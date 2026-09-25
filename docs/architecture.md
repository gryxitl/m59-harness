# M59-Harness Architecture

> **Note (2026-09-01):** The tick keeper (`m59-tick.mjs` + `m59-decide.mjs`) is now the live path for this fleet. The legacy keeper (`m59-autopilot.mjs`) is still in the codebase and is used by other fleets in parallel. See [The Tick Keeper](#the-tick-keeper) below for the current architecture.

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MERIDIAN 59 SERVER                           │
│                        <host>:5959  (set M59_HOST)                  │
└────────────────────────────┬────────────────────────────────────────┘
                             │  TCP — M59 binary protocol
                             │  AP_* login frames / BP_* game frames
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                         M59Client                                   │
│                    tools/m59-client.mjs                             │
│                                                                     │
│  • Maintains TCP socket, parses every incoming packet               │
│  • Keeps live state: room.objects, inventory, vitals, abilities     │
│  • Emits events upward: room-contents, stat, said, equipped, ...    │
│  • Event ring: 500 entries (combat) + 300 entries (chat, separate   │
│    so speech survives a busy fight)                                 │
│  • Sends commands: REQ_MOVE, REQ_ATTACK, REQ_CAST, BP_WITHDRAW …   │
└────────────────────────────┬────────────────────────────────────────┘
                             │  one M59Client per character
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                          Session                                    │
│                    tools/m59-broker.mjs                             │
│                                                                     │
│  • Wraps one M59Client; mediates all read/write access              │
│  • Pacer: rate-limits actions to ~5/second                          │
│    (queues: 'read', 'use', 'move', 'cast', 'drop')                  │
│  • Records every health drop → substrate/hits/<char>.json           │
│  • Records room transit times → substrate/transit/<char>.json       │
│  • Writes raw event stream → substrate/recordings/<char>/           │
│  • Tracks credentials; can rejoin() after a drop                    │
└────────────────────────────┬────────────────────────────────────────┘
                             │  one Session per character
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                         Broker                                      │
│                    tools/m59-broker.mjs                             │
│                                                                     │
│  Fleet state ──────────────────────────────────────────────────┐   │
│  • sessions Map (agent → Session)                              │   │
│  • fleetState.json: credentials + autopilot policy per char    │   │
│  • leftOnPurpose / piloted sets                                │   │
│  • Rejoin sweep every 45s: re-logs dropped characters          │   │
│  • resumeFleet on startup: reads prior client cmd lines,       │   │
│    skips chars a human is already playing                      │   │
│                                                                │   │
│  Ledger ───────────────────────────────────────────────────────┘   │
│  • 5-minute samples: health, activity, kills, purse, pack          │
│  • killed events attributed to specific kills (not diff)           │
│  • tougher events: max-health gains with kill attribution          │
│  • substrate/ledger/<fleet>.jsonl                                   │
│                                                                     │
│  HTTP server :8901  ◄── JSON-RPC MCP ──► Claude / other agents     │
│  Dashboard   :8902  ◄── browser (read-only fleet page)             │
│                                                                     │
│  83 MCP tools exposed:                                             │
│    fleet, snapshot, autopilot, travel, fight, join, leave,         │
│    go_through, leave_raza, signets, guild, loadout, …              │
└────────────────────────────┬────────────────────────────────────────┘
                             │  one Autopilot per character
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                        Autopilot (Keeper)                           │
│                    tools/m59-autopilot.mjs                          │
│                                                                     │
│  Runs pass() every ~1s (decideMs policy):                          │
│                                                                     │
│   1. Post position & interests to team coordination board           │
│   2. Resync every 8s: roomContents() + stats() to correct drift    │
│   3. observe(): is the current safe spot still working?             │
│   4. recordFrame(): health/doing/room snapshot for post-mortems     │
│   5. Decision ladder (priority order):                              │
│        panicking?      → logoff                                     │
│        in Underworld?  → escape via portals                         │
│        health < flee?  → run                                        │
│        health < rest?  → find safe wall, rest to full               │
│        farm mode?      → hunt prey (fight loop)                     │
│        town needed?    → travel to town, bank/buy/sell              │
│        errand active?  → execute multi-hop task                     │
│        idle            → roam or wait                               │
│                                                                     │
│  Watchdog (independent 500ms timer):                               │
│   • Reads health live (server pushes it)                           │
│   • If health crosses flee line while pass is blocked > 3s         │
│     → calls cancelMovement() to interrupt the await               │
│   • Writes health-change frames even when pass is blind            │
│                                                                     │
│  Policy (settable via MCP autopilot tool):                         │
│   hunt, fightRounds, restBelow, fleeBelow, assignedRoom,           │
│   bankAbove, buyFood, roam, partner, threatCeiling, …              │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                          Skills                                     │
│                    tools/m59-skills.mjs                             │
│                                                                     │
│  fight(session, opts)                                              │
│   • findCreature() — scans room.objects, filters OF_PLAYER         │
│   • claimQuarry() — coordinates with fleetmates, no pile-ons       │
│   • equipBest() / wearBest() — equip weapon + armour               │
│   • approach to within 2-3 squares (melee range disc)              │
│   • swing loop: rounds × swings, loot on kill                      │
│   • disengageAt threshold: break off below flee health             │
│   • preferId: locks onto specific creature id across rounds        │
│                                                                     │
│  travel(session, roomId)                                           │
│   • A* path via m59-map world graph                                │
│   • Per-hop: approachSquare() with fine-coord fallback             │
│   • Bracketed: "setting off" + "arrived" frames either side        │
│   • Cancellation token: watchdog can interrupt mid-hop             │
│                                                                     │
│  eat(), rest(), healUp(), bank(), buy(), sell(), cast()            │
└─────────────────────────────────────────────────────────────────────┘


## Claude / MCP integration

┌──────────────────┐     stdio MCP      ┌──────────────────────────┐
│   Claude Code    │ ◄────────────────► │   m59-mcp-attach.mjs     │
│  (this session)  │                    │   forwards to :8901      │
└──────────────────┘                    └────────────┬─────────────┘
                                                     │ HTTP JSON-RPC
                                                     ▼
                                          Broker :8901 tool handlers


## What Claude can do via MCP

READ                          WRITE / ACT
────────────────────────────  ────────────────────────────────────
fleet()       — all chars     autopilot(set/start/stop)
snapshot(t1)  — one char      travel(agent, room)
ledger()      — history       fight(agent, target)
deaths()      — post-mortems  go_through(agent, exit)
tougher()     — level gains   leave_raza(agent)
skills()      — ability lvls  signets(action)
economy()     — purse/bank    loadout(agent, ...)
                              guild(action)


## State that persists to disk (substrate/)

substrate/
  fleet-state.json          ← credentials + autopilot policy (THE roster)
  fleet-state.json.prev     ← safety backup written before every save
  hits/<char>.json          ← every health drop with room + killer
  abilities/<char>.json     ← spell/skill levels (pushed by server)
  banks/<char>.json         ← bank balance (caught when banker speaks)
  sheets/<char>.json        ← character stats snapshot
  loadouts/<char>.json      ← per-character gear/reagent targets
  recordings/<char>/        ← raw event stream to disk
  ledger/<fleet>.jsonl      ← 5-minute samples + kill/tougher events
  broker-<fleet>.log        ← broker stdout/stderr


## Service wrapper

start-broker.sh
  └── m59-service.mjs start
        └── spawns m59-broker.mjs detached
              pid → substrate/broker-<fleet>.pid
              log → substrate/broker-<fleet>.log
              survives terminal; does NOT survive reboot
```

## The Tick Keeper

> **This is the current live path for this fleet.** The legacy keeper (`m59-autopilot.mjs`) is still in the codebase and is used by other fleets in parallel.

The tick keeper is a real-time 10Hz loop that drives each character. It was built to fix the architectural defect of the legacy keeper: **how often the agent looks at the world is decided by how long it spent not looking.**

### The Loop

```
every 100ms, never blocking:
  frame  = sensor.read()        // free — but POSITION IN IT MAY BE STALE
  intent = decide(frame)        // pure, synchronous, no awaits
  actuate(intent)               // enqueue one command; do not await
```

### The Five Rules

1. **A tick never awaits an actuation.** A `decide()` returning a promise is reported and NOT awaited.
2. **The sensor never sends.** Built on `snapshot()`/`perception()`, never `view()`.
3. **Effects are observed, not returned.** The actuator reports what it SENT.
4. **The position is polled, not pushed.** The server does not push our own position. `confirmPosition()` is the only way to know where we are.
5. **The watchdog is independent.** A 500ms timer reads health live and can interrupt a blocked pass.

### Key Components

| Component | File | Role |
|-----------|------|------|
| **Tick driver** | `m59-tick.mjs` | The 10Hz loop |
| **Decision** | `m59-decide.mjs` | Pure, synchronous decision function |
| **ControllerMover** | `m59-controller-mover.mjs` | Movement with airlock, room stamp, force-adopt |
| **CharacterController** | `m59-controller.mjs` | Fine-grained movement (walk/run) |
| **Sensor** | `m59-sensor.mjs` | Reads the world state |
| **Actuator** | `m59-act/*.mjs` | Action primitives (attack, cast, equip, flee, rest, step, travel-to) |

### The Airlock

When the room changes, **all movement stops** until the server confirms the new position via `BP_ROOM_CONTENTS`. This makes the order-of-operations bug impossible by construction.

```
1. Character walks to staging square
2. Server teleports to new room
3. Server sends BP_PLAYER (new room ID, old position)
4. **Airlock engages**: all movement stops
5. Server sends BP_ROOM_CONTENTS (new position)
6. Client sets _lastContentsRoom to new room
7. **Airlock releases**: ControllerMover force-adopts new position (syncFrom), resumes movement
```

### Room Stamp Guard

Every path and position is stamped with the room it was created in. If the room changes, stale paths/positions are dropped/refused.

### Speed Parity

- **Walk**: 18 units/s (combat, precision)
- **Run**: 36 units/s (travel, hunt, flee)

`setRun(true)` is called for all goals except `_fight`, `healthy`, `vigor_low`, `idle_rest`.

### What's Different from the Legacy Keeper

| | Legacy Keeper | Tick Keeper |
|---|---|---|
| **Loop** | `pass()` every ~1s (blocking) | 10Hz loop (non-blocking) |
| **Position** | Pushed (assumed) | Polled (confirmed) |
| **Movement** | Legacy mover | ControllerMover (airlock, room stamp) |
| **Speed** | Walk only | Walk + Run (setRun) |
| **Room transitions** | No airlock | Airlock (all movement stops) |
| **Watchdog** | 500ms timer | 500ms timer (same) |
| **Decision** | Ladder (priority order) | Pure function (synchronous) |
