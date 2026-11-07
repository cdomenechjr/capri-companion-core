import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {
  ActionReceiptSchema,CodexConnectionSchema,ContactIntentSchema,CursorSettingsSchema,CursorStatusSchema,ExtensionActionSchema,ExtensionSettingsSchema,
  ExtensionStatusSchema,ListeningSettingsSchema,ReleaseVersionSchema,SecurityEvidenceSchema,SecurityJobSchema,SkillManifestSchema,defaultExtensionSettings,
  type ContactApproval,type ContactBinding,type ContactIntent,type ContactRoute,type ContactRule,
  type ContactTemplate,type ContactWorkflow,type DeliveryReceipt,type ReleaseManifest,type SkillManifest,type TaskGrant,
} from '../src/extensions/contracts';
import {
  agentPolicy,automaticUpdatePolicy,bindingMatches,canonicalJson,contactPolicy,cursorLeasePolicy,decorativeMotionAllowed,defaultExtensionStatus,
  deliveryOutcome,featureCapability,releasePolicy,releaseSigningPayload,securitySchedulePolicy,sha256,skillPolicy,
  type AgentPolicyContext,type ContactPolicyContext,type ReleasePolicyContext,
} from '../src/extensions/policy';
import {defaults} from '../src/shared';

const now=10000;
test('Codex connection contract exposes only bounded configuration evidence and never inference proof or credentials',()=>{
  const connection={state:'authenticated',authenticated:true,inferenceVerified:false,model:'chosen-model',models:['chosen-model']};
  assert.deepEqual(CodexConnectionSchema.parse(connection),connection);
  for(const extra of [{authUrl:'https://auth.openai.com/'},{accessToken:['synthetic','value'].join('-')},{email:'private@example.invalid'},{inferenceVerified:true}])assert.equal(CodexConnectionSchema.safeParse({...connection,...extra}).success,false);
  assert.equal(CodexConnectionSchema.safeParse({...connection,models:Array(101).fill('model')}).success,false);
  assert.equal(CodexConnectionSchema.safeParse({...connection,model:'https://provider.invalid/model'}).success,false);
});
function contactFixture(){
  const settings=defaultExtensionSettings();settings.contacts={enabled:true,automaticEnabled:true};
  const route:ContactRoute={id:'route-1',revision:1,adapter:'fake-mail',recipientId:'contact-1',recipientSha256:sha256('test@example.invalid'),
    kind:'contact',enabled:true,verification:{method:'user-challenge',recordId:'verify-1',verifiedAt:1000,expiresAt:20000}};
  const workflow:ContactWorkflow={id:'digest',enabled:true,automatic:true,templateIds:['daily']};
  const template:ContactTemplate={id:'daily',version:1,bodySha256:sha256('A public test digest.'),contentClass:'public'};
  const binding:ContactBinding={routeId:route.id,routeRevision:route.revision,recipientId:route.recipientId,recipientSha256:route.recipientSha256,
    workflowId:workflow.id,templateId:template.id,templateVersion:template.version,bodySha256:template.bodySha256};
  const intent:ContactIntent={requestId:'send-1',binding};
  const rule:ContactRule={id:'rule-1',binding:{...binding},createdAt:1000,expiresAt:20000,revoked:false};
  const approval:ContactApproval={...rule,id:'approval-1',requestId:intent.requestId};
  const context:ContactPolicyContext={now,settings,route,workflow,template,privateSession:false,containsPrivateContent:false,rules:[],approvals:[]};
  return {settings,route,workflow,template,binding,intent,rule,approval,context};
}
test('absent extension fields use independent safe defaults without changing legacy settings',()=>{
  const before=structuredClone(defaults);
  for(const input of [undefined,{}, {agents:{},contacts:{},cursor:{},listening:{}}]){
    const settings=ExtensionSettingsSchema.parse(input);
    assert.equal(settings.agents.codexEnabled,false);assert.equal(settings.agents.claudeApiEnabled,false);
    assert.equal(settings.contacts.enabled,false);assert.equal(settings.contacts.automaticEnabled,false);
    assert.equal(settings.updates.automatic,true);assert.equal(settings.cursor.enabled,false);
    assert.equal(settings.cursor.durationMs,0);assert.equal(settings.security.dailyQuickScan,true);
    assert.equal(settings.security.localHour,9);
    assert.equal(settings.listening.localOnly,true);
  }
  const a=defaultExtensionSettings();a.cursor.enabled=true;
  assert.equal(defaultExtensionSettings().cursor.enabled,false);
  assert.deepEqual(defaults,before);assert.equal(defaults.speechEngine,'designed');
  assert.equal(ExtensionSettingsSchema.safeParse({agents:{apiKey:'secret'}}).success,false);
  assert.equal(ExtensionSettingsSchema.safeParse({contacts:{recipient:'forged'}}).success,false);
  const disabled=ExtensionSettingsSchema.parse({security:{enabled:false,dailyQuickScan:false},updates:{automatic:false}});
  assert.equal(disabled.security.enabled,false);assert.equal(disabled.security.dailyQuickScan,false);
  assert.equal(disabled.updates.automatic,false);
});
test('settings bounds and unsupported security operations fail runtime validation',()=>{
  for(const value of [{durationMs:-1},{durationMs:999},{durationMs:300001},{watchdogLeaseMs:0},{watchdogLeaseMs:60001},{intensity:-1},{intensity:NaN}])
    assert.equal(CursorSettingsSchema.safeParse(value).success,false);
  for(const value of [{localOnly:false},{silenceMs:0},{vadThreshold:2}])
    assert.equal(ListeningSettingsSchema.safeParse(value).success,false);
  assert.equal(SecurityJobSchema.safeParse({id:'s',taskId:'t',requestId:'r',operation:'disable-defender',state:'pending',createdAt:now,evidence:[]}).success,false);
});
test('safe status advertises no providers or actions until configured, and has no key fields',()=>{
  const status=ExtensionStatusSchema.parse(defaultExtensionStatus(now));
  for(const capability of Object.values(status.features)){assert.equal(capability.available,false);assert.deepEqual(capability.actions,[]);}
  assert.equal(status.updates.state,'untrusted');assert.equal(status.features.updates.reason,'untrusted');
  for(const agent of status.agents)assert.equal(agent.capability.available,false);
  assert.equal(ExtensionStatusSchema.safeParse({...status,apiKey:'secret'}).success,false);
  const inconsistent=structuredClone(status);inconsistent.features.agents.available=true;
  assert.equal(ExtensionStatusSchema.safeParse(inconsistent).success,false);
  const untrusted=structuredClone(status);
  untrusted.features.updates={available:true,enabled:true,configured:true,verification:'configuration',reason:'ready',actions:['apply']};
  untrusted.updates={state:'available',version:'0.7.0'};
  assert.equal(ExtensionStatusSchema.safeParse(untrusted).success,false);
  assert.equal(CursorStatusSchema.safeParse({state:'active',recoveryAvailable:true}).success,true);
  assert.throws(()=>defaultExtensionStatus(NaN));
  assert.equal(featureCapability({enabled:true,configured:true,supported:true,trusted:false,actions:['apply']}).available,false);
  assert.deepEqual(featureCapability({enabled:true,configured:true,supported:true,actions:['restore']}).actions,['restore']);
});

