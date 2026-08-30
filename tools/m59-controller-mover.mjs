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
// Consecutive blocked ticks before the belief is abandoned in favour of the server's
// square. Well above an ordinary bump into a wall (which clears on the next heading) and
// far below the thousands a genuinely unreasonable belief racks up. See tick().
const BLOCKED_RESYNC_TICKS = 8;
// How long a destination steers the body without anybody renewing it. Both callers re-aim
// every tick they actually want movement, so this is generous — it only ever catches an
// aim that has been ABANDONED, never one still in use. See _aimIsStale.
const AIM_STALE_MS = Number(process.env.M59_AIM_STALE_MS || 1000);

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
    this._seenClient = null;   // the client object reference from when we last ran — a change means a rejoin
    this._noProgress = 0;
    this._blockedRun = 0;
    this._sentSeen = 0;
    this._noProgressCycles = 0;
    this.stats = { ticks: 0, arrived: 0, stuck: 0, noRoute: 0, delegated: 0, replans: 0,
                   moving: 0, blockedTicks: 0, planFail: 0 };
    this._lastSummary = 0;
    this._agent = session?.agent ?? session?.name ?? '?';
  }

  _geo() { return this.session?.world?.geometry ?? this.session?._roomGeo ?? null; }

  // DIAGNOSTIC: fire when we are about to adopt (or have just adopted) a
  // position that is a go-exit staging square in the CURRENT room. This is
  // the symptom of the room-transition bug. Log the full state so we can
  // see which code path placed the character there.
  _checkStagingAdoption(me, c) {
    if (!me?.col || !me?.row || !this._room) return;
    const map = this.session?.world?.map;
    if (!map) return;
    const room = map.rooms?.[String(this._room)];
    if (!room) return;
    // Check if (me.col, me.row) is a go-exit staging square in ANY room
    // (not just the current one — the bug places the character at the OLD
    // room's staging coordinates in the NEW room).
    const matches = [];
    for (const [num, r] of Object.entries(map.rooms)) {
      if (num === String(this._room)) continue;
      for (const e of (r.goExits ?? [])) {
        if (e.col == me.col && e.row == me.row && e.to != null && !e.locked) {
          matches.push(`${r.name}[${num}]->${e.to}`);
        }
      }
    }
    if (!matches.length) return;
    console.error(`[ctlmover] ${this._agent} STAGING-SQUARE ADOPTION DETECTED`);
    console.error(`  position: (${me.col},${me.row}) in room ${this._room} (${room.name})`);
    console.error(`  matches staging in: ${matches.join(', ')}`);
    console.error(`  _room: ${this._room}, _lastMoveRoom: ${c._lastMoveRoom}, _roomStamp: ${c._roomStamp}`);
    console.error(`  ctl.x: ${this.ctl.x}, ctl.y: ${this.ctl.y}, _posRoomStamp: ${this.ctl._posRoomStamp}`);
    console.error(`  self: (${c.self?.col},${c.self?.row}), room.id: ${c.room?.id}`);
    console.error(`  lastServerTile: ${JSON.stringify(this._lastServerTile)}`);
    console.error(`  stack: (this is the adoption path — check the tick that called syncFrom)`);
  }

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
    this._destAge = Date.now();
      // The room it is a crossing OUT OF. An off-room request is a request to leave one
      // specific room, so it is finished the moment we are in a different one.
      this.crossing = { col, row, room: this.session?.client?.room?.id ?? null };
      this.active = false;                 // the controller is not steering this one
      try { this.fallback?.to?.(col, row); } catch { /* fallback, not a dependency */ }
      return;
    }
    this.crossing = null;

    {
      // One-time debug: log when dest IS set
      if (this._agent === 't4' && (this._dbgDestCounts ??= 0) < 10) {
        this._dbgDestCounts++;
        const prevAge = this._destAge ? Date.now() - this._destAge : 0;
        import('node:fs').then(m => m.appendFileSync('/tmp/t4-dest.log',
          `to(${col},${row}) isNew=${!this.dest || this.dest.col !== col || this.dest.row !== row} prevDestAge=${prevAge} newDestAge=${this._destAge ? 'will-reset' : 'null'}\n`));
      }
    }
    const isNew = !this.dest || this.dest.col !== col || this.dest.row !== row;
    this.dest = { col, row };
    this.active = true;
    // WHOEVER IS STEERING MUST KEEP SAYING SO. See the note on AIM_STALE_MS.
    this._aimedAt = Date.now();
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
      this._destAge = Date.now();         // reset the pocket timer only for NEW aims
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

  // THE BODY WAS MOVED BY SOMETHING THAT IS NOT US. Blink, a portal, a death, a DM.
  //
  // Movement here is CLIENT-AUTHORITATIVE, so a controller that does not hear about a
  // relocation does not merely hold a stale opinion — it actively undoes the relocation.
  // It keeps replicating the position it still believes in, the server accepts that (it
  // validates nothing), and the body is dragged straight back. Watched on JayB in room
  // 535: the keeper cast blink five times against an `entombed` square, every cast
  // succeeded and moved him, and the controller put him back on (47,13) each time. Fifteen
  // mana spent to travel nowhere, and from outside it looked like blink was broken.
  //
  // So every deliberate relocation must land here. The plan goes with it: it was drawn
  // from a place the body is no longer standing.
  // Set the run flag on the underlying CharacterController. Run moves at 2x
  // the distance per step (5 squares/sec vs 2.5) and sends speed 36 instead
  // of 18. The decider calls this based on the active goal: run when
  // travelling, walk when hunting/fighting/fleeing/resting. Running costs
  // ~11 vigor/minute (out of 200), so a character at 80 vigor can run for
  // ~7 minutes before the rest system kicks in at 60.
  setRun(run) {
    try { this.ctl.setRun(!!run); } catch { /* best effort */ }
  }

  relocated(col, row) {
    if (!Number.isFinite(col) || !Number.isFinite(row)) return false;
    let ok = false;
    try { ok = this.ctl.serverMovedPlayer(col, row); } catch { /* best effort */ }
    this._plannedFor = null;
    this._noProgress = 0;
    this._handedBack = false;
    this.stats.relocations = (this.stats.relocations || 0) + 1;
    console.error(`[ctlmover] ${this._agent} relocated to (${col},${row}) by something that is not us`
      + ` — adopting it and dropping the plan`);
    return ok;
  }

  maybeConfirm(...a) { return this.fallback?.maybeConfirm?.(...a); }

  cancel() {
    this.active = false; this.dest = null;
    try { this.ctl.clear(); } catch { /* ignore */ }
    try { this.fallback?.cancel?.(); } catch { /* ignore */ }
  }

  // Before the fallback owns the body, make sure our fine position is not anchored on a
  // stale prediction. When this function is called, the controller has produced a sub-square
  // plan the geometry cannot execute; the fallback will now own the body and may send a
  // request that places it on a far tile. `c.predictSelf` in m59-fallbacks.mjs writes that
  // far tile to `c.self`; on the NEXT tick `syncFrom(me)` reads `c.self` and adopts it as
  // our fine position — even though the server still has us where we were. The gap is the
  // distance the body cannot actually cross (the geometry said no), so it persists and the
  // controller cannot recover without a room change or a restart.
  //
  // Fix: adopt the server's confirmed tile BEFORE delegating. `serverMovedPlayer` is the
  // same call the room-change path and relocation path use for exactly this — it rebase the
  // fine position and drops the plan. `c.self` is the server's last echo (BP_MOVE); it is
  // not a local prediction, so it is safe to adopt. Gap > 2 tiles: the legitimate
  // BP_MOVE echo lag is 1-4 tiles at 1202ms/2.5 tiles-per-sec; a persisted gap past the
  // 8-tick no-progress window is a genuine asymmetry, not lag.
  _syncFineForFofalback() {
    const c = this.session?.client;
    if (!c?.self || this.ctl?.x == null) return;
    const me = c.self;
    const believed = this.ctl.square();
    const gap = Math.hypot((believed?.col ?? me.col) - me.col,
                           (believed?.row ?? me.row) - me.row);
    if (gap > 2) {
      this.ctl.serverMovedPlayer(me.col, me.row, me.x, me.y);
      this._plannedFor = null;
      this._noProgress = 0;
      this.stats.delegResyncs = (this.stats.delegResyncs ?? 0) + 1;
      console.error(`[ctlmover] ${this._agent} DELEGATE resync: believed (${believed.col},${believed.row})`
        + ` vs server (${me.col},${me.row}) — ${gap.toFixed(1)} tiles; rebasing fine position`);
    }
  }

  _delegate(posOverride, why) {
    this.stats.delegated++;
    const fbState = this.fallback?.active ?? 'no fallback active';
    const fbPath = this.fallback?.path?.length ?? 0;
    console.error(`[ctlmover] ${this._agent} DELEGATE ${why}| fallback.active=${fbState} fallback.path=${fbPath} fallbackId=null`);
    if (!this.fallback?.tick) return { state: 'blocked', why: why ?? 'no fallback mover' };
    this._syncFineForFofalback();
    const r = this.fallback.tick(posOverride);
    // Don't log every tick, just the state:
    if (this.fallback?.tick === undefined || r?.state !== 'moving') {
      console.error(`[ctlmover] ${this._agent} DELEGATE RESULT: ${r?.state} ${r?.why ?? ''}`);
    }
    return r;
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
      // The early returns, which the counters above cannot see and which are the difference
      // between "not moving because it cannot" and "not moving because it is waiting".
      + ` held=${s.held ?? 0} resync=${s.blockedResyncs ?? 0} rock=${s.rockDelegations ?? 0}`
      + ` rockOff=${s.rockWalkedOff ?? 0}`
      + ` stale=${s.staleAims ?? 0} restQuiet=${s.restQuiet ?? 0}`
      + ` | ctl sent=${c.sent ?? 0} slid=${c.slid ?? 0} ctlBlocked=${c.blocked ?? 0} reconciled=${c.reconciled ?? 0} drift=${Math.round(c.drift_max ?? 0)}`
      + ` roomResyncs=${s.roomResyncs ?? 0}`
      // WHERE THE CONTROLLER THINKS THE BODY IS, to the client unit, and whether the
      // floor test under that point answered. `at=` above is the SQUARE, and a square is
      // exactly the resolution at which this class of bug is invisible: a centre with no
      // floor and a body with floor share one square number.
      + ` | ctlAt=${this.ctl.x == null ? '-' : Math.round(this.ctl.x)},${Math.round(this.ctl.y)}`
      + ` stranded=${c.stranded ?? 0} fineAdopted=${c.fineAdopted ?? 0} fineRejected=${c.fineRejected ?? 0}`
      + ` offRoom=${c.offRoomRefused ?? 0} sideSteps=${c.sideSteps ?? 0}`
      + ` traceBlocked=${c.trace_blocked ?? 0} fellback=${c.trace_fellback ?? 0} rescued=${c.trace_rescued ?? 0}`
      // WHAT IT IS STEERING AT. "blocked" says the step failed; it does not say the
      // step was aimed at a wall because the plan went missing.
      + ` | path=${this.ctl.path ? this.ctl.path.length : 'NONE'}@${this.ctl.pathIdx ?? 0}`
      + ` aim=${this.ctl._lastAim ? `${Math.round(this.ctl._lastAim.x)},${Math.round(this.ctl._lastAim.y)}` : '-'}`);
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
  // HAS ANYBODY ASKED FOR THIS DESTINATION LATELY?
  //
  // The mover keeps its last destination until somebody gives it another, and the
  // controller integrates that destination from the 10Hz loop whether or not any decision
  // asked it to. Two callers share this one mover — combat aims it at a quarry, travel aims
  // it at a staging square — and neither has any idea the other exists. So a destination
  // set by travel kept steering the body through an entire fight, and the movement target
  // and the attack target pointed in different directions with nothing arbitrating.
  //
  // The rule that needs no arbitration: an aim is a claim on the body, and a claim has to
  // be renewed. The router re-aims every tick it travels and combat re-aims every tick it
  // walks, so anything still wanted is refreshed continuously; anything nobody has spoken
  // for in AIM_STALE_MS is nobody's, and the body stands still rather than finishing
  // somebody else's errand. Silence stops the body — it never redirects it.
  _aimIsStale() {
    if (!this.dest || !this._aimedAt) return false;
    return Date.now() - this._aimedAt > AIM_STALE_MS;
  }

  physicsTick() {
    // A REST IS A TIMER THE SERVER DELETES ON ANY MOVEMENT, and the payoff is all at the
    // end. Integrating and replicating through one is how a character rests for a minute
    // and gains nothing. See the note in m59-decide.mjs where _restingQuiet is set.
    if (this.session?._restingQuiet) return null;
    if (this._aimIsStale()) {
      this.stats.staleAims = (this.stats.staleAims || 0) + 1;
      return null;
    }
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
    const lead = Math.hypot(b.col - here.col, b.row - here.row);
    if (lead <= MAX_LEAD_SQUARES) return false;

    // A DISTANCE CANNOT TELL AHEAD FROM BEHIND, AND ONLY ONE OF THEM IS WORTH HOLDING FOR.
    //
    // This guard exists to stop the belief RUNNING AHEAD of the server: integrating past
    // what the echo can explain only builds a correction paid back as a visible snap. But
    // the test was a symmetric hypot, so it fired just as readily when the belief was
    // BEHIND — and then holding is precisely wrong. The belief needs to catch up, and
    // freezing it means replicating a stale position, which drags the body backwards.
    //
    // Measured live in the Deep Forest of Farol: "belief (4,4) vs server (8,6) — lead 4.5",
    // the belief four squares behind, held. 1,999 of 2,568 ticks (78%) were spent held
    // while `moving` advanced 7 per twenty-second window. That is the stutter — five
    // squares, twenty-four seconds of nothing, four more squares.
    //
    // The destination gives the direction the distance lacks: if adopting the server's
    // square would put us CLOSER to where we are going, the server is ahead and its word is
    // simply better than ours. Take it and re-plan. Only when we are the ones out in front
    // is waiting the right answer.
    const d = this.dest;
    if (d) {
      const dBelief = Math.hypot(d.col - b.col, d.row - b.row);
      const dServer = Math.hypot(d.col - here.col, d.row - here.row);
      if (dServer < dBelief) {
        this.stats.behindAdopted = (this.stats.behindAdopted || 0) + 1;
        if (this.stats.behindAdopted <= 5)
          console.error(`[ctlmover] ${this._agent} belief (${b.col},${b.row}) is ${lead.toFixed(1)}`
            + ` BEHIND the server (${here.col},${here.row}) — adopting it rather than waiting for it`);
        try { this.ctl.serverMovedPlayer(here.col, here.row, here.x, here.y); } catch { /* best effort */ }
        this._plannedFor = null;
        return false;              // not a hold: the body may move again this very tick
      }
    }

    this.stats.held = (this.stats.held || 0) + 1;
    if (this.stats.held <= 5)
      console.error(`[ctlmover] ${this._agent} HOLD: belief (${b.col},${b.row}) vs server`
        + ` (${here.col},${here.row}) — lead ${lead.toFixed(1)} > ${MAX_LEAD_SQUARES}`);
    try { this.ctl.replicate(c, true); } catch { /* best effort */ }
    return true;
  }

  tick(posOverride) {
    this.stats.ticks++;
    {
      try { const _tick = (this._dbgTick ??= 0) + 1; this._dbgTick = _tick;
        if (_tick % 100 === 1) {
          import('node:fs').then(m => m.appendFileSync('/tmp/ctl-debug.log',
            `${this._agent} tick#${_tick} pos=${posOverride?posOverride.col+','+posOverride.row:'?'} ctlXY=${this.ctl?.x?.toFixed(0)},${this.ctl?.y?.toFixed(0)} dest=${this.dest?this.dest.col+','+this.dest.row:'null'} step=${this._lastStep?.state} pathLen=${this.ctl?.path?.length ?? 0} pathIdx=${this.ctl?.pathIdx ?? -1}\n`));
        }
      } catch {}
    }
    // SESSION RESTART: session.rejoin() replaces session.client with a fresh
    // one. The character's believed position is in the OLD session; adopting the
    // new client's coordinates from the server POSLIST is mandatory.
    // We must reset HERE, before the crossing-delagate branch, otherwise the
    // believed position (at (11,49)) never has to sync with the server's
    // current position (at (20,2)) and is forever 47 squares off on a
    // tiny tileSize pocket.
    const _c = this.session?.client;
    if (_c && this._seenClient !== _c) {
      if (this._seenClient !== null) {
        console.error(`[ctlmover] ${this._agent} rejoin detected (new client) — resetting controller state`);
        this.stats.rejoins = (this.stats.rejoins ?? 0) + 1;
        this.ctl.clear();
        this._room = null;
        this._seenClient = _c;
        return { state: 'resync' };
      }
      this._seenClient = _c;  // first tick: just record the client reference
    }
    // AIRLOCK HOLD: the room changed and the server has not confirmed our
    // position in the new room yet. NOTHING moves while the airlock is
    // closed — no crossing requests, no delegation to the legacy mover,
    // no resting-quiet pass, no replication. This is checked before every
    // other branch so no code path can send a move computed in the old
    // room. The airlock is set in the room-change block below and released
    // once c._lastMoveRoom confirms a BP_MOVE in the new room.
    if (this._airlock) {
      // A ROOM CHANGE IS ANNOUNCED BY BP_PLAYER + BP_ROOM_CONTENTS, NOT BY
      // BP_MOVE. The arrival position is in the room contents (our character
      // object, at the arrival square). BP_MOVE is a periodic echo that may
      // not come at all if the character is standing still. So confirm on
      // room contents: once we've seen the contents for the new room (which
      // includes our character at the arrival position), the position is
      // confirmed. Fall back to _lastMoveRoom if contents never include us
      // (shouldn't happen, but belt-and-braces).
      const confirmed = (_c?._lastContentsRoom != null
          && Number(_c._lastContentsRoom) === Number(this._room))
        || (_c?._lastMoveRoom != null
          && Number(_c._lastMoveRoom) === Number(this._room));
      if (!confirmed) {
        // Safety valve: if the server never confirms (BP_MOVE lost, object
        // map stuck), do not hold forever. After 5s, release and let the
        // room-change block's adoption logic take over — a wrong position
        // is recoverable via the divergence check; an airlocked character
        // is not.
        if (Date.now() - this._airlock.since > 5000) {
          console.error(`[ctlmover] ${this._agent} airlock timeout after 5s — releasing with unconfirmed position`);
          console.error(`  DIAG: _lastMoveRoom=${_c?._lastMoveRoom} this._room=${this._room} room.id=${_c?.room?.id} self=(${_c?.self?.col},${_c?.self?.row}) selfId=${_c?.selfId} objects=${_c?.room?.objects?.size}`);
          this._airlock = null;
          // Fall through to the room-change block, which will adopt.
        } else {
          return { state: 'airlock' };
        }
      } else {
        console.error(`[ctlmover] ${this._agent} airlock released: position confirmed in room ${this._room}`
          + ` (${Math.round((Date.now() - this._airlock.since) / 100) / 10}s after the crossing)`);
        console.error(`  DIAG airlock-release: c.self=(${_c?.self?.col},${_c?.self?.row}) _lastContentsRoom=${_c?._lastContentsRoom} _lastMoveRoom=${_c?._lastMoveRoom}`);
        this._airlock = null;
        // BAD ARRIVAL CHECK: the position is now confirmed (BP_ROOM_CONTENTS
        // or BP_MOVE). If it has no floor, the server placed us in a bad spot
        // (util.kod skips ReqSomethingMoved for &User). Delegate to the
        // fallback with a destination (nearest walkable square) so its
        // walkTo recovery can fire.
        const _me = _c?.self;
        const _geo = this._geo();
        if (_me && _geo?.walkable && !_geo.walkable(_me.row, _me.col)) {
          const _near = _geo.nearestWalkable?.(_me.row, _me.col, { maxRadius: 12 });
          console.error(`[ctlmover] ${this._agent} BAD ARRIVAL: position (${_me.col},${_me.row}) in room ${this._room} has no floor${_near ? ` — nearest walkable (${_near.col},${_near.row})` : ''}`);
          this.stats.badArrivals = (this.stats.badArrivals ?? 0) + 1;
          if (_near) {
            try { this.fallback?.to?.(_near.col, _near.row); } catch { /* best effort */ }
          }
          return this._delegate(_me, 'bad arrival (no floor)');
        }
        // Fall through: the position is valid, continue with normal movement.
        // FORCE-ADOPT THE SERVER'S POSITION. The airlock held all movement,
        // but ctl.x still has the OLD room's position (ctl.clear() doesn't
        // clear x). The adoption block below (if ctl.x == null) is skipped
        // because x is not null. So the server's new position is never
        // adopted, and the motion path is calculated from the old position
        // in the new room. Fix: syncFrom the server's position now.
        if (_me && _me.col != null) {
          this.ctl.syncFrom(_me);
          console.error(`  DIAG airlock-adopt: ctl.x synced to server (${_me.col},${_me.row})`);
        }
      }
    }
    // TELEPORT / DIVERGENCE CORRECTION BEFORE the resting early return.
    // A character resting HAS a fine position; if that fine position has drifted
    // > DIVERGENCE_SQUARES (6) tiles from the server's BP_MOVE echo, it will never
    // heal because the normal glazing path in step() is skipped while resting.
    //
    // SKIP THIS WHEN THE ROOM HAS CHANGED: a large gap across a room boundary
    // is not drift, it is the distance between two rooms' coordinate systems.
    // Snapping here would adopt the old room's coordinates in the new room and
    // preempt the room-change block (which drops the plan, spends the crossing,
    // and enters the airlock). Let the room-change block handle it.
    const _roomNow2 = _c?.room?.id ?? this.session?.world?.room?.num ?? null;
    const _roomChanged2 = this._room != null && _roomNow2 != null && _roomNow2 !== this._room;
    if (this.ctl.x != null && _c?.self && !_roomChanged2) {
      const _me2 = _c.self;
      const _bel2 = this.ctl.square();
      const _gap2 = Math.hypot((_me2.col - _bel2.col) * CLIENT_PER_SQUARE,
                               (_me2.row - _bel2.row) * CLIENT_PER_SQUARE);
      if (_gap2 > DIVERGENCE_SQUARES * CLIENT_PER_SQUARE) {
        this.ctl.serverMovedPlayer(_me2.col, _me2.row, _me2.x, _me2.y);
        this._plannedFor = null;
        this._divSince = 0;
        if (_gap2 > TELEPORT_SQUARES * CLIENT_PER_SQUARE) {
          this.stats.teleports = (this.stats.teleports || 0) + 1;
          console.error(`[ctlmover] ${this._agent} TELEPORT resync while resting: believed`
            + ` (${_bel2.col},${_bel2.row}) vs server (${_me2.col},${_me2.row})`
            + ` - ${Math.round(_gap2 / CLIENT_PER_SQUARE)} tiles; snapping`);
        } else {
          this.stats.resyncs = (this.stats.resyncs || 0) + 1;
          console.error(`[ctlmover] ${this._agent} DIVERGENCE resync while resting: believed`
            + ` (${_bel2.col},${_bel2.row}) vs server (${_me2.col},${_me2.row})`
            + ` - ${Math.round(_gap2 / CLIENT_PER_SQUARE)} tiles; adopting server`);
        }
        return { state: 'resync' };
      }
    }
    // Silent while resting, for the reason in physicsTick. Reported as a distinct state so
    // a caller cannot read it as progress or as a stall.
    if (this.session?._restingQuiet) {
      this.stats.restQuiet = (this.stats.restQuiet || 0) + 1;
      return { state: 'moving', to: this.dest, resting: true };
    }
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
      // A CROSSING IS SPENT THE MOMENT THE ROOM CHANGES, AND KEEPING IT SENDS YOU ON.
      //
      // The off-room request names coordinates OUTSIDE the room, and which edge that is
      // depends entirely on which room you are standing in. Nothing cleared `crossing` on
      // arrival — only a new on-map destination did — so the tick after landing re-sent the
      // old room's out-of-bounds square, and the server read it against the NEW room's
      // bounds and obligingly fired whichever exit it fell past.
      //
      // That is how JayB left West Merchant Way through Ilerian Woods by its south edge,
      // arrived in the Forest of Farol at its north-west corner (row 4, col 6), and was in
      // Faronath seconds later at (row 4, col 34) -- which is precisely where Farol's own
      // south exit lands you (c6.kod: [LEAVE_SOUTH, RID_C7, 4, 34]). He did not walk the
      // forty-five rows between those two edges; he was passed straight through on a
      // request meant for a room he had already left. Two rooms per crossing, silently,
      // and the exit tables were blamed for it first.
      const roomNow = this.session?.client?.room?.id ?? null;
      if (this.crossing.room != null && roomNow != null && roomNow !== this.crossing.room) {
        this.stats.crossingsCompleted = (this.stats.crossingsCompleted || 0) + 1;
        console.error(`[ctlmover] ${this._agent} crossing into room ${roomNow} completed`
          + ` — dropping the off-room request for room ${this.crossing.room}`);
        this.crossing = null;
        this._offRoomAt = 0;
        return this._delegate(posOverride, 'crossing completed');
      }
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
    // If the position also has no floor, give the fallback a destination (the
    // nearest walkable square) so its walkTo recovery can fire.
    if (!geo?.collisionReady) {
      if (geo?.walkable && me && !geo.walkable(me.row, me.col)) {
        const near = geo.nearestWalkable?.(me.row, me.col, { maxRadius: 12 });
        if (near) {
          console.error(`[ctlmover] ${this._agent} BAD ARRIVAL (no geo): position (${me.col},${me.row}) has no floor — delegating with dest (${near.col},${near.row})`);
          this.stats.badArrivals = (this.stats.badArrivals ?? 0) + 1;
          try { this.fallback?.to?.(near.col, near.row); } catch { /* best effort */ }
        }
      }
      return this._delegate(posOverride, 'no collision geometry');
    }

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
        console.error(`[ctlmover] ${this._agent} room ${this._room} -> ${roomNow}: dropping the plan, waiting for BP_MOVE`);
        this.stats.roomResyncs = (this.stats.roomResyncs || 0) + 1;
      }
      this._room = roomNow;
      this.ctl.clear();
      this._plannedFor = null;
      this._noProgress = 0;
      this._handedBack = false;
      this._lastServerTile = null;
      // A COMPLETED CROSSING IS SPENT THE MOMENT THE ROOM CHANGES. The
      // off-room request named a square outside the OLD room; re-sending it
      // in the NEW room would ask that room to throw us out of whichever
      // edge those coordinates fall past — one crossing becomes two. (This
      // check lives here rather than only in the crossing branch because
      // the resync return below must not skip it: the room change IS the
      // completion.)
      if (this.crossing) {
        this.stats.crossingsCompleted = (this.stats.crossingsCompleted || 0) + 1;
        console.error(`[ctlmover] ${this._agent} crossing into room ${roomNow} completed`
          + ` — dropping the off-room request for room ${this.crossing.room}`);
        this.crossing = null;
        this._offRoomAt = 0;
      }
      // THE LEGACY MOVER MUST HEAR ABOUT THE ROOM CHANGE TOO. It keeps its own
      // path and dead-reckoned position, and it does not detect room changes on
      // its own. If it is not cleared, the next delegation plans a path from
      // its STALE position in the OLD room's coordinate system, using the NEW
      // room's geometry. The path is garbage, and the character is walked to
      // the wrong place — effectively skipping ahead an extra zone.
      try { this.fallback?.clear?.(); } catch { /* best effort */ }
      // ENTER THE AIRLOCK.
      //
      // A room transition is handled as an airlock: the moment the room
      // changes, ALL movement stops. No plans, no steps, no replication,
      // no off-room requests, no delegation. The character stands still
      // until the server has confirmed a position in the NEW room (a
      // BP_MOVE seen in this room, tracked by c._lastMoveRoom). Only then
      // do we adopt the position and resume.
      //
      // This makes the order-of-operations bug impossible by construction:
      // there is no window in which a move computed in the old room can be
      // sent in the new one, because nothing sends moves while the airlock
      // is closed. It replaces the resync-wait, the _lastMoveRoom gate,
      // and the room-stamp guards as the primary defence; those remain as
      // belt-and-braces.
      //
      // BP_PLAYER sets the new room ID but does NOT update self's position.
      // The arrival position arrives in the next BP_MOVE. Between BP_PLAYER
      // and BP_MOVE, self still has the OLD room's position (the staging
      // square for a go-exit, or the last walked position for an edge exit).
      // Adopting it places the character at the old room's coordinates in
      // the new room. JayB, Main gate to Tos -> Streets of Tos: staged at
      // (41,27) in room 586, arrived at (4,58) in room 50, the resync
      // adopted (41,27), the divergence check snapped 48 tiles later.
      this._airlock = { from: this._room, to: roomNow, since: Date.now() };
      console.error(`  DIAG room-change: c.self=(${c.self?.col},${c.self?.row}) _lastMoveRoom=${c._lastMoveRoom} _lastContentsRoom=${c._lastContentsRoom} room.id=${c.room?.id} objects=${c.room?.objects?.size} selfId=${c.selfId}`);
      return { state: 'airlock' };
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
    if (this.ctl.x == null) {
      // ROOM RESYNC: after a room change, don't syncFrom until we've seen
      // a BP_ROOM_CONTENTS (or BP_MOVE) in the new room. BP_PLAYER sets the
      // new room ID but doesn't update self's position. The arrival position
      // arrives in BP_ROOM_CONTENTS (our character object, at the arrival
      // square). BP_MOVE is a periodic echo that may not come at all if the
      // character is standing still. So confirm on room contents first,
      // with BP_MOVE as a fallback.
      const confirmed = (c._lastContentsRoom != null
          && Number(c._lastContentsRoom) === Number(this._room))
        || (c._lastMoveRoom != null
          && Number(c._lastMoveRoom) === Number(this._room));
      if (this._room != null && !confirmed) {
        return { state: 'resync-wait' };
      }
      // FLOOR CHECK: the server's arrival position may be invalid — inside a
      // wall, on a dead-end ledge, or off the grid entirely. The server's edge
      // exit / go exit arrival table is not always correct. The server does NOT
      // validate user positions against room geometry (util.kod: UtilGoToSquare
      // skips ReqSomethingMoved for &User), so a bad arrival position is
      // accepted unconditionally.
      //
      // If the position has no floor, find the nearest walkable square and
      // adopt THAT instead. The server has the character at the bad position,
      // but our controller can start from the nearest valid square and walk
      // from there. The divergence check will snap us to the server's position
      // if it disagrees, but at least we're not starting inside a wall.
      const geo = this._geo();
      // DIAG: log the geometry state at adoption time
      console.error(`  DIAG adoption: geo=${geo ? 'yes' : 'no'} collisionReady=${geo?.collisionReady} walkable=${geo?.walkable ? geo.walkable(me.row, me.col) : 'no method'} me=(${me.col},${me.row})`);
      if (geo?.walkable && !geo.walkable(me.row, me.col)) {
        const near = geo.nearestWalkable?.(me.row, me.col, { maxRadius: 12 });
        console.error(`[ctlmover] ${this._agent} BAD ARRIVAL: server position (${me.col},${me.row}) in room ${this._room} has no floor${near ? ` — nearest walkable (${near.col},${near.row})` : ' — no nearby walkable square'}`);
        this.stats.badArrivals = (this.stats.badArrivals ?? 0) + 1;
        this.ctl.syncFrom(me);
        if (near) {
          // Give the fallback mover a destination: the nearest walkable
          // square. Its walkTo will detect the no-floor start and use
          // its three-stage recovery (stepFine, walkFine) to get the
          // character there.
          try { this.fallback?.to?.(near.col, near.row); } catch { /* best effort */ }
        }
        return this._delegate(me, 'bad arrival (no floor)');
      }
      // DIAGNOSTIC: if we are about to adopt a position that is a go-exit
      // staging square in the current room, log the full state. This is
      // the symptom of the room-transition bug: the character was placed
      // at the old room's staging coordinates in the new room.
      this._checkStagingAdoption(me, c);
      this.ctl.syncFrom(me);
    }
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
          this.ctl.serverMovedPlayer(me.col, me.row, me.x, me.y);
          this._plannedFor = null;
          this.stats.resyncs = (this.stats.resyncs || 0) + 1;
          console.error(`[ctlmover] ${this._agent} believed (${believed.col},${believed.row}) but the server`
            + ` says (${me.col},${me.row}) — ${Math.round(gap / CLIENT_PER_SQUARE)} squares for a second; adopting the server`);
        }
      } else if (gap <= DIVERGENCE_SQUARES * CLIENT_PER_SQUARE) {
        this._divSince = 0;                       // back in agreement
      }
      if (gap > TELEPORT_SQUARES * CLIENT_PER_SQUARE) {
        this.ctl.serverMovedPlayer(me.col, me.row, me.x, me.y);
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
    // ASK THE MODEL THE MOVER ENFORCES, NOT THE ONE THE SERVER KEEPS.
    //
    // This asked `geo.walkable` -- the COARSE grid, a server artifact the real client never
    // consults, and the exact mistake the note in m59-controller.mjs:270 was written about.
    // The two grids disagree constantly, and not marginally: of the fine-walkable squares in
    // the Deep Forest of Farol, 76% are coarse-UNwalkable (2,432 of 3,201). Across six rooms
    // the fleet actually walks, 36.5%.
    //
    // So better than a third of every journey was spent "embedded", handed to the legacy
    // mover to dig out of ground it was standing on perfectly well -- and the legacy mover
    // AWAITS server confirmation, which is where the multi-second pauses come from. Reported
    // as "he seems to pause for a few seconds every now and then" while crossing Farol, and
    // measured at delegated 308 -> 598 in one twenty-second window against six controller
    // steps.
    //
    // The claim in the note below that "the fine tracer refuses too, so this is not a
    // coarse-grid artifact" was true of the square it was written about and not in general.
    // fineWalkable is what traceFineMoveClient enforces, so it is what may declare a body
    // stuck in rock.
    // TRY TO WALK OFF IT BEFORE DECLARING IT ROCK.
    //
    // A coarse-walkable square the fine model refuses is ordinary terrain, not a rare
    // accident: 155 of the 1,412 coarse-walkable squares in the King's Way are like that —
    // 11% of the room — and a character chasing a quarry lands on one constantly. This
    // branch handed straight to the legacy mover BEFORE the controller tried anything, on
    // the strength of one case where "the fine tracer refuses too". That was true of the
    // square it was written about and is not true in general, and the hand-off does not
    // work either: Sasquatch, on (13,39) with a giant rat six squares away, delegated 9,670
    // times, arrived ZERO times, and blinked every thirty seconds for an hour.
    //
    // So ask the tracer, which is the thing that actually decides. If any of the eight
    // directions yields real movement then the body is not embedded in any sense that
    // matters, and the ordinary plan-and-step below walks it off — navPath starts from the
    // nearest free cell, so a start the clearance grid dislikes does not stop it planning.
    // Only when every direction is refused is this genuinely rock, and only then is the
    // legacy mover's escape fan worth the pass.
    let stuckInRock = false;
    if (geo.fineWalkable && geo.fineWalkable(me.row, me.col) === false) {
      stuckInRock = true;
      if (this.ctl.x != null && typeof geo.traceFineMoveClient === 'function') {
        const S = 256;
        for (const [dx, dy] of [[S,0],[-S,0],[0,S],[0,-S],[181,181],[-181,-181],[181,-181],[-181,181]]) {
          try {
            const t = geo.traceFineMoveClient(this.ctl.x, this.ctl.y,
                                              this.ctl.x + dx, this.ctl.y + dy, { slide: true });
            const d = t && t.x != null ? Math.hypot(t.x - this.ctl.x, t.y - this.ctl.y) : 0;
            if (t?.moved && d >= 32) { stuckInRock = false; break; }
          } catch { /* a throwing direction is not a passable one */ }
        }
      }
      if (!stuckInRock) this.stats.rockWalkedOff = (this.stats.rockWalkedOff || 0) + 1;
    }
    if (stuckInRock) {
      this.stats.rockDelegations = (this.stats.rockDelegations || 0) + 1;
      if (!this._warnedRock) {
        this._warnedRock = true;
        console.error(`[ctlmover] ${this._agent} is embedded at (${me.col},${me.row}) —`
          + ` handing to the legacy mover to dig out`);
      }
      return this._delegate(posOverride, 'body is on an unwalkable square');
    }
    if (this._warnedRock && geo.fineWalkable && geo.fineWalkable(me.row, me.col) !== false)
      this._warnedRock = false;      // back on real ground; the next embedding is news again

    // PLAN: once per destination, on the grid. Re-planning at tick rate is what held the
    // first live run to 1.14 squares/sec.
    const key = `${this.dest.col},${this.dest.row}`;
    if (this._plannedFor !== key || !this.ctl.path) {
      const plan = this.ctl.setDestination(geo, this.dest.col, this.dest.row, me);
      this.stats.replans++;
      { try { const _pt = (this._dbgPlanT ??= 0) + 1; this._dbgPlanT = _pt; if (_pt % 200 === 1) { import('node:fs').then(m => m.appendFileSync('/tmp/plan-debug.log', `${this._agent} plan# ${_pt/200} ctlX=${this.ctl.x} ctlY=${this.ctl.y} plan ok=${plan?.ok} pathLen=${this.ctl.path?.length ?? 0} dest=${this.dest.col},${this.dest.row} geoCollisionReady=${geo?.collisionReady} walkable=${geo?.walkable ? geo.walkable(me.row, me.col) : 'no method'}\n`)); } } catch {} }
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

    // Use the SERVER'S tile for progress detection. Store it per tick, compare
    // current to previous. The controller's fine belief crosses the tile boundary
    // before the server does (it integrates locally), making the old `moved` check
    // unreliable.
    const serverTile = { col: c.self?.col ?? this.ctl.square().col, row: c.self?.row ?? this.ctl.square().row };
    const before = this._lastServerTile ?? serverTile;
    this._lastServerTile = serverTile;
    const r = this.ctl.step(dt, { geo, client: c });
    this._lastStep = r;

    if (r.state === 'blocked' || r.state === 'no-path') this.stats.blockedTicks++;
    else if (r.state === 'moving') this.stats.moving++;
    this._summarise(r.state);

    // ARRIVAL IS A SERVER TILE, NOT A BELIEF.
    // The controller's fine position crosses the destination tile's boundary,
    // causing step() to return "arrived". But the server tile (c.self.col) has
    // not actually changed because the server rejected the fine-move packets.
    // Use the server tile for the arrival check.
    const serverArrived = c.self && this.dest
      && c.self.col === this.dest.col && c.self.row === this.dest.row;
    if (r.state === 'arrived' && serverArrived) {
      this.stats.arrived++;
      console.error(`[ctlmover] ${this._agent} ARRIVED (server confirmed) at (${c.self.col},${c.self.row})`);
      this.active = false;
      // The last position is worth a packet even though the throttle would hold it: the
      // keeper is about to swing, and swinging from where the server thinks we are is the
      // difference between a hit and a whiff.
      try { this.ctl.replicate(c, true); } catch { /* best effort */ }
      return { state: 'arrived', position: this.ctl.square() };
    }

    const after = serverTile;
    if (this._agent === 't4') {
      import('node:fs').then(m => m.appendFileSync('/tmp/t4-moved.log',
        `${this._agent} tick before=(${before.col},${before.row}) after=(${after.col},${after.row}) moved=${moved === (before.col !== after.col || before.row !== after.row)} noProg=${this._noProgress} destAge=${this._destAge ? (Date.now()-this._destAge) : 'null'}\n`));
    }
    const moved = after.col !== before.col || after.row !== before.row;
    if (moved) { this._noProgress = 0; this._handedBack = false; this._noProgressCycles = 0; }
    else this._noProgress++;

    // THE SERVER KNOWS WHERE THE BODY IS; THE BELIEF ONLY KNOWS WHERE IT STEERED IT.
    //
    // The controller owns its position and there is deliberately no correction loop (the
    // long note above argues why). That leaves one failure it cannot reason its way out
    // of: a believed position wedged against geometry it cannot leave. It re-plans,
    // re-slides, and sends almost nothing.
    //
    // KEYED ON PROGRESS, NOT ON THE WORD 'blocked'. The first version of this asked
    // whether the step came back blocked, and it never once fired: a body pressed against
    // a wall SLIDES, the slide is sub-square motion, and sub-square motion reports
    // `moving`. Watched on JayB in Brownestone Inn — slid=5489, ctlBlocked=5483, blocked=0
    // and ctl sent=6, the belief pinned on (5,4) while the server had him on (6,4). This
    // is the same trap the stall detector fell into: a two-square shuffle resets anything
    // that asks for stillness, so ask whether the BODY got anywhere instead.
    //
    // The square itself is usually fine — (5,4) has five of eight directions open. It is
    // the FINE position inside it that is jammed, which is why adopting is the cure:
    // serverMovedPlayer re-centres the coordinates on the square the server named.
    //
    // Placed before the hand-back below, and BLOCKED_RESYNC_TICKS is deliberately under
    // HANDBACK_TICKS: recovering our own position is cheaper than surrendering the
    // destination, so it gets the first attempt.
    // If the controller has been 'moving' (sending fine packets) but the SERVER 
    // hasn't moved the tile in 30 seconds, this is a walkable POCKET: the .roo 
    // geo can't find a path out. Hand back to legacy.
    if (!moved && this._noProgress >= BLOCKED_RESYNC_TICKS && c?.self) {
      // Separate from _noProgress (which the resync keeps resetting):
      // log the condition values for debugging:
      if (process.env.M59_DBG_PROBE === '1' && (this._dbgPool ??= 0) % 5 === 0) {
        this._dbgPool++;
        console.error(`[ctlmover dbg] ${this._agent} destAge=${this._destAge ? Date.now() - this._destAge : 'null'}ms noProgress=${this._noProgress} moved=${!!moved} before=(${before.col},${before.row}) after=(${after.col},${after.row})`);
      }
      {
        try { import('node:fs').then(m => m.appendFileSync('/tmp/t4-pocket.log',
          `${this._agent} POCKET CHECK: noProg=${this._noProgress} destAge=${this._destAge ? Date.now()-this._destAge : 'null'} moved=${moved} cSelf=${!!c?.self}\n`)); } catch {}
      }
      const _age = this._destAge ? Date.now() - this._destAge : 0;
      if (this._agent === 't4' && _age > 4500) {
        try { import('node:fs').then(m => m.appendFileSync('/tmp/t4-pool-delegate.log',
          `${this._agent} WILL DELEGATE: age=${_age} noProg=${this._noProgress}\n`)); } catch {}
      }
      this._noProgressCycles = (this._noProgressCycles ?? 0) + 1;
      const pocket = (this._destAge && Date.now() - this._destAge > 4500)
        || (this._noProgressCycles >= 2);
      if (pocket) {
        this.stats.handedBack = (this.stats.handedBack ?? 0) + 1;
        console.error(`[ctlmover] ${this._agent} wPR: no tile progress — handing back to legacy (cycles=${this._noProgressCycles})`);
        return this._delegate(posOverride, 'walkable pocket, no geo route');
      }
      const sv = c.self;
      // AGREEING ABOUT THE SQUARE IS NOT THE SAME AS BEING FREE TO LEAVE IT.
      //
      // This only re-synced when the server named a DIFFERENT square, on the reasoning that
      // agreement means the belief is fine. It does not: the belief carries a FINE position
      // inside the square, and that can be pressed into geometry while the square itself is
      // perfectly good. Nothing then corrects it, because the two agree — so the body slides
      // against the same wall for ever and the square never changes.
      //
      // Lee, room 150, two squares from his waypoint: 112,000 ticks, 15,454 of them
      // "moving", slid=117,105, ctl sent=1,613, arrived=ZERO, and not one square of
      // progress in two hours. From the square CENTRE all eight directions are open and
      // navPath plans the hop in eight waypoints — the square was never the problem.
      //
      // So a long enough stall re-centres the belief on the server's square whichever square
      // that is. `serverMovedPlayer` puts the body at the stand point, which is the one
      // position in the square known to be clear, and drops the plan that was drawn from
      // wherever it had drifted to. The correction is bounded by a single square, and the
      // alternative is a character frozen until somebody restarts its keeper.
      if (Number.isFinite(sv.col) && Number.isFinite(sv.row)) {
        const sameSquare = sv.col === after.col && sv.row === after.row;
        this._noProgress = 0;
        this.stats.blockedResyncs = (this.stats.blockedResyncs || 0) + 1;
        if (this.stats.blockedResyncs <= 5)
          console.error(`[ctlmover] ${this._agent} no square progress in ${BLOCKED_RESYNC_TICKS} ticks`
            + ` at believed (${after.col},${after.row}); the server says (${sv.col},${sv.row})`
            + ` — ${sameSquare ? 're-centring on the stand point' : 'adopting it'}`);
        // RESYNC ESORTING FROM APRX EST UENQUE USES THE SQUARE CENTER.
        // 座择再 - Son Adopt fine position from a direction that the body can ACTUALLY walk.
        // The old code re-centred at (col-0.5)*CLIENT_PER_SQUARE — the square centre —
        // and the body immediately re-jammed into the same wall. Now: try the heading direction first,
        // then two perpendiculars. Each probe is a short trace from the current point.
        let reSyncPx = undefined, reSyncPy = undefined;
        try {
          const geoFine = this._geo?.();
          if (geoFine?.traceFineMoveClient && this.ctl.x != null) {
            const CLIENT_PER_TILE = 1024;
            const KOD_FINE = 64;
            // Step probe: 1/8 tile in the direction toward the dest
            const dx = (this.dest.col - after.col), dy = (this.dest.row - after.row);
            const len = Math.hypot(dx, dy) || 1;
            const step = CLIENT_PER_TILE / 8;
            const dirs = [
              [dx/len * step, dy/len * step],          // toward dest
              [-dy/len * step, dx/len * step],          // perpendicular A
              [dy/len * step, -dx/len * step],          // perpendicular B
            ];
            for (const [ppx, ppy] of dirs) {
              const t = geoFine.traceFineMoveClient(this.ctl.x, this.ctl.y, this.ctl.x + ppx, this.ctl.y + ppy, { slide: true });
              const moved = t?.x != null ? Math.hypot(t.x - this.ctl.x, t.y - this.ctl.y) : 0;
              if (t?.moved && moved >= 32) {
                // Clamp to the current tile boundary so it doesn't leak into a neighbour.
                const TILE = 1024, PAD = 16;  // stay 16 units off the tile edge
                const minX = (sv.col - 1) * TILE + PAD, maxX = sv.col * TILE - PAD;
                const minY = (sv.row - 1) * TILE + PAD, maxY = sv.row * TILE - PAD;
                const cx2 = Math.max(minX, Math.min(maxX, t.x));
                const cy2 = Math.max(minY, Math.min(maxY, t.y));
                const PROTO_OFFSET = 64, PROTO_SCALE = 16;
                reSyncPx = Math.round(cx2 / PROTO_SCALE + PROTO_OFFSET);
                reSyncPy = Math.round(cy2 / PROTO_SCALE + PROTO_OFFSET);
                break;
              }
            }
          }
        } catch { /* best-effort geometry */ }
        // Always recenter at the TILE CENTER, not at the probe point.
        // The probes may free from the current fine position, but the FREE
        // position is still in the pocket (wall 483 blocks the path to the
        // destination from every offset position, only the tile center is
        // clear). The center is the one position the .roo walls say you can
        // always walk from in any direction.
        {
          const TILE = 1024;
          const centerClientX = (sv.col - 0.5) * TILE;
          const centerClientY = (sv.row - 0.5) * TILE;
          const PROTO_OFFSET = 64, PROTO_SCALE = 16;
          const px = Math.round(centerClientX / PROTO_SCALE + PROTO_OFFSET);
          const py = Math.round(centerClientY / PROTO_SCALE + PROTO_OFFSET);
          try {
            this.ctl.serverMovedPlayer(sv.col, sv.row, px, py);
            this.ctl.x = centerClientX;
            this.ctl.y = centerClientY;
            this.ctl.z = this.ctl.square()  ? this.ctl.z : this.ctl.z;
          } catch {
            this.ctl.serverMovedPlayer(sv.col, sv.row);
          }
        }
        this._plannedFor = null;        // the plan was made from somewhere we are not
        return { state: 'moving', to: this.dest, resynced: true };
      }
    }

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
      // A WATER ROOM HAS NO WALKABLE .roo CELLS, and the controller can never plan 
      // a path through it. After 5 seconds of continuous no-path, hand back to the 
      // legacy mover which uses server-side pathfinding that understands water.
      if (r.state === 'no-path') {
        this._noPathTicks = (this._noPathTicks ?? 0) + 1;
        if (this._noPathTicks >= 50) {  // 50 ticks ≈ 5s at 10Hz
          this.stats.handedBack = (this.stats.handedBack ?? 0) + 1;
          console.error(`[ctlmover] ${this._agent} in no-path water room for 50 ticks — handing back to legacy`);
          return this._delegate(posOverride, 'water room, no .roo land');
        }
      } else {
        this._noPathTicks = 0;
      }
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
