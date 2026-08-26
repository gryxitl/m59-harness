#!/usr/bin/env node
// m59-combat.mjs -- THE COMBAT STATE MACHINE for the tick driver.
//
// Safe-wall combat is a multi-step sequence:
//   1. Find a safe spot (wall/corner with 2+ non-walkable neighbors)
//   2. Walk to the safe spot
//   3. If mob is nearby: PULL (walk to mob, swing once, walk back)
//   4. Fight from the safe spot: one swing per 1050ms, hold position
//   5. If mob is far and not aggroed: walk toward it (closing gap)
//
// In the tick model, this is STATE, not a loop. The controller
// holds the current phase and produces one action per tick.
// The decider queries it when the _fight goal is active.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpawns } from './m59-spawns.mjs';
import { KOD_FINENESS, protocolToClient } from './m59-roo.mjs';
import { zapStatus, shouldCastZap, findZapSpell, equippedWeapon } from './m59-zap.mjs';
import './m59-navgeom.mjs';   // installs the height model + lenient fine path onto RoomGeometry

const SPAWNS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'compendium', 'data', 'spawns.json');
const MERCHANTS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', 'm59-merchants.json');

// Everyone the merchant index knows about — shopkeepers, bankers, innkeepers. Read once.
let _merchants = null;
function merchantIndex() {
  if (_merchants) return _merchants;
  try {
    const raw = JSON.parse(readFileSync(MERCHANTS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.merchants ?? Object.values(raw));
    _merchants = list.filter(m => m && typeof m === 'object');
  } catch { _merchants = []; }
  return _merchants;
}

// A name reduced to its words, sorted, so a class name and a display name for the same
// creature land on the same key. See _creatureNames.
export const creatureKey = (name) => String(name ?? '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')     // SpiderBaby -> Spider Baby
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(Boolean)
  .sort()
  .join('|');
import { recordEvent } from './m59-ledger.mjs';
import * as tougher from './m59-tougher.mjs';

/**
 * Compute the adjacent square to walk to when engaging a target.
 * Instead of walking ONTO the target (which causes overlap),
 * walk to the square just before it — 1 square away in the
 * direction from the character to the target.
 */
function engageSquare(me, target) {
  const dx = target.col - me.col;
  const dy = target.row - me.row;
  if (dx === 0 && dy === 0) return { col: me.col, row: me.row };
  // Step one square toward the target.
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { col: me.col + Math.sign(dx), row: me.row };
  } else {
    return { col: me.col, row: me.row + Math.sign(dy) };
  }
}

// How close (in squares) the mob must be for a pull to be worth it.
// Each walkTo step costs ~250ms; a pull is two walks + one swing.
// For a mob 20 steps away, that's 40+ seconds. Cap at 12.
const PULL_RANGE = 12;
// How close (in squares) for "in reach" — melee is a disc of
// radius 2-3 on square coordinates.
//
// TWO, NOT THREE, AND THE REASON IS THE METRIC MISMATCH. The check below measures
// MANHATTAN distance (|dx| + |dy|, what the mover costs) while the server's attack range is
// squared EUCLIDEAN. At 3 those disagree exactly at the boundary: a target 3 tiles NSEW is
// Manhattan 3 and Euclidean 3, sitting on the outer edge of a 2-3 disc, so the swing is the
// server's to refuse. Manhattan <= 2 guarantees Euclidean <= 2 for every arrangement, which
// is inside the disc whatever the server rounds to.
//
// Measured before the change: JayB, 331 swings in nine minutes at level-25 mummies, zero
// kills, neither side losing health. A swing refused for range costs the whole second of
// cooldown it was paced against, so a boundary swing is not a cheap miss — it is the round.
const MELEE_REACH = 2;
// PUNCHING IS SHORTER THAN SWINGING. Bare hands reach one square, not two, so an unarmed
// character that closes to melee range stands a square short and swings at air for ever.
const PUNCH_REACH = 1;
const WEAPONISH = /\b(mace|sword|axe|hammer|dagger|club|staff|halberd|spear|flail|scimitar|rapier|bow)\b/i;
// CAST_REACH: how close a caster needs to be to cast a bolt at a mob.
// Bolt spells (zap, fire bolt) travel several squares, so casters can
// engage from farther out than melee.
const CAST_REACH = 8;
// Swing cooldown: one swing per 1000ms (the server's IsOkayAttackTime threshold).
// Previously 950ms, which was under the server cooldown and caused rejected swings.
// At 1000ms we hit the server's rate exactly: one clean swing per second.
const SWING_MS = 1000;
// Retreat (take cover) when HP drops below this fraction. Mob-first
// combat: engage directly, but back off to a safe spot when hurt.
const RETREAT_HP_PCT = 55; // 0-100

/**
 * Check if a cell is "at a wall": 2+ of its 4 cardinal neighbors
 * are non-walkable. This is a corner or alcove.
 */
function wallScore(r, c, isWalkable) {
  let walls = 0;
  if (!isWalkable(r + 1, c)) walls++;
  if (!isWalkable(r - 1, c)) walls++;
  if (!isWalkable(r, c + 1)) walls++;
  if (!isWalkable(r, c - 1)) walls++;
  return walls;
}

