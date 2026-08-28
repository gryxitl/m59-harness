#!/usr/bin/env node
// m59-plan.mjs -- WHAT THIS CHARACTER CAN DO, AND A PLAN OVER IT.
//
// The join between three pieces that were each built to be useless alone:
//
//   m59-act/*          atomics -- one bounded, honest thing each, over (client, session)
//   m59-worldstate     the closed vocabulary, one producer per symbol
//   m59-goap-planner   A* over pre/effects
//
// TWO THINGS HAPPEN HERE THAT ARE THE POINT OF THE WHOLE DESIGN.
//
// 1. THE ACTION SET IS BUILT FROM WHAT THE CHARACTER ACTUALLY HAS. A character that
//    has not learned `create food` gets no cast-create-food action, so no plan can
//    contain one -- not discouraged, absent. Same for every other grounded action.
//    This is how the game itself behaves (an unlearnable skill is missing from the
//    merchant's offer list, monster.kod:4855, rather than refused), and it is the
//    mechanism the plan document calls survival-as-preconditions: a rule expressed
//    as a missing action or an unmet precondition cannot be outbid, where the same
//    rule expressed as a cost can.
//
// 2. THE ACTION SET IS VALIDATED BEFORE THE SEARCH RUNS. Every pre and effect must
//    be a symbol m59-worldstate actually produces. Without that check a typo makes
//    a plan quietly unsatisfiable and the planner can only report "no plan found",
//    which is indistinguishable from "this character genuinely cannot do it". With
//    it, the typo is named. That distinction is the difference between a five-minute
//    fix and the failure mode this repository already lived through once, when
//    policy.purpose sat outside a schema for a year with the yield audit switched
//    off behind it.

import { evaluate, unknowns, validateAll } from './m59-worldstate.mjs';
import { plan as astar } from './m59-goap-planner.mjs';
import { costOf } from './m59-cost.mjs';

import { attack, attackOf }       from './m59-act/attack.mjs';
import { approachTarget }         from './m59-act/approach.mjs';
import { step }          from './m59-act/step.mjs';
import { equipBest }              from './m59-act/equip.mjs';
import { rest, stand }   from './m59-act/rest.mjs';
import { eatSomething }           from './m59-act/eat.mjs';
import { buy }           from './m59-act/buy.mjs';
import { sellOf }                 from './m59-act/sell.mjs';
import { pickUp as pickup } from './m59-act/pickup.mjs';
import { drop }          from './m59-act/drop.mjs';
import { deposit, withdraw } from './m59-act/bank.mjs';
import travelTo      from './m59-act/travel-to.mjs';
import { travelToHuntRoom, acquireTarget } from './m59-act/hunt-room.mjs';
import { escapePocket } from './m59-act/escape-pocket.mjs';
import { groundedCasts } from './m59-act/cast.mjs';

