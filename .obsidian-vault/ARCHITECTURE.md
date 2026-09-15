# Architecture

> How the pieces fit together. Read [[README]] first.

## The system in one paragraph

A broker (`m59-broker.mjs`) manages a fleet of characters. Each character has a
**tick keeper** (`m59-keeper-process.mjs`) that runs a 10Hz loop: read the client
state, decide what to do, and actuate it. The client (`m59-client.mjs`) maintains
the TCP connection to the server and parses every packet. Movement is handled by
the **ControllerMover** (`m59-controller-mover.mjs`), which uses a fine-grained
`CharacterController` (`m59-controller.mjs`) to walk/run square-by-square.

## The two generations

| | Legacy (upstream default) | Tick (ours) |
|---|---|---|
| **Keeper** | `m59-autopilot.mjs` (13,196 lines) | `m59-keeper-process.mjs` |
| **Loop** | `pass()` every ~1s (blocking) | 10Hz (non-blocking) |
| **Mover** | `m59-mover.mjs` (step-by-step) | `m59-controller-mover.mjs` (continuous) |
| **Position** | Assumed pushed | Polled (`confirmPosition()`) |
| **Room transitions** | No protection | Airlock |
| **Speed** | Walk only (18) | Walk (18) + Run (36) |
| **Used by** | Other fleets | This fleet |

**We run the tick keeper.** The legacy keeper is still in the codebase and is used
by other fleets in parallel.

## The tick loop

```
every 100ms, never blocking:
  frame   = sensor.read()       // read client state (free, no network)
  intent  = decide(frame)       // pure, synchronous, no awaits
  actuate(intent)               // enqueue one command; do not await
```

### The five rules

1. **A tick never awaits an actuation.** A `decide()` returning a promise is reported and NOT awaited.
2. **The sensor never sends.** Built on `snapshot()`/`perception()`, never `view()`.
3. **Effects are observed, not returned.** The actuator reports what it SENT.
4. **The position is polled, not pushed.** The server does not push our own position.
5. **The watchdog is independent.** A 500ms timer reads health live.

## The layers

```
┌──────────────────────────────────────────────────────────────┐
│  BROKER (m59-broker.mjs)                                      │
│  Fleet management, sessions, policy, rejoin, HTTP API :8901   │
├──────────────────────────────────────────────────────────────┤
│  KEEPER (m59-keeper-process.mjs)                             │
│  One per character. Starts the tick loop, manages the client. │
├──────────────────────────────────────────────────────────────┤
│  TICK LOOP (m59-tick.mjs)                                    │
│  10Hz: sense → decide → actuate                               │
├──────────────────────────────────────────────────────────────┤
│  DECIDE (m59-decide.mjs)                                     │
│  Pure, synchronous. Goals: hunt, flee, travel, rest, fight.   │
├──────────────────────────────────────────────────────────────┤
│  MOVER (m59-controller-mover.mjs)                            │
│  Airlock, room stamp, force-adopt. Delegates to:              │
│    CharacterController (m59-controller.mjs) — walk/run        │
│    Legacy mover (m59-mover.mjs) — fallback/recovery           │
├──────────────────────────────────────────────────────────────┤
│  CLIENT (m59-client.mjs)                                     │
│  TCP socket, packet parsing, state, events                    │
├──────────────────────────────────────────────────────────────┤
│  SERVER (blakserv)                                            │
│  Meridian 59 game server                                      │
└──────────────────────────────────────────────────────────────┘
```

## The layers, explained

### 1. Broker (`m59-broker.mjs`)

**Owns**: The fleet. All sessions, all policy, all rejoin logic.

**Does**:
- Maintains one `M59Client` per character (the "session")
- Reads policy from loadout files, writes via `autopilot set`
- Rejoins dropped sessions every 45s (unless `leave`d on purpose)
- Serves the HTTP API (:8901 JSON-RPC, :8902 dashboard)
- Writes the ledger (5-minute samples)
- Starts/stops keepers when characters join/leave

