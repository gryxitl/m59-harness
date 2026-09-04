# Tick Brain — Position Truth Audit

Why this exists: the tick brain was drawing "where am I" from five places that
disagree, and the disagreement was the single biggest cost of debugging (stale
`c.self` vs live room objects ate an hour; the (58,7)-vs-(31,43) split ate another).
This document names each source, its staleness mode, and the evidence, so the Pose
module can replace them with one.

## The five sources

### 1. `client.self` — a GETTER, not a field
`tools/m59-client.mjs:486`
```js
get self() { return this.selfId ? this.room.objects.get(this.selfId) : undefined; }
```
**Staleness mode:** none on its own — it is a live lookup into `room.objects`.
The "stale c.self" symptom was NOT this getter being stale; it was the *underlying
`room.objects` entry* being absent (selfId not yet bound, or object not yet in the
map) so the getter returned `undefined` and a fallback kicked in. The `predicted`
flag on the returned object is the one real signal: it is set by `predictSelf()`
(client-side prediction) and cleared by the BP_MOVE handler (`m59-client.mjs:1357`),
so `predicted === true` means "we think so, server hasn't confirmed yet."

### 2. `room.objects.get(selfId)` — the live store
`tools/m59-client.mjs:1357` (BP_MOVE), `:1340` (CREATE)
Updated on every server move packet and on object creation. This is the authoritative
server-truth position. **Staleness mode:** lags the local sim by ~1/s (server echo
cadence); during a fast walk it trails the dead-reckoned position.

### 3. `frame.position` — the Sensor's read
`tools/tick/m59-tick.mjs:116-125`
Reads `c.self`, then falls back to `room.objects.get(selfId)`. Because source 1 IS
source 2, the "live first" fallback in the Sensor is currently a no-op that just
re-reads the same store. **Staleness mode:** inherits source 2. This is the source
the Mover/Router/Decide/Combat all *should* read.

### 4. `_simX/_simY` — the Mover's dead-reckoning
`tools/tick/m59-mover.mjs` (local sim, official-client model)
Advances on every send; expires to server truth after ~2s; cleared on reset/teleport/
blink/room change. **Staleness mode:** leads source 2 by the walk distance since the
last server echo; correct by construction (server is client-authoritative, no geometry
check on user moves) but can drift if a move is silently refused.

### 5. `me` param / `effMe` — the value threaded into tick
The `me` object passed into `Mover.tick()` and the `effMe` the Mover computes.
Currently a mix of source 3 and source 4. **Staleness mode:** whatever the caller
passed — this is where the five-source tangle actually lives, because each layer
re-derives `me` from a different combination.

## The real problem
Sources 1 and 2 are the same store. The tangle is that **each of the five tick files
re-derives "where am I" from a different combination of {frame.position, sim, the
`me` param, direct `c.self` reads}**, so when they disagree there is no single place
to look. The fix is not "prefer live over stale" (they're the same thing) — it is
**one Pose object, owned by the tick, that reconciles the sim (source 4) with the
server echo (source 2) and is the ONLY thing the other four read.**

## Target
`tools/tick/m59-pose.mjs` — a `Pose` that:
- holds `server` (from room.objects, provenance `predicted`) and `sim` (dead-reckoned)
- exposes `current()` = sim while fresh (<2s), else server, with a `stale` flag
- is updated by the Sensor each frame and by the Mover on each send
- is the single read for Sensor, Mover, Router, Decide, Combat
- no direct `c.self` / `room.objects` position reads remain in `tools/tick/`
