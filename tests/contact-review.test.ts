import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../src/server/store';
import {createService} from '../src/server/service';
import {defaults} from '../src/shared';
import {ContactsService,retainContactJournalAcrossRollback,type ResolvedContact,type ContactChannelPolicy} from '../src/extensions/contacts';
import {defaultExtensionSettings,type ContactIntent,type ContactExactReview} from '../src/extensions/contracts';
import {createExtensionHub} from '../src/extensions/hub';
import {reviewedContactBody,type ContactProvider,type OutboundMessage} from '../src/extensions/contact-providers';
import {sha256} from '../src/extensions/policy';
import {approvalInput,createActionRunner,createContactReviewController,type ExtensionReply,type ExtensionRequest} from '../src/ui/extensions-api';

const signal=()=>new AbortController().signal;
const input=(p:ContactExactReview)=>approvalInput(p);
async function fixture(channel:'sms'|'gmail'|'voice'|'whatsapp'='sms'){
  const directory=await mkdtemp(path.join(os.tmpdir(),'capri-exact-review-')),key=randomBytes(32);
  let store=await new Store(directory,key).init(),now=Date.now(),prepares=0,sends=0,alive=true,epoch=randomUUID(),privateSession=false;
  let onPrepare:(()=>void)|undefined,uncertain=false;
  const message:OutboundMessage={channel,sender:channel==='gmail'?'sender@example.com':channel==='whatsapp'?'whatsapp:+15550000001':'+15550000001',
    recipient:channel==='gmail'?'friend@example.com':channel==='whatsapp'?'whatsapp:+15550000002':'+15550000002',body:'Exact intended content.'};
  if(channel==='gmail')message.subject='Exact subject';
  if(channel==='voice')message.maxVoiceSeconds=45;
  if(channel==='whatsapp')message.whatsapp={contentSid:'HX'+'a'.repeat(32),variables:{'1':'Exact variable'}};
  const policy:ContactChannelPolicy={enabled:true,configured:true,sender:message.sender,optedInRecipientHashes:[sha256(message.recipient)],
    approvedTemplateSids:message.whatsapp?[message.whatsapp.contentSid]:undefined,maxDispatchCostMicros:1,dailyBudgetMicros:100,maxPerDay:100,maxPerMinute:60};
  const settings=defaultExtensionSettings();settings.contacts={enabled:true,automaticEnabled:true};
  const resolved:ResolvedContact={message,channelPolicy:policy,execution:{active:true,localOnly:false},context:{settings,
    route:{id:'route',revision:1,adapter:'fake-contact',recipientId:'friend',recipientSha256:sha256(message.recipient),enabled:true,kind:'contact',
      verification:{method:'user-challenge',recordId:'not-authority',verifiedAt:now-1,expiresAt:now+1000000}},
    workflow:{id:'manual',automatic:false,enabled:true,templateIds:['exact']},template:{id:'exact',version:1,bodySha256:sha256(reviewedContactBody(message)),contentClass:'personal'},
    privateSession:false,containsPrivateContent:false,rules:[],approvals:[]}};
  const intent:ContactIntent={requestId:'exact-request',binding:{routeId:'route',routeRevision:1,recipientId:'friend',recipientSha256:sha256(message.recipient),
    workflowId:'manual',templateId:'exact',templateVersion:1,bodySha256:sha256(reviewedContactBody(message))}};
  const provider:ContactProvider={id:'fake-contact',channel,prepare:async()=>{prepares++;onPrepare?.();return {dispatch:async()=>{sends++;return uncertain?{state:'unconfirmed'}:{state:'accepted',recordId:'receipt-'+sends};}};}};
  const scope=()=>{if(!alive)throw Error('Scope ended');return {authority:'trusted-ui' as const,privacyEpoch:epoch,privateSession};};
  const options={providers:[provider],resolve:async()=>resolved,reviewScope:scope,
    resolveVerification:async()=>{const {verification,...route}=resolved.context.route!;return {route,channel,recipient:message.recipient,channelPolicy:policy,whatsappTemplateSid:message.whatsapp?.contentSid};}};
  const make=()=>new ContactsService({store,clock:()=>now,...options});let service=make();
  const challenge=await service.beginVerification('route'),journal=(await store.get('contact-outbox','main'))!;
  await service.dispatch(challenge.requestId,signal());
  const {verification,...route}=resolved.context.route!;
  resolved.context.route=await service.completeVerification(challenge.challengeId,journal.challenges[0].code,route);
  prepares=0;sends=0;
  return {directory,key,options,resolved,intent,message,policy,provider,make,scope,get epoch(){return epoch;},get store(){return store;},get service(){return service;},
    prepares:()=>prepares,sends:()=>sends,unconfirmed:()=>{uncertain=true;},advance:(ms:number)=>{now+=ms;},private:()=>{privateSession=true;resolved.context.privateSession=true;},
    rotate:()=>{epoch=randomUUID();},end:()=>{alive=false;},onPrepare:(f:()=>void)=>{onPrepare=f;},
    reopen:async()=>{await store.close();store=await new Store(directory,key).init();service=make();},
    cleanup:async()=>{await store.close();await rm(directory,{recursive:true,force:true});}};
}

