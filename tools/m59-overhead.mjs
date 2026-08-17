#!/usr/bin/env node
// WHO IS NOT FIGHTING, AND WHAT IS STOPPING THEM.
//
//   node tools/m59-overhead.mjs            worst first: travel + trade against fighting
//   node tools/m59-overhead.mjs --json
//
// The fleet board answers "what is this character doing". This answers the question one
// level up: where does the time GO, and for the characters losing the most of it, what
// is the mechanism. Overhead is travel plus trade — the two buckets that are neither
// fighting nor recovering from it — and a character at 90% overhead and 0% fighting is
// not idle or stalled. It is busy doing something that is not the job.
//
// WHY THE MONEY COLUMNS ARE HERE. They are the mechanism, and it is not obvious enough
// to leave to a second command. `walkingMoney` is BOTH the float kept after banking AND
// the floor restockReagents refuses to spend below, so the money a character can actually
// spend is the BAND between bank_above and walking_money — and when that band is narrow a
// character walks to a merchant, declines to buy, and walks back, for ever. Measured on
// this fleet with the shipped 500/400: purses of 0 to 586 against bank balances of 10,000
// to 36,000, trading at 54% of active time, three characters at zero fighting. Nothing in
// the fleet board showed it; the band did.
//
// AND THE DECLINE COUNTERS ARE THE PROOF. The keeper already records every purchase it
// decided against, with a reason, in `spending.declined` — `purse is down to the walking
// float` is the exact string that would have named the fault the first time anybody
// looked. It was there all along and no view surfaced it. That is what this column is.
//
// Reagents are shown as the pair because castings are min(elderberry, herbs) / 2: a
// character at 3/94 has ONE casting, not ninety-seven, and reads as stocked to anything
// that sums or averages the two.
const PORT = process.env.M59_BROKER_PORT || '8901';
const JSON_OUT = process.argv.includes('--json');
const LIFETIME = process.argv.includes('--lifetime');

// SINCE THE LAST TIME SOMEBODY ASKED, NOT SINCE THE KEEPER STARTED.
//
// The broker's time buckets are cumulative from keeper start, and read as ratios they
// are a character's whole biography rather than what it is doing now. That is not a
// small distortion: one deep restock is twenty minutes of `trading`, and it sits in the
// percentage for ever. Camilla read 78% overhead and 9% fighting on this table while
// standing in room 39 fighting from a proven safe spot with 62 castings in the pack —
// the trade was an hour old and the row still called it the worst in the fleet. Read
// that way twice, it produced a confident and wrong conclusion both times.
//
// So the default is a DELTA against the previous run: the buckets are stamped to disk
// each time and the next run subtracts. The first run has nothing to subtract and says
// so rather than printing a lifetime table that looks like an interval one. `--lifetime`
// asks for the old behaviour on purpose.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const STAMP = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', 'overhead-last.json');
const previous = (() => {
  try { return JSON.parse(readFileSync(STAMP, 'utf8')); } catch { return null; }
})();

async function call(name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return JSON.parse(j.result.content[0].text);
}

const fleet = await call('fleet', {}).catch(e => {
  console.error(`no answer from the broker on ${PORT}: ${e.message}`);
  process.exit(1);
});

// One status call per character is the only way to reach `spending.declined`; the fleet
// row does not carry it. Sequential on purpose — this is a diagnostic somebody runs, not
// something on a loop, and twenty-one parallel calls would fight the pacer for the same
// broker the fleet is being driven through.
const rows = [];
for (const f of (fleet.fleet || [])) {
  const t = f.time || {};
  const active = t.active_s || 0;
  const overhead = (t.trading_s || 0) + (t.travelling_s || 0);
  const st = await call('autopilot', { agent: f.agent, action: 'status' }).catch(() => null);
  const declined = st?.spending?.declined || {};
  // The single loudest reason, because a list per row makes the table unreadable and the
  // top one has always been the answer so far.
  const top = Object.entries(declined).sort((a, b) => b[1] - a[1])[0] || null;
  const p = st?.policy || {};
  const was = previous?.by?.[f.agent] || null;
  // Only subtract when the counters have gone UP. A keeper restart zeroes them, and
  // subtracting across that gives negative time, which would read as a character that
  // un-fought. Falling counters mean the baseline is gone, so fall back to lifetime and
  // mark the row rather than printing a number that cannot be true.
  const usable = !LIFETIME && was && (t.active_s || 0) >= (was.active_s || 0);
  const d = (key) => usable ? (t[key] || 0) - (was[key] || 0) : (t[key] || 0);
  const activeD = d('active_s');
  const overheadD = d('trading_s') + d('travelling_s');
  rows.push({
    agent: f.agent, character: f.character || '?',
    since: usable ? 'interval' : (LIFETIME ? 'lifetime' : 'no-baseline'),
    interval_s: activeD,
    overhead_pct_interval: activeD > 0 ? Math.round(100 * overheadD / activeD) : null,
    fighting_pct_interval: activeD > 0 ? Math.round(100 * d('fighting_s') / activeD) : null,
    fighting_s: t.fighting_s || 0, trading_s: t.trading_s || 0, travelling_s: t.travelling_s || 0,
    active_s: active,
    overhead_pct_lifetime: active ? Math.round(100 * overhead / active) : 0,
    fighting_pct_lifetime: active ? Math.round(100 * (t.fighting_s || 0) / active) : 0,
    elderberry: f.reagents?.elderberry ?? 0, herbs: f.reagents?.herbs ?? 0,
    castings: Math.floor(Math.min(f.reagents?.elderberry ?? 0, f.reagents?.herbs ?? 0) / 2),
    purse: f.purse ?? null,
    band: (p.bankAbove != null && p.walkingMoney != null) ? p.bankAbove - p.walkingMoney : null,
    declined: top ? `${top[0]} x${top[1]}` : null,
  });
}
// Worst first: the gap between what a character spends on overhead and what it spends
// fighting. A character at 90/0 and one at 50/45 are different problems and this orders
// them the way somebody triaging would.
const oh = r => r.overhead_pct_interval ?? r.overhead_pct_lifetime;
const fp = r => r.fighting_pct_interval ?? r.fighting_pct_lifetime;
rows.sort((a, b) => (oh(b) - fp(b)) - (oh(a) - fp(a)));

// Stamp AFTER reading, so this run's numbers are the next run's baseline.
try {
  mkdirSync(dirname(STAMP), { recursive: true });
  writeFileSync(STAMP, JSON.stringify({ at: Date.now(),
    by: Object.fromEntries((fleet.fleet || []).map(f => [f.agent, f.time || {}])) }, null, 1));
} catch { /* a missing stamp costs one interval, not the run */ }

if (JSON_OUT) { console.log(JSON.stringify(rows, null, 1)); }
else {
  const n = (v, w) => String(v ?? '?').padStart(w);
  const span = rows.find(r => r.since === 'interval');
  console.log(span
    ? `worst first — overhead is travel + trade, SINCE THE LAST RUN (~${Math.round((rows.reduce((m, r) => Math.max(m, r.interval_s || 0), 0)) / 60)}m)`
    : 'worst first — overhead is travel + trade, LIFETIME (no baseline yet; run again for an interval)');
  console.log('ag   char        oh%  fight%  cast  e/h        purse  band   most-declined purchase');
  for (const r of rows)
    console.log(r.agent.padEnd(4), r.character.padEnd(10), n(oh(r), 4), n(fp(r), 6),
                n(r.castings, 5), (r.elderberry + '/' + r.herbs).padStart(9),
                n(r.purse, 7), n(r.band, 5), '  ' + (r.declined ?? '—'));
}
