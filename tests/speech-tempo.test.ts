import test from 'node:test';
import assert from 'node:assert/strict';
import {speechTempo} from '../src/server/speech-tempo';

test('speech tempo changes duration while preserving vocal pitch',()=>{
 const rate=24000, hz=300;
 const input=Float32Array.from({length:rate*2},(_,i)=>.3*Math.sin(2*Math.PI*hz*i/rate));
 for(const speed of [.7,.85,1.2,1.4]) {
  const audio=speechTempo(input,rate,speed);
  assert.equal(audio.length,Math.round(input.length/speed));
  assert.ok(audio.every(Number.isFinite));
  let crossings=0;const first=Math.round(rate*.1),last=audio.length-Math.round(rate*.1);
  for(let i=first+1;i<last;i++)if(audio[i-1]<=0&&audio[i]>0)crossings++;
  const measured=crossings/((last-first)/rate);
  assert.ok(Math.abs(measured-hz)<3,`speed ${speed} changed pitch to ${measured} Hz`);
 }
});

test('speech tempo preserves identity at normal speed and rejects invalid controls',()=>{
 const audio=new Float32Array([0,.1,-.1]);
 assert.equal(speechTempo(audio,24000,1),audio);
 assert.equal(speechTempo(new Float32Array(),24000,.85).length,0);
 for(const speed of [0,NaN,Infinity,2])assert.throws(()=>speechTempo(audio,24000,speed));
});
