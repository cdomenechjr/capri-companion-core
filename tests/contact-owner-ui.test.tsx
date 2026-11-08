import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DesktopContactOwner,ProtectedContactVault} from '../src/desktop/contact-owner';
import {createService} from '../src/server/service';
import {Store} from '../src/server/store';
import {defaults} from '../src/shared';
import {ContactAdminReplySchema,ContactAdminRequestSchema,ContactAdminStatusSchema,contactAuthorityKind,parseContactAuthority,writeContactAuthority} from '../src/extensions/contact-admin';
import {defaultExtensionSettings,type DeliveryReceipt} from '../src/extensions/contracts';
import {defaultExtensionStatus,featureCapability} from '../src/extensions/policy';
import {ContactReviewDetails,ContactSetup,ExtensionSettings,limitsInput} from '../src/ui/ExtensionSettings';
import {
  ContactAdminReplyViewSchema,ContactAdminStatusViewSchema,approvalInput,contactAdminInputSchemas,contactAdminKey,contactChallengeLifetimeMs,contactChallengeView,contactChannelBadge,contactRuleFenced,contactDestinationProblem,contactEvidenceText,contactSetupUnavailableMessage,
  createActionRunner,createContactAdminController,createMainContactBridge,createReadGate,deliveryBadge,interpretContactAdminReply,readContactReview,readExtensionSettings,readExtensionStatus,readOverview,templateBodyProblem,whatsAppReview,
  type ContactAdminBridge,type ContactAdminRequest,type ContactAdminStatus,type ExtensionRequest,type ReadView,type SetTimer,
} from '../src/ui/extensions-api';

/*
 * Contact setup UI against the accepted desktop owner contract. Provider transport is a fixed in-process fake
 * (simulated Twilio/Google responses); the owner, Hub, outbox, receipts and service session are the real modules.
 * No live credential, OAuth authorization, message, call or account is used.
 */
