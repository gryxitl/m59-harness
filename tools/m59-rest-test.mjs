#!/usr/bin/env node
// RESTING MUST NOTICE IT IS BEING HIT. Offline, no server, safe to run any time:
//
//   node tools/m59-rest-test.mjs
//
// restUntil sits still for up to two and a half minutes and restores health slowly.
// It does nothing to stop anything hitting you, so the only evidence that a rest is
// going badly is that health is going DOWN — and it already reads vitals every three
// seconds to decide whether it is finished.
//
// It did not always look. Zoot rested 61 seconds on a square that had been proven safe
// against fewer attackers than were now standing on him, went from 17 health to 3, and
// every one of those reads saw the number falling. These are the cases that must not
// regress: it aborts on damage, it does NOT abort on ordinary slow recovery, and the
// blind behaviour is still reachable on purpose.

import { restUntil, isArmed } from './m59-skills.mjs';

// A session whose stats reads walk down a scripted list of health values.
function fakeSession(seq) {
  let i = 0;
  const c = {
    vitals: () => ({ health: { value: seq[Math.min(i, seq.length - 1)], max: 20 },
                     vigor:  { value: 200, max: 200, scale_max: 200 } }),
    stats: async () => { i++; },
    waitFor: async () => {},
    rest: async () => {},
    stand: async () => {},
  };
  return { need: () => c, pacer: { submit: async (_kind, f) => f() } };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// Climbing, then knocked back down. The comparison has to be against the best health
// seen so far and not the health we sat down at, or 12 -> 16 -> 14 reads as progress.
{
  const r = await restUntil(fakeSession([12, 14, 16, 14]),
                            { health: 0.99, vigor: 0.99, maxSeconds: 120 });
  ok('aborts when health falls back from its peak', !!r.interrupted, JSON.stringify(r.interrupted));
  ok('says how much was lost', /took 2 damage/.test(r.interrupted || ''), r.interrupted);
  ok('cuts the rest short instead of burning the leash', r.seconds < 30, 'seconds=' + r.seconds);
}

// Ordinary recovery. Must not abort — a rest that bails on its own regeneration would
// leave every character permanently hurt.
{
  const r = await restUntil(fakeSession([12, 15, 18, 20]),
                            { health: 0.95, vigor: 0.95, maxSeconds: 120 });
  ok('does not abort on a clean recovery', !r.interrupted, JSON.stringify(r.interrupted));
  ok('still reaches the target', r.reached_target === true);
}

// The old behaviour, still available for a caller that genuinely wants to sit it out.
{
  const r = await restUntil(fakeSession([12, 14, 9]),
                            { health: 0.99, vigor: 0.99, maxSeconds: 12, abortOnDamage: false });
  ok('abortOnDamage:false keeps the blind behaviour', !r.interrupted);
}

// An owned RTS recovery may be cancelled after it has sat down. Cancellation must
// stop further work but still stand as cleanup, or the character remains unable to
// move or fight after the job reports that it stopped.
{
  let cancel = false;
  const packets = [];
  const c = {
    vitals: () => ({ health: { value: 10, max: 20 },
                     vigor: { value: 40, max: 200, scale_max: 200 } }),
    stats: async () => {}, waitFor: async () => {},
    rest: async () => { packets.push('rest'); cancel = true; },
    stand: async () => { packets.push('stand'); },
  };
  const s = { need: () => c, pacer: { submit: async (_kind, fn) => fn() } };
  const guarded = [];
  const r = await restUntil(s, { health: 0.9, vigor: 0.9,
    beforeMutation: packet => guarded.push(packet), shouldCancel: () => cancel });
  ok('an owned recovery reports cancellation', r.cancelled === true, JSON.stringify(r));
  ok('a cancelled recovery still stands as cleanup', packets.join(',') === 'rest,stand', packets.join(','));
  ok('cleanup stand bypasses the cancelled mutation guard', guarded.join(',') === 'rest', guarded.join(','));
}

// The exception to cleanup is a keeper that resumed while the owned recovery was
// unwinding. Sending the old controller's stand after that handoff can interrupt the
// keeper's posture/action. The cleanup hook runs inside the pacer callback and must
// suppress that packet while preserving cancellation telemetry.
{
  let cancel = false;
  const packets = [];
  const c = {
    vitals: () => ({ health: { value: 10, max: 20 },
                     vigor: { value: 40, max: 200, scale_max: 200 } }),
    stats: async () => {}, waitFor: async () => {},
    rest: async () => { packets.push('rest'); cancel = true; },
    stand: async () => { packets.push('stand'); },
  };
  const s = { need: () => c, pacer: { submit: async (_kind, fn) => fn() } };
  const r = await restUntil(s, { health: 0.9, vigor: 0.9,
    shouldCancel: () => cancel,
    beforeCleanup: packet => {
      if (packet !== 'cleanup-stand') throw new Error(`unexpected cleanup packet ${packet}`);
      throw new Error('RTS control refused while this character has an active keeper');
    },
  });
  ok('cancelled recovery stays cancelled when cleanup authority is lost',
     r.cancelled === true, JSON.stringify(r));
  ok('a newly active keeper suppresses the old controller cleanup stand',
     packets.join(',') === 'rest', packets.join(','));
  ok('the skipped cleanup reason stays visible',
     /active keeper/.test(r.cleanup_stand_skipped || ''), JSON.stringify(r));
}

// AFTER A DEATH, STAY IN AND REST UNTIL WHOLE.
//
// Scooter died twice inside forty minutes: the keeper escaped the Underworld, cleared
// its one-shot needsRecovery flag on the same pass, and sent a 5-health character with
// no weapon straight back to the room that had just killed it. recovered() is the gate
// that stops that, and the trap it must not fall into is demanding more vigor than
// resting can deliver — REST_VIGOR_CAP is 80 of 200, and asking for more retires the
// character silently rather than erroring.
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  const keeper = (health, maxHealth, vigor) => {
    const k = Object.create(Autopilot.prototype);
    k.recoverUntilWhole = true;
    k.s = { client: { vitals: () => ({
      health: { value: health, max: maxHealth },
      vigor:  { value: vigor, scale_max: 200 },
    }) } };
    return k;
  };

  ok('a character back from the dead at 11% is not recovered',
     keeper(3, 28, 80).recovered() === false);
  ok('nor at 80% — the ordinary restBelow would already have released it',
     keeper(23, 28, 80).recovered() === false);
  ok('at full health and the resting cap it IS recovered',
     keeper(28, 28, 80).recovered() === true);
  ok('28 of 29 counts as whole, so the last health point does not block for ever',
     keeper(28, 29, 80).recovered() === true);

  // The deadlock. Vigor above 80/200 comes only from food, so a character resting in
  // an inn can never exceed it — requiring more would hold it there for ever.
  ok('full health with vigor AT the cap does not deadlock waiting for 200',
     keeper(28, 28, 80).recovered() === true);
  ok('but below the cap it keeps resting',
     keeper(28, 28, 40).recovered() === false);

  // Clearing is the point: the flag must go off, or the character never fights again.
  const done = keeper(28, 28, 80);
  done.recovered();
  ok('recovering clears the flag once whole', done.recoverUntilWhole === false);
  const notYet = keeper(3, 28, 80);
  notYet.recovered();
  ok('and does NOT clear it while still hurt', notYet.recoverUntilWhole === true);

  // Unknown vitals must not be read as "fine" — that would defeat the whole gate.
  const blind = Object.create(Autopilot.prototype);
  blind.recoverUntilWhole = true;
  blind.s = { client: { vitals: () => ({}) } };
  ok('unreadable vitals keep it resting rather than releasing it',
     blind.recovered() === false);
}

