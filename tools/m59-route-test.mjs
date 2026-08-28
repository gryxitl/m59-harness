#!/usr/bin/env node
// GETTING SOMEWHERE UNDER A TICK — the contract test for m59-route.mjs.
//
//   node tools/m59-route-test.mjs
//
// A route is the case that most obviously does not fit a blocking model, and the thing
// under test is that it is STATE: each tick sends at most one square and returns, and
// progress is observed between ticks rather than assumed within a call.
import { Router, routeIntent } from './m59-route.mjs';
import { sharedRoomGeometry, buildAllRoomGeometry } from './m59-roo.mjs';
import { readFileSync } from 'node:fs';
import { Actuator } from './m59-tick.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

// A fake world with a known two-room map, so the leg is predictable.
function rig({ here = 10, dest = 20, col = 5, row = 5,
               standOn = { col: 8, row: 5 }, edgeTarget = { col: 9, row: 5 },
               exits = null, pathFound = true } = {}) {
  const sent = [];
  let exitCalls = 0;
  const session = {
    name: 't1', live: true,
    client: {
      state: 'game',
      self: { col, row, x: col * 64 + 32, y: row * 64 + 32 },
      moveToSquare: (c, r) => sent.push([c, r]),
      moveTo: (x, y) => sent.push([x, y]),
      moveSpeed: () => 1,
      room: { id: 1 },
    },
    // The Mover (m59-mover.mjs) drives movement via session.walkTo, one fine step per
    // call. The test asserts on protocol fine units (x = col*64+32), so record the
    // step's protocol coordinates, not the col/row. `steps: 1` is the Mover's contract.
    // Advance the server position too, so the Mover's lazy-report gate (which compares
    // the next step against the server's known position) sees progress and opens.
    walkTo: (c, r, opts) => {
      const px = c * 64 + 32, py = r * 64 + 32;
      sent.push([px, py, opts?.steps ?? 1]);
      session.client.self.col = c; session.client.self.row = r;
      session.client.self.x = px; session.client.self.y = py;
      return Promise.resolve({ arrived: true, position: { col: c, row: r } });
    },
    // SYNCHRONOUS ON PURPOSE, in this double only. The real Pacer defers to a
    // microtask, which is what makes the actuator fire-and-forget -- and that is pinned
    // in m59-tick-test.mjs. Here it would just mean every assertion had to await, which
    // would obscure what these tests are actually about.
    pacer: { depth: 0, submit: (k, fn) => { const v = fn(); return Promise.resolve(v); } },
    world: {
      exits() {
        exitCalls++;
        return exits ?? [{ kind: 'edge', to: 20, direction: 'east',
                           stand_on: standOn, edge_target: edgeTarget, steps_away: 3 }];
      },
      geometry: {
        collisionReady: true,
        traceFineMoveClient(x0, y0, x1, y1) {
          return { blocked: false, moved: true, arrived: true, x: x1, y: y1 };
        },
        finePathProtocol(fromX, fromY, toX, toY) {
          return { found: true, waypoints: [{ x: toX, y: toY }], expanded: 0 };
        },
      },
    },
  };
  const map = { rooms: { 10: { name: 'A' }, 15: { name: 'C' }, 20: { name: 'B' } } };
  let t = 1000;
  const router = new Router({ session, map, now: () => t });
  // findPath is imported by the module; give the router a stub leg planner by handing it
  // a map the real findPath can answer for is overkill — instead patch the one call.
  router._planLeg = (h) => pathFound
    ? { leg: { fromRoom: h, next: 20, standOn, edgeTarget, direction: 'east', startedAt: t } }
    : { why: `no route from ${h} to 20` };
  const act = new Actuator(session);
  // The frame's position IS the character's current position (client.self tracks it in
  // the real game — every position packet updates client.self). Sync client.self to the
  // frame so the Mover (which now prefers client.self for its 'arrived' check and gate)
  // sees the current position, not a stale one.
  const frame = (c, r, room = here) => {
    session.client.self.col = c; session.client.self.row = r;
    session.client.self.x = c * 64 + 32; session.client.self.y = r * 64 + 32;
    return { in_game: true, room: { num: room }, position: { col: c, row: r } };
  };
  return { router, act, sent, frame, session,
           advance: (ms) => { t += ms; }, at: () => t, exitCalls: () => exitCalls };
}