test('cursor session lifetime is independent of bounded renewing ownership leases and suspension',()=>{
  assert.equal(CursorSettingsSchema.parse({}).durationMs,0);
  for(const durationMs of [0,1000,30000,300000])assert.equal(CursorSettingsSchema.parse({durationMs}).durationMs,durationMs);
  const lease={ownerId:'owner-1',expiresAt:now+1000,leaseMs:15000};
  const context={now,ownerId:'owner-1',ownerAlive:true};
  assert.deepEqual(cursorLeasePolicy(lease,context),{action:'renew',expiresAt:now+15000});
  // Repeated renewal keeps a session alive well beyond the optional trial bound.
  let current={...lease};
  for(let tick=now;tick<now+600000;tick+=500){
    const result=cursorLeasePolicy(current,{...context,now:tick});
    assert.equal(result.action,'renew');
    if(result.action==='renew')current={...current,expiresAt:result.expiresAt};
  }
  for(const change of [{ownerAlive:false},{ownerId:'owner-2'},{now:lease.expiresAt},{now:NaN}])
    assert.equal(cursorLeasePolicy(lease,{...context,...change}).action,'restore');
  assert.equal(cursorLeasePolicy({...lease,leaseMs:60001},context).action,'restore');
  for(const suspensionReason of ['reduced-motion','game-docked','intensity-zero','locked','accessibility','owner-conflict','host-unavailable']){
    const suspended=CursorStatusSchema.parse({state:'suspended',suspensionReason,recoveryAvailable:true});
    assert.equal(suspended.recoveryAvailable,true);
  }
  for(const status of [{state:'suspended'},{state:'suspended',suspensionReason:'arbitrary error text'},
    {state:'active',suspensionReason:'locked'},{state:'active',suspensionReason:'accessibility'},
    {state:'suspended',suspensionReason:'accessibility: raw Windows settings'}])
    assert.equal(CursorStatusSchema.safeParse({...status,recoveryAvailable:true}).success,false);
  assert.equal(CursorStatusSchema.parse({state:'recovery-required',recoveryAvailable:true}).state,'recovery-required');
});

