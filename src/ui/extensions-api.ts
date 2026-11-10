import {z} from 'zod';
import {
  ActionReceiptSchema,AgentJobSchema,AgentProviderSchema,ContactBindingSchema,ContactExactReviewSchema,ContactIntentSchema,ContactReviewApprovalInputSchema,CursorSettingsSchema,DeliveryReceiptSchema,ExtensionSettingsSchema,ExtensionStatusSchema,
  IdSchema,CodexConnectionSchema,CodexModelSchema,ReleaseVersionSchema,SecurityJobSchema,SecuritySettingsSchema,Sha256Schema,SkillManifestSchema,TimestampSchema,
  type ActionReceipt,type AgentJob,type ContactBinding,type ContactIntent,type CursorStatus,type DeliveryReceipt,type ExtensionError,type ExtensionFeature,type ExtensionStatus,type FeatureCapability,type SecurityJob,
} from '../extensions/contracts';
// Type only: the server administration module imports Node crypto and is never bundled into the renderer.
import type {ContactAdminRequestSchema} from '../extensions/contact-admin';
import {redactActivity} from '../development';
import {displayTaskId} from './agent-activity';

/**
 * Renderer client for the authenticated 0.7 extension API. Nothing here runs on render or navigation:
 * every request starts from an explicit user action. Success is shown only from a matching ActionReceipt
 * (and, for contacts, a matching delivery receipt); caught errors and bare replies stay unconfirmed.
 */
export const extensionRoutes={
  status:'/v1/extensions/status',
  settings:'/v1/extensions/settings',
  codexConnection:'/v1/extensions/agents/connection',
  action:(feature:ExtensionFeature,action:string)=>`/v1/extensions/${feature}/${action}`,
  overview:{skills:'/v1/extensions/skills/catalog',security:'/v1/extensions/security/jobs',contacts:'/v1/extensions/contacts/outbox',agents:'/v1/extensions/agents/jobs'},
  /** POST, nonlogged: exact recipient and content for one pending outbox request, fenced by the privacy epoch. */
  contactReview:'/v1/extensions/contacts/review-details',
} as const;
export type OverviewFeature=keyof typeof extensionRoutes.overview;

/** Plain-text display with the activity panel's redaction. Raw values stay only for routing. */
export const displayText=(value:unknown,max=240)=>redactActivity(String(value??'').replace(/\s+/g,' ').trim()).slice(0,max);
export {displayTaskId};

// ---- transport -------------------------------------------------------------------------------
export type ExtensionReply={ok:true;status?:number;body:unknown}|{ok:false;status?:number;body?:unknown;message:string};
export type ExtensionRequest=(method:'GET'|'POST',route:string,body:unknown,signal:AbortSignal)=>Promise<ExtensionReply>;
export function errorText(error:unknown):string {
  const raw=error instanceof Error?error.message:typeof error==='string'?error:'';
  const text=raw.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/,'');
  return text&&text!=='[object Object]'?displayText(text,200):'';
}
/**
 * Browser mode keeps the HTTP status and receipt body of non-2xx replies. The desktop bridge throws on
 * non-2xx and cannot be cancelled, so there a refused receipt arrives as an error and stays unconfirmed.
 */
export const defaultExtensionRequest:ExtensionRequest=async(method,route,body,signal)=>{
  signal.throwIfAborted();
  if(typeof window!=='undefined'&&window.capri){
    try{return {ok:true,body:await window.capri.request(method,route,body)};}catch(e){return {ok:false,message:errorText(e)};}
  }
  try{
    const token=sessionStorage.getItem('capri-token')||'';
    const res=await fetch(route,{method,signal,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    let json:unknown;try{json=await res.json();}catch{json=undefined;}
    if(res.ok)return {ok:true,status:res.status,body:json};
    const message=typeof (json as any)?.error==='string'?(json as any).error:'Request failed: '+res.status;
    return {ok:false,status:res.status,body:json,message:displayText(message,200)};
  }catch(e){return {ok:false,message:errorText(e)};}
};
const notFound=(reply:Extract<ExtensionReply,{ok:false}>)=>reply.status===404||(reply.status===undefined&&/^(?:not found|request failed: 404)$|route .* not found/i.test(reply.message));
export const olderServiceMessage='This Capri service does not provide 0.7 extension controls yet (HTTP 404). Existing features are unaffected; update the service to use these controls.';

// ---- action inputs (strict; the service validates again) --------------------------------------
const empty=z.object({}).strict();
const id=IdSchema;
const windowsPath=z.string().max(240).refine(v=>/^[A-Za-z]:\\/.test(v)&&!/[\x00-\x1f\x7f*?"<>|/]/.test(v)&&!v.slice(2).includes(':')&&
  !v.split('\\').slice(1).some(p=>p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)),{message:'Choose an absolute local Windows file or folder path.'});
const lines=(max:number,each:number)=>z.array(z.string().trim().min(1).max(each)).min(1).max(max);
/** Teach-workflow fields only. Permissions, review and manifest are derived by the trusted service. */
export const SkillTeachInputSchema=z.object({
  id,name:z.string().trim().min(1).max(100),description:z.string().trim().min(1).max(240),
  recipe:z.object({summary:z.string().trim().min(1).max(240),keywords:z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)?$/).max(40)).min(1).max(24),
    tools:z.array(z.string().regex(/^[a-z_]{1,40}$/)).min(1).max(16),optionalTools:z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(16),
    extensions:z.array(z.literal('security')).max(1),steps:lines(12,400),verify:lines(8,300),checks:z.array(id).min(1).max(16)}).strict(),
}).strict();
export const uiActionSchemas={
  'skills/configure':z.object({enabled:z.boolean()}).strict(),
  'cursor/import':z.object({folder:z.string().min(3).max(1024)}).strict(),
  'cursor/configure':CursorSettingsSchema,
  'cursor/restore':empty,
  'skills/list':empty,
  'skills/draft':SkillTeachInputSchema,
  'skills/save-draft':z.object({skillId:id}).strict(),
  'skills/discard-draft':z.object({skillId:id}).strict(),
  'skills/review':z.object({skillId:id,manifestSha256:Sha256Schema}).strict(),
  'skills/revoke':z.object({skillId:id}).strict(),
  'security/configure':SecuritySettingsSchema.pick({enabled:true,dailyQuickScan:true}).strict(),
  'security/health':empty,
  'security/quick-scan':empty,
  'security/full-scan':empty,
  'security/custom-scan':z.object({target:windowsPath}).strict(),
  'security/update-signatures':empty,
  'security/inspect':z.object({jobId:id}).strict(),
  'security/cancel':z.object({jobId:id}).strict(),
  // Feature switches only. Credentials, recipients, verification, limits and rules use the
  // desktop main-owner administration bridge below, never generic extension HTTP.
  'contacts/configure':z.object({enabled:z.boolean(),automaticEnabled:z.boolean()}).strict(),
  // Bound to the exact review the user saw; built only by approvalInput() from a current ContactReview.
  'contacts/approve':ContactReviewApprovalInputSchema,
  'agents/configure':z.object({codexEnabled:z.boolean(),claudeApiEnabled:z.boolean()}).strict(),
  'agents/connect-codex':empty,
  'agents/inspect-codex':empty,
  'agents/cancel-codex':z.object({sessionId:id}).strict(),
  'agents/select-codex-model':z.object({model:CodexModelSchema}).strict(),
  'agents/grant':z.object({providers:z.array(AgentProviderSchema).min(1).max(2),workspaceIds:z.array(id).min(1).max(32),allowPaid:z.boolean(),expiresInMinutes:z.number().int().min(5).max(1440)}).strict(),
  'agents/start':z.object({provider:AgentProviderSchema,workspaceId:id,prompt:z.string().trim().min(1).max(12000)}).strict(),
  'agents/inspect':z.object({jobId:id}).strict(),
  'agents/cancel':z.object({jobId:id}).strict(),
  'updates/configure':z.object({automatic:z.boolean(),channel:z.enum(['stable','preview'])}).strict(),
  'updates/check':empty,
  'updates/stage':z.object({version:ReleaseVersionSchema}).strict(),
  'updates/rollback':empty,
} as const;
export type UiAction=keyof typeof uiActionSchemas;
export type UiActionInput<A extends UiAction>=z.input<typeof uiActionSchemas[A]>;
/** Actions whose envelope carries the current task ID (correlation only; the service resolves the grant). */
export const taskScopedActions:readonly UiAction[]=['agents/grant','agents/start','agents/inspect','agents/cancel'];
type Effect='read'|'settings'|'effect';
const readActions=new Set<UiAction>(['skills/list','security/inspect','agents/inspect','updates/check','security/health']);
const settingsActions=new Set<UiAction>(['cursor/configure','skills/configure','security/configure','contacts/configure','agents/configure','agents/select-codex-model','updates/configure']);
export const actionEffect=(action:UiAction):Effect=>readActions.has(action)?'read':settingsActions.has(action)?'settings':'effect';
const confirmedText:Partial<Record<UiAction,string>>={
  'cursor/import':'Cursor pack imported privately and validated by the service.',
  'cursor/restore':'Normal cursor restore confirmed by the service.',
  'skills/review':'Review recorded for this exact manifest.',
  'skills/revoke':'Review revoked.',
  'security/cancel':'Monitoring cancellation recorded. Defender may still finish its own scan.',
  'contacts/approve':'Approval recorded for this exact request. This is not a delivery receipt.',
  'agents/grant':'Task grant recorded.',
  'agents/cancel':'Cancellation observed.',
  'agents/cancel-codex':'Connection setup cancellation observed. No inference was started.',
  'agents/select-codex-model':'Runtime model configuration saved. Inference access remains unverified.',
  'updates/stage':'Verified update staged. It is not installed yet.',
  'updates/rollback':'Rollback confirmed by the service.',
};

// ---- receipts ------------------------------------------------------------------------------------
export type ActionResultState='completed'|'queued'|'rejected'|'cancelled'|'unconfirmed'|'unsupported-service'|'invalid';
/**
 * The validated identities and fixed codes of a matching receipt. Service text (error messages, delivery details)
 * is dropped before anything is returned or stored: it can echo prompts, bodies, addresses or secrets.
 */
export interface SafeReceipt {id:string;outcome:ActionReceipt['outcome'];effect:ActionReceipt['effect'];jobId?:string;errorCode?:ExtensionError['code'];retry?:ExtensionError['retry']}
const safeReceipt=(r:ActionReceipt):SafeReceipt=>({id:r.id,outcome:r.outcome,effect:r.effect,...(r.jobId?{jobId:r.jobId}:{}),...(r.error?{errorCode:r.error.code,retry:r.error.retry}:{})});
export interface ActionResult {action:UiAction;requestId:string;state:ActionResultState;message:string;receipt?:SafeReceipt}
const errorHints:Record<string,string>={
  'approval-required':'Needs your approval first.',unconfigured:'Not configured.',unavailable:'Unavailable right now.',
  forbidden:'Not permitted by the current settings or grant.',conflict:'This request ID is already bound to another request.',
  unsupported:'This service does not support that action.','invalid-request':'The service rejected the input.',
  cancelled:'Cancelled.',unconfirmed:'The service could not confirm the outcome.',
};
const statusHints:Record<number,string>={400:'The service rejected the input.',401:'The local service did not accept this session.',403:'Not permitted by the current settings or grant.',
  409:'Conflicts with an existing request.',413:'The request was too large.',429:'The service is busy.',500:'The service reported an internal error.',
  502:'The service is unreachable.',503:'The service is unavailable right now.',504:'The service timed out.'};
/**
 * Fixed text chosen from the status code or receipt error code only. Service, bridge and provider messages are
 * never displayed or logged: they can echo prompts, message bodies, secrets, addresses or whole request bodies.
 */
