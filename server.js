const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

app.use(express.json());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Game API ────────────────────────────────────────────────────────────────

// Create a new game
app.post('/api/game/new', async (req, res) => {
  try {
    const { player1, player2 } = req.body;
    if (!player1 || !player2) return res.status(400).json({ error: 'Need player1 and player2 names' });

    const state = createInitialState(player1, player2);
    const { rows } = await pool.query(
      `INSERT INTO games (state, created_at, updated_at) VALUES ($1, NOW(), NOW()) RETURNING id`,
      [JSON.stringify(state)]
    );
    res.json({ id: rows[0].id, state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get game state
app.get('/api/game/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM games WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Game not found' });
    res.json({ id: rows[0].id, state: rows[0].state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Game action
app.post('/api/game/:id/action', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM games WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Game not found' });

    const state = rows[0].state;
    const { action } = req.body;
    const result = applyAction(state, action);

    if (result.error) return res.status(400).json({ error: result.error });

    await pool.query(
      `UPDATE games SET state = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(result.state), req.params.id]
    );
    res.json({ state: result.state, events: result.events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List recent games
app.get('/api/games', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, state->>'phase' as phase, state->>'winner' as winner,
              state->'players'->0->>'name' as p1, state->'players'->1->>'name' as p2,
              created_at FROM games ORDER BY created_at DESC LIMIT 20`
    );
    res.json({ games: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Game Logic ───────────────────────────────────────────────────────────────

const COLS = 20;
const ROWS = 10;
const INITIAL_TROOPS = 20;
const SUPPLY_DECAY = 0.20; // 20% loss when supply line cut

// Home squares: P0 = (0,4), P1 = (19,4) (roughly center vertically on each side)
const HOME = [
  { col: 0, row: 4 },
  { col: 19, row: 4 },
];

function cellKey(col, row) { return `${col},${row}`; }

function createInitialState(player1, player2) {
  const grid = {};

  // Place home squares with initial garrison
  for (let p = 0; p < 2; p++) {
    const { col, row } = HOME[p];
    grid[cellKey(col, row)] = { owner: p, troops: INITIAL_TROOPS, home: true };
  }

  return {
    grid,
    players: [
      { name: player1, reinforcements: INITIAL_TROOPS },
      { name: player2, reinforcements: INITIAL_TROOPS },
    ],
    currentPlayer: 0,
    phase: 'place',       // place → move → fight → final_move → (next turn place)
    turnNumber: 1,
    pendingFight: null,   // { fromKey, toKey } when awaiting dice roll confirmation
    movesLeft: 1,         // moves available in move phase
    winner: null,
    log: [`Game started. ${player1} vs ${player2}. Turn 1 — Place troops.`],
  };
}

function getNeighbors(col, row) {
  const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
  return dirs
    .map(([dc, dr]) => [col + dc, row + dr])
    .filter(([c, r]) => c >= 0 && c < COLS && r >= 0 && r < ROWS);
}

// BFS: does player `p` have an unbroken supply line from `key` to their home?
function hasSupplyLine(grid, key, playerIdx) {
  const homeKey = cellKey(HOME[playerIdx].col, HOME[playerIdx].row);
  if (key === homeKey) return true;

  const visited = new Set();
  const queue = [key];
  visited.add(key);

  while (queue.length) {
    const cur = queue.shift();
    if (cur === homeKey) return true;
    const [c, r] = cur.split(',').map(Number);
    for (const [nc, nr] of getNeighbors(c, r)) {
      const nk = cellKey(nc, nr);
      if (!visited.has(nk) && grid[nk] && grid[nk].owner === playerIdx) {
        visited.add(nk);
        queue.push(nk);
      }
    }
  }
  return false;
}

// Apply 20% supply decay to cells not connected to home
function applySupplyDecay(state) {
  const events = [];
  const grid = state.grid;

  for (const [key, cell] of Object.entries(grid)) {
    if (!hasSupplyLine(grid, key, cell.owner)) {
      const loss = Math.ceil(cell.troops * SUPPLY_DECAY);
      cell.troops -= loss;
      events.push(`Supply cut! ${state.players[cell.owner].name}'s troops at (${key}) lose ${loss} (${cell.troops} remain)`);
      if (cell.troops <= 0) {
        events.push(`Cell (${key}) abandoned — troops starved out`);
        delete grid[key];
      }
    }
  }
  return events;
}

// Risk-style dice combat
// attacker rolls min(troops-1, 3) dice, defender rolls min(troops, 2)
function rollCombat(attackTroops, defendTroops) {
  const aDice = Math.min(attackTroops - 1, 3);
  const dDice = Math.min(defendTroops, 2);

  if (aDice < 1) return { error: 'Need at least 2 troops to attack' };

  const aRolls = Array.from({ length: aDice }, () => Math.ceil(Math.random() * 6)).sort((a, b) => b - a);
  const dRolls = Array.from({ length: dDice }, () => Math.ceil(Math.random() * 6)).sort((a, b) => b - a);

  let aLoss = 0, dLoss = 0;
  const pairs = Math.min(aDice, dDice);
  for (let i = 0; i < pairs; i++) {
    if (aRolls[i] > dRolls[i]) dLoss++;
    else aLoss++;
  }

  return { aRolls, dRolls, aLoss, dLoss };
}

function applyAction(state, action) {
  if (state.winner) return { error: 'Game is over' };

  const s = JSON.parse(JSON.stringify(state)); // deep clone
  const events = [];
  const cp = s.currentPlayer;

  switch (action.type) {

    case 'PLACE_TROOPS': {
      if (s.phase !== 'place') return { error: 'Not in place phase' };
      const { col, row, amount } = action;
      if (typeof col !== 'number' || typeof row !== 'number') return { error: 'Invalid cell' };
      if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return { error: 'Out of bounds' };

      const key = cellKey(col, row);
      const cell = s.grid[key];

      // Can only place on own cells
      if (!cell || cell.owner !== cp) return { error: 'Can only place troops on your own cells' };

      const amt = Math.max(1, Math.min(amount || 1, s.players[cp].reinforcements));
      s.players[cp].reinforcements -= amt;
      cell.troops += amt;
      events.push(`${s.players[cp].name} places ${amt} troops at (${key})`);

      // If no reinforcements left, auto-advance
      if (s.players[cp].reinforcements <= 0) {
        s.phase = 'move';
        s.movesLeft = 3;
        events.push(`${s.players[cp].name} advances to move phase`);
      }
      break;
    }

    case 'END_PLACE': {
      if (s.phase !== 'place') return { error: 'Not in place phase' };
      s.phase = 'move';
      s.movesLeft = 3;
      events.push(`${s.players[cp].name} ends placement, moves to move phase`);
      break;
    }

    case 'MOVE_TROOPS': {
      if (s.phase !== 'move' && s.phase !== 'final_move') return { error: 'Not in move phase' };
      const { fromCol, fromRow, toCol, toRow, amount } = action;
      const fromKey = cellKey(fromCol, fromRow);
      const toKey = cellKey(toCol, toRow);
      const fromCell = s.grid[fromKey];

      if (!fromCell || fromCell.owner !== cp) return { error: 'Not your cell' };
      if (fromCell.troops <= 1) return { error: 'Must keep at least 1 troop' };

      // Must be adjacent
      const [dc, dr] = [toCol - fromCol, toRow - fromRow];
      if (Math.abs(dc) + Math.abs(dr) !== 1) return { error: 'Can only move to adjacent cell' };
      if (toCol < 0 || toCol >= COLS || toRow < 0 || toRow >= ROWS) return { error: 'Out of bounds' };

      const toCell = s.grid[toKey];
      const amt = Math.max(1, Math.min(amount || fromCell.troops - 1, fromCell.troops - 1));

      if (!toCell || toCell.owner === cp) {
        // Friendly move
        fromCell.troops -= amt;
        if (!toCell) s.grid[toKey] = { owner: cp, troops: amt };
        else toCell.troops += amt;
        if (fromCell.troops === 0) delete s.grid[fromKey];
        events.push(`${s.players[cp].name} moves ${amt} troops from (${fromKey}) to (${toKey})`);
      } else {
        // Attack — queue the fight
        s.pendingFight = { fromKey, toKey, amount: amt };
        s.phase = 'fight';
        events.push(`${s.players[cp].name} attacks (${toKey}) from (${fromKey}) with ${amt} troops`);
        return { state: s, events };
      }

      if (s.phase === 'move') {
        s.movesLeft--;
        if (s.movesLeft <= 0) {
          s.phase = 'fight';
          events.push(`${s.players[cp].name} exhausted moves, entering fight phase`);
        }
      } else {
        // final_move — one move then end turn
        advanceTurn(s, events);
      }
      break;
    }

    case 'END_MOVE': {
      if (s.phase !== 'move') return { error: 'Not in move phase' };
      s.phase = 'fight';
      events.push(`${s.players[cp].name} skips remaining moves`);
      break;
    }

    case 'ROLL_DICE': {
      if (s.phase !== 'fight' || !s.pendingFight) return { error: 'No pending fight' };
      const { fromKey, toKey, amount } = s.pendingFight;
      const fromCell = s.grid[fromKey];
      const toCell = s.grid[toKey];

      if (!fromCell || !toCell) return { error: 'Invalid fight state' };

      const result = rollCombat(amount, toCell.troops);
      if (result.error) return { error: result.error };

      const { aRolls, dRolls, aLoss, dLoss } = result;
      events.push(`Dice! Attacker [${aRolls}] vs Defender [${dRolls}] → attacker -${aLoss}, defender -${dLoss}`);

      fromCell.troops -= aLoss;
      toCell.troops -= dLoss;

      // Attacker committed `amount` troops, but they physically stayed in fromKey until now
      // If attacker won (defender at 0), move surviving attack troops in
      if (toCell.troops <= 0) {
        const surviving = amount - aLoss;
        events.push(`${s.players[cp].name} captures (${toKey})! ${surviving} troops move in`);
        delete s.grid[toKey];
        if (surviving > 0) {
          s.grid[toKey] = { owner: cp, troops: surviving };
        }
        fromCell.troops -= (amount - aLoss); // remove the troops that moved
        if (fromCell.troops <= 0) delete s.grid[fromKey];

        // Check win: did we capture enemy home?
        const enemyHomeKey = cellKey(HOME[1 - cp].col, HOME[1 - cp].row);
        if (toKey === enemyHomeKey) {
          s.winner = s.players[cp].name;
          events.push(`🏆 ${s.players[cp].name} WINS by capturing the enemy home base!`);
          s.phase = 'gameover';
          s.pendingFight = null;
          return { state: s, events };
        }
      } else {
        // Attacker lost/repelled — move attack troops back (already counted above)
        fromCell.troops -= (amount - aLoss);
        if (fromCell.troops <= 0) delete s.grid[fromKey];
      }

      s.pendingFight = null;

      // After fight, go to final_move
      s.phase = 'final_move';
      s.movesLeft = 1;
      events.push(`${s.players[cp].name} gets 1 final move`);
      break;
    }

    case 'SKIP_FIGHT': {
      if (s.phase !== 'fight') return { error: 'Not in fight phase' };
      s.pendingFight = null;
      s.phase = 'final_move';
      s.movesLeft = 1;
      events.push(`${s.players[cp].name} skips fighting`);
      break;
    }

    case 'END_FINAL_MOVE': {
      if (s.phase !== 'final_move') return { error: 'Not in final move phase' };
      advanceTurn(s, events);
      break;
    }

    default:
      return { error: `Unknown action: ${action.type}` };
  }

  return { state: s, events };
}

function advanceTurn(s, events) {
  // Apply supply decay before handing off
  const decayEvents = applySupplyDecay(s);
  events.push(...decayEvents);

  // Check if anyone lost their home
  for (let p = 0; p < 2; p++) {
    const hk = cellKey(HOME[p].col, HOME[p].row);
    if (!s.grid[hk] || s.grid[hk].owner !== p) {
      const enemy = 1 - p;
      if (!s.winner) {
        s.winner = s.players[enemy].name;
        events.push(`🏆 ${s.players[enemy].name} WINS — enemy home base lost!`);
        s.phase = 'gameover';
        return;
      }
    }
  }

  // Switch player
  s.currentPlayer = 1 - s.currentPlayer;
  s.turnNumber++;
  // Earn reinforcements: 1 per 3 cells owned, minimum 1
  const cellsOwned = Object.values(s.grid).filter(c => c.owner === s.currentPlayer).length;
  const reinforcements = Math.max(1, Math.floor(cellsOwned / 3));
  s.players[s.currentPlayer].reinforcements += reinforcements;
  s.phase = 'place';
  events.push(`Turn ${s.turnNumber} — ${s.players[s.currentPlayer].name}'s turn. +${reinforcements} reinforcements (${s.players[s.currentPlayer].reinforcements} total)`);
}

// ─── Static & DB setup ───────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS presses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
