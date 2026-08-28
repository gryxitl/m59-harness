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
import { MIN_SIDE_MOVE, KOD_FINENESS, protocolToClient, clientToProtocol } from './m59-roo.mjs';
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

// What each sector depth does to movement speed — clientd3d/move.c:196-201, indexed by the
// depth the sector flags carry (SF_DEPTH0..3). The client computes these as integer
// divisions of move_distance; the same three fractions expressed directly.
export const WADE_FACTORS = [1, 3 / 4, 1 / 2, 1 / 4];

// THE STRANDED ESCAPE HOP -- see the long note in `_step`. A body on a floorless point
// cannot microstep out, because every fraction of a tick's travel lands in the same hole.
// The floor of the search is just over a third of a square because that is where the
// measured pocket ended (384 refused, 448 arrived, r587); the ceiling is a square and a
// half, which is under `m59-game.mjs`'s own three-square recovery radius and far too
// short to cross anything. Headings are tried nearest the planned one first, out to a
// right angle either side, so the hop follows the route when it can and merely finds
// floor when it cannot.
export const STRANDED_ESCAPE_MIN = 384;
export const STRANDED_ESCAPE_MAX = 1536;
export const STRANDED_ESCAPE_STEP = 64;
export const STRANDED_ESCAPE_TURNS = [0, Math.PI / 8, -Math.PI / 8, Math.PI / 4, -Math.PI / 4,
                                      3 * Math.PI / 8, -3 * Math.PI / 8, Math.PI / 2, -Math.PI / 2];

// move.c:57,58 — replication, and ONLY replication. INCOMING_PACKET_THROTTLE is 5
// (user.kod:50), so this stays at 1Hz however fast the body moves.
export const MOVE_INTERVAL_MS = 1000;
export const MOVE_THRESHOLD_CLIENT = CLIENT_PER_SQUARE / 4;

// How much nearer the current waypoint a BLOCKED tick must get before it counts as
// progress rather than a dead leg. One client unit: the bar is deliberately almost
// nothing, because the point is the SIGN of the movement, not its size. A slide that
// carries the body along its route closes distance; a slide along a wall it is pressed
// against does not, and used to reset the dead-leg counter anyway.
export const MIN_CLOSING_CLIENT = 1;

// WHAT COUNTS AS THE SERVER HAVING MOVED US, and why it is a big number.
//
// BP_MOVE is our own last report echoed back, and it lags: the round trip plus however long
// the server took to walk the body there, measured at a ~1.2s median on this fleet. At walk
// speed that echo is legitimately 3 squares behind and at run speed 6, so any threshold near
// the per-tick walk budget fires on ordinary latency — the first attempt used one and snapped
// 483 times in 3,895 ticks, which is the correction loop this was meant to delete, wearing a
// different name.
//
// A real relocation is not subtle. A blink crosses a room, a portal changes the world, a death
// moves you to the Underworld. Ten squares separates the two cleanly and cheaply, without
// reintroducing a ring of past beliefs to diff against.
export const TELEPORT_SQUARES = 10;

// AND A FLOOR UNDER ORDINARY DIVERGENCE, which the real client does not need and we do.
//
// clientd3d/move.c never corrects the player toward the server, and reading that I deleted our
// reconciliation entirely. That was the wrong lesson. The real client CANNOT diverge: it owns
// the position and the server accepts whatever it reports, so its belief is the truth by
// definition. Ours is not — our moves can fail to take effect, and with nothing pulling us
// back we integrate forward against a body that never moved.
//
// Measured on JayB: the controller believed (46,40) while the server had him at (44,31), nine
// squares apart and growing, so navPath planned from the fiction and answered "no route
// through free space" for a journey that routes in 65 waypoints from his real square. A
// hand-issued walkTo moved him instantly, because walkTo re-reads the server every time.
//
// So: not the old per-second reconcile, which chased round-trip lag and threw away working
// plans. A gap this large is not lag — the echo runs 3 to 6 squares behind at walking speed —
// and it must persist across two checks a second apart before we act on it.
export const DIVERGENCE_SQUARES = 6;

// HOW FAR THE BELIEF MAY RUN AHEAD OF THE SERVER BEFORE WE STOP INTEGRATING.
//
// The divergence floor above snaps the belief back when it has run away, and that is what the
// operator saw as rubberbanding: the body walks to a boundary where its moves stop taking
// effect, the belief keeps integrating, hits six squares, and is yanked back eight squares to
// the server's word — over and over, never crossing.
//
// The cure is not a faster snap, it is not running ahead. The echo legitimately trails 3 to 6
// squares at walking speed, so a lead inside that is prediction working as intended; beyond it
// the server is plainly not following and integrating further only builds a bigger correction.
// So we hold position and let the confirmations catch up, which reads as a brief stall rather
// than a rubberband and leaves the belief close enough that no snap is ever needed.
export const MAX_LEAD_SQUARES = 4;

