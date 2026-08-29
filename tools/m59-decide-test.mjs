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
import { chooseFleeExit } from './m59-decide.mjs';
import { evaluate } from './m59-worldstate.mjs';
import { isArmed } from './m59-skills.mjs';
import { planFor } from './m59-plan.mjs';
import { fakeClient } from './m59-fake-client.mjs';
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
  // ASSERT THE SWING, NOT THE SENTENCE. This used to regex the id out of `what`,
  // which broke the moment `attack` started running through the CombatController —
  // the swing still went to 42, the prose just stopped naming it. Same lesson as the
  // refusal-wording assertion above: pin the behaviour, and let the words move.
  const swings = [];
  const spied = session.client.attack?.bind(session.client);
  session.client.attack = (id) => { swings.push(id); return spied?.(id); };
  const r1 = intend('attack', { objects: session.client.room.objects }, new Actuator(session),
                    { client: session.client, session, ws: { _targetId: 42 } });
  ok('with a target in the ws it swings at that id',
     r1.sent === true && swings.includes(42),
     `sent=${r1.sent} swings=${JSON.stringify(swings)}`);
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

// YOU CANNOT WALK ONTO THE MERCHANT.
//
// The buy approach aimed at the merchant's OWN square and required getting within 1.5 of
// it. Something is standing on that square — the merchant — so it can never be reached,
// the distance never closed, and the goal re-issued the same approach every tick.
//
// Lee, 2026-08-27: at (14,11) with the merchant at (13,13), distance 2.24, for over ninety
// minutes and 2,130 identical sends, carrying 77 shillings with no weapon in his hand.
{
  const src = readFileSync(new URL('./m59-decide.mjs', import.meta.url), 'utf8');
  ok('the approach no longer aims at the merchant square',
     !/mv\.to\(target\.col, target\.row\)/.test(src));
  ok('it aims at a stand point beside him', /mv\.to\(stand\.col, stand\.row\)/.test(src));
  ok('and the gate matches what the server enforces, not 1.5',
     /distToNearest > BUY_REACH/.test(src) && /const BUY_REACH = 2\.5/.test(src));

  // The geometry of Lee's actual stall.
  const me = { col: 14, row: 11 }, merchant = { col: 13, row: 13 };
  const d = Math.hypot(merchant.col - me.col, merchant.row - me.row);
  ok('his real distance was outside the old gate', d > 1.5 && +d.toFixed(2) === 2.24);
  ok('...and inside the new one only after stepping beside the merchant', d > 2.5 === false);

  // Adjacent squares are what the approach should choose from, nearest first.
  const cands = [];
  for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
    if (!dc && !dr) continue;
    cands.push({ col: merchant.col + dc, row: merchant.row + dr });
  }
  cands.sort((a, b) => Math.hypot(a.col - me.col, a.row - me.row)
                     - Math.hypot(b.col - me.col, b.row - me.row));
  ok('the nearest adjacent square is one step away',
     cands[0].col === 14 && cands[0].row === 12);
  ok('and standing there puts him inside BUY_REACH of the merchant',
     Math.hypot(cands[0].col - merchant.col, cands[0].row - merchant.row) <= 2.5);
  ok('the merchant square itself is never a candidate',
     !cands.some(c => c.col === merchant.col && c.row === merchant.row));
}

