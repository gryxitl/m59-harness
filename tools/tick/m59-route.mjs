#!/usr/bin/env node
// m59-route.mjs -- GETTING SOMEWHERE, UNDER A TICK.
//
// A route is the thing that most obviously does not fit a blocking model, and it is why
// the old one looked reasonable for so long: "walk to room 52" reads like one operation.
// It is not. It is a hundred decisions taken a tenth of a second apart, and writing it
// as one call is what produced `walkTo(maxSteps: 30)` inside `for (attempt of 5)` --
// 150 steps in a single await, with nothing sampling health.
//
// THE WHOLE IDEA HERE IS THAT A ROUTE IS STATE, NOT A LOOP. The router holds a
// destination and a current leg; each tick it looks at where the server says we are,
// decides the single next square, sends it, and returns. Progress is OBSERVED between
// ticks rather than assumed within a call, which is what makes it interruptible: any
// tick can decide to do something else entirely and nothing has to be unwound.
//
// ---------------------------------------------------------------------------
// WHAT IS EXPENSIVE AND WHAT IS NOT
// ---------------------------------------------------------------------------
//
// `World.exits()` runs flood fills to price every staging square -- its own comment
// records that a fresh A* per opening once made one call take tens of seconds. That is
// fine occasionally and ruinous every tick. So it is called ONLY when the leg changes,
// which is when the room changes, and the answer is cached as the leg.
//
// The per-tick cost after that is arithmetic: compare two coordinates, pick a direction,
// send one square. `findPath` and `resolveRoom` are synchronous and in-memory, and they
// too only run on a room change.
//
// ---------------------------------------------------------------------------
// EXITS ARE NOT DOORS AND THEY ARE NOT 1:1
// ---------------------------------------------------------------------------
//
// Walking from A to B does not put you where the return trip starts, and the edge back
// to A can be most of a room away from where you arrive. So the leg is recomputed from
// scratch on every room change rather than reversed, inverted, or remembered.
import { loadMap, findPath, hazardReason } from '../m59-map.mjs';
import { objIdToNum } from '../m59-hunt-room.mjs';
import { Mover } from './m59-mover.mjs';
import { tickEdgeExits, tickGoExits } from './m59-exits.mjs';
import { recordCrossing } from '../m59-crossings.mjs';
import { KOD_FINENESS } from '../m59-roo.mjs';
import { transitBanned } from './m59-ground.mjs';
import { Pose } from './m59-pose.mjs';

// WHICH MAP ROOM ARE WE ACTUALLY IN.
//
// The live room id and the map's room numbers are different namespaces that OVERLAP, and
// the overlap is silent. Watched live: JayB standing in "Raza" with a live id of 2013,
// which is a perfectly real map room called "The East Tower" -- so a router that trusted
// the number planned a route from a tower on the other side of the world and reported
// "no route" for ever.
//
// So the order is EVIDENCE FIRST and the raw number LAST:
//
//   1. the bake's own objId -> map num table. The server's object id is unambiguous.
//   2. the room NAME. The server tells us what the room is called; a name that matches
//      exactly one map room settles it.
//   3. the raw number, ONLY if the map knows it AND nothing above disagreed.
//
// m59-keeper-goap.mjs's resolveMapRoom has the same job and tries the raw number FIRST,
// returning it whenever it happens to be a map key -- which is exactly the case that is
// wrong, and is the bug above.
let _byName = null;
export function resolveRoomNum({ id = null, num = null, name = null } = {}, map = null) {
  const m = map ?? loadMap();
  const byObj = objIdToNum(id ?? num);
  if (byObj != null && m?.rooms?.[byObj]) return byObj;

  if (name) {
    if (!_byName) {
      _byName = new Map();
      for (const [n, r] of Object.entries(m?.rooms ?? {})) {
        if (!r?.name) continue;
        // A name that belongs to more than one room settles nothing, so it is dropped
        // rather than guessed between.
        _byName.set(r.name, _byName.has(r.name) ? null : Number(n));
      }
    }
    const hit = _byName.get(name);
    if (hit != null) return hit;
  }

  if (num != null && m?.rooms?.[num]) return Number(num);
  if (id != null && m?.rooms?.[id]) return Number(id);
  return null;
}

// How long a character may stand on the same square, while it has somewhere to be,
// before the leg is treated as wrong rather than slow. WALL CLOCK, not ticks: ticks
// coalesce under load, so a tick-count deadline gets longer exactly when the loop is
// already struggling.
const STUCK_MS = Number(process.env.M59_ROUTE_STUCK_MS || 4000);
// How long a leg may take before it is replanned even without being visibly stuck.
const LEG_MAX_MS = Number(process.env.M59_ROUTE_LEG_MAX_MS || 30000);
// MULTI-LEG BOUNDS. When the leg's standOn is not directly fine-reachable (a fence, a
// ledge, a walled alcove), the router decomposes the approach into sub-legs: a chain of
// intermediate waypoints, each individually reachable. These cap the decomposition so a
// genuinely unreachable standOn cannot loop the planner forever.
const SUBLEG_MAX = Number(process.env.M59_ROUTE_SUBLEG_MAX || 32);      // max waypoints in a chain
const SUBLEG_REPLAN_MS = Number(process.env.M59_ROUTE_SUBLEG_REPLAN_MS || 8000); // no-progress before re-plan
const SUBLEG_MAX_REPLANS = Number(process.env.M59_ROUTE_SUBLEG_REPLANS || 3);   // re-plans before giving up
// How far (in squares) to search outward from the standOn for the nearest reachable
// approach point. The door of a walled alcove is usually 1-4 squares from the closest
// square the character can actually stand on.
const APPROACH_SEARCH_RADIUS = Number(process.env.M59_ROUTE_APPROACH_RADIUS || 4);
// OSCILLATION BREAKER. A pinned character can keep "moving" (neighbour-bounce) for
// hours while every square-held stuck timer resets on each step. The window is how far
// back we look for net displacement; the minimum is how many squares of CHEBYSHEV net
// movement count as progress in that window; and the max is how many consecutive dead
// windows the route survives before being dropped entirely. 20s/2 squares/3 verdicts:
// long enough that a slow walk around a wall is not misread, short enough that an
// hour-long pin becomes ~a minute of retry-then-escape.
const PROGRESS_WINDOW_MS = Number(process.env.M59_ROUTE_PROGRESS_WINDOW_MS || 20000);
const PROGRESS_MIN_NET = Number(process.env.M59_ROUTE_PROGRESS_MIN_NET || 3);
const OSCILLATION_MAX = Number(process.env.M59_ROUTE_OSCILLATION_MAX || 3);

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

export class Router {
  constructor({ session, map = null, stuckMs = STUCK_MS, legMaxMs = LEG_MAX_MS,
                now = () => Date.now() } = {}) {
    if (!session) throw new Error('Router: no session');
    this.session = session;
    this.map = map ?? loadMap();
    this.stuckMs = stuckMs;
    this.legMaxMs = legMaxMs;
    this.now = now;
    this.dest = null;
    this.leg = null;
    this.mark = null;      // { col, row, at } -- the last place we noticed we were
    this.lastState = 'idle';
    this.mover = new Mover(session);
    // MULTI-LEG STATE. When the leg's standOn needs an intra-room sub-journey (around a
    // fence, up a ledge), `subWp` holds the ordered waypoints to reach, in squares. The
    // router walks to subWp[0] first; on arrival it shifts and re-plans the rest. `subWp`
    // ends at the standOn itself, so reaching the end IS reaching the door. The
    // `_subWpPlanAt`/`_subWpReplans` fields bound the no-progress re-planning.
    this.subWp = null;        // [ {col,row}, ... ] or null when the leg is a plain walk
    this._subWpPlanAt = 0;    // wall-clock ms of the last sub-leg (re)plan
    this._subWpReplans = 0;   // how many times we've re-planned the current leg's sub-legs
    // OSCILLATION BREAKER STATE. A character pinned at a wall can still be "moving" —
    // the mover or the stuck-escape walks it to a neighbour and back, every second, for
    // ever (JayB at the Raza Mausoleum door: thousands of one-step walkTo calls between
    // (44,12) and (45,12)). The square-held stuck detector never fires because the
    // position keeps CHANGING. Net-progress tracking catches what it cannot: samples of
    // the position over a window, and an oscillation verdict when the window is full but
    // the character has gone nowhere.
    this._progress = [];      // [{ t, col, row }] position samples, newest last
    this._oscillations = 0;   // consecutive oscillation verdicts for this route
    this._badStandOn = new Set();  // `${nextRoom}:${col},${row}` squares to stop aiming at
    // RE-ENTRY ARRIVAL (A1) + CROSS-ROOM OSCILLATION (A2) STATE. A windowed history of
    // the rooms observed while this route is active. Consecutive duplicates are never
    // pushed, so "the current room appears more than once" means "we left it and came
    // back" (a re-entry), and ">= 2 distinct rooms" means "we are crossing between
    // rooms" (a ping-pong). The window resets every 2*PROGRESS_WINDOW_MS so a long
    // route does not accumulate the whole journey.
    this._roomSeq = [];       // [ { room, at }, ... ] distinct consecutive rooms, newest last
    this._crossOsc = 0;       // consecutive windows spent ping-ponging between rooms
    this._crossOscAt = null;  // wall-clock ms of the last cross-room verdict (once per window)
  }

