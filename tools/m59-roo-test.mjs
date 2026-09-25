#!/usr/bin/env node
// Does the .roo parse actually hold the room's RELIEF, and do we obey the climb limit?
//
//   node tools/m59-roo-test.mjs
//
// The sector section is the part of a .roo we were reading the offset of and then
// throwing away. Without it every floor is at height zero, which is a lie that never
// announces itself: a staircase and a cliff edge look identical, both read as "wall",
// and a route planned up one is refused by our own collision check for a reason the
// logs render as the server saying no.
//
// Two things here are worth a test rather than a read-through.
//
// THE SECTOR RECORD IS VARIABLE-LENGTH. bspload.c LoadSectors appends a 46-byte slope
// block per sector for a sloped floor and another for a sloped ceiling, INLINE, inside
// the same loop. A parser that assumes a stride reads correctly right up to the first
// sloped sector and garbage from there on — and 80 of the 266 rooms in the tree have
// at least one. So the synthetic files below deliberately put a sloped sector in the
// MIDDLE, because a stride bug is invisible if the variable-length record is last.
//
// A PASSABLE WALL IS NOT A CROSSABLE WALL. move.c:551 is a three-part AND, and this
// repository had been treating the third part as the whole test. A wall flagged
// WF_PASSABLE still blocks when the step up exceeds MAX_STEP_HEIGHT or the headroom is
// under the player's height — which is exactly how the format distinguishes a step
// from a cliff, and the distinction is the entire point of parsing heights at all.
import fs from 'node:fs';
import path from 'node:path';
import {
  RoomGeometry,
  parseRoo, parseRooNodes, parseRooSectors, setWallHeights, canCrossWall,
  floorHeightAt, ceilingHeightAt,
  MAX_STEP_HEIGHT, MAX_STEP_HEIGHT_KOD, SECTOR_DEPTHS, sectorDepth, SF, WF,
  CLIENT_FINENESS, KOD_FINENESS, MAX_BSP_POINTS,
  PLAYER_HEIGHT, PLAYER_RADIUS, PLAYER_WIDTH,
  heightKodToClient, DEFAULT_ROO_DIRS,
} from './m59-roo.mjs';
import './m59-navgeom.mjs';   // installs the height model + lenient fine path onto RoomGeometry

let pass = 0, fail = 0, skipped = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};
const skip = (label, why) => { skipped++; console.log(`  --   ${label} — ${why}`); };

// ------------------------------------------------------- the constants, from source
//
// These are pinned because they are the numbers a future reader is most likely to
// "clean up" into something rounder, and every one of them is load-bearing.
console.log('constants, against the C the client actually compiles');
ok('MAX_STEP_HEIGHT is 24 kod units', MAX_STEP_HEIGHT_KOD === 24, 'move.c:55');
ok('...which is 384 client units', MAX_STEP_HEIGHT === 384, `${MAX_STEP_HEIGHT}`);
ok('height conversion shifts by 4', heightKodToClient(1) === 16, 'drawdefs.h:60');
ok('wading depths are {0,204,409,614}', SECTOR_DEPTHS.join(',') === '0,204,409,614', 'draw3d.c:80');
ok('depth is the low two flag bits', sectorDepth(0x0403) === 3 && sectorDepth(0x0400) === 0, 'bsp.h:70');
ok('player width 496, radius 248', PLAYER_WIDTH === 496 && PLAYER_RADIUS === 248, 'game.c:261, move.c:122');
ok('player height 768', PLAYER_HEIGHT === 768, 'game.c:262');
ok('fineness 1024 client / 64 kod', CLIENT_FINENESS === 1024 && KOD_FINENESS === 64, 'drawdefs.h:42,52');
ok('a BSP leaf is bounded to 20 vertices', MAX_BSP_POINTS === 20, 'bsp.h:303');

// ------------------------------------------------------- the variable-length walk
//
// A sector section built by hand, so the expected bytes are known rather than
// inferred. Sector 1 is flat, sector 2 is SLOPED, sector 3 is flat again — and the
// test is whether sector 3 comes back with its own numbers or with the tail of
// sector 2's slope block reinterpreted as a header.
function sectorBytes({ id, floorKod, ceilKod, flags, slopes = 0 }) {
  const fixed = Buffer.alloc(20);
  fixed.writeInt16LE(id, 0);
  fixed.writeInt16LE(0, 2); fixed.writeInt16LE(0, 4);   // floor/ceiling bitmap types
  fixed.writeInt16LE(0, 6); fixed.writeInt16LE(0, 8);   // tx, ty
  fixed.writeInt16LE(floorKod, 10);
  fixed.writeInt16LE(ceilKod, 12);
  fixed.writeUInt8(64, 14);                              // light
  fixed.writeInt32LE(flags, 15);
  fixed.writeUInt8(0, 19);                               // speed (version >= 10)
  if (!slopes) return fixed;
  // A slope block: a,b,c,d then p0.x,p0.y then the texture angle then 18 junk bytes.
  const blocks = [];
  for (let i = 0; i < slopes; i++) {
    const s = Buffer.alloc(46);
    s.writeInt32LE(0, 0); s.writeInt32LE(0, 4);          // a, b — level plane...
    s.writeInt32LE(1024, 8);                             // c
    s.writeInt32LE(-1024 * 500, 12);                     // d, so z = 500 everywhere
    s.writeInt32LE(0, 16); s.writeInt32LE(0, 20);        // p0
    s.writeInt32LE(0, 24);                               // angle
    blocks.push(s);
  }
  return Buffer.concat([fixed, ...blocks]);
}

