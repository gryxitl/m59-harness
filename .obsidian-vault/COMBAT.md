# Combat

> How characters fight, flee, and rest. When a character is dying or not fighting, start here.

## The decision ladder (in `m59-decide.mjs`)

The decide function evaluates goals in priority order:

```
1. panicking?       → logoff (health < 10%)
2. in Underworld?  → escape via portals
3. health < flee?  → run (flee from threat)
4. health < rest?  → find safe wall, rest to full
5. farm mode?      → hunt prey (fight loop)
6. town needed?    → travel to town, bank/buy/sell
7. errand active?  → execute multi-hop task
8. idle            → roam or wait
```

## Fighting

### The fight loop

```
1. Find a target (scan room.objects, filter by type)
2. Equip weapon + armour (if not already equipped)
3. Approach to within 2-3 squares (melee range)
4. Swing loop: attack until target dies or health < flee threshold
5. Loot on kill (pick up dropped items)
6. Disengage below flee health
```

### Key rules

- **No blinking while fighting** — blink requires concentration; incoming attacks break it
- **No fighting while fleeing** — when fleeing, the character just runs, doesn't swing
- **Loot must be picked up** — characters were leaving money and items on the floor

### Caster builds

Some characters (e.g., Kage) are caster builds with no weapon. They:
- Cast spells instead of swinging
- Need mana (not vigor) to fight
- May need to cast "create weapon" to get a melee weapon

## Fleeing

### The flee logic

```
1. Identify the threat (nearest hostile)
2. Calculate the flee direction (away from threat)
3. Run (setRun(true)) in the flee direction
4. If the router is stuck, run away from the threat directly
5. If in a pocket, cast blink to escape
```

### Key rules

- **Fleeing = running, not fighting** — the character does not swing while fleeing
- **Flee threshold** — `fleeBelow` policy (default: 30% health)
- **Flee room** — if the character is in a room with no safe exit, it tries to flee to a connected room

## Resting

### The rest logic

```
1. Find a safe spot (wall corner, away from monsters)
2. stand() (to avoid PFLAG_NO_MAGIC)
3. Rest until health is full
4. Resume the previous goal
```

### Key rules

- **Resting requires a safe spot** — not in the open, not next to a monster
- **`stand()` before rest** — to avoid the `PFLAG_NO_MAGIC` refusal
- **Rest threshold** — `restBelow` policy (default: 60% health)

## The watchdog

An independent 500ms timer that:
- Reads health live (server pushes it)
- If health crosses the flee line while the tick is blocked > 3s → calls `cancelMovement()`
- Writes health-change frames even when the tick is blind

## Debugging combat

```bash
# Check the character's health and what it's doing
curl -s http://127.0.0.1:8901/snapshot?t1 | python3 -m json.tool

# Check the broker log for combat events
grep -i "fight\|flee\|rest\|kill\|death" substrate/broker-prod.log | tail -20

# Check the postmortems
ls substrate/postmortems/ | tail -5
```

### Common symptoms

| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| Character dying repeatedly | Over-level mobs, no flee | Hunt band, flee threshold |
| Character not fighting | No weapon (caster build) | Loadout, equip logic |
| Character fleeing too early | Flee threshold too high | Policy `fleeBelow` |
| Character not resting | No safe spot found | `m59-safespots.mjs` |
| Character stuck in a fight | Can't disengage | Flee logic, room exits |

## Hunt bands

Hunt bands are scaled by level:
- **Armed**: `floor(level/2)`
- **Unarmed**: `floor(level/4)`
- **Ceiling**: level + band

| Level | Armed band | Unarmed band | Ceiling |
|-------|-----------|-------------|---------|
| 20 | 10 | 5 | 30 |
| 21 | 10 | 5 | 31 |
| 25 | 12 | 6 | 37 |

**Safe targets:**
- lv20-24: Baby spiders (lv25) in Deep Woods (rooms 534, 535, 545, 554, 568, 574, 575, 593, 603)
- lv25+: Giant rats (lv30) in Sewers (room 377/600)

**Too tough:**
- lv30 giant rats for lv21 characters (ceiling 31, but still too tough)
- Each death drops max HP by 1-2, starting a death spiral

## Links

- [[ARCHITECTURE]] — the big picture
- [[MOVEMENT]] — how fleeing movement works
- [[TRAPS]] — combat-related traps
