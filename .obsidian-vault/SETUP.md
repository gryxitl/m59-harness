# Setup

> How to get a working dev environment. When you're starting fresh, start here.

## The quick start (10-15 minutes)

```bash
# 1. Check what's missing
node tools/setup.mjs doctor

# 2. Clone + build + run server, start broker, make 10 characters
node tools/setup.mjs all 10
```

Ten to fifteen minutes, mostly compiling. Every step is idempotent.

## The individual steps

| Step | Command | What it does |
|------|---------|-------------|
| 1 | `node tools/setup.mjs server` | Clones + builds + runs `blakserv` in Docker |
| 2 | `node tools/setup.mjs client` | Finds a Steam install (cannot install one) |
| 3 | `node tools/setup.mjs broker` | MCP broker on 8901, dashboard 8902 |
| 4 | `node tools/setup.mjs fleet 10` | Creates 10 characters |

## Step 1: The server

```bash
node tools/setup.mjs server
```

- Clones `Meridian59/Meridian59` (upstream) by default
- Builds the server (compiling, ~10 minutes)
- Runs `blakserv` in Docker
- Sets `[Channel] Flush` to `Yes` (so server logs are written)

**Either server tree works:**
- `Meridian59/Meridian59` (upstream) — default
- `tpeppers/Meridian59-deck` (public fork, gamepad + Steam Deck support) — set `M59_ROOT` to prefer it

**Docker's daemon is separate from its CLI.** `docker --version` succeeding proves nothing can be built. If the daemon is down, ask the user to start Docker Desktop rather than starting it yourself.

## Step 2: The client

```bash
node tools/setup.mjs client
```

- Finds a Steam install of Meridian 59
- **Cannot install one** — if it finds nothing, give the user https://store.steampowered.com/app/893390/Meridian_59/ and carry on

**The client is optional for a fleet.** Agents log in over the wire; no `Meridian.exe` is involved. It's for watching the fleet and for compendium art. A missing client does not block anything.

**Steam cannot be automated.** It will not install a game the user does not own or log in for them. Do not script a Steam login or fetch the client from anywhere else.

## Step 3: The broker

```bash
node tools/setup.mjs broker
```

- Starts the MCP broker on port 8901
- Starts the dashboard on port 8902
- Sets `M59_ROOT` and `M59_MAP` in the startup environment

**Start it this way rather than by hand.** A broker started from a terminal belongs to that terminal. Use `m59-service.mjs` for a detached process with a pid file and log.

## Step 4: The fleet

```bash
node tools/setup.mjs fleet 10
```

- Creates 10 characters
- **Do NOT create characters by hand** — use `m59-makefleet.mjs`
- `create automated` makes a character with ZERO in every attribute (capped at 102 max HP for ever)

## After setup

```bash
# Check what fleet you're looking at
node tools/m59-which.mjs

# Check where all the characters are
node tools/m59-check-positions.mjs

# Check the broker status
node tools/m59-service.mjs status --fleet prod

# Follow the broker log
node tools/m59-service.mjs logs --fleet prod --follow
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `docker --version` works but build fails | Docker daemon is down | Start Docker Desktop |
| `setup.mjs client` finds nothing | No Steam install of Meridian 59 | Give the user the Steam URL |
| Characters have 102 max HP | Created with `create automated` (ZERO attributes) | Re-roll (manual only) |
| Server logs are 0 bytes | `[Channel] Flush` is `No` | Set it to `Yes` in the container |
| Broker comes up empty | Second broker spawned (lock refused) | Use `m59-mcp-attach.mjs` |

## Links

- [[FLEET-OPS]] — how to manage the fleet
- [[ENV-VARS]] — the environment variables
- [[TRAPS]] — setup-related traps
