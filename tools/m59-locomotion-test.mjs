#!/usr/bin/env node
// THE WALL-DECLARATION BUG, REPRODUCED.
//
//   node tools/m59-locomotion-test.mjs
//
// The contract under test is one sentence, and it comes from the reference client rather
// than from preference: **a position the client reports is a position the client actually
// reached.** move.c:374-382 — when a sub-step is blocked the client sets `x = last_x` and
// breaks, and then `MoveUpdatePosition` (move.c:764) reports `player.x, player.y`. Being
// blocked does not change *what* is reported; it changes where the integration stopped,
// and therefore what there is to report.
//
// Why this needs a separate reference model instead of the mover's own geometry: the
// mover asks `traceFineMoveClient(..., { slide: false })`, and that call answers a
// blocked trace with the trace's START. So the mover's own oracle could never say "the
// position you are about to send is inside the wall" — the single fact that matters. Every
// guard built on that answer inherits the blind spot. This file therefore re-implements
// move.c's integration independently and judges the mover's packets against it. If the two
// agree, that is evidence; if they disagree, one of them is wrong about Meridian 59.
//
// Both movers are run over the identical room so the comparison cannot be an artefact of
// two different fixtures:
//   - tools/tick/m59-mover-preFix.mjs  — the mover as of 2d44a48^, WITH the velocity engine
//   - tools/tick/m59-mover.mjs         — the current mover, step engine only
//
// The prediction, from reading the deleted code: the velocity block computes
// `aim = myProto + stride * unit(waypoint)` whenever the beeline to a far waypoint is
// blocked, and that point is inside the wall. So the velocity engine must be caught
// declaring a position past the wall, and the step engine must not — the step engine names
// an adjacent square and cannot reach the wall in one send. If the velocity engine is NOT
// caught, this test has not reproduced anything and must not be trusted.

// THE FILE UNDER TEST IS ./tick/m59-mover.mjs — the live mover, not a copy.
//
// That is a deliberate constraint on this test and it is what makes it useful after the fix
// lands. A reproduction that imports a pinned snapshot of the old mover keeps passing forever,
// including after the bug is fixed, at which point it has stopped being a test and become a
// fossil. Auditing the live file means this suite answers the only question that matters going
// forward — "does the mover in this repository emit positions past walls?" — and turns red the
// day someone reintroduces the behaviour. `git checkout 2d44a48^ -- tools/tick/m59-mover.mjs`
// is then a real check that this suite can see the bug at all, which is exactly how it was
// verified: with the baseline mover restored, this file fails.
import { Mover as CurrentMover, STEPS_PER_MOVE as STEPS_PER_MOVE_CONST, WALK_STRIDE_PROTO, MOVEUNITS_PROTO, PLAYER_WALL_CLEARANCE_CLIENT_UNITS } from './tick/m59-mover.mjs';
// The pre-fix mover, kept as a separate module so the before/after comparison can be run in
// one process. It is evidence for the diagnosis, not the thing under audit.
import { Mover as PreFixMover } from './tick/m59-mover-preFix.mjs';
// THE BISECT BUILD. Same mover, with the slide-along-wall pre-emption disabled so the
// velocity declaration is reached even when the beeline to the aim is blocked.
//
// Why the reproduction needs it, and why that is not cheating: the declaration is the thing
// under test, and in the pre-fix build the slide check runs first and hands the tick to the
// escape fan whenever a wall is in the way — so the declaration never runs, and the test
// reports zero violations from a mover that never got to the statement being audited. That is
// a real property of the pre-fix design and it is worth knowing: the illegal send was
// unreachable because a different guard pre-empted it, which is also why it went unnoticed.
//
// But it is not a safety property worth keeping. A declaration that only stays legal because
// something else intercepts it cannot be reasoned about at its own site, cannot be tested at
// its own site, and breaks the moment a caller reaches it by another route — which is what
// `standOnNear` did: the slide check is skipped when the destination is a stand_on square,
// and on that path the declaration runs unguarded. Step 3's job is to make the declaration
// clamp its own output, so the correct position comes out of it by construction. Until then,
// this build is the honest way to ask the question.
// There is deliberately no bisect build here. An earlier draft imported a copy of the pre-fix
// mover with its slide-along-wall guard disabled, to see where the illegal send came from. It
// produced a violation in seconds — and it was a violation of the guard that had been removed,
// which is not a finding about anything. Removing a guard to demonstrate that the code behind
// it is unsafe proves nothing a reader could act on, and a suite that keeps such a file around
// will eventually run it and report the result as a pass. The question was answered instead by
// reading the send sites, and the answer is asserted against the live mover below.
import { Pose } from './tick/m59-pose.mjs';
import { ReferenceRoom, referenceGeometry, protocolToClient, clientToProtocol, KOD_FINENESS, MOVE_INTERVAL, STEPS_PER_MOVE } from './m59-locomotion-oracle.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

// ---------------------------------------------------------------- the room
//
// One protocol square wide enough to walk in, with a wall down col 7 covering rows 0..5.
// The wall is placed at the CENTRE of col 7, not on a square boundary: fineWalkable tests
// the cell centre against wall segments within the player radius (248), and a wall lying
// on a boundary is 512 client units from every centre on either side, so it would be
// invisible to the fine grid while still blocking a trace. That mismatch is a fixture bug
// that looks like a mover bug, so it is avoided by construction.
// The wall spans the FULL height of the room except for the doorway, so there is no way
// around it. A wall that stops short is not an obstacle but an inconvenience: the mover
// plans a route over its end, never aims through anything, and the test silently loses the
// case it was built for. This cost four drafts.
// THE ROOM AND THE WALL, sized together. The room must be TALLER than the doorway or the
// wall has no bottom to assert about: a room whose last row falls inside the gap is a room
// where the wall stops short because the room does, which is a different claim than the one
// being made — and the assertion that checks it was failing for exactly that reason.
const ROOM_SQUARES = 18;   // protocol squares per side
const WALL_COL = 8, WALL_ROW0 = 0, WALL_ROW1 = ROOM_SQUARES - 1;
// THE WALL LIES ON THE BOUNDARY BETWEEN col 7 AND col 8, and it is derived from that
// boundary rather than written as a number.
//
// Getting this coordinate right took four drafts, because every wrong placement still
// produced a green-looking fixture:
//   - through the CENTRE of a square: that square becomes unwalkable, which looks like a
//     correct wall, but the squares facing a gap are still within PLAYER_RADIUS of the
//     wall's end, so the doorway never opens, the room has no route, and the mover plans
//     nothing. A clean test about an empty room.
//   - at a value assumed to be a boundary but actually a centre (7680 is col 8's centre;
//     protocolToClient is (v-64)*16, so boundaries are protocolToClient(n*64)): the wall
//     lands one square away from where the reader thinks it is, and every assertion about
//     "the far side" is then about the near side.
// On the true boundary, col 7 and col 8 are each half-squares with 512 - 248 = 264 client
// units of clearance at the gap — narrow, which is the point: a wide door would let the
// mover go around honestly instead of ever being offered the chance to walk through.
//
// THE WALL RUNS THROUGH THE MIDDLE OF col 8, which is where a wall has to go for this
// geometry to see it at all. That is not a free choice: a segment lying on a square
// BOUNDARY is 512 client units from the centre of either neighbour, and fineWalkable (the
// real one, m59-roo.mjs:1573) tests only the cell centre at radius 256 — so a boundary wall
// is invisible to the fine grid, every square reads as walkable, the planner draws a straight
// line through the wall, and the test reports zero violations from a room that has no wall in
// it. A wall the fine grid can see must cross a cell centre.
const WALL_X = protocolToClient(WALL_COL * KOD_FINENESS + KOD_FINENESS / 2);
// How far each segment end overshoots the doorway, in client units. The squares whose centres
// are more than 256 from a segment end stay open, so the ends must overshoot past the gap's
// own boundary by more than that radius — otherwise the segment stops short, the squares
// facing the gap read as walkable, and the "doorway" is 3 squares wide instead of 2.
const WALL_END = 257;
// THE WALL'S PHYSICAL THICKNESS, in client units, and the same number the wall segments are
// built with. A reference model that draws a wall of one thickness and audits against another
// is auditing a room that does not exist.
const WALL_HALF = 257;
// THE WALL SQUARE ITSELF, derived rather than assumed: the first square east of the
// boundary. Every assertion below asks this question of this square; none of them may
// hard-code a column, because a hard-coded column is a second source of truth about where
// the wall is and the two of them already disagreed once.
const WALL_SQUARE_COL = WALL_COL;
// A row on which the wall stands, well inside its span. The character starts west of the wall
// on this row and is sent east of it, so every straight aim crosses the wall.
const WALL_ROW_AIM = 3;
// Client units per protocol unit. Used as the audit's tolerance: the wire rounds to whole
// protocol units, so sub-protocol-unit disagreement between the audit and the mover is not a
// finding. Derived from the repository's converter rather than written as 16, so it cannot
// silently become wrong if the scale is ever corrected.
const CLIENT_PER_PROTO = protocolToClient(KOD_FINENESS) - protocolToClient(0);
// A wall exactly on the boundary between two squares. The fine grid (centre test, radius 256)
// cannot see it: the boundary is 512 from either centre. The BSP trace can.
const WALL_ON_BOUNDARY = protocolToClient(WALL_COL * KOD_FINENESS);
const BOUNDARY_LEFT_COL = WALL_COL - 1;
const WALL_Y1 = (WALL_ROW1 + 1) * 1024;   // the wall's full extent, client units

