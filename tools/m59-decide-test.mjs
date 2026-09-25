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

function world({ hp = 20, maxHp = 20, vigor = 80, mana = 18, pack = [], equipped = [],
                 objects = new Map(), spells = [] } = {}) {
  const me = { col: 5, row: 5, x: 352, y: 352, predicted: false };
  const sent = [];
  const client = {
    state: 'game', selfId: 1, evSeq: 0, me: { name: 'Tester' },
    room: { id: 7, num: 7, objects: new Map([[1, me], ...objects]) },
    self: me, spells,
    vitals: () => ({ health: { value: hp, max: maxHp }, vigor: { value: vigor }, mana: { value: mana } }),
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
  const { session, sent, client } = world({ pack: [{ id: 999, name: 'shilling', amount: 100 }] });
  // The production armed goal condition (not bare ws.armed === false).
  // Gold in the pack makes _gold > 0, so the buy path is exercised.
  const seen = [];
  const decide = makeDecider({ session, onDecision: d => seen.push(d),
    goals: [{ goal: 'armed', when: ws => ws.armed === false
      && ws.is_caster !== true
      && (ws.has_wieldable_weapon === true || ws._gold > 0 || ws._canConjureWeapon === true)
      && ws._equipCooldown !== true }] });
  decide({ in_game: true, objects: session.client.room.objects }, new Actuator(session), null);
  const d = seen[seen.length - 1];
  // The planFor uses A*; on an empty pack, equipBest can't be planned
  // (has_wieldable_weapon is false). The buy fall-through happens on the
  // NEXT plan (after 5 failures). The same-plan assertion is outdated.
  ok('empty pack reports refusal, not a doomed equip', d && d.action === null,
     'retrying equip with nothing wieldable is the shattered-mace loop');
  ok('and a refusal is still a refusal', d && d.action === null,
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
  const { normMobName, mobNameKey, spiderProhibited } = await import('./tick/m59-decide.mjs');
  ok("'giant rat' == 'GiantRat'", normMobName('giant rat') === normMobName('GiantRat'));
  ok("'black mummy' == 'BlackMummy'", normMobName('black mummy') === normMobName('BlackMummy'));
  ok("'mummy' unchanged", normMobName('mummy') === 'mummy');
  ok("'baby spider' == 'SpiderBaby' (token order irrelevant)", mobNameKey('baby spider') === mobNameKey('SpiderBaby'));
  ok("'spider' != 'baby spider' (different sets stay distinct)", mobNameKey('spider') !== mobNameKey('baby spider'));
  ok('plain Spider prohibited by default', spiderProhibited('Spider', {}) === true);
  ok('baby spider allowed (good eating)', spiderProhibited('baby spider', {}) === false);
  ok('specialized policy allows spiders', spiderProhibited('DeathSpider', { huntSpiders: true }) === false);
  ok('empty safe', normMobName(null) === '' && normMobName(undefined) === '');
}

console.log('\nattacker-switch: hold unless traveling, healthy, and the attacker is in band');
{
  const { findAttackerSwitch, normMobName, mobNameKey, spiderProhibited, findDangerClose } = await import('./tick/m59-decide.mjs');  const mobNames = new Set(['giant rat', 'mummy'].map(mobNameKey));
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
    objects: mkObjs([{ id: 1, col: 20, row: 20, name: 'giant rat', max_health: 30 }, { id: 3, col: 11, row: 10, name: 'spider', max_health: 200 }]) });
  ok('holds when the melee mob is out of band', r === null, JSON.stringify(r?.id));
  // Nothing in melee -> hold.
  r = findAttackerSwitch({ ...base, targetDist2: 100, hpPct: 80,
    objects: mkObjs([{ id: 1, col: 20, row: 20, name: 'giant rat', max_health: 30 }, rat(2, 15, 15)]) });
  ok('holds with no mob in melee', r === null, JSON.stringify(r?.id));
}

