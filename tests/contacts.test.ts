import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/server/store';
import {ActionReceiptSchema,defaultExtensionSettings,type ContactIntent,type ExtensionDependencies} from '../src/extensions/contracts';
import {sha256} from '../src/extensions/policy';
import {ContactsService,createContactsModule,retainContactJournalAcrossRollback,type ResolvedContact,type ContactChannelPolicy} from '../src/extensions/contacts';
import {reviewedContactBody,type ContactProvider,type OutboundMessage,type ProviderObservation} from '../src/extensions/contact-providers';

async function fixture(options:{verified?:boolean;kind?:'self'|'contact'}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'capri-contact-')),key=randomBytes(32);
  let store=await new Store(directory,key).init(),now=1_800_000_000_000,sends=0,prepares=0;
  let observe:ProviderObservation={state:'delivered',recordId:'remote-1'},result:ProviderObservation={state:'accepted',recordId:'remote-1'};
  let onDispatch:(()=>Promise<void>)|undefined,onPrepare:(()=>Promise<void>)|undefined;
  const message:OutboundMessage={channel:'sms',sender:'+15550000001',recipient:'+15550000002',body:'A reviewed alert.'};
  const p:ContactChannelPolicy={enabled:true,configured:true,sender:message.sender,optedInRecipientHashes:[sha256(message.recipient)],maxDispatchCostMicros:100,dailyBudgetMicros:200,maxPerMinute:2,maxPerDay:2};
  const settings=defaultExtensionSettings();settings.contacts={enabled:true,automaticEnabled:true};
  const resolved:ResolvedContact={message,channelPolicy:p,execution:{active:true,localOnly:false},context:{settings,
    route:{id:'route',revision:1,adapter:'fake-sms',recipientId:'recipient',recipientSha256:sha256(message.recipient),kind:options.kind??'self',enabled:true,
      verification:{method:'user-challenge',recordId:'proof',verifiedAt:now-1000,expiresAt:now+86400000}},
    workflow:{id:'workflow',automatic:true,enabled:true,templateIds:['template']},template:{id:'template',version:1,bodySha256:sha256(reviewedContactBody(message)),contentClass:'personal'},
    privateSession:false,containsPrivateContent:false,rules:[],approvals:[]}};
  const intent:ContactIntent={requestId:'request-1',binding:{routeId:'route',routeRevision:1,recipientId:'recipient',recipientSha256:sha256(message.recipient),workflowId:'workflow',templateId:'template',templateVersion:1,bodySha256:sha256(reviewedContactBody(message))}};
  const provider:ContactProvider={id:'fake-sms',channel:'sms',prepare:async(m)=>{prepares++;assert.equal(m.recipient,message.recipient);await onPrepare?.();return {dispatch:async()=>{sends++;await onDispatch?.();return result;}};},observe:async()=>observe};
  const make=()=>new ContactsService({store,clock:()=>now,providers:[provider],resolve:async()=>resolved,
    resolveVerification:async()=>{const {verification,...route}=resolved.context.route!;return {route,channel:'sms',recipient:message.recipient,channelPolicy:p};}});
  let service=make();
  if(options.verified!==false){
    // All send fixtures earn their proof through the same fake-provider round trip as the UI.
    const challenge=await service.beginVerification('route');
    const journal=await store.get('contact-outbox','main'),code=journal!.challenges[0].code;
    assert.equal((await service.dispatch(challenge.requestId,new AbortController().signal)).state,'accepted');
    const {verification,...route}=resolved.context.route!;
    resolved.context.route=await service.completeVerification(challenge.challengeId,code,route);
    // Leave the dispatch tombstone intact while moving beyond its rate/budget window.
    now+=86400001;sends=0;prepares=0;
  }
  return {directory,key,message,p,resolved,intent,provider,get store(){return store;},get service(){return service;},make,
    now:()=>now,advance:(n:number)=>{now+=n;},sends:()=>sends,prepares:()=>prepares,
    result:(r:ProviderObservation)=>{result=r;},observe:(r:ProviderObservation)=>{observe=r;},onDispatch:(f:()=>Promise<void>)=>{onDispatch=f;},onPrepare:(f:()=>Promise<void>)=>{onPrepare=f;},
    reopen:async()=>{await store.close();store=await new Store(directory,key).init();service=make();},
    cleanup:async()=>{await store.close();await rm(directory,{recursive:true,force:true});}};
}
const signal=()=>new AbortController().signal;

/** Inspect the exact JSON Store would encrypt, without 10,000 SQLite file rewrites per fixture. */
function inspectingStore(){
  const records=new Map<string,any>();let beforeWrite:((kind:string,value:any)=>void)|undefined;
  return {records,onWrite:(f:(kind:string,value:any)=>void)=>{beforeWrite=f;},
    get:async(kind:string,id:string)=>{const r=records.get(kind+':'+id);return r?structuredClone(r):undefined;},
    put:async(kind:string,value:any)=>{const copy=JSON.parse(JSON.stringify(value));beforeWrite?.(kind,copy);records.set(kind+':'+value.id,copy);return structuredClone(copy);}};
}