// Offset 0 legitimately means "no sector section", so the synthetic files put the
// count somewhere real — as a file would.
const SEC_OFF = 4;
function section(...records) {
  const count = Buffer.alloc(2);
  count.writeUInt16LE(records.length, 0);
  return Buffer.concat([Buffer.alloc(SEC_OFF), count, ...records]);
}

console.log('\nthe sector record is variable-length');
{
  const buf = section(
    sectorBytes({ id: 11, floorKod: 100, ceilKod: 300, flags: 0 }),
    sectorBytes({ id: 22, floorKod: 200, ceilKod: 400, flags: SF.SLOPED_FLOOR, slopes: 1 }),
    sectorBytes({ id: 33, floorKod: 150, ceilKod: 350, flags: SF.DEPTH_MASK & 2 }),
  );
  const secs = parseRooSectors(buf, 12, SEC_OFF);

  ok('all three sectors read', secs.length === 3, `${secs.length}`);
  ok('the flat one before the slope is right', secs[0]?.serverId === 11 && secs[0]?.floorHeight === heightKodToClient(100));
  ok('the sloped one is right', secs[1]?.serverId === 22 && !!secs[1]?.slopedFloor);
  // THE ASSERTION THIS WHOLE FILE EXISTS FOR.
  ok('the flat one AFTER the slope is right', secs[2]?.serverId === 33 && secs[2]?.floorHeight === heightKodToClient(150),
     secs[2] ? `id=${secs[2].serverId} floor=${secs[2].floorHeight}` : 'missing');
  ok('a sloped floor solves its plane', floorHeightAt(0, 0, secs[1]) === 500, `${floorHeightAt(0, 0, secs[1])}`);
  ok('a flat floor ignores x,y', floorHeightAt(9999, 9999, secs[0]) === heightKodToClient(100));
  ok('two slope blocks are both consumed',
     parseRooSectors(section(
       sectorBytes({ id: 7, floorKod: 1, ceilKod: 2, flags: SF.SLOPED_FLOOR | SF.SLOPED_CEILING, slopes: 2 }),
       sectorBytes({ id: 8, floorKod: 3, ceilKod: 4, flags: 0 }),
     ), 12, SEC_OFF)[1]?.serverId === 8);
  // LoadSectors reads a WORD. A high-bit pattern must therefore remain a high
  // unsigned height rather than being sign-extended into a low/negative surface.
  const neg = parseRooSectors(section(sectorBytes({ id: 1, floorKod: -40, ceilKod: 100, flags: 0 })), 12, SEC_OFF);
  ok('floor heights preserve unsigned WORD semantics',
    neg[0].floorHeight === heightKodToClient(0x10000 - 40), `${neg[0].floorHeight}`);
  const highTexture = sectorBytes({ id: 1, floorKod: 0, ceilKod: 100, flags: 0 });
  highTexture.writeUInt16LE(50063, 2);
  ok('texture resource ids are unsigned WORDs',
    parseRooSectors(section(highTexture), 12, SEC_OFF)[0].floorType === 50063,
    'real resource ids exceed signed int16');
  // A partial collision table is not usable geometry. Silently returning the records
  // that happened to fit can turn every missing wall reference into a null/open side.
  const short = section(sectorBytes({ id: 1, floorKod: 1, ceilKod: 2, flags: 0 }));
  short.writeUInt16LE(9, SEC_OFF);
  let truncatedRejected = false;
  try { parseRooSectors(short, 12, SEC_OFF); } catch { truncatedRejected = true; }
  ok('a truncated sector table is rejected', truncatedRejected);
}

// ------------------------------------------------------- BSP leaves / subsectors
// A leaf is the actual floor patch. Its sector reference is what joins raw polygon
// geometry to texture, height, slope and light, so test that association with bytes
// built independently of the parser and preserve a deliberately fractional winding.
const NODE_OFF = 4;
const f32 = n => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const bboxBytes = (box, coord) => Buffer.concat(box.map(coord));
function internalNodeBytes({ bbox, separator, positive, negative, firstWall = 0, coord = f32 }) {
  const refs = Buffer.alloc(6);
  refs.writeUInt16LE(positive, 0); refs.writeUInt16LE(negative, 2); refs.writeUInt16LE(firstWall, 4);
  return Buffer.concat([Buffer.from([1]), bboxBytes(bbox, coord), ...separator.map(coord), refs]);
}
function leafNodeBytes({ bbox, sector, polygon, coord = f32 }) {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(sector, 0); head.writeUInt16LE(polygon.length, 2);
  return Buffer.concat([Buffer.from([2]), bboxBytes(bbox, coord), head,
    ...polygon.flatMap(([x, y]) => [coord(x), coord(y)])]);
}
function nodeSection(...records) {
  const count = Buffer.alloc(2); count.writeUInt16LE(records.length);
  return Buffer.concat([Buffer.alloc(NODE_OFF), count, ...records]);
}
const throws = fn => { try { fn(); return false; } catch { return true; } };

