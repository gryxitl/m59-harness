#!/usr/bin/env node
// m59-rate-measure.mjs -- how much ground one packet buys, for both locomotion engines.
//
// WHY THIS FILE EXISTS. docs/TICK-MOVEMENT-PLAN.md carried a sends-per-square table for two
// commits before it had a source: the numbers were produced in throwaway heredocs and typed up.
// A figure that cannot be re-run is a figure nobody can check, and the one recorded there was
// additionally the *optimistic* case — 2.50 squares per packet, which is the full unobstructed
// stride, quoted next to the client's 2.50 as though it were an observation. The observed value
// in game is 2.24, because the integration stops at walls and a stride that hits a wall declares
// less than a stride. This prints the number instead of asserting it, so the document can point
// at a command.
//
// WHAT IS BEING MEASURED, and why the obvious measurement is wrong.
//
// The first attempt drove both engines through a fake server that moved the character onto
// whatever position had just been sent. Both engines then advanced one square per tick and
// reported identical rates, which looked like proof that the restored engine was no faster than
// the step engine. It was proof about the rig: a server that adopts the declared position gives
// the mover credit for ground it only asked for, so the rig measured its own clamping.
//
// What the mover actually controls, and what the protocol actually carries, is the POSITION IN
// THE PACKET. So that is what is measured: the distance from the position we were at to the
// position we declared. The client's own answer to "how far does the server carry you" is
// MOVEUNITS per MOVE_DELAY (m59-game.mjs:207-222), which is a constant, not a variable of the
// mover.
//
// THE ENGINES ARE TWO CLASSES, NOT A POLICY FLAG. policy.ownPhysics selects nothing in the current
// mover — it was the gate on the velocity declaration that 2d44a48 deleted, and the engine that
// replaced it has no switch. Passing a policy field to select an engine would make the
// measurement vacuous in exactly the way the five ownPhysics tests were. So the pre-fix mover is
// loaded as its own module and the flag is set on it because THAT file still reads it.
import { Mover as CurrentMover } from './tick/m59-mover.mjs';
import { Mover as PreFixMover } from './tick/m59-mover-preFix.mjs';
import { Pose } from './tick/m59-pose.mjs';
import { WALK_STRIDE_PROTO, RUN_STRIDE_PROTO, PLAYER_WALL_CLEARANCE_CLIENT_UNITS } from './tick/m59-mover.mjs';

const KOD = 64;
// The client's own rate, from the source rather than from a mover's comment: MOVEUNITS = 256
// client units per MOVE_DELAY = 100 ms, reported at most once per MOVE_INTERVAL = 1000 ms, so ten
// MOVE_DELAYs fit in one report and one packet covers 2560 client units = 2.5 squares.
const CLIENT_SQUARES_PER_PACKET = 2.5;

// A virtual clock. The mover paces itself on Date.now(), and a measurement that sleeps a real
// second per tick takes an hour for four engines.
let CLOCK = 0;
const realNow = Date.now.bind(Date);
Date.now = () => CLOCK + realNow.call(Date);

const TICK_MS = 1050;   // the mover's own minimum interval between reports

function makeSession(geo, policy) {
  const sent = [];
  const s = {
    name: 'measure', live: true, policy,
    client: {
      state: 'game',
      self: { col: 2, row: 2, x: 2 * KOD + 32, y: 2 * KOD + 32 },
      moveTo: (x, y) => { sent.push([x, y]); },
      moveSpeed: () => 18, room: { id: 1 }, stand: () => {},
      vitals: () => ({ health: 100, vigor: { value: 20 } }),
    },
    // The pacer runs the send synchronously so the measurement does not depend on a microtask
    // ordering; a real fleet has a real pacer and the same position on the wire.
    pacer: { depth: 0, submit: (_k, fn) => { fn(); return Promise.resolve(); } },
    walkTo: () => Promise.resolve({ arrived: true }),
    world: { geometry: geo },
  };
  s._pose = new Pose();
  s._pose.updateServer({ ...s.client.self });
  return { session: s, sent };
}

// Open ground, 20 squares in a straight line, one waypoint per square. Deliberately unobstructed:
// this measures the stride an engine USES, not the walls it meets. A maze would measure the
// integration's wall handling and report a lower number for the restored engine, which is true but
// is a different question and is answered in game rather than here.
function openGeometry(nSquares) {
  const waypoints = Array.from({ length: nSquares }, (_, i) => ({ x: (3 + i) * KOD + 32, y: 2 * KOD + 32 }));
  return {
    collisionReady: true,
    fineWalkable: () => true,
    standable: () => true,
    traceFineMoveClient: (_a, _b, x1, _c, _d) => ({ blocked: false, moved: true, arrived: true, x: x1 }),
    finePathProtocol: () => ({ found: true, waypoints }),
    rows: 40, cols: 40,
  };
}

