import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {Store} from '../src/server/store';
import {ActionReceiptSchema,ContactIntentSchema,ContactRouteSchema,ContactApprovalSchema,DeliveryReceiptSchema,IdSchema,defaultExtensionSettings,type ContactIntent,type ExtensionDependencies} from '../src/extensions/contracts';
import {canonicalJson,sha256} from '../src/extensions/policy';
import {ContactsService,createContactsModule,retainContactJournalAcrossRollback,type ResolvedContact,type ContactChannelPolicy} from '../src/extensions/contacts';
import {OutboundMessageSchema,reviewedContactBody,type ContactProvider,type OutboundMessage,type ProviderObservation} from '../src/extensions/contact-providers';

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

test('unknown original reservations expire at the exact rolling minute boundary without replay/refund',async()=>{
  const f=await fixture();try{
    f.p.maxPerMinute=1;f.p.maxPerDay=20;f.p.dailyBudgetMicros=2000;f.result({state:'unconfirmed'});
    await f.service.enqueue(f.intent);const original=await f.service.dispatch(f.intent.requestId,signal());assert.equal(original.state,'unconfirmed');
    f.advance(59999);const early={...f.intent,requestId:'minute-early'};await f.service.enqueue(early);assert.equal((await f.service.dispatch(early.requestId,signal())).state,'rejected');assert.equal(f.sends(),1);
    await f.reopen();f.advance(1);const fresh={...f.intent,requestId:'minute-exact'};await f.service.enqueue(fresh);assert.equal((await f.service.dispatch(fresh.requestId,signal())).state,'unconfirmed');assert.equal(f.sends(),2);
    assert.deepEqual(await f.service.dispatch(f.intent.requestId,signal()),original);assert.equal(f.sends(),2);
  }finally{await f.cleanup();}
});

for(const limit of ['day-count','day-cost'] as const)test('unknown '+limit+' expires exactly at 86400000ms',async()=>{
  const f=await fixture();try{
    f.p.maxPerMinute=60;f.p.maxPerDay=limit==='day-count'?1:20;f.p.dailyBudgetMicros=limit==='day-cost'?100:2000;f.result({state:'unconfirmed'});
    await f.service.enqueue(f.intent);assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'unconfirmed');
    f.advance(86399999);const early={...f.intent,requestId:'day-early'};await f.service.enqueue(early);assert.equal((await f.service.dispatch(early.requestId,signal())).state,'rejected');assert.equal(f.sends(),1);
    f.advance(1);await f.reopen();const fresh={...f.intent,requestId:'day-exact'};await f.service.enqueue(fresh);assert.equal((await f.service.dispatch(fresh.requestId,signal())).state,'unconfirmed');assert.equal(f.sends(),2);
    assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'unconfirmed');assert.equal(f.sends(),2);
  }finally{await f.cleanup();}
});

