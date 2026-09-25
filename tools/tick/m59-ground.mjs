#!/usr/bin/env node
// m59-ground.mjs -- "is there ground here?" for the tick brain.
//
// The server is client-authoritative: it accepts any declared position, so a
// character can end up on a square with no BSP floor (a void outside the
// environment). The server will not refuse the move, so the void must be
// detected locally — and once detected, never stepped into again.
//
// The predicate that detects a void is NOT fineWalkable. fineWalkable only
// asks whether a cell centre is within 256 fine units of an impassable wall
// segment, and answers true in open void. The void test is standable: whether
// any point in the square has occupiable BSP floor (a sector, finite floor and
// ceiling, tall enough for the 768-unit player). standPoint(...) == null is
// the same answer phrased as "no aim point".
//
// Stand_on exit squares are floorless BY DESIGN (the server handles the
// transition), so every caller takes an explicit exception for deliberate
// exits. This module never grants that exception itself — the caller, which
// knows whether the square is a deliberate exit, passes it in.

/**
 * Is there BSP ground on square (row, col)?
 * Returns true (ground), false (no ground), or undefined (no data — the
 * geometry has no collision payload, so the caller must fall back to its
 * previous behavior). Out-of-bounds squares are false.
 */
// BODY CHECK (configuration space). A square can be nominally walkable
// (fineWalkable true) yet narrower than a body: wall faces within one
// player radius of every point in the square. Routing through such cracks
// looks like wall-walking and wedges plan-vs-validate (planner says open,
// radius traces refuse). A zero-length trace reports embedded (blocked).
export function isEmbedded(geo, protoX, protoY) {
  if (!geo?.traceFineMoveClient) return undefined;
  try {
    const cx = protocolToClient(protoX), cy = protocolToClient(protoY);
    const tr = geo.traceFineMoveClient(cx, cy, cx, cy, { slide: false, playerRadius: 32 });
    if (tr?.blocked === true) return true;
    return false;
  } catch {
    return undefined;
  }
}
// TRANSIT BAN (square level). Walls, out-of-bounds, and point-less nooks
// are banned as aims/steps; thickets (standable-false WITH a stand point)
// PASS — the server walks them daily and detouring around 65% of a forest
// is the observed 556 slowness. When the geometry has no standPoint
// function the distinction is unavailable and this falls back to the legacy
// strictness (isGrounded), so old fixtures keep their behavior.
export function transitBanned(geo, row, col) {
  if (!geo) return undefined;
  try {
    if (geo.inBounds && geo.inBounds(row, col) === false) return true;
    if (geo.fineWalkable) {
      try { if (geo.fineWalkable(row, col) === false) return true; } catch {}
    }
    if (typeof geo.standPoint === 'function') {
      try { return geo.standPoint(row, col) == null; } catch {}
    }
    if (typeof geo.standable === 'function') {
      try { if (geo.standable(row, col) === false) return true; } catch {}
    }
    return false;
  } catch {
    return undefined;
  }
}
export function isGrounded(geo, row, col) {
  if (!geo) return undefined;
  try {
    if (geo.inBounds && geo.inBounds(row, col) === false) return false;
    if (typeof geo.standable !== 'function') return undefined;
    const s = geo.standable(row, col);
    if (s === true) return true;
    // An explicit false is only trustworthy with the full collision payload;
    // without it, a coarse-false square may still hold real BSP floor.
    if (s === false && geo.collisionReady === true) return false;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The nearest grounded square to (col, row), expanding Chebyshev rings.
 * Returns {col, row} or null when nothing grounded is found within maxRadius.
 * Candidates must be grounded AND not inside a wall (fineWalkable !== false).
 * Only used for void recovery (infrequent), so a wide radius is affordable.
 */
export function nearestGrounded(geo, col, row, { maxRadius = 40 } = {}) {
  if (!geo || !Number.isFinite(col) || !Number.isFinite(row)) return null;
  for (let r = 0; r <= maxRadius; r++) {
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== r) continue;
        const c = col + dc, rr = row + dr;
        if (isGrounded(geo, rr, c) !== true) continue;
        let f;
        try { f = geo.fineWalkable ? geo.fineWalkable(rr, c) : undefined; } catch { f = undefined; }
        if (f === false) continue; // grounded but inside a wall: not a target
        return { col: c, row: rr };
      }
    }
  }
  return null;
}

import { protocolToClient } from '../m59-roo.mjs';

/**
 * HEIGHT DISCIPLINE (clientd3d/move.c IntersectNode): the stock client refuses
 * climbs steeper than MAX_STEP_HEIGHT (24 kod units) at wall crossings, while
 * sliding along walls and pushing into door gaps stays legal. A full trace
 * conflates the two, so this runs the segment trace and honors ONLY the
 * height refusal — walls (doors, fences) still pass, cliffs don't. Descends
 * always pass (the client falls freely). Unknown geometry passes.
 * Returns true (ok), false (too steep), undefined (no data).
 */
export function segHeightOk(geo, fromProtoX, fromProtoY, toProtoX, toProtoY) {
  if (!geo?.traceFineMoveClient) return undefined;
  try {
    const tr = geo.traceFineMoveClient(
      protocolToClient(fromProtoX), protocolToClient(fromProtoY),
      protocolToClient(toProtoX), protocolToClient(toProtoY),
      { slide: false, playerRadius: 32 });
    if (!tr) return undefined;
    if (tr.blocked === true && tr.reason === 'step_too_high') return false;
    return true;
  } catch { return undefined; }
}

export default { isGrounded, nearestGrounded, segHeightOk };
