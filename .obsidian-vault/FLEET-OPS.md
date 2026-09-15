# Fleet Operations

> How to manage the fleet. When you need to start, stop, restart, or change policy, start here.

## The commands

```bash
# What fleet am I looking at? What's the broker holding?
node tools/m59-which.mjs

# Start the broker (detached, survives this terminal)
node tools/m59-service.mjs start --fleet prod

# Check the broker status
node tools/m59-service.mjs status --fleet prod

# Restart the broker (picks up code changes)
node tools/m59-service.mjs restart --fleet prod

# Stop the broker (logs out every character)
node tools/m59-service.mjs stop --fleet prod

# Follow the broker log
node tools/m59-service.mjs logs --fleet prod --follow

# Shut down the server (SAFELY — never a bare docker stop)
node tools/m59-shutdown.mjs

# Check where all the characters are
node tools/m59-check-positions.mjs
```

## The broker

**File**: `tools/m59-broker.mjs`
**Port**: :8901 (JSON-RPC MCP), :8902 (dashboard)
**Log**: `substrate/broker-<fleet>.log`
**PID**: `substrate/broker-<fleet>.pid`

### What the broker does

- **Sessions**: One `M59Client` per character
- **Policy**: Reads from loadout files, writes via `autopilot set`
- **Rejoin**: Every 45s, re-logs dropped characters (unless `leave`d on purpose)
- **HTTP API**: :8901 (JSON-RPC MCP), :8902 (dashboard)
- **Ledger**: 5-minute samples → `substrate/ledger/<fleet>.jsonl`

### The rejoin logic

The broker rejoins sessions that drop, every 45s. It will NOT:
- **Undo a `leave`** — without `forget`, that means "out until a restart"
- **Fight a human** — one connection per character; a click-to-play bumps the broker off
- **Restore orders that were stopped on purpose** — it restarts the keeper that was running

## Policy

### The source of truth

| Data | Source of truth | File |
|------|----------------|------|
| Standing preferences (POLICY_KEYS) | **Loadout** | `substrate/loadouts/<char>.json` |
| Everything else (protected faculties) | **Roster** | `substrate/fleet-state.json` |

### Setting policy

```bash
# Via the broker API (writes BOTH loadout and roster)
curl -s -X POST http://127.0.0.1:8901/autopilot \
  -d '{"agent":"t4","action":"set","key":"assignedRoom","value":1016}'

# Via the MCP tool
autopilot set t4 assignedRoom 1016
```

**`autopilot set` writes both the loadout (for POLICY_KEYS) and the roster.**
This prevents drift between the two.

### POLICY_KEYS

The keys that are stored in the loadout (per-character standing preferences):
- `hunt` — what to hunt
- `assignedRoom` — which room to go to
- `fightRounds` — how many rounds to fight
- `restBelow` — rest threshold
- `fleeBelow` — flee threshold
- `bankAbove` — bank threshold
- `buyFood` — whether to buy food
- `roam` — whether to roam
- `partner` — partner character
- `threatCeiling` — max threat level

## The roster

**File**: `substrate/fleet-state.json` (gitignored)
**What**: Character name, password, HP, pack, room, policy

**NEVER delete this file.** It's the only record of the account passwords.

## The loadout

**File**: `substrate/loadouts/<char>.json`
**What**: Per-character gear/reagent targets, standing preferences

## Making a fleet

```bash
# Create 10 characters
node tools/m59-makefleet.mjs 10

# Do NOT create characters by hand — use m59-makefleet.mjs
# (create automated makes a character with ZERO in every attribute)
```

## Setup

```bash
# Check what's missing
node tools/setup.mjs doctor

# Clone + build + run server, start broker, make 10 characters
node tools/setup.mjs all 10

# Individually:
node tools/setup.mjs server   # clone + build + run blakserv in Docker
node tools/setup.mjs client   # find a Steam install (cannot install one)
node tools/setup.mjs broker   # MCP broker on 8901, dashboard 8902
node tools/setup.mjs fleet 10 # create 10 characters
```

## Debugging fleet ops

```bash
# Check the broker's view of the fleet
curl -s http://127.0.0.1:8901/fleet | python3 -m json.tool

# Check a specific character
curl -s http://127.0.0.1:8901/snapshot?t1 | python3 -m json.tool

# Check the broker log
tail -50 substrate/broker-prod.log

# Check if the broker is running
node tools/m59-service.mjs status --fleet prod
```

### Common symptoms

| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| Character logged out | Broker restarted, or `leave` was called | Broker log, rejoin logic |
| Policy not taking effect | Loadout/roster drift | `autopilot set` (writes both) |
| Broker not running | Crashed, or never started | `m59-service.mjs status` |
| Characters not moving | Keeper crashed | Broker log, keeper process |
| Wrong fleet | `--fleet` flag or `M59_FLEET` env | `m59-which.mjs` |

## Links

- [[ARCHITECTURE]] — the big picture
- [[TRAPS]] — fleet-related traps
- [[FILES]] — what each file does