test('actual repeated rollback preserves a recent hot reservation merged into a cold receipt exactly once',async()=>{
  const f=await fixture(),backup=await fixture();try{
    f.p.maxPerMinute=1;f.p.maxPerDay=2;f.p.dailyBudgetMicros=200;f.result({state:'unconfirmed'});
    // The backup contains the same identity as an older trusted no-effect denial.
    await f.service.enqueue(f.intent);const old=(await f.store.get('contact-outbox','main'))!.entries.find((e:any)=>e.intent.requestId===f.intent.requestId);
    old.phase='final';old.receipt={...old.receipt,state:'rejected',evidence:{source:'trusted-pre-dispatch',code:'cancelled'}};delete old.draft;
    await backup.store.put('contact-outbox-receipt',{id:f.intent.requestId,version:1,entry:old});
    const bj=(await backup.store.get('contact-outbox','main'))!;bj.version=2;bj.archiveHead=f.intent.requestId;delete bj.accounting;await backup.store.put('contact-outbox',bj);
    // The current generation dispatches the original queued identity; its
    // possible-dispatch evidence must dominate the backup's no-effect receipt.
    const receipt=await f.service.dispatch(f.intent.requestId,signal());assert.equal(receipt.state,'unconfirmed');
    const at=f.now();await retainContactJournalAcrossRollback(f.store,backup.store);await retainContactJournalAcrossRollback(f.store,backup.store);
    const cold=(await backup.store.get('contact-outbox-receipt',f.intent.requestId))!.entry;assert.equal(cold.reservedAt,at);assert.equal(cold.reservedCost,100);
    const journal=(await backup.store.get('contact-outbox','main'))!;assert.equal(journal.accounting.recent.filter((r:any)=>r.requestId===f.intent.requestId).length,1);
    await backup.store.close();const reopened=await new Store(backup.directory,backup.key).init();try{
      const service=new ContactsService({store:reopened,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
      const next={...f.intent,requestId:'after-cold-merge'};await service.enqueue(next);assert.equal((await service.dispatch(next.requestId,signal())).state,'rejected');assert.equal(f.sends(),1);
      f.advance(60000);const after={...f.intent,requestId:'after-cold-minute'};await service.enqueue(after);assert.equal((await service.dispatch(after.requestId,signal())).state,'unconfirmed');assert.equal(f.sends(),2);
      assert.deepEqual(await service.dispatch(f.intent.requestId,signal()),receipt);assert.equal(f.sends(),2);
      f.advance(86400000-60000-1);const early={...f.intent,requestId:'cold-day-early'};await service.enqueue(early);assert.equal((await service.dispatch(early.requestId,signal())).state,'rejected');
      f.advance(1);const exact={...f.intent,requestId:'cold-day-exact'};await service.enqueue(exact);assert.equal((await service.dispatch(exact.requestId,signal())).state,'unconfirmed');assert.equal(f.sends(),3);
      f.advance(60000);const capped={...f.intent,requestId:'other-recent-still-counted'};await service.enqueue(capped);assert.equal((await service.dispatch(capped.requestId,signal())).state,'unconfirmed');assert.equal(f.sends(),4);
      const full={...f.intent,requestId:'day-still-capped'};await service.enqueue(full);assert.equal((await service.dispatch(full.requestId,signal())).state,'rejected');assert.equal(f.sends(),4);
    }finally{await reopened.close();backup.store.db=undefined;}
  }finally{await f.cleanup();await backup.cleanup();}
});

test('real reservations in another channel remain charged independently',async()=>{
  const f=await fixture();try{
    let gmailSends=0;
    const message:OutboundMessage={channel:'gmail',sender:'sender@example.invalid',recipient:'recipient@example.invalid',body:'Separate channel.'},context=structuredClone(f.resolved.context);
    context.route={...context.route!,id:'gmail-route',adapter:'fake-gmail',recipientId:'gmail-recipient',recipientSha256:sha256(message.recipient)};context.template!.bodySha256=sha256(message.body);
    const policy={...f.p,sender:message.sender,optedInRecipientHashes:[sha256(message.recipient)],maxPerMinute:1,maxPerDay:1,dailyBudgetMicros:100};
    const provider:ContactProvider={id:'fake-gmail',channel:'gmail',prepare:async m=>{assert.equal(m.recipient,message.recipient);assert.equal(m.sender,message.sender);return {dispatch:async()=>{gmailSends++;return {state:'accepted',recordId:'gmail-record'};}};}};
    // Earn a real proof with a matching fake service receipt, consuming exactly
    // one Gmail reservation in the same encrypted Store as the SMS service.
    const gmail=new ContactsService({store:f.store,clock:f.now,providers:[provider],resolve:async()=>({message,channelPolicy:policy,context,execution:{active:true,localOnly:false}}),resolveVerification:async()=>{const {verification,...route}=context.route!;return {route,channel:'gmail',recipient:message.recipient,channelPolicy:policy};}});
    const challenge=await gmail.beginVerification('gmail-route'),j=(await f.store.get('contact-outbox','main'))!;assert.equal((await gmail.dispatch(challenge.requestId,signal())).state,'accepted');
    const {verification,...route}=context.route!;context.route=await gmail.completeVerification(challenge.challengeId,j.challenges.find((c:any)=>c.id===challenge.challengeId).code,route);
    const intent={requestId:'gmail-capped',binding:{...f.intent.binding,routeId:route.id,recipientId:route.recipientId,recipientSha256:route.recipientSha256,bodySha256:sha256(message.body)}};
    await gmail.enqueue(intent);assert.equal((await gmail.dispatch(intent.requestId,signal())).state,'rejected');assert.equal(gmailSends,1);
    await f.service.enqueue(f.intent);assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'accepted');assert.equal(f.sends(),1);assert.equal(gmailSends,1);
  }finally{await f.cleanup();}
});

for(const mode of ['timestamped','ambiguous','trusted-no-reservation'] as const)test('legacy accounting migrates intact '+mode+' receipts without losing identities',async()=>{
  const f=await fixture();try{
    f.p.maxPerMinute=1;f.p.maxPerDay=1;f.p.dailyBudgetMicros=100;f.result({state:'unconfirmed'});
    await f.service.enqueue(f.intent);const original=await f.service.dispatch(f.intent.requestId,signal());
    const j=(await f.store.get('contact-outbox','main'))!,entry=j.entries.find((e:any)=>e.intent.requestId===f.intent.requestId);delete entry.draft;
    if(mode!=='timestamped'){delete entry.reservedAt;delete entry.reservedCost;if(mode==='trusted-no-reservation'){entry.receipt={...entry.receipt,state:'rejected',evidence:{source:'trusted-pre-dispatch',code:'cancelled'}};}}
    await f.store.put('contact-outbox-receipt',{id:f.intent.requestId,version:1,entry});j.version=2;j.archiveHead=f.intent.requestId;j.entries=j.entries.filter((e:any)=>e.intent.requestId!==f.intent.requestId);delete j.accounting;j.archivedUnconfirmed=mode==='trusted-no-reservation'?0:1;delete j.archivedReservations;await f.store.put('contact-outbox',j);
    if(mode==='timestamped')f.advance(86400000);
    await f.reopen();const first={...f.intent,requestId:'legacy-first'};await f.service.enqueue(first);const result=await f.service.dispatch(first.requestId,signal());assert.equal(result.state,mode==='ambiguous'?'rejected':'unconfirmed');
    if(mode==='ambiguous'){
      const observed=(await f.store.get('contact-outbox-receipt',f.intent.requestId))!.entry.usageObservedAt;assert.equal(observed,f.now());
      await f.reopen();f.p.dailyBudgetMicros=10000;f.p.maxPerDay=100;f.advance(86399999);
      const early={...f.intent,requestId:'legacy-still-held'};await f.service.enqueue(early);assert.equal((await f.service.dispatch(early.requestId,signal())).state,'rejected');
      assert.equal((await f.store.get('contact-outbox-receipt',f.intent.requestId))!.entry.usageObservedAt,observed);
      const recovered=inspectingStore();await retainContactJournalAcrossRollback(f.store,recovered);await retainContactJournalAcrossRollback(f.store,recovered);
      assert.equal((await recovered.get('contact-outbox-receipt',f.intent.requestId))!.entry.usageObservedAt,observed);
      f.advance(1);const service=new ContactsService({store:recovered,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved}),fresh={...f.intent,requestId:'legacy-hold-ended'};
      await service.enqueue(fresh);assert.equal((await service.dispatch(fresh.requestId,signal())).state,'unconfirmed');assert.equal(f.sends(),2);
    }
    assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,mode==='trusted-no-reservation'?'rejected':original.state);
  }finally{await f.cleanup();}
});

