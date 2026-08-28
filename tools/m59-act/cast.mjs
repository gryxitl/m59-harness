#!/usr/bin/env node
// m59-act/cast.mjs -- CAST ONE SPELL THE CHARACTER ACTUALLY KNOWS.
//
// A CHARACTER CAN ONLY CAST WHAT IS IN ITS OWN SPELL LIST, and that is not a
// formality -- it is the difference between an atomic and a wish. plSpells is the
// server's list; `client.spells` is our copy of it. A spell absent from it cannot
// be cast at any amount of mana, and asking anyway spends the round and produces
// nothing but silence.
//
// SO UNKNOWN SPELLS ARE NOT REFUSED AT PLAN TIME -- THEY ARE ABSENT. groundedCasts()
// below builds one action per spell the character actually holds, so a planner for
// a character that has never learned `create food` simply has no such action and
// cannot plan a meal out of thin air. That is the same shape the game itself uses:
// a skill you already have, or cannot yet learn, is not refused by a merchant, it is
// missing from the offer list (monster.kod:4855) with no message of any kind.
//
// The atomic still checks, because a plan can be executed against a character whose
// list changed since it was built, and because a refusal must never be a throw.
//
// TWO TRAPS THIS OBEYS.
//
//   THE LIST MUST BE FRESH. A group-3 stat packet is POSITIONAL against plSpells,
//   so against a stale list every number is mislabelled -- silently. That is why
//   abilities are read once after login and kept rather than polled, and why this
//   resolves by NAME against the live list rather than caching an id. Object ids are
//   renumbered on every save (every 15 minutes) in any case; a cached spell id goes
//   quietly deaf.
//
//   MAX MANA IS DERIVED AND LOOKS STORED. piMax_Mana is declared at 20 and
//   ComputeMaxMana (player.kod:6116) throws it away and rebuilds it from
//   15 + mysticism/5 plus melded nodes, worn items and enchantments -- on login, on
//   an equipment change, on an enchantment change. A character set to 200 reads 200
//   until it relogs and comes back at 25. Never cache it; read vitals each time.

import { MIN_CAST_MANA } from '../m59-worldstate.mjs';

const nameOf = (c, s) => String(s?.name ?? c?.rsc?.get?.(s?.nameRsc) ?? '');

/** The spells this character actually holds, as {id, name}. */
export function knownSpells(client) {
  return (client?.spells ?? []).map(s => ({ id: s.id, name: nameOf(client, s) }));
}

/** Resolve a spell BY NAME against the live list. Null when it is not known. */
export function spellNamed(client, name) {
  const want = String(name ?? '').toLowerCase();
  return knownSpells(client).find(s => s.name.toLowerCase() === want) ?? null;
}

/**
 * cast(client, session, { spell, targets, minMana, waitMs })
 *
 * `spell` is a NAME, not an id -- see the freshness trap above.
 * Returns { sent, reason, spell, known, mana_before }.
 *
 * Refuses, by returning:
 *   - the character does not know the spell   (`known: false`)
 *   - not enough mana for the floor
 * Neither is an exception, and neither pretends the spell went out.
 */
export async function cast(client, session, { spell, targets = [], minMana = MIN_CAST_MANA,
                                              waitMs = 1050 } = {}) {
  if (!client || !session) return { sent: false, reason: 'no client or session' };
  if (!spell)              return { sent: false, reason: 'no spell named' };

  const found = spellNamed(client, spell);
  if (!found)
    // NOT AN ERROR AND NOT A FAILURE OF NERVE: this character has not learned it.
    return { sent: false, reason: 'does not know that spell', spell, known: false };

  const mana = client.vitals?.()?.mana?.value ?? null;
  if (mana != null && mana < minMana)
    return { sent: false, reason: 'not enough mana', spell, known: true, mana_before: mana };

  const since = client.evSeq ?? 0;
  await session.pacer.submit('cast', () => client.cast(found.id, targets), waitMs).catch(() => {});
  // What a cast produced is read by the CALLER from the pack or the vitals: the
  // server answers a failed cast with prose to the room, so there is no result code
  // to return and inventing one would be a lie with a number in it.
  await client.waitFor({ since, kinds: ['message', 'inventory', 'stat'], timeoutMs: waitMs })
              .catch(() => {});

  return { sent: true, spell: found.name, known: true, mana_before: mana };
}

cast.pre     = ['has_mana'];
cast.effects = ['!has_mana'];
cast.atomic  = 'cast';

/**
 * groundedCasts(client, table) -> [action]
 *
 * One planner action per spell the character ACTUALLY KNOWS, with that spell's own
 * preconditions and effects. A character who has not learned `create food` gets no
 * `cast create food` action at all, so no plan can contain one -- which is the same
 * guarantee `attack.pre` gives against the engagement ceiling: not discouraged,
 * impossible, because the action does not exist.
 *
 * `table` maps spell name -> { pre, effects } drawn from the closed vocabulary.
 */
export function groundedCasts(client, table = SPELL_EFFECTS) {
  return knownSpells(client)
    .filter(s => table[s.name.toLowerCase()])
    .map(s => {
      const t = table[s.name.toLowerCase()];
      const run = (c, sess, args = {}) => cast(c, sess, { ...args, spell: s.name });
      run.pre     = ['has_mana', ...(t.pre ?? [])];
      run.effects = ['!has_mana', ...(t.effects ?? [])];
      run.atomic  = `cast ${s.name}`;
      return run;
    });
}

// What the fleet's spells DO, in vocabulary terms. `create food` is the one that
// matters: 2 elderberry AND 2 herbs per casting, which is why has_reagents is the
// per-character minimum of the pair and never the sum.
export const SPELL_EFFECTS = {
  'create food':  { pre: ['has_reagents'], effects: ['has_food', '!has_reagents'] },
  // PER-SPELL PRICES, because the generic `has_mana` floor is `create food`'s 10 and
  // these cost more. A spell planned below its own price is refused by a SENTENCE, not an
  // error, so nothing is spent and nothing is learned and the next tick tries again.
  // creaweap.kod:41 viMana = 15; it needs no reagents (plReagents = $).
  'create weapon': { pre: ['can_pay_create_weapon'], effects: ['armed'] },
  // BLINK CURES BEING ENTOMBED, NOT BEING TRAPPED. It asks the ROOM to relocate the body
  // ("a central location in the room", blink.kod:21) — which frees a character wedged in
  // geometry, and does nothing for one whose whole reachable region has no exit, because
  // the central location is inside that region. Gating it on `entombed` is what stops the
  // planner offering it to a pocketed character for ever; `escape_pocket` is offered
  // instead. Measured on JayB, room 50: repeated casts, mana spent, never moved.
  'blink': { pre: ['entombed', 'can_pay_blink'], effects: ['can_leave'] },
};