  to(roomNum) {
    const n = Number(roomNum);
    if (!Number.isFinite(n)) return false;
    // NEVER-ENTER CHOKE POINT: no caller (hunt, flee, stuck-escape, travel
    // command) may park the router on a room that kills by arithmetic. The
    // route planner refuses these too, but refusing here stops the
    // destination from latching while every goal yields to it forever.
    const hazard = hazardReason(n);
    if (hazard) {
      this._refusedHazard = { dest: n, why: hazard, at: Date.now() };
      return false;
    }
    if (this.dest !== n) {
      console.error(`[route] RETARGET ${this.dest} -> ${n}`);
      this.dest = n; this.leg = null; this.mark = null; this.subWp = null; this._subWpReplans = 0;
      this._goFireCount = 0;
      this._progress = []; this._oscillations = 0; this._badStandOn.clear();
      this._roomSeq = []; this._crossOsc = 0; this._crossOscAt = null;
      this.lastState = 'idle';  // a new destination is never mid-crossing
    }
    return true;
  }

  clear() {
    console.error(`[route] CLEAR ${this.dest}`);
    this.dest = null; this.leg = null; this.mark = null; this.subWp = null; this._subWpReplans = 0;
    this._progress = []; this._oscillations = 0; this._badStandOn.clear();
    // NOTE: _roomSeq / _crossOsc / _crossOscAt are NOT reset here. clear() is the
    // drop path itself (the A2 breaker calls it after stamping _routeDrop), so
    // wiping the breaker's own evidence here would make every route drop reset the
    // ping-pong counter to zero — the loop we are trying to end. They are reset
    // only in to(), on a genuinely new destination.
  }

  status() {
    return { dest: this.dest, state: this.lastState,
             leg: this.leg ? { to: this.leg.next, stand_on: this.leg.standOn } : null };
  }

  // THE EXPENSIVE HALF, run only on a room change.
  _planLeg(here) {
    // A new room: the reachability cache (keyed by room) is for the old room now.
    this._reachCache = null;
    this.lastState = 'idle';  // a fresh leg is never mid-crossing (stale
    // 'crossing' poisons vigor_low/travel yields downstream forever).
    const world = this.session?.world;
    if (!world) return { why: 'no world' };
    let hops = null;
    try {
      const p = findPath(this.map, here, this.dest);
      if (p?.found) hops = p.hops ?? [];
    } catch (e) { return { why: `route failed: ${e.message}` }; }
    if (!hops) return { why: `no route from ${here} to ${this.dest}` };

    const next = hops.length ? (hops[0].to ?? hops[0]) : this.dest;
    let exits = [];
    try { exits = world.exits() ?? []; } catch (e) { return { why: `exits failed: ${e.message}` }; }
    // TICK EDGES (gap-fill, not replacement): the shared exit computation can
    // drop a working edge entirely (watched live: 382's north door to 557 —
    // baked approaches exist, coarse flood connects, but no exit object came
    // back and travel reported "no usable exit" next to a working door).
    // The tick provider answers from map topology + baked approaches +
    // witnessed crossings, verified live against BSP floor. Merged by
    // (to, stand_on) so the shared list keeps precedence elsewhere.
    try {
      const extra = tickEdgeExits({ map: this.map, roomNum: here, geo: this._geo() });
      if (extra.length) {
        const seen = new Set(exits.map(e => `${e.to}:${e.stand_on?.col},${e.stand_on?.row}`));
        for (const x of extra) {
          const k = `${x.to}:${x.stand_on?.col},${x.stand_on?.row}`;
          if (!seen.has(k)) { seen.add(k); exits.push(x); }
        }
      }
    } catch {}
    // DOOR (go) exits: world.exits() computes only edges, so a door-only room
    // (106 Brownestone Inn: edgeExits: []) yields no exit from it and the leg is
    // unplanable — the character can be routed IN but never out. Read the map's
    // goExits directly; the router already fires act.go() for a 'go' leg (the
    // crossing branch in tick()). Merged by (to, stand_on) like the edge gap-fill.
    try {
      const doors = tickGoExits({ map: this.map, roomNum: here });
      if (doors.length) {
        const seen = new Set(exits.map(e => `${e.to}:${e.stand_on?.col},${e.stand_on?.row}`));
        for (const x of doors) {
          const k = `${x.to}:${x.stand_on?.col},${x.stand_on?.row}`;
          if (!seen.has(k)) { seen.add(k); exits.push(x); }
        }
      }
    } catch {}
    // PREFER EXITS WHOSE STAND_ON IS REACHABLE. A go/edge exit whose stand_on square
    // is walled off (a fence, a ledge) makes the leg target an unreachable square and
    // the character oscillates against the wall forever. `reachable` is computed by
    // world.exits() via this.reach(). If the primary is unreachable but the exit
    // carries alternates (other squares on the same boundary), try those first — a
    // wide edge often has a passable square even when the nearest one is blocked.
    const cands = exits.filter(e => Number(e.to) === Number(next) && e.stand_on
      // A standOn condemned by the oscillation breaker is not aimed at again — the
      // fine-aware sort below already demotes fine-blocked squares; this removes ones
      // that proved bad in PLAY (the fine model said fine, the server or the geometry
      // still refused, and the character pinned there). Cleared when the route changes.
      && !this._badStandOn.has(`${next}:${e.stand_on.col},${e.stand_on.row}`));
    // If every candidate for this exit is condemned, forgive them: a condemned door is
    // better than no leg at all (the room-escape escalation in the decider will handle
    // a truly unusable room).
    if (!cands.length) {
      cands.push(...exits.filter(e => Number(e.to) === Number(next) && e.stand_on));
      this._badStandOn.clear();   // all condemned: forgive rather than leave the room exitless
    }
    // FINE-REACHABILITY OUTRANKS COARSE. The coarse grid over-promises across fences and
    // ledges (it calls a square behind a retaining wall "reachable" in 4 steps when the
    // fine model refuses every step), and picking a coarse-reachable-but-fine-blocked
    // standOn is exactly the Raza Mausoleum door trap: (44,8) wins the coarse sort by
    // distance, the mover cannot walk there, and the character pinned at the wall below
    // it for hours alternating between two escape squares. Compute the fine-reachable set
    // ONCE here (bounded BFS, cached) and sort candidates that can actually be WALKED to
    // ahead of ones that cannot.
    const meNow = this.session?._pose?.current?.() ?? this.session?.client?.self ?? null;
    let fineSet = null;
    if (meNow?.col != null) {
      try { fineSet = this._fineReachableSet(this._geo(), meNow.col, meNow.row); }
      catch { fineSet = null; }
    }
    const fineOk = (e) => fineSet != null && e.stand_on != null
      && fineSet.has(`${e.stand_on.col},${e.stand_on.row}`);
    const byReach = (a, b) => (((b.reachable === true) - (a.reachable === true))
      || ((fineOk(b) ? 1 : 0) - (fineOk(a) ? 1 : 0))
      || ((a.steps_away ?? 1e9) - (b.steps_away ?? 1e9)));
    cands.sort(byReach);
    const exit = cands.find(e => e.reachable !== false && (!fineSet || fineOk(e)
      // No fine-reachable candidate at all: keep the coarse pick rather than no leg —
      // the sub-leg planner and the mover's raw-door-push still have a chance.
      || !cands.some(x => x.reachable !== false && fineOk(x)))) ?? cands[0];
    if (!exit) return { why: `no usable exit from ${here} toward ${next}` };
    // If the chosen exit's stand_on is unreachable and it has alternates, fall back to
    // the first reachable alternate.
    let standOn = exit.stand_on;
    if (exit.reachable === false && Array.isArray(exit.alternates) && exit.alternates.length) {
      const alt = exit.alternates.find(a => a.reachable !== false && a.stand_on)
        ?? exit.alternates.find(a => a.stand_on);
      if (alt?.stand_on) standOn = alt.stand_on;
    }
    // A declared standOn that the COARSE grid calls a wall is unpathable: the mover's
    // coarse A* expands the whole room and gives up (watched: room 201 door (12,4),
    // fine-floor / server-floor but coarse-wall, pinned the character at (4,7) for
    // hours while a walkable alternate door (11,4) sat four squares away). The fine
    // model and the server both call it floor, so the door is real — the coarse grid
    // is the outlier. Aim at the nearest square the coarse grid can path to instead;
    // from there the mover's walk-past-boundary closes the gap. No-op when the
    // standOn is already walkable.
    let _standOnSubstituted = false;
    let _origStandOn = null;
    if (this._geo()?.walkable?.(standOn.row, standOn.col) === false) {
      const _near = this._nearestCoarseWalkable(this._geo(), standOn.col, standOn.row);
      if (_near) {
        _origStandOn = standOn;
        console.error(`[route] standOn (${standOn.col},${standOn.row}) is a coarse wall; aiming at nearest walkable (${_near.col},${_near.row}) (leg to ${next})`);
        standOn = _near;
        _standOnSubstituted = true;
      }
    }

    // Compute an edge target if the exit doesn't provide one.
    // The edge target is one square beyond the staging square,
    // in the direction of the exit. Walking to it triggers
    // the room change. NOTE: `standOn` may have been substituted above
    // (a coarse-wall standOn replaced by the nearest walkable square), so this
    // derives from the SUBSTITUTED standOn — the edge target stays one square
    // past the actual staging square, and the edge direction (standOn ->
    // edgeTarget) is unchanged. A direction-kind exit whose standOn was
    // substituted therefore aims the walk-past-boundary at the correct square.
    let edgeTarget = exit.edge_target ?? null;
    if (!edgeTarget && exit.direction) {
      const dir = exit.direction.toLowerCase();
      const dx = dir === 'east' ? 1 : dir === 'west' ? -1 : 0;
      const dy = dir === 'south' ? 1 : dir === 'north' ? -1 : 0;
      edgeTarget = { col: standOn.col + dx, row: standOn.row + dy };
    }
    // A SUBSTITUTED standOn on a go-door exit (kind='go' carries no direction, so
    // edgeTarget is still null) leaves the mover's walk-past-boundary without a
    // direction vector: the substituted square is no longer the declared boundary
    // square, so the mover's fallbacks (room-boundary, then character-to-standOn)
    // aim the wrong way for an interior staging square. The ORIGINAL declared
    // standOn is, by definition, one step past the real staging square in the
    // server's boundary direction — it is the correct edge target. Setting it keeps
    // the walk-past-boundary vector intact without inventing a direction. The mover
    // normalizes {col,row} to protocol units (m59-mover.mjs:559).
    if (!edgeTarget && _standOnSubstituted && _origStandOn) {
      edgeTarget = { col: _origStandOn.col, row: _origStandOn.row };
    }

    return { leg: { fromRoom: here, next, standOn,
                    edgeTarget,
                    direction: exit.direction ?? null,
                    kind: exit.kind ?? 'walk',
                    // THE ROOM WE ARE TRYING TO REACH, PASSED THROUGH TO THE MOVER.
                    // It is needed because a room's kod region exits -- the corners that
                    // teleport you -- are invisible to every walkability predicate, and the
                    // only thing that distinguishes the door we want from the door we do not
                    // is this number. See regionCornerBanned in m59-mover.mjs.
                    wantRoom: next ?? null,
                    startedAt: this.now() } };
  }

