#!/usr/bin/env node
// m59-ground-test.mjs -- unit tests for the grounded-square predicate.
// Offline, no network. Run: node tools/m59-ground-test.mjs

import { isGrounded, isEmbedded, nearestGrounded, segHeightOk } from './tick/m59-ground.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) {
  // ARGUMENT-ORDER GUARD. This suite's signature is ok(cond, msg). Seven other suites in this
  // directory use the OPPOSITE order, ok(what, cond, detail). Writing a call in the other style
  // produces no error and no failure — a non-empty message string is truthy, so the assertion can
  // never fail and is still counted as a pass. That is not hypothetical: 28 assertions in this
  // file and m59-ground-test.mjs were written that way and reported 'passed' through a full day of
  // changes to the code underneath every claim made from them. A vacuous assertion is worse than a
  // missing one precisely because it is counted.
  if (typeof cond === 'string') {
    fail++;
    console.log(`  FAIL ok() got a string as its CONDITION — argument order is inverted, so this ` +
                `assertion cannot fail: ${cond.slice(0, 70)}`);
    return;
  }
  if (cond) { pass++; console.log(`  ok   ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
}

// Fake geometry: ground everywhere except the 3x3 void at cols/rows 1..3,
// and a wall cell at (10,10) (grounded but inside a wall).
function fakeGeo() {
  return {
    collisionReady: true,
    inBounds: (r, c) => r >= 1 && r <= 20 && c >= 1 && c <= 20,
    standable: (r, c) => !(r >= 1 && r <= 3 && c >= 1 && c <= 3),
    fineWalkable: (r, c) => (r === 10 && c === 10) ? false : true,
  };
}

{
  const g = fakeGeo();
  ok(isGrounded(g, 5, 5) === true, 'grounded square reads true');
  ok(isGrounded(g, 2, 2) === false, 'void square reads false');
  ok(isGrounded(g, 0, 5) === false, 'out-of-bounds reads false');
  ok(isGrounded(null, 2, 2) === undefined, 'no geometry reads undefined');
  ok(isGrounded({}, 2, 2) === undefined, 'no standable reads undefined');
  ok(isGrounded({ standable: () => false }, 2, 2) === undefined,
     'explicit false without collisionReady reads undefined (no data)');
}

{
  const g = fakeGeo();
  const n = nearestGrounded(g, 2, 2, { maxRadius: 10 });
  ok(n && n.col === 4 && n.row === 1, 'nearest grounded from void corner is (4,1)', JSON.stringify(n));
}

{
  const g = fakeGeo();
  const n = nearestGrounded(g, 2, 2, { maxRadius: 1 });
  ok(n === null, 'nothing grounded within radius 1 of the void returns null');
}

{
  // (10,10) is grounded but inside a wall: nearestGrounded must skip it.
  const g = fakeGeo();
  const n = nearestGrounded(g, 10, 9, { maxRadius: 3 });
  ok(n && !(n.col === 10 && n.row === 10), 'walled grounded cell is skipped', JSON.stringify(n));
  ok(n && isGrounded(g, n.row, n.col) === true, 'returned cell is grounded');
}

console.log('\nsegHeightOk honors only the climb refusal');
{
  const steep = { traceFineMoveClient: () => ({ blocked: true, reason: 'step_too_high' }) };
  const wall = { traceFineMoveClient: () => ({ blocked: true, reason: 'geometry_blocked' }) };
  const clear = { traceFineMoveClient: () => ({ blocked: false, arrived: true }) };
  ok(segHeightOk(steep, 160, 160, 320, 160) === false, 'cliff refused');
  ok(segHeightOk(wall, 160, 160, 320, 160) === true, 'wall passes (doors must)');
  ok(segHeightOk(clear, 160, 160, 320, 160) === true, 'clear passes');
  ok(segHeightOk({}, 160, 160, 320, 160) === undefined, 'no trace passes (old behavior)');
  ok(segHeightOk(null, 160, 160, 320, 160) === undefined, 'no geometry passes');
}

console.log('\nisEmbedded: sub-body-width cracks are not walkable');
{
  // Fake geo: everything x < 1000 is a crack (trace reports blocked).
  const geo = { traceFineMoveClient: (x1, y1, x2, y2) => ({ blocked: x1 < 1000 }) };
  ok(isEmbedded(geo, 100, 100) === true, 'crack point is embedded');
  ok(isEmbedded(geo, 50000, 50000) === false, 'open point is not embedded');
  ok(isEmbedded({}, 100, 100) === undefined, 'no trace model is unknown');
}

console.log('\ntransitBanned: thickets pass, holes and walls refuse');
{
  const { transitBanned } = await import('./tick/m59-ground.mjs');
  const mk = (stand, point, fine) => ({
    inBounds: () => true,
    fineWalkable: () => fine,
    standable: () => stand,
    standPoint: () => point,
  });
  ok(transitBanned(mk(false, { x: 1, y: 2 }, true), 1, 1) === false, 'thicket (standable false, point) passes', 'thicket');
  ok(transitBanned(mk(false, null, true), 1, 1) === true, 'hole (standable false, no point) banned', 'hole');
  ok(transitBanned(mk(true, { x: 1 }, false), 1, 1) === true, 'wall (fine false) banned even with point', 'wall');
  ok(transitBanned(mk(true, { x: 1 }, true), 1, 1) === false, 'ground passes', 'ground');
  ok(transitBanned({ inBounds: () => false }, 1, 1) === true, 'oob banned', 'oob');
  const legacy = { inBounds: () => true, standable: () => false };
  ok(transitBanned(legacy, 1, 1) === true, 'no standPoint fn: legacy strictness', 'legacy');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
