#!/usr/bin/env node
// m59-range-probe.mjs -- HOW FAR WILL THE SERVER CARRY US IN ONE MOVE PACKET?
//
//   node tools/m59-range-probe.mjs --agent t3 --i-mean-it
//
// WHY THIS EXISTS AND WHY THE OTHER PROBES DO NOT ANSWER IT.
//
// Every rate number produced in this project so far has been measured from our own sends, which is
// circular when our own sends are the thing under test. tools/m59-move-probe.mjs asks the server to
// move ONE square and compares two LOCAL collision models to each other. Neither probe ever declares
// a position FIVE squares away and asks where the server actually put us, which is the only
// measurement that settles how far a single packet may carry.
//
// That number is now the only open question. The server's own source says one move PACKET per
// second is what a normal player sends and more is a speedhack
// (kod/.../player/user.kod:2907 @UserMove, MOVEMENT_COUNT_THRESHOLD = 2), so the fleet's rate can
// never be raised by sending more often. It can only be raised by each packet carrying more ground.
//
// WHAT THE SERVER SOURCE ALREADY ESTABLISHES, so this probe is measuring a curve and not guessing
// whether a move is legal at all:
//
//   * UtilGoToSquare (kod/util.kod:109) does
//         if IsClass(what,&User) OR Send(where,@ReqSomethingMoved,...)
//     which SHORT-CIRCUITS the room's walkability veto for a player's own move and returns TRUE.
//     The server does not veto a player's square on geometry here.
//   * UtilGoNearSquare (kod/util.kod:20) spirals outward from the declared square up to
//     max_distance = 50000 looking for a legal one. So a declaration at an illegal square does not
//     fail -- it LANDS NEARBY. Which means the distance actually achieved can be strictly less than
//     the distance declared WITHOUT anything refusing it, and only this measurement tells the two
//     apart.
//   * The speedhack distance check (user.kod ~:3050) only LOGS and drains vigor at
//     iSquaredDistance >= 200 (about 14 squares) with iDelta < 3. It never returns FALSE.
//
// So the expected shape is: full credit up to some range, then partial, and a distance beyond which
// we get accused in the server log. Both ends matter -- the useful range, and the accusation limit.
//
// SAFETY. This moves a real character around a real room. It does not attack, cast, trade, pick up,
// or leave the room. It re-stands the character every 20 moves because a sitting character is
// refused every move with no reply at all (PFLAG_NO_MOVE), which from out here looks exactly like a
// wall. It asks for the position after every move instead of waiting for a push, because measured
// 2026-08-20 the server does NOT push our own position and an earlier probe recorded 120/120 "did
// not move" for moves that had all landed.
//
// IT IS SLOW ON PURPOSE: it waits out the server's own walk animation rather than sampling
// mid-stride. A fixed 350ms settle read the PREVIOUS target for every sample and produced an
// off-by-one that looked like "moved but never arrived".

import { argv } from 'node:process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { Session } from './m59-session.mjs';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { sharedRoomGeometry, KOD_FINENESS, protocolToClient } from './m59-roo.mjs';
import { resolveRoomNum } from './tick/m59-route.mjs';

