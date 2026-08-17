#!/usr/bin/env node
// m59-fake-client.mjs -- ONE fake client, shaped from the real one, for every
// offline test that needs a character.
//
// WHY THIS FILE EXISTS. Both of the silent bugs found in the behavior-tree work
// were FIXTURE bugs, not logic bugs, and each passed its own suite for months:
//
//   m59-bt-farming.mjs:78   new Set([...(c.equipment?.keys?.() ?? [])])
//   m59-bt-combat.mjs:393   new Set([...(c.equipment?.keys?.() ?? [])])
//
// equipment() is a METHOD returning { known, equipped[] } (m59-client.mjs:380),
// not a Map. `c.equipment.keys` is undefined on a function, `?.()` short-circuits,
// `?? []` swallows it -- so the set was unconditionally empty and every character
// read as wearing nothing. GearBrokenCondition therefore always reported broken
// gear, and CombatTree's canFight always said no, meaning a fully-armed character
// would always flee. Their fixtures supplied `equipment: new Map()`, which has
// .keys(), so the tests agreed with the code and both were wrong together.
//
//   m59-bt-nodes.mjs:100    bb.client.armed && bb.client.armed()
//   m59-autopilot.mjs:6928  typeof c.armed === 'function' && !c.armed()
//
// A client has never had an armed() -- that predicate was Autopilot's, and is now
// skills.isArmed(client). So the condition answered false for every character and
// the useBT get-armed branch has never executed at all. Again the fixtures
// supplied `armed: () => true`, a method the real code never calls.
//
// A fake that answers questions the real client is never asked will agree with
// anything. So there is one fake, it is shaped from m59-client.mjs, and
// m59-fake-client-test.mjs asserts that shape against the real class. When the
// client grows a method, the fake fails until it grows one too.
//
// It is deliberately NOT a mock framework. It is a plain object with the same
// surface, a scripted world, and a `sent` log so a test can assert what went to
// the wire rather than what a function returned.

// The exact shape of M59Client.equipment() -- see m59-client.mjs:380. `known` is
// false until the first BP_USE_LIST lands, and "nothing equipped" and "nobody has
// asked yet" are different answers that must never render the same.
function equipmentOf({ equipped = [], known = true }) {
  return {
    known,
    equipped: equipped.map(o => ({ id: o.id, name: o.name ?? null })),
    count: equipped.length,
    fresh_ms: known ? 0 : null,
    changed_ms: known ? 0 : null,
    source: 'BP_USE_LIST/BP_USE/BP_UNUSE — the server\'s own plUsing list',
  };
}

// The shape of M59Client.vitals(). Health and vigor are PUSHED by the server, so
// reading them is a cache hit and costs nothing -- which is what lets a condition
// be evaluated every tick, and what lets the watchdog run while a pass is blocked.
function vitalsOf({ hp = 20, hpMax = 20, mana = 20, manaMax = 20,
                    vigor = 100, vigorMax = 200 }) {
  return {
    health: { value: hp,    max: hpMax },
    mana:   { value: mana,  max: manaMax },
    vigor:  { value: vigor, max: vigorMax, scale_max: vigorMax },
  };
}

/**
 * fakeClient(spec) -> a client-shaped object.
 *
 * spec:
 *   hp, hpMax, mana, manaMax, vigor, vigorMax   vitals
 *   equipped: [{id, name}]                      the USE LIST (plUsing), not the pack
 *   known: bool                                 has a use list arrived at all
 *   inventory: [{id, name, amount}]             the pack
 *   room: { num, name, objects: Map|[] }        current room
 *   selfId, col, row                            where we are
 *
 * Everything the real client sends is recorded on `.sent` as [verb, ...args] so a
 * test can assert the WIRE, which is the only thing the server ever sees.
 */
export function fakeClient(spec = {}) {
  const sent = [];
  const inventory = (spec.inventory ?? []).map(o => ({ amount: 1, ...o }));
  const objects = spec.room?.objects instanceof Map
    ? spec.room.objects
    : new Map((spec.room?.objects ?? []).map(o => [o.id, o]));

  const c = {
    sent,
    selfId: spec.selfId ?? 1,
    self: { id: spec.selfId ?? 1, col: spec.col ?? 0, row: spec.row ?? 0 },
    inventory,
    // `using` is the raw Set the real client keeps; equippedNow() reads it directly.
    using: new Set((spec.equipped ?? []).map(o => o.id)),
    room: { num: spec.room?.num ?? 1, name: spec.room?.name ?? 'Room', objects },
    // The resource table. A real one answers by nameRsc; tests mostly set `name`
    // directly, so this falls through rather than inventing a string.
    rsc: { get: (k) => spec.rsc?.[k] ?? null },
    evSeq: 0,

    equipment: () => equipmentOf({ equipped: spec.equipped ?? [], known: spec.known ?? true }),
    vitals:    () => vitalsOf(spec),

    attack: (id, info = 1) => { sent.push(['attack', id, info]); },
    cast:   (spellId, targets = []) => { sent.push(['cast', spellId, targets]); },
    apply:  (what, onWhat) => { sent.push(['apply', what, onWhat]); },
    rest:   () => { sent.push(['rest']); },
    stand:  () => { sent.push(['stand']); },
    requestInventory: () => { sent.push(['requestInventory']); },
    roomContents:     () => { sent.push(['roomContents']); },
    // Resolves immediately: a test that wants to model a timeout says so by
    // overriding it. Defaulting to a real wait would make every suite slow and
    // would test setTimeout rather than the code.
    waitFor: async () => ({}),
  };

  return Object.assign(c, spec.overrides ?? {});
}

/**
 * fakeSession(client, spec) -> the session surface the trees actually use.
 *
 * `world` is the routing view (room, exits, geometry); `leaveVia` and `step` are
 * the two movement verbs. Both record to the client's `sent` log and both can be
 * scripted to fail, because a movement that silently does not happen is the
 * failure mode that matters here -- the server does not say no.
 */
export function fakeSession(client, spec = {}) {
  const s = {
    name: spec.name ?? 't1',
    client,
    live: true,
    world: {
      room: client.room,
      map: spec.map ?? null,
      exits: () => spec.exits ?? [],
      geometry: spec.geometry ?? null,
    },
    // The pacer is a queue in front of the socket. Offline it is a pass-through,
    // so tests exercise ordering rather than sleeping.
    pacer: { submit: async (_kind, fn) => fn() },
    leaveVia: spec.leaveVia ?? (async (exit) => {
      client.sent.push(['leaveVia', exit?.to ?? null]);
      if (exit?.to == null) return { left: false };
      client.room = s.world.room = { num: exit.to, name: `Room ${exit.to}`, objects: new Map() };
      return { left: true };
    }),
    step: spec.step ?? (async (col, row) => {
      client.sent.push(['step', col, row]);
      client.self.col = col; client.self.row = row;
      return { moved: true };
    }),
  };
  return Object.assign(s, spec.overrides ?? {});
}

export { equipmentOf, vitalsOf };