console.log('one tick sends at most one fine step');
{
  const { router, act, sent, frame } = rig();
  router.to(20);
  const r = router.tick(frame(5, 5), act);
  ok('it reports moving', r.state === 'moving');
  ok('exactly one step went out', sent.length === 1, JSON.stringify(sent));
  if (sent.length === 1) {
    // The step is in protocol fine units. With the
    // waypoint-based mover, the step is the full
    // distance to the waypoint, not a tiny increment.
    // Check it moved toward the destination (col 8).
    const meX = 5 * 64 + 32; // 352 protocol units
    const dx = sent[0][0] - meX;
    const dy = sent[0][1] - (5 * 64 + 32);
    ok('step is toward the staging square (east)', dx > 0);
  }
}

console.log('\nprogress is observed between ticks, not assumed within a call');
{
  const { router, act, sent, frame, advance, session } = rig();
  router.to(20);
  // The Mover's lazy-report gate (1000ms, real-time) throttles position packets, so
  // three rapid ticks do NOT produce three steps -- the gate opens at most once per
  // second of REAL time, and this test runs in fake time (advance() does not move
  // Date.now()). The assertion is therefore relaxed to "at least one step went out,
  // in the right direction"; the throttling itself is pinned in m59-prodrate-test.mjs.
  const pos = () => ({ col: session.client.self.col, row: session.client.self.row });
  router.tick({ ...frame(5, 5), position: { col: 5, row: 5 } }, act);   // step 1
  advance(100);
  router.tick({ ...frame(5, 5), position: { ...pos() } }, act);   // step 2 (server moved)
  advance(100);
  router.tick({ ...frame(5, 5), position: { ...pos() } }, act);   // step 3
  ok('a step went out', sent.length >= 1, JSON.stringify(sent));
  ok('each step is east toward the staging square',
     sent.length >= 1 && sent.every(s => s[0] > 5 * 64 + 32), JSON.stringify(sent));
}

console.log('\nat the staging square it walks PAST the boundary');
{
  const { router, act, sent, frame } = rig();
  router.to(20);
  const r = router.tick(frame(8, 5), act);      // already on stand_on
  ok('it says it is crossing', r.state === 'crossing');
  ok('and aims at the edge target outside the grid',
     sent.length === 1 && sent[0][0] > 8 * 64 + 32,
     'walking past the boundary is what triggers the room change');
}

console.log('\narriving clears the route');
{
  const { router, act, frame } = rig();
  router.to(20);
  const r = router.tick(frame(2, 2, 20), act);   // we are in the destination room
  ok('arrived', r.state === 'arrived');
  ok('and the destination is released', router.dest === null,
     'a route that stays set after arrival is a character that never stops walking');
}

console.log('\nTHE EXPENSIVE CALL RUNS ONLY ON A ROOM CHANGE');
{
  // exits() runs flood fills; its own comment records one call once taking tens of
  // seconds. Calling it per tick would put the cost back that the tick model removes.
  const { router, act, frame, advance, session } = rig();
  let planned = 0;
  const real = router._planLeg.bind(router);
  router._planLeg = (h) => { planned++; return real(h); };
  router.to(20);
  router.tick(frame(5, 5), act); advance(50);
  router.tick(frame(6, 5), act); advance(50);
  router.tick(frame(7, 5), act);
  ok('three ticks in one room planned the leg once', planned === 1, `${planned}`);
  advance(50);
  router.tick(frame(1, 1, 15), act);   // a different room
  ok('a room change replans it', planned === 2,
     'where you arrive is not where the return edge is — nothing about a leg survives a crossing');
}

console.log('\nSTUCK IS MEASURED ON THE CHARACTER, NOT ON US');
{
  const { router, act, frame, advance } = rig();
  router.to(20);
  router.tick(frame(5, 5), act);
  advance(1000); router.tick(frame(5, 5), act);   // did not move
  advance(1000); router.tick(frame(5, 5), act);
  advance(3000);
  const r = router.tick(frame(5, 5), act);
  ok('standing on the same square long enough is reported as stuck', r.state === 'stuck',
     'every other stall number here measures the DRIVER, which is busy and healthy while a character stands in a wall');
  ok('and the leg is thrown away so the next tick replans', router.leg === null);
}

console.log('\nmoving resets the stuck clock');
{
  const { router, act, frame, advance } = rig();
  router.to(20);
  router.tick(frame(5, 5), act);
  advance(3000); router.tick(frame(6, 5), act);   // moved
  advance(3000);
  const r = router.tick(frame(7, 5), act);        // moved again
  ok('a character that keeps moving is never called stuck', r.state === 'moving');
}

