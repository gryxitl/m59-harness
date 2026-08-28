#!/usr/bin/env node
// m59-goap-planner.mjs -- A* GOAP planner + GoapExecutor BT node.
//
// plan(actions, initialWs, goal) → { found, steps }
//
// Each action must expose:
//   .pre     string[]   keys that must be truthy in ws before this runs
//   .effects string[]   keys to set; "!key" clears (sets false)
//   .cost    number     optional, defaults to 1
//   .node    BT node    the actual Action to tick during execution
//
// GoapExecutor(actions, goal, opts) → BT Action node
//   Ticks a live plan against the current blackboard world-state.
//   Re-plans automatically when a step fails or the state diverges.

import { Action, SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';

// ---------------------------------------------------------------------------
// World-state helpers
// ---------------------------------------------------------------------------

function applyEffects(ws, effects) {
  const next = { ...ws };
  for (const e of effects) {
    if (e.startsWith('!')) next[e.slice(1)] = false;
    else                   next[e]          = true;
  }
  return next;
}

function satisfies(ws, goal) {
  for (const [k, v] of Object.entries(goal)) {
    // A NEGATED GOAL KEY IS THE SAME BUG THE PRECONDITIONS HAD. `{ '!in_underworld': true }`
    // means "in_underworld must be false", and the effect that achieves it is `!in_underworld`
    // (which sets in_underworld=false, NOT a key called '!in_underworld'). Reading ws['!in_underworld']
    // literally finds undefined, so the goal was never satisfied and the planner reported "no plan"
    // for a character trapped in the Underworld — exactly the preconditionsMet bug, in the goal gate.
    const actual = k.startsWith('!') ? !ws[k.slice(1)] : !!ws[k];
    if (actual !== !!v) return false;
  }
  return true;
}

// A NEGATED PRECONDITION IS A REAL ONE. `!has_food` means "only when there is none",
// and this used to look up ws['!has_food'] -- a key nothing ever sets, so it read
// undefined, so any action guarded that way was permanently unplannable. It was
// silent because relevantKeySet() already strips the "!" when collecting keys: the
// state space was right and only the gate was wrong, so the planner explored
// correctly and then refused every negated action it met, reporting "no plan".
function preconditionsMet(ws, pre) {
  return pre.every(k => (k.startsWith('!') ? !ws[k.slice(1)] : !!ws[k]));
}

function relevantKeySet(actions, goal) {
  const s = new Set(Object.keys(goal));
  for (const a of actions) {
    for (const p of (a.pre     ?? [])) s.add(p.startsWith('!') ? p.slice(1) : p);
    for (const e of (a.effects ?? [])) s.add(e.startsWith('!') ? e.slice(1) : e);
  }
  return [...s].sort();
}

function wsKey(ws, keys) {
  return keys.map(k => `${k}:${ws[k] ? 1 : 0}`).join(',');
}

// ---------------------------------------------------------------------------
// A* planner
// ---------------------------------------------------------------------------

export function plan(actions, initialWs, goal, { maxNodes = 4000 } = {}) {
  const relevantKeys = relevantKeySet(actions, goal);

  if (satisfies(initialWs, goal)) return { found: true, steps: [] };

  // Min-heap via sorted insertion (graph is small — navigation is ~1-20 hops).
  const open    = [];
  const visited = new Map();   // key → best g seen

  function heuristic(ws) {
    let n = 0;
    for (const [k, v] of Object.entries(goal)) {
      const actual = k.startsWith('!') ? !ws[k.slice(1)] : !!ws[k];
      if (actual !== !!v) n++;
    }
    return n;
  }

  function push(node) {
    node.f = node.g + node.h;
    let lo = 0, hi = open.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (open[mid].f <= node.f) lo = mid + 1; else hi = mid;
    }
    open.splice(lo, 0, node);
  }

  push({ ws: initialWs, g: 0, h: heuristic(initialWs), steps: [], f: 0 });

  let explored = 0;
  while (open.length && explored < maxNodes) {
    const cur = open.shift();
    explored++;

    // THE MIN-F HEAP CAM IT THE GOAL REACHED, so this is its g. The outer
    // while loop popped nodes by f = g + h and every node it's already popped
    // was at least as good as any node still open, so the FIRST POP that
    // satisfies the goal is the cheapest satisfying path. This is what
    // "greedy to a random neighbour first" in the inner loop used to get
    // wrong: it returned at the moment a GOAL-MATCHING action was seen, which
    // made the result depend on the order the caller happened to pass the
    // actions in, not on their cost. Reported for the entombed+affordable
    // case where `cast blink` and `escape_pocket` both cure `can_leave` and
    // the two costs differ by 19x.
    if (satisfies(cur.ws, goal)) return { found: true, steps: cur.steps };

    const key = wsKey(cur.ws, relevantKeys);
    const best = visited.get(key);
    if (best !== undefined && best <= cur.g) continue;
    visited.set(key, cur.g);

    for (const action of actions) {
      if (!preconditionsMet(cur.ws, action.pre ?? [])) continue;

      const nextWs  = applyEffects(cur.ws, action.effects ?? []);
      const nextKey = wsKey(nextWs, relevantKeys);
      const g       = cur.g + (action.cost ?? 1);
      const h       = heuristic(nextWs);
      const steps   = [...cur.steps, action.node];

      // NO EARLY RETURN HERE. The action may be the only g-1 or g+10 one that
      // satisfies, and the cheapest satisfying one is the one the POP ORDER says
      // will land next. Pushing keeps that order, and the check above returns
      // at the right moment.
      const prevBest = visited.get(nextKey);
      if (prevBest !== undefined && prevBest <= g) continue;

      push({ ws: nextWs, g, h, steps });
    }
  }

  return { found: false, reason: `exhausted ${explored} nodes without finding a plan` };
}

