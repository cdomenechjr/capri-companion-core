import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,execFile,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {z} from 'zod';
import type {Options,Query} from '@anthropic-ai/claude-agent-sdk';
import type {TaskPermission} from '../agency';
import {ActionReceiptSchema,AgentJobSchema,AgentProviderSchema,ExtensionActionSchema,IdSchema,CodexModelSchema,CodexConnectionSchema,type CodexConnection,
  type AgentJob,type AgentProvider,type ExtensionSettings,type TaskGrant,
  type ExtensionAction,type ExtensionActionContext,type ExtensionDependencies,type ExtensionFeatureStatus,
  type ExtensionModule,type ActionReceipt} from './contracts';
import {agentPolicy,canonicalJson,featureCapability,sha256} from './policy';
import {AgentLeasePool,AgentLeaseJournal,agentLeaseDigest,ensureAgentLeaseDirectory,sharedAgentLeases,stopAgentProcess,AgentStopUnconfirmed,type AgentNativeLeaseClaim,type AgentLeaseInspector,type AgentLeaseRecovery,type AgentLeaseRecord} from './agent-lease';
import {prepareSupervisedLaunch,armSupervisedRun,inspectSupervisedRun,cancelSupervisedRun,type SupervisorIdentity} from './supervisor';

const StartSchema=z.object({provider:AgentProviderSchema,workspaceId:IdSchema,prompt:z.string().min(1).max(12000)}).strict();
const JobInputSchema=z.object({jobId:IdSchema}).strict();
type Start=z.infer<typeof StartSchema>;
export const agentJournalKind='extension:agents:request';
export const agentResultKind='extension:agents:result';
const maxReportText=32768;
const ProviderReportSchema=z.object({
  source:z.discriminatedUnion('provider',[
    z.object({provider:z.literal('codex'),threadId:IdSchema,turnId:IdSchema,itemIds:z.array(IdSchema).max(64)}).strict(),
    z.object({provider:z.literal('claude-api'),sessionId:IdSchema}).strict()
  ]),text:z.string().max(maxReportText),truncated:z.boolean()
}).strict();
export type AgentProviderReport=z.infer<typeof ProviderReportSchema>;
const FileChangeSchema=z.object({path:z.string().min(1).max(4096),kind:z.enum(['added','modified','deleted']),
  beforeSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),afterSha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
const TaskResultSchema=z.object({schemaVersion:z.literal(1),id:IdSchema,jobId:IdSchema,taskId:IdSchema,requestId:IdSchema,
  provider:AgentProviderSchema,workspaceId:IdSchema,scopeSha256:z.string().regex(/^[a-f0-9]{64}$/),observedAt:z.number().int().nonnegative(),
  state:z.enum(['completed','unconfirmed']),untrusted:z.literal(true),verification:z.literal('unverified'),
  report:z.object({source:ProviderReportSchema.shape.source,format:z.literal('html-escaped-text'),text:z.string().max(maxReportText*6),truncated:z.boolean()}).strict().optional(),
  changedFiles:z.array(FileChangeSchema).max(1000),changesObserved:z.boolean(),changesTruncated:z.boolean(),
  limitations:z.array(z.enum(['task-verification-required','shell-and-build-unavailable','file-observation-unavailable','file-list-truncated','final-report-unavailable'])).max(5)
});
/** Untrusted display data, never permissions, verification, activity, speech or notifications.
 * Stored through Capri's encrypted Store. Paths are relative routing data; escape on display.
 */
export type AgentTaskResult=z.infer<typeof TaskResultSchema>;
const escapeText=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export interface AgentWorkspace {id:string;root:string;writable:boolean;/** Include Capri source, profiles and all secret roots. */excludedRoots:readonly string[]}
export type AgentConfiguration=
  | {provider:'codex';executable:string;model?:string;/** Operator-provisioned CLI home; never the user's general configuration. */configDir:string;isolated:true}
  | {provider:'claude-api';apiKey:string;budgetUsd:number;model:string;configDir:string;isolated:true};
export function codexExecutableConfiguration(executable:string,configDir:string,previous?:Extract<AgentConfiguration,{provider:'codex'}>):Extract<AgentConfiguration,{provider:'codex'}>{
  if(!path.isAbsolute(executable)||!path.isAbsolute(configDir)||previous&&(!previous.isolated||!path.isAbsolute(previous.configDir)))throw Error('Isolated runtime configuration required');
  return {provider:'codex',executable,configDir:previous?.configDir??configDir,isolated:true,...(previous?.model?{model:CodexModelSchema.parse(previous.model)}:{})};
}
function sameConfiguration(a:AgentConfiguration|undefined,b:AgentConfiguration|undefined):boolean {
  if(!a||!b||a.provider!==b.provider||a.configDir!==b.configDir||a.isolated!==b.isolated||a.model!==b.model)return false;
  return a.provider==='codex'&&b.provider==='codex'?a.executable===b.executable:
    a.provider==='claude-api'&&b.provider==='claude-api'&&a.apiKey===b.apiKey&&a.budgetUsd===b.budgetUsd;
}
/** Resolve from live server-owned task/settings/TaskAccess state. No request fields create authority. */
export interface AgentAuthority {
  settings:ExtensionSettings;localOnly:boolean;privateSession:boolean;grant?:TaskGrant;parentGrant?:TaskPermission;
  workspace?:AgentWorkspace;configuration?:AgentConfiguration;
}
export interface AgentApproval {
  jobId:string;taskId:string;provider:AgentProvider;tool:string;input:Readonly<Record<string,unknown>>;signal:AbortSignal;
}
export interface RuntimeAgentDependencies extends ExtensionDependencies {
  resolveAuthority(taskId:string,provider:AgentProvider,workspaceId:string):Promise<AgentAuthority>;
  /** Separate authenticated UI, exact request binding; default denial. Input is untrusted data. */
  approveTool?(request:AgentApproval):Promise<boolean>;
  /** Only fixed summaries leave this module; never route these events to speech. */
  onActivity?(job:Readonly<AgentJob>):void;
  leases?:AgentLeasePool;
  /** Trusted native supervisor/operator proof of the entire token-owned tree's exit.
   * Never implement as !isAlive(record.pid): that PID identifies the creating host,
   * while the separately pinned supervisor identity identifies the native guardian.
   * No inspector leaves a visible recovery-required report; no inference is replayed.
   */
  inspectLeaseStopped?:AgentLeaseInspector;
  /** Trusted factory recovery includes native orphan claims without a Store row. */
  recoverLeases?():Promise<AgentLeaseRecovery[]>;
  drivers?:Partial<Record<AgentProvider,AgentDriver>>;
  /** Trusted read-only provider probe; never an inference turn or settings mutation. */
  providerStatus?():Promise<Array<{provider:AgentProvider;enabled:boolean;configured:boolean;ready:boolean}>>;
  /** Host connection evidence gates only NEW jobs; existing journals/results remain inspectable. */
  canStart?(provider:AgentProvider):boolean;
  timeoutMs?:number;
}
const DriverResultSchema=z.object({state:z.enum(['completed','unconfirmed']),reason:z.enum(['quota','authentication','provider-error','permission-denied']).optional(),report:ProviderReportSchema.optional()}).strict();
export type AgentResult=z.infer<typeof DriverResultSchema>;
export interface AgentDriverContext {
  configuration:AgentConfiguration;workspace:AgentWorkspace;prompt:string;signal:AbortSignal;
  /** Host routing identity for a native supervisor's durable process-tree ledger.
   * Injected drivers may associate their owned child/job with this token BEFORE
   * starting it. This is never model authority or proof that the tree stopped.
   */
  leaseToken?:string;
  /** Complete host claim, never reconstructed from a token or provider event. */
  leaseRecord?:AgentLeaseRecord;
  /** Durable Store readback, awaited by the native arming gate before ACK. */
  pinOwnership?(identity:SupervisorIdentity):Promise<void>;
  /** Must be awaited immediately before the first inference dispatch. */
  beforeDispatch():Promise<void>;
  approve(tool:string,input:Record<string,unknown>):Promise<boolean>;
  event(state:'running'|'needs-approval'):void;
}
/** Host-only contract, supplied with an owned launch implementation, never from
 * provider readiness/model input. stop must control the exact token-owned tree;
 * inspectStopped must independently prove that whole tree has exited.
 * Direct protocol adapters omit this; the trusted native factory supplies it.
 */
export interface AgentOwnedLifecycle {
  stop(record:AgentLeaseRecord,provider:AgentProvider):Promise<void>;
  inspectStopped:AgentLeaseInspector;
  available?():boolean;
  claim?(input:{provider:AgentProvider;jobId:string;workspace:AgentWorkspace;signal:AbortSignal}):Promise<AgentNativeLeaseClaim>;
  register?(record:AgentLeaseRecord,provider:AgentProvider):void;
}
export interface CodexSetup {
  mode:'connect'|'inspect';open(url:string):Promise<void>;
  observed(authenticated:boolean,models:string[]):void;
}
export interface AgentDriver {readonly ownedLifecycle?:AgentOwnedLifecycle;run(context:AgentDriverContext):Promise<AgentResult>;
  /** Trusted settings composition only. Never called by an agent job. */
  setup?(context:AgentDriverContext,setup:CodexSetup):Promise<AgentResult>}
const lifecycleAvailable=(driver:AgentDriver|undefined):driver is AgentDriver&{ownedLifecycle:AgentOwnedLifecycle}=>
  typeof driver?.ownedLifecycle?.stop==='function'&&typeof driver.ownedLifecycle.inspectStopped==='function'&&driver.ownedLifecycle.available?.()!==false;
export class AgentNeedsSupervision extends Error {constructor(){super('Runtime delegation needs owned native process supervision.');this.name='AgentNeedsSupervision';}}

const inside=(root:string,value:string)=>{const rel=path.relative(root,value);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
const samePath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const excludedName=/(^\.env(?:\.|$)|^\.(?:codex|claude|agents|aws|ssh|git)$|^\.mcp\.json$|^(?:credentials|secrets)(?:\.|$)|\.(?:pem|key|pfx|p12)$)/i;
function cleanPath(value:string):string {
  if(!path.isAbsolute(value)||(/[\x00-\x1f<>"|?*]/.test(value))||value.startsWith('\\\\')||value.startsWith('//'))throw Error('Invalid workspace path');
  if(process.platform==='win32'&&value.slice(2).includes(':'))throw Error('Alternate path stream');
  if(process.platform==='win32'&&value.slice(3).split(/[\\/]/).some(p=>/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('Noncanonical Windows path');
  return path.resolve(value);
}
function noAliases(value:string):void {
  const absolute=cleanPath(value),parsed=path.parse(absolute);let current=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Workspace alias denied');
  }
  if(fs.existsSync(absolute)&&!samePath(fs.realpathSync.native(absolute),absolute))throw Error('Noncanonical workspace');
}
/** Conservative dedicated-workspace policy: reject junctions/symlinks, hardlinks,
 * secret files/config and overlaps with host exclusions, including nested aliases.
 * Rechecked before dispatch and each approval; this never reads file contents.
 */
export function validateAgentWorkspace(workspace:AgentWorkspace):string {
  const root=cleanPath(workspace.root);noAliases(root);
  if(root.slice(path.parse(root).root.length).split(path.sep).some(part=>excludedName.test(part)))throw Error('Excluded workspace');
  if(!workspace.excludedRoots.length||!fs.statSync(root).isDirectory()||root===path.parse(root).root)throw Error('Dedicated workspace required');
  for(const excluded of workspace.excludedRoots){
    const resolved=cleanPath(excluded);noAliases(resolved);
    if(inside(root,resolved)||inside(resolved,root))throw Error('Excluded workspace');
  }
  let entries=0;
  function walk(directory:string,depth:number):void {
    if(depth>40)throw Error('Workspace too deep');
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      if(++entries>20000||excludedName.test(entry.name))throw Error('Workspace contains excluded content');
      const file=path.join(directory,entry.name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||(stat.isFile()&&stat.nlink>1))throw Error('Workspace alias denied');
      if(stat.isDirectory())walk(file,depth+1);
    }
  }
  walk(root,0);return root;
}
function scopedTool(workspace:AgentWorkspace,tool:string,input:Record<string,unknown>):boolean {
  try{
    const root=validateAgentWorkspace(workspace);
    if(!['Read','Glob','Grep','Edit','Write'].includes(tool)||(['Edit','Write'].includes(tool)&&!workspace.writable))return false;
    if(tool==='Glob'||tool==='Grep'){
      const glob=tool==='Glob'?input.pattern:input.glob;
      if(glob!==undefined&&(typeof glob!=='string'||path.isAbsolute(glob)||glob.includes(':')||glob.split(/[\\/]/).some(p=>p==='..'||excludedName.test(p))))return false;
    }
    const value=input.file_path??input.path??root;
    if(typeof value!=='string')return false;
    const target=path.isAbsolute(value)?cleanPath(value):path.resolve(root,value);
    if(!inside(root,target))return false;
    noAliases(target);
    if(path.relative(root,target).split(path.sep).some(p=>excludedName.test(p)))return false;
    if(fs.existsSync(target)&&fs.statSync(target).isFile()&&fs.statSync(target).nlink>1)return false;
    return !(['Read','Edit','Write'].includes(tool)&&typeof input.file_path!=='string');
  }catch{return false;}
}
async function nextUntilAbort<T>(iterator:AsyncIterator<T>,signal:AbortSignal):Promise<IteratorResult<T>|undefined>{
  if(signal.aborted)return undefined;
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);resolve(undefined);};
    signal.addEventListener('abort',abort,{once:true});
    void iterator.next().then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
function setupUntilAbort<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(Error('Codex setup cancelled'));};
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    void work.then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(Error('Codex setup cancelled'));else resolve(value);},()=>{signal.removeEventListener('abort',abort);reject(Error('Codex setup unavailable'));});
  });
}
/** Allowlist, not a copy of process.env: no tokens, proxy overrides, hooks or NODE_OPTIONS. */
export function agentEnvironment(configDir:string):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={};
  for(const [key,value] of Object.entries(process.env))if(/^(?:path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all)$/i.test(key))env[key]=value;
  return {...env,HOME:configDir,USERPROFILE:configDir,NO_COLOR:'1',ENABLE_CLAUDEAI_MCP_SERVERS:'false'};
}