  // The room's fine geometry, or null. The sub-leg planner needs it to test reachability
  // of intermediate squares. Read fresh each call (the room can change under us).
  _geo() { return this.session?.world?.geometry ?? null; }

  // Is square (col,row) reachable from (fromCol,fromRow) on the COARSE grid? The coarse
  // grid is a fast (sub-ms) reachability oracle. It is deliberately used here rather than
  // the fine model: the fine finePathProtocol takes ~1.8s per BLOCKED square, which would
  // stall the tick loop. The coarse grid can over-promise (it misses thin fences/ledges),
  // but the Mover re-validates every step with the fine model when actually walking, so a
  // coarse false-positive just costs one re-plan, not a correctness failure. A
  // coarse false-negative (rare) is bounded by the approach search radius.
  _reachable(geo, fromCol, fromRow, toCol, toRow) {
    if (!geo?.path) return null;  // no oracle: caller treats as "unknown"
    // path() is 1-indexed. Guard against out-of-bounds squares.
    if (toCol < 1 || toRow < 1 || toCol > geo.cols || toRow > geo.rows) return false;
    if (fromCol < 1 || fromRow < 1 || fromCol > geo.cols || fromRow > geo.rows) return false;
    try {
      const r = geo.path(fromRow, fromCol, toRow, toCol, { fine: false, maxNodes: 4000 });
      return r?.found === true;
    } catch { return null; }
  }

  // Is a single step from (c1,r1) to the adjacent (c2,r2) allowed?
  //
  // ONE PREDICATE, ONE PLACE. `geo.moverStepLands` is the geometry's own answer
  // to "will a step land here" — a baked step-mask lookup, the same function
  // `finePathProtocol` uses for its edge test. The mover's step search asks a
  // deliberately different, more conservative question (fine grid + edges +
  // void + body-width), and that disagreement is FINE as long as only the
  // mover holds it.
  //
  // It was not. Three sites in this file each carried their own walkability
  // predicate — `_fineStep` (fine `moverStepLands`), `_chainSquareOk` (fine
  // `fineWalkable`/`standable`), and the runtime edge-blocked drop (raw
  // `moverStepLands` again) — and every one of them could drop or keep the SAME
  // chain head on a different verdict. The result was the aim flip-flopping
  // between the chain head and the standOn (watched: 30,33<->29,33 116 times, and
  // 13,619 destination changes against 244,021 sends). Each flip is a new
  // destination in the mover, which resets its path, its stuck signal and its
  // escape fan — so nothing in the mover could ever finish anything.
  //
  // So: every chain question in this file asks `chainStepOk`, and `chainStepOk`
  // is the one predicate the mover's own planner already uses. A chain built
  // here and a plan drawn by the mover cannot disagree about an edge, because
  // they read the same byte.
  chainStepOk(geo, fromRow, fromCol, toRow, toCol) {
    if (!geo) return null;
    if (toCol < 0 || toRow < 0) return false;
    if (geo.moverStepLands) return geo.moverStepLands(fromRow, fromCol, toRow, toCol);
    // No step mask on this geometry (a bare test fixture): the closest honest
    // answer is a single radius-free trace between the two squares.
    if (!geo.traceFineMoveClient) return null;
    const CF = 1024, H = 512;
    try {
      const t = geo.traceFineMoveClient(fromCol * CF + H, fromRow * CF + H,
                                        toCol * CF + H, toRow * CF + H, { slide: false });
      return t?.arrived === true;
    } catch { return null; }
  }

  // Is a single step from (c1,r1) to the adjacent (c2,r2) allowed by the FINE model?
  // DELEGATED: this is now `chainStepOk`. Kept as a name because the BFS callers
  // read better with it; it adds no predicate of its own.
  _fineStep(geo, c1, r1, c2, r2) {
    return this.chainStepOk(geo, r1, c1, r2, c2);
  }

