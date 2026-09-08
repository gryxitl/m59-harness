#!/usr/bin/env node
// m59-mover-test.mjs -- the contract test for the fine-model mover.
//
//   node tools/m59-mover-test.mjs
//
// The critical case: a room whose square CENTRES are all clear but which
// has an impassable wall SEGMENT across the middle. The coarse planner
// gets this wrong (it sees no blocked squares); the fine model routes
// around the segment.

import { Mover, MOVEUNITS_PROTO } from './tick/m59-mover.mjs';
import { readFileSync } from 'node:fs';
import { Pose } from './tick/m59-pose.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

// A fake geometry with a wall segment across the middle.
// The wall is at x = 4096 client units (between col 4 and 5), y=0 to y=4096.
// finePathProtocol uses traceFineMoveClient for its clear() check.
function wallGeometry() {
  const WALL_X = 4096;
  const WALL_HALF = 64;
  const WALL_Y0 = 0;
  const WALL_Y1 = 4 * 1024;

  function crossesWall(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    if (Math.abs(dx) > 0.001) {
      const t = (WALL_X - x0) / dx;
      if (t > 0 && t < 1) {
        const crossY = y0 + t * dy;
        if (crossY >= WALL_Y0 && crossY <= WALL_Y1) return true;
      }
    }
    if (Math.abs(x1 - WALL_X) < WALL_HALF && y1 >= WALL_Y0 && y1 <= WALL_Y1) return true;
    if (Math.abs(x0 - WALL_X) < WALL_HALF && y0 >= WALL_Y0 && y0 <= WALL_Y1) return true;
    return false;
  }

  return {
    collisionReady: true,
    traceFineMoveClient(x0, y0, x1, y1, { slide = false } = {}) {
      if (crossesWall(x0, y0, x1, y1)) {
        if (!slide) return { blocked: true, moved: false, arrived: false, x: x0, y: y0 };
        const slideX = x0 < WALL_X ? WALL_X - WALL_HALF : WALL_X + WALL_HALF;
        return { blocked: true, moved: true, arrived: false, x: slideX, y: y1, slid: true };
      }
      return { blocked: false, moved: true, arrived: true, x: x1, y: y1 };
    },
    finePathProtocol(fromX, fromY, toX, toY, { step = 8, margin = 768, maxNodes = 20000 } = {}) {
      // Convert to client units (protocolToClient: (x-64)*16)
      const p2c = x => (x - 64) * 16;
      const c2p = x => x / 16 + 64;
      const fx = p2c(fromX), fy = p2c(fromY), tx = p2c(toX), ty = p2c(toY);

      // Fast path: direct line clear?
      if (!crossesWall(fx, fy, tx, ty)) {
        return { found: true, waypoints: [{ x: toX, y: toY }], expanded: 0 };
      }

      // A*: search for a path around the wall.
      // The wall is at x=4096, y=0..4096. To go around, we need to
      // go to y > 4096 (north) or y < 0 (south, but bounded).
      // Go north: waypoint at (tx, 5000) then (tx, ty).
      // Check if (fx,fy) -> (fx,5000) -> (tx,5000) -> (tx,ty) is clear.
      const detourY = 5000; // client units, above the wall
      const leg1 = !crossesWall(fx, fy, fx, detourY);
      const leg2 = !crossesWall(fx, detourY, tx, detourY);
      const leg3 = !crossesWall(tx, detourY, tx, ty);
      if (leg1 && leg2 && leg3) {
        const wp1 = { x: Math.round(c2p(fx)), y: Math.round(c2p(detourY)) };
        const wp2 = { x: Math.round(c2p(tx)), y: Math.round(c2p(detourY)) };
        return { found: true, waypoints: [wp1, wp2, { x: toX, y: toY }], expanded: 3 };
      }
      return { found: false, reason: 'no fine path', waypoints: [], expanded: 0 };
    },
  };
}

// No-wall geometry: everything is clear.
function clearGeometry() {
  return {
    collisionReady: true,
    traceFineMoveClient(x0, y0, x1, y1) {
      return { blocked: false, moved: true, arrived: true, x: x1, y: y1 };
    },
    finePathProtocol(fromX, fromY, toX, toY) {
      return { found: true, waypoints: [{ x: toX, y: toY }], expanded: 0 };
    },
  };
}

// The mover's waits are wall-clock (the 1.5s fan echo-patience, the 1s send gate),
// and a rig that ticks 200 times in a millisecond can never get past an echo wait —
// it reads 'waiting' on every tick and reports a loop that does not exist live. So the
// rig drives a virtual clock: `clock(ms)` moves real time forward for the mover.
let CLOCK_MS = 0;
const REAL_NOW = Date.now;
Date.now = () => CLOCK_MS + REAL_NOW.call(Date);
const clock = (ms) => { CLOCK_MS += ms; };

function rig({ col = 2, row = 2, destCol = 8, destRow = 2, geo } = {}) {
  const sent = [];
  const session = {
    name: 'test', live: true,
    client: {
      state: 'game',
      self: { col, row, x: col * 64 + 32, y: row * 64 + 32 },
      moveTo: (x, y) => { sent.push([x, y]); },
      moveToSquare: (col, row) => { sent.push([col * 64 + 32, row * 64 + 32]); },
      moveSpeed: () => 1,
      room: { id: 1 },
      stand: () => sent.push({ stand: true }),
    },
    pacer: { depth: 0, submit: (k, fn) => { fn(); return Promise.resolve(); } },
    walkTo: (col, row) => { sent.push([col * 64 + 32, row * 64 + 32]); return Promise.resolve({ arrived: true }); },
    world: { geometry: geo ?? wallGeometry() },
  };
  // No Pose by default. Production always wires one, but a rig that hands the mover a
  // Pose without a server behind it freezes the echo: Pose.server never moves, so
  // _noteServerStatic is right to call the server static and the mover goes stuck after
  // five honest sends. Tests that need a position truth build their own Pose and feed
  // updateServer by hand (see the arrival tests); the multi-tick route test runs a fake
  // server via fakeServer() below.
  const mover = new Mover(session, { reportIntervalMs: 0, moveCapMs: 0 });  // the rig ticks in microseconds; the 1s client gate is a LIVE constraint
  return { mover, sent, session, clock };
}

// Advance the fake position to match the last sent move. This is the CLIENT's own
// view (client.self is what the client declares), NOT a server echo: the rig has no
// server and must not fabricate one. Feeding the Pose's server echo from our own sends
// makes every send look confirmed, which commits arrival after a single packet and
// hides the exact stall the mover exists to detect. Tests that need a confirmation
// call session._pose.updateServer(...) by hand, as the arrival tests above do.
function advance(session, sent) {
  for (const s of sent) {
    if (Array.isArray(s) && s.length === 2) {
      session.client.self.x = s[0];
      session.client.self.y = s[1];
      session.client.self.col = Math.floor((s[0] - 32) / 64);
      session.client.self.row = Math.floor((s[1] - 32) / 64);
    }
  }
  sent.length = 0;
}

// A fake server for the tests that walk a route over many ticks: gives the session a
// Pose and returns the tick hook that echoes what the client declared, one tick late.
// A real server confirms the position it accepted; without that confirmation no route
// can ever be seen to arrive. Tests that want to study a STALL must not call this.
function fakeServer(session) {
  session._pose = new Pose();
  session._pose.updateServer({ ...session.client.self });
  // The rig's moveTo only records the packet; nothing moves the character. A server that
  // accepts a position moves the character there, so install that here — otherwise every
  // walk ends 'stuck' for a reason that has nothing to do with the mover.
  const c = session.client.self;
  const apply = (x, y) => {
    c.x = x; c.y = y;
    c.col = Math.floor(x / 64); c.row = Math.floor(y / 64);
  };
  if (session._serverAccepts !== false) {
    const rawMove = session.client.moveTo, rawSquare = session.client.moveToSquare;
    session.client.moveTo = (x, y) => { apply(x, y); return rawMove(x, y); };
    session.client.moveToSquare = (col, row) => { apply(col * 64 + 32, row * 64 + 32); return rawSquare(col, row); };
  }
  return () => { session._pose.updateServer({ ...session.client.self }); };
}

console.log('one tick moves at most MOVEUNITS');
{
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  mover.to(4, 2); // same row, 2 squares away
  const r = mover.tick();
  ok('it reports moving or planning', r.state === 'moving' || r.state === 'planning', r.state + ' ' + (r.why ?? ''));
  if (r.state === 'moving') {
    ok('exactly one step went out', sent.length === 1, `sent: ${JSON.stringify(sent)}`);
    if (sent.length === 1) {
      const [px, py] = sent[0];
      const meX = 2 * 64 + 32, meY = 2 * 64 + 32;
      const destX = 6 * 64 + 32, destY = 2 * 64 + 32;
      // The waypoint should be toward the destination,
      // not a tiny step. Check it's in the right direction.
      const toWp = { x: px - meX, y: py - meY };
      const toDest = { x: destX - meX, y: destY - meY };
      const dot = toWp.x * toDest.x + toWp.y * toDest.y;
      ok(`step is toward destination (dot=${dot.toFixed(0)} > 0)`, dot > 0,
         'waypoint is not toward the destination');
    }
  }
}

