import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopContactOwner,ProtectedContactVault,assertDesktopContactSender,officialContactFetch} from '../src/desktop/contact-owner';
import {createService} from '../src/server/service';
import {Store} from '../src/server/store';
import {defaults} from '../src/shared';
import {retainContactJournalAcrossRollback} from '../src/extensions/contacts';
import {contactAuthorityKind,parseContactAuthority,writeContactAuthority,type ContactAdminRequest} from '../src/extensions/contact-admin';
import {contactCompletionIdentity} from '../src/server/contact-workflows';
import {sha256} from '../src/extensions/policy';
import type {TaskPermission} from '../src/agency';
import {approvalInput} from '../src/ui/extensions-api';

const account='AC'+'a'.repeat(32),contentSid='HX'+'b'.repeat(32),sender='+15550000001',recipient='+15550000002';
const response=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
async function fixture(){
  const directory=await mkdtemp(path.join(os.tmpdir(),'capri-owner-')),key=randomBytes(32),token=randomBytes(24).toString('hex');
  let store=await new Store(directory,key).init(),now=1_800_000_000_000,mode='queued',posts=0,gets=0,opens:string[]=[],root:Record<string,unknown>={voice:'Designed A',unrelated:{keep:true}};
  let beforeFetch:((url:string,init:RequestInit)=>Promise<void>)|undefined,afterVault:(()=>Promise<void>)|undefined,failVault=false,failRead=false,allowOAuth=false,contentBody='Capri is {{1}}.',contentTypes:Record<string,unknown>|undefined,approval='approved',contentPatch:Record<string,unknown>={},approvalPatch:Record<string,unknown>={};
  const sent=new Map<string,{to:string;from:string}>();
  const requests:{url:string;init:RequestInit}[]=[];
  const grants=new Map<string,TaskPermission>();
  let owner:DesktopContactOwner,service:Awaited<ReturnType<typeof createService>>;
  const open=async()=>{
    const protectedVault=new ProtectedContactVault({read:()=>{if(failRead)throw Error('fixture read failure');return structuredClone(root);},write:value=>{if(failVault)throw Error('fixture write failure');root=structuredClone(value);}});
    // A stable vault for this owner; the explicit async seam models a protected
    // write completing after its authenticated owner has been cancelled.
    const vault={assertUsable:()=>protectedVault.assertUsable(),read:(key:string)=>protectedVault.read(key),write:async(key:string,value:string)=>{await protectedVault.write(key,value);await afterVault?.();},delete:async(key:string)=>{await protectedVault.delete(key);await afterVault?.();}};
    owner=new DesktopContactOwner({store,vault,clock:()=>now,openAuthorization:async url=>{opens.push(url);},fetch:async(url,init)=>{
      requests.push({url,init});await beforeFetch?.(url,init);
      if(url==='https://oauth2.googleapis.com/token'&&init.method==='POST'&&allowOAuth)return response({access_token:randomBytes(20).toString('hex'),refresh_token:randomBytes(20).toString('hex'),expires_in:3600,token_type:'Bearer',scope:'https://www.googleapis.com/auth/gmail.send'});
      if(url==='https://content.twilio.com/v1/Content/'+contentSid&&init.method==='GET'){gets++;return response({sid:contentSid,account_sid:account,language:'en',types:contentTypes??{'twilio/text':{body:contentBody}},variables:{'1':'example'},...contentPatch});}
      if(url==='https://content.twilio.com/v1/Content/'+contentSid+'/ApprovalRequests'&&init.method==='GET'){gets++;return response({sid:contentSid,account_sid:account,whatsapp:{status:approval,content_type:'twilio/text'},...approvalPatch});}
      const messages='https://api.twilio.com/2010-04-01/Accounts/'+account+'/Messages';
      if(init.method==='POST'&&url===messages+'.json'){
        const form=new URLSearchParams(String(init.body??'')),to=form.get('To'),from=form.get('From');assert.ok(to);assert.ok(from);assert.equal(form.has('MaxPrice'),false);
        posts++;const sid='SM'+posts.toString(16).padStart(32,'0');sent.set(sid,{to,from});return response({sid,account_sid:account,to,from,direction:'outbound-api',status:mode});
      }
      if(init.method==='GET'&&url.startsWith(messages+'/')){const id=url.slice(messages.length+1,-5),record=sent.get(id);assert.equal(url,messages+'/'+id+'.json');assert.ok(record,'Only a matching existing provider record may be observed.');gets++;return response({sid:id,account_sid:account,...record,direction:'outbound-api',status:mode});}
      throw Error('Unexpected fixture provider request.');
    }});
    await store.put('settings',{...defaults,id:'main',providerMode:'local',initiative:false,retentionDays:0});
    service=await createService({store,adminToken:token,key:()=>undefined,contactOwner:owner,clock:()=>now,extensions:{profile:'self-test'},taskPermission:id=>grants.get(id),taskLifecycle:(phase,task)=>{if(phase==='start')grants.set(task.id,{taskId:task.id,request:task.text,mode:'scoped',createdAt:now,revoked:false});else if(phase==='end')grants.delete(task.id);}});
  };await open();
  const status=async()=>((await service.desktopContactAdministration({requestId:randomUUID(),expectedRevision:1,action:'status'},()=>{})) as any).status;
  const admin=async(action:ContactAdminRequest['action'],patch:Record<string,unknown>={},request?:unknown)=>service.desktopContactAdministration(request??{requestId:randomUUID(),expectedRevision:(await status()).revision,action,...patch},()=>{}) as Promise<any>;
  const http=(action:string,input:unknown,requestId=randomUUID())=>service.app.inject({method:'POST',url:'/v1/extensions/contacts/'+action,headers:{authorization:'Bearer '+token},payload:{requestId,input}});
  const configure=async()=>{
    assert.equal((await admin('configure-twilio',{accountSid:account,authToken:randomBytes(20).toString('hex'),sender,voiceEnabled:false})).receipt.outcome,'completed');
    assert.equal((await admin('set-limits',{channel:'sms',limits:{enabled:true,unitCostMicros:100,maxDispatchCostMicros:1000,dailyBudgetMicros:10000,maxPerMinute:10,maxPerDay:50}})).receipt.outcome,'completed');
    assert.equal((await http('configure',{enabled:true,automaticEnabled:true})).json().outcome,'completed');
    assert.equal((await admin('save-route',{channel:'sms',destination:recipient,kind:'self',optedIn:true})).receipt.outcome,'completed');
    return (await status()).routes.at(-1).id as string;
  };
  const verify=async(routeId:string,advance=true)=>{
    const r=await admin('verify-begin',{routeId});assert.equal(r.result.state,'accepted');
    const journal=await store.get('contact-outbox','main'),code=journal!.challenges.find((c:any)=>c.id===r.challenge.challengeId).code;
    assert.equal((await admin('verify-complete',{routeId,challengeId:r.challenge.challengeId,code})).receipt.outcome,'completed');if(advance)now+=86400001;return r;
  };
  const workflow=async(routeId:string,trigger='on-demand',contentClass='personal',body='Capri is {{status}}.')=>{
    await admin('save-template',{definition:{enabled:true,body,contentClass}});const templateId=(await status()).templates.at(-1).id;
    await admin('save-workflow',{definition:{enabled:true,trigger,routeId,templateId}});return (await status()).workflows.at(-1).id as string;
  };
  return {get store(){return store;},get owner(){return owner;},get service(){return service;},directory,key,token,admin,status,http,configure,verify,workflow,
    grants,
    posts:()=>posts,gets:()=>gets,opens:()=>opens,requests:()=>requests,root:()=>root,now:()=>now,advance:(n:number)=>now+=n,mode:(value:string)=>mode=value,oauth:()=>allowOAuth=true,
    content:(value:string)=>contentBody=value,types:(value:Record<string,unknown>|undefined)=>contentTypes=value,approval:(value:string)=>approval=value,catalog:(content:Record<string,unknown>={},approved:Record<string,unknown>={})=>{contentPatch=content;approvalPatch=approved;},
    before:(fn:typeof beforeFetch)=>beforeFetch=fn,afterVault:(fn:typeof afterVault)=>afterVault=fn,vaultFailure:(read=false,value=true)=>{if(read)failRead=value;else failVault=value;},
    reopen:async()=>{await service.app.close();store=await new Store(directory,key).init();await open();},
    cleanup:async()=>{await service.app.close();await rm(directory,{recursive:true,force:true});}};
}

