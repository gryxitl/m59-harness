#!/usr/bin/env node
// THE DECIDE HALF — offline contract test for m59-decide.mjs.
//
//   node tools/m59-decide-test.mjs
//
// The decider is the middle of a tick and the whole model rests on it being
// SYNCHRONOUS. Most of this file is that, plus the two failures that were watched live
// on this fleet and must not come back: a plan that cannot be made counting as nothing,
// and an action reporting success it did not have.
import { makeDecider, intend, INTENTS, DEFAULT_GOALS,
         REST_UNTIL_DEFAULT, REST_LATCH_MAX_MS,
         VIGOR_REST_BELOW, VIGOR_REST_CEILING,
         creatureLevelOf, levelInBand } from './m59-decide.mjs';
import { readFileSync } from 'node:fs';
import { SYMBOLS } from './m59-worldstate.mjs';
import { Actuator, TickLoop } from './m59-tick.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function world({ hp = 20, maxHp = 20, vigor = 80, pack = [], equipped = [],
                 objects = new Map(), spells = [] } = {}) {
  const me = { col: 5, row: 5, x: 352, y: 352, predicted: false };
  const sent = [];
  const client = {
    state: 'game', selfId: 1, evSeq: 0, me: { name: 'Tester' },
    room: { id: 7, num: 7, objects: new Map([[1, me], ...objects]) },
    self: me, spells,
    vitals: () => ({ health: { value: hp, max: maxHp }, vigor: { value: vigor } }),
    inventory: pack,
    equipment: () => ({ known: true, equipped }),
    rsc: { get: () => null },
    moveToSquare: () => {}, face: () => {}, go: () => {}, attack: (id) => sent.push(['attack', id]),
    use: (id) => sent.push(['use', id]), unuse: () => {}, get: () => {}, drop: () => {},
    apply: (id) => sent.push(['apply', id]), cast: (id) => sent.push(['cast', id]),
    buy: () => {}, offer: () => {}, acceptOffer: () => {},
    rest: () => sent.push(['rest']), stand: () => sent.push(['stand']),
    requestInventory: () => {}, roomContents: () => {},
  };
  const session = { name: 't1', live: true, client, sent,
    pacer: { depth: 0, submit: (k, fn) => Promise.resolve().then(fn) } };
  return { session, client, sent, me };
}

console.log('the decider is synchronous — the whole model depends on it');
{
  const { session } = world();
  const decide = makeDecider({ session, goals: DEFAULT_GOALS });
  const act = new Actuator(session);
  const out = decide({ in_game: true, objects: session.client.room.objects }, act, null);
  ok('decide() returns nothing awaitable', out === undefined || typeof out?.then !== 'function',
     'a promise here is the blocking loop coming back in disguise');
}

console.log('\nit turns a plan into exactly one command');
{
  const { session, sent } = world({ pack: [{ id: 9, name: 'mace' }] });
  const decide = makeDecider({ session, goals: [{ goal: 'armed', when: ws => ws.armed === false }] });
  const act = new Actuator(session);
  decide({ in_game: true, objects: session.client.room.objects }, act, null);
  await sleep(5);
  ok('unarmed with a mace in the pack sends one use', sent.filter(x => x[0] === 'use').length === 1);
  ok('and it is the mace', sent.find(x => x[0] === 'use')?.[1] === 9);
  ok('and nothing else went out', sent.length === 1,
     'one planned action is one command; two would be a loop with the awaits removed');
}

console.log('\nAN UNPLANNABLE GOAL COUNTS AS A FAILURE');
{
  // Watched live: JayB, goal has_food, "exhausted 13 nodes without finding a plan",
  // every pass, standing still. The old keeper returned before its failure counter on
  // exactly this path, so the clearest possible evidence that a goal is unreachable was
  // the only outcome that could never retire it.
  const { session } = world({ pack: [] });          // nothing to eat, nothing to cast with
  const seen = [];
  const decide = makeDecider({ session, skipAfter: 3, skipForMs: 10_000,
    goals: [{ goal: 'has_food', when: () => true }],
    onDecision: d => seen.push(d) });
  const act = new Actuator(session);
  const frame = { in_game: true, objects: session.client.room.objects };
  for (let i = 0; i < 3; i++) decide(frame, act, null);
  ok('a goal with no plan is reported, not silently retried',
     seen.length === 3 && seen.every(d => d.action === null));
  ok('and after enough failures it is skipped',
     Object.keys(decide.state().skipped).includes('has_food'));
  const before = seen.length;
  decide(frame, act, null);
  ok('so the next tick moves on rather than re-select the same dead goal',
     seen[before]?.goal !== 'has_food' || seen[before]?.why === 'nothing to do');
}

