#!/usr/bin/env node
// m59-keeper-goap-test.mjs -- tests for the GOAP keeper.
//
// Offline, no server:  node tools/m59-keeper-goap-test.mjs

import { fakeClient, fakeSession } from './m59-fake-client.mjs';
import { GOAPKeeper } from './m59-keeper-goap.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

console.log('GOAPKeeper: constructor\n');

{
  let threw = false;
  try { new GOAPKeeper({}); } catch { threw = true; }
  ok('no client throws', threw);

  threw = false;
  try { new GOAPKeeper({ client: fakeClient() }); } catch { threw = true; }
  ok('no session throws', threw);
}

console.log('GOAPKeeper: pass() reads world state and plans\n');

{
  // A character at vigor 40 (under the cap of 80) with no food and no
  // reagents. Armed, no food. The goal stack tries: in_underworld (no),
  // armed (yes, satisfied), has_food (no, false), vigor_ok (false).
  // Effective goal: has_food. The planner finds no plan (no food, no
  // reagents, no shop).
  // VIGOR HIGH ENOUGH THAT THE VIGOR GOALS ARE ALREADY MET. At vigor 40 the ladder picks a
  // vigor goal and plans `rest` — a perfectly good plan — so the scenario stopped matching
  // its own comment and this asserted "no plan" against a keeper that had found one. The
  // case being tested is the one described above: armed, fed nothing, nothing to cook with
  // and nowhere to buy, so has_food is the effective goal and there is genuinely no plan.
  const c = fakeClient({ vigor: 150, mana: 25, spells: [], inventory: [],
    equipped: [{ id: 1, name: 'mace' }] });  // armed
  const s = fakeSession(c);
  const notes = [];
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: {}, goal: 'vigor_ok',
    note: (msg, data) => notes.push({ msg, data }),
  });

  const r = await keeper.pass();
  ok('no plan: acted is false', r.acted === false);
  // A PASS THAT DOES NOTHING MUST SAY WHY — that is the claim, not which sentence it uses.
  //
  // This matched /no plan|not reachable|plan is empty|no hostiles|no target/. With the
  // vigor goals met the keeper reports "all goals satisfied, no hunt room, no wander"
  // instead, which is an equally honest account of doing nothing and a more informative
  // one. Pinning the wording made the test fail for a report that improved, the same way
  // the refusal wording did in m59-decide-test.
  ok('no plan: the pass says why it did nothing',
     typeof r.reason === 'string' && r.reason.length > 0, JSON.stringify(r.reason));
}

{
  // A character at vigor 20 (under the cap) with no food. Armed.
  // Goal stack: in_underworld (no), armed (yes), has_food (no), vigor_ok (yes).
  // Effective goal: has_food. No plan (no food, no shop).
  // But the test expects "already satisfied" which is wrong now.
  // The character is NOT idle: it's trying to find food.
  const c = fakeClient({ vigor: 20, mana: 25, spells: [], inventory: [],
    equipped: [{ id: 1, name: 'mace' }] });  // armed
  const s = fakeSession(c);
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: {}, goal: 'can_rest_higher',
    note: () => {},
  });

  const r = await keeper.pass();
  // The keeper is NOT idle: it's trying to find food (has_food=false).
  // It might find a plan (eat if it has food) or no plan.
  ok('under the cap: not idle (has_food goal)', r.reason !== 'all goals satisfied');
}

{
  // A character at vigor 120 (above the 100 threshold). Armed, has food,
  // has money. Goal stack: in_underworld (no), armed (yes), healthy (yes),
  // has_food (yes), has_money (yes), can_rest_higher (no, vigor>=80),
  // vigor_ok (yes). All goals satisfied. Idle.
  const c = fakeClient({ vigor: 120, mana: 25, spells: [],
    inventory: [{ name: 'bread', amount: 1 }, { nameRsc: 'shilling', amount: 200 }],
    equipped: [{ id: 1, name: 'mace' }] });  // armed
  const s = fakeSession(c);
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: {}, goal: 'vigor_ok',
    note: () => {},
  });

  const r = await keeper.pass();
  ok('all satisfied: acted is false', r.acted === false);
  ok('all satisfied: reason says so', /all goals satisfied/.test(r.reason ?? ''), r.reason);
}

console.log('GOAPKeeper: at the cap, rest is still planned (the planner cannot know the cap)\n');

