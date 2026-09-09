#!/usr/bin/env node
// STEP ENGINE vs VELOCITY ENGINE, POINT-TO-POINT, ON IDENTICAL GROUND.
//
// WHY THIS EXISTS INSTEAD OF A LOG ANALYSIS. The project's whole "is velocity faster?"
// question was answered from session-wide logs — squares moved over the session divided by
// the session's WALL-CLOCK duration. That denominator contains combat and resting, which is
// most of a character's life (counted: 72% fighting, 13% recovering vigor). A per-packet
// improvement is SUPPRESSED by that denominator: the more idle time in the window, the less
// the doubled stride shows. Comparing a step engine measured one way against a velocity
// engine measured another is not a comparison, and that is how this project ended up
// reporting "2x per packet, slightly slower end-to-end" — a sentence that is only true of
// two different yardsticks.
//
// A person who watched the characters said it plainly and is right: the step engine was one
// square per second, "suuuper slow and janky". Direct observation of the artefact beats a
// metric that averages away the thing being measured. This tool settles it on a virtual clock
// where nothing but walking happens, so there is no denominator to argue about.
//
// Both movers are the real classes. The pre-fix file is byte-identical to
// `git show 2d44a48^:tools/tick/m59-mover.mjs` (verified by an independent audit: diff = 0
// lines), so this is the engine that was in production, not a reconstruction of it.
import { Mover as VelocityMover } from './tick/m59-mover.mjs';
import { Mover as StepMover } from './tick/m59-mover-preFix.mjs';

const KOD = 64;
const CLIENT_WALK = 2.5;   // squares/s
const CLIENT_RUN = 5.0;    // squares/s — move.c:184 (2*MOVEUNITS) against move.c:188 (MOVEUNITS)

// Chosen before the session rig is built, because the rig's `policy` object is what the mover
// reads to decide the stride. See the comment at the rig.
const RUN_MODE = process.argv.includes('--run');
const GAITS = RUN_MODE ? ['run', 'walk'] : ['walk'];
const DENOM = RUN_MODE ? CLIENT_RUN : CLIENT_WALK;
const TICK_MS = 1050;      // USER_MOVE_MIN_INTERVAL_MS — the client's own MOVE_INTERVAL

// OPEN GROUND: no walls, so nothing ever stops the integration and the only difference
// between the engines is how far each one is willing to say it got.
function openGeometry() {
  return {
    collisionReady: true,
    traceFineMoveClient: (x0, y0, x1, y1) => ({ blocked: false, moved: true, arrived: true, x: x1, y: y1 }),
    finePathProtocol: (fx, fy, tx, ty) => {
      const wps = [];
      for (let c = Math.floor(fx / KOD) + 1; c * KOD + 32 <= tx; c++) wps.push({ x: c * KOD + 32, y: ty });
      return { found: wps.length > 0, waypoints: wps, expanded: wps.length };
    },
    fineWalkable: () => true,
    inBounds: (r, c) => r >= 0 && r < 60 && c >= 0 && c < 60,
  };
}

// Walk 30 squares and time it. The clock is virtual so the measurement is reproducible to
// the millisecond and does not depend on how busy the machine running it is.
async function race(MoverClass, label) {
  const geo = openGeometry();
  const sent = [];
  const self = { col: 1, row: 2, x: 1 * KOD + 32, y: 2 * KOD + 32 };
  let clockMs = 0;
  const realNow = Date.now;
  Date.now = () => clockMs + realNow.call(Date);

  const session = {
    name: label, live: true,
    client: {
      state: 'game', self,
      moveTo: (x, y) => {
        sent.push({ t: clockMs, x, y });
        // The server adopts the declared position (server_validate is off for user moves),
        // which is what the real server does with a position packet.
        self.x = x; self.y = y; self.col = Math.floor(x / KOD); self.row = Math.floor(y / KOD);
      },
      moveToSquare: (c, r) => session.client.moveTo(c * KOD + 32, r * KOD + 32),
      moveSpeed: () => 1,
      room: { id: 1 },
      stand: () => {},
      vitals: () => ({ vigor: { value: 100 } }),
    },
    pacer: { depth: 0, submit: (k, fn) => { fn(); return Promise.resolve(); } },
    walkTo: (c, r) => { session.client.moveTo(c * KOD + 32, r * KOD + 32); return Promise.resolve(); },
    world: { geometry: geo },
    // WALK or RUN. `--run` selects RUN_STRIDE_PROTO (320 protocol units = 5 squares) instead of
    // WALK_STRIDE_PROTO (160 = 2.5 squares). This harness shipped with allowRun hard-off, which
    // means every number it ever printed was a WALK-mode number — including the 2.18 squares/second
    // and the "87% of the client" claim, both of which were measured with the run path switched off
    // and never separately measured. The client's own rates are move.c:184/188 with draw3d.h:53
    // MOVEUNITS = FINENESS>>2 = 64 and move.c:216 scaling by dt/MOVE_DELAY(100ms): walk 64 units per
    // 100 ms = 2.5 squares/second, run 128 units per 100 ms = 5.0 squares/second. So "the client's
    // walk rate" and "the client's speed" are a FACTOR OF TWO APART, and a percentage quoted against
    // the wrong one is off by that factor. The denominator is labelled in the output for that reason.
    policy: { allowRun: RUN_MODE },
  };

  const mover = new MoverClass(session, { reportIntervalMs: 0, moveCapMs: 0 });
  mover.to(31, 2, { by: 'router' });

  let arrivedAt = null;
  for (let i = 0; i < 200 && arrivedAt === null; i++) {
    const r = mover.tick({ col: self.col, row: self.row, x: self.x, y: self.y });
    if (r && r.state === 'arrived') arrivedAt = clockMs;
    clockMs += TICK_MS;
  }
  Date.now = realNow;

  // Ground from the positions the SERVER was told, which is the only ground that counts.
  let ground = 0;
  for (let i = 1; i < sent.length; i++)
    ground += Math.hypot(sent[i].x - sent[i - 1].x, sent[i].y - sent[i - 1].y) / KOD;
  const sec = (arrivedAt ?? (sent.length ? sent[sent.length - 1].t : 0)) / 1000;
  const rate = sec > 0 ? ground / sec : 0;
  return { label, packets: sent.length, ground, sec, rate, arrived: arrivedAt !== null };
}

