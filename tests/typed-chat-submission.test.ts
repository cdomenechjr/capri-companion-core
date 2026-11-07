import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChatSubmission} from '../src/ui/ChatSubmission';
import {admitReply, advancePrivacy, chatStatus, claimPrivate, dismissChat, dropPrivateChat, privateGate, showReply, emptyChatSubmission, heldLimit, insertConfirmed, observedChat, prepareChat, reconcileChat, restoreDraft, runChat, settleChat, type ChatRequest, type ChatSubmissionState} from '../src/ui/chat-submission';
import {NotAcceptedError} from '../src/ui/transcript-correction';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};}
const tick=()=>new Promise<void>(r=>setImmediate(r));
const last=(state:ChatSubmissionState)=>state.attempts.at(-1)||null;

/** Renderer stand-in: refs for state, composer and privacy exactly as main.tsx supplies them, plus a deferred fake /v1/chat. */
function session(composer=''){
 let ids=0;
 const s={state:emptyChatSubmission as ChatSubmissionState,composer,private:false,epoch:0,tasks:[] as {id:string;status?:string}[],sent:[] as ChatRequest[],echoed:[] as ChatRequest[],replies:[] as ReturnType<typeof deferred<unknown>>[]};
 const gate=privateGate();
 const api={state:()=>s.state,update:(next:ChatSubmissionState)=>{s.state=next;},privateMode:()=>s.private,epoch:()=>s.epoch,tasks:()=>s.tasks,composer:()=>s.composer,setComposer:(text:string)=>{s.composer=text;},
  send:(request:ChatRequest)=>{s.sent.push(request);const reply=deferred<unknown>();s.replies.push(reply);return reply.promise;},echo:(request:ChatRequest)=>{s.echoed.push(request);},
  claim:(request:ChatRequest,epoch:number)=>claimPrivate(gate,request.id,epoch),newId:()=>'chat-'+(++ids)};
 /** Privacy toggle as main.tsx performs it: every claim is retired synchronously, before voice is stopped; only private attempts are purged. */
 const togglePrivacy=()=>{s.private=!s.private;s.epoch++;advancePrivacy(gate,s.epoch);s.state=dropPrivateChat(s.state);};
 return {s,api,gate,togglePrivacy};
}
/** Event outlets as main.tsx's receive() wires them: speech, caption, ephemeral chat and the floating-view caption. */
function outlets(){
 const seen={spoken:[] as string[],captions:[] as string[],ephemeral:[] as any[],forwarded:[] as string[]};
 const out={speak:(text:string)=>{seen.spoken.push(text);},caption:(text:string)=>{seen.captions.push(text);},ephemeral:(message:any)=>{seen.ephemeral.push(message);},forward:(text:string)=>{seen.forwarded.push(text);}};
 return {seen,out};
}
const privateReply=(taskId:string|undefined,text:string)=>({type:'message',privateSession:true,message:{id:'m-'+taskId,role:'assistant',text,taskId}});
const nothingShown=(seen:ReturnType<typeof outlets>['seen'])=>assert.deepEqual(seen,{spoken:[],captions:[],ephemeral:[],forwarded:[]});
const render=(state:ChatSubmissionState,tasks:{id:string}[]=[])=>renderToStaticMarkup(React.createElement(ChatSubmission,{state,tasks,onRestore(){},onDismiss(){}}));

test('a matching receipt accepts the request; the draft stays pending and visible until then',async()=>{
 const {s,api}=session('book a table for three');
 const run=runChat(api,'book a table for three',true);
 assert.equal(s.sent.length,1);assert.deepEqual(s.sent[0],{id:'chat-1',text:'book a table for three',private:false});
 assert.equal(last(s.state)?.outcome,'pending');assert.equal(last(s.state)?.text,'book a table for three');assert.equal(s.composer,'');
 const pending=render(s.state);assert.match(pending,/SENDING/);assert.match(pending,/book a table for three/);assert.doesNotMatch(pending,/Restore draft/);
 s.replies[0].resolve({id:'chat-1',status:'running'});
 const result=await run;
 assert.equal(result.sent&&result.submission.outcome,'accepted');assert.deepEqual(s.state.attempts,[]);assert.equal(render(s.state),'');assert.deepEqual(s.echoed,[]);
});

