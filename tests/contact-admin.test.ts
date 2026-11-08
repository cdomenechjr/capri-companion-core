import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../src/server/store';
import {ContactAdminRequestSchema,contactAuthorityKind,emptyContactAuthority,parseContactAuthority,writeContactAuthority,isEmptyContactAuthority} from '../src/extensions/contact-admin';
import {retainContactJournalAcrossRollback} from '../src/extensions/contacts';
import {DesktopContactOwner,ProtectedContactVault} from '../src/desktop/contact-owner';
import {createService} from '../src/server/service';
import {sha256,canonicalJson} from '../src/extensions/policy';
import {androidProtocol} from '../src/extensions/paired-android';

async function stores(){const directory=await mkdtemp(path.join(os.tmpdir(),'capri-authority-')),key=randomBytes(32),source=await new Store(path.join(directory,'current'),key).init(),target=await new Store(path.join(directory,'recovered'),key).init();return {source,target,cleanup:async()=>{await source.close();await target.close();await rm(directory,{recursive:true,force:true});}};}
function authority(){const s=emptyContactAuthority(),generation=randomUUID();s.revision=10;s.providers.twilio={generation,enabled:true,connected:true,sender:'+15550000001',accountSid:'AC'+'a'.repeat(32)};
  s.routes.push({id:'route',recipientId:'recipient',revision:7,channel:'sms',destination:'+15550000002',kind:'self',enabled:true,optedIn:true,providerGeneration:generation});s.templates.push({id:'template',revision:2,enabled:true,body:'Completed.',contentClass:'public'});s.workflows.push({id:'workflow',revision:3,enabled:true,trigger:'task-completed',routeId:'route',templateId:'template'});
  s.rules.push({id:'rule',binding:{routeId:'route',routeRevision:7,recipientId:'recipient',recipientSha256:sha256(s.routes[0].destination),workflowId:'workflow',templateId:'template',templateVersion:2,bodySha256:sha256('Completed.')},createdAt:1,expiresAt:2_000_000_000_000,revoked:false});return s;}

test('administration schemas reject authority, URL, sender override, weak codes, raw rules and unknown keys',()=>{
  const base={requestId:'request',expectedRevision:1};
  for(const raw of [{...base,action:'status',approved:true},{...base,action:'configure-gmail',clientId:'client',sender:'a@example.invalid',redirectUrl:'https://example.invalid'},
    {...base,action:'verify-complete',routeId:'route',challengeId:'challenge',code:'123'},
    {...base,action:'save-route',routeId:'r',channel:'sms',destination:'+15550000001',kind:'self',optedIn:true,verified:true},
    {...base,action:'add-rule',outboxRequestId:'r',expiresAt:123,binding:{},approved:true},
    {...base,action:'prepare-notification',workflowId:'workflow',body:'model text',recipient:'+15550000001'},
    {...base,action:'configure-twilio',accountSid:'AC'+'a'.repeat(32),authToken:'fixture',sender:'+15550000001',voiceEnabled:false,url:'https://example.invalid'}])assert.equal(ContactAdminRequestSchema.safeParse(raw).success,false);
});

test('current revoke/opt-out/account/template generations survive the actual rollback hook',async()=>{
  const f=await stores();try{const backup=authority();await writeContactAuthority(f.target,backup);const current=structuredClone(backup);current.revision++;current.routes[0].enabled=false;current.routes[0].optedIn=false;current.routes[0].revision++;current.rules[0].revoked=true;current.providers.twilio!.generation=randomUUID();current.templates[0].revision++;await writeContactAuthority(f.source,current);
    await retainContactJournalAcrossRollback(f.source,f.target);assert.deepEqual(parseContactAuthority(await f.target.get(contactAuthorityKind,'main')),current);
    const owner=new DesktopContactOwner({store:f.target,vault:new ProtectedContactVault({read:()=>({voice:'Designed A'}),write:()=>{throw Error('Unexpected vault write');}}),fetch:async()=>{throw Error('Unexpected network');},openAuthorization:async()=>{throw Error('Unexpected OAuth');}});
    try{const rows=await owner.overview({authority:'trusted-ui',signal:new AbortController().signal,privateSession:false,localOnly:false});assert.equal(rows.routes[0].enabled,false);assert.equal(rows.routes[0].verified,false);assert.equal(rows.rules[0].revoked,true);
      await assert.rejects(owner.options.resolve({requestId:'stale',binding:backup.rules[0].binding},{authority:'trusted-ui',signal:new AbortController().signal,privateSession:false,localOnly:false}));
    }finally{await owner.close();}
  }finally{await f.cleanup();}
});