type RpcObject=Record<string,any>;
const object=(v:unknown):v is RpcObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
export type AgentSpawn=(command:string,args:string[],options:Parameters<typeof spawn>[2])=>ChildProcessWithoutNullStreams;
/** JSON-RPC stdio without Content-Length framing, as documented by Codex app-server.
 * Source reference: https://developers.openai.com/codex/app-server (independent implementation).
 */
class CodexRpc {
  private sequence=0;private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  private buffer='';private decoder=new StringDecoder('utf8');private failed?:Error;
  onEvent:(message:RpcObject)=>void=()=>{};
  onRequest:(message:RpcObject)=>Promise<unknown>=async()=>{throw Error('Unsupported request');};
  constructor(readonly child:ChildProcessWithoutNullStreams){
    child.stdout.on('data',(chunk:Buffer)=>{
      this.buffer+=this.decoder.write(chunk);
      if(this.buffer.length>2_000_000){this.fail(Error('Protocol limit'));return;}
      let newline:number;
      while((newline=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);if(!line.trim())continue;
        try{this.receive(JSON.parse(line));}catch{this.fail(Error('Invalid provider protocol'));}}
    });
    child.stderr.on('data',()=>{}); // Never expose arbitrary provider errors or credentials.
    child.stdin.on('error',()=>this.fail(Error('Provider connection lost')));
    child.on('error',()=>this.fail(Error('Provider unavailable')));
    child.on('close',()=>this.fail(Error('Provider connection lost')));
  }
  private fail(error:Error){this.failed=error;for(const p of this.pending.values())p.reject(error);this.pending.clear();this.onEvent({method:'connection/lost'});}
  cancel(){this.fail(Error('Task stopped'));}
  private receive(message:unknown){
    if(!object(message))throw Error('Invalid message');
    if(typeof message.method==='string'){
      if(message.id!==undefined){
        if(typeof message.id!=='string'&&typeof message.id!=='number')throw Error('Invalid request');
        void this.onRequest(message).then(result=>this.send({id:message.id,result}),()=>this.send({id:message.id,error:{code:-32601,message:'Request denied by application'}})).catch(()=>{});
      }else this.onEvent(message);
    }else if(typeof message.id==='number'){
      const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);
      if(message.error)pending.reject(Error('Provider request failed'));else pending.resolve(message.result);
    }
  }
  send(message:RpcObject){if(this.failed)throw this.failed;this.child.stdin.write(JSON.stringify(message)+'\n');}
  request(method:string,params:unknown):Promise<any>{
    if(this.failed)return Promise.reject(this.failed);
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});try{this.send({id,method,params});}catch{this.pending.delete(id);reject(Error('Provider connection lost'));}});
  }
}
const codexArguments=(root:string)=>['app-server','--listen','stdio://','-c','mcp_servers={}','-c','notify=[]','-c','features.hooks=false','-c','features.multi_agent=false','-c','features.plugins=false','-c','features.memories=false','-c','features.goals=false','-c','features.shell_snapshot=false','-c','features.skill_mcp_dependency_install=false','-c','projects.'+JSON.stringify(root)+'.trust_level="untrusted"','-c','web_search="disabled"','-c','cli_auth_credentials_store="file"','-c','forced_login_method="chatgpt"'];
/** Exact official origins, no userinfo/ports/fragments/control characters. The
 * ephemeral URL goes only to the host browser opener, never UI/events/Store. */
