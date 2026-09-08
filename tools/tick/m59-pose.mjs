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
      // ECHO TRACE. The one question this repository has been unable to answer all evening is what
      // the SERVER does with a move: adopt the position we declare (so ground per packet is the
      // stride, 2.5 squares) or walk the character toward it at its own speed (so ground per packet
      // is the server's cadence, ~1 square, and declaring further buys nothing). Every attempt to
      // read the answer out of the log measured the INSTRUMENT instead. srv= is sampled only at
      // send time, so a packet sent between two echoes repeats the previous srv= and looks like a
      // server that refused to move: 121 of 331 sampled pairs showed zero movement and 27 showed
      // exactly 5.0 squares, with nothing in between, which is not a locomotion law, it is a
      // sampling artefact with a suspiciously round number in it.
      //
      // The echo itself is the only ground truth available, and it was being thrown away after one
      // comparison. Log every CHANGE of position with the time since the last change and the
      // declaration that was outstanding when it arrived. That turns the question into arithmetic:
      // squares per SECOND of echo-to-echo time, which no sampling can fake.
      try {
        if (this.server && Number.isFinite(obj.x) && Number.isFinite(obj.y)) {
          const moved = Math.hypot(obj.x - this.server.x, obj.y - this.server.y);
          if (moved >= 1) {
            // THE DENOMINATOR MUST BE THE TIME SINCE THE LAST POSITION CHANGE, NOT since the last
            // echo of any kind. `updatedAt` is refreshed on every updateServer call, including the
            // ones that log nothing because the position was unchanged, so it is the frame period
            // (~0.10 s) and dividing by it reported 49 squares/second for a 5-square move. That is
            // the same mistake as sampling srv= at send time, made in the denominator instead of
            // the numerator. lastMovedAt is set only when this branch fires.
            const since = this.lastMovedAt ? (Date.now() - this.lastMovedAt) / 1000 : 0;
            const dec = this.lastDeclared;
            const toward = dec
              ? Math.sign((obj.x - dec.x) * (dec.x - this.server.x) + (obj.y - dec.y) * (dec.y - this.server.y))
              : 0;
            console.error(
              `[echo] x=${Math.round(this.server.x)},${Math.round(this.server.y)} -> ` +
              `x=${Math.round(obj.x)},${Math.round(obj.y)} moved=${Math.round(moved)} ` +
              `(${(moved / 64).toFixed(2)} sq) in ${since.toFixed(2)}s = ` +
              `${since > 0 ? (moved / 64 / since).toFixed(2) : 'n/a'} sq/s ` +
              `declared=${dec ? Math.round(dec.x) + ',' + Math.round(dec.y) : 'none'} toward=${toward}`);
            this.lastMovedAt = Date.now();
          }
        }
      } catch {}
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
      // GROUND IS ACCUMULATED ON EVERY ECHO, not only on the ones that moved. See noteGround.
      this.noteGround(this.server.x, this.server.y);
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
  // Called by the mover with the position it just put on the wire, so an echo can be read
  // against the declaration that produced it. Without this the log has a server position and
  // no way to know which send it is an answer to.
  noteDeclared(x, y) {
    this.lastDeclared = { x, y };
  }

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
    // DEAD RECKONING MEANS GOING WHERE WE DECLARED. The sim is 'dead-reckoned feet', and
    // dead reckoning advances to the position we last said we were at — it does not crawl
    // toward it. The clamp below is a leftover of a server model the reference client does
    // not hold: move.c:96 defines server_x as the "Last position we've told server we are",
    // and it is re-anchored only when the server tells us our position outright
    // (move.c:732/:810 — a room change or a correction). Between corrections the server
    // believes the declaration, so the position we declared IS where our feet are.
    //
    // The clamp's cost was measured, not assumed: a mover declaring 128 units of ground per
    // packet had its sim move 64, so it planned every subsequent route from a position
    // permanently one square BEHIND its own feet. The lookahead could never see past the
    // second waypoint, the stride could never be spent, and the rate came out at 0.89
    // squares per packet — exactly the step engine's — while the engine itself was correct
    // and the tests were green. A position truth that lags the wire is not a truth, and it
    // silently caps the thing that reads it.
    //
    // `step` is retained as a FLOOR, not a ceiling: it is the smallest advance a send can
    // claim, which keeps a zero-distance send from leaving the track stale in time while
    // being unmoved in space. A send that declares two squares moves the track two squares.
    this.sim = { x, y };
    this.simAt = Date.now();
    void step;
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

  // THE GROUND TRUTH, READ WITHOUT SAMPLING IT.
  //
  // Every rate this repository has printed came from differencing a position sampled at SEND
  // time, and every one of them was wrong in a different way, because the sample and the
  // denominator came from different clocks: srv= repeats when no echo arrived between two packets
  // (so 'the server refused' was really 'no echo yet'); 164 of 331 samples were square centres
  // synthesised from col/row because the echo carried no x/y; and dividing a move by `updatedAt`
  // gave 49 squares/second because every no-change echo refreshes it, so the denominator was the
  // frame period.
  //
  // The fix is to stop sampling the echo at moments chosen for a different purpose. This
  // accumulator is updated at the one moment the echo actually arrives, which is the only event
  // that can legitimately change a ground total, and it carries its own clock. Room transitions
  // are excluded at the source — the echo's x/y are room-local, so a new room is a new origin and
  // the delta is not distance: the log showed 51.97 squares in 0.30 s, which is 170 squares/second
  // of nothing. A jump of 12+ squares is a transition or a teleport and is counted as a transition
  // instead of as ground.
  noteGround(x, y) {
    const now = Date.now();
    const prev = this._groundAt;
    // THE SNAPSHOT MUST BE TAKEN BEFORE THE WRITE, AND THE WRITE MUST HAPPEN ON EVERY ECHO,
    // INCLUDING THE ONES THAT MOVED. The first version of this compared the incoming echo against
    // `_groundAt` and then overwrote `_groundAt` unconditionally — so a transition, or any echo
    // that added nothing, replaced the reference position with the new one and the ground between
    // them was lost for ever. Measured: three one-second squares in a row accumulated 2 squares
    // over 1 second instead of 3 over 3, because the 60 s standstill and the transition each
    // reset the clock. A rate that silently drops the time it cannot count is not conservative,
    // it is inflated — which is precisely the failure mode this whole file exists to avoid.
    this._groundAt = { x, y, t: now };
    if (!prev) return;
    const moved = Math.hypot(x - prev.x, y - prev.y);
    const dt = (now - prev.t) / 1000;
    if (dt <= 0) return;
    if (moved >= 12 * 64) {
      // A transition is real elapsed time with no ground under it. Count the time, not the
      // distance, so the rate over a room change is honest rather than flattering.
      this.transitions = (this.transitions ?? 0) + 1;
      this.groundSeconds = (this.groundSeconds ?? 0) + dt;
      return;
    }
    this.groundSeconds = (this.groundSeconds ?? 0) + dt;
    if (moved < 1) return;
    this.groundSquares = (this.groundSquares ?? 0) + moved / 64;
  }

  // Squares per second over the time the character was actually moving, with transitions and
  // standing time excluded by how it is accumulated. Returned with its own denominator, because a
  // rate without one is not a measurement.
  groundRate() {
    const g = this.groundSquares ?? 0, sec = this.groundSeconds ?? 0;
    return { squares: g, seconds: sec, rate: sec > 0 ? g / sec : null, transitions: this.transitions ?? 0 };
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