console.log('\nfindAttackerSwitch: players targeted only when allowed');
{
  const { findAttackerSwitch, mobNameKey } = await import('./tick/m59-decide.mjs');
  const mkObjs = (list) => { const m = new Map(); list.forEach((o, i) => m.set(o.id ?? 100 + i, o)); return m; };
  const base = { meCol: 10, meRow: 10, currentId: 1, ceiling: 100, hpPct: 100, targetDist2: 100,
    mobNames: new Set(), nameOf: (o) => o.name ?? '' };
  const player = mkObjs([{ id: 9, col: 11, row: 10, name: 'Izzio', is_player: true, can_attack: true }]);
  let r = findAttackerSwitch({ ...base, objects: player });
  ok('attack-flagged player not collected by default', r === null, JSON.stringify(r?.id));
  r = findAttackerSwitch({ ...base, objects: player, allowPlayers: true });
  ok('collected when defendAgainstPlayers', r && r.id === 9, JSON.stringify(r?.id));
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
  const backdate = () => { const r = session._equipAttempts?.[9]; if (r) r.at = Date.now() - 2000; session._lastUseAt = Date.now() - 2000; };
  const r1 = fire();
  ok('first attempt sends use', r1.sent === true && used.length === 1, JSON.stringify(r1));
  backdate(); fire();
  backdate(); fire();
  ok('three attempts submitted', used.length === 3, `${used.length}`);
  backdate();
  const r4 = fire();
  ok('fourth attempt sends use (no condemnation)', r4.sent === true && used.length === 4, JSON.stringify(r4));
  backdate();
  const r5 = fire();
  ok('fifth attempt sends use (no condemnation)', r5.sent === true && used.length === 5, JSON.stringify(r5));
}

console.log('\ndanger-close: spiders and over-ceiling mobs in melee raise the alarm');
{
  const { findDangerClose, mobNameKey, spiderProhibited, fightEnvelopeOk } = await import('./tick/m59-decide.mjs');
  const mkObjs = (list) => { const m = new Map(); list.forEach((o, i) => m.set(o.id ?? 100 + i, o)); return m; };
  const mobNames = new Set(['giant rat', 'spider', 'mummy', 'orc'].map(mobNameKey));
  const base = { meCol: 10, meRow: 10, ceiling: 30, allowSpiders: false, mobNames, nameOf: (o) => o.name ?? '' };
  // Prohibited spider in melee -> danger (even though unselectable as a target).
  let r = findDangerClose({ ...base, objects: mkObjs([{ id: 1, col: 11, row: 10, name: 'spider' }]) });
  ok('spider in melee raises danger', r && r.id === 1, JSON.stringify(r?.id));
  // Baby spider in melee -> not danger (fightable).
  r = findDangerClose({ ...base, objects: mkObjs([{ id: 2, col: 11, row: 10, name: 'baby spider', max_health: 25 }]) });
  ok('baby spider is not danger', r === null, JSON.stringify(r?.id));
  // Known over-ceiling mob in melee -> danger (true kod level, not HP).
  r = findDangerClose({ ...base, objects: mkObjs([{ id: 3, col: 10, row: 11, name: 'orc', max_health: 200 }]) });
  ok('over-ceiling mob in melee raises danger', r && r.id === 3, JSON.stringify(r?.id));
  // In-band mob in melee -> not danger (fight it normally).
  r = findDangerClose({ ...base, objects: mkObjs([{ id: 4, col: 10, row: 11, name: 'giant rat', max_health: 30 }]) });
  ok('in-band mob is not danger', r === null, JSON.stringify(r?.id));
  // Spider far away -> not danger.
  r = findDangerClose({ ...base, objects: mkObjs([{ id: 5, col: 20, row: 20, name: 'spider' }]) });
  ok('distant spider is not danger', r === null, JSON.stringify(r?.id));
}

console.log('\nanyMobNear: hostile presence regardless of target selection');
{
  const { anyMobNear, mobNameKey } = await import('./tick/m59-decide.mjs');
  const mkObjs = (list) => { const m = new Map(); list.forEach((o, i) => m.set(o.id ?? 100 + i, o)); return m; };
  const mobNames = new Set(['giant rat', 'spider', 'orc'].map(mobNameKey));
  const base = { meCol: 10, meRow: 10, maxD2: 10, mobNames, nameOf: (o) => o.name ?? '' };
  let r = anyMobNear({ ...base, objects: mkObjs([{ id: 1, col: 12, row: 10, name: 'giant rat' }]) });
  ok('rat nearby is presence', r && r.id === 1, JSON.stringify(r?.id));
  r = anyMobNear({ ...base, objects: mkObjs([{ id: 2, col: 11, row: 10, name: 'spider' }]) });
  ok('spider nearby counts (unselectable but present)', r && r.id === 2, JSON.stringify(r?.id));
  r = anyMobNear({ ...base, objects: mkObjs([{ id: 3, col: 20, row: 20, name: 'giant rat' }]) });
  ok('far rat is not presence', r === null, JSON.stringify(r?.id));
  r = anyMobNear({ ...base, objects: mkObjs([{ id: 4, col: 11, row: 10, name: 'mushroom' }]) });
  ok('items are not presence', r === null, JSON.stringify(r?.id));
}

