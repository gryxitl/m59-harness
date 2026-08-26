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

import { protocolToClient, clientToProtocol, KOD_FINENESS, PLAYER_RADIUS } from './m59-roo.mjs';
import './m59-navgeom.mjs';   // installs the height model + lenient fine path onto RoomGeometry

// 256 client units = 16 protocol units per 100ms tick (walking).
// Running is 2 * MOVEUNITS = 32 protocol units.
// How many recent squares the shuffle detector remembers, and how few distinct ones count as
// going nowhere. Six samples and two squares catches the A-B-A-B bounce without flagging a
// character legitimately squeezing through a doorway.
export const SHUFFLE_WINDOW = 6;
export const SHUFFLE_SQUARES = 2;

export const MOVEUNITS_PROTO = 16;
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
  constructor(session, { now = () => Date.now() } = {}) {
    this.session = session;
    // AN INJECTABLE CLOCK, BECAUSE THE MOVER IS THROTTLED BY WALL TIME.
    //
    // Position reports are gated to one per MOVE_INTERVAL_MS, which is right against a
    // real server and untestable against a loop. m59-mover-test drove 200 ticks in about a
    // millisecond: the first send went out, the gate shut, and the other 199 did nothing —
    // so "the mover routed around the wall" failed reporting `states: moving` and looked
    // like a pathfinding bug rather than a stopped clock. Router already takes its clock
    // this way; this brings Mover into line.
    this.now = now;
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
    this._lastWpKey = null;
  }

  /**
   * Set the destination. col/row are protocol square coordinates
   * (the same space as client.self.col/.row).
   */
  to(col, row) {
    // A NEW destination (different from the current one) resets the lazy-report gate so the
    // first position packet goes out immediately. The router calls to() every tick with the
    // same aim while walking, so we must NOT reset on a no-op to() — that would defeat the
    // gate and send a packet every tick again. Only a genuine re-route resets it.
    const isNewDest = !this.dest || this.dest.col !== col || this.dest.row !== row;
    this.dest = { col, row };
    // Centre of the destination square in protocol units.
    this.destProto = {
      x: col * KOD_FINENESS + HALF,
      y: row * KOD_FINENESS + HALF,
    };
    if (isNewDest) {
      this._lastReportAt = 0;
      this._lastReportX = null;
      this._lastReportY = null;
      this.path = null;      // re-plan on a new destination
      this.pathIdx = 0;
      this.stuckTicks = 0;
      this._fanIndex = null;
      this._fanTarget = null;
      this._fanFrom = null;
      this._blinkPending = false;
      this._blinkFrom = null;
      this._lastWpKey = null;
    }
    // A no-op to() (same destination, called every tick by the router) changes NOTHING.
    // It does not re-plan, does not reset stuckTicks (so the stuck detector can still
    // accumulate), and does not reset the lazy-report gate. This is what makes the gate
    // work despite the router calling to() at 10Hz.
  }

  clear() {
    this.dest = null;
    this.destProto = null;
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
    this._lastWpKey = null;
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
    const result = geo.finePathProtocol(
      fromProtoX, fromProtoY,
      this.destProto.x, this.destProto.y,
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
    const s = this.session;
    const c = s?.client;
    if (!c || c.state !== 'game') return { state: 'not-in-game' };

    const me = posOverride ?? c.self;
    if (!me || me.col == null) return { state: 'no-position' };

    // THE SITTING TRAP: PFLAG_NO_MOVE refuses every move silently.
    // Stand first.
    if (this.sitting) {
      this.sitting = false;
      const rec = s.pacer.submit('stand', () => c.stand(), 0);
      Promise.resolve(rec).catch(() => {});
      return { state: 'standing' };
    }

    // Use the CURRENT position for waypoint distance and the lazy-report gate.
    // client.self is updated by every position packet (the source the probe/room-view
    // use) and is more current than world.position (updated by confirmPosition at 2s
    // cadence). Using the stale world.position makes the Mover path from an old position
    // and never report 'arrived' at a sub-waypoint it has physically reached. Fall back
    // to the frame's me when client.self is unavailable.
    const selfPos = s.client?.self;
    const curCol = (selfPos && selfPos.col != null) ? selfPos.col : me.col;
    const curRow = (selfPos && selfPos.row != null) ? selfPos.row : me.row;
    const myProtoX = (selfPos && selfPos.x != null) ? selfPos.x : (curCol * KOD_FINENESS + HALF);
    const myProtoY = (selfPos && selfPos.y != null) ? selfPos.y : (curRow * KOD_FINENESS + HALF);
    // Keep DR in sync with current position for the fine model's collision checks.
    this.drX = protocolToClient(myProtoX);
    this.drY = protocolToClient(myProtoY);
    // The 'arrived' and gate checks below use curCol/curRow (the current position).
    const effMe = { col: curCol, row: curRow, x: myProtoX, y: myProtoY };

    // BLINK PROGRESS: if we cast blink last tick, check if position changed.
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
          this.stuckTicks = 0;
          this.path = null; // replan from new position
          return { state: 'blinked', why: 'position changed after blink' };
        }
      }
      this._blinkPending = false;
      this._blinkFrom = null;
    this._lastWpKey = null;
    }

    // FAN PROGRESS: if we fired a raw move last tick, check position.
    if (this._fanTarget != null) {
      const curX = protocolToClient(me.x ?? (me.col * KOD_FINENESS + HALF));
      const curY = protocolToClient(me.y ?? (me.row * KOD_FINENESS + HALF));
      if (Math.hypot(curX - this._fanFrom?.x ?? curX, curY - this._fanFrom?.y ?? curY) > 8) {
        // Raw move worked!
        this.drX = curX;
        this.drY = curY;
        this._fanTarget = null;
        this._fanFrom = null;
        this._fanIndex = null;
        this.stuckTicks = 0;
        this.path = null; // replan
      } else {
        this._fanIndex = (this._fanIndex ?? 0) + 1;
        if (this._fanIndex >= 9) {
          this._fanTarget = null;
          this._fanFrom = null;
          this._fanIndex = null;
          this.stuckTicks++;
          const blinked = this._tryBlink();
          if (blinked) {
            this._blinkFrom = { x: curX, y: curY };
            return { state: 'blink', why: 'all 8 raw moves refused, casting blink' };
          }
          return { state: 'stuck', why: 'server refused all 8 raw move directions' };
        }
        // Fall through: fire next fan heading below.
      }
    }

    // ARRIVED: check if we're at the destination.
    const destDist = Math.hypot(this.destProto.x - myProtoX, this.destProto.y - myProtoY);
    if (destDist < KOD_FINENESS * 0.5) { // within ~0.5 protocol units
      this.clear();
      return { state: 'arrived', position: { col: effMe.col, row: effMe.row } };
    }

    // PLAN: if no path yet, or we're stuck, plan a new one.
    const needPlan = this.path == null
      || this.pathIdx >= this.path.length
      || this.stuckTicks > 10;
    if (needPlan) {
      const result = this._plan(myProtoX, myProtoY);
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
      this.stuckTicks = 0;
    }

    // If the fan is active (we were in raw-move fallback), fire the next heading.
    if (this._fanTarget != null || (this._fanIndex != null && this._fanIndex < 9)) {
      const FAN = [0, -0.35, 0.35, -0.75, 0.75, -1.2, 1.2, -1.7, 1.7];
      const idx = this._fanIndex ?? 0;
      const angle = FAN[idx % FAN.length];
      // Direction to destination for the base angle.
      const dx = this.destProto.x - myProtoX;
      const dy = this.destProto.y - myProtoY;
      const dist = Math.hypot(dx, dy);
      const baseAngle = Math.atan2(dy, dx);
      const finalAngle = baseAngle + angle;
      const stepProto = Math.min(dist, MOVEUNITS_PROTO);
      const fx = myProtoX + Math.cos(finalAngle) * stepProto;
      const fy = myProtoY + Math.sin(finalAngle) * stepProto;
      const px = Math.round(fx);
      const py = Math.round(fy);
      Promise.resolve(s.pacer.submit('move', () => c.moveTo(px, py, 18, c.room?.id ?? 0), 100)).catch(() => {});
      this._fanTarget = { x: protocolToClient(fx), y: protocolToClient(fy) };
      this._fanFrom = { x: myX, y: myY };
      this._fanIndex = idx;
      return { state: 'raw-move', fanIndex: idx };
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
      if (distToDest0 < KOD_FINENESS * 4 && (destFineOk === false || noPathToNearDest)) {
        const rx = this.destProto.x - myProtoX, ry = this.destProto.y - myProtoY;
        const rd = Math.hypot(rx, ry) || 1;
        const stepProto = Math.min(rd, KOD_FINENESS);
        const rawX = Math.round(myProtoX + (rx / rd) * stepProto);
        const rawY = Math.round(myProtoY + (ry / rd) * stepProto);
        if (this.now() - (this._lastRawLogAt ?? 0) > 2000) {
          this._lastRawLogAt = this.now();
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
        if (this.now() - (this._lastRawPushAt ?? 0) >= 500) {
          this._lastRawPushAt = this.now();
          Promise.resolve(s.pacer.submit('move', () => s.client.moveTo(rawX, rawY, 18, s.client.room?.id ?? 0), 100)).catch(() => {});
        }
        if (this.now() - (this._lastRawLogAt ?? 0) > 5000) {
          this._lastRawLogAt = this.now();
          console.error(`[raw-door-push] my=(${Math.round(myProtoX)},${Math.round(myProtoY)}) dest=(${destCol},${destRow}) dist=${distToDest0.toFixed(0)} wp=${wp?'yes':'no'}`);
        }
        this.path = null;  // drop any stale path; we're pushing through the gap
        return { state: 'moving', to: { col: destCol, row: destRow }, raw: true };
      }
    }
    if (!wp) {
      // Past the last waypoint (or no path): walk toward
      // the destination one square at a time, using the same
      // candidate search as the waypoint branch (validate each
      // candidate against the fine grid, try alternatives).
      if (this.path) this.pathIdx = this.path.length;
      const dx = this.destProto.x - myProtoX;
      const dy = this.destProto.y - myProtoY;
      const dist = Math.hypot(dx, dy);
      if (dist < KOD_FINENESS * 0.5) {
        this.clear();
        return { state: 'arrived', position: { col: effMe.col, row: effMe.row } };
      }
      const myCol = Math.floor(myProtoX / KOD_FINENESS);
      const myRow = Math.floor(myProtoY / KOD_FINENESS);
      const destCol = Math.floor(this.destProto.x / KOD_FINENESS);
      const destRow = Math.floor(this.destProto.y / KOD_FINENESS);
      const geo = this.session?.world?.geometry;
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
      for (const [nc, nr] of candidates) {
        const f = geo?.fineWalkable ? geo.fineWalkable(nr, nc) : undefined;
        const c = geo?.walkable ? geo.walkable(nr, nc) : undefined;
        if (f === false) continue;
        if (f === undefined && c === false) continue;
        stepCol = nc; stepRow = nr;
        break;
      }
      if (stepCol == null) {
        // No fine-reachable neighbor. Initiate the verified raw-move fan (server-confirmed
        // escape) before declaring blocked — see the waypoint branch for the rationale.
        this.stuckTicks++;
        if (this._fanIndex == null && this._fanTarget == null && this.stuckTicks >= 3) {
          this._fanIndex = 0;
          this._fanFrom = { x: myProtoX, y: myProtoY };
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
        Promise.resolve(s.walkTo(stepCol, stepRow, { steps: 1 })).catch(() => {});
        this._recordReport(stepProtoX, stepProtoY);
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
        // Past all waypoints: go to destination directly.
        const dd = Math.hypot(this.destProto.x - myProtoX, this.destProto.y - myProtoY);
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
    // pacing-back-and-forth between valid and invalid.
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
    // Find the first candidate that is valid.
    let stepCol = null, stepRow = null;
    for (const [nc, nr] of candidates) {
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
      if (f === false) continue;                      // fine says blocked
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
            && !tryT(px*256,py*256) && !tryT(-px*256,-py*256)) continue;
      }
      if (f === true) { stepCol = nc; stepRow = nr; break; }  // fine says ok
      if (f === undefined && s === false) continue;   // no fine data, coarse blocked
      stepCol = nc; stepRow = nr; break;              // fine ok, or no data
    }
    if (stepCol == null) {
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
        this._fanFrom = { x: myProtoX, y: myProtoY };
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
      s.walkTo(stepCol, stepRow, { steps: 1 })
        .then(wr => { if (process.env.M59_MOVE_DEBUG !== '0')
          console.error(`[movedbg] t3 gateOK step=(${stepCol},${stepRow}) me=(${me.col},${me.row}) walkTo=>${JSON.stringify(wr)}`); })
        .catch(e => { if (process.env.M59_MOVE_DEBUG !== '0')
          console.error(`[movedbg] t3 gateOK step=(${stepCol},${stepRow}) ERR ${e.message}`); });
      this._recordReport(enrProtoX, enrProtoY);
    } else {
      if (process.env.M59_MOVE_DEBUG !== '0')
        console.error(`[movedbg-gate] t3 gateCLOSED step=(${stepCol},${stepRow}) me=(${me.col},${me.row}) server=(${myProtoX},${myProtoY}) lastReport=(${this._lastReportX},${this._lastReportY}) interval=${this.now()-this._lastReportAt}ms`);
    }
    // A SHUFFLE IS A STALL, AND STILLNESS IS NOT THE ONLY WAY TO STAND STILL.
    //
    // This counted a tick as stuck only when the square did not change, so a body bouncing
    // between two squares cleared the counter on every sample and could shuffle for ever.
    // Watched live on JayB in room 1012: 257 walkTo calls, every one returning arrived:true,
    // alternating (32,11) -> (33,11) -> (32,11) for eighteen minutes while `travel` reported
    // progress and the stuck detector never fired once. He never reached the Mausoleum and
    // never swung at anything.
    //
    // So: remember the last few squares and ask whether the body is actually GETTING
    // ANYWHERE. Revisiting a square we stood on two or three moves ago is not travel, and it
    // is the commonest shape of a stalled route — docs/m59-routing.md has the warning this
    // code did not implement.
    if (me) {
      this._recent = this._recent ?? [];
      const key = `${me.col},${me.row}`;
      const revisit = this._recent.includes(key);
      this._recent.push(key);
      if (this._recent.length > SHUFFLE_WINDOW) this._recent.shift();
      const distinct = new Set(this._recent).size;
      const stillHere = this.lastPos && this.lastPos.col === me.col && this.lastPos.row === me.row;
      // Stuck when we did not move at all, OR when the last SHUFFLE_WINDOW moves only ever
      // touched a couple of squares and we are back on one of them.
      if (stillHere || (this._recent.length >= SHUFFLE_WINDOW && distinct <= SHUFFLE_SQUARES && revisit))
        this.stuckTicks++;
      else this.stuckTicks = 0;
      this.lastPos = { col: me.col, row: me.row };
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
    const now = this.now();
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
    const movedEnough = moved2 > MOVE_THRESHOLD_PROTO2;
    const intervalOk = (now - this._lastReportAt) >= MOVE_INTERVAL_MS;
    return movedEnough && intervalOk;
  }
  _recordReport(protoX, protoY) {
    this._lastReportAt = this.now();
    this._lastReportX = protoX;
    this._lastReportY = protoY;
  }

  // Returns true if a position packet was actually sent this tick.
  _maybeReportPosition(protoX, protoY, c, s, serverX, serverY) {
    if (!this._movementGateOk(protoX, protoY, serverX, serverY, serverX, serverY)) return false;
    const px = Math.round(protoX), py = Math.round(protoY);
    Promise.resolve(s.pacer.submit('move', () => c.moveTo(px, py, 18, c.room?.id ?? 0), 100)).catch(() => {});
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
    // walking toward the waypoint regardless. If the SERVER position isn't changing,
    // that's a stall even if we're not (yet) reporting.
    if (me && this.lastPos && this.lastPos.col === me.col && this.lastPos.row === me.row) {
      this.stuckTicks++;
    } else {
      this.stuckTicks = 0;
    }
    if (me) this.lastPos = { col: me.col, row: me.row };
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
    Promise.resolve(s.pacer.submit('move', () => c.moveTo(px, py, 18, c.room?.id ?? 0), 100)).catch(() => {});
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
    const now = this.now();
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
  _tryBlink() {
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
      const rec = this.session.pacer.submit('blink', () => c.cast(blink.id, []), 1500);
      Promise.resolve(rec).catch(() => {});
      this._blinkPending = true;
      return true;
    } catch { return false; }
  }
}