for(const location of ['hot','cold'] as const)test('repeated get-only legacy '+location+' retention preserves each observation and never backdates a new identity',async(t)=>{
  const f=await fixture({verified:false}),backup=await fixture({verified:false});try{
    let clock=f.now();t.mock.method(Date,'now',()=>clock);
    const entry=(requestId:string)=>({intent:{...f.intent,requestId},createdAt:f.now(),phase:'final',channel:'sms',fingerprint:sha256('legacy-bodyless'),providerConfigurationId:'original-account',
      receipt:{id:'receipt-'+requestId,requestId,binding:f.intent.binding,adapter:'fake-sms',state:'unconfirmed',observedAt:f.now()-1000,evidence:{source:'none'}}});
    const original=entry('original-unknown'),fresh=entry('new-unknown');
    const legacy=async(includeNew:boolean)=>{
      const entries=includeNew?[original,fresh]:[original];
      if(location==='cold')for(let n=0;n<entries.length;n++)await f.store.put('contact-outbox-receipt',{id:entries[n].intent.requestId,version:1,entry:entries[n],previous:entries[n-1]?.intent.requestId});
      await f.store.put('contact-outbox',{id:'main',version:2,entries:location==='hot'?entries:[],challenges:[],consumedApprovals:[],verifiedRoutes:[],archiveHead:location==='cold'?entries.at(-1)!.intent.requestId:undefined});
    };
    // The source is deliberately immutable through this boundary, just like the
    // controller's get-only current generation. All persistence is real encrypted Store.
    const current={get:f.store.get.bind(f.store)};
    const snapshot=async()=>{
      const rows=await Promise.all([backup.store.get('contact-outbox','main'),backup.store.get('contact-outbox-receipt',original.intent.requestId),backup.store.get('contact-outbox-receipt',fresh.intent.requestId)]);
      return rows.map(row=>{if(!row)return row;const {updatedAt,...journal}=row;return journal;});
    };
    const observed=async(requestId:string)=>location==='cold'?(await backup.store.get('contact-outbox-receipt',requestId))!.entry:(await backup.store.get('contact-outbox','main'))!.entries.find((e:any)=>e.intent.requestId===requestId);
    await legacy(false);const sourceBefore=await f.store.get('contact-outbox','main');
    await retainContactJournalAcrossRollback(current,backup.store);const first=await snapshot(),firstTime=clock;
    assert.equal((await observed(original.intent.requestId)).usageObservedAt,firstTime);
    clock+=1000;await backup.reopen();await retainContactJournalAcrossRollback(current,backup.store);
    assert.deepEqual(await snapshot(),first);assert.deepEqual(await f.store.get('contact-outbox','main'),sourceBefore);
    // This second original identity has never been observed. It must not borrow
    // either the earlier request's timestamp or an earlier global migration clock.
    clock+=1000;await legacy(true);await retainContactJournalAcrossRollback(current,backup.store);
    assert.equal((await observed(original.intent.requestId)).usageObservedAt,firstTime);
    assert.equal((await observed(fresh.intent.requestId)).usageObservedAt,clock);
    if(location==='cold')assert.deepEqual((await backup.store.get('contact-outbox','main'))!.accounting.recent,
      [{requestId:'new-unknown',channel:'sms',observedAt:clock},{requestId:'original-unknown',channel:'sms',observedAt:firstTime}]);
    const both=await snapshot();clock+=1000;await backup.reopen();await retainContactJournalAcrossRollback(current,backup.store);assert.deepEqual(await snapshot(),both);
    // These are historical uncertain claims, not invented reservation times/costs.
    const service=new ContactsService({store:backup.store,clock:()=>clock,providers:[f.provider],resolve:async()=>{throw Error('Unexpected preparation of an existing request');}});
    for(const e of [original,fresh]){
      const saved=await observed(e.intent.requestId);assert.equal(saved.reservedAt,undefined);assert.equal(saved.reservedCost,undefined);
      assert.deepEqual(await service.dispatch(e.intent.requestId,signal()),e.receipt);
    }
    const beforeConflict=await snapshot();
    for(const conflict of ['binding','channel','account'] as const){
      await legacy(true);
      const kind=location==='cold'?'contact-outbox-receipt':'contact-outbox',id=location==='cold'?original.intent.requestId:'main',row=(await f.store.get(kind,id))!;
      const e=location==='cold'?row.entry:row.entries[0];
      if(conflict==='binding'){e.intent.binding.routeRevision++;e.receipt.binding.routeRevision=e.intent.binding.routeRevision;}
      if(conflict==='channel')e.channel='voice';
      if(conflict==='account')e.providerConfigurationId='different-account';
      await f.store.put(kind,row);await assert.rejects(retainContactJournalAcrossRollback(current,backup.store));assert.deepEqual(await snapshot(),beforeConflict);
    }
    assert.equal(f.prepares(),0);assert.equal(f.sends(),0);
  }finally{await f.cleanup();await backup.cleanup();}
});

