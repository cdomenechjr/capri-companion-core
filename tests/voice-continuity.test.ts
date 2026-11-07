import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Voice} from '../src/ui/voice';
import {admitReply, advancePrivacy, claimPrivate, privateGate, showReply} from '../src/ui/chat-submission';
import {defaultListeningPreferences} from '../src/ui/listening';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};}
const tick=()=>new Promise<void>(r=>setImmediate(r));
const voices=new Set<Voice>();
afterEach(async()=>{try{for(const voice of voices)await voice.stop();}finally{voices.clear();}});
const privateReply=(taskId:string,text:string)=>({type:'message',privateSession:true,message:{id:'m-'+taskId,role:'assistant',text,taskId}});

/**
 * Desktop renderer stand-in wired as main.tsx wires it: one Voice owner, a renderer-owned private ledger and the
 * privacy toggle. /v1/chat and transcription are deferred fakes; no microphone, audio, network or provider is used.
 */
function renderer(options:{detect?:(body:any)=>Promise<any>;transcribe?:(n:number)=>any}={}){
 const gate=privateGate();const ui={private:false,epoch:0};
 const captureToken=crypto.randomUUID();
 const chats:{body:any;claimedFirst:boolean;receipt:ReturnType<typeof deferred<any>>}[]=[];const transcripts:ReturnType<typeof deferred<any>>[]=[];const heard:any[]=[];const events:any[]=[];
 (globalThis as any).window={capri:{request:(method:string,route:string,body:any)=>{
  if(route==='/v1/voice/local/capture'&&method==='GET'){assert.equal(body,undefined);return Promise.resolve({captureToken});}
  if(route==='/v1/chat'){const receipt=deferred<any>();chats.push({body,claimedFirst:gate.current.has(body.id),receipt});return receipt.promise;}
  if(route==='/v1/voice/local/transcribe'){const t=deferred<any>();transcripts.push(t);heard.push(body);if(options.transcribe)t.resolve(options.transcribe(transcripts.length));return t.promise;}
  if(route==='/v1/voice/local/detect'&&options.detect){assert.equal(method,'POST');assert.equal(body.captureToken,captureToken);assert.equal(typeof body.sessionId,'string');assert.ok(Number.isSafeInteger(body.sequence)&&body.sequence>=0);assert.equal(typeof body.samples,'string');assert.ok(body.reset===undefined||body.reset===true);return options.detect(body);}
  if(method==='DELETE')return Promise.resolve({});
  throw Error('Unexpected route '+route);
 }}};
 (globalThis as any).cancelAnimationFrame=()=>{};
 const voice=new Voice(e=>events.push(e),()=>ui.private,true,{epoch:()=>ui.epoch,claim:(id,epoch)=>claimPrivate(gate,id,epoch)});
 voices.add(voice);
 voice.player={playing:false,play:async()=>{},stop:()=>{}} as any;
 /** main.tsx's toggle: retire every claim synchronously, then stop voice. */
 const toggle=()=>{ui.private=!ui.private;ui.epoch++;advancePrivacy(gate,ui.epoch);void voice.stop();};
 /** A connected realtime call with a fake data channel. */
 const realtime=()=>{const sent:any[]=[];voice.active=true;voice.localMode=false;voice.channel={readyState:'open',send:(v:string)=>sent.push(JSON.parse(v)),close(){}} as any;return sent;};
 let calls=0;
 const requestTask=(text:string)=>(voice as any).receive({type:'response.function_call_arguments.done',name:'request_task',call_id:'call-'+(++calls),arguments:JSON.stringify({text})}) as Promise<void>;
 const outputs=(sent:any[])=>sent.filter(v=>v.item?.type==='function_call_output').map(v=>JSON.parse(v.item.output));
 const seen={spoken:[] as string[],captions:[] as string[],ephemeral:[] as any[]};
 const out={speak:(text:string)=>{seen.spoken.push(text);},caption:(text:string)=>{seen.captions.push(text);},ephemeral:(m:any)=>{seen.ephemeral.push(m);}};
 /** deliver() then receive() as main.tsx routes a message event. */
 const deliver=(event:any)=>admitReply(gate,event,{privateMode:ui.private,floating:false})&&showReply(gate,event,{privateMode:ui.private,floating:false},out);
 /** The ledger advances on its own: no Stop from main.tsx and no further recognizer part is needed to fence old audio. */
 const switchPrivacy=()=>{ui.private=!ui.private;ui.epoch++;advancePrivacy(gate,ui.epoch);};
 return {gate,ui,voice,chats,transcripts,heard,events,toggle,switchPrivacy,realtime,requestTask,outputs,seen,deliver};
}