// Per-room cache of safe-spot CANDIDATES: walkable squares with 2+ wall
// neighbors and <4 wall neighbors (not a pocket). This is a static
// property of the room geometry — the walls don't move — so it is computed
// once per room and reused. Without the cache, every findSafeSpot call
// re-scanned a 25x25 box and re-scored every square, which added up over
// a fight. The reachability check (relative to the character) is still done
// per-call on the short candidate list.
const _safeSpotCache = new Map(); // roomKey -> { list, isWalkable }
const SAFE_SPOT_CACHE_LIMIT = 64; // rooms

function safeSpotCandidatesFor(roomKey, cols, rows, isWalkable) {
  const hit = _safeSpotCache.get(roomKey);
  if (hit) return hit.list;
  const list = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isWalkable(r, c)) continue;
      const s = wallScore(r, c, isWalkable);
      if (s >= 2 && s < 4) list.push({ col: c, row: r, score: s });
    }
  }
  if (_safeSpotCache.size >= SAFE_SPOT_CACHE_LIMIT) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = _safeSpotCache.keys().next().value;
    _safeSpotCache.delete(oldest);
  }
  _safeSpotCache.set(roomKey, { list, isWalkable });
  return list;
}

/**
 * Find the nearest safe spot within a radius of the given position.
 * Returns { col, row, score } or null.
 *
 * Uses a per-room cache of candidate squares (wallScore >= 2, not a
 * pocket) so the wall-scoring is done once per room, not every call.
 * The reachability check (relative to the character) is still applied
 * to the short candidate list.
 *
 * A safe spot must:
 *   1. Be walkable (both grids agree or no data)
 *   2. Have 2+ wall neighbors (protected)
 *   3. Have < 4 wall neighbors (not a pocket)
 *   4. Be reachable: a fine path from the character to the spot exists.
 */
function findSafeSpot(col, row, radius, isWalkable, geo, meCol, meRow, roomKey) {
  const cols = geo?.cols ?? 64;
  const rows = geo?.rows ?? 64;
  const candidates = safeSpotCandidatesFor(roomKey ?? 'unknown', cols, rows, isWalkable);
  // Pre-filter to those within radius, sort by distance, and only run the
  // expensive reachability A* on the nearest few. The wall-scoring is cached;
  // the reachability check is the remaining cost, so bound it.
  const inRadius = [];
  for (const cand of candidates) {
    const dist = Math.hypot(cand.row - row, cand.col - col);
    if (dist <= radius) inRadius.push({ ...cand, dist });
  }
  inRadius.sort((a, b) => a.dist - b.dist);
  let best = null;
  for (const cand of inRadius.slice(0, 12)) {
    // Reachability check: a fine path from the character to the spot.
    if (geo?.finePathProtocol && meCol != null && meRow != null) {
      const fromX = meCol * KOD_FINENESS + 32;
      const fromY = meRow * KOD_FINENESS + 32;
      const toX = cand.col * KOD_FINENESS + 32;
      const toY = cand.row * KOD_FINENESS + 32;
      const path = geo.finePathProtocol(fromX, fromY, toX, toY, {
        step: 8, margin: 4 * KOD_FINENESS, maxNodes: 2000,
      });
      if (!path.found) continue;
    }
    if (!best) {
      best = { col: cand.col, row: cand.row, score: cand.score, dist: cand.dist };
    }
  }
  return best;
}

/**
 * The combat state machine. One instance per character.
 *
 * Phases:
 *   idle      - no target, not in combat
 *   approach  - walking to the safe spot
 *   hold      - at the safe spot, waiting for the mob
 *   pull      - walking to the mob to engage (will walk back)
 *   fight     - at the safe spot, swinging at the mob
 *   close     - mob is far and not aggroed, walking toward it
 *
 * The decider calls tick() each time the _fight goal is active.
 * It returns one action: { kind, ... } where kind is
 * 'walk', 'swing', 'face', or 'idle'.
 */
export class CombatController {
  constructor(session) {
    this.session = session;
    this.phase = 'idle';
    this.safeSpot = null;      // { col, row }
    this.targetId = null;      // the mob we're fighting
    this.targetName = null;
    this.lastSwing = 0;        // wall-clock ms of last swing
    this.swings = 0;           // swings at the CURRENT quarry, for the ledger's `rounds`
    this.pullFrom = null;      // position before pull (to walk back to)
    this.stuckTicks = 0;
    this._approachStart = 0;   // wall-clock ms when approach started
  }

  reset() {
    this.phase = 'idle';
    this.safeSpot = null;
    this.targetId = null;
    this._walkDest = null;
    this.targetName = null;
    this.lastSwing = 0;
    this.swings = 0;
    this.pullFrom = null;
    this.stuckTicks = 0;
  }

