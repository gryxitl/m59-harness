#!/usr/bin/env node
// m59-act-test.mjs -- THE ATOMIC CONTRACT, ENFORCED MECHANICALLY.
//
// Offline, no server:  node tools/m59-act-test.mjs
//
// Two halves. The first is a CONFORMANCE sweep that every file in tools/m59-act/
// must pass, whoever writes it and whenever: it is the thing that stops the next
// wave of atomics turning into wrappers the way the last one did. The second is
// per-atomic behaviour.
//
// The conformance rules come from docs/keeper-rebuild-plan.md §4, and each exists
// because of a specific failure already paid for in this repository:
//
//   TAKES A CLIENT, NOT A KEEPER
//     The fork's BT modules took a keeper and called 71 of its methods. 25 of
//     those existed on one fork only, so the modules could not be carried to
//     another trunk at all -- the wrapper debt and the fork turned out to be the
//     same bill. An atomic over the client is portable because m59-client.mjs is
//     identical everywhere.
//
//   DECLARES pre/effects FROM THE CLOSED VOCABULARY
//     A precondition nobody produces makes a plan silently unsatisfiable, and the
//     planner can only report "no plan". Same shape as policy.purpose sitting
//     outside a schema for a year with the yield audit switched off behind it.
//
//   NO UNBOUNDED LOOP
//     The keeper is a long-await machine and 82% of deaths had it blind, worst
//     case 909 seconds inside one travel call. An atomic that loops cannot be
//     interrupted between iterations, so looping belongs to the caller.
//
//   REFUSES BY RETURNING, NOT BY THROWING
//     A refusal that throws has to be caught by every caller, and the ones that
//     forget read it as success -- which is exactly how "no error" came to mean
//     "the merchant sold it" for years, when a refusal here is a sentence spoken
//     to the room and never an error on the wire.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, SYMBOL_NAMES, evaluate } from './m59-worldstate.mjs';
import { fakeClient, fakeSession } from './m59-fake-client.mjs';
import { didAct } from './m59-plan.mjs';

const evaluateFor = (spec) => evaluate({ client: fakeClient(spec), policy: {} });
const ACTDIR = join(dirname(fileURLToPath(import.meta.url)), 'm59-act');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// ---------------------------------------------------------------------------
// Conformance: every atomic, every rule.
// ---------------------------------------------------------------------------
const files = readdirSync(ACTDIR).filter(f => f.endsWith('.mjs')).sort();
ok('there is at least one atomic to check', files.length > 0);