// MANA IS THE THIRD BAR, AND IT IS WHY CHARACTERS DIED TWICE IN A ROW.
//
// Everything a character owns is on the floor of the room that killed it, so the only
// route back to a weapon is `create weapon` at 15 mana. recovered() used to release at
// full health and 80 vigor, which is a state a character reaches with ten mana — below
// the spell, unable to arm itself anywhere it was being sent. Zoot, Rizzo and Animal
// were all let out that way and all died again inside four minutes.
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  const keeper = (health, maxHealth, vigor, mana = null, manaMax = 20) => {
    const k = Object.create(Autopilot.prototype);
    k.recoverUntilWhole = true;
    k.note = () => {};
    k.s = { client: { vitals: () => ({
      health: { value: health, max: maxHealth },
      vigor:  { value: vigor, scale_max: 200 },
      ...(mana === null ? {} : { mana: { value: mana, max: manaMax } }),
    }) } };
    return k;
  };

  ok('whole on health and vigor but empty of mana is NOT recovered',
     keeper(28, 28, 80, 2).recovered() === false);
  ok('ten of twenty mana is still short of a create weapon',
     keeper(28, 28, 80, 10).recovered() === false);
  ok('a full mana bar with the other two back IS recovered',
     keeper(28, 28, 80, 20).recovered() === true);
  ok('19 of 20 counts, so the last mana point does not block for ever',
     keeper(28, 28, 80, 19).recovered() === true);
  // A character with no mana bar at all must not be held for one it cannot fill: that
  // is the same silent retirement the vigor cap exists to avoid.
  ok('no mana reading at all is not a shortfall',
     keeper(28, 28, 80, null).recovered() === true);

  // THE DEADLINE. Three vitals is three ways to wait for something that is not coming.
  const stuck = keeper(28, 28, 80, 2);
  stuck.recoverSince = Date.now() - 13 * 60_000;
  ok('after the deadline it goes out anyway rather than parking for ever',
     stuck.recovered() === true);
  ok('and clears the flag when it does', stuck.recoverUntilWhole === false);
  const waiting = keeper(28, 28, 80, 2);
  waiting.recoverSince = Date.now() - 60_000;
  ok('but a minute in it is still recovering', waiting.recovered() === false);
}

