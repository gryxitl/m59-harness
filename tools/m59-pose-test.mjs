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

// 2. Server echo is read when no sim is fresh.
{
  const p = new Pose();
  p.updateServer({ col: 10, row: 20, x: 10 * 1024 + 512, y: 20 * 1024 + 512, predicted: false });
  const c = p.current();
  ok(c.source === 'server', 'server echo read when no sim');
  ok(c.col === 10 && c.row === 20, 'server echo col/row correct');
  ok(c.predicted === false, 'server echo predicted=false preserved');
  ok(c.stale === false, 'server echo not stale');
}

// 3. A fresh sim supersedes the server echo.
{
  const p = new Pose();
  p.updateServer({ col: 10, row: 20, x: 10 * 1024 + 512, y: 20 * 1024 + 512, predicted: false });
  p.advance(11 * 1024 + 512, 21 * 1024 + 512);
  const c = p.current();
  ok(c.source === 'sim', 'fresh sim supersedes server');
  ok(c.col === 11 && c.row === 21, 'sim col/row derived from x/y');
  ok(c.predicted === true, 'sim is predicted=true');
}

// 4. A stale sim (no advance for >2s) falls back to the server echo.
{
  const p = new Pose();
  p.updateServer({ col: 10, row: 20, x: 10 * 1024 + 512, y: 20 * 1024 + 512, predicted: false });
  p.advance(11 * 1024 + 512, 21 * 1024 + 512);
  // Force the sim to be stale by backdating simAt.
  p.simAt = Date.now() - 3000;
  const c = p.current();
  ok(c.source === 'server', 'stale sim falls back to server');
  ok(c.col === 10, 'fallback col is the server col');
}

// 5. reset() clears the sim so the server echo resumes immediately.
{
  const p = new Pose();
  p.updateServer({ col: 10, row: 20, x: 10 * 1024 + 512, y: 20 * 1024 + 512, predicted: false });
  p.advance(11 * 1024 + 512, 21 * 1024 + 512);
  p.reset();
  const c = p.current();
  ok(c.source === 'server', 'reset clears sim, server resumes');
  ok(c.col === 10, 'reset col is the server col');
}

// 6. updateServer with a non-finite/absent object is ignored.
{
  const p = new Pose();
  p.updateServer({ col: 10, row: 20, x: 10 * 1024 + 512, y: 20 * 1024 + 512, predicted: false });
  p.updateServer(null);
  p.updateServer({ col: NaN, row: 20 });
  const c = p.current();
  ok(c.col === 10, 'bad updateServer does not clobber the last good echo');
}

// 7. x/y default to square-center when absent.
{
  const p = new Pose();
  p.updateServer({ col: 5, row: 6 });
  const c = p.current();
  ok(c.x === 5 * 1024 + 512, 'x defaults to square center');
  ok(c.y === 6 * 1024 + 512, 'y defaults to square center');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