test('a mismatched or missing receipt is unconfirmed and keeps the draft, never resubmitting',async()=>{
 for(const receipt of [{id:'someone-else'},{stopped:true},undefined]){
  const {s,api}=session('hello');const run=runChat(api,'hello',true);
  s.replies[0].resolve(receipt);await run;
  assert.equal(last(s.state)?.outcome,'unknown');assert.equal(last(s.state)?.text,'hello');assert.equal(s.sent.length,1);
  const html=render(s.state);assert.match(html,/NOT CONFIRMED/);assert.match(html,/hello/);assert.match(html,/Restore draft/);assert.doesNotMatch(html,/SENDING/);
 }
});

test('transport loss after the service stored the task stays unconfirmed, then an observed record accepts it',async()=>{
 const {s,api}=session('summarise my notes');const run=runChat(api,'summarise my notes',true);
 s.tasks=[{id:'chat-1',status:'running'}];// the service stored it before the connection dropped
 s.replies[0].reject(new TypeError('fetch failed'));
 const result=await run;
 assert.equal(result.sent&&result.submission.outcome,'unknown');
 assert.deepEqual(s.state.attempts,[],'the observed task record proves acceptance');assert.equal(s.sent.length,1);
});

test('an arbitrary service error that sounds like a refusal remains unconfirmed; only typed provenance rejects',async()=>{
 const {s,api}=session('x');let run=runChat(api,'x',true);
 s.replies[0].reject(Error("Error invoking remote method 'capri:request': Error: Connect OpenAI or enable the local model in Settings."));await run;
 assert.equal(last(s.state)?.outcome,'unknown');assert.match(chatStatus(last(s.state)),/could not confirm.*Connect OpenAI/);
 s.state=emptyChatSubmission;run=runChat(api,'y',false);s.replies[1].reject(new NotAcceptedError('Paused by the local guard.'));await run;
 assert.equal(last(s.state)?.outcome,'rejected');assert.match(render(s.state),/NOT SENT/);assert.match(chatStatus(last(s.state)),/Paused by the local guard/);
});

test('observed-record reconciliation settles a pending or unconfirmed attempt only for the captured id',async()=>{
 const {s,api}=session('');const run=runChat(api,'hello',false);
 assert.deepEqual(observedChat(s.state,[{id:'other'}]),[]);assert.equal(reconcileChat(s.state,[{id:'other'}]),s.state);
 assert.deepEqual(observedChat(s.state,[{id:'chat-1'}]).map(a=>a.id),['chat-1']);
 assert.equal(render(s.state,[{id:'chat-1'}]),'','an observed record hides the pending notice');
 // main.tsx reconciles on observation while pending; the late receipt then cannot reopen anything.
 s.state=reconcileChat(s.state,[{id:'chat-1'}]);s.replies[0].resolve({id:'chat-1'});const result=await run;
 assert.equal(result.sent&&result.current,false);assert.deepEqual(s.state.attempts,[]);
 const unknown=settleChat(prepareChat(emptyChatSubmission,'a',false,0,[],()=>'u-1').state,'u-1',{outcome:'unknown',error:'lost'});
 assert.equal(observedChat(unknown,[{id:'u-1'}])[0]?.outcome,'unknown');assert.equal(prepareChat(unknown,'a',false,0,[{id:'u-1'}]).ok,true,'observed acceptance releases the duplicate guard');
});

test('rapid duplicate clicks are refused synchronously while pending, and a same-text resend after an unconfirmed result is refused',async()=>{
 const {s,api}=session('');
 const first=runChat(api,'Plan my next move',false);const second=runChat(api,'Plan my next move',false);const third=runChat(api,'something else',false);
 assert.deepEqual(await second,{sent:false,reason:'pending'});assert.deepEqual(await third,{sent:false,reason:'pending'});assert.equal(s.sent.length,1);
 s.replies[0].reject(new TypeError('fetch failed'));await first;
 assert.deepEqual(await runChat(api,'  Plan my  next move ',false),{sent:false,reason:'unknown'});assert.equal(s.sent.length,1);
 assert.deepEqual(await runChat(api,'   ',true),{sent:false,reason:'empty'});
 assert.equal(s.sent.length,1,'nothing is ever resubmitted automatically');
});

