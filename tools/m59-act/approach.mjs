// CLOSE THE GAP WITH THE QUARRY.
//
// The half of fighting that is not swinging. `_fight` used to be one hand-written
// branch that delegated to CombatController.tick(), and the controller's `close` /
// `fight` / `retreat` phase machine made three decisions the goal ladder was already
// making somewhere else:
//
//   close   -> walk toward the mob        == this action, when `in_reach` is false
//   fight   -> swing                      == `attack`, whose pre is `in_reach`
//   retreat -> back off at <= 55% health  == `flee_hurt`, which OUTRANKS `_fight`
//
// Two retreat rules that did not agree is the worst of those: the ladder ran at
// `below_flee` and the controller at a hardcoded 55%, so which one fired depended on
// which number was crossed first, and the controller's version backed away one square
// at a time from a mob that simply followed. Naming the state (`!has_target` — the
// quarry is gone) lets the planner sequence approach and swing, and lets the ladder
// keep the survival decision it already owned.
//
// See docs/m59-goap-repayment.md, phase 3.

/**
 * Walk toward the selected target.
 *
 * The MOVEMENT is the controller's — it owns the mover aim, the fine-walkable
 * retarget when the quarry stands on an unpathable square, the no-route blacklist,
 * and `_standStill`. What moved into the planner is the DECISION to close rather
 * than swing. This action is the seam between the two.
 */
export async function approachTarget(client, session, { targetId = null } = {}) {
  const id = targetId ?? session?._ws?._targetId ?? null;
  if (id == null) return { sent: false, reason: 'no target to approach' };
  return { sent: true, what: `approach ${id}` };
}
// `has_target` only. Reachability is NOT a precondition here: whether a path exists is
// the mover's finding, not the planner's, and it arrives as `session._moverNoRoute`
// after an attempt. Gating on a symbol the planner cannot produce before trying is what
// deadlocked `hunt` when `route_reachable` was made a goal precondition.
approachTarget.pre     = ['has_target'];
approachTarget.effects = ['in_reach'];
approachTarget.atomic  = 'approach_target';