const account='AC'+'a'.repeat(32),contentSid='HX'+'b'.repeat(32),sender='+15550000001',self='+15550000002',friend='+15550000003';
const response=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=<T,>()=>{let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const ready=<T,>(data:T):ReadView<T>=>({kind:'ready',data,observedAt:1000});

async function fixture(start=1_800_000_000_000){
  const directory=await mkdtemp(path.join(os.tmpdir(),'capri-contact-ui-')),key=randomBytes(32),token=randomBytes(24).toString('hex');
  let store=await new Store(directory,key).init(),now=start,mode='queued',posts=0,gets=0,failVault=false,failPost=false;
  let root:Record<string,unknown>={voice:'Designed A',unrelated:{keep:true}};
  const opens:string[]=[],sent=new Map<string,{to:string;from:string}>();
  let service:Awaited<ReturnType<typeof createService>>;
  const vault=new ProtectedContactVault({read:()=>structuredClone(root),write:value=>{if(failVault)throw Error('fixture protected write failure');root=structuredClone(value);}});
  const owner=new DesktopContactOwner({store,vault,clock:()=>now,openAuthorization:async url=>{opens.push(url);},fetch:async(url,init)=>{
    if(url==='https://content.twilio.com/v1/Content/'+contentSid&&init.method==='GET'){gets++;return response({sid:contentSid,account_sid:account,language:'en',types:{'twilio/text':{body:'Capri verification code: {{1}}'}},variables:{'1':'example'}});}
    if(url==='https://content.twilio.com/v1/Content/'+contentSid+'/ApprovalRequests'&&init.method==='GET'){gets++;return response({sid:contentSid,account_sid:account,whatsapp:{status:'approved',content_type:'twilio/text'}});}
    const messages='https://api.twilio.com/2010-04-01/Accounts/'+account+'/Messages';
    if(init.method==='POST'&&url===messages+'.json'){
      if(failPost)throw Error('fixture uncertain network');
      const form=new URLSearchParams(String(init.body??'')),to=form.get('To')!,from=form.get('From')!;
      posts++;const sid='SM'+posts.toString(16).padStart(32,'0');sent.set(sid,{to,from});return response({sid,account_sid:account,to,from,direction:'outbound-api',status:mode});
    }
    if(init.method==='GET'&&url.startsWith(messages+'/')){const id=url.slice(messages.length+1,-5),record=sent.get(id);assert.ok(record,'only an existing record may be observed');gets++;return response({sid:id,account_sid:account,...record,direction:'outbound-api',status:mode});}
    throw Error('Unexpected fixture provider request.');
  }});
  await store.put('settings',{...defaults,id:'main',providerMode:'local',initiative:false,retentionDays:0});
  service=await createService({store,adminToken:token,key:()=>undefined,contactOwner:owner,clock:()=>now,extensions:{profile:'self-test'}});
  const calls:ContactAdminRequest[]=[];
  // The same in-process entry the authenticated main-window IPC handler injects.
  const bridge:ContactAdminBridge=async request=>{calls.push(structuredClone(request));return service.desktopContactAdministration(request,()=>{});};
  const request:ExtensionRequest=async(method,route,body)=>{
    const reply=await service.app.inject({method,url:route,headers:{authorization:'Bearer '+token},...(body===undefined?{}:{payload:body as any})});
    let json:unknown;try{json=reply.json();}catch{json=undefined;}
    return reply.statusCode<300?{ok:true,status:reply.statusCode,body:json}:{ok:false,status:reply.statusCode,body:json,message:'HTTP '+reply.statusCode};
  };
  /** Test-only stand-in for the user reading the code on their phone: the service journal's own challenge. */
  const code=async(challengeId:string)=>(await store.get('contact-outbox','main'))!.challenges.find((c:any)=>c.id===challengeId).code as string;
  return {store,owner,get service(){return service;},token,bridge,calls,request,code,opens,
    posts:()=>posts,gets:()=>gets,root:()=>root,now:()=>now,advance:(n:number)=>now+=n,mode:(v:string)=>mode=v,vaultFailure:(v:boolean)=>failVault=v,postFailure:(v:boolean)=>failPost=v,
    cleanup:async()=>{await service.app.close();await rm(directory,{recursive:true,force:true});}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const controllerFor=(f:Fixture,scope={epoch:'e1' as string|number|undefined,privateSession:false})=>createContactAdminController({bridge:f.bridge,gate:createReadGate(),scope});
const smsLimits={enabled:true,unitCostMicros:100,maxDispatchCostMicros:1000,dailyBudgetMicros:10000,maxPerMinute:10,maxPerDay:50};
const status=(c:ReturnType<typeof controllerFor>)=>{const s=c.snapshot().status;assert.equal(s.kind,'ready');return (s as {data:ContactAdminStatus}).data;};
async function configured(f:Fixture,c:ReturnType<typeof controllerFor>,kind:'self'|'contact'='self'){
  await c.refresh();
  const twilioToken=randomBytes(20).toString('hex');
  assert.equal((await c.run('configure-twilio',{accountSid:account,authToken:twilioToken,sender,voiceEnabled:true}))?.state,'completed');
  assert.equal((await c.run('set-limits',{channel:'sms',limits:smsLimits}))?.state,'completed');
  assert.equal((await createActionRunner({request:f.request}).run('contacts/configure',{enabled:true,automaticEnabled:true}))?.state,'completed');
  assert.equal((await c.run('save-route',{channel:'sms',destination:kind==='self'?self:friend,kind,optedIn:true}))?.state,'completed');
  return {route:status(c).routes.at(-1)!.id,twilioToken};
}
async function verified(f:Fixture,c:ReturnType<typeof controllerFor>,routeId:string){
  const begun=await c.run('verify-begin',{routeId},'verify-begin:'+routeId);
  assert.equal(begun?.state,'completed');assert.equal(begun?.evidence?.state,'accepted');assert.match(begun!.message,/provider accepted the verification challenge.*Enter the 6-digit code/);
  const challenge=c.snapshot().challenges[routeId];assert.ok(challenge,'only a provider-accepted challenge offers code entry');
  assert.equal((await c.run('verify-complete',{routeId,challengeId:challenge.challengeId,code:await f.code(challenge.challengeId)},'verify-complete:'+routeId))?.state,'completed');
  assert.equal(c.snapshot().challenges[routeId],undefined,'a used challenge is forgotten');
  f.advance(86400001);await c.refresh();
}
async function workflow(c:ReturnType<typeof controllerFor>,routeId:string,trigger:'on-demand'|'task-completed'='on-demand'){
  assert.equal((await c.run('save-template',{definition:{enabled:true,body:'Capri is {{status}}.',contentClass:'personal'}}))?.state,'completed');
  const templateId=status(c).templates.at(-1)!.id;
  assert.equal((await c.run('save-workflow',{definition:{enabled:true,trigger,routeId,templateId}}))?.state,'completed');
  const workflowId=status(c).workflows.at(-1)!.id;assert.equal(c.snapshot().workflowRoutes[workflowId],routeId);
  return {templateId,workflowId};
}

test('browser projection accepts exactly what the real owner returns and refuses any extra field',async()=>{
  const f=await fixture();try{
    const c=controllerFor(f);const {route}=await configured(f,c);
    const raw=await f.service.desktopContactAdministration({requestId:randomUUID(),expectedRevision:1,action:'status'},()=>{}) as any;
    assert.deepEqual(ContactAdminStatusViewSchema.parse(raw.status),ContactAdminStatusSchema.parse(raw.status));
    assert.deepEqual(ContactAdminReplyViewSchema.parse(raw),ContactAdminReplySchema.parse(raw));
    const begun=await f.service.desktopContactAdministration({requestId:randomUUID(),expectedRevision:raw.status.revision,action:'verify-begin',routeId:route},()=>{}) as any;
    assert.deepEqual(ContactAdminReplyViewSchema.parse(begun),ContactAdminReplySchema.parse(begun),'nested verification receipt shape');
    for(const extra of [{sender},{accountSid:account},{destination:self},{body:'Capri is {{status}}.'},{clientId:'client.apps'}]){
      assert.equal(ContactAdminStatusViewSchema.safeParse({...raw.status,...extra}).success,false,Object.keys(extra)[0]+' is never accepted in status');
      assert.equal(ContactAdminStatusViewSchema.safeParse({...raw.status,routes:raw.status.routes.map((r:any)=>({...r,...extra}))}).success,false);
    }
    // The local input mirror agrees with the real request schema on accepted and refused inputs.
    const cases:[string,Record<string,unknown>][]=[['configure-twilio',{accountSid:account,authToken:'',sender,voiceEnabled:false}],['configure-twilio',{accountSid:account,authToken:'tok_en-1',sender,voiceEnabled:false}],
      ['verify-complete',{routeId:route,challengeId:'c-1',code:'12345'}],['verify-complete',{routeId:route,challengeId:'c-1',code:'123456'}],['set-limits',{channel:'sms',limits:{...smsLimits,maxPerMinute:0}}],
      ['set-limits',{channel:'sms',limits:{...smsLimits,quietHours:{startMinute:1320,endMinute:420,timeZone:'Not/AZone'}}}],['set-limits',{channel:'voice',limits:smsLimits}],
      ['save-template',{definition:{enabled:true,body:'x',contentClass:'personal',subject:'a\nb'}}],['recheck-whatsapp',{contentSid:'HX1',language:'en'}],['configure-gmail',{clientId:'id with space',sender:'me@example.com'}],
      ['recover-setup',{confirmation:'yes'}],['recover-setup',{confirmation:'disable-unprovable-permissions'}],['save-route',{channel:'pager',destination:'x',kind:'self',optedIn:true}]];
    for(const [action,fields] of cases)assert.equal((contactAdminInputSchemas as any)[action].safeParse(fields).success,ContactAdminRequestSchema.safeParse({requestId:'r-1',expectedRevision:1,action,...fields}).success,action+' '+JSON.stringify(fields));
    assert.equal(contactAdminInputSchemas['prepare-notification'].safeParse({workflowId:'w',taskId:'t'}).success,false,'settings-started sends are never task scoped');
  }finally{await f.cleanup();}
});

test('opening settings reads, connects and sends nothing; browser views show a precise setup-unavailable state',async()=>{
  const bridge:ContactAdminBridge=async()=>assert.fail('render must not call contact administration');
  const request:ExtensionRequest=async()=>assert.fail('render must not call the service');
  const settings=ready(defaultExtensionSettings());
  const desktop=renderToStaticMarkup(<ExtensionSettings request={request} contactAdmin={bridge} initial={{status:ready(defaultExtensionStatus(1)),settings}}/>);
  assert.match(desktop,/Setup status not loaded\. Nothing is read, connected or sent until you click/);
  assert.match(desktop,/<button class="text-link">Read setup status<\/button>/);
  assert.match(desktop,/type="password"[^>]*value=""/,'the token field renders empty and masked');
  for(const label of['Save Twilio credentials','Connect Gmail','Save limits','Add recipient','Add template','Add workflow','Check approved template'])
    assert.match(desktop,new RegExp('<button[^>]*disabled=""[^>]*>'+label+'</button>'),label+' waits for setup status');
  assert.doesNotMatch(desktop,/monthly|this month/i,'no unenforced monthly-count control');
  assert.doesNotMatch(desktop,/>CONNECTED<|>READY<|>VERIFIED</);
  const browser=renderToStaticMarkup(<ExtensionSettings request={request} initial={{status:ready(defaultExtensionStatus(1)),settings}}/>);
  assert.ok(browser.includes(contactSetupUnavailableMessage.replace(/’/g,'&#x27;'))||browser.includes('Contact setup is available only in the Capri desktop window'));
  assert.doesNotMatch(browser,/type="password"|Twilio account SID|Gmail OAuth client ID|Verification code/,'no credential, recipient or code entry without the bridge');
  assert.doesNotMatch(browser,/id="ext-contacts-enabled"[^>]*disabled/,'ordinary messaging switches still work in the browser');
  const controller=createContactAdminController({gate:createReadGate(),scope:{epoch:'e1',privateSession:false}});
  await controller.refresh();assert.equal(controller.snapshot().status.kind,'unchecked');
  assert.equal(await controller.run('configure-twilio',{accountSid:account,authToken:'abc',sender,voiceEnabled:false}),undefined);
  assert.equal(controller.snapshot().notes['configure-twilio']?.message,contactSetupUnavailableMessage);
  // main.tsx injects the bridge only in the main (non-floating) view and only after the existing privacy synchronization.
  const main=await readFile(path.join('src','ui','main.tsx'),'utf8');
  assert.match(main,/const contactAdmin:ContactAdminBridge\|undefined=!floating&&window\.capri\?\.agency\?createMainContactBridge\(\{agency:request=>window\.capri!\.agency!\('contacts',request\),epoch:\(\)=>privacyEpoch\.current,privacySync:\(\)=>privacySync\.current\.catch\(\(\)=>syncPrivacy\(\)\)\}\):undefined;/);
  assert.match(main,/<ExtensionSettings [^>]*contactAdmin=\{contactAdmin\}/);
});

test('full fake-provider setup: credentials, limits, recipient, paid challenge, code, self send, exact approval and read-only reconcile',async()=>{
  const f=await fixture();try{
    const c=controllerFor(f);
    await c.refresh();
    const initial=status(c);
    assert.ok(initial.channels.every(ch=>contactChannelBadge(ch,initial.state).tag==='NOT CONFIGURED'),'default: every channel unavailable');
    assert.equal(f.posts(),0);assert.equal(f.gets(),0);assert.equal(f.opens.length,0);
    const {route:selfRoute,twilioToken}=await configured(f,c);
    assert.match(c.snapshot().notes['configure-twilio']!.message,/saved and read back.*not a provider test/);
    assert.match(c.snapshot().notes['save-route']!.message,/not verified/);
    const sms=status(c).channels.find(ch=>ch.channel==='sms')!;
    assert.equal(contactChannelBadge(sms,'ready').tag,'READY');assert.equal(status(c).routes[0].verified,false,'saving a self recipient does not verify it');
    assert.equal(f.posts(),0,'configuration, limits and recipients send nothing');
    await verified(f,c,selfRoute);assert.equal(f.posts(),1,'exactly one challenge message');
    assert.equal(status(c).routes[0].verified,true);
    const selfFlow=await workflow(c,selfRoute);
    const sent=await c.run('prepare-notification',{workflowId:selfFlow.workflowId},'send:'+selfFlow.workflowId);
    assert.equal(sent?.state,'completed');assert.equal(sent?.evidence?.state,'accepted');assert.equal(sent?.evidence?.remote,true);
    assert.match(sent!.message,/provider accepted the message \(provider receipt\)\. Delivery is not observed yet/);
    assert.equal(f.posts(),2);assert.equal(c.snapshot().held[selfFlow.workflowId],undefined);
    // A contact (not self) needs the exact current message approved through the original outbox.
    assert.equal((await c.run('save-route',{channel:'sms',destination:friend,kind:'contact',optedIn:true}))?.state,'completed');
    const contactRoute=status(c).routes.at(-1)!.id;await verified(f,c,contactRoute);
    const other=await workflow(c,contactRoute);const posted=f.posts();
    const waiting=await c.run('prepare-notification',{workflowId:other.workflowId},'send:'+other.workflowId);
    assert.equal(waiting?.state,'pending');assert.match(waiting!.message,/Waiting for your exact approval/);assert.equal(f.posts(),posted);
    assert.equal(c.snapshot().held[other.workflowId]?.outboxRequestId,waiting!.outboxRequestId,'the draft keeps its original request ID; no new send is offered');
    const overview=await readOverview(f.request,'contacts');assert.equal(overview.kind,'ready');
    const row=(overview as any).data.outbox.find((r:any)=>r.receipt.requestId===waiting!.outboxRequestId);assert.equal(row.approvalRequired,true);
    assert.equal(deliveryBadge(row.receipt).tag,'PENDING');
    const review=await readContactReview(f.request,row.receipt as DeliveryReceipt,'local-1',{privateSession:false});assert.equal(review.kind,'ready');
    const exact=(review as any).review;assert.equal(exact.destination,friend);assert.equal(exact.content.body,'Capri is requested.');
    const approved=await createActionRunner({request:f.request}).run('contacts/approve',approvalInput(exact))!;
    assert.equal(approved.state,'completed');assert.match(approved.message,/not a delivery receipt/);assert.equal(f.posts(),posted+1);
    // Read-only reconciliation observes the original record and never POSTs.
    f.mode('delivered');const gets=f.gets();
    const checked=await c.run('reconcile',{outboxRequestId:waiting!.outboxRequestId!},'reconcile:'+waiting!.outboxRequestId);
    assert.equal(checked?.state,'completed');assert.equal(checked?.evidence?.state,'delivered');assert.match(checked!.message,/^Read-only check: The provider reports the message delivered\./);
    assert.equal(f.posts(),posted+1);assert.equal(f.gets(),gets+1);
    c.release(other.workflowId);assert.equal(c.snapshot().held[other.workflowId],undefined,'only an explicit acknowledgement allows a separate new request');
    // Nothing secret or private reaches the snapshot, notes or the action log.
    const visible=JSON.stringify(c.snapshot())+renderToStaticMarkup(<ContactSetup admin={c} snap={c.snapshot()} act={()=>{}} privateSession={false} now={f.now()}/>);
    for(const value of[twilioToken,self,friend,sender,account,'Capri is requested'])assert.ok(!visible.includes(value),'leaked '+value);
    assert.deepEqual(f.calls.filter(r=>JSON.stringify(r).includes(twilioToken)).map(r=>r.action),['configure-twilio'],'the token is sent once, only through the bridge');
    assert.equal(f.root().voice,'Designed A');
  }finally{await f.cleanup();}
});

test('blank and invalid inputs are refused locally without dispatch',async()=>{
  const calls:ContactAdminRequest[]=[];const base=ContactAdminStatusSchema.parse({revision:3,state:'ready',channels:[],routes:[],templates:[],workflows:[],rules:[],oauthPending:false,billing:'local-conservative-estimate'});
  const c=createContactAdminController({bridge:async r=>{calls.push(r);return {requestId:r.requestId,status:base};},gate:createReadGate(),scope:{epoch:'e1',privateSession:false}});
  assert.equal(await c.run('set-limits',{channel:'sms',limits:smsLimits}),undefined);assert.match(c.snapshot().notes['set-limits']!.message,/Read setup status first/);
  await c.refresh();assert.equal(calls.length,1);assert.equal(calls[0].action,'status');
  for(const [action,fields] of [['configure-twilio',{accountSid:account,authToken:'',sender,voiceEnabled:false}],['configure-twilio',{accountSid:'AC1',authToken:'abc',sender,voiceEnabled:false}],
    ['verify-complete',{routeId:'r',challengeId:'c',code:'12a456'}],['set-limits',{channel:'sms',limits:{...smsLimits,maxPerDay:0}}],['save-route',{channel:'sms',destination:'',kind:'self',optedIn:true}],
    ['configure-gmail',{clientId:'',sender:''}],['add-rule',{outboxRequestId:'o',review:{requestId:'o'},expiresAt:1}]] as const){
    assert.equal(await c.run(action as any,fields as any),undefined);assert.equal(c.snapshot().notes[action]?.state,'invalid',action);assert.match(c.snapshot().notes[action]!.message,/Nothing was sent/);
  }
  assert.equal(calls.length,1,'nothing invalid reached the bridge');
  assert.equal(contactDestinationProblem('sms','5551234'),'Use an international number such as +15551234567.');
  assert.equal(contactDestinationProblem('whatsapp','whatsapp:+15551234567'),undefined);
  assert.equal(contactDestinationProblem('gmail','Me <me@example.com>'),'Use one plain email address.');
  assert.equal(contactDestinationProblem('gmail',''),'Enter the recipient.');
  assert.match(templateBodyProblem('Hi {{name}}')!,/Only \{\{status\}\}/);assert.equal(templateBodyProblem('Capri is {{status}}.'),undefined);assert.ok(templateBodyProblem('  '));
  const form={enabled:true,unit:'0.0001',perSend:'0.001',daily:'0.01',perMinute:'10',perDay:'50',quiet:false,start:'22:00',end:'07:00',timeZone:'UTC'};
  assert.deepEqual(limitsInput(form).limits,smsLimits);
  for(const bad of[{unit:'-1'},{daily:'1e3'},{perMinute:'61'},{perDay:'0'},{quiet:true,start:'25:00'},{quiet:true,timeZone:'Not/AZone'}])assert.ok(limitsInput({...form,...bad}).problem,JSON.stringify(bad));
  assert.deepEqual(limitsInput({...form,quiet:true}).limits?.quietHours,{startMinute:1320,endMinute:420,timeZone:'UTC'});
});

test('save failure, stale revision and a throwing bridge never report saved and send nothing',async()=>{
  const f=await fixture();try{
    const c=controllerFor(f);await c.refresh();
    f.vaultFailure(true);
    const failed=await c.run('configure-twilio',{accountSid:account,authToken:randomBytes(16).toString('hex'),sender,voiceEnabled:false});
    assert.equal(failed?.state,'unconfirmed');assert.doesNotMatch(failed!.message,/saved|configured/i);assert.match(failed!.message,/nothing is retried/);
    f.vaultFailure(false);await c.refresh();assert.equal(status(c).channels.some(ch=>ch.configured||ch.ready),false);assert.equal(f.root().voice,'Designed A');
    // Another change makes this view's revision stale: the owner refuses, the view refreshes, nothing changes.
    await f.service.desktopContactAdministration({requestId:randomUUID(),expectedRevision:status(c).revision,action:'set-limits',channel:'gmail',limits:{...smsLimits,unitCostMicros:0}},()=>{});
    const before=status(c).revision,stale=await c.run('set-limits',{channel:'sms',limits:smsLimits});
    assert.equal(stale?.state,'conflict');assert.match(stale!.message,/Nothing was changed/);assert.ok(status(c).revision>before,'the conflict reply refreshes status');
    assert.equal(status(c).channels.find(ch=>ch.channel==='sms')!.limits.enabled,false);
    const thrower=createContactAdminController({bridge:async(r,fence)=>{if(r.action==='status')return f.bridge(r,fence);throw Error('Contact renderer changed. '+self);},gate:createReadGate(),scope:{epoch:'e1',privateSession:false}});
    await thrower.refresh();const lost=await thrower.run('set-limits',{channel:'sms',limits:smsLimits});
    assert.equal(lost?.state,'unconfirmed');assert.ok(!lost!.message.includes(self),'bridge error text is never shown');assert.equal(f.posts(),0);
  }finally{await f.cleanup();}
});

test('Gmail: saving the client is not a connection; connect opens the system browser and cancel closes it without a token',async()=>{
  const f=await fixture();try{
    const c=controllerFor(f);await c.refresh();
    assert.equal((await c.run('configure-gmail',{clientId:'desktop-client.apps.googleusercontent.com',sender:'me@example.com'}))?.state,'completed');
    assert.match(c.snapshot().notes['configure-gmail']!.message,/Not connected yet/);
    const gmail=()=>status(c).channels.find(ch=>ch.channel==='gmail')!;assert.equal(gmail().configured,false);
    const connect=await c.run('connect-gmail',{});assert.equal(connect?.state,'completed');assert.match(connect!.message,/connected only when setup status shows it/);
    assert.equal(f.opens.length,1);assert.equal(new URL(f.opens[0]).origin,'https://accounts.google.com');assert.equal(new URL(f.opens[0]).searchParams.get('scope'),'https://www.googleapis.com/auth/gmail.send');
    assert.equal(status(c).oauthPending,true);assert.equal(gmail().configured,false,'sign-in pending is not connected');
    const html=renderToStaticMarkup(<ContactSetup admin={c} snap={c.snapshot()} act={()=>{}} privateSession={false} now={f.now()}/>);
    assert.match(html,/SIGN-IN PENDING/);assert.doesNotMatch(html,/>CONNECTED</);
    assert.equal((await c.run('cancel-gmail',{}))?.state,'completed');assert.equal(status(c).oauthPending,false);assert.equal(gmail().configured,false);
    assert.equal(f.posts(),0);assert.equal(f.opens.length,1,'nothing reopened automatically');
  }finally{await f.cleanup();}
});

test('stale receipts: a boundary, close or mismatch never applies a late or foreign reply; a deadline does not resend',async()=>{
  const held:ReturnType<typeof deferred<unknown>>[]=[],sent:ContactAdminRequest[]=[];
  const base=ContactAdminStatusSchema.parse({revision:2,state:'ready',channels:[],routes:[],templates:[],workflows:[],rules:[],oauthPending:false,billing:'local-conservative-estimate'});
  const bridge:ContactAdminBridge=r=>{sent.push(r);if(r.action==='status')return Promise.resolve({requestId:r.requestId,status:base});const d=deferred<unknown>();held.push(d);return d.promise;};
  const gate=createReadGate(),c=createContactAdminController({bridge,gate,scope:{epoch:'e1',privateSession:false}});
  await c.refresh();const pending=c.run('set-limits',{channel:'sms',limits:smsLimits});await tick();
  assert.equal(c.snapshot().notes['set-limits']?.state,'pending');assert.equal(c.snapshot().busy,true);
  assert.equal(c.sync({epoch:'e2',privateSession:false}),true,'Stop/privacy boundary');
  assert.equal(c.snapshot().status.kind,'unchecked');assert.deepEqual(c.snapshot().notes,{});
  const r=sent[1];held[0].resolve({receipt:{id:'x',requestId:r.requestId,feature:'contacts',action:'set-limits',observedAt:1,outcome:'completed',effect:'confirmed'},status:{...base,revision:9}});
  assert.equal(await pending,undefined);await tick();
  assert.equal(c.snapshot().status.kind,'unchecked','a late receipt from the old scope is not applied');assert.equal(c.snapshot().busy,false);
  // A reply for another request or action is not evidence.
  const id={requestId:'mine',action:'set-limits' as const};
  const receipt=(patch:object)=>({receipt:{id:'x',requestId:'mine',feature:'contacts',action:'set-limits',observedAt:1,outcome:'completed',effect:'confirmed',...patch},status:base});
  assert.equal(interpretContactAdminReply(id,receipt({})).note.state,'completed');
  for(const patch of[{requestId:'other'},{action:'save-route'},{feature:'agents'}])assert.equal(interpretContactAdminReply(id,receipt(patch)).note.state,'unconfirmed',JSON.stringify(patch));
  assert.equal(interpretContactAdminReply(id,{...receipt({}),status:{...base,sender}}).note.state,'unconfirmed','a status with a secret-bearing field is not recognized');
  assert.equal(interpretContactAdminReply({requestId:'s',action:'status'},{requestId:'other',status:base}).note.state,'unconfirmed');
  const challenge={challengeId:'ch-1',requestId:'vr-1',expiresAt:5};
  const verification={kind:'verification',requestId:'vr-1',challengeId:'ch-1',receiptId:'rc',adapter:'twilio-sms',state:'accepted',observedAt:1,evidence:{source:'service-receipt',recordId:'SM1'}};
  const begin=(v:object,ch=challenge)=>interpretContactAdminReply({requestId:'mine',action:'verify-begin'},{...receipt({action:'verify-begin'}),challenge:ch,result:{...verification,...v}});
  assert.equal(begin({}).note.state,'completed');assert.ok(begin({}).challenge);
  assert.equal(begin({challengeId:'ch-2'}).note.state,'unconfirmed','a receipt for another challenge is refused');
  for(const state of['pending','unconfirmed','rejected']){const read=begin({state,evidence:{source:'none'}});assert.notEqual(read.note.state,'completed');assert.equal(read.challenge,undefined,state+' challenges cannot take a code');}
  // A UI deadline leaves the outcome unknown and holds the bridge slot: no second request until the first settles.
  const timers=new Set<()=>void>(),setTimer:SetTimer=fn=>{timers.add(fn);return ()=>{timers.delete(fn);};};
  const slow=createContactAdminController({bridge,gate,scope:{epoch:'e3',privateSession:false},setTimer});await slow.refresh();
  const waiting=slow.run('set-limits',{channel:'sms',limits:smsLimits});await tick();for(const fn of[...timers])fn();
  const timedOut=await waiting;assert.equal(timedOut?.state,'unconfirmed');assert.match(timedOut!.message,/No receipt within 30 s/);
  const count=sent.length;assert.equal(await slow.run('set-limits',{channel:'sms',limits:smsLimits}),undefined);assert.equal(sent.length,count,'the unsettled request blocks a duplicate');
  held[1].resolve({});await tick();await tick();assert.equal(slow.snapshot().notes['set-limits']?.state,'unconfirmed','a late reply never upgrades a timed-out outcome');
  c.close();assert.equal(c.closed(),true);assert.equal(await c.run('set-limits',{channel:'sms',limits:smsLimits}),undefined);
});

test('private session and Stop: setup waits locally and at the owner, and a boundary drops challenges and status',async()=>{
  const f=await fixture();try{
    const c=controllerFor(f);const {route}=await configured(f,c);
    await c.run('verify-begin',{routeId:route},'verify-begin:'+route);assert.ok(c.snapshot().challenges[route]);
    c.sync({epoch:'e2',privateSession:true});
    assert.deepEqual(c.snapshot().challenges,{},'a privacy boundary forgets the challenge; the code cannot be entered in the new scope');
    await c.refresh();assert.match(c.blocked('configure-twilio')!,/Private session/);assert.equal(c.blocked('cancel-gmail'),undefined);
    const noEpoch=createContactAdminController({bridge:f.bridge,gate:createReadGate(),scope:{epoch:undefined,privateSession:true}});
    assert.match(noEpoch.blocked('status')!,/without a trusted privacy epoch/);
    // The owner enforces the same boundary for its own private session.
    const session=(await f.service.app.inject({method:'GET',url:'/v1/extensions/session',headers:{authorization:'Bearer '+f.token}})).json();
    await f.service.app.inject({method:'POST',url:'/v1/extensions/session',headers:{authorization:'Bearer '+f.token},payload:{privateSession:true,revision:session.revision+1}});
    const raw=await f.service.desktopContactAdministration({requestId:randomUUID(),expectedRevision:status(c).revision,action:'save-route',channel:'sms',destination:friend,kind:'contact',optedIn:true},()=>{}) as any;
    assert.equal(interpretContactAdminReply({requestId:raw.receipt.requestId,action:'save-route'},raw).note.state,'unconfirmed');
    assert.equal(f.posts(),1,'only the earlier challenge was sent');
  }finally{await f.cleanup();}
});

test('route edits, template changes and disabled routes invalidate rules; an exact rule needs the current reviewed message',async()=>{
  const f=await fixture();try{
    const c=controllerFor(f);const {route}=await configured(f,c,'contact');await verified(f,c,route);
    const {templateId,workflowId}=await workflow(c,route,'task-completed');const count=f.posts();
    const prepared=await c.run('prepare-rule',{workflowId,completion:'unverified'},'rule:'+workflowId);
    assert.equal(prepared?.state,'completed');assert.match(prepared!.message,/Nothing was sent/);assert.equal(c.snapshot().prepared[prepared!.outboxRequestId!],workflowId);
    const overview=await readOverview(f.request,'contacts');const row=(overview as any).data.outbox.find((r:any)=>r.receipt.requestId===prepared!.outboxRequestId);
    const review=await readContactReview(f.request,row.receipt,'local-1',{privateSession:false});assert.equal(review.kind,'ready');
    assert.equal((review as any).review.content.body,'Capri is completed-unverified.');
    const tooLong=await c.run('add-rule',{outboxRequestId:prepared!.outboxRequestId!,review:approvalInput((review as any).review),expiresAt:f.now()+31*86400000});
    assert.notEqual(tooLong?.state,'completed','a rule longer than 30 days is refused');
    await c.refresh();const review2=await readContactReview(f.request,row.receipt,'local-1',{privateSession:false});
    const added=await c.run('add-rule',{outboxRequestId:prepared!.outboxRequestId!,review:approvalInput((review2 as any).review),expiresAt:f.now()+7*86400000},'add-rule:'+prepared!.outboxRequestId);
    assert.equal(added?.state,'completed');assert.match(added!.message,/Nothing was sent/);assert.equal(f.posts(),count,'adding a rule sends nothing');
    assert.equal(status(c).rules.filter(r=>!r.revoked).length,1);
    assert.equal((await c.run('save-template',{templateId,definition:{enabled:true,body:'Capri changed: {{status}}.',contentClass:'personal'}}))?.state,'completed');
    assert.equal(status(c).rules.every(r=>r.revoked),true,'a template change revokes the exact rule');
    assert.equal((await c.run('save-route',{routeId:route,channel:'sms',destination:friend,kind:'contact',optedIn:true}))?.state,'completed');
    const edited=status(c).routes.find(r=>r.id===route)!;assert.equal(edited.verified,false,'an edited route needs verification again');
    assert.equal((await c.run('disable-route',{routeId:route},'disable-route:'+route))?.state,'completed');assert.equal(status(c).routes.find(r=>r.id===route)!.enabled,false);
    assert.equal(f.posts(),count);
  }finally{await f.cleanup();}
});

test('budget and limit failures keep channels unavailable and a send unconfirmed with zero provider POSTs',async()=>{
  const f=await fixture();try{
    const c=controllerFor(f);const {route}=await configured(f,c);await verified(f,c,route);const {workflowId}=await workflow(c,route);const count=f.posts();
    assert.equal((await c.run('set-limits',{channel:'sms',limits:{...smsLimits,unitCostMicros:0}}))?.state,'completed');
    const sms=status(c).channels.find(ch=>ch.channel==='sms')!;assert.equal(contactChannelBadge(sms,'ready').tag,'NOT READY');assert.match(contactChannelBadge(sms,'ready').text,/nonzero estimated cost/);
    const refused=await c.run('prepare-notification',{workflowId},'send:'+workflowId);assert.notEqual(refused?.state,'completed');assert.equal(f.posts(),count);
    // An unconfirmed reply carries no status, so the next change conflicts until setup status is read again.
    assert.equal((await c.run('set-limits',{channel:'sms',limits:{...smsLimits,maxDispatchCostMicros:50}}))?.state,'conflict');
    assert.equal((await c.run('set-limits',{channel:'sms',limits:{...smsLimits,maxDispatchCostMicros:50}}))?.state,'completed');
    assert.notEqual((await c.run('prepare-notification',{workflowId},'send:'+workflowId))?.state,'completed');assert.equal(f.posts(),count,'per-send cap below the estimate blocks dispatch');
    const html=renderToStaticMarkup(<ContactSetup admin={c} snap={c.snapshot()} act={()=>{}} privateSession={false} now={f.now()}/>);
    assert.match(html,/up to 10\/min and 50 per rolling day · estimate 0\.0001 per SMS segment, at most 0\.00005 per send, 0\.01 per rolling day/);
    assert.match(html,/local conservative estimates/);assert.doesNotMatch(html,/monthly|this month/i);
  }finally{await f.cleanup();}
});

test('an unknown send keeps its original request, offers no resend and reconciles read-only',async()=>{
  const f=await fixture();try{
    const c=controllerFor(f);const {route}=await configured(f,c);await verified(f,c,route);const {workflowId}=await workflow(c,route);
    f.postFailure(true);const count=f.posts();
    const unknown=await c.run('prepare-notification',{workflowId},'send:'+workflowId);
    assert.equal(unknown?.state,'unconfirmed');assert.match(unknown!.message,/may or may not have been sent\. Nothing is resent automatically/);
    const held=c.snapshot().held[workflowId];assert.equal(held?.outboxRequestId,unknown!.outboxRequestId);assert.ok(held?.outboxRequestId);
    const html=renderToStaticMarkup(<ContactSetup admin={c} snap={c.snapshot()} act={()=>{}} privateSession={false} now={f.now()}/>);
    assert.match(html,/no new send is offered/);assert.doesNotMatch(html,/<button[^>]*>Send notification[^<]*<\/button>/,'no send control while the outcome is unknown');
    assert.doesNotMatch(html,/<button[^>]*>[^<]*(?:resend|send again|retry)[^<]*<\/button>/i);
    f.postFailure(false);
    const checked=await c.run('reconcile',{outboxRequestId:held!.outboxRequestId!},'reconcile:'+held!.outboxRequestId);
    assert.notEqual(checked?.state,'pending');assert.equal(f.posts(),count,'reconciliation never POSTs');
    const overview=await readOverview(f.request,'contacts');const row=(overview as any).data.outbox.find((r:any)=>r.receipt.requestId===held!.outboxRequestId);
    assert.equal(row.receipt.state,'unconfirmed');assert.equal(deliveryBadge(row.receipt).tag,'UNCONFIRMED');
  }finally{await f.cleanup();}
});

test('review-required shows Start fresh contact setup; its receipt unlocks setup only; retention-required has no bypass',async()=>{
  const f=await fixture();try{
    const c=controllerFor(f);const {route}=await configured(f,c);await verified(f,c,route);
    const state=parseContactAuthority(await f.store.get(contactAuthorityKind,'main'));state.state='review-required';await writeContactAuthority(f.store,state);
    await c.refresh();assert.equal(status(c).state,'review-required');
    assert.match(c.blocked('configure-twilio')!,/Start fresh contact setup first/);assert.equal(c.blocked('recover-setup'),undefined);
    const locked=renderToStaticMarkup(<ContactSetup admin={c} snap={c.snapshot()} act={()=>{}} privateSession={false} now={f.now()}/>);
    assert.match(locked,/could not be proved current/);assert.match(locked,/<button class="secondary">Start fresh contact setup…<\/button>/);
    assert.ok(status(c).channels.every(ch=>contactChannelBadge(ch,'review-required').tag==='UNAVAILABLE'));
    const recovered=await c.run('recover-setup',{confirmation:'disable-unprovable-permissions'});
    assert.equal(recovered?.state,'completed');assert.match(recovered!.message,/Setup unlocked.*Nothing is configured or verified yet/);
    assert.equal(status(c).state,'ready');assert.ok(status(c).channels.every(ch=>!ch.ready&&!ch.enabled));assert.ok(status(c).routes.every(r=>!r.enabled&&!r.verified));
    assert.equal(f.root().voice,'Designed A');
    const retained=parseContactAuthority(await f.store.get(contactAuthorityKind,'main'));retained.state='retention-required';await writeContactAuthority(f.store,retained);
    await c.refresh();assert.match(c.blocked('recover-setup')!,/no bypass/);
    const blocked=renderToStaticMarkup(<ContactSetup admin={c} snap={c.snapshot()} act={()=>{}} privateSession={false} now={f.now()}/>);
    assert.match(blocked,/there is no bypass/);assert.doesNotMatch(blocked,/Start fresh contact setup/);
  }finally{await f.cleanup();}
});

test('keyboard and form ownership: labelled native controls, explicit confirmations and no automatic send',async()=>{
  const base=ContactAdminStatusSchema.parse({revision:4,state:'ready',channels:['gmail','sms','voice','whatsapp','android'].map(channel=>({channel,configured:false,enabled:false,ready:false,secretStored:false,limits:{enabled:false,unitCostMicros:0,maxDispatchCostMicros:0,dailyBudgetMicros:0,maxPerMinute:1,maxPerDay:1}})),
    routes:[{id:'route-a',revision:2,channel:'sms',kind:'self',enabled:true,optedIn:true,verified:false}],templates:[{id:'t-a',revision:1,enabled:true}],workflows:[{id:'w-a',revision:1,enabled:true,trigger:'on-demand'}],
    rules:[{id:'rule-a',revoked:false,expiresAt:4102444800000}],oauthPending:false,billing:'local-conservative-estimate'});
  const sent:ContactAdminRequest[]=[];const c=createContactAdminController({bridge:async r=>{sent.push(r);return {requestId:r.requestId,status:base};},gate:createReadGate(),scope:{epoch:'e1',privateSession:false}});
  await c.refresh();
  const html=renderToStaticMarkup(<ContactSetup admin={c} snap={c.snapshot()} act={()=>assert.fail('render must not act')} privateSession={false} now={1}/>);
  for(const tag of html.match(/<(?:input|select|textarea)\b[^>]*>/g)??[])assert.ok(/aria-label="[^"]+"/.test(tag)||/type="checkbox"/.test(tag),'every field is labelled: '+tag);
  assert.doesNotMatch(html,/<(?:div|span|p)[^>]*onClick/i);assert.doesNotMatch(html,/autofocus/i);
  assert.match(html,/<button class="text-link">Verify recipient…<\/button>/,'paid verification starts with a confirmation step');
  assert.match(html,/<button class="text-link">Send notification or call…<\/button>/,'sends start with a confirmation step');
  assert.doesNotMatch(html,/Send verification code<|>Send notification<|>Send call request</,'the dispatching buttons only appear after confirmation');
  assert.match(html,/Marked as you, but that does not verify it/);assert.match(html,/Rule 1 · scope not loaded: use Load messaging details to see its recipient, workflow and template · active until/);
  // With the redacted overview bindings loaded, each rule names what it covers using the same positional labels.
  const scoped=renderToStaticMarkup(<ContactSetup admin={c} snap={c.snapshot()} act={()=>{}} privateSession={false} now={1} ruleScopes={[{id:'rule-a',routeId:'route-a',workflowId:'w-a',templateId:'t-a'}]}/>);
  assert.match(scoped,/Rule 1 · sends Template 1 to Recipient 1 for Workflow 1 · active until/);assert.doesNotMatch(scoped,/>[^<]*(?:route-a|rule-a|w-a)[^<]*</,'raw IDs are not shown as text');
  assert.match(html,/autoComplete="new-password"|autocomplete="new-password"/);
  assert.deepEqual(sent.map(r=>r.action),['status'],'rendering dispatched nothing');
});

test('WhatsApp review shows the exact approved text, SID hint, variables and revision; incomplete template data stays unapprovable; calls are not proof of listening',async()=>{
  const binding={routeId:'route-1',routeRevision:2,recipientId:'contact-1',recipientSha256:'a'.repeat(64),workflowId:'w-1',templateId:'t-1',templateVersion:4,bodySha256:'b'.repeat(64)};
  const body={renderedText:'Capri is requested.',contentSid,variables:{'1':'requested'},language:'en',templateSha256:'c'.repeat(64)};
  const review=(content:string)=>({requestId:'send-1',reviewId:'review-1',privacyEpoch:randomUUID(),reviewDigest:'d'.repeat(64),revision:3,expiresAt:Date.now()+60000,binding,channel:'whatsapp' as const,destination:'whatsapp:'+friend,sender:'whatsapp:'+sender,content:{kind:'message' as const,body:content},contentClass:'personal' as const});
  const html=renderToStaticMarkup(<ContactReviewDetails review={review(JSON.stringify(body))}/>);
  assert.match(html,/Approved WhatsApp template HXbb…bbbb · language en · template revision 4/);assert.match(html,/>Capri is requested\.</);assert.match(html,/\{\{1\}\} = requested/);
  assert.doesNotMatch(html,/renderedText|templateSha256/,'the raw envelope is not shown as the message');
  assert.equal(whatsAppReview(review(JSON.stringify({contentSid}))),undefined);
  assert.match(renderToStaticMarkup(<ContactReviewDetails review={review(JSON.stringify({contentSid}))}/>),/cannot be approved/);
  const outbox={id:'d-1',requestId:'send-1',binding,adapter:'twilio-whatsapp',state:'pending' as const,observedAt:1,evidence:{source:'none' as const}};
  for(const content of[JSON.stringify({contentSid}),JSON.stringify({...body,extra:true}),'not json']){
    const hostEpoch=randomUUID();
    const read=await readContactReview(async method=>method==='GET'?{ok:true,body:{protocol:'capri-private-v1',privacyEpoch:hostEpoch,privateSession:false,revision:1}}:{ok:true,body:{...review(content),privacyEpoch:hostEpoch}},outbox,'local',{});
    assert.equal(read.kind,'error',content);assert.match((read as any).message,/cannot be approved/);
  }
  const voice=(state:'accepted'|'sent'|'delivered')=>deliveryBadge({...outbox,adapter:'twilio-voice',state,evidence:{source:'observed-record',recordId:'CA1'}});
  assert.equal(voice('delivered').tag,'CALL CONNECTED');assert.match(voice('delivered').text,/not proof a person listened/);assert.match(voice('accepted').text,/not connected yet/);
  assert.match(contactEvidenceText({kind:'delivery',requestId:'r',state:'delivered',adapter:'twilio-voice',remote:true}),/voicemail/);
  assert.match(contactEvidenceText({kind:'delivery',requestId:'r',state:'sent',adapter:'twilio-sms',remote:false}),/unknown/,'sent without remote evidence is not sent');
});

test('a service composed without the desktop contact owner reports setup unavailable, never configured',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'capri-contact-ui-none-')),store=await new Store(directory,randomBytes(32)).init();
  const service=await createService({store,adminToken:randomUUID(),key:()=>undefined});
  try{
    const c=createContactAdminController({bridge:r=>service.desktopContactAdministration(r,()=>{}),gate:createReadGate(),scope:{epoch:'e1',privateSession:false}});
    await c.refresh();const view=c.snapshot().status;
    assert.equal(view.kind,'error');assert.match((view as any).message,/desktop contact owner is unavailable.*Nothing is shown as configured/);
    assert.match(c.blocked('configure-twilio')!,/Read setup status first/);
    const html=renderToStaticMarkup(<ContactSetup admin={c} snap={c.snapshot()} act={()=>{}} privateSession={false} now={1}/>);
    assert.doesNotMatch(html,/>READY<|>CONNECTED<|>CREDENTIALS SAVED</);
  }finally{await service.app.close();await rm(directory,{recursive:true,force:true});}
});

