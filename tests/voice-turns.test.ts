import test from 'node:test';
import assert from 'node:assert/strict';
import { Voice } from '../src/ui/voice';
import { UtteranceSegmenter } from '../src/ui/audio';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const tick=()=>new Promise<void>(r=>setImmediate(r));
function harness(request:(route:string,body:any)=>Promise<any>,ownsAudio=true){
 (globalThis as any).window={capri:{request:(_method:string,route:string,body:any)=>request(route,body)}};
 (globalThis as any).cancelAnimationFrame=()=>{};
 const events:any[]=[];const played:string[]=[];const voice=new Voice(e=>events.push(e),()=>false,ownsAudio);
 voice.configure({speakReplies:true});
 voice.player={playing:false,play:async(base64:string)=>{played.push(base64);},stop:()=>{}} as any;
 return {voice,events,played};
}

test('natural pauses and quiet speech stay in one utterance; silence is ignored',()=>{
 const segmenter=new UtteranceSegmenter();const quiet=new Float32Array(1600).fill(.009);const silence=new Float32Array(1600);
 for(let i=0;i<20;i++)assert.equal(segmenter.push(silence),undefined);
 for(let i=0;i<4;i++)assert.equal(segmenter.push(quiet),undefined);
 for(let i=0;i<11;i++)assert.equal(segmenter.push(silence),undefined);
 assert.equal(segmenter.collecting,true);
 for(let i=0;i<4;i++)assert.equal(segmenter.push(quiet),undefined);
 for(let i=0;i<13;i++)assert.equal(segmenter.push(silence),undefined);
 assert.ok(segmenter.push(silence));assert.equal(segmenter.collecting,false);
});

test('audio frames cannot exceed the recognition service limit',()=>{
 const segmenter=new UtteranceSegmenter();let utterance:Float32Array|undefined;
 for(let i=0;i<220&&!utterance;i++)utterance=segmenter.push(new Float32Array(1601).fill(.04));
 assert.equal(utterance?.length,320000);
});

test('the small companion cannot start, synthesize, or announce audio',async()=>{
 let requests=0;const {voice,played}=harness(async()=>{requests++;throw Error('Unexpected audio owner');},false);
 await voice.start();await voice.startOpenAI();await voice.startCallProfile();await voice.speak('Hello');voice.announceResult('Hello','same-message');await tick();
 assert.equal(requests,0);assert.deepEqual(played,[]);await voice.stop();
});

test('duplicate delivery is silent and replies synthesize and play sequentially',async()=>{
 const first=deferred<any>();const requests:string[]=[];
 const {voice,played}=harness(async(route,body)=>{assert.equal(route,'/v1/voice/local/speak');requests.push(body.text);return requests.length===1?first.promise:{base64:body.text};});
 voice.announceResult('one','task-one');voice.announceResult('one','task-one');voice.announceResult('two','task-two');await tick();
 assert.deepEqual(requests,['one']);first.resolve({base64:'one'});await tick();await tick();
 assert.deepEqual(requests,['one','two']);assert.deepEqual(played,['one','two']);await voice.stop();
});

test('an unrelated task result cannot unlock a user voice turn',async()=>{
 const requests:string[]=[];const {voice}=harness(async(route,body)=>{requests.push(body.text);return {base64:body.text};});
 voice.active=true;voice.localMode=true;voice.localBusy=true;voice.taskIds.add('user-task');
 voice.announceResult('background update','background-task');await tick();assert.equal(voice.localBusy,true);assert.deepEqual(requests,[]);
 voice.taskState({state:'error',taskId:'other-task'});assert.equal(voice.localBusy,true);
 voice.announceResult('your answer','user-task');await tick();await tick();assert.deepEqual(requests,['background update','your answer']);await voice.stop();
});

test('speech prepared during a user turn waits until their turn finishes',async()=>{
 const synthesis=deferred<any>();const {voice,played}=harness(async()=>synthesis.promise);
 const operation=voice.speak('prepared reply');(voice as any).inputSpeaking=true;synthesis.resolve({base64:'prepared reply'});await tick();assert.deepEqual(played,[]);
 (voice as any).inputSpeaking=false;(voice as any).wakeFloor();await operation;assert.deepEqual(played,['prepared reply']);await voice.stop();
});

test('interrupt drops prepared speech and an old worker cannot reset the next playback',async()=>{
 const old=deferred<any>();const nextPlayback=deferred<void>();
 const {voice,events,played}=harness(async(_route,body)=>body.text==='old'?old.promise:{base64:body.text});
 voice.player.play=async base64=>{played.push(base64);await nextPlayback.promise;};
 voice.announceResult('old','old-task');await tick();voice.interrupt();voice.announceResult('new','new-task');await tick();
 assert.equal(voice.playback.playing,true);old.resolve({base64:'old'});await tick();
 assert.deepEqual(played,['new']);assert.equal(voice.playback.playing,true);assert.equal(events.at(-1)?.state,'speaking');
 nextPlayback.resolve();await tick();await voice.stop();
});

test('stop during synthesis prevents any late audio',async()=>{
 const synthesis=deferred<any>();const {voice,played}=harness(async()=>synthesis.promise);
 const operation=voice.speak('late reply');await voice.stop();synthesis.resolve({base64:'late reply'});await operation;assert.deepEqual(played,[]);
});