  /**
   * ONE TICK OF COMBAT. Returns an action for the actuator.
   *
   * @param {object} frame - the sensor frame (position, objects, vitals)
   * @param {object} act   - the actuator (step, swing, face, walk)
   * @param {object} [ws]  - world state. If ws._targetId is set, the
   *   controller fights THAT target, not the first object in the room.
   *   This is the contract: the ceiling is checked against one target,
   *   the swing must land on the same one.
   * @returns {object} { kind, what, why? }
   */
  tick(frame, act, ws) {
    const c = this.session?.client;
    if (!c || c.state !== 'game') return { kind: 'idle', why: 'not in game' };

    const me = frame?.position ?? c.self;
    if (!me || me.col == null) return { kind: 'idle', why: 'no position' };

    // Build a walkable checker from the geometry.
    // A square is valid if EITHER grid says true.
    // If both return undefined (no data), assume valid.
    // If either explicitly says false, it's invalid.
    const geo = this.session?.world?.geometry;
    const isWalkable = (r, col) => {
      const f = geo?.fineWalkable ? geo.fineWalkable(r, col) : undefined;
      const s = geo?.standable ? geo.standable(r, col) : undefined;
      // Explicitly blocked by either grid: invalid.
      if (f === false || s === false) return false;
      // No data at all: assume valid.
      if (f === undefined && s === undefined) return true;
      // At least one grid says true: valid.
      return f === true || s === true;
    };

    // Find the target in the room. PREFER the world-state target
    // (ws._targetId): the ceiling was checked against it, so the
    // swing must land on it. Only fall back to scanning the room
    // when the world state has no target (e.g. the controller was
    // created before the first evaluate).
    const objects = frame?.objects ?? c.room?.objects;
    let target = null;
    const wsTargetId = ws?._targetId;
    if (wsTargetId != null && objects) {
      target = objects instanceof Map ? objects.get(wsTargetId) : null;
      // NEVER SWING AT YOURSELF.
      //
      // The world state filters its own candidates on `o.is_self`, but that is computed as
      // `o.id === c.selfId` by whoever enriched the object, and this branch takes the world
      // state's id on trust without re-checking. Watched live: Lee logged 117 swings at "Lee"
      // in one window and 76 in another, which also pinned him in place — `has_target` stayed
      // true, `_fight` outranks `hunt`, and a character fighting himself never travels. That
      // is why he sat in The Sweet Grass Prairies with a hunt room assigned.
      //
      // Checked here by id AND by name, because the two failure modes are different: a
      // selfId that never resolved makes every is_self false, and a stale one makes the
      // wrong object self. Our own name is the one thing we always know.
      if (target && this._isSelf(target, c)) {
        target = null;
        if (!this._warnedSelf) {
          this._warnedSelf = true;
          console.error(`[combat] ${this.session?.name ?? '?'} refused to target ITSELF`
            + ` (ws id ${wsTargetId}, selfId ${c?.selfId}) — dropping it`);
        }
      }
      if (target) {
        // A QUARRY THAT DIES IN A CROWDED ROOM IS REPLACED, NOT REPORTED.
        //
        // The kill recorder below fires when the target vanishes and nothing takes its place.
        // With six giant rats in the room the world state hands over a fresh one on the very
        // next tick, so targetId was overwritten and the death went unrecorded: JayB's max
        // health rose 25 -> 26 — an advancement roll, which only happens on a KILL — with
        // zero rows in the ledger.
        //
        // So before adopting a new quarry, check whether the OLD one is still in the room.
        // Gone while we were engaged with it is the same evidence the survive keeper uses
        // (m59-skills.mjs:2019).
        if (this.targetId != null && this.targetId !== target.id) {
          const old = objects instanceof Map ? objects.get(this.targetId) : null;
          if (!old) this._recordKill(this.targetName, this.targetId, this.swings || null, frame);
        }
        if (this.targetId !== target.id) this.swings = 0;   // a new quarry, a new count
        this.targetId = target.id;
        this.targetName = target.name ?? c.rsc?.get?.(target.nameRsc) ?? 'mob';
      }
    }
    if (!target && this.targetId != null && objects) {
      target = objects instanceof Map ? objects.get(this.targetId) : null;
    }
    // If the target left (died or fled), loot the floor before clearing.
    // The corpse's drops (gold, reagents, equipment) are on the ground where
    // it fell. lootFloor is async and multi-second, so we signal the decider
    // to kick it off fire-and-forget rather than blocking the tick.
    if (this.targetId != null && !target) {
      const hadTarget = this.targetId;
      const hadName = this.targetName;
      const rounds = this.swings || null;
      this.targetId = null;
      this.targetName = null;
      this.phase = 'idle';
      this._recordKill(hadName, hadTarget, rounds, frame);
      return { kind: 'loot', what: `target ${hadName ?? hadTarget} left — looting`, lootId: hadTarget };
    }
    if (!target) {
      // No target from world state or memory: only scan the room
      // for a hostile when the world state says there is one.
      // This prevents swinging at items or exits.
      if ((ws == null || ws?.has_target === true) && objects instanceof Map) {
        // THIS SCAN TAKES THE FIRST OBJECT IN THE ROOM, AND `objects` IS RAW.
        //
        // `is_self` is added by whoever ENRICHES an object (broker/keeper-process, as
        // `o.id === c.selfId`); the map read here is `frame?.objects ?? c.room?.objects`,
        // which carries no such flag. So `if (o.is_self) continue` never fired, the
        // character's own object happened to be first, and Lee swung at himself 75-117 times
        // a window. That also pinned him: has_target stayed true, _fight outranks hunt, and a
        // character fighting himself never travels — which is the whole reason he sat in The
        // Sweet Grass Prairies with a hunt room assigned.
        // AND IT MUST BE A CREATURE, NOT MERELY "NOT US".
        //
        // Guarding on o.is_player has the same defect as o.is_self did: the flag is added by
        // an enricher and these objects are raw, so it never fired either. With the self-guard
        // in and nothing else, the scan simply moved on to the next body in the room — and
        // that was Gountrug, another character in this fleet. Swinging at our own people is a
        // worse failure than swinging at ourselves.
        //
        // So the test is positive rather than negative: the name has to be a creature the
        // compendium knows. Anything we cannot identify as a mob is left alone, which is the
        // right default for a swing.
        const creatures = this._creatureNames();
        for (const o of objects.values()) {
          if (o.is_player || this._isSelf(o, c)) continue;
          if (o.col == null || o.row == null) continue;
          const nm = String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
          // No compendium is a reason to swing at NOTHING, not at anything. The previous
          // shape (`creatures.size && ...`) would have quietly restored the behaviour that
          // put Lee's mace into a fleet-mate.
          if (!nm || !creatures.has(creatureKey(nm))) continue;
          target = o;
          this.targetId = o.id;
          this.targetName = nm || 'mob';
          break;
        }
      }
      if (!target) {
        this.phase = 'idle';
        return { kind: 'idle', what: 'no target in room' };
      }
    }

    const tCol = target.col;
    const tRow = target.row;
    // Manhattan distance (NSEW tile steps), not Euclidean. The server's
    // attack range is squared Euclidean on square coords, but for the
    // reach CHECK we want "how many tile steps to get there" — that's
    // what the mover actually costs. With MELEE_REACH=2, a target 2
    // tiles NSEW is in range; a target at (2,2) diagonal is 4 steps
    // and out of range (the character must walk there first).
    const dist = Math.abs(tCol - me.col) + Math.abs(tRow - me.row);
    const isAggroed = !!(target.flags & 0x02000000); // OF.ENEMY
    // HP as a fraction (0-100). Drives the retreat decision.
    const hpPct = frame?.vitals?.health?.pct ?? 100;
    const hpLow = hpPct <= RETREAT_HP_PCT;
    // Attack mode: casters (no weapon, has attack spell) use a bolt at
    // CAST_REACH; everyone else uses a melee swing at MELEE_REACH.
    const reach = this._attackSpell() ? CAST_REACH
                : (this._armed(c) ? MELEE_REACH : PUNCH_REACH);
    const tGeo = frame?.geometry ?? this.session?.world?.geometry;

    // When the target's square is fine-unwalkable (mummy on a ledge, in a
    // wall edge, on a step), the A* can never path to that exact square.
    // Find the nearest walkable neighbor of the target and use THAT as the
    // movement destination. The character then swings from within reach of
    // the mummy's actual position.
    let moveTarget = { col: target.col, row: target.row };
    if (tGeo?.fineWalkable && tGeo.fineWalkable(target.row, target.col) === false) {
      let best = null, bestD = Infinity;
      for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const nr = target.row + dr, nc = target.col + dc;
        if (tGeo.fineWalkable(nr, nc) !== true) continue;
        const d = Math.abs(nc - target.col) + Math.abs(nr - target.row);
        if (d < bestD) { bestD = d; best = { col: nc, row: nr }; }
      }
      if (best) moveTarget = best;
    }

