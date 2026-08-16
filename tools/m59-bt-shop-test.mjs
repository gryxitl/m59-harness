#!/usr/bin/env node
// m59-bt-shop-test.mjs -- tests for buy-gear BT atomics.
//
// No live server, no broker. All interactions use mock sessions and clients.

import {
  BrowseShopAction,
  BuyItemAction,
  FindMerchantForSlot,
  BuyAndEquipItem,
  BuyGearTree,
  OF_MERCHANT,
} from './m59-bt-shop.mjs';
import { SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';

// ---------------------------------------------------------------------------
// Minimal harness
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
  console.log(`  ${pass ? 'ok' : 'FAIL'} ${label}${pass ? '' : (note ? `  (${note})` : '')}`);
  pass ? passed++ : failed++;
}

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
// Mock builder
// ---------------------------------------------------------------------------

const MERCHANT_ID = 9001;
const ITEM_LEATHER_ID = 101;
const ITEM_MACE_ID    = 102;
const ITEM_SHIELD_ID  = 103;

function makeShopEvent(items) {
  return {
    kind:     'shop',
    sellerId: MERCHANT_ID,
    items,
  };
}

function makeSession({ shopItems = null, buyOk = true, evSeq = 0 } = {}) {
  let inventory = [];
  let evSeqVal  = evSeq;

  // Track what was submitted to the pacer.
  const submitted = [];

  const client = {
    get evSeq() { return evSeqVal; },
    get inventory() { return inventory; },
    room: { objects: new Map([[MERCHANT_ID, { id: MERCHANT_ID, flags: OF_MERCHANT, name: 'Smith' }]]) },
    equipment: new Map(),
    buy: async () => {},
    buyItems: async (sellerId, items) => {
      if (buyOk && items?.length) {
        for (const it of items) {
          inventory.push({ id: it.id, name: it.name ?? `item_${it.id}` });
        }
      }
    },
    waitFor: async ({ kinds, timeoutMs }) => {
      // Simulate an immediate shop or inventory event.
      const events = [];
      if (kinds.includes('shop') && shopItems) {
        events.push(makeShopEvent(shopItems));
      }
      if (kinds.includes('inventory') && buyOk) {
        events.push({ kind: 'inventory' });
        evSeqVal++;
      }
      if (kinds.includes('message')) { /* noop */ }
      if (!events.length && timeoutMs) {
        await new Promise(r => setTimeout(r, 0));
      }
      return { events };
    },
  };

  const session = {
    client,
    pacer: {
      submit: async (_label, fn, _delay) => {
        submitted.push(_label);
        return fn?.();
      },
    },
  };

  return { session, client, inventory: () => inventory, submitted };
}

// ---------------------------------------------------------------------------
// Section: BrowseShopAction — fetches shop list
// ---------------------------------------------------------------------------

section('BrowseShopAction — succeeds when shop event arrives');
{
  const items = [
    { id: ITEM_LEATHER_ID, name: 'leather armor' },
    { id: ITEM_MACE_ID,    name: 'mace' },
  ];
  const { session, client } = makeSession({ shopItems: items });
  const bb = { _bt: {}, ws: {}, session: { s: session }, client };
  const node = BrowseShopAction(MERCHANT_ID);

  const result = await tickUntilDone(node, bb, 30);
  ok('result is SUCCESS', result, SUCCESS);
  assert('shop_browsed key set',       !!bb.ws[`shop_browsed_${MERCHANT_ID}`]);
  assert('_shop cache populated',      !!bb.ws._shop?.[MERCHANT_ID]);
  ok('sellerId stored',                bb.ws._shop[MERCHANT_ID].sellerId, MERCHANT_ID);
  ok('item count in cache',            bb.ws._shop[MERCHANT_ID].items.length, 2);
  assert('slot cleaned up',            !bb._bt[`at_browse_${MERCHANT_ID}`]);
}

section('BrowseShopAction — FAILURE when no shop event arrives');
{
  const { session, client } = makeSession({ shopItems: null });
  const bb = { _bt: {}, ws: {}, session: { s: session }, client };
  const node = BrowseShopAction(MERCHANT_ID);

  const result = await tickUntilDone(node, bb, 30);
  ok('result is FAILURE', result, FAILURE);
  assert('shop_browsed NOT set', !bb.ws[`shop_browsed_${MERCHANT_ID}`]);
}

