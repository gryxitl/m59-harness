#!/usr/bin/env node
// m59-restock-test.mjs -- offline tests for the restockReagents decomposition.
//   node tools/m59-restock-test.mjs

import { Autopilot } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const tests = [];
function t(name, fn) {
  tests.push({ name, fn });
}
async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++; console.log(`PASS  ${name}`);
    } catch (e) {
      failed++; console.log(`FAIL  ${name}: ${e.message}`);
    }
  }
  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Mock session and keeper
// ---------------------------------------------------------------------------

function mockSession(overrides = {}) {
  return {
    name: 't1',
    need: () => ({
      inventory: [],
      rsc: { get: () => 'shilling' },
      vitals: () => ({ vigor: { value: 100, scale_max: 200 } }),
      ...overrides.client,
    }),
    world: { room: { num: 100 } },
    pacer: { submit: async () => {} },
    ...overrides,
  };
}

function mockKeeper(overrides = {}) {
  const s = mockSession(overrides.session);
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, {
    s,
    policy: {
      reagentTarget: null,
      walkingMoney: 400,
      hungryFloor: 100,
      vigorWant: 0.9,
      fightAboveVigor: 140,
      purchases: { food: true, reagents: true },
      ...overrides.policy,
    },
    name: 't1',
    note: () => {},
    declinedPurchase: () => {},
    recordPurchase: () => {},
    reagentCount: () => ({ elderberry: 0, herbs: 0 }),
    larder: () => [],
    loadout: () => null,
    packAsItems: () => [],
    makeRoomToBuy: async () => {},
    ...overrides,
  });
  return k;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('m59-restock-test.mjs\n');

// --- _restockCalculateNeeds ---

t('_restockCalculateNeeds: calculates needs when empty', () => {
  const k = mockKeeper({
    reagentCount: () => ({ elderberry: 0, herbs: 0 }),
  });
  const r = k._restockCalculateNeeds();
  if (r.need.elderberry <= 0) throw new Error('expected elderberry need > 0');
  if (r.need.herb <= 0) throw new Error('expected herb need > 0');
  if (r.mayBuyFood !== true) throw new Error('expected mayBuyFood=true');
  if (r.mayBuyReagents !== true) throw new Error('expected mayBuyReagents=true');
});

t('_restockCalculateNeeds: no needs when stocked', () => {
  const k = mockKeeper({
    reagentCount: () => ({ elderberry: 100, herbs: 100 }),
  });
  const r = k._restockCalculateNeeds();
  if (r.need.elderberry > 0) throw new Error('expected elderberry need = 0');
  if (r.need.herb > 0) throw new Error('expected herb need = 0');
});

t('_restockCalculateNeeds: wantsFood when no larder', () => {
  const k = mockKeeper({
    larder: () => [],
  });
  const r = k._restockCalculateNeeds();
  if (r.wantsFood !== true) throw new Error('expected wantsFood=true');
  if (r.emptyLarder !== true) throw new Error('expected emptyLarder=true');
  if (r.hungryNow !== true) throw new Error('expected hungryNow=true');
});

t('_restockCalculateNeeds: not hungry when larder has food and vigor is high', () => {
  const k = mockKeeper({
    larder: () => [{ name: 'bread' }],
    session: { client: { vitals: () => ({ vigor: { value: 190, scale_max: 200 } }) } },
  });
  const r = k._restockCalculateNeeds();
  if (r.emptyLarder !== false) throw new Error('expected emptyLarder=false');
  if (r.hungryNow !== false) throw new Error('expected hungryNow=false');
});

// --- _restockCheckBudget ---

