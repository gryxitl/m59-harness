#!/usr/bin/env node
// WHICH CHARACTERS ARE LOSING MOVES TO THEIR OWN THROTTLE, AND HOW FAST?
//
//   node tools/m59-move-drops.mjs              every live keeper, one line each
//   node tools/m59-move-drops.mjs --agent t3   one character
//   node tools/m59-move-drops.mjs --json       machine-readable
//   node tools/m59-move-drops.mjs --since 60   only drops from the last 60s
//
// The client drops a UserMove that arrives inside the 1000ms server cadence window. It has
// counted those drops since the window was added and nothing ever read the number. That
// is not a cosmetic gap: a drop is a movement command the character decided to take and
// never sent, and a mover that is stuck re-fires every tick, so a character can spend its
// whole life planning moves that die in its own throttle while every external signal —
// in game, keeper alive, broker healthy, mover heartbeating — says it is fine.
//
// The count alone is not actionable, which is a big part of why it went unread. Ten drops
// over a week in a town square is nothing. Ten in the last four seconds is a character
// that cannot move and is screaming into a counter nobody watches. So this prints a RATE
// over an explicit window, and the window it was measured over, and it says which.
//
// A drop is NOT a refusal, and the difference matters when reading the numbers: a drop
// never reached the wire (our throttle swallowed it), a refusal went out and the server
// said no. A character can be dying of either and look identical from outside.
//
// Read-only. It asks each keeper for a number and prints it.

import { argv, env, stdout } from 'node:process';

const KEEPER_PORT_BASE = Number(env.M59_KEEPER_PORT_BASE || 8911);
const KEEPER_PORTS = Number(env.M59_KEEPER_PORTS || 32);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const flag = (n) => argv.includes(`--${n}`);
const ONLY = arg('agent');
const SINCE_MS = arg('since') != null ? Number(arg('since')) * 1000 : null;
const JSON_OUT = flag('json');

async function get(port, path, ms = 2500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Every keeper answers /health with its own agent name, so the port scan is
// self-identifying: no roster file to read, no assumption that index order survived a
// restart, and a keeper that is down is simply absent rather than guessed at.
async function scan() {
  const ports = ONLY != null ? null : Array.from({ length: KEEPER_PORTS }, (_, i) => KEEPER_PORT_BASE + i);
  const found = [];
  const probe = async (port) => {
    const h = await get(port, '/health');
    if (!h || h.agent == null) return null;
    const d = await get(port, '/move-drops');
    return { port, agent: h.agent, in_game: !!h.ok, drops: d };
  };
  if (ports == null) {
    // One agent: we still have to find which port it is on.
    const all = await Promise.all(Array.from({ length: KEEPER_PORTS }, (_, i) => get(KEEPER_PORT_BASE + i, '/health')));
    for (let i = 0; i < all.length; i++) {
      const h = all[i];
      if (!h || h.agent !== ONLY) continue;
      const port = KEEPER_PORT_BASE + i;
      found.push({ port, agent: h.agent, in_game: !!h.ok, drops: await get(port, '/move-drops') });
    }
    return found;
  }
  const all = await Promise.all(ports.map(probe));
  return all.filter(Boolean);
}

const fmt = (n, d = 3) => n == null ? 'n/a' : String(Number(n.toFixed(d)));
const ago = (ms) => ms == null ? 'never' : ms < 1000 ? `${Math.round(ms)}ms`
  : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`;

const rows = await scan();

if (JSON_OUT) {
  stdout.write(JSON.stringify(rows.map(r => ({
    agent: r.agent, port: r.port, in_game: r.in_game, ...(r.drops ?? { error: 'no /move-drops' }),
  })), null, 2) + '\n');
  process.exit(0);
}

if (!rows.length) {
  console.log(ONLY != null
    ? `no keeper answering for "${ONLY}" on ports ${KEEPER_PORT_BASE}-${KEEPER_PORT_BASE + KEEPER_PORTS - 1}`
    : `no keepers answering on ports ${KEEPER_PORT_BASE}-${KEEPER_PORT_BASE + KEEPER_PORTS - 1} — is the broker up?`);
  process.exit(ONLY != null ? 1 : 0);
}

// "How many drops did we lose RECENTLY" is the question a person actually asks, and the
// counter is monotonic since the keeper started. Report both and label them, because
// reading a lifetime total as if it were the last minute is how you chase a number that
// has not moved in days.
let anyRecent = false;
for (const r of rows) {
  const d = r.drops;
  if (!d) { console.log(`${r.agent.padEnd(10)} port ${r.port}  no /move-drops (keeper predates this tool)`); continue; }
  const recent = SINCE_MS != null
    ? (d.last_drop_ms_ago != null && d.last_drop_ms_ago <= SINCE_MS ? d.dropped : 0)
    : d.dropped;
  if (recent > 0) anyRecent = true;
  const line = [
    r.agent.padEnd(10),
    r.in_game ? 'in game ' : 'OUT     ',
    `drops ${String(d.dropped).padStart(5)}`,
    `rate ${fmt(d.rate_per_sec)}/s over ${ago(d.window_ms)}`,
    `last drop ${ago(d.last_drop_ms_ago).padStart(7)}`,
    `throttle ${d.throttle_ms}ms`,
  ];
  if (SINCE_MS != null) line.push(`in last ${SINCE_MS / 1000}s: ${recent}`);
  console.log(line.join('  '));
}

const total = rows.reduce((a, r) => a + (r.drops?.dropped ?? 0), 0);
const live = rows.filter(r => r.in_game).length;
console.log(`\n${rows.length} keeper(s), ${live} in game, ${total} UserMoves dropped in total`
  + (rows.some(r => r.drops?.recent_rate_per_sec != null && r.drops.recent_rate_per_sec > 0.5)
    ? ' — at least one is dropping faster than every 2s NOW' : ''));
if (SINCE_MS != null && !anyRecent) console.log(`(nothing dropped in the last ${SINCE_MS / 1000}s)`);