test('encrypted outbox persists receipts and deduplicates across instances and reopen',async()=>{
  const f=await fixture();try{
    const queued=await f.service.enqueue(f.intent);assert.equal(queued.state,'pending');assert.equal(f.sends(),0);
    const receipts=await Promise.all([f.service.dispatch(f.intent.requestId,signal()),f.make().dispatch(f.intent.requestId,signal())]);
    assert.deepEqual(receipts[0],receipts[1]);assert.equal(receipts[0].state,'accepted');assert.equal(f.sends(),1);
    await f.reopen();assert.equal((await f.service.enqueue(f.intent)).state,'accepted');await f.service.dispatch(f.intent.requestId,signal());assert.equal(f.sends(),1);
    const bytes=await readFile(path.join(f.directory,'capri.sqlite'));assert.equal(bytes.includes(Buffer.from(f.message.body)),false);assert.equal(bytes.includes(Buffer.from(f.message.recipient)),false);
    assert.equal(JSON.stringify(await f.service.status()).includes(f.message.recipient),false);
    assert.equal(JSON.stringify(await f.store.export()).includes(f.message.body),false);
    assert.equal((await f.service.reconcile(f.intent.requestId,signal()))?.state,'delivered');assert.equal(f.sends(),1);
  }finally{await f.cleanup();}
});

test('tool overrides cannot inject approval, destination, body or private classification',async()=>{
  const f=await fixture();try{
    for(const extra of [{approved:true},{recipient:'+15550000003'},{privateSession:false},{body:'unreviewed'},{rules:[{approved:true}]}])
      await assert.rejects(f.service.enqueue({...f.intent,...extra}));
    f.resolved.context.privateSession=true;
    assert.equal((await f.service.enqueue(f.intent)).state,'rejected');assert.equal(f.sends(),0);
    assert.equal((await f.service.get(f.intent.requestId))?.evidence.source,'trusted-pre-dispatch');
  }finally{await f.cleanup();}
});

test('server-owned local-only restriction and inactive task deny remote dispatch despite conversation/provider readiness',async()=>{
  for(const restriction of ['localOnly','active'] as const){const f=await fixture();try{
    await f.service.enqueue(f.intent);f.resolved.execution[restriction]=restriction==='localOnly';
    assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'rejected');assert.equal(f.sends(),0);
  }finally{await f.cleanup();}}
});

test('definite enqueue denials preserve rejected drafts and reconcile without provider preparation or sending',async()=>{
  for(const mode of ['local','inactive','disabled','unconfigured','opt-in','budget','sender','route-hash','template-hash','resolver'] as const){
    const f=await fixture();try{
      if(mode==='local')f.resolved.execution.localOnly=true;
      if(mode==='inactive')f.resolved.execution.active=false;
      if(mode==='disabled')f.p.enabled=false;
      if(mode==='unconfigured')f.p.configured=false;
      if(mode==='opt-in')f.p.optedInRecipientHashes=[];
      if(mode==='budget')f.p.dailyBudgetMicros=0;
      if(mode==='sender')f.p.sender='+15550000003';
      if(mode==='route-hash')f.resolved.context.route!.recipientSha256=sha256('different');
      if(mode==='template-hash')f.resolved.context.template!.bodySha256=sha256('different');
      const service=mode==='resolver'?new ContactsService({store:f.store,clock:f.now,providers:[f.provider],resolve:async()=>{throw Error('private secret');}}):f.service;
      const rejected=await service.enqueue(f.intent);
      assert.equal(rejected.state,'rejected',mode);assert.equal(rejected.evidence.source,'trusted-pre-dispatch',mode);
      assert.deepEqual(await service.reconcile(f.intent.requestId,signal()),rejected,mode);
      const entry=(await f.store.get('contact-outbox','main'))!.entries.find((e:any)=>e.intent.requestId===f.intent.requestId);
      assert.equal(entry.reservedAt,undefined);assert.equal(entry.phase,'final');
      if(mode!=='resolver')assert.equal(entry.draft.body,f.message.body,mode);
      await f.reopen();assert.deepEqual(await f.service.enqueue(f.intent),rejected,mode);
      assert.deepEqual(await f.service.dispatch(f.intent.requestId,signal()),rejected,mode);
      assert.equal(f.prepares(),0,mode);assert.equal(f.sends(),0,mode);
      assert.doesNotMatch(JSON.stringify(rejected),/private secret|155500/);
    }finally{await f.cleanup();}
  }
});

test('fabricated host verification and code-send alone cannot authorize ordinary content',async()=>{
  const f=await fixture({verified:false});try{
    assert.equal((await f.service.enqueue(f.intent)).state,'rejected');
    f.resolved.context.route!.verification.method='adapter-identity';
    const fabricated={...f.intent,requestId:'fabricated-adapter'};
    assert.equal((await f.service.enqueue(fabricated)).state,'rejected');assert.equal(f.sends(),0);
    const challenge=await f.service.beginVerification('route');
    const j=await f.store.get('contact-outbox','main'),code=j!.challenges[0].code;
    await f.service.dispatch(challenge.requestId,signal());assert.equal(f.sends(),1);
    const beforeRoundTrip={...f.intent,requestId:'code-only'};
    const rejected=await f.service.enqueue(beforeRoundTrip);
    assert.equal(rejected.state,'rejected');assert.equal(rejected.evidence.source==='trusted-pre-dispatch'&&rejected.evidence.code,'unverified-route');
    const {verification,...route}=f.resolved.context.route!;
    f.resolved.context.route=await f.service.completeVerification(challenge.challengeId,code,route);
    await f.reopen();
    const verified={...f.intent,requestId:'verified-send'};
    assert.equal((await f.service.enqueue(verified)).state,'pending');
    assert.equal((await f.service.dispatch(verified.requestId,signal())).state,'accepted');assert.equal(f.sends(),2);
  }finally{await f.cleanup();}
});

