// A REFERENCE MODEL OF HOW THE REAL CLIENT ARRIVES AT THE POSITION IT REPORTS.
//
// This exists because the bug it catches could not be seen from inside the mover. The
// mover asks the geometry "is this trace clear?" and, when the answer is no, projects a
// position anyway. Every oracle it had answered that question with the START of the trace
// (`slide: false` returns x0,y0), so nothing in the system could say "the position you are
// about to report is inside a wall" — the only fact that mattered.
//
// So this file does not ask the mover anything. It is a transcription of
// clientd3d/move.c `UserMovePlayer`, and it is deliberately a SEPARATE implementation
// from the mover's: if both were written from the same assumptions they would agree with
// each other instead of with the game. Where this and the mover disagree, one of them is
// wrong about Meridian 59, and the disagreement is the finding.
//
//   move.c:266   num_steps = max(1, min(STEPS_PER_MOVE, NUM_STEPS_PER_SECOND*dt/1000))
//   move.c:268   xinc = dx / num_steps; yinc = dy / num_steps;
//   move.c:288   no floor under the sub-step      -> x = last_x; y = last_y; break;
//   move.c:374   MoveObjectAllowed == MOVE_BLOCKED -> x = last_x; y = last_y; break;
//   move.c:764   MoveUpdatePosition reports player.x, player.y — where the client IS.
//
// The rule this encodes, in one line: **a reported position is a position the client
// actually reached.** Being blocked does not change what is reported; it changes only
// where the integration stopped, and therefore what there is to report.

import { protocolToClient, clientToProtocol, KOD_FINENESS, PLAYER_RADIUS } from './m59-roo.mjs';

// move.c:52-53, verbatim.
export const NUM_STEPS_PER_SECOND = 200;
export const STEPS_PER_MOVE = 20;
// move.c:49 — minimum ms between moving MOVEUNITS.
export const MOVE_DELAY = 100;
// move.c:57 — at most one position packet per this many ms. Our client's
// USER_MOVE_MIN_INTERVAL_MS is 1050: the same law plus 5% so the server's counter drains.
export const MOVE_INTERVAL = 1000;
// move.c:63 — only report a move at least this large (client units, compared squared).
export const MOVE_THRESHOLD = 1024 / 4;

// The room this model walks. Walls are axis-aligned segments in CLIENT units, which is
// what move.c works in and what the mover's trace takes; protocol units convert at
// CLIENT_PER_KOD = 2.
export class ReferenceRoom {
  // `walls`: [{x0,y0,x1,y1}] in client units. `size`: room extent in client units.
  // `voids`: [[row, col]] squares with no floor at all. Distinct from `walls` for the
  // reason spelled out on standable below — a wall has floor under it, a void does not, and
  // the mover treats the two completely differently.
  constructor({ walls = [], voids = [], size = 16 * 1024, squares = 16 } = {}) {
    this.walls = walls;
    this.voids = voids;
    this.size = size;
    this.squares = squares;
  }