console.log('\nBSP leaves preserve ROO subsectors and resolve sectors');
{
  const sectors = parseRooSectors(section(
    sectorBytes({ id: 71, floorKod: 10, ceilKod: 200, flags: 0 }),
    sectorBytes({ id: 72, floorKod: 20, ceilKod: 220, flags: SF.SLOPED_FLOOR, slopes: 1 }),
  ), 12, SEC_OFF);
  const clockwise = [[1024.25, 0], [2048, 0], [2048, 1024], [1024.25, 1024]];
  const nodes = nodeSection(
    internalNodeBytes({ bbox: [0, 0, 2048, 1024], separator: [1, 0, -1024], positive: 2, negative: 3 }),
    leafNodeBytes({ bbox: [1024.25, 0, 2048, 1024], sector: 2, polygon: clockwise }),
    leafNodeBytes({ bbox: [0, 0, 1024.25, 1024], sector: 1,
      polygon: [[0, 0], [1024.25, 0], [1024.25, 1024], [0, 1024]] }),
  );
  const bsp = parseRooNodes(nodes, 13, NODE_OFF, sectors, 0);
  ok('the root and all three nodes parse', bsp.root === 1 && bsp.nodes.length === 3);
  ok('both leaves become renderable subsectors', bsp.leaves.length === 2);
  ok('every leaf is tied to the parsed sector it references',
    bsp.leaves.every(leaf => leaf.sector === sectors[leaf.sectorNum - 1]));
  ok('raw float coordinates and original winding survive unchanged',
    JSON.stringify(bsp.leaves[0].polygon) === JSON.stringify(clockwise),
    JSON.stringify(bsp.leaves[0].polygon));

  const geo = new RoomGeometry({ file: 'fixture.roo', version: 13, rows: 1, cols: 1,
    grid: Buffer.from([0]), flags: Buffer.from([1]), monsterGrid: null,
    walls: [], sidedefs: [], sectors, nodes: bsp.nodes, leaves: bsp.leaves, clientSize: null });
  const baked = geo.toJSON({ includeWalls: false });
  const restored = RoomGeometry.fromJSON(baked);
  ok('the baked map carries sector textures, heights, light and slope angle',
    baked.sectors[1].floorType === sectors[1].floorType &&
    baked.sectors[1].floorHeight === sectors[1].floorHeight &&
    baked.sectors[1].light === sectors[1].light &&
    baked.sectors[1].slopedFloor.textureAngle === 0);
  ok('the baked-map round trip re-associates leaves with sectors',
    restored.leaves.every(leaf => leaf.sector === restored.sectors[leaf.sectorNum - 1]));

  ok('a leaf cannot name a sector that was not parsed', throws(() => parseRooNodes(
    nodeSection(leafNodeBytes({ bbox: [0, 0, 1, 1], sector: 3,
      polygon: [[0, 0], [1, 0], [0, 1]] })), 13, NODE_OFF, sectors, 0)));
  ok('oversized leaf polygons are rejected before reading their payload', (() => {
    const bad = nodeSection(leafNodeBytes({ bbox: [0, 0, 1, 1], sector: 1,
      polygon: Array.from({ length: MAX_BSP_POINTS + 1 }, (_, i) => [i, i]) }));
    return throws(() => parseRooNodes(bad, 13, NODE_OFF, sectors, 0));
  })());
  ok('out-of-range child references are rejected', throws(() => parseRooNodes(
    nodeSection(internalNodeBytes({ bbox: [0, 0, 1, 1], separator: [1, 0, 0], positive: 2, negative: 0 })),
    13, NODE_OFF, sectors, 0)));
  ok('cycles in the BSP references are rejected', throws(() => parseRooNodes(
    nodeSection(internalNodeBytes({ bbox: [0, 0, 1, 1], separator: [1, 0, 0], positive: 1, negative: 0 })),
    13, NODE_OFF, sectors, 0)));
  const v12 = parseRooNodes(nodeSection(leafNodeBytes({ bbox: [-64, 0, 64, 64], sector: 1,
    polygon: [[-64, 0], [64, 0], [0, 64]], coord: i32 })), 12, NODE_OFF, sectors, 0);
  ok('pre-v13 signed integer coordinates remain in their raw scale',
    v12.leaves[0].polygon[0][0] === -64);
  const completeLeaf = nodeSection(leafNodeBytes({ bbox: [0, 0, 1, 1], sector: 1,
    polygon: [[0, 0], [1, 0], [0, 1]] }));
  ok('truncated leaf payloads are rejected', throws(() => parseRooNodes(
    completeLeaf.subarray(0, completeLeaf.length - 1), 13, NODE_OFF, sectors, 0)));
  const nonFinite = Buffer.from(completeLeaf);
  nonFinite.writeFloatLE(Number.NaN, NODE_OFF + 3); // count(2), type(1), then bbox.x0
  ok('non-finite v13 coordinates are rejected',
    throws(() => parseRooNodes(nonFinite, 13, NODE_OFF, sectors, 0)));
}