// The wall runs down the centre of col 7 with a DOORWAY at row 1.
//
// The doorway is not scenery, it is the reason this fixture can reproduce anything at all.
// A wall with no gap makes the far side unreachable, the mover's planner fails, and the
// mover falls into its escape fan — where it behaves correctly and there is nothing to
// measure. It needs to be a room where a route EXISTS, so the mover commits to walking and
// the question becomes what it declares while walking.
//
// And the far side must be GROUND, which is what makes the bug reachable. The mover has a
// void check on the aim (mover:1307 `transitBanned(...aimSqR, aimSqC)`) and it does exactly
// what it says: it refuses an aim square with no floor. If the far side were void, that
// check would refuse the illegal aim and the bug would be masked by a different guard — the
// mover would look clean for the wrong reason. With floor on the far side, no guard of
// the mover's objects to the aim being *past a wall*: the aim square is perfectly walkable,
// it is the road between that is not. That is the shape of the real failure, and it is why
// keeper-t3 could sit in a room declaring positions through a wall instead of going around
// it through the door.
// The doorway spans DOOR_ROW0..DOOR_ROW1 and must be WIDE. It was first written as a
// single square, and it was not a doorway at all: the wall segment still ran through the
// middle of the supposed gap, `fineWalkable` correctly refused the square, and the room had
// no route — so the mover planned nothing and the test measured nothing while reporting a
// clean room. A gap is only a doorway if a body fits through it, and a body here is
// PLAYER_RADIUS = 248 on each side of the centre, so a 1024-wide square leaves 264 of
// clearance once the radius is charged against both wall ends. Two squares is the narrowest
// honest door in this geometry.
// THE DOORWAY, IN THE UNITS THE GEOMETRY ACTUALLY USES.
//
// This was first written as a pair of row numbers and that is where three of the fixture's
// drafts went: a row number has to be converted to client units to place a wall, and the
// conversion was gotten wrong, so the "gap" was placed one square from where the wall's
// segments stopped and the room had no opening at all. Stated as client-unit y values the
// doorway is checkable in one line, and the assertion below checks it.
// THE DOORWAY, IN CLIENT UNITS, AND WIDE ENOUGH FOR A BODY TO FIT THROUGH.
//
// The clearance that matters is not the width of the gap but the distance from the NEAREST
// facing SQUARE CENTRE to the segment end, against the radius of 256 that fineWalkable
// charges. With the ends overshooting by 257, a three-square gap leaves that centre
// 3*1024 - 257 - 512 = 2303 units clear, which opens; a two-square gap leaves it at exactly
// the radius, which seals the "doorway" shut. Three squares is the narrowest honest door.
//
// AND IT IS PLACED FAR ENOUGH AWAY THAT TURNING AROUND COSTS MORE THAN ONE STRIDE. That was
// the last thing wrong with this room, and it made the test silently vacuous in a way no
// assertion caught: with the door two squares off, a stride toward the door is already two
// squares of progress toward a destination two squares past the wall, so going around is the
// GREEDY move. The mover did exactly that, walked a completely legal route, and the test
// reported zero violations while watching a character do nothing wrong. A room that merely
// HAS a doorway is not a room with a doorway in its path.
//
// The door has to be far enough away that the first stride toward it is a step AWAY from the
// destination. Then the straight aim at the far side is the tempting one, the void check
// cannot refuse it because the aim square is itself walkable, and the only thing standing
// between the mover and an illegal send is the clamp this test exists to demand.
const DOOR_Y0 = 12 * 1024, DOOR_Y1 = 15 * 1024;
// The room must be TALLER than the doorway, or the wall has no bottom to assert about: a
// room whose last row is inside the gap is a room where the wall stops short because the
// room does, which is not the same claim. The wall's span is expressed in this room's own
// height so the two cannot drift apart.
const DOOR_ROW = Math.floor(clientToProtocol((DOOR_Y0 + DOOR_Y1) / 2) / KOD_FINENESS);
// The PROTOCOL ROW the walk runs along, derived from the gap via the repository's own
// converter rather than a formula of my own. The first version divided the client
// coordinate by 64 directly and produced row 112 — a row that does not exist — because
// protocolToClient(0) is -1024, not 0: the client origin sits a full square outside the
// grid. Any hand-rolled client->protocol arithmetic in this file is a bug of that shape,
// so none of it is hand-rolled.
// The walk runs along row DOOR_ROW0 — the doorway row — because that is the only row on
// which a straight aim ever meets a wall that has floor on the far side of it.
function makeRoom() {
  // THE WALL IS DRAWN AS A CENTRELINE SEGMENT, AND THAT IS THE GEOMETRY'S OWN CONVENTION.
  //
  // This file used to describe the wall as 514 client units thick and then measure "past the
  // wall" against the face that description implies, while drawing only the centreline. The
  // mismatch looked like a bug in the mover: it stopped 48 units short of the centreline and the
  // audit called that 257 units inside a wall. It is not a mover bug, it is a fixture that asks
  // for a rule its own geometry does not implement.
  //
  // The attempt to "fix" it by drawing a closed box is worse, and it is worth writing down why,
  // because it is a trap that looks like diligence. fineWalkable (m59-roo.mjs:1573) decides a
  // cell by the distance from its CENTRE to the nearest impassable SEGMENT, with a threshold of
  // 256 — the player radius. A wall drawn as a line through the centre of col 8 is 0 from that
  // centre, so the cell reads as wall and the planner will not route through it. Draw the same
  // wall as a 514-thick box and the centre is 257 from either face — one unit outside the
  // threshold — so the wall's own cell reads WALKABLE, the A* happily routes through it, and the
  // mover is now asked to walk into a wall its coarse grid has just certified as floor. The test
  // would then be about a room with no wall in it, which is the failure mode this fixture was
  // originally written to avoid.
  //
  // So: centreline segments, and the audit measures the centreline. The thickness in the prose
  // above describes how a wall looks in the rendered room; it is not a collision volume this
  // geometry carries, and nothing in the mover can see it.
  return new ReferenceRoom({
    walls: [
      { x0: WALL_X, y0: 0, x1: WALL_X, y1: DOOR_Y0 - WALL_HALF },
      { x0: WALL_X, y0: DOOR_Y1 + WALL_HALF, x1: WALL_X, y1: ROOM_SQUARES * 1024 },
    ],
    size: ROOM_SQUARES * 1024,
  });
}