test('a private realtime task is claimed before dispatch; after privacy off/on its late receipt and reply are rejected',async()=>{
 const r=renderer();r.toggle();
 let sent=r.realtime();const run=r.requestTask('my secret errand');
 assert.equal(r.chats.length,1);const id=r.chats[0].body.id;
 assert.equal(r.chats[0].claimedFirst,true,'the id was in the ledger before /v1/chat was called');
 assert.equal(r.chats[0].body.private,true);assert.ok(r.voice.taskIds.has(id));
 r.toggle();r.toggle();assert.equal(r.ui.private,true,'private again, in a newer epoch');
 assert.equal(r.gate.current.has(id),false);assert.equal(r.voice.taskIds.size,0);
 sent=r.realtime();// a new call is live when the old receipt lands
 r.chats[0].receipt.resolve({id,status:'running'});await run;
 assert.equal(r.voice.taskIds.has(id),false,'the stopped session does not adopt the late receipt');
 assert.deepEqual(sent,[],'no function output reaches the newer call');
 assert.equal(r.deliver(privateReply(id,'Here is your secret.')),false);
 assert.deepEqual(r.seen,{spoken:[],captions:[],ephemeral:[]});
 assert.equal(claimPrivate(r.gate,id,r.ui.epoch),false,'a retired id cannot be reclaimed');
 await r.voice.stop();
});

test('a current-epoch private realtime task still shows its reply once after ordinary voice shutdown',async()=>{
 const r=renderer();r.toggle();
 const sent=r.realtime();const run=r.requestTask('check the weather');const id=r.chats[0].body.id;
 r.chats[0].receipt.resolve({id,status:'running'});await run;
 assert.deepEqual(r.outputs(sent),[{taskId:id,status:'running',message:'Task submitted. Completion is not yet known. Wait for its result.'}]);
 await r.voice.stop();// idle shutdown clears the voice session's own task set
 assert.equal(r.voice.taskIds.size,0);
 assert.equal(r.deliver(privateReply(id,'Sunny.')),true);
 assert.deepEqual(r.seen.spoken,['Sunny.']);assert.deepEqual(r.seen.ephemeral.map(m=>m.taskId),[id]);
 assert.equal(r.deliver(privateReply(id,'Sunny.')),false,'a duplicate event is dropped');
 assert.deepEqual(r.seen.spoken,['Sunny.']);assert.equal(r.seen.ephemeral.length,1);
 assert.equal(r.chats.length,1,'nothing was resubmitted');
});

test('realtime transport loss and mismatched receipts are reported as unconfirmed without resubmitting',async()=>{
 const r=renderer();r.toggle();
 const sent=r.realtime();
 let run=r.requestTask('book it');const lost=r.chats[0].body.id;r.chats[0].receipt.reject(new TypeError('fetch failed'));await run;
 assert.equal(r.voice.taskIds.has(lost),false);assert.deepEqual(r.outputs(sent),[{error:'fetch failed'}]);
 // The service may have stored it before the connection dropped; its reply in this epoch is still shown once.
 assert.equal(r.deliver(privateReply(lost,'Booked.')),true);assert.deepEqual(r.seen.spoken,['Booked.']);
 run=r.requestTask('and the other one');const other=r.chats[1].body.id;r.chats[1].receipt.resolve({id:'someone-else',status:'running'});await run;
 assert.deepEqual(r.outputs(sent)[1],{taskId:other,message:'Submission could not be confirmed. Do not submit it again; the user can check Activity.'});
 assert.equal(r.chats.length,2);
 await r.voice.stop();
});

