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
         REST_UNTIL_DEFAULT, REST_LATCH_MAX_MS } from './m59-decide.mjs';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
