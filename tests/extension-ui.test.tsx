import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ActionNote,ContactReviewDetails,ExtensionSettings,SkillsPanel,confirmedWrite,teachInput,emptyTeachForm,type ExtensionSettingsProps} from '../src/ui/ExtensionSettings';
import {
  actionEffect,approvalInput,capabilityBadge,contactReviewKey,createActionRunner,createContactReviewController,createSkillsSession,cursorBadge,deliveryBadge,extensionRoutes,interpretReply,olderServiceMessage,readContactReview,
  readCodexConnection,readExtensionSettings,readExtensionStatus,readKey,readOverview,reviewCurrent,scopedRunner,securityJobBadge,skillsCatalogKey,uiActionSchemas,updatesBadge,agentJobBadge,
  type ContactReview,type ExtensionReply,type ExtensionRequest,type ReadView,type SetTimer,type SkillCatalog,
} from '../src/ui/extensions-api';
import {defaultExtensionSettings,type ActionReceipt,type DeliveryReceipt,type ExtensionStatus,type SecurityJob} from '../src/extensions/contracts';
import {defaultExtensionStatus,featureCapability} from '../src/extensions/policy';

const A='a'.repeat(64),B='b'.repeat(64);
const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
/** Fake service: records every call and answers from a script; never touches a real provider. */
function fakeService(answer:(method:string,route:string,body:any)=>ExtensionReply|Promise<ExtensionReply>){
  const calls:{method:string;route:string;body:any}[]=[];
  const request:ExtensionRequest=async(method,route,body)=>{calls.push({method,route,body:structuredClone(body)});return answer(method,route,body);};
  return {calls,request};
}
const receipt=(body:any,patch:Partial<ActionReceipt>):ActionReceipt=>({id:'receipt-1',requestId:body.requestId,feature:'cursor',action:'configure',observedAt:10,outcome:'completed',effect:'confirmed',...patch} as ActionReceipt);
const ready=<T,>(data:T):ReadView<T>=>({kind:'ready',data,observedAt:1000});
const binding={routeId:'route-1',routeRevision:1,recipientId:'contact-1',recipientSha256:A,workflowId:'digest',templateId:'daily',templateVersion:1,bodySha256:B};
const delivery=(patch:Partial<DeliveryReceipt>):DeliveryReceipt=>({id:'d-1',requestId:'send-1',binding,adapter:'fake-mail',state:'pending',observedAt:10,evidence:{source:'none'},...patch} as DeliveryReceipt);
const readyCapability=(actions:string[])=>featureCapability({enabled:true,configured:true,supported:true,ready:true,verification:'local-probe',actions});
const render=(props:ExtensionSettingsProps)=>renderToStaticMarkup(<ExtensionSettings {...props}/>);
const disabledButton=(html:string,label:string)=>new RegExp('<button[^>]*disabled=""[^>]*>'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'</button>').test(html);
const enabledButton=(html:string,label:string)=>new RegExp('<button(?![^>]*disabled)[^>]*>'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'</button>').test(html);

test('skill readiness wording never presents reviewed guidance as a verified task outcome',()=>{
  const entry={skillId:'documents',version:'1',name:'Documents',manifestSha256:A,provenance:{kind:'built-in' as const},private:false,
    state:'ready' as const,localOnly:true,paidTools:[],missing:{capabilities:[],dependencies:[],checks:[]}};
  const html=renderToStaticMarkup(<SkillsPanel initialCatalog={ready({skills:[entry]})}/>);
  assert.match(html,/>READY TO USE</);assert.match(html,/Task verified is reported only after current-task outcome checks pass/);
  assert.doesNotMatch(html,/>TASK VERIFIED</);assert.match(html,/Revoke review/);
  const unavailable=renderToStaticMarkup(<SkillsPanel initialCatalog={ready({skills:[{...entry,state:'verification-required',missing:{...entry.missing,checks:['desktop-reinspect']}}]})}/>);
  assert.match(unavailable,/Window observations cannot yet verify arbitrary application effects/);
  const coding=renderToStaticMarkup(<SkillsPanel initialCatalog={ready({skills:[{...entry,skillId:'coding-workbench',name:'Coding',state:'verification-required',missing:{...entry.missing,checks:['command-exit-status']}}]})}/>);
  assert.match(coding,/CHECK UNAVAILABLE/);assert.match(coding,/JavaScript, .NET, Python, Cargo and Go/);
  assert.match(coding,/Other toolchains and arbitrary scripts are unavailable for verified completion/);assert.doesNotMatch(coding,/>READY TO USE</);
});

test('rendering the controls and skills panel makes no service request and claims nothing ready',()=>{
  const {calls,request}=fakeService(()=>assert.fail('render must not call the service'));
  const html=render({request,chooseFolder:async()=>assert.fail('render must not open a folder chooser')});
  const skills=renderToStaticMarkup(<SkillsPanel request={request}/>);
  assert.deepEqual(calls,[]);
  assert.match(html,/Status not loaded\. Nothing is read until you click/);assert.match(skills,/Catalog not loaded/);
  for(const text of[html,skills])assert.doesNotMatch(text,/>READY<|connected|>SENT<|>NO DETECTIONS<|>ACCEPTED</i);
  assert.ok(disabledButton(html,'Quick scan'),'scans stay disabled until the service reports them ready');
  assert.ok(disabledButton(html,'Check for updates'));
});

test('the skills switch requires confirmed settings and changes only its enabled flag through a settings receipt',async()=>{
  const {calls,request}=fakeService((_method,_route,body)=>({ok:true,body:receipt(body,{feature:'skills',action:'configure'})}));
  assert.match(render({request}),/id="ext-skills-enabled"[^>]*disabled=""/);
  const settings=defaultExtensionSettings(),status=defaultExtensionStatus(1000);
  const off=render({request,initial:{settings:ready(settings),status:ready(status)}});
  assert.match(off,/Use reviewed skills/);
  assert.doesNotMatch(off,/id="ext-skills-enabled"[^>]*(?:disabled|checked)=""/);
  settings.skills.enabled=true;
  assert.match(render({request,initial:{settings:ready(settings),status:ready(status)}}),/id="ext-skills-enabled"[^>]*checked=""/);
  assert.equal(calls.length,0,'rendering never enables skills');
  assert.equal(actionEffect('skills/configure'),'settings');
  assert.equal(uiActionSchemas['skills/configure'].safeParse({enabled:true,permissions:['delegate']}).success,false);
  const runner=createActionRunner({request});
  const result=await runner.run('skills/configure',{enabled:true})!;
  assert.equal(result.state,'completed');assert.equal(runner.writeCount(),1);
  assert.equal(calls[0].route,'/v1/extensions/skills/configure');assert.deepEqual(calls[0].body.input,{enabled:true});
});

test('Codex settings show one-time isolated sign-in, explicit model choice and inference-free evidence',()=>{
  const f=fakeService(()=>assert.fail('render must not inspect accounts or start login'));
  const cold=render({request:f.request,initial:{settings:ready(defaultExtensionSettings())}});
  assert.ok(disabledButton(cold,'Connect Codex'));assert.ok(disabledButton(cold,'Inspect connection'));assert.ok(disabledButton(cold,'Cancel sign-in'));
  const base={state:'needs-sign-in' as const,authenticated:false,inferenceVerified:false as const,models:[]};
  const disconnected=render({request:f.request,initial:{settings:ready(defaultExtensionSettings()),codexConnection:ready(base)}});
  assert.ok(enabledButton(disconnected,'Connect Codex'));assert.ok(enabledButton(disconnected,'Inspect connection'));
  assert.match(disconnected,/existing ChatGPT account and plan/);assert.match(disconnected,/does not buy API credits/);assert.match(disconnected,/Setup makes no inference request/);
  const signedIn=render({request:f.request,initial:{settings:ready(defaultExtensionSettings()),codexConnection:ready({...base,state:'authenticated',authenticated:true,model:'catalog-model',models:['catalog-model','another-model']})}});
  assert.match(signedIn,/<option value="catalog-model" selected="">catalog-model<\/option>/);assert.match(signedIn,/inference access unverified/);
  assert.doesNotMatch(signedIn,/id="ext-agents-codex"[^>]*disabled/);
  const privateHtml=render({request:f.request,privateSession:true,privacyEpoch:'new-epoch',initial:{codexConnection:ready({...base,state:'connecting',sessionId:'old-private-session'})}});
  assert.ok(disabledButton(privateHtml,'Connect Codex'));assert.ok(disabledButton(privateHtml,'Cancel sign-in'));assert.doesNotMatch(privateHtml,/old-private-session/);
  assert.deepEqual(f.calls,[]);
});

test('Codex connection reads reject leaks and setup actions require matching receipts without storing service text',async()=>{
  const f=fakeService((method,route,body)=>method==='GET'?{ok:true,body:{state:'needs-sign-in',authenticated:false,inferenceVerified:false,models:[]}}:
    {ok:true,body:receipt(body,{feature:'agents',action:route.split('/').at(-1)!,outcome:'pending',effect:'queued',jobId:'setup-session'})});
  assert.equal((await readCodexConnection(f.request)).kind,'ready');assert.equal(f.calls[0].route,extensionRoutes.codexConnection);
  const runner=createActionRunner({request:f.request,newRequestId:()=> 'setup-request'});
  const result=await runner.run('agents/connect-codex',{});assert.equal(result?.state,'queued');assert.equal(f.calls[1].route,'/v1/extensions/agents/connect-codex');
  assert.equal(JSON.stringify(runner.log()).includes('setup-session'),false);
  assert.equal(uiActionSchemas['agents/connect-codex'].safeParse({type:'chatgptAuthTokens'}).success,false);
  assert.equal(uiActionSchemas['agents/cancel-codex'].safeParse({}).success,false);
  assert.equal(uiActionSchemas['agents/select-codex-model'].safeParse({model:'https://provider.invalid/'}).success,false);
  for(const extra of [{authUrl:'https://auth.openai.com/'},{email:'private@example.invalid'},{inferenceVerified:true}]){
    const view=await readCodexConnection(async()=>({ok:true,body:{state:'authenticated',authenticated:true,inferenceVerified:false,models:[],...extra}}));assert.equal(view.kind,'error');
  }
});

