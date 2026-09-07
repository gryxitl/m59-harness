#!/usr/bin/env node
// m59-pose.mjs -- THE SINGLE POSITION TRUTH for the tick brain.
//
// The tick brain used to read "where am I" from five places that disagree:
//   1. client.self            (a getter into room.objects)
//   2. room.objects.get(selfId) (the live server store)
//   3. frame.position         (the Sensor's read of 1/2)
//   4. _simX/_simY           (the Mover's dead-reckoning)
//   5. the `me` param / effMe (each layer re-deriving a mix of the above)
//
// Sources 1 and 2 are the SAME store. The tangle is that each of the five tick
// files re-derives position from a different combination, so when they disagree
// there is no single place to look. This module is that single place.
//
// MODEL (matches the official client, see m59-client.mjs predictSelf):
//   - We are client-authoritative: a move we send is a move that happened.
//     The track never expires and is never rewritten by an echo. Teleports,
//     blinks and room changes are known discontinuities with explicit reset()
//     calls, and they are the ONLY thing that invalidates the track.
//   - Server echoes (~1/s BP_MOVE) are confirmations, not positions. Agreement
//     (a fresh echo near the sim) lets commitment proceed; sustained
//     disagreement (echo frozen or far behind while sends flow) means our
//     moves are not landing — it blocks arrival and feeds stall escalation,
//     but it never moves our believed position. The server has no persistent
//     truth to snap to: it records our last declaration.
//   - `predicted` distinguishes "server said so" from "we think so".
//
// OWNERSHIP: the Sensor calls updateServer() each frame with the room-objects
// self entry; the Mover calls advance() on each send and reset() on
// teleport/blink/room change. Every other tick file reads ONLY current().
//
// This is a pure data holder: no client, no pacer, no geometry. It can be unit
// tested with no network.

import { KOD_FINENESS } from '../m59-roo.mjs';

export class Pose {
  constructor() {
    this.server = null;   // { col, row, x, y, predicted } — last server echo
    this.sim = null;      // { x, y } — dead-reckoned feet (never expires)
    this.simAt = 0;       // wall-clock ms of the last advance()
    this.updatedAt = 0;   // wall-clock ms of the last updateServer()
    this.divergenceResets = 0; // count of divergence-guard adoptions (mover re-plans)
  }

  // Called by the Sensor each frame with the room-objects self entry (or null).
  // The server echo supersedes the sim's `predicted` flag: a real read clears it.
  updateServer(obj) {
    if (obj && Number.isFinite(obj.col) && Number.isFinite(obj.row)) {
      const prevUpd = this.updatedAt;
      this.server = {
        col: obj.col, row: obj.row,
        // KOD protocol units (64 per square), matching advance().
        x: Number.isFinite(obj.x) ? obj.x : (obj.col * KOD_FINENESS + KOD_FINENESS / 2),
        y: Number.isFinite(obj.y) ? obj.y : (obj.row * KOD_FINENESS + KOD_FINENESS / 2),
        predicted: obj.predicted === true,
      };
      this.updatedAt = Date.now();
      // ADOPT: if our track is strictly older than the previous echo (no sends
      // since) and the new echo is on a different square, the server moved
      // without us — legacy walks, slides, knockbacks move the body without
      // advancing the sim. Adopt the echo (it is newer information, not a
      // correction of our intent). When our sends are outstanding (sim newer),
      // keep tracking. (Strictly-less: a same-millisecond advance is a send,
      // not a no-send gap — the divergence guard owns the drifted-sim case.)
      if (this.sim != null && this.simAt < prevUpd) {
        const scol = Math.floor(this.sim.x / KOD_FINENESS);
        const srow = Math.floor(this.sim.y / KOD_FINENESS);
        if (scol !== this.server.col || srow !== this.server.row) {
          this.sim = { x: this.server.x, y: this.server.y };
          this.simAt = Date.now();
        }
      }
      // DIVERGENCE GUARD: the sim is never-expiring and only resets on a room
      // change, so a stale plan (or sends that aren't landing) drifts it in
      // the wrong direction and it never self-corrects. The echo lag is up to
      // one stride (160 walk / 320 run); a gap beyond 6 squares (384) is not
      // "ahead", it's lost. Adopt the echo (the last confirmed position) so
      // the next plan re-anchors on where we actually are. Matches the client
      // (MoveObject2 overwrites player.x/y on every BP_MOVE — auto-correction).
      const div = this.divergence();
      if (div != null && div > 384) {
        if (process.env.M59_POSE_DEBUG !== '0' && this.divergenceResets < 3)
          console.error(`[posedbg] divergence guard: sim ${Math.round(this.sim.x)},${Math.round(this.sim.y)} -> echo ${this.server.col},${this.server.row} (div=${Math.round(div)})`);
        this.sim = { x: this.server.x, y: this.server.y };
        this.simAt = Date.now();
        this.divergenceResets++;
      }
    }
  }