test('Defender full scans and distinct evidence are represented; scheduling is real-profile only',()=>{
  assert.equal(SecurityJobSchema.parse({id:'s',taskId:'t',requestId:'r',operation:'full-scan',state:'pending',createdAt:now,evidence:[]}).operation,'full-scan');
  for(const outcome of ['no-detection','remediated','action-required','unavailable','uncertain','healthy','findings'])
    assert.equal(SecurityEvidenceSchema.parse({id:'e',jobId:'s',source:'windows-defender',observedAt:now,outcome,summary:''}).outcome,outcome);
  assert.equal(SecurityEvidenceSchema.safeParse({id:'e',jobId:'s',source:'windows-defender',observedAt:now,outcome:'everything-safe',summary:''}).success,false);
  const settings=defaultExtensionSettings();
  const context={settings,profile:'user' as const,hostAvailable:true,due:true,active:false,gameDocked:false};
  assert.equal(securitySchedulePolicy(context).allowed,true);
  for(const profile of ['development','self-test'] as const)
    assert.equal(securitySchedulePolicy({...context,profile}).allowed,false);
  for(const change of [{active:true},{gameDocked:true},{hostAvailable:false},{due:false}])
    assert.equal(securitySchedulePolicy({...context,...change}).allowed,false);
  settings.security.dailyQuickScan=false;assert.equal(securitySchedulePolicy(context).allowed,false);
  settings.security.dailyQuickScan=true;settings.security.enabled=false;assert.equal(securitySchedulePolicy(context).allowed,false);
});
test('decorative motion gates every new portrait effect consistently',()=>{
  const base={gameDocked:false,reducedMotion:false,intensity:1};
  assert.equal(decorativeMotionAllowed(base),true);
  for(const change of [{gameDocked:true},{reducedMotion:true},{intensity:0},{intensity:NaN},{intensity:-1}])
    assert.equal(decorativeMotionAllowed({...base,...change}),false);
});
test('untrusted approved/private/recipient fields cannot create contact or action authority',()=>{
  const f=contactFixture();
  for(const injected of [{approved:true},{private:false},{recipient:'attacker@example.invalid'},{authority:'trusted-ui'}]){
    assert.equal(ContactIntentSchema.safeParse({...f.intent,...injected}).success,false);
    assert.equal(contactPolicy({...f.intent,...injected},f.context).allowed,false);
    assert.equal(ExtensionActionSchema.safeParse({requestId:'r',input:{},...injected}).success,false);
  }
  // Nested arguments remain data: they are not consulted by the pure authorization policy.
  assert.equal(contactPolicy({requestId:'r',input:{approved:true,private:false,recipient:'x'}},f.context).allowed,false);
});
test('verified self and exact explicit rules authorize public contact workflows',()=>{
  const f=contactFixture();
  assert.deepEqual(contactPolicy(f.intent,f.context),{allowed:false,reason:'approval-required',approvalRequired:true});
  f.route.kind='self';assert.deepEqual(contactPolicy(f.intent,f.context),{allowed:true,reason:'self'});
  f.route.kind='contact';f.context.rules=[f.rule];assert.deepEqual(contactPolicy(f.intent,f.context),{allowed:true,reason:'rule'});
  for(const changed of [{expiresAt:now},{createdAt:now+1},{revoked:true}]){
    f.context.rules=[{...f.rule,...changed}];assert.equal(contactPolicy(f.intent,f.context).allowed,false);
  }
});
test('contact permission binds every recipient, route, workflow, template and exact body field',()=>{
  const f=contactFixture();f.context.rules=[f.rule];
  const changes:Partial<ContactBinding>[]=[{routeId:'other'},{routeRevision:2},{recipientId:'other'},
    {recipientSha256:sha256('other')},{workflowId:'other'},{templateId:'other'},{templateVersion:2},{bodySha256:sha256('changed')}];
  for(const change of changes){
    assert.equal(bindingMatches(f.binding,{...f.binding,...change}),false);
    assert.equal(contactPolicy({...f.intent,binding:{...f.binding,...change}},f.context).allowed,false);
    f.context.rules=[{...f.rule,binding:{...f.binding,...change}}];
    assert.equal(contactPolicy(f.intent,f.context).allowed,false);
  }
  assert.notEqual(sha256('body\n'),sha256('body'));assert.notEqual(sha256('é'),sha256('e\u0301'));
});
test('verification expiry, disabled routing and automatic opt-out cannot be bypassed by approvals',()=>{
  const f=contactFixture();f.context.approvals=[f.approval];
  f.route.verification.expiresAt=now;assert.equal(contactPolicy(f.intent,f.context).allowed,false);
  f.route.verification.expiresAt=20000;f.route.verification.verifiedAt=now+1;
  assert.equal(contactPolicy(f.intent,f.context).allowed,false);
  f.route.verification.verifiedAt=1000;f.route.enabled=false;assert.equal(contactPolicy(f.intent,f.context).allowed,false);
  f.route.enabled=true;f.settings.contacts.automaticEnabled=false;assert.equal(contactPolicy(f.intent,f.context).allowed,false);
  f.workflow.automatic=false;assert.equal(contactPolicy(f.intent,f.context).allowed,true);
  f.workflow.templateIds=[];assert.equal(contactPolicy(f.intent,f.context).allowed,false);
});
test('private automatic content is denied even for self, explicit rules and UI approvals',()=>{
  for(const privateSource of ['session','content','template']){
    const f=contactFixture();f.route.kind='self';f.context.rules=[f.rule];f.context.approvals=[f.approval];
    if(privateSource==='session')f.context.privateSession=true;
    if(privateSource==='content')f.context.containsPrivateContent=true;
    if(privateSource==='template')f.template.contentClass='private';
    assert.deepEqual(contactPolicy(f.intent,f.context),{allowed:false,reason:'private-automatic-content',approvalRequired:false});
    f.workflow.automatic=false;f.context.approvals=[];
    assert.equal(contactPolicy(f.intent,f.context).allowed,false);
    f.context.approvals=[f.approval];assert.deepEqual(contactPolicy(f.intent,f.context),{allowed:true,reason:'approval'});
    assert.equal(contactPolicy({...f.intent,requestId:'another-send'},f.context).allowed,false);
    f.context.approvals=[{...f.approval,revoked:true}];assert.equal(contactPolicy(f.intent,f.context).allowed,false);
  }
});
test('delivery acceptance requires trusted matching evidence; error text is unconfirmed',()=>{
  const f=contactFixture();
  const receipt:DeliveryReceipt={id:'receipt-1',requestId:f.intent.requestId,binding:f.binding,adapter:f.route.adapter,
    state:'accepted',observedAt:now,evidence:{source:'service-receipt',recordId:'remote-1'}};
  assert.equal(deliveryOutcome(f.intent,f.route.adapter,receipt),'accepted');
  assert.equal(deliveryOutcome(f.intent,f.route.adapter,{...receipt,state:'sent'}),'sent');
  assert.equal(deliveryOutcome(f.intent,f.route.adapter,{...receipt,state:'delivered',evidence:{source:'observed-record',recordId:'remote-1'}}),'delivered');
  for(const bad of [{...receipt,requestId:'other'},{...receipt,adapter:'other'},
    {...receipt,binding:{...f.binding,bodySha256:sha256('other')}},{...receipt,evidence:{source:'none'}},
    {error:'Service refused the message',status:403},{...receipt,state:'sent',evidence:{source:'none'}},
    {...receipt,state:'sent',binding:{...f.binding,recipientId:'other'}},{...receipt,state:'rejected',evidence:{source:'none'}}])
    assert.equal(deliveryOutcome(f.intent,f.route.adapter,bad),'unconfirmed');
  assert.equal(deliveryOutcome(f.intent,f.route.adapter,{...receipt,state:'rejected',evidence:{source:'trusted-pre-dispatch',code:'not-dispatched'}}),'rejected');
});
test('action receipts cannot call queued, cancelled-after-dispatch or receipt-free messaging completed',()=>{
  const base={id:'receipt-1',requestId:'request-1',feature:'agents',action:'start',observedAt:now};
  assert.equal(ActionReceiptSchema.safeParse({...base,outcome:'pending',effect:'queued',jobId:'job-1'}).success,true);
  for(const change of [{outcome:'completed',effect:'queued'},{outcome:'completed',effect:'unknown'},
    {outcome:'cancelled',effect:'unknown'},{outcome:'rejected',effect:'confirmed'},{outcome:'unconfirmed',effect:'none'}])
    assert.equal(ActionReceiptSchema.safeParse({...base,...change}).success,false);
  assert.equal(ActionReceiptSchema.safeParse({...base,feature:'contacts',action:'send',outcome:'completed',effect:'confirmed'}).success,false);
  assert.equal(ActionReceiptSchema.safeParse({...base,feature:'contacts',action:'configure',outcome:'completed',effect:'confirmed'}).success,true);
  const f=contactFixture();
  const delivery:DeliveryReceipt={id:'delivery-1',requestId:'request-1',binding:f.binding,adapter:f.route.adapter,
    state:'accepted',observedAt:now,evidence:{source:'service-receipt',recordId:'remote-1'}};
  const sent={...base,feature:'contacts',action:'send',outcome:'completed',effect:'confirmed',delivery};
  assert.equal(ActionReceiptSchema.safeParse(sent).success,true);
  const confirmedSent=ActionReceiptSchema.parse({...sent,delivery:{...delivery,state:'sent'}});
  assert.equal(confirmedSent.delivery?.state,'sent');assert.equal(confirmedSent.outcome,'completed');
  for(const change of [{effect:'none'},{outcome:'pending',effect:'queued'},{delivery:{...delivery,requestId:'wrong'}}])
    assert.equal(ActionReceiptSchema.safeParse({...sent,...change}).success,false);
  assert.equal(ActionReceiptSchema.safeParse({...base,outcome:'unconfirmed',effect:'unknown',
    error:{code:'unconfirmed',message:'Review the observed record.',retry:'read-only-reconcile'}}).success,true);
  assert.equal(ActionReceiptSchema.safeParse({...base,outcome:'unconfirmed',effect:'unknown',
    error:{code:'unconfirmed',message:'Review the observed record.',retry:'after-review'}}).success,false);
});
function agentFixture(){
  const settings=defaultExtensionSettings();settings.agents={codexEnabled:true,claudeApiEnabled:true};
  const grant:TaskGrant={taskId:'task-1',request:'Edit the test workspace',mode:'scoped',createdAt:1000,revoked:false,
    expiresAt:20000,providers:['codex','claude-api'],workspaceIds:['workspace-1'],allowPaid:false};
  const context:AgentPolicyContext={now,settings,localOnly:false,privateSession:false,configuredProviders:['codex','claude-api'],grant,parentGrant:{...grant}};
  const input={taskId:'task-1',workspaceId:'workspace-1',provider:'codex' as const};
  return {settings,grant,context,input};
}
test('runtime delegates are off by default, need current scoped grants and never bypass local-only',()=>{
  const f=agentFixture();assert.equal(agentPolicy(f.input,f.context).allowed,true);
  assert.equal(agentPolicy(f.input,{...f.context,settings:defaultExtensionSettings()}).allowed,false);
  for(const change of [{localOnly:true},{privateSession:true},{configuredProviders:[]},{grant:undefined},{parentGrant:undefined},
    {parentGrant:{...f.grant,revoked:true}},{parentGrant:{...f.grant,createdAt:2000}},
    {grant:{...f.grant,expiresAt:now}},{grant:{...f.grant,mode:'full' as const}}])
    assert.equal(agentPolicy(f.input,{...f.context,...change}).allowed,false);
  assert.equal(agentPolicy({...f.input,taskId:'other'},f.context).allowed,false);
  assert.equal(agentPolicy({...f.input,workspaceId:'other'},f.context).allowed,false);
  assert.equal(agentPolicy({...f.input,provider:'claude-api'},f.context).allowed,false);
  f.grant.allowPaid=true;assert.equal(agentPolicy({...f.input,provider:'claude-api'},f.context).allowed,true);
  assert.equal(agentPolicy({...f.input,provider:'claude-api'},{...f.context,localOnly:true}).allowed,false);
});
test('skill reviews pin the complete manifest and source; manifest content cannot self-approve',()=>{
  const manifest:SkillManifest={schemaVersion:1,id:'test-skill',version:'1',name:'Test skill',description:'A local fixture',
    sourceSha256:sha256('source'),entrypoint:'run',permissions:['workspace-read'],localOnly:true,
    requiredCapabilities:[],dependencies:[],verification:[]};
  const reviewed={manifest,review:{skillId:manifest.id,version:manifest.version,manifestSha256:sha256(canonicalJson(manifest)),
    sourceSha256:manifest.sourceSha256,reviewedAt:1000,revoked:false}};
  const context={now,enabled:true,localOnly:true,sourceSha256:manifest.sourceSha256};
  assert.equal(skillPolicy(reviewed,context).allowed,true);
  assert.equal(SkillManifestSchema.safeParse({...manifest,approved:true}).success,false);
  for(const bad of [{...reviewed,manifest:{...manifest,permissions:['host-tools']}},
    {...reviewed,review:{...reviewed.review,revoked:true}},{...reviewed,review:{...reviewed.review,reviewedAt:now+1}}])
    assert.equal(skillPolicy(bad,context).allowed,false);
  assert.equal(skillPolicy(reviewed,{...context,sourceSha256:sha256('tampered')}).allowed,false);
  const networkManifest={...manifest,localOnly:false};
  const networkReview={...reviewed,manifest:networkManifest,review:{...reviewed.review,manifestSha256:sha256(canonicalJson(networkManifest))}};
  assert.equal(skillPolicy(networkReview,context).allowed,false);
  const networkPermission={...manifest,permissions:['network' as const]};
  assert.equal(skillPolicy({...reviewed,manifest:networkPermission,
    review:{...reviewed.review,manifestSha256:sha256(canonicalJson(networkPermission))}},context).allowed,false);
});

