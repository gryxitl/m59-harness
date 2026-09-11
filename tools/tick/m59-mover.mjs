#!/usr/bin/env node
// m59-mover.mjs -- THE FINE-MODEL MOVER: one legal STRIDE per tick, integrated.
//
// The server does not check geometry for players (UtilGoToSquare short-circuits
// the walkability veto). BUT UtilGoNearSquare spirals outward from the declared
// square looking for a legal one — a declaration at an illegal square does NOT
// fail, it lands somewhere nearby. If there is no legal square nearby, the
// character stays put. "All 8 raw moves refused" is a misnomer: the moves are
// landing on the same square, not being refused. Collision is our responsibility.
//
// IMPORTANT: "the server is client-authoritative" is a shorthand that has led to
// misdiagnosis. What it means: the server does NOT check geometry for players
// (UtilGoToSquare short-circuits the walkability veto). What it does NOT mean:
// the server always accepts the declared position. UtilGoNearSquare spirals
// outward from the declared square looking for a legal one. If there is no
// legal square nearby, the character stays put. "All 8 raw moves refused" is a
// misnomer: the moves are landing on the same square, not being refused.
// See docs/MOVEMENT-ENVELOPE.md for the full picture.
//
// THE SPEED BUDGET — AND THE ERROR THAT MADE THE FLEET CRAWL
//
// This header used to read, in capitals, 'ONE TICK = ONE STEP OF AT MOST MOVEUNITS. No more, no
// less', and derived 16 protocol units from the client source. Every line of that derivation was
// arithmetically correct and the conclusion was off by ten, because it attached MOVEUNITS to the
// wrong clock. From the source, with the three constants in their own words:
//
//   draw3d.h:53    #define MOVEUNITS (FINENESS >> 2)          = 256 client units
//   drawdefs.h:42  #define FINENESS  1024L                    (a square, in the client's space)
//   move.c:49      #define MOVE_DELAY 100   // ms between moving MOVEUNITS
//   move.c:57      #define MOVE_INTERVAL 1000 // Inform server at most once per this many ms
//   move.c:187     default: move_distance = MOVEUNITS         (2*MOVEUNITS for the FAST actions)
//
// MOVEUNITS is the distance per MOVE_DELAY — one hundred milliseconds. A tick, which is what this
// mover runs on, is MOVE_INTERVAL: one thousand. Ten MOVE_DELAYs fit in one tick. So the distance
// a real client covers between two reports is 10 * 256 = 2560 client units = 2.5 SQUARES, and the
// 16 protocol units this header computed is the distance covered in a TENTH of a tick.
//
// 'ONE TICK = ONE STEP OF AT MOST MOVEUNITS' is not a conservative reading of the client. It is
// the client's own rate divided by ten and then defended as a law. The fleet has been moving at
// that since the header was written, which is why it crawls and why the real client, watched in
// the same room, walks away from it.
//
// The stride this file uses is therefore WALK_STRIDE_PROTO = 160 protocol units = 2.5 squares,
// with RUN_STRIDE_PROTO for the fast actions, and it is covered by INTEGRATION over the tick —
// sub-stepped and collision-checked per move.c:266 and move.c:374 — not by a single declaration
// of a far point. The reporting rate is unchanged and still matches the client: at most one packet
// per MOVE_INTERVAL.
//
// PLANNING
//
// The mover uses finePathProtocol (a bounded A* on the fine model) to plan
// a path around walls. It follows the waypoints one stride per tick. If the
// path is blocked mid-way (stale geometry, a new wall appeared), it replans
// from the current position. If finePathProtocol reports "no fine path", the
// mover reports "no-route". If it reports "search budget exhausted", the
// mover reports "search-exhausted". These are different answers and the
// caller can distinguish them.
//
// A REGION EXIT IS A DOOR THAT IS INVISIBLE TO EVERY WALKABILITY PREDICATE.
//
// Some rooms implement their borders in kod instead of `plEdge_Exits`, so the bake sees
// `edgeExits: []` and the geometry says the whole corner is ordinary floor. Marion (200) is the
// case that produced this: `marion.kod:150` opens `SomethingMoved` and tests two corners --
//
//   if (new_row < 32) and (new_col > 66)  -> RID_C4 (534), arriving at 34,5
//   if (new_row > 83) and (new_col > 48)  -> RID_C5 (535), arriving at 3,23
//
// Nothing in `transitBanned`, `fineWalkable`, `standable` or `inBounds` can see either. A mover
// asked to walk to (50,85) -- which is INSIDE the second corner, the correct destination -- will
// blunder through the first one on the way, get teleported to room 534, be re-sent to Marion by
// the router, and walk into it again. Measured live: `trans=75` room transitions with the
// character never leaving the pair of rooms, and 79 of 1,653 move declarations landing inside the
// unwanted corner.
//
// THE RULE IS NOT "corners are impassable". A corner is the door for exactly ONE room, so it is
// forbidden only when it is not the room we are travelling to. Banning it unconditionally would
// seal the exit we are trying to reach, which is the opposite bug.
//
// The cost is small and measured rather than assumed: in Marion, the C4 corner is 837 squares of
// which only 22 are walkable, and the C5 corner is 225 of which only 15 are. These are tight
// doorways, not open ground, which is why they are safe to exclude and also why a mover can
// stumble into one -- there is no room to be merely near it.
export function regionCornerBanned(geo, row, col, wantRoom) {
  if (!geo) return false;
  const num = geo.roomNum ?? geo.num;
  if (num == null) return false;
  let exits;
  try { exits = codeExits(num); } catch { return false; }
  if (!Array.isArray(exits) || !exits.length) return false;
  for (const e of exits) {
    if (e.to == null || !Array.isArray(e.when) || !e.when.length) continue;
    // The door for the room we actually want: walk through it freely.
    if (wantRoom != null && e.to === wantRoom) continue;
    let inCorner = true;
    for (const c of e.when) {
      const v = c.axis === 'row' ? row : c.axis === 'col' ? col : null;
      if (v == null) { inCorner = false; break; }
      if (c.op === '<' && !(v < c.value)) { inCorner = false; break; }
      if (c.op === '>' && !(v > c.value)) { inCorner = false; break; }
      if (c.op === '==' && !(v === c.value)) { inCorner = false; break; }
    }
    if (inCorner) return true;
  }
  return false;
}

// The straight-line + brute-force fan from the previous revision is gone.
// The raw-move fallback remains as a last resort for stale geometry where
// the fine model says "wall" but the server says "floor".

import { protocolToClient, clientToProtocol, KOD_FINENESS, PLAYER_RADIUS } from '../m59-roo.mjs';
import { codeExits } from '../m59-map.mjs';
import { isGrounded, isEmbedded, nearestGrounded, segHeightOk, transitBanned } from './m59-ground.mjs';
import { Pose } from './m59-pose.mjs';
import '../m59-navgeom.mjs';   // installs the height model + lenient fine path onto RoomGeometry

// WHO MAY OWN THE DESTINATION. Setting a destination throws away the previous
// one's path, stuckTicks and escape fan, so simultaneous callers destroy each
// other's planning. Rank by how much planning sits behind the aim: the router
// walks a multi-leg route and a stolen leg loses the whole route; recovery is a
// single escape; combat and patrol are opportunistic and can wait a tick.
// An unrecognised caller gets OWNER_RANK_DEFAULT, which is below every named
// owner — a caller that has not declared itself cannot take a destination from
// one that has.
export const OWNER_RANK = { router: 100, recovery: 60, buy: 40, combat: 30, patrol: 20 };
export const OWNER_RANK_DEFAULT = 10;
// An owner that has not touched the destination in this long has abandoned it,
// so the guard must not freeze movement forever. Well above the ~1s send law and
// the ~1.2s echo cadence, so a live owner never looks stale mid-step.
export const OWNER_STALE_MS = 10000;

// CANDIDATE ORDERING (pure, unit tested). Loop avoidance (unvisited
// squares first) engages ONLY while genuinely stuck (stuckTicks >= 3,
// the fan threshold — the echo lags ~1s, so 1-2 static ticks are healthy
// movement, not stuck): applied any earlier it turns straight walks into
// a drunkard's dither. While the server advances, walk straight at the
// goal; dead ends backtrack once static.
/** How long a server-refused step stays excluded from the next plan. See
 *  Mover._noteRefusedStep. Nine move intervals at the 1000ms cadence. */
export const REFUSED_STEP_TTL_MS = 45_000;

export function orderCandidates(candidates, recentSteps, stuckTicks, opts = {}) {
  const taboo = stuckTicks >= 3 ? (recentSteps ?? []) : [];
  let list = candidates;

  // SQUARES THE SERVER HAS ACTUALLY REFUSED, which is a different thing from squares we
  // have recently walked on and must not be conflated with them.
  //
  // `taboo` above is SOFT: refused squares are moved to the back and remain eligible.
  // That is right for our own footfall and wrong for a refusal. Measured on the live
  // shard, one character declared the same step four times in four seconds (n=746..749,
  // at=480,480 from srv=480,416) and the server did not move it once; then the mover
  // re-planned, the new path began with the square it had just come from, and it walked
  // back. The refused square reappears as a candidate on the next plan because the bake
  // says it is walkable — fineWalkable, walkable, standable, moverStepLands,
  // stepAllowedByCollision and heightStepOk all say true, and the two squares are the
  // same floor height. The bake is not wrong about the geometry; it is silent about the
  // thing standing there.
  //
  // A soft reorder cannot fix that, because the square is the SHORTEST route and so sorts
  // to the front again the moment it leaves the 8-entry window. It needs to be excluded
  // outright, for as long as a refusal plausibly still means what it meant.
  const refused = opts.refused ?? [];
  if (refused.length) {
    const hard = list.filter(([cc, rr]) => !refused.includes(cc + ',' + rr));
    // If EVERY candidate was refused we must still move, or a character with a fully
    // refused neighbourhood would freeze in place — the failure this is meant to cure.
    // Fall back to the unfiltered list, which is the pre-existing behaviour.
    list = hard.length ? hard : list;
  }
  // MONSTER RULE (monster.kod MoveInDirection): never step 180 degrees
  // from the goal — wall-follow with the perpendiculars instead. Applies
  // only while moving; a genuinely stuck character may backtrack anywhere.
  const { meCol, meRow, goalCol, goalRow } = opts;
  if (stuckTicks < 3 && meCol != null && goalCol != null) {
    const ox = meCol - Math.sign(goalCol - meCol);
    const oy = meRow - Math.sign(goalRow - meRow);
    list = list.filter(([cc, rr]) => !(cc === ox && rr === oy));
  }
  return taboo.length
    ? [...list.filter(([cc, rr]) => !taboo.includes(cc + ',' + rr)),
       ...list.filter(([cc, rr]) => taboo.includes(cc + ',' + rr))]
    : list;
}
// DITHER VERDICT (pure — unit tested). The progress window holds
// {t,col,row,sends} samples (server squares); full when it spans winMs.
// Dithering = full window + net displacement of at most a square + sends
// flowed (a 1-square N-S jitter moves the server every tick, defeating
// stuck-counting, while going nowhere). Stillness without sends is rest.
export function dithered(window, nowMs, winMs) {
  if (!window?.length) return false;
  const first = window[0];
  // 2s tolerance: ticks run slightly under 10Hz, so a nominally-15s window
  // of ~148 samples spans ~14.8s and would otherwise never read full.
  if (nowMs - first.t < winMs - 2000) return false;
  const last = window[window.length - 1];
  const net = Math.max(Math.abs(last.col - first.col), Math.abs(last.row - first.row));
  return net <= 1 && (last.sends ?? 0) > (first.sends ?? 0);
}

// THE CLEARANCE A PLAYER KEEPS FROM A WALL, in the units our trace takes them.
//
// THE UNITS ARE THE WHOLE STORY, AND GETTING THEM WRONG IS THE BUG THIS TASK EXISTS TO CATCH.
// traceFineMoveClient takes its radius in CLIENT units and offsets the swept disc by exactly
// that much — measured, not assumed: 48 stops 48 client units short of a segment, 256 stops 256,
// 3968 stops 3968. One protocol unit is 16 client units (protocolToClient is
// (v - KOD_FINENESS) * 16). A clearance stated in the wrong system is wrong by a factor of
// sixteen and presents itself as a tuning choice rather than as an error.
//
// Three drafts of this constant, all wrong, all in the same way:
//
//   1     A POINT. A point can be placed on a wall line and a player cannot, so the geometry's
//         "yes" here is something the client's own collision code refuses. It produced a mover
//         that parked with its nose one client unit from a wall, and a test that watched it
//         declare positions inside the wall's drawn body while reporting that it had stopped AT
//         the wall.
//   48    move.c:100's `static int min_distance = 48`, copied without noticing that move.c:122
//         overwrites it two lines later with player.width/2. The initialiser is not the value.
//   256   A quarter square, which happens to be PLAYER_HEIGHT's client figure divided by three.
//         Right order of magnitude, wrong quantity, arrived at by coincidence.
//
// The codebase had already answered this and I had not read it: m59-roo.mjs:143-145 works out
// the same move.c:122 figure — PLAYER_WIDTH = 31 * KOD_FINENESS / 4 = 496 PROTOCOL units,
// PLAYER_RADIUS = 248 of them. In the units our trace takes, 248 * 16 = 3968. Importing the
// existing constant is the fix; the fourth guess would have been wrong too.
//
// The consequence is worth stating because it looks like a regression: a 3968-unit clearance is
// 3.875 squares of dead zone on each side of a wall, so a corridor four squares wide is not
// walkable by trace at all. That is not this constant being too careful — it is the client's
// own cylinder, and it is why the coarse walkable-square graph is what routes between rooms
// while the trace is only ever asked about the last few units before a wall. Asking the trace to
// plan a route is asking a collision test to do pathfinding.
// One protocol unit is 16 client units; protocolToClient is (v - KOD_FINENESS) * 16.
// (CLIENT_UNITS_PER_PROTOCOL_UNIT was here for a draft that scaled PLAYER_RADIUS into the
// trace's space. The trace takes the same space PLAYER_RADIUS is stated in, so the scale factor
// was a bug dressed as a conversion.)
export const PLAYER_WALL_CLEARANCE_CLIENT_UNITS = PLAYER_RADIUS;

// 256 client units = 16 protocol units per 100ms tick (walking).
// Running is 2 * MOVEUNITS = 32 protocol units.
export const MOVEUNITS_PROTO = 16;
// OFFICIAL PER-SECOND STRIDE (verified: clientd3d/move.c + user.kod UserMove).
// The server ACCEPTS the declared position per packet (~1 pkt/s speedhack
// law: counter +1/pkt, -1/sec, threshold 2) and never interpolates — speed
// IS displacement per packet. Walk: 160 proto units (2.5 sq/s, speed byte
// 18). Run: 320 (5 sq/s, byte 36, needs vigor — kod VIGOR_RUN_THRESHOLD is
// 10; we require RUN_VIGOR_FLOOR so sustained travel doesn't arrive gassed
// and immediately rest). Packets displaced ≥ ~14 squares trip teleport
// detection (blink exempt), so aims are clamped to one stride.
// RUN IS THE DEFAULT (policy.allowRun === false opts out): speed is survival —
// walking through danger gets characters killed. Running drains vigor ~4x per
// move (exertion scales with speed squared, user.kod). RUN_VIGOR_FLOOR keeps a
// margin above kod VIGOR_RUN_THRESHOLD (10, below which >18 rubber-bands) and
// keeps the character fight-capable on arrival (ineffective below 20). Walk is
// reserved for low/unknown vigor and the precision paths below (fan probes,
// door pushes, boundary walk-past, step model), which hardcode speed 18.
export const WALK_STRIDE_PROTO = 160;
export const RUN_STRIDE_PROTO = 320;
export const RUN_VIGOR_FLOOR = 25;
export const RUNUNITS_PROTO = 32;

// LAZY POSITION REPORTING — modeled directly on the real client (clientd3d/move.c).
// The client does NOT send a "go to X" command every frame. It moves the player locally
// (physics + BSP collision) and only REPORTS its position to the server when BOTH:
//   (a) >= MOVE_INTERVAL since the last position packet, AND
//   (b) it moved more than MOVE_THRESHOLD since the last reported position.
// A human holding a key therefore produces ~1 position packet/second, not 10/second.
// We were the opposite: the mover sent a moveTo every tick (10Hz) = 10-18 packets/s, which
// tripped the server's INCOMING_PACKET_THROTTLE = 5 (user.kod:50) and got us marked a
// spammer, silently dropping packets. See docs/packet-throttle.md.
//
// MOVE_INTERVAL = 1000ms (move.c:60): at most one position packet per second.
// MOVE_THRESHOLD = (FINENESS/4)² (move.c:63): only report if we moved a meaningful
//   distance. FINENESS = KOD_FINENESS = 64 protocol units, so the threshold is 16
//   protocol units = 0.25 squares. We report in protocol units; the squared threshold
//   is MOVE_THRESHOLD_PROTO² (compare squared distance, no sqrt).
const MOVE_INTERVAL_MS = 1000;
// move.c:52-53, the resolution of the local integration. 200 sub-steps per second of
// attempted movement, never more than 20 in a single move. The cap is load-bearing: the
// sub-steps exist so a thin wall cannot be stepped OVER, and a step count that grew with the
// distance being covered would stretch with it and let a long declaration sail past a short
// obstacle. See _integrateToward.
const NUM_STEPS_PER_SECOND = 200;
export const STEPS_PER_MOVE = 20;   // exported so a test can state a tolerance in sub-steps rather than guess one
const MOVE_THRESHOLD_PROTO = KOD_FINENESS / 4;  // 16 protocol units
const MOVE_THRESHOLD_PROTO2 = MOVE_THRESHOLD_PROTO * MOVE_THRESHOLD_PROTO;

const HALF = KOD_FINENESS / 2; // 32 protocol units = half a square

/**
 * The fine-model mover. Plans on wall segments (not the coarse grid),
 * moves at most MOVEUNITS per tick, and handles the sitting trap.
 *
 * Usage:
 *   const mover = new Mover(session);
 *   mover.to(col, row);          // set destination (protocol square coords)
 *   mover.tick();                // one step per tick, returns state
 *   mover.clear();               // stop
 */
// THE MOVE-SUBMIT CADENCE, IN MILLISECONDS. ONE CONSTANT, BECAUSE THERE WERE TWO.
//
// The constructor default and the `_claimMoveSlot` fallback both said 1050 independently. Two
// literals for one policy is how a cadence becomes folklore: change one, and a mover built with the
// option gets one rate while a mover built without it gets another, silently.
//
// IT IS NOW 1000, WHICH IS WHAT THE SERVER'S OWN ARITHMETIC PERMITS AND WHAT THE CLIENT USES.
//
// For the whole life of this project 1050 was defended as the speedhack law. The law is
// user.kod:2937:
//
//   piMovesCounter = bound((piMovesCounter + 1) - iDelta, -MOVEMENT_DELTA_LAG_THRESHOLD, $)
//   if piMovesCounter > MOVEMENT_COUNT_THRESHOLD(2) -> Debug("ALERT! ... Possible speedhacker.")
//
// iDelta is the WHOLE SECONDS since the last packet. At a 1000 ms cadence iDelta is 1 for every
// packet, so the counter is (c + 1) - 1 = c and sits at ZERO forever. It never rises. The ALERT
// needs a counter above 2, which needs THREE packets inside one server second — and a 1000 ms
// cadence with sub-second jitter produces two, not three.
//
// The 50 ms bought nothing. It cost 4.8% of our locomotion, and it was the ONLY thing standing
// between us and the client's own rate: 5 squares per packet at 1000 ms is 5.00 squares/second,
// which is the client's run speed exactly, not 95% of it.
//
// WHY THIS IS NOT A SPEEDHACK, WHICH IS A DIFFERENT QUESTION FROM WHETHER IT IS ALLOWED.
// The server caps nothing: user.kod:3064 detects a squared row/col distance >= 200 and only writes
// a log line and drains vigor — line 3099 sends SomethingMoved unconditionally afterwards. So we
// COULD declare 14 squares a second and the server would move us. We do not, because the client's
// 5 squares per packet is the MEASURED RESULT of one second of locomotion, and our 320-unit stride
// is the same 5 squares because it is the same stride over the same interval. Matching the client
// means matching its rate, not exploiting the absence of a cap.
//
// THE RISK WE ARE ACCEPTING, STATED RATHER THAN HIDDEN: the margin is one packet. If the network
// or the pacer ever delivers three position submits inside one server second, the counter reaches
// 3 and draws an ALERT. That is a LOG LINE naming the character, not a ban and not a refused move,
// and it is the same line a legitimate player behind a laggy connection can draw — which is why
// the server tolerates a counter of 2 and decays it by elapsed time. `cadence_report()` now records
// the real gap distribution so this is a measured risk rather than the unmeasured one it was: our
// log lines have never carried a timestamp, and the gap has never once been recorded.
export const MOVE_CAP_MS = 1000;

// High-volume mover diagnostics (coarse-tier, movestuck, path-null, path-install,
// movedbg fan-released), off by default. Set M59_MOVER_TRACE=1 to restore the full
// firehose. The load-bearing low-volume signals (move-sent, step-refused, void-probe,
// mover-hb, tick-state) are NOT gated here and always log.
function _trace(...args) {
  if (process.env.M59_MOVER_TRACE === '1') console.error(...args);
}

export class Mover {
  constructor(session, { reportIntervalMs = MOVE_INTERVAL_MS, moveCapMs = MOVE_CAP_MS } = {}) {
    this.session = session;
    // The central move-submit cap, injectable like the report interval so the
    // rig can tick in microseconds (live default 1050ms: the speedhack law).
    // The move gate's interval, injectable so the test rig can tick faster than
    // one step per second of wall time (the live default, MOVE_INTERVAL_MS, matches
    // the client's own report rate — move.c:60 — and must not change).
    this.reportIntervalMs = reportIntervalMs;
    this._moveCapMs = moveCapMs;
    this.dest = null;       // { col, row } in protocol square coordinates
    this.destProto = null;  // { x, y } in protocol units (centre of dest square)
    this.path = null;       // [ {x, y} ] waypoints in protocol units, index 0 = next
    this.pathIdx = 0;
    this.sitting = false;   // we think the character is sitting
    this.lastPos = null;    // last confirmed position { col, row }
    this.lastConfirm = 0;   // wall-clock ms of last confirmPosition
    this.stuckTicks = 0;    // consecutive ticks with no position change
    // DEAD RECKONING: the server does not push our position.
    // Between confirmations, we estimate where we are by
    // tracking the steps we sent. This is the `predicted`
    // flag on objects, made explicit.
    this.drX = null;        // dead-reckoned x in client units
    this.drY = null;        // dead-reckoned y in client units
    this.confirmInterval = 2000; // ms between confirmPosition calls
    // LAZY POSITION REPORTING state (the client's MoveUpdateServer model).
    // We only send a position packet when >= MOVE_INTERVAL_MS since the last report AND
    // we moved > MOVE_THRESHOLD_PROTO since the last reported position. This is what keeps
    // movement production at ~1/s (like a human) instead of 10/s.
    this._lastReportAt = 0;      // wall-clock ms of the last position packet sent
    this._lastReportX = null;    // protocol x of the last reported position
    this._lastReportY = null;    // protocol y of the last reported position
    // RAW-MOVE FALLBACK STATE
    this._fanIndex = null;
    this._fanTarget = null;
    this._fanFrom = null;
    this._blinkPending = false;
    this._blinkFrom = null;
    this._blinkAt = null;
    this._voidBlinkAt = 0;   // wall-clock ms of the last void-blink attempt
    this._arriveBase = null;   // server square when the current dest was set
    this._roomKey = null;    // last seen room identity (id|num|name)
    this._roomChangedAt = 0; // wall-clock ms of the last room change
    this._simX = null;
    this._simY = null;
    this._simAt = 0;
    this._lastWpKey = null;
    // PHASE 0a: velocity bookkeeping. Each packet IS one accepted server
    // position (user.kod UserMove); _lastSentKey/Pos record the last send
    // for teleport-change detection. There is deliberately NO hold gate:
    // the server never interpolates, so holding after one step freezes.
    // _lastSentKey: the target (x,y) we last sent. _lastSentPos: the character
    // position at send time.
    this._lastSentKey = null;
    this._lastSentPos = null;
  }

  /**
   * PHASE 0a: record that we sent a move toward (keyX, keyY) while the
   * character was at (posX, posY). Bookkeeping for teleport-change
   * detection; sends are throttled by the 1/s gate, never held.
   */
  // keyX/keyY is the DESTINATION (what the mover is heading for), posX/posY is where the mover
  // thinks it is, and atX/atY is the POSITION THAT WENT ON THE WIRE. Only the last can measure
  // ground covered, and it can only come from the caller: the nine send sites each compute their
  // own position (a stride, a fan probe, a rounded-backward wall stop), and there is no way to
  // recover it afterwards. An earlier draft reached for `this._lastMoveSent`, which is set by one
  // site out of nine — the same 'one of nine sites logs anything' defect the historical
  // '244,021 sends' figure was made of, reintroduced while complaining about it.
  // `site` NAMES THE BRANCH THAT SENT THIS PACKET, so the count cannot drift from the code.
  // The historical '244,021 sends' was a count of the log text `moveTo sent`, which is one of
  // nine send sites — a metric taken from whatever happened to be logged. Guessing the branch
  // from which debug line preceded a packet is the same error in a new form, and I did it
  // tonight: that heuristic attributed 187 packets to a session the instrument said held 139.
  // So each site states its own name at the one place every packet must pass through, and the
  // per-branch rate becomes a fact in the log rather than an inference about it.
  _recordSend(keyX, keyY, posX, posY, atX, atY, site = 'unlabelled') {
    this._lastSentKey = `${Math.round(keyX)},${Math.round(keyY)}`;
    this._lastSentPos = { x: posX, y: posY };
    this._sendCount = (this._sendCount ?? 0) + 1;
    // ONE LINE PER PACKET, EMITTED WHERE THE COUNT LIVES.
    //
    // The fleet's movement rate was never measurable, and the reason is embarrassingly mundane:
    // this mover has nine `moveTo` call sites and exactly one of them logged anything. Any count
    // taken from the log was therefore a count of one branch. Worse, the historical baseline
    // everyone has been quoting — '244,021 sends' in keeper-t1.log — was a count of the string
    // `moveTo sent`, which is that one branch's log text. It is not a number of packets, it is a
    // number of lines matching a sentence, and it changed when the sentence changed without any
    // change in behaviour. A metric that moves when a comment moves is not a metric.
    //
    // So the line is emitted here, at the single place every send is already required to pass
    // through on pain of the teleport detector misfiring. If a future send site forgets to call
    // this, the counter is wrong in a way that breaks something else, which is the only kind of
    // guarantee this file has ever had. `sent=` is the packet count; `aim=` is the position the
    // packet declared, which is the quantity the locomotion rate is actually made of.
    try {
      // `at=` IS THE PACKET'S PAYLOAD AND IS THE ONLY POSITION THAT MEANS ANYTHING HERE.
      //
      // The first version of this line logged only `from=`, which is the mover's SIM position.
      // Every rate computed from it was wrong, and the wrongness was invisible because the
      // numbers looked plausible: the sim jumps to wherever the last declaration aimed, so
      // consecutive `from` values differ by the stride rather than by the ground covered, and a
      // 'squares per packet' figure came out at 2.24 for a character that was standing still.
      // The wire carries the position we declared, so that is what gets logged. `aim=` stays
      // because the freeze diagnostic needs the destination, and the two are only equal by
      // accident.
      // `srv=` IS THE SERVER'S POSITION AT THIS PACKET. It is read here, at the one place every
        // send passes, rather than left to the branch-specific debug lines — and that placement
        // is the difference between a measurement and a guess. Ground computed by differencing
        // server positions that appear on some packets and not others is a rate taken across
        // an irregular sample, which is why the fleet's squares-per-second has been a range
        // (0.09, 0.34, 0.39) all evening instead of a number.
        try { this.session?._pose?.noteDeclared?.(atX, atY); } catch {}
        console.error(`[move-sent] n=${this._sendCount} site=${site} at=${Math.round(atX)},${Math.round(atY)} aim=${Math.round(keyX)},${Math.round(keyY)} from=${Math.round(posX)},${Math.round(posY)} srv=${Math.round(this.session?._pose?.server?.x ?? -1)},${Math.round(this.session?._pose?.server?.y ?? -1)} simSrc=${this.session?._pose?.sim == null ? 'SEEDED (clamped to one square)' : 'tracked'}`);
    } catch {}
  }