// ------------------------------------------------------- wall heights from sectors
console.log('\nwall heights come off the sectors either side');
{
  const low  = { floorHeight: 0,    ceilingHeight: 4096, depth: 0, slopedFloor: null, slopedCeiling: null };
  const step = { floorHeight: 320,  ceilingHeight: 4096, depth: 0, slopedFloor: null, slopedCeiling: null };  // 20 kod — climbable
  const cliff= { floorHeight: 1024, ceilingHeight: 4096, depth: 0, slopedFloor: null, slopedCeiling: null };  // 64 kod — not
  const sectors = [low, step, cliff];
  const wall = (posSector, negSector) => setWallHeights(
    { x0: 0, y0: 0, x1: 1024, y1: 0, posSector, negSector }, sectors);

  ok('a wall with no sectors gets the defaults', (w => w.z0 === 0 && w.z2 === CLIENT_FINENESS)(wall(0, 0)));
  ok('a one-sided wall takes the sector it has', (w => w.z0 === 320 && w.z1 === 320)(wall(2, 0)));
  ok('z1 is the HIGHER floor, z0 the lower', (w => w.z1 === 320 && w.z0 === 0)(wall(2, 1)));
  ok('...whichever side it is on', (w => w.z1 === 320 && w.z0 === 0)(wall(1, 2)));
  ok('z2 is the LOWER ceiling', (w => w.z2 === 4096)(wall(1, 2)));
  ok('a cliff reports its real step', (w => w.z1 - w.z0 === 1024)(wall(1, 3)));
}

// ------------------------------------------------------- the crossing rule
console.log('\ncrossing a wall is three tests, not one');
{
  const flat  = { floorHeight: 0,   ceilingHeight: 4096, depth: 0, slopedFloor: null, slopedCeiling: null };
  const up20  = { floorHeight: 320, ceilingHeight: 4096, depth: 0, slopedFloor: null, slopedCeiling: null };
  const up64  = { floorHeight: 1024, ceilingHeight: 4096, depth: 0, slopedFloor: null, slopedCeiling: null };
  const deep  = { floorHeight: 0,   ceilingHeight: 4096, depth: SECTOR_DEPTHS[3], slopedFloor: null, slopedCeiling: null };
  const build = (negSectorObj, { flags = WF.PASSABLE, belowType = 1, aboveType = 0 } = {}) => {
    const sd = { flags, belowType, aboveType };
    const w = { x0: 0, y0: 0, x1: 1024, y1: 0, posSector: 1, negSector: 2,
                posSidedefRec: sd, negSidedefRec: sd };
    return setWallHeights(w, [flat, negSectorObj]);
  };

  ok('a passable wall onto a small step is crossable', canCrossWall(build(up20), 0, 'pos'));
  ok('a passable wall onto a CLIFF is not', !canCrossWall(build(up64), 0, 'pos'),
     'this is the case `passable` alone got wrong');
  ok('exactly MAX_STEP_HEIGHT is allowed',
     canCrossWall(build({ ...flat, floorHeight: MAX_STEP_HEIGHT }), 0, 'pos'));
  ok('one unit above it is not',
     !canCrossWall(build({ ...flat, floorHeight: MAX_STEP_HEIGHT + 1 }), 0, 'pos'));
  ok('an impassable wall is never crossable', !canCrossWall(build(up20, { flags: 0 }), 0, 'pos'));
  ok('no below texture means no step test at all',
     canCrossWall(build(up64, { belowType: 0 }), 0, 'pos'), 'move.c short-circuits on a null bitmap');
  ok('standing higher makes a tall step crossable', canCrossWall(build(up64), 1024 - MAX_STEP_HEIGHT, 'pos'));
  // Wading LOWERS the far side, so deep water is easier to climb out of than the
  // number alone suggests — move.c subtracts the depth before the comparison.
  ok('wading depth reduces the effective step',
     canCrossWall(build({ ...up64, depth: SECTOR_DEPTHS[3], floorHeight: MAX_STEP_HEIGHT + 100 }), 0, 'pos'));
  ok('headroom under the player height blocks',
     !canCrossWall(build(up20, { aboveType: 1 }), 0, 'pos', { playerHeight: 99999 }));
  ok('a null sidedef is skipped, as move.c does',
     canCrossWall({ ...build(up64), posSidedefRec: null }, 0, 'pos'));
}

