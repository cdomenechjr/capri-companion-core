import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TranscriptCorrection} from '../src/ui/TranscriptCorrection';
import {Voice, type UserTranscriptEvent} from '../src/ui/voice';
import {beginCorrection, canResend, cancelCorrection, CORRECTION_LIMIT, emptyCorrection, failureOutcome, heardOutcome, heardTranscript, NotAcceptedError, originalStatus, prepareResend, receiptOutcome, reconcileObserved, resendOutcome, resendStatus, resetForPrivacy, runResend, settleSubmission, updateCorrection, type CorrectionRequest, type CorrectionState} from '../src/ui/transcript-correction';

const event=(text:string,privateMode=false,taskId='task-original',id='utterance-1'):UserTranscriptEvent=>({type:'userTranscript',id,taskId,text,private:privateMode});
const heard=(text='book a table for tree',privateMode=false,taskId='task-original')=>heardTranscript(emptyCorrection,event(text,privateMode,taskId),privateMode);
const accepted=(state=heard())=>heardOutcome(state,{type:'userTranscriptOutcome',id:'utterance-1',taskId:state.heard!.taskId,outcome:'accepted',error:''});
const edited=(text:string,state=accepted())=>updateCorrection(beginCorrection(state),text);
let ids=0;const nextId=()=>'new-'+(++ids);
const render=(state:CorrectionState,tasks:{id:string;status?:string}[]=[])=>renderToStaticMarkup(React.createElement(TranscriptCorrection,{state,tasks,onEdit(){},onChange(){},onCancel(){},onResend(){}}));
/** Typed pre-acceptance refusal: the only failure that counts as a rejection. */
const rejection=()=>new NotAcceptedError('Connect OpenAI or enable the local model in Settings.');
/** A plain service error carries no provenance; the service may already have stored the task. */
const serviceError=()=>Error("Error invoking remote method 'capri:request': Error: Connect OpenAI or enable the local model in Settings.");
const transportLoss=()=>new TypeError('fetch failed');

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const tick=()=>new Promise<void>(r=>setImmediate(r));
/** Desktop Voice owner with a fake local transcriber and chat service; no microphone, audio or network. */
function localVoice(transcribe:()=>Promise<any>,chat:(body:any)=>Promise<any>=async body=>({id:body.id,status:'running'})){
 const chats:any[]=[];const events:any[]=[];const privacy={private:false};
 (globalThis as any).window={capri:{request:async(_method:string,route:string,body:any)=>{if(route==='/v1/voice/local/transcribe')return transcribe();if(route==='/v1/chat'){chats.push(body);return chat(body);}if(route==='/v1/voice/local/speak')return {base64:body.text};throw Error('Unexpected route '+route);}}};
 (globalThis as any).cancelAnimationFrame=()=>{};
 const voice=new Voice(e=>events.push(e),()=>privacy.private);voice.configure({speakReplies:true});
 voice.player={playing:false,play:async()=>{},stop:()=>{}} as any;voice.active=true;voice.localMode=true;
 const utterance=()=>(voice as any).utterance(new Float32Array(16),voice.generation) as Promise<void>;
 const heardEvents=()=>events.filter(e=>e.type==='userTranscript');
 const outcomes=()=>events.filter(e=>e.type==='userTranscriptOutcome');
 /** Feeds Voice's typed events into the panel state exactly as main.tsx does. */
 const panel=(privateMode=false)=>events.reduce((state,e)=>e.type==='userTranscript'?heardTranscript(state,e,privateMode):e.type==='userTranscriptOutcome'?heardOutcome(state,e):state,emptyCorrection);
 return {voice,chats,events,privacy,utterance,heardEvents,outcomes,panel};
}

