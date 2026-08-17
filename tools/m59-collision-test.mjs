#!/usr/bin/env node
// Local player collision, offline and deterministic:
//
//   node tools/m59-collision-test.mjs

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  CLIENT_FINENESS, COLLISION_VERSION, DEFAULT_ROO_DIRS, KOD_FINENESS,
  MAX_STEP_HEIGHT, MIN_SIDE_MOVE, PLAYER_HEIGHT, PLAYER_RADIUS,
  RoomGeometry, WF, canCrossWallAt, parseRoo, setWallHeights, sharedRoomGeometry,
} from './m59-roo.mjs';
import { BP, M59Client } from './m59-client.mjs';
import { MOVEON, blocksMovement, parsePlayer } from './m59-parse.mjs';
import {
  COND, LEAVE, edgeCandidatesOf, edgeExitsOf, findPath,
  geometryManifest, movementMapReadiness, roomResourceDirs, setGeometryProvenance,
  resourcePathWithin,
} from './m59-map.mjs';
import {
  CHECKED_MAP_FILE, LOCAL_MAP_FILE, geometryOutputFile,
  geometryRefreshBaseFile, movementMapFile,
} from './m59-map-path.mjs';
import { isTerminalMovementReason } from './m59-movement.mjs';
import { World, boundedRegionEntry, spreadEdges } from './m59-world.mjs';

let pass = 0, fail = 0, skipped = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const skip = (name, detail) => {
  skipped++;
  console.log('  skip ' + name + (detail ? '  ' + detail : ''));
};

const sector = ({ floor = 0, ceiling = 4096, depth = 0, floorSlope = null,
                  ceilingSlope = null, flags = null } = {}) => ({
  floorHeight: floor, ceilingHeight: ceiling, depth,
  slopedFloor: floorSlope, slopedCeiling: ceilingSlope,
  ...(Number.isInteger(flags) ? { flags } : {}),
});
const side = ({ passable = false, above = false, below = true } = {}) => ({
  flags: passable ? WF.PASSABLE : 0,
  aboveType: above ? 1 : 0,
  belowType: below ? 1 : 0,
});

const TEST_SECURITY = 0x02345678;
const CLIENT_PER_KOD = CLIENT_FINENESS / KOD_FINENESS;
const clientToWire = value => value / CLIENT_PER_KOD + KOD_FINENESS;
const wireToClient = value => (value - KOD_FINENESS) * CLIENT_PER_KOD;
const squareCenterClient = square => wireToClient(square * KOD_FINENESS + (KOD_FINENESS >> 1));
const redigestCollision = json => {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    file: json.file, security: json.security, version: json.version,
    rows: json.rows, cols: json.cols,
    grid: json.grid, flags: json.flags, monsterGrid: json.monsterGrid,
    walls: json.walls, edgeOpenings: json.edgeOpenings,
    edgeApproaches: json.edgeApproaches,
  }));
  for (const key of ['wallSides', 'sectors', 'leaves', 'nodes']) {
    hash.update('\0' + key + '\0');
    hash.update(Buffer.from(json.collision[key], 'base64'));
  }
  json.collision.digest = hash.digest('hex');
  return json;
};

function twoSides({ left = sector(), right = sector(), pos = side(), neg = side(),
                    wallY0 = 0, wallY1 = 4096 } = {}) {
  const sectors = [left, right];
  const wall = setWallHeights({
    x0: 2048, y0: wallY0, x1: 2048, y1: wallY1,
    posSector: 1, negSector: 2,
    posSidedefRec: pos, negSidedefRec: neg,
    drawable: !!(pos || neg), passable: !!((pos || neg)?.flags & WF.PASSABLE),
    mapNever: false, mapAlways: false, collisionMetadata: true, collisionNode: 1,
    nextWall: 0, nextCollisionWall: 0,
  }, sectors);
  const leaves = [
    { type: 'leaf', node: 2, sectorNum: 1, sector: left, bbox: [0, 0, 2048, 4096],
      polygon: [[0, 0], [2048, 0], [2048, 4096], [0, 4096]] },
    { type: 'leaf', node: 3, sectorNum: 2, sector: right, bbox: [2048, 0, 4096, 4096],
      polygon: [[2048, 0], [4096, 0], [4096, 4096], [2048, 4096]] },
  ];
  // The canonical client BSP is 0-based. Protocol coordinates add one KOD square
  // (64 fine units) on the wire; broker tests below cross that boundary explicitly.
  const root = { type: 'internal', node: 1, positive: 2, negative: 3,
                 bbox: [0, 0, 4096, 4096], firstWall: 1, firstCollisionWall: 1,
                 separator: { a: -CLIENT_FINENESS, b: 0,
                              c: 2048 * CLIENT_FINENESS } };
  return new RoomGeometry({ file: 'synthetic.roo', version: 13, security: TEST_SECURITY,
    rows: 4, cols: 4,
    grid: Buffer.alloc(16, 0xff), flags: Buffer.alloc(16, 1), monsterGrid: null,
    walls: [wall], sidedefs: [pos, neg].filter(Boolean), sectors,
    nodes: [root, ...leaves], leaves, bspRoot: 1,
    clientSize: { width: 4096, height: 4096, rows: 4, cols: 4 },
    collisionVersion: COLLISION_VERSION });
}

function threeStrips({ left = sector(), middle = sector(), right = sector(),
                       firstX = 1400, secondX = 2600,
                       firstPos = side({ passable: true }),
                       firstNeg = side({ passable: true }),
                       secondPos = side({ passable: true }),
                       secondNeg = side({ passable: true }) } = {}) {
  const sectors = [left, middle, right];
  const makeWall = (x, posSector, negSector, posSidedefRec, negSidedefRec, collisionNode) =>
    setWallHeights({
      x0: x, y0: 0, x1: x, y1: 4096,
      posSector, negSector, posSidedefRec, negSidedefRec,
      drawable: true, passable: true, mapNever: false, mapAlways: false,
      collisionMetadata: true, collisionNode, nextWall: 0, nextCollisionWall: 0,
    }, sectors);
  const walls = [
    makeWall(firstX, 1, 2, firstPos, firstNeg, 1),
    makeWall(secondX, 2, 3, secondPos, secondNeg, 2),
  ];
  const leaves = [
    { type: 'leaf', node: 3, sectorNum: 1, sector: left,
      bbox: [0, 0, firstX, 4096],
      polygon: [[0, 0], [firstX, 0], [firstX, 4096], [0, 4096]] },
    { type: 'leaf', node: 4, sectorNum: 2, sector: middle,
      bbox: [firstX, 0, secondX, 4096],
      polygon: [[firstX, 0], [secondX, 0], [secondX, 4096], [firstX, 4096]] },
    { type: 'leaf', node: 5, sectorNum: 3, sector: right,
      bbox: [secondX, 0, 4096, 4096],
      polygon: [[secondX, 0], [4096, 0], [4096, 4096], [secondX, 4096]] },
  ];
  const splitter = (node, x, positive, negative) => ({
    type: 'internal', node, positive, negative,
    bbox: [node === 1 ? 0 : firstX, 0, 4096, 4096],
    firstWall: node, firstCollisionWall: node,
    separator: { a: -CLIENT_FINENESS, b: 0, c: x * CLIENT_FINENESS },
  });
  const nodes = [splitter(1, firstX, 3, 2), splitter(2, secondX, 4, 5), ...leaves];
  return new RoomGeometry({ file: 'three-strips.roo', version: 13, security: TEST_SECURITY,
    rows: 4, cols: 4,
    grid: Buffer.alloc(16, 0xff), flags: Buffer.alloc(16, 1), monsterGrid: null,
    walls, sidedefs: [firstPos, firstNeg, secondPos, secondNeg].filter(Boolean), sectors,
    nodes, leaves, bspRoot: 1,
    clientSize: { width: 4096, height: 4096, rows: 4, cols: 4 },
    collisionVersion: COLLISION_VERSION });
}

const across = (g, y = 2048, options = {}) =>
  g.traceFineMoveClient(1024, y, 3072, y, options);
const back = (g, y = 2048, options = {}) =>
  g.traceFineMoveClient(3072, y, 1024, y, options);

console.log('runtime geometry controls and raw room security');
{
  // ToCliPlayer appends these fields after the ordinary identity/room record. They
  // are not presentation metadata: the low three room-flag bits select live floor
  // overrides used by the stock client's collision pass.
  const body = Buffer.alloc(54);
  let at = 0;
  const u32 = value => { body.writeUInt32LE(value >>> 0, at); at += 4; };
  const i32 = value => { body.writeInt32LE(value, at); at += 4; };
  for (const value of [101, 102, 103, 49, 104, 105, TEST_SECURITY]) u32(value);
  body.writeUInt8(17, at++);              // room light
  body.writeUInt8(23, at++);              // player light
  u32(106);                               // background resource
  u32(107);                               // wading sound
  u32(0x05);                              // depth-1 and depth-3 override flags
  i32(30); i32(-2); i32(50);              // KOD heights, converted to client units

  const player = parsePlayer(body);
  ok('BP_PLAYER parses security, room flags, and all three depth overrides',
     player.exact && player.security === TEST_SECURITY && player.roomFlags === 0x05 &&
     JSON.stringify(player.overrideDepths) === JSON.stringify([0, 480, -32, 800]),
     JSON.stringify(player));

  const liveClient = new M59Client({ verbose: false, resources: new Map() });
  liveClient.roomContents = () => ++liveClient.roomContentsRequested;
  liveClient.onGameMessage(BP.PLAYER, body);
  ok('M59Client installs BP_PLAYER runtime collision controls on the live room',
     liveClient.room.security === TEST_SECURITY && liveClient.room.flags === 0x05 &&
     JSON.stringify(liveClient.room.overrideDepths) === JSON.stringify([0, 480, -32, 800]) &&
     liveClient.room.collisionInvalidated === null,
     JSON.stringify(liveClient.room));

  // With no override, wading puts the source body at z=296 and the 850-unit
  // destination is a 554-unit cliff. Runtime depth-1 raises that body to z=480,
  // making the same 370-unit step legal. This proves the parsed values reach the
  // actual crossability decision rather than merely surviving parsing.
  const overridden = twoSides({
    left: sector({ floor: 500, depth: 204, flags: 1 }),
    right: sector({ floor: 850 }),
    pos: side({ passable: true }), neg: side({ passable: true }),
  });
  const staticDepth = across(overridden);
  const runtimeDepth = across(overridden, 2048,
    { roomFlags: player.roomFlags, overrideDepths: player.overrideDepths });
  ok('a BP_PLAYER depth override changes wall-step crossability',
     !staticDepth.arrived && runtimeDepth.arrived,
     JSON.stringify({ staticDepth, runtimeDepth }));

  const rawPath = DEFAULT_ROO_DIRS.map(dir => join(dir, 'marion.roo')).find(existsSync);
  if (!rawPath) {
    skip('raw .roo checksum rejects collision corruption', 'marion.roo is not installed');
  } else {
    const raw = readFileSync(rawPath);
    const original = parseRoo(raw, 'marion.roo');
    const corrupt = Buffer.from(raw);
    const mainOff = corrupt.readInt32LE(12);
    const wallOff = corrupt.readInt32LE(mainOff + 12);
    // Change one summed coordinate byte while preserving every offset and record
    // length. The retained header must no longer authenticate the collision body.
    corrupt[wallOff + 2 + 6] ^= 1;
    let error = null;
    try { parseRoo(corrupt, 'corrupt-marion.roo'); } catch (caught) { error = caught; }
    ok('raw .roo checksum rejects collision corruption',
       original.security === raw.readUInt32LE(8) &&
       /room security checksum mismatch/i.test(error?.message ?? ''),
       error?.message ?? 'corrupt body unexpectedly parsed');
  }
}