export const safeFailureText=(reply:ExtensionReply)=>reply.status===undefined?'':statusHints[reply.status]??'HTTP '+reply.status+'.';
const unconfirmedResult=(action:UiAction,requestId:string,why:string):ActionResult=>{
  const effect=actionEffect(action);
  return {action,requestId,state:'unconfirmed',message:effect==='read'?why+' Nothing was changed by this read.':
    effect==='settings'?why+' The setting is not confirmed; check status before changing it again.':
    why+' The outcome is unknown. Do not repeat it; inspect or reconcile the existing record instead.'};
};
export function interpretReply(action:UiAction,requestId:string,reply:ExtensionReply):ActionResult {
  const [feature,name]=action.split('/') as [ExtensionFeature,string];
  const unknown=(why:string)=>unconfirmedResult(action,requestId,why);
  const parsed=ActionReceiptSchema.safeParse(reply.body);
  if(parsed.success){
    const full=parsed.data;
    if(full.requestId!==requestId||full.feature!==feature||full.action!==name)return unknown('The reply did not match this request.');
    const receipt=safeReceipt(full);
    switch(receipt.outcome){
      case 'completed':return {action,requestId,state:'completed',receipt,message:receipt.effect==='none'?'Read completed.':confirmedText[action]??'Saved — confirmed by the service.'};
      case 'pending':return {action,requestId,state:'queued',receipt,message:'Queued — not finished.'+(receipt.jobId?' Job '+displayTaskId(receipt.jobId)+'.':'')};
      case 'cancelled':return {action,requestId,state:'cancelled',receipt,message:'Cancelled before dispatch. Nothing was sent.'};
      case 'rejected':return {action,requestId,state:'rejected',receipt,message:errorHints[receipt.errorCode??'']??'Rejected.'};
      default:return {...unknown('The service could not confirm the outcome.'),receipt};
    }
  }
  if(reply.ok)return unknown('The service replied without a matching receipt.');
  if(notFound(reply))return {action,requestId,state:'unsupported-service',message:olderServiceMessage+' No receipt was returned.'};
  const hint=safeFailureText(reply);
  return unknown('No receipt was returned.'+(hint?' '+hint:''));
}

// ---- runner ----------------------------------------------------------------------------------
export type ActionView=ActionResult|{action:UiAction;requestId:string;state:'pending';message:string};
export interface ActionLogEntry {at:number;action:UiAction;state:ActionView['state']}
export interface ActionRunner {
  /** Starts one explicit user action. Returns undefined when the slot is busy or too many requests are pending. */
  run<A extends UiAction>(action:A,input:UiActionInput<A>,options?:{slot?:string;taskId?:string}):Promise<ActionResult>|undefined;
  outcome(slot:string):ActionView|undefined;
  busy(slot:string):boolean;
  pendingCount():number;
  /** Requests whose UI deadline passed while the transport has not settled; their outcome stays unknown. */
  abandonedCount():number;
  /** Operational log: action names and states only — never inputs, prompts, paths or secrets. */
  log():readonly ActionLogEntry[];
  subscribe(listener:()=>void):()=>void;
  /** Requests of this effect kind that are live or timed out but not yet settled by the transport. */
  unsettled(effect:Effect):number;
  /** Settings writes dispatched so far; a settings read observed before the latest write is stale. */
  writeCount():number;
  /** Shared bound on outstanding reads, so repeated reloads, boundaries and remounts cannot pile up transport calls. */
  reads:ReadGate;
  /**
   * Drops every stored outcome under a namespace and fences it: results that settle later are not stored, and an
   * unsettled effect still blocks the same control in a newer namespace until its transport settles (no replay).
   */
  retire(prefix:string):void;
  /**
   * The live handle of a namespace, shared by every scoped runner issued for it until it is retired. Retirement is
   * permanent for that handle, so a stale scoped runner never dispatches again even after its fence is pruned.
   * Only live handles are kept; nothing is remembered per retired prefix.
   */
  handle(prefix:string):NamespaceHandle;
  /** Stable namespace for `family` while `key` stays the same; a new key retires the old namespace and never reuses it. */
  namespace(family:string,key:string):string;
}
export interface NamespaceHandle {readonly prefix:string;retired():boolean}
export type SetTimer=(fn:()=>void,ms:number)=>()=>void;
const defaultTimer:SetTimer=(fn,ms)=>{const t=setTimeout(fn,ms);return ()=>clearTimeout(t);};
export interface RunnerOptions {request?:ExtensionRequest;maxPending?:number;timeoutMs?:number;newRequestId?:()=>string;clock?:()=>number;setTimer?:SetTimer;maxReads?:number}
export const runnerLimits={maxPending:4,timeoutMs:30000,log:20,maxAbandoned:8,recoveryPending:1,recoveryAbandoned:2,maxReads:6};
/**
 * Recovery actions use a separate lane, so hung ordinary calls never block them. They only restore the normal
 * state and carry no authority, so a repeat after an unknown outcome is harmless; the lane is still bounded.
 */
export const recoveryActions:readonly UiAction[]=['cursor/restore'];
const prefixOf=(slot:string)=>{const i=slot.lastIndexOf('|');return i<0?'':slot.slice(0,i);};
const tailOf=(slot:string)=>slot.slice(slot.lastIndexOf('|')+1);
const slotAction=(slot:string)=>tailOf(slot).split(':')[0];

/**
 * One transport call per read key until that call settles, even after its UI deadline (the desktop bridge ignores
 * abort), and a fixed total. A refused read sends nothing.
 */
export interface ReadGate {
  /** No new call for this key now: its last call is unsettled or the gate is full. */
  busy(key:string):boolean;
  /** This key's last call has not settled at the transport. */
  open(key:string):boolean;
  unsettled():number;start(key:string):(()=>void)|undefined}
export function createReadGate(max:number=runnerLimits.maxReads,notify:()=>void=()=>{}):ReadGate {
  const open=new Set<string>();
  return {
    busy:key=>open.has(key)||open.size>=max,
    open:key=>open.has(key),
    unsettled:()=>open.size,
    start(key){
      if(open.has(key)||open.size>=max)return undefined;
      open.add(key);notify();let done=false;
      return ()=>{if(done)return;done=true;open.delete(key);notify();};
    },
  };
}
export function createActionRunner(options:RunnerOptions={}):ActionRunner {
  const request=options.request??defaultExtensionRequest,maxPending=Math.max(1,Math.min(options.maxPending??runnerLimits.maxPending,8));
  const timeoutMs=Math.max(1000,Math.min(options.timeoutMs??runnerLimits.timeoutMs,120000));
  const newId=options.newRequestId??(()=>'ui-'+crypto.randomUUID()),clock=options.clock??Date.now,setTimer=options.setTimer??defaultTimer;
  type Lane={live:Set<string>;abandoned:Map<string,string>;maxLive:number;maxAbandoned:number;repeatable:boolean};
  const ordinary:Lane={live:new Set(),abandoned:new Map(),maxLive:maxPending,maxAbandoned:runnerLimits.maxAbandoned,repeatable:false};
  const recovery:Lane={live:new Set(),abandoned:new Map(),maxLive:runnerLimits.recoveryPending,maxAbandoned:runnerLimits.recoveryAbandoned,repeatable:true};
  const laneOf=(slot:string)=>(recoveryActions as readonly string[]).includes(slotAction(slot))?recovery:ordinary;
  const unsettledSlots=()=>[...ordinary.live,...ordinary.abandoned.values(),...recovery.live,...recovery.abandoned.values()];
  const retired=new Set<string>();
  // A fenced namespace is forgotten once nothing under it can still settle.
  const prune=()=>{if(!retired.size)return;const open=new Set(unsettledSlots().map(prefixOf));for(const p of[...retired])if(!open.has(p))retired.delete(p);};
  // An unsettled effect keeps its control closed until the transport settles, including from a retired namespace.
  const busy=(slot:string)=>{const lane=laneOf(slot);if(lane.live.has(slot)||lane.live.size>=lane.maxLive||lane.abandoned.size>=lane.maxAbandoned)return true;
    if(lane.repeatable)return false;const tail=tailOf(slot);
    return [...lane.live,...lane.abandoned.values()].some(s=>s===slot||(tailOf(s)===tail&&retired.has(prefixOf(s))));};
  const views=new Map<string,ActionView>(),listeners=new Set<()=>void>();let entries:ActionLogEntry[]=[],writes=0;
  const notify=()=>{for(const l of[...listeners])l();};
  const record=(slot:string,view:ActionView)=>{if(retired.has(prefixOf(slot)))return;views.set(slot,view);entries=[...entries,{at:clock(),action:view.action,state:view.state}].slice(-runnerLimits.log);notify();};
  // Live handles only: retiring one flips it permanently and forgets it.
  const handles=new Map<string,{retired:boolean}>();
  const retire=(prefix:string)=>{const live=handles.get(prefix);if(live){live.retired=true;handles.delete(prefix);}
    for(const slot of[...views.keys()])if(prefixOf(slot)===prefix)views.delete(slot);retired.add(prefix);prune();};
  const spaces=new Map<string,{key:string;prefix:string}>();let spaceCount=0;
  return {
    run(action,input,opts={}){
      const slot=opts.slot??action;
      if(retired.has(prefixOf(slot))||busy(slot))return undefined;
      const requestId=newId();
      const parsed=uiActionSchemas[action].safeParse(input);
      if(!parsed.success){
        const fields=[...new Set(parsed.error.issues.map(i=>i.path.join('.')||'input'))].slice(0,4).join(', ');
        const result:ActionResult={action,requestId,state:'invalid',message:'Check '+displayText(fields,80)+'. Nothing was sent.'};
        record(slot,result);return Promise.resolve(result);
      }
      const [feature,name]=action.split('/') as [ExtensionFeature,string];
      if(taskScopedActions.includes(action)&&!opts.taskId){
        const result:ActionResult={action,requestId,state:'invalid',message:'Choose a task first. Nothing was sent.'};record(slot,result);return Promise.resolve(result);
      }
      const envelope={requestId,...(taskScopedActions.includes(action)?{taskId:opts.taskId}:{}),input:parsed.data};
      const lane=laneOf(slot),controller=new AbortController();
      if(actionEffect(action)==='settings')writes++;
      lane.live.add(slot);record(slot,{action,requestId,state:'pending',message:'Waiting for a service receipt…'});
      return new Promise<ActionResult>(resolve=>{
        let settled=false;
        // The UI deadline is independent of the transport: the desktop bridge ignores abort and may never settle.
        const cancelTimer=setTimer(()=>{
          if(settled)return;settled=true;controller.abort();lane.live.delete(slot);lane.abandoned.set(requestId,slot);
          const result=unconfirmedResult(action,requestId,'No receipt within '+Math.round(timeoutMs/1000)+' s.');record(slot,result);resolve(result);
        },timeoutMs);
        Promise.resolve().then(()=>request('POST',extensionRoutes.action(feature,name),envelope,controller.signal))
          .catch((e):ExtensionReply=>({ok:false,message:errorText(e)}))
          .then(reply=>{
            const result=interpretReply(action,requestId,reply);
            // Record before pruning: a result under a retired namespace is dropped, never stored.
            if(!settled){settled=true;cancelTimer();lane.live.delete(slot);record(slot,result);prune();notify();resolve(result);return;}
            // Late reply: frees the abandoned slot but never upgrades the shown outcome, and only touches it while current.
            lane.abandoned.delete(requestId);prune();
            if(views.get(slot)?.requestId!==requestId){notify();return;}
            record(slot,unconfirmedResult(action,requestId,result.state==='completed'||result.state==='queued'
              ?'A receipt arrived after the time limit and is not treated as confirmation here. Check status first.'
              :'The late reply did not confirm an outcome.'));
          });
      });
    },
    outcome:slot=>views.get(slot),
    busy,
    pendingCount:()=>ordinary.live.size+recovery.live.size,
    abandonedCount:()=>ordinary.abandoned.size+recovery.abandoned.size,
    log:()=>entries,
    subscribe(listener){listeners.add(listener);return ()=>{listeners.delete(listener);};},
    unsettled:effect=>unsettledSlots().filter(s=>actionEffect(slotAction(s) as UiAction)===effect).length,
    writeCount:()=>writes,
    reads:createReadGate(Math.max(1,Math.min(options.maxReads??runnerLimits.maxReads,16)),notify),
    retire,
    handle(prefix){
      let state=handles.get(prefix);if(!state){state={retired:false};handles.set(prefix,state);}
      const own=state;return {prefix,retired:()=>own.retired};
    },
    namespace(family,key){
      const current=spaces.get(family);if(current?.key===key)return current.prefix;
      if(current)retire(current.prefix);
      const prefix=family.replace(/\|/g,'')+'#'+(++spaceCount);spaces.set(family,{key,prefix});return prefix;
    },
  };
}
/**
 * Same runner with every slot namespaced, so outcomes from an older privacy epoch are never shown in a newer one.
 * Once its namespace is retired this handle starts nothing, ever; its earlier requests still settle and free capacity.
 */