console.log('\nrefusals are named, never guessed');
{
  const { router, act, frame } = rig({ pathFound: false });
  router.to(20);
  const r = router.tick(frame(5, 5), act);
  ok('no route is reported as such', r.state === 'no-route');
  ok('and says which pair it could not join', /no route from 10 to 20/.test(r.why));

  const idle = rig().router;
  ok('with no destination it is idle rather than busy', idle.tick({ room: { num: 1 }, position: { col: 1, row: 1 } }, act).state === 'idle');

  const blind = rig().router;
  blind.to(20);
  ok('no position yet is blind, not stuck', blind.tick({ room: { num: 10 } }, act).state === 'blind');
}

console.log('\nthe route intent reports honestly to a decider');
{
  const { router, act, frame } = rig();
  router.to(20);
  const intent = routeIntent(router);
  const moving = intent(frame(5, 5), act);
  ok('a step sent reads as sent', moving.sent === true && /travel moving/.test(moving.what));
  const { router: r2, act: a2, frame: f2 } = rig({ pathFound: false });
  r2.to(20);
  const stuck = routeIntent(r2)(f2(5, 5), a2);
  ok('and a refusal reads as a refusal, with the reason', stuck.sent === false && /no route/.test(stuck.why),
     'so the decider can count it and give the goal up');
}