    // PATH DISTANCE: the true cost of reaching the mummy, in tile steps.
    // Manhattan distance is a lower bound that ignores walls and corridors.
    // The A* path length is the actual number of steps the mover must take.
    // If the path is longer than MELEE_REACH, the mummy is NOT in reach —
    // the character must follow the path, not swing at air.
    //
    // CACHED for 2s: the A* with PLAYER_RADIUS traces is expensive on a
    // cold edge memo (first call in a new room can take 1-2s per call,
    // blocking the event loop and causing swing gaps). The path distance
    // only changes when the character or target moves a full tile, which
    // is at most once per second at walking speed. A 2s cache is safe:
    // worst case, the character swings one extra time at a target that
    // just moved out of range, or walks one extra tick when it should
    // swing. Both are harmless compared to a 3s swing gap from event-loop
    // starvation.
    let pathDist = Math.abs(target.col - me.col) + Math.abs(target.row - me.row);
    if (tGeo?.finePathProtocol) {
      const now = Date.now();
      const cacheValid = this._cachedPathAt &&
        this._cachedPathAt.c === me.col && this._cachedPathAt.r === me.row &&
        this._cachedPathAt.tc === target.col && this._cachedPathAt.tr === target.row &&
        (now - (this._lastPathDistAt ?? 0) < 2000);
      if (!cacheValid) {
        this._lastPathDistAt = now;
        const F = 64, H = 32;
        try {
          const p = tGeo.finePathProtocol(
            me.col * F + H, me.row * F + H,
            moveTarget.col * F + H, moveTarget.row * F + H,
            { maxNodes: 4000 }
          );
          if (p.found) {
            // WAYPOINTS ARE TURN POINTS, NOT SQUARES.
            //
            // This used p.waypoints.length as a distance. A straight walk has ONE waypoint
            // however far it runs, so a target nine squares away in a clear line measured as
            // 1 — inside MELEE_REACH — and the character stood still swinging at it for ever
            // instead of closing. Watched on JayB at (14,23) against a baby spider at (15,14):
            // dist 9.1, reach reporting waypoints:1, expanded:0, and nothing but
            // `_fight -> swing` in the log.
            //
            // Measure the path's LENGTH instead: sum the segments and convert protocol units
            // back to squares. Never shorter than the straight line, which is the property the
            // reach test actually needs.
            let len = 0;
            let px = me.col * F + H, py = me.row * F + H;
            for (const w of p.waypoints) {
              const wx = w.x ?? w.col, wy = w.y ?? w.row;
              if (!Number.isFinite(wx) || !Number.isFinite(wy)) continue;
              len += Math.hypot(wx - px, wy - py);
              px = wx; py = wy;
            }
            const inSquares = len / F;
            // A degenerate path (no usable waypoints) must not read as "already here".
            this._cachedPathDist = inSquares > 0
              ? Math.max(inSquares, Math.hypot(target.col - me.col, target.row - me.row))
              : Math.abs(target.col - me.col) + Math.abs(target.row - me.row);
          } else {
            this._cachedPathDist = 999; // no path: separate island or walled off
            if (this.session && this.targetId != null) {
              this.session._moverNoRoute = { targetId: this.targetId, at: now };
            }
          }
          this._cachedPathAt = { c: me.col, r: me.row, tc: target.col, tr: target.row };
        } catch { /* keep Manhattan fallback */ }
      }
      pathDist = this._cachedPathDist ?? pathDist;
    }

