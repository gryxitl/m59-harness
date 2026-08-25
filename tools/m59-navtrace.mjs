// PLANNING ON THE GEOMETRY ITSELF, WITH NO BAKE IN BETWEEN.
//
// `m59-navgrid.mjs` answers "can I stand here" per cell and then assumes a path between two
// standable cells is walkable. That assumption is false in this game, and the failure is not
// rare: room 1016 is built of one-way ledges and tomb rails, walls flagged WF_PASSABLE that
// `canCrossWallAt` refuses from ONE SIDE. A cell grid cannot hold that fact — freedom is a
// property of a CELL, crossability is a property of an EDGE AND A DIRECTION — so the planner
// routed through them, the mover correctly refused, and about a third of walks died grinding
// against a wall the plan said was not there. Both repairs available to a grid were measured
// and both are wrong: blocking when either side refuses collapses 1016's main body from 9,582
// cells to 960, and blocking only when both refuse is the original bug.
//
// So this drops the intermediate representation. A* expands a node by TRACING THE STEP, with
// the same `traceFineMoveClient` the controller uses to move — which takes a from and a to,
// and therefore carries the direction the grid could not express. A one-way ledge is crossable
// downhill and refused uphill, and that is simply what the search finds.
//
// AFFORDABLE ONLY SINCE THE DESCENT PRUNE, same as collide-and-slide. A 256-unit expansion is
// 6.1us. The bake it replaces was 61-144ms of tracing every cell in the room, most of which no
// route ever visits; A* with an octile heuristic touches a few hundred. Paying per node
// examined instead of per cell in the room is what makes the honest question affordable.
//
// AND NOTHING IS SNAPPED TO A CELL CENTRE. The first version of this quantised positions onto
// a 256-unit lattice and asked whether each cell's CENTRE was occupiable, which walked straight
// back into the bug that started the whole geometry effort: 15.7% of Raza's tile centres are
// inside a wall, so a centre is not a proxy for the space around it at any resolution. Here a
// node's position is WHERE A TRACE ACTUALLY LANDED, so every node is reachable by construction
// and the start node is the body's own fine position rather than the middle of its cell. The
// lattice survives only as the key of the visited set — a way to stop expanding the same pocket
// twice, never a claim about where anything may stand.
//
// PLAN ON WHAT THE MOVER ENFORCES. The router's standing rule (docs/m59-routing.md) is that the
// planner must ask the mover's question, not a cheaper one nearby. Here they are not merely the
// same rule, they are the same function.
import { PLAYER_RADIUS } from './m59-roo.mjs';