// The atomics that are always available -- they need no per-character grounding.
// `step` is deliberately absent: a route is planned by upstream's router (baked
// exit-to-exit paths, planned on the map the mover enforces) and executed a hop at a
// time. Putting a bare `step` in the action set would invite the planner to
// rediscover pathfinding one square at a time, badly.
//
// buy, sell, travel_to are included because they have vocabulary preconditions
// (has_money, at_shop) that let the planner reason about WHEN to use them.
// The per-item specifics (which item, which merchant) are handled inside the
// atomic; the planner only decides that buying is the right KIND of action.
// EVERY ACTION IN THE SET BINDS ITS OWN TARGET. `stepPlan` calls a step with no args
// -- a plan is a sequence of symbols, not of object ids -- so an atomic that requires
// an id refused `{sent:false, reason:'no item'}` on every call while remaining a
// perfectly attractive step to the planner. Live: 1,105 consecutive passes, all
// ACTION=equip, on a character holding a mace it never put in its hand.
//
// The bound forms resolve their target AT EXECUTION TIME, against the pack and room as
// they are by then -- never at plan time, because the object a step needs is often made
// by an earlier step (`cast create food -> eat` is the canonical one) and an action that
// vanishes when the pack is empty cannot be sequenced after the thing that fills it.
// What makes an impossible action impossible is its PRECONDITION; that is what `pre`
// is for.
// ORDER MATTERS WHEN TWO ACTIONS ACHIEVE THE SAME SYMBOL AT EQUAL COST. The A*
// breaks ties by insertion order, so the first matching action in this array wins.
// `equipBest` is before `buy` on purpose: when a character already has a weapon in
// its pack (JayB, holding a mace), the `armed` goal's plan should be EQUIP what he
// has, not BUY another one (which spends gold for a duplicate and, worse, left the
// character unable to act when there was no buy intent in the tick decider). Buying
// is only right when the pack is empty; `equipBest` returns {sent:false, no weapon}
// in that case and the planner falls through to `buy` on the next plan.
// `travelTo` is LAST, and it is here at all because nothing else produces `at_shop`.
//
// It was imported into this file, given `pre: []`, `effects: ['at_shop']` and a comment
// beginning "THE PLANNER USES IT LIKE THIS" -- and then left out of this array, so the
// planner never had it. `buy.pre` is ['has_money', 'at_shop'] and `sell.pre` is
// ['at_shop', 'has_loot'], so with no way to REACH a shop, every plan that needed one was
// unreachable: the search expanded `equip` (refused, nothing to wield) and `buy` (refused,
// not at a shop) and stopped.
//
// Lee, 2026-08-27: no weapon, 77 shillings, no `create weapon` in his spell list —
// `armed — exhausted 2 nodes without finding a plan`, over and over, while standing in a
// hunt room with the money to buy one. The chain the planner can now find is
// travel_to -> buy -> armed.
//
// Last in the array on purpose: ties break by insertion order, so anything that can be
// done where the character already stands is preferred over walking somewhere.
// `travelToHuntRoom` and `acquireTarget` are the two halves of what the `hunt` handler
// used to do procedurally. They are here so the goal `has_target` can be PLANNED, which
// is what makes it refusable: travel carries `route_reachable` as a precondition, so a
// hunt whose room cannot be reached produces no plan instead of being re-issued for ever.
// See docs/m59-goap-repayment.md, phase 2. They sit before `travelTo`, the generic
// last-resort walk, because a named destination beats "keep moving and hope".
const ALWAYS = [rest, stand, equipBest, buy, eatSomething,
                travelToHuntRoom, acquireTarget, escapePocket, travelTo,
                // `approach_target` is what makes `in_reach` achievable, and so what
                // makes the goal `!has_target` plannable from across the room instead
                // of only from inside melee. Without it the planner can express
                // "swing" and never "walk up to it and then swing".
                approachTarget];

/**
 * actionsFor(client) -> [action]
 *
 * Every atomic this character can actually perform right now, grounded. Each carries
 * `pre`, `effects`, `atomic`, and `node` (the callable), which is the shape
 * m59-goap-planner expects.
 */
export function actionsFor(client, { extra = [], costCtx = {}, ws = {}, isTrusted = null, filter = null } = {}) {
  const all = [
    ...ALWAYS,
    // attack takes its id from the SAME ws the ceiling was checked against, and sell
    // needs the caller's trusted-buyer test -- neither has a safe default.
    attackOf(ws),
    sellOf({ isTrusted }),
    ...groundedCasts(client),
    ...extra,
  ];
  // Optional filter: remove atomics by name. Used by the GOAP keeper to
  // prevent the planner from picking `rest` when a hostile is present
  // (it should use `recover` instead, which includes fleeing).
  const filtered = filter ? all.filter(fn => !filter.has(fn.atomic)) : all;
  return filtered.map(fn => ({
    name: fn.atomic,
    pre: fn.pre ?? [],
    effects: fn.effects ?? [],
    cost: fn.cost ?? costOf(fn, costCtx),
    node: fn,          // the callable atomic: (client, session, args)
    run: fn,
  }));
}