**Contract with the layer below**: The broker creates a `Session` object
(wrapping an `M59Client`) and hands it to the keeper. It does NOT drive the
tick loop — the keeper does. The broker can read the keeper's state (via the
HTTP API) but does not intervene in decisions.

**Key files**: `m59-broker.mjs`, `m59-service.mjs`, `m59-shutdown.mjs`

---

### 2. Keeper (`m59-keeper-process.mjs`)

**Owns**: One character's lifecycle. The tick loop, the client connection,
the state reporting.

**Does**:
- Creates the `M59Client` (or receives it from the broker)
- Starts the 10Hz tick loop (`m59-tick.mjs`)
- Reports state to the broker (health, position, goal, stuck)
- Handles the watchdog (independent 500ms timer)
- Manages the `ControllerMover` instance

**Contract with the layer below**: The keeper calls `tick()` every 100ms.
Each tick: `sense()` → `decide()` → `actuate()`. The keeper does NOT make
decisions — it delegates to `decide()`. It does NOT move the character —
it delegates to the mover.

**Contract with the layer above**: The keeper reports its state to the broker
via the session. The broker can read `health`, `position`, `goal`, `stuck`
from the keeper's state.

**Key files**: `m59-keeper-process.mjs`, `m59-tick.mjs`, `m59-game.mjs`

---

### 3. Tick Loop (`m59-tick.mjs`)

**Owns**: The 10Hz rhythm. The sense → decide → actuate cycle.

**Does**:
- Every 100ms: reads the client state (`sense()`), calls `decide()`,
  and actuates the result
- Enforces the five rules (no awaiting, no sending from sensor, etc.)
- Reports tick health (is the loop running? is it blocked?)

**Contract with the layer below**: The tick loop calls `decide(frame)` which
returns an intent. It then calls `actuate(intent)` which enqueues a command.
Neither is awaited.

**Key files**: `m59-tick.mjs`, `m59-tick-run.mjs`

---

### 4. Decide (`m59-decide.mjs`)

**Owns**: The decision logic. Pure, synchronous, no I/O.

**Does**:
- Evaluates the frame (health, position, threats, goal)
- Selects a goal (hunt, flee, travel, rest, fight, armed, idle)
- Returns an intent (what to do next)
- Calls `setRun(true/false)` based on the goal
- Detects stuck state and triggers `escape_pocket`

**Contract with the layer below**: The decide function returns an intent
object. The intent is either a movement command (go to room X, flee from Y),
a combat command (attack target Z), or a rest command. The decide function
does NOT send any packets — it only returns what should be sent.

**Contract with the layer above**: The decide function is pure. It takes a
frame (read-only snapshot of the world) and returns an intent. It has no
side effects. It can be tested offline.

**Key files**: `m59-decide.mjs`, `m59-worldstate.mjs` (the frame)

---

### 5. Mover (`m59-controller-mover.mjs`)

**Owns**: Movement. Paths, positions, room transitions.

**Does**:
- Plans paths (using `m59-route.mjs` for inter-room, `m59-finepath.mjs` for intra-room)
- Handles the airlock (room transitions)
- Stamps paths/positions with the room (room stamp guard)
- Force-adopts the server's position after airlock release
- Detects bad arrivals (no floor) and triggers recovery
- Delegates to `CharacterController` for walk/run
- Delegates to legacy mover (`m59-mover.mjs`) for fallback/recovery

**Contract with the layer below**: The mover calls `CharacterController.move()
` to walk/run to a position. It calls `m59-client.mjs` to send `REQ_MOVE`
packets. It reads the client's state (`_lastContentsRoom`, `_roomStamp`) to
know when the room has changed.

**Contract with the layer above**: The mover exposes `moveTo(room, x, y)`,
`fleeFrom(x, y)`, `setRun(bool)`, `clear()`, `syncFrom(me)`. The decide
function calls these to actuate its intent.

