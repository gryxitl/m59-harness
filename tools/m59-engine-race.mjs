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
import { Mover as VelocityMover, MOVE_CAP_MS } from './tick/m59-mover.mjs';
import { Mover as StepMover } from './tick/m59-mover-preFix.mjs';

const KOD = 64;
const CLIENT_WALK = 2.5;   // squares/s
const CLIENT_RUN = 5.0;    // squares/s — move.c:184 (2*MOVEUNITS) against move.c:188 (MOVEUNITS)
const MOVE_INTERVAL_CLIENT_MS = 1000;   // move.c:57 — the client's own report interval

// Chosen before the session rig is built, because the rig's `policy` object is what the mover
// reads to decide the stride. See the comment at the rig.
const RUN_MODE = process.argv.includes('--run');
const GAITS = RUN_MODE ? ['run', 'walk'] : ['walk'];
const DENOM = RUN_MODE ? CLIENT_RUN : CLIENT_WALK;
// THE CADENCE THE RACE CLOCKS AT, READ FROM THE MOVER RATHER THAN TYPED IN.
//
// This line used to read `const TICK_MS = 1050;` with the comment "USER_MOVE_MIN_INTERVAL_MS — the
// client's own MOVE_INTERVAL". Both halves were false. The client's MOVE_INTERVAL is 1000
// (move.c:57); 1050 was OUR number and nothing else. And because the race builds its mover with
// `moveCapMs: 0` and drives a virtual clock, the literal here — not the mover's constant — was the
// thing setting the cadence for every speed figure this harness ever printed.
//
// That is how a harness came to report "87% of the client" against a 1050 ms clock while calling
// that clock the client's own, and to compute a ceiling from a cadence the mover did not use. Import
// the real one so the number and the engine cannot disagree.
const TICK_MS = MOVE_CAP_MS;

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
  // KEPT, not just used to build `self`. The ground measurement has to difference from where the
  // character actually started, and recomputing `1 * KOD + 32` at the far end of this function would
  // be a second copy of the origin — the same class of bug as the two 1050 literals, where one copy
  // gets edited and the other quietly becomes false.
  const start = { x: self.x, y: self.y };
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
  //
  // THE FIRST PACKET CARRIES GROUND AND THIS USED TO THROW IT AWAY. The loop began at i = 1 and
  // differenced consecutive sends, so the ground covered between the character's starting position
  // and the first declaration was never counted — while `sec` below divides by the FULL elapsed
  // time including that first interval. N packets of ground over N+1 intervals' worth of time.
  //
  // The size of the error is one packet's worth of ground, which at a 5-square stride on a 30-square
  // road is 17% of the total. It is also NOT uniform: it scales inversely with road length, so short
  // roads were understated worst and the numbers were never comparable across lengths. Every rate
  // this harness has ever printed was low by that much, including the 4.17 sq/s and the "83% of the
  // client" in the plan document, and including the step engine's 0.97 — which means the step engine
  // was also understated and the RATIO between engines was roughly right while both absolutes were
  // wrong. A ratio of two wrong numbers in the same direction is how a measurement survives being
  // wrong for this long: the comparison looked sound and the headline number was not.
  //
  // Fixed by seeding the differencing chain with the position the character actually started at,
  // which the rig knows and previously did not need to keep.
  let ground = 0;
  let prev = { x: start.x, y: start.y };
  for (let i = 0; i < sent.length; i++) {
    ground += Math.hypot(sent[i].x - prev.x, sent[i].y - prev.y) / KOD;
    prev = sent[i];
  }
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
// THE CEILING OUR OWN CADENCE ALLOWS, PRINTED FROM THE CADENCE IN USE.
//
// This block used to hardcode "1050 ms" and "95%" in its output strings. When the cadence moved to
// 1000 it went on printing a ceiling computed from a cadence nothing was using, and reported the
// engine at "175% of that ceiling" — a percentage over 100% for a rate that is simply measured
// against the wrong denominator. A report that cannot notice its own constant changed is not a
// report. The cadence, the denominator and the percentage are all derived now.
for (const [g, u] of [['walk', 160], ['run', 320]]) {
  const client = g === 'run' ? CLIENT_RUN : CLIENT_WALK;
  const ceil = u / KOD / (TICK_MS / 1000);
  const measured = (RUN_MODE ? 'run' : 'walk') === g ? vel.rate : null;
  console.log(`\n${g}: stride ${u} units = ${u / KOD} squares at a ${TICK_MS} ms cadence `
    + `-> ceiling ${ceil.toFixed(2)} sq/s = ${(ceil / client * 100).toFixed(0)}% `
    + `of the client's ${g} (${client} sq/s, which is a ${MOVE_INTERVAL_CLIENT_MS} ms cadence)`);
  if (measured == null) {
    // NOT MEASURED IN THIS INVOCATION. The gait is selected before the rig is built, so a run-mode
    // race has no walk figure to report. The first version of this line read
    // `(g === 'run' ? vel.rate : vel.rate)` — both branches the same expression — and printed the
    // RUN rate under the WALK heading, which came out as "167% of that ceiling" and looked like a
    // discovery about the engine when it was a typo about a label. A ternary whose branches agree is
    // not a condition, and the guard below would have been the only thing that noticed.
    console.log('   not measured in this invocation (gait selected before the rig is built). '
      + 'Run with the other flag.');
    continue;
  }
  console.log(`   engine measured ${measured.toFixed(2)} sq/s = ${(measured / ceil * 100).toFixed(0)}% `
    + `of that ceiling, ${(measured / client * 100).toFixed(0)}% of the client's ${g}.`);
  if (measured > ceil)
    console.log('   *** MEASURED ABOVE THE CEILING — the cadence and the measurement disagree. '
      + 'Check that the race clocks at TICK_MS and not at something else. ***');
}
console.log(`\nCadence in use: ${TICK_MS} ms (MOVE_CAP_MS). The official client reports at most once `
  + `per\nMOVE_INTERVAL = ${MOVE_INTERVAL_CLIENT_MS} ms (move.c:57). At equal cadence and equal stride `
  + `the rates are\nequal by construction: ${KOD ? '' : ''}${320 / KOD} squares per packet both.`);
console.log('\nNOT CLAIMED: that the fleet walks this fast. The fleet\'s point-to-point median was');
console.log('46/27/18% of the client and that deficit is routing and decisions, not stride length.');
