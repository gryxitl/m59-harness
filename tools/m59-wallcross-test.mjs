#!/usr/bin/env node
// DOES A PLANNED ROUTE CROSS A WALL? Asked of the WALL LIST, not of the collision model.
//
//   node tools/m59-wallcross-test.mjs
//   node tools/m59-wallcross-test.mjs --room 1012 --pairs 300
//
// EVERY OTHER COLLISION TEST HERE ASKS THE MOVER AND BELIEVES THE ANSWER, so none of them
// can catch the mover being wrong -- only the mover being inconsistent with itself. The 153
// assertions in m59-collision-test are all positive ("this legitimate move remains usable"),
// and m59-impossible-test asserts refusals against traces recorded from the same tracer. A
// blind spot shared by the model and its tests is invisible to both.
//
// This asks a question with an independent oracle: take the room's WALL LIST straight out of
// the baked .roo -- coordinates and the passable bit, never passed through the tracer -- and
// intersect it, as line segments, with the centre-to-centre steps `path()` produces. A step
// that crosses a wall the data itself calls solid is a plan through a wall, whatever the
// collision model believes.
//
// IT FOUND ONE. Room 1012 (Raza), wall 388 at y=10752 is solid and runs along the centre
// line of row 11 -- which is also its BSP splitter. A centre-to-centre step therefore STARTS
// exactly on the plane, `oldDistance` is 0, and move.c's "are we moving away from this plane"
// guard skips the node and never tests its walls. The step 43,11 -> 43,10 crossed a solid
// wall reporting `arrived: true`, and the router planned through it every time.
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import './m59-navgeom.mjs';
import { sharedRoomGeometry, KOD_FINENESS as K } from './m59-roo.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n);
                        return i > 0 ? process.argv[i + 1] : d; };
const PAIRS = Number(arg('pairs', 120));
const ONLY  = arg('room', null);
let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? '  ' + detail : ''}`); }
};

const CLIENT = 1024;
const centre = (c, r) => [(c - 0.5) * CLIENT, (r - 0.5) * CLIENT];
// Proper segment/segment intersection. Endpoints count: a step that merely grazes a wall's
// end is exactly the case the mover slides along, and calling that a crossing would make
// this fire on legitimate movement.
function crosses(a, b, c, d) {
  const s1x = b[0] - a[0], s1y = b[1] - a[1], s2x = d[0] - c[0], s2y = d[1] - c[1];
  const den = -s2x * s1y + s1x * s2y;
  if (Math.abs(den) < 1e-9) return false;                 // parallel: never a crossing
  const s = (-s1y * (a[0] - c[0]) + s1x * (a[1] - c[1])) / den;
  const t = ( s2x * (a[1] - c[1]) - s2y * (a[0] - c[0])) / den;
  const EPS = 1e-6;
  return s > EPS && s < 1 - EPS && t > EPS && t < 1 - EPS;
}

const map = loadMap();
attachStepMasks(map);

// ---------------------------------------------------------------------------
console.log('the fence in Raza — the case this test was written for');
{
  const g = sharedRoomGeometry(map.rooms[1012]);
  const wall = (g.walls || []).find(w => Math.round(w.y0) === 10752 && Math.round(w.x0) === 40704);
  ok('wall 388 is present and the data calls it solid', !!wall && wall.passable === false);
  if (wall) {
    const t = g.traceFineMoveClient(43520, 10752, 43520, 9728, { slide: false });
    ok('a centre-to-centre step through it is refused by the tracer',
       !!t && (t.blocked === true || t.arrived === false),
       JSON.stringify({ arrived: t?.arrived, blocked: t?.blocked, reason: t?.reason }));
    ok('and the mover does not authorise the step',
       g.moverStepLands(11, 43, 10, 43) === false,
       'moverStepLands still returns true — the baked step mask may predate the fix');
  }
}

// ---------------------------------------------------------------------------
console.log('\nno planned route may cross a wall the data calls solid');
{
  const rooms = (ONLY ? [Number(ONLY)] : [1012, 587, 50, 597, 545])
    .filter(n => sharedRoomGeometry(map.rooms[n])?.collisionReady);
  let seed = 5;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const num of rooms) {
    const g = sharedRoomGeometry(map.rooms[num]);
    const solid = (map.rooms[num].roo.walls || []).filter(w => !(w[4] & 1));
    let planned = 0, bad = 0, worst = null;
    for (let n = 0; n < PAIRS; n++) {
      const pick = () => { for (let t = 0; t < 80; t++) {
        const r = 1 + Math.floor(rnd() * g.rows), c = 1 + Math.floor(rnd() * g.cols);
        if (g.standable(r, c)) return { r, c }; } return null; };
      const a = pick(), b = pick(); if (!a || !b) continue;
      const p = g.path(a.r, a.c, b.r, b.c);
      if (!p?.found) continue;
      planned++;
      let here = [a.c, a.r];
      for (const st of p.steps) {
        const A = centre(...here), B = centre(st.col, st.row);
        const hit = solid.find(w => crosses(A, B, [w[0], w[1]], [w[2], w[3]]));
        if (hit) { bad++; worst ??= `${here[0]},${here[1]} -> ${st.col},${st.row}`; break; }
        here = [st.col, st.row];
      }
    }
    ok(`${String(num).padStart(4)} ${String(map.rooms[num].name).slice(0, 26).padEnd(27)} ` +
       `${String(planned).padStart(3)} routes, ${bad} through a solid wall`,
       bad === 0, worst ? `first: ${worst}` : '');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