test('sending different text after an unconfirmed result keeps the earlier draft until it is accepted or dismissed',async()=>{
 const {s,api}=session('draft A');
 const a=runChat(api,'draft A',true);assert.equal(s.composer,'','the composer no longer holds A');
 s.replies[0].reject(new TypeError('fetch failed'));await a;
 s.composer='draft B';const b=runChat(api,'draft B',true);
 assert.deepEqual(s.state.attempts.map(x=>[x.text,x.outcome]),[['draft A','unknown'],['draft B','pending']],'A is retained while B is pending');
 let html=render(s.state);assert.match(html,/draft A/);assert.match(html,/NOT CONFIRMED/);assert.match(html,/draft B/);assert.match(html,/SENDING/);
 s.replies[1].resolve({id:'chat-2'});await b;
 assert.deepEqual(s.state.attempts.map(x=>[x.text,x.outcome]),[['draft A','unknown']],'accepting B does not release A');
 html=render(s.state);assert.match(html,/draft A/);assert.match(html,/Restore draft/);
 // A later rejection of C also leaves A in place; only explicit disposition removes one.
 const c=runChat(api,'draft C',false);s.replies[2].reject(new NotAcceptedError('Paused.'));await c;
 assert.deepEqual(s.state.attempts.map(x=>[x.id,x.outcome]),[['chat-1','unknown'],['chat-3','rejected']]);
 assert.equal(dismissChat(s.state,'chat-2'),s.state,'an unknown id changes nothing');
 s.state=dismissChat(s.state,'chat-1');assert.deepEqual(s.state.attempts.map(x=>x.id),['chat-3']);
 assert.equal(s.sent.length,3,'nothing was resent');
 // A pending attempt cannot be dismissed away.
 const d=runChat(api,'draft D',false);assert.equal(dismissChat(s.state,'chat-4'),s.state);s.replies[3].resolve({id:'chat-4'});await d;
});

test('unresolved drafts are bounded by explicit disposition rather than silently dropped',async()=>{
 const {s,api}=session('');
 for(let i=0;i<heldLimit;i++){const run=runChat(api,'note '+i,false);s.replies[i].reject(new TypeError('fetch failed'));await run;}
 assert.equal(s.state.attempts.length,heldLimit);
 assert.deepEqual(await runChat(api,'one more',false),{sent:false,reason:'full'});assert.equal(s.sent.length,heldLimit);
 assert.equal(s.state.attempts.length,heldLimit,'no retained draft was replaced');
 s.state=dismissChat(s.state,'chat-1');const next=runChat(api,'one more',false);assert.equal(s.sent.length,heldLimit+1);s.replies[heldLimit].resolve({id:'chat-'+(heldLimit+1)});await next;
});

test('text typed while a request is pending is preserved, and suggestions never touch the composer',async()=>{
 const {s,api}=session('first message');const run=runChat(api,'first message',true);
 assert.equal(s.composer,'');s.composer='second thought';
 s.replies[0].reject(new TypeError('fetch failed'));await run;
 assert.equal(s.composer,'second thought','a failed request does not overwrite newer text');
 assert.equal(restoreDraft(s.composer,last(s.state)!.text),'second thought\nfirst message');assert.equal(restoreDraft('','first message'),'first message');
 const other=session('my own draft');const suggestion=runChat(other.api,'Let’s make something',false);
 assert.equal(other.s.composer,'my own draft');other.s.replies[0].resolve({id:'chat-1'});await suggestion;assert.equal(other.s.composer,'my own draft');
 const edited=session('abc');const edit=runChat(edited.api,'abc',true);edited.s.replies[0].resolve({id:'chat-1'});await edit;assert.equal(edited.s.composer,'');
});

