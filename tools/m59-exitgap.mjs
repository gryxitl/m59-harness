#!/usr/bin/env node
// WHERE THE COLLISION MODEL SAYS "NO WAY OUT" AND A CHARACTER WALKS OUT ANYWAY.
//
//   node tools/m59-exitgap.mjs                 every gap, worst first
//   node tools/m59-exitgap.mjs --delta         ONLY the believed-vs-actual offsets
//   node tools/m59-exitgap.mjs --roo 150       draw room 150 with both marked
//   node tools/m59-exitgap.mjs --clear
//
// THE PROBLEM THIS INSTRUMENTS. The baked collision model refuses any move it cannot
// prove legal, which is right — the server accepts whatever coordinates you send and the
// stock client is what enforces collision. But the model is incomplete at some doorways:
// Cor Noth room 150 west publishes SIX boundary crossings and ZERO grounded approaches,
// so the model believes there is nowhere to stand to use a door that real players walk
// through every day. Ten of twenty-one characters could not reach a bank because of it.
//
// A refusal on its own is not a bug report. What makes one is the PAIR:
//
//   believed — the closest square to that exit the model thought could be stood on,
//              or null when it offered nothing at all;
//   actual   — the square the character was standing on when the exit ACTUALLY worked.
//
// One pair is an anecdote. A hundred pairs with the same `delta` is a coordinate bug, and
// a hundred pairs with scattered deltas is a modelling gap at specific doorways. Those
// need completely different fixes, and nothing else in the harness can tell them apart —
// which is the whole reason this file exists rather than a counter.
//
// `--delta` is the question "are we off by one somewhere" asked of the data instead of of
// the source. A systematic (+1,+1) would show as one row with every sighting in it.
//
// KEYED ON ROOM AND DIRECTION, because that is what a fix is about. Not on the character:
// twenty-one characters failing at one doorway is one gap, and filing it twenty-one times
// would make the rarest and most interesting doorway look like the least important.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
export const EXITGAP_FILE = () => process.env.M59_EXITGAP_FILE ||
  join(REPO, 'substrate', 'exit-gaps.json');

const key = (room, dir) => `${room}:${String(dir ?? '?').toLowerCase()}`;

function readAll() {
  try {
    const raw = JSON.parse(readFileSync(EXITGAP_FILE(), 'utf8'));
    return (raw && typeof raw === 'object' && raw.gaps) ? raw.gaps : {};
  } catch { return {}; }
}

function writeAll(gaps) {
  try {
    mkdirSync(dirname(EXITGAP_FILE()), { recursive: true });
    writeFileSync(EXITGAP_FILE(), JSON.stringify({ format: 'm59-exit-gaps/1', gaps }, null, 1));
    return true;
  } catch { return false; }
}

let cache = { mtime: -1, value: {} };
function current() {
  let mtime = 0;
  try { mtime = existsSync(EXITGAP_FILE()) ? statSync(EXITGAP_FILE()).mtimeMs : 0; } catch { mtime = 0; }
  if (cache.mtime !== mtime) cache = { mtime, value: readAll() };
  return cache.value;
}

/**
 * The model could not offer a way out of this room in this direction.
 *
 * Recorded even when nothing is standing anywhere useful yet, because "the model offered
 * nothing at all" and "the model offered squares that all refused" are different gaps and
 * only the first one implicates the approach search.
 */
export function noteRefused(room, direction, {
  believed = null, crossings = 0, approaches = 0, tried = [], at = Date.now(),
} = {}) {
  const gaps = readAll();
  const k = key(room, direction);
  const row = gaps[k] ?? { room, direction: String(direction ?? '?').toLowerCase(),
                           refused: 0, escaped: 0, first: at, at,
                           crossings, approaches, believed: null, actual: [], deltas: {} };
  row.refused++;
  row.at = at;
  row.crossings = crossings;
  row.approaches = approaches;
  if (believed) row.believed = { col: believed.col, row: believed.row };
  if (tried.length) row.tried = tried.slice(0, 8);
  gaps[k] = row;
  writeAll(gaps);
  cache = { mtime: -1, value: gaps };
  return row;
}

/**
 * A character DID get out — this is the square it was standing on when that happened.
 *
 * The delta against `believed` is the payload. It is recorded per distinct offset rather
 * than averaged: a mean of two different modelling gaps is a number describing neither,
 * and the thing we are looking for is whether one offset accounts for all of them.
 */
export function noteEscaped(room, direction, actual, { at = Date.now() } = {}) {
  if (!actual || !Number.isInteger(actual.col) || !Number.isInteger(actual.row)) return null;
  const gaps = readAll();
  const k = key(room, direction);
  const row = gaps[k] ?? { room, direction: String(direction ?? '?').toLowerCase(),
                           refused: 0, escaped: 0, first: at, at,
                           crossings: 0, approaches: 0, believed: null, actual: [], deltas: {} };
  row.escaped++;
  row.at = at;
  const seen = (row.actual ??= []);
  if (!seen.some(s => s.col === actual.col && s.row === actual.row)) {
    seen.push({ col: actual.col, row: actual.row });
    if (seen.length > 16) seen.shift();
  }
  if (row.believed) {
    const d = `${actual.col - row.believed.col},${actual.row - row.believed.row}`;
    row.deltas = row.deltas ?? {};
    row.deltas[d] = (row.deltas[d] ?? 0) + 1;
  }
  gaps[k] = row;
  writeAll(gaps);
  cache = { mtime: -1, value: gaps };
  return row;
}