for(const conflict of ['missing-current','equal-version','older-current'] as const)test('unprovable rollback authority is unavailable: '+conflict,async()=>{
  const f=await stores();try{
    const backup=authority();backup.routes[0].revision=50;await writeContactAuthority(f.target,backup);
    if(conflict!=='missing-current'){const current=authority();current.revision=conflict==='older-current'?9:10;current.routes[0].enabled=false;current.routes[0].revision=51;current.rules[0].revoked=true;await writeContactAuthority(f.source,current);}
    await retainContactJournalAcrossRollback(f.source,f.target);const saved=parseContactAuthority(await f.target.get(contactAuthorityKind,'main'));assert.equal(saved.state,'review-required');assert.deepEqual(saved.providers,{});assert.equal(saved.routes[0].enabled,false);assert.equal(saved.routes[0].optedIn,false);assert.ok(saved.routes[0].revision>50);assert.equal(saved.rules[0].revoked,true);assert.equal(saved.workflows[0].enabled,false);
    const owner=new DesktopContactOwner({store:f.target,vault:new ProtectedContactVault({read:()=>({}),write:()=>{throw Error('Unexpected write');}}),fetch:async()=>{throw Error('Unexpected provider request');},openAuthorization:async()=>{throw Error('Unexpected OAuth');}});
    const service=await createService({store:f.target,contactOwner:owner,adminToken:randomUUID(),key:()=>undefined});
    try{const result=await service.desktopContactAdministration({requestId:'read',expectedRevision:1,action:'status'},()=>{});assert.equal((result as any).status.state,'review-required');
      const denied=await service.desktopContactAdministration({requestId:'repair-denied',expectedRevision:saved.revision,action:'save-route',channel:'sms',destination:'+15550000003',kind:'self',optedIn:true},()=>{});assert.equal((denied as any).receipt.outcome,'unconfirmed');
    }finally{await service.app.close();}
    // Service owns target close; keep the fixture's final cleanup harmless.
    f.target.db=undefined;
  }finally{await f.cleanup();}
});

test('retention unions server event and administration claims and refuses conflicting identities',async()=>{
  const f=await stores();try{
    const backup=authority(),current=structuredClone(backup);current.revision++;current.events.push({id:'event',retired:false,requests:[{requestId:'original-send',binding:backup.rules[0].binding}]});current.actions.push({id:'original-ui-action',digest:'a'.repeat(64)});
    await writeContactAuthority(f.target,backup);await writeContactAuthority(f.source,current);await retainContactJournalAcrossRollback(f.source,f.target);await retainContactJournalAcrossRollback(f.source,f.target);
    const saved=parseContactAuthority(await f.target.get(contactAuthorityKind,'main'));assert.equal(saved.events.length,1);assert.equal(saved.events[0].requests[0].requestId,'original-send');assert.equal(saved.actions.length,1);
    saved.events[0].requests[0].requestId='conflicting-send';await writeContactAuthority(f.target,saved);await assert.rejects(retainContactJournalAcrossRollback(f.source,f.target));
  }finally{await f.cleanup();}
});

