#!/usr/bin/env node
// m59-move-probe.mjs -- WHAT DOES THE SERVER ACTUALLY DO WITH A MOVE?
//
//   node tools/m59-move-probe.mjs --agent t3 --moves 120 --i-mean-it
//   node tools/m59-move-probe.mjs --agent t3 --moves 60 --settle 500 --i-mean-it
//
// tools/m59-motion-probe.mjs compares two LOCAL collision models -- moverStepLands and
// traceFineMoveClient -- to each other. Both are our code. Neither can say what the
// SERVER does, and the server is the only authority on whether a move lands.
//
// This is the missing measurement. It sends real moves on a real character and records
// whether the PUSHED position changed, tagged with what each local model predicted. It
// produces the two numbers the whole motion-planning design turns on:
//
//   FALSE CONFIDENCE -- the server refused a move a model approved. This is the one that
//                       strands a character: the planner believes the route and the
//                       character stands still re-sending it. JayB at the fence.
//   FALSE CAUTION    -- the server accepted a move a model rejected. This is the one that
//                       makes good routes look impossible and sends characters the long
//                       way round, or nowhere.
//
// IT DELIBERATELY SENDS MOVES THE MODEL REJECTS. That is the only way to measure false
// caution: a probe that only tries what the model likes can never discover the model is
// too strict. Those are the interesting half.
//
// SAFE BY CONSTRUCTION: single squares from where the character already stands, no
// fighting, no travel, no purchases. It walks a character a short distance around one
// room and puts nothing else at risk.
//
// IT OPENS ITS OWN CONNECTION and so bumps a broker holding this character.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { Session } from './m59-session.mjs';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { sharedRoomGeometry, KOD_FINENESS, protocolToClient } from './m59-roo.mjs';
import { resolveRoomNum } from './tick/m59-route.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);

const FLEET  = fleetName(argv) || null;
const AGENT  = arg('agent', 't3');
const MOVES  = Number(arg('moves', 100));
const SETTLE = Number(arg('settle', 600));
const OUT    = arg('out', 'substrate/move-probe.json');
const FORCE  = flag('i-mean-it');
const LOOPBACK = /^(127\.0\.0\.1|::1|localhost)$/i;
const K = KOD_FINENESS ?? 64;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function roster() {
  const p = stateFileFor(FLEET);
  if (!existsSync(p)) throw new Error(`no roster at ${p}`);
  return { path: p, data: JSON.parse(readFileSync(p, 'utf8')) };
}