test('default real owner composition is unconfigured and status never contacts a provider',async()=>{
  const f=await fixture();try{
    assert.equal((await f.status()).channels.some((c:any)=>c.configured||c.enabled),false);
    const status=await f.service.app.inject({method:'GET',url:'/v1/extensions/status',headers:{authorization:'Bearer '+f.token}});
    assert.equal(status.json().features.contacts.available,false);assert.equal(f.requests().length,0);assert.equal(f.posts(),0);assert.equal(f.opens().length,0);
    const rows=await f.service.app.inject({method:'GET',url:'/v1/extensions/contacts/outbox',headers:{authorization:'Bearer '+f.token}});assert.deepEqual(rows.json().outbox,[]);
  }finally{await f.cleanup();}
});

test('desktop HTTPS transport allows only fixed provider operations and forces no redirects',async t=>{
  const base='https://api.twilio.com/2010-04-01/Accounts/'+account+'/',sid='SM'+'1'.repeat(32),call='CA'+'2'.repeat(32),gmailSend='https://gmail.googleapis.com/'+['gmail','v1','users','me','messages','send'].join('/');
  const allowed=new Map([[base+'Messages.json','POST'],[base+'Calls.json','POST'],[base+'Messages/'+sid+'.json','GET'],[base+'Calls/'+call+'.json','GET'],['https://oauth2.googleapis.com/token','POST'],[gmailSend,'POST'],['https://content.twilio.com/v1/Content/'+contentSid,'GET'],['https://content.twilio.com/v1/Content/'+contentSid+'/ApprovalRequests','GET']]);
  let requests=0;t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{assert.equal(allowed.get(url),init.method,'Unexpected fixture operation.');assert.equal(init.redirect,'error');assert.ok(init.signal);requests++;return response({});});
  for(const [url,method] of allowed)await officialContactFetch(url,{method,redirect:'follow'});
  assert.equal(requests,allowed.size);
  for(const [url,method] of [[base+'Messages.json','GET'],[base+'Messages/'+sid+'.json','POST'],[base+'Calls/'+sid+'.json','GET'],['http://api.twilio.com/2010-04-01/Accounts/'+account+'/Messages.json','POST'],['https://content.twilio.com/v1/Content/'+contentSid+'/ApprovalRequests/whatsapp','POST'],[gmailSend+'?extra=1','POST'],['https://example.invalid/token','POST']])await assert.rejects(officialContactFetch(url,{method}));
  assert.equal(requests,allowed.size);
});

test('actual authenticated task completion produces one nonprivate alert and rollback/restart never replays its event',async()=>{
  const f=await fixture(),recoveredDir=await mkdtemp(path.join(os.tmpdir(),'capri-completion-rollback-'));let recovered:Store|undefined;
  try{
    const route=await f.configure();await f.verify(route);await f.workflow(route,'task-completed');recovered=await new Store(recoveredDir,f.key).init();
    await recovered.put(contactAuthorityKind,await f.store.get(contactAuthorityKind,'main'));await recovered.put('contact-outbox',await f.store.get('contact-outbox','main'));
    f.service.assistant.router.available=async()=>true;f.service.assistant.call=async()=>({output:[{type:'message',content:[{type:'output_text',text:'A short answer.'}]}]});
    const id=randomUUID(),headers={authorization:'Bearer '+f.token},count=f.posts();
    assert.equal((await f.service.app.inject({method:'POST',url:'/v1/chat',headers,payload:{id,text:'Explain a small idea.'}})).statusCode,200);await f.service.assistant.jobs.get(id);
    assert.equal((await f.store.get('task',id))!.status,'completed');assert.equal((await f.store.get('task',id))!.taskVerified,false);assert.equal(f.posts(),count+1);assert.equal(new URLSearchParams(String(f.requests().at(-1)!.init.body)).get('Body'),'Capri is completed-unverified.');
    const event=parseContactAuthority(await f.store.get(contactAuthorityKind,'main')).events.find(e=>e.id===contactCompletionIdentity(id))!;assert.equal(event.requests.length,1);const intent=event.requests[0];
    await f.service.app.inject({method:'POST',url:'/v1/chat',headers,payload:{id,text:'Explain a small idea.'}});await f.service.assistant.stop();assert.equal(f.posts(),count+1);
    await retainContactJournalAcrossRollback(f.store,recovered);assert.deepEqual(parseContactAuthority(await recovered.get(contactAuthorityKind,'main')).events.find(e=>e.id===event.id),event);
    let requests=0;const owner=new DesktopContactOwner({store:recovered,vault:new ProtectedContactVault({read:()=>structuredClone(f.root()),write:()=>{throw Error('Unexpected vault write');}}),clock:f.now,fetch:async()=>{requests++;throw Error('No retrospective provider operation');},openAuthorization:async()=>{throw Error('Unexpected OAuth');}}),service=await createService({store:recovered,adminToken:randomUUID(),key:()=>undefined,contactOwner:owner,clock:f.now});
    try{const result=await service.desktopContactAdministration({requestId:'status',expectedRevision:1,action:'status'},()=>{});assert.ok(result);assert.equal(requests,0);assert.equal((await recovered.get('contact-outbox','main'))!.entries.find((e:any)=>e.intent.requestId===intent.requestId).receipt.state,'accepted');}finally{await service.app.close();recovered.db=undefined;}
  }finally{await recovered?.close();await f.cleanup();await rm(recoveredDir,{recursive:true,force:true});}
});

test('private and local-only actual task completions cannot enter automatic alerts or acquire authority later',async()=>{
  const f=await fixture();try{
    const route=await f.configure();await f.verify(route);await f.workflow(route,'task-completed');f.service.assistant.router.available=async()=>true;f.service.assistant.call=async()=>({output:[{type:'message',content:[{type:'output_text',text:'A short answer.'}]}]});
    const headers={authorization:'Bearer '+f.token},count=f.posts(),id=randomUUID();await f.service.app.inject({method:'POST',url:'/v1/chat',headers,payload:{id,text:'Explain a small idea local-only.'}});await f.service.assistant.jobs.get(id);assert.equal(f.posts(),count);assert.equal(parseContactAuthority(await f.store.get(contactAuthorityKind,'main')).events.find(e=>e.id===contactCompletionIdentity(id))!.retired,true);
    const session=(await f.service.app.inject({method:'POST',url:'/v1/extensions/session',headers,payload:{privateSession:true,revision:1}})).json(),privateId=randomUUID();await f.service.app.inject({method:'POST',url:'/v1/chat',headers,payload:{id:privateId,text:'Explain a private idea.',private:true,privacyEpoch:session.privacyEpoch}});await f.service.assistant.jobs.get(privateId);assert.equal(f.posts(),count);
    await f.service.app.inject({method:'POST',url:'/v1/extensions/session',headers,payload:{privateSession:false,revision:2}});assert.equal(f.posts(),count);assert.equal(parseContactAuthority(await f.store.get(contactAuthorityKind,'main')).events.find(e=>e.id===contactCompletionIdentity(privateId))!.retired,true);
  }finally{await f.cleanup();}
});

test('a route mutation requested during awaited provider preparation fences dispatch before the mutation commits',async()=>{
  const f=await fixture();try{
    const route=await f.configure();await f.verify(route);const workflow=await f.workflow(route),count=f.posts();let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),provider=f.owner.options.providers.find(p=>p.channel==='sms')!,original=provider.prepare.bind(provider);
    provider.prepare=async(message,signal)=>{entered();await gate;return original(message,signal);};
    const send=f.admin('prepare-notification',{workflowId:workflow});await waiting;const expectedRevision=parseContactAuthority(await f.store.get(contactAuthorityKind,'main')).revision,revoke=f.admin('disable-route',{}, {requestId:randomUUID(),expectedRevision,action:'disable-route',routeId:route});
    // Wait for the explicit administration request to claim its synchronous fence.
    await new Promise(resolve=>setImmediate(resolve));release();await send;await revoke;assert.equal(f.posts(),count);
  }finally{await f.cleanup();}
});