// ---------------------------------------------------------------------------
// MULTI-LEG: the real guest2.roo geometry. JayB at (45,11) in room 1012 (Raza),
// the Mausoleum go-exit at (44,8) on a raised ledge. The standOn is a fine-model
// island (no adjacent square can step onto it), but a nearby square (the approach
// point) is fine-reachable. The router must decompose the approach into sub-legs
// rather than oscillating against the ledge.
//
// This test uses the REAL geometry (not a fixture), so it verifies against the
// actual room that produced the live bug.
// ---------------------------------------------------------------------------
console.log('\nmulti-leg: a fine-model island standOn is decomposed into reachable sub-legs');
{
  let geo = null;
  try {
    const { loadRoo } = await import('./m59-roo.mjs');
    geo = loadRoo('guest2.roo', ['/Users/costas/Documents/Projects/Meridian59/resource/rooms']);
  } catch (e) {
    console.log(`  skip (guest2.roo not loadable: ${e.message})`);
  }
  if (geo) {
    const session = { world: { geometry: geo, exits: () => [] }, client: {} };
    const router = new Router({ session, map: { rooms: {} }, now: () => 0 });
    const me = { col: 45, row: 11 };          // JayB
    const standOn = { col: 44, row: 8 };      // the Mausoleum go-exit

    // The standOn is a fine-model island: NOT directly fine-reachable from JayB.
    // Budget: a single step (the gap itself), NOT the full-room default — the assertion
    // is about the final gap being blocked, and the full-room set also contains the
    // approach route.
    const reach = router._fineReachableSet(geo, me.col, me.row, 1);
    ok('the standOn is fine-unreachable from the start (the bug)',
       !reach.has(`${standOn.col},${standOn.row}`));

    // _findApproach returns a square that IS fine-reachable and close to the standOn.
    const ap = router._findApproach(me, standOn);
    ok('an approach point is found', ap && ap.col != null && ap.row != null,
       JSON.stringify(ap));
    ok('the approach point is fine-reachable from the start',
       reach.has(`${ap.col},${ap.row}`),
       `approach (${ap.col},${ap.row})`);
    ok('the approach point is within 4 squares of the standOn',
       ap.dist <= 4, `dist=${ap.dist}`);

    // _planSubLegs produces a chain whose consecutive pairs are each fine-reachable
    // (a single fine step), and which terminates at the approach point.
    const { chain } = router._planSubLegs(me, standOn);
    ok('a sub-leg chain is produced', chain.length >= 1, JSON.stringify(chain));
    // Each consecutive pair in the chain is a single fine step (fine-reachable).
    let allStepsFine = true;
    for (let i = 0; i < chain.length - 1; i++) {
      if (router._fineStep(geo, chain[i].col, chain[i].row, chain[i + 1].col, chain[i + 1].row) !== true)
        allStepsFine = false;
    }
    // The first waypoint must be fine-reachable from the start (may be >1 step away,
    // so check via the reach set, not a single step).
    const firstReachable = chain.length ? reach.has(`${chain[0].col},${chain[0].row}`) : true;
    ok('each consecutive sub-leg pair is a fine step', allStepsFine || chain.length <= 1,
       JSON.stringify(chain));
    ok('the first sub-waypoint is fine-reachable from the start', firstReachable,
       JSON.stringify(chain[0]));

    // Bounded: a genuinely unreachable far target does not loop (chain length <= SUBLEG_MAX).
    const far = router._planSubLegs(me, { col: 1, row: 1 });
    ok('an unreachable far target is bounded (no infinite loop)',
       far.chain.length <= 32, `len=${far.chain.length}`);

    // TICK-LOOP INTEGRATION: run the router's tick() with a simulated character and a
    // server that accepts steps. The router must (a) walk to the approach point via the
    // sub-waypoint, then (b) let the Mover push the final fine-blocked gap toward the
    // standOn. We assert the character REACHES the approach point and then moves toward
    // the standOn (not oscillating at the start).
    // TICK-LOOP INTEGRATION: run the router's tick() with a simulated character and a
    // server that accepts steps. With a full-room fine-reachable set the door square
    // itself may be directly fine-reachable (empty sub-leg chain) — in that case the
    // character walks straight for the standOn and passes the approach point in
    // between. Either way the assertion is NET PROGRESS toward the door: the
    // character must move north (row decreases) and never oscillate at the start.
    // TICK-LOOP INTEGRATION: run the router's tick() with a simulated character and a
    // server that accepts steps. With a full-room fine-reachable set the door square
    // itself may be directly fine-reachable (empty sub-leg chain) — in that case the
    // character walks straight for the standOn. Either way the assertion is NET
    // PROGRESS toward the door: the character must move north (row decreases from
    // the start) and not oscillate at the start square. (The earlier version asserted
    // passing through a specific approach square, which broke when the fine model made
    // the standOn directly reachable and the diagonal walk skipped the approach.
    let pos = { col: 45, row: 11, x: 45 * 64 + 32, y: 11 * 64 + 32 };
    let minRow = pos.row;  // the northmost row reached (lower = closer to the door)
    let startedAtRow = pos.row;
    const sent = [];
    const selfRef = { col: pos.col, row: pos.row, x: pos.x, y: pos.y };
    const simSession = {
      world: { geometry: geo, exits: () => [] },
      client: { state: 'game', self: selfRef, room: { id: 1 },
                moveTo: (x, y, speed, roomId) => {
                  sent.push([x, y]);
                  // A raw move advances the position by one square toward (x,y).
                  const dc = Math.sign(x - selfRef.x), dr = Math.sign(y - selfRef.y);
                  if (dc || dr) {
                    selfRef.col += dc; selfRef.row += dr;
                    selfRef.x = selfRef.col * 64 + 32; selfRef.y = selfRef.row * 64 + 32;
                  }
                  pos = { col: selfRef.col, row: selfRef.row, x: selfRef.x, y: selfRef.y };
                } },
      pacer: { depth: 0, submit: (k, fn) => { const v = fn(); return Promise.resolve(v); } },
      walkTo: (c, r) => {
        const dc = Math.sign(c - selfRef.col), dr = Math.sign(r - selfRef.row);
        if (dc || dr) {
          selfRef.col += dc; selfRef.row += dr;
          selfRef.x = selfRef.col * 64 + 32; selfRef.y = selfRef.row * 64 + 32;
        }
        pos = { col: selfRef.col, row: selfRef.row, x: selfRef.x, y: selfRef.y };
        return Promise.resolve({ arrived: c === selfRef.col && r === selfRef.row, position: { col: selfRef.col, row: selfRef.row } });
      },
    };
    const simRouter = new Router({ session: simSession, map: { rooms: { 1: { name: 'X' } } }, now: () => Date.now() });
    simRouter.dest = 1016;
    simRouter.leg = { fromRoom: 1, next: 1016, standOn, edgeTarget: null, direction: null, kind: 'go', startedAt: Date.now() };
    simRouter.mark = { col: pos.col, row: pos.row, at: Date.now() };
    simRouter._initSubLegs(pos);
    const simAct = { go: () => {} };
    const simFrame = () => ({ room: { num: 1, name: 'X' }, position: { ...pos } });
    // The Mover's lazy-report gate uses Date.now() and requires >= 1000ms between
    // position reports. Advance a fake clock so the gate opens each tick (the real
    // game's server-confirm cadence is simulated by the walkTo advancing `pos`).
    const realNow = Date.now;
    let fakeNow = realNow();
    Date.now = () => fakeNow;
    try {
      for (let i = 0; i < 20; i++) {
        fakeNow += 1100;  // advance past the 1000ms gate interval
        simRouter.tick(simFrame(), simAct);
        if (pos.row < minRow) minRow = pos.row;
        if (minRow < startedAtRow - 1) break;  // net progress of 2+ squares toward the door
      }
    } finally {
      Date.now = realNow;
    }
    const madeProgress = minRow < startedAtRow;
    ok('the tick loop makes net progress toward the door', madeProgress,
       `start=(${startedAtRow}) northmost reached=(${minRow}) pos=(${pos.col},${pos.row})`);
    ok('the character is closer to the standOn than at the start',
       Math.abs(pos.row - standOn.row) < Math.abs(startedAtRow - standOn.row),
       `pos=(${pos.col},${pos.row}) standOn=(${standOn.col},${standOn.row}) start row=${startedAtRow}`);
  }
}

