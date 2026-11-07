import test from 'node:test';
import assert from 'node:assert/strict';
import {wav,readReferenceWav} from '../src/server/local-speech';
import {Voice} from '../src/ui/voice';

test('designed voice references decode into owned PCM samples and malformed audio is rejected before native inference',()=>{
 const input=new Float32Array([0,.25,-.25,1,-1]);const bytes=wav(input,24000);const result=readReferenceWav(bytes);
 assert.equal(result.sampleRate,24000);assert.equal(result.samples.length,5);assert.ok(Math.abs(result.samples[1]-.25)<.001);
 bytes.fill(0);assert.ok(result.samples[1]>.24);
 assert.throws(()=>readReferenceWav(Buffer.from('bad audio')),/Invalid/);
 const stereo=wav(input,24000);stereo.writeUInt16LE(2,22);assert.throws(()=>readReferenceWav(stereo),/mono PCM16/);
 const truncated=wav(input,24000);truncated.writeUInt32LE(999999,40);assert.throws(()=>readReferenceWav(truncated),/Truncated/);
});
test('OpenAI reasoning can use the selected local voice without opening a paid realtime call',async()=>{
 const oldWindow=(globalThis as any).window;let local=0,realtime=0;
 (globalThis as any).window={capri:{request:async(_method:string,route:string)=>route==='/v1/settings'?{voiceTransport:'auto'}:{active:'openai',speech:{ready:true},local:{ready:false}}}};
 const voice=new Voice(()=>{},()=>false);
 (voice as any).startLocal=async()=>{local++;};(voice as any).startOpenAI=async()=>{realtime++;};
 try{await voice.start();assert.equal(local,1);assert.equal(realtime,0);}finally{(globalThis as any).window=oldWindow;}
});
