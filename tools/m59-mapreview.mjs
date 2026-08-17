#!/usr/bin/env node
// THE ROOMS WORTH A HUMAN LOOKING AT, AND WHY EACH ONE IS ON THE LIST.
//
//   node tools/m59-mapreview.mjs                every exceptional room, worst first
//   node tools/m59-mapreview.mjs --json         the same, for the map review page
//   node tools/m59-mapreview.mjs --tag stranded-exits
//   node tools/m59-mapreview.mjs --room 578     one room, in full
//
// WHY A TAG AND NOT A VERDICT. The routing bake produces a number for every room — how
// much of the floor is one connected body, how many pockets hang off it, how many exits
// the body cannot walk to. Those numbers are a claim about a MODEL of somebody else's
// server, and the model is stricter than the world: the same measurement that correctly
// identifies the Cragged Mountains cliff (which really does need `blink`) also flags every
// doorway in the game, because a door tile is a pocket by design.
//
// So nothing here decides anything. It sorts 264 rooms into the handful worth opening in
// the map review page, states which measurement put each one there, and stops. Reading a
// tag as a defect is how a bake ends up deleting a doorway people walk through every day.
//
// EVERY TAG IS DERIVED FROM substrate/m59-routes.json AND NOTHING ELSE, so this is instant
// and re-runs after a bake with no extra work. It reads no live fleet and starts no broker.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES_FILE } from './m59-routebake.mjs';

// THE THRESHOLDS ARE ROUND NUMBERS AND THEY ARE MEANT TO BE ARGUED WITH. They exist to
// keep a review list short enough to actually review; none of them is a finding on its own.
export const TAGS = {
  'stranded-exits': {
    what: 'the body of the room cannot walk to one or more of its own exits',
    why: 'the strongest routing signal here, and the one that actually strands a character '
       + '— but a `go` exit anchor IS the door tile, which is a pocket by design, so read '
       + 'the kind before concluding anything',
    test: r => (r.stranded_exits ?? 0) > 0,
    rank: r => r.stranded_exits ?? 0,
  },
  'fragmented': {
    what: 'less than half the floor is in one connected body',
    why: 'either a genuinely broken-up room (a cliff, a chasm, a set of ledges) or a room '
       + 'where our collision model is much stricter than the client',
    test: r => r.walkable > 200 && r.main_region_squares / r.walkable < 0.5,
    rank: r => 1 - (r.main_region_squares / Math.max(1, r.walkable)),
  },
  'no-routes': {
    what: 'two or more exits and not one baked route between any pair of them',
    why: 'a room the fleet must cross and, as far as the bake can tell, cannot',
    test: r => r.anchors.length > 1 && Object.keys(r.routes ?? {}).length === 0,
    rank: r => r.anchors.length,
  },
  'pocket-dense': {
    what: 'more than one pocket for every ten squares of floor',
    why: 'NOT a problem — this is where the safe spots are. A square the BSP hems in is a '
       + 'square whose line to a monster is broken, and Room.LineOfSight is checked for the '
       + 'monster and never for us. Worth reviewing to HARVEST rather than to fix',
    test: r => r.walkable > 100 && (r.pockets ?? 0) / r.walkable > 0.1,
    rank: r => (r.pockets ?? 0) / Math.max(1, r.walkable),
  },
  'one-way-body': {
    what: 'the room has exits and the bake found routes in one direction only',
    why: 'the mover graph is directed — a square whose centre is inside a wall\'s radius '
       + 'can be left and not entered — so a room really can be easier to cross one way',
    test: r => {
      const pairs = Object.keys(r.routes ?? {});
      if (pairs.length < 2) return false;
      const seen = new Set(pairs);
      const oneWay = pairs.filter(p => {
        const [a, b] = p.split('>');
        return !seen.has(`${b}>${a}`);
      });
      return oneWay.length > pairs.length / 2;
    },
    rank: r => Object.keys(r.routes ?? {}).length,
  },
};

// KNOWN, AND DELIBERATELY NOT AUTOMATED AWAY. These are places the operator has already
// walked and can vouch for, so a tag on them means "the model agrees with what we know"
// rather than "go and investigate". Kept here rather than in the tagger because they are
// observations about the WORLD and the tags are observations about our model of it.
export const KNOWN = {
  578: 'the Cragged Mountains cliff — entering from the north-west, the south-west and '
     + 'south-east exits are a one-way trip unless you blink up the cliff near the '
     + 'north-west corner. The one place in the world genuinely joined only by blink',
  598: 'the other half of the Cragged Mountains, same cliff',
  106: 'the Brownestone Inn — the door in delivers you to (12,16) and the door out is at '
     + '(12,17); row 17 is walkable floor the coarse grid marks unreachable from every '
     + 'square touching it. Six characters sat here for half an hour before fine movement '
     + 'was tried',
  615: 'The Badlands — the only room in the world the fleet can walk into and never walk '
     + 'out of, by the room graph rather than by geometry',
  150: 'Cor Noth — west publishes six boundary crossings and zero grounded approaches, so '
     + 'the model believes there is nowhere to stand at a door real players use daily',
};