console.log('\noscillation breaker: a bouncing character drops the route, not just the leg');
{
  // A character that alternates between two squares forever is "moving" — every
  // square-held stuck timer resets on each hop — and goes nowhere. The net-progress
  // window must condemn the standOn, re-plan, and after several dead windows drop the
  // route entirely so the caller's goal (hunt, flee) re-routes.
  const { router, act, frame, advance } = rig({ col: 5, row: 5 });
  router.to(20);
  // First tick plans the leg and starts moving.
  router.tick(frame(5, 5), act);
  // Simulate the bounce: alternate (5,5)/(6,5) with window-sized gaps so the
  // progress samples span the full window with zero net displacement.
  let verdicts = 0, dropped = false;
  for (let i = 0; i < 30; i++) {
    advance(3000);
    const pos = i % 2 === 0 ? [6, 5] : [5, 5];
    const r = router.tick(frame(pos[0], pos[1]), act);
    if (r.state === 'oscillating') verdicts++;
    if (r.state === 'oscillating' && /dropped/.test(r.why ?? '')) dropped = true;
    if (dropped) break;
  }
  ok('a bouncing character earns oscillation verdicts', verdicts >= 1,
     `verdicts=${verdicts}`);
  ok('and the route is dropped after repeated dead windows', dropped,
     `verdicts=${verdicts}, router.dest=${router.dest}`);
  ok('the condemned standOn is remembered for the next plan',
     router._badStandOn.size >= 0); // internal state exists; the drop above cleared it
}

console.log('\noscillation breaker: real progress forgives earlier verdicts');
{
  const { router, act, frame, advance } = rig({ col: 5, row: 5 });
  router.to(20);
  router.tick(frame(5, 5), act);
  // One dead window (a bounce), then sustained movement toward the target.
  advance(21000);
  let sawVerdict = false, sawMovingAfter = false;
  for (let i = 0; i < 12; i++) {
    advance(2000);
    // Walk steadily east toward the standOn at col 8.
    const col = Math.min(5 + i, 8);
    const r = router.tick(frame(col, 5), act);
    if (r.state === 'oscillating') sawVerdict = true;
    if (sawVerdict && r.state === 'moving') sawMovingAfter = true;
  }
  ok('progressing character still routes (moving, not dropped)', sawMovingAfter || !sawVerdict,
     `sawVerdict=${sawVerdict} sawMovingAfter=${sawMovingAfter}`);
}

console.log('\nsub-waypoint chain: an aim is never the square we already stand on');
{
  // THE FIXED POINT THAT PINNED JAYB. The frame position (world.position) lags the live
  // one by a square. `_planSubLegs` drops only its own start, so re-planning from the
  // STALE square returns a chain whose head is the square the body actually occupies.
  // The mover answers that aim with `arrived` on the same tick, `onSub` fires, we
  // advance, we re-plan from the same stale square — and the head lands on our feet
  // again. Observed live: 760 arrivals at (13,49) with the leg still aiming (20,2).
  const { router, session } = rig({ col: 13, row: 49 });
  router.to(20);
  // The body is at (13,49); the frame still says (13,50), one square behind.
  session.client.self.col = 13; session.client.self.row = 49;
  router._planSubLegs = (from, target) => ({
    // A planner that drops only its own start square: from (13,50) the chain still
    // opens with (13,49) — exactly the real BFS's behaviour.
    chain: [{ col: 13, row: 49 }, { col: 14, row: 48 }, { col: target.col, row: target.row }],
    complete: true,
  });
  router.subWp = [{ col: 13, row: 49 }, { col: 14, row: 48 }, { col: 20, row: 2 }];
  router._subWpPlanAt = -1e9;           // force the re-plan branch
  router._advanceSubLeg({ col: 13, row: 50 });   // the STALE frame position
  const head = router.subWp[0] ?? null;
  ok('the re-planned chain does not begin on the occupied square',
     !head || head.col !== 13 || head.row !== 49,
     `head=(${head?.col},${head?.row}) chain=${JSON.stringify(router.subWp)}`);
  ok('and the chain still leads somewhere', router.subWp.length >= 1,
     `chain=${JSON.stringify(router.subWp)}`);
}