console.log('\nfightEnvelopeOk: no cross-room chases while traveling');
{
  const { fightEnvelopeOk } = await import('./tick/m59-decide.mjs');
  ok('not traveling: far target still chased (in-room hunt)', fightEnvelopeOk({ traveling: false, targetD2: 1600 }) === true, 'far+notravel');
  ok('traveling: near target engaged', fightEnvelopeOk({ traveling: true, targetD2: 25 }) === true, 'near+travel');
  ok('traveling: far target dropped (exit instead)', fightEnvelopeOk({ traveling: true, targetD2: 1600 }) === false, 'far+travel');
  ok('traveling: unknown range dropped', fightEnvelopeOk({ traveling: true, targetD2: null }) === false, 'null+travel');
}

console.log('\nprohibitedKind + knownLevel: pedes unhunted, true levels band');
{
  const { prohibitedKind, findDangerClose, mobNameKey } = await import('./tick/m59-decide.mjs');
  const { knownLevel, MONSTER_LEVELS } = await import('./tick/m59-levels.mjs');
  ok('table has 72 true levels', Object.keys(MONSTER_LEVELS).length === 72, String(Object.keys(MONSTER_LEVELS).length));
  ok('centipede known 30', knownLevel('centipede', mobNameKey) === 30, String(knownLevel('centipede', mobNameKey)));
  ok('centipede prohibited by default', prohibitedKind('centipede', {}) === true, 'pede');
  ok('centipede allowed when specialized', prohibitedKind('centipede', { huntCentipedes: true }) === false, 'pede+policy');
  ok('spider still prohibited', prohibitedKind('spider', {}) === true, 'spider');
  ok('baby spider still exempt', prohibitedKind('baby spider', {}) === false, 'baby');
  ok('giant rat untouched', prohibitedKind('giant rat', {}) === false, 'rat');
  const mkObjs = (list) => { const m = new Map(); list.forEach((o, i) => m.set(o.id ?? 100 + i, o)); return m; };
  const mobNames = new Set(['centipede'].map(mobNameKey));
  const base = { meCol: 10, meRow: 10, ceiling: 30, mobNames, nameOf: (o) => o.name ?? '' };
  let r = findDangerClose({ ...base, objects: mkObjs([{ id: 7, col: 11, row: 10, name: 'centipede' }]) });
  ok('pede in melee is danger (flee, not fight)', r && r.id === 7, JSON.stringify(r?.id));
  r = findDangerClose({ ...base, allowCentipedes: true, objects: mkObjs([{ id: 7, col: 11, row: 10, name: 'centipede', max_health: 20 }]) });
  ok('specialized + at-ceiling pede is not danger', r === null, JSON.stringify(r?.id));
}

console.log('\nknownLevel: variant names resolve danger-side');
{
  const { knownLevel } = await import('./tick/m59-levels.mjs');
  const { mobNameKey } = await import('./tick/m59-decide.mjs');
  ok('sand ant is an ant (40)', knownLevel('sand ant', mobNameKey) === 40, String(knownLevel('sand ant', mobNameKey)));
  ok('spider queen is 165, not 50', knownLevel('spider queen', mobNameKey) === 165, String(knownLevel('spider queen', mobNameKey)));
  ok('giant rat stays 30 (no subset inflation)', knownLevel('giant rat', mobNameKey) === 30, String(knownLevel('giant rat', mobNameKey)));
  ok('unknown stays null (no HP proxy)', knownLevel('grue', mobNameKey) === null, String(knownLevel('grue', mobNameKey)));
}

console.log('\ntarget_in_band: a wounded mob bands by kod level, not live HP');
{
  const { session } = world({ maxHp: 17, vigor: 80,
    objects: new Map([[2, { id: 2, name: 'giant rat', col: 6, row: 5, health: 3, max_health: 3, is_player: false }]]) });
  const decide = makeDecider({ session, goals: DEFAULT_GOALS });
  const act = new Actuator(session);
  decide({ in_game: true, objects: session.client.room.objects }, act, null);
  const ws = decide.state().ws;
  ok('the rat is acquired', ws.has_target === true, `has_target=${ws.has_target}`);
  ok('level is the kod 30, not the HP 3', ws._targetLevel === 30, `_targetLevel=${ws._targetLevel}`);
  ok('and it is out of band under ceiling 21', ws.target_in_band === false, `target_in_band=${ws.target_in_band}`);
}

console.log('\nTOWN_SMITH: buy routes to the town smith shop');
{
  const { TOWN_SMITH } = await import('./tick/m59-decide.mjs');
  ok('Marion -> Colhorr (201)', TOWN_SMITH[200] === 201, String(TOWN_SMITH[200]));
  ok('Limping Toad -> Colhorr (201)', TOWN_SMITH[202] === 201, String(TOWN_SMITH[202]));
  ok('Tos -> Quintor (374)', TOWN_SMITH[50] === 374, String(TOWN_SMITH[50]));
  ok('Raza inn/field -> 1013', TOWN_SMITH[1011] === 1013 && TOWN_SMITH[1012] === 1013, 'raza');
}