test('the default unconfigured status shows each provider unavailable and only recovery controls enabled',()=>{
  const status=defaultExtensionStatus(1000);
  const html=render({initial:{status:ready(status),settings:ready(defaultExtensionSettings())}});
  assert.equal((html.match(/>UNAVAILABLE · NOT CONFIGURED</g)??[]).length,6,'cursor, skills, security, contacts and both agent providers');
  assert.equal((html.match(/>UNAVAILABLE · UNTRUSTED</g)??[]).length,2,'update trust and update state');
  assert.match(html,/No operator-pinned release key/);assert.doesNotMatch(html,/>READY</);
  for(const label of['Health check','Quick scan','Signature update','Full scan…','Scan this path','Check for updates'])assert.ok(disabledButton(html,label),label);
  assert.ok(enabledButton(html,'Restore normal cursor'),'cursor recovery is reachable even though new changes are unavailable');
  assert.ok(enabledButton(html,'Enable animated cursor'),'settings can enable a feature that is currently off');
  assert.match(html,/id="ext-security-daily"[^>]*checked=""/,'daily 09:00 quick scan is the owner-selected default');
  assert.match(html,/id="ext-updates-auto"[^>]*checked=""/);assert.doesNotMatch(html,/id="ext-contacts-auto"[^>]*checked/);
});

test('an older service without extension routes gets an explanatory 404 state, not an error or success',async()=>{
  for(const reply of[{ok:false,status:404,message:'Not Found'},{ok:false,message:'Not Found'},{ok:false,message:'Request failed: 404'}] as ExtensionReply[]){
    const view=await readExtensionStatus(async()=>reply);
    assert.deepEqual(view,{kind:'unsupported',message:olderServiceMessage});
  }
  const html=render({initial:{status:{kind:'unsupported',message:olderServiceMessage}}});
  assert.match(html,/does not provide 0\.7 extension controls yet \(HTTP 404\)/);
  assert.ok(disabledButton(html,'Restore normal cursor')&&disabledButton(html,'Import cursor folder…'),'no actions against a service that lacks the routes');
  const post=interpretReply('cursor/restore','r-1',{ok:false,status:404,message:'Not Found'});
  assert.equal(post.state,'unsupported-service');assert.match(post.message,/No receipt was returned/);
  const failed=await readExtensionStatus(async()=>({ok:false,status:500,message:'boom'}));
  assert.equal(failed.kind,'error');assert.match((failed as any).message,/Status is unknown/);
  const malformed=await readExtensionStatus(async()=>({ok:true,body:{...defaultExtensionStatus(1),features:{}}}));
  assert.equal(malformed.kind,'error','a partial status is not displayed as ready');
});

test('only a matching receipt confirms an action; bare replies, mismatches and errors stay unconfirmed',()=>{
  const ok=(body:unknown):ExtensionReply=>({ok:true,body});
  const match=receipt({requestId:'r-1'},{});
  assert.equal(interpretReply('cursor/configure','r-1',ok(match)).state,'completed');
  assert.equal(interpretReply('cursor/configure','r-1',ok({ok:true})).state,'unconfirmed');
  assert.equal(interpretReply('cursor/configure','r-1',ok(undefined)).state,'unconfirmed');
  assert.equal(interpretReply('cursor/configure','r-2',ok(match)).state,'unconfirmed','another request ID is not evidence');
  assert.equal(interpretReply('cursor/restore','r-1',ok(match)).state,'unconfirmed','another action is not evidence');
  assert.equal(interpretReply('security/quick-scan','r-1',ok({...match,feature:'security',action:'quick-scan'})).state,'completed');
  const forged={...match,outcome:'completed',effect:'unknown'};
  assert.equal(interpretReply('cursor/configure','r-1',ok(forged)).state,'unconfirmed','structurally invalid receipts are not success');
  for(const message of['Contact delivery was rejected.','Your request was rejected as a result of our safety system.','fetch failed',''])
    assert.equal(interpretReply('contacts/approve','r-1',{ok:false,message}).state,'unconfirmed',message);
  const refused=receipt({requestId:'r-1'},{feature:'contacts',action:'approve',outcome:'rejected',effect:'none',error:{code:'approval-required',message:'Needs approval.',retry:'after-review'}});
  const rejected=interpretReply('contacts/approve','r-1',{ok:false,status:409,body:refused,message:'x'});
  assert.equal(rejected.state,'rejected');assert.match(rejected.message,/Needs your approval first/);
  const queued=interpretReply('security/full-scan','r-1',ok(receipt({requestId:'r-1'},{feature:'security',action:'full-scan',outcome:'pending',effect:'queued',jobId:'scan-1'})));
  assert.equal(queued.state,'queued');assert.match(queued.message,/not finished/);
  const unknown=interpretReply('agents/start','r-1',ok(receipt({requestId:'r-1'},{feature:'agents',action:'start',outcome:'unconfirmed',effect:'unknown',error:{code:'unconfirmed',message:'Outcome unknown.',retry:'read-only-reconcile'}})));
  assert.equal(unknown.state,'unconfirmed');assert.match(unknown.message,/Do not repeat it/);
});

test('the runner sends exactly one envelope per click, bounds pending work and never retries',async()=>{
  const replies:ReturnType<typeof deferred<ExtensionReply>>[]=[];
  const {calls,request}=fakeService(()=>{const d=deferred<ExtensionReply>();replies.push(d);return d.promise;});
  let n=0;const runner=createActionRunner({request,maxPending:2,newRequestId:()=>'req-'+(++n)});
  const first=runner.run('cursor/configure',{enabled:true,durationMs:0,watchdogLeaseMs:15000,intensity:1})!;
  assert.equal(runner.run('cursor/configure',{enabled:false}),undefined,'a second click on a pending control is refused');
  assert.equal(runner.outcome('cursor/configure')?.state,'pending');
  const second=runner.run('security/health',{})!;
  assert.equal(runner.run('updates/check',{}),undefined,'the pending bound is enforced');
  await tick();
  assert.deepEqual(calls.map(c=>[c.method,c.route]),[['POST','/v1/extensions/cursor/configure'],['POST','/v1/extensions/security/health']]);
  assert.deepEqual(calls[0].body,{requestId:'req-1',input:{enabled:true,durationMs:0,watchdogLeaseMs:15000,intensity:1}},'no task ID, approval or private flag in a settings envelope');
  replies[0].resolve({ok:false,message:'socket hang up'});replies[1].resolve({ok:true,body:receipt({requestId:'req-2'},{feature:'security',action:'health'})});
  assert.equal((await first).state,'unconfirmed');assert.equal((await second).state,'completed');
  await tick();assert.equal(calls.length,2,'nothing is retried after an unknown outcome');
  const third=runner.run('updates/check',{});assert.ok(third,'slots free up once receipts settle');
  await tick();replies[2].resolve({ok:false,message:'done'});assert.equal((await third).state,'unconfirmed');
});

test('invalid input and missing task scope are refused locally without dispatch',async()=>{
  const {calls,request}=fakeService(()=>assert.fail('nothing should be sent'));const runner=createActionRunner({request});
  assert.equal((await runner.run('security/custom-scan',{target:'..\\relative'})!).state,'invalid');
  assert.equal((await runner.run('security/custom-scan',{target:'C:\\Folder\\..\\x'})!).state,'invalid');
  assert.equal((await runner.run('contacts/configure',{enabled:'yes',automaticEnabled:false} as any)!).state,'invalid');
  for(const action of['contacts/configure-gmail','contacts/configure-twilio','contacts/verify-begin','contacts/verify-complete','contacts/add-rule','contacts/revoke-rule','contacts/budget','contacts/reconcile'])
    assert.equal(action in uiActionSchemas,false,action+' is desktop main-owner administration, never generic extension HTTP');
  assert.equal((await runner.run('agents/start',{provider:'codex',workspaceId:'ws-1',prompt:'Run checks'})!).state,'invalid','delegation needs a task');
  assert.equal((await runner.run('cursor/configure',{durationMs:5} as any)!).state,'invalid','trials are bounded');
  assert.equal((await runner.run('skills/review',{skillId:'s',manifestSha256:A,approved:true} as any)!).state,'invalid','no extra authority fields');
  assert.deepEqual(calls,[]);
});