// ------------------------------------------------------- routing round monsters
//
// A monster is not a wall, and the two failure modes are opposite. Treating it as a
// wall strands a character whenever the only corridor has something in it — the same
// shape of bug as the coarse grid sealing a doorway. Treating it as nothing walks the
// character through its attack radius at a walking pace, which is where this fleet's
// travel deaths come from.
//
// So: cost, not prohibition. The radii are the monster's own (`monster.kod:1676`,
// `:1682`) — vision 4 + difficulty/2, reach Bound(2 + difficulty/6, 2, 3).
console.log('\nrouting treats monsters as cost, not as wall');
{
  const open = (rows, cols, mask = null) => {
    const flags = Buffer.alloc(rows * cols, 0);
    if (mask) mask(flags, cols); else flags.fill(1);
    return new RoomGeometry({ file: 'synthetic', version: 13, rows, cols,
      grid: Buffer.alloc(rows * cols, 0xff), flags, monsterGrid: null,
      walls: [], sidedefs: [], sectors: [], clientSize: null });
  };
  const g = open(21, 21);
  const threat = [{ row: 11, col: 11, vision: 6, reach: 3 }];
  const closest = p => Math.min(...p.steps.map(s => Math.hypot(s.row - 11, s.col - 11)));

  const straight = g.path(11, 1, 11, 21);
  ok('without threats the route goes straight through it',
     straight.found && straight.steps.some(s => s.row === 11 && s.col === 11));

  const dodged = g.path(11, 1, 11, 21, { threats: threat });
  ok('with a threat the route stays outside its vision', dodged.found && closest(dodged) >= 6,
     `closest approach ${closest(dodged).toFixed(2)} squares`);
  // The detour is FREE in an open room, because diagonals let it arc. That is worth
  // asserting: if this ever costs steps, the penalty is mis-tuned rather than the
  // geometry being tight.
  ok('...and in the open that costs no extra steps',
     dodged.steps.length === straight.steps.length,
     `${straight.steps.length} -> ${dodged.steps.length}`);

  // WHEN YOU HAVE TO, YOU HAVE TO. One-square corridor, monster sitting in it.
  const corridor = open(21, 21, (f, cols) => { for (let c = 0; c < cols; c++) f[(11 - 1) * cols + c] = 1; });
  const forced = corridor.path(11, 1, 11, 21, { threats: threat });
  ok('a route that only exists through its reach is still taken', forced.found,
     forced.found ? `${forced.steps.length} steps` : forced.reason);

  // A hard `avoid` on the same square would refuse — which is the behaviour this is
  // deliberately NOT.
  const blocked = corridor.path(11, 1, 11, 21, { avoid: new Set(['11,11']) });
  ok('...where a hard avoid would have refused it', !blocked.found, blocked.reason);

  ok('no threats means no cost map at all', g.threatField([]) === null);
  ok('the penalty tapers with distance', (() => {
    const f = g.threatField(threat);
    return f(11, 14) > f(11, 16) && f(11, 16) > 0 && f(11, 18) === 0;
  })(), 'full weight inside reach, nothing outside vision');
  ok('two monsters stack', (() => {
    const one = g.threatField([{ row: 11, col: 11, vision: 6, reach: 3 }])(11, 11);
    const two = g.threatField([{ row: 11, col: 11, vision: 6, reach: 3 },
                               { row: 11, col: 12, vision: 6, reach: 3 }])(11, 11);
    return two > one;
  })());
}

// ------------------------------------------------------- standing in a "wall"
//
// The router used to refuse to plan at all when the square it was STANDING ON read as
// no-floor, and return `stuck: true` with a sentence telling the caller it was trapped.
// That answer is emitted before a single packet goes out, on no evidence but a
// one-byte-per-square projection we have caught being wrong three ways in an
// afternoon — and it does not even need the grid to be wrong, because a dead-reckoned
// position that is one step stale reads exactly the same. It was the first of the seven
// refusals on every failed edge crossing.
//
// Standing somewhere is proof it is standable. So: recover onto the nearest square the
// grid believes in, and say so, rather than refusing.
console.log('\nstanding where the grid says there is no floor');
{
  const rows = 21, cols = 21;
  const flags = Buffer.alloc(rows * cols, 1);
  flags[(11 - 1) * cols + (11 - 1)] = 0;            // the square we are standing on
  const g = new RoomGeometry({ file: 'synthetic', version: 13, rows, cols,
    grid: Buffer.alloc(rows * cols, 0xff), flags, monsterGrid: null,
    walls: [], sidedefs: [], sectors: [], clientSize: null });

  const p = g.path(11, 11, 11, 20);
  ok('it plans a route instead of declaring itself trapped', p.found, p.reason || `${p.steps.length} steps`);
  ok('...and does not report stuck', !p.stuck);
  ok('the first step recovers onto believable floor',
     p.steps[0]?.recovered === true && g.walkable(p.steps[0].row, p.steps[0].col),
     JSON.stringify(p.steps[0]));
  ok('it still ends at the goal', p.steps.at(-1).row === 11 && p.steps.at(-1).col === 20);
  ok('it says where it recovered from', !!p.recovered_from);
  // A start with genuinely nothing around it is still a refusal — that one is real.
  const empty = new RoomGeometry({ file: 'synthetic', version: 13, rows, cols,
    grid: Buffer.alloc(rows * cols, 0xff), flags: Buffer.alloc(rows * cols, 0),
    monsterGrid: null, walls: [], sidedefs: [], sectors: [], clientSize: null });
  ok('a room with no floor at all is still refused', !empty.path(11, 11, 11, 20).found);
  // And the normal case must not have grown a phantom first step.
  const plain = new RoomGeometry({ file: 'synthetic', version: 13, rows, cols,
    grid: Buffer.alloc(rows * cols, 0xff), flags: Buffer.alloc(rows * cols, 1),
    monsterGrid: null, walls: [], sidedefs: [], sectors: [], clientSize: null });
  const q = plain.path(11, 11, 11, 20);
  ok('a normal route is unchanged', q.found && !q.recovered_from && q.steps.length === 9,
     `${q.steps.length} steps`);
}