async function measure(label, MoverClass, policy, nSquares = 20) {
  const geo = openGeometry(nSquares);
  const { session, sent } = makeSession(geo, policy);
  const mover = new MoverClass(session, { reportIntervalMs: 0, moveCapMs: 0 });
  mover.to(3 + nSquares - 1, 2, { by: 'router' });
  const declared = [];
  // THE TWO QUANTITIES ARE NOT THE SAME AND ONLY ONE BELONGS TO THE MOVER.
  //
  // `declared` collects how far the position in the packet is from where we were. `strides`
  // collects what the mover itself says it covered, from its own `ground=` field. They differ,
  // and the difference is the whole reason a rate table was wrong for two commits: on open
  // ground with one waypoint per square, the character lands on a waypoint, so the *distance to
  // the next waypoint* is one square no matter how long a stride the engine is willing to
  // declare. That is a property of the waypoint spacing, not of the engine, and measuring it
  // makes the step engine and the restored engine look identical.
  //
  // The stride the mover declares is the quantity the engine chooses, so it is the quantity
  // worth printing. The distance-to-position is printed alongside as the ground actually gained,
  // which is what the fleet's rate is made of.
  const strides = [];
  const realError = console.error;
  console.error = (...a) => {
    const m = /ground=(\d+)/.exec(String(a[0] ?? ''));
    if (m) strides.push(Number(m[1]));
    // The mover's diagnostics are the data source here, so they are swallowed rather than
    // printed: the point of this file is one clean table, not 200 lines of movedbg.
  };
  for (let i = 0; i < 60; i++) {
    CLOCK += TICK_MS;
    const before = sent.length;
    const r = mover.tick();
    // The sends resolve synchronously via the stub pacer; drain the microtask queue the same way
    // the other suites do, so a send made on a later microtask is not missed.
    for (let j = 0; j < 8; j++) await new Promise((res) => setImmediate(res));
    for (let k = before; k < sent.length; k++) {
      const c = session.client.self;
      const dx = sent[k][0] - c.x, dy = sent[k][1] - c.y;
      declared.push(Math.hypot(dx, dy));
      // The server carries the character along the declaration (m59-game.mjs:207-222). Advancing
      // by the declared distance is Model A, which is what that file says the server does.
      c.x = sent[k][0]; c.y = sent[k][1];
      c.col = Math.floor((c.x - 32) / KOD); c.row = Math.floor((c.y - 32) / KOD);
      session._pose.updateServer({ ...c });
    }
    if (r.state === 'arrived' || r.state === 'stuck') break;
  }
  console.error = realError;
  if (!declared.length) { console.log(`  ${label}: SENT NOTHING — nothing measured`); return null; }
  if (strides.length) {
    // THE DISTRIBUTION, NOT THE MAXIMUM. The first draft printed `max` and it lied by
    // omission: the step engine produced exactly ONE 160-unit declaration in twenty packets —
    // a single escape-fan probe — and labelling that 'the step engine's stride' made the step
    // engine look as fast as the velocity engine on open ground. One outlier is not a rate, and
    // a summary line built from Math.max of a one-element spike is how a measurement becomes a
    // justification.
    const ss = [...strides].sort((a, b) => a - b);
    const smed = ss[Math.floor(ss.length / 2)];
    const hist = {};
    for (const v of strides) hist[v] = (hist[v] ?? 0) + 1;
    const h = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([v, n]) => `${v}u x${n}`).join(', ');
    console.log(`    stride the engine DECLARED: median ${smed} units = ${(smed / KOD).toFixed(2)} squares | ${strides.length} declarations | ${h}`);
  }
  const sorted = [...declared].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = declared.reduce((a, b) => a + b, 0) / declared.length;
  console.log(`  ${label}`);
  console.log(`    packets ${String(declared.length).padEnd(4)} median ground ${median.toFixed(0)} proto units = ${(median / KOD).toFixed(2)} squares | mean ${(mean / KOD).toFixed(2)}`);
  console.log(`    sends per square: ${(KOD / (median || 1)).toFixed(2)} | vs the client's ${CLIENT_SQUARES_PER_PACKET.toFixed(2)} sq/packet: ${(median / KOD / CLIENT_SQUARES_PER_PACKET).toFixed(2)}x`);
  return median / KOD;
}

console.log('ground declared per packet, both engines, identical open geometry');
console.log('(open ground on purpose: this measures the stride an engine uses. In a maze the');
console.log(' integration stops at walls and the figure drops — that is measured in game.)');
const step = await measure('step engine (2d44a48^ mover, engine flag off)', PreFixMover, {});
const vel = await measure('restored engine (current mover)', CurrentMover, {});
if (step && vel) {
  console.log('\nsummary — ground actually gained per packet, on open ground');
  console.log(`  step engine      ${step.toFixed(2)} squares/packet = ${(step / CLIENT_SQUARES_PER_PACKET).toFixed(2)}x the client's walk rate`);
  console.log(`  restored engine  ${vel.toFixed(2)} squares/packet = ${(vel / CLIENT_SQUARES_PER_PACKET).toFixed(2)}x the client's walk rate`);
  // SAY IT WHEN THE MEASUREMENT DOES NOT DISCRIMINATE. It came out equal here, and the honest
  // reading is that this rig cannot tell the engines apart rather than that they are the same
  // speed: the geometry hands the mover one waypoint per square, so the distance to the next
  // waypoint is one square regardless of what an engine is willing to declare. The engines are
  // not equal in game, where the waypoint spacing comes from a real pathfinder and the stride
  // is what carries the character between waypoints.
  if (Math.abs(step - vel) < 0.01) {
    console.log('  THESE TWO ARE EQUAL, AND THIS RIG IS WHY, NOT THE ENGINES: with one waypoint');
    console.log('  per square the ground available per packet is one square by construction. A');
    console.log('  rig that cannot distinguish the things it compares measures the rig. The');
    console.log('  discriminating number is the in-game one — see the header of this file.');
  }
  console.log('  observed in game from [move-sent]: median 2.24 squares per packet for the');
  console.log('  restored engine. Re-measure with tools/m59-rate-observed.mjs against a keeper log.');
}