test('exact review does no provider work or writes; approval consumes the same pending outbox exactly once through restart/rollback',async()=>{
  const f=await fixture(),target=await fixture();try{
    assert.equal((await f.service.enqueue(f.intent)).state,'pending');
    assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'pending');assert.equal(f.prepares(),0);
    const before=await f.store.get('contact-outbox','main'),preview=await f.service.reviewDetails(f.intent.requestId,f.epoch);
    assert.deepEqual(await f.store.get('contact-outbox','main'),before,'preview is a read, not an approval or a private content write');
    assert.equal(preview.destination,f.message.recipient);assert.equal(preview.sender,f.message.sender);assert.equal(preview.content.kind,'message');
    if(preview.content.kind==='message')assert.equal(preview.content.body,f.message.body);
    assert.equal(f.prepares(),0);assert.equal(f.sends(),0);
    const both=await Promise.allSettled([f.service.approve(input(preview)),f.make().approve(input(preview))]);
    assert.equal(both.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.sends(),0,'approval write alone never sends');
    await target.store.put('contact-outbox',before!);
    const receipts=await Promise.all([f.service.dispatch(f.intent.requestId,signal()),f.make().dispatch(f.intent.requestId,signal())]);
    assert.equal(receipts[0].state,'accepted');assert.deepEqual(receipts[0],receipts[1]);assert.equal(f.sends(),1);
    await f.reopen();assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'accepted');assert.equal(f.sends(),1);
    await retainContactJournalAcrossRollback(f.store,target.store);
    assert.equal((await target.service.dispatch(f.intent.requestId,signal())).state,'accepted');assert.equal(target.sends(),0);
    assert.ok(await target.store.get('contact-outbox-approval',preview.reviewId));
    await assert.rejects(f.service.approve(input(preview)));await assert.rejects(f.service.reviewDetails(f.intent.requestId,f.epoch));
    assert.doesNotMatch(JSON.stringify(await f.service.status()),/Exact intended|155500/);
    assert.doesNotMatch(JSON.stringify(await f.store.export()),/Exact intended|155500/);
  }finally{await f.cleanup();await target.cleanup();}
});

test('claimed digest, review ID, revision, body, route and epoch never create approval authority',async()=>{
  const f=await fixture();try{
    await f.service.enqueue(f.intent);
    for(const patch of [{reviewDigest:'f'.repeat(64)},{reviewId:'invented'},{revision:2},{bodySha256:'f'.repeat(64)},
      {routeId:'different'},{routeRevision:2},{privacyEpoch:randomUUID()},{approved:true}]){
      const p=await f.service.reviewDetails(f.intent.requestId,f.epoch);
      await assert.rejects(f.service.approve({...input(p),...patch}));
      assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'pending');
    }
    assert.equal(f.prepares(),0);assert.equal(f.sends(),0);
  }finally{await f.cleanup();}
});

