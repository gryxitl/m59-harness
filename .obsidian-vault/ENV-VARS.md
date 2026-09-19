# Environment Variables

> The environment variables. When you need to know what must be set, start here.

## Required

| Variable | What it does | Where it's set | If missing |
|----------|-------------|----------------|------------|
| `M59_ROOT` | Path to the Meridian 59 source tree | `m59-service.mjs` (broker startup) | `.roo` files not found → map build fails |
| `M59_MAP` | Path to `m59-map.json` | `m59-service.mjs` (broker startup) | Map not found → routing fails |

## Optional

| Variable | What it does | Default | Where it's set |
|----------|-------------|---------|----------------|
| `M59_HOST` | The server host | `127.0.0.1` | `m59-client.mjs` |
| `M59_FLEET` | The fleet name | `substrate/fleet-default` | `m59-broker.mjs` |
| `M59_REAGENT_SHOP_ROOM` | The reagent shop room | (none) | `m59-decide.mjs` |
| `M59_REJOIN` | Enable/disable rejoin | `1` (enabled) | `m59-broker.mjs` |

## The `M59_ROOT` trap

**`M59_ROOT` must be set in the broker's startup environment.** If it's not set:
- `.roo` files not found
- Map build fails
- Only 26/256 `.roo` filenames resolved (admin socket fallback)

**Fix:** Set `M59_ROOT` in `m59-service.mjs`:
```javascript
const env = { ...process.env, M59_MAP: mapFile, M59_ROOT: process.env.M59_ROOT || '/Users/costas/Documents/Projects/Meridian59' };
```

## The `M59_FLEET` resolution

The fleet name resolves in this order:
1. `--fleet` flag (command line)
2. `M59_FLEET` environment variable
3. `substrate/fleet-default` (one line, gitignored, what this checkout cares about)
4. The unnamed `substrate/fleet-state.json`

`--fleet -` asks for the unnamed one on purpose.

**Check with:** `node tools/m59-which.mjs`

## The `M59_REJOIN` flag

`M59_REJOIN=0` (or `--no-rejoin`) disables the broker's rejoin logic.
Without it, the broker rejoins dropped sessions every 45s.

## Setting environment variables

### For the broker (via `m59-service.mjs`)

The broker's startup environment is set in `m59-service.mjs`:
```javascript
const env = {
  ...process.env,
  M59_MAP: mapFile,
  M59_ROOT: process.env.M59_ROOT || '/Users/costas/Documents/Projects/Meridian59',
};
```

### For a one-off command

```bash
M59_ROOT=/Users/costas/Documents/Projects/Meridian59 node tools/m59-map.mjs build
```

### For the current shell

```bash
export M59_ROOT=/Users/costas/Documents/Projects/Meridian59
export M59_MAP=substrate/m59-map.json
```

## Debugging environment variables

```bash
# Check what M59_ROOT is set to
echo $M59_ROOT

# Check what the broker's environment is
cat substrate/broker-prod.log | grep -i "M59_ROOT\|M59_MAP"

# Check the broker's startup command
cat substrate/broker-prod.pid  # (the pid file)
ps aux | grep m59-broker  # (the running process)
```

## Common symptoms

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `.roo` files not found | `M59_ROOT` not set | Set `M59_ROOT` in `m59-service.mjs` |
| Map not found | `M59_MAP` not set | Set `M59_MAP` in `m59-service.mjs` |
| Wrong fleet | `M59_FLEET` not set, or `--fleet` flag wrong | Check `m59-which.mjs` |
| Characters not rejoining | `M59_REJOIN=0` | Set `M59_REJOIN=1` (or remove the flag) |

## Links

- [[FLEET-OPS]] — how to manage the fleet
- [[MAP-ROUTES]] — how the map is built
- [[TRAPS]] — environment-related traps