export const CELL = 256;                    // client units; 4 to a 1024 tile
const DIRS = [[1,0],[0,1],[-1,0],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
const SQRT2 = Math.SQRT2;

// A step counts as taken only if the trace LANDED where it was aimed. A slide that stops short
// against a wall is a refusal for planning purposes even though it moved the body, which is why
// this traces with slide off: we want the yes/no, not the salvage.
// How much of a 256-unit step must actually happen for it to count as a step. A quarter of it
// keeps a genuine slide and drops a body grinding against a wall.
const MIN_STEP_GAIN = CELL / 4;

export const cellKey = (i, j) => (j + 4096) * 65536 + (i + 4096);
export const cellOf = (x, y) => [Math.floor(x / CELL), Math.floor(y / CELL)];
export const pointOf = (i, j) => ({ x: i * CELL + CELL / 2, y: j * CELL + CELL / 2 });

function memoFor(geo) {
  if (!geo._navTrace) geo._navTrace = { edges: new Map() };
  return geo._navTrace;
}

// One step, traced from a REAL position toward a lattice offset. Returns where the body ENDS
// UP, or null if it would not move at all.
//
// SLIDE IS ON, AND REFUSING A SLIDE WAS THE WHOLE BUG. This traced with slide:false and
// demanded exact arrival, on the reasoning that a step stopping short has not connected two
// nodes. That reasoning is wrong, and measurably so: of the 958 steps across four rooms where
// `moverStepLands` said yes and a strict trace said no, **every single one** — 267, 105, 427,
// 159 — put the body inside the target square once sliding was allowed. Not one went nowhere.
//
// The body is a DISC and the lattice is a line through points. Clipping a corner and sliding
// along it is how a disc crosses a square; it is what collide-and-slide is for, and the stock
// client does it every frame (move.c). Demanding a clean straight line refuses ordinary
// walking, which is why this planner rejected all five of the walks JayB was actually failing
// while the grid planner found routes for every one of them.
//
// So the node's position is WHERE THE SLIDE LANDED. A step counts when the body made real
// ground; it is refused only when it could not move at all.
function stepTo(geo, x0, y0, x1, y1, radius) {
  let t;
  try { t = geo.traceFineMoveClient(x0, y0, x1, y1, { slide: true, playerRadius: radius }); }
  catch { return null; }
  if (!t || !t.available || !t.moved) return null;
  // Ground actually gained. A slide that shaves a few units off a 256-unit step is progress;
  // one that moves a hair and stops is the wall in front of us, not beside us.
  const gained = Math.hypot((t.x ?? x0) - x0, (t.y ?? y0) - y0);
  if (gained < MIN_STEP_GAIN) return null;
  return { x: t.x, y: t.y };
}

/**
 * A* from one client-space point to another, over real geometry, with no bake and no snapping.
 * Returns { waypoints, nodes, blocked }. `waypoints` EXCLUDES the start, because a waypoint the
 * body already stands on is a leg that cannot make progress, and reporting that as success is
 * how the grid version once measured zero movement as an arrival.
 */
export function tracePath(geo, from, to, { radius = PLAYER_RADIUS, maxNodes = 6000 } = {}) {
  const memo = memoFor(geo);
  const goalNear = CELL;                      // close enough to try the last leg directly
  const h = (x, y) => Math.hypot(x - to.x, y - to.y) / CELL;

  const startK = cellKey(...cellOf(from.x, from.y));
  const heap = [{ x: from.x, y: from.y, k: startK, g: 0, f: h(from.x, from.y), prev: null }];
  const best = new Map([[startK, 0]]);
  const closed = new Set();
  let nodes = 0;

  const push = n => { heap.push(n); let c = heap.length - 1;
    while (c > 0) { const p = (c - 1) >> 1; if (heap[p].f <= heap[c].f) break;
      [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const pop = () => { const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let p = 0;
      for (;;) { const l = 2*p+1, r = l+1; let s = p;
        if (l < heap.length && heap[l].f < heap[s].f) s = l;
        if (r < heap.length && heap[r].f < heap[s].f) s = r;
        if (s === p) break; [heap[p], heap[s]] = [heap[s], heap[p]]; p = s; } }
    return top; };
  const unwind = n => { const out = []; for (let c = n; c; c = c.prev) out.push({ x: c.x, y: c.y });
    out.reverse(); out.shift(); return out; };

  while (heap.length && nodes < maxNodes) {
    const cur = pop();
    if (closed.has(cur.k)) continue;
    closed.add(cur.k); nodes++;

    // The last leg is traced to the EXACT destination, never to a cell centre near it — the
    // caller asked to stand on a specific point and that is the point the plan has to reach.
    if (Math.hypot(cur.x - to.x, cur.y - to.y) <= goalNear) {
      const land = stepTo(geo, cur.x, cur.y, to.x, to.y, radius);
      if (land) return { waypoints: [...unwind(cur), { x: to.x, y: to.y }], nodes, blocked: false };
    }

    for (const [di, dj] of DIRS) {
      const tx = cur.x + di * CELL, ty = cur.y + dj * CELL;
      // A diagonal that squeezes between two refused orthogonals is a corner cut the mover will
      // not reproduce. Checked from this node's real position, so it is the corner the body
      // would actually face rather than an idealised one.
      if (di && dj) {
        const eK = `${cur.k}|${di}|${dj}`;
        let ok = memo.edges.get(eK);
        if (ok === undefined) {
          ok = !!stepTo(geo, cur.x, cur.y, cur.x + di * CELL, cur.y, radius)
            && !!stepTo(geo, cur.x, cur.y, cur.x, cur.y + dj * CELL, radius);
          memo.edges.set(eK, ok);
        }
        if (!ok) continue;
      }
      const land = stepTo(geo, cur.x, cur.y, tx, ty, radius);
      if (!land) continue;
      const nk = cellKey(...cellOf(land.x, land.y));
      if (closed.has(nk) || nk === cur.k) continue;
      const ng = cur.g + (di && dj ? SQRT2 : 1);
      if (ng >= (best.get(nk) ?? Infinity)) continue;
      best.set(nk, ng);
      push({ x: land.x, y: land.y, k: nk, g: ng, f: ng + h(land.x, land.y), prev: cur });
    }
  }
  return { waypoints: [], nodes, blocked: true };
}

/** Reachability, asked the same way and therefore agreeing with the path by construction. */
export function traceReachable(geo, from, to, opts = {}) {
  return !tracePath(geo, from, to, opts).blocked;
}