export function scopedRunner(runner:ActionRunner,prefix:string):ActionRunner {
  if(prefix.includes('|'))throw new Error('Runner namespaces cannot contain "|".');
  const at=(slot:string)=>prefix+'|'+slot,own=runner.handle(prefix);
  return {...runner,run:(action,input,opts={})=>own.retired()?undefined:runner.run(action,input,{...opts,slot:at(opts.slot??action)}),
    outcome:slot=>own.retired()?undefined:runner.outcome(at(slot)),busy:slot=>own.retired()||runner.busy(at(slot))};
}

// ---- privacy epoch ---------------------------------------------------------------------------
/**
 * Trusted privacy epoch from the main renderer: it changes on every private on/off boundary, Stop and close.
 * A boolean alone cannot tell one private session from the next, so private flows need the epoch.
 */
export type PrivacyEpoch=string|number;
export interface PrivacyScope {epoch?:PrivacyEpoch;privateSession:boolean}
export const scopeKey=(scope:PrivacyScope)=>(scope.privateSession?'private@':'public@')+(scope.epoch===undefined?'-':String(scope.epoch));
export const privateFlowsAllowed=(scope:PrivacyScope)=>!scope.privateSession||scope.epoch!==undefined;
export const missingEpochMessage='Private session without a trusted privacy epoch: private review and drafting are unavailable here.';

// ---- reads ---------------------------------------------------------------------------------------
export type ReadView<T>={kind:'unchecked'}|{kind:'loading'}|{kind:'ready';data:T;observedAt:number}|{kind:'unsupported';message:string}|{kind:'error';message:string};
/** `gate` bounds outstanding transport calls; pass the shared runner's `reads` from the UI. */
export interface ReadOptions {timeoutMs?:number;setTimer?:SetTimer;gate?:ReadGate}
/** Gate key of each read: one outstanding transport call per key. */
export const readKey=(route:string)=>'read '+route;
export const contactReviewKey=readKey(extensionRoutes.contactReview);
/**
 * Sends once and settles by the deadline even when the transport never does; a late reply is dropped. The gate slot
 * is held until the transport itself settles, so a deadline frees the UI but never permits an unbounded resend.
 */
function bounded(key:string,send:(signal:AbortSignal)=>Promise<ExtensionReply>,options:ReadOptions={}):Promise<ExtensionReply|'timeout'|'busy'> {
  const release=options.gate?options.gate.start(key):()=>{};
  if(!release)return Promise.resolve('busy');
  const controller=new AbortController(),setTimer=options.setTimer??defaultTimer;
  return new Promise(resolve=>{
    let settled=false;
    const cancel=setTimer(()=>{if(!settled){settled=true;controller.abort();resolve('timeout');}},options.timeoutMs??runnerLimits.timeoutMs);
    Promise.resolve().then(()=>send(controller.signal)).catch((e):ExtensionReply=>({ok:false,message:errorText(e)}))
      .then(reply=>{release();if(!settled){settled=true;cancel();resolve(reply);}});
  });
}
const readBusyText=' An earlier read has not settled yet, so nothing was sent. Try again once it finishes.';
async function read<T>(request:ExtensionRequest,route:string,schema:z.ZodType<T>,label:string,clock:()=>number,options?:ReadOptions):Promise<ReadView<T>> {
  const reply=await bounded(readKey(route),signal=>request('GET',route,undefined,signal),options);
  if(reply==='busy')return {kind:'error',message:label+' was not read.'+readBusyText+' Status is unknown.'};
  if(reply==='timeout')return {kind:'error',message:label+' could not be read: no reply in time. Status is unknown.'};
  if(!reply.ok){const hint=safeFailureText(reply);return notFound(reply)?{kind:'unsupported',message:olderServiceMessage}:{kind:'error',message:label+' could not be read'+(hint?': '+hint:'.')+' Status is unknown.'};}
  const parsed=schema.safeParse(reply.body);
  return parsed.success?{kind:'ready',data:parsed.data,observedAt:clock()}:{kind:'error',message:label+' reply was not recognized. Status is unknown; nothing is shown as ready.'};
}
export const readExtensionStatus=(request:ExtensionRequest,clock:()=>number=Date.now,options?:ReadOptions)=>read<ExtensionStatus>(request,extensionRoutes.status,ExtensionStatusSchema,'Extension status',clock,options);
export const readExtensionSettings=(request:ExtensionRequest,clock:()=>number=Date.now,options?:ReadOptions)=>read(request,extensionRoutes.settings,ExtensionSettingsSchema,'Extension settings',clock,options);
export const readCodexConnection=(request:ExtensionRequest,clock:()=>number=Date.now,options?:ReadOptions)=>read(request,extensionRoutes.codexConnection,CodexConnectionSchema,'Codex connection',clock,options);
export const readOverview=<F extends OverviewFeature>(request:ExtensionRequest,feature:F,clock:()=>number=Date.now,options?:ReadOptions)=>
  read<z.infer<typeof overviewSchemas[F]>>(request,extensionRoutes.overview[feature],overviewSchemas[feature] as any,'Details',clock,options);

const label=z.string().max(120);
const SkillStateSchema=z.enum(['ready','disabled','unreviewed','invalid-review','changed','revoked','local-only','missing-capability','missing-dependency','verification-required']);
export const SkillCatalogSchema=z.object({skills:z.array(z.object({
  skillId:id,version:id,name:label,manifestSha256:Sha256Schema,provenance:z.object({kind:z.enum(['built-in','user-authored'])}),
  private:z.boolean(),state:SkillStateSchema,localOnly:z.boolean(),paidTools:z.array(z.string().max(64)).max(32),
  missing:z.object({capabilities:z.array(z.string().max(200)).max(32),dependencies:z.array(z.string().max(200)).max(64),checks:z.array(z.string().max(200)).max(32)}),
  draft:z.boolean().optional(),manifest:SkillManifestSchema.optional(),
})).max(200)});
export type SkillCatalogEntry=z.infer<typeof SkillCatalogSchema>['skills'][number];
export const SecurityOverviewSchema=z.object({
  profile:z.enum(['user','development','self-test']),jobs:z.array(SecurityJobSchema).max(50),
  schedule:z.object({nextDueAt:z.number().int().nonnegative().nullable(),deferred:z.boolean()}).optional(),
});
export const ContactsOverviewSchema=z.object({
  providers:z.array(z.object({channel:z.enum(['gmail','sms','voice','whatsapp']),configured:z.boolean(),secretStored:z.boolean(),senderHint:label.optional()})).max(4),
  routes:z.array(z.object({id,revision:z.number().int().positive(),channel:z.enum(['gmail','sms','voice','whatsapp','android']),kind:z.enum(['self','contact']),label,enabled:z.boolean(),verified:z.boolean(),verificationExpiresAt:z.number().int().nonnegative().optional()})).max(100),
  rules:z.array(z.object({id,routeId:id,workflowId:id,templateId:id,expiresAt:z.number().int().nonnegative(),revoked:z.boolean()})).max(100),
  // No monthly-count budget is read or shown: the enforced limits come from the administration status.
  outbox:z.array(z.object({receipt:DeliveryReceiptSchema,channel:z.enum(['gmail','sms','voice','whatsapp','android']),routeLabel:label.optional(),draftKept:z.boolean(),approvalRequired:z.boolean()})).max(100),
});
export const AgentsOverviewSchema=z.object({
  tasks:z.array(z.object({id,label})).max(50),workspaces:z.array(z.object({id,label})).max(32),
  grants:z.array(z.object({taskId:id,providers:z.array(AgentProviderSchema).max(2),workspaceIds:z.array(id).max(32),allowPaid:z.boolean(),expiresAt:z.number().int().nonnegative(),revoked:z.boolean()})).max(50),
  jobs:z.array(AgentJobSchema).max(50),
});
export const overviewSchemas={skills:SkillCatalogSchema,security:SecurityOverviewSchema,contacts:ContactsOverviewSchema,agents:AgentsOverviewSchema} as const;

// ---- contact exact review --------------------------------------------------------------------
/**
 * Reply of POST extensionRoutes.contactReview with envelope {requestId,input:{outboxRequestId,privacyEpoch}}.
 * Shown only in the panel: never logged, never put in runner outcomes, discarded on any refresh or epoch change.
 */
export const ContactReviewSchema=ContactExactReviewSchema;
export type ContactReview=z.infer<typeof ContactReviewSchema>&{localEpoch?:PrivacyEpoch};
/**
 * The host-verified approved WhatsApp text inside a WhatsApp exact review's message body. A ContentSid alone is not
 * the recipient's message, so a WhatsApp review that does not carry this exact shape is not shown or approvable.
 */
export const WhatsAppReviewSchema=z.object({renderedText:z.string().min(1).max(1600),contentSid:z.string().regex(/^HX[0-9a-fA-F]{32}$/),
  variables:z.record(z.string().regex(/^[1-9][0-9]{0,2}$/),z.string().max(1600)),language:z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),templateSha256:Sha256Schema}).strict();
export type WhatsAppReview=z.infer<typeof WhatsAppReviewSchema>;
export function whatsAppReview(review:Pick<ContactReview,'channel'|'content'>):WhatsAppReview|undefined {
  if(review.channel!=='whatsapp'||review.content.kind!=='message')return undefined;
  try{const parsed=WhatsAppReviewSchema.safeParse(JSON.parse(review.content.body));return parsed.success?parsed.data:undefined;}catch{return undefined;}
}
export type ReviewView={kind:'ready';review:ContactReview}|{kind:'unsupported'|'error';message:string};
const sameBinding=(a:ContactBinding,b:ContactBinding)=>(Object.keys(a) as (keyof ContactBinding)[]).every(k=>a[k]===b[k])&&Object.keys(a).length===Object.keys(b).length;
/** Reads the exact details for one outbox request. A reply for another request, binding or epoch is refused. */
export async function readContactReview(request:ExtensionRequest,outbox:DeliveryReceipt,privacyEpoch:PrivacyEpoch,options:ReadOptions&{newRequestId?:()=>string;privateSession?:boolean;current?:()=>boolean}={}):Promise<ReviewView> {
  const requestId=(options.newRequestId??(()=>'ui-'+crypto.randomUUID()))();let epoch:string|undefined;
  const reply=await bounded(contactReviewKey,async signal=>{
    const session=await request('GET','/v1/extensions/session',undefined,signal);
    const parsed=z.object({protocol:z.literal('capri-private-v1'),privacyEpoch:z.uuid(),privateSession:z.boolean(),revision:z.number().int().nonnegative()}).strict().safeParse(session.body);
    if(!session.ok||!parsed.success||parsed.data.privateSession!==!!options.privateSession||options.current?.()===false||signal.aborted)return {ok:false,message:'Current contact review session unavailable.'};
    epoch=parsed.data.privacyEpoch;
    return request('POST',extensionRoutes.contactReview,{requestId,input:{outboxRequestId:outbox.requestId,privacyEpoch:epoch}},signal);
  },options);
  if(reply==='busy')return {kind:'error',message:'Exact message details were not read.'+readBusyText+' Approval stays off.'};
  if(reply==='timeout')return {kind:'error',message:'Exact message details did not arrive in time. Approval stays off.'};
  if(!reply.ok)return notFound(reply)?{kind:'unsupported',message:'This service cannot show the exact message yet, so approval is unavailable. Nothing was approved.'}
    :{kind:'error',message:'Exact message details could not be read.'+(safeFailureText(reply)?' '+safeFailureText(reply):'')+' Approval stays off.'};
  const parsed=ContactReviewSchema.safeParse(reply.body);
  if(!parsed.success)return {kind:'error',message:'Exact message details were not recognized. Approval stays off.'};
  const review=parsed.data;
  if(options.current?.()===false||review.expiresAt<=Date.now()||review.requestId!==outbox.requestId||review.privacyEpoch!==epoch||!sameBinding(review.binding,outbox.binding))
    return {kind:'error',message:'The details did not match this message or session. Approval stays off.'};
  if(review.channel==='whatsapp'&&!whatsAppReview(review))
    return {kind:'error',message:'The approved WhatsApp template text could not be shown, so this message cannot be approved. Recheck the template in setup.'};
  return {kind:'ready',review:{...review,localEpoch:privacyEpoch}};
}
/** Current only for the same outbox request, binding and privacy epoch. Any refresh or boundary drops it upstream. */
export const reviewCurrent=(review:ContactReview|undefined,outbox:DeliveryReceipt,privacyEpoch:PrivacyEpoch|undefined):review is ContactReview=>
  !!review&&privacyEpoch!==undefined&&review.localEpoch===privacyEpoch&&review.expiresAt>Date.now()&&review.requestId===outbox.requestId&&outbox.state==='pending'&&sameBinding(review.binding,outbox.binding);
