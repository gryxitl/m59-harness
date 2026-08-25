#!/usr/bin/env node
// A CHARACTER CONTROLLER. The tick keeper drives a body; this is the body.
//
// It owns its position. Every tick it integrates toward the next waypoint, collide-and-
// slides against the room's BSP, commits where it LANDED, and replicates to the server on
// a separate cadence. The server is a CORRECTION, never the source.
//
// That last part is the whole difference from `m59-mover.mjs`, which has the fields for a
// controller and then overwrites the important one every tick:
//
//     this.drX = protocolToClient(myProtoX);   // "keep DR in sync with current position"
//
// Position re-read from the last server report rather than advanced. And the server DOES
// NOT PUSH OUR POSITION — measured — so with confirmInterval at 2000ms it steers from a
// position up to two seconds old. It cannot believe it has moved, so it can only take one
// square and wait, which is a tenth of walking pace.
//
// The reference implementation is clientd3d/move.c, in this repository's own source tree.
// UserMovePlayer is a fixed-timestep controller: divide the move into sub-steps, and per
// sub-step find the blocking wall and SlideAlongWall. MoveUpdateServer replicates at
// MOVE_INTERVAL and never decides how far the body goes.
//
// AFFORDABLE ONLY SINCE THE DESCENT PRUNE. A fine trace was 76us, which is why nobody put
// one on a 10Hz path; it is 3us now, so collide-and-slide per tick is free.
import { KOD_FINENESS, protocolToClient, clientToProtocol } from './m59-roo.mjs';
import { navPath } from './m59-navgrid.mjs';

const CLIENT_PER_SQUARE = 1024;
const HALF_PROTO = KOD_FINENESS / 2;

// move.c:53,52 — at most 20 sub-steps per move, 200 a second. Sub-stepping is not
// decoration: a single long trace can tunnel a corner that four short ones catch, and
// sliding changes direction mid-move so one segment is not equivalent.
export const STEPS_PER_MOVE = 20;
export const NUM_STEPS_PER_SECOND = 200;

// draw3d.h:53 — MOVEUNITS is FINENESS>>2 per 100ms: a quarter square per tick walking,
// half running. 2.5 and 5 squares a second, which is what a person does.
export const WALK_CLIENT_PER_MS = (CLIENT_PER_SQUARE / 4) / 100;
export const RUN_CLIENT_PER_MS = (CLIENT_PER_SQUARE / 2) / 100;

// move.c:57,58 — replication, and ONLY replication. INCOMING_PACKET_THROTTLE is 5
// (user.kod:50), so this stays at 1Hz however fast the body moves.
export const MOVE_INTERVAL_MS = 1000;
export const MOVE_THRESHOLD_CLIENT = CLIENT_PER_SQUARE / 4;

// How far off a confirmation may be before we believe it over ourselves. Under this we
// keep our own position: a confirmation is a square-granular read of a body that has moved
// on since, so snapping to it every time would undo the integration this exists to do.
export const RECONCILE_SNAP_CLIENT = CLIENT_PER_SQUARE;

export class CharacterController {
  constructor(session, { run = false } = {}) {
    this.session = session;
    this.run = run;
    // THE SIMULATION STATE. This is what persists; everything else is derived.
    this.x = null;              // client units — ours, not the server's
    this.y = null;
    this.path = null;           // [{x,y}] client units
    this.pathIdx = 0;
    this.dest = null;           // {x,y} client units
    // Replication
    this._lastSentAt = 0;
    this._lastSentX = null;
    this._lastSentY = null;
    // Diagnostics that answer the questions this driver has been unable to answer
    this.stats = { ticks: 0, slid: 0, blocked: 0, sent: 0, reconciled: 0,
                   drift_max: 0, arrived: 0, replans: 0 };
  }

  // Adopt the server's position as the starting truth. Called on a new destination, a room
  // change, or when a confirmation disagrees beyond RECONCILE_SNAP_CLIENT.
  syncFrom(me) {
    if (!me) return false;
    const px = me.x ?? (me.col * KOD_FINENESS + HALF_PROTO);
    const py = me.y ?? (me.row * KOD_FINENESS + HALF_PROTO);
    this.x = protocolToClient(px);
    this.y = protocolToClient(py);
    return true;
  }

  clear() { this.path = null; this.pathIdx = 0; this.dest = null; }

  // A new destination in SQUARES. Pathing is navPath: free space, synchronous, ~1ms.
  setDestination(geo, col, row, me) {
    if (this.x == null) this.syncFrom(me);
    const to = { x: (col - 0.5) * CLIENT_PER_SQUARE, y: (row - 0.5) * CLIENT_PER_SQUARE };
    const plan = navPath(geo, { x: this.x, y: this.y }, to);
    this.stats.replans++;
    if (!plan.found) { this.clear(); return { ok: false, reason: plan.reason }; }
    this.path = plan.waypoints;
    this.pathIdx = 0;
    this.dest = to;
    return { ok: true, waypoints: plan.waypoints.length };
  }