// ------------------------------------------------------- against the real tree
//
// Everything above runs anywhere. This part needs the game's own room files, so it
// SKIPS rather than fails when they are absent — a clone without M59_ROOT is not a
// broken checkout.
const roomsDir = DEFAULT_ROO_DIRS.find(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
  || (process.env.M59_ROOT ? process.env.M59_ROOT + '/resource/rooms' : null);
console.log('\nagainst the real rooms');
if (!roomsDir) {
  skip('every room parses', 'no resource/rooms directory on this machine');
  skip('the slope stride is right', 'ditto');
  skip('the Limping Toad', 'ditto');
} else {
  const files = fs.readdirSync(roomsDir).filter(f => f.toLowerCase().endsWith('.roo'));
  let parsed = 0, threw = 0, withSectors = 0, withLeaves = 0, leafRefs = 0,
      badLeafRefs = 0, sloped = 0, wading = 0;
  const deltas = new Map();
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(roomsDir, f)); } catch { continue; }
    try {
      const g = parseRoo(buf, f);
      parsed++;
      const h = g.heightSummary;
      if (h) { withSectors++; if (h.sloped) sloped++; if (h.wading) wading++; }
      if (g.leaves?.length) withLeaves++;
      for (const leaf of g.leaves || []) {
        leafRefs++;
        if (leaf.sector !== g.sectors?.[leaf.sectorNum - 1]) badLeafRefs++;
      }
    } catch { threw++; continue; }
    // Where the variable-length walk ENDS. A wrong stride shows up here as a delta
    // that differs between flat rooms and sloped ones, which is the only signal
    // available without reimplementing the BSP to check the file's own checksum.
    const version = buf.readInt32LE(4), mainOff = buf.readInt32LE(12);
    const sectorOff = buf.readInt32LE(mainOff + 8 + 16);
    let q = sectorOff; const n = buf.readUInt16LE(q); q += 2;
    let hadSlope = false;
    for (let i = 0; i < n; i++) {
      const flags = buf.readInt32LE(q + 15);
      q += 19 + (version >= 10 ? 1 : 0);
      if (flags & SF.SLOPED_FLOOR) { q += 46; hadSlope = true; }
      if (flags & SF.SLOPED_CEILING) { q += 46; hadSlope = true; }
    }
    const key = `${buf.readInt32LE(16) - q}`;
    const bucket = deltas.get(key) || { flat: 0, sloped: 0 };
    bucket[hadSlope ? 'sloped' : 'flat']++;
    deltas.set(key, bucket);
  }
  ok('every room parses without throwing', threw === 0, `${parsed} parsed, ${threw} threw`);
  ok('every room yields sectors', withSectors === parsed, `${withSectors}/${parsed}`);
  ok('every room yields BSP leaf surfaces', withLeaves === parsed, `${withLeaves}/${parsed}`);
  ok('every real leaf resolves to its parsed sector', leafRefs > 0 && badLeafRefs === 0,
     `${leafRefs} leaves, ${badLeafRefs} bad references`);
  ok('the tree really does contain slopes', sloped > 0, `${sloped} rooms sloped, ${wading} wading`);
  // THE STRIDE PROOF. Sloped rooms must land on the same boundary as flat ones. If the
  // 46 were wrong, every sloped room would be displaced by a multiple of the error and
  // would land in its own bucket.
  const slopedBuckets = [...deltas.entries()].filter(([, v]) => v.sloped > 0);
  const flatBuckets = [...deltas.entries()].filter(([, v]) => v.flat > 0);
  const shared = slopedBuckets.every(([k]) => flatBuckets.some(([j]) => j === k));
  ok('sloped rooms end where flat rooms end', shared && slopedBuckets.length === 1,
     [...deltas.entries()].map(([k, v]) => `${k}:${v.flat}f/${v.sloped}s`).join(' '));

  // ------------------------------------------------- the Limping Toad, and a correction
  //
  // docs/m59-geometry-plan.md set this room as task 0's acceptance test, on the
  // expectation that its unreachable-but-walkable squares were a HEIGHT problem and
  // that parsing sectors would show them reachable. It is not, and it does not.
  //
  // The floors either side of the boundary that strands them are both at 3200, dead
  // flat. What actually strands them is a wall covering HALF of one square's edge:
  // the .roo carries movement as one byte per square, so "half of this edge is
  // blocked" has nowhere to live and the whole edge reads as blocked. Heights are
  // real and worth having — this room has a raised area with genuine stairs and
  // genuine cliffs — but they are not this bug, and the raycast is.
  //
  // Pinned so the claim in the plan cannot quietly drift back.
  const toad = path.join(roomsDir, 'marinn.roo');
  if (!fs.existsSync(toad)) skip('the Limping Toad', 'marinn.roo not present');
  else {
    const g = parseRoo(fs.readFileSync(toad), 'marinn.roo');
    const h = g.heightSummary;
    ok('the Toad has sectors and relief', h.sectors === 30 && h.floorMax > h.floorMin,
       `${h.sectors} sectors, floors ${h.floorMin}..${h.floorMax}`);
    ok('it has both climbable steps and real cliffs', h.steps > 0 && h.cliffs > 0,
       `${h.steps} steps, ${h.cliffs} cliffs`);
    // The boundary that strands the perimeter: col 12|13 at row 5.
    const onLine = g.walls.filter(w => w.x0 === 12288 && w.x1 === 12288);
    ok('one wall covers half of that edge', onLine.length === 1
       && Math.abs(onLine[0].y1 - onLine[0].y0) === CLIENT_FINENESS / 2,
       onLine.map(w => `y ${Math.min(w.y0, w.y1)}..${Math.max(w.y0, w.y1)}`).join(''));
    ok('and both floors there are level', onLine.every(w => w.z1 - w.z0 === 0),
       'so height is NOT what blocks it');
    const walkable = [];
    for (let r = 1; r <= g.rows; r++) for (let c = 1; c <= g.cols; c++) if (g.walkable(r, c)) walkable.push([r, c]);
    const seen = new Set(['8,8']); const q = [[8, 8]];
    while (q.length) { const [r, c] = q.pop();
      for (const nb of g.neighbors(r, c)) { const k = `${nb.row},${nb.col}`; if (!seen.has(k)) { seen.add(k); q.push([nb.row, nb.col]); } } }
    ok('the coarse grid still strands part of the room', walkable.length - seen.size > 0,
       `${walkable.length - seen.size} of ${walkable.length} walkable squares unreachable from (8,8)`);
  }
}