test('skill declarations default safely, validate logical data and require trusted dependency/check facts',()=>{
  const legacy={schemaVersion:1,id:'skill',version:'1',name:'Fixture',description:'',sourceSha256:sha256('source'),
    entrypoint:'run',permissions:['workspace-read'],localOnly:true};
  const normalized=SkillManifestSchema.parse(legacy);
  assert.deepEqual(normalized.requiredCapabilities,[]);assert.deepEqual(normalized.dependencies,[]);assert.deepEqual(normalized.verification,[]);
  for(const bad of [{requiredCapabilities:['x'.repeat(201)]},{dependencies:['https://example.invalid/script']},
    {verification:[{kind:'eval',code:'approve()'}]},{verification:[{kind:'registered-check',checkId:'check',approved:true}]},
    {requiredCapabilities:Array(33).fill('capability')},{dependencies:Array(65).fill('dependency')},
    {verification:Array(33).fill({kind:'registered-check',checkId:'check'})}])
    assert.equal(SkillManifestSchema.safeParse({...legacy,...bad}).success,false);
  const manifest=SkillManifestSchema.parse({...legacy,requiredCapabilities:['workspace-read'],dependencies:['tool-1'],
    verification:[{kind:'source-sha256',sha256:legacy.sourceSha256},{kind:'registered-check',checkId:'check-1'}]});
  const review={skillId:manifest.id,version:manifest.version,manifestSha256:sha256(canonicalJson(manifest)),
    sourceSha256:manifest.sourceSha256,reviewedAt:1000,revoked:false};
  const context={now,enabled:true,localOnly:true,sourceSha256:legacy.sourceSha256,
    availableCapabilities:['workspace-read'],availableDependencies:['tool-1'],availableVerifiers:['check-1']};
  assert.equal(skillPolicy({manifest,review},context).allowed,true);
  for(const change of [{availableCapabilities:[]},{availableDependencies:[]},{availableVerifiers:[]}])
    assert.equal(skillPolicy({manifest,review},{...context,...change}).allowed,false);
  const changed={...manifest,dependencies:['tool-2']};
  assert.equal(skillPolicy({manifest:changed,review},{...context,availableDependencies:['tool-2']}).allowed,false);
  const forged={...manifest,verification:[{kind:'source-sha256' as const,sha256:sha256('other')}]};
  assert.equal(skillPolicy({manifest:forged,review:{...review,manifestSha256:sha256(canonicalJson(forged))}},context).allowed,false);
  // Old sparse reviews require a new review of normalized declarations, rather than granting new authority.
  assert.equal(skillPolicy({manifest:legacy,review:{...review,manifestSha256:sha256(canonicalJson(legacy))}},context).allowed,false);
});
// Ephemeral, in-memory signing fixture: no credentials, key files or provider calls.
const keyPair=generateKeyPairSync('ed25519');
const publicPem=keyPair.publicKey.export({format:'pem',type:'spki'}).toString();
function signedRelease(change:Partial<ReleaseManifest['release']>={}):ReleaseManifest {
  const manifest:ReleaseManifest={release:{schemaVersion:1,version:'0.7.0',sequence:7,channel:'stable',publishedAt:1000,expiresAt:20000,
    migration:{readMin:1,readMax:2,writeVersion:2,backupRequired:true,reversible:true},
    artifacts:[{platform:'win32',arch:'x64',url:'https://updates.example.invalid/capri.exe',sha256:sha256('installer'),bytes:9,publisherKeyId:'publisher-1'}],...change},
    signature:{algorithm:'ed25519',keyId:'release-1',value:''}};
  manifest.signature.value=sign(null,Buffer.from(releaseSigningPayload(manifest)),keyPair.privateKey).toString('base64');
  return manifest;
}
const releaseContext:ReleasePolicyContext={now,channel:'stable',platform:'win32',arch:'x64',currentSequence:6,dataVersion:1,
  trustedKeys:{'release-1':publicPem},trustedPublisherKeyIds:['publisher-1']};