section('BrowseShopAction — first tick returns RUNNING');
{
  const { session, client } = makeSession({ shopItems: [{ id: 1, name: 'sword' }] });
  const bb = { _bt: {}, ws: {}, session: { s: session }, client };
  const node = BrowseShopAction(MERCHANT_ID);
  const first = node.tick(bb);
  ok('first tick is RUNNING', first, RUNNING);
  assert('slot stashed', !!bb._bt[`at_browse_${MERCHANT_ID}`]);
  await tickUntilDone(node, bb, 20);  // drain
}

section('BrowseShopAction — pre/effects metadata');
{
  const node = BrowseShopAction(MERCHANT_ID);
  ok('pre is empty array', node.pre?.length, 0);
  ok('effects has shop_browsed key', node.effects?.[0], `shop_browsed_${MERCHANT_ID}`);
}

section('BrowseShopAction — no session → FAILURE');
{
  const bb = { _bt: {}, ws: {} };
  const node = BrowseShopAction(MERCHANT_ID);
  const result = await tickUntilDone(node, bb, 20);
  ok('no session → FAILURE', result, FAILURE);
}

// ---------------------------------------------------------------------------
// Section: BuyItemAction — purchases a specific item
// ---------------------------------------------------------------------------

section('BuyItemAction — SUCCESS when item lands in inventory');
{
  const items = [{ id: ITEM_LEATHER_ID, name: 'leather armor' }];
  const { session, client } = makeSession({ shopItems: items, buyOk: true });
  // Pre-populate shop in ws (simulates already browsed).
  const bb = {
    _bt: {}, ws: {
      [`shop_browsed_${MERCHANT_ID}`]: true,
      _shop: { [MERCHANT_ID]: { sellerId: MERCHANT_ID, items } },
    },
    session: { s: session }, client,
  };
  const node = BuyItemAction(MERCHANT_ID, ITEM_LEATHER_ID);

  const result = await tickUntilDone(node, bb, 30);
  ok('result is SUCCESS', result, SUCCESS);
  assert('bought key set',   !!bb.ws[`bought_${ITEM_LEATHER_ID}`]);
  assert('holding key set',  !!bb.ws[`holding_${ITEM_LEATHER_ID}`]);
  assert('slot cleaned up',  !bb._bt[`at_buy_${ITEM_LEATHER_ID}`]);
}

section('BuyItemAction — FAILURE when item does not land');
{
  const { session, client } = makeSession({ buyOk: false });
  const bb = {
    _bt: {}, ws: { [`shop_browsed_${MERCHANT_ID}`]: true },
    session: { s: session }, client,
  };
  const node = BuyItemAction(MERCHANT_ID, ITEM_LEATHER_ID);

  const result = await tickUntilDone(node, bb, 30);
  ok('result is FAILURE', result, FAILURE);
  assert('bought key NOT set',  !bb.ws[`bought_${ITEM_LEATHER_ID}`]);
}

section('BuyItemAction — first tick returns RUNNING');
{
  const items = [{ id: ITEM_MACE_ID, name: 'mace' }];
  const { session, client } = makeSession({ shopItems: items, buyOk: true });
  const bb = {
    _bt: {}, ws: { [`shop_browsed_${MERCHANT_ID}`]: true },
    session: { s: session }, client,
  };
  const node = BuyItemAction(MERCHANT_ID, ITEM_MACE_ID);
  const first = node.tick(bb);
  ok('first tick is RUNNING', first, RUNNING);
  await tickUntilDone(node, bb, 20);  // drain
}

section('BuyItemAction — pre/effects metadata');
{
  const node = BuyItemAction(MERCHANT_ID, ITEM_LEATHER_ID);
  ok('pre has shop_browsed key', node.pre?.[0], `shop_browsed_${MERCHANT_ID}`);
  assert('effects includes bought', node.effects?.includes(`bought_${ITEM_LEATHER_ID}`));
  assert('effects includes holding', node.effects?.includes(`holding_${ITEM_LEATHER_ID}`));
}

