#!/usr/bin/env node
// m59-pose-test.mjs -- unit tests for the single position truth (Pose).
// Offline, no network. Run: node tools/m59-pose-test.mjs

import { Pose } from './tick/m59-pose.mjs';

let pass = 0, fail = 0;
function ok(cond, msg, detail) {
  // ARGUMENT-ORDER GUARD. This suite's signature is ok(cond, msg). Seven other suites in tools/
  // use the OPPOSITE order, ok(what, cond, detail). Writing a call in the other suite's style
  // raises nothing and fails nothing: the condition parameter receives the message string, a
  // non-empty string is truthy, and the assertion is counted as a pass. That is not a hypothetical
  // — 17 assertions in this file and 11 in m59-ground-test.mjs were written that way and reported
  // 'passed' through a full day of edits to the code underneath them, including through the change
  // that made the seeded track crawl one square per send instead of going to the declaration.
  // A vacuous assertion is worse than a missing one precisely because it is counted.
  if (typeof cond === 'string') {
    fail++;
    console.log(`  FAIL ok() got a string as its CONDITION — argument order is inverted, so this ` +
                `assertion cannot fail: ${cond.slice(0, 70)}`);
    return;
  }
  if (cond) { pass++; console.log(`  ok   ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}${detail ? ' — ' + detail : ''}`); }
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
  // THE ANCHOR IS THE ECHO; THE ADVANCE GOES TO THE DECLARATION. Two decisions this block used to
  // conflate into one demand for a one-square crawl.
  //
  //  * Anchoring on the echo is the fix from e70dd99 and stands: seeding from the AIM left the
  //    track up to a full stride (320) from anything the server had confirmed, which is under the
  //    divergence guard's 384 threshold, so the guard could never catch its own cause.
  //  * Advancing to the declaration is what the server does with a send. Measured in game, not
  //    assumed: the echo shows a 320-unit declaration adopted to the unit
  //    (`x=800,2528 -> x=722,2838 moved=320`), and Pose.noteGround accumulates ground from exactly
  //    those echoes. A track that crawls one square per send while the character is already at the
  //    declared position plans every later route from behind its own feet — which is how the stride
  //    engine measured 0.89 squares per packet, the step engine's own rate, with the engine correct
  //    and the suite green.
  //
  // The three assertions this replaces demanded (23,19) and divergence 64 — the crawl — and were
  // written ok('message', condition) into a suite whose signature is ok(condition, message). The
  // condition parameter received a message string, was always truthy, and they were counted as
  // passes for a day, including across the edit that introduced the crawl.
  // What is decidable here is not 'which value was seeded' — after a send the track is at the
  // declaration either way, and the old assertion ignored the send it had just performed. What the
  // e70dd99 fix actually guarantees is that the seed is BOUNDED by the echo: seeding from the aim
  // could put the track a whole stride from any confirmation, seeding from the echo cannot put it
  // further than one send's worth. That is testable, and it is what keeps the divergence guard able
  // to see a bad seed.
  ok(c.col === 23 && c.row === 23, 'a send moves the seeded track to the declaration',
     `${c.col},${c.row}`);
  ok(p.divergence() <= 384,
     'and the seed is anchored close enough to the echo that the divergence guard can still see it',
     `divergence ${p.divergence()} vs threshold 384`);
  p.reset();
  p.updateServer({ col: 23, row: 18, x: 23 * 64 + 32, y: 18 * 64 + 32 });
  p.reset();
  p.advance(1472, 1472);
  const seeded = p.current();
  ok(seeded.col === 23 && seeded.row === 23,
     'after anchoring on the echo, a send takes the track to the position we declared',
     `${seeded.col},${seeded.row} (declared 23,23; the crawl gave 23,19)`);
  ok(p.divergence() <= 384, 'and the seeded track stays inside the divergence guard',
     p.divergence());
}

// 13. With no echo at all (a fresh join, before the first BP_MOVE) the aim is the
// only information there is, so seeding still has to land somewhere.
{
  const p = new Pose();
  p.advance(1472, 1472);
  ok(p.sim != null && p.sim.x === 1472 && p.sim.y === 1472, 'no echo: seeding falls back to the aim rather than staying null', JSON.stringify(p.sim));
  ok(p.current().predicted === true, 'and current() reports it as predicted');
}