export const approvalInput=(review:ContactReview):UiActionInput<'contacts/approve'>=>({requestId:review.requestId,reviewId:review.reviewId,reviewDigest:review.reviewDigest,revision:review.revision,
  routeId:review.binding.routeId,routeRevision:review.binding.routeRevision,bodySha256:review.binding.bodySha256,privacyEpoch:review.privacyEpoch});
/** Live trusted inputs, passed on every render: the service capabilities and the main renderer's privacy epoch. */
export interface ContactReviewScope {epoch?:PrivacyEpoch;privateSession?:boolean;reviewAllowed:boolean;approveAllowed:boolean}
export interface ContactReviewSnapshot {review?:ContactReview;reviewing:string|null;notes:Readonly<Record<string,string>>}
/**
 * The exact-message preview state behind the approval button. A preview exists only between a successful matching
 * detail read and the next refresh start, failure, edit, capability withdrawal, epoch change, approval click or close.
 * Approval checks the latest synced capabilities, never a caller's earlier view; the service still revalidates.
 */
export interface ContactReviewController {
  /** Called on every render. Withdrawing either capability or changing the epoch discards the preview; returns true then. */
  sync(scope:ContactReviewScope):boolean;
  snapshot():ContactReviewSnapshot;
  /** The preview to show for this row, only while it is current and review is still offered. */
  current(outbox:DeliveryReceipt):ContactReview|undefined;
  canApprove(outbox:DeliveryReceipt):boolean;
  /** Clears any earlier preview synchronously, then reads; one read at a time through the shared gate. */
  load(outbox:DeliveryReceipt):Promise<void>;
  /** Consumes the preview and returns its bound input, or undefined when approval is not currently allowed. */
  approve(outbox:DeliveryReceipt):UiActionInput<'contacts/approve'>|undefined;
  invalidate():void;
  /** Irreversible; pending reads are ignored. */
  close():void;
  closed():boolean;
  subscribe(listener:()=>void):()=>void;
}
export function createContactReviewController(options:{request:ExtensionRequest;gate:ReadGate;scope:ContactReviewScope}&Omit<ReadOptions,'gate'>&{newRequestId?:()=>string}):ContactReviewController {
  const listeners=new Set<()=>void>(),notify=()=>{for(const l of[...listeners])l();};
  let scope=options.scope,generation=0,closed=false,review:ContactReview|undefined,reviewing:string|null=null,notes:Record<string,string>={},cancelExpiry:(()=>void)|undefined;
  const drop=()=>{cancelExpiry?.();cancelExpiry=undefined;generation++;review=undefined;reviewing=null;notes={};};
  const live=()=>!closed&&scope.reviewAllowed&&scope.epoch!==undefined;
  const controller:ContactReviewController={
    sync(next){
      if(closed)return false;
      const changed=next.epoch!==scope.epoch||!!next.privateSession!==!!scope.privateSession||(scope.reviewAllowed&&!next.reviewAllowed)||(scope.approveAllowed&&!next.approveAllowed);
      scope=next;if(!changed)return false;drop();return true;
    },
    snapshot:()=>({review,reviewing,notes}),
    current:outbox=>live()&&reviewCurrent(review,outbox,scope.epoch)?review:undefined,
    canApprove:outbox=>live()&&scope.approveAllowed&&reviewing===null&&reviewCurrent(review,outbox,scope.epoch),
    async load(outbox){
      if(!live()||reviewing!==null||options.gate.busy(contactReviewKey))return;
      const epoch=scope.epoch!,key=outbox.requestId;
      drop();const mine=generation;reviewing=key;notify();
      const view=await readContactReview(options.request,outbox,epoch,{gate:options.gate,timeoutMs:options.timeoutMs,setTimer:options.setTimer,newRequestId:options.newRequestId,
        privateSession:scope.privateSession,current:()=>mine===generation&&!closed&&live()&&scope.epoch===epoch});
      if(mine!==generation||closed)return;
      reviewing=null;
      // Capabilities or epoch may have changed while reading; sync() would already have bumped the generation then.
      if(view.kind==='ready'&&live()&&scope.epoch===epoch){
        review=view.review;
        cancelExpiry=(options.setTimer??defaultTimer)(()=>{if(mine===generation){drop();notes={[key]:'Exact review expired. Show the message again. Approval stays off.'};notify();}},Math.max(0,review.expiresAt-Date.now()));
      }
      else notes={[key]:view.kind==='ready'?'Exact message review is no longer available. Approval stays off.':view.message};
      notify();
    },
    approve(outbox){
      if(!controller.canApprove(outbox))return undefined;
      const input=approvalInput(review!);drop();notify();return input;
    },
    invalidate(){if(closed)return;drop();notify();},
    close(){if(closed)return;closed=true;drop();notify();},
    closed:()=>closed,
    subscribe(listener){listeners.add(listener);return ()=>{listeners.delete(listener);};},
  };
  return controller;
}

// ---- contact administration (desktop main-owner bridge only) ----------------------------------
/**
 * Credentials, recipients, verification, limits, templates, workflows and rules go only through the main view's
 * injected window.capri.agency('contacts', request) bridge; the service supplies session UUID, signal and authority.
 * `expectedRevision` is the revision of the last administration status this view observed.
 */
export type ContactAdminRequest=z.input<typeof ContactAdminRequestSchema>;
/**
 * The dispatching view's privacy epoch and liveness. The bridge rechecks both immediately before the IPC call (after
 * any privacy synchronization) and throws ContactAdminNotDispatched instead of acting for a retired view.
 */
export interface ContactAdminFence {epoch?:PrivacyEpoch;live:()=>boolean}
export type ContactAdminBridge=(request:ContactAdminRequest,fence:ContactAdminFence)=>Promise<unknown>;
/** Thrown by a trusted bridge that refused to dispatch because its view or privacy epoch was retired first. */
export class ContactAdminNotDispatched extends Error {constructor(){super('Contact administration was not dispatched.');this.name='ContactAdminNotDispatched';}}
/**
 * The main window's bridge: waits for the existing privacy synchronization, then dispatches only if the requesting
 * view is still live and its epoch is still the renderer's current privacy epoch (Stop and privacy changes advance it).
 */
export function createMainContactBridge(options:{agency:(request:ContactAdminRequest)=>Promise<unknown>;epoch:()=>PrivacyEpoch;privacySync:()=>Promise<unknown>}):ContactAdminBridge {
  return async(request,fence)=>{
    const current=()=>fence.epoch===options.epoch()&&fence.live();
    if(!current())throw new ContactAdminNotDispatched();
    // A failed privacy synchronization dispatches nothing: the owner's session state could be stale.
    try{await options.privacySync();}catch{throw new ContactAdminNotDispatched();}
    if(!current())throw new ContactAdminNotDispatched();
    return options.agency(request);
  };
}
export const contactSetupUnavailableMessage='Contact setup is available only in the Capri desktop window. This view can still change the messaging switches, read the outbox and review exact messages, but it never handles provider credentials, recipients or verification codes.';
export const contactChannels=['gmail','sms','voice','whatsapp','android'] as const;
export type ContactChannel=typeof contactChannels[number];
const adminChannel=z.enum(contactChannels),adminRevision=z.number().int().positive().safe();
const validTimeZone=(value:string)=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}};
/** Mirrors the server's enforced per-channel limits exactly; tests compare it with the real schema. */
export const ContactLimitsViewSchema=z.object({enabled:z.boolean(),unitCostMicros:z.number().int().nonnegative().max(1e9).default(0),maxDispatchCostMicros:z.number().int().nonnegative().max(1e9),
  dailyBudgetMicros:z.number().int().nonnegative().max(1e12),maxPerMinute:z.number().int().min(1).max(60),maxPerDay:z.number().int().min(1).max(1000),
  quietHours:z.object({startMinute:z.number().int().min(0).max(1439),endMinute:z.number().int().min(0).max(1439),timeZone:z.string().min(1).max(100).refine(validTimeZone)}).strict().optional()}).strict();
export type ContactLimits=z.output<typeof ContactLimitsViewSchema>;
/**
 * Strict browser-safe projection of the administration status. It carries only bounded IDs, revisions, flags and
 * limits; a reply with any other field (sender, client ID, account SID, token, destination, template body) is refused.
 */
export const ContactAdminStatusViewSchema=z.object({revision:adminRevision,state:z.enum(['ready','review-required','retention-required']),
  channels:z.array(z.object({channel:adminChannel,configured:z.boolean(),enabled:z.boolean(),ready:z.boolean(),secretStored:z.boolean(),limits:ContactLimitsViewSchema}).strict()).max(5),
  routes:z.array(z.object({id,revision:adminRevision,channel:adminChannel,kind:z.enum(['self','contact']),enabled:z.boolean(),optedIn:z.boolean(),verified:z.boolean(),verificationExpiresAt:TimestampSchema.optional()}).strict()).max(100),
  templates:z.array(z.object({id,revision:adminRevision,enabled:z.boolean()}).strict()).max(100),
  workflows:z.array(z.object({id,revision:adminRevision,enabled:z.boolean(),trigger:z.enum(['on-demand','task-completed'])}).strict()).max(100),
  rules:z.array(z.object({id,revoked:z.boolean(),expiresAt:TimestampSchema}).strict()).max(100),
  oauthPending:z.boolean(),billing:z.literal('local-conservative-estimate')}).strict();
export type ContactAdminStatus=z.infer<typeof ContactAdminStatusViewSchema>;
const ChallengeViewSchema=z.object({challengeId:id,requestId:id,expiresAt:TimestampSchema}).strict();
export type ContactChallenge=z.infer<typeof ChallengeViewSchema>;
const remoteSources=['service-receipt','observed-record'];
const VerificationReceiptViewSchema=z.object({kind:z.literal('verification'),requestId:id,challengeId:id,receiptId:id,adapter:id,state:DeliveryReceiptSchema.shape.state,observedAt:TimestampSchema,
  evidence:DeliveryReceiptSchema.shape.evidence}).strict().refine(r=>!['accepted','sent','delivered'].includes(r.state)||remoteSources.includes(r.evidence.source));
export const ContactAdminReplyViewSchema=z.object({requestId:id.optional(),receipt:ActionReceiptSchema.optional(),status:ContactAdminStatusViewSchema.optional(),intent:ContactIntentSchema.optional(),
  challenge:ChallengeViewSchema.optional(),result:z.union([ActionReceiptSchema,DeliveryReceiptSchema,VerificationReceiptViewSchema]).optional()}).strict()
  .refine(v=>!!v.receipt||!!v.requestId&&!!v.status);
const emptyInput=z.object({}).strict(),hx=z.string().regex(/^HX[0-9a-fA-F]{32}$/);
/** Local mirror of the strict administration inputs (keys excluded). The desktop owner validates everything again. */
export const contactAdminInputSchemas={
  'recover-setup':z.object({confirmation:z.literal('disable-unprovable-permissions')}).strict(),
  'configure-gmail':z.object({clientId:z.string().min(1).max(512).regex(/^[A-Za-z0-9._-]+$/),sender:z.string().min(1).max(254)}).strict(),
  'connect-gmail':emptyInput,'cancel-gmail':emptyInput,'disconnect-gmail':emptyInput,
  'configure-twilio':z.object({accountSid:z.string().regex(/^AC[0-9a-fA-F]{32}$/),authToken:z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/),sender:z.string().min(1).max(254),voiceEnabled:z.boolean()}).strict(),
  'disable-twilio':emptyInput,
  'save-route':z.object({routeId:id.optional(),channel:adminChannel,destination:z.string().min(1).max(254),kind:z.enum(['self','contact']),optedIn:z.boolean()}).strict(),
  'disable-route':z.object({routeId:id}).strict(),
  'verify-begin':z.object({routeId:id}).strict(),
  'verify-complete':z.object({routeId:id,challengeId:id,code:z.string().regex(/^\d{6}$/)}).strict(),
  'set-limits':z.object({channel:adminChannel,limits:ContactLimitsViewSchema}).strict(),
  'save-template':z.object({templateId:id.optional(),definition:z.object({enabled:z.boolean(),body:z.string().min(1).max(1600),subject:z.string().max(200).refine(v=>!/[\r\n]/.test(v)).optional(),
    contentClass:z.enum(['public','personal','private']),maxVoiceSeconds:z.number().int().min(1).max(120).optional(),whatsappSid:hx.optional()}).strict()}).strict(),
  'save-workflow':z.object({workflowId:id.optional(),definition:z.object({enabled:z.boolean(),trigger:z.enum(['on-demand','task-completed']),routeId:id,templateId:id}).strict()}).strict(),
  'recheck-whatsapp':z.object({contentSid:hx,language:z.string().min(2).max(10)}).strict(),
  'add-rule':z.object({outboxRequestId:id,review:ContactReviewApprovalInputSchema,expiresAt:TimestampSchema}).strict(),
  'revoke-rule':z.object({ruleId:id}).strict(),
  'prepare-rule':z.object({workflowId:id,completion:z.enum(['verified','unverified'])}).strict(),
  // Settings-started requests are never task scoped: no task ID is accepted from this view.
  'prepare-notification':z.object({workflowId:id}).strict(),
  'reconcile':z.object({outboxRequestId:id}).strict(),
} as const;
export type ContactAdminAction=keyof typeof contactAdminInputSchemas;
export type ContactAdminFields<A extends ContactAdminAction>=z.input<typeof contactAdminInputSchemas[A]>;
/** Allowed by the owner during a private session; every other administration change waits for it to end. */
export const privateContactAdminActions:readonly ContactAdminAction[]=['cancel-gmail','prepare-notification'];
/** Maximum exact-rule lifetime accepted by the owner. */
export const contactRuleMaxDays=30;

