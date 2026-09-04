#!/usr/bin/env node
// m59-ground-test.mjs -- unit tests for the grounded-square predicate.
// Offline, no network. Run: node tools/m59-ground-test.mjs

import { isGrounded, nearestGrounded, segHeightOk } from './tick/m59-ground.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) {
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
  ok('cliff refused', segHeightOk(steep, 160, 160, 320, 160) === false);
  ok('wall passes (doors must)', segHeightOk(wall, 160, 160, 320, 160) === true);
  ok('clear passes', segHeightOk(clear, 160, 160, 320, 160) === true);
  ok('no trace passes (old behavior)', segHeightOk({}, 160, 160, 320, 160) === undefined);
  ok('no geometry passes', segHeightOk(null, 160, 160, 320, 160) === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