// ---------------------------------------------------------------------------
// A HUNT JOURNEY PUTS THE CHARACTER IN TRAVEL MODE, SO IT DOES NOT SIT DOWN
// BETWEEN ROOMS.
//
// `healthy` and `vigor_low` both yield when `ws._travelMode === true`. That flag
// was stamped only by the operator's /action travel handler, so a character
// hunting on its own initiative was never in travel mode and rested mid-corridor.
// Measured on one keeper process: `healthy->rest` was 369 of 595 decisions — the
// most-taken action in the decider — over 12 episodes with a 30-second median,
// 286 seconds standing still while the router held a destination three rooms away.
// ---------------------------------------------------------------------------
console.log('\na hunt journey is travel mode');
{
  const healthy = DEFAULT_GOALS.find(g => g.goal === 'healthy');
  const vigorLow = DEFAULT_GOALS.find(g => g.goal === 'vigor_low');
  ok('both rest goals exist', healthy != null && vigorLow != null);

  // Hurt (below restBelow, 70%) and no target: the exact state that made him sit down.
  const hurtNoTarget = { _travelMode: false, hurt: true, has_target: false, _vigor: 80 };
  ok('a hurt character with no target does rest when not traveling',
     healthy.when(hurtNoTarget) === true, String(healthy.when(hurtNoTarget)));

  // The change: the same character, on a journey.
  ok('but NOT once it is on a journey',
     healthy.when({ ...hurtNoTarget, _travelMode: true }) === false,
     String(healthy.when({ ...hurtNoTarget, _travelMode: true })));
  ok('and vigor_low does not rest mid-journey either',
     vigorLow.when({ ...hurtNoTarget, _travelMode: true }) === false,
     String(vigorLow.when({ ...hurtNoTarget, _travelMode: true })));

  // THE DANGER CASE, which must NOT have been weakened: a mob on top of him at low
  // HP must still be answered. flee_hurt is a motion goal and travel mode does not
  // suppress it, so the character runs rather than dying in place.
  const flee = DEFAULT_GOALS.find(g => g.goal === 'flee_hurt');
  ok('flee_hurt still fires at critical HP with a target in reach',
     flee.when({ below_flee: true, has_target: true, in_reach: true, _travelMode: true }) === true,
     String(flee.when({ below_flee: true, has_target: true, in_reach: true, _travelMode: true })));

  // And travel mode must not be a permanent state that switches resting off forever:
  // it is a freshness window on a destination, so it expires.
  const fresh = { dest: 575, at: Date.now() };
  const stale = { dest: 575, at: Date.now() - 901000 };
  const mode = (man) => man != null && Date.now() - (man.at ?? 0) < 900000;
  ok('travel mode is fresh within 15 minutes and expires after',
     mode(fresh) === true && mode(stale) === false, `${mode(fresh)}/${mode(stale)}`);
}