test('a higher global revision cannot hide regressed route authority or clear a retired event',async()=>{
  const f=await stores();try{
    const backup=authority();backup.events.push({id:'retired-completion',retired:true,requests:[]});const current=structuredClone(backup);current.revision++;current.routes[0].revision--;current.events[0].retired=false;
    await writeContactAuthority(f.source,current);await writeContactAuthority(f.target,backup);await retainContactJournalAcrossRollback(f.source,f.target);
    const saved=parseContactAuthority(await f.target.get(contactAuthorityKind,'main'));assert.equal(saved.state,'review-required');assert.equal(saved.routes[0].enabled,false);assert.ok(saved.routes[0].revision>backup.routes[0].revision);assert.equal(saved.events[0].retired,true);
  }finally{await f.cleanup();}
});

test('failed or silently stale authority readback cannot be a successful retention/configuration',async()=>{
  const f=await stores();try{
    const old=authority(),current=structuredClone(old);current.revision++;current.rules[0].revoked=true;await writeContactAuthority(f.source,current);await writeContactAuthority(f.target,old);
    const stale={get:f.target.get.bind(f.target),put:async(_kind:string,value:any)=>value};await assert.rejects(retainContactJournalAcrossRollback(f.source,stale));assert.equal(parseContactAuthority(await f.target.get(contactAuthorityKind,'main')).rules[0].revoked,false);
    await f.target.put('memory',{id:'unrelated',text:'Retained ordinary memory.'});await retainContactJournalAcrossRollback(f.source,f.target);assert.equal((await f.target.get('memory','unrelated'))!.text,'Retained ordinary memory.');
    const exported=JSON.stringify(await f.target.export());assert.equal(exported.includes(contactAuthorityKind),false);assert.equal(exported.includes(old.routes[0].destination),false);assert.equal(exported.includes(old.providers.twilio!.accountSid!),false);
  }finally{await f.cleanup();}
});

test('protected contact vault detects stale write/readback and never overwrites sibling fields',async()=>{
  const root={voice:'Designed A',contactSecrets:{'contact:generation:token':'old'}},vault=new ProtectedContactVault({read:()=>structuredClone(root),write:()=>{}});
  await assert.rejects(vault.write('contact:generation:token',randomBytes(16).toString('hex')));assert.equal(root.voice,'Designed A');assert.equal(root.contactSecrets['contact:generation:token'],'old');await assert.rejects(vault.read('contact:generation:token'));
});

test('interrupted receipt retention leaves reopened authority unavailable even for configuration',async()=>{
  const f=await stores();let service:Awaited<ReturnType<typeof createService>>|undefined;
  try{
    const current=authority(),previous={requestId:'previously-saved',expectedRevision:1,action:'configure-gmail',clientId:'fixture.apps.googleusercontent.com',sender:'sender@example.invalid'};
    current.actions.push({id:previous.requestId,digest:sha256(canonicalJson(previous)),receipt:{id:randomUUID(),requestId:previous.requestId,feature:'contacts',action:previous.action,observedAt:1,outcome:'completed',effect:'confirmed'}});
    const backup=structuredClone(current);backup.revision--;await writeContactAuthority(f.source,current);await writeContactAuthority(f.target,backup);
    const interrupted={get:f.target.get.bind(f.target),put:async(kind:string,value:any)=>{if(kind==='contact-outbox')throw Error('Fixture interrupted receipt commit.');return f.target.put(kind,value);}};
    await assert.rejects(retainContactJournalAcrossRollback(f.source,interrupted));
    const saved=parseContactAuthority(await f.target.get(contactAuthorityKind,'main'));assert.equal(saved.state,'retention-required');
    let network=0,writes=0;const owner=new DesktopContactOwner({store:f.target,vault:new ProtectedContactVault({read:()=>({voice:'Designed A'}),write:()=>{writes++;}}),fetch:async()=>{network++;throw Error('Unexpected network');},openAuthorization:async()=>{throw Error('Unexpected OAuth');}});
    service=await createService({store:f.target,contactOwner:owner,adminToken:randomUUID(),key:()=>undefined});
    const replay=await service.desktopContactAdministration(previous,()=>{});assert.equal(replay.receipt?.outcome,'unconfirmed');assert.equal(replay.status?.state,'retention-required');
    const request={requestId:'must-finish-retention',expectedRevision:saved.revision,action:'configure-gmail',clientId:'fixture.apps.googleusercontent.com',sender:'sender@example.invalid'};
    const reply=await service.desktopContactAdministration(request,()=>{});assert.equal(reply.receipt?.outcome,'unconfirmed');assert.equal(network,0);assert.equal(writes,0);
    assert.equal(parseContactAuthority(await f.target.get(contactAuthorityKind,'main')).state,'retention-required');
    const recover=await service.desktopContactAdministration({requestId:'no-bypass',expectedRevision:parseContactAuthority(await f.target.get(contactAuthorityKind,'main')).revision,action:'recover-setup',confirmation:'disable-unprovable-permissions'},()=>{});
    assert.equal(recover.receipt?.outcome,'unconfirmed');assert.equal(parseContactAuthority(await f.target.get(contactAuthorityKind,'main')).state,'retention-required');assert.equal(network,0);assert.equal(writes,0);
  }finally{if(service){await service.app.close();f.target.db=undefined;}await f.cleanup();}
});