test('dispatch checks durable verification identity and expiry again, including after prepare',async()=>{
  for(const mode of ['identity','revision','adapter','expired','prepare-expiry'] as const){
    const f=await fixture();try{
      await f.service.enqueue(f.intent);
      if(mode==='identity')f.resolved.context.route!.recipientId='other';
      if(mode==='revision')f.resolved.context.route!.revision++;
      if(mode==='adapter')f.resolved.context.route!.adapter='other';
      if(mode==='expired'){
        f.advance(30*86400000);
        // A host claim cannot extend the service's proof lifetime.
        f.resolved.context.route!.verification.expiresAt=f.now()+86400000;
      }
      if(mode==='prepare-expiry')f.onPrepare(async()=>{f.advance(30*86400000);});
      assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'rejected',mode);assert.equal(f.sends(),0,mode);
    }finally{await f.cleanup();}
  }
});

test('retention reclaims a full denial ledger while preserving every reservation and uncertain dispatch',async()=>{
  const f=await fixture();try{
    await f.service.enqueue(f.intent);await f.service.dispatch(f.intent.requestId,signal());
    f.result({state:'unconfirmed'});
    const unknown={...f.intent,requestId:'unknown'};await f.service.enqueue(unknown);await f.service.dispatch(unknown.requestId,signal());
    const cancelled={...f.intent,requestId:'cancelled'};await f.service.enqueue(cancelled);await f.service.cancel(cancelled.requestId);
    const j=(await f.store.get('contact-outbox','main'))!;
    const denial=j.entries.find((e:any)=>e.intent.requestId===cancelled.requestId);
    const reserved=j.entries.filter((e:any)=>e.reservedAt!==undefined);
    j.entries=[...reserved,...Array.from({length:10000-reserved.length},(_,i)=>({
      ...structuredClone(denial),intent:{...denial.intent,requestId:'denial-'+i},receipt:{...denial.receipt,requestId:'denial-'+i},
    }))];
    const store=inspectingStore();await store.put('contact-outbox',j);f.advance(8*86400000);
    const service=new ContactsService({store,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
    assert.equal((await service.get(f.intent.requestId))?.state,'accepted');
    assert.equal((await service.get(unknown.requestId))?.state,'unconfirmed');
    const retained=(await store.get('contact-outbox','main'))!.entries;
    assert.ok(retained.length<10000);assert.ok(retained.every((e:any)=>e.draft===undefined));
    assert.equal((await service.get('denial-0'))?.state,'rejected');
    assert.ok((await store.get('contact-outbox-receipt',unknown.requestId))?.entry.reservedAt!==undefined);
    await service.dispatch(unknown.requestId,signal());assert.equal(f.sends(),2);
    f.result({state:'accepted',recordId:'remote-2'});
    const next={...f.intent,requestId:'after-retention'};
    assert.equal((await service.enqueue(next)).state,'pending');
    assert.equal((await service.dispatch(next.requestId,signal())).state,'accepted');assert.equal(f.sends(),3);
    const challenge=await f.service.beginVerification('route');assert.ok(challenge.challengeId);
  }finally{await f.cleanup();}
});

test('rollback carry-forward retains receipts, reservations and one-use approvals rather than reviving an older queue',async()=>{
  const f=await fixture(),rollback=await fixture();try{
    await f.service.enqueue(f.intent);const before=await f.store.get('contact-outbox','main');await rollback.store.put('contact-outbox',before);
    f.resolved.context.containsPrivateContent=true;f.resolved.context.workflow!.automatic=false;
    f.resolved.context.approvals=[{id:'approval',requestId:f.intent.requestId,binding:f.intent.binding,createdAt:f.now()-1,expiresAt:f.now()+10000,revoked:false}];
    assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'accepted');
    await retainContactJournalAcrossRollback(f.store,rollback.store);
    assert.equal((await rollback.service.dispatch(f.intent.requestId,signal())).state,'accepted');assert.equal(rollback.sends(),0);
    const restored=await rollback.store.get('contact-outbox','main');assert.equal(restored?.entries.find((e:any)=>e.intent.requestId===f.intent.requestId).reservedCost,100);assert.deepEqual(restored?.consumedApprovals,[]);
    assert.equal((await rollback.store.get('contact-outbox-approval','approval'))?.expiresAt,f.now()+10000);
  }finally{await f.cleanup();await rollback.cleanup();}
});

test('private automatic content denies even an exact rule/approval; private manual requires a live request approval',async()=>{
  const f=await fixture();try{
    f.resolved.context.containsPrivateContent=true;
    const approval={id:'approval',requestId:f.intent.requestId,binding:f.intent.binding,createdAt:f.now()-100,expiresAt:f.now()+1000,revoked:false};
    f.resolved.context.rules=[approval];f.resolved.context.approvals=[approval];
    assert.equal((await f.service.enqueue(f.intent)).state,'rejected');
    const next={...f.intent,requestId:'manual'};f.resolved.context.workflow!.automatic=false;
    assert.equal((await f.service.enqueue(next)).state,'rejected');
    const approved={...next,requestId:'approved'};approval.requestId='approved';
    assert.equal((await f.service.enqueue(approved)).state,'pending');assert.equal((await f.service.dispatch('approved',signal())).state,'accepted');
    assert.deepEqual((await f.store.get('contact-outbox','main'))?.consumedApprovals,[]);
    assert.equal((await f.store.get('contact-outbox-approval','approval'))?.expiresAt,approval.expiresAt);
  }finally{await f.cleanup();}
});

test('automatic contact rules are exact, live, and cannot be replaced with model-injected declarations',async()=>{
  for(const mode of ['exact','body','recipient','future','expired','injected'] as const){const f=await fixture({kind:'contact'});try{
    const rule={id:'rule',binding:structuredClone(f.intent.binding),createdAt:f.now()-100,expiresAt:f.now()+10000,revoked:false};
    if(mode==='body')rule.binding.bodySha256=sha256('another body');
    if(mode==='recipient')rule.binding.recipientSha256=sha256('+15550000003');
    if(mode==='future')rule.createdAt=f.now()+1;
    if(mode==='expired')rule.expiresAt=f.now();
    f.resolved.context.rules=[mode==='injected'?{...rule,approved:true} as any:rule];
    const queued=await f.service.enqueue(f.intent);
    assert.equal(queued.state,mode==='exact'?'pending':'rejected',mode);
    if(mode==='exact')assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'accepted');
    assert.equal(f.sends(),mode==='exact'?1:0,mode);
  }finally{await f.cleanup();}}
});