test('android readiness is the owner’s pairing check, never a pair record alone; capabilities stay independent of text-model preference',()=>{
  const limits={enabled:true,unitCostMicros:0,maxDispatchCostMicros:0,dailyBudgetMicros:0,maxPerMinute:1,maxPerDay:1};
  const android=(patch:object)=>contactChannelBadge({channel:'android',configured:true,enabled:true,ready:false,secretStored:false,limits,...patch},'ready');
  assert.equal(android({}).tag,'NOT READY');assert.match(android({}).text,/A pair record alone does not make the phone reachable/);
  assert.match(android({ready:true}).text,/Only the phone’s own receipt confirms delivery/);
  assert.equal(android({configured:false}).tag,'NOT CONFIGURED');assert.equal(android({enabled:false}).tag,'LIMITS OFF');
  const status=defaultExtensionStatus(1);status.features.contacts=featureCapability({enabled:true,configured:true,supported:true,ready:false});
  const html=renderToStaticMarkup(<ExtensionSettings contactAdmin={async()=>assert.fail('no read on render')} initial={{status:ready(status),settings:ready({...defaultExtensionSettings()})}}/>);
  assert.match(html,/Configured, but not ready/);assert.doesNotMatch(html,/OPENAI|LOCAL AI/);
});

test('dispatch fence: Stop, a privacy change or closing Settings before the IPC call dispatches nothing and reaches no provider',async()=>{
  const f=await fixture();try{
    // The controller rechecks liveness in the deferred dispatch step, after the caller has already been given a promise.
    const retire:((c:ReturnType<typeof controllerFor>)=>void)[]=[c=>c.sync({epoch:'e2',privateSession:false}),c=>c.sync({epoch:'e1',privateSession:true}),c=>c.close()];
    for(const boundary of retire){
      const gate=createReadGate(),c=createContactAdminController({bridge:f.bridge,gate,scope:{epoch:'e1',privateSession:false}});
      await c.refresh();const before=f.calls.length;
      const pending=c.run('set-limits',{channel:'sms',limits:smsLimits});boundary(c);
      assert.equal(await pending,undefined);assert.equal(f.calls.length,before,'no IPC after the boundary');assert.equal(gate.busy(contactAdminKey),false);
    }
    // The main-window bridge rechecks the renderer epoch and the view after the privacy synchronization it waits for.
    let epoch=1;const ipc:ContactAdminRequest[]=[];
    const agency=async(r:ContactAdminRequest)=>{ipc.push(r);return f.bridge(r,{epoch,live:()=>true});};
    const mainBridge=(sync:()=>Promise<unknown>)=>createMainContactBridge({agency,epoch:()=>epoch,privacySync:sync});
    const ok=createContactAdminController({bridge:mainBridge(async()=>{}),gate:createReadGate(),scope:{epoch:1,privateSession:false}});
    const {route}=await configured(f,ok);await verified(f,ok,route);const {workflowId}=await workflow(ok,route);
    const sent=ipc.length,posts=f.posts();assert.ok(sent>0,'a current view dispatches normally');
    const stop=deferred<unknown>(),c=createContactAdminController({bridge:mainBridge(()=>stop.promise),gate:createReadGate(),scope:{epoch:1,privateSession:false}});
    const reading=c.refresh();await tick();epoch=2;stop.resolve(undefined);await reading;
    assert.equal(ipc.length,sent,'Stop during privacy synchronization: nothing reached IPC');
    assert.match((c.snapshot().status as {message:string}).message,/not read: this view changed before the request left it/);
    epoch=1;await c.refresh();assert.equal(c.snapshot().status.kind,'ready');
    const privacy=deferred<unknown>();let bridgeSync=()=>privacy.promise;
    const held=createContactAdminController({bridge:mainBridge(()=>bridgeSync()),gate:createReadGate(),scope:{epoch:1,privateSession:false}});
    bridgeSync=async()=>{};await held.refresh();bridgeSync=()=>privacy.promise;
    const sending=held.run('prepare-notification',{workflowId},'send:'+workflowId);await tick();
    assert.equal(held.snapshot().held[workflowId]?.state,'pending','an in-flight send is held before dispatch');
    epoch=3;privacy.resolve(undefined);const refused=await sending;
    assert.equal(refused?.state,'rejected');assert.match(refused!.message,/Not sent: this view changed before the request left it/);
    assert.equal(held.snapshot().held[workflowId],undefined,'nothing was dispatched, so nothing stays held');
    const closing=deferred<unknown>();epoch=1;bridgeSync=()=>closing.promise;
    const late=held.run('prepare-notification',{workflowId},'send:'+workflowId);await tick();held.close();closing.resolve(undefined);
    assert.equal(await late,undefined);
    const failing=createContactAdminController({bridge:mainBridge(async()=>{throw Error('privacy sync failed');}),gate:createReadGate(),scope:{epoch:1,privateSession:false}});
    await failing.refresh();assert.equal(failing.snapshot().status.kind,'error');
    assert.equal(ipc.length,sent+2,'only the two deliberate status reads reached IPC');assert.equal(f.posts(),posts,'no provider effect');
  }finally{await f.cleanup();}
});