test('accepted local speech emits one transcript and one receipt-backed outcome for the same ids',async()=>{
 const {voice,chats,events,utterance,heardEvents,outcomes,panel}=localVoice(async()=>({text:'Hey Capri, book a table for tree'}));
 await utterance();
 assert.equal(chats.length,1,'the original request is submitted once by Voice');
 const [produced]=heardEvents();assert.equal(heardEvents().length,1);
 assert.deepEqual({...produced,id:''},{type:'userTranscript',id:'',taskId:chats[0].id,text:'book a table for tree',private:false});
 assert.ok(produced.id&&produced.id!==chats[0].id);assert.ok(voice.taskIds.has(chats[0].id));
 assert.deepEqual(outcomes(),[{type:'userTranscriptOutcome',id:produced.id,taskId:chats[0].id,outcome:'accepted',error:''}]);
 assert.ok(events.indexOf(produced)<events.indexOf(outcomes()[0]),'the outcome follows the transcript');
 assert.ok(events.some(e=>e.type==='caption'&&e.text==='book a table for tree'),'the existing caption is unchanged');
 const state=panel();
 assert.equal(state.heard?.taskId,chats[0].id);assert.equal(state.heard?.outcome,'accepted');
 assert.match(originalStatus(state.heard,[]),/was received/);
 assert.equal(heardTranscript(state,produced,false),state,'the same event is never taken twice');
 const resent=prepareResend(edited('book a table for three',state),false,nextId);
 assert.ok(resent.ok);assert.notEqual(resent.request.id,chats[0].id);assert.equal(chats.length,1,'preparing a resend never submits by itself');
 await voice.stop();
});

test('a transcribed utterance whose chat request fails with a service error is unconfirmed, not rejected or accepted',async()=>{
 const {voice,chats,events,utterance,outcomes,panel}=localVoice(async()=>({text:'call the bank'}),async()=>{throw serviceError();});
 await utterance();
 assert.equal(chats.length,1,'no automatic retry');
 assert.deepEqual(outcomes().map(e=>[e.outcome,e.taskId,e.error]),[['unknown',chats[0].id,'Connect OpenAI or enable the local model in Settings.']]);
 assert.ok(events.some(e=>e.type==='state'&&e.state==='error'),'the existing error state is still raised');
 assert.equal(voice.taskIds.size,0);assert.equal(voice.localBusy,false);
 const state=panel();assert.equal(state.heard?.outcome,'unknown');
 const status=originalStatus(state.heard,[]);
 assert.match(status,/could not confirm.*Check Activity/);assert.doesNotMatch(status,/not accepted|^Original request was received/);
 const view=render(state);assert.match(view,/could not confirm/);assert.doesNotMatch(view,/Activity shows|not accepted/);
 const resent=prepareResend(edited('call the bank tomorrow',state),false,nextId);
 assert.ok(resent.ok,'a correction can still be sent deliberately as a new request');assert.notEqual(resent.request.id,chats[0].id);
 await voice.stop();
});

test('a lost chat reply leaves the original unconfirmed, and a missing receipt is not an acceptance',async()=>{
 const lost=localVoice(async()=>({text:'order more coffee'}),async()=>{throw transportLoss();});
 await lost.utterance();
 assert.equal(lost.chats.length,1);assert.equal(lost.outcomes()[0].outcome,'unknown');
 const state=lost.panel();assert.match(originalStatus(state.heard,[]),/could not confirm.*Check Activity/);
 assert.doesNotMatch(originalStatus(state.heard,[]),/^Original request was received|Activity shows/);
 assert.equal(originalStatus(state.heard,[{id:lost.chats[0].id,status:'running'}]),'Original request is running.','an observed task record is the real status');
 await lost.voice.stop();
 const silent=localVoice(async()=>({text:'order more tea'}),async()=>({status:'queued'}));
 await silent.utterance();assert.equal(silent.outcomes()[0].outcome,'unknown');assert.equal(silent.chats.length,1);
 await silent.voice.stop();
});

