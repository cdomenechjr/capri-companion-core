import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {
  ActionReceiptSchema,AgentJobSchema,AgentProviderSchema,CursorSettingsSchema,DeliveryReceiptSchema,
  ExtensionActionSchema,ExtensionSettingsSchema,ExtensionStatusSchema,FeatureSchema,IdSchema,ReleaseVersionSchema,SecurityJobSchema,
  SecuritySettingsSchema,Sha256Schema,TaskGrantSchema,defaultExtensionSettings,
  type ActionReceipt,type ExtensionAction,type ExtensionActionContext,
  type ExtensionDependencies,type ExtensionFeature,type ExtensionFeatureStatus,type ExtensionModule,
  type ExtensionSettings,type ExtensionStatus,type FeatureCapability,type SecurityJob,type TaskGrant,
} from './contracts';
import {canonicalJson,defaultExtensionStatus,featureCapability,sha256} from './policy';
import {CursorController,PrivateCursorCache,type CursorEnvironment} from './cursor';
import {SkillRegistry,SkillDraftInputSchema,skillsFeatureStatus,type SkillContext,type SkillHostFacts,type SkillMutation} from './skills';
import {SkillExecutionBindingSchema,availableSkillVerifiers,discardPrivateSkillEvidence,observeSkillProof,type SkillExecutionBinding} from './skill-verification';
import {SecurityScheduler,SecurityTools,validateSecurityTarget,type SecurityHost,type SecurityJournal,type SecurityJournalRecord,type SecurityScheduleContext} from './security';
import {createContactsModule,clearContactReviews,type ContactsModuleOptions,type ContactsDependencies} from './contacts';
import {verificationContactReceipt} from './contact-admin';
import {RuntimeAgents,CodexRuntimeConnection,createNativeRuntimeAgentFactory,agentJournalKind,type CodexConnectionOptions,type AgentAuthority,type AgentTaskResult,type NativeRuntimeAgentOptions,type RuntimeAgentDependencies} from './agents';

/** A bounded source snapshot, never a writable view of the original project.
 * Ignore VCS/dependency/cache and secret configuration entries before copying;
 * aliases and hardlinks cannot smuggle content across that boundary. */
export function stageAgentWorkspace(input:{sourceRoot:string;stagingRoot:string;excludedRoots:readonly string[];signal:AbortSignal}):{root:string;files:number;bytes:number}{
  const canonical=(value:string)=>{if(!path.isAbsolute(value))throw new ExtensionHubError('invalid-request');const absolute=path.resolve(value),real=fs.realpathSync.native(absolute);if(real.toLowerCase()!==absolute.toLowerCase())throw new ExtensionHubError('forbidden');let current=path.parse(absolute).root;for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw new ExtensionHubError('forbidden');}return real;};
  const source=canonical(input.sourceRoot),base=canonical(input.stagingRoot);
  const within=(a:string,b:string)=>{const relative=path.relative(a.toLowerCase(),b.toLowerCase());return !relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
  if(within(source,base)||within(base,source)||source===path.parse(source).root)throw new ExtensionHubError('forbidden');
  const exclusions=input.excludedRoots.map(value=>path.resolve(value));if(exclusions.some(value=>within(value,source)))throw new ExtensionHubError('forbidden');
  const ignored=/^(?:\.|node_modules$|vendor$|dist$|build$|coverage$|bin$|obj$|private\.config$|credentials(?:\.|$)|secrets?(?:\.|$))|\.(?:pem|key|pfx|p12|keystore|sqlite|db)$/i;
  const root=fs.mkdtempSync(path.join(base,'workspace-'));let files=0,bytes=0,entries=0;
  const walk=(directory:string,target:string,depth:number)=>{input.signal.throwIfAborted();if(depth>32)throw new ExtensionHubError('invalid-request');for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    if(++entries>20000)throw new ExtensionHubError('invalid-request');if(ignored.test(entry.name))continue;
    input.signal.throwIfAborted();const file=path.join(directory,entry.name);if(exclusions.some(value=>within(value,file)))continue;const info=fs.lstatSync(file);if(info.isSymbolicLink()||info.isFile()&&info.nlink!==1||!info.isDirectory()&&!info.isFile())throw new ExtensionHubError('forbidden');
    const output=path.join(target,entry.name);if(info.isDirectory()){fs.mkdirSync(output);walk(file,output,depth+1);continue;}
    if(++files>1000||info.size>4*1024*1024||(bytes+=info.size)>32*1024*1024)throw new ExtensionHubError('invalid-request');
    const handle=fs.openSync(file,'r');try{const before=fs.fstatSync(handle);if(before.dev!==info.dev||before.ino!==info.ino||before.size!==info.size||before.nlink!==1)throw new ExtensionHubError('forbidden');const data=Buffer.alloc(info.size+1);const count=fs.readSync(handle,data,0,data.length,0);const after=fs.fstatSync(handle);if(count!==info.size||after.size!==info.size||after.mtimeMs!==before.mtimeMs)throw new ExtensionHubError('unavailable');fs.writeFileSync(output,data.subarray(0,count),{flag:'wx'});}finally{fs.closeSync(handle);}
  }};
  try{walk(source,root,0);return {root,files,bytes};}catch(error){if(path.dirname(root)===base&&path.basename(root).startsWith('workspace-'))fs.rmSync(root,{recursive:true,force:true});throw error;}
}
export interface DelegatedTextChange {path:string;before:string;after:string;beforeSha256?:string;afterSha256:string}
/** Exact text preview for an explicit host review; this neither applies files nor
 * treats an agent's report as verification. Deletions/binary changes stay manual. */
