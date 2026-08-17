#!/usr/bin/env node
// WALK CHARACTERS ROUND AND ROUND A CLOSED LOOP, FOR AS LONG AS YOU LIKE.
//
//   node tools/m59-patrol.mjs --agents arena1,arena2 --room 60 --centre 13,13 --radius 9
//   node tools/m59-patrol.mjs --agents arena1 --waypoints 8,8 8,18 18,18 18,8
//   node tools/m59-patrol.mjs --agents arena1,arena2,arena3 --radius 9 --laps 3
//
// A test bed needs characters that are DOING something ordinary while the thing under
// test happens around them — moving targets, bodies in the way, a room that is not
// static. The keeper cannot provide that: `survive` stands still by design and `farm`
// goes where the prey is. This is the missing verb, and it is deliberately stupid —
// it walks a ring and nothing else.
//
// THE KEEPER IS STOPPED FIRST, AND THAT IS NOT OPTIONAL. Both would be steering the
// same character a step at a time, so the character would stutter between two
// intentions and neither would look broken. `--keep-keeper` exists for when you want
// exactly that fight, and for nothing else.
//
// STAGGERED BY DEFAULT. Handing every character the same first waypoint puts the whole
// group in a queue walking single file to one square, which is not a patrol, it is a
// crowd. Each starts a whole segment further round the ring, so N characters end up
// evenly spaced on it from the first step.
//
// WHERE A CHARACTER MAY STAND IS THE ROOM'S BUSINESS, NOT OURS. The Arena of Kraanan
// pushes non-combatants back out of its playing field (`tosarena.kod` declares the
// boundaries as 6..20), so a ring drawn at radius 6 around the centre is walked at the
// edge and silently corrected every lap. That is why a lap that never reaches its
// waypoints is REPORTED rather than retried for ever: a ring nobody is allowed to walk
// looks exactly like a slow one.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_BROKER = Number(process.env.M59_BROKER_PORT || 8901);

// ------------------------------------------------------------------ broker rpc

export async function rpc(port, name, args, timeoutMs = 120000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
                                params: { name, arguments: args } });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctl.signal });
  } finally { clearTimeout(t); }
  const j = await res.json();
  if (j.error) throw new Error(`${name}: ${j.error.message}`);
  const text = j.result?.content?.[0]?.text ?? '';
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (j.result?.isError) throw new Error(`${name}: ${String(text).slice(0, 300)}`);
  return parsed;
}

// ------------------------------------------------------------------ the ring
//
// Pure, so the shape of a patrol can be argued about without a server. Squares are the
// kod grid — 1-based, integral — so the circle is rounded onto it and any duplicate
// that rounding produces is dropped: two identical consecutive waypoints are a step
// that never moves, and a ring made of those spins on the spot.

export function ring({ centre = [13, 13], radius = 9, points = 8, rows = null, cols = null } = {}) {
  const [cc, cr] = centre;
  const out = [];
  for (let i = 0; i < points; i++) {
    const a = (2 * Math.PI * i) / points;
    let col = Math.round(cc + radius * Math.cos(a));
    let row = Math.round(cr + radius * Math.sin(a));
    col = Math.max(1, Math.min(cols || 1e9, col));
    row = Math.max(1, Math.min(rows || 1e9, row));
    const last = out[out.length - 1];
    if (last && last[0] === col && last[1] === row) continue;
    out.push([col, row]);
  }
  // The seam too: the last waypoint leads back to the first, so a duplicate there is
  // the same standing-still step at the point where nobody is looking for it.
  if (out.length > 1) {
    const a = out[0], z = out[out.length - 1];
    if (a[0] === z[0] && a[1] === z[1]) out.pop();
  }
  return out;
}

// Each character starts a segment further round, so they spread out from the first step
// instead of queueing up to reach waypoint one. A plain rotation: the ring is a cycle,
// so walking it from a different starting index is the same patrol, phase-shifted.
export const phased = (waypoints, i) =>
  waypoints.map((_, k) => waypoints[(k + i) % waypoints.length]);

// ------------------------------------------------------------------ driving