test('cancelled or empty recognition emits no transcript, outcome or request',async()=>{
 const pending=deferred<any>();const cancelled=localVoice(()=>pending.promise);
 const turn=cancelled.utterance();await tick();await cancelled.voice.stop();pending.resolve({text:'too late'});await turn;
 assert.deepEqual(cancelled.heardEvents(),[]);assert.deepEqual(cancelled.outcomes(),[]);assert.deepEqual(cancelled.chats,[]);
 for(const text of ['','   ','hey capri']){
  const empty=localVoice(async()=>({text}));await empty.utterance();
  assert.deepEqual(empty.heardEvents(),[]);assert.deepEqual(empty.outcomes(),[]);assert.deepEqual(empty.chats,[]);await empty.voice.stop();
 }
});

test('assistant, result and realtime captions are never treated as the user transcript',async()=>{
 const {voice,events,heardEvents}=localVoice(async()=>({text:'unused'}));
 await voice.speak('Sure, booked.');voice.announceResult('Your table is booked.','task-x');await tick();await tick();
 await (voice as any).transcript({type:'response.output_audio_transcript.done',response_id:'r1',transcript:'assistant words'});
 await (voice as any).transcript({type:'conversation.item.input_audio_transcription.completed',item_id:'i1',transcript:'realtime words'});
 assert.ok(events.filter(e=>e.type==='caption').length>=3);assert.deepEqual(heardEvents(),[]);
 for(const caption of [{type:'caption',text:'Local microphone ready. Go on, I’m listening.'},{type:'caption',text:'Sure, booked.'},{type:'userTranscript',id:'x',text:'no task',private:false}])
  assert.equal(heardTranscript(emptyCorrection,caption,false),emptyCorrection,'only a complete userTranscript event is accepted');
 await voice.stop();
});

test('a privacy switch cancels in-flight recognition and requests keep their captured privacy',async()=>{
 const pending=deferred<any>();const switched=localVoice(()=>pending.promise);switched.privacy.private=true;
 const turn=switched.utterance();await tick();
 await switched.voice.stop();switched.privacy.private=false;
 pending.resolve({text:'call mom'});await turn;
 assert.deepEqual(switched.heardEvents(),[],'private speech does not surface after leaving the private session');assert.deepEqual(switched.chats,[]);

 const late=deferred<any>();const privateTurn=localVoice(()=>late.promise);privateTurn.privacy.private=true;
 const sent=privateTurn.utterance();await tick();privateTurn.privacy.private=false;late.resolve({text:'call mom'});await sent;
 const [produced]=privateTurn.heardEvents();
 assert.equal(produced.private,true);assert.equal(privateTurn.chats[0].private,true,'original request and transcript share one captured privacy value');
 assert.equal(privateTurn.panel(false),emptyCorrection,'a private transcript or its outcome is not shown in a saved session');
 const state=privateTurn.panel(true);assert.equal(state.heard?.outcome,'accepted');
 const resent=prepareResend(edited('call mum',state),true,nextId);
 assert.ok(resent.ok);assert.equal(resent.request.private,true);assert.notEqual(resent.request.id,produced.taskId);
 await privateTurn.voice.stop();
});

test('outcomes only settle the matching pending heard request',()=>{
 const state=heard();
 for(const stray of [{type:'userTranscriptOutcome',id:'other',taskId:'task-original',outcome:'accepted'},{type:'userTranscriptOutcome',id:'utterance-1',taskId:'other',outcome:'accepted'},{type:'userTranscriptOutcome',id:'utterance-1',taskId:'task-original',outcome:'maybe'},{type:'caption',id:'utterance-1',taskId:'task-original',outcome:'accepted'},null])
  assert.equal(heardOutcome(state,stray),state);
 const rejected=heardOutcome(state,{type:'userTranscriptOutcome',id:'utterance-1',taskId:'task-original',outcome:'rejected',error:'No provider.'});
 assert.equal(rejected.heard?.outcome,'rejected');
 assert.equal(heardOutcome(rejected,{type:'userTranscriptOutcome',id:'utterance-1',taskId:'task-original',outcome:'accepted',error:''}),rejected,'a settled outcome is never rewritten');
 assert.equal(heardOutcome(emptyCorrection,{type:'userTranscriptOutcome',id:'utterance-1',taskId:'task-original',outcome:'accepted'}),emptyCorrection);
 assert.match(originalStatus(state.heard,[]),/still being submitted/);
});