  // The set of squares fine-reachable from (fromCol,fromRow), found by a BOUNDED BFS
  // using single-step fine traces as the edge test. Bounded by maxSteps (total squares
  // visited) so it cannot run away. Returns a Set of "col,row" keys. This matches the
  // Mover's fine model (unlike the coarse grid, which over-promises across fences/ledges)
  // while staying fast (~1ms per edge).
  //
  // CACHED PER (room, start square): the reachability set is a property of the room's
  // geometry + the start position, both of which are stable while the character is in
  // the room working toward a standOn. Without the cache, every leg re-plan (triggered
  // by the stuck-detection when the character holds at the approach point) re-runs the
  // BFS. The budget covers a WHOLE ROOM (the largest rooms are ~50x66 = 3300 squares;
  // 4000 visits cannot be exhausted before the region is complete). A partial BFS was
  // the Raza trap: the fine-reachable region around the Mausoleum door is ~1250 squares
  // — a 400-visit BFS declared both door squares unreachable, the fine-aware exit sort
  // silently degraded to the coarse pick, and the router aimed at the fine-blocked
  // square for hours. With the step mask, moverStepLands is O(1), so a full-room BFS is
  // ~2ms — the old 1.7s figure predates the mask and is no longer the constraint.
  _fineReachableSet(geo, fromCol, fromRow, maxSteps = 4000) {
    const roomKey = this.session?.world?.room?.num ?? this.session?.client?.room?.id ?? '?';
    const cacheKey = `${roomKey}:${fromCol},${fromRow}`;
    if (!this._reachCache) this._reachCache = new Map();
    const hit = this._reachCache.get(cacheKey);
    if (hit) return hit.set;
    const seen = new Set();
    const queue = [[fromCol, fromRow]];
    seen.add(`${fromCol},${fromRow}`);
    const DIRS = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let visited = 0;
    while (queue.length && visited < maxSteps) {
      const [c, r] = queue.shift();
      visited++;
      for (const [dc, dr] of DIRS) {
        const nc = c + dc, nr = r + dr;
        const key = `${nc},${nr}`;
        if (seen.has(key)) continue;
        const ok = this._fineStep(geo, c, r, nc, nr);
        if (ok !== true) continue;  // fine model refuses the step (wall/ledge)
        seen.add(key);
        queue.push([nc, nr]);
      }
    }
    // Bound the cache (room changes + a handful of start squares); evict the oldest.
    if (this._reachCache.size > 32) {
      const oldest = this._reachCache.keys().next().value;
      this._reachCache.delete(oldest);
    }
    this._reachCache.set(cacheKey, { set: seen, at: Date.now() });
    return seen;
  }