  /**
   * Set the destination. col/row are protocol square coordinates
   * (the same space as client.self.col/.row).
   */
  to(col, row, { standOn = false, edgeTarget = null, by = null, wantRoom = null } = {}) {
    // The room this destination is ultimately FOR. Used only to decide which of a room's
    // kod teleport corners may be walked through; see regionCornerBanned.
    // Never poison the destination: a non-finite col/row makes destProto NaN,
    // and every later send throws RangeError inside a swallowed catch —
    // counted by the pacer, never on the wire, frozen with zero errors.
    if (!Number.isFinite(col) || !Number.isFinite(row)) {
      console.error(`[mover] to() refused non-finite dest col=${col} row=${row} (keeping ${this.dest ? this.dest.col + ',' + this.dest.row : 'none'})`);
      return false;
    }
    // ONE OWNER OF THE DESTINATION. Every caller that sets a destination also
    // resets path/stuckTicks/fan below, so an unguarded re-aim throws away the
    // planning of whoever set it last. keeper-t1.log counted 13,619 destination
    // changes against 244,021 sends: the mover was re-aimed ~1.4x per step, A*
    // never finished a search, stuckTicks never accumulated, and the escape fan
    // was cleared before it could fire. The fix is rank order: a caller may take
    // the destination only from a strictly lower-ranked one, and only from a
    // stamp that has gone stale. Refusal is visible (returns false, logs a
    // reason) and mutates NOTHING — path, stuckTicks and fan all survive.
    if (this.dest && (this.dest.col !== col || this.dest.row !== row)) {
      const rank = OWNER_RANK[by] ?? OWNER_RANK_DEFAULT;
      const held = this._owner ?? null;
      const heldRank = OWNER_RANK[held] ?? OWNER_RANK_DEFAULT;
      const stale = Date.now() - (this._ownerAt ?? 0) > OWNER_STALE_MS;
      // THE OWNER MAY ALWAYS RE-AIM ITS OWN DESTINATION. This guard exists to stop a
      // lower-priority caller (combat, patrol) from stealing a route out from under the router
      // and resetting the path every tick — the thrashing this mover was rebuilt for. It used
      // `rank <= heldRank`, which also refuses the holder ITSELF: observed live as
      // `to() DEFERRED: 'router' rank=100 wants 71,49 but 'router' rank=100 holds 69,49`, over
      // and over, while the mover walked toward the stale 69,49 and then fell silent with
      // gateAge past 20 minutes and stuck past 13,000. A router walks a route as a sequence of
      // destinations; a guard that forbids it from updating its own destination does not
      // protect the route, it freezes the character on the first leg. Equality is the owner,
      // not a rival of equal rank.
      if (!stale && by !== held && rank <= heldRank) {
        // Same-rank or lower, and the owner is live: defer. The owner is still
        // responsible for this destination; if it has genuinely finished, it
        // clears it, or it goes stale in OWNER_STALE_MS.
        if (Date.now() - (this._ownerDbgAt ?? 0) > 5000) {
          this._ownerDbgAt = Date.now();
          try {
            console.error(`[movedbg] to() DEFERRED: '${by ?? '?'}' rank=${rank} wants ${col},${row} but '${held ?? '?'}' rank=${heldRank} holds ${this.dest.col},${this.dest.row} (owner age ${Math.round((Date.now() - (this._ownerAt ?? 0)) / 1000)}s)`);
          } catch {}
        }
        return false;
      }
    }
    // A NEW destination (different from the current one) resets path/fan state.
    // The router calls to() every tick with the same aim while walking, so we
    // must NOT reset on a no-op to() — that would defeat planning and send a
    // packet every tick again. Only a genuine re-route resets it.
    const isNewDest = !this.dest || this.dest.col !== col || this.dest.row !== row;
    if (isNewDest && Date.now() - (this._toDbgAt ?? 0) > 5000) {
      this._toDbgAt = Date.now();
      try { console.error(`[movedbg] ${this.logName} to() -> ${col},${row} (was ${this.dest ? this.dest.col + ',' + this.dest.row : 'none'}) by=${by ?? '?'}`); } catch {}
    }
    this.dest = { col, row };
    // WHO OWNS THE DESTINATION, RECORDED AT THE ONLY PLACE IT IS EVER SET.
    // The DEFERRAL side of the ownership guard was logged and the ACCEPTANCE side was not, so a
    // destination that changed to something the router never asked for was undiagnosable: the
    // router logged `aim=(50,85)` every tick while the mover's heartbeat reported `dest=6,36`,
    // and nothing in between said who made it 6,36. One line per ACCEPTED change of owner or
    // square -- not per tick, which would be the new flood.
    // PHASE 2: the stand_on flag. When true, the destination is an exit square
    // (stand_on) — a square the character is meant to stand on to trigger a
    // transition. The geometry's "no floor" answer is wrong for that square;
    // the server handles the transition. The mover skips the floor check and
    // lets the raw-move fallback carry the character onto it.
    this._destIsStandOn = standOn;
    // Which room the destination is ultimately FOR, so a kod teleport corner can be told
    // apart from ordinary floor. Null means "nobody told me", which is NOT the same as
    // "there is no such room": with it null every corner is treated as unwanted, which is
    // the safe direction to be wrong (we avoid doors we might have wanted) but would seal
    // a room whose only exit is a corner. The router always passes it now.
    this._wantRoom = wantRoom ?? null;
    if (this._lastToLog !== `${by}|${col},${row}`) {
      this._lastToLog = `${by}|${col},${row}`;
      try {
        console.error(`[to-accepted] ${this.logName} by=${by} -> (${col},${row}) `
          + `wantRoom=${wantRoom ?? 'null'} standOn=${standOn === true}`);
      } catch { /* a diagnostic must never break a move */ }
    }
    // PHASE 2: the edge target. The square beyond the boundary (in the other
    // room). Used to compute the edge direction for the walk-past-boundary
    // check. The direction from the stand_on square to the edgeTarget is the
    // edge direction (away from the room interior).
    // Normalize the shape: the router passes the square as {col,row}, but the
    // crossing math needs protocol-unit {x,y}. A {col,row} shape used to flow
    // straight into pastX/pastY as undefined, sending NaN coordinates that
    // count toward the throttle and move nowhere (frozen with zero errors).
    if (edgeTarget && !Number.isFinite(edgeTarget.x) && Number.isFinite(edgeTarget.col)) {
      edgeTarget = { x: edgeTarget.col * KOD_FINENESS + HALF, y: edgeTarget.row * KOD_FINENESS + HALF };
    }
    this._edgeTarget = edgeTarget;
    // Claim (or keep) ownership of the destination and stamp the time, so a
    // lower-ranked caller can be deferred against a live owner.
    this._owner = by;
    this._ownerAt = Date.now();
    // Centre of the destination square in protocol units.
    this.destProto = {
      x: col * KOD_FINENESS + HALF,
      y: row * KOD_FINENESS + HALF,
    };
    if (isNewDest) {
      // NOTE: _lastReportAt is deliberately NOT reset here. Resetting it on
      // every re-route defeats the 1/s send law (speedhack detection counts
      // packets/sec averaged over time): a churning destination would send
      // every tick. A fresh route's first send waits at most 1s. Path, fan
      // and stuck state still reset below.
      // NOTE 2: the sim/pose is deliberately NOT reset here either. A new
      // aim does not move our feet — only the server (room change, blink,
      // teleport) does that. Resetting on re-aim drops planning back to a
      // stale echo while the server runs ahead, and the next aims pull
      // backwards (the ping-pong). Feet persist; plans change.
      this._lastReportX = null;
      this._lastReportY = null;
      this._recentSteps = null;  // loop-avoidance memory is per-destination
      this.path = null;      // re-plan on a new destination
      this.pathIdx = 0;
      this.stuckTicks = 0;
      this._fanIndex = null;
      this._fanTarget = null;
      this._fanFrom = null;
      this._blinkPending = false;
      this._blinkFrom = null;
      this._blinkAt = null;
      this._simX = null;   // (legacy mirror; the Pose owns the track now —
      this._simY = null;   // left null here so nothing reads stale feet.
      this._simAt = 0;     // See NOTE 2 above: never seed from a re-aim.)
      this._lastWpKey = null;
      // (No pose.reset() here — see NOTE 2 above.)
      // Corroboration base for arrival honesty (see tick-top note): the server
      // square as of this destination. Arrival commits only if the server is
      // at/near the destination or visibly moved since here.
      try {
        const sp = Pose.confirmed(this.session);
        this._arriveBase = sp.source !== 'none' ? { col: sp.col, row: sp.row } : null;
      } catch { this._arriveBase = null; }
    }
    // A no-op to() (same destination, called every tick by the router) changes NOTHING.
    // It does not re-plan, does not reset stuckTicks (so the stuck detector can still
    // accumulate), and does not reset the lazy-report gate. This is what makes the gate
    // work despite the router calling to() at 10Hz.
  }

  clear() {
    this.dest = null;
    this.destProto = null;
    this._recentSteps = null;
    this.path = null;  try { _trace(`[path-null] site 445`); } catch {}
    this.pathIdx = 0;
    this.sitting = false;
    this.lastPos = null;
    this.stuckTicks = 0;
    this.drX = null;
    this.drY = null;
    this._fanIndex = null;
    this._fanTarget = null;
    this._fanFrom = null;
    this._blinkPending = false;
    this._blinkFrom = null;
    this._blinkAt = null;
    this._simX = null;
    this._simY = null;
    this._simAt = 0;
    this._lastWpKey = null;
    try { this.session?._pose?.reset(); } catch {}
  }

  get active() { return this.dest != null; }

