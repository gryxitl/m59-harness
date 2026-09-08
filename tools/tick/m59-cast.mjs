// m59-cast.mjs — OBSERVE A CAST FROM THE SERVER'S OWN WORDS.
//
// ## Why this file exists
//
// Blink requires concentration. The server's rule is not "blink takes N milliseconds"; it is
// "blink resolves unless the caster does something else first" — running, moving, swinging, or
// taking a hit. That means the correct hold around a cast is not a timer at all. It is the
// interval between the server accepting the cast and the server telling you how it ended.
//
// The server tells you how it ended, in plain text, on the event stream. The harness already
// receives those lines and drops them: `m59-game.mjs` routes every `ev.kind === 'message'` to
// three consumers (banker lines, combat lines, loyalty warnings) and discards the rest. So the
// one signal that answers "did the cast happen, is it still going, or did we just cancel it"
// was going past unread for the whole life of this project.
//
// The three lines, as the server writes them (supplied by the user from the live client, and
// matched here by distinctive substring rather than whole string, so a punctuation or
// localization change degrades to "unrecognised line" instead of "cast never ended"):
//
//   "You focus your whole will on casting blink."
//   "Your concentration is broken and the blink spell fizzles."
//   "You find yourself realigned with your surroundings."
//
// ## What it replaces
//
// `Mover._tryBlink()` used a 2,000 ms `setTimeout` to wait out standing up, armed its hold
// INSIDE that timeout, and then held for a hard-coded 20,000 ms. Three defects, all confirmed
// from source before this file was written:
//
//   1. The hold was armed at the moment the cast was SUBMITTED, which is 2,000 ms AFTER
//      `_tryBlink()` returned. The mover ticks every 0.30 s (measured, keeper-t2.log), so six
//      unconstrained ticks ran inside that window and each one was free to send a move packet.
//   2. The cast was submitted to the pacer under kind `'blink'`. The pacer's priority list is
//      `kind === 'attack' || kind === 'cast'` (m59-game.mjs:526), so the cast queued BEHIND the
//      move packets instead of ahead of them.
//   3. Nothing observed the outcome. Over 106 blinks, exactly one was followed by a position
//      change. A cast that was never sent, a cast that fizzled, and a cast that landed in the
//      same 0.125-square threshold all looked identical from where the mover sat.
//
// Defect 1 is the mechanism: the mover's own escape fan sent a move packet during the
// concentration window, and the server answered with the fizzle line. We were cancelling our
// own blink, 105 times out of 106.
//
// ## Scope, and why it is not in m59-game.mjs
//
// docs/TICK-MOVEMENT-PLAN.md says the shared `m59-game.mjs` / `m59-roo.mjs` are read, not
// modified, and that every change belongs in the tick driver's own files. An earlier revision
// of this work added a `noteCastLine()` call to the session's event handler and was reverted
// for that reason. This file is installed instead by WRAPPING `client.onEvent` from the keeper
// process after join, chaining to the original callback so the legacy consumers — banker,
// combat, loyalty, the recorder's raw stream — all still receive every event untouched.
//
// It is deliberately a passive observer. It does not decide anything, does not hold anything,
// and does not know what blink is for. It answers one question — what is the state of the cast
// the server last told us about — and the Mover decides what to do with the answer.

import { appendFileSync } from 'node:fs';

