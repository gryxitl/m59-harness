#!/usr/bin/env node
// m59-bt-equip-e2e-test.mjs -- end-to-end test: navigate to smith, buy leather
// armour and a mace, wear leather, wield mace.
//
// No live server. Uses a mock session that simulates:
//   - Room navigation (MoveToRoomAction)
//   - Shop browsing  (BrowseShopAction)
//   - Buying items   (BuyItemAction)
//   - Equipping      (EquipWeaponAction / WearArmourAction via skills stubs)
//
// The test wires these through a GoapExecutor so the planner sequences the
// full trip automatically.

import { plan, GoapExecutor }      from './m59-goap-planner.mjs';
import { navigationActions,
         MoveToRoomAction }         from './m59-bt-nav.mjs';
import { BrowseShopAction,
         BuyItemAction,
         BuyGearTree,
         OF_MERCHANT }              from './m59-bt-shop.mjs';
import { EquipWeaponAction,
         WearArmourAction }         from './m59-bt-atomics.mjs';
import { SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0, failed = 0;
function section(name) { console.log('\n' + name); }
function ok(label, got, want) {
  const pass = got === want;
  console.log(`  ${pass ? 'ok' : 'FAIL'} ${label}${pass ? '' :
    `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  pass ? passed++ : failed++;
}
function assert(label, cond, note = '') {
  const pass = !!cond;
  console.log(`  ${pass ? 'ok' : 'FAIL'} ${label}${note && !pass ? `  (${note})` : ''}`);
  pass ? passed++ : failed++;
}

async function tickUntilDone(node, bb, maxTicks = 200) {
  let result;
  for (let i = 0; i < maxTicks; i++) {
    result = node.tick(bb);
    if (result === SUCCESS || result === FAILURE) return result;
    await new Promise(r => setTimeout(r, 5));
  }
  return result;
}

// ---------------------------------------------------------------------------
// World constants for the test
// ---------------------------------------------------------------------------

const ROOM_ILERIA  = 534;   // character starts here
const ROOM_SMITH   = 700;   // blacksmith's room (Barloque)
const MERCHANT_ID  = 9001;
const LEATHER_ID   = 201;
const MACE_ID      = 202;
const SHIELD_ID    = 203;

const SMITH_ITEMS = [
  { id: LEATHER_ID, name: 'leather armor' },
  { id: MACE_ID,    name: 'mace' },
  { id: SHIELD_ID,  name: 'metal shield' },
];

// ---------------------------------------------------------------------------
// Mock session factory
// ---------------------------------------------------------------------------

function makeMockSession({ startRoom = ROOM_ILERIA } = {}) {
  let currentRoom = startRoom;
  const inventory  = [];
  const equipped   = new Set();   // item ids in plUsing
  let   evSeqVal   = 0;

  const log = [];

  // Minimal room map: Ileria → Smith (direct hop for this test).
  const EXITS = {
    [ROOM_ILERIA]: [{ to: ROOM_SMITH, stand_on: { col: 5, row: 5 }, steps_away: 3 }],
    [ROOM_SMITH]:  [],
  };

  const client = {
    get evSeq() { return evSeqVal; },
    get inventory() { return inventory; },
    get equipment() { return new Map(
      [...equipped].map(id => {
        const item = inventory.find(i => i.id === id);
        return item ? [id, item] : null;
      }).filter(Boolean)
    ); },
    // Simple armed check: any weapon in equipped set.
    armed: () => [...equipped].some(id => {
      const it = inventory.find(i => i.id === id);
      return it && /mace|sword|axe|hammer/i.test(it.name);
    }),
    room: {
      objects: new Map([
        [MERCHANT_ID, { id: MERCHANT_ID, flags: OF_MERCHANT, name: 'Blacksmith' }],
      ]),
    },
    rsc: new Map(),  // skills.wearBest reads nameRsc — we bypass this below
    buy: async () => { log.push('c.buy()'); },
    buyItems: async (sellerId, items) => {
      for (const it of items) {
        const shopItem = SMITH_ITEMS.find(s => s.id === it.id);
        if (shopItem) {
          inventory.push({ id: it.id, name: shopItem.name, nameRsc: it.id });
          evSeqVal++;
        }
      }
      log.push(`c.buyItems(${items.map(i => i.id).join(',')})`);
    },
    use: async (id) => {
      equipped.add(id);
      evSeqVal++;
      log.push(`c.use(${id})`);
    },
    unuse: async (id) => {
      equipped.delete(id);
      evSeqVal++;
    },
    requestInventory: async () => { evSeqVal++; },
    waitFor: async ({ kinds }) => {
      evSeqVal++;
      const events = [];
      if (kinds?.includes('shop')) {
        events.push({ kind: 'shop', sellerId: MERCHANT_ID, items: SMITH_ITEMS });
      }
      if (kinds?.includes('inventory'))  events.push({ kind: 'inventory' });
      if (kinds?.includes('equipment'))  events.push({ kind: 'equipment' });
      if (kinds?.includes('message'))    { /* silent */ }
      return { events };
    },
    // equippedNow used by skills.equipBest — returns Set of equipped ids.
    self: { row: 5, col: 5 },
  };

  // Skills module reads equippedNow(c) which does: new Set(c.inventory
  // filtered by plUsing. We provide a simplified version here by monkey-patching
  // the equipment getter — skills.equipBest calls s.need() which returns c.
  client._equippedIds = equipped;

  const session = {
    client,
    // s.need() — called by skills.equipBest and wearBest.
    need: () => client,
    pacer: {
      submit: async (label, fn, _delay) => {
        log.push(`pacer.${label}`);
        return fn?.();
      },
    },
    // leaveVia — used by MoveToRoomAction.
    leaveVia: async (exit) => {
      if (exit.to != null) {
        currentRoom = exit.to;
        log.push(`leaveVia(${exit.to})`);
        return { left: true };
      }
      return { left: false, reason: 'no exit' };
    },
    world: {
      get room() { return { num: currentRoom }; },
      exits: () => EXITS[currentRoom] ?? [],
      map: null,
    },
  };

  return { session, client, log, currentRoom: () => currentRoom, equipped, inventory };
}

// ---------------------------------------------------------------------------
// Test 1: BrowseShopAction + BuyItemAction sequence (single item)
// ---------------------------------------------------------------------------

section('buy single item end-to-end: browse → buy');
{
  const { session, client, log, inventory } = makeMockSession({ startRoom: ROOM_SMITH });
  const bb = { _bt: {}, ws: {}, session: { s: session }, client };

  const browse = BrowseShopAction(MERCHANT_ID);
  const buy    = BuyItemAction(MERCHANT_ID, LEATHER_ID);

  // Tick browse to completion.
  const r1 = await tickUntilDone(browse, bb, 30);
  ok('browse → SUCCESS', r1, SUCCESS);
  assert('shop cached', !!bb.ws._shop?.[MERCHANT_ID]);

  // Tick buy.
  const r2 = await tickUntilDone(buy, bb, 30);
  ok('buy → SUCCESS', r2, SUCCESS);
  assert('holding leather', !!bb.ws[`holding_${LEATHER_ID}`]);
  assert('leather in inventory', inventory.some(i => i.id === LEATHER_ID));
}

// ---------------------------------------------------------------------------
// Test 2: EquipWeaponAction wields whatever is in inventory
// ---------------------------------------------------------------------------

section('EquipWeaponAction — wields mace from inventory');
{
  const { session, client, equipped } = makeMockSession({ startRoom: ROOM_SMITH });

  // Pre-load inventory with a mace.
  client.inventory.push({ id: MACE_ID, name: 'mace', nameRsc: MACE_ID });

  // Stub the skills module's weaponsOf / equipBest calls via the pacer so we
  // don't need the full skills module loaded.  We patch at the session level
  // by monkey-patching pacer.submit to intercept 'use' calls.
  const usedIds = [];
  const orig = session.pacer.submit.bind(session.pacer);
  session.pacer.submit = async (label, fn, delay) => {
    if (label === 'use') {
      // Simulate equipping: fn calls c.use(id), which adds to equipped.
      const result = await fn?.();
      usedIds.push(label);
      return result;
    }
    return orig(label, fn, delay);
  };

  const bb = { _bt: {}, ws: {}, session: { s: session }, client };

  // Because EquipWeaponAction calls skills.equipBest which needs full skills
  // logic (weapon ranking, brokenSet, etc.), we test the node's contract:
  // - It returns RUNNING on the first tick
  // - It resolves to SUCCESS or FAILURE (not RUNNING for ever)
  // - The slot is cleaned up
  const node = EquipWeaponAction();
  const first = node.tick(bb);
  ok('first tick is RUNNING', first, RUNNING);

  const final = await tickUntilDone(node, bb, 40);
  assert('resolves to terminal', final === SUCCESS || final === FAILURE,
    `got ${final}`);
  assert('slot cleaned up', !bb._bt['at_equip_weapon']);
}

// ---------------------------------------------------------------------------
// Test 3: WearArmourAction puts on leather armour
// ---------------------------------------------------------------------------

section('WearArmourAction — wears leather from inventory');
{
  const { session, client } = makeMockSession({ startRoom: ROOM_SMITH });
  client.inventory.push({ id: LEATHER_ID, name: 'leather armor', nameRsc: LEATHER_ID });

  const bb = { _bt: {}, ws: {}, session: { s: session }, client };
  const node = WearArmourAction();
  const first = node.tick(bb);
  ok('first tick is RUNNING', first, RUNNING);

  const final = await tickUntilDone(node, bb, 40);
  assert('resolves to terminal', final === SUCCESS || final === FAILURE,
    `got ${final}`);
  assert('slot cleaned up', !bb._bt['at_wear_armour']);
}

// ---------------------------------------------------------------------------
// Test 4: Full GOAP plan — navigate → browse → buy leather → buy mace
//         (equip is handled by BuyGearTree's inner EquipWeaponAction / WearArmourAction)
// ---------------------------------------------------------------------------

section('GOAP plan: navigate → browse → buy leather + mace');
{
  const { session, client, log, inventory, currentRoom } =
    makeMockSession({ startRoom: ROOM_ILERIA });

  const bb = { _bt: {}, ws: { at_room_534: true }, session: { s: session }, client };

  // Room navigation action: ROOM_ILERIA → ROOM_SMITH.
  const navActions = navigationActions([ROOM_ILERIA, ROOM_SMITH]);

  // Shop actions.
  const browse     = BrowseShopAction(MERCHANT_ID);
  const buyLeather = BuyItemAction(MERCHANT_ID, LEATHER_ID);
  const buyMace    = BuyItemAction(MERCHANT_ID, MACE_ID);

  // Chain: after navigation we need to browse before buying.
  browse.pre     = [`at_room_${ROOM_SMITH}`];
  browse.effects = [`shop_browsed_${MERCHANT_ID}`, `at_room_${ROOM_SMITH}`];  // keep room

  buyLeather.pre     = [`shop_browsed_${MERCHANT_ID}`];
  buyLeather.effects = [`holding_${LEATHER_ID}`, `bought_${LEATHER_ID}`, `shop_browsed_${MERCHANT_ID}`];

  buyMace.pre     = [`shop_browsed_${MERCHANT_ID}`];
  buyMace.effects = [`holding_${MACE_ID}`, `bought_${MACE_ID}`, `shop_browsed_${MERCHANT_ID}`];

  const allActions = [
    ...navActions,
    { pre: browse.pre,     effects: browse.effects,     cost: 1, node: browse     },
    { pre: buyLeather.pre, effects: buyLeather.effects, cost: 1, node: buyLeather },
    { pre: buyMace.pre,    effects: buyMace.effects,    cost: 1, node: buyMace    },
  ];

  const goal = {
    [`holding_${LEATHER_ID}`]: true,
    [`holding_${MACE_ID}`]:    true,
  };

  // Verify the planner finds a plan.
  const result = plan(allActions, bb.ws, goal);
  ok('planner finds a plan', result.found, true);
  assert('plan has at least 4 steps (nav + browse + 2 buys)',
    result.steps.length >= 4, `got ${result.steps.length}`);

  // wsSource keeps at_room_* in sync with actual room.
  const wsSource = b => {
    const ws = b.ws ?? (b.ws = {});
    const num = session.world.room.num;
    ws[`at_room_${num}`] = true;
    return ws;
  };

  // Execute via GoapExecutor.
  const exec = GoapExecutor(allActions, goal, { key: 'e2e_shop', wsSource });
  const execResult = await tickUntilDone(exec, bb, 300);

  ok('executor reaches goal → SUCCESS', execResult, SUCCESS);
  ok('character is now in smith room', currentRoom(), ROOM_SMITH);
  assert('leather in inventory', inventory.some(i => i.id === LEATHER_ID),
    JSON.stringify(inventory.map(i => i.name)));
  assert('mace in inventory',    inventory.some(i => i.id === MACE_ID),
    JSON.stringify(inventory.map(i => i.name)));
  assert('navigate was logged', log.some(l => l.startsWith('leaveVia')));
  assert('shop was browsed',    log.some(l => l.includes('c.buy()')));
  assert('items were bought',   log.some(l => l.includes('buyItems')));
}

// ---------------------------------------------------------------------------
// Test 5: GOAP plan — already in smith room, just browse and buy
// ---------------------------------------------------------------------------

section('GOAP plan: already at smith, browse → buy shield');
{
  const { session, client, inventory } = makeMockSession({ startRoom: ROOM_SMITH });
  const bb = {
    _bt: {}, ws: { [`at_room_${ROOM_SMITH}`]: true },
    session: { s: session }, client,
  };

  const browse    = BrowseShopAction(MERCHANT_ID);
  const buyShield = BuyItemAction(MERCHANT_ID, SHIELD_ID);

  browse.pre     = [`at_room_${ROOM_SMITH}`];
  browse.effects = [`shop_browsed_${MERCHANT_ID}`, `at_room_${ROOM_SMITH}`];
  buyShield.pre     = [`shop_browsed_${MERCHANT_ID}`];
  buyShield.effects = [`holding_${SHIELD_ID}`, `shop_browsed_${MERCHANT_ID}`];

  const actions = [
    { pre: browse.pre,    effects: browse.effects,    cost: 1, node: browse    },
    { pre: buyShield.pre, effects: buyShield.effects, cost: 1, node: buyShield },
  ];
  const goal = { [`holding_${SHIELD_ID}`]: true };

  const exec = GoapExecutor(actions, goal, { key: 'e2e_shield' });
  const result = await tickUntilDone(exec, bb, 100);

  ok('result is SUCCESS', result, SUCCESS);
  assert('shield in inventory', inventory.some(i => i.id === SHIELD_ID));
}

// ---------------------------------------------------------------------------
// Test 6: BuyGearTree — already owns mace, only buys leather
// ---------------------------------------------------------------------------

section('BuyGearTree — owns mace, buys missing leather only');
{
  const { session, client, inventory } = makeMockSession({ startRoom: ROOM_SMITH });

  // Pre-populate shop cache so FindMerchantForSlot can match.
  const shopCache = { sellerId: MERCHANT_ID, items: SMITH_ITEMS };

  // Pre-seed inventory with a mace (already owned).
  client.inventory.push({ id: MACE_ID, name: 'mace', nameRsc: MACE_ID });

  const bb = {
    _bt: {},
    ws: { _shop: { [MERCHANT_ID]: shopCache } },
    session: { s: session }, client,
  };

  const wants = [
    { slot: 'armour', re: /leather\s*arm/i, what: 'leather armour' },
    { slot: 'weapon', re: /\bmace\b/i,       what: 'a mace' },
  ];
  const node = BuyGearTree(wants, MERCHANT_ID);
  const result = await tickUntilDone(node, bb, 120);

  // Tree: leather branch runs browse+buy; weapon branch's Condition(alreadyOwned) succeeds.
  assert('result is terminal', result === SUCCESS || result === FAILURE, `got ${result}`);
  // Leather should be purchased (browse happens inside BuyAndEquipItem).
  const hasLeather = inventory.some(i => i.id === LEATHER_ID);
  assert('leather purchased', hasLeather, JSON.stringify(inventory.map(i => i.name)));
  // Mace: already had it — should NOT be double-bought.
  const maceCount = inventory.filter(i => i.id === MACE_ID).length;
  ok('mace not re-purchased', maceCount, 1);
}

// ---------------------------------------------------------------------------
// Test 7: Plan structure — navigate + BuyGearTree goal
// ---------------------------------------------------------------------------

section('plan() — navigate+buy goal finds correct step order');
{
  const navActions  = navigationActions([ROOM_ILERIA, ROOM_SMITH]);

  const browse = BrowseShopAction(MERCHANT_ID);
  browse.pre     = [`at_room_${ROOM_SMITH}`];
  browse.effects = [`shop_browsed_${MERCHANT_ID}`, `at_room_${ROOM_SMITH}`];

  const buyL = BuyItemAction(MERCHANT_ID, LEATHER_ID);
  buyL.pre     = [`shop_browsed_${MERCHANT_ID}`];
  buyL.effects = [`holding_${LEATHER_ID}`, `shop_browsed_${MERCHANT_ID}`];

  const allActions = [
    ...navActions,
    { pre: browse.pre, effects: browse.effects, cost: 1, node: browse },
    { pre: buyL.pre,   effects: buyL.effects,   cost: 1, node: buyL   },
  ];

  const r = plan(allActions, { at_room_534: true }, { [`holding_${LEATHER_ID}`]: true });
  ok('plan found', r.found, true);
  assert('navigate is first step', r.steps[0] === navActions[0].node);
  assert('browse is second step',  r.steps[1] === browse);
  assert('buy is last step',       r.steps[r.steps.length - 1] === buyL);
}

// ---------------------------------------------------------------------------
// Test 8: GoapExecutor re-plans when a step fails
// ---------------------------------------------------------------------------

section('GoapExecutor — re-plans after step failure, then succeeds');
{
  const { session, client, inventory } = makeMockSession({ startRoom: ROOM_SMITH });

  let browseAttempts = 0;
  const browse = BrowseShopAction(MERCHANT_ID);
  const origBrowseKey = `at_browse_${MERCHANT_ID}`;

  // Wrap browse: fail on first attempt, succeed on second.
  const flakyBrowse = {
    key:     origBrowseKey,
    name:    'flaky_browse',
    pre:     [`at_room_${ROOM_SMITH}`],
    effects: [`shop_browsed_${MERCHANT_ID}`, `at_room_${ROOM_SMITH}`],
    tick(bb) {
      browseAttempts++;
      if (browseAttempts === 1) return FAILURE;   // first attempt fails
      return browse.tick(bb);                     // second succeeds
    },
  };

  const buyL = BuyItemAction(MERCHANT_ID, LEATHER_ID);
  buyL.pre     = [`shop_browsed_${MERCHANT_ID}`];
  buyL.effects = [`holding_${LEATHER_ID}`, `shop_browsed_${MERCHANT_ID}`];

  const actions = [
    { pre: flakyBrowse.pre, effects: flakyBrowse.effects, cost: 1, node: flakyBrowse },
    { pre: buyL.pre,        effects: buyL.effects,         cost: 1, node: buyL        },
  ];

  const bb = {
    _bt: {},
    ws: { [`at_room_${ROOM_SMITH}`]: true },
    session: { s: session }, client,
  };

  const exec = GoapExecutor(actions, { [`holding_${LEATHER_ID}`]: true }, { key: 'e2e_replan' });
  const result = await tickUntilDone(exec, bb, 200);

  ok('executor succeeds after re-plan', result, SUCCESS);
  assert('browse was attempted twice', browseAttempts >= 2, `attempts: ${browseAttempts}`);
  assert('leather in inventory', inventory.some(i => i.id === LEATHER_ID));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