export function officialCodexLoginUrl(value:unknown):string {
  if(typeof value!=='string'||value.length>8192||/[\s\x00-\x1f\x7f\\]/.test(value))throw Error('Invalid official sign-in URL');
  const url=new URL(value);
  if(url.protocol!=='https:'||!['auth.openai.com','auth0.openai.com','chatgpt.com'].includes(url.hostname)||url.username||url.password||url.port||url.hash)throw Error('Invalid official sign-in URL');
  return url.href;
}
/** Supported managed login only; this transport cannot start an inference turn. */
async function codexSetup(context:AgentDriverContext,setup:CodexSetup,spawnProcess:AgentSpawn,stopProcess:(child:ChildProcessWithoutNullStreams)=>Promise<void>):Promise<AgentResult>{
  const c=context.configuration;if(c.provider!=='codex'||context.signal.aborted)throw Error('Setup unavailable');
  const child=spawnProcess(c.executable,codexArguments(context.workspace.root),{cwd:context.workspace.root,env:{...agentEnvironment(c.configDir),CODEX_HOME:c.configDir},windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  const rpc=new CodexRpc(child);let loginId:string|undefined,settled=false,completed=false,cancelSent=false;
  let resolveLogin!:()=>void,rejectLogin!:(error:Error)=>void;
  const login=new Promise<void>((resolve,reject)=>{resolveLogin=resolve;rejectLogin=reject;});void login.catch(()=>{});
  const early:RpcObject[]=[];
  const event=(message:RpcObject)=>{
    if(settled||context.signal.aborted)return;
    if(message.method==='connection/lost'){rejectLogin(Error('Setup connection lost'));return;}
    if(message.method!=='account/login/completed')return;
    if(!loginId){if(early.length>=4){rpc.cancel();return;}early.push(message);return;}
    const p=message.params;
    if(!object(p)||p.loginId!==loginId)return;
    if(completed){rejectLogin(Error('Duplicate login completion'));rpc.cancel();return;}completed=true;
    if(p.success===true&&(p.error===null||p.error===undefined))resolveLogin();else rejectLogin(Error('Sign-in not completed'));
  };
  rpc.onEvent=event;
  const cancelLogin=()=>{if(loginId&&!cancelSent){cancelSent=true;try{rpc.send({id:-1,method:'account/login/cancel',params:{loginId}});}catch{}}};
  const abort=()=>{cancelLogin();rpc.cancel();rejectLogin(Error('Setup cancelled'));};
  context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
  try{
    await rpc.request('initialize',{clientInfo:{name:'capri_runtime_setup',version:'1'},capabilities:{experimentalApi:false}});rpc.send({method:'initialized'});
    if(setup.mode==='connect'){
      const result=await rpc.request('account/login/start',{type:'chatgpt'});
      if(!object(result)||result.type!=='chatgpt'||!IdSchema.safeParse(result.loginId).success)throw Error('Invalid sign-in response');
      loginId=result.loginId;const url=officialCodexLoginUrl(result.authUrl);
      context.signal.throwIfAborted();await setup.open(url);context.signal.throwIfAborted();
      for(const message of early.splice(0))event(message);
      await login;
    }
    context.signal.throwIfAborted();
    const account=await rpc.request('account/read',{refreshToken:false});
    const authenticated=object(account)&&object(account.account)&&account.account.type==='chatgpt';
    const models:string[]=[];
    if(authenticated){
      let cursor:string|undefined;const seen=new Set<string>();
      for(let page=0;page<5;page++){
        const result=await rpc.request('model/list',{limit:20,includeHidden:false,...(cursor?{cursor}:{})});
        if(!object(result)||!Array.isArray(result.data)||result.data.length>20)throw Error('Invalid model catalog');
        for(const entry of result.data){if(!object(entry)||typeof entry.hidden!=='boolean')throw Error('Invalid model catalog');if(entry.hidden)continue;
          const model=CodexModelSchema.parse(entry.model);if(!models.includes(model))models.push(model);}
        if(result.nextCursor===null||result.nextCursor===undefined)break;
        if(typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor.length>2048||seen.has(result.nextCursor)||page===4)throw Error('Model catalog limit');
        cursor=result.nextCursor;seen.add(cursor);
      }
    }
    context.signal.throwIfAborted();settled=true;setup.observed(authenticated,models);return {state:'completed'};
  }finally{if(!settled)cancelLogin();settled=true;context.signal.removeEventListener('abort',abort);rpc.cancel();await stopProcess(child);}
}
export function createCodexDriver(spawnProcess?:AgentSpawn,stopProcess:(child:ChildProcessWithoutNullStreams)=>Promise<void>=stopAgentProcess):AgentDriver {
  return {async setup(context,setup){if(!spawnProcess)throw new AgentNeedsSupervision();return codexSetup(context,setup,spawnProcess,stopProcess);},async run(context){
    // Only an explicit host transport can launch. Production obtains its owned
    // transport from createNativeRuntimeAgentFactory; tests may inject a fake.
    if(!spawnProcess)throw new AgentNeedsSupervision();
    const c=context.configuration;if(c.provider!=='codex')throw Error('Wrong provider');
    if(!CodexModelSchema.safeParse(c.model).success)throw Error('Choose an explicit runtime model first');
    if(context.signal.aborted)throw Error('Cancelled');
    const child=spawnProcess(c.executable,codexArguments(context.workspace.root),
      {cwd:context.workspace.root,env:{...agentEnvironment(c.configDir),CODEX_HOME:c.configDir},windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    const rpc=new CodexRpc(child);let threadId='',turnId='';
    let bindTurn!:()=>void;const turnBound=new Promise<void>(resolve=>{bindTurn=resolve;});
    const earlyEvents:RpcObject[]=[];
    const changes=new Map<string,unknown>(),answers=new Map<string,{text:string;truncated:boolean}>();
    let finish!:(value:AgentResult)=>void,permissionDenied=false,settled=false,reportTruncated=false;
    const done=new Promise<AgentResult>(resolve=>{finish=value=>{if(!settled){settled=true;resolve(value);}};});
    const report=():AgentProviderReport|undefined=>{
      if(!answers.size)return undefined;
      const text=[...answers.values()].map(a=>a.text).join('\n\n');
      return {source:{provider:'codex',threadId,turnId,itemIds:[...answers.keys()]},text:text.slice(0,maxReportText),
        truncated:reportTruncated||text.length>maxReportText||[...answers.values()].some(a=>a.truncated)};
    };
    rpc.onEvent=message=>{
      const p=message.params;
      if(message.method==='connection/lost'){finish({state:'unconfirmed'});return;}
      if(settled||context.signal.aborted||!object(p)||p.threadId!==threadId)return;
      // Notifications can arrive before the turn/start response. Only that response binds the turn.
      if(!turnId){if(earlyEvents.length<128)earlyEvents.push(message);else finish({state:'unconfirmed',reason:'provider-error'});return;}
      if(message.method==='item/started'&&p.turnId===turnId&&p.item?.type==='fileChange')changes.set(p.item.id,p.item.changes);
      if(message.method==='item/agentMessage/delta'&&p.turnId===turnId)context.event('running');
      // item/completed is authoritative; deltas and commentary are not a final answer.
      if(message.method==='item/completed'&&p.turnId===turnId&&object(p.item)&&p.item.type==='agentMessage'&&
        (p.item.phase===undefined||p.item.phase===null||p.item.phase==='final_answer')&&IdSchema.safeParse(p.item.id).success){
        if(typeof p.item.text!=='string'){finish({state:'unconfirmed',reason:'provider-error'});return;}
        if(answers.size<64||answers.has(p.item.id))answers.set(p.item.id,{text:p.item.text.slice(0,maxReportText),truncated:p.item.text.length>maxReportText});
        else reportTruncated=true;
      }
      if(message.method==='turn/completed'&&p.turn?.id===turnId){
        const info=p.turn.error?.codexErrorInfo;
        finish({state:p.turn.status==='completed'&&!permissionDenied?'completed':'unconfirmed',reason:info==='usageLimitExceeded'?'quota':info==='unauthorized'?'authentication':permissionDenied?'permission-denied':undefined,report:report()});
      }
    };
    rpc.onRequest=async message=>{
      const p=message.params;
      if(object(p)&&p.threadId===threadId&&!turnId)await turnBound;
      if(settled||context.signal.aborted)return {decision:'decline'};
      if(message.method==='item/permissions/requestApproval'){permissionDenied=true;return {permissions:{},scope:'turn'};}
      if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(message.method))throw Error('Unsupported request');
      if(!object(p)||p.threadId!==threadId||p.turnId!==turnId||context.signal.aborted)return {decision:'decline'};
      // Escalated shell/network/amendment approvals can escape path grants: never accept them.
      if(message.method==='item/commandExecution/requestApproval'){
        permissionDenied=true;return {decision:'decline'};
      }
      if(message.method!=='item/fileChange/requestApproval')throw Error('Unsupported request');
      const files=changes.get(p.itemId);let allowed=Array.isArray(files)&&files.length>0&&files.length<=100&&!p.grantRoot;
      if(allowed)for(const file of files as any[]){
        if(!object(file)||typeof file.path!=='string'||!await context.approve('Write',{file_path:file.path,diff:file.diff,kind:file.kind})){allowed=false;break;}
      }
      if(!allowed||context.signal.aborted)permissionDenied=true;
      return {decision:allowed&&!context.signal.aborted?'accept':'decline'};
    };
    const abort=()=>{
      if(threadId&&turnId)void rpc.request('turn/interrupt',{threadId,turnId}).catch(()=>{});
      rpc.cancel();
      finish({state:'unconfirmed'});
    };
    context.signal.addEventListener('abort',abort,{once:true});
    try{
      await rpc.request('initialize',{clientInfo:{name:'capri',title:'Capri',version:'0.7'},capabilities:{experimentalApi:false}});
      rpc.send({method:'initialized',params:{}});
      const account=await rpc.request('account/read',{refreshToken:false});
      if(!account?.account||account.account.type!=='chatgpt')throw Error('Codex sign-in required');
      if(context.signal.aborted)throw Error('Cancelled');
      const thread=await rpc.request('thread/start',{cwd:context.workspace.root,model:c.model,approvalPolicy:'untrusted',sandbox:context.workspace.writable?'workspace-write':'read-only',ephemeral:true,
        config:{mcp_servers:{},shell_environment_policy:{inherit:'none'},features:{hooks:false,multi_agent:false},web_search:'disabled'}});
      if(typeof thread?.thread?.id!=='string')throw Error('Invalid thread receipt');threadId=thread.thread.id;
      await context.beforeDispatch();
      const access={type:'restricted',includePlatformDefaults:true,readableRoots:[context.workspace.root]};
      const turn=await rpc.request('turn/start',{threadId,input:[{type:'text',text:context.prompt}],cwd:context.workspace.root,model:c.model,approvalPolicy:'untrusted',
        sandboxPolicy:context.workspace.writable?{type:'workspaceWrite',writableRoots:[context.workspace.root],readOnlyAccess:access,networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',access}});
      if(typeof turn?.turn?.id!=='string')throw Error('Invalid turn receipt');
      if(turnId&&turnId!==turn.turn.id)throw Error('Turn mismatch');turnId=turn.turn.id;
      for(const message of earlyEvents)rpc.onEvent(message);
      bindTurn();
      if(context.signal.aborted)abort();
      return await done;
    }finally{
      bindTurn();
      context.signal.removeEventListener('abort',abort);
      // Even a failed handshake must stop its child before another provider lease is possible.
      await stopProcess(child);
    }
  }};
}
export type ClaudeSdkDriver={query:(input:{prompt:string;options:Options})=>Pick<Query,typeof Symbol.asyncIterator|'close'>};
/** Build-time pins are compiled into the main bundle. The adjacent JSON is public
 * inventory for the managed host, never a trust bootstrap or provider configuration. */
declare const __CAPRI_RUNTIME_RESOURCES__:unknown;
const RuntimeResourceManifestSchema=z.object({schemaVersion:z.literal(1),platform:z.string(),arch:z.string(),claudeSdkVersion:z.literal('0.3.318'),
  processSupervisorSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),files:z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/))}).strict();
export type RuntimeResourceManifest=z.infer<typeof RuntimeResourceManifestSchema>;
const resourceFileIdentity=(info:fs.BigIntStats)=>[info.dev,info.ino,info.mode,info.size,info.mtimeNs,info.ctimeNs,info.nlink].join(':');
function runtimeResourceIdentity(file:string):string{
  const absolute=cleanPath(file),parsed=path.parse(absolute),ancestors:string[]=[];let current=parsed.root;
  // Directory timestamps/size change for unrelated siblings. Bind directory
  // identity and type, and recheck every ancestor for aliases on every poll.
  for(const part of ['',...absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)]){
    if(part)current=path.join(current,part);
    const info=fs.lstatSync(current,{bigint:true});
    if(current===absolute){
      if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n)throw Error('Invalid runtime resource');
      ancestors.push(resourceFileIdentity(info));
    }else{
      if(!info.isDirectory()||info.isSymbolicLink())throw Error('Runtime resource ancestor is aliased');
      ancestors.push([info.dev,info.ino,info.mode].join(':'));
    }
  }
  if(!samePath(fs.realpathSync.native(absolute),absolute))throw Error('Noncanonical runtime resource');
  return ancestors.join('/');
}
function runtimeResourceDigest(file:string):string{
  // The native SDK is large. Bound memory while checking the actual copied bytes.
  const fd=fs.openSync(file,'r'),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
  try{
    const before=fs.fstatSync(fd,{bigint:true});if(!before.isFile()||before.nlink!==1n)throw Error('Invalid runtime resource');
    let count:number;while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));
    const after=fs.fstatSync(fd,{bigint:true}),atPath=fs.lstatSync(file,{bigint:true});
    if(resourceFileIdentity(before)!==resourceFileIdentity(after)||!atPath.isFile()||atPath.isSymbolicLink()||
      resourceFileIdentity(atPath)!==resourceFileIdentity(after))throw Error('Runtime resource changed during verification');
    return hash.digest('hex');
  }finally{fs.closeSync(fd);}
}
function runtimeIntegrity(){
  const verified=new Map<string,{pin:string;identity:string}>();
  return {
    verify(file:string,pin:string){
      verified.delete(file);
      const before=runtimeResourceIdentity(file);
      if(runtimeResourceDigest(file)!==pin||runtimeResourceIdentity(file)!==before)throw Error('Packaged runtime resource is unavailable or changed');
      verified.set(file,{pin,identity:before});
    },
    available(file:string,pin:string):boolean{
      const cached=verified.get(file);
      try{if(cached?.pin===pin&&runtimeResourceIdentity(file)===cached.identity)return true;}catch{/* Changed/missing/aliased resources fail closed. */}
      verified.delete(file);return false;
    }
  };
}
export function packagedRuntimeResources(nativeDirectory:string,expected:unknown=typeof __CAPRI_RUNTIME_RESOURCES__==='undefined'?undefined:__CAPRI_RUNTIME_RESOURCES__){
  const manifest=RuntimeResourceManifestSchema.parse(expected);
  if(!path.isAbsolute(nativeDirectory)||path.resolve(nativeDirectory)!==nativeDirectory)throw Error('Canonical native resource directory required');
  const root=nativeDirectory;
  const file=(relative:string)=>{
    if(!relative||relative.includes('\\')||relative.split('/').some(part=>!part||part==='.'||part==='..'||part.includes(':')))throw Error('Invalid packaged resource path');
    return path.join(root,...relative.split('/'));
  };
  for(const name of Object.keys(manifest.files))file(name);
  const executable=process.platform==='win32'?'claude.exe':'claude',integrity=runtimeIntegrity();
  const resourceNames=(kind:'supervisor'|'claude-api'|'updater')=>{
    if(manifest.platform!==process.platform||manifest.arch!==process.arch)throw Error('Packaged runtime platform differs');
    const names=kind==='claude-api'?Object.keys(manifest.files).filter(name=>name.startsWith('claude/')):
      [kind==='supervisor'?'Capri.ProcessSupervisor.exe':'update-launcher.cjs'];
    const required=kind==='claude-api'?['claude/sdk/sdk.mjs','claude/sdk/package.json','claude/sdk/LICENSE.md','claude/sdk/README.md',
      'claude/platform/'+executable,'claude/platform/package.json','claude/platform/LICENSE.md','claude/platform/README.md']:names;
    if(required.some(name=>!manifest.files[name])||kind==='supervisor'&&manifest.processSupervisorSha256!==manifest.files['Capri.ProcessSupervisor.exe'])throw Error('Required runtime resource pin is absent');
    return names;
  };
  const verify=(kind:'supervisor'|'claude-api'|'updater')=>{for(const name of resourceNames(kind))integrity.verify(file(name),manifest.files[name]);};
  // Read-only UI polling never hashes bytes or primes trust. Only a full verify
  // records an identity; any subsequent identity change requires verification.
  const available=(kind:'supervisor'|'claude-api'|'updater')=>{
    try{return resourceNames(kind).every(name=>integrity.available(file(name),manifest.files[name]));}catch{return false;}
  };
  return Object.freeze({nativeDirectory:root,helperPath:file('Capri.ProcessSupervisor.exe'),helperSha256:manifest.processSupervisorSha256??'',
    claudeExecutable:file('claude/platform/'+executable),sdkPath:file('claude/sdk/sdk.mjs'),updateLauncher:file('update-launcher.cjs'),verify,available,
    async loadClaude():Promise<ClaudeSdkDriver>{
      verify('claude-api');
      // A native import of an absolute file URL survives the Electron/CJS bundle.
      // SDK distribution is unmodified ESM, outside ASAR, and imports Node builtins only.
      const sdk=await import(pathToFileURL(file('claude/sdk/sdk.mjs')).href);
      verify('claude-api');if(typeof sdk.query!=='function')throw Error('Packaged SDK export is unavailable');return sdk;
    }});
}
export type PackagedRuntimeResources=ReturnType<typeof packagedRuntimeResources>;
/** Explicit SDK loader/transport seam. Production must use the native factory;
 * calling this protocol adapter alone never grants owned lifecycle capability.
 */