// Matched by substring, not equality. The three lines are server DATA (spell SDF), not source
// constants — `grep blink` over blakserv/*.c and clientd3d/*.c returns nothing but a comment
// about torches — so there is no compile-time coupling to protect and no reason to be brittle.
// Each pattern is chosen to be unambiguous against the other two.
export const CAST_LINES = [
  // "You focus your whole will on casting blink."  — accepted; concentration has begun.
  { phase: 'begin',    match: 'focus your whole will on casting' },
  // "Your concentration is broken and the blink spell fizzles."  — cancelled.
  { phase: 'fizzle',   match: 'concentration is broken' },
  // "You find yourself realigned with your surroundings."  — succeeded.
  { phase: 'landed',   match: 'realigned with your surroundings' },
  // "You don't have enough mana to cast blink!"  — REFUSED BEFORE IT BEGAN.
  //
  // This line is not a hypothesis. It is what the live server sent, four times in one
  // recording, while t2 stood in the Brownestone Inn: the raw event stream at
  // substrate/recordings/t2-*.jsonl is full of it. It is the commonest cast outcome in
  // this fleet by a wide margin, and it was invisible: the mover held the character
  // still for the full 20,000 ms backstop on a cast the server had rejected in well
  // under a second, then tried again. Over 106 blinks that is minutes of standing in a
  // pocket doing nothing, on a spell that was never going to fire.
  //
  // It is a REFUSAL, not an interruption: no concentration window ever opened, so it
  // must not be treated like a fizzle (which means "we moved during the cast"). The
  // distinction matters because the remedies differ — a fizzle says stop moving, a
  // refusal says stop casting until there is mana.
  { phase: 'refused',  match: "don't have enough mana to cast" },
];

// A cast that never resolves is a bug in SOMETHING, and the old code's failure mode was a hold
// that lasted forever on a dead cast. This is a backstop, not the release condition: the normal
// release is a `landed`/`fizzle` line, which arrives in well under a second. Anything still
// unresolved after this is reported as `lost` so the caller can stop waiting, and the fact that
// it happened is worth logging rather than hiding — it means the text we key on changed.
export const CAST_LOST_AFTER_MS = 15000;

/**
 * Classify one server text line. Pure, exported for tests.
 * @returns {{phase: string, spell: string|null}|null} null when the line is not a cast line.
 */