test('an uncertain reviewed send keeps its consumed approval and never reposts after restart or rollback',async()=>{
  const f=await fixture(),target=await fixture();try{
    await f.service.enqueue(f.intent);const before=await f.store.get('contact-outbox','main');
    await target.store.put('contact-outbox',before!);
    const p=await f.service.reviewDetails(f.intent.requestId,f.epoch);await f.service.approve(input(p));f.unconfirmed();
    assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'unconfirmed');assert.equal(f.sends(),1);
    await f.reopen();assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'unconfirmed');
    await retainContactJournalAcrossRollback(f.store,target.store);
    assert.equal((await target.service.dispatch(f.intent.requestId,signal())).state,'unconfirmed');
    assert.ok(await target.store.get('contact-outbox-approval',p.reviewId));
    await assert.rejects(target.service.approve(input(p)));await assert.rejects(f.service.reviewDetails(f.intent.requestId,f.epoch));
    assert.equal(f.sends(),1);assert.equal(target.sends(),0);
  }finally{await f.cleanup();await target.cleanup();}
});

test('Hub keeps the original task waiting for an exact UI approval and Stop cancels receipt observation without resending',async()=>{
  for(const privateSession of [false,true]){
    const f=await fixture();if(privateSession)f.private();
    const hub=await createExtensionHub({store:f.store,clock:Date.now,profile:'self-test',contacts:f.options});
    const controller=new AbortController(),uiController=new AbortController(),epoch=randomUUID();
    const ui=hub.context(()=>({authority:'trusted-ui',privateSession,localOnly:false,signal:uiController.signal,privacyEpoch:epoch}));
    const task=hub.context(()=>({authority:'task',taskId:'task-1',privateSession,localOnly:false,signal:controller.signal,privacyEpoch:randomTaskEpoch}));
    try{
      await hub.dispatch('contacts','configure',{requestId:'enabled',input:{enabled:true}},ui);
      const initial=await hub.dispatch('contacts','send',{requestId:f.intent.requestId,taskId:'task-1',input:f.intent},task);
      assert.equal(initial.outcome,'pending');const waiting=hub.waitContact(initial,task);void waiting.catch(()=>{});
      const p=await hub.contactReview(f.intent.requestId,epoch,ui);assert.equal(f.prepares(),0);
      assert.equal((await hub.dispatch('contacts','approve',{requestId:'approve-ui',input:input(p)},ui)).outcome,'completed');
      const final=await waiting;assert.equal(final.delivery?.requestId,f.intent.requestId);assert.equal(final.delivery?.state,'accepted');assert.equal(f.sends(),1);
      const again={...f.intent,requestId:'stop-pending'};
      const pending=await hub.dispatch('contacts','send',{requestId:again.requestId,taskId:'task-1',input:again},task);
      assert.equal(pending.outcome,'pending');const stopped=hub.waitContact(pending,task);void stopped.catch(()=>{});
      await hub.stop();await assert.rejects(stopped);assert.equal(f.sends(),1);
    }finally{controller.abort();uiController.abort();await hub.close();await f.cleanup();}
  }
});
const randomTaskEpoch=randomUUID();

test('an active UI cannot approve after the original task grant is revoked',async()=>{
  const f=await fixture(),hub=await createExtensionHub({store:f.store,clock:Date.now,profile:'self-test',contacts:f.options});
  const epoch=randomUUID(),grant={taskId:'task-1',request:'Review a manual message',mode:'scoped' as const,createdAt:Date.now()-1,expiresAt:Date.now()+60000,revoked:false,providers:[],workspaceIds:[],allowPaid:false};
  const ui=hub.context(()=>({authority:'trusted-ui',privateSession:false,localOnly:false,signal:signalForUi,privacyEpoch:epoch})),signalForTask=signal();
  const task=hub.context(()=>({authority:'task',taskId:'task-1',grant,privateSession:false,localOnly:false,signal:signalForTask,privacyEpoch:randomTaskEpoch}));
  try{
    await hub.dispatch('contacts','configure',{requestId:'enabled',input:{enabled:true}},ui);
    await hub.dispatch('contacts','send',{requestId:f.intent.requestId,taskId:'task-1',input:f.intent},task);
    const p=await hub.contactReview(f.intent.requestId,epoch,ui);grant.revoked=true;
    assert.equal((await hub.dispatch('contacts','approve',{requestId:'revoked',input:input(p)},ui)).outcome,'rejected');assert.equal(f.prepares(),0);assert.equal(f.sends(),0);
  }finally{await hub.close();await f.cleanup();}
});
const signalForUi=signal();

