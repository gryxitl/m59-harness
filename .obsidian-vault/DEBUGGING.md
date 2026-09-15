# Debugging

> A cross-domain debugging playbook. When something breaks and you don't know why, start here.

## The first 3 commands

```bash
# 1. What fleet am I looking at? What's the broker holding?
node tools/m59-which.mjs

# 2. Where are all the characters? Are any stuck?
node tools/m59-check-positions.mjs

# 3. Check the broker log for errors
tail -50 substrate/broker-prod.log
```

## The symptom → diagnosis → fix table

### "Character is not moving"

| Check | Command | If broken |
|-------|---------|-----------|
| Is the broker running? | `node tools/m59-service.mjs status --fleet prod` | Restart the broker |
| Is the character in-game? | `curl -s http://127.0.0.1:8901/snapshot?t1 \| python3 -m json.tool` | Check `in_game` field |
| Does the character have a position? | Same as above | Check `you.col`/`you.row` (not `pos`) |
| Is the tick loop running? | `grep -i "tick" substrate/broker-prod.log \| tail -10` | Check for "tick silent" errors |
| Is the character stuck? | `grep -i "stuck" substrate/broker-prod.log \| tail -10` | Check stuck detection, escape_pocket |
| Is the airlock engaged? | `grep -i "airlock" substrate/broker-prod.log \| tail -10` | Check `_lastContentsRoom` |

**Likely causes:**
- Airlock engaged (room change, waiting for `BP_ROOM_CONTENTS`)
- Stuck in a pocket (0 open dirs, blink not working)
- Tick loop silent (`c.cast()` returning undefined, `.then()` chain)
- Character is BLIND (no position — false alarm, check `you.col`/`you.row`)

