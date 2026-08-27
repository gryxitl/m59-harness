#!/usr/bin/env node
// m59-plan-test.mjs -- THE JOIN: atomics + vocabulary + A*, and what it REFUSES.
//
// Offline, no server:  node tools/m59-plan-test.mjs
//
// The plans this produces are less interesting than the plans it cannot produce.
// A planner that finds a route to every goal is a planner that will walk a
// character into a faction soldier, and the whole argument of
// docs/keeper-rebuild-plan.md §2 is that survival belongs in preconditions --
// where it cannot be outbid -- rather than in costs, where it can.
//
// So the assertions below come in pairs: the plan that should exist, and the one
// that must not.

import { fakeClient, fakeSession } from './m59-fake-client.mjs';
import { evaluate } from './m59-worldstate.mjs';
import { planFor, actionsFor, stepPlan } from './m59-plan.mjs';
import { plan as astar } from './m59-goap-planner.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const REAGENTS = [{ id: 1, name: 'elderberry', amount: 4 }, { id: 2, name: 'herbs', amount: 4 }];
const hungryCaster = (over = {}) => fakeClient({
  spells: ['create food'], mana: 30, vigor: 40, inventory: REAGENTS, ...over });

const namesOf = (c, goal, opts = {}) => {
  const p = planFor(c, goal, { policy: {}, ...opts });
  return p.found ? p.names.join(' -> ') : null;
};

console.log('\nthe supply chain is DERIVED, not written down');
{
  // has_reagents + has_mana -> cast -> has_food -> eat -> vigor_ok.
  // Nothing anywhere says "cast then eat"; A* finds it from pre/effects alone.
  ok('a hungry caster with reagents plans cast then eat',
     namesOf(hungryCaster(), { vigor_ok: true }) === 'cast create food -> eat');

  ok('with food already in the pack it just eats — the shorter plan wins',
     namesOf(fakeClient({ spells: [], mana: 30, vigor: 40,
                          inventory: [{ id: 5, name: 'bread' }] }), { vigor_ok: true }) === 'eat');

  ok('a goal already satisfied plans nothing at all',
     namesOf(hungryCaster({ vigor: 180 }), { vigor_ok: true }) === '');
}

console.log('\nAND THE PLANS IT REFUSES — each is a rule that cannot be outbid');
{
  // 1. THE SPELL IS NOT KNOWN. Not refused at plan time -- ABSENT. groundedCasts
  //    builds actions only for spells the character holds, so no plan can contain
  //    one. Same shape as the game: an unlearnable skill is missing from the offer
  //    list rather than declined.
  ok('a character who never learned the spell cannot plan a meal out of thin air',
     namesOf(hungryCaster({ spells: [] }), { vigor_ok: true }) === null);

  // 2. THE RECIPE IS min(elderberry, herbs), NEVER THE SUM. The measured failure:
  //    61 elderberry and 160 herbs across twenty-one characters, twenty of whom
  //    could cast zero times, because the herb-rich stood beside the elderberry-rich.
  ok('NINETY-FOUR HERBS AND ONE ELDERBERRY PLANS NOTHING',
     namesOf(hungryCaster({ inventory: [{ id: 1, name: 'herbs', amount: 94 },
                                        { id: 2, name: 'elderberry', amount: 1 }] }),
             { vigor_ok: true }) === null);

  // 3. Mana is a precondition, so no amount of wanting the goal invents it.
  ok('no mana, no plan', namesOf(hungryCaster({ mana: 2 }), { vigor_ok: true }) === null);

  // 4. THE ENGAGEMENT CEILING. attack.pre carries target_in_band, so a planner
  //    asked to remove a faction soldier CANNOT produce a swing at it. This is the
  //    §2 invariant in its most load-bearing instance: as a cost, a big enough
  //    reward outbids it; as a precondition, no valid plan exists.
  const soldier = fakeClient({
    equipped: [{ id: 5, name: 'mace' }], selfId: 1, col: 10, row: 10,
    room: { num: 1, objects: [{ id: 9, name: 'soldier', col: 11, row: 10 }] } });
  ok('a target ABOVE the ceiling cannot be planned into a swing',
     namesOf(soldier, { has_target: false },
             { ws: { _targetId: 9, _targetLevel: 70, _threatCeiling: 30 } }) === null);
  ok('and the same target UNDER the ceiling can',
     namesOf(soldier, { has_target: false },
             { ws: { _targetId: 9, _targetLevel: 25, _threatCeiling: 30 } }) === 'attack');
}