test('verification challenges: expiry, route edits and used-up attempts retire a code and offer a deliberate new paid challenge',async()=>{
  const f=await fixture();try{
    const c=controllerFor(f);const {route}=await configured(f,c,'contact');
    const view=()=>{const r=status(c).routes.find(x=>x.id===route)!;return contactChallengeView(r,c.snapshot().challenges[route],c.snapshot().uncertain[route],f.now());};
    const render=()=>renderToStaticMarkup(<ContactSetup admin={c} snap={c.snapshot()} act={()=>{}} privateSession={false} now={f.now()}/>);
    assert.equal(view().kind,'none');assert.match(render(),/<button class="text-link">Verify recipient…<\/button>/);
    assert.equal((await c.run('verify-begin',{routeId:route},'verify-begin:'+route))?.state,'completed');assert.equal(view().kind,'code');
    assert.match(render(),/aria-label="Verification code for Recipient 1"/);assert.match(render(),/5 attempts left/);
    const first=c.snapshot().challenges[route]!;
    f.advance(contactChallengeLifetimeMs+1);assert.deepEqual(view(),{kind:'renew',reason:'expired'});
    let html=render();assert.doesNotMatch(html,/Verification code for/);assert.match(html,/earlier verification code expired\. A new code needs a new provider message/);
    assert.match(html,/<button class="text-link">Request a new code…<\/button>/,'a new paid challenge starts with its cost confirmation');
    await c.refresh();
    assert.notEqual((await c.run('verify-complete',{routeId:route,challengeId:first.challengeId,code:await f.code(first.challengeId)},'verify-complete:'+route))?.state,'completed','the owner refuses an expired code as well');
    await c.refresh();let posts=f.posts();
    assert.equal((await c.run('verify-begin',{routeId:route},'verify-begin:'+route))?.state,'completed');assert.equal(f.posts(),posts+1,'exactly one new message, on request');
    const second=c.snapshot().challenges[route]!;assert.notEqual(second.challengeId,first.challengeId);assert.equal(view().kind,'code');
    const right=await f.code(second.challengeId),wrong=right==='000000'?'111111':'000000';
    for(let i=0;i<5;i++){await c.refresh();assert.notEqual((await c.run('verify-complete',{routeId:route,challengeId:second.challengeId,code:wrong},'verify-complete:'+route))?.state,'completed');}
    assert.deepEqual(view(),{kind:'renew',reason:'exhausted'});assert.match(render(),/too many attempts and can no longer be used/);
    await c.refresh();assert.notEqual((await c.run('verify-complete',{routeId:route,challengeId:second.challengeId,code:right},'verify-complete:'+route))?.state,'completed','the owner also refuses a sixth attempt');
    f.advance(61000);await c.refresh();posts=f.posts();
    assert.equal((await c.run('verify-begin',{routeId:route},'verify-begin:'+route))?.state,'completed');assert.equal(view().kind,'code');
    // Editing the recipient invalidates its outstanding challenge and asks for a new one.
    assert.equal((await c.run('save-route',{routeId:route,channel:'sms',destination:friend,kind:'contact',optedIn:true}))?.state,'completed');
    assert.deepEqual(view(),{kind:'renew',reason:'changed'});html=render();assert.match(html,/changed after its code was sent/);assert.doesNotMatch(html,/Verification code for/);
    assert.equal(f.posts(),posts+1);assert.equal(status(c).routes.find(r=>r.id===route)!.verified,false);
  }finally{await f.cleanup();}
});