test('submission results are classified from receipts and failures without retrying',async()=>{
 assert.deepEqual(receiptOutcome('r1',{id:'r1',status:'running'}),{outcome:'accepted',error:''});
 for(const receipt of [undefined,null,{},{id:'r2'},'r1'])assert.equal(receiptOutcome('r1',receipt).outcome,'unknown');
 assert.deepEqual(failureOutcome(new NotAcceptedError('Connect OpenAI first.')),{outcome:'rejected',error:'Connect OpenAI first.'});
 assert.deepEqual(failureOutcome(Error("Error invoking remote method 'capri:request': Error: Connect OpenAI first.")),{outcome:'unknown',error:'Connect OpenAI first.'},'message text alone never proves a rejection');
 for(const lost of [Error('Task could not be scheduled'),Object.assign(Error('Bad request'),{name:'NotAcceptedError'}),{notAccepted:true,message:'forged'},new TypeError('fetch failed'),new TypeError('Failed to fetch'),Object.assign(Error('The operation was aborted due to timeout'),{name:'TimeoutError'}),new SyntaxError('Unexpected token < in JSON'),Error("Error invoking remote method 'capri:request': TypeError: fetch failed"),Error('connect ECONNREFUSED 127.0.0.1:18701'),Error('')])
  assert.equal(failureOutcome(lost).outcome,'unknown',String(lost));
 let calls=0;
 assert.equal((await settleSubmission('r1',async()=>{calls++;throw transportLoss();})).outcome,'unknown');
 assert.equal((await settleSubmission('r1',async()=>{calls++;throw rejection();})).outcome,'rejected');
 assert.equal((await settleSubmission('r1',async()=>{calls++;throw serviceError();})).outcome,'unknown');
 assert.equal((await settleSubmission('r1',async()=>{calls++;return {id:'r1'};})).outcome,'accepted');
 assert.equal(calls,4,'each settle sends exactly once');
});

/** Simulates main.tsx resendCorrection against a fake chat service. */
async function resend(state:CorrectionState,chat:(body:any)=>Promise<any>,sent:any[]){
 const result=prepareResend(state,false,nextId);if(!result.ok)return {result,state:result.state};
 const submission=await settleSubmission(result.request.id,()=>{sent.push(result.request);return chat(result.request);});
 return {result,state:resendOutcome(result.state,result.request.id,submission),pending:result.state};
}

test('a corrected request with an accepted receipt is sent exactly once',async()=>{
 const sent:any[]=[];const ok=async(body:any)=>({id:body.id,status:'running'});
 const first=await resend(edited('book a table for three'),ok,sent);
 assert.ok(first.result.ok);assert.equal(sent.length,1);
 assert.equal(first.pending?.resend?.outcome,'pending');assert.match(resendStatus(first.pending!.resend,[]),/Sending/);
 assert.equal(first.state.resend?.outcome,'accepted');assert.equal(first.state.resend?.id,sent[0].id);
 assert.notEqual(sent[0].id,'task-original','the original request is never re-submitted');assert.equal(sent[0].text,'book a table for three');
 assert.equal(first.state.heard?.taskId,'task-original');assert.equal(first.state.editing,false);
 const again=await resend(first.state,ok,sent);
 assert.equal(!again.result.ok&&again.result.reason,'already');assert.equal(sent.length,1,'no second request');
 const whilePending=await resend(first.pending!,ok,sent);
 assert.equal(!whilePending.result.ok&&whilePending.result.reason,'pending');assert.equal(sent.length,1);
 assert.equal(beginCorrection(first.state),first.state,'a sent correction cannot be reopened');
 assert.equal(updateCorrection(first.state,'again'),first.state);
 const done=render(first.state,[{id:sent[0].id,status:'running'}]);
 assert.match(done,/Correction sent as a new request and is running/);assert.match(done,/not undone/);assert.ok(!done.includes('>Correct</button>'));
 const next=heardTranscript(first.state,event('and a cab',false,'task-2','utterance-2'),false);
 assert.equal(next.resend,null);assert.equal(next.heard?.taskId,'task-2');
});