console.log('\nheight map from BSP leaves');
if (!roomsDir) {
  skip('floorHeightAtCell / heightMap / heightStepOk', 'no resource/rooms directory');
} else {
  // Flat room: every resolved cell has the same height, all steps legal.
  const flat = parseRoo(fs.readFileSync(path.join(roomsDir, 'c4.roo')), 'c4.roo');
  const fhm = flat.heightMap();
  const fvals = [...new Set(fhm)].filter(v => v >= 0);
  ok('flat room has a single floor height', fvals.length === 1, `${fvals.length} unique`);
  // Pick two adjacent resolved cells; a step between them must be legal.
  let flatPair = null;
  outer: for (let r = 1; r < flat.rows; r++) for (let c = 1; c < flat.cols; c++) {
    if (fhm[(r-1)*flat.cols + (c-1)] >= 0 && fhm[(r-1)*flat.cols + c] >= 0) { flatPair = [r, c]; break outer; }
  }
  if (flatPair) {
    const [r, c] = flatPair;
    ok('flat adjacent step is legal', flat.heightStepOk(r, c, r, c + 1) === true);
    ok('same-cell step is legal', flat.heightStepOk(r, c, r, c) === true);
  }
  // Multi-level room: more than one height, and some adjacent steps are ledges (illegal).
  const multi = parseRoo(fs.readFileSync(path.join(roomsDir, 'KA1.roo')), 'KA1.roo');
  const mhm = multi.heightMap();
  const mvals = [...new Set(mhm)].filter(v => v >= 0);
  ok('multi-level room has several floor heights', mvals.length > 3, `${mvals.length} unique`);
  let legal = 0, ledge = 0, voidPair = 0;
  for (let r = 1; r < multi.rows; r++) for (let c = 1; c < multi.cols; c++) {
    const a = mhm[(r-1)*multi.cols + (c-1)];
    const b = mhm[(r-1)*multi.cols + c];
    if (a >= 0 && b >= 0) {
      if (multi.heightStepOk(r, c, r, c + 1)) legal++; else ledge++;
    } else if (a >= 0 || b >= 0) voidPair++;
  }
  ok('multi-level room has at least one ledge between resolved neighbours', ledge > 0, `${ledge} ledges, ${legal} steps`);
  // A void neighbour is never a legal step.
  let voidChecked = false;
  for (let r = 1; r < multi.rows && !voidChecked; r++) for (let c = 1; c < multi.cols; c++) {
    const a = mhm[(r-1)*multi.cols + (c-1)], b = mhm[(r-1)*multi.cols + c];
    if (a >= 0 && b < 0) { ok('step into a void is illegal', multi.heightStepOk(r, c, r, c + 1) === false); voidChecked = true; break; }
  }
}

