#!/usr/bin/env node
// m59-goap-nav-test.mjs -- prototype test for GOAP room navigation.
//
// Exercises the planner + executor against a mock session with a fake room
// graph. No live server, no broker, no map file needed for the planner tests.
// The map-file integration tests (NavigateTo with a real map) are skipped when
// the map file is absent.

import { plan, GoapExecutor }       from './m59-goap-planner.mjs';
import { navigationActions,
         MoveToRoomAction }          from './m59-bt-nav.mjs';
import { SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';

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

// ---------------------------------------------------------------------------
// Tick helper: runs a node until terminal or maxTicks
// ---------------------------------------------------------------------------
async function tickUntilDone(node, bb, maxTicks = 40) {
  let result;
  for (let i = 0; i < maxTicks; i++) {
    result = node.tick(bb);
    if (result === SUCCESS || result === FAILURE) return result;
    await new Promise(r => setTimeout(r, 5));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Section: plan() — pure A* planner with hand-crafted action sets
// ---------------------------------------------------------------------------

section('plan() — direct single hop');
{
  // A → B
  const nodeAB = MoveToRoomAction(2);
  nodeAB.pre = ['at_room_1']; nodeAB.effects = ['at_room_2', '!at_room_1'];
  const actions = [{ pre: nodeAB.pre, effects: nodeAB.effects, cost: 1, node: nodeAB }];

  const result = plan(actions, { at_room_1: true }, { at_room_2: true });
  ok('found',       result.found, true);
  ok('one step',    result.steps.length, 1);
  ok('step is AB',  result.steps[0], nodeAB);
}

section('plan() — already at goal');
{
  const result = plan([], { at_room_5: true }, { at_room_5: true });
  ok('found',     result.found, true);
  ok('no steps',  result.steps.length, 0);
}

section('plan() — two-hop route A → B → C');
{
  const ab = MoveToRoomAction(2);
  ab.pre = ['at_room_1']; ab.effects = ['at_room_2', '!at_room_1'];
  const bc = MoveToRoomAction(3);
  bc.pre = ['at_room_2']; bc.effects = ['at_room_3', '!at_room_2'];
  // Distractor: direct A→C (no such exit — pre not satisfiable from start alone)
  const ac = MoveToRoomAction(3);
  ac.pre = ['at_room_1', 'portal_open']; ac.effects = ['at_room_3', '!at_room_1'];

  const actions = [
    { pre: ab.pre, effects: ab.effects, cost: 1, node: ab },
    { pre: bc.pre, effects: bc.effects, cost: 1, node: bc },
    { pre: ac.pre, effects: ac.effects, cost: 1, node: ac },
  ];

  const result = plan(actions, { at_room_1: true }, { at_room_3: true });
  ok('found',         result.found, true);
  ok('two steps',     result.steps.length, 2);
  ok('first step AB', result.steps[0], ab);
  ok('second step BC',result.steps[1], bc);
}

section('plan() — no path (island room)');
{
  // Room 1 connects to 2 only; goal is room 3 with no exit
  const ab = MoveToRoomAction(2);
  ab.pre = ['at_room_1']; ab.effects = ['at_room_2', '!at_room_1'];
  const actions = [{ pre: ab.pre, effects: ab.effects, cost: 1, node: ab }];

  const result = plan(actions, { at_room_1: true }, { at_room_3: true });
  ok('not found', result.found, false);
  assert('reason string present', typeof result.reason === 'string');
}

section('plan() — chooses cheaper route');
{
  // Two paths A→B→D and A→C→D; C→D costs 5, B→D costs 1
  const ab = MoveToRoomAction(10); ab.pre = ['at_room_1']; ab.effects = ['at_room_10', '!at_room_1'];
  const bd = MoveToRoomAction(4);  bd.pre = ['at_room_10']; bd.effects = ['at_room_4', '!at_room_10'];
  const ac = MoveToRoomAction(11); ac.pre = ['at_room_1']; ac.effects = ['at_room_11', '!at_room_1'];
  const cd = MoveToRoomAction(4);  cd.pre = ['at_room_11']; cd.effects = ['at_room_4', '!at_room_11']; cd.cost = 5;
  bd.cost = 1; ab.cost = 1; ac.cost = 1;

  const actions = [
    { pre: ab.pre, effects: ab.effects, cost: ab.cost, node: ab },
    { pre: bd.pre, effects: bd.effects, cost: bd.cost, node: bd },
    { pre: ac.pre, effects: ac.effects, cost: ac.cost, node: ac },
    { pre: cd.pre, effects: cd.effects, cost: cd.cost, node: cd },
  ];

  const result = plan(actions, { at_room_1: true }, { at_room_4: true });
  ok('found', result.found, true);
  ok('takes cheaper 2-hop path', result.steps.length, 2);
  ok('first hop is AB not AC', result.steps[0], ab);
}

// ---------------------------------------------------------------------------
// Section: navigationActions() helper
// ---------------------------------------------------------------------------

section('navigationActions() — builds chained action set');
{
  // Route: [10, 20, 30, 40]
  const route = [10, 20, 30, 40];
  const actions = navigationActions(route);

  ok('three actions for four rooms', actions.length, 3);
  ok('first pre  is at_room_10',  actions[0].pre[0],     'at_room_10');
  ok('first eff  is at_room_20',  actions[0].effects[0], 'at_room_20');
  ok('first eff2 clears room_10', actions[0].effects[1], '!at_room_10');
  ok('second pre is at_room_20',  actions[1].pre[0],     'at_room_20');
  ok('third eff  is at_room_40',  actions[2].effects[0], 'at_room_40');
}

section('navigationActions() — plan finds ordered route');
{
  const route   = [1, 2, 3, 4];
  const actions = navigationActions(route);
  const result  = plan(actions, { at_room_1: true }, { at_room_4: true });
  ok('found', result.found, true);
  ok('three steps', result.steps.length, 3);
}

// ---------------------------------------------------------------------------
// Section: GoapExecutor — mock session that moves between rooms
// ---------------------------------------------------------------------------

section('GoapExecutor — navigates A→B→C with mock session');
{
  // Fake session: tracks current room, leaveVia sets it to exit.to
  let currentRoom = 1;
  const mockSession = {
    world: {
      get room() { return { num: currentRoom }; },
      exits: () => [
        { to: 2, stand_on: { col: 5, row: 0 }, kind: 'edge', steps_away: 3 },
        { to: 3, stand_on: null },   // no stand_on — should be filtered
      ],
    },
    leaveVia: async (exit) => {
      if (exit.to === 2 && exit.stand_on) { currentRoom = 2; return { left: true }; }
      return { left: false, reason: 'no stand_on' };
    },
  };

  // Override MoveToRoomAction for room 3 to work from room 2
  // We build actions manually to control the mock behaviour.
  const node2 = new (class extends Object {
    constructor() {
      super();
      this.key = 'at_move_room_2';
      this._name = 'move_to_room_2';
      this.pre = ['at_room_1'];
      this.effects = ['at_room_2', '!at_room_1'];
      this.cost = 1;
      this._slot = {};
    }
    tick(bb) {
      if (!bb._bt) bb._bt = {};
      const slot = bb._bt[this.key];
      if (!slot || slot.done === undefined) {
        const s = { done: false, ok: false };
        bb._bt[this.key] = s;
        Promise.resolve().then(async () => {
          const exits = mockSession.world.exits();
          for (const e of exits.filter(x => x.to === 2 && x.stand_on)) {
            const r = await mockSession.leaveVia(e);
            if (r?.left) { s.ok = true; bb.ws[`at_room_2`] = true; break; }
          }
          s.done = true;
        });
        return RUNNING;
      }
      if (!slot.done) return RUNNING;
      const ok = slot.ok;
      delete bb._bt[this.key];
      return ok ? SUCCESS : FAILURE;
    }
  })();

  // Room 3 action — sets currentRoom = 3 when from room 2
  let room3done = false;
  const node3 = {
    key: 'at_move_room_3',
    _name: 'move_to_room_3',
    pre: ['at_room_2'], effects: ['at_room_3', '!at_room_2'], cost: 1,
    tick(bb) {
      if (!room3done) {
        room3done = true;
        currentRoom = 3;
        bb.ws['at_room_3'] = true;
        bb.ws['at_room_2'] = false;
      }
      return SUCCESS;
    },
  };

  const actions = [
    { pre: node2.pre, effects: node2.effects, cost: 1, node: node2 },
    { pre: node3.pre, effects: node3.effects, cost: 1, node: node3 },
  ];

  const bb = {
    _bt: {},
    ws: { at_room_1: true },
    session: { s: mockSession },
  };

  const wsSource = b => {
    const ws = b.ws ?? (b.ws = {});
    ws[`at_room_${currentRoom}`] = true;
    return ws;
  };

  const exec = GoapExecutor(actions, { at_room_3: true }, { key: 'test_nav', wsSource });
  const result = await tickUntilDone(exec, bb, 60);

  ok('executor reached goal → SUCCESS', result, SUCCESS);
  ok('ended in room 3', currentRoom, 3);
}

// ---------------------------------------------------------------------------
// Section: GoapExecutor — goal already met
// ---------------------------------------------------------------------------

section('GoapExecutor — goal already satisfied on first tick');
{
  const bb = { _bt: {}, ws: { at_room_5: true } };
  const exec = GoapExecutor([], { at_room_5: true }, { key: 'nav_done' });
  const result = exec.tick(bb);
  ok('immediate SUCCESS', result, SUCCESS);
}

// ---------------------------------------------------------------------------
// Section: GoapExecutor — no path available → FAILURE
// ---------------------------------------------------------------------------

section('GoapExecutor — no path → FAILURE');
{
  // No actions that reach room 99
  const ab = MoveToRoomAction(2);
  ab.pre = ['at_room_1']; ab.effects = ['at_room_2', '!at_room_1'];
  const actions = [{ pre: ab.pre, effects: ab.effects, cost: 1, node: ab }];

  const bb = { _bt: {}, ws: { at_room_1: true } };
  const exec = GoapExecutor(actions, { at_room_99: true }, { key: 'nav_fail' });

  const result = await tickUntilDone(exec, bb, 10);
  ok('no path → FAILURE', result, FAILURE);
}

// ---------------------------------------------------------------------------
// Section: MoveToRoomAction — already in target room
// ---------------------------------------------------------------------------

section('MoveToRoomAction — already in target room');
{
  const mockSession = {
    world: {
      room: { num: 5 },
      exits: () => [],
      map: null,
    },
    leaveVia: async () => ({ left: false }),
  };

  const bb = { _bt: {}, ws: {}, session: { s: mockSession } };
  const node = MoveToRoomAction(5);
  const result = await tickUntilDone(node, bb, 10);
  ok('already there → SUCCESS', result, SUCCESS);
  assert('ws updated', !!bb.ws['at_room_5']);
}

// ---------------------------------------------------------------------------
// Section: MoveToRoomAction — no exit to target → FAILURE
// ---------------------------------------------------------------------------

section('MoveToRoomAction — no exit available → FAILURE');
{
  const mockSession = {
    world: {
      room: { num: 1 },
      exits: () => [],   // no exits
      map: null,
    },
    leaveVia: async () => ({ left: false }),
  };

  const bb = { _bt: {}, ws: {}, session: { s: mockSession } };
  const node = MoveToRoomAction(9);
  const result = await tickUntilDone(node, bb, 10);
  ok('no exit → FAILURE', result, FAILURE);
}

// ---------------------------------------------------------------------------
// Section: slot pattern — RUNNING on first tick, settles
// ---------------------------------------------------------------------------

section('MoveToRoomAction — slot pattern');
{
  const mockSession = {
    world: { room: { num: 1 }, exits: () => [{ to: 2, stand_on: { col: 3, row: 3 }, kind: 'edge', steps_away: 2 }], map: null },
    leaveVia: async (e) => { return { left: true }; },
  };
  const bb = { _bt: {}, ws: {}, session: { s: mockSession } };
  const node = MoveToRoomAction(2);
  const first = node.tick(bb);
  ok('first tick is RUNNING', first, RUNNING);
  assert('slot stashed', !!bb._bt[`at_move_room_2`]);

  const final = await tickUntilDone(node, bb, 20);
  assert('settles to terminal', final === SUCCESS || final === FAILURE);
  assert('slot cleaned up', !bb._bt[`at_move_room_2`]);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