test('signed releases need pinned trust and actual signature verification before availability',()=>{
  const manifest=signedRelease();
  assert.equal(releasePolicy(manifest,releaseContext).available,true);
  assert.equal(releasePolicy(manifest,{...releaseContext,trustedKeys:{}}).available,false);
  assert.equal(releasePolicy(manifest,{...releaseContext,trustedPublisherKeyIds:[]}).available,true);
  const artifact={...manifest.release.artifacts[0]};delete artifact.publisherKeyId;
  assert.equal(releasePolicy(signedRelease({artifacts:[artifact]}),{...releaseContext,trustedPublisherKeyIds:undefined}).available,true);
  assert.deepEqual(releasePolicy({...manifest,release:{...manifest.release,version:'0.7.1'}},releaseContext),
    {available:false,reason:'invalid-signature'});
  assert.deepEqual(releasePolicy({...manifest,release:{...manifest.release,
    artifacts:[{...manifest.release.artifacts[0],sha256:sha256('tampered artifact')}]}},releaseContext),
    {available:false,reason:'invalid-signature'});
  assert.equal(releasePolicy({...manifest,signature:{...manifest.signature,value:'A'.repeat(86)+'=='}},releaseContext).available,false);
  assert.equal(releasePolicy({...manifest,trusted:true},releaseContext).available,false);
});