// A clock the test owns. The mover's send gate is a 1050ms live constraint; a rig that
// ticks in microseconds collapses it and measures a rate that cannot happen.
let CLOCK = 0;
const REAL_NOW = Date.now;
Date.now = () => CLOCK + REAL_NOW.call(Date);
const tick = (ms) => { CLOCK += ms; };

// ---------------------------------------------------------------- the rig
//
// `engine` picks which mover implementation drives the session. Everything else — room,
// start square, clock discipline, server echo — is shared, so any difference in what gets
// sent is a difference between the engines and nothing else.
// THE WALK STARTS ON A WALL ROW, NOT ON THE DOOR ROW, AND THAT IS THE WHOLE POINT.
//
// The first version aimed from the doorway row toward the far side, which is a walk that
// never meets a wall: it goes through the door, honestly, and the test then reported no
// violations because there were none to report. A room that HAS a doorway is not a room with
// a doorway in its path.
//
// To be offered the chance to declare a position past a wall, the character has to stand on a
// row where the wall is and be told to go somewhere on the far side of it. Ground beyond the
// wall is what makes the aim look legal: the aim square itself is walkable, so the mover's
// own void check has nothing to object to. It is the road between that is not there. That is
// also precisely what keeper-t3 was doing — sitting in a room declaring positions through a
// wall at a destination it could only have reached by going around.
function rig(MoverClass, { col = WALL_COL - 2, row = WALL_ROW_AIM, velocity = false, geo: injectedGeo = null } = {}) {
  const room = injectedGeo ? injectedGeo.room : makeRoom();
  const geo = injectedGeo ?? referenceGeometry(room);
  const sent = [];
  const session = {
    name: 'loc', live: true,
    // `velocity` selects the engine under test. It is NOT decoration: in the mover as of
    // 2d44a48^ this flag is the gate on the velocity declaration (mover:547 returns early
    // when it is false, mover:797 reads it, mover:927/1172 gate the slide and raycast
    // checks on it). A rig that loads the pre-fix mover and leaves it false drives the STEP
    // branch of a file whose purpose was to test the velocity branch — and every assertion
    // about velocity then passes while saying nothing. That is exactly the vacuous-test
    // class this file exists to catch, and it is what the first draft of this file did.
    // The test below therefore does not trust the flag: it proves the branch ran.
    policy: velocity ? { ownPhysics: true } : {},
    client: {
      state: 'game',
      self: { col, row, x: col * KOD_FINENESS + 32, y: row * KOD_FINENESS + 32 },
      // RECORD THE WIRE BYTES, not an interpretation of them. moveTo takes protocol x,y;
      // moveToSquare takes (col, row) and the client converts. Recording a square call as
      // though it carried a position produced an audit that "caught" a 117,130 teleport out
      // of an ordinary `moveToSquare(4, 7)` — a violation of a packet that was never sent,
      // which is worse than no audit because it looks like a finding.
      moveTo: (x, y, sp) => { sent.push({ x, y, kind: 'moveTo', sp }); },
      moveToSquare: (c, r) => { sent.push({ x: c * KOD_FINENESS + 32, y: r * KOD_FINENESS + 32, kind: 'moveToSquare', col: c, row: r }); },
      moveSpeed: () => 18,
      room: { id: 1 },
      stand: () => {},
      vitals: () => ({ health: 100, maxHealth: 100, mana: 50, stamina: 50 }),
    },
    pacer: { depth: 0, submit: (k, fn) => { const r = fn(); return Promise.resolve(r); } },
    walkTo: (c, r) => { sent.push({ x: c * KOD_FINENESS + 32, y: r * KOD_FINENESS + 32, kind: 'walkTo', col: c, row: r }); return Promise.resolve({ arrived: true }); },
    world: { geometry: geo },
  };
  session._pose = new Pose();
  session._pose.updateServer({ ...session.client.self });

  const mover = new MoverClass(session, { reportIntervalMs: 0, moveCapMs: 0 });
  return { mover, sent, session, room, geo, velocity };
}

// DID THE BRANCH UNDER TEST ACTUALLY RUN?
//
// The only honest way to know a test measured the velocity engine is to observe the
// velocity engine. The mover logs one throttled line on entering the velocity declaration
// — `[movedbg] ... vel-tick` — which is unconditional inside that block, so its presence
// proves the block executed and its absence proves the test was about something else.
// Capturing stderr for the duration of a walk is how this test keeps itself honest.
function captureBranch(fn) {
  const writes = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { writes.push(String(chunk)); return true; };
  try { return { result: fn(), log: writes.join('') };
  } finally { process.stderr.write = real; }
}

// Walk one report interval at a time, echoing what the client declared as if a server had
// accepted it. The echo is what lets a walk proceed at all; without it every engine stalls
// for reasons that have nothing to do with the question being asked.
// Is this protocol position inside a wall of this room? Returns the wall and its half-width,
// or null. Uses the same `blocked` predicate the reference integration stops on, so the audit
// cannot call a position illegal that the integration would have been able to reach.
function squareInsideWall(room, protoX, protoY) {
  const cx = protocolToClient(protoX), cy = protocolToClient(protoY);
  for (const w of room.walls) {
    // Is this position on the far side of this wall segment, measured from the side the
    // character was standing on?
    //
    // A wall in these fixtures is a LINE at a single x — which is what a wall segment in this
    // geometry is, a line the BSP collides against — and the audit has to say so rather than
    // borrow a half-thickness the fixture never drew. An earlier draft tested `d <= WALL_HALF`
    // (257), which is the thickness the SEGMENT ENDS are offset by to make a doorway, not a
    // thickness the wall has. It flagged a position 1 client unit off the line as a 257-unit
    // "penetration", and would have flagged the doorway itself as a violation.
    //
    // Two things follow, and both are load-bearing:
    //   - A position exactly on the line is ON the wall, not through it. Characters stand
    //     there; the doorway case below depends on it being legal.
    //   - A position within one protocol unit of the line is a rounding artefact. The wire
    //     carries whole protocol units and a protocol unit is 16 client units, so landing 1
    //     unit off the face is arithmetic, not intrusion. Flagging that is not conservative:
    //     a safety audit that cries wolf gets ignored, and then the real one is missed.
    //
    // So the wall is audited as a half-plane. The caller supplies which side is legal by
    // asking about the TRANSITION; here we only report the position's own side.
    const y0 = Math.min(w.y0, w.y1), y1 = Math.max(w.y0, w.y1);
    if (cy < y0 || cy > y1) continue;            // beyond this segment's extent: no wall here
    const d = cx - w.x0;
    if (Math.abs(d) <= CLIENT_PER_PROTO) continue;  // on the face, or within rounding of it
    return { x: w.x0, side: Math.sign(d) };
  }
  return null;
}

