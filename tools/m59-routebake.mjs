#!/usr/bin/env node
// EXIT TO EXIT, WORKED OUT ONCE, OFFLINE, AGAINST THE MAP THE MOVER ACTUALLY ENFORCES.
//
//   node tools/m59-routebake.mjs                 bake every room
//   node tools/m59-routebake.mjs --rooms 150,578 just these
//   node tools/m59-routebake.mjs --check         report, write nothing
//   node tools/m59-routebake.mjs --resume        keep what is already on disk, bake the rest
//   node tools/m59-routebake.mjs --grid          the old coarse view, for comparison only
//
// THIRTEEN MINUTES ON THIS MACHINE, FLUSHED EVERY MINUTE. `--resume` adopts the rooms
// already in the table when — and only when — they were baked from the same geometry and
// the same view, so a killed bake costs a minute rather than the lot.
//
// WHAT THE RUNTIME ACTUALLY USES OUT OF THIS IS THE STEP MASK. The routes and the region
// labels are useful; the mask is the thing that changes behaviour, because it turns "would
// the mover take this step" from a 0.44ms trace into an array index and so lets the router
// plan on the same map the mover enforces without stopping the event loop.
//
// WHY THIS EXISTS, AND WHY IT IS A BAKE RATHER THAN A BUDGET.
//
// Since #18 movement is validated against the CLIENT's BSP — walls, sector heights, the
// player radius — while the router planned on the SERVER's coarse one-byte-a-square grid.
// Those disagree, and a router planning on a different map from the one the mover enforces
// does not produce a wrong route: it produces a character walking into a wall for ever.
//
// Making the router ask the mover's own trace fixes it and CANNOT BE DONE AT RUNTIME. The
// trace is synchronous and CPU-bound, A* calls it tens of thousands of times, and every
// session in the broker shares one event loop — so a cold path measured 1.2s during which
// no character's keepalive is answered. Shipped on by default, it took twelve of
// twenty-one characters out of the world in five minutes.
//
// Offline there is no loop to block. So the expensive, correct thing is done once here and
// the runtime does a lookup.
//
// ---------------------------------------------------------------------------
// WHAT IS STORED, AND THE TWO DIFFERENT QUESTIONS IT ANSWERS
//
//   components — every walkable square labelled by which collision-connected region it is
//                in, and each exit tagged with its region. This answers "is there a route
//                at all" in O(1), and that is the question that was most expensive to get
//                wrong: rooms 578 and 101 each burned a full A* exhaustion to conclude
//                "no route", every pass, for characters that genuinely cannot walk out.
//                A room with two regions is not broken — the Cragged Mountains has a cliff
//                and you need `blink` to get up it.
//
//   routes     — the actual step list between each ordered pair of exits in the same
//                region, as a direction string. One BFS per exit rather than one per PAIR:
//                a single search from an exit square yields the shortest path to every
//                other square in the room, including all the other exits.
//
// ONE BFS PER EXIT, NOT PER PAIR. The busiest room here has 58 exits; per-pair would be
// 3,306 searches for what 58 already answer.
//
// PATHS ARE STORED AS DIRECTIONS, NOT SQUARES. A step is one of eight neighbours, so it is
// one character; a forty-step route is forty bytes rather than forty coordinate pairs. The
// squares are recovered by walking the string from the known start.
//
// A SIBLING FILE, NOT substrate/m59-map.json. That file is already 27 MB and is the
// checked map with its own manifest; this is derived from it and regenerable, and mixing
// the two would mean rebaking geometry to change a routing decision.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap } from './m59-map.mjs';
import { movementMapFile } from './m59-map-path.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
export const ROUTES_FILE = () => process.env.M59_ROUTES_FILE ||
  join(REPO, 'substrate', 'm59-routes.json');

// The eight directions, in a fixed order, so a stored path is stable across bakes. The
// letter is what goes in the string.
export const STEP_DIRS = [
  ['n', -1, 0], ['s', 1, 0], ['e', 0, 1], ['w', 0, -1],
  ['a', -1, 1], ['b', 1, 1], ['c', 1, -1], ['d', -1, -1],
];
const BY_LETTER = new Map(STEP_DIRS.map(([ch, dr, dc]) => [ch, { dr, dc }]));