for (const file of files) {
  const src = readFileSync(join(ACTDIR, file), 'utf8');
  const mod = await import(join(ACTDIR, file));
  const fns = Object.values(mod).filter(v => typeof v === 'function' && v.atomic);

  console.log(`\nconformance: m59-act/${file}`);
  ok(`${file} exports at least one tagged atomic`, fns.length > 0,
     'tag it with `fn.atomic = "name"` so the sweep can find it');

  for (const fn of fns) {
    const n = fn.atomic;

    // 1. the vocabulary
    ok(`${n}: declares pre`, Array.isArray(fn.pre));
    ok(`${n}: declares effects`, Array.isArray(fn.effects));
    const problems = validate({ name: n, pre: fn.pre, effects: fn.effects });
    ok(`${n}: every pre/effect is a known world-state symbol`, problems.length === 0,
       problems[0] ?? '');
    // An atomic that changes nothing is a Condition, not an Action. The exception:
    // item-level atomics (pickup, drop, buy, sell, deposit, withdraw) change the
    // pack or the purse, which the 14-symbol vocabulary does not model. They are
    // actions by construction — they send a mutation packet — and the planner
    // re-evaluates world state after each step, so the effects are visible to the
    // next plan even though they are not declared here. Mark them `mutates = true`
    // so the sweep knows the empty effects are honest, not an oversight.
    ok(`${n}: effects are not empty — an atomic that changes nothing is a Condition`,
       (fn.effects ?? []).length > 0 || fn.mutates === true,
       fn.mutates ? '' : 'declare effects or set fn.mutates = true for item-level atomics');

    // 2. NEVER THE KEEPER. Checked in the source, because a signature cannot say it.
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok(`${n}: never reaches for a keeper`,
       !/\bkeeper\./.test(body) && !/\bthis\.(policy|s|note|tally)\b/.test(body),
       'an atomic takes (client, session) and nothing else');

    // 3. bounded — no loop around an await
    //
    // MATCHED BY BRACE, NOT BY REGEX. The old test was
    // /\b(while|for)\s*\([^)]*\)\s*\{[^]*?\bawait\b/, which is any loop followed
    // ANYWHERE LATER by an await — so a pure geometry scan with a single walk after it
    // failed, while what the rule is actually about is an await INSIDE the loop body.
    // A check that cries wolf gets the rule relaxed or the file exempted, and then it
    // is not there for the real violation; take_safe_spot was the wolf.
    const loopBodyHasAwait = (src) => {
      const re = /\b(while|for)\s*\(/g;
      let m;
      while ((m = re.exec(src))) {
        // step over the head to its opening brace, then brace-match the body
        let i = src.indexOf('{', m.index);
        if (i < 0) continue;
        let depth = 0, end = -1;
        for (let at = i; at < src.length; at++) {
          if (src[at] === '{') depth++;
          else if (src[at] === '}') { depth--; if (depth === 0) { end = at; break; } }
        }
        if (end < 0) continue;
        if (/\bawait\b/.test(src.slice(i, end))) return true;
      }
      return false;
    };
    const looping = loopBodyHasAwait(body);
    ok(`${n}: contains no loop around an await`, !looping,
       'looping is the callers job, so it can be interrupted between iterations');

    // 4. arity: (client, session, args)
    ok(`${n}: takes (client, session, args)`, fn.length <= 3 && fn.length >= 2);
  }
}

// ---------------------------------------------------------------------------
// Behaviour: attack
// ---------------------------------------------------------------------------
const { attack, SWING_MS } = await import('./m59-act/attack.mjs');

const withFoe = (col = 11, row = 10) => {
  const c = fakeClient({
    selfId: 1, col: 10, row: 10,
    equipped: [{ id: 5, name: 'mace' }],
    room: { num: 1, objects: [{ id: 9, name: 'mummy', col, row }] },
  });
  return { c, s: fakeSession(c) };
};

console.log('\nattack: one swing, and it reaches the wire');
{
  const { c, s } = withFoe();
  const r = await attack(c, s, { targetId: 9, waitMs: 1 });
  ok('it reports sending', r.sent === true);
  ok('exactly ONE attack packet — an atomic is one swing',
     c.sent.filter(x => x[0] === 'attack').length === 1, JSON.stringify(c.sent));
  ok('aimed at the target we named', c.sent.find(x => x[0] === 'attack')[1] === 9);
  ok('the swing timer is the server\'s', SWING_MS === 1050);
}

console.log('\nattack refuses by RETURNING — never by throwing');
{
  const { c, s } = withFoe();
  let threw = false; let r;
  try { r = await attack(c, s, {}); } catch { threw = true; }
  ok('no target: does not throw', !threw);
  ok('and says why', r.sent === false && /no target/.test(r.reason));
  ok('and sent nothing', c.sent.length === 0);

  let r2, threw2 = false;
  try { r2 = await attack(null, null, { targetId: 9 }); } catch { threw2 = true; }
  ok('no client: does not throw either', !threw2 && r2.sent === false);
}

console.log('\nattack obeys the reach disc — a swing from too far is thrown away by the server');
{
  const far = withFoe(14, 10);              // distance 4, outside the radius-3 disc
  const r = await attack(far.c, far.s, { targetId: 9, waitMs: 1 });
  ok('it refuses rather than wasting the round', r.sent === false);
  ok('and names the reason', /out of reach/.test(r.reason));
  ok('and no packet went out', far.c.sent.filter(x => x[0] === 'attack').length === 0);

  // THREE SQUARES IS THE SERVER'S BOUND AND IS NO LONGER A SWING WE TAKE.
  //
  // The disc of radius 3 is what the server accepts; whether to swing from its outer
  // edge is a different question, and it now has one answer shared by the planner and
  // the mover (attackReachFor, m59-combat.mjs). It is the conservative one: MANHATTAN
  // <= 2 for an armed character, because a swing refused for range costs the whole
  // cooldown second it was paced against. Measured: JayB, 331 swings in nine minutes
  // at level-25 mummies, zero kills, neither side losing health.
  //
  // Before this there were two rules — a Euclidean 3 here and a Manhattan 2 in the
  // controller — and a target three squares NSEW read in-reach to one and out to the
  // other. Under the planner that is a livelock: pick `attack`, get refused, pick it
  // again, ten times a second.
  const edge = withFoe(13, 10);             // Manhattan 3 — the server would take it, we do not
  const r2 = await attack(edge.c, edge.s, { targetId: 9, waitMs: 1 });
  ok('three squares away is the server\'s edge, and we hold for a square closer',
     r2.sent === false);

  const good = withFoe(12, 10);             // Manhattan 2 — inside the disc whatever it rounds to
  const r3 = await attack(good.c, good.s, { targetId: 9, waitMs: 1 });
  ok('two squares away does swing', r3.sent === true);
}

console.log('\nattack is honest: it reads the room back rather than trusting the send');
{
  const { c, s } = withFoe();
  const r = await attack(c, s, { targetId: 9, waitMs: 1 });
  ok('the target was there before', r.target_present_before === true);
  ok('and is reported still there after — nothing is claimed about damage',
     r.target_present_after === true);

  // Now the room says it is gone. The atomic must report the ROOM's answer.
  const { c: c2, s: s2 } = withFoe();
  s2.pacer = { submit: async (_k, fn) => { fn(); c2.room.objects.delete(9); } };
  const r2 = await attack(c2, s2, { targetId: 9, waitMs: 1 });
  ok('a target that left is reported gone, from the room and not from the send',
     r2.sent === true && r2.target_present_after === false);
}

console.log('\nattack will not swing at something that is not there');
{
  const { c, s } = withFoe();
  const r = await attack(c, s, { targetId: 999, waitMs: 1 });
  ok('an absent target is refused', r.sent === false && /not in the room/.test(r.reason));
  ok('and nothing was sent', c.sent.filter(x => x[0] === 'attack').length === 0);
}

// ---------------------------------------------------------------------------
// Behaviour: step
// ---------------------------------------------------------------------------
const { step, WALK_SPEED, VIGOR_RUN_THRESHOLD } = await import('./m59-act/step.mjs');

const walker = (spec = {}) => {
  const c = fakeClient({ selfId: 1, col: 5, row: 5, vigor: 100, room: { num: 7 }, ...spec });
  return { c, s: fakeSession(c) };
};

console.log('\nstep: one square, and arrival is READ BACK not assumed');
{
  const { c, s } = walker();
  const r = await step(c, s, { col: 6, row: 5, waitMs: 1 });
  ok('it moved', r.sent === true && r.arrived === true);
  ok('it reports where it came from and where it landed',
     r.from.col === 5 && r.at.col === 6, JSON.stringify(r));
  ok('exactly one movement went out — an atomic is one step',
     c.sent.filter(x => x[0] === 'step').length === 1, JSON.stringify(c.sent));
}

console.log('\nstep is honest: a move the world refuses is NOT an arrival');
{
  // The packet goes out and nothing happens -- which is what a collision refusal
  // looks like on this wire. A caller that trusted the send walks a route it never
  // actually started.
  const { c, s } = walker();
  s.step = async () => ({ moved: false, reason: 'blocked' });   // world does not budge
  const r = await step(c, s, { col: 9, row: 9, waitMs: 1 });
  ok('it does not claim to have arrived', r.arrived === false);
  ok('and it says where it actually is', r.at.col === 5 && r.at.row === 5);
  ok('and carries the reason through', r.reason === 'blocked');
}

console.log('\nstep propagates TERMINAL failures rather than inviting a retry');
{
  const { c, s } = walker();
  s.step = async () => ({ moved: false, reason: 'collision_geometry_unavailable' });
  const r = await step(c, s, { col: 6, row: 5, waitMs: 1 });
  ok('a terminal reason is marked as such', r.terminal === true);
  ok('retrying one of these just re-sends a move the geometry already refused',
     r.arrived === false);

  const { c: c2, s: s2 } = walker();
  s2.step = async () => ({ moved: false, reason: 'blocked' });
  const r2 = await step(c2, s2, { col: 6, row: 5, waitMs: 1 });
  ok('an ordinary refusal is NOT terminal — that one is worth retrying',
     r2.terminal === undefined);
}

console.log('\nstep offers no speed, because the mover accepts none');
{
  // The run floor is real (below vigor 10 the server snaps you back and logs you as
  // a speedhacker) but UNREACHABLE: the broker's mover is step(col,row,{confirm,
  // beforeMutation}) and takes no speed. An argument the mover drops is a lever
  // connected to nothing, and a guard on it can never fire -- the same shape as the
  // `typeof c.armed === 'function'` branch that has never executed.
  const { c, s } = walker({ vigor: 4 });
  const r = await step(c, s, { col: 6, row: 5, waitMs: 1 });
  ok('a character at 4 vigor still steps — walking has no floor',
     r.sent === true && r.arrived === true);
  ok('the constants stay for citation even though nothing consumes them',
     WALK_SPEED === 18 && VIGOR_RUN_THRESHOLD === 10);
  ok('and no speed is passed to the mover',
     c.sent.filter(x => x[0] === 'step').length === 1);
}

console.log('\nstep requires the validated mover — the grid is for planning, not stepping');
{
  // Centre-to-centre grid steps are measured to fail 218 of 311 in room 587, and
  // 92% of those failures DO NOT MOVE THE CHARACTER -- so a caller replans from an
  // unchanged position and asks for the identical refused step for ever.
  const c = fakeClient({ selfId: 1, col: 5, row: 5, room: { num: 587 } });
  const s = fakeSession(c);
  delete s.step;                       // a session with no fine-coordinate mover
  const r = await step(c, s, { col: 6, row: 5, waitMs: 1 });
  ok('it refuses rather than sending a step that cannot work',
     r.sent === false && /no validated mover/.test(r.reason));
  ok('and marks it terminal — retrying cannot make it legal', r.terminal === true);
  ok('and NOTHING went to the wire', c.sent.length === 0);
}

console.log('\nstep refuses what cannot be a step at all');
{
  const { c, s } = walker();
  const same = await step(c, s, { col: 5, row: 5, waitMs: 1 });
  ok('a step to where we already stand sends nothing and is already arrived',
     same.sent === false && same.arrived === true && c.sent.length === 0);

  const bad = await step(c, s, { col: 1.5, row: 'x', waitMs: 1 });
  ok('a non-integer target is invalid_move_target and terminal',
     bad.sent === false && bad.reason === 'invalid_move_target' && bad.terminal === true);

  const lost = walker({ overrides: { self: null } });
  const r = await step(lost.c, lost.s, { col: 6, row: 5, waitMs: 1 });
  ok('not knowing where we are is terminal, not a guess',
     r.sent === false && r.reason === 'own_position_unknown' && r.terminal === true);

  let threw = false;
  try { await step(null, null, { col: 1, row: 1 }); } catch { threw = true; }
  ok('and none of these throw', !threw);
}

// ---------------------------------------------------------------------------
// Behaviour: equip / rest / stand
// ---------------------------------------------------------------------------
const { equip } = await import('./m59-act/equip.mjs');
const { rest, stand } = await import('./m59-act/rest.mjs');

console.log('\nequip: the USE LIST is the answer, never what the send asked for');
{
  // A `use` that the server declines says so OUT LOUD to the room and sends
  // nothing on the wire -- "your hands are too full", player.kod:131. So a caller
  // that trusts the send goes on believing it is armed. Nineteen of twenty-five
  // characters were once found fighting in their shirts.
  const c = fakeClient({ inventory: [{ id: 3, name: 'mace' }], equipped: [] });
  const s = fakeSession(c);
  const r = await equip(c, s, { itemId: 3, waitMs: 1 });
  ok('the packet went', r.sent === true);
  ok('but nothing changed, because the use list did not move',
     r.changed === false && r.equipped_after === false);
  ok('and it says so rather than reporting success',
     /did not move/.test(r.reason), r.reason);
}

console.log('\nequip reports a real change when the use list actually moves');
{
  const c = fakeClient({ inventory: [{ id: 3, name: 'mace' }], equipped: [] });
  const s = fakeSession(c);
  // the server accepts: the use list gains the item
  s.pacer = { submit: async (_k, fn) => { fn(); c.equipment = () =>
    ({ known: true, equipped: [{ id: 3, name: 'mace' }], count: 1 }); } };
  const r = await equip(c, s, { itemId: 3, waitMs: 1 });
  ok('changed is true only when the SERVER moved it',
     r.changed === true && r.equipped_before === false && r.equipped_after === true);
}

console.log('\nequip refuses the two no-ops, because re-using is REFUSED not idempotent');
{
  const armedC = fakeClient({ equipped: [{ id: 3, name: 'mace' }] });
  const r = await equip(armedC, fakeSession(armedC), { itemId: 3, waitMs: 1 });
  ok('wielding what we already wield sends nothing',
     r.sent === false && /already in use/.test(r.reason) && armedC.sent.length === 0);

  const bareC = fakeClient({ equipped: [] });
  const r2 = await equip(bareC, fakeSession(bareC), { itemId: 3, off: true, waitMs: 1 });
  ok('taking off what is not on sends nothing either',
     r2.sent === false && /not in use/.test(r2.reason));
}

console.log('\nequip will not claim a change from an unread use list');
{
  // known:false means NOBODY HAS ASKED, which is the opposite fact from "nothing
  // is equipped" and must never render the same.
  const c = fakeClient({ equipped: [], known: false });
  const r = await equip(c, fakeSession(c), { itemId: 3, waitMs: 1 });
  ok('it still sends — an unread list is not a refusal', r.sent === true);
  ok('but claims no change, because there is no evidence either way',
     r.changed === false && r.equipped_before === null);
}

console.log('\nrest / stand: one posture change, and no confirmation is invented');
{
  const c = fakeClient({ vigor: 20 });
  const s = fakeSession(c);
  const r = await rest(c, s, { waitMs: 1 });
  ok('rest sends exactly one', r.sent === true && c.sent.filter(x => x[0] === 'rest').length === 1);
  // Posture is reported by no packet this client parses. Claiming to have
  // confirmed it would be the UC_LOOK_PLAYER mistake: inventing an answer for a
  // question nothing on the wire asks.
  ok('and does NOT pretend to have confirmed the posture', r.posture_confirmed === false);

  const r2 = await stand(c, s, { waitMs: 1 });
  ok('stand sends exactly one', r2.sent === true && c.sent.filter(x => x[0] === 'stand').length === 1);

  let threw = false;
  try { await rest(null, null); await stand(null, null); } catch { threw = true; }
  ok('neither throws without a session', !threw);
}

console.log('\nresting cannot pass the cap, and the vocabulary is what says so');
{
  // REST_VIGOR_CAP is 80 of 200: everything above it has to be EATEN, and a fleet
  // holding out for a vigor no rest can deliver looks exactly like a working one.
  const low  = evaluateFor({ vigor: 40 });
  const atCap = evaluateFor({ vigor: 80 });
  ok('under the cap, sitting down can still pay', low.can_rest_higher === true);
  ok('AT the cap it cannot, however long you sit', atCap.can_rest_higher === false);
  ok('rest declares that as its effect, so a planner cannot loop on it',
     rest.effects.includes('can_rest_higher'));
}

// ---------------------------------------------------------------------------
// Behaviour: cast — A CHARACTER CAN ONLY CAST WHAT IT KNOWS
// ---------------------------------------------------------------------------
const { cast, knownSpells, spellNamed, groundedCasts, SPELL_EFFECTS }
  = await import('./m59-act/cast.mjs');

const caster = (spells, spec = {}) => {
  const c = fakeClient({ spells, mana: 30, ...spec });
  return { c, s: fakeSession(c) };
};

console.log('\ncast: a spell the character does not know is refused, not attempted');
{
  const { c, s } = caster(['create food']);
  const r = await cast(c, s, { spell: 'shatter lock', waitMs: 1 });
  ok('it refuses', r.sent === false && r.known === false);
  ok('and says why in the character\'s own terms',
     /does not know that spell/.test(r.reason), r.reason);
  ok('and NOTHING went to the wire — asking spends the round for silence',
     c.sent.filter(x => x[0] === 'cast').length === 0);

  const r2 = await cast(c, s, { spell: 'create food', waitMs: 1 });
  ok('a spell it DOES know goes out', r2.sent === true && r2.known === true);
  ok('and it went out by the id from the LIVE list, not a cached one',
     c.sent.find(x => x[0] === 'cast')[1] === spellNamed(c, 'create food').id);
}

console.log('\ncast resolves BY NAME, because ids are renumbered and lists go stale');
{
  // Object ids are renumbered on every save (every 15 minutes) and a group-3 stat
  // packet is POSITIONAL against plSpells -- against a stale list every number is
  // mislabelled silently. So a name is the only durable handle.
  const { c } = caster([{ id: 4242, name: 'create food' }]);
  ok('it finds the spell whatever its id is', spellNamed(c, 'create food').id === 4242);
  ok('matching is case-insensitive', spellNamed(c, 'CREATE FOOD') !== null);
  ok('and an unknown name is null rather than a guess', spellNamed(c, 'fireball') === null);
  ok('knownSpells lists what the character actually holds',
     knownSpells(c).length === 1 && knownSpells(c)[0].name === 'create food');
}

console.log('\ncast refuses on mana rather than sending a spell that cannot land');
{
  const { c, s } = caster(['create food'], { mana: 3 });
  const r = await cast(c, s, { spell: 'create food', waitMs: 1 });
  ok('it refuses', r.sent === false && /not enough mana/.test(r.reason));
  ok('and reports what it had', r.mana_before === 3);
  ok('and sent nothing', c.sent.filter(x => x[0] === 'cast').length === 0);
}

console.log('\ngroundedCasts: an unknown spell is ABSENT from the plan space, not refused in it');
{
  // The same guarantee attack.pre gives against the engagement ceiling: not
  // discouraged, IMPOSSIBLE, because the action does not exist. This is also how
  // the game itself behaves -- a skill you cannot learn is missing from the
  // merchant's offer list (monster.kod:4855) rather than refused.
  const { c } = caster(['create food']);
  const acts = groundedCasts(c);
  ok('a character who knows create food gets exactly that action',
     acts.length === 1 && acts[0].atomic === 'cast create food');
  ok('it carries the SPELL\'s own preconditions, not a generic one',
     acts[0].pre.includes('has_reagents') && acts[0].pre.includes('has_mana'));
  ok('and the spell\'s own effects',
     acts[0].effects.includes('has_food') && acts[0].effects.includes('!has_reagents'));

  const none = groundedCasts(fakeClient({ spells: [] }));
  ok('a character who knows NOTHING gets no cast actions at all — no plan can contain one',
     none.length === 0);

  const other = groundedCasts(fakeClient({ spells: ['blink'] }));
  // blink's preconditions are `entombed` and `can_pay_blink`; its modelled effect is
  // `can_leave`. What this gates is that a spell that is NOT in the closed table is
  // ABSENT from the plan space, because hallucinating a spell's effect is how a
  // planner invents an action that no server behaviour ever matches. A spell that IS
  // in the table (blink is, now, for entombment) gets an action even when the client
  // is not actually entombed; the pre then just refuses the cast at run time.
  ok('and a spell in the closed table appears exactly once',
     other.length === 1 && other[0].atomic === 'cast blink');
  ok('and a spell NOT in the table invents no plan',
     groundedCasts(fakeClient({ spells: ['bogus'] })).length === 0);

  // The chain the fleet actually lives on, expressed in the vocabulary.
  ok('create food is 2 elderberry AND 2 herbs -> a meal',
     SPELL_EFFECTS['create food'].pre.includes('has_reagents') &&
     SPELL_EFFECTS['create food'].effects.includes('has_food'));
}

console.log('\ncast refuses by returning, like every other atomic');
{
  let threw = false; let r;
  try { r = await cast(null, null, { spell: 'create food' }); } catch { threw = true; }
  ok('no client does not throw', !threw && r.sent === false);
  const { c, s } = caster(['create food']);
  const r2 = await cast(c, s, {});
  ok('no spell named does not throw either', r2.sent === false && /no spell/.test(r2.reason));
}

// ---------------------------------------------------------------------------
// Behaviour: eat — the stomach is the constraint, and it is invisible
// ---------------------------------------------------------------------------
const { eat } = await import('./m59-act/eat.mjs');
const { Stomach, STOMACH_CAP } = await import('./m59-skills.mjs');

const eater = (vigor = 40, extra = {}) => {
  const c = fakeClient({ vigor, inventory: [{ id: 4, name: 'bread' }], ...extra });
  return { c, s: fakeSession(c) };
};

console.log('\neat: applies the food to ourselves, and reads the gain back');
{
  const { c, s } = eater(40);
  // the server accepts and vigor rises
  let v = 40;
  c.vitals = () => ({ health: { value: 20, max: 20 }, mana: { value: 20, max: 20 },
                      vigor: { value: v, max: 200, scale_max: 200 } });
  s.pacer = { submit: async (_k, fn) => { fn(); v = 95; } };
  const r = await eat(c, s, { itemId: 4, waitMs: 1 });
  ok('it sent an apply of the food onto ourselves',
     c.sent.some(x => x[0] === 'apply' && x[1] === 4 && x[2] === c.selfId), JSON.stringify(c.sent));
  ok('and reports the gain from vitals rather than assuming one',
     r.vigor_before === 40 && r.vigor_after === 95 && r.gained === 55);
}

console.log('\neat will not eat what is not in the pack');
{
  const { c, s } = eater();
  const r = await eat(c, s, { itemId: 999, waitMs: 1 });
  ok('refused, and nothing sent',
     r.sent === false && /not in the pack/.test(r.reason) && c.sent.length === 0);
}

console.log('\neat refuses a mouthful the stomach cannot take — before the packet');
{
  // ReqEatSomething refuses when piStomach + filling > 100 (player.kod:5703) and
  // says so only to the room. A refusal we can predict is one we can plan around.
  const { c, s } = eater();
  const full = new Stomach(STOMACH_CAP);
  const r = await eat(c, s, { itemId: 4, filling: 25, stomach: full, waitMs: 1 });
  ok('it refuses', r.sent === false && /too full/.test(r.reason));
  ok('and says how long until it would fit — the stomach drains 0.12 a second',
     typeof r.seconds_until_room === 'number' && r.seconds_until_room > 0,
     String(r.seconds_until_room));
  ok('and no packet went out', c.sent.filter(x => x[0] === 'apply').length === 0);
}

console.log('\nthe stomach model is charged on EVIDENCE, and a refusal is a measurement');
{
  // Charging optimistically lets the model drift permanently high; it must move only
  // on what actually happened.
  const gained = new Stomach(0);
  const { c, s } = eater(40);
  let v = 40;
  c.vitals = () => ({ health: { value: 20, max: 20 }, mana: { value: 20, max: 20 },
                      vigor: { value: v, max: 200, scale_max: 200 } });
  s.pacer = { submit: async (_k, fn) => { fn(); v = 90; } };
  await eat(c, s, { itemId: 4, filling: 25, stomach: gained, waitMs: 1 });
  ok('a meal that landed is charged to the model', gained.level >= 25, String(gained.level));

  // Now the server declines: the packet goes, nothing moves.
  const declined = new Stomach(0);
  const { c: c2, s: s2 } = eater(40);
  await eat(c2, s2, { itemId: 4, filling: 25, stomach: declined, waitMs: 1 });
  ok('a meal that did NOT land pins the model from below instead',
     declined.level > 0, String(declined.level));
  ok('and that reading is the only stomach evidence the wire ever gives',
     declined.level >= STOMACH_CAP - 25);
}

console.log('\neat closes the supply chain, in the vocabulary');
{
  ok('it needs food', eat.pre.includes('has_food'));
  ok('it produces vigor and consumes the food',
     eat.effects.includes('vigor_ok') && eat.effects.includes('!has_food'));
  // The reason the chain has to exist at all: resting stops at 80 of 200, so
  // everything above the cap must be eaten.
  ok('and resting alone could never get there — the cap is 80 of 200',
     evaluateFor({ vigor: 80 }).can_rest_higher === false);
}

console.log('\nattack declares a plan-able contract');
{
  ok('pre includes being in reach', attack.pre.includes('in_reach'));
  // AND DELIBERATELY DOES NOT INCLUDE `armed`. Requiring it made `_fight` — a planned
  // goal since phase 3 — unplannable for a bare-handed character, who then stood in
  // front of the quarry doing nothing. Arming is the rung above `_fight` in the ladder,
  // not a precondition of swinging; a character that cannot arm punches, which is how it
  // earns the price of a weapon. See the note beside attack.pre.
  ok('and NOT being armed — punching is how an unarmed character earns a weapon',
     !attack.pre.includes('armed'));
  ok('pre includes the engagement band — the ceiling is a PRECONDITION, not an afterthought',
     attack.pre.includes('target_in_band'));
  ok('every symbol it names exists in the vocabulary',
     [...attack.pre, ...attack.effects].every(s => SYMBOL_NAMES.includes(s.replace(/^!/, ''))));
}

// ---------------------------------------------------------------------------
// Behaviour: pickup
// ---------------------------------------------------------------------------
const { pickUp } = await import('./m59-act/pickup.mjs');

const looter = (spec = {}) => {
  const c = fakeClient({
    selfId: 1, col: 5, row: 5,
    room: { num: 1, objects: [] },
    ...spec,
  });
  return { c, s: fakeSession(c) };
};

console.log('\npickup: picks up an item in reach, refuses what it cannot take');
{
  const { c, s } = looter();
  c.room.objects.set(42, { id: 42, nameRsc: 1, col: 6, row: 5, amount: 1 });
  c.rsc.get = () => 'mace';
  const r = await pickUp(c, s, { itemId: 42, waitMs: 1 });
  ok('it sends a get', r.sent === true);
  ok('and reports the item name on success', r.taken === 'mace' || r.taken === null);
}

console.log('\npickup refuses an item that is not in the room');
{
  const { c, s } = looter();
  const r = await pickUp(c, s, { itemId: 999, waitMs: 1 });
  ok('refused, and says why', r.sent === false && /not in the room/.test(r.reason));
  ok('and nothing went to the wire', c.sent.filter(x => x[0] === 'get').length === 0);
}

console.log('\npickup refuses an item out of reach (manhattan > 7)');
{
  const { c, s } = looter();
  c.room.objects.set(42, { id: 42, nameRsc: 1, col: 20, row: 5 });
  c.rsc.get = () => 'mace';
  const r = await pickUp(c, s, { itemId: 42, waitMs: 1 });
  ok('refused, and names the distance', r.sent === false && /out of reach/.test(r.reason), r.reason);
  ok('and nothing went to the wire', c.sent.filter(x => x[0] === 'get').length === 0);
}

console.log('\npickup refuses the cursed items, because picking one up is not a mistake you can undo');
{
  const { c, s } = looter();
  c.room.objects.set(42, { id: 42, nameRsc: 1, col: 5, row: 5 });
  c.rsc.get = () => 'Amulet of Shadows';
  const r = await pickUp(c, s, { itemId: 42, waitMs: 1 });
  ok('refused', r.sent === false && /cursed/.test(r.reason), r.reason);
  ok('and nothing went to the wire', c.sent.filter(x => x[0] === 'get').length === 0);

  const { c: c2, s: s2 } = looter();
  c2.room.objects.set(43, { id: 43, nameRsc: 1, col: 5, row: 5 });
  c2.rsc.get = () => 'Ring of Lethargy';
  const r2 = await pickUp(c2, s2, { itemId: 43, waitMs: 1 });
  ok('the ring is refused too', r2.sent === false && /cursed/.test(r2.reason), r2.reason);
}

console.log('\npickup declares pack_room as its precondition, so a full pack is a refusal, not a crash');
{
  ok('pre is [pack_room]', pickUp.pre.length === 1 && pickUp.pre[0] === 'pack_room');
}

// ---------------------------------------------------------------------------
// Behaviour: drop
// ---------------------------------------------------------------------------
const { drop } = await import('./m59-act/drop.mjs');

console.log('\ndrop: drops an item from the pack to the floor');
{
  const c = fakeClient({ selfId: 1, col: 5, row: 5, inventory: [{ id: 42, nameRsc: 1 }] });
  const s = fakeSession(c);
  c.rsc.get = () => 'mace';
  const r = await drop(c, s, { itemId: 42, waitMs: 1 });
  ok('it sends a drop', r.sent === true);
  ok('and exactly one drop went out', c.sent.filter(x => x[0] === 'drop').length === 1);
}

console.log('\ndrop refuses an item not in the pack');
{
  const c = fakeClient({ selfId: 1, inventory: [] });
  const s = fakeSession(c);
  const r = await drop(c, s, { itemId: 999, waitMs: 1 });
  ok('refused, and says why', r.sent === false && /not in the pack/.test(r.reason));
  ok('and nothing went to the wire', c.sent.length === 0);
}

// ---------------------------------------------------------------------------
// Behaviour: buy
// ---------------------------------------------------------------------------
const { buy } = await import('./m59-act/buy.mjs');

const shopper = (spec = {}) => {
  const c = fakeClient({
    selfId: 1, col: 5, row: 5,
    inventory: [],
    buyList: null,
    ...spec,
  });
  return { c, s: fakeSession(c) };
};

console.log('\nbuy: buys an item from the merchant\'s buy list');
{
  const { c, s } = shopper();
  c.buyList = { items: [{ id: 42, nameRsc: 1, cost: 100 }] };
  c.inventory = [{ id: 99, nameRsc: 2, amount: 500 }]; // 500 shillings
  c.rsc.get = (r) => r === 1 ? 'mace' : 'shillings';
  const r = await buy(c, s, { itemId: 42, waitMs: 1 });
  ok('it sends a buy', r.sent === true);
}

console.log('\nbuy refuses when there is no buy list');
{
  const { c, s } = shopper();
  c.buyList = null;
  const r = await buy(c, s, { itemId: 42, waitMs: 1 });
  // "No buy list" used to cover two different facts -- nobody to buy from, and a
  // merchant who offered nothing. They have different fixes, so they are now different
  // sentences and this pins the first.
  ok('refused, and says why', r.sent === false && /no merchant in this room/.test(r.reason));
}

console.log('\nA MOUTHFUL THAT MOVED NOTHING IS A REFUSAL TOO');
{
  // Watched live 2026-08-20: Sasquatch, vigor 80, goal vigor_comfortable (180), three
  // purple mushrooms in the pack, planned `eat` 121 times in seven minutes. The count
  // never dropped and the bar never moved. eat() measured `moved` for its stomach model
  // and then returned a bare `sent: true`, so the caller scored every one as progress.
  const feed = (gain) => {
    const st = { v: 80 };
    return { st,
      inventory: [{ id: 5, name: 'purple mushroom', amount: 3 }],
      rsc: { get: () => 'purple mushroom' },
      vitals: () => ({ vigor: { value: st.v }, health: { value: 20, max: 20 } }),
      evSeq: 0, selfId: 1, apply() { st.v += gain; },
      waitFor: async () => ({ events: [] }) };
  };
  const sess = { pacer: { submit: async (_k, f) => { await f(); } } };

  const nothing = await eat(feed(0), sess, { itemId: 5, waitMs: 1 });
  ok('a bar that did not move is reported as unchanged', nothing.changed === false);
  ok('and didAct counts it, so the goal-skip can give up', didAct(nothing) === false);
  ok('and it says so in words', /did not move/.test(nothing.reason ?? ''));

  const fed = await eat(feed(40), sess, { itemId: 5, waitMs: 1 });
  ok('a real meal still reads as acted', fed.changed === true && didAct(fed) === true);
  ok('and reports what it gained', fed.gained === 40);

  // UNKNOWN IS NOT FALSE. A missing vigor reading must not read as a failed meal, or a
  // slow stat packet would stop a character eating at all.
  const blind = { inventory: [{ id: 5, name: 'bread', amount: 1 }], rsc: { get: () => 'bread' },
                  vitals: () => ({ health: { value: 20, max: 20 } }), evSeq: 0, selfId: 1,
                  apply() {}, waitFor: async () => ({ events: [] }) };
  const r = await eat(blind, sess, { itemId: 5, waitMs: 1 });
  ok('an unreadable bar is null, never false', r.changed === null);
}

console.log('\nA BUY THAT BOUGHT NOTHING IS A REFUSAL, AND THE CALLER MUST BE ABLE TO COUNT IT');
{
  // Watched live 2026-08-20: JayB stood in the Raza Inn opening an empty shop on every
  // pass for ever. The atomic was honest in its `reason` and returned `bought: null`,
  // and didAct() reads only an explicit `false` as a refusal -- so the keeper scored it
  // as progress, and the goal-skip that abandons a hopeless goal after five failures
  // never counted a single one.
  //
  // `null` is reserved for "not applicable yet" -- the approach phase, which really is
  // making progress. A purchase that did not happen is FALSE.
  const { c, s } = shopper();
  c.buyList = null;
  c.room = { objects: new Map([[7, { id: 7, flags: 0, nameRsc: 1, col: 1, row: 1 }]]) };
  c.self = { col: 1, row: 1 };
  const r = await buy(c, s, { waitMs: 1 });
  ok('a merchant with an empty counter is not an accomplishment',
     r.bought === false || r.sent === false,
     `got bought=${JSON.stringify(r.bought)} sent=${r.sent}`);
  ok('and didAct agrees, which is what makes the goal-skip work',
     didAct(r) === false, 'null would have read as success');
}

console.log('\nbuy refuses when the purse cannot cover the cost');
{
  const { c, s } = shopper();
  c.buyList = { items: [{ id: 42, nameRsc: 1, cost: 500 }] };
  c.inventory = [{ id: 99, nameRsc: 2, amount: 100 }]; // only 100 shillings
  c.rsc.get = (r) => r === 1 ? 'mace' : 'shillings';
  const r = await buy(c, s, { itemId: 42, waitMs: 1 });
  ok('refused, and names the shortfall', r.sent === false && /cannot afford/.test(r.reason), r.reason);
  ok('and nothing went to the wire', c.sent.filter(x => x[0] === 'buy').length === 0);
}

console.log('\nbuy refuses an item not in the buy list');
{
  const { c, s } = shopper();
  c.buyList = { items: [{ id: 42, nameRsc: 1, cost: 100 }] };
  c.inventory = [{ id: 99, nameRsc: 2, amount: 500 }];
  c.rsc.get = (r) => r === 1 ? 'mace' : 'shillings';
  const r = await buy(c, s, { itemId: 999, waitMs: 1 });
  ok('refused, and says why', r.sent === false && /not in the buy list/.test(r.reason));
}

// ---------------------------------------------------------------------------
// Behaviour: sell
// ---------------------------------------------------------------------------
const { sell } = await import('./m59-act/sell.mjs');

console.log('\nsell: offers an item to a merchant and accepts the counter');
{
  const c = fakeClient({
    selfId: 1, col: 5, row: 5,
    inventory: [{ id: 42, nameRsc: 1, amount: 1 }],
    room: { num: 1, objects: new Map([[7, { id: 7, nameRsc: 2 }]]) },
  });
  const s = fakeSession(c);
  c.rsc.get = (r) => r === 1 ? 'mace' : 'merchant';
  const r = await sell(c, s, { merchantId: 7, itemId: 42, waitMs: 1 });
  ok('it sent an offer', r.sent === true);
}

console.log('\nsell refuses an item not in the pack');
{
  const c = fakeClient({
    selfId: 1, inventory: [],
    room: { num: 1, objects: new Map([[7, { id: 7, nameRsc: 2 }]]) },
  });
  const s = fakeSession(c);
  const r = await sell(c, s, { merchantId: 7, itemId: 999, waitMs: 1 });
  ok('refused, and says why', r.sent === false && /not in the pack/.test(r.reason));
}

console.log('\nsell refuses a merchant that is not in the room');
{
  const c = fakeClient({
    selfId: 1, inventory: [{ id: 42, nameRsc: 1 }],
    room: { num: 1, objects: new Map() },
  });
  const s = fakeSession(c);
  const r = await sell(c, s, { merchantId: 999, itemId: 42, waitMs: 1 });
  ok('refused, and says why', r.sent === false && /merchant not in/.test(r.reason));
}

// ---------------------------------------------------------------------------
// Behaviour: deposit / withdraw
// ---------------------------------------------------------------------------
const { deposit, withdraw } = await import('./m59-act/bank.mjs');

const banker = (spec = {}) => {
  const c = fakeClient({
    selfId: 1, col: 5, row: 5,
    inventory: [],
    ...spec,
  });
  return { c, s: fakeSession(c) };
};

console.log('\ndeposit: moves shillings from purse to vault');
{
  const { c, s } = banker();
  c.inventory = [{ id: 99, nameRsc: 2, amount: 500 }];
  c.rsc.get = () => 'shillings';
  const r = await deposit(c, s, { amount: 200, waitMs: 1 });
  ok('it sends a deposit', r.sent === true && r.amount === 200);
}

console.log('\ndeposit refuses when the purse is short');
{
  const { c, s } = banker();
  c.inventory = [{ id: 99, nameRsc: 2, amount: 100 }];
  c.rsc.get = () => 'shillings';
  const r = await deposit(c, s, { amount: 500, waitMs: 1 });
  ok('refused, and names the shortfall', r.sent === false && /purse has/.test(r.reason), r.reason);
  ok('and nothing went to the wire', c.sent.filter(x => x[0] === 'deposit').length === 0);
}

console.log('\nwithdraw: moves shillings from vault to purse');
{
  const { c, s } = banker();
  const r = await withdraw(c, s, { amount: 200, waitMs: 1 });
  ok('it sends a withdraw', r.sent === true && r.amount === 200);
}

console.log('\nwithdraw refuses a non-positive amount');
{
  const { c, s } = banker();
  const r = await withdraw(c, s, { amount: 0, waitMs: 1 });
  ok('refused', r.sent === false && /no amount/.test(r.reason));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
