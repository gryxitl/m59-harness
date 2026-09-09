#!/usr/bin/env node
// WHERE TO RECOVER, OWNED BY THE TICK DRIVER.
//
// The problem this exists for. `healthy` rests when HP drops below `restBelow` (0.7), and
// it rested WHEREVER IT HAPPENED TO BE STANDING — in a corridor, on a crossroads, in the
// middle of the room it was crossing. Measured on one keeper process: `healthy->rest` was
// 369 of 595 decisions, the most-taken action in the entire decider, over twelve episodes
// with a 30-second median and 286 seconds standing still while the router held a
// destination three rooms away.
//
// The previous fix for that made the character keep WALKING instead of sitting. That is
// better — a journey that stops is a journey that never arrives — but it is half an answer.
// It trades "sits in the open" for "walks in the open". The right behaviour is the one the
// legacy autopilot already had: WALK TO A DEFENSIBLE SQUARE, recover there, and get back on
// the road when the clock says so.
//
// WHY THIS IS A NEW MODULE AND NOT AN IMPORT OF THE LEGACY.
//
// `m59-autopilot.mjs` has `takeSafeSpot`, and it is good: 118 code lines with a 3-minute
// hold budget, a share cap so two characters can use one wall, a barren-spot memo for walls
// where pulls repeatedly failed, quarry reachability, an island-bridge plan, and a ledger
// that records what happened. It is also 38 references deep into a class built for FIGHTING
// FROM A WALL — the quarry, the pull test, the island crossing — and it is the file upstream
// changes. Resting mid-journey needs none of that. Importing it would put our rest behaviour
// behind a class we do not control and that is shaped for a different question, so an
// upstream change to combat would break recovery.
//
// What IS imported is `m59-safespots.mjs`, which is a different kind of file: it imports
// only `node:fs` and `RoomGeometry`, exports pure functions over geometry, and has 183 tests
// of its own. It answers "which squares in this room are defensible", which is a geometry
// question, not a combat policy. That is the layer worth depending on.
//
// So this module owns the POLICY — when to walk, when to sit, when to give up and sit anyway
// — and delegates the GEOMETRY. If upstream rewrites the autopilot, nothing here changes. If
// upstream changes the geometry model, `m59-safespots.mjs` fails its own 183 tests first and
// tells us there, rather than silently making characters rest in doorways.
//
// THE POLICY, AND WHY EACH RULE IS THERE
//
//  1. Rest at a defensible square, not where we are standing.
//  2. Walk to it only if the walk is short. Crossing half a room to reach a wall, while
//     hurt, is a worse bet than sitting down here — the point of the wall is shelter, and a
//     long walk spends the shelter to get it. `within` is therefore a budget in squares, not
//     a search radius.
//  3. NEVER rest in the open when a defensible square is reachable and close. This is the
//     whole point, so it is asserted rather than hoped for.
//  4. ALWAYS have an answer. A room with no defensible square — the Brownestone Inn, 6x12,
//     genuinely has none — must return "rest here", not "no spot". The first version of this
//     rule anywhere in this repository returned null in that case and the character stood
//     doing nothing at 5/20 HP, which is worse than resting in the open. Same for a room with
//     no geometry, a room not in the book, and a spot we cannot reach.
//  5. A BUDGET, from the legacy, kept verbatim in spirit: 180s. `a journey that keeps
//     stopping is a journey that never arrives`. After the budget we walk on and let the
//     character recover while moving. This is what makes rule 1 safe to have.
//  6. A spot we have never tested is usable, but flagged. 11 of the 15 rooms the fleet uses
//     are in the safe-spot book; the four that are not (Marion, the inn, West Jasper) are
//     exactly the TRANSIT rooms where resting mid-journey happens, so refusing unproven
//     spots would disable this feature precisely where it is needed.

import { nearestSafeSpot, safeSpotBook } from '../m59-safespots.mjs';

// The legacy's travelHoldBudgetMs, same value and same reason. Long enough to recover a
// meaningful amount of HP, short enough that a journey still finishes.
export const REST_HOLD_BUDGET_MS = 180_000;

