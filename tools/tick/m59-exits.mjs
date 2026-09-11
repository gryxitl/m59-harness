#!/usr/bin/env node
// m59-exits.mjs -- tick-owned EDGE exits, computed live.
//
// The router needs to know which boundary squares leave the room and where
// they go. That used to come only from session.world.exits() (the shared
// World, owned by the legacy keeper): when its live derivation drops an edge
// — watched live with 382's north door to 557 — travel reports "no usable
// exit" and the character stands still next to a working door.
//
// This module answers the same question from sources the tick already owns:
//   1. map topology (room graph edges: leave/to — stable facts, not bake),
//   2. baked approach squares (a hint, never truth),
//   3. witnessed crossings (operator book + the fleet's learned book —
//      squares somebody actually crossed at, ranked first),
//   4. live geometry verification (BSP floor; a square with no floor is not
//      an exit, everything else is kept).
//
// Bake proposes, live disposes: a baked square with no BSP floor is dropped,
// but nothing else is filtered — reachability from the character's current
// square is the ROUTER's job (sub-legs, fan, blink), not the exit list's.
// An exit list that refuses to offer a door strands the character; an exit
// list that offers a hard door costs a walk.
//
// EDGE exits (walk-past-boundary crossings) and DOOR (go) exits. `world.exits()`
// computes only edges, so a door-only room (106 Brownestone Inn: `edgeExits: []`,
// one `go` door) yields nothing from it; `tickGoExits` answers the door half from
// the map's `goExits`. The router merges both lists.

import { observedCrossings } from '../m59-crossings.mjs';

const DIRS = {
  north: { dc: 0, dr: -1 },
  south: { dc: 0, dr: 1 },
  east: { dc: 1, dr: 0 },
  west: { dc: -1, dr: 0 },
};

/**
 * Edge exits out of roomNum, live-verified.
 * Returns [{ kind:'edge', direction, to, stand_on:{col,row}, edge_target:{col,row},
 *            alternates:[{stand_on}], witnessed:bool }]
 * Squares are protocol/object coords (1-based), matching mover/router convention.
 */
export function tickEdgeExits({ map, roomNum, geo } = {}) {
  const out = [];
  try {
    const rooms = map?.rooms ?? {};
    const room = rooms[roomNum] ?? rooms[String(roomNum)];
    if (!room) return out;
    const edges = room.exits ?? room.edgeExits ?? [];
    for (const e of edges) {
      const to = Number(e.to);
      if (!Number.isFinite(to)) continue;
      const dir = String(e.leaveName ?? e.direction ?? '').toLowerCase();
      const step = DIRS[dir];
      if (!step) continue;
      // Candidates: baked approach squares first (document order), then
      // witnessed crossings (ranked below by count).
      const cands = [];
      const seenSq = new Set();
      const appr = room?.roo?.edgeApproaches?.[dir] ?? [];
      for (const a of appr) {
        const sqs = a?.[4] ?? a?.squares ?? [];
        for (const s of sqs) {
          const c = s?.col ?? s?.[0], r = s?.row ?? s?.[1];
          if (!Number.isFinite(c) || !Number.isFinite(r)) continue;
          const k = c + ',' + r;
          if (seenSq.has(k)) continue;
          seenSq.add(k);
          cands.push({ col: c, row: r, baked: true, seen: 0 });
        }
      }
      let witnessed = [];
      try { witnessed = observedCrossings(Number(roomNum), to) ?? []; } catch { witnessed = []; }
      for (const w of witnessed) {
        if (!Number.isFinite(w?.col) || !Number.isFinite(w?.row)) continue;
        const k = w.col + ',' + w.row;
        if (seenSq.has(k)) {
          const prev = cands.find(q => q.col === w.col && q.row === w.row);
          if (prev) prev.seen = Math.max(prev.seen, w.seen ?? 1);
          continue;
        }
        seenSq.add(k);
        cands.push({ col: w.col, row: w.row, baked: false, seen: w.seen ?? 1 });
      }
      // Live verification: drop squares with provably no BSP floor. Nothing
      // else is filtered — reachability is the router's job downstream.
      const ok = [];
      for (const sq of cands) {
        let grounded = undefined;
        try {
          if (typeof geo?.standable === 'function') {
            const s = geo.standable(sq.row, sq.col);
            if (s === true) grounded = true;
            else if (s === false && geo?.collisionReady === true) grounded = false;
          }
        } catch { grounded = undefined; }
        if (grounded === false) continue;
        ok.push(sq);
      }
      if (!ok.length) continue;
      // Witnessed squares first (by count), then baked document order.
      ok.sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0));
      const [best, ...rest] = ok;
      const edge_target = { col: best.col + step.dc, row: best.row + step.dr };
      out.push({
        kind: 'edge',
        direction: dir,
        to,
        to_name: rooms[to]?.name ?? rooms[String(to)]?.name ?? `room ${to}`,
        stand_on: { col: best.col, row: best.row },
        edge_target,
        ...(rest.length ? { alternates: rest.slice(0, 7).map(s => ({ stand_on: { col: s.col, row: s.row } })) } : {}),
        ...(best.seen > 0 ? { witnessed: best.seen } : {}),
      });
    }
  } catch { /* an exit list must never throw: fall back to world.exits() */ }
  return out;
}


/**
 * Door (go) exits out of roomNum, straight from the map's `goExits`.
 *
 * `world.exits()` computes only EDGE exits, so a door-only room (106 Brownestone
 * Inn: `edgeExits: []`, one `go` door to 101) yields an empty list and the router
 * could plan a route INTO the room but never the leg OUT of it. This answers the
 * door half from the map: one entry per unlocked door, `stand_on` the square you
 * stand on to trigger it. Squares are 1-based, matching the edge convention.
 * Locked doors (`to: -1`, cupboards) are not routes and are skipped.
 */
export function tickGoExits({ map, roomNum } = {}) {
  const out = [];
  try {
    const rooms = map?.rooms ?? {};
    const room = rooms[roomNum] ?? rooms[String(roomNum)];
    if (!room) return out;
    for (const g of room.goExits ?? []) {
      if (g.locked) continue;
      const to = Number(g.to);
      if (!Number.isFinite(to) || to <= 0) continue;
      if (!Number.isInteger(g.row) || !Number.isInteger(g.col)) continue;
      out.push({
        kind: 'go',
        to,
        to_name: rooms[to]?.name ?? rooms[String(to)]?.name ?? `room ${to}`,
        stand_on: { col: g.col, row: g.row },
        arrive_row: g.arriveRow ?? null,
        arrive_col: g.arriveCol ?? null,
      });
    }
  } catch { /* an exit list must never throw: fall back to world.exits() */ }
  return out;
}
export default { tickEdgeExits, tickGoExits };
