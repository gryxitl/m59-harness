#!/usr/bin/env node
// m59-act/scavenge.mjs -- THE SCAVENGE ATOMIC. Fight the weakest
// creature in the room to loot money or items.
//
// This is the "punch rats" fallback: when a character is unarmed,
// broke, and can't cast create weapon, the only way to get money
// is to fight something weak and loot what it drops.
//
// WHAT THE ATOMIC DOES:
//   1. Finds the weakest hostile in the room (lowest max HP).
//   2. Refuses if the target is above the character's level band
//      (fighting a level 50 fungus beast with bare fists is not
//      scavenging, it is suicide).
//   3. Delegates to the legacy fight() for the actual combat.
//   4. After the fight, picks up any dropped items.
//
// CONTRACT: (client, session) -> { sent, killed, reason }
//   - sent: true when the fight was started
//   - killed: true when the target died
//   - reason: null on success, a description of what went wrong

/**
 * @param {object} client  - the M59Client
 * @param {object} session - the broker session (has .fight, .step, etc.)
 */

// Health fraction: 0..1, or null if unreadable.
function frac(v) {
  const val = v?.value, max = v?.max;
  if (val == null || max == null || max === 0) return null;
  return val / max;
}

import { wanderAway } from '../m59-wander.mjs';
import { affordances, OF } from '../m59-parse.mjs';
import { readFileSync, existsSync } from 'node:fs';

// Compendium spawn data: room number -> [{creature, level, ...}].
// Used to filter targets by level when the wire protocol doesn't
// send mob HP/level data.
let _spawns = null;
function loadSpawns() {
  if (_spawns) return _spawns;
  const file = 'substrate/m59-spawns.json';
  if (!existsSync(file)) return null;
  try { _spawns = JSON.parse(readFileSync(file, 'utf8')); } catch { _spawns = null; }
  return _spawns;
}

// Find the compendium level for a mob name in a given room.
// Returns the level or null if not found.
function compendiumLevel(roomNum, mobName) {
  const spawns = loadSpawns();
  if (!spawns?.rooms) return null;
  const name = String(mobName).toLowerCase();
  // First try the specific room.
  const entries = spawns.rooms[String(roomNum)];
  if (entries) {
    const match = entries.find(e => e.creature?.toLowerCase() === name);
    if (match) return match.level;
  }
  // Fall back to a global search: the compendium may not list this
  // mob for this specific room. The level is the same regardless.
  for (const entries2 of Object.values(spawns.rooms)) {
    const match2 = entries2.find(e => e.creature?.toLowerCase() === name);
    if (match2) return match2.level;
  }
  return null;
}