test('a saved-history realtime task claims nothing and its reply passes as before',async()=>{
 const r=renderer();
 const sent=r.realtime();const run=r.requestTask('remember this');const id=r.chats[0].body.id;
 assert.equal(r.chats[0].body.private,false);assert.equal(r.gate.current.size,0);
 r.chats[0].receipt.resolve({id,status:'running'});await run;assert.equal(r.outputs(sent)[0].taskId,id);
 assert.equal(r.deliver({type:'message',message:{id:'m',role:'assistant',text:'Saved.',taskId:id}}),true);
 assert.deepEqual(r.seen.spoken,['Saved.']);assert.deepEqual(r.seen.ephemeral,[]);
 await r.voice.stop();
});

test('a long private local turn is transcribed in parts, claimed once and submitted once; stopping between parts sends nothing',async()=>{
 const r=renderer();r.toggle();
 r.voice.active=true;r.voice.localMode=true;
 let turn=(r.voice as any).utterance([new Float32Array(1600),new Float32Array(1600)],r.voice.generation) as Promise<void>;await tick();
 r.transcripts[0].resolve({text:'first half'});await tick();
 assert.equal(r.chats.length,0,'nothing is submitted before the whole turn is heard');assert.equal(r.gate.current.size,0);
 r.transcripts[1].resolve({text:'second half'});await tick();
 assert.equal(r.chats.length,1);assert.equal(r.chats[0].body.text,'first half second half');
 assert.equal(r.chats[0].claimedFirst,true);assert.equal(r.chats[0].body.private,true);
 r.chats[0].receipt.resolve({id:r.chats[0].body.id,status:'running'});await turn;
 assert.equal(r.events.filter(e=>e.type==='userTranscript').length,1);
 r.voice.active=true;r.voice.localMode=true;
 turn=(r.voice as any).utterance([new Float32Array(1600),new Float32Array(1600)],r.voice.generation);await tick();
 r.transcripts[2].resolve({text:'unfinished'});await tick();await r.voice.stop();
 r.transcripts[3]?.resolve({text:'late words'});await turn;
 assert.equal(r.chats.length,1);assert.equal(r.events.filter(e=>e.type==='userTranscript').length,1);
});

/** Generated 100 ms frames for the live capture path; no microphone. */
const speech=(n:number,p:any)=>{for(let i=0;i<n;i++)p.push(new Float32Array(1600).fill(.1),{outputActive:false,outputLevel:0});};
const pause=(p:any)=>{for(let i=0;i<14;i++)p.push(new Float32Array(1600).fill(.001),{outputActive:false,outputLevel:0});};
/** The worklet's route into the single capture owner: each block is checked against the privacy fence before buffering. */
const capture=(r:ReturnType<typeof renderer>)=>({push:(samples:Float32Array)=>(r.voice as any).capture(r.voice.generation,samples)});

test('a long private capture turn: Stop and a privacy change invalidate every pending part and nothing is submitted late',async()=>{
 const r=renderer();r.toggle();r.voice.active=true;r.voice.localMode=true;
 let p=(r.voice as any).listen(r.voice.generation);
 for(let k=0;k<5;k++){speech(100,p);await tick();}// 50 s: two parts are with the recognizer
 assert.equal(r.transcripts.length,1,'parts are transcribed in order, one at a time');
 await r.voice.stop();
 r.transcripts[0].resolve({text:'private words'});for(let i=0;i<5;i++)await tick();
 pause(p);for(let i=0;i<5;i++)await tick();
 assert.equal(r.transcripts.length,1,'the queued part was never sent for transcription');assert.equal(r.chats.length,0);assert.equal(r.gate.current.size,0);
 assert.equal(r.events.filter(e=>e.type==='userTranscript').length,0);
 // Privacy flips while a long turn is still being spoken: its transcripts are discarded and it ends with a notice, unsent.
 p=localCapture(r);
 speech(250,p);await tick();assert.equal(r.transcripts.length,2);
 r.ui.private=false;r.ui.epoch++;advancePrivacy(r.gate,r.ui.epoch);
 r.transcripts[1].resolve({text:'old private words'});await tick();
 pause(p);for(let i=0;i<5;i++)await tick();// speech after the switch would be a new turn of the new mode
 assert.equal(r.transcripts.length,2,'no further part of the old turn is transcribed');assert.equal(r.chats.length,0);
 assert.ok(r.events.some(e=>e.type==='notice'&&/Private mode changed/.test(e.text)));
 assert.equal(r.events.some(e=>e.type==='caption'&&/old private words/.test(e.text)),false,'nothing heard in the old mode is shown');
 // The next turn belongs to the new mode and is submitted once.
 speech(6,p);pause(p);await tick();r.transcripts[2].resolve({text:'saved request'});for(let i=0;i<5;i++)await tick();
 assert.equal(r.chats.length,1);assert.equal(r.chats[0].body.private,false);assert.equal(r.chats[0].body.text,'saved request');
 await r.voice.stop();
});

