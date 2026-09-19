# Tests

> How to run tests, what they cover, and how to add a new test.

## The test files

190 test files (`m59-*-test.mjs`). They are standalone `.mjs` scripts with zero
dependencies (no `npm install` needed).

## The offline tests (safe to run any time)

These tests do NOT need a live server. They test the logic, the data structures,
and the algorithms.

| Test | Assertions | What it tests |
|------|-----------|---------------|
| `m59-safespot-test.mjs` | 91 | Safe spot finding (wall corners, away from monsters) |
| `m59-chat-test.mjs` | 102 | Chat parsing, auto-respond, inbox |
| `m59-rest-test.mjs` | 6 | Rest logic (stand before rest, PFLAG_NO_MAGIC) |
| `m59-ledger-test.mjs` | 15 | Ledger samples (5-minute health/activity/kill/purse/pack) |
| `m59-escape-test.mjs` | 29 | Escape logic (pocket, underworld, blink) |
| `m59-collision-test.mjs` | 333 | Collision model (fine grid, step masks, lane threading) |
| `m59-breadcrumb-test.mjs` | — | Breadcrumb pathfinding (arrival honesty, queue patience) |
| `m59-fleeline-test.mjs` | — | Fleet line (formation, spacing) |
| `m59-tick-test.mjs` | 29 | Tick loop (five rules, no awaiting, no sending) |
| `m59-stuckwatch-test.mjs` | — | Stuck detection (STUCK_TICKS, escape_pocket) |

### Running the offline tests

```bash
# Run all offline tests
node tools/m59-safespot-test.mjs
node tools/m59-chat-test.mjs
node tools/m59-rest-test.mjs
node tools/m59-ledger-test.mjs
node tools/m59-escape-test.mjs
node tools/m59-collision-test.mjs
node tools/m59-breadcrumb-test.mjs
node tools/m59-fleeline-test.mjs
node tools/m59-tick-test.mjs
node tools/m59-stuckwatch-test.mjs
```

**All should pass with 0 failures.** If a test fails, the code has a bug.

## The live tests (need a running server)

These tests need a live `blakserv` server and at least one character logged in.

| Test | What it tests |
|------|---------------|
| `m59-bt-combat.mjs` | Combat behavior tree (live) |
| `m59-bt-nav.mjs` | Navigation behavior tree (live) |
| `m59-navtrace.mjs` | Navigation trace (compares model vs. server) |
| `m59-walktrial.mjs` | Walk trial (measures actual movement) |
| `m59-jumptrial.mjs` | Jump trial (measures fall-jumps) |

### Running the live tests

```bash
# Start the server and broker first
node tools/setup.mjs all 10

# Then run the live tests
node tools/m59-bt-combat.mjs
node tools/m59-navtrace.mjs
```

## How to add a new test

1. **Create the file**: `tools/m59-<name>-test.mjs`
2. **Use the same pattern**: standalone `.mjs`, zero dependencies, `assert()` calls
3. **Print the assertion count** at the end: `console.log(`${count} assertions passed`)`
4. **Exit with code 0** on success, **non-zero** on failure
5. **Add it to the offline list** in this note if it doesn't need a live server

### Example test structure

```javascript
#!/usr/bin/env node
// m59-myfeature-test.mjs
// Tests for my feature.

import { myFunction } from './m59-myfeature.mjs';

let count = 0;
function assert(cond, msg) {
  count++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// Test 1: basic case
assert(myFunction(1) === 2, 'myFunction(1) should be 2');

// Test 2: edge case
assert(myFunction(0) === 0, 'myFunction(0) should be 0');

console.log(`${count} assertions passed`);
```

## The test conventions

- **File name**: `m59-<feature>-test.mjs`
- **Location**: `tools/`
- **Dependencies**: None (standalone `.mjs`)
- **Assertions**: `assert(condition, message)` — exit non-zero on failure
- **Output**: Print the assertion count at the end
- **Offline tests**: No network, no server, no character
- **Live tests**: Need a running server and at least one character

## Debugging a failing test

1. **Run the test**: `node tools/m59-<name>-test.mjs`
2. **Read the failure message**: It tells you which assertion failed and why
3. **Check the code**: The test is testing a specific function in a specific file
4. **Fix the code** (not the test, unless the test is wrong)
5. **Re-run the test**: It should pass

## Links

- [[FILES]] — what each file does
- [[ARCHITECTURE]] — the big picture
- [[TRAPS]] — what can break
