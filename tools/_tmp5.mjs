import { parseRoo, RoomGeometry, protocolToClient } from './m59-roo.mjs';
import { readFileSync } from 'node:fs';
const buf = readFileSync('/Users/costas/Documents/Projects/Meridian59/resource/rooms/e7.roo');
const fresh = new RoomGeometry(parseRoo(buf));
const d = JSON.parse(readFileSync('substrate/m59-map.json','utf8'));
const rooms = Array.isArray(d.rooms)?d.rooms:Object.values(d.rooms);
const bk = rooms.find(x=>x.num===557).roo;
console.log('baked collision keys:', Object.keys(bk.collision ?? {}).join(', ').slice(0,160));
const baked = RoomGeometry.fromJSON(bk);
// Ask both the SAME question at the same points: is there floor?
let agree=0, freshOnly=0, bakedOnly=0, bothNo=0;
for (let row=1; row<=fresh.rows; row++) for (let col=1; col<=fresh.cols; col++) {
  const x=protocolToClient((col-1)*64+32), y=protocolToClient((row-1)*64+32);
  const f = !!fresh._occupiable?.(x,y), b = !!baked._occupiable?.(x,y);
  if (f&&b) agree++; else if (f&&!b) freshOnly++; else if (!f&&b) bakedOnly++; else bothNo++;
}
console.log(`floor at square centres, FRESH PARSE vs BAKED:`);
console.log(`  both floor ${agree}   fresh-only ${freshOnly}   baked-only ${bakedOnly}   neither ${bothNo}`);