  // move.c:288 `BSPFindLeafByPoint(...) == NULL` — no floor here.
  hasFloor(x, y) {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  // move.c:374 `MoveObjectAllowed`. In a room with only walls this reduces to "the
  // segment from last to next crosses a wall". Deliberately a SEGMENT test, not a
  // point-in-square test: a sub-step can pass through a thin wall between samples and a
  // point test would miss it, which is the mistake that let the mover project through.
  // Does a wall stand in the way of this line? With a radius, "in the way" widens to
  // "within r of the line", which is what a body of radius r experiences; with r = 1 it is
  // the centreline test, which is what the mover asks for when it wants to know whether the
  // road is open at all.
  blocked(x0, y0, x1, y1, r = 0) {
    for (const w of this.walls) {
      if (segCrosses(x0, y0, x1, y1, w.x0, w.y0, w.x1, w.y1)) return w;
      if (r > 0 && segNearSeg(x0, y0, x1, y1, w.x0, w.y0, w.x1, w.y1, r)) return w;
    }
    return null;
  }

  // THE FURTHEST LEGAL POSITION ALONG A LINE, which is what move.c's integration produces
  // and what a client that hit something would be reporting. Binary search on the segment
  // against the same `blocked` the integration uses, so the answer is a property of the
  // room and not of a sampling schedule: a sub-stepped approximation can be talked into a
  // coarser answer than the truth by choosing its own step count, and the whole point of
  // this file is to refuse to be talked out of anything.
  //
  // Returns { x, y, atWall } where atWall says the line was cut short. `x, y` is on the
  // legal side of whatever stopped it, within `tol` client units.
  furthest(x0, y0, x1, y1, tol = 1) {
    if (!this.blocked(x0, y0, x1, y1)) return { x: x1, y: y1, atWall: false };
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const mx = x0 + (x1 - x0) * mid, my = y0 + (y1 - y0) * mid;
      if (this.blocked(x0, y0, mx, my)) hi = mid; else lo = mid;
      if (hi - lo < tol / Math.max(1, Math.hypot(x1 - x0, y1 - y0))) break;
    }
    return { x: x0 + (x1 - x0) * lo, y: y0 + (y1 - y0) * lo, atWall: true };
  }

  // THE INTEGRATION. move.c:266-382. Returns the position the client would REPORT after
  // moving `distance` client units toward (tx,ty) from (x,y) — stopping at the first
  // blocked sub-step, exactly as `x = last_x; break;` does.
  //
  // No sliding, on purpose. move.c does slide (SlideAlongWall, move.c:448), but sliding is
  // a way of getting *around* an obstacle; it cannot make a position past the obstacle
  // legal. The property under test is "never report inside a wall", and a model that
  // slides could still satisfy it while hiding whether the straight case was correct.
  // The mover has its own slide path and its own tests for it.
  // dt is the elapsed time the integration covers, in ms. move.c:266 turns it into a
  // sub-step count; at 200 steps/s anything at or above 100ms saturates the STEPS_PER_MOVE
  // cap of 20, which is why a real client at 100ms ticks walks 32 client units in 20
  // sub-steps of 1.6 units each. The sub-steps exist to make a wall impossible to step
  // OVER, so the count must not be inferred from the distance — a long distance with few
  // samples is precisely the bug this file was written to catch.
  integrate(x, y, tx, ty, distance, { dt = MOVE_DELAY, numSteps = STEPS_PER_MOVE } = {}) {
    const raw = Math.hypot(tx - x, ty - y);
    if (raw < 1e-9) return { x, y, stopped: 'nowhere', distance: 0 };
    const steps = Math.max(1, Math.min(numSteps, Math.floor(NUM_STEPS_PER_SECOND * dt / 1000)));
    const ux = (tx - x) / raw, uy = (ty - y) / raw;
    const travel = Math.min(distance, raw);
    const xinc = (ux * travel) / steps, yinc = (uy * travel) / steps;

    let lastX = x, lastY = y;
    for (let i = 0; i < steps; i++) {
      const nx = lastX + xinc, ny = lastY + yinc;
      // move.c:288-296 — no floor under the sub-step.
      if (!this.hasFloor(nx, ny)) return { x: lastX, y: lastY, stopped: 'no_floor', steps: i };
      // move.c:374-382 — an object/wall prevents this move.
      if (this.blocked(lastX, lastY, nx, ny)) return { x: lastX, y: lastY, stopped: 'wall', steps: i };
      lastX = nx; lastY = ny;
    }
    return { x: lastX, y: lastY, stopped: null, steps };
  }