console.log('collision data survives the baked-map boundary');
{
  const raw = twoSides({ right: sector({ floor: 320 }),
                         pos: side({ passable: true, above: true }),
                         neg: side({ passable: false, below: false }) });
  const baked = raw.toJSON({ includeSurfaces: false });
  const restored = RoomGeometry.fromJSON(baked);
  ok('compact collision payload is versioned', baked.collisionVersion === COLLISION_VERSION);
  ok('round trip restores collision readiness', restored.collisionReady);
  ok('round trip preserves the room security binding', restored.security === TEST_SECURITY);
  ok('round trip restores the BSP root and internal splitter', restored.bspRoot === 1 &&
     restored.nodes?.[0]?.type === 'internal');
  ok('round trip restores both sector references', restored.walls[0].posSector === 1 &&
     restored.walls[0].negSector === 2);
  ok('round trip restores each wall collision owner', restored.walls[0].collisionNode === 1);
  ok('round trip restores the stock BSP wall chain',
     restored.nodes[0].firstCollisionWall === 1 &&
     restored.walls[0].nextCollisionWall === 0);
  ok('round trip restores directional sidedef tests',
     restored.walls[0].posSidedefRec.flags & WF.PASSABLE &&
     !(restored.walls[0].negSidedefRec.flags & WF.PASSABLE) &&
     restored.walls[0].posSidedefRec.aboveType === 1 &&
     restored.walls[0].negSidedefRec.belowType === 0);

  const twiceBaked = restored.toJSON({ includeSurfaces: false });
  const twiceRestored = RoomGeometry.fromJSON(twiceBaked);
  ok('collision metadata survives two full toJSON/fromJSON generations',
     twiceRestored.collisionReady && twiceRestored.nodes[0].firstCollisionWall === 1 &&
     twiceRestored.walls[0].nextCollisionWall === 0 &&
     twiceRestored.traceFineMoveClient(1024, 2048, 3072, 2048).arrived ===
       restored.traceFineMoveClient(1024, 2048, 3072, 2048).arrived,
     JSON.stringify({ first: restored.collisionReady, second: twiceRestored.collisionReady }));

  const unroutable = structuredClone(baked);
  unroutable.edgeApproaches.north = [[96, 96, 96, 63, [[1, 1]], 0]];
  redigestCollision(unroutable);
  const unroutableOnce = RoomGeometry.fromJSON(unroutable);
  const unroutableTwice = RoomGeometry.fromJSON(
    unroutableOnce.toJSON({ includeSurfaces: false }));
  ok('an unroutable baked edge stays unroutable across two map generations',
     unroutableOnce.collisionReady && unroutableTwice.collisionReady &&
     unroutableOnce.edgeApproachCandidates('north')[0]?.graph_routable === false &&
     unroutableTwice.edgeApproachCandidates('north')[0]?.graph_routable === false,
     JSON.stringify({
       first: unroutableOnce.edgeApproachCandidates('north'),
       second: unroutableTwice.edgeApproachCandidates('north'),
     }));

  const wrongDirection = structuredClone(baked);
  wrongDirection.edgeApproaches.north = [[288, 96, 320, 96, [[1, 1]], 0]];
  redigestCollision(wrongDirection);
  ok('a digest-valid approach filed under the wrong edge direction fails closed',
     !RoomGeometry.fromJSON(wrongDirection).collisionReady);

  const legacy = structuredClone(baked);
  delete legacy.collisionVersion; delete legacy.collision;
  const old = RoomGeometry.fromJSON(legacy);
  ok('legacy display-only maps are not collision-ready', !old.collisionReady);
  const refused = old.traceFineMoveClient(1024, 2048, 3072, 2048);
  ok('legacy maps fail fine movement closed', !refused.available &&
     refused.reason === 'collision_geometry_unavailable', JSON.stringify(refused));

  const corrupt = structuredClone(baked);
  corrupt.collision.leaves = corrupt.collision.leaves.slice(0, -8);
  ok('truncated collision payload fails closed', !RoomGeometry.fromJSON(corrupt).collisionReady);

  const wrongOwner = structuredClone(baked);
  const wallSides = Buffer.from(wrongOwner.collision.wallSides, 'base64');
  wallSides.writeUInt16LE(2, 10); // leaf 2, not the owning internal BSP node 1
  wrongOwner.collision.wallSides = wallSides.toString('base64');
  ok('semantically invalid wall ownership fails closed at the compact boundary',
     !RoomGeometry.fromJSON(wrongOwner).collisionReady);

  const cyclic = structuredClone(baked);
  const nodes = Buffer.from(cyclic.collision.nodes, 'base64');
  nodes.writeUInt16LE(1, 8); // root node 1 names itself as its positive child
  cyclic.collision.nodes = nodes.toString('base64');
  ok('a length-correct cyclic compact BSP fails closed',
     !RoomGeometry.fromJSON(cyclic).collisionReady);

  const orphaned = structuredClone(baked);
  const orphanNodes = Buffer.from(orphaned.collision.nodes, 'base64');
  orphanNodes.writeUInt16LE(0, 6 + 30); // root owns no chain, leaving wall 1 orphaned
  orphaned.collision.nodes = orphanNodes.toString('base64');
  redigestCollision(orphaned);
  ok('a digest-valid orphaned wall chain is rejected semantically',
     !RoomGeometry.fromJSON(orphaned).collisionReady);

  const sloped = twoSides({ right: sector({
    floorSlope: { a: 1, b: 0, c: 5, d: 0 },
  }) }).toJSON({ includeSurfaces: false });
  const zeroC = structuredClone(sloped);
  const slopeSectors = Buffer.from(zeroC.collision.sectors, 'base64');
  // Sector 2 starts after the 4-byte count and one 76-byte record; c is the
  // third double in its floor-slope plane.
  slopeSectors.writeDoubleLE(0, 4 + 76 + 12 + 16);
  zeroC.collision.sectors = slopeSectors.toString('base64');
  redigestCollision(zeroC);
  ok('a digest-valid sloped sector with c=0 fails closed',
     !RoomGeometry.fromJSON(zeroC).collisionReady);

  const tinyMap = { rooms: { '1': {
    num: 1, rows: 4, cols: 4, rooFile: 'synthetic.roo', roo: baked,
  } } };
  Object.assign(tinyMap, geometryManifest(tinyMap.rooms));
  const tinyStatus = movementMapReadiness(tinyMap);
  const corruptMap = structuredClone(tinyMap);
  corruptMap.rooms['1'].roo.collision.digest = '0'.repeat(64);
  const corruptStatus = movementMapReadiness(corruptMap);
  ok('map readiness decodes every collision payload and verifies its manifest',
     tinyStatus.ok && tinyStatus.ready === 1 && !corruptStatus.ok &&
     corruptStatus.ready === 0 && !corruptStatus.manifest_matches,
     JSON.stringify({ tinyStatus, corruptStatus }));
  const wrongDimensions = structuredClone(tinyMap);
  wrongDimensions.rooms['1'].rows = 5;
  Object.assign(wrongDimensions, geometryManifest(wrongDimensions.rooms));
  const wrongDimensionsStatus = movementMapReadiness(wrongDimensions);
  ok('map readiness independently binds graph dimensions and room filenames',
     !wrongDimensionsStatus.ok && wrongDimensionsStatus.manifest_matches &&
     wrongDimensionsStatus.ready === 0,
     JSON.stringify(wrongDimensionsStatus));
}

