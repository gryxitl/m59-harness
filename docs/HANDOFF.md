# Session Handoff — Meridian 59 Fleet Viability

## Goal
Make the Meridian 59 fleet operationally viable: characters should kill monsters, buy equipment, and level up. The user's core complaint: "this is a game from 1995 defeating us." Characters must not fight players.

## Constraints & Preferences
- Commands run from `/Users/costas/Documents/Projects/m59-harness`; `substrate/keeper-t{1..5}.log` + `substrate/broker-default.log` are the state sources.
- **Back up logs before every restart** — restarts truncate `keeper-*.log` in place. Pattern: `TS=$(date +%Y%m%d-%H%M%S); mkdir -p /tmp/keeper-logs-$TS; cp substrate/keeper-*.log /tmp/keeper-logs-$TS/`.
- **Port mapping**: t1→8911, t3→8912, t4→8913, t5→8914, t2→8915. Verified from `substrate/broker-default.log` `[keeper] spawned` lines.
- **Fleet is "default"** (unnamed), 5 characters, broker on 8901. Verified via `node tools/m59-which.mjs`.
- **`substrate/keeper-t*.log` is append-mode with no rotation (>276MB for t4).** Use byte-offset recipe: `wc -c` at generation start, then `tail -c +<off+1> | grep -c` for the window. `grep` only reads the first 4MB; `tail -c 2000000` reads the wrong region on 400MB+ files.
- **The user is frustrated with looping/going in circles.** Be direct, make progress, don't re-analyze the same issue repeatedly.
- **Characters must not fight players.** The `is_player === false` check + `how === 'generator'` compendium filter prevent this.
- **`m59-decide.mjs` imports only `{ trustedBuyer }` from `../m59-skills.mjs`** — `skills` is NOT a defined symbol in that file. Any `console.error` template that references `skills.isArmed(...)` throws a ReferenceError and kills the tick's decision loop.
- **`substrate/history/fleet-2026-09-14.jsonl` mixes two fleets** — `m59-fleetpath.mjs:113-116` returns plain `substrate/history/` when `M59_FLEET` is unset. Per-character trends from that file are unreliable.
- **`substrate/tougher/*.json` keys on in-world names** (Gountrug.json, Kage.json, Sasquatch.json) and holds `gains` (max-HP points) only — no kill tally. The `player_improve_maxhealth` announcement is the only server-authoritative, non-duplicable progress signal.