test('actual empty rollback commits readiness only after all journals and repeats without creating authority',async()=>{
  const f=await stores();try{
    const original=f.target.put.bind(f.target);let fenced=false;
    const intercepted={get:f.target.get.bind(f.target),put:async(kind:string,value:any)=>{
      if(kind==='contact-outbox'){assert.equal(parseContactAuthority(await f.target.get(contactAuthorityKind,'main')).state,'retention-required');fenced=true;}
      return original(kind,value);
    }};
    await retainContactJournalAcrossRollback(f.source,intercepted);assert.equal(fenced,true);
    let saved=parseContactAuthority(await f.target.get(contactAuthorityKind,'main'));assert.equal(isEmptyContactAuthority(saved),true);
    saved.revision=87;await writeContactAuthority(f.target,saved);
    await retainContactJournalAcrossRollback(f.source,f.target);await retainContactJournalAcrossRollback(f.source,f.target);
    saved=parseContactAuthority(await f.target.get(contactAuthorityKind,'main'));assert.equal(saved.revision,87);assert.equal(isEmptyContactAuthority(saved),true);
  }finally{await f.cleanup();}
});

test('empty recovery stays retention-fenced when the paired journal copy fails',async()=>{
  const f=await stores();try{
    const row={id:'phone-claim',notificationId:'phone-claim',deviceId:'phone',bodySha256:'a'.repeat(64),state:'unconfirmed'};await f.source.put('paired-android-receipt',row);
    const put=f.target.put.bind(f.target),interrupted={get:f.target.get.bind(f.target),put:async(k:string,v:any)=>{if(k==='paired-android-receipt'){assert.equal(parseContactAuthority(await f.target.get(contactAuthorityKind,'main')).state,'retention-required');throw Error('Paired commit interrupted');}return put(k,v);}};
    await assert.rejects(retainContactJournalAcrossRollback(f.source,interrupted));assert.equal(parseContactAuthority(await f.target.get(contactAuthorityKind,'main')).state,'retention-required');
    // A fresh complete retention into a fresh recovered generation can prove
    // empty readiness; an interrupted record itself has no UI recovery bypass.
    const directory=await mkdtemp(path.join(os.tmpdir(),'capri-empty-retention-')),target=await new Store(directory,randomBytes(32)).init();try{
      await retainContactJournalAcrossRollback(f.source,target);assert.equal(isEmptyContactAuthority(parseContactAuthority(await target.get(contactAuthorityKind,'main'))),true);assert.equal((await target.get('paired-android-receipt',row.id))!.state,'unconfirmed');
    }finally{await target.close();await rm(directory,{recursive:true,force:true});}
  }finally{await f.cleanup();}
});