console.log('\nthe action set is checked BEFORE the search, so a typo is named');
{
  // Without this, a mistyped symbol makes the goal unreachable and the planner can
  // only say "no plan found" -- indistinguishable from a character that genuinely
  // cannot do it. That ambiguity is how policy.purpose stayed broken for a year.
  const typo = (c, s) => ({}); typo.pre = ['has_manna']; typo.effects = ['vigor_ok'];
  typo.atomic = 'typo';
  const p = planFor(hungryCaster(), { vigor_ok: true }, { policy: {}, extra: [typo] });
  ok('planning is refused outright', p.found === false);
  ok('and the offending symbol is named', p.problems.some(x => x.includes('has_manna')),
     JSON.stringify(p.problems).slice(0, 90));
  ok('with the known set listed beside it', p.problems[0].includes('has_mana'));
  ok('and the reason says it is the ACTION SET, not the character',
     /action set/.test(p.reason), p.reason);
}

console.log('\na plan built on guesses is reported as such');
{
  // Every symbol that could not be read falls back to its safe direction. A plan
  // over fallbacks looks exactly like a confident one, so it has to be surfaced.
  const p = planFor(hungryCaster(), { vigor_ok: true }, { policy: {} });
  ok('assumed lists what could not be answered', Array.isArray(p.assumed));
  ok('each entry says what it fell back to and why',
     p.assumed.every(a => typeof a.assumed === 'boolean' && a.why));
  ok('the world state it planned against is returned, so the plan can be argued with',
     typeof p.ws === 'object' && 'has_reagents' in p.ws);
}

console.log('\na negated precondition is a real one');
{
  // This was broken in the planner: `!key` was looked up as the literal key '!key',
  // which nothing sets, so any action guarded that way was permanently unplannable
  // -- silently, because relevantKeySet() already stripped the "!" so the state
  // space was right and only the gate was wrong.
  const A = () => ({}); A.pre = []; A.effects = ['has_food']; A.atomic = 'A';
  const B = () => ({}); B.pre = ['!has_food']; B.effects = ['vigor_ok']; B.atomic = 'B';
  const mk = f => ({ name: f.atomic, pre: f.pre, effects: f.effects, node: f });

  const runnable = astar([mk(B)], { has_food: false }, { vigor_ok: true });
  ok('an action gated on !x runs when x is false', runnable.found === true);

  const blocked = astar([mk(B)], { has_food: true }, { vigor_ok: true });
  ok('and is correctly refused when x is true', blocked.found === false);

  // THE SAME BUG IN THE GOAL GATE. A negated goal key ('!in_underworld': true) means the
  // underlying symbol must be false, and the effect that achieves it is '!in_underworld'
  // (which sets in_underworld=false, not a key called '!in_underworld'). Reading the goal
  // key literally finds undefined, so the goal was never satisfied and a character trapped
  // in the Underworld got "no plan" for an action that was right there. Verify the plan
  // is found when the negated goal is achievable, and refused when it is not.
  const Esc = () => ({}); Esc.pre = ['in_underworld']; Esc.effects = ['!in_underworld']; Esc.atomic = 'escape';
  const esc = astar([mk(Esc)], { in_underworld: true }, { '!in_underworld': true });
  ok('a negated goal is satisfied by the matching negated effect', esc.found === true);
  const escDone = astar([mk(Esc)], { in_underworld: false }, { '!in_underworld': true });
  ok('and is already satisfied when the symbol is false', escDone.found === true && escDone.steps.length === 0);
  const escStuck = astar([mk(Esc)], { in_underworld: true }, { in_underworld: false });
  // The goal { in_underworld: false } is achievable (escape sets it false), so this is found.
  // A genuinely unplannable goal: a symbol no action can produce.
  const escImpossible = astar([mk(Esc)], { in_underworld: true }, { at_shop: true });
  ok('a goal no action can produce is refused', escImpossible.found === false);
}