test('a rejected corrected request keeps the draft and permits one new deliberate attempt',async()=>{
 const sent:any[]=[];
 const failed=await resend(edited('book a table for three'),async()=>{throw rejection();},sent);
 assert.equal(sent.length,1);assert.equal(failed.state.resend?.outcome,'rejected');
 assert.equal(failed.state.draft,'book a table for three','the draft is retained');assert.equal(failed.state.editing,true);
 const status=resendStatus(failed.state.resend,[]);assert.match(status,/not accepted: Connect OpenAI/);assert.doesNotMatch(status,/Correction sent/);
 const view=render(failed.state);assert.match(view,/role="alert"/);assert.doesNotMatch(view,/Correction sent/);
 assert.equal(cancelCorrection(failed.state).draft,'book a table for three','cancel keeps the failed draft for later');
 const retry=await resend(failed.state,async body=>({id:body.id}),sent);
 assert.ok(retry.result.ok);assert.equal(sent.length,2);assert.notEqual(sent[1].id,sent[0].id,'the rejected id created nothing, so the new attempt is a new request');
 assert.equal(retry.state.resend?.outcome,'accepted');
});

test('an unconfirmed corrected request keeps its id and blocks duplicates until a task record is observed',async()=>{
 const sent:any[]=[];
 const lost=await resend(edited('book a table for three'),async()=>{throw transportLoss();},sent);
 assert.equal(lost.state.resend?.outcome,'unknown');assert.equal(lost.state.resend?.id,sent[0].id);assert.equal(lost.state.editing,false);
 const again=await resend(updateCorrection(beginCorrection(lost.state),'book a table for four'),async body=>({id:body.id}),sent);
 assert.equal(!again.result.ok&&again.result.reason,'unknown');assert.equal(sent.length,1,'never silently retried under a fresh id');
 assert.equal(beginCorrection(lost.state),lost.state);
 assert.match(resendStatus(lost.state.resend,[]),/could not confirm.*Check Activity.*not be sent again automatically/);
 assert.doesNotMatch(render(lost.state),/Correction sent/);
 assert.match(resendStatus(lost.state.resend,[{id:sent[0].id,status:'completed'}]),/Correction sent as a new request and is completed/,'an observed record confirms it');
 assert.equal(resendOutcome(lost.state,sent[0].id,{outcome:'accepted',error:''}),lost.state,'a settled attempt is not rewritten');
 assert.equal(resendOutcome(lost.state,'other',{outcome:'rejected',error:'x'}),lost.state);
});

test('hearing a transcript only records it and never creates a request',()=>{
 const state=heard('  book a   table for tree ');
 assert.equal(state.heard?.text,'book a table for tree');assert.equal(state.draft,'book a table for tree');
 assert.equal(state.editing,false);assert.equal(state.resend,null);assert.equal(state.heard?.outcome,'pending');
 assert.equal(heardTranscript(state,event('   ',false,'t2','utterance-2'),false),state,'empty speech keeps the previous transcript');
});

test('empty and unchanged corrections are refused without a request',()=>{
 for(const text of ['','   \n\t ']){
  const state=edited(text);const result=prepareResend(state,false,nextId);
  assert.equal(result.ok,false);assert.equal(!result.ok&&result.reason,'empty');
  assert.equal(result.state,state);assert.equal(result.state.resend,null);
 }
 const unchanged=prepareResend(edited(' book a table  for tree '),false,nextId);
 assert.equal(!unchanged.ok&&unchanged.reason,'unchanged');
 assert.equal(prepareResend(emptyCorrection,false,nextId).ok,false);
 assert.equal(updateCorrection(edited(''),'x'.repeat(CORRECTION_LIMIT+50)).draft.length,CORRECTION_LIMIT);
});

