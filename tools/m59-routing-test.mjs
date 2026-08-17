#!/usr/bin/env node
// THE CONTRACT TEST FOR PLANNING ON THE MAP THE MOVER ENFORCES.
//
//   node tools/m59-routing-test.mjs
//
// Movement is validated against the CLIENT's BSP; the router planned on the SERVER's
// coarse one-byte-a-square grid. Those disagree, and a router planning on a different map
// from the one the mover enforces does not produce a wrong route — it produces a character
// sliding along a wall, replanning into the same wall, and giving up. Measured offline
// against the twelve boundaries the exit-gap record complains about most, that killed 59%
// of all walks to an exit, and on prod it killed characters: several died in the Western
// border of the Twisted Wood with spiders on them while bouncing between two squares.
//
// WHAT IS PINNED HERE, AND WHY EACH ONE FAILS IN THE DANGEROUS DIRECTION IF INVERTED:
//
//   * `moverStepLands` is the MOVER's question, not `stepAllowedByCollision`'s. The second
//     asks whether a straight line between two square CENTRES arrives with no sliding —
//     which the player, a disc of radius 248 in a square of 1024, frequently cannot do
//     next to a wall. Measured, that predicate breaks room 150 into 159 pieces and room
//     578 into 214; the mover's own gives 15 and 2. Reverting to the strict one does not
//     look like a bug, it looks like a world full of walls.
//
//   * A step mask round-trips bit for bit. A mask read against a different direction
//     order is a confident map of the WRONG doors and nothing downstream could notice.
//
//   * With no mask attached, `path` plans exactly as it did before any of this existed.
//     That is what makes the change safe for a checkout that has never run the bake.
//
//   * `blockedEdges` removes an EDGE and not a SQUARE. A wall sits between two squares;
//     blaming the square removes a perfectly good place to stand that other neighbours
//     still reach, and that was the old behaviour.
//
//   * The bake's regions are STRONGLY CONNECTED COMPONENTS, and the tiny ones against the
//     walls are kept. They are not noise — they are the safe-spot signal, the same
//     geometric fact `substrate/m59-safespots.json` measures from the other side. A pass
//     that smoothed them away to make the count look tidy would throw that away.
//
//   * An exit anchor is chosen from a staging square the room's body can REACH, not the
//     first one the boundary happens to publish. Room 578 came out with all four exits
//     "unreachable" purely because the first square on each list was one the mover cannot
//     get to and the other ten were never considered.
//
// OFFLINE AND FIXTURE-FIRST. The geometry-backed half runs only when a baked map is
// present and reports itself skipped otherwise, because a suite that silently tests
// nothing is worse than one that says it did.

import { existsSync } from 'node:fs';
import { RoomGeometry, protocolToward, STEP_MASK_DIRS, KOD_FINENESS, CLIENT_FINENESS }
  from './m59-roo.mjs';
import { components, exitAnchors } from './m59-routebake.mjs';

let passed = 0, failed = 0, skipped = 0;
function ok(what, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
}
function skip(what, why) { skipped++; console.log(`  --   ${what} — ${why}`); }

// ---------------------------------------------------------------- the quantizer
// One home, two callers: Session.validateFineTarget decides what to SEND and
// moverStepLands decides what to PLAN. Two answers here is a router planning steps the
// mover will not make, which is the entire bug.
console.log('\nprotocolToward — one answer for "which integer square is this"');
{
  const scale = CLIENT_FINENESS / KOD_FINENESS;
  // The broker's inline arithmetic, spelled out, so a drift between them is a failure here
  // rather than a fleet walking into walls.
  const broker = (value, fromValue) => {
    const wire = value / scale + KOD_FINENESS;
    if (value > fromValue) return Math.floor(wire + 1e-9);
    if (value < fromValue) return Math.ceil(wire - 1e-9);
    return Math.round(wire);
  };
  let agree = true;
  for (let from = -2048; from <= 2048; from += 97)
    for (let v = -2048; v <= 2048; v += 31)
      if (protocolToward(v, from) !== broker(v, from)) agree = false;
  ok('it agrees with the arithmetic inside validateFineTarget everywhere', agree);
  ok('it rounds back toward the start when moving forward',
     protocolToward(1000, 0) <= 1000 / scale + KOD_FINENESS);
  ok('it rounds back toward the start when moving backward',
     protocolToward(-1000, 0) >= -1000 / scale + KOD_FINENESS);
  ok('a zero-length move is nearest-rounded rather than biased',
     protocolToward(512, 512) === Math.round(512 / scale + KOD_FINENESS));
}

