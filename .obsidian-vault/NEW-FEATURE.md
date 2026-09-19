# Adding a New Feature

> How to add a new goal, action, or policy key. When you need to extend the system, start here.

## The three types of features

| Type | What it is | Example |
|------|-----------|---------|
| **Goal** | A new thing the character can do (a new branch in the decision ladder) | "Gather herbs" |
| **Action** | A new primitive the character can execute (a new `m59-act/` file) | "Plant a seed" |
| **Policy key** | A new standing preference (a new POLICY_KEY) | `gatherHerbs: true` |

## Adding a new goal

### 1. Add the goal to the decision ladder (`m59-decide.mjs`)

```javascript
// In the decision ladder, add the new goal at the appropriate priority:
if (shouldGatherHerbs(frame)) {
  return { goal: 'gather_herbs', target: nearestHerbSpot(frame) };
}
```

### 2. Add the goal to the `setRun` logic (`m59-decide.mjs`)

```javascript
// Run for travel/hunt/flee/gather, walk for combat/rest:
const shouldRun = !['_fight', 'healthy', 'vigor_low', 'idle_rest'].includes(goal);
session._mover?.setRun?.(shouldRun);
```

### 3. Add the goal to the actuator (`m59-tick.mjs` or `m59-act/`)

```javascript
// In the actuator, handle the new goal:
case 'gather_herbs':
  await gatherHerbs(session, intent.target);
  break;
```

### 4. Write the action primitive (`m59-act/gather-herbs.mjs`)

```javascript
export async function gatherHerbs(session, spot) {
  // Walk to the spot
  await session.mover.moveTo(spot.room, spot.x, spot.y);
  // Use the "gather" action
  await session.act('gather', { target: spot.id });
  // Pick up the herbs
  await session.act('pickup', { item: 'herb' });
}
```

### 5. Add a test (`m59-gather-herbs-test.mjs`)

```javascript
import { gatherHerbs } from './m59-act/gather-herbs.mjs';

let count = 0;
function assert(cond, msg) {
  count++;
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

// Test the gatherHerbs function
assert(typeof gatherHerbs === 'function', 'gatherHerbs should be a function');

console.log(`${count} assertions passed`);
```

### 6. Update the docs

- Add the goal to `[[COMBAT]]` (the decision ladder)
- Add the action to `[[FILES]]` (the action primitives)
- Add the policy key to `[[FLEET-OPS]]` (the policy keys)

## Adding a new action

### 1. Write the action primitive (`m59-act/<name>.mjs`)

```javascript
export async function myAction(session, opts) {
  // Send the packet to the server
  session.client.send('REQ_MY_ACTION', opts);
  // Check the result
  const result = await session.client.waitFor('BP_MY_ACTION_RESULT', 5000);
  return result;
}
```

### 2. Add the action to the actuator (`m59-tick.mjs`)

```javascript
case 'my_action':
  await myAction(session, intent);
  break;
```

### 3. Add a test

```javascript
import { myAction } from './m59-act/my-action.mjs';

let count = 0;
function assert(cond, msg) {
  count++;
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

assert(typeof myAction === 'function', 'myAction should be a function');

console.log(`${count} assertions passed`);
```

### 4. Update the docs

- Add the action to `[[FILES]]` (the action primitives)

## Adding a new policy key

### 1. Add the key to POLICY_KEYS (`m59-broker.mjs`)

```javascript
const POLICY_KEYS = [
  'hunt', 'assignedRoom', 'fightRounds', 'restBelow', 'fleeBelow',
  'bankAbove', 'buyFood', 'roam', 'partner', 'threatCeiling',
  'myNewPolicyKey',  // ← add the new key
];
```

### 2. Add the key to the loadout schema (`m59-loadout.mjs`)

```javascript
// In the loadout schema, add the new key:
myNewPolicyKey: { type: 'boolean', default: false },
```

### 3. Use the key in the decide logic (`m59-decide.mjs`)

```javascript
if (policy.myNewPolicyKey) {
  // Do the new thing
}
```

### 4. Update the docs

- Add the key to `[[FLEET-OPS]]` (the policy keys)
- Add the key to `[[GLOSSARY]]` (if it's a new term)

## The checklist

- [ ] Code written
- [ ] Test written and passing
- [ ] Docs updated (COMBAT, FILES, FLEET-OPS, GLOSSARY)
- [ ] Offline tests still pass
- [ ] Live test (if applicable)

## Links

- [[TESTS]] — how to write and run tests
- [[FILES]] — where the files are
- [[FLEET-OPS]] — policy management
- [[COMBAT]] — the decision ladder
