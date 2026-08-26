#!/usr/bin/env node
// m59-worldstate-test.mjs -- the closed vocabulary, and the direction it fails in.
//
// Offline, no server:  node tools/m59-worldstate-test.mjs
//
// Two things are pinned here and they are the whole point of the module:
//
//   THE SET IS CLOSED. An action naming a symbol nobody produces is reported by
//   name. Without this a plan can be unsatisfiable because of a typo and the
//   planner reports only "no plan" -- the same shape as `policy.purpose` being
//   absent from a schema for a year while every keeper ran with the yield audit
//   silently switched off.
//
//   UNKNOWN FAILS SAFE, AND SAFE IS PER SYMBOL. There is no single right default.
//   `armed` unknown must read TRUE or one timed-out inventory request idles the
//   fleet mid-fight; `target_in_band` unknown must read FALSE because a ceiling
//   that defaults open is the one that kills somebody. Those are opposite, both
//   deliberate, and inverting either is a bug no ordinary test would notice.

import { SYMBOLS, SYMBOL_NAMES, evaluate, unknowns, validate, validateAll, MELEE_REACH }
  from './m59-worldstate.mjs';
import { fakeClient } from './m59-fake-client.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

console.log('\nthe registry is well formed');
{
  ok('there are symbols', SYMBOL_NAMES.length > 0);
  for (const [n, s] of Object.entries(SYMBOLS)) {
    ok(`${n} describes itself`, typeof s.describe === 'string' && s.describe.length > 0);
    ok(`${n} has a producer`, typeof s.produce === 'function');
    ok(`${n} states its unknown answer`, typeof s.whenUnknown === 'boolean');
    ok(`${n} says WHY that is the safe direction`,
       typeof s.why_unknown === 'string' && s.why_unknown.length > 0);
  }
}

console.log('\nthe set is closed — a name nobody produces is reported, not dropped');
{
  ok('a known symbol validates', validate({ name: 'a', pre: ['armed'] }).length === 0);
  ok('and so does its negation', validate({ name: 'a', pre: ['!armed'] }).length === 0);

  const bad = validate({ name: 'fight', pre: ['armed', 'has_ammo'], effects: ['target_dead'] });
  ok('an invented precondition is caught', bad.some(p => p.includes('has_ammo')));
  ok('an invented effect is caught too', bad.some(p => p.includes('target_dead')));
  ok('the problem names the action and the symbol',
     bad[0].includes('fight') && bad[0].includes('has_ammo'), bad[0]);
  ok('and it lists what IS known, so the fix is obvious',
     bad[0].includes('armed'), bad[0]);

  ok('validateAll checks a whole action set',
     validateAll([{ name: 'x', pre: ['nope'] }, { name: 'y', effects: ['also_nope'] }]).length === 2);
}

console.log('\nunknown fails SAFE, and safe is per symbol');
{
  // Nothing readable at all: no client, no party, no policy.
  const blind = evaluate({});

  ok('armed unknown reads ARMED — a failed read must not stop a fight',
     blind.armed === true);
  ok('target_in_band unknown reads REFUSE — a ceiling that defaults open kills',
     blind.target_in_band === false);
  ok('has_target unknown reads NO — no evidence of a target is not a target',
     blind.has_target === false);
  ok('in_reach unknown reads NO — swinging at nothing costs us the round',
     blind.in_reach === false);
  ok('hurt unknown reads HURT — costs a rest, the other way costs a death',
     blind.hurt === true);
  // CORRECTED BY THE FIRST LIVE RUN. A real character's vitals() carried health and
  // mana and no vigor at all -- it arrives as a BP_STAT and had not yet -- so this
  // read true on no evidence, the goal was already satisfied, the plan came back
  // EMPTY and a hungry character would never have eaten. Wrong `false` costs a meal;
  // wrong `true` costs a character, at six times the death rate below 85 vigor.
  ok('vigor_ok unknown reads NO — an absent vigor must not satisfy a provisioning goal',
     blind.vigor_ok === false);
  ok('and it fails the OPPOSITE way to armed, which stops a fight already happening',
     blind.armed === true && blind.vigor_ok === false);
  ok('pack_room unknown reads ROOM — refusing to loot on an unread pack is a silent no',
     blind.pack_room === true);
  ok('has_reagents unknown reads NO — do not plan a cast we cannot pay for',
     blind.has_reagents === false);

  ok('has_mana unknown reads NO — do not plan a cast we cannot pay for',
     blind.has_mana === false);
  ok('has_food unknown reads NO — believing in food we cannot see sends a character out hungry',
     blind.has_food === false);

  // The two that must be opposites. If a refactor ever makes these agree, one of
  // them is wrong and it is not obvious which.
  ok('armed and target_in_band fail in OPPOSITE directions, deliberately',
     blind.armed === true && blind.target_in_band === false);
}

