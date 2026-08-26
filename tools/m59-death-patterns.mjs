#!/usr/bin/env node
// m59-death-patterns.mjs -- detect repeating death patterns in the ledger.
//
// WHY THIS EXISTS
//
// The ledger records every death (room, level, killer, prey, strategy). But
// nobody was reading it for PATTERNS. Lee died four times in two days, all at
// "Main gate to the city of Tos", all against giant rats, all in the same safe
// spot (col 3, row 17). The post-mortems said "killed by giant rat" four times
// and stopped there. The actionable fact -- "this character keeps dying in the
// same spot, the safe spot is compromised, re-spot or switch rooms" -- had to
// be noticed by a human reading four separate files.
//
// This tool reads the recent death events from the ledger and surfaces the
// patterns that matter:
//   1. Same room: N deaths in the same room within the window -> "the room is
//      dangerous / the safe spot is compromised".
//   2. Same killer: N deaths to the same creature -> "you are fighting something
//      you cannot beat, change prey or level up".
//   3. Same prey: N deaths while hunting the same prey -> "that prey is killing
//      you, auto-retarget should have fired".
//   4. Room + prey combo: the strongest signal -- same room, same prey, same deaths.
//
// It is a reporting tool, not a decision maker. It prints what it finds and
// leaves the judgement to the human (or the GOAP, if you wire it up later).
//
// USAGE
//   node tools/m59-death-patterns.mjs                # all characters, 24h
//   node tools/m59-death-patterns.mjs --window 72h   # 3-day window
//   node tools/m59-death-patterns.mjs --char Lee     # one character
//   node tools/m59-death-patterns.mjs --min 3        # require 3+ deaths to flag
//
// No dependencies. Reads the ledger JSONL files, needs nothing live.

import { pathToFileURL } from 'node:url';
import { readLedger } from './m59-ledger.mjs';

// ── pattern detection (exported for testing) ──────────────────────────────────
function countBy(arr, key) {
  const m = new Map();
  for (const x of arr) {
    const k = key(x);
    if (k == null) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function topRepeats(m, min) {
  return [...m.entries()]
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1]);
}

// Detect repeating death patterns in a list of death events.
// Each death event: { character, died_in, hunting, killed_by, ... }
// Returns: [{ name, totalDeaths, findings: [{type, label, count, note}] }]
//
// Exported so m59-death-patterns-test.mjs can verify the detection logic
// without reading the real ledger.
export function detectPatterns(deaths, minDeaths = 3) {
  const byChar = new Map();
  for (const d of deaths) {
    if (!d.character) continue;
    if (!byChar.has(d.character)) byChar.set(d.character, []);
    byChar.get(d.character).push(d);
  }

  const findings = [];

  for (const [name, list] of byChar) {
    const n = list.length;
    const findingsFor = [];

    // 1. Same room
    const rooms = topRepeats(countBy(list, d => d.died_in), minDeaths);
    for (const [room, cnt] of rooms)
      findingsFor.push({ type: 'room', label: room, count: cnt,
        note: cnt >= 3 ? 'the safe spot is likely compromised or the room is too dangerous -- re-spot or switch rooms'
                       : 'repeated deaths here -- worth a look' });

    // 2. Same killer
    const killers = topRepeats(countBy(list, d => d.killed_by), minDeaths);
    for (const [killer, cnt] of killers)
      findingsFor.push({ type: 'killer', label: killer, count: cnt,
        note: cnt >= 3 ? 'you are being killed by the same creature repeatedly -- change prey or level up'
                       : 'repeatedly killed by this creature' });

    // 3. Same prey (hunting)
    const prey = topRepeats(countBy(list, d => d.hunting), minDeaths);
    for (const [hunt, cnt] of prey)
      findingsFor.push({ type: 'prey', label: hunt, count: cnt,
        note: cnt >= 3 ? 'died repeatedly while hunting this prey -- it is above your level or the room is unsafe'
                       : 'repeated deaths hunting this prey' });

    // 4. Room + prey combo (the strongest signal: same room, same prey, same deaths)
    const combos = topRepeats(countBy(list, d =>
      (d.died_in && d.hunting) ? `${d.died_in} / ${d.hunting}` : null), minDeaths);
    for (const [combo, cnt] of combos)
      findingsFor.push({ type: 'room+prey', label: combo, count: cnt,
        note: 'died in the same room hunting the same prey -- the safe spot in that room does not hold against that prey' });

    if (findingsFor.length) {
      findings.push({ name, totalDeaths: n, findings: findingsFor });
    }
  }
  return findings;
}

// ── args ─────────────────────────────────────────────────────────────────────
function parseWindow(s) {
  const m = String(s).match(/^(\d+)([hmd])$/);
  if (!m) return 24 * 3600 * 1000;
  const n = Number(m[1]);
  const unit = m[2] === 'h' ? 3600 * 1000 : m[2] === 'd' ? 86400 * 1000 : 60000;
  return n * unit;
}

// ── main (only when run directly, not imported) ──────────────────────────────
// pathToFileURL, not a hand-built `file://` template: the template leaves spaces
// percent-encoded on one side of the comparison and not the other, and needs drive-letter
// repair on Windows. Node owns this conversion. m59-path-test.mjs guards it.
const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  function arg(name, dflt) {
    const i = argv.indexOf('--' + name);
    if (i === -1) return dflt;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return dflt;
    return v;
  }
  const charFilter = arg('char', null);
  const minDeaths = Number(arg('min', 3));
  const windowStr = arg('window', '24h');
  const windowMs = parseWindow(windowStr);

  const { events } = readLedger({ sinceMs: windowMs });
  const deaths = events.filter(e => e.kind === 'died' && e.character);
  const filtered = charFilter ? deaths.filter(d => d.character === charFilter) : deaths;

  if (!filtered.length) {
    console.log(`No deaths in the last ${windowStr}.`);
    process.exit(0);
  }

  const findings = detectPatterns(filtered, minDeaths);

  console.log(`\nDeath patterns (last ${windowStr}, ${filtered.length} deaths, min ${minDeaths} to flag):`);
  console.log('─'.repeat(60));

  if (!findings.length) {
    console.log('  No repeating patterns at or above the threshold. Deaths are spread out.');
    process.exit(0);
  }

  for (const f of findings) {
    console.log(`\n${f.name}  (${f.totalDeaths} deaths in window)`);
    for (const p of f.findings) {
      console.log(`  ${p.count}x  ${p.type.padEnd(10)}  ${p.label}`);
      console.log(`       ${p.note}`);
    }
  }

  // The one number that matters: total deaths, and the share that are
  // "repeat offenders" (same character+room+prey). A high share means the
  // fleet is stuck in a death loop, not spreading the risk.
  const totalRoomPrey = filtered.reduce((t, d) => {
    const k = (d.died_in && d.hunting) ? `${d.character}|${d.died_in}|${d.hunting}` : null;
    if (!k) return t;
    t.set(k, (t.get(k) || 0) + 1);
    return t;
  }, new Map());
  const repeatDeaths = [...totalRoomPrey.values()].filter(n => n >= minDeaths).reduce((a, b) => a + b, 0);
  const pct = filtered.length ? Math.round(100 * repeatDeaths / filtered.length) : 0;
  console.log(`\n${repeatDeaths}/${filtered.length} deaths (${pct}%) are repeat offenders (same character+room+prey, ${minDeaths}+ times).`);
  if (pct >= 50) {
    console.log('  WARNING: more than half the deaths are concentrated in a few death loops.');
    console.log('  The fix is usually one of: re-spot the safe spot, switch prey, or level up.');
  }
}