    // State machine. MOB-FIRST: engage the mob directly. Only take cover
    // (retreat to a safe spot) when HP is low. The old safe-spot-first
    // design committed to a spot before checking the mob was engageable,
    // which trapped the character holding a spot it couldn't get to.
    switch (this.phase) {
      case 'idle':
      case 'close': {
        // Walk toward the mob. In reach -> fight. HP low -> retreat first.
        if (hpLow) {
          this.phase = 'retreat';
          this._retreatStart = Date.now();
          return { kind: 'idle', what: `hp low (${hpPct}%), backing off`, }; }
        if (pathDist <= reach) {
          this.phase = 'fight';
          return this._doFight(frame, act, target, dist, isAggroed, pathDist);
        }
        // Keep walking toward the mob. Target the mob's OWN square (not a one-square step
        // from me) so the mover plans a real path and the lazy-reporting gate isn't reset
        // every tick by a fresh one-square re-target. The dist <= reach check above
        // switches to fighting when we get close enough.
        this.phase = 'close';
        return this._walkToward(act, moveTarget, 'close gap', me);
      }

      case 'fight': {
        // In reach: swing. After each swing, re-check HP — if it just
        // dropped low, back off to a safe spot.
        if (hpLow) {
          this.phase = 'retreat';
          this._retreatStart = Date.now();
          return { kind: 'idle', what: `hp low (${hpPct}%), backing off` };
        }
        // Re-check distance: if the target moved out of reach (or the
        // character's position was stale when we entered fight), go back
        // to closing the gap instead of swinging at air.
        if (pathDist > reach) {
          this.phase = 'close';
          return this._walkToward(act, moveTarget, 'out of reach, closing', me);
        }
        return this._doFight(frame, act, target, dist, isAggroed, pathDist);
      }

      case 'retreat': {
        // Back away from the mob to a safe spot (or just create distance)
        // so HP can recover / we're not in melee. Then re-engage.
        if (!hpLow) {
          // HP recovered (regen) — re-engage the mob.
          this.phase = 'close';
          return { kind: 'idle', what: 'hp recovered, re-engaging' };
        }
        // Timeout: don't retreat forever (60s max, in case HP regen is slow).
        if (this._retreatStart && Date.now() - this._retreatStart > 60000) {
          this.phase = 'close';
          return { kind: 'idle', what: 'retreat timeout, re-engaging' };
        }
        // Find a safe spot AWAAY from the mob (on our side of the room).
        // If found, walk to it. If not, just back away from the mob.
        const roomKey = frame?.room?.name ?? frame?.room?.num ?? 'unknown';
        // Search near the CHARACTER (not the mob) for cover behind us.
        const spot = findSafeSpot(me.col, me.row, 10, isWalkable, geo, me.col, me.row, roomKey);
        if (spot && (spot.col !== me.col || spot.row !== me.row)) {
          if (!this._retreatSpot || this._retreatSpot.col !== spot.col || this._retreatSpot.row !== spot.row) {
            this._retreatSpot = { col: spot.col, row: spot.row };
          }
          const atSpot = me.col === spot.col && me.row === spot.row;
          if (atSpot) {
            // At cover. Wait for HP to recover, keeping an eye on the mob.
            if (dist <= reach) {
              // Mob got back in range — attack once then keep distance.
              const now = Date.now();
              if (now - this.lastSwing >= SWING_MS) {
                this.lastSwing = now; this.swings++;
                const deg = Math.atan2(tRow - me.row, tCol - me.col) * 180 / Math.PI;
                act.face(deg);
                const spell = this._attackSpell();
                if (spell) {
                  this.session?.cast?.(spell.id, []);
                  return { kind: 'cast', what: `retreat: cast ${spell.name} at closing mob (${hpPct}%)` };
                }
                act.swing(this.targetId);
                return { kind: 'swing', what: `retreat: swing at closing mob (${hpPct}%)` };
              }
              return { kind: 'idle', what: `retreat: attack cooldown (${hpPct}%)` };
            }
            return { kind: 'idle', what: `retreat: at cover (${hpPct}%), mob ${dist.toFixed(1)} away` };
          }
          return this._walkTo(act, this._retreatSpot, `retreat to cover (${spot.col},${spot.row})`, me);
        }
        // No safe spot: back away from the mob (one square opposite).
        const awayCol = me.col + Math.sign(me.col - tCol) || me.col;
        const awayRow = me.row + Math.sign(me.row - tRow) || me.row;
        return this._walkTo(act, { col: awayCol, row: awayRow }, 'retreat: back away', me);
      }

      default:
        this.phase = 'idle';
        return { kind: 'idle', why: `unknown phase ${this.phase}` };
    }
  }

  /**
   * Fight from the current position. One attack per SWING_MS.
   *
   * Attack priority:
   *   1. ZAP enchantment: if the character has the zap spell, blue mushrooms,
   *      and the enchantment is down, cast it (unequipping the weapon first).
   *      While the enchantment is active, melee attacks are electric and do
   *      much more damage. The server's ON/OFF messages drive the state.
   *   2. Melee swing: the default for an armed character.
   */
  _doFight(frame, act, target, dist, isAggroed, pathDist) {
    const me = frame?.position ?? this.session?.client?.self;
    const client = this.session?.client;
    const reach = this._attackSpell() ? CAST_REACH
                : (this._armed(client) ? MELEE_REACH : PUNCH_REACH);
    // Use pathDist (A* tile count) if available, else fall back to Manhattan.
    const effDist = pathDist ?? dist;
    if (effDist > reach) {
      // Out of reach (by path distance). Walk toward it.
      if (!isAggroed) {
        this.phase = 'close';
        return this._walkToward(act, { col: target.col, row: target.row }, 'close gap', me);
      }
      return { kind: 'idle', what: `waiting for ${this.targetName} to close (path ${effDist})` };
    }
    // In reach (by path distance): attack. The cooldown paces BOTH the
    // zap-cast decision and the swing, so we don't spam the enchantment
    // or the weapon.
    const now = Date.now();
    if (now - this.lastSwing >= SWING_MS) {
      this.lastSwing = now; this.swings++;   // the round the ledger records as `rounds`
      // 1. Zap enchantment: cast it if it's down and we can afford it.
      const zap = this._maybeCastZap(client);
      if (zap) return zap;
      // 2. Caster bolt (no weapon, has a ranged attack spell).
      const attackSpell = this._attackSpell();
      if (attackSpell) {
        if (me) {
          const deg = Math.atan2(target.row - me.row, target.col - me.col) * 180 / Math.PI;
          act.face?.(deg);
        }
        this.session?.cast?.(attackSpell.id, []);
        return { kind: 'cast', what: `cast ${attackSpell.name} at ${this.targetName}` };
      }
      // 3. Melee swing (this is a zap-touched swing if the enchantment is active).
      // Best-effort face: send the turn toward the target, but DO NOT block the
      // swing on the angle. A mobile combatant is always repositioning, so the
      // angle to the target changes every tick; a hard "must be within 45°" gate
      // meant the character spent every tick turning and almost never swung
      // (measured 0.067/s, 1 swing per 15s). The server hits the nearest mob in
      // the facing arc and is lenient about exact angle, so swinging while
      // turning is far better than not swinging at all. The face command is
      // coalesced in the client (it won't spam identical turns).
      if (me) {
        const deg = Math.atan2(target.row - me.row, target.col - me.col) * 180 / Math.PI;
        act.face(((deg % 360) + 360) % 360);
      }
      act.swing(this.targetId);
      if (process.env.M59_DEBUG_SWING) {
        const sinceLast = Date.now() - (this._lastSwingLogAt ?? 0);
        this._lastSwingLogAt = Date.now();
        console.error(`[swing-debug] t3 swing at ${Date.now()} sinceLast=${sinceLast}ms lastSwing=${this.lastSwing} now=${Date.now()} gap=${Date.now()-this.lastSwing}ms`);
      }
      const zapActive = zapStatus(client).active;
      return { kind: 'swing', what: `swing at ${this.targetName}${zapActive ? ' (zap active)' : ''}` };
    }
    // In reach but on cooldown. Check if the zap enchantment just lapsed and
    // the weapon needs re-equipping.
    const reequip = this._maybeReequip(this.session?.client);
    if (reequip) return reequip;
    return { kind: 'idle', what: 'attack cooldown' };
  }

  /**
   * If the zap enchantment just lapsed (active -> down) and the weapon was
   * unequipped for the cast, re-equip it so the character isn't fighting
   * bare-handed. Called on each attack cooldown. Returns a decision if it
   * re-equipped, else null.
   */
  _maybeReequip(client) {
    if (!client) return null;
    // Only re-equip if the enchantment is DOWN (it lapsed) and a weapon is in
    // the pack but not equipped. We track the weapon we unequipped.
    if (zapStatus(client).active) return null;
    const inPack = (client.inventory ?? []).find(o => {
      const n = client.rsc?.get?.(o.nameRsc) ?? o.name ?? '';
      return /mace|sword|axe|club|hammer|dagger|staff|spear/i.test(n);
    });
    if (!inPack) return null;
    const equipped = equippedWeapon(client);
    if (equipped) return null; // already has a weapon out
    // Re-equip the weapon from the pack.
    client.use?.(inPack.id);
    console.error(`[combat] ${this.session?.name} re-equipped ${client.rsc?.get?.(inPack.nameRsc) ?? inPack.name} after zap lapse`);
    return { kind: 'reequip', what: 're-equipped weapon after zap lapse' };
  }

  /**
   * Cast the zap enchantment if it should be active. Returns a decision result
   * ({kind:'zap-cast', ...}) if it cast, or null if nothing to do (enchantment
   * already active, no spell, no mushrooms). The cast is: unequip the weapon
   * (if any), then cast zap. The server's "Sparks jump and crackle" message
   * flips zapStatus().active, and "no longer charged" flips it back.
   */
  _maybeCastZap(client) {
    if (!client) return null;
    const { shouldCast, reason } = shouldCastZap(client);
    if (!shouldCast) return null;
    const spell = findZapSpell(client);
    if (!spell) return null;
    // Unequip the weapon first — the charge is on the hands.
    const weapon = equippedWeapon(client);
    if (weapon) {
      client.unuse?.(weapon.id);
    }
    client.cast?.(spell.id, []);
    // Log the cast for visibility. The ON message confirms it took.
    console.error(`[combat] ${this.session?.name} casting zap (${reason})`);
    return { kind: 'zap-cast', what: `cast zap (${reason})` };
  }

  /**
   * Find the character's ranged attack spell, if they are a caster (no
   * weapon, but have an attack spell). Returns {id, name} or null. The
   * preference is: zap (mage), then any spell whose name is an obvious
   * attack (fire, ice, zap, bolt, missile, etc.). Returns null if the
   * character has no weapon AND no attack spell (can't fight).
   */
  _attackSpell() {
    const client = this.session?.client;
    if (!client) return null;
    // Do NOT use skills.isArmed here — it defaults to `true` when the
    // equipment read is unknown ("a failed read must not idle the fleet"),
    // which makes a caster look like a melee fighter. Instead, directly
    // check: is there a weapon in the equipped list? If not, and there are
    // attack spells, the character is a caster.
    let hasWeapon = false;
    try {
      const eq = client.equipment?.();
      if (eq?.known !== false && Array.isArray(eq.equipped)) {
        hasWeapon = eq.equipped.some(o => {
          const n = (o.name ?? client.rsc?.get?.(o.nameRsc) ?? '').toLowerCase();
          return /sword|axe|club|mace|hammer|dagger|staff|spear|bow|claymore|scimitar/.test(n);
        });
      }
    } catch {}
    if (hasWeapon) return null;
    const spells = client.spells ?? [];
    if (!spells.length) return null;
    const norm = (s) => {
      const n = client.rsc?.get?.(s.nameRsc) ?? s.name ?? '';
      return String(n).toLowerCase();
    };
    // Zap is NOT a bolt — it is the persistent touch enchantment, handled by
    // _maybeCastZap (unequip + cast + track the ON/OFF messages). Do not
    // return it here as a ranged attack, or a bare-handed zap-caster would
    // "cast zap" as a bolt every swing instead of maintaining the enchantment.
    // Then any other obvious attack spell.
    const ATK = ['fire','ice','bolt','missile','flame','frost','shock','lightning','acid'];
    for (const s of spells) {
      const n = norm(s);
      if (n === 'zap') continue;  // enchantment, not a bolt
      if (ATK.some(a => n.includes(a))) return { id: s.id, name: n };
    }
    return null;
  }

  /**
   * Walk toward a point. Uses the session's mover if available
   * (has pathfinding + blink fallback), otherwise falls back to
   * raw act.step() (one square per tick, no pathfinding).
   */
  _walkTo(act, dest, what, me) {
    const mover = this.session?._mover;
    if (mover) {
      // Only set the destination if it changed (avoids
      // replanning the A* path every tick).
      if (!this._walkDest || this._walkDest.col !== dest.col || this._walkDest.row !== dest.row) {
        this._walkDest = { col: dest.col, row: dest.row };
        mover.to(dest.col, dest.row);
      }
      const r = mover.tick(me ? { col: me.col, row: me.row, x: me.x, y: me.y } : undefined);
      if (r.state === 'arrived') {
        this._walkDest = null;
        return { kind: 'walk', what: what + ' (arrived)' };
      }
      if (r.state === 'stuck' || r.state === 'no-route') {
        // NO-ROUTE: the mover definitively cannot reach the destination (the fine grid
        // has no walkable path). Record it on the session so the decider can BLACKLIST
        // this target and pick the next-closest reachable mob. Previously unreachable
        // targets were never blacklisted (the decider skips the reachability A* for
        // performance, and the stuck-detector was told not to blacklist), so the
        // character chased a walled-off mummy in a loop for minutes at a time.
        if (r.state === 'no-route' && this.session && this.targetId != null) {
          this.session._moverNoRoute = { targetId: this.targetId, at: Date.now() };
        }
        return { kind: 'idle', what: `${what}: ${r.state} — ${r.why ?? ''}` };
      }
      return { kind: 'walk', what };
    }
    // Fallback: raw one-square step.
    if (!me) me = this.session?.client?.self;
    if (!me) return { kind: 'idle', why: 'no position' };
    const dc = Math.sign(dest.col - me.col);
    const dr = Math.sign(dest.row - me.row);
    const nextCol = me.col + dc;
    const nextRow = me.row + dr;
    act.step(nextCol, nextRow);
    return { kind: 'walk', what };
  }

  /**
   * Walk toward a point (diagonal allowed). Same as _walkTo.
   */
  _walkToward(act, dest, what, me) {
    return this._walkTo(act, dest, what, me);
  }

  // Every creature name the compendium knows, cached for the life of the controller. The
  // spawns file is the same source m59-decide.mjs uses to tell a mob from a barrel.
  _creatureNames() { return preyNames(); }





  // Are we holding a weapon? The server's own use list, so it cannot disagree with the
  // character's actual hands — and it decides whether we reach two squares or one.
  _armed(c) {
    try {
      const eq = c?.equipment?.();
      if (!eq || eq.known === false) return true;   // unknown: assume armed, the safer error
      return (eq.equipped ?? []).some(o => WEAPONISH.test(String(o.name ?? '')));
    } catch { return true; }
  }

  // Is this object us? By id when we know it, and by name always — see the caller.
  _isSelf(o, c) {
    if (!o) return false;
    if (o.is_self) return true;
    const selfId = c?.selfId;
    if (selfId != null && o.id === selfId) return true;
    // `client.me.name` is not always populated — the survive keeper reads
    // `client?.me?.name ?? credentials?.character` for exactly this reason, and relying on the
    // first alone is why this guard did not fire on Lee at all.
    const mine = String(c?.me?.name ?? this.session?.credentials?.character
                        ?? this.session?.name ?? '').toLowerCase();
    if (!mine) return false;
    const theirs = String(o.name ?? c?.rsc?.get?.(o.nameRsc) ?? '').toLowerCase();
    return !!theirs && theirs === mine;
  }

  // THE TICK KEEPER'S KILLS, WRITTEN DOWN — AND THEY OVER-COUNT. MEASURED.
  //
  // 47% is the number: of 15 "the quarry left the room" events on JayB, only SEVEN left
  // anything on the floor (34 items over those seven). A corpse drops; a mob that wandered
  // off or despawned does not. So roughly half of what this records as a kill is not one,
  // and a kills/min read from it is an upper bound rather than a count. The survive keeper's
  // measure has the same property — see below — which is why they are still comparable.
  //
  // The honest fix is to wait for the loot result and only record when the floor had
  // something, but lootFloor is async and multi-second and this is a synchronous tick. Doing
  // it properly means recording the kill provisionally and confirming it from the loot
  // callback in m59-decide.mjs.
  //
  //
  // `recordEvent(name, 'killed', ...)` is the ONLY thing countKills() reads, and it was
  // called from m59-autopilot.mjs alone — so a tick-keeper character killed things and
  // m59-minimal.mjs reported 0.00 kills/min for it no matter what it did. Every question
  // about whether the real-time keeper earns anything was unanswerable for that reason.
  //
  // THE SIGNAL IS THE SAME ONE THE SURVIVE KEEPER USES, deliberately. m59-skills.mjs:2019
  // is `if (!c.room.objects.has(foe.id)) killed = true` — the quarry we were engaged with
  // left the room. It cannot tell a corpse from a mob that wandered off or despawned, and
  // it will over-count in a room where they do. That is a known property of the existing
  // measure, and matching it is the point: two keepers counting the same way can be
  // compared, and a truer count on one side only would make the comparison worse.
  //
  // Nothing here is allowed to throw. A record that breaks the play it is recording is
  // worse than no record.
  _recordKill(name, id, rounds, frame) {
    try {
      const c = this.session?.client;
      const who = c?.me?.name;
      if (!who) return;
      const room = frame?.room ?? c?.room ?? null;
      const detail = {
        creature: name ?? String(id),
        room: room?.name ?? null,
        room_num: room?.num ?? null,
        rounds: rounds ?? undefined,
        keeper: 'tick',
      };
      recordEvent(who, 'killed', { agent: this.session?.name ?? undefined, ...detail });
      // The feed as well as the ledger: recordKill is what attributes a max-health gain to
      // the creature that paid for it, and "you suddenly feel a little tougher" is the only
      // announcement of the only thing this fleet is for.
      tougher.recordKill(who, { creature: name ?? String(id), room: detail.room,
                                room_num: detail.room_num, rounds: rounds ?? null });
    } catch { /* never let the record break the play it is recording */ }
  }

  /**
   * Current state for logging/debugging.
   */
  status() {
    return {
      phase: this.phase,
      safeSpot: this.safeSpot,
      target: this.targetName,
      targetId: this.targetId,
    };
  }
}