test('an open UI cannot replace an ended task authority when approving its exact preview',async()=>{
  for(const end of ['release','abort'] as const){
    const f=await fixture(),hub=await createExtensionHub({store:f.store,clock:Date.now,profile:'self-test',contacts:f.options});
    const controller=new AbortController(),epoch=randomUUID(),uiSignal=signal();
    const ui=hub.context(()=>({authority:'trusted-ui',privateSession:false,localOnly:false,signal:uiSignal,privacyEpoch:epoch}));
    const task=hub.context(()=>({authority:'task',taskId:'ended-task',privateSession:false,localOnly:false,signal:controller.signal,privacyEpoch:randomTaskEpoch}));
    try{
      await hub.dispatch('contacts','configure',{requestId:'enabled',input:{enabled:true}},ui);
      const pending=await hub.dispatch('contacts','send',{requestId:f.intent.requestId,taskId:'ended-task',input:f.intent},task);
      assert.equal(pending.outcome,'pending');
      const preview=await hub.contactReview(f.intent.requestId,epoch,ui);
      if(end==='release')hub.releaseContext(task);else controller.abort();
      // The fake resolver still reports active:true. Only the opaque original host
      // context distinguishes an ended task from this still-authenticated UI.
      assert.equal((await hub.dispatch('contacts','approve',{requestId:'ended-approval',input:input(preview)},ui)).outcome,'rejected',end);
      await assert.rejects(hub.contactReview(f.intent.requestId,epoch,ui));
      assert.equal(f.prepares(),0);assert.equal(f.sends(),0);
    }finally{controller.abort();await hub.close();await f.cleanup();}
  }
});

test('UI approval provider preparation inherits cancellation from the original task',async()=>{
  const f=await fixture(),entered=deferred<void>();let providerSignal:AbortSignal|undefined,dispatches=0;
  f.provider.prepare=async(_message,signal)=>{providerSignal=signal;entered.resolve();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));return {dispatch:async()=>{dispatches++;return {state:'accepted',recordId:'never'};}};};
  const hub=await createExtensionHub({store:f.store,clock:Date.now,profile:'self-test',contacts:f.options}),controller=new AbortController(),epoch=randomUUID(),uiSignal=signal();
  const ui=hub.context(()=>({authority:'trusted-ui',privateSession:false,localOnly:false,signal:uiSignal,privacyEpoch:epoch}));
  const task=hub.context(()=>({authority:'task',taskId:'task-cancel',privateSession:false,localOnly:false,signal:controller.signal,privacyEpoch:randomTaskEpoch}));
  try{
    await hub.dispatch('contacts','configure',{requestId:'enabled',input:{enabled:true}},ui);
    await hub.dispatch('contacts','send',{requestId:f.intent.requestId,taskId:'task-cancel',input:f.intent},task);
    const preview=await hub.contactReview(f.intent.requestId,epoch,ui);
    const approving=hub.dispatch('contacts','approve',{requestId:'cancel-approval',input:input(preview)},ui);
    await entered.promise;controller.abort();assert.equal(providerSignal?.aborted,true);await approving;assert.equal(dispatches,0);
  }finally{controller.abort();await hub.close();await f.cleanup();}
});

test('review replacement, expiry, task closure, local-only, route revocation, template edits and privacy boundaries invalidate approval',async()=>{
  for(const change of ['replacement','expiry','closure','local-only','route','template','body','sender','opt-in','budget','epoch','scope'] as const){
    const f=await fixture();try{
      await f.service.enqueue(f.intent);const p=await f.service.reviewDetails(f.intent.requestId,f.epoch);
      if(change==='replacement')await f.service.reviewDetails(f.intent.requestId,f.epoch);
      if(change==='expiry')f.advance(120001);
      if(change==='closure')f.resolved.execution.active=false;
      if(change==='local-only')f.resolved.execution.localOnly=true;
      if(change==='route')f.resolved.context.route!.enabled=false;
      if(change==='template')f.resolved.context.template!.version++;
      if(change==='body')f.message.body='Edited while reviewing';
      if(change==='sender')f.message.sender='+15550000003';
      if(change==='opt-in')f.policy.optedInRecipientHashes=[];
      if(change==='budget')f.policy.dailyBudgetMicros=0;
      if(change==='epoch')f.rotate();if(change==='scope')f.end();
      await assert.rejects(f.service.approve(input(p)),change);assert.equal(f.prepares(),0,change);assert.equal(f.sends(),0,change);
    }finally{await f.cleanup();}
  }
});