test('journal marker write failure and malformed stored evidence never dispatch',async()=>{
  const f=await fixture();try{
    await f.service.enqueue(f.intent);let failed=false;
    const facade={get:f.store.get.bind(f.store),put:async(kind:string,value:any)=>{
      if(value.entries?.some((e:any)=>e.phase==='dispatching')&&!failed){failed=true;throw Error('storage failed before dispatch');}
      return f.store.put(kind,value);
    }};
    const service=new ContactsService({store:facade,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
    assert.equal((await service.dispatch(f.intent.requestId,signal())).state,'unconfirmed');assert.equal(f.sends(),0);
    const j=await f.store.get('contact-outbox','main');j!.entries.find((e:any)=>e.intent.requestId===f.intent.requestId).receipt.requestId='different';await f.store.put('contact-outbox',j);
    await assert.rejects(f.service.dispatch(f.intent.requestId,signal()));assert.equal(f.sends(),0);
  }finally{await f.cleanup();}
});

test('stale approvals, changed route/payload and revocation during credential preparation prevent dispatch',async()=>{
  for(const change of ['expiry','body','route','prepare'] as const){
    const f=await fixture({kind:'contact'});try{
      f.resolved.context.approvals=[{id:'approval',requestId:f.intent.requestId,binding:f.intent.binding,createdAt:f.now()-1,expiresAt:f.now()+100,revoked:false}];
      await f.service.enqueue(f.intent);
      if(change==='expiry')f.advance(101);
      if(change==='body')f.message.body='Changed body';
      if(change==='route')f.resolved.context.route!.revision++;
      if(change==='prepare')f.onPrepare(async()=>{f.resolved.context.approvals[0].revoked=true;});
      assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'rejected',change);assert.equal(f.sends(),0,change);
    }finally{await f.cleanup();}
  }
});

test('canonical recipients, sender, opt-in, explicit cost budgets and daily rates fail closed',async()=>{
  const f=await fixture();try{
    f.message.recipient='15550000002';assert.equal((await f.service.enqueue({...f.intent,requestId:'invalid-number'})).state,'rejected');f.message.recipient='+15550000002';
    f.p.optedInRecipientHashes=[];assert.equal((await f.service.enqueue({...f.intent,requestId:'no-opt-in'})).state,'rejected');f.p.optedInRecipientHashes=[sha256(f.message.recipient)];
    f.p.dailyBudgetMicros=99;assert.equal((await f.service.enqueue({...f.intent,requestId:'invalid-budget'})).state,'rejected');f.p.dailyBudgetMicros=100;
    const second={...f.intent,requestId:'second'};await f.service.enqueue(f.intent);await f.service.enqueue(second);
    const results=await Promise.all([f.service.dispatch(f.intent.requestId,signal()),f.make().dispatch(second.requestId,signal())]);
    assert.equal(results.filter(r=>r.state==='accepted').length,1);assert.equal(results.filter(r=>r.state==='rejected').length,1);assert.equal(f.sends(),1);
  }finally{await f.cleanup();}
});

test('unknown dispatch never retries or falls back, preserves draft and redacts arbitrary error text',async()=>{
  const f=await fixture();try{
    f.onDispatch(async()=>{throw new Error('401 rejected secret-token recipient private body');});
    await f.service.enqueue(f.intent);const r=await f.service.dispatch(f.intent.requestId,signal());assert.equal(r.state,'unconfirmed');assert.equal(f.sends(),1);
    await f.reopen();await f.service.enqueue(f.intent);await f.service.dispatch(f.intent.requestId,signal());await f.service.reconcile(f.intent.requestId,signal());assert.equal(f.sends(),1);
    assert.equal((await f.store.get('contact-outbox','main'))?.entries.find((e:any)=>e.intent.requestId===f.intent.requestId).draft.body,f.message.body);
    assert.doesNotMatch(JSON.stringify([r,await f.service.status()]),/secret-token|private body|155500/);
  }finally{await f.cleanup();}
});

test('crash after durable dispatch marker recovers to unknown without a second send',async()=>{
  const f=await fixture();try{
    await f.service.enqueue(f.intent);let captured:any;
    f.onDispatch(async()=>{captured=structuredClone(await f.store.get('contact-outbox','main'));assert.equal(captured.entries.find((e:any)=>e.intent.requestId===f.intent.requestId).phase,'dispatching');});
    await f.service.dispatch(f.intent.requestId,signal());assert.equal(f.sends(),1);
    // Restore the exact last durable state a terminated process could have left before its receipt write.
    await f.store.put('contact-outbox',captured);await f.reopen();
    assert.equal((await f.service.get(f.intent.requestId))?.state,'unconfirmed');
    await f.service.dispatch(f.intent.requestId,signal());assert.equal(f.sends(),1);
    assert.equal((await f.store.get('contact-outbox','main'))?.entries.find((e:any)=>e.intent.requestId===f.intent.requestId).reservedCost,100);
  }finally{await f.cleanup();}
});

test('mismatched/missing receipt evidence cannot establish acceptance; reconciliation is read-only and correlated',async()=>{
  const f=await fixture();try{
    f.result({state:'sent'});await f.service.enqueue(f.intent);assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'unconfirmed');
    const second={...f.intent,requestId:'second'};await f.service.enqueue(second);f.result({state:'sent',recordId:'owned'});await f.service.dispatch('second',signal());
    f.observe({state:'delivered',recordId:'some-other-message'});assert.equal((await f.service.reconcile('second',signal()))?.state,'sent');
    f.observe({state:'accepted',recordId:'owned'});assert.equal((await f.service.reconcile('second',signal()))?.state,'sent');
    f.observe({state:'delivered',recordId:'owned'});assert.equal((await f.service.reconcile('second',signal()))?.state,'delivered');assert.equal(f.sends(),2);
  }finally{await f.cleanup();}
});