console.log('\nthe wall segment: route goes around it');
{
  // Character at (2,2), destination at (8,2).
  // The wall is at x=4096 (between col 4 and 5), y=0 to y=4096.
  // A straight line crosses the wall. finePathProtocol should
  // return a path that goes around (north, y > 4096).
  const { mover, sent, session } = rig();
  const echo = fakeServer(session);
  mover.to(8, 2);

  let states = [];
  let crossedWall = false;
  const path = [];

  for (let i = 0; i < 200; i++) {
    clock(1600);   // one live tick per second: past the fan's 1.5s echo-patience
    echo();
    const r = mover.tick({ col: session.client.self.col, row: session.client.self.row, x: session.client.self.x, y: session.client.self.y });
    states.push(r.state);
    if (r.state === 'arrived') break;
    if (r.state === 'no-route' || r.state === 'search-exhausted' || r.state === 'stuck') break;

    // Track the path in client units.
    advance(session, sent);
    const cx = (session.client.self.x - 64) * 16;
    const cy = (session.client.self.y - 64) * 16;
    path.push({ x: cx, y: cy });

    // Check if the path crossed the wall.
    if (path.length >= 2) {
      const prev = path[path.length - 2];
      const dx = cx - prev.x;
      if (Math.abs(dx) > 0.001) {
        const t = (4096 - prev.x) / dx;
        if (t > 0 && t < 1) {
          const crossY = prev.y + t * (cy - prev.y);
          if (crossY >= 0 && crossY <= 4096) crossedWall = true;
        }
      }
    }
  }

  const arrived = states.includes('arrived');
  ok('the mover routed around the wall (arrived)', arrived,
     `states: ${[...new Set(states)].join(', ')}`);
  ok('the mover did NOT cross the wall segment', !crossedWall,
     `path length: ${path.length}`);
}

console.log('\nno wall: straight line works');
{
  const { mover, sent, session } = rig({ destCol: 4, geo: clearGeometry() });
  mover.to(4, 2);
  const r = mover.tick();
  ok('it reports moving or planning', r.state === 'moving' || r.state === 'planning', r.state);
}

console.log('\nsitting trap: stand before move');
{
  // Step engine (ownPhysics off): standing is its own tick, and nothing moves until
  // the character is on its feet.
  const { mover, sent } = rig({ geo: clearGeometry() });
  mover.to(4, 2);
  mover.markSitting();
  const r = mover.tick();
  ok('first tick stands', r.state === 'standing', r.state);
  ok('a stand was issued', sent.some(x => x && x.stand === true), JSON.stringify(sent).slice(0, 60));
  ok('no move sent while sitting', !sent.some(x => Array.isArray(x)), JSON.stringify(sent).slice(0, 60));
  const r2 = mover.tick();
  ok('second tick moves or plans', r2.state === 'moving' || r2.state === 'planning', r2.state);
}
{
  // The policy flag cannot change the engine any more: there is one engine, and
  // standing is its own tick. This test exists to pin that — a policy that used to
  // select the other engine must now be inert.
  const { mover, sent } = rig({ geo: clearGeometry() });
  // THESE FIVE BLOCKS ARE ESCAPE-PATH TESTS, NOT ENGINE TESTS, AND SAYING SO IS THE FIX.
  //
  // The task this file was written for asked that the five `ownPhysics` blocks each assert
  // velocity-specific behaviour. They cannot, and the reason is worth recording because it is a
  // fact about the mover rather than an oversight: all five drive geometries that refuse the
  // direct path (a pocket, a void, a leafless point, a fine-blocked exit). Those are the
  // situations where the velocity declaration is SUPPOSED not to fire — the integration stops at
  // the wall and the escape fan takes the tick. Measured, the first send out of the first of them
  // travels ZERO units: it is a fan probe, not a stride. An assertion that a fan probe declares a
  // stride would be a false assertion written to satisfy a sentence.
  //
  // WHERE THE ENGINE IS ASSERTED — WITH NUMBERS ACTUALLY MEASURED, NOT REMEMBERED.
  //
  // An earlier draft of this comment claimed that disabling the velocity declaration took THIS
  // suite from 121 to 112 with nine named failures, and named 'exactly one step went out' and
  // 'the mover routed around the wall' among them. That was false, and an independent audit
  // tried the mutation and got 123/0 — no failures at all. The two assertions named as living
  // here are in the ROUTE suite, and the route suite does not move either. The claim was
  // reproduced from a tree that no longer exists and then copied forward as though it were a
  // measurement. A falsification number that cannot be reproduced is worse than no number,
  // because it closes the question.
  //
  // Re-measured tonight on the current tree, both ways the auditor tried:
  //
  //   mutation                              mover  route  locomotion  tick  decide  frame  pose
  //   baseline                              123/0  53/0    27/0        41/0   72/0    52/0   46/0
  //   declaration gated off (if (false))    123/0  53/0    24/3        41/0   72/0    52/0   46/0
  //   _integrateToward forced to zero      118/5   53/0    22/5        41/0   72/0    52/0   46/0
  //
  // So the honest statement is narrower than the one I made: the engine is asserted by
  // `m59-locomotion-test` in both mutations, and by `m59-mover-test` ONLY when the integration
  // itself is broken — five failures, which are the wall-stop and stride assertions. Gating the
  // SEND off leaves this suite entirely untouched, because every geometry in it that reaches the
  // declaration also has a step-engine route to the same answer, and a test that passes under
  // both engines is not a test of either.
  //
  // THAT IS A GAP, NOT A VERDICT. If the declaration is meant to be the engine, deleting it must
  // break something that is about the declaration. The five mover-test failures that do appear
  // when the integration is zeroed are the closest thing there is, and `m59-locomotion-test`
  // carries the rest. What is missing is an assertion here that a packet carries a STRIDE rather
  // than a square on open ground — which is the whole point of the engine and is currently only
  // provable in the locomotion suite. It is named rather than left implied.
  //
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(4, 2);
  mover.markSitting();
  const r = mover.tick();
  ok('the removed engine flag does not resurrect it — standing is still its own tick',
    r.state === 'standing', r.state);
  ok('a stand was issued', sent.some(x => x && x.stand === true), JSON.stringify(sent).slice(0, 60));
}

console.log('\nclear stops the mover');
{
  const { mover } = rig({ geo: clearGeometry() });
  mover.to(4, 2);
  mover.clear();
  ok('inactive after clear', !mover.active);
  const r = mover.tick();
  ok('idle when clear', r.state === 'idle');
}

console.log('\nno fine path: falls back to direct step');
{
  // Geometry where finePathProtocol reports "no fine path".
  // The mover should still move: it falls back to a direct
  // step toward the destination (client-authoritative).
  const noPathGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'no fine path', waypoints: [] }; },
  };
  const { mover, sent, session } = rig({ geo: noPathGeo });
  mover.to(4, 2);
  const r = mover.tick();
  ok('still moves (client-authoritative)', r.state === 'moving', r.state + ' ' + (r.why ?? ''));
  ok('a step was sent', sent.length === 1, JSON.stringify(sent));

  const exhaustGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'fine path search budget exhausted', waypoints: [], expanded: 20000 }; },
  };
  const { mover: m2, sent: s2 } = rig({ geo: exhaustGeo });
  m2.to(4, 2);
  const r2 = m2.tick();
  ok('search-exhausted: still moves', r2.state === 'moving', r2.state);
  ok('a step was sent', s2.length === 1, JSON.stringify(s2));
}