console.log('\nexecution is one step at a time, never a loop');
{
  // A plan is a claim about a world that will not hold still. Running one to
  // completion inside a single call is exactly the unbounded await the atomics were
  // built to avoid -- 82% of deaths had the keeper blind inside one.
  const c = hungryCaster();
  const s = fakeSession(c);
  const p = planFor(c, { vigor_ok: true }, { policy: {} });
  ok('the plan has two steps', p.steps.length === 2);

  const first = await stepPlan(c, s, p, { index: 0 });
  ok('one call advances exactly one step', first.index === 1 && first.done === false);
  ok('and it was the cast', first.action === 'cast create food', String(first.action));
  ok('only that one packet went out',
     c.sent.filter(x => x[0] === 'cast').length === 1 &&
     c.sent.filter(x => x[0] === 'apply').length === 0, JSON.stringify(c.sent));

  const done = await stepPlan(c, s, p, { index: 2 });
  ok('running off the end reports done rather than throwing', done.done === true);
}

console.log('\nthe action set is what the character HAS, not what exists');
{
  ok('a caster gets its cast action',
     actionsFor(hungryCaster()).some(a => a.name === 'cast create food'));
  ok('a non-caster does not',
     !actionsFor(fakeClient({ spells: [] })).some(a => String(a.name).startsWith('cast')));
  ok('every action carries a callable node',
     actionsFor(hungryCaster()).every(a => typeof a.node === 'function'));
}

// EQUIPPING NEEDS SOMETHING TO EQUIP.
//
// `equipBest` declared NO precondition, so the planner treated "put a weapon in your hand"
// as an action that always works. With an empty pack it is the cheapest thing producing
// `armed`, so it won every plan, did nothing, and was planned again on the next tick --
// while `cast create weapon`, which the character knew and could pay for, was never
// reached. Sasquatch, 2026-08-27: nine hours, zero kills, `armed -> buy` / `buy in flight`
// alternating in his log once `buy` was reachable and `equip` once it was not.
{
  const mk = (inv, spells, mana) => ({
    inventory: inv, inventoryKnown: true, spells,
    equipment: () => ({ known: true, equipped: [] }),
    vitals: () => ({ health: { value: 20, max: 20 }, mana: { value: mana, max: 21 },
                     vigor: { value: 76 } }),
    room: { num: 150, objects: new Map() } });
  const cw = [{ name: 'create weapon' }];
  const plan = (client) => {
    const ws = evaluate({ client, policy: {}, session: { world: { room: { num: 150 } } } });
    const p = planFor(client, { armed: true },
                      { session: { world: { room: { num: 150 } } }, policy: {}, ws });
    return p.found ? p.names : null;
  };

  ok('a weapon in the pack is equipped',
     JSON.stringify(plan(mk([{ name: 'mace' }], cw, 21))) === JSON.stringify(['equip']));
  ok('an empty pack conjures instead of equipping nothing',
     JSON.stringify(plan(mk([], cw, 21))) === JSON.stringify(['cast create weapon']));
  ok('and empty-handed with no spell and no money has no plan at all -- fists',
     plan(mk([], [], 21)) === null);
  ok('the conjure is still gated on being able to pay for it',
     plan(mk([], cw, 3)) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
