// THE CONTROLLER, WEARING THE MOVER'S INTERFACE.
//
// `m59-combat.mjs:_walkTo` drives `session._mover` with `to(col,row)` then `tick(me)` every
// pass, and acts on three of the states that come back: `arrived` clears the walk, `no-route`
// blacklists the target, `stuck` escalates to a blink. That is the seam the fleet actually
// moves through — `Actuator.walk()` and `session.walkTo` carry travel and errands, not combat
// — so this is where a new mover has to fit.
//
// WHY REPLACE IT AT ALL. Measured on JayB in the Mausoleum over one run: 1,658 swings, 49
// walk attempts, 62 blinks, thirty seconds of standing still before each blink and 42 of the
// 62 from two adjacent squares. Every one of those squares is walkable, floored, and in the
// same 9,582-cell region as the mummy he was chasing — `sameRegion` says the route exists and
// the legacy mover could not walk it. Handed the same grid plan, the controller arrives on all
// five of the walks he was failing, in 3.4s to 18.9s, with zero blocked ticks:
//
//     (38,28) -> (22,30)   arrived 16.9s   157 waypoints   slid 0  blocked 0
//     (38,26) -> (22,30)   arrived 16.1s   149            slid 0  blocked 0
//     (23,20) -> (22,30)   arrived  4.1s    40            slid 0  blocked 0
//     (38,28) -> (20,34)   arrived 18.9s   175            slid 0  blocked 0
//     (26,24) -> (22,30)   arrived  3.4s    32            slid 0  blocked 0
//
// AND IT PLANS ON THE GRID, NOT THE TRACE. `m59-navtrace.mjs` refuses all five of those walks,
// because `traceFineMoveClient` disagrees with `moverStepLands` on 16% of this room's steps and
// the refusals cluster at doorways. The grid plan was never the problem; executing it was. Keep
// M59_NAV_TRACE=off here until that disagreement is closed — see docs/m59-controller-plan.md.
//
// FALLING BACK IS NOT OPTIONAL. Rooms without collision geometry exist, and a character whose
// mover has no opinion must not stand still. Anything this cannot answer goes to the mover the
// router built, which is kept and delegated to rather than discarded.
import { CharacterController, TELEPORT_SQUARES, DIVERGENCE_SQUARES,
         MAX_LEAD_SQUARES, CLIENT_PER_SQUARE } from './m59-controller.mjs';

// How many consecutive ticks the controller may report no progress before we tell the keeper
// `stuck` and let it blink. The legacy mover waited 30s; three seconds is long enough to be a
// real obstruction and short enough that a blink is still cheap.
const STUCK_TICKS = 30;

// HAND BACK RATHER THAN STAND STILL.
//
// The controller executes a grid plan against the FINE geometry, and the two disagree in
// places: from (3,17) in the Mausoleum it walks to (22,30) in 12.4s, but the same planner's
// 76-waypoint route to (2,35) — where the mummies are — is refused on the ninth tick and the
// body never leaves the square. The grid says region 0 for both, so this is not a pocket; it
// is the 8-25% step disagreement in docs/m59-controller-plan.md, and no amount of adapter
// work closes it.
//
// The legacy mover already handles these spots — verified escape fans, raw server-confirmed
// moves, blink. So a destination the controller cannot make progress on is DELEGATED for as
// long as that destination stands, rather than being reported as stuck. The controller keeps
// everything it is better at and gives back the cases it is worse at, which is the only
// honest arrangement while the two geometries disagree.
const HANDBACK_TICKS = 12;

// MOVE_OFF_ROOM_INTERVAL in clientd3d/move.c. One request a second while pressed against a
// boundary; the client rate-limits identically.
const OFF_ROOM_INTERVAL_MS = 1000;