test('cancel restores the heard text and keeps the correction unsent',()=>{
 const state=cancelCorrection(edited('something else'));
 assert.equal(state.editing,false);assert.equal(state.draft,'book a table for tree');assert.equal(state.resend,null);
});

test('private transcripts and pending corrections reset when privacy changes',async()=>{
 const privateState=edited('call mum',heard('call mom',true));
 assert.equal(resetForPrivacy(privateState,true),privateState);
 assert.deepEqual(resetForPrivacy(privateState,false),emptyCorrection);
 const crossed=prepareResend(privateState,false,nextId);
 assert.equal(!crossed.ok&&crossed.reason,'privacy');assert.deepEqual(crossed.state,emptyCorrection);
 assert.deepEqual(resetForPrivacy(edited('saved',heard('saved text',false)),true),emptyCorrection);
 const pending=prepareResend(privateState,true,nextId);assert.ok(pending.ok);
 const reset=resetForPrivacy(pending.state,false);assert.deepEqual(reset,emptyCorrection);
 assert.equal(resendOutcome(reset,pending.request.id,{outcome:'accepted',error:''}),reset,'a late receipt does not revive a cleared private correction');
});

/** Renderer stand-in wired exactly like main.tsx resendCorrection and the privacy toggle. */
function renderer(state:CorrectionState,privateMode:boolean,chat:(request:CorrectionRequest)=>Promise<unknown>){
 const r={state,private:privateMode,epoch:0,tasks:[] as {id:string;status?:string}[],ephemeral:[] as any[],sent:[] as CorrectionRequest[],
  toggle(){r.private=!r.private;r.epoch++;r.ephemeral=[];r.state=emptyCorrection;},
  click(){return runResend({state:()=>r.state,update:next=>{r.state=next;},privateMode:()=>r.private,epoch:()=>r.epoch,tasks:()=>r.tasks,send:request=>{r.sent.push(request);return chat(request);},echo:request=>r.ephemeral.push({id:request.id,role:'user',text:request.text}),newId:nextId});}};
 return r;
}

test('a late private receipt after privacy off/on never restores the cleared private text',async()=>{
 const reply=deferred<unknown>();
 const r=renderer(edited('call mum about the test results',accepted(heard('call mom',true))),true,()=>reply.promise);
 const click=r.click();await tick();
 assert.equal(r.sent.length,1);assert.equal(r.state.resend?.outcome,'pending');
 r.toggle();r.toggle();
 assert.equal(r.private,true,'back in a private session, but a new one');assert.equal(r.epoch,2);
 const request=r.sent[0];reply.resolve({id:request.id,status:'running'});
 const run=await click;
 assert.ok(run.sent);assert.equal(run.current,false,'the late result belongs to a previous privacy session');
 assert.equal(run.submission.outcome,'accepted');
 assert.deepEqual(r.ephemeral,[],'no private text reappears in the chat');
 assert.equal(r.state,emptyCorrection,'the cleared correction is not revived');
 assert.equal(r.sent.length,1,'nothing is resent');

 const same=deferred<unknown>();
 const live=renderer(edited('call mum',accepted(heard('call mom',true))),true,()=>same.promise);
 const ok=live.click();await tick();same.resolve({id:live.sent[0].id});const done=await ok;
 assert.ok(done.sent&&done.current);
 assert.deepEqual(live.ephemeral,[{id:live.sent[0].id,role:'user',text:'call mum'}],'the matching current request is shown once');
 assert.equal(live.state.resend?.outcome,'accepted');
});