// THE AUDIT'S OWN WITNESS: of the packets the velocity declaration actually emitted, how many
// are past the wall?
//
// This exists because an audit and a hand-trace of the same run disagreed, and the hand-trace
// was right. A send at client x=8704 sits 1536 units past a boundary at 7168, and the audit
// reported zero violations — it asked "does this hop cross the wall?", which a character can
// satisfy by standing inside the wall and stepping east. The question a reported position has
// to answer is "is this position somewhere a client could be?", which is about a place.
//
// Counting the offending sends straight off the send list means the audit's verdict and the
// evidence can never silently diverge again: if the audit says zero and this says three, the
// audit self-check fails and says so in the same run.
function declaredPastWall(room, sends, startX) {
  const startSide = Math.sign(protocolToClient(startX) - WALL_ON_BOUNDARY) || -1;
  return sends.filter(x => {
    if (typeof x.x !== 'number') return false;
    const wire = x.kind === 'moveToSquare' || x.kind === 'walkTo'
      ? { x: x.col * KOD_FINENESS + KOD_FINENESS / 2, y: x.row * KOD_FINENESS + KOD_FINENESS / 2 }
      : x;
    const w = squareInsideWall(room, wire.x, wire.y);
    return !!w && w.x === WALL_ON_BOUNDARY && w.side !== startSide;
  });
}

// Tick the mover once per report interval.
//
// intervalMs is 1500, not the 1050 the client's own send throttle allows, and the difference
// is not sloppiness — it is the shape of the system. The escape fan parks a probe and refuses
// to judge it until one echo window has passed: `Date.now() - this._fanSentAt < 1500` returns
// 'waiting' (mover:734), because BP_MOVE echoes arrive ~1200ms after a send while the fan's
// nine probes would otherwise exhaust in 900ms. A rig that ticks at 1050ms never lets a probe
// resolve, so the fan holds at heading 0 forever, the tick never falls through to the
// statement under test, and the test reports a clean mover that was never asked to move.
// Ticking at 1500 lets each probe complete, which is what a live keeper does.
function walk(r, destCol, destRow, { ticks = 60, intervalMs = 1500 } = {}) {
  r.mover.to(destCol, destRow, { by: 'router' });
  const c = r.session.client.self;
  for (let i = 0; i < ticks; i++) {
    tick(intervalMs);
    const before = r.sent.length;
    r.mover.tick();
    // apply what was sent, as a server that accepts positions would
    for (let j = before; j < r.sent.length; j++) {
      const s = r.sent[j];
      c.x = s.x; c.y = s.y;
      c.col = Math.floor(s.x / KOD_FINENESS);
      c.row = Math.floor(s.y / KOD_FINENESS);
    }
    r.session._pose.updateServer({ ...c });
  }
  return r;
}

// ---------------------------------------------------------------- the assertion
//
// THE VIOLATION THE CONTRACT IS ABOUT, stated once, in the units the wire carries.
//
// A send is illegal when the position it declares is FURTHER ALONG the line toward the aim
// than the wall that stands on that line. Not "further than it could travel in one second"
// — that is a different rule, and a mover that obeys it while stepping through a wall
// passes it. The reference client cannot make such a send, because its integration stops at
// the wall (`x = last_x; break;`, move.c:374-382) and it reports where it stopped.
//
// `wallX` is the wall position along the axis the walk runs on, and `wallLimit` is the
// furthest legal coordinate on the near side, from ReferenceRoom.furthest — a binary search
// against the room's own geometry, not a hand-computed number, so the fixture cannot drift
// away from the room it is describing.
function illegalSend(sent, from, wallLimit, axis) {
  return sent > wallLimit + 1e-6
    ? { illegal: true, sent, limit: wallLimit, overshoot: sent - wallLimit }
    : null;
}

// For every packet the mover sent, ask the reference model: starting from where the client
// actually was, and moving no further than the stride the mover itself declares, could a
// real client have arrived at this position? Anything that crossed a wall is a violation.
function auditSends(r) {
  const room = r.room;
  const violations = [];
  const start = r.startPos;
  let x = start.x, y = start.y;
  for (const s of r.sent) {
    if (typeof s.x !== 'number' || typeof s.y !== 'number') continue;
    // THE COORDINATES THAT GET ON THE WIRE.
    //
    // moveTo is documented and implemented as (protocolX, protocolY); moveToSquare is
    // (col, row) and the client converts. Recording both as a bare {x, y} made the audit
    // read a `moveToSquare(6, 6)` as a position of (6, 6) — near the room's origin — and
    // report it as a jump across a wall at client x=7168. It "caught" the STEP ENGINE
    // declaring a position past the wall, which is a false accusation against code that is
    // correct, and it is the kind of false positive that ends a investigation in the wrong
    // direction. Audit the bytes the wire would carry, or audit nothing.
    const wire = s.kind === 'moveToSquare' || s.kind === 'walkTo'
      ? { x: s.col * KOD_FINENESS + KOD_FINENESS / 2, y: s.row * KOD_FINENESS + KOD_FINENESS / 2 }
      : { x: s.x, y: s.y };
    const cx = protocolToClient(wire.x), cy = protocolToClient(wire.y);
    const fx = protocolToClient(x), fy = protocolToClient(y);
    // THE TEST, in one sentence: is the position this packet declares further along the
    // line toward its aim than the wall that stands on that line?
    //
    // Deliberately NOT "further than the character could have travelled in one second".
    // That is a different rule — a legal one, about speed — and a mover can satisfy it while
    // stepping straight through a wall. The reference client cannot make this send at all:
    // its integration stops at the wall (`x = last_x; break;`) and it reports where it
    // stopped, so the position past the wall is never in player.x to be reported.
    // THE WALL IS THE ONE THIS ROOM WAS BUILT WITH, looked up rather than inferred from
    // where this particular packet happened to be going.
    //
    // `furthest(from, to)` binary-searches along the line to `to`, so if the character is
    // standing ON the far side of the wall and the packet is a short step further east, the
    // line meets no wall at all, `atWall` comes back false, and the packet is judged clean.
    // That is how a run with a send 1536 client units past the boundary produced zero
    // violations: the audit was asking "does this hop cross the wall?" when the question is
    // "is this position inside the wall?" The first is a question about a transition and can
    // be evaded by crossing gradually; the second is a question about a place, and a position
    // on the wrong side of a wall is illegal however it got there.
    const limit = r.room.furthest(fx, fy, cx, cy);
    // WHICH SIDE OF THE WALL IS THE ONE THIS CHARACTER IS ALLOWED TO BE ON?
    //
    // The walk starts west of the wall, so west is legal and east is not. Deriving the legal
    // side from the character's own starting position, rather than hard-coding "x > boundary",
    // keeps the audit honest if the room is ever mirrored — and it is what makes the doorway
    // case work: a character that goes THROUGH the door ends up east of the boundary by a
    // route the reference integration approves, and an audit that asked "is x past the line?"
    // would convict a perfectly legal walk. The question is never about x on its own; it is
    // about which side the character was entitled to be on and whether it crossed the wall to
    // get where it is.
    const startSide = Math.sign(protocolToClient(start.x) - WALL_ON_BOUNDARY) || -1;
    const wallHere = squareInsideWall(room, wire.x, wire.y);
    const insideWall = wallHere && wallHere.side !== startSide && wallHere.x === WALL_ON_BOUNDARY
      ? wallHere : null;
    // A TOLERANCE, because the wire carries integers and the reference model does not.
    //
    // The position is `Math.round`ed to a whole protocol unit before it is sent, and one
    // protocol unit is 16 client units; `furthest` is a binary search that converges to within
    // a client unit. So a position that lands exactly on the wall can come out 0.5 client
    // units either side of it for reasons that have nothing to do with the mover. A test that
    // calls that a violation will pass the wrong thing and blame the right one.
    //
    // The threshold is one protocol unit — the smallest distinction the wire can carry. A
    // position more than a protocol unit past the wall is a position the client could not have
    // reached and did not round into; anything inside that is the same position by the only
    // resolution the protocol has.
    const over = (limit.atWall && cx > limit.x + CLIENT_PER_PROTO) || insideWall !== null;
    if (over) {
      violations.push({
        from: { x, y }, to: s, wire,
        why: insideWall !== null
          ? `declared client x=${cx.toFixed(1)} on the far side of the wall at x=${insideWall.x.toFixed(1)} (crossed by ${(Math.abs(cx - insideWall.x)).toFixed(1)} client units) without a legal route through it`
          : `declared client x=${cx.toFixed(1)} but the wall stops legal movement at x=${limit.x.toFixed(1)} (overshoot ${(cx - limit.x).toFixed(1)} client units)`,
        fromSq: { col: Math.floor(clientToProtocol(fx) / KOD_FINENESS), row: Math.floor(clientToProtocol(fy) / KOD_FINENESS) },
        toSq: { col: Math.floor(cx / KOD_FINENESS), row: Math.floor(cy / KOD_FINENESS) },
        wallX: insideWall ? insideWall.x : WALL_X, limitX: limit.x,
        overshoot: insideWall ? Math.abs(cx - insideWall.x) : cx - limit.x,
      });
    }
    x = wire.x; y = wire.y;
  }
  return violations;
}