test('edits during approval persistence, credential preparation and durable dispatch marker cannot send the reviewed payload',async()=>{
  for(const point of ['approval-write','prepare','dispatch-marker'] as const){const f=await fixture();try{
    await f.service.enqueue(f.intent);const p=await f.service.reviewDetails(f.intent.requestId,f.epoch);
    const put=f.store.put.bind(f.store);let edited=false;
    f.store.put=async(kind,value)=>{const result=await put(kind,value);
      if(!edited&&kind==='contact-outbox'&&value.entries?.some((e:any)=>e.intent.requestId===f.intent.requestId&&
        (point==='approval-write'&&e.exactApproval||point==='dispatch-marker'&&e.phase==='dispatching'))){edited=true;f.message.body='Concurrent edit';}
      return result;};
    if(point==='prepare')f.onPrepare(()=>{f.resolved.context.workflow!.enabled=false;});
    await f.service.approve(input(p));
    assert.notEqual((await f.service.dispatch(f.intent.requestId,signal())).state,'accepted');assert.equal(f.sends(),0);
    await f.reopen();await f.service.dispatch(f.intent.requestId,signal());assert.equal(f.sends(),0);
  }finally{await f.cleanup();}}
});

test('manual private preview requires the live private epoch, while automatic private content and terminal denials remain unavailable',async()=>{
  const f=await fixture();try{
    f.private();await f.service.enqueue(f.intent);
    const p=await f.service.reviewDetails(f.intent.requestId,f.epoch);assert.equal(p.contentClass,'private');
    f.rotate();await assert.rejects(f.service.approve(input(p)));assert.equal(f.sends(),0);
    f.resolved.context.workflow!.automatic=true;
    const automatic={...f.intent,requestId:'private-automatic'};
    assert.equal((await f.service.enqueue(automatic)).state,'rejected');await assert.rejects(f.service.reviewDetails(automatic.requestId,f.epoch));
    f.resolved.context.workflow!.automatic=false;f.resolved.execution.localOnly=true;
    const local={...f.intent,requestId:'local-only'};assert.equal((await f.service.enqueue(local)).state,'rejected');
    f.resolved.execution.localOnly=false;await assert.rejects(f.service.reviewDetails(local.requestId,f.epoch),'a terminal denial cannot be silently revived');
    assert.equal(f.prepares(),0);
  }finally{await f.cleanup();}
});

test('subject and bounded call script are exact; unsupported WhatsApp template detail cannot be approved',async()=>{
  for(const channel of ['gmail','voice','whatsapp'] as const){const f=await fixture(channel);try{
    await f.service.enqueue(f.intent);
    if(channel==='whatsapp')await assert.rejects(f.service.reviewDetails(f.intent.requestId,f.epoch));
    else {const p=await f.service.reviewDetails(f.intent.requestId,f.epoch);
      if(p.content.kind==='call')assert.equal(p.content.maxVoiceSeconds,45);else assert.equal(p.content.subject,'Exact subject');
      await f.service.approve(input(p));assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'accepted');
    }
    assert.equal(f.sends(),channel==='whatsapp'?0:1);
  }finally{await f.cleanup();}}
});