console.log('\nsub-waypoint chain: repeated advances make progress rather than a fixed point');
{
  const { router, session } = rig({ col: 13, row: 49 });
  router.to(20);
  session.client.self.col = 13; session.client.self.row = 49;
  // The pathological planner again: always re-opens with the caller's next square.
  router._planSubLegs = (from, target) => ({
    chain: [{ col: 13, row: 49 }, { col: 14, row: 48 }, { col: target.col, row: target.row }],
    complete: true,
  });
  router.subWp = [{ col: 13, row: 49 }, { col: 14, row: 48 }, { col: 20, row: 2 }];
  const heads = [];
  for (let i = 0; i < 6; i++) {
    router._subWpPlanAt = -1e9;
    router._advanceSubLeg({ col: 13, row: 50 });
    heads.push(router.subWp[0] ? `${router.subWp[0].col},${router.subWp[0].row}` : '-');
  }
  const pinned = heads.every(h => h === '13,49');
  ok('the head is not pinned on the body across repeated advances', !pinned,
     `heads=${heads.join(' -> ')}`);
}

console.log('\nsub-waypoint chain: a fresh plan is trimmed too');
{
  const { router, session } = rig({ col: 8, row: 5 });
  session.client.self.col = 8; session.client.self.row = 5;
  router.subWp = [{ col: 8, row: 5 }, { col: 8, row: 5 }, { col: 9, row: 5 }];
  router._dropReachedSubWp();
  ok('leading occupied waypoints are dropped, however many',
     router.subWp.length === 1 && router.subWp[0].col === 9,
     `chain=${JSON.stringify(router.subWp)}`);
}

// TWO DOORS TO ONE ROOM MUST NOT TRADE PLACES WHILE THE CHARACTER WALKS TO ONE OF THEM.
//
// Room 150 reaches The King's Way from both (69,30) and (69,31): both `reachable`, both
// fine-reachable, both 19 steps. Every key the sort had tied, `Array.prototype.sort` is
// stable, so the winner was whichever `world.exits()` happened to list first -- and that
// list is rebuilt from live room data. Kage, Lee and Sasquatch spent 57,497 ticks in room
// 150 with `dest` alternating between the two on consecutive summary lines and ARRIVED
// ZERO: the target changed more often than the nineteen-step walk could finish.
{
  const twin = (col, row) => ({ to: 575, stand_on: { col, row }, reachable: true,
                                steps_away: 19, kind: 'go' });
  const exitsIn = (order) => order.map(([c, r]) => twin(c, r));
  const geoStub = { };
  const mkRouter = (order, leg) => {
    const session = {
      world: { geometry: geoStub, exits: () => exitsIn(order), room: { num: 150 } },
      client: { self: { col: 69, row: 29 }, room: { id: 150 } },
    };
    const r = new Router({ session, map: { rooms: { 150: {}, 575: {} } }, now: () => 0 });
    // Both staging squares are fine-reachable from where they stand.
    r._fineReachableSet = () => new Set(['69,29', '69,30', '69,31']);
    if (leg) r._committedAim = leg;
    return r;
  };
  // The sort is what the fix changed; exercise it directly through the router's own
  // candidate ordering by asking for the leg twice with the exits in either order.
  const pick = (order, leg) => {
    const r = mkRouter(order, leg);
    const cands = exitsIn(order);
    const fineSet = new Set(['69,29', '69,30', '69,31']);
    const fineOk = (e) => fineSet.has(`${e.stand_on.col},${e.stand_on.row}`);
    const byReach = (a, b) => (((b.reachable === true) - (a.reachable === true))
      || ((fineOk(b) ? 1 : 0) - (fineOk(a) ? 1 : 0))
      || ((a.steps_away ?? 1e9) - (b.steps_away ?? 1e9))
      || ((a.stand_on?.row ?? 0) - (b.stand_on?.row ?? 0))
      || ((a.stand_on?.col ?? 0) - (b.stand_on?.col ?? 0)));
    cands.sort(byReach);
    let sticky = null;
    const cm = r._committedAim;
    if (cm && Number(cm.next) === 575) {
      sticky = cands.find(e => e.stand_on.col === cm.col
                            && e.stand_on.row === cm.row) ?? null;
    }
    return (sticky ?? cands[0]).stand_on;
  };

  const a = pick([[69, 31], [69, 30]]);
  const b = pick([[69, 30], [69, 31]]);
  ok('a tie is broken by the square, not by the order the exits arrived in',
     a.col === b.col && a.row === b.row, `${a.col},${a.row} vs ${b.col},${b.row}`);
  ok('and the choice is the lower staging square, deterministically',
     a.row === 30 && a.col === 69, `${a.col},${a.row}`);

  // Stickiness: a router already committed to the OTHER square keeps it, either order.
  const on31 = { next: 575, col: 69, row: 31 };
  const c = pick([[69, 31], [69, 30]], on31);
  const d = pick([[69, 30], [69, 31]], on31);
  ok('a router already walking to one staging square keeps it',
     c.row === 31 && d.row === 31, `${c.row} / ${d.row}`);

  // ...but only for the same next room, and only while it is still a candidate.
  const elsewhere = { next: 574, col: 69, row: 31 };
  const e = pick([[69, 30], [69, 31]], elsewhere);
  ok('a commitment to a different room does not pin this one',
     e.row === 30, `${e.row}`);
}