export function classifyCastLine(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const t = text.toLowerCase();
  for (const { phase, match } of CAST_LINES) {
    if (!t.includes(match)) continue;
    // The begin line names the spell ("...on casting blink."); the other two do not, so the
    // spell name is recovered where present and left null otherwise rather than guessed.
    // The spell name appears in two constructions, and both are worth recovering:
    // "...on casting blink." on the accept line, "...to cast blink!" on the refusal. The
    // original pattern knew only the first, so every refusal came back spell: null -- inert
    // today, but a silent gap the moment two spells' refusals need telling apart.
    let spell = null;
    let m = /casting ([a-z][a-z '-]*?)\s*[.!?]/i.exec(t);
    if (!m) m = /to cast ([a-z][a-z '-]*?)\s*[.!?]/i.exec(t);
    if (m) spell = m[1].trim();
    return { phase, spell };
  }
  return null;
}

/**
 * The cast state for one session. One instance per session, fed by the wrapped onEvent.
 */
export class CastWatch {
  /** @param {(msg: string) => void} [log] defaults to console.error */
  constructor({ log = null, now = () => Date.now() } = {}) {
    this.log = log ?? ((m) => console.error(m));
    this.now = now;
    // null | 'casting' — set on `begin`, cleared on `landed`/`fizzle`/`lost`.
    this.state = null;
    this.spell = null;
    this.beganAt = 0;
    this.endedAt = 0;
    this.phase = null;        // last terminal phase seen: 'landed' | 'fizzle' | 'refused' | 'lost'
    // Counts are the durable part. A single fizzle is an event; a hundred fizzles and no
    // landings is a diagnosis, and the second one is what the next reader needs.
    this.counts = { begin: 0, fizzle: 0, landed: 0, refused: 0, lost: 0, untracked: 0 };
    this._lastLoggedAt = 0;
  }

  /**
   * Feed one event. Call for EVERY event; this ignores non-message events itself so the
   * caller can wrap the callback without knowing which event kinds matter.
   * @returns {object|null} the classification, when this event was a cast line.
   */
  note(ev) {
    if (!ev || ev.kind !== 'message' || !ev.text) return null;
    const hit = classifyCastLine(ev.text);
    if (!hit) return null;
    // A cast line we were not waiting for is still worth counting: it is how a cast issued by
    // the legacy keeper, by a macro, or by a second code path shows up in the numbers instead
    // of silently corrupting them.
    if (hit.phase === 'begin') {
      this.counts.begin++;
      this.state = 'casting';
      this.spell = hit.spell;
      this.beganAt = this.now();
      this.endedAt = 0;
      this.phase = null;
      this._emit('begin', ev.text);
      return hit;
    }
    if (hit.phase === 'landed' || hit.phase === 'fizzle' || hit.phase === 'refused') {
      this.counts[hit.phase]++;
      if (this.state === 'casting') this.state = null;
      else this.counts.untracked++;
      this.endedAt = this.now();
      this.phase = hit.phase;
      this._emit(hit.phase, ev.text);
      return hit;
    }
    return hit;
  }

  /**
   * Is a cast in flight? Advances the state machine: a cast that has been outstanding for
   * longer than CAST_LOST_AFTER_MS is declared `lost` so a caller can stop waiting on it.
   * This is the backstop, never the normal exit.
   */
  casting() {
    if (this.state !== 'casting') return false;
    if (this.now() - this.beganAt > CAST_LOST_AFTER_MS) {
      this.counts.lost++;
      this.state = null;
      this.phase = 'lost';
      this.endedAt = this.now();
      this._emit('lost', `no cast line after ${CAST_LOST_AFTER_MS}ms`);
      return false;
    }
    return true;
  }

  /** Milliseconds the current (or last) cast has taken / took. */
  elapsed() {
    if (this.state === 'casting') return this.now() - this.beganAt;
    if (this.endedAt && this.beganAt) return this.endedAt - this.beganAt;
    return 0;
  }

  /** A one-line summary for a heartbeat or an HTTP diagnostic. */
  summary() {
    const c = this.counts;
    return `cast begin=${c.begin} landed=${c.landed} fizzle=${c.fizzle} refused=${c.refused}`
      + ` lost=${c.lost} untracked=${c.untracked} state=${this.state ?? 'idle'}`
      + (this.state === 'casting' ? ` age=${this.elapsed()}ms` : '');
  }

  // Every cast line goes to the log, and the three phases are logged on SEPARATE prefixes so a
  // grep can count one outcome without excluding the others. This is the point of the whole
  // file: before it, the repository had no way to tell these three apart at all.
  _emit(phase, text) {
    const ms = this.elapsed();
    const line = `[cast] ${phase} ${this.spell ?? 'blink?'} ${phase === 'begin' ? `t=0` : `t=${ms}ms`} :: ${text}`;
    try { this.log(line); } catch { /* a dead log must not break the packet path */ }
  }
}

/**
 * Install the watcher on a session by wrapping its client's onEvent, chaining to whatever was
 * already installed so nothing loses an event. Must be called AFTER join: `joinOnce` assigns
 * `c.onEvent` itself (m59-game.mjs:1407), so a wrapper installed before login is overwritten.
 *
 * Idempotent: installing twice does not double-count.
 *
 * @param {object} session
 * @param {object} [opts]
 * @returns {CastWatch|null} null when there is no client to wrap.
 */
export function installCastWatch(session, opts = {}) {
  const c = session?.client;
  if (!c) return null;
  if (session._castWatch) return session._castWatch;
  const watch = new CastWatch(opts);
  const prev = typeof c.onEvent === 'function' ? c.onEvent : null;
  c.onEvent = (ev) => {
    // Order matters: the original handler is called FIRST so the legacy consumers — the raw
    // recorder stream, banker, combat, loyalty — see exactly what they saw before, and our
    // observation cannot change what they observe even if this file throws.
    if (prev) { try { prev(ev); } catch (e) { /* the original's errors are its own */ } }
    try { watch.note(ev); } catch { /* never break the packet path for a diagnostic */ }
  };
  session._castWatch = watch;
  return watch;
}