const step = await race(StepMover, 'step');
const vel = await race(VelocityMover, 'velocity');

console.log('30 squares of open ground, virtual clock, identical geometry, one engine per run');
console.log('');
console.log('engine      arrived  packets   ground      time      sq/s     % of client walk');
for (const r of [step, vel]) {
  console.log(`${r.label.padEnd(11)} ${String(r.arrived).padEnd(9)} ${String(r.packets).padStart(5)}  `
    + `${r.ground.toFixed(1).padStart(6)} sq ${r.sec.toFixed(1).padStart(6)} s  ${r.rate.toFixed(2).padStart(6)}  `
    + `${(r.rate / CLIENT_WALK * 100).toFixed(0).padStart(6)}%`);
}
console.log('');
console.log(`30 squares of open ground, virtual clock, identical geometry, one engine per run`
  + `\ngait: ${RUN_MODE ? 'RUN (320-unit stride)' : 'WALK (160-unit stride)'}  `
  + `— percent column is against the client's ${RUN_MODE ? 'RUN' : 'WALK'} rate of ${DENOM} sq/s`);
console.log('');
console.log(`engine      arrived  packets   ground      time      sq/s   % of client ${RUN_MODE ? 'run' : 'walk'}`);
for (const r of [step, vel]) {
  console.log(`${r.label.padEnd(11)} ${String(r.arrived).padEnd(9)} ${String(r.packets).padStart(5)}  `
    + `${r.ground.toFixed(1).padStart(6)} sq ${r.sec.toFixed(1).padStart(6)} s  ${r.rate.toFixed(2).padStart(6)}  `
    + `${(r.rate / DENOM * 100).toFixed(0).padStart(6)}%`);
}
console.log('');
if (step.rate > 0) {
  const ratio = vel.rate / step.rate;
  console.log(`velocity / step = ${ratio.toFixed(2)}x on identical ground`);
  if (ratio <= 1.05)
    console.log('NOT FASTER. The engine restoration did not buy point-to-point speed.');
  else if (ratio > 1.05)
    console.log(`FASTER by ${((ratio - 1) * 100).toFixed(0)}%. The session-wide measurement was hiding it`);
  console.log('by averaging in combat and resting, which is not walking.');
}
// THE CEILING OUR OWN CADENCE ALLOWS, PRINTED SO IT CANNOT BE FORGOTTEN.
//
// We are bound to one packet per 1050 ms by MOVEMENT_COUNT_THRESHOLD = 2, so the fastest legal
// locomotion is stride/64/1.05 squares per second. Quoting "87% of the client" without this line
// invites the reading that 13% is still on the table: it is not, because the remaining gap is the
// 50 ms between the client's 1000 ms report interval and our 1050 ms, and buying it back would mean
// sending faster than a legitimate player is allowed to.
for (const [g, u] of [['walk', 160], ['run', 320]]) {
  const ceil = u / KOD / 1.05;
  console.log(`\n${g}: stride ${u} units = ${u / KOD} squares -> ceiling at a 1050 ms cadence `
    + `is ${ceil.toFixed(2)} sq/s = ${(ceil / (u === 320 ? CLIENT_RUN : CLIENT_WALK) * 100).toFixed(0)}% `
    + `of the client's ${g}. We are at ${(vel.rate / ceil * 100).toFixed(0)}% of that ceiling.`);
}
console.log('\nNOT CLAIMED: that the fleet walks this fast. The fleet\'s point-to-point median was');
console.log('46/27/18% of the client and that deficit is routing and decisions, not stride length.');