console.log('\nPHASE 0a: NO hold gate (ownPhysics on)');
{
  // Server model (user.kod UserMove): the server ACCEPTS the declared
  // position per packet and never interpolates — there is no carry, so
  // holding after one step freezes. Every tick re-declares (live: gated
  // to 1/s by the send law, cheat-clean).
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  session.policy = { ownPhysics: true };
  mover.to(4, 2); // 2 squares away
  const r1 = mover.tick();
  ok('first tick: sends a move', r1.state === 'moving', r1.state);
  ok('exactly one move sent', sent.length === 1, JSON.stringify(sent));
  // THE SERVER CARRIES THE CHARACTER, AND THIS RIG USED TO DENY IT WHILE DOING IT.
  //
  // The comment here used to read 'the server records the declared position; it does not carry
  // the character there', and the four lines under it moved the character 16 units toward the
  // aim — which is carrying. A rig that contradicts itself in consecutive lines is not a spec.
  //
  // The server's actual law is in m59-game.mjs:207-222, worked out from move.c:184/49/53 and
  // draw3d.h:53: MOVEUNITS is FINENESS>>2 = 256 CLIENT units per MOVE_DELAY = 100 ms, so walking
  // is 2560 client units/s = 2.5 squares/s, and move.c:59 reports to the server at most once per
  // MOVE_INTERVAL = 1000 ms. One packet therefore covers about five squares of ground. The
  // sentence in that file is the thing this rig got backwards: 'one packet covering about five
  // squares, not five packets covering one square each.'
  //
  // In protocol units, which is what this rig speaks, 256 client units is 16 per 100 ms — so the
  // 16 that was already here is the right NUMBER for the wrong reason, and it is the distance the
  // character covers in a tenth of the interval between reports. Carrying it once per tick is
  // what a tick is worth.
  if (sent.length === 1) {
    const aimX = sent[0][0], aimY = sent[0][1];
    const meX = session.client.self.x, meY = session.client.self.y;
    const dx = aimX - meX, dy = aimY - meY;
    const dist = Math.hypot(dx, dy) || 1;
    const step = Math.min(dist, 16); // MOVEUNITS per MOVE_DELAY, in protocol units
    session.client.self.x = meX + (dx / dist) * step;
    session.client.self.y = meY + (dy / dist) * step;
    session.client.self.col = Math.floor((session.client.self.x - 32) / 64);
    session.client.self.row = Math.floor((session.client.self.y - 32) / 64);
  }
  sent.length = 0;
  const r2 = mover.tick();
  // A STRIDE CAN FINISH THE JOB. The first send declared 160 protocol units — two and a half
  // squares — and the server carried the character along it, so on the second tick the mover
  // correctly sees itself at the destination and says so. Asserting 'moving' here was the step
  // model talking: when one packet covered one square, a two-square trip always needed a second.
  ok('second tick: either re-sends or arrives, and never holds', r2.state !== 'hold', r2.state + ' hold=' + r2.hold);
  ok('a second move was sent only if the trip is not over',
     (r2.state === 'arrived' && sent.length === 0) || sent.length === 1,
     JSON.stringify(sent) + ' ' + r2.state);
  // The server accepts the trip: advance the fake server position onto the
  // destination square (echoes confirm what our sends declared).
  session.client.self.x = 4 * 64 + 32;
  session.client.self.y = 2 * 64 + 32;
  session.client.self.col = 4;
  session.client.self.row = 2;
  sent.length = 0;
  const r3 = mover.tick();
  // Arrival requires SERVER confirmation, never the sim alone: the sim covers
  // the trip after 1-2 sends, but only the server's echo commits it. Judging
  // arrival on the sim fires while refused sends pile up, and the clear()
  // wipes fan/path/stuck into a perpetual pseudo-progress loop.
  ok('third tick: arrived (server confirmed it)', r3.state === 'arrived', r3.state + ' hold=' + r3.hold);
  ok('no third move needed', sent.length === 0, JSON.stringify(sent));
}
{
  // REGRESSION (the pseudo-progress loop): the sim covers the destination
  // after sends go out, but the SERVER never moves (every send refused).
  // Arrival must NOT fire — firing clear()s fan/path/stuck and the driver
  // re-aims forever with a static position. Instead the mover keeps sending
  // (so stuckTicks can accumulate and the fan/blink escalate).
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(4, 2); // 2 squares away
  mover.tick(); // send 1 (server refuses: self never advances)
  sent.length = 0;
  mover.tick(); // send 2 (sim now covers the trip; server still behind)
  sent.length = 0;
  const r3 = mover.tick();
  ok('no false arrival while the server never moved', r3.state !== 'arrived', r3.state);
  ok('mover state survives (no clear)', mover.dest != null && mover.dest.col === 4, JSON.stringify(mover.dest));
}
{
  // RESPONSIVE ARRIVAL: with echo tracking, sim-near plus a server that
  // visibly moved toward this destination commits immediately — no echo wait.
  // (Without corroboration this would be the pseudo-progress loop above.)
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  session._pose = new Pose();
  session._pose.updateServer({ col: 2, row: 2, x: 160, y: 160 });
  mover.session.policy = {};
  mover.to(4, 2);
  // THE CONTRACT IS 'ARRIVAL IS REPORTED ONCE THE ECHO CONFIRMS US AT THE DESTINATION', not 'arrival
  // is reported on the third tick'. The tick count here was written when Pose.advance's seed branch
  // crawled one square per send, so the sim needed three sends to reach square 4 and the third tick
  // happened to be the one that reported it. With the seed going to the declaration — which is what
  // the server does with a move, measured from the echo — the sim is at the destination after one
  // send and arrival is reported two ticks earlier. Asserting a tick count turned a correct
  // acceleration into a failure, and it had been passing only because the assertion that would have
  // caught the crawl was itself unbreakable (ok('message', cond) in a suite whose signature is
  // ok(cond, msg)). Collect the states across the confirmations instead:
  const states = [];
  for (let i = 0; i < 3; i++) {
    states.push(mover.tick().state);
    if (i === 0) session._pose.updateServer({ col: 3, row: 2, x: 224, y: 160 }); // echo confirms
    if (i === 1) session._pose.updateServer({ col: 4, row: 2, x: 288, y: 160 }); // echo confirms
  }
  ok('tracked arrival commits on confirmation', states.includes('arrived'), states.join(' -> '));
  const after = states.length;
  sent.length = 0;
  const r = mover.tick();
  ok('no extra send after arrival', sent.length === 0, JSON.stringify(sent));
  ok('and the destination is dropped once arrived', r.state === 'idle' || r.state === 'arrived',
     `${r.state} after ${after} ticks: ${states.join(' -> ')}`);
}

console.log('\nPHASE 0a: the hold gate is off by default (ownPhysics off)');
{
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  // No policy.ownPhysics — the default step model.
  mover.to(4, 2);
  const r1 = mover.tick();
  ok('first tick: sends a move', r1.state === 'moving', r1.state);
  ok('exactly one move sent', sent.length === 1, JSON.stringify(sent));
  advance(session, sent);
  const r2 = mover.tick();
  // WHAT THIS RIG IS FOR IS 'NO HOLD', NOT 'MUST RE-SEND'.
  //
  // It used to assert `state === 'moving'` on the second tick, which was the step model talking:
  // back when one packet moved the character one square, a two-square trip could not finish in
  // one send and a second send was guaranteed. The mover now declares a stride — 160 protocol
  // units, two and a half squares — and the server carries the character along the declaration
  // (m59-game.mjs:207-222: MOVEUNITS = 256 client units per MOVE_DELAY = 100 ms, reported at most
  // once per MOVE_INTERVAL = 1000 ms, so one packet covers about five squares). A two-square trip
  // can legitimately be over, and `arrived` is then the right answer, not a regression.
  //
  // The thing that would be a regression is a HOLD: a mover that goes silent while the character
  // is short of its destination. That is what the title of this block names and what the
  // assertion now checks, directly, in both shapes.
  ok('second tick: no hold — it moves or it arrives', r2.state !== 'hold' && r2.hold !== true, r2.state);
  ok('a second move was sent unless the stride already arrived',
     (r2.state === 'arrived' && sent.length === 0) || sent.length === 1,
     JSON.stringify(sent) + ' ' + r2.state);
}