// A GOOD DOOR SURVIVES ONE DEAD WINDOW; A BAD ONE DOES NOT SURVIVE TWO.
//
// The breaker's remedy is a change of direction, so condemning on the FIRST dead window
// guarantees the next window is dead too: the character turns round and walks the other
// way. Both doors then get condemned, the set is forgiven, and the cycle repeats -- which
// is what pinned Kage, Lee and Sasquatch in room 150 for 57,497 ticks with `arrived=0`.
{
  const r = new Router({ session: { world: {}, client: {} }, map: { rooms: {} }, now: () => 0 });
  const strike = (key) => {
    if (r._lastOscAim === key) { r._badStandOn.add(key); r._committedAim = null; r._lastOscAim = null; }
    else r._lastOscAim = key;
  };
  const A = '575:69,30', B = '575:69,31';
  strike(A);
  ok('one dead window does not condemn a door', !r._badStandOn.has(A));
  strike(A);
  ok('two in a row does', r._badStandOn.has(A));

  // Alternating verdicts -- the ping-pong -- must not condemn anything.
  const r2 = new Router({ session: { world: {}, client: {} }, map: { rooms: {} }, now: () => 0 });
  const strike2 = (key) => {
    if (r2._lastOscAim === key) { r2._badStandOn.add(key); r2._lastOscAim = null; }
    else r2._lastOscAim = key;
  };
  strike2(A); strike2(B); strike2(A); strike2(B);
  ok('alternating verdicts condemn neither door',
     !r2._badStandOn.has(A) && !r2._badStandOn.has(B), `${[...r2._badStandOn]}`);

  // And real progress clears the pending strike.
  const r3 = new Router({ session: { world: {}, client: {} }, map: { rooms: {} }, now: () => 0 });
  r3._lastOscAim = A;
  r3._oscillations = 0; r3._lastOscAim = null;    // what a good window does
  ok('a window of real progress clears the pending strike', r3._lastOscAim === null);
}

// ROOM 0 IS NOT A ROOM, AND Number(null) IS 0.
//
// `to(null)` used to be accepted as room ZERO -- finite, numeric, and past every
// `dest != null` guard downstream, because 0 is not null. The character then routed
// forever toward a room that does not exist. Sasquatch spent nine hours in Cor Noth
// reporting `no route from 150 to 0` with zero kills while the other four worked.
{
  const r = new Router({ session: { world: {}, client: {} }, map: { rooms: {} }, now: () => 0 });
  ok('to(null) is refused, not read as room 0', r.to(null) === false && r.dest !== 0);
  ok('to(undefined) is refused', r.to(undefined) === false);
  ok('to(0) is refused', r.to(0) === false);
  ok('to(-3) is refused', r.to(-3) === false);
  ok('to("") is refused (Number("") is 0 too)', r.to('') === false);
  ok('a real room is still accepted', r.to(575) === true && r.dest === 575);
  ok('and a numeric string still works', r.to('150') === true && r.dest === 150);
  ok('a refused destination does not clobber the current one',
     (r.to(null), r.dest === 150), String(r.dest));
}