export function review({ file = ROUTES_FILE() } = {}) {
  if (!existsSync(file)) return { ok: false, why: `no routing table at ${file}`, rooms: [] };
  let table;
  try { table = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { return { ok: false, why: `unreadable routing table: ${error.message}`, rooms: [] }; }
  if (table?.format !== 'm59-routes/1')
    return { ok: false, why: 'the routing table is not m59-routes/1', rooms: [] };

  const rooms = [];
  for (const [num, r] of Object.entries(table.rooms ?? {})) {
    const tags = [];
    for (const [name, tag] of Object.entries(TAGS)) {
      let hit = false;
      try { hit = !!tag.test(r); } catch { hit = false; }
      if (hit) tags.push({ tag: name, rank: Number(tag.rank(r).toFixed(4)) });
    }
    if (!tags.length && !KNOWN[num]) continue;
    rooms.push({
      room: Number(num),
      tags: tags.map(t => t.tag),
      ranks: Object.fromEntries(tags.map(t => [t.tag, t.rank])),
      known: KNOWN[num] ?? null,
      walkable: r.walkable ?? null,
      main_body: r.main_region_squares ?? null,
      main_body_share: r.walkable ? Number((r.main_region_squares / r.walkable).toFixed(3)) : null,
      pockets: r.pockets ?? null,
      exits: r.anchors?.length ?? 0,
      stranded_exits: r.stranded_exits ?? 0,
      stranded_kinds: (r.anchors ?? []).filter(a => !a.from_body)
        .reduce((acc, a) => { acc[a.kind] = (acc[a.kind] ?? 0) + 1; return acc; }, {}),
      routes: Object.keys(r.routes ?? {}).length,
    });
  }
  // Worst first, where "worst" is stranded exits before anything else: it is the only tag
  // that names a character actually failing to get somewhere.
  rooms.sort((a, b) => (b.stranded_exits - a.stranded_exits)
    || ((a.main_body_share ?? 1) - (b.main_body_share ?? 1))
    || (a.room - b.room));
  return { ok: true, built_at: table.builtAt ?? null, view: table.view ?? 'grid',
           total_rooms: Object.keys(table.rooms ?? {}).length, rooms };
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const val = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const r = review();
  if (!r.ok) { console.error(r.why); process.exit(1); }

  const only = val('--room') ? Number(val('--room')) : null;
  const tag = val('--tag');
  let rooms = r.rooms;
  if (only != null) rooms = rooms.filter(x => x.room === only);
  if (tag) rooms = rooms.filter(x => x.tags.includes(tag));

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...r, rooms }, null, 1));
    process.exit(0);
  }

  console.log(`${r.total_rooms} room(s) baked (${r.view} view, ${r.built_at})`);
  console.log(`${rooms.length} exceptional room(s)${tag ? ` tagged ${tag}` : ''}\n`);
  for (const x of rooms) {
    const kinds = Object.entries(x.stranded_kinds).map(([k, n]) => `${n} ${k}`).join(', ');
    console.log(`room ${String(x.room).padEnd(5)} ${x.tags.join(' ')}`);
    console.log(`   ${x.main_body}/${x.walkable} squares in one body ` +
      `(${Math.round(100 * (x.main_body_share ?? 0))}%), ${x.pockets} pocket(s), ` +
      `${x.exits} exit(s), ${x.routes} route(s)` +
      (x.stranded_exits ? `, ${x.stranded_exits} unreachable from the body (${kinds})` : ''));
    if (x.known) console.log(`   KNOWN: ${x.known}`);
  }
  console.log('\nNothing here is a verdict. Every tag is a measurement of our MODEL of the');
  console.log('server, which is stricter than the world — see the header of this file.');
  if (!tag) {
    const counts = {};
    for (const x of rooms) for (const t of x.tags) counts[t] = (counts[t] ?? 0) + 1;
    console.log('\nby tag:');
    for (const [name, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
      console.log(`  ${String(n).padStart(4)}  ${name.padEnd(16)} ${TAGS[name].what}`);
  }
}