test('OAuth success has durable protected readback and single callback; rotation closes the next listener',async()=>{
  const f=await fixture();try{
    f.oauth();await f.admin('configure-gmail',{clientId:'fixture.apps.googleusercontent.com',sender:'sender@example.invalid'});await f.admin('connect-gmail');const url=new URL(f.opens()[0]),callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('state',url.searchParams.get('state')!);callback.searchParams.set('code','fixture-code');
    const completed=await fetch(callback);assert.equal(completed.status,200);assert.equal((await f.status()).channels.find((c:any)=>c.channel==='gmail').configured,true);assert.equal(f.requests().length,1);await assert.rejects(fetch(callback,{signal:AbortSignal.timeout(1000)}));
    await f.admin('connect-gmail');const next=new URL(new URL(f.opens()[1]).searchParams.get('redirect_uri')!);await f.admin('configure-gmail',{clientId:'another.apps.googleusercontent.com',sender:'another@example.invalid'});await assert.rejects(fetch(next,{signal:AbortSignal.timeout(1000)}));assert.equal((await f.status()).channels.find((c:any)=>c.channel==='gmail').configured,false);assert.equal(f.posts(),0);
  }finally{await f.cleanup();}
});

test('owner WhatsApp review contains the actual approved rendered text, SID and every substitution',async()=>{
  const f=await fixture();try{
    await f.configure();await f.admin('set-limits',{channel:'whatsapp',limits:{enabled:true,unitCostMicros:100,maxDispatchCostMicros:1000,dailyBudgetMicros:10000,maxPerMinute:10,maxPerDay:50}});
    f.content('Capri verification code: {{1}}');await f.admin('recheck-whatsapp',{contentSid,language:'en'});await f.admin('save-route',{channel:'whatsapp',destination:recipient,kind:'contact',optedIn:true});const route=(await f.status()).routes.at(-1).id;await f.verify(route,false);
    f.content('Capri is {{1}}.');await f.admin('recheck-whatsapp',{contentSid,language:'en'});await f.admin('save-template',{definition:{enabled:true,body:'Capri is {{status}}.',contentClass:'personal',whatsappSid:contentSid}});const template=(await f.status()).templates.at(-1).id;await f.admin('save-workflow',{definition:{enabled:true,trigger:'on-demand',routeId:route,templateId:template}});const workflow=(await f.status()).workflows.at(-1).id;
    const request=await f.admin('prepare-notification',{workflowId:workflow});assert.equal(request.result.outcome,'pending');const count=f.posts(),headers={authorization:'Bearer '+f.token},session=(await f.service.app.inject({method:'GET',url:'/v1/extensions/session',headers})).json();
    const preview=(await f.http('review-details',{outboxRequestId:request.intent.requestId,privacyEpoch:session.privacyEpoch})).json();assert.equal(preview.channel,'whatsapp');assert.equal(preview.content.kind,'message');const text=JSON.parse(preview.content.body);assert.equal(text.renderedText,'Capri is requested.');assert.equal(text.contentSid,contentSid);assert.deepEqual(text.variables,{'1':'requested'});assert.equal(f.posts(),count);
    const approved=await f.http('approve',approvalInput(preview));assert.equal(approved.json().outcome,'completed');assert.equal(f.posts(),count+1);const form=new URLSearchParams(String(f.requests().at(-1)!.init.body));assert.equal(form.get('ContentSid'),contentSid);assert.equal(form.get('ContentVariables'),JSON.stringify({'1':'requested'}));assert.equal(form.has('Body'),false);
  }finally{await f.cleanup();}
});

test('expired WhatsApp setup pins cannot authorize a preview, approval or new send without explicit recheck',async()=>{
  const f=await fixture();try{
    await f.configure();await f.admin('set-limits',{channel:'whatsapp',limits:{enabled:true,unitCostMicros:100,maxDispatchCostMicros:1000,dailyBudgetMicros:10000,maxPerMinute:10,maxPerDay:50}});
    f.content('Capri verification code: {{1}}');await f.admin('recheck-whatsapp',{contentSid,language:'en'});await f.admin('save-route',{channel:'whatsapp',destination:recipient,kind:'contact',optedIn:true});const route=(await f.status()).routes.at(-1).id;await f.verify(route,false);
    f.content('Capri is {{1}}.');await f.admin('recheck-whatsapp',{contentSid,language:'en'});await f.admin('save-template',{definition:{enabled:true,body:'Capri is {{status}}.',contentClass:'personal',whatsappSid:contentSid}});const template=(await f.status()).templates.at(-1).id;
    await f.admin('save-workflow',{definition:{enabled:true,trigger:'on-demand',routeId:route,templateId:template}});const workflow=(await f.status()).workflows.at(-1).id,prepared=await f.admin('prepare-notification',{workflowId:workflow});
    const headers={authorization:'Bearer '+f.token},session=(await f.service.app.inject({method:'GET',url:'/v1/extensions/session',headers})).json(),preview=(await f.http('review-details',{outboxRequestId:prepared.intent.requestId,privacyEpoch:session.privacyEpoch})).json(),count=f.posts(),gets=f.gets();
    assert.equal(preview.channel,'whatsapp');f.advance(86400001);
    assert.equal((await f.status()).channels.find((c:any)=>c.channel==='whatsapp').ready,false);
    assert.notEqual((await f.http('review-details',{outboxRequestId:prepared.intent.requestId,privacyEpoch:session.privacyEpoch})).statusCode,200);
    assert.equal((await f.http('approve',approvalInput(preview))).json().outcome,'rejected');
    assert.equal((await f.admin('prepare-notification',{workflowId:workflow})).receipt.outcome,'unconfirmed');assert.equal(f.posts(),count);assert.equal(f.gets(),gets);
    await f.admin('recheck-whatsapp',{contentSid,language:'en'});assert.equal(f.gets(),gets+2);
    assert.equal((await f.http('approve',approvalInput(preview))).json().outcome,'rejected');assert.equal(f.posts(),count);
  }finally{await f.cleanup();}
});

test('notify_contact resolves only a draft prepared for the real live task and cannot replay after grant loss',async()=>{
  const f=await fixture();let release:(()=>void)|undefined;try{
    const route=await f.configure();await f.verify(route);const workflow=await f.workflow(route);f.service.assistant.router.available=async()=>true;
    let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);f.service.assistant.call=async()=>{entered();await gate;return {output:[{type:'message',content:[{type:'output_text',text:'A short answer.'}]}]};};
    const id=randomUUID();await f.service.app.inject({method:'POST',url:'/v1/chat',headers:{authorization:'Bearer '+f.token},payload:{id,text:'Explain a small idea.'}});await waiting;
    const prepared=await f.admin('prepare-notification',{workflowId:workflow,taskId:id});assert.equal(prepared.result.outcome,'completed');const count=f.posts(),signal=f.service.assistant.controllers.get(id)!.signal;
    assert.equal((await f.service.assistant.tool('notify_contact',prepared.intent,signal,false,id)).outcome,'completed');assert.equal(f.posts(),count);
    await assert.rejects(f.service.assistant.tool('notify_contact',{...prepared.intent,body:'injected'},signal,false,id));
    const grant=f.grants.get(id)!;grant.revoked=true;await assert.rejects(f.service.assistant.tool('notify_contact',prepared.intent,signal,false,id));assert.equal(f.posts(),count);
    release!();await f.service.assistant.jobs.get(id);
  }finally{release?.();await f.cleanup();}
});