test('quiet hours retain pending; Stop before preparation never sends; recent denial remains idempotent',async()=>{
  const f=await fixture();try{
    f.p.quietHours={startMinute:0,endMinute:0,timeZone:'America/Chicago'};await f.service.enqueue(f.intent);
    assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'pending');assert.equal(f.prepares(),0);
    f.p.quietHours=undefined;const stop=new AbortController();stop.abort();assert.equal((await f.service.dispatch(f.intent.requestId,stop.signal)).state,'rejected');assert.equal(f.sends(),0);
    f.advance(86400000);assert.equal((await f.service.get(f.intent.requestId))?.state,'rejected');
    await f.service.enqueue(f.intent);await f.service.dispatch(f.intent.requestId,signal());assert.equal(f.sends(),0);
    await assert.rejects(f.service.enqueue({...f.intent,binding:{...f.intent.binding,templateVersion:2}}),/conflict/);
  }finally{await f.cleanup();}
});

test('verification requires actual code round trip and receipt, rejects replay/expiry/changed identity',async()=>{
  const f=await fixture({verified:false});try{
    const challenge=await f.service.beginVerification('route');assert.equal('code' in challenge,false);assert.equal(f.sends(),0);
    const j=await f.store.get('contact-outbox','main');const code=j?.challenges[0].code;
    const {verification,...route}=f.resolved.context.route!;
    assert.equal(await f.service.verifiedRoute(route),undefined);
    await assert.rejects(f.service.completeVerification(challenge.challengeId,code,route)); // queued is no receipt
    assert.equal((await f.service.dispatch(challenge.requestId,signal())).state,'accepted');
    await assert.rejects(f.service.completeVerification(challenge.challengeId,'000000',route));
    await assert.rejects(f.service.completeVerification(challenge.challengeId,code,{...route,recipientSha256:sha256('different')}));
    const verified=await f.service.completeVerification(challenge.challengeId,code,route);assert.equal(verified.verification.method,'user-challenge');
    await f.reopen();assert.deepEqual(await f.service.verifiedRoute(route),verified);assert.equal(await f.service.verifiedRoute({...route,revision:2}),undefined);
    await assert.rejects(f.service.completeVerification(challenge.challengeId,code,route));
    f.advance(61000);const expired=await f.service.beginVerification('route');f.advance(300001);await assert.rejects(f.service.completeVerification(expired.challengeId,'123456',route));
  }finally{await f.cleanup();}
});

test('extension module defaults off, strictly correlates intent, enforces task/private/local context and returns contract receipts',async()=>{
  const f=await fixture();try{
    const dependencies:ExtensionDependencies={store:f.store,clock:f.now,host:{run:async()=>{throw Error('not used');}},transport:{request:async()=>{throw Error('not used');}}};
    const context={authority:'task' as const,taskId:'task',privateSession:false,localOnly:false,signal:signal()};
    const request={requestId:f.intent.requestId,taskId:'task',input:f.intent};
    const disabled=createContactsModule(dependencies);
    assert.equal((await disabled.status(signal())).capability.available,false);
    assert.equal((await disabled.action('send',request,context)).error?.code,'unconfigured');
    const module=createContactsModule(dependencies,{providers:[f.provider],resolve:async()=>f.resolved});
    assert.equal((await module.action('send',{...request,input:{...f.intent,approved:true}},context)).error?.code,'invalid-request');
    assert.equal((await module.action('send',request,{...context,taskId:'other'})).error?.code,'forbidden');
    const denied=await module.action('send',request,{...context,localOnly:true});assert.equal(denied.outcome,'rejected');assert.equal(denied.effect,'none');assert.equal(f.sends(),0);
    assert.equal((await f.service.reconcile(request.requestId,signal()))?.state,'rejected');
    assert.equal((await module.action('send',request,context)).outcome,'rejected'); // Same ID cannot silently resubmit the draft.
    const next={...request,requestId:'reviewed-send',input:{...f.intent,requestId:'reviewed-send'}};
    const receipt=await module.action('send',next,context);assert.ok(ActionReceiptSchema.safeParse(receipt).success);assert.equal(receipt.outcome,'completed');assert.equal(receipt.delivery?.state,'accepted');assert.equal(f.sends(),1);
    await module.close();const stopped=await module.action('send',{...request,requestId:'new',input:{...f.intent,requestId:'new'}},context);assert.equal(stopped.outcome,'cancelled');assert.equal(f.sends(),1);
    assert.equal((await module.action('send',next,context)).delivery?.state,'accepted');
    assert.equal((await module.action('send',{...next,input:{...next.input,binding:{...next.input.binding,templateVersion:2}}},context)).error?.code,'conflict');assert.equal(f.sends(),1);
  }finally{await f.cleanup();}
});

