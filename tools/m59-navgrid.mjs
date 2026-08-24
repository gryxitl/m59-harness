#!/usr/bin/env node
// PATHFINDING ON FREE SPACE, BECAUSE A TILE IS NOT A PLACE.
//
// The router plans on 1024-unit tiles and asks, per tile and direction, one yes/no question
// answered by tracing between the two tiles' representative points. Measured on the shipped
// geometry, that abstraction does not fit the world:
//
//   tiles crossed by a solid wall   Raza 44.6%   Twisted Wood 42.3%   Streets of Tos 31.0%
//   tile centres inside a wall      Raza 15.7%
//   steps whose answer depends on where in the tile you stand   22% - 34%
//
// A tile a wall runs through is two places, and no single point represents it. Room 1012's
// fence runs along the centre line of row 11, so the tile's own centre sits inside it: every
// question asked from there is ill-posed, which is why the router planned a step straight
// through a solid wall and the mover agreed. Moving the representative point does not help —
// it lands on whichever side of the fence the sampler happened to prefer.
//
// So this plans on FREE SPACE instead. Cells of 256 units, four to a tile; a cell is free
// when a body could stand in it — floor and headroom under `_occupiable`, and at least
// PLAYER_RADIUS from every wall the data calls solid. Connectivity is then just adjacency of
// free cells, which needs no representative point and is correct whether or not a wall
// happens to cross a tile.
//
// WHY 256. It is the client's own lattice pitch (m59-finepath.mjs RESOLUTION 4) and it is
// finer than the 248-unit player radius, which is the width that decides whether a gap is
// passable at all. Coarser cannot see a gap a body fits through; finer costs time and finds
// no new gaps.
//
// WHAT IT IS STRICTER ABOUT. Requiring a full radius of clearance refuses a gap the stock
// client could squeeze through at an angle. That is the pessimistic direction — it costs a
// route, never a collision — and it is the right way round to be wrong while this is new.
import { PLAYER_RADIUS } from './m59-roo.mjs';

// A region this small a share of the main body is a sealed pocket rather than a splinter of
// the clearance margin. See sameRegion for the measurement behind the number.
export const POCKET_FRACTION = 0.05;

export const CELL = 256;                        // client units; 4 cells to a 1024 tile
export const PER_TILE = 1024 / CELL;

// Distance from a point to a wall segment. The body is a disc, so this is the only
// clearance test that matters.
function distanceToWall(x, y, w) {
  const dx = w.x1 - w.x0, dy = w.y1 - w.y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((x - w.x0) * dx + (y - w.y0) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return Math.hypot(x - (w.x0 + t * dx), y - (w.y0 + t * dy));
}

// THE FREE-SPACE GRID, BUILT ONCE PER ROOM AND KEPT ON THE GEOMETRY. ~100ms for a large
// room, which is the same shape of cost the step mask has — except this is derived from the
// walls rather than from a question about tiles, so it does not go stale against a fix to
// the tracer the way a baked mask does.
export function freeSpace(geo, { radius = PLAYER_RADIUS } = {}) {
  if (geo._navGrid && geo._navGrid.radius === radius) return geo._navGrid;
  const W = geo.cols * PER_TILE, H = geo.rows * PER_TILE;
  const free = new Uint8Array(W * H);
  const solid = (geo.walls ?? []).filter(w => w.passable === false);
  let count = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = i * CELL + CELL / 2, y = j * CELL + CELL / 2;
      if (!geo._occupiable?.(x, y)) continue;
      let ok = true;
      for (const w of solid) if (distanceToWall(x, y, w) < radius) { ok = false; break; }
      if (ok) { free[j * W + i] = 1; count++; }
    }
  }
  return (geo._navGrid = { W, H, free, radius, count });
}

export const cellOfClient = (x, y) => [Math.floor(x / CELL), Math.floor(y / CELL)];
export const clientOfCell = (i, j) => ({ x: i * CELL + CELL / 2, y: j * CELL + CELL / 2 });