// THE PREY LIST, IN ONE PLACE.
//
// m59-decide.mjs used to build its own copy from loadSpawns and therefore had its own bugs:
// it matched class names against display names (so "giant rat" never matched GiantRat) and it
// had no idea the compendium's monster list is full of shopkeepers. One set, one set of rules.
let _prey = null;
export function preyNames() {
  if (_prey) return _prey;
  _prey = new Set();
  try {
    const spawns = loadSpawns(SPAWNS_FILE);
    for (const name of Object.keys(spawns?.byMonster ?? {})) _prey.add(creatureKey(name));
    // AND THE COMPENDIUM'S "MONSTERS" INCLUDE EVERY SHOPKEEPER IN THE WORLD.
    //
    // byMonster lists spawnable CLASSES, not prey: BarloqueApothecary, JasperBanker,
    // CornothGrocer, Izzio — 34 of them are merchants, bankers, innkeepers and tailors. Keying
    // names properly (so "giant rat" finally matched GiantRat) therefore also made every
    // merchant a valid target, and JayB killed Izzio, one of the eight NPCs on the
    // trusted-buyer allowlist — the people we SELL to.
    //
    // The merchant index is subtracted. It is the same file the sell errand routes by, so the
    // two can never disagree about who is a shop.
    for (const m of merchantIndex()) {
      _prey.delete(creatureKey(m.cls ?? ''));
      _prey.delete(creatureKey(m.name ?? ''));
    }
  } catch { /* no compendium: an empty set refuses rather than guessing */ }
  return _prey;
}
