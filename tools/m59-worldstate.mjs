#!/usr/bin/env node
// m59-worldstate.mjs -- THE CLOSED VOCABULARY A PLAN IS WRITTEN IN.
//
// GOAP is fast because the state is small. F.E.A.R. planned over a couple dozen
// symbols packed into a fixed struct and replanned continuously in microseconds;
// the search is cheap exactly as long as the vocabulary is finite and shared.
//
// Ours was neither. Symbols were invented per module as they were needed --
// `vigor_ok`, `loot_sold`, `gear_ok`, `armed`, `safe_spot_taken`, `at_mausoleum`,
// `at_room_<n>` -- with no registry, so nothing could check that an action's
// precondition was a fact any other action produced. A plan could be unsatisfiable
// for the dullest possible reason, a typo, and the planner would report only that
// it found no plan.
//
// That failure has a precedent here worth naming: `policy.purpose` was absent from
// the autopilot tool's schema for a year, so every keeper ran with `purpose: null`
// and the yield audit -- the check that says a character is killing things worth
// nothing -- silently never ran. A name nothing validates is a name that can be
// wrong for ever.
//
// So: one registry, one producer per symbol, and an unknown answer that fails in
// the safe direction rather than the convenient one.
//
// ── THE THREE RULES ─────────────────────────────────────────────────────────
//
//   1. CLOSED SET. An atomic declaring a `pre` or `effect` outside SYMBOLS is a
//      test failure (see validate()). Not a runtime surprise, not a silent no-op.
//
//   2. ONE PRODUCER EACH. Every symbol is computed in exactly one place, here,
//      from client/party/policy state. A quantity with two homes in this
//      repository has always ended up with two answers -- the engagement ceiling
//      had four copies, and the second answer to that one is a dead character.
//
//   3. UNKNOWN FAILS SAFE, PER SYMBOL. There is no single safe default, because
//      the safe direction depends on the question. `armed` unknown must read TRUE
//      (a failed inventory read must not stop the fleet fighting); `target_in_band`
//      unknown must read FALSE (a ceiling that defaults open is the one that kills
//      somebody). Each symbol states its own, with the reason.
//
// Offline, pure, no I/O: every producer reads state the server has already PUSHED
// (health, stats and the use list all arrive unasked), so evaluating the whole
// vocabulary is a handful of cache reads and can happen every tick.

import * as skills from './m59-skills.mjs';
import * as party  from './m59-party.mjs';
import { REST_VIGOR_CAP, MIN_FIGHT_VIGOR } from './m59-localpolicy.mjs';
import { affordances } from './m59-parse.mjs';
import { preyNames, creatureKey } from './m59-combat.mjs';

// Melee reach is a disc on SQUARE coordinates -- both sides run
// `SquaredDistanceTo <= GetAttackRange^2` where range is Bound(2 + difficulty/6, 2, 3)
// for a monster (monster.kod:1682) and 2-3 by weapon type for us (weapon.kod:52).
// Fine coordinates are read by nothing but the drawing code (MonsterOrient,
// monster.kod:2189), so there is nothing finer than a square to stand on.
// What counts as a weapon for the surplus test. Deliberately narrow: the point is to shed
// the pile of identical drops a farming character accumulates, not to judge gear.
const WEAPON_RE = /\b(mace|sword|axe|hammer|dagger|club|staff|halberd|spear|flail|scimitar|rapier)\b/i;

// How close an aggroed creature has to be to count as being ON us. A little beyond melee,
// because something one step outside reach this instant is inside it on the next.
// blink.kod:41 viSpellExertion, and player.kod's HasVigor wants STRICTLY more than it.
const BLINK_EXERTION = 20;

// BOTH HALVES OF BLINK'S PRICE ARE SPECIFIC, and neither is the generic cast floor.
// `blink.kod:40 viMana = 15` against `MIN_CAST_MANA = 10`, which is `create food`'s
// price and the only cost the wire carries. So a character with 10-14 mana passes
// `has_mana`, asks for a blink the server refuses (spell.kod:604, a SENTENCE and not
// a wire error), and asks again on the next tick having spent nothing and learned
// nothing. Ground the escape on what the escape actually costs.
const BLINK_MANA = 15;

// `create weapon`, the only way an empty-handed character with an empty purse ever holds
// a weapon again. creaweap.kod:41. Same price as blink, and for the same reason it has to
// be named rather than folded into the generic cast floor: MIN_CAST_MANA is `create food`.
const CREATE_WEAPON_MANA = 15;

// The fraction of health below which a character stops PICKING fights (it may still finish
// one it is already in). Deliberately well above fleeBelow: the flee line is where you run,
// and choosing a fight from just above it is choosing to run almost immediately. Override
// with policy.engageAbove.
const DEFAULT_ENGAGE_ABOVE = 0.6;

const OUTNUMBERED_RANGE = 4;

export const MELEE_REACH = 3;

// `create food`, the spell this fleet lives on. The wire carries no per-spell cost,
// so this is a floor for "could cast something ordinary" rather than a price.
export const MIN_CAST_MANA = 10;

export const FOOD_RE = /\bsnack\b|\bfood\b|\bpastry\b|\bpie\b|\bbread\b|\bmeat\b|\bmushroom\b|\bapple\b/i;

const frac = (v) => (v?.max ? v.value / v.max : null);