/**
 * Record an escape ONLY where this doorway has already been seen to come up short.
 *
 * A door that has always worked is not a gap, and filing every successful exit in the
 * world would bury the handful that matter under tens of thousands of rows a day.
 */
export function noteEscapedIfKnown(room, direction, actual) {
  if (!current()[key(room, direction)]) return null;
  return noteEscaped(room, direction, actual);
}

export const allGaps = () => Object.values(current())
  .sort((a, b) => (b.refused + b.escaped) - (a.refused + a.escaped));

/**
 * Every believed-vs-actual offset seen anywhere, most common first.
 *
 * ONE ROW MEANS A COORDINATE BUG. Many rows mean the approach search is incomplete at
 * particular doorways. That is the whole question, and this is the shape that answers it.
 */
export function deltaSummary() {
  const totals = new Map();
  for (const g of Object.values(current())) {
    for (const [d, n] of Object.entries(g.deltas ?? {})) {
      const row = totals.get(d) ?? { delta: d, sightings: 0, rooms: new Set() };
      row.sightings += n;
      row.rooms.add(`${g.room}:${g.direction}`);
      totals.set(d, row);
    }
  }
  return [...totals.values()]
    .map(r => ({ delta: r.delta, sightings: r.sightings, places: [...r.rooms] }))
    .sort((a, b) => b.sightings - a.sightings);
}

export function clearAll() { writeAll({}); cache = { mtime: -1, value: {} }; return true; }

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = n => argv.includes(n);
  const val = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

  if (flag('--clear')) { clearAll(); console.log('cleared'); }
  else if (flag('--delta')) {
    const rows = deltaSummary();
    if (!rows.length) console.log('no believed-vs-actual pairs recorded yet');
    else {
      console.log('believed -> actual offsets, most seen first\n');
      console.log(`${'delta (col,row)'.padEnd(18)}${'sightings'.padStart(10)}  where`);
      for (const r of rows)
        console.log(`${r.delta.padEnd(18)}${String(r.sightings).padStart(10)}  ` +
                    `${r.places.slice(0, 5).join(' ')}${r.places.length > 5 ? ' …' : ''}`);
      console.log('\nONE row covering everything is a coordinate bug — a systematic offset.');
      console.log('MANY rows are modelling gaps at particular doorways, which is a different fix.');
    }
  } else if (val('--roo')) {
    // Draw the room with both squares marked, because a picture is the only way to see
    // whether the gap is "one square out" or "the wrong side of a wall".
    const num = Number(val('--roo'));
    const M = await import('./m59-map.mjs');
    const P = await import('./m59-map-path.mjs');
    const R = await import('./m59-roo.mjs');
    const map = M.loadMap(P.movementMapFile());
    const room = map.rooms[num] ?? map.rooms[String(num)];
    if (!room?.roo) { console.error(`no baked geometry for room ${num}`); process.exit(1); }
    const g = R.sharedRoomGeometry(room);
    const marks = [];
    for (const gap of allGaps().filter(x => Number(x.room) === num)) {
      if (gap.believed) marks.push({ ...gap.believed, ch: 'B' });
      for (const a of (gap.actual ?? [])) marks.push({ ...a, ch: 'A' });
    }
    console.log(`room ${num} — ${room.name}   B = believed takeable, A = actually worked\n`);
    console.log(g.renderWalls ? g.renderWalls({ marks }) : '(this geometry cannot be drawn)');
  } else {
    const rows = allGaps();
    if (!rows.length) console.log('no exit gaps recorded — the collision model has not been caught short');
    else {
      console.log(`${rows.length} exit(s) where the model and the world disagree\n`);
      console.log(`${'room:dir'.padEnd(14)}${'refused'.padStart(8)}${'escaped'.padStart(8)}` +
                  `${'cross'.padStart(7)}${'appr'.padStart(6)}  believed -> actual`);
      for (const g of rows) {
        const b = g.believed ? `${g.believed.col},${g.believed.row}` : 'none offered';
        const a = (g.actual ?? []).slice(0, 3).map(s => `${s.col},${s.row}`).join(' ') || '—';
        console.log(`${(g.room + ':' + g.direction).padEnd(14)}${String(g.refused).padStart(8)}` +
                    `${String(g.escaped).padStart(8)}${String(g.crossings).padStart(7)}` +
                    `${String(g.approaches).padStart(6)}  ${b} -> ${a}`);
      }
      console.log('\n`--delta` aggregates the offsets; `--roo <room>` draws one.');
      console.log('crossings with ZERO approaches is the model finding a door and no way to stand at it.');
    }
  }
}
