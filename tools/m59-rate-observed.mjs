#!/usr/bin/env node
// m59-rate-observed.mjs -- the mover's rate, read from a keeper log rather than from a rig.
//
// WHY THIS IS A SEPARATE PROGRAM FROM m59-rate-measure.mjs. That file drives two mover classes
// over one geometry and came out equal for both, because the geometry hands each engine one
// waypoint per square and so caps the ground available per packet at one square regardless of
// what the engine would declare. A rig that cannot distinguish the things it is comparing has
// measured the rig. The number that means something is what the mover actually put on the wire
// while playing the game, and that is already in the log as `[move-sent]` — emitted from
// _recordSend, the one place every send must pass through.
//
// Usage: node tools/m59-rate-observed.mjs [substrate/keeper-t3.log]
//
// THE OUTLIER RULE, and why it is not a nicety. A room transition produces a send whose `from`
// is in the old room's coordinates and whose `aim` is in the new one. The distance between them
// is meaningless — measured at 5,525 units, roughly 86 squares — and a median over a few hundred
// sends is dragged by them. The first version of this file reported 2.24 squares per packet
// including those; excluding sends over 600 units gives 2.00. Both are printed. Which one to
// quote depends on whether you are asking 'how much ground does a packet buy' or 'how much does
// the fleet appear to progress', and picking the flattering one without saying so is the error
// this file exists to avoid.
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'substrate/keeper-t3.log';
const KOD = 64;
const CLIENT_SQUARES_PER_PACKET = 2.5;   // MOVEUNITS per MOVE_DELAY, reported per MOVE_INTERVAL
const TRANSITION_CUTOFF = 600;           // units; above this it is a room change, not a stride

let txt;
try { txt = readFileSync(file, 'utf8'); }
catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(1); }

// THE CURRENT SESSION ONLY. A keeper log spans every restart it has survived, and the mover's
// send counter restarts at 1 with each one. Measuring across sessions mixes code versions — which
// is precisely how a rate figure came to be quoted against a baseline produced by different
// software, and how '634 packets' was reported for a session that had sent 40.
const _starts = [...txt.matchAll(/\[keeper\] \S+ starting on port/g)];
if (_starts.length > 1) {
  const before = txt.length;
  txt = txt.slice(_starts[_starts.length - 1].index);
  console.log(`(window: the current session only — ${_starts.length} sessions in the file, ${before - txt.length} bytes of earlier code excluded)`);
}

// `at=` IS THE POSITION THAT WENT ON THE WIRE, and it is the only one that can measure ground.
// This file first read `from=`, which is the mover's SIM position: the sim jumps to wherever the
// last declaration aimed, so consecutive `from` values differ by roughly the STRIDE rather than by
// the ground covered, and the figure came out at 2.24 squares per packet for a character that was
// standing still. Older logs have no `at=` at all, in which case there is nothing to measure and
// this says so rather than falling back to the wrong field and printing a plausible number.
const sends = [];
for (const m of txt.matchAll(/\[move-sent\] n=(\d+) at=([-\d.]+),([-\d.]+) aim=([-\d.]+),([-\d.]+) from=([-\d.]+),([-\d.]+)/g)) {
  const [, n, tx, ty, ax, ay, fx, fy] = m;
  sends.push({ n: Number(n), at: [Number(tx), Number(ty)], aim: [Number(ax), Number(ay)], from: [Number(fx), Number(fy)] });
}
if (!sends.length && /\[move-sent\]/.test(txt)) {
  console.log(file + ': [move-sent] lines exist but carry no at= field.');
  console.log('That field is the declared position, and it is the only one that measures ground.');
  console.log('Re-run against a log written by the current mover. Do not substitute the sim');
  console.log('position for it: a rate computed from the sim is a rate of the estimate, not of');
  console.log('the character, which is how 2.24 squares per packet got reported for a mover');
  console.log('that was not moving at all.');
  process.exit(0);
}
if (!sends.length) {
  console.log(`${file}: no [move-sent] lines.`);
  console.log('This instrument postdates the log text it replaces. The historical figure of');
  console.log('"244,021 sends" is a count of the STRING `moveTo sent`, which is one of nine send');
  console.log('sites and nothing else — it is not a packet count. Do not compare against it.');
  process.exit(0);
}

const dist = sends.map(s => Math.hypot(s.aim[0] - s.from[0], s.aim[1] - s.from[1]));
const transitions = dist.filter(d => d > TRANSITION_CUTOFF);
const walking = dist.filter(d => d <= TRANSITION_CUTOFF).sort((a, b) => a - b);
const med = a => (a.length ? a[Math.floor(a.length / 2)] : NaN);

const medAll = med([...dist].sort((a, b) => a - b));
const medWalk = med(walking);

console.log(`${file}`);
console.log(`  packets            ${sends.length}`);
console.log(`  room transitions   ${transitions.length} (over ${TRANSITION_CUTOFF} units — 'from' is in the old room)`);
console.log(`  STRIDE (declared position vs where we were): median ${medAll.toFixed(0)} units = ${(medAll / KOD).toFixed(2)} squares = ${(medAll / KOD / CLIENT_SQUARES_PER_PACKET).toFixed(2)}x the client's 2.5-square stride`);
console.log(`  STRIDE, walking only    ${medWalk.toFixed(0)} units = ${(medWalk / KOD).toFixed(2)} squares = ${(medWalk / KOD / CLIENT_SQUARES_PER_PACKET).toFixed(2)}x the client's stride`);
// THE HONEST LABEL. Stride is what a packet OFFERS; ground is what the character GOT, and the
// log does not carry the server's position finely enough to compute the second. Reporting a
// stride under the name 'squares per packet' is what made every figure tonight read well while the
// fleet stood still, so the quantity gets its real name and the missing one gets named too.
console.log(`  packets per stride: ${(KOD / (medWalk || 1)).toFixed(2)}  (stride, NOT ground — see above)`);
console.log(`  ground per packet is NOT derivable from this log: the server position is`);
console.log(`  logged to square precision only. To measure ground, read the mover's own`);
console.log(`  [move-sent] at= against a position source that is not the sim.`);

// THE FREEZE CHECK, which is what this mover was actually broken by. A character that declares
// the same position over and over is not slow, it is stuck, and a rate figure alone hides that:
// 790 of 879 sends in the original keeper-t3.log declared one identical aim, and the average
// speed looked merely poor.
const runs = [];
let cur = 1;
for (let i = 1; i < sends.length; i++) {
  const same = sends[i].aim[0] === sends[i - 1].aim[0] && sends[i].aim[1] === sends[i - 1].aim[1];
  cur = same ? cur + 1 : 1;
  runs.push(cur);
}
const longest = runs.length ? Math.max(...runs) : 0;
console.log(`  longest run declaring an identical aim: ${longest} packets`);
console.log(`    (the defect this work started from was 790 of 879 sends on one identical aim)`);
