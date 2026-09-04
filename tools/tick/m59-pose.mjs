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
//   - The server echoes our position ~1/s (BP_MOVE), which corrects us.
//   - While a send is FRESH (< SIM_FRESH_MS) we trust our own feet (the sim);
//     otherwise we trust the last server echo.
//   - `predicted` distinguishes "server said so" from "we think so".
//
// OWNERSHIP: the Sensor calls updateServer() each frame with the room-objects
// self entry; the Mover calls advance() on each send and reset() on
// teleport/blink/room change. Every other tick file reads ONLY current().
//
// This is a pure data holder: no client, no pacer, no geometry. It can be unit
// tested with no network.

const SIM_FRESH_MS = 2000;

export class Pose {
  constructor() {
    this.server = null;   // { col, row, x, y, predicted } — last server echo
    this.sim = null;      // { x, y } — dead-reckoned feet
    this.simAt = 0;       // wall-clock ms of the last advance()
    this.updatedAt = 0;   // wall-clock ms of the last updateServer()
  }

  // Called by the Sensor each frame with the room-objects self entry (or null).
  // The server echo supersedes the sim's `predicted` flag: a real read clears it.
  updateServer(obj) {
    if (obj && Number.isFinite(obj.col) && Number.isFinite(obj.row)) {
      this.server = {
        col: obj.col, row: obj.row,
        x: Number.isFinite(obj.x) ? obj.x : (obj.col * 1024 + 512),
        y: Number.isFinite(obj.y) ? obj.y : (obj.row * 1024 + 512),
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

  get _simFresh() {
    return this.sim != null && (Date.now() - this.simAt) < SIM_FRESH_MS;
  }

  // THE single read. Returns { col, row, x, y, predicted, source, stale }.
  //   source: 'sim' (fresh dead-reckoning) | 'server' (last echo) | 'none'
  //   stale:  true when neither source is available.
  current() {
    if (this._simFresh) {
      const col = Math.floor(this.sim.x / 1024);
      const row = Math.floor(this.sim.y / 1024);
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