console.log('\nan action that could not be bound reports a refusal, not a success');
{
  const { session, sent } = world({ pack: [] });    // unarmed AND nothing to equip
  const seen = [];
  const decide = makeDecider({ session, onDecision: d => seen.push(d),
    goals: [{ goal: 'armed', when: ws => ws.armed === false }] });
  decide({ in_game: true, objects: session.client.room.objects }, new Actuator(session), null);
  ok('nothing was sent', sent.length === 0);
  const d = seen[seen.length - 1];
  // THE POINT IS THAT IT SAYS SOMETHING, NOT WHICH SENTENCE IT SAYS.
  //
  // This pinned /no weapon/, which was the refusal when `armed` planned to equip from the
  // pack. It now plans to BUY one when the pack is empty, so the truthful refusal for this
  // character is "no merchant in room" — a different sentence and an equally honest one.
  // Asserting the wording made the test fail for a plan that improved.
  //
  // What must not regress is the rule this file is named for: a refusal reports sent:false
  // AND gives a reason. Silence, or sent:true with nothing behind it, is the failure.
  ok('and it said why', d && d.sent === false && typeof d.why === 'string' && d.why.length > 0,
     `no error has never meant success here — got ${JSON.stringify(d)}`);
}

console.log('\nthe target comes from the world state, never a second search');
{
  const foe = { id: 42, col: 6, row: 5, flags: 0 };
  const { session } = world({ objects: new Map([[42, foe]]) });
  const r1 = intend('attack', { objects: session.client.room.objects }, new Actuator(session),
                    { client: session.client, session, ws: { _targetId: 42 } });
  ok('with a target in the ws it swings at that id', r1.sent === true && /42/.test(r1.what));
  const r2 = intend('attack', { objects: session.client.room.objects }, new Actuator(session),
                    { client: session.client, session, ws: {} });
  ok('with none it refuses rather than picking one', r2.sent === false,
     'choosing here would let the ceiling be checked against one creature and the swing land on another');
  const r3 = intend('attack', { objects: new Map() }, new Actuator(session),
                    { client: session.client, session, ws: { _targetId: 42 } });
  ok('a target that has left the room is a refusal too', r3.sent === false && /left the room/.test(r3.why));
}

console.log('\nan action with no intent is refused BY NAME');
{
  const { session } = world();
  const r = intend('teleport', {}, new Actuator(session), { client: session.client, session, ws: {} });
  ok('refused', r.sent === false);
  ok('and names the action, so a new atomic cannot go quietly unexecuted',
     /teleport/.test(r.why), r.why);
  ok('every intent that exists is a function', Object.values(INTENTS).every(v => typeof v === 'function'));
}

console.log('\nend to end: a real TickLoop driving a real decider');
{
  const { session, sent } = world({ pack: [{ id: 9, name: 'mace' }] });
  const loop = new TickLoop({ session, hz: 50,
    decide: makeDecider({ session, goals: [{ goal: 'armed', when: ws => ws.armed === false }] }) });
  loop.start();
  await sleep(150);
  loop.stop();
  ok('it ticked repeatedly', loop.stats.ticks > 3, `${loop.stats.ticks}`);
  ok('never awaited a decide', loop.stats.awaited === 0);
  ok('never errored', loop.stats.errors === 0, loop.stats.lastError ?? '');
  ok('and kept sending while commands were in flight', sent.length >= loop.stats.ticks - 1);
}