test('secrets, prompts, bodies, addresses and paths never reach the log, outcome or rendered note, even when the service echoes them',async()=>{
  const secret='tw-secret-token-0000000000',prompt='Summarise my private medical notes',path=['C:','Users','me','Private'].join('\\'),address='alex.private@example.com';
  const echo=(body:any)=>'Error: '+JSON.stringify(body)+' '+address;
  // Three echo shapes: bridge-style error text, HTTP error with an echoed body, and a well-formed rejected receipt whose message echoes the input.
  // Contact credentials no longer travel here at all (see contact-owner-ui tests); a skills draft carries the secret-shaped text instead.
  const {calls,request}=fakeService((_m,route,body)=>route.endsWith('/agents/start')?{ok:false,status:400,body:{error:echo(body)},message:echo(body)}
    :route.endsWith('/skills/draft')?{ok:false,status:409,message:'x',body:{id:'rc-1',requestId:body.requestId,feature:'skills',action:'draft',observedAt:1,outcome:'rejected',effect:'none',error:{code:'invalid-request',message:echo(body).slice(0,200),retry:'never'}}}
    :{ok:false,message:echo(body)});
  const runner=createActionRunner({request,newRequestId:()=>'req-x'});
  const draft=teachInput({...emptyTeachForm,name:'Mail '+address,description:'Uses '+secret,summary:'Send it',keywords:'mail',tools:'read_file',steps:'Read',verify:'Check',checks:'artifact-readback'},'k1');
  const results=[await runner.run('skills/draft',{...draft,description:'Uses '+secret})!,
    await runner.run('agents/start',{provider:'codex',workspaceId:'ws-1',prompt},{taskId:'task-1'})!,
    await runner.run('security/custom-scan',{target:path})!,
    await runner.run('contacts/configure',{enabled:true,automaticEnabled:false})!];
  assert.equal(calls[0].body.input.description,'Uses '+secret,'the input goes only to the service');
  assert.equal(calls[1].body.taskId,'task-1');
  const logged=JSON.stringify(runner.log());
  const rendered=renderToStaticMarkup(<>{['skills/draft','agents/start','security/custom-scan','contacts/configure'].map(s=><ActionNote key={s} runner={runner} slot={s}/>)}</>);
  const outcomes=JSON.stringify(results.map(r=>r.message))+JSON.stringify(['skills/draft','agents/start','security/custom-scan','contacts/configure'].map(s=>runner.outcome(s)?.message));
  for(const text of[logged,rendered,outcomes])for(const value of[secret,prompt,path,address,'Private','medical','requestId','Error:'])assert.ok(!text.includes(value),value+' leaked');
  assert.deepEqual(results.map(r=>r.state),['rejected','unconfirmed','unconfirmed','unconfirmed']);
  assert.match(results[1].message,/The service rejected the input\./,'whitelisted status codes still give useful text');
  assert.match(results[0].message,/^The service rejected the input\.$/,'a rejected receipt shows only its error-code hint');
  assert.match(rendered,/The outcome is unknown\. Do not repeat it/);
});

test('delivery shows accepted or sent only with matching remote evidence, and outbox rows never expose hashes',()=>{
  assert.equal(deliveryBadge(delivery({state:'accepted',evidence:{source:'service-receipt',recordId:'remote-1'}})).tag,'ACCEPTED');
  assert.equal(deliveryBadge(delivery({state:'sent',evidence:{source:'observed-record',recordId:'remote-1'}})).tag,'SENT');
  assert.equal(deliveryBadge(delivery({state:'sent',evidence:{source:'none'}})).tag,'UNCONFIRMED','sent without a receipt is not sent');
  assert.equal(deliveryBadge(delivery({state:'accepted',evidence:{source:'service-receipt',recordId:'remote-1'}}),'send-2').tag,'UNCONFIRMED','a receipt for another request is not evidence');
  assert.equal(deliveryBadge(delivery({state:'rejected',evidence:{source:'trusted-pre-dispatch',code:'approval-required'}})).tag,'REJECTED');
  assert.equal(deliveryBadge(delivery({state:'pending'})).tag,'PENDING');
  const contacts={providers:[{channel:'gmail' as const,configured:true,secretStored:true,senderHint:'m…@example.com'}],
    routes:[{id:'route-1',revision:1,channel:'sms' as const,kind:'contact' as const,label:'Alex',enabled:true,verified:false}],rules:[],
    // An older service's unenforced monthly count is ignored, never displayed as a spending control.
    budget:{monthlyMessageLimit:20,usedThisMonth:null},
    outbox:[{receipt:delivery({requestId:'send-1',state:'pending'}),channel:'sms' as const,routeLabel:'Alex',draftKept:true,approvalRequired:true},
      {receipt:delivery({requestId:'send-2',state:'unconfirmed'}),channel:'gmail' as const,routeLabel:'Me',draftKept:true,approvalRequired:false},
      {receipt:delivery({requestId:'send-3',state:'sent',evidence:{source:'service-receipt',recordId:'remote-3'}}),channel:'gmail' as const,routeLabel:'Me',draftKept:false,approvalRequired:false}]};
  const html=render({privateSession:true,initial:{status:ready(defaultExtensionStatus(1)),overviews:{contacts:ready(contacts)}}});
  assert.ok(!html.includes(A)&&!html.includes(B),'recipient and body hashes are never displayed');
  assert.equal((html.match(/>SENT</g)??[]).length,1);assert.equal((html.match(/>UNCONFIRMED</g)??[]).length,1);
  assert.ok(disabledButton(html,'Approve this exact message'),'no blind approval without current exact details');
  assert.ok(disabledButton(html,'Show exact message'),'this service lacks the review-details action');
  assert.match(html,/Private session without a trusted privacy epoch/);
  assert.equal((html.match(/Check provider record/g)??[]).length,3,'pending, unconfirmed and sent rows can be observed read-only');
  assert.doesNotMatch(html,/<button[^>]*>[^<]*(?:resend|send again|retry)[^<]*<\/button>/i,'no resubmission control exists');
  assert.equal((html.match(/Draft kept/g)??[]).length,3,'pending row once; unconfirmed badge title and text once each; none for the sent row');
  assert.match(html,/secret stored \(hidden\)/);assert.doesNotMatch(html,/connected/i);
  assert.doesNotMatch(html,/type="password"/,'without the desktop main-owner bridge no credential field exists at all');
  assert.match(html,/Contact setup is available only in the Capri desktop window/);
  assert.match(html,/NOT VERIFIED/);assert.match(html,/Private session: private content is never sent automatically/);
  assert.doesNotMatch(html,/monthly|this month|Usage unknown/i,'no unenforced monthly-count control or claim');
});

test('Defender results come only from evidence correlated with the job',()=>{
  const job=(patch:Partial<SecurityJob>):SecurityJob=>({id:'scan-1',taskId:'task-1',requestId:'q-1',operation:'quick-scan',state:'completed',createdAt:1,evidence:[],...patch});
  const ev=(outcome:SecurityJob['evidence'][number]['outcome'],jobId='scan-1')=>({id:'e-'+outcome+jobId,jobId,source:'windows-defender' as const,observedAt:2,outcome,summary:'Fixed summary.'});
  assert.equal(securityJobBadge(job({})).tag,'NO EVIDENCE','a finished job without evidence is not clean');
  assert.equal(securityJobBadge(job({evidence:[ev('no-detection','scan-9')]})).tag,'NO EVIDENCE','evidence from another job is ignored');
  assert.equal(securityJobBadge(job({evidence:[ev('no-detection')]})).tag,'NO DETECTIONS');
  assert.equal(securityJobBadge(job({state:'running',evidence:[ev('no-detection')]})).tag,'RUNNING','no clean claim before completion');
  for(const outcome of['action-required','unavailable','uncertain','remediated'] as const)assert.notEqual(securityJobBadge(job({evidence:[ev(outcome)]})).tag,'NO DETECTIONS');
  assert.match(securityJobBadge(job({operation:'status',evidence:[ev('healthy')]})).text,/not a scan result/);
  const overview={profile:'development' as const,jobs:[job({evidence:[ev('action-required')]}),job({id:'scan-2',state:'running'})]};
  const status=defaultExtensionStatus(1);status.features.security=readyCapability(['health','quick-scan','full-scan','custom-scan','update-signatures']);
  const html=render({initial:{status:ready(status),overviews:{security:ready(overview)}}});
  assert.match(html,/development profile: scheduled scans never run here/);assert.match(html,/ACTION REQUIRED/);
  assert.ok(enabledButton(html,'Quick scan')&&enabledButton(html,'Full scan…'),'ready actions are offered');
  assert.doesNotMatch(html,/Start full scan/,'a full scan needs a second explicit confirmation');
  assert.equal((html.match(/Stop monitoring/g)??[]).length,1);
});

test('agent rows use activity redaction and never treat a finished turn as verified work',()=>{
  assert.match(agentJobBadge({id:'j',taskId:'t',requestId:'r',provider:'codex',workspaceId:'w',state:'completed',createdAt:1,updatedAt:2,summary:''}).text,/not proof/);
  const status=defaultExtensionStatus(1);
  const agents={tasks:[{id:'task-1',label:'Fix api_key=abcd1234 build'}],workspaces:[{id:'ws-1',label:'Project token: hunter22'}],grants:[],
    jobs:[{id:'job-1',taskId:'task sk-abcdefghijklmnop',requestId:'r-1',provider:'codex' as const,workspaceId:'ws-1',state:'running' as const,createdAt:1,updatedAt:2,summary:'Used password=letmein1 to log in'}]};
  const html=render({privateSession:true,initial:{status:ready(status),overviews:{agents:ready(agents)}}});
  for(const leaked of['abcd1234','hunter22','sk-abcdefghijklmnop','letmein1'])assert.ok(!html.includes(leaked),leaked);
  assert.match(html,/\[redacted\]/);assert.match(html,/Private session: remote agents are never used/);
  assert.ok(disabledButton(html,'Start agent'),'unavailable providers and private sessions cannot start agents');
  assert.ok(enabledButton(html,'Cancel'),'cancel stays reachable for a running job');
});

test('cursor and update badges report session mode, suspension and verified availability truthfully',()=>{
  assert.match(cursorBadge({state:'active',watchdogExpiresAt:25000,recoveryAvailable:true},1000).text,/until you disable it, Stop or quit/);
  assert.match(cursorBadge({state:'active',expiresAt:31000,recoveryAvailable:true},1000).text,/30 s/);
  assert.match(cursorBadge({state:'suspended',suspensionReason:'game-docked',recoveryAvailable:true},0).text,/game is docked.*preference is kept/);
  assert.equal(cursorBadge({state:'recovery-required',recoveryAvailable:true},0).tone,'error');
  const status:ExtensionStatus=defaultExtensionStatus(1);
  assert.equal(updatesBadge(status).tag,'UNAVAILABLE · UNTRUSTED');
  const available={...status,updates:{state:'available' as const,version:'0.7.1-preview.2'},features:{...status.features,updates:featureCapability({enabled:true,configured:true,supported:true,trusted:true,verification:'verified',actions:['check','stage','rollback']})}};
  assert.equal(updatesBadge(available).tag,'AVAILABLE');assert.match(updatesBadge(available).text,/not installed/);
  assert.equal(updatesBadge({...available,features:{...available.features,updates:{...available.features.updates,verification:'configuration'}}}).tag,'STATUS UNKNOWN');
  const html=render({initial:{status:ready(available),settings:ready(defaultExtensionSettings())}});
  assert.ok(enabledButton(html,'Stage 0.7.1-preview.2'));assert.doesNotMatch(html,/Roll back now/,'rollback needs a second confirmation');
  assert.equal(capabilityBadge(featureCapability({enabled:true,configured:true,supported:true,ready:false})).tag,'UNAVAILABLE','configuration alone is not readiness');
});