console.log('\nunknowns() says what was guessed, so a plan built on nothing can be seen');
{
  const u = unknowns({});
  ok('it reports the symbols it could not answer', u.length > 0);
  ok('each carries what it assumed', u.every(x => typeof x.assumed === 'boolean'));
  ok('and why that was the safe direction', u.every(x => x.why && x.why.length > 0));
  const armed = u.find(x => x.symbol === 'armed');
  ok('armed is among them when there is no client', !!armed && armed.assumed === true);
}

console.log('\nproducers read the pushed state, and get it right');
{
  const mace = fakeClient({ equipped: [{ id: 1, name: 'mace' }], hp: 20, hpMax: 20, vigor: 150 });
  const s = evaluate({ client: mace, policy: {} });
  ok('a wielded mace is armed', s.armed === true);
  ok('full health is healthy', s.healthy === true);
  ok('and not hurt', s.hurt === false);
  ok('150 vigor clears the fight floor of 100', s.vigor_ok === true);
  ok('but cannot be raised further by RESTING — the cap is 80', s.can_rest_higher === false);

  const empty = fakeClient({ equipped: [], hp: 4, hpMax: 20, vigor: 40 });
  const t = evaluate({ client: empty, policy: {} });
  ok('an empty use list is not armed', t.armed === false);
  ok('4 of 20 is hurt', t.hurt === true);
  ok('and not healthy', t.healthy === false);
  ok('40 vigor is under the fight floor', t.vigor_ok === false);
  ok('and CAN still be raised by resting', t.can_rest_higher === true);
}

console.log('\ncastings are min(elderberry, herbs)/2 — never the sum');
{
  const both = fakeClient({ inventory: [{ id: 1, name: 'elderberry', amount: 2 },
                                        { id: 2, name: 'herbs', amount: 2 }] });
  ok('two of each is a casting', evaluate({ client: both }).has_reagents === true);

  // THE MEASURED FAILURE: a fleet rich in one half of the recipe reads as well
  // supplied to anything that sums. 61 elderberry and 160 herbs across twenty-one
  // characters, and twenty of them could cast zero times.
  const lopsided = fakeClient({ inventory: [{ id: 1, name: 'herbs', amount: 94 },
                                            { id: 2, name: 'elderberry', amount: 1 }] });
  ok('NINETY-FOUR HERBS AND ONE ELDERBERRY IS NOT A CASTING',
     evaluate({ client: lopsided }).has_reagents === false);
  ok('and the singular "herb" still counts — the item is named "herbs"',
     evaluate({ client: fakeClient({ inventory: [
       { id: 1, name: 'herb', amount: 4 }, { id: 2, name: 'elderberry', amount: 4 }] })
     }).has_reagents === true);
}

console.log('\nreach is a disc on SQUARE coordinates');
{
  ok('the reach constant is the server\'s own bound', MELEE_REACH === 3);
  const at = (col, row) => {
    const c = fakeClient({ selfId: 1, col: 10, row: 10,
      room: { num: 1, objects: [{ id: 9, name: 'mummy', col, row }] } });
    return evaluate({ client: c, ws: { _targetId: 9 } }).in_reach;
  };
  ok('directly adjacent is in reach', at(11, 10) === true);
  ok('three squares away is still in reach — the disc is radius 3', at(13, 10) === true);
  ok('a diagonal inside the radius counts', at(12, 12) === true);
  ok('four squares away is not', at(14, 10) === false);
  // 28 squares can hit you, not the 8 that touch you. A test that only checked the
  // touching ring would pass while the keeper walked into everything.
  ok('the diagonal corner of the bounding box is OUTSIDE the disc',
     at(13, 13) === false, 'that corner is distance sqrt(18) > 3');
}

console.log('\na target that has left the room is not a target');
{
  const c = fakeClient({ room: { num: 1, objects: [{ id: 9, name: 'mummy', col: 1, row: 1 }] } });
  ok('present means has_target', evaluate({ client: c, ws: { _targetId: 9 } }).has_target === true);
  ok('absent means not', evaluate({ client: c, ws: { _targetId: 77 } }).has_target === false);
  ok('and no selection at all means not', evaluate({ client: c, ws: {} }).has_target === false);
}