// PHASE 1 OF THE GOAP REPAYMENT: AN UNACHIEVABLE GOAL DECLINES, AND SOMETHING ALWAYS
// ACCEPTS.
//
// The decider is a priority ladder with one planFor call site and nine hand-written
// goals. A handler has no precondition and no plan, so `hunt` re-issued a travel to a
// staging square the body could not reach — JayB, room 50 at (2,48), 231,626 ticks,
// 358,787 blocked steps, 938,856 side-steps, ARRIVED ZERO, over seven hours, with
// `stalled_count: 0` on the board. See docs/m59-goap-repayment.md.
{
  const pick = (ws) => (DEFAULT_GOALS.find(g => g.when(ws)) ?? { goal: null }).goal;
  const healthy = { has_target: false, under_attack: false, hurt: false,
                    _vigor: 150, has_food: true, vigor_ok: true };

  // The precondition itself.
  const rr = SYMBOLS.route_reachable.produce;
  const sess = (set, stand = { col: 3, row: 57 }) => ({ session: {
    _router: { leg: { standOn: stand }, _fineReachableSet: () => set },
    world: { geometry: {} }, client: { self: { col: 2, row: 48 } } } });
  ok('a reachable staging square answers true', rr(sess(new Set(['2,48', '3,57']))) === true);
  ok('an unreachable one answers false', rr(sess(new Set(['2,48', '2,47']))) === false);
  ok('an empty reachable set abstains rather than refusing',
     rr(sess(new Set())) === null);
  ok('and no leg at all abstains',
     SYMBOLS.route_reachable.produce({ session: { _router: {} } }) === null);
  ok('an unreadable answer must not strand anybody',
     SYMBOLS.route_reachable.whenUnknown === true);

  // WHERE THE REFUSAL LIVES. It was briefly on the `hunt` goal — decline while
  // `route_reachable` is false — and that DEADLOCKED: the handler that drops the stale leg
  // lives inside the goal, so gating the goal meant the leg was never dropped and the
  // character rested for ever (measured: idle_rest 3,096 ticks against hunt 2). Refusing
  // at source is what lets the router re-plan, so `hunt` stays ungated and the router
  // simply never hands out an impossible leg.
  ok('hunt is not gated on route_reachable — the router refuses instead',
     pick({ ...healthy, route_reachable: false }) === 'hunt');
  ok('...and hunts normally when it is reachable',
     pick({ ...healthy, route_reachable: true }) === 'hunt');

  const rsrc = readFileSync(new URL('./m59-route.mjs', import.meta.url), 'utf8');
  ok('the router refuses a staging square outside the reachable set',
     /staging square unreachable; re-routing/.test(rsrc));
  ok('...and marks the hop doorless so findPath routes around it',
     /staging square[\s\S]{0,400}_doorless \?\?= new Set\(\)/.test(rsrc)
     || /_doorless \?\?= new Set\(\)[\s\S]{0,400}staging square/.test(rsrc));
  ok('...only on a positive finding, never on an empty set',
     /fineSet && fineSet\.size && standOn && !fineSet\.has/.test(rsrc));

  // THE FLOOR. This is the property that makes declining safe.
  ok('the ladder ends in something that always accepts',
     DEFAULT_GOALS[DEFAULT_GOALS.length - 1].goal === 'idle_rest');
  ok('a character with nothing else to do rests', pick(healthy) !== null);
  ok('the floor still stands aside for a target',
     pick({ ...healthy, has_target: true, target_in_band: true }) === '_fight');
  ok('and for an attack', pick({ ...healthy, under_attack: true, has_target: true,
                                 in_reach: true, target_in_band: false }) === 'flee_danger');

  // Survival still outranks everything, which the plan says must not change.
  const order = DEFAULT_GOALS.map(g => g.goal);
  // `indexOf` is the FIRST occurrence, and both `flee_danger` and `idle_rest` now appear
  // twice: once where they are the right answer, and once in the total cover at the
  // bottom. What must hold is that the high occurrence outranks work and that the LAST
  // rung is the floor — which is what these say now.
  ok('survival still outranks work',
     order.indexOf('flee_danger') < order.indexOf('hunt')
     && order.indexOf('healthy') < order.indexOf('hunt')
     && order[order.length - 1] === 'idle_rest');

  // travel_to is now unplannable without the precondition.
  const src = readFileSync(new URL('./m59-act/travel-to.mjs', import.meta.url), 'utf8');
  ok('travelTo declares route_reachable as a precondition',
     /travelTo\.pre = \['route_reachable'\]/.test(src));
}