// MONEY BROUGHT TO A SHOP IS MONEY TO SPEND AT THE SHOP.
//
// These three asserted the ORIGINAL rule — floor = walkingMoney (400), relaxed to
// hungryFloor (100) when hungry — which was deliberately changed to zero, and the
// reasoning is recorded at the call site in m59-autopilot.mjs. walkingMoney is also the
// level bankRun banks DOWN to, so the two met exactly: a character banked to 400, walked to
// a merchant, found its purse at the floor, declined, and walked back. Measured with the
// shipped 500/400 — restocks arriving 150 shillings at a time against a 3,360sh fill, the
// fleet trading 54% of its active time against 17% fighting, three characters that had not
// fought at all.
//
// So these now pin the CURRENT rule. A test that keeps asserting a superseded design is
// not protecting anything; it just fails until somebody deletes it.
t('_restockCheckBudget: the default floor is zero — a shop is where the money is for', () => {
  const k = mockKeeper();
  const r = k._restockCheckBudget(500, { hungryNow: false });
  if (r.canBuy !== true) throw new Error('expected canBuy=true');
  if (r.floor !== 0) throw new Error(`expected floor=0, got ${r.floor}`);
  if (r.budget !== 500) throw new Error(`expected the whole purse as budget, got ${r.budget}`);
});

t('_restockCheckBudget: an empty purse still cannot buy', () => {
  const k = mockKeeper();
  const r = k._restockCheckBudget(0, { hungryNow: false });
  if (r.canBuy !== false) throw new Error('expected canBuy=false');
});

t('_restockCheckBudget: shopFloor is how a reserve is asked for', () => {
  const k = mockKeeper({ policy: { shopFloor: 100 } });
  const r = k._restockCheckBudget(150, { hungryNow: false });
  if (r.floor !== 100) throw new Error(`expected floor=100, got ${r.floor}`);
  if (r.canBuy !== true) throw new Error('expected canBuy=true');
  if (r.budget !== 50) throw new Error(`expected budget=50, got ${r.budget}`);
  const at = k._restockCheckBudget(100, { hungryNow: false });
  if (at.canBuy !== false) throw new Error('a purse exactly at the floor cannot buy');
});

// --- _restockRankItems ---

t('_restockRankItems: returns empty when shop is empty', () => {
  const k = mockKeeper();
  const shop = { items: [] };
  const ctx = {
    need: { elderberry: 10, herb: 10 },
    askedFor: {},
    mayBuyReagents: true,
    mayBuyFood: true,
    hungryNow: true,
    emptyLarder: true,
    budget: 100,
  };
  const r = k._restockRankItems(shop, ctx);
  if (r.reagents.length !== 0) throw new Error('expected no reagents');
  if (r.food.length !== 0) throw new Error('expected no food');
});

t('_restockRankItems: ranks reagents when short', () => {
  const k = mockKeeper();
  const shop = {
    items: [
      { name: 'elderberry', cost: 10 },
      { name: 'herb', cost: 10 },
      { name: 'bread', cost: 5 },
    ],
  };
  const ctx = {
    need: { elderberry: 5, herb: 5 },
    askedFor: {},
    mayBuyReagents: true,
    mayBuyFood: false,
    hungryNow: false,
    emptyLarder: false,
    budget: 100,
  };
  const r = k._restockRankItems(shop, ctx);
  if (r.reagents.length !== 2) throw new Error(`expected 2 reagents, got ${r.reagents.length}`);
});

// --- _restockBuyItems ---

t('_restockBuyItems: returns empty when no items', async () => {
  const k = mockKeeper();
  const shop = { sellerId: 1 };
  const seller = { id: 1, nameRsc: null };
  const r = await k._restockBuyItems(shop, seller, []);
  if (r.length !== 0) throw new Error('expected empty array');
});

t('_restockBuyItems: buys items and returns list', async () => {
  const bought = [];
  const k = mockKeeper({
    s: {
      pacer: { submit: async (kind, fn) => {
        if (kind === 'buy') {
          const result = await fn();
          bought.push(result);
        }
      }},
      need: () => ({
        buyItems: async () => ({ success: true }),
        requestInventory: async () => {},
        rsc: { get: () => null },
      }),
    },
  });
  const shop = { sellerId: 1 };
  const seller = { id: 1, nameRsc: null };
  const items = [{ name: 'elderberry', cost: 10, id: 100 }];
  const r = await k._restockBuyItems(shop, seller, items);
  if (r.length !== 1) throw new Error(`expected 1 item bought, got ${r.length}`);
  if (!r[0].includes('elderberry')) throw new Error(`expected 'elderberry' in result, got ${r[0]}`);
});

// ---------------------------------------------------------------------------

run();