async function main() {
  const { path, data } = roster();
  const entry = data[AGENT] ?? data.agents?.[AGENT];
  if (!entry) throw new Error(`no agent "${AGENT}" in ${path}`);
  const cred = entry.credentials ?? entry;
  if (!LOOPBACK.test(String(cred.host)) && !FORCE)
    throw new Error(`refusing to drive ${AGENT} on ${cred.host}. Pass --i-mean-it.`);

  const map = loadMap();
  attachStepMasks(map);

  const session = new Session(AGENT);
  await session.join({ account: cred.account, password: cred.password,
                       character: cred.character, host: cred.host, port: Number(cred.port) });
  const c = session.client;
  await sleep(2500);
  // STAND UP FIRST. A sitting character is refused every move with no reply at all
  // (PFLAG_NO_MOVE), which is indistinguishable from a collision refusal from out here --
  // and it is why the first two runs of this probe reported 120/120 "did not move" while
  // both models said the step was fine. "Did not move" is not always about geometry.
  await session.pacer.submit('stand', () => c.stand()).catch(() => {});
  await sleep(700);
  console.log(`in game as ${c.me?.name}  room ${c.room?.id}  ${MOVES} moves, ${SETTLE}ms settle\n`);

  const rows = [];
  for (let i = 0; i < MOVES; i++) {
    // A SITTING CHARACTER IS REFUSED EVERY MOVE WITH NO REPLY (PFLAG_NO_MOVE), which
    // from out here is indistinguishable from a collision refusal. Stand periodically so
    // a nap in the middle of the run cannot masquerade as a wall.
    if (i % 25 === 0) { await session.pacer.submit('stand', () => c.stand()).catch(() => {}); await sleep(400); }
    const me = c.self;
    if (!me) { await sleep(SETTLE); continue; }
    // THE LIVE ROOM ID IS NOT A MAP NUMBER and the two namespaces overlap silently:
    // JayB stands in "Raza" reporting id 2013, which is a real map room called "The East
    // Tower". Using the raw id here evaluated every prediction against ANOTHER ROOM'S
    // GEOMETRY -- which is why the first run of this probe reported 120/120 "lands" and
    // 120/120 did not move. Resolve by evidence: objId table, then name, then the number.
    const roomName = c.roomNameRsc ? (c.rsc?.get?.(c.roomNameRsc) ?? null) : null;
    const roomNum = resolveRoomNum({ id: c.room?.id, num: c.room?.num, name: roomName }, map);
    const geo = sharedRoomGeometry(map.rooms[roomNum]);
    if (!geo?.collisionReady) { console.log('no geometry for this room; stopping'); break; }

    // One square in one of the eight directions, chosen at random -- INCLUDING ones the
    // model rejects, because those are the only way to see false caution.
    const dirs = [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]];
    const [dr, dc] = dirs[Math.floor(Math.random() * dirs.length)];
    const tr = me.row + dr, tc = me.col + dc;
    if (!geo.inBounds(tr, tc)) continue;

    // WHAT EACH LOCAL MODEL PREDICTS, recorded BEFORE the move so it cannot be
    // rationalised afterwards.
    const saysLands = geo.moverStepLands(me.row, me.col, tr, tc);
    const target = { x: tc * K + (K >> 1), y: tr * K + (K >> 1) };
    let traceArrives = null;
    try {
      const t = geo.traceFineMoveClient(protocolToClient(me.x), protocolToClient(me.y),
                                        protocolToClient(target.x), protocolToClient(target.y),
                                        { slide: false });
      traceArrives = !!t?.arrived;
    } catch { traceArrives = null; }

    const before = { x: me.x, y: me.y, col: me.col, row: me.row };
    // SEND, THEN ASK. Measured 2026-08-20: the server does NOT push our own position --
    // three consecutive landed moves produced zero events and left `client.self`
    // unchanged until confirmPosition() read the room. An earlier version of this probe
    // waited for a `moved` event and recorded 120/120 "did not move" for moves that had
    // all landed. The only way to know where we are is to ask.
    let sendThrew = null;
    try {
      await session.pacer.submit('move',
        () => c.moveTo(target.x, target.y, 18, c.room.id));
    } catch (e) { sendThrew = e?.message ?? String(e); }
    // WAIT FOR THE WALK TO FINISH, DO NOT GUESS AT IT. A move is not instantaneous: the
    // server walks the body at `speed`, so a fixed 350ms settle read the position
    // mid-stride and every sample landed on the PREVIOUS target -- an off-by-one that
    // looked like "moved but never arrived" for every single move.
    //
    // So: confirm repeatedly until the position stops changing, or we run out of patience.
    // Settling is the measurement here, not an inconvenience around it.
    let confirmed = null, prev = null, settled = 0;
    const deadline = Date.now() + SETTLE * 6;
    do {
      await sleep(SETTLE);
      confirmed = await session.confirmPosition().catch(() => null);
      const p = c.self ?? {};
      if (prev && p.x === prev.x && p.y === prev.y) settled++; else settled = 0;
      prev = { x: p.x, y: p.y };
    } while (settled < 1 && Date.now() < deadline);

    const now = c.self ?? {};
    const after = { x: now.x, y: now.y, col: now.col, row: now.row };
    const movedAtAll = after.x !== before.x || after.y !== before.y;
    const arrived = after.col === tc && after.row === tr;
    rows.push({ room: roomNum, from: before, to: { col: tc, row: tr }, after,
                says_lands: saysLands, trace_arrives: traceArrives, moved: movedAtAll,
                arrived, confirmed: !!confirmed, send_threw: sendThrew });

    if (i < 4)
      console.log(`  #${i} ${before.col},${before.row} -> ${tc},${tr}  ` +
                  `lands=${saysLands} trace=${traceArrives}  landed at ${after.col},${after.row}` +
                  `  moved=${movedAtAll}${sendThrew ? '  THREW: ' + sendThrew : ''}`);
    if ((i + 1) % 20 === 0) process.stdout.write(`  ${i + 1}/${MOVES}\r`);
  }

  writeFileSync(OUT, JSON.stringify({ at: Date.now(), agent: AGENT, rows }, null, 1));

  // ---- the confusion matrix, per model
  const report = (name, pick) => {
    const known = rows.filter(r => pick(r) !== null);
    const yes = known.filter(r => pick(r) === true), no = known.filter(r => pick(r) === false);
    const falseConf = yes.filter(r => !r.arrived).length;
    const falseCaut = no.filter(r => r.arrived).length;
    console.log(`\n${name}  (${known.length} moves with a prediction)`);
    console.log(`  said LANDS  ${String(yes.length).padStart(4)}   arrived ${yes.filter(r => r.arrived).length}` +
                `   moved-but-not-arrived ${yes.filter(r => r.moved && !r.arrived).length}` +
                `   DID NOT MOVE ${yes.filter(r => !r.moved).length}`);
    console.log(`  said NO     ${String(no.length).padStart(4)}   arrived ${no.filter(r => r.arrived).length}` +
                `   moved-but-not-arrived ${no.filter(r => r.moved && !r.arrived).length}` +
                `   did not move ${no.filter(r => !r.moved).length}`);
    const p = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '—';
    console.log(`  FALSE CONFIDENCE (approved, did not arrive)  ${falseConf}/${yes.length}  ${p(falseConf, yes.length)}`);
    console.log(`  FALSE CAUTION    (rejected, arrived anyway)  ${falseCaut}/${no.length}  ${p(falseCaut, no.length)}`);
  };

  console.log(`\n=== ${rows.length} moves, ${new Set(rows.map(r => r.room)).size} room(s) ===`);
  console.log(`arrived ${rows.filter(r => r.arrived).length}   ` +
              `moved but not arrived ${rows.filter(r => r.moved && !r.arrived).length}   ` +
              `did not move at all ${rows.filter(r => !r.moved).length}`);
  report('moverStepLands', r => r.says_lands);
  report('traceFineMoveClient', r => r.trace_arrives);
  console.log(`\nwritten to ${OUT}`);
  process.exit(0);
}

main().catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
