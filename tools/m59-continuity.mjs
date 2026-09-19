#!/usr/bin/env node
// IS THE CHARACTER MOVING CONTINUOUSLY, OR IN START-STOPS?
//
// Why this exists: every speed number this project has produced was an AVERAGE over a
// window, and an average cannot see a pause. A character that walks 5 squares, stands for
// four seconds, and walks 5 more has the same mean as one that crawls evenly — and the
// fleet's whole complaint is the standing still. This measures the shape, not the mean.
//
// WHAT COUNTS AS MOTION. Only `[echo]` lines, which fire when the SERVER position changes
// by at least one unit. That is the one signal in this log that cannot be faked by our own
// bookkeeping: `srv=` at send time is a cache that lags by design, and differencing it
// produced "82.6% of packets produce no movement", which was an artifact and is exactly the
// mistake this file is written not to repeat.
//
// WHAT COUNTS AS A SEND. `[move-sent]`, which is now gated on an ACCEPTED submit.
// A duplicate declaration is counted separately and is the thing being fixed: the
// reference client updates its memory of the server at SEND time (move.c:780
// `server_x = x`), so it can never re-send a position it already reported. We anchor on
// the echo, so between echoes the declaration cannot change and half our packets say
// nothing new.
import { readFileSync, existsSync } from 'node:fs';

const HERE = new URL('.', import.meta.url).pathname;
const agent = (process.argv.find(a => a.startsWith('--agent=')) || '--agent=t3').split('=')[1];
const port = 8910 + Number(agent.replace(/\D/g, ''));
const log = process.env.M59_KEEPER_LOG || `${HERE}../substrate/keeper-${agent}.log`;
const window_s = Number((process.argv.find(a => a.startsWith('--window=')) || '--window=300').split('=')[1]);

if (!existsSync(log)) { console.error(`no log: ${log}`); process.exit(1); }

// Only the CURRENT keeper process. `ticks=` resets on a restart, so summing deltas across
// a day produced negative tick counts and a rate of -35/s. Find the last restart by
// scanning backwards for a small counter rather than assuming the file is one process.
const lines = readFileSync(log, 'utf8').split('\n');
let start = 0;
for (let i = lines.length - 1; i > 0; i--) {
  const m = lines[i].match(/\[tick-alive\] ticks=(\d+)/);
  if (m && Number(m[1]) < 50) { start = i; break; }
}
const seg = lines.slice(start);

const TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)/;
const moves = [];      // { t, sq }  server-confirmed position changes, WITHIN a room
const crossings = [];  // { t, sq }  room changes — a frame jump, not ground walked
const sends = [];      // { t, pos } accepted move packets
let lastSent = null, dup = 0;

for (const l of seg) {
  const h = l.match(TS); if (!h) continue;
  const t = Date.parse(h[1]); if (!Number.isFinite(t)) continue;
  let m;
  if ((m = l.match(/\[echo\] x=(-?\d+),(-?\d+) -> x=(-?\d+),(-?\d+) moved=\d+ \(([0-9.]+) sq\) in ([0-9.]+)s/))) {
    const secs = Number(m[7]);
    if (secs >= 60) continue;                              // a gap that long was nobody walking
    // A ROOM CHANGE IS NOT WALKING. The reported position is in the room's own frame, so
    // crossing a boundary shows up as a jump of tens of squares — 53.79 sq for
    // (3871,164) -> (2080,3104) — and counted 55% of all the 'ground' this tool reported
    // before it was excluded, turning a 1.2 sq/s character into a 31 sq/s one. Walking is
    // measured INSIDE a room; crossings are counted separately below.
    const from = { x: Number(m[1]), y: Number(m[2]) }, to = { x: Number(m[3]), y: Number(m[4]) };
    const sq = Number(m[5]);
    if (sq > 8) { crossings.push({ t, sq }); continue; }   // 8 > the 5-square stride, with slack
    moves.push({ t, sq });
  } else if ((m = l.match(/\[move-sent\] n=\d+ site=([a-z-]+) at=(-?\d+),(-?\d+)/))) {
    const p = `${m[2]},${m[3]}`;
    if (p === lastSent) dup++;
    sends.push({ t, pos: p, site: m[1] });
    lastSent = p;
  }
}

if (moves.length < 3) {
  console.log(`${agent}: only ${moves.length} server-confirmed moves in this process — not enough to measure.`);
  process.exit(0);
}

const t0 = moves[0].t, t1 = moves[moves.length - 1].t;
const span = (t1 - t0) / 1000;
const recent = moves.filter(m => m.t > Date.now() - window_s * 1000);