test('an uncertain challenge keeps its identities for a read-only provider check; code entry waits for matching acceptance and nothing is resent',async()=>{
  const f=await fixture();try{
    const c=controllerFor(f);const {route}=await configured(f,c,'contact');
    const view=()=>{const r=status(c).routes.find(x=>x.id===route)!;return contactChallengeView(r,c.snapshot().challenges[route],c.snapshot().uncertain[route],f.now());};
    f.postFailure(true);const posts=f.posts();
    const begun=await c.run('verify-begin',{routeId:route},'verify-begin:'+route);
    assert.equal(begun?.state,'unconfirmed');assert.equal(posts,f.posts(),'the failed POST was not counted as a sent record');
    const v=view();assert.notEqual(v.kind,'code','no code entry without provider acceptance');assert.notEqual(v.kind,'none','no new challenge is offered while one may be outstanding');
    const html=renderToStaticMarkup(<ContactSetup admin={c} snap={c.snapshot()} act={()=>{}} privateSession={false} now={f.now()}/>);
    assert.doesNotMatch(html,/Verification code for|Verify recipient…|Request a new code…/);
    if(v.kind==='check'){
      assert.match(html,/<button class="text-link">Check provider record<\/button>/);assert.equal(v.challenge.requestId,begun!.outboxRequestId);
      f.postFailure(false);const gets=f.gets();
      const checked=await c.run('reconcile',{outboxRequestId:v.challenge.requestId},'verify-check:'+route);
      assert.equal(checked?.state,'completed');assert.equal(checked?.evidence?.kind,'verification');assert.equal(checked?.evidence?.challengeId,v.challenge.challengeId);
      assert.equal(view().kind,'check','unconfirmed evidence does not enable code entry');assert.equal(f.posts(),posts,'reconciliation never POSTs');assert.ok(f.gets()>=gets);
    }else assert.equal(v.kind,'wait');
    f.advance(contactChallengeLifetimeMs+1);assert.ok(['renew','none'].includes(view().kind),'after the lifetime a deliberate new challenge is offered');
  }finally{await f.cleanup();}
});

test('reconciled challenge acceptance must match the stored challenge; an identity-less unknown waits out the lifetime',async()=>{
  const base=ContactAdminStatusSchema.parse({revision:2,state:'ready',channels:[],routes:[{id:'route-a',revision:3,channel:'sms',kind:'contact',enabled:true,optedIn:true,verified:false}],templates:[],workflows:[],rules:[],oauthPending:false,billing:'local-conservative-estimate'});
  let now=1000,mode:'pending'|'throw'='pending',reconciled:{challengeId:string;state:string}={challengeId:'ch-1',state:'accepted'};
  const receipt=(r:ContactAdminRequest)=>({id:'x-'+r.requestId,requestId:r.requestId,feature:'contacts',action:r.action,observedAt:1,outcome:'completed',effect:r.action==='reconcile'?'none':'confirmed'});
  const verification=(state:string,challengeId='ch-1')=>({kind:'verification',requestId:'vr-1',challengeId,receiptId:'rc-1',adapter:'twilio-sms',state,observedAt:1,evidence:state==='pending'?{source:'none'}:{source:'observed-record',recordId:'SM1'}});
  const bridge:ContactAdminBridge=async r=>{
    if(r.action==='status')return {requestId:r.requestId,status:base};
    if(r.action==='verify-begin'){if(mode==='throw')throw Error('lost');return {receipt:receipt(r),status:base,challenge:{challengeId:'ch-1',requestId:'vr-1',expiresAt:now+300000},result:verification('pending')};}
    if(r.action==='reconcile')return {receipt:receipt(r),status:base,result:verification(reconciled.state,reconciled.challengeId)};
    throw Error('unexpected');
  };
  const c=createContactAdminController({bridge,gate:createReadGate(),scope:{epoch:'e1',privateSession:false},clock:()=>now});
  const route=base.routes[0],view=()=>contactChallengeView(route,c.snapshot().challenges['route-a'],c.snapshot().uncertain['route-a'],now);
  await c.refresh();assert.equal((await c.run('verify-begin',{routeId:'route-a'}))?.state,'pending');assert.equal(view().kind,'check');
  reconciled={challengeId:'ch-other',state:'accepted'};await c.run('reconcile',{outboxRequestId:'vr-1'});assert.equal(view().kind,'check','evidence for another challenge is ignored');
  reconciled={challengeId:'ch-1',state:'accepted'};const read=await c.run('reconcile',{outboxRequestId:'vr-1'});
  assert.match(read!.message,/^Read-only check: The provider accepted the verification challenge/);assert.equal(view().kind,'code','matching provider acceptance enables the code');
  // No challenge identity at all: the request may have sent a code, so a new one waits until that would have expired.
  now+=61000;mode='throw';const lost=await c.run('verify-begin',{routeId:'route-a'});
  assert.equal(lost?.state,'unconfirmed');assert.match(lost!.message,/A code may have been sent/);
  assert.equal(c.snapshot().challenges['route-a'],undefined,'an older code is not offered after an unknown new request');
  assert.equal(view().kind,'wait');now+=contactChallengeLifetimeMs+1;assert.equal(view().kind,'none');
});