// The nearest free cell to a point, searched outward. A body can legitimately be standing
// somewhere this grid calls occupied — it is stricter than the game — and refusing to plan
// from where the character actually is would be the worst of both.
function nearestFree(grid, i0, j0, maxRing = 8) {
  const { W, H, free } = grid;
  if (i0 >= 0 && j0 >= 0 && i0 < W && j0 < H && free[j0 * W + i0]) return [i0, j0];
  for (let ring = 1; ring <= maxRing; ring++) {
    for (let dj = -ring; dj <= ring; dj++) {
      for (let di = -ring; di <= ring; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
        const i = i0 + di, j = j0 + dj;
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        if (free[j * W + i]) return [i, j];
      }
    }
  }
  return null;
}

// A binary heap, because a sorted array is most of the runtime at this cell count.
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node) {
    const a = this.a; a.push(node);
    let n = a.length - 1;
    while (n > 0) { const p = (n - 1) >> 1;
      if (a[p][0] <= a[n][0]) break; [a[p], a[n]] = [a[n], a[p]]; n = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let n = 0;
      for (;;) { const l = 2 * n + 1, r = l + 1; let s = n;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === n) break; [a[s], a[n]] = [a[n], a[s]]; n = s; } }
    return top;
  }
}

const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

// PLAN FROM WHERE THE BODY IS TO WHERE IT IS GOING, both in client units. Returns waypoints
// in client units, or a reason. `maxCells` bounds the search the way path() bounds its own.
export function navPath(geo, from, to, { radius = PLAYER_RADIUS, maxCells = 40000 } = {}) {
  const grid = freeSpace(geo, { radius });
  const { W, H, free } = grid;
  const s = nearestFree(grid, ...cellOfClient(from.x, from.y));
  const g = nearestFree(grid, ...cellOfClient(to.x, to.y));
  if (!s) return { found: false, reason: 'no free space at the start' };
  if (!g) return { found: false, reason: 'no free space at the destination' };
  const [si, sj] = s, [gi, gj] = g;
  const key = (i, j) => j * W + i;
  const h = (i, j) => Math.hypot(i - gi, j - gj);
  const gScore = new Float64Array(W * H).fill(Infinity);
  const came = new Int32Array(W * H).fill(-1);
  const open = new Heap();
  gScore[key(si, sj)] = 0;
  open.push([h(si, sj), si, sj]);
  let expanded = 0;
  while (open.size) {
    const [, i, j] = open.pop();
    if (++expanded > maxCells) return { found: false, reason: 'nav search gave up', expanded };
    if (i === gi && j === gj) {
      const cells = [];
      for (let n = key(i, j); n >= 0; n = came[n]) cells.push(n);
      cells.reverse();
      return { found: true, expanded,
               waypoints: cells.map(n => clientOfCell(n % W, (n - n % W) / W)) };
    }
    const gHere = gScore[key(i, j)];
    for (const [di, dj] of DIRS) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const k = key(ni, nj);
      if (!free[k]) continue;
      // A DIAGONAL MAY NOT CUT A CORNER. Both orthogonal neighbours must be free, or the
      // body clips the corner of whatever makes the diagonal a diagonal.
      if (di && dj && (!free[key(i + di, j)] || !free[key(i, j + dj)])) continue;
      const ng = gHere + (di && dj ? Math.SQRT2 : 1);
      if (ng < gScore[k]) { gScore[k] = ng; came[k] = key(i, j); open.push([ng + h(ni, nj), ni, nj]); }
    }
  }
  return { found: false, reason: 'no route through free space', expanded };
}