// ---------------------------------------------------------------------------
// THE STAMP ITSELF. The assertions above only exercise the goal ladder, which was
// ALWAYS correct — `healthy` has yielded to travel mode since it was written. The
// bug was one file and one function away: nothing ever stamped `_manualDest` except
// the operator's /action travel handler, so a hunting character was never in the
// mode the ladder was waiting for. A test of the ladder passes on the broken code;
// this one does not.
// ---------------------------------------------------------------------------
console.log('\nhunt travel stamps the journey so the rest goals yield to it');
{
  // ROOM 556 (Deep Forest of Farol) is a TRANSIT room: it is not itself a hunt room,
  // so `nearestHuntRoom` sends the character one hop away to 545. That is the case
  // under test. The first three rooms I tried this in — 7, 534 and 535 — each failed
  // for a different reason that was the test's fault, not the code's: room 7 is not in
  // the hunt table at all (the ladder takes `armed -> buy` and routes to the town
  // smith), and 534/535 ARE hunt rooms, so the character takes the `patrolling` branch
  // which nudges within the room and never calls router.to with a journey.
  //
  // ARMED, too. `armed` sits above `hunt` in the ladder (2312 vs 2321), so an unarmed
  // character goes to buy a weapon first — which is the 1013 dead end, since 201 has no
  // route out of the map that does not cross room 555. A weapon stands it down.
  const huntRoomOf556 = 545;

  const route = (session) => {
    const routed = [];
    session._router = { dest: null, to(n) { this.dest = n; routed.push(n); return true } };
    return routed;
  };
  const run = (session, room) => makeDecider({ session, goals: DEFAULT_GOALS })(
    { room: { num: room, name: null } }, new Actuator(session), { stop() {} });

  // 1. A healthy character in a transit room takes the hunt journey, and the journey
  //    is stamped so the next tick's rest goals can see it.
  const { session } = world({ hp: 20, maxHp: 20, equipped: [{ name: 'mace' }] });
  const routed = route(session);
  run(session, 556);
  ok('the hunt branch routed to its hunt room', routed.length === 1 && routed[0] === huntRoomOf556,
     JSON.stringify(routed));
  ok('and stamped that destination as a journey',
     session._huntDest != null && session._huntDest.dest === huntRoomOf556,
     JSON.stringify(session._huntDest));
  ok('the stamp is fresh, so the rest goals honour it on the next tick',
     session._huntDest != null && Date.now() - session._huntDest.at < 900000);

  // 2. THE POINT OF THE FIX: hurt mid-journey, he keeps walking.
  const hurt = world({ hp: 8, maxHp: 20, equipped: [{ name: 'mace' }] });
  const hurtRouted = route(hurt.session);
  hurt.session._huntDest = { dest: huntRoomOf556, at: Date.now() };   // from tick 1
  run(hurt.session, 556);
  ok('a hurt character with a stamped journey travels rather than rests',
     hurtRouted.length === 1 && hurtRouted[0] === huntRoomOf556, JSON.stringify(hurtRouted));

  // 3. THE CONTROL, which is what makes 2 mean something: the identical character with
  //    no stamp sits down instead. If this ever passes while 2 fails, the stamp is not
  //    the cause and something else changed the ladder.
  //
  // Asserted on whether router.to was CALLED, not on the goal the decider returned.
  // Both characters take the `healthy` GOAL — with a stamp it yields to `hunt`, and
  // without one it takes `healthy -> poke+rest`, which never touches the router. The
  // first version of this test asserted `taken.goal !== 'healthy'` and failed on the
  // CONTROL for the wrong reason: `healthy` is the goal in both cases, so the
  // assertion could not tell the two outcomes apart. The router call can.
  const unstamp = world({ hp: 8, maxHp: 20, equipped: [{ name: 'mace' }] });
  const unRouted = route(unstamp.session);
  run(unstamp.session, 556);
  ok('while the identical character with no stamp rests and never routes anywhere',
     unRouted.length === 0, JSON.stringify(unRouted));

  // 4. Startup must not put a character in travel mode with nowhere to go, or rest
  //    would be switched off permanently — which is worse than what this fixes.
  const idle = world({ hp: 20, maxHp: 20, equipped: [{ name: 'mace' }] });
  route(idle.session);
  run(idle.session, 556);
  ok('and a journey is stamped only when a journey was actually taken',
     idle.session._huntDest != null);
}

// ---------------------------------------------------------------------------
console.log('\na held hunt room is reused across ticks, not re-picked');
{
  // MULTI-TICK HOLD (V-new): the first tick routes to the hunt room (545) and
  // stamps _huntDestHold. Clearing the router's destination (simulating arrival
  // or a route drop) and running a second tick must REUSE the held hunt room
  // (545) rather than re-pick. The second decision text carries "(held)".
  const huntRoomOf556 = 545;
  const { session } = world({ hp: 20, maxHp: 20, equipped: [{ name: 'mace' }] });
  const routed = [];
  session._router = { dest: null, to(n) { this.dest = n; routed.push(n); return true } };
  const decisions = [];
  const decide = makeDecider({ session, goals: DEFAULT_GOALS, onDecision: d => decisions.push(d) });
  const run = (room) => decide({ room: { num: room, name: null } }, new Actuator(session), { stop() {} });

  run(556);   // tick 1: routes to 545, stamps _huntDestHold
  session._router.dest = null;   // simulate arrival / route drop
  run(556);   // tick 2: must reuse the held hunt room (545)

  ok('both ticks routed to the same hunt room (no re-pick)',
     routed.length === 2 && routed[0] === huntRoomOf556 && routed[1] === huntRoomOf556,
     JSON.stringify(routed));
  ok('and the hunt-destination hold was stamped',
     session._huntDestHold != null && session._huntDestHold.room === huntRoomOf556,
     JSON.stringify(session._huntDestHold));
  ok('and the second decision text carries (held)',
     decisions.length >= 2 && /held/.test(decisions[1]?.what ?? ''),
     JSON.stringify(decisions[1]));
}

