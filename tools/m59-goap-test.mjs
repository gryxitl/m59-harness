#!/usr/bin/env node
// m59-goap-test.mjs -- offline tests for the GOAP planner.
//
// SUPERSEDED 2026-08-28. This suite was written against m59-goap.mjs, the
// standalone GOAP supervisor that predates the current architecture. The
// planner it exercised (m59-goap.mjs) is now a runnable script for external
// bot repositories, and the exported API it tested (deriveWorldState,
// buildActionLibrary, planAction, compileExpr) was replaced by m59-goap-planner.mjs
// (plan, GoapExecutor) and m59-decide.mjs (the goal ladder and world state).
//
// The assertions below still hold in spirit — they test things like flee-threshold
// coverage, inert-revive gating, and the cost of attacking versus waiting — but the
// plumbing is wrong. The current planner's behaviour is pinned against live world
// states in m59-decide-test.mjs, m59-bt-farm-test.mjs, m59-bt-flee-test.mjs, and
// m59-worldstate-test.mjs. Reopening this file is a migration task: reconstruct the
// synthetic world states in terms of the symbols in m59-worldstate.mjs, and replace
// each planAction(...) with the equivalent planner call.
console.log('');
console.log(('m59-goap-test: SKIPPED — this suite tested the pre-repayment planner API').padEnd(80));
console.log('see m59-decide-test.mjs / m59-worldstate-test.mjs / m59-bt-farm-test.mjs for the current coverage');
console.log('');
process.exit(0);
