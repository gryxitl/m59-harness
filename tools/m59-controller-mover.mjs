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
import { CharacterController } from './m59-controller.mjs';

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

// The server's own word arrives asynchronously and is square-granular. Reconciling against it
// every tick would treat its resolution as error — see CharacterController.reconcile.
const RECONCILE_EVERY_MS = 1000;

// HOW FAR BACK THE SERVER'S WORD IS ABOUT. A position push describes where the body was when
// the server last processed it, so the error has to be measured against what WE believed at
// roughly that moment. A ring of recent beliefs is the honest way to find it; the alternative
// — comparing against a snapshot taken when we last SENT — freezes the moment sending stops,
// and a blocked body stops sending immediately. That is how drift reached 3,254 units (three
// squares) on the first live run while reconcile fired seven times and corrected nothing.
const BELIEF_RING_MS = 3000;

export class ControllerMover {
  constructor(session, fallback) {
    this.session = session;
    this.fallback = fallback;          // the router's Mover, kept for what we cannot do
    this.ctl = new CharacterController();
    this.dest = null;
    this.active = false;
    this._lastTickAt = 0;
    this._lastReconcileAt = 0;
    this._beliefs = [];        // {x,y,at}, most recent last
    this._room = null;         // the room our believed position belongs to
    this._noProgress = 0;
    this._sentSeen = 0;
    this.stats = { ticks: 0, arrived: 0, stuck: 0, noRoute: 0, delegated: 0, replans: 0,
                   moving: 0, blockedTicks: 0, planFail: 0 };
    this._lastSummary = 0;
    this._agent = session?.agent ?? session?.name ?? '?';
  }

  get _geo() { return this.session?.world?.geometry ?? this.session?._roomGeo ?? null; }

  to(col, row) {
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

  tick(posOverride) {
    this.stats.ticks++;
    if (!this.active || !this.dest) return { state: 'idle' };

    const c = this.session?.client;
    if (!c || c.state !== 'game') return { state: 'not-in-game' };
    const me = posOverride ?? c.self;
    if (!me || me.col == null) return { state: 'no-position' };

    const geo = this._geo;
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
      this._beliefs.length = 0;
      this._plannedFor = null;
      this._noProgress = 0;
      this._handedBack = false;
    }

    const now = Date.now();
    const dt = this._lastTickAt ? Math.min(now - this._lastTickAt, 1000) : 0;
    this._lastTickAt = now;

    // POSITION: adopt the server's word once, then own it.
    if (this.ctl.x == null) this.ctl.syncFrom(me);
    else {
      this._beliefs.push({ x: this.ctl.x, y: this.ctl.y, at: now });
      while (this._beliefs.length && now - this._beliefs[0].at > BELIEF_RING_MS) this._beliefs.shift();
      if (now - this._lastReconcileAt >= RECONCILE_EVERY_MS) {
        this._lastReconcileAt = now;
        // What did we believe about a second ago? That is the belief the server's word is
        // about. If we have not moved in that time the answer is simply "here", and the
        // reconcile becomes a straight correction — which is exactly right for a body that
        // is wedged and needs its position fixed rather than its travel preserved.
        const want = now - RECONCILE_EVERY_MS;
        let snap = this._beliefs[0] ?? null;
        for (const b of this._beliefs) if (Math.abs(b.at - want) < Math.abs(snap.at - want)) snap = b;
        if (this.ctl.reconcile({ col: me.col, row: me.row }, snap)) this._plannedFor = null;
      }
    }

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
        this.stats.noRoute++; this.stats.planFail++;
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