  // Called by the Mover on each accepted send. Advances our feet.
  // SERVER-SPEED ADVANCE (the dead-reckoning fix): the server moves the
  // character at the declared speed (18 = 1 square/sec, 36 = 2 squares/sec)
  // TOWARD the aim — it does not teleport to the aim. Advancing the sim to
  // the aim (the full stride) ran it 2.5-5 squares ahead of the server, and
  // the divergence guard yanked it back every echo (the dither). Advance by
  // one server step (64 proto units = 1 square, the send interval is ~1s at
  // speed 18) toward (x, y) instead. The sim then tracks the server (1 square
  // ahead, within echo lag), the plan is drawn from the real position, and the
  // guard rarely fires.
  //
  // SEEDING IS NOT A JUMP TO THE AIM. `x, y` is what we are DECLARING we are
  // heading toward — a stride target up to 320 protocol units (5 squares) away —
  // not where our feet are. Seeding the sim there made the Pose report an aim as
  // a position, and the error was uncatchable: the largest possible bad seed is
  // one stride (320), which is UNDER the 384 divergence threshold, so the guard
  // could never see its own cause. Live, keeper-t3.log, immediately after a room
  // change with the echo at (23,18):
  //
  //   plan from=(23,23)   <- the Pose, seeded from a run aim 320 away
  //   gateOK vel aim=(1472,1152) me=(23,18) srv=(23,18)   <- 790 identical sends
  //
  // The path was then planned for a square the character had never been to, its
  // first waypoint was the low-edge corner of the square it actually stood in, and
  // every declaration said "go to where you already are". Frozen for 790 sends.
  //
  // So seed from the last confirmed echo when we have one, and only fall back to
  // the aim when there is no echo at all (a fresh join, before the first BP_MOVE).
  // The 64-unit step then does its job from a position that is actually ours.
  advance(x, y, step = KOD_FINENESS) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (this.sim == null) {
      const anchor = this.server != null
        && Number.isFinite(this.server.x) && Number.isFinite(this.server.y)
        ? { x: this.server.x, y: this.server.y }
        : { x, y };
      this.sim = anchor;
      this.simAt = Date.now();
      // Then take the step toward the aim from that anchor, so a send still
      // advances the track by one server step rather than being discarded.
      const dx = x - this.sim.x, dy = y - this.sim.y;
      const dist = Math.hypot(dx, dy);
      this.sim = dist > step
        ? { x: this.sim.x + (dx / dist) * step, y: this.sim.y + (dy / dist) * step }
        : { x, y };
      this.simAt = Date.now();
      return;
    }
    const dx = x - this.sim.x, dy = y - this.sim.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= step) {
      this.sim = { x, y };  // aim is within one step — go to it
    } else {
      this.sim = { x: this.sim.x + (dx / dist) * step, y: this.sim.y + (dy / dist) * step };
    }
    this.simAt = Date.now();
  }

  // Called on teleport / blink / room change. Our feet are no longer valid.
  reset() {
    this.sim = null;
    this.simAt = 0;
  }

  // Disagreement between our track and the last echo, in protocol units
  // (null when either side is missing). A small gap is normal echo lag (up
  // to a stride behind while running); a large, persistent gap means our
  // sends are not landing.
  divergence() {
    if (this.sim == null || this.server == null) return null;
    const sx = Number.isFinite(this.server.x) ? this.server.x : null;
    const sy = Number.isFinite(this.server.y) ? this.server.y : null;
    if (sx == null || sy == null) return null;
    return Math.hypot(this.sim.x - sx, this.sim.y - sy);
  }

  // THE single read. Returns { col, row, x, y, predicted, source, stale }.
  //   source: 'sim' (our tracked position) | 'server' (last echo) | 'none'
  //   stale:  true when neither source is available.
  // Units are KOD protocol units throughout (64 per square) — the sim is
  // advanced with protocol coordinates, so it must be read back in them.
  current() {
    if (this.sim != null) {
      const col = Math.floor(this.sim.x / KOD_FINENESS);
      const row = Math.floor(this.sim.y / KOD_FINENESS);
      return { col, row, x: this.sim.x, y: this.sim.y,
              predicted: true, source: 'sim', stale: false };
    }
    if (this.server) {
      return { ...this.server, source: 'server', stale: false };
    }
    return { col: null, row: null, x: null, y: null,
            predicted: true, source: 'none', stale: true };
  }

  /**
   * THE COMMITMENT READ — where the SERVER has confirmed we are, as opposed to where
   * our own sends say we are heading. `current()` is sim-while-fresh, and the sim
   * advances on every SEND, so judging arrival, a stall, or a chain advance on it fires
   * on packets the server never accepted. Anything that COMMITS (arrives, gives up,
   * re-plans) must use this instead.
   *
   * `session` is the fallback, and it is a real one: `client.self` is the room-objects
   * self entry, written only by BP_MOVE (moveTo records what it asked for, it never
   * mutates the object), so it is the same server truth this mirror holds — and on a
   * session with no Pose wired it is the only copy. Reading it is not a rule violation;
   * hand-rolling the fallback chain in six places is, because each copy drifted: the
   * mover preferred the echo and the router preferred the raw object, and a reader
   * cannot tell from the call site which of the two it is getting.
   *
   * Returns { col, row, x, y, source } with source 'echo' | 'client' | 'none'.
   */
  static confirmed(session) {
    const pose = session?._pose;
    const echo = pose?.server ?? null;
    const src = (echo && Number.isFinite(echo.col) && Number.isFinite(echo.row))
      ? echo
      : (session?.client?.self ?? null);
    if (!src || !Number.isFinite(src.col) || !Number.isFinite(src.row)) {
      return { col: null, row: null, x: null, y: null, source: 'none' };
    }
    const half = KOD_FINENESS / 2;
    return {
      col: src.col, row: src.row,
      x: Number.isFinite(src.x) ? src.x : src.col * KOD_FINENESS + half,
      y: Number.isFinite(src.y) ? src.y : src.row * KOD_FINENESS + half,
      source: echo && src === echo ? 'echo' : 'client',
    };
  }
}

export default Pose;
