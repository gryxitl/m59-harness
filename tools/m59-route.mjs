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
import { loadMap, findPath } from './m59-map.mjs';
import { objIdToNum } from './m59-hunt-room.mjs';
import { Mover } from './m59-mover.mjs';
import { KOD_FINENESS } from './m59-roo.mjs';

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
const PROGRESS_MIN_NET = Number(process.env.M59_ROUTE_PROGRESS_MIN_NET || 2);
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
    this._committedAim = null;     // the staging square this router is walking to
    this._lastOscAim = null;       // the aim that used up its one free dead window
  }

  to(roomNum) {
    // ROOM 0 IS NOT A ROOM, AND `Number(null)` IS 0.
    //
    // The finite check alone lets `to(null)` through as room ZERO: it is finite, it is a
    // number, and nothing downstream disagrees. The destination then survives every
    // `dest != null` guard in the decider -- 0 is not null -- so the character routes
    // forever toward a room that does not exist, reporting `no route from 150 to 0` on
    // every tick and never falling back to anything that would pick a real one.
    //
    // Sasquatch, 2026-08-27: nine hours in Cor Noth, `state: no-route`, `dest: 0`, zero
    // kills, while the other four worked. Same shape as the sanctuary bug where an absent
    // assignment read as "assigned to room 0" and walked a character out of safety.
    //
    // Reject the absent value BEFORE converting it, and reject non-positive rooms after.
    if (roomNum == null) return false;
    const n = Number(roomNum);
    if (!Number.isFinite(n) || n <= 0) return false;
    if (this.dest !== n) {
      this.dest = n; this.leg = null; this.mark = null; this.subWp = null; this._subWpReplans = 0;
      this._committedAim = null; this._lastOscAim = null;
      this._progress = []; this._oscillations = 0; this._badStandOn.clear();
    }
    return true;
  }

  clear() {
    this.dest = null; this.leg = null; this.mark = null; this.subWp = null; this._subWpReplans = 0;
    this._committedAim = null; this._lastOscAim = null;
    this._progress = []; this._oscillations = 0; this._badStandOn.clear();
    this.lastState = 'idle';
  }

  status() {
    return { dest: this.dest, state: this.lastState,
             leg: this.leg ? { to: this.leg.next, stand_on: this.leg.standOn } : null };
  }

  // THE EXPENSIVE HALF, run only on a room change.
  _planLeg(here) {
    // A new room: the reachability cache (keyed by room) is for the old room now.
    this._reachCache = null;
    const world = this.session?.world;
    if (!world) return { why: 'no world' };
    let hops = null;
    try {
      // A HOP THE ROOM HAS NO DOOR FOR MUST NOT BE PLANNED AGAIN.
      //
      // The graph carries INFERRED REVERSE edges — if 535 has a north exit to Marion, an
      // edge Marion->535 is inferred — and CLAUDE.md is explicit that exits are not doors
      // and are not 1:1. Marion genuinely has no way back to 535: its go-exits lead to
      // 2600, 201, 202, 204 and 205 and nowhere else. So findPath answered "one hop",
      // the leg planner found no usable exit for it, and the pass repeated that for ever.
      // Gountrug stood on Marion's crypt door for two hours doing exactly this.
      //
      // Every hop that has been refused for want of a door is fed back to the planner, so
      // the next plan routes around it instead of rediscovering it. `blockedHops` is the
      // parameter findPath already has for this; nothing was filling it.
      const p = findPath(this.map, here, this.dest,
                         this._doorless?.size ? { blockedHops: this._doorless } : undefined);
      if (p?.found) hops = p.hops ?? [];
    } catch (e) { return { why: `route failed: ${e.message}` }; }
    if (!hops) return { why: `no route from ${here} to ${this.dest}` };

    const next = hops.length ? (hops[0].to ?? hops[0]) : this.dest;
    let exits = [];
    try { exits = world.exits() ?? []; } catch (e) { return { why: `exits failed: ${e.message}` }; }
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
    // EVERY DOOR TO THIS ROOM CONDEMNED IS A FACT ABOUT THE HOP, NOT ABOUT THE DOORS.
    //
    // Forgiving them and picking the same square again is a closed loop when the room
    // offers only ONE way to `next`: condemn it, forgive it, choose it, condemn it. The
    // character never moves and nothing upstream is told the hop is unusable.
    //
    // JayB, 2026-08-28, room 50 at (2,48): the single exit to 586 stages on (3,57), which
    // is not in the 340-square pocket he is standing in — `geo.path(collision)` answers
    // `found: false` and every planner refuses. He logged 231,626 ticks, 358,787 blocked
    // steps, 938,856 side-steps and ARRIVED ZERO TIMES over seven hours. The stillness
    // stall detector never fired because side-stepping is movement, which is the trap
    // docs/m59-routing.md warns about.
    //
    // So: on the second full condemnation of the same hop, mark it doorless. `findPath`
    // already honours `blockedHops`, so the next plan routes to `dest` some other way
    // instead of re-entering the loop. The first condemnation still forgives, because one
    // bad window is not evidence a hop is impossible.
    if (!cands.length) {
      const hop = `${here}>${next}`;
      const seen = (this._allCondemned ??= new Map());
      const n = (seen.get(hop) ?? 0) + 1;
      seen.set(hop, n);
      if (n >= 2) {
        (this._doorless ??= new Set()).add(hop);
        seen.delete(hop);
        this._badStandOn.clear();
        console.error(`[route] ${this.session?.name ?? '?'} every door from ${here} to ${next}`
          + ` condemned twice — treating the hop as unusable and routing around it`);
        // Re-plan the whole route without this hop rather than staging at a square we have
        // just decided cannot be reached.
        this.leg = null; this._committedAim = null;
        return { why: `hop ${hop} is unusable; re-routing` };
      }
      cands.push(...exits.filter(e => Number(e.to) === Number(next) && e.stand_on));
      this._badStandOn.clear();   // first time: forgive rather than leave the room exitless
    }
    // FINE-REACHABILITY OUTRANKS COARSE. The coarse grid over-promises across fences and
    // ledges (it calls a square behind a retaining wall "reachable" in 4 steps when the
    // fine model refuses every step), and picking a coarse-reachable-but-fine-blocked
    // standOn is exactly the Raza Mausoleum door trap: (44,8) wins the coarse sort by
    // distance, the mover cannot walk there, and the character pinned at the wall below
    // it for hours alternating between two escape squares. Compute the fine-reachable set
    // ONCE here (bounded BFS, cached) and sort candidates that can actually be WALKED to
    // ahead of ones that cannot.
    const meNow = this.session?.client?.self ?? null;
    let fineSet = null;
    if (meNow?.col != null) {
      try { fineSet = this._fineReachableSet(this._geo(), meNow.col, meNow.row); }
      catch { fineSet = null; }
    }
    const fineOk = (e) => fineSet != null && e.stand_on != null
      && fineSet.has(`${e.stand_on.col},${e.stand_on.row}`);
    // AND A TIE IS BROKEN BY THE SQUARE, NEVER BY THE ORDER THE EXITS ARRIVED IN.
    //
    // The three keys above tie whenever a room offers the same destination through two
    // adjacent staging squares, which is common: room 150 reaches The King's Way from
    // both (69,30) and (69,31), both `reachable`, both fine-reachable, both 19 steps.
    // `Array.prototype.sort` is stable, so a perfect tie preserves INPUT order — and the
    // input is `world.exits()`, rebuilt from live room data whose order is not guaranteed
    // across refreshes. So the pick flipped between the two, and a flip is not a cosmetic
    // difference: the leg changes, the plan drawn for it is dropped, and the walk starts
    // again from the top.
    //
    // Kage, Lee and Sasquatch, 2026-08-27, room 150: `dest` alternating (69,30)/(69,31)
    // on consecutive summary lines, 57,497 ticks, 18,458 of them "moving", ARRIVED ZERO.
    // Nineteen steps they never got to walk, because the target changed more often than
    // the walk could finish.
    const byReach = (a, b) => (((b.reachable === true) - (a.reachable === true))
      || ((fineOk(b) ? 1 : 0) - (fineOk(a) ? 1 : 0))
      || ((a.steps_away ?? 1e9) - (b.steps_away ?? 1e9))
      || ((a.stand_on?.row ?? 0) - (b.stand_on?.row ?? 0))
      || ((a.stand_on?.col ?? 0) - (b.stand_on?.col ?? 0)));
    cands.sort(byReach);
    // AND HAVING CHOSEN ONE, WALK TO IT. A deterministic tie-break alone is not enough:
    // `steps_away` is measured from where the character is standing NOW, so the ordering
    // legitimately changes as it walks, and two staging squares one apart trade places
    // partway there. Keep the staging square this leg already committed to for as long as
    // it remains a candidate for the SAME next room — it drops out of `cands` by itself if
    // it becomes unreachable or the oscillation breaker condemns it, and that is the only
    // thing that should be able to change our mind mid-approach.
    // THE COMMITMENT CANNOT LIVE ON THE LEG, BECAUSE THE THING IT DEFENDS AGAINST KILLS
    // THE LEG. The oscillation breaker below condemns the current standOn and sets
    // `this.leg = null` in the same breath, so a stickiness keyed on `this.leg` is always
    // reading null exactly when it is needed. Keep the committed aim on the router.
    let sticky = null;
    const committed = this._committedAim;
    if (committed && Number(committed.next) === Number(next)) {
      sticky = cands.find(e => e.stand_on.col === committed.col
                            && e.stand_on.row === committed.row
                            && e.reachable !== false
                            && (!fineSet || fineOk(e))) ?? null;
      if (sticky) this._stickyLegs = (this._stickyLegs ?? 0) + 1;
    }

    const exit = sticky ?? cands.find(e => e.reachable !== false && (!fineSet || fineOk(e)
      // No fine-reachable candidate at all: keep the coarse pick rather than no leg —
      // the sub-leg planner and the mover's raw-door-push still have a chance.
      || !cands.some(x => x.reachable !== false && fineOk(x)))) ?? cands[0];
    if (!exit) {
      // Remember it, so the next plan does not choose the same non-existent door. Keyed the
      // way findPath keys them, `from>to`, and kept on the router because it is a fact about
      // the MAP rather than about this journey.
      (this._doorless ??= new Set()).add(`${here}>${next}`);
      if (!this._doorlessNoted?.has(`${here}>${next}`)) {
        (this._doorlessNoted ??= new Set()).add(`${here}>${next}`);
        console.error(`[route] ${this.session?.name ?? '?'} no door from ${here} to ${next}`
          + ` — the graph offers that hop but the room does not; routing around it`);
      }
      this.leg = null; this.mark = null;
      return { why: `no usable exit from ${here} toward ${next}` };
    }
    // If the chosen exit's stand_on is unreachable and it has alternates, fall back to
    // the first reachable alternate.
    let standOn = exit.stand_on;
    if (exit.reachable === false && Array.isArray(exit.alternates) && exit.alternates.length) {
      const alt = exit.alternates.find(a => a.reachable !== false && a.stand_on)
        ?? exit.alternates.find(a => a.stand_on);
      if (alt?.stand_on) standOn = alt.stand_on;
    }

    // AN EDGE EXIT IS AN EDGE, SO SLIDE ALONG IT TO SOMETHING WE CAN REACH.
    //
    // A `go` exit is a doorway and really is one square. An EDGE exit is the whole boundary —
    // any walkable square on it leaves the room — but the bake records one anchor for it, and
    // a character who cannot reach that one square is reported stuck in a room he could walk
    // out of in ten steps.
    //
    // Lee, in The Sweet Grass Prairies: the south anchor is (49,12); his reachable ground is
    // columns 32-46 and touches the SAME south edge at (49,43) through (49,46), every one
    // walkable. He tried to leave seventeen times. The room has no `go` exits at all, so
    // there was no other candidate and the fallback above kept the anchor he cannot walk to.
    //
    // `fineSet` is already computed for the sort, so this costs a scan of it: keep the
    // anchor's fixed coordinate (the boundary itself) and take the nearest reachable square
    // along the other one.
    if (standOn && fineSet && !fineSet.has(`${standOn.col},${standOn.row}`)
        && (exit.kind === 'edge' || exit.direction)) {
      const dir = String(exit.direction ?? '').toLowerCase();
      const alongCol = dir === 'north' || dir === 'south';   // the row is fixed, the column varies
      let best = null, bestD = Infinity;
      for (const key of fineSet) {
        const [c, r] = key.split(',').map(Number);
        if (!Number.isFinite(c) || !Number.isFinite(r)) continue;
        if (alongCol ? r !== standOn.row : c !== standOn.col) continue;
        const d = Math.hypot(c - (meNow?.col ?? standOn.col), r - (meNow?.row ?? standOn.row));
        if (d < bestD) { bestD = d; best = { col: c, row: r }; }
      }
      if (best) {
        this.session?.log?.(`[route] edge exit to ${next}: anchor (${standOn.col},${standOn.row})`
          + ` unreachable, crossing at (${best.col},${best.row}) instead`);
        standOn = best;
      }
    }

    // AND IF NOTHING ON THE BOUNDARY LINE CAN BE STOOD ON, STEP INWARD.
    //
    // The slide above moves ALONG the boundary. That does not help when the whole line is
    // unreachable, which is the ordinary case: a staging square within a square or two of the
    // map edge cannot hold a body of radius 248, so the fine model refuses it however the
    // coarse grid votes. Measured in the Deep Forest of Farol, aiming at column 30:
    //
    //     row 1  coarse walkable, fine-reachable from nowhere
    //     row 2  coarse walkable, fine-reachable from nowhere
    //     row 3  coarse walkable, reachable from everywhere tried
    //
    // Two characters queued at that crossing and stopped dead, several rows short, with the
    // dashboard reporting "travel moving" the whole time.
    //
    // So walk to the nearest square on the same line that a body can actually occupy, and let
    // the mover's raw boundary push cover the last stride — which is its job, and the one part
    // of this that does not care about the player radius.
    const dirForInward = String(exit.direction ?? exit.dir ?? '').toLowerCase()
      || (() => { try {
            const room = loadMap()?.rooms?.[here];
            const e = (room?.edgeExits ?? []).find(x => Number(x.to) === Number(next));
            return e?.leaveName ? String(e.leaveName).toLowerCase() : '';
          } catch { return ''; } })();
    if (standOn && fineSet && !fineSet.has(`${standOn.col},${standOn.row}`) && dirForInward) {
      const inward = { north: [0, 1], south: [0, -1], west: [1, 0], east: [-1, 0] }[dirForInward];
      if (inward) {
        for (let step = 1; step <= 4; step++) {
          const c = standOn.col + inward[0] * step, r = standOn.row + inward[1] * step;
          if (fineSet.has(`${c},${r}`)) {
            this.session?.log?.(`[route] boundary staging (${standOn.col},${standOn.row}) cannot hold a body;`
              + ` approaching from (${c},${r}) instead`);
            standOn = { col: c, row: r };
            break;
          }
        }
      }
    }

    // DO NOT HAND OUT A LEG THAT CANNOT BE WALKED.
    //
    // The sort above already prefers fine-reachable candidates, and then takes the coarse
    // pick anyway when none of them is reachable — on the reasoning that a bad leg beats
    // no leg. It does not: a staging square outside the body's own pocket is re-issued for
    // ever by whatever is steering, which is how JayB spent seven hours at (2,48) with
    // 938,856 side-steps and zero arrivals.
    //
    // Refusing here is what lets the caller do something else. The hop is marked doorless
    // so `findPath` routes around it on the next plan rather than offering the same
    // impossible staging square again, and the decider's ladder falls to a goal that can
    // make progress — at the bottom, resting. See docs/m59-goap-repayment.md.
    //
    // Only on a POSITIVE finding: `fineSet` must exist and be non-empty, or we know
    // nothing and hand the leg over as before.
    if (fineSet && fineSet.size && standOn && !fineSet.has(`${standOn.col},${standOn.row}`)) {
      const hop = `${here}>${next}`;
      (this._doorless ??= new Set()).add(hop);
      if (!this._unreachNoted?.has(hop)) {
        (this._unreachNoted ??= new Set()).add(hop);
        console.error(`[route] ${this.session?.name ?? '?'} ${hop}: staging square`
          + ` (${standOn.col},${standOn.row}) is not reachable from (${meNow?.col},${meNow?.row})`
          + ` — marking the hop unusable and routing around it`);
      }
      this.leg = null; this.mark = null; this._committedAim = null;
      return { why: `${hop}: staging square unreachable; re-routing` };
    }

    // Record what this router is now committed to, so a leg torn down by the oscillation
    // breaker is rebuilt aiming at the SAME square rather than the other one.
    this._committedAim = { next: Number(next), col: standOn?.col, row: standOn?.row };

    // Compute an edge target if the exit doesn't provide one.
    // The edge target is one square beyond the staging square,
    // in the direction of the exit. Walking to it triggers
    // the room change.
    let edgeTarget = exit.edge_target ?? null;
    const finiteP = (p) => p && Number.isFinite(p.col) && Number.isFinite(p.row);
    if (!finiteP(edgeTarget)) edgeTarget = null;
    // The exit's own direction if it has one, the baked anchor's `dir` if it does not.
    let dir = String(exit.direction ?? exit.dir ?? '').toLowerCase();
    // FAILING BOTH, ASK THE MAP. The room's own edgeExits name the side you leave by
    // ("north" -> 557), which is the authoritative answer and does not care where the staging
    // square happens to sit. This is the case that actually bites: West Jasper's anchor to 557
    // is at (60,1) with dir "north", but the staging square is (60,2) — one in from the
    // boundary — so a rule keyed on the boundary never fires, and Lee logged 462 arrivals at
    // (60,2) against 7 crossing attempts without ever leaving the room.
    if (!dir) {
      try {
        const room = loadMap()?.rooms?.[here];
        const e = (room?.edgeExits ?? []).find(x => Number(x.to) === Number(next));
        if (e?.leaveName) dir = String(e.leaveName).toLowerCase();
      } catch { /* no map: fall through to the boundary guess below */ }
    }

    // AND FAILING THAT, THE BOUNDARY THE STAGING SQUARE IS STANDING ON.
    //
    // An edge crossing fires by walking PAST the boundary, so the target has to be a square
    // BEYOND it. With no direction and no baked edge_target there was nothing to aim at, and
    // the earlier guard fell back to the standOn — which is where the character already is, so
    // it arrives, re-aims, arrives again. Watched on Lee at (60,2) in West Jasper: five
    // `travel crossing -> 557` decisions and three `ARRIVED at (60,2)` in a row, never
    // crossing. A staging square sits ON the boundary by definition, so which boundary it is
    // tells us which way is out.
    if (!dir && standOn && this.leg?.kind !== 'go') {
      const geo = this._geo?.();
      const rows = geo?.rows ?? null, cols = geo?.cols ?? null;
      // At the edge OR one square in from it — a staging square is often the latter.
      if (standOn.row <= 2) dir = 'north';
      else if (rows && standOn.row >= rows - 1) dir = 'south';
      else if (standOn.col <= 2) dir = 'west';
      else if (cols && standOn.col >= cols - 1) dir = 'east';
    }
    // THE CROSSING IS TRIGGERED BY COORDINATES OUTSIDE THE ROOM, NOT BY ONE STEP.
    //
    // `room.kod`'s SomethingMoved picks the edge from the coordinates against the CURRENT
    // room's bounds: `new_row > piRows` leaves south, `< 1` leaves north, `new_col > piCols`
    // east, `< 1` west. So the target has to be PAST the boundary. One step beyond the
    // staging square is the same thing only when the staging square is already ON the
    // boundary — and it often is not.
    //
    // Room 546 is 50x49 and its exit to 547 stages on (22,48). One step south is (22,49),
    // which is still inside a 49-row room, so walking there crossed nothing: the mover
    // reported "arrived", the router stayed in `crossing`, and the character stood on the
    // edge target indefinitely. Gountrug and Lee were both parked on that square on
    // 2026-08-27, one of them for forty minutes, on the way to the smith.
    //
    // The other coordinate is kept from the staging square, because that is the part the
    // exit actually chose. Without geometry we cannot know the bound, so the old one-step
    // guess stays as the fallback rather than inventing a number.
    if (!edgeTarget && dir) {
      const dx = dir === 'east' ? 1 : dir === 'west' ? -1 : 0;
      const dy = dir === 'south' ? 1 : dir === 'north' ? -1 : 0;
      if (dx || dy) {
        const geo = this._geo?.();
        const rows = geo?.rows, cols = geo?.cols;
        let col = standOn.col + dx, row = standOn.row + dy;
        if (dir === 'north') row = 0;
        else if (dir === 'west') col = 0;
        else if (dir === 'south' && Number.isFinite(rows)) row = rows + 1;
        else if (dir === 'east' && Number.isFinite(cols)) col = cols + 1;
        edgeTarget = { col, row };
      }
    }

    return { leg: { fromRoom: here, next, standOn,
                    edgeTarget,
                    direction: exit.direction ?? dir ?? null,
                    kind: exit.kind ?? 'walk',
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

  // Is a single step from (c1,r1) to the adjacent (c2,r2) allowed by the FINE model?
  // This is a CHEAP check (a single traceFineMoveClient, ~1ms) unlike finePathProtocol
  // (a full A*, ~1.8s per blocked square). It is what the Mover effectively enforces
  // step-by-step, so an approach point found with this oracle is one the Mover can
  // actually stand on. Returns true/false, or null if the geometry can't answer.
  _fineStep(geo, c1, r1, c2, r2) {
    if (!geo) return null;
    if (c2 < 0 || r2 < 0) return false;
    // THE SAME PREDICATE THE A* AND THE MOVER USE (Option A: one shared
    // predicate). `moverStepLands` is the function the mover's step search and the
    // A* edge test both consult, so a sub-leg chain built on it is guaranteed to use
    // steps the mover will actually take. The old `_fineStep` used a radius-248/no-slide
    // `traceFineMoveClient` directly, which disagreed with both the A* and the mover:
    // it saw the direct approach (44,11) as blocked and routed a long detour to (42,8),
    // while the A* (moverStepLands) said (44,11) was reachable. Now the sub-leg BFS,
    // the A*, and the mover all ask the same question.
    //
    // ORIGIN-TRAP ESCAPE: the BFS starts from `me`, which may be a non-standable
    // square (a respawn point, a ledge edge). `moverStepLands` refuses every first
    // edge out of such a square (no stand point to start the trace from), which would
    // strand the BFS at the start. For the FIRST step out of a non-standable origin,
    // fall back to the lenient radius-248 trace so the BFS can leave the trap square;
    // every subsequent step uses the strict `moverStepLands`.
    if (geo.moverStepLands) {
      const originStandable = geo.standable ? geo.standable(r1, c1) : true;
      if (originStandable === false && (c1 === this._bfsOriginC && r1 === this._bfsOriginR)) {
        // lenient fallback for the first edge out of the origin
        const CF = 1024, H = 512;
        try {
          const a = geo.standPoint(r1, c1) ?? { x: c1 * CF + H, y: r1 * CF + H };
          const b = geo.standPoint(r2, c2) ?? { x: c2 * CF + H, y: r2 * CF + H };
          const t = geo.traceFineMoveClient(a.x, a.y, b.x, b.y, { slide: false, playerRadius: 248 });
          return t?.arrived === true;
        } catch { return false; }
      }
      return geo.moverStepLands(r1, c1, r2, c2);
    }
    // No moverStepLands on this geometry (test fixture): fall back to the old trace.
    if (!geo.traceFineMoveClient) return null;
    const CF = 1024, H = 512;
    const x1 = c1 * CF + H, y1 = r1 * CF + H;
    const x2 = c2 * CF + H, y2 = r2 * CF + H;
    try {
      const t = geo.traceFineMoveClient(x1, y1, x2, y2, { slide: false });
      return t?.arrived === true;
    } catch { return null; }
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
    this._bfsOriginC = fromCol;
    this._bfsOriginR = fromRow;
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
    // Record the BFS origin so _fineStep can give the FIRST step out of a
    // non-standable origin the lenient escape (see _fineStep). Reset each plan.
    this._bfsOriginC = me.col;
    this._bfsOriginR = me.row;
    // BFS from `me` with parent tracking, using _fineStep as the edge test.
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

  // Set up the sub-leg chain for a freshly planned leg. If the standOn is directly
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
    // Fast path: is the standOn directly fine-reachable? (One bounded BFS.)
    const reach = this._fineReachableSet(geo, me.col, me.row);
    if (reach.has(`${standOn.col},${standOn.row}`)) return;  // plain walk
    // The standOn is fine-unreachable: plan a bounded chain toward it. The chain ends at
    // the approach point (closest fine-reachable square); the Mover pushes the last gap.
    const { chain } = this._planSubLegs(me, standOn);
    if (chain.length) this.subWp = chain;
    this._dropReachedSubWp();
  }

  // We reached the current sub-waypoint (subWp[0]). Advance the chain: drop it, and if
  // the rest is no longer valid (the geometry or our position shifted), re-plan the
  // remainder. Bounded by SUBLEG_MAX_REPLANS so a no-progress loop cannot run forever.
  _advanceSubLeg(me) {
    if (!this.subWp || !this.subWp.length) return;
    this.subWp.shift();
    if (!this.subWp.length) return;  // chain exhausted: the Mover now pushes the door
    // Re-plan the remainder from where we actually are, in case the original chain is
    // stale. Bounded: if we've re-planned too many times, drop the sub-legs and let the
    // Mover's direct fallback + the leg's stuck-detection take over.
    const now = this.now();
    if (now - this._subWpPlanAt > SUBLEG_REPLAN_MS && this._subWpReplans < SUBLEG_MAX_REPLANS) {
      this._subWpReplans++;
      this._subWpPlanAt = now;
      const target = this.subWp[this.subWp.length - 1];
      // PLAN FROM WHERE THE BODY IS, NOT FROM WHERE THE FRAME SAYS IT WAS.
      //
      // `me` here is the frame position (world.position), which lags a square behind the
      // live one. `_planSubLegs` drops only its own start square, so planning from the
      // stale square yields a chain whose FIRST waypoint is the square we are standing on
      // — and that is a fixed point: the mover reports `arrived` immediately, `onSub`
      // fires, we advance, we re-plan from the same stale square, and the head lands on
      // our feet again. JayB sat on (13,49) in the Sweet Grass Prairies through 760
      // arrivals with the leg still aiming (20,2), because the aim WAS his own square.
      // Use the same source `onSub` compares against, so the two cannot disagree.
      const here = this.session?.client?.self ?? me;
      const chain = this._planSubLegs({ col: here.col, row: here.row }, target);
      if (chain.chain.length) this.subWp = chain.chain;
    }
    this._dropReachedSubWp();
  }

  // A CHAIN MUST NEVER BEGIN WHERE WE ALREADY STAND. Any leading waypoint on the body's
  // own square is not a destination, it is a no-op the mover answers with `arrived` --
  // and an aim that is satisfied the instant it is set advances nothing. This is the
  // invariant, enforced wherever the chain is (re)built, rather than a fix at one call
  // site: the same fixed point is reachable from `_replanSubLegs` too.
  _dropReachedSubWp() {
    if (!this.subWp || !this.subWp.length) return;
    const here = this.session?.client?.self;
    if (!here || !Number.isFinite(here.col) || !Number.isFinite(here.row)) return;
    let dropped = 0;
    while (this.subWp.length
           && this.subWp[0].col === here.col && this.subWp[0].row === here.row) {
      this.subWp.shift();
      dropped++;
    }
    if (dropped && process.env.M59_ROUTE_DEBUG === '1')
      console.error(`[routedbg] dropped ${dropped} sub-waypoint(s) already occupied at (${here.col},${here.row})`);
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

    if (Number(here) === Number(this.dest)) { this.clear(); return this._say('arrived'); }

    // A ROOM CHANGE INVALIDATES THE LEG, always. Where you arrive is not where the
    // return edge is, so nothing about the old leg survives the crossing.
    if (!this.leg || Number(this.leg.fromRoom) !== Number(here)) {
      const r = this._planLeg(here);
      if (!r.leg) return this._say('no-route', { why: r.why });
      this.leg = r.leg;
      this.mark = { col: me.col, row: me.row, at: t };
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
      if (anchor) {
        const net = Math.max(Math.abs(me.col - anchor.col), Math.abs(me.row - anchor.row));
        if (net < PROGRESS_MIN_NET) {
          this._oscillations++;
          const aim = this.leg?.standOn;
          // CONDEMN ON THE SECOND VERDICT, NOT THE FIRST — and only against the SAME aim.
          //
          // Condemning immediately is right when the door is the problem (the Raza
          // Mausoleum case: a standOn the coarse grid promises and the fine model refuses,
          // which never becomes walkable however long you look at it). It is wrong when
          // the door is fine and the character merely had a bad window, because the remedy
          // IS a change of direction: the re-plan picks the other staging square, the
          // character turns round and walks the other way, and the next window is dead for
          // exactly that reason. The breaker then condemns that square too, both are
          // condemned, the set is forgiven, and the cycle repeats.
          //
          // Kage, Lee and Sasquatch, 2026-08-27, room 150: two good doors to The King's
          // Way at (69,30) and (69,31), both reachable, both 19 steps. They ping-ponged
          // between (68,29) and (69,29) for 57,497 ticks — walking west, being turned
          // round, walking east — and ARRIVED ZERO. Every individual verdict was correct;
          // the remedy was the thing keeping them there.
          //
          // So a door has to fail twice IN A ROW to be condemned. A genuinely unreachable
          // one still is, one window later; a good one survives a single bad window and
          // the commitment above keeps the character walking to it.
          const aimKey = aim && this.leg?.next != null
            ? `${this.leg.next}:${aim.col},${aim.row}` : null;
          if (aimKey) {
            if (this._lastOscAim === aimKey) {
              this._badStandOn.add(aimKey);
              this._committedAim = null;      // it is condemned; stop steering back to it
              this._lastOscAim = null;
            } else {
              this._lastOscAim = aimKey;      // one free window, then it goes
            }
          }
          const osc = this._oscillations;
          this.leg = null;
          this.mark = null;
          this.subWp = null;
          P.length = 0;
          if (osc >= OSCILLATION_MAX) {
            // This room's exits are not working. Drop the whole route; the caller's
            // goal (hunt) will re-plan — and its own room-escape escalation takes over.
            const wasDest = this.dest;
            this.clear();
            this._oscillations = 0;
            return this._say('oscillating', { why: `no net progress for ${Math.round(PROGRESS_WINDOW_MS/1000)}s ` +
                                              `x${osc}; route to ${wasDest} dropped` });
          }
          return this._say('oscillating', { why: `no net progress for ${Math.round(PROGRESS_WINDOW_MS/1000)}s ` +
                                            `(x${osc}); condemning (${aim?.col ?? '?'},${aim?.row ?? '?'}) and re-planning` });
        }
        // Real net movement happened within the window: not oscillating. A single
        // window of progress forgives earlier verdicts — the counter is for CONSECUTIVE
        // dead windows, not a lifetime total. That includes the pending first-strike
        // above: a door that has since been walked toward is not on its second strike.
        this._oscillations = 0;
        this._lastOscAim = null;
      }
    }

    if (t - this.leg.startedAt > this.legMaxMs) {
      this.leg = null;
      return this._say('replan', { why: 'leg took too long' });
    }

    // STUCK IS MEASURED ON THE CHARACTER, NOT ON US. Every other stall number in this
    // repository measures the driver -- which is busy and healthy while a character
    // stands in a wall. This compares the SERVER'S position to the last one it gave us.
    if (this.mark && (me.col !== this.mark.col || me.row !== this.mark.row)) {
      this.mark = { col: me.col, row: me.row, at: t };
    } else if (this.mark && t - this.mark.at > this.stuckMs) {
      // Measure BEFORE clearing. Reading this.mark after nulling it printed "NaNs",
      // which is a diagnostic that tells you nothing at the exact moment you need one.
      const held = Math.round((t - this.mark.at) / 1000);
      const where = { col: me.col, row: me.row };
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
        this.mark = { col: me.col, row: me.row, at: t };
        if (process.env.M59_ROUTE_DEBUG === '1')
          console.error(`[routedbg] t3 stuck AT DOOR (${aim.col},${aim.row}) for ${held}s — keeping leg, letting raw-door-push engage`);
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
    const selfPosAt = this.session?.client?.self;
    const at = (me.col === this.leg.standOn.col && me.row === this.leg.standOn.row)
      || (selfPosAt && selfPosAt.col === this.leg.standOn.col && selfPosAt.row === this.leg.standOn.row);

    if (at && this.leg.kind === 'go') {
      // Fire the go command to transition rooms.
      act.go();
      return this._say('crossing', { next: this.leg.next, why: 'go command fired' });
    }

    // MULTI-LEG: if there is a sub-waypoint chain, the current target is the NEXT
    // sub-waypoint, not the standOn. Reaching it advances the chain. We advance when the
    // character's CURRENT position (client.self, the source the probe uses — more current
    // than world.position, which can lag) is on the sub-waypoint. The frame's position
    // (world.position) can lag behind, which otherwise stalls the advancement and makes
    // the character oscillate at the approach point.
    const sub = this.subWp && this.subWp.length ? this.subWp[0] : null;
    if (sub) {
      const selfPos = this.session?.client?.self;
      const onSub = (selfPos && selfPos.col === sub.col && selfPos.row === sub.row)
        || (me.col === sub.col && me.row === sub.row);
      if (onSub) this._advanceSubLeg({ col: sub.col, row: sub.row });
    }
    // A NON-FINITE AIM IS NOT AN AIM. `edgeTarget` comes either from the baked exit or is
    // derived from the direction, and both can be absent or half-formed — a `{col:undefined,
    // row:undefined}` reaches the mover as `to(undefined, undefined)`, which plans a route to
    // NaN and comes back "no free space at the destination". Watched on Lee at the West Jasper
    // border: four NO-ROUTEs in a row against an aim that was never a place.
    const finite = (p) => p && Number.isFinite(p.col) && Number.isFinite(p.row);
    const edgeAim = at && finite(this.leg.edgeTarget) ? this.leg.edgeTarget : null;
    const aim = (this.subWp && this.subWp.length && finite(this.subWp[0])) ? this.subWp[0]
      : (edgeAim ?? this.leg.standOn);
    if (!finite(aim))
      return this._say('blocked', { why: `leg to ${this.leg.next} has no usable aim`
        + ` (standOn ${JSON.stringify(this.leg.standOn)}, edgeTarget ${JSON.stringify(this.leg.edgeTarget)})` });
    if (process.env.M59_ROUTE_DEBUG === '1')
      console.error(`[routedbg] t3 here=${here} me=(${me.col},${me.row}) standOn=(${this.leg.standOn?.col},${this.leg.standOn?.row}) sub=(${sub?sub.col+','+sub.row:'-'}) aim=(${aim.col},${aim.row}) dir=${this.leg.direction} kind=${this.leg.kind} subWp=${this.subWp?this.subWp.length:0}`);

    // Hand the aim to the FINE-MODEL MOVER. It plans on wall segments,
    // moves at most MOVEUNITS per tick, and reports blocked when the
    // geometry says no. The actuator is still used for the actual send
    // (the mover goes through the session's pacer).
    this.mover.to(aim.col, aim.row);
    const mr = this.mover.tick({ col: me.col, row: me.row, x: me.x, y: me.y });
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
      return this._say('moving', { to: aim, next: this.leg.next, why: mr.state });
    }
    return this._say(at ? 'crossing' : 'moving', { to: aim, next: this.leg.next });
  }

  _say(state, extra = {}) { this.lastState = state; return { state, ...extra }; }
}

// A route intent for m59-decide.mjs. The router is held by the caller, because a route
// is a COMMITMENT that outlives one decision -- putting it in the intent table would
// rebuild it every tick and it would never get anywhere.
export function routeIntent(router) {
  return (frame, act) => {
    const r = router.tick(frame, act);
    const sent = r.state === 'moving' || r.state === 'crossing';
    return { sent, what: sent ? `travel ${r.state} -> ${router.dest}` : null,
             why: sent ? null : (r.why ?? r.state) };
  };
}