test('skills: teaching builds a strict draft, review binds the displayed manifest digest, and nothing loads on render',async()=>{
  const input=teachInput({...emptyTeachForm,name:'Weekly Report!',description:'Make the weekly report',summary:'Draft a report',keywords:'Report, weekly',tools:'read_file, create_artifact',steps:'Read notes\nWrite report',verify:'Read back the file',checks:'artifact-readback'},'k1');
  assert.ok(uiActionSchemas['skills/draft'].safeParse(input).success);
  assert.equal(input.id,'user-weekly-report-k1');assert.deepEqual(input.recipe.keywords,['report','weekly']);assert.deepEqual(input.recipe.steps,['Read notes','Write report']);
  assert.ok(!('permissions' in input)&&!('review' in input),'authors cannot declare permissions or approval');
  const manifest={schemaVersion:1 as const,id:'weekly',version:'r1',name:'Weekly',description:'d',sourceSha256:A,entrypoint:'task-plan',permissions:['workspace-read' as const],requiredCapabilities:[],dependencies:['tool:read_file'],verification:[{kind:'source-sha256' as const,sha256:A}],localOnly:true};
  const catalog={skills:[{skillId:'weekly',version:'r1',name:'Weekly',manifestSha256:B,provenance:{kind:'user-authored' as const},private:false,state:'unreviewed' as const,localOnly:true,paidTools:[],missing:{capabilities:[],dependencies:[],checks:[]},manifest}]};
  const {calls,request}=fakeService((_m,_r,body)=>({ok:true,body:{id:'rc',requestId:body.requestId,feature:'skills',action:'review',observedAt:1,outcome:'completed',effect:'confirmed'}}));
  const html=renderToStaticMarkup(<SkillsPanel request={request} initialCatalog={ready(catalog)}/>);
  assert.equal(calls.length,0,'render loads nothing');assert.match(html,/NEEDS REVIEW/);assert.match(html,/Permissions: workspace-read/);
  assert.ok(disabledButton(html,'Approve review'),'review needs an explicit acknowledgement first');
  const runner=createActionRunner({request});const result=await runner.run('skills/review',{skillId:'weekly',manifestSha256:catalog.skills[0].manifestSha256})!;
  assert.equal(result.state,'completed');assert.deepEqual(calls[0].body.input,{skillId:'weekly',manifestSha256:B});
  const older=await readOverview(async()=>({ok:false,status:404,message:'Not Found'}),'skills');
  assert.equal(older.kind,'unsupported');
});

/** Manual timers: nothing fires until the test says so, and no real timer is left behind. */
function fakeTimers(){
  const pending=new Set<{fn:()=>void}>();
  const setTimer:SetTimer=fn=>{const t={fn};pending.add(t);return ()=>{pending.delete(t);};};
  return {setTimer,fire(){const all=[...pending];pending.clear();for(const t of all)t.fn();},size:()=>pending.size};
}
/** Desktop-bridge stand-in: ignores the abort signal and settles only when the test resolves it. */
function hungBridge(){
  const calls:{route:string;body:any;signal:AbortSignal;reply:ReturnType<typeof deferred<ExtensionReply>>}[]=[];
  const request:ExtensionRequest=(_m,route,body,signal)=>{const reply=deferred<ExtensionReply>();calls.push({route,body:structuredClone(body),signal,reply});return reply.promise;};
  return {calls,request};
}

test('a hung bridge times out to unconfirmed, frees UI capacity, never resends and ignores late success',async()=>{
  const timers=fakeTimers(),bridge=hungBridge();let n=0;
  const runner=createActionRunner({request:bridge.request,setTimer:timers.setTimer,newRequestId:()=>'req-'+(++n)});
  const started=[runner.run('agents/start',{provider:'codex',workspaceId:'ws-1',prompt:'Run checks'},{taskId:'task-1'})!,
    runner.run('updates/check',{})!,runner.run('security/quick-scan',{})!,runner.run('skills/revoke',{skillId:'weekly'})!];
  await tick();
  assert.equal(bridge.calls.length,4);assert.equal(runner.run('cursor/configure',{enabled:false}),undefined,'ordinary capacity is full');
  // Recovery has its own lane: it dispatches while four ordinary calls hang, and creates no authority.
  const restore=runner.run('cursor/restore',{})!;assert.ok(restore,'restore is not blocked by hung ordinary calls');
  await tick();assert.equal(bridge.calls.length,5);assert.deepEqual(bridge.calls[4].body,{requestId:'req-5',input:{}});
  timers.fire();
  const results=await Promise.all([...started,restore]);
  assert.deepEqual(results.map(r=>r.state),['unconfirmed','unconfirmed','unconfirmed','unconfirmed','unconfirmed']);
  assert.match(results[0].message,/No receipt within 30 s\. The outcome is unknown\. Do not repeat it/);
  assert.equal(results[0].requestId,'req-1','the exact uncertain action identity is kept');
  assert.ok(bridge.calls.every(c=>c.signal.aborted),'the transport is asked to abort');
  assert.equal(runner.pendingCount(),0);assert.equal(runner.abandonedCount(),5);
  // The same uncertain effect cannot be clicked again until its transport settles; other controls work again.
  assert.equal(runner.run('agents/start',{provider:'codex',workspaceId:'ws-1',prompt:'Run checks'},{taskId:'task-1'}),undefined,'no duplicate action');
  assert.equal(runner.busy('agents/start'),true);assert.equal(runner.busy('cursor/configure'),false);
  const restoreAgain=runner.run('cursor/restore',{})!;assert.ok(restoreAgain,'restore stays reachable after its own timeout');
  await tick();assert.equal(bridge.calls.length,6);
  // Late matching success for the current view is reconciled as still unconfirmed, never upgraded.
  bridge.calls[0].reply.resolve({ok:true,body:{id:'rc-1',requestId:'req-1',feature:'agents',action:'start',observedAt:5,outcome:'completed',effect:'confirmed'}});
  await tick();await tick();
  assert.equal(runner.outcome('agents/start')?.state,'unconfirmed');assert.match(runner.outcome('agents/start')!.message,/after the time limit and is not treated as confirmation/);
  assert.equal(runner.busy('agents/start'),false,'settling frees the slot');
  // A late reply for a slot that already shows a newer request leaves that newer view untouched.
  bridge.calls[4].reply.resolve({ok:true,body:{id:'rc-5',requestId:'req-5',feature:'cursor',action:'restore',observedAt:5,outcome:'completed',effect:'confirmed'}});
  await tick();await tick();
  assert.equal(runner.outcome('cursor/restore')?.requestId,'req-6');assert.equal(runner.outcome('cursor/restore')?.state,'pending');
  bridge.calls[5].reply.resolve({ok:true,body:{id:'rc-6',requestId:'req-6',feature:'cursor',action:'restore',observedAt:6,outcome:'completed',effect:'confirmed'}});
  assert.equal((await restoreAgain).state,'completed');
  assert.equal(bridge.calls.length,6,'nothing was resent automatically');
  assert.equal(timers.size(),0,'no deadline timer is left running');
  for(const c of bridge.calls.slice(1,4))c.reply.resolve({ok:false,message:'late'});
  await tick();await tick();assert.equal(runner.abandonedCount(),0);
});

test('abandoned ordinary calls are bounded, but restore keeps its own lane',async()=>{
  const timers=fakeTimers(),bridge=hungBridge();let n=0;
  const runner=createActionRunner({request:bridge.request,setTimer:timers.setTimer,newRequestId:()=>'req-'+(++n)});
  for(let i=0;i<8;i++){runner.run('security/inspect',{jobId:'job-'+i},{slot:'security/inspect:'+i});if(i%4===3)timers.fire();}
  await tick();assert.equal(runner.abandonedCount(),8);
  assert.equal(runner.run('updates/check',{}),undefined,'too many unsettled requests: new ordinary work waits');
  assert.ok(runner.run('cursor/restore',{}),'restore still dispatches');
  const view=await readExtensionStatus(bridge.request,()=>1,{setTimer:(fn,ms)=>{assert.equal(ms,30000);queueMicrotask(fn);return ()=>{};}});
  assert.equal(view.kind,'error');assert.match((view as any).message,/no reply in time\. Status is unknown/,'a hung read settles by its deadline');
  timers.fire();for(const c of bridge.calls)c.reply.resolve({ok:false,message:'late'});await tick();
});

const skill=(id:string,patch:Partial<SkillCatalog['skills'][number]>={}):SkillCatalog['skills'][number]=>({skillId:id,version:'r1',name:id,manifestSha256:A,provenance:{kind:'user-authored'},
  private:false,state:'unreviewed',localOnly:true,paidTools:[],missing:{capabilities:[],dependencies:[],checks:[]},...patch});
