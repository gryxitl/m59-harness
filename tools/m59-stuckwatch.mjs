// A STUCK CHARACTER SAYS SO, AND CAN SHOW YOU WHERE.
//
//   node tools/m59-stuckwatch.mjs --port 8971                  watch the shadow fleet
//   node tools/m59-stuckwatch.mjs --port 8971 --dry-run        decide, print, send nothing
//   node tools/m59-stuckwatch.mjs --port 8971 --every 15       poll interval, seconds
//   node tools/m59-stuckwatch.mjs --port 8971 --cooldown 3600  seconds between shouts
//
// THIS IS A TEST-SERVER BEHAVIOUR AND IT REFUSES TO RUN ANYWHERE ELSE. Broadcasting is free
// to the fleet and not to the twenty other people on a shared server, and the `show me` reply
// below uses the maintenance port, which is unauthenticated and must never be pointed at a
// real one. So this checks the roster's own endpoint and exits on anything that is not
// loopback. The `stuck` FLAG it reads is not test-only — that lives in the keeper and the
// fleet board, and is as useful in production as here. What stays here is the SHOUTING.
//
// WHY OUTSIDE THE KEEPER, like m59-lastwords.mjs. The keeper's survival ladder decides at one
// second and is the thing keeping a character alive; a `say` on the wire is one more thing
// that can throw inside a pass that must not throw. This watches from outside and cannot
// affect the ladder either way. If it dies, every character is exactly as safe as it was.
//
// ONCE AN HOUR, UNLESS IT GOT FREE FIRST. A character that is stuck stays stuck, and a
// message every fifteen seconds is not information, it is weather. The cooldown resets the
// moment the keeper reports it unstuck, so getting free and re-sticking is worth hearing
// about immediately — that is a different event from never having moved.
//
// AND `show me` IS THE HALF THAT MATTERS. Reading "I am stuck in Ukgoth" and then having to
// find Ukgoth, find the character, and find somewhere to stand is three minutes of work for a
// person who is already logged in. Tell a stuck character `show me` and this puts you on the
// nearest safe spot it believes can reach them.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { fleetName, stateFileFor, rosterGameEndpoint } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = n => argv.includes('--' + n);

if (has('help')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const PORT = Number(arg('port', 8971));
const FLEET = arg('fleet', null) ?? fleetName();
const EVERY = Number(arg('every', 15)) * 1000;
const COOLDOWN = Number(arg('cooldown', 3600)) * 1000;
const DRY = has('dry-run');
const STATE = join(REPO, 'substrate', `stuckwatch-${FLEET ?? 'default'}.json`);

// LOOPBACK OR NOTHING. See the note at the top: this shouts, and it teleports people with the
// maintenance port. Both are fine on a server nobody else is on and neither is fine anywhere
// else. The roster is the authority on which one this is.
const endpoint = (() => {
  try { return rosterGameEndpoint(stateFileFor(FLEET)); } catch { return null; }
})();
const host = String(endpoint?.host ?? '');
if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
  console.error(`refusing to run: fleet "${FLEET}" plays on ${host || '(unknown)'}, which is not loopback.`);
  console.error('This tool broadcasts and uses the maintenance port. Both belong on a test server only.');
  process.exit(1);
}

function call(name, args = {}, ms = 30000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' },
      agent: false, timeout: ms }, res => {
      let t = ''; res.setEncoding('utf8');
      res.on('data', c => { t += c; });
      res.on('end', () => {
        try {
          const text = JSON.parse(t)?.result?.content?.[0]?.text ?? t;
          if (typeof text === 'string' && text.startsWith('error: ')) return done({ _error: text.slice(7) });
          done(JSON.parse(text));
        } catch { done({ _error: 'unparseable' }); }
      });
    });
    req.on('error', e => done({ _error: e.message }));
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.end(body);
  });
}

const load = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { said: {}, seen: {} }; } };
// A DRY RUN DOES NOT SPEND THE COOLDOWN. The cooldown lives on disk so it survives a
// restart of this script; a rehearsal that wrote to it would silence the real run for the
// next hour, which turns "let me check what it would say" into an outage.
const save = s => { if (DRY) return;
  try { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 1)); } catch {} };

// What a stuck character says. Plain, and it names the room, because the room is the entire
// point of the message — "I am stuck" without a place is a noise, not a report.
const shout = (row) =>
  `I am stuck in ${row.room ?? 'somewhere'}${row.stuck?.why ? ` — ${row.stuck.why}` : ''}` +
  `${row.stuck?.seconds ? `, ${Math.round(row.stuck.seconds / 60)} minute(s) now` : ''}. ` +
  `Tell me "show me" and I will bring you here.`;