// LEAVING SAFETY NEEDS POSITIVE EVIDENCE OF A WEAPON.
//
// `known` is false until the first BP_USE_LIST lands — which is the pass right after a
// login, and a resume logs in twenty-one characters at once. armed() answers "yes" there
// on no evidence, which is right mid-fight and fatal at an inn door.
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  const keeper = (eq) => {
    const k = Object.create(Autopilot.prototype);
    k.s = { client: { equipment: () => eq, rsc: { get: () => null } } };
    return k;
  };
  const unknown = { known: false, equipped: [] };
  const emptyHanded = { known: true, equipped: [] };
  const holdingMace = { known: true, equipped: [{ id: 1, name: 'mace' }] };
  const holdingBread = { known: true, equipped: [{ id: 1, name: 'bread' }] };

  ok('armed() still says yes on an unread use list — it must not stop a fight',
     isArmed({ equipment: () => unknown, rsc: { get: () => null } }) === true);
  ok('armedForSure() says no on the same reading',
     keeper(unknown).armedForSure() === false);
  ok('both say no to a confirmed empty hand',
     isArmed({ equipment: () => emptyHanded, rsc: { get: () => null } }) === false && keeper(emptyHanded).armedForSure() === false);
  ok('both say yes to a mace',
     isArmed({ equipment: () => holdingMace, rsc: { get: () => null } }) === true && keeper(holdingMace).armedForSure() === true);
  ok('a loaf of bread is not a weapon',
     keeper(holdingBread).armedForSure() === false);
}