  /**
   * Plan a path from the current position to the destination using
   * finePathProtocol. Returns the path or a reason string.
   */
  _plan(fromProtoX, fromProtoY) {
    const geo = this.session?.world?.geometry;
    if (!geo?.finePathProtocol) return { found: false, reason: 'no_geometry' };

    // THE GEOMETRY MUST BELONG TO THE ROOM THE CHARACTER IS STANDING IN.
    //
    // Why this check exists, stated as a measurement rather than a theory. One character
    // sat in the Brownestone Inn (106) for over twenty minutes declaring 258 move packets
    // across five minutes, during which the server saw exactly TWO positions and it never
    // left one square. Every local predicate said the step was legal — fineWalkable,
    // walkable, standable, moverStepLands, stepAllowedByCollision, heightStepOk, floor
    // height 2048 on both squares. It was not blocked by anything in the room it was in.
    //
    // It was planning on the geometry of room 575, the room it was trying to REACH. The
    // destination square (12,17) 0-based is fine-walkable in 575 and NOT coarse-walkable in
    // 106, so the strict search exhausts a 127-square pocket and reports `no fine path`
    // with a suspiciously constant expanded=116. The coarse tier then returns 11
    // waypoints computed on 575's floor, whose first step has moverStepLands=false — an
    // illegal step in the room the character is actually in. The mover sends it, the server
    // refuses, movestuck wipes the path, and the next tick re-plans the identical
    // nonsense. 7,951 movestuck lines against 960 move-sent in thirteen minutes.
    //
    // The legacy already names this and I had not read it: m59-game.mjs:3417 returns
    // `position_outside_room_geometry` with the note that the character is "standing
    // outside the bounds of the room geometry loaded for it — the two are almost certainly
    // different rooms, which is a room-change race and not a hole in the map". The tick
    // driver has zero occurrences of that guard. It checks the AIM against the geometry's
    // bounds (line ~1734) and never checks the GEOMETRY against the room, which is the
    // check that matters, because a wrong-room geometry passes every bounds test — 575 is
    // 48x50 and 106 is 20x21, and (12,17) is in bounds of both.
    //
    // Refusing to plan is the correct action, not a workaround. A plan computed on another
    // room's floor is not a bad plan that sometimes works; it is not a plan about this room
    // at all. Returning a reason lets the caller wait one tick, by which time the room
    // change has normally settled. This is a race, and the cure for a race is to re-read,
    // not to steer around the symptom.
    {
      const room = this.session?.world?.room ?? null;
      const roomNum = room?.num ?? this.s?.client?.room?.num ?? null;
      // The identity that actually exists on both sides. A RoomGeometry carries the .roo
      // FILE it was built from (`file`), and the map's room record carries the file it
      // names (`rooFile`). Neither carries a room NUMBER, which is why a naive
      // `geo.roomNum !== room.num` check would have been inert — it compares two
      // undefineds, finds them equal, and never fires. I wrote exactly that inert guard
      // first and called it a fix; this is the version that can actually fire.
      //
      // barinn.roo is room 106 (Brownestone Inn), g5.roo is room 575. Different files, so
      // the comparison is real and not a tautology.
      const geoFile = geo?.file ?? null;
      const roomFile = room?.rooFile ?? room?.roo?.file ?? null;
      if (geoFile != null && roomFile != null && geoFile !== roomFile) {
        if (process.env.M59_MOVE_DEBUG !== '0') {
          console.error(`[geo-mismatch] ${this.logName} standing in room ${roomNum}`
            + ` (${roomFile}) while planning on ${geoFile}`
            + ' — room-change race, refusing to plan on another room floor');
        }
        return { found: false, reason: 'geometry_room_mismatch',
          note: `standing in room ${roomNum} (${roomFile}) while holding geometry for ${geoFile}`
              + ' — room-change race; re-plan next tick' };
      }
      // One-shot identity dump, so the question 'which geometry does the mover hold'
      // is answered by the log instead than by reading assignments that do not exist.
      if (!this._geoIdLogged && roomNum != null) {
        this._geoIdLogged = true;
        if (process.env.M59_MOVE_DEBUG !== '0') {
          console.error(`[geo-id] ${this.logName} room=${roomNum} roomFile=${roomFile ?? 'unknown'}`
            + ` geoFile=${geoFile ?? 'unknown'} — ${roomFile == null ? 'UNCHECKABLE: the room record names no .roo, so a wrong-room geometry would pass silently' : 'comparable'}`);
        }
      }
    }
    // If the character is in an invalid square, the fine
    // path will be garbage. Walk to the nearest valid
    // square first. A square is valid if EITHER grid says
    // true. If both grids return undefined (no data), we
    // can't tell — assume valid and let the fine path try.
    const sqCol = Math.floor(fromProtoX / KOD_FINENESS);
    const sqRow = Math.floor(fromProtoY / KOD_FINENESS);
    const fineVal = geo?.fineWalkable ? geo.fineWalkable(sqRow, sqCol) : undefined;
    const coarseVal = geo?.standable ? geo.standable(sqRow, sqCol) : undefined;
    const hasData = fineVal !== undefined || coarseVal !== undefined;
    const fineOk = fineVal === true;
    const coarseOk = coarseVal === true;
    if (hasData && !fineOk && !coarseOk) {
      // Find the nearest valid neighbor. A square is
      // valid if either grid says true. If both return
      // undefined, assume valid (no data).
      const dirs = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [dc, dr] of dirs) {
        const nc = sqCol + dc, nr = sqRow + dr;
        const f = geo?.fineWalkable ? geo.fineWalkable(nr, nc) : undefined;
        const s = geo?.standable ? geo.standable(nr, nc) : undefined;
        const fOk = f === true;
        const sOk = s === true;
        const noData = f === undefined && s === undefined;
        if (fOk || sOk || noData) {
          const wx = nc * KOD_FINENESS + HALF;
          const wy = nr * KOD_FINENESS + HALF;
          return { found: true, waypoints: [{ x: wx, y: wy }], escaped: true };
        }
      }
    }
    // TARGET ADJUST (stand_on doors): A* will not terminate ON a no-floor
    // square, but exit squares have no floor by design — while the router's
    // reachability BFS says the door is reachable and skips sub-legs. That
    // predicate mismatch strands the character (planner fails, stepper
    // dithers). Plan to the nearest walkable neighbor instead; the
    // boundary-crossing logic covers the final gap. [0,0] first so normal
    // destinations are untouched.
    let tx = this.destProto.x, ty = this.destProto.y;
    {
      const dc = Math.floor(tx / KOD_FINENESS), dr = Math.floor(ty / KOD_FINENESS);
      const df = geo?.fineWalkable ? geo.fineWalkable(dr, dc) : undefined;
      const ds = geo?.standable ? geo.standable(dr, dc) : undefined;
      if (df !== true && ds !== true) {
        const rings = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1],
                       [2,0],[-2,0],[0,2],[0,-2],[2,2],[2,-2],[-2,2],[-2,-2],
                       [3,0],[-3,0],[0,3],[0,-3]];
        for (const [ox, oy] of rings) {
          const nr2 = dr + oy, nc2 = dc + ox;
          const f2 = geo?.fineWalkable ? geo.fineWalkable(nr2, nc2) : undefined;
          const s2 = geo?.standable ? geo.standable(nr2, nc2) : undefined;
          if (f2 === true || s2 === true) {
            tx = nc2 * KOD_FINENESS + HALF;
            ty = nr2 * KOD_FINENESS + HALF;
            break;
          }
        }
      }
    }
    const result = geo.finePathProtocol(
      fromProtoX, fromProtoY,
      tx, ty,
      { step: 8, margin: 12 * KOD_FINENESS, maxNodes: 20000, blockedEdges: this._refusedEdgeKeys() },
    );
    // COARSE TIER FALLBACK -- THE OTHER HALF OF THE TWO-TIER DESIGN navgeom ALREADY HAS.
    //
    // navgeom's edgeWalkable (m59-navgeom.mjs:182) documents the split and names the failure it
    // exists to prevent:
    //
    //   TWO-TIER: when `coarse`, the edge predicate is the COARSE grid (walkable + heightStepOk) --
    //   fast and forgiving, for room-scale path planning. The fine grid (moverStepLands) is only
    //   consulted by the mover for the immediate next step (the 9 tiles around the character).
    //   This avoids the fine A* getting stuck on strictness across the whole map
    //   (the 13-node pocket case).
    //
    // The mover only ever asked for the STRICT tier. `finePathProtocol` without `coarse` requires
    // BOTH squares of EVERY edge to be coarse-walkable, so the search is confined to the
    // intersection of the two grids. Measured live in room 534 (Deep Woods of Ileria, 56x54) with
    // a character at (40,37) and a destination at (6,36):
    //
    //   reachable on the fine grid alone      : 2,808 squares
    //   reachable on the coarse grid alone    :   611
    //   reachable needing BOTH                :   430   <-- the search's entire world
    //   finePathProtocol strict  -> found:false  expanded:432  "no fine path"
    //   finePathProtocol coarse  -> found:true   expanded:278  44 waypoints, ending at (6,36)
    //
    // 432 is not a wall and not a node cap (maxNodes is 20,000). It is the pocket, exhausted. The
    // character is NOT blocked and never was: the strict search simply cannot see the route, so it
    // reports no path, the mover falls through to raw pushes, and the log fills with
    // "travel-mode pocket: all 8 raw moves refused" while the room sits open around him.
    //
    // THIS IS WHY HE WOULD NOT BACKTRACK. The route out of that pocket runs NORTH FIRST --
    // (39,37) (40,36) (40,35) (40,34) ... then west. A mover with no path cannot backtrack, because
    // backtracking is a property of a path, not of a push.
    //
    // SAFETY, measured rather than assumed: all 43 waypoints of the coarse path were re-checked
    // against the fine grid on the live server and ZERO of them are fine-blocked. The forgiving
    // tier did not produce a reckless route here. It is still a fallback and not the default: the
    // strict path is preferred whenever it exists, so this only changes behaviour in the case where
    // the alternative is standing still.
    if (!result?.found) {
      const coarseResult = geo.finePathProtocol(
        fromProtoX, fromProtoY, tx, ty,
        { step: 8, margin: 12 * KOD_FINENESS, maxNodes: 20000, coarse: true, blockedEdges: this._refusedEdgeKeys() },
      );
      if (coarseResult?.found) {
        const startCol = Math.floor(fromProtoX / KOD_FINENESS);
        const startRow = Math.floor(fromProtoY / KOD_FINENESS);
        const startFine = geo.fineWalkable ? geo.fineWalkable(startRow, startCol) : undefined;
        _trace(`[coarse-tier] ${this.logName} strict A* exhausted at `
          + `expanded=${result?.expanded ?? '?'} reason=${result?.reason ?? '?'} `
          + `start=(${startCol},${startRow}) startFine=${startFine} `
          + `-- coarse A* found ${coarseResult.waypoints?.length ?? 0} waypoints. `
          + `The pocket is real: the strict search cannot leave the intersection of the two grids.`);
        return { ...coarseResult, coarseTier: true };
      }
      // Both tiers failed. Report the STRICT reason, because that is what the caller's
      // blacklisting is keyed on, but say the pocket was tried -- otherwise a reader sees
      // "no fine path" and looks for a wall again.
      _trace(`[coarse-tier] ${this.logName} BOTH tiers failed to `
        + `(${Math.floor(tx / KOD_FINENESS)},${Math.floor(ty / KOD_FINENESS)}): `
        + `strict=${result?.reason ?? '?'} expanded=${result?.expanded ?? '?'} `
        + `coarse=${coarseResult?.reason ?? '?'} expanded=${coarseResult?.expanded ?? '?'}`);
    }
    return result;
  }

  /**
   * ONE TICK OF MOVEMENT. Sends at most MOVEUNITS of movement and returns.
   * Never blocks. Returns a state object the decider can read.
   *
   * States:
   *   'idle'          - no destination set
   *   'not-in-game'   - client not in game
   *   'no-position'   - no position available
   *   'standing'      - was sitting, stood up this tick
   *   'planning'      - planning a path this tick (no move sent)
   *   'moving'        - sent a step along the path
   *   'arrived'       - reached the destination
   *   'no-route'      - finePathProtocol found no path
   *   'search-exhausted' - finePathProtocol ran out of budget
   *   'raw-move'      - fine model blocked, trying raw move fallback
   *   'blink'         - all raw moves refused, casting blink
   *   'blinked'       - blink changed position
   *   'stuck'         - truly stuck, no escape found
   *
   * @param {object} [posOverride] - { col, row, x, y } to use instead of client.self.
   */
  // THE ONE LOG THAT CANNOT DRIFT FROM THE CODE.
  //
  // The fleet's rate has been unanswerable all evening, and the reason is not the locomotion
  // model: in the window where the echo says the character moved one square per thirty seconds,
  // the mover sent SEVEN packets and then said nothing for three minutes while the tick ran 181
  // times. `tick()` is 1,430 lines with 32 exits, 29 of which log nothing at all. Every question
  // about why the character is standing still therefore has no answer in the log, and I spent
  // the evening answering it by inference from positions — which produced four confident,
  // mutually contradictory conclusions, each of which turned out to be an artefact of the
  // instrument (sampling srv= at send time; dividing by the frame period; reading client units as
  // square indices; differencing a quantised echo).
  //
  // So this wrapper logs the state every tick actually returned, with the send count and the age
  // of the send gate, on ONE line, at the single place all 32 exits pass through. Placing it by
  // hand at each return would drift the first time someone added an exit; wrapping cannot,
  // because a return that skips the wrapper does not exist. It is rate-limited to changes of
  // state plus one line per 15 s so a 10 Hz tick does not drown the log the way the per-tick
  // diagnostics already do.
  // The name every diagnostic should carry. `session.name` is what decide.mjs uses
  // (m59-decide.mjs:1786), and the session is already on `this`.
  //
  // This exists because the diagnostics in this class had a character's name BAKED INTO THE
  // STRING — `[movedbg] t3 vel-tick`, `[movedbg] t4 to() -> ...` — in a class that all five
  // characters instantiate, so on a live fleet every line said 't3' or 't4' regardless of who
  // wrote it.
  //
  // BOTH SPELLINGS MATTER, and I learned that the hard way. The first sweep for this bug searched
  // for the literal 't3' and reported zero remaining sites, which I read as 'fixed'. It was not:
  // the destination setter was written `t4`, and it is the single most important movement line in
  // the log — `[movedbg] t4 to() -> 30,41 (was 30,42) by=combat`. So for a whole extra restart I
  // read destination churn out of a line whose name was a lie and concluded 'all the re-aims are
  // by=combat' from a log that could have belonged to any of the five. A cleanup that greps for one
  // spelling of a bug and declares victory because the other spelling is absent has not fixed the
  // bug, it has hidden it. The assertion in m59-mover-test.mjs scans the source for the SHAPE of
  // the bug — any `t<digit>` following a log tag — rather than for the name it happens to
  // remember.
  get logName() {
    try { return this.session?.name ?? '?'; } catch { return '?'; }
  }

  tickLogged(posOverride) {
    let r;
    try {
      r = this.tick(posOverride);
    } catch (e) {
      try { console.error(`[tick-state] ${this.logName} THREW ${e.message}`); } catch {}
      throw e;
    }
    try {
      const st = r && r.state ? r.state : 'undefined';
      const now = Date.now();
      if (st !== this._lastTickState || now - (this._lastTickStateAt ?? 0) > 15000) {
        this._lastTickState = st; this._lastTickStateAt = now;
        console.error(`[tick-state] ${this.logName} state=${st}` +
          `${r && r.why ? ' why=' + r.why : ''}${r && r.hold ? ' hold=1' : ''}` +
          ` sends=${this._sendCount ?? 0} gateAge=${now - (this._lastReportAt ?? 0)}` +
          ` path=${this.path ? this.pathIdx + '/' + this.path.length : 'null'}` +
          ` stuck=${this.stuckTicks}` +
          ` lastMovedAge=${this.session?._pose?.lastMovedAt ? now - this.session._pose.lastMovedAt : 'none'}`);
      }
    } catch {}
    return r;
  }

  tick(posOverride) {
    // When this tick began, for the corner-rounded release below. Captured first because every
    // later `Date.now()` in a 2,000-line function can drift past a millisecond boundary and make
    // a fan created on this very tick look like it predates it.
    this._tickStartedAt = Date.now();
    if (!this.active) return { state: 'idle' };
    // CASTING HOLD: movement breaks concentration (server-side cast time),
    // so a cast never completes while strides go out every second — mana
    // stays full and the intent re-fires forever. Any cast stamps
    // session._castingUntil; the mover holds (no sends) until it lapses.
    // Same family as the blink-pending hold below.
    if (Date.now() < (this.session?._castingUntil ?? 0)) return { state: 'casting', hold: true };
    // REST HOLD: a sent rest holds the mover (stillness for trance). Set by
    // the decider when healthy/vigor_low rests; cleared every tick otherwise.
    if (this.session?._restHold === true) return { state: 'resting', hold: true };
    // HEARTBEAT (permanent, 60s): the mover is otherwise silent when gated
    // or holding, which made multi-minute stalls undiagnosable. One line.
    if (Date.now() - (this._hbAt ?? 0) > 60000) {
      this._hbAt = Date.now();
      // VOID PROBE, on the heartbeat so it costs nothing and cannot be missed.
      //
      // A character was OBSERVED standing in what the 3D client renders as a void, and six
      // offline tests across two rooms could not produce an entry: every declared move from a
      // floored square into one of those squares is refused by the trace, in both the coarse
      // and the fine model, at the mover's own options (slide:false, radius 248, and the
      // blocked!==true||arrived===true pass rule). Room 557: 0 of 267. Room 556: 0 of 168.
      //
      // A test that never fires is not evidence the event cannot happen; it is evidence the
      // test does not cover the path. So rather than reason about which of the remaining
      // explanations is right -- the server placing a body there on room entry or respawn, a
      //kod-driven move, or room3d drawing something the BSP does not contain -- this asks
      // the question every minute on the character's ACTUAL square and names it in the log.
      // When it fires, the square is known, and the answer is a probe away instead of a
      // reconstruction from a log that spans builds and five characters.
      try {
        const _vg = this.session?.world?.geometry;
        const _me = this.session?.client?.self;
        if (_vg?.fineWalkable && _me && Number.isFinite(_me.col) && Number.isFinite(_me.row)) {
          const _c1 = _me.col + 1, _r1 = _me.row + 1;   // self is 0-based; the API is 1-based
          const _coarse = _vg.walkable?.(_r1, _c1) === true;
          const _fineBlocked = _vg.fineWalkable?.(_r1, _c1) === false;
          let _floor = false;
          // Always test the lattice directly rather than reading standable(): standable()
          // short-circuits on the coarse grid (m59-roo.mjs:1697), so it returns true for exactly
          // the squares we are investigating and cannot answer the question.
          if (_vg._occupiable) {
            for (let _sy = 0; _sy < 5 && !_floor; _sy++) for (let _sx = 0; _sx < 5; _sx++) {
              const _x = protocolToClient((_c1 - 1) * KOD_FINENESS + Math.round((_sx + 0.5) * KOD_FINENESS / 5));
              const _y = protocolToClient((_r1 - 1) * KOD_FINENESS + Math.round((_sy + 0.5) * KOD_FINENESS / 5));
              if (_vg._occupiable(_x, _y)) { _floor = true; break; }
            }
          }
          // The condition we are looking for: the server's grid says there is floor here, the
          // BSP says there is none anywhere on the square. That is the disagreement room3d
          // draws as a hole. Reported whether or not it fires, so a run of 'no' is visible too.
          // TWO DIFFERENT THINGS, AND THE FIRST VERSION ONLY TESTED THE WRONG ONE.
          //
          // A VOID is coarse=walkable with no BSP floor. An IN-A-WALL is coarse=walkable and
          // BSP floor PRESENT but fineWalkable FALSE -- the fine wall grid says blocked while
          // the server and the BSP both say there is ground. The first probe tested only the
          // first, and stayed silent while the character stood visibly inside a wall, which is
          // the second. Room 557 has 221 of the second and 169 of the first; the character was
          // in one of the second.
          if (_coarse && !_floor) {
            console.error(`[void-probe] STANDS IN A VOID square=(${_me.col},${_me.row}) `
              + `coarse=walkable bsp_floor=none fine=${_vg.fineWalkable(_r1, _c1)} `
              + `room=${this.session?.world?.room?.num ?? '?'} -- the server put a body where the BSP has no floor`);
          } else if (_coarse && _fineBlocked) {
            console.error(`[void-probe] STANDS INSIDE A WALL square=(${_me.col},${_me.row}) `
              + `coarse=walkable bsp_floor=present fine=BLOCKED `
              + `room=${this.session?.world?.room?.num ?? '?'} -- the fine wall grid calls this square `
              + `a wall while the server stands a body on it; a client drawing the fine grid draws `
              + `a wall around the character`);
          }
        }
      } catch { /* a diagnostic must never break the tick */ }
      try { const _cr = this.cadence_report(); console.error(`[mover-hb] dest=${this.dest ? this.dest.col + ',' + this.dest.row : 'null'} path=${this.path ? this.pathIdx + '/' + this.path.length : 'null'} fan=${this._fanIndex} stuck=${this.stuckTicks} sends=${this._sendCount ?? 0} drops=${this.session?.client?._droppedUserMoves ?? 0} gateAge=${this._lastReportAt ? Date.now() - this._lastReportAt : '-'}${(() => { const c = this.session?._pose?.corroboration?.(); return c ? ` unconfirmed=${c.outstanding}` : ''; })()}${(() => { const g = this.session?._pose?.groundRate?.(); return g && g.seconds ? ` ground=${g.squares.toFixed(1)}sq/${g.seconds.toFixed(0)}s=${g.rate.toFixed(2)}sq/s trans=${g.transitions}` : ''; })()} cadence={submits=${_cr.accepted_submits} minGap=${_cr.min_gap_ms ?? 'n/a'} under1s=${_cr.under_1000ms} under05s=${_cr.under_500ms}} cli=${this.session?.client ? this.session.client.state : 'noclient'} pacer=${this.session?.pacer ? 'Y' : 'N'}`); } catch {}
    }
    const s = this.session;
    const c = s?.client;
    if (!c || c.state !== 'game') return { state: 'not-in-game' };

    // ROOM-CHANGE HOLD: when the room identity changes, drop dead reckoning
    // from the old room and wait for the server's first position in the new
    // one — like the real client, which never acts on a stale room. Sending
    // old-room positions (or planning from them) strands characters in the
    // new room's walls/voids. Bounded (5s) so a missing echo can never stall.
    // Without a Pose there is no echo tracking, so don't hold (tests).
    // Room identity is the map NUMBER + name, never the object id: at a
    // boundary the server interleaves messages from both rooms and the
    // object id flaps (watched: 2013<->2125), which reset the sim every few
    // ticks, dropped aims back to stale echoes, and ping-ponged the
    // character. A genuine transition changes the number (or name).
    // Keyed on the map number ALONE: names/rscs also flutter at boundaries
    // (each room's messages carry its own), but a genuine transition always
    // changes the number, and nothing else does.
    const wNum = this.session?.world?.room?.num ?? c.room?.num ?? '?';
    const roomKey = String(wNum);
    if (this._roomKey == null) {
      this._roomKey = roomKey;
    } else if (this._roomKey !== roomKey) {
      this._roomKey = roomKey;
      this._simX = null; this._simY = null; this._simAt = 0;
      try { this.session?._pose?.reset(); } catch {}
      this.path = null; this.pathIdx = 0;  try { _trace(`[path-null] site 609`); } catch {}
      this._fanIndex = null; this._fanTarget = null; this._fanFrom = null;
      this._roomChangedAt = Date.now();
    }
    if (this._roomChangedAt) {
      if (Date.now() - this._roomChangedAt > 5000) {
        this._roomChangedAt = 0; // give up waiting; proceed on best available
      } else if (this.session?._pose) {
        const srvUpd = this.session._pose.updatedAt ?? 0;
        if (srvUpd <= this._roomChangedAt) {
          return { state: 'waiting-room', why: 'room changed; awaiting server position' };
        }
        this._roomChangedAt = 0;
      } else {
        this._roomChangedAt = 0;
      }
    }

    // SINGLE POSITION TRUTH: read from the Pose (sim while fresh, else the
    // server echo). Fall back to the raw getter only when the Pose is stale.
    const _pose = s?._pose?.current?.();
    const me = posOverride ?? (_pose && !_pose.stale ? _pose : c.self);
    if (!me || !Number.isFinite(me.col) || !Number.isFinite(me.row)) return { state: 'no-position' };
    // COMMITMENT TRUTH: arrival/at/clear and the send gate must use the raw
    // server echo — never the sim. Pose.current() is sim-while-fresh, and the
    // sim advances on every SEND: judging arrival on it fires after 1-2 sends
    // even when the server refused them all, and clear() then wipes
    // fan/path/stuck (snapping the sim back to the stale square) — a
    // perpetual pseudo-progress loop with zero server movement. Server echoes
    // lag ~1s; arrival waits for proof. Planning may stay optimistic; only
    // commitment (arrival, gate reference, candidate origin) uses the echo.
    const srvPos = Pose.confirmed(s);
    const srvCol = srvPos.source !== 'none' ? srvPos.col : me.col;
    const srvRow = srvPos.source !== 'none' ? srvPos.row : me.row;
    const srvX = srvPos.source !== 'none' ? srvPos.x : (srvCol * KOD_FINENESS + HALF);
    const srvY = srvPos.source !== 'none' ? srvPos.y : (srvRow * KOD_FINENESS + HALF);

    // THE SITTING TRAP: PFLAG_NO_MOVE refuses every move silently.
    // Stand first.
    if (this.sitting) {
      this.sitting = false;
      const rec = s.pacer.submit('stand', () => c.stand(), 0);
      Promise.resolve(rec).catch(() => {});
      // Standing is its own tick. The velocity engine used to fall through and
      // declare a stride on the same tick as the stand(); with one engine there
      // is nothing left to fall through to.
      return { state: 'standing' };
    }

    // PHASE 0c fix: BLINK PROGRESS + HOLD. When a blink is pending (cast in
    // progress), check if the position changed (blink worked) or timed out
    // (blink failed). If the position changed, clear the pending flag and
    // re-plan. If not, hold the character still (movement breaks
    // concentration and the cast fails). The hold ends when the blink
    // resolves (position change) or the pending flag is cleared.
    if (this._blinkPending) {
      const curX = protocolToClient(me.x ?? (me.col * KOD_FINENESS + HALF));
      const curY = protocolToClient(me.y ?? (me.row * KOD_FINENESS + HALF));

      // THE SERVER'S WORD IS THE PRIMARY RELEASE, NOT THE DISTANCE.
      //
      // The test below asks whether the character moved more than 8 CLIENT units — one
      // eighth of a square. That is a very small number to hang a spell's outcome on, and
      // blink picks its destination: a blink that lands inside the same square as the
      // square it left is a legal outcome in a 21x20 room, and under the distance test it
      // is indistinguishable from a cast that never happened. The character then stands
      // still for the whole 20 s backstop, and the mover concludes the spell did nothing.
      //
      // The server says, in as many words, whether the cast worked:
      //   "You find yourself realigned with your surroundings."   it worked
      //   "Your concentration is broken and the blink spell fizzles."  it did not
      // Those lines arrive on the event stream, and are now observed by CastWatch
      // (tools/tick/m59-cast.mjs). A landed/fizzle verdict is TERMINAL and definitive, so
      // it ends the hold immediately in both directions — which also means a fizzled cast
      // no longer costs 20 s of standing still before the next thing can be tried.
      //
      // The distance check stays as the fallback for the case the text cannot cover: a
      // server that moved us without saying so, or a build whose spell text changed.
      const _cw = this.session?._castWatch;
      if (_cw && _cw.state !== 'casting') {
        if (_cw.phase === 'landed') {
          this._blinkPending = false;
          this._blinkFrom = null;
          this._lastWpKey = null;
          this._simX = null; this._simY = null; this._simAt = 0;
          try { this.session?._pose?.reset(); } catch {}
          this.stuckTicks = 0;
          this._blinkLandedAt = Date.now();   // blink-landing cooldown: don't re-cast immediately
          this.path = null;   // replan from wherever the blink actually put us
          // DELIBERATELY DOES NOT REPORT curX/curY. The server sends the completion text
          // and the position packet as two separate packets, and nothing in this
          // repository establishes which arrives first — there is no capture of a blink
          // in the raw stream, and the spell text is server data with no ordering
          // guarantee in the source. Reading the position on THIS tick could therefore
          // replan from the position we left while the character is already somewhere
          // else, which is a worse failure than the one being fixed: a stale position
          // with a confident 'blinked' verdict. Releasing the hold is safe and immediate;
          // the position is read next tick, by which point both packets have landed.
          // The cost is one 0.30 s tick.
          return { state: 'blinked', why: `blink confirmed by server text (${_cw.elapsed()}ms)` };
        }
        if (_cw.phase === 'fizzle' || _cw.phase === 'lost' || _cw.phase === 'refused') {
          this._blinkPending = false;
          this._blinkFrom = null;
          this.stuckTicks++;
          // Do NOT fall through into the escape fan on the same tick: the fizzle is
          // evidence that something moved during the cast, and if that something was us,
          // the next move packet will fizzle the retry for the same reason. The fan's own
          // gate paces the next attempt.
          if (_cw.phase === 'refused') {
            // A mana refusal is not bad luck, it is arithmetic: the server will say the
            // same thing next time. Record when we last heard it so the caller can stop
            // spending 20s holds on an unaffordable spell, and say so in the why rather
            // than letting it look like a spell that nearly worked.
            this._blinkRefusedAt = Date.now();
            return { state: 'blink-refused', why: 'blink refused: not enough mana (server said so)' };
          }
          return { state: 'blink-fizzled', why: `blink cancelled (${_cw.phase}) — movement during concentration` };
        }
      }

      if (this._blinkFrom != null) {
        if (Math.hypot(curX - this._blinkFrom.x, curY - this._blinkFrom.y) > 8) {
          this.drX = curX;
          this.drY = curY;
          this._blinkPending = false;
          this._blinkLandedAt = Date.now();
          this._blinkFrom = null;
          this._lastWpKey = null;
          this._simX = null;
          this._simY = null;
          this._simAt = 0;
          try { this.session?._pose?.reset(); } catch {}
          this.stuckTicks = 0;
          this.path = null; // replan from new position  try { _trace(`[path-null] site 679`); } catch {}
          return { state: 'blinked', why: 'position changed after blink' };
        }
      }
      // Blink is still in progress — hold the character still, but only
      // for the cast window. A failed cast (fizzle, refusal, interrupt)
      // never moves the character, and without a timeout this holds
      // forever on a dead cast (prod move 0 with a live path).
      if (Date.now() - (this._blinkAt ?? 0) > 20000) {
        this._blinkPending = false;
        this._blinkLandedAt = Date.now();
        this._blinkFrom = null;
        this.stuckTicks++;
        // Fall through: movement resumes immediately below.
      } else {
        return { state: 'blinking', hold: true };
      }
    }

    // Use the CURRENT position for waypoint distance and the lazy-report gate.
    // client.self is updated by every position packet (the source the probe/room-view
    // use) and is more current than world.position (updated by confirmPosition at 2s
    // cadence). Using the stale world.position makes the Mover path from an old position
    // and never report 'arrived' at a sub-waypoint it has physically reached. Fall back
    // to the frame's me when client.self is unavailable.
    // FINITE-CHAINED (not ??): a NaN coordinate passes ?? through (it only skips
    // null/undefined) and then poisons every distance, trace and gate below into
    // silent NaN-false — the observed prod-0 freeze with a live path.
    // SINGLE POSITION TRUTH: `me` comes from the Pose (validated finite at the
    // entry). curCol/curRow are the SERVER square (for the 'arrived' and gate
    // checks); myProtoX0/Y0 are the server point. The sim (below) supersedes
    // them while fresh.
    const curCol = srvCol;
    const curRow = srvRow;
    const myProtoX0 = srvX;
    const myProtoY0 = srvY;
    // LOCAL SIMULATION: the Pose owns the track now (persistent, unit-correct).
    // The mover's own fields are a fallback for sessions without a Pose
    // (tests). Server echoes arrive ~1/s and confirm the track; they never
    // rewrite it (see Pose doc) — confirmation gates commitment below.
    const poseSim = s?._pose?.sim;
    const usePoseSim = poseSim != null && Number.isFinite(poseSim.x) && Number.isFinite(poseSim.y);
    const simFresh = this._simX != null && this._simY != null && (Date.now() - (this._simAt ?? 0)) < 2000;
    let myProtoX = usePoseSim ? poseSim.x : (simFresh ? this._simX : myProtoX0);
    let myProtoY = usePoseSim ? poseSim.y : (simFresh ? this._simY : myProtoY0);
    // DIVERGENCE RE-ANCHOR: the Pose's divergence guard adopted the server
    // echo (the sim drifted 6+ squares off it — a stale plan moving the wrong
    // way). The path was planned from the drifted sim; re-plan from the
    // re-anchored position so the waypoints point the right way again.
    const divResets = s?._pose?.divergenceResets ?? 0;
    if (divResets !== (this._lastDivResets ?? 0)) {
      this._lastDivResets = divResets;
      this.path = null;  try { _trace(`[path-null] site 730`); } catch {}
      this.pathIdx = 0;
      this._fanIndex = null;
      this._fanTarget = null;
      this._fanFrom = null;
    }
    // COMMITMENT POINT (arrival honesty): our tracked position (the sim),
    // but ONLY with server corroboration — the server is already at/near the
    // destination, or it visibly moved since this destination was set. A sim
    // that "covers" a square while the server never budges is refused sends,
    // and committing on it clear()s fan/path/stuck into a pseudo-progress
    // loop. Without echo tracking (tests) the server squares decide (legacy).
    const srvNearDest = this.destProto != null
      && Math.hypot(this.destProto.x - srvX, this.destProto.y - srvY) < KOD_FINENESS;
    const srvMoved = this._arriveBase != null
      && (srvCol !== this._arriveBase.col || srvRow !== this._arriveBase.row);
    // The SERVER echo is the arrival truth. When the server is at the
    // destination, commit on the SERVER (the sim can drift off the dest via
    // single-square stepping and would never re-arrive). Only when the server
    // has visibly moved (progress) but is not yet at the destination do we
    // commit on the sim (ahead of the server). Never on the sim alone — a sim
    // that "covers" a square while the server never budges is refused sends.
    const cmtX = srvNearDest ? srvX : (srvMoved ? myProtoX : srvX);
    const cmtY = srvNearDest ? srvY : (srvMoved ? myProtoY : srvY);
    // Keep DR in sync with current position for the fine model's collision checks.
    this.drX = protocolToClient(myProtoX);
    this.drY = protocolToClient(myProtoY);
    // The 'arrived' and gate checks below use curCol/curRow (the SERVER position).
    // effMe follows our feet (sim-aware) so arrival and reporting track what
    // we did, while crossing/validation stays on server truth.
    const effMe = { col: Math.floor(myProtoX / KOD_FINENESS), row: Math.floor(myProtoY / KOD_FINENESS), x: myProtoX, y: myProtoY };

    // NO-FLOOR START: if the character's square has no floor (a wall square,
    // reached by teleport or fine movement along a ledge), the path planner
    // can't find a path. Fire the escape fan immediately (not after 3 ticks)
    // to walk to a nearby walkable square. Placed AFTER the position block:
    // it needs myProtoX/myProtoY. Uses the same protocol-square convention
    // as _plan(); do not reindex here.
    const startGeo = this.session?.world?.geometry;
    // Start square on SERVER truth (not the sim): a drifted sim inside a wall
    // would fire a false escape while the character stands on real ground.
    const startCol = srvCol;
    const startRow = srvRow;
    const startFine = startGeo?.fineWalkable?.(startRow, startCol);
    // A dumb server can accept a declared position outside the BSP, so a void
    // must be detected locally. fineWalkable only tests the cell centre against
    // wall segments and can be true in open void; standable tests the BSP for
    // occupiable floor anywhere in the square. A standable-false square WITH a
    // stand point is a thicket (transited daily, no fan); without one it is a
    // hole or wall-pocket (escape fan, blink-first when leafless-open).
    const startVoidByFloor = startGeo?.collisionReady === true
      && startGeo?.standable?.(startRow, startCol) === false
      && (typeof startGeo?.standPoint !== 'function'
          || startGeo.standPoint(startRow, startCol) == null);
    const startHasNoFloor = startFine === false || startVoidByFloor;
    // EXACT-POINT floor: the square can hold floor elsewhere (standable true)
    // while the body's own point sits in a BSP coverage gap (no leaf at all).
    // Watched live: 30 minutes pinned on a leafless corner point of an
    // otherwise-floored square, with every square-level check passing. A body
    // with no leaf has no floor — escape it the same way.
    let startPointNoFloor = false;
    if (startGeo?.collisionReady === true && typeof startGeo?.leafAtClient === 'function') {
      try {
        const cx = protocolToClient(srvX), cy = protocolToClient(srvY);
        const leaf = startGeo.leafAtClient(cx, cy);
        const base = leaf ? startGeo.floorBaseAtClient(cx, cy, leaf) : null;
        startPointNoFloor = !leaf?.sector || base == null;
      } catch { startPointNoFloor = false; }
    }
    const startHasNoFloor2 = startHasNoFloor || startPointNoFloor;
    // Don't steal a deliberate exit square: if this no-floor square is the
    // stand_on destination itself, let the boundary-crossing logic below
    // handle the transition instead of starting an escape fan.
    const atStandOnExit = this._destIsStandOn === true && this.dest != null
      && this.dest.col === startCol && this.dest.row === startRow;
    if (startHasNoFloor2 && !atStandOnExit && this._fanIndex == null && this._fanTarget == null) {
      this.stuckTicks = 3; // bypass the 3-tick wait (and satisfy _tryBlink's stalled check)
      // Open void (no BSP floor at all, not just a wall center): sliding is
      // pointless — the dumb server accepts every probe, so headings always
      // "succeed" and the fan never reaches its blink fallback. Blink out
      // first; fall back to the escape fan when blink is unavailable.
      // One attempt per 30s so a failed cast can't spam stands/casts.
      if (startVoidByFloor && !this._blinkPending && Date.now() - (this._voidBlinkAt ?? 0) > 30000) {
        this._voidBlinkAt = Date.now();
        if (this._tryBlink()) {
          this._blinkFrom = { x: protocolToClient(myProtoX), y: protocolToClient(myProtoY) };
          this._blinkPending = true;
          this._blinkAt = Date.now();
          return { state: 'blink', why: 'in open void: blinking out' };
        }
      }
      this._fanIndex = 0;
      this._fanFrom = { x: protocolToClient(myProtoX), y: protocolToClient(myProtoY) };
      this._fanFiredAt = Date.now();   // see the corner-rounded release below
      // NO EARLY RETURN (see the 0c note below): fall through to the fan
      // branch so the gate can send this same tick.
    }
    // Whether the start square itself is floorless (and not a deliberate exit).
    // When true, the character is already in a void: traversal is allowed so the
    // escape fan can walk out. When false, no step may ENTER a floorless square.
    const startIsVoid = startHasNoFloor2 && !atStandOnExit;

    // (Blink progress check moved to the top of tick() — see the BLINK
    // PROGRESS + HOLD block above.)

    // FAN PROGRESS: if we fired a raw move last tick, check position.
    // ECHO PATIENCE: server echoes arrive ~1200ms after a send (BP_MOVE
    // cadence) but exhaustion hits at 9 ticks (900ms). Assessing before the
    // echo can possibly arrive declares failure just ahead of confirmation
    // every cycle (chronic stuck/blink loop). Wait out one echo window per
    // probe before advancing the fan or judging movement.
    if (this._fanTarget != null && this._fanSentAt != null && Date.now() - this._fanSentAt < 1500) {
      return { state: 'raw-move', fanIndex: this._fanIndex ?? 0, waiting: true };
    }
    if (this._fanTarget != null) {
      // SERVER TRUTH: the sim drifts during a fan (each speculative probe
      // advances it), so `me` (the sim) would report >8 units of movement
      // even when the server refused every probe (a walled-in pocket). Use
      // the raw SERVER echo (the last BP_MOVE, not the dead-reckoned sim) —
      // the only thing that proves the character actually moved. _fanFrom is
      // the position at init, in the same unit system.
      const _fanSrv = Pose.confirmed(this.session);
      const srvX = _fanSrv.x, srvY = _fanSrv.y;
      const curX = protocolToClient(srvX ?? (me.col * KOD_FINENESS + HALF));
      const curY = protocolToClient(srvY ?? (me.row * KOD_FINENESS + HALF));
      if (process.env.M59_MOVER_TRACE === '1') {
        const _delta = Math.hypot(curX - (this._fanFrom?.x ?? curX), curY - (this._fanFrom?.y ?? curY));
        console.error(`[fan-check] ${this.logName} idx=${this._fanIndex} srvAtCheck=(${srvX ?? '?'},${srvY ?? '?'}) fanFrom=(${this._fanFrom?.x ?? '?'},${this._fanFrom?.y ?? '?'}) delta=${_delta.toFixed(1)} >8=${_delta > 8}`);
      }
      if (Math.hypot(curX - (this._fanFrom?.x ?? curX), curY - (this._fanFrom?.y ?? curY)) > 8) {
        // Raw move worked! PERSISTENT SLIDE: keep the successful heading
        // instead of clearing the fan. Clearing re-inits at heading 0 every
        // step, so the fan rotates through headings that cancel out (net
        // ~zero squares per window) and the router's oscillation breaker
        // kills the route. The heading that moved once moves again — that
        // is wall contour-following. Only a stalled heading advances.
        this.drX = curX;
        this.drY = curY;
        this._fanTarget = null;
        this._fanFrom = null;
        this.stuckTicks = 0;
        // NOTE: no path replan here (waypoints are absolute; still valid).
      } else {
        this._fanIndex = (this._fanIndex ?? 0) + 1;
        if (this._fanIndex >= 9) {
          return this._fanExhausted(curX, curY);
        }
        // Fall through: fire next fan heading below.
      }
    }

    // ARRIVED: check if we're at the destination.
    // SKIP for stand_on destinations: the character needs to walk PAST the
    // stand_on (into the wall) to trigger the transition. The boundary-
    // crossing check (below) handles that.
    // FAN GUARD: while sliding (the fan is active), the sim drifts — each
    // speculative probe advances it, and the server may refuse every one
    // (a walled-in pocket). The sim can land near the destination while the
    // SERVER never moved the character, firing a false 'arrived' that clears
    // the fan and strands the character. Arrival is therefore ALWAYS judged on
    // the server echo (srvCol/srvRow above), sim or fan or not: the sim
    // advances on every send, so sim-judged arrival fires after 1-2 sends even
    // when every one was refused, and the clear() below wipes fan/path/stuck.
    const destDist = Math.hypot(this.destProto.x - cmtX, this.destProto.y - cmtY);
    if (destDist < KOD_FINENESS * 0.5 && !this._destIsStandOn) { // within ~0.5 protocol units
      this.clear();
      return { state: 'arrived', position: { col: effMe.col, row: effMe.row } };
    }

    // THE AIM: the current waypoint if a path exists, else the destination. The
    // escape fan probes around it and the boundary check tests it, so both need
    // it even though nothing declares it directly any more (see the engine note
    // in docs/TICK-MOVEMENT-PLAN.md).
    const holdWp = this.path ? this.path[this.pathIdx] : null;
    let aimX = holdWp ? holdWp.x : this.destProto.x;
    let aimY = holdWp ? holdWp.y : this.destProto.y;
    // LOOK DOWN THE ROUTE, HERE, ABOVE THE STRIDE CLAMP. Where this call sits is the whole
    // finding, so it is written out rather than implied:
    //
    // An earlier attempt put the lookahead down near the declaration and had the step branch
    // above hand it over through a field. That read the PREVIOUS tick's heading — the aim is
    // built 700 lines before the step branch runs — and produced an oscillation
    // (832,800,960,992,1056,992): a mover walking backward and forward on a straight road. A
    // heading decided after the thing that consumes it is not a heading, it is a memory.
    //
    // The reason a lookahead is needed at all: the planner emits one waypoint per square
    // because that is what a square-centre path IS, and a walk stride is 2.5 squares. Without
    // consuming several waypoints per tick the stride budget is spent on a one-square heading,
    // which is precisely the 1.00 squares-per-packet the fleet has been running at.
    //
    // It chooses a HEADING. The clamp below still bounds it by what the elapsed time buys and
    // the integration still decides what is legal, so a lookahead can name a destination but
    // never authorise a position.
    {
      const _g = this.session?.world?.geometry;
      if (this.path && this.pathIdx < this.path.length) {
        const _v = s.client?.vitals?.()?.vigor?.value ?? 0;
        const _r = s?.policy?.allowRun !== false && _v >= RUN_VIGOR_FLOOR;
        const _ahead = this._routeAhead(_g, myProtoX, myProtoY, _r ? RUN_STRIDE_PROTO : WALK_STRIDE_PROTO);
        if (_ahead) { aimX = _ahead.x; aimY = _ahead.y; }
      }
    }
    // OFFICIAL STRIDE, NO HOLD GATE. The server never carries (each packet IS
    // one accepted position), so holding after one step freezes — the observed
    // one-step-then-stop. Instead clamp the aim to one per-second stride:
    // a distant waypoint can't trip teleport detection, and the per-second
    // displacement IS the speed (walk 2.5 sq/s, run 5 sq/s).
    const vigorNow = s.client?.vitals?.()?.vigor?.value ?? 0;
    const runNow = s?.policy?.allowRun !== false && vigorNow >= RUN_VIGOR_FLOOR;
    const strideNow = runNow ? RUN_STRIDE_PROTO : WALK_STRIDE_PROTO;
    // Boundary checks (0c slide, raycast-ahead) skip only on the FINAL
    // APPROACH to an exit square. En route, a blocked direct path means a
    // real wall even when the destination is a stand_on.
    // STRIDE ORIGIN IS THE SIM (the live position), NOT the server echo.
    // The server is client-authoritative: it accepts our declared position, so
    // the sim IS where the character is. The echo lags ~1s; clamping one
    // stride ahead of a stale echo aimed BEHIND the character and pulled it
    // backward every tick — the "not following the path" wedge.
    {
      const adx = aimX - myProtoX, ady = aimY - myProtoY;
      const ad = Math.hypot(adx, ady);
      if (ad > strideNow) {
        aimX = myProtoX + (adx / ad) * strideNow;
        aimY = myProtoY + (ady / ad) * strideNow;
      }
    }

    // WALL-AIM DIAGNOSTIC (visibility only, no behavior change): if the
    // destination square itself is fine-blocked and not a stand_on exit,
    // name it and continue. Chasing a wall aim jitters (watched: router
    // sub-aim (27,33) in 557, fine=False) — but the raw-door-push exists
    // precisely for fine-blocked gaps (the server is client-authoritative
    // and accepts a step the model refuses), and height/void discipline
    // already gates the bad cases. Refusing here broke three tests and the
    // push philosophy, so: visibility, not refusal.
    if (this._destIsStandOn !== true && this.destProto != null) {
      const _dgeo = this.session?.world?.geometry;
      const _dsqC = Math.floor(this.destProto.x / KOD_FINENESS);
      const _dsqR = Math.floor(this.destProto.y / KOD_FINENESS);
      let _df;
      try { _df = _dgeo?.fineWalkable ? _dgeo.fineWalkable(_dsqR, _dsqC) : undefined; } catch { _df = undefined; }
      if (_df === false && process.env.M59_MOVER_TRACE === '1' && Date.now() - (this._wallAimLogAt ?? 0) > 10000) {
        this._wallAimLogAt = Date.now();
        console.error(`[movestuck] ${this.logName} wall aim: dest=(${_dsqC},${_dsqR}) fine-blocked (not stand_on) — pushing/stepping anyway`);
      }
    }

    // PLAN: if no path yet, or we're stuck, plan a new one.
    // ALWAYS RUN — the A* path gives the character the route.
    // NOTE: replanning NEVER resets stuckTicks. Drawing a new line is not
    // movement — the server didn't move because we re-planned. The old
    // reset wiped the static signal on every replan, and single-waypoint
    // stub paths (consumed by one sim-advance) re-planned every tick:
    // stuck could never accumulate, the fan/escalation never fired, and
    // the character pseudo-progressed forever. _noteServerStatic resets on
    // real server movement; nothing else may zero it.
    const needPlan = this.path == null
      || this.pathIdx >= this.path.length
      || this.stuckTicks > 10;
    if (needPlan) {
      const result = this._plan(myProtoX, myProtoY);
      // PLAN OUTCOME TRACE: velocity never engages because path is null at
      // its block — is _plan failing, or is the path dropped after?
      if (process.env.M59_MOVE_DEBUG !== '0')
        try { console.error(`[movedbg] ${this.logName} plan from=(${Math.floor(myProtoX / KOD_FINENESS)},${Math.floor(myProtoY / KOD_FINENESS)}) dest=${this.dest ? this.dest.col + ',' + this.dest.row : 'null'} found=${result.found} wp=${result.found ? result.waypoints.length : 0} reason=${result.found ? '-' : (result.reason ?? '?')} expanded=${result.expanded} budget=20000 tgtFine=${geo?.fineWalkable?.(Math.floor((this.destProto?.y ?? 0) / KOD_FINENESS), Math.floor((this.destProto?.x ?? 0) / KOD_FINENESS))} tgtStand=${geo?.standable?.(Math.floor((this.destProto?.y ?? 0) / KOD_FINENESS), Math.floor((this.destProto?.x ?? 0) / KOD_FINENESS))} adjusted=${(tx !== this.destProto?.x || ty !== this.destProto?.y) ? 'yes' : 'no'} goal=${Math.floor(ty / KOD_FINENESS)},${Math.floor(tx / KOD_FINENESS)}`); } catch {}
      if (result.found) {
        this.path = result.waypoints;
        this.pathIdx = 0;
        // ADVANCE PAST IN-SQUARE WAYPOINTS. The planner may emit
        // waypoints already inside our own square (sim/server drift).
        // Skip them so path[pathIdx] is always "a square ahead of me".
        // Use Pose.confirmed (protocol units) — _serverPos is client-scale.
        try {
          const sp = Pose.confirmed(this.session);
          if (process.env.M59_MOVE_DEBUG !== '0' && Date.now() - (this._lastSpTraceAt ?? 0) > 30000) {
            this._lastSpTraceAt = Date.now();
            try { console.error(`[pose-confirmed] ${this.logName} sp=${sp ? `source=${sp.source} col=${sp.col}(${typeof sp.col}) row=${sp.row}(${typeof sp.row})` : 'null'}`); } catch {}
          }
          if (sp && sp.source !== 'none' && this.path.length > 0) {
            const srvCol = sp.col;
            const srvRow = sp.row;
            while (this.pathIdx < this.path.length) {
              const w = this.path[this.pathIdx];
              const wCol = Math.floor(w.x / KOD_FINENESS);
              const wRow = Math.floor(w.y / KOD_FINENESS);
              if (wCol === srvCol && wRow === srvRow) {
                this.pathIdx++;
              } else {
                break;
              }
            }
            // Assert: waypoints[0] within one square of the plan origin.
            // The planner's contract is that the first waypoint is adjacent
            // to the character. If it isn't, the planner is broken.
            // Gate on !coarseTier: a coarse plan's sole waypoint is the
            // destination by design, so the check only applies to fine plans.
            if (!result.coarseTier && this.pathIdx < this.path.length) {
              const w0 = this.path[this.pathIdx];
              const w0Col = Math.floor(w0.x / KOD_FINENESS);
              const w0Row = Math.floor(w0.y / KOD_FINENESS);
              const planCol = Math.floor(myProtoX / KOD_FINENESS);
              const planRow = Math.floor(myProtoY / KOD_FINENESS);
              const d = Math.abs(w0Col - planCol) + Math.abs(w0Row - planRow);
              if (d > 1 && process.env.M59_MOVE_DEBUG !== '0') {
                try { console.error(`[wp-origin] ${this.logName} wpIdx=${this.pathIdx} wp0=(${w0Col},${w0Row}) plan=(${planCol},${planRow}) dist=${d} — planner contract violated`); } catch {}
              }
            }
          }
        } catch { /* Pose.confirmed unavailable — skip the check */ }
        // IS THE PATH ACTUALLY INSTALLED? Asked because the coarse-tier fallback logs a
        // SUCCESS EVERY ~100ms -- "coarse A* found 18 waypoints" -- while the heartbeat keeps
        // reporting `path=null`. One of those two statements has to be false, and the only way
        // to tell which is to log the install itself. If a path is installed and then reported
        // null on the next tick, something between these two lines is discarding it.
        // Rate-limited to once a second so this cannot become the thing that fills the log.
        if (Date.now() - (this._lastInstallLogAt ?? 0) > 1000) {
          this._lastInstallLogAt = Date.now();
          _trace(`[path-install] ${this.logName} ${result.waypoints?.length ?? 0} waypoints `
            + `tier=${result.coarseTier ? 'COARSE' : 'fine'} `
            + `to=(${Math.floor((result.waypoints?.at(-1)?.x ?? 0) / KOD_FINENESS)},`
            + `${Math.floor((result.waypoints?.at(-1)?.y ?? 0) / KOD_FINENESS)}) `
            + `from=(${Math.floor(myProtoX / KOD_FINENESS)},${Math.floor(myProtoY / KOD_FINENESS)})`);
        }
      } else {
        // No fine path, or search exhausted. The server is
        // CLIENT-AUTHORITATIVE: it does not check geometry, it
        // records what we say. The fine model is a guide, not
        // a gate. Fall back to a direct step toward the
        // destination. We keep the reason for reporting, but
        // we still move.
        this._noRouteReason = result.reason ?? 'no fine path';
        this.path = null;  try { _trace(`[path-null] site 976`); } catch {}
        this.pathIdx = 0;
      }
    }

    // (No hold gate: the server never carries, so holding freezes. The 1/s
    // send gate below is the only throttle — the speedhack law.)

    // DITHER ESCAPE (mover-level progress window). A 1-square N-S dither
    // moves the server every tick (stuck stays 0) while going nowhere, so
    // the stuck-gated fan never fires and A* can't round the building.
    // Track net SERVER displacement over 15s; if sends flowed but net is
    // under a square with a live dest and no fan, force the slide fan.
    // Gated on sends (resting sends nothing — stillness without sends is
    // rest, not dither).
    if (this.dest != null && this._fanIndex == null && this._fanTarget == null) {
      const winMs = this._progWinMs ?? 15000;
      const pw = (this._progWin ??= []);
      const sendsNow = this._sendCount ?? 0;
      const _pw = Pose.confirmed(s);
      const pc = _pw.source !== 'none' ? _pw.col : null;
      const pr = _pw.source !== 'none' ? _pw.row : null;
      if (pc != null) {
        pw.push({ t: Date.now(), col: pc, row: pr, sends: sendsNow });
        while (pw.length && Date.now() - pw[0].t > winMs) pw.shift();
        if (dithered(pw, Date.now(), winMs)) {
          this._fanIndex = 0;
          this._fanFrom = { x: protocolToClient(myProtoX), y: protocolToClient(myProtoY) };
          pw.length = 0;
        }
      }
    } else if (this._progWin?.length) {
      this._progWin.length = 0;
    }

    // CORNER ROUNDED: RELEASE THE FAN. Restored from 2d44a48^, where it read 'Direct path is
    // CLEAR and we were sliding: corner rounded. Release the fan so velocity resumes
    // (persistent slide would otherwise keep sidestepping past the opening).' It was deleted
    // with the slide-along-wall check and never replaced, and its absence is a live defect
    // rather than a stylistic one: the dither detector above can only FIRE the fan and nothing
    // here ever puts it down, so a character that fans once keeps fanning — it sidesteps past
    // the opening it was sliding toward and then dithers again, which is the oscillation this
    // goal was opened to fix.
    //
    // The clear-test is the INTEGRATION rather than the old radius-free trace. The pre-fix code
    // used `playerRadius: 1` and justified it as 'the full player radius clips nearby walls and
    // reads the direct path as blocked on open ground, firing the fan which then escapes a
    // pocket that doesn't exist'. That reasoning is sound and the constant was wrong for the
    // reason documented at PLAYER_WALL_CLEARANCE_CLIENT_UNITS. What matters here is that the
    // release test and the declaration agree about what 'clear' means; if they use different
    // geometry the fan re-fires on the next tick and the release does nothing.
    // `standOnNear` in 2d44a48^ was declared at preFix:830, above the clause. Here it is
    // recomputed from the same formula rather than reaching for the `standOnNear` at line
    // 1256, which is inside a different block and out of scope — the same class of error as
    // the `f`/`frame` crash in decide(), and the reason this restore is written with its own
    // binding instead of assuming the old one is still in view.
    const _standOnNear = !!this._destIsStandOn && this.destProto != null &&
      Math.hypot(this.destProto.x - myProtoX, this.destProto.y - myProtoY) < KOD_FINENESS * 4;
    if (this._fanIndex != null && !_standOnNear) {
      const geo = this.session?.world?.geometry;
      if (geo?.traceFineMoveClient) {
        // THE TEST MUST HAVE SOMETHING TO TEST. A zero-length path — the aim is where we already
        // are — integrates to 'clear' trivially, because nothing blocks a move of zero distance.
        // Releasing on that would clear the fan on the exact tick the fan exists to escape, which
        // is how the first draft of this restore failed five fan tests: the fan fired, the release
        // ran on the same tick with the character's own position as the aim, and the fan was gone
        // before it could probe. Require real distance before trusting a 'clear' verdict, and
        // require the full distance to be clear, not merely some of it.
        const relDist = Math.hypot(aimX - myProtoX, aimY - myProtoY);
        const rel = relDist < 1 ? { moved: 0, stopped: 'no path to test' }
          : this._integrateToward(geo, myProtoX, myProtoY, aimX, aimY,
          relDist,
          { dt: 1000, numSteps: STEPS_PER_MOVE, playerRadius: PLAYER_WALL_CLEARANCE_CLIENT_UNITS });
        // CLEAR MEANS WALKABLE, AND THE TRACE ONLY ANSWERS ABOUT WALLS. The pre-fix clause tested
        // the trace alone and released on `!blocked`; the rigs that caught that are the five fan
        // tests, which put a clear trace over a FLOORLESS square (standable false, `voidSlideGeo`)
        // and watch whether the mover steps into it. A wall and a hole are different refusals and
        // the fan exists for both: this file's own fan-aiming comment says 'wandering void is how
        // characters get lost and die'. So the release requires the destination square to be
        // standable as well as the path to be unblocked — releasing into a void is worse than not
        // releasing, because the fan was the thing trying to get out of it.
        // RELEASE ONLY IF THE FAN IS FINISHED WITH, NOT MERELY BECAUSE THE AIM IS REACHABLE.
        //
        // The pre-fix clause tested the trace to the AIM and released on `!blocked`. That is the
        // whole of its defect and the rigs prove it: `voidSlideGeo` voids square (4,2), which is
        // where a fan HEADING stride-extends, while the trace to the aim is clear and the aim's own
        // square is fine. A release keyed on the aim therefore fires on every one of those ticks,
        // the fan is discarded, and the mover walks into the hole the fan was about to step around
        // — or, with every heading void, never reaches `stuck` and so never reaches blink. Exhausting
        // the fan is the only route out of a pocket, and a release that pre-empts it is not a
        // convenience, it is a dead end with better manners.
        //
        // So the release is keyed on the heading the fan is ABOUT to try. If that heading is
        // walkable, the fan has found its way and there is nothing left to escape: release and let
        // the direct declaration resume. If it is not, keep fanning.
        const FAN_ANGLES = [0, -0.35, 0.35, -0.75, 0.75, -1.2, 1.2, -1.7, 1.7];
        const nextAngle = FAN_ANGLES[(this._fanIndex ?? 0) % FAN_ANGLES.length];
        const baseAngle = Math.atan2(aimY - myProtoY, aimX - myProtoX);
        const probe = this._integrateToward(geo, myProtoX, myProtoY,
          myProtoX + Math.cos(baseAngle + nextAngle) * strideNow,
          myProtoY + Math.sin(baseAngle + nextAngle) * strideNow,
          strideNow, { dt: 1000, numSteps: STEPS_PER_MOVE, playerRadius: PLAYER_WALL_CLEARANCE_CLIENT_UNITS });
        const nextCol = Math.floor(probe.x / KOD_FINENESS), nextRow = Math.floor(probe.y / KOD_FINENESS);
        const nextGrounded = geo.standable ? geo.standable(nextRow, nextCol) !== false : true;
        const aimClear = rel.stopped == null && rel.moved >= relDist - 1;
        const headingWalkable = probe.stopped == null && nextGrounded;
        // NOT ON THE TICK THE FAN WAS BORN. The escape fan is fired earlier in this same tick by
        // the leafless-point / no-floor detector, which deliberately does not return so the gate
        // can send immediately. A release that runs on that tick cancels the fan the tick that
        // created it and the mover walks into the hole it was escaping — which is what the
        // leafless-point rig caught. 'The corner was rounded' is a statement about a slide that
        // has happened, and on the tick of creation nothing has happened yet.
        // NOT ON THE TICK THE FAN WAS BORN. The escape fan is fired earlier in this same tick by
        // the leafless-point / no-floor detector, which deliberately does not return so the gate
        // can send on the tick of creation. A release that runs there cancels the fan the tick that
        // made it and the mover walks into the hole it was escaping. Keyed on the tick's own start
        // time rather than a per-creation counter, because there are four sites that create a fan
        // and a counter has to be incremented at all four and at the fifth someone adds; a fan with
        // no counter read as 'no history' is a mover that never releases, which is the failure this
        // whole goal is about. Comparing against the tick's start time needs no cooperation.
        const fanHasHistory = this._fanFiredAt == null || this._fanFiredAt < this._tickStartedAt;
        if (aimClear && headingWalkable && fanHasHistory) {
          this._fanIndex = null;
          this._fanTarget = null;
          this._fanFrom = null;
          this._fanSentAt = null;
          try { _trace(`[movedbg] fan released: direct path to aim clear (${Math.round(rel.moved)} units clear)`); } catch {}
        }
      }
    }

    // If the fan is active (we were in raw-move fallback), fire the next heading.
    // PHASE 0a: the fan probes with single-step declarations (1/s gated).
    // Each packet is one accepted position; the progress check above commits
    // only directions the SERVER actually moved us.
    if (this._fanTarget != null || (this._fanIndex != null && this._fanIndex < 9)) {
      const FAN = [0, -0.35, 0.35, -0.75, 0.75, -1.2, 1.2, -1.7, 1.7];
      const idx = this._fanIndex ?? 0;
      const angle = FAN[idx % FAN.length];
      // Direction to the AIM (waypoint if path exists, target if not) for
      // the base angle, from the server point. The fan slides along the wall
      // toward the aim. GROUND-SEEKING ESCAPE: starting on void, aim at the
      // nearest grounded square instead of the travel aim — wandering void
      // is how characters get lost and die; walk out to solid ground first.
      let fanAimX = aimX, fanAimY = aimY;
      if (startIsVoid) {
        try {
          const ng = nearestGrounded(this.session?.world?.geometry, curCol, curRow, { maxRadius: 40 });
          if (ng) { fanAimX = ng.col * KOD_FINENESS + HALF; fanAimY = ng.row * KOD_FINENESS + HALF; }
        } catch { /* keep the travel aim */ }
      }
      const dx = fanAimX - myProtoX;
      const dy = fanAimY - myProtoY;
      const dist = Math.hypot(dx, dy);
      const baseAngle = Math.atan2(dy, dx);
      const finalAngle = baseAngle + angle;
      // VELOCITY DECLARATION: send moveTo(fanX, fanY, speed) — one accepted
      // position per packet. The fan heading is the direction; the target is
      // ONE STEP ahead (16 units = MOVEUNITS), not 100 units (a far target
      // could jump a wall the segment check can't see).
      // STRIDE-SCALED PROBES (parity): a fixed 16-proto probe caps wall-
      // following at 1/4 sq/s. Extend along the heading up to the official
      // stride (walk 160 / run 320) when the SEGMENT validates clean via
      // trace (arrived===true) — safe by construction, 10x faster along
      // clear slides. Falls back to the 16-probe on any block.
      // THE PROBE MUST BE AT LEAST ONE SQUARE LONG OR IT CANNOT LEAVE THE SQUARE.
      //
      // This was MOVEUNITS_PROTO, which is 16 — and the character's position is always a
      // square CENTRE, because every position the mover adopts comes from
      // `col * KOD_FINENESS + HALF`. The centre is 32 units from any edge. A 16-unit probe
      // from a point 32 units from the nearest edge cannot reach it, so for all nine
      // headings the probe landed back in the square the character was already standing in.
      // Not sometimes: always, whenever the fallback was taken.
      //
      // Measured on one keeper process: 153 fan packets declared a position EXACTLY equal
      // to the server's. All 153 came from this fallback. Zero came from the stride-scaled
      // integration below, which produced 417 packets that all moved him. The fallback was
      // 31% of fan sends and 100% of the useless ones.
      //
      // What such a packet looks like to everybody downstream is the worst part. The server
      // does not refuse it — user.kod:3099 passes new_row through verbatim and
      // ReqSomethingMoved returns TRUE by default — so there is no reply, no error, no log.
      // The mover returns state:'raw-move', which reads in the dashboard, in the logs and
      // in my own analysis this afternoon as a character that is escaping. It is a character
      // asking to be where it already is, nine times, once a second.
      //
      // WHY 64 AND NOT LONGER. The comment below the old constant says the probe is one step
      // and not a far target because "a far target could jump a wall the segment check can't
      // see". That is a real safety property and 64 preserves it exactly: from a centre, a
      // 64-unit probe lands in an orthogonally adjacent square, and a 64-unit DIAGONAL probe
      // moves 45 units per axis, which is still under 64, so it reaches a diagonally adjacent
      // square and no further. It cannot skip a square. 64 is simultaneously the shortest
      // probe that can leave the current one and the longest that cannot jump past one —
      // which is why it is the right value rather than a bigger number.
      //
      // The stride-scaled extension below is unchanged and remains the fast path: it
      // lengthens a heading to the full stride (walk 160 / run 320) only when the trace
      // validates the whole segment. This only fixes the floor for when it does not.
      let fanX = myProtoX + Math.cos(finalAngle) * KOD_FINENESS;
      let fanY = myProtoY + Math.sin(finalAngle) * KOD_FINENESS;
      const _fgeo = this.session?.world?.geometry;
      if (_fgeo?.traceFineMoveClient) {
        // Stride origin is the SIM (the live position; the server is
        // client-authoritative, so the sim is where we are — the echo lags).
        const _fx = myProtoX + Math.cos(finalAngle) * strideNow;
        const _fy = myProtoY + Math.sin(finalAngle) * strideNow;
        // THE EXTENSION IS AN INTEGRATION, NOT AN APPROVAL.
        //
        // This site used to trace the full stride once and, if the trace came back clear,
        // send the stride's endpoint. That is the defect tools/m59-locomotion-test.mjs was
        // written around, and it is worth being exact about what was wrong, because the site
        // LOOKED careful: it validated, it chose its radius deliberately, it fell back to the
        // short probe on any block. What it did not do is ask the question the send needs
        // answered. A trace reports on the segment it was handed; a clear verdict on a
        // 16-unit probe says nothing about the 320 units past it, and this code used the
        // former to authorise the latter.
        //
        // Observed on a room whose wall the coarse grid cannot see (fineWalkable tests a
        // square by its CENTRE at radius 256; walls lie on square BOUNDARIES, 512 from either
        // centre, so that class of wall is invisible to the planner): the character crept east
        // 16 units at a time, crossed the boundary on a step the grid could not see, and from
        // then on every trace was legitimately clear — it was already on the far side. It then
        // extended to the full stride, reported a position 1840 client units past a sealed
        // wall, and returned `arrived`. The server is client-authoritative and believed it.
        //
        // So integrate instead of approving: walk the heading in sub-steps and take the
        // position where the integration STOPPED. The illegal position is never constructed,
        // which is the property move.c has by construction (move.c:374-382 sets `x = last_x`
        // and move.c:764 reports `player.x`) and the property this site lacked.
        //
        // RADIUS-FREE is preserved for the same reason it was chosen before: the full player
        // radius (32) clips nearby walls and rejects open directions the stepmask
        // (playerRadius: 1) accepts, producing the self-inflicted pocket on open ground.
        const _integ = this._integrateToward(_fgeo, myProtoX, myProtoY, _fx, _fy, strideNow, {
          dt: 1000, numSteps: STEPS_PER_MOVE, playerRadius: PLAYER_WALL_CLEARANCE_CLIENT_UNITS,
        });
        fanX = _integ.x; fanY = _integ.y;
      }
      const speed = 18; // walking speed
      // NEVER STEP INTO A VOID: from a grounded start, skip headings whose
      // probe lands on floorless ground (the deliberate stand_on exit itself
      // is exempt). Treated exactly like a refused heading: advance, and
      // exhaust to blink/stuck when no heading has ground.
      {
        const sqC = Math.floor(fanX / KOD_FINENESS), sqR = Math.floor(fanY / KOD_FINENESS);
        const destSqC = this.destProto ? Math.floor(this.destProto.x / KOD_FINENESS) : null;
        const destSqR = this.destProto ? Math.floor(this.destProto.y / KOD_FINENESS) : null;
        const sqIsExit = this._destIsStandOn === true && sqC === destSqC && sqR === destSqR;
        // A HEADING THAT DOES NOT LEAVE OUR OWN SQUARE IS NOT A HEADING. Try the next one.
        //
        // The probe is `myProtoX + cos(angle) * MOVEUNITS_PROTO`, and MOVEUNITS_PROTO is 16
        // — a QUARTER of a 64-unit square. So whether a heading reaches the next square
        // depends on where inside the current square the character happens to be standing.
        // Measured live, from square (28,35): four of the nine headings landed back in
        // (28,35). Across one keeper process, 130 fan packets declared a position EXACTLY
        // equal to the server's — not 16 units off it, EQUAL to it — and 66 velocity sends
        // bought under one unit of ground.
        //
        // The server has nothing to do with such a packet. It is not refused, not logged,
        // not an error: user.kod:3099 passes new_row through verbatim and ReqSomethingMoved
        // returns TRUE by default, so there is no reply to wait for. The mover returns
        // state:'raw-move', which in the dashboard and in every log reading looks exactly
        // like activity. It is how I spent an hour concluding the SERVER was throttling us
        // to one move per four seconds, when a quarter of the packets in the measurement
        // were asking the character to be where he already was.
        //
        // Treated as a REFUSED heading so it advances _fanIndex and exhausts to
        // blink/stuck like any other dead end. That is the honest outcome: if no heading
        // leaves the square, the character IS stuck, and saying so beats sending no-ops a
        // second apart and calling it escaping.
        //
        // DELIBERATELY NOT A CHANGE TO MOVEUNITS_PROTO. The comment above says the probe is
        // one step and not a far target because "a far target could jump a wall the segment
        // check can't see" — that is a stated safety property and it still holds. The
        // stride-scaled extension below already lengthens a heading only when the trace
        // validates the whole segment. This guard lengthens nothing; it declines to send a
        // heading that provably goes nowhere, which is safe for the stronger reason that it
        // sends LESS than before.
        //
        // EXEMPT: a start with no ground under it. From a void square the trace refuses to
        // even begin (start_has_no_floor), so every heading's integration returns the start
        // point and this guard would reject all nine headings and route the character to
        // blink. The void case already has its own handling at the startIsVoid branch, and
        // blink is the one tool that has ever gotten a character out of one.
        if (!startIsVoid && sqC === Math.floor(myProtoX / KOD_FINENESS)
                          && sqR === Math.floor(myProtoY / KOD_FINENESS)) {
          this._fanIndex = idx + 1;
          if (this._fanIndex >= 9) {
            return this._fanExhausted(protocolToClient(myProtoX), protocolToClient(myProtoY));
          }
          return { state: 'raw-move', fanIndex: this._fanIndex,
                   why: 'fan heading lands in our own square; nothing to move' };
        }
        // Skip headings into floorless ground OR up unclimbable faces. The
        // stride extension above already refused wall/height-blocked segments;
        // this covers the 16-unit base probe the extension falls back to.
        // A KOD TELEPORT CORNER IS REFUSED LIKE A WALL. The fan is the site that actually
        // caused the ping-pong: it probes eight headings, the corner squares are perfectly
        // walkable, and the heading that points into the corner is often the best-scoring one.
        // In Marion the fan declared into the 534 corner 79 times while the destination was in
        // 535, and each declaration teleported the character out of the room the router had
        // just sent him into.
        if (!startIsVoid && !sqIsExit && (transitBanned(_fgeo, sqR, sqC) === true
            || segHeightOk(_fgeo, myProtoX, myProtoY, fanX, fanY) === false
            || regionCornerBanned(_fgeo, sqR, sqC, this._wantRoom))) {
          this._fanIndex = idx + 1;
          if (this._fanIndex >= 9) {
            return this._fanExhausted(protocolToClient(myProtoX), protocolToClient(myProtoY));
          }
          return { state: 'raw-move', fanIndex: this._fanIndex, why: 'fan heading refused (no floor, too steep,), skipping' };
        }
      }
      // Cheat-clean: gate fan probes to the 1/s send law like every move.
      // Ungated this fires every tick (10/s) and trips speedhack detection.
      const fServerPX = curCol * KOD_FINENESS + HALF, fServerPY = curRow * KOD_FINENESS + HALF;
      if (Date.now() - (this._fanDbgAt ?? 0) > 20000) {
        this._fanDbgAt = Date.now();
        try { const _g = this._movementGateOk(fanX, fanY, myProtoX, myProtoY, fServerPX, fServerPY); console.error(`[movedbg] ${this.logName} fan gate=${_g} me=(${Math.round(myProtoX)},${Math.round(myProtoY)}) srv=(${fServerPX},${fServerPY}) age=${Date.now() - (this._lastReportAt ?? 0)} idx=${idx} tgt=${this._fanTarget ? 'Y' : 'n'}`); } catch (e) { console.error(`[movedbg] ${this.logName} fan gate THROW: ${e.message}`); }
      }
      if (this._movementGateOk(fanX, fanY, myProtoX, myProtoY, fServerPX, fServerPY)) {
        const _sent = this._submitMove(s, c, () => c.moveTo(Math.round(fanX), Math.round(fanY), speed, c.room?.id ?? 0));
        if (_sent) {
          this._recordSend(fanX, fanY, myProtoX, myProtoY, Math.round(fanX), Math.round(fanY), 'escape-fan-probe');
        }
        this._recordReport(fanX, fanY);
        this._fanTarget = { x: protocolToClient(fanX), y: protocolToClient(fanY) };
        this._fanSentAt = Date.now();
        if (process.env.M59_MOVER_TRACE === '1') {
          const _fsrv2 = Pose.confirmed(this.session);
          console.error(`[fan-probe] ${this.logName} idx=${idx} aim=(${Math.round(fanX)},${Math.round(fanY)}) srvAtSend=(${_fsrv2.x ?? '?'},${_fsrv2.y ?? '?'}) fanFrom=(${this._fanFrom?.x ?? '?'},${this._fanFrom?.y ?? '?'})`);
        }
        // _fanFrom is the SERVER reference point for the progress check (which
        // uses the raw server echo). Resetting it to the drifted sim would make
        // the progress check compare server-vs-sim (>8), firing the 'success'
        // branch on a walled-in pocket. Use the raw server echo.
        const _fsrv = Pose.confirmed(this.session);
        const _fsrvX = _fsrv.x, _fsrvY = _fsrv.y;
        this._fanFrom = { x: protocolToClient(_fsrvX ?? (curCol * KOD_FINENESS + HALF)), y: protocolToClient(_fsrvY ?? (curRow * KOD_FINENESS + HALF)) };
        this._fanIndex = idx;
      }
      return { state: 'raw-move', fanIndex: idx, velocity: true };
    }

    // PHASE 0a: BOUNDARY CROSSING. When the destination is a stand_on
    // (exit) square and the character is close to it, use the go() command
    // (REQ_GO) instead of the velocity declaration. The go() command tells
    // the server "I'm going through this door" — the server processes the
    // transition. The velocity declaration (moveTo) does not trigger the
    // door crossing; the character gets stuck at the boundary.
    // PHASE 0a: BOUNDARY CROSSING. When the destination is a stand_on
    // (exit) square and the character is close to it, OR when the aim is
    // OUT OF BOUNDS for the current room (the aim is in the other room),
    // use the go() command (REQ_GO) instead of the velocity declaration.
    // The go() command tells the server "I'm going through this door" —
    // the server processes the transition. The velocity declaration
    // (moveTo) does not trigger the door crossing; the character gets
    // stuck at the boundary.
    if (this._destIsStandOn) {
      const geo = this.session?.world?.geometry;
      const distToDest = Math.hypot(this.destProto.x - myProtoX, this.destProto.y - myProtoY);
      const aimOOB = geo?.inBounds?.(Math.floor(aimY / KOD_FINENESS) + 1, Math.floor(aimX / KOD_FINENESS) + 1) === false;
      if (distToDest < KOD_FINENESS * 4 || aimOOB) {
        // WALK PAST THE BOUNDARY (into the wall) to trigger the transition.
        // The character needs to hit the wall (the boundary) for the server
        // to process the transition. The go() command does not work — the
        // character must walk into the wall.
        // Compute a target PAST the boundary: one square beyond the stand_on
        // square (in the other room). Use the EDGE DIRECTION (away from the
        // room interior), not the character-to-stand_on direction (which is
        // degenerate when the character is at the stand_on).
        const destCol = Math.floor(this.destProto.x / KOD_FINENESS);
        const destRow = Math.floor(this.destProto.y / KOD_FINENESS);
        // Determine the edge direction from the edgeTarget (the square beyond
        // the boundary, in the other room). The direction from the stand_on
        // square to the edgeTarget is the edge direction (away from the room
        // interior).
        let edgeDx = 0, edgeDy = 0;
        if (this._edgeTarget) {
          // edgeTarget is {x, y} in protocol units.
          const dx = this._edgeTarget.x - this.destProto.x;
          const dy = this._edgeTarget.y - this.destProto.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 0) {
            edgeDx = dx / dist;
            edgeDy = dy / dist;
          }
        }
        // Fallback: if the edgeTarget is not set, use the room boundary check.
        if (edgeDx === 0 && edgeDy === 0) {
          const destCol = Math.floor(this.destProto.x / KOD_FINENESS);
          const destRow = Math.floor(this.destProto.y / KOD_FINENESS);
          if (destRow === 0) { edgeDy = -1; } // north edge
          else if (destRow === (geo?.rows ?? 63) - 1) { edgeDy = 1; } // south edge
          else if (destCol === 0) { edgeDx = -1; } // west edge
          else if (destCol === (geo?.cols ?? 63) - 1) { edgeDx = 1; } // east edge
        }
        // Fallback: if the edge direction is still (0,0), use the character-to-stand_on
        // direction (the character is not at the stand_on yet).
        if (edgeDx === 0 && edgeDy === 0) {
          const dx = this.destProto.x - myProtoX;
          const dy = this.destProto.y - myProtoY;
          const dist = Math.hypot(dx, dy);
          if (dist > 0) {
            edgeDx = dx / dist;
            edgeDy = dy / dist;
          } else {
            // Character is at the stand_on square and no edge direction available.
            // Default to north (the most common boundary).
            edgeDy = -1;
          }
        }
        // The past target is the edge target (the wall). The character needs
        // to hit the wall (the boundary) to trigger the transition. Walking
        // past the wall does not trigger the transition.
        const pastX = this._edgeTarget ? this._edgeTarget.x : this.destProto.x + edgeDx * 32;
        const pastY = this._edgeTarget ? this._edgeTarget.y : this.destProto.y + edgeDy * 32;
        // Cheat-clean: gate to the 1/s send law (ungated this fires every
        // tick at a boundary and trips speedhack detection).
        // HEIGHT DISCIPLINE (move.c): walking past into an unclimbable face
        // is not a crossing — refuse and escalate (stuck -> fan -> blink)
        // instead of declaring a position the client could never stand on.
        // Walls still pass (the door itself).
        const wServerPX = curCol * KOD_FINENESS + HALF, wServerPY = curRow * KOD_FINENESS + HALF;
        if (segHeightOk(geo, myProtoX, myProtoY, pastX, pastY) === false) {
          this.stuckTicks++;
          return { state: 'stuck', why: 'exit climb refused' };
        }
        if (this._movementGateOk(pastX, pastY, myProtoX, myProtoY, wServerPX, wServerPY)) {
          const _sent = this._submitMove(s, c, () => c.moveTo(Math.round(pastX), Math.round(pastY), 18, c.room?.id ?? 0));
          if (_sent) {
            this._recordSend(pastX, pastY, myProtoX, myProtoY, Math.round(pastX), Math.round(pastY), 'walk-past-boundary');
          }
          this._recordReport(pastX, pastY);
        }
        return { state: 'crossing', walkPast: true };
      }
    }

    // FOLLOW THE PATH: head toward the current waypoint.
    // If path is null (no fine path found), go directly to
    // the destination. The server is client-authoritative.
    const wp = this.path ? this.path[this.pathIdx] : null;

    // THE HEADING IS DECIDED ONCE, ABOVE ALL THREE ENGINES, so that whichever of them
    // returns first does not win the tick merely by sitting earlier in the file. `ahead` is
    // the farthest waypoint this tick's stride can legally reach. An engine below may send it
    // or decline it, but none of them can leave the mover aimed at one square because that is
    // where its own branch happened to be.
    let ahead = null;
    {
      const _g = this.session?.world?.geometry;
      const _v0 = s.client?.vitals?.()?.vigor?.value ?? 0;
      const _run0 = s?.policy?.allowRun !== false && _v0 >= RUN_VIGOR_FLOOR;
      ahead = this._routeAhead(_g, myProtoX, myProtoY, _run0 ? RUN_STRIDE_PROTO : WALK_STRIDE_PROTO);
    }
    // RAW-MOVE DOOR PUSH: if we are CLOSE to the dest (within 4 squares) and the dest is
    // FINE-UNREACHABLE (a door alcove, a walled gap — the fine model says no path), do a
    // raw move toward the dest, bypassing the fine model. The server is client-
    // authoritative — it accepts a step the fine model refuses. This is the final push
    // into a door: the character is at the approach point, the standOn is fine-unreachable,
    // and the fine model's candidate search wanders around the approach point without
    // ever reaching the door (each neighbor is fine-reachable but none progress). Bypassing
    // the fine model entirely (a raw position packet) is the only way through. Checked
    // BEFORE path following so it works whether or not a (stale) path exists.
    {
      const destCol = Math.floor(this.destProto.x / KOD_FINENESS);
      const destRow = Math.floor(this.destProto.y / KOD_FINENESS);
      const distToDest0 = Math.hypot(this.destProto.x - myProtoX, this.destProto.y - myProtoY);
      const geoRef = this.session?.world?.geometry;
      const destFineOk = geoRef?.fineWalkable ? geoRef.fineWalkable(destRow, destCol) : undefined;
      // FIRE ON TWO TRIGGERS. (1) The dest square is FINE-BLOCKED — a door in a walled gap
      // the model can't path to. (2) The dest is fine-walkable as a square but we are near it
      // and A* found NO PATH (this._noRouteReason is set and this.path is null) — the Raza
      // Blacksmith door is exactly this: (9,7) is marked walkable, but the only approach from
      // the room edge (10,5) is walled off, so the path search fails. Both are the same
      // "walled gap" the raw push exists for; the server is client-authoritative and accepts
      // a step the fine model refuses.
      const noPathToNearDest = this.path == null && this._noRouteReason != null;
      // PHASE 2: the stand_on trigger. When the destination is an exit square
      // (stand_on), the geometry's "no floor" answer is wrong — the character is
      // meant to stand on this square to trigger a transition. Fire the raw push
      // whenever we are near it, regardless of the fine model's answer.
      const standOnNear = this._destIsStandOn && distToDest0 < KOD_FINENESS * 4;
      // NEVER PUSH INTO A VOID: a floorless non-exit destination is a bad
      // target, not a door alcove. Stand_on exits are exempt by design.
      const destGroundOk = (this._destIsStandOn === true || transitBanned(geoRef, destRow, destCol) !== true)
        && !regionCornerBanned(geoRef, destRow, destCol, this._wantRoom);
      if (distToDest0 < KOD_FINENESS * 4 && (destFineOk === false || noPathToNearDest || standOnNear) && destGroundOk) {
        const rx = this.destProto.x - myProtoX, ry = this.destProto.y - myProtoY;
        const rd = Math.hypot(rx, ry) || 1;
        const stepProto = Math.min(rd, KOD_FINENESS);
        // ONE SQUARE, AND WHY THE TRACE IS NOT ASKED ABOUT IT.
        //
        // The obvious move was to run this through `_integrateToward` like every other send.
        // That is wrong, and the reason is the raw push's own purpose: it exists to enter a gap
        // the fine model is WRONG about — a door alcove the coarse graph cannot see. Gating it
        // on the trace means gating it on the mechanism that is already known to be mistaken
        // here, which deletes the branch. Measured: with a trace that refuses everything (the
        // case under test, and the case the branch was written for) the integrated push sends the
        // ORIGIN and the character never moves again.
        //
        // So the safety bound is not the trace, it is the DISTANCE. One square is the extent the
        // coarse walkable-square graph has already vouched for, and it is shorter than the
        // player's own clearance in the trace's units — so a one-square push cannot put the
        // character through a wall the geometry can see, only through one it cannot. That is
        // exactly the trade this branch is for, and it is the reason the rounding is toward the
        // target rather than away from it: the destination of a one-square push is a square
        // centre, which is the safest place in the square.
        const rawX = Math.round(myProtoX + (rx / rd) * stepProto);
        const rawY = Math.round(myProtoY + (ry / rd) * stepProto);
        if (Date.now() - (this._lastRawLogAt ?? 0) > 2000) {
          this._lastRawLogAt = Date.now();
          console.error(`[raw-door-push] my=(${Math.round(myProtoX)},${Math.round(myProtoY)}) dest=(${destCol},${destRow}) dist=${distToDest0.toFixed(0)} raw->(${rawX},${rawY}) wp=${wp?'yes':'no'}`);
        }
        // The raw-door-push is a DELIBERATE escape into a fine-blocked gap (a
        // door alcove), not regular movement pacing. It only fires when the
        // character is within 4 squares of a fine-unreachable destination — a
        // rare, intentional action. The lazy-report gate (1000ms interval +
        // moved-past-last-report) would throttle it and, worse, deadlock when
        // the character is standing ON the last-reported square (the approach
        // point): myProto == _lastReport, movedEnough=false, gate closed, the
        // push never goes out and the character sits at the approach point. The
        // server is client-authoritative here — a position packet into the
        // alcove is accepted — so send it directly. A short cooldown prevents
        // a flood while the character is mid-gap.
        // HEIGHT DISCIPLINE (move.c): a push into an unclimbable face is not a
        // door — skip the whole push (path included) and let the stepper/fan
        // below escalate to blink. Walls still pass (deliberate).
        if (segHeightOk(geoRef, myProtoX, myProtoY, rawX, rawY) !== false) {
          if (Date.now() - (this._lastRawPushAt ?? 0) >= 500) {
            this._lastRawPushAt = Date.now();
            const _sent = this._submitMove(s, c, () => s.client.moveTo(rawX, rawY, 18, s.client.room?.id ?? 0));
            if (_sent) {
              this._recordSend(this.destProto.x, this.destProto.y, myProtoX, myProtoY, rawX, rawY, 'raw-door-push');
            }
          }
          if (Date.now() - (this._lastRawLogAt ?? 0) > 5000) {
            this._lastRawLogAt = Date.now();
            console.error(`[raw-door-push] my=(${Math.round(myProtoX)},${Math.round(myProtoY)}) dest=(${destCol},${destRow}) dist=${distToDest0.toFixed(0)} wp=${wp?'yes':'no'}`);
          }
          this.path = null;  // drop any stale path; we're pushing through the gap  try { _trace(`[path-null] site 1407`); } catch {}
          return { state: 'moving', to: { col: destCol, row: destRow }, raw: true };
        }
      }
    }
    if (!wp) {
      // Past the last waypoint (or no path): walk toward
      // the destination one square at a time, using the same
      // candidate search as the waypoint branch (validate each
      // candidate against the fine grid, try alternatives).
      if (this.path) this.pathIdx = this.path.length;
      // Arrival and candidate origin on the COMMITMENT point (see tick-top).
      const dx = this.destProto.x - cmtX;
      const dy = this.destProto.y - cmtY;
      const dist = Math.hypot(dx, dy);
      if (dist < KOD_FINENESS * 0.5) {
        this.clear();
        return { state: 'arrived', position: { col: effMe.col, row: effMe.row } };
      }
      // CANDIDATE ORIGIN IS THE SIM (the live position). The server is
      // client-authoritative so the sim is where the character is; the echo
      // lags ~1s. Ordering candidates from the stale echo re-aims from
      // behind on every tick and ping-pongs the character (watched live:
      // steps alternating N/S with zero net progress while gated at 1/s).
      const myCol = Math.floor(myProtoX / KOD_FINENESS);
      const myRow = Math.floor(myProtoY / KOD_FINENESS);
      const destCol = Math.floor(this.destProto.x / KOD_FINENESS);
      const destRow = Math.floor(this.destProto.y / KOD_FINENESS);
      const geo = this.session?.world?.geometry;
      // STRIDED DIRECT DECLARATION: the planner failed, but a beeline that
      // validates clean is as safe as any fan stride (same trace + ground
      // checks). Without this, no-path travel is capped at 1 square per send
      // even across open ground — the observed 0.15 sq/s regime. Falls through
      // to single-square stepping when the segment is blocked or floorless.
      {
        const ndx = this.destProto.x - myProtoX, ndy = this.destProto.y - myProtoY;
        const nd = Math.hypot(ndx, ndy);
        if (nd > KOD_FINENESS) {
          const slen = Math.min(nd, strideNow);
          const sx = Math.round(myProtoX + (ndx / nd) * slen);
          const sy = Math.round(myProtoY + (ndy / nd) * slen);
          const sqC = Math.floor(sx / KOD_FINENESS), sqR = Math.floor(sy / KOD_FINENESS);
          const sqIsExit = this._destIsStandOn === true && sqC === destCol && sqR === destRow;
          const sqGroundOk = (sqIsExit || transitBanned(geo, sqR, sqC) !== true)
            && !regionCornerBanned(geo, sqR, sqC, this._wantRoom);
          let segOk = false;
          if (sqGroundOk && geo?.traceFineMoveClient) {
            try {
              const tr = geo.traceFineMoveClient(
                protocolToClient(myProtoX), protocolToClient(myProtoY),
                protocolToClient(sx), protocolToClient(sy),
                { slide: false, playerRadius: 32 });
              segOk = !!(tr && tr.blocked !== true);
            } catch { segOk = false; }
          }
          const srvPX = srvCol * KOD_FINENESS + HALF, srvPY = srvRow * KOD_FINENESS + HALF;
          if (segOk && this._movementGateOk(sx, sy, myProtoX, myProtoY, srvPX, srvPY)) {
            const npSpeed = runNow ? 36 : 18;
            const _sent = this._submitMove(s, c, () => c.moveTo(sx, sy, npSpeed, c.room?.id ?? 0));
            if (_sent) {
              this._recordSend(this.destProto.x, this.destProto.y, myProtoX, myProtoY, sx, sy, 'no-path-stride');
            }
            this._recordReport(sx, sy);
            // Honest stuck bookkeeping: the stride sends while the server
            // echo sits still for ~1s. Without this the direct-send site
            // froze stuckTicks at 0 while sends flowed (the fan and the
            // pocket escalation stayed blind). Server squares only.
            this._noteServerStatic(srvCol, srvRow);
            return { state: 'moving', to: { col: destCol, row: destRow }, stride: true };
          }
        }
      }
      // Candidate squares ordered toward the destination.
      const sdx = Math.sign(destCol - myCol);
      const sdy = Math.sign(destRow - myRow);
      const candidates = [];
      if (sdx !== 0) candidates.push([myCol + sdx, myRow]);
      if (sdy !== 0) candidates.push([myCol, myRow + sdy]);
      if (sdx !== 0 && sdy !== 0) candidates.push([myCol + sdx, myRow + sdy]);
      for (const [dc2, dr2] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const nc = myCol + dc2, nr = myRow + dr2;
        if (!candidates.some(([c2, r2]) => c2 === nc && r2 === nr)) {
          candidates.push([nc, nr]);
        }
      }
      let stepCol = null, stepRow = null;
      // Loop avoidance: try unvisited squares first (recently-sent last).
      // Never exclude (dead ends must backtrack). Engaged ONLY while stuck:
      // applied every tick it turns straight walks into a drunkard's dither
      // (each step avoids the last, so open ground random-walks at ~0 net).
      // While the server position advances, walk straight at the goal.
      const ordered0 = orderCandidates(candidates, this._recentSteps, this.stuckTicks,
        { meCol: myCol, meRow: myRow, goalCol: destCol, goalRow: destRow,
          refused: this._refusedKeys() });
      for (const [nc, nr] of ordered0) {
        const f = geo?.fineWalkable ? geo.fineWalkable(nr, nc) : undefined;
        const c = geo?.walkable ? geo.walkable(nr, nc) : undefined;
        if (f === false) continue;
        if (f === undefined && c === false) continue;
        // BODY CHECK: never ENTER a sub-body-width crack (fine-open but
        // radius-embedded). Leaving one is always allowed (exit anywhere).
        if (isEmbedded(geo, myProtoX, myProtoY) !== true
            && isEmbedded(geo, nc * KOD_FINENESS + HALF, nr * KOD_FINENESS + HALF) === true) continue;
        // NEVER ENTER A VOID (same rule as the waypoint branch above).
        if (!startIsVoid) {
          const destSqC1 = this.destProto ? Math.floor(this.destProto.x / KOD_FINENESS) : null;
          const destSqR1 = this.destProto ? Math.floor(this.destProto.y / KOD_FINENESS) : null;
          const isExitDest1 = this._destIsStandOn === true && nc === destSqC1 && nr === destSqR1;
          if (!isExitDest1 && (transitBanned(geo, nr, nc) === true
              || regionCornerBanned(geo, nr, nc, this._wantRoom))) continue;
        }
        stepCol = nc; stepRow = nr;
        break;
      }
      if (stepCol == null) {
        // No fine-reachable neighbor. Initiate the verified raw-move fan (server-confirmed
        // escape) before declaring blocked — see the waypoint branch for the rationale.
        this.stuckTicks++;
        if (this._fanIndex == null && this._fanTarget == null && this.stuckTicks >= 3) {
          this._fanIndex = 0;
          this._fanFrom = { x: protocolToClient(myProtoX), y: protocolToClient(myProtoY) };
          return { state: 'raw-move', fanIndex: 0, why: 'verified escape fan (no-path fallback)' };
        }
        return { state: 'blocked', why: 'no walkable neighbor toward dest' };
      }
      const stepProtoX = stepCol * KOD_FINENESS + HALF, stepProtoY = stepRow * KOD_FINENESS + HALF;
      // The server position is the room object's col/row (what the server last
      // confirmed). The local position (selfPos.x) leads it. The gate compares the
      // step against the server position — the step is always ahead of the server.
      const serverPX = curCol * KOD_FINENESS + HALF;
      const serverPY = curRow * KOD_FINENESS + HALF;
      if (this._movementGateOk(stepProtoX, stepProtoY, myProtoX, myProtoY, serverPX, serverPY)) {
        // PHASE 1: un-gate from session.walkTo. The Mover has already validated
        // this step against the fine model (the gate check above). Sending the
        // raw moveTo directly means the shared geometry's floor check
        // ("goal square has no floor") no longer gates our movement. The server
        // accepts the declared position (server_validate=false for user moves).
        if (this._claimMoveSlot()) Promise.resolve(s.client.moveTo(stepProtoX, stepProtoY, 18, s.client.room?.id ?? 0)).catch(() => {});
        this._recordSend(this.destProto.x, this.destProto.y, myProtoX, myProtoY, stepProtoX, stepProtoY, 'raw-move-push');
        this._recordReport(stepProtoX, stepProtoY);
        this._noteServerStatic(curCol, curRow);
      }
      return { state: 'moving', to: { col: stepCol, row: stepRow } };
    }

    const dx = wp.x - myProtoX;
    const dy = wp.y - myProtoY;
    const dist = Math.hypot(dx, dy);
    if (dist < KOD_FINENESS) {
      this.pathIdx++;
      if (this.pathIdx >= this.path.length) {
        // Past all waypoints: go to destination directly. Final arrival on
        // the COMMITMENT point (see tick-top); the outer waypoint advance
        // above stays sim-optimistic for flow (it commits nothing).
        const dd = Math.hypot(this.destProto.x - cmtX, this.destProto.y - cmtY);
        if (dd < KOD_FINENESS * 0.5) {
          this.clear();
          return { state: 'arrived', position: { col: effMe.col, row: effMe.row } };
        }
        this._sendWaypoint(this.destProto.x, this.destProto.y, c, s, me);
        return { state: 'moving', to: { x: Math.round(this.destProto.x), y: Math.round(this.destProto.y) } };
      }
      // Send the next waypoint — unless the route ahead is clear for further than a square,
      // in which case this branch is the WRONG BRANCH AND MUST NOT RUN.
      //
      // This is the ordering finding, and it is what the fleet's rate actually turned on. This
      // branch owned every tick after the first and sent exactly one square per packet — 1.00
      // squares per packet, 40% of the reference client — and the velocity declaration below it
      // never executed because this branch returns first. Which engine is correct was never
      // the question; which branch is REACHED was, and the answer was always this one.
      //
      // It cannot simply be deleted: with it disabled two assertions fail with 'never arrives',
      // because it also owns waypoint consumption and arrival. And it must not be made to send
      // `ahead` directly — an earlier attempt did that and measured 1.50 squares per packet,
      // which is a FALSE RESULT even though the number moved. `_sendWaypoint` declares the
      // destination we are HEADING FOR; the reference client declares the position it has
      // REACHED (move.c MoveUpdatePosition sends player.x/player.y, its own integrated
      // position). Those are different packets with different meanings, and a far waypoint sent
      // as a position is a claim about where we are that we have not earned. The integration is
      // what earns it. So this branch steps a square, and strides are left to the branch that
      // integrates them.
      // WHEN THE ROUTE AHEAD IS CLEAR BEYOND ONE SQUARE, THIS BRANCH TAKES THE TICK AND MUST
      // NOT SPEND IT. It is the ordering finding, and it is what the fleet's rate turned on.
      //
      // This branch owned every tick after the first and sent exactly one square per packet —
      // 1.00 squares per packet, 40% of the reference client — while the velocity declaration
      // 180 lines below it never executed, because this branch returns. Which engine is
      // correct was never the question; which branch is REACHED was, and the answer was always
      // this one. That is also why a committed measurement tool reported both engines at 1.00:
      // it was observing the same branch twice.
      //
      // Two wrong fixes were tried and rejected before this one:
      //   * Deleting it. Two assertions then fail with 'never arrives', because this branch
      //     also owns waypoint consumption and arrival. It is necessary.
      //   * Making it send `ahead` via _sendWaypoint. That measured 1.50 squares per packet —
      //     a moved number and a FALSE result. `_sendWaypoint` declares the destination we are
      //     heading FOR; the reference client declares the position it has REACHED (move.c
      //     MoveUpdatePosition sends its own integrated player.x/player.y). A far waypoint sent
      //     as a position is a claim about where we are that we have not earned, and the
      //     integration is what earns it.
      //
      // So: aim at the far heading, and let control fall through to the branch that
      // integrates. `aimX`/`aimY` are what the declaration below reads, and it still runs the
      // geometry before sending anything — the fall-through buys rate, never permission.
      if (ahead && Math.hypot(ahead.x - myProtoX, ahead.y - myProtoY) > KOD_FINENESS) {
        // Fall through: the declaration below integrates this heading and sends the position
        // it stopped at. See the note above for why stepping a far waypoint is not a stride.
      } else {
      const nextWp = this.path[this.pathIdx];
      if (nextWp) {
        this._sendWaypoint(nextWp.x, nextWp.y, c, s, me);
        return { state: 'moving', to: { x: Math.round(nextWp.x), y: Math.round(nextWp.y) } };
      }
      return { state: 'moving' };
      }
    }

    // EN ROUTE TO WAYPOINT: walk one ADJACENT square at a
    // time, same as the GOAP driver's act.step(). Before
    // sending moveToSquare, CHECK the target square is
    // valid (standable on the coarse grid). If not, try
    // the next adjacent square. This prevents the
    // pacing-back-and-forth between valid and invalid. Candidate origin on
    // SERVER truth (see the tick-top note).
    // EN ROUTE TO WAYPOINT: candidate origin is the SIM (the live position),
    // not the stale server echo — same ping-pong fix as the no-path branch
    // above. Commitment (arrival, gate) stays on server truth.
    const myCol = Math.floor(myProtoX / KOD_FINENESS);
    const myRow = Math.floor(myProtoY / KOD_FINENESS);
    const geo = this.session?.world?.geometry;
    // Candidate squares: the 8 neighbors, ordered by
    // preference (WAYPOINT direction first, then cardinal,
    // then diagonal). The waypoint is the next A* path node,
    // NOT the final destination. Ordering by the final destination
    // makes the character walk toward walls instead of following
    // the path around them.
    const wpCol = Math.floor(wp.x / KOD_FINENESS);
    const wpRow = Math.floor(wp.y / KOD_FINENESS);
    const sdx = Math.sign(wpCol - myCol);
    const sdy = Math.sign(wpRow - myRow);
    const candidates = [];
    if (sdx !== 0) candidates.push([myCol + sdx, myRow]);
    if (sdy !== 0) candidates.push([myCol, myRow + sdy]);
    if (sdx !== 0 && sdy !== 0) candidates.push([myCol + sdx, myRow + sdy]);
    // Remaining cardinal and diagonal neighbors.
    for (const [dc2, dr2] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
      const nc = myCol + dc2, nr = myRow + dr2;
      if (!candidates.some(([c2, r2]) => c2 === nc && r2 === nr)) {
        candidates.push([nc, nr]);
      }
    }
    // Find the first candidate that is valid. Unvisited squares first
    // (loop avoidance — see above); never exclude, dead ends backtrack.
    // Same stuck-gating as the waypoint branch: straight while moving.
    let stepCol = null, stepRow = null;
    const refusedKeys = this._refusedKeys();
    const ordered1 = orderCandidates(candidates, this._recentSteps, this.stuckTicks,
      { meCol: myCol, meRow: myRow, goalCol: wpCol, goalRow: wpRow , refused: refusedKeys });
    // Log which candidates were filtered out by orderCandidates, tagged by WHICH filter
    if (process.env.M59_MOVER_TRACE === '1') {
      const ox = myCol - Math.sign(wpCol - myCol);
      const oy = myRow - Math.sign(wpRow - myRow);
      const filtered = candidates.filter(([cc, rr]) => !ordered1.some(([c2, r2]) => c2 === cc && r2 === rr));
      if (filtered.length) {
        const tagged = filtered.map(([c, r]) => {
          const tags = [];
          if (refusedKeys.includes(c + ',' + r)) tags.push('refused');
          if (this.stuckTicks < 3 && c === ox && r === oy) tags.push('monster');
          if (this.stuckTicks >= 3 && this._recentSteps?.includes(c + ',' + r)) tags.push('taboo');
          return `${c},${r}:${tags.join('+') || 'unknown'}`;
        });
        console.error(`[candfilter] ${this.logName} me=(${myCol},${myRow}) wp=(${wpCol},${wpRow}) filtered=[${tagged.join(' ')}] refused=[${refusedKeys.join(' ')}] stuck=${this.stuckTicks} recent=[${(this._recentSteps ?? []).join(' ')}]`);
      }
    }
    // REFUSAL ACCOUNTING (motion-only diagnostics): when no candidate
    // survives, the log must say WHICH check walled us in — otherwise
    // "stuck" is a mystery and we can't tell a real wall from an
    // over-strict validator. Counted by first-failing check, logged once
    // below when stepCol stays null.
    const rejects = { fine: 0, embedded: 0, edge: 0, void: 0 };
    const rejectLog = [];
    for (const [nc, nr] of ordered1) {
      // The FINE grid is the authoritative collision model. When the two
      // grids disagree (fine says walkable, coarse says not), trust the
      // FINE grid — the coarse grid is a 1-byte-per-square projection of
      // the BSP and can be wrong on ledge edges and diagonal walls. This
      // is the disagreement that stranded the character: the A* path (fine
      // model) went through a square the coarse grid flagged unwalkable,
      // and the one-square step validator rejected it, so the character
      // never moved. Accept if the fine grid says true, or if there is no
      // fine data (fall back to coarse). Reject only if the fine grid
      // explicitly says false (or no fine data and coarse says false).
      // A geometry with no cell grids at all (test fixtures) accepts
      // everything, matching the old behavior.
      const f = geo?.fineWalkable ? geo.fineWalkable(nr, nc) : undefined;
      const s = geo?.standable ? geo.standable(nr, nc) : undefined;
      if (f === false) { rejects.fine++; rejectLog.push(`${nc},${nr}:fine`); continue; }       // fine says blocked
      // BODY CHECK (same rule as the no-path branch): never enter a crack.
      if (isEmbedded(geo, myProtoX, myProtoY) !== true
          && isEmbedded(geo, nc * KOD_FINENESS + HALF, nr * KOD_FINENESS + HALF) === true) { rejects.embedded++; rejectLog.push(`${nc},${nr}:embedded`); continue; }
      // THE EDGE, NOT JUST THE SQUARE. A neighbor can be fine-walkable as a
      // SQUARE while the EDGE from where we stand to it is walled (a wall
      // segment between the two squares' centres). Check with a radius-free
      // trace (playerRadius: 1) + small lateral offsets — detects real walls
      // without the false positives of full-radius standPoint traces (which
      // fail when the stand point sits on a wall line, e.g. the Raza fence
      // running along row 11's centre). The mover handles fine positioning
      // via sliding; the step search only needs to know "no wall on this edge".
      if (geo?.traceFineMoveClient && geo?.standPoint) {
        let a = geo.standPoint(myRow, myCol);
        let b = geo.standPoint(nr, nc);
        if (!a) a = { x: (myCol-1)*1024+512, y: (myRow-1)*1024+512 };
        if (!b) b = { x: (nc-1)*1024+512, y: (nr-1)*1024+512 };
        const dx = b.x-a.x, dy = b.y-a.y;
        const len = Math.hypot(dx,dy)||1;
        const px = -dy/len, py = dx/len;
        const tryT = (ox,oy) => geo.traceFineMoveClient(a.x+ox,a.y+oy,b.x+ox,b.y+oy,{slide:false,playerRadius:1}).arrived===true;
        if (!tryT(0,0) && !tryT(px*128,py*128) && !tryT(-px*128,-py*128)
            && !tryT(px*256,py*256) && !tryT(-px*256,-py*256)) { rejects.edge++; rejectLog.push(`${nc},${nr}:edge`); continue; }
      }
      // NEVER ENTER A VOID: from a grounded start, reject neighbors with no
      // BSP floor (the deliberate stand_on exit square itself is exempt). A
      // dumb server accepts any declared position, so the check must live here.
      if (!startIsVoid) {
        const destSqC0 = this.destProto ? Math.floor(this.destProto.x / KOD_FINENESS) : null;
        const destSqR0 = this.destProto ? Math.floor(this.destProto.y / KOD_FINENESS) : null;
        const isExitDest0 = this._destIsStandOn === true && nc === destSqC0 && nr === destSqR0;
        if (!isExitDest0 && (transitBanned(geo, nr, nc) === true
            || regionCornerBanned(geo, nr, nc, this._wantRoom))) { rejects.void++; rejectLog.push(`${nc},${nr}:void`); continue; }
      }
      if (f === true) { stepCol = nc; stepRow = nr; break; }  // fine says ok
      if (f === undefined && s === false) { rejectLog.push(`${nc},${nr}:coarse`); continue; }   // no fine data, coarse blocked
      stepCol = nc; stepRow = nr; break;              // fine ok, or no data
    }
    if (stepCol != null && process.env.M59_MOVER_TRACE === '1' && rejectLog.length)
      console.error(`[steptrace] ${this.logName} me=(${myCol},${myRow}) wp=(${wpCol},${wpRow}) step=(${stepCol},${stepRow}) stuck=${this.stuckTicks} ordered=[${ordered1.map(([c, r]) => `${c},${r}`).join(' ')}] rejected=[${rejectLog.join(' ')}] recent=[${(this._recentSteps ?? []).join(' ')}]`);
    if (stepCol == null) {
      // Name the wall: which check rejected all 8 neighbors.
      if (process.env.M59_MOVER_TRACE === '1')
        console.error(`[movestuck] ${this.logName} me=(${myCol},${myRow}) srv=(${curCol},${curRow}) wp=(${wpCol},${wpRow}) stuck=${this.stuckTicks} ordered=[${ordered1.map(([c, r]) => `${c},${r}`).join(' ')}] rejects=${JSON.stringify(rejects)} rejected=[${rejectLog.join(' ')}] refused=[${refusedKeys.join(' ')}]`);
      // No fine-reachable neighbor: the fine model has walled us in. The server
      // does not check geometry for players, but UtilGoNearSquare lands the
      // character on a nearby legal square — if there is no legal square nearby,
      // the character stays put. A fine-wall here may be a model mismatch (the
      // Raza Blacksmith traps a character exactly this way: every fine step is
      // blocked, but the server lands the character on the same square). Do NOT
      // jump straight to a blind blink. Instead initiate the VERIFIED raw-move
      // FAN: it fires one raw move per tick in 8 directions, and the
      // position-change check (FAN PROGRESS above) only commits if the SERVER
      // actually moved us. If a direction lands on a new square we walk out;
      // if all 8 land on the same square the fan falls back to blink.
      this.stuckTicks++;
      if (this._fanIndex == null && this._fanTarget == null && this.stuckTicks >= 3) {
        this._fanIndex = 0;
        this._fanFrom = { x: protocolToClient(myProtoX), y: protocolToClient(myProtoY) };
        return { state: 'raw-move', fanIndex: 0, why: 'verified escape fan: no fine step, trying server-confirmed raw moves' };
      }
      if (this._fanIndex == null && this._fanTarget == null) {
        return { state: 'stuck', why: 'no valid adjacent square' };
      }
      return { state: 'stuck', why: 'no valid adjacent square' };
    }
    // ==========================================================================
    // THE VELOCITY DECLARATION (restored from 2d44a48^, with its defect fixed).
    //
    // Commit 2d44a48 deleted this and kept the step engine, on the reasoning that the velocity
    // declaration "never arrives" while the step engine arrives in 11 sends. That reasoning
    // mistook a broken implementation for a wrong model, and docs/TICK-MOVEMENT-PLAN.md now
    // carries the retraction. The measurement that shows why: against the live server, the step
    // engine declares 1.371 squares per send (substrate/keeper-t1.log, 244,042 sends), where a
    // legal walk stride is 2.5 — and 15.3% of those sends declare the square the character is
    // ALREADY in. It is not a slower version of the same thing, it is a mover spending a sixth
    // of its packets standing still.
    //
    // WHAT THE ORIGINAL DEFECT ACTUALLY WAS. Not the model — one line:
    //
    //   if (!beelineClear(w.x, w.y)) { cornerAim = lastClear >= 0 ? this.path[lastClear] : null; break; }
    //
    // When the FIRST waypoint's beeline was blocked, `lastClear` was -1, so `cornerAim` was
    // null, so the aim stayed whatever the code had before the loop: the destination direction
    // projected forward by a full stride. That point is inside the wall. The declaration then
    // sent it, the server accepted it (client-authoritative: room.kod's own comment is "already
    // been checked by client (HAHA!)"), the character materialised past the wall or rubber-
    // banded, the escape fan fired, and because the aim was a pure function of a position that
    // never changed, the fan fired again forever. That is the t3 freeze.
    //
    // THE FIX IS NOT A CLAMP ADDED TO THE AIM. It is that the aim is no longer computed by
    // projection at all. `_integrateToward` walks the heading in sub-steps and RETURNS THE
    // POSITION WHERE IT STOPPED, which is the same shape as move.c: sub-step, check, and on
    // MOVE_BLOCKED `x = last_x; y = last_y; break` (move.c:374-382), then report `player.x`
    // (move.c:764). A position inside a wall is never constructed, so there is nothing for a
    // guard to catch. The difference from the deleted code is that the aim is now an
    // OBSERVATION of an integration instead of an assertion about a straight line.
    //
    // WHY THIS IS FASTER AND NOT MERELY SAFER: the step engine's unit of progress is a square
    // centre, which is 64 protocol units. The declaration's unit of progress is the stride the
    // character can actually cover in the elapsed time — 160 walking, 320 running — and it
    // takes the full stride whenever the integration clears it. Same packets, 2.5x the ground.
    // ==========================================================================
    {
      const geo = this.session?.world?.geometry;

      // The heading: toward the current waypoint if a path exists, else the destination. The
      // stride is what the elapsed time buys at the current gait, so the declaration cannot
      // outrun the clock and trip the speedhack counter (user.kod: +1 per packet, -1 per
      // second, threshold 2).
      const speed = runNow ? 36 : 18;
      const moved = this._integrateToward(geo, myProtoX, myProtoY, aimX, aimY, strideNow, {
        // move.c:266-268. dt is the elapsed time since the last report, capped at one
        // MOVE_INTERVAL so a stalled tick cannot buy a longer stride than a second of walking
        // is worth. Without the cap, a 10s stall would integrate 10 seconds of movement and
        // declare a teleport — legal by the letter of the trace, and exactly the sort of
        // position the server would rubber-band.
        dt: Math.min(MOVE_INTERVAL_MS, Math.max(100, Date.now() - this._lastReportAt)),
        numSteps: STEPS_PER_MOVE,
        // RADIUS-FREE, deliberately, and this is the one place the choice is load-bearing in
        // both directions. At the full player radius (32) the trace clips any wall within a
        // player-width and refuses headings the stepmask accepts, which on open ground beside
        // a wall leaves the character with nowhere to go. At radius 1 the trace reports the
        // wall itself, which is what the integration needs to stop AT rather than avoid.
        playerRadius: PLAYER_WALL_CLEARANCE_CLIENT_UNITS,
      });
      // A stride that integrates to nothing means the heading is walled in at the character's
      // own feet. Declaring the character's own position is not movement, and the deleted
      // version did exactly that 3,443 times in one session (substrate/keeper-t3.log: the aim
      // equalled the mover's position on 2,653 + 790 sends and the run never arrived). Fall
      // through to the step engine and the escape fan, which are the machinery for that case.
      if (moved.moved >= MOVE_THRESHOLD_PROTO) {
        const vServerPX = curCol * KOD_FINENESS + HALF, vServerPY = curRow * KOD_FINENESS + HALF;
        if (this._movementGateOk(moved.x, moved.y, myProtoX, myProtoY, vServerPX, vServerPY)) {
          // ROUNDED BACKWARD, ON PURPOSE, AND THIS IS NOT A COSMETIC CHOICE.
          //
          // The integration stops one client unit short of a wall — which is correct, and
          // better than the reference client's own 12.8 — and the wire carries protocol
          // integers, so the position has to be rounded to be sent. Rounding to nearest turns
          // 7167.0 into 512, which converts back to 7168: the one coordinate on the far side of
          // the line the trace calls blocked. The integration was right and the declaration was
          // wrong, by a rounding rule, in a room with a wall in it.
          //
          // So round toward where we CAME FROM. The direction of "backward" is the heading we
          // were integrating along, which is always known, and it is always the legal side
          // because the integration's start position is legal by construction. This is the same
          // instinct as move.c's `x = last_x` at a coarser level: when in doubt, the position
          // you are allowed to be at is the one you were just at.
          const back = this._roundBackward(moved, { x: aimX, y: aimY });
          this._submitMove(s, c, () => c.moveTo(back.x, back.y, speed, c.room?.id ?? 0));
          if (process.env.M59_MOVE_DEBUG !== '0')
            try { console.error(`[movedbg] ${this.logName} vel-tick declare=(${Math.round(moved.x)},${Math.round(moved.y)}) ground=${moved.moved.toFixed(0)} stopped=${moved.stopped ?? 'clear'} run=${runNow} stride=${strideNow} idx=${this.path ? this.pathIdx + '/' + this.path.length : 'null'} me=(${me.col},${me.row}) srv=(${curCol},${curRow}) srvXY=(${Math.round(this._serverPos?.x ?? -1)},${Math.round(this._serverPos?.y ?? -1)}) prevDecl=(${Math.round(this._lastDeclX ?? -1)},${Math.round(this._lastDeclY ?? -1)})`); } catch {}
          this._lastDeclX = back.x; this._lastDeclY = back.y;
          // THE SERVER'S RAW POSITION, FOR THE ONE MEASUREMENT THAT SETTLES THE MOVEMENT MODEL.
          // Every claim in this file about how far the server moves per accepted packet has been
          // an assumption, because the log only ever carried the server's position to SQUARE
          // precision — and a 160-unit acceptance and a 64-unit step both land in a neighbouring
          // square, so the two models were indistinguishable in the evidence. The whole
          // step-vs-velocity argument has therefore been conducted without the fact that decides
          // it. This records it.
          this._serverPos = this.session?._pose?.server ?? null;
          this._recordSend(aimX, aimY, myProtoX, myProtoY, back.x, back.y, 'stride-declaration');
          // SIM ADVANCE DIAGNOSTIC — read-only, prints what the Pose believes before and
          // after the report that is supposed to move it. Added because `me=(30,38)` was
          // logged on four consecutive sends while the declaration moved 320 units each
          // time, which is what a character that is NOT advancing looks like. Four theories
          // (the adopt, the divergence guard, a missing advance() call, a wrong `me`) were
          // each REFUTED by testing the Pose in isolation, where the sim advances and
          // survives. That makes this a question about the running object, not the code, and
          // the only way to answer it is to look at the running object.
          if (process.env.M59_SIM_TRACE === '1') {
            const _b = this.session?._pose?.sim;
            const _c = p => p ? `(${Math.round(p.x)},${Math.round(p.y)})` : 'null';
            // Print BEFORE the report, then re-print from a microtask after it, so the
            // normal _recordReport below stays the only thing that mutates the track.
            this._simTraceBefore = _c(_b);
            this._simTraceLine = `[sim-trace] ${this.logName} declared=(${Math.round(back.x)},${Math.round(back.y)}) integration=(${Math.round(moved.x)},${Math.round(moved.y)}) simBefore=${this._simTraceBefore}`;
          }
          this._recordReport(moved.x, moved.y);
          // A stride stopped by a wall is not progress made, and stuckTicks is the counter
          // that decides whether the escape fan engages. Counting a walled stride as progress
          // is how a mover sits in a corner forever believing it is on its way.
          if (moved.stopped) this.stuckTicks++; else this._noteServerStatic(-1, -1);
        }
        return { state: 'moving', velocity: true, speed, stopped: moved.stopped };
      }
      // A STRIDE THAT INTEGRATES TO NOTHING IS STUCK, NOT 'MOVING'.
      //
      // This used to increment stuckTicks and RETURN `state: 'moving'`. That is a deadlock, and
      // it is what the live fleet was actually doing: keeper-t3.log after the restart shows
      // `plan from=(12,3) dest=8,2 found=true wp=1` on 2,180 consecutive ticks, sends=0, and
      // stuck=1747 climbing with no ceiling. The mover was reporting that it was moving while
      // putting nothing on the wire, and because it returned, it never reached the escape fan
      // below — the fan being the only thing in this file that knows how to leave a pocket.
      //
      // The step engine never reached this line, because a step always had somewhere to go: it
      // named an adjacent square and declared its centre without asking the geometry. The
      // integration can legitimately return zero — the character is in a corner where every
      // heading is walled within a stride — and that is precisely the situation the escape fan
      // was written for. Falling through is the whole point of having one.
      //
      // `stuckTicks` is kept and incremented: it is the counter the fan's own engagement reads,
      // and zeroing it here would mean a character in a pocket never accumulates the three ticks
      // the fan asks for.
      this.stuckTicks++;
      // Deliberately NO return. Fall through to the step search and the escape fan below.
    }

    // Walk to the valid adjacent square using the
    // validated mover (session.walkTo with steps: 1),
    // same as the GOAP driver's act.step(). This handles
    // diagonal walls and elevation changes that
    // moveToSquare cannot.
    // LAZY GATE: only send if the interval + threshold allow it (see the other fallback).
    const enrProtoX = stepCol * KOD_FINENESS + HALF, enrProtoY = stepRow * KOD_FINENESS + HALF;
    const serverPX2 = curCol * KOD_FINENESS + HALF;
    const serverPY2 = curRow * KOD_FINENESS + HALF;
    if (this._movementGateOk(enrProtoX, enrProtoY, myProtoX, myProtoY, serverPX2, serverPY2)) {
      // PHASE 1: un-gate from session.walkTo. Same rationale as the waypoint
      // branch — the step is fine-model-validated, send it raw.
      if (this._claimMoveSlot()) Promise.resolve(s.client.moveTo(enrProtoX, enrProtoY, 18, s.client.room?.id ?? 0))
        .then(() => { if (process.env.M59_MOVE_DEBUG !== '0')
          console.error(`[movedbg] ${this.logName} gateOK step=(${stepCol},${stepRow}) me=(${me.col},${me.row}) wp=(${wpCol},${wpRow}) idx=${this.pathIdx}/${this.path ? this.path.length : 'null'} stuck=${this.stuckTicks} srv=(${curCol},${curRow}) moveTo sent`); })
        .catch(e => { if (process.env.M59_MOVE_DEBUG !== '0')
          console.error(`[movedbg] ${this.logName} gateOK step=(${stepCol},${stepRow}) ERR ${e.message}`); });
      this._recordSend(this.destProto.x, this.destProto.y, myProtoX, myProtoY, enrProtoX, enrProtoY, 'waypoint-step');
      this._recordReport(enrProtoX, enrProtoY);

      // DID THE SERVER ACTUALLY REFUSE THIS STEP? Decided from the server's own position,
      // not from our model of the room.
      //
      // The test is that we declared the SAME square from the SAME square on consecutive
      // sends and the server put us nowhere else in between. One repeat proves nothing —
      // the server echoes with a delay and a legitimate 1000ms move has the character
      // mid-stride. Three consecutive identical declarations with no change in the server
      // position is not a delay: at a 1000ms cadence that is three seconds of asking for
      // the same square and being refused.
      //
      // Measured on the live shard, exactly this pattern ran for over twenty minutes:
      // n=746..749 declaring at=480,480 from srv=480,416, the server reporting two squares
      // total across eight minutes. The mover treated every refusal as a fresh plan and
      // re-chose the same step, because the bake rates that square walkable by every
      // predicate it has. It is not wrong about the geometry; it cannot see a body.
      if (this._lastDecl && this._lastDecl.to === stepCol + ',' + stepRow
          && this._lastDecl.from === curCol + ',' + curRow) {
        this._declRepeats = (this._declRepeats ?? 0) + 1;
        if (this._declRepeats >= 2) {
          this._noteRefusedStep(stepCol, stepRow, curCol, curRow);
          if (process.env.M59_MOVE_DEBUG !== '0') {
            const _refCount = this._refusedSteps?.size ?? 0;
            const _refKey = this._refusedSteps?.keys?.().next?.()?.value ?? 'none';
            console.error(`[step-refused] ${this.logName} server will not enter (${stepCol},${stepRow})`
              + ` from (${curCol},${curRow}) after ${this._declRepeats + 1} identical declares`
              + ` — bake says fine=${geo?.fineWalkable?.(curRow + 1, stepCol + 1)}`
              + ` coarse=${geo?.walkable?.(curRow + 1, stepCol + 1)}`
              + `; excluded=${_refCount} first=${_refKey}`
              + `; excluding it for ${Math.round(REFUSED_STEP_TTL_MS / 1000)}s and routing around`);
          }
          this._declRepeats = 0;
          // DROP THE PATH. Three identical declares with no server
          // movement is evidence of a real entry refusal (obstruction,
          // a body in a doorway). The path was computed through this
          // square; now that the square is known-unsafe the path is
          // stale. Re-plan from where the server actually has us.
          this.path = null;
          this.pathIdx = 0;
          this._lastWpKey = null;
        }
      } else {
        this._declRepeats = 0;
      }
      this._lastDecl = { to: stepCol + ',' + stepRow, from: curCol + ',' + curRow };
      this._noteServerStatic(curCol, curRow);
    } else {
      if (process.env.M59_MOVE_DEBUG !== '0')
        console.error(`[movedbg-gate] ${this.logName} gateCLOSED step=(${stepCol},${stepRow}) me=(${me.col},${me.row}) server=(${myProtoX},${myProtoY}) lastReport=(${this._lastReportX},${this._lastReportY}) interval=${Date.now()-this._lastReportAt}ms`);
    }
    // STUCK SIGNAL HONESTY: _noteServerStatic above (server squares) is the
    // SOLE maintainer of stuckTicks/lastPos. The old me-based check compared
    // against the sim — which advances on every SEND by construction — so it
    // zeroed the static signal on every send tick and stuckTicks could never
    // exceed 1 while sends flowed: fake 'moving' with a frozen server (the
    // 556/382 walk-in-place, watched for hours; mover-hb stuck=0).
    // SERVER-STATIC ESCALATION: the echo lags ~1s, so 1-2 static ticks are
    // healthy. 5+ static sends means the server is refusing us while the sim
    // runs ahead planning from phantom squares. Re-anchor planning to the
    // server and report stuck — no fan, no blink (motion-only: recovery is
    // parked; the failure must be visible, not papered over).
    if (this.stuckTicks >= 5) {
      const _lastMoved = this.session?._pose?.lastMovedAt ?? 0;
      const _lastMovedAge = _lastMoved > 0 ? Date.now() - _lastMoved : Infinity;
      if (process.env.M59_MOVER_TRACE === '1')
        console.error(`[movestuck] ${this.logName} server static x${this.stuckTicks} sends at srv=(${curCol},${curRow}) sim=(${myCol},${myRow}) lastMovedAge=${_lastMovedAge === Infinity ? 'none' : _lastMovedAge + 'ms'} — ${_lastMovedAge > 8000 ? 're-anchoring sim to server' : 'holding (path kept, position unchanged <8s)'}`);
      if (_lastMovedAge > 8000) {
        this._simX = null; this._simY = null; this._simAt = 0;
        try { this.session?._pose?.reset(); } catch {}
        this.path = null; this.pathIdx = 0;
        this._lastWpKey = null;
        this._fanIndex = null; this._fanTarget = null; this._fanFrom = null;
        return { state: 'stuck', why: `server static across ${this.stuckTicks} sends — sim re-anchored to server` };
      }
      // Path kept: position unchanged <8s, likely a slow echo. Report stuck but don't destroy the route.
      return { state: 'stuck', why: `server static across ${this.stuckTicks} sends — holding (position unchanged <8s)` };
    }
    return { state: 'moving', to: { col: stepCol, row: stepRow } };
  }

  /**
   * Send a waypoint to the server. The server moves the
   * character at speed 18 toward (protoX, protoY). We only
   * re-send when the waypoint changes, so the character
   * walks smoothly without per-tick corrections.
   */
  // LAZY POSITION REPORT (the client's MoveUpdateServer model, move.c:739).
  // The client moves locally and only tells the server its position when (a) >= 1000ms
  // since the last position packet AND (b) it moved more than FINENESS/4. We were sending
  // a moveTo every tick (10/s) which tripped the server's 5/s throttle. This is the gate
  // that drops movement production to ~1/s, like a human holding a key.
  //
  // Shared by every per-tick movement send (waypoint moveTo AND the walkTo fallbacks), so
  // NO movement path can flood the pacer. Returns true if a movement packet may be sent
  // this tick; the caller sends and then records the report via _recordReport.
  //
  // The gate compares the STEP against the SERVER POSITION (serverX/Y), not against the
  // last-SENT position. This is the client's server_x model: report when you've moved far
  // enough PAST where the server thinks you are. If the server is stuck at (28,9) and the
  // step is (29,9), the step is always far enough past (28,9) (64 > threshold 16), so the
  // gate opens every interval and we re-send the step (holding the key) until the server
  // actually moves. The old bug compared the step against the last-SENT position: after
  // sending (29,9) we recorded _lastReport=(29,9), the next tick computed the same step
  // (29,9), the distance was 0, the gate stayed closed forever, and the character never
  // moved. Comparing against the server position fixes that.
  // The gate compares the CURRENT POSITION against the last reported position
  // (the reference client's MoveUpdatePosition model, move.c:766): report when
  // the player's current x/y is far enough from server_x/server_y (the last
  // position WE sent), AND >= MOVE_INTERVAL since the last packet. The step
  // target is NOT the gate's concern — comparing the step against the last
  // report deadlocks when the step equals the last report (JayB at (29,8) with
  // _lastReport=(28,8) stepping to (28,8): dx=0, gate closed forever).
  //
  // protoX/protoY is kept in the signature for the caller's record step, but the
  // distance check uses myProtoX/myProtoY (the character's ACTUAL position).
  // A stale _lastReport (a gap > 1 square from the current position — a refused
  // move, a teleport, a respawn) is handled by the mover's re-plan, so no extra snap.
  _movementGateOk(protoX, protoY, myProtoX, myProtoY, serverX, serverY) {
    const now = Date.now();
    // The gate compares the STEP (protoX/protoY — where the character is heading)
    // against the SERVER POSITION (serverX/serverY — where the server last confirmed
    // the character is). This is the client's MoveUpdateServer model: report when
    // you've moved far enough PAST where the server thinks you are. The server
    // position lags the character, so the step is always "ahead" of it, and the gate
    // opens every interval. The old deadlock (step == lastReport) is impossible here
    // because serverX/Y is BEHIND the step (the server hasn't confirmed the character's
    // latest position yet). This is the version that worked; the current-position
    // variant deadlocked because at the start of a path the character is AT its
    // last-reported position (distance 0, gate closed, never moves).
    const refX = serverX ?? null;
    const refY = serverY ?? null;
    const dx = refX == null ? Infinity : (protoX - refX);
    const dy = refY == null ? Infinity : (protoY - refY);
    const moved2 = refX == null ? Infinity : (dx * dx + dy * dy);
    // >= (not >): single-step probes sit at exactly 16 units (256 = the
    // threshold squared). Strict > deadlocks the escape fan: it would spin
    // forever, gated closed, sending nothing.
    const movedEnough = moved2 >= MOVE_THRESHOLD_PROTO2;
    const intervalOk = (now - this._lastReportAt) >= (this.reportIntervalMs ?? MOVE_INTERVAL_MS);
    // FLOOR (anti-deadlock): never go longer than 5s without a send. When the
    // character sits <1 proto unit off square-center on the aim side, every
    // 16-unit probe lands within 16 of center and movedEnough stays false
    // forever — a stable fixed point (prod 0 with a live path). The floor
    // bounds any gating pathology to 0.2/s; the 1/s law still governs healthy
    // movement, so this cannot trip speedhack detection.
    const floorOk = (now - this._lastReportAt) > 5000;
    return (movedEnough && intervalOk) || floorOk;
  }
  _recordReport(protoX, protoY) {
    // Captured BEFORE the overwrite: the distance from the last declared position to this one is
    // the ground this packet bought, and Pose needs it to advance its own track by the same
    // amount. Reading it after the assignment would always give zero.
    const _prevX = this._lastReportX, _prevY = this._lastReportY;
    this._lastReportAt = Date.now();
    this._lastReportX = protoX;
    this._lastReportY = protoY;
    this._simX = protoX;
    this._simY = protoY;
    this._simAt = Date.now();
    // Keep the shared Pose in step with our own feet (single position truth).
    //
    // STEP = THE WHOLE DECLARED DISTANCE, AND THAT IS A SOURCE-READ, NOT A TUNING CHOICE.
    //
    // Pose.advance's default step is KOD_FINENESS — one square — which encodes a model of the
    // server that the reference client does not hold: that the server walks the character toward
    // a declared position at its own rate, so one accepted packet is worth one square of ground.
    // move.c:96 says otherwise in the client's own words: `server_x` is the
    // "Last position we've told server we are." Between corrections the server simply BELIEVES
    // what we declared; it is re-anchored only when the server tells us our position outright
    // (move.c:732, :810 — a room change or a correction), which is what Pose.updateServer is for.
    //
    // The consequence was measured, not guessed: with the one-square default, a mover that
    // declared two squares of ground believed it had moved one, so the next aim was computed from
    // a position a square BEHIND its own feet, the lookahead could never see past the second
    // waypoint, and the rate came out at 0.89 squares per packet — identical to the step engine.
    // That is how the restoration could be 'complete' and the fleet not one whit faster: the
    // engine was fixed and the position truth underneath it was still a step engine.
    const _step = (_prevX == null || _prevY == null)
      ? KOD_FINENESS
      : (Math.hypot(protoX - _prevX, protoY - _prevY) || KOD_FINENESS);
    try { this.session?._pose?.advance(protoX, protoY, _step); } catch {}
    // Completion of the SIM ADVANCE DIAGNOSTIC above: the "before" was captured at the
    // send site, the "after" is here, immediately after the only call that moves the track.
    if (process.env.M59_SIM_TRACE === '1' && this._simTraceLine) {
      const _a = this.session?._pose?.sim;
      const _c = p => p ? `(${Math.round(p.x)},${Math.round(p.y)})` : 'null';
      console.error(this._simTraceLine + ` simAfter=${_c(_a)}`);
      this._simTraceLine = null;
    }
    // LOCAL SIMULATION (official client model, move.c): our own feet are
    // authoritative between server echoes. Every send advances the sim to
    // the declared point; planning reads it while fresh (<2s) so waypoints
    // advance and fans progress without waiting ~1.2s per echo. After 2s
    // the sim expires and server truth resumes — refused sends (walls,
    // sitting) self-correct instead of drifting.
    // LOOP AVOIDANCE: remember recently-sent squares so the candidate
    // search can deprioritize them. The greedy stepper otherwise dithers
    // between two squares forever (east, back west, east…) in front of a
    // wall, which also trips the router's oscillation breaker. Cap 8.
    const key = Math.floor(protoX / KOD_FINENESS) + ',' + Math.floor(protoY / KOD_FINENESS);
    const seen = this._recentSteps ?? (this._recentSteps = []);
    const at = seen.indexOf(key);
    if (at !== -1) seen.splice(at, 1);
    seen.unshift(key);
    if (seen.length > 8) seen.length = 8;
  }

  // CENTRAL MOVE CAP (user.kod speedhack law). Every UserMove packet feeds
  // piMovesCounter (+1 per packet, -1 per server second, trip at >2 with a
  // snap-back). The per-site gates each allow ~1/s, but sites overlap (two
  // sites firing in one tick = 2 packets in one server second, sustained
  // overlap trips the counter every few seconds: accept-jump, snap back,
  // repeat). ALL position submits go through here: at most one per 1050ms
  // (5% under the server budget so the counter drains instead of ratcheting).
  // Drops, never queues — movement is latest-wins; the next tick re-fires.