test('extension facade does not describe an unreadable possible-dispatch journal as safe rejection',async()=>{
  const f=await fixture();try{
    const dependencies:ExtensionDependencies={store:{...f.store,get:async()=>{throw Error('private provider secret');},put:f.store.put.bind(f.store),list:f.store.list.bind(f.store),remove:f.store.remove.bind(f.store)},clock:f.now,
      host:{run:async()=>undefined},transport:{request:async()=>undefined}};
    const module=createContactsModule(dependencies,{providers:[f.provider],resolve:async()=>f.resolved});
    const receipt=await module.action('send',{requestId:f.intent.requestId,input:f.intent},{authority:'trusted-ui',privateSession:false,localOnly:false,signal:signal()});
    assert.equal(receipt.outcome,'unconfirmed');assert.equal(receipt.error?.retry,'read-only-reconcile');assert.doesNotMatch(JSON.stringify(receipt),/private provider secret/);assert.equal(f.sends(),0);
  }finally{await f.cleanup();}
});

test('a full old dispatch ledger frees hot capacity without forgetting reserved, successful or unknown requests',async()=>{
  const f=await fixture();try{
    await f.service.enqueue(f.intent);await f.service.dispatch(f.intent.requestId,signal());
    const j=(await f.store.get('contact-outbox','main'))!,base=j.entries.find((e:any)=>e.intent.requestId===f.intent.requestId);
    const states=['accepted','sent','delivered','unconfirmed','pending'] as const;
    j.entries=Array.from({length:10000},(_,i)=>{
      const state=states[i%states.length],requestId='old-'+i;
      return {...structuredClone(base),intent:{...base.intent,requestId},phase:state==='pending'?'dispatching':'final',
        receipt:{...base.receipt,requestId,state,evidence:state==='pending'||state==='unconfirmed'?{source:'none'}:{source:'service-receipt',recordId:'remote-'+i}}};
    });
    const store=inspectingStore();await store.put('contact-outbox',j);let coldWrites=0;
    store.onWrite((kind,value)=>{
      if(kind==='contact-outbox'){assert.ok(value.entries.length<=10000);assert.equal(value.consumedApprovals.length,0);}
      if(kind==='contact-outbox-receipt'){coldWrites++;assert.equal(value.entry.draft,undefined);assert.ok(JSON.stringify(value).length<4096);}
    });
    f.advance(8*86400000);
    const make=()=>new ContactsService({store,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});let service=make();
    const next={...f.intent,requestId:'after-full-dispatch-ledger'};
    assert.equal((await service.enqueue(next)).state,'pending');assert.equal(coldWrites,64);
    assert.ok((await store.get('contact-outbox','main'))!.entries.length<10000);
    assert.equal((await service.dispatch(next.requestId,signal())).state,'accepted');assert.equal(f.sends(),2);
    assert.equal((await service.status()).unconfirmed,4000);
    service=make(); // Restart with only the durable adapter; no in-memory deduplication cache.
    for(let i=0;i<5;i++){
      const intent={...f.intent,requestId:'old-'+i},expected=i===4?'unconfirmed':states[i];
      assert.equal((await service.enqueue(intent)).state,expected);
      assert.equal((await service.dispatch(intent.requestId,signal())).state,expected);
      assert.equal((await service.reconcile(intent.requestId,signal()))?.state,expected);
    }
    await assert.rejects(service.enqueue({...f.intent,requestId:'old-0',binding:{...f.intent.binding,templateVersion:2}}),/conflict/);
    const reserved=await store.get('contact-outbox-receipt','old-4');
    assert.equal(reserved?.entry.fingerprint,base.fingerprint);assert.equal(reserved?.entry.reservedAt,base.reservedAt);
    assert.equal(reserved?.entry.receipt.state,'unconfirmed');
    const rollback=inspectingStore();await retainContactJournalAcrossRollback(store,rollback);
    // Running the migration twice must not create archive cycles or lose receipt identity.
    await retainContactJournalAcrossRollback(store,rollback);
    const restored=new ContactsService({store:rollback,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
    assert.deepEqual(await restored.get('old-0'),await service.get('old-0'));
    assert.equal((await restored.dispatch('old-4',signal())).state,'unconfirmed');assert.equal(f.sends(),2);
    assert.equal((await restored.status()).unconfirmed,4000);
  }finally{await f.cleanup();}
});

test('interrupted archive writes preserve cold receipts and never replay even before the head update',async()=>{
  const f=await fixture();try{
    await f.service.enqueue(f.intent);f.result({state:'unconfirmed'});await f.service.dispatch(f.intent.requestId,signal());
    const store=inspectingStore();await store.put('contact-outbox',(await f.store.get('contact-outbox','main'))!);
    f.advance(8*86400000);let fail=true;
    store.onWrite((kind)=>{if(kind==='contact-outbox'&&fail){fail=false;throw Error('crash before hot head update');}});
    const make=()=>new ContactsService({store,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
    await assert.rejects(make().get(f.intent.requestId));
    assert.ok(await store.get('contact-outbox-receipt',f.intent.requestId));
    assert.equal((await make().enqueue(f.intent)).state,'unconfirmed');
    assert.equal((await make().dispatch(f.intent.requestId,signal())).state,'unconfirmed');assert.equal(f.sends(),1);
    const rollback=inspectingStore();await retainContactJournalAcrossRollback(store,rollback);
    assert.equal((await new ContactsService({store:rollback,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved}).get(f.intent.requestId))?.state,'unconfirmed');
  }finally{await f.cleanup();}
});

test('interrupted rollback copy relinks orphan receipts and live approvals before another rollback',async()=>{
  const f=await fixture();try{
    f.resolved.context.workflow!.automatic=false;f.resolved.context.containsPrivateContent=true;
    f.resolved.context.approvals=[{id:'copy-approval',requestId:f.intent.requestId,binding:f.intent.binding,createdAt:f.now()-1,expiresAt:f.now()+20*86400000,revoked:false}];
    await f.service.enqueue(f.intent);f.result({state:'unconfirmed'});await f.service.dispatch(f.intent.requestId,signal());
    f.advance(8*86400000);await f.service.status();
    const rollback=inspectingStore();let fail=true;
    rollback.onWrite(kind=>{if(kind==='contact-outbox'&&fail){fail=false;throw Error('Interrupted final migration write');}});
    await assert.rejects(retainContactJournalAcrossRollback(f.store,rollback));
    assert.ok(await rollback.get('contact-outbox-receipt',f.intent.requestId));
    assert.ok(await rollback.get('contact-outbox-approval','copy-approval'));
    await retainContactJournalAcrossRollback(f.store,rollback);
    const next=inspectingStore();await retainContactJournalAcrossRollback(rollback,next);
    const service=new ContactsService({store:next,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
    assert.equal((await service.dispatch(f.intent.requestId,signal())).state,'unconfirmed');assert.equal((await service.status()).unconfirmed,1);
    assert.equal((await next.get('contact-outbox-approval','copy-approval'))?.expiresAt,f.resolved.context.approvals[0].expiresAt);assert.equal(f.sends(),1);
  }finally{await f.cleanup();}
});

test('more than 10000 expired approvals are pruned while live and legacy consumed approvals remain durable',async()=>{
  const f=await fixture({kind:'contact'});try{
    const j=(await f.store.get('contact-outbox','main'))!;
    j.version=1;j.consumedApprovals=[...Array.from({length:10001},(_,i)=>({id:'expired-'+i,expiresAt:f.now()-1})),
      {id:'live-consumed',expiresAt:f.now()+60000},'legacy-consumed'];
    const store=inspectingStore();await store.put('contact-outbox',j);
    const make=()=>new ContactsService({store,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
    await make().status();
    const migrated=(await store.get('contact-outbox','main'))!;assert.equal(migrated.version,2);assert.deepEqual(migrated.consumedApprovals,[]);
    assert.equal([...store.records.keys()].filter(k=>k.startsWith('contact-outbox-approval:')).length,2);
    assert.equal((await store.get('contact-outbox-approval','live-consumed'))?.expiresAt,f.now()+60000);
    assert.equal((await store.get('contact-outbox-approval','legacy-consumed'))?.expiresAt,Number.MAX_SAFE_INTEGER);
    const rollback=inspectingStore();await retainContactJournalAcrossRollback(store,rollback);
    const restored=()=>new ContactsService({store:rollback,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
    for(const id of ['live-consumed','legacy-consumed']){
      const intent={...f.intent,requestId:'reused-'+id};
      f.resolved.context.approvals=[{id,requestId:intent.requestId,binding:intent.binding,createdAt:f.now()-1,expiresAt:f.now()+120000,revoked:false}];
      assert.equal((await restored().enqueue(intent)).state,'rejected');
    }
    const next={...f.intent,requestId:'fresh-after-approval-pruning'};
    f.resolved.context.approvals=[{id:'fresh',requestId:next.requestId,binding:next.binding,createdAt:f.now()-1,expiresAt:f.now()+120000,revoked:false}];
    assert.equal((await restored().enqueue(next)).state,'pending');assert.equal((await restored().dispatch(next.requestId,signal())).state,'accepted');assert.equal(f.sends(),1);
    assert.equal((await rollback.get('contact-outbox-approval','fresh'))?.expiresAt,f.now()+120000);
  }finally{await f.cleanup();}
});

test('automatic private denials persist only minimal hashes and receipts across guards, module privacy and restart',async()=>{
  for(const mode of ['session','content','template','inactive','module'] as const){
    const f=await fixture();try{
      f.advance(8*86400000);await f.service.status(); // Retire the nonprivate verification draft.
      f.message.body='PRIVATE-BODY-SENTINEL-'+mode;f.message.subject='PRIVATE-SUBJECT-SENTINEL-'+mode;
      f.resolved.context.template!.bodySha256=sha256(reviewedContactBody(f.message));f.intent.binding.bodySha256=f.resolved.context.template!.bodySha256;
      if(mode==='session')f.resolved.context.privateSession=true;
      if(mode==='content'||mode==='inactive')f.resolved.context.containsPrivateContent=true;
      if(mode==='template')f.resolved.context.template!.contentClass='private';
      if(mode==='inactive')f.resolved.execution.active=false;
      if(mode==='module'){
        const module=createContactsModule({store:f.store,clock:f.now,host:{run:async()=>undefined},transport:{request:async()=>undefined}},
          {providers:[f.provider],resolve:async()=>f.resolved});
        assert.equal((await module.action('send',{requestId:f.intent.requestId,input:f.intent},
          {authority:'trusted-ui',privateSession:true,localOnly:false,signal:signal()})).outcome,'rejected');
      }else assert.equal((await f.service.enqueue(f.intent)).state,'rejected');
      await f.reopen();await f.service.dispatch(f.intent.requestId,signal());
      assert.equal((await f.service.get(f.intent.requestId))?.state,'rejected');assert.equal(f.sends(),0);assert.equal(f.prepares(),0);
      const records=(await Promise.all(['contact-outbox','contact-outbox-receipt','contact-outbox-approval'].map(k=>f.store.list(k)))).flat();
      const all=JSON.stringify(records);assert.ok(!all.includes(f.message.body));assert.ok(!all.includes(f.message.subject!));assert.ok(!all.includes(f.message.recipient));
      const e=(await f.store.get('contact-outbox','main'))!.entries.find((e:any)=>e.intent.requestId===f.intent.requestId);
      assert.equal(e.contentRedacted,true);assert.equal(e.draft,undefined);assert.equal(e.intent.binding.bodySha256,f.intent.binding.bodySha256);
    }finally{await f.cleanup();}
  }
});

test('privacy changes during preparation or cancellation scrub automatic drafts without sending',async()=>{
  for(const mode of ['prepare','cancel','module-stop'] as const){
    const f=await fixture();try{
      f.advance(8*86400000);await f.service.status();
      f.message.body='PRIVATE-EPOCH-SENTINEL-'+mode;f.resolved.context.template!.bodySha256=sha256(reviewedContactBody(f.message));f.intent.binding.bodySha256=f.resolved.context.template!.bodySha256;
      await f.service.enqueue(f.intent);
      const stop=new AbortController();
      const change=()=>{f.resolved.context.privateSession=true;f.resolved.execution.active=false;stop.abort();};
      if(mode==='prepare'){
        f.onPrepare(async()=>change());await f.service.dispatch(f.intent.requestId,stop.signal);
      }else{
        change();
        if(mode==='cancel')await f.service.cancel(f.intent.requestId);
        else{
          const module=createContactsModule({store:f.store,clock:f.now,host:{run:async()=>undefined},transport:{request:async()=>undefined}},
            {providers:[f.provider],resolve:async()=>f.resolved});
          assert.equal((await module.action('send',{requestId:f.intent.requestId,input:f.intent},
            {authority:'trusted-ui',privateSession:true,localOnly:false,signal:stop.signal})).outcome,'cancelled');
        }
      }
      await f.reopen();assert.equal((await f.service.get(f.intent.requestId))?.state,'rejected');
      for(const kind of ['contact-outbox','contact-outbox-receipt'])assert.ok(!JSON.stringify(await f.store.list(kind)).includes(f.message.body));
      assert.equal(f.sends(),0);
    }finally{await f.cleanup();}
  }
});

test('recovery removes legacy private automatic denial drafts and preserves nonprivate and confirmed manual drafts',async()=>{
  const f=await fixture();try{
    await f.service.enqueue(f.intent);await f.service.cancel(f.intent.requestId);
    const j=(await f.store.get('contact-outbox','main'))!,entry=j.entries.find((e:any)=>e.intent.requestId===f.intent.requestId);
    delete entry.draftPrivacy;entry.receipt.evidence.code='private-automatic-content';
    entry.draft.body='LEGACY-PRIVATE-SENTINEL';await f.store.put('contact-outbox',j);
    await f.reopen();await f.service.status();
    assert.ok(!JSON.stringify(await f.store.list('contact-outbox')).includes('LEGACY-PRIVATE-SENTINEL'));
    const nonprivate={...f.intent,requestId:'legacy-nonprivate'};
    await f.service.enqueue(nonprivate);await f.service.cancel(nonprivate.requestId);
    const legacy=(await f.store.get('contact-outbox','main'))!;
    delete legacy.entries.find((e:any)=>e.intent.requestId===nonprivate.requestId).draftPrivacy;
    await f.store.put('contact-outbox',legacy);
    const unresolved=new ContactsService({store:f.store,clock:f.now,providers:[f.provider],resolve:async()=>{throw Error('No task context in status facade');}});
    await unresolved.status();
    assert.equal((await f.store.get('contact-outbox','main'))!.entries.find((e:any)=>e.intent.requestId===nonprivate.requestId).draft.body,f.message.body);
    // A legacy denial from an earlier guard still gets scrubbed when trusted privacy is known.
    f.resolved.context.privateSession=true;await f.service.status();
    assert.equal((await f.store.get('contact-outbox','main'))!.entries.find((e:any)=>e.intent.requestId===nonprivate.requestId).draft,undefined);
    f.resolved.context.privateSession=false;
    f.resolved.context.workflow!.automatic=false;f.resolved.context.containsPrivateContent=true;
    const manual={...f.intent,requestId:'manual-private-preserved'};
    f.resolved.context.approvals=[{id:'manual-approval',requestId:manual.requestId,binding:manual.binding,createdAt:f.now()-1,expiresAt:f.now()+60000,revoked:false}];
    await f.service.enqueue(manual);assert.equal((await f.service.dispatch(manual.requestId,signal())).state,'accepted');
    await f.reopen();await f.service.status();
    assert.equal((await f.store.get('contact-outbox','main'))!.entries.find((e:any)=>e.intent.requestId===manual.requestId).draft.body,f.message.body);
  }finally{await f.cleanup();}
});