export class ControllerMover {
  constructor(session, fallback) {
    this.session = session;
    this.fallback = fallback;          // the router's Mover, kept for what we cannot do
    this.ctl = new CharacterController();
    this.dest = null;
    this.active = false;
    this._lastTickAt = 0;
    this._lastReconcileAt = 0;
    this._room = null;         // the room our believed position belongs to
    this._noProgress = 0;
    this._sentSeen = 0;
    this.stats = { ticks: 0, arrived: 0, stuck: 0, noRoute: 0, delegated: 0, replans: 0,
                   moving: 0, blockedTicks: 0, planFail: 0 };
    this._lastSummary = 0;
    this._agent = session?.agent ?? session?.name ?? '?';
  }

  _geo() { return this.session?.world?.geometry ?? this.session?._roomGeo ?? null; }

  to(col, row) {
    // A destination that is not a place gets handed straight back. Reporting `no-route` for it
    // is worse than useless: the caller reads that as "this quarry is unreachable" and
    // blacklists it, when in fact nobody ever named a square. Lee sat at the West Jasper
    // border on four of these in a row.
    if (!Number.isFinite(col) || !Number.isFinite(row)) {
      this.stats.badDest = (this.stats.badDest || 0) + 1;
      if (this.stats.badDest <= 3)
        console.error(`[ctlmover] ${this._agent} refused a destination that is not a place (${col},${row})`);
      try { this.fallback?.to?.(col, row); } catch { /* it is a fallback, not a dependency */ }
      return;
    }
    // AN OFF-MAP TARGET IS A CROSSING, NOT A DESTINATION.
    //
    // An edge exit fires by walking PAST the boundary, so the router aims one square beyond it
    // — column 0 for a west edge, row 0 for a north one. Those squares do not exist, navPath
    // cannot plan to them, and every attempt came back a plan failure: 99,593 of 178,420 ticks
    // (56%), with the body oscillating between two staging squares — (1,30) aiming (0,30),
    // then (1,42) aiming (0,42), and back — never crossing.
    //
    // The legacy mover knows how to push across a boundary with a raw server-confirmed move.
    // This is its job, so give it straight over rather than planning a route to nowhere.
    const geo = this._geo();
    const offMap = col < 1 || row < 1
      || (geo?.cols != null && col > geo.cols) || (geo?.rows != null && row > geo.rows);
    if (offMap) {
      this.stats.offMapCrossings = (this.stats.offMapCrossings || 0) + 1;
      if (this.stats.offMapCrossings <= 3)
        console.error(`[ctlmover] ${this._agent} (${col},${row}) is off the map — a boundary crossing`);
      this.dest = { col, row };
      this.crossing = { col, row };        // handled by _requestOffRoom, not by walking
      this.active = false;                 // the controller is not steering this one
      try { this.fallback?.to?.(col, row); } catch { /* fallback, not a dependency */ }
      return;
    }
    this.crossing = null;

    const isNew = !this.dest || this.dest.col !== col || this.dest.row !== row;
    this.dest = { col, row };
    this.active = true;
    // The legacy mover has to keep tracking the aim even while we are steering, or a
    // delegated tick would resume against a stale destination.
    try { this.fallback?.to?.(col, row); } catch { /* it is a fallback, not a dependency */ }
    if (isNew) {
      // NOT resetting _noProgress here. The quarry MOVES, so a fight re-aims every few ticks,
      // and clearing the counter on each new aim means a wedged body never reports stuck:
      // watched live, JayB sat at (3,17) for 736 ticks with stuck=0 while the destination
      // walked from (11,26) to (3,35) to (10,25) to (4,29) to (12,24). The probe said
      // 'no fine path' the whole time and nothing escalated, because the counter kept being
      // forgiven. Progress is a property of the BODY, not of the aim.
      this._plannedFor = null;           // force a plan on the next tick
      this._handedBack = false;          // a new aim deserves a fresh try
    }
  }