// SIT IN A CORNER, AND IN THE EMPTIEST ONE THERE IS.
//
// Two of the four approaches to a corner are wall, so anything that wants to reach a
// character sitting in one has half as many squares to do it from. It costs nothing —
// the character is sitting still either way — and it is what a person does in a tavern.
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  // A ten-by-ten grid with floor in the box rows 2..8, cols 2..8. (2,2), (2,8), (8,2)
  // and (8,8) are corners; the middle of an edge is a wall; the centre is open floor.
  const room = (others = []) => {
    const k = Object.create(Autopilot.prototype);
    const geo = {
      rows: 10, cols: 10,
      walkable: (row, col) => row >= 2 && row <= 8 && col >= 2 && col <= 8,
    };
    const me = { id: 0, col: 5, row: 5 };
    const objects = new Map([[0, me], ...others.map((o, i) => [i + 1, { id: i + 1, ...o }])]);
    k.s = {
      client: { selfId: 0, self: me, room: { objects } },
      world: {
        geometry: geo,
        // Chebyshev steps, everything reachable — the grid is not what is under test.
        reach: (col, r) => ({ reachable: true,
                              steps: Math.max(Math.abs(col - me.col), Math.abs(r - me.row)) }),
      },
    };
    return k;
  };

  const empty = room().restingSquare();
  ok('an empty room seats the character in a corner', empty?.seat === 'corner',
     JSON.stringify(empty));
  ok('and not in the middle of the floor it was standing on',
     !(empty?.col === 5 && empty?.row === 5), JSON.stringify(empty));
  ok('the corner it picks is one of the four real ones',
     [2, 8].includes(empty?.col) && [2, 8].includes(empty?.row), JSON.stringify(empty));

  // AN OCCUPIED CORNER IS NOT AN OPEN ONE. Every character here is attackable and they
  // stack, so a corner with a fleetmate already in it is the crowd the clearance rule
  // exists to avoid — take another corner, not that one.
  const taken = room([{ col: 2, row: 2 }]).restingSquare();
  ok('a corner with somebody already in it is not chosen',
     !(taken?.col === 2 && taken?.row === 2), JSON.stringify(taken));
  ok('it takes a different corner rather than giving up on corners',
     taken?.seat === 'corner', JSON.stringify(taken));

  // All four corners occupied: it must still seat the character somewhere rather than
  // returning nothing, because "nowhere clear to rest" is what leaves it on its feet.
  const crowded = room([{ col: 2, row: 2 }, { col: 2, row: 8 },
                        { col: 8, row: 2 }, { col: 8, row: 8 }]).restingSquare();
  ok('with every corner taken it still finds a seat', !!crowded, JSON.stringify(crowded));
  ok('and says honestly that it is not a corner',
     crowded && crowded.seat !== 'corner', JSON.stringify(crowded));
}

// restUntil has to be able to WAIT for mana, and must not read "only mana is moving"
// as a stall — health and vigor are already at their ceilings in the case that needs it.
{
  let i = 0;
  const seq = [4, 8, 12, 16, 20];
  const s = {
    need: () => ({
      vitals: () => ({ health: { value: 20, max: 20 },
                       vigor:  { value: 200, max: 200, scale_max: 200 },
                       mana:   { value: seq[Math.min(i, seq.length - 1)], max: 20 } }),
      stats: async () => { i++; },
      waitFor: async () => {}, rest: async () => {}, stand: async () => {},
    }),
    pacer: { submit: async (_k, f) => f() },
  };
  const r = await restUntil(s, { health: 0.95, vigor: 0.95, mana: 0.95, maxSeconds: 60 });
  ok('sits for mana even with health and vigor already full', r.reached_target === true,
     JSON.stringify({ reached: r.reached_target, mana: r.vitals?.mana }));
  ok('and does not call a climbing mana bar a stall', !/nothing recovered/.test(r.note || ''),
     r.note);
}

// The default is unchanged: a caller that says nothing about mana must not start
// waiting for it. Every existing call site depends on this.
{
  const s = {
    need: () => ({
      vitals: () => ({ health: { value: 20, max: 20 },
                       vigor:  { value: 200, max: 200, scale_max: 200 },
                       mana:   { value: 1, max: 20 } }),
      stats: async () => {}, waitFor: async () => {},
      rest: async () => {}, stand: async () => {},
    }),
    pacer: { submit: async (_k, f) => f() },
  };
  const r = await restUntil(s, { health: 0.95, vigor: 0.95, maxSeconds: 60 });
  ok('an empty mana bar does not hold a rest that never asked for mana',
     r.rested === false && /already recovered/.test(r.note || ''), JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