// PHASE 2: HUNTING IS PLANNED, NOT PROCEDURAL.
//
// `hunt` was a 111-line hand-written branch that chose a room, set the router and steered,
// with no precondition and no plan — which is why it could re-issue an impossible travel
// for ever. It is now two planner actions with real preconditions, and the goal name maps
// to the world state it actually wants. See docs/m59-goap-repayment.md.
{
  const src = readFileSync(new URL('./m59-decide.mjs', import.meta.url), 'utf8');
  ok('the hand-written hunt branch is gone',
     !/active\?\.goal === 'hunt' \|\| \(!active && ws\.has_target === false\)/.test(src));
  ok('the goal name maps to a world state', /hunt: \{ has_target: true \}/.test(src));
  ok('and the planner is asked for that state, not the goal name',
     /planFor\(client, goalState,/.test(src));

  ok('travel_to_hunt_room is an intent', typeof INTENTS.travel_to_hunt_room === 'function');
  ok('acquire_target is an intent', typeof INTENTS.acquire_target === 'function');

  // The travel intent steers and does not re-target once already heading there.
  let toCalls = 0;
  const router = { dest: null, to(d) { toCalls++; this.dest = d; },
                   tick: () => ({ state: 'moving' }) };
  const sess = (here) => ({ _router: router, _huntRoomWanted: 575,
                            world: { room: { num: here } } });
  const first = INTENTS.travel_to_hunt_room({}, {}, { session: sess(50), client: {} });
  ok('it sets the hunt room as the destination', first.sent === true && router.dest === 575);
  INTENTS.travel_to_hunt_room({}, {}, { session: sess(50), client: {} });
  ok('and does not re-target on the next tick', toCalls === 1);
  ok('it declines once already in the room',
     INTENTS.travel_to_hunt_room({}, {}, { session: sess(575), client: {} }).sent === false);

  // in_hunt_room reports against the chosen room and abstains when nothing is chosen.
  const ihr = SYMBOLS.in_hunt_room.produce;
  ok('in_hunt_room is true when we are there',
     ihr({ session: { _huntRoomWanted: 575, world: { room: { num: 575 } } }, client: {} }) === true);
  ok('...false when we are not',
     ihr({ session: { _huntRoomWanted: 575, world: { room: { num: 50 } } }, client: {} }) === false);
  ok('...and abstains when no room has been chosen',
     ihr({ session: { world: { room: { num: 50 } } }, client: {} }) === null);
  ok('an unreadable answer must not strand anybody',
     SYMBOLS.in_hunt_room.whenUnknown === true);
}

// NEVER PLAN A CAST YOU CANNOT PAY FOR.
//
// `groundedCasts` gives every spell `pre: ['has_mana']`, and `has_mana` is MIN_CAST_MANA =
// 10 — the price of `create food`, the only cost the wire carries. `create weapon` is
// viMana = 15 (creaweap.kod:41). Between 10 and 14 mana the planner planned a conjure the
// server refuses with a SENTENCE rather than an error, so nothing was spent, nothing was
// learned, and the next tick planned it again. The same shape already fixed for blink.
//
// It needs no reagents — `plReagents = $` — so mana is the whole of its price, unlike
// `create food`, which is correctly gated on `has_reagents`.
{
  const pay = SYMBOLS.can_pay_create_weapon.produce;
  const at = (m) => ({ client: { vitals: () => ({ mana: { value: m } }) } });
  ok('14 mana cannot pay for a 15-mana conjure', pay(at(14)) === false);
  ok('15 can', pay(at(15)) === true);
  ok('an unreadable bar abstains rather than blocking',
     pay({ client: { vitals: () => ({}) } }) === null);
  ok('...and abstaining must not strand an empty-handed character',
     SYMBOLS.can_pay_create_weapon.whenUnknown === true);

  const csrc = readFileSync(new URL('./m59-act/cast.mjs', import.meta.url), 'utf8');
  ok('the spell table carries the price as a precondition',
     /'create weapon': \{ pre: \['can_pay_create_weapon'\]/.test(csrc));
  ok('and create food is still gated on its reagents, which it does need',
     /'create food':  \{ pre: \['has_reagents'\]/.test(csrc));
}

// A SPELL YOU CANNOT AFFORD YET IS A REASON TO WAIT, NOT A REASON TO GIVE UP.
//
// Gating a cast on its real price (previous commit) stops a character asking for a spell
// the server will refuse. On its own that is only half an answer: a character holding
// `create weapon` at 11 of 25 mana would simply decline to arm, for ever, while the mana
// it needed arrived on its own.
//
// Mana is NOT restored by resting — `ManaTimer` (player.kod:2664) gains a point per tick
// whether the character rests, walks or fights. Resting is the SAFE way to let that clock
// run, and the only action that does nothing else, so in planning terms it is how a
// character waits. Declaring the mana preconditions as rest's effects is what lets A*
// chain "wait, then cast".
{
  const mk = (mana) => ({
    inventory: [], inventoryKnown: true,
    spells: [{ name: 'create weapon' }, { name: 'blink' }],
    equipment: () => ({ known: true, equipped: [] }),
    vitals: () => ({ health: { value: 20, max: 20 }, mana: { value: mana, max: 25 },
                     vigor: { value: 150 } }),
    room: { num: 50, objects: new Map() } });
  const plan = (mana, goal) => {
    const c = mk(mana);
    const ws = evaluate({ client: c, policy: {}, session: { world: { room: { num: 50 } } } });
    const p = planFor(c, goal, { session: { world: { room: { num: 50 } } }, policy: {}, ws });
    return p.found ? p.names : null;
  };

  ok('with the mana in hand it just casts',
     JSON.stringify(plan(25, { armed: true })) === JSON.stringify(['cast create weapon']));
  ok('short of the price it waits and then casts',
     JSON.stringify(plan(11, { armed: true })) === JSON.stringify(['rest', 'cast create weapon']));
  ok('and from nearly empty, the same plan',
     JSON.stringify(plan(2, { armed: true })) === JSON.stringify(['rest', 'cast create weapon']));

  const rsrc = readFileSync(new URL('./m59-act/rest.mjs', import.meta.url), 'utf8');
  ok('rest declares the mana preconditions it lets time satisfy',
     /can_pay_create_weapon/.test(rsrc) && /can_pay_blink/.test(rsrc));
  ok('...and still declares what it genuinely restores',
     /'healthy'/.test(rsrc) && /'vigor_rested'/.test(rsrc));
}

// A CASTER'S ZAP ENCHANTMENT IS A REAL WEAPON, AND NOTHING COULD SEE IT.
//
// `zap` is `persench/touchatk` — it does not buff a held weapon, it CREATES an enchantment
// that acts as one. A caster with zap up and blue mushrooms in the pack is armed and needs
// no weapon at all.
//
// `isArmed` read only the server's use list, so every zapped caster was called unarmed,
// with two consequences that both punish the build: the `armed` goal fires and sends them
// to conjure or buy a weapon they do not need, and the hunt band is HALVED —
// floor(level/4) against floor(level/2) — so a properly armed caster refuses prey it could
// beat. Three of this fleet's five characters are casters.
{
  const mk = (equipped, msgs) => ({
    equipment: () => ({ known: true, equipped }),
    eventsSince: () => msgs.map((t, i) => ({ kind: 'message', text: t, at: Date.now() - 100 + i })) });
  const ON  = 'Sparks jump and crackle around your hands!';
  const OFF = 'Your hands are no longer charged with electrical energy.';
  const ALREADY = 'Your hands already crackle with energy.';

  ok('a wielded weapon still counts', isArmed(mk([{ name: 'mace' }], [])) === true);
  ok('nothing wielded and no zap is unarmed', isArmed(mk([], [])) === false);
  ok('an ACTIVE zap enchantment counts as armed', isArmed(mk([], [ON])) === true);
  ok('...and stops counting once it lapses', isArmed(mk([], [ON, OFF])) === false);
  ok('a refusal because it is ALREADY up also means armed',
     isArmed(mk([], [ALREADY])) === true);

  // The two guards that must not change.
  ok('an unreadable use list still abstains to armed',
     isArmed({ equipment: () => ({ known: false }) }) === true);
  ok('a client with no event source falls through to the use list',
     isArmed({ equipment: () => ({ known: true, equipped: [] }) }) === false);
}


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nNO HEALTH AND DISTANCE COMBINATION LETS A HURT CHARACTER WALK AT A MOB');
{
  // THE GUARD FOR PHASE 3, AND THE ONE THAT SHOULD FAIL IF ANYBODY UNDOES IT.
  //
  // `_fight` used to hand the whole decision to the CombatController, which checked
  // health at the top of its `close` phase and backed off below 55%. That check is
  // gone — the ladder owns retreat now, which is right, because two retreat rules with
  // two thresholds meant the one that fired was whichever number was crossed first.
  //
  // But removing it made the ladder's coverage load-bearing, and the ladder had a hole:
  // `flee_hurt` required `in_reach`, so a character at 30% health with the mob one
  // square outside melee selected `_fight` — and `_fight` plans `approach_target`. It
  // would walk TOWARDS the thing that hurt it and only be allowed to flee once it
  // arrived and got hit again.
  //
  // This sweeps the whole space rather than sampling it, because the hole was not at a
  // threshold — it was in a corner two booleans wide.
  const engaged = (hp, { inReach, underAttack }) => ({
    has_target: true, target_in_band: true, in_reach: inReach,
    under_attack: underAttack, hurt: hp < 80,
    below_flee: hp <= 70, critical: hp <= 20,
    healthy: hp >= 95, armed: true, vigor_ok: true, has_food: true,
    fleeing: false, outnumbered: false, entombed: false,
    in_underworld: false, pocket_has_exit: true, can_leave: true,
  });
  const pick = (ws) => DEFAULT_GOALS.find(g => g.when?.(ws))?.goal ?? '(none)';
  const FLEES = new Set(['flee_hurt', 'flee_danger']);

  let holes = [];
  for (const hp of [70, 65, 55, 45, 35, 30, 25, 20, 15, 10, 5]) {
    for (const inReach of [true, false]) {
      for (const underAttack of [true, false]) {
        const g = pick(engaged(hp, { inReach, underAttack }));
        if (!FLEES.has(g)) holes.push({ hp, inReach, underAttack, goal: g });
      }
    }
  }
  ok('below the flee line, every combination runs — none of them fights or approaches',
     holes.length === 0, JSON.stringify(holes.slice(0, 6)));

  // The other half: this must not have been bought by making everyone flee always.
  // A healthy character with an in-band quarry still fights, in reach or not.
  let fights = 0;
  for (const inReach of [true, false])
    for (const underAttack of [true, false])
      if (pick(engaged(95, { inReach, underAttack })) === '_fight') fights++;
  ok('...and a healthy character still takes the fight', fights === 4);
}



// ─────────────────────────────────────────────────────────────────────────────
console.log('\n_fight IS PLANNED NOW: approach, then swing');
{
  // Phase 3 end to end, through the real decider rather than the planner alone.
  // `_fight` maps to the world state `!has_target` — the quarry stops existing — and
  // the two ways to get there are ordinary actions: `approach_target` achieves
  // `in_reach`, `attack` consumes it. What this pins is that the decision changes with
  // the distance, which is exactly what the hand-written phase machine used to decide.
  // A giant rat, not a baby spider: the selector refuses a quarry whose ATTACK ABILITY
  // (3*level + 60*difficulty) is over the danger cap, and a baby spider's 315 is over it
  // at this max health while a rat's 150 is not. See the table beside `dangerCap`.
  const foeAt = (col) => new Map([[42, { id: 42, col, row: 5, flags: 0, name: 'giant rat' }]]);
  const decisionFor = (col) => {
    const { session } = world({ hp: 20, maxHp: 20, vigor: 150,
                                equipped: [{ id: 1, name: 'mace' }], objects: foeAt(col) });
    let seen = null;
    const decide = makeDecider({ session, goals: DEFAULT_GOALS,
                                 onDecision: (d) => { seen = d; } });
    decide({ in_game: true, objects: session.client.room.objects,
             position: session.client.self, vitals: { health: { pct: 100 } } },
           new Actuator(session), null);
    return seen;
  };

  const near = decisionFor(6);          // adjacent
  ok('adjacent, the goal is the fight', near?.goal === '_fight',
     JSON.stringify(near));
  const far = decisionFor(15);          // across the room
  ok('across the room it is still the fight goal', far?.goal === '_fight',
     JSON.stringify(far));
  // The actions differ even though the goal does not — that IS the migration.
  ok('but the planned action is not the same at both distances',
     near?.action !== far?.action, `near=${near?.action} far=${far?.action}`);
  ok('...and from across the room it closes rather than swinging',
     far?.action === 'approach_target', JSON.stringify(far));
  ok('...while from beside it, it swings',
     near?.action === 'attack', JSON.stringify(near));
}


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTHERE IS ALWAYS SOMETHING TO DO — NO WORLD STATE SELECTS NO GOAL');
{
  // A stall does not need a bug in a handler. It only needs a combination of symbols
  // that every rung declines, and the commonest source of those is a symbol that is
  // NULL rather than true or false — "we could not tell". `_fight` asked for
  // `target_in_band === true` and `hunt` for `=== false`, so an unresolved creature
  // level matched neither; `idle_rest` excludes a character holding a target; and the
  // character had no goal at all. Watched live as Lee, 192 ticks of `none`.
  //
  // Sweeping the tri-state space is the only honest way to check this, because the hole
  // was not at a threshold — it was where two rungs both said "not my case".
  const TRI = [true, false, null];
  const pick = (ws) => DEFAULT_GOALS.find(g => g.when?.(ws))?.goal ?? null;

  const holes = [];
  for (const has_target of TRI)
    for (const target_in_band of TRI)
      for (const under_attack of TRI)
        for (const hurt of TRI)
          for (const armed of TRI) {
            const ws = { has_target, target_in_band, under_attack, hurt, armed,
              in_reach: false, below_flee: false, critical: false,
              vigor_ok: true, has_food: true, fleeing: false, outnumbered: false,
              entombed: false, in_underworld: false, pocket_has_exit: true,
              can_leave: true, can_arm: true };
            if (pick(ws) === null)
              holes.push({ has_target, target_in_band, under_attack, hurt, armed });
          }
  ok('every combination of the five combat symbols selects some goal',
     holes.length === 0, `${holes.length} with no goal, e.g. ${JSON.stringify(holes.slice(0, 4))}`);

  // AND THE INVARIANT IS STRUCTURAL, NOT A PROPERTY OF THE CONDITIONS ABOVE.
  //
  // The sweep above covers five symbols; the rungs read a dozen. Closing corners one at
  // a time is what kept producing them — each fix made one pair of rungs agree and left
  // the next pair to be found. The bottom rung takes no world state at all, so totality
  // cannot be broken by editing anything above it. If this assertion ever fails, the
  // ladder has stopped being a total cover and `none` will come back.
  const last = DEFAULT_GOALS[DEFAULT_GOALS.length - 1];
  ok('the last rung accepts unconditionally', last.when({}) === true && last.when() === true,
     JSON.stringify(last.goal));
  ok('...and it is a safe one to land on', last.goal === 'idle_rest', last.goal);

  // The empty world state is the one a keeper sees on its very first tick, before
  // anything has been read back. It must still produce a goal.
  ok('a completely unknown world still selects a goal', pick({}) !== null);

  // Randomised tri-state across every symbol any rung mentions — cheap insurance that
  // the two bottom rungs really are reached rather than shadowed by a throw.
  const NAMES = ['has_target','target_in_band','under_attack','hurt','armed','critical',
                 'in_reach','fit_to_engage','vigor_floor','below_flee','fleeing',
                 'outnumbered','entombed','in_underworld','pocket_has_exit','can_leave',
                 'can_arm','vigor_ok','has_food','has_reagents','in_raza','raza_outgrown',
                 'purse_heavy','over_weapons','has_loot','_still_recovering'];
  let random_holes = 0, threw = 0;
  for (let i = 0; i < 4000; i++) {
    const ws = {};
    for (const n of NAMES) ws[n] = TRI[Math.floor(Math.random() * 3)];
    try { if (pick(ws) === null) random_holes++; } catch { threw++; }
  }
  ok('4000 random tri-state worlds all select a goal', random_holes === 0, `${random_holes} holes`);
  ok('...and no rung throws on an unexpected shape', threw === 0, `${threw} threw`);
}


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTHE ENGAGEMENT CEILING SURVIVES THE SECOND TICK');
{
  // THIS BUG HAS NOW BEEN INTRODUCED TWICE, BOTH TIMES THE SAME WAY, AND THE SECOND
  // TIME IT WAS INTRODUCED BY THE FIX FOR THE FIRST.
  //
  // Target selection has two branches: choose a new quarry, or keep the one we have.
  // The choosing branch computed `_threatCeiling` and the three target symbols; the
  // keeping branch computed the symbols AGAIN, reading a `_threatCeiling` it never set.
  // `levelInBand(level, undefined)` is `true`, so the ceiling was applied on the tick a
  // quarry was chosen and ABSENT on every tick after it — which is nearly all of them.
  //
  // First time it was a literal `ws.target_in_band = true; // DEBUG: force in-band`.
  // Second time it was the careful-looking replacement for that line. A one-tick test
  // passes against both. So this one runs FOUR ticks, and the tick that matters is the
  // second — the first sticky one.
  const run = (name, ticks = 4) => {
    const foe = { id: 77, name, col: 6, row: 5, flags: 0 };
    const { session } = world({ hp: 20, maxHp: 20, vigor: 150,
      equipped: [{ id: 1, name: 'mace' }], objects: new Map([[77, foe]]) });
    const seen = [];
    const goals = [{ goal: '_probe', when: ws => {
      seen.push({ id: ws._targetId, level: ws._targetLevel,
                  ceiling: ws._threatCeiling, band: ws.target_in_band,
                  has: ws.has_target });
      return false; } }];
    const decide = makeDecider({ session, goals, policy: {} });
    for (let i = 0; i < ticks; i++)
      decide({ in_game: true, objects: session.client.room.objects,
               position: session.client.self, vitals: { health: { pct: 100 } } },
             new Actuator(session), null);
    return seen;
  };

  // A level-20 character, armed: ceiling = 20 + floor(20/2) = 30.
  const beast = run('fungus beast');          // level 50 — far above the ceiling
  ok('a quarry over the ceiling is refused on the FIRST tick',
     beast[0]?.band === false, JSON.stringify(beast[0]));
  ok('...and on the second, which is the one that regressed twice',
     beast[1]?.band === false, JSON.stringify(beast[1]));
  ok('...and stays refused', beast.every(s => s.band === false),
     JSON.stringify(beast.map(s => s.band)));
  ok('the ceiling is present on every tick, not just the first',
     beast.every(s => s.ceiling === 30), JSON.stringify(beast.map(s => s.ceiling)));
  ok('and the level is resolved on every tick',
     beast.every(s => s.level === 50), JSON.stringify(beast.map(s => s.level)));

  // The other half: this must not have been bought by refusing everything.
  const rat = run('giant rat');               // level 30 — exactly at the ceiling
  ok('a quarry AT the ceiling is still fightable, every tick',
     rat.every(s => s.band === true), JSON.stringify(rat.map(s => s.band)));

  // `has_target` is produced from `_targetId` now, so the two cannot disagree. That
  // disagreement is what made `approach_target` refuse 180 times while the goal said
  // there was a target -- the sticky branch set the symbol and not the id.
  ok('has_target and _targetId agree on every tick, on both branches',
     [...beast, ...rat].every(s => s.has === (s.id != null)),
     JSON.stringify([...beast, ...rat].map(s => ({ has: s.has, id: s.id }))));
}


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nA PORTAL WE ARE STILL WALKING TOWARDS IS NOT AN UNREACHABLE ONE');
{
  // The Underworld escape commits to one portal and rotates when that portal fails. It
  // used to rotate on ELAPSED TIME since it picked one, which abandons a portal the
  // character is approaching perfectly well, restarts the mover on another, and arrives
  // at none of them. Watched live: Lee cycling "portal 1/6 ... 2/6 ... 3/6 ... 4/6
  // unreachable after 30000ms" while /findpath returned real waypoint lists for three of
  // the four. Nothing was unreachable; the walk was slower than the clock.
  //
  // So the clock measures CLOSING, not time. Same correction the routing notes already
  // record for stall detection: asking for stillness misses the commonest way to stand
  // still, so ask the rate instead.
  const uw = (selfCol, selfRow) => {
    const objects = new Map([
      [1, { id: 1, col: 20, row: 20, nameRsc: 1 }],
      [2, { id: 2, col: 2,  row: 2,  nameRsc: 2 }],
    ]);
    const names = new Map([[1, 'portal'], [2, 'portal']]);
    const client = { state: 'game', selfId: 99, self: { col: selfCol, row: selfRow },
      room: { id: 10, num: 1, objects }, rsc: { get: r => names.get(r) ?? '?' },
      moveToSquare: () => {}, go: () => {} };
    const session = { name: 't-uw', live: true, client,
      pacer: { depth: 0, submit: (k, fn) => Promise.resolve().then(fn) },
      _mover: { to: () => {}, tick: () => ({ state: 'moving' }), cancel: () => {} } };
    return { client, session };
  };
  const act = { step: () => {}, walk: () => {}, face: () => {}, go: () => {} };
  const call = (session, client) =>
    intend('escape_underworld', { objects: client.room.objects, position: client.self },
           act, { client, session, ws: { in_underworld: true } });

  // (a) STILL CLOSING. The portal is far and the clock is long past the timeout, but the
  //     character has been getting nearer, so the commitment must hold.
  {
    const { client, session } = uw(10, 10);
    call(session, client);                       // commit to the nearest portal
    const first = session._uwPortal;
    session._uwSelectedAt = Date.now() - 120_000; // long past any elapsed-time timeout
    for (const [c0, r0] of [[9, 9], [8, 8], [7, 7], [6, 6]]) {
      client.self = { col: c0, row: r0 };         // closing on (2,2)
      call(session, client);
    }
    ok('a portal we are closing on is NOT abandoned, however long it takes',
       session._uwPortal === first,
       `started ${first}, now ${session._uwPortal}`);
  }

  // (b) NOT CLOSING. Same elapsed time, but the character has not moved — this is what
  //     an unreachable portal actually looks like, and it must still rotate.
  {
    const { client, session } = uw(10, 10);
    call(session, client);
    const first = session._uwPortal;
    session._uwProgressAt = Date.now() - 120_000;  // stopped closing long ago
    call(session, client);
    ok('...but one we have stopped closing on IS given up',
       session._uwPortal !== first,
       `started ${first}, now ${session._uwPortal}`);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTHE DANGER CAP SITS IN THE GAP BETWEEN WHAT WE SURVIVE AND WHAT KILLS US');
{
  // LEVEL IS NOT DANGER; ATTACK ABILITY IS (3*viLevel + 60*viDifficulty, monster.kod).
  // A level-30 centipede is exactly as dangerous as a level-50 spider, and a baby spider
  // is 2.1x a giant rat that OUTRANKS it. So a level band alone cannot keep this fleet
  // alive, and the cap is the layer that does.
  //
  // The table has a wide, empty gap in the middle, and the cap belongs in it:
  //
  //     150 rat | 195 mummy | 210 fungus beast | 315 baby spider ||  390 centipede/spider/living tree
  //                                                              ^^ nothing lives here
  //
  // 250 sat below the baby spider and starved the fleet in rooms holding both. Raising it
  // to 500 fixed that and re-admitted the whole 390 band with it — the exact group the
  // death ledger names as killers. Gountrug engaged a centipede and died.
  const rooms = JSON.parse(readFileSync(new URL('../substrate/m59-spawns.json', import.meta.url), 'utf8'))?.rooms ?? {};
  const aa = new Map();
  for (const list of Object.values(rooms))
    for (const e of list ?? []) {
      if (!e?.creature || e.level == null || e.difficulty == null) continue;
      aa.set(String(e.creature).toLowerCase(), 3 * e.level + 60 * e.difficulty);
    }
  const of = (n) => aa.get(n) ?? null;

  // The table itself, so a spawn-data change that moves a creature across the line is
  // caught here rather than in a postmortem.
  ok('the fleet\'s prey are all under 350',
     ['giant rat', 'mummy', 'baby spider'].every(n => of(n) != null && of(n) <= 350),
     JSON.stringify(['giant rat', 'mummy', 'baby spider'].map(n => n + '=' + of(n))));
  ok('and the three it dies to are all over it',
     ['centipede', 'spider', 'living tree'].every(n => of(n) != null && of(n) > 350),
     JSON.stringify(['centipede', 'spider', 'living tree'].map(n => n + '=' + of(n))));

  // The cap the decider actually uses, read off the module rather than restated.
  const capSrc = readFileSync(new URL('./m59-decide.mjs', import.meta.url), 'utf8');
  const cap = Number(capSrc.match(/DEFAULT_ATTACK_ABILITY_CAP = Number\(process\.env\.M59_MAX_ATTACK_ABILITY \|\| (\d+)\)/)?.[1]);
  ok('the default cap is a real number', Number.isFinite(cap), String(cap));
  ok('it admits the baby spider — the raise that introduced the bug wanted this',
     cap >= of('baby spider'), `cap=${cap} baby spider=${of('baby spider')}`);
  ok('and it refuses the centipede — which that raise gave away',
     cap < of('centipede'), `cap=${cap} centipede=${of('centipede')}`);
}


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nA FLEE DOES NOT GO BACK WHERE IT JUST CAME FROM');
{
  // The two-room bounce. Sasquatch's last ten flee destinations, in order, were
  // 45 49 45 49 45 49 45 49 — room 49 to 45, back to 49, taking damage the whole way.
  // He was never failing to flee; he was fleeing in a circle, because the room you have
  // just escaped is always adjacent to the room you escaped into and `nearestExit` has
  // no memory. The postmortems from that shape carry no target, because there is no
  // fight — just a body walked between two rooms until it runs out.
  const nearest = (list) => list[0] ?? null;      // deterministic stand-in for nearestExit
  const exits = [{ to: 49 }, { to: 45 }, { to: 102 }];

  ok('with no history it just takes the nearest',
     chooseFleeExit({}, exits, null, nearest)?.to === 49);

  const justFled49 = { _fledFrom: { room: 49, at: Date.now() } };
  ok('having just fled 49, it does NOT go back to 49',
     chooseFleeExit(justFled49, exits, null, nearest)?.to !== 49,
     JSON.stringify(chooseFleeExit(justFled49, exits, null, nearest)));

  // The exclusion must lapse, or a character that circles a dangerous area is stuck.
  const longAgo = { _fledFrom: { room: 49, at: Date.now() - 10 * 60_000 } };
  ok('...but the exclusion lapses, so a real circuit is still possible',
     chooseFleeExit(longAgo, exits, null, nearest)?.to === 49);

  // A DEAD END STILL HAS TO BE USABLE. Refusing the only door would leave the character
  // standing in the room being hit, which is worse than going back.
  const oneWay = [{ to: 49 }];
  ok('the only way out is taken even if we just came from there',
     chooseFleeExit(justFled49, oneWay, null, nearest)?.to === 49);

  ok('no exits at all is null, not a throw', chooseFleeExit(justFled49, [], null, nearest) === null);
}


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nBLINK IS WORTH ONE TRY, AND THEN IT IS NOT A CURE');
{
  // Blink IS the right answer to being entombed — any relocation is progress when the
  // body cannot take a step — and it is far cheaper than a reconnect, so it is offered
  // first. But it relocates to "a central location in the room" (blink.kod:21), and if
  // that location is inside the same sealed geometry the character is still entombed.
  //
  // Then it is the most expensive loop this keeper can run: 15 mana at roughly one per
  // ten seconds is about two minutes of resting per attempt, and `unwedge` outranks
  // everything below it, so nothing else happens in between. Measured on JayB in
  // Familiars: mana 12, 13, 14, then 0 (the cast), then 1, 2, 3, 4 — climbing toward the
  // next attempt, 1,919 consecutive unwedge ticks, never free.
  //
  // The planner already had a guard and it could never fire: it wanted
  // `entombed === true && pocket_has_exit === false`, but an entombed body reaches
  // NOTHING, pocket_has_exit returns null on an empty set, and null means true. The one
  // character it was written for was the one it excluded. Judge on evidence instead.
  const c = fakeClient({ selfId: 1, col: 5, row: 5, hp: 20, hpMax: 20, mana: 20, vigor: 150,
    spells: ['blink'], equipped: [{ id: 1, name: 'mace' }], room: { num: 50, objects: [] } });
  const ws = { entombed: true, can_pay_blink: true, can_leave: false, pocket_has_exit: null };

  const first = planFor(c, { can_leave: true }, { ws });
  ok('the first attempt is blink — it is the cheap cure and it often works',
     first.found && first.names[0] === 'cast blink', JSON.stringify(first.names));

  const after = planFor(c, { can_leave: true }, { ws, filter: new Set(['cast blink']) });
  ok('once it has failed, the plan is the reconnect instead',
     after.found && after.names[0] === 'escape_pocket', JSON.stringify(after.names));

  // The decider must be the thing that stops offering it, and must stop counting once
  // the character can step again — otherwise one bad stranding disables blink for ever.
  const src = readFileSync(new URL('./m59-decide.mjs', import.meta.url), 'utf8');
  ok('the counter is cleared when the character is no longer entombed',
     /ws\.entombed !== true\) \{ session\._unwedgeBlinks = 0; \}/.test(src));
  ok('and the filter is only applied after a blink has actually been sent',
     /_unwedgeBlinks \?\? 0\) >= 1/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