console.log('\nruntime and maintenance map selection');
{
  const explicit = resolve('fixture-map.json');
  ok('an explicit M59_MAP always wins runtime selection',
     movementMapFile({ explicit, exists: () => true }) === explicit);
  ok('runtime selection prefers a generated local map over the reference',
     movementMapFile({ explicit: null, exists: file => file === LOCAL_MAP_FILE }) === LOCAL_MAP_FILE);
  ok('runtime selection falls back to the checked reference when no local map exists',
     movementMapFile({ explicit: null, exists: () => false }) === CHECKED_MAP_FILE);
  ok('a bare geometry refresh updates the checked reference map',
     geometryOutputFile({ explicit: null }) === CHECKED_MAP_FILE);
  ok('refreshing the setup-local map always starts from the current checked graph',
     geometryRefreshBaseFile(LOCAL_MAP_FILE, { exists: () => true }) === CHECKED_MAP_FILE);
  ok('a custom explicit refresh preserves its own graph base',
     geometryRefreshBaseFile(explicit, { exists: file => file === explicit }) === explicit);
  ok('an explicit room-resource directory disables every fallback for build and refresh',
     JSON.stringify(roomResourceDirs({ explicit, defaults: ['steam', 'source'] })) ===
       JSON.stringify([explicit]));
  ok('an explicit room-resource authority rejects absolute and sibling path escapes',
     resourcePathWithin('C:/server/rooms', 'C:/server/rooms/room.roo') &&
     !resourcePathWithin('C:/server/rooms', 'C:/server/other/room.roo') &&
     !resourcePathWithin('C:/server/rooms', 'D:/client/room.roo'));
  const checkedProvenance = setGeometryProvenance({ geometryBuiltAt: 'old' },
    CHECKED_MAP_FILE, { sourceDir: 'C:/Users/example/private/rooms', now: () => 'new' });
  const localProvenance = setGeometryProvenance({}, LOCAL_MAP_FILE,
    { sourceDir: 'C:/server/rooms', now: () => '2026-01-02T03:04:05.000Z' });
  ok('checked-map provenance is canonical while a local map records its source',
     checkedProvenance.geometryBuiltAt == null &&
     checkedProvenance.geometrySource === 'portable reference room resources' &&
     localProvenance.geometryBuiltAt === '2026-01-02T03:04:05.000Z' &&
     localProvenance.geometrySource === resolve('C:/server/rooms'),
     JSON.stringify({ checkedProvenance, localProvenance }));
}

console.log('\nwall, elevation, and headroom rules');
{
  const solid = twoSides();
  const stopped = across(solid);
  ok('a solid wall blocks', stopped.blocked && !stopped.arrived &&
     stopped.x <= 2048 - PLAYER_RADIUS, JSON.stringify(stopped));

  const low = twoSides({ right: sector({ floor: 20 * 16 }),
                         pos: side({ passable: true }), neg: side({ passable: true }) });
  ok('a passable 20-kod step crosses', across(low).arrived);
  const exact = twoSides({ right: sector({ floor: MAX_STEP_HEIGHT }),
                           pos: side({ passable: true }), neg: side({ passable: true }) });
  ok('exactly 24 kod of rise crosses', across(exact).arrived);
  const cliff = twoSides({ right: sector({ floor: MAX_STEP_HEIGHT + 1 }),
                           pos: side({ passable: true }), neg: side({ passable: true }) });
  ok('one client unit above the climb limit blocks', !across(cliff).arrived);
  ok('the same cliff is legal downward', back(cliff).arrived);

  const asymmetric = twoSides({ pos: side({ passable: true }), neg: side({ passable: false }) });
  ok('the source-facing sidedef makes crossing directional',
     across(asymmetric).arrived && !back(asymmetric).arrived);
  const nullFacing = twoSides({ pos: null, neg: side({ passable: false }) });
  ok('a null source-facing sidedef is skipped like move.c', across(nullFacing).arrived);
  const noLowerTexture = twoSides({ right: sector({ floor: 2048 }),
    pos: side({ passable: true, below: false }), neg: side({ passable: true, below: false }) });
  ok('no lower texture short-circuits the step test', across(noLowerTexture).arrived);

  const exactHead = twoSides({ right: sector({ ceiling: PLAYER_HEIGHT }),
    pos: side({ passable: true, above: true }), neg: side({ passable: true, above: true }) });
  ok('exactly one player-height of headroom crosses', across(exactHead).arrived);
  const lowHead = twoSides({ right: sector({ ceiling: PLAYER_HEIGHT - 1 }),
    pos: side({ passable: true, above: true }), neg: side({ passable: true, above: true }) });
  ok('one unit less headroom blocks', !across(lowHead).arrived);

  const water = twoSides({ right: sector({ floor: MAX_STEP_HEIGHT + 100, depth: 204 }),
    pos: side({ passable: true }), neg: side({ passable: true }) });
  ok('destination water depth reduces the effective step', across(water).arrived);
}

console.log('\nD3D bowtie wall-height parity');
{
  const descending = sector({ floorSlope: {
    a: 1000, b: 0, c: 1024, d: -1024 * 1000,
  } });
  const ascending = sector({ floorSlope: {
    a: -1000, b: 0, c: 1024, d: 0,
  } });
  const bowtie = (positive, negative) => setWallHeights({
    x0: 0, y0: 0, x1: 1024, y1: 0,
    posSector: 1, negSector: 2,
    posSidedefRec: side({ passable: true }),
    negSidedefRec: side({ passable: true }),
  }, [positive, negative]);
  const highPositive = bowtie(descending, ascending);
  ok('D3D bowtie keeps the endpoint-0 high split from the positive sector',
     highPositive.bowtie && highPositive.z0 === 0 && highPositive.z1 === 1000 &&
     highPositive.zz0 === 0 && highPositive.zz1 === 0,
     JSON.stringify(highPositive));
  const highNegative = bowtie(ascending, descending);
  ok('D3D bowtie mirrors the stock split when sector order is reversed',
     highNegative.bowtie && highNegative.z0 === 0 && highNegative.z1 === 0 &&
     highNegative.zz0 === 0 && highNegative.zz1 === 1000,
     JSON.stringify(highNegative));
}

console.log('\ncontinuous geometry, slopes, radius, and sliding');
{
  // z = y/5 at the wall. Stock move.c does NOT sample the contact point: it uses
  // SetWallHeights' endpoint-0 z1/z2 values even on a slope. Pin that historical
  // quirk rather than silently authorizing movement the stock client refuses.
  const slope = { a: 0, b: -1, c: 5, d: 0 };
  const lowFirst = twoSides({ right: sector({ floorSlope: slope }),
    pos: side({ passable: true }), neg: side({ passable: true }) });
  ok('a sloped step uses the same endpoint-0 z1 at low and high contact points',
     across(lowFirst, 512).arrived && across(lowFirst, 3000).arrived &&
     canCrossWallAt(lowFirst.walls[0], 2048, 512, 0, 'pos') ===
       canCrossWallAt(lowFirst.walls[0], 2048, 3000, 0, 'pos'));
  const highFirst = twoSides({ right: sector({ floorSlope: slope }),
    pos: side({ passable: true }), neg: side({ passable: true }),
    wallY0: 3000, wallY1: 0 });
  ok('a high endpoint-0 z1 blocks the whole sloped wall like the stock client',
     !across(highFirst, 512).arrived && !across(highFirst, 2500).arrived);

  const ceilingSlope = { a: 0, b: -1, c: 5, d: -3500 }; // 700 + y/5
  const lowCeilingFirst = twoSides({ right: sector({ ceilingSlope }),
    pos: side({ passable: true, above: true }),
    neg: side({ passable: true, above: true }) });
  ok('sloped headroom uses static endpoint-0 z2 at every contact point',
     !canCrossWallAt(lowCeilingFirst.walls[0], 2048, 512, 0, 'pos') &&
     !canCrossWallAt(lowCeilingFirst.walls[0], 2048, 3000, 0, 'pos'));

  const shortWall = twoSides({ wallY0: 1900, wallY1: 2100 });
  ok('the player radius catches a wall endpoint the centerline misses',
     !across(shortWall, 2300).arrived);
  ok('the same ray passes outside the authentic radius', across(shortWall, 2400).arrived);
  ok('a long request cannot tunnel through an intermediate wall',
     !solidLong(shortWall).arrived);

  const beside = shortWall.traceFineMoveClient(1800, 2000, 1500, 2000);
  ok('moving away while already close to a wall is allowed', beside.arrived);

  const wall = twoSides();
  const slid = wall.traceFineMoveClient(1024, 1024, 3072, 3072);
  ok('a diagonal collision slides along the wall without crossing it',
     slid.moved && slid.slid && !slid.arrived && slid.x <= 2048 - PLAYER_RADIUS,
     JSON.stringify(slid));

  const voided = twoSides({ pos: side({ passable: true, below: false }),
                            neg: side({ passable: true, below: false }) });
  voided.leaves = [voided.leaves[0]];
  voided.nodes = [
    { ...voided.nodes[0], negative: 0 },
    voided.nodes[1],
  ];
  const voidResult = across(voided);
  ok('a destination with no BSP floor is never emitted', !voidResult.arrived &&
     voidResult.reason === 'destination_has_no_floor', JSON.stringify(voidResult));

  const brownestone = twoSides({
    left: sector({ floor: 2560, ceiling: 3776 }),
    right: sector({ floor: 2304, ceiling: 4352 }),
    pos: side({ passable: true, above: true }),
    neg: side({ passable: true, above: true }),
  });
  ok('the Brownestone 256-unit step and 1472 headroom remain legal',
     across(brownestone).arrived && back(brownestone).arrived);
}

