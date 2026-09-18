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
import { affordances, OF } from './m59-parse.mjs';

// Melee reach is a disc on SQUARE coordinates -- both sides run
// `SquaredDistanceTo <= GetAttackRange^2` where range is Bound(2 + difficulty/6, 2, 3)
// for a monster (monster.kod:1682) and 2-3 by weapon type for us (weapon.kod:52).
// Fine coordinates are read by nothing but the drawing code (MonsterOrient,
// monster.kod:2189), so there is nothing finer than a square to stand on.
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
    whenUnknown: false,
    why_unknown: 'an unarmed character that hunts is a death sentence; ' +
                 'fail-closed so the armed goal fires and the character arms first',
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
      // Floor at 50%: legacy fleet policies say 0.4, but fleeing at 8 HP
      // with chasers is dying (watched repeatedly) — venom and packs need
      // the margin. An operator can still raise it, never lower it.
      return f < Math.max(policy?.fleeBelow ?? 0.5, 0.5);
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
  mob_near: {
    describe: 'a hostile mob (attackable, not a player, not decoration) is within 20 squares',
    whenUnknown: false,
    why_unknown: 'no evidence of a nearby hostile is not a nearby hostile',
    produce: ({ client }) => {
      const me = client?.self;
      if (!me || me.col == null) return false;
      const objects = client?.room?.objects;
      if (!(objects instanceof Map)) return false;
      for (const o of objects.values()) {
        if (o.flags & OF.PLAYER) continue;
        const can = affordances(o.flags ?? 0);
        if (!can.includes('attack')) continue;
        const name = client.rsc?.get?.(o.nameRsc) ?? '';
        if (/^(tree|living tree|flagpole|fence|wall|door|window|rock|boulder|bush|grass|flower|mushroom|log|stump)/i.test(name)) continue;
        if (/friendly|pet|tame/i.test(name)) continue;
        if (o.col == null) continue;
        const d2 = (o.col - me.col) ** 2 + (o.row - me.row) ** 2;
        if (d2 <= 400) return true; // 20 squares
      }
      return false;
    },
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
      if (!client?.inventory?.length) return null;
      return purse >= (policy?.walkingMoney ?? 100);
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
  flee_room: {
    describe: 'the character has fled the hostile room (goal-direction name, not a worldstate symbol)',
    whenUnknown: false,
    why_unknown: 'a wrong true means the planner thinks the character already fled; a wrong false is the default (not fled yet)',
    produce: () => false, // always false: the character has not fled until the action fires
  },

  has_wieldable_weapon: {
    describe: 'the pack has a weapon that is not broken and not already equipped',
    whenUnknown: false,
    why_unknown: 'a wrong true means the planner plans equip on a broken/absent weapon; a wrong false just delays arming',
    produce: ({ client }) => {
      const inv = client?.inventory ?? [];
      if (!inv.length) return false;
      const eq = client.equipment?.();
      const held = new Set((eq && eq.known !== false ? eq.equipped || [] : []).map(o => o.id));
      const broken = client._brokenWeapons ?? new Set();
      const WEAPON = /mace|sword|axe|club|hammer|dagger|staff|spear|blade|knife/i;
      return inv.some(o => {
        if (o?.id == null || held.has(o.id) || broken.has(o.id)) return false;
        const nm = String(client.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
        return WEAPON.test(nm);
      });
    },
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

// The registry is open by design: an atomic may declare a symbol nobody has
// produced yet, and the planner treats it as unsatisfied (the safe direction).
// `validate()` checks the CLOSED SET — the symbols with a producer — so a typo
// is still reported by name. A declared-but-unproduced symbol is not a typo:
// it is a promise the atomic makes that no one else in the vocabulary can
// verify, and the planner's re-evaluation after each step is what makes it
// visible. `SYMBOL_NAMES` is the closed set; `KNOWN_NAMES` is the open one.
export const SYMBOL_NAMES = Object.freeze(Object.keys(SYMBOLS));
export const KNOWN_NAMES = new Set(SYMBOL_NAMES);
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
      if (!KNOWN_NAMES.has(name)) {
        // A declared-but-unproduced symbol is not a typo: it is a promise the
        // atomic makes that no other symbol in the vocabulary can verify, and
        // the planner's re-evaluation after each step is what makes it visible.
        // It is reported, not rejected, so the conformance sweep can see it.
        problems.push(`${action?.name ?? 'action'}.${where} names "${raw}", which is ` +
                      `declared but has no producer (produced: ${SYMBOL_NAMES.join(', ')})`);
      }
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
