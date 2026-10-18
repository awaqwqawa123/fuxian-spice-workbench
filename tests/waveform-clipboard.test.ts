import assert from 'node:assert/strict'
import test from 'node:test'
import {pasteWaveformGroup} from '../src/core/waveform-clipboard'
import type {CanvasWaveform} from '../src/core/canvas-waveform-store'
const frame=(id:string,x:number,y:number):CanvasWaveform=>({id,x,y,width:640,height:330,title:id,profileId:'p'})
test('group paste preserves relative geometry, separate IDs and repeated paste offsets',()=>{
 const source=[frame('a',100,200),frame('b',140,240)],before=structuredClone(source)
 const first=pasteWaveformGroup(source,source),second=pasteWaveformGroup(source,[...source,...first])
 for(const group of [first,second]){assert.equal(group[1].x-group[0].x,40);assert.equal(group[1].y-group[0].y,40);assert.equal(new Set(group.map(f=>f.id)).size,2);assert.ok(group.every(f=>!source.some(s=>s.id===f.id)))}
 assert.notEqual(first[0].x,second[0].x);assert.deepEqual(source,before)
})
test('group paste translates inward together at the sheet boundary',()=>{
 const source=[frame('a',19360,100),frame('b',18600,200)]
 const group=pasteWaveformGroup(source,source)
 assert.notDeepEqual([group[0].x,group[0].y],[source[0].x,source[0].y]);assert.equal(group[1].x-group[0].x,source[1].x-source[0].x)
 assert.ok(group.every(f=>f.x>=-20000&&f.x+f.width<=20000))
})
