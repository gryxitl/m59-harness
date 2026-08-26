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
import { tracePath } from './m59-navtrace.mjs';

// WHICH PLANNER STEERS, AND THE MIDDLE SETTING IS THE POINT.
//
// The two planners disagree because the two COLLISION MODELS disagree — `moverStepLands`
// allows 17-54% more steps than `traceFineMoveClient`, and on the floored subset the residual
// is 8-25%, all of it geometry_blocked. Until that is closed, `trace` refuses walks the fleet
// makes all day, so it is not the default.
//
//   off      navPath steers. What the fleet did before any of this.
//   shadow   navPath steers, tracePath is computed alongside and the disagreements counted.
//            Measures without changing behaviour.
//   on       tracePath steers, falling back to navPath when it refuses. THE DEFAULT.
//   strict   tracePath steers and a refusal is a refusal. This is the mode that actually
//            tests the thing: on the bench `on` fell back on 775 of 891 walks, so it steered
//            by grid 87% of the time and would have reported that as trace-driven movement.
//            A character that stands still under `strict` is the finding, not a malfunction.
const NAV_MODE = (process.env.M59_NAV_TRACE || 'on').toLowerCase();

export const CLIENT_PER_SQUARE = 1024;
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

// HOW FAR THE BODY COULD POSSIBLY HAVE WALKED, plus a square of slack. A server position
// further away than this is not our own echo arriving late — it is the server having MOVED us
// (a blink, a portal, a death), which is the one case clientd3d/move.c accepts a position for
// the player outside a room change. Anything inside it is the echo of our own last report and
// is ignored, exactly as the real client ignores it.
export const TELEPORT_SLACK_CLIENT = CLIENT_PER_SQUARE;

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
    this.stats = { ticks: 0, slid: 0, blocked: 0, sent: 0, serverMoved: 0,
                   arrived: 0, replans: 0 };
  }

  // Adopt the server's position as the starting truth. Called when we have no position yet
  // and on a room change — the two places clientd3d takes a position for the player.
  syncFrom(me) {
    if (!me) return false;
    const px = me.x ?? (me.col * KOD_FINENESS + HALF_PROTO);
    const py = me.y ?? (me.row * KOD_FINENESS + HALF_PROTO);
    this.x = protocolToClient(px);
    this.y = protocolToClient(py);
    return true;
  }

  clear() { this.path = null; this.pathIdx = 0; this.dest = null; }

  // A new destination in SQUARES. navPath is ~1ms over a baked grid; tracePath is ~10ms and
  // asks the mover's own question. See NAV_MODE.
  setDestination(geo, col, row, me) {
    if (this.x == null) this.syncFrom(me);
    const to = { x: (col - 0.5) * CLIENT_PER_SQUARE, y: (row - 0.5) * CLIENT_PER_SQUARE };
    const from = { x: this.x, y: this.y };
    this.stats.replans++;

    const grid = (NAV_MODE === 'on' || NAV_MODE === 'strict') ? null : navPath(geo, from, to);
    let traced = null;
    if (NAV_MODE !== 'off') {
      const t0 = Date.now();
      try { traced = tracePath(geo, from, to); } catch (err) { traced = { waypoints: [], blocked: true, error: String(err?.message || err) }; }
      this.stats.trace_ms = (this.stats.trace_ms || 0) + (Date.now() - t0);
      this.stats.trace_plans = (this.stats.trace_plans || 0) + 1;
      if (traced.blocked) this.stats.trace_blocked = (this.stats.trace_blocked || 0) + 1;
    }

    // The comparison is only meaningful where both were asked, so it lives in shadow.
    if (NAV_MODE === 'shadow' && grid && traced) {
      if (grid.found && traced.blocked) this.stats.trace_stricter = (this.stats.trace_stricter || 0) + 1;
      else if (!grid.found && !traced.blocked) this.stats.trace_looser = (this.stats.trace_looser || 0) + 1;
      else if (grid.found && !traced.blocked) {
        this.stats.trace_agreed = (this.stats.trace_agreed || 0) + 1;
        // Both found one; a much longer traced route is a detour AROUND something the grid
        // walked straight through, which is the same disagreement wearing a different hat.
        const g = grid.waypoints.length, t = traced.waypoints.length;
        if (t > g * 1.5 + 2) this.stats.trace_detoured = (this.stats.trace_detoured || 0) + 1;
      }
    }

    let plan, steeredBy = 'grid';
    if (NAV_MODE === 'on' || NAV_MODE === 'strict') {
      if (traced && !traced.blocked) { plan = { found: true, waypoints: traced.waypoints }; steeredBy = 'trace'; }
      else if (NAV_MODE === 'strict') { plan = { found: false, reason: 'trace_blocked' }; steeredBy = 'trace'; }
      else {
        plan = navPath(geo, from, to);
        this.stats.trace_fellback = (this.stats.trace_fellback || 0) + 1;
      }
    } else plan = grid;
    this.stats[`steered_${steeredBy}`] = (this.stats[`steered_${steeredBy}`] || 0) + 1;

    if (!plan.found) { this.clear(); return { ok: false, reason: plan.reason }; }
    this.path = plan.waypoints;
    this.pathIdx = 0;
    this.dest = to;
    return { ok: true, waypoints: plan.waypoints.length, planner: steeredBy };
  }

  // THE SERVER MOVED US — SNAP, AND RESET THE REPORTING BASELINE.
  //
  // This replaces a periodic reconcile that did not belong here at all. `clientd3d/move.c`
  // never corrects the player toward the server during ordinary movement: `server_x/server_y`
  // are the client's record of WHAT IT LAST TOLD THE SERVER, and MoveUpdatePosition compares
  // the player's position against that to decide whether to speak again. The only two places
  // the server sets the player's position are entering a room (game.c:379) and an explicit
  // object-move for the player (moveobj.c:88), and the latter returns early with the comment
  // "Don't interpolate or animate our own motion" and calls ServerMovedPlayer — whose whole
  // body is `server_x = motion.x; server_y = motion.y`. It does not move the player; it resets
  // the baseline so we do not immediately re-send a position the server just dictated.
  //
  // We had it inverted: we polled the server's echo of our OWN last report every second,
  // treated it as truth, and dragged the believed position toward it — measuring our own
  // latency and calling it error. That is what produced a believed position 2 to 46 squares
  // from the body, and with it 2,276 refused plans ("no free space at the start", "no route
  // through free space") and a third of all movement handed to the legacy mover.
  serverMovedPlayer(col, row) {
    if (!Number.isFinite(col) || !Number.isFinite(row)) return false;
    this.x = (col - 0.5) * CLIENT_PER_SQUARE;
    this.y = (row - 0.5) * CLIENT_PER_SQUARE;
    this.path = null; this.pathIdx = 0;      // the plan was made from somewhere we no longer are
    this._lastSentX = this.x; this._lastSentY = this.y;   // ServerMovedPlayer's whole job
    this._lastSentAt = Date.now();
    this.stats.serverMoved = (this.stats.serverMoved ?? 0) + 1;
    return true;
  }

  // ONE TICK. Synchronous, no awaits, no promises — the loop forbids them.
  step(dt, { geo, client }) {
    this.stats.ticks++;
    if (this.x == null || !geo?.collisionReady) return { state: 'no-position' };
    if (!this.path || this.pathIdx >= this.path.length) {
      if (!this.dest) return { state: 'idle' };
      // ARRIVAL IS A SQUARE, NOT A POINT.
      //
      // This measured the distance to the destination's exact centre against a quarter of a
      // square, so a body standing squarely ON the target — the thing every caller actually
      // asks for — reported `no-path` whenever it settled more than 256 units off centre.
      //
      // Watched on JayB in the Raza Inn: an eight-by-eleven room, one region, a 24-waypoint
      // plan, zero blocked ticks, and the run ended AT (6,1) — the exit staging square — and
      // still answered no-path. The router read that as a failed leg and logged
      // `geometry_blocked`, so he could not walk out of a room with nothing in the way.
      //
      // The callers judge arrival by square (`me.col === standOn.col && me.row === standOn.row`
      // in m59-route.mjs), so this does too, and keeps the distance test as the finer of the
      // two answers rather than the only one.
      const here = this.square();
      const want = { col: Math.floor(this.dest.x / CLIENT_PER_SQUARE) + 1,
                     row: Math.floor(this.dest.y / CLIENT_PER_SQUARE) + 1 };
      const d = Math.hypot(this.dest.x - this.x, this.dest.y - this.y);
      if (d <= MOVE_THRESHOLD_CLIENT || (here.col === want.col && here.row === want.row)) {
        this.stats.arrived++; this.clear(); return { state: 'arrived' };
      }
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
    const beforeX = this.x, beforeY = this.y;
    const startSq = this.square();
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

      // DO NOT SLIDE INTO ROCK.
      //
      // The fine tracer answers from the BSP alone, so a slide along a wall will happily
      // deposit the body on a square the coarse grid calls solid. `moverStepLands` refuses
      // exactly that (`walkable(toRow,toCol)`) and this did not, so the controller could put
      // the body somewhere the planner cannot plan FROM — and that is where it then sat.
      //
      // Measured on JayB: of ten distinct positions the controller gave up from, SEVEN were
      // coarse-unwalkable, while all sixty-three destinations it was aiming at were fine. The
      // plans were never the problem; the body was in rock.
      //
      // The origin square is exempt: a body already standing on one has to be able to leave.
      if (geo.walkable) {
        const sq = { col: Math.floor(nx / CLIENT_PER_SQUARE) + 1,
                     row: Math.floor(ny / CLIENT_PER_SQUARE) + 1 };
        if ((sq.col !== startSq.col || sq.row !== startSq.row) && !geo.walkable(sq.row, sq.col)) {
          blocked = true;
          break;                      // keep the last good position; do not commit this one
        }
      }
      cx = nx; cy = ny;
    }
    if (slid) this.stats.slid++;
    if (blocked) this.stats.blocked++;

    // COMMIT WHERE IT LANDED. Never where it aimed — that is the difference between a
    // controller and a wish, and on a server with no geometry validation it is the
    // difference between walking and standing inside a wall.
    this.x = cx; this.y = cy;

    if (Math.hypot(wp.x - this.x, wp.y - this.y) <= MOVE_THRESHOLD_CLIENT) this.pathIdx++;

    // A BLOCKED TICK IS NOT AUTOMATICALLY A BAD PLAN. The body is a disc and the path is a
    // line through cell centres, so clipping a corner and sliding is the ORDINARY case —
    // it is what collide-and-slide is for. Throwing the plan away on every contact makes
    // the controller replan its way across a room instead of walking it.
    //
    // So: contact that still made ground is progress, contact that made none is a waypoint
    // the body cannot reach directly. Skip that waypoint first — the next one is usually
    // reachable, because a path through free space rarely has two bad legs in a row — and
    // only give the plan up when skipping stops helping.
    if (blocked) {
      const gained = Math.hypot(this.x - beforeX, this.y - beforeY);
      if (gained < 1) {
        this._deadLegs = (this._deadLegs ?? 0) + 1;
        if (this._deadLegs >= 3) {
          this._deadLegs = 0;
          this.path = null;
          return { state: 'blocked', at: this.square() };
        }
        this.pathIdx++;                       // try the next waypoint along
        if (this.pathIdx >= this.path.length) { this.path = null; return { state: 'blocked', at: this.square() }; }
        return { state: 'moving', at: this.square(), skipped: true };
      }
      this._deadLegs = 0;
    } else this._deadLegs = 0;

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
