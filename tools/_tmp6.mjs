import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('substrate/m59-map.json','utf8'));
const rooms = Array.isArray(d.rooms)?d.rooms:Object.values(d.rooms);
const bk = rooms.find(x=>x.num===557).roo;
const m = Buffer.from(bk.monsterGrid,'base64'), g = Buffer.from(bk.grid,'base64'), f = Buffer.from(bk.flags,'base64');
const C = bk.cols;
const idx=(c,r)=>(r-1)*C+(c-1);
// MASK_* from blakserv/roomdata.h -- the directional bits CanMoveInRoomFine tests.
const MASKS = { NORTH:0x01, NORTH_EAST:0x02, EAST:0x04, SOUTH_EAST:0x08, SOUTH:0x10, SOUTH_WEST:0x20, WEST:0x40, NORTH_WEST:0x80 };
const sq = [27,39];   // 1-based (26,38) 0-based -- the square he stands in
const mv = m[idx(...sq)], gv = g[idx(...sq)], fv = f[idx(...sq)];
console.log(`square (26,38): flags=${fv} (walkable=${!!(fv&1)})  grid=${gv}  monsterGrid=${mv}`);
console.log('  monster may step: ' + Object.entries(MASKS).filter(([,b])=>mv&b).map(([k])=>k).join(' '));
console.log('  monster blocked  : ' + Object.entries(MASKS).filter(([,b])=>!(mv&b)).map(([k])=>k).join(' '));
console.log();
console.log('  => the monster grid gates DIRECTIONS out of a square, and it permits some');
console.log('     directions into a square the player grid also permits. Both allow standing here.');