console.log('\na flee commits to ONE way out, or it reaches none of them');
{
  // PICKING THE NEAREST EXIT EVERY TICK IS HOW YOU PICK NEITHER. nearestExit is measured
  // from where the body is standing, so every step toward one door makes another the nearer
  // one, and the choice flips on alternate ticks:
  //
  //     flee_danger -> travel (flee to room 563 via north)
  //     flee_danger -> travel (flee to room 554 via west)
  //     flee_danger -> travel (flee to room 563 via north)
  //
  // JayB died at the end of exactly that, in East Merchant Way, hp trail
  // [16,13,9,7,4,5,1,2] -- fifteen points taken while standing between two doors. The
  // goal-level flee commitment held `flee_danger` firmly and did nothing about it, because
  // the goal was never what flickered.
  const { session, client } = world({ hp: 6, maxHp: 20 });
  session._hpTrail = [16, 13, 9, 7, 4];        // falling: under_attack is true
  // Two exits, on opposite sides, so "nearest" flips as the body drifts between them.
  session.world = { exits: () => [
    { to: 563, direction: 'north', kind: 'edge', stand_on: { col: 5, row: 1 } },
    { to: 554, direction: 'west',  kind: 'edge', stand_on: { col: 1, row: 5 } },
  ] };
  const dests = [];
  session._router = { dest: null, to(n) { this.dest = n; dests.push(n); },
                      tick: () => ({ state: 'moving' }) };
  const decide = makeDecider({ session, goals: DEFAULT_GOALS });
  const act = new Actuator(session);
  for (let i = 0; i < 12; i++) {
    // The body drifts a little each tick, which is what re-measuring "nearest" reacts to.
    client.self.col = 5 - (i % 2);
    client.self.row = 5 - ((i + 1) % 2);
    decide({ in_game: true, position: client.self, objects: client.room.objects }, act, null);
  }
  const distinct = new Set(dests);
  ok('the flee settles on a single destination', distinct.size <= 1,
     `destinations chosen: ${JSON.stringify(dests)}`);
}

console.log('\nbelow the flee line: finish a fight, never start one');
{
  const { DEFAULT_GOALS: G } = await import('./m59-decide.mjs');
  const fight = G.find(g => g.goal === '_fight');
  const base = { has_target: true, target_in_band: true, critical: false,
                 hurt: true, vigor_floor: true, _targetElevated: false };
  // JayB engaged a giant rat at 7 of 20 -- below the flee line (fleeBelow 0.5) but above
  // critical (0.3). flee_hurt needs the target IN REACH and the rat was not adjacent yet,
  // so nothing fled and _fight won: he walked TOWARD it. hp trail [7,8,6,7,6,5,2,3].
  // The gate is now `fit_to_engage` rather than `below_flee` — a strictly higher bar, for
  // the reason in m59-worldstate.mjs: this fleet's fleeBelow is 0.4, so below_flee would
  // only have stopped him at 8 of 20, one exchange from death.
  ok('below the ENGAGE bar he does NOT close on a distant target',
     fight.when({ ...base, fit_to_engage: false, in_reach: false }) === false);
  ok('but he still swings at what is already on us',
     fight.when({ ...base, fit_to_engage: false, in_reach: true }) === true);
  ok('and a healthy character closes normally',
     fight.when({ ...base, fit_to_engage: true, in_reach: false }) === true);
  ok('critical still refuses outright, in reach or not',
     fight.when({ ...base, critical: true, fit_to_engage: true, in_reach: true }) === false);
}

console.log('\na cast holds the character still, because the tick loop is what breaks it');
{
  // A cast needs concentration and the tick driver sends move/turn at 10Hz, so a cast that
  // does not hold the body is a cast that never completes. The keeper's /action path and
  // the decider's `unstuck` blink both freeze the loop; `unwedge` goes through castIntent,
  // which did not. Lee sat entombed at (28,35) in the Deep Forest of Farol at full mana,
  // casting blink on a loop and never moving: correctly diagnosed, correctly prescribed,
  // and the cure cancelled by the caller a tenth of a second later.
  const { session, client, sent } = world();
  client.spells = [{ id: 42, name: 'blink' }];
  let frozenFor = 0, thawed = 0;
  session._tickLoop = {
    freeze(ms) { frozenFor = ms; return () => {}; },
    thaw() { thawed++; },
  };
  client.waitFor = () => Promise.resolve({ events: [], timedOut: true });
  const act = new Actuator(session);
  const r = intend('cast blink', {}, act, { client, session, ws: {}, policy: {} });
  // The rig's pacer defers to a microtask, exactly as the real one does — that deferral is
  // what makes the actuator fire-and-forget, and it is pinned in m59-tick-test.
  await sleep(5);
  ok('the cast is sent', r.sent === true && sent.some(x => x[0] === 'cast'),
     JSON.stringify(sent));
  ok('and the loop is frozen for it', frozenFor > 5000, `frozenFor=${frozenFor}`);

  // A spell that cannot be found must not leave the character frozen.
  const b = world();
  b.client.spells = [];
  let bFrozen = 0;
  b.session._tickLoop = { freeze(ms) { bFrozen = ms; return () => {}; }, thaw() {} };
  const r2 = intend('cast blink', {}, new Actuator(b.session),
                    { client: b.client, session: b.session, ws: {}, policy: {} });
  ok('an unknown spell is refused without freezing anything',
     r2.sent === false && bFrozen === 0, `${JSON.stringify(r2)} frozen=${bFrozen}`);
}