test('nested receipts must carry the complete prepared binding and requested workflow, or the outcome stays unconfirmed',()=>{
  const binding={routeId:'route-1',routeRevision:2,recipientId:'contact-1',recipientSha256:'a'.repeat(64),workflowId:'w-1',templateId:'t-1',templateVersion:4,bodySha256:'b'.repeat(64)};
  const delivery=(patch:object={},state='accepted')=>({id:'d-1',requestId:'o-1',binding:{...binding,...patch},adapter:'twilio-sms',state,observedAt:1,evidence:{source:'service-receipt',recordId:'SM1'}});
  const top=(action:string)=>({id:'x',requestId:'mine',feature:'contacts',action,observedAt:1,outcome:'completed',effect:'confirmed'});
  const send=(d:object,intent:object=binding)=>({receipt:top('prepare-notification'),intent:{requestId:'o-1',binding:intent},result:{id:'y',requestId:'o-1',feature:'contacts',action:'send',observedAt:1,outcome:'completed',effect:'confirmed',delivery:d}});
  const ask={requestId:'mine',action:'prepare-notification' as const,workflowId:'w-1'};
  assert.equal(interpretContactAdminReply(ask,send(delivery())).note.state,'completed');
  for(const patch of[{routeId:'route-2'},{routeRevision:3},{recipientId:'contact-2'},{recipientSha256:'c'.repeat(64)},{templateId:'t-2'},{templateVersion:5},{bodySha256:'c'.repeat(64)},{workflowId:'w-2'}]){
    const read=interpretContactAdminReply(ask,send(delivery(patch)));
    assert.equal(read.note.state,'unconfirmed',JSON.stringify(patch));assert.equal(read.note.evidence,undefined);assert.doesNotMatch(read.note.message,/accepted|sent|delivered/);
  }
  assert.equal(interpretContactAdminReply({...ask,workflowId:'w-2'},send(delivery({workflowId:'w-2'}),{...binding,workflowId:'w-2'})).note.state,'completed');
  assert.equal(interpretContactAdminReply({...ask,workflowId:'w-3'},send(delivery())).note.state,'unconfirmed','a receipt for another workflow is not this send');
  assert.equal(interpretContactAdminReply({requestId:'mine',action:'prepare-notification'},send(delivery())).note.state,'unconfirmed');
  const rule=(d:object,workflowId='w-1')=>interpretContactAdminReply({requestId:'mine',action:'prepare-rule',workflowId},{receipt:top('prepare-rule'),intent:{requestId:'o-1',binding},result:d});
  assert.equal(rule(delivery({},'pending')).note.state,'completed');
  assert.equal(rule(delivery({templateVersion:9},'pending')).note.state,'unconfirmed');assert.equal(rule(delivery({},'pending'),'w-9').note.state,'unconfirmed');
});

test('an exact-rule draft keeps its purpose across leaving and reopening Settings and never becomes a send approval',async()=>{
  const f=await fixture();try{
    const runner=createActionRunner({request:f.request}),gate=runner.reads,scope={epoch:'e1',privateSession:false};
    const first=createContactAdminController({bridge:f.bridge,gate,scope});
    const {route}=await configured(f,first,'contact');await verified(f,first,route);const {workflowId}=await workflow(first,route,'task-completed');const count=f.posts();
    const prepared=await first.run('prepare-rule',{workflowId,completion:'unverified'},'rule:'+workflowId);const id=prepared!.outboxRequestId!;
    first.close();
    const second=createContactAdminController({bridge:f.bridge,gate,scope});
    assert.equal(second.snapshot().prepared[id],workflowId,'the draft purpose survives navigation');assert.equal(second.snapshot().status.kind,'unchecked','status is read again');
    const initial={status:await readExtensionStatus(f.request),settings:await readExtensionSettings(f.request),overviews:{contacts:await readOverview(f.request,'contacts')}};
    const html=renderToStaticMarkup(<ExtensionSettings runner={runner} request={f.request} contactAdmin={f.bridge} privacyEpoch="e1" initial={initial}/>);
    assert.match(html,/Prepared for an exact rule; approving a rule sends nothing now/);assert.match(html,/>Add exact rule for this message</);
    assert.doesNotMatch(html,/>Approve this exact message</,'a rule draft is never offered as a send approval');
    await second.refresh();
    const row=(initial.overviews.contacts as any).data.outbox.find((r:any)=>r.receipt.requestId===id);
    const review=await readContactReview(f.request,row.receipt,'e1',{privateSession:false});assert.equal(review.kind,'ready');
    const added=await second.run('add-rule',{outboxRequestId:id,review:approvalInput((review as any).review),expiresAt:f.now()+86400000},'add-rule:'+id);
    assert.equal(added?.state,'completed');assert.equal(f.posts(),count,'adding the rule sent nothing');
    const scoped=renderToStaticMarkup(<ContactSetup admin={second} snap={second.snapshot()} act={()=>{}} privateSession={false} now={f.now()} ruleScopes={(await readOverview(f.request,'contacts') as any).data.rules}/>);
    assert.match(scoped,/Rule 1 · sends Template 1 to Recipient 1 for Workflow 1 · active until/);
    const other=createContactAdminController({bridge:f.bridge,gate,scope:{epoch:'e2',privateSession:false}});
    assert.deepEqual(other.snapshot().prepared,{},'a privacy/Stop boundary forgets the draft purposes');
  }finally{await f.cleanup();}
});

test('a send still in flight when Settings closes stays held on return; its late receipt is kept for the owner scope only',async()=>{
  const base=ContactAdminStatusSchema.parse({revision:2,state:'ready',channels:[],routes:[],templates:[],workflows:[{id:'w-1',revision:1,enabled:true,trigger:'on-demand'}],rules:[],oauthPending:false,billing:'local-conservative-estimate'});
  const sends=deferred<unknown>(),calls:ContactAdminRequest[]=[];
  const bridge:ContactAdminBridge=r=>{calls.push(r);return r.action==='status'?Promise.resolve({requestId:r.requestId,status:base}):sends.promise;};
  const gate=createReadGate(),scope={epoch:'e1',privateSession:false};
  const a=createContactAdminController({bridge,gate,scope});await a.refresh();
  const sending=a.run('prepare-notification',{workflowId:'w-1'},'send:w-1');await tick();a.close();
  const b=createContactAdminController({bridge,gate,scope});
  assert.equal(b.snapshot().held['w-1']?.state,'pending');assert.equal(b.snapshot().busy,true);
  b.release('w-1');assert.ok(b.snapshot().held['w-1'],'no release while the request is unsettled');
  const r=calls.at(-1)!;let seen=0;const off=b.subscribe(()=>seen++);
  sends.resolve({receipt:{id:'x',requestId:r.requestId,feature:'contacts',action:'prepare-notification',observedAt:1,outcome:'unconfirmed',effect:'unknown',error:{code:'unconfirmed',message:'x',retry:'read-only-reconcile'}}});
  assert.equal(await sending,undefined);off();
  assert.equal(b.snapshot().held['w-1']?.state,'unconfirmed','the late unknown receipt still holds the workflow');assert.ok(seen>0,'the reopened view re-renders');
  await b.refresh();const html=renderToStaticMarkup(<ContactSetup admin={b} snap={b.snapshot()} act={()=>{}} privateSession={false} now={1}/>);
  assert.match(html,/no new send is offered/);assert.doesNotMatch(html,/<button[^>]*>Send notification[^<]*<\/button>/);
  assert.equal(calls.filter(x=>x.action==='prepare-notification').length,1,'nothing was resent');
});

/*
 * Rendered interaction through the real react-dom/client renderer: clicks, typing, selects, effects, unmount and
 * remount against the real owner/service. The DOM below is a minimal in-process stand-in (no browser engine, layout,
 * focus traversal or paint), so it is interaction evidence for React handlers and lifecycle, not a screenshot.
 */
const HTML_NS='http://www.w3.org/1999/xhtml';
class FakeNode {
  parentNode:FakeNode|null=null;childNodes:FakeNode[]=[];listeners=new Map<string,{fn:(e:unknown)=>void;capture:boolean}[]>();
  constructor(public nodeType:number,public nodeName:string,public ownerDocument:any){}
  get firstChild():FakeNode|null{return this.childNodes[0]??null;}
  get lastChild():FakeNode|null{return this.childNodes.at(-1)??null;}
  get nextSibling():FakeNode|null{const p=this.parentNode;return p?p.childNodes[p.childNodes.indexOf(this)+1]??null:null;}
  get parentElement():FakeNode|null{return this.parentNode?.nodeType===1?this.parentNode:null;}
  appendChild(c:FakeNode){c.parentNode?.removeChild(c);this.childNodes.push(c);c.parentNode=this;return c;}
  insertBefore(c:FakeNode,before:FakeNode|null){if(!before)return this.appendChild(c);c.parentNode?.removeChild(c);this.childNodes.splice(this.childNodes.indexOf(before),0,c);c.parentNode=this;return c;}
  removeChild(c:FakeNode){const i=this.childNodes.indexOf(c);if(i>=0)this.childNodes.splice(i,1);c.parentNode=null;return c;}
  contains(n:FakeNode|null){for(let x=n;x;x=x.parentNode)if(x===this)return true;return false;}
  getRootNode(){let x:FakeNode=this;while(x.parentNode)x=x.parentNode;return x;}
  addEventListener(type:string,fn:(e:unknown)=>void,options?:boolean|{capture?:boolean}){const capture=typeof options==='boolean'?options:!!options?.capture;this.listeners.set(type,[...this.listeners.get(type)??[],{fn,capture}]);}
  removeEventListener(type:string,fn:(e:unknown)=>void,options?:boolean|{capture?:boolean}){const capture=typeof options==='boolean'?options:!!options?.capture;this.listeners.set(type,(this.listeners.get(type)??[]).filter(l=>l.fn!==fn||l.capture!==capture));}
  get textContent():string{return this.childNodes.map(c=>c.textContent).join('');}
  set textContent(value:string){for(const c of this.childNodes)c.parentNode=null;this.childNodes=[];if(value)this.appendChild(this.ownerDocument.createTextNode(value));}
}
class FakeText extends FakeNode {
  constructor(public data:string,doc:any){super(3,'#text',doc);}
  get nodeValue(){return this.data;} set nodeValue(v:string){this.data=String(v);}
  override get textContent(){return this.data;} override set textContent(v:string){this.data=String(v);}
}
class FakeElement extends FakeNode {
  attributes=new Map<string,string>();namespaceURI=HTML_NS;style:Record<string,string>={};checked=false;selected=false;_value?:string;
  get tagName(){return this.nodeName;}
  get type(){return this.attributes.get('type')??(this.nodeName==='INPUT'?'text':'');} set type(v:string){this.attributes.set('type',String(v));}
  get options():FakeElement[]{const out:FakeElement[]=[];const walk=(n:FakeNode)=>{for(const c of n.childNodes)if(c instanceof FakeElement){if(c.nodeName==='OPTION')out.push(c);walk(c);}};walk(this);return out;}
  get value():string{if(this.nodeName==='SELECT'){const o=this.options.find(x=>x.selected)??this.options[0];return o?o.value:'';}
    return this._value??this.attributes.get('value')??(this.nodeName==='OPTION'?this.textContent:'');}
  set value(v:string){if(this.nodeName==='SELECT'){for(const o of this.options)o.selected=o.value===String(v);return;}this._value=String(v);}
  setAttribute(name:string,value:unknown){this.attributes.set(name,String(value));}
  getAttribute(name:string){return this.attributes.get(name)??null;}
  removeAttribute(name:string){this.attributes.delete(name);}
  hasAttribute(name:string){return this.attributes.has(name);}
  focus(){this.ownerDocument.activeElement=this;} blur(){if(this.ownerDocument.activeElement===this)this.ownerDocument.activeElement=this.ownerDocument.body;}
}
class FakeDocument extends FakeNode {
  activeElement:FakeElement;body:FakeElement;documentElement:FakeElement;defaultView:unknown=globalThis;oninput=null;
  constructor(){super(9,'#document',null);this.ownerDocument=null;this.documentElement=this.createElement('html');this.body=this.createElement('body');this.appendChild(this.documentElement);this.documentElement.appendChild(this.body);this.activeElement=this.body;}
  createElement(tag:string){return new FakeElement(1,tag.toUpperCase(),this);}
  createElementNS(ns:string,tag:string){const e=new FakeElement(1,tag,this);e.namespaceURI=ns;return e;}
  createTextNode(text:string){return new FakeText(String(text),this);}
  createComment(text:string){const c=new FakeText(String(text),this);c.nodeType=8;c.nodeName='#comment';return c;}
}
let fakeDom:{document:FakeDocument;createRoot:typeof import('react-dom/client').createRoot}|undefined;
async function dom(){
  if(fakeDom)return fakeDom;
  const document=new FakeDocument(),g=globalThis as any;
  Object.assign(g,{window:g,document,HTMLIFrameElement:class{},IS_REACT_ACT_ENVIRONMENT:true});
  const {createRoot}=await import('react-dom/client');return fakeDom={document,createRoot};
}
function fire(target:FakeElement,type:string){
  const event:any={type,target,bubbles:true,cancelable:true,defaultPrevented:false,timeStamp:Date.now(),isTrusted:true,button:0,_stop:false,
    preventDefault(){this.defaultPrevented=true;},stopPropagation(){this._stop=true;},stopImmediatePropagation(){this._stop=true;}};
  const path:FakeNode[]=[];for(let n:FakeNode|null=target;n;n=n.parentNode)path.push(n);
  (globalThis as any).event=event;
  try{
    for(const n of[...path].reverse()){event.currentTarget=n;for(const l of n.listeners.get(type)??[])if(l.capture)l.fn.call(n,event);if(event._stop)return;}
    for(const n of path){event.currentTarget=n;for(const l of n.listeners.get(type)??[])if(!l.capture)l.fn.call(n,event);if(event._stop)return;}
  }finally{delete (globalThis as any).event;}
}
const elements=(root:FakeNode,pred:(e:FakeElement)=>boolean)=>{const out:FakeElement[]=[];const walk=(n:FakeNode)=>{for(const c of n.childNodes)if(c instanceof FakeElement){if(pred(c))out.push(c);walk(c);}};walk(root);return out;};
const text=(root:FakeNode)=>root.textContent.replace(/\s+/g,' ');
const act=(work:()=>unknown)=>React.act(async()=>{await work();});
const settle=async()=>{for(let i=0;i<6;i++)await act(tick);};
function screen(root:FakeNode){
  const buttons=(label:string)=>elements(root,e=>e.nodeName==='BUTTON'&&e.textContent.trim()===label);
  const button=(label:string,index=0)=>{const b=buttons(label)[index];assert.ok(b,'button "'+label+'" is rendered');return b;};
  const field=(label:string)=>{const e=elements(root,x=>x.getAttribute('aria-label')===label)[0];assert.ok(e,'field "'+label+'" is rendered');return e;};
  const enabled=(b:FakeElement)=>!b.hasAttribute('disabled');
  return {buttons,button,field,enabled,text:()=>text(root),
    async click(target:FakeElement|string,index=0){const b=typeof target==='string'?button(target,index):target;assert.ok(enabled(b),'"'+b.textContent+'" is enabled');b.focus();await act(()=>fire(b,'click'));await settle();},
    async type(label:string,value:string){const e=field(label);e.focus();await act(()=>{Object.getOwnPropertyDescriptor(FakeElement.prototype,'value')!.set!.call(e,value);fire(e,'input');});},
    async choose(label:string,value:string){const e=field(label);await act(()=>{for(const o of e.options)o.selected=o.value===value;fire(e,'change');});},
    async toggle(box:FakeElement){await act(()=>{box.checked=!box.checked;fire(box,'click');});},
    checkbox:(labelText:string)=>{const l=elements(root,e=>e.nodeName==='LABEL'&&e.textContent.includes(labelText))[0];assert.ok(l,'checkbox "'+labelText+'"');return elements(l,e=>e.nodeName==='INPUT')[0];},
  };
}