// THE INTEGRATION THE CLIENT ACTUALLY RUNS, transcribed from clientd3d/move.c.
//
// WHY THIS EXISTS AS ITS OWN FUNCTION, AND WHY IT IS NOT A CLAMP ADDED TO A SEND SITE.
//
// The instinct when a mover is caught declaring positions inside walls is to add a check at
// each place that sends. There are eight send sites in this file, and that approach would
// have produced eight checks that all ask the same question of the same geometry — which is
// how the file already got into trouble: the escape fan's stride extension DOES validate,
// carefully, at `playerRadius: 1`, and it still emitted a position 1840 client units past a
// sealed wall. The validation was not missing. It was answering a different question than the
// one the send needed answered, and nothing downstream could tell.
//
// What the reference client has is not a clamp. It is an INTEGRATION, and the position it
// reports is a by-product of that integration rather than something chosen and then checked:
//
//   move.c:266  num_steps = max(1, min(STEPS_PER_MOVE, NUM_STEPS_PER_SECOND * dt / 1000))
//   move.c:268  xinc = dx / num_steps; yinc = dy / num_steps;
//   move.c:288  no floor under the sub-step      -> x = last_x; y = last_y; break;
//   move.c:374  MoveObjectAllowed == MOVE_BLOCKED -> x = last_x; y = last_y; break;
//   move.c:764  RequestMove(player.y, player.x, ...) — reports where the integration STOPPED.
//
// The illegal position is never constructed, so there is nothing to catch it. That is the
// difference between a guard and an invariant, and it is the whole reason this file now has
// one place that answers "where may we actually be?".
//
// THE ASYMMETRY THAT MATTERS: the reference client collides against the BSP, which sees every
// wall. Our geometry's fineWalkable (m59-roo.mjs:1573) tests a square by its CENTRE at radius
// 256, and walls lie on square BOUNDARIES — 512 from either centre — so the coarse layer is
// structurally blind to a whole class of wall. A mover that plans on that layer and then
// declares positions from it will walk through walls it cannot see, and the server, being
// client-authoritative, will BELIEVE it. The trace below is the BSP-shaped layer: it sees what
// fineWalkable cannot. Anything that declares a position must integrate through THIS, not
// merely be permitted by the other.
//
// Returns the furthest position along the line that the geometry's own trace will vouch for,
// in PROTOCOL units, plus how far it actually got. `distance` is the most the client could
// cover in the elapsed time at the current gait; the result is never further than that.
  // LOOK DOWN THE ROUTE: consume every waypoint this tick's stride can reach AND whose
  // beeline the geometry clears; return the farthest such waypoint as the heading.
  //
  // WHY A METHOD AND NOT A BLOCK INSIDE THE DECLARATION. tick() holds three engines in
  // sequence, each of which returns: a raw door push, a one-square step (its own comment:
  // 'walk one ADJACENT square at a time, same as the GOAP driver's act.step()'), and the
  // velocity declaration. This lookahead used to live inside the third one, BELOW the other
  // two, so from the second tick of any route onward the step branch ran first, returned, and
  // neither the lookahead nor the declaration executed. That is the whole explanation of a
  // committed measurement reporting 1.00 squares per packet for both engines, and of an
  // independent audit being unable to make any suite notice the declaration being switched
  // off: both were observing code that never ran. Restoring the declaration's source did not
  // restore its execution, because in this function execution is decided by ORDER. A shared
  // decision needs a shared helper placed above the things that share it.
  //
  // IT PICKS A HEADING AND APPROVES NOTHING. The caller still integrates. A lookahead that
  // could authorise a position would be the wall-declaration defect re-admitted through the
  // front door. The trace gate below is not there for safety — the integration would stop at
  // the wall anyway — it is there for CORRECTNESS: halting a heading at a wall is safe and
  // still wrong, and it spends the tick grinding a corner at the escape fan's speed instead
  // of aiming at the waypoint the route actually goes through.
  _routeAhead(geo, fromX, fromY, budget) {
    if (!this.path || this.pathIdx >= this.path.length) return null;
    let far = -1;
    for (let i = this.pathIdx; i < this.path.length; i++) {
      const w = this.path[i];
      // The path is ordered, so once one waypoint is out of stride none further can be in.
      if (Math.hypot(w.x - fromX, w.y - fromY) > budget) break;
      // A WAYPOINT WE ARE ALREADY AT IS NOT A HEADING.
      //
      // This is the pause, and it took a live character to see it. `far` started at -1 and
      // the loop began at `pathIdx`, which after any re-anchor IS the square the character
      // is standing in — distance 0, trivially inside budget, trivially unblocked. So the
      // lookahead happily returned the character's own position as its answer, the
      // integration bought 0.00 squares, `pathIdx` never advanced, and the next tick asked
      // the same question and got the same answer. Reproduced exactly, room 557, standing
      // on waypoint 0 of a path north:
      //
      //   _routeAhead(budget 320) -> (1632,1888)   <- that IS fromX,fromY
      //   _integrateToward        -> moved 0.00 squares
      //   pathIdx after           -> 0
      //
      // The server-confirmed walk rate was 1.48 squares/s against the client's 5, with
      // 47% of packets declaring a position identical to the one before. A stride aimed at
      // where we already are is not slow, it is nil, and it looks in the logs exactly like
      // a server that will not move us.
      //
      // Skip waypoints inside the square we occupy. Not `> 0`: the position is continuous
      // and a waypoint a few units away would be a heading of a few units, which the
      // integration would spend as nothing and the gate would still count as a send.
      // One square is the smallest displacement the server itself reports as a move.
      if (Math.abs(w.x - fromX) < KOD_FINENESS && Math.abs(w.y - fromY) < KOD_FINENESS) {
        if (far < 0 && i > this.pathIdx) this.pathIdx = i;   // consume it; it is behind us
        continue;
      }
      if (geo?.traceFineMoveClient) {
        try {
          const t = geo.traceFineMoveClient(
            protocolToClient(fromX), protocolToClient(fromY),
            protocolToClient(w.x), protocolToClient(w.y),
            { slide: false, playerRadius: PLAYER_WALL_CLEARANCE_CLIENT_UNITS });
          if (t && t.blocked === true && t.arrived !== true) break;
        } catch { break; }   // an unknown trace is not a licence to look further
      }
      far = i;
    }
    // NOTHING IN BUDGET IS AHEAD OF US. On a one-square path — a short hop, a final
    // approach — every waypoint is in our own square, and returning null here used to fall
    // through to `aim = myProto + stride * unit(aim)`, which is the bug this whole file is
    // about: a point the geometry never cleared. Letting the caller fall back to a raw
    // stride is how a character ends up inside a wall. So say null and let the caller use
    // the step path, which is short but legal.
    if (far < 0) return null;
    const last = this.path[far];

    // THE LEFTOVER HALF SQUARE, WHICH COST 20% OF THE FLEET'S SPEED ON EMPTY GROUND.
    //
    // The planner emits waypoints one square apart, and this function had to return one of
    // them. With a 160-unit (2.5 square) walk stride and 64-unit spacing, the furthest waypoint
    // that fits inside the budget is 128 units away — two squares. The remaining 32 units, half
    // a square, was thrown away EVERY PACKET because there was no waypoint to aim at out there.
    // Measured on flat, empty, wall-free ground — the case with no terrain excuse at all — the
    // mover declared 128 units per packet in steady state and ran at 1.75 squares/second against
    // the client's 2.5. Waypoint quantisation, not geometry, not the integration, not the server.
    //
    // The reference client does not have this problem because it does not aim at waypoints.
    // move.c:266 `UserMovePlayer` integrates a HEADING for the interval and move.c:764 reports
    // where it actually got to; the waypoints are a planning artefact we invented and were then
    // paying rent on. So the fix is to extend the aim down the same heading by the distance the
    // budget still allows, and let the integration decide whether it is legal: aim further, let
    // `_integrateToward` stop at the wall. Aiming short is the only way to lose ground that the
    // geometry never asked for.
    //
    // TWO GUARDS, BOTH LEARNED FROM A REGRESSION RATHER THAN FROM REASONING.
    //
    // (1) ONLY ALONG A STRAIGHT RUN. The heading extended is from..last. If a waypoint follows
    //     `last`, the route TURNS there, and extending past a turn point walks off the route —
    //     in the wall fixture it drove straight at the segment the mover had just routed around,
    //     and in the corner fixture it sailed east past a waypoint where the route turns north.
    //     The first version extended unconditionally and failed both. So: extend only when
    //     `last` is the FINAL waypoint in budget, where there is demonstrably no turn to miss.
    //     A corner costs half a square; a corner cut costs the run.
    //
    // (2) ONLY OVER GROUND THE TRACE VOUCHES FOR. The loop traced the line to `last`, never
    //     PAST it, and the extension is by construction the unexamined remainder. Trace it, and
    //     accept only a result that is not a refusal. `pathIdx` is advanced AFTER the aim is
    //     final: spending waypoints while the aim was still in question charged the route for
    //     ground we then refused to walk to.
    //
    // (3) NEVER PAST THE GOAL. On a short hop the last waypoint in budget IS the destination, and
    //     extending the budget beyond it aims at ground we were never asked to walk to. The first
    //     version did, the next tick came back, and a monotonicity test caught the round trip:
    //     736 units of ground sent, 416 of it forward. A stride that overshoots is not fast, it is
    //     lost. So the extension is capped at the final waypoint, which on a straight run is the
    //     destination itself.
    // (1) ONLY PAST A STRAIGHT CONTINUATION, NEVER PAST A TURN. The heading extended is
    //     from..last. If the route CHANGES DIRECTION at `last`, extending past it walks off the
    //     route — in the wall fixture it drove straight at the segment the mover had just routed
    //     around, and in the corner fixture it sailed east past a waypoint where the route turns
    //     north. The first version extended unconditionally and failed both.
    //
    //     The first correction to that — extend only when `last` is the last waypoint in the
    //     route — was too broad in the other direction and bought nothing: the planner emits one
    //     waypoint per square, so on a 30-square road the final waypoint is reached on hop 30 and
    //     the extension never fires. Measured: still 1.75 squares/second, unchanged. A guard that
    //     only permits the last hop of a straight road is not a guard, it is a disabled feature.
    //
    //     So the test is geometric, not positional: is the next leg a continuation of this one?
    //     Waypoints one square apart on a straight run are collinear and extend freely; a corner
    //     is a direction change and stops the extension dead. A corner costs half a square; a
    //     corner cut costs the run.
    const _dx = last.x - fromX, _dy = last.y - fromY;
    const _dl = Math.hypot(_dx, _dy);
    let aim = last;
    let straight_run = far + 1 >= this.path.length;
    if (!straight_run && far + 1 < this.path.length) {
      // Cosine of the turn at `last`. Collinear legs give 1; a 90-degree corner gives 0. The
      // tolerance admits the shallow kinks a grid path makes without ever admitting a corner:
      // cos 60 degrees = 0.5, so this extends only when the heading moves by less than 60 degrees.
      const nx = this.path[far + 1];
      const bx = nx.x - last.x, by = nx.y - last.y;
      const bl = Math.hypot(bx, by);
      if (bl > 0 && _dl > 0) {
        straight_run = (_dx * bx + _dy * by) / (_dl * bl) > 0.5;
      }
    }
    if (_dl > 0 && straight_run) {
      const _goal = this.path[this.path.length - 1];
      const _to_goal = Math.hypot(_goal.x - fromX, _goal.y - fromY);
      const _spare = Math.min(budget, _to_goal) - _dl;
      if (_spare > 0 && geo?.traceFineMoveClient) {
        const _ex = last.x + (_dx / _dl) * _spare;
        const _ey = last.y + (_dy / _dl) * _spare;
        try {
          const t = geo.traceFineMoveClient(
            protocolToClient(fromX), protocolToClient(fromY),
            protocolToClient(_ex), protocolToClient(_ey),
            { slide: false, playerRadius: PLAYER_WALL_CLEARANCE_CLIENT_UNITS });
          if (!(t && t.blocked === true && t.arrived !== true)) aim = { x: _ex, y: _ey };
        } catch {
          // An unvouched-for extension is not taken. Falling back costs the half square;
          // it does not cost the wall.
        }
      }
    }
    // Spend the waypoints strictly BEFORE the aim: the aim's own square is not reached until
    // the character is in it, and spending it early makes the next tick aim past the corner
    // it has not yet turned.
    if (far > this.pathIdx) this.pathIdx = far;
    return aim;
  }

  _integrateToward(geo, fromProtoX, fromProtoY, toProtoX, toProtoY, distance, {
    // move.c:52-53. 200 sub-steps per second, capped at 20 per move, so a 100ms tick walks
    // 256 client units in 20 sub-steps of 12.8. The cap is the point: sub-steps exist so a
    // thin wall cannot be stepped OVER, and a count derived from the distance would stretch
    // with it, which is exactly how a long declaration escapes a short obstacle.
    dt = 100, numSteps = 20, playerRadius = PLAYER_WALL_CLEARANCE_CLIENT_UNITS,
  } = {}) {
    const raw = Math.hypot(toProtoX - fromProtoX, toProtoY - fromProtoY);
    if (raw < 1e-9 || distance <= 0) return { x: fromProtoX, y: fromProtoY, moved: 0, stopped: null };
    const travel = Math.min(distance, raw);
    const steps = Math.max(1, Math.min(numSteps, Math.floor(NUM_STEPS_PER_SECOND * dt / 1000)));
    const ux = (toProtoX - fromProtoX) / raw, uy = (toProtoY - fromProtoY) / raw;
    let lastX = fromProtoX, lastY = fromProtoY;
    for (let i = 0; i < steps; i++) {
      const nx = lastX + ux * travel / steps, ny = lastY + uy * travel / steps;
      // move.c:288-296 — no floor under the sub-step. Asked of the square the sub-step lands
      // in, because that is the only floor question our geometry can answer; the BSP-shaped
      // trace below carries the finer part of the same law.
      if (geo?.fineWalkable) {
        const c = Math.floor(clientToProtocol(nx) / KOD_FINENESS), r = Math.floor(clientToProtocol(ny) / KOD_FINENESS);
        if (geo.fineWalkable(r, c) === false) return { x: lastX, y: lastY, moved: Math.hypot(lastX - fromProtoX, lastY - fromProtoY), stopped: 'no_floor' };
      }
      // move.c:374-382 — an object prevents this move. Each sub-step is traced on its own,
      // from where the client actually is to where this sub-step wants to be. Tracing the
      // WHOLE distance once and trusting a clear verdict is the bug this function replaces:
      // a trace answers about the segment it was given, and a 16-unit probe says nothing
      // about the 320 units beyond it.
      if (geo?.traceFineMoveClient) {
        try {
          const t = geo.traceFineMoveClient(
            protocolToClient(lastX), protocolToClient(lastY),
            protocolToClient(nx), protocolToClient(ny),
            { slide: false, playerRadius });
          if (t && t.blocked === true && t.arrived !== true) {
            // THE LAST LEG IS A BISECT, NOT A STEP.
            //
            // move.c stops 12.8 client units short of a wall because its sub-steps are that
            // size (move.c:266-268 divides a 100ms MOVE_DELAY into 20). Ours are 128 client
            // units because a whole stride is being integrated at once, so taking the last
            // whole sub-step would leave the character standing a tenth of a square away from
            // a wall it was told to walk up to — and a mover parked off the wall cannot make
            // progress along it, which is the failure the escape fan exists for.
            //
            // The trace resolves better than that: it reports `blocked` for an endpoint one
            // unit past the wall and clear for one 64 units short of it (measured, not
            // assumed). So the boundary is findable to within a unit, and the honest thing is
            // to find it rather than to approximate it and call the error a tolerance.
            //
            // The reference client does not bisect because it does not need to — it never
            // looks ahead at all, it just takes 20 small steps. Given a trace that CAN see the
            // wall, a bisect is the equivalent: same guarantee (the returned position is one
            // the trace vouched for), finer resolution, and no dependence on how coarse our
            // sub-stepping happens to be.
            const hit = this._bisectToWall(geo, lastX, lastY, nx, ny, { playerRadius });
            return { x: hit.x, y: hit.y, moved: Math.hypot(hit.x - fromProtoX, hit.y - fromProtoY), stopped: 'wall' };
          }
        } catch { /* a geometry that throws is not a licence to move: stop. */
          return { x: lastX, y: lastY, moved: Math.hypot(lastX - fromProtoX, lastY - fromProtoY), stopped: 'trace_error' };
        }
      }
      lastX = nx; lastY = ny;
    }
    return { x: lastX, y: lastY, moved: travel, stopped: null };
  }

  // Binary search the last legal position along one sub-step's segment.
  //
  // The segment's endpoints are already known to be, respectively, legal (it is where the
  // integration stopped last sub-step) and blocked (the trace just said so). That is exactly
  // the precondition a bisection needs, and 12 iterations on a 128-unit leg resolves the
  // boundary to well under a client unit.
  //
  // Every returned position is one the trace itself cleared, so this cannot be used to reach a
  // position the geometry has not vouched for — the property the whole file is about. It is
  // deliberately NOT a projection onto a wall normal or a distance subtraction: neither of
  // those is something the trace agrees with, and a gap closed by arithmetic the validator was
  // never asked about is how the previous version of this mover ended up inside walls.
  // Round a legal protocol position to the integers the wire carries, biased AWAY from the
  // direction we were travelling. See the call site: rounding to nearest can land a position
  // one unit short of a wall onto the wall itself, and the wall is exactly where being wrong by
  // one unit matters. Only the axis that actually moved is biased; a zero axis has no wrong
  // side and must not be pushed a whole unit for no reason.
  _roundBackward(moved, toward) {
    // ROUND AWAY FROM THE WALL — BUT ONLY IF WE STOPPED AT ONE.
    //
    // The integration's result is a fractional protocol position, and the wire carries whole
    // units (protocol.h:75 passes an int). Rounding to nearest does not know which side of a wall
    // line it is on: measured, an integration that stopped exactly on the clearance line returned
    // 527.06, Math.round gave 527, and 527 is fifteen client units INSIDE the wall. So when the
    // run ended on an obstruction the rounding must go backward, against the heading.
    //
    // When the run ended nowhere — it travelled the whole limit, `stopped` is null — there is no
    // wall to be afraid of and rounding backward is a pure loss. The corner-flow case is exact:
    // a full 64-unit stride returns 223.9999999999998, which is floating-point dust, not a near
    // miss. Rounding it down sends 223 where the square centre is 224, and it does that once per
    // packet. Over a 22-waypoint route that is 22 units of ground handed back for nothing, and a
    // character that never quite arrives at the middle of the squares it is standing in.
    if (moved.stopped == null) {
      return { x: Math.round(moved.x), y: Math.round(moved.y) };
    }
    const dx = toward.x - (moved.fromX ?? moved.x), dy = toward.y - (moved.fromY ?? moved.y);
    const bias = (v, d) => {
      const r = Math.round(v);
      if (r === v) return r;
      if (d === 0) return Math.floor(v);
      // Move against the travel direction: down if heading positive, up if heading negative.
      return d > 0 ? Math.floor(v) : Math.ceil(v);
    };
    return { x: bias(moved.x, dx), y: bias(moved.y, dy) };
  }

  _bisectToWall(geo, ax, ay, bx, by, { playerRadius = 1 } = {}) {
    let lo = { x: ax, y: ay }, hi = { x: bx, y: by };
    for (let i = 0; i < 12; i++) {
      const mx = (lo.x + hi.x) / 2, my = (lo.y + hi.y) / 2;
      let blocked = true;   // same rule as the caller: an error is not a licence to move
      try {
        const t = geo.traceFineMoveClient(
          protocolToClient(lo.x), protocolToClient(lo.y),
          protocolToClient(mx), protocolToClient(my),
          { slide: false, playerRadius });
        blocked = !!(t && t.blocked === true && t.arrived !== true);
      } catch { blocked = true; }
      if (blocked) hi = { x: mx, y: my }; else lo = { x: mx, y: my };
    }
    return lo;
  }

  _submitMove(s, c, sendFn) {
    // DO NOT SEND A MOVE PACKET WHILE A BLINK IS IN PROGRESS. A move packet
    // breaks the character's concentration and the blink fizzles. The blink
    // takes 15+ seconds to cast; the mover ticks every 0.3s. Without this
    // gate, the first tick after the cast sends a move packet, breaks the
    // concentration, and the blink never lands.
    if (this._blinkPending) return false;
    if (!this._claimMoveSlot()) {
      // THE REJECTION IS LOGGED, AND THE SEND IS NOT. Every call site used to call _recordSend() on
      // the very next line regardless of what this returned, so `[move-sent] n=N` counted ATTEMPTS.
      //
      // That is not a cosmetic mislabel, and the direction of the error is the reason it went
      // unnoticed:
      //
      //   - Every squares-per-second figure ever computed from these logs used the attempt count as
      //     its denominator. Refused attempts read as slow movement, so the numbers UNDERSTATED us.
      //     It is the same sign as the harness bug that ate the first packet's ground — two
      //     independent errors both making the fleet look slower, neither caught.
      //   - The inter-packet gap distribution is built from these same lines, and that distribution
      //     is the entire evidence base for the cadence question. This is where the 409ms and 444ms
      //     "gaps" in keeper-t3.log came from: two sites ATTEMPTING in the same second, the cap
      //     refusing the second one, and the log recording both. Read naively, that data argues
      //     against a 1000 ms cadence on the strength of packets that never went out.
      //
      // The rule lives here rather than at the call sites because a rule enforced in seven places is
      // a rule forgotten at the eighth — which is exactly what happened.
      this._submitsRefused = (this._submitsRefused ?? 0) + 1;
      if (process.env.M59_MOVE_DEBUG !== '0')
        console.error(`[move-refused] n=${this._sendCount} cap=${this._moveCapMs ?? MOVE_CAP_MS}ms `
          + `gap=${Date.now() - (this._lastMoveSubmitAt ?? 0)}ms refused=${this._submitsRefused}`);
      return false;
    }
    Promise.resolve(s.pacer.submit('move', sendFn, 100)).catch(() => {});
    return true;
  }

  // Claim one move slot without submitting (for the raw direct-send sites
  // that bypass the pacer to avoid queue delay).
  _claimMoveSlot() {
    const t = Date.now();
    const cap = this._moveCapMs ?? MOVE_CAP_MS;
    if (t - (this._lastMoveSubmitAt ?? 0) < cap) return false;
    // THE ONE MEASUREMENT THAT DECIDES WHETHER THE CADENCE IS LEGAL, AND WE HAVE NEVER HAD IT.
    //
    // user.kod:2937 keeps piMovesCounter = (c + 1) - iDelta, where iDelta is the WHOLE SECONDS
    // since the last packet, and raises an ALERT above 2. Two packets inside one server second give
    // iDelta = 0, so the counter climbs 1, 2, ALERT. A 1000 ms cadence is therefore safe in the
    // average and unsafe under jitter, and the margin is exactly one packet.
    //
    // Every squares-per-second claim in this project has been made without knowing the answer, and
    // the reason is boring: our own log lines carry no timestamps at all. The inter-packet gap has
    // never been recorded, so "is our cadence inside the server's tolerance" has been argued from
    // the constant rather than measured, which is how 1050 ms came to be defended as a law when
    // nothing in the source requires it and nothing here has ever shown it was needed.
    //
    // So record the gap. A histogram of gaps, and a count of gaps below the server's own one-second
    // unit, is the whole evidence base for the rate contract. It is cheap, it is per-send, and it
    // turns a standing argument into a number.
    if (this._lastMoveSubmitAt != null) {
      const gap = t - this._lastMoveSubmitAt;
      this._gapHist = this._gapHist ?? new Map();
      const bucket = Math.floor(gap / 50) * 50;
      this._gapHist.set(bucket, (this._gapHist.get(bucket) ?? 0) + 1);
      this._gapMin = Math.min(this._gapMin ?? Infinity, gap);
      if (gap < 1000) this._subSecondGaps = (this._subSecondGaps ?? 0) + 1;
      // Three packets in one server second is what actually trips the ALERT. Two is the warning.
      if (gap < 500) this._dangerGaps = (this._dangerGaps ?? 0) + 1;
    }
    this._lastMoveSubmitAt = t;
    return true;
  }

  /** Cadence evidence: the distribution of inter-packet gaps since the mover started.
   *
   * `move_cap_ms` is part of the report on purpose. A test rig builds a mover with `moveCapMs: 0`
   * to tick in microseconds, and that mover happily records a 0 ms gap between two accepted submits
   * — which is true of the rig and worthless as evidence about the fleet. Without the cap in the
   * output, a rig histogram and a live histogram are indistinguishable, and the number we would be
   * betting the rate contract on could have come from either.
   */
  cadence_report()
  {
    const buckets = [...(this._gapHist ?? new Map())].sort((a, b) => a[0] - b[0]);
    // GAPS, NOT SENDS. The first accepted submit records no gap because there is nothing before it,
    // so the histogram holds one fewer entry than the number of submits. I named this field `sends`
    // an hour ago and an assertion immediately read it as one and was wrong — which is the field
    // lying, not the test. Both counts are reported now so the off-by-one cannot be re-mistaken for
    // a lost send, which is the specific thing that would make this evidence look like it dropped
    // evidence when it did not.
    const gaps = buckets.reduce((s, [, n]) => s + n, 0);
    return {
      gaps_recorded: gaps,
      accepted_submits: gaps + (this._lastMoveSubmitAt != null ? 1 : 0),
      move_cap_ms: this._moveCapMs ?? MOVE_CAP_MS,
      min_gap_ms: this._gapMin === Infinity ? null : this._gapMin,
      under_1000ms: this._subSecondGaps ?? 0,
      under_500ms: this._dangerGaps ?? 0,
      histogram_ms: buckets.map(([ms, n]) => `${ms}-${ms + 49}:${n}`).join(' '),
    };
  }

  // SERVER-STATIC TRACKING (shared): the raw direct-send sites bypassed
  // _sendStep/_sendWaypoint, so stuckTicks froze at 0 while sends flowed
  // and the server never moved — fan, diagnostics, and stand logic blind.
  /**
   * REMEMBER THAT THE SERVER REFUSED A STEP, so the next plan routes around it.
   *
   * Why this exists rather than a bigger retry budget: the mover already re-plans and
   * already has a taboo list, and neither helps, because both treat a refusal like a
   * delay. It is not a delay. On the live shard one character sent the identical step
   * four times in four seconds and the server never moved it, then the mover re-planned
   * and chose the same step again, because every static predicate in the bake says the
   * square is walkable. They are all correct about the geometry and none of them can see
   * a body, a container, or a kod script.
   *
   * The evidence for a refusal is the only thing in this system that comes from the
   * server rather than from our own model: we declared a square, we are still where we
   * were. That is an observation about the world and it should outrank a prediction
   * about a file.
   *
   * TTL, not permanent. A refusal is probably a player who will walk away, a container
   * that will be picked up, or a door that will open. A permanent ban would turn a
   * temporary crowd into a permanently unreachable room, which is a worse and rarer
   * failure than the ping-pong. 45 seconds is about nine move intervals — enough to
   * outlast a crowd crossing our path, short enough that a genuinely blocked route is
   * retried rather than silently abandoned.
   */
  _noteRefusedStep(toCol, toRow, fromCol, fromRow) {
    if (!Number.isFinite(toCol) || !Number.isFinite(toRow)) return;
    // Edge key: fromRow,fromCol>toRow,toCol. One-way (refusals are directional).
    // Keying by edge (not square) means a square refused from two different
    // neighbours keeps both bans. The `from` is stored in the value for
    // _refusedKeys() to derive the square key for orderCandidates.
    const key = `${fromRow},${fromCol}>${toRow},${toCol}`;
    const now = Date.now();
    if (!this._refusedSteps) this._refusedSteps = new Map();
    // Re-declaring the same refused step EXTENDS the ban: the server has just refused it
    // again, which is evidence the obstruction is still there. Without this, a character
    // that keeps choosing the blocked square would let the ban lapse mid-crowd.
    this._refusedSteps.set(key, { until: now + REFUSED_STEP_TTL_MS, from: fromCol + ',' + fromRow });
    if (this._refusedSteps.size > 64) {
      // Bound the memory. Drop the oldest-expiring entries rather than the whole map, so
      // a long journey does not lose the refusals it is actively routing around.
      const stale = [...this._refusedSteps.entries()].sort((a, b) => a[1].until - b[1].until);
      for (const [k] of stale.slice(0, this._refusedSteps.size - 64)) this._refusedSteps.delete(k);
    }
  }

  /** Live, unexpired refusals as 'col,row' square keys, for orderCandidates.
   *  Derived from the edge key by splitting on '>'. */
  _refusedKeys() {
    if (!this._refusedSteps?.size) return [];
    const now = Date.now();
    const out = [];
    for (const [k, v] of this._refusedSteps) {
      if (v.until <= now) { this._refusedSteps.delete(k); continue; }
      // Edge key: fromRow,fromCol>toRow,toCol → square key: toCol,toRow
      const toPart = k.split('>')[1];
      const [toRow, toCol] = toPart.split(',').map(Number);
      out.push(toCol + ',' + toRow);
    }
    return out;
  }

  /** Live, unexpired refusals as edge keys, for finePathProtocol.
   *  Returns the raw edge keys (fromRow,fromCol>toRow,toCol). */
  _refusedEdgeKeys() {
    if (!this._refusedSteps?.size) return new Set();
    const now = Date.now();
    const out = new Set();
    for (const [k, v] of this._refusedSteps) {
      if (v.until <= now) { this._refusedSteps.delete(k); continue; }
      out.add(k);
    }
    return out;
  }


  _noteServerStatic(col, row) {
    if (col == null || row == null) return;
    // ECHO-MOVED-KEYED: reset the counter when the server position actually changed
    // (lastMovedAt is fresh), not just when updateServer was called (which runs
    // every frame ~0.1s). A fresh position change means the server is moving,
    // so the character is not pinned.
    const _lastMoved = this.session?._pose?.lastMovedAt ?? 0;
    if (_lastMoved > 0 && Date.now() - _lastMoved < 1500) {
      this.stuckTicks = 0;
      this.lastPos = { col, row };
      return;
    }
    if (this.lastPos && this.lastPos.col === col && this.lastPos.row === row) this.stuckTicks++;
    else this.stuckTicks = 0;
    this.lastPos = { col, row };
  }

  // Returns true if a position packet was actually sent this tick.
  _maybeReportPosition(protoX, protoY, c, s, serverX, serverY) {
    if (!this._movementGateOk(protoX, protoY, serverX, serverY, serverX, serverY)) return false;
    const px = Math.round(protoX), py = Math.round(protoY);
    const _sent = this._submitMove(s, c, () => c.moveTo(px, py, 18, c.room?.id ?? 0));
    if (_sent) {
      this._recordSend(this.destProto?.x ?? protoX, this.destProto?.y ?? protoY, protoX, protoY, px, py, 'send-waypoint-helper');
    }
    this._recordReport(protoX, protoY);
    return true;
  }

  _sendWaypoint(protoX, protoY, c, s, me) {
    // Lazy report: only send the position packet if the interval + threshold allow it.
    // The reference is the SERVER position (me), so a stuck server re-sends the waypoint.
    const serverX = me?.x ?? (me?.col != null ? me.col * KOD_FINENESS + HALF : undefined);
    const serverY = me?.y ?? (me?.row != null ? me.row * KOD_FINENESS + HALF : undefined);
    const sent = this._maybeReportPosition(protoX, protoY, c, s, serverX, serverY);
    // Stuck tracking is independent of whether we sent a packet: the character is
    // walking toward the waypoint regardless. This used to re-implement the counter
    // inline — a third copy of "has the server square stopped changing", and it had
    // already drifted from the one in _noteServerStatic that every other send site
    // calls. One stall mechanism now: Pose.confirmed for the position, _noteServerStatic
    // for the counter.
    const srv = Pose.confirmed(s);
    if (srv.source !== 'none') this._noteServerStatic(srv.col, srv.row);
    return sent;
  }

  /**
   * Send a step to the server and advance dead reckoning.
   * Falls back to the raw-move fan if the fine model blocks the step.
   */
  _sendStep(protoX, protoY, c, s, me) {
    const myX = this.drX, myY = this.drY;

    const px = Math.round(protoX);
    const py = Math.round(protoY);
    // THE RESULT IS DELIBERATELY DISCARDED HERE, UNLIKE THE FIVE SITES THAT GATE _recordSend.
    // This site advances the dead-reckoning position (drX/drY), which is a statement about what we
    // intended, not about what reached the wire. A refused submit still moves our intent, and the
    // next tick plans from where we meant to be. The five gated sites are gated because they feed
    // the SEND COUNTER, and that counter is a claim about the wire — it is the denominator of every
    // squares-per-packet figure anyone computes from these logs. Intent may be optimistic; a wire
    // counter may not.
    this._submitMove(s, c, () => c.moveTo(px, py, 18, c.room?.id ?? 0));
    this.drX = protocolToClient(px);
    this.drY = protocolToClient(py);

    // No stall counting here. The caller _sendWaypoint counts it once, on the
    // confirmed square. Counting it here as well made a stationary character's
    // stuckTicks climb twice per send, so the escalation fired at roughly half
    // the number of sends it is configured for.
    return { blocked: false };
  }

  /**
   * Mark the character as sitting (after a rest command).
   */
  markSitting() {
    this.sitting = true;
  }

  /**
   * Fire a confirmPosition and sync dead reckoning when it resolves.
   */
  maybeConfirm() {
    const now = Date.now();
    if (now - this.lastConfirm < this.confirmInterval) return false;
    this.lastConfirm = now;
    const s = this.session;
    if (!s?.confirmPosition) return false;
    Promise.resolve(s.confirmPosition()).then(pos => {
      if (pos && this.drX != null) {
        this.drX = protocolToClient(pos.col * KOD_FINENESS + HALF);
        this.drY = protocolToClient(pos.row * KOD_FINENESS + HALF);
      }
    }).catch(() => {});
    return true;
  }

  /**
   * Sync dead reckoning from a confirmed position.
   */
  syncPosition(col, row) {
    this.drX = protocolToClient(col * KOD_FINENESS + HALF);
    this.drY = protocolToClient(row * KOD_FINENESS + HALF);
  }

  /**
   * Try to cast blink to escape a geometry pocket.
   */
  // Shared fan-exhaustion path: every heading refused (or skipped as
  // floorless). Clears the fan, counts the stall, blinks when possible.
  _fanExhausted(curX, curY) {    this._fanTarget = null;
    this._fanFrom = null;
    this._fanIndex = null;
    this.stuckTicks++;
    // TRAVEL MODE (motion-only proving): no blink — a random teleport
    // destroys the run. The pocket is reported as stuck (a named blocker)
    // instead of scattered out of. The void-blink path above is untouched
    // (already floorless = survival, not a crossing run).
    const _man = this.session?._manualDest;
    const _travelMode = _man != null && Date.now() - (_man.at ?? 0) < 900000;
    // DO NOT CAST BLINK WHILE IN COMBAT. A cast in combat breaks concentration
    // (the swing/attack interrupts the channel) and the blink fizzles. If you
    // are in combat, run — the fan tries to walk out. Only blink when fully
    // stuck (the fan is exhausted) AND not in combat.
    const _inCombat = this.session?.ws?.has_target === true;
    let _recovered = false;
    if (!_travelMode && !_inCombat) {
      // SPELL-FREE ESCAPE: before trying blink (which requires mana these
      // martial characters don't have), try walking to the nearest grounded
      // square. Gated on a 30s cooldown to prevent per-tick reset loops.
      const _recAt = this._recoveryAt ?? 0;
      if (Date.now() - _recAt > 30000) {
        const _geo = this.session?.world?.geometry;
        const _srv = Pose.confirmed(this.session);
        if (_srv.source !== 'none' && _geo) {
          try {
            const ng = nearestGrounded(_geo, _srv.col, _srv.row, { maxRadius: 40 });
            if (ng && (ng.col !== _srv.col || ng.row !== _srv.row)) {
              if (this.to(ng.col, ng.row, { by: 'recovery' })) {
                this._recoveryAt = Date.now();
                this._fanIndex = null;
                this._fanTarget = null;
                this._fanFrom = null;
                this.path = null;
                this.pathIdx = 0;
                _recovered = true;
                console.error(`[mover] ${this.logName} fan-exhausted: recovered to grounded square ${ng.col},${ng.row} (was ${_srv.col},${_srv.row})`);
              } else {
                console.error(`[mover] ${this.logName} recovery deferred; router owns dest`);
              }
            }
          } catch { /* keep the blink path */ }
        }
      }
      if (!_recovered) {
        const blinked = this._tryBlink();
        if (blinked) {
          this._blinkFrom = { x: curX, y: curY };
          return { state: 'blink', why: 'all 8 raw moves landed on same square, casting blink' };
        }
      }
    } else if (process.env.M59_MOVER_TRACE === '1') {
      console.error(`[movestuck] ${this.logName} travel-mode pocket: all 8 raw moves landed on same square at srv=(${this.lastPos?.col},${this.lastPos?.row}) — blink parked, holding`);
    }
    return { state: _recovered ? 'recovered' : 'stuck', why: _recovered ? 'fan exhausted, walked to grounded square' : 'all 8 raw moves landed on same square' };
  }
  _tryBlink() {
    // PHASE 0c fix: don't cast blink while moving. Movement breaks
    // concentration and the cast fails. Only blink when the character is
    // stalled (stuckTicks > 0 = no position change since the last tick).
    if (this.stuckTicks === 0) return false; // moving, don't blink
    const c = this.session?.client;
    if (!c?.cast) return false;

    // MANA REFUSAL COOLDOWN.
    //
    // The server told us, in words, that this character cannot afford blink. Retrying on
    // the next escape attempt does not change that, and each retry cost a 20,000 ms hold
    // because nothing was watching for the answer. In the live fleet this was the single
    // most common cast outcome: "You don't have enough mana to cast blink!" appears on
    // essentially every recording, and each one bought a full backstop wait.
    //
    // The cooldown is one minute, not forever: mana regenerates, and a character that
    // waits it out should get the blink it is standing in a pocket for. It is keyed on
    // the refusal we actually observed rather than on a mana threshold we would have to
    // guess at -- blink's cost is spell DATA, and the spell record the client is given
    // (id/name/targets/school) carries no cost field at all, so any number written here
    // would be invented.
    const _ref = this._blinkRefusedAt ?? 0;
    if (Date.now() - _ref < 60000) {
      return false;   // let the escape fan / stuck report run instead of holding on a refusal
    }
    // BLINK-LANDING COOLDOWN.
    //
    // Re-casting immediately after a landing holds the character for another 20s
    // with no progress. A 30s cooldown lets the escape fan and the raw-move path
    // run instead of re-holding on a blink. The cooldown is shorter than the
    // mana-refusal one (60s) because a landed blink at least proved the character
    // can cast; the mana refusal proved it cannot.
    const _landed = this._blinkLandedAt ?? 0;
    if (Date.now() - _landed < 30000) {
      return false;   // let the escape fan / raw-move path run instead of re-holding
    }

    const blink = (c.spells ?? []).find(sp => {
      const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
      return n.toLowerCase() === 'blink';
    }) ?? (c.skills ?? []).find(sp => {
      const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
      return n.toLowerCase() === 'blink';
    });
    if (!blink) return false;
    try {
      // ARM THE HOLD BEFORE ANYTHING IS SUBMITTED, not after.
      //
      // This is the fix, and the previous version had it exactly backwards. It armed
      // _blinkPending inside a setTimeout(2000) — the wait for STAND to be processed —
      // which meant the hold did not exist for the first 2,000 ms of a cast. The mover
      // ticks every 0.30 s (measured, keeper-t2.log, n=695), so SIX unconstrained ticks
      // ran in that window, each free to send an escape-fan move packet. Blink requires
      // concentration; a move packet breaks it. The server then answered
      //
      //   "Your concentration is broken and the blink spell fizzles."
      //
      // We were cancelling our own blink, and could not see it happening: over 106 blinks
      // exactly one was followed by a position change, and a never-sent cast, a fizzled
      // cast and a cast that landed inside the 8-unit threshold were indistinguishable
      // from in here. The three server texts are now observed (tools/tick/m59-cast.mjs),
      // which is what turned "the geometry refuses all eight directions" into "we fizzle
      // the only spell that could have gotten us out".
      //
      // Arming here is safe against a failed submit: the hold is released by the cast
      // lines (landed/fizzle) or by CastWatch's own lost-timeout, and _blinkAt still
      // bounds it from below, so a submit that throws cannot wedge the mover forever.
      this._blinkPending = true;
      this._blinkAt = Date.now();

      // STAND BEFORE BLINK: a resting character has PFLAG_NO_MAGIC set
      // (player.kod:1166) and the server refuses the cast whole. UC_STAND ->
      // StopResting() -> ResetPlayerFlagList() clears the flag.
      this.session.pacer.submit('stand', () => c.stand?.()).catch(() => {});

      // SUBMIT THE CAST NOW, UNDER THE URGENT KIND.
      //
      // Two changes from `submit('blink', fn, 1500)`, both from reading submit() rather
      // than assuming:
      //
      //   * kind `'blink'` is NOT on the pacer's priority list — `isUrgent = kind ===
      //     'attack' || kind === 'cast'` (m59-game.mjs:526). A blink cast queued under
      //     'blink' waits BEHIND the move packets, which is the last thing a cast that
      //     must not be interrupted can tolerate. `'cast'` jumps them.
      //   * the third argument is `minGapForKind`, a rate LIMIT, not a staleness deadline.
      //     The 1500 there was delaying our own cast by 1.5 s after we had already waited
      //     2 s. It is dropped.
      //
      // The 2 s wait for STAND is gone because it was never about time. It existed to
      // avoid submitting a cast that the server would refuse while the character was
      // still flagged as resting; the pacer sends in order, so the stand is processed
      // before the cast without us guessing how long that takes.
      const rec = this.session.pacer.submit('cast', () => c.cast(blink.id, []));
      Promise.resolve(rec).catch(() => {});
      return true;
    } catch {
      this._blinkPending = false;   // never hold for a cast that was never submitted
      return false;
    }
  }
}