// RESTING NEEDS HYSTERESIS: ONE THRESHOLD CANNOT BE BOTH "SIT DOWN" AND "STAND UP".
//
// `healthy` fired on `hurt` (HP < restBelow), so the same number decided both. A character
// rested from 13 of 20 to exactly 14 and `hunt` -- which has no health gate -- took the
// next tick. Measured damage on 2026-08-27 was 5 to 15 points between consecutive samples,
// so 14 of 20 is about one sample of margin; three characters died in the King's Way
// inside 66 seconds.
{
  const healthy = DEFAULT_GOALS.find(g => g.goal === 'healthy');
  ok('the healthy goal exists', !!healthy);

  // Entering is still `hurt`.
  ok('sits down when hurt',
     healthy.when({ hurt: true, has_target: false, under_attack: false }) === true);

  // Leaving is NOT `hurt` going false -- that is the bug.
  ok('STAYS down while still recovering, even once out of the hurt band',
     healthy.when({ hurt: false, _still_recovering: true,
                    has_target: false, under_attack: false }) === true);
  ok('and stands up once recovery is done',
     healthy.when({ hurt: false, _still_recovering: false,
                    has_target: false, under_attack: false }) === false);

  // The two things that must still break a rest, latch or no latch.
  ok('a target breaks the rest',
     healthy.when({ hurt: true, _still_recovering: true,
                    has_target: true, under_attack: false }) === false);
  ok('being attacked breaks the rest',
     healthy.when({ hurt: true, _still_recovering: true,
                    has_target: false, under_attack: true }) === false);

  // The latch arithmetic itself, as the loop runs it.
  const latch = (frac, was, since, now, until = REST_UNTIL_DEFAULT, restBelow = 0.7) => {
    if (frac == null) return false;
    if (!was) return frac < restBelow;
    return !(frac >= until || now - since > REST_LATCH_MAX_MS);
  };
  ok('closes below restBelow', latch(13 / 20, false, 0, 0) === true);
  ok('does not close at 15 of 20', latch(15 / 20, false, 0, 0) === false);
  ok('stays closed at 15 of 20 once resting', latch(15 / 20, true, 0, 0) === true);
  ok('opens at 19 of 20', latch(19 / 20, true, 0, 0) === false);
  ok('opens on the deadline even if the bar never fills',
     latch(15 / 20, true, 0, REST_LATCH_MAX_MS + 1) === false);
  ok('an unreadable bar never pins a character', latch(null, true, 0, 0) === false);
}

// SELLING WHEN THERE IS NOTHING ELSE TO DO.
//
// Both original triggers were about SHEDDING — too many weapons, or no room left — so a
// character carrying a few sellable stacks with slots to spare never sold anything. 118
// kills on 2026-08-27 produced one purse of 77 shillings across five characters, and with
// walkingMoney at 400 that is the same as none: no food, no reagents, no replacement
// weapon after a death.
{
  const sell = DEFAULT_GOALS.find(g => g.goal === 'sell_loot');
  ok('the sell_loot goal exists', !!sell);

  // The two original triggers still work.
  ok('surplus weapons still trigger a trip', sell.when({ over_weapons: true }) === true);
  ok('a full pack with loot still triggers one',
     sell.when({ has_loot: true, pack_room: false }) === true);

  // The new one: idle with loot.
  ok('loot and no target triggers a trip',
     sell.when({ has_loot: true, pack_room: true, has_target: false,
                 under_attack: false }) === true);

  // The things that must still stop it.
  ok('a target in front of us does not',
     sell.when({ has_loot: true, pack_room: true, has_target: true,
                 under_attack: false }) === false);
  ok('being under attack does not',
     sell.when({ has_loot: true, pack_room: true, has_target: false,
                 under_attack: true }) === false);
  ok('and an empty pack never does',
     sell.when({ has_loot: false, pack_room: true, has_target: false,
                 under_attack: false }) === false);

  // It self-terminates: once the loot is gone the goal stops matching, so `hunt` (which
  // sits immediately below it) takes the next tick rather than a town/hunt oscillation.
  const after = { has_loot: false, pack_room: true, has_target: false, under_attack: false };
  ok('selling ends the trip rather than repeating it', sell.when(after) === false);
  const hunt = DEFAULT_GOALS.find(g => g.goal === 'hunt');
  ok('and hunt picks up immediately afterwards',
     hunt.when({ ...after, has_target: false }) === true);
}