console.log('\nblocked direct path: the escape fan takes over');
{
  // One engine, so there is no on/off pair any more — just the escalation. A blocked
  // trace to the DESTINATION is not a blocked step: the mover names one ADJACENT square
  // per send, so it first tries the square next to it (the raw door push, which exists
  // because the fine model is wrong about door alcoves). Only when that stops moving
  // the character does the escape fan start probing headings.
  const wallGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'wall', waypoints: [] }; },
    standable: () => true,
    fineWalkable: () => true,
  };
  const { mover, sent, session } = rig({ geo: wallGeo });
  session._serverAccepts = false;   // sends go out and nothing moves: that is the situation under test
  const echo = fakeServer(session);
  mover.to(4, 2); // 2 squares away, direct path blocked
  const r1 = mover.tick();
  ok('first tick tries the adjacent square, not a fan', r1.state === 'moving', r1.state + ' ' + (r1.why ?? ''));
  ok('the send is the adjacent square centre', JSON.stringify(sent) === '[[224,160]]', JSON.stringify(sent));
  let fan = null;
  for (let i = 0; i < 14 && fan == null; i++) {
    clock(1600); echo();
    const r = mover.tick();
    if (r.state === 'raw-move') fan = r.fanIndex;
    if (r.state === 'stuck' || r.state === 'arrived') break;
  }
  ok('a character that is not moving escalates to the escape fan', fan != null, `fanIndex=${fan}`);
  ok('the fan starts at heading 0', fan === 0, String(fan));
}
console.log('\nTHE 5s ANTI-DEADLOCK FLOOR (the gate/fan stall fix)');
{
  // The exact stall: a step that is CLOSE to the server (movedEnough=false)
  // must still open the gate once 5s have passed since the last report.
  const { mover } = rig({ geo: clearGeometry() });
  const serverX = 2 * 64 + 32, serverY = 2 * 64 + 32;
  // Step is 8 proto units from the server (64 < 256 threshold => movedEnough false).
  const stepX = serverX + 8, stepY = serverY;
  // Fresh last report: floor closed, movedEnough false => gate closed.
  mover._lastReportAt = Date.now();
  ok('fresh report + close step => gate CLOSED', mover._movementGateOk(stepX, stepY, serverX, serverY, serverX, serverY) === false);
  // 6s since last report: floor open => gate open even though movedEnough is false.
  mover._lastReportAt = Date.now() - 6000;
  ok('6s since report + close step => gate OPEN (floor fires)', mover._movementGateOk(stepX, stepY, serverX, serverY, serverX, serverY) === true);
}
{
  // Full-tick: a pocketed character (fresh mover, no prior report) must send
  // within a bounded number of ticks. The floor (lastReportAt=0) opens the gate
  // on the first fan-branch tick, so the character cannot sit at sends=0.
  const wallGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'pocket', waypoints: [] }; },
    fineWalkable() { return false; },  // the start square is not walkable => escape fan
  };
  const { mover, sent } = rig({ geo: wallGeo });
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(4, 2);
  let sendsOut = 0;
  for (let i = 0; i < 12; i++) {
    mover.tick();
    sendsOut = sent.length;
    if (sendsOut > 0) break;
  }
  ok('pocketed fresh mover sends within 12 ticks (floor breaks the stall)', sendsOut > 0, `sends after 12 ticks: ${sendsOut}`);
}
{
  // Bounded escape: when every fan heading is refused (the server never moves
  // the character), the fan must exhaust all 9 headings and reach the blink
  // path within a bounded number of ticks. Bypass the 1.5s echo-wait by
  // backdating _fanSentAt each tick (the test runs in microseconds).
  const wallGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'pocket', waypoints: [] }; },
    fineWalkable() { return false; },
  };
  const { mover } = rig({ geo: wallGeo });
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(4, 2);
  let reachedBlink = false;
  for (let i = 0; i < 40; i++) {
    mover._fanSentAt = Date.now() - 2000; // bypass the 1.5s echo-wait
    const r = mover.tick();
    if (r.state === 'blink' || r.state === 'stuck') { reachedBlink = true; break; }
  }
  ok('fan exhausts all headings and reaches the blink path (bounded escape)', reachedBlink);
}
{
  // OPEN VOID: fineWalkable can be true outside the BSP when no wall segment
  // is near the cell centre. standable must still detect the missing floor and
  // fire the same immediate escape fan.
  const voidGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'void', waypoints: [] }; },
    fineWalkable() { return true; },
    standable() { return false; },
  };
  const { mover } = rig({ geo: voidGeo });
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(4, 2);
  const r = mover.tick();
  ok('open void (fine true, standable false) engages the escape fan', r.state === 'raw-move' && mover._fanIndex === 0, `${r.state} ${r.why ?? ''} idx=${mover._fanIndex}`);
}
{
  // Do not steal a deliberate exit: if the current no-floor square is itself
  // the stand_on destination, the boundary-crossing logic owns the tick.
  const exitGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'exit', waypoints: [] }; },
    fineWalkable() { return true; },
    standable() { return false; },
  };
  const { mover } = rig({ col: 2, row: 2, geo: exitGeo });
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(2, 2, { standOn: true });
  const r = mover.tick();
  ok('stand_on exit square does not start an escape fan', r.why !== 'no-floor start: escape fan', `${r.state} ${r.why ?? ''}`);
}
{
  // OPEN VOID WITH BLINK AVAILABLE: sliding is pointless (the server accepts
  // every probe, so headings never refuse), so the mover blinks out on the
  // first tick instead of fanning.
  const voidGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'void', waypoints: [] }; },
    fineWalkable() { return true; },
    standable() { return false; },
  };
  const { mover, sent, session } = rig({ geo: voidGeo });
  session.client.cast = (id) => sent.push({ cast: id });
  session.client.spells = [{ id: 9, name: 'blink' }];
  // NO ENGINE FLAG IS SET HERE, AND THAT IS THE POINT OF THIS BLOCK.
  // `policy.ownPhysics` used to be set on this line. The mover does not read it: 2d44a48 deleted
  // the velocity declaration that gated on it, and the engine that replaced it has no switch — the
  // stride is unconditional. Setting a field nothing reads makes a test look like it is selecting
  // an engine when it is selecting nothing, which is how five tests in this file came to be
  // vacuous. Proven, not argued: deleting the field from all seven sites leaves 115/115 passing,
  // so not one of them ever depended on it. See m59-locomotion-test.mjs for the engine A/B, which
  // uses two real mover classes rather than a flag that does nothing.
  mover.to(4, 2);
  const r = mover.tick();
  ok('open void blinks out instead of sliding', r.state === 'blink' && /void/.test(r.why ?? ''), `${r.state} ${r.why ?? ''}`);
  ok('no fan engaged for a void blink', mover._fanIndex == null && mover._fanTarget == null);
  ok('blink held pending', mover._blinkPending === true);
}
{
  // ROOM-CHANGE HOLD: a room transition clears dead reckoning and holds sends
  // until the server places us in the new room (like the real client).
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  session._pose = { server: { col: 2, row: 2, x: 160, y: 160 }, updatedAt: Date.now(), reset() {} };
  session.client.room = { id: 1, num: 7 };
  mover.session.policy = {};
  mover.to(4, 2);
  mover.tick(); // establishes _roomKey (and may send)
  sent.length = 0;
  session.client.room = { id: 2, num: 8 }; // crossed into a new room, no echo yet
  const r = mover.tick();
  ok('room change holds movement', r.state === 'waiting-room', r.state);
  mover.tick();
  ok('no sends while waiting for the new room position', sent.length === 0, JSON.stringify(sent));
  // The server places us in the new room: the hold releases.
  session._pose.server = { col: 5, row: 5, x: 352, y: 352 };
  session._pose.updatedAt = mover._roomChangedAt + 50; // strictly after the change
  session.client.self = { col: 5, row: 5, x: 352, y: 352 };
  const r2 = mover.tick();
  ok('fresh server position releases the hold', r2.state !== 'waiting-room', r2.state);
}

