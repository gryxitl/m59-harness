#!/usr/bin/env node
// tools/m59-rate-live.mjs — the fleet's speed, measured from the SERVER's position.
//
//   node tools/m59-rate-live.mjs substrate/keeper-t3.log
//
// WHY THIS FILE EXISTS. Every rate figure this repository has ever printed was squares per
// PACKET, computed from the mover's own estimate of where it was. Both halves of that are
// wrong in the same direction. Per-packet is the wrong denominator — one square per packet
// at one packet per twelve seconds is 3% of the client, not 40% — and the mover's estimate is
// not the character. An independent audit could not reproduce the numbers quoted in
// docs/TICK-MOVEMENT-PLAN.md because there was no committed tool that produced them, which is
// a fair criticism of a document that cited figures it could not regenerate.
//
// WHAT IT READS. `[move-sent] ... at=` is the position we DECLARED. `srvXY=` inside
// [movedbg] vel-tick is the SERVER's raw position at that moment. Ground is summed over
// consecutive distinct server positions, which is the only quantity that describes how fast
// the character is actually going. Room transitions (a jump over TRANSITION_CUTOFF units) are
// excluded: the character was moved, it did not walk.
//
// WHAT IT REFUSES TO DO. It will not report a rate from the declared positions, because those
// measure the stride, and it will not fall back to the mover's sim, because that measures the
// estimate. A log without srvXY gets a refusal, not a number.

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: m59-rate-live.mjs <keeper log>'); process.exit(1); }
let txt;
try { txt = readFileSync(file, 'utf8'); }
catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(1); }

// The current session only. A keeper log spans every restart it has survived and the mover's
// counters restart with each one; measuring across sessions mixes code versions, which is how
// a rate came to be quoted against a baseline produced by different software.
const starts = [...txt.matchAll(/\[keeper\] \S+ starting on port/g)];
if (starts.length > 1) {
  const before = txt.length;
  txt = txt.slice(starts[starts.length - 1].index);
  console.log(`(window: current session only — ${starts.length} in the file, ` +
              `${((before - txt.length) / 1e6).toFixed(1)} MB of earlier code excluded)`);
}

const KOD = 64;
const CLIENT_WALK = 2.5;      // squares/s: MOVEUNITS(256 client)/MOVE_DELAY(100ms) / 16 / 64
const CLIENT_RUN = 5.0;
const TRANSITION_CUTOFF = 1000;

// Server-truth positions, in time order, deduplicated.
const srv = [];
for (const m of txt.matchAll(/srvXY=\(([-\d]+),([-\d]+)\)/g)) {
  const p = [Number(m[1]), Number(m[2])];
  if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < 0) continue;
  if (!srv.length || srv[srv.length - 1][0] !== p[0] || srv[srv.length - 1][1] !== p[1]) srv.push(p);
}
if (srv.length < 2) {
  console.log(`${file}: no server positions in the log.`);
  console.log('This instrument measures ground from the SERVER\'s position (the srvXY= field on');
  console.log('[movedbg] vel-tick lines). Nothing else describes how fast the character is going:');
  console.log('the declared position measures the stride, and the mover\'s sim measures its own');
  console.log('estimate. Older logs carry neither. Run against a log from the current mover.');
  process.exit(0);
}

let ground = 0, walking = 0, transitions = 0;
for (const [a, b] of srv.map((p, i) => [p, srv[i + 1]]).filter(([, b]) => b)) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (d > TRANSITION_CUTOFF) { transitions++; continue; }
  ground += d; walking++;
}

const packets = (txt.match(/\[move-sent\]/g) ?? []).length;
const strides = (txt.match(/vel-tick declare=/g) ?? []).length;

// PER-BRANCH ATTRIBUTION, read from the `site=` field each send site stamps at the single
// place every packet passes through. Attributing a packet to a branch by which debug line
// happened to precede it is the same mistake as the historical '244,021 sends', which counted
// the log text of one of nine send sites: a metric taken from whatever was logged rather than
// from what the code guarantees.
const bySite = new Map();
for (const m of txt.matchAll(/\[move-sent\] n=\d+ site=([\w-]+)/g))
  bySite.set(m[1], (bySite.get(m[1]) ?? 0) + 1);

// Wall-clock window from the log's own timestamps, when it has them.
const times = [...txt.matchAll(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/gm)]
  .map(m => Date.parse(m[1])).filter(Number.isFinite);
const seconds = times.length > 1 ? (times[times.length - 1] - times[0]) / 1000 : null;

const squares = ground / KOD;
console.log(file);
console.log(`  server positions      ${srv.length} distinct (${transitions} room transitions excluded)`);
console.log(`  packets sent          ${packets}  (${strides} from the stride declaration)`);
console.log(`  GROUND (server truth) ${squares.toFixed(2)} squares`);
if (seconds && seconds > 0) {
  const rate = squares / seconds;
  console.log(`  window                ${seconds.toFixed(0)} s`);
  console.log(`  RATE                  ${(rate * 100).toFixed(0)} squares per 100 s = ${rate.toFixed(2)} squares/s`);
  console.log(`  vs the client         ${(rate / CLIENT_WALK * 100).toFixed(0)}% of walk (${CLIENT_WALK}/s), ${(rate / CLIENT_RUN * 100).toFixed(0)}% of run (${CLIENT_RUN}/s)`);
  console.log(`  packets per second    ${(packets / seconds).toFixed(2)} (the client reports ~1/s)`);
} else {
  console.log('  window                unknown — the log has no parseable timestamps, so no');
  console.log('                        per-second rate is reported. Ground alone is not a rate.');
}
console.log(`  ground per packet     ${(squares / Math.max(1, packets)).toFixed(2)} squares (client stride: 2.5 walk / 5.0 run)`);
if (bySite.size) {
  console.log('  packets by send site:');
  for (const [k, v] of [...bySite].sort((a, b) => b[1] - a[1]))
    console.log(`    ${String(v).padStart(6)}  ${k}`);
  if (bySite.get('unlabelled'))
    console.log('    ^ UNLABELLED means a send site was added without naming itself. Every site');
  console.log('  (ground per site is not reported: the log carries the server position far less');
  console.log('   often than there are packets, so per-site ground would be an attribution.)');
} else {
  console.log('  no site= field in these packets: an older log. Ground per branch is not');
  console.log('  reportable and guessing it from neighbouring debug lines is how the');
  console.log("  the '244,021 sends' figure came to exist.");
}