  // Passed through untouched: the decider calls it every pass and it belongs to the legacy
  // mover's lazy position reporting, which still runs for travel.
  // The client's off-room request: speed 0, the coordinates OUTSIDE the room, once a second.
  _requestOffRoom(c) {
    const x = this.crossing;
    if (!x || !c) return;
    const now = Date.now();
    if (now - (this._offRoomAt ?? 0) < OFF_ROOM_INTERVAL_MS) return;
    this._offRoomAt = now;
    // Protocol units, the same conversion every other send uses.
    const px = Math.round((x.col - 0.5) * CLIENT_PER_SQUARE / 16 + 64);
    const py = Math.round((x.row - 0.5) * CLIENT_PER_SQUARE / 16 + 64);
    try {
      c.moveTo(px, py, 0, c.room?.id ?? 0);
      this.stats.offRoomRequests = (this.stats.offRoomRequests || 0) + 1;
      if (this.stats.offRoomRequests <= 3)
        console.error(`[ctlmover] ${this._agent} off-room request to (${x.col},${x.row}) at speed 0`);
    } catch (e) { /* the server answers by moving us, or not at all */ }
  }

  maybeConfirm(...a) { return this.fallback?.maybeConfirm?.(...a); }

  cancel() {
    this.active = false; this.dest = null;
    try { this.ctl.clear(); } catch { /* ignore */ }
    try { this.fallback?.cancel?.(); } catch { /* ignore */ }
  }

  _delegate(posOverride, why) {
    this.stats.delegated++;
    if (!this.fallback?.tick) return { state: 'blocked', why: why ?? 'no fallback mover' };
    return this.fallback.tick(posOverride);
  }

  _summarise(state) {
    const now = Date.now();
    if (now - this._lastSummary < 20000) return;
    this._lastSummary = now;
    const s = this.stats, c = this.ctl.stats ?? {};
    console.error(`[ctlmover] ${this._agent} ${state} dest=${this.dest ? `(${this.dest.col},${this.dest.row})` : '-'}`
      + ` at=(${this.ctl.square?.().col},${this.ctl.square?.().row})`
      + ` | ticks=${s.ticks} moving=${s.moving} arrived=${s.arrived} stuck=${s.stuck}`
      + ` noRoute=${s.noRoute} planFail=${s.planFail} blocked=${s.blockedTicks} delegated=${s.delegated}`
      + ` | ctl sent=${c.sent ?? 0} slid=${c.slid ?? 0} ctlBlocked=${c.blocked ?? 0} reconciled=${c.reconciled ?? 0} drift=${Math.round(c.drift_max ?? 0)}`
      + ` roomResyncs=${s.roomResyncs ?? 0}`);
  }

  // PHYSICS ON THE LOOP'S CLOCK, NOT THE DECIDER'S.
  //
  // tick() is called from m59-combat.mjs:_walkTo, which runs only when the decider picks a
  // walk. Measured on Lee: 352 mover ticks against 3,952 loop ticks — NINE PER CENT. The
  // controller integrates per call, so a body with a perfectly good 144-waypoint plan crossed
  // it at a tenth of walking speed, in bursts, standing still for twenty seconds at a stretch
  // with the path already in hand.
  //
  // So the loop advances the physics every tick and the decider keeps reading state. It is
  // safe to call both: dt comes from the wall clock, so the decider's call immediately after
  // integrates the ~0ms that remain rather than moving twice.
  //
  // This deliberately does NOT plan, and does NOT touch `active`. Planning and the no-route
  // answer belong to the decider's call, because `no-route` is how the keeper learns to
  // blacklist a quarry — swallowing it here would lose that signal.
  physicsTick() {
    if (!this.active || !this.dest || !this.ctl.path) return null;
    const c = this.session?.client;
    if (!c || c.state !== 'game') return null;
    const geo = this._geo();
    if (!geo?.collisionReady || this.ctl.x == null) return null;
    const now = Date.now();
    const dt = this._lastTickAt ? Math.min(now - this._lastTickAt, 1000) : 0;
    if (!dt) return null;
    this._lastTickAt = now;
    // THE LEAD CHECK BELONGS ON THE PATH THAT ACTUALLY INTEGRATES, AND THIS IS IT.
    //
    // `tick()` had this guard and `physicsTick` did not — but physicsTick is the one the
    // 10Hz loop drives, while tick() only runs when the decider gets round to it. So the
    // belief integrated freely between decisions and outran the server, and the divergence
    // check further down snapped it back: "believed (26,31) but the server says (24,39) —
    // 8 squares", over and over. Eight is exactly twice MAX_LEAD_SQUARES, which is what a
    // guard on the slow path and none on the fast one looks like from the outside. The
    // snap IS the rubberband; holding here is what stops it being needed.
    if (this._leadExceeded(c)) return null;
    try { return this.ctl.step(dt, { geo, client: c }); }
    catch { return null; }
  }