console.log('\nNEVER ENTER A VOID (step model)');
{
  // Start grounded, destination far: the no-path stepper must skip the
  // floorless neighbor toward the dest and take a grounded one instead.
  const voidGeo = {
    collisionReady: true,
    fineWalkable() { return true; },
    walkable() { return true; },
    standable(r, c) { return !(r === 2 && c === 3); }, // (3,2) is void
    finePathProtocol() { return { found: false, reason: 'void-test', waypoints: [] }; },
  };
  const { mover, sent } = rig({ col: 2, row: 2, destCol: 8, destRow: 2, geo: voidGeo });
  mover.session.policy = {}; // step model (ownPhysics off)
  mover.to(8, 2);
  mover.tick();
  ok('floorless neighbor toward dest is skipped', sent.length === 1 && !(sent[0][0] === 224 && sent[0][1] === 160), JSON.stringify(sent));
  ok('a grounded neighbor is stepped to instead (contour, not reversal)', sent.length === 1 && sent[0][0] === 160 && sent[0][1] === 224, JSON.stringify(sent));
}
{
  // Waypoint branch (step model): same rule when following a path.
  const voidGeo = {
    collisionReady: true,
    fineWalkable() { return true; },
    standable(r, c) { return !(r === 2 && c === 3); }, // (3,2) is void
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: voidGeo });
  mover.session.policy = {}; // step model
  mover.to(8, 2);
  mover.path = [{ x: 8 * 64 + 32, y: 2 * 64 + 32 }];
  mover.pathIdx = 0;
  mover.tick();
  ok('waypoint stepper skips the floorless neighbor', sent.length === 1 && !(sent[0][0] === 224 && sent[0][1] === 160), JSON.stringify(sent));
}
{
  // NEVER ENTER A VOID. The old velocity engine declared a stride-clamped point up to
  // five squares away, so a single send could land inside a hole two squares off and
  // needed an explicit aim check to stop it. The one engine names a single ADJACENT
  // square per send, so the square it names is the only square it can reach — the
  // floor check is on the square it is about to step onto. Assert the stronger
  // property: over a whole walk toward a destination that sits past a hole, the
  // character never once declares a position inside the hole.
  const voidGeo = {
    collisionReady: true,
    standable(r, c) { return !(r === 2 && c === 5); }, // the hole, two squares short of dest (6,2)
    fineWalkable(r, c) { return !(r === 2 && c === 5); },
    traceFineMoveClient(x0, y0, x1, y1) { return { blocked: false, moved: true, arrived: true, x: x1, y: y1 }; },
    finePathProtocol() { return { found: false, reason: 'maze', waypoints: [] }; },
  };
  const { mover, sent, session } = rig({ col: 2, row: 2, geo: voidGeo });
  session._serverAccepts = false;   // a server that refuses everything must still never be told to enter the hole
  const echo = fakeServer(session);
  mover.to(6, 2, { by: 'router' });
  const entered = [];
  for (let i = 0; i < 24; i++) {
    clock(1600); echo();
    mover.tick();
    for (const m of sent) if (Array.isArray(m) && m[0] === 5 * 64 + 32 && m[1] === 2 * 64 + 32) entered.push(m);
    sent.length = 0;
  }
  ok('never declares a position inside the hole', entered.length === 0, JSON.stringify(entered));
}
{
  // Raw-door-push: a floorless non-exit destination is a bad target, not a door.
  const voidGeo = {
    collisionReady: true,
    fineWalkable() { return true; },
    walkable() { return true; },
    standable(r, c) { return !((r === 2 && c === 4) || (r === 2 && c === 3)); }, // dest (4,2) and (3,2) void
    finePathProtocol() { return { found: false, reason: 'void-test', waypoints: [] }; },
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: voidGeo });
  mover.session.policy = {}; // step model
  mover.to(4, 2); // near (<256), floorless, NOT a stand_on
  mover.tick();
  ok('raw push does not fire into a floorless non-exit', sent.length === 1 && !(sent[0][0] === 224 && sent[0][1] === 160), JSON.stringify(sent));
}

console.log('\nCORNER FLOW (trace-gated lookahead)');
{
  // An L-turn: the beeline to wp2 cuts the corner (blocked), the beeline to
  // wp1 is clear. The mover must aim at wp1 and keep striding — not hand the
  // tick to the 0c fan.
  const cornerGeo = {
    collisionReady: true,
    standable() { return true; },
    traceFineMoveClient(x0, y0, x1, y1) {
      // Client units here: wp1 ends at (2560,1536), wp2 at (2560,4608).
      // Block any segment ending past y=2560 (the corner cut).
      if (x1 >= 2560 && y1 > 2560) return { blocked: true, moved: false, arrived: false };
      return { blocked: false, moved: true, arrived: true, x: x1, y: y1 };
    },
  };
  const { mover, sent, session } = rig({ col: 2, row: 2, geo: cornerGeo });
  const echo = fakeServer(session);
  mover.to(3, 4, { by: 'router' });
  // The corner is hand-set rather than planned: this fixture has no finePathProtocol,
  // and the point under test is what the mover DOES with a path, not how it got one.
  mover.path = [{ x: 3 * 64 + 32, y: 2 * 64 + 32 }, { x: 3 * 64 + 32, y: 4 * 64 + 32 }];
  mover.pathIdx = 0;
  const r = mover.tick();
  ok('corner aims at the clear waypoint, striding', r.state === 'moving', `${r.state} ${r.why ?? ''}`);
  ok('the send goes to wp1, not into the wall', sent.length === 1 && sent[0][0] === 224 && sent[0][1] === 160, JSON.stringify(sent));
  ok('the fan stays out of it', mover._fanIndex == null && mover._fanTarget == null);
  let end = r.state;
  for (let i = 0; i < 8 && end !== 'arrived' && end !== 'stuck'; i++) {
    clock(1600); echo();
    end = mover.tick().state;
  }
  ok('the L-turn is walked without a fan', end === 'arrived', end);
  ok('the fan never engaged on the way round', mover._fanIndex == null && mover._fanTarget == null,
    `idx=${mover._fanIndex}`);
}

console.log('\nTHE RATE: A PACKET MUST CARRY A STRIDE, NOT A SQUARE');
{
  // THE ASSERTION WHOSE ABSENCE COST THE MOST. The velocity engine was 'restored' — code
  // present, comments written, suites green — and the fleet did not move one inch faster,
  // because the step branch 180 lines ABOVE the declaration owned every tick and returned.
  // Every test in this file passed the whole time. A suite that cannot tell whether the
  // engine it is testing is executing is not testing the engine, and that is exactly what an
  // independent audit found when it disabled the declaration and got 123/0.
  //
  // So this asserts the OUTCOME the engine exists to produce, on the one geometry where the
  // answer is unambiguous: open ground, a straight route, waypoints at every square centre
  // (which is what a square-centre planner emits), a walk stride of 2.5 squares. The mover
  // must cover more than one square per packet. If it covers one, it is stepping.
  const openGeo = {
    collisionReady: true,
    fineWalkable: () => true,
    standable: () => true,
    inBounds: () => true,
    traceFineMoveClient: () => ({ blocked: false, moved: true, arrived: false }),
    finePathProtocol: () => ({
      found: true,
      waypoints: Array.from({ length: 10 }, (_, i) => ({ x: (11 + i) * 64 + 32, y: 10 * 64 + 32 })),
    }),
  };
  const { mover, sent, session } = rig({ col: 10, row: 10, geo: openGeo });
  if (session._pose) session._pose.sim = { x: 10 * 64 + 32, y: 10 * 64 + 32 };
  mover.to(20, 10, { by: 'router' });
  const pts = [];
  for (let i = 0; i < 6; i++) {
    clock(1050);
    mover.tick();
    for (let j = 0; j < 8; j++) await Promise.resolve();
  }
  for (const p of sent) if (Array.isArray(p)) pts.push(p);
  let ground = 0;
  for (let i = 0; i + 1 < pts.length; i++)
    ground += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  const perPacket = ground / 64 / Math.max(1, pts.length - 1);
  ok('on open ground a packet carries more than one square of ground',
     perPacket > 1.2, `${perPacket.toFixed(2)} sq/packet over ${pts.length} sends (${pts.map(p => Math.round(p[0])).join(',')})`);
  // And the ground must be MONOTONIC: a mover that walks 2 forward and 1 back has a high
  // total-variation figure and goes nowhere, which is the failure mode an earlier attempt at
  // this ordering produced (832,800,960,992,1056,992 — a straight road walked backward and
  // forward). Total variation alone would have passed that.
  const net = pts.length > 1 ? Math.abs(pts[pts.length - 1][0] - pts[0][0]) : 0;
  ok('and the ground is made FORWARD, not by oscillation',
     pts.length < 2 || net >= ground * 0.7, `net ${Math.round(net)} vs total ${Math.round(ground)}`);
}

console.log('\nSTRIDED NO-PATH DECLARATION');
{
  // Planner failed but the beeline validates clean: declare a full stride,
  // not a single square.
  const openGeo = {
    collisionReady: true,
    standable() { return true; },
    traceFineMoveClient(x0, y0, x1, y1) { return { blocked: false, moved: true, arrived: true, x: x1, y: y1 }; },
    finePathProtocol() { return { found: false, reason: 'maze', waypoints: [] }; },
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: openGeo });
  mover.session.policy = {}; // walk stride (160)
  mover.to(8, 2);
  const r = mover.tick();
  ok('open beeline declares a full walk stride', r.state === 'moving' && r.stride === true, `${r.state}`);
  ok('the send covers 160 proto units, not 64', sent.length === 1 && sent[0][0] === 320 && sent[0][1] === 160, JSON.stringify(sent));
}
{
  // Blocked beeline falls back to single-square stepping (no behavior change).
  const wallGeo2 = {
    collisionReady: true,
    standable() { return true; },
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    fineWalkable() { return true; },
    walkable() { return true; },
    finePathProtocol() { return { found: false, reason: 'maze', waypoints: [] }; },
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: wallGeo2 });
  mover.session.policy = {};
  mover.to(8, 2);
  const r = mover.tick();
  ok('blocked beeline falls back to stepping', r.state === 'moving' && r.stride !== true, `${r.state}`);
  ok('the fallback step is adjacent', sent.length === 1 && Math.abs(sent[0][0] - 160) + Math.abs(sent[0][1] - 160) === 64, JSON.stringify(sent));
}