console.log('\nthe engagement ceiling, in the vocabulary');
{
  const inBand  = evaluate({ ws: { _targetLevel: 25, _threatCeiling: 30 } });
  const over    = evaluate({ ws: { _targetLevel: 70, _threatCeiling: 30 } });
  ok('a level 25 target under a ceiling of 30 is in band', inBand.target_in_band === true);
  ok('a faction soldier at 70 is not', over.target_in_band === false);
  ok('and an unknown ceiling REFUSES rather than permitting',
     evaluate({ ws: { _targetLevel: 25 } }).target_in_band === false);
  ok('as does an unknown target level',
     evaluate({ ws: { _threatCeiling: 30 } }).target_in_band === false);
}

console.log('\na producer that throws is "cannot tell", never a crash and never a yes');
{
  const exploding = { get equipment() { throw new Error('boom'); } };
  let threw = false;
  let s;
  try { s = evaluate({ client: exploding }); } catch { threw = true; }
  ok('evaluate does not propagate a broken producer', !threw);
  ok('and the symbol falls back to its safe answer, not to true-because-convenient',
     s.armed === SYMBOLS.armed.whenUnknown);
}

console.log('\noutnumbered does not ask a flag that monsters never set');
{
  // OF.ENEMY IS "ENEMY PLAYER" (include/proto.h:405) -- a guild-war relationship the client
  // uses for the colour of a dot on the automap. No monster carries it. This rule was gated
  // on it, so "two or more aggroed creatures" could not become true however many things were
  // hitting the character, and the multi-attacker flee never fired once. JayB was killed by
  // a spider while the postmortem recorded "engaged by 0".
  // Ids well clear of selfId (1), or the "creature" IS us.
  const spiders = [
    { id: 101, name: 'baby spider', col: 6, row: 5, flags: 0 },   // no flags: as the wire has it
    { id: 102, name: 'baby spider', col: 4, row: 5, flags: 0 },
  ];
  const mk = (objects, trail) => {
    const c = fakeClient({ hp: 12, hpMax: 20, col: 5, row: 5,
                           room: { num: 535, name: 'Woods', objects } });
    return evaluate({ client: c, session: { _hpTrail: trail }, policy: {} });
  };

  // Two of them adjacent, health falling: this is the case the rule exists for.
  const gang = mk(spiders, [20, 16, 14, 12]);
  ok('two creatures in reach while health falls IS outnumbered', gang.outnumbered === true,
     JSON.stringify({ outnumbered: gang.outnumbered, under_attack: gang.under_attack }));

  // The same two, health steady: a room with things standing about is not an ambush.
  const idle = mk(spiders, [20, 20, 20, 20]);
  ok('the same two with health steady is NOT outnumbered', idle.outnumbered === false,
     String(idle.outnumbered));

  // One attacker, health falling: under attack, but not outnumbered.
  const solo = mk([spiders[0]], [20, 16, 14, 12]);
  ok('one attacker is under_attack but not outnumbered',
     solo.under_attack === true && solo.outnumbered === false,
     JSON.stringify({ under_attack: solo.under_attack, outnumbered: solo.outnumbered }));

  // AND THE FLAG MUST NOT BE WHAT DECIDES IT. Same geometry, same falling health, flags
  // left at zero exactly as the server sends them -- the rule still has to see the gang.
  ok('the verdict does not depend on any object flag',
     gang.outnumbered === true && spiders.every(o => o.flags === 0));
}

console.log('\ntwo samples are evidence: the first hits must not read as safety');
{
  const mk = trail => evaluate({ client: fakeClient({ hp: 16, hpMax: 20, col: 5, row: 5 }),
                                 session: { _hpTrail: trail }, policy: {} });
  // THE EXACT TRAIL JAYB DIED BEHIND. The trail records health only when it CHANGES, so
  // his first hit gave a trail of length two -- and a rule wanting three said "not under
  // attack". He rested through it. It first read true at 12, too late to walk out on.
  ok('20 -> 16 is already under attack', mk([20, 16]).under_attack === true);
  ok('and so is the fuller trail', mk([20, 16, 12]).under_attack === true);
  // The other direction must stay quiet: healing is not an attack, and one sample says
  // nothing at all.
  ok('a single sample is not evidence of anything', mk([20]).under_attack === false);
  ok('health going UP is not an attack', mk([10, 14]).under_attack === false);
  ok('and a flat trail is not an attack', mk([20, 20, 20]).under_attack === false);
}