  // THE CONTRACT, as a predicate a test can assert on one send.
  // A reported position is legal iff the client could have reached it from where it was,
  // in the distance it claims to have moved, without crossing a wall.
  reachable(fromX, fromY, toX, toY, distance) {
    if (this.blocked(fromX, fromY, toX, toY)) return { ok: false, why: 'segment crosses a wall' };
    const moved = Math.hypot(toX - fromX, toY - fromY);
    if (moved > distance + 1e-6) return { ok: false, why: `moved ${moved.toFixed(1)} > declared ${distance.toFixed(1)}` };
    if (!this.hasFloor(toX, toY)) return { ok: false, why: 'no floor at the reported position' };
    return { ok: true, moved };
  }
}

// Segment-segment intersection, closed segments. Standard orientation test; no floating
// point cleverness, because a fixture that is subtly wrong is worse than no fixture.
function segCrosses(ax, ay, bx, by, cx, cy, dx, dy) {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// A geometry object shaped like the mover's `session.world.geometry`, backed by a
// ReferenceRoom. The mover is not supposed to know it is being tested — so this answers
// the methods it actually calls, and the ONLY thing it adds is that traces report where
// they stopped. That is not a test hook; it is what a trace means.
export function referenceGeometry(room) {
  const stopsAtWall = (x0, y0, x1, y1) => {
    // Full-trace integration, sampled densely enough that a thin wall cannot be stepped
    // over: dt is scaled so the sub-step length stays near the 100ms walk step rather than
    // stretching with the trace. This answers "where is the furthest legal position along
    // this line", which is what a client that hit the wall would be reporting.
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const dt = Math.max(MOVE_DELAY, Math.ceil(dist / (32 / 20)));
    return room.integrate(x0, y0, x1, y1, dist, { dt });
  };
  return {
    collisionReady: true,
    room,
    // THE TRACE THE MOVER ASKS BEFORE IT SENDS.
    //
    // `playerRadius` is accepted and honoured, because the real one honours it
    // (m59-roo.mjs:791 compares the wall's bounding box against playerRadius). The mover's
    // slide-along-wall check calls this with `playerRadius: 1` and explains why: "the full
    // player radius (32) clips nearby walls and reads the direct path as blocked on open
    // ground, firing the fan". A fixture that ignored the option would report blocked where
    // the mover's own guard reported clear, and would then "catch" a violation the mover
    // never had a chance to commit. Honour the argument the caller passed.
    traceFineMoveClient(x0, y0, x1, y1, { slide = false, playerRadius = PLAYER_RADIUS } = {}) {
      // THE TRACE MUST NEVER BE ASKED FROM A POSITION IT CANNOT EXPLAIN.
      //
      // The reference client cannot be inside a wall, so it has no opinion about what a trace
      // from inside one means. This fixture can be asked that, because the mover's own coarse
      // layer can hand it a position past a wall — and the answer must not be "clear". A
      // centreline test from inside a wall to a point beyond it crosses nothing, so a naive
      // implementation reports the road as open and the mover walks further into the wall.
      // That is not a modelling nicety: it is how a test fixture ends up certifying the exact
      // violation it was written to catch.
      if (squareInsideTrace(room, x0, y0)) {
        return { blocked: true, moved: false, arrived: false, x: x0, y: y0,
                 reason: 'origin_inside_wall', note: 'the reference client cannot be here' };
      }
      const wall = room.blocked(x0, y0, x1, y1, playerRadius);
      if (!wall) return { blocked: false, moved: true, arrived: true, x: x1, y: y1 };
      const stop = stopsAtWall(x0, y0, x1, y1);
      if (!slide) return { blocked: true, moved: false, arrived: false, x: x0, y: y0, stopX: stop.x, stopY: stop.y };
      return { blocked: true, moved: stop.x !== x0 || stop.y !== y0, arrived: false, x: stop.x, y: stop.y, stopX: stop.x, stopY: stop.y };
    },
    // THE MOVER'S FINE-GRID QUESTIONS, answered from the same wall set — and the answer is
    // deliberately NOT the same verdict the reference model gives.
    //
    // That asymmetry is not sloppiness, it is the room. RoomGeometry.fineWalkable
    // (m59-roo.mjs:1573) tests a square by its CENTRE at radius 256, while the client that
    // this file models collides continuously through the BSP. So a segment lying on a square
    // BOUNDARY is 512 from either neighbour's centre: the fine grid calls both squares open,
    // the planner routes straight through the wall, and the mover walks into what its own
    // geometry says is open ground. That mismatch is not a fixture defect — it is a
    // documented property of the real system, which is why the mover carries an escape fan
    // and a raw door push at all.
    //
    // Making the fixture's fineWalkable as strict as its own trace would close that gap and
    // quietly delete the only case worth testing: a mover that believes a route exists and
    // declares positions across something it cannot cross. The fixture keeps the real
    // predicate's blind spot; the reference model keeps the physics. Where they disagree is
    // the bug.
    //
    // ARGUMENT ORDER IS (row, col), NOT (col, row). roo.mjs:1573 declares
    // `fineWalkable(r, c)` and every mover/router call site passes row first — and the
    // escape block at mover:384 builds `wx = nc*KOD + HALF, wy = nr*KOD + HALF`, i.e. col
    // from the SECOND argument. A fixture written (col, row) would silently transpose the
    // room: every assertion would still run, and every one of them would be about a room
    // that is the original rotated. Get this wrong and the test proves nothing while
    // looking exactly like it does.
    // TRANSCRIBED FROM THE REAL GEOMETRY, NOT INVENTED.
    //
    // RoomGeometry.fineWalkable (m59-roo.mjs:1573-1591) tests the CELL CENTRE against each
    // impassable segment at a radius of 256, with the comment "256 is the player radius in
    // fine units (the client collides the character circle, not a point)". A first draft of
    // this fixture tested the centre AND the four edge midpoints at PLAYER_RADIUS = 248, on
    // the reasoning that a body occupies a whole square. That is stricter than the game, and
    // stricter turns out to mean wrong: it closes squares the game considers open, so the
    // mover's planner routes around obstacles that are not there and the fixture measures a
    // game that does not exist. A fixture may not be more cautious than the thing it models.
    //
    // The consequence matters for how a wall can be placed, and it is the reason three
    // drafts of the wall-declaration test found nothing: a segment lying exactly ON a square
    // boundary is 512 client units from the centre of either neighbour, which is outside the
    // radius, so the fine grid does not consider either square blocked. In this geometry a
    // wall the fine grid can see is a wall that runs THROUGH a square. The test room has to
    // be built that way or it has no wall in it at all.
    fineWalkable(row, col) {
      if (!this.inBounds(row, col)) return false;
      // THE CENTRE OF THE CELL, IN THE SAME UNITS THE WALLS ARE WRITTEN IN.
      //
      // The repository's converter is protocolToClient(v) = (v - KOD_FINENESS) * 16, and the
      // -64 is not a rounding term: the kod grid is 1-BASED (roo.mjs:1712 indexes a square as
      // (row - 1) * CLIENT_FINENESS) and the client grid is 0-based, so one whole square of
      // offset is baked into every conversion. Writing the cell centre as the arithmetically
      // prettier (col + 0.5) * 1024 drops that offset, and the effect is not a rounding
      // error — it is exactly one square. The wall and the walkable predicate then disagree
      // about where the wall is by a full square, which produces a room whose wall closes the
      // squares beside it and leaves the squares it runs through open. Every assertion about
      // "the far side" is then about the near side, and a test built on it measures a room
      // that does not exist. Always derive the centre from protocolToClient, the same
      // function the walls went through.
      const fx = protocolToClient(col * KOD_FINENESS + KOD_FINENESS / 2);
      const fy = protocolToClient(row * KOD_FINENESS + KOD_FINENESS / 2);
      if (!room.hasFloor(fx, fy)) return false;
      const R = 256;   // roo.mjs:1580, verbatim
      for (const w of room.walls) if (pointNearSeg(fx, fy, w, R)) return false;
      return true;
    },
    walkable(row, col) { return this.fineWalkable(row, col); },
    // GROUND TRUTH — and it must NOT be an alias of fineWalkable.
    //
    // A WALL AND A VOID ARE DIFFERENT THINGS AND THIS FIXTURE HAS TO KNOW THE DIFFERENCE.
    // fineWalkable asks whether a body of PLAYER_RADIUS fits at the square's centre, so a
    // wall running through the middle makes the square false. isGrounded/standable asks
    // whether there is FLOOR AT ALL, and a wall standing on the floor leaves the floor
    // there: you can stand in a doorway with your shoulders against both sides. Aliasing
    // the two makes every wall square a void, which silently converts the test from
    // "did the mover declare a position inside a wall?" into "did it declare a position
    // outside the room?" — a different question, one the mover already answers correctly,
    // and the answer it gives is a refusal rather than the illegal send being looked for.
    //
    // So the room carries its void squares separately, defaulting to none: every square in
    // a walled room is floor, which is what a room is.
    standable(row, col) {
      if (!this.inBounds(row, col)) return false;
      return !room.voids.some(([vr, vc]) => vr === row && vc === col);
    },
    // THE SAFEST PLACE TO STAND IN A SQUARE, or null if there is nowhere a body fits.
    //
    // Returning null unconditionally is the single most destructive mistake a fixture for
    // this mover can make. transitBanned (m59-ground.mjs) reaches this method and treats
    // `standPoint(...) == null` as "this square is banned", and it RETURNS that verdict
    // without consulting standable — so a null-for-everything stub declares every square in
    // the room unbreatheable, every candidate step is refused, both engines emit zero
    // packets, and the test reports "0 illegal sends" about a room nobody could leave. That
    // is not a passing test; it is a test with nothing in it, and it looks identical to one.
    //
    // So this answers from the wall set: the square centre, unless a wall is close enough
    // to the centre that a body of PLAYER_RADIUS would be embedded in it.
    standPoint(row, col) {
      if (!this.inBounds(row, col)) return null;
      if (!this.fineWalkable(row, col)) return null;
      return {
        x: protocolToClient(col * KOD_FINENESS + KOD_FINENESS / 2),
        y: protocolToClient(row * KOD_FINENESS + KOD_FINENESS / 2),
      };
    },
    inBounds(row, col) {
      return row >= 0 && col >= 0 && row < room.squares && col < room.squares;
    },
    fineHeightAt() { return 0; },
    // A BFS over the coarse square grid, in PROTOCOL units, refusing to cross a wall.
    //
    // This is not the thing under test — but it has to be a real planner, because a stub
    // that answers `found: false` whenever the beeline is blocked sends the mover into its
    // escape fan, and then both engines emit nothing and the test measures nothing. The
    // first version of this file did exactly that and reported "0 packets, 0 violations",
    // which reads as a clean room and is actually a silent test.
    finePathProtocol(fromX, fromY, toX, toY) {
      const sc = Math.floor(clientToProtocol(fromX) / KOD_FINENESS), sr = Math.floor(clientToProtocol(fromY) / KOD_FINENESS);
      const tc = Math.floor(clientToProtocol(toX) / KOD_FINENESS), tr = Math.floor(clientToProtocol(toY) / KOD_FINENESS);
      const seen = new Set([sr + ',' + sc]);
      let frontier = [[sr, sc, []]];
      for (let depth = 0; depth < 400 && frontier.length; depth++) {
        const next = [];
        for (const [r, c, path] of frontier) {
          if (r === tr && c === tc) {
            // Match navgeom's contract exactly (navgeom.mjs:379-385): the intermediate
            // squares' CENTRES, then a final waypoint at EXACTLY (toX, toY). The trailing
            // point is not decoration — it is how a mover knows it has arrived, and a plan
            // that ends at a square centre short of the target leaves the character
            // standing next to the destination planning forever. Including the case that
            // bites here: when start and goal are in the same square the real planner
            // returns that single exact point (navgeom.mjs:258), while a naive BFS returns
            // an EMPTY list, and `found: true, waypoints: []` makes the mover plan, find
            // nothing to walk, and send nothing — which reads as a mover that refuses to
            // move and is a fixture that never described a route.
            return {
              found: true,
              waypoints: [...path.map(([pr, pc]) => ({ x: pc * KOD_FINENESS + KOD_FINENESS / 2, y: pr * KOD_FINENESS + KOD_FINENESS / 2 })),
                          { x: toX, y: toY }],
            };
          }
          for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
            const nr = r + dr, nc = c + dc;
            const k = nr + ',' + nc;
            if (seen.has(k)) continue;
            if (!this.inBounds(nr, nc)) continue;
            // A step may not cross a wall, judged by the same integration the sends are
            // judged with — one square per edge, so the test is the same predicate.
            const ax = c * KOD_FINENESS + KOD_FINENESS / 2, ay = r * KOD_FINENESS + KOD_FINENESS / 2;
            const bx = nc * KOD_FINENESS + KOD_FINENESS / 2, by = nr * KOD_FINENESS + KOD_FINENESS / 2;
            if (room.blocked(protocolToClient(ax), protocolToClient(ay), protocolToClient(bx), protocolToClient(by))) continue;
            if (!this.fineWalkable(nr, nc)) continue;
            seen.add(k);
            next.push([nr, nc, [...path, [nr, nc]]]);
          }
        }
        frontier = next;
      }
      return { found: false, waypoints: [] };
    },
  };
}

