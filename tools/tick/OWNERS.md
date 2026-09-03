# OWNERS — the tick driver's boundary

This folder is **ours**: the tick driver. The files in `tools/` (outside this
folder) are the legacy keeper and the shared layer. This manifest is the answer
to "whose is this?" — read it before you touch a file.

## Ours (in `tools/tick/`)

The tick driver's decision loop and movement. Only the tick driver imports these.

| file | what it is |
|---|---|
| `m59-tick.mjs` | the 10Hz `TickLoop` + the `Actuator` (fire-and-forget sends) |
| `m59-decide.mjs` | `makeDecider` — the goal ladder (the brain) |
| `m59-mover.mjs` | the fine-model `Mover` (one legal step per tick) |
| `m59-route.mjs` | the `Router` (room-to-room legs, drives the `Mover`) |
| `m59-combat.mjs` | the `CombatController` (facing, zapping, weapon choice) |

## Shared (in `tools/`, read by the tick driver, **do not modify for tick work**)

The tick driver imports these. They are also imported by the legacy keeper and
other tools. A change here is a **two-system** change — coordinate it.

| file | what it is | imported by tick via |
|---|---|---|
| `m59-roo.mjs` | geometry, protocol conversion, the fine path | `m59-mover`, `m59-route`, `m59-combat`, `m59-decide` |
| `m59-navgeom.mjs` | the height model + lenient fine path (installed onto `RoomGeometry`) | `m59-mover`, `m59-combat`, `m59-decide` |
| `m59-map.mjs` | `loadMap`, `findPath`, `buildReverseEdges` | `m59-route`, `m59-decide` |
| `m59-parse.mjs` | `affordances`, `KOD_FINENESS`, object parsing | `m59-decide`, `m59-worldstate`, `m59-skills` |
| `m59-session.mjs` | the `Session` + `Pacer` | `m59-keeper-process` |
| `m59-routes.mjs` | `attachStepMasks` | `m59-keeper-process` |
| `m59-skills.mjs` | skill/item/weapon logic (shared with the legacy keeper) | `m59-worldstate`, `m59-decide` |
| `m59-worldstate.mjs` | `evaluate` — the world-state snapshot (shared with the GOAP keeper) | `m59-decide` |
| `m59-act/` | the atomic actions (`equip`, `eat`, `cast`, `escape-pocket`, …) | `m59-decide` |

## Legacy (in `tools/`, **never touch for tick work**)

The legacy keeper and its support. A parallel effort. The tick driver does not
import these.

| file | what it is |
|---|---|
| `m59-autopilot.mjs` | the 16K-line legacy keeper (the "old brain") |
| `m59-keeper-goap.mjs` | the GOAP keeper (the experimental/blocking variant) |
| `m59-game.mjs` | the 7,300-line legacy `Session` (the "old body") |
| `m59-bt-*.mjs` | the legacy behaviour-tree atomics |
| `m59-goap-run.mjs` | the GOAP runner |

## The dispatcher

`tools/m59-keeper-process.mjs` is the one file that imports **both** sides. It
dispatches on `entry.autopilot.mode`:

- `mode === 'tick'` → the tick driver (imports from `./tick/`)
- otherwise → the legacy keeper (imports `m59-autopilot.mjs`)

A change to the dispatcher is a two-system change.

## The rule

**A change that leaves the tick driver still calling `session.walkTo` /
`session.travel` / `session.leaveVia` for its own movement is not a tick-driver
change — it's a shared-layer change.** The tick driver's movement should live in
`tools/tick/` (`m59-mover.mjs`, `m59-route.mjs`). If you find yourself editing
`m59-game.mjs` or `m59-roo.mjs` to fix tick-driver movement, stop — that's the
shared layer, and the fix belongs in the tick driver's own mover.