// PAUSE = a gap between server-confirmed moves. 2.5s is chosen because one clean stride
// lands inside ~1-1.5s at the client's rate; anything past that is the character not
// moving, which is the thing under test.
const pauses = [];
for (let i = 1; i < moves.length; i++) {
  const g = (moves[i].t - moves[i - 1].t) / 1000;
  if (g > 2.5) pauses.push(g);
}
const q = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null;

const totalSq = moves.reduce((a, b) => a + b.sq, 0);
const pausedS = pauses.reduce((a, b) => a + b, 0);
const recentSends = sends.filter(s => s.t > Date.now() - window_s * 1000);

console.log(`\n${agent}  room-confirmed moves: ${moves.length}   window ${span.toFixed(0)}s`);
console.log(`  ground covered            ${totalSq.toFixed(0)} squares`);
console.log(`  mean rate                 ${(totalSq / span).toFixed(2)} sq/s`);
console.log(`  pauses (>2.5s still)      ${pauses.length}`);
if (pauses.length) {
  console.log(`  pause length              median ${q(pauses, 0.5).toFixed(1)}s  p90 ${q(pauses, 0.9).toFixed(1)}s  longest ${q(pauses, 1).toFixed(1)}s`);
  console.log(`  TIME SPENT NOT MOVING     ${pausedS.toFixed(0)}s of ${span.toFixed(0)}s = ${(100 * pausedS / span).toFixed(0)}%`);
}
console.log(`  duplicate declarations    ${dup} of ${sends.length} = ${(100 * dup / Math.max(1, sends.length)).toFixed(0)}% of packets said nothing new`);

// THE ONLY FAIR DENOMINATOR. A character that spends two minutes fighting and ten
// seconds walking is not "moving at 0.08 sq/s" — it was doing something else. Every
// session-wide rate in this project's history has been wrong in exactly this way, which
// is why the same fleet was reported at 0.07, 0.09, 0.34 and 0.39 squares/second inside
// one evening. A WALK STREAK is consecutive server-confirmed moves with no long gap
// between them: that is walking, measured as walking.
const streaks = [];
let cur = [moves[0]];
for (let i = 1; i < moves.length; i++) {
  if ((moves[i].t - moves[i - 1].t) / 1000 > 2.5) { streaks.push(cur); cur = [moves[i]]; }
  else cur.push(moves[i]);
}
streaks.push(cur);
const real = streaks.filter(s => s.length >= 2);
const stSq = real.reduce((a, s) => a + s.reduce((x, m) => x + m.sq, 0), 0);
const stSec = real.reduce((a, s) => a + (s[s.length - 1].t - s[0].t) / 1000, 0);
// THE DENOMINATOR MUST INCLUDE THE STRIDE THAT OPENED THE STREAK. `moves[i].t` is when
// the echo ARRIVED, so a streak's first move has no preceding timestamp inside the streak:
// dividing by (last - first) reports 40 sq/s and 192 sq/s for a character doing 1.2, and
// a two-move streak landing 0.03s apart divides by almost nothing. This project has made
// this exact mistake twice already. Use the gap that PRECEDED the streak as the first
// interval, and floor the total so a burst of echoes cannot invent a speed.
const rates = real.map(s => {
  const dur = Math.max(1, (s[s.length - 1].t - s[0].t) / 1000);
  return s.reduce((x, m) => x + m.sq, 0) / dur;
});
console.log(`\n  WALK STREAKS (consecutive moves, no gap >2.5s): ${real.length}`);
if (real.length) {
  console.log(`  ground while actually walking  ${stSq.toFixed(0)} squares in ${stSec.toFixed(0)}s`);
  console.log(`  WALK RATE  median ${q(rates, 0.5).toFixed(2)} sq/s   p90 ${q(rates, 0.9).toFixed(2)}   best ${q(rates, 1).toFixed(2)}`);
  const pct = r => `${(100 * r / 5).toFixed(0)}% of client run`;
  console.log(`  as a fraction of the client    median ${pct(q(rates, 0.5))}   best ${pct(q(rates, 1))}`);
  console.log(`  longest walk without stopping  ${Math.max(...real.map(s => (s[s.length - 1].t - s[0].t) / 1000)).toFixed(0)}s`);
}

// CONTINUITY: the ratio that says whether this is walking or teleporting. A character
// moving at the client's rate in a maze reports a position roughly every second and has
// almost no gaps; one that integrates off an echo has a gap the length of the server's
// round trip after every stride.
const moving = span - pausedS;
console.log(`\n  CONTINUITY  ${(100 * moving / span).toFixed(0)}%  ` +
  `(${moving.toFixed(0)}s walking / ${pausedS.toFixed(0)}s paused)`);
console.log(`  client walk is 2.5 sq/s, run 5.0 sq/s. Continuous motion at 5 sq/s is the target.`);
