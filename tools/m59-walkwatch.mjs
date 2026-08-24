#!/usr/bin/env node
// WALK ONE CHARACTER SOMEWHERE, OUT LOUD, SO A PERSON CAN WATCH IT HAPPEN.
//
//   node tools/m59-walkwatch.mjs --agent lab01 --to 1016
//   node tools/m59-walkwatch.mjs --agent lab01 --to 1016 --cap 600 --every 2
//   node tools/m59-walkwatch.mjs --agent lab01 --where        # just say where it is
//
// WHY THIS EXISTS. Every instrument in this repository reports on the walk from inside the
// walk, and on this fault they have all agreed with each other and been wrong: the router
// returns a route, `moverStepLands` authorises every step of it, the bake marks the anchor
// reachable from the body, and the character does not arrive. Six measurement harnesses
// written in one day produced four confident wrong answers between them.
//
// So this one is deliberately thin. It walks, and it prints WHERE THE BODY IS on a clock,
// with the room resolved properly, and it prints every note the walk makes about itself.
// It decides nothing. The point is that a person can have a client open beside it and
// compare what the log claims with what the world shows.
//
// LOG IN AS SOMEBODY ELSE TO WATCH. Meridian allows one connection per character, so
// opening a client as the agent this is driving takes the character away from it. Use
// another character in the same room as the observer.
import { readFileSync } from 'node:fs';
import { Session } from './m59-session.mjs';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import './m59-navgeom.mjs';
import { resolveRoomNum } from './m59-route.mjs';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n);
                        return i > 0 ? process.argv[i + 1] : d; };
const has = n => process.argv.includes('--' + n);
const AGENT = arg('agent', 'lab01');
const TO    = arg('to', null) === null ? null : Number(arg('to'));
const CAP   = Number(arg('cap', 300)) * 1000;
const EVERY = Number(arg('every', 2)) * 1000;

const roster = JSON.parse(readFileSync(stateFileFor(fleetName()), 'utf8'));
const cred = (roster[AGENT] ?? roster.agents?.[AGENT])?.credentials;
if (!cred) { console.error(`no agent "${AGENT}" in ${stateFileFor(fleetName())}`); process.exit(1); }

const s = new Session(AGENT);
await s.join(cred);
await new Promise(r => setTimeout(r, 2500));
const c = s.client;
const map = loadMap(); attachStepMasks(map);

const room = () => {
  const nm = c.roomNameRsc ? (c.rsc?.get?.(c.roomNameRsc) ?? null) : null;
  return resolveRoomNum({ id: c.room?.id, num: c.room?.num, name: nm }, map);
};
const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (...a) => console.log(stamp(), ...a);

const pos = await s.confirmPosition().catch(() => null);
say(`${cred.character ?? AGENT} is in room ${room()} (${map.rooms[room()]?.name ?? '?'})` +
    `${pos ? ` at ${pos.col},${pos.row}` : ''}`);
if (has('where') || TO === null) { await s.leave?.().catch(() => {}); process.exit(0); }

// EVERY NOTE THE WALK MAKES, VERBATIM. These are the only account of what it thought it
// was doing, and the escape notes in particular are the difference between "it failed"
// and "it failed and here is what it tried".
s.note = (msg, detail) => say('   note:', msg, detail ? JSON.stringify(detail) : '');

say(`walking to ${TO} (${map.rooms[TO]?.name ?? '?'}), cap ${CAP / 1000}s\n`);
let last = '';
const tick = setInterval(async () => {
  const p = await s.confirmPosition().catch(() => null);
  const line = `room ${room()} at ${p ? `${p.col},${p.row}` : '?'}`;
  if (line !== last) { say('  ', line); last = line; }
}, EVERY);

const t0 = Date.now();
const r = await Promise.race([
  s.travelExclusive(TO, { maxHops: 12 }).catch(e => ({ arrived: false, reason: e.message })),
  new Promise(x => setTimeout(() => x({ arrived: false, reason: `capped at ${CAP / 1000}s` }), CAP)),
]);
clearInterval(tick);
const end = await s.confirmPosition().catch(() => null);
say(`\n${r?.arrived ? 'ARRIVED' : 'FAILED'} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
say(`  reason: ${r?.reason ?? '-'}`);
say(`  ended : room ${room()} (${map.rooms[room()]?.name ?? '?'})` +
    `${end ? ` at ${end.col},${end.row}` : ''}`);
if (r?.escapes?.length) say(`  escapes: ${JSON.stringify(r.escapes)}`);
await s.leave?.().catch(() => {});
process.exit(0);