// How far we are willing to walk for shelter while hurt. Ten squares is the legacy's
// travelHoldWithin default; it is roughly a third of a hunt room (50x49) and well under the
// distance a hurt character can survive crossing in the open.
export const REST_SPOT_WITHIN_SQUARES = 10;

// A spot is "ours" for this long after we reach it, so we sit rather than re-deciding.
const AT_SPOT_SAME_SQUARE = 0;

let _book = null;
function book() {
  // The book is a cache of which squares have been PROVEN defensible by a live pull test.
  // It is optional: `nearestSafeSpot` scores proven squares higher and still returns an
  // unproven candidate when there is nothing better. Loading it must therefore never be
  // able to break recovery, which is why a throw here is not fatal.
  if (_book === null) {
    try { _book = safeSpotBook(); } catch { _book = false; }
  }
  return _book || null;
}

// THE ONE FUNCTION THE DECIDER CALLS.
//
// Returns { action, spot, why, heldMs } where action is:
//   'rest-here'  sit down where we are (already on a spot, out of budget, or no alternative)
//   'walk'       move to spot.col/spot.row first, do not sit yet
// Never throws, and never returns null: a caller that has to handle "no answer" will get it
// wrong eventually, and the wrong answer here is a character standing at 5 HP.
export function restSpotFor(session, { now = () => Date.now() } = {}) {
  try {
    const geo = session?.world?.geometry;
    const me = session?._pose?.current?.() ?? session?.client?.self;
    const roomNum = session?.world?.room?.num ?? session?.client?.room?.num ?? null;

    if (!geo || !me || me.col == null || me.row == null) {
      // No geometry, no position. Rest where we are. This is the case that must not stall:
      // the room's baked .roo can be missing, stale or a different size than the server's
      // (room 534's local map and the live server have disagreed about dimensions before),
      // and in every one of those the character still needs to be able to heal.
      return { action: 'rest-here', spot: null, why: 'no geometry for this room; resting here' };
    }

    // Already holding a spot within this budget? Then sit. Without this the decider would
    // re-run the search every tick and could oscillate between two equally good squares,
    // walking toward one and re-choosing the other — the same stand/travel thrash the
    // `stand before moving` branch exists to prevent.
    const held = session._restSpot;
    if (held && held.room === roomNum && now() - held.at < REST_HOLD_BUDGET_MS) {
      if (held.col === me.col && held.row === me.row) {
        return { action: 'rest-here', spot: held, why: 'already on the spot we chose',
                 heldMs: now() - held.at };
      }
      // Still committed to a spot we have not reached, and still in budget: keep walking to
      // it rather than re-choosing. Re-deciding every tick is how a character ends up
      // between two walls and resting at neither.
      return { action: 'walk', spot: held, why: 'continuing to the spot already chosen',
               heldMs: now() - held.at };
    }

    const budgetSpent = session._restHeldMs ?? 0;
    if (budgetSpent >= REST_HOLD_BUDGET_MS) {
      // THE WALK-ON RULE, and the reason rule 1 is safe to have at all.
      return { action: 'rest-here', spot: null,
               why: 'out of holding budget; a journey that keeps stopping is a journey that never arrives',
               heldMs: budgetSpent };
    }

    const spot = nearestSafeSpot(geo, me, {
      book: book(),
      room: roomNum,
      within: REST_SPOT_WITHIN_SQUARES,
      // No quarry, no quarryReach, no island bridge, no share cap. Those are the legacy's
      // combat concerns; a character recovering between rooms has no quarry and is alone.
    });

    if (!spot) {
      // No defensible square within budget — or none in the room at all. The Brownestone Inn
      // (6x12) is the real case: it is a shop, it has no wall that qualifies, and the correct
      // answer is "this is as safe as it gets, sit down", not "stand up forever".
      return { action: 'rest-here', spot: null,
               why: 'nothing defensible in reach; resting here rather than not recovering' };
    }

    if ((spot.steps_away ?? 0) === AT_SPOT_SAME_SQUARE) {
      session._restSpot = { col: spot.col, row: spot.row, room: roomNum, at: now(),
                            proven: !!spot.proven };
      return { action: 'rest-here', spot: session._restSpot,
               why: `on a defensible square (${spot.proven ? 'proven' : 'unproven'})` };
    }

    session._restSpot = { col: spot.col, row: spot.row, room: roomNum, at: now(),
                          proven: !!spot.proven };
    return { action: 'walk', spot: session._restSpot,
             why: `walk ${spot.steps_away} squares to a ${spot.proven ? 'proven' : 'candidate'} defensible square`,
             heldMs: budgetSpent };
  } catch (e) {
    // A throw in here must never cost a character its recovery. Whatever broke, sit down.
    return { action: 'rest-here', spot: null, why: `rest-spot search failed: ${e.message}` };
  }
}

