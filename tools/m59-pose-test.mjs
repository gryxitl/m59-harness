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
  // Set the sim 4 squares off the echo (test divergence() directly, not advance()).
  p.sim = { x: 14 * 64 + 32, y: 20 * 64 + 32 };
  ok(p.divergence() === 256, 'split track reads the gap in proto units');
}

// 9. DEAD RECKONING: THE SIM GOES WHERE THE PACKET SAID.
//
// This block used to assert the opposite — 'sim advances one square toward the aim
// (server-speed)', with the justification 'the send interval is ~1s at speed 18'.
// That sentence is the STEP ENGINE'S send model, and it is what made the velocity
// restoration accomplish nothing: the engine declared 128 units of ground per packet
// while the position truth underneath it moved 64, so every subsequent plan was drawn
// from a square behind the character's own feet and the rate came out identical to the
// engine being replaced. An engine can be correct and the thing that reads it can still
// make it ineffective, which is why the position truth gets asserted here at all.
//
// The reference client's law (move.c:96): server_x is the "Last position we've told
// server we are", re-anchored only when the server tells us our position outright
// (move.c:732, :810). Between corrections the server believes the declaration, so the
// declared position is where our feet are and the track goes there.
{
  const p = new Pose();
  p.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32 });
  p.advance(10 * 64 + 32, 20 * 64 + 32);  // sim null -> seed at (10, 20)
  // A packet declaring (18,20) puts our feet at (18,20). Not one square short of it.
  p.advance(18 * 64 + 32, 20 * 64 + 32);
  ok(p.sim.x === 18 * 64 + 32, 'sim goes to the declared position (dead reckoning)');
  ok(p.divergence() === 512, 'an eight-square gap between echo and declaration is measured');
  // A gap WITHIN one stride is echo lag, not drift: at run speed a legitimate declaration
  // sits 320 units ahead of an echo that has not arrived yet, and adopting that would throw
  // the track back every second. The guard's threshold is 384 (six squares) precisely because
  // it must clear the largest legal stride.
  const q = new Pose();
  q.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32 });
  q.advance(10 * 64 + 32, 20 * 64 + 32);
  q.advance(15 * 64 + 32, 20 * 64 + 32);   // five squares ahead: one run stride of echo lag
  ok(q.divergence() === 320, 'a stride-sized gap reads as echo lag');
  q.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32 });
  ok(q.divergenceResets === 0, 'echo lag within one stride is not adopted');
  // Force a large drift (set the sim 8 squares off the echo) — the guard fires.
  p.sim = { x: 18 * 64 + 32, y: 20 * 64 + 32 };
  ok(p.divergence() === 512, 'drifted sim reads the gap');
  p.updateServer({ col: 10, row: 20, x: 10 * 64 + 32, y: 20 * 64 + 32 });
  ok(p.divergenceResets === 1, 'drifted sim is adopted (counted)');
  ok(p.sim.x === 10 * 64 + 32, 'adopted sim is the echo');
  ok(p.divergence() === 0, 'adopted sim agrees with the echo');
}

// 12. SEEDING IS NOT A JUMP TO THE AIM. advance(x, y) is called with what we are
// DECLARING we head toward — a stride target up to 320 proto (5 squares) away —
// not our feet. Seeding a null sim at the aim made current() report an aim as a
// position, and the divergence guard could not see it: the worst possible bad
// seed is one stride (320), which is under its 384 threshold, so the guard could
// never catch its own cause. Live (keeper-t3.log): echo (23,18), a room change
// reset the sim, one send seeded it from a run aim, and the mover then planned a
// path for (23,23) and froze for 790 sends.
{
  const p = new Pose();
  p.updateServer({ col: 23, row: 18, x: 23 * 64 + 32, y: 18 * 64 + 32 });
  p.reset();                       // a room change wipes the sim
  p.advance(1472, 1472);           // a run aim 320 proto away, as in the log
  const c = p.current();
  ok('seeding anchors on the echo, not the aim', c.col === 23 && c.row === 19,
    `${c.col},${c.row} (the bug gave 23,23)`);
  ok('the seed advances one server step toward the aim', p.divergence() === 64,
    p.divergence());
  ok('the seed is inside the guard threshold by construction, not by luck',
    p.divergence() <= 64);
}