// THE PLANNER'S `travel_to` HAD NO EXECUTOR.
//
// `travel_to` produces `at_shop`, the precondition of both `buy` and `sell`. The tick
// decider had no intent of that name, so a correct plan died on its first step:
//     [tick] t4 armed -> travel_to — no intent for "travel_to"
// Lee, 2026-08-27: no weapon, 77 shillings, the right plan found and dropped every tick.
{
  ok('travel_to is a registered intent', typeof INTENTS.travel_to === 'function');
  ok('without a router it refuses rather than throwing',
     INTENTS.travel_to({}, {}, { session: {} }).sent === false);

  // It sets the destination on the first call, then steers on later ones.
  const router = { dest: null, to(d) { this.dest = d; } };
  const first = INTENTS.travel_to({}, {}, { session: { _router: router } });
  ok('the first call sets the merchant room as the destination',
     first.sent === true && router.dest === 374, `dest=${router.dest}`);

  // It must not re-issue `to()` once already heading there, or the router would drop
  // its leg on every tick — the oscillation this codebase has been bitten by twice.
  let calls = 0;
  const steady = { dest: 374, to() { calls++; },
                   tick: () => ({ state: 'moving', why: 'steering' }) };
  const again = INTENTS.travel_to({}, {}, { session: { _router: steady } });
  ok('and does not re-target once already on the way', calls === 0);
  ok('it steers instead', again.sent !== undefined);
}

// THE MERCHANT DEPENDS ON THE GOODS, AND SENDING THE WRONG ONES IS SILENT.
//
// `SELL_ROOM` was one hardcoded room for everything, and it is a BLACKSMITH:
// JasperBlacksmith buys weapon and wearable (jssmith.kod:93) and nothing else. This
// fleet's loot is reagents and gems, so the trip ran, the sale executed, and the log read
// `[sell] t1: sold 0 item(s) to Quintor` over and over — the documented trap, in which a
// smith offered a mushroom returns a silence rather than an error. Gountrug walked to
// Jasper with eight elderberry, eight mushrooms, four herbs, six red mushrooms and two
// sapphires and sold none of it. 2026-08-27.
{
  const mk = (names) => ({ inventory: names.map(n => ({ name: n })) });
  const dest = (names) => {
    const router = { dest: null, to(d) { this.dest = d; }, tick: () => ({ state: 'moving' }) };
    INTENTS.travel_to({}, {}, { session: { _router: router }, client: mk(names) });
    return router.dest;
  };

  ok('reagents go to the grocer, not the smith',
     dest(['elderberry', 'mushroom', 'herb']) === 151, String(dest(['elderberry'])));
  ok('a gem goes there too', dest(['sapphire']) === 151);
  ok('a spare weapon still goes to the smith', dest(['mace', 'mace']) === 374);
  ok('armour goes to the smith as well', dest(['leather armor']) === 374);
  ok('a mixed pack prefers the smith, because only he buys the gear half',
     dest(['mace', 'elderberry']) === 374);
  ok('an empty pack falls back to the smith', dest([]) === 374);
}