test('corrupt current authority fences rollback and corrupt recovered authority cannot be setup-recovered',async()=>{
  const f=await stores();let service:Awaited<ReturnType<typeof createService>>|undefined;try{
    await f.source.put(contactAuthorityKind,{id:'main',state:'not-a-record'});await assert.rejects(retainContactJournalAcrossRollback(f.source,f.target));
    assert.equal(parseContactAuthority(await f.target.get(contactAuthorityKind,'main')).state,'retention-required');
    await f.target.put(contactAuthorityKind,{id:'main',state:'not-a-record'});
    let touched=0;const owner=new DesktopContactOwner({store:f.target,vault:new ProtectedContactVault({read:()=>{touched++;throw Error('No credential reads');},write:()=>{touched++;throw Error('No credential writes');}}),fetch:async()=>{touched++;throw Error('No provider');},openAuthorization:async()=>{touched++;throw Error('No OAuth');}});
    service=await createService({store:f.target,contactOwner:owner,adminToken:randomUUID(),key:()=>undefined});
    await assert.rejects(service.desktopContactAdministration({requestId:'cannot-recover-corruption',expectedRevision:1,action:'recover-setup',confirmation:'disable-unprovable-permissions'},()=>{}));assert.equal(touched,0);
    assert.equal((await f.target.get(contactAuthorityKind,'main'))!.state,'not-a-record');
  }finally{if(service){await service.app.close();f.target.db=undefined;}await f.cleanup();}
});

test('structural emptiness excludes every nondefault limit and inert identity/tombstone',async()=>{
  for(const raw of [null,false,0,''])assert.throws(()=>parseContactAuthority(raw));
  const variants=[(s:ReturnType<typeof emptyContactAuthority>)=>{s.limits.android.dailyBudgetMicros=1;},
    (s:ReturnType<typeof emptyContactAuthority>)=>{s.limits.android.maxPerDay=2;},
    (s:ReturnType<typeof emptyContactAuthority>)=>{s.state='review-required';},
    (s:ReturnType<typeof emptyContactAuthority>)=>{s.state='retention-required';},
    (s:ReturnType<typeof emptyContactAuthority>)=>{s.events.push({id:'retired',retired:true,requests:[]});},
    (s:ReturnType<typeof emptyContactAuthority>)=>{s.actions.push({id:'claim',digest:'a'.repeat(64)});}];
  for(const change of variants){const f=await stores();try{const s=emptyContactAuthority();change(s);assert.equal(isEmptyContactAuthority(s),false);await writeContactAuthority(f.target,s);
    await retainContactJournalAcrossRollback(f.source,f.target);assert.equal(parseContactAuthority(await f.target.get(contactAuthorityKind,'main')).state,s.state==='retention-required'?'retention-required':'review-required');
  }finally{await f.cleanup();}}
});

async function recoveryFixture(){
  const f=await stores(),old=authority();old.state='review-required';old.limits.sms={enabled:true,unitCostMicros:100,maxDispatchCostMicros:100,dailyBudgetMicros:1000,maxPerMinute:2,maxPerDay:10};
  const intent={requestId:'old-request',binding:old.rules[0].binding};old.events.push({id:'old-event',retired:false,requests:[intent]});
  old.actions.push({id:'old-positive',digest:'b'.repeat(64),intent,challenge:{challengeId:'old-challenge',requestId:intent.requestId,expiresAt:2e12},receipt:{id:randomUUID(),requestId:'old-positive',feature:'contacts',action:'prepare-notification',observedAt:1,outcome:'completed',effect:'confirmed'}});
  await writeContactAuthority(f.target,old);
  const root={voice:'Designed A',sibling:{untouched:true},contactSecrets:{'contact:old:twilio':randomBytes(20).toString('hex')}};let reads=0,writes=0,network=0;
  const vault=new ProtectedContactVault({read:()=>{reads++;return structuredClone(root);},write:()=>{writes++;throw Error('Recovery cannot write vault');}});
  const owner=new DesktopContactOwner({store:f.target,vault,fetch:async()=>{network++;throw Error('Recovery cannot use provider');},openAuthorization:async()=>{throw Error('Recovery cannot open OAuth');}}),token=randomUUID();
  const service=await createService({store:f.target,contactOwner:owner,adminToken:token,key:()=>undefined,extensions:{profile:'self-test'}});
  const request={requestId:'recover',expectedRevision:old.revision,action:'recover-setup',confirmation:'disable-unprovable-permissions'};
  const status=()=>service.desktopContactAdministration({requestId:randomUUID(),expectedRevision:1,action:'status'},()=>{});
  return {...f,old,root,vault,owner,service,token,request,status,counts:()=>({reads,writes,network}),cleanup:async()=>{await service.app.close();f.target.db=undefined;await f.cleanup();}};
}