console.log(`room: wall at client x=${WALL_X} (col ${WALL_COL}) rows ${WALL_ROW0}..${WALL_ROW1}, doorway y ${DOOR_Y0}..${DOOR_Y1} (row ${DOOR_ROW})`);
console.log(`      fineWalkable(3, ${WALL_COL}) = ${referenceGeometry(makeRoom()).fineWalkable(3, WALL_COL)}  (must be false)`);

console.log('\nthe fixture sees what it claims to see');
{
  const g = referenceGeometry(makeRoom());
  ok('the square west of the wall is walkable', g.fineWalkable(3, WALL_COL - 1) === true,
    'the character must start on legal ground or its first position is illegal before it moves');
  ok('the square east of it is walkable', g.fineWalkable(3, WALL_COL + 2) === true);
  ok('the wall square is NOT walkable', g.fineWalkable(3, WALL_SQUARE_COL) === false,
    'a wall fineWalkable cannot see is a wall the test cannot assert anything about');
  ok('the wall spans the whole room, so there is no way around it',
    g.fineWalkable(WALL_ROW1, WALL_SQUARE_COL) === false && g.fineWalkable(0, WALL_SQUARE_COL) === false,
    'a wall you can walk around is not the obstacle this test needs');
  ok('the squares facing the gap are walkable — that is what makes it a doorway',
    g.fineWalkable(DOOR_ROW, WALL_COL) === true && g.fineWalkable(DOOR_ROW, WALL_SQUARE_COL) === true,
    `west=${g.fineWalkable(DOOR_ROW, WALL_COL)} east=${g.fineWalkable(DOOR_ROW, WALL_SQUARE_COL)} doorRow=${DOOR_ROW}`);
  ok('and the square facing the wall is not', g.fineWalkable(3, WALL_SQUARE_COL) === false);
  ok('and a trace actually gets THROUGH the doorway',
    g.traceFineMoveClient(protocolToClient(6 * 64 + 32), protocolToClient(DOOR_ROW * 64 + 32), protocolToClient((WALL_COL + 2) * 64 + 32), protocolToClient(DOOR_ROW * 64 + 32), { slide: false }).blocked === false,
    'a gap the mover cannot trace through is not a doorway, it is a wider wall');
  ok('and the far side of the wall is GROUND, so a void check cannot mask the bug',
    g.standable(3, WALL_COL + 2) === true,
    'if the far side were void the mover would look clean for the wrong reason');
  const plan = g.finePathProtocol(3 * 64 + 32, DOOR_ROW * 64 + 32, (WALL_COL + 2) * 64 + 32, DOOR_ROW * 64 + 32);
  ok('a route exists through the doorway', plan.found === true && plan.waypoints.length > 0,
    JSON.stringify(plan).slice(0, 90));
  const room = makeRoom();
  // Straight at the wall from legal ground, one report interval at the walk stride.
  const stop = room.integrate(protocolToClient((WALL_COL - 1) * 64 + 32), protocolToClient(3 * 64 + 32), protocolToClient((WALL_COL + 2) * 64 + 32), protocolToClient(3 * 64 + 32), protocolToClient(160));
  // THE FIXTURE MUST DISAGREE WITH ITSELF, ON PURPOSE.
  //
  // fineWalkable (the real one, and this fixture's transcription of it) tests a square by its
  // CENTRE at radius 256; the client collides continuously through the BSP. A wall on a square
  // boundary is 512 from either centre, so the planner sees open ground where the physics sees
  // a wall. If a future edit made these two agree, the room would have no case in it and every
  // assertion below would pass while testing nothing. This is the assertion that would notice.
  ok('the fine grid and the trace DISAGREE about the wall, which is the case under test',
    g.fineWalkable(3, WALL_COL) === false || room.blocked(
      protocolToClient((WALL_COL - 1) * 64 + 32), protocolToClient(3 * 64 + 32),
      protocolToClient((WALL_COL + 1) * 64 + 32), protocolToClient(3 * 64 + 32)) !== null,
    'both agree the wall is passable: the room has no obstacle and the test is vacuous');
  ok('the reference integration stops at the wall when walking into it',
    stop.stopped === 'wall' && stop.x <= WALL_X + 1e-6, JSON.stringify(stop));
}