// A PLAN OVER SQUARE CENTRES, VALIDATED BY THE MOVER'S OWN PREDICATE.
//
// `geo.path({ collision: true })` walks the square grid with `moverStepLands` on every edge,
// which is the question "will the mover take this step" rather than "is there free space
// here". Its output is squares; the controller steers in client units, so the centres are
// what it is handed — and a centre is the one point in a square the geometry is known to
// accept, which is why these plans survive contact with the tracer when free-cell waypoints
// do not. Returns null when there is no such route, so the caller can fall further back.
function squarePlan(geo, from, to) {
  if (typeof geo?.path !== 'function') return null;
  const sqOf = (v) => Math.floor(v / CLIENT_PER_SQUARE) + 1;
  const fc = sqOf(from.x), fr = sqOf(from.y), tc = sqOf(to.x), tr = sqOf(to.y);
  let p;
  try { p = geo.path(fr, fc, tr, tc, { collision: true }); } catch { return null; }
  if (!p?.found || !p.steps?.length) return null;
  return { found: true,
           waypoints: p.steps.map(st => ({ x: (st.col - 0.5) * CLIENT_PER_SQUARE,
                                           y: (st.row - 0.5) * CLIENT_PER_SQUARE })) };
}

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
        // THE TRACE IS BLOCKED. FALL BACK TO THE PLANNER WHOSE STEPS THE MOVER CAN TAKE.
        //
        // This fell back to navPath, which plans through FREE-SPACE CELLS of 256 units.
        // Those are not places a body can be steered between: the first waypoint is often a
        // SUB-SQUARE hop, and aiming at something that close slides the body along whatever
        // wall it is already near and leaves it in the same square. No square progress, so
        // the stall detector re-centres it, so it slides into the same spot again — a closed
        // loop that only a keeper restart broke.
        //
        // Measured offline on the two squares that held the fleet all night. Following
        // navPath's plan with the real tracer: Cor Noth (68,29) STOPS after 3 steps, still
        // on (68,29); the King's Way (13,39) stops on (14,39). Following geo.path's plan,
        // whose edges are validated by `moverStepLands` — the mover's own predicate — over
        // SQUARE CENTRES: Cor Noth walks all 18 steps to (69,31), the King's Way all 64 to
        // (15,39). Same geometry, same tracer, same destinations.
        //
        // navPath stays as the last resort, because it can squeeze through a clearance seam
        // that the square planner refuses outright — that is what gets a body off a ledge —
        // and a plan that is hard to walk still beats no plan at all.
        // BUT FIRST: ASK AGAIN FROM WHERE THE BODY COULD LEGALLY STAND.
        //
        // A blocked trace is usually not a statement about the ROUTE, it is a statement
        // about the ORIGIN. A body pressed into geometry inside an otherwise good square
        // refuses every plan drawn from where it is pressed, while the same plan from that
        // square's stand point is clean. Measured in room 150 to a target ONE SQUARE south:
        // from the body's real point (70256,29440) tracePath is blocked with no waypoints;
        // from the stand point (70144,29184) it returns 155 and walks.
        //
        // Falling straight through to a weaker planner is what made this fatal rather than
        // slow. The fallbacks plan from the same jammed point, and to a target one square
        // away they return a near-straight line — which aims the body back into the wall it
        // is already against. It slides deeper, the next plan is refused for the same
        // reason, and the body re-jams itself faster than the eight-tick resync can
        // re-centre it. Kage, Lee and Sasquatch held (69,29) that way for over two hours,
        // aim reading 10 to 15 units due south on every sample.
        //
        // So recover the origin before weakening the planner: re-ask from the stand point,
        // and if that plans, make the stand point the first waypoint so the body walks out
        // of the jam and then follows a route it can actually take. This is the same cure
        // the blocked-resync applies, asked at plan time instead of eight ticks later, and
        // it can only ever steer a body to the one position in its own square that the
        // geometry calls clear.
        const here = this.square();
        const stand = { x: (here.col - 0.5) * CLIENT_PER_SQUARE,
                        y: (here.row - 0.5) * CLIENT_PER_SQUARE };
        let rescued = null;
        if (Math.hypot(stand.x - from.x, stand.y - from.y) >= 1) {
          try {
            const t2 = tracePath(geo, stand, to);
            if (t2 && !t2.blocked && t2.waypoints?.length) rescued = t2;
          } catch { /* the rescue is best-effort; the fallbacks below still apply */ }
        }
        if (rescued) {
          plan = { found: true, waypoints: [stand, ...rescued.waypoints] };
          steeredBy = 'standpoint';
          this.stats.trace_rescued = (this.stats.trace_rescued || 0) + 1;
        } else {
          const sq = squarePlan(geo, from, to);
          if (sq) { plan = sq; steeredBy = 'squares'; }
          else {
            plan = navPath(geo, from, to);
            this.stats.trace_fellback = (this.stats.trace_fellback || 0) + 1;
          }
        }
      }
    } else plan = grid;
    this.stats[`steered_${steeredBy}`] = (this.stats[`steered_${steeredBy}`] || 0) + 1;

    if (!plan.found) { this.clear(); return { ok: false, reason: plan.reason }; }
    // DROP THE WAYPOINTS WE ARE ALREADY STANDING ON.
    //
    // `navPath` plans through free-space cells of 256 units, so its first waypoints are
    // routinely a fraction of a square from the body — and the last resort is exactly when
    // it gets used, because `tracePath` is blocked and `squarePlan` found nothing. Aiming
    // at a point two units away asks the stepper for a two-unit move, which slides along
    // whatever wall the body is already against and arrives nowhere.
    //
    // JayB, 2026-08-28, room 50 at (2,48) with one open neighbour: `ctlAt=1783,48775` and
    // `aim=1782,48777` — a two-unit aim — with 36,189 side-steps, 12,694 blocked steps and
    // `arrived=0`. The plan was 40 waypoints long and he never left the first one.
    //
    // A waypoint inside the arrival threshold is already reached by the controller's own
    // definition (`pathIdx++` uses the same test below), so starting there wastes ticks.
    // At least one waypoint is always kept: a plan trimmed to nothing would clear the
    // destination and look like an arrival.
    const wps = plan.waypoints;
    let start = 0;
    while (start < wps.length - 1
           && Math.hypot(wps[start].x - this.x, wps[start].y - this.y) <= MOVE_THRESHOLD_CLIENT) {
      start++;
    }
    if (start > 0) this.stats.waypointsPreDropped = (this.stats.waypointsPreDropped ?? 0) + start;
    this.path = start > 0 ? wps.slice(start) : wps;
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
  //
  // AND THE SNAP TAKES THE FINE POSITION WHEN THERE IS ONE. `ServerMovedPlayer`'s body is
  // `server_x = motion.x`, and `motion.x` is a FINE coordinate — the square centre is our
  // approximation of it, not the client's behaviour. The approximation is not free: a
  // centre can be a point with no floor under it while the body's actual position, in the
  // same square, has floor. Then every plan drawn from the centre answers
  // `destination_has_no_floor`, the `stranded` allowance cannot help because the origin it
  // is asked about is fabricated, and the blocked-resync path re-centres on the same dead
  // point every time it fires.
  //
  // JayB, 2026-08-27, r587 (30,14): real position (29728,13520) steps to the first
  // waypoint cleanly; the centre (30208,13824) refuses it. 243 resyncs, 10,972 blocked
  // microsteps and ZERO packets sent — he had never moved once.
  //
  // The fine pair is only trusted when it lands in the square the server named; a pair
  // that disagrees is a stale echo, and then the centre is the honest answer.
  //
  // AND OMITTING THE PAIR IS A REQUEST, NOT AN OVERSIGHT. The blocked-resync in
  // `m59-controller-mover.mjs` calls this with the square alone on purpose: there the fine
  // position is what has gone wrong -- the square is good and the body is pressed into
  // geometry inside it -- and re-centring on the stand point is the whole cure. Do not
  // "fix" that caller by handing it the fine coordinates; that re-adopts the jam.
  serverMovedPlayer(col, row, px, py) {
    if (!Number.isFinite(col) || !Number.isFinite(row)) return false;
    let fx = null, fy = null;
    if (Number.isFinite(px) && Number.isFinite(py)) {
      const cx = protocolToClient(px), cy = protocolToClient(py);
      if (Math.floor(cx / CLIENT_PER_SQUARE) + 1 === col
          && Math.floor(cy / CLIENT_PER_SQUARE) + 1 === row) { fx = cx; fy = cy; }
      else this.stats.fineRejected = (this.stats.fineRejected ?? 0) + 1;
    }
    if (fx != null) this.stats.fineAdopted = (this.stats.fineAdopted ?? 0) + 1;
    this.x = fx != null ? fx : (col - 0.5) * CLIENT_PER_SQUARE;
    this.y = fy != null ? fy : (row - 0.5) * CLIENT_PER_SQUARE;
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
    //
    // WADING SLOWS THE PLAYER DOWN, and getting this wrong is not cosmetic. The belief
    // integrates at whatever speed we say; the real body moves at whatever speed the
    // SERVER's copy of the client would. In deep water that is a factor of four, so a
    // belief running at full speed pulls steadily ahead of the echo — which is precisely
    // the divergence that shows up as rubberbanding, and as the lead-holds that stalled
    // travel earlier today. A movement model that ignores terrain manufactures its own lag.
    //
    //   clientd3d/move.c:194   // Wading slows player movement down.
    //                          depth = GetPointDepth(motion.x, motion.y)
    //                          SF_DEPTH1 -> * 3/4    SF_DEPTH2 -> / 2    SF_DEPTH3 -> / 4
    //
    // Measured at the BODY's point, as the client does — not at the waypoint and not
    // averaged along the step, so entering and leaving water changes speed exactly where
    // the client changes it. Unknown depth means full speed: no geometry is no reason to
    // crawl.
    const baseSpeed = this.run ? RUN_CLIENT_PER_MS : WALK_CLIENT_PER_MS;
    let depthIdx = 0;
    try { depthIdx = geo.depthIndexAtClient?.(this.x, this.y) ?? 0; } catch { depthIdx = 0; }
    const wade = WADE_FACTORS[depthIdx] ?? 1;
    if (wade !== 1) this.stats.wadingTicks = (this.stats.wadingTicks ?? 0) + 1;
    const speed = baseSpeed * wade;
    const travel = Math.min(speed * dt, dist);
    const aimX = this.x + (dx / dist) * travel;
    const aimY = this.y + (dy / dist) * travel;
    this._lastAim = { x: aimX, y: aimY };   // diagnostic only

    // COLLIDE AND SLIDE, THE WAY clientd3d/move.c ACTUALLY DOES IT.
    //
    // The real client's per-step collision is four things and NO walkability grid:
    //
    //   1. floor:  BSPFindLeafByPoint — a null leaf or sector refuses the move
    //   2. walls:  FindIntersection over the BSP, then SlideAlongWall
    //   3. RETRY:  FindIntersection again; if still blocked, SlideAlongWall again
    //   4. SIDE:   step MIN_SIDE_MOVE at angle+270, then at angle+90, then give up
    //
    // and `IsInRoom` is only `row >= 0 && row < rows && col >= 0 && col < cols` — a bounds
    // test. Nothing client-side consults a per-square passable table for a player move.
    //
    // We had both halves wrong. We vetoed on the coarse `walkable` grid, which is a SERVER
    // artifact the client never asks about, and we gave up after ONE slide where the client
    // tries two slides and two perpendicular side-steps. Between them those produced bodies
    // that reported zero of eight directions passable while standing somewhere the game was
    // perfectly happy with — JayB and Lee both immobilised in the Deep Forest of Farol, with
    // every downstream fix helpless because each one needed a legal step to exist.
    let subs = Math.max(1, Math.min(STEPS_PER_MOVE,
      Math.round(NUM_STEPS_PER_SECOND * dt / 1000)));
    const beforeX = this.x, beforeY = this.y;
    let cx = this.x, cy = this.y, slid = false, blocked = false;

    // One attempt at a target, returning where it landed or null if it went nowhere. The
    // tracer's own `slide` covers FindIntersection + SlideAlongWall.
    // Is our own leaf unresolvable? Then judge the DESTINATION only, as move.c does — see
    // allowNoStartFloor. A body standing on such a spot is not stuck in the game, only in us.
    let stranded = false;
    try { stranded = geo.floorBaseAtClient(this.x, this.y, geo.leafAtClient(this.x, this.y), {}) == null; }
    catch { stranded = false; }
    if (stranded) this.stats.stranded = (this.stats.stranded ?? 0) + 1;

    // LEAVING THE ROOM IS A DECISION, AND WALKING IS NOT HOW IT IS MADE.
    //
    // move.c documents this four lines above and we never applied it. The real client tests
    // IsInRoom on the destination and, when it fails, REFUSES THE MOVE LOCALLY — `x = last_x;
    // y = last_y; break;` — and sends a separate speed-0 request instead. It never walks a
    // body out of a room by accident, because it cannot.
    //
    // We could, and did. Movement is client-authoritative: the belief stepped past the
    // boundary, replicated, and the server read the coordinates against the room's own
    // bounds (room.kod SomethingMoved: new_col < 1 -> LEAVE_WEST) and obligingly fired that
    // exit. JayB was at the Main gate to the city of Tos with a leg planned NORTH to the
    // border of the Badlands -- the room is 58x44, so the north staging square and the west
    // boundary are near the same corner. He drifted past column 1 on the way there, left by
    // the west edge into the Western border of the Twisted Wood, and was two rooms down a
    // road nobody had planned before anything noticed. The correct route was
    // 586 -> 585 -> 584 -> 574 -> 564 -> 554 -> 545 -> 535.
    //
    // A deliberate crossing does not come through here: the mover marks it off-map, stops
    // steering, and _requestOffRoom sends the speed-0 request the way the client does.
    //
    // Bounds unknown means no opinion -- permission, never refusal. A room whose dimensions
    // we failed to read must not become a room nobody can move in.
    const inRoom = (x, y) => {
      const R = geo?.rows, C = geo?.cols;
      if (!Number.isFinite(R) || !Number.isFinite(C)) return true;
      const col = Math.floor(x / CLIENT_PER_SQUARE) + 1;
      const row = Math.floor(y / CLIENT_PER_SQUARE) + 1;
      return col >= 1 && col <= C && row >= 1 && row <= R;
    };

    const tryMove = (fx, fy, tx, ty) => {
      let t;
      try { t = geo.traceFineMoveClient(fx, fy, tx, ty, { slide: true, allowNoStartFloor: stranded }); }
      catch { return null; }
      if (!t?.available) return null;
      const nx = t.x ?? fx, ny = t.y ?? fy;
      if (Math.hypot(nx - fx, ny - fy) < 0.5) return null;
      if (!inRoom(nx, ny)) {
        this.stats.offRoomRefused = (this.stats.offRoomRefused ?? 0) + 1;
        return null;
      }
      return { x: nx, y: ny, slid: !!t.slid, blocked: !!t.blocked };
    };

    // A MICROSTEP CANNOT CLIMB OUT OF A HOLE.
    //
    // `allowNoStartFloor` forgives a floorless ORIGIN; it does not forgive a floorless
    // DESTINATION, and it should not — landing a body on nothing is the bug it exists to
    // avoid. But the loop below walks toward the aim in `subs` fractions of one tick's
    // travel, and inside a floorless pocket every one of those fractions lands in the
    // pocket too. Each is refused `destination_has_no_floor`, the side-steps are shorter
    // still and are refused for the same reason, and the body never sends a packet.
    //
    // JayB, 2026-08-27, r587 (30,14): 45 of 81 points sampled within ±512 of him had no
    // leaf. Measured along his own planned heading, every step of 384 or less was refused
    // and 448 arrived. He had ticked 17,938 times with `ctl sent=0`, `stranded` correctly
    // true on every one of them, a plan that never failed, and no way to act on it.
    //
    // So when the origin is floorless, take the escape WHOLE. `m59-game.mjs` already
    // reasons exactly this way for the mover's own validator -- one recovery hop, the
    // destination checked for floor by the same BSP that refused, reported so the caller
    // can see a move nothing validated. This is that rule for the controller:
    //
    //   * only when `stranded` -- with floor underfoot nothing here changes;
    //   * the landing point must have a leaf, so it can only ever move ONTO floor;
    //   * the search is bounded to STRANDED_ESCAPE_MAX and prefers the shortest hop
    //     nearest the heading already planned, so it is a recovery and not a teleport;
    //   * and it is counted, because a hop the microstepper did not make must be visible.
    if (stranded && dist > 0) {
      const ux = dx / dist, uy = dy / dist;
      let escaped = null;
      for (let radius = STRANDED_ESCAPE_MIN; radius <= STRANDED_ESCAPE_MAX && !escaped;
           radius += STRANDED_ESCAPE_STEP) {
        for (const turn of STRANDED_ESCAPE_TURNS) {
          const c = Math.cos(turn), sn = Math.sin(turn);
          const hx = ux * c - uy * sn, hy = ux * sn + uy * c;
          const tx = this.x + hx * radius, ty = this.y + hy * radius;
          let hasFloor = false;
          try { hasFloor = geo.leafAtClient(tx, ty) != null; } catch { hasFloor = false; }
          if (!hasFloor) continue;
          const r = tryMove(cx, cy, tx, ty);
          if (r) { escaped = r; break; }
          // THE TRACE REFUSES DESTINATIONS THAT DEMONSTRABLY HAVE FLOOR.
          //
          // From a floorless origin `traceFineMoveClient` answers
          // `destination_has_no_floor` for squares whose centre `leafAtClient` says is
          // solid ground — measured on Gountrug at the exact centre of (25,34) in room
          // 556, where all four squares `moverStepLands` approves came back refused while
          // `leafAtClient` called every one of them floor. Reasoning about a journey from
          // an origin the model itself calls invalid produces answers like that, and the
          // body cannot move at all: 3,919 blocked steps, ZERO packets.
          //
          // `m59-game.mjs` already resolved this for the legacy mover, which is why
          // /movecheck reports `recovered_from_no_floor` on the very steps refused here.
          // This is that rule, with its clauses intact: only when the ORIGIN is floorless,
          // only to a destination this same BSP calls floor, bounded by the escape radius,
          // and counted separately so a move nothing traced is never invisible.
          this.stats.strandedTrusted = (this.stats.strandedTrusted ?? 0) + 1;
          escaped = { x: tx, y: ty, slid: true, blocked: false };
          break;
        }
      }
      if (escaped) {
        // Land it and skip the microstepper for this tick: the hop IS the whole move, and
        // re-walking it in fractions would only re-enter the pocket it just left.
        cx = escaped.x; cy = escaped.y;
        slid = true;
        this.stats.strandedEscapes = (this.stats.strandedEscapes ?? 0) + 1;
        subs = 0;
      } else {
        this.stats.strandedEscapeFailed = (this.stats.strandedEscapeFailed ?? 0) + 1;
      }
    }

    for (let i = 0; i < subs; i++) {
      const tx = this.x + (aimX - this.x) * ((i + 1) / subs);
      const ty = this.y + (aimY - this.y) * ((i + 1) / subs);

      // 1 + 2: the straight attempt, sliding.
      let r = tryMove(cx, cy, tx, ty);

      // 3: the client retries the same target after a slide before giving up.
      if (!r) r = tryMove(cx, cy, tx, ty);

      // 4: two perpendicular side-steps, MIN_SIDE_MOVE each, exactly as move.c does when the
      // retry fails. This is what shakes a body out of a corner it has wedged into, and its
      // absence is why ours reported every direction blocked.
      if (!r) {
        const dxa = tx - cx, dya = ty - cy;
        const len = Math.hypot(dxa, dya) || 1;
        const px = -dya / len * MIN_SIDE_MOVE, py = dxa / len * MIN_SIDE_MOVE;
        r = tryMove(cx, cy, cx + px, cy + py) || tryMove(cx, cy, cx - px, cy - py);
        if (r) { slid = true; this.stats.sideSteps = (this.stats.sideSteps ?? 0) + 1; }
      }

      if (!r) { blocked = true; break; }
      if (r.slid) slid = true;
      if (r.blocked) blocked = true;
      cx = r.x; cy = r.y;
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
      // PROGRESS IS CLOSING ON THE WAYPOINT, NOT MOVING.
      //
      // This measured raw displacement against a threshold of ONE client unit, and a square
      // is 1024 of them. Sliding along a wall is displacement: the body travels tens of
      // units a tick and gets no nearer anything. So `gained` cleared the bar on every
      // contact, `_deadLegs` reset on every tick, and the two escapes below — skip the
      // waypoint, then give up the plan — could never fire. The body slid against the same
      // wall for as long as the keeper lived.
      //
      // That is the whole of the fleet-wide freeze of 2026-08-27, and it is why the
      // signature was identical in three different rooms with three different plans:
      // `slid` ~= `ctlBlocked` ~= `ticks`, `sent` near zero, `arrived` exactly zero.
      // Kage 2,425 blocked ticks, Lee 2,440, JayB 242, every one of them "making ground".
      //
      // Closing distance keeps the case this bar was written for — clipping a corner and
      // sliding ALONG the route is ordinary, and it still closes on the waypoint — while
      // refusing the case that hung the fleet, where the slide is sideways or backwards.
      const closed = Math.hypot(wp.x - beforeX, wp.y - beforeY)
                   - Math.hypot(wp.x - this.x, wp.y - this.y);
      if (closed < MIN_CLOSING_CLIENT) {
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