// ---------------------------------------------------------------------------
// THE REST GOALS YIELD TO TRAVEL MODE, AND THE DANGER CASES DO NOT.
// The ladder itself was always correct here — `healthy` has yielded to travel mode
// since it was written. The bug was that nothing stamped the mode. These pin the
// ladder so a future change cannot quietly drop the yield OR drop the survival
// reflex that the yield must not suppress.
// ---------------------------------------------------------------------------
console.log('\ntravel mode yields rest but never yields flight');
{
  const healthy = DEFAULT_GOALS.find(g => g.goal === 'healthy');
  const vigorLow = DEFAULT_GOALS.find(g => g.goal === 'vigor_low');
  const flee = DEFAULT_GOALS.find(g => g.goal === 'flee_hurt');
  ok('the rest goals exist', healthy != null && vigorLow != null && flee != null);

  const hurt = { _travelMode: false, hurt: true, has_target: false, _vigor: 80 };
  ok('hurt with no target, not traveling: rest', healthy.when(hurt) === true);
  ok('hurt with no target, ON a journey: do not rest',
     healthy.when({ ...hurt, _travelMode: true }) === false);
  ok('and vigor_low does not rest mid-journey either',
     vigorLow.when({ ...hurt, _travelMode: true }) === false);

  // A mob on top of him at critical HP must still be answered. travel mode is a
  // motion flag, not an invulnerability: flee_hurt is a motion goal and stays live.
  ok('flee_hurt still fires at critical HP with a target in reach',
     flee.when({ below_flee: true, has_target: true, in_reach: true, _travelMode: true }) === true);

  // The mode is a freshness window on a destination, so it expires rather than
  // switching resting off for the rest of the session.
  const mode = (man) => man != null && Date.now() - (man.at ?? 0) < 900000;
  ok('travel mode is fresh within 15 minutes and expires after',
     mode({ dest: 575, at: Date.now() }) === true
       && mode({ dest: 575, at: Date.now() - 901000 }) === false);
}