test('current main recovery durably unlocks only setup, preserves encrypted journals and strips replay caches once',async()=>{
  const f=await recoveryFixture();try{
    const journals=['contact-outbox','contact-outbox-receipt','contact-outbox-approval','paired-android-receipt'];
    // Opaque sentinels prove recovery never reads, rewrites or deletes any journal.
    for(const kind of journals)await f.target.put(kind,{id:'preserved',value:randomUUID()});
    const before=await Promise.all(journals.map(k=>f.target.get(k,'preserved'))),root=structuredClone(f.root);
    const reply=await f.service.desktopContactAdministration(f.request,()=>{});assert.equal(reply.receipt?.outcome,'completed');assert.equal(reply.receipt?.effect,'confirmed');
    const saved=parseContactAuthority(await f.target.get(contactAuthorityKind,'main'));assert.equal(saved.state,'ready');assert.ok(saved.revision>f.old.revision);assert.deepEqual(saved.providers,{});assert.deepEqual(saved.approvedText,[]);
    assert.deepEqual(saved.limits,emptyContactAuthority().limits);for(const r of saved.routes){assert.equal(r.enabled,false);assert.equal(r.optedIn,false);assert.ok(r.revision>f.old.routes[0].revision);assert.notEqual(r.providerGeneration,f.old.routes[0].providerGeneration);}
    for(const r of saved.rules)assert.equal(r.revoked,true);for(const t of saved.templates)assert.equal(t.enabled,false);for(const w of saved.workflows)assert.equal(w.enabled,false);
    assert.deepEqual(saved.events,[{...f.old.events[0],retired:true}]);assert.deepEqual(saved.actions.find(a=>a.id==='old-positive'),{id:'old-positive',digest:'b'.repeat(64)});
    assert.deepEqual(await Promise.all(journals.map(k=>f.target.get(k,'preserved'))),before);assert.deepEqual(f.root,root);assert.deepEqual(f.counts(),{reads:0,writes:0,network:0});
    const duplicate=await f.service.desktopContactAdministration(f.request,()=>{});assert.deepEqual(duplicate.receipt,reply.receipt);assert.deepEqual(parseContactAuthority(await f.target.get(contactAuthorityKind,'main')),saved);
    await assert.rejects(f.owner.options.resolve({requestId:'old-request',binding:f.old.rules[0].binding},{authority:'trusted-ui',privateSession:false,localOnly:false,signal:new AbortController().signal}));
    const exported=JSON.stringify(await f.target.export());assert.equal(exported.includes('old-event'),false);assert.equal(exported.includes('old-positive'),false);assert.equal(exported.includes(f.root.contactSecrets['contact:old:twilio']),false);
    assert.equal(JSON.stringify(reply).includes(f.old.routes[0].destination),false);
  }finally{await f.cleanup();}
});

