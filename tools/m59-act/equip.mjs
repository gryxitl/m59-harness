#!/usr/bin/env node
// m59-act/equip.mjs -- PUT ONE THING IN YOUR HAND (or take it off).
//
// WHAT YOU CARRY AND WHAT YOU ARE WEARING ARE TWO DIFFERENT LISTS. Equipment lives
// in plUsing, not the inventory, and the server volunteers it: whole on
// BP_USE_LIST, one line per change on BP_USE/BP_UNUSE, and free behind every
// inventory request (user.kod:955). `client.equipment()` is the only authoritative
// answer -- do NOT re-derive it from what a `use` was asked to do.
//
// WHICH IS THE WHOLE PROBLEM THIS ATOMIC EXISTS TO SOLVE. Wielding something you
// already wield is REFUSED -- "your hands are too full", player.kod:131 -- and the
// refusal is a sentence spoken to the room, not an error on the wire. So "no error"
// has never meant "equipped", and nineteen of twenty-five characters were once
// found fighting in their shirts while their packs said they owned leather.
//
// So this reads the use list back afterwards and reports what the SERVER says is in
// hand, never what the send was asked to do. A caller that trusted the send would
// go on believing it was armed.
//
// It does not choose WHAT to equip. skills.weaponRanking and skills.wearBest own
// that -- ranking on viDefense_base against viDamage_base, where bare skin is worse
// than every piece of armour in the game and heavy armour is worse than leather for
// a character that intends to be hit zero times. An atomic that picked would be a
// policy with a socket attached.

import { weaponScore } from '../m59-skills.mjs';

/**
 * equip(client, session, { itemId, off, waitMs })
 *
 * `off: true` unuses instead. Returns:
 *   { sent, reason, equipped_before, equipped_after, changed }
 *
 * `changed` is the honest answer: the use list actually moved. A refusal leaves it
 * false with `sent: true`, because the packet did go and the server simply declined
 * out loud to somebody who was not listening.
 */
export async function equip(client, session, { itemId, off = false, waitMs = 700 } = {}) {
  if (!client || !session) return { sent: false, reason: 'no client or session' };
  if (itemId == null)      return { sent: false, reason: 'no item' };

  const inUse = () => {
    const eq = client.equipment?.();
    // `known: false` means no use list has arrived -- nobody has asked yet, which
    // is a different fact from "nothing is equipped" and must not read the same.
    if (!eq || eq.known === false) return null;
    return (eq.equipped || []).some(o => o.id === itemId);
  };

  const before = inUse();
  if (before === true && !off)
    return { sent: false, reason: 'already in use', equipped_before: true,
             equipped_after: true, changed: false };
  if (before === false && off)
    return { sent: false, reason: 'not in use', equipped_before: false,
             equipped_after: false, changed: false };

  const since = client.evSeq ?? 0;
  await session.pacer.submit('use', () => (off ? client.unuse(itemId) : client.use(itemId)), waitMs)
                     .catch(() => {});
  // BP_USE / BP_UNUSE is what confirms it, and the server sends one per change.
  await client.waitFor({ since, kinds: ['equipment', 'message'], timeoutMs: waitMs }).catch(() => {});

  const after = inUse();
  return {
    sent: true,
    equipped_before: before,
    equipped_after: after,
    // Unknown before or after means we cannot claim a change. Reporting `true`
    // on an unread list is how a character comes to believe it is armed.
    changed: before != null && after != null && before !== after,
    reason: after === before ? 'the use list did not move' : null,
  };
}

equip.pre     = ['has_wieldable_weapon'];
equip.effects = ['armed'];
equip.atomic  = 'equip';

// ---------------------------------------------------------------------------
// BINDING -- which item, resolved AT EXECUTION TIME.
// ---------------------------------------------------------------------------
//
// THE PLANNER PLANS OVER SYMBOLS AND NOTHING BOUND THE OBJECTS. `equip` sat in the
// always-available set unbound, stepPlan calls a step with no args, so it correctly
// refused `{sent:false, reason:'no item'}` on every single call while remaining a
// perfectly attractive step to the planner. Observed live: 1,105 consecutive passes,
// every one ACTION=equip, on a character holding a mace it never put in its hand.
//
// BINDING AT PLAN TIME IS THE WRONG FIX, and it was tried first: an action that is only
// in the set when the item is ALREADY in the pack cannot appear after a step that
// creates it, which breaks `cast create weapon -> equip` and, for eat, breaks the
// canonical `cast create food -> eat` outright. The precondition is what makes an
// impossible action absent -- that is what `pre` is FOR -- so binding belongs at the
// moment the step runs, against the pack as it is by then.
export function pickWeapon(client, { score = weaponScore } = {}) {
  const inv = client?.inventory;
  if (!Array.isArray(inv) || !inv.length) return null;
  const nameOf = (o) => String(o?.name ?? client?.rsc?.get?.(o?.nameRsc) ?? '');
  // Already in the server's own use list? Re-`use` is refused with "your hands are too
  // full" (player.kod:131) -- a refusal, not a step, so it is not a candidate.
  const eq = client.equipment?.();
  const held = new Set((eq && eq.known !== false ? eq.equipped || [] : []).map(o => o.id));
  return inv
    .filter(o => o?.id != null && !held.has(o.id) && score(nameOf(o)) > 0)
    .sort((a, b) => score(nameOf(b)) - score(nameOf(a)))[0] ?? null;
}

export const equipBest = (client, session, args = {}) => {
  const item = pickWeapon(client);
  if (!item) return { sent: false, reason: 'no weapon in the pack to equip' };
  return equip(client, session, { ...args, itemId: item.id });
};
equipBest.pre     = equip.pre;
equipBest.effects = equip.effects;
equipBest.atomic  = 'equip';