// Called when the character actually sits, so the budget measures real resting time and the
// chosen spot survives a tick of walking. Separate from the search so a search that runs
// while the character is walking does not consume the budget.
export function noteResting(session, { now = () => Date.now() } = {}) {
  try {
    const me = session?._pose?.current?.() ?? session?.client?.self;
    if (!me || me.col == null) return;
    session._restStartedAt = session._restStartedAt ?? now();
    // If we moved off the chosen square, the hold is no longer valid and the next rest
    // re-chooses. This is what stops a character walking away from its wall and continuing
    // to believe it is sheltered.
    const held = session._restSpot;
    if (held && (held.col !== me.col || held.row !== me.row) && held.room === session?.world?.room?.num) {
      session._restSpot = null;
    }
  } catch { /* bookkeeping only; never blocks a rest */ }
}

// Called when the character stands back up: bank the time spent resting.
export function noteStoppedResting(session, { now = () => Date.now() } = {}) {
  try {
    const started = session._restStartedAt;
    if (started != null) {
      session._restHeldMs = (session._restHeldMs ?? 0) + (now() - started);
      session._restStartedAt = null;
    }
  } catch { /* bookkeeping only */ }
}

// A new room resets the budget. The budget is per JOURNEY LEG, not per session: a character
// that rests 170s in one room, walks on, and gets hurt again two rooms later should be able
// to use a wall there too. Carrying the spent budget across rooms would mean the first bad
// room disables recovery for the rest of the run.
/**
 * A ROOM CHANGED. This clears the chosen SPOT and nothing else.
 *
 * It used to clear `_restHeldMs` too, under the reasoning that a character hurt again in a
 * new room should get a fresh allowance. That was wrong, and the name made it worse: the
 * budget is a JOURNEY allowance, and handing it back at every room boundary means a hurt
 * character crossing five rooms may stop for the full allowance in each — fifteen minutes on
 * one journey — while every individual stop reports itself within budget. The legacy zeroes
 * `travelHeldMs` only at trip start (m59-autopilot.mjs:5176) and trip end (:5272), and only
 * ever adds to it in between (:4893, :5014).
 *
 * The chosen spot, on the other hand, IS room-local: a square picked as shelter in room A is
 * not shelter in room B, and carrying it across a transition would have the character walk
 * back toward a wall in a room it has already left.
 */
export function noteRoomChanged(session) {
  try {
    session._restSpot = null;
    session._restStartedAt = null;   // an in-progress rest belongs to the room we left
  } catch { /* bookkeeping only */ }
}

/**
 * A NEW JOURNEY BEGAN — the budget is per journey, so it starts at zero.
 *
 * This is the only place the budget is cleared while a character is moving, and it replaces
 * noteRoomChanged in the decider. Clearing on a room change gives a hurt character a fresh
 * allowance in every room it crosses, which is the failure the budget exists to stop: five
 * rooms at 180s each is fifteen minutes of stopping on one journey, reported the whole time
 * as being within budget. The legacy agrees — `travelHeldMs` is zeroed at trip start
 * (m59-autopilot.mjs:5176) and at trip end (:5272), and only ever added to in between.
 */
export function noteNewJourney(session) {
  if (!session || typeof session !== 'object') return;
  session._restHeldMs = 0;
  session._restStartedAt = null;
  session._restSpot = null;
}