export function createClaudeDriver(load?:()=>Promise<ClaudeSdkDriver>,spawnProcess:AgentSpawn=(command,args,options)=>spawn(command,args,options) as ChildProcessWithoutNullStreams,stopProcess:(child:ChildProcessWithoutNullStreams)=>Promise<void>=stopAgentProcess,runtime?:Pick<PackagedRuntimeResources,'claudeExecutable'|'verify'>):AgentDriver {
  return {async run(context){
    if(!load)throw new AgentNeedsSupervision();
    const c=context.configuration;if(c.provider!=='claude-api'||!c.apiKey||!Number.isFinite(c.budgetUsd)||c.budgetUsd<=0)throw Error('Claude API unconfigured');
    runtime?.verify('claude-api');const sdk=await load();if(context.signal.aborted)throw Error('Cancelled');
    const abortController=new AbortController();let query:ReturnType<ClaudeSdkDriver['query']>|undefined,owned:ChildProcessWithoutNullStreams|undefined;
    const abort=()=>{abortController.abort();query?.close();};context.signal.addEventListener('abort',abort,{once:true});
    const tools=context.workspace.writable?['Read','Glob','Grep','Edit','Write']:['Read','Glob','Grep'];
    try{
      runtime?.verify('claude-api');
      await context.beforeDispatch();
      if(context.signal.aborted)throw Error('Task stopped');
      query=sdk.query({prompt:context.prompt,options:{...(runtime?{pathToClaudeCodeExecutable:runtime.claudeExecutable}:{}),cwd:context.workspace.root,model:c.model,maxBudgetUsd:c.budgetUsd,maxTurns:20,
        abortController,persistSession:false,settingSources:[],skills:[],plugins:[],mcpServers:{},strictMcpConfig:true,
        tools,allowedTools:[],permissionMode:'default',settings:{disableAllHooks:true,enableAllProjectMcpServers:false,permissions:{ask:tools}},
        env:{...agentEnvironment(c.configDir),CLAUDE_CONFIG_DIR:c.configDir,ANTHROPIC_API_KEY:c.apiKey},
        spawnClaudeCodeProcess:options=>{
          if(owned||context.signal.aborted)throw Error('Additional SDK process denied');
          if(runtime){runtime.verify('claude-api');if(options.command!==runtime.claudeExecutable)throw Error('SDK executable differs from packaged native resource');}
          owned=spawnProcess(options.command==='node'?process.execPath:options.command,options.args,{cwd:context.workspace.root,env:options.env,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
          owned.stderr.on('data',()=>{});return owned;
        },
        canUseTool:async(tool,input,options)=>{
          if(options.signal.aborted||context.signal.aborted)return {behavior:'deny',message:'Task stopped',interrupt:true};
          context.event('needs-approval');
          const allowed=scopedTool(context.workspace,tool,input)&&await context.approve(tool,input);
          return allowed&&!options.signal.aborted&&!context.signal.aborted?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'Outside current application approval'};
        }}});
      const iterator=query[Symbol.asyncIterator]();let sessionId='';
      while(true){
        const next=await nextUntilAbort(iterator,context.signal);
        if(!next||next.done)break;
        const message=next.value;
        if(context.signal.aborted)return {state:'unconfirmed'};
        if(message.type==='system'&&message.subtype==='init'){
          if(message.apiKeySource!=='ANTHROPIC_API_KEY'||!IdSchema.safeParse(message.session_id).success||sessionId)return {state:'unconfirmed',reason:'authentication'};
          sessionId=message.session_id;
        }
        if(message.type==='result'){
          if(!sessionId||message.session_id!==sessionId)return {state:'unconfirmed',reason:'authentication'};
          if(!Array.isArray(message.permission_denials))return {state:'unconfirmed',reason:'provider-error'};
          if(message.subtype==='success'&&typeof message.result!=='string')return {state:'unconfirmed',reason:'provider-error'};
          const report:AgentProviderReport|undefined=message.subtype==='success'&&typeof message.result==='string'?
            {source:{provider:'claude-api',sessionId},text:message.result.slice(0,maxReportText),truncated:message.result.length>maxReportText}:undefined;
          if(message.subtype==='success'&&!message.is_error&&message.permission_denials.length===0)return {state:'completed',report};
          return {state:'unconfirmed',reason:message.subtype==='error_max_budget_usd'?'quota':message.permission_denials.length?'permission-denied':'provider-error',report};
        }
        context.event('running');
      }
      return {state:'unconfirmed'};
    }finally{
      context.signal.removeEventListener('abort',abort);
      let closeFailed=false;try{query?.close();}catch{closeFailed=true;}
      if(owned)await stopProcess(owned);
      else if(closeFailed)throw new AgentStopUnconfirmed('SDK stop unconfirmed');
    }
  }};
}

export interface NativeRuntimeAgentOptions {
  /** Private host-owned directory, outside every delegated workspace. */
  controlRoot:string;
  helperPath?:string;helperSha256?:string;hostId?:string;leases?:AgentLeasePool;
  armingTimeoutMs?:number;stopTimeoutMs?:number;
  /** Trusted packaged paths/pins; never supplied by task text or a fetched manifest. */
  runtimeResources?:PackagedRuntimeResources;
  /** Trusted injection seams only. They never come from settings/model input. */
  loadClaude?:()=>Promise<ClaudeSdkDriver>;
  spawnGuardian?:AgentSpawn;
  creatorState?:(pid:number,created?:string)=>Promise<{state:'alive'|'dead'|'unknown';created?:string}>;
}
type NativeRuntimeAttempt={record:AgentLeaseRecord;provider:AgentProvider;journal:AgentLeaseJournal;controller:AbortController;
  child?:ChildProcessWithoutNullStreams;rawKill?:ChildProcessWithoutNullStreams['kill'];closed?:Promise<void>;arming?:Promise<SupervisorIdentity>;stopping?:Promise<void>};
const execAgentIdentity=promisify(execFile);
/** Process birth is used ONLY to recover a strictly pre-ACK claim. Armed runs
 * always require the native signed zero-process Job proof, even after PID loss. */
async function runtimeCreatorState(pid:number,created?:string):Promise<{state:'alive'|'dead'|'unknown';created?:string}>{
  if(process.platform!=='win32'||!Number.isSafeInteger(pid)||pid<=0)return {state:'unknown'};
  try{
    const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const script='$ErrorActionPreference="Stop";try{$p=[System.Diagnostics.Process]::GetProcessById('+pid+');$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}catch [System.ArgumentException]{"absent"}';
    const result=await execAgentIdentity(powershell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000,maxBuffer:2048}),value=result.stdout.trim();
    if(value==='absent')return {state:'dead'};
    if(!/^\d{1,20}$/.test(value)||BigInt(value)<=0n)return {state:'unknown'};
    return {state:created&&created!==value?'dead':'alive',created:value};
  }catch{return {state:'unknown'};}
}
function pinnedRuntimeHelperPath(file:string,pin:string){
  if(!file||!path.isAbsolute(file)||path.resolve(file)!==file||file.includes('~')||!file.toLowerCase().endsWith('.exe')||!/^[a-f0-9]{64}$/.test(pin))throw Error('Pinned native helper path and SHA256 are required');
}
/** Construct once from trusted host configuration, then spread leases/drivers/
 * inspectLeaseStopped/recoverLeases into RuntimeAgents dependencies. No launch,
 * authentication, provider probe or default profile read occurs here. Windows
 * without the pinned helper is unavailable, with no raw-spawn fallback.
 *
 * The global default pool is shared with development. Tests must inject their
 * own disk pool. A different runtime host supplies its own private controlRoot;
 * it still uses that same global pool. recoverLeases never kills a foreign live
 * owner and never resubmits inference or upgrades an unknown task outcome.
 *
 * Integration handoff (the later Hub owns composition): resolve the packaged
 * native/Capri.ProcessSupervisor.exe resource and its operator-reviewed SHA256
 * into helperPath/helperSha256, or use the explicit trusted development pins.
 * Keep controlRoot outside delegated workspaces and exports; preserve its files
 * and the shared pool's immutable generations across host restarts. Spread this
 * factory into RuntimeAgents, wire the server-owned grants/provider probes, and
 * await module.recover() before exposing actions. Surface unresolved reports to
 * the trusted recovery UI and await module.close() on Stop/Quit. Never force-clear
 * an armed generation or retry its inference to recover an unknown outcome.
 * Packaged Claude uses the pinned native SDK distribution and absolute executable;
 * Electron's process.execPath is never its production child launcher.
 * No coordinator tooling modules or installed profile are runtime dependencies.
 */