console.log('\nTHE REPRODUCTION: the velocity engine declares positions inside the wall');
let velocityViolations = [];
let velocitySends = 0;
{
  // The rig's defaults put the character west of the wall on a WALL row, aimed east.
  // Passing col/row explicitly here was the last thing wrong: {col: 3, row: 3} is a square
  // in the open west of everything, and from there the destination is reachable without
  // crossing anything.
  // THE BUILD UNDER TEST IS THE PRE-FIX MOVER WITH ITS GUARDS INTACT.
  //
  // It is not the bisect build. That distinction is the difference between a reproduction and
  // an accusation: a mover with a guard removed will produce any violation you want, and the
  // finding would be about the guard you removed. Everything below therefore runs the real
  // 2d44a48^ file — slide-along-wall check, escape fan, void check, all of it — and the
  // violation has to come out of that.
  const r = rig(PreFixMover, { velocity: true });
  r.startPos = { x: r.session.client.self.x, y: r.session.client.self.y };
  // Aim EAST, straight at the wall. Not a contrivance: a destination on the far side of a
  // wall is the ordinary case, and it is the only case where the difference between
  // "stop at the wall" and "project past it" can show up at all.
  const { result, log } = captureBranch(() => { walk(r, WALL_COL + 2, WALL_ROW_AIM, { ticks: 40 }); return r.sent.length; });
  velocitySends = result;
  velocityViolations = auditSends(r);
  const tookBranch = /vel-tick/.test(log);
  console.log(`  velocity engine sent ${result} packets, ${velocityViolations.length} of them illegal`);
  console.log(`  velocity declaration branch entered: ${tookBranch ? 'YES (vel-tick logged)' : 'NO'}`);
  // THE ANTI-VACUITY ASSERTION. Everything below is worthless if this fails, so it is
  // asserted first and loudest: a mover that never entered the block under test cannot
  // fail to declare a position past a wall, and "0 illegal sends" from such a run is the
  // sound of a test doing nothing.
  ok('the mover sent packets', result > 0, 'a walk that sends nothing tests nothing');
  console.log(`  velocity declaration branch entered: ${tookBranch ? 'YES' : 'NO'}`);
  // This is a DIAGNOSTIC, not a verdict, and it is labelled as such so nobody reads a green
  // run as a reproduction. In this room the mover's own slide-along-wall check sees the wall
  // and hands the tick to the escape fan, so the declaration under audit never runs and there
  // is nothing to convict. That is a true fact about the pre-fix design — and it is also why
  // the bug survived: a violation that only appears when a guard is not looking is invisible
  // to a test that only looks where the guard is not. The verdict lives in the section below,
  // in the room where the guard is legitimately blind.
  ok(`DIAGNOSTIC (wall the mover can see): branch ran=${tookBranch}, violations=${velocityViolations.length}`, true);
}

console.log('\nthe same room, the current step engine');
{
  const r = rig(CurrentMover, {});
  r.startPos = { x: r.session.client.self.x, y: r.session.client.self.y };
  const { result, log } = captureBranch(() => { walk(r, WALL_COL + 2, WALL_ROW_AIM, { ticks: 40 }); return r.sent.length; });
  const v = auditSends(r);
  console.log(`  step engine sent ${result} packets, ${v.length} of them illegal`);
  // THE CONTRAST THIS ASSERTION USED TO PROTECT NO LONGER EXISTS, AND SAYING SO IS THE FIX.
  //
  // It asserted that the mover in ./tick/m59-mover.mjs had NO velocity branch, so that the run
  // above (the pre-fix declaration) and this one (the step engine) measured two different
  // engines. That held as of 2d44a48, which deleted the declaration. It stopped holding the
  // moment the declaration was restored with its defect fixed — which is the whole point of the
  // restoration, not an oversight in it. There is one engine again.
  //
  // A green assertion reading "this mover cannot do the thing it now does" is worse than no
  // assertion, because the next reader believes it. What replaces it is the positive claim: the
  // current mover DOES enter the declaration, and the sends below are the declaration's sends.
  ok('the current mover enters the restored declaration', /vel-tick/.test(log),
    'no vel-tick line — the step engine is still what is being measured, so nothing below tests the restored code');
  ok('and it actually sent packets', result > 0, 'a walk that sends nothing tests nothing');
  ok('the declaration never declares a position past the wall', v.length === 0,
    v.slice(0, 2).map(x => `(${x.to.x},${x.to.y}) ${x.why}`).join(' | '));
}

console.log('\nTHE DEFECT IN THE CODE WE ARE SHIPPING NOW');
{
  // This section is NOT about the deleted velocity engine. It is about the mover in
  // ./tick/m59-mover.mjs today, and it is the reason this work was worth starting: the
  // reference model was built to catch a historical bug and caught a current one instead.
  //
  // A SEALED WALL — one segment, the room's full height, no doorway. Nothing to walk around.
  // The wall lies on a square BOUNDARY, and the fine grid is blind to that by construction:
  // RoomGeometry.fineWalkable (m59-roo.mjs:1573) tests a square by its CENTRE at radius 256,
  // and a boundary wall is 512 from either neighbour. So the planner is handed a straight
  // route through a wall, and it takes it.
  //
  // What then emits the illegal position is the escape fan's STRIDE EXTENSION
  // (m59-mover.mjs:946). It traces the candidate probe at `playerRadius: 1` — a deliberate,
  // documented choice, because the full radius rejects open directions and traps characters
  // in pockets — and if the trace is clear it extends a 16-unit probe to the full stride.
  // The probe at 16 units does not reach the wall, so the trace is clear, and the probe at
  // 320 units is on the far side of it. The trace answers a question about 16 units and the
  // code uses it to justify 320.
  //
  // The result on the wire: a position 2464 client units past a wall the character walked
  // straight through, and then `arrived`. The character reports having teleported through a
  // wall and believes it succeeded. Against the server that is not a crash but a lie: the
  // server is client-authoritative (docs/MOTION-PLAN.md §1, a 24-square jump granted in one
  // packet), so it will BELIEVE the position, and the character will be somewhere it never
  // walked. Whatever that room contains, the character met it without passing through it.
  const room = new ReferenceRoom({
    walls: [{ x0: WALL_ON_BOUNDARY, y0: 0, x1: WALL_ON_BOUNDARY, y1: ROOM_SQUARES * 1024 }],
    size: ROOM_SQUARES * 1024,
  });
  const geo = referenceGeometry(room);
  ok('the fine grid cannot see this wall at all',
    geo.fineWalkable(WALL_ROW_AIM, BOUNDARY_LEFT_COL) === true && geo.fineWalkable(WALL_ROW_AIM, WALL_COL) === true,
    'if the fine grid sees it, the planner routes around and there is no case');
  ok('while the trace sees it clearly',
    room.blocked(protocolToClient(BOUNDARY_LEFT_COL * 64 + 32), protocolToClient(WALL_ROW_AIM * 64 + 32),
                 protocolToClient(WALL_COL * 64 + 32), protocolToClient(WALL_ROW_AIM * 64 + 32), 1) !== null);

  const r = rig(CurrentMover, { col: BOUNDARY_LEFT_COL, row: WALL_ROW_AIM, velocity: false, geo });
  r.startPos = { x: r.session.client.self.x, y: r.session.client.self.y };
  const { result } = captureBranch(() => { walk(r, WALL_COL, WALL_ROW_AIM, { ticks: 24 }); return r.sent.length; });
  const v = auditSends(r);
  const past = declaredPastWall(room, r.sent, r.startPos.x);
  for (const x of past.slice(0, 3)) {
    const cx = protocolToClient(x.kind === 'moveToSquare' ? x.col * KOD_FINENESS + 32 : x.x);
    console.log(`    sent ${JSON.stringify([x.x, x.y])} -> client x=${cx.toFixed(0)}, wall at ${WALL_ON_BOUNDARY.toFixed(0)}, past by ${(cx - WALL_ON_BOUNDARY).toFixed(0)}`);
  }
  console.log(`  ${result} packets sent, ${past.length} of them past the wall`);
  // THE CONTRACT OF THIS SUITE, stated as an assertion rather than a comment: no position on
  // the wire may be one the reference client could not have reached. That is the whole rule,
  // it applies to whatever mover is in ./tick/m59-mover.mjs today, and it is asserted here so
  // the suite is RED until the defect is fixed. A suite that reports a known violation as a
  // pass is worse than no suite, because a green battery is exactly what makes it safe to ship.
  //
  // This fails right now, on purpose. It is the exit code that step 3 exists to turn green.
  ok('NO SEND LANDS PAST A SEALED WALL (the contract)', past.length === 0,
    `${past.length} send(s) past the wall — the worst is ${past.length ? Math.max(...past.map(x => protocolToClient(x.kind === 'moveToSquare' ? x.col * KOD_FINENESS + 32 : x.x) - WALL_ON_BOUNDARY)).toFixed(0) : 0} client units beyond it. Emitted by the escape fan's stride extension at mover:946, which traces a 16-unit probe and justifies a 320-unit position with the answer.`);
}

