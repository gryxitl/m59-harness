#!/usr/bin/env node
// m59-zap.mjs -- the zap enchantment state machine for the tick driver.
//
// Zap is NOT a one-shot bolt. It is a PERSISTENT ENCHANTMENT: while it is
// active, the character's melee touch is electric, doing significantly more
// damage than a bare swing. The mechanic (from zap.kod):
//
//   - Requires BLUE MUSHROOMS to cast (consumed per cast).
//   - Cast ONCE; the enchantment then lasts for a duration.
//   - "Sparks jump and crackle from your fingertips."   -> turned ON
//   - "Your fingers are no longer charged..."           -> expired / OFF
//   - "Your hands already crackle..."                   -> already active (refused)
//   - The weapon must be UNEQUIPPED to cast (the charge is on the hands).
//   - Range is short: a touch, ~3 squares in a line.
//
// The server signals the enchantment state through the message stream
// (BP.MESSAGE / BP.SYS_MESSAGE -> emit('message', {text})), so we track it by
// scanning the client's event ring for those phrases rather than guessing a
// duration. This is more robust than a timer: the server tells us exactly when
// it lapses.
//
// This module is deliberately small and side-effect-free in its read path:
//   - ZapState.read(client)       -> current enchantment status
//   - ZapState.ensureActive(...)  -> cast zap if it should be active
//
// The cast itself (unequip + cast) is the caller's decision, so the combat
// controller can pace it with the rest of its attack loop.

// Phrases from zap.kod, matched case-insensitively. The ON phrase is the
// definitive "enchantment is active" signal; the OFF phrase is the lapse.
const ZAP_ON  = /sparks jump and crackle/i;
const ZAP_OFF = /no longer charged with electrical/i;
const ZAP_ACTIVE_REFUSED = /already crackle/i;

// How far back (ms) to scan the event ring for zap status messages. The
// enchantment lasts longer than this, but the LATEST on/off message is what
// matters — we scan a wide window and take the most recent signal.
const SCAN_WINDOW_MS = 5 * 60 * 1000;

/**
 * Read the zap enchantment status from the client's event ring.
 *
 * Returns:
 *   { active: boolean, lastChangeMs: number|null, basis: string }
 *
 * `active` is true if the most recent zap status message (within the window)
 * was an ON without a subsequent OFF. `basis` names the message that decided
 * it, for logging.
 */
export function zapStatus(client, { windowMs = SCAN_WINDOW_MS } = {}) {
  const now = Date.now();
  const events = client?.eventsSince?.(0) ?? [];
  // Walk the ring, tracking the latest zap on/off signal.
  let active = false;
  let basis = null;
  let lastAt = null;
  for (const ev of events) {
    if (ev.kind !== 'message' || !ev.text) continue;
    const t = ev.text;
    if (ZAP_ON.test(t) || ZAP_OFF.test(t) || ZAP_ACTIVE_REFUSED.test(t)) {
      const isOn = ZAP_ON.test(t) || ZAP_ACTIVE_REFUSED.test(t);
      active = isOn;
      basis = t.slice(0, 80);
      lastAt = ev.at;
    }
  }
  return {
    active,
    lastChangeMs: lastAt,
    ageMs: lastAt == null ? null : now - lastAt,
    basis,
  };
}

/**
 * Does the character have enough blue mushrooms to cast zap?
 * zap.kod says "requires blue mushrooms" — the catalogue lists no fixed count,
 * so we require at least one. Returns the count found.
 */
export function blueMushroomCount(client) {
  const inv = client?.inventory ?? [];
  let n = 0;
  for (const o of inv) {
    const name = client.rsc?.get?.(o.nameRsc) ?? o.name ?? '';
    if (/blue mushroom/i.test(name)) n += o.count ?? 1;
  }
  return n;
}

/**
 * Is a weapon currently equipped? (Needed to know whether to unequip first.)
 */
export function equippedWeapon(client) {
  try {
    const eq = client.equipment?.();
    if (!eq || eq.known === false) return null;
    const WEAPONS = /sword|axe|club|mace|hammer|dagger|staff|spear|bow|claymore|scimitar|pike|lance/;
    for (const o of eq.equipped ?? []) {
      const name = o.name ?? client.rsc?.get?.(o.nameRsc) ?? '';
      if (WEAPONS.test(name)) return o;
    }
  } catch {}
  return null;
}

/**
 * Find the zap spell in the character's spell list. Returns { id, name } or null.
 */
export function findZapSpell(client) {
  const spells = client?.spells ?? [];
  for (const s of spells) {
    const name = client.rsc?.get?.(s.nameRsc) ?? s.name ?? '';
    if (/^zap$/i.test(String(name).trim())) return { id: s.id, name: 'zap' };
  }
  return null;
}

/**
 * Decide whether zap should be (re)cast right now.
 *
 * Returns { shouldCast: boolean, reason: string }. The caller performs the
 * cast (unequip weapon if equipped, then client.cast(zapId)) and relies on
 * the server's ON message to flip zapStatus().active.
 */
export function shouldCastZap(client, session = null) {
  const spell = findZapSpell(client);
  if (!spell) return { shouldCast: false, reason: 'no zap spell' };
  const status = zapStatus(client);
  if (status.active) return { shouldCast: false, reason: `already active (${status.ageMs ?? '?'}ms)` };
  // Cooldown: if the character cast the spell within the last 5 seconds,
  // don't cast again. This prevents the "cast every second" loop.
  const now = Date.now();
  const lastCast = client?._lastZapCastAt ?? 0;
  if (lastCast > 0 && now - lastCast < 5000) {
    return { shouldCast: false, reason: `cooldown (${now - lastCast}ms since last cast)` };
  }
  // CastWatch gate: hold while the last zap cast was refused or fizzled
  // and the verdict is fresh. Normalize the spell name once (trailing space
  // from the regex).
  const cw = session?._castWatch;
  if (cw) {
    const sp = String(cw.spell ?? '').trim().toLowerCase();
    if ((sp === 'zap' || sp === '') && (cw.phase === 'refused' || cw.phase === 'fizzle') && cw.endedAt) {
      const age = now - cw.endedAt;
      if (age < 10000) {
        return { shouldCast: false, reason: `zap ${cw.phase} (${age}ms ago)` };
      }
    }
  }
  const mush = blueMushroomCount(client);
  if (mush < 1) return { shouldCast: false, reason: `no blue mushrooms (${mush})` };
  return { shouldCast: true, reason: `enchantment down, ${mush} blue mushroom(s) available` };
}