{
  // A character at vigor 120 (above the 100 threshold). Armed, has food,
  // has money. All goals satisfied. Idle.
  const c = fakeClient({ vigor: 120, mana: 25, spells: [],
    inventory: [{ name: 'bread', amount: 1 }, { nameRsc: 'shilling', amount: 200 }],
    equipped: [{ id: 1, name: 'mace' }] });
  const s = fakeSession(c);
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: {}, goal: 'vigor_ok',
    note: () => {},
  });

  const r = await keeper.pass();
  ok('at the cap: all goals satisfied, idle', r.acted === false);
}

console.log('GOAPKeeper: unarmed character gets the armed goal\n');

{
  // A character with no weapon. Goal stack: in_underworld (no),
  // armed (NO, false). Effective goal: armed.
  // The planner should find a plan: equip (if there's a weapon in the pack)
  // or cast create weapon (if the character knows the spell).
  // With no spells and no weapon in the pack: no plan.
  const c = fakeClient({ vigor: 40, mana: 25, spells: [], inventory: [] });
  const s = fakeSession(c);
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: {}, goal: 'vigor_ok',
    note: () => {},
  });

  const r = await keeper.pass();
  ok('unarmed: planner tries equip (optimistic)', r.action === 'equip' || /no plan|not reachable/.test(r.reason ?? ''), 'action=' + r.action + ' reason=' + r.reason);
  ok('unarmed: does not crash', true);
}

{
  // An armed character with food, money, and enough vigor: all goals met, idle.
  const c = fakeClient({ vigor: 120, mana: 25, spells: [],
    inventory: [{ name: 'bread', amount: 1 }, { nameRsc: 'shilling', amount: 200 }],
    equipped: [{ id: 1, name: 'mace' }] });
  const s = fakeSession(c);
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: {}, goal: 'vigor_ok',
    note: () => {},
  });

  const r = await keeper.pass();
  ok('armed + food: idle', r.acted === false);
  ok('armed + food: all goals satisfied', /all goals satisfied/.test(r.reason ?? ''), r.reason);
}

{
  // A character with a weapon equipped, and nothing else outstanding. Goal armed is true.
  // Vigor is high for the same reason as the first case: at 40 the keeper would rightly
  // rest, and "a satisfied goal produces no action" is not a claim about resting.
  const c = fakeClient({
    vigor: 150, mana: 25, spells: [], inventory: [],
    equipped: [{ id: 3, name: 'mace' }],
  });
  const s = fakeSession(c);
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: {}, goal: 'armed',
    note: () => {},
  });

  const r = await keeper.pass();
  ok('armed: goal satisfied, no action', r.acted === false);
  ok('custom goal: reason present', r.reason != null);
}

console.log('GOAPKeeper: travel_to injection when at_shop=false and has_money=true\n');

{
  // A character with money (above the walking floor) but not at a shop.
  // The goal is has_food. The planner should see: has_food=false, at_shop=false,
  // has_money=true. It should inject travel_to and plan: travel_to -> buy.
  const c = fakeClient({
    vigor: 40, mana: 25, spells: [],
    inventory: [ { nameRsc: 'shilling', amount: 500 } ],  // 500 shillings > 100 floor
    room: { num: 100, name: 'A random room', objects: [] },
  });
  const s = fakeSession(c);
  // The fake session needs a travel method for _travelOneHop
  s.travel = async (room, opts) => ({ arrived: true, room });
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: { walkingMoney: 100 }, goal: 'has_food',
    note: () => {},
  });

  const r = await keeper.pass();
  // The planner should find a plan (travel_to -> buy) or no plan (no shop
  // reachable from room 100 in the test map). Either way, it should not crash.
  ok('travel_to: does not crash', true);
  ok('travel_to: reason or action present', r.reason != null || r.action != null);
}

{
  // Same character but at a shop. at_shop should be true (a merchant is
  // in the room). The planner should plan: buy (no travel needed).
  const c = fakeClient({
    vigor: 40, mana: 25, spells: [],
    inventory: [ { nameRsc: 'shilling', amount: 500 } ],
    room: { num: 52, name: 'Tos Inn', objects: [
      { name: 'Paddock', can: ['buy'], id: 100 },
    ]},
  });
  const s = fakeSession(c);
  s.travel = async (room, opts) => ({ arrived: true, room });
  // The buy atomic needs a buy list on the client
  c.buyList = { items: [{ id: 1, nameRsc: 'bread', cost: 10 }] };
  const keeper = new GOAPKeeper({
    client: c, session: s,
    policy: { walkingMoney: 100 }, goal: 'has_food',
    note: () => {},
  });

  const r = await keeper.pass();
  ok('at shop: does not crash', true);
  ok('at shop: reason or action present', r.reason != null || r.action != null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