// THE REST HANDLER'S GUARD MUST MATCH THE GOAL'S OWN CONDITION.
//
// `healthy` latches from `hurt` (< 0.7) up to `restUntil` (0.95). The handler that
// actually sends the rest still asked only about `hurt`, so in the 70-95% band the goal
// was active and no handler ran — and the fall-through plans for the SYMBOL `healthy`,
// which is `HP >= 0.7` and already true there. `[tick] t5 healthy — no plan`, a goal
// failure counted against a goal that had nothing left to do. Sasquatch, 2026-08-27.
{
  const src = readFileSync(new URL('./m59-decide.mjs', import.meta.url), 'utf8');
  const guard = /active\?\.goal === 'healthy' && \(ws\.hurt === true \|\| ws\._still_recovering === true\)/;
  ok('the rest handler fires for the whole latched band', guard.test(src));

  // And the two really do disagree in that band, which is why the guard matters.
  const healthySym = SYMBOLS.healthy.produce;
  const hurtSym = SYMBOLS.hurt.produce;
  const at = (v) => ({ client: { vitals: () => ({ health: { value: v, max: 20 } }) },
                       policy: { restBelow: 0.7 } });
  ok('at 17 of 20 the character is NOT hurt', hurtSym(at(17)) === false);
  ok('...and the healthy SYMBOL is already satisfied', healthySym(at(17)) === true);
  ok('...so planning for it would find nothing — hence the guard, not the planner',
     hurtSym(at(17)) === false && healthySym(at(17)) === true);

  // The goal itself is still active there, which is the whole point of the latch.
  const healthyGoal = DEFAULT_GOALS.find(g => g.goal === 'healthy');
  ok('the goal is still active at 17 of 20 while recovering',
     healthyGoal.when({ hurt: false, _still_recovering: true,
                        has_target: false, under_attack: false }) === true);
}

// VIGOR NEEDS THE SAME HYSTERESIS AS HEALTH, AND HAS ITS OWN CEILING.
//
// `vigor_low` fired below 60 and stopped matching AT 60, so a character rested to exactly
// the trigger and set out with 60 of 200 — which activity eats straight back down (Lee
// measured at 80 -> 78 -> 76 -> 74 over four minutes of walking, 2026-08-27). Sasquatch was
// sitting at 61: one point above the threshold that would have made him rest, at 30% of
// his bar.
//
// The ceiling is 80, not the top of the bar, because resting stops paying there —
// post-death samples read 20/200, climb to 80/200, and stop dead. Everything above 80 is
// eaten, which is why the characters carrying reagents were the ones at 133, 160 and 186.
{
  const g = DEFAULT_GOALS.find(x => x.goal === 'vigor_low');
  ok('the vigor_low goal exists', !!g);
  ok('the ceiling is the rest cap, not the top of the bar',
     VIGOR_REST_CEILING === 80 && VIGOR_REST_BELOW === 60);

  // Entering is still the trigger.
  ok('below the trigger it rests', g.when({ _vigor: 45, in_reach: false }) === true);
  ok('above the trigger, unlatched, it does not',
     g.when({ _vigor: 61, _vigor_recovering: false, in_reach: false }) === false);

  // Leaving is the ceiling, not the trigger — the whole point.
  ok('once resting it KEEPS resting past the trigger',
     g.when({ _vigor: 70, _vigor_recovering: true, in_reach: false }) === true);
  ok('and stops at the rest ceiling',
     g.when({ _vigor: 80, _vigor_recovering: false, in_reach: false }) === false);

  // A fight still wins, latch or no latch.
  ok('something in reach breaks the rest',
     g.when({ _vigor: 45, _vigor_recovering: true, in_reach: true }) === false);
  ok('an unreadable vigor never pins anybody',
     g.when({ _vigor: null, _vigor_recovering: true, in_reach: false }) === false);

  // The latch arithmetic as the loop runs it.
  const step = (v, was) => was ? !(v >= VIGOR_REST_CEILING) : v < VIGOR_REST_BELOW;
  ok('61 does not close the latch', step(61, false) === false);
  ok('59 does', step(59, false) === true);
  ok('and it stays closed at 79', step(79, true) === true);
  ok('opening exactly at the ceiling', step(80, true) === false);
}