/**
 * planFor(client, goal, opts) -> {
 *   found, steps, names, ws, assumed, problems, reason
 * }
 *
 * `goal` is a plain object of symbol -> boolean, e.g. { vigor_ok: true }.
 *
 * `problems` is non-empty ONLY when the action set names something outside the
 * vocabulary, and in that case NO PLAN IS ATTEMPTED -- a search over a broken action
 * set produces a confident "no plan" for the wrong reason.
 *
 * `assumed` lists the symbols that could not be read and what they fell back to.
 * A plan built entirely on fallbacks is a plan built on no evidence, and today that
 * is invisible: it looks exactly like a confident one. Callers should surface it.
 */
export function planFor(client, goal, { session = null, policy = {}, agent = null,
                                        ws: wsIn = null, extra = [], costCtx = {},
                                        isTrusted = null, filter = null } = {}) {
  // WORLD STATE IS READ BEFORE THE ACTION SET IS BUILT, and the order matters: the
  // target `attack` grounds on is `ws._targetId`, the same one `in_reach` and
  // `target_in_band` are produced from. Building actions first meant grounding against
  // a target the ceiling had not been checked against.
  const ctx = { client, session, policy, agent, ws: wsIn ?? {} };
  const ws  = { ...evaluate(ctx), ...(wsIn ?? {}) };

  const actions  = actionsFor(client, { extra, costCtx, ws, isTrusted, filter });
  const problems = validateAll(actions);
  if (problems.length)
    return { found: false, problems, reason: 'the action set names symbols nothing produces' };

  const out = astar(actions, ws, goal);
  // astar returns `steps` as the collected `node`s; map back to names so a caller
  // can report a plan without executing it. A plan you cannot read is a plan you
  // cannot argue with.
  const names = (out.steps ?? []).map(n => n?.atomic ?? n?.name ?? 'step');

  return {
    ...out,
    names,
    ws,
    assumed: unknowns(ctx),
    problems: [],
  };
}

/**
 * A plan is a claim about a world that will hold still, and this one will not. So
 * execution is one step at a time with a re-read between each -- the caller decides
 * whether to continue, which is what makes the whole thing interruptible.
 *
 * Deliberately NOT a loop that runs a plan to completion: that would be exactly the
 * unbounded await the atomics were built to avoid, and 82% of deaths in this fleet
 * happened while the keeper was blind inside one.
 */
/**
 * DID THE WORLD ACTUALLY MOVE? One definition, here, because the caller that had its
 * own got it exactly backwards.
 *
 * m59-keeper-goap.mjs read `result.sent` off the WRAPPER stepPlan returns, where the
 * atomic's own answer is nested under `.result`. `undefined !== false` is true, so
 * every refusal in the world read as a success -- and the keeper then called
 * `progress()` on it, which satisfied the stall detector. That is how a character
 * repeated one impossible step 1,105 times while every instrument reported it healthy.
 *
 * The atomics are honest and say so in four different words depending on what they do:
 * `sent:false` is "I did not even send it", `changed:false` is "I sent it and the
 * server declined out loud" (equip's use list not moving), and buy/sell report
 * `bought`/`sold`. ANY of them being explicitly false is a refusal. Nothing here
 * guesses: a field that is absent is not evidence of anything and is ignored.
 */
export function didAct(result) {
  if (!result || typeof result !== 'object') return false;
  for (const k of ['sent', 'changed', 'bought', 'sold'])
    if (result[k] === false) return false;
  return true;
}

export async function stepPlan(client, session, planned, { index = 0, args = {} } = {}) {
  const node = planned?.steps?.[index];
  if (!node) return { done: true, index, acted: false, result: null, reason: 'plan exhausted' };
  const result = await node(client, session, args);
  // `acted` and `reason` are hoisted onto the wrapper deliberately. The nesting is
  // what the caller got wrong, and a caller that has to reach two levels down to find
  // out whether anything happened is a caller that will one day forget to.
  return { done: false, index: index + 1, action: node.atomic ?? null, result,
           acted: didAct(result), reason: result?.reason ?? null };
}
