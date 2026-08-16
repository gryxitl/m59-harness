#!/usr/bin/env node
// m59-bt-walk.mjs -- GOAP in-room navigation: plan a path on the grid, execute step by step.
//
// Exports:
//   StepAction(col, row)          atomic: send one paced BP_REQ_MOVE to (col, row)
//   walkActions(geo, fromR, fromC, toR, toC)  build action set from geo.neighbors()
//   WalkTo(col, row, opts)        GoapExecutor wired for in-room grid navigation

import { Action, SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';
import { GoapExecutor, plan }                from './m59-goap-planner.mjs';

// Square key used in world-state: at_sq_<row>_<col>
const sqKey = (row, col) => `at_sq_${row}_${col}`;

// ---------------------------------------------------------------------------
// StepAction(col, row)
//
// Sends one paced step to (col, row) via s.step(col, row).
// Confirms arrival by checking c.self.col/row after the step.
//
// Pre:     at_sq_<fromRow>_<fromCol>   (enforced by planner ordering)
// Effects: at_sq_<row>_<col>, !at_sq_<fromRow>_<fromCol>
//          (fromRow/fromCol are set by the planner on the action, not the factory)
// ---------------------------------------------------------------------------
export function StepAction(col, row) {
  const key = `at_step_${row}_${col}`;

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;

      const s = bb.session?.s ?? null;
      const c = s?.client ?? null;
      if (!s || !c) { slot.ok = false; slot.done = true; return RUNNING; }

      // Capture from-square before the step so we can clear its ws key.
      const me = c.self;
      const fromRow = me?.row ?? null;
      const fromCol = me?.col ?? null;

      Promise.resolve()
        .then(async () => {
          const r = await s.step(col, row).catch(() => null);
          // step() predicts position via c.predictSelf(); read it back.
          const after = c.self;
          const arrived = after?.col === col && after?.row === row;
          return { arrived, fromRow, fromCol };
        })
        .then(({ arrived, fromRow, fromCol }) => {
          const ws = bb.ws ?? (bb.ws = {});
          if (arrived) {
            ws[sqKey(row, col)] = true;
            if (fromRow != null) ws[sqKey(fromRow, fromCol)] = false;
          }
          slot.ok = arrived;
          slot.done = true;
        })
        .catch(() => { slot.done = true; });

      return RUNNING;
    }

    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: `step_${row}_${col}` });

  // pre/effects are set by walkActions() when it binds the from-square.
  node.pre     = [];
  node.effects = [sqKey(row, col)];
  return node;
}

// ---------------------------------------------------------------------------
// walkActions(geo, fromRow, fromCol, toRow, toCol)
//
// Builds the minimal action set needed to plan a path from (fromRow,fromCol)
// to (toRow,toCol) using the geometry grid.
//
// Strategy: run geo.path() to get the shortest route, then for each step
// emit one action with the correct pre/effects chaining. This keeps the
// action set small (O(steps)) instead of enumerating the whole grid.
//
// Returns { actions, route } or { actions: [], route: null } if no path.
// ---------------------------------------------------------------------------
export function walkActions(geo, fromRow, fromCol, toRow, toCol) {
  if (!geo) return { actions: [], route: null };

  const result = geo.path(fromRow, fromCol, toRow, toCol);
  if (!result.found) return { actions: [], route: null };

  const route = [
    { row: fromRow, col: fromCol },
    ...result.steps,
  ];

  const actions = [];
  for (let i = 0; i < route.length - 1; i++) {
    const from = route[i];
    const to   = route[i + 1];
    const node = StepAction(to.col, to.row);
    node.pre     = [sqKey(from.row, from.col)];
    node.effects = [sqKey(to.row, to.col), `!${sqKey(from.row, from.col)}`];
    node.cost    = to.diagonal ? Math.SQRT2 : 1;
    actions.push({ pre: node.pre, effects: node.effects, cost: node.cost, node });
  }

  return { actions, route };
}

// ---------------------------------------------------------------------------
// WalkTo(col, row, opts) — BT Action for in-room grid navigation.
//
// Plans the route with geo.path() on first tick, then ticks each StepAction
// in sequence. Re-plans from the current position if a step fails (e.g. a
// monster walked into the path). Returns FAILURE immediately if no path
// exists (goal is a wall or the room has no route).
//
// opts:
//   key       string   blackboard slot key (default 'walk_to_R_C')
//   maxReplans number  how many times to re-plan on step failure (default 3)
// ---------------------------------------------------------------------------
export function WalkTo(col, row, opts = {}) {
  const key        = opts.key        ?? `walk_to_${row}_${col}`;
  const maxReplans = opts.maxReplans ?? 3;

  return new Action((bb, slot) => {
    if (!bb._bt) bb._bt = {};

    // Check goal first — may already be there.
    const c   = bb.session?.s?.client ?? null;
    const geo = bb.session?.s?.world?.geometry ?? null;
    const me  = c?.self;
    if (me?.col === col && me?.row === row) {
      delete bb._bt[key];
      if (bb.ws) bb.ws[sqKey(row, col)] = true;
      return SUCCESS;
    }

    // First entry or re-plan after step failure.
    if (!slot || slot.phase === 'plan') {
      if (!c || !geo || !me) return FAILURE;

      const replans = slot?.replans ?? 0;
      if (replans > maxReplans) { delete bb._bt[key]; return FAILURE; }

      const { actions } = walkActions(geo, me.row, me.col, row, col);
      if (!actions.length) { delete bb._bt[key]; return FAILURE; }

      slot = { phase: 'walk', stepIdx: 0, steps: actions.map(a => a.node), replans };
      bb._bt[key] = slot;
    }

    // Execution.
    if (slot.stepIdx >= slot.steps.length) {
      // Exhausted plan — replan from current position.
      slot.phase   = 'plan';
      slot.replans = (slot.replans ?? 0) + 1;
      return RUNNING;
    }

    const result = slot.steps[slot.stepIdx].tick(bb);
    if (result === RUNNING) return RUNNING;

    if (result === SUCCESS) {
      slot.stepIdx++;
      // Check goal after each step.
      const after = c?.self;
      if (after?.col === col && after?.row === row) {
        delete bb._bt[key];
        if (bb.ws) bb.ws[sqKey(row, col)] = true;
        return SUCCESS;
      }
      return RUNNING;
    }

    // Step failed — replan.
    slot.phase   = 'plan';
    slot.replans = (slot.replans ?? 0) + 1;
    return RUNNING;
  }, { key, name: `walk_to_${row}_${col}` });
}