## Progress
### Done
- [x] **`_packWeapon` disjunct removed from `armed` goal** — `tools/tick/m59-decide.mjs:2977`. The `_packWeapon` disjunct made the `armed` goal fire even when `ws.armed=true`. Characters were stuck in `armed` for 30+ minutes instead of hunting.
- [x] **`ZAP_ON` regex fixed** — `tools/m59-zap.mjs:31`: now matches both "sparks jump and crackle" AND "crackle with blue energy". The old regex only matched one, so `zapStatus()` reported `active:false` forever.
- [x] **Mana check added to `shouldCastZap`** — `tools/m59-zap.mjs:152-154`. `findZapSpell` now returns `{ id, name, mana }`.
- [x] **Zap-cast guard added to `_maybeReequip`** — `tools/tick/m59-combat.mjs:712`: prevents the cast/reequip collision.
- [x] **Reequip cooldown added** — `tools/tick/m59-combat.mjs:711,723`: 30s cooldown.
- [x] **Combat classifier extended** — `tools/m59-client.mjs:1016-1024`: now recognizes "slaps", "killed", "wounded", "valiantly slain", "damaged". The old classifier was matching none of the actual phrasing.
- [x] **Kill routing into ledger via `combatLog` entry stamping** — `tools/tick/m59-combat.mjs:235-256`: stamps `e.ledgered = 'killed' | 'died' | 'skip'` on each entry so it's processed exactly once.
- [x] **Kill attribution fixed** — uses `c.me?.name ?? this.session?.name` (character name, not keeper name). Matches `m59-tougher.mjs` keying.
- [x] **`room_num` fixed** — `tools/tick/m59-combat.mjs:253`: added `this.session?.world?.room?.num` as fallback.
- [x] **Creature extraction made case-insensitive** — `tools/tick/m59-combat.mjs:238-248`: matches both first-person and third-person forms. Third-person gated on actor (`thirdPerson[1] === charName`).
- [x] **`died` event added to ledger** — `tools/tick/m59-combat.mjs:257-270`: classifies `### X was just killed by Y` as `kind:'died'`, captures victim and killer.
- [x] **`flee_hurt` relaxed** — `tools/tick/m59-decide.mjs:2895`: `ws.below_flee === true && (ws.has_target === true || (ws._mobCount ?? 0) > 0)`. The old `in_reach === true` requirement left a gap.
- [x] **Kill drain skip made observable** — `tools/tick/m59-combat.mjs:244,249`: `[kill-skip]` log for skipped entries.
- [x] **`buy_next_planned_skills` fixed for keeper-backed characters** — `tools/m59-broker.mjs:8365`: `KeeperProxy` guard skips the forced refresh.
- [x] **Travel timeout in outfit fixed** — `tools/m59-outfit.mjs:266`: 30s → 180s.
- [x] **Outfit lease raised** — `tools/m59-outfit.mjs:950`: 120s → 300s.
- [x] **Router A1-A4 already in code** — re-entry arrival, cross-room oscillation breaker, route-drop TTL memory, debug gate. All verified in `tools/m59-route-test.mjs` (57 passing).
- [x] **Decider B1-B4 already in code** — route-drop memory respect, hunt repick floor, `_fight` gate redefinition, GOAP reporting.
- [x] **Tests passing** — 106/106 in `m59-decide-test.mjs`, 57/57 in `m59-route-test.mjs`.

### In Progress
- [ ] **A1 verified working** — 36 total arrivals (t2: 2, t3: 9, t4: 17, t5: 8) in 25-min V-live window. Zero oscillation, zero route drops.
- [ ] **A2 unexercised** — fleet never crossed 200↔556 edge in the observation window.

### Pending
- [ ] **"Buy equipment" unaddressed** — zero `bought` events in `substrate/history/fleet-2026-09-14.jsonl` all session.
- [ ] **"Level up" unaddressed** — `ready_to_learn` stays unsent. `buy_next_planned_skills` now works but characters need more points (e.g. "brawling still needs 176 point(s)").
- [ ] **t4's ceiling 20, below peers' 26–28** — cause unattributed. No death count measurement for t4 in this session.
- [ ] **Kill count is not reliable** — the 500-entry `combatLog` ring is shared by 5 characters. First-person kill prose is sent only to the victim's own client and carries no name. The kill count is a floor with unknown confidence.
- [ ] **Death count is an artifact** — the `### X was just killed by Y` line is sent only to the dying player's own client, after the server has already moved them to the Underworld. The `room_num` values in the ledger are where the character happened to be after respawning, not where they died.
- [ ] **`m59-client.mjs` has zero test coverage** — the combat classifier (`_noteCombatOutcome`) is the single function both the ledger and the `tougher` attribution key off, and it has no tests.

## Key Decisions
- **`_packWeapon` disjunct removed**: The `armed` goal's `when` was `ws => (ws.armed === false || ws._packWeapon === true) && ...`. The `_packWeapon` disjunct made the goal fire even when `ws.armed=true`. Fixed by removing the disjunct.
- **`ZAP_ON` regex fixed**: The server sends two different ON phrases. The old regex only matched one. Fixed to match both.
- **Combat classifier extended**: The server says "Your punch slaps" and "You killed" — not "hits"/"misses". The old classifier was matching none of the actual phrasing.
- **Kill routing via entry stamping**: Replaced HWM approach (which had ordering bugs) with `e.ledgered` stamping. Each entry is processed exactly once regardless of timestamp ordering.
- **Kill attribution uses character name**: `c.me?.name ?? this.session?.name` matches `m59-tougher.mjs` keying.
- **Third-person kill filter gates on actor**: `"X has valiantly slain Y"` is the room announcement our own kill produces. Filter by `thirdPerson[1] === charName`, not by dropping the line entirely.
- **`flee_hurt` relaxed to fire when mobs present**: The old `in_reach === true` requirement left a gap. Now fires when `below_flee && (has_target || _mobCount > 0)`.
- **`buy_next_planned_skills` KeeperProxy guard**: The `force:true` refresh routes into `readLive` which hits the KeeperProxy throw-stub. Skip the forced refresh for KeeperProxy sessions and rely on the push-maintained cache.

