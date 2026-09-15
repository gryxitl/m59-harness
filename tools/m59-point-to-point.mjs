#!/usr/bin/env node
// POINT-TO-POINT WALKING SPEED, which is the only number that answers "how fast does
// this character walk to another spot".
//
// WHY THIS TOOL EXISTS. Every rate figure in this project up to now was computed as
//
//     squares moved over the whole session  /  session wall-clock duration
//
// and compared against the client's 2.5 squares/second. That is wrong, and the error is
// one line in tools/m59-rate-live.mjs:119-121, which takes the FIRST and LAST timestamp in
// the log and calls the difference a `window`. The session window contains everything a
// character does — counted from a live log it is 72% combat and 13% sitting down
// recovering vigor — so the "rate" was a fleet working a shift, divided by a stopwatch,
// compared to somebody walking down a corridor. It made a healthy mover look like a slow
// one, and it is why a 2x-per-packet engine appeared to change nothing.
//
// WHAT IS MEASURED INSTEAD: a contiguous WALKING interval. The clock starts when the
// character is given a destination it accepts and stops when it arrives, is refused, or
// goes longer than IDLE_MS without a move packet — whichever comes first. Time spent in
// combat, resting, looting or idling is NOT in the denominator, because the character was
// not trying to walk during it. The client's 2.5 squares/s is a walking speed, so it may
// only ever be compared to a walking speed.
//
// The distance is server-truth: positions the server echoed, with room transitions
// excluded (a teleport is not walking). Declarations are never differenced — a position
// packet is a claim, and the claim is what is being tested.
import fs from 'node:fs';
import readline from 'node:readline';

const KOD = 64;
const CLIENT_WALK = 2.5;   // squares/s, move.c:49/57 — the number we are allowed to compare to
const IDLE_MS = 3000;      // no packet for this long means the walk stopped
const TRANSITION_CUTOFF = 64 * 12; // a jump past this is a room change, not walking

const file = process.argv[2] || 'substrate/keeper-t3.log';

const lines = (await fs.promises.readFile(file, 'utf8')).split('\n');

// Session window: the mover's instrumentation has changed across restarts, so only the
// current session's lines are comparable.
const starts = lines.map(l => /^\d{4}-\d\d-\d\dT/.test(l) && l).filter(Boolean);
let sessionFrom = null;
for (let i = lines.length - 1; i >= 0; i--) {
  if (/t[0-9] starting on port|keeper .* starting/.test(lines[i])) { sessionFrom = lines[i].slice(0, 24); break; }
}

const events = [];  // { t, kind, x?, y? }
for (const l of lines) {
  if (sessionFrom && l.slice(0, 24) < sessionFrom) continue;
  const ts = l.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)/);
  if (!ts) continue;
  const t = Date.parse(ts[1]);

  // A destination the mover ACCEPTED. This is the start of a walk, and it is the only
  // place an accepted destination is logged, so it cannot undercount.
  const acc = l.match(/\[to-accepted\][^>]*-> \((\d+),(\d+)\)/);
  if (acc) { events.push({ t, kind: 'dest', col: +acc[1], row: +acc[2] }); continue; }

  // A SERVER POSITION, in fine units. Getting this right is the whole tool, and the first
  // version got it wrong by a factor of 64: it matched `srv=(20,40)`, which is a SQUARE
  // (col,row) from the [movestuck] diagnostic, treated it as a fine coordinate, and divided
  // by KOD again — producing a confident "0.01 squares/second" for a character the other
  // instrument measured crossing six thousand squares. Two shapes are accepted, both fine:
  //   [move-sent] ... srv=1568,2530   dense, one per packet — the one to use
  //   [echo] x=800,2528 -> x=722,2838 sparse, but the `moved=` field is the server's own delta
  // `at=` is what we DECLARED and must never be differenced to measure ground; `from=` is
  // the mover's SIM estimate. Both have produced false rates in this project already.
  const dense = l.match(/\[move-sent\].*\bsrv=(\d+),(\d+)/);
  if (dense) { events.push({ t, kind: 'pos', x: +dense[1], y: +dense[2] }); continue; }
  const echo = l.match(/\[echo\] x=(\d+),(\d+) -> x=(\d+),(\d+) moved=(\d+)/);
  if (echo) { events.push({ t, kind: 'pos', x: +echo[3], y: +echo[4] }); continue; }
}