console.log('\nFAN NEVER STEPS INTO A VOID');
{
  // From a grounded start, a fan heading whose (stride-extended) probe lands
  // on floorless ground is skipped without sending — like a refused heading.
  const voidSlideGeo = {
    collisionReady: true,
    standable(r, c) { return !(r === 2 && c === 5); }, // stride endpoint (5,2) is void
    traceFineMoveClient(x0, y0, x1, y1) { return { blocked: false, moved: true, arrived: true, x: x1, y: y1 }; },
    finePathProtocol() { return { found: false, reason: 'maze', waypoints: [] }; },
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: voidSlideGeo });
  mover.session.policy = {};
  mover.to(8, 2);
  mover._fanIndex = 0;
  mover._fanFrom = { x: 0, y: 0 };
  const r = mover.tick();
  ok('floorless fan heading is skipped, not sent', r.state === 'raw-move' && sent.length === 0, `${r.state} ${r.why ?? ''} sent=${JSON.stringify(sent)}`);
  ok('the fan advances past the skipped heading', mover._fanIndex === 1, `idx=${mover._fanIndex}`);
}
{
  // Skipping every heading exhausts the fan to stuck (no blink spell here).
  // Heading 8 (1.7 rad off due east) stride-extends to square (2,4): void.
  const voidSlideGeo = {
    collisionReady: true,
    standable(r, c) { return !(r === 4 && c === 2); },
    traceFineMoveClient(x0, y0, x1, y1) { return { blocked: false, moved: true, arrived: true, x: x1, y: y1 }; },
    finePathProtocol() { return { found: false, reason: 'maze', waypoints: [] }; },
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: voidSlideGeo });
  mover.session.policy = {};
  mover.to(8, 2);
  mover._fanIndex = 8;
  mover._fanFrom = { x: 0, y: 0 };
  const r = mover.tick();
  ok('skipping the last heading exhausts to stuck', r.state === 'stuck', `${r.state} ${r.why ?? ''}`);
  ok('nothing sent into the void', sent.length === 0, JSON.stringify(sent));
}

console.log('\nFAN INIT FALLS THROUGH TO SEND (no silent wedge)');
{
  // NO SILENT TICK. This used to pin the 0c slide check falling through to a send on
  // the same tick instead of returning after arming the fan (verified live: 40 ticks of
  // silent inits, 1 send via the 5s floor). The slide check is gone with the engine that
  // owned it, so the property is stated where it now lives: a tick that has a grounded
  // square to step onto sends, and a tick that has nothing to say reports a state — a
  // tick never goes quiet with neither.
  const wallGeo = {
    collisionReady: true,
    traceFineMoveClient() { return { blocked: true, moved: false, arrived: false }; },
    finePathProtocol() { return { found: false, reason: 'wall', waypoints: [] }; },
    standable: () => true,
    fineWalkable: () => true,
  };
  const { mover, sent, session } = rig({ geo: wallGeo });
  session._serverAccepts = false;
  mover.to(4, 2, { by: 'router' });
  const r1 = mover.tick();
  ok('first tick sends rather than arming a fan and going quiet',
    sent.length === 1, `sent=${JSON.stringify(sent)} state=${r1.state}`);
  let saw = { sent: 0, states: new Set() };
  for (let i = 0; i < 20; i++) {
    clock(1600);
    const r = mover.tick();
    saw.states.add(r.state);
    saw.sent += sent.length;
    sent.length = 0;
  }
  ok('no tick is silent across a full escape: every tick sends or reports',
    saw.sent > 0 && !saw.states.has('idle'), `sends=${saw.sent} states=${[...saw.states]}`);
  ok('and it reaches the escape fan when stepping cannot get through',
    saw.states.has('raw-move'), [...saw.states].join(','));
}

console.log('\nHEIGHT DISCIPLINE (move.c step limit)');
{
  // Raw-door-push into a cliff face is skipped (falls through to the stepper).
  const cliffGeo = {
    collisionReady: true,
    fineWalkable: (r, c) => !((r === 2 && c === 4) || (r === 2 && c === 3)),
    walkable: () => true,
    standable: () => true,
    traceFineMoveClient: () => ({ blocked: true, reason: 'step_too_high' }),
    finePathProtocol: () => ({ found: false, reason: 'maze', waypoints: [] }),
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: cliffGeo });
  mover.session.policy = {};
  mover.to(4, 2); // near (<256), fine-blocked dest, NOT stand_on
  mover.tick();
  ok('raw push into a cliff is skipped', sent.length === 1 && !(sent[0][0] === 224 && sent[0][1] === 160), JSON.stringify(sent));
}
{
  // Same setup, clear trace: the push fires (old path preserved).
  const doorGeo = {
    collisionReady: true,
    fineWalkable: (r, c) => !(r === 2 && c === 4),
    walkable: () => true,
    standable: () => true,
    traceFineMoveClient: (x0, y0, x1, y1) => ({ blocked: false, arrived: true, x: x1, y: y1 }),
    finePathProtocol: () => ({ found: false, reason: 'maze', waypoints: [] }),
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: doorGeo });
  mover.session.policy = {};
  mover.to(4, 2);
  mover.tick();
  ok('raw push into a door gap still fires', sent.length === 1 && sent[0][0] === 224 && sent[0][1] === 160, JSON.stringify(sent));
}
{
  // Boundary walk-past into a cliff is refused (stuck escalates to fan/blink).
  const cliffGeo = {
    collisionReady: true,
    fineWalkable: () => true,
    standable: () => true,
    traceFineMoveClient: () => ({ blocked: true, reason: 'step_too_high' }),
    finePathProtocol: () => ({ found: false, reason: 'maze', waypoints: [] }),
  };
  const { mover, sent } = rig({ col: 3, row: 2, geo: cliffGeo });
  mover.session.policy = {};
  mover.to(4, 2, { standOn: true, edgeTarget: { x: 5 * 64 + 32, y: 2 * 64 + 32 } });
  const r = mover.tick();
  ok('walk-past into a cliff is refused', r.state === 'stuck', `${r.state} ${r.why ?? ''}`);
  ok('nothing sent past the cliff', sent.length === 0, JSON.stringify(sent));
}
{
  // Control: clear trace crosses.
  const doorGeo = {
    collisionReady: true,
    fineWalkable: () => true,
    standable: () => true,
    traceFineMoveClient: (x0, y0, x1, y1) => ({ blocked: false, arrived: true, x: x1, y: y1 }),
    finePathProtocol: () => ({ found: false, reason: 'maze', waypoints: [] }),
  };
  const { mover, sent } = rig({ col: 3, row: 2, geo: doorGeo });
  mover.session.policy = {};
  mover.to(4, 2, { standOn: true, edgeTarget: { x: 5 * 64 + 32, y: 2 * 64 + 32 } });
  const r = mover.tick();
  ok('walk-past through a door gap crosses', r.state === 'crossing', `${r.state} ${r.why ?? ''}`);
  ok('the crossing send goes past the boundary', sent.length === 1 && sent[0][0] === 352 && sent[0][1] === 160, JSON.stringify(sent));
}
{
  // Fan probe up a cliff is skipped like a refused heading.
  const cliffGeo = {
    collisionReady: true,
    standable: () => true,
    traceFineMoveClient: () => ({ blocked: true, reason: 'step_too_high' }),
    finePathProtocol: () => ({ found: false, reason: 'maze', waypoints: [] }),
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: cliffGeo });
  mover.session.policy = {};
  mover.to(8, 2);
  mover._fanIndex = 0;
  mover._fanFrom = { x: 0, y: 0 };
  mover.tick();
  ok('fan probe up a cliff is skipped, not sent', sent.length === 0 && mover._fanIndex === 1, `sent=${JSON.stringify(sent)} idx=${mover._fanIndex}`);
}

console.log('\nEXACT-POINT VOID (square floored, body point leafless)');
{
  // Square (2,2) has floor somewhere (standable true) but the character's
  // exact point sits in a BSP coverage gap (no leaf). Must escape anyway.
  const gapGeo = {
    collisionReady: true,
    standable: () => true,
    fineWalkable: () => true,
    leafAtClient: () => null,
    floorBaseAtClient: () => null,
    traceFineMoveClient: (x0, y0, x1, y1) => ({ blocked: false, arrived: true, x: x1, y: y1 }),
    finePathProtocol: () => ({ found: false, reason: 'gap', waypoints: [] }),
  };
  const { mover, sent } = rig({ col: 2, row: 2, geo: gapGeo });
  mover.session.policy = {};
  mover.to(8, 2);
  const r = mover.tick();
  ok('leafless point fires the escape fan', r.state === 'raw-move' && mover._fanIndex === 0, `${r.state} idx=${mover._fanIndex}`);
  void sent;
}