for(const damage of ['missing','cycle','aggregate-without-identities'] as const)test('legacy usage refuses '+damage+' dedup history',async()=>{
  const f=await fixture();try{
    const j=(await f.store.get('contact-outbox','main'))!;j.version=2;delete j.accounting;
    if(damage==='aggregate-without-identities')j.archivedReservations=[{channel:'sms',count:1,cost:100}];
    else{j.archiveHead='missing';if(damage==='cycle'){const entry=structuredClone(j.entries[0]);delete entry.draft;entry.intent.requestId='missing';entry.receipt.requestId='missing';await f.store.put('contact-outbox-receipt',{id:'missing',version:1,entry,previous:'missing'});}}
    await f.store.put('contact-outbox',j);await assert.rejects(f.service.enqueue({...f.intent,requestId:'must-not-send'}));assert.equal(f.sends(),0);
  }finally{await f.cleanup();}
});

test('durable usage clock refuses a backward clock after expired usage was archived and reopened',async()=>{
  const f=await fixture();try{
    assert.equal((await f.service.enqueue(f.intent)).state,'pending');assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'accepted');assert.equal(f.sends(),1);
    f.advance(8*86400000);await f.service.status();
    assert.ok(await f.store.get('contact-outbox-receipt',f.intent.requestId));
    f.advance(-7*86400000);await f.reopen();const next={...f.intent,requestId:'clock-rollback'};
    // The earned route proof remains valid; only the durable usage clock denies.
    const {verification,...route}=f.resolved.context.route!;
    assert.ok(await f.service.verifiedRoute(route));
    await f.service.enqueue(next);const denied=await f.service.dispatch(next.requestId,signal());assert.equal(denied.state,'rejected');assert.equal(denied.evidence.source,'trusted-pre-dispatch');
    assert.equal(denied.evidence.source==='trusted-pre-dispatch'&&denied.evidence.code,'budget-or-rate-limit');assert.equal(f.sends(),1);
  }finally{await f.cleanup();}
});

/** Inspect the exact JSON Store would encrypt, without 10,000 SQLite file rewrites per fixture. */
function inspectingStore(){
  const records=new Map<string,any>();let beforeWrite:((kind:string,value:any)=>void)|undefined;
  return {records,onWrite:(f:(kind:string,value:any)=>void)=>{beforeWrite=f;},
    get:async(kind:string,id:string)=>{const r=records.get(kind+':'+id);return r?structuredClone(r):undefined;},
    put:async(kind:string,value:any)=>{const copy=JSON.parse(JSON.stringify(value));beforeWrite?.(kind,copy);records.set(kind+':'+value.id,copy);return structuredClone(copy);}};
}

/** Historical compatibility fixture from this project's published .2 application:
 * 6eef5904fce72d574741d6e53079c56ac4e868bd, src/extensions/contacts.ts
 * SHA-256 (Git blob bytes): 0588e02ce5c0dc75b259091f146cb4e4a4716fe50204b0a2f5a0aae581730619.
 * The non-strict entry/main schemas below reproduce that source's field projection and
 * literal2 fence. No external checkout/download is needed. The status fixture exercises
 * its load -> recover -> save branch with final, recent, bodyless entries and no approvals
 * or challenges; that branch has no other mutations and never requires configured dispatch.
 * Source attribution: existing Capri MIT application code; no provider code/assets copied. */
const historicalExpiry=z.number().int().nonnegative().safe();
const historicalConsumed=z.object({id:IdSchema,expiresAt:historicalExpiry});
const historicalEntry=z.object({intent:ContactIntentSchema,createdAt:z.number().int().nonnegative(),phase:z.enum(['queued','dispatching','final']),receipt:DeliveryReceiptSchema,
  draft:OutboundMessageSchema.optional(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),channel:z.enum(['gmail','sms','voice','whatsapp','android']),
  reservedAt:z.number().int().nonnegative().optional(),reservedCost:z.number().int().nonnegative().optional(),approvalId:IdSchema.optional(),verificationChallengeId:IdSchema.optional(),
  draftPrivacy:z.enum(['nonprivate','manual-private']).optional(),contentRedacted:z.boolean().optional(),awaitingReview:z.boolean().optional(),
  exactApproval:z.object({approval:ContactApprovalSchema,authorizationSha256:z.string().regex(/^[a-f0-9]{64}$/),privacyEpoch:z.uuid()}).strict().optional(),
  approvalAction:z.object({requestId:IdSchema,digest:z.string().regex(/^[a-f0-9]{64}$/),receipt:ActionReceiptSchema}).strict().optional()});