test('privacy is captured per request; a privacy change clears private state and a late reply cannot restore it',async()=>{
 const {s,api,togglePrivacy}=session('');togglePrivacy();
 const run=runChat(api,'my secret',true);assert.equal(s.sent[0].private,true);assert.match(render(s.state),/PRIVATE, NOT SAVED/);
 togglePrivacy();assert.deepEqual(s.state.attempts,[]);
 s.replies[0].reject(new TypeError('fetch failed'));const result=await run;
 assert.equal(result.sent&&result.current,false);assert.deepEqual(s.state.attempts,[]);assert.deepEqual(s.echoed,[]);assert.equal(s.composer,'');
 // Off and on again: same privacy mode, different epoch, so a late receipt still cannot echo the private text.
 const again=session('');again.togglePrivacy();const late=runChat(again.api,'another secret',true);again.togglePrivacy();again.togglePrivacy();
 again.s.replies[0].resolve({id:'chat-1'});const lateResult=await late;assert.equal(lateResult.sent&&lateResult.current,false);assert.deepEqual(again.s.echoed,[]);assert.deepEqual(again.s.state.attempts,[]);
});

test('a history request pending across a privacy toggle settles against its own id and stays recoverable',async()=>{
 const {s,api,togglePrivacy}=session('book the dentist');
 const run=runChat(api,'book the dentist',true);assert.equal(s.sent[0].private,false);
 togglePrivacy();assert.equal(s.private,true);
 assert.deepEqual(s.state.attempts.map(a=>[a.id,a.outcome,a.private]),[['chat-1','pending',false]],'the pending history draft survives the toggle');
 s.replies[0].reject(Error('Request refused by the service.'));const result=await run;
 assert.equal(result.sent&&result.current,true,'it settles even though the current privacy mode differs');
 assert.deepEqual(s.state.attempts.map(a=>[a.id,a.outcome,a.text]),[['chat-1','unknown','book the dentist']],'a generic error without an observed task stays unconfirmed');
 assert.deepEqual(s.echoed,[],'a history request is never echoed into the private conversation');
 const html=render(s.state);assert.match(html,/NOT CONFIRMED/);assert.match(html,/book the dentist/);assert.match(html,/Restore draft/);assert.match(html,/Dismiss/);assert.doesNotMatch(html,/PRIVATE/);
 assert.equal(restoreDraft(s.composer,s.state.attempts[0].text),'book the dentist');
 togglePrivacy();togglePrivacy();assert.deepEqual(s.state.attempts.map(a=>a.id),['chat-1'],'still retained through off/on');
 s.state=dismissChat(s.state,'chat-1');assert.deepEqual(s.state.attempts,[]);assert.equal(s.sent.length,1,'never resubmitted');
});

test('rejected and unknown history drafts survive toggles; a public receipt releases only its draft; old private outcomes stay discarded',async()=>{
 const {s,api,gate,togglePrivacy}=session('');
 let run=runChat(api,'draft A',false);s.replies[0].reject(new TypeError('fetch failed'));await run;
 run=runChat(api,'draft B',false);s.replies[1].reject(new NotAcceptedError('Paused.'));await run;
 togglePrivacy();
 const secret=runChat(api,'private C',false);assert.equal(s.sent[2].private,true);
 assert.deepEqual(s.state.attempts.map(a=>[a.id,a.outcome]),[['chat-1','unknown'],['chat-2','rejected'],['chat-3','pending']]);
 togglePrivacy();
 assert.deepEqual(s.state.attempts.map(a=>[a.id,a.outcome]),[['chat-1','unknown'],['chat-2','rejected']],'only the private attempt is purged');
 // The old private request fails late and its reply arrives: nothing is restored, shown or spoken.
 s.replies[2].reject(new NotAcceptedError('Paused.'));const secretResult=await secret;
 assert.equal(secretResult.sent&&secretResult.current,false);assert.equal(s.state.attempts.some(a=>a.private),false);assert.deepEqual(s.echoed,[]);
 const {seen,out}=outlets();togglePrivacy();
 assert.equal(showReply(gate,privateReply('chat-3','private answer'),{privateMode:s.private,floating:false},out),false);nothingShown(seen);
 assert.deepEqual(s.state.attempts.map(a=>a.id),['chat-1','chat-2'],'history drafts remain after off/on');
 // A new history request sent while private is off accepts on a matching receipt and releases only itself.
 togglePrivacy();const d=runChat(api,'draft D',false);togglePrivacy();
 assert.deepEqual(s.state.attempts.map(a=>[a.id,a.outcome]),[['chat-1','unknown'],['chat-2','rejected'],['chat-4','pending']]);
 s.replies[3].resolve({id:'chat-4'});const dResult=await d;
 assert.equal(dResult.sent&&dResult.submission.outcome,'accepted');assert.deepEqual(s.state.attempts.map(a=>a.id),['chat-1','chat-2']);assert.deepEqual(s.echoed,[]);
 assert.equal(s.sent.length,4,'nothing was resent');
});