test('skills: a privacy boundary discards private form, catalog and acknowledgements and ignores late reads and actions',async()=>{
  const replies:ReturnType<typeof deferred<ExtensionReply>>[]=[];
  const {calls,request}=fakeService(()=>{const d=deferred<ExtensionReply>();replies.push(d);return d.promise;});
  const runner=createActionRunner({request});
  const initial=ready<SkillCatalog>({skills:[skill('public-saved'),skill('private-one',{private:true}),skill('draft-one',{draft:true})]});
  const session=createSkillsSession({request,runner,scope:{epoch:'e1',privateSession:true},initialCatalog:initial});
  session.setForm({...emptyTeachForm,name:'Private health routine'});session.acknowledge('public-saved',A);
  session.act('skills/draft',teachInput({...emptyTeachForm,name:'x',description:'d',summary:'s',keywords:'k',tools:'read_file',steps:'a',verify:'v',checks:'artifact-readback'},'1'),'skills/draft',true);
  const loading=session.load();await tick();
  assert.equal(calls.length,2);assert.equal(session.snapshot().runner.outcome('skills/draft')?.state,'pending');
  // Private on -> private on (a new session): the boolean is unchanged, the epoch is not.
  assert.equal(session.sync({epoch:'e2',privateSession:true}),true);
  const after=session.snapshot();
  assert.deepEqual(after.form,emptyTeachForm,'private form is discarded synchronously');
  assert.deepEqual(after.acknowledged,{},'acknowledgements never carry over');
  assert.deepEqual(after.catalog.kind==='ready'&&after.catalog.data.skills.map(s=>s.skillId),['public-saved'],'only explicitly saved public entries remain');
  assert.equal(after.runner.outcome('skills/draft'),undefined,'outcomes from the old epoch are not shown');
  replies[0].resolve({ok:true,body:{id:'rc',requestId:calls[0].body.requestId,feature:'skills',action:'draft',observedAt:1,outcome:'completed',effect:'confirmed'}});
  replies[1].resolve({ok:true,body:{skills:[skill('private-two',{private:true})]}});
  await loading;await tick();
  assert.equal(calls.length,2,'a completed old-epoch action does not reload into the new epoch');
  const late=session.snapshot();
  assert.deepEqual(late.catalog.kind==='ready'&&late.catalog.data.skills.map(s=>s.skillId),['public-saved'],'no phantom private catalog after a late promise');
  assert.equal(session.sync({epoch:'e2',privateSession:true}),false,'same scope is not a boundary');
});

test('skills: public drafts survive turning private on; private flows need the trusted epoch',async()=>{
  const {calls,request}=fakeService(()=>assert.fail('nothing is sent without a trusted epoch'));
  const session=createSkillsSession({request,runner:createActionRunner({request}),scope:{epoch:'p1',privateSession:false}});
  session.setForm({...emptyTeachForm,name:'Weekly report'});
  session.sync({epoch:'s1',privateSession:true});
  assert.equal(session.snapshot().form.name,'Weekly report','a public draft is kept when private mode starts');
  session.sync({epoch:undefined,privateSession:true});
  assert.equal(session.snapshot().form.name,'','leaving that private epoch discards what was there');
  assert.equal(session.snapshot().allowed,false);
  await session.load();session.act('skills/review',{skillId:'s',manifestSha256:A});
  assert.equal(calls.length,0);assert.match((session.snapshot().catalog as any).message,/without a trusted privacy epoch/);
  const html=renderToStaticMarkup(<SkillsPanel request={request} privateSession/>);
  assert.ok(disabledButton(html,'Create draft')&&disabledButton(html,'Load catalog'));assert.match(html,/without a trusted privacy epoch/);
  assert.ok(enabledButton(renderToStaticMarkup(<SkillsPanel request={request} privateSession privacyEpoch="s2"/>),'Load catalog'));
});

const hostEpoch='11111111-1111-4111-8111-111111111111';
const sessionReply=()=>({ok:true as const,body:{protocol:'capri-private-v1',privacyEpoch:hostEpoch,privateSession:false,revision:0}});
const review=(patch:Partial<ContactReview>={}):ContactReview=>({requestId:'send-1',reviewId:'review-1',expiresAt:Date.now()+120000,privacyEpoch:hostEpoch,reviewDigest:A,revision:3,binding,channel:'sms',destination:'+15550001111',sender:'+15550002222',routeLabel:'Alex',
  content:{kind:'message',body:'Running late, back at 6.'},contentClass:'personal',...patch});
test('contacts: approval needs current exact details bound to the same request, binding and privacy epoch',async()=>{
  const outbox=delivery({requestId:'send-1',state:'pending'});
  const answer=(body:unknown):ExtensionRequest=>async(method)=>method==='GET'?sessionReply():{ok:true,body};
  const seen:any[]=[];
  const ok=await readContactReview(async(method,route,body)=>{seen.push({method,route,body});return method==='GET'?sessionReply():{ok:true,body:review()};},outbox,7,{newRequestId:()=>'ui-r1'});
  assert.equal(ok.kind,'ready');assert.deepEqual(seen,[{method:'GET',route:'/v1/extensions/session',body:undefined},{method:'POST',route:'/v1/extensions/contacts/review-details',body:{requestId:'ui-r1',input:{outboxRequestId:'send-1',privacyEpoch:hostEpoch}}}]);
  for(const [why,body] of[['another epoch',review({privacyEpoch:'8'})],['another request',review({requestId:'send-2'})],['another revision',review({binding:{...binding,routeRevision:2}})],
    ['another body',review({binding:{...binding,bodySha256:A}})],['malformed',{...review(),approved:true}]] as const)
    assert.equal((await readContactReview(answer(body),outbox,7)).kind,'error',why);
  const older=await readContactReview(async method=>method==='GET'?sessionReply():{ok:false,status:404,message:'Not Found'},outbox,7);
  assert.equal(older.kind,'unsupported');assert.match((older as any).message,/approval is unavailable/);
  const echoed=await readContactReview(async()=>({ok:false,status:500,message:'Running late, back at 6. +15550001111'}),outbox,7);
  assert.ok(!JSON.stringify(echoed).includes('+15550001111')&&!JSON.stringify(echoed).includes('Running late'),'errors never echo the message');
  const shown={...review(),localEpoch:7};
  assert.equal(reviewCurrent(shown,outbox,7),true);
  assert.equal(reviewCurrent(shown,outbox,8),false,'a new privacy epoch invalidates the preview');
  assert.equal(reviewCurrent(shown,outbox,undefined),false);
  assert.equal(reviewCurrent(shown,{...outbox,binding:{...binding,routeRevision:2}},7),false,'a route edit invalidates it');
  assert.equal(reviewCurrent(shown,{...outbox,state:'unconfirmed'},7),false,'only pending requests can be approved');
  const input=approvalInput(shown);
  assert.deepEqual(input,{requestId:'send-1',reviewId:'review-1',reviewDigest:A,revision:3,routeId:'route-1',routeRevision:1,bodySha256:B,privacyEpoch:hostEpoch});
  assert.ok(uiActionSchemas['contacts/approve'].safeParse(input).success);
  assert.equal(uiActionSchemas['contacts/approve'].safeParse({requestId:'send-1'}).success,false,'a bare request ID cannot approve');
  const {calls,request}=fakeService((_m,_r,body)=>({ok:true,body:{id:'rc',requestId:body.requestId,feature:'contacts',action:'approve',observedAt:1,outcome:'completed',effect:'confirmed'}}));
  const runner=createActionRunner({request});const result=await runner.run('contacts/approve',input)!;
  assert.equal(result.state,'completed');assert.match(result.message,/not a delivery receipt/);
  assert.deepEqual(calls[0].body.input,input);
  assert.ok(!JSON.stringify(runner.log()).includes('Running late')&&!JSON.stringify(runner.log()).includes('+1555'),'the preview is never logged');
  const details=renderToStaticMarkup(<ContactReviewDetails review={review({content:{kind:'message',subject:'Tonight',body:'Running late, back at 6.'}})}/>);
  assert.match(details,/\+15550001111/);assert.match(details,/Subject.*Tonight/);assert.match(details,/Running late, back at 6\./);
  assert.match(renderToStaticMarkup(<ContactReviewDetails review={review({channel:'voice',content:{kind:'call',script:'Hi, this is Capri.',maxVoiceSeconds:30}})}/>),/Call script.*Hi, this is Capri\./);
});

test('contacts: with the review action available, exact details load on click and approval stays off until then',()=>{
  const status=defaultExtensionStatus(1);status.features.contacts=readyCapability(['approve','review-details','reconcile']);
  const contacts={providers:[],routes:[],rules:[],outbox:[{receipt:delivery({requestId:'send-1',state:'pending'}),channel:'sms' as const,routeLabel:'Alex',draftKept:true,approvalRequired:true}]};
  const {calls,request}=fakeService(()=>assert.fail('render must not read the exact message'));
  const html=render({request,privateSession:true,privacyEpoch:7,initial:{status:ready(status),overviews:{contacts:ready(contacts)}}});
  assert.deepEqual(calls,[]);
  assert.ok(enabledButton(html,'Show exact message'));assert.ok(disabledButton(html,'Approve this exact message'),'no approval before current details are loaded');
  assert.doesNotMatch(html,/Exact message to approve/);
});

