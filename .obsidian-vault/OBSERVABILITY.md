# Observability

> The dashboard, ledger, and postmortems. When you need to understand what the fleet is doing, start here.

## The dashboard

**URL**: `http://127.0.0.1:8902` (loopback only)

The dashboard shows:
- **Fleet**: All characters, their health, position, goal, stuck state
- **Economy**: Purse, bank, spending per character
- **Skills**: Skill levels per character
- **Deaths**: Recent deaths, with postmortems
- **Uptime**: How long each character has been in-game
- **Pulse**: Health checks (is the broker alive? are the keepers running?)

### The fleet page

The fleet page shows one row per character:
- **Name**: Character name
- **Health**: Current HP / max HP
- **Position**: Room, col, row
- **Goal**: Current goal (hunt, flee, travel, rest, fight)
- **Stuck**: Whether the character is stuck (and for how long)
- **Path**: The current path (if moving)
- **Dest**: The destination (if moving)

### The buttons (loopback only)

The fleet page carries **Rejoin / Restart / Stop** buttons when opened on
`127.0.0.1`. These are:
- **Rendered only for loopback** (not for remote clients)
- **Refused at the socket** for non-loopback POSTs (a hidden button is not a permission check)

There is **no Start button** — when the broker is down, nothing is serving the page.

## The ledger

**File**: `substrate/ledger/<fleet>.jsonl`

The ledger records 5-minute samples of:
- **Health**: Current HP / max HP
- **Activity**: What the character was doing (hunt, flee, travel, rest)
- **Kills**: Number of kills in the last 5 minutes
- **Purse**: Current gold
- **Pack**: Number of items in the pack

### Kill attribution

Kills are attributed to specific events (not just a diff). The ledger records:
- **Who** was killed
- **By whom** (the killer)
- **Where** (the room)
- **When** (the timestamp)

### Tougher events

Max-health gains are recorded as "tougher" events, with kill attribution:
- **What**: Max HP increased by X
- **Why**: Killed a tough monster
- **Where**: The room
- **When**: The timestamp

## The postmortems

**Directory**: `substrate/postmortems/`

When a character dies, a postmortem is written:
- **What killed it**: The killer (from the `killed_by_broadcast` event)
- **Where it died**: The last known position (from the keeper's last frame)
- **When it died**: The timestamp
- **How it died**: The sequence of events (health drops, hits, etc.)

### The 30-second window

`m59-postmortems.mjs` refuses to place a death unless an independent observation
lands within 30 seconds of the killing blow. This prevents "inn deaths" (where
the last frame is stale and the character appears to have died in an inn).

### The "was the keeper up" question

The postmortem answers two questions:
1. **Was the keeper up?** (uptime ledger)
2. **Was the keeper looking?** (blind threshold: `WATCH_MS`, 8s)

A keeper can be "up" but "blind" (not looking at the world). The postmortem
shows `Y 3s` / `Y blind 18s` / `N` rather than a bare Y.

## The observation pages

| Page | URL | What it shows |
|------|-----|---------------|
| Fleet | `:8902/fleet` | All characters, health, position, goal, stuck |
| Economy | `:8902/economy` | Purse, bank, spending per character |
| Skills | `:8902/skills` | Skill levels per character |
| Deaths | `:8902/deaths` | Recent deaths, with postmortems |
| Uptime | `:8902/uptime` | How long each character has been in-game |
| Pulse | `:8902/pulse` | Health checks (broker alive, keepers running) |
| Players | `:8902/players` | All players on the server |
| Hero | `:8902/hero` | A single character's detailed view |

## The watchdog

An independent 500ms timer that:
- Reads health live (server pushes it)
- If health crosses the flee line while the tick is blocked > 3s → calls `cancelMovement()`
- Writes health-change frames even when the tick is blind

The watchdog is the "safety net" — it can interrupt a blocked tick and force
the character to flee.

## Debugging observability

```bash
# Check the dashboard
curl -s http://127.0.0.1:8902/fleet | python3 -m json.tool

# Check the ledger
tail -10 substrate/ledger/prod.jsonl | python3 -m json.tool

# Check the postmortems
ls substrate/postmortems/ | tail -5
cat substrate/postmortems/<latest>.json | python3 -m json.tool

# Check the broker log
tail -50 substrate/broker-prod.log
```

### Common symptoms

| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| Dashboard not loading | Broker not running, or not on loopback | `m59-service.mjs status` |
| Fleet page shows no characters | Broker is empty (second broker spawned) | `m59-which.mjs` |
| Ledger is empty | Broker not running, or no characters in-game | Broker log |
| Postmortem says "inn" | Last frame is stale (keeper was blind) | Blind threshold, 30s window |
| Watchdog not firing | Health not crossing the flee line, or tick not blocked | Watchdog logic |

## Links

- [[FLEET-OPS]] — how to manage the fleet
- [[DEBUGGING]] — the debugging playbook
- [[TRAPS]] — what can break