export type ContactAdminNoteState='pending'|'completed'|'rejected'|'conflict'|'unconfirmed'|'invalid';
/** Validated, correlated nested evidence. Only fixed codes and identities: never provider or service text. */
export interface ContactEvidence {kind:'delivery'|'verification';requestId:string;state:DeliveryReceipt['state'];adapter:string;remote:boolean;challengeId?:string}
export interface ContactAdminNote {action:ContactAdminAction|'status';requestId:string;state:ContactAdminNoteState;message:string;evidence?:ContactEvidence;
  /** The original outbox request this note concerns, for read-only reconciliation. */
  outboxRequestId?:string}
/**
 * `challenge` is set only for a provider-accepted challenge (the only kind a code can complete). `uncertainChallenge`
 * keeps the identities of a matching challenge whose dispatch is pending or unknown, for read-only reconciliation.
 */
export interface ContactAdminInterpretation {note:ContactAdminNote;status?:ContactAdminStatus;challenge?:ContactChallenge;uncertainChallenge?:ContactChallenge;intent?:ContactIntent}
const adminDone:Partial<Record<ContactAdminAction,string>>={
  'recover-setup':'Setup unlocked. Every earlier permission stays disabled: connect providers, set limits and verify recipients again. Nothing is configured or verified yet.',
  'configure-gmail':'Gmail client saved. Not connected yet: use Connect Gmail and finish Google sign-in in your browser.',
  'connect-gmail':'Google sign-in opened in your system browser. Gmail counts as connected only when setup status shows it.',
  'cancel-gmail':'Pending Google sign-in cancelled. Nothing was connected.',
  'disconnect-gmail':'Gmail disconnected and its stored authorization removed. Gmail recipients need verification again.',
  'configure-twilio':'Twilio credentials saved and read back from protected storage. This is not a provider test: each channel still needs limits and verified recipients.',
  'disable-twilio':'Twilio disabled and its stored token removed. SMS, voice and WhatsApp recipients need verification again.',
  'save-route':'Recipient saved but not verified. Any earlier verification and rules for an edited recipient no longer apply. Nothing was sent.',
  'disable-route':'Recipient disabled. Its rules were revoked.',
  'verify-complete':'Recipient verified: the service matched the code from its own challenge.',
  'set-limits':'Limits saved. Costs are local conservative estimates, not provider invoices.',
  'save-template':'Template saved as a new revision. Rules bound to it were revoked. Nothing was sent.',
  'save-workflow':'Workflow saved as a new revision. Rules bound to it were revoked. Nothing was sent.',
  'recheck-whatsapp':'Approved plain-text template read back and pinned for 24 hours. Nothing was sent, created or submitted.',
  'add-rule':'Exact rule saved for this recipient, workflow and template revision until it expires or you revoke it. Nothing was sent.',
  'revoke-rule':'Rule revoked.',
};
const voiceAdapter=(adapter:string)=>adapter==='twilio-voice';
/** Fixed text for correlated nested evidence. Accepted, sent, delivered and call connection stay distinct. */
export function contactEvidenceText(e:ContactEvidence):string {
  const voice=voiceAdapter(e.adapter),what=e.kind==='verification'?'verification challenge':voice?'call request':'message';
  switch(e.state){
    case 'accepted':return e.remote?'The provider accepted the '+what+' (provider receipt). '+(voice?'The call has not connected yet.':'Delivery is not observed yet.'):contactEvidenceText({...e,state:'unconfirmed'});
    case 'sent':return e.remote?(voice?'The provider reports the call in progress. That does not prove a person heard it.':'The provider reports the '+what+' sent. Delivery is not observed yet.'):contactEvidenceText({...e,state:'unconfirmed'});
    case 'delivered':return e.remote?(voice?'The provider reports the call connected and ended. It may have reached voicemail; this is not proof a person listened.':'The provider reports the '+what+' delivered.'):contactEvidenceText({...e,state:'unconfirmed'});
    case 'pending':return e.kind==='verification'?'The challenge is queued and not yet accepted by the provider. It is not resent; use Check provider record.':'Waiting for your exact approval in the outbox. Nothing was sent.';
    case 'rejected':return 'The '+what+' was rejected before dispatch or by the provider. The draft is kept; nothing is resent.';
    default:return 'The outcome of this '+what+' is unknown: it may or may not have been sent. Nothing is resent automatically; use Check provider record.';
  }
}
const evidenceOf=(r:DeliveryReceipt|z.infer<typeof VerificationReceiptViewSchema>,kind:ContactEvidence['kind']):ContactEvidence=>({kind,requestId:r.requestId,state:r.state,adapter:r.adapter,remote:remoteSources.includes(r.evidence.source),
  ...('challengeId' in r?{challengeId:r.challengeId}:{})});
const delivered=(e:ContactEvidence)=>e.remote&&['accepted','sent','delivered'].includes(e.state);
const unknownTail=(action:ContactAdminAction,which:string)=>' The outcome is unknown and nothing is retried. Read setup status'+
  (action==='verify-begin'?'. A code may have been sent; a new one is offered only after the earlier one would have expired.'
    :action==='prepare-rule'?'. A rule message may have been prepared; this workflow’s pending messages are not offered as send approvals until its purpose is known.'
    :['prepare-notification','reconcile'].includes(action)?' and use Check provider record'+which+'.':' before changing it again.');
/**
 * Interprets one administration reply for exactly this request. Success needs the matching receipt; sends, challenges
 * and reconciliation also need nested evidence correlated with the original request: the same request IDs, the
 * complete recipient/workflow/template/body binding and the requested workflow. No service text is kept.
 */
export function interpretContactAdminReply(request:{requestId:string;action:ContactAdminAction|'status';outboxRequestId?:string;workflowId?:string},body:unknown):ContactAdminInterpretation {
  const base={action:request.action,requestId:request.requestId};
  const unknown=(why:string,extra:Partial<ContactAdminNote>={}):ContactAdminNote=>({...base,state:'unconfirmed',message:why+(request.action==='status'?' Setup status is unknown.':unknownTail(request.action,' for the original request')),...extra});
  const parsed=ContactAdminReplyViewSchema.safeParse(body);
  if(!parsed.success)return {note:unknown('The reply was not recognized.')};
  const reply=parsed.data;
  if(request.action==='status'){
    if(reply.receipt||reply.requestId!==request.requestId||!reply.status)return {note:unknown('The reply did not match this request.')};
    return {note:{...base,state:'completed',message:'Setup status read.'},status:reply.status};
  }
  const r=reply.receipt;
  if(!r||r.requestId!==request.requestId||r.feature!=='contacts'||r.action!==request.action)return {note:unknown('The reply did not match this request.')};
  const status=reply.status;
  if(r.outcome==='rejected')return {status,note:r.error?.code==='conflict'
    ?{...base,state:'conflict',message:'Setup changed since this view read it, or this request was already used for something else. Nothing was changed. Review the refreshed setup before trying again.'}
    :{...base,state:'rejected',message:(errorHints[r.error?.code??'']??'Rejected.')+' Nothing was changed.'}};
  if(r.outcome==='cancelled')return {status,note:{...base,state:'rejected',message:'Cancelled before any effect. Nothing was changed.'}};
  if(r.outcome!=='completed')return {status,note:unknown('The desktop owner could not confirm it.')};
  switch(request.action){
    case 'verify-begin':{
      const c=reply.challenge,v=reply.result;
      if(!c||!v||!('kind' in v)||v.challengeId!==c.challengeId||v.requestId!==c.requestId)return {status,note:unknown('The challenge receipt did not match this request.')};
      const evidence=evidenceOf(v,'verification'),note:ContactAdminNote={...base,evidence,outboxRequestId:c.requestId,
        state:delivered(evidence)?'completed':evidence.state==='rejected'?'rejected':evidence.state==='pending'?'pending':'unconfirmed',
        message:contactEvidenceText(evidence)+(delivered(evidence)?' Enter the 6-digit code you received.':'')};
      return {status,note,challenge:delivered(evidence)?c:undefined,uncertainChallenge:!delivered(evidence)&&evidence.state!=='rejected'?c:undefined};
    }
    case 'prepare-notification':{
      const intent=reply.intent,a=reply.result;
      if(!intent||!a||!('feature' in a)||a.requestId!==intent.requestId||a.feature!=='contacts'||a.action!=='send'||intent.binding.workflowId!==request.workflowId||
        a.delivery&&(a.delivery.requestId!==intent.requestId||!sameBinding(a.delivery.binding,intent.binding)))
        return {status,intent,note:unknown('The send receipt did not match the prepared message.',intent?{outboxRequestId:intent.requestId}:{})};
      const evidence:ContactEvidence=a.delivery?evidenceOf(a.delivery,'delivery'):{kind:'delivery',requestId:intent.requestId,adapter:'contacts',remote:false,
        state:a.outcome==='pending'?'pending':a.outcome==='rejected'||a.outcome==='cancelled'?'rejected':'unconfirmed'};
      const state:ContactAdminNoteState=a.outcome==='completed'&&delivered(evidence)?'completed':evidence.state==='pending'?'pending':evidence.state==='rejected'?'rejected':'unconfirmed';
      return {status,intent,note:{...base,state,evidence,outboxRequestId:intent.requestId,message:contactEvidenceText(state==='unconfirmed'?{...evidence,state:'unconfirmed'}:evidence)}};
    }
    case 'prepare-rule':{
      const intent=reply.intent,d=reply.result;
      if(!intent||!d||!('binding' in d)||d.requestId!==intent.requestId||!sameBinding(d.binding,intent.binding)||intent.binding.workflowId!==request.workflowId)
        return {status,intent,note:unknown('The prepared message did not match this request.')};
      if(d.state!=='pending')return {status,intent,note:{...base,state:d.state==='rejected'?'rejected':'unconfirmed',outboxRequestId:intent.requestId,message:'The rule message could not be prepared for review. Nothing was sent.'}};
      return {status,intent,note:{...base,state:'completed',outboxRequestId:intent.requestId,message:'Exact rule message prepared. Nothing was sent. Load messaging details, show this exact message, then add the rule from the outbox.'}};
    }
    case 'reconcile':{
      const d=reply.result;
      if(!d||'feature' in d||d.requestId!==request.outboxRequestId)return {status,note:{...base,state:'unconfirmed',outboxRequestId:request.outboxRequestId,message:'No matching provider record could be read. Nothing was resent; the original request is unchanged.'}};
      const evidence=evidenceOf(d,'kind' in d?'verification':'delivery');
      return {status,note:{...base,state:'completed',evidence,outboxRequestId:request.outboxRequestId,message:'Read-only check: '+contactEvidenceText(evidence)}};
    }
    default:return {status,note:{...base,state:'completed',message:adminDone[request.action]??'Confirmed by the desktop owner.'}};
  }
}