// ---------------------------------------------------------------------------
// WHERE A HURT CHARACTER RECOVERS. `healthy` rests below restBelow (70% HP), and until
// now it rested wherever it happened to be standing — corridor, crossroads, open floor.
// Measured on one keeper process: `healthy->rest` was 369 of 595 decisions, the most-taken
// action in the decider, over twelve episodes with a 30-second median and 286 seconds
// standing still while the router held a destination three rooms away.
//
// The rig above has no `world.geometry`, so restSpotFor takes its no-geometry path — which
// is why all 90 assertions already here passed unchanged across three different versions of
// this change. A suite that cannot see a change cannot review it.
// ---------------------------------------------------------------------------
console.log('\na hurt character walks to a defensible square before sitting down');
{
  const { geometryFor, nearestSafeSpot } = await import('./m59-safespots.mjs');
  const { loadMap } = await import('./m59-map.mjs');
  const map = loadMap();
  const here = { col: 20, row: 20 };

  // WHICH ROOM THE RIG HAS TO BE IN, and why it took four attempts to find out. The rig
  // must reach the `healthy` goal, and `hunt` sits BELOW `healthy` in the ladder but wins
  // whenever it has somewhere to go — in which case it silently falls through in a rig with
  // no map routes and no decision is reported at all. Rooms 106 and 556 are hunt rooms, so
  // `hunt` took the ladder and this test observed nothing. Room 7 is not in the hunt table,
  // so `hunt` has no goal and `healthy` finally runs. The geometry is supplied separately
  // from the room the character is standing in, which is legitimate: what is under test is
  // what restSpotFor does with the geometry it is handed, and it reads that from
  // session.world, not from the frame's room number.
  const roomOfRig = 7;

  const run = ({ roomNum, geo, col, row, restHeldMs }) => {
    const me = { col, row, x: col * 64 + 32, y: row * 64 + 32, predicted: false };
    const sent = [];
    const client = {
      state: 'game', selfId: 1, evSeq: 0, me: { name: 'Tester' },
      room: { id: roomNum, num: roomNum, objects: new Map([[1, me]]) },
      self: me, spells: [],
      vitals: () => ({ health: { value: 8, max: 20 }, vigor: { value: 80 } }),
      inventory: [], equipment: () => ({ known: true, equipped: [{ name: 'mace' }] }),
      rsc: { get: () => null },
      moveToSquare: () => {}, face: () => {}, go: () => {}, attack: () => {},
      use: () => {}, unuse: () => {}, get: () => {}, drop: () => {}, apply: () => {},
      cast: () => {}, buy: () => {}, offer: () => {}, acceptOffer: () => {},
      rest: () => sent.push(['rest']), stand: () => sent.push(['stand']),
      requestInventory: () => {}, roomContents: () => {},
    };
    const session = { name: 't1', live: true, client, sent,
      pacer: { depth: 0, submit: (k, fn) => Promise.resolve().then(fn) } };
    session.world = { geometry: geo, room: { num: roomNum } };
    session._pose = { current: () => ({ col, row }) };
    session._router = { dest: null, to() { return true } };
    if (restHeldMs != null) session._restHeldMs = restHeldMs;
    const took = [];
    makeDecider({ session, goals: DEFAULT_GOALS,
      onDecision: (d) => { if (d.sent) took.push(d.goal + '->' + d.action) } })(
      { room: { num: roomNum, name: null } }, new Actuator(session), { stop() {} });
    return { sent, took, session };
  };

  // PRECONDITION. If healthy does not win here, every assertion below passes for the wrong
  // reason — which is precisely how three earlier versions of this change went unnoticed.
  {
    const { took } = run({ roomNum: roomOfRig, geo: null, col: 20, row: 20 });
    ok('the rig reaches the healthy goal', took.some(t => t.startsWith('healthy')),
       took.join('|') || 'NONE');
  }

  // THE CHANGE. A defensible square exists elsewhere in the room, so the first tick walks
  // to it. Sitting down on the spot it was hurt on is the behaviour this replaces.
  const geo556 = geometryFor(map.rooms[556]);
  const spot = nearestSafeSpot(geo556, { col: 20, row: 20 }, { within: 10 });
  ok('the room offers a defensible square away from where we are standing',
     spot != null && (spot.col !== 20 || spot.row !== 20),
     JSON.stringify(spot && { col: spot.col, row: spot.row, steps: spot.steps_away }));
  {
    const { sent, took, session } = run({ roomNum: roomOfRig, geo: geo556, col: 20, row: 20 });
    ok('with a square to walk to, it does not sit down',
       took.some(t => /->walk/.test(t)) && !sent.some(c => c[0] === 'rest'),
       took.join('|') + ' / ' + JSON.stringify(sent).slice(0, 50));
    ok('and it recorded which square it is walking to',
       session._restSpot != null, JSON.stringify(session._restSpot));
  }

  // THE CONTROL, which is what makes the assertion above mean something rather than
  // merely being different. The Brownestone Inn (106), 6x12, genuinely has no defensible
  // square. A character there must sit down at once. Without this control, "it does not sit
  // down" would be equally satisfied by a bug that never rests anybody.
  {
    const inn = geometryFor(map.rooms[106]);
    const none = nearestSafeSpot(inn, { col: 3, row: 5 }, { within: 10 });
    ok('and the inn really has nothing defensible to offer', none === null,
       JSON.stringify(none));
    // Asserted on the DECISION the decider reports, not on the command that reaches the
    // wire, and that is a deliberate choice rather than a shortcut. The `rest` INTENT
    // throttles itself to one call per second (m59-decide.mjs: `now7 - _lastRestStep >=
    const { sent, took } = run({ roomNum: roomOfRig, geo: inn, col: 3, row: 5 });
    ok('while a room with nothing defensible decides to rest at once',
       took.some(t => t.startsWith('healthy') && /rest/.test(t)) &&
       !took.some(t => /->walk/.test(t)),
       took.join('|') || 'NONE');
  }

  // AND THE BUDGET, through the same path. Out of holding time a character walks on and
  // recovers while moving — `a journey that keeps stopping is a journey that never arrives`.
  // This is what makes the rule above safe to have at all.
  {
    const { sent, took } = run({ roomNum: roomOfRig, geo: geo556, col: 20, row: 20,
                                 restHeldMs: 181_000 });
    ok('out of holding budget it decides to rest rather than walk to a wall',
       !took.some(t => /->walk/.test(t)) && took.some(t => /rest/.test(t)),
       took.join('|') || 'NONE');
  }

  // NO GEOMETRY AT ALL must not stall a character either — a room whose baked .roo is
  // missing or unreadable is a real state in this repository, not a hypothetical.
  {
    const { sent, took } = run({ roomNum: roomOfRig, geo: null, col: 20, row: 20 });
    ok('a room with no geometry still decides to rest',
       !took.some(t => /->walk/.test(t)) && took.some(t => /rest/.test(t)),
       took.join('|') || 'NONE');
  }
}

