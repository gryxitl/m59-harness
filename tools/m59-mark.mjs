#!/usr/bin/env node
// A LINE IN THE LEDGER, SO A NUMBER CAN BE ATTRIBUTED TO A CONFIGURATION.
//
//   node tools/m59-mark.mjs "all five on the tick keeper, assigned 575"
//   node tools/m59-mark.mjs --since            # what has happened since the last mark
//   node tools/m59-mark.mjs --list             # every mark, newest first
//
// WHY THIS EXISTS. A day's kill/death ratio is the sum of every configuration the fleet
// ran that day, and there is no way to tell them apart afterwards. On 2026-08-26 JayB
// finished 56/38 across a day that included: the legacy mover, the tick keeper, a dozen
// movement fixes, two room reassignments and about thirty keeper restarts. The number is
// real and it answers nothing, because it cannot be split.
//
// So a mark writes down WHAT THE FLEET WAS when the clock started: every character's mode,
// assigned room, hunt brief and max health, plus the commit. `--since` then reports only
// the events after it. That turns "the fleet did 1.5:1 today" into "this configuration did
// N:M over H hours", which is a claim that can be checked.
//
// It records the CONFIGURATION, not an opinion about it. The note is free text for the
// human reason ("switched Gountrug to match Lee's brief"); everything else is read from the
// roster and the loadouts at the moment of writing, because a marker that says what
// somebody INTENDED is worth much less than one that says what was actually loaded.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { recordEvent, readLedger } from './m59-ledger.mjs';
import { resolveFleet } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// A mark is not about one character, and `recordEvent` needs one. `__MARK__` is the same
// sentinel convention the ledger already carries for `__DEATHPROBE__`, and every reader
// that groups by character ignores it for the same reason.
const MARK_CHARACTER = '__MARK__';
const MARK_KIND = 'config_mark';

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'],
                        { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { return null; }
}

// WHAT THE FLEET ACTUALLY IS, read rather than assumed. The loadout OVERRIDES the roster —
// a keeper applies it as a policy overlay on every load — so a mark that reported only the
// roster would record a setting the fleet is not running. Both are read and the effective
// value is the one written down.
export function fleetConfig() {
  const { label, stateFile } = resolveFleet();
  const out = { fleet: label, roster: stateFile, characters: [] };
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return out; }
  for (const [slot, entry] of Object.entries(state)) {
    const character = entry?.credentials?.character ?? entry?.character ?? null;
    const policy = entry?.autopilot?.policy ?? {};
    const row = { slot, character,
                  mode: entry?.autopilot?.mode ?? null,
                  assigned_room: policy.assignedRoom ?? null,
                  hunt: policy.hunt ?? null,
                  flee_below: policy.fleeBelow ?? null,
                  source: 'roster' };
    if (character) {
      const lo = join(ROOT, 'substrate', 'loadouts', `${character}.json`);
      if (existsSync(lo)) {
        try {
          const l = JSON.parse(readFileSync(lo, 'utf8'));
          const p = l.policy ?? {};
          if (p.assigned_room != null) { row.assigned_room = p.assigned_room; row.source = 'loadout'; }
          if (p.hunt != null) { row.hunt = p.hunt; row.source = 'loadout'; }
          const q = l.plan?.learning_queue ?? [];
          const tracks = [...new Set(q.map(e => e?.track).filter(Boolean))];
          if (tracks.length) row.tracks = tracks;
        } catch { /* a loadout that will not parse is not a reason to refuse the mark */ }
      }
    }
    out.characters.push(row);
  }
  return out;
}

function readMarks() {
  const { events } = readLedger({ sinceMs: 30 * 24 * 3600 * 1000 });
  return events.filter(e => e.kind === MARK_KIND).sort((a, b) => a.t - b.t);
}

function plant(note) {
  const config = fleetConfig();
  recordEvent(MARK_CHARACTER, MARK_KIND, { note: note || null, commit: gitHead(), config });
  console.log(`marked at ${new Date().toISOString()}${note ? ` — ${note}` : ''}`);
  console.log(`  commit ${config.commit ?? gitHead() ?? '?'}   fleet ${config.fleet}`);
  for (const c of config.characters) {
    if (!c.character) continue;
    console.log(`  ${String(c.character).padEnd(11)} ${String(c.mode ?? '-').padEnd(8)}`
      + ` room ${String(c.assigned_room ?? '-').padStart(4)}`
      + `  hunt ${String(c.hunt ?? '-').padEnd(12)}`
      + `${c.tracks ? ' [' + c.tracks.join(',') + ']' : ''}  (${c.source})`);
  }
  console.log('\nRun `node tools/m59-mark.mjs --since` to read only what happens from here.');
}

// Everything since the last mark, per character. Deliberately the same four kinds the
// hourly breakdowns use, so a since-report and a day-report can be compared directly.
function since() {
  const marks = readMarks();
  const last = marks[marks.length - 1];
  if (!last) {
    console.log('no mark has been planted yet — run `node tools/m59-mark.mjs "<what changed>"` first');
    process.exitCode = 1;
    return;
  }
  const ageMs = Date.now() - last.t;
  const { events } = readLedger({ sinceMs: Math.max(ageMs + 60_000, 60_000) });
  const KINDS = ['killed', 'died', 'level_up', 'level_lost'];
  const by = new Map();
  for (const e of events) {
    if (e.t < last.t || !KINDS.includes(e.kind) || !e.character) continue;
    if (e.character.startsWith('__')) continue;
    if (!by.has(e.character)) by.set(e.character, { killed: 0, died: 0, level_up: 0, level_lost: 0 });
    by.get(e.character)[e.kind]++;
  }
  const hours = ageMs / 3600_000;
  console.log(`since ${new Date(last.t).toISOString()} (${hours.toFixed(1)}h ago)`
    + `${last.note ? ` — ${last.note}` : ''}`);
  if (last.commit) console.log(`  at commit ${last.commit}`);
  console.log('');
  if (!by.size) { console.log('  nothing recorded yet'); return; }
  console.log('  character      kills deaths  ratio   lvl+ lvl-   kills/h');
  let tk = 0, td = 0;
  for (const [name, v] of [...by].sort((a, b) => b[1].killed - a[1].killed)) {
    tk += v.killed; td += v.died;
    const ratio = v.died ? (v.killed / v.died).toFixed(2) : (v.killed ? 'inf' : '-');
    console.log(`  ${name.padEnd(13)} ${String(v.killed).padStart(5)} ${String(v.died).padStart(6)}`
      + ` ${String(ratio).padStart(6)}   ${String(v.level_up).padStart(4)} ${String(v.level_lost).padStart(4)}`
      + `   ${(v.killed / Math.max(hours, 0.01)).toFixed(1)}`);
  }
  const ratio = td ? (tk / td).toFixed(2) : (tk ? 'inf' : '-');
  console.log(`  ${'FLEET'.padEnd(13)} ${String(tk).padStart(5)} ${String(td).padStart(6)} ${String(ratio).padStart(6)}`);
}

function list() {
  const marks = readMarks().reverse();
  if (!marks.length) { console.log('no marks recorded'); return; }
  for (const m of marks) {
    const tick = (m.config?.characters ?? []).filter(c => c.mode === 'tick').length;
    console.log(`${new Date(m.t).toISOString()}  ${m.commit ?? '???????'}  ${tick} on tick`
      + `${m.note ? `  — ${m.note}` : ''}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--since')) since();
  else if (args.includes('--list')) list();
  else plant(args.filter(a => !a.startsWith('--')).join(' '));
}
