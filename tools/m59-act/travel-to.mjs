#!/usr/bin/env node
// m59-act/travel-to.mjs -- THE TRAVEL-TO ATOMIC. One room hop toward a
// destination. Not pathfinding, not a route: a single exit request.
//
// WHY ONE HOP: the planner is room-local. It cannot plan a multi-room
// route because the route depends on the map, the character's position,
// and the exits available in each room — state the 16-symbol vocabulary
// does not model. The legacy router (m59-map.mjs) handles the route;
// this atomic is one step of it.
//
// THE PLANNER USES IT LIKE THIS:
//   goal: at_shop (a merchant is in the current room)
//   pre:  !at_shop
//   effects: at_shop  (optimistic: the next room might have a shop)
//
// In practice the planner will use travel_to as a "keep moving" step
// when no other action is available. The legacy router decides WHICH
// exit to take; the planner decides WHETHER to travel at all.
//
// CONTRACT: (client, session, opts) -> { sent, reason }
//   - opts.to: the destination room number (required)
//   - opts.via: a specific exit to use (optional; the router picks one)
//   - refuses when already at the destination
//   - refuses when there is no route (the map doesn't know the way)
//   - sends at most one exit request per call

/**
 * @param {object} client  - the M59Client
 * @param {object} session - the broker session (has .travelToRoom)
 * @param {object} opts
 * @param {number} opts.to - the destination room number
 * @param {object} [opts.via] - a specific exit object (optional)
 */
export default function travelTo(client, session, opts = {}) {
  const to = opts.to;
  if (!Number.isFinite(to) || to <= 0)
    return { sent: false, reason: 'no destination given' };

  const here = client?.room?.num;
  if (here == null)
    return { sent: false, reason: 'unknown current room' };

  if (here === to)
    return { sent: false, reason: `already at room ${to}` };

  // Use the session's travel method if available. The broker session has
  // travelToRoom which handles the route planning and exit requests.
  if (session && typeof session.travelToRoom === 'function') {
    const r = session.travelToRoom(to, opts.via);
    if (r && r.sent === false)
      return { sent: false, reason: r.reason ?? 'travel refused' };
    return { sent: true, reason: null };
  }

  // Fallback: the session doesn't have travelToRoom. This is the case
  // for the standalone goap-run (no broker session). Refuse rather
  // than try to do raw exit requests.
  return { sent: false, reason: 'no travel method on session (broker required)' };
}

// Precondition: we are NOT at the destination. The planner will only
// plan travel_to when at_shop (or whatever the destination symbol is)
// is false. We don't have a generic "at_room_N" symbol, so the pre is
// empty and the planner's goal determines when travel is planned.
// AN ACTION THAT CANNOT WORK MUST BE UNPLANNABLE, NOT MERELY UNSUCCESSFUL.
//
// With no precondition the planner would always offer a travel, so a leg staged on a
// square the body cannot reach was re-issued for ever — JayB, room 50, 231,626 ticks and
// zero arrivals. `route_reachable` abstains (null -> true) when there is no leg, no
// geometry or no answer, so this only ever refuses on a POSITIVE finding that the staging
// square is outside the reachable set. See docs/m59-goap-repayment.md, phase 1.
travelTo.pre = ['route_reachable'];

// Effect: optimistically, we are now at the destination. This is wrong
// most of the time (one hop is not the whole route), but it gives the
// planner something to chain: travel_to → buy. The next pass re-evaluates
// at_shop from the actual room, and if we're not there yet, the planner
// plans another travel_to.
travelTo.effects = ['at_shop'];

travelTo.atomic = 'travel_to';
travelTo.mutates = true;  // sends an exit request; the room changes