// ---------------------------------------------------------------------------
// GoapExecutor BT node
//
// Wraps plan() in a BT Action that:
//   1. Plans on first tick (or after a step fails)
//   2. Ticks steps in sequence
//   3. Re-plans if a step fails
//   4. Returns SUCCESS when goal is satisfied, FAILURE when no plan exists
//
// opts:
//   key       string   blackboard slot key (default 'goap_exec')
//   wsSource  fn(bb)   returns the current world-state object; defaults to bb.ws
//   onReplan  fn(plan) called each time a new plan is made (for debugging)
// ---------------------------------------------------------------------------

export function GoapExecutor(actions, goal, {
  key      = 'goap_exec',
  wsSource = null,
  onReplan = null,
} = {}) {
  return new Action((bb, slot) => {
    if (!bb._bt) bb._bt = {};

    const ws = wsSource ? wsSource(bb) : (bb.ws ?? {});

    // Goal already satisfied — done.
    if (satisfies(ws, goal)) {
      delete bb._bt[key];
      return SUCCESS;
    }

    // First entry or re-plan needed.
    if (!slot || slot.phase === undefined || slot.phase === 'plan') {
      const replanCount = slot?.replanCount ?? 0;
      const result = plan(actions, ws, goal);
      if (!result.found) {
        delete bb._bt[key];
        return FAILURE;
      }
      onReplan?.(result.steps);
      slot = { phase: 'execute', stepIdx: 0, steps: result.steps, replanCount: replanCount + 1 };
      bb._bt[key] = slot;
    }

    // Execution phase.
    const { steps, stepIdx } = slot;

    if (stepIdx >= steps.length) {
      // Exhausted the plan without satisfying the goal — replan.
      slot.phase = 'plan';
      return RUNNING;
    }

    const result = steps[stepIdx].tick(bb);

    if (result === RUNNING) return RUNNING;

    if (result === SUCCESS) {
      slot.stepIdx++;
      const freshWs = wsSource ? wsSource(bb) : (bb.ws ?? {});
      if (satisfies(freshWs, goal)) {
        delete bb._bt[key];
        return SUCCESS;
      }
      return RUNNING;
    }

    // Step failed — replan next tick.
    slot.phase = 'plan';
    return RUNNING;
  }, { key, name: 'goap_executor' });
}