const settingsControls=['ext-security-enabled','ext-contacts-enabled','ext-agents-codex','ext-agents-claude','ext-updates-auto'];
const inputDisabled=(html:string,id:string)=>new RegExp('id="'+id+'"[^>]*disabled=""').test(html);
test('settings writes need confirmed saved settings: cold, failed and unsettled states never write defaults over saved values',async()=>{
  const status=defaultExtensionStatus(1);
  for(const settings of[undefined,{kind:'loading'},{kind:'error',message:'Extension settings could not be read.'},{kind:'unchecked'}] as (ReadView<any>|undefined)[]){
    const {calls,request}=fakeService(()=>assert.fail('render must not call the service'));
    const html=render({request,initial:{status:ready(status),...(settings?{settings}:{})}});
    const why=settings?.kind??'cold';
    for(const id of settingsControls)assert.ok(inputDisabled(html,id),id+' stays off while settings are '+why);
    assert.match(html,/<select aria-label="Update channel"[^>]*disabled=""/,why);assert.match(html,/<option value="" selected="">Not loaded<\/option>/,'no default channel is shown as saved');
    assert.ok(disabledButton(html,'Enable animated cursor')&&disabledButton(html,'Disable'),why);
    assert.ok(enabledButton(html,'Restore normal cursor'),'functional safe Restore stays available while settings are '+why);
    assert.match(html,/Saved settings are not confirmed/);assert.doesNotMatch(html,/id="ext-updates-auto"[^>]*checked/,'the default automatic=true is not displayed as saved');
    assert.deepEqual(calls,[]);
  }
  // Confirmed settings where the owner already disabled automatic updates and chose preview: shown as saved and preserved.
  const saved=defaultExtensionSettings();saved.updates={automatic:false,channel:'preview'};saved.security={...saved.security,dailyQuickScan:false};
  const html=render({initial:{status:ready(status),settings:ready(saved),codexConnection:ready({state:'authenticated',authenticated:true,inferenceVerified:false,model:'catalog-model',models:['catalog-model']})}});
  for(const id of settingsControls)assert.ok(!inputDisabled(html,id),id+' is writable once settings are confirmed');
  assert.doesNotMatch(html,/id="ext-updates-auto"[^>]*checked/);assert.match(html,/<option value="preview" selected="">/);
  assert.doesNotMatch(html,/Saved settings are not confirmed/);
  // The handlers build their input only through confirmedWrite: sibling values come from the confirmed saved record.
  assert.equal(confirmedWrite(undefined as typeof saved.updates|undefined,true,['automatic','channel'],{channel:'stable'}),undefined,'nothing to write without saved settings');
  assert.equal(confirmedWrite(saved.updates,false,['automatic','channel'],{channel:'stable'}),undefined,'nothing to write while unconfirmed');
  const channel=confirmedWrite(saved.updates,true,['automatic','channel'],{channel:'stable'});
  assert.deepEqual(channel,{automatic:false,channel:'stable'},'changing the channel keeps automatic updates disabled');
  assert.ok(uiActionSchemas['updates/configure'].safeParse(channel).success);
  const security=confirmedWrite(saved.security,true,['enabled','dailyQuickScan'],{enabled:true});
  assert.deepEqual(security,{enabled:true,dailyQuickScan:false},'turning tools on keeps the daily scan disabled');
  assert.ok(uiActionSchemas['security/configure'].safeParse(security).success,'only the strict configurable fields are sent');
  // A settings write that has not settled makes even a ready view unconfirmed, including after its UI deadline.
  const timers=fakeTimers(),bridge=hungBridge();const runner=createActionRunner({request:bridge.request,setTimer:timers.setTimer});
  runner.run('updates/configure',{automatic:false,channel:'preview'});await tick();
  assert.equal(runner.writeCount(),1);assert.equal(runner.unsettled('settings'),1);
  timers.fire();await tick();assert.equal(runner.unsettled('settings'),1,'a timed-out write is still unsettled');
  const stale=render({runner,request:bridge.request,initial:{status:ready(status),settings:ready(saved)}});
  for(const id of settingsControls)assert.ok(inputDisabled(stale,id),id+' waits for the unsettled write');
  assert.match(stale,/while a settings change is unsettled/);assert.ok(enabledButton(stale,'Restore normal cursor'));
  bridge.calls[0].reply.resolve({ok:false,message:'late'});await tick();await tick();
  assert.equal(runner.unsettled('settings'),0);
  const after=render({runner,request:bridge.request,initial:{status:ready(status),settings:ready(saved)}});
  assert.ok(!inputDisabled(after,'ext-updates-auto'),'a settings view read after the write settles is confirmed');
});

test('reads are bounded at the transport: one call per key until it settles, despite deadlines, ignored abort and remounts',async()=>{
  const timers=fakeTimers(),bridge=hungBridge();
  const runner=createActionRunner({request:bridge.request,setTimer:timers.setTimer});
  const opts={gate:runner.reads,setTimer:timers.setTimer},statusKey=readKey(extensionRoutes.status);
  const first=readExtensionStatus(bridge.request,()=>1,opts);
  const duplicate=await readExtensionStatus(bridge.request,()=>1,opts);
  assert.equal(duplicate.kind,'error');assert.match((duplicate as any).message,/earlier read has not settled yet, so nothing was sent/);
  await tick();assert.equal(bridge.calls.length,1,'a repeated reload does not dispatch');
  timers.fire();const timedOut=await first;
  assert.equal(timedOut.kind,'error');assert.ok(bridge.calls[0].signal.aborted,'the transport was asked to abort');
  // The bridge ignored abort: the UI deadline settled the view, but the gate still holds the transport slot.
  assert.equal(runner.reads.busy(statusKey),true);await readExtensionStatus(bridge.request,()=>1,opts);await tick();
  assert.equal(bridge.calls.length,1,'no unlimited redispatch after a deadline');
  // A remounted panel sees the shared gate: Check status stays off until the transport settles.
  const remounted=render({runner,request:bridge.request,initial:{status:ready(defaultExtensionStatus(1))}});
  assert.ok(disabledButton(remounted,'Check status'));
  assert.ok(disabledButton(renderToStaticMarkup(<SkillsPanel runner={runner} request={bridge.request}/>),'Load catalog')===false,'other keys are unaffected');
  // Exact-message detail reads share the gate and keep their exact request identity.
  const outbox=delivery({requestId:'send-1',state:'pending'});
  const detail=readContactReview(bridge.request,outbox,7,{...opts,newRequestId:()=>'ui-r1'});
  assert.equal((await readContactReview(bridge.request,outbox,7,{...opts,newRequestId:()=>'ui-r2'})).kind,'error','one detail read at a time');
  await tick();assert.equal(bridge.calls.length,2);assert.equal(bridge.calls[1].route,'/v1/extensions/session');
  assert.equal(runner.reads.open(contactReviewKey),true);
  // The total is bounded too.
  const more=[readExtensionSettings(bridge.request,()=>1,opts),readOverview(bridge.request,'security',()=>1,opts),readOverview(bridge.request,'contacts',()=>1,opts),readOverview(bridge.request,'agents',()=>1,opts)];
  await tick();assert.equal(runner.reads.unsettled(),6);
  const refused=await readOverview(bridge.request,'skills',()=>1,opts);await tick();
  assert.equal(refused.kind,'error');assert.equal(bridge.calls.length,6,'the seventh outstanding read is refused without dispatch');
  assert.ok(disabledButton(renderToStaticMarkup(<SkillsPanel runner={runner} request={bridge.request}/>),'Load catalog'),'a full gate keeps Load off');
  // A late status reply is not published anywhere, and capacity returns once transports settle.
  bridge.calls[0].reply.resolve({ok:true,body:defaultExtensionStatus(2)});await tick();await tick();
  assert.equal(runner.reads.busy(statusKey),false);assert.deepEqual(timedOut,await first,'the settled view does not change after the late reply');
  bridge.calls[1].reply.resolve({ok:false,message:'Session unavailable'});
  timers.fire();assert.equal((await detail).kind,'error','a detail reply after the deadline is dropped, never shown');
  const again=readExtensionStatus(bridge.request,()=>1,opts);await tick();assert.equal(bridge.calls.length,7,'capacity recovered');
  for(const c of bridge.calls.slice(2))c.reply.resolve({ok:false,message:'late'});timers.fire();await Promise.all([again,...more]);await tick();
  assert.equal(runner.reads.unsettled(),0);assert.equal(runner.reads.busy(skillsCatalogKey),false);
});

test('returned and stored outcomes keep only validated identities and fixed codes; retired private namespaces are deleted and fenced',async()=>{
  const marker='neutral-echo-marker-7f3a';
  const held:ReturnType<typeof deferred<ExtensionReply>>[]=[];
  const {request}=fakeService((_m,route,body)=>{
    const rejected={id:'rc-'+body.requestId,requestId:body.requestId,feature:route.split('/')[3],action:route.split('/')[4],observedAt:1,outcome:'rejected',effect:'none',error:{code:'forbidden',message:marker,retry:'never'}};
    if(route.endsWith('/security/inspect')){const d=deferred<ExtensionReply>();held.push(d);return d.promise;}
    if(route.endsWith('/agents/start'))return {ok:true,body:{...rejected,outcome:'unconfirmed',effect:'unknown',error:{code:'unconfirmed',message:marker,retry:'read-only-reconcile'}}};
    return {ok:false,status:403,message:marker,body:rejected};
  });
  let n=0;const runner=createActionRunner({request,newRequestId:()=>'req-'+(++n)});
  const results=[await runner.run('agents/cancel',{jobId:'job-1'},{taskId:'task-1'})!,await runner.run('agents/start',{provider:'codex',workspaceId:'ws-1',prompt:'x'},{taskId:'task-1'})!];
  assert.deepEqual(results[0].receipt,{id:'rc-req-1',outcome:'rejected',effect:'none',errorCode:'forbidden',retry:'never'});
  assert.deepEqual(results[1].receipt,{id:'rc-req-2',outcome:'unconfirmed',effect:'unknown',errorCode:'unconfirmed',retry:'read-only-reconcile'});
  for(const text of[JSON.stringify(results),JSON.stringify(runner.outcome('agents/cancel')),JSON.stringify(runner.outcome('agents/start')),JSON.stringify(runner.log())])
    assert.ok(!text.includes(marker),'service text is not retained: '+text);
  const queued=interpretReply('security/quick-scan','r-1',{ok:true,body:{id:'rc',requestId:'r-1',feature:'security',action:'quick-scan',observedAt:1,outcome:'pending',effect:'queued',jobId:'scan-1'}});
  assert.deepEqual(queued.receipt,{id:'rc',outcome:'pending',effect:'queued',jobId:'scan-1'},'only validated identities and status are kept');
  // Private e1 -> public e2 on one shared runner.
  const p1=runner.namespace('ext','private@e1'),s1=scopedRunner(runner,p1);
  assert.equal(runner.namespace('ext','private@e1'),p1,'stable while the fence is unchanged');
  const verified=await s1.run('skills/revoke',{skillId:'route-1'},{slot:'skills/revoke:route-1'})!;
  assert.equal(verified.state,'rejected');
  const late=s1.run('security/inspect',{jobId:'send-1'},{slot:'security/inspect:send-1'})!;await tick();
  assert.equal(s1.outcome('security/inspect:send-1')?.state,'pending');
  const p2=runner.namespace('ext','public@e2'),s2=scopedRunner(runner,p2);
  assert.notEqual(p2,p1);
  assert.equal(s1.outcome('skills/revoke:route-1'),undefined,'retired outcomes are deleted, not hidden');
  assert.equal(s1.outcome('security/inspect:send-1'),undefined);
  assert.equal(s1.run('skills/revoke',{skillId:'route-1'},{slot:'skills/revoke:route-1'}),undefined,'a retired namespace accepts no new work');
  assert.equal(s2.busy('security/inspect:send-1'),true,'the unsettled effect still blocks the same control in the new namespace');
  held[0].resolve({ok:false,status:403,message:marker,body:{id:'rc-late',requestId:'req-4',feature:'security',action:'inspect',observedAt:2,outcome:'rejected',effect:'none',error:{code:'forbidden',message:marker,retry:'never'}}});
  const settled=await late;await tick();
  assert.ok(!JSON.stringify(settled).includes(marker));
  assert.equal(s1.outcome('security/inspect:send-1'),undefined,'a late receipt cannot reinsert a retired view');
  assert.equal(s2.outcome('security/inspect:send-1'),undefined);assert.equal(s2.busy('security/inspect:send-1'),false,'settling frees the control');
  assert.notEqual(runner.namespace('ext','private@e1'),p1,'a namespace is never reused');
});

