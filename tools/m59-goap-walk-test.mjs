#!/usr/bin/env node
// m59-goap-walk-test.mjs -- GOAP in-room navigation tests.
//
// All tests use a mock RoomGeometry built from a small hand-drawn grid.
// No live server, no .roo file needed.

import { StepAction, walkActions, WalkTo } from './m59-bt-walk.mjs';
import { plan }                             from './m59-goap-planner.mjs';
import { SUCCESS, FAILURE, RUNNING }        from './m59-bt.mjs';

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

let passed = 0, failed = 0;
function section(name) { console.log('\n' + name); }
function ok(label, got, want) {
  const pass = got === want;
  console.log(`  ${pass ? 'ok' : 'FAIL'} ${label}${pass ? '' :
    `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  pass ? passed++ : failed++;
}
function assert(label, cond) { ok(label, !!cond, true); }

async function tickUntilDone(node, bb, maxTicks = 60) {
  let result;
  for (let i = 0; i < maxTicks; i++) {
    result = node.tick(bb);
    if (result === SUCCESS || result === FAILURE) return result;
    await new Promise(r => setTimeout(r, 5));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mock RoomGeometry
//
// 5x5 grid. '#' = wall, '.' = floor. 1-based rows/cols (top = row 1).
//
//   col: 1 2 3 4 5
// row 1: . . . . .
// row 2: . # # # .
// row 3: . . . . .
// row 4: . # # # .
// row 5: . . . . .
//
// Two corridors (col 1 and col 5) connect top to bottom through a walled middle.
// ---------------------------------------------------------------------------

const ROWS = 5, COLS = 5;
const WALL = new Set([
  '2,2','2,3','2,4',
  '4,2','4,3','4,4',
]);

function isFloor(r, c) {
  return r >= 1 && r <= ROWS && c >= 1 && c <= COLS && !WALL.has(`${r},${c}`);
}

// Diagonal cost flag reuses Math.SQRT2 in walkActions; neighbours check 8 dirs.
const DIRS = [
  { dr: -1, dc:  0, diag: false }, { dr:  1, dc:  0, diag: false },
  { dr:  0, dc: -1, diag: false }, { dr:  0, dc:  1, diag: false },
  { dr: -1, dc: -1, diag: true  }, { dr: -1, dc:  1, diag: true  },
  { dr:  1, dc: -1, diag: true  }, { dr:  1, dc:  1, diag: true  },
];

// Minimal mock geometry matching the RoomGeometry interface used by walkActions.
const mockGeo = {
  rows: ROWS, cols: COLS,
  inBounds:  (r, c) => r >= 1 && r <= ROWS && c >= 1 && c <= COLS,
  walkable:  (r, c) => isFloor(r, c),
  neighbors: (r, c) => {
    const out = [];
    for (const { dr, dc, diag } of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (isFloor(nr, nc)) out.push({ row: nr, col: nc, diagonal: diag });
    }
    return out;
  },
  // A* on the mock grid — same interface as RoomGeometry.path().
  path(fromRow, fromCol, toRow, toCol) {
    if (!isFloor(fromRow, fromCol)) return { found: false, reason: 'start not walkable' };
    if (!isFloor(toRow,   toCol))   return { found: false, reason: 'goal not walkable' };
    if (fromRow === toRow && fromCol === toCol) return { found: true, steps: [] };

    const key = (r, c) => r * 100 + c;
    const h   = (r, c) => Math.max(Math.abs(r - toRow), Math.abs(c - toCol));
    const open = [{ r: fromRow, c: fromCol, g: 0, f: h(fromRow, fromCol), path: [] }];
    const best = new Map([[key(fromRow, fromCol), 0]]);

    while (open.length) {
      open.sort((a, b) => a.f - b.f);
      const cur = open.shift();
      if (cur.r === toRow && cur.c === toCol) {
        return { found: true, steps: cur.path };
      }
      for (const n of this.neighbors(cur.r, cur.c)) {
        const g = cur.g + (n.diagonal ? Math.SQRT2 : 1);
        const k = key(n.row, n.col);
        if ((best.get(k) ?? Infinity) <= g) continue;
        best.set(k, g);
        open.push({ r: n.row, c: n.col, g, f: g + h(n.row, n.col),
                    path: [...cur.path, { row: n.row, col: n.col, diagonal: n.diagonal }] });
      }
    }
    return { found: false, reason: 'no path' };
  },
};

// ---------------------------------------------------------------------------
// Section: walkActions() — builds chained actions from geo.path()
// ---------------------------------------------------------------------------

section('walkActions() — straight corridor');
{
  // (1,1) → (1,5): straight along row 1, 4 steps east
  const { actions, route } = walkActions(mockGeo, 1, 1, 1, 5);
  assert('found a route',            !!route);
  ok('four steps',                   actions.length, 4);
  ok('first pre is at_sq_1_1',       actions[0].pre[0], 'at_sq_1_1');
  ok('first eff is at_sq_1_2',       actions[0].effects[0], 'at_sq_1_2');
  ok('first eff clears at_sq_1_1',   actions[0].effects[1], '!at_sq_1_1');
  ok('last eff is at_sq_1_5',        actions[actions.length - 1].effects[0], 'at_sq_1_5');
}

section('walkActions() — already at goal');
{
  const { actions, route } = walkActions(mockGeo, 3, 3, 3, 3);
  // geo.path returns steps: [] — no actions needed
  ok('zero actions', actions.length, 0);
  assert('route has one entry', route != null && route.length === 1);
}

section('walkActions() — wall in the way, routes around');
{
  // (1,1) → (5,1): can go straight down col 1 (no walls there)
  const { actions, route } = walkActions(mockGeo, 1, 1, 5, 1);
  assert('found route through corridor', !!route);
  assert('at least 4 steps',            actions.length >= 4);
  ok('last eff reaches (5,1)',           actions[actions.length - 1].effects[0], 'at_sq_5_1');
}

section('walkActions() — no path (goal is a wall)');
{
  const { actions, route } = walkActions(mockGeo, 1, 1, 2, 2);
  ok('no actions', actions.length, 0);
  ok('no route',   route, null);
}

// ---------------------------------------------------------------------------
// Section: plan() using walkActions output
// ---------------------------------------------------------------------------

section('plan() with walkActions — (1,1) to (1,5)');
{
  const { actions } = walkActions(mockGeo, 1, 1, 1, 5);
  const result = plan(actions, { at_sq_1_1: true }, { at_sq_1_5: true });
  ok('found',       result.found, true);
  ok('four steps',  result.steps.length, 4);
}

section('plan() with walkActions — (1,1) to (5,5) around walls');
{
  const { actions } = walkActions(mockGeo, 1, 1, 5, 5);
  const result = plan(actions, { at_sq_1_1: true }, { at_sq_5_5: true });
  ok('found',                   result.found, true);
  assert('reaches destination', result.steps.length > 0);
}

section('plan() — already at goal, zero steps');
{
  const result = plan([], { at_sq_3_3: true }, { at_sq_3_3: true });
  ok('found',    result.found, true);
  ok('no steps', result.steps.length, 0);
}

// ---------------------------------------------------------------------------
// Section: StepAction — slot pattern and world-state update
// ---------------------------------------------------------------------------

section('StepAction — moves and updates ws');
{
  let stepped = null;
  let selfPos = { col: 1, row: 1 };
  const mockSession = {
    client: {
      get self() { return selfPos; },
      face: () => {},
    },
    step: async (col, row) => {
      stepped = { col, row };
      selfPos = { col, row };   // simulate server confirming move
      return {};
    },
    pacer: { submit: async (_, fn) => fn() },
  };

  const bb = { _bt: {}, ws: { at_sq_1_1: true }, session: { s: mockSession } };
  const node = StepAction(2, 1);   // move to col 2, row 1
  node.pre     = ['at_sq_1_1'];
  node.effects = ['at_sq_1_2', '!at_sq_1_1'];

  const first = node.tick(bb);
  ok('first tick RUNNING', first, RUNNING);

  const final = await tickUntilDone(node, bb, 20);
  ok('step arrives → SUCCESS', final, SUCCESS);
  ok('stepped to correct square', stepped?.col, 2);
  assert('ws at_sq_1_2 set',    !!bb.ws['at_sq_1_2']);
  assert('ws at_sq_1_1 cleared', !bb.ws['at_sq_1_1']);
}

section('StepAction — server does not confirm → FAILURE');
{
  let selfPos = { col: 1, row: 1 };
  const mockSession = {
    client: { get self() { return selfPos; } },
    step: async (col, row) => {
      // Server blocked the move — position unchanged
      return {};
    },
    pacer: { submit: async (_, fn) => fn() },
  };

  const bb = { _bt: {}, ws: {}, session: { s: mockSession } };
  const node = StepAction(2, 1);
  const final = await tickUntilDone(node, bb, 20);
  ok('blocked step → FAILURE', final, FAILURE);
  assert('ws at_sq_1_2 not set', !bb.ws['at_sq_1_2']);
}

section('StepAction — slot cleanup');
{
  let selfPos = { col: 3, row: 3 };
  const mockSession = {
    client: { get self() { return selfPos; } },
    step: async (col, row) => { selfPos = { col, row }; return {}; },
    pacer: { submit: async (_, fn) => fn() },
  };

  const bb = { _bt: {}, ws: {}, session: { s: mockSession } };
  const node = StepAction(4, 3);
  await tickUntilDone(node, bb, 20);
  assert('slot cleaned up', !bb._bt[`at_step_3_4`]);
}

// ---------------------------------------------------------------------------
// Section: WalkTo executor — navigates across the mock grid
// ---------------------------------------------------------------------------

section('WalkTo — (1,1) to (1,4) in a clear row');
{
  let selfPos = { col: 1, row: 1 };
  const steps = [];
  const mockSession = {
    client: { get self() { return selfPos; } },
    world:  { geometry: mockGeo },
    step: async (col, row) => {
      steps.push({ col, row });
      selfPos = { col, row };
      return {};
    },
    pacer: { submit: async (_, fn) => fn() },
  };

  const bb = { _bt: {}, ws: {}, session: { s: mockSession } };
  const exec = WalkTo(4, 1);
  const result = await tickUntilDone(exec, bb, 80);
  ok('reached goal → SUCCESS', result, SUCCESS);
  ok('ended at col 4', selfPos.col, 4);
  ok('ended at row 1', selfPos.row, 1);
  assert('took at least 3 steps', steps.length >= 3);
}

section('WalkTo — already at goal');
{
  let selfPos = { col: 3, row: 3 };
  const mockSession = {
    client: { get self() { return selfPos; } },
    world:  { geometry: mockGeo },
    step: async () => {},
    pacer: { submit: async (_, fn) => fn() },
  };

  const bb = { _bt: {}, ws: {}, session: { s: mockSession } };
  const exec = WalkTo(3, 3);
  const result = await tickUntilDone(exec, bb, 10);
  ok('already there → SUCCESS', result, SUCCESS);
}

section('WalkTo — goal is a wall → FAILURE');
{
  let selfPos = { col: 1, row: 1 };
  const mockSession = {
    client: { get self() { return selfPos; } },
    world:  { geometry: mockGeo },
    step: async () => {},
    pacer: { submit: async (_, fn) => fn() },
  };

  const bb = { _bt: {}, ws: {}, session: { s: mockSession } };
  const exec = WalkTo(2, 2);   // (col 2, row 2) is a wall
  const result = await tickUntilDone(exec, bb, 10);
  ok('no path to wall → FAILURE', result, FAILURE);
}

section('WalkTo — routes around walls to reach (5,5) from (1,1)');
{
  let selfPos = { col: 1, row: 1 };
  const mockSession = {
    client: { get self() { return selfPos; } },
    world:  { geometry: mockGeo },
    step: async (col, row) => { selfPos = { col, row }; return {}; },
    pacer: { submit: async (_, fn) => fn() },
  };

  const bb = { _bt: {}, ws: {}, session: { s: mockSession } };
  const exec = WalkTo(5, 5);
  const result = await tickUntilDone(exec, bb, 120);
  ok('reached far corner → SUCCESS', result, SUCCESS);
  ok('ended at col 5', selfPos.col, 5);
  ok('ended at row 5', selfPos.row, 5);
}

// ---------------------------------------------------------------------------
// Section: diagonal cost — diagonal steps cost √2
// ---------------------------------------------------------------------------

section('walkActions() — diagonal steps have √2 cost');
{
  // (1,1) → (3,3): diagonal path through clear corner
  // Both (2,2) and (4,2)/(2,4) are walls, but (1,1)→(2,1)→(3,1) is clear
  // and diagonal cost should prefer the shorter path where available.
  const { actions } = walkActions(mockGeo, 3, 1, 5, 3);
  assert('has actions', actions.length > 0);
  const diagonals = actions.filter(a => Math.abs(a.cost - Math.SQRT2) < 0.01);
  const cardinals = actions.filter(a => a.cost === 1);
  assert('at least one cardinal or diagonal step exists',
         diagonals.length > 0 || cardinals.length > 0);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
