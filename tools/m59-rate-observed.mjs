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
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const file = process.argv[2] ?? 'substrate/keeper-t3.log';
const KOD = 64;
const CLIENT_SQUARES_PER_PACKET = 2.5;   // MOVEUNITS per MOVE_DELAY, reported per MOVE_INTERVAL
const TRANSITION_CUTOFF = 600;           // units; above this it is a room change, not a stride

// STREAM: logs now exceed the V8 string limit (~512 MB). Read line by line.
const sends = [];
let _lastStartLine = 0;
let _totalStarts = 0;
const _re = /\[move-sent\] n=(\d+)(?: site=(\S+))? at=([-\d.]+),([-\d.]+) aim=([-\d.]+),([-\d.]+) from=([-\d.]+),([-\d.]+)/;
const _startRe = /\[keeper\] \S+ starting on port/;
const _tsRe = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;
let _firstTs = null, _lastTs = null;
const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) });
for await (const line of rl) {
  if (_startRe.test(line)) { _lastStartLine = sends.length; _totalStarts++; }
  const m = line.match(_re);
  if (m) {
    const ts = line.match(_tsRe);
    if (ts) { if (!_firstTs) _firstTs = ts[1]; _lastTs = ts[1]; }
    sends.push({ n: Number(m[1]), site: m[2] ?? '?', at: [Number(m[3]), Number(m[4])], aim: [Number(m[5]), Number(m[6])], from: [Number(m[7]), Number(m[8])] });
  }
}
if (_totalStarts > 1) {
  const excluded = _lastStartLine;
  sends.splice(0, _lastStartLine);
  console.log(`(window: the current session only — ${_totalStarts} sessions in the file, ${excluded} sends from earlier sessions excluded; kept ${sends.length} sends ${_firstTs ?? '?'} → ${_lastTs ?? '?'})`);
}

if (!sends.length) {
  console.log(`${file}: no [move-sent] lines with at= field.`);
  console.log('Re-run against a log written by the current mover. Do not substitute the sim');
  console.log('position for it: a rate computed from the sim is a rate of the estimate, not of');
  console.log('the character, which is how 2.24 squares per packet got reported for a mover');
  console.log('that was not moving at all.');
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
console.log(`  packets per stride: ${(KOD / (medWalk || 1)).toFixed(2)}  (stride, NOT ground — see above)`);
console.log(`  ground per packet is NOT derivable from this log: the server position is`);
console.log(`  logged to square precision only. To measure ground, read the mover's own`);
console.log(`  [move-sent] at= against a position source that is not the sim.`);
// Per-site breakdown
const bySite = {};
for (const s of sends) { (bySite[s.site] ??= []).push(Math.hypot(s.aim[0] - s.from[0], s.aim[1] - s.from[1])); }
for (const [site, ds] of Object.entries(bySite).sort((a, b) => b[1].length - a[1].length)) {
  const sorted = [...ds].sort((a, b) => a - b);
  const m2 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
  console.log(`  site=${site}: ${ds.length} packets, median stride ${m2.toFixed(0)}u = ${(m2 / KOD).toFixed(2)} sq`);
}
console.log(`  ground per packet is NOT derivable from this log: the server position is`);
console.log(`  logged to square precision only. To measure ground, read the mover's own`);
console.log(`  [move-sent] at= against a position source that is not the sim.`);

// THE FREEZE CHECK, which is what this mover was actually broken by. A character that declares
// the same position over and over is not slow, it is stuck, and a rate figure alone hides that:
// 790 of 879 sends in the original keeper-t3.log declared one identical aim, and the average
// speed looked merely poor.
let cur = 1, longest = 0;
for (let i = 1; i < sends.length; i++) {
  const same = sends[i].aim[0] === sends[i - 1].aim[0] && sends[i].aim[1] === sends[i - 1].aim[1];
  cur = same ? cur + 1 : 1;
  if (cur > longest) longest = cur;
}
console.log(`  longest run declaring an identical aim: ${longest} packets`);
console.log(`    (the defect this work started from was 790 of 879 sends on one identical aim)`);
