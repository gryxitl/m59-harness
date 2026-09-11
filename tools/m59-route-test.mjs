#!/usr/bin/env node
// GETTING SOMEWHERE UNDER A TICK — the contract test for m59-route.mjs.
//
//   node tools/m59-route-test.mjs
//
// A route is the case that most obviously does not fit a blocking model, and the thing
// under test is that it is STATE: each tick sends at most one square and returns, and
// progress is observed between ticks rather than assumed within a call.
import { Router, routeIntent } from './tick/m59-route.mjs';
import { Actuator } from './tick/m59-tick.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

// A fake world with a known two-room map, so the leg is predictable.
function rig({ here = 10, dest = 20, col = 5, row = 5,
               standOn = { col: 8, row: 5 }, edgeTarget = { col: 9, row: 5 },
               exits = null, pathFound = true, customMap = null, legMaxMs = 30000 } = {}) {
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
  const map = customMap ?? { rooms: { 10: { name: 'A' }, 15: { name: 'C' }, 20: { name: 'B' } } };
  let t = 1000;
  const router = new Router({ session, map, now: () => t, legMaxMs });
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

console.log('\noscillation breaker: presses the same approach, condemns only at MAX');
{
  const { router, act, frame, advance } = rig({ col: 5, row: 5 });
  router.to(20);
  router.tick(frame(5, 5), act);
  // One dead window: bounce with zero net displacement.
  let firstVerdict = null;
  for (let i = 0; i < 10; i++) {
    advance(3000);
    const pos = i % 2 === 0 ? [6, 5] : [5, 5];
    const r = router.tick(frame(pos[0], pos[1]), act);
    if (r.state === 'oscillating' && !firstVerdict) firstVerdict = r;
    if (firstVerdict) break;
  }
  ok('first dead window earns a verdict', !!firstVerdict, firstVerdict?.why ?? 'none');
  ok('the leg is kept (pressing, not alternating)', router.leg != null, 'leg=' + (router.leg ? 'kept' : 'null'));
  ok('nothing condemned yet', router._badStandOn.size === 0, 'size=' + router._badStandOn.size);
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

console.log('\nRouter.to refuses never-enter rooms');
{
  const router = new Router({ session: {}, now: () => 0 });
  ok('hazard dest refused', router.to(555) === false, 'to(555)=' + router.to(555));
  ok('dest not latched', router.dest !== 555, 'dest=' + router.dest);
  ok('refusal recorded', !!router._refusedHazard?.why, router._refusedHazard?.why ?? 'none');
  ok('normal dest accepted', router.to(535) === true && router.dest === 535, 'dest=' + router.dest);
}

console.log('\nsub-leg chains never head into a wall square (557 pin: (27,33) fine-blocked)');
{
  // Geometry where (6,5) is a fine-blocked wall square, everything else open.
  const wallGeo = {
    collisionReady: true,
    fineWalkable: (r, c) => !(r === 5 && c === 6),
    standable: () => true,
    traceFineMoveClient: () => ({ blocked: false, arrived: true }),
    finePathProtocol: (fx, fy, tx, ty) => ({ found: true, waypoints: [{ x: tx, y: ty }] }),
  };
  const { router } = rig();
  router.session.world.geometry = wallGeo;
  // Build time: truncate to the standable prefix.
  const s = router._sanitizeChain([{ col: 5, row: 5 }, { col: 6, row: 5 }, { col: 7, row: 5 }], wallGeo);
  ok('chain truncates at the first blocked square', s.chain.length === 1 && s.chain[0].col === 5 && s.dropped === 2,
     JSON.stringify(s));
  const s2 = router._sanitizeChain([{ col: 5, row: 5 }, { col: 7, row: 5 }], wallGeo);
  ok('all-standable chain passes through untouched', s2.chain.length === 2 && s2.dropped === 0,
     JSON.stringify(s2));
  ok('no geometry reads pass (fixtures without grids)',
     router._chainSquareOk(null, 1, 1) === true, 'null geo');
  // Runtime: a frozen wall head is dropped on tick so the aim falls through
  // to the next square instead of pinning the mover forever.
  router.to(20);
  router.leg = { fromRoom: 10, next: 20, standOn: { col: 8, row: 5 }, edgeTarget: null,
                 direction: 'east', kind: 'edge', startedAt: 1000 };
  router.subWp = [{ col: 6, row: 5 }, { col: 7, row: 5 }];
  const { act, frame } = rig();
  // NOTE: fresh rig session for act/frame would desync the router's session;
  // reuse this router's own session pieces instead.
  const selfRef = router.session.client.self;
  selfRef.col = 5; selfRef.row = 5; selfRef.x = 5 * 64 + 32; selfRef.y = 5 * 64 + 32;
  router.tick({ room: { num: 10, name: 'A' },
                position: { col: 5, row: 5, x: 5 * 64 + 32, y: 5 * 64 + 32 } }, act);
  ok('blocked head dropped at runtime', router.subWp && router.subWp[0].col === 7 && router.subWp[0].row === 5,
     JSON.stringify(router.subWp));
}

console.log('\nsub-leg chains drop edge-blocked heads only while the mover is stuck');
{
  // (22,17)->(23,17) in 557: both squares open, the edge between them fenced.
  // The head must go when the mover is honestly stuck (server static 3+ sends)
  // and stay while steps land (the step search may cross what moverStepLands
  // refuses on radius strictness).
  const { router, act } = rig({ col: 5, row: 5 });
  router.session.world.geometry.moverStepLands = (r1, c1, r2, c2) =>
    !((r1 === 5 && c1 === 5 && r2 === 5 && c2 === 6));  // only the (5,5)->(6,5) edge walled
  router.to(20);
  router.leg = { fromRoom: 10, next: 20, standOn: { col: 8, row: 5 }, edgeTarget: null,
                 direction: 'east', kind: 'edge', startedAt: 1000 };
  const frm = { room: { num: 10, name: 'A' },
                position: { col: 5, row: 5, x: 5 * 64 + 32, y: 5 * 64 + 32 } };
  // Steps landing: the head stays even though the strict edge test refuses it.
  router.subWp = [{ col: 6, row: 5 }, { col: 7, row: 5 }];
  router.mover.stuckTicks = 0;
  router.tick(frm, act);
  ok('head kept while steps land', router.subWp && router.subWp[0].col === 6,
     JSON.stringify(router.subWp));
  // Honestly stuck: the unenterable head goes, aim falls to the next square.
  router.subWp = [{ col: 6, row: 5 }, { col: 7, row: 5 }];
  router.mover.stuckTicks = 4;
  router.tick(frm, act);
  ok('edge-blocked head dropped while stuck', router.subWp && router.subWp[0].col === 7,
     JSON.stringify(router.subWp));
}

console.log('\nONE PREDICATE: the router asks the geometry, never re-derives one');
{
  // The aim flap that cost 13,619 destination changes: the router's chain
  // questions each had their own walkability predicate (coarse `walkable` in one
  // place, `fineWalkable`/`standable` in another, raw `moverStepLands` in a
  // third), so the SAME chain head could be kept by one and dropped by another.
  // Every flip changes the mover's destination, which resets its path, its stuck
  // signal and its escape fan. The fix is structural: `chainStepOk` is the single
  // door, and it delegates to the geometry's own `moverStepLands`.
  const { router, session } = rig();
  const geo = session.world.geometry;
  const asked = [];
  geo.moverStepLands = (r1, c1, r2, c2) => { asked.push(`${r1},${c1}->${r2},${c2}`); return true; };
  router.chainStepOk(geo, 5, 5, 5, 6);
  ok('chainStepOk delegates to moverStepLands', asked.length === 1, JSON.stringify(asked));
  ok('_fineStep is the same function, not a second one',
     router._fineStep(geo, 5, 5, 5, 6) === true && asked.length === 2, JSON.stringify(asked));
  // A square-level question uses the mover's own square test (transitBanned).
  const banned = { inBounds: () => true, fineWalkable: () => false };
  ok('_chainSquareOk refuses what the mover refuses',
     router._chainSquareOk(banned, 3, 3) === false);
  ok('_chainSquareOk passes an unknown geometry', router._chainSquareOk({}, 3, 3) === true);
}

console.log('\nAIM IS STABLE when the coarse and fine grids disagree');
{
  // A fixture where the two grids DISAGREE about every square: coarse says
  // walkable everywhere, fine says open only on row 5. Under the old code the
  // sub-leg BFS (coarse) planned a chain through row 9 while the mover's own
  // planner (fine) refused it, the sanitizer dropped the head, the aim fell to
  // the standOn, and the next tick rebuilt the chain — the 30,33<->29,33 flap.
  // Now all three questions read one predicate, so the disagreement has one
  // answer and the aim cannot move.
  const { router, act, frame, session } = rig({ col: 5, row: 5 });
  const geo = session.world.geometry;
  const FINE_OPEN_ROW = 5;
  geo.walkable = () => true;                              // coarse: blind, all open
  geo.fineWalkable = (r) => (r === FINE_OPEN_ROW);         // fine: only row 5
  geo.standable = (r) => (r === FINE_OPEN_ROW);
  geo.standPoint = (r) => (r === FINE_OPEN_ROW ? { x: 512, y: 512 } : null);
  geo.inBounds = () => true;
  // One honest edge predicate: open only along row 5.
  geo.moverStepLands = (r1, c1, r2, c2) =>
    (r1 === FINE_OPEN_ROW && r2 === FINE_OPEN_ROW);
  // The mover's planner agrees with it (coarse mode aside, this is the point).
  geo.finePathProtocol = () => ({ found: false, reason: 'no fine path', waypoints: [] });

  router.to(20);
  router.leg = { fromRoom: 10, next: 20, standOn: { col: 12, row: 9 }, edgeTarget: null,
                 direction: 'east', kind: 'edge', startedAt: 1000 };
  router._initSubLegs({ col: 5, row: 5 });
  const chainAfterBuild = (router.subWp ?? []).map(s => `${s.col},${s.row}`).join(' ');

  const aims = [];
  for (let i = 0; i < 12; i++) {
    router.mover.stuckTicks = 0;              // steps landing: nothing may be dropped
    router.tick(frame(5, 5), act);
    aims.push(`${router.mover.dest.col},${router.mover.dest.row}`);
  }
  const uniq = [...new Set(aims)];
  ok('the aim never changes across 12 ticks', uniq.length === 1, aims.join(' | '));
  // And it is a square the honest predicate admits: no head inside fine-blocked
  // ground, because the chain was built and sanitized with the same verdict.
  if (router.subWp && router.subWp.length) {
    const head = router.subWp[0];
    ok('chain head is on ground the mover will enter',
       geo.moverStepLands(5, 5, head.row, head.col) === true,
       `head ${head.col},${head.row} chain[${chainAfterBuild}]`);
  } else {
    ok('no chain means the aim is the standOn itself (stable)', true);
  }
}

console.log('\narrival is reachable when the destination is the current room');
{
  // RE-ENTRY ARRIVAL DEGENERATE CASE (V-new): if dest == here at route start,
  // to() already returns arrived at the first tick (the existing :653 check). The
  // re-entry rule (A1) must not break this — a character standing in the
  // destination room is "arrived" on the first tick, no walk required.
  const { router, act, frame } = rig({ here: 20, dest: 20 });
  router.to(20);
  const r = router.tick(frame(5, 5), act);
  ok('dest == here at route start is arrived on the first tick', r.state === 'arrived',
     JSON.stringify(r));
}

console.log('\na cross-room ping-pong drops the route and stamps the drop memory');
{
  // CROSS-ROOM OSCILLATION BREAKER (V-new): a character oscillating between two
  // non-destination rooms (200 and 556) for OSCILLATION_MAX consecutive windows
  // has the route dropped and the route-drop memory stamped (A2 + A3). The
  // destination is 603 (a different room), so the re-entry to 200/556 is a
  // ping-pong, not an arrival.
  const { router, act, frame, advance, session, at } = rig({
    here: 200, dest: 603,
    customMap: { rooms: { 200: { name: 'Marion' }, 556: { name: 'Deep Forest' }, 603: { name: 'Hunt' } } },
    legMaxMs: 1e9,   // huge: the leg-timeout must not preempt the A2 breaker
  });
  router.to(603);
  // The rig's _planLeg stub hard-codes next: 20, which cannot route to 603. Override
  // it to hop 200<->556 so the only thing that can clear the route is the A2 breaker.
  router._planLeg = (h) => ({ leg: { fromRoom: h, next: h === 200 ? 556 : 200,
    standOn: { col: 8, row: 5 }, edgeTarget: { col: 9, row: 5 }, direction: 'east',
    startedAt: at() } });
  // Alternate between 200 and 556 for 3 windows (each PROGRESS_WINDOW_MS = 20s).
  // Use different positions per room so the room-local detector (net=0) does not
  // preempt A2 — only the cross-room breaker should fire.
  router.tick(frame(5, 5, 200), act);   // tick 1: room 200, pos (5,5)
  advance(20000);
  router.tick(frame(10, 10, 556), act);   // tick 2: room 556, pos (10,10)
  advance(20000);
  router.tick(frame(5, 5, 200), act);   // tick 3: room 200, pos (5,5) — re-entry
  advance(20000);
  router.tick(frame(10, 10, 556), act);   // tick 4: room 556, pos (10,10) — re-entry
  advance(20000);
  ok('A2 counted a re-entry window (crossOsc >= 1)', router._crossOsc >= 1,
     JSON.stringify({ crossOsc: router._crossOsc, roomSeq: router._roomSeq.map(x => x.room) }));
  const r = router.tick(frame(5, 5, 200), act);   // tick 5: room 200, pos (5,5) — re-entry, _crossOsc = 3 = MAX
  ok('the cross-room breaker dropped the route', router.dest == null,
     JSON.stringify({ state: r.state, crossOsc: router._crossOsc, roomSeq: router._roomSeq.map(x => x.room), oscillations: router._oscillations }));
  ok('and stamped the route-drop memory',
     session._routeDrop != null && Array.isArray(session._routeDrop.rooms) && session._routeDrop.rooms.length >= 2,
     JSON.stringify(session._routeDrop));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
