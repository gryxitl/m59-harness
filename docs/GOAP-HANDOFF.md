# GOAP Fleet Supervisor — Handoff Notes

This document covers the GOAP external supervisor layer and the four new characters
added in August 2026. It assumes familiarity with the broker and keeper architecture
described in `CLAUDE.md`.

---

## The four new characters

| Character | Agent | Build | Karma filter | Current hunt | Room |
|---|---|---|---|---|---|
| Gountrug | t1 | Weaponcraft | none | slime | 583 |
| Kage | t2 | Shal'ille caster | `good` (kills negative-karma only) | baby spider | 534 |
| JayB | t3 | Qor caster | `evil` (kills positive-karma only) | fungus beast | 544 |
| Lee | t4 | Weaponcraft | none | baby spider | 534 |

All four are PvP-enabled (base max health ≥ 30, so `PFLAG_PKILL_ENABLE` is set).

### Karma mechanics

`karmaSafe(creatureKarma, want)` in `m59-spawns.mjs`:
- `want='good'` → only allows `creatureKarma < 0` (kills evil creatures, character moves toward good)
- `want='evil'` → only allows `creatureKarma > 0` (kills good creatures, character moves toward evil)

**Kage** is Shal'ille → must stay good → `karma: "good"` → hunts giant rat (karma −20).
**JayB** is Qor → grinding toward evil → `karma: "evil"` → hunts fungus beast (karma +10).

When `yieldCheck` fires and auto-retargets, it now passes `policy.karma` to `scorePrey`
so the replacement prey also respects the filter. This was the bug fix in `m59-autopilot.mjs`
around line 7871 — `want: this.policy.karma ?? null` added to the `scorePrey` call.

### JayB's karma progression

JayB needs karma ≤ −10 to unlock Qor level 1 spells. Positive-karma prey to hunt
as she levels, in order of difficulty:

| Level range | Hunt | Karma | Room(s) |
|---|---|---|---|
| 30–49 | fungus beast | +10 | 544, 562, 563 |
| 50+ | living tree | +40 | 534, 536, 537, 546 |
| higher | frogman | +80 | 552, 576 |

When the keeper auto-retargets (yieldCheck fires), it will pick the next positive-karma
creature in the band automatically. No manual intervention needed unless she gets stuck.

### Kage's learning queue

`substrate/loadouts/Kage.json` has a full learning queue: minor heal → Shal'ille 1–6.
The GOAP `buy_next_skill` action handles purchases automatically when funds are available.

### Scaled hunt bands (as of 2026-08-19)

The fleet is currently at **lv20–27**. The threat band is `floor(level/4)` when armed,
`floor(level/8)` when unarmed. The engagement ceiling is `level + band`. A character
may fight any mob at or below the ceiling, but *may* is not *will survive*.

### Safe-wall fight strategy

Mobs are **not hostile until you swing at them**. Once you do, they chase you.
The safe-wall strategy exploits this:

1. **Engage**: swing at a mob in band. It now chases you.
2. **Reposition**: move to a wall or corner. The mob follows.
3. **Hold**: stay at the wall. The mob arrives in reach.
4. **Fight**: swing until it dies. One mob at a time, wall behind you.
5. **Repeat**: next mob approaches, fight it.

A character at a wall takes hits from one direction, not five. The `scavenge`
action implements this: it calls `fight()` with `holdPosition: false` first
(walk to target, swing, engage), then `takeSafeSpot()`, then `fight()` with
`holdPosition: true` (stay at the wall, fight when the mob arrives). If the
mob is out of reach, the action returns `holding: true` and the GOAP re-plans
on the next pass — the mob is still chasing, it just hasn't arrived yet.

**Do not take a safe spot before engaging.** The mob isn't hostile yet, so it
won't follow you to the wall. You'd be standing at a corner waiting for
something that has no idea you exist.

**Practical hunt targets for the current level range:**

| Character level | Safe hunt | Mobs (level) | Rooms |
|---|---|---|---|
| 20–24 | baby spider | lv25 | 534, 535, 545, 554, 568, 574, 575, 593, 603 |
| 25–29 | giant rat | lv30 | 535, 567, 583, 586, 603 (NOT the sewers — see below) |
| 30+ | scale up | — | — |