// THE NEAREST SAFE SPOT THAT CAN REACH THEM, which is not the same as the nearest square.
// Standing a person on top of a stuck character teaches nothing — the interesting thing is
// usually the geometry AROUND them — and standing them somewhere that cannot path to the
// character is worse than useless. `safe_spots` already answers this for the room, and the
// keeper that owns the body is the one that can say whether a square is reachable from where
// it stands.
async function bringThemHere(watcher, stuckRow) {
  const spots = await call('safe_spots', { agent: stuckRow.agent });
  const best = (spots?.spots ?? [])[0] ?? null;
  const room = Number(stuckRow.room_num);
  const dm = await import('./m59-dm.mjs');
  const where = best ? { row: best.row, col: best.col } : {};
  const r = await dm.relocate([watcher], room, { ...where, verify: true }).catch(e => ({ error: e.message }));
  return { room, spot: best ? `${best.row},${best.col}` : '(the room, no safe spot offered)', result: r };
}

console.log(`stuck watch on ${FLEET} (port ${PORT}, loopback ${host}) — ` +
            `poll ${EVERY / 1000}s, one shout per ${COOLDOWN / 1000}s${DRY ? ', DRY RUN' : ''}`);

// SEEN LINES, NOT A CURSOR. `chat`'s `since` is ONE number applied to every character, and
// the sequences are PER CHARACTER — so the highest seq in a batch is a cursor that silently
// skips everything a quieter character says. Twenty ids is cheap; a dropped `show me` is not.
const answered = new Set();

// LOADED ONCE, NOT PER TICK. Re-reading the file every poll meant a dry run — which
// deliberately never writes — reloaded an empty cooldown and re-shouted every fifteen
// seconds, so the one rehearsal that is meant to show the rate could not show it. Same
// mistake, and the same fix, as m59-lastwords.mjs.
const state = load();

async function tick() {
  const f = await call('fleet', {});
  if (!f?.fleet) return;
  const now = Date.now();

  for (const row of f.fleet) {
    const key = row.agent;
    const isStuck = !!row.stuck;
    const was = state.seen[key] ?? false;
    // GETTING FREE RESETS THE CLOCK. A character that unsticks and sticks again is news.
    if (was && !isStuck) { delete state.said[key]; }
    state.seen[key] = isStuck;
    if (!isStuck) continue;
    const said = state.said[key] ?? 0;
    if (now - said < COOLDOWN) continue;
    const line = shout(row);
    console.log(`${new Date().toISOString().slice(11, 19)}  ${row.character}: ${line}`);
    if (!DRY) await call('say', { agent: row.agent, text: line, type: 'broadcast' }, 20000);
    state.said[key] = now;
  }

  // `show me`, AND ONLY AS A TELL. A tell reaches exactly one character, so the line names
  // who is being asked. Every other channel reaches the room or the world, which means a
  // `show me` said out loud would match on twenty rows at once and teleport somebody twenty
  // times. Channel `dm` is the tell.
  const chat = await call('chat', { limit: 60, include_self: false, channels: ['dm'] });
  for (const m of chat?.messages ?? []) {
    const id = `${m.agent}:${m.seq}`;
    if (answered.has(id)) continue;
    answered.add(id);
    if (answered.size > 4000) for (const k of [...answered].slice(0, 2000)) answered.delete(k);
    if (!/show\s*me/i.test(String(m.text ?? ''))) continue;
    const row = (f.fleet ?? []).find(c => c.agent === m.agent);
    const who = String(m.name ?? '').trim();
    if (!row || !who) continue;
    if (!row.stuck) {
      console.log(`  "show me" from ${who} to ${row.character}, who is not stuck`);
      if (!DRY) await call('say', { agent: row.agent, type: 'tell', to: who,
                                    text: 'I am not stuck — nothing to show.' });
      continue;
    }
    console.log(`  "show me" from ${who} -> bringing them to ${row.character} in ${row.room}`);
    if (DRY) continue;
    const out = await bringThemHere(who, row);
    await call('say', { agent: row.agent, type: 'tell', to: who,
                        text: out.result?.error
                          ? `I could not bring you: ${out.result.error}. I am in ${row.room ?? '?'}.`
                          : `You are on ${out.spot} in ${row.room ?? 'this room'}. I am stuck here.` });
  }

  save(state);
}

for (;;) {
  await tick().catch(e => console.error('tick failed:', e.message));
  await new Promise(r => setTimeout(r, EVERY));
}