// `create food` costs 2 elderberry AND 2 herbs, so what a character can actually
// cast is min(elder, herb)/2 and the FLEET TOTAL cannot say so: measured once at
// 61 elderberry and 160 herbs across twenty-one characters, of whom twenty could
// cast zero times, because the herb-rich were standing next to the elderberry-rich.
// Always the per-character minimum, never the sum.
function reagentPairs(c) {
  let elder = 0, herbs = 0;
  for (const o of c?.inventory ?? []) {
    const n = String(o.name ?? c.rsc?.get?.(o.nameRsc) ?? '').toLowerCase();
    const amt = o.amount ?? 1;
    if (/\belderberry\b/.test(n)) elder += amt;
    if (/\bherbs?\b/.test(n))     herbs += amt;
  }
  return Math.min(elder, herbs);
}

/**
 * ctx: { client, session, policy, agent }
 * Every producer returns true | false | null, where null means "cannot tell" and
 * is resolved by that symbol's own `whenUnknown`.
 */
export const SYMBOLS = {
  // ── body ──────────────────────────────────────────────────────────────────
  armed: {
    describe: 'a weapon is in the server\'s use list',
    whenUnknown: true,
    why_unknown: 'a failed read must not idle the fleet; the guard catches the empty ' +
                 'hand, it is not a new way to stop',
    produce: ({ client }) => (client ? skills.isArmed(client) : null),
  },

  healthy: {
    describe: 'at or above the health we would START a fight at',
    whenUnknown: false,
    why_unknown: 'opening a fight on an unreadable health bar is the one that kills',
    produce: ({ client, policy }) => {
      const f = frac(client?.vitals?.()?.health);
      if (f == null) return null;
      return f >= (policy?.engageAt ?? policy?.restBelow ?? 0.75);
    },
  },

  hurt: {
    describe: 'below restBelow — should be recovering rather than working',
    whenUnknown: true,
    why_unknown: 'treating an unreadable bar as hurt costs a rest; the other way costs a death',
    produce: ({ client, policy }) => {
      const f = frac(client?.vitals?.()?.health);
      if (f == null) return null;
      return f < (policy?.restBelow ?? 0.7);
    },
  },

  critical: {
    describe: 'HP is critically low — running away from anything, even safe targets',
    whenUnknown: true,
    why_unknown: 'unreadable HP must not trigger a panic flee',
    produce: ({ client, policy }) => {
      const f = frac(client?.vitals?.()?.health);
      if (f == null) return null;
      return f < (policy?.criticalHp ?? 0.3);
    },
  },

  // BELOW FLEE — the HP line at which a character should RUN from an in-reach
  // target. Distinct from `hurt` (below restBelow, ~70%, which also drives resting):
  // resting is a calm recovery and can start early, but FLEEING abandons a fight, so
  // it must wait until HP is genuinely dangerous. A 70% flee meant a character dropped
  // to 69% against a weak mummy and ran off to another room instead of finishing it —
  // which is the opposite of what we want. 50% is the line: a fight can be fought down
  // to half HP, but below that the risk of dying (and dropping max HP, a death spiral)
  // outweighs the loot.
  below_flee: {
    describe: 'below the flee line (~50% HP) — a fight should be abandoned, not just rested',
    whenUnknown: false,
    why_unknown: 'an unreadable HP bar must not send a character fleeing on no evidence',
    produce: ({ client, policy }) => {
      const f = frac(client?.vitals?.()?.health);
      if (f == null) return null;
      return f < (policy?.fleeBelow ?? 0.5);
    },
  },

  vigor_rested: {
    describe: 'vigor is at the rest cap (>= 80) — rested as far as sitting can take it',
    whenUnknown: false,
    why_unknown: 'unreadable vigor must not gate rest by default',
    produce: ({ client }) => {
      const v = client?.vitals?.()?.vigor?.value;
      return v == null ? null : v >= REST_VIGOR_CAP;
    },
  },

  vigor_ok: {
    describe: 'vigor is high enough to start a fight',
    // CORRECTED BY THE FIRST LIVE RUN, AND THE ONLY SYMBOL A LIVE RUN HAS MOVED.
    //
    // This was `true`, on the reasoning that it was "same as armed: a failed read
    // must not park a healthy character". That reasoning is wrong, and the first
    // character ever pointed at showed why: vitals() carried health and mana and NO
    // VIGOR AT ALL — vigor arrives as a BP_STAT and simply had not, which is an
    // ordinary condition and not a fault. So `vigor_ok` read true on no evidence,
    // the goal { vigor_ok: true } was already satisfied, the plan came back EMPTY,
    // and a hungry character would never have eaten.
    //
    // The asymmetry is the opposite of armed's. Wrong in the `true` direction: the
    // character never provisions and fights tired, and deaths per thousand
    // observations run 75.7 below 85 vigor against 12.4 above 160 — six-fold. Wrong
    // in the `false` direction: it eats when it did not need to, costing one cast,
    // two elderberry and two herbs.
    //
    // Being wrong about ARMED stops a fight already happening. Being wrong about
    // VIGOR only prevents a meal. Those are not the same kind of consequence, and
    // reasoning by analogy from one to the other is what put this the wrong way up.
    whenUnknown: false,
    why_unknown: 'unreadable vigor must not satisfy a provisioning goal by default: ' +
                 'a wrong `false` costs a meal, a wrong `true` costs a character',
    produce: ({ client, policy }) => {
      const v = client?.vitals?.()?.vigor?.value;
      if (v == null) return null;
      // MIN_FIGHT_VIGOR (100) sits ABOVE REST_VIGOR_CAP (80) on purpose: resting
      // stops awarding vigor at 80 of 200, so everything above it has to be EATEN.
      // The two are not the ends of a quiet middle band and no setting clears both.
      return v >= (policy?.fightAboveVigor ?? MIN_FIGHT_VIGOR);
    },
  },

  // THE NEWBIE ZONE, AND WHETHER IT STILL PAYS.
  //
  // Raza is rooms 1011-1018 and there is NO door out: every map exit leads back inside and the
  // eleven unresolved ones are locked. The way out is the portal in the Grand Museum (1018) at
  // (11,2), touched TWICE — the first touch warns and bounces you back. It is one-way.
  //
  // It stops paying at max health 25. Advancement needs monster_level > base_max_health and the
  // only thing Raza generates is the level-25 mummy, so from 25 onward a character can farm the
  // whole zone for ever and gain nothing — which is exactly what JayB was doing.
  // IS HEALTH GOING DOWN? The one signal that is always true when something is hitting us,
  // whatever the wire says about it. Net loss over the window rather than any single dip, so
  // a rest tick or a heal does not mask an attack and one unlucky sample does not invent one.
  // Shared by `under_attack` and `outnumbered` so the two can never disagree about it.
  // (Defined as a module function below the table; hoisted, so the order here is free.)
  // MORE THAN ONE THING IS ON US.
  //
  // A character trades blows with one creature and wins or loses on arithmetic. Two or more
  // at once is a different fight: the incoming rate doubles while the outgoing does not, and
  // the flee thresholds — which are fractions of health — are calibrated for the first case.
  // Counting only AGGROED creatures (OF.ENEMY) matters: a room with six rats standing about
  // is not the same as three of them hitting you, and only the flag tells them apart.
  //
  // Prey only, so the merchant exclusion keeps shopkeepers out of the tally.
  // SOMETHING IS HITTING US, AND THE FLAGS WILL NOT TELL YOU.
  //
  // Every flee rule we had was gated on has_target or OF.ENEMY. JayB's first recorded death
  // shows why that fails: hp_trail [16,13,14,11,12,9,4,3] — ground down over eight samples
  // with time to react — while last_target was null and engaged_by was 0. He was being beaten
  // by creatures he was not fighting, and every rule that could have saved him asked a
  // question whose answer was no.
  //
  // The flags cannot be trusted for this: read live in a room with a live NPC in it, EVERY
  // object came back flags=0x0. Health going down is the one signal that is always true when
  // something is hitting you, whatever the wire says about it.
  //
  // Net loss over the window, not any single dip, so that a rest tick or a heal does not mask
  // an attack and a single unlucky sample does not invent one.
  under_attack: {
    describe: 'health has fallen over the last few samples — something is hitting us',
    whenUnknown: false,
    why_unknown: 'an unreadable health bar must not invent an attack',
    produce: ({ client, session }) => {
      const v = client?.vitals?.()?.health?.value;
      if (v == null) return null;
      return healthFalling(session);
    },
  },

  // OF.ENEMY IS "ENEMY PLAYER", AND A SPIDER IS NOT A PLAYER.
  //
  //     include/proto.h:405   #define OF_ENEMY   0x02000000   // Enemy player
  //
  // It is a guild-war relationship, which the client uses for nothing but the colour of a
  // dot on the minimap (clientd3d/map.c:452). No monster has ever carried it, so this rule
  // — "two or more AGGROED creatures" — could not become true no matter what was happening
  // in the room, and the multi-attacker flee has never fired once since it was written.
  //
  // The note on `under_attack` above had already found the flags were untrustworthy and
  // reached for the health bar instead; this rule was left behind on the flag. So use the
  // two signals that are real: how many prey-class creatures are within striking distance,
  // and whether health is actually going down. Proximity alone would call a room of six
  // idle rats an ambush; damage alone cannot tell one attacker from three. Together they
  // mean what the rule always said it meant.
  // A FLEE ALREADY UNDER WAY. Set by the decider when a flee goal wins; read back here so
  // the ladder can hold it against the sampling noise in the conditions that started it.
  // Reading session state is what `under_attack` does with the health trail, and for the
  // same reason: the fact is about a span of time, not about this instant.
  fleeing: {
    describe: 'a flee is already under way and has not run out or been resolved',
    whenUnknown: false,
    why_unknown: 'never invent a flee — a wrong true walks a healthy character out of a fight it was winning',
    produce: ({ session, client }) => {
      const until = session?._fleeUntil ?? 0;
      if (!until || Date.now() > until) return false;
      // A DIFFERENT ROOM IS THE ONLY THING THAT RELIABLY MEANS SAFETY, and it ends the
      // commitment early rather than making the character run out the clock somewhere it
      // has already got away to.
      const room = client?.room?.id ?? client?.room?.num ?? null;
      if (session._fleeRoom != null && room != null && room !== session._fleeRoom) return false;
      return true;
    },
  },

  // CAN WE ACTUALLY PAY FOR A BLINK? MANA IS ONLY HALF THE PRICE.
  //
  //   spell.kod:604   if (NOT Send(who,@HasVigor,#amount=viSpellExertion)) AND vbCheck_Exertion
  //                   { MsgSendUser(spell_too_tired); return FALSE; }
  //   player.kod:1354 HasVigor(amount): return piVigor > amount        (strictly greater)
  //   blink.kod:41    viSpellExertion = 20
  //
  // And the refusal is a SENTENCE — "You are too tired to cast %s!" — spoken to the user,
  // not an error on the wire. Nothing fails, mana does not move, and from outside it looks
  // exactly like a cast that was sent and ignored.
  //
  // This exists because `unwedge` sits near the top of the goal ladder and outranks rest.
  // An entombed character with mana but no vigor therefore asked for a blink it could never
  // pay for, for ever, and could never rest to earn the vigor — Lee sat at (28,35) in the
  // Deep Forest of Farol at 19/19 mana and vigor 4, genuinely entombed, doing exactly that.
  // The same trap was found once before with mana at zero and fixed by adding `has_mana`;
  // this is the other half of the same price.
  //
  // Unknown vigor answers TRUE: an unreadable vital must not be what keeps a body buried,
  // and the cast throttle bounds what a wrong true costs to one refused packet every 12s.
  // STARTING A FIGHT AND CONTINUING ONE DESERVE DIFFERENT BARS.
  //
  // Every health threshold here was a DISENGAGE threshold — below_flee, critical — and the
  // decision to walk across a room and pick a fight was made against the same numbers, or
  // against nothing at all. With fleeBelow at 0.4 and max health 20, that meant a character
  // would happily close on a fresh giant rat at 9 HP.
  //
  // The damage rate is what makes that indefensible. Measured on three consecutive deaths,
  // the last few samples before dying:
  //
  //     [19,20,19,20,17,15,10,2]      [18,19,20,18,14,11,4,5]      [17,18,19,17,13,8,5,6]
  //
  // Five to eight points per sample — 11 to 4 in one. A flee line at 8 is a decision made
  // one exchange from death, and no amount of fixing the ESCAPE helps a character that
  // chose the fight from there.
  //
  // So: engaging needs headroom, not merely a pulse. Continuing does not — walking away
  // from something already swinging at you is worse than finishing it, which is why the
  // flee rungs ask for in_reach.
  fit_to_engage: {
    describe: 'healthy enough to START a fight, which is a higher bar than continuing one',
    whenUnknown: true,
    why_unknown: 'an unreadable health bar must not stop a character working; the flee ladder still guards it',
    produce: ({ client, policy }) => {
      const h = client?.vitals?.()?.health;
      if (h?.value == null || !h?.max) return null;
      return (h.value / h.max) >= (policy?.engageAbove ?? DEFAULT_ENGAGE_ABOVE);
    },
  },

  can_pay_blink: {
    describe: 'vigor AND mana both cover blink\'s price, so the server will not refuse the cast',
    whenUnknown: true,
    why_unknown: 'an unreadable vital must not be what keeps an entombed character buried',
    produce: ({ client }) => {
      const vit = client?.vitals?.();
      const v = vit?.vigor?.value;
      const m = vit?.mana?.value;
      // `HasVigor` is strictly greater (player.kod:1354); the mana check is a plain
      // sufficiency. An unreadable half abstains rather than refusing -- whenUnknown
      // is true here for the reason above, and a wrong true costs one refused packet.
      if (v != null && !(v > BLINK_EXERTION)) return false;
      if (m != null && m < BLINK_MANA) return false;
      if (v == null && m == null) return null;
      return true;
    },
  },

  outnumbered: {
    describe: 'two or more creatures are within striking distance while health is falling',
    whenUnknown: false,
    why_unknown: 'a wrong true throws away a winnable fight; a wrong false only costs what it already cost',
    produce: ({ client, session }) => {
      const objs = client?.room?.objects;
      const me = client?.self;
      if (!(objs instanceof Map) || me?.col == null) return null;
      if (!healthFalling(session)) return false;
      let n = 0;
      for (const o of objs.values()) {
        if (o.is_self || o.col == null) continue;
        const nm = String(client?.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
        if (!preyNames().has(creatureKey(nm))) continue;
        if (Math.hypot(o.col - me.col, o.row - me.row) > OUTNUMBERED_RANGE) continue;
        if (++n >= 2) return true;
      }
      return false;
    },
  },

  // ENTOMBED: THE BODY CANNOT MOVE IN ANY DIRECTION.
  //
  // Not "blocked toward the target" — blocked EVERYWHERE. A character that has ended up inside
  // geometry has no leaf, no floor, and no legal step, and nothing in the walking model can
  // help it: sliding, side-steps, escape fans and raw moves all need one direction to work.
  //
  // Measured on JayB at (30,47) in the Deep Forest of Farol: leaf NULL, floor null, zero of
  // eight directions passable, for hours, while the dashboard read "travel moving -> 535". A
  // blink relocated him to (50,7) — leaf present, floor 2048, eight of eight directions — and
  // that is the only thing that worked.
  //
  // Deliberately expensive and deliberately rare: eight short traces, and only ever consulted
  // by the goal that casts blink.
  entombed: {
    describe: 'the body cannot take a legal step in any of the eight directions',
    whenUnknown: false,
    why_unknown: 'never claim a character is entombed on an unreadable position — blink is one-way and costs mana',
    // ASK THE THING THAT ACTUALLY MOVES HIM. This used to trace `traceFineMoveClient`
    // from the CENTRE of the occupied square — a point the body is not standing on and
    // may not be able to stand on. When that fabricated origin lands inside geometry
    // every one of the eight traces fails from the first microstep, and the predicate
    // reports a sealed tomb around a character who can walk.
    //
    // JayB, 2026-08-27, r587 (30,14): `entombed` said 0/8 while `moverStepLands` — the
    // validator the mover enforces on every step — said four neighbours were reachable
    // ((29,13), (30,13), (31,13), (31,14)). He sat there casting blink at a wall that
    // was not there, and because `unwedge` outranks hunting he did nothing else for
    // hours. Same fixed-point bug as `_advanceSubLeg` planning from the lagging frame.
    //
    // This is the routing rule in the same words as `docs/m59-routing.md`: plan on the
    // map the mover enforces. A tomb nobody but a synthetic origin can see is not a tomb.
    produce: ({ client, session }) => {
      const geo = session?.world?.geometry;
      const me = client?.self;
      if (!me || me.col == null || me.row == null) return null;
      if (typeof geo?.moverStepLands !== 'function') return null;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          try {
            if (geo.moverStepLands(me.row, me.col, me.row + dr, me.col + dc)) return false;
          } catch { /* a throwing direction is not a passable one */ }
        }
      }
      return true;
    },
  },

  in_raza: {
    describe: 'inside the newbie zone (rooms 1011-1018)',
    whenUnknown: false,
    why_unknown: 'an unreadable room must not send anybody through a one-way portal',
    // THE MAP NUMBER, NOT THE OBJECT ID. `client.room.id` is the room OBJECT's id (1511 for
    // The Sweet Grass Prairies, whose map number is 557), so comparing it against 1011-1018
    // silently answers about the wrong rooms — and whenUnknown:false then reads as "not in
    // Raza" for a character standing in it. The session's world carries the resolved number.
    produce: ({ client, session }) => {
      const n = Number(session?.world?.room?.num ?? client?.room?.num);
      return Number.isFinite(n) ? (n >= 1011 && n <= 1018) : null;
    },
  },

  raza_outgrown: {
    describe: 'max health has reached 25, so the newbie zone can no longer pay anything',
    whenUnknown: false,
    why_unknown: 'do not graduate a character on an unreadable health bar',
    produce: ({ client }) => {
      const max = client?.vitals?.()?.health?.max;
      return max == null ? null : max >= 25;
    },
  },

  vigor_floor: {
    describe: 'vigor is above the minimum for effective combat (>= 20)',
    whenUnknown: false,
    why_unknown: 'unreadable vigor must not gate combat by default',
    produce: ({ client }) => {
      const v = client?.vitals?.()?.vigor?.value;
      return v == null ? null : v >= 20;
    },
  },

  vigor_comfortable: {
    describe: 'vigor is high enough that fighting now is safe — above the ideal fight threshold',
    whenUnknown: true,
    why_unknown: 'unreadable vigor must not suppress a fight by default',
    produce: ({ client, policy }) => {
      const v = client?.vitals?.()?.vigor?.value;
      if (v == null) return null;
      return v >= (policy?.idealFightVigor ?? 100);
    },
  },

  can_rest_higher: {
    describe: 'resting could still raise vigor — i.e. we are under the resting cap',
    whenUnknown: false,
    why_unknown: 'if we cannot tell, do not sit down expecting a gain that cannot come',
    produce: ({ client }) => {
      const v = client?.vitals?.()?.vigor?.value;
      return v == null ? null : v < REST_VIGOR_CAP;
    },
  },

  // ── pack and supply ───────────────────────────────────────────────────────
  has_reagents: {
    describe: 'at least one casting of create food (2 elderberry AND 2 herbs)',
    whenUnknown: false,
    why_unknown: 'planning a cast we cannot pay for wastes the pass and the walk',
    produce: ({ client }) => (client?.inventory ? reagentPairs(client) >= 2 : null),
  },

  has_mana: {
    describe: 'mana enough for an ordinary spell',
    whenUnknown: false,
    why_unknown: 'planning a cast we cannot pay for wastes the pass and the walk',
    produce: ({ client, policy }) => {
      const m = client?.vitals?.()?.mana?.value;
      if (m == null) return null;
      // THE WIRE DOES NOT CARRY A PER-SPELL COST, so this is a floor rather than a
      // price. 10 is `create food`, the spell this fleet actually lives on. A
      // planner wanting a specific spell grounds its own cost (see groundedCast).
      //
      // And note the ceiling is not stored either: piMax_Mana is declared at 20 and
      // ComputeMaxMana (player.kod:6116) THROWS IT AWAY and rebuilds it from
      // 15 + mysticism/5 plus nodes, worn items and enchantments, on login and on
      // every equipment change. So a character set to 200 reads 200 until it relogs
      // and comes back at 25 -- never cache a max mana.
      return m >= (policy?.minCastMana ?? MIN_CAST_MANA);
    },
  },

  has_food: {
    describe: 'something edible in the pack',
    whenUnknown: false,
    why_unknown: 'believing in food we cannot see sends a character to fight hungry',
    produce: ({ client }) => {
      if (!client?.inventory) return null;
      return client.inventory.some(o =>
        FOOD_RE.test(String(o.name ?? client.rsc?.get?.(o.nameRsc) ?? '')));
    },
  },

  pack_room: {
    describe: 'room for one more ordinary item',
    whenUnknown: true,
    why_unknown: 'refusing to loot on an unread pack is a silent, permanent no',
    produce: ({ client }) => {
      if (!client?.inventory) return null;
      // A pack is limited by weight AND bulk and is full when EITHER is reached
      // (holder.kod:259 -> :281), so fullness is the WORSE of the two fractions.
      // There is no stack-count limit; a character that cannot receive is nearly
      // always simply full, and the fix is shedding the heaviest stacks.
      try { return skills.wouldFit(client, 1, 1); } catch { return null; }
    },
  },

  // ── target ────────────────────────────────────────────────────────────────
  has_target: {
    describe: 'a target is selected and still present in room contents',
    whenUnknown: false,
    why_unknown: 'no evidence of a target is not a target',
    produce: ({ client, ws }) => {
      const id = ws?._targetId;
      if (id == null) return false;
      return !!client?.room?.objects?.has?.(id);
    },
  },

  in_reach: {
    describe: 'the selected target is inside melee reach',
    whenUnknown: false,
    why_unknown: 'swinging at nothing is free for the server and costs us the round',
    produce: ({ client, ws }) => {
      const id = ws?._targetId;
      const me = client?.self;
      const t  = id == null ? null : client?.room?.objects?.get?.(id);
      if (!me || !t || t.col == null || me.col == null) return null;
      // SQUARED distance on square coordinates -- the server's own test.
      const d2 = (t.col - me.col) ** 2 + (t.row - me.row) ** 2;
      return d2 <= MELEE_REACH ** 2;
    },
  },

  target_in_band: {
    describe: 'the target is at or under the engagement ceiling',
    whenUnknown: false,
    why_unknown: 'A CEILING THAT DEFAULTS OPEN IS THE ONE THAT KILLS SOMEBODY. ' +
                 'threatCeiling() returns null on unknown max health and every caller ' +
                 'reads null as refuse; this is that rule, in the vocabulary',
    produce: ({ ws }) => (ws?._targetLevel == null || ws?._threatCeiling == null
      ? null : ws._targetLevel <= ws._threatCeiling),
  },

  // ── party ─────────────────────────────────────────────────────────────────
  mate_present: {
    describe: 'our partner is in this room',
    whenUnknown: false,
    why_unknown: 'two characters in different rooms are not a party, they are two solo ones',
    produce: ({ agent, client }) => (agent
      ? party.together(agent, client?.room?.num ?? null) : null),
  },

  mate_hurt: {
    describe: 'our partner is below the heal threshold',
    whenUnknown: false,
    why_unknown: 'healing on no evidence spends reagents and a round for nothing',
    produce: ({ agent, policy }) => {
      if (!agent) return null;
      const m = party.mateOf(agent);
      if (!m || m.health == null || m.max_health == null) return null;
      return (m.health / m.max_health) < (policy?.partyHealBelow ?? 0.5);
    },
  },

  has_money: {
    describe: 'the purse holds at least the walking-money floor',
    whenUnknown: false,
    why_unknown: 'a wrong false just delays a buy; a wrong true spends money the character needs to survive the walk home',
    produce: ({ client, policy }) => {
      const purse = (client?.inventory ?? [])
        .filter(o => {
          const name = client?.rsc?.get?.(o.nameRsc) ?? o.name ?? o.nameRsc ?? '';
          return /shilling/i.test(name);
        })
        .reduce((t, o) => t + (o.amount || 1), 0);
      // AN EMPTY PACK IS AN ANSWER, ONCE THE PACK HAS BEEN READ.
      //
      // This returned `null` for any empty list, which conflates "the INVENTORY packet has
      // not arrived" with "this character is carrying nothing" -- and the second is the
      // state every character is in the moment after it dies, because everything it owned
      // is on the floor where it fell. Unknown money keeps `buy` plannable (its `pre` is
      // ['has_money','at_shop']), so a penniless character planned a purchase it could
      // never make, every tick, for ever.
      //
      // Sasquatch, 2026-08-27: empty pack, no shillings, `armed -> buy (buy weapon)` and
      // `buy in flight` alternating in his log while `cast create weapon` -- which he
      // knows, and which the planner already carries as `{ pre: [], effects: ['armed'] }`
      // -- sat unused behind `buy`'s earlier insertion order.
      if (!client?.inventoryKnown && !client?.inventory?.length) return null;
      return purse >= (policy?.walkingMoney ?? 100);
    },
  },

  // SURPLUS WEAPONS AND SURPLUS MONEY — the two things a farming character accumulates and
  // the tick keeper had no way to shed. JayB was carrying SEVENTEEN maces against a policy of
  // two, and 1,020 shillings against a bank floor of 500, in a pack of 26 entries against a
  // maxCarry of 14. A pack that cannot receive cannot loot.
  // CAN WE ACTUALLY GET ARMED, or is being unarmed simply the situation?
  //
  // The `armed` goal outranks `_fight`, which is right when a weapon is obtainable — a
  // character with a mace in the pack should wield it before swinging. It is a TRAP when it
  // is not: Lee died, death drops everything, and he woke with an empty pack and an empty
  // purse. `armed` fired for ever, planned a purchase he could not afford, and never fell
  // through to fighting — so he could not earn the money that would end the loop.
  //
  // Fists are a real option here. The hunt band is explicitly halved when unarmed
  // (floor(level/4) against floor(level/2)) and skills.sellAll says as much: "you will fight
  // with your fists". So `armed` should only outrank fighting while it can be satisfied.
  can_arm: {
    describe: 'a weapon can be had: one in the pack, money to buy one, or the mana to conjure one',
    whenUnknown: true,
    why_unknown: 'if we cannot tell, try to arm — the cost of a wasted trip is smaller than the cost of punching everything',
    // A THIRD WAY TO GET A WEAPON, AND THE ONLY ONE A CORPSE HAS.
    //
    // This asked two questions -- is there a weapon in the pack, is there money -- and a
    // character that has just died has neither: everything it owned is on the floor where
    // it fell. `can_arm` then answered false, the `armed` goal is gated on it, and the
    // character was left unarmed for ever. Unarmed halves the hunt band (floor(level/4)
    // against floor(level/2)), so it also stops finding anything worth fighting, which is
    // how it stops earning the money that was the only route out. A closed loop.
    //
    // Sasquatch, 2026-08-27: empty pack, no purse, 20/20 health, and `create weapon` in
    // his spell list with 21 mana against its cost of 15 (creaweap.kod:41). He could have
    // armed himself at any point in nine hours and was never asked to. Zero kills all day.
    //
    // The conjure is checked LAST because it is the most expensive of the three and the
    // only one that can fail on the wire, and its mana bar is read the way blink's is --
    // an unreadable one abstains rather than claiming the character is helpless.
    produce: ({ client }) => {
      const inv = client?.inventory;
      if (!Array.isArray(inv)) return null;
      let purse = 0;
      for (const o of inv) {
        const name = String(client?.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
        if (/shilling/i.test(name)) { purse += (o.amount || 1); continue; }
        if (WEAPON_RE.test(name)) return true;      // something to wield already
      }
      if (purse > 0) return true;                   // no weapon, but something to spend
      // Nothing to wield and nothing to spend: can we make one?
      const spells = client?.spells;
      if (!Array.isArray(spells)) return false;
      const knows = spells.some(sp =>
        String(client?.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '').toLowerCase() === 'create weapon');
      if (!knows) return false;
      const mana = client?.vitals?.()?.mana?.value;
      if (mana == null) return true;                // unreadable bar does not condemn him
      return mana >= CREATE_WEAPON_MANA;
    },
  },

  over_weapons: {
    describe: 'the pack holds more weapons than the loadout allows',
    whenUnknown: false,
    why_unknown: 'a wrong true sends a character to a smith for nothing; a wrong false only delays it',
    produce: ({ client, policy }) => {
      const inv = client?.inventory;
      if (!Array.isArray(inv) || !inv.length) return null;
      const max = policy?.maxWeapons;
      if (!Number.isFinite(max)) return false;
      const n = inv.filter(o => {
        const name = String(client?.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
        return WEAPON_RE.test(name);
      }).length;
      return n > max;
    },
  },

  purse_heavy: {
    describe: 'the purse is above the bank floor — the excess belongs in an account',
    whenUnknown: false,
    why_unknown: 'a wrong true walks a character to a bank for nothing',
    produce: ({ client, policy }) => {
      const inv = client?.inventory;
      if (!Array.isArray(inv) || !inv.length) return null;
      const floor = policy?.bankAbove;
      if (!Number.isFinite(floor)) return false;
      const purse = inv
        .filter(o => /shilling/i.test(String(client?.rsc?.get?.(o.nameRsc) ?? o.name ?? '')))
        .reduce((t, o) => t + (o.amount || 1), 0);
      return purse > floor;
    },
  },

  at_shop: {
    describe: 'a merchant with a buy list is in the current room, or the room is a known shop type',
    whenUnknown: false,
    why_unknown: 'no merchant visible, no buy; a wrong true just wastes a turn',
    produce: ({ client }) => {
      // First: check for a merchant with a buy list in the room objects.
      // Raw objects have o.flags, not o.can — derive via affordances().
      const objects = client?.room?.objects;
      if (objects) {
        const list = objects instanceof Map ? [...objects.values()] : Array.isArray(objects) ? objects : [];
        if (list.some(o => affordances(o.flags ?? 0).includes('buy')))
          return true;
      }
      // Fallback: the room name matches a shop type. This covers
      // the case where the merchant hasn't been published yet (timing)
      // or the room has a vendor that doesn't advertise 'buy'.
      // Resolve the room name via RSC — client.room.name is an RSC id, not a string.
      const roomName = client?.rsc?.get?.(client?.roomNameRsc) ?? client?.room?.name ?? '';
      const SHOP_ROOM_RE = /inn|tavern|shop|store|market|apothecary|smith|armourer|jeweller|bank|pawn|general/i;
      return typeof roomName === 'string' && SHOP_ROOM_RE.test(roomName);
    },
  },

  at_bank: {
    describe: 'a banker is in the current room, or the room is a known bank',
    whenUnknown: false,
    why_unknown: 'no banker visible, no withdraw; a wrong true just wastes a turn',
    produce: ({ client }) => {
      // Check for a banker object in the room. Bankers have the
      // 'bank' affordance (or we check by name).
      const objects = client?.room?.objects;
      if (objects) {
        const list = objects instanceof Map ? [...objects.values()] : Array.isArray(objects) ? objects : [];
        if (list.some(o => {
          const name = client?.rsc?.get?.(o.nameRsc) ?? '';
          return /banker|bank/i.test(name);
        }))
          return true;
      }
      // Fallback: room name matches a bank type.
      const roomName = client?.rsc?.get?.(client?.roomNameRsc) ?? client?.room?.name ?? '';
      return typeof roomName === 'string' && /bank/i.test(roomName);
    },
  },

  in_underworld: {
    describe: 'the character is in the Underworld (dead, needs to escape)',
    whenUnknown: false,
    why_unknown: 'a wrong false in the Underworld means the character tries to farm in a room with no exits',
    produce: ({ client }) => {
      // The client's room name comes from roomNameRsc -> rsc.get(),
      // not from room.name (which doesn't exist). The room id is
      // room.id. Room 6 is the Underworld.
      const name = client?.roomNameRsc
        ? (client.rsc?.get?.(client.roomNameRsc) ?? '')
        : '';
      const id = client?.room?.id;
      return /underworld/i.test(name) || id === 6;
    },
  },

  _fight: {
    describe: 'no hostile target in reach that should be killed (fight satisfied)',
    whenUnknown: true,
    why_unknown: 'a wrong true means the character ignores a mummy standing next to it',
    produce: () => true, // default: no fight needed; keeper sets _fight=false in ws
  },

  flee_danger: {
    describe: 'no out-of-band hostile in the room (safe to stay)',
    whenUnknown: true,
    why_unknown: 'a wrong true means the character stays in a room with a deadly mob',
    produce: () => true, // default: safe; keeper sets flee_danger=false when out-of-band target present
  },

  has_loot: {
    describe: 'the pack has items that are not food, money, or reagents (sellable loot)',
    whenUnknown: false,
    why_unknown: 'a wrong false just delays a sell trip; a wrong true wastes a walk to a shop',
    produce: ({ client }) => {
      const inv = client?.inventory;
      if (!Array.isArray(inv) || !inv.length) return false;
      return inv.some(o => {
        const name = client?.rsc?.get?.(o.nameRsc) ?? o.name ?? o.nameRsc ?? '';
        const lower = name.toLowerCase();
        if (/shilling|gold|silver|copper/i.test(lower)) return false;
        if (/bread|cheese|stew|apple|peach|bun|cake|pie|porridge|rice|meat|fish|salad|egg|ham|bacon|sausage|roast|kebab|bowl|plate|loaf|torta|pasta|noodles|sushi|burger|sandwich|pizza|dough|flour|milk|juice|water|beer|wine|ale|cider|potion|drink|food/i.test(lower)) return false;
        if (/elderberry|herb|mushroom|reagent/i.test(lower)) return false;
        // Exclude gear: weapons, armor, shields. These are not sellable loot —
        // they are the character's equipment. A false positive here makes the GOAP
        // plan a useless sell trip for a character who has nothing to sell.
        if (/mace|sword|axe|dagger|club|staff|bow|spear|hammer|warhammer|flail|sickle|scythe|katana|rapier|sabre|broadsword|longsword|shortsword|greatsword/i.test(lower)) return false;
        if (/armor|armour|shield|helmet|helm|glove|gait|boots|cloak|robe|tunic|leather|chain|plate|scale|ring|amulet|belt|bracer|greave/i.test(lower)) return false;
        return true;
      });
    },
  },

  at_inn: {
    describe: 'the character is in an inn or tavern room (safe to rest)',
    whenUnknown: false,
    why_unknown: 'a wrong false just means the character rests in place instead of at an inn; a wrong true wastes a trip',
    produce: ({ client }) => {
      const roomName = client?.roomNameRsc
        ? (client.rsc?.get?.(client.roomNameRsc) ?? '')
        : (client?.room?.name ?? '');
      return /inn|tavern/i.test(roomName);
    },
  },
};

export const SYMBOL_NAMES = Object.freeze(Object.keys(SYMBOLS));

// ---------------------------------------------------------------------------
// evaluate(ctx) -> { symbol: boolean }
//
// Every symbol, resolved. A producer that throws is treated exactly as "cannot
// tell" -- a broken producer must not be able to take a keeper down, and it must
// not be able to quietly flip a symbol to the convenient answer either.
// ---------------------------------------------------------------------------
export function evaluate(ctx = {}) {
  const out = {};
  for (const [name, sym] of Object.entries(SYMBOLS)) {
    let v = null;
    try { v = sym.produce(ctx); } catch { v = null; }
    out[name] = v == null ? sym.whenUnknown : !!v;
  }
  return out;
}

// Which symbols could not be answered from this context, and what each fell back
// to. The board should be able to show this: a plan built entirely on fallbacks is
// a plan built on no evidence, and it currently looks identical to a confident one.
export function unknowns(ctx = {}) {
  const out = [];
  for (const [name, sym] of Object.entries(SYMBOLS)) {
    let v = null;
    try { v = sym.produce(ctx); } catch { v = null; }
    if (v == null) out.push({ symbol: name, assumed: sym.whenUnknown, why: sym.why_unknown });
  }
  return out;
}

// ---------------------------------------------------------------------------
// validate(action) -> string[]
//
// The closed-set rule, enforced. `pre` and `effects` may name a symbol or its
// negation (`!armed`). Anything else is reported by name -- an unrecognised key is
// never applied and never dropped, because a setting that silently does nothing is
// how `purpose` stayed out of a schema for a year.
// ---------------------------------------------------------------------------
export function validate(action) {
  const problems = [];
  const check = (list, where) => {
    for (const raw of list ?? []) {
      const name = String(raw).replace(/^!/, '');
      if (!SYMBOLS[name])
        problems.push(`${action?.name ?? 'action'}.${where} names "${raw}", which is not a ` +
                      `world-state symbol (known: ${SYMBOL_NAMES.join(', ')})`);
    }
  };
  check(action?.pre, 'pre');
  check(action?.effects, 'effects');
  return problems;
}

// Every action in a set, checked at once -- what a conformance test calls.
export function validateAll(actions = []) {
  return actions.flatMap(a => validate(a));
}


// See the note beside `under_attack`. Kept as one function because two copies of a
// threshold is how two rules end up disagreeing about whether a character is being hit.
function healthFalling(session, samples = 4, drop = 2) {
  const t = session?._hpTrail;
  // TWO SAMPLES ARE EVIDENCE. This wanted three, and the trail only records health when it
  // CHANGES, so the first two hits could never say anything: JayB went 20 -> 16 with a
  // trail of length 2, `under_attack` answered false, and the ladder let him SIT DOWN AND
  // REST while a spider hit him. It first read true at 12, by which point fleeing meant
  // standing up and walking out at 60% health. He died at 3.
  //
  // A drop of `drop` between two consecutive distinct readings is not ambiguous — nothing
  // else in this game takes health away — and reacting one sample earlier is the whole
  // difference between leaving with health to spend on the walk and leaving without.
  if (!Array.isArray(t) || t.length < 2) return false;
  const window = t.slice(-samples);
  return window[0] - window[window.length - 1] >= drop;
}
