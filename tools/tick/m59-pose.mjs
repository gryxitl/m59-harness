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
  }

  // Called by the Sensor each frame with the room-objects self entry (or null).
  // The server echo supersedes the sim's `predicted` flag: a real read clears it.
  updateServer(obj) {
    if (obj && Number.isFinite(obj.col) && Number.isFinite(obj.row)) {
      this.server = {
        col: obj.col, row: obj.row,
        // KOD protocol units (64 per square), matching advance().
        x: Number.isFinite(obj.x) ? obj.x : (obj.col * KOD_FINENESS + KOD_FINENESS / 2),
        y: Number.isFinite(obj.y) ? obj.y : (obj.row * KOD_FINENESS + KOD_FINENESS / 2),
        predicted: obj.predicted === true,
      };
      this.updatedAt = Date.now();
    }
  }

  // Called by the Mover on each accepted send. Advances our feet.
  advance(x, y) {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      this.sim = { x, y };
      this.simAt = Date.now();
    }
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
}

export default Pose;