console.log('\npacket vertical state and stock slide retries');
{
  const overhang = threeStrips({
    left: sector({ floor: 1000 }), middle: sector({ floor: 0 }),
    right: sector({ floor: 0, ceiling: 1500 }),
    secondPos: side({ passable: true, above: true }),
    secondNeg: side({ passable: true, above: true }),
  });
  const alreadyLow = overhang.traceFineMoveClient(1800, 2048, 3400, 2048,
    { slide: false });
  const descendedThisPacket = overhang.traceFineMoveClient(600, 2048, 3400, 2048,
    { slide: false });
  ok('a body already on the low floor fits under the overhang', alreadyLow.arrived,
     JSON.stringify(alreadyLow));
  ok('downhill movement preserves physical Z through the packet and blocks at a low overhang',
     !descendedThisPacket.arrived && descendedThisPacket.motionZ?.min === 0 &&
     descendedThisPacket.motionZ?.max === 1000 &&
     descendedThisPacket.x <= 2600 - PLAYER_RADIUS,
     JSON.stringify(descendedThisPacket));

  // Drive the real retry ladder with deterministic wall hits. This isolates the
  // stock-client order (first projection, second-wall projection, then +/-64 side
  // moves) from BSP fixture accidents while still executing production code.
  const firstWall = { x0: 0, y0: 0, x1: 100, y1: 100 };
  const secondWall = { x0: 0, y0: 0, x1: 100, y1: 0 };
  const scriptedResolve = (from, to, hits) => {
    const calls = [];
    const geometry = Object.create(RoomGeometry.prototype);
    geometry.leafAtClient = () => ({ sectorNum: 1, sector: sector() });
    geometry._blockingWall = (_old, target) => {
      calls.push({ x: target.x, y: target.y });
      const wall = hits[calls.length - 1];
      return wall ? { wall, index: calls.length, contact: 0, reason: 'geometry_blocked' } : null;
    };
    const result = geometry._resolveClientMicrostep(from, to, {
      slide: true, playerRadius: PLAYER_RADIUS, playerHeight: PLAYER_HEIGHT,
      roomFlags: 0, overrideDepths: null, motionZ: null,
    });
    return { calls, result };
  };
  const secondRetry = scriptedResolve(
    { x: 100, y: 100, sectorNum: 1 }, { x: 130, y: 110 },
    [firstWall, secondWall, null]);
  ok('a slide blocked by a second wall projects along that second wall before sending',
     secondRetry.calls.length === 3 && secondRetry.result.moved && secondRetry.result.slid &&
     secondRetry.result.x === 120 && secondRetry.result.y === 100,
     JSON.stringify(secondRetry));

  const sideRetry = scriptedResolve(
    { x: 100, y: 100, sectorNum: 1 }, { x: 130, y: 140 },
    [firstWall, secondWall, secondWall, secondWall, null]);
  ok('two blocked projections fall back to the stock +/-MIN_SIDE_MOVE side step',
     MIN_SIDE_MOVE === 64 && sideRetry.calls.length === 5 &&
     sideRetry.result.moved && sideRetry.result.slid &&
     sideRetry.result.x === 151 && sideRetry.result.y === 62,
     JSON.stringify(sideRetry));
}

function solidLong(g) {
  return g.traceFineMoveClient(128, 2300, 3968, 2300);
}

console.log('\nchecked-in room regressions');
{
  const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
  const rooms = Object.values(map.rooms);
  const geometries = rooms.map(room => RoomGeometry.fromJSON(room.roo));
  const readyCount = geometries.filter(geometry => geometry.collisionReady).length;
  ok('every shipped room has collision-ready geometry',
     readyCount === geometries.length, `${readyCount}/${geometries.length}`);

  const inn = RoomGeometry.fromJSON(map.rooms['106'].roo);
  // This is the actual narrow strip Camilla has to leave: moving north from the
  // 300-unit pocket crosses the 256-unit doorway step. Testing canCrossWall alone
  // misses the neighbouring wall and the player cylinder; trace the whole request.
  const brownestoneExit = inn.traceFineMoveClient(11776, 16684, 11776, 16084,
    { slide: false });
  ok('the exact real Brownestone doorway trace remains legal', brownestoneExit.arrived,
     JSON.stringify(brownestoneExit));

  const toad = RoomGeometry.fromJSON(map.rooms['202'].roo);
  const blockedHalf = toad.traceFineMoveClient(11264, 4352, 13312, 4352);
  const openHalf = toad.traceFineMoveClient(11264, 4864, 13312, 4864);
  ok('the Limping Toad half-wall blocks only its solid half',
     !blockedHalf.arrived && openHalf.arrived,
     JSON.stringify({ blockedHalf, openHalf }));

  const icky = RoomGeometry.fromJSON(map.rooms['587'].roo);
  const fineWalk = (start, target) => {
    let at = { x: squareCenterClient(start.col), y: squareCenterClient(start.row) };
    const dest = { x: squareCenterClient(target.col), y: squareCenterClient(target.row) };
    const fan = [0, 0.35, -0.35, 0.75, -0.75, 1.2, -1.2, 1.7, -1.7];
    for (let stepNo = 0; stepNo < 40; stepNo++) {
      const dx = dest.x - at.x, dy = dest.y - at.y;
      const remaining = Math.hypot(dx, dy);
      if (remaining <= 40 * 16) return true;
      const base = Math.atan2(dy, dx), reach = Math.min(48 * 16, remaining);
      let moved = false;
      for (const offset of fan) {
        const trace = icky.traceFineMoveClient(at.x, at.y,
          at.x + Math.cos(base + offset) * reach,
          at.y + Math.sin(base + offset) * reach);
        if (!trace.moved) continue;
        at = { x: trace.x, y: trace.y }; moved = true; break;
      }
      if (!moved) return false;
    }
    return false;
  };
  ok('the Icky Cave staged fine crossing remains navigable',
     fineWalk({ col: 3, row: 18 }, { col: 3, row: 17 }));

  // badland2.roo wall 25 belongs to BSP node 34. Both sides name sector 2,
  // so sector identity cannot choose a sidedef: the node plane must. Its positive
  // side is solid (flags 2), while its negative side is passable (flags 6).
  const kardde = RoomGeometry.fromJSON(map.rooms['49'].roo);
  const karddeWall = kardde.walls?.find(w => w.x0 === 14336 && w.y0 === 8192 &&
    w.x1 === 13312 && w.y1 === 7168 && w.posSector === 2 && w.negSector === 2);
  const karddeSolid = kardde.traceFineMoveClient(14080, 7424, 13568, 7936,
    { slide: false });
  const karddeOpen = kardde.traceFineMoveClient(13568, 7936, 14080, 7424,
    { slide: false });
  ok('the real Kardde same-sector wall follows its asymmetric BSP sidedefs',
     karddeWall?.collisionNode === 34 && !karddeSolid.arrived && karddeOpen.arrived,
     JSON.stringify({ wall: karddeWall, solid: karddeSolid, open: karddeOpen }));

  // marion.roo wall 581 is a real D3D bowtie: sector 72's sloped floor starts
  // below sector 70 and ends above it. These are the exact SetWallHeights values
  // produced by the shipped room, including the intentionally asymmetric splits.
  const marion = RoomGeometry.fromJSON(map.rooms['200'].roo);
  const marionBowtie = marion.walls.find(w => w.x0 === 20480 && w.y0 === 49664 &&
    w.x1 === 19376 && w.y1 === 49664 && w.posSector === 72 && w.negSector === 70);
  ok('the real shipped Marion bowtie has stock D3D wall-height splits',
     marionBowtie?.bowtie === true && marionBowtie.z0 === 2560 &&
     marionBowtie.z1 === 2560 && marionBowtie.zz0 === 3488 && marionBowtie.zz1 === 3526,
     JSON.stringify(marionBowtie));

  const checkedVault = RoomGeometry.fromJSON(map.rooms['114'].roo);
  const checkedParallel = checkedVault.traceFineMoveClient(8688, 5856, 8672, 5856,
    { slide: false });
  const checkedCorner = checkedVault.traceFineMoveClient(5808, 1856, 5744, 1936,
    { slide: false });
  ok('the checked map pins the stock BarVault IntersectNode edge cases',
     !checkedParallel.arrived && !checkedParallel.moved && checkedCorner.arrived,
     JSON.stringify({ checkedParallel, checkedCorner }));

  const checked150 = RoomGeometry.fromJSON(map.rooms['150'].roo)
    .edgeApproachCandidates('west');
  const checked556 = RoomGeometry.fromJSON(map.rooms['556'].roo)
    .edgeApproachCandidates('east');
  const checked599 = RoomGeometry.fromJSON(map.rooms['599'].roo)
    .edgeApproachCandidates('east');
  const checked574 = RoomGeometry.fromJSON(map.rooms['574'].roo)
    .edgeApproachCandidates('north');
  const checked802 = RoomGeometry.fromJSON(map.rooms['802'].roo)
    .edgeApproachCandidates('south');
  const checkedGateDetour = findPath(map, 574, 563);
  ok('checked edge approaches keep Cor Noth and its gate closed where geometry is sealed',
     checked150.length === 0 && checked574.length === 0 && checkedGateDetour.found &&
     checkedGateDetour.hops.map(hop => hop.to).join(',') === '564,563',
     JSON.stringify({ checked150, checked574, checkedGateDetour }));
  ok('checked edge approaches retain Farol and Temple fine-only legal crossings',
     checked556.length === 1 && checked556[0].graph_routable === true &&
     checked802.length > 0 && checked802.every(candidate => candidate.graph_routable),
     JSON.stringify({ checked556, checked802 }));
  ok('checked Ukgoth crossings use the minimum boundary target and stay live-only',
     checked599.length > 0 && checked599.every(candidate =>
       candidate.edge_target.x === 4288 && candidate.graph_routable === false),
     JSON.stringify(checked599.slice(0, 3)));

  const checkedFey = map.rooms['531'];
  const checkedSouth = edgeExitsOf(checkedFey).filter(edge => edge.leave === LEAVE.SOUTH);
  const checkedByDestination = new Map(checkedSouth.map(edge =>
    [edge.to, edgeCandidatesOf(checkedFey, edge)]));
  const checkedHigh = checkedByDestination.get(541) ?? [];
  const checkedLow = checkedByDestination.get(521) ?? [];
  const checkedFallback = checkedByDestination.get(532) ?? [];
  ok('the checked Fey crossing applies the whole ordered conditional edge list',
     checkedHigh.length > 0 && checkedHigh.every(candidate => candidate.col > 50) &&
     checkedLow.length > 0 && checkedLow.every(candidate => candidate.col < 27) &&
     checkedFallback.length > 0 && checkedFallback.every(candidate =>
       candidate.col >= 27 && candidate.col <= 50),
     JSON.stringify({
       high: checkedHigh.map(candidate => candidate.col),
       low: checkedLow.map(candidate => candidate.col),
       fallback: checkedFallback.map(candidate => candidate.col),
     }));
}