export async function scavenge(client, session, opts = {}) {
  if (!client || !session)
    return { sent: false, killed: false, reason: 'no client or session' };

  const room = client?.room;
  if (!room) return { sent: false, killed: false, reason: 'no room' };

  // Threat ceiling: the GOAP keeper passes this so the scavenge uses the
  // same band definition as the planner (myLevel + threatBand). Without it,
  // fall back to myLevel * 2 (the old, looser check). This was the bug:
  // the GOAP said the rat was out of band (ceiling=20) but the scavenge's
  // own check (20*2=40) said it was fine, so the character walked toward
  // a mob it should have been running from.
  const myLevel = client?.vitals?.()?.health?.max ?? 20;
  const ceiling = opts.threatCeiling ?? myLevel * 2;

  // Find hostiles in the room.
  const objects = room.objects;
  const list = objects instanceof Map
    ? [...objects.values()]
    : Array.isArray(objects) ? objects : [];

  // HEALTH GATE: if we're below 50% HP, don't start a new fight.
  // The GOAP's hurt symbol uses 70% (restBelow), but there's a timing
  // gap where HP drops during a pass and the world state is stale.
  // This is the last line of defense: even if the GOAP says "go fight",
  // the scavenge itself refuses when the character is too hurt to
  // survive another engagement. The GOAP will re-evaluate on the
  // next pass with fresh vitals and switch to recover/flee.
  const hpNow = frac(client?.vitals?.()?.health);
  if (hpNow != null && hpNow < 0.5)
    return { sent: false, killed: false,
      reason: `HP too low to fight (${Math.round(hpNow * 100)}%) — need to recover first` };

  const hostiles = list.filter(o => {
    // Raw room objects have o.flags (bit flags), NOT o.can (action list).
    // The action list is derived from flags via affordances().
    if (o.id === client?.selfId) return false; // never target self
    if (o.flags & OF.PLAYER) return false; // players are handled by the PVP gate, not scavenge
    const can = affordances(o.flags ?? 0);
    if (!can.includes('attack')) return false;
    const name = client?.rsc?.get?.(o.nameRsc) ?? '';
    if (/friendly|pet|tame/i.test(name)) return false;
    return true;
  });

  // LEVEL FILTER: the wire protocol does not send mob HP/level data.
  // The compendium (m59-spawns.json) does: it maps room -> creature -> level.
  // Filter out mobs whose compendium level is above the character's
  // hunt level. This is the only way to know a spider is level 50
  // when Kage is level 20.
  const levelCeiling = opts.threatCeiling ?? null;
  const roomNum = opts.mapRoomNum ?? room?.num ?? room?.id ?? null;
  if (levelCeiling != null && roomNum != null) {
    const filtered = hostiles.filter(o => {
      const name = client?.rsc?.get?.(o.nameRsc) ?? '';
      const lv = compendiumLevel(roomNum, name);
      // If the compendium doesn't know this mob, REFUSE it.
      // An unknown mob could be a high-level spider that the
      // compendium doesn't list for this room. Safer to skip
      // unknowns than to walk into a spider (lv50) that
      // the lookup failed to identify.
      if (lv == null) return false;
      return lv <= levelCeiling;
    });
    if (filtered.length) {
      // Only keep mobs at or below the hunt level.
      const removed = hostiles.length - filtered.length;
      if (removed > 0)
        console.error(`[scavenge] level filter: removed ${removed} mob(s) above ceiling ${levelCeiling} in room ${roomNum}`);
      hostiles.splice(0, hostiles.length, ...filtered);
    } else if (hostiles.length > 0) {
      // ALL mobs in the room are above the ceiling. Don't fight.
      const names = hostiles.map(o => client?.rsc?.get?.(o.nameRsc) ?? '?').join(', ');
      return { sent: false, killed: false,
        reason: `all mobs in room are above ceiling ${levelCeiling} (${names}) — travel to a safer room` };
    }
  }

  if (!hostiles.length) {
    // No hostiles: walk a few steps toward where mobs are likely to be, then wait.
    // See wanderAway() — extracted so the atomic body has no loop around an await.
    wanderAway(client, session);
    return { sent: false, killed: false, reason: 'no hostiles in the room' };
  }

  // Pick the NEAREST reachable hostile. Sort by distance, then try
  // each one until the walk succeeds. The nearest mob might be behind
  // a door, on a different elevation, or across an impassable gap.
  const mePos = client?.self;
  const geo = session.world?.geometry;

  // ELEVATION CHECK: if the geometry has height data, filter out
  // targets whose floor height differs from ours by more than one
  // step (384 fine units). A mummy on a lower ledge is 3 cells away
  // on the 2D grid but unreachable — the pathfinder will waste 30+ 
  // steps trying to walk down a cliff.
  const myHeight = (mePos && geo?.floorHeightAtCell) 
    ? geo.floorHeightAtCell(mePos.row, mePos.col) : null;
  // Debug: log elevation check
  console.error(`[scavenge] ${session.name ?? '?'} elevation check: geo=${!!geo} floorHeightAtCell=${typeof geo?.floorHeightAtCell} mePos=(${mePos?.col},${mePos?.row}) myHeight=${myHeight}`);
  const reachable = hostiles.filter(t => {
    if (myHeight == null || !geo?.floorHeightAtCell) return true; // no height data, allow all
    const th = geo.floorHeightAtCell(t.row, t.col);
    if (th == null) return true; // target has no floor data, allow (might be same level)
    return Math.abs(myHeight - th) <= 384; // MAX_STEP_HEIGHT
  });
  if (reachable.length < hostiles.length && mePos) {
    console.error(`[scavenge] ${session.name ?? '?'} elevation filter: ${hostiles.length} hostiles, ${reachable.length} reachable (myHeight=${myHeight})`);
  }
  const sorted = reachable.sort((a, b) => {
    // Sort by compendium level (weakest first), then distance.
    // A baby spider (lv25) is always a better target than a giant rat (lv30),
    // even if the rat is closer. The level filter already removed mobs above
    // the ceiling, so all remaining mobs are "safe" — but weaker is safer.
    const lvA = compendiumLevel(roomNum, client?.rsc?.get?.(a.nameRsc) ?? a.name ?? '') ?? 999;
    const lvB = compendiumLevel(roomNum, client?.rsc?.get?.(b.nameRsc) ?? b.name ?? '') ?? 999;
    if (lvA !== lvB) return lvA - lvB;
    if (mePos) {
      const da = Math.hypot((a.col ?? 0) - mePos.col, (a.row ?? 0) - mePos.row);
      const db = Math.hypot((b.col ?? 0) - mePos.col, (b.row ?? 0) - mePos.row);
      if (Math.abs(da - db) > 3) return da - db;
    }
    return (a.max_health ?? a.health ?? 999) - (b.max_health ?? b.health ?? 999);
  });
  const hpFrac = frac(client?.vitals?.()?.health);
  const { fight: doFight } = await import('../m59-skills.mjs');

  // All targets filtered by elevation — the character is on a different
  // level than every hostile in the room. Wander to a random point in the
  // room to find a staircase or connection to the other floor level.
  if (sorted.length === 0 && hostiles.length > 0) {
    console.error(`[scavenge] ${session.name ?? '?'} all ${hostiles.length} hostiles unreachable by elevation (myHeight=${myHeight}), wandering to find a connection`);
    // Pick a random walkable point in the room and walk there. This is
    // how the character discovers staircases: by exploring, not by
    // refusing to move.
    // CHOOSE FIRST, THEN WALK ONCE. This tried five random points and walked up to 30
    // steps at EACH of them inside the loop -- one call, up to 150 steps, nothing
    // sampling health. Picking a square is pure arithmetic and costs nothing, so the
    // search happens with no await in it and exactly one walk follows.
    //
    // `session.need()` is also gone: an atomic is handed a CLIENT and re-deriving it
    // from the session is how this file came to depend on a Session method the fake
    // does not have, which crashed the conformance sweep before it could check the
    // rest of the file.
    const c = client;
    const geo = session.world?.geometry;
    const me = c.self;
    if (me && geo?.walkable) {
      const candidates = [];
      // Pure: no await anywhere in here.
      for (let attempt = 0; attempt < 12; attempt++) {
        const tc = me.col + Math.floor(Math.random() * 11) - 5;
        const tr = me.row + Math.floor(Math.random() * 11) - 5;
        if (!geo.walkable(tr, tc)) continue;
        const targetH = geo.floorHeightAtCell?.(tr, tc);
        const different = targetH != null && myHeight != null && Math.abs(targetH - myHeight) > 384;
        candidates.push({ tc, tr, targetH, different });
      }
      // A DIFFERENT FLOOR HEIGHT IS THE STAIRCASE CLUE, so those sort first; a
      // same-level square is still worth walking to, because standing still discovers
      // nothing at all.
      const pick = candidates.find(x => x.different) ?? candidates[0];
      if (pick) {
        console.error(`[scavenge] ${session.name ?? '?'} wandering to (${pick.tc},${pick.tr}) h=${pick.targetH} to find a level change`);
        // ONE STEP. maxSteps:8 was still eight seconds inside one call with nothing
        // sampling health -- better than the 150 it replaced, and still a batch. The
        // wander is re-aimed every pass anyway, so a step is the whole unit.
        const walk = await session.walkTo(pick.tc, pick.tr, { maxSteps: 1 })
                                  .catch(() => ({ arrived: false }));
        if (walk.arrived) {
          const newH = geo.floorHeightAtCell?.(c.self?.row, c.self?.col);
          if (newH != null && myHeight != null && Math.abs(newH - myHeight) > 384)
            return { sent: false, killed: false, reason: 'found a different level, re-evaluating targets', acted: true };
        }
        return { sent: true, killed: false, reason: 'wandered a step, looking for a way up' };
      }
    }
    return { sent: false, killed: false, reason: 'all hostiles on a different elevation' };
  }

  // SAFE-WALL FIGHT STRATEGY (ported from the legacy keeper's pull()).
  //
  // The legacy keeper's flow:
  //   1. takeSafeSpot() — find and walk to a wall/corner
  //   2. pull(quarry) — walk OUT to the mob, swing once, walk BACK
  //   3. Fight from the wall (hold position)
  //   4. observe() — stand still, verify the spot works (12s quiet = proven)
  //
  // The key insight: the safe spot is taken BEFORE engaging the mob.
  // The pull() method walks out, swings once to engage, and walks back.
  // The mob follows because it's now hostile. The fight happens at the
  // wall, not in the open.
  //
  // Mobs are NOT hostile until you swing at them. Once you do, they
  // chase you. The pull pattern exploits this: you choose where the
  // fight happens, not the mob.
  const { takeSafeSpot } = await import('./take-safe-spot.mjs');

  // Try up to 3 nearest hostiles. Stop at the first one we can kill.
  let lastResult = null;
    // ONE TARGET, ONE INTERACTION, AND THE LOOP IS GONE.
  //
  // This was `for (let i = 0; i < Math.min(3, sorted.length); i++)` wrapped around the
  // whole engagement -- approach, take a wall, pull, fight -- so ONE "atomic" call could
  // walk to three creatures in turn and fight each of them. Measured on this fleet that
  // is exactly where the long passes come from: worst 138.8s inside a single call, while
  // the fight path checks health once on entry and never again.
  //
  // Trying the next creature is the NEXT PASS's job -- the planner re-plans from the real
  // room every pass, which is the whole point of planning continuously. A labelled block
  // rather than a loop: with one candidate `continue` and `break` both mean "stop here",
  // so the body keeps its own control flow unchanged.
  ONE_TARGET: {
    const i = 0;
    const target = sorted[i];
    const targetName = client?.rsc?.get?.(target.nameRsc) ?? target.name ?? 'creature';
    const targetHp = target.max_health ?? target.health ?? '?';
    const targetCol = target.col ?? null;
    const targetRow = target.row ?? null;
    const foeId = target.id ?? target.obj_id ?? null;
    const nm = session.name ?? '?';

    // PVP GATE
    if (target.is_player === true) {
      const armed = client?.equipment?.()?.equipped?.length > 0;
      const healthy = hpFrac != null && hpFrac >= 0.7;
      const inBand = typeof targetHp === 'number' && targetHp <= myLevel * 1.5;
      if (!armed || !healthy || !inBand) break ONE_TARGET;
    }

    const dist = mePos && targetCol != null && targetRow != null
      ? Math.hypot(targetCol - mePos.col, targetRow - mePos.row) : null;
    console.error(`[scavenge] ${nm} targeting ${targetName} at (${targetCol},${targetRow}) dist=${dist ? dist.toFixed(1) : '?'}`);

    // PHASE 0: If the target is far and NOT aggroed, walk toward it
    // first. A non-aggroed mob won't come to us — we have to go to it.
    // The safe spot is taken AFTER closing the gap, so the character
    // ends up at a wall near the target, not a wall across the room.
    if (dist != null && dist > 8 && targetCol != null && targetRow != null) {
      const isAggroed0 = !!(target.flags & OF.ENEMY);
      if (!isAggroed0) {
        const approach0 = session.world?.approachSquare?.(targetCol, targetRow);
        if (approach0 && approach0.steps > 0) {
          console.error(`[scavenge] ${nm} ${targetName} not aggroed, ${dist.toFixed(1)} away — walking to close gap before safe spot (maxSteps=${Math.min(approach0.steps, 8)})`);
          const walk0 = await session.walkTo(approach0.col, approach0.row, { maxSteps: Math.min(approach0.steps, 8) }).catch(e => ({ arrived: false, reason: e.message }));
          console.error(`[scavenge] ${nm} walk result: arrived=${walk0?.arrived} reason=${walk0?.reason ?? 'n/a'}`);
          // Re-check position after the walk
          const meAfter = client.self;
          if (meAfter) {
            const newDist = targetCol != null && targetRow != null
              ? Math.hypot(targetCol - meAfter.col, targetRow - meAfter.row) : null;
            console.error(`[scavenge] ${nm} closed gap, now at (${meAfter.col},${meAfter.row}), dist=${newDist ? newDist.toFixed(1) : '?'}`);
            // Update targetCol/targetRow references for the safe-spot phase
            // (mePos is const, so we just log the new position)
          }
        }
      }
    }

    // PHASE 1: Take a safe spot (wall/corner) BEFORE engaging.
    // The legacy keeper does this first: the safe spot is the anchor,
    // and the fight happens at the wall, not where the mob spawned.
    let spotCol = null, spotRow = null;
    let atWall = false;
    if (!opts.noSafeSpot) {
      const spotResult = await takeSafeSpot(client, session, { maxSteps: 8 }).catch(() => null);
      if (spotResult?.at_wall && spotResult.spot) {
        spotCol = spotResult.spot.col;
        spotRow = spotResult.spot.row;
        atWall = true;
        console.error(`[scavenge] ${nm} at safe spot (${spotCol},${spotRow}), pulling ${targetName}`);
      } else if (spotResult?.at_wall) {
        // Already at a wall but no specific spot coordinates.
        // Still hold position — the character is at a wall, even if
        // we don't know which one.
        atWall = true;
        console.error(`[scavenge] ${nm} already at a wall, holding position`);
      } else {
        console.error(`[scavenge] ${nm} no safe spot found (${spotResult?.reason ?? 'unknown'}), fighting in the open`);
      }
    }

    // PHASE 2: If we have a safe spot, PULL the mob to it.
    // Walk out to the mob, swing once (engages it), walk back.
    // The mob follows because it's now hostile.
    //
    // BUDGET: the pull is only worth it for nearby mobs. Each walkTo step
    // costs 250ms (coarse) or 1s (fine grid), and the pull is two walks.
    // For a mob 20 steps away, that's 40+ seconds of walking — which blocks
    // the broker's event loop for the entire time. The GOAP re-plans every
    // second, so if the mob is far, we'll try again next pass when it's
    // closer (or we'll have walked toward it during travel).
    // Cap: only pull if the mob is within 12 steps.
    if (spotCol != null && targetCol != null && targetRow != null) {
      const c = client;
      const s = session;
      const approach = s.world?.approachSquare?.(targetCol, targetRow);
      if (approach && approach.steps > 0 && approach.steps <= 12) {
        const out = await s.walkTo(approach.col, approach.row, { maxSteps: approach.steps + 4 }).catch(() => ({ arrived: false }));
        if (out.arrived) {
          // Swing once to engage the mob
          const liveFoe = c.room?.objects?.get?.(foeId);
          if (liveFoe) {
            const deg = Math.atan2(liveFoe.row - c.self.row, liveFoe.col - c.self.col) * 180 / Math.PI;
            await s.pacer.submit('move', () => c.face(deg), 200).catch(() => {});
            await s.pacer.submit('attack', () => c.attack(foeId), 1050).catch(() => {});
            console.error(`[scavenge] ${nm} swung at ${targetName} to engage`);
          }
          // Walk back to the safe spot
          const back = await s.walkTo(spotCol, spotRow, { maxSteps: approach.steps + 4 }).catch(() => ({ arrived: false }));
          if (back.arrived) {
            console.error(`[scavenge] ${nm} back at safe spot (${spotCol},${spotRow}), ${targetName} following`);
          } else {
            console.error(`[scavenge] ${nm} could not get back to safe spot: ${back.reason}`);
          }
        } else {
          console.error(`[scavenge] ${nm} could not reach ${targetName} to pull: ${out.reason}`);
        }
      } else if (approach && approach.steps > 12) {
        console.error(`[scavenge] ${nm} mob ${approach.steps} steps away — too far to pull, fighting in place`);
      }
    }

    // PHASE 3: Fight from the safe spot (or in the open if no spot).
    // holdPosition: true when at a safe spot — don't walk away.
    // If the mob is out of reach, fight() returns out_of_reach
    // and we wait for the next pass (the mob is still chasing).
    // ONE SWING PER PASS, NOT THREE ROUNDS.
    //
    // rounds:3 is ~4 seconds inside one await, and a fight is the single most dangerous
    // place to stop looking -- it is where every long pass on this fleet came from, and
    // the fight path itself checks health once on entry and never again. At one round
    // the keeper re-reads health, target and threat between every swing, which is what
    // "re-plan continuously" was supposed to mean.
    //
    // The planner loses nothing: `_fight` is re-selected next pass while the target is
    // still there and still in band, so three swings is three passes rather than one
    // blind burst -- and any of the three can now be interrupted by a flee.
    const r = await doFight(session, {
      target: targetName, preferId: foeId,
      rounds: 1, swingsPerRound: 1,
      holdPosition: atWall, reach: 3,
    });

    if (r?.killed || r?.won)
      return { sent: true, killed: true, reason: null };

    // out_of_reach: the mob hasn't reached us yet.
    // If the mob IS aggroed (chasing), wait for it to close.
    // If the mob is NOT aggroed, it won't come — walk toward it.
    if (r?.out_of_reach) {
      // Check if the target is aggroed
      const liveFoe = client.room?.objects?.get?.(foeId);
      const isAggroed = !!(liveFoe?.flags & OF.ENEMY);
      if (!isAggroed && r.nearest?.distance > 5) {
        // Not aggroed and far away — walk toward it to close the gap.
        const tgt = client.room?.objects?.get?.(foeId);
        if (tgt) {
          const approach = session.world?.approachSquare?.(tgt.col, tgt.row);
          if (approach && approach.steps > 0) {
            console.error(`[scavenge] ${nm} ${targetName} not aggroed (${r.nearest.distance?.toFixed(1)} away), walking to close gap`);
            // Cap the walk to 8 steps per pass. The GOAP re-plans
            // every second, so the character walks 8 cells closer
            // per pass and reaches the mob in 3-5 passes.
            const cappedSteps = Math.min(approach.steps, 8);
            const walkResult = await session.walkTo(approach.col, approach.row, { maxSteps: cappedSteps }).catch(() => ({ arrived: false, reason: 'walk error' }));
            if (!walkResult.arrived) {
              return {
                sent: true, killed: false,
                reason: `could not reach ${targetName}: ${walkResult.reason ?? 'walk failed'} (dist=${r.nearest?.distance ?? '?'})`,
                holding: false,
              };
            }
          }
        }
        return {
          sent: true, killed: false,
          reason: `closing gap to non-aggroed ${targetName} (dist=${r.nearest?.distance ?? '?'})`,
          holding: false,
        };
      }
      return {
        sent: true, killed: false,
        reason: `holding safe spot, waiting for ${targetName} to close (dist=${r.nearest?.distance ?? '?'})`,
        holding: true,
      };
    }

    const unreachable = /could not get|ran out of steps|blocked|no approach/i.test(r?.reason ?? '');
    if (unreachable) {
      lastResult = r;
      console.error(`[scavenge] ${nm} target ${i + 1} ${targetName} unreachable: ${r.reason}`);
      break ONE_TARGET;
    }

    lastResult = r;
    break ONE_TARGET;
  }

  // All targets unreachable or fight failed
  const firstTarget = sorted[0];
  const firstName = client?.rsc?.get?.(firstTarget.nameRsc) ?? firstTarget.name ?? 'creature';
  if (/could not get|ran out of steps|blocked|no approach/i.test(lastResult?.reason ?? '')) {
    // The message said "any of 3 nearest hostiles" long after the 3-target loop was
    // collapsed to one. A reason string that describes behaviour the code no longer has
    // is how a reader is sent looking for a loop that is not there.
    console.error(`[scavenge] ${session.name ?? '?'} target ${firstName} unreachable`);
    return { sent: true, killed: false, reason: `could not reach ${firstName}` };
  }
  return {
    sent: true,
    killed: lastResult?.killed ?? lastResult?.won ?? false,
    reason: lastResult?.killed || lastResult?.won ? null : (lastResult?.reason ?? 'fight did not end in a kill'),
  };
}

// No precondition: scavenge is always available. When there is no
// target, it waits for the next pass (mobs may be respawning).
// The planner can always plan scavenge to satisfy has_money/has_loot,
// and the execution either fights or idles.
scavenge.pre = [];

// Effect: optimistically, the fight produced loot. The next pass
// re-evaluates has_loot from the actual inventory.
scavenge.effects = ['_fight', 'has_loot', 'has_money'];  // fighting kills the target, drops gold AND items

scavenge.atomic = 'scavenge';
scavenge.mutates = true;  // sends combat packets; the room and inventory change
scavenge.cost = 3;        // a fight is expensive: time, risk, vigor