test('exact reviewed rule authorizes only future matching completion, and its revoke blocks subsequent events',async()=>{
  const f=await fixture();try{
    const old=await f.configure();await f.verify(old);await f.admin('save-route',{routeId:old,channel:'sms',destination:recipient,kind:'contact',optedIn:true});await f.verify(old);
    const workflow=await f.workflow(old,'task-completed'),prepared=await f.admin('prepare-rule',{workflowId:workflow}),count=f.posts(),headers={authorization:'Bearer '+f.token},session=(await f.service.app.inject({method:'GET',url:'/v1/extensions/session',headers})).json();
    assert.equal(f.posts(),count);const preview=(await f.http('review-details',{outboxRequestId:prepared.intent.requestId,privacyEpoch:session.privacyEpoch})).json();assert.equal(preview.content.body,'Capri is completed-unverified.');
    const accepted=await f.admin('add-rule',{outboxRequestId:prepared.intent.requestId,review:approvalInput(preview),expiresAt:f.now()+86400000});assert.equal(accepted.receipt.outcome,'completed');assert.equal(f.posts(),count);
    f.service.assistant.router.available=async()=>true;f.service.assistant.call=async()=>({output:[{type:'message',content:[{type:'output_text',text:'A short answer.'}]}]});
    const complete=async()=>{const id=randomUUID();await f.service.app.inject({method:'POST',url:'/v1/chat',headers,payload:{id,text:'Explain a small idea.'}});await f.service.assistant.jobs.get(id);return id;};
    await complete();assert.equal(f.posts(),count+1);const rule=(await f.status()).rules.at(-1).id;await f.admin('revoke-rule',{ruleId:rule});await complete();assert.equal(f.posts(),count+1);
    assert.equal(parseContactAuthority(await f.store.get(contactAuthorityKind,'main')).events.length,2);
  }finally{await f.cleanup();}
});

test('main-frame authentication denies avatar, subframes, navigation and retired renderer',()=>{
  const frame={url:'http://127.0.0.1:18601/',isDestroyed:()=>false},webContents={mainFrame:frame},owner={webContents,isDestroyed:()=>false};
  assert.doesNotThrow(()=>assertDesktopContactSender({sender:webContents,senderFrame:frame},owner,frame.url,false));
  for(const event of [{sender:{},senderFrame:frame},{sender:webContents,senderFrame:{...frame}},{sender:webContents,senderFrame:null}])assert.throws(()=>assertDesktopContactSender(event,owner,frame.url,false));
  assert.throws(()=>assertDesktopContactSender({sender:webContents,senderFrame:frame},owner,frame.url,true));frame.url='https://example.invalid/';assert.throws(()=>assertDesktopContactSender({sender:webContents,senderFrame:frame},owner,'http://127.0.0.1:18601/',false));
});

test('setup readback/restart preserves unrelated vault data and private export exclusion',async()=>{
  const f=await fixture();try{
    const route=await f.configure();assert.ok(route);assert.equal(f.requests().length,0);const before=await f.status();await f.reopen();
    assert.deepEqual((await f.status()).routes,before.routes);assert.equal(f.root().voice,'Designed A');assert.deepEqual(f.root().unrelated,{keep:true});
    const exported=JSON.stringify(await f.store.export()),bytes=await readFile(path.join(f.directory,'capri.sqlite'));assert.equal(exported.includes(recipient),false);assert.equal(bytes.includes(Buffer.from(recipient)),false);
    assert.equal(JSON.stringify(await f.status()).includes(recipient),false);assert.equal(JSON.stringify(await f.status()).includes(account),false);assert.equal(JSON.stringify(await f.status()).includes('contactSecrets'),false);
  }finally{await f.cleanup();}
});

test('generic HTTP/task/cloud callers cannot administer credentials or route overrides',async()=>{
  const f=await fixture();try{
    for(const action of ['configure-gmail','configure-twilio','save-route','verify-begin','recheck-whatsapp'])assert.equal((await f.http(action,{approved:true})).json().outcome,'rejected');
    await assert.rejects(f.service.assistant.tool('notify_contact',{action:'configure-twilio'},new AbortController().signal,false,'unowned'));
    await assert.rejects(f.service.desktopContactAdministration({requestId:'denied',expectedRevision:1,action:'status'},()=>{throw Error('untrusted renderer');}));assert.equal(f.posts(),0);
  }finally{await f.cleanup();}
  const directory=await mkdtemp(path.join(os.tmpdir(),'capri-cloud-contact-')),store=await new Store(directory,randomBytes(32)).init();const service=await createService({store,adminToken:randomUUID(),key:()=>undefined});
  try{await assert.rejects(service.desktopContactAdministration({requestId:'cloud',expectedRevision:1,action:'status'},()=>{}));}finally{await service.app.close();await rm(directory,{recursive:true,force:true});}
});

test('setup recovery retires live exact-review/challenge/action/event caches without touching original delivery history',async()=>{
  const f=await fixture();try{
    const route=await f.configure(),verification=await f.verify(route,false),workflow=await f.workflow(route),prepared=await f.admin('prepare-rule',{workflowId:workflow}),headers={authorization:'Bearer '+f.token};
    const session=(await f.service.app.inject({method:'GET',url:'/v1/extensions/session',headers})).json(),preview=(await f.http('review-details',{outboxRequestId:prepared.intent.requestId,privacyEpoch:session.privacyEpoch})).json();assert.ok(preview.reviewId);
    const state=parseContactAuthority(await f.store.get(contactAuthorityKind,'main'));state.state='review-required';state.events.push({id:'retired-on-recovery',retired:false,requests:[prepared.intent]});await writeContactAuthority(f.store,state);
    const root=structuredClone(f.root()),journal=await f.store.get('contact-outbox','main'),count=f.posts();
    const recovered=await f.admin('recover-setup',{confirmation:'disable-unprovable-permissions'});assert.equal(recovered.receipt.outcome,'completed');assert.equal(f.posts(),count);assert.deepEqual(f.root(),root);assert.deepEqual(await f.store.get('contact-outbox','main'),journal);
    assert.notEqual((await f.http('approve',approvalInput(preview))).json().outcome,'completed');
    assert.notEqual((await f.http('review-details',{outboxRequestId:prepared.intent.requestId,privacyEpoch:session.privacyEpoch})).statusCode,200);
    assert.equal((await f.admin('prepare-notification',{workflowId:workflow})).receipt.outcome,'unconfirmed');
    const oldClaim=parseContactAuthority(await f.store.get(contactAuthorityKind,'main')).actions.find(a=>a.id===verification.receipt.requestId)!;assert.equal(oldClaim.receipt,undefined);assert.equal(oldClaim.challenge,undefined);
    const event=parseContactAuthority(await f.store.get(contactAuthorityKind,'main')).events.find(e=>e.id==='retired-on-recovery')!;assert.equal(event.retired,true);assert.equal(event.requests[0].requestId,prepared.intent.requestId);
    assert.equal((await f.admin('verify-complete',{routeId:route,challengeId:verification.challenge.challengeId,code:'000000'})).receipt.outcome,'unconfirmed');assert.equal(f.posts(),count);
  }finally{await f.cleanup();}
});

for(const read of [false,true])test('protected vault failure cannot claim configuration or alter voice (read failure '+read+')',async()=>{
  const f=await fixture();try{f.vaultFailure(read);const result=await f.admin('configure-twilio',{accountSid:account,authToken:randomBytes(16).toString('hex'),sender,voiceEnabled:false});assert.equal(result.receipt.outcome,'unconfirmed');assert.equal(f.root().voice,'Designed A');
    // The failed provider remains unavailable without poisoning unrelated authority.
    assert.equal((await f.status()).state,'ready');assert.equal((await f.status()).channels.some((c:any)=>c.configured||c.ready),false);assert.equal(f.posts(),0);
  }finally{await f.cleanup();}
});