// THE ENGAGEMENT CEILING WAS SWITCHED OFF BY A DEBUG LINE.
//
//     ws.target_in_band = true;  // DEBUG: force in-band to test
//
// That ran for any target ALREADY IN THE ROOM, which is the common path — once a target is
// selected and stays put, every later tick came through it. So the ceiling applied to
// almost nothing and `_fight` engaged anything at any level. The other half: the level was
// resolved from `max_health`, and the compendium lookup that was meant to find the real one
// set `targetLevel = null` with a comment saying it would be "set below" and never set it —
// and an unknown level defaults to in-band.
//
// Sasquatch, level 20, ceiling 30, spent 2026-08-27 trading blows with level-50 fungus
// beasts and died thirteen times — six times more than the same-build JayB.
{
  const o = (n) => ({ name: n });

  ok('a fungus beast is level 50, by name', creatureLevelOf({}, o('fungus beast')) === 50);
  ok('a giant rat is 30', creatureLevelOf({}, o('giant rat')) === 30);
  ok('a mummy is 25', creatureLevelOf({}, o('mummy')) === 25);

  // The case that mattered.
  ok('at ceiling 30 a fungus beast is OUT of band',
     levelInBand(creatureLevelOf({}, o('fungus beast')), 30) === false);
  ok('...while a giant rat is in', levelInBand(creatureLevelOf({}, o('giant rat')), 30) === true);
  ok('...and a centipede is in', levelInBand(creatureLevelOf({}, o('centipede')), 30) === true);

  // And it opens up as he grows: ceiling = level + floor(level/2) armed, so 34 -> 51.
  ok('a fungus beast comes into band once the ceiling clears 50',
     levelInBand(creatureLevelOf({}, o('fungus beast')), 51) === true);
  ok('but not at 49', levelInBand(creatureLevelOf({}, o('fungus beast')), 49) === false);

  // An unknown creature still answers in-band, deliberately — refusing everything unnamed
  // would stop a character fighting in a room it was deliberately sent to.
  ok('an unknown creature is still in-band', levelInBand(creatureLevelOf({}, o('wibble')), 30) === true);
  ok('and an unknown ceiling never blocks', levelInBand(50, null) === true);

  // The health proxy remains the fallback for things the table does not name.
  ok('an unnamed object falls back to its health',
     creatureLevelOf({}, { max_health: 42 }) === 42);

  // The debug line must not come back. Checked as an ASSIGNMENT, not as text, because the
  // note explaining the fix quotes the line it removed.
  const src = readFileSync(new URL('./m59-decide.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok('no unconditional force-in-band assignment remains',
     !/^\s*ws\.target_in_band\s*=\s*true\s*;/m.test(code));
}

// NOBODY SITS DOWN IN THE MIDDLE OF AN ESCAPE.
//
// `in_reach`, `has_target` and `under_attack` all go false a couple of squares into a flee
// — which is exactly when the flee is least finished. Before the rest latches this rarely
// mattered, because the vital climbed past its trigger and the goal stopped matching. The
// latches hold the goal on all the way to the ceiling, so they started winning the tick
// mid-flight.
//
// Sasquatch, 2026-08-27, room 583: `flee_danger -> travel (flee to room 593)` and then
// `vigor_low -> rest` two ticks later, sitting down in the open with a soldier of the
// Princess' army in the room. Seen from outside as "ran a couple of steps away from a rat
// and then stopped moving".
{
  const v = DEFAULT_GOALS.find(g => g.goal === 'vigor_low');
  const h = DEFAULT_GOALS.find(g => g.goal === 'healthy');
  const fleeing = (extra) => ({ in_reach: false, has_target: false, under_attack: false,
                                fleeing: true, ...extra });
  const settled = (extra) => ({ ...fleeing(extra), fleeing: false });

  ok('vigor_low does not rest mid-escape',
     v.when(fleeing({ _vigor: 45, _vigor_recovering: true })) === false);
  ok('healthy does not rest mid-escape',
     h.when(fleeing({ hurt: true, _still_recovering: true })) === false);

  ok('vigor_low rests once the flee is over',
     v.when(settled({ _vigor: 45, _vigor_recovering: true })) === true);
  ok('healthy rests once the flee is over',
     h.when(settled({ hurt: true, _still_recovering: true })) === true);

  // The escape itself still outranks both, so this is belt and braces rather than the
  // only thing keeping a fleeing character moving.
  const order = DEFAULT_GOALS.map(g => g.goal);
  ok('flee_danger is ranked above both rest goals',
     order.indexOf('flee_danger') < order.indexOf('healthy')
     && order.indexOf('flee_danger') < order.indexOf('vigor_low'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