// WHICH CONNECTED PIECE OF FREE SPACE IS THIS POINT IN?
//
// Flooding free space labels every cell with the region it belongs to, and two points are
// mutually reachable exactly when their labels match. That is one array lookup, and it is
// the question the hunt has never been able to ask.
//
// It matters because prey does not spawn where a character can walk. The Mausoleum (room
// 1016) is 88.6% wall-crossed tiles and its free space falls into EIGHT pieces: a body of
// 9,582 cells and seven sealed pockets, the largest 378 and 184. A mummy standing in one of
// those cannot be reached by any route, at any quality of pathfinding — the character walks
// to the nearest point of the wall between them and stops. Watched live, that is a keeper
// picking a target, failing to path, blinking, and sitting still.
//
// Region 0 is the largest piece by convention, so `labelAt` returning 0 usually means "in
// the main body". Do not rely on that for correctness — compare labels, never assume.
export function regions(geo, { radius = PLAYER_RADIUS } = {}) {
  const grid = freeSpace(geo, { radius });
  if (grid.labels) return grid;
  const { W, H, free } = grid;
  const labels = new Int32Array(W * H).fill(-1);
  const sizes = [];
  let next = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (!free[k] || labels[k] >= 0) continue;
      const id = next++;
      let n = 0;
      const stack = [[i, j]];
      labels[k] = id;
      while (stack.length) {
        const [a, b] = stack.pop(); n++;
        for (const [da, db] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const na = a + da, nb = b + db;
          if (na < 0 || nb < 0 || na >= W || nb >= H) continue;
          const kk = nb * W + na;
          if (!free[kk] || labels[kk] >= 0) continue;
          labels[kk] = id; stack.push([na, nb]);
        }
      }
      sizes.push({ id, n });
    }
  }
  // Renumber so 0 is the largest piece, which is what a character in the open is standing in.
  sizes.sort((a, b) => b.n - a.n);
  const rank = new Map(sizes.map((s, i) => [s.id, i]));
  for (let k = 0; k < labels.length; k++) if (labels[k] >= 0) labels[k] = rank.get(labels[k]);
  grid.labels = labels;
  grid.regionSizes = sizes.map(s => s.n);
  return grid;
}

// The region label at a client-unit point, or null when the point is not free space. Falls
// back to the nearest free cell, because a body can legitimately stand somewhere this grid
// calls occupied — it is stricter than the game — and answering "nowhere" for a character
// that is plainly standing somewhere would refuse every target it has.
export function labelAt(geo, x, y, { radius = PLAYER_RADIUS } = {}) {
  const grid = regions(geo, { radius });
  const near = nearestFree(grid, ...cellOfClient(x, y));
  if (!near) return null;
  return grid.labels[near[1] * grid.W + near[0]];
}

// CAN A BODY AT `from` REACH `to` AT ALL? Both in client units. Null means "cannot say" —
// no geometry, or neither point resolves to free space — and every caller must read null as
// PERMISSION, never as refusal. Being wrong about reachability costs a walk; refusing every
// target because a room has no collision data costs the character its whole day.
export function sameRegion(geo, from, to, { radius = PLAYER_RADIUS, pocketFraction = POCKET_FRACTION } = {}) {
  if (!geo?.collisionReady || !geo.walls?.length) return null;
  const grid = regions(geo, { radius });
  const a = labelAt(geo, from.x, from.y, { radius });
  const b = labelAt(geo, to.x, to.y, { radius });
  if (a == null || b == null) return null;
  if (a === b) return true;
  // A DIFFERENCE IS ONLY WORTH REFUSING WHEN IT IS A POCKET, JUDGED FROM THE MAIN BODY.
  //
  // This clearance test wants a full player radius from every solid wall and the game will
  // let a body squeeze past at an angle, so the margin shows up as splinters — and not random
  // ones. A SAFE SPOT IS THE TIGHTEST SQUARE IN THE ROOM by definition, which is the whole
  // mechanic, so the squares this fleet deliberately seeks out are exactly the ones an
  // over-strict clearance isolates. Refusing on any difference called 10.55% of the pairs of
  // squares the fleet has ACTUALLY HELD unreachable — a character resting on a safe wall
  // would have found every target in the room unreachable and stood there for ever.
  //
  // So: only judge from the main body, and only against a region small enough to be a sealed
  // pocket rather than a splinter or a second hall. Measured against the recorded book, 891
  // held pairs across 31 rooms:
  //
  //     fraction   false refusals   catches the Mausoleum's pockets
  //       0.02       1  (0.11%)     partly — misses the 378-cell one
  //       0.05      16  (1.80%)     yes
  //       0.10      28  (3.14%)     yes
  //       0.20      35  (3.93%)     yes
  //
  // 0.05 is the smallest that still sees both of room 1016's real pockets (378 and 184 cells
  // against a 9,582-cell body). Loosening it buys nothing and costs hunting.
  if (a !== 0) return null;                      // not in the main body: cannot say
  const body = grid.regionSizes?.[0] ?? 0;
  const pocket = grid.regionSizes?.[b] ?? 0;
  if (!body || pocket > body * pocketFraction) return null;
  return false;
}