test('verification queues the original fixed challenge; code alone and self selection do not verify',async()=>{
  const f=await fixture();try{
    const route=await f.configure(),workflow=await f.workflow(route);
    assert.equal((await f.admin('prepare-notification',{workflowId:workflow})).result.outcome,'rejected');assert.equal(f.posts(),0);
    const result=await f.admin('verify-begin',{routeId:route});assert.equal(f.posts(),1);assert.equal(result.result.state,'accepted');assert.doesNotMatch(JSON.stringify(result),/Capri verification code/);
    const challenge=(await f.store.get('contact-outbox','main'))!.challenges[0];assert.equal(JSON.stringify(result).includes(challenge.code),false);
    const original=(await f.store.get('contact-outbox','main'))!.entries.find((e:any)=>e.intent.requestId===challenge.requestId).intent;
    assert.equal(JSON.stringify(result).includes(original.binding.bodySha256),false);
    for(const intent of [original,{...original,binding:{...original.binding,bodySha256:'a'.repeat(64)}}]){const denied=(await f.http('send',intent,intent.requestId)).json();assert.equal(denied.outcome,'rejected');assert.equal(denied.error.code,'forbidden');assert.equal(denied.delivery,undefined);}
    const reconciliation=await f.admin('reconcile',{outboxRequestId:challenge.requestId});assert.equal(reconciliation.result.kind,'verification');assert.equal(JSON.stringify(reconciliation).includes(original.binding.bodySha256),false);
    const safeRows=(await f.service.app.inject({method:'GET',url:'/v1/extensions/contacts/outbox',headers:{authorization:'Bearer '+f.token}})).json();assert.equal(JSON.stringify(safeRows).includes(original.binding.bodySha256),false);
    assert.equal((await f.admin('verify-complete',{routeId:route,challengeId:challenge.id,code:'000000'})).receipt.outcome,'unconfirmed');
    assert.equal((await f.admin('verify-complete',{routeId:route,challengeId:challenge.id,code:challenge.code})).receipt.outcome,'completed');
    assert.equal((await f.admin('verify-complete',{routeId:route,challengeId:challenge.id,code:challenge.code})).receipt.outcome,'unconfirmed');
    const overview=await f.service.app.inject({method:'GET',url:'/v1/extensions/contacts/outbox',headers:{authorization:'Bearer '+f.token}});assert.equal(overview.json().routes[0].verified,true);
  }finally{await f.cleanup();}
});

test('unconfirmed challenge never verifies with the correct code and is not retried',async()=>{
  const f=await fixture();try{
    const route=await f.configure();f.before(async()=>{throw Error('fixture uncertain network');});const result=await f.admin('verify-begin',{routeId:route});
    assert.equal(result.result.state,'unconfirmed');const challenge=(await f.store.get('contact-outbox','main'))!.challenges[0];
    assert.equal((await f.admin('verify-complete',{routeId:route,challengeId:challenge.id,code:challenge.code})).receipt.outcome,'unconfirmed');assert.equal(f.requests().length,1);
  }finally{await f.cleanup();}
});

test('duplicate administration request preserves original request/receipt without a second send, including restart',async()=>{
  const f=await fixture();try{
    const route=await f.configure();await f.verify(route);const workflow=await f.workflow(route),raw={requestId:randomUUID(),expectedRevision:(await f.status()).revision,action:'prepare-notification',workflowId:workflow};
    const result=await f.admin('prepare-notification',{},raw);assert.equal(result.result.delivery.state,'accepted');const count=f.posts();
    const duplicate=await f.admin('prepare-notification',{},raw);assert.deepEqual(duplicate.receipt,result.receipt);assert.deepEqual(duplicate.intent,result.intent);assert.equal(f.posts(),count);
    const conflict=await f.admin('prepare-notification',{}, {...raw,workflowId:'different'});assert.equal(conflict.receipt.requestId,raw.requestId);assert.equal(conflict.receipt.error.code,'conflict');assert.equal(f.posts(),count);
    const stale=await f.admin('prepare-notification',{}, {...raw,requestId:randomUUID()});assert.equal(stale.receipt.error.code,'conflict');assert.equal(stale.status.revision,(await f.status()).revision);assert.equal(f.posts(),count);
    await f.reopen();assert.deepEqual((await f.admin('prepare-notification',{},raw)).receipt,result.receipt);assert.equal(f.posts(),count);
  }finally{await f.cleanup();}
});

test('concurrent duplicate owner actions share the original outbox request and actual receipt',async()=>{
  const f=await fixture();try{
    const route=await f.configure();await f.verify(route);const workflow=await f.workflow(route),count=f.posts(),raw={requestId:randomUUID(),expectedRevision:(await f.status()).revision,action:'prepare-notification',workflowId:workflow};
    const results=await Promise.all([f.admin('prepare-notification',{},raw),f.admin('prepare-notification',{},structuredClone(raw))]);
    assert.equal(results[0].result.delivery.state,'accepted');assert.deepEqual(results[1],results[0]);assert.equal(f.posts(),count+1);
    const entries=(await f.store.get('contact-outbox','main'))!.entries.filter((e:any)=>e.intent.requestId===results[0].intent.requestId);assert.equal(entries.length,1);
  }finally{await f.cleanup();}
});

test('read-only reconciliation observes original record and cannot regress delivered/sent or POST',async()=>{
  const f=await fixture();try{
    const route=await f.configure();await f.verify(route);const workflow=await f.workflow(route),result=await f.admin('prepare-notification',{workflowId:workflow}),count=f.posts();
    f.mode('delivered');assert.equal((await f.admin('reconcile',{outboxRequestId:result.intent.requestId})).result.state,'delivered');
    f.mode('queued');assert.equal((await f.admin('reconcile',{outboxRequestId:result.intent.requestId})).result.state,'delivered');assert.equal(f.posts(),count);assert.equal(f.gets(),2);
    await f.admin('disable-twilio');await f.admin('reconcile',{outboxRequestId:result.intent.requestId});assert.equal(f.gets(),2);assert.equal(f.posts(),count);
  }finally{await f.cleanup();}
});

test('Stop and privacy changes close pending OAuth listener and late callback cannot reconnect',async()=>{
  for(const transition of ['stop','privacy','disconnect'] as const){const f=await fixture();try{
    f.oauth();await f.admin('configure-gmail',{clientId:'fixture.apps.googleusercontent.com',sender:'sender@example.invalid'});await f.admin('connect-gmail');assert.equal(f.opens().length,1);
    const authorization=new URL(f.opens()[0]),callback=new URL(authorization.searchParams.get('redirect_uri')!);callback.searchParams.set('state',authorization.searchParams.get('state')!);callback.searchParams.set('code','fixture-code');
    if(transition==='stop')await f.service.assistant.stop();else if(transition==='disconnect')await f.admin('disconnect-gmail');else await f.service.app.inject({method:'POST',url:'/v1/extensions/session',headers:{authorization:'Bearer '+f.token},payload:{privateSession:true,revision:1}});
    await assert.rejects(fetch(callback,{signal:AbortSignal.timeout(1000)}));assert.equal(f.requests().length,0);assert.equal((await f.status()).oauthPending,false);
  }finally{await f.cleanup();}}
});

test('OAuth loopback uses random owned path/PKCE, rejects state mismatch once and closes',async()=>{
  const f=await fixture();try{
    f.oauth();await f.admin('configure-gmail',{clientId:'fixture.apps.googleusercontent.com',sender:'sender@example.invalid'});await f.admin('connect-gmail');const url=new URL(f.opens()[0]);
    assert.equal(url.searchParams.get('scope'),'https://www.googleapis.com/auth/gmail.send');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
    const callback=new URL(url.searchParams.get('redirect_uri')!);assert.equal(callback.hostname,'127.0.0.1');assert.ok(Number(callback.port)>0);callback.searchParams.set('state','incorrect');callback.searchParams.set('code','fixture-code');
    await fetch(callback).catch(()=>{});assert.equal(f.requests().length,0);assert.equal((await f.status()).oauthPending,false);await assert.rejects(fetch(callback,{signal:AbortSignal.timeout(1000)}));
  }finally{await f.cleanup();}
});

test('quiet hours and zero/per-dispatch monetary limits block provider POSTs',async()=>{
  const f=await fixture();try{
    const route=await f.configure();await f.verify(route);const workflow=await f.workflow(route),count=f.posts();
    await f.admin('set-limits',{channel:'sms',limits:{enabled:true,unitCostMicros:100,maxDispatchCostMicros:100,dailyBudgetMicros:1000,maxPerMinute:10,maxPerDay:50,quietHours:{startMinute:0,endMinute:0,timeZone:'UTC'}}});
    assert.equal((await f.admin('prepare-notification',{workflowId:workflow})).result.outcome,'pending');assert.equal(f.posts(),count);
    await f.admin('set-limits',{channel:'sms',limits:{enabled:true,unitCostMicros:100,maxDispatchCostMicros:99,dailyBudgetMicros:1000,maxPerMinute:10,maxPerDay:50}});
    assert.equal((await f.admin('prepare-notification',{workflowId:workflow})).receipt.outcome,'unconfirmed');assert.equal(f.posts(),count);
  }finally{await f.cleanup();}
});