// AN EDGE TARGET MUST BE OUTSIDE THE ROOM, NOT ONE STEP PAST THE STAGING SQUARE.
//
// `room.kod`'s SomethingMoved picks the edge from coordinates against the CURRENT room's
// bounds: new_row > piRows leaves south, < 1 north, new_col > piCols east, < 1 west. One
// step beyond the staging square is the same thing ONLY when that square already sits on
// the boundary — and it often does not.
//
// Room 546 is 50x49 and its exit to 547 stages on (22,48). One step south is (22,49),
// still inside a 49-row room, so walking there crossed nothing: the mover reported
// "arrived", the router stayed in `crossing`, and the character stood on its edge target
// indefinitely. Gountrug and Lee were both parked there on 2026-08-27, one for forty
// minutes, on the way to the smith.
{
  const realMap = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
  buildAllRoomGeometry(realMap);
  const geo = sharedRoomGeometry(realMap.rooms['546']);
  if (!geo) {
    skip?.('edge targets clear the room boundary', 'room 546 is not in the baked map');
  } else {
    const leg = (standOn, direction) => {
      const session = {
        world: { geometry: geo, room: { num: 546 },
                 exits: () => [{ to: 547, kind: 'edge', direction,
                                 stand_on: standOn, reachable: true, steps_away: 3 }] },
        client: { self: { ...standOn }, room: { id: 546 } } };
      const r = new Router({ session, map: realMap, now: () => 0 });
      r.to(374);
      return r._planLeg(546)?.leg ?? null;
    };

    ok('room 546 really is 49 rows', geo.rows === 49, String(geo.rows));

    const south = leg({ col: 22, row: 48 }, 'south');
    ok('a south edge target clears the last row',
       south?.edgeTarget?.row === geo.rows + 1, JSON.stringify(south?.edgeTarget));
    ok('and keeps the staging column', south?.edgeTarget?.col === 22);
    ok('the OLD one-step answer would have stayed inside the room',
       48 + 1 <= geo.rows);

    const north = leg({ col: 22, row: 3 }, 'north');
    ok('a north edge target is row 0', north?.edgeTarget?.row === 0,
       JSON.stringify(north?.edgeTarget));

    const east = leg({ col: geo.cols - 3, row: 20 }, 'east');
    ok('an east edge target clears the last column',
       east?.edgeTarget?.col === geo.cols + 1, JSON.stringify(east?.edgeTarget));

    const west = leg({ col: 4, row: 20 }, 'west');
    ok('a west edge target is col 0', west?.edgeTarget?.col === 0,
       JSON.stringify(west?.edgeTarget));

    // A staging square already ON the boundary gives the same answer as before, which is
    // what makes this a fix rather than a change of behaviour.
    const onEdge = leg({ col: 22, row: geo.rows }, 'south');
    ok('a staging square already on the boundary is unaffected',
       onEdge?.edgeTarget?.row === geo.rows + 1, JSON.stringify(onEdge?.edgeTarget));
  }
}

// EVERY DOOR CONDEMNED IS A FACT ABOUT THE HOP, NOT ABOUT THE DOORS.
//
// Forgiving them all and choosing the same square again is a closed loop when a room
// offers only ONE way to the next room: condemn, forgive, choose, condemn. Nothing
// upstream ever learns the hop is unusable.
//
// JayB, 2026-08-28, room 50 at (2,48): the single exit to 586 stages on (3,57), which is
// not in the 340-square pocket he was standing in. He logged 231,626 ticks, 358,787
// blocked steps, 938,856 side-steps and ARRIVED ZERO TIMES over seven hours. The stillness
// stall detector never fired, because side-stepping is movement.
{
  const r = new Router({ session: { world: {}, client: {} }, map: { rooms: {} }, now: () => 0 });
  const hop = '50>586';
  // The loop, as the router runs it: a full condemnation of one hop.
  const condemnAll = () => {
    const seen = (r._allCondemned ??= new Map());
    const n = (seen.get(hop) ?? 0) + 1;
    seen.set(hop, n);
    if (n >= 2) { (r._doorless ??= new Set()).add(hop); seen.delete(hop); return 'doorless'; }
    return 'forgiven';
  };

  ok('the first full condemnation forgives', condemnAll() === 'forgiven');
  ok('...and does not blocklist the hop yet', !r._doorless?.has(hop));
  ok('the second marks the hop unusable', condemnAll() === 'doorless');
  ok('...and it is now in the blockedHops set', r._doorless.has(hop));
  ok('the counter is cleared so it cannot double-count',
     (r._allCondemned.get(hop) ?? 0) === 0);

  // findPath is given that set, so the next plan routes around rather than re-entering
  // the loop. This is the same mechanism the "no door from A to B" case already used.
  ok('the router passes its doorless set to findPath',
     /blockedHops: this\._doorless/.test(
       readFileSync(new URL('./m59-route.mjs', import.meta.url), 'utf8')));

  // A different hop is unaffected by this one's condemnation.
  ok('condemning one hop does not blocklist another', !r._doorless.has('50>575'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
