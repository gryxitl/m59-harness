#!/usr/bin/env node
// m59-mover.mjs -- THE FINE-MODEL MOVER: one legal step per tick.
//
// The server is client-authoritative for movement: it does not check geometry,
// it records what we say. Collision is entirely our responsibility, and it must
// be the FINE model: standable() reads the coarse grid and is blind to wall
// segments (0 non-standable squares in Raza, 280 of 1792 fine cells blocked).
//
// THE SPEED BUDGET
//
// From the game's own client source (clientd3d/move.c):
//   MOVEUNITS  = FINENESS >> 2 = 256 client units
//   MOVE_DELAY = 100 ms
// So the real client moves 256 client units per 100ms tick.
// In protocol units: 256 / 16 = 16 units per tick (0.25 squares).
//
// ONE TICK = ONE STEP OF AT MOST MOVEUNITS. No more, no less.
//
// PLANNING
//
// The mover uses finePathProtocol (a bounded A* on the fine model) to plan
// a path around walls. It follows the waypoints one step per tick. If the
// path is blocked mid-way (stale geometry, a new wall appeared), it replans
// from the current position. If finePathProtocol reports "no fine path", the
// mover reports "no-route". If it reports "search budget exhausted", the
// mover reports "search-exhausted". These are different answers and the
// caller can distinguish them.
//
// The straight-line + brute-force fan from the previous revision is gone.
// The raw-move fallback remains as a last resort for stale geometry where
// the fine model says "wall" but the server says "floor".