test('rollback carries consumed server events, revoked routes and original uncertain reservations',async()=>{
  const f=await fixture(),recoveredDir=await mkdtemp(path.join(os.tmpdir(),'capri-contact-restored-'));let recovered:Store|undefined;
  try{
    const route=await f.configure();await f.verify(route);const workflow=await f.workflow(route);recovered=await new Store(recoveredDir,f.key).init();
    await recovered.put(contactAuthorityKind,await f.store.get(contactAuthorityKind,'main'));await recovered.put('contact-outbox',await f.store.get('contact-outbox','main'));
    f.before(async()=>{throw Error('uncertain original dispatch');});const result=await f.admin('prepare-notification',{workflowId:workflow});const requestId=result.intent.requestId;
    await f.admin('disable-route',{routeId:route});const current=parseContactAuthority(await f.store.get(contactAuthorityKind,'main'));current.events.push({id:contactCompletionIdentity('task-once'),retired:true,requests:[result.intent]});await f.store.put(contactAuthorityKind,{id:'main',...current});
    await retainContactJournalAcrossRollback(f.store,recovered);const saved=parseContactAuthority(await recovered.get(contactAuthorityKind,'main'));
    assert.equal(saved.routes[0].enabled,false);assert.equal(saved.events[0].retired,true);assert.equal(saved.events[0].requests[0].requestId,requestId);
    const entry=(await recovered.get('contact-outbox','main'))!.entries.find((e:any)=>e.intent.requestId===requestId);assert.equal(entry.receipt.state,'unconfirmed');assert.equal(entry.reservedCost,100);assert.ok(entry.reservedAt);
    assert.equal(JSON.stringify(await recovered.export()).includes(recipient),false);assert.equal(f.root().voice,'Designed A');
    const reopenedOwner=new DesktopContactOwner({store:recovered,vault:new ProtectedContactVault({read:()=>f.root(),write:()=>{throw Error('not expected');}}),fetch:async()=>{throw Error('rollback must not request provider');},openAuthorization:async()=>{throw Error('not expected');}});
    const count=f.posts();const overview=await reopenedOwner.overview({authority:'trusted-ui',signal:new AbortController().signal,privateSession:false,localOnly:false});assert.equal(overview.routes[0].verified,false);assert.equal(f.posts(),count);await reopenedOwner.close();
    assert.equal(sha256(recipient).length,64);
  }finally{await recovered?.close();await f.cleanup();await rm(recoveredDir,{recursive:true,force:true});}
});

// Real owner/service/ContactsService and encrypted Store throughout. Only the
// explicit provider transport and OS-protection boundary are neutral fixtures.
type OwnerFixture=Awaited<ReturnType<typeof fixture>>;
const authority=async(f:OwnerFixture)=>parseContactAuthority(await f.store.get(contactAuthorityKind,'main'));
function configuration(value:Awaited<ReturnType<typeof authority>>){const {revision:_revision,actions:_actions,...config}=value;return config;}
function journalEvidence(value:any){const {updatedAt:_updatedAt,...evidence}=value;return evidence;}
async function configuredContacts(f:OwnerFixture){
  const route=await f.configure();
  await f.admin('save-route',{routeId:route,channel:'sms',destination:recipient,kind:'contact',optedIn:true});await f.verify(route);
  const workflow=await f.workflow(route,'task-completed'),prepared=await f.admin('prepare-rule',{workflowId:workflow});
  const headers={authorization:'Bearer '+f.token},session=(await f.service.app.inject({method:'GET',url:'/v1/extensions/session',headers})).json();
  const preview=(await f.http('review-details',{outboxRequestId:prepared.intent.requestId,privacyEpoch:session.privacyEpoch})).json();
  assert.equal((await f.admin('add-rule',{outboxRequestId:prepared.intent.requestId,review:approvalInput(preview),expiresAt:f.now()+86400000})).receipt.outcome,'completed');
  f.oauth();assert.equal((await f.admin('configure-gmail',{clientId:'fixture.apps.googleusercontent.com',sender:'sender@example.invalid'})).receipt.outcome,'completed');
  assert.equal((await f.admin('connect-gmail')).receipt.outcome,'completed');
  const url=new URL(f.opens().at(-1)!),callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('state',url.searchParams.get('state')!);callback.searchParams.set('code','fixture-code');
  assert.equal((await fetch(callback)).status,200);
  const limits={enabled:true,unitCostMicros:100,maxDispatchCostMicros:1000,dailyBudgetMicros:10000,maxPerMinute:10,maxPerDay:50};
  await f.admin('set-limits',{channel:'gmail',limits});await f.admin('set-limits',{channel:'whatsapp',limits});
  assert.equal((await f.admin('recheck-whatsapp',{contentSid,language:'en'})).receipt.outcome,'completed');
  await f.admin('save-template',{definition:{enabled:true,body:'Capri is {{status}}.',contentClass:'personal',whatsappSid:contentSid}});
  const snapshot=await authority(f),status=await f.status();
  assert.equal(status.channels.find((c:any)=>c.channel==='gmail').ready,true);assert.equal(status.channels.find((c:any)=>c.channel==='sms').ready,true);
  assert.equal(status.routes.find((r:any)=>r.id===route).verified,true);assert.equal(snapshot.rules.length,1);assert.equal(snapshot.rules[0].revoked,false);
  return {route,workflow,template:snapshot.templates.at(-1)!.id};
}
async function proveRuleUsable(f:OwnerFixture){
  // This is one deliberate fake dispatch AFTER the zero-POST refusal assertions.
  const count=f.posts(),id=randomUUID();f.service.assistant.router.available=async()=>true;
  f.service.assistant.call=async()=>({output:[{type:'message',content:[{type:'output_text',text:'A short answer.'}]}]});
  await f.service.app.inject({method:'POST',url:'/v1/chat',headers:{authorization:'Bearer '+f.token},payload:{id,text:'Explain a small idea.'}});await f.service.assistant.jobs.get(id);
  assert.equal((await f.store.get('task',id))!.status,'completed');assert.equal(f.posts(),count+1);
  const form=new URLSearchParams(String(f.requests().at(-1)!.init.body));assert.equal(form.get('Body'),'Capri is completed-unverified.');assert.equal(form.get('To'),recipient);assert.equal(form.get('From'),sender);
}
const noConfirmedReceipt=(result:PromiseSettledResult<any>)=>{if(result.status==='fulfilled')assert.notEqual(result.value.receipt?.effect,'confirmed');};

test('invalid canonical destinations and unknown admin relationships leave ready providers, verified routes and exact rules unchanged',async()=>{
  const f=await fixture();try{
    const ids=await configuredContacts(f),before=await authority(f),journal=await f.store.get('contact-outbox','main'),vault=structuredClone(f.root()),posts=f.posts(),providerPosts=f.requests().filter(r=>r.init.method==='POST').length;
    const edits:[ContactAdminRequest['action'],Record<string,unknown>][]=[
      ['save-route',{routeId:ids.route,channel:'sms',destination:'not-a-canonical-phone',kind:'self',optedIn:true}],
      ['save-route',{routeId:'missing',channel:'sms',destination:recipient,kind:'self',optedIn:true}],
      ['disable-route',{routeId:'missing'}],['save-template',{templateId:'missing',definition:{enabled:true,body:'Changed.',contentClass:'public'}}],
      ['save-workflow',{workflowId:'missing',definition:{enabled:true,trigger:'on-demand',routeId:ids.route,templateId:ids.template}}],
      ['save-workflow',{definition:{enabled:true,trigger:'on-demand',routeId:'missing',templateId:ids.template}}],
      ['save-workflow',{definition:{enabled:true,trigger:'on-demand',routeId:ids.route,templateId:'missing'}}],
      ['revoke-rule',{ruleId:'missing'}],['prepare-rule',{workflowId:'missing'}],['prepare-notification',{workflowId:'missing'}],
      ['configure-gmail',{clientId:'fixture.apps.googleusercontent.com',sender:'invalid-address'}],
      ['configure-twilio',{accountSid:account,authToken:randomBytes(20).toString('hex'),sender:'invalid-phone',voiceEnabled:false}],
    ];
    for(const [action,patch] of edits){const result=await f.admin(action,patch);assert.equal(result.receipt.outcome,'unconfirmed',action);assert.deepEqual(configuration(await authority(f)),configuration(before),action);}
    assert.equal(f.posts(),posts);assert.equal(f.requests().filter(r=>r.init.method==='POST').length,providerPosts);assert.deepEqual(f.root(),vault);assert.deepEqual(journalEvidence(await f.store.get('contact-outbox','main')),journalEvidence(journal));assert.deepEqual((await authority(f)).actions.slice(0,before.actions.length),before.actions);
    assert.ok((await authority(f)).revision>before.revision);await f.reopen();assert.deepEqual(configuration(await authority(f)),configuration(before));assert.equal((await f.status()).routes.find((r:any)=>r.id===ids.route).verified,true);
    await proveRuleUsable(f);
  }finally{await f.cleanup();}
});