  // Is the belief further ahead than the server's echo can explain? Integrating past this
  // only builds a correction that has to be paid back as a visible snap. Holding keeps
  // replicating, so the confirmations catch up instead. Shared by both tick paths, because
  // a guard that only one of them honours is the same as no guard at all.
  _leadExceeded(c) {
    const here = c?.self;
    if (!here || !Number.isFinite(here.col) || !Number.isFinite(here.row)) return false;
    const b = this.ctl.square?.();
    if (!b || !Number.isFinite(b.col)) return false;
    if (Math.hypot(b.col - here.col, b.row - here.row) <= MAX_LEAD_SQUARES) return false;
    this.stats.held = (this.stats.held || 0) + 1;
    try { this.ctl.replicate(c, true); } catch { /* best effort */ }
    return true;
  }

  tick(posOverride) {
    this.stats.ticks++;
    // A crossing handed over in to() leaves us inactive with a destination still set: keep
    // feeding the legacy mover until the room changes or a new destination arrives.
    if (!this.active && this.dest) {
      // LEAVING A ROOM IS ITS OWN REQUEST, AND IT IS NOT A WALK.
      //
      // clientd3d/move.c, when the next step would land outside the room:
      //
      //     if (!IsInRoom(row, col, current_room)) {
      //        if (now - move_off_room_time >= MOVE_OFF_ROOM_INTERVAL)   // 1000ms
      //           RequestMove(y, x, 0, player.room_id);                  // SPEED ZERO
      //        x = last_x; y = last_y; z = last_z;                       // do not move locally
      //        break;
      //     }
      //
      // Speed 0 is the signal: it asks the SERVER to perform the transition, rather than
      // asking it to walk us to a square that does not exist. Every move we send carries
      // speed 18 or 32, so we have never once made that request — which is why a character
      // reaches the staging square and simply stands there. JayB walked thirty squares clean
      // across West Jasper and then sat at (60,2) indefinitely.
      //
      // Rate-limited to one a second exactly as the client is, and the body deliberately does
      // not move while it waits.
      // `c` is bound further down for the ordinary path; this branch returns before it, so
      // read the client here. Passing the not-yet-declared binding silently did nothing —
      // _requestOffRoom takes `(x, c)` and bailed on the undefined client, which is why three
      // off-map crossings were noticed and zero requests were ever sent.
      this._requestOffRoom(this.session?.client);
      return this._delegate(posOverride, 'boundary crossing');
    }
    if (!this.active || !this.dest) return { state: 'idle' };

    const c = this.session?.client;
    if (!c || c.state !== 'game') return { state: 'not-in-game' };
    const me = posOverride ?? c.self;
    if (!me || me.col == null) return { state: 'no-position' };

    const geo = this._geo();
    // A room we cannot collide in is a room the controller has no business steering in.
    if (!geo?.collisionReady) return this._delegate(posOverride, 'no collision geometry');

    // A ROOM CHANGE INVALIDATES EVERYTHING WE BELIEVE.
    //
    // The controller owns its position, and that position means nothing in a room it was not
    // measured in. Nothing here tracked the room, so a character walking through a door kept
    // integrating the OLD room's coordinates against the NEW room's geometry — planning from a
    // point that does not exist, colliding with walls that are not there, and reporting no
    // progress because the body it is steering is somewhere else entirely.
    //
    // The tell was drift_max = 22,356 client units. That is 21.8 squares, which is not drift;
    // no amount of 1Hz replication error accumulates to twenty-one squares. It is the distance
    // between two rooms' coordinate systems, and it also explains 310 handbacks scattered over
    // a dozen positions with no wall in common, and 9 arrivals in 13,238 ticks.
    //
    // So: adopt the server's word outright, drop the plan, and start again. There is nothing
    // worth preserving across a door.
    const roomNow = c.room?.id ?? this.session?.world?.room?.num ?? null;
    if (roomNow !== this._room) {
      if (this._room !== null) {
        console.error(`[ctlmover] ${this._agent} room ${this._room} -> ${roomNow}: resyncing position, dropping the plan`);
        this.stats.roomResyncs = (this.stats.roomResyncs || 0) + 1;
      }
      this._room = roomNow;
      this.ctl.clear();
      this.ctl.x = null;                 // forces syncFrom(me) below
      this._plannedFor = null;
      this._noProgress = 0;
      this._handedBack = false;
    }

    const now = Date.now();
    const dt = this._lastTickAt ? Math.min(now - this._lastTickAt, 1000) : 0;
    this._lastTickAt = now;

    // POSITION: ADOPT ONCE, THEN OWN IT. NO CORRECTION LOOP.
    //
    // This used to reconcile against the server every second. It should never have: the server
    // does not move a walking character, WE do. What arrives once a second is BP_MOVE — the
    // server echoing our own last report back at us, lagged by the round trip and by however
    // long it took to walk the body there. Treating that echo as truth measured our own
    // latency and called it error, then dragged the believed position toward it: 2 to 46
    // squares of disagreement, 2,276 refused plans, a third of movement handed to the legacy
    // mover. clientd3d/move.c has no such step, and `server_x/server_y` there are not the
    // server's opinion at all — they are what the client last TOLD the server.
    //
    // The one real exception is the server RELOCATING us: a blink (our own keeper casts it to
    // get unstuck), a portal, a death. That is moveobj.c:88 -> ServerMovedPlayer, and it is
    // detected the only way it honestly can be — by a jump we could not have walked.
    if (this.ctl.x == null) this.ctl.syncFrom(me);
    else {
      const believed = this.ctl.square();
      const gap = Math.hypot((me.col - believed.col) * CLIENT_PER_SQUARE,
                             (me.row - believed.row) * CLIENT_PER_SQUARE);
      // A LARGE, PERSISTENT GAP MEANS WE ARE SIMPLY WRONG — adopt the server's word.
      // Checked about once a second and required twice running, so ordinary echo lag (3-6
      // squares at walking speed) never triggers it.
      if (gap > DIVERGENCE_SQUARES * CLIENT_PER_SQUARE
          && gap <= TELEPORT_SQUARES * CLIENT_PER_SQUARE) {
        if (now - (this._divSince ?? 0) > 3000) this._divSince = now;   // start a fresh window
        else if (now - this._divSince >= 900) {
          this._divSince = 0;
          this.ctl.serverMovedPlayer(me.col, me.row);
          this._plannedFor = null;
          this.stats.resyncs = (this.stats.resyncs || 0) + 1;
          console.error(`[ctlmover] ${this._agent} believed (${believed.col},${believed.row}) but the server`
            + ` says (${me.col},${me.row}) — ${Math.round(gap / CLIENT_PER_SQUARE)} squares for a second; adopting the server`);
        }
      } else if (gap <= DIVERGENCE_SQUARES * CLIENT_PER_SQUARE) {
        this._divSince = 0;                       // back in agreement
      }
      if (gap > TELEPORT_SQUARES * CLIENT_PER_SQUARE) {
        this.ctl.serverMovedPlayer(me.col, me.row);
        this._plannedFor = null;
        this.stats.teleports = (this.stats.teleports || 0) + 1;
        console.error(`[ctlmover] ${this._agent} the server moved us to (${me.col},${me.row})`
          + ` — ${Math.round(gap / CLIENT_PER_SQUARE)} squares, further than we could have walked; snapping`);
      }
    }
    this._lastSeenAt = now;

    // A BODY IN ROCK IS AN ESCAPE, NOT A JOURNEY — CHECK BEFORE PLANNING.
    //
    // The rock hand-off below only fires when the PLAN fails, and the plan usually succeeds:
    // navPath measures from the square's centre, which can be clear while the body itself is
    // embedded. So the controller accepted a 194-waypoint route and then could not take the
    // first step — JayB on an unwalkable (30,47) with ctlBlocked=19789 against 17,938 ticks,
    // slid=0, sent=52. The fine tracer refuses too, so this is not a coarse-grid artifact and
    // no amount of collide-and-slide gets him out.
    //
    // Escape fans and raw server-confirmed moves are the legacy mover's job. Hand it over the
    // moment we notice, rather than after twelve ticks of grinding.
    if (geo.walkable && geo.walkable(me.row, me.col) === false) {
      this.stats.rockDelegations = (this.stats.rockDelegations || 0) + 1;
      if (!this._warnedRock) {
        this._warnedRock = true;
        console.error(`[ctlmover] ${this._agent} is embedded at (${me.col},${me.row}) —`
          + ` handing to the legacy mover to dig out`);
      }
      return this._delegate(posOverride, 'body is on an unwalkable square');
    }
    if (this._warnedRock && geo.walkable && geo.walkable(me.row, me.col) !== false)
      this._warnedRock = false;      // back on real ground; the next embedding is news again

    // PLAN: once per destination, on the grid. Re-planning at tick rate is what held the
    // first live run to 1.14 squares/sec.
    const key = `${this.dest.col},${this.dest.row}`;
    if (this._plannedFor !== key || !this.ctl.path) {
      const plan = this.ctl.setDestination(geo, this.dest.col, this.dest.row, me);
      this.stats.replans++;
      if (!plan?.ok) {
        // NO ROUTE IS A REAL ANSWER AND THE KEEPER ACTS ON IT — it blacklists the target
        // rather than chasing something behind a wall. Only say it when the planner refused,
        // never when we merely failed to make progress.
        this.stats.planFail++;
        // A BODY STANDING IN ROCK CANNOT BE PLANNED FOR, AND THAT IS NOT THE QUARRY'S FAULT.
        //
        // navPath plans through free space, so it refuses outright when the START is a square
        // the room calls solid — and `no-route` tells the keeper the DESTINATION is
        // unreachable, so it blacklists a perfectly good target and gives up. Lee sat in the
        // Yonder Inn on (13,4), a walkable=false square in region 1, with the only exit at
        // (8,2) in region 0: six NO-ROUTEs in a row and seven minutes of not moving, over a
        // route the graph plans in six hops.
        //
        // The legacy mover has verified escape fans and raw server-confirmed moves for
        // exactly this, so a body that cannot be planned FROM is handed to it rather than
        // surrendered. `no-route` keeps its real meaning: we are somewhere sane and the
        // destination still cannot be reached.
        const geoRock = this._geo();
        if (geoRock?.walkable && geoRock.walkable(me.row, me.col) === false) {
          if (!this._warnedRock) {
            this._warnedRock = true;
            console.error(`[ctlmover] ${this._agent} is standing on an unwalkable square`
              + ` (${me.col},${me.row}) — handing movement to the legacy mover to get out`);
          }
          this.stats.rockDelegations = (this.stats.rockDelegations || 0) + 1;
          return this._delegate(posOverride, 'body is on an unwalkable square');
        }
        this.stats.noRoute++;
        this.active = false;
        console.error(`[ctlmover] ${this._agent} NO-ROUTE to (${this.dest.col},${this.dest.row})`
          + ` from (${me.col},${me.row}): ${plan?.reason ?? '?'}`);
        // `no-route` for the combat caller, which blacklists the target on it. The ROUTER
        // has no case for that name and would fall through to its default 'moving', so it
        // would keep believing a leg was in progress that can never advance.
        return { state: 'no-route', blocked: true, why: plan?.reason ?? 'no path to destination' };
      }
      this._plannedFor = key;
      // NOT resetting _noProgress here. A blocked tick forces a replan, so resetting the
      // counter on every plan means it can never reach STUCK_TICKS — which is why the first
      // live run reported stuck=0 while the body stood in one square for 998 ticks. Only real
      // movement, or a new destination, clears it.
    }

    if (!dt) return { state: 'moving', to: this.dest };

    // DO NOT RUN AHEAD OF THE SERVER. If the belief is already further ahead than the echo
    // can explain, integrating more only builds a correction we will have to pay back as a
    // rubberband. Hold, keep replicating, and let the confirmations arrive.
    if (this._leadExceeded(c)) return { state: 'moving', to: this.dest, holding: true };

    const before = this.ctl.square();
    const r = this.ctl.step(dt, { geo, client: c });

    if (r.state === 'blocked' || r.state === 'no-path') this.stats.blockedTicks++;
    else if (r.state === 'moving') this.stats.moving++;
    this._summarise(r.state);

    if (r.state === 'arrived') {
      this.stats.arrived++;
      console.error(`[ctlmover] ${this._agent} ARRIVED at (${this.ctl.square().col},${this.ctl.square().row})`);
      this.active = false;
      // The last position is worth a packet even though the throttle would hold it: the
      // keeper is about to swing, and swinging from where the server thinks we are is the
      // difference between a hit and a whiff.
      try { this.ctl.replicate(c, true); } catch { /* best effort */ }
      return { state: 'arrived', position: this.ctl.square() };
    }

    const after = this.ctl.square();
    const moved = after.col !== before.col || after.row !== before.row;
    if (moved) { this._noProgress = 0; this._handedBack = false; }
    else this._noProgress++;

    // Once the controller has failed to move the body for HANDBACK_TICKS, this destination
    // belongs to the legacy mover. Cleared by any real movement, or by a new destination.
    if (!moved && this._noProgress >= HANDBACK_TICKS) {
      if (!this._handedBack) {
        this._handedBack = true;
        console.error(`[ctlmover] ${this._agent} handing (${this.dest.col},${this.dest.row}) back to the legacy mover`
          + ` — no progress from (${after.col},${after.row}) in ${HANDBACK_TICKS} ticks`);
      }
      return this._delegate(posOverride, 'controller made no progress');
    }

    if (r.state === 'blocked' || r.state === 'no-path') {
      // The controller gave the plan up. Try once more from where we now are; a body that
      // slid into a corner often has a route the plan made from the old position did not.
      this._plannedFor = null;
      if (this._noProgress >= STUCK_TICKS) {
        this.stats.stuck++;
        this._noProgress = 0;
        console.error(`[ctlmover] ${this._agent} STUCK (blocked) at (${after.col},${after.row}) aiming (${this.dest.col},${this.dest.row})`);
        return { state: 'stuck', why: `controller blocked at (${after.col},${after.row})` };
      }
      return { state: 'moving', to: this.dest, blocked: true };
    }

    if (this._noProgress >= STUCK_TICKS) {
      this.stats.stuck++;
      this._noProgress = 0;
      this._plannedFor = null;
      return { state: 'stuck', why: `no progress for ${STUCK_TICKS} ticks at (${after.col},${after.row})` };
    }

    return { state: 'moving', to: this.dest };
  }
}