test('authenticated HTTP session/preview/approval round trip uses the original outbox and never logs preview content',async()=>{
  const f=await fixture();let host:Awaited<ReturnType<typeof createService>>|undefined;try{
    await f.store.put('settings',{...defaults,id:'main',providerMode:'local',initiative:false});
    host=await createService({store:f.store,adminToken:'fixture-admin',key:()=>undefined,extensions:{profile:'self-test',contacts:{...f.options,
      availability:async()=>({enabled:true,configured:true,ready:true})}}});
    const headers={authorization:'Bearer fixture-admin'},post=(action:string,input:unknown,id=action)=>host!.app.inject({method:'POST',url:'/v1/extensions/contacts/'+action,headers,payload:{requestId:id,input}});
    await post('configure',{enabled:true},'configure-contacts');
    assert.equal((await post('send',f.intent,f.intent.requestId)).json().outcome,'pending');
    const session=(await host.app.inject({method:'GET',url:'/v1/extensions/session',headers})).json();
    const body={outboxRequestId:f.intent.requestId,privacyEpoch:session.privacyEpoch};
    assert.equal((await host.app.inject({method:'POST',url:'/v1/extensions/contacts/review-details',payload:{requestId:'unauth',input:body}})).statusCode,401);
    assert.equal((await post('review-details',{...body,privacyEpoch:'7'})).statusCode,409);
    const detail=await post('review-details',body);assert.equal(detail.statusCode,200);assert.equal(detail.headers['cache-control'],'no-store');
    const preview=detail.json() as ContactExactReview;assert.equal(f.prepares(),0);assert.equal(preview.privacyEpoch,session.privacyEpoch);
    const approved=await post('approve',input(preview),'approve-once');assert.equal(approved.json().outcome,'completed');assert.equal(approved.json().delivery,undefined,'approval is not a delivery receipt');assert.equal(f.sends(),1);
    assert.deepEqual((await post('approve',input(preview),'approve-once')).json(),approved.json(),'an identical action returns its durable approval receipt');assert.equal(f.sends(),1);
    assert.equal((await post('approve',input(preview),'approve-duplicate')).json().outcome,'rejected');assert.equal(f.sends(),1);
    const overview=(await host.app.inject({method:'GET',url:'/v1/extensions/contacts/outbox',headers})).json();
    assert.equal(overview.outbox.at(-1).receipt.state,'accepted');assert.doesNotMatch(JSON.stringify(overview),/Exact intended|155500/);
    assert.doesNotMatch(JSON.stringify(await f.store.list('extension:hub:request')),/Exact intended|155500/);
  }finally{if(host){await host.app.close();await rm(f.directory,{recursive:true,force:true});}else await f.cleanup();}
});

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
test('UI separates numeric render fence from host UUID and refuses boundaries between the session and preview awaits',async()=>{
  const f=await fixture();try{
    const receipt=await f.service.enqueue(f.intent),p=await f.service.reviewDetails(f.intent.requestId,f.epoch);
    for(const point of ['session','preview','failure','private-mismatch','dispose'] as const){
      const session=deferred<ExtensionReply>(),preview=deferred<ExtensionReply>();let posts=0;
      const request:ExtensionRequest=async method=>method==='GET'?session.promise:(posts++,preview.promise);
      const runner=createActionRunner({request}),controller=createContactReviewController({request,gate:runner.reads,scope:{epoch:7,reviewAllowed:true,approveAllowed:true}});
      const loading=controller.load(receipt);
      if(point==='session')controller.sync({epoch:8,reviewAllowed:true,approveAllowed:true});
      session.resolve(point==='failure'?{ok:false,message:'Unavailable'}:{ok:true,body:{protocol:'capri-private-v1',privacyEpoch:f.epoch,privateSession:point==='private-mismatch',revision:0}});
      await new Promise(r=>setImmediate(r));
      if(point==='preview')controller.sync({epoch:8,reviewAllowed:true,approveAllowed:true});
      if(point==='dispose')controller.close();
      preview.resolve({ok:true,body:p});await loading;
      assert.equal(controller.canApprove(receipt),false,point);assert.equal(controller.current(receipt),undefined,point);
      if(['session','failure','private-mismatch'].includes(point))assert.equal(posts,0,point);
    }
    const request:ExtensionRequest=async method=>method==='GET'?{ok:true,body:{protocol:'capri-private-v1',privacyEpoch:f.epoch,privateSession:false,revision:0}}:{ok:true,body:p};
    const runner=createActionRunner({request}),controller=createContactReviewController({request,gate:runner.reads,scope:{epoch:7,reviewAllowed:true,approveAllowed:true}});
    await controller.load(receipt);assert.equal(controller.current(receipt)?.localEpoch,7);assert.equal(controller.canApprove(receipt),true);
    assert.equal(controller.approve(receipt)?.privacyEpoch,f.epoch);assert.equal(controller.approve(receipt),undefined);
    assert.doesNotMatch(JSON.stringify(runner.log()),/Exact intended|155500/);controller.close();
  }finally{await f.cleanup();}
});