// FINE-GRID WALKABILITY + HIDDEN CELLS.
// The coarse grid is a coarser approximation of the wall segments. A cell the coarse
// grid calls WALL but the fine grid is open in is an asymmetric safe spot: the player
// (fine-grid, any direction) can stand there, a monster (NSEW on the coarse grid)
// cannot step in. hiddenCells() must return exactly those interior, reachable cells.
{
  const { loadRoo } = await import('./m59-roo.mjs');
  const m59Root = process.env.M59_ROOT || '/Users/costas/Documents/Projects/Meridian59';
  const dir = m59Root + '/resource/rooms';
  // Valley of Ileria (d4.roo) is a multi-level room whose coarse grid is coarser than
  // the wall segments, so it has hidden cells. Deep Woods (c4.roo) is flat and aligned.
  const d4 = loadRoo('d4.roo', [dir]);
  ok('fineWalkable is a function', typeof d4.fineWalkable === 'function');
  ok('hiddenCells is a function', typeof d4.hiddenCells === 'function');
  // A coarse-wall cell that is fine-open must be reported fineWalkable=true.
  let foundHidden = false, foundCoarseOpen = false;
  const hidden = d4.hiddenCells();
  for (const [c, r] of hidden) {
    ok(`hidden cell (${c},${r}) is coarse-wall`, d4.walkable(r, c) === false);
    ok(`hidden cell (${c},${r}) is fine-open`, d4.fineWalkable(r, c) === true);
    ok(`hidden cell (${c},${r}) is interior`, r > 0 && c > 0 && r < d4.rows - 1 && c < d4.cols - 1);
    foundHidden = true;
  }
  // There must be at least one hidden cell in d4 (the coarse/fine mismatch is real).
  ok('d4 has at least one hidden safe cell', hidden.length > 0, `${hidden.length}`);
  // A coarse-walkable cell must never be in the hidden list.
  ok('no coarse-walkable cell is hidden', hidden.every(([c, r]) => d4.walkable(r, c) === false));

  // FINE-GRID FALLBACK ROUTING: when the room has wall data but no baked step mask, the
  // coarse grid (openDirections) used to hold a silent veto over fine-open cells. With the
  // fallback, a step the coarse grid vetoes is reconsidered against the fine grid and kept
  // if the destination is open. Verify a route can now be planned INTO a hidden cell from
  // a coarse-walkable neighbour (the goal-exempt path would find it anyway, but the
  // neighbour->hidden step must be offered by the fine fallback, not the coarse grid).
  const [hc, hr] = hidden[0];
  // find a coarse-walkable neighbour of the hidden cell
  let nb = null;
  for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
    const nr = hr + dr, nc = hc + dc;
    if (d4.walkable(nr, nc) && d4.standable(nr, nc)) { nb = [nc, nr]; break; }
  }
  if (nb) {
    const [bc, br] = nb;
    // The neighbour must itself be offered a step toward the hidden cell by the fine grid.
    const p = d4.path(br, bc, hr, hc, { collision: true });
    ok(`fine-fallback routes into hidden cell (${hc},${hr})`, p.found === true, p.reason ?? 'found');
    // And back out (we can get in AND out — not a trap). Since 37e4611 the ROUTER's
    // collision view is deliberately coarse-conservative (generosity there invented roads —
    // room 27's eight-hop route through a stranded boundary), and the fine tolerance lives
    // in the MOVER's view: fineWiden. So "not a trap" is tested at the level it is true at:
    // a body standing on the hidden cell is OFFERED a step toward the coarse-walkable
    // neighbour by the mover's view, and the mover's own trace (moverStepLands) accepts it.
    const offered = d4.neighbors(hr, hc, { fine: true, collision: true, fineWiden: true })
      .some(n => n.row === br && n.col === bc);
    ok(`mover's view offers a step out of hidden cell (${hc},${hr})`, offered === true,
       JSON.stringify(d4.neighbors(hr, hc, { fine: true, collision: true, fineWiden: true })));
    if (offered) {
      ok(`moverStepLands accepts the step out of hidden cell (${hc},${hr})`,
         d4.moverStepLands(hr, hc, br, bc) === true);
    }
  }
  // Regression: a normal route through the room body still works.
  const pnorm = d4.path(10, 10, 20, 20, { collision: true });
  ok('normal route still works with fine fallback', pnorm.found === true, pnorm.reason ?? 'found');

  // FINE-AWARE EXIT GATE: edgeCrossingCandidates prefers coarse-walkable staging squares,
  // but when the coarse grid vetoes every candidate (a pocket) it falls back to fine-walkable
  // ones, and only then to everything. The key property: a fine-open but coarse-unwalkable
  // candidate is never DROPPED when it is the only option — a filter must not delete a door.
  if (typeof d4.edgeCrossingCandidates === 'function' && d4.walls?.length) {
    for (const dir of ['north', 'south', 'west', 'east']) {
      const ranges = d4.edgeCrossingRanges(dir);
      if (!ranges.length) continue; // no crossing this way, nothing to gate
      const cands = d4.edgeCrossingCandidates(dir);
      ok(`${dir}: exit candidates are all in-bounds`, cands.every(c => d4.inBounds(c.row, c.col)));
      // Every candidate the gate returns must be at least fine-walkable OR coarse-walkable
      // (never a square that is both coarse-wall AND fine-wall — that would be a dead door).
      const viable = cands.filter(c => d4.walkable(c.row, c.col) || d4.fineWalkable(c.row, c.col) === true);
      ok(`${dir}: all ${cands.length} exit candidates are viable (coarse or fine)`, viable.length === cands.length, `viable=${viable.length}`);
    }
  }

  // fineWiden: the coarse flood (collision: false) can widen into fine-open cells when asked,
  // but NOT by default. Verify a hidden cell is reachable from a coarse neighbour WITH
  // fineWiden but the option does not change the default coarse path for non-pocket callers.
  { const [hc, hr] = hidden[0];
    let nb = null;
    for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
      const nr = hr + dr, nc = hc + dc;
      if (d4.walkable(nr, nc) && d4.standable(nr, nc)) { nb = [nc, nr]; break; }
    }
    if (nb) {
      const [bc, br] = nb;
      // Default coarse neighbours (no fineWiden) — record what is offered.
      const plain = d4.neighbors(br, bc, { collision: false });
      // fineWiden coarse neighbours — must be a SUPERSET (permissive: only adds, never removes).
      const widened = d4.neighbors(br, bc, { collision: false, fineWiden: true });
      const plainKeys = new Set(plain.map(n => `${n.row},${n.col}`));
      const widenedKeys = new Set(widened.map(n => `${n.row},${n.col}`));
      ok('fineWiden is permissive: coarse neighbours are a subset of widened neighbours',
         [...plainKeys].every(k => widenedKeys.has(k)), `plain=${plainKeys.size} widened=${widenedKeys.size}`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