test('local voice claims a private turn with the epoch captured at the turn; a privacy change mid-turn sends nothing',async()=>{
 const r=renderer();r.toggle();
 r.voice.active=true;r.voice.localMode=true;
 let turn=(r.voice as any).utterance(new Float32Array(16),r.voice.generation) as Promise<void>;await tick();
 r.transcripts[0].resolve({text:'remind me at six'});await tick();
 assert.equal(r.chats.length,1);const id=r.chats[0].body.id;
 assert.equal(r.chats[0].claimedFirst,true);assert.equal(r.chats[0].body.private,true);
 r.chats[0].receipt.resolve({id,status:'running'});await turn;
 await r.voice.stop();
 assert.equal(r.deliver(privateReply(id,'Reminder set.')),true,'the reply still shows after voice stopped');
 assert.equal(r.deliver(privateReply(id,'Reminder set.')),false);assert.deepEqual(r.seen.spoken,['Reminder set.']);
 // Privacy flips while the next utterance is being transcribed: nothing is claimed or submitted.
 r.voice.active=true;r.voice.localMode=true;
 turn=(r.voice as any).utterance(new Float32Array(16),r.voice.generation);await tick();
 r.toggle();r.toggle();
 r.transcripts[1].resolve({text:'old private words'});await turn;
 assert.equal(r.chats.length,1);assert.equal(r.gate.current.size,0);
 await r.voice.stop();
});

// ---- privacy fence at capture: generated frames, fake detector/recognizer/chat, ledger-only switches (no Stop).

/** Frames at a distinct level so their samples can be recognised in whatever reaches the recognizer. */
const fill=(p:any,n:number,level:number)=>{for(let i=0;i<n;i++)p.push(new Float32Array(1600).fill(level),{outputActive:false,outputLevel:0});};
const decode=(body:any)=>{const b=Buffer.from(body.samples,'base64');return new Float32Array(b.buffer,b.byteOffset,b.byteLength/4);};
const has=(samples:Float32Array,level:number)=>samples.some(v=>v===Math.fround(level));
const settle=async(n=5)=>{for(let i=0;i<n;i++)await tick();};
const notices=(r:ReturnType<typeof renderer>)=>r.events.filter(e=>e.type==='notice').map(e=>e.text as string);
const previews=(r:ReturnType<typeof renderer>)=>r.events.filter(e=>e.type==='caption'&&/^I heard/.test(e.text)).map(e=>e.text as string);
const PRIVACY=/Private mode changed/;
/** Starts listening as startLocal does. Stop's 500 ms speaker tail is cleared so generated frames are not counted as playback. */
const localCapture=(r:ReturnType<typeof renderer>)=>{r.voice.active=true;r.voice.localMode=true;(r.voice as any).speakerTailUntil=0;(r.voice as any).listen(r.voice.generation);return capture(r);};

test('a short private utterance switched to history before any recognizer part is discarded with its pre-roll and never becomes a saved request',async()=>{
 const r=renderer();r.toggle();const mic=localCapture(r);
 fill(mic,3,.003);fill(mic,8,.1);assert.equal(r.voice.listeningStatus()?.collecting,true,'a private turn is open, with pre-roll, before any part exists');
 r.switchPrivacy();assert.equal(r.ui.private,false);
 fill(mic,14,.001);await settle();
 assert.equal(r.transcripts.length,0,'nothing of it reaches the recognizer');assert.equal(r.chats.length,0);assert.equal(r.gate.current.size,0);
 assert.equal(r.events.filter(e=>e.type==='userTranscript').length,0);assert.equal(notices(r).filter(t=>PRIVACY.test(t)).length,1);
 // A clean turn in the new epoch: only audio buffered after the switch.
 fill(mic,6,.2);fill(mic,14,.001);await settle();
 assert.equal(r.transcripts.length,1);const audio=decode(r.heard[0]);
 assert.equal(audio.length,(3+6+14)*1600,'new pre-roll, speech and pause only');assert.equal(has(audio,.1)||has(audio,.003),false,'no sample from the private capture');
 r.transcripts[0].resolve({text:'saved request'});await settle();
 assert.equal(r.chats.length,1);assert.equal(r.chats[0].body.private,false);assert.equal(r.chats[0].body.text,'saved request');assert.equal(r.gate.current.size,0);
 await r.voice.stop();
});