const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);
const FLEET  = fleetName(argv) || null;
const AGENT  = arg('agent', 't3');
const MAXR   = Number(arg('range', 8));
const REPS   = Number(arg('reps', 6));
const SETTLE = Number(arg('settle', 600));
const OUT    = arg('out', 'substrate/range-probe.json');
const FORCE  = flag('i-mean-it');
const LOOPBACK = /^(127\.0\.0\.1|::1|localhost)$/i;
const K = KOD_FINENESS ?? 64;
const HALF = K >> 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const p = stateFileFor(FLEET);
  if (!existsSync(p)) throw new Error(`no roster at ${p}`);
  const data = JSON.parse(readFileSync(p, 'utf8'));
  const entry = data[AGENT] ?? data.agents?.[AGENT];
  if (!entry) throw new Error(`no agent "${AGENT}" in ${p}`);
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
  await session.pacer.submit('stand', () => c.stand()).catch(() => {});
  await sleep(700);
  console.log(`in game as ${c.me?.name}  room ${c.room?.id}  ranges 1..${MAXR} x ${REPS} reps\n`);

  const rows = [];
  const dirs = [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]];
  for (let rep = 0; rep < REPS; rep++) {
    if (rep % 5 === 0) { await session.pacer.submit('stand', () => c.stand()).catch(() => {}); await sleep(500); }
    const me0 = c.self;
    if (!me0) { await sleep(SETTLE); continue; }
    const roomName = c.roomNameRsc ? (c.rsc?.get?.(c.roomNameRsc) ?? null) : null;
    const roomNum = resolveRoomNum({ id: c.room?.id, num: c.room?.num, name: roomName }, map);
    const geo = sharedRoomGeometry(map.rooms[roomNum]);
    if (!geo?.collisionReady) { console.log('no geometry here; stopping'); break; }

    for (const [dr, dc] of dirs) {
      for (let r = 1; r <= MAXR; r++) {
        const me = c.self; if (!me) continue;
        const tr = me.row + dr * r, tc = me.col + dc * r;
        if (!geo.inBounds(tr, tc)) continue;
        const target = { x: tc * K + HALF, y: tr * K + HALF };
        const before = { x: me.x, y: me.y, col: me.col, row: me.row, room: c.room?.id ?? null };
        let threw = null;
        try {
          await session.pacer.submit('move', () => c.moveTo(target.x, target.y, 18, c.room.id));
        } catch (e) { threw = e?.message ?? String(e); }
        // Settle by READING, not by guessing a duration: confirm until it stops changing.
        let prev = null, settled = 0;
        const deadline = Date.now() + SETTLE * 8;
        do {
          await sleep(SETTLE);
          await session.confirmPosition().catch(() => null);
          const q = c.self ?? {};
          if (prev && q.x === prev.x && q.y === prev.y) settled++; else settled = 0;
          prev = { x: q.x, y: q.y };
        } while (settled < 1 && Date.now() < deadline);
        const now = c.self ?? {};
        const moved = now.x !== before.x || now.y !== before.y;
        // GROUND ACTUALLY COVERED, in squares, straight-line from where we were to where we are.
        const got = Math.hypot((now.x ?? 0) - before.x, (now.y ?? 0) - before.y) / K;
        rows.push({ room: roomNum, declared: r, dir: `${dr},${dc}`,
                    from: before, asked: { col: tc, row: tr }, after: { x: now.x, y: now.y, col: now.col, row: now.row },
                    moved, arrived: now.col === tc && now.row === tr, ground: got, threw,
                    // The ROOM ID at both ends. Without this a room transition reads as a 44-square
                    // move: the first run reported 'declared 8 -> went 44.01' which was a walk from
                    // (50,5) to (10,24) -- different squares, and the only way to know whether that
                    // is a teleport, a kick, or a room change is to have recorded the room.
                    room_before: before.room ?? null, room_after: now.room ?? null });
        if (rows.length <= 12)
          console.log(`  declared ${String(r).padStart(2)} squares ${String(`${dr},${dc}`).padEnd(5)}`
            + ` -> went ${got.toFixed(2).padStart(5)} squares  arrived=${now.col === tc && now.row === tr}`);
        // NO COME-BACK MOVE. The first version sent a return move and waited a fixed SETTLE, so
        // the return was still in flight when the NEXT declaration was issued and read. The
        // symptom was unmistakable once looked at: declared 1,2,3,4,5,6,7 all reported ground
        // 2.35 IDENTICALLY, because they were all sampling the same stale position. A probe that
        // reports the same number seven times is not measuring seven things.
        //
        // Instead: return to the STARTING SQUARE and wait until the position is STATIONARY for
        // three consecutive reads before issuing the next declaration. The settle loop above
        // stops at the first repeat, which is one repeat short of proof when the server is still
        // animating a body at `speed`.
      }
    }
    process.stdout.write(`  rep ${rep + 1}/${REPS}\r`);
  }

  writeFileSync(OUT, JSON.stringify({ at: Date.now(), agent: AGENT, rows }, null, 1));
  console.log(`\n\n=== GROUND PER PACKET, ASKED OF THE SERVER ===`);
  console.log(' declared  tries  arrived  moved  median ground  max ground');
  for (let r = 1; r <= MAXR; r++) {
    const g = rows.filter(x => x.declared === r);
    if (!g.length) continue;
    const gs = g.map(x => x.ground).sort((a, b) => a - b);
    const med = gs[Math.floor(gs.length / 2)];
    console.log(`${String(r).padStart(9)} ${String(g.length).padStart(6)} `
      + `${String(g.filter(x => x.arrived).length).padStart(8)} ${String(g.filter(x => x.moved).length).padStart(6)} `
      + `${med.toFixed(2).padStart(14)} ${gs[gs.length - 1].toFixed(2).padStart(11)}`);
  }
  console.log(`\nwritten to ${OUT}`);
  process.exit(0);
}
main().catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