  // RECONCILE, NEVER ADOPT. A confirmation is square-granular and already stale; snapping
  // to it every tick would throw away the integration. Only a disagreement larger than a
  // square means we are actually wrong.
  reconcile(confirmed) {
    if (!confirmed || this.x == null) return false;
    const cx = (confirmed.col - 0.5) * CLIENT_PER_SQUARE;
    const cy = (confirmed.row - 0.5) * CLIENT_PER_SQUARE;
    const drift = Math.hypot(cx - this.x, cy - this.y);
    if (drift > this.stats.drift_max) this.stats.drift_max = drift;
    if (drift <= RECONCILE_SNAP_CLIENT) return false;
    this.x = cx; this.y = cy;
    this.stats.reconciled++;
    this.path = null;                 // our belief was wrong; the plan rests on it
    return true;
  }

  // ONE TICK. Synchronous, no awaits, no promises — the loop forbids them.
  step(dt, { geo, client }) {
    this.stats.ticks++;
    if (this.x == null || !geo?.collisionReady) return { state: 'no-position' };
    if (!this.path || this.pathIdx >= this.path.length) {
      if (!this.dest) return { state: 'idle' };
      const d = Math.hypot(this.dest.x - this.x, this.dest.y - this.y);
      if (d <= MOVE_THRESHOLD_CLIENT) { this.stats.arrived++; this.clear(); return { state: 'arrived' }; }
      return { state: 'no-path' };
    }

    const wp = this.path[this.pathIdx];
    const dx = wp.x - this.x, dy = wp.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) { this.pathIdx++; return { state: 'moving', advanced: true }; }

    // STEER: speed x dt, never further than the waypoint.
    const speed = this.run ? RUN_CLIENT_PER_MS : WALK_CLIENT_PER_MS;
    const travel = Math.min(speed * dt, dist);
    const aimX = this.x + (dx / dist) * travel;
    const aimY = this.y + (dy / dist) * travel;

    // COLLIDE AND SLIDE, IN SUB-STEPS. move.c does this because a single long trace can
    // tunnel and because sliding changes direction mid-move.
    const subs = Math.max(1, Math.min(STEPS_PER_MOVE,
      Math.round(NUM_STEPS_PER_SECOND * dt / 1000)));
    let cx = this.x, cy = this.y, slid = false, blocked = false;
    for (let i = 0; i < subs; i++) {
      const tx = this.x + (aimX - this.x) * ((i + 1) / subs);
      const ty = this.y + (aimY - this.y) * ((i + 1) / subs);
      let t;
      try { t = geo.traceFineMoveClient(cx, cy, tx, ty, { slide: true }); }
      catch { blocked = true; break; }
      if (!t?.available) { blocked = true; break; }
      const nx = t.x ?? cx, ny = t.y ?? cy;
      if (t.blocked) blocked = true;
      if (t.slid) slid = true;
      // A sub-step that goes nowhere means the wall is in front of us, not beside us.
      if (Math.hypot(nx - cx, ny - cy) < 0.5) { blocked = true; cx = nx; cy = ny; break; }
      cx = nx; cy = ny;
    }
    if (slid) this.stats.slid++;
    if (blocked) this.stats.blocked++;

    // COMMIT WHERE IT LANDED. Never where it aimed — that is the difference between a
    // controller and a wish, and on a server with no geometry validation it is the
    // difference between walking and standing inside a wall.
    this.x = cx; this.y = cy;

    if (Math.hypot(wp.x - this.x, wp.y - this.y) <= MOVE_THRESHOLD_CLIENT) this.pathIdx++;

    // A blocked tick with no progress means the plan is wrong, not the body.
    if (blocked && !slid) { this.path = null; return { state: 'blocked', at: this.square() }; }

    this.replicate(client);
    return { state: 'moving', at: this.square(), slid };
  }

  // REPLICATION IS NOT MOVEMENT. move.c:745,772 — report when the interval has passed AND
  // we are far enough from what we last reported. The throttle is why this stays at 1Hz
  // however fast the body is moving.
  replicate(client, force = false) {
    const now = Date.now();
    if (!force) {
      if (now - this._lastSentAt < MOVE_INTERVAL_MS) return false;
      if (this._lastSentX != null) {
        const moved = Math.hypot(this.x - this._lastSentX, this.y - this._lastSentY);
        if (moved < MOVE_THRESHOLD_CLIENT) return false;
      }
    }
    const px = Math.round(clientToProtocol(this.x));
    const py = Math.round(clientToProtocol(this.y));
    try { client.moveTo(px, py, this.run ? 32 : 18, client.room?.id); } catch { return false; }
    this._lastSentAt = now; this._lastSentX = this.x; this._lastSentY = this.y;
    this.stats.sent++;
    return true;
  }

  square() {
    return { col: Math.floor(this.x / CLIENT_PER_SQUARE) + 1,
             row: Math.floor(this.y / CLIENT_PER_SQUARE) + 1 };
  }
}