**Both baby spiders (lv25) and giant rats (lv30) are viable right now** for characters
at lv20–30. Baby spiders are the safer choice at the low end (lv20–24); giant rats
become the better target once the character reaches lv25+.

**The Sewers of Jasper (rooms 377–379, 108, 111, 112) have giant rats AND lupoggs (lv105).**
Lupoggs hit extremely hard and will one-shot a low-level character. NEVER send a
character below lv60+ to the sewer rooms to hunt giant rats. Use the non-sewer giant
rat rooms instead: 535, 567, 583, 586, 603. A character below lv25 who is routed into
the Sewers will be fighting over-level mobs and slowly bleeding HP through the death
spiral (each death −1 to −2 max HP). The GOAP's `nearestHuntRoom` uses the character's
engagement ceiling, so a lv21 character in the Sewers sees the rats as "in band"
(ceiling 31 ≥ 30) and stays. If a character is losing HP over successive passes, the
fix is to route them to a baby-spider room, not to raise the ceiling.

**Death spiral warning:** when a character's max HP drops below the level of the mobs
they're hunting, every death makes the next fight harder. The GOAP should detect
"HP dropping over N consecutive passes" and route to an inn to rest, or to a room
with weaker mobs. This check is not yet implemented.

### Weaponcraft builds (Gountrug, Lee)

- `buy_reagents: false` — no spells, so no reagents needed. Set in loadout policy.
- `sell: ["elderberry", "herb"]` — sell any reagents looted.
- Skill queue: weaponcraft level 1 → level 2 (GOAP handles purchases).
- As of 2026-08-15: Gountrug slash=34, mace fighting=22, block=21. Lee slash=16, mace fighting=6.

---

## The GOAP supervisor

**File:** `tools/m59-goap.mjs`

**Start it:** `node tools/m59-goap.mjs` (separate process, not part of the broker)

**Polls:** broker at `http://127.0.0.1:8901` every 60 seconds. Reads the `/fleet` endpoint,
derives world state for each character, plans and executes one action per character per pass.

### GOAP Atomics (shared with the behavior tree)

`tools/m59-atomics.mjs` is the single implementation of the primitive keeper operations that
both the GOAP planner and the behavior tree delegate to — so a primitive has one home instead
of two copies (GOAP over broker MCP tools, the BT over in-process keeper methods) that could
drift. Each atomic is invoked `runAtomic(name, ctx, params)` through a small driver:

- `brokerDriver(baseURL)` — GOAP: verbs issue broker MCP tool calls over HTTP.
- `keeperDriver(keeper)` — BT: verbs call in-process keeper methods.

Atomics: `revive_keeper`, `stop_keeper`, `travel_to`, `set_policy`, `pick_prey`, `claim_inn`,
`buy_skills`, `leave_raza`, `who_in_room`, `equip_best`, `conjure_weapon`, `buy_weapon`, plus
the `relocate_then_revive` composite (the `stop→travel→revive` triple the five town-trip actions
used to copy-paste) and `innDest(room)`. Each atomic declares its `effect` (the world-state field
it moves forward), so GOAP's cycle-guard and the BT's docs read the same monotonicity answer.

GOAP actions keep their planning decisions (which prey, which room) in `m59-goap.mjs` and
delegate only the mechanical tool calls to atomics. The BT action nodes in `m59-bt-nodes.mjs`
wrap atomics into the RUNNING/slot protocol, and `get_armed` is unchanged by the refactor.

**The GOAP action library (`buildActionLibrary`)** — each action is `{name, cost, pre, effect, run}`,
with `run` delegating to atomics via the broker driver (`_ctx`).

### Actions and what triggers them