**Fixes:**
- Wait for the airlock to release (or check why `_lastContentsRoom` isn't set)
- Cast blink (if mana allows) or re-roll (manual only)
- Remove the `.then()` chain on `c.cast()`
- Verify the position fields (`you.col`/`you.row`, not `pos`)

---

### "Character is in a wall"

| Check | Command | If broken |
|-------|---------|-----------|
| Is the position valid? | `node tools/m59-check-positions.mjs` | Check for "no floor" |
| Did the airlock release? | `grep -i "airlock" substrate/broker-prod.log \| tail -10` | Check force-adopt |
| Is the bad arrival detection working? | `grep -i "BAD ARRIVAL" substrate/broker-prod.log \| tail -10` | Check the check |

**Likely causes:**
- Server placed the character in a wall (no position validation for `&User`)
- Force-adopt didn't happen (stale position after airlock release)
- Bad arrival detection didn't trigger (no floor check)

**Fixes:**
- Force-adopt: `syncFrom(_me)` after airlock release
- Bad arrival: delegate to legacy mover with nearest walkable square
- Check `m59-controller-mover.mjs` for the bad arrival check

---

### "Character is in the wrong room"

| Check | Command | If broken |
|-------|---------|-----------|
| What room does the client think it's in? | `curl -s http://127.0.0.1:8901/snapshot?t1 \| python3 -m json.tool` | Check `room` field |
| What room does the server say it's in? | `grep -i "BP_PLAYER" substrate/broker-prod.log \| tail -10` | Compare room IDs |
| Is the room stamp guard working? | `grep -i "roomStamp" substrate/broker-prod.log \| tail -10` | Check for stale paths |

**Likely causes:**
- Airlock didn't engage (room changed, but movement continued with stale position)
- Room stamp guard didn't drop the stale path
- `BP_PLAYER` updated the room ID but not the position

**Fixes:**
- Airlock: hold until `_lastContentsRoom === this._room`
- Room stamp: drop paths with stale `_roomStamp`
- Force-adopt: `syncFrom(_me)` after airlock release

---

### "Character is dying repeatedly"

| Check | Command | If broken |
|-------|---------|-----------|
| What's the character's level? | `curl -s http://127.0.0.1:8901/snapshot?t1 \| python3 -m json.tool` | Check `level` |
| What's the hunt band? | `docs/GOAP-HANDOFF.md` § "Scaled hunt bands" | Check the table |
| Is the character fleeing? | `grep -i "flee" substrate/broker-prod.log \| tail -10` | Check flee threshold |
| Is the character resting? | `grep -i "rest" substrate/broker-prod.log \| tail -10` | Check rest threshold |
| What's the character's max HP? | `curl -s http://127.0.0.1:8901/snapshot?t1 \| python3 -m json.tool` | Check `max_hp` |

**Likely causes:**
- Over-level mobs (ceiling = level + band, but still too tough)
- Flee threshold too low (character doesn't flee early enough)
- Rest threshold too high (character doesn't rest early enough)
- Max HP dropping (each death drops max HP by 1-2, death spiral)

**Fixes:**
- Route to a weaker-mob room (don't raise the ceiling)
- Lower the flee threshold (`fleeBelow` policy)
- Lower the rest threshold (`restBelow` policy)
- Re-roll (manual only) if max HP is too low

---

### "Character is not fighting"

| Check | Command | If broken |
|-------|---------|-----------|
| Does the character have a weapon? | `curl -s http://127.0.0.1:8901/snapshot?t1 \| python3 -m json.tool` | Check `equipped` |
| Is the character a caster build? | Check the loadout | Check `substrate/loadouts/<char>.json` |
| Is the character in combat range? | `node tools/m59-check-positions.mjs` | Check distance to target |
| Is the character stuck? | `grep -i "stuck" substrate/broker-prod.log \| tail -10` | Check stuck detection |

**Likely causes:**
- No weapon (caster build, needs to cast "create weapon")
- Not in combat range (too far from target)
- Stuck (can't approach the target)
- Fleeing (health below flee threshold)

**Fixes:**
- Cast "create weapon" (if caster build)
- Approach the target (check the path)
- Unstick (escape_pocket, blink)
- Rest (if health is too low)

---

### "Character is leaving loot behind"

| Check | Command | If broken |
|-------|---------|-----------|
| Is the loot action working? | `grep -i "loot\|pickup" substrate/broker-prod.log \| tail -10` | Check the action |
| Is the character picking up items? | `curl -s http://127.0.0.1:8901/snapshot?t1 \| python3 -m json.tool` | Check `pack` |
| Is the `lootFloor` proxy working? | Check `m59-act/pickup.mjs` | Check the proxy |

**Likely causes:**
- `loot` case missing from the action handler
- `lootFloor` proxy not working
- Character not in range of the loot

**Fixes:**
- Add the `loot` case to the action handler
- Fix the `lootFloor` proxy
- Approach the loot

---

### "Character is walking slowly"

| Check | Command | If broken |
|-------|---------|-----------|
| Is `setRun` being called? | `grep -i "setRun" substrate/broker-prod.log \| tail -10` | Check the decide logic |
| What's the character's speed? | `curl -s http://127.0.0.1:8901/snapshot?t1 \| python3 -m json.tool` | Check `speed` |
| Is the character in a combat goal? | Check the decide logic | Check `_fight`, `healthy`, `vigor_low`, `idle_rest` |

**Likely causes:**
- `setRun(true)` not called (walking at 18 instead of running at 36)
- Character is in a combat goal (walk, not run)
- Vigor too low (can't run)

**Fixes:**
- Call `setRun(true)` for travel/hunt/flee
- Check the decide logic (is the goal correct?)
- Rest (if vigor is too low)

---

### "Character is logged out"

| Check | Command | If broken |
|-------|---------|-----------|
| Is the broker running? | `node tools/m59-service.mjs status --fleet prod` | Restart the broker |
| Did the broker rejoin? | `grep -i "rejoin" substrate/broker-prod.log \| tail -10` | Check the rejoin logic |
| Was the character `leave`d on purpose? | Check the roster | Check `leftOnPurpose` |

**Likely causes:**
- Broker restarted (character needs to be rejoined)
- Rejoin failed (one connection per character, human is playing)
- Character was `leave`d on purpose (honored, not rejoined)

**Fixes:**
- Restart the broker (triggers rejoin)
- Wait for the rejoin (45s cycle)
- If `leave`d on purpose, rejoin manually

---

### "Policy is not taking effect"

| Check | Command | If broken |
|-------|---------|-----------|
| Was the policy set via `autopilot set`? | Check the broker log | Check for "autopilot set" |
| Is the loadout updated? | `cat substrate/loadouts/<char>.json` | Check the policy key |
| Is the roster updated? | `cat substrate/fleet-state.json` | Check the policy key |

**Likely causes:**
- Policy set directly in the roster (not via `autopilot set`)
- Loadout not updated (drift between loadout and roster)
- Broker cache not refreshed

**Fixes:**
- Use `autopilot set` (writes both loadout and roster)
- Restart the broker (refreshes the cache)
- Check the loadout and roster for consistency

## The debugging workflow

1. **Identify the symptom** (what's the character doing wrong?)
2. **Run the first 3 commands** (which, check-positions, broker log)
3. **Look up the symptom in the table above**
4. **Follow the checks** (in order, top to bottom)
5. **Apply the fix**
6. **Verify** (re-run the checks, confirm the symptom is gone)

## Links

- [[MOVEMENT]] — movement debugging
- [[COMBAT]] — combat debugging
- [[MAP-ROUTES]] — map/route debugging
- [[FLEET-OPS]] — fleet ops debugging
- [[TRAPS]] — what can break