console.log('\nA STRIDE THAT INTEGRATES TO NOTHING MUST NOT REPORT MOVING');
{
  // THE LIVE FAILURE THIS ASSERTION EXISTS FOR. After the integration was restored, keeper-t3.log
  // showed 2,180 consecutive ticks of `plan from=(12,3) dest=8,2 found=true wp=1` with sends=0 and
  // stuck=1747 climbing with no ceiling. The mover was reporting `state: 'moving'` while putting
  // nothing on the wire, and because it RETURNED, it never reached the escape fan below — the fan
  // being the only thing in the file that knows how to leave a pocket. A counter that climbs for
  // ever while nothing is sent is not a stuck detector, it is a diary.
  //
  // The step engine could not reach this state: it named an adjacent square and declared its
  // centre without consulting the geometry, so it always had somewhere to go. The integration can
  // legitimately return zero ground — the character is in a corner where every heading is walled
  // within a stride — which is exactly the situation the escape fan was written for.
  //
  // THE ASSERTION IS ABOUT THE WIRE, NOT THE RETURN VALUE. 'state === moving' is whatever the
  // branch says it is; a test that reads it back proves nothing, and the first draft of this one
  // did. So it counts SENDS over thirty ticks and requires the mover to escalate rather than
  // tick quietly forever.
  const cornerGeo = {
    collisionReady: true,
    fineWalkable: () => true,
    standable: () => true,
    traceFineMoveClient: () => ({ blocked: true, moved: false, arrived: false }),
    finePathProtocol: () => ({ found: true, waypoints: [{ x: 9 * 64 + 32, y: 2 * 64 + 32 }] }),
  };
  const { mover, sent } = rig({ col: 12, row: 3, geo: cornerGeo });
  mover.to(8, 2, { by: 'router' });
  let escalated = false, quietTicks = 0;
  for (let i = 0; i < 30; i++) {
    clock(1050);
    const before = sent.length;
    const r = mover.tick();
    if (sent.length === before) quietTicks++;
    if (r.state === 'raw-move' || r.state === 'stuck' || r.state === 'blink') { escalated = true; break; }
  }
  ok('a mover whose stride integrates to nothing escalates rather than ticking quietly',
     escalated, `${quietTicks} quiet ticks of ${30}, stuck=${mover.stuckTicks}`);
  // And the counter that the fan reads must actually advance, or escalation can never happen.
  ok('and stuckTicks advances while nothing is sent (the fan reads it)', mover.stuckTicks > 0,
     `stuck=${mover.stuckTicks}`);
}

console.log('\nDESTINATION OWNERSHIP: the owner may re-aim its own destination');
{
  // THE GUARD EXISTS TO STOP A LOWER CALLER STEALING A ROUTE. It was written as
  // `rank <= heldRank`, which also refuses the holder itself. That is not a conservative
  // reading of the guard — a router walks a route as a SEQUENCE of destinations, so a guard
  // that forbids it from updating its own destination freezes the character on the first leg.
  // Seen live: `to() DEFERRED: 'router' rank=100 wants 71,49 but 'router' rank=100 holds
  // 69,49` repeating while the mover walked to the stale square, ending with gateAge past
  // twenty minutes and stuck past thirteen thousand.
  const { mover } = rig({ geo: clearGeometry() });
  mover.to(8, 2, { by: 'router' });
  ok('first claim takes the destination', mover.dest?.col === 8 && mover.dest?.row === 2, JSON.stringify(mover.dest));
  mover.to(9, 2, { by: 'router' });   // the same owner, advancing along its own route
  ok('the SAME owner can re-aim its own destination', mover.dest?.col === 9 && mover.dest?.row === 2,
     `dest=${mover.dest?.col},${mover.dest?.row} — a router that cannot advance is frozen on leg one`);
  // And the guard still does the job it was written for. Without this half, the assertion above
  // is just 'anyone may set anything', which is what the mover did before and why it thrashed
  // at 13,619 destination changes against 244,021 sends.
  mover.to(4, 4, { by: 'combat' });
  ok('a LOWER caller still cannot steal it', mover.dest?.col === 9,
     `dest=${mover.dest?.col},${mover.dest?.row} — combat took the route`);
  mover.to(4, 4, { by: 'router' });
  ok('and the owner may still re-aim after a refusal', mover.dest?.col === 4 && mover.dest?.row === 4,
     `dest=${mover.dest?.col},${mover.dest?.row}`);
}

console.log('\nCORNER ROUNDED: the fan releases when the direct path clears');
{
  // THE CLAUSE THIS ASSERTION EXISTS FOR was deleted with the slide-along-wall check in
  // 2d44a48 and never replaced: 'Direct path is CLEAR and we were sliding: corner rounded.
  // Release the fan so velocity resumes (persistent slide would otherwise keep sidestepping
  // past the opening).' Its absence is not cosmetic. The dither detector can only FIRE the
  // fan; with no release, a character that fans once keeps sidestepping past the opening it
  // was sliding toward, which is the oscillation this mover was reported for.
  //
  // WHY THIS RIG AND NOT A CLEANER ONE. It uses the `maze` geometry, where the fan is engaged
  // by the dither detector rather than hand-set. The first attempt at this assertion hand-set
  // `_fanIndex = 0` and then asserted the fan was gone three ticks later — and it passed
  // vacuously, because the fan had never engaged in the first place, so 'null' was the state
  // before and after. An assertion that holds on a run where nothing happened is the exact
  // failure this repository keeps hitting, so the fan's ENGAGEMENT is asserted before its
  // release, on the same object, with nothing reset in between.
  const mazeGeo = {
    collisionReady: true,
    standable: () => true,
    fineWalkable: () => true,
    traceFineMoveClient: () => ({ blocked: true, moved: false, arrived: false }),
    finePathProtocol: () => ({ found: false, reason: 'maze', waypoints: [] }),
  };
  const { mover, clock } = rig({ geo: mazeGeo });
  mover.to(6, 2, { by: 'router' });
  let engaged = false;
  for (let i = 0; i < 40 && !engaged; i++) { clock(1600); mover.tick(); if (mover._fanIndex != null) engaged = true; }
  ok('the fan engages while the path is blocked (the release assertion needs this)', engaged, `fanIndex=${mover._fanIndex}`);
  if (engaged) {
    // The corner is rounded: the wall is gone, the direct path is clear.
    mazeGeo.traceFineMoveClient = (x0, y0, x1, y1) => ({ blocked: false, moved: true, arrived: true, x: x1, y: y1 });
    let released = false;
    for (let i = 0; i < 6 && !released; i++) { clock(1600); mover.tick(); if (mover._fanIndex == null) released = true; }
    ok('the fan releases once the direct path is clear', released, `fanIndex=${mover._fanIndex}`);
  } else {
    ok('the fan releases once the direct path is clear', false, 'never engaged, so release is untested');
  }
}

console.log('\norderCandidates: straight while moving, taboo only when stuck');
{
  const { orderCandidates } = await import('./tick/m59-mover.mjs');
  const cands = [[2, 5], [3, 5], [4, 5]];  // goal-ward first
  let o = orderCandidates(cands, ['2,5'], 0);
  ok('moving: keeps goal order (no dither)', o[0][0] === 2 && o[1][0] === 3, JSON.stringify(o));
  o = orderCandidates(cands, ['2,5'], 3);
  ok('stuck: unvisited first', o[0][0] === 3 && o[2][0] === 2, JSON.stringify(o));
  o = orderCandidates(cands, [], 5);
  ok('stuck, empty taboo: unchanged', o.length === 3 && o[0][0] === 2, JSON.stringify(o));
}

console.log('\norderCandidates: monster rule (never step directly away)');
{
  const { orderCandidates } = await import('./tick/m59-mover.mjs');
  // me (5,5), goal east (8,5): the 8-neighborhood minus directly-west.
  const cands = [[6,5],[5,4],[5,6],[4,5],[6,4],[6,6],[4,4],[4,6]];
  const goal = { meCol: 5, meRow: 5, goalCol: 8, goalRow: 5 };
  let o = orderCandidates(cands, [], 0, goal);
  ok('moving: opposite square excluded', !o.some(([c, r]) => c === 4 && r === 5) && o.length === 7, JSON.stringify(o));
  ok('moving: goal-ward still first', o[0][0] === 6 && o[0][1] === 5, JSON.stringify(o[0]));
  o = orderCandidates(cands, [], 4, goal);
  ok('stuck: backtrack allowed (nothing excluded)', o.length === 8, JSON.stringify(o.length));
}

