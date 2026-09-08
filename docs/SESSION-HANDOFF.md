# Session Handoff — for the next agent

Written by the previous session. Read this before touching the fleet or the
movement code. The state below was verified as of writing; re-verify anything
time-sensitive (positions, logs) before acting on it.

## 1. The codebase-memory tools are now native

- The old CLI workflow (guessing `codebase-memory-mcp cli <tool>` names) is **dead**.
  The standalone daemon was killed; the old `cbmem.ts` extension and the old
  `~/.pi/agent/skills/codebase-memory` skill were deleted.
- The `pi-codebase-memory-mcp` package (v0.1.2, reviewed clean before install)
  is installed in `~/.pi/agent/npm/node_modules/`. It spawns the binary over
  stdio itself and registers `cbm_*` tools.
- **First action in a new session:** if `cbm_*` tools are missing, call
  `cbm_connect`. Then `cbm_list_projects` should show `m59-harness`
  (57,620 nodes / 127,458 edges, indexed 2026-09-03). The index is on disk —
  do NOT re-index unless asked.
- Use the graph for structural questions (callers, dependencies, impact);
  fall back to grep for string literals and configs.

## 2. Uncommitted work in the tree (do not lose it)

`git status` at writing showed these modified files — all intentional:

- `tools/m59-decide.mjs` — `is_caster` guard on the `armed` goal (line ~1332:
  `ws.armed === false && ws.is_caster !== true`). `is_caster` is decorated on
  `ws` in the decide loop after `evaluate()`, computed via `loadoutFor()`
  (has schools AND no weapon track). Worldstate stays pure by contract.
- `tools/m59-world.mjs` — code-exit reachability uses `collision: false`
  (coarse view); spiral search for walkable+in-zone trigger target.
- `tools/m59-keeper-process.mjs` — `/path3d` and `/room-view` now fall back to
  the router's travel destination when there is no combat target. **Critical
  detail:** the router's `status()` returns `leg.stand_on` (snake_case) —
  NOT `standOn`. The 3D viewer shows travel targets with `is_travel: true`.
- `tools/m59-game.mjs` — `blockedSquares` dynamic blocking (Set + lastRoomId,
  cleared on room change); debug log statements from that work may still be
  in here — clean before committing.
- `tools/m59-mover.mjs` — `reportIntervalMs` constructor option (default
  `MOVE_INTERVAL_MS = 1000`) so tests can inject 0.
- Test fixes: `m59-breadcrumb-test.mjs` (refusing `walkFine` stub),
  `m59-escape-test.mjs` (no-op `face()` on mock client),
  `m59-fleeline-test.mjs` (grep `m59-watchdog.mjs`), `m59-path-test.mjs`
  (`pathToFileURL`), `m59-roo-test.mjs` (fine-fallback-off assertion).

Offline battery at last run: safespot 183/0, chat 128/0, rest 51/0, ledger 30/0,
escape 87/0, decide 19/0, breadcrumb 51/0, collision 245/0+10 skipped,
worldstate 160/0, loadout 185/0, tick 35/0, mover 14/0, fleeline 21/0,
roo 818/0. (No `timeout` command on macOS — run suites individually.)

## 3. Fleet state (verify before acting)

- Broker: `node tools/m59-service.mjs status --fleet -` (unnamed fleet).
  `M59_ROOT` is set in the service env (added to `m59-service.mjs`).
- Characters: t1 Gountrug, t2 Kage (caster — Shal'ille 6, no weapon track;
  the `armed` goal must NOT fire for him), t3 JayB, t4 Lee (assigned room
  535, giant rats), t5 Sasquatch.
- Kage was last seen traveling Marion (200) → Deep Woods (534) via the code
  exit (trigger zone `row < 32 AND col > 66`).
- **Broker rejoin backoff:** killing a keeper repeatedly makes the broker
  double its rejoin wait (15-min cap). If a keeper won't respawn, do a full
  `m59-service.mjs stop` + `start` to reset the backoff.
- **Fleet-state save merges fields** present on disk but absent in memory
  (fix for the credential-loss bug). `substrate/fleet-accounts.json` is the
  only copy of passwords — never commit, print, or delete it.

## 4. Invariants that are easy to break

- **Stand before casting.** A resting character has `PFLAG_NO_MAGIC`; the
  server refuses the whole cast. `stand()` then wait ~2s before any blink.
  This is currently copy-pasted in 6 files (escape-pocket, autopilot
  blinkFree, decide unstuck, keeper-goap unstuck, mover `_tryBlink`,
  keeper-process /action cast). **Known debt: consolidate into one
  `prepareForCast(session)` helper** — the six 2-second waits will drift.
- **Lifted functions.** `validateFineTarget`, `queueValidatedMove`, `walkTo`,
  `leaveVia`, `travel` in `m59-game.mjs` are lifted out by TEXT for tests.
  A missed lift must throw, not return undefined. Keep their signatures
  stable; verify with `m59-breadcrumb-test.mjs` after edits.
- **Airlock.** On room change ALL movement pauses until
  `_lastContentsRoom === room` (confirmed from `BP_ROOM_CONTENTS`, not
  `_lastMoveRoom`). Room-stamp guard refuses stale moves at send time.
  Force-adopt via explicit `syncFrom(_me)` after release (`ctl.clear()`
  does NOT clear `ctl.x`).
- **Speeds:** walk 18, run 36 (`USER_RUNNING_SPEED` is 36, not 32).
  `setRun` must be called explicitly in the decide loop.
- **No blink while fleeing/combat** (concentration breaks under attack).
- **Map integrity:** no synthetic exits. `m59-map.mjs` falls back to the
  existing map when the admin socket is incomplete.
- **Policy:** loadout = source of truth for `POLICY_KEYS`; roster for
  everything else; `autopilot set` writes both. Only save policy if changed
  (JSON.stringify compare) or the broker loops.

## 5. Open threads

- **Monitor fleet stability:** grep keeper logs for `fine_blocked`,
  `airlock released`, `BAD ARRIVAL`, `blink relocated`.
- **PR #49** (to tpeppers): policy unification + airlock/room-stamp
  reference. **PR #1**: doc updates. Check for feedback.
- **`passFightBack` port** (from upstream): needs `fightBackAfterMs` policy,
  `fightBackDue` state, `refuseEngagement` helper. Not started.
- **Remove debug logs** from the `blockedSquares` work in `m59-game.mjs`
  before committing.
- **`/path3d` path is empty during travel** even though the target beacon
  works: `finePathProtocol` finds no path from the character to the staging
  square (likely collision-model blocking). The beacon + direct line render;
  the waypoint trail does not. Low priority — the beacon is the useful part.
- **Upstream fork** (`tpeppers/m59-harness`): 149 ahead / 265 behind.
  Strategy is PORT, not merge. `trial/merge-upstream-test` branch is
  reference-only — do not ship.

## 6. User preferences (learned the hard way)

- **Do not loop on identical tool calls.** If a grep returns the same
  result twice, change approach (read the file, search elsewhere, ask).
  This session looped on a `grep class tools/m59-client.mjs` and the user
  had to intervene three times.
- Re-rolls are manual only — never trigger them automatically.
- The client (Steam) cannot be automated; it is optional for a fleet.
- Don't present a missing client as blocking.
- Shut down with `node tools/m59-shutdown.mjs`, never bare `docker stop`
  (blakserv has no SIGTERM handler; 180-min save period).
- Attach to the broker, never spawn a second (`m59-mcp-attach.mjs`).
- Never call the `leave` tool on a fleet anyone cares about.