const historicalFields={entries:z.array(historicalEntry).max(10000),challenges:z.array(z.object({
  id:IdSchema,routeId:IdSchema,revision:z.number().int().positive(),recipientSha256:z.string(),adapter:IdSchema,digest:z.string(),salt:z.string(),
  createdAt:z.number(),expiresAt:z.number(),attempts:z.number().int(),used:z.boolean(),requestId:IdSchema.optional(),code:z.string().optional(),
})).max(1000),verifiedRoutes:z.array(ContactRouteSchema).max(1000)};
function historicalCheck(j:{entries:z.infer<typeof historicalEntry>[]},ctx:z.RefinementCtx){
  const equal=(a:unknown,b:unknown)=>canonicalJson(JSON.parse(JSON.stringify(a)))===canonicalJson(JSON.parse(JSON.stringify(b)));
  if(new Set(j.entries.map(e=>e.intent.requestId)).size!==j.entries.length)ctx.addIssue({code:'custom',message:'Duplicate outbox identity.'});
  for(const e of j.entries){
    if(e.receipt.requestId!==e.intent.requestId||!equal(e.receipt.binding,e.intent.binding)||
      (e.reservedAt===undefined)!==(e.reservedCost===undefined)||e.phase==='dispatching'&&e.reservedAt===undefined||
      e.phase==='final'&&e.receipt.state==='pending'||e.phase!=='final'&&e.receipt.state!=='pending')ctx.addIssue({code:'custom',message:'Inconsistent outbox evidence.'});
    if(e.exactApproval&&(e.exactApproval.approval.requestId!==e.intent.requestId||!equal(e.exactApproval.approval.binding,e.intent.binding))||
      e.approvalAction&&(!e.exactApproval||e.approvalAction.receipt.requestId!==e.approvalAction.requestId||e.approvalAction.receipt.feature!=='contacts'||e.approvalAction.receipt.action!=='approve'||e.approvalAction.receipt.delivery))
      ctx.addIssue({code:'custom',message:'Inconsistent exact approval evidence.'});
  }
}
const historicalV2=z.object({version:z.literal(2),...historicalFields,consumedApprovals:z.array(historicalConsumed).max(10000),archiveHead:IdSchema.optional(),approvalHead:IdSchema.optional(),archivedUnconfirmed:historicalExpiry.optional()}).superRefine(historicalCheck);
const historicalV1=z.object({version:z.literal(1),...historicalFields,consumedApprovals:z.array(z.union([IdSchema,historicalConsumed]))}).superRefine(historicalCheck);
async function historicalStatus(store:Pick<Store,'get'|'put'>,now:number){
  const raw=await store.get('contact-outbox','main');
  const j=raw?.version===2?historicalV2.parse(raw):{...historicalV1.parse(raw),version:2};
  // Pin the exercised recovery branch instead of pretending to implement other old paths.
  assert.deepEqual(j.challenges,[]);assert.deepEqual(j.consumedApprovals,[]);assert.equal('archiveHead' in j?j.archiveHead:undefined,undefined);
  for(const e of j.entries){assert.equal(e.phase,'final');assert.equal(e.draft,undefined);assert.ok(now-e.createdAt<=7*86400000);}
  await store.put('contact-outbox',{id:'main',...j});
  assert.deepEqual(historicalV2.parse(await store.get('contact-outbox','main')),j);
}

test('published .2 status strips format2 accounting; format3 refuses before any write or dispatch',async()=>{
  const f=await fixture();try{
    f.result({state:'unconfirmed'});await f.service.enqueue(f.intent);await f.service.dispatch(f.intent.requestId,signal());
    const legacy=(await f.store.get('contact-outbox','main'))!;legacy.version=2;legacy.challenges=[];legacy.verifiedRoutes=[];
    legacy.entries=legacy.entries.filter((e:any)=>e.intent.requestId===f.intent.requestId);
    const e=legacy.entries[0];delete e.draft;delete e.reservedAt;delete e.reservedCost;e.usageObservedAt=f.now()-1000;
    const observed=e.usageObservedAt,old=inspectingStore();await old.put('contact-outbox',legacy);let writes=0;
    old.onWrite(()=>{writes++;});await historicalStatus(old,f.now());assert.equal(writes,1);
    const rewritten=(await old.get('contact-outbox','main'))!;
    assert.equal(rewritten.accounting,undefined);assert.equal(rewritten.usageClock,undefined);assert.equal(rewritten.entries[0].usageObservedAt,undefined);
    // The new reader preserves the original bound, fences the old writer even when
    // providers/owner are unconfigured, and does not dispatch during status/migration.
    await f.store.put('contact-outbox',legacy);const unavailable=new ContactsService({store:f.store,clock:f.now,providers:[],resolve:async()=>{throw Error('No configured owner');}});
    await unavailable.status();const upgraded=(await f.store.get('contact-outbox','main'))!;
    assert.equal(upgraded.version,3);assert.equal(upgraded.entries[0].usageObservedAt,observed);assert.equal(f.sends(),1);
    await old.put('contact-outbox',upgraded);writes=0;const bytes=JSON.stringify(await old.get('contact-outbox','main'));
    await assert.rejects(historicalStatus(old,f.now()));assert.equal(writes,0);assert.equal(JSON.stringify(await old.get('contact-outbox','main')),bytes);assert.equal(f.sends(),1);
    f.advance(1000);await f.reopen();await f.service.status();assert.equal((await f.store.get('contact-outbox','main'))!.entries[0].usageObservedAt,observed);
  }finally{await f.cleanup();}
});