console.log('\na flee already under way survives the sample that would have cancelled it');
{
  const mk = (session, roomId = 1) =>
    evaluate({ client: fakeClient({ hp: 15, hpMax: 20, col: 5, row: 5,
                                    room: { num: roomId, name: 'R', objects: [] } }),
               session, policy: {} });
  const soon = Date.now() + 5000, past = Date.now() - 1;

  // JayB fled, regenerated one point between blows, and the rung that started the flee went
  // false: flee -> hunt -> _fight -> flee, and he swung at one of the two things chasing him.
  // hp trail [18,19,20,15,14,15,5,3]; the 14 -> 15 is the tick that unlatched it.
  ok('a live commitment reads as fleeing', mk({ _fleeUntil: soon, _fleeRoom: 1 }).fleeing === true);
  ok('an expired one does not', mk({ _fleeUntil: past, _fleeRoom: 1 }).fleeing === false);
  ok('and no commitment at all does not', mk({}).fleeing === false);

  // A DIFFERENT ROOM IS THE ONLY THING THAT RELIABLY MEANS SAFETY, and it ends the
  // commitment early rather than running out the clock somewhere already safe.
  ok('leaving the room ends the commitment early',
     mk({ _fleeUntil: soon, _fleeRoom: 999 }, 1).fleeing === false);
}

console.log('\nan entombed character must be able to pay the WHOLE price of the blink');
{
  // spell.kod:604 refuses a cast when HasVigor(viSpellExertion) is false, and player.kod's
  // HasVigor wants STRICTLY more than the amount. blink.kod:41 puts that at 20. The refusal
  // is a sentence — "You are too tired to cast %s!" — so nothing fails, mana does not move,
  // and it looks exactly like a cast that was sent and ignored.
  //
  // Lee sat entombed at (28,35) in the Deep Forest of Farol with 19/19 mana and vigor 4,
  // asking for that blink for ever. `unwedge` outranks rest, so he could never earn the
  // vigor to pay for it: a goal above survival that is not achievable outranks survival
  // for ever. Exactly the deadlock the has_mana gate was added for, one price short.
  const mk = vigor => evaluate({ client: fakeClient({ hp: 20, hpMax: 20, vigor }), policy: {} });
  ok('vigor 4 cannot pay for a blink', mk(4).can_pay_blink === false);
  ok('vigor 20 cannot either — HasVigor is strictly greater', mk(20).can_pay_blink === false);
  ok('vigor 21 can', mk(21).can_pay_blink === true);
  ok('and the rest cap of 80 certainly can', mk(80).can_pay_blink === true);

  // The goal must fall through when the price cannot be paid, or the character never rests.
  const { DEFAULT_GOALS: G } = await import('./m59-decide.mjs');
  const unwedge = G.find(g => g.goal === 'unwedge');
  ok('unwedge fires when entombed and able to pay',
     unwedge.when({ entombed: true, has_mana: true, can_pay_blink: true }) === true);
  ok('and stands down when too tired, so rest can win',
     unwedge.when({ entombed: true, has_mana: true, can_pay_blink: false }) === false);
  // An unreadable vital must not be what keeps a body buried.
  ok('unknown ability to pay still tries', 
     unwedge.when({ entombed: true, has_mana: true, can_pay_blink: true }) === true);
}

console.log('\nstarting a fight needs headroom; continuing one does not');
{
  const mk = (hp, policy = {}) => evaluate({ client: fakeClient({ hp, hpMax: 20 }), policy });
  // Every health threshold was a DISENGAGE threshold, and the decision to cross a room and
  // pick a fight was made against the same numbers. With fleeBelow 0.4 and max health 20
  // that let a character close on a fresh giant rat at 9 HP -- and the measured damage rate
  // is 5 to 8 points per sample ([18,19,20,18,14,11,4,5]: 11 to 4 in one). A fight chosen
  // from there is lost before the escape logic is ever consulted.
  ok('9 of 20 is not fit to start a fight', mk(9).fit_to_engage === false);
  ok('12 of 20 is (the default bar is 0.6)', mk(12).fit_to_engage === true);
  ok('and the bar is policy-settable', mk(12, { engageAbove: 0.8 }).fit_to_engage === false);

  const { DEFAULT_GOALS: G } = await import('./m59-decide.mjs');
  const fight = G.find(g => g.goal === '_fight');
  const base = { has_target: true, target_in_band: true, critical: false,
                 hurt: true, vigor_floor: true, _targetElevated: false };
  ok('a hurt character does NOT cross the room for a new fight',
     fight.when({ ...base, fit_to_engage: false, in_reach: false }) === false);
  ok('but it still finishes the one already on it',
     fight.when({ ...base, fit_to_engage: false, in_reach: true }) === true);
  ok('and a healthy one engages freely',
     fight.when({ ...base, fit_to_engage: true, in_reach: false }) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