console.log('\n_submitMove: central 1050ms cap across all sites');
{
  const { mover } = rig({});
  mover._moveCapMs = 1050;  // live cap (the rig defaults it off)
  const s = mover.session, c = s.client;
  let calls = 0;
  s.pacer = { submit: () => { calls++; return Promise.resolve(); } };
  ok('first submit goes', mover._submitMove(s, c, () => {}) === true && calls === 1, 'calls=' + calls);
  ok('immediate second is dropped', mover._submitMove(s, c, () => {}) === false && calls === 1, 'calls=' + calls);
  mover._lastMoveSubmitAt = Date.now() - 2000;
  ok('after the window it goes again', mover._submitMove(s, c, () => {}) === true && calls === 2, 'calls=' + calls);
}

console.log('\ndithered: sends with no net progress over a full window');
{
  const { dithered } = await import('./tick/m59-mover.mjs');
  const now = 1000000;
  const win = (t0, cols, sends0) => cols.map((c, i) => ({ t: t0 + i * 1000, col: c[0], row: c[1], sends: sends0 + i }));
  ok('empty window is not dither', dithered([], now, 15000) === false, 'empty');
  ok('short window is not dither', dithered(win(now - 5000, [[2,2],[2,2]], 0), now, 15000) === false, 'short');
  ok('full window, no net, sends flowed = dither',
     dithered(win(now - 16000, [[2,2],[2,2],[2,3],[2,2]], 5), now, 15000) === true, 'dither');
  ok('real progress is not dither',
     dithered(win(now - 16000, [[2,2],[5,5]], 5), now, 15000) === false, 'progress');
  ok('1-square jitter with sends flowing is dither',
     dithered(win(now - 16000, [[22,81],[22,80],[22,81]], 5), now, 15000) === true, 'jitter');
  ok('stillness without sends is rest, not dither',
     dithered(win(now - 16000, [[2,2],[2,2]], 5).map(s => ({ ...s, sends: 5 })), now, 15000) === false, 'rest');
}

console.log('\ncasting hold: no sends while a cast is charging');
{
  const { mover, sent, session } = rig({});
  mover.to(8, 2);
  session._castingUntil = Date.now() + 5000;
  const r = mover.tick();
  ok('mover holds during the cast', r.state === 'casting' && r.hold === true, r.state);
  ok('nothing sent while holding', sent.length === 0, JSON.stringify(sent));
  session._castingUntil = Date.now() - 1;
  const r2 = mover.tick();
  ok('movement resumes after', r2.state !== 'casting', r2.state);
}

console.log('\nrest hold: a sent rest stills the mover for trance');
{
  const { mover, sent, session } = rig({});
  mover.to(8, 2);
  session._restHold = true;
  const r = mover.tick();
  ok('mover holds while resting', r.state === 'resting' && r.hold === true, r.state);
  ok('nothing sent while holding', sent.length === 0, JSON.stringify(sent));
  session._restHold = false;
  const r2 = mover.tick();
  ok('movement resumes after', r2.state !== 'resting', r2.state);
}

console.log('\nOWNERSHIP: a lower-rank caller cannot steal the destination');
{
  // The live failure: 13,619 destination changes vs 244,021 sends on keeper-t1.
  // Each new destination reset path/pathIdx/stuckTicks/fan, so A* never finished
  // and the escape fan never reached its threshold. Here: the router claims the
  // destination, then combat and patrol try to take it every tick.
  const { mover, sent, session } = rig({ geo: clearGeometry() });
  mover.to(8, 2, { by: 'router' });
  const r1 = mover.tick();
  ok('router owns it and moves', r1.state === 'moving' || r1.state === 'planning', r1.state);
  // Build real plan state to be destroyed: a path and a stuck count.
  const pathBefore = mover.path ? mover.path.length : null;
  mover.stuckTicks = 7;
  const fanBefore = mover._fanIndex;
  sent.length = 0;

  const stolen = mover.to(4, 2, { by: 'combat' });
  ok('combat to() is REFUSED (returns false)', stolen === false, String(stolen));
  ok('destination unchanged by the refusal', mover.dest.col === 8 && mover.dest.row === 2,
    `${mover.dest.col},${mover.dest.row}`);
  ok('stuckTicks NOT reset by the refusal', mover.stuckTicks === 7, String(mover.stuckTicks));
  ok('fan state NOT reset by the refusal', mover._fanIndex === fanBefore, String(mover._fanIndex));
  if (pathBefore != null) ok('path NOT dropped by the refusal',
    mover.path && mover.path.length === pathBefore, String(mover.path && mover.path.length));

  const stolen2 = mover.to(3, 3, { by: 'patrol' });
  ok('patrol to() is REFUSED too', stolen2 === false, String(stolen2));
  ok('still the router destination', mover.dest.col === 8 && mover.dest.row === 2);

  // A same-owner re-assert (the router calling to() every tick) changes nothing
  // and is not treated as a steal of itself.
  const reassert = mover.to(8, 2, { by: 'router' });
  ok('router re-assert is a no-op success', reassert !== false, String(reassert));
  ok('stuckTicks survives the owner re-assert', mover.stuckTicks === 7, String(mover.stuckTicks));
}

console.log('\nOWNERSHIP: a higher-rank caller CAN take the destination');
{
  const { mover } = rig({ geo: clearGeometry() });
  mover.to(4, 2, { by: 'patrol' });
  mover.stuckTicks = 2;
  const taken = mover.to(8, 2, { by: 'router' });
  ok('router takes it from patrol', taken !== false && mover.dest.col === 8, `${taken} ${mover.dest.col}`);
  ok('a genuine steal resets stuckTicks', mover.stuckTicks === 0, String(mover.stuckTicks));
}

console.log('\nOWNERSHIP: recovery outranks combat and patrol, router outranks recovery');
{
  const { mover } = rig({ geo: clearGeometry() });
  mover.to(4, 2, { by: 'combat' });
  ok('recovery takes from combat', mover.to(5, 5, { by: 'recovery' }) !== false);
  ok('patrol cannot take from recovery', mover.to(6, 6, { by: 'patrol' }) === false);
  ok('router takes from recovery', mover.to(7, 7, { by: 'router' }) !== false);
  ok('unknown caller cannot take from router', mover.to(9, 9, { by: undefined }) === false);
}

console.log('\nOWNERSHIP: an abandoned owner does not freeze movement');
{
  const { mover } = rig({ geo: clearGeometry() });
  mover.to(8, 2, { by: 'router' });
  // Simulate the owner going away: the stamp ages past OWNER_STALE_MS.
  mover._ownerAt = Date.now() - 11000;
  const took = mover.to(4, 2, { by: 'combat' });
  ok('a stale owner loses the destination', took !== false && mover.dest.col === 4, `${took} ${mover.dest.col}`);
}


// ---------------------------------------------------------------- diagnostic identity
// A diagnostic that names the wrong character is worse than no diagnostic: every conclusion
// drawn from it is about whichever character happened to write the line. This class is
// instantiated once per character, and its format strings had `t3` BAKED IN —
// `[movedbg] t3 vel-tick`, `[movestuck] t3 server static` — so on a five-character fleet the
// log said 't3' for all five. Prove the label comes from the session.
{
  const lines = [];
  const orig = console.error;
  console.error = (s) => lines.push(String(s));
  try {
    const session = {
      name: 'zebra',
      client: { state: 'game', room: { id: 5 }, self: { col: 3, row: 4 } },
      policy: {},
    };
    const mover = new Mover(session, { reportIntervalMs: 0 });
    mover.tickLogged();
  } finally {
    console.error = orig;
  }
  const ts = lines.filter((l) => l.includes('[tick-state]'));
  ok('tickLogged reports the state it returned', ts.length >= 1, `got ${ts.length} lines`);
  ok('the tick-state line carries the session name', ts.every((l) => l.includes('zebra')), ts[0]);
  ok('no baked-in character name survives in it', !ts.some((l) => /\bt3\b/.test(l)), ts.join(' | ').slice(0, 120));
}
{
  const probe = new Mover({ name: 'zebra', policy: {} }, { reportIntervalMs: 0 });
  ok('logName reads through the session', probe.logName === 'zebra', String(probe.logName));
  const anon = new Mover({}, { reportIntervalMs: 0 });
  ok("a session with no name is '?' rather than a wrong name", anon.logName === '?', String(anon.logName));
}


// A cleanup that searches for one spelling of a bug and reports zero hits is not a cleanup.
// The diagnostics in this class had a character's name baked into the format string, in BOTH
// 't3' and 't4' spellings; a sweep for 't3' alone reported the file clean while the destination
// setter still said 't4'. Scan the source for the shape of the bug.
{
  const src = readFileSync(new URL('./tick/m59-mover.mjs', import.meta.url), 'utf8');
  const baked = src
    .split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /console\.error\(`\[[a-z-]+\] t\d\s/.test(l));
  ok('no console.error template bakes a character name', baked.length === 0,
     `found ${baked.length}: ` +
     baked.slice(0, 3).map(([n, l]) => n + ':' + l.trim().slice(0, 40)).join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