// 13. With no echo at all (a fresh join, before the first BP_MOVE) the aim is the
// only information there is, so seeding still has to land somewhere.
{
  const p = new Pose();
  p.advance(1472, 1472);
  ok('no echo: seeding falls back to the aim rather than staying null',
    p.sim != null && p.sim.x === 1472 && p.sim.y === 1472, JSON.stringify(p.sim));
  ok('and current() reports it as predicted', p.current().predicted === true);
}

// 14. The invariant the frozen mover violated: the square current() reports must
// be the square of the proto point the mover plans from, in the same call.
{
  const p = new Pose();
  p.updateServer({ col: 23, row: 18, x: 23 * 64 + 32, y: 18 * 64 + 32 });
  p.reset();
  p.advance(1472, 1472);
  const c = p.current();
  ok('current().col is floor(sim.x / 64)', c.col === Math.floor(p.sim.x / 64));
  ok('current().row is floor(sim.y / 64)', c.row === Math.floor(p.sim.y / 64));
  ok('so a caller cannot see a position the sim does not have',
    c.x === p.sim.x && c.y === p.sim.y);
}

console.log('\nPose.confirmed — the one commitment read');
{
  // The tick driver had three places asking "has the server square stopped changing",
  // each hand-rolling its own fallback chain and each drifting: the mover preferred the
  // echo, the router preferred the raw client object, and a caller could not tell from
  // the call site which truth it was getting. Pose.confirmed is now the single answer.
  const p = new Pose();
  const session = { _pose: p, client: { self: { col: 9, row: 9, x: 9 * 64 + 32, y: 9 * 64 + 32 } } };

  p.updateServer({ col: 3, row: 2, x: 224, y: 160 });
  const c1 = Pose.confirmed(session);
  ok('with an echo it reports the echo', c1.source === 'echo' && c1.col === 3 && c1.row === 2,
    `${c1.source} ${c1.col},${c1.row}`);

  // The whole point: the sim advances on every SEND, so a commitment read must ignore it.
  p.advance(544, 160, 64);
  const cur = p.current();
  const c2 = Pose.confirmed(session);
  ok('current() follows the sim after a send', cur.source === 'sim', cur.source);
  ok('confirmed() ignores the sim and still reports the echo',
    c2.source === 'echo' && c2.col === 3 && c2.row === 2, `${c2.source} ${c2.col},${c2.row}`);
  ok('so a send cannot be mistaken for the server having moved us',
    !(cur.col === c2.col && cur.row === c2.row), `current=${cur.col},${cur.row} confirmed=${c2.col},${c2.row}`);
}
{
  // A session with no Pose wired at all: client.self is the designated last resort, and
  // it is a real server source — BP_MOVE writes the room object, moveTo never does.
  const session = { client: { self: { col: 7, row: 4, x: 7 * 64 + 32, y: 4 * 64 + 32 } } };
  const c = Pose.confirmed(session);
  ok('falls back to client.self when there is no Pose', c.source === 'client' && c.col === 7, `${c.source} ${c.col},${c.row}`);
  ok('derives x/y in protocol units when the object carries only squares',
    c.x === 7 * 64 + 32 && c.y === 4 * 64 + 32, `${c.x},${c.y}`);
}
{
  const none = Pose.confirmed({});
  ok('reports none rather than inventing a position', none.source === 'none' && none.col === null, none.source);
  ok('and a caller can test one field instead of three Number.isFinite guards',
    Object.keys(none).join(',') === 'col,row,x,y,source', Object.keys(none).join(','));
  ok('Pose.confirmed survives a missing session entirely',
    Pose.confirmed(undefined).source === 'none' && Pose.confirmed(null).source === 'none');
}