import { protocolToClient, clientToProtocol, KOD_FINENESS, PLAYER_RADIUS } from '../m59-roo.mjs';
import { isGrounded, isEmbedded, nearestGrounded, segHeightOk, transitBanned } from './m59-ground.mjs';
import '../m59-navgeom.mjs';   // installs the height model + lenient fine path onto RoomGeometry
// CANDIDATE ORDERING (pure, unit tested). Loop avoidance (unvisited
// squares first) engages ONLY while genuinely stuck (stuckTicks >= 3,
// the fan threshold — the echo lags ~1s, so 1-2 static ticks are healthy
// movement, not stuck): applied any earlier it turns straight walks into
// a drunkard's dither. While the server advances, walk straight at the
// goal; dead ends backtrack once static.
export function orderCandidates(candidates, recentSteps, stuckTicks, opts = {}) {
  const taboo = stuckTicks >= 3 ? (recentSteps ?? []) : [];
  let list = candidates;
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
export class Mover {
  constructor(session, { reportIntervalMs = MOVE_INTERVAL_MS, moveCapMs = 1050 } = {}) {
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
  _recordSend(keyX, keyY, posX, posY) {
    this._lastSentKey = `${Math.round(keyX)},${Math.round(keyY)}`;
    this._lastSentPos = { x: posX, y: posY };
    this._sendCount = (this._sendCount ?? 0) + 1;
  }

  /**
   * Set the destination. col/row are protocol square coordinates
   * (the same space as client.self.col/.row).
   */
  to(col, row, { standOn = false, edgeTarget = null, by = null } = {}) {
    // Never poison the destination: a non-finite col/row makes destProto NaN,
    // and every later send throws RangeError inside a swallowed catch —
    // counted by the pacer, never on the wire, frozen with zero errors.
    if (!Number.isFinite(col) || !Number.isFinite(row)) {
      console.error(`[mover] to() refused non-finite dest col=${col} row=${row} (keeping ${this.dest ? this.dest.col + ',' + this.dest.row : 'none'})`);
      return false;
    }
    // A NEW destination (different from the current one) resets path/fan state.
    // The router calls to() every tick with the same aim while walking, so we
    // must NOT reset on a no-op to() — that would defeat planning and send a
    // packet every tick again. Only a genuine re-route resets it.
    const isNewDest = !this.dest || this.dest.col !== col || this.dest.row !== row;
    if (isNewDest && Date.now() - (this._toDbgAt ?? 0) > 5000) {
      this._toDbgAt = Date.now();
      try { console.error(`[movedbg] t4 to() -> ${col},${row} (was ${this.dest ? this.dest.col + ',' + this.dest.row : 'none'}) by=${by ?? '?'}`); } catch {}
    }
    this.dest = { col, row };
    // PHASE 2: the stand_on flag. When true, the destination is an exit square
    // (stand_on) — a square the character is meant to stand on to trigger a
    // transition. The geometry's "no floor" answer is wrong for that square;
    // the server handles the transition. The mover skips the floor check and
    // lets the raw-move fallback carry the character onto it.
    this._destIsStandOn = standOn;
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
        const sp = this.session?._pose?.server ?? this.session?.client?.self;
        this._arriveBase = (sp && Number.isFinite(sp.col) && Number.isFinite(sp.row))
          ? { col: sp.col, row: sp.row } : null;
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
    this.path = null;
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
      { step: 8, margin: 12 * KOD_FINENESS, maxNodes: 20000 },
    );
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
  tick(posOverride) {
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
      try { console.error(`[mover-hb] dest=${this.dest ? this.dest.col + ',' + this.dest.row : 'null'} path=${this.path ? this.pathIdx + '/' + this.path.length : 'null'} fan=${this._fanIndex} stuck=${this.stuckTicks} sends=${this._sendCount ?? 0} ownPhys=${this.session?.policy?.ownPhysics === true} gateAge=${Date.now() - (this._lastReportAt ?? 0)} cli=${this.session?.client ? this.session.client.state : 'noclient'} pacer=${this.session?.pacer ? 'Y' : 'n'}`); } catch {}
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
      this.path = null; this.pathIdx = 0;
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
    const srvPos = (s?._pose?.server) ?? c.self;
    const srvCol = (srvPos && Number.isFinite(srvPos.col)) ? srvPos.col : me.col;
    const srvRow = (srvPos && Number.isFinite(srvPos.row)) ? srvPos.row : me.row;
    const srvX = (srvPos && Number.isFinite(srvPos.x)) ? srvPos.x : (srvCol * KOD_FINENESS + HALF);
    const srvY = (srvPos && Number.isFinite(srvPos.y)) ? srvPos.y : (srvRow * KOD_FINENESS + HALF);

    // THE SITTING TRAP: PFLAG_NO_MOVE refuses every move silently.
    // Stand first.
    if (this.sitting) {
      this.sitting = false;
      const rec = s.pacer.submit('stand', () => c.stand(), 0);
      Promise.resolve(rec).catch(() => {});
      // PHASE 0a: when ownPhysics is on, do NOT return — let the tick
      // continue to the velocity declaration. The stand() command is
      // fire-and-forget (the server processes it asynchronously). The
      // velocity declaration fires on the same tick. The server might
      // refuse the move (the character is still sitting), but the next
      // tick the character is standing, and the velocity declaration
      // fires again. This breaks the stand/sit loop caused by the
      // vigor_low goal.
      if (!this.session?.policy?.ownPhysics) {
        return { state: 'standing' };
      }
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
      if (this._blinkFrom != null) {
        if (Math.hypot(curX - this._blinkFrom.x, curY - this._blinkFrom.y) > 8) {
          this.drX = curX;
          this.drY = curY;
          this._blinkPending = false;
          this._blinkFrom = null;
          this._lastWpKey = null;
          this._simX = null;
          this._simY = null;
          this._simAt = 0;
          try { this.session?._pose?.reset(); } catch {}
          this.stuckTicks = 0;
          this.path = null; // replan from new position
          return { state: 'blinked', why: 'position changed after blink' };
        }
      }
      // Blink is still in progress — hold the character still, but only
      // for the cast window. A failed cast (fizzle, refusal, interrupt)
      // never moves the character, and without a timeout this holds
      // forever on a dead cast (prod move 0 with a live path).
      if (Date.now() - (this._blinkAt ?? 0) > 20000) {
        this._blinkPending = false;
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
      this.path = null;
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
      const srvX = this.session?._pose?.server?.x ?? this.session?.client?.self?.x;
      const srvY = this.session?._pose?.server?.y ?? this.session?.client?.self?.y;
      const curX = protocolToClient(srvX ?? (me.col * KOD_FINENESS + HALF));
      const curY = protocolToClient(srvY ?? (me.row * KOD_FINENESS + HALF));
      if (Math.hypot(curX - this._fanFrom?.x ?? curX, curY - this._fanFrom?.y ?? curY) > 8) {
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

    // PHASE 0a: the velocity-declaration hold (computed here, applied after PLAN).
    // The server moves the character toward the declared target at the declared
    // speed. If we've already sent this target AND the character is making
    // progress (moved since the last send), hold the SEND (not the PLAN) —
    // the A* path is still planned (to get the route), but the moveTo is not
    // re-sent. GATED: only active when policy.ownPhysics is on (opt-in).
    // FIX: measure progress toward the CURRENT AIM (waypoint if path exists,
    // target if not), not the target. The character is moving toward the
    // waypoint (the A* path), not the target (beeline).
    const ownPhysics = this.session?.policy?.ownPhysics === true;
    const holdWp = this.path ? this.path[this.pathIdx] : null;
    let aimX = holdWp ? holdWp.x : this.destProto.x;
    let aimY = holdWp ? holdWp.y : this.destProto.y;
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

    // Final-approach flag for the boundary checks below (0c slide,
    // raycast-ahead): they skip only within 4 squares of an exit square,
    // where the crossing logic takes over. En route they must run — a
    // blocked direct path means a real wall even when headed to a door.
    const standOnNear = !!this._destIsStandOn && this.destProto != null &&
      Math.hypot(this.destProto.x - myProtoX, this.destProto.y - myProtoY) < KOD_FINENESS * 4;

    // WALL-AIM REFUSAL (motion-only honesty): if the destination square
    // itself is fine-blocked and not a stand_on exit, no plan or step can
    // ever reach it — aiming there jitters around the wall forever (watched:
    // router sub-aim (27,33) in 557, fine=False, an hour of 1-sq jitter +
    // fan exhausts + oscillation drops + reasserts). Hold and name it
    // instead of sending; the router's oscillation breaker condemns the
    // leg. Stand_on exits are exempt (the door-push owns the final gap).
    // Only explicit fine-false refuses (no geometry readings = no verdict).
    if (this._destIsStandOn !== true && this.destProto != null) {
      const _dgeo = this.session?.world?.geometry;
      const _dsqC = Math.floor(this.destProto.x / KOD_FINENESS);
      const _dsqR = Math.floor(this.destProto.y / KOD_FINENESS);
      let _df;
      try { _df = _dgeo?.fineWalkable ? _dgeo.fineWalkable(_dsqR, _dsqC) : undefined; } catch { _df = undefined; }
      if (_df === false) {
        if (process.env.M59_MOVE_DEBUG !== '0' && Date.now() - (this._wallAimLogAt ?? 0) > 10000) {
          this._wallAimLogAt = Date.now();
          console.error(`[movestuck] t3 wall aim: dest=(${_dsqC},${_dsqR}) fine-blocked (not stand_on) — holding`);
        }
        return { state: 'stuck', why: `dest square (${_dsqC},${_dsqR}) blocked` };
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
        try { console.error(`[movedbg] t3 plan from=(${Math.floor(myProtoX / KOD_FINENESS)},${Math.floor(myProtoY / KOD_FINENESS)}) dest=${this.dest ? this.dest.col + ',' + this.dest.row : 'null'} found=${result.found} wp=${result.found ? result.waypoints.length : 0} reason=${result.found ? '-' : (result.reason ?? '?')}`); } catch {}
      if (result.found) {
        this.path = result.waypoints;
        this.pathIdx = 0;
      } else {
        // No fine path, or search exhausted. The server is
        // CLIENT-AUTHORITATIVE: it does not check geometry, it
        // records what we say. The fine model is a guide, not
        // a gate. Fall back to a direct step toward the
        // destination. We keep the reason for reporting, but
        // we still move.
        this._noRouteReason = result.reason ?? 'no fine path';
        this.path = null;
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
      const sc = s?.client?.self;
      const pc = (sc && Number.isFinite(sc.col)) ? sc.col : null;
      const pr = (sc && Number.isFinite(sc.row)) ? sc.row : null;
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

    // PHASE 0c: the slide-along-wall check. When ownPhysics is on and we're
    // about to send (not holding), check the direct path to the AIM (waypoint
    // if path exists, target if not). If the fine model says it's blocked by
    // a wall segment, don't send the direct velocity (that walks into the
    // wall) — fire the fan (slide along the wall) instead. The fan tries 8
    // headings; the one that clears the wall is the slide.
    // FIX: check the path to the AIM (not the target) — the velocity
    // declaration sends the character toward the aim (waypoint), not the
    // target (beeline).
    // En route: run the slide check whenever the direct path is blocked.
    if (ownPhysics && !standOnNear) {
      const geo = this.session?.world?.geometry;
      if (geo?.traceFineMoveClient) {
        // Trace origin is the SIM (the live position; the server is
        // client-authoritative, so the sim is where we are — the echo lags).
        const clientX = protocolToClient(myProtoX), clientY = protocolToClient(myProtoY);
        const aimClientX = protocolToClient(aimX), aimClientY = protocolToClient(aimY);
        const trace = geo.traceFineMoveClient(clientX, clientY, aimClientX, aimClientY, { slide: false, playerRadius: 32 });
        if (trace.blocked && !trace.arrived) {
          // Direct path to the aim is blocked by a wall. Fire the fan
          // (slide) instead of the direct velocity. NO EARLY RETURN: the fan
          // branch below gates and sends; returning here starves it (and
          // everything below) whenever this check re-fires, which is the
          // observed wedge of silence with a live path and an open gate.
          if (this._fanIndex == null && this._fanTarget == null) {
            this._fanIndex = 0;
            this._fanFrom = { x: clientX, y: clientY };
          }
        } else if (this._fanIndex != null) {
          // Direct path is CLEAR and we were sliding: corner rounded.
          // Release the fan so velocity resumes (persistent slide would
          // otherwise keep sidestepping past the opening).
          this._fanIndex = null;
          this._fanTarget = null;
          this._fanFrom = null;
          this._fanSentAt = null;
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
      let fanX = myProtoX + Math.cos(finalAngle) * MOVEUNITS_PROTO;
      let fanY = myProtoY + Math.sin(finalAngle) * MOVEUNITS_PROTO;
      const _fgeo = this.session?.world?.geometry;
      if (_fgeo?.traceFineMoveClient) {
        // Stride origin is the SIM (the live position; the server is
        // client-authoritative, so the sim is where we are — the echo lags).
        const _fx = myProtoX + Math.cos(finalAngle) * strideNow;
        const _fy = myProtoY + Math.sin(finalAngle) * strideNow;
        try {
          const _tr = _fgeo.traceFineMoveClient(
            protocolToClient(myProtoX), protocolToClient(myProtoY),
            protocolToClient(_fx), protocolToClient(_fy),
            { slide: false, playerRadius: 32 });
          if (_tr && _tr.blocked !== true) { fanX = _fx; fanY = _fy; }
        } catch {}
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
        // Skip headings into floorless ground OR up unclimbable faces. The
        // stride extension above already refused wall/height-blocked segments;
        // this covers the 16-unit base probe the extension falls back to.
        if (!startIsVoid && !sqIsExit && (transitBanned(_fgeo, sqR, sqC) === true
            || segHeightOk(_fgeo, myProtoX, myProtoY, fanX, fanY) === false)) {
          this._fanIndex = idx + 1;
          if (this._fanIndex >= 9) {
            return this._fanExhausted(protocolToClient(myProtoX), protocolToClient(myProtoY));
          }
          return { state: 'raw-move', fanIndex: this._fanIndex, why: 'fan heading refused (no floor or too steep), skipping' };
        }
      }
      // Cheat-clean: gate fan probes to the 1/s send law like every move.
      // Ungated this fires every tick (10/s) and trips speedhack detection.
      const fServerPX = curCol * KOD_FINENESS + HALF, fServerPY = curRow * KOD_FINENESS + HALF;
      if (Date.now() - (this._fanDbgAt ?? 0) > 20000) {
        this._fanDbgAt = Date.now();
        try { const _g = this._movementGateOk(fanX, fanY, myProtoX, myProtoY, fServerPX, fServerPY); console.error(`[movedbg] t4 fan gate=${_g} me=(${Math.round(myProtoX)},${Math.round(myProtoY)}) srv=(${fServerPX},${fServerPY}) age=${Date.now() - (this._lastReportAt ?? 0)} idx=${idx} tgt=${this._fanTarget ? 'Y' : 'n'}`); } catch (e) { console.error(`[movedbg] t4 fan gate THROW: ${e.message}`); }
      }
      if (this._movementGateOk(fanX, fanY, myProtoX, myProtoY, fServerPX, fServerPY)) {
        this._submitMove(s, c, () => c.moveTo(Math.round(fanX), Math.round(fanY), speed, c.room?.id ?? 0));
        this._recordSend(aimX, aimY, myProtoX, myProtoY);
        this._recordReport(fanX, fanY);
        this._fanTarget = { x: protocolToClient(fanX), y: protocolToClient(fanY) };
        this._fanSentAt = Date.now();
        // _fanFrom is the SERVER reference point for the progress check (which
        // uses the raw server echo). Resetting it to the drifted sim would make
        // the progress check compare server-vs-sim (>8), firing the 'success'
        // branch on a walled-in pocket. Use the raw server echo.
        const _fsrvX = this.session?._pose?.server?.x ?? this.session?.client?.self?.x;
        const _fsrvY = this.session?._pose?.server?.y ?? this.session?.client?.self?.y;
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
          this._submitMove(s, c, () => c.moveTo(Math.round(pastX), Math.round(pastY), 18, c.room?.id ?? 0));
          this._recordSend(pastX, pastY, myProtoX, myProtoY);
          this._recordReport(pastX, pastY);
        }
        return { state: 'crossing', walkPast: true };
      }
    }

    // PHASE 0a: RAYCAST-AHEAD CHECK. Before sending the velocity
    // declaration, check if the character's NEXT position (one step ahead
    // at the declared speed) would collide with a wall. This is the
    // proper physics engine approach: check the trajectory, not just the
    // direct line. At running speed, the character covers more ground per
    // tick, so a wall that's clear on the direct line might not be clear
    // on the trajectory. If the next position is invalid (wall, out of
    // bounds), fire the fan (slide) instead of the velocity declaration.
    // BOUNDARY EXCEPTION: if the destination is a stand_on (exit) square,
    // skip the block — the character is at a boundary (a door/exit), and
    // the next position is in the other room (out of bounds for the
    // current room). The boundary-crossing check (below) fires the go()
    // command. The raycast-ahead check should not block the velocity
    // declaration when the character is at a boundary.
    if (ownPhysics && !standOnNear) {
      const geo = this.session?.world?.geometry;
      // Compute the next position: one step ahead in the aim direction,
      // from the SIM (the live position; the server is client-authoritative,
      // so the sim is where we are — the echo lags).
      const dx = aimX - myProtoX, dy = aimY - myProtoY;
      const dist = Math.hypot(dx, dy) || 1;
      const nextX = myProtoX + (dx / dist) * MOVEUNITS_PROTO;
      const nextY = myProtoY + (dy / dist) * MOVEUNITS_PROTO;
      // Check if the next position is valid (not a wall, not out of bounds).
      // inBounds is 1-indexed (like the aimOOB check above): the floor() square
      // needs +1, or edge squares read out-of-bounds and the fan engages forever.
      const nextValid = geo?.fineWalkable?.(Math.floor(nextY / KOD_FINENESS), Math.floor(nextX / KOD_FINENESS)) !== false
        && geo?.inBounds?.(Math.floor(nextY / KOD_FINENESS) + 1, Math.floor(nextX / KOD_FINENESS) + 1) !== false;
      if (!nextValid) {
        // Next position is invalid (wall or out of bounds). Fire the fan
        // (slide) instead of the velocity declaration. NO EARLY RETURN (see
        // the 0c note above): fall through to the fan branch so the gate can
        // send this same tick.
        if (this._fanIndex == null && this._fanTarget == null) {
          const clientX = protocolToClient(srvX), clientY = protocolToClient(srvY);
          this._fanIndex = 0;
          this._fanFrom = { x: clientX, y: clientY };
        }
      }
    }

    // PHASE 0a: VELOCITY DECLARATION. Under ownPhysics, declare the (already
    // stride-clamped) aim: one accepted position per second IS the speed
    // (walk 160 = 2.5 sq/s, run 320 = 5 sq/s). The byte must match the
    // stride: >18 with vigor < 10 gets rubber-banded as cheating (user.kod),
    // and runNow already requires RUN_VIGOR_FLOOR.
    if (ownPhysics) {
      // ENTRY TRACE (throttled): why does the velocity declaration never send live?
      if (Date.now() - (this._velDbgAt ?? 0) > 10000) {
        this._velDbgAt = Date.now();
        try { console.error(`[movedbg] t3 vel-tick path=${this.path ? this.pathIdx + '/' + this.path.length : 'null'} dest=${this.dest ? this.dest.col + ',' + this.dest.row : 'null'} run=${runNow} stride=${strideNow} stuck=${this.stuckTicks} fan=${this._fanIndex}`); } catch {}
      }
      // Advance past reached waypoints HERE: the shared advance block below
      // is unreachable past this return. Without this, pathIdx freezes on a
      // reached waypoint, aim == position, the send gate closes forever —
      // the observed one-step-then-stop.
      let cornerAim = null;
      if (this.path && this.pathIdx < this.path.length) {
        // Stride lookahead, TRACE-GATED: consume every waypoint within one
        // stride whose beeline from here is trace-clear, so each send covers
        // the full official distance on straightaways. Stop at the first
        // waypoint whose beeline is blocked (a corner): aiming past it would
        // cut the corner through the wall and trip the 0c fan into minutes of
        // sliding. The corner waypoint is consumed on arrival (its beeline is
        // trivially clear once reached), so curves flow without fanning.
        const geoLA = this.session?.world?.geometry;
        const beelineClear = (wx, wy) => {
          if (!geoLA || !geoLA.traceFineMoveClient) return true;
          try {
            const t = geoLA.traceFineMoveClient(
              protocolToClient(myProtoX), protocolToClient(myProtoY),
              protocolToClient(wx), protocolToClient(wy),
              { slide: false, playerRadius: 32 });
            return !(t && t.blocked && !t.arrived);
          } catch { return true; }
        };
        let lastClear = -1;
        while (this.pathIdx < this.path.length) {
          const w = this.path[this.pathIdx];
          if (Math.hypot(w.x - myProtoX, w.y - myProtoY) >= strideNow) break;
          if (!beelineClear(w.x, w.y)) {
            cornerAim = lastClear >= 0 ? this.path[lastClear] : null;
            break;
          }
          lastClear = this.pathIdx;
          this.pathIdx++;
        }
      }
      if (!this.path || this.pathIdx >= this.path.length) {
        // Past all waypoints (or no path): fall through to the
        // destination-direct logic below.
      } else {
        // At a corner the lookahead stops early: aim at the furthest CLEAR
        // waypoint (cornerAim), not the blocked one the index points at.
        const w = cornerAim ?? this.path[this.pathIdx];
        aimX = w.x; aimY = w.y;
        // Re-clamp: the new aim may be farther than one stride. Clamped from
        // the SIM (the live position; the server is client-authoritative, so
        // the sim is where we are — the echo lags and would pull backward).
        const adx = aimX - myProtoX, ady = aimY - myProtoY;
        const ad = Math.hypot(adx, ady);
        if (ad > strideNow) {
          aimX = myProtoX + (adx / ad) * strideNow;
          aimY = myProtoY + (ady / ad) * strideNow;
        }
        const speed = runNow ? 36 : 18;
      // NEVER ENTER A VOID: from a grounded start, refuse to declare an aim
      // square with no BSP floor (the deliberate stand_on exit itself is
      // exempt — boundary handling owns that). A dumb server would accept the
      // packet and strand the character outside the environment.
      {
        const aimSqC = Math.floor(aimX / KOD_FINENESS), aimSqR = Math.floor(aimY / KOD_FINENESS);
        const destSqC = this.destProto ? Math.floor(this.destProto.x / KOD_FINENESS) : null;
        const destSqR = this.destProto ? Math.floor(this.destProto.y / KOD_FINENESS) : null;
        const aimIsExit = this._destIsStandOn === true && aimSqC === destSqC && aimSqR === destSqR;
        if (!startIsVoid && !aimIsExit && transitBanned(this.session?.world?.geometry, aimSqR, aimSqC) === true) {
          this.stuckTicks++;
          return { state: 'stuck', why: 'aim has no floor' };
        }
      }
      // Cheat-clean send: gated to 1/s. Ungated this fires every tick (10/s)
      // and flags the account (speedhack counter threshold 2).
      const vServerPX = curCol * KOD_FINENESS + HALF, vServerPY = curRow * KOD_FINENESS + HALF;
      const gateOk = this._movementGateOk(aimX, aimY, myProtoX, myProtoY, vServerPX, vServerPY);
      // TEMP BISECT (t4 freeze): bypass gate once to test if submits flow.
      const bisect = process.env.M59_BISECT_SEND === '1';
      if (bisect || gateOk) {
        this._submitMove(s, c, () => c.moveTo(Math.round(aimX), Math.round(aimY), speed, c.room?.id ?? 0));
        if (process.env.M59_MOVE_DEBUG !== '0')
          console.error(`[movedbg] t3 gateOK vel aim=(${Math.round(aimX)},${Math.round(aimY)}) sq=(${Math.floor(aimX / KOD_FINENESS)},${Math.floor(aimY / KOD_FINENESS)}) me=(${me.col},${me.row}) idx=${this.pathIdx}/${this.path ? this.path.length : 'null'} stuck=${this.stuckTicks} srv=(${curCol},${curRow}) speed=${speed} moveTo sent`);
        this._recordSend(aimX, aimY, myProtoX, myProtoY);
        this._recordReport(aimX, aimY);
      }
        return { state: 'moving', velocity: true, speed };
      }
    }

    // FOLLOW THE PATH: head toward the current waypoint.
    // If path is null (no fine path found), go directly to
    // the destination. The server is client-authoritative.
    const wp = this.path ? this.path[this.pathIdx] : null;
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
      const destGroundOk = this._destIsStandOn === true || transitBanned(geoRef, destRow, destCol) !== true;
      if (distToDest0 < KOD_FINENESS * 4 && (destFineOk === false || noPathToNearDest || standOnNear) && destGroundOk) {
        const rx = this.destProto.x - myProtoX, ry = this.destProto.y - myProtoY;
        const rd = Math.hypot(rx, ry) || 1;
        const stepProto = Math.min(rd, KOD_FINENESS);
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
            this._submitMove(s, c, () => s.client.moveTo(rawX, rawY, 18, s.client.room?.id ?? 0));
            this._recordSend(this.destProto.x, this.destProto.y, myProtoX, myProtoY);
          }
          if (Date.now() - (this._lastRawLogAt ?? 0) > 5000) {
            this._lastRawLogAt = Date.now();
            console.error(`[raw-door-push] my=(${Math.round(myProtoX)},${Math.round(myProtoY)}) dest=(${destCol},${destRow}) dist=${distToDest0.toFixed(0)} wp=${wp?'yes':'no'}`);
          }
          this.path = null;  // drop any stale path; we're pushing through the gap
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
          const sqGroundOk = sqIsExit || transitBanned(geo, sqR, sqC) !== true;
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
            this._submitMove(s, c, () => c.moveTo(sx, sy, npSpeed, c.room?.id ?? 0));
            this._recordSend(this.destProto.x, this.destProto.y, myProtoX, myProtoY);
            this._recordReport(sx, sy);
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
        { meCol: myCol, meRow: myRow, goalCol: destCol, goalRow: destRow });
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
          if (!isExitDest1 && transitBanned(geo, nr, nc) === true) continue;
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
        this._recordSend(this.destProto.x, this.destProto.y, myProtoX, myProtoY);
        this._recordReport(stepProtoX, stepProtoY);
        this._noteServerStatic(curCol, curRow);
      }
      return { state: 'moving', to: { col: stepCol, row: stepRow } };
    }

    const dx = wp.x - myProtoX;
    const dy = wp.y - myProtoY;
    const dist = Math.hypot(dx, dy);

    // ARRIVED AT WAYPOINT (within 1 square): advance to the next one.
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
      // Send the next waypoint.
      const nextWp = this.path[this.pathIdx];
      if (nextWp) {
        this._sendWaypoint(nextWp.x, nextWp.y, c, s, me);
        return { state: 'moving', to: { x: Math.round(nextWp.x), y: Math.round(nextWp.y) } };
      }
      return { state: 'moving' };
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
    const ordered1 = orderCandidates(candidates, this._recentSteps, this.stuckTicks,
      { meCol: myCol, meRow: myRow, goalCol: wpCol, goalRow: wpRow });
    // REFUSAL ACCOUNTING (motion-only diagnostics): when no candidate
    // survives, the log must say WHICH check walled us in — otherwise
    // "stuck" is a mystery and we can't tell a real wall from an
    // over-strict validator. Counted by first-failing check, logged once
    // below when stepCol stays null.
    const rejects = { fine: 0, embedded: 0, edge: 0, void: 0 };
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
      if (f === false) { rejects.fine++; continue; }       // fine says blocked
      // BODY CHECK (same rule as the no-path branch): never enter a crack.
      if (isEmbedded(geo, myProtoX, myProtoY) !== true
          && isEmbedded(geo, nc * KOD_FINENESS + HALF, nr * KOD_FINENESS + HALF) === true) { rejects.embedded++; continue; }
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
            && !tryT(px*256,py*256) && !tryT(-px*256,-py*256)) { rejects.edge++; continue; }
      }
      // NEVER ENTER A VOID: from a grounded start, reject neighbors with no
      // BSP floor (the deliberate stand_on exit square itself is exempt). A
      // dumb server accepts any declared position, so the check must live here.
      if (!startIsVoid) {
        const destSqC0 = this.destProto ? Math.floor(this.destProto.x / KOD_FINENESS) : null;
        const destSqR0 = this.destProto ? Math.floor(this.destProto.y / KOD_FINENESS) : null;
        const isExitDest0 = this._destIsStandOn === true && nc === destSqC0 && nr === destSqR0;
        if (!isExitDest0 && transitBanned(geo, nr, nc) === true) { rejects.void++; continue; }
      }
      if (f === true) { stepCol = nc; stepRow = nr; break; }  // fine says ok
      if (f === undefined && s === false) continue;   // no fine data, coarse blocked
      stepCol = nc; stepRow = nr; break;              // fine ok, or no data
    }
    if (stepCol == null) {
      // Name the wall: which check rejected all 8 neighbors.
      if (process.env.M59_MOVE_DEBUG !== '0')
        console.error(`[movestuck] t3 me=(${myCol},${myRow}) srv=(${curCol},${curRow}) wp=(${wpCol},${wpRow}) rejects=${JSON.stringify(rejects)}`);
      // No fine-reachable neighbor: the fine model has walled us in. The server is
      // CLIENT-AUTHORITATIVE (it does not check geometry), so a fine-wall here may be
      // a model mismatch, not a real wall (the Raza Blacksmith traps a character exactly
      // this way: every fine step is blocked, but the server accepts the step the fine
      // grid calls a wall). Do NOT jump straight to a blind blink. Instead initiate the
      // VERIFIED raw-move FAN: it fires one raw move per tick in 8 directions, and the
      // position-change check (FAN PROGRESS above) only commits if the SERVER actually
      // moved us. If a direction is server-accepted we walk out; if all 8 are refused the
      // fan itself falls back to blink (handled in the fan-progress block). This tries the
      // cheaper, safer escape first and only blinks when the server refuses every step.
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
          console.error(`[movedbg] t3 gateOK step=(${stepCol},${stepRow}) me=(${me.col},${me.row}) wp=(${wpCol},${wpRow}) idx=${this.pathIdx}/${this.path ? this.path.length : 'null'} stuck=${this.stuckTicks} srv=(${curCol},${curRow}) moveTo sent`); })
        .catch(e => { if (process.env.M59_MOVE_DEBUG !== '0')
          console.error(`[movedbg] t3 gateOK step=(${stepCol},${stepRow}) ERR ${e.message}`); });
      this._recordSend(this.destProto.x, this.destProto.y, myProtoX, myProtoY);
      this._recordReport(enrProtoX, enrProtoY);
      this._noteServerStatic(curCol, curRow);
    } else {
      if (process.env.M59_MOVE_DEBUG !== '0')
        console.error(`[movedbg-gate] t3 gateCLOSED step=(${stepCol},${stepRow}) me=(${me.col},${me.row}) server=(${myProtoX},${myProtoY}) lastReport=(${this._lastReportX},${this._lastReportY}) interval=${Date.now()-this._lastReportAt}ms`);
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
      if (process.env.M59_MOVE_DEBUG !== '0')
        console.error(`[movestuck] t3 server static x${this.stuckTicks} sends at srv=(${curCol},${curRow}) sim=(${myCol},${myRow}) — re-anchoring sim to server`);
      this._simX = null; this._simY = null; this._simAt = 0;
      try { this.session?._pose?.reset(); } catch {}
      this.path = null; this.pathIdx = 0;
      this._lastWpKey = null;
      this._fanIndex = null; this._fanTarget = null; this._fanFrom = null;
      return { state: 'stuck', why: `server static across ${this.stuckTicks} sends — sim re-anchored to server` };
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
    this._lastReportAt = Date.now();
    this._lastReportX = protoX;
    this._lastReportY = protoY;
    this._simX = protoX;
    this._simY = protoY;
    this._simAt = Date.now();
    // Keep the shared Pose in step with our own feet (single position truth).
    try { this.session?._pose?.advance(protoX, protoY); } catch {}
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
  _submitMove(s, c, sendFn) {
    if (!this._claimMoveSlot()) return false;
    Promise.resolve(s.pacer.submit('move', sendFn, 100)).catch(() => {});
    return true;
  }

  // Claim one move slot without submitting (for the raw direct-send sites
  // that bypass the pacer to avoid queue delay).
  _claimMoveSlot() {
    const t = Date.now();
    if (t - (this._lastMoveSubmitAt ?? 0) < (this._moveCapMs ?? 1050)) return false;
    this._lastMoveSubmitAt = t;
    return true;
  }

  // SERVER-STATIC TRACKING (shared): the raw direct-send sites bypassed
  // _sendStep/_sendWaypoint, so stuckTicks froze at 0 while sends flowed
  // and the server never moved — fan, diagnostics, and stand logic blind.
  _noteServerStatic(col, row) {
    if (col == null || row == null) return;
    if (this.lastPos && this.lastPos.col === col && this.lastPos.row === row) this.stuckTicks++;
    else this.stuckTicks = 0;
    this.lastPos = { col, row };
  }

  // Returns true if a position packet was actually sent this tick.
  _maybeReportPosition(protoX, protoY, c, s, serverX, serverY) {
    if (!this._movementGateOk(protoX, protoY, serverX, serverY, serverX, serverY)) return false;
    const px = Math.round(protoX), py = Math.round(protoY);
    this._submitMove(s, c, () => c.moveTo(px, py, 18, c.room?.id ?? 0));
    this._recordSend(this.destProto?.x ?? protoX, this.destProto?.y ?? protoY, protoX, protoY);
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
    // walking toward the waypoint regardless. Tracked on SERVER squares, not the
    // sim: the sim advances on every send by construction, so sim-based tracking
    // can never observe a stall (every refused send looks like progress).
    const sc = s?.client?.self;
    const kCol = (sc && Number.isFinite(sc.col)) ? sc.col : me?.col;
    const kRow = (sc && Number.isFinite(sc.row)) ? sc.row : me?.row;
    if (me && this.lastPos && this.lastPos.col === kCol && this.lastPos.row === kRow) {
      this.stuckTicks++;
    } else {
      this.stuckTicks = 0;
    }
    if (me) this.lastPos = { col: kCol, row: kRow };
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
    this._submitMove(s, c, () => c.moveTo(px, py, 18, c.room?.id ?? 0));
    this.drX = protocolToClient(px);
    this.drY = protocolToClient(py);

    if (me && this.lastPos && this.lastPos.col === me.col && this.lastPos.row === me.row) {
      this.stuckTicks++;
    } else {
      this.stuckTicks = 0;
    }
    if (me) this.lastPos = { col: me.col, row: me.row };
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
    if (!_travelMode) {
      const blinked = this._tryBlink();
      if (blinked) {
        this._blinkFrom = { x: curX, y: curY };
        return { state: 'blink', why: 'all 8 raw moves refused, casting blink' };
      }
    } else if (process.env.M59_MOVE_DEBUG !== '0') {
      console.error(`[movestuck] t3 travel-mode pocket: all 8 raw moves refused at srv=(${this.lastPos?.col},${this.lastPos?.row}) — blink parked, holding`);
    }
    return { state: 'stuck', why: 'server refused all 8 raw move directions' };
  }
  _tryBlink() {
    // PHASE 0c fix: don't cast blink while moving. Movement breaks
    // concentration and the cast fails. Only blink when the character is
    // stalled (stuckTicks > 0 = no position change since the last tick).
    if (this.stuckTicks === 0) return false; // moving, don't blink
    const c = this.session?.client;
    if (!c?.cast) return false;
    const blink = (c.spells ?? []).find(sp => {
      const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
      return n.toLowerCase() === 'blink';
    }) ?? (c.skills ?? []).find(sp => {
      const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
      return n.toLowerCase() === 'blink';
    });
    if (!blink) return false;
    try {
      // STAND BEFORE BLINK: a resting character has PFLAG_NO_MAGIC set
      // (player.kod:1166) and the server refuses the cast whole. UC_STAND ->
      // StopResting() -> ResetPlayerFlagList() clears the flag; wait 2s for
      // the server to process it before the cast begins.
      this.session.pacer.submit('stand', () => c.stand?.()).catch(() => {});
      setTimeout(() => {
        const rec = this.session.pacer.submit('blink', () => c.cast(blink.id, []), 1500);
        Promise.resolve(rec).catch(() => {});
        this._blinkPending = true;
        this._blinkAt = Date.now();
      }, 2000);
      return true;
    } catch { return false; }
  }
}
