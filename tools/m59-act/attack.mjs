#!/usr/bin/env node
// m59-act/attack.mjs -- ONE SWING. Not a fight.
//
// The first atomic written to the contract in docs/keeper-rebuild-plan.md §4, and
// the shape every other one follows:
//
//   1. TAKES (client, session), NEVER THE KEEPER. This is the rule the whole
//      rebuild turns on. The fork's BT modules took a keeper, and that is why they
//      could not be carried to another trunk: of the 71 legacy methods they call,
//      25 existed on one fork only. An atomic over the client is portable by
//      construction, because m59-client.mjs is the same everywhere.
//
//   2. BOUNDED. One swing, one pacer slot, one bounded wait. No loop. The keeper's
//      own fight loop is a single await that can run for minutes, and 87 deaths
//      happened inside one with a mean of 44 seconds since the last observation.
//      Looping is the caller's job precisely so the caller can be interrupted
//      between swings.
//
//   3. HONEST. Reports what the ROOM says afterwards, not what the send returned.
//      c.attack() is fire-and-forget over a socket; it cannot fail and it cannot
//      succeed. The only evidence a swing did anything is the target's absence, and
//      the only evidence it was legal is that we were in reach when we sent it.
//
//   4. DECLARES ITS pre/effects from the closed vocabulary, so the planner can
//      chain it and m59-worldstate.validate() can reject a typo.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not decide whether to swing. It does
// not check the engagement band, it does not flee, it does not pick a target, and
// it does not stop when health drops. Every one of those is a decision and belongs
// to a tree or a planner; an atomic that decides is a tree wearing a disguise, and
// that is exactly how the fork's provisionNode became a three-line wrapper around
// 240 lines of keeper.

import { evaluate } from '../m59-worldstate.mjs';

export const SWING_MS = 1050;   // the server's swing timer; the keeper paces to it

/**
 * attack(client, session, { targetId, waitMs })
 *
 * Sends one attack at targetId and waits briefly for the room to say something.
 * Returns a plain result -- no BT status, no world-state mutation -- so the same
 * atomic serves a tree, a planner, or a test.
 *
 *   { sent, reason, target_present_before, target_present_after, in_reach_before }
 *
 * `sent: false` with a reason is the ordinary outcome for "we should not have
 * swung", and it is never an exception: a refusal that throws would have to be
 * caught by every caller, and the ones that forgot would look like successes.
 */
export async function attack(client, session, { targetId, waitMs = SWING_MS } = {}) {
  if (!client || !session)  return { sent: false, reason: 'no client or session' };
  if (targetId == null)     return { sent: false, reason: 'no target' };

  const present = () => !!client.room?.objects?.has?.(targetId);
  const before = present();
  if (!before) return { sent: false, reason: 'target is not in the room', target_present_before: false };

  // IN REACH IS CHECKED, NOT ASSUMED. The server resolves both sides with
  // `SquaredDistanceTo <= GetAttackRange^2` on SQUARE coordinates, so a swing from
  // four squares away is simply thrown away -- no error, no message, and the round
  // is gone. The vocabulary owns that arithmetic; this atomic only obeys it.
  const ws = evaluate({ client, ws: { _targetId: targetId } });
  if (!ws.in_reach)
    return { sent: false, reason: 'out of reach', target_present_before: true, in_reach_before: false };

  const since = client.evSeq ?? 0;
  await session.pacer.submit('attack', () => client.attack(targetId), waitMs).catch(() => {});

  // A BOUNDED wait, and its timeout is not a failure. The server pushes hits and
  // room contents unasked; this is only giving them a moment to arrive so the
  // caller's next tick reads fresh state rather than the state before the swing.
  await client.waitFor({ since, kinds: ['hit', 'room-contents', 'message'],
                         timeoutMs: waitMs + 200 }).catch(() => {});

  return {
    sent: true,
    target_present_before: true,
    in_reach_before: true,
    // The honest part: whether it is still there, read back from the room rather
    // than inferred from the send having not thrown.
    target_present_after: present(),
  };
}

// GOAP metadata. `!has_target` is the effect of the target LEAVING the room, which
// is the only thing a swing can be said to accomplish from out here -- "damage" is
// not in the vocabulary because nothing on the wire reports it per swing.
// BARE HANDS ARE STILL AN ATTACK, AND `armed` IS NOT A PRECONDITION OF SWINGING.
//
// This used to read ['armed', 'has_target', 'in_reach', 'target_in_band'], which was
// harmless while `_fight` ran a hand-written handler — the CombatController punched, and
// PUNCH_REACH exists in m59-combat.mjs for exactly that. The moment `_fight` became a
// PLANNED goal (`{'!has_target': true}`), `armed` made the whole goal unplannable for a
// bare-handed character: the goal was selected, no plan was found, and the character
// stood in front of the quarry doing nothing. Watched live: Lee, 40 ticks of
// "_fight — exhausted 13 nodes without finding a plan".
//
// Nothing is lost by dropping it, because arming is a HIGHER RUNG rather than a
// precondition: `{ goal: 'armed', when: ws.armed === false && ws.can_arm !== false }`
// sits above `_fight` in the ladder, so a character that can get a weapon still does
// before it fights. Only one that CANNOT — no weapon, no money — falls through to here,
// and for that character punching is the way it earns the price of a mace.
attack.pre     = ['has_target', 'in_reach', 'target_in_band'];
attack.effects = ['!has_target'];
attack.atomic  = 'attack';

// ---------------------------------------------------------------------------
// BINDING -- which target. See m59-act/equip.mjs for why this is not plan-time.
// ---------------------------------------------------------------------------
//
// THE TARGET COMES FROM THE WORLD STATE, NOT FROM A SECOND SEARCH. `has_target`,
// `in_reach` and `target_in_band` are all produced from `ws._targetId`. Choosing a
// different creature here would let the planner check the engagement ceiling against
// one and swing at another -- the ceiling failing open, which is the one this
// repository says kills somebody. So the id is taken from the same ws the
// preconditions were evaluated against, and if there is none this refuses rather
// than picking something.
export function attackOf(ws = {}) {
  const run = (client, session, args = {}) => {
    const id = ws?._targetId;
    if (id == null) return { sent: false, reason: 'no target in the world state' };
    return attack(client, session, { ...args, targetId: id });
  };
  run.pre     = attack.pre;
  run.effects = attack.effects;
  run.atomic  = 'attack';
  return run;
}