test('skills: a shared runner gives each session its own namespace; closing a private panel deletes outcomes and fences late receipts',async()=>{
  const marker='neutral-echo-marker-skills',bridge=hungBridge();
  const runner=createActionRunner({request:bridge.request});
  const privateSession=createSkillsSession({request:bridge.request,runner,scope:{epoch:'e1',privateSession:true}});
  const oldRunner=privateSession.snapshot().runner;
  privateSession.act('skills/review',{skillId:'weekly',manifestSha256:A},'skills/review:weekly');
  privateSession.act('skills/discard-draft',{skillId:'weekly'},'skills/discard-draft:weekly');await tick();
  assert.equal(bridge.calls.length,2);
  bridge.calls[1].reply.resolve({ok:false,status:400,message:marker,body:{id:'rc-2',requestId:bridge.calls[1].body.requestId,feature:'skills',action:'discard-draft',observedAt:1,outcome:'rejected',effect:'none',error:{code:'invalid-request',message:marker,retry:'never'}}});
  await tick();await tick();assert.equal(oldRunner.outcome('skills/discard-draft:weekly')?.state,'rejected');
  privateSession.close();
  assert.equal(oldRunner.outcome('skills/discard-draft:weekly'),undefined,'completed private outcomes are deleted on close');
  assert.equal(oldRunner.outcome('skills/review:weekly'),undefined);
  const publicSession=createSkillsSession({request:bridge.request,runner,scope:{epoch:'e2',privateSession:false}});
  const current=publicSession.snapshot().runner;
  assert.equal(current.outcome('skills/discard-draft:weekly'),undefined,'a remounted public panel sees nothing from the private one');
  assert.equal(current.busy('skills/review:weekly'),true,'the unsettled private review still blocks a duplicate');
  publicSession.act('skills/review',{skillId:'weekly',manifestSha256:A},'skills/review:weekly');await tick();
  assert.equal(bridge.calls.length,2,'no replay of the uncertain review');
  bridge.calls[0].reply.resolve({ok:true,body:{id:'rc-1',requestId:bridge.calls[0].body.requestId,feature:'skills',action:'review',observedAt:1,outcome:'rejected',effect:'none',error:{code:'forbidden',message:marker,retry:'never'}}});
  await tick();await tick();
  for(const r of[oldRunner,current])assert.equal(r.outcome('skills/review:weekly'),undefined,'the late receipt is not stored in either namespace');
  assert.ok(!JSON.stringify(runner.log()).includes(marker));
  assert.equal(current.busy('skills/review:weekly'),false);
  assert.equal(bridge.calls.length,2,'the late private completion did not trigger a reload in the public session');
});

const rejectedReceipt=(call:{route:string;body:any})=>({ok:true,body:{id:'rc-'+call.body.requestId,requestId:call.body.requestId,feature:call.route.split('/')[3],action:call.route.split('/')[4],
  observedAt:1,outcome:'rejected',effect:'none',error:{code:'forbidden',message:'neutral-echo-marker-retire',retry:'never'}}} as ExtensionReply);

test('retirement is irreversible per issued handle: quiescent, after settlement and after a late receipt',async()=>{
  const bridge=hungBridge(),runner=createActionRunner({request:bridge.request});
  // Quiescent retire: nothing under the namespace is unsettled, so the runner's fence is pruned at once.
  const q=scopedRunner(runner,runner.namespace('ext','private@q1'));
  runner.namespace('ext','public@q2');
  assert.equal(q.run('skills/revoke',{skillId:'route-1'}),undefined,'a quiescent retired handle starts nothing');
  assert.equal(q.busy('skills/revoke'),true);assert.equal(bridge.calls.length,0);
  // Retire after settlement: the handle's own request settles first, then the namespace is retired.
  const s=scopedRunner(runner,runner.namespace('ext','private@s1'));
  const first=s.run('skills/revoke',{skillId:'route-1'})!;await tick();
  bridge.calls[0].reply.resolve(rejectedReceipt(bridge.calls[0]));assert.equal((await first).state,'rejected');
  runner.namespace('ext','public@s2');
  assert.equal(s.run('skills/revoke',{skillId:'route-1'}),undefined,'a handle retired after settlement starts nothing');
  assert.equal(s.outcome('skills/revoke'),undefined);
  // Stale handle after a late receipt: its pending request settles after retirement and frees capacity, nothing more.
  const l=scopedRunner(runner,runner.namespace('ext','private@l1'));
  const pending=l.run('security/inspect',{jobId:'send-1'})!;await tick();
  const next=scopedRunner(runner,runner.namespace('ext','public@l2'));
  assert.equal(runner.pendingCount(),1);
  bridge.calls[1].reply.resolve(rejectedReceipt(bridge.calls[1]));const late=await pending;await tick();
  assert.equal(late.state,'rejected');assert.ok(!JSON.stringify(late).includes('neutral-echo-marker-retire'));
  assert.equal(runner.pendingCount(),0,'the settled request released its capacity');assert.equal(runner.abandonedCount(),0);
  assert.equal(l.outcome('security/inspect'),undefined,'the late receipt is not stored under the retired namespace');
  for(const handle of[q,s,l])assert.equal(handle.run('security/inspect',{jobId:'send-1'}),undefined,'stale handles stay retired after the fence is pruned');
  assert.equal(bridge.calls.length,2,'no stale handle dispatched');
  assert.ok(!JSON.stringify(runner.log()).includes('neutral-echo-marker-retire'));
  // The current handle still works on the same shared runner.
  const fresh=next.run('security/inspect',{jobId:'send-1'})!;await tick();assert.equal(bridge.calls.length,3);
  bridge.calls[2].reply.resolve(rejectedReceipt(bridge.calls[2]));assert.equal((await fresh).state,'rejected');
});

test('skills: a closed session never loads or acts again; its pending work still settles; only a new session works',async()=>{
  const bridge=hungBridge(),runner=createActionRunner({request:bridge.request});
  const closed=createSkillsSession({request:bridge.request,runner,scope:{epoch:'e1',privateSession:true}});
  const oldRunner=closed.snapshot().runner;
  closed.act('skills/review',{skillId:'weekly',manifestSha256:A},'skills/review:weekly');await tick();
  assert.equal(bridge.calls.length,1);
  closed.close();assert.equal(closed.closed(),true);
  await closed.load();
  closed.act('skills/revoke',{skillId:'weekly'},'skills/revoke:weekly');
  assert.equal(oldRunner.run('skills/revoke',{skillId:'weekly'},{slot:'skills/revoke:weekly'}),undefined,'the stale session runner starts nothing');
  assert.equal(closed.sync({epoch:'e2',privateSession:false}),false,'a boundary cannot reactivate a closed session');
  closed.act('skills/revoke',{skillId:'weekly'},'skills/revoke:weekly');await closed.load();await tick();
  assert.equal(bridge.calls.length,1,'zero dispatch after close');
  // The owned pending review settles, frees capacity and triggers no reload or storage.
  bridge.calls[0].reply.resolve({ok:true,body:{id:'rc-1',requestId:bridge.calls[0].body.requestId,feature:'skills',action:'review',observedAt:1,outcome:'completed',effect:'confirmed'}});
  await tick();await tick();
  assert.equal(runner.pendingCount(),0);assert.equal(bridge.calls.length,1,'a late completion does not reload a closed session');
  assert.equal(oldRunner.outcome('skills/review:weekly'),undefined);
  assert.equal(closed.snapshot().form,emptyTeachForm);
  // Only a fresh, explicitly created session works on the same runner.
  const fresh=createSkillsSession({request:bridge.request,runner,scope:{epoch:'e2',privateSession:false}});
  fresh.act('skills/review',{skillId:'weekly',manifestSha256:A},'skills/review:weekly');await tick();
  assert.equal(bridge.calls.length,2);bridge.calls[1].reply.resolve(rejectedReceipt(bridge.calls[1]));await tick();await tick();
  assert.equal(fresh.snapshot().runner.outcome('skills/review:weekly')?.state,'rejected');
});

