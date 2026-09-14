# Map & Routes

> How the map and routes work. When a room is missing, an exit is wrong, or routing fails, start here.

## The map

**File**: `substrate/m59-map.json`
**Built by**: `node tools/m59-map.mjs build`
**Contents**: 264 rooms, 982 directed exits

### Data sources (in priority order)

1. **Admin socket** — room names, `.roo` filenames, edge exits, go exits
2. **Existing map** — fallback for anything the admin socket doesn't provide
3. **`.roo` files** — collision geometry (needs `M59_ROOT`)
4. **Code exits** — region-based exits (`substrate/m59-codeexits.json`)

### The fallback rule

The map build falls back to the existing map for **ALL data** when the admin
socket doesn't provide it. This protects against upstream changes that break
the admin socket.

### Code exits

Region-based exits (e.g., Marion→534) are defined in `substrate/m59-codeexits.json`.
They have a `when` condition (e.g., `row < 32 AND col > 66`) and a `trigger_targets`
field (the position to walk to).

**If `trigger_targets` is missing**, the character doesn't know where to walk.
The `codeExits` function in `m59-map.mjs` computes `trigger_targets` from the
`when` condition (e.g., target `{col: 68, row: 30}` for the top-right corner).

### Rebuilding the map

```bash
# Rebuild the map (needs M59_ROOT set)
M59_ROOT=/Users/costas/Documents/Projects/Meridian59 node tools/m59-map.mjs build

# Rebuild the routes (needs the map)
node tools/m59-routebake.mjs

# Rebuild the safe spots
node tools/m59-safespots.mjs
```

## The routes

**File**: `substrate/m59-routes.json`
**Built by**: `node tools/m59-routebake.mjs`
**Contents**: 16,494 baked routes

### How routes are baked

1. For each pair of rooms (A, B), find the shortest path using A*
2. The path goes through a sequence of rooms and exits
3. For each exit, the route records the **anchor** (the square to walk to)
4. The routes are stored as a lookup table: `routes[fromRoom][toRoom] = [hops]`

### Using routes at runtime

When the character needs to go from room A to room B:
1. Look up `routes[A][B]` in `m59-routes.json`
2. Follow the hops: walk to the anchor for each exit
3. Cross the exit (trigger the go-exit or region exit)
4. Repeat until in room B

## The .roo files

**What**: Room geometry files (collision data)
**Where**: `M59_ROOT/resource/rooms/*.roo`
**Parsed by**: `m59-roo.mjs`

### M59_ROOT

- **What**: Path to the Meridian 59 source tree
- **Where**: `/Users/costas/Documents/Projects/Meridian59` (this machine)
- **If not set**: `.roo` files not found → map build fails
- **Fix**: Set `M59_ROOT` in the broker's startup environment (`m59-service.mjs`)

### The 26/256 problem

The admin socket only resolves 26/256 `.roo` filenames. The fix is to fall back
to the existing map's `.roo` filenames when the admin socket is incomplete.

## Debugging map/routing

```bash
# Check if a room exists in the map
node -e "const m=require('./substrate/m59-map.json'); console.log(m.rooms[534])"

# Check if a route exists between two rooms
node -e "const r=require('./substrate/m59-routes.json'); console.log(r[200]?.[534])"

# Check the code exits
cat substrate/m59-codeexits.json | python3 -m json.tool | head -30

# Rebuild the map and routes
M59_ROOT=/Users/costas/Documents/Projects/Meridian59 node tools/m59-map.mjs build
node tools/m59-routebake.mjs
```

### Common symptoms

| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| Room not in map | Admin socket didn't provide it | Map build fallback |
| No route between rooms | Map is disconnected (missing exit) | Map exits, code exits |
| Character can't reach a room | Route exists but anchor is wrong | `trigger_targets`, exit anchors |
| `.roo` files not found | `M59_ROOT` not set | Broker env, `m59-service.mjs` |
| Only 26/256 `.roo` resolved | Admin socket incomplete | Map build fallback |

## Links

- [[ARCHITECTURE]] — the big picture
- [[MOVEMENT]] — how the routes are used at runtime
- [[TRAPS]] — map-related traps
