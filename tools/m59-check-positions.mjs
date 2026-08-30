#!/usr/bin/env node
// Detect characters in messed-up places: go-exit staging squares, outside
// the room grid. Uses the live room-view API for current positions.
import { loadMap } from './m59-map.mjs';

const map = loadMap();
const agents = ['t1', 't2', 't3', 't4', 't5'];
const problems = [];

for (const agent of agents) {
  const port = 8910 + Number(agent.slice(1));
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${port}/room-view`, { signal: ctrl.signal });
    clearTimeout(timer);
    const d = await res.json();
    const { col, row } = d.self ?? {};
    const roomNum = d.room_num;
    const roomName = d.room_name;
    if (col == null || roomNum == null) {
      problems.push({ agent, issue: 'no position', col, row });
      continue;
    }
    const room = map.rooms[String(roomNum)];
    if (!room) {
      problems.push({ agent, issue: `room ${roomNum} not in map`, col, row, room: roomName });
      continue;
    }
    // Check if outside the room grid
    if (col < 1 || col > room.cols || row < 1 || row > room.rows) {
      problems.push({ agent, issue: `OUTSIDE GRID (${col},${row} in ${room.cols}x${room.rows})`, col, row, room: roomName });
      continue;
    }
    // Check if at a go-exit staging square from another room
    const matches = [];
    for (const [num, r] of Object.entries(map.rooms)) {
      if (num === String(roomNum)) continue;
      for (const e of (r.goExits ?? [])) {
        if (e.col == col && e.row == row && e.to != null && !e.locked) {
          matches.push(`${r.name}->${e.to}`);
        }
      }
    }
    if (matches.length) {
      problems.push({ agent, issue: `STAGING SQUARE: ${matches.join(', ')}`, col, row, room: roomName });
    }
  } catch (e) {
    problems.push({ agent, issue: `room-view failed: ${e.message}`, col: null, row: null });
  }
}

if (problems.length) {
  console.log(`\n⚠️  ${problems.length} character(s) in messed-up places:\n`);
  for (const p of problems) {
    console.log(`  ${p.agent} (${p.col},${p.row}) in ${p.room ?? '?'}: ${p.issue}`);
  }
  process.exit(1);
} else {
  console.log('✓ All characters in valid positions');
}