## Critical Context
- **Fleet state (23:22, final read)**:
  ```
  t1: hp=15/25 goal=None
  t2: hp=26/26 goal=healthy
  t3: hp=28/28 goal=hunt
  t4: hp=20/20 goal=healthy [FROZEN — acked, not readback-verified; _inert is process-local, broker rejoin clears it]
  t5: hp=25/26 goal=hunt [FROZEN — acked, not readback-verified; _inert is process-local, broker rejoin clears it]
  ```
  All characters at or near full HP. t4 and t5 freeze acked but not readback-verified (in-memory flag, cleared by broker rejoin).

- **V-live results (25-min window, broker pid 56557)**:
  - A1 (re-entry arrival): 36 total arrivals (t2: 2, t3: 9, t4: 17, t5: 8)
  - A2 (cross-room oscillation breaker): unexercised — fleet never crossed 200↔556
  - t2's flap: 1176 `move-sent` in window (~1/s, near-saturation). `aim=` jumps ~37 squares between n=22 and n=23 — destination churn (goal/hunt repick), not send reversal. `srv=864,160` (Underworld respawn) accounts for 146 of 1176 sends. `stride-declaration` dominates the 544 stretch.
  - t4: ceiling 20, below peers' 26–28. Cause unattributed.
  - Freeze stops locomotion; recovery not attributed. HP moved in both directions regardless of freeze state (t1 unfrozen fell 20→15, t3 unfrozen rose 26→28, t2 revived early and climbed 4→26 while running).

- **Kill ledger (88 kills / 5 deaths)**:
  - Kill count is a floor with unknown confidence (first-person prose has no name to validate against)
  - Death count is an artifact (broadcast only to dying client, room is post-respawn location, restarts lose deaths)
  - `substrate/tougher/*.json` gains are the only trustworthy progress signal

## Next Steps
1. **Outfit's teacher errand never completing a buy within its own lease** — the travel timeout (180s) and lease (300s) are set, but the errand still times out. `aim=` jumps between distant pairs — goal/hunt repick rewriting the target every few seconds. `stride-declaration` dominates, not `walk-past-boundary`/`escape-fan-probe`.
2. **`bought` events still zero** — the buy path is not producing any `bought` events in the ledger. The `buy_next_planned_skills` tool now returns a real preflight reason ("brawling still needs 176 point(s)"), but the outfit errand's buy path is separate and still not working.
3. **t4's ceiling 20, below peers' 26–28** — cause unattributed. No death count measurement for t4 in this session. Route to a weaker-mob room if the ceiling continues to drop.
4. **Investigate t2's flap** — 1176 `move-sent` in 25 min (~1/s, near-saturation). `aim=` jumps between distant pairs (n=22 aim=2092,3195 → n=23 aim=3296,1952) — goal/hunt repick rewriting the target every few seconds. `srv=864,160` (Underworld respawn) accounts for 146 of 1176 sends. `stride-declaration` dominates the 544 stretch.
5. **`/state` now reports `inert`** — added `inert: !!(session._tickLoop?._inert || session._inert)` to `state()`. Previously the field was missing, so a freeze was unverifiable from the endpoint. Verify by checking `inert: true` after a freeze and `inert: false` after a revive.
6. **Add test coverage for `m59-client.mjs`** — the combat classifier has zero tests. Pin the kill/death regexes in a new `tools/m59-client-test.mjs`.
7. **Add the out-of-reach `flee_hurt` test case** — `m59-decide-test.mjs:372,515` only tests `in_reach: true`. Add a case with `in_reach: false` and `_mobCount: 1`.