console.log('\nraw-client IntersectNode and edge-grounding regressions');
{
  const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
  const rawCache = new Map();
  const rawRoom = roomNum => {
    if (rawCache.has(roomNum)) return rawCache.get(roomNum);
    const room = map.rooms[String(roomNum)];
    const file = room?.rooFile && DEFAULT_ROO_DIRS
      .map(dir => join(dir, room.rooFile)).find(existsSync);
    const geometry = file ? parseRoo(readFileSync(file), room.rooFile) : null;
    rawCache.set(roomNum, geometry);
    return geometry;
  };

  const vault = rawRoom(114);
  if (!vault?.collisionReady) {
    skip('BarVault parallel and endpoint IntersectNode parity', 'barvault.roo is unavailable');
  } else {
    const parallelWall = vault.walls.findIndex(w => w.x0 === 8832 && w.y0 === 6016 &&
      w.x1 === 8320 && w.y1 === 6016);
    const parallel = vault.traceFineMoveClient(8688, 5856, 8672, 5856, { slide: false });
    ok('BarVault parallel equality inside the radius blocks on exact wall 5',
       parallelWall === 4 && !parallel.arrived && !parallel.moved &&
       parallel.wallIndex === parallelWall,
       JSON.stringify({ parallelWall, parallel }));

    const cornerWall = vault.walls.findIndex(w => w.x0 === 5520 && w.y0 === 1872 &&
      w.x1 === 5520 && w.y1 === 1744);
    const corner = vault.traceFineMoveClient(5808, 1856, 5744, 1936, { slide: false });
    ok('BarVault stock endpoint heuristic permits its exact weird corner trace',
       cornerWall === 294 && corner.arrived && corner.x === 5744 && corner.y === 1936,
       JSON.stringify({ cornerWall, corner }));
  }

  const edgeSpecs = [
    [150, 'west'], [556, 'east'], [599, 'east'], [574, 'north'], [802, 'south'],
  ];
  const edgeRooms = Object.fromEntries(edgeSpecs.map(([num]) => [num, rawRoom(num)]));
  if (edgeSpecs.some(([num]) => !edgeRooms[num]?.collisionReady)) {
    for (const label of [
      'Cor Noth room 150 west has no grounded approach',
      'Farol room 556 east retains its fine-only approach',
      'Ukgoth room 599 east uses minimum target x=4288',
      'Cor Noth gate room 574 north has no grounded approach',
      'Temple 802 south has grounded synthetic edge approaches',
    ]) skip(label, 'one or more installed raw room files are unavailable');
  } else {
    const west150 = edgeRooms[150].edgeApproachCandidates('west');
    ok('Cor Noth room 150 west has no grounded approach',
       edgeRooms[150].edgeCrossingRanges('west').length > 0 && west150.length === 0,
       JSON.stringify(west150));

    const east556 = edgeRooms[556].edgeApproachCandidates('east');
    ok('Farol room 556 east retains its fine-only approach',
       east556.length === 1 && east556[0].col === edgeRooms[556].cols &&
       east556[0].stages.every(stage => stage.col < edgeRooms[556].cols),
       JSON.stringify(east556));

    const east599 = edgeRooms[599].edgeApproachCandidates('east');
    ok('Ukgoth room 599 east uses minimum target x=4288',
       east599.length > 0 && east599.every(candidate => candidate.edge_target.x === 4288),
       JSON.stringify(east599.slice(0, 3)));

    const north574 = edgeRooms[574].edgeApproachCandidates('north');
    ok('Cor Noth gate room 574 north has no grounded approach', north574.length === 0,
       JSON.stringify(north574));

    const south802 = edgeRooms[802].edgeApproachCandidates('south');
    const room802 = { ...map.rooms['802'],
      roo: edgeRooms[802].toJSON({ includeSurfaces: false }) };
    const synthetic802 = edgeExitsOf(room802).filter(edge => edge.synthetic);
    ok('Temple 802 south has grounded synthetic edge approaches',
       south802.length > 0 && synthetic802.length === 2 &&
       synthetic802.every(edge => edgeCandidatesOf(room802, edge).length === south802.length),
       JSON.stringify({ physical: south802.length, synthetic: synthetic802.length }));
  }

  const feyGeometry = rawRoom(531);
  if (!feyGeometry?.collisionReady) {
    skip('real room 531 selects conditional edges from the whole ordered list',
      'c1.roo is unavailable');
    skip('World shares one decoded geometry object across sessions', 'c1.roo is unavailable');
    skip('World.exits uses baked approaches without runtime finePathProtocol fanout',
      'c1.roo is unavailable');
  } else {
    const fey = { ...map.rooms['531'], roo: feyGeometry.toJSON({ includeSurfaces: false }) };
    const southEdges = edgeExitsOf(fey).filter(edge => edge.leave === LEAVE.SOUTH);
    const byDestination = new Map(southEdges.map(edge => [edge.to, edgeCandidatesOf(fey, edge)]));
    const high = byDestination.get(541) ?? [];
    const low = byDestination.get(521) ?? [];
    const fallback = byDestination.get(532) ?? [];
    const key = candidate => `${candidate.fine_stand_on.x},${candidate.fine_stand_on.y}`;
    const selected = new Set([...high, ...low, ...fallback].map(key));
    const allSouth = feyGeometry.edgeApproachCandidates('south');
    ok('real room 531 selects conditional edges from the whole ordered list',
       southEdges.length === 3 && southEdges[0].condition?.type === COND.COL_GT &&
       southEdges[1].condition?.type === COND.COL_LT &&
       southEdges[2].condition?.type === COND.NONE &&
       high.length > 0 && high.every(candidate => candidate.col > 50) &&
       low.length > 0 && low.every(candidate => candidate.col < 27) &&
       fallback.length > 0 && fallback.every(candidate => candidate.col >= 27 && candidate.col <= 50) &&
       selected.size === allSouth.length,
       JSON.stringify({ high: high.map(c => c.col), low: low.map(c => c.col),
         fallback: fallback.map(c => c.col), all: allSouth.length }));

    const runtimeMap = { ...map, rooms: { ...map.rooms, '531': fey } };
    const firstStage = allSouth[0].stages[0];
    const makeWorld = () => new World({
      room: { id: fey.objId, objects: new Map() },
      self: { col: firstStage.col, row: firstStage.row,
        x: firstStage.col * KOD_FINENESS + (KOD_FINENESS >> 1),
        y: firstStage.row * KOD_FINENESS + (KOD_FINENESS >> 1) },
    }, runtimeMap);
    const worldA = makeWorld(), worldB = makeWorld();
    ok('World shares one decoded geometry object across sessions',
       worldA.geometry === worldB.geometry && worldA.geometry === sharedRoomGeometry(fey));

    const shared = worldA.geometry;
    const originalFinePath = shared.finePathProtocol;
    let finePathCalls = 0, exits = [], elapsed = Number.POSITIVE_INFINITY;
    shared.finePathProtocol = () => { finePathCalls++; throw new Error('runtime fine-path fanout'); };
    try {
      // The first call also compiles/ranks the room's many ordinary go exits. Measure
      // the steady hot path while still counting both calls for forbidden fine A* use.
      worldA.exits();
      const began = performance.now();
      exits = worldA.exits();
      elapsed = performance.now() - began;
    } finally {
      shared.finePathProtocol = originalFinePath;
    }
    ok('World.exits uses baked approaches without runtime finePathProtocol fanout',
       finePathCalls === 0 && exits.some(exit => exit.kind === 'edge') && elapsed < 1000,
       JSON.stringify({ finePathCalls, exitCount: exits.length, elapsed_ms: elapsed }));
  }
}

// `m59-broker.mjs` cannot be imported: doing so takes the fleet lock and starts
// its supervisors. Lift the real Session methods out by balanced braces instead,
// just as m59-travel-test does. This keeps the packet-boundary regression pinned
// to production control flow rather than a test-only reimplementation.
function sessionMethod(source, signature, name) {
  const start = source.indexOf(`  ${signature}`);
  ok(`the Session.${name} method was located`, start >= 0);
  if (start < 0) return null;
  const opening = source.indexOf(') {', start);
  const body = opening < 0 ? -1 : opening + 2;
  ok(`the Session.${name} body was located`, body > start + 1);
  if (body < 0) return null;
  let depth = 0, end = -1;
  for (let at = body; at < source.length; at++) {
    if (source[at] === '{') depth++;
    else if (source[at] === '}') {
      depth--;
      if (depth === 0) { end = at + 1; break; }
    }
  }
  const method = source.slice(start, end);
  ok(`the complete Session.${name} method was extracted`, end > body && method.trim().endsWith('}'));
  return end > body && method.trim().endsWith('}') ? method : null;
}

function compileSessionMethod(source, signature, name, dependencies = {}) {
  const method = sessionMethod(source, signature, name);
  if (!method) return null;
  try {
    const compiled = new Function(...Object.keys(dependencies),
      `return ({${method}}).${name}`)(...Object.values(dependencies));
    ok(`the extracted Session.${name} method compiled`, typeof compiled === 'function');
    return compiled;
  } catch (error) {
    ok(`the extracted Session.${name} method compiled`, false, error.message);
    return null;
  }
}

const brokerSource = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
const validateFineTarget = compileSessionMethod(brokerSource,
  'validateFineTarget(x, y, {', 'validateFineTarget',
  { CLIENT_FINENESS, KOD_FINENESS, blocksMovement });
// `noteGeometryDrift` is stubbed rather than lifted: this suite is about what the
// collision contract DECIDES, and where the broker files the resulting drift record is
// not that question. The decision itself is asserted below, off `validateFineTarget`,
// which stays pure precisely so it can be.
const driftRecorded = [];
const queueValidatedMove = compileSessionMethod(brokerSource,
  'async queueValidatedMove(x, y, {', 'queueValidatedMove',
  { MOVE_INTERVAL_MS: 0, CLIENT_FINENESS,
    noteGeometryDrift: (session, drift) => driftRecorded.push(drift) });
const confirmPosition = compileSessionMethod(brokerSource,
  'async confirmPosition() {', 'confirmPosition', { Pacer: { note() {} } });
const stepFine = compileSessionMethod(brokerSource,
  'async stepFine(x, y) {', 'stepFine', { MOVE_INTERVAL_MS: 0, Pacer: { note() {} } });