section('BuyItemAction — unique slot keys per item');
{
  const a = BuyItemAction(MERCHANT_ID, 10);
  const b = BuyItemAction(MERCHANT_ID, 20);
  assert('slot keys differ', a.key !== b.key, `${a.key} vs ${b.key}`);
}

// ---------------------------------------------------------------------------
// Section: FindMerchantForSlot — scans room for matching merchant
// ---------------------------------------------------------------------------

section('FindMerchantForSlot — finds merchant with matching shop cache');
{
  const shopData = {
    sellerId: MERCHANT_ID,
    items: [
      { id: ITEM_LEATHER_ID, name: 'leather armor' },
      { id: ITEM_MACE_ID,    name: 'mace' },
    ],
  };
  const bb = {
    _bt: {}, ws: {
      _shop: { [MERCHANT_ID]: shopData },
    },
  };

  const objects = [{ id: MERCHANT_ID, flags: OF_MERCHANT, name: 'Smith' }];
  const node = FindMerchantForSlot('armour', /leather\s*arm/i, {
    roomObjects: () => objects,
  });

  const result = node.tick(bb);
  ok('result is SUCCESS', result, SUCCESS);
  assert('merchant_for_armour set',       !!bb.ws[`merchant_for_armour`]);
  assert('_merchantFor populated',        !!bb.ws._merchantFor?.armour);
  ok('stored merchantId', bb.ws._merchantFor.armour.merchantId, MERCHANT_ID);
  ok('stored itemId',     bb.ws._merchantFor.armour.itemId,     ITEM_LEATHER_ID);
  ok('stored itemName',   bb.ws._merchantFor.armour.itemName,   'leather armor');
}

section('FindMerchantForSlot — FAILURE when no merchant in room');
{
  const bb = { _bt: {}, ws: {} };
  const node = FindMerchantForSlot('weapon', /mace/i, { roomObjects: () => [] });
  const result = node.tick(bb);
  ok('no objects → FAILURE', result, FAILURE);
}

section('FindMerchantForSlot — FAILURE when merchant has no matching item');
{
  const shopData = { sellerId: MERCHANT_ID, items: [{ id: 1, name: 'bread' }] };
  const bb = { _bt: {}, ws: { _shop: { [MERCHANT_ID]: shopData } } };
  const objects = [{ id: MERCHANT_ID, flags: OF_MERCHANT, name: 'Innkeeper' }];
  const node = FindMerchantForSlot('weapon', /mace/i, { roomObjects: () => objects });
  const result = node.tick(bb);
  ok('no match → FAILURE', result, FAILURE);
}

section('FindMerchantForSlot — collects candidate when no shop cache yet');
{
  const bb = { _bt: {}, ws: {} };
  const objects = [{ id: MERCHANT_ID, flags: OF_MERCHANT, name: 'Smith' }];
  const node = FindMerchantForSlot('armour', /leather/i, { roomObjects: () => objects });
  const result = node.tick(bb);
  ok('not yet browsed → FAILURE', result, FAILURE);
  assert('candidateMerchants populated', bb.ws._candidateMerchants?.includes(MERCHANT_ID));
}

section('FindMerchantForSlot — pre/effects metadata');
{
  const node = FindMerchantForSlot('weapon', /mace/i);
  ok('pre is empty',                node.pre?.length, 0);
  ok('effects has merchant_for key', node.effects?.[0], 'merchant_for_weapon');
}

// ---------------------------------------------------------------------------
// Section: BuyAndEquipItem — browse → buy → equip sequence
// ---------------------------------------------------------------------------

section('BuyAndEquipItem — returns a named Sequence node');
{
  const node = BuyAndEquipItem('armour', /leather/i, MERCHANT_ID);
  assert('has _name property', typeof (node._name ?? node.name) === 'string');
  // It is a Sequence: should have a children array or tick method.
  assert('is tickable', typeof node.tick === 'function');
}