test('a late receipt in the same epoch only settles the still-current request',async()=>{
 const reply=deferred<unknown>();
 const r=renderer(edited('call mum',accepted(heard('call mom',true))),true,()=>reply.promise);
 const click=r.click();await tick();
 r.state=heardTranscript(r.state,event('and text dad',true,'task-2','utterance-2'),true);
 reply.resolve({id:r.sent[0].id});const run=await click;
 assert.ok(run.sent);assert.equal(run.current,false);
 assert.deepEqual(r.ephemeral,[]);assert.equal(r.state.heard?.taskId,'task-2');assert.equal(r.state.resend,null);
});

test('a stored task followed by a generic error cannot produce a duplicate correction',async()=>{
 const r=renderer(edited('book a table for three'),false,async request=>{r.tasks=[{id:request.id,status:'running'}];throw serviceError();});
 const first=await r.click();
 assert.ok(first.sent);assert.equal(first.submission.outcome,'unknown','an error after storing is not a rejection');
 assert.equal(r.state.resend?.outcome,'accepted','the observed record settles the attempt');
 assert.equal(r.state.editing,false);
 r.state=updateCorrection(beginCorrection(r.state,r.tasks),'book a table for four');
 const retry=await r.click();
 assert.equal(!retry.sent&&retry.reason,'already');assert.equal(r.sent.length,1,'no duplicate dispatch');
 r.tasks=[];const later=await r.click();
 assert.equal(!later.sent&&later.reason,'already','the guard holds after the record leaves the list');assert.equal(r.sent.length,1);
 assert.doesNotMatch(render(r.state),/Edit and try again|not accepted/);
});

test('an observed task overrides an earlier rejection in both the display and the submission guard',async()=>{
 const r=renderer(edited('book a table for three'),false,async()=>{throw rejection();});
 await r.click();
 assert.equal(r.state.resend?.outcome,'rejected');assert.equal(r.state.editing,true);
 const id=r.sent[0].id;r.tasks=[{id,status:'running'}];
 assert.equal(canResend(r.state),true,'without evidence a typed rejection still allows a deliberate retry');
 assert.equal(canResend(r.state,r.tasks),false);
 assert.equal(prepareResend(r.state,false,nextId,r.tasks).ok,false);
 const view=render(r.state,r.tasks);
 assert.match(view,/Correction sent as a new request and is running/);assert.doesNotMatch(view,/Send as new request|Edit and try again|not accepted/);
 const retry=await r.click();
 assert.equal(!retry.sent&&retry.reason,'already');assert.equal(r.sent.length,1,'no duplicate dispatch');
 const settled=reconcileObserved(r.state,[]);assert.equal(settled,r.state,'reconciling without records changes nothing');
 assert.equal(r.state.draft,'book a table for three','the draft is preserved');
});

test('original status is reported honestly and never changed',()=>{
 const state=accepted();
 assert.equal(originalStatus(state.heard,[{id:'task-original',status:'completed'}]),'Original request is completed.');
 assert.match(originalStatus(state.heard,[]),/was received/);
 assert.equal(originalStatus(null,[]),'');
});

test('panel renders transcript as plain text with keyboard controls and an undo warning',()=>{
 assert.equal(render(emptyCorrection),'');
 const view=render(heard('<img src=x onerror=alert(1)>'));
 assert.ok(!view.includes('<img'));assert.match(view,/&lt;img/);assert.match(view,/<button type="button"[^>]*>.*Correct<\/button>/);
 const editing=render(edited('book a table for three'),[{id:'task-original',status:'running'}]);
 assert.match(editing,/aria-label="Correct what Capri heard"/);assert.match(editing,/not undone/);assert.match(editing,/Original request is running/);
 assert.match(editing,/Ctrl\+Enter/);assert.match(editing,/Esc to cancel/);
 assert.match(render(edited(' ')),/<button class="primary" disabled=""/,'empty correction cannot be sent');
 assert.match(render(heard('call mom',true)),/PRIVATE, NOT SAVED/);
});