test('release labels use semver including prereleases, while signed sequence controls replay',()=>{
  for(const version of ['0.7.0','0.7.0-dev.1','1.2.3-rc.0+build.001','1.2.3-1a','1.2.3+001'])
    assert.equal(ReleaseVersionSchema.safeParse(version).success,true,version);
  for(const version of ['v0.7.0','0.7','01.2.3','1.2.3-01','1.2.3-','1.2.3+','1.2.3-rc..1','1.2.3\n','nonsense'])
    assert.equal(ReleaseVersionSchema.safeParse(version).success,false,version);
  assert.equal(releasePolicy(signedRelease({version:'0.7.0-rc.1'}),releaseContext).available,true);
  assert.equal(releasePolicy(signedRelease({version:'99.0.0',sequence:6}),releaseContext).available,false);
  assert.equal(releasePolicy(signedRelease({version:'0.1.0',sequence:8}),releaseContext).available,true);
});

test('selected automatic updates still require trust, verification, backup, idle and no cancellation',()=>{
  const context={settings:defaultExtensionSettings(),trustedConfiguration:true,candidateVerified:true,artifactHashVerified:true,
    independentAcceptanceVerified:true,backupVerified:true,idle:true,aborted:false};
  assert.equal(automaticUpdatePolicy(context).allowed,true);
  for(const change of [{trustedConfiguration:false},{candidateVerified:false},{artifactHashVerified:false},
    {independentAcceptanceVerified:false},{backupVerified:false},{idle:false},{aborted:true}])
    assert.equal(automaticUpdatePolicy({...context,...change}).allowed,false);
  assert.equal(defaultExtensionStatus(now).features.updates.available,false);
  assert.equal(releasePolicy(signedRelease(),{...releaseContext,trustedKeys:{}}).available,false);
  context.settings.updates.automatic=false;assert.equal(automaticUpdatePolicy(context).allowed,false);
});
test('signed release policy rejects rollback, expiry, channel, platform and migration mismatches',()=>{
  const manifest=signedRelease();
  for(const change of [{currentSequence:7},{dataVersion:3},{channel:'preview' as const},{platform:'android' as const},{now:20000},{now:0}])
    assert.equal(releasePolicy(manifest,{...releaseContext,...change}).available,false);
  assert.equal(releasePolicy(signedRelease({migration:{readMin:3,readMax:2,writeVersion:2,backupRequired:true,reversible:true}}),releaseContext).available,false);
  assert.equal(releasePolicy(signedRelease({artifacts:[manifest.release.artifacts[0],manifest.release.artifacts[0]]}),releaseContext).available,false);
  // Credential-bearing URL assembled from parts so the public export's secret scanner stays strict.
  const badArtifact={...manifest.release.artifacts[0],url:'https://'+['user','password'].join(':')+'@example.invalid/update'};
  assert.equal(releasePolicy(signedRelease({artifacts:[badArtifact]}),releaseContext).available,false);
  assert.equal(releasePolicy(signedRelease({artifacts:[{...badArtifact,url:'not-a-url'}]}),releaseContext).available,false);
});