export function createNativeRuntimeAgentFactory(options:NativeRuntimeAgentOptions){
  // Electron exposes resourcesPath in packaged/CJS execution. Native tests inject
  // their own resources/loader and pool; there is no development npm/PATH fallback.
  const resourcesPath=(process as NodeJS.Process&{resourcesPath?:string}).resourcesPath;
  let resources=options.runtimeResources;
  if(!resources&&resourcesPath&&typeof __CAPRI_RUNTIME_RESOURCES__!=='undefined')resources=packagedRuntimeResources(path.join(resourcesPath,'native'));
  const leases=options.leases??sharedAgentLeases,helperPath=options.helperPath??resources?.helperPath??process.env.CAPRI_PROCESS_SUPERVISOR??'',helperSha256=options.helperSha256??resources?.helperSha256??process.env.CAPRI_PROCESS_SUPERVISOR_SHA256??'';
  const hostId=options.hostId??agentLeaseDigest({owner:'runtime',controlRoot:options.controlRoot.toLowerCase()}),attempts=new Map<string,NativeRuntimeAttempt>();
  const helperIntegrity=runtimeIntegrity();
  // Prime once during host composition, never from a status/availability call.
  // Claim, SDK load and native spawn still hash actual bytes independently.
  try{pinnedRuntimeHelperPath(helperPath,helperSha256);if(resources)resources.verify('supervisor');else helperIntegrity.verify(helperPath,helperSha256);}catch{/* Unavailable until trusted resources are repaired and freshly verified. */}
  if(resources&&!options.loadClaude)try{resources.verify('claude-api');}catch{/* No provider readiness from inventory alone. */}
  const creatorState=options.creatorState??runtimeCreatorState;
  const workspaceBoundary=(workspace:AgentWorkspace)=>{
    const root=validateAgentWorkspace(workspace),directory=leases.directory;
    if(!directory||!path.isAbsolute(directory)||path.resolve(directory)!==directory||directory.includes('~'))throw Error('Canonical durable lease pool directory is required');
    noAliases(directory);
    if(fs.existsSync(directory)&&!fs.lstatSync(directory).isDirectory())throw Error('Lease pool directory is unavailable');
    // The shared pool contains every provider's claims and proof authority. No
    // delegated workspace may contain it, be inside it, or equal it.
    if(inside(root,directory)||inside(directory,root))throw Error('Native lease pool overlaps delegated workspace');
    if(inside(root,options.controlRoot)||inside(options.controlRoot,root))throw Error('Native control overlaps delegated workspace');
    return root;
  };
  const configuration=(provider?:AgentProvider,verifyBytes=false)=>{
    try{
      if(process.platform!=='win32'||!leases.directory||leases.initializationError)throw Error(leases.initializationError??'Windows native supervision requires a durable shared lease pool');
      if(!/^[a-f0-9]{64}$/.test(hostId))throw Error('Invalid runtime host identity');
      for(const [time,max] of [[options.armingTimeoutMs,14000],[options.stopTimeoutMs,15000]])if(time!==undefined&&(!Number.isSafeInteger(time)||time<100||time>max!))throw Error('Invalid native lifecycle timeout');
      pinnedRuntimeHelperPath(helperPath,helperSha256);
      if(resources){
        if(helperPath!==resources.helperPath||helperSha256!==resources.helperSha256)throw Error('Packaged helper binding differs');
        if(verifyBytes)resources.verify('supervisor');else if(!resources.available('supervisor'))throw Error('Pinned native helper changed');
      }else if(verifyBytes)helperIntegrity.verify(helperPath,helperSha256);
      else if(!helperIntegrity.available(helperPath,helperSha256))throw Error('Pinned native helper changed');
      if(provider==='claude-api'&&!options.loadClaude){
        if(!resources)throw Error('Packaged SDK resources are required');
        if(verifyBytes)resources.verify('claude-api');else if(!resources.available('claude-api'))throw Error('Packaged SDK resources changed');
      }
      if(!path.isAbsolute(options.controlRoot)||path.resolve(options.controlRoot)!==options.controlRoot||options.controlRoot.includes('~'))throw Error('Canonical private native control root is required');
      noAliases(options.controlRoot);return {available:true as const};
    }catch{return {available:false as const,reason:'Pinned Windows native runtime supervision is missing, invalid, or inaccessible.'};}
  };
  const journal=(record:AgentLeaseRecord,provider:AgentProvider)=>new AgentLeaseJournal(leases,provider,record);
  const matches=(record:AgentLeaseRecord,provider:AgentProvider)=>record.native?.hostId===hostId&&record.owner==='runtime:'+record.native.sessionId&&['codex','claude-api'].includes(provider);
  const noAck=(record:AgentLeaseRecord)=>!fs.existsSync(path.join(record.native!.controlRoot,record.native!.controlToken,'ack.json'));
  const inspect:AgentLeaseInspector=async(record,provider)=>{
    if(!record.native)return false;
    const log=journal(record,provider);if(log.isSettled()){attempts.delete(record.token);return true;}const state=log.read();
    if(state.phase==='armed'){
      let proof=inspectSupervisedRun(state.supervisor);
      if(proof.state!=='stopped'&&proof.reason==='proof-missing'&&(await creatorState(record.pid,record.native.creatorCreated)).state==='dead'){
        const deadline=Date.now()+1200;while(proof.state!=='stopped'&&proof.reason==='proof-missing'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,20));proof=inspectSupervisedRun(state.supervisor);}
      }
      if(proof.state!=='stopped')return false;log.settled(proof);return log.isSettled();
    }
    if(!noAck(record)||(await creatorState(record.pid,record.native.creatorCreated)).state!=='dead')return false;
    log.settled({state:'not-dispatched',creatorCreated:record.native.creatorCreated});return log.isSettled();
  };
  const stop=async(record:AgentLeaseRecord,provider:AgentProvider):Promise<void>=>{
    const attempt=attempts.get(record.token);
    if(!attempt||!matches(record,provider)||agentLeaseDigest(record)!==agentLeaseDigest(attempt.record)){
      if(await inspect(record,provider))return;throw new AgentStopUnconfirmed('Runtime owned Job cannot be confirmed from this host');
    }
    if(attempt.stopping)return attempt.stopping;
    attempt.controller.abort('Owned runtime Stop');
    return attempt.stopping=Promise.resolve().then(async()=>{
      try{
        const state=attempt.journal.read();
        if(state.phase==='armed'){
          const proof=await cancelSupervisedRun(state.supervisor,{timeoutMs:options.stopTimeoutMs??12000});
          if(proof.state!=='stopped')throw new AgentStopUnconfirmed('Runtime native Job stop proof is unavailable');
          attempt.journal.settled(proof);
        }else{
          // The local arming continuation has been permanently cancelled. Only
          // this captured pre-ACK handle may be killed, never a reopened PID.
          if(!noAck(record))throw new AgentStopUnconfirmed('Unexpected pre-ACK authorization');
          if(attempt.child&&attempt.child.exitCode===null&&attempt.child.signalCode===null)attempt.rawKill?.('SIGKILL');
          if(attempt.closed){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([attempt.closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AgentStopUnconfirmed('Pre-ACK guardian close is unknown')),3000);})]);}finally{clearTimeout(timer);}}
          if(attempt.journal.read().phase==='armed'){
            const armed=attempt.journal.read();if(armed.phase!=='armed')throw Error('Journal changed');const proof=await cancelSupervisedRun(armed.supervisor,{timeoutMs:options.stopTimeoutMs??12000});
            if(proof.state!=='stopped')throw new AgentStopUnconfirmed('Late arming stop is unconfirmed');attempt.journal.settled(proof);
          }else attempt.journal.settled({state:'not-dispatched',creatorCreated:record.native!.creatorCreated});
        }
        if(!attempt.journal.isSettled())throw new AgentStopUnconfirmed('Runtime lifecycle settlement did not read back');
      }catch(error){try{attempt.journal.uncertain('Native runtime cleanup requires exact ownership recovery');}catch{}throw error instanceof AgentStopUnconfirmed?error:new AgentStopUnconfirmed('Runtime native cleanup is unconfirmed');}
    });
  };
  const lifecycle:AgentOwnedLifecycle={available:()=>configuration().available,inspectStopped:inspect,stop,
    async claim(input){
      const root=workspaceBoundary(input.workspace);
      if(!configuration(input.provider,true).available||input.signal.aborted)throw new AgentNeedsSupervision();
      ensureAgentLeaseDirectory(options.controlRoot);
      const creator=await creatorState(process.pid);
      if(input.signal.aborted)throw Error('Runtime stopped before native claim');
      if(creator.state!=='alive'||!creator.created)throw new AgentNeedsSupervision();
      workspaceBoundary(input.workspace);
      return {protocol:'capri-native-agent-lease-v1',sessionId:input.jobId,hostId,creatorCreated:creator.created,startedAt:new Date().toISOString(),controlRoot:options.controlRoot,controlToken:randomBytes(32).toString('hex'),helperPath,helperSha256,workspaceSha256:sha256(root.toLowerCase())};
    },
    register(record,provider){if(!matches(record,provider)||attempts.has(record.token))throw Error('Runtime native claim binding changed');attempts.set(record.token,{record,provider,journal:journal(record,provider),controller:new AbortController()});}
  };
  const execute=async(provider:AgentProvider,context:AgentDriverContext,setup?:CodexSetup):Promise<AgentResult>=>{
    const record=context.leaseRecord,attempt=record&&attempts.get(record.token);
    if(!attempt||!record||!context.pinOwnership||record.native?.sessionId!==record.owner.slice('runtime:'.length)||attempt.provider!==provider||agentLeaseDigest(attempt.record)!==agentLeaseDigest(record))throw new AgentNeedsSupervision();
    const controller=attempt.controller,abort=()=>controller.abort('Runtime task cancelled');context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
    const nativeSpawn:AgentSpawn=(command,args,spawnOptions)=>{
      if(controller.signal.aborted||attempt.child||!configuration(provider,true).available)throw Error('Runtime native launch denied');
      workspaceBoundary(context.workspace);
      if(spawnOptions.cwd!==context.workspace.root||sha256(context.workspace.root.toLowerCase())!==record.native!.workspaceSha256)throw Error('Runtime workspace binding changed');
      const launch=prepareSupervisedLaunch({helperPath,helperSha256,controlRoot:options.controlRoot,cwd:context.workspace.root,executable:command,args,scopeSha256:agentLeaseDigest({provider,lease:record}),token:record.native!.controlToken});
      attempt.journal.prepare(launch.control);
      if(controller.signal.aborted)throw Error('Runtime stopped before guardian spawn');
      workspaceBoundary(context.workspace);
      const child=(options.spawnGuardian??((exe,argv,opts)=>spawn(exe,argv,opts) as ChildProcessWithoutNullStreams))(launch.executable,launch.args,{...spawnOptions,...launch.spawnOptions,shell:false,stdio:['pipe','pipe','pipe']});
      attempt.child=child;attempt.rawKill=child.kill.bind(child);attempt.closed=new Promise<void>(resolve=>{child.once('close',()=>resolve());child.once('error',()=>resolve());});
      // SDK close/abort may call child.kill. It must cancel the exact owned Job,
      // not kill the guardian and destroy its opportunity to write zero proof.
      child.kill=()=>{void stop(record,provider).catch(()=>{});return true;};
      attempt.arming=armSupervisedRun(launch.control,child,{signal:controller.signal,timeoutMs:options.armingTimeoutMs,
        onArmed:async identity=>{if(controller.signal.aborted)throw Error('Runtime stopped before native arming');attempt.journal.arm(identity);await context.pinOwnership!(identity);if(controller.signal.aborted)throw Error('Runtime stopped before native ACK');}});
      void attempt.arming.catch(()=>{controller.abort('Native arming failed');});return child;
    };
    const transport=provider==='codex'?createCodexDriver(nativeSpawn,()=>stop(record,provider)):
      createClaudeDriver(options.loadClaude??(resources?()=>resources!.loadClaude():undefined),nativeSpawn,()=>stop(record,provider),options.loadClaude?undefined:resources);
    try{
      const scoped={...context,signal:controller.signal};
      const result=setup?await transport.setup!(scoped,setup):await transport.run(scoped);
      if(!attempt.child||!attempt.arming)throw new AgentStopUnconfirmed('Runtime provider did not use the owned native transport');
      await attempt.arming;return result;
    }finally{context.signal.removeEventListener('abort',abort);await stop(record,provider);}
  };
  const driver=(provider:AgentProvider):AgentDriver=>({ownedLifecycle:{...lifecycle,available:()=>configuration(provider).available},
    run:context=>execute(provider,context),...(provider==='codex'?{setup:(context:AgentDriverContext,setup:CodexSetup)=>execute(provider,context,setup)}:{})});
  return Object.freeze({leases,drivers:Object.freeze({codex:driver('codex'),'claude-api':driver('claude-api')}),inspectLeaseStopped:inspect,
    configuration:(provider?:AgentProvider)=>configuration(provider),
    async recoverLeases():Promise<AgentLeaseRecovery[]>{
      const reports:AgentLeaseRecovery[]=[];
      for(const provider of ['codex','claude-api'] as const){const slot=leases.peek(provider);
        if(slot.state==='occupied'&&slot.active){reports.push({provider,state:'recovery-required',reason:'active',record:slot.record});continue;}
        reports.push(await leases.reconcile(provider,inspect));
      }return reports;
    }
  });
}