test('an accepted private request is echoed once to the ephemeral chat; a saved-history request is not',async()=>{
 const {s,api,togglePrivacy}=session('');togglePrivacy();
 const run=runChat(api,'just between us',false);await tick();assert.deepEqual(s.echoed,[],'nothing is shown as sent before the receipt');
 s.replies[0].resolve({id:'chat-1'});await run;assert.deepEqual(s.echoed,[{id:'chat-1',text:'just between us',private:true}]);
 const saved=session('');const plain=runChat(saved.api,'remember this',false);saved.s.replies[0].resolve({id:'chat-1'});await plain;assert.deepEqual(saved.s.echoed,[]);
});

test('a private reply that arrives before the receipt is shown after the confirmed user message',async()=>{
 // Ephemeral chat as main.tsx keeps it: private 'message' events append; echo inserts the confirmed request.
 let ephemeral:any[]=[{id:'earlier-user',role:'user',text:'hi',taskId:'chat-0'},{id:'earlier-reply',role:'assistant',text:'hey',taskId:'chat-0'}];
 const {s,api,togglePrivacy}=session('');togglePrivacy();
 api.echo=(request:ChatRequest)=>{s.echoed.push(request);ephemeral=insertConfirmed(ephemeral,request);};
 const run=runChat(api,'switch to local',false);
 ephemeral=[...ephemeral,{id:'reply-1',role:'assistant',text:'Switched to the local model.',taskId:'chat-1'}];// the provider-switch reply is emitted first
 assert.equal(ephemeral.some(m=>m.role==='user'&&m.taskId==='chat-1'),false,'not shown as sent before the receipt');
 s.replies[0].resolve({id:'chat-1'});await run;
 assert.deepEqual(ephemeral.map(m=>m.role+':'+m.text),['user:hi','assistant:hey','user:switch to local','assistant:Switched to the local model.']);
 assert.equal(insertConfirmed(ephemeral,s.sent[0]),ephemeral,'a second confirmation (receipt then observed record) does not duplicate it');
 // Without an earlier reply the confirmed message is appended.
 assert.deepEqual(insertConfirmed([],{id:'x',text:'t',private:true}),[{id:'x',role:'user',text:'t',taskId:'x'}]);
});