for(const version of [1,2])test('legacy'+version+' migrates to durable3 and encrypted rollback twice preserves hot T, cold cost and one-use identity',async()=>{
  const f=await fixture(),backup=await fixture({verified:false}),recovered=await fixture({verified:false});try{
    f.p.maxPerMinute=60;f.p.maxPerDay=10;f.p.dailyBudgetMicros=1000;f.result({state:'unconfirmed'});
    await f.service.enqueue(f.intent);const hotReceipt=await f.service.dispatch(f.intent.requestId,signal());
    const coldIntent={...f.intent,requestId:'known-cold'};await f.service.enqueue(coldIntent);const coldReceipt=await f.service.dispatch(coldIntent.requestId,signal());
    const j=(await f.store.get('contact-outbox','main'))!,hot=j.entries.find((e:any)=>e.intent.requestId===f.intent.requestId),cold=j.entries.find((e:any)=>e.intent.requestId===coldIntent.requestId);
    const reservedAt=cold.reservedAt,cost=cold.reservedCost,observed=f.now()-1000;
    delete hot.reservedAt;delete hot.reservedCost;hot.usageObservedAt=observed;hot.approvalId='migration-consumed';
    const approvalExpires=f.now()+86400000;j.consumedApprovals=[{id:'migration-consumed',expiresAt:approvalExpires}];
    delete cold.draft;await f.store.put('contact-outbox-receipt',{id:coldIntent.requestId,version:1,entry:cold});
    j.entries=j.entries.filter((e:any)=>e.intent.requestId!==coldIntent.requestId);j.version=version;j.archiveHead=coldIntent.requestId;j.archivedUnconfirmed=1;
    j.archivedReservations=[{channel:'sms',count:1,cost}];delete j.accounting;await f.store.put('contact-outbox',j);
    await f.reopen();await f.service.status();assert.equal((await f.store.get('contact-outbox','main'))!.version,3);
    await retainContactJournalAcrossRollback(f.store,backup.store);await retainContactJournalAcrossRollback(f.store,backup.store);
    await backup.reopen();f.advance(60000);
    await retainContactJournalAcrossRollback(backup.store,recovered.store);await retainContactJournalAcrossRollback(backup.store,recovered.store);
    await recovered.reopen();const service=new ContactsService({store:recovered.store,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
    const restored=(await recovered.store.get('contact-outbox','main'))!;
    assert.equal(restored.version,3);assert.equal(restored.entries.find((e:any)=>e.intent.requestId===f.intent.requestId).usageObservedAt,observed);
    const record=(await recovered.store.get('contact-outbox-receipt',coldIntent.requestId))!;
    assert.equal(record.version,1);assert.equal(record.entry.reservedAt,reservedAt);assert.equal(record.entry.reservedCost,cost);
    assert.deepEqual(restored.accounting.recent.filter((r:any)=>r.requestId===coldIntent.requestId),[{requestId:coldIntent.requestId,channel:'sms',reservedAt,reservedCost:cost}]);
    assert.equal((await recovered.store.get('contact-outbox-approval','migration-consumed'))!.expiresAt,approvalExpires);
    assert.deepEqual(await service.dispatch(f.intent.requestId,signal()),hotReceipt);assert.deepEqual(await service.dispatch(coldIntent.requestId,signal()),coldReceipt);
    const fresh={...f.intent,requestId:'held-by-original-T'};await service.enqueue(fresh);assert.equal((await service.dispatch(fresh.requestId,signal())).state,'rejected');assert.equal(f.sends(),2);
    assert.ok(!JSON.stringify(await recovered.store.export()).includes('migration-consumed'));
  }finally{await f.cleanup();await backup.cleanup();await recovered.cleanup();}
});

test('queued legacy dispatch cannot prepare until the format3 migration has matching durable final readback',async()=>{
  const f=await fixture();try{
    await f.service.enqueue(f.intent);const j=(await f.store.get('contact-outbox','main'))!;j.version=2;delete j.accounting;await f.store.put('contact-outbox',j);
    let fail=true;const store={get:f.store.get.bind(f.store),put:async(kind:string,value:any)=>{
      if(kind==='contact-outbox'){assert.equal(value.version,3);if(!value.accountingMigration&&fail){fail=false;throw Error('Migration commit interrupted');}}
      return f.store.put(kind,value);
    }};
    const service=new ContactsService({store,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
    await assert.rejects(service.dispatch(f.intent.requestId,signal()));assert.equal(f.prepares(),0);assert.equal(f.sends(),0);
    assert.ok((await f.store.get('contact-outbox','main'))!.accountingMigration);
    await f.reopen();assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'accepted');assert.equal(f.prepares(),1);assert.equal(f.sends(),1);
    const complete=(await f.store.get('contact-outbox','main'))!;assert.equal(complete.version,3);assert.equal(complete.accountingMigration,undefined);
    await f.reopen();assert.equal((await f.service.dispatch(f.intent.requestId,signal())).state,'accepted');assert.equal(f.sends(),1);
  }finally{await f.cleanup();}
});

test('interrupted real rollback fences legacy hot observations before copying and never reobserves them on retry',async()=>{
  const f=await fixture(),backup=await fixture({verified:false});try{
    f.result({state:'unconfirmed'});await f.service.enqueue(f.intent);const original=await f.service.dispatch(f.intent.requestId,signal());
    const j=(await f.store.get('contact-outbox','main'))!,entry=j.entries.find((e:any)=>e.intent.requestId===f.intent.requestId);
    j.version=2;delete j.accounting;delete entry.reservedAt;delete entry.reservedCost;await f.store.put('contact-outbox',j);
    let fail=true;const target={get:backup.store.get.bind(backup.store),put:async(kind:string,value:any)=>{
      if(kind==='contact-outbox'&&!value.accountingMigration&&fail){fail=false;throw Error('Interrupted rollback commit');}
      return backup.store.put(kind,value);
    }};
    await assert.rejects(retainContactJournalAcrossRollback(f.store,target));
    const pending=(await backup.store.get('contact-outbox','main'))!,observed=pending.accountingMigration.observedAt;
    assert.equal(pending.version,3);assert.ok(observed>=j.usageClock);assert.equal(f.sends(),1);
    f.advance(60000);await backup.reopen();
    await retainContactJournalAcrossRollback(f.store,backup.store);await retainContactJournalAcrossRollback(f.store,backup.store);
    const complete=(await backup.store.get('contact-outbox','main'))!;
    assert.equal(complete.accountingMigration,undefined);assert.equal(complete.entries.find((e:any)=>e.intent.requestId===f.intent.requestId).usageObservedAt,observed);
    const service=new ContactsService({store:backup.store,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
    assert.deepEqual(await service.dispatch(f.intent.requestId,signal()),original);
    const next={...f.intent,requestId:'after-interrupted-rollback'};await service.enqueue(next);assert.equal((await service.dispatch(next.requestId,signal())).state,'rejected');assert.equal(f.sends(),1);
  }finally{await f.cleanup();await backup.cleanup();}
});

for(const failure of ['stage-write','stage-drop','stage-readback','cold-write','final-write','final-readback'] as const)test('format3 migration '+failure+' cannot send, refund or reset a durable observation',async()=>{
  const f=await fixture();try{
    f.result({state:'unconfirmed'});await f.service.enqueue(f.intent);const original=await f.service.dispatch(f.intent.requestId,signal());
    const j=(await f.store.get('contact-outbox','main'))!,entry=j.entries.find((e:any)=>e.intent.requestId===f.intent.requestId);
    delete entry.draft;delete entry.reservedAt;delete entry.reservedCost;
    // Early failures have no new durable marker yet; retain an already durable T.
    if(failure==='stage-write'||failure==='stage-drop')entry.usageObservedAt=f.now()-1000;
    await f.store.put('contact-outbox-receipt',{id:f.intent.requestId,version:1,entry});
    j.version=2;j.entries=j.entries.filter((e:any)=>e.intent.requestId!==f.intent.requestId);j.archiveHead=f.intent.requestId;j.archivedUnconfirmed=1;delete j.accounting;
    await f.store.put('contact-outbox',j);const expected=entry.usageObservedAt??f.now();let armed=true,stale:any;
    const store={get:async(kind:string,id:string)=>{if(kind==='contact-outbox'&&stale){const value=stale;stale=undefined;return value;}return f.store.get(kind,id);},
      put:async(kind:string,value:any)=>{
        const stage=kind==='contact-outbox'&&!!value.accountingMigration,final=kind==='contact-outbox'&&!value.accountingMigration;
        if(armed&&(stage&&failure==='stage-write'||kind==='contact-outbox-receipt'&&failure==='cold-write'||final&&failure==='final-write')){armed=false;throw Error('Injected migration interruption');}
        if(armed&&stage&&failure==='stage-drop'){armed=false;return value;}
        const previous=await f.store.get(kind,value.id),written=await f.store.put(kind,value);
        if(armed&&(stage&&failure==='stage-readback'||final&&failure==='final-readback')){armed=false;stale=previous;}
        return written;
      }};
    const service=new ContactsService({store,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
    await assert.rejects(service.dispatch(f.intent.requestId,signal()));assert.equal(armed,false);assert.equal(f.sends(),1);assert.equal(f.prepares(),1);
    const partial=(await f.store.get('contact-outbox','main'))!;
    if(failure!=='stage-write'&&failure!=='stage-drop')assert.equal(partial.version,3);
    if(partial.accountingMigration)assert.equal(partial.accountingMigration.observedAt,expected);
    f.advance(60000);await f.reopen();await f.service.status();
    assert.equal((await f.store.get('contact-outbox-receipt',f.intent.requestId))!.entry.usageObservedAt,expected);
    assert.deepEqual(await f.service.dispatch(f.intent.requestId,signal()),original);
    const fresh={...f.intent,requestId:'still-held-after-migration'};await f.service.enqueue(fresh);assert.equal((await f.service.dispatch(fresh.requestId,signal())).state,'rejected');assert.equal(f.sends(),1);
  }finally{await f.cleanup();}
});

for(const damage of ['unknown-main','null-main','mixed-accounting','mixed-archive','mixed-migration','missing-v3-index','inconsistent-index'] as const)test('format migration refuses '+damage+' before any write or provider effect',async()=>{
  const f=await fixture();try{
    const store=inspectingStore(),j=(await f.store.get('contact-outbox','main'))!;j.version=2;
    if(damage==='unknown-main')j.version=4;
    if(damage==='mixed-accounting')j.accounting.version=2;
    if(damage==='mixed-migration')j.accountingMigration={version:1,observedAt:f.now()};
    if(damage==='missing-v3-index'){j.version=3;delete j.accounting;}
    if(damage==='inconsistent-index')j.accounting.recent=[{requestId:'missing-usage',channel:'sms',reservedAt:f.now(),reservedCost:100}];
    if(damage==='mixed-archive'){
      const entry=structuredClone(j.entries[0]);delete entry.draft;j.archiveHead=entry.intent.requestId;delete j.accounting;
      await store.put('contact-outbox-receipt',{id:entry.intent.requestId,version:2,entry});
    }
    if(damage==='null-main')store.records.set('contact-outbox:main',null);else await store.put('contact-outbox',j);
    let writes=0;store.onWrite(()=>{writes++;});
    // Preserve null as corruption rather than the inspecting fixture's absent-record shortcut.
    const boundary=damage==='null-main'?{get:async()=>null as any,put:store.put}:store;
    const before=JSON.stringify([...store.records]);const service=new ContactsService({store:boundary,clock:f.now,providers:[f.provider],resolve:async()=>f.resolved});
    await assert.rejects(service.status());assert.equal(writes,0);assert.equal(JSON.stringify([...store.records]),before);assert.equal(f.prepares(),0);assert.equal(f.sends(),0);
  }finally{await f.cleanup();}
});

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

test('rollback preserves matching accepted evidence over uncertainty and refuses conflicting provider generations',async()=>{
  const f=await fixture(),recovered=await fixture();try{
    await f.service.enqueue(f.intent);await f.service.dispatch(f.intent.requestId,signal());const accepted=(await f.store.get('contact-outbox','main'))!;await recovered.store.put('contact-outbox',accepted);
    const uncertain=structuredClone(accepted),entry=uncertain.entries.find((e:any)=>e.intent.requestId===f.intent.requestId);entry.receipt.state='unconfirmed';entry.receipt.evidence={source:'none'};await f.store.put('contact-outbox',uncertain);
    await retainContactJournalAcrossRollback(f.store,recovered.store);assert.equal((await recovered.service.dispatch(f.intent.requestId,signal())).state,'accepted');assert.equal(recovered.sends(),0);assert.equal(f.sends(),1);
    const source=(await f.store.get('contact-outbox','main'))!,target=(await recovered.store.get('contact-outbox','main'))!;source.entries.find((e:any)=>e.intent.requestId===f.intent.requestId).providerConfigurationId='generation-a';target.entries.find((e:any)=>e.intent.requestId===f.intent.requestId).providerConfigurationId='generation-b';await f.store.put('contact-outbox',source);await recovered.store.put('contact-outbox',target);
    await assert.rejects(retainContactJournalAcrossRollback(f.store,recovered.store));assert.equal(f.sends(),1);assert.equal(recovered.sends(),0);
  }finally{await f.cleanup();await recovered.cleanup();}
});

test('rollback cannot erase an uncertain reservation with a restored pre-dispatch denial or confuse remote records',async()=>{
  const f=await fixture(),recovered=await fixture();try{
    f.result({state:'unconfirmed'});await f.service.enqueue(f.intent);await f.service.dispatch(f.intent.requestId,signal());const uncertain=(await f.store.get('contact-outbox','main'))!;
    await recovered.store.put('contact-outbox',uncertain);const denied=structuredClone(uncertain),entry=denied.entries.find((e:any)=>e.intent.requestId===f.intent.requestId);
    delete entry.reservedAt;delete entry.reservedCost;entry.receipt.state='rejected';entry.receipt.evidence={source:'trusted-pre-dispatch',code:'cancelled'};await f.store.put('contact-outbox',denied);
    await retainContactJournalAcrossRollback(f.store,recovered.store);const kept=(await recovered.store.get('contact-outbox','main'))!.entries.find((e:any)=>e.intent.requestId===f.intent.requestId);
    assert.equal(kept.receipt.state,'unconfirmed');assert.equal(kept.reservedCost,100);assert.equal(kept.reservedAt,uncertain.entries.find((e:any)=>e.intent.requestId===f.intent.requestId).reservedAt);assert.equal(recovered.sends(),0);
    const source=structuredClone(uncertain),target=structuredClone(uncertain);source.entries.find((e:any)=>e.intent.requestId===f.intent.requestId).receipt={...kept.receipt,state:'sent',evidence:{source:'service-receipt',recordId:'original-record'}};
    target.entries.find((e:any)=>e.intent.requestId===f.intent.requestId).receipt={...kept.receipt,state:'delivered',evidence:{source:'observed-record',recordId:'different-record'}};
    await f.store.put('contact-outbox',source);await recovered.store.put('contact-outbox',target);await assert.rejects(retainContactJournalAcrossRollback(f.store,recovered.store));assert.equal(recovered.sends(),0);assert.equal(f.sends(),1);
  }finally{await f.cleanup();await recovered.cleanup();}
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
    // All original reservation timestamps are eight days old. Retaining unknown
    // identities forever must not turn a rolling local limit into a lifetime cap.
    assert.equal((await service.dispatch(next.requestId,signal())).state,'accepted');assert.equal(f.sends(),2);
    assert.ok((await store.get('contact-outbox','main'))!.archivedReservations.some((r:any)=>r.channel==='sms'&&r.count>0&&r.cost>0));
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
    rollback.onWrite((kind,value)=>{if(kind==='contact-outbox'&&!value.accountingMigration&&fail){fail=false;throw Error('Interrupted final migration write');}});
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
    const migrated=(await store.get('contact-outbox','main'))!;assert.equal(migrated.version,3);assert.deepEqual(migrated.consumedApprovals,[]);
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