/** Walk a stored direction string back into squares. */
export function replay(fromRow, fromCol, path) {
  const out = [];
  let r = fromRow, c = fromCol;
  for (const ch of String(path ?? '')) {
    const d = BY_LETTER.get(ch);
    if (!d) return out;
    r += d.dr; c += d.dc;
    out.push({ row: r, col: c });
  }
  return out;
}

/**
 * The squares a room's exits are used from.
 *
 * An edge exit is used from one of its approach squares — the model's own answer to "where
 * do you stand to cross this boundary". A `go` exit names its square outright. Both are
 * reduced to a square, because that is what a route ends at.
 */
export function exitAnchors(room, geometry, { reachable = null } = {}) {
  const out = [];
  for (const e of room.edgeExits ?? []) {
    const dir = e.leaveName ?? null;
    if (!dir) continue;
    // A BOUNDARY PUBLISHES MANY STAGING SQUARES AND THEY ARE NOT INTERCHANGEABLE. This
    // took the first one offered and called that the exit, which is how room 578 came out
    // with all four of its exits "unreachable" while a character can plainly walk to three
    // of them — the first square on the list happened to be one the mover cannot get to,
    // and the other ten were never considered. `reachable` is the room's own body, so a
    // square it can walk to always beats a square merely printed first.
    let best = null, fallback = null;
    try {
      for (const a of geometry.edgeApproachCandidates(dir)) {
        for (const stage of a.stages ?? []) {
          fallback ??= stage;
          if (!reachable || reachable.has(`${stage.row},${stage.col}`)) { best = stage; break; }
        }
        if (best) break;
      }
    } catch { /* an unbaked direction simply offers nothing */ }
    best ??= fallback;
    if (!best) continue;
    out.push({ kind: 'edge', dir, to: e.to, row: best.row, col: best.col });
  }
  for (const g of room.goExits ?? []) {
    if (!Number.isInteger(g.row) || !Number.isInteger(g.col)) continue;
    out.push({ kind: 'go', to: g.to, row: g.row, col: g.col, locked: !!g.locked });
  }
  // One anchor per square: two exits sharing a square are one place to walk to.
  const seen = new Set();
  return out.filter(a => {
    const k = `${a.row},${a.col}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// WHICH VIEW OF "CAN I STEP THERE" THE BAKE USES — AND THE CORRECTION THAT MADE THE
// STRICT ONE USABLE AT ALL.
//
// This file used to say the mover's own view could not be baked: on room 150 it refused
// 10% of grid-adjacent walkable pairs and broke every room into 109 to 214 disconnected
// regions, which is plainly not what a room is. That measurement was real and the
// conclusion drawn from it was wrong, because it was measuring the wrong predicate.
//
// `RoomGeometry.stepAllowedByCollision` asks whether the straight line between two square
// CENTRES arrives exactly, with no sliding. `Session.validateFineTarget` — the thing that
// actually decides whether a step happens — slides, quantizes toward the start, and cares
// only that the endpoint is IN the target square, because `walkTo` compares squares. The
// player is a disc of radius 248 in a square of 1024, so centres near walls are places
// nobody stands and a person walking that corridor never tries to.
//
// Asked the mover's real question (`RoomGeometry.moverStepLands`), the same rooms come out
// as rooms: 150 in 15 regions with 96% of it in one, 578 in TWO with 99.4% in one, 545 in
// 10 with 98.5% in one, against 159, 214 and 101 before. That is the difference between a
// routing table that shatters and one that can be planned on.
//
// So the mover's view is now the DEFAULT here and `--grid` asks for the old coarse one.
// The file records which view it used, because mixing the two silently would produce a
// table that is right about some rooms and confidently wrong about others with nothing on
// its face to say which.
// A REGION IS A SET OF SQUARES THAT CAN ALL REACH EACH OTHER, WHICH MEANS THIS HAS TO BE
// A STRONGLY CONNECTED COMPONENT AND NOT A FLOOD FILL.
//
// The mover's step graph is DIRECTED, and heavily so: measured on room 150, 2,606 of
// 23,219 adjacent pairs (11%) are one-way. That is not a modelling artifact — the stock
// client's wall test only blocks a move that gets CLOSER to a wall, so a square whose
// centre already lies inside a wall's radius is one a character can leave and cannot
// enter. There really are such squares and they really are one-way.
//
// THE DOZENS OF TINY REGIONS AGAINST THE WALLS ARE NOT NOISE — THEY ARE THE SAFE SPOTS.
// A room coming out in ninety pieces is ninety-odd real features: one big body of floor
// and a scatter of corners the BSP hems in. That is the same geometric fact the safe-spot
// book measures from the other side (`substrate/m59-safespots.json`, and the note in
// CLAUDE.md): a square whose lines to the surrounding floor are broken is a square whose
// line to a MONSTER is broken, and `Room.LineOfSight` is checked for the monster and never
// for us. Held rates run 28% at zero refused neighbours and 70% at four or more. So this
// pass is a safe-spot predictor as much as a routing one, and smoothing the pockets away
// to make the count look tidy would throw away the more valuable half.
//
// What was actually wrong with the old flood is narrower and matters for both uses: it
// labelled "everything reachable FROM here", so the answer depended on which square it
// happened to start from and it was not a partition — and it could not tell a pocket you
// can leave but not enter from one you can enter but not leave. Those are opposite facts.
// For routing, one is a trap and the other is a detour. For a safe spot, the one you can
// step into and out of is the one worth walking to. Tarjan keeps every pocket and
// distinguishes them; `sizes` is what says which is which.
//
// Iterative, because these rooms reach 8,639 walkable squares and recursion would not
// survive the Cragged Mountains.
export function components(geometry, { collision = true } = {}) {
  const { rows, cols } = geometry;
  const at = (r, c) => r * (cols + 2) + c;
  const label = new Int32Array((rows + 2) * (cols + 2)).fill(-1);
  const index = new Int32Array((rows + 2) * (cols + 2)).fill(-1);
  const low = new Int32Array((rows + 2) * (cols + 2)).fill(0);
  const onStack = new Uint8Array((rows + 2) * (cols + 2));
  const sccStack = [];
  const sizes = [];
  let counter = 0, next = 0;

  for (let r0 = 1; r0 <= rows; r0++) {
    for (let c0 = 1; c0 <= cols; c0++) {
      if (!geometry.walkable(r0, c0) || index[at(r0, c0)] !== -1) continue;
      // Each frame is one square plus how many of its neighbours have been dealt with.
      const work = [{ r: r0, c: c0, i: 0, ns: null }];
      while (work.length) {
        const frame = work[work.length - 1];
        const k = at(frame.r, frame.c);
        if (frame.i === 0) {
          index[k] = counter; low[k] = counter; counter++;
          sccStack.push(k); onStack[k] = 1;
          // The MOVER's neighbours, not the grid's — that is the whole point of the bake.
          frame.ns = geometry.neighbors(frame.r, frame.c, { collision });
        }
        if (frame.i < frame.ns.length) {
          const n = frame.ns[frame.i++];
          const nk = at(n.row, n.col);
          if (index[nk] === -1) work.push({ r: n.row, c: n.col, i: 0, ns: null });
          else if (onStack[nk]) low[k] = Math.min(low[k], index[nk]);
          continue;
        }
        work.pop();
        if (work.length) {
          const parent = at(work[work.length - 1].r, work[work.length - 1].c);
          low[parent] = Math.min(low[parent], low[k]);
        }
        if (low[k] === index[k]) {
          const id = next++;
          let size = 0, popped;
          do { popped = sccStack.pop(); onStack[popped] = 0; label[popped] = id; size++; }
          while (popped !== k);
          sizes.push(size);
        }
      }
    }
  }
  return { label, at, count: next, sizes };
}

/** Shortest collision-valid path from one square to every other, as a came-from map. */
function bfs(geometry, fromRow, fromCol, { collision = true } = {}) {
  const { cols } = geometry;
  const came = new Map();
  const key = (r, c) => r * (cols + 2) + c;
  const start = key(fromRow, fromCol);
  came.set(start, null);
  let frontier = [[fromRow, fromCol]];
  while (frontier.length) {
    const nextFrontier = [];
    for (const [r, c] of frontier) {
      for (const n of geometry.neighbors(r, c, { collision })) {
        const k = key(n.row, n.col);
        if (came.has(k)) continue;
        came.set(k, { row: r, col: c, dir: n.dir });
        nextFrontier.push([n.row, n.col]);
      }
    }
    frontier = nextFrontier;
  }
  return { came, key };
}

const LETTER = new Map(STEP_DIRS.map(([ch, dr, dc]) => [`${dr},${dc}`, ch]));

function pathString(came, key, fromRow, fromCol, toRow, toCol) {
  const steps = [];
  let r = toRow, c = toCol;
  for (;;) {
    const prev = came.get(key(r, c));
    if (prev === undefined) return null;          // unreachable
    if (prev === null) break;                     // reached the start
    const ch = LETTER.get(`${r - prev.row},${c - prev.col}`);
    if (!ch) return null;
    steps.push(ch);
    r = prev.row; c = prev.col;
    if (r === fromRow && c === fromCol) break;
  }
  return steps.reverse().join('');
}

/** Bake one room. */
export function bakeRoom(room, { collision = true } = {}) {
  const geometry = sharedRoomGeometry(room);
  if (!geometry?.collisionReady)
    return { room: room.num, skipped: 'no collision geometry' };
  // THE MASK FIRST, BECAUSE EVERYTHING ELSE HERE IS THEN A LOOKUP. Attaching it makes
  // `neighbors({collision:true})` an array index for the component pass and every BFS
  // below, instead of eight traces a square repeated by each of them.
  const mask = collision ? geometry.buildStepMask() : null;
  if (mask) geometry.attachStepMask(mask);
  const comp = components(geometry, { collision });
  // THE ROOM ITSELF IS THE BIGGEST REGION AND EVERY OTHER ONE IS A POCKET — but "outside
  // the main region" is NOT the same as "cannot be walked to", and conflating the two is
  // the trap this bake nearly shipped. An exit anchor is usually a pocket by design: you
  // step into the doorway and you cannot step back off it into the room. So what a
  // consumer needs is one-directional — can the body of the room REACH this square —
  // which is one flood from any square of the main region, not an equality test.
  //
  // Computed BEFORE the anchors, because choosing which staging square on a boundary is
  // "the exit" is exactly the decision that needs this answer.
  let mainRegion = -1, mainSize = 0;
  for (let id = 0; id < comp.sizes.length; id++)
    if (comp.sizes[id] > mainSize) { mainSize = comp.sizes[id]; mainRegion = id; }
  let mainSeed = null;
  for (let r = 1; r <= geometry.rows && !mainSeed; r++)
    for (let c = 1; c <= geometry.cols && !mainSeed; c++)
      if (geometry.walkable(r, c) && comp.label[comp.at(r, c)] === mainRegion) mainSeed = { r, c };
  const reachedFromBody = new Set();
  if (mainSeed) {
    const stack = [mainSeed];
    reachedFromBody.add(`${mainSeed.r},${mainSeed.c}`);
    while (stack.length) {
      const at = stack.pop();
      for (const n of geometry.neighbors(at.r, at.c, { collision })) {
        const k = `${n.row},${n.col}`;
        if (reachedFromBody.has(k)) continue;
        reachedFromBody.add(k);
        stack.push({ r: n.row, c: n.col });
      }
    }
  }

  const anchors = exitAnchors(room, geometry, { reachable: reachedFromBody });
  const regionOf = a => comp.label[comp.at(a.row, a.col)];
  const tagged = anchors.map(a => ({ ...a, region: regionOf(a),
                                     from_body: reachedFromBody.has(`${a.row},${a.col}`) }));
  const strandedExits = tagged.filter(a => !a.from_body).length;

  // ONE BFS PER ANCHOR, AND NO SAME-REGION FILTER ON IT.
  //
  // This used to skip any pair of anchors in different regions, which was right when a
  // region was a flood fill and is wrong now that it is a strongly connected component:
  // an exit square is very often a POCKET ON PURPOSE — you can step onto it and you cannot
  // step back off it into the room, because that is what standing in a doorway is. Under
  // mutual reachability every one of room 578's four exits sits outside the main body, and
  // filtering on that would have baked no routes to any of them.
  //
  // The BFS already answers the only question that matters — is there a way from here to
  // there — so it is simply asked, and a pair with no path silently produces no entry.
  const routes = {};
  for (const from of tagged) {
    if (from.region < 0) continue;
    const targets = tagged.filter(t => t !== from);
    if (!targets.length) continue;
    const { came, key } = bfs(geometry, from.row, from.col, { collision });
    for (const to of targets) {
      const p = pathString(came, key, from.row, from.col, to.row, to.col);
      if (p == null) continue;
      routes[`${from.row},${from.col}>${to.row},${to.col}`] = p;
    }
  }
  return {
    room: room.num,
    rows: geometry.rows, cols: geometry.cols,
    // ONE BYTE A SQUARE, ONE BIT A DIRECTION, in `STEP_MASK_DIRS` order — the whole of
    // `moverStepLands`, so the runtime never has to trace. 510,789 squares across 264
    // rooms is 0.49 MB raw and 0.65 MB base64; the trace it replaces cost 1.2s on one
    // cold path and took twelve characters out of the world. See RoomGeometry.buildStepMask.
    ...(mask ? { stepMask: Buffer.from(mask).toString('base64') } : {}),
    security: geometry.security ?? null,
    view: collision ? 'collision' : 'grid',
    regions: comp.count,
    main_region: mainRegion,
    main_region_squares: mainSize,
    walkable: comp.sizes.reduce((n, s) => n + s, 0),
    // Every region that is not the room proper, smallest first. These are the corners the
    // BSP hems in — the safe-spot candidates — and a one-square one is the strongest.
    pockets: comp.sizes.filter((_, id) => id !== mainRegion).length,
    stranded_exits: strandedExits,
    // `from_body` is the one a router should read: can the room walk to this exit. `region`
    // is kept beside it because a pocket exit and a main-body exit behave differently once
    // you are standing on one — the first cannot be stepped back off.
    anchors: tagged.map(a => ({ kind: a.kind, dir: a.dir ?? null, to: a.to ?? null,
                                row: a.row, col: a.col, region: a.region,
                                from_body: !!a.from_body })),
    routes,
  };
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const val = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const only = val('--rooms')?.split(',').map(Number).filter(Number.isFinite) ?? null;
  const check = argv.includes('--check');
  // The mover's view is the point of the bake now; `--grid` asks for the old coarse one,
  // which is only useful for comparing the two.
  const collision = !argv.includes('--grid');

  const map = loadMap(movementMapFile());
  const manifest = map.geometryManifestSha256 ?? null;
  const rooms = Object.values(map.rooms)
    .filter(r => r?.roo && (!only || only.includes(Number(r.num))));

  // THIRTEEN MINUTES THAT USED TO BE ALL-OR-NOTHING. The whole table was one write after
  // the loop, so a Ctrl-C, a reboot or an OOM at room 250 of 264 produced nothing at all
  // and the next run started from the beginning. Two things fix that and they are the same
  // mechanism: the partial table is flushed as it goes, and a rerun can adopt what is
  // already on disk.
  //
  // ADOPTION IS GATED ON THE MANIFEST AND ON THE VIEW, because a half-table stitched from
  // two different maps is exactly the confidently-wrong artifact this file keeps warning
  // about — and unlike a stale table, nothing downstream could detect it. Same geometry
  // and same view, or the existing rooms are ignored and it bakes from scratch.
  const resume = argv.includes('--resume');
  const out = {};
  if (resume) {
    try {
      const prior = JSON.parse(readFileSync(ROUTES_FILE(), 'utf8'));
      const sameMap = prior?.geometryManifestSha256 && manifest
        && prior.geometryManifestSha256 === manifest;
      const sameView = (prior?.view ?? 'grid') === (collision ? 'collision' : 'grid');
      if (sameMap && sameView) {
        for (const [num, baked] of Object.entries(prior.rooms ?? {}))
          if (baked && !baked.skipped) out[num] = baked;
        console.error(`resuming: ${Object.keys(out).length} room(s) already baked from the same map`);
      } else {
        console.error(`ignoring the table on disk — ` +
          (!sameMap ? 'it was baked from different geometry' : `it is the ${prior?.view} view`));
      }
    } catch { console.error('nothing usable on disk to resume from'); }
  }
  const todo = rooms.filter(r => !(String(r.num) in out));
  console.error(`baking ${todo.length} room(s)${resume && todo.length !== rooms.length
    ? ` (${rooms.length - todo.length} already done)` : ''}…`);

  let skipped = 0, pairs = 0, pockets = 0, stranded = 0;
  const t0 = Date.now();
  // Flushed on a CLOCK rather than every N rooms, because room sizes vary by two orders
  // of magnitude here: 264 rooms is anything from 18ms to 30s each, so "every 25 rooms"
  // is thirty seconds in one place and six minutes in another.
  const FLUSH_MS = 60_000;
  let lastFlush = Date.now();
  const write = () => {
    mkdirSync(dirname(ROUTES_FILE()), { recursive: true });
    writeFileSync(ROUTES_FILE(), JSON.stringify({
      format: 'm59-routes/1',
      view: collision ? 'collision' : 'grid',
      builtAt: new Date().toISOString(),
      builtFrom: movementMapFile(),
      geometryManifestSha256: manifest,
      // Says outright that the table is short of the map it was built from, so a partial
      // flush cannot be mistaken for a finished bake by anything reading it.
      complete: Object.keys(out).length + skipped >= rooms.length && !only,
      rooms: out,
    }));
  };

  for (const [i, room] of todo.entries()) {
    const t = Date.now();
    const baked = bakeRoom(room, { collision });
    if (baked.skipped) { skipped++; continue; }
    out[baked.room] = baked;
    pairs += Object.keys(baked.routes).length;
    pockets += baked.pockets ?? 0;
    stranded += baked.stranded_exits ?? 0;
    if (todo.length > 5)
      process.stderr.write(`\r  ${i + 1}/${todo.length}  room ${baked.room} ` +
        `${baked.anchors.length} exits, ${baked.main_region_squares}/${baked.walkable} ` +
        `in the main body, ${baked.pockets} pocket(s), ` +
        `${Object.keys(baked.routes).length} routes, ${Date.now() - t}ms      `);
    if (!check && Date.now() - lastFlush >= FLUSH_MS) { write(); lastFlush = Date.now(); }
  }
  process.stderr.write('\n');
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`baked ${Object.keys(out).length} room(s) in ${took}s — ${pairs} routes, ` +
                `${skipped} without collision geometry, ${pockets} pocket(s) off the main ` +
                `body (safe-spot candidates), ${stranded} exit(s) stranded outside it`);

  if (check) {
    // WHAT A ROOM ACTUALLY LOOKS LIKE, rather than a region count. A room in a hundred
    // pieces with 99% of its floor in one of them is a normal room with a lot of corners.
    // The line worth acting on is an exit THE BODY OF THE ROOM CANNOT REACH.
    //
    // AND THAT IS A CLAIM ABOUT THIS MODEL, NOT ABOUT THE WORLD. This report used to say
    // "walking cannot join those; that is what blink is for" about every such exit, which
    // is an overclaim three ways over. Most of them are neither:
    //
    //   * a doorway is a POCKET BY DESIGN — you step onto the exit square and cannot step
    //     back off it into the room — and is reached perfectly well from the body;
    //   * this model is stricter than the client it models, so an unreachable reading is
    //     as likely to be ours as the map's;
    //   * the one place in the world genuinely joined only by blink is the CRAGGED
    //     MOUNTAINS cliff (578, and 598 by the same name): entering by the north-west, the
    //     south-west and south-east exits are a one-way trip unless you blink up the cliff
    //     near the north-west corner.
    //
    // So this says what it measured and leaves the conclusion to somebody who can go and
    // look. A refusal we invented reads exactly like a wall, which is the failure this
    // whole routing path exists to stop repeating.
    const rows = Object.values(out).sort((a, b) =>
      (b.stranded_exits - a.stranded_exits) || (a.main_region_squares / a.walkable) - (b.main_region_squares / b.walkable));
    for (const r of rows.slice(0, 12))
      console.error(`  room ${String(r.room).padEnd(5)} ` +
        `${String(Math.round(100 * r.main_region_squares / Math.max(1, r.walkable))).padStart(3)}% of ${String(r.walkable).padStart(5)} squares in one body, ` +
        `${String(r.pockets).padStart(4)} pocket(s), ` +
        (r.stranded_exits
          ? `${r.stranded_exits} of ${r.anchors.length} exit(s) this model cannot walk to from that body — go and look before believing it`
          : `all ${r.anchors.length} exit(s) reachable from it`));
  } else {
    write();
    const mb = (readFileSync(ROUTES_FILE()).length / 1048576).toFixed(2);
    console.error(`wrote ${ROUTES_FILE()} (${mb} MB)`);
  }
}