export interface ContactAdminSnapshot {
  status:ReadView<ContactAdminStatus>;
  /** One administration request is outstanding at the bridge (possibly from an earlier mount); new ones wait. */
  busy:boolean;
  notes:Readonly<Record<string,ContactAdminNote>>;
  /** Challenges issued in this owner scope, by route ID. Only an accepted, current one takes a code (contactChallengeView). */
  challenges:Readonly<Record<string,ContactChallengeRecord>>;
  /** Verification requests whose reply carried no challenge identity, by route ID. */
  uncertain:Readonly<Record<string,ContactUncertainVerification>>;
  /** Exact-rule drafts prepared in this owner scope, by original outbox request ID. Survives Settings navigation. */
  prepared:Readonly<Record<string,string>>;
  /**
   * Exact-rule preparations without a matching settled receipt, by administration request ID → workflow ID. Recorded
   * before dispatch; while one is open, a pending approval for that workflow cannot be proved to be a send draft.
   */
  ruleFences:Readonly<Record<string,string>>;
  /** Sends in flight or whose outcome is pending or unknown, by workflow ID. No new send is offered until you release it. */
  held:Readonly<Record<string,ContactAdminNote>>;
  /** Route of workflows saved in this owner scope (status itself never names routes or templates). */
  workflowRoutes:Readonly<Record<string,string>>;
}
/** A challenge this owner scope issued for one route revision. Only an accepted, unexpired, unexhausted one takes a code. */
export interface ContactChallengeRecord extends ContactChallenge {routeRevision:number;accepted:boolean;attempts:number}
/** A verification request without a returned challenge identity: a code may have been sent until `until`. */
export interface ContactUncertainVerification {requestId:string;routeRevision:number;until:number}
/** The owner's challenge lifetime and code attempts. A new challenge also retires every older one for the route. */
export const contactChallengeLifetimeMs=300000,contactChallengeAttempts=5;
/**
 * What a route's verification can do now: take a code, check an uncertain challenge read-only, wait for an unknown one
 * to lapse, or start a new (paid, explicitly confirmed) challenge because the old one expired, changed or was used up.
 */
export type ContactChallengeView={kind:'none'}|{kind:'code'|'check';challenge:ContactChallengeRecord}|{kind:'wait';until:number}|{kind:'renew';reason:'expired'|'changed'|'exhausted'};
export function contactChallengeView(route:{revision:number;enabled:boolean;verified:boolean},record:ContactChallengeRecord|undefined,uncertain:ContactUncertainVerification|undefined,now:number):ContactChallengeView {
  if(!route.enabled||route.verified)return {kind:'none'};
  if(record){
    if(record.routeRevision!==route.revision)return {kind:'renew',reason:'changed'};
    if(record.expiresAt<=now)return {kind:'renew',reason:'expired'};
    if(!record.accepted)return {kind:'check',challenge:record};
    return record.attempts>=contactChallengeAttempts?{kind:'renew',reason:'exhausted'}:{kind:'code',challenge:record};
  }
  if(uncertain&&uncertain.routeRevision===route.revision&&uncertain.until>now)return {kind:'wait',until:uncertain.until};
  return {kind:'none'};
}
/**
 * Owner-scoped memory shared by every controller on one runner gate (the main window's runner), so leaving and
 * reopening Settings keeps in-flight/unknown sends, challenges and exact-rule draft purposes. It never holds status,
 * exact previews, codes or secrets, and a privacy/Stop boundary replaces it.
 */
interface ContactAdminMemory {key:string;challenges:Record<string,ContactChallengeRecord>;uncertain:Record<string,ContactUncertainVerification>;prepared:Record<string,string>;ruleFences:Record<string,string>;held:Record<string,ContactAdminNote>;workflowRoutes:Record<string,string>}
const adminMemories=new WeakMap<ReadGate,ContactAdminMemory>(),adminListeners=new WeakMap<ReadGate,Set<()=>void>>();
const freshMemory=(key:string):ContactAdminMemory=>({key,challenges:{},uncertain:{},prepared:{},ruleFences:{},held:{},workflowRoutes:{}});
/** Whether a pending outbox approval may be an exact-rule draft whose purpose was never confirmed (no send approval then). */
export const contactRuleFenced=(snap:Pick<ContactAdminSnapshot,'ruleFences'|'prepared'>,receipt:Pick<DeliveryReceipt,'requestId'|'binding'>)=>
  snap.prepared[receipt.requestId]===undefined&&Object.values(snap.ruleFences).includes(receipt.binding.workflowId);
