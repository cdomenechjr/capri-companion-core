import test from 'node:test';
import assert from 'node:assert/strict';
import { companionBounds } from '../src/desktop/companion-bounds';
test('small call anchors to the actual work area and scaling stays on screen',()=>{
 for(const area of [{x:1920,y:30,width:1280,height:690},{x:-1280,y:-720,width:1280,height:690}]){
  const initial=companionBounds(area,1);assert.equal(initial.x,area.x+area.width-initial.width-20);assert.equal(initial.y,area.y+24);
  const scaled=companionBounds(area,2,{x:9999,y:9999,width:330,height:510});
  assert.ok(scaled.x>=area.x&&scaled.y>=area.y);assert.ok(scaled.x+scaled.width<=area.x+area.width);assert.ok(scaled.y+scaled.height<=area.y+area.height);
 }
});