// Cut into WALK intervals: a destination opens one, and it closes on the next destination
// or on a gap in packets longer than IDLE_MS.
const walks = [];
let cur = null;
for (const e of events) {
  if (e.kind === 'dest') {
    if (cur && cur.pos.length > 1) walks.push(cur);
    cur = { start: e.t, dest: `${e.col},${e.row}`, pos: [] };
    continue;
  }
  if (!cur) continue;
  const last = cur.pos[cur.pos.length - 1];
  if (last && e.t - last.t > IDLE_MS) { if (cur.pos.length > 1) walks.push(cur); cur = { ...cur, pos: [] }; }
  cur.pos.push(e);
}
if (cur && cur.pos.length > 1) walks.push(cur);

const rows = [];
for (const w of walks) {
  let ground = 0, trans = 0;
  for (let i = 1; i < w.pos.length; i++) {
    const d = Math.hypot(w.pos[i].x - w.pos[i - 1].x, w.pos[i].y - w.pos[i - 1].y);
    if (d > TRANSITION_CUTOFF) trans++; else ground += d;
  }
  const sec = (w.pos[w.pos.length - 1].t - w.pos[0].t) / 1000;
  if (ground > 0) rows.push({ dest: w.dest, sq: ground / KOD, sec, rate: sec > 0 ? ground / KOD / sec : 0, trans });
}

// EXCLUSIONS, counted out loud. An interval shorter than MIN_SEC cannot yield a rate: the
// first version of this tool reported '1.0 sq in 0 s = 9.80 sq/s (392% of client walk)' and
// a 'best single walk' of 11.57 sq/s, which is 4.6x the client's WALK speed and physically
// impossible on foot. It was two log lines stamped in the same millisecond divided at each
// other. A rate needs a duration, and a tool that prints a rate without one is worse than a
// tool that prints nothing. CEILING_SQ_S is the same kind of guard in the other direction:
// anything faster than a character can run is not a walk, and reporting it as one turns a
// measurement into a boast.
const MIN_SEC = 3;
const CEILING_SQ_S = 6.0;   // above the client's RUN speed (5/s); nothing on foot beats it
const kept = [], dropped = { short: 0, impossible: 0, zero: 0 };
for (const r of rows) {
  if (!(r.sec > 0)) { dropped.zero++; continue; }
  if (r.sec < MIN_SEC) { dropped.short++; continue; }
  if (r.rate > CEILING_SQ_S) { dropped.impossible++; continue; }
  kept.push(r);
}
console.log(`intervals: ${rows.length} measured, ${kept.length} usable`
  + ` (dropped: ${dropped.zero} with no duration, ${dropped.short} under ${MIN_SEC}s,`
  + ` ${dropped.impossible} faster than ${CEILING_SQ_S} sq/s and therefore not a walk)`);
rows.length = 0; rows.push(...kept);

console.log(file, sessionFrom ? `(session from ${sessionFrom})` : '(whole file)');
console.log(`walk intervals with measurable ground: ${rows.length}`);
if (!rows.length) {
  console.log('\nNOTHING MEASURABLE. Either the log has no [to-accepted] lines (the mover');
  console.log('build predates that instrumentation) or no walk produced server positions.');
  process.exit(0);
}
rows.sort((a, b) => a.sec - b.sec);
for (const r of rows.slice(0, 25))
  console.log(`  -> ${r.dest.padEnd(8)} ${r.sq.toFixed(1).padStart(6)} sq in ${r.sec.toFixed(0).padStart(5)} s`
    + ` = ${(r.sq / r.sec).toFixed(2)} sq/s (${(r.rate / CLIENT_WALK * 100).toFixed(0)}% of client walk)`
    + (r.trans ? `  [${r.trans} room change${r.trans > 1 ? 's' : ''} excluded]` : ''));

const rates = rows.map(r => r.rate).sort((a, b) => a - b);
const med = rates[Math.floor(rates.length / 2)];
const best = rates[rates.length - 1];
const totalSq = rows.reduce((s, r) => s + r.sq, 0);
const totalSec = rows.reduce((s, r) => s + r.sec, 0);
console.log('');
console.log('');
console.log(`  MEDIAN walk              ${med.toFixed(2)} sq/s = ${(med / CLIENT_WALK * 100).toFixed(0)}% of the client's ${CLIENT_WALK} sq/s   <- the headline number`);
console.log(`  pooled (all sq / all s)  ${(totalSq / totalSec).toFixed(2)} sq/s across ${totalSec.toFixed(0)} s of walking — weights long`);
console.log(`                             slow walks, so it sits below the median here; quoted as a`);
console.log(`                             floor, never as 'the' speed`);
console.log(`  best single walk         ${best.toFixed(2)} sq/s — one walk, on good ground, no generalisation`);
console.log('');
console.log('Compare THIS to 2.5 sq/s. The session-wide figure in m59-rate-live.mjs is not');
console.log('comparable to it: that denominator is wall-clock and includes combat and resting,');
console.log('during which the character is not walking and never claimed to be.');
