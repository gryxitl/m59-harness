#!/usr/bin/env node
// m59-act/flee.mjs -- THE FLEE ATOMIC.
// Run away from the nearest hostile. The character moves to the
// farthest point from the threat, or to a safe spot (wall) if one
// is available.
//
// This is a decision: "I should not be here." The planner uses it
// when the character is hurt and the fight is going badly.
//
// CONTRACT: (client, session) -> { sent, fled, reason }
//   - sent: true when a flee attempt was made
//   - fled: true when the character moved away from the threat
//   - reason: null on success, a description of what went wrong

import { evaluate } from '../m59-worldstate.mjs';
import { affordances, OF } from '../m59-parse.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {object} client  - the M59Client
 * @param {object} session - the broker session (has .walkTo, .s)
 */
export async function flee(client, session, _opts = {}) {
  if (!client || !session)
    return { sent: false, fled: false, reason: 'no client or session' };

  const c = client;
  const s = session.s ?? session;

  // Anything attackable that is not a player. Players are a PVP question and the
  // playbook's, not this one's.
  const hostiles = (c.room?.objects instanceof Map)
    ? [...c.room.objects.values()].filter(o => {
        if (o.id === c.selfId) return false;
        if (o.flags & OF.PLAYER) return false;
        return affordances(o.flags ?? 0).includes('attack');
      })
    : (Array.isArray(c.room?.objects) ? c.room.objects.filter(o => o.hostile) : []);

  if (!hostiles.length)
    return { sent: false, fled: false, reason: 'no hostiles in the room' };

  const me = c.self;
  if (!me) return { sent: false, fled: false, reason: 'own position unknown' };

  const { nearest, nearestDist } = hostiles.reduce((acc, h) => {
    const d = Math.hypot((h.col ?? 0) - me.col, (h.row ?? 0) - me.row);
    return d < acc.nearestDist ? { nearest: h, nearestDist: d } : acc;
  }, { nearest: null, nearestDist: Infinity });

  const room = c.room;
  const rows = room?.rows ?? 30, cols = room?.cols ?? 30;

  // ONE SQUARE, DIRECTLY AWAY FROM THE NEAREST THREAT.
  //
  // This used to walk 15 tiles and then, if that failed, loop eight moveToSquare calls
  // with a 400ms sleep between them -- three-plus seconds inside one call, with nothing
  // sampling health, WHILE BEING CHASED. That is the worst possible place to stop
  // looking, and it is why the sweep forbids a loop around an await.
  //
  // The direction is recomputed from scratch on every call, which is the point: the
  // thing chasing you MOVES, and a flee that committed to a vector eight steps ago is
  // running to where the threat used to be. One step, re-aimed each pass.
  const dx = me.col - nearest.col;
  const dy = me.row - nearest.row;
  const dist = Math.max(1, Math.hypot(dx, dy));
  const nx = Math.max(1, Math.min(cols - 2, Math.round(me.col + (dx / dist))));
  const ny = Math.max(1, Math.min(rows - 2, Math.round(me.row + (dy / dist))));

  if (nx === me.col && ny === me.row)
    return { sent: false, fled: false, reason: 'nowhere further from it inside this room',
             threat: { id: nearest.id, col: nearest.col, row: nearest.row,
                       dist: Math.round(nearestDist) } };

  // The collision-validated mover when the session has one, because a step the geometry
  // refuses is a step that does not move the character at all -- 92% of refused steps
  // measured upstream. moveToSquare is the fallback: the server does the real collision.
  const stepped = typeof s.walkTo === 'function'
    ? await s.walkTo(nx, ny, { maxSteps: 1 }).catch(() => ({ arrived: false, reason: 'walk refused' }))
    : await s.pacer?.submit?.('move', () => c.moveToSquare(nx, ny))
        .then(() => ({ arrived: true })).catch(() => ({ arrived: false, reason: 'move refused' }));

  const after = c.self;
  const moved = !!after && (after.col !== me.col || after.row !== me.row);

  return {
    sent: true,
    fled: moved,
    reason: moved ? null : (stepped?.reason ?? 'could not move'),
    from: { col: me.col, row: me.row },
    to: { col: after?.col ?? null, row: after?.row ?? null },
    threat: { id: nearest.id, col: nearest.col, row: nearest.row, dist: Math.round(nearestDist) },
  };
}

// GOAP metadata.
flee.pre     = ['has_target'];
// ONE STEP DOES NOT CLEAR A THREAT, so this no longer claims it does. `flee_danger` is
// the honest effect: distance was opened. `!has_target` and `healthy` were aspirational
// -- the planner believed one flee ended the encounter, and when it had not, the goal
// looked achieved while the character was still being chased. The planner re-evaluates
// from the real room every pass and will simply plan another step.
flee.effects = ['flee_danger', 'flee_room'];
flee.atomic  = 'flee';