test('refused or failed read-only WhatsApp rechecks preserve prior approved text and unrelated usable authority with zero POSTs',async()=>{
  const f=await fixture();try{
    await configuredContacts(f);const before=await authority(f),posts=f.posts(),providerPosts=f.requests().filter(r=>r.init.method==='POST').length,vault=structuredClone(f.root());
    const cases:{name:string;content?:Record<string,unknown>;approved?:Record<string,unknown>;status?:string;network?:boolean}[]=[
      {name:'paused',status:'paused'},{name:'unapproved',status:'pending'},{name:'wrong-account',content:{account_sid:'AC'+'c'.repeat(32)}},
      {name:'wrong-sid',content:{sid:'HX'+'c'.repeat(32)}},{name:'wrong-approval-account',approved:{account_sid:'AC'+'c'.repeat(32)}},
      {name:'wrong-language',content:{language:'fr'}},{name:'rich-alternative',content:{types:{'twilio/text':{body:'Capri is {{1}}.'},'twilio/media':{media:['https://example.invalid/image']}}}},
      {name:'wrong-type',approved:{whatsapp:{status:'approved',content_type:'twilio/media'}}},
      {name:'missing-variable',content:{variables:{}}},{name:'extra-variable',content:{variables:{'1':'example','2':'extra'}}},{name:'network-failure',network:true},
    ];
    for(const item of cases){
      f.approval(item.status??'approved');f.catalog(item.content,item.approved);f.before(item.network?async()=>{throw Error('Neutral catalog failure');}:undefined);
      assert.equal((await f.admin('recheck-whatsapp',{contentSid,language:'en'})).receipt.outcome,'unconfirmed',item.name);
      assert.deepEqual(configuration(await authority(f)),configuration(before),item.name);
    }
    f.before(undefined);f.catalog();f.approval('approved');assert.equal(f.posts(),posts);assert.equal(f.requests().filter(r=>r.init.method==='POST').length,providerPosts);assert.deepEqual(f.root(),vault);
    await f.reopen();assert.deepEqual(configuration(await authority(f)),configuration(before));await proveRuleUsable(f);
  }finally{await f.cleanup();}
});

for(const transition of ['stop','private','revision','supersession'] as const)test('owner '+transition+' during awaited WhatsApp GET leaves previous configuration intact',async()=>{
  const f=await fixture();let release=()=>{};try{
    await configuredContacts(f);const before=await authority(f),posts=f.posts(),providerPosts=f.requests().filter(r=>r.init.method==='POST').length;
    let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
    f.before(async(url)=>{if(url.endsWith('/'+contentSid)){entered();await gate;}});
    const pending=Promise.allSettled([f.admin('recheck-whatsapp',{contentSid,language:'en'})]);await waiting;
    let newer:Promise<any>|undefined;
    if(transition==='stop')await f.service.assistant.stop();
    else if(transition==='supersession'){newer=f.admin('cancel-gmail',{}, {requestId:randomUUID(),expectedRevision:(await authority(f)).revision,action:'cancel-gmail'});await new Promise(r=>setImmediate(r));}
    else await f.service.app.inject({method:'POST',url:'/v1/extensions/session',headers:{authorization:'Bearer '+f.token},payload:{privateSession:transition==='private',revision:1}});
    release();noConfirmedReceipt((await pending)[0]);await newer;f.before(undefined);
    assert.deepEqual(configuration(await authority(f)),configuration(before));assert.equal(f.posts(),posts);assert.equal(f.requests().filter(r=>r.init.method==='POST').length,providerPosts);
    if(transition==='private')await f.service.app.inject({method:'POST',url:'/v1/extensions/session',headers:{authorization:'Bearer '+f.token},payload:{privateSession:false,revision:2}});
    await proveRuleUsable(f);
  }finally{release();await f.cleanup();}
});

test('read-only preparation cannot overwrite a newer durable route tombstone',async()=>{
  const f=await fixture();let release=()=>{};try{
    const ids=await configuredContacts(f);let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);f.before(async url=>{if(url.endsWith('/'+contentSid)){entered();await gate;}});
    const pending=f.admin('recheck-whatsapp',{contentSid,language:'en'});await waiting;
    const newer=await authority(f);newer.revision++;newer.routes.find(r=>r.id===ids.route)!.enabled=false;newer.routes.find(r=>r.id===ids.route)!.revision++;newer.rules[0].revoked=true;
    await f.store.put(contactAuthorityKind,{id:'main',...newer});const posts=f.posts();release();assert.equal((await pending).receipt.outcome,'unconfirmed');
    assert.deepEqual(await authority(f),newer);assert.equal(f.posts(),posts);f.before(undefined);await f.reopen();assert.equal((await f.status()).rules[0].revoked,true);
  }finally{release();await f.cleanup();}
});

for(const transition of ['stop','private','revision'] as const)test(transition+' after a read-back pure mutation fence restores identical verified authority at a higher revision',async()=>{
  const f=await fixture();let release=()=>{},restore=()=>{};try{
    const ids=await configuredContacts(f),before=await authority(f),journal=await f.store.get('contact-outbox','main'),posts=f.posts();
    let entered!:()=>void,writes=0;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),put=f.store.put.bind(f.store);
    f.store.put=async(kind,value)=>{const result=await put(kind,value);if(kind===contactAuthorityKind&&++writes===2){entered();await gate;}return result;};restore=()=>{f.store.put=put;};
    const pending=Promise.allSettled([f.admin('disable-route',{routeId:ids.route})]);await waiting;
    const fencedRevision=(await authority(f)).revision;assert.equal((await authority(f)).routes.find(r=>r.id===ids.route)!.enabled,false);
    if(transition==='stop')await f.service.assistant.stop();else await f.service.app.inject({method:'POST',url:'/v1/extensions/session',headers:{authorization:'Bearer '+f.token},payload:{privateSession:transition==='private',revision:1}});
    release();noConfirmedReceipt((await pending)[0]);restore();
    assert.deepEqual(configuration(await authority(f)),configuration(before));assert.ok((await authority(f)).revision>fencedRevision);assert.equal(f.posts(),posts);assert.deepEqual(journalEvidence(await f.store.get('contact-outbox','main')),journalEvidence(journal));
    if(transition==='private')await f.service.app.inject({method:'POST',url:'/v1/extensions/session',headers:{authorization:'Bearer '+f.token},payload:{privateSession:false,revision:2}});
    await f.reopen();assert.deepEqual(configuration(await authority(f)),configuration(before));assert.equal((await f.status()).routes.find((r:any)=>r.id===ids.route).verified,true);await proveRuleUsable(f);
  }finally{release();restore();await f.cleanup();}
});