const ordinaryStep = compileSessionMethod(brokerSource,
  'async step(col, row, {', 'step', {
    MOVE_INTERVAL_MS: 0, ROOM_RESYNC_MS: Number.POSITIVE_INFINITY,
    KOD_FINENESS, squaresPerSecond: () => 2.5,
  });
const walkFine = compileSessionMethod(brokerSource,
  'async walkFine(destX, destY, {', 'walkFine', { isTerminalMovementReason });
const walkTo = compileSessionMethod(brokerSource,
  'async walkTo(col, row, {', 'walkTo', {
    isTerminalMovementReason, KOD_FINENESS, MOVE_HOP_MAX_SQUARES: 8,
  });
const leaveVia = compileSessionMethod(brokerSource,
  'async leaveVia(exit, {', 'leaveVia', {
    isTerminalMovementReason, KOD_FINENESS, MOVE_INTERVAL_MS: 0,
    Pacer: { note() {} }, forgetInferredExit() {},
  });
const leaveViaAny = compileSessionMethod(brokerSource,
  'async leaveViaAny(candidates, {', 'leaveViaAny', {
    isTerminalMovementReason, spreadEdges, orderExits: exits => exits,
  });

function fakeBrokerSession(geometry, {
  x = clientToWire(1024), y = clientToWire(2048),
  roomId = 1, roomSecurity = geometry?.security ?? TEST_SECURITY,
  objects = [], beforePaced = null,
} = {}) {
  const packets = [], turns = [];
  const selfId = 99;
  const self = { x, y, col: Math.floor(x / KOD_FINENESS), row: Math.floor(y / KOD_FINENESS) };
  const roomObjects = new Map([[selfId, self], ...objects.map(object => [object.id, object])]);
  const client = {
    selfId,
    self,
    evSeq: 0,
    roomContentsRequested: 0,
    roomContentsReceived: 0,
    room: { id: roomId, security: roomSecurity, flags: 0,
      overrideDepths: [0, 0, 0, 0], collisionInvalidated: null, objects: roomObjects },
    moveTo(nextX, nextY, speed, packetRoom) {
      packets.push({ x: nextX, y: nextY, speed, room: packetRoom });
      this.self = {
        ...this.self,
        x: nextX, y: nextY,
        col: Math.floor(nextX / KOD_FINENESS), row: Math.floor(nextY / KOD_FINENESS),
      };
      this.room.objects.set(selfId, this.self);
    },
    face(degrees) { turns.push(degrees); },
    predictSelf(next) {
      this.self = { ...this.self, ...next, predicted: true };
      this.room.objects.set(selfId, this.self);
    },
    roomContents() {
      const request = ++this.roomContentsRequested;
      this.roomContentsReceived = request;
      return request;
    },
    async waitFor() { return { timedOut: false, seq: ++this.evSeq }; },
  };
  const session = {
    client,
    world: { geometry },
    finePositionUnknown: false,
    collisionVertical: null,
    lastRoomRead: Date.now(),
    pacer: { async submit(kind, invoke) {
      if (typeof beforePaced === 'function') await beforePaced(kind, client);
      return invoke();
    } },
    need() { return this.client; },
    moveSpeed() { return 18; },
    validateFineTarget,
    queueValidatedMove,
    confirmPosition,
  };
  return { session, client, packets, turns };
}

console.log('\nclient protocol bounds and live geometry invalidation');
{
  const packetClient = Object.create(M59Client.prototype);
  packetClient.room = { id: 1 };
  let sent = 0;
  packetClient.send = () => { sent++; };
  const rejected = [[-1, 0], [0, -1], [0x10000, 0], [0, 0x10000]]
    .map(([x, y]) => {
      try { packetClient.moveTo(x, y); return false; }
      catch (error) { return error instanceof RangeError; }
    });
  ok('M59Client.moveTo rejects negative and overflowing unsigned-16 targets without a packet',
     rejected.every(Boolean) && sent === 0, JSON.stringify({ rejected, sent }));

  const newClient = () => new M59Client({ verbose: false, resources: new Map() });
  const cosmetic = newClient();
  cosmetic.onGameMessage(BP.SECTOR_ANIMATE, Buffer.alloc(0));
  const normalTexture = Buffer.alloc(5);
  normalTexture.writeUInt8(0x02, 4);
  cosmetic.onGameMessage(BP.CHANGE_TEXTURE, normalTexture);
  ok('cosmetic sector animation and normal-wall texture changes keep collision valid',
     cosmetic.room.collisionInvalidated === null,
     JSON.stringify(cosmetic.room.collisionInvalidated));

  const movingSector = newClient();
  movingSector.onGameMessage(BP.SECTOR_MOVE, Buffer.alloc(0));
  const movingWall = newClient();
  movingWall.onGameMessage(BP.WALL_ANIMATE, Buffer.alloc(0));
  const lowerTexture = newClient();
  const lowerBody = Buffer.alloc(5);
  lowerBody.writeUInt8(0x04, 4);
  lowerTexture.onGameMessage(BP.CHANGE_TEXTURE, lowerBody);
  ok('moving geometry and above/below texture changes invalidate live collision',
     movingSector.room.collisionInvalidated?.opcode === BP.SECTOR_MOVE &&
     movingWall.room.collisionInvalidated?.opcode === BP.WALL_ANIMATE &&
     lowerTexture.room.collisionInvalidated?.opcode === BP.CHANGE_TEXTURE &&
     lowerTexture.room.collisionInvalidated?.flags === 0x04,
     JSON.stringify({ sector: movingSector.room.collisionInvalidated,
       wall: movingWall.room.collisionInvalidated,
       texture: lowerTexture.room.collisionInvalidated }));
}

console.log('\nterminal movement propagation and edge packet authority');
{
  let fineFallbacks = 0, goFallbacks = 0;
  const boundedTerminal = await boundedRegionEntry({
    candidates: [{ stand_on: { col: 2, row: 2 } }],
    sequence: () => 0,
    eventsSince: () => [],
    walk: async () => ({ arrived: false, reason: 'collision_geometry_changed' }),
    fineWalk: async () => { fineFallbacks++; return { arrived: true }; },
    waitForEntry: async () => null,
    askGo: async () => { goFallbacks++; },
  });
  ok('bounded region entry propagates terminal collision state without fine/go fallback',
     boundedTerminal.terminal?.reason === 'collision_geometry_changed' &&
     fineFallbacks === 0 && goFallbacks === 0,
     JSON.stringify({ boundedTerminal, fineFallbacks, goFallbacks }));

  if (typeof walkTo !== 'function') {
    skip('walkTo propagates a terminal step without replanning', 'Session.walkTo did not extract');
    skip('walkTo reports unknown own position as a terminal contract reason',
      'Session.walkTo did not extract');
    skip('walkTo reports a permanently floorless start as terminal',
      'Session.walkTo did not extract');
  } else {
    let stepCalls = 0;
    const client = { self: { col: 1, row: 1, x: 96, y: 96 } };
    const geometry = {
      walkable: () => true,
      path: () => ({ found: true, steps: [{ col: 2, row: 1 }] }),
    };
    const session = {
      client, world: { geometry }, movementGeneration: 0,
      need() { return this.client; },
      movementWasCancelled() { return false; },
      threatsHere() { return []; },
      async step() {
        stepCalls++;
        return { moved: false, left_room: false, reason: 'room_geometry_mismatch' };
      },
    };
    const result = await walkTo.call(session, 2, 1, { maxSteps: 5, hardCap: 10 });
    ok('walkTo propagates a terminal step without replanning',
       result.reason === 'room_geometry_mismatch' && stepCalls === 1 && result.replans === 0,
       JSON.stringify({ result, stepCalls }));

    let pathCalls = 0;
    const unknown = {
      client: { self: null }, world: { geometry: { path() { pathCalls++; } } },
      need() { return this.client; },
    };
    const unknownResult = await walkTo.call(unknown, 2, 1, { maxSteps: 5, hardCap: 10 });
    ok('walkTo reports unknown own position as a terminal contract reason',
       unknownResult.reason === 'own_position_unknown' &&
       isTerminalMovementReason(unknownResult.reason) && pathCalls === 0,
       JSON.stringify({ unknownResult, pathCalls }));

    const floorless = {
      client: { self: { col: 9, row: 9 } }, movementGeneration: 0,
      world: { geometry: { walkable: () => false, nearestWalkable: () => null } },
      need() { return this.client; }, movementWasCancelled() { return false; },
    };
    const floorlessResult = await walkTo.call(floorless, 2, 1, { maxSteps: 5, hardCap: 10 });
    ok('walkTo reports a permanently floorless start as terminal',
       floorlessResult.reason === 'start_has_no_floor' &&
       isTerminalMovementReason(floorlessResult.reason), JSON.stringify(floorlessResult));
  }

  if (typeof leaveVia !== 'function') {
    skip('leaveVia propagates terminal approach and emits no edge packet',
      'Session.leaveVia did not extract');
    skip('the outward StandardLeaveDir packet uses stock speed zero',
      'Session.leaveVia did not extract');
    skip('a doorway position-confirmation timeout sends no correction or go',
      'Session.leaveVia did not extract');
  } else {
    const client = {
      room: { id: 1 }, self: { col: 2, row: 2, x: 160, y: 160 },
      roomNameRsc: 1, rsc: { get: () => 'next room' },
      async waitFor() { return { events: [{ kind: 'room-entered', roomName: 'next room' }] }; },
    };
    let edgePackets = 0;
    const terminalSession = {
      client, movementGeneration: 0,
      need() { return this.client; },
      movementWasCancelled() { return false; },
      async walkTo() { return { arrived: false, reason: 'room_security_unknown' }; },
      async walkFine() { throw new Error('terminal movement must not fall through'); },
      async queueValidatedMove() { edgePackets++; return { sent: true }; },
      world: { exits: () => [] },
    };
    const exit = {
      kind: 'edge', direction: 'east', to: 2,
      stand_on: { col: 2, row: 2 }, fine_stand_on: { x: 160, y: 160 },
      edge_target: { x: 192, y: 160 }, fine_path: [{ x: 160, y: 160 }],
    };
    const terminal = await leaveVia.call(terminalSession, exit, {});
    ok('leaveVia propagates terminal approach and emits no edge packet',
       terminal.reason === 'room_security_unknown' && terminal.stage === 'walk' &&
       edgePackets === 0, JSON.stringify({ terminal, edgePackets }));

    let edgeOptions = null;
    const successSession = {
      ...terminalSession,
      async walkTo() { return { arrived: true }; },
      async walkFine() { return { arrived: true }; },
      async queueValidatedMove(_x, _y, options) {
        edgeOptions = options;
        return { sent: true, eventSeq: 10 };
      },
    };
    const left = await leaveVia.call(successSession, exit, {});
    ok('the outward StandardLeaveDir packet uses stock speed zero',
       left.left === true && edgeOptions?.speed === 0 && edgeOptions?.slide === false &&
       edgeOptions?.expectedRoomId === 1,
       JSON.stringify({ left, edgeOptions }));

    let fineCorrections = 0, goPackets = 0;
    const unknownDoorSession = {
      client: { room: { id: 1 }, self: { col: 4, row: 4 } },
      movementGeneration: 0, finePositionUnknown: false,
      need() { return this.client; },
      movementWasCancelled() { return false; },
      async walkTo() { return { arrived: true }; },
      async confirmPosition() { return null; },
      async stepFine() { fineCorrections++; return { moved: true }; },
      async standBeforeGo() {},
      pacer: { async submit() { goPackets++; } },
    };
    const unknownDoor = await leaveVia.call(unknownDoorSession, {
      kind: 'go', stand_on: { col: 4, row: 4 }, steps_away: 0,
    }, {});
    ok('a doorway position-confirmation timeout sends no correction or go',
       unknownDoor.reason === 'position_confirmation_timeout' &&
       isTerminalMovementReason(unknownDoor.reason) &&
       unknownDoorSession.finePositionUnknown === true &&
       fineCorrections === 0 && goPackets === 0,
       JSON.stringify({ unknownDoor, fineCorrections, goPackets }));
  }

  if (typeof leaveViaAny !== 'function') {
    skip('leaveViaAny stops after the first terminal candidate',
      'Session.leaveViaAny did not extract');
  } else {
    let attempts = 0;
    const session = {
      movementGeneration: 0,
      movementWasCancelled() { return false; },
      async leaveVia() {
        attempts++;
        return { left: false, reason: 'collision_geometry_unavailable' };
      },
    };
    const result = await leaveViaAny.call(session,
      [{ kind: 'edge', stand_on: { col: 1, row: 1 } },
       { kind: 'edge', stand_on: { col: 2, row: 2 } }], {});
    ok('leaveViaAny stops after the first terminal candidate',
       result.reason === 'collision_geometry_unavailable' && attempts === 1,
       JSON.stringify({ result, attempts }));
  }
}