for(const boundary of ['private','stale','renderer','confirmation','retention','protected-failure','stop-held-write'] as const)test('setup recovery refuses '+boundary,async()=>{
  const f=await recoveryFixture();try{
    let request:any={...f.request},current=()=>{};
    if(boundary==='private')await f.service.app.inject({method:'POST',url:'/v1/extensions/session',headers:{authorization:'Bearer '+f.token},payload:{privateSession:true,revision:1}});
    if(boundary==='stale')request.expectedRevision--;
    if(boundary==='renderer')current=()=>{throw Error('Avatar or retired main renderer');};
    if(boundary==='confirmation')request.confirmation='enable-old-permissions';
    if(boundary==='retention'){const s=structuredClone(f.old);s.state='retention-required';await writeContactAuthority(f.target,s);}
    if(boundary==='protected-failure')await assert.rejects(f.vault.write('contact:failed:twilio','fixture'));
    if(boundary==='stop-held-write'){const put=f.target.put.bind(f.target);let once=true;f.target.put=async(k,v)=>{const row=await put(k,v);if(k===contactAuthorityKind&&v.state==='ready'&&once){once=false;await f.service.assistant.stop();}return row;};}
    let reply:any;try{reply=await f.service.desktopContactAdministration(request,current);}catch{/* Denied authority may reject before a receipt. */}
    assert.notEqual(reply?.receipt?.outcome,'completed');assert.notEqual(parseContactAuthority(await f.target.get(contactAuthorityKind,'main')).state,'ready');assert.equal(f.counts().network,0);
    // A generic authenticated HTTP/tool caller still has no admin endpoint.
    const http=await f.service.app.inject({method:'POST',url:'/v1/extensions/contacts/recover-setup',headers:{authorization:'Bearer '+f.token},payload:{requestId:'http',input:{expectedRevision:10,confirmation:'disable-unprovable-permissions'}}});assert.notEqual(http.json().outcome,'completed');
    await assert.rejects(f.service.assistant.tool('notify_contact',{action:'recover-setup',confirmation:'disable-unprovable-permissions'},new AbortController().signal,false,'unowned'));
  }finally{await f.cleanup();}
});

test('an opaque task Hub context cannot substitute for current main recovery authority',async()=>{
  const f=await recoveryFixture();try{
    const controller=new AbortController(),privacyEpoch=randomUUID(),handle=f.service.hub.context(()=>({signal:controller.signal,authority:'task',taskId:'task',privateSession:false,localOnly:false,privacyEpoch}));
    const result=await f.owner.administer(f.request,{signal:controller.signal,privacyEpoch,revision:0,privateSession:false,assertCurrent:()=>controller.signal.throwIfAborted()},handle);
    assert.equal(result.receipt?.outcome,'unconfirmed');assert.equal(parseContactAuthority(await f.target.get(contactAuthorityKind,'main')).state,'review-required');assert.deepEqual(f.counts(),{reads:0,writes:0,network:0});
  }finally{await f.cleanup();}
});