function pointNearSeg(px, py, w, r) {
  const dx = w.x1 - w.x0, dy = w.y1 - w.y0;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-9) return Math.hypot(px - w.x0, py - w.y0) <= r;
  let t = ((px - w.x0) * dx + (py - w.y0) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (w.x0 + t * dx), py - (w.y0 + t * dy)) <= r;
}

// Protocol <-> client helpers re-exported so a test does not re-derive the scale and get
// it wrong the way the plan document did.
export { protocolToClient, clientToProtocol, KOD_FINENESS };

// Minimum distance between two segments, for the widened "in the way" test above. Sampled
// at each endpoint against the other segment plus the reverse; two axis-aligned segments
// that do not cross but sit 1 unit apart are 1 unit apart, and a radius of 2 must see that.
function segNearSeg(ax, ay, bx, by, cx, cy, dx, dy, r) {
  const d = Math.min(
    pointSegDist(ax, ay, cx, cy, dx, dy), pointSegDist(bx, by, cx, cy, dx, dy),
    pointSegDist(cx, cy, ax, ay, bx, by), pointSegDist(dx, dy, ax, ay, bx, by));
  return d <= r;
}

function pointSegDist(px, py, x0, y0, x1, y1) {
  const ddx = x1 - x0, ddy = y1 - y0, L2 = ddx * ddx + ddy * ddy;
  let t = 0;
  if (L2 > 0) t = Math.max(0, Math.min(1, ((px - x0) * ddx + (py - y0) * ddy) / L2));
  return Math.hypot(px - (x0 + t * ddx), py - (y0 + t * ddy));
}

// Is a client position inside one of this room's walls? The reference model's answer is that
// the question should never be asked — a client that integrated correctly cannot be there — so
// any geometry built on top of it must refuse rather than report a clear road.
function squareInsideTrace(room, cx, cy) {
  for (const w of room.walls) {
    const y0 = Math.min(w.y0, w.y1), y1 = Math.max(w.y0, w.y1);
    if (cy < y0 || cy > y1) continue;
    if (Math.abs(cx - w.x0) <= 1) return w;   // on the wall's line
  }
  return null;
}