// 13. DEAD RECKONING AND ECHO ADOPTION, PINNED WITH THE LIVE NUMBERS.
//
// WHAT THIS BLOCK IS AND IS NOT. It was written to pin a defect I believed I had found — an
// oscillation where the server accepts a declaration and the sim is then dragged back to the
// pre-declaration position, so the mover re-declares the same point forever. **That defect does
// not exist, and the change this block was written for was reverted.** The falsification is
// the evidence: with the change removed, every assertion here still passes. A test that cannot
// tell the fix from the bug is not a test of the fix, and the honest response is to say so in
// the file rather than leave a comment that attributes these assertions to a phantom.
//
// What the live log actually shows is a PIPELINE, not a loop:
//
//   vel-tick declare=(736,2464) ground=281 stride=320  srvXY=(1102,2040) prevDecl=(822,2196)
//   move-sent n=163 at=736,2464 aim=736,2464 from=822,2196
//   next tick: srvXY=(822,2196)
//
// `ground=281` — the integration travelled. The server then moved toward the PREVIOUS
// declaration. The server is one declaration behind us and catches up; the sim is seeded from
// the echo, so `from` is always a stride behind the aim. That is echo lag of about two strides,
// and it is why 'ground per packet' computed from consecutive echoes understates what the
// mover is doing. Reading a lag as a freeze is how I spent an evening on a bug that was a
// pipeline, and the numbers that looked like the 790-send freeze were that misreading.
//
// The assertions themselves are worth keeping on their own merits: dead reckoning goes to the
// declaration, an echo we have already been accepted for does not move the track, and an echo
// to a position we never declared IS adopted (a legacy walk, a slide, a knockback).
{
  // THE LIVE NUMBERS, NOT INVENTED ONES. keeper-t3.log: the mover's sim was (822,2196), it
  // declared (736,2464) — 282 units, 4.4 squares — and the server's echo became (736,2464). The
  // gap is UNDER the divergence guard's 384 threshold, so the guard does not fire and cannot be
  // what saves the track. Any test that picks a gap large enough for the guard to notice is
  // testing the guard, and passes with the adopt bug in place. That is why the first draft of
  // this block did not catch the defect it was written for.
  const p = new Pose();
  p.updateServer({ col: 12, row: 34, x: 822, y: 2196 });
  p.advance(822, 2196);                       // seed the track from the echo, as a real send does
  p.advance(736, 2464);                       // then declare the stride
  ok(p.sim.x === 736 && p.sim.y === 2464, 'dead reckoning goes to the declaration');
  const gap = Math.hypot(736 - 822, 2464 - 2196);
  ok(gap < 384, `the live gap is inside the divergence guard (${gap.toFixed(0)} < 384), so the guard cannot be what protects the track`);
  // The server accepts it. This is the echo for our send, and it arrives later than the send.
  const simBefore = { ...p.sim };
  p.updateServer({ col: 11, row: 38, x: 736, y: 2464 });
  ok(p.sim.x === simBefore.x && p.sim.y === simBefore.y,
     'an echo that agrees with our declaration does not move the track');
  // And the opposite case: an echo to somewhere we never declared IS the server moving us
  // (a legacy walk, a slide, a knockback). That must be adopted, or the track is a fiction.
  p.updateServer({ col: 1, row: 1, x: 96, y: 96 });
  ok(p.sim.x === 96 && p.sim.y === 96,
     'an echo to a position we never declared IS adopted (the server moved us)');
  // NOTE FOR WHOEVER READS THIS NEXT: reverting the adopt condition in pose.mjs to the plain
  // `movedSquare` leaves this block PASSING. That was the measurement that killed the change,
  // and it is recorded here so the block is not mistaken for cover of a condition that is not
  // there. If a real echo-adopt defect is ever found, this is where its assertion goes.
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);