| Action | Precondition | What it does |
|---|---|---|
| `revive_inert` | `keeperRunning && inert && !busyErrand && inertWhy not "unarmed…"` | Clears post-restart inert state |
| `stop_and_travel` | Off assigned room | Travels to assigned room |
| `set_purpose` | No purpose set | Sets `advance` purpose with hp goal |
| `set_prey` | No hunt or yield paying=false | Picks best prey via `prey` tool |
| `rest_in_inn` | In inn, not rested | Parks at inn to rest |
| `avoid_crowded_room` | Stalled, healthy, outsider players in room | Moves to different room |
| `retarget_on_stall` | Stalled, healthy, no assigned room | Picks new prey via `prey` tool |
| `retreat_to_inn` | Stalled, hurt (<70%), not at inn | Travels to inn to rest |
| `leave_capped_room` | Stall: `room capped by creatures we will not fight` | Clears assigned_room |
| `relocate_no_safe_wall` | Stall: `no safe wall here` | Clears assigned_room |
| `town_trip_bags_full` | Stall: `bags full` | Travels to town to sell/bank |
| `retarget_unreachable` | Stall: `cannot reach` or `roam limit` | Picks new prey |
| `rescue_trapped` | Stall: `trapped` or `too hurt to fight` | Evacuates to inn |
| `send_to_town_for_gear` | Stall: `unarmed — N mana`, **or** inert-with-unarmed reason | Travels to town, keeper buys weapon |
| `buy_next_skill` | Has skill plan, has funds | Queues next skill purchase |
| `escalate_to_operator` | Stalled >5min, nothing else worked | Writes needs-operator flag |
| `leave_raza` | In Raza (rooms 1011–1018) **and level ≥ 25** | Walks out of Raza |

### World state fields

Derived in `deriveWorldState()`. Key ones for writing new actions:
- `stalledWhy` — the raw stall reason string from the broker
- `stallRoomCapped`, `stallNoSafeWall`, `stallBagsFull`, etc. — pre-parsed booleans
- `unarmedStall` — true when stall why starts with "unarmed"
- `learningCooldown` — true while `buy_next_skill` is cooling down (5 min)
- `gearTripCooldown` — true while `send_to_town_for_gear` is cooling down (10 min)
- `inert` — the keeper is awake but not steering. **The fleet row publishes no `inert`
  field** (its `autopilot` is a deliberate subset); it surfaces as
  `committed.kind === 'driven'` (describeCommitment returns 'driven' exactly when inert)
  or the activity string `"inert -- <why>"`. Without that, `revive_inert` could never fire.
- `busyErrand` — busy from a REAL operation (parked, busy.busy, an errand/partner/bot
  commitment, or an external faculty claim). `committed.kind === 'driven'` (the inert
  keeper) is NOT an errand and does not set it — that distinction is what lets
  `revive_inert` fire while the inert-driven state itself reports `busy`.
- `committedKind` — the commitment kind: `errand` | `parked` | `partner` | `bot` | `driven` | null
- `inertWhy` — why the keeper is inert (the 'driven' label, or the activity after
  `"inert -- "`). Distinguishes post-restart inert (revive fixes it) from unarmed inert
  (revive just re-inerts — `send_to_town_for_gear` must arm it instead). `revive_inert`
  is gated off the unarmed case for exactly this reason, which is what stops it looping
  on an unarmed keeper.
- `fleetNames` — Set of all fleet character names, used to identify outsiders

### Adding a new action

1. Add stall-reason booleans to `deriveWorldState()` if needed
2. Call `mk({ name, cost, pre, effect, run })` in the `buildActions()` array
3. `pre` is a JS expression string evaluated against the world state object
4. `run` is `async (state) => { ... }` — call broker tools via `callTool(name, args)`
5. Return `{ note: '...' }` on success, `null` to skip (action treated as no-op)
6. Add a comment to the `// Effect discipline` block at the bottom explaining how
   the effect removes its own precondition to avoid infinite loops

---

## Playbooks (PvP response)

**Directory:** `substrate/playbooks/` — one JSON file per character, keyed on lowercase name.

All four characters have playbooks with the same policy:
- Health ≥ 70%, single attacker → `fleet_alert` then `fight_back`
- Health < 70% OR 2+ attackers → `leave_room`
- Health < 40% → `logoff` for 5 minutes

`fight_back` and `fleet_alert` were added to the verb set in `tools/m59-playbook.mjs`
and wired into `executeVerb()` in `tools/m59-autopilot.mjs`. `fleet_alert` signals
the broker which fans out to nearby healthy fleet members to converge and fight back.

**Key point:** the `inReachOfUs()` OF.PLAYER filter stays in place — ordinary combat
never targets players. `fight_back` is only triggered by an explicit playbook rule.

---

## Loadout policy block

Loadout files now support an optional `policy` block that is applied to the keeper's
live policy on every pass (`applyLoadoutPolicyOverlay()` in `m59-autopilot.mjs`).
Fields present in the loadout overwrite the live policy on every pass. Fields absent
do not touch the live policy.