test('history pre-roll buffered before a switch to private never leads the private turn',async()=>{
 const r=renderer();const mic=localCapture(r);
 fill(mic,5,.003);r.switchPrivacy();assert.equal(r.ui.private,true);
 fill(mic,6,.2);fill(mic,14,.001);await settle();
 assert.equal(r.transcripts.length,1);const audio=decode(r.heard[0]);
 assert.equal(audio.length,(6+14)*1600,'the history pre-roll stays behind');assert.equal(has(audio,.003),false);
 assert.deepEqual(notices(r),[],'no turn was open, so there is nothing to report');
 r.transcripts[0].resolve({text:'private request'});await settle();
 assert.equal(r.chats.length,1);assert.equal(r.chats[0].body.private,true);assert.equal(r.chats[0].claimedFirst,true,'claimed in the new epoch before dispatch');
 await r.voice.stop();
});

test('detector decisions for a whole private turn and its final pause arriving after a switch to history submit nothing',async()=>{
 const held:{body:any;reply:ReturnType<typeof deferred<any>>}[]=[];const bodies:any[]=[];let hold=true;
 const answer=(body:any)=>({available:true,speech:decode(body)[0]>.05,sequence:body.sequence,sessionId:body.sessionId});
 const r=renderer({detect:body=>{bodies.push(body);if(!hold)return Promise.resolve(answer(body));const reply=deferred<any>();held.push({body,reply});return reply.promise;}});
 r.toggle();r.voice.applyListening({...defaultListeningPreferences(),enabled:true,silenceMs:200});const mic=localCapture(r);
 fill(mic,3,.003);fill(mic,6,.1);fill(mic,2,.001);await settle();// pre-roll, speech and the natural pause, all undecided
 assert.equal(held.length,3,'detector requests stay bounded');const oldSession=held[0].body.sessionId;
 r.switchPrivacy();
 for(let round=0;round<6;round++){for(const h of held.splice(0))h.reply.resolve(answer(h.body));await settle(2);}
 assert.equal(r.transcripts.length,0);assert.equal(r.chats.length,0);assert.equal(r.events.filter(e=>e.type==='userTranscript').length,0);
 assert.equal(r.voice.listeningStatus()?.collecting,false);
 hold=false;const before=bodies.length;
 for(let i=0;i<6;i++){fill(mic,1,.2);await settle(1);}for(let i=0;i<2;i++){fill(mic,1,.001);await settle(1);}await settle();
 const fresh=bodies.slice(before);assert.ok(fresh.length>0&&fresh.every(b=>b.sessionId!==oldSession),'the new mode uses a new detector session');assert.equal(fresh[0].reset,true);
 assert.equal(r.transcripts.length,1);const audio=decode(r.heard[0]);assert.equal(audio.length,(6+2)*1600);assert.equal(has(audio,.1),false);
 r.transcripts[0].resolve({text:'saved request'});await settle();
 assert.equal(r.chats.length,1);assert.equal(r.chats[0].body.private,false);assert.equal(r.gate.current.size,0);
 await r.voice.stop();
});

test('a backlog failure followed by a switch before the pause never shows or sends the old private text',async()=>{
 const r=renderer();r.toggle();const mic=localCapture(r);
 for(let i=0;i<220;i++){fill(mic,1,.1);if(i%20===19)await tick();}
 assert.equal(r.transcripts.length,1);r.transcripts[0].resolve({text:'my private backlog words'});await settle();
 for(let i=0;i<820;i++){fill(mic,1,.1);if(i%20===19)await tick();}
 assert.equal((r.voice as any).turn.failure,'backlog');
 r.switchPrivacy();fill(mic,14,.001);await settle();
 r.transcripts[1].resolve({text:'late private words'});await settle();
 assert.deepEqual(previews(r),[]);assert.equal(r.chats.length,0);assert.equal(r.transcripts.length,2,'no queued part is transcribed later');
 assert.equal(notices(r).length,1);assert.match(notices(r)[0],PRIVACY);
 fill(mic,6,.2);fill(mic,14,.001);await settle();r.transcripts[2].resolve({text:'saved request'});await settle();
 assert.equal(r.chats.length,1);assert.equal(r.chats[0].body.private,false);assert.equal(r.chats[0].body.text,'saved request');
 await r.voice.stop();
});