export function delegatedTextChanges(source:string,staged:string,changes:AgentTaskResult['changedFiles']):DelegatedTextChange[]{
  if(changes.length>1000)throw new ExtensionHubError('unavailable');let total=0;
  const read=(root:string,relative:string,missing=false)=>{let current=path.resolve(root);for(const part of relative.split('/')){current=path.join(current,part);try{if(fs.lstatSync(current).isSymbolicLink())throw new ExtensionHubError('forbidden');}catch(error){if(missing&&(error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
    if(fs.realpathSync.native(current).toLowerCase()!==path.resolve(current).toLowerCase())throw new ExtensionHubError('forbidden');const stat=fs.lstatSync(current);if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024||(total+=stat.size)>4*1024*1024)throw new ExtensionHubError('unavailable');
    const fd=fs.openSync(current,'r');try{const start=fs.fstatSync(fd);if(start.ino!==stat.ino||start.dev!==stat.dev||start.size!==stat.size||start.nlink!==1)throw new ExtensionHubError('forbidden');const data=Buffer.alloc(start.size+1),count=fs.readSync(fd,data,0,data.length,0),end=fs.fstatSync(fd);if(count!==start.size||end.size!==start.size||end.mtimeMs!==start.mtimeMs)throw new ExtensionHubError('unavailable');const bytes=data.subarray(0,count),text=bytes.toString('utf8');if(text.includes('\0')||!Buffer.from(text,'utf8').equals(bytes))throw new ExtensionHubError('unsupported');return {text,digest:createHash('sha256').update(bytes).digest('hex')};}finally{fs.closeSync(fd);}};
  return changes.map(change=>{const relative=change.path.replace(/\\/g,'/');if(!relative||path.posix.isAbsolute(relative)||relative.split('/').some(part=>!part||part==='..'||part==='.'||part.startsWith('.')||/[\x00-\x1f<>:"|?*]/.test(part))||change.kind==='deleted')throw new ExtensionHubError('unsupported');
    const before=read(source,relative,true),after=read(staged,relative);if(!after||after.digest!==change.afterSha256||before?.digest!==change.beforeSha256)throw new ExtensionHubError('unavailable','Project or staged files changed after the agent result.');return {path:relative,before:before?.text??'',after:after.text,beforeSha256:before?.digest,afterSha256:after.digest};});
}

const empty=z.object({}).strict(),keyInput=z.object({jobId:IdSchema}).strict();
const shape=ExtensionSettingsSchema.unwrap().shape;
const configureSchemas={cursor:CursorSettingsSchema,listening:shape.listening,
  skills:shape.skills,agents:shape.agents,security:SecuritySettingsSchema,contacts:shape.contacts,assets:shape.assets,updates:shape.updates} as const;
export const hubRecordKinds=Object.freeze({settings:'extension:settings',request:'extension:hub:request',grant:'extension:agents:grant',security:'extension:security:request',schedule:'extension:security:schedule'});
const settingsRecord=z.object({id:z.literal('main'),schemaVersion:z.literal(1),settings:ExtensionSettingsSchema}).strict();
const requestRecord=z.object({id:z.string().min(1).max(240),digest:Sha256Schema,feature:FeatureSchema,action:IdSchema,receipt:ActionReceiptSchema,final:z.boolean()}).strict();
const stripStoreFields=(raw:any)=>{if(!raw)return raw;const {updatedAt:_updatedAt,...value}=raw;return value;};
const queues=new WeakMap<object,Map<string,Promise<unknown>>>();
function serial<T>(store:object,key:string,work:()=>Promise<T>):Promise<T>{
  let map=queues.get(store);if(!map){map=new Map();queues.set(store,map);}const previous=map.get(key)??Promise.resolve();
  const result=previous.catch(()=>{}).then(work),tail=result.catch(()=>{});map.set(key,tail);
  void tail.then(()=>{if(map!.get(key)===tail)map!.delete(key);});return result;
}
export class ExtensionHubError extends Error {
  constructor(readonly code:'forbidden'|'unavailable'|'unsupported'|'invalid-request',message='Extension operation is unavailable.'){super(message);}
}
/** Created after HTTP/UI/task authentication, never by spreading request fields.
 * A synchronous resolver reads live session/TaskAccess state before each effect.
 * privacyEpoch changes whenever the authenticated capture/session owner changes. */
export interface HubHostContext extends ExtensionActionContext {privacyEpoch:string}
declare const contextBrand:unique symbol;
export interface HubContext {readonly [contextBrand]:true}
type ContextEntry={resolve:()=>HubHostContext;initial:HubHostContext;controller:AbortController;signal:AbortSignal;retired:boolean};
type AgentCatalog={tasks:{id:string;label:string}[];workspaces:{id:string;label:string}[]};
const agentCatalog=z.object({tasks:z.array(z.object({id:IdSchema,label:z.string().max(120)}).strict()).max(50),
  workspaces:z.array(z.object({id:IdSchema,label:z.string().max(120)}).strict()).max(32)}).strict();
const contactsOverview=z.object({
  providers:z.array(z.object({channel:z.enum(['gmail','sms','voice','whatsapp']),configured:z.boolean(),secretStored:z.boolean(),senderHint:z.string().max(120).optional()}).strict()).max(4),
  routes:z.array(z.object({id:IdSchema,revision:z.number().int().positive(),channel:z.enum(['gmail','sms','voice','whatsapp','android']),kind:z.enum(['self','contact']),label:z.string().max(120),enabled:z.boolean(),verified:z.boolean(),verificationExpiresAt:z.number().int().nonnegative().optional()}).strict()).max(100),
  rules:z.array(z.object({id:IdSchema,routeId:IdSchema,workflowId:IdSchema,templateId:IdSchema,expiresAt:z.number().int().nonnegative(),revoked:z.boolean()}).strict()).max(100),
  budget:z.object({monthlyMessageLimit:z.number().int().nonnegative(),usedThisMonth:z.number().int().nonnegative().nullable()}).strict().optional(),
  outbox:z.array(z.object({receipt:DeliveryReceiptSchema,channel:z.enum(['gmail','sms','voice','whatsapp','android']),routeLabel:z.string().max(120).optional(),draftKept:z.boolean(),approvalRequired:z.boolean()}).strict()).max(100)
}).strict();
export type HubContactsOverview=z.infer<typeof contactsOverview>;
export interface ExtensionHubOptions extends Pick<ExtensionDependencies,'store'|'clock'> {
  profile:'user'|'development'|'self-test';
  settingsChanged?(settings:ExtensionSettings,context:ExtensionActionContext):Promise<void>;
  host?:ExtensionDependencies['host'];transport?:ExtensionDependencies['transport'];
  cursor?:{controller:Pick<CursorController,'status'|'recover'|'enable'|'stop'|'updateEnvironment'>;cache:Pick<PrivateCursorCache,'importFolder'>;
    status?():ExtensionStatus['cursor'];recoveryStatus?():'none'|'restored'|'required';
    environment(signal:AbortSignal):Promise<CursorEnvironment>};
  /** Existing local voice owner supplies observation only; Hub never captures or speaks. */
  listeningStatus?(signal:AbortSignal):Promise<Extract<ExtensionFeatureStatus,{feature:'listening'}>>;
  assetsStatus?(signal:AbortSignal):Promise<{feature:'assets';capability:FeatureCapability}>;
  importAssets?(folder:string,settings:ExtensionSettings['assets'],context:ExtensionActionContext):Promise<void>;
  skillFacts?(context:ExtensionActionContext):Promise<Omit<SkillHostFacts,'checks'>>;
  agents?:{native:NativeRuntimeAgentOptions;resolveAuthority:RuntimeAgentDependencies['resolveAuthority'];
    connection?:CodexConnectionOptions;
    stageWorkspace?(folder:string,context:ExtensionActionContext):Promise<void>;
    approveTool?:RuntimeAgentDependencies['approveTool'];providerStatus?:RuntimeAgentDependencies['providerStatus'];onActivity?:RuntimeAgentDependencies['onActivity'];
    catalog?(context:ExtensionActionContext):Promise<AgentCatalog>};
  security?:{host:SecurityHost;availability?(signal:AbortSignal):Promise<{configured:boolean;ready:boolean}>;
    authorize(operation:SecurityJob['operation'],target:string|undefined,context:ExtensionActionContext):Promise<boolean>;
    scheduleContext?(signal:AbortSignal):Promise<Omit<SecurityScheduleContext,'profile'|'settings'>>};
  contacts?:ContactsModuleOptions;
  /** Optional trusted administration metadata. Delivery rows come from the real
   * contact outbox when configured; this callback cannot create review authority. */
  contactsOverview?(context:ExtensionActionContext):Promise<HubContactsOverview>;
  /** A real managed-update facade may be supplied later. No default host,
   * signature/acceptance callback, backup, key or simulated success is created. */
  updates?:ExtensionModule&{stop?():Promise<void>};
}
export interface HubStopReport {cursor?:ExtensionStatus['cursor'];agents:Awaited<ReturnType<RuntimeAgents['recover']>>;errors:ExtensionFeature[]}

/** Composition only. Service/main keep authentication, TaskAccess, project
 * staging, renderer/voice ownership and concrete resource/provider discovery.
 * await createExtensionHub(options), then create a context handle from trusted
 * live host state for status/settings/overview/dispatch. Notify privacyBoundary
 * immediately on an owner/privacy change and await stop/close on Stop/Quit.
 * No constructor/status/overview starts scans, sends, SDK turns or updates. */
export class ExtensionHub {
  private contexts=new WeakMap<HubContext,ContextEntry>();private entries=new Set<ContextEntry>();
  private skills:SkillRegistry;private agents?:RuntimeAgents;private contacts:ReturnType<typeof createContactsModule>;private security?:SecurityTools;
  private contactScopes=new Map<string,HubContext>();
  // Global policy changes fence every binding; registry edits fence only their
  // validated skill identity, including failed or uncertain writes across awaits.
  private skillGeneration=0;private skillMutations=0;
  private skillScopes=new Map<string,{generation:number;pending:number;unconfirmed:boolean}>();
  private scheduler?:SecurityScheduler;private initialized=false;private closed=false;private stopping?:Promise<HubStopReport>;
  private closing?:Promise<void>;
  private codex?:CodexRuntimeConnection;
  private codexScope?:HubContext;
  private initializing?:Promise<this>;private stopGeneration=0;
  private privateRequests=new Map<string,z.infer<typeof requestRecord>>();
  private securityStarted=new Map<string,(job:SecurityJob)=>void>();
  private securityActive=new Map<string,{job?:SecurityJob;digest:string;handle:HubContext;controller:AbortController;done:Promise<SecurityJob>}>();
  private securityScopes=new Map<string,HubContext>();
  private scheduledSecurity=new Set<string>();
  private cursorDirectory?:string;
  constructor(private readonly options:ExtensionHubOptions){
    this.skills=new SkillRegistry(options);
    this.contacts=this.makeContacts();
    if(options.updates?.feature!=='updates'&&options.updates)throw new ExtensionHubError('invalid-request','Update adapter has the wrong feature.');
    if(options.security){this.security=new SecurityTools({platform:options.security.host.platform,invoke:async(operation,input,signal)=>{
      const handle=this.securityScopes.get(input.requestId);if(!handle)throw new ExtensionHubError('forbidden');
      const ctx=this.current(handle),settings=await this.readSettings();this.current(handle);
      if(!settings.security.enabled||!await options.security!.authorize(operation,input.target,ctx))throw new ExtensionHubError('forbidden');
      this.current(handle);
      if(this.scheduledSecurity.has(input.requestId)&&!await this.scheduleReady(handle))throw new ExtensionHubError('forbidden');
      this.current(handle);signal.throwIfAborted();return options.security!.host.invoke(operation,input,signal);
    }},this.securityJournal(),{now:options.clock,localDate:now=>new Date(now)});
      this.scheduler=new SecurityScheduler({claimOccurrence:day=>serial(options.store,'schedule:'+day,async()=>{
        if(await options.store.get(hubRecordKinds.schedule,day))return false;
        await options.store.put(hubRecordKinds.schedule,{id:day,claimed:true});return (await options.store.get(hubRecordKinds.schedule,day))?.claimed===true;
      })},{now:options.clock,localDate:now=>new Date(now)});}
  }
  private dependencies():ExtensionDependencies{return {...this.options,host:this.options.host??{run:async()=>{throw new ExtensionHubError('unavailable');}},
    transport:this.options.transport??{request:async()=>{throw new ExtensionHubError('unavailable');}}};}
  private makeContacts(handle?:HubContext){
    const options=this.options.contacts;
    let originHandle:HubContext|undefined;
    // The accepted facade snapshots its context. Bind each dispatch to its live
    // Hub handle instead; all facades still use the SAME outbox Store/journals.
    const guard=(signal?:AbortSignal)=>{if(!handle)throw new ExtensionHubError('forbidden');const current=this.current(handle);current.signal.throwIfAborted();signal?.throwIfAborted();if(originHandle)this.current(originHandle).signal.throwIfAborted();return current;};
    const providers=handle?options?.providers.map(provider=>({id:provider.id,channel:provider.channel,
      ...(provider.configurationId?{configurationId:async()=>{guard();const id=await provider.configurationId!();guard();return id;}}:{}),
      prepare:async(message:Parameters<typeof provider.prepare>[0],signal:AbortSignal)=>{
        guard(signal);const original=originHandle?this.current(originHandle).signal:undefined,scopedSignal=original?AbortSignal.any([signal,original]):signal;
        const prepared=await provider.prepare(message,scopedSignal);guard(scopedSignal);
        return {dispatch:async()=>{guard(scopedSignal);const observation=await prepared.dispatch();guard(scopedSignal);return observation;}};
      },...(provider.observe?{observe:async(message:Parameters<NonNullable<typeof provider.observe>>[0],recordId:string,signal:AbortSignal)=>{
        guard(signal);const original=originHandle?this.current(originHandle).signal:undefined,scopedSignal=original?AbortSignal.any([signal,original]):signal;
        const observation=await provider.observe!(message,recordId,scopedSignal);guard(scopedSignal);return observation;
      }}:{})})):options?.providers;
    return createContactsModule(this.dependencies(),options?{...options,providers:providers!,
      reviewScope:()=>{const ctx=guard(),entry=this.contexts.get(handle!)!;return {authority:ctx.authority,privacyEpoch:entry.initial.privacyEpoch,privateSession:ctx.privateSession};},
      availability:async()=>{const settings=await this.readSettings(),value=await options.availability?.();return {enabled:settings.contacts.enabled,configured:options.providers.length>0&&value?.configured===true,ready:options.providers.length>0&&value?.ready===true};},
      resolve:async(intent,context)=>{originHandle=this.contactScopes.get(intent.requestId);
        const origin=originHandle,current=guard(context.signal);
        // A UI review can use only the original live send authority. Closing a task
        // removes that binding; the UI session must never become its replacement.
        if(!origin||current.authority==='task'&&origin!==handle)throw new ExtensionHubError('forbidden');
        const source=this.current(origin);
        if(source.privateSession&&!current.privateSession)throw new ExtensionHubError('forbidden');
        const value=structuredClone(await options.resolve(intent,source));guard(context.signal);if(origin)this.current(origin);
        value.execution.active=value.execution.active&&!source.signal.aborted;
        value.execution.localOnly=value.execution.localOnly||source.localOnly;
        value.context.privateSession=value.context.privateSession||source.privateSession;
        value.context.settings=await this.readSettings();guard(context.signal);if(origin)this.current(origin);return value;}}:undefined);
  }
  /** In-process desktop administration only. The service never mounts this on
   * generic HTTP. Every call retains its authenticated live Hub scope. */
  contactAdministration(handle:HubContext){
    const guard=()=>{const c=this.current(handle);if(c.authority!=='trusted-ui'||c.privateSession||c.localOnly||!this.options.contacts)throw new ExtensionHubError('forbidden');c.signal.throwIfAborted();return c;};
    const ctx=guard(),module=this.makeContacts(handle);let resolver:ContactsDependencies['resolveVerification'];
    const service=()=>module.administration(guard(),resolver?async id=>{guard();const value=await resolver!(id);guard();return value;}:undefined);
    return {
      beginVerification:async(id:string,resolve:NonNullable<ContactsDependencies['resolveVerification']>)=>{guard();resolver=resolve;const value=await service().beginVerification(id);guard();return value;},
      dispatchVerification:async(id:string)=>{guard();const result=await service().dispatch(id,ctx.signal);guard();return result;},
      completeVerification:async(id:string,code:string,route:Parameters<ReturnType<typeof service>['completeVerification']>[2])=>{guard();const result=await service().completeVerification(id,code,route);guard();return result;},
      verifiedRoute:async(route:Parameters<ReturnType<typeof service>['verifiedRoute']>[0])=>{guard();const result=await service().verifiedRoute(route);guard();return result;},
      reconcile:async(id:string)=>{guard();const outbox=service(),result=await outbox.reconcile(id,ctx.signal),challenge=await outbox.verificationChallenge(id);guard();return result&&challenge?verificationContactReceipt(challenge,result):result;},
      approveRule:async(input:unknown)=>{guard();const result=await service().approve(input);guard();return result;},
    };
  }
  async prepareContact(intent:Parameters<ContactsModuleOptions['resolve']>[0],handle:HubContext){
    const ctx=this.current(handle);if(ctx.localOnly||!this.options.contacts)throw new ExtensionHubError('forbidden');
    if(this.contactScopes.has(intent.requestId)||this.contactScopes.size>=10000)throw new ExtensionHubError('unavailable');this.contactScopes.set(intent.requestId,handle);
    const scoped=this.makeContacts(handle);try{const result=await scoped.administration(ctx).enqueue(intent);this.current(handle);return result;}finally{await scoped.close();}
  }
  private makeAgents(){
    const options=this.options.agents;if(!options)return undefined;
    const native=createNativeRuntimeAgentFactory(options.native);
    this.codex=options.connection?new CodexRuntimeConnection(options.connection,native.drivers.codex,native.leases):undefined;
    return new RuntimeAgents({...this.dependencies(),...native,resolveAuthority:async(taskId,provider,workspaceId)=>{
      const authority=await options.resolveAuthority(taskId,provider,workspaceId);
      return {...authority,settings:await this.readSettings(),grant:await this.readGrant(taskId)};
    },approveTool:options.approveTool,onActivity:options.onActivity,canStart:provider=>provider!=='codex'||!options.connection||this.codex?.ready()===true,
      providerStatus:async()=>{const settings=await this.readSettings();return (await options.providerStatus?.()??[]).map(p=>({...p,ready:p.ready&&native.configuration(p.provider).available&&(p.provider!=='codex'||!options.connection||this.codex?.ready()===true),enabled:p.provider==='codex'?settings.agents.codexEnabled:settings.agents.claudeApiEnabled}));}});
  }
  codexConnection(handle:HubContext){const ctx=this.current(handle);if(ctx.authority!=='trusted-ui'||ctx.taskId||ctx.privateSession||ctx.localOnly)throw new ExtensionHubError('forbidden');if(!this.codex)throw new ExtensionHubError('unsupported');const state=this.codex.snapshot();if(state.sessionId&&this.codexScope!==handle)throw new ExtensionHubError('forbidden');return state;}
  /** Main-window executable locator uses the same shared provider lease as setup/jobs. */
  async configureCodex<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{if(!this.codex||this.stopping||this.closed)throw new ExtensionHubError('unavailable');return this.codex.configure(work);}
  private async codexAction(action:string,request:ExtensionAction,handle:HubContext):Promise<ActionReceipt>{
    const ctx=this.current(handle);if(ctx.authority!=='trusted-ui'||ctx.taskId||ctx.privateSession||ctx.localOnly)return this.receipt('agents',action,request,'forbidden');
    if(!this.codex)return this.receipt('agents',action,request,'unconfigured');
    try{
      if(action==='connect-codex'||action==='inspect-codex'){
        empty.parse(request.input);const id=this.codex.start(action==='connect-codex'?'connect':'inspect',ctx.signal);this.codexScope=handle;
        return {...this.receipt('agents',action,request),outcome:'pending',effect:'queued',jobId:id};
      }
      if(action==='cancel-codex'){if(this.codexScope!==handle)return this.receipt('agents',action,request,'forbidden');const {sessionId}=z.object({sessionId:IdSchema}).strict().parse(request.input);await this.codex.cancel(sessionId);}
      else if(action==='select-codex-model'){const {model}=z.object({model:z.string()}).strict().parse(request.input);await this.codex.selectModel(model);}
      else return this.receipt('agents',action,request,'unsupported');
      this.current(handle);return this.receipt('agents',action,request);
    }catch{return this.receipt('agents',action,request,'unavailable');}
  }
  initialize():Promise<this>{
    if(this.initialized)return Promise.resolve(this);if(this.closed)return Promise.reject(new ExtensionHubError('unavailable'));if(this.initializing)return this.initializing;
    const generation=this.stopGeneration,guard=()=>{if(this.closed||generation!==this.stopGeneration)throw new ExtensionHubError('unavailable');};
    return this.initializing=(async()=>{
    await this.readSettings();guard();this.agents=this.makeAgents();await this.agents?.recover();guard();
    // Recovery observes/stops old ownership; it never enables a saved cursor or
    // replays a pending effect. Native factory performs no inference on recovery.
    await this.options.cursor?.controller.recover();guard();
    for(const raw of await this.options.store.list(hubRecordKinds.security)){
      const value=this.securityRecord(raw);if(['pending','running'].includes(value.job.state)){
        guard();value.job={...value.job,state:'unconfirmed'};await this.saveSecurity(value.job.requestId,value);
      }
    }
    guard();this.initialized=true;return this;
    })().finally(()=>{this.initializing=undefined;});
  }
  /** Host-only context issuer. Handles are opaque, instance-bound and cannot be
   * reconstructed from JSON, an approval flag, a model event or an HTTP body.
   * Reuse a handle for its task/session lifetime. Queued jobs need the task-owned
   * signal; HTTP response completion must not retire a running task's context. */
  context(resolve:()=>HubHostContext):HubContext {
    if(!this.initialized||this.closed||this.stopping)throw new ExtensionHubError('unavailable');
    const initial=this.validateContext(resolve()),controller=new AbortController();if(initial.signal.aborted)throw new ExtensionHubError('forbidden');
    const entry:ContextEntry={resolve,initial,controller,signal:AbortSignal.any([initial.signal,controller.signal]),retired:false};
    const handle=Object.freeze({}) as HubContext;this.contexts.set(handle,entry);this.entries.add(entry);
    entry.signal.addEventListener('abort',()=>{this.entries.delete(entry);for(const [id,source]of this.contactScopes)if(source===handle)this.contactScopes.delete(id);},{once:true});return handle;
  }
  private validateContext(value:HubHostContext):HubHostContext {
    if(!value||!(value.signal instanceof AbortSignal)||!['trusted-ui','task'].includes(value.authority)||typeof value.privateSession!=='boolean'||typeof value.localOnly!=='boolean'||
      typeof value.privacyEpoch!=='string'||!value.privacyEpoch||value.privacyEpoch.length>120||value.taskId!==undefined&&!IdSchema.safeParse(value.taskId).success||value.grant!==undefined&&!TaskGrantSchema.safeParse(value.grant).success)throw new ExtensionHubError('forbidden');
    return {...value};
  }
  private refresh(entry:ContextEntry):HubHostContext|undefined {
    if(entry.retired||this.closed)return undefined;
    try{const value=this.validateContext(entry.resolve());
      if(value.signal!==entry.initial.signal||value.authority!==entry.initial.authority||value.taskId!==entry.initial.taskId||value.privateSession!==entry.initial.privateSession||value.localOnly!==entry.initial.localOnly||value.privacyEpoch!==entry.initial.privacyEpoch)throw Error();
      if(value.authority==='task'&&value.grant&&(value.grant.revoked||value.grant.taskId!==value.taskId||value.grant.createdAt>this.options.clock()||value.grant.expiresAt<=this.options.clock()))throw Error();
      if(entry.signal.aborted)throw Error();return value;
    }catch{entry.retired=true;entry.controller.abort();discardPrivateSkillEvidence(this.options.store);this.skills.discardPrivateDrafts();return undefined;}
  }
  private current(handle:HubContext):HubHostContext {
    const entry=this.contexts.get(handle);if(!entry||!this.refresh(entry)||this.stopping||!this.initialized)throw new ExtensionHubError('forbidden');
    // Module guards re-read host authority synchronously after their own awaits.
    const read=()=>this.refresh(entry);
    return {get privacyEpoch(){return read()?.privacyEpoch??'retired';},get signal(){read();return entry.signal;},get authority(){return read()?.authority??'task';},get taskId(){return read()?.taskId;},
      get grant(){return read()?.grant;},get privateSession(){return read()?.privateSession??true;},get localOnly(){return read()?.localOnly??true;}};
  }
  /** Call when the task/session scope ends; not when a queued HTTP reply ends. */
  releaseContext(handle:HubContext){const entry=this.contexts.get(handle);if(entry){entry.retired=true;entry.controller.abort();this.entries.delete(entry);}}
  privacyBoundary(){discardPrivateSkillEvidence(this.options.store);for(const entry of this.entries){entry.retired=true;entry.controller.abort();}this.entries.clear();this.contactScopes.clear();this.privateRequests.clear();clearContactReviews(this.options.store);this.skills.discardPrivateDrafts();}
  private async readSettings():Promise<ExtensionSettings>{
    const raw=await this.options.store.get(hubRecordKinds.settings,'main');
    if(!raw)return defaultExtensionSettings();
    const parsed=settingsRecord.safeParse(stripStoreFields(raw));if(!parsed.success)throw new ExtensionHubError('unavailable','Extension settings need recovery.');return parsed.data.settings;
  }
  async settings(handle:HubContext){const ctx=this.current(handle);ctx.signal.throwIfAborted();const settings=await this.readSettings();this.current(handle);return settings;}
  private async readGrant(taskId:string):Promise<TaskGrant|undefined>{const raw=await this.options.store.get(hubRecordKinds.grant,taskId);if(!raw)return undefined;const grant=TaskGrantSchema.parse(raw.grant);if(raw.id!==taskId||grant.taskId!==taskId)throw new ExtensionHubError('unavailable');return grant;}
  private receipt(feature:ExtensionFeature,action:string,request:ExtensionAction,code?:NonNullable<ActionReceipt['error']>['code'],unknown=false):ActionReceipt {
    return ActionReceiptSchema.parse({id:randomUUID(),requestId:request.requestId,feature,action,observedAt:this.options.clock(),outcome:unknown?'unconfirmed':code?'rejected':'completed',effect:unknown?'unknown':code?'none':'confirmed',
      ...(code?{error:{code:unknown?'unconfirmed':code,message:unknown?'The outcome requires read-only reconciliation.':'Extension action is not available under current authority.',retry:unknown?'read-only-reconcile':['unavailable','unconfigured','approval-required'].includes(code)?'after-review':'never'}}:{})});
  }
  async status(handle:HubContext):Promise<ExtensionStatus>{
    const ctx=this.current(handle),settings=await this.readSettings();this.current(handle);const value=defaultExtensionStatus(this.options.clock());
    const apply=(status:ExtensionFeatureStatus)=>{value.features[status.feature]=status.capability;if(status.feature==='cursor')value.cursor=status.cursor;else if(status.feature==='listening')value.listening=status.listening;else if(status.feature==='agents')value.agents=status.agents;else if(status.feature==='updates')value.updates=status.updates;};
    apply(skillsFeatureStatus(settings));
    value.features.skills.actions=value.features.skills.actions.filter(action=>action!=='select');
    value.features.security=featureCapability({enabled:settings.security.enabled,configured:!!this.security,supported:true,ready:false});
    if(this.options.cursor){const cursor=this.options.cursor.status?.()??this.options.cursor.controller.status();value.cursor=cursor;value.features.cursor=featureCapability({enabled:settings.cursor.enabled,configured:!!this.cursorDirectory,supported:true,ready:cursor.state==='active',verification:cursor.state==='active'?'local-probe':'none',actions:['restore','configure']});}
    const observations=[this.agents?.status(ctx.signal),this.contacts.status(ctx.signal),this.options.updates?.status(ctx.signal),this.options.listeningStatus?.(ctx.signal),this.options.assetsStatus?.(ctx.signal)];
    const results=await Promise.allSettled(observations);for(const result of results)if(result.status==='fulfilled'&&result.value)apply(result.value);
    if(this.options.security){try{const observed=await this.options.security.availability?.(ctx.signal);value.features.security=featureCapability({enabled:settings.security.enabled,configured:observed?.configured===true,supported:this.options.security.host.platform==='win32',ready:observed?.ready===true,verification:observed?.ready?'local-probe':'none',actions:['health','quick-scan','full-scan','custom-scan','update-signatures','inspect','cancel']});}catch{}}
    if(!settings.listening.enabled){value.features.listening=featureCapability({enabled:false,configured:value.features.listening.configured,supported:true});value.listening={state:'disabled',owner:'desktop',localOnly:true};}
    if(ctx.privateSession||ctx.localOnly){for(const item of value.agents)item.capability=featureCapability({enabled:item.capability.enabled,configured:item.capability.configured,supported:true,ready:false});value.features.agents=featureCapability({enabled:settings.agents.codexEnabled||settings.agents.claudeApiEnabled,configured:value.features.agents.configured,supported:true,ready:false});}
    this.current(handle);return ExtensionStatusSchema.parse(value);
  }
  private async skillContext(handle:HubContext):Promise<SkillContext>{const ctx=this.current(handle),settings=await this.readSettings(),facts=await this.options.skillFacts?.(ctx);
    const task=ctx.taskId&&!ctx.privateSession?await this.options.store.get('task',ctx.taskId):undefined;
    const dependencies=[...(facts?.dependencies??[])],verifiers=[...(facts?.availableVerifiers??[])];
    if(settings.security.enabled&&this.security&&this.options.security?.host.platform==='win32'){
      const security=await this.options.security.availability?.(ctx.signal);this.current(handle);
      if(security?.ready&&security.configured){dependencies.push('extension:security');verifiers.push('defender-evidence');}
    }
    this.current(handle);return {now:this.options.clock(),enabled:settings.skills.enabled,privateSession:ctx.privateSession,localOnly:ctx.localOnly,requestText:typeof task?.text==='string'?task.text:undefined,
      facts:{capabilities:[...(facts?.capabilities??[])],dependencies:[...new Set(dependencies)],availableVerifiers:[...new Set(verifiers)].filter(id=>availableSkillVerifiers.includes(id)),checks:[],
        commandToolchains:facts?.commandToolchains,verifierReasons:facts?.verifierReasons}};}
  async selectSkills(input:{text:string;limit?:number},handle:HubContext){const request=z.object({text:z.string().min(1).max(4000),limit:z.number().int().min(1).max(8).optional()}).strict().parse(input);
    const result=await this.skills.select(request,await this.skillContext(handle));this.current(handle);return result;}
  async skillGuidance(ids:readonly string[],handle:HubContext,requestText?:string){const result=await this.skills.guidance(z.array(IdSchema).max(3).parse(ids),{...await this.skillContext(handle),...(requestText===undefined?{}:{requestText})});this.current(handle);return result;}
  private skillFence(ids:readonly string[]){
    const fence={global:this.skillGeneration,skills:[...new Set(ids.map(id=>IdSchema.parse(id)))].map(id=>({id,generation:this.skillScopes.get(id)?.generation??0}))};
    this.assertSkillFence(fence);return fence;
  }
  private assertSkillFence(fence:{global:number;skills:{id:string;generation:number}[]}){
    if(this.skillMutations||fence.global!==this.skillGeneration||fence.skills.some(({id,generation})=>{
      const current=this.skillScopes.get(id);return current?.pending||current?.unconfirmed||(current?.generation??0)!==generation;
    }))throw new ExtensionHubError('unavailable');
  }
  /** Host-only task binding; never exposed as an HTTP/model action. */
  async bindSkillExecution(ids:readonly string[],runId:string,handle:HubContext,availableOnly=false):Promise<SkillExecutionBinding[]>{
    const requested=z.array(IdSchema).max(3).parse(ids),fence=this.skillFence(requested);
    const ctx=this.current(handle);if(ctx.authority!=='task'||!ctx.taskId)throw new ExtensionHubError('forbidden');
    const guidance=availableOnly?await this.skills.bindingGuidance(requested,await this.skillContext(handle)):await this.skillGuidance(requested,handle);this.current(handle);
    this.assertSkillFence(fence);
    return guidance.map(skill=>SkillExecutionBindingSchema.parse({taskId:ctx.taskId,runId,sessionEpoch:ctx.privacyEpoch,
      skillId:skill.skillId,version:skill.version,manifestSha256:skill.manifestSha256,requiredChecks:skill.requiredChecks,
      ...('unavailableChecks' in skill&&skill.unavailableChecks?{unavailableChecks:skill.unavailableChecks}:{})}));
  }
  async assertSkillExecution(binding:SkillExecutionBinding,handle:HubContext){
    const ctx=this.current(handle);if(ctx.taskId!==binding.taskId||ctx.privacyEpoch!==binding.sessionEpoch)throw new ExtensionHubError('forbidden');
    const [current]=await this.bindSkillExecution([binding.skillId],binding.runId,handle,!!binding.unavailableChecks?.length);
    if(!current||canonicalJson(current)!==canonicalJson(binding))throw new ExtensionHubError('forbidden','The reviewed skill or its grants changed.');
    this.current(handle);
  }
  skillExecutionSignal(handle:HubContext){return this.current(handle).signal;}
  /** Host lifetime for optional unavailable planning constraints, never request data. */
  skillExecutionEpoch(handle:HubContext){return this.current(handle).privacyEpoch;}
  /** Cheap producer-boundary guard: never enqueue another capability probe into
   * the host operation whose effect is about to dispatch. */
  async guardSkillExecution(bindings:readonly SkillExecutionBinding[],handle:HubContext){
    const fence=this.skillFence(bindings.map(binding=>binding.skillId));
    const ctx=this.current(handle),settings=await this.readSettings();this.current(handle);
    for(const binding of bindings){
      if(ctx.authority!=='task'||ctx.taskId!==binding.taskId||ctx.privacyEpoch!==binding.sessionEpoch)throw new ExtensionHubError('forbidden');
      await this.skills.assertExecutionReview(binding,{now:this.options.clock(),enabled:settings.skills.enabled,privateSession:ctx.privateSession,localOnly:ctx.localOnly});
      this.current(handle);
    }
    this.assertSkillFence(fence);
  }
  async overview(feature:'skills'|'security'|'contacts'|'agents',handle:HubContext):Promise<unknown>{
    const ctx=this.current(handle);if(ctx.authority!=='trusted-ui')throw new ExtensionHubError('forbidden');
    let result:unknown;
    if(feature==='skills')result={skills:(await this.skills.list(await this.skillContext(handle))).slice(0,200)};
    else if(feature==='security')result={profile:this.options.profile,jobs:(await this.options.store.list(hubRecordKinds.security)).map(raw=>this.securityRecord(raw).job).filter(job=>!ctx.privateSession&&(!ctx.taskId||job.taskId===ctx.taskId)).slice(-50)};
    else if(feature==='contacts'){
      if(!this.options.contacts&&!this.options.contactsOverview)throw new ExtensionHubError('unsupported','Contact overview is not supplied by this outbox owner.');
      const scoped=this.makeContacts(handle);
      try{const metadata=!ctx.privateSession&&this.options.contactsOverview?contactsOverview.parse(await this.options.contactsOverview(ctx)):{providers:[],routes:[],rules:[],outbox:[]};
        result=this.options.contacts?{...metadata,outbox:await scoped.reviewOverview(ctx)}:metadata;
      }finally{await scoped.close();}
    }else{
      const catalog=ctx.privateSession?{tasks:[],workspaces:[]}:agentCatalog.parse(await this.options.agents?.catalog?.(ctx)??{tasks:[],workspaces:[]});
      const jobs=ctx.privateSession?[]:(await this.options.store.list(agentJournalKind)).map(raw=>AgentJobSchema.parse(raw.job)).filter(job=>!ctx.taskId||job.taskId===ctx.taskId).slice(-50);
      const grants=ctx.privateSession?[]:(await this.options.store.list(hubRecordKinds.grant)).map(raw=>TaskGrantSchema.parse(raw.grant)).filter(g=>!ctx.taskId||g.taskId===ctx.taskId).slice(-50).map(({taskId,providers,workspaceIds,allowPaid,expiresAt,revoked})=>({taskId,providers,workspaceIds,allowPaid,expiresAt,revoked}));
      result={...catalog,grants,jobs};
    }
    this.current(handle);return structuredClone(result);
  }
  async contactReview(requestId:string,epoch:string,handle:HubContext){
    const ctx=this.current(handle);if(ctx.authority!=='trusted-ui'||ctx.localOnly||!this.options.contacts)throw new ExtensionHubError('unsupported');
    const origin=this.contactScopes.get(requestId);if(!origin)throw new ExtensionHubError('unavailable');this.current(origin);
    const scoped=this.makeContacts(handle);try{const preview=await scoped.reviewDetails(requestId,epoch,ctx);this.current(handle);return preview;}finally{await scoped.close();}
  }
  /** Keep the original task alive while its exact message awaits UI approval.
   * Poll only existing receipts: this never re-enqueues, dispatches or retries. */
  async waitContact(initial:ActionReceipt,handle:HubContext):Promise<ActionReceipt>{
    if(initial.feature!=='contacts'||initial.action!=='send'||initial.outcome!=='pending')return initial;
    const scoped=this.makeContacts(handle),deadline=performance.now()+10*60000;
    try{while(performance.now()<deadline){
      const ctx=this.current(handle);ctx.signal.throwIfAborted();
      const delivery=await scoped.delivery(initial.requestId,ctx);this.current(handle);
      if(!delivery||delivery.state==='pending'){
        await new Promise<void>((resolve,reject)=>{const signal=ctx.signal,onAbort=()=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);reject(new ExtensionHubError('forbidden'));},
          timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},250);signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();});
        continue;
      }
      const base={...initial,id:randomUUID(),observedAt:this.options.clock(),delivery};
      if(['accepted','sent','delivered'].includes(delivery.state))return ActionReceiptSchema.parse({...base,outcome:'completed',effect:'confirmed'});
      if(delivery.state==='rejected')return ActionReceiptSchema.parse({...base,outcome:'rejected',effect:'none',error:{code:'forbidden',message:'Contact delivery was rejected. Review the original draft.',retry:'after-review'}});
      return ActionReceiptSchema.parse({...base,outcome:'unconfirmed',effect:'unknown',error:{code:'unconfirmed',message:'Contact delivery could not be confirmed. Inspect the original outbox.',retry:'read-only-reconcile'}});
    }return initial;}finally{await scoped.close();}
  }
  async agentResult(jobId:string,handle:HubContext):Promise<AgentTaskResult|undefined>{const ctx=this.current(handle);const result=await this.agents?.readResult(jobId,ctx);this.current(handle);return result;}
  async securityResult(jobId:string,handle:HubContext):Promise<SecurityJob|undefined>{
    IdSchema.parse(jobId);const ctx=this.current(handle);
    const result=(await this.options.store.list(hubRecordKinds.security)).map(raw=>this.securityRecord(raw).job).find(job=>job.id===jobId&&job.taskId===ctx.taskId);
    this.current(handle);return result?structuredClone(result):undefined;
  }
  async taskWorkspaces(handle:HubContext):Promise<{id:string;label:string}[]>{
    const ctx=this.current(handle);if(ctx.authority!=='task'||!ctx.taskId||ctx.privateSession||ctx.localOnly||!this.options.agents?.catalog)return [];
    const catalog=agentCatalog.parse(await this.options.agents.catalog(ctx));this.current(handle);
    const workspaces=[];
    for(const workspace of catalog.workspaces){
      const authority=await this.options.agents.resolveAuthority(ctx.taskId,'codex',workspace.id);this.current(handle);
      if(!authority.privateSession&&!authority.localOnly&&authority.parentGrant?.taskId===ctx.taskId&&!authority.parentGrant.revoked&&authority.workspace?.id===workspace.id)workspaces.push(workspace);
    }
    return workspaces;
  }

  private async configure(feature:ExtensionFeature,input:unknown,handle:HubContext){
    const ctx=this.current(handle);if(ctx.authority!=='trusted-ui')throw new ExtensionHubError('forbidden');
    const patch=z.record(z.string(),z.unknown()).parse(input);
    if(feature==='agents'&&patch.codexEnabled===true&&this.options.agents?.connection&&!this.codex?.ready())throw new ExtensionHubError('unavailable','Connect Codex and choose a runtime model first.');
    if(feature==='skills'){this.skillGeneration++;this.skillMutations++;}
    try{
    await serial(this.options.store,'settings',async()=>{const before=await this.readSettings();this.current(handle);
      const settings=ExtensionSettingsSchema.parse({...before,[feature]:configureSchemas[feature].parse({...before[feature],...patch})});
      await this.options.store.put(hubRecordKinds.settings,{id:'main',schemaVersion:1,settings});
      if(canonicalJson(await this.readSettings())!==canonicalJson(settings))throw new ExtensionHubError('unavailable','Settings readback failed.');this.current(handle);
    });
    await this.options.settingsChanged?.(await this.readSettings(),ctx);this.current(handle);
    if(feature==='cursor'&&this.options.cursor){const settings=await this.readSettings();this.current(handle);
      if(!settings.cursor.enabled)await this.options.cursor.controller.stop();
      else {if(!this.cursorDirectory)throw new ExtensionHubError('unavailable');const environment=await this.options.cursor.environment(ctx.signal);this.current(handle);await this.options.cursor.controller.enable(this.cursorDirectory,settings.cursor,environment);}
    }
    }finally{if(feature==='skills'){this.skillMutations--;this.skillGeneration++;}}
  }
  private async grant(input:unknown,handle:HubContext){
    const ctx=this.current(handle);if(ctx.authority!=='trusted-ui'||!ctx.taskId||ctx.privateSession||ctx.localOnly||!this.options.agents)throw new ExtensionHubError('forbidden');
    const value=z.object({providers:z.array(AgentProviderSchema).min(1).max(2),workspaceIds:z.array(IdSchema).min(1).max(32),allowPaid:z.boolean(),expiresInMinutes:z.number().int().min(5).max(1440)}).strict().parse(input);
    let parent:AgentAuthority['parentGrant'];
    for(const provider of value.providers)for(const workspace of value.workspaceIds){const a=await this.options.agents.resolveAuthority(ctx.taskId,provider,workspace);this.current(handle);
      if(a.privateSession||a.localOnly||!a.parentGrant||a.parentGrant.revoked||a.parentGrant.taskId!==ctx.taskId||a.parentGrant.createdAt>this.options.clock()||a.workspace?.id!==workspace||parent&&canonicalJson(parent)!==canonicalJson(a.parentGrant))throw new ExtensionHubError('forbidden');parent=a.parentGrant;}
    const grant=TaskGrantSchema.parse({...parent,expiresAt:this.options.clock()+value.expiresInMinutes*60000,providers:value.providers,workspaceIds:value.workspaceIds,allowPaid:value.allowPaid});
    this.current(handle);await this.options.store.put(hubRecordKinds.grant,{id:ctx.taskId,grant});
    if(canonicalJson(await this.readGrant(ctx.taskId))!==canonicalJson(grant))throw new ExtensionHubError('unavailable');this.current(handle);
  }
  private securityRecord(raw:any):SecurityJournalRecord {
    const record=z.object({job:SecurityJobSchema,intentSha256:Sha256Schema}).strict().parse(raw?.record);return record;
  }
  private async saveSecurity(id:string,value:SecurityJournalRecord){await this.options.store.put(hubRecordKinds.security,{id,record:value});
    const observed=this.securityRecord(await this.options.store.get(hubRecordKinds.security,id));if(canonicalJson(observed)!==canonicalJson(value))throw new ExtensionHubError('unavailable');}
  private securityJournal():SecurityJournal{return {read:async key=>{const raw=await this.options.store.get(hubRecordKinds.security,key.slice('security-request:'.length));return raw?this.securityRecord(raw):undefined;},
    claim:(key,record)=>serial(this.options.store,key,async()=>{const id=record.job.requestId;if(await this.options.store.get(hubRecordKinds.security,id))return false;
      await this.saveSecurity(id,record);
      observeSkillProof('security_job','defender-evidence',{requestId:id,jobId:record.job.id,operation:record.job.operation,intentSha256:record.intentSha256});
      this.securityStarted.get(id)?.(record.job);return true;}),save:(_key,record)=>this.saveSecurity(record.job.requestId,record)};}
  private jobReceipt(action:string,request:ExtensionAction,job:SecurityJob):ActionReceipt {
    const base=this.receipt('security',action,request),evidence=job.evidence.at(-1),pending=['pending','running'].includes(job.state);
    if(pending)return {...base,outcome:'pending',effect:'queued',jobId:job.id};
    if(job.state==='completed'&&evidence&&evidence.jobId===job.id)return {...base,effect:action==='health'||action==='inspect'?'none':'confirmed',jobId:job.id};
    if(job.state==='cancelled')return {...base,outcome:'cancelled',effect:'none',jobId:job.id,error:{code:'cancelled',message:'Monitoring stopped before dispatch.',retry:'never'}};
    return {...this.receipt('security',action,request,'unconfirmed',true),jobId:job.id};
  }
  private securityAction(action:string,request:ExtensionAction,handle:HubContext):Promise<ActionReceipt>{
    return serial(this.options.store,'security-dispatch:'+request.requestId,()=>this.runSecurityAction(action,request,handle));
  }
  private async runSecurityAction(action:string,request:ExtensionAction,handle:HubContext):Promise<ActionReceipt>{
    const ctx=this.current(handle);if(!this.security||!this.options.security)return this.receipt('security',action,request,'unconfigured');
    if(action==='inspect'||action==='cancel'){
      const {jobId}=keyInput.parse(request.input),row=(await this.options.store.list(hubRecordKinds.security)).map(raw=>this.securityRecord(raw)).find(row=>row.job.id===jobId);this.current(handle);
      if(!row||ctx.authority==='task'&&row.job.taskId!==ctx.taskId)return this.receipt('security',action,request,'forbidden');
      if(action==='cancel'){const active=this.securityActive.get(row.job.requestId);if(!active)return this.receipt('security',action,request,'conflict');active.controller.abort();return this.jobReceipt(action,request,await active.done);}
      return this.jobReceipt(action,request,row.job);
    }
    const operation=action==='health'?'status':action;
    if(!['status','quick-scan','full-scan','custom-scan','update-signatures'].includes(operation))return this.receipt('security',action,request,'unsupported');
    const target=action==='custom-scan'?z.object({target:z.string().min(1).max(4096)}).strict().parse(request.input).target:(empty.parse(request.input),undefined);
    const settings=await this.readSettings();this.current(handle);
    if(!settings.security.enabled||!await this.options.security.authorize(operation as SecurityJob['operation'],target,ctx))return this.receipt('security',action,request,'forbidden');this.current(handle);
    const digest=sha256(canonicalJson({taskId:ctx.taskId??'trusted-ui-security',operation,target:target??null})),prior=this.securityActive.get(request.requestId);
    if(prior)return prior.digest!==digest?this.receipt('security',action,request,'conflict'):this.jobReceipt(action,request,prior.job??await prior.done);
    const controller=new AbortController(),signal=AbortSignal.any([ctx.signal,controller.signal]);let claimed!:(job:SecurityJob)=>void;
    const started=new Promise<SecurityJob>(resolve=>{claimed=resolve;});this.securityStarted.set(request.requestId,claimed);
    this.securityScopes.set(request.requestId,handle);
    const done=this.security.run({taskId:ctx.taskId??'trusted-ui-security',requestId:request.requestId,operation:operation as SecurityJob['operation'],...(target?{target}: {})},signal);
    const active={controller,done,digest,handle,job:undefined as SecurityJob|undefined};this.securityActive.set(request.requestId,active);
    void done.catch(()=>{}).finally(()=>{if(this.securityActive.get(request.requestId)===active){this.securityActive.delete(request.requestId);this.securityScopes.delete(request.requestId);this.securityStarted.delete(request.requestId);this.scheduledSecurity.delete(request.requestId);}});
    const job=await Promise.race([started,done]);active.job=job;this.current(handle);return this.jobReceipt(action,request,job);
  }
  private validInput(feature:ExtensionFeature,action:string,input:Record<string,unknown>):boolean {
    if(action==='configure'){configureSchemas[feature].parse({...defaultExtensionSettings()[feature],...input});return true;}
    if(feature==='agents'){
      if(action==='start')z.object({provider:AgentProviderSchema,workspaceId:IdSchema,prompt:z.string().min(1).max(12000)}).strict().parse(input);
      else if(action==='inspect'||action==='cancel')keyInput.parse(input);
      else if(action==='stage-workspace')z.object({folder:z.string().min(1).max(4096)}).strict().parse(input);
      else if(action==='connect-codex'||action==='inspect-codex')empty.parse(input);
      else if(action==='cancel-codex')z.object({sessionId:IdSchema}).strict().parse(input);
      else if(action==='select-codex-model')z.object({model:z.string().min(1).max(100)}).strict().parse(input);
      else if(action!=='grant')return false;
      return true;
    }
    if(feature==='contacts')return action==='send'||action==='approve'&&!!this.options.contacts; // exact validation stays in the single outbox facade
    if(feature==='assets'){if(action==='import')z.object({folder:z.string().min(1).max(4096)}).strict().parse(input);else return false;return true;}
    if(feature==='cursor'){if(action==='restore')empty.parse(input);else if(action==='import')z.object({folder:z.string().min(3).max(4096)}).strict().parse(input);else return false;return true;}
    if(feature==='skills'){
      if(action==='draft'||action==='update-draft')SkillDraftInputSchema.parse(input);
      else if(action==='list')empty.parse(input);
      else if(action==='review')z.object({skillId:IdSchema,manifestSha256:Sha256Schema}).strict().parse(input);
      else if(['revoke','save-draft','discard-draft'].includes(action))z.object({skillId:IdSchema}).strict().parse(input);
      else return false;return true;
    }
    if(feature==='security'){
      if(action==='inspect'||action==='cancel')keyInput.parse(input);
      else if(action==='custom-scan')validateSecurityTarget(z.object({target:z.string().min(1).max(4096)}).strict().parse(input).target);
      else if(['health','quick-scan','full-scan','update-signatures'].includes(action))empty.parse(input);
      else return false;return true;
    }
    if(feature==='updates'){if(action==='stage')z.object({version:ReleaseVersionSchema}).strict().parse(input);else if(action==='check'||action==='rollback')empty.parse(input);else return false;return true;}
    return false;
  }
  private async delegated(feature:ExtensionFeature,action:string,request:ExtensionAction,handle:HubContext,work:()=>Promise<ActionReceipt>){
    try{const receipt=ActionReceiptSchema.parse(await work());this.current(handle);
      if(receipt.feature!==feature||receipt.action!==action||receipt.requestId!==request.requestId)throw new ExtensionHubError('unavailable');return receipt;
    }catch{return this.receipt(feature,action,request,'unconfirmed',true);}
  }
  async dispatch(feature:ExtensionFeature,action:string,input:unknown,handle:HubContext):Promise<ActionReceipt>{
    FeatureSchema.parse(feature);IdSchema.parse(action);const request=ExtensionActionSchema.parse(structuredClone(input));let ctx:ExtensionActionContext;
    try{ctx=this.current(handle);}catch{return this.receipt(feature,action,request,'forbidden');}
    if(request.taskId!==ctx.taskId||ctx.authority==='task'&&!ctx.taskId)return this.receipt(feature,action,request,'forbidden');
    if(action==='configure'&&ctx.authority!=='trusted-ui'||['cursor','skills','updates','assets'].includes(feature)&&ctx.authority!=='trusted-ui'&&!(feature==='skills'&&action==='list')||feature==='agents'&&action==='stage-workspace'&&ctx.authority!=='trusted-ui')return this.receipt(feature,action,request,'forbidden');
    if((['agents','updates'].includes(feature)&&(ctx.privateSession||ctx.localOnly)||feature==='contacts'&&(ctx.localOnly||ctx.privateSession&&!this.options.contacts))&&action!=='configure')return this.receipt(feature,action,request,'forbidden');
    try{if(!this.validInput(feature,action,request.input))return this.receipt(feature,action,request,'unsupported');}catch{return this.receipt(feature,action,request,'invalid-request');}
    // Existing agents/contact/security journals own their complete effect and
    // request ID. Hub never replays them or creates a second delivery queue.
    if(feature==='agents'&&['start','inspect','cancel'].includes(action))return this.agents?this.delegated(feature,action,request,handle,()=>this.agents!.action(action,request,ctx)):this.receipt(feature,action,request,'unconfigured');
    if(feature==='contacts'&&(action==='send'||action==='approve'))return this.delegated(feature,action,request,handle,async()=>{
      if(action==='send'&&!this.contactScopes.has(request.requestId)){
        if(this.contactScopes.size>=10000)return this.receipt(feature,action,request,'unavailable');this.contactScopes.set(request.requestId,handle);
      }
      const scoped=this.makeContacts(handle);try{return await scoped.action(action,request,ctx);}finally{await scoped.close();}
    });
    if(feature==='security'&&action!=='configure')return this.delegated(feature,action,request,handle,()=>this.securityAction(action,request,handle));
    const digest=sha256(canonicalJson({feature,action,request,authority:ctx.authority})),privateKey=this.contexts.get(handle)!.initial.privacyEpoch+':'+request.requestId;
    return serial(this.options.store,feature+':'+request.requestId,async()=>{
      const prior=ctx.privateSession?this.privateRequests.get(privateKey):await this.options.store.get(hubRecordKinds.request,feature+':'+request.requestId);
      if(prior){const value=requestRecord.parse(stripStoreFields(prior));if(value.digest!==digest)return this.receipt(feature,action,request,'conflict');
        if(value.feature!==feature||value.action!==action||value.receipt.feature!==feature||value.receipt.action!==action||value.receipt.requestId!==request.requestId)throw new ExtensionHubError('unavailable');
        return value.final?value.receipt:this.receipt(feature,action,request,'unconfirmed',true);}
      try{this.current(handle);}catch{return this.receipt(feature,action,request,'cancelled',true);}
      const record:z.infer<typeof requestRecord>={id:feature+':'+request.requestId,digest,feature,action,receipt:{...this.receipt(feature,action,request),outcome:'pending',effect:'queued'},final:false};
      const persist=async()=>{if(ctx.privateSession)this.privateRequests.set(privateKey,structuredClone(record));else{await this.options.store.put(hubRecordKinds.request,record);const observed=await this.options.store.get(hubRecordKinds.request,record.id);if(canonicalJson(requestRecord.parse(stripStoreFields(observed)))!==canonicalJson(record))throw new ExtensionHubError('unavailable');}};
      try{await persist();this.current(handle);let receipt:ActionReceipt;
        if(action==='configure'){await this.configure(feature,request.input,handle);receipt=this.receipt(feature,action,request);}
        else if(feature==='cursor'){
          if(!this.options.cursor)receipt=this.receipt(feature,action,request,'unconfigured');
          else if(action==='restore'){empty.parse(request.input);const state=await this.options.cursor.controller.stop();receipt=this.receipt(feature,action,request,state.state==='recovery-required'?'unconfirmed':undefined,state.state==='recovery-required');}
          else if(action==='import'){const value=z.object({folder:z.string().min(3).max(4096)}).strict().parse(request.input);const pack=await this.options.cursor.cache.importFolder(value.folder);this.current(handle);this.cursorDirectory=pack.directory;receipt=this.receipt(feature,action,request);}
          else receipt=this.receipt(feature,action,request,'unsupported');
        }else if(feature==='skills')receipt=await this.skillAction(action,request,handle);
        else if(feature==='assets'&&action==='import'&&this.options.importAssets){const settings=await this.readSettings();this.current(handle);await this.options.importAssets(String(request.input.folder),settings.assets,ctx);receipt=this.receipt(feature,action,request);}
        else if(feature==='agents'&&['connect-codex','inspect-codex','cancel-codex','select-codex-model'].includes(action))receipt=await this.codexAction(action,request,handle);
        else if(feature==='agents'&&action==='stage-workspace'&&this.options.agents?.stageWorkspace){await this.options.agents.stageWorkspace(String(request.input.folder),ctx);receipt=this.receipt(feature,action,request);}
        else if(feature==='agents'&&action==='grant'){await this.grant(request.input,handle);receipt=this.receipt(feature,action,request);}
        else if(feature==='updates'&&this.options.updates)receipt=await this.options.updates.action(action,request,ctx);
        else receipt=this.receipt(feature,action,request,'unsupported');
        this.current(handle);record.receipt=ActionReceiptSchema.parse(receipt);
        if(record.receipt.feature!==feature||record.receipt.action!==action||record.receipt.requestId!==request.requestId)throw new ExtensionHubError('unavailable');
        record.final=true;await persist();return record.receipt;
      }catch{record.receipt=this.receipt(feature,action,request,'unconfirmed',true);record.final=true;try{await persist();}catch{}return record.receipt;}
    }).catch(()=>this.receipt(feature,action,request,'unconfirmed',true));
  }
  private async skillAction(action:string,request:ExtensionAction,handle:HubContext):Promise<ActionReceipt>{
    const ctx=this.current(handle);let result:SkillMutation|{ok:true}|undefined;
    if(action==='list'){empty.parse(request.input);await this.skills.list(await this.skillContext(handle));return {...this.receipt('skills',action,request),effect:'none'};}
    let skillId:string,mutate:()=>Promise<SkillMutation|{ok:true}>;
    if(action==='draft'||action==='update-draft'){const value=SkillDraftInputSchema.parse(request.input);skillId=value.id;
      mutate=()=>action==='draft'?this.skills.createDraft(value,ctx):this.skills.updateDraft(value,ctx);}
    else if(action==='review'){const value=z.object({skillId:IdSchema,manifestSha256:Sha256Schema}).strict().parse(request.input);skillId=value.skillId;mutate=()=>this.skills.review(skillId,value,ctx);}
    else if(['revoke','save-draft','discard-draft'].includes(action)){({skillId}=z.object({skillId:IdSchema}).strict().parse(request.input));
      mutate=()=>action==='revoke'?this.skills.revoke(skillId,ctx):action==='save-draft'?this.skills.saveDraft(skillId,ctx):this.skills.discardDraft(skillId,ctx);}
    else return this.receipt('skills',action,request,'unsupported');
    const scope=this.skillScopes.get(skillId)??{generation:0,pending:0,unconfirmed:false};this.skillScopes.set(skillId,scope);scope.generation++;scope.pending++;
    try{
    result=await mutate();
    if(!result.ok&&(result.reason==='cancelled'||result.reason==='closed'))return {...this.receipt('skills',action,request),outcome:'cancelled',effect:'none',error:{code:'cancelled',message:'The skill session ended.',retry:'never'}};
    return result.ok?this.receipt('skills',action,request):this.receipt('skills',action,request,result.reason==='unconfirmed'?'unconfirmed':result.reason==='conflict'?'conflict':result.reason==='forbidden'?'forbidden':'invalid-request',result.reason==='unconfirmed');
    }finally{
      scope.pending--;scope.generation++;
      // An uncertain same-skill write needs an explicit trusted review/readback.
      // Never clear its fence just because an unrelated operation has settled.
      if(!result||!result.ok&&result.reason==='unconfirmed')scope.unconfirmed=true;
      else if(result.ok&&!scope.pending&&(action==='review'||action==='revoke'))scope.unconfirmed=false;
    }
  }
  async tickSecurity(handle:HubContext):Promise<string>{
    const ctx=this.current(handle);if(this.options.profile!=='user')return 'non-user-profile';
    if(!this.scheduler||!this.options.security?.scheduleContext||ctx.privateSession)return 'unavailable';
    const observed=await this.options.security.scheduleContext(ctx.signal);this.current(handle);
    const settings=await this.readSettings();this.current(handle);
    return this.scheduler.tick({...observed,profile:this.options.profile,settings:settings.security},async({occurrence})=>{
      this.current(handle);const request={requestId:'scheduled-security:'+occurrence,...(ctx.taskId?{taskId:ctx.taskId}:{}),input:{}};
      this.scheduledSecurity.add(request.requestId);
      try{
        if(!await this.scheduleReady(handle))throw new ExtensionHubError('unavailable');
        const receipt=await this.securityAction('quick-scan',request,handle);if(receipt.outcome!=='pending'&&receipt.outcome!=='completed')throw new ExtensionHubError('unavailable');
      }finally{if(!this.securityActive.has(request.requestId))this.scheduledSecurity.delete(request.requestId);}
    });
  }
  private async scheduleReady(handle:HubContext):Promise<boolean>{
    const ctx=this.current(handle);if(this.options.profile!=='user'||!this.options.security?.scheduleContext||ctx.privateSession)return false;
    const observed=await this.options.security.scheduleContext(ctx.signal);this.current(handle);
    const settings=await this.readSettings();this.current(handle);
    const hour=new Date(this.options.clock()).getHours();
    return this.options.profile==='user'&&settings.security.enabled&&settings.security.dailyQuickScan&&hour>=9&&hour<21&&
      observed.hostAvailable===true&&observed.active===false&&observed.gameDocked===false&&observed.quiet===false;
  }
  stop():Promise<HubStopReport>{
    if(this.stopping)return this.stopping;this.stopGeneration++;this.privacyBoundary();for(const active of this.securityActive.values())active.controller.abort();this.security?.stop();
    return this.stopping=(async()=>{const report:HubStopReport={agents:[],errors:[]},oldAgents=this.agents,oldContacts=this.contacts;
      const securitySettlements=Promise.allSettled([...this.securityActive.values()].map(active=>active.done));
      const results=await Promise.allSettled([this.options.cursor?.controller.stop(),oldAgents?.close(),oldContacts.close(),this.codex?.close(),this.options.updates?.stop?.()]);
      if(results[0].status==='fulfilled')report.cursor=results[0].value;else report.errors.push('cursor');
      if(results[1].status==='rejected')report.errors.push('agents');if(results[2].status==='rejected')report.errors.push('contacts');
      if(results[3].status==='rejected')report.errors.push('agents');
      if(results[4].status==='rejected')report.errors.push('updates');
      if((await securitySettlements).some(result=>result.status==='rejected'))report.errors.push('security');
      if(oldAgents)try{report.agents=await oldAgents.recover();}catch{report.errors.push('agents');}
      if(!this.closed){try{this.agents=this.makeAgents();this.contacts=this.makeContacts();await this.agents?.recover();}catch{this.agents=undefined;report.errors.push('agents');}}
      return report;
    })().finally(()=>{this.stopping=undefined;});
  }
  close():Promise<void>{if(this.closing)return this.closing;this.closed=true;return this.closing=(async()=>{await this.stop();await this.skills.close();await this.options.updates?.close();})();}
}
export const createExtensionHub=async(options:ExtensionHubOptions)=>new ExtensionHub(options).initialize();