// ---------------------------------------------------------------------------
// STEP 3: THE POSITIVE HALF OF THE RULE.
//
// "No send lands past a wall" is a negative claim, and negative claims are easy to satisfy by
// accident — a mover that sends nothing at all passes it, and so does one that refuses to walk
// anywhere near a wall. The reference client's behaviour is a POSITIVE statement, and it is the
// half that actually tells you the integration is running: move.c:374-382 sets `x = last_x` when
// a sub-step returns MOVE_BLOCKED, so a client walked into a wall reports a position stopped AT
// the wall and then keeps reporting it. Parked, not silent, and not on the far side.
//
// "At the wall" is measured in client units, and the tolerance is not arbitrary — it is one
// sub-step. The integration advances in units of (stride / STEPS_PER_MOVE) protocol units, and
// the last legal position is the last sub-step boundary BEFORE the wall. A result further short
// than that means the integration stopped early, which is the other way a mover fails: it looks
// compliant because nothing crosses the wall while it stands in the middle of the room and goes
// nowhere. A tolerance wider than a sub-step would let that pass, which is how a passing test
// can still be telling you nothing.
// ---------------------------------------------------------------------------
console.log('\nA CHARACTER WALKING AT A WALL SENDS A POSITION AT THE WALL (step 3)');
{
  // THE TOLERANCE IS A MEASUREMENT, NOT A GENEROSITY.
  //
  // It used to be one sub-step, which was the right size when the integration could only stop
  // on a sub-step boundary. It then passed a mover that came to rest 512 client units from the
  // wall — a tenth of a square away, parked where it can make no progress along it — and a
  // tolerance that admits that is not a tolerance, it is a blind spot with a number on it.
  //
  // The trace resolves the wall to within one client unit (it reports `blocked` for an endpoint
  // one unit past the wall and clear for one 64 units short of it), so the integration can be
  // held to that. The reference client lands 12.8 units short because its sub-steps are that
  // size; ours lands ~1 because it bisects the last leg instead. Both are "at the wall"; one
  // unit is inside both, and it is the smallest figure that a correct implementation on either
  // strategy could satisfy.
  // THE TOLERANCE IS THE WIRE'S OWN GRANULARITY, NOT A GENEROSITY.
  //
  // The integration lands within about one client unit of the face (measured: 7423.03 against a
  // face at 7423). But the wire carries WHOLE PROTOCOL units, and one protocol unit is 16 client
  // units, so the closest position that can actually be SENT is up to 16 client units short of
  // the face. Demanding 12.8 — the distance the reference client's sub-steps leave it short —
  // asks for a precision the protocol cannot carry, and would fail a correct mover for a
  // rounding artifact. That is a test that cannot be passed, which is not much better than one
  // that cannot fail.
  //
  // It is derived from the converter rather than written as 16 so it cannot silently become
  // wrong if the scale is ever corrected.
  // ONE PROTOCOL UNIT, asked of the converter the correct way: p2c(n+1) - p2c(n) = 16.
  // The first draft wrote p2c(KOD_FINENESS) - p2c(0), which is the span of a whole SQUARE
  // (1024), and a tolerance one square wide cannot notice a mover standing a square inside a
  // wall — which is precisely the failure this assertion exists to catch.
  const CLIENT_UNITS_PER_PROTO_UNIT = protocolToClient(1) - protocolToClient(0);
  const AT_WALL_TOLERANCE_CLIENT_UNITS = CLIENT_UNITS_PER_PROTO_UNIT;
  // THE ROW MATTERS, AND GETTING IT WRONG MAKES THE TEST A LIE. This room has a doorway at
  // rows 12-14 (DOOR_Y0/DOOR_Y1 above). A character placed on one of those rows reaches the
  // far side WITHOUT touching the wall, every assertion below then passes for a mover that was
  // never offered a wall, and the suite goes green having tested nothing. Row 3 is chosen
  // because the wall stands on it unbroken — verified, not assumed: fineWalkable(3, 8) is false
  // and a trace along row 3 comes back blocked with stopX 7424, short of the wall's line.
  const r = rig(CurrentMover, { col: WALL_COL - 2, row: WALL_ROW_AIM });
  r.startPos = { x: r.session.client.self.x, y: r.session.client.self.y };
  walk(r, WALL_COL + 2, WALL_ROW_AIM, { ticks: 14 });

  const east = r.sent.filter(x => (x.kind === 'moveToSquare' ? x.col * KOD_FINENESS + 32 : x.x) > r.startPos.x);
  const furthest = east.length ? Math.max(...east.map(x => protocolToClient(x.kind === 'moveToSquare' ? x.col * KOD_FINENESS + 32 : x.x))) : -Infinity;
  // MEASURED AGAINST THE WALL THIS ROOM ACTUALLY HAS. The wall is built at WALL_X — the CENTRE
  // of col 8, which is where a wall has to sit for fineWalkable to see it at all (see the long
  // note at WALL_X). WALL_ON_BOUNDARY is a different line, one square west, belonging to the
  // boundary-wall room used by the contract test above. Asserting against that line would call
  // a position inside the wall's own square a violation while letting a position on the FAR
  // side of the wall pass, which is the exact inversion of what a wall test is for.
// MEASURED AGAINST THE LINE THE GEOMETRY ACTUALLY COLLIDES AGAINST.
  //
  // The first draft of this assertion measured against WALL_X - WALL_HALF, the west FACE of a
  // wall described in prose as 514 client units thick. That is not a line anything in this
  // repository enforces. fineWalkable (m59-roo.mjs:1573) and traceFineMoveClient both collide a
  // disc against wall SEGMENTS, and the segments this room is built from lie on the wall's
  // centreline. Measuring against the face therefore asserts a rule the fixture does not
  // implement, and it fails a mover that did exactly the right thing: the integration stopped 48
  // client units short of the centreline — the reference client's own clearance, move.c:100 —
  // and the audit called that 209 units inside a wall.
  //
  // Getting this wrong is not a rounding complaint. An assertion that cannot be satisfied
  // without crippling the thing under test will eventually be "fixed" by crippling it.
  // (2) Even against the centreline, "at the wall" cannot mean ON it. move.c:100 declares
  //     `min_distance = 48` — "Minimum distance player is allowed to get to wall" — and the
  //     client refuses a move that would bring the player inside that. A mover standing on the
  //     line is not at the wall, it is in it. So the position a correct mover comes to rest at
  //     is min_distance short of the line, and that is what this measures. Demanding the line
  //     itself asks the mover to declare something the client's own collision code rejects.
  // THE SAME CLEARANCE THE MOVER USES, IMPORTED RATHER THAN REPEATED.
  //
  // This is the third draft of this line and the first two were wrong in the same way the mover
  // was wrong: they named a clearance instead of taking one. The first measured against the
  // wall's drawn FACE (257 client units inside the geometry's own collision line) and so failed
  // a mover that had done the right thing. The second used move.c:100's literal 48 without
  // noticing that move.c:122 overwrites it, or that the trace takes CLIENT units while move.c
  // works in protocol units — a factor of sixteen.
  //
  // The lesson is the one this task was created to teach: a constant copied out of the unit
  // system it was written in is not a constant, it is a coincidence. So the clearance is
  // imported from the mover, which is the only place that decides it, and this assertion cannot
  // drift from the implementation again. If the mover's clearance changes, what "at the wall"
  // means changes with it, in the same commit, or the suite will say so.
  const WALL_LINE = WALL_X;
  const CLEARANCE = PLAYER_WALL_CLEARANCE_CLIENT_UNITS;
  const WHERE_IT_MAY_REST = WALL_LINE - CLEARANCE;
  // The wire carries WHOLE protocol units (protocol.h:75 passes an int), and one protocol unit
  // is 16 client units, so the closest position that can physically be declared is up to one
  // protocol unit short of the clearance line. That is the smallest tolerance a correct
  // implementation can satisfy, and it is a property of the wire, not a generosity.
  const ONE_PROTOCOL_UNIT = protocolToClient(1) - protocolToClient(0);
  const short = WHERE_IT_MAY_REST - furthest;

  console.log(`  ${r.sent.length} packets; furthest eastward position is ${furthest.toFixed(1)} client units, wall line ${WALL_LINE}, closest legal rest ${WHERE_IT_MAY_REST}, short by ${short.toFixed(1)}`);
  console.log(`  sends: ${r.sent.map(x => `${x.x}@c${protocolToClient(x.kind === 'moveToSquare' ? x.col * KOD_FINENESS + 32 : x.x).toFixed(0)}/${x.kind}${x.sp ?? ''}`).join(' ')}`);

  ok('it does send eastward at all', east.length > 0,
    `${east.length} eastward sends — a mover that refuses to move satisfies "never past a wall" while telling us nothing`);
  ok('no eastward send crosses the wall', east.every(x => protocolToClient(x.kind === 'moveToSquare' ? x.col * KOD_FINENESS + 32 : x.x) <= WHERE_IT_MAY_REST),
    `a send is east of ${WHERE_IT_MAY_REST} — the closest a client may legally be to the wall's collision line at ${WALL_LINE}, once move.c:100's clearance is honoured`);
  ok('the last position is AT the wall, within a sub-step of it', Number.isFinite(short) && short >= 0 && short >= 0 && short <= ONE_PROTOCOL_UNIT,
    `stopped ${short.toFixed(1)} client units short of the wall. The tolerance is ${AT_WALL_TOLERANCE_CLIENT_UNITS} — the distance the reference client's own sub-steps leave it short (move.c:266-268). Further short than that is a mover parked where it cannot progress along the wall, which is the failure the escape fan exists to fix and which "did not cross the wall" does not excuse.`);

  // AND THEN IT STOPS, WHICH IS CORRECT AND MUST NOT BE “FIXED”.
  //
  // This assertion used to demand the opposite: that the mover keep reporting from the wall, on
  // the theory that a mover which goes quiet has wedged. That theory is wrong, and the
  // assertion was about to cause real damage — the change it was pushing for (open the gate on
  // the interval regardless of ground) breaks the send law seven other tests exist to protect,
  // because it puts a packet on the wire every second with nothing in it.
  const parked = east.filter(x => {
    const cx = protocolToClient(x.kind === 'moveToSquare' ? x.col * KOD_FINENESS + 32 : x.x);
    return Math.abs(cx - furthest) < 1;
  });
  //
  // What the reference client actually does, at a wall:
  //
  //   move.c:745   if (now - server_time < MOVE_INTERVAL || !pos_valid) return;   // rate limit
  //   move.c:770   if ((server_x - x)^2 + (server_y - y)^2 > MOVE_THRESHOLD) {
  //                  RequestMove(y, x, speed, player.room_id);
  //                  server_x = x; server_y = y; server_time = timeGetTime();
  //                }
  //
  // The content rule compares against the SERVER's known position and then sets that position
  // to the one just sent. So once the character has reported where it came to rest, the
  // difference is zero and no further packet is produced. A client parked at a wall is silent,
  // and silence is the correct end state of a walk into an obstacle.
  //
  // What is NOT correct, and is the thing this suite is actually for, is being silent in a
  // position the client could not have reached. So the assertion measures that instead: the
  // sends stop, and every one of them is legal.
  ok('it goes quiet at the wall, as the reference client does', parked.length <= 2,
    `${parked.length} sends at the resting position — the reference client compares against the server's known position and stops once they agree (move.c:770); repeating a position it has already reported is the packet-spam this gate exists to prevent`);
}