test('a private reply from before a privacy off/on change is never displayed, spoken or forwarded',async()=>{
 const {s,api,gate,togglePrivacy}=session('my secret plan');togglePrivacy();
 const view=()=>({privateMode:s.private,floating:false});
 const run=runChat(api,'my secret plan',true);assert.equal(s.sent[0].private,true);
 togglePrivacy();togglePrivacy();assert.equal(s.private,true,'private again, but in a newer epoch');
 // The deferred service now emits the old reply, then the old receipt arrives.
 const {seen,out}=outlets();
 assert.equal(admitReply(gate,privateReply('chat-1','Here is your secret plan.'),view()),false,'deliver() drops it before attention or routing');
 assert.equal(showReply(gate,privateReply('chat-1','Here is your secret plan.'),view(),out),false);
 nothingShown(seen);
 s.replies[0].resolve({id:'chat-1'});const result=await run;
 assert.equal(result.sent&&result.current,false);assert.deepEqual(s.echoed,[]);assert.deepEqual(s.state.attempts,[]);assert.equal(s.composer,'','the private text is not restored');
 // A late claim of the retired id, even under the current epoch, cannot bring it back.
 assert.equal(claimPrivate(gate,'chat-1',gate.epoch),false);
 assert.equal(showReply(gate,privateReply('chat-1','Here is your secret plan.'),view(),out),false);nothingShown(seen);
 // A request captured in the current epoch is still shown and spoken, once its reply arrives.
 const next=runChat(api,'new question',false);
 assert.equal(showReply(gate,privateReply('chat-2','New answer.'),view(),out),true);
 assert.deepEqual(seen.spoken,['New answer.']);assert.deepEqual(seen.captions,['New answer.']);assert.deepEqual(seen.forwarded,['New answer.']);assert.deepEqual(seen.ephemeral.map(m=>m.taskId),['chat-2']);
 // A duplicate delivery of the same reply is not shown or spoken again.
 assert.equal(admitReply(gate,privateReply('chat-2','New answer.'),view()),false);
 assert.equal(showReply(gate,privateReply('chat-2','New answer.'),view(),out),false);assert.deepEqual(seen.spoken,['New answer.']);
 s.replies[1].resolve({id:'chat-2'});await next;assert.deepEqual((s.echoed as ChatRequest[]).map(r=>r.id),['chat-2']);
});

test('a private reply is dropped after privacy is turned off, and late claims from an old epoch are ignored',async()=>{
 const {s,api,gate,togglePrivacy}=session('');togglePrivacy();
 const run=runChat(api,'private thing',false);togglePrivacy();assert.equal(s.private,false);
 const {seen,out}=outlets();
 assert.equal(showReply(gate,privateReply('chat-1','private answer'),{privateMode:false,floating:false},out),false);nothingShown(seen);
 assert.equal(claimPrivate(gate,'late-old',0),false);assert.equal(gate.current.has('late-old'),false,'a claim captured under an earlier epoch is not recorded');
 s.replies[0].resolve({id:'chat-1'});await run;assert.deepEqual(s.echoed,[]);
});

test('unknown or foreign private replies are guarded conservatively; normal history messages are unchanged',()=>{
 const {gate,togglePrivacy}=session('');togglePrivacy();
 const view={privateMode:true,floating:false};
 const {seen,out}=outlets();
 for(const event of [privateReply('foreign-task','from another session'),privateReply(undefined,'no task id'),privateReply('','empty id')])
  assert.equal(showReply(gate,event,view,out),false);
 nothingShown(seen);
 // Voice claims its ids through the same ledger before dispatch; only those are admitted.
 assert.equal(claimPrivate(gate,'voice-1',gate.epoch),true);
 assert.equal(showReply(gate,privateReply('voice-1','voice answer'),view,out),true);
 assert.deepEqual(seen.spoken,['voice answer']);
 // Claims outstanding at a privacy change are retired with it.
 claimPrivate(gate,'voice-2',gate.epoch);togglePrivacy();togglePrivacy();
 assert.equal(showReply(gate,privateReply('voice-2','old voice answer'),view,out),false);assert.deepEqual(seen.spoken,['voice answer']);
 // The floating view cannot verify the epoch, so it relies on the caption forwarded by the main window.
 claimPrivate(gate,'current-1',gate.epoch);
 assert.equal(showReply(gate,privateReply('current-1','answer'),{...view,floating:true},{caption:text=>seen.captions.push('floating:'+text),ephemeral(){}}),false);
 assert.equal(seen.captions.includes('floating:answer'),false);
 // Saved-history messages behave as before in every view.
 const saved={type:'message',message:{id:'m',role:'assistant',text:'saved answer',taskId:'t'}};
 const plain=outlets();
 assert.equal(showReply(gate,saved,{privateMode:false,floating:false},plain.out),true);
 assert.equal(showReply(gate,saved,{privateMode:false,floating:true},{caption:plain.out.caption,ephemeral:plain.out.ephemeral}),true);
 assert.deepEqual(plain.seen,{spoken:['saved answer'],captions:['saved answer','saved answer'],ephemeral:[],forwarded:[]});
});