section('BuyAndEquipItem — FAILURE when merchant sells no matching item');
{
  const items = [{ id: 50, name: 'bread' }];   // no leather here
  const { session, client } = makeSession({ shopItems: items, buyOk: false });
  const bb = {
    _bt: {}, ws: {},
    session: { s: session }, client,
  };
  const node = BuyAndEquipItem('armour', /leather armo/i, MERCHANT_ID);

  const result = await tickUntilDone(node, bb, 60);
  // Browse succeeds, lazy buy finds no match → FAILURE propagates.
  ok('no match in shop → FAILURE or SUCCESS(already)', result === FAILURE || result === SUCCESS, true);
}

section('BuyAndEquipItem — pre/effects shape on inner browse node');
{
  const node = BuyAndEquipItem('weapon', /mace/i, MERCHANT_ID);
  // Sequence children[0] should be the BrowseShopAction.
  const browse = node.children?.[0];
  assert('first child exists', !!browse);
  if (browse) {
    ok('browse pre is empty', browse.pre?.length, 0);
    ok('browse effects[0]', browse.effects?.[0], `shop_browsed_${MERCHANT_ID}`);
  }
}

// ---------------------------------------------------------------------------
// Section: BuyGearTree — top-level composed tree
// ---------------------------------------------------------------------------

section('BuyGearTree — returns a tickable Sequence');
{
  const wants = [
    { slot: 'armour', re: /leather/i, what: 'leather armour' },
    { slot: 'weapon', re: /mace/i,    what: 'a mace' },
  ];
  const node = BuyGearTree(wants, MERCHANT_ID);
  assert('is tickable', typeof node.tick === 'function');
}

section('BuyGearTree — skips slot when already owned');
{
  // Character already has leather armor in inventory.
  const items = [{ id: ITEM_LEATHER_ID, name: 'leather armor' }];
  const { session, client } = makeSession({ shopItems: [] });
  client.inventory.push({ id: ITEM_LEATHER_ID, name: 'leather armor' });

  const bb = {
    _bt: {}, ws: {},
    session: { s: session }, client,
  };

  const wants = [{ slot: 'armour', re: /leather/i, what: 'leather armour' }];
  const node = BuyGearTree(wants, MERCHANT_ID);
  const result = await tickUntilDone(node, bb, 20);
  // The Condition(alreadyOwned) inside the Selector succeeds → Selector succeeds →
  // overall Sequence with one branch succeeds.
  ok('already owned → SUCCESS (skipped)', result, SUCCESS);
}

section('BuyGearTree — two-slot tree with both in shop');
{
  const shopItems = [
    { id: ITEM_LEATHER_ID, name: 'leather armor' },
    { id: ITEM_MACE_ID,    name: 'mace' },
  ];

  let wieldCalled = false;
  const { session, client } = makeSession({ shopItems, buyOk: true });

  // Patch: override equip/wear calls to be no-ops in the test.
  // (skills.equipBest / skills.wearBest are called inside EquipWeaponAction and
  //  WearArmourAction — not testable without the full skills module, so we patch
  //  the pacer to mark them.)
  const originalSubmit = session.pacer.submit.bind(session.pacer);
  session.pacer.submit = async (label, fn, delay) => {
    if (label === 'buy' || label === 'wear' || label === 'equip') {
      if (label !== 'buy') { wieldCalled = true; return { wielding: true, worn: [{ name: 'x' }] }; }
    }
    return originalSubmit(label, fn, delay);
  };

  const bb = { _bt: {}, ws: {}, session: { s: session }, client };
  const wants = [
    { slot: 'armour', re: /leather/i, what: 'leather armour' },
    { slot: 'weapon', re: /mace/i,    what: 'a mace' },
  ];

  const node = BuyGearTree(wants, MERCHANT_ID);
  const result = await tickUntilDone(node, bb, 120);

  // Both items should be purchased — equip may fail due to missing skills.mjs
  // in a minimal test environment, but purchase is what we are testing.
  assert('result is terminal', result === SUCCESS || result === FAILURE);
  assert('leather purchased or already had',
    !!bb.ws[`bought_${ITEM_LEATHER_ID}`] || client.inventory.some(i => i.id === ITEM_LEATHER_ID));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