// ---------------------------------------------------------------- the mask, on a fixture
console.log('\nthe step mask — bit order, round trip, and what an absent one means');
{
  // A tiny room with no collision payload at all. `moverStepLands` must answer "no
  // opinion" there rather than "refused": a room whose collision could not be baked still
  // has a usable coarse grid and must not become unroutable because of this.
  const bare = RoomGeometry.fromJSON({
    rows: 3, cols: 3,
    flags: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    grid: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    moveGrid: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  });
  ok('a room with no collision payload is not collisionReady', !bare.collisionReady);
  ok('and it therefore has no opinion about a step rather than refusing one',
     bare.moverStepLands(2, 2, 1, 1) === true);
  ok('it reports no step mask', bare.hasStepMask === false);
  ok('and `path` therefore defaults to the coarse grid, exactly as before',
     bare.path(1, 1, 3, 3).found === true);

  // Bit order is the one thing a mask cannot survive getting wrong, because nothing
  // downstream can detect it. Pin the order itself, and the round trip through base64.
  ok('the mask has exactly eight directions', STEP_MASK_DIRS.length === 8);
  ok('and they are the DIR table in its own order, so there is one table and not two',
     STEP_MASK_DIRS.map(d => d.name).join(',') ===
     'north,northeast,east,southeast,south,southwest,west,northwest');

  const made = new Uint8Array(bare.rows * bare.cols);
  for (let i = 0; i < made.length; i++) made[i] = (i * 37) & 0xff;
  const b64 = Buffer.from(made).toString('base64');
  const back = new Uint8Array(Buffer.from(b64, 'base64'));
  ok('a mask survives base64 byte for byte',
     back.length === made.length && made.every((v, i) => back[i] === v));
  ok('a mask of the right size is accepted', bare.attachStepMask(back) === true);
  ok('and the geometry then says so', bare.hasStepMask === true);
  ok('a mask of the WRONG size is refused rather than mis-indexed',
     bare.attachStepMask(new Uint8Array(made.length + 1)) === false);
  ok('and refusing one leaves the geometry with none rather than a bad one',
     bare.hasStepMask === false);
  ok('a non-mask is refused', bare.attachStepMask([1, 2, 3]) === false);
}

// ---------------------------------------------------------------- blockedEdges
console.log('\nblockedEdges — a wall is between two squares, not on one of them');
{
  // Three squares in a row, all mutually adjacent through the grid. Blocking the edge
  // 2,2 -> 2,3 must not make 2,3 unreachable: 1,3 still reaches it.
  const flags = new Array(9).fill(1);
  const open = new Array(9).fill(0xff);
  const g = RoomGeometry.fromJSON({ rows: 3, cols: 3, flags, grid: open, moveGrid: open });
  const edge = new Set(['2,2>2,3']);
  ok('the blocked edge is gone from that square\'s neighbours',
     !g.neighbors(2, 2, { blockedEdges: edge }).some(n => n.row === 2 && n.col === 3));
  ok('but the square is still reachable from elsewhere — an edge is not a square',
     g.neighbors(1, 3, { blockedEdges: edge }).some(n => n.row === 2 && n.col === 3));
  ok('and the reverse edge is untouched, because refusals really are one-way',
     g.neighbors(2, 3, { blockedEdges: edge }).some(n => n.row === 2 && n.col === 2));
  const around = g.path(2, 2, 2, 3, { blockedEdges: edge });
  ok('a route to it still exists, going round', around.found === true);
  ok('and it is longer than the single step it replaced', (around.steps?.length ?? 0) > 1);

  const walled = new Set();
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++)
    if (!(r === 2 && c === 3)) walled.add(`${r},${c}>2,3`);
  const none = g.path(1, 1, 2, 3, { blockedEdges: walled });
  ok('when every way in is refused, the answer is no route', none.found === false);
  ok('and it says WHICH view refused, so a caller can fall back to the grid',
     none.blocked_edges === walled.size &&
     /mover/.test(none.reason ?? ''), JSON.stringify(none));
  ok('while the same search with no refusals still finds the step',
     g.path(1, 1, 2, 3).found === true);
}