export interface CodexConnectionOptions {
  configuration():Extract<AgentConfiguration,{provider:'codex'}>|undefined;
  save(configuration:Extract<AgentConfiguration,{provider:'codex'}>):Promise<void>;
  /** Empty host-owned setup directory, outside runtime home and every workspace grant. */
  workspace:AgentWorkspace;
  open(url:string):Promise<void>;
  timeoutMs?:number;
}
/** Host settings boundary. No credentials/URLs/account identities are retained.
 * One lease covers initialization, user login, catalog and exact-token cleanup. */
export class CodexRuntimeConnection {
  private evidence?:{configuration:AgentConfiguration;authenticated:boolean;models:string[]};
  private last:CodexConnection['state']='needs-sign-in';
  private active?:{id:string;controller:AbortController;done:Promise<void>};
  private configuring?:AbortController;
  private closed=false;
  constructor(private readonly options:CodexConnectionOptions,private readonly driver:AgentDriver,private readonly leases:AgentLeasePool){}
  snapshot():CodexConnection {
    const config=this.options.configuration();
    const evidence=this.evidence&&sameConfiguration(config,this.evidence.configuration)?this.evidence:undefined;
    const occupied=this.leases.peek('codex').state!=='available';
    return CodexConnectionSchema.parse({state:this.closed?'unavailable':!config?'unconfigured':this.active?this.last:this.configuring||occupied?'busy':!lifecycleAvailable(this.driver)?'unavailable':evidence?.authenticated?'authenticated':this.last==='authenticated'?'needs-sign-in':this.last,
      authenticated:evidence?.authenticated===true,inferenceVerified:false,...(config?.model?{model:config.model}:{}),models:evidence?.models??[],...(this.active?{sessionId:this.active.id}:{})});
  }
  ready():boolean {const s=this.snapshot();return !this.closed&&!this.active&&lifecycleAvailable(this.driver)&&s.authenticated&&!!s.model&&s.models.includes(s.model);}
  /** Also used by the existing executable locator; lock BEFORE its file dialog. */
  async configure<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    if(this.closed||this.active||this.configuring||!lifecycleAvailable(this.driver)||this.leases.peek('codex').state!=='available')throw Error('Codex connection is busy or unavailable');
    const controller=new AbortController();this.configuring=controller;
    const lifecycle=this.driver.ownedLifecycle!,id=randomUUID();let lease:ReturnType<AgentLeasePool['acquire']>|undefined;
    try{
      const claim=await lifecycle.claim?.({provider:'codex',jobId:id,workspace:this.options.workspace,signal:controller.signal});
      controller.signal.throwIfAborted();lease=this.leases.acquire('codex','runtime:'+id,claim);lifecycle.register?.(lease.record,'codex');
      const result=await work(controller.signal);controller.signal.throwIfAborted();this.evidence=undefined;this.last='needs-sign-in';return result;
    }finally{try{if(lease)await this.settle(lease,lifecycle);}finally{this.configuring=undefined;}}
  }
  private async settle(lease:ReturnType<AgentLeasePool['acquire']>,lifecycle:AgentOwnedLifecycle):Promise<void>{
    try{
      await lifecycle.stop(lease.record,'codex');if(!await lifecycle.inspectStopped(lease.record,'codex'))throw new AgentStopUnconfirmed();
      if(lease.record.native){lease.retain();const settled=await this.leases.reconcile('codex',(record,p)=>agentLeaseDigest(record)===agentLeaseDigest(lease.record)?lifecycle.inspectStopped(record,p):Promise.resolve(false));if(!['available','recovered'].includes(settled.state))throw new AgentStopUnconfirmed();}
      lease.release();
    }catch{lease.retain();throw new AgentStopUnconfirmed('Codex setup ownership requires recovery');}
  }
  async selectModel(model:string):Promise<void>{
    model=CodexModelSchema.parse(model);
    if(!this.snapshot().authenticated||!this.evidence?.models.includes(model))throw Error('Inspect the signed-in model catalog first');
    const models=[...this.evidence.models],config=this.options.configuration();if(!config)throw Error('Codex is unconfigured');
    await this.configure(async signal=>{signal.throwIfAborted();const next={...config,model};await this.options.save(next);signal.throwIfAborted();if(!sameConfiguration(next,this.options.configuration()))throw Error('Runtime model readback failed');});
    this.evidence={configuration:this.options.configuration()!,authenticated:true,models};this.last='authenticated';
  }
  start(mode:'connect'|'inspect',signal:AbortSignal):string {
    if(this.closed||this.active||this.configuring||signal.aborted||!lifecycleAvailable(this.driver)||!this.driver.setup)throw Error('Codex setup is unavailable or busy');
    const config=this.options.configuration();if(!config)throw Error('Configure the Codex executable first');
    const root=validateAgentWorkspace(this.options.workspace);noAliases(config.configDir);
    if(inside(root,config.configDir)||inside(config.configDir,root)||!path.isAbsolute(config.executable))throw Error('Isolated Codex home required');
    // Native claim must precede acquire for its immutable generation; reserve the
    // local start synchronously, then the shared pool arbitrates that claim.
    if(this.leases.peek('codex').state!=='available')throw Error('Codex provider is busy');
    const id=randomUUID(),controller=new AbortController(),abort=()=>controller.abort('cancelled');
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    this.evidence=undefined;this.last=mode==='connect'?'connecting':'checking';
    const done=Promise.resolve().then(async()=>{
      let lease:ReturnType<AgentLeasePool['acquire']>|undefined,observed:{authenticated:boolean;models:string[]}|undefined;
      const timer=setTimeout(()=>controller.abort('expired'),Math.max(20,Math.min(this.options.timeoutMs??180000,300000)));
      const lifecycle=this.driver.ownedLifecycle!;
      try{
        const claim=await lifecycle.claim?.({provider:'codex',jobId:id,workspace:this.options.workspace,signal:controller.signal});
        controller.signal.throwIfAborted();lease=this.leases.acquire('codex','runtime:'+id,claim);lifecycle.register?.(lease.record,'codex');
        const record=lease.record;
        const result=await setupUntilAbort(this.driver.setup!({configuration:config,workspace:this.options.workspace,prompt:'',signal:controller.signal,leaseToken:lease.token,leaseRecord:record,
          pinOwnership:async identity=>{controller.signal.throwIfAborted();const state=new AgentLeaseJournal(this.leases,'codex',record).read();if(state.phase!=='armed'||agentLeaseDigest(state.supervisor)!==agentLeaseDigest(identity))throw Error('Setup ownership changed');},
          beforeDispatch:async()=>{throw Error('Inference is forbidden during setup');},approve:async()=>false,event:()=>{}},
        {mode,open:async url=>{controller.signal.throwIfAborted();await this.options.open(officialCodexLoginUrl(url));controller.signal.throwIfAborted();},
          observed:(authenticated,models)=>{controller.signal.throwIfAborted();observed={authenticated,models};}}),controller.signal);
        if(result.state!=='completed'||!observed)throw Error('Setup not confirmed');
      }catch{observed=undefined;this.last=controller.signal.aborted?(controller.signal.reason==='expired'?'expired':'cancelled'):'unavailable';}
      finally{
        clearTimeout(timer);
        if(lease){
          try{await this.settle(lease,lifecycle);}catch{observed=undefined;this.last='unavailable';}
        }
        if(observed&&!controller.signal.aborted&&sameConfiguration(config,this.options.configuration())&&!this.closed){this.evidence={configuration:structuredClone(config),...observed};this.last=observed.authenticated?'authenticated':'needs-sign-in';}
        signal.removeEventListener('abort',abort);if(this.active?.id===id)this.active=undefined;
      }
    });
    this.active={id,controller,done};void done.catch(()=>{this.last='unavailable';});return id;
  }
  async cancel(sessionId:string):Promise<void>{const active=this.active;if(!active||active.id!==sessionId)throw Error('Connection session changed');active.controller.abort('cancelled');await active.done;}
  async close():Promise<void>{this.closed=true;this.evidence=undefined;this.configuring?.abort('cancelled');const active=this.active;active?.controller.abort('cancelled');await active?.done;}
}

type Journal={id:string;digest:string;job:AgentJob;dispatched:boolean;receipt:ActionReceipt;
  leaseToken?:string;leaseRecord?:AgentLeaseRecord;supervisor?:SupervisorIdentity;scopeSha256?:string;grantSha256?:string;resultSha256?:string};
const workspaceDigest=(authority:AgentAuthority)=>sha256(canonicalJson(authority.workspace));
const grantDigest=(authority:AgentAuthority)=>sha256(canonicalJson(authority.grant));
/** Bounded host observation, independent of provider claims. No file contents enter the result. */
function workspaceSnapshot(workspace:AgentWorkspace):Map<string,string>|undefined {
  try{
    const root=validateAgentWorkspace(workspace),files=new Map<string,string>();let bytes=0;
    const walk=(directory:string)=>{
      for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
        const file=path.join(directory,entry.name),stat=fs.lstatSync(file);
        if(stat.isDirectory()){walk(file);continue;}
        if(!stat.isFile()||stat.nlink!==1||stat.size>8*1024*1024||(bytes+=stat.size)>64*1024*1024)throw Error('Observation limit');
        noAliases(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|(process.platform==='win32'?0:(fs.constants.O_NOFOLLOW??0)));
        try{
          const opened=fs.fstatSync(fd),current=fs.lstatSync(file);
          if(!opened.isFile()||opened.nlink!==1||opened.ino!==stat.ino||opened.dev!==stat.dev||current.isSymbolicLink()||current.ino!==opened.ino||opened.size!==stat.size)throw Error('File changed during observation');
          const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let read=0,total=0;
          while((read=fs.readSync(fd,buffer,0,buffer.length,null))>0){total+=read;if(total>stat.size)throw Error('File changed during observation');hash.update(buffer.subarray(0,read));}
          if(total!==stat.size||fs.fstatSync(fd).mtimeMs!==opened.mtimeMs)throw Error('File changed during observation');
          files.set(path.relative(root,file),hash.digest('hex'));
        }finally{fs.closeSync(fd);}
      }
    };
    walk(root);validateAgentWorkspace(workspace);return files;
  }catch{return undefined;}
}
function observedChanges(before:Map<string,string>|undefined,after:Map<string,string>|undefined){
  const changedFiles:z.infer<typeof FileChangeSchema>[]=[];let changesTruncated=false;
  if(before&&after)for(const file of [...new Set([...before.keys(),...after.keys()])].sort()){
    const prior=before.get(file),next=after.get(file);if(prior===next)continue;
    if(changedFiles.length>=1000){changesTruncated=true;break;}
    changedFiles.push({path:file,kind:prior===undefined?'added':next===undefined?'deleted':'modified',beforeSha256:prior,afterSha256:next});
  }
  return {changedFiles,changesObserved:!!before&&!!after,changesTruncated};
}
const pendingStates=new Set(['pending','running','needs-approval']);
const unknownReceipt=(r:ActionReceipt,now:number):ActionReceipt=>({...r,observedAt:now,outcome:'unconfirmed',effect:'unknown',error:{code:'unconfirmed',message:'Agent outcome is unknown. Inspect the workspace before continuing.',retry:'read-only-reconcile'}});
/** Integration: construct once, wire trusted callbacks, await recover() before accepting actions.
 * start input {provider,workspaceId,prompt}; inspect/cancel input {jobId}.
 * No coordinator task/queue writes. No model output is a verification receipt.
 */