Supported fields: `buy_reagents`, `karma`, `hunt`, `assigned_room`, `pulls_before_barren`.

This means broker restarts are self-healing — no manual `autopilot set` calls needed.

---

## Known issues / things to watch

**Gountrug's broken weapon cycle:** The broker marks a weapon `known_broken` after a
failed equip attempt. If the keeper is restarted while the weapon is mid-use, it can
get stuck: the broken weapon counts as `has_weapon: true` so the unarmed stall message
fires, but `equip_best` refuses it. The GOAP `send_to_town_for_gear` handles this by
sending Gountrug to the smith. The broken weapon is auto-dropped within 2 minutes
(`dropBrokenEverySec: 120`). Root cause not fully diagnosed.

**Lee has no assigned_room in loadout:** Lee's loadout doesn't pin a room. The keeper
picks by roaming. Could add `"assigned_room": 586` to Lee's loadout policy if she
keeps ending up in bad rooms.

**Settings that still require manual set after restart (none — fixed):** All per-character
policy settings are now in loadout files and applied automatically.

**`leave_raza` needs the map graph, not rsc (fixed 2026-08-16):** The broker tool's
`inRaza()` used to test `rsc.get(roomNameRsc)`. When the local resource table holds zero
strings (no container, so `setup.mjs rsc` never ran — see the m59-rsc.mjs trap), that
returns `"<rsc 23197>"`, `inRaza()` always failed, and the GOAP supervisor re-fired
`leave_raza` every pass with no effect (Sasquatch stalled in the Mausoleum for hours).
`inRaza()` now resolves the room name from `worldMap.rooms[room_num].name` first, falling
back to rsc. It is also gated in the GOAP on `level >= 25` (the tool's own threshold), so
a sub-25 character stays in Raza — a capped-room stall there is handled by
`leave_capped_room` instead.

**Sasquatch (t5) left Raza early on 2026-08-16** during the above fix's validation: it was
level 20, the GOAP's pre-gate `leave_raza` dragged it out, and the portal is one-way — it
cannot return. It now hunts mummy (Raza-only prey) outside Raza and will roam until it
stalls and the GOAP retargets it to non-Raza prey. It has no loadout; if its progression
matters, give it one.

**Latent: `stop_and_travel` inside Raza to an outside-Raza room loops.** Raza rooms
(1011–1018) have zero exits in the map graph, so the router cannot plan a trip out; the
broker's `leave_raza` is the only way out. With `leave_raza` now gated on `level >= 25`,
a sub-25 character stalled in Raza whose `assigned_room` is outside Raza (an anomalous
assignment — the keeper normally assigns a Raza room for mummy hunting) falls to
`stop_and_travel` (cost 1), which outbids `leave_capped_room` (4) and cannot complete.
Not fixed yet — no live character is in this state (Sasquatch is out); a future fix would
exclude the in-Raza/outside-assignment case from `stop_and_travel` so `leave_capped_room`
wins.

---

## Swarm tasks

Use project `m59-harness` (not `game-harness`) when creating swarm tasks for this repo.

```bash
curl -s http://localhost:5001/api/tasks -X POST -H 'Content-Type: application/json' -d '{
  "project": "m59-harness",
  "task_type": "feature",
  "priority": 80,
  "description": "..."
}'
curl -s http://localhost:5001/api/spawn -X POST -H 'Content-Type: application/json' \
  -d '{"project":"m59-harness","force":true}'
```

---

## Quick diagnostics

```bash
# Fleet overview — stalls, levels, weapons
node tools/m59-which.mjs

# Character abilities
node tools/m59-abilities.mjs Gountrug Lee JayB Kage

# Tougher history (HP gains)
node tools/m59-tougher.mjs

# Check a stall reason
curl -s http://127.0.0.1:8901/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"autopilot","arguments":{"agent":"t1","action":"status"}}}' \
  | python3 -c "import sys,json; s=json.loads(json.load(sys.stdin)['result']['content'][0]['text']); print(s.get('stalled'), s.get('activity'))"

# Re-equip a character manually
node tools/m59-outfit.mjs --port 8901 --agents t1

# Broker restart (policy reloads from loadouts automatically)
node tools/m59-service.mjs restart
```