async function uncertainNotification(f:OwnerFixture,route:string){
  const workflow=await f.workflow(route),request=await f.admin('prepare-notification',{workflowId:workflow});assert.equal(request.result.outcome,'pending');
  const session=(await f.service.app.inject({method:'GET',url:'/v1/extensions/session',headers:{authorization:'Bearer '+f.token}})).json();
  const preview=(await f.http('review-details',{outboxRequestId:request.intent.requestId,privacyEpoch:session.privacyEpoch})).json();f.mode('unknown-fixture-status');
  const posts=f.posts();await f.http('approve',approvalInput(preview));f.mode('queued');assert.equal(f.posts(),posts+1);
  const journal=await f.store.get('contact-outbox','main'),entry=journal!.entries.find((e:any)=>e.intent.requestId===request.intent.requestId);
  assert.equal(entry.receipt.state,'unconfirmed');assert.equal(entry.reservedCost,100);assert.ok(entry.approvalId);assert.equal((await f.store.get('contact-outbox-approval',entry.approvalId))!.id,entry.approvalId);return {requestId:request.intent.requestId,journal};
}

for(const phase of ['fence','commit'] as const)for(const failure of ['before-write','after-write','readback'] as const)test('uncertain pure authority '+phase+' '+failure+' fences only the edit and retains original uncertain dispatch evidence',async()=>{
  const f=await fixture();let restore=()=>{};try{
    const ids=await configuredContacts(f),original=await uncertainNotification(f,ids.route),before=await authority(f),posts=f.posts(),put=f.store.put.bind(f.store),get=f.store.get.bind(f.store);
    let writes=0,failRead=false;
    f.store.put=async(kind,value)=>{
      const target=kind===contactAuthorityKind&&++writes===(phase==='fence'?2:3);
      if(target&&failure==='before-write')throw Error('Pure authority write refused');
      const result=await put(kind,value);if(target&&failure==='after-write')throw Error('Pure authority commit uncertain');if(target&&failure==='readback')failRead=true;return result;
    };
    f.store.get=async(kind,id)=>{if(kind===contactAuthorityKind&&failRead){failRead=false;throw Error('Pure authority readback unavailable');}return get(kind,id);};
    restore=()=>{f.store.put=put;f.store.get=get;};
    const result=await f.admin('save-template',{templateId:ids.template,definition:{enabled:true,body:'Updated {{status}}.',contentClass:'personal',whatsappSid:contentSid}});
    assert.equal(result.receipt.outcome,'unconfirmed');assert.notEqual(result.receipt.effect,'confirmed');restore();
    const saved=await authority(f);assert.equal(saved.state,'ready');assert.ok(saved.revision>before.revision);assert.deepEqual(saved.providers,before.providers);assert.deepEqual(saved.routes,before.routes);assert.deepEqual(saved.rules,before.rules);assert.deepEqual(saved.events,before.events);
    assert.equal(saved.templates.find(t=>t.id===ids.template)!.enabled,false);assert.equal(f.posts(),posts);assert.deepEqual(journalEvidence(await f.store.get('contact-outbox','main')),journalEvidence(original.journal));assert.deepEqual(saved.actions.slice(0,before.actions.length),before.actions);
    const failedAction=saved.actions.at(-1)!;assert.equal(failedAction.receipt,undefined);
    await f.reopen();assert.equal((await f.status()).channels.find((c:any)=>c.channel==='gmail').ready,true);assert.equal((await f.status()).routes.find((r:any)=>r.id===ids.route).verified,true);
    assert.equal((await f.admin('reconcile',{outboxRequestId:original.requestId})).result.requestId,original.requestId);assert.equal(f.posts(),posts);
    const entries=(await f.store.get('contact-outbox','main'))!.entries.filter((e:any)=>e.intent.requestId===original.requestId);assert.equal(entries.length,1);
    await proveRuleUsable(f);
  }finally{restore();await f.cleanup();}
});

for(const effect of ['rotation-failure','delete-failure','late-rotation'] as const)test('uncertain protected '+effect+' cannot restore old provider permission or wipe unrelated Gmail',async()=>{
  const f=await fixture();let release=()=>{};try{
    const ids=await configuredContacts(f),original=await uncertainNotification(f,ids.route),before=await authority(f),posts=f.posts();
    let result:PromiseSettledResult<any>;
    if(effect==='late-rotation'){
      let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);f.afterVault(async()=>{entered();await gate;});
      const pending=Promise.allSettled([f.admin('configure-twilio',{accountSid:account,authToken:randomBytes(20).toString('hex'),sender,voiceEnabled:false})]);await waiting;await f.service.assistant.stop();release();result=(await pending)[0];
    }else{
      if(effect==='delete-failure')f.vaultFailure();else f.afterVault(async()=>{throw Error('Protected write completion uncertain');});
      result=(await Promise.allSettled([f.admin(effect==='delete-failure'?'disable-twilio':'configure-twilio',effect==='delete-failure'?{}:{accountSid:account,authToken:randomBytes(20).toString('hex'),sender,voiceEnabled:false})]))[0];
    }
    noConfirmedReceipt(result);f.afterVault(undefined);f.vaultFailure(false,false);
    const saved=await authority(f);assert.equal(saved.state,'ready');assert.ok(saved.revision>before.revision);assert.deepEqual(saved.providers.gmail,before.providers.gmail);
    assert.equal(saved.providers.twilio!.enabled,false);assert.equal(saved.providers.twilio!.connected,false);assert.notEqual(saved.providers.twilio!.generation,before.providers.twilio!.generation);
    assert.equal(saved.routes.find(r=>r.id===ids.route)!.enabled,false);assert.equal(saved.rules[0].revoked,true);assert.deepEqual(saved.events,before.events);assert.deepEqual(saved.actions.slice(0,before.actions.length),before.actions);assert.equal(f.posts(),posts);assert.deepEqual(journalEvidence(await f.store.get('contact-outbox','main')),journalEvidence(original.journal));
    assert.equal(f.root().voice,'Designed A');assert.deepEqual(f.root().unrelated,{keep:true});
    await f.reopen();const status=await f.status();assert.equal(status.channels.find((c:any)=>c.channel==='gmail').ready,true);assert.equal(status.channels.find((c:any)=>c.channel==='sms').ready,false);assert.equal(status.routes.find((r:any)=>r.id===ids.route).verified,false);
    const count=f.requests().length;await f.admin('reconcile',{outboxRequestId:original.requestId});assert.equal(f.requests().length,count);assert.equal(f.posts(),posts);
    // Explicit current-owner recovery touches only Twilio, retaining the Gmail
    // generation and the consumed original outbox identity/reservation.
    assert.equal((await f.admin('configure-twilio',{accountSid:account,authToken:randomBytes(20).toString('hex'),sender,voiceEnabled:false})).receipt.outcome,'completed');
    assert.deepEqual((await authority(f)).providers.gmail,before.providers.gmail);assert.equal((await f.status()).channels.find((c:any)=>c.channel==='gmail').ready,true);assert.equal((await f.status()).routes.find((r:any)=>r.id===ids.route).verified,false);assert.equal(f.posts(),posts);
    assert.deepEqual(journalEvidence(await f.store.get('contact-outbox','main')),journalEvidence(original.journal));
  }finally{release();await f.cleanup();}
});

test('uncertain authority recovery never overwrites a newer revocation with its old snapshot',async()=>{
  const f=await fixture();let restore=()=>{};try{
    const ids=await configuredContacts(f),put=f.store.put.bind(f.store);let writes=0,newer:Awaited<ReturnType<typeof authority>>|undefined;
    f.store.put=async(kind,value)=>{
      const result=await put(kind,value);if(kind===contactAuthorityKind&&++writes===3){
        newer=parseContactAuthority(value);newer.revision+=10;newer.routes.find(r=>r.id===ids.route)!.enabled=false;newer.routes.find(r=>r.id===ids.route)!.revision++;newer.rules[0].revoked=true;
        await put(contactAuthorityKind,{id:'main',...newer});throw Error('Uncertain commit with newer authority');
      }return result;
    };restore=()=>{f.store.put=put;};const posts=f.posts();
    noConfirmedReceipt((await Promise.allSettled([f.admin('save-template',{templateId:ids.template,definition:{enabled:true,body:'Updated {{status}}.',contentClass:'personal',whatsappSid:contentSid}})]))[0]);restore();
    assert.deepEqual(await authority(f),newer);assert.equal(f.posts(),posts);await f.reopen();assert.equal((await f.status()).rules[0].revoked,true);assert.equal((await f.status()).routes.find((r:any)=>r.id===ids.route).verified,false);
  }finally{restore();await f.cleanup();}
});