// 14. The invariant the frozen mover violated: the square current() reports must
// be the square of the proto point the mover plans from, in the same call.
{
  const p = new Pose();
  p.updateServer({ col: 23, row: 18, x: 23 * 64 + 32, y: 18 * 64 + 32 });
  p.reset();
  p.advance(1472, 1472);
  const c = p.current();
  ok(c.col === Math.floor(p.sim.x / 64), 'current().col is floor(sim.x / 64)');
  ok(c.row === Math.floor(p.sim.y / 64), 'current().row is floor(sim.y / 64)');
  ok(c.x === p.sim.x && c.y === p.sim.y, 'so a caller cannot see a position the sim does not have');
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
  ok(c1.source === 'echo' && c1.col === 3 && c1.row === 2, 'with an echo it reports the echo', `${c1.source} ${c1.col},${c1.row}`);

  // The whole point: the sim advances on every SEND, so a commitment read must ignore it.
  p.advance(544, 160, 64);
  const cur = p.current();
  const c2 = Pose.confirmed(session);
  ok(cur.source === 'sim', 'current() follows the sim after a send', cur.source);
  ok(c2.source === 'echo' && c2.col === 3 && c2.row === 2, 'confirmed() ignores the sim and still reports the echo', `${c2.source} ${c2.col},${c2.row}`);
  ok(!(cur.col === c2.col && cur.row === c2.row), 'so a send cannot be mistaken for the server having moved us', `current=${cur.col},${cur.row} confirmed=${c2.col},${c2.row}`);
}
{
  // A session with no Pose wired at all: client.self is the designated last resort, and
  // it is a real server source — BP_MOVE writes the room object, moveTo never does.
  const session = { client: { self: { col: 7, row: 4, x: 7 * 64 + 32, y: 4 * 64 + 32 } } };
  const c = Pose.confirmed(session);
  ok(c.source === 'client' && c.col === 7, 'falls back to client.self when there is no Pose', `${c.source} ${c.col},${c.row}`);
  ok(c.x === 7 * 64 + 32 && c.y === 4 * 64 + 32, 'derives x/y in protocol units when the object carries only squares', `${c.x},${c.y}`);
}
{
  const none = Pose.confirmed({});
  ok(none.source === 'none' && none.col === null, 'reports none rather than inventing a position', none.source);
  ok(Object.keys(none).join(',') === 'col,row,x,y,source', 'and a caller can test one field instead of three Number.isFinite guards', Object.keys(none).join(','));
  ok(Pose.confirmed(undefined).source === 'none' && Pose.confirmed(null).source === 'none', 'Pose.confirmed survives a missing session entirely');
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

// ---------------------------------------------------------------- ground accumulator
// The accumulator exists because every rate read out of the keeper log was an artefact of where
// the position was sampled. It is only trustworthy if it counts what it claims, so:
{
  let clock = 1_000_000;
  const real = Date.now;
  // Drive the clock through the module's own Date.now by monkeypatching the global.
  Date.now = () => clock;
  const p = new Pose();
  p.updateServer({ col: 10, row: 10, x: 10 * 64 + 32, y: 10 * 64 + 32 });
  clock += 1000;
  p.updateServer({ col: 10, row: 11, x: 10 * 64 + 32, y: 11 * 64 + 32 });   // 1 square in 1 s
  clock += 1000;
  p.updateServer({ col: 10, row: 12, x: 10 * 64 + 32, y: 12 * 64 + 32 });   // 1 square in 1 s
  let r = p.groundRate();
  ok(Math.abs(r.squares - 2) < 0.02, `ground accumulates the two squares, got ${r.squares}`);
  ok(Math.abs(r.seconds - 2) < 0.02, `the denominator is echo-to-echo time, got ${r.seconds}`);
  ok(Math.abs(r.rate - 1) < 0.05, `1 square per second, got ${r.rate}`);
  ok(r.transitions === 0, 'no transitions counted on ordinary steps');

  // A room transition must NOT be ground: the echo's x/y are room-local, so a new room is a new
  // origin. The live log showed 51.97 squares in 0.30 s, which is 170 squares/second of nothing.
  clock += 1000;
  p.updateServer({ col: 40, row: 3, x: 40 * 64 + 32, y: 3 * 64 + 32 });
  r = p.groundRate();
  ok(r.transitions === 1, `a 12+ square jump counts as a transition, got ${r.transitions}`);
  ok(Math.abs(r.squares - 2) < 0.02, `a transition adds NO ground, got ${r.squares}`);
  // The transition's second IS counted. It was real time in which the character covered no
  // ground, and an accumulator that dropped it would report a rate over a shorter window than
  // the one it measured — inflated rather than conservative, which is the failure mode this
  // file exists to avoid.
  ok(Math.abs(r.seconds - 3) < 0.02, `a transition contributes its time but no distance, got ${r.seconds}`);

  // STANDING TIME IS COUNTED, AND THAT IS THE POINT. An earlier version of this test asserted
  // the opposite — that a standstill contributed nothing, making the figure a rate 'while
  // moving'. That is indefensible: the fleet's speed is what a player experiences, and a player
  // who is sitting down is slow. It is also the exact confusion that made this repository's
  // numbers look irreproducible, because a window containing a vigor rest and a window that
  // happens not to contain one are not the same measurement and neither is wrong.
  //
  // The honest decomposition is cadence x ground-per-packet, both measured over the whole window,
  // with standing showing up as a low packet rate and resting showing up there too. So:
  clock += 60_000;
  p.updateServer({ col: 40, row: 4, x: 40 * 64 + 32, y: 4 * 64 + 32 });
  r = p.groundRate();
  ok(Math.abs(r.squares - 3) < 0.02, `third square counted, got ${r.squares}`);
  ok(Math.abs(r.seconds - 63) < 0.02,
     `a 60 s standstill IS counted, so the rate is the character's real speed: 3 squares in 63 s, got ${r.seconds}`);
  ok(r.rate < 0.05, `and the rate collapses to ${r.rate?.toFixed(2)} sq/s, which is the truth`);

  // An echo that repeats our position is not movement, but it is time.
  // An echo that repeats our position is not movement and must not age the clock.
  clock += 5000;
  p.updateServer({ col: 40, row: 4, x: 40 * 64 + 32, y: 4 * 64 + 32 });
  r = p.groundRate();
  // 68 s = 1 + 1 (two one-square steps) + 1 (the transition's second) + 60 (the standstill)
  // + 5 (this repeated echo). 3 squares of ground. I wrote 128 here first and the code said 68;
  // the code was right and my arithmetic was wrong, which is the whole argument for running the
  // assertion instead of reasoning about it.
  ok(Math.abs(r.seconds - 68) < 0.02 && Math.abs(r.squares - 3) < 0.02,
     `a repeated echo adds time and no distance: 3 sq in 68 s, got ${r.squares} sq in ${r.seconds} s`);
  ok(Math.abs(r.rate - 3 / 68) < 0.001,
     `and the rate is the honest 0.04 sq/s over a window that includes a minute of standing, got ${r.rate?.toFixed(3)}`);
  Date.now = real;
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);