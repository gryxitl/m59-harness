#!/usr/bin/env node
// m59-soak-sample.mjs — poll the fleet's keepers and record the GOAP-signal basket:
//   1. /health stalled        — the board's own "stalled / not stalled" verdict,
//      which is defined as the mover's `arrived` counter not climbing while
//      `moving` is set. So "stalled=false" over a window IS the arrived-climbing
//      signal, available through the proof endpoint.
//   2. /health goap.goal      — which goal the decider is running each tick; a
//      goal with a big cumulative tick count but no progress is the unachievable
//      goal signature (it just keeps declining and never reaches idle_rest).
//   3. /tickstats by_goal     — the cumulative-per-goal book for the window; lets
//      a goal's count be compared against what it actually SENT to the server
//      (ticks >> sent = a goal that keeps asking for a step the model refuses).
//   4. /probe pos            — the character's room col,row so we can see the
//      character actually relocating between samples (the live form
//      of "mover arrived is climbing").
//
// Writes one JSONL line per poll round and prints a human one-liner per keeper.
import { writeFile } from 'fs/promises';

const PORTS = [8911, 8912, 8913, 8914, 8915];
const opt = (k, d) => { const hit = process.argv.find(a => a.startsWith('--' + k + '='));
                        return hit && hit.split('=')[1] ? hit.split('=')[1] : d; };
const DUR     = Number(opt('dur',   300000));
const EVERY   = Number(opt('every', 30000));
const OUT     = opt('out',  '/tmp/m59-soak-samples.jsonl');

const get = (p, path) =>
  fetch(`http://127.0.0.1:${p}${path}`, { signal: AbortSignal.timeout(4000) })
    .then(r => r.json()).catch(() => null);

async function one(p) {
  const [health, tick, probe] = await Promise.all([
    get(p, '/health'), get(p, '/tickstats'), get(p, '/probe'),
  ]);
  return {
    port: p,
    ts: Date.now(),
    character: health?.character ?? null,
    in_game: health?.in_game ?? false,
    // The board's own verdict. false = the proof moved arrived recently.
    stalled: health?.stalled ?? null,
    goal: health?.goap?.goal ?? null,
    action: health?.goap?.action ?? null,
    room: health?.room?.name ?? (health?.room && String(health.room.num)) ?? null,
    pos: probe?.pos ? { col: probe.pos.col, row: probe.pos.row } : null,
    by_goal: tick?.by_goal ?? null,
    window_s: tick?.window_s ?? null,
    ticks: tick?.ticks ?? null,
    sent: tick?.sent ?? null,
    worst_gap_ms: tick?.loop?.worst_gap_ms ?? null,
    not_in_game: tick?.loop?.not_in_game ?? null,
  };
}

const startedAt = Date.now();
const lines = [];
let n = 0;
while (Date.now() - startedAt < DUR) {
  const rows = await Promise.all(PORTS.map(one));
  lines.push(JSON.stringify({ n, at: Date.now(), rows }));
  n++;
  for (const r of rows) {
    const top = r.by_goal?.slice().sort((a, b) => b.ticks - a.ticks)
                                   .map(g => `${g.goal}:${g.ticks}${g.sent < g.ticks ? `/${g.sent}` : ''}`)
                                   .join(' ');
    const st = r.stalled === false ? 'ok'
            : (r.stalled == null ? '?' : `STALL:${String(r.stalled).slice(0, 40)}`);
    console.log(`[t ${String(n).padStart(2)}] ${String(r.character).padEnd(10)} ` +
                `goal=${String(r.goal).padEnd(14)} ${st.padEnd(52)} ${top}`);
  }
  const wait = Math.min(EVERY, DUR - (Date.now() - startedAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}
await writeFile(OUT, lines.join('\n') + '\n');
console.log(`\nwrote ${n} samples to ${OUT}`);
