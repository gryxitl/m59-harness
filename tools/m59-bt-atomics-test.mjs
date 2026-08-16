#!/usr/bin/env node
// m59-bt-atomics-test.mjs -- unit tests for the atomic BT action nodes.
//
// All tests run against a mock client / session — no live server needed.
// The mock implements just enough surface for each atomic to exercise its
// precondition check, slot pattern, world-state write, and SUCCESS/FAILURE path.

import {
  EquipWeaponAction, WearArmourAction, PickUpAction, DropAction,
  MoveToSquareAction, AttackAction, RestAction, StandAction, CastAction,
  syncWorldState,
} from './m59-bt-atomics.mjs';
import { SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const sections = [];

function section(name) { sections.push(name); console.log('\n' + name); }
function ok(label, got, want) {
  const pass = got === want;
  console.log(`  ${pass ? 'ok' : 'FAIL'} ${label}${pass ? '' : `\n      got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  pass ? passed++ : failed++;
}
function assert(label, cond) { ok(label, !!cond, true); }

// ---------------------------------------------------------------------------
// Mock builder
// ---------------------------------------------------------------------------

function makeMock({
  weapons = [],      // items in inventory that count as weapons
  armour  = [],      // items in inventory that count as armour
  equipped = [],     // item ids in plUsing
  inventory = [],    // full inventory list
  spells  = [],
  vitals  = { health: { value: 30, max: 40 }, mana: { value: 10, max: 20 } },
  roomObjects = new Map(),
  walkResult  = { arrived: true },
  equipResult = null,   // return from skills.equipBest
  wearResult  = null,   // return from skills.wearBest
  pacer       = null,
} = {}) {
  const evSeq = { v: 0 };
  const waitQueue = [];

  const mockClient = {
    evSeq: 0,
    inventory,
    spells,
    room: { objects: roomObjects },
    me: { flags: 0 },
    vitals: () => vitals,
    waitFor: ({ kinds, timeoutMs } = {}) => new Promise(resolve => {
      // Immediately resolve with empty events (simulating a quiet server).
      setTimeout(() => resolve({ events: [], timedOut: false }), 0);
    }),
    attack : (id)        => {},
    get    : (id)        => {},
    drop   : (specs)     => {},
    rest   : ()          => {},
    stand  : ()          => {},
    cast   : (id, tgts)  => {},
    rsc    : { get: () => '' },
  };

  const mockPacer = pacer ?? {
    submit: async (_label, fn, _ms) => fn(),
  };

  const mockSession = {
    client: mockClient,
    pacer: mockPacer,
    world: { room: { isSanctuary: false } },
    walkTo: async (col, row, opts) => walkResult,
  };

  // The keeper keeps session as `this.s`; in the BT bb, session IS the keeper.
  // We set bb.session = { s: mockSession } to match what _session(bb) expects.
  const bb = {
    _bt: {},
    ws: {},
    client: mockClient,
    session: { s: mockSession },
    // Inject skill overrides via bb for tests that can't easily mock the module.
    _mockEquipResult: equipResult,
    _mockWearResult: wearResult,
    _mockWeapons: weapons,
  };

  return { bb, mockClient, mockSession, mockPacer };
}

// ---------------------------------------------------------------------------
// Tick helper: ticks a node up to maxTicks times until it reaches a terminal.
// ---------------------------------------------------------------------------
async function tickUntilDone(node, bb, maxTicks = 10) {
  let result;
  for (let i = 0; i < maxTicks; i++) {
    result = node.tick(bb);
    if (result === SUCCESS || result === FAILURE) return result;
    // RUNNING — wait one microtask for the promise to settle
    await new Promise(r => setTimeout(r, 5));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Section: world-state keys declared on each atomic
// ---------------------------------------------------------------------------

section('pre/effects metadata');

{
  const equip = EquipWeaponAction();
  assert('EquipWeaponAction has pre array',   Array.isArray(equip.pre));
  assert('EquipWeaponAction has effects',     equip.effects.includes('armed'));

  const wear = WearArmourAction();
  assert('WearArmourAction effects armour_worn', wear.effects.includes('armour_worn'));

  const pick = PickUpAction(42);
  assert('PickUpAction pre includes item_on_floor_42', pick.pre.includes('item_on_floor_42'));
  assert('PickUpAction effects holding_42',             pick.effects.includes('holding_42'));
  assert('PickUpAction effects !item_on_floor_42',      pick.effects.includes('!item_on_floor_42'));

  const drop = DropAction(42);
  assert('DropAction pre includes holding_42',          drop.pre.includes('holding_42'));
  assert('DropAction effects !holding_42',              drop.effects.includes('!holding_42'));

  const move = MoveToSquareAction(5, 10);
  assert('MoveToSquareAction has no pre',       move.pre.length === 0);
  assert('MoveToSquareAction effects at_square', move.effects.includes('at_square_5_10'));

  const atk = AttackAction(99);
  assert('AttackAction pre includes armed',      atk.pre.includes('armed'));
  assert('AttackAction pre includes has_target', atk.pre.includes('has_target'));
  assert('AttackAction effects !has_target',     atk.effects.includes('!has_target'));

  const rest = RestAction();
  assert('RestAction pre includes in_sanctuary', rest.pre.includes('in_sanctuary'));
  assert('RestAction effects resting',           rest.effects.includes('resting'));

  const stand = StandAction();
  assert('StandAction pre includes resting',     stand.pre.includes('resting'));
  assert('StandAction effects !resting',         stand.effects.includes('!resting'));

  const cast = CastAction(7);
  assert('CastAction pre includes knows_spell_7',  cast.pre.includes('knows_spell_7'));
  assert('CastAction pre includes mana_available', cast.pre.includes('mana_available'));
  assert('CastAction effects spell_cast_7',        cast.effects.includes('spell_cast_7'));
}

// ---------------------------------------------------------------------------
// Section: slot pattern — first tick returns RUNNING, settles to terminal
// ---------------------------------------------------------------------------

section('slot pattern');

{
  const { bb, mockClient } = makeMock({ inventory: [{ id: 99 }] });
  mockClient.room.objects.set(99, { id: 99 });

  const node = PickUpAction(99);
  const first = node.tick(bb);
  ok('first tick is RUNNING', first, RUNNING);
  assert('slot stashed in bb._bt', !!bb._bt[`at_pick_up_99`]);

  const final = await tickUntilDone(node, bb);
  assert('settles to SUCCESS or FAILURE', final === SUCCESS || final === FAILURE);
  assert('slot cleaned up after terminal', !bb._bt[`at_pick_up_99`]);
}

// ---------------------------------------------------------------------------
// Section: MoveToSquareAction — arrived path and failed path
// ---------------------------------------------------------------------------

section('MoveToSquareAction');

{
  const { bb } = makeMock({ walkResult: { arrived: true } });
  const node = MoveToSquareAction(3, 7);
  const result = await tickUntilDone(node, bb);
  ok('arrives → SUCCESS', result, SUCCESS);
  assert('sets at_square_3_7 in ws', !!bb.ws['at_square_3_7']);
}

{
  const { bb } = makeMock({ walkResult: { arrived: false } });
  const node = MoveToSquareAction(3, 7);
  const result = await tickUntilDone(node, bb);
  ok('blocked → FAILURE', result, FAILURE);
  assert('does not set at_square when blocked', !bb.ws['at_square_3_7']);
}

// ---------------------------------------------------------------------------
// Section: PickUpAction — item confirmed in inventory → SUCCESS
// ---------------------------------------------------------------------------

section('PickUpAction');

{
  const itemId = 55;
  let gotCmd = null;
  const { bb, mockClient } = makeMock({ inventory: [] });
  mockClient.get = (id) => {
    gotCmd = id;
    // Simulate server adding item to inventory.
    mockClient.inventory = [{ id: itemId }];
  };

  const node = PickUpAction(itemId);
  const result = await tickUntilDone(node, bb);
  ok('item picked up → SUCCESS', result, SUCCESS);
  ok('sent get to correct id', gotCmd, itemId);
  assert('ws.holding_55 set', !!bb.ws[`holding_${itemId}`]);
  assert('ws.item_on_floor_55 cleared', bb.ws[`item_on_floor_${itemId}`] === false);
}

{
  // Item never appears in inventory (server refused silently).
  const itemId = 56;
  const { bb, mockClient } = makeMock({ inventory: [] });
  mockClient.get = () => {};   // inventory stays empty

  const node = PickUpAction(itemId);
  const result = await tickUntilDone(node, bb);
  ok('item not received → FAILURE', result, FAILURE);
  assert('ws.holding_56 not set', !bb.ws[`holding_${itemId}`]);
}

// ---------------------------------------------------------------------------
// Section: DropAction — item gone from inventory → SUCCESS
// ---------------------------------------------------------------------------

section('DropAction');

{
  const itemId = 77;
  const inv = [{ id: itemId }];
  const { bb, mockClient } = makeMock({ inventory: inv });
  mockClient.drop = (specs) => { mockClient.inventory = []; };

  const node = DropAction(itemId);
  const result = await tickUntilDone(node, bb);
  ok('item dropped → SUCCESS', result, SUCCESS);
  assert('ws.holding_77 cleared', bb.ws[`holding_${itemId}`] === false);
  assert('ws.item_on_floor_77 set', !!bb.ws[`item_on_floor_${itemId}`]);
}

// ---------------------------------------------------------------------------
// Section: AttackAction — swing sent → SUCCESS; sets target_dead when foe gone
// ---------------------------------------------------------------------------

section('AttackAction');

{
  const foeId = 33;
  let swung = null;
  const roomObjects = new Map([[foeId, { id: foeId }]]);
  const { bb, mockClient } = makeMock({ roomObjects });
  mockClient.attack = (id) => {
    swung = id;
    // Foe survives this swing.
  };

  const node = AttackAction(foeId);
  const result = await tickUntilDone(node, bb);
  ok('swing sent → SUCCESS', result, SUCCESS);
  ok('attacked correct id', swung, foeId);
  assert('target_dead not set while foe alive', !bb.ws.target_dead);
}

{
  const foeId = 34;
  let swung = null;
  const roomObjects = new Map([[foeId, { id: foeId }]]);
  const { bb, mockClient } = makeMock({ roomObjects });
  mockClient.attack = (id) => {
    swung = id;
    roomObjects.delete(foeId);   // foe dies on this swing
  };

  const node = AttackAction(foeId);
  const result = await tickUntilDone(node, bb);
  ok('swing that kills → SUCCESS', result, SUCCESS);
  assert('target_dead set when foe gone', !!bb.ws.target_dead);
}

// ---------------------------------------------------------------------------
// Section: RestAction and StandAction
// ---------------------------------------------------------------------------

section('RestAction / StandAction');

{
  const { bb, mockClient } = makeMock();
  mockClient.rest = () => {};

  const node = RestAction();
  const result = await tickUntilDone(node, bb);
  ok('rest → SUCCESS', result, SUCCESS);
  assert('ws.resting set', !!bb.ws.resting);
}

{
  const { bb, mockClient } = makeMock();
  mockClient.stand = () => {};
  bb.ws.resting = true;

  const node = StandAction();
  const result = await tickUntilDone(node, bb);
  ok('stand → SUCCESS', result, SUCCESS);
  assert('ws.resting cleared', bb.ws.resting === false);
}

// ---------------------------------------------------------------------------
// Section: CastAction — waitFor resolves → SUCCESS, sets ws key
// ---------------------------------------------------------------------------

section('CastAction');

{
  const spellId = 7;
  let castArg = null;
  const { bb, mockClient } = makeMock();
  mockClient.cast = (id, tgts) => { castArg = { id, tgts }; };

  const node = CastAction(spellId, []);
  const result = await tickUntilDone(node, bb);
  ok('cast → SUCCESS', result, SUCCESS);
  ok('cast correct spell id', castArg?.id, spellId);
  assert(`ws.spell_cast_${spellId} set`, !!bb.ws[`spell_cast_${spellId}`]);
}

// ---------------------------------------------------------------------------
// Section: syncWorldState — reads client state into bb.ws
// ---------------------------------------------------------------------------

section('syncWorldState');

{
  const { bb, mockClient, mockSession } = makeMock({
    vitals: { health: { value: 20, max: 40 }, mana: { value: 5, max: 20 } },
  });
  mockSession.world.room.isSanctuary = true;

  syncWorldState(bb);

  assert('mana_available when mana > 0', !!bb.ws.mana_available);
  assert('in_sanctuary when room is sanctuary', !!bb.ws.in_sanctuary);
}

{
  const { bb, mockSession } = makeMock({
    vitals: { health: { value: 20, max: 40 }, mana: { value: 0, max: 20 } },
  });
  mockSession.world.room.isSanctuary = false;

  syncWorldState(bb);
  assert('mana_available false when mana = 0', !bb.ws.mana_available);
  assert('in_sanctuary false when not sanctuary', !bb.ws.in_sanctuary);
}

// ---------------------------------------------------------------------------
// Section: unique slot keys — two atomics of the same type do not collide
// ---------------------------------------------------------------------------

section('unique slot keys per instance');

{
  const a = PickUpAction(10);
  const b = PickUpAction(20);
  assert('different item ids → different keys', a.key !== b.key);

  const c = AttackAction(1);
  const d = AttackAction(2);
  assert('different target ids → different keys', c.key !== d.key);

  const e = MoveToSquareAction(1, 2);
  const f = MoveToSquareAction(3, 4);
  assert('different squares → different keys', e.key !== f.key);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