test('rendered interaction: real clicks drive setup, verification, challenge recovery, exact-rule remount, delayed dispatch and private/Stop boundaries',async()=>{
  // The exact-review expiry timer uses real time, so this service clock starts at real time.
  const f=await fixture(Date.now());const {document,createRoot}=await dom();const container=document.createElement('div');document.body.appendChild(container);
  const root=createRoot(container as any);const errors:unknown[]=[],consoleError=console.error;console.error=(...args:unknown[])=>{errors.push(args);};
  try{
    let epoch=1,privateSession=false,sync:()=>Promise<unknown>=async()=>{};
    const runner=createActionRunner({request:f.request});
    const bridge=createMainContactBridge({agency:r=>f.bridge(r,{live:()=>true}),epoch:()=>epoch,privacySync:()=>sync()});
    const initial={status:await readExtensionStatus(f.request),settings:await readExtensionSettings(f.request)};
    const show=()=>act(()=>root.render(<ExtensionSettings runner={runner} request={f.request} contactAdmin={bridge} privacyEpoch={epoch} privateSession={privateSession} clock={f.now} initial={initial}/>));
    const ui=screen(container);
    await show();
    assert.equal(f.calls.length,0,'opening Settings dispatched nothing');assert.equal(f.posts()+f.gets()+f.opens.length,0);
    assert.match(ui.text(),/Setup status not loaded\. Nothing is read, connected or sent until you click/);
    await ui.click('Read setup status');
    assert.deepEqual(f.calls.map(r=>r.action),['status']);assert.match(ui.text(),/NOT CONFIGURED/);
    // Twilio credentials: the token is cleared on submit and only the receipt reports saved.
    await ui.type('Twilio account SID',account);await ui.type('Twilio sender number',sender);const token=randomBytes(20).toString('hex');await ui.type('Twilio auth token',token);
    assert.equal(ui.field('Twilio auth token').value,token);
    await ui.click('Save Twilio credentials');
    assert.equal(ui.field('Twilio auth token').value,'','the entered token is cleared');assert.match(ui.text(),/Twilio credentials saved and read back from protected storage\. This is not a provider test/);
    assert.match(ui.text(),/CREDENTIALS SAVED/);
    // Limits.
    await ui.toggle(ui.checkbox('Allow sending on this channel'));await ui.type('Estimated cost per unit','0.0001');await ui.type('Maximum cost per send','0.001');await ui.type('Daily budget','0.01');
    await ui.type('Maximum per minute','10');await ui.type('Maximum per day','50');
    await ui.click('Save limits');assert.match(ui.text(),/Limits saved\. Costs are local conservative estimates/);
    assert.match(ui.text(),/On · up to 10\/min and 50 per rolling day · estimate 0\.0001 per SMS segment/);
    // The ordinary messaging switch still goes through the existing feature-settings action.
    await ui.toggle(elements(container,e=>e.getAttribute('id')==='ext-contacts-enabled')[0]);await settle();assert.match(ui.text(),/Saved — confirmed by the service\./);
    assert.ok(!f.calls.some(r=>(r.action as string)==='configure'),'the switch is ordinary feature settings, not contact administration');
    // Recipient: someone else, explicit opt-in. Saving sends nothing and does not verify.
    await ui.type('Recipient address or number',friend);await ui.toggle(ui.checkbox('explicitly agreed'));
    await ui.click('Add recipient');assert.match(ui.text(),/Recipient saved but not verified/);assert.match(ui.text(),/Recipient 1 SMS · contact/);
    assert.equal(f.posts(),0,'credentials, limits and recipients sent nothing');
    // Verification: cost confirmation first, then exactly one message, then the code.
    assert.equal(ui.buttons('Send verification code').length,0);await ui.click('Verify recipient…');
    assert.match(ui.text(),/This sends one real verification message through the provider\. Local estimate: 0\.0001 per segment\. It is never resent automatically/);
    await ui.click('Cancel');assert.equal(ui.buttons('Send verification code').length,0,'cancel sends nothing');assert.equal(f.posts(),0);
    await ui.click('Verify recipient…');await ui.click('Send verification code');assert.equal(f.posts(),1);
    assert.match(ui.text(),/provider accepted the verification challenge/);ui.field('Verification code for Recipient 1');assert.match(ui.text(),/5 attempts left/);
    // Challenge recovery: the code lapses; a new one needs its own confirmation.
    const first=Object.values((await f.store.get('contact-outbox','main'))!.challenges as any[]).at(-1);
    f.advance(contactChallengeLifetimeMs+1);await show();
    assert.equal(elements(container,e=>e.getAttribute('aria-label')==='Verification code for Recipient 1').length,0,'an expired code is not offered');
    assert.match(ui.text(),/The earlier verification code expired\. A new code needs a new provider message/);
    await ui.click('Read setup status');await ui.click('Request a new code…');assert.match(ui.text(),/Any earlier code stops working/);
    await ui.click('Send a new verification code');assert.equal(f.posts(),2);
    const second=Object.values((await f.store.get('contact-outbox','main'))!.challenges as any[]).at(-1);assert.notEqual(second.id,first.id);
    await ui.type('Verification code for Recipient 1',second.code);await ui.click('Verify code');
    assert.match(ui.text(),/Recipient verified: the service matched the code from its own challenge/);assert.match(ui.text(),/VERIFIED/);
    // Template and a task-completed workflow, then an exact-rule draft.
    await ui.type('Template text','Capri is {{status}}.');await ui.click('Add template');assert.match(ui.text(),/Template saved as a new revision/);
    const option=(label:string,prefix:string)=>elements(ui.field(label),e=>e.nodeName==='OPTION'&&e.textContent.startsWith(prefix))[0].value;
    await ui.choose('Workflow trigger','task-completed');await ui.choose('Workflow recipient',option('Workflow recipient','Recipient 1'));await ui.choose('Workflow template',option('Workflow template','Template 1'));
    await ui.click('Add workflow');assert.match(ui.text(),/Workflow saved as a new revision/);
    await ui.click('Prepare exact rule review');assert.match(ui.text(),/Exact rule message prepared\. Nothing was sent/);assert.equal(f.posts(),2);
    await ui.click('Check status');await ui.click('Load messaging details');
    assert.equal(ui.buttons('Add exact rule for this message').length,1);assert.equal(ui.buttons('Approve this exact message').length,0);
    // Leave Settings and return: the draft keeps its rule purpose; status and previews are read again.
    await act(()=>root.render(<div/>));assert.equal(ui.text(),'');await show();
    assert.match(ui.text(),/Setup status not loaded/);
    await ui.click('Check status');await ui.click('Read setup status');await ui.click('Load messaging details');
    assert.equal(ui.buttons('Add exact rule for this message').length,1,'the remounted outbox still offers the rule');
    assert.equal(ui.buttons('Approve this exact message').length,0,'a rule draft is never offered as a send approval');
    assert.equal(ui.enabled(ui.button('Add exact rule for this message')),false,'no rule without the current exact preview');
    await ui.click('Show exact message');assert.match(ui.text(),/Capri is completed-unverified\./);
    await ui.click('Add exact rule for this message');assert.match(ui.text(),/Exact rule saved for this recipient, workflow and template revision.*Nothing was sent/);
    assert.equal(f.posts(),2,'adding the rule sent nothing');assert.doesNotMatch(ui.text(),/Capri is completed-unverified\./,'approval consumed the preview');
    await ui.click('Load messaging details');assert.match(ui.text(),/Rule 1 · sends Template 1 to Recipient 1 for Workflow 1 · active until/);
    // Delayed dispatch: Stop advances the epoch while the bridge waits for privacy synchronization.
    const waiting=deferred<unknown>();sync=()=>waiting.promise;const before=f.calls.length;
    await ui.click('Save limits');assert.match(ui.text(),/A setup request is waiting for its receipt/);
    epoch++;await show();waiting.resolve(undefined);await settle();
    assert.equal(f.calls.length,before,'Stop before dispatch: nothing reached the owner');assert.doesNotMatch(ui.text(),/Limits saved|waiting for its receipt/);
    assert.match(ui.text(),/Setup status not loaded/,'the boundary dropped setup status');sync=async()=>{};
    // Private session: setup reads still work, changes wait, and entered secrets do not survive the boundary.
    await ui.type('Twilio auth token','typed-but-not-saved');privateSession=true;epoch++;await show();
    assert.equal(ui.field('Twilio auth token').value,'','a privacy boundary clears entered secrets');
    await ui.click('Read setup status');assert.match(ui.text(),/Private session: setup changes wait until it ends/);
    for(const label of['Save limits','Add recipient','Add template','Add workflow','Disable Twilio'])assert.equal(ui.enabled(ui.button(label)),false,label+' waits for the private session to end');
    assert.equal(f.posts(),2);
    // Keyboard/form ownership of the rendered controls: native focusable elements, each with an accessible name.
    for(const e of elements(container,x=>['BUTTON','INPUT','SELECT','TEXTAREA'].includes(x.nodeName))){
      const named=e.nodeName==='BUTTON'?!!e.textContent.trim():!!e.getAttribute('aria-label')||!!e.getAttribute('id')||elements(e.parentNode!,x=>x===e).length>0&&e.parentElement?.nodeName==='LABEL';
      assert.ok(named,'accessible name for '+e.nodeName);assert.notEqual(e.getAttribute('tabindex'),'-1');
    }
    assert.ok(!text(container).includes(token),'the token is never rendered');
  }finally{console.error=consoleError;await act(()=>root.unmount());await f.cleanup();}
  assert.deepEqual(errors,[],'no React errors or warnings');
});