test('a duration failure keeps its own-epoch preview; after a switch before the pause nothing more of it is shown or sent',async()=>{
 const r=renderer({transcribe:n=>({text:'private piece '+n})});r.toggle();const mic=localCapture(r);
 for(let i=0;i<3000;i++){fill(mic,1,.1);if(i%20===19)await tick();}await settle();
 assert.equal(previews(r).length,1,'shown in the private epoch it was heard in');assert.match(notices(r)[0],/longer than I can take/);
 const transcribed=r.transcripts.length,shown=r.events.filter(e=>e.type==='caption').length;
 r.switchPrivacy();fill(mic,14,.001);await settle();
 assert.equal(r.events.filter(e=>e.type==='caption').length,shown,'nothing more of the old turn is shown');assert.equal(r.transcripts.length,transcribed);assert.equal(r.chats.length,0);
 assert.equal(notices(r).filter(t=>PRIVACY.test(t)).length,1);
 fill(mic,6,.2);fill(mic,14,.001);await settle();
 assert.equal(r.chats.length,1);assert.equal(r.chats[0].body.private,false);assert.equal(r.chats[0].body.text,'private piece '+(transcribed+1));
 await r.voice.stop();
});

test('a text failure followed by a switch before the pause shows no preview and sends nothing',async()=>{
 const r=renderer({transcribe:()=>({text:'secret '.repeat(714)})});r.toggle();const mic=localCapture(r);
 for(let i=0;i<620;i++){fill(mic,1,.1);if(i%20===19)await tick();}await settle();
 assert.equal((r.voice as any).turn.failure,'text');
 r.switchPrivacy();fill(mic,14,.001);await settle();
 assert.deepEqual(previews(r),[]);assert.equal(r.chats.length,0);assert.equal(r.events.some(e=>/secret/.test(String(e.text??''))),false);
 assert.equal(notices(r).length,1);assert.match(notices(r)[0],PRIVACY);
 await r.voice.stop();
});

/** A finished turn waits behind an earlier request while its last part fails the text bound; the ledger may move before it is reported. */
async function queuedTextFailure(startPrivate:boolean,switchBeforeReport:boolean){
 const r=renderer();if(startPrivate)r.toggle();const mic=localCapture(r);(r.voice as any).localBusy=true;
 for(let i=0;i<620;i++){fill(mic,1,.1);if(i%20===19)await tick();if(r.transcripts.length<3)for(const t of r.transcripts)t.resolve({text:'a'.repeat(5000)});}
 fill(mic,14,.001);await settle();
 assert.equal((r.voice as any).pendingUtterances.length,1,'the finished turn is queued');
 r.transcripts[2].resolve({text:'a'.repeat(5000)});await settle();
 assert.equal((r.voice as any).pendingUtterances[0].failure,'text');
 if(switchBeforeReport)r.switchPrivacy();
 (r.voice as any).localBusy=false;(r.voice as any).nextUtterance();await settle();
 assert.equal(r.chats.length,0);assert.equal(r.transcripts.length,3,'the final part is not transcribed after the failure');
 await r.voice.stop();return r;
}

// ---- one recognizer bound and held-audio wiping: deferred fake recognizer that ignores aborts, generated frames only.

/** Recognizer calls the fake transport has not settled yet, and the most ever outstanding at once. */
function recognizerLedger(r:ReturnType<typeof renderer>){
 const settled=new Set<number>();let peak=0;
 const outstanding=()=>r.transcripts.length-settled.size;
 return {settled,outstanding,observe(){peak=Math.max(peak,outstanding());},get peak(){return peak;},
  resolve(i:number,text:string){settled.add(i);r.transcripts[i].resolve({text});}};
}
/** The level of a request's speech, which identifies the turn it came from (pre-roll and pauses are quieter). */
const speechLevel=(body:any)=>{const s=decode(body);for(const v of s)if(v>.05)return Math.round(v*1000)/1000;return 0;};
const zeroed=(samples:Float32Array)=>samples.every(v=>v===0);
const MAX_RECOGNIZER=2;