test('skills: a draft receipt clears only the submitted form revision; newer edits are kept',async()=>{
  const replies:ReturnType<typeof deferred<ExtensionReply>>[]=[];
  const {calls,request}=fakeService(()=>{const d=deferred<ExtensionReply>();replies.push(d);return d.promise;});
  const session=createSkillsSession({request,runner:createActionRunner({request}),scope:{epoch:'p1',privateSession:false}});
  const form={...emptyTeachForm,name:'Weekly',description:'d',summary:'s',keywords:'k',tools:'read_file',steps:'a',verify:'v',checks:'artifact-readback'};
  const ok=(i:number)=>({ok:true,body:{id:'rc-'+i,requestId:calls[i].body.requestId,feature:'skills',action:'draft',observedAt:1,outcome:'completed',effect:'confirmed'}} as ExtensionReply);
  session.setForm(form);session.act('skills/draft',teachInput(form,'1'),'skills/draft',true);await tick();
  session.setForm({...form,name:'Weekly report, edited while pending'});
  replies[0].resolve(ok(0));await tick();await tick();
  assert.equal(session.snapshot().form.name,'Weekly report, edited while pending','newer text survives the earlier receipt');
  replies[1].resolve({ok:true,body:{skills:[]}});await tick();
  session.act('skills/draft',teachInput(session.snapshot().form,'2'),'skills/draft',true);await tick();
  replies[2].resolve(ok(2));await tick();await tick();
  assert.deepEqual(session.snapshot().form,emptyTeachForm,'an unedited submitted form is cleared by its receipt');
  replies[3]?.resolve({ok:true,body:{skills:[]}});await tick();
});

/** Scripted contact-review transport: every detail read waits for an explicit reply; nothing reaches a provider. */
function reviewHarness(scope:{epoch?:string|number;reviewAllowed:boolean;approveAllowed:boolean}={epoch:7,reviewAllowed:true,approveAllowed:true}){
  const replies:ReturnType<typeof deferred<ExtensionReply>>[]=[];
  const {calls,request}=fakeService(method=>{if(method==='GET')return sessionReply();const d=deferred<ExtensionReply>();replies.push(d);return d.promise;});
  const runner=createActionRunner({request});
  const controller=createContactReviewController({request,gate:runner.reads,scope});
  const dispatched:unknown[]=[];
  // The component's click handler: approval input comes only from the controller at click time.
  const click=(outbox:DeliveryReceipt)=>{const input=controller.approve(outbox);if(input)dispatched.push(input);};
  const off=(outbox:DeliveryReceipt)=>!controller.canApprove(outbox)&&controller.current(outbox)===undefined&&controller.approve(outbox)===undefined;
  return {calls,replies,runner,controller,dispatched,click,off};
}
const validPreview=async(h:ReturnType<typeof reviewHarness>,outbox:DeliveryReceipt,body:unknown=review())=>{
  const done=h.controller.load(outbox);await tick();h.replies.at(-1)!.resolve({ok:true,body});await done;
};

test('contacts: preview expiry clears content and disables approval without another read or dispatch',async()=>{
  const timers=fakeTimers(),outbox=delivery({requestId:'send-1',state:'pending'});
  const {calls,request}=fakeService(method=>method==='GET'?sessionReply():{ok:true,body:review()});
  const runner=createActionRunner({request}),controller=createContactReviewController({request,gate:runner.reads,setTimer:timers.setTimer,
    scope:{epoch:7,reviewAllowed:true,approveAllowed:true}});
  await controller.load(outbox);assert.equal(controller.canApprove(outbox),true);assert.equal(timers.size(),1,'only the preview expiry remains');
  timers.fire();assert.equal(controller.canApprove(outbox),false);assert.equal(controller.current(outbox),undefined);assert.equal(controller.snapshot().review,undefined);
  assert.equal(controller.approve(outbox),undefined);assert.match(controller.snapshot().notes[outbox.requestId],/expired/);
  assert.equal(calls.length,2,'expiry never resends or reloads');assert.deepEqual(runner.log(),[]);controller.close();
});

test('contacts: refreshing an exact preview withdraws approval at once and only a new matching read restores it',async()=>{
  const outbox=delivery({requestId:'send-1',state:'pending'}),h=reviewHarness();
  await validPreview(h,outbox);
  assert.equal(h.controller.canApprove(outbox),true);assert.equal(h.controller.current(outbox)?.reviewDigest,A);
  for(const [why,reply] of[['404',{ok:false,status:404,message:'Not Found'}],['error',{ok:false,status:500,message:'boom'}],
    ['binding mismatch',{ok:true,body:review({binding:{...binding,bodySha256:A}})}],['epoch mismatch',{ok:true,body:review({privacyEpoch:'8'})}],
    ['malformed',{ok:true,body:{...review(),approved:true}}]] as const){
    await validPreview(h,outbox);assert.equal(h.controller.canApprove(outbox),true,why+': starts from a valid preview');
    const pending=h.controller.load(outbox);
    // Synchronously at refresh start, before the transport answers.
    assert.ok(h.off(outbox),why+': the old preview is gone while the refresh is pending');
    assert.equal(h.controller.snapshot().review,undefined);assert.equal(h.controller.snapshot().reviewing,'send-1');
    h.click(outbox);assert.equal(h.dispatched.length,0,why+': a click during the refresh dispatches nothing');
    await tick();h.replies.at(-1)!.resolve(reply as ExtensionReply);await pending;
    assert.ok(h.off(outbox),why+': approval stays off after the failed refresh');
    assert.match(h.controller.snapshot().notes['send-1']??'',/Approval stays off|approval is unavailable/,why);
    h.click(outbox);assert.equal(h.dispatched.length,0,why);
  }
  await validPreview(h,outbox);
  assert.equal(h.controller.canApprove(outbox),true,'a later valid read enables approval again');
  assert.deepEqual(h.controller.snapshot().notes,{});
  h.click(outbox);h.click(outbox);
  assert.deepEqual(h.dispatched,[approvalInput(review())],'one dispatch; approving consumes the preview');
  assert.ok(h.off(outbox));
  assert.ok(!JSON.stringify(h.runner.log()).includes('Running late'),'previews never reach the runner log');
});

test('contacts: withdrawing either capability discards the preview; re-enabling needs a fresh read; stale handlers cannot approve',async()=>{
  const outbox=delivery({requestId:'send-1',state:'pending'}),h=reviewHarness();
  await validPreview(h,outbox);
  const staleClick=()=>h.click(outbox); // captured while both capabilities were live
  assert.equal(h.controller.sync({epoch:7,reviewAllowed:false,approveAllowed:true}),true,'review-details withdrawn while approve remains');
  assert.ok(h.off(outbox));staleClick();assert.equal(h.dispatched.length,0);
  assert.equal(h.controller.sync({epoch:7,reviewAllowed:true,approveAllowed:true}),false);
  assert.ok(h.off(outbox),'re-enabled capabilities do not revive the old preview');
  staleClick();assert.equal(h.dispatched.length,0);
  await validPreview(h,outbox);assert.equal(h.controller.canApprove(outbox),true,'a fresh read after re-enabling works');
  h.controller.sync({epoch:7,reviewAllowed:true,approveAllowed:false});
  assert.ok(h.off(outbox),'approve withdrawn while review remains');
  h.controller.sync({epoch:7,reviewAllowed:true,approveAllowed:true});
  assert.ok(h.off(outbox),'still needs a fresh read');staleClick();assert.equal(h.dispatched.length,0);
  // Without review-details nothing is read at all.
  h.controller.sync({epoch:7,reviewAllowed:false,approveAllowed:true});
  const before=h.calls.length;await h.controller.load(outbox);assert.equal(h.calls.length,before,'no detail read without the capability');
});

test('contacts: epoch and row-binding changes and late older reads never leave an approvable preview',async()=>{
  const outbox=delivery({requestId:'send-1',state:'pending'}),h=reviewHarness();
  await validPreview(h,outbox);
  assert.equal(h.controller.sync({epoch:8,reviewAllowed:true,approveAllowed:true}),true,'a new privacy epoch drops the preview');
  assert.ok(h.off(outbox));assert.ok(h.off(outbox));
  await validPreview(h,outbox);assert.equal(h.controller.canApprove(outbox),true);
  const edited={...outbox,binding:{...binding,routeRevision:2}};
  assert.ok(h.off(edited),'a row whose route revision changed cannot use the preview');
  assert.ok(!h.controller.canApprove({...outbox,state:'unconfirmed'}));
  assert.ok(!h.controller.canApprove(delivery({requestId:'send-2',state:'pending'})),'another row cannot use it');
  // A late read from before an epoch change is ignored, even when it is valid for the old epoch.
  const late=h.controller.load(outbox);await tick();
  h.controller.sync({epoch:9,reviewAllowed:true,approveAllowed:true});
  h.replies.at(-1)!.resolve({ok:true,body:review({privacyEpoch:'8'})});await late;
  assert.ok(h.off(outbox));assert.equal(h.controller.snapshot().reviewing,null);
  // A late read after review-details is withdrawn mid-flight, then re-enabled, is ignored too.
  const late2=h.controller.load(outbox);await tick();
  h.controller.sync({epoch:9,reviewAllowed:false,approveAllowed:true});h.controller.sync({epoch:9,reviewAllowed:true,approveAllowed:true});
  h.replies.at(-1)!.resolve({ok:true,body:review({privacyEpoch:'9'})});await late2;
  assert.ok(h.off(outbox),'the read started before withdrawal does not install a preview');
  // An edit or refresh elsewhere in the panel invalidates; a closed controller never loads or approves again.
  await validPreview(h,outbox);h.controller.invalidate();assert.ok(h.off(outbox));
  await validPreview(h,outbox);h.controller.close();assert.ok(h.off(outbox));
  const before=h.calls.length;await h.controller.load(outbox);assert.equal(h.calls.length,before);
  assert.equal(h.dispatched.length,0);
});
