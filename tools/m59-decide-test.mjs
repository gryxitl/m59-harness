#!/usr/bin/env node
// THE DECIDE HALF — offline contract test for m59-decide.mjs.
//
//   node tools/m59-decide-test.mjs
//
// The decider is the middle of a tick and the whole model rests on it being
// SYNCHRONOUS. Most of this file is that, plus the two failures that were watched live
// on this fleet and must not come back: a plan that cannot be made counting as nothing,
// and an action reporting success it did not have.
import { makeDecider, intend, INTENTS, DEFAULT_GOALS } from './tick/m59-decide.mjs';
import { Actuator, TickLoop } from './tick/m59-tick.mjs';

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
  ok('empty pack escalates to buy, not a doomed equip', d && d.action === 'buy',
     'retrying equip with nothing wieldable is the shattered-mace loop');
  ok('and a refusal is still a refusal', d && d.sent === false && /no merchant|no weapon/.test(d.why ?? ''),
     'no error has never meant success here');
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
  ok('the equip went out', sent.length >= 1, `${sent.length}`);
  ok('but equips are gated to 1/s, not re-fired every tick', sent.length <= 2, `${sent.length}`);
}

console.log('\ncast intent fires by spell name (the conjure path)');
{
  const { session } = world({ spells: [{ id: 42, name: 'create weapon' }] });
  const act = new Actuator(session);
  const r = intend('cast create weapon', { in_game: true }, act, { client: session.client, session, ws: {} });
  ok('cast intent sends', r.sent === true, JSON.stringify(r));
}

console.log('\nmob names normalize across game and compendium');
{
  const { normMobName, mobNameKey } = await import('./tick/m59-decide.mjs');
  ok("'giant rat' == 'GiantRat'", normMobName('giant rat') === normMobName('GiantRat'));
  ok("'black mummy' == 'BlackMummy'", normMobName('black mummy') === normMobName('BlackMummy'));
  ok("'mummy' unchanged", normMobName('mummy') === 'mummy');
  ok("'baby spider' == 'SpiderBaby' (token order irrelevant)", mobNameKey('baby spider') === mobNameKey('SpiderBaby'));
  ok("'spider' != 'baby spider' (different sets stay distinct)", mobNameKey('spider') !== mobNameKey('baby spider'));
  ok('empty safe', normMobName(null) === '' && normMobName(undefined) === '');
}

console.log('\nattacker-switch: hold unless traveling, healthy, and the attacker is in band');
{
  const { findAttackerSwitch, normMobName, mobNameKey } = await import('./tick/m59-decide.mjs');
  const mobNames = new Set(['giant rat', 'mummy'].map(normMobName));
  const mkObjs = (list) => { const m = new Map(); list.forEach((o, i) => m.set(o.id ?? 100 + i, o)); return m; };
  const base = { meCol: 10, meRow: 10, currentId: 1, blacklist: new Set(), ceiling: 30, mobNames, nameOf: (o) => o.name ?? '' };
  const rat = (id, col, row, extra = {}) => ({ id, col, row, name: 'giant rat', max_health: 30, ...extra });
  // Traveling (far target), healthy, in-band attacker in melee -> switch.
  let r = findAttackerSwitch({ ...base, targetDist2: 100, hpPct: 80,
    objects: mkObjs([{ id: 1, col: 20, row: 20, name: 'giant rat', max_health: 30 }, rat(2, 11, 10)]) });
  ok('switches to the melee attacker while traveling healthy', r && r.id === 2, JSON.stringify(r?.id));
  // Already joined (target reached) -> hold, finish it.
  r = findAttackerSwitch({ ...base, targetDist2: 4, hpPct: 80,
    objects: mkObjs([{ id: 1, col: 12, row: 10, name: 'giant rat', max_health: 30 }, rat(2, 11, 10)]) });
  ok('holds when already in melee with the target', r === null, JSON.stringify(r?.id));
  // Hurt (<50%) -> hold, don't collect a second fight.
  r = findAttackerSwitch({ ...base, targetDist2: 100, hpPct: 40,
    objects: mkObjs([{ id: 1, col: 20, row: 20, name: 'giant rat', max_health: 30 }, rat(2, 11, 10)]) });
  ok('holds while hurt', r === null, JSON.stringify(r?.id));
  // Out-of-band attacker in melee -> hold (don't collect it).
  r = findAttackerSwitch({ ...base, targetDist2: 100, hpPct: 80,
    objects: mkObjs([{ id: 1, col: 20, row: 20, name: 'giant rat', max_health: 30 }, { id: 3, col: 11, row: 10, name: 'dragon', max_health: 200 }]) });
  ok('holds when the melee mob is out of band', r === null, JSON.stringify(r?.id));
  // Nothing in melee -> hold.
  r = findAttackerSwitch({ ...base, targetDist2: 100, hpPct: 80,
    objects: mkObjs([{ id: 1, col: 20, row: 20, name: 'giant rat', max_health: 30 }, rat(2, 15, 15)]) });
  ok('holds with no mob in melee', r === null, JSON.stringify(r?.id));
}

console.log('\nequip condemns silent-broken weapons after 3 gated attempts');
{
  const used = [];
  const client = {
    inventory: [{ id: 9, name: 'mace' }],
    equipment: () => ({ known: true, equipped: [] }), // never equips: silent refusal
    rsc: { get: () => null },
  };
  const session = { name: 't' };
  const act = { use: (id) => used.push(id) };
  const ctx = { client, session };
  const fire = () => intend('equip', {}, act, ctx);
  const backdate = () => { const r = session._equipAttempts?.[9]; if (r) r.at = Date.now() - 2000; };
  const r1 = fire();
  ok('first attempt sends use', r1.sent === true && used.length === 1, JSON.stringify(r1));
  backdate(); fire();
  backdate(); fire();
  ok('three attempts submitted', used.length === 3, `${used.length}`);
  backdate();
  const r4 = fire();
  ok('fourth attempt condemns instead of retrying', r4.sent === false && /condemned/.test(r4.why ?? ''), JSON.stringify(r4));
  const r5 = fire();
  ok('condemned id routes to no-weapon refusal (conjure/buy next)', r5.sent === false && /no weapon/.test(r5.why ?? ''), JSON.stringify(r5));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