console.log('\nreal broker seam validates before emitting coordinates');
if (![validateFineTarget, queueValidatedMove, confirmPosition, stepFine, ordinaryStep, walkFine]
    .every(method => typeof method === 'function')) {
  skip('real broker seam movement regressions', 'one or more production methods did not extract');
} else {
  const unavailable = fakeBrokerSession(null);
  const refused = await stepFine.call(unavailable.session, clientToWire(3072), clientToWire(2048));
  ok('missing collision metadata reports collision_geometry_unavailable',
     refused.reason === 'collision_geometry_unavailable', JSON.stringify(refused));
  ok('missing collision metadata emits zero move packets', unavailable.packets.length === 0,
     JSON.stringify(unavailable.packets));

  const wireCalls = [];
  const wireProbe = {
    security: TEST_SECURITY,
    traceFineMoveClient(x0, y0, x1, y1) {
      wireCalls.push({ x0, y0, x1, y1 });
      return { available: true, x: x1, y: y1, moved: x0 !== x1 || y0 !== y1,
               arrived: true, blocked: false, slid: false, reason: null };
    },
  };
  const origin = fakeBrokerSession(wireProbe, { x: 64, y: 64 });
  const oneUnit = validateFineTarget.call(origin.session, 65, 64);
  ok('wire coordinate 64 maps to client coordinate zero in both axes',
     wireCalls.length === 2 && wireCalls.every(call => call.x0 === 0 && call.y0 === 0) &&
     wireCalls[0].x1 === CLIENT_PER_KOD && wireCalls[0].y1 === 0 &&
     oneUnit.target?.x === 65 && oneUnit.target?.y === 64,
     JSON.stringify({ wireCalls, oneUnit }));

  // A LIVE ANIMATION BLOCKS, AND THE BLOCK EXPIRES. Both halves matter and only the
  // first was ever true: the flag is cleared by BP_PLAYER, which arrives on a ROOM
  // CHANGE, and changing rooms needs the very movement this refuses — so without an
  // expiry any animating room is a cage. Three characters were caught in one on prod
  // within ten minutes, all reporting "could not reach the bank".
  const animating = fakeBrokerSession(twoSides());
  const setAnimation = (record) => { animating.session.client.room.collisionInvalidated = record; };
  const tryMove = () => validateFineTarget.call(animating.session,
    clientToWire(3072), clientToWire(2048));

  setAnimation({ kind: 'BP_SECTOR_MOVE', at: Date.now(), until: Date.now() + 10_000 });
  ok('a live room animation fails movement closed while it is in flight',
     tryMove().reason === 'collision_geometry_changed');
  setAnimation({ kind: 'BP_SECTOR_MOVE', at: Date.now() - 60_000, until: Date.now() - 30_000 });
  ok('and once the animation has finished, movement is allowed again rather than caged',
     tryMove().reason !== 'collision_geometry_changed');
  // "We do not know when this ends" is not "it has ended".
  setAnimation({ kind: 'BP_SECTOR_MOVE', at: Date.now() });
  ok('a record with no expiry still blocks, because unknown is not finished',
     tryMove().reason === 'collision_geometry_changed');
  setAnimation(null);

  const mismatch = fakeBrokerSession(twoSides(), { roomSecurity: TEST_SECURITY ^ 1 });
  const mismatched = await queueValidatedMove.call(mismatch.session,
    clientToWire(3072), clientToWire(2048));
  ok('a room security mismatch fails closed before the movement queue',
     !mismatched.sent && mismatched.validation?.reason === 'room_geometry_mismatch' &&
     mismatch.packets.length === 0, JSON.stringify(mismatched));
  // THE BAKED MAP IS EVIDENCE ABOUT SOMEBODY ELSE'S SERVER, AND THAT SERVER CAN BE
  // PATCHED WITHOUT TELLING US. So a mismatch has to carry BOTH values out to the caller
  // — refusing the move says a character did not walk; naming the two security values is
  // what says the world changed, which is the half anyone can act on.
  ok('and it carries the evidence out: the room, and both security values',
     mismatched.validation?.drift?.room != null &&
     Number.isInteger(mismatched.validation.drift.live) &&
     Number.isInteger(mismatched.validation.drift.baked) &&
     mismatched.validation.drift.live !== mismatched.validation.drift.baked,
     JSON.stringify(mismatched.validation?.drift));
  ok('and the broker is handed that record rather than having to infer it',
     driftRecorded.length === 1 && driftRecorded[0].live !== driftRecorded[0].baked);

  for (const [label, geometry] of [
    ['solid wall', twoSides()],
    ['cliff', twoSides({
      right: sector({ floor: MAX_STEP_HEIGHT + 1 }),
      pos: side({ passable: true }), neg: side({ passable: true }),
    })],
  ]) {
    const blocked = fakeBrokerSession(geometry);
    const result = await stepFine.call(blocked.session, clientToWire(3072), clientToWire(2048));
    const emitted = blocked.packets[0];
    const emittedTrace = emitted && geometry.traceFineMoveClient(
      1024, 2048, wireToClient(emitted.x), wireToClient(emitted.y), { slide: false });
    ok(`${label} target never emits an endpoint across the barrier`,
       blocked.packets.length <= 1 && (!emitted ||
         (wireToClient(emitted.x) <= 2048 - PLAYER_RADIUS && emittedTrace.arrived)),
       JSON.stringify({ result, packets: blocked.packets, emittedTrace }));
  }

  const lowStep = fakeBrokerSession(twoSides({
    right: sector({ floor: 20 * 16 }),
    pos: side({ passable: true }), neg: side({ passable: true }),
  }));
  const crossed = await stepFine.call(lowStep.session, clientToWire(3072), clientToWire(2048));
  ok('a legal low-step target emits the locally validated endpoint',
     crossed.locally_validated === true && crossed.moved === true &&
     lowStep.packets.length === 1 && lowStep.packets[0].x === clientToWire(3072) &&
     lowStep.packets[0].y === clientToWire(2048),
     JSON.stringify({ crossed, packets: lowStep.packets }));

  const open = twoSides({ pos: side({ passable: true }), neg: side({ passable: true }) });
  const invalidProtocol = [];
  for (const [x, y] of [[-1, 128], [128, -1], [0x10000, 128], [128, 0x10000]]) {
    const invalid = fakeBrokerSession(open);
    const result = await stepFine.call(invalid.session, x, y);
    invalidProtocol.push({ x, y, reason: result.reason, packets: invalid.packets.length });
  }
  ok('negative and overflowing broker targets emit no movement packet',
     invalidProtocol.every(item => item.reason === 'invalid_move_target' && item.packets === 0),
     JSON.stringify(invalidProtocol));

  const invalidated = fakeBrokerSession(open);
  invalidated.client.room.collisionInvalidated = {
    opcode: BP.SECTOR_MOVE, kind: 'SECTOR_MOVE', at: Date.now(),
  };
  const geometryChanged = await stepFine.call(invalidated.session,
    clientToWire(3072), clientToWire(2048));
  ok('collision_geometry_changed fails closed before emitting a move',
     geometryChanged.reason === 'collision_geometry_changed' &&
     invalidated.packets.length === 0,
     JSON.stringify({ geometryChanged, packets: invalidated.packets }));

  let fatalFineCalls = 0;
  const fatalClient = {
    room: { id: 1 },
    self: { x: 128, y: 128, col: 2, row: 2 },
  };
  const fatalSession = {
    client: fatalClient,
    movementGeneration: 0,
    need() { return this.client; },
    movementWasCancelled() { return false; },
    async stepFine() {
      fatalFineCalls++;
      return { moved: false, left_room: false, reason: 'collision_geometry_changed',
               note: 'live wall animation' };
    },
  };
  const fatalWalk = await walkFine.call(fatalSession, 256, 128,
    { maxSteps: 10, stride: 48, arriveWithin: 1 });
  ok('collision_geometry_changed is fatal to walkFine without fanning more headings',
     fatalWalk.reason === 'collision_geometry_changed' && fatalFineCalls === 1,
     JSON.stringify({ fatalWalk, fatalFineCalls }));

  const blocker = {
    id: 7, x: clientToWire(2048), y: clientToWire(2048), flags: MOVEON.NO,
  };
  const occupied = fakeBrokerSession(open, { objects: [blocker] });
  const objectBlocked = validateFineTarget.call(occupied.session,
    clientToWire(3072), clientToWire(2048), { slide: true });
  blocker.flags = MOVEON.YES;
  const objectGone = validateFineTarget.call(occupied.session,
    clientToWire(3072), clientToWire(2048), { slide: true });
  ok('a live OF_MOVEON_NO object blocks movement until its current flags permit it',
     objectBlocked.blocked && objectBlocked.reason === 'object_blocked' &&
     wireToClient(objectBlocked.target?.x) < 2048 && objectGone.arrived &&
     objectGone.target?.x === clientToWire(3072),
     JSON.stringify({ objectBlocked, objectGone }));

  // The requested point is 248.5 client units from the wall endpoint, just outside
  // the player cylinder. Naive nearest-integer KOD rounding moves it six client
  // units toward the endpoint and puts it inside; production quantizes toward the
  // start and revalidates the exact wire endpoint before queuing it.
  const corner = twoSides({ wallY0: 1907, wallY1: 2207 });
  const start = { x: clientToWire(2032), y: clientToWire(1648) };
  const barelyClearY = clientToWire(1658.5);
  const raw = corner.traceFineMoveClient(wireToClient(start.x), wireToClient(start.y),
    2048, wireToClient(barelyClearY), { slide: true });
  const rounded = corner.traceFineMoveClient(wireToClient(start.x), wireToClient(start.y),
    2048, wireToClient(Math.round(barelyClearY)), { slide: false });
  ok('the quantization fixture is clear before rounding and blocked after it',
     raw.arrived && !rounded.arrived, JSON.stringify({ raw, rounded }));
  const quantized = fakeBrokerSession(corner, start);
  const quantizedResult = await stepFine.call(quantized.session, clientToWire(2048), barelyClearY);
  const allPacketsSafe = quantized.packets.every(packet => corner.traceFineMoveClient(
    wireToClient(start.x), wireToClient(start.y),
    wireToClient(packet.x), wireToClient(packet.y),
    { slide: false }).arrived);
  ok('quantization cannot emit a barely-clear point rounded into collision',
     quantizedResult.locally_validated === true && allPacketsSafe,
     JSON.stringify({ quantizedResult, packets: quantized.packets }));

  const floorCalls = [];
  const floorEdge = 100.1;
  const floorEdgeGeometry = {
    security: TEST_SECURITY,
    traceFineMoveClient(x0, y0, x1, y1) {
      floorCalls.push({ x0, y0, x1, y1 });
      if (x1 <= floorEdge) return {
        available: true, x: x1, y: y1, moved: x0 !== x1 || y0 !== y1,
        arrived: true, blocked: false, slid: false, reason: null,
      };
      return { available: true, x: floorEdge, y: y1, moved: true,
               arrived: false, blocked: true, slid: false,
               reason: 'destination_has_no_floor' };
    },
  };
  const edge = fakeBrokerSession(floorEdgeGeometry, { x: 64, y: 64 });
  const edgeResult = validateFineTarget.call(edge.session, 72, 64, { slide: true });
  ok('the exact final quantized endpoint is revalidated inside a floor edge',
     edgeResult.target?.x === 70 && edgeResult.target?.y === 64 &&
     floorCalls.some(call => call.x1 === wireToClient(70) && call.y1 === 0) &&
     floorCalls.at(-1).x1 === wireToClient(edgeResult.target.x),
     JSON.stringify({ edgeResult, floorCalls }));

  const verticalGeometry = threeStrips({
    left: sector({ floor: 1000 }), middle: sector({ floor: 0 }),
    right: sector({ floor: 0, ceiling: 1500 }),
    secondPos: side({ passable: true, above: true }),
    secondNeg: side({ passable: true, above: true }),
  });
  const vertical = fakeBrokerSession(verticalGeometry, {
    x: clientToWire(608), y: clientToWire(2048),
  });
  const verticalResult = await stepFine.call(vertical.session,
    clientToWire(3392), clientToWire(2048));
  ok('the broker packet keeps downhill motion Z and emits no endpoint through the low overhang',
     vertical.packets.length === 1 &&
     wireToClient(vertical.packets[0].x) <= 2600 - PLAYER_RADIUS &&
     vertical.session.collisionVertical?.min === 0 &&
     vertical.session.collisionVertical?.max === 1000,
     JSON.stringify({ verticalResult, packets: vertical.packets,
       collisionVertical: vertical.session.collisionVertical }));

  const carriedCalls = [];
  const carriedGeometry = {
    security: TEST_SECURITY,
    traceFineMoveClient(x0, y0, x1, y1, options = {}) {
      const destinationFloor = x1 < 1000 ? 0 : x1 < 3000 ? 1400 : 500;
      const incoming = Number.isFinite(options.motionZ?.min)
        ? options.motionZ : { min: 1000, max: 1000 };
      const motionZ = {
        min: Math.min(incoming.min, incoming.max, destinationFloor),
        max: Math.max(incoming.min, incoming.max, destinationFloor),
      };
      carriedCalls.push({ x1, incoming: options.motionZ ?? null, destinationFloor, motionZ });
      return { available: true, x: x1, y: y1, moved: x0 !== x1 || y0 !== y1,
               arrived: true, blocked: false, slid: false, reason: null,
               motionZ, destinationFloor };
    },
  };
  const carried = fakeBrokerSession(carriedGeometry);
  await queueValidatedMove.call(carried.session, 100, 128);
  const firstSettle = { ...carried.session.collisionVertical };
  await queueValidatedMove.call(carried.session, 200, 128);
  const crestSettle = { ...carried.session.collisionVertical };
  await queueValidatedMove.call(carried.session, 300, 128);
  const repeatedSettle = { ...carried.session.collisionVertical };
  const crestInputs = carriedCalls.filter(call => call.destinationFloor === 1400)
    .map(call => call.incoming);
  const repeatInputs = carriedCalls.filter(call => call.destinationFloor === 500)
    .map(call => call.incoming);
  ok('repeated packets carry the vertical range over a crest without shrinking/resetting settle',
     carried.packets.length === 3 && firstSettle.min === 0 && firstSettle.max === 1000 &&
     crestInputs.every(input => input?.min === 0 && input?.max === 1000) &&
     crestSettle.min === 0 && crestSettle.max === 1400 &&
     repeatInputs.every(input => input?.min === 0 && input?.max === 1400) &&
     repeatedSettle.min === 0 && repeatedSettle.max === 1400 &&
     repeatedSettle.settleAt >= crestSettle.settleAt && crestSettle.settleAt >= firstSettle.settleAt,
     JSON.stringify({ firstSettle, crestSettle, repeatedSettle, carriedCalls }));

  const changed = fakeBrokerSession(open, {
    beforePaced(kind, client) { if (kind === 'move') client.room.id = 2; },
  });
  const changedResult = await queueValidatedMove.call(changed.session,
    clientToWire(3072), clientToWire(2048));
  ok('a queued move is discarded when the room changes before send',
     !changedResult.sent && changedResult.validation?.reason === 'room_changed_before_move' &&
     changed.packets.length === 0, JSON.stringify(changedResult));

  const changedDuringTurn = fakeBrokerSession(open, {
    beforePaced(kind, client) { if (kind === 'turn') client.room.id = 2; },
  });
  const changedDuringTurnResult = await ordinaryStep.call(changedDuringTurn.session, 3, 3);
  ok('Session.step sends no move when the room changes during its paced turn',
     changedDuringTurnResult.reason === 'room_changed_before_move' &&
     changedDuringTurnResult.left_room === true && changedDuringTurn.packets.length === 0,
     JSON.stringify({ changedDuringTurnResult, packets: changedDuringTurn.packets }));

  const stale = fakeBrokerSession(open);
  stale.client.roomContentsRequested = 1;
  stale.client.roomContentsReceived = 0;
  stale.client.roomContents = function roomContents() { return ++this.roomContentsRequested; };
  let waits = 0;
  stale.client.waitFor = async function waitFor() {
    waits++;
    if (waits === 1) {
      this.roomContentsReceived = 1; // reply to the older fire-and-forget request
      return { timedOut: false, seq: 10 };
    }
    return { timedOut: true, seq: 11 };
  };
  const staleConfirmation = await confirmPosition.call(stale.session);
  ok('an older room-contents ordinal cannot satisfy position confirmation',
     staleConfirmation === null && waits === 2 && stale.client.roomContentsReceived === 1,
     JSON.stringify({ staleConfirmation, waits,
       requested: stale.client.roomContentsRequested,
       received: stale.client.roomContentsReceived }));

  const ordinary = fakeBrokerSession(null, {
    x: 2 * KOD_FINENESS + (KOD_FINENESS >> 1),
    y: 2 * KOD_FINENESS + (KOD_FINENESS >> 1),
  });
  const ordinaryResult = await ordinaryStep.call(ordinary.session, 3, 2);
  ok('ordinary Session.step uses the same fail-closed validated movement guard',
     ordinaryResult.reason === 'collision_geometry_unavailable' &&
     ordinary.packets.length === 0,
     JSON.stringify({ ordinaryResult, packets: ordinary.packets }));
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exitCode = fail ? 1 : 0;