test('recovered Android-only setup earns a fresh original-outbox challenge and sends one deduplicated explicit notification',async()=>{
  const f=await recoveryFixture();try{
    assert.equal((await f.service.desktopContactAdministration(f.request,()=>{})).receipt?.outcome,'completed');
    const status=async()=>(await f.status()).status!,admin=async(action:string,patch:Record<string,unknown>={},id=randomUUID())=>{
      const request={requestId:id,expectedRevision:(await status()).revision,action,...patch};return {request,reply:await f.service.desktopContactAdministration(request,()=>{})};
    };
    const global=await f.service.app.inject({method:'POST',url:'/v1/extensions/contacts/configure',headers:{authorization:'Bearer '+f.token},payload:{requestId:randomUUID(),input:{enabled:true,automaticEnabled:false}}});assert.equal(global.json().outcome,'completed');
    assert.equal((await admin('set-limits',{channel:'android',limits:{enabled:true,unitCostMicros:0,maxDispatchCostMicros:0,dailyBudgetMicros:0,maxPerMinute:10,maxPerDay:10}})).reply.receipt?.outcome,'completed');
    const phoneToken=randomBytes(24).toString('hex'),deviceId=sha256(phoneToken),frames:any[]=[];
    assert.equal((await admin('save-route',{channel:'android',destination:deviceId,kind:'self',optedIn:true})).reply.receipt?.outcome,'completed');
    const route=(await status()).routes.at(-1)!;assert.equal((await status()).channels.find(c=>c.channel==='android')!.ready,false);
    // Explicit authenticated phone socket fixture; this uses the service's real
    // StorePairedAndroidTransport, not a replacement contact provider.
    await f.target.put('device',{id:deviceId,role:'phone',revoked:false});
    f.service.pairedAndroid.attach(deviceId,{readyState:1,send:raw=>{frames.push(JSON.parse(raw));}});
    assert.equal((await status()).channels.find(c=>c.channel==='android')!.ready,false,'pairing without capability is unavailable');
    const capability=await f.service.app.inject({method:'POST',url:'/v1/android/capability',headers:{authorization:'Bearer '+phoneToken},payload:{protocol:androidProtocol,permission:'granted',channelEnabled:true}});assert.equal(capability.statusCode,200);
    assert.equal((await status()).channels.find(c=>c.channel==='android')!.ready,true);
    const verification=await admin('verify-begin',{routeId:route.id});assert.equal((verification.reply.result as any).state,'accepted');assert.equal(frames.length,1);
    assert.equal(frames[0].type,'android-notification');assert.equal(frames[0].deviceId,deviceId);assert.match(frames[0].body,/^Capri verification code: \d{6}$/);
    const code=frames[0].body.slice(-6),challenge=verification.reply.challenge!;assert.equal(JSON.stringify(verification.reply).includes(code),false);
    const repeated=await f.service.desktopContactAdministration(verification.request,()=>{});assert.deepEqual(repeated.challenge,challenge);assert.equal(frames.length,1);
    assert.equal((await admin('verify-complete',{routeId:route.id,challengeId:challenge.challengeId,code})).reply.receipt?.outcome,'completed');
    assert.equal((await status()).routes.find(r=>r.id===route.id)!.verified,true);
    assert.equal((await admin('save-template',{definition:{enabled:true,body:'Capri is {{status}}.',contentClass:'personal'}})).reply.receipt?.outcome,'completed');
    const templateId=(await status()).templates.at(-1)!.id;
    assert.equal((await admin('save-workflow',{definition:{enabled:true,trigger:'on-demand',routeId:route.id,templateId}})).reply.receipt?.outcome,'completed');
    const workflowId=(await status()).workflows.at(-1)!.id,notification=await admin('prepare-notification',{workflowId});
    assert.equal((notification.reply.result as any).delivery.state,'accepted');assert.equal(frames.length,2);assert.equal(frames[1].body,'Capri is requested.');
    await f.service.desktopContactAdministration(notification.request,()=>{});assert.equal(frames.length,2);
    const ack=await f.service.app.inject({method:'POST',url:'/v1/android/receipt',headers:{authorization:'Bearer '+phoneToken},payload:{deviceId,notificationId:frames[1].notificationId,bodySha256:frames[1].bodySha256,state:'delivered'}});assert.equal(ack.statusCode,200);
    const observed=await admin('reconcile',{outboxRequestId:notification.reply.intent!.requestId});assert.equal((observed.reply.result as any).state,'delivered');assert.equal(frames.length,2);
    assert.equal(f.counts().network,0);assert.equal(f.counts().writes,0);assert.equal(f.counts().reads,0);assert.equal(f.root.voice,'Designed A');
    assert.equal((await f.target.get('contact-outbox','main'))!.entries.filter((e:any)=>e.reservedAt!==undefined).length,2);
    assert.equal(JSON.stringify(await f.target.export()).includes('Capri is requested.'),false);
  }finally{await f.cleanup();}
});