test('one recognizer bound covers every turn: repeated long turns behind a saturated finished queue stay bounded, ordered and submitted once each',async t=>{
 const r=renderer();t.after(()=>r.voice.stop());const mic=localCapture(r);const ledger=recognizerLedger(r);
 const say=async(level:number,seconds:number)=>{for(let i=0;i<seconds*10;i++){fill(mic,1,level);if(i%20===19){await tick();ledger.observe();}}pause(mic);await settle();ledger.observe();};
 // Five 25 s requests, each longer than one recognizer part: one is submitting, three wait finished, the fifth overflows the queue.
 for(let t=0;t<5;t++)await say(.1+t*.01,25);
 assert.ok(ledger.peak<=MAX_RECOGNIZER,'never more than the bound outstanding: '+ledger.peak);
 assert.equal(r.transcripts.length,MAX_RECOGNIZER,'later turns wait for capacity instead of starting requests');
 assert.deepEqual(r.transcripts.map((_,i)=>speechLevel(r.heard[i])),[.1,.11],'the oldest turns go first');
 assert.ok(notices(r).some(t=>/Still finishing your earlier requests/.test(t)),'the overflowing turn is reported, not silently dropped');
 assert.equal(r.chats.length,0);
 // The transport settles in its own time; each turn's parts are transcribed in order and each turn is submitted once.
 const parts=new Map<number,number>();const answered=new Set<string>();
 for(let round=0;round<60;round++){
  for(let i=0;i<r.transcripts.length;i++)if(!ledger.settled.has(i)){const level=speechLevel(r.heard[i]),k=parts.get(level)??0;parts.set(level,k+1);ledger.resolve(i,'turn'+level+' part'+k);}
  await settle();ledger.observe();
  for(const chat of r.chats)if(!answered.has(chat.body.id)){answered.add(chat.body.id);chat.receipt.resolve({id:chat.body.id,status:'running'});await settle();r.voice.taskState({state:'error',source:'chat',taskId:chat.body.id});}
  await settle();ledger.observe();
 }
 assert.ok(ledger.peak<=MAX_RECOGNIZER);assert.equal(ledger.outstanding(),0);
 assert.deepEqual(r.chats.map(c=>c.body.text),[.1,.11,.12,.13].map(l=>'turn'+l+' part0 turn'+l+' part1'),'four requests, in order, each whole and once');
 assert.equal(r.transcripts.length,8,'the cancelled fifth turn was never transcribed');assert.equal(r.events.filter(e=>e.type==='userTranscript').length,4);
 await r.voice.stop();
});

test('recognizer calls abandoned by Stop, restart and privacy changes keep their slots until the transport settles; late results change nothing',async t=>{
 const r=renderer();t.after(()=>r.voice.stop());let mic=localCapture(r);const ledger=recognizerLedger(r);
 const long=async(level:number)=>{for(let i=0;i<210;i++){fill(mic,1,level);if(i%20===19){await tick();ledger.observe();}}await settle();ledger.observe();};
 await long(.11);assert.equal(r.transcripts.length,1);
 await r.voice.stop();mic=localCapture(r);await long(.12);
 assert.equal(r.transcripts.length,2,'the stopped session’s request still counts; one more fits');
 await r.voice.stop();mic=localCapture(r);await long(.13);
 assert.equal(r.transcripts.length,2,'a third waits: both earlier requests are unsettled although their sessions stopped');
 r.switchPrivacy();await long(.15);
 assert.equal(r.transcripts.length,2,'a new privacy epoch shares the same bound');assert.ok(ledger.peak<=MAX_RECOGNIZER);
 // The abandoned transports settle late: their text goes nowhere, and only the current turn takes the freed capacity.
 ledger.resolve(0,'stale one');await settle();
 assert.equal(r.transcripts.length,3);assert.equal(speechLevel(r.heard[2]),.15,'the current private turn, not the abandoned .13 turn');
 ledger.resolve(1,'stale two');await settle();
 ledger.resolve(2,'fresh a');pause(mic);await settle();assert.equal(r.transcripts.length,4,'its final part follows in order');
 ledger.resolve(3,'fresh b');await settle();
 assert.equal(r.chats.length,1);assert.equal(r.chats[0].body.text,'fresh a fresh b');assert.equal(r.chats[0].body.private,true);assert.equal(r.chats[0].claimedFirst,true);
 assert.equal(r.events.some(e=>/stale/.test(String(e.text??''))),false,'no late text is shown or sent');assert.deepEqual(previews(r),[]);
 assert.ok(ledger.peak<=MAX_RECOGNIZER);
 await r.voice.stop();
});

