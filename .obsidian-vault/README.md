# m59-harness — Start Here

> If you're an agent (or human) working in this repo, read this first.

## What this repo is

A bot that plays Meridian 59 as a real player character. It connects to a `blakserv`
server, controls a fleet of characters, and makes decisions (hunt, flee, travel, rest,
fight) in a real-time 10Hz loop.

## The 30-second orientation

| Question | Answer |
|----------|--------|
| What drives the characters? | The **tick keeper** (`m59-tick.mjs` + `m59-decide.mjs`) |
| What's the old system? | The **legacy keeper** (`m59-autopilot.mjs`) — still used by other fleets |
| Where does movement happen? | `m59-controller-mover.mjs` (airlock, room stamp, force-adopt) |
| Where does the client live? | `m59-client.mjs` (TCP socket, packet parsing, state) |
| Who manages the fleet? | `m59-broker.mjs` (sessions, policy, rejoin, HTTP API) |
| How is the broker started? | `m59-service.mjs` (detached process, pid file, log) |
| Where's the map? | `substrate/m59-map.json` (264 rooms, 982 exits) |
| Where are the routes? | `substrate/m59-routes.json` (16,494 baked routes) |
| What's the source of truth for policy? | The **loadout** file (`substrate/loadouts/<char>.json`) |
| What's the source of truth for the roster? | `substrate/fleet-state.json` (gitignored) |

## The 5 files you'll touch most

1. **`tools/m59-decide.mjs`** — the decision logic. If a character is doing the wrong thing, it's here.
2. **`tools/m59-controller-mover.mjs`** — movement. If a character is stuck, in a wall, or in the wrong room, it's here.
3. **`tools/m59-client.mjs`** — the protocol client. If the character doesn't know where it is, it's here.
4. **`tools/m59-broker.mjs`** — fleet management. If a character is logged out or the policy is wrong, it's here.
5. **`tools/m59-map.mjs`** — the map builder. If a room is missing or an exit is wrong, it's here.

## The 3 commands you'll run most

```bash
# What fleet am I looking at? What's the broker holding?
node tools/m59-which.mjs

# Where are all the characters? Are any stuck?
node tools/m59-check-positions.mjs

# Restart the broker (picks up code changes)
node tools/m59-service.mjs restart --fleet prod
```

## The rules that outrank everything

1. **Never call `leave`** on a fleet anyone cares about — it drops the roster (the only record of passwords).
2. **Never trigger a re-roll** automatically — only via explicit user command.
3. **Never commit** `fleet-state.json`, `fleet-accounts.json`, `history/`, `recordings/`, `commissions/`.
4. **Always use `m59-shutdown.mjs`** to stop the server — never a bare `docker stop`.
5. **Attach to the broker, never spawn a second** — use `m59-mcp-attach.mjs`.

## The notes

| Note | When to read it |
|------|-----------------|
| [[ARCHITECTURE]] | When you need to understand how the pieces fit together |
| [[MOVEMENT]] | When a character is stuck, in a wall, or in the wrong room |
| [[COMBAT]] | When a character is dying, not fighting, or fleeing wrong |
| [[MAP-ROUTES]] | When a room is missing, an exit is wrong, or routing fails |
| [[FLEET-OPS]] | When you need to manage the fleet (start, stop, restart, policy) |
| [[TRAPS]] | When something breaks and you don't know why |
| [[PROTOCOL]] | When you need to understand the wire protocol (BP_* packets) |
| [[FILES]] | When you need to find a specific file |
| [[TESTS]] | When you need to run tests or add a new test |
| [[DEBUGGING]] | When something breaks and you need a cross-domain playbook |
| [[ECONOMY]] | When a character is not buying, selling, or banking |
| [[PROGRESSION]] | When a character is not leveling up, or max HP is dropping |
| [[OBSERVABILITY]] | When you need to understand what the fleet is doing (dashboard, ledger, postmortems) |
| [[GLOSSARY]] | When you see a term you don't know |
| [[KEY-CONSTANTS]] | When you need to know a threshold, timeout, or speed |
| [[ENV-VARS]] | When you need to know what environment variables must be set |
| [[SETUP]] | When you're starting fresh and need a working dev environment |
| [[NEW-FEATURE]] | When you need to add a new goal, action, or policy key |
| [[CODEBASE-MEMORY]] | When you need to query the codebase (15 MCP tools, 3D graph UI) |

## Conventions

- `[[LINK]]` = Obsidian wiki-link to another note
- **BOLD** = important term
- `code` = file name or code reference
- Status tags: FIXED, PRE-EXISTING, OPEN, RESOLVED