export async function patrol({
  port, agents, waypoints, laps = Infinity, keepKeeper = false, fine = false,
  onStep = () => {}, stop = { now: false },
}) {
  const report = {};
  for (const a of agents) report[a] = { laps: 0, steps: 0, missed: 0, last: null };

  if (!keepKeeper) {
    for (const a of agents) {
      // `hard` ends the keeper rather than leaving it inert, because an inert keeper
      // still owns the character and takes it back at its next heartbeat.
      await rpc(port, 'autopilot', { agent: a, action: 'stop', hard: true,
                                     why: 'patrol is driving this character' })
        .catch(e => { report[a].keeper_stop = e.message; });
    }
  }

  const runOne = async (agent, index) => {
    const mine = phased(waypoints, index);
    for (let lap = 0; lap < laps && !stop.now; lap++) {
      for (const [col, row] of mine) {
        if (stop.now) break;
        try {
          const r = await rpc(port, 'walk_to', { agent, col, row, fine, max_steps: 60 });
          report[agent].steps++;
          report[agent].last = { col, row, arrived: !!r.arrived };
          if (!r.arrived) report[agent].missed++;
          onStep(agent, col, row, r);
        } catch (e) {
          report[agent].missed++;
          report[agent].last = { col, row, error: e.message };
          onStep(agent, col, row, { arrived: false, reason: e.message });
        }
      }
      report[agent].laps++;
    }
  };

  await Promise.all(agents.map(runOne));
  return report;
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v.startsWith('--')) {
      const k = v.slice(2);
      const vals = [];
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) vals.push(argv[++i]);
      a[k] = vals.length === 0 ? true : vals.length === 1 ? vals[0] : vals;
    } else a._.push(v);
  }
  return a;
}

const pair = s => String(s).split(',').map(Number);

async function main(argv) {
  const a = parseArgs(argv);
  if (a.help || !a.agents) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').filter(l => l.startsWith('//')).slice(0, 8).join('\n'));
    return a.agents ? 0 : 2;
  }

  const port = Number(a.broker || DEFAULT_BROKER);
  const agents = String(a.agents).split(',').map(s => s.trim()).filter(Boolean);

  let waypoints;
  if (a.waypoints) {
    waypoints = (Array.isArray(a.waypoints) ? a.waypoints : [a.waypoints]).map(pair);
  } else {
    let rows = null, cols = null;
    if (a.room) {
      try {
        const map = JSON.parse(readFileSync(
          new URL('../substrate/m59-map.json', import.meta.url), 'utf8')).rooms[String(a.room)];
        rows = map?.rows ?? null; cols = map?.cols ?? null;
      } catch { /* geometry is a nicety; the server is the authority either way */ }
    }
    waypoints = ring({
      centre: a.centre ? pair(a.centre) : [13, 13],
      radius: Number(a.radius ?? 9),
      points: Number(a.points ?? 8),
      rows, cols,
    });
  }

  const laps = a.laps ? Number(a.laps) : Infinity;
  const stop = { now: false };
  const bye = () => { stop.now = true; };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);

  console.log(`patrol: ${agents.length} character(s), ${waypoints.length} waypoints, ` +
              `${laps === Infinity ? 'until stopped' : laps + ' lap(s)'}`);
  console.log(`  ring: ${waypoints.map(([c, r]) => `${c},${r}`).join(' -> ')}`);

  const report = await patrol({
    port, agents, waypoints, laps, keepKeeper: a['keep-keeper'] !== undefined,
    fine: a.fine !== undefined, stop,
    onStep: (agent, col, row, r) =>
      process.stdout.write(`${agent} -> ${col},${row} ${r.arrived ? 'ok' : 'MISSED'}\n`),
  });

  console.log('\n' + JSON.stringify(report, null, 2));
  // A patrol where nobody ever reaches a waypoint is a ring the room will not let them
  // walk, and that is worth an exit code rather than a wall of "MISSED".
  const anyArrived = Object.values(report).some(r => r.steps > r.missed);
  if (!anyArrived) {
    console.error('\nNOT ONE waypoint was reached. The room is probably refusing these squares — ' +
                  'the Arena of Kraanan pushes non-combatants out of its 6..20 playing field, ' +
                  'so try a wider radius, or make them combatants first.');
    return 1;
  }
  return 0;
}

const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(e => {
    console.error(e.message); process.exit(1);
  });
}
