#!/usr/bin/env node
// m59-pose-test.mjs -- unit tests for the single position truth (Pose).
// Offline, no network. Run: node tools/m59-pose-test.mjs

import { Pose } from './tick/m59-pose.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ok   ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
}

// 1. Fresh Pose with no data is stale.
{
  const p = new Pose();
  const c = p.current();
  ok(c.stale === true, 'empty pose is stale');
  ok(c.source === 'none', 'empty pose source is none');
  ok(c.col == null, 'empty pose has no col');
}

// 2. Server echo is read when there is no sim.
{
  const p = new Pose();
  p.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32, predicted: false });
  const c = p.current();
  ok(c.source === 'server', 'server echo read when no sim');
  ok(c.col === 10 && c.row === 20, 'server echo col/row correct');
  ok(c.predicted === false, 'server echo predicted=false preserved');
  ok(c.stale === false, 'server echo not stale');
}

// 3. The sim supersedes the server echo (units are KOD protocol units).
{
  const p = new Pose();
  p.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32, predicted: false });
  p.advance(11 * 64 + 32, 21 * 64 + 32);
  const c = p.current();
  ok(c.source === 'sim', 'sim supersedes server');
  ok(c.col === 11 && c.row === 21, 'sim col/row derived from x/y in KOD units');
  ok(c.predicted === true, 'sim is predicted=true');
}

// 4. The sim NEVER expires: an old advance is still our best track (echoes
// confirm it; only reset() clears it). No more 2s fallback to stale echoes.
{
  const p = new Pose();
  p.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32, predicted: false });
  p.advance(11 * 64 + 32, 21 * 64 + 32);
  // Age the sim far past the old freshness window.
  p.simAt = Date.now() - 30000;
  const c = p.current();
  ok(c.source === 'sim', 'aged sim still reported (track entirely)');
  ok(c.col === 11 && c.row === 21, 'aged sim position intact');
}

// 5. reset() clears the sim so the server echo resumes immediately.
{
  const p = new Pose();
  p.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32, predicted: false });
  p.advance(11 * 64 + 32, 21 * 64 + 32);
  p.reset();
  const c = p.current();
  ok(c.source === 'server', 'reset clears sim, server resumes');
  ok(c.col === 10, 'reset col is the server col');
}

// 6. updateServer with a non-finite/absent object is ignored.
{
  const p = new Pose();
  p.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32, predicted: false });
  p.updateServer(null);
  p.updateServer({ col: NaN, row: 20 });
  const c = p.current();
  ok(c.col === 10, 'bad updateServer does not clobber the last good echo');
}

// 7. x/y default to square-center when absent (KOD units).
{
  const p = new Pose();
  p.updateServer({ col: 5, row: 6 });
  const c = p.current();
  ok(c.x === 5 * 64 + 32, 'x defaults to square center');
  ok(c.y === 6 * 64 + 32, 'y defaults to square center');
}

// 8. divergence() measures track-vs-echo disagreement (null when either side missing).
{
  const p = new Pose();
  ok(p.divergence() === null, 'no data means null divergence');
  p.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32 });
  ok(p.divergence() === null, 'no sim means null divergence');
  p.advance(10 * 64 + 32, 20 * 64 + 32);
  ok(p.divergence() === 0, 'agreed track reads zero');
  p.advance(14 * 64 + 32, 20 * 64 + 32);
  ok(p.divergence() === 256, 'split track reads the gap in proto units');
}

// 9. divergence guard: a sim 6+ squares off the echo is adopted (reset) and counted.
{
  const p = new Pose();
  p.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32 });
  p.advance(10 * 64 + 32, 20 * 64 + 32);
  // Drift the sim 8 squares (512 proto units) off the echo — beyond the guard.
  p.advance(18 * 64 + 32, 20 * 64 + 32);
  ok(p.divergence() === 512, 'drifted sim reads the gap before the guard');
  p.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32 });
  ok(p.divergenceResets === 1, 'drifted sim is adopted (counted)');
  ok(p.sim.x === 10 * 64 + 32, 'adopted sim is the echo');
  ok(p.divergence() === 0, 'adopted sim agrees with the echo');
  // A small gap (one stride, 320) is echo lag, not drift — not adopted.
  p.advance(15 * 64 + 32, 20 * 64 + 32);
  ok(p.divergence() === 320, 'one-stride gap reads the gap');
  p.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32 });
  ok(p.divergenceResets === 1, 'one-stride gap is not adopted (echo lag)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
