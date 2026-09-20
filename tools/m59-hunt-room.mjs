#!/usr/bin/env node
// m59-hunt-room.mjs -- FIND THE NEAREST ROOM WITH HUNTABLE MOBS.
//
// The GOAP keeper needs to know where to send a character that
// has no target in the current room. This module loads the spawn
// index and the map graph, finds rooms with huntable mobs at or
// below the character's level, and returns the nearest one by
// BFS path length.
//
// The result is a room number that the GOAP keeper can pass to
// the travel_to atomic, which uses the broker's travel() to walk
// the character there.

import { readFileSync, existsSync } from 'node:fs';
import { findPath, loadMap as _loadMap } from './m59-map.mjs';

let _spawns = null;
let _map = null;
let _objIdToNum = null;

function loadSpawns() {
  if (_spawns) return _spawns;
  const file = new URL('../substrate/m59-spawns.json', import.meta.url).pathname;
  if (!existsSync(file)) return null;
  _spawns = JSON.parse(readFileSync(file, 'utf8'));
  return _spawns;
}

function loadMap() {
  if (_map) return _map;
  try { _map = _loadMap(); } catch { _map = null; }
  return _map;
}

/**
 * Convert a client room object (which has .num = objId) to the
 * map's room number. The client's room.num is the objId, not the
 * map's num. The map's rooms are keyed by num.
 */
export function objIdToNum(objId) {
  if (!_objIdToNum) {
    const map = loadMap();
    _objIdToNum = new Map();
    if (map) {
      for (const [num, room] of Object.entries(map.rooms)) {
        if (room.objId != null) _objIdToNum.set(room.objId, parseInt(num));
      }
    }
  }
  return _objIdToNum.get(objId) ?? null;
}

/**
 * Find rooms with huntable mobs at or below the given level.
 *
 * @param {number} level - the character's level
 * @param {number} [ceiling] - optional threat ceiling (level + band).
 *   When provided, mobs up to this level are included, not just
 *   those at or below the character's level. This lets a level-20
 *   armed character (ceiling 30) hunt level-25 baby spiders.
 * @returns {Array<{room: number, creature: string, level: number}>}
 */
// Rooms that contain spiders which are too dangerous for low-level characters.
// The hunt room search will skip these rooms. Baby spiders (lv25) are fine;
// regular spiders (lv50) and above will one-shot a level-20 character.
const DANGEROUS_SPIDER_ROOMS = new Set([
  35,   // spider lv50 + queen spider lv165
  536, 537, 556, 564, 584, 587, 596, 597,  // spider lv50
  578, 579, 589, 598, 826,  // black spider lv75
  4, 6, 26, 27, 28,  // spider lv50 (underworld/early rooms)
  // Sewer rooms: giant rats (lv30) co-spawn with lupoggs (lv105)
  377, 378, 379, 108, 111, 112, 380,
  // Sweet Grass Prairies: groundworm larvae (lv35, karma-aggr) + navigation
  // issues — characters get stuck and die. Temporarily excluded.
  557, 556, 555,
]);

export function huntRoomsAtOrBelow(level, ceiling, minLevel) {
  const spawns = loadSpawns();
  if (!spawns) return [];
  const maxLevel = ceiling ?? level;
  const min = minLevel ?? level + 5;
  const out = [];
  for (const [num, entries] of Object.entries(spawns.rooms ?? {})) {
    const roomNum = parseInt(num);
    if (DANGEROUS_SPIDER_ROOMS.has(roomNum)) continue;
    // Collect all qualifying entries. Prefer prey STRICTLY ABOVE the character's
    // level (AdvancementCheck rolls only when victim level > own level, so prey
    // at or below pays nothing). Among above-level prey, pick the highest (most
    // XP). If no above-level prey exists, fall back to closest-to-own-level.
    let best = null;
    let bestAbove = null;
    for (const e of entries) {
      if (e.huntable && e.level != null && e.level <= maxLevel && e.level >= min) {
        if (e.level > level) {
          if (!bestAbove || e.level > bestAbove.level) bestAbove = e;
        } else if (!best || Math.abs(e.level - level) < Math.abs(best.level - level)) {
          best = e;
        }
      }
    }
    const chosen = bestAbove ?? best;
    if (chosen) out.push({ room: roomNum, creature: chosen.creature, level: chosen.level });
  }
  return out;
}

/**
 * Find the nearest hunt room from a given room.
 *
 * @param {number} fromRoom - the character's current room number
 * @param {number} level - the character's level
 * @returns {{room: number, creature: string, level: number, hops: number, path: number[]}|null}
 */
export function nearestHuntRoom(fromRoom, level, ceiling, minLevel, excludeRoom = null, avoidRooms = null) {
  // Convert objId to map num if needed.
  const mapNum = objIdToNum(fromRoom) ?? fromRoom;
  let candidates = huntRoomsAtOrBelow(level, ceiling, minLevel);
  if (!candidates.length) {
    // Fallback: if no in-band room, go to the nearest room with any mob
    // WITHIN THE CEILING. Standing still forever is worse than fighting an
    // out-of-band mob, but marching at a lv75 skeleton 13 hops away is a
    // death spiral (each death drops max HP by 1, and max health IS the
    // level). Widen minLevel downward, keep the ceiling.
    candidates = huntRoomsAtOrBelow(level, ceiling, 1);
  }
  if (!candidates.length) return null;

  // Filter out avoidRooms BEFORE the slice. The toCheck slice is the first
  // 3-5 candidates from an Object.entries-ordered list; excluding inside the
  // loop strands qualifying rooms outside the top slice. If the filter
  // empties the list, return null (stay put) BEFORE the minLevel=1 fallback
  // which would aim a low-level character at over-ceiling mobs.
  if (avoidRooms && avoidRooms.length > 0) {
    const _avoid = new Set(avoidRooms);
    candidates = candidates.filter(c => !_avoid.has(c.room));
    if (!candidates.length) return null;
  }

  const map = loadMap();
  if (!map) return null;

  let best = null;
  // Check at most 3 candidates to keep the tick loop unblocked. The
  // findPath function takes ~5s on a cache miss; checking all 11
  // candidates would block the tick loop for 55s.
  const toCheck = candidates.slice(0, excludeRoom != null ? 5 : 3);
  for (const c of toCheck) {
    if (excludeRoom != null && c.room === excludeRoom) continue;
    if (c.room === mapNum) {
      // Already there.
      return { ...c, hops: 0, path: [] };
    }
    const r = findPath(map, mapNum, c.room, { danger: false });
    if (!r.found) continue;
    const hops = r.hops.length;
    if (!best || hops < best.hops) {
      best = { ...c, hops, path: r.hops.map(h => h.to) };
    }
  }
  return best;
}