const without=<T,>(record:Record<string,T>,id:string)=>{const {[id]:_gone,...rest}=record;return rest;};
export interface ContactAdminController {
  /** Called on every render. A privacy/Stop boundary drops status, notes, challenges and drafts synchronously. */
  sync(scope:PrivacyScope):boolean;
  snapshot():ContactAdminSnapshot;
  /** Why this action cannot start now, or undefined. */
  blocked(action:ContactAdminAction|'status'):string|undefined;
  refresh():Promise<void>;
  run<A extends ContactAdminAction>(action:A,fields:ContactAdminFields<A>,slot?:string):Promise<ContactAdminNote|undefined>;
  /** Explicit user acknowledgement after checking the outbox: allows a new, separate request for this workflow. */
  release(workflowId:string):void;
  close():void;
  closed():boolean;
  subscribe(listener:()=>void):()=>void;
}
export const contactAdminKey='admin contacts';
export function createContactAdminController(options:{bridge?:ContactAdminBridge;gate:ReadGate;scope:PrivacyScope;clock?:()=>number;timeoutMs?:number;setTimer?:SetTimer;newRequestId?:()=>string}):ContactAdminController {
  const gate=options.gate;
  // Listeners live with the gate's memory so a receipt that settles after a remount still re-renders the newer view.
  let listeners=adminListeners.get(gate);if(!listeners){listeners=new Set();adminListeners.set(gate,listeners);}
  const notify=()=>{for(const l of[...listeners!])l();};
  const clock=options.clock??Date.now,setTimer=options.setTimer??defaultTimer,timeoutMs=options.timeoutMs??runnerLimits.timeoutMs,newId=options.newRequestId??(()=>crypto.randomUUID());
  let scope=options.scope,key=scopeKey(scope),generation=0,closed=false;
  let status:ReadView<ContactAdminStatus>={kind:'unchecked'},notes:Record<string,ContactAdminNote>={};
  let mem=adminMemories.get(gate);if(!mem||mem.key!==key){mem=freshMemory(key);adminMemories.set(gate,mem);}
  const memoryLive=(m:ContactAdminMemory)=>adminMemories.get(gate)===m;
  // A privacy/Stop boundary forgets everything, including the owner-scoped memory; closing (navigation) does not.
  const drop=()=>{generation++;status={kind:'unchecked'};notes={};mem=freshMemory(key);adminMemories.set(gate,mem);};
  const current=()=>status.kind==='ready'?status.data:undefined;
  const blocked=(action:ContactAdminAction|'status'):string|undefined=>{
    if(closed)return 'This view was closed.';
    if(!options.bridge)return contactSetupUnavailableMessage;
    if(!privateFlowsAllowed(scope))return missingEpochMessage;
    if(action==='status')return undefined;
    if(scope.privateSession&&!privateContactAdminActions.includes(action))return 'Private session: contact setup changes wait until it ends.';
    const s=current();if(!s)return 'Read setup status first. Nothing was sent.';
    if(s.state==='retention-required')return 'Contact setup is locked while update rollback retention is incomplete. There is no bypass.';
    if(s.state==='review-required'&&action!=='recover-setup')return 'Contact permissions need review. Start fresh contact setup first.';
    return undefined;
  };
  // One request at the bridge at a time, across remounts; a deadline frees the view but never permits a pile-up.
  // Liveness is checked again immediately before the bridge call: a view retired by Stop, a privacy change or closing
  // in the meantime dispatches nothing. The bridge rechecks the same fence after its own privacy synchronization.
  type Sent={ok:true;body:unknown}|{ok:false;notSent?:true}|'timeout'|'busy';
  // `late` receives a reply that arrives after the deadline (used only to settle an exact-rule purpose fence).
  const send=(request:ContactAdminRequest,fence:ContactAdminFence,late?:(reply:Exclude<Sent,'timeout'|'busy'>)=>void):Promise<Sent>=>{
    const release=gate.start(contactAdminKey);if(!release)return Promise.resolve('busy');
    return new Promise(resolve=>{let settled=false;
      const cancel=setTimer(()=>{if(!settled){settled=true;resolve('timeout');}},timeoutMs);
      Promise.resolve().then(()=>{if(!fence.live())throw new ContactAdminNotDispatched();return options.bridge!(request,fence);})
        .then(body=>({ok:true as const,body}),error=>error instanceof ContactAdminNotDispatched?{ok:false as const,notSent:true as const}:{ok:false as const})
        .then(reply=>{release();if(!settled){settled=true;cancel();resolve(reply);}else{late?.(reply);notify();}});});
  };
  /**
   * Settles one exact-rule fence from a correlated reply. A matching intent records the draft's rule purpose; a refusal
   * before any effect (or a request that never left) releases the fence; anything else keeps it, so an uncertain
   * pending draft is never offered as a send approval.
   */
  const settleRule=(m:ContactAdminMemory,fenceId:string,workflowId:string,read:ContactAdminInterpretation|'not-sent')=>{
    if(!memoryLive(m)||m.ruleFences[fenceId]===undefined)return;
    if(read==='not-sent'){m.ruleFences=without(m.ruleFences,fenceId);return;}
    if(read.intent&&read.note.outboxRequestId===read.intent.requestId&&read.intent.binding.workflowId===workflowId){
      m.prepared={...m.prepared,[read.intent.requestId]:workflowId};m.ruleFences=without(m.ruleFences,fenceId);}
    else if(!read.intent&&!read.note.outboxRequestId&&(read.note.state==='rejected'||read.note.state==='conflict'))m.ruleFences=without(m.ruleFences,fenceId);
  };
  const accept=(next:ContactAdminStatus|undefined)=>{if(next)status={kind:'ready',data:next,observedAt:clock()};};
  const remember=(m:ContactAdminMemory,action:ContactAdminAction,target:{routeId?:string;workflowId?:string;outboxRequestId?:string;challengeId?:string},
    route:ContactAdminStatus['routes'][number]|undefined,before:ContactAdminStatus,read:ContactAdminInterpretation)=>{
    const state=read.note.state;
    if(action==='verify-begin'&&route){
      const issued=read.challenge??read.uncertainChallenge;
      if(issued){m.uncertain=without(m.uncertain,route.id);m.challenges={...m.challenges,[route.id]:{...issued,routeRevision:route.revision,accepted:!!read.challenge,attempts:0}};}
      // A rejected challenge or a refused request leaves nothing outstanding; an unknown one keeps the marker until it lapses.
      else if(state==='rejected'||state==='conflict')m.uncertain=without(m.uncertain,route.id);
      // Any new challenge retires older ones at the owner, so an earlier code is no longer offered unless nothing happened.
      if(state!=='conflict'&&!issued)m.challenges=without(m.challenges,route.id);
    }
    if(action==='verify-complete'&&target.routeId){const c=m.challenges[target.routeId];
      if(c?.challengeId===target.challengeId){
        if(state==='completed')m.challenges=without(m.challenges,target.routeId);
        else if(state!=='conflict')m.challenges={...m.challenges,[target.routeId]:{...c,attempts:c.attempts+1}};
      }}
    if(action==='reconcile'&&read.note.evidence?.kind==='verification'){const e=read.note.evidence;
      for(const [routeId,c] of Object.entries(m.challenges))if(c.requestId===target.outboxRequestId&&c.challengeId===e.challengeId){
        if(delivered(e))m.challenges={...m.challenges,[routeId]:{...c,accepted:true}};
        else if(e.state==='rejected')m.challenges=without(m.challenges,routeId);
      }}
    if(action==='prepare-notification'&&target.workflowId)m.held=state==='completed'||state==='rejected'||state==='conflict'?without(m.held,target.workflowId):{...m.held,[target.workflowId]:read.note};
    if(action==='save-workflow'&&state==='completed'&&read.status){
      const known=new Set(before.workflows.map(w=>w.id)),saved=target.workflowId??read.status.workflows.find(w=>!known.has(w.id))?.id;
      if(saved)m.workflowRoutes={...m.workflowRoutes,[saved]:(target as unknown as ContactAdminFields<'save-workflow'>).definition.routeId};
    }
    // Starting fresh disables every route and discards the owner's prepared drafts; unknown sends stay held.
    if(action==='recover-setup'&&state==='completed'){m.challenges={};m.uncertain={};m.prepared={};}
  };
  const controller:ContactAdminController={
    sync(next){if(closed||scopeKey(next)===key)return false;scope=next;key=scopeKey(next);drop();return true;},
    snapshot:()=>({status,busy:gate.busy(contactAdminKey),notes,challenges:mem!.challenges,uncertain:mem!.uncertain,prepared:mem!.prepared,ruleFences:mem!.ruleFences,held:mem!.held,workflowRoutes:mem!.workflowRoutes}),
    blocked,
    async refresh(){
      if(blocked('status')||gate.busy(contactAdminKey))return;
      const mine=generation,requestId=newId();status=status.kind==='ready'?status:{kind:'loading'};notify();
      const reply=await send({requestId,expectedRevision:current()?.revision??1,action:'status'},{epoch:scope.epoch,live:()=>!closed&&mine===generation});
      if(mine!==generation||closed)return;
      if(reply==='busy')return;
      const read=reply==='timeout'||!reply.ok?undefined:interpretContactAdminReply({requestId,action:'status'},reply.body);
      if(read?.status)accept(read.status);
      else if(reply!=='timeout'&&!reply.ok&&reply.notSent)status={kind:'error',message:'Setup status was not read: this view changed before the request left it. Read it again.'};
      else status={kind:'error',message:reply==='timeout'?'Setup status did not arrive in time. Status is unknown.':'Setup status could not be read: the desktop contact owner is unavailable in this build or session. Nothing is shown as configured.'};
      notify();
    },
    async run(action,fields,slot=action){
      const why=blocked(action);
      if(why){if(!closed){notes={...notes,[slot]:{action,requestId:'',state:'invalid',message:why}};notify();}return undefined;}
      const parsed=contactAdminInputSchemas[action].safeParse(fields);
      if(!parsed.success){const which=[...new Set(parsed.error.issues.map(i=>i.path.join('.')||'input'))].slice(0,4).join(', ');
        notes={...notes,[slot]:{action,requestId:'',state:'invalid',message:'Check '+displayText(which,80)+'. Nothing was sent.'}};notify();return undefined;}
      if(gate.busy(contactAdminKey))return undefined;
      const mine=generation,memory=mem!,requestId=newId(),before=current()!;
      const request={...parsed.data,requestId,expectedRevision:before.revision,action} as ContactAdminRequest;
      const target=parsed.data as {routeId?:string;workflowId?:string;outboxRequestId?:string;challengeId?:string};
      const outboxRequestId=action==='reconcile'?target.outboxRequestId:undefined,route=target.routeId?before.routes.find(r=>r.id===target.routeId):undefined;
      // Markers before dispatch: an in-flight send or challenge blocks a duplicate, across remounts, until its receipt.
      if(action==='prepare-notification')memory.held={...memory.held,[target.workflowId!]:{action,requestId,state:'pending',message:'This send is waiting for its receipt. No new send is offered and nothing is resent automatically.'}};
      if(action==='verify-begin'&&route)memory.uncertain={...memory.uncertain,[route.id]:{requestId,routeRevision:route.revision,until:clock()+contactChallengeLifetimeMs}};
      // An exact-rule draft's purpose is fenced before dispatch, so a lost or late receipt cannot turn it into a send approval.
      const rule=action==='prepare-rule'?target.workflowId!:undefined;
      if(rule)memory.ruleFences={...memory.ruleFences,[requestId]:rule};
      const unmark=()=>{if(action==='prepare-notification'&&memory.held[target.workflowId!]?.requestId===requestId)memory.held=without(memory.held,target.workflowId!);
        if(action==='verify-begin'&&route&&memory.uncertain[route.id]?.requestId===requestId)memory.uncertain=without(memory.uncertain,route.id);
        if(rule)settleRule(memory,requestId,rule,'not-sent');};
      notes={...notes,[slot]:{action,requestId,state:'pending',message:'Waiting for the desktop owner’s receipt…'}};notify();
      const reply=await send(request,{epoch:scope.epoch,live:()=>!closed&&mine===generation&&memoryLive(memory)},rule?late=>{
        if(!late.ok&&late.notSent)settleRule(memory,requestId,rule,'not-sent');
        else settleRule(memory,requestId,rule,late.ok?interpretContactAdminReply({requestId,action,workflowId:rule},late.body):{note:{action,requestId,state:'unconfirmed',message:''}});}:undefined);
      const viewLive=()=>mine===generation&&!closed;
      if(reply==='busy'||reply!=='timeout'&&!reply.ok&&reply.notSent){
        unmark();
        if(viewLive()){notes=reply==='busy'?without(notes,slot):{...notes,[slot]:{action,requestId,state:'rejected',message:'Not sent: this view changed before the request left it. Nothing was changed.'}};}
        notify();return reply==='busy'||!viewLive()?undefined:notes[slot];
      }
      const read:ContactAdminInterpretation=reply==='timeout'||!reply.ok
        ?{note:{action,requestId,state:'unconfirmed',outboxRequestId,message:(reply==='timeout'?'No receipt within '+Math.round(timeoutMs/1000)+' s.':'No receipt from the desktop owner.')+unknownTail(action,'')}}
        :interpretContactAdminReply({requestId,action,outboxRequestId,workflowId:target.workflowId},reply.body);
      // The owner-scoped memory takes this receipt even after Settings closed, so a remount keeps the send held, the
      // challenge and the draft purpose. A privacy/Stop boundary replaced the memory: a late receipt then changes nothing.
      if(memoryLive(memory))remember(memory,action,target,route,before,read);
      if(rule&&reply!=='timeout')settleRule(memory,requestId,rule,read);
      if(!viewLive()){notify();return undefined;}
      accept(read.status);notes={...notes,[slot]:read.note};
      notify();return read.note;
    },
    release(workflowId){if(closed||!mem!.held[workflowId]||gate.busy(contactAdminKey))return;mem!.held=without(mem!.held,workflowId);notify();},
    close(){if(closed)return;closed=true;generation++;status={kind:'unchecked'};notes={};notify();},
    closed:()=>closed,
    subscribe(listener){listeners!.add(listener);return ()=>{listeners!.delete(listener);};},
  };
  return controller;
}
/** Display amounts: integer micro-units of your billing currency, as local estimates. */
export const formatMicros=(micros:number)=>{const text=(micros/1e6).toFixed(6).replace(/0+$/,'');return text.endsWith('.')?text+'00':text;};
export const parseMicros=(text:string):number|undefined=>{const t=text.trim();if(!/^\d{1,7}(?:\.\d{1,6})?$/.test(t))return undefined;const v=Math.round(Number(t)*1e6);return Number.isSafeInteger(v)?v:undefined;};
export const minuteText=(m:number)=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
export const parseMinute=(text:string):number|undefined=>{const m=/^(\d\d):(\d\d)$/.exec(text);if(!m)return undefined;const v=Number(m[1])*60+Number(m[2]);return Number(m[1])<24&&Number(m[2])<60?v:undefined;};
/** The enforced limits in words. Never a monthly count: only the fields the owner enforces. */
export function contactLimitsText(channel:ContactChannel,l:ContactLimits):string {
  const unit=channel==='voice'?'started call minute':channel==='sms'?'SMS segment':'message';
  return (l.enabled?'On':'Off')+' · up to '+l.maxPerMinute+'/min and '+l.maxPerDay+' per rolling day · estimate '+formatMicros(l.unitCostMicros)+' per '+unit+
    ', at most '+formatMicros(l.maxDispatchCostMicros)+' per send, '+formatMicros(l.dailyBudgetMicros)+' per rolling day'+
    (l.quietHours?' · quiet '+minuteText(l.quietHours.startMinute)+'–'+minuteText(l.quietHours.endMinute)+' '+displayText(l.quietHours.timeZone,60):'');
}
const channelNames:Record<ContactChannel,string>={gmail:'Gmail',sms:'SMS',voice:'Voice calls',whatsapp:'WhatsApp',android:'Paired Android'};
export const contactChannelName=(c:ContactChannel)=>channelNames[c];
/** Separate truthful readiness per channel: configuration, limits and channel prerequisites, never delivery. */
export function contactChannelBadge(c:ContactAdminStatus['channels'][number],state:ContactAdminStatus['state']):Badge {
  if(state!=='ready')return {tag:'UNAVAILABLE',tone:'warn',text:'Locked until contact permissions are reviewed.'};
  if(c.ready)return c.channel==='android'?{tag:'READY',tone:'green',text:'A paired device is recorded for an enabled route and limits are on. Only the phone’s own receipt confirms delivery.'}
    :{tag:'READY',tone:'green',text:'Provider, limits and channel prerequisites are in place. Each recipient still needs verification; this is not a delivery test.'};
  if(!c.configured)return {tag:'NOT CONFIGURED',tone:'warn',text:c.channel==='gmail'?'Gmail is not connected.':c.channel==='android'?'No enabled, opted-in paired-device recipient.':'Twilio credentials are not saved.'};
  if(!c.enabled)return {tag:'LIMITS OFF',tone:'warn',text:'Set and enable limits for this channel. Nothing is sent while its limits are off.'};
  const why:Record<ContactChannel,string>={gmail:'The limits do not allow a message.',sms:'Needs a nonzero estimated cost per segment within the per-send and daily budgets.',
    voice:'Needs voice calls allowed in Twilio setup and a nonzero estimated cost per call minute within budget.',
    whatsapp:'Needs a nonzero estimated cost within budget and an approved plain-text template rechecked in the last 24 hours.',
    android:'No paired device is currently confirmed for an enabled recipient. A pair record alone does not make the phone reachable.'};
  return {tag:'NOT READY',tone:'warn',text:why[c.channel]};
}
/** Quick local check before sending; the owner applies the authoritative canonical form. */
export function contactDestinationProblem(channel:ContactChannel,value:string):string|undefined {
  const v=value.trim();if(!v)return 'Enter the recipient.';
  if(channel==='gmail')return /^[^\s@<>,;"]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(v)?undefined:'Use one plain email address.';
  if(channel==='android')return IdSchema.safeParse(v).success?undefined:'Use the paired device ID.';
  return /^\+[1-9][0-9]{7,14}$/.test(channel==='whatsapp'?v.replace(/^whatsapp:/,''):v)?undefined:'Use an international number such as +15551234567.';
}
/** Templates may use only the server-owned {{status}} value; nothing else is substituted. */
export const templateBodyProblem=(body:string)=>!body.trim()?'Enter the message text.':/\{\{(?!status\}\})[^}]*\}\}/.test(body)||/\{\{status\}\}\}/.test(body)?'Only {{status}} can be filled in; it is supplied by Capri.':undefined;

// ---- skills session --------------------------------------------------------------------------
export const emptyTeachForm={name:'',description:'',summary:'',keywords:'',tools:'',optionalTools:'',steps:'',verify:'',checks:'',security:false};
export type TeachForm=typeof emptyTeachForm;
export type SkillCatalog=z.infer<typeof SkillCatalogSchema>;
export interface SkillsSnapshot {catalog:ReadView<SkillCatalog>;form:TeachForm;acknowledged:Readonly<Record<string,string>>;allowed:boolean;runner:ActionRunner;
  /** A catalog read is still outstanding at the transport (possibly from an earlier session); Load stays off. */
  reading:boolean}
export interface SkillsSession {
  /** Called on every render with the trusted scope. A boundary discards private state synchronously; returns true then. */
  sync(scope:PrivacyScope):boolean;
  snapshot():SkillsSnapshot;
  setForm(form:TeachForm):void;
  acknowledge(skillId:string,manifestSha256:string):void;
  load():Promise<void>;
  /** With resetForm, a completed receipt clears the form only if it is still the exact revision that was submitted. */
  act<A extends UiAction>(action:A,input:UiActionInput<A>,slot?:string,resetForm?:boolean):void;
  /** Irreversible: discards private state, retires the namespace and starts nothing afterwards. Create a new session instead. */
  close():void;
  closed():boolean;
  subscribe(listener:()=>void):()=>void;
}
/** Keeps explicitly saved, non-private entries across a boundary; private entries and drafts are dropped. */
export const publicCatalog=(view:ReadView<SkillCatalog>):ReadView<SkillCatalog>=>
  view.kind==='ready'?{...view,data:{skills:view.data.skills.filter(s=>!s.private&&!s.draft)}}:{kind:'unchecked'};