**Key files**: `m59-controller-mover.mjs`, `m59-controller.mjs`, `m59-mover.mjs`

---

### 6. Client (`m59-client.mjs`)

**Owns**: The TCP connection. All packet parsing. All state.

**Does**:
- Maintains the TCP socket to the server
- Parses every incoming packet (`BP_*`)
- Maintains the room state (`room.objects`, `room.exits`)
- Maintains the character state (`self`, `vitals`)
- Tracks `_lastContentsRoom`, `_lastMoveRoom`, `_roomStamp`
- Emits events upward (`room-contents`, `stat`, `said`, `equipped`, ...)
- Sends commands downward (`REQ_MOVE`, `REQ_ATTACK`, `REQ_CAST`, ...)
- Rate-limits actions to ~5/second (the pacer)

**Contract with the layer below**: The client sends `REQ_*` packets to the
server and receives `BP_*` packets. It is the only layer that touches the
network.

**Contract with the layer above**: The client exposes `snapshot()`,
`perception()`, `vitals()`, `roomContents()`, `confirmPosition()`. The
keeper and mover read from these. The client does NOT make decisions — it
only reports state and sends commands.

**Key files**: `m59-client.mjs`

---

### 7. Server (blakserv)

**Owns**: The game world. All characters, all rooms, all monsters.

**Does**:
- Runs the Meridian 59 game server
- Validates (or doesn't validate) player positions
- Sends `BP_*` packets to all connected clients
- Receives `REQ_*` packets from clients

**Key insight**: The server does NOT validate user positions against room
geometry (`util.kod` skips `ReqSomethingMoved` for `&User`). This is why
the client must validate positions and recover from bad arrivals.

**Key files**: (server source at `M59_ROOT`, not in this repo)

## The data files

| File | What | Built by |
|------|------|----------|
| `substrate/m59-map.json` | Room graph (264 rooms, 982 exits) | `m59-map.mjs build` |
| `substrate/m59-routes.json` | Baked routes (16,494) | `m59-routebake.mjs` |
| `substrate/m59-safespots.json` | Safe spots per room | `m59-safespots.mjs` |
| `substrate/m59-codeexits.json` | Region-based exits | Manual |
| `substrate/fleet-state.json` | Roster (gitignored) | Broker |
| `substrate/loadouts/<char>.json` | Per-character policy | `autopilot set` |

See [[MAP-ROUTES]] for details on the map and routes.

## The broker

The broker (`m59-broker.mjs`) is the single process that manages the fleet:
- **Sessions**: One `M59Client` per character
- **Policy**: Reads from loadout files, writes via `autopilot set`
- **Rejoin**: Every 45s, re-logs dropped characters (unless `leave`d on purpose)
- **HTTP API**: :8901 (JSON-RPC MCP), :8902 (dashboard)
- **Ledger**: 5-minute samples → `substrate/ledger/<fleet>.jsonl`

Started by `m59-service.mjs` (detached, pid file, log in `substrate/broker-<fleet>.log`).

See [[FLEET-OPS]] for how to manage the fleet.

## Key dependencies

| Dependency | What | If missing |
|------------|------|------------|
| `M59_ROOT` | Path to Meridian 59 source tree | `.roo` files not found → map build fails |
| Admin socket | Server endpoint for room data | Only 26/256 `.roo` filenames resolved |
| `M59_MAP` | Path to `m59-map.json` | Map not found → routing fails |
| Docker | For running blakserv | Can't run the server |

## Links

- [[MOVEMENT]] — how movement works (airlock, room stamp, setRun)
- [[COMBAT]] — how combat works (fight, flee, rest)
- [[MAP-ROUTES]] — how the map and routes work
- [[FLEET-OPS]] — how to manage the fleet
- [[TRAPS]] — what can break
- [[PROTOCOL]] — the wire protocol
- [[FILES]] — what each file does
