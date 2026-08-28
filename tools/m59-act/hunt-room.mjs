// TRAVEL TO THE ROOM WE HUNT IN, AND TAKE A TARGET ONCE WE ARE THERE.
//
// The two halves of what `hunt` used to do in one hand-written branch. Splitting them
// into planner actions is what lets the goal `has_target` be PLANNED — and therefore what
// lets it be refused when it cannot be reached, instead of re-issued for ever. See
// docs/m59-goap-repayment.md.
//
// The room CHOICE is not planning and does not live here: `huntRoomFor` is policy
// (assigned room first, else the nearest room whose prey is under the engagement ceiling)
// and is called at EXECUTION time, because the right room depends on where the body is by
// then. What the planner decides is whether travelling is the thing to do at all.
import { nearestHuntRoom } from '../m59-hunt-room.mjs';

/**
 * Which room this character should be hunting in, or null if we cannot tell.
 * Policy, not planning: an explicit assignment wins, then the nearest room whose prey is
 * inside the engagement ceiling.
 */
export function huntRoomFor(session, { policy = {}, ws = {}, here = null, ceiling = null } = {}) {
  const assigned = policy?.assignedRoom;
  if (assigned != null && Number.isFinite(Number(assigned)) && Number(assigned) > 0) {
    return Number(assigned);
  }
  if (here == null || ceiling == null) return null;
  try {
    const r = nearestHuntRoom(here, ceiling);
    return r?.room ?? null;
  } catch { return null; }
}

// TRAVEL. Its precondition is the one that was missing for a day: a leg whose staging
// square the body cannot reach makes this unplannable rather than merely unsuccessful.
export async function travelToHuntRoom(client, session, { room = null } = {}) {
  const router = session?._router;
  if (!router) return { sent: false, reason: 'no router' };
  const dest = room ?? session?._huntRoomWanted ?? null;
  if (dest == null) return { sent: false, reason: 'no hunt room chosen' };
  if (router.dest !== dest) router.to(dest);
  return { sent: true, what: `travel to hunt room ${dest}` };
}
travelToHuntRoom.pre     = ['route_reachable'];
travelToHuntRoom.effects = ['in_hunt_room'];
travelToHuntRoom.atomic  = 'travel_to_hunt_room';

// ACQUIRE. Standing in the right room is not the same as having something to fight; this
// is the step that turns one into the other, and its precondition is being there.
export async function acquireTarget(client, session) {
  // The decider's own target selection already runs each tick from room contents; this
  // action exists so the PLANNER can express "being in the room comes before having a
  // target", which is what makes the sequence refusable at the travel step.
  return { sent: false, reason: 'waiting for a target to appear' };
}
acquireTarget.pre     = ['in_hunt_room'];
acquireTarget.effects = ['has_target'];
acquireTarget.atomic  = 'acquire_target';