export const skillsCatalogKey=readKey(extensionRoutes.overview.skills);
let skillsSessions=0;
export function createSkillsSession(options:{request:ExtensionRequest;runner:ActionRunner;scope:PrivacyScope;clock?:()=>number;initialCatalog?:ReadView<SkillCatalog>}&ReadOptions):SkillsSession {
  const clock=options.clock??Date.now,listeners=new Set<()=>void>(),gate=options.gate??options.runner.reads;
  // Every session and every epoch inside it gets a namespace no other session or epoch ever uses.
  const family='skills.'+(++skillsSessions);
  let scope=options.scope,key=scopeKey(scope),epochGeneration=0,readGeneration=0,formRevision=0,closed=false;
  let prefix=family+'.0',runner=scopedRunner(options.runner,prefix);
  let catalog:ReadView<SkillCatalog>=options.initialCatalog??{kind:'unchecked'},form=emptyTeachForm,acknowledged:Record<string,string>={};
  const notify=()=>{for(const l of[...listeners])l();};
  // Ends the current epoch: private drafts dropped, outcomes deleted, pending reads and receipts ignored from now on.
  const retireEpoch=()=>{
    // Drafts typed in a private session never cross it; public drafts are kept. Acknowledgements never carry over.
    if(scope.privateSession){form=emptyTeachForm;formRevision++;}
    epochGeneration++;readGeneration++;
    // Old outcomes are deleted, not hidden; late receipts for them are dropped by the runner.
    options.runner.retire(prefix);catalog=publicCatalog(catalog);acknowledged={};
  };
  const boundary=(next:PrivacyScope)=>{
    retireEpoch();scope=next;key=scopeKey(next);
    prefix=family+'.'+epochGeneration;runner=scopedRunner(options.runner,prefix);
  };
  const session:SkillsSession={
    sync(next){if(closed||scopeKey(next)===key)return false;boundary(next);return true;},
    snapshot:()=>({catalog,form,acknowledged,allowed:privateFlowsAllowed(scope),runner,reading:gate.busy(skillsCatalogKey)}),
    setForm(next){if(closed)return;form=next;formRevision++;notify();},
    acknowledge(skillId,digest){if(closed)return;acknowledged={...acknowledged,[skillId]:digest};notify();},
    async load(){
      if(closed)return;
      if(!privateFlowsAllowed(scope)){catalog={kind:'error',message:missingEpochMessage};notify();return;}
      if(gate.busy(skillsCatalogKey))return;
      const mine=++readGeneration;if(catalog.kind!=='ready')catalog={kind:'loading'};notify();
      const next=await readOverview(options.request,'skills',clock,{...options,gate});
      if(mine!==readGeneration)return;
      catalog=next;notify();
    },
    act(action,input,slot=action,resetForm=false){
      if(closed||!privateFlowsAllowed(scope))return;
      const mine=epochGeneration,submitted=formRevision,done=runner.run(action,input,{slot});if(!done)return;
      void done.then(r=>{if(closed||mine!==epochGeneration||r.state!=='completed')return;
        // Newer edits made while the receipt was pending are kept.
        if(resetForm&&formRevision===submitted){form=emptyTeachForm;formRevision++;notify();}
        void session.load();});
    },
    // The retired scoped runner stays in place: it can never dispatch again, and no fresh namespace is issued.
    close(){if(closed)return;closed=true;retireEpoch();notify();},
    closed:()=>closed,
    subscribe(listener){listeners.add(listener);return ()=>{listeners.delete(listener);};},
  };
  return session;
}

// ---- display helpers -------------------------------------------------------------------------
export type Tone='green'|'warn'|'error'|'';
export interface Badge {tag:string;tone:Tone;text:string}
/** READY only when the service reports the full readiness conjunction; configuration alone never reads as connected. */
export function capabilityBadge(capability:FeatureCapability|undefined):Badge {
  if(!capability)return {tag:'STATUS UNKNOWN',tone:'warn',text:'Status has not been read. Nothing is assumed ready.'};
  if(capability.available)return {tag:'READY',tone:'green',text:capability.verification==='verified'?'Ready and verified.':capability.verification==='local-probe'?'Ready; local probe passed.':'Ready.'};
  switch(capability.reason){
    case 'disabled':return {tag:'OFF',tone:'',text:'Disabled in settings.'};
    case 'unconfigured':return {tag:'UNAVAILABLE · NOT CONFIGURED',tone:'warn',text:'Not configured. Nothing will be sent or run.'};
    case 'unsupported':return {tag:'UNSUPPORTED',tone:'warn',text:'Not supported on this device or build.'};
    case 'untrusted':return {tag:'UNAVAILABLE · UNTRUSTED',tone:'warn',text:'No trusted configuration exists for this build.'};
    default:return {tag:'UNAVAILABLE',tone:'warn',text:capability.configured?'Configured, but not ready. Configuration is not a successful probe.':'Unavailable.'};
  }
}
const suspension:Record<string,string>={'reduced-motion':'reduced motion is on','game-docked':'a game is docked','intensity-zero':'intensity is zero',locked:'the session is locked',
  accessibility:'an accessibility pointer setting is active','owner-conflict':'another owner holds the cursor','host-unavailable':'the cursor host is unavailable'};
export function cursorBadge(cursor:CursorStatus|undefined,now:number):Badge {
  if(!cursor)return {tag:'STATUS UNKNOWN',tone:'warn',text:'Cursor state has not been read.'};
  switch(cursor.state){
    case 'active':return {tag:'ACTIVE',tone:'green',text:cursor.expiresAt?'Animated cursor on for this trial, ending in about '+Math.max(0,Math.ceil((cursor.expiresAt-now)/1000))+' s.':'Animated cursor on until you disable it, Stop or quit.'};
    case 'suspended':return {tag:'SUSPENDED',tone:'warn',text:'Normal cursor restored while '+(suspension[cursor.suspensionReason??'']??'suspended')+'. Your preference is kept.'};
    case 'restoring':return {tag:'RESTORING',tone:'warn',text:'Restoring the normal Windows cursor…'};
    case 'recovery-required':return {tag:'RECOVERY REQUIRED',tone:'error',text:'The normal cursor could not be confirmed. Use Restore normal cursor.'};
    case 'unsupported':return {tag:'UNSUPPORTED',tone:'warn',text:'Animated cursors are not supported here.'};
    default:return {tag:'INACTIVE',tone:'',text:'Normal Windows cursor.'};
  }
}
const evidenceText:Record<SecurityJob['evidence'][number]['outcome'],Badge>={
  'no-detection':{tag:'NO DETECTIONS',tone:'green',text:'Defender completed this scan and reported no detections.'},
  remediated:{tag:'REMEDIATED',tone:'warn',text:'Defender reports a threat remediated under its own policy.'},
  'action-required':{tag:'ACTION REQUIRED',tone:'error',text:'Defender reports an item needing review in Windows Security.'},
  unavailable:{tag:'UNAVAILABLE',tone:'warn',text:'Defender was unavailable or not permitted. No scan result.'},
  uncertain:{tag:'UNCERTAIN',tone:'warn',text:'The result could not be verified. Review Windows Security.'},
  healthy:{tag:'STATUS OBSERVED',tone:'green',text:'Protection and definitions were observed. This is not a scan result.'},
  findings:{tag:'NEEDS REVIEW',tone:'warn',text:'Security health needs review. No settings were changed.'},
  failed:{tag:'FAILED',tone:'error',text:'Defender reported an operation failure.'},
  cancelled:{tag:'CANCELLED',tone:'',text:'Cancelled; no scan result.'},
  unconfirmed:{tag:'UNCONFIRMED',tone:'warn',text:'Monitoring stopped; Defender may still be running.'},
};
/** A job's headline comes only from evidence correlated with that job; a finished job without it is not clean. */
export function securityJobBadge(job:SecurityJob):Badge {
  const evidence=job.evidence.filter(e=>e.jobId===job.id);
  const latest=evidence[evidence.length-1];
  if(latest&&(latest.outcome!=='no-detection'||job.state==='completed'))return evidenceText[latest.outcome];
  if(job.state==='pending'||job.state==='running')return {tag:job.state.toUpperCase(),tone:'',text:'In progress. No result yet.'};
  if(job.state==='cancelled')return evidenceText.cancelled;
  return {tag:'NO EVIDENCE',tone:'warn',text:'No correlated Defender evidence. This is not a clean result.'};
}
export const securityOperationLabel:Record<SecurityJob['operation'],string>={status:'Health check','quick-scan':'Quick scan','full-scan':'Full scan','custom-scan':'Custom scan','update-signatures':'Signature update'};
/** Accepted/sent/delivered require a matching remote receipt or observed record. Hashes are never shown. */
export function deliveryBadge(receipt:DeliveryReceipt,requestId=receipt.requestId):Badge {
  const parsed=DeliveryReceiptSchema.safeParse(receipt);
  const remote=parsed.success&&(receipt.evidence.source==='service-receipt'||receipt.evidence.source==='observed-record');
  if(!parsed.success||receipt.requestId!==requestId)return {tag:'UNCONFIRMED',tone:'warn',text:'The receipt does not match this message. Draft kept; nothing is resent.'};
  // A connected or completed call can be voicemail or an automated answer: never proof that a person listened.
  if(receipt.adapter==='twilio-voice'&&remote)switch(receipt.state){
    case 'accepted':return {tag:'CALL ACCEPTED',tone:'green',text:'The provider accepted the call request (provider receipt). The call has not connected yet.'};
    case 'sent':return {tag:'CALL PLACED',tone:'green',text:'The provider reports the call in progress. That does not prove a person heard the script.'};
    case 'delivered':return {tag:'CALL CONNECTED',tone:'green',text:'The provider reports the call connected and ended. It may have reached voicemail; this is not proof a person listened.'};
  }
  switch(receipt.state){
    case 'accepted':if(remote)return {tag:'ACCEPTED',tone:'green',text:'The provider accepted the message (provider receipt). Delivery is not yet observed.'};break;
    case 'sent':if(remote)return {tag:'SENT',tone:'green',text:'The provider confirmed transmission. Delivery is not yet observed.'};break;
    case 'delivered':if(remote)return {tag:'DELIVERED',tone:'green',text:'Delivery was observed by the provider.'};break;
    case 'pending':return {tag:'PENDING',tone:'',text:'Queued or waiting for approval. Not sent.'};
    case 'rejected':return {tag:'REJECTED',tone:'error',text:'Rejected'+(receipt.evidence.source==='trusted-pre-dispatch'?' before dispatch':' by the provider')+'. Draft kept for review.'};
  }
  return {tag:'UNCONFIRMED',tone:'warn',text:'Delivery could not be confirmed. Draft kept; reconcile reads the provider record and never resends.'};
}
export function updatesBadge(status:ExtensionStatus|undefined):Badge {
  if(!status)return {tag:'STATUS UNKNOWN',tone:'warn',text:'Update status has not been read.'};
  const trust=status.features.updates;
  switch(status.updates.state){
    case 'untrusted':return {tag:'UNAVAILABLE · UNTRUSTED',tone:'warn',text:'No operator-pinned release key is configured for this build. Updates stay unavailable; nothing is downloaded.'};
    case 'disabled':return {tag:'OFF',tone:'',text:'Automatic verified updates are turned off.'};
    case 'checking':return {tag:'CHECKING',tone:'',text:'Checking the signed release feed…'};
    case 'current':return {tag:'CURRENT',tone:'green',text:'No newer signed release was found.'};
    case 'available':return trust.available&&trust.verification==='verified'&&status.updates.version
      ?{tag:'AVAILABLE',tone:'green',text:'Signed release '+displayText(status.updates.version,80)+' is verified and compatible. It is not installed.'}
      :{tag:'STATUS UNKNOWN',tone:'warn',text:'Update availability is not verified.'};
    case 'installing':return {tag:'INSTALLING',tone:'warn',text:'Installing a verified update after backup…'};
    default:return {tag:'RECOVERY REQUIRED',tone:'error',text:'The last update needs recovery. Roll back to the known-good version.'};
  }
}
export function agentJobBadge(job:AgentJob):Badge {
  switch(job.state){
    case 'completed':return {tag:'TURN COMPLETED',tone:'',text:'The provider turn finished. That is not proof a requested build, test or change succeeded — review the handoff.'};
    case 'pending':case 'running':return {tag:job.state.toUpperCase(),tone:'',text:'Working. No result yet.'};
    case 'needs-approval':return {tag:'NEEDS APPROVAL',tone:'warn',text:'Waiting for your approval.'};
    case 'cancelled':return {tag:'CANCELLED',tone:'',text:'Cancellation observed.'};
    case 'failed':return {tag:'FAILED',tone:'error',text:'The job failed.'};
    default:return {tag:'UNCONFIRMED',tone:'warn',text:'Outcome unknown. Inspect it; nothing is replayed.'};
  }
}
export const resultTone=(state:ActionView['state']):Tone=>state==='completed'?'green':state==='rejected'||state==='invalid'?'error':state==='pending'||state==='queued'||state==='cancelled'?'':'warn';