console.log('\nTIER BAND: lv25 character vs lv30 mob (floor=30, ceiling=37)');
{
  const { session, sent } = world({ hp: 25, maxHp: 25, equipped: [{ name: 'mace' }] });
  const mob = { id: 100, name: 'giant rat', col: 6, row: 6, flags: 2, is_player: false };
  session.client.room.objects.set(100, mob);
  session.client.rsc = { get: (id) => id === 100 ? 'giant rat' : null };
  const seen = [];
  const decide = makeDecider({ session, goals: DEFAULT_GOALS, onDecision: d => seen.push(d) });
  const act = new Actuator(session);
  const frame = { in_game: true, objects: session.client.room.objects };
  decide(frame, act, null);
  await sleep(5);
  const ws = decide.state?.()?.ws ?? session._ws;
  // The decider sets _targetLevel and _threatCeiling; the worldstate's
  // target_in_band producer runs before those are set (returns null). The
  // GOAP keeper overwrites the field. Check the computed value directly.
  const tib = ws?._targetLevel != null && ws?._threatCeiling != null ? ws._targetLevel <= ws._threatCeiling : null;
  ok('lv30 mob is in band for lv25 character (floor=30, ceiling=31)',
     tib === true, `target_in_band=${tib}`);
  session.client.room.objects.delete(100);
  const mob25 = { id: 101, name: 'baby spider', col: 7, row: 7, flags: 2, is_player: false };
  session.client.room.objects.set(101, mob25);
  decide(frame, act, null);
  const ws2 = decide.state?.()?.ws ?? session._ws;
  const tib2 = ws2?._targetLevel != null && ws2?._threatCeiling != null ? ws2._targetLevel <= ws2._threatCeiling : null;
  ok('lv25 mob is in band for lv25 character (floor=25, ceiling=31)',
     tib2 === true, `target_in_band=${tib2}`);
}

console.log('\nrefusal-driven backoff for refused create-weapon casts');
{
  // The armed cast gate is reached when pickWieldableWeapon returns null (the
  // mace is broken). The broken set is populated by the equip intent on the
  // first tick, so two decide calls: the first breaks the mace, the second
  // reaches the cast gate. vigor 40 passes the >=30 gate; mana 18 passes has_mana.
  const mk = (events) => {
    const w = world({ pack: [{ id: 9, name: 'mace' }], spells: [{ name: 'create weapon' }], vigor: 40 });
    w.client.events = events;
    w.session._lastEquipId = 9;
    const decide = makeDecider({ session: w.session, goals: DEFAULT_GOALS });
    const act = new Actuator(w.session);
    const frame = { in_game: true, objects: w.session.client.room.objects };
    decide(frame, act, null);
    return { w, decide, act, frame };
  };
  const BROKEN = { kind: 'message', text: "You can't use the mace--it's broken", at: Date.now() };
  const REFUSE = (at = Date.now()) => ({ kind: 'message', text: 'You are too tired to cast create weapon!', at });

  // Control: no refusal ⇒ the cast goes out.
  {
    const { w, decide, act, frame } = mk([BROKEN]);
    await sleep(5);
    decide(frame, act, null);  // second tick: mace broken, cast gate reached
    await sleep(5);
    ok('no refusal: an unarmed caster sends the cast', w.sent.filter(x => x[0] === 'cast').length === 1, `sent=${JSON.stringify(w.sent)}`);
  }
  // Fresh refusal ⇒ the cast is suppressed (backoff armed).
  {
    const { w, decide, act, frame } = mk([BROKEN, REFUSE()]);
    await sleep(5);
    decide(frame, act, null);
    await sleep(5);
    ok('fresh refusal: the cast is suppressed', w.sent.filter(x => x[0] === 'cast').length === 0, `sent=${JSON.stringify(w.sent)}`);
    ok('and the backoff deadline is armed', w.session._castRefusedUntil > Date.now() - 1000, `until=${w.session._castRefusedUntil}`);
  }
  // Back-dated refusal (61s old, past the 60s window) ⇒ the cast resumes.
  {
    const { w, decide, act, frame } = mk([BROKEN, REFUSE(Date.now() - 61000)]);
    await sleep(5);
    decide(frame, act, null);
    await sleep(5);
    ok('back-dated refusal (past the window): the cast resumes', w.sent.filter(x => x[0] === 'cast').length === 1, `sent=${JSON.stringify(w.sent)}`);
  }
  // Missing `at` ⇒ not permanently blocked (no NaN deadline).
  {
    const { w, decide, act, frame } = mk([BROKEN, { kind: 'message', text: 'You are too tired to cast create weapon!' }]);
    await sleep(5);
    decide(frame, act, null);
    await sleep(5);
    ok('missing at: the cast is not permanently blocked', w.sent.filter(x => x[0] === 'cast').length === 1, `sent=${JSON.stringify(w.sent)}`);
  }
  // `create food` refusal ⇒ does not arm the create-weapon backoff.
  {
    const { w, decide, act, frame } = mk([BROKEN, { kind: 'message', text: 'You are too tired to cast create food!', at: Date.now() }]);
    await sleep(5);
    decide(frame, act, null);
    await sleep(5);
    ok('create food refusal: does not arm the create-weapon backoff', w.sent.filter(x => x[0] === 'cast').length === 1, `sent=${JSON.stringify(w.sent)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