  // The CLOSEST square to (col,row) that is COARSE-walkable, found by a bounded BFS
  // on the coarse grid (expanding rings, first walkable hit is the nearest). Used when
  // a declared standOn is a coarse wall (the grid says wall, the fine model / server
  // say floor) — the character cannot path to a wall, so the router aims at the
  // nearest square it can actually walk to. Bounded by the room size so it cannot run
  // away. Returns {col,row} or null. No-op caller-side when the standOn is walkable.
  _nearestCoarseWalkable(geo, col, row) {
    if (!geo?.walkable) return null;
    if (geo.walkable(row, col) === true) return { col, row };
    const seen = new Set([`${col},${row}`]);
    const queue = [[col, row]];
    const DIRS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const maxC = geo.cols ?? 1e9, maxR = geo.rows ?? 1e9;
    let visited = 0;
    const maxSteps = maxC * maxR;
    while (queue.length && visited < maxSteps) {
      const [c, r] = queue.shift();
      visited++;
      for (const [dc, dr] of DIRS) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= maxC || nr >= maxR) continue;
        const key = `${nc},${nr}`;
        if (seen.has(key)) continue;
        if (geo.walkable(nr, nc) !== true) continue;
        return { col: nc, row: nr };
      }
    }
    return null;
  }

  // The CLOSEST square to `standOn` that is FINE-reachable from `me`. This is the
  // approach point: where the character should be before the final (possibly
  // fine-blocked) push into the standOn. It handles the "door is a walled alcove" case
  // — the standOn itself is fine-unreachable, but a nearby square is, and from there the
  // Mover's direct-step fallback (the server is client-authoritative) closes the gap.
  //
  // Uses the FINE model (via a bounded BFS of single-step traces), NOT the coarse grid:
  // the coarse grid over-promises across fences/ledges (it said the door was reachable
  // when the Mover's fine model refused it), which is exactly the disagreement that
  // produced the oscillation. The BFS is bounded (maxSteps) so it stays fast (~1ms per
  // edge). Searches outward from the standOn in expanding rings, returning the first ring
  // that contains a fine-reachable square, and within it the closest such square.
  _findApproach(me, standOn) {
    const geo = this._geo();
    if (!geo) return { col: standOn.col, row: standOn.row, dist: 0 };
    // One bounded BFS gives the whole fine-reachable region from `me`.
    const reach = this._fineReachableSet(geo, me.col, me.row);
    // The standOn itself, if reachable, is the best approach point.
    if (reach.has(`${standOn.col},${standOn.row}`))
      return { col: standOn.col, row: standOn.row, dist: 0 };
    for (let radius = 1; radius <= APPROACH_SEARCH_RADIUS; radius++) {
      let best = null;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;  // this ring only
          const c = standOn.col + dc, r = standOn.row + dr;
          if (!reach.has(`${c},${r}`)) continue;
          const dist = Math.hypot(c - standOn.col, r - standOn.row);
          if (!best || dist < best.dist) best = { col: c, row: r, dist };
        }
      }
      if (best) return best;
    }
    // Nothing within the radius is fine-reachable: fall back to the standOn itself. The
    // Mover will do its best (direct-step fallback); the sub-leg bound keeps this bounded.
    return { col: standOn.col, row: standOn.row, dist: Infinity };
  }

  // Build a BOUNDED chain of waypoints from `me` to `target`, each consecutive pair
  // fine-reachable (a single fine step). Uses a BFS on the fine model (via _fineStep) with
  // PARENT TRACKING, so it finds the actual shortest fine-reachable path — including routes
  // that must go AWAY from the target first to go around a fence/ledge (the greedy monotone
  // expansion could not do this: hill-climbing can't navigate an obstacle that requires a
  // detour). If `target` is directly fine-reachable, the chain is [target]. If it is not
  // (a fine island, like a door), the chain ends at the closest fine-reachable square to the
  // target (the approach point); the Mover's raw-door-push closes the final fine-blocked gap.
  //
  // Bounded: the BFS visits at most maxSteps squares, and the returned chain is capped at
  // SUBLEG_MAX waypoints (the rest are implied by the Mover's per-tick stepping). Returns
  // { chain, complete } where complete is true only if the last waypoint is the target.
  _planSubLegs(me, target) {
    const geo = this._geo();
    if (!geo) return { chain: [{ col: target.col, row: target.row }], complete: true };
    // BFS from `me` with parent tracking, using the ONE edge predicate
    // (`chainStepOk` -> the geometry's `moverStepLands`). The origin-trap
    // leniency that used to live here is the geometry's own job: `moverStepLands`
    // already lets the first edge out of a non-standable origin through, so a
    // second lenient trace here was a second opinion about the same edge.
    const startKey = `${me.col},${me.row}`;
    const parent = new Map([[startKey, null]]);  // key -> parent key
    const queue = [[me.col, me.row]];
    const DIRS = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let visited = 0;
    const maxSteps = 800;  // bounded: 800 fine steps, ~0.2ms each = ~160ms worst case
    const goalKey = `${target.col},${target.row}`;
    let foundGoal = false;
    while (queue.length && visited < maxSteps) {
      const [c, r] = queue.shift(); visited++;
      const key = `${c},${r}`;
      if (key === goalKey) { foundGoal = true; break; }
      for (const [dc, dr] of DIRS) {
        const nc = c + dc, nr = r + dr;
        const nk = `${nc},${nr}`;
        if (parent.has(nk)) continue;
        if (this._fineStep(geo, c, r, nc, nr) !== true) continue;  // fine model refuses
        parent.set(nk, key);
        queue.push([nc, nr]);
      }
    }
    if (foundGoal) {
      // Reconstruct the path from `me` to `target`.
      const path = [];
      let cur = goalKey;
      while (cur) {
        const [c, r] = cur.split(',').map(Number);
        path.unshift({ col: c, row: r });
        cur = parent.get(cur);
      }
      // Drop the start (we're already there) and cap at SUBLEG_MAX waypoints.
      const chain = path.slice(1);
      if (chain.length <= SUBLEG_MAX) return { chain, complete: true };
      // Too long: return the first SUBLEG_MAX waypoints (the Mover walks the rest).
      return { chain: chain.slice(0, SUBLEG_MAX), complete: false };
    }
    // The target is fine-unreachable. Find the closest fine-reachable square to it
    // (INCLUDING the start — if we're already at the closest fine-reachable square, the
    // chain is empty and the raw-door-push handles the final gap).
    let best = null;
    for (const key of parent.keys()) {
      const [c, r] = key.split(',').map(Number);
      const d = Math.hypot(c - target.col, r - target.row);
      if (!best || d < best.d) best = { c, r, d };
    }
    if (!best) return { chain: [{ col: target.col, row: target.row }], complete: false };
    // Reconstruct the path from `me` to the approach point.
    const path = [];
    let cur = `${best.c},${best.r}`;
    while (cur) {
      const [c, r] = cur.split(',').map(Number);
      path.unshift({ col: c, row: r });
      cur = parent.get(cur);
    }
    const chain = path.slice(1);
    if (chain.length <= SUBLEG_MAX) return { chain, complete: false };
    return { chain: chain.slice(0, SUBLEG_MAX), complete: false };
  }

  // CHAIN-SQUARE VALIDITY — the SQUARE half of the same single predicate.
  // A chain square must be standable: edge-reachable is not enough, because
  // advancement requires standing ON each head (a wall head freezes the chain
  // forever — watched (27,33) in 557, fine=False). This is `transitBanned`
  // inverted, which is exactly the square test the mover's own step search
  // applies, so a chain head can never be a square the mover refuses to enter.
  _chainSquareOk(geo, col, row) {
    if (!geo) return true;
    const banned = transitBanned(geo, row, col);
    if (banned === undefined) return true;   // no data = pass (mirrors the mover)
    return banned === false;
  }
  // Truncate a chain at the first non-standable square (keep the valid
  // prefix). Returns { chain, dropped } — dropped counts removed heads.
  _sanitizeChain(chain, geo) {
    if (!chain || !chain.length) return { chain, dropped: 0 };
    let cut = chain.length;
    for (let i = 0; i < chain.length; i++) {
      if (!this._chainSquareOk(geo, chain[i].col, chain[i].row)) { cut = i; break; }
    }
    if (cut === chain.length) return { chain, dropped: 0 };
    return { chain: chain.slice(0, cut), dropped: chain.length - cut };
  }
  // fine-reachable from `me`, there is nothing to decompose (subWp stays null and the
  // leg is a plain walk). Otherwise, plan a bounded chain from `me` toward the standOn;
  // the chain ends at the closest fine-reachable square (the approach point) when the
  // standOn itself is an island. The final push from the approach point into the standOn
  // is left to the Mover's direct-step fallback (the server is client-authoritative, so
  // it accepts a step the fine model refuses).
  _initSubLegs(me) {
    this.subWp = null;
    this._subWpReplans = 0;
    this._subWpPlanAt = this.now();
    const geo = this._geo();
    const standOn = this.leg?.standOn;
    if (!geo || !standOn) return;
    // Fast path MUST use the mover's own planner with the mover's own arguments,
    // so "the planner says reachable" and "the mover will walk it" are the same
    // sentence by construction. The mover plans coarse (see Mover._plan); so do
    // we, with the same step/margin/budget. Any divergence here re-opens the aim
    // flap: this verdict decides whether a chain exists at all.
    try {
      const F = KOD_FINENESS, H = F >> 1;
      const direct = geo.finePathProtocol?.(
        me.col * F + H, me.row * F + H,
        standOn.col * F + H, standOn.row * F + H,
        { step: 8, margin: 12 * F, maxNodes: 4000, coarse: true });
      if (direct?.found) return; // plain walk
    } catch { /* fall through to decomposition */ }
    // The standOn is fine-unreachable: plan a bounded chain toward it. The chain ends at
    // the approach point (closest fine-reachable square); the Mover pushes the last gap.
    // SANITIZE: drop any fine-blocked squares (the BFS edge test can admit one via
    // the origin-trap leniency). A blocked head freezes the chain forever — advancement
    // requires standing on it. Truncate to the standable prefix; empty = plain walk.
    const { chain } = this._planSubLegs(me, standOn);
    const clean = this._sanitizeChain(chain, geo);
    if (clean.dropped > 0) console.error(`[route] sub-leg chain dropped ${clean.dropped} blocked square(s) (leg to ${this.leg?.next})`);
    if (clean.chain.length) this.subWp = clean.chain;
  }

  // We reached the current sub-waypoint (subWp[0]). Advance the chain: drop it, and if
  // the rest is no longer valid (the geometry or our position shifted), re-plan the
  // remainder. Bounded by SUBLEG_MAX_REPLANS so a no-progress loop cannot run forever.
  _advanceSubLeg(me) {
    if (!this.subWp || !this.subWp.length) return;
    this.subWp.shift();
    // FORWARD PROGRESS resets the replan budget: the cap counts CONSECUTIVE
    // failures, not lifetime ones. Otherwise a stall era (before the mover
    // could move at all) permanently exhausts the budget and the chain is
    // dropped exactly when movement starts working again.
    this._subWpReplans = 0;
    if (!this.subWp.length) return;  // chain exhausted: the Mover now pushes the door
    // Re-plan the remainder from where we actually are, in case the original chain is
    // stale. Bounded: if we've re-planned too many times, drop the sub-legs and let the
    // Mover's direct fallback + the leg's stuck-detection take over.
    const now = this.now();
    if (now - this._subWpPlanAt > SUBLEG_REPLAN_MS && this._subWpReplans < SUBLEG_MAX_REPLANS) {
      this._subWpReplans++;
      this._subWpPlanAt = now;
      const geo = this._geo();
      const target = this.subWp[this.subWp.length - 1];
      const chain = this._planSubLegs(me, target);
      const clean = this._sanitizeChain(chain.chain, geo);
      if (clean.dropped > 0) console.error(`[route] sub-leg replan dropped ${clean.dropped} blocked square(s) (leg to ${this.leg?.next})`);
      if (clean.chain.length) this.subWp = clean.chain;
    }
  }

  /**
   * ONE TICK OF TRAVEL. Sends at most one step and returns; never awaits.
   *
   * The returned state is what a decider reads to know whether to keep going, and it is
   * deliberately observational: 'moving' means a step went out, not that it landed.
   */
  tick(frame, act) {
    const t = this.now();
    if (this.dest == null) return this._say('idle');
    const here = resolveRoomNum(frame?.room ?? {}, this.map);
    const me = frame?.position;
    if (here == null || !me) return this._say('blind', { why: 'no room or position yet' });
    // SERVER TRUTH for commitment (see Mover.tick): frame.position may be
    // sim-led via the Pose; stuck/at/chain-advance decisions must use the raw
    // server echo, or chains advance on sends the server never confirmed.
    const srvR = Pose.confirmed(this.session);
    const srvCol = srvR.source !== 'none' ? srvR.col : me.col;
    const srvRow = srvR.source !== 'none' ? srvR.row : me.row;

    // RE-ENTRY ARRIVAL (A1) + CROSS-ROOM OSCILLATION (A2) bookkeeping. Maintain a
    // rolling history of the rooms observed while this route is active. Consecutive
    // duplicates are never pushed, so "the current room appears more than once" means
    // "we left it and came back" (a re-entry), and ">= 2 distinct rooms" means "we are
    // crossing between rooms" (a ping-pong). Per-sample pruning: entries older than
    // (OSCILLATION_MAX + 1) windows are shifted out, so a long route does not
    // accumulate the whole journey, and the history is never bulk-wiped mid-route
    // (which would collapse it to one room and zero the cross-room counter).
    while (this._roomSeq.length && t - this._roomSeq[0].at > (OSCILLATION_MAX + 1) * PROGRESS_WINDOW_MS)
      this._roomSeq.shift();
    const _lastRoom = this._roomSeq[this._roomSeq.length - 1];
    if (_lastRoom === undefined || Number(_lastRoom.room) !== Number(here))
      this._roomSeq.push({ room: Number(here), at: t });
    // RE-ENTRY ARRIVAL (A1): if the character walked out of the DESTINATION room and
    // came back (within the window), it is "arrived" — the hunt room is the room it
    // stands in, and re-entering it is the arrival. This makes arrival reachable for
    // current-room hunt candidates through any legitimate door, and kills the
    // exit-and-re-enter incentive when the character is already in the room. Gated on
    // the room being the destination: a failed leg that walks back to the ORIGIN room
    // is not an arrival (that ping-pong is A2's breaker to catch, not a success).
    const _seenHere = this._roomSeq.filter(r => Number(r.room) === Number(here)).length;
    if (_seenHere > 1 && Number(here) === Number(this.dest)) {
      console.error(`[route] ARRIVED (re-entry) room=${here} dest=${this.dest}`);
      this.clear();
      return this._say('arrived', { why: 're-entry' });
    }
    if (Number(here) === Number(this.dest)) {
      console.error(`[route] ARRIVED room=${here} dest=${this.dest}`);
      this.clear();
      return this._say('arrived');
    }

    // A ROOM CHANGE INVALIDATES THE LEG, always. Where you arrive is not where the
    // return edge is, so nothing about the old leg survives the crossing.
    if (!this.leg || Number(this.leg.fromRoom) !== Number(here)) {
      // LEARNED CROSSINGS: if we held a leg into this room change, its exit
      // square is where we crossed from. Record it (debounced, never throws)
      // so future legs prefer proven squares. Walk-past/go transitions never
      // go through leaveVia, so without this the book never learns from the
      // characters that cross the most.
      try {
        const old = this.leg;
        if (old && Number(old.fromRoom) !== Number(here) && old.standOn?.col != null) {
          recordCrossing(Number(old.fromRoom), Number(here), { row: old.standOn.row, col: old.standOn.col });
        }
      } catch {}
      const r = this._planLeg(here);
      if (!r.leg) {
        // RELEASE THE DOOMED CLAIM. A no-route that holds the dest and skips the
        // mover pump starves the executor for the life of the destination — the
        // :835-839 oscillation breaker already does this correctly (stamp, clear,
        // return). Reuse that shape: stamp _routeDrop so the decider holds off
        // re-marching the same pair, clear() to release the dest, return.
        try { this.session._routeDrop = { rooms: [Number(here), Number(this.dest)], at: Date.now() }; } catch {}
        try { this.session._routeUnroutable = { from: Number(here), to: Number(this.dest), at: Date.now() }; } catch {}
        this.clear();
        return this._say('no-route', { why: r.why });
      }
      this.leg = r.leg;
      this.mark = { col: srvCol, row: srvRow, at: t };
      // MULTI-LEG: if the standOn is not directly fine-reachable from where we are,
      // decompose the approach into a chain of sub-waypoints (around a fence, up a
      // ledge, etc.). If it IS reachable, subWp is empty and the leg is a plain walk.
      this._initSubLegs(me);
    }

    // NET-PROGRESS (OSCILLATION) DETECTION. Sample the position while a leg is active;
    // if a full window passes with no net displacement, the character is oscillating —
    // moving enough to reset every square-held timer, going nowhere. Condemn the
    // current standOn (so the re-plan picks a different door square), clear the leg, and
    // after several verdicts drop the route entirely so the caller re-routes somewhere
    // else. Without this, a coarse-reachable-but-fine-blocked door pins the character
    // for hours (the Raza Mausoleum case).
    {
      const P = this._progress;
      P.push({ t, col: me.col, row: me.row });
      // Keep TWO windows of samples: the detector needs a sample at least one full
      // window old to compare against, and trimming to exactly one window would remove
      // that anchor before it could ever be used (the first version did, and the window
      // never filled — the span was always just under the threshold).
      while (P.length && t - P[0].t > 2 * PROGRESS_WINDOW_MS) P.shift();
      // The anchor: the OLDEST sample at least one window back. Net displacement is
      // measured from it to now; a bouncing character has none.
      let anchor = null;
      for (const s of P) { if (t - s.t >= PROGRESS_WINDOW_MS) { anchor = s; break; } }
      // CROSS-ROOM OSCILLATION BREAKER (A2). Gated on _crossOscAt alone, NOT on the
      // anchor: a character ping-ponging between rooms HAS net displacement (it is
      // crossing), so the room-local detector below resets _oscillations and never
      // fires for it, and its P.length=0 would clear the anchor and skip A2. The
      // signal: >= 2 distinct rooms in the window AND a re-entry to a NON-destination
      // room (the character left a room and came back, but it is not the destination
      // — a re-entry to the destination is A1's arrival, not a ping-pong). Runs once
      // per window.
      if (this._crossOscAt == null || t - this._crossOscAt >= PROGRESS_WINDOW_MS) {
        this._crossOscAt = t;
        const _distinctRooms = new Set(this._roomSeq.map(r => Number(r.room))).size;
        const _isReentry = this._roomSeq.filter(r => Number(r.room) === Number(here)).length > 1;
        // "Insufficient history" (fewer than 2 distinct rooms because of pruning or
        // because the character is in one room) is "no verdict this window", NOT a
        // forgiveness: _crossOsc is left untouched, so it accumulates on every
        // ping-pong verdict and is cleared only on genuine net progress (below) or
        // in to().
        if (_distinctRooms >= 2 && _isReentry && Number(here) !== Number(this.dest)) {
          this._crossOsc++;
          const cosc = this._crossOsc;
          if (cosc >= OSCILLATION_MAX) {
            const wasDest = this.dest;
            const rooms = [...new Set(this._roomSeq.map(r => Number(r.room)))];
            // ROUTE-DROP TTL MEMORY (A3): stamp the session so the decider holds off
            // re-marching the same room pair for 2 minutes (read in the decider, B1).
            try { this.session._routeDrop = { rooms, at: Date.now() }; } catch {}
            this.clear();
            this._crossOsc = 0;
            return this._say('oscillating', { why: `ping-pong between rooms ${rooms.join('/')} x${cosc}; route to ${wasDest} dropped` });
          }
        }
      }
      if (anchor) {
        const net = Math.max(Math.abs(me.col - anchor.col), Math.abs(me.row - anchor.row));
        if (net < PROGRESS_MIN_NET) {
          this._oscillations++;
          const osc = this._oscillations;
          // PRESS, DON'T ALTERNATE. Condemning the stand_on and re-planning
          // to an alternate approach ping-pongs forever: each leg's movement
          // resets this counter, so MAX is never reached. Keep pressing the
          // same stand_on (the mover's raw-door-push is built for doors);
          // only at MAX do we condemn (the next route then avoids it) + drop.
          P.length = 0;
          if (osc >= OSCILLATION_MAX) {
            const aim = this.leg?.standOn;
            if (aim && this.leg?.next != null)
              this._badStandOn.add(`${this.leg.next}:${aim.col},${aim.row}`);
            // This room's exits are not working. Drop the whole route; the caller's
            // goal (hunt) will re-plan — and its own room-escape escalation takes over.
            const wasDest = this.dest;
            this.clear();
            this._oscillations = 0;
            return this._say('oscillating', { why: `no net progress for ${Math.round(PROGRESS_WINDOW_MS/1000)}s ` +
                                              `x${osc}; route to ${wasDest} dropped` });
          }
          return this._say('oscillating', { why: `no net progress for ${Math.round(PROGRESS_WINDOW_MS/1000)}s ` +
                                            `(x${osc}); pressing the same approach` });
        }
        // Real net movement happened within the window: not room-local-oscillating.
        // A single window of progress forgives the room-local verdicts — the counter
        // is for CONSECUTIVE dead windows, not a lifetime total. NOTE: _crossOsc is
        // NOT reset here. A cross-room ping-pong HAS net displacement (it is
        // crossing), so resetting it here would zero it on every crossing and MAX
        // would be unreachable. _crossOsc is reset only in to() (a genuinely new
        // destination) and on the drop path (clear()).
        this._oscillations = 0;
      }
    }

    if (t - this.leg.startedAt > this.legMaxMs) {
      this.leg = null;
      return this._say('replan', { why: 'leg took too long' });
    }

    // STUCK IS MEASURED ON THE CHARACTER'S SERVER POSITION, NOT OUR MODEL OF
    // IT. Every other stall number in this repository measures the driver --
    // which is busy and healthy while a character stands in a wall. This
    // compares the SERVER'S position (echo) to the last one it gave us; the
    // sim advances on every send and would mask a real stall.
    if (this.mark && (srvCol !== this.mark.col || srvRow !== this.mark.row)) {
      this.mark = { col: srvCol, row: srvRow, at: t };
    } else if (this.mark && t - this.mark.at > this.stuckMs) {
      // Measure BEFORE clearing. Reading this.mark after nulling it printed "NaNs",
      // which is a diagnostic that tells you nothing at the exact moment you need one.
      const held = Math.round((t - this.mark.at) / 1000);
      const where = { col: srvCol, row: srvRow };
      const aim = this.leg?.standOn ?? null;
      // A DOOR. If the standOn we're stuck approaching is FINE-BLOCKED, it is a door in a
      // walled gap (the Raza Blacksmith exit, the Raza fence alcoves) and the mover's
      // raw-door-push is the thing that gets us through — it only fires while the mover
      // still HOLDS that destination. Clearing the leg here (the old behavior) dropped the
      // destination, so the next tick re-planned the SAME leg and we looped forever with
      // the character pinned at the door square. Detect that case and KEEP the leg so the
      // mover's raw-door-push engages; only re-plan (clear the leg) when the standOn is a
      // normal square and the character is in a genuine dead-end.
      const geo = this.session?.world?.geometry;
      const standOnFineBlocked = aim && geo?.fineWalkable
        ? geo.fineWalkable(aim.row, aim.col) === false
        : false;
      if (standOnFineBlocked) {
        // Reset the stuck timer so we keep pressing (via the raw-door-push) instead of
        // re-planning the same leg. The mover reports when the push finally lands.
        this.mark = { col: srvCol, row: srvRow, at: t };
        if (process.env.M59_ROUTE_DEBUG !== '0')
          console.error(`[routedbg] ${this.mover?.logName ?? "?"} stuck AT DOOR (${aim.col},${aim.row}) for ${held}s — keeping leg, letting raw-door-push engage`);
        // Fall through to the mover below (do NOT return) so it runs the raw-door-push.
      } else {
        this.leg = null;
        this.mark = null;
        return this._say('stuck', { why: `same square (${where.col},${where.row}) for ${held}s` +
                                         (aim ? `, aiming at (${aim.col},${aim.row})` : '') });
      }
    }

    // At the staging square: the crossing is triggered by walking PAST the boundary, so
    // the target is the square outside the grid rather than the one we stand on.
    // For "go" exits, the crossing is triggered by the go command, not by walking.
    //
    // Use client.self (the current position) for the `at` check — the frame's me
    // (world.position) can lag behind, so a character standing on the standOn would
    // not be detected as `at`, and the crossing (or the walk-past-boundary) would never
    // trigger. client.self is updated by every position packet and is the source the
    // probe/room-view use.
    // Use the SERVER position for the `at` check (see the tick-top note):
    // frame/pose may be sim-led; client.self is the echo. The frame stays as
    // a fallback so a slow echo never blocks a crossing the server took.
    const selfPosAt = Pose.confirmed(this.session);
    const _atCol = selfPosAt?.col ?? me.col;
    const _atRow = selfPosAt?.row ?? me.row;
    const _distToStandOn = Math.max(Math.abs(_atCol - this.leg.standOn.col), Math.abs(_atRow - this.leg.standOn.row));
    const at = _distToStandOn === 0;

    if (at && this.leg.kind === 'go') {
      // Fire the go command to transition rooms.
      act.go();
      return this._say('crossing', { next: this.leg.next, why: 'go command fired' });
    }

    // GO-EXIT NEARBY FALLBACK: if the character is within 4 squares of the
    // standOn and has been stationary for >= 5s, fire the go() command.
    // Uses a separate _goStuckAt timestamp (not the mark, which is reset by
    // route re-sets) so the 5s timer survives the buy intent re-setting the route.
    if (_distToStandOn > 0 && _distToStandOn <= 4 && this.leg.kind === 'go') {
      if (this._goStuckAt == null) {
        // First time we're in the standOn vicinity: start the timer.
        this._goStuckAt = t;
        this._goStuckPos = `${_atCol},${_atRow}`;
      } else if (this._goStuckPos !== `${_atCol},${_atRow}`) {
        // Character moved: reset the timer.
        this._goStuckAt = t;
        this._goStuckPos = `${_atCol},${_atRow}`;
      }
      const _stuckMs = t - this._goStuckAt;
      if (_stuckMs >= 5000) {
        // Limit the number of go() firings: if the server won't transition
        // from 3 squares away, 3 attempts is enough. Drop the route instead
        // of looping forever (per the "press, don't alternate" rule).
        this._goFireCount = (this._goFireCount ?? 0) + 1;
        if (this._goFireCount > 3) {
          this._goFireCount = 0;
          this._goStuckAt = null;
          this._goStuckPos = null;
          return this._say('dropped', { why: `go-exit fallback fired 3x without transition; dropping route` });
        }
        act.go();
        this._goStuckAt = null;
        this._goStuckPos = null;
        return this._say('crossing', { next: this.leg.next, why: `go command fired from nearby (stuck ${Math.round(_stuckMs / 1000)}s at ${_atCol},${_atRow} -> standOn ${this.leg.standOn.col},${this.leg.standOn.row})` });
      }
    } else {
      // Not in the standOn vicinity: reset the timer.
      this._goStuckAt = null;
      this._goStuckPos = null;
    }

    // MULTI-LEG: if there is a sub-waypoint chain, the current target is the NEXT
    // sub-waypoint, not the standOn. Reaching it advances the chain. We advance when the
    // character's CURRENT position (client.self, the source the probe uses — more current
    // than world.position, which can lag) is on the sub-waypoint. The frame's position
    // (world.position) can lag behind, which otherwise stalls the advancement and makes
    // the character oscillate at the approach point.
    // RECOVER DROPPED CHAINS: if the leg has no sub-waypoints but the standOn
    // is unreachable, the decomposition gave up during a stall era (replan
    // budget exhausted before movement worked). Retry periodically — bounded
    // (30s) so a truly impossible leg just re-checks cheaply.
    if ((!this.subWp || !this.subWp.length) && t - (this._subWpRecoverAt ?? 0) > 30000) {
      this._subWpRecoverAt = t;
      this._initSubLegs(me);
    }
    // DROP BLOCKED HEADS: a frozen chain head inside a wall never advances
    // (advancement requires standing on it). Sanitize covers build time;
    // this covers chains built before the fix and races. Keep the LAST
    // square even if blocked when it is the standOn itself (the door-push
    // target); drop a blocked last square that is NOT the standOn (a dead
    // approach — fall back to aiming the standOn directly).
    if (this.subWp && this.subWp.length) {
      const _rgeo = this._geo();
      const _so = this.leg?.standOn;
      while (this.subWp.length > 1) {
        const _h = this.subWp[0];
        if (this._chainSquareOk(_rgeo, _h.col, _h.row)) break;
        console.error(`[route] dropping blocked sub-waypoint (${_h.col},${_h.row}) (leg to ${this.leg?.next})`);
        this.subWp.shift();
      }
      if (this.subWp.length === 1) {
        const _h = this.subWp[0];
        const _isStandOn = _so != null && _h.col === _so.col && _h.row === _so.row;
        if (!_isStandOn && !this._chainSquareOk(_rgeo, _h.col, _h.row)) {
          console.error(`[route] dropping blocked lone approach (${_h.col},${_h.row}) (leg to ${this.leg?.next})`);
          this.subWp = null;
        }
      }
    }
    // DROP EDGE-BLOCKED HEADS: the head square may read open while the EDGE
    // from where we stand is fenced (fence segments run between squares —
    // watched: (22,17)->(23,17) in 557, both open, edge walled). Advancement
    // needs entering; an unenterable head pins the chain like a wall square.
    // Same `chainStepOk` the chain was BUILT with, so this is not a second
    // opinion — it is the one opinion applied again against the current square.
    // GATED on the mover's honest stuck signal (server static 3+ sends): a head
    // the character can still be walked toward is left alone, and dropping a
    // head changes the aim, which must not happen while steps are landing.
    // Keeps a lone standOn (door-push target); drops a lone non-standOn.
    if (this.subWp && this.subWp.length && (this.mover?.stuckTicks ?? 0) >= 3) {
      const _egeo = this._geo();
      const _srv = Pose.confirmed(this.session);
      const _so2 = this.leg?.standOn;
      const headEnterable = () => {
        const h = this.subWp[0];
        if (!_srv || !Number.isFinite(_srv.col) || !Number.isFinite(_srv.row)) return true;
        return this.chainStepOk(_egeo, _srv.row, _srv.col, h.row, h.col) !== false;
      };
      let _guard = 0;
      while (this.subWp.length > 1 && _guard++ < 4) {
        const _h = this.subWp[0];
        if (headEnterable()) break;
        console.error(`[route] dropping edge-blocked sub-waypoint (${_h.col},${_h.row}) (leg to ${this.leg?.next})`);
        this.subWp.shift();
      }
      if (this.subWp.length === 1) {
        const _h = this.subWp[0];
        const _isStandOn = _so2 != null && _h.col === _so2.col && _h.row === _so2.row;
        if (!_isStandOn && !headEnterable()) {
          console.error(`[route] dropping edge-blocked lone approach (${_h.col},${_h.row}) (leg to ${this.leg?.next})`);
          this.subWp = null;
        }
      }
    }
    const sub = this.subWp && this.subWp.length ? this.subWp[0] : null;
    if (sub) {
      // Server-first (see the tick-top note): advance the chain only on
      // squares the server confirmed, never on sim-led positions.
      const selfPos = Pose.confirmed(this.session);
      const onSub = (selfPos && selfPos.col === sub.col && selfPos.row === sub.row)
        || (me.col === sub.col && me.row === sub.row);
      if (onSub) this._advanceSubLeg({ col: sub.col, row: sub.row });
    }
    const aim = this.subWp && this.subWp.length ? this.subWp[0]
      : (at && this.leg.edgeTarget ? this.leg.edgeTarget : this.leg.standOn);
    if (process.env.M59_ROUTE_DEBUG !== '0')
      console.error(`[routedbg] ${this.mover?.logName ?? "?"} here=${here} me=(${me.col},${me.row}) standOn=(${this.leg.standOn?.col},${this.leg.standOn?.row}) sub=(${sub?sub.col+','+sub.row:'-'}) aim=(${aim.col},${aim.row}) dir=${this.leg.direction} kind=${this.leg.kind} subWp=${this.subWp?this.subWp.length:0}`);

    // Hand the aim to the FINE-MODEL MOVER. It plans on wall segments,
    // moves at most MOVEUNITS per tick, and reports blocked when the
    // geometry says no. The actuator is still used for the actual send
    // (the mover goes through the session's pacer).
    // PHASE 2: tell the mover when the aim is a stand_on (exit) square so
    // it can bypass the floor check. The standOn is the square the character
    // stands on to trigger the transition; the edgeTarget is the square
    // beyond the boundary (for the actual crossing). Both are "exit" squares
    // the geometry may mark "no floor" for.
    const isStandOn = (at && this.leg.edgeTarget) ? true : (aim.col === this.leg.standOn?.col && aim.row === this.leg.standOn?.row);
    // Convert aim to {col, row} if it's the edgeTarget ({x, y} protocol units).
    const aimCol = aim.col ?? Math.floor(aim.x / 64);
    const aimRow = aim.row ?? Math.floor(aim.y / 64);
    // ONE-SHOT DIAGNOSTIC, and it exists because the fleet has been standing in an escape fan
    // for the length of this session with `plan ... found=false reason='no fine path'`, and
    // nothing in the log says WHERE the aim came from. The aim is (26,54) while the character
    // is at (59,7): a square that is in bounds in 57 map rooms and in none of the ones the
    // character has occupied. The router's own contract is that the aim is `leg.standOn`,
    // planned from `me`, so it should be in the current room. This names which of those is
    // false. Logged once per leg rather than every tick, because a per-tick line for a
    // condition that never changes is how a 387MB log got written.
    if (this._aimDiagLeg !== this.leg) {
      this._aimDiagLeg = this.leg;
      try {
        console.error(`[aim-dbg] dest=${this.dest} me=(${me.col},${me.row}) aim=(${aimCol},${aimRow}) ` +
          `standOn=${JSON.stringify(this.leg?.standOn)} edgeTarget=${JSON.stringify(this.leg?.edgeTarget ?? null)} ` +
          `subWp=${this.subWp ? this.subWp.length : 'null'} subWp0=${JSON.stringify(this.subWp?.[0] ?? null)} ` +
          `at=${this._at ?? '?'} inBounds=${this._geo()?.inBounds?.(aimRow, aimCol)} ` +
          `room=${this._geo()?.roomNum ?? this._geo()?.num ?? '?'} geoRows=${this._geo()?.rows ?? '?'} geoCols=${this._geo()?.cols ?? '?'}`);
      } catch {}
    }
    // wantRoom IS THE LEG'S TARGET ROOM, and it is the only thing that lets the mover tell a
    // kod teleport corner it wants from one it does not -- those corners are ordinary floor to
    // every geometry predicate. Omitting it makes the mover avoid ALL of them, which in a room
    // whose only exit is a corner means it can never leave.
    this.mover.to(aimCol, aimRow, { standOn: isStandOn, edgeTarget: this.leg.edgeTarget,
                                    by: 'router', wantRoom: this.leg.wantRoom ?? null });
    // tickLogged, not tick: the 1,430-line tick() has 29 exits that log nothing, so a character
    // standing still for three minutes is undiagnosable from the log. The wrapper is the only
    // place that sees every return, and it cannot drift from the code.
    const mr = this.mover.tickLogged({ col: me.col, row: me.row, x: me.x, y: me.y });
    if (mr.state === 'blocked')
      return this._say('blocked', { why: mr.why, next: this.leg.next });
    if (mr.state === 'standing')
      return this._say('standing', { next: this.leg.next });
    if (mr.state === 'arrived') {
      // Reached the aim. If the aim was a sub-waypoint, advance the chain. If it was the
      // standOn (chain empty), the crossing fires via the 'at' check next tick.
      if (sub) this._advanceSubLeg({ col: me.col, row: me.row });
      if (at) return this._say('crossing', { next: this.leg.next });
      return this._say('moving', { to: aim, next: this.leg.next, why: 'sub-leg reached' });
    }
    if (mr.state === 'blinked') {
      // The blink worked: the character is in a new position.
      // Replan from here: clear the current leg and re-plan.
      this.leg = null;
      this.mark = null;
      return this._say('replanning', { why: 'blink changed position, replanning' });
    }
    if (mr.state === 'blink' || mr.state === 'raw-move' || mr.state === 'stuck') {
      // The mover is trying to escape a geometry pocket.
      // Let it continue: report as moving so the decider
      // doesn't interrupt.
      return this._say('moving', { to: aim, next: this.leg?.next ?? null, why: mr.state });
    }
    return this._say(at ? 'crossing' : 'moving', { to: aim, next: this.leg?.next ?? null });
  }

  _say(state, extra = {}) { this.lastState = state; try { this._stateAt = this.now(); } catch {} return { state, ...extra }; }
}

// A route intent for m59-decide.mjs. The router is held by the caller, because a route
// is a COMMITMENT that outlives one decision -- putting it in the intent table would
// rebuild it every tick and it would never get anywhere.
export function routeIntent(router) {
  return (frame, act) => {
    const r = router.tick(frame, act);
    const sent = r.state === 'moving' || r.state === 'crossing';
    if (Date.now() - (router._dbgAt ?? 0) > 15000) {
      router._dbgAt = Date.now();
      try { console.error(`[routedbg] dest=${router.dest} rstate=${r.state} why=${r.why ?? '-'}`); } catch {}
    }
    return { sent, what: sent ? `travel ${r.state} -> ${router.dest}` : null,
             why: sent ? null : (r.why ?? r.state) };
  };
}