/** Mounts the real Settings view on the shared runner gate (same owner scope as controllers created on `runner.reads`). */
async function mounted(f:Fixture,runner:ReturnType<typeof createActionRunner>,bridge:ContactAdminBridge){
  const {document,createRoot}=await dom();const container=document.createElement('div');document.body.appendChild(container);
  const root=createRoot(container as any);const errors:unknown[]=[],consoleError=console.error;console.error=(...args:unknown[])=>{errors.push(args);};
  const initial={status:await readExtensionStatus(f.request),settings:await readExtensionSettings(f.request)};
  const show=()=>act(()=>root.render(<ExtensionSettings runner={runner} request={f.request} contactAdmin={bridge} privacyEpoch="e1" clock={f.now} initial={initial}/>));
  await show();
  return {ui:screen(container),show,hide:()=>act(()=>root.render(<div/>)),errors,
    async done(){console.error=consoleError;await act(()=>root.unmount());container.parentNode?.removeChild(container);}};
}

test('rendered: a rule preparation whose receipt arrives after the deadline is never offered as a send approval',async()=>{
  const f=await fixture(Date.now());const runner=createActionRunner({request:f.request}),gate=runner.reads,scope={epoch:'e1',privateSession:false};
  let view:Awaited<ReturnType<typeof mounted>>|undefined;
  try{
    const c=createContactAdminController({bridge:f.bridge,gate,scope});
    const {route}=await configured(f,c,'contact');await verified(f,c,route);
    // An ordinary on-demand send for the same recipient waits for exact approval: it has no rule-preparation history.
    const onDemand=(await workflow(c,route)).workflowId,generic=await c.run('prepare-notification',{workflowId:onDemand},'send:'+onDemand);
    assert.equal(generic?.state,'pending');const genericId=generic!.outboxRequestId!;
    const {workflowId}=await workflow(c,route,'task-completed');const count=f.posts();
    // The owner enqueues the rule draft at once; its reply is held past the renderer's deadline.
    const release=deferred<void>();let enqueued=false,expire:(()=>void)|undefined;
    const slow:ContactAdminBridge=async(r,fence)=>{const reply=await f.bridge(r,fence);if(r.action==='prepare-rule'){enqueued=true;await release.promise;}return reply;};
    const d=createContactAdminController({bridge:slow,gate,scope,timeoutMs:30000,setTimer:fn=>{expire=fn;return ()=>{};}});
    await d.refresh();
    assert.ok(d.snapshot().ruleFences,'snapshot exposes rule fences');
    const preparing=d.run('prepare-rule',{workflowId,completion:'unverified'},'rule:'+workflowId);
    assert.deepEqual(Object.values(d.snapshot().ruleFences),[workflowId],'the rule purpose is fenced before dispatch');
    while(!enqueued)await tick();expire!();
    const late=await preparing;assert.equal(late?.state,'unconfirmed');assert.match(late!.message,/rule message may have been prepared.*not offered as send approvals/);
    assert.deepEqual(d.snapshot().prepared,{},'no purpose was recorded from a missing receipt');
    const pending=(await f.store.get('contact-outbox','main'))!.entries.filter((e:any)=>e.intent.binding.workflowId===workflowId);assert.equal(pending.length,1,'the owner enqueued exactly one rule draft');
    const ruleId=pending[0].intent.requestId as string;
    // The real Settings view on the same owner scope: the ambiguous draft is blocked, the unrelated approval stays.
    view=await mounted(f,runner,f.bridge);const {ui}=view;
    await ui.click('Load messaging details');
    assert.match(ui.text(),/may be an exact-rule draft whose preparation receipt never arrived, so its purpose cannot be proved\. It is not offered for approval or as a rule, and nothing is sent/);
    assert.equal(ui.buttons('Approve this exact message').length,1,'only the ordinary send keeps its approval');
    assert.equal(ui.buttons('Add exact rule for this message').length,0,'an unproved draft is not offered as a rule either');
    assert.equal(ui.buttons('Show exact message').length,1);
    // Leaving and reopening Settings in the same session keeps the fence.
    await view.hide();await view.show();await ui.click('Load messaging details');
    assert.match(ui.text(),/purpose cannot be proved/);assert.equal(ui.buttons('Approve this exact message').length,1);
    // The late reply settles the fence for its own request: the draft is now a rule draft, still never a send approval.
    release.resolve();await settle();
    assert.deepEqual(d.snapshot().ruleFences,{});assert.equal(d.snapshot().prepared[ruleId],workflowId);
    assert.doesNotMatch(ui.text(),/purpose cannot be proved/);
    assert.equal(ui.buttons('Add exact rule for this message').length,1);assert.equal(ui.buttons('Approve this exact message').length,1,'the ordinary send only');
    const overview=await readOverview(f.request,'contacts') as any;
    assert.equal(overview.data.outbox.find((e:any)=>e.receipt.requestId===genericId).approvalRequired,true);
    assert.equal(overview.data.outbox.find((e:any)=>e.receipt.requestId===ruleId).receipt.state,'pending','the original rule draft is unchanged');
    assert.equal(f.posts(),count,'zero provider sends');assert.equal(f.calls.filter(r=>r.action==='prepare-rule').length,1,'never re-prepared');
  }finally{await view?.done();await f.cleanup();}
  assert.deepEqual(view?.errors,[],'no React errors or warnings');
});

test('rule fences: a mismatched late reply keeps the fence, a refusal releases it, and a privacy boundary forgets it',async()=>{
  const base=ContactAdminStatusSchema.parse({revision:2,state:'ready',channels:[],routes:[],templates:[],workflows:[{id:'w-1',revision:1,enabled:true,trigger:'task-completed'}],rules:[],oauthPending:false,billing:'local-conservative-estimate'});
  const binding={routeId:'route-1',routeRevision:2,recipientId:'contact-1',recipientSha256:'a'.repeat(64),workflowId:'w-1',templateId:'t-1',templateVersion:4,bodySha256:'b'.repeat(64)};
  const top=(r:ContactAdminRequest,outcome:'completed'|'rejected')=>({id:'x',requestId:r.requestId,feature:'contacts',action:'prepare-rule',observedAt:1,outcome,effect:outcome==='completed'?'confirmed':'none',...(outcome==='rejected'?{error:{code:'forbidden',message:'x',retry:'never'}}:{})});
  for(const [label,reply,kept] of[
    ['another workflow',(r:ContactAdminRequest)=>({receipt:top(r,'completed'),intent:{requestId:'o-1',binding:{...binding,workflowId:'w-2'}},result:{id:'d',requestId:'o-1',binding:{...binding,workflowId:'w-2'},adapter:'twilio-sms',state:'pending',observedAt:1,evidence:{source:'none'}}}),true],
    ['an unrecognized reply',()=>({nonsense:true}),true],
    ['a refusal before any effect',(r:ContactAdminRequest)=>({receipt:top(r,'rejected')}),false],
  ] as const){
    const pending=deferred<unknown>();let expire:(()=>void)|undefined;
    const bridge:ContactAdminBridge=r=>r.action==='status'?Promise.resolve({requestId:r.requestId,status:base}):pending.promise;
    const gate=createReadGate(),c=createContactAdminController({bridge,gate,scope:{epoch:'e1',privateSession:false},setTimer:fn=>{expire=fn;return ()=>{};}});
    await c.refresh();const run=c.run('prepare-rule',{workflowId:'w-1',completion:'verified'});await tick();
    const fenceId=Object.keys(c.snapshot().ruleFences)[0];assert.ok(fenceId,label);expire!();await run;
    pending.resolve((reply as (r:ContactAdminRequest)=>unknown)({requestId:fenceId} as ContactAdminRequest));await tick();await tick();
    assert.equal(Object.keys(c.snapshot().ruleFences).length,kept?1:0,label);assert.deepEqual(c.snapshot().prepared,{},label);
    const receipt={requestId:'o-1',binding} as DeliveryReceipt;
    assert.equal(contactRuleFenced(c.snapshot(),receipt),kept,label);
    if(kept){const other=createContactAdminController({bridge,gate,scope:{epoch:'e2',privateSession:false}});assert.deepEqual(other.snapshot().ruleFences,{},'a boundary forgets fences');}
  }
});

test('rendered: accepted, sent and delivered records keep a read-only provider check on the original request with no new POST',async()=>{
  const f=await fixture(Date.now());const runner=createActionRunner({request:f.request});let view:Awaited<ReturnType<typeof mounted>>|undefined;
  try{
    const c=createContactAdminController({bridge:f.bridge,gate:runner.reads,scope:{epoch:'e1',privateSession:false}});
    const {route}=await configured(f,c);await verified(f,c,route);await workflow(c,route);
    view=await mounted(f,runner,f.bridge);const {ui}=view;
    await ui.click('Read setup status');await ui.click('Send notification…');const before=f.posts();await ui.click('Send notification');
    assert.equal(f.posts(),before+1);assert.match(ui.text(),/The provider accepted the message \(provider receipt\)\. Delivery is not observed yet/);
    const sent=f.calls.at(-1)!;assert.equal(sent.action,'prepare-notification');
    const id=(await f.store.get('contact-outbox','main'))!.entries.at(-1).intent.requestId as string,posts=f.posts(),gets=f.gets();
    await ui.click('Load messaging details');assert.match(ui.text(),/ACCEPTED/);assert.equal(ui.buttons('Check provider record').length,1,'an accepted record can still be observed');
    f.mode('sent');await ui.click('Check provider record');
    assert.match(ui.text(),/Read-only check: The provider reports the message sent\. Delivery is not observed yet/);
    await ui.click('Load messaging details');assert.equal(ui.buttons('Check provider record').length,1,'a sent record can still be observed');
    f.mode('delivered');await ui.click('Check provider record');assert.match(ui.text(),/Read-only check: The provider reports the message delivered\./);
    await ui.click('Load messaging details');assert.equal(ui.buttons('Check provider record').length,0,'delivered is terminal');
    const checks=f.calls.filter(r=>r.action==='reconcile') as {outboxRequestId:string}[];
    assert.equal(checks.length,2);assert.ok(checks.every(r=>r.outboxRequestId===id),'every check names the original request');
    assert.equal(f.posts(),posts,'zero additional provider POSTs');assert.ok(f.gets()>=gets+2,'each check was a provider read');
    const row=((await readOverview(f.request,'contacts')) as any).data.outbox.find((e:any)=>e.receipt.requestId===id);assert.equal(row.receipt.state,'delivered');
  }finally{await view?.done();await f.cleanup();}
  assert.deepEqual(view?.errors,[],'no React errors or warnings');
});

test('rendered: the recover-setup receipt stays visible after setup unlocks, and claims nothing configured',async()=>{
  const f=await fixture(Date.now());const runner=createActionRunner({request:f.request});let view:Awaited<ReturnType<typeof mounted>>|undefined;
  try{
    const c=createContactAdminController({bridge:f.bridge,gate:runner.reads,scope:{epoch:'e1',privateSession:false}});
    const {route}=await configured(f,c);await verified(f,c,route);
    const state=parseContactAuthority(await f.store.get(contactAuthorityKind,'main'));state.state='review-required';await writeContactAuthority(f.store,state);
    view=await mounted(f,runner,f.bridge);const {ui}=view;const posts=f.posts();
    await ui.click('Read setup status');assert.match(ui.text(),/could not be proved current/);assert.doesNotMatch(ui.text(),/Setup unlocked/);
    await ui.click('Start fresh contact setup…');await ui.click('Keep it locked');assert.doesNotMatch(ui.text(),/Setup unlocked/,'cancelling the confirmation changes nothing');
    await ui.click('Start fresh contact setup…');await ui.click('Start fresh contact setup');
    assert.doesNotMatch(ui.text(),/could not be proved current/,'the review block is gone once the receipt is ready');
    assert.match(ui.text(),/Setup unlocked\. Every earlier permission stays disabled: connect providers, set limits and verify recipients again\. Nothing is configured or verified yet\./);
    assert.doesNotMatch(ui.text().replace(/NOT (?:VERIFIED|READY)/g,''),/VERIFIED|CREDENTIALS SAVED|READY/,'no earlier permission is shown as current');
    assert.equal(f.posts(),posts);assert.equal(f.root().voice,'Designed A');
  }finally{await view?.done();await f.cleanup();}
  assert.deepEqual(view?.errors,[],'no React errors or warnings');
});
