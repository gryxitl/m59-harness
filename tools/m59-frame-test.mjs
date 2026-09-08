// m59-frame-test.mjs — the two-position defect that froze the velocity engine.
//
// WHY THIS FILE EXISTS
// substrate/keeper-t3.log holds a character with policy.ownPhysics = true whose
// velocity engine was alive, sending, and completely frozen:
//
//   790 of 805 sends are the identical packet
//   [movedbg] t3 gateOK vel aim=(1472,1152) sq=(23,18) me=(23,18) idx=0/22 stuck=3 srv=(23,18)
//
// Same aim, same waypoint index, same server square, for the rest of the log.
// The engine declared the position it already occupied, over and over. That is
// the one thing the client's report law can never actuate
// (clientd3d/move.c MoveUpdatePosition: only report when you have MOVED).
//
// THE CAUSE: tick() reads position from two different places.
//
//   mover.mjs:531   const me       = posOverride ?? pose ?? c.self
//   mover.mjs:629   let myProtoX   = usePoseSim ? poseSim.x : (simFresh ? this._simX : srvX)
//
// `me` is the caller's posOverride — the router passes frame.position, which is
// Pose.current(). `myProtoX/Y` is Pose.sim, or the mover's own dead-reckoning, or
// the server echo. Nothing reconciles them, and me.col/me.row are never
// re-derived from myProtoX/myProtoY. So one tick can plan a path from one square
// and declare a position from another.
//
// The log shows exactly that, in one tick:
//
//   plan from=(23,23) dest=20,2 found=true wp=22     <- myProtoX/Y, printed as floor(proto/64)
//   gateOK vel aim=(1472,1152) ... me=(23,18)        <- me.col/me.row, the posOverride
//
// The path was built for a character at (23,23); the aim was then compared,
// clamped and declared as if the character were at (23,18).
//
// WHY THAT PRODUCED aim == me EXACTLY (fixed: navgeom now emits the centre)
// navgeom used to build waypoints at (c - 0.5)*64 + 32, which its comment called
// "center of each square". It was not the centre: the terms cancel, (c - 0.5)*64
// + 32 = 64c, so every waypoint sat on the LOW EDGE of its square, 32 protocol
// units short of the centre the rest of the repository uses (col*64 + 32 —
// m59-client.mjs:935, mover.mjs:298, pose.mjs:55, and roo.standPoint).
// floor(64c/64) == c, so the waypoint still *read* as the right square, which is
// why no assertion ever flagged it. m59-navgeom.mjs now emits c*64 + 32.
//
// Put those two facts together for a character whose posOverride says (23,18)
// while the path was built for (23,23): the first waypoint is the low-edge corner
// of the square the character is standing in. Declaring it moves the declared
// position 32 units backward in each axis, the echo square does not change, the
// next tick recomputes the same waypoint from the same square, and the loop is a
// fixed point. stuckTicks freezes at 3 because the server genuinely is not
// moving — it is being told to go to where it already is.
//
// These tests pin both halves: the arithmetic of the waypoint offset, and the
// existence of two unreconciled position reads in one tick.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { KOD_FINENESS } from './m59-roo.mjs';
import { Pose } from './tick/m59-pose.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOVER = readFileSync(join(HERE, 'tick/m59-mover.mjs'), 'utf8');
const NAVGEOM = readFileSync(join(HERE, 'm59-navgeom.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` -- ${detail}` : ''}`); }
};

const K = KOD_FINENESS;          // 64 protocol units per square
const HALF = K / 2;              // 32

// The repository's convention, stated once. A square centre is col*64 + 32 and
// the square of a protocol point is floor(proto / 64) — m59-parse.mjs:230.
const centre = col => col * K + HALF;
const squareOf = p => Math.floor(p / K);

console.log('\nHALF 1: navgeom waypoints are the square CENTRE (was: the low edge)');
{
  // The current navgeom formula, copied verbatim.
  const navgeomBack = c => c * K + K / 2;
  ok('navgeomBack(c) is now col*64 + 32, the repository centre formula',
    [1, 7, 18, 23, 40].every(c => navgeomBack(c) === centre(c)));
  ok('it is NOT the old low-edge value 64c',
    [1, 18, 23, 40].every(c => navgeomBack(c) !== c * K));
  ok('the old edge formula is gone from the code (prose may still recount it)',
    !/^\s*x: \(c - 0\.5\) \* KOD_FINENESS/m.test(NAVGEOM)
    && /x: c \* KOD_FINENESS \+ KOD_FINENESS \/ 2,/.test(NAVGEOM));
  ok('and the misleading "center of each square" comment was rewritten',
    !/waypoints \(center of each square\)/.test(NAVGEOM));

  // The authoritative point is roo.standPoint: client (c-1)*1024 + 512.
  const standPointProto = c => ((c - 1) * 1024 + 512) / 16 + K;
  ok('the waypoint equals roo.standPoint for an ordinary square',
    [1, 18, 23, 40].every(c => navgeomBack(c) === standPointProto(c)));

  // The frozen aim, straight out of the log, and what the fix yields instead.
  ok('t3 aim (1472,1152) was 64*(23,18), the old low-edge corner',
    23 * K === 1472 && 18 * K === 1152);
  ok('the same cell now yields (1504,1184), the centre',
    navgeomBack(23) === 1504 && navgeomBack(18) === 1184,
    `${navgeomBack(23)},${navgeomBack(18)}`);

  // A waypoint for the NEXT square must be a full square away and land outside.
  ok('a waypoint for the next square is a full 64 proto ahead',
    navgeomBack(24) - centre(23) === K, navgeomBack(24) - centre(23));
  ok('and lands in the next square, so the echo CAN change',
    squareOf(navgeomBack(24)) === squareOf(centre(23)) + 1);
  ok('a waypoint for our OWN square is now distance 0 from us, so it is skipped',
    Math.hypot(navgeomBack(23) - centre(23), navgeomBack(18) - centre(18)) === 0);
}

console.log('\nHALF 2: tick() reads position twice, from two sources, and never reconciles');
{
  const meLine = MOVER.match(/const me\s*=\s*posOverride[^;]*;/);
  const protoLine = MOVER.match(/let myProtoX\s*=\s*[^;]*;/);
  ok('me comes from the caller posOverride, falling back to Pose',
    !!meLine && /posOverride/.test(meLine[0]), meLine?.[0]?.slice(0, 60));
  ok('myProtoX comes from Pose.sim / the mover dead-reckoning / the echo',
    !!protoLine && /poseSim/.test(protoLine[0]) && /myProtoX0/.test(protoLine[0]),
    protoLine?.[0]?.slice(0, 70));
  ok('myProtoX0 is the server echo, not me',
    /const myProtoX0 = srvX;/.test(MOVER));

  // Nothing between those two lines re-derives me.col/me.row from myProtoX/myProtoY.
  const body = MOVER.slice(MOVER.indexOf('const me = posOverride'),
                           MOVER.indexOf('_dbg(msg)'));
  ok('me.col is never re-derived from myProtoX anywhere in tick()',
    !/me\.col\s*=/.test(body));
  ok('me.row is never re-derived from myProtoY anywhere in tick()',
    !/me\.row\s*=/.test(body));

  // So the two can disagree arbitrarily. The mover's own traces prove they did.
  ok('the plan trace prints the myProto square',
    /plan from=\(\$\{Math\.floor\(myProtoX \/ KOD_FINENESS\)\}/.test(MOVER));
  // The trace that showed the split lived in the velocity block. That engine is gone
  // (one engine now, per docs/TICK-MOVEMENT-PLAN.md), so pin the same split against
  // whichever send site exists — the defect was never the engine, it was two position
  // sources printed in one line.
  ok('the send trace prints the me square',
    /gateOK (?:vel|step)[^\n]*me=\(\$\{me\.col\},\$\{me\.row\}\)/.test(MOVER));
}

console.log('\nthe two sources disagreed in the same tick, in the real log');
{
  // EVIDENCE WINDOW: this log belongs to a LIVE fleet and keeps growing, and the
  // frame fix above changes what new sends look like. The frozen episode runs from
  // line 1623 (first `aim=(1472,1152)`) to line 7733 (last), so the window is cut
  // just past that rather than read whole — otherwise the assertions would depend
  // on when the test happens to run.
  const all = readFileSync(join(HERE, '..', 'substrate/keeper-t3.log'), 'utf8');
  const firstFrozen = all.indexOf('aim=(1472,1152)');
  const lastFrozen = all.lastIndexOf('aim=(1472,1152)');
  ok('the log contains the frozen episode at all', firstFrozen > 0 && lastFrozen > firstFrozen);
  const log = all.slice(0, lastFrozen + 2000);
  const plans = [...log.matchAll(/plan from=\((\d+),(\d+)\) dest=(\d+),(\d+) found=true wp=(\d+)/g)]
    .map(m => ({ col: +m[1], row: +m[2], dest: `${m[3]},${m[4]}`, wp: +m[5] }));
  const sends = [...log.matchAll(/gateOK vel aim=\((\d+),(\d+)\) sq=\((\d+),(\d+)\) me=\((\d+),(\d+)\) idx=(\d+)\/(\d+)/g)]
    .map(m => ({ aim: `${m[1]},${m[2]}`, sq: `${m[3]},${m[4]}`, me: `${m[5]},${m[6]}`,
                idx: +m[7], len: +m[8] }));

  ok('the log has plan traces and send traces to compare',
    plans.length > 0 && sends.length > 0, `${plans.length} plans, ${sends.length} sends`);

  // The dominant failure: one aim sent 790 times, and a second frozen at 70.
  const counts = new Map();
  for (const s of sends) counts.set(s.aim, (counts.get(s.aim) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  ok('the window has few distinct aims across many sends (a spin, not a route)',
    counts.size <= 6 && sends.length > 300, `${counts.size} aims / ${sends.length} sends`);

  const [topAim, topCount] = ranked[0];
  ok('one single aim carries the overwhelming majority of all sends',
    topCount / sends.length > 0.95, `${topAim} ${topCount}/${sends.length}`);
  ok('that aim is (1472,1152), the low-edge corner of the character square',
    topAim === '1472,1152', topAim);

  // A fixed point: the declared aim lands in the square the character is already
  // in, so the echo never changes and the same waypoint is chosen again.
  const frozen = sends.filter(s => s.aim === topAim);
  ok('every frozen send declared a point inside its own square',
    frozen.every(s => s.sq === s.me), `${[...new Set(frozen.map(s => s.sq))].join(' ')}`);
  ok('and never advanced past waypoint 0 of 22',
    frozen.every(s => s.idx === 0 && s.len === 22));
  ok('and never saw a different position — one square, the whole episode',
    new Set(frozen.map(s => s.me)).size === 1 && frozen[0].me === '23,18',
    [...new Set(frozen.map(s => s.me))].join(' '));
  ok('the episode is long enough to be a structural wedge, not a transient',
    frozen.length > 300, `${frozen.length} identical sends`);

  // The plan that built that path was for a different square.
  const samePath = plans.filter(p => p.wp === 22);
  ok('the 22-waypoint path was planned from a square other than (23,18)',
    samePath.length > 0 && samePath.every(p => `${p.col},${p.row}` !== '23,18'),
    [...new Set(samePath.map(p => `${p.col},${p.row}`))].join(' '));

  // The disagreement is in the ROW, and it is large: the plan row and the send
  // row are never equal anywhere in the frozen window.
  ok('the plan row and the send row never agree in the frozen window',
    frozen.length > 0 && samePath.every(p => p.row !== 18),
    [...new Set(samePath.map(p => p.row))].join(' '));
}

console.log('\nwhy aim == me is a fixed point, computed');
{
  // Character's posOverride: square (23,18). Path built for (23,23).
  const meProto = { x: centre(23), y: centre(18) };
  const wpOwnCell = { x: 23 * K, y: 18 * K };      // navgeomBack(23), back(18)
  const d = Math.hypot(wpOwnCell.x - meProto.x, wpOwnCell.y - meProto.y);
  ok('the waypoint for our own square is 45.3 proto away (0.71 squares)',
    Math.abs(d - 45.25) < 0.1, d.toFixed(2));
  ok('45.3 < WALK_STRIDE 160 so the stride clamp is skipped and aim == waypoint',
    d < 160);
  ok('declaring it lands in the SAME square, so the echo cannot change',
    squareOf(wpOwnCell.x) === squareOf(meProto.x)
    && squareOf(wpOwnCell.y) === squareOf(meProto.y));
  ok('and the next tick recomputes the identical waypoint from the identical square',
    squareOf(wpOwnCell.x) === 23 && squareOf(wpOwnCell.y) === 18);
}

console.log('\nthe frame fix, and the truth fix');
{
  // navgeom's cell index is the SAME index as a mover column, which this pins by
  // checking the forward conversion: navgeom.mjs:141 toKod(centre(c)) === c.
  const navgeomToKod = v => Math.max(1, Math.round((v - K / 2) / K));
  ok('toKod maps a mover centre to its own index, so the inverse is the same formula',
    [1, 18, 23, 40].every(c => navgeomToKod(centre(c)) === c));

  // Therefore the correct inverse is the repository's own centre formula.
  const fixed = c => c * K + HALF;
  ok('the fixed conversion lands on the centre, not the edge',
    fixed(23) === centre(23), `${fixed(23)} vs ${centre(23)}`);
  ok('it round-trips: fixed(toKod(p)) === p for a centre',
    fixed(navgeomToKod(centre(23))) === centre(23));
  ok('so a waypoint for the NEXT square is a full 64 ahead',
    fixed(24) - centre(23) === K, fixed(24) - centre(23));
  ok('and lands in the next square, so the echo CAN change',
    squareOf(fixed(24)) === squareOf(centre(23)) + 1);

  // The frame fix alone is not enough: with two position reads, a path built for
  // (23,23) still hands back a waypoint 5 rows from where me says we are.
  ok('the frame fix alone still mis-aims when the plan square is wrong',
    squareOf(fixed(23)) === 23 && Math.abs(fixed(23) - centre(23)) === 0
    && squareOf(fixed(18)) === 18);
}

console.log('\nROOT CAUSE: Pose.advance seeded the sim from the AIM, not from feet');
{
  // The frame fix and the two-position read are both real, but neither explains
  // how the mover came to plan a path for a square it had never occupied. This
  // does. Pose.advance(x, y) is called by _recordReport with the DECLARED aim,
  // which is a stride target up to 320 proto (5 squares) away. When the sim was
  // null — which mover.tick() causes on every room change (mover.mjs:509) — the
  // old code jumped the sim straight to the aim, so Pose.current() reported an
  // aim as a position.
  //
  // The guard could not see it: the largest possible bad seed is exactly one
  // stride (RUN_STRIDE_PROTO = 320), and the divergence threshold is 384, so the
  // guard was structurally blind to its own cause.
  const RUN_STRIDE = 320, THRESHOLD = 384;
  ok('a bad seed is bounded by one stride, which is under the guard threshold',
    RUN_STRIDE < THRESHOLD, `${RUN_STRIDE} vs ${THRESHOLD}`);
  ok('so the guard could never catch a bad seed, by construction',
    RUN_STRIDE <= THRESHOLD);

  // Reproduce the t3 sequence against the real Pose, and assert it is fixed.
  const p = new Pose();
  p.updateServer({ col: 23, row: 18, x: 23 * K + HALF, y: 18 * K + HALF });
  p.reset();                      // a room change wipes the sim
  p.advance(1472, 1472);          // one send, declaring a run aim 320 away
  const c = p.current();
  // WHAT THIS BLOCK ACTUALLY PROVES, restated because the assertions had drifted into demanding a
  // particular position rather than the property that matters. The BUG was that a send seeded the
  // sim at the AIM with no confirmation behind it, so Pose.current() reported a stride target as a
  // position and the divergence guard could not see it (worst bad seed 320 < threshold 384).
  //
  // The fix is the ANCHOR: the seed is taken from the last server echo, so the track is never more
  // than one send's worth from something the server confirmed. It is NOT a one-square clamp. An
  // earlier version of this test asserted the clamp — `c.row === 19`, divergence exactly 64 — which
  // conflated the anchor with a speed limit on the track, and it was unbreakable because it was
  // written ok('message', cond) into a suite whose signature is ok(cond, msg).
  //
  // The clamp is gone, deliberately: the server adopts a declared position (measured from the echo:
  // a 320-unit declaration produced moved=320 landing on the declared point), so after a send our
  // feet ARE at the declaration. Keeping the crawl capped the stride engine at the step engine's
  // rate — 0.89 squares per packet — in exactly the situation the freeze was watched in, right after
  // a room change.
  // THE OBSERVABLE DIFFERENCE IS THE STARTING POINT OF THE ADVANCE, NOT ITS ENDPOINT. Both the
  // anchored seed and the buggy one finish at the declared square, so asserting where the track ends
  // up cannot distinguish them — an early rewrite of these two assertions did exactly that and
  // passed with the original bug put back, which is how I know. What does distinguish them is that
  // the anchor is the echo's own position, so the divergence between the seeded track and the
  // declaration is the echo-to-declaration distance (289.77 units here), whereas the buggy seed sets
  // the track TO the declaration and the divergence is therefore exactly 0.
  //
  // That zero is the whole point of the original finding: the divergence guard's threshold is 384 and
  // the largest possible bad seed is one stride, 320, so a track fabricated from a declaration looks
  // perfectly healthy to the one mechanism meant to catch it.
  // THE ANCHOR IS NO LONGER OBSERVABLE THROUGH advance(), and that is worth stating rather than
  // working around: since the seed goes to the declaration, any read after a send shows the
  // declaration. My first rewrite tried to measure it with advance(x, y, 1) — a one-unit step — and
  // read 0, because the step size is a floor and not a ceiling. So the anchor is tested through
  // Pose.seedAnchor(), the accessor that exists for exactly this purpose, and through the divergence
  // the anchored track actually reports afterwards.
  const q = new Pose();
  q.updateServer({ col: 23, row: 18, x: 23 * K + HALF, y: 18 * K + HALF });
  q.reset();
  const anchor = q.seedAnchor();
  ok('the seed anchor is the echo, not the declaration',
    anchor.x === 23 * K + HALF && anchor.y === 18 * K + HALF,
    `${anchor.x},${anchor.y} (echo 1504,1184; declaration 1472,1472)`);
  ok('and there is no anchor when no echo has arrived',
    (function () { const r = new Pose(); r.reset(); return r.seedAnchor() === null; })());
  ok('an anchored track reports a non-zero divergence, which is what makes the guard usable at all',
    p.divergence() > 0, `divergence ${p.divergence()}`);
  // NONE OF THE THREE ASSERTIONS ABOVE IS FALSIFIABLE THROUGH advance(), and that is a fact about
  // the code rather than about the test. Deleting the anchor entirely leaves all ten suites green —
  // verified by mutation, not by reasoning. With the advance going to the declaration, an anchored
  // track reads divergence 289.8 and an unanchored one reads 0.0, and both are under the 384
  // threshold, so no guard fires and nothing downstream can tell the two apart.
  //
  // My first attempt at an assertion here called seedAnchor() directly while I mutated advance(),
  // which tested the accessor and not the code that uses it — the same class of error as the bug it
  // was meant to catch, reproduced while writing its test. It is kept because seedAnchor() is now
  // what advance() actually calls, so it pins the accessor's contract; it must not be read as
  // protection.
  ok('the protection the anchor was written to provide does not exist yet',
    p.divergence() < 384,
    'a seeded track and a fabricated track are indistinguishable to the divergence guard. What is ' +
    'needed is a corroboration check: declare, then require the echo to arrive near the declaration ' +
    'within a few sends. That is not a distance test, and it is not implemented.');

  // The bug's signature: plan square (23,23) while the echo held (23,18).
  ok('the buggy square (23,23) is exactly 5 rows off the echo',
    (23 - 18) * K === 320 && 320 === RUN_STRIDE);
  // 'what the fix removes' is the UNCONFIRMED five-row jump, not the five-row distance: with the
  // anchor on the echo and the advance going to the declaration, the track may legitimately sit at
  // the declared square, because the server has been measured to put us there.
  ok('the track is either on the echo or on a position we actually declared',
    Math.abs(Math.floor(p.sim.y / K) - 18) <= 5, Math.floor(p.sim.y / K));
}

console.log('\nthe consumers of these waypoints agree on the frame');
{
  // Two HTTP mappings convert waypoint protocol coords for display. Before the fix
  // they carried OPPOSITE compensation offsets (+1 and -1) for the same numbers, so
  // the two diagnostics disagreed by two squares about one waypoint.
  const KP = readFileSync(join(HERE, 'm59-keeper-process.mjs'), 'utf8');
  const maps = [...KP.matchAll(/x: Math\.round\(\(w\.x - H\) \/ F\) ([+-] 1)?,/g)]
    .map(m => (m[1] ?? '0').replace(/\s+/g, ''));
  ok('the /path3d waypoint mappings both use the -1 viewer offset',
    maps.length >= 2 && maps.every(v => v === '-1'), maps.join(' '));
  ok('no waypoint mapping still adds +1 for the old edge frame',
    !/\(w\.x - H\) \/ F\) \+ 1/.test(KP));

  // The viewer is 0-based (m59-room3d.mjs:26,32,38 draw col-1), so a centre
  // waypoint must map to col-1 and the /findpath diagnostic must report col.
  const F = 64, H = 32;
  const viewerX = c => Math.round((c * F + H - H) / F) - 1;
  const findpathCol = c => Math.round((c * F + H - H) / F);
  ok('a centre waypoint maps to the viewer 0-based x',
    [22, 23, 24].every(c => viewerX(c) === c - 1));
  ok('and /findpath reports the true column',
    [22, 23, 24].every(c => findpathCol(c) === c));
  ok('the two diagnostics now agree, one square apart as they should',
    [22, 23, 24].every(c => findpathCol(c) - viewerX(c) === 1));
}

console.log('\nthe protocol bridge is NOT the problem (ruled out)');
{
  ok('the server echo square is floor(proto / 64) — m59-parse.mjs:230',
    /col: \(x \/ KOD_FINENESS\) \| 0/.test(readFileSync(join(HERE, 'm59-parse.mjs'), 'utf8')));
  ok('moveToSquare sends col*64 + half — m59-client.mjs:935',
    /col \* KOD_FINENESS \+ half/.test(readFileSync(join(HERE, 'm59-client.mjs'), 'utf8')));
  ok('a 160-proto stride clears the 16-proto report threshold, so the gate was never it',
    160 > K / 4);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