// ---------------------------------------------------------------- against the real map
console.log('\nagainst the baked world map');
const { movementMapFile } = await import('./m59-map-path.mjs');
const mapFile = movementMapFile();
if (!existsSync(mapFile)) {
  skip('the mover view keeps a room in one piece', 'no baked map on this machine');
  skip('a baked mask agrees with the live predicate', 'ditto');
  skip('exit anchors prefer a staging square the body can reach', 'ditto');
} else {
  const { loadMap } = await import('./m59-map.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const map = loadMap(mapFile);
  const room = map.rooms[578] ?? map.rooms['578'];      // the Cragged Mountains
  const geo = room?.roo ? sharedRoomGeometry(room) : null;
  if (!geo?.collisionReady) {
    skip('the mover view keeps a room in one piece', 'room 578 has no collision geometry');
    skip('a baked mask agrees with the live predicate', 'ditto');
    skip('exit anchors prefer a staging square the body can reach', 'ditto');
  } else {
    // THE MEASUREMENT THAT TURNED THE ROUTER BACK ON. Under the strict centre-to-centre
    // predicate this room is 214 pieces; under the mover's own it is a room.
    let strictRefused = 0, moverRefused = 0, pairs = 0;
    for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
      if (!geo.walkable(r, c)) continue;
      for (const n of geo.neighbors(r, c)) {
        pairs++;
        if (!geo.stepAllowedByCollision(r, c, n.row, n.col)) strictRefused++;
        if (!geo.moverStepLands(r, c, n.row, n.col)) moverRefused++;
      }
    }
    ok('the mover refuses strictly fewer adjacent pairs than the centre-to-centre test',
       moverRefused < strictRefused, `mover ${moverRefused}, strict ${strictRefused}, of ${pairs}`);
    ok('and it refuses only a small minority of them',
       moverRefused / pairs < 0.05, `${(100 * moverRefused / pairs).toFixed(1)}%`);

    const comp = components(geo, { collision: true });
    const biggest = Math.max(...comp.sizes);
    const walkable = comp.sizes.reduce((n, s) => n + s, 0);
    ok('most of the room is one body of floor under the mover view',
       biggest / walkable > 0.6, `${biggest}/${walkable} in ${comp.count} region(s)`);
    ok('and the pockets against the walls are KEPT, because they are the safe spots',
       comp.count > 1 && comp.sizes.filter(s => s === 1).length > 0,
       `${comp.sizes.filter(s => s === 1).length} single-square pocket(s)`);

    // A MASK IS ONLY WORTH HAVING IF IT IS THE SAME ANSWER. This is the assertion that
    // catches a reordered bit table, an off-by-one row stride, or a predicate that drifted
    // between the bake and the runtime.
    const mask = geo.buildStepMask();
    ok('the mask is one byte for every square', mask.length === geo.rows * geo.cols);
    const fresh = RoomGeometry.fromJSON(room.roo);
    fresh.attachStepMask(mask);
    let agree = true, checked = 0;
    for (let r = 1; r <= geo.rows && agree; r++) for (let c = 1; c <= geo.cols && agree; c++) {
      if (!geo.walkable(r, c)) continue;
      for (const d of STEP_MASK_DIRS) {
        const nr = r + d.dr, nc = c + d.dc;
        if (!geo.inBounds(nr, nc) || !geo.walkable(nr, nc)) continue;
        checked++;
        if (fresh.moverStepLands(r, c, nr, nc) !== geo.moverStepLands(r, c, nr, nc)) agree = false;
      }
    }
    ok('reading the mask gives the same answer as tracing, on every pair in the room',
       agree, `${checked} pair(s) compared`);

    // AND THE ANCHOR CHOICE. A boundary publishes many staging squares; taking the first
    // is how this room reported all four exits unreachable.
    const bodySeed = (() => {
      let best = -1, id = -1;
      for (let i = 0; i < comp.sizes.length; i++) if (comp.sizes[i] > best) { best = comp.sizes[i]; id = i; }
      for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++)
        if (geo.walkable(r, c) && comp.label[comp.at(r, c)] === id) return { r, c };
      return null;
    })();
    const body = new Set();
    if (bodySeed) {
      const stack = [bodySeed];
      body.add(`${bodySeed.r},${bodySeed.c}`);
      while (stack.length) {
        const at = stack.pop();
        for (const n of geo.neighbors(at.r, at.c, { collision: true })) {
          const k = `${n.row},${n.col}`;
          if (body.has(k)) continue;
          body.add(k); stack.push({ r: n.row, c: n.col });
        }
      }
    }
    const naive = exitAnchors(room, geo);
    const chosen = exitAnchors(room, geo, { reachable: body });
    const reach = list => list.filter(a => body.has(`${a.row},${a.col}`)).length;
    ok('choosing anchors with the body in hand reaches at least as many exits',
       reach(chosen) >= reach(naive),
       `first-offered ${reach(naive)}/${naive.length}, body-aware ${reach(chosen)}/${chosen.length}`);
    ok('and on the Cragged Mountains it strictly improves on taking the first offered',
       reach(chosen) > reach(naive),
       `first-offered ${reach(naive)}, body-aware ${reach(chosen)}`);
    ok('an anchor it cannot reach is still OFFERED rather than deleted — a bake must ' +
       'never be the reason a doorway disappears',
       chosen.length === naive.length);
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