test('raw audio of emitted, finalized and waiting recognizer parts is zeroed on encoding, Stop and privacy changes while requests are unresolved',async t=>{
 const r=renderer();t.after(()=>r.voice.stop());const voice=r.voice as any;const chunks:Float32Array[]=[];
 const addPart=voice.addPart.bind(voice);voice.addPart=(turn:unknown,samples:Float32Array)=>{chunks.push(samples);addPart(turn,samples);};
 let mic=localCapture(r);
 for(let i=0;i<250;i++){fill(mic,1,.1);if(i%20===19)await tick();}pause(mic);await settle();
 assert.equal(r.transcripts.length,1);assert.equal(chunks.length,2);assert.equal(voice.turn,undefined,'the finished turn is detached from capture');
 assert.ok(zeroed(chunks[0]),'the part with the recognizer was zeroed as soon as it was encoded');assert.ok(has(decode(r.heard[0]),.1));
 assert.ok(!zeroed(chunks[1]),'the finalized turn still holds its waiting last part');
 void r.voice.stop();
 assert.ok(chunks.every(zeroed),'Stop zeroes every held part at once, attached to capture or not');
 r.transcripts[0].resolve({text:'late words'});await settle();
 assert.equal(r.transcripts.length,1,'the waiting part is never sent');assert.equal(r.chats.length,0);
 assert.equal(r.events.filter(e=>e.type==='userTranscript').length,0);assert.deepEqual(previews(r),[]);
 // Privacy: a finished turn waiting on the recognizer and an open turn with a part emitted are both wiped by the switch.
 chunks.length=0;mic=localCapture(r);
 for(let i=0;i<250;i++){fill(mic,1,.12);if(i%20===19)await tick();}pause(mic);await settle();
 for(let i=0;i<210;i++){fill(mic,1,.13);if(i%20===19)await tick();}await settle();
 assert.equal(chunks.length,3);assert.equal(r.transcripts.length,3,'two requests are with the recognizer');
 assert.ok(zeroed(chunks[0])&&zeroed(chunks[2]),'sent parts were zeroed once encoded');assert.ok(!zeroed(chunks[1]));assert.ok(voice.turn,'a turn is open');
 r.switchPrivacy();fill(mic,1,.001);
 assert.ok(chunks.every(zeroed),'the privacy change zeroes the finished turn’s waiting part as well as the open turn');
 for(let i=1;i<r.transcripts.length;i++)r.transcripts[i].resolve({text:'old mode words'});await settle();
 assert.equal(r.transcripts.length,3);assert.equal(r.chats.length,0);assert.deepEqual(previews(r),[]);
 assert.equal(r.events.some(e=>/old mode words/.test(String(e.text??''))),false);
 assert.ok(notices(r).length>0&&notices(r).every(t=>PRIVACY.test(t)));
 assert.equal(voice.heardTurns.size,0,'nothing is left holding audio');
 await r.voice.stop();
});

test('a queued failed turn rechecks its privacy epoch when reported; same-epoch history feedback is kept',async()=>{
 const moved=await queuedTextFailure(true,true);
 assert.deepEqual(previews(moved),[],'no raw private text after the epoch moved');assert.match(notices(moved).at(-1)!,PRIVACY);
 assert.equal((moved.voice as any).pendingUtterances.length,0);
 const same=await queuedTextFailure(false,false);
 assert.equal(previews(same).length,1);assert.ok(previews(same)[0].startsWith('I heard: “aaaa'));assert.match(notices(same).at(-1)!,/too long to send as one/);
});