export class RuntimeAgents implements ExtensionModule {
  readonly feature='agents' as const;
  private closed=false;private active=new Map<string,{controller:AbortController;done:Promise<void>}>();
  private pendingStarts=new Set<AbortController>();
  private serial:Promise<unknown>=Promise.resolve();
  private records=new Map<string,Journal>();
  private writes=new Map<string,Promise<void>>();
  // No persistent production leases before an owned launch/recovery integration.
  private fallbackLeases=new AgentLeasePool();
  private get leases(){return this.deps.leases??this.fallbackLeases;}
  constructor(private deps:RuntimeAgentDependencies){}
  private exclusive<T>(fn:()=>Promise<T>):Promise<T>{const next=this.serial.then(fn,fn);this.serial=next.catch(()=>{});return next;}
  private async save(record:Journal){
    const snapshot=structuredClone(record);
    const write=(this.writes.get(record.id)??Promise.resolve()).catch(()=>{}).then(async()=>{
      await this.deps.store.put(agentJournalKind,snapshot);
      const observed=await this.deps.store.get(agentJournalKind,record.id);
      if(!observed||observed.digest!==snapshot.digest||canonicalJson(observed.job)!==canonicalJson(snapshot.job)||canonicalJson(observed.receipt)!==canonicalJson(snapshot.receipt)||observed.dispatched!==snapshot.dispatched||
        observed.leaseToken!==snapshot.leaseToken||canonicalJson(observed.leaseRecord??null)!==canonicalJson(snapshot.leaseRecord??null)||canonicalJson(observed.supervisor??null)!==canonicalJson(snapshot.supervisor??null)||observed.scopeSha256!==snapshot.scopeSha256||observed.grantSha256!==snapshot.grantSha256||observed.resultSha256!==snapshot.resultSha256)throw Error('Agent journal not confirmed');
      this.records.set(record.id,record);
    });
    this.writes.set(record.id,write);
    try{await write;}finally{if(this.writes.get(record.id)===write)this.writes.delete(record.id);}
  }
  /** Call at startup, and again from the trusted recovery UI after native cleanup.
   * Return reports to that UI only (raw owner/token are routing data). Legacy leases
   * without a journal token require the operator's pool.reconcile inspector route.
   * Clearing a lease never changes unknown receipts or resubmits a previous job.
   */
  async recover(inspectStopped:AgentLeaseInspector|undefined=this.deps.inspectLeaseStopped):Promise<AgentLeaseRecovery[]>{
    return this.exclusive(async()=>{if(this.active.size)throw Error('Cannot recover active jobs');for(const value of await this.deps.store.list(agentJournalKind)){
      if(typeof value.digest!=='string'||!AgentJobSchema.safeParse(value.job).success||!ActionReceiptSchema.safeParse(value.receipt).success||typeof value.dispatched!=='boolean'||value.job.requestId!==value.id||value.receipt.requestId!==value.id||value.receipt.jobId!==value.job.id||
        value.receipt.feature!=='agents'||value.receipt.action!=='start')throw Error('Invalid agent journal');
      const record=value as unknown as Journal;
      if(pendingStates.has(record.job.state)){
        record.job={...record.job,state:'unconfirmed',summary:'Previous agent outcome requires inspection.',updatedAt:this.deps.clock()};
        record.receipt=unknownReceipt(record.receipt,this.deps.clock());await this.save(record);
      }else this.records.set(record.id,record);
    }
    if(this.deps.recoverLeases)return this.deps.recoverLeases();
    const reports:AgentLeaseRecovery[]=[];
    for(const provider of ['codex','claude-api'] as const){
      reports.push(await this.leases.reconcile(provider,inspectStopped?async(record,key)=>{
        const journal=[...this.records.values()].find(r=>r.job.provider===key&&r.leaseToken===record.token&&record.owner==='runtime:'+r.job.id);
        return !!journal&&await inspectStopped(record,key);
      }:undefined));
    }
    return reports;});
  }
  private async authorize(taskId:string,input:Start,requireModel=true):Promise<AgentAuthority>{
    const authority=await this.deps.resolveAuthority(taskId,input.provider,input.workspaceId);
    const decision=agentPolicy({taskId,...input},{...authority,now:this.deps.clock(),configuredProviders:authority.configuration?[authority.configuration.provider]:[]});
    if(!decision.allowed||authority.configuration?.provider!==input.provider||authority.configuration.isolated!==true||!authority.workspace||authority.workspace.id!==input.workspaceId)throw Error('Task delegation denied');
    const c=authority.configuration;
    if(!path.isAbsolute(c.configDir)||(c.provider==='codex'&&(!path.isAbsolute(c.executable)||requireModel&&!CodexModelSchema.safeParse(c.model).success))||(c.provider==='claude-api'&&(!c.apiKey||!c.model||!Number.isFinite(c.budgetUsd)||c.budgetUsd<=0)))throw Error('Provider unconfigured');
    validateAgentWorkspace(authority.workspace);
    const root=path.resolve(authority.workspace.root),configDir=path.resolve(c.configDir);
    if(inside(root,configDir)||inside(configDir,root))throw Error('Provider configuration overlaps workspace');
    return authority;
  }
  private async authorizeRecord(record:Journal,context:ExtensionActionContext):Promise<void>{
    if(this.closed||context.signal.aborted||!context.taskId||context.taskId!==record.job.taskId||context.privateSession||context.localOnly)throw Error('Agent result access denied');
    const current=await this.authorize(record.job.taskId,{provider:record.job.provider,workspaceId:record.job.workspaceId,prompt:'Read existing job'},false);
    if((record.scopeSha256&&workspaceDigest(current)!==record.scopeSha256)||(record.grantSha256&&grantDigest(current)!==record.grantSha256)||
      this.closed||context.signal.aborted||context.privateSession||context.localOnly)throw Error('Agent result scope changed');
  }
  /** Trusted task/UI context only. Returns escaped untrusted data for explicit result display.
   * Never executes, applies files, verifies a task, emits activity, or starts a provider.
   * Undefined means denied, pending, absent, corrupt, or interrupted persistence; never retry inference.
   */
  async readResult(jobId:string,context:ExtensionActionContext):Promise<AgentTaskResult|undefined>{
    try{
      if(!IdSchema.safeParse(jobId).success)return undefined;
      const record=[...this.records.values()].find(r=>r.job.id===jobId&&r.job.taskId===context.taskId);
      if(!record||!record.resultSha256||!record.dispatched||this.active.has(jobId)||pendingStates.has(record.job.state))return undefined;
      await this.authorizeRecord(record,context);
      const parsed=TaskResultSchema.safeParse(await this.deps.store.get(agentResultKind,jobId));if(!parsed.success)return undefined;
      const result=parsed.data;
      if(result.id!==jobId||result.jobId!==jobId||result.taskId!==record.job.taskId||result.requestId!==record.id||result.provider!==record.job.provider||
        result.workspaceId!==record.job.workspaceId||result.scopeSha256!==record.scopeSha256||result.state!==record.job.state||result.report&&result.report.source.provider!==result.provider||
        sha256(canonicalJson(result))!==record.resultSha256)return undefined;
      await this.authorizeRecord(record,context);return structuredClone(result);
    }catch{return undefined;}
  }
  async status(_signal:AbortSignal):Promise<ExtensionFeatureStatus>{
    // Connection availability is separate from inference evidence. Every new job
    // still needs live task/workspace grants and its own account handshake.
    const probes=await this.deps.providerStatus?.().catch(()=>[])??[];
    const agents=(['codex','claude-api'] as const).map(provider=>{
      const probe=probes.find(p=>p.provider===provider);
      const supervised=lifecycleAvailable(this.deps.drivers?.[provider]);
      return {provider,capability:featureCapability({enabled:probe?.enabled===true,configured:probe?.configured===true,supported:true,ready:!this.closed&&supervised&&probe?.ready===true,
        verification:supervised&&probe?.ready?'local-probe':'none',actions:['start','inspect','cancel']})};
    });
    return {feature:'agents',capability:agents.find(p=>p.capability.available)?.capability??agents[0].capability,agents};
  }
  async action(action:string,request:ExtensionAction,context:ExtensionActionContext):Promise<ActionReceipt>{
    const now=this.deps.clock();
    const base:ActionReceipt={id:randomUUID(),requestId:request.requestId,feature:'agents',action,observedAt:now,outcome:'rejected',effect:'none',error:{code:'forbidden',message:'Agent action denied by current task authority.',retry:'after-review'}};
    if(!ExtensionActionSchema.safeParse(request).success)return {...base,error:{code:'invalid-request',message:'Invalid agent request.',retry:'never'}};
    if(!request.taskId||request.taskId!==context.taskId||context.privateSession||context.localOnly)return base;
    if(action==='inspect'||action==='cancel'){
      const parsed=JobInputSchema.safeParse(request.input);if(!parsed.success)return base;
      const record=[...this.records.values()].find(r=>r.job.id===parsed.data.jobId&&r.job.taskId===context.taskId);if(!record)return base;
      if(action==='cancel'){
        const running=this.active.get(record.job.id);
        if(!running)return {...base,error:{code:'conflict',message:'Agent job already ended. Inspect its outcome.',retry:'never'}};
        running.controller.abort('cancelled');await running.done;
      }else try{await this.authorizeRecord(record,context);}catch{return base;}
      return {...record.receipt,requestId:request.requestId,action,observedAt:this.deps.clock()};
    }
    if(action!=='start')return {...base,error:{code:'unsupported',message:'Unsupported agent action.',retry:'never'}};
    const parsed=StartSchema.safeParse(request.input);if(!parsed.success)return {...base,error:{code:'invalid-request',message:'Invalid agent input.',retry:'never'}};
    const input=parsed.data,taskId=request.taskId,digest=sha256(canonicalJson({action,input,taskId}));
    return this.exclusive(async()=>{
      const existing=this.records.get(request.requestId)??await this.deps.store.get(agentJournalKind,request.requestId) as Journal|undefined;
      if(existing){
        if(existing.digest!==digest)return {...base,error:{code:'conflict',message:'Request ID already bound to another intent.',retry:'never'}};
        try{await this.authorizeRecord(existing,context);}catch{return base;}
        if(!this.records.has(existing.id)&&pendingStates.has(existing.job.state)){
          existing.job={...existing.job,state:'unconfirmed',updatedAt:now,summary:'Previous agent outcome requires inspection.'};existing.receipt=unknownReceipt(existing.receipt,now);await this.save(existing);
        }
        return existing.receipt;
      }
      if(this.closed||context.signal.aborted)return {...base,outcome:'cancelled',error:{code:'cancelled',message:'Task stopped before dispatch.',retry:'never'}};
      if(this.deps.canStart?.(input.provider)===false)return {...base,error:{code:'unavailable',message:'Connect the runtime provider and choose a model before starting a new job.',retry:'after-review'}};
      let authority:AgentAuthority;
      try{authority=structuredClone(await this.authorize(taskId,input));}catch{return base;}
      const driver=this.deps.drivers?.[input.provider];
      if(!lifecycleAvailable(driver))return {...base,error:{code:'unavailable',message:'Runtime delegation needs owned native process supervision.',retry:'after-review'}};
      // Snapshot trusted callbacks before any journal/lease/provider effects.
      const lifecycle:AgentOwnedLifecycle={stop:driver.ownedLifecycle.stop.bind(driver.ownedLifecycle),inspectStopped:driver.ownedLifecycle.inspectStopped.bind(driver.ownedLifecycle),
        claim:driver.ownedLifecycle.claim?.bind(driver.ownedLifecycle),register:driver.ownedLifecycle.register?.bind(driver.ownedLifecycle)};
      const controller=new AbortController(),abort=()=>controller.abort('cancelled');context.signal.addEventListener('abort',abort,{once:true});
      if(context.signal.aborted||this.closed){context.signal.removeEventListener('abort',abort);return base;}
      this.pendingStarts.add(controller);
      const job:AgentJob={id:randomUUID(),taskId,requestId:request.requestId,provider:input.provider,workspaceId:input.workspaceId,state:'pending',createdAt:now,updatedAt:now,summary:'Agent job queued.'};
      let lease;
      try{
        const claim=await lifecycle.claim?.({provider:input.provider,jobId:job.id,workspace:authority.workspace!,signal:controller.signal});
        if(controller.signal.aborted||this.closed)throw Error('Runtime stopped before claim');
        lease=this.leases.acquire(input.provider,'runtime:'+job.id,claim);lifecycle.register?.(lease.record,input.provider);
      }catch{lease?.retain();this.pendingStarts.delete(controller);context.signal.removeEventListener('abort',abort);return {...base,outcome:controller.signal.aborted?'cancelled':'rejected',error:{code:controller.signal.aborted?'cancelled':'unavailable',message:'Agent provider occupied, unavailable, or awaiting recovery.',retry:controller.signal.aborted?'never':'after-review'}};}
      const receipt:ActionReceipt={id:base.id,requestId:request.requestId,feature:'agents',action:'start',observedAt:now,outcome:'pending',effect:'queued',jobId:job.id};
      const record:Journal={id:request.requestId,digest,job,dispatched:false,receipt,leaseToken:lease.token,leaseRecord:lease.record,scopeSha256:workspaceDigest(authority),grantSha256:grantDigest(authority)};
      const settle=async()=>{
        if(!lease.record.native)return;
        lease.retain();const result=await this.leases.reconcile(input.provider,(current,key)=>agentLeaseDigest(current)===agentLeaseDigest(lease.record)?lifecycle.inspectStopped(current,key):Promise.resolve(false));
        if(result.state!=='recovered'&&result.state!=='available')throw new AgentStopUnconfirmed('Native runtime generation settlement is unconfirmed');
      };
      try{await this.save(record);}catch{
        if(lease.record.native){lease.retain();try{await lifecycle.stop(lease.record,input.provider);await settle();}catch{}}
        else lease.release();this.pendingStarts.delete(controller);context.signal.removeEventListener('abort',abort);return {...base,error:{code:'unavailable',message:'Agent journal could not be verified.',retry:'after-review'}};
      }
      this.pendingStarts.delete(controller);
      const done=this.run(record,input,authority,controller,driver,lifecycle,settle).then(safelyStopped=>{if(safelyStopped)lease.release();else lease.retain();},error=>{lease.retain();throw error;}).finally(()=>{context.signal.removeEventListener('abort',abort);this.active.delete(job.id);});
      this.active.set(job.id,{controller,done});void done.catch(()=>{});
      return receipt;
    });
  }
  private async run(record:Journal,input:Start,initial:AgentAuthority,controller:AbortController,driver:AgentDriver,lifecycle:AgentOwnedLifecycle,settle:()=>Promise<void>):Promise<boolean>{
    const timeout=setTimeout(()=>controller.abort('timeout'),Math.max(100,Math.min(this.deps.timeoutMs??300000,1800000)));
    let monitor:ReturnType<typeof setTimeout>|undefined,stopped=false,safelyStopped=true,resultWritten=false;
    let before:Map<string,string>|undefined;
    const fresh=async()=>{
      if(controller.signal.aborted||this.closed)throw Error('Task stopped');
      const current=await this.authorize(record.job.taskId,input);
      if(workspaceDigest(current)!==workspaceDigest(initial)||grantDigest(current)!==grantDigest(initial)||!sameConfiguration(current.configuration,initial.configuration))throw Error('Agent scope changed');
      if(controller.signal.aborted||this.closed)throw Error('Task stopped');return current;
    };
    const check=async()=>{try{await fresh();}catch{controller.abort('authority-changed');}finally{if(!stopped)monitor=setTimeout(()=>void check(),500);}};
    monitor=setTimeout(()=>void check(),500);
    const identity=Object.freeze(record.leaseRecord??{token:record.leaseToken!,pid:process.pid,owner:'runtime:'+record.job.id});
    let stopPromise:Promise<void>|undefined;
    const stopOwned=()=>stopPromise??=Promise.resolve().then(async()=>{
      await lifecycle.stop(identity,input.provider);
      if(!await lifecycle.inspectStopped(identity,input.provider))throw new AgentStopUnconfirmed('Owned provider tree stop unconfirmed');
      await settle();
    });
    const abortOwned=()=>{void stopOwned().catch(()=>{});};
    controller.signal.addEventListener('abort',abortOwned,{once:true});
    try{
      let value:AgentResult;
      try{
        await fresh();
        value=await driver.run({configuration:initial.configuration!,workspace:initial.workspace!,prompt:input.prompt,signal:controller.signal,leaseToken:record.leaseToken,leaseRecord:identity,
        pinOwnership:async supervisor=>{
          await fresh();if(!identity.native||record.supervisor)throw Error('Unexpected runtime ownership checkpoint');
          const state=new AgentLeaseJournal(this.leases,input.provider,identity).read();
          if(state.phase!=='armed'||agentLeaseDigest(state.supervisor)!==agentLeaseDigest(supervisor))throw Error('Runtime armed identity readback differs');
          record.supervisor=structuredClone(supervisor);await this.save(record);await fresh();
        },
        beforeDispatch:async()=>{
          if(record.dispatched)throw Error('Agent dispatch already recorded');
          await fresh();before=workspaceSnapshot(initial.workspace!);await fresh();
          record.dispatched=true;record.job={...record.job,state:'running',updatedAt:this.deps.clock(),summary:'Agent is running.'};
          await this.save(record);await fresh();
        },
        approve:async(tool,value)=>{
          try{
            await fresh();if(!scopedTool(initial.workspace!,tool,value))return false;
            record.job={...record.job,state:'needs-approval',summary:'Agent tool requires application approval.',updatedAt:this.deps.clock()};
            await this.save(record);this.emit(record.job);
            if(!this.deps.approveTool||!await this.deps.approveTool({jobId:record.job.id,taskId:record.job.taskId,provider:input.provider,tool,input:structuredClone(value),signal:controller.signal}))return false;
            await fresh();return scopedTool(initial.workspace!,tool,value);
          }catch{return false;}
        },
        event:state=>{this.emit({...record.job,state,summary:state==='needs-approval'?'Agent tool requires application approval.':'Agent is running.'});}
      });}finally{
        try{await stopOwned();}
        catch{throw new AgentStopUnconfirmed('Owned provider tree stop unconfirmed');}
      }
      const result=DriverResultSchema.parse(value);
      if(result.report&&result.report.source.provider!==input.provider)throw Error('Provider result mismatch');
      await fresh();
      if(!controller.signal.aborted&&result.state==='completed'&&record.dispatched){
        record.job={...record.job,state:'completed',summary:'Agent turn completed; task verification remains separate.',updatedAt:this.deps.clock()};
        record.receipt={...record.receipt,outcome:'completed',effect:'confirmed',observedAt:this.deps.clock()};
      }else {
        record.job={...record.job,state:'unconfirmed',summary:result.reason==='quota'?'Agent quota or budget limit reached; inspect partial work.':result.reason==='authentication'?'Agent authentication failed; inspect partial work.':result.reason==='permission-denied'?'Agent tool permission denied; inspect partial work.':'Agent outcome requires inspection.',updatedAt:this.deps.clock()};
        record.receipt=unknownReceipt(record.receipt,this.deps.clock());
      }
      if(record.dispatched){
        const changes=observedChanges(before,workspaceSnapshot(initial.workspace!));
        const limitations:AgentTaskResult['limitations']=['task-verification-required','shell-and-build-unavailable'];
        if(!changes.changesObserved)limitations.push('file-observation-unavailable');
        if(changes.changesTruncated)limitations.push('file-list-truncated');
        if(!result.report)limitations.push('final-report-unavailable');
        // JSON normalization removes absent optional fields before deterministic hashing/Store readback.
        const saved=TaskResultSchema.parse(JSON.parse(JSON.stringify({schemaVersion:1,id:record.job.id,jobId:record.job.id,taskId:record.job.taskId,
          requestId:record.id,provider:input.provider,workspaceId:input.workspaceId,scopeSha256:record.scopeSha256,observedAt:this.deps.clock(),
          state:result.state,untrusted:true,verification:'unverified',report:result.report?{...result.report,format:'html-escaped-text',text:escapeText(result.report.text)}:undefined,
          ...changes,limitations})));
        await fresh();resultWritten=true;await this.deps.store.put(agentResultKind,saved);
        const observed=TaskResultSchema.parse(await this.deps.store.get(agentResultKind,saved.id));
        if(canonicalJson(saved)!==canonicalJson(observed))throw Error('Agent result not confirmed');
        await fresh();record.resultSha256=sha256(canonicalJson(saved));
        await this.save(record);await fresh();
      }
    }catch(error){
      delete record.resultSha256;
      if(resultWritten)await this.deps.store.remove(agentResultKind,record.job.id).catch(()=>{});
      safelyStopped=!(error instanceof AgentStopUnconfirmed);
      record.job={...record.job,state:record.dispatched?'unconfirmed':controller.signal.aborted?'cancelled':'failed',summary:record.dispatched?(controller.signal.reason==='timeout'?'Agent timed out; inspect partial work.':'Agent outcome requires inspection.'):'Agent unavailable or stopped before inference dispatch.',updatedAt:this.deps.clock()};
      record.receipt=record.dispatched?unknownReceipt(record.receipt,this.deps.clock()):{...record.receipt,outcome:controller.signal.aborted?'cancelled':'rejected',effect:'none',observedAt:this.deps.clock(),error:{code:controller.signal.aborted?'cancelled':'unavailable',message:'Agent stopped or unavailable before inference dispatch.',retry:controller.signal.aborted?'never':'after-review'}};
    }finally{stopped=true;controller.signal.removeEventListener('abort',abortOwned);clearTimeout(timeout);clearTimeout(monitor);}
    if(!record.resultSha256)await this.save(record);
    this.emit(record.job);return safelyStopped;
  }
  private emit(job:AgentJob){try{this.deps.onActivity?.(Object.freeze({...job}));}catch{/* UI callback cannot change job authority. */}}
  async close():Promise<void>{this.closed=true;for(const controller of this.pendingStarts)controller.abort('closed');for(const {controller} of this.active.values())controller.abort('closed');await this.serial;for(const {controller} of this.active.values())controller.abort('closed');await Promise.allSettled([...this.active.values()].map(v=>v.done));}
}
export const createAgentsModule=(dependencies:RuntimeAgentDependencies)=>new RuntimeAgents(dependencies);