console.log('\nTHE SAME DEFECT IN THE DELETED VELOCITY DECLARATION (diagnostic, not a verdict)');
{
  // Kept for the record, and labelled so nobody mistakes it for a passing reproduction.
  //
  // The pre-fix mover is run in a room whose wall its OWN slide-along-wall check can see.
  // That check traces the beeline to the aim and hands the tick to the escape fan when the
  // trace is blocked, so the velocity declaration below it never executes — and the run
  // produces no violations. That is a true fact about the old design and it is worth stating
  // plainly, because it explains why the class of bug went unnoticed for as long as it did:
  // the guard that hid it was doing so by declining to run the code it was supposed to
  // protect. A violation reachable only when a guard is not looking is invisible to a test
  // that only looks where the guard is not.
  //
  // It is also why restoring the engine in step 3 must give the DECLARATION its own clamp
  // rather than lean on the slide check. A guard that intercepts is not the same as a
  // statement that cannot be wrong, and the one path that skipped the guard — `standOnNear`,
  // a stand_on destination near the mover — ran the declaration unguarded.
  const r = rig(PreFixMover, { col: WALL_COL - 2, row: WALL_ROW_AIM, velocity: true });
  r.startPos = { x: r.session.client.self.x, y: r.session.client.self.y };
  const { result, log } = captureBranch(() => { walk(r, WALL_COL + 2, WALL_ROW_AIM, { ticks: 40 }); return r.sent.length; });
  const v = auditSends(r);
  console.log(`  pre-fix mover: ${result} packets, ${v.length} violations, declaration entered=${/vel-tick/.test(log)}`);
  ok(`DIAGNOSTIC pre-fix: entered=${/vel-tick/.test(log)}, violations=${v.length}`, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
