import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import type {Store} from '../server/store';
import {ContactAdminRequestSchema,ContactAdminReplySchema,ContactAdminStatusSchema,ContactAuthoritySchema,verificationContactReceipt,contactAuthorityKind,parseContactAuthority,writeContactAuthority,ruleBinding,zeroContactLimits,type ContactAdminScope,type ContactAuthority,type AdminChannel,type AdminRoute,type ContactAdminReply,type ApprovedText} from '../extensions/contact-admin';
import {GmailProvider,GmailStoredTokensSchema,TwilioProvider,canonicalRecipient,type ContactSecretVault,type ContactFetch,type ContactProvider,type OutboundMessage} from '../extensions/contact-providers';
import type {ContactsModuleOptions,ResolvedContact} from '../extensions/contacts';
import {clearContactReviews,ContactsService} from '../extensions/contacts';
import {ActionReceiptSchema,defaultExtensionSettings,type ActionReceipt,type ContactIntent,type ExtensionActionContext,type ContactRoute} from '../extensions/contracts';
import {canonicalJson,sha256} from '../extensions/policy';
import type {ExtensionHub,HubContext,HubContactsOverview} from '../extensions/hub';
import {renderContactWorkflow,notificationIntent,contactCompletionIdentity,type ContactWorkflowStatus} from '../server/contact-workflows';

/** Provider-contract review: 2026-11-07, documentation only, no source copied.
 * https://developers.google.com/identity/protocols/oauth2/native-app
 * https://developers.google.com/workspace/gmail/api/auth/scopes
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
 * Decisions: system browser, owned random 127.0.0.1 port/path, S256/state,
 * gmail.send only, fixed token/send endpoints, no inferred identity or delivery.
 * https://www.twilio.com/docs/messaging/api/message-resource
 * https://www.twilio.com/docs/voice/api/call-resource
 * Decisions: exact account/record/envelope correlation, observed states only,
 * bounded TimeLimit/escaped inline TwiML; obsolete maxPrice is never a cap.
 * https://www.twilio.com/docs/whatsapp/api
 * https://www.twilio.com/docs/whatsapp/tutorial/send-whatsapp-notification-messages-templates
 * https://www.twilio.com/docs/whatsapp/tutorial/message-template-approvals-statuses
 * https://www.twilio.com/docs/content/content-api-resources
 * https://www.twilio.com/docs/content/twilio-text
 * https://www.twilio.com/docs/content/content-types-overview
 * Decisions: explicit opt-in plus exact Content/{SID} and /ApprovalRequests GETs;
 * bind account/SID/language/approved twilio/text only, reject rich alternatives,
 * render every variable, pin text/hash, cap text at 1600, explicit recheck only.
 * The 24-hour pin lifetime is Capri's conservative policy, not provider approval.
 * https://www.electronjs.org/docs/latest/api/safe-storage
 * https://www.electronjs.org/docs/latest/tutorial/security
 * Decisions: real protected storage, no plaintext fallback, current main-frame
 * authentication and existing service session authority. Synchronous protection
 * remains supported by the pinned Electron runtime; no context/key migration.
 */

const unavailable=()=>Error('Contact administration unavailable. Review current configuration.');
const equal=(a:unknown,b:unknown)=>canonicalJson(JSON.parse(JSON.stringify(a)))===canonicalJson(JSON.parse(JSON.stringify(b)));
export function assertDesktopContactSender(event:{sender:unknown;senderFrame:any},owner:{webContents:{mainFrame:unknown};isDestroyed():boolean},localUrl:string,closing:boolean){
  const frame=event.senderFrame;
  if(closing||owner.isDestroyed()||event.sender!==owner.webContents||!frame||frame!==owner.webContents.mainFrame||frame.isDestroyed()||new URL(frame.url).origin!==new URL(localUrl).origin)throw unavailable();
}
/** Synchronous OS-protected IO lets each update preserve the latest unrelated vault
 * fields atomically, with no interleaved await or stale whole-vault replacement. */
export interface ProtectedContactStorage {read():Record<string,unknown>;write(value:Record<string,unknown>):void}
export class ProtectedContactVault implements ContactSecretVault {
  private failed=false;
  constructor(private storage:ProtectedContactStorage){}
  assertUsable(){if(this.failed)throw unavailable();}
  private entries(root:Record<string,unknown>):Record<string,string>{
    if(!root||typeof root!=='object'||Array.isArray(root))throw unavailable();
    const entries=root.contactSecrets;if(entries===undefined)return {};
    if(!entries||typeof entries!=='object'||Array.isArray(entries)||Object.entries(entries).length>256||Object.values(entries).some(v=>typeof v!=='string'||v.length>65536))throw unavailable();
    return {...entries as Record<string,string>};
  }
  async read(key:string){try{if(this.failed)throw unavailable();return this.entries(this.storage.read())[key];}catch{this.failed=true;throw unavailable();}}
  private update(key:string,value?:string){
    try{if(this.failed||!/^contact:[A-Za-z0-9:._-]{1,200}$/.test(key)||value!==undefined&&value.length>65536)throw unavailable();
      const root=this.storage.read(),entries=this.entries(root);if(value===undefined)delete entries[key];else entries[key]=value;
      const next={...root,contactSecrets:entries};this.storage.write(next);
      if(!equal(this.storage.read(),next))throw unavailable();
    }catch{this.failed=true;throw unavailable();}
  }
  async write(key:string,value:string){this.update(key,value);}
  async delete(key:string){this.update(key);}
}

/** Fixed official destinations only, with fetch's TLS verification intact. Body
 * limits/timeouts are also enforced by the adapters; no redirect is followed. */
export const officialContactFetch:ContactFetch=async(url,init)=>{
  const u=new URL(url),method=init.method??'GET';
  const gmail=u.origin==='https://oauth2.googleapis.com'&&u.pathname==='/token'&&method==='POST'||u.origin==='https://gmail.googleapis.com'&&u.pathname==='/'+['gmail','v1','users','me','messages','send'].join('/')&&method==='POST';
  const twilio=u.origin==='https://api.twilio.com'&&(method==='POST'&&/^\/2010-04-01\/Accounts\/AC[a-fA-F0-9]{32}\/(?:Messages|Calls)\.json$/.test(u.pathname)||method==='GET'&&/^\/2010-04-01\/Accounts\/AC[a-fA-F0-9]{32}\/(?:Messages\/SM|Calls\/CA)[a-fA-F0-9]{32}\.json$/.test(u.pathname));
  const content=u.origin==='https://content.twilio.com'&&/^\/v1\/Content\/HX[a-fA-F0-9]{32}(?:\/ApprovalRequests)?$/.test(u.pathname)&&method==='GET';
  if(u.username||u.password||u.search||u.hash||!(gmail||twilio||content))throw unavailable();
  return fetch(url,{...init,redirect:'error',signal:AbortSignal.any([init.signal??new AbortController().signal,AbortSignal.timeout(30000)])});
};
interface Draft {intent:ContactIntent;message:OutboundMessage;route:AdminRoute;templateRevision:number;workflowRevision:number;epoch:string;signal:AbortSignal;assertCurrent():void;status:ContactWorkflowStatus;automatic:boolean;privateContent:boolean}
export interface DesktopContactOwnerOptions {store:Pick<Store,'get'|'put'>;vault:ContactSecretVault;clock?:()=>number;fetch?:ContactFetch;openAuthorization(url:string):Promise<void>}
/** One owner, one stable vault, the original Hub/ContactsService outbox. Nothing
 * in construction/status performs network, OAuth, catalog refresh or dispatch. */
export class DesktopContactOwner {
  readonly options:ContactsModuleOptions;
  private hub?:ExtensionHub;private tail:Promise<unknown>=Promise.resolve();private fence=0;private closed=false;private faulted=false;
  private pendingMutations=0;
  private inFlight=new Map<string,Promise<ContactAdminReply>>();
  private paired?:(deviceId:string)=>Promise<boolean>;
  private drafts=new Map<string,Draft>();private oauth?:{server:Server;controller:AbortController;state?:string;provider:GmailProvider;timer:NodeJS.Timeout;detach:()=>void};
  private readonly clock:()=>number;private readonly fetcher:ContactFetch;
  private readonly proofs:ContactsService;
  constructor(private deps:DesktopContactOwnerOptions){
    this.clock=deps.clock??Date.now;this.fetcher=deps.fetch??officialContactFetch;
    const providers=(['gmail','sms','voice','whatsapp'] as const).map(channel=>this.provider(channel));
    this.proofs=new ContactsService({store:deps.store,clock:this.clock,providers:[],resolve:async()=>{throw unavailable();}});
    this.options={providers,resolve:(intent,context)=>this.resolve(intent,context),availability:()=>this.availability()};
  }
  bind(hub:ExtensionHub,paired?:(deviceId:string)=>Promise<boolean>){if(this.hub&&this.hub!==hub)throw unavailable();this.hub=hub;this.paired=paired;}
  private serialize<T>(work:()=>Promise<T>){const result=this.tail.catch(()=>{}).then(work);this.tail=result.catch(()=>{});return result;}
  private async state(){if(this.closed||this.faulted)throw unavailable();try{return parseContactAuthority(await this.deps.store.get(contactAuthorityKind,'main'));}catch{this.faulted=true;throw unavailable();}}
  private async ready(){const state=await this.state();if(state.state!=='ready'||this.pendingMutations>0)throw unavailable();return state;}
  private config(state:ContactAuthority,channel:AdminChannel){return state.providers[channel==='gmail'?'gmail':'twilio'];}
  private key(generation:string,kind:string){return 'contact:'+generation+':'+kind;}
  private actual(state:ContactAuthority,channel:'gmail'|'sms'|'voice'|'whatsapp'){
    const c=this.config(state,channel);if(!c?.enabled)throw unavailable();
    if(channel==='gmail'){if(!c.clientId)throw unavailable();return new GmailProvider({clientId:c.clientId,sender:c.sender,vaultKey:this.key(c.generation,'gmail')},this.deps.vault,this.fetcher,this.clock);}
    if(!c.accountSid)throw unavailable();return new TwilioProvider(channel,{accountSid:c.accountSid,authTokenKey:this.key(c.generation,'twilio'),sender:canonicalRecipient(channel,c.sender),voiceEnabled:c.voiceEnabled,approvedText:state.approvedText.filter(t=>t.providerGeneration===c.generation)},this.deps.vault,this.fetcher);
  }
  private provider(channel:'gmail'|'sms'|'voice'|'whatsapp'):ContactProvider {
    return {id:channel==='gmail'?'gmail':'twilio-'+channel,channel,configurationId:async()=>this.config(await this.ready(),channel)?.generation??'unconfigured',
      prepare:async(message,signal)=>{const state=await this.ready(),generation=this.config(state,channel)?.generation,fence=this.fence;
        const check=async()=>{signal.throwIfAborted();if(this.fence!==fence||this.config(await this.ready(),channel)?.generation!==generation)throw unavailable();};
        await check();const prepared=await this.actual(state,channel).prepare(message,signal);await check();
        return {dispatch:async()=>{await check();return prepared.dispatch();}};
      },...(channel==='gmail'?{}:{observe:async(message:Readonly<OutboundMessage>,recordId:string,signal:AbortSignal)=>{
        const state=await this.ready(),fence=this.fence,provider=this.actual(state,channel) as TwilioProvider;signal.throwIfAborted();const result=await provider.observe(message,recordId,signal);signal.throwIfAborted();if(fence!==this.fence)throw unavailable();return result;
      }})};
  }
  private async channelReadiness(s:ContactAuthority,channel:'gmail'|'sms'|'voice'|'whatsapp'){
    const c=this.config(s,channel);let secretStored=false;
    if(s.state==='ready'&&c?.enabled&&c.connected)try{const raw=await this.deps.vault.read(this.key(c.generation,channel==='gmail'?'gmail':'twilio'));if(channel==='gmail'){const tokens=raw?GmailStoredTokensSchema.parse(JSON.parse(raw)):undefined;secretStored=!!tokens?.refreshToken&&!!tokens.accessToken;}else secretStored=typeof raw==='string'&&raw.length>0;}catch{/* Never expose protection/provider failures. */}
    const configured=!!c?.enabled&&secretStored,enabled=s.state==='ready'&&s.limits[channel].enabled;
    const limits=s.limits[channel],spendingReady=(channel==='gmail'||limits.unitCostMicros>0)&&limits.maxDispatchCostMicros>=limits.unitCostMicros&&limits.dailyBudgetMicros>=limits.unitCostMicros;
    const ready=configured&&enabled&&spendingReady&&(channel!=='voice'||c?.voiceEnabled===true)&&(channel!=='whatsapp'||s.approvedText.some(t=>t.providerGeneration===c?.generation&&t.checkedAt<=this.clock()&&this.clock()-t.checkedAt<=86400000));
    return {channel,configured,enabled,ready,secretStored};
  }
  private async androidReadiness(s:ContactAuthority){const routes=s.routes.filter(r=>r.channel==='android'&&r.enabled&&r.optedIn),configured=routes.length>0,enabled=s.state==='ready'&&s.limits.android.enabled;let ready=false;for(const r of routes)if(enabled&&await this.paired?.(r.destination))ready=true;return {channel:'android' as const,configured,enabled,ready,secretStored:false};}
  private async availability(){try{const s=await this.ready(),channels=[...await Promise.all((['gmail','sms','voice','whatsapp'] as const).map(c=>this.channelReadiness(s,c))),await this.androidReadiness(s)];return {enabled:true,configured:channels.some(c=>c.configured),ready:channels.some(c=>c.ready)};}catch{return {enabled:false,configured:false,ready:false};}}
  private route(state:ContactAuthority,id:string){const route=state.routes.find(r=>r.id===id);if(!route?.enabled||!route.optedIn)throw unavailable();const c=this.config(state,route.channel);if(route.channel!=='android'&&(!c?.enabled||!c.connected||c.generation!==route.providerGeneration))throw unavailable();return route;}
  private routeIdentity(route:AdminRoute):Omit<ContactRoute,'verification'>{return {id:route.id,revision:route.revision,adapter:route.channel==='android'?'paired-android':route.channel==='gmail'?'gmail':'twilio-'+route.channel,recipientId:route.recipientId,recipientSha256:sha256(route.destination),kind:route.kind,enabled:route.enabled};}
  private approvedTemplate(state:ContactAuthority,route:AdminRoute,sid?:string):ApprovedText|undefined {
    if(route.channel!=='whatsapp')return undefined;
    const account=state.providers.twilio,now=this.clock(),template=state.approvedText.find(t=>t.sid===sid&&t.accountSid===account?.accountSid&&t.providerGeneration===route.providerGeneration);
    if(!template||template.checkedAt>now||now-template.checkedAt>86400000)throw unavailable();
    return template;
  }
  private policy(state:ContactAuthority,route:AdminRoute,message?:OutboundMessage){const c=this.config(state,route.channel),{unitCostMicros,...limits}=state.limits[route.channel];
    // Worst-case UCS-2 SMS segments (including surrogate pairs); voice reserves
    // whole started minutes at the configured rate, never an ineffective maxPrice.
    const units=route.channel==='sms'&&message?message.body.length<=70?1:Math.ceil(message.body.length/67):route.channel==='voice'?Math.ceil((message?.maxVoiceSeconds??30)/60):1;
    const estimate=unitCostMicros*units;if(!Number.isSafeInteger(estimate)||estimate>limits.maxDispatchCostMicros||['sms','voice','whatsapp'].includes(route.channel)&&unitCostMicros<=0)throw unavailable();
    return {...limits,maxDispatchCostMicros:estimate,configured:route.channel==='android'||c?.connected===true,sender:route.channel==='android'?'desktop':canonicalRecipient(route.channel,c!.sender),optedInRecipientHashes:route.optedIn?[sha256(route.destination)]:[],approvedTemplateSids:state.approvedText.filter(t=>t.providerGeneration===c?.generation).map(t=>t.sid)};}
  private async resolve(intent:ContactIntent,context:ExtensionActionContext):Promise<ResolvedContact>{
    const d=this.drafts.get(intent.requestId);if(!d||!equal(d.intent,intent))throw unavailable();d.assertCurrent();d.signal.throwIfAborted();context.signal.throwIfAborted();
    const s=await this.ready(),route=this.route(s,d.route.id),workflow=s.workflows.find(w=>w.id===intent.binding.workflowId),template=s.templates.find(t=>t.id===intent.binding.templateId);
    if(!equal(route,d.route)||!workflow?.enabled||workflow.revision!==d.workflowRevision||!template?.enabled||template.revision!==d.templateRevision)throw unavailable();
    const approved=this.approvedTemplate(s,route,template.whatsappSid);
    const policy=this.policy(s,route),message=renderContactWorkflow(template,d.status,{channel:route.channel,recipient:route.destination,sender:policy.sender,approvedText:approved});
    if(!equal(message,d.message))throw unavailable();d.assertCurrent();context.signal.throwIfAborted();
    return {message,channelPolicy:this.policy(s,route,message),execution:{active:!d.signal.aborted,localOnly:context.localOnly},whatsappTemplate:approved,
      context:{settings:defaultExtensionSettings(),route:{...this.routeIdentity(route),verification:{method:'user-challenge',recordId:'unverified',verifiedAt:0,expiresAt:0}},
        workflow:{id:workflow.id,enabled:workflow.enabled,automatic:d.automatic,templateIds:[template.id]},template:{id:template.id,version:template.revision,bodySha256:intent.binding.bodySha256,contentClass:template.contentClass},
        privateSession:context.privateSession,containsPrivateContent:d.privateContent,rules:s.rules,approvals:[]}};
  }
  private async prepare(s:ContactAuthority,workflowId:string,scope:ContactAdminScope,status:ContactWorkflowStatus,automatic:boolean):Promise<ContactIntent>{
    scope.assertCurrent();if(scope.localOnly)throw unavailable();const workflow=s.workflows.find(w=>w.id===workflowId&&w.enabled),template=s.templates.find(t=>t.id===workflow?.templateId&&t.enabled);
    if(!workflow||!template||automatic&&workflow.trigger!=='task-completed'||automatic&&(scope.privateSession||template.contentClass==='private'))throw unavailable();
    const route=this.route(s,workflow.routeId),policy=this.policy(s,route),approved=this.approvedTemplate(s,route,template.whatsappSid);
    const message=renderContactWorkflow(template,status,{channel:route.channel,sender:policy.sender,recipient:route.destination,approvedText:approved});
    const intent=notificationIntent({routeId:route.id,routeRevision:route.revision,recipientId:route.recipientId,recipientSha256:sha256(route.destination),workflowId:workflow.id,templateId:template.id,templateVersion:template.revision},message);
    for(const [id,d]of this.drafts)if(d.signal.aborted||!s.routes.some(r=>equal(r,d.route))||!s.templates.some(t=>t.id===d.intent.binding.templateId&&t.revision===d.templateRevision))this.drafts.delete(id);
    if(this.drafts.size>=1000)throw unavailable();this.drafts.set(intent.requestId,{intent,message,route:structuredClone(route),templateRevision:template.revision,workflowRevision:workflow.revision,epoch:scope.privacyEpoch,signal:scope.signal,assertCurrent:scope.assertCurrent,status,automatic,privateContent:scope.privateSession||template.contentClass==='private'});return intent;
  }
  async overview(_context:ExtensionActionContext):Promise<HubContactsOverview>{const s=await this.state();return {providers:await Promise.all((['gmail','sms','voice','whatsapp'] as const).map(async channel=>{const value=await this.channelReadiness(s,channel);return {channel,configured:value.configured&&(channel!=='voice'||s.providers.twilio?.voiceEnabled===true),secretStored:value.secretStored};})),
    routes:await Promise.all(s.routes.map(async r=>{const proof=s.state==='ready'&&r.enabled?await this.proofs.verifiedRoute(this.routeIdentity(r)):undefined;return {id:r.id,revision:r.revision,channel:r.channel,kind:r.kind,label:'Contact route',enabled:r.enabled,verified:!!proof,...(proof?{verificationExpiresAt:proof.verification.expiresAt}:{})};})),rules:s.rules.map(r=>({id:r.id,routeId:r.binding.routeId,workflowId:r.binding.workflowId,templateId:r.binding.templateId,expiresAt:r.expiresAt,revoked:r.revoked})),outbox:[]};}
  private async summary(){const s=await this.state(),channels=await Promise.all((['gmail','sms','voice','whatsapp'] as const).map(async channel=>({...await this.channelReadiness(s,channel),limits:s.limits[channel]})));return ContactAdminStatusSchema.parse({revision:s.revision,state:s.state,channels:[...channels,{...await this.androidReadiness(s),limits:s.limits.android}],routes:await Promise.all(s.routes.map(async r=>{const proof=s.state==='ready'&&r.enabled?await this.proofs.verifiedRoute(this.routeIdentity(r)):undefined;return {id:r.id,revision:r.revision,channel:r.channel,kind:r.kind,enabled:r.enabled,optedIn:r.optedIn,verified:!!proof,...(proof?{verificationExpiresAt:proof.verification.expiresAt}:{})};})),templates:s.templates.map(t=>({id:t.id,revision:t.revision,enabled:t.enabled})),workflows:s.workflows.map(w=>({id:w.id,revision:w.revision,enabled:w.enabled,trigger:w.trigger})),rules:s.rules.map(r=>({id:r.id,revoked:r.revoked,expiresAt:r.expiresAt})),oauthPending:!!this.oauth,billing:'local-conservative-estimate'});}
  /** Called only by the service's injected desktop-owner closure. */
  async administer(raw:unknown,scope:ContactAdminScope,handle:HubContext):Promise<ContactAdminReply>{
    const request=ContactAdminRequestSchema.parse(raw);scope.assertCurrent();
    const key=canonicalJson({request,epoch:scope.privacyEpoch,revision:scope.revision,taskId:scope.taskId??null,privateSession:scope.privateSession,localOnly:scope.localOnly??false});
    const prior=this.inFlight.get(key);
    if(prior){const result=await prior;scope.assertCurrent();return structuredClone(result);}
    if(this.inFlight.size>=128)throw unavailable();
    const pending=this.runAdministration(request,scope,handle);this.inFlight.set(key,pending);
    try{return await pending;}finally{if(this.inFlight.get(key)===pending)this.inFlight.delete(key);}
  }
  private async runAdministration(raw:unknown,scope:ContactAdminScope,handle:HubContext):Promise<ContactAdminReply>{
    const request=ContactAdminRequestSchema.parse(raw);scope.assertCurrent();if(!this.hub)throw unavailable();
    if(request.action==='status'){const status=await this.summary();scope.assertCurrent();return ContactAdminReplySchema.parse({requestId:request.requestId,status});}
    const fence=++this.fence;
    let mutationClaimed=['recover-setup','configure-gmail','configure-twilio','disconnect-gmail','disable-twilio','save-route','disable-route','set-limits','save-template','save-workflow','recheck-whatsapp','revoke-rule'].includes(request.action);
    if(mutationClaimed)this.pendingMutations++;
    return this.serialize(async()=>{
      const check=()=>{scope.assertCurrent();scope.signal.throwIfAborted();if(fence!==this.fence)throw unavailable();if(request.action==='recover-setup')this.deps.vault.assertUsable?.();};check();
      const s=await this.state();check();
      const base={id:randomUUID(),requestId:request.requestId,feature:'contacts' as const,action:request.action,observedAt:this.clock()};
      const unknownReceipt=():ActionReceipt=>ActionReceiptSchema.parse({...base,outcome:'unconfirmed',effect:'unknown',error:{code:'unconfirmed',message:'Contact action could not be confirmed. Inspect current configuration and the original outbox.',retry:'read-only-reconcile'}});
      const conflictReply=async()=>{const status=await this.summary();check();return ContactAdminReplySchema.parse({status,receipt:ActionReceiptSchema.parse({...base,outcome:'rejected',effect:'none',error:{code:'conflict',message:'Contact configuration or request identity changed. Refresh before review.',retry:'after-review'}})});};
      const digest=sha256(canonicalJson(request)),prior=s.actions.find(a=>a.id===request.requestId);
      if(prior){if(prior.digest!==digest)return conflictReply();const status=await this.summary();check();if(s.state!=='ready')return ContactAdminReplySchema.parse({receipt:unknownReceipt(),status});return ContactAdminReplySchema.parse({receipt:prior.receipt??unknownReceipt(),status,...(prior.intent?{intent:prior.intent}:{}),...(prior.challenge?{challenge:prior.challenge}:{})});}
      if(s.revision!==request.expectedRevision)return conflictReply();
      if(s.actions.length>=10000)throw unavailable();s.actions.push({id:request.requestId,digest});s.revision++;await writeContactAuthority(this.deps.store,s);check();
      let delivery:unknown,intent:ContactIntent|undefined,challenge:unknown;
      try{
        if(s.state==='retention-required')throw unavailable();
        if(scope.privateSession&&!['prepare-notification','cancel-gmail'].includes(request.action))throw unavailable();
        if(request.action==='recover-setup'){
          if(s.state!=='review-required'||scope.taskId||scope.localOnly||!this.deps.vault.assertUsable)throw unavailable();
          // Validate the opaque live Hub principal as well as the service scope.
          this.hub!.contactAdministration(handle);this.deps.vault.assertUsable();check();
        }else if(s.state!=='ready')throw unavailable();
        const facade=['verify-begin','verify-complete','reconcile','add-rule'].includes(request.action)?this.hub!.contactAdministration(handle):undefined;
        const mutate=async(plan:(next:ContactAuthority)=>Promise<void>|void,effect?:(next:ContactAuthority)=>Promise<void>)=>{
          if(!mutationClaimed){mutationClaimed=true;this.pendingMutations++;}
          const next=structuredClone(s);
          if(s.state!=='ready'){
            if(request.action!=='recover-setup')throw unavailable();
          }
          // Planning contains only deterministic validation and explicit read-only
          // preparation. A typo, refused catalog read or retired owner cannot
          // change any route, credential generation, verification or permission.
          await plan(next);check();next.state='ready';ContactAuthoritySchema.parse(next);
          if(!equal(await this.state(),s))throw unavailable();check();
          const blocked=this.mutationFence(s,next);blocked.revision=s.revision+1;
          for(const rows of ['routes','templates','workflows'] as const)for(const row of next[rows]){
            const denied=blocked[rows].find(r=>r.id===row.id);
            if(denied&&!equal(denied,row))row.revision=Math.max(row.revision,denied.revision+1);
          }
          next.revision=s.revision+2;
          ContactAuthoritySchema.parse(blocked);ContactAuthoritySchema.parse(next);
          clearContactReviews(this.deps.store);
          // Only replace a record this operation actually wrote/read. Never
          // recover an old snapshot over newer authority (including a tombstone).
          const replaceKnown=async(known:ContactAuthority[],replacement:ContactAuthority)=>{
            const current=await this.state();if(!known.some(value=>equal(value,current)))throw unavailable();
            const saved={...structuredClone(replacement),revision:current.revision+1};
            if(replacement===blocked)for(const rows of ['routes','templates','workflows'] as const)for(const row of saved[rows]){
              const uncertain=current[rows].find(r=>r.id===row.id);
              if(uncertain&&!equal(uncertain,row))row.revision=Math.max(row.revision,uncertain.revision+1);
            }
            await writeContactAuthority(this.deps.store,saved);
          };
          const retainUnavailable=async(known:ContactAuthority[])=>{
            try{await replaceKnown(known,blocked);}catch{this.faulted=true;}
          };
          try{await writeContactAuthority(this.deps.store,blocked);}catch{
            // An uncertain authority write must not restore old permission.
            await retainUnavailable([s,blocked]);throw unavailable();
          }
          let effectStarted=false,committing=false;
          try{
            check();
            if(effect){effectStarted=true;await effect(next);check();}
            if(!equal(await this.state(),blocked))throw unavailable();check();
            committing=true;await writeContactAuthority(this.deps.store,next);
          }catch{
            if(!effectStarted&&!committing){
              // The fence was read back and no external/protected effect began.
              // Restore the unchanged authority at a higher revision even when
              // Stop/privacy/supersession retired this action's response scope.
              try{await replaceKnown([blocked],s);}catch{this.faulted=true;}
            }else await retainUnavailable([blocked,next]);
            throw unavailable();
          }
          try{check();}catch{
            if(!effectStarted){try{await replaceKnown([next],s);}catch{this.faulted=true;}}
            else await retainUnavailable([next]);
            throw unavailable();
          }
        };
        switch(request.action){
          case 'recover-setup':{const pending=this.oauth;await mutate(n=>{
            n.providers={};n.approvedText=[];
            for(const channel of ['gmail','sms','voice','whatsapp','android'] as const)n.limits[channel]=zeroContactLimits();
            for(const r of n.routes){r.enabled=false;r.optedIn=false;r.revision++;r.providerGeneration=randomUUID();}
            for(const t of n.templates){t.enabled=false;t.revision++;}
            for(const w of n.workflows){w.enabled=false;w.revision++;}
            for(const r of n.rules)r.revoked=true;
            for(const e of n.events)e.retired=true;
            n.actions=n.actions.map(a=>({id:a.id,digest:a.digest}));
          },pending?async()=>{await this.cancelOAuth(pending.server);this.deps.vault.assertUsable!();check();}:undefined);
          this.drafts.clear();break;}
          case 'configure-gmail':{const sender=canonicalRecipient('gmail',request.sender),pending=this.oauth;await mutate(n=>{this.rotate(n,'gmail');const generation=randomUUID();n.providers.gmail={generation,enabled:true,connected:false,sender,clientId:request.clientId};},pending?async()=>{await this.cancelOAuth(pending.server);}:undefined);break;}
          case 'configure-twilio':await mutate(n=>{const sender=canonicalRecipient('sms',request.sender);this.rotate(n,'twilio');n.providers.twilio={generation:randomUUID(),enabled:true,connected:true,sender,accountSid:request.accountSid,voiceEnabled:request.voiceEnabled};},async n=>{const key=this.key(n.providers.twilio!.generation,'twilio');await this.deps.vault.write(key,request.authToken);check();if(await this.deps.vault.read(key)!==request.authToken)throw unavailable();});break;
          case 'disconnect-gmail':{const pending=this.oauth,c=s.providers.gmail;await mutate(n=>{const c=n.providers.gmail;this.rotate(n,'gmail');if(c){c.enabled=false;c.connected=false;c.generation=randomUUID();}},pending||c?async()=>{if(pending)await this.cancelOAuth(pending.server);check();if(c)await this.deps.vault.delete(this.key(c.generation,'gmail'));}:undefined);break;}
          case 'disable-twilio':await mutate(n=>{const c=n.providers.twilio;this.rotate(n,'twilio');if(c){c.enabled=false;c.connected=false;c.generation=randomUUID();}},async()=>{const c=s.providers.twilio;if(c)await this.deps.vault.delete(this.key(c.generation,'twilio'));});break;
          case 'connect-gmail':if(scope.privateSession)throw unavailable();await this.beginOAuth(s,scope,check);break;
          case 'cancel-gmail':await this.cancelOAuth();check();break;
          case 'save-route':await mutate(n=>{const old=request.routeId?n.routes.find(r=>r.id===request.routeId):undefined;if(request.routeId&&!old)throw unavailable();const c=this.config(n,request.channel);if(request.channel!=='android'&&!c?.enabled)throw unavailable();
            const route:AdminRoute={id:old?.id??randomUUID(),recipientId:old?.recipientId??randomUUID(),revision:(old?.revision??0)+1,channel:request.channel,destination:canonicalRecipient(request.channel,request.destination),kind:request.kind,enabled:true,optedIn:request.optedIn,providerGeneration:request.channel==='android'?'paired-android':c!.generation};
            if(old){n.routes[n.routes.indexOf(old)]=route;for(const r of n.rules)if(r.binding.routeId===old.id)r.revoked=true;}else n.routes.push(route);});break;
          case 'disable-route':await mutate(n=>{const route=n.routes.find(r=>r.id===request.routeId);if(!route)throw unavailable();route.enabled=false;route.optedIn=false;route.revision++;for(const r of n.rules)if(r.binding.routeId===route.id)r.revoked=true;});break;
          case 'set-limits':await mutate(n=>{n.limits[request.channel]=request.limits;});break;
          case 'save-template':await mutate(n=>{const old=request.templateId?n.templates.find(t=>t.id===request.templateId):undefined;if(request.templateId&&!old)throw unavailable();const t={...request.definition,id:old?.id??randomUUID(),revision:(old?.revision??0)+1};if(old)n.templates[n.templates.indexOf(old)]=t;else n.templates.push(t);for(const r of n.rules)if(r.binding.templateId===t.id)r.revoked=true;});break;
          case 'save-workflow':await mutate(n=>{if(!n.templates.some(t=>t.id===request.definition.templateId)||!n.routes.some(r=>r.id===request.definition.routeId))throw unavailable();const old=request.workflowId?n.workflows.find(w=>w.id===request.workflowId):undefined;if(request.workflowId&&!old)throw unavailable();const w={...request.definition,id:old?.id??randomUUID(),revision:(old?.revision??0)+1};if(old)n.workflows[n.workflows.indexOf(old)]=w;else n.workflows.push(w);for(const r of n.rules)if(r.binding.workflowId===w.id)r.revoked=true;});break;
          case 'recheck-whatsapp':await mutate(async n=>{const c=n.providers.twilio;if(!c?.connected)throw unavailable();const observed=await (this.actual(n,'whatsapp') as TwilioProvider).approvedPlainText(request.contentSid,request.language,scope.signal);check();const old=n.approvedText.find(t=>t.sid===request.contentSid);n.approvedText=n.approvedText.filter(t=>t.sid!==request.contentSid);n.approvedText.push({...observed,revision:(old?.revision??0)+1,providerGeneration:c.generation,checkedAt:this.clock()});for(const t of n.templates)if(t.whatsappSid===request.contentSid){t.revision++;for(const r of n.rules)if(r.binding.templateId===t.id)r.revoked=true;}});break;
          case 'verify-begin':{if(scope.privateSession)throw unavailable();const route=this.route(s,request.routeId);challenge=await facade!.beginVerification(request.routeId,async()=>{check();const now=await this.ready(),r=this.route(now,request.routeId);if(!equal(route,r))throw unavailable();const fixed=now.approvedText.find(t=>t.providerGeneration===r.providerGeneration&&t.body==='Capri verification code: {{1}}'&&equal(t.variables,['1'])),approved=this.approvedTemplate(now,r,fixed?.sid);check();return {route:this.routeIdentity(r),channel:r.channel,recipient:r.destination,channelPolicy:this.policy(now,r),whatsappTemplateSid:approved?.sid,whatsappTemplate:approved};});check();const c=challenge as {challengeId:string;requestId:string};delivery=verificationContactReceipt(c.challengeId,await facade!.dispatchVerification(c.requestId));check();break;}
          case 'verify-complete':{const route=this.route(s,request.routeId);await facade!.completeVerification(request.challengeId,request.code,this.routeIdentity(route));check();break;}
          case 'add-rule':{const draft=this.drafts.get(request.outboxRequestId);if(!draft||draft.automatic||draft.privateContent||request.review.requestId!==request.outboxRequestId||request.review.privacyEpoch!==scope.privacyEpoch||request.expiresAt<=this.clock()||request.expiresAt>this.clock()+30*86400000)throw unavailable();draft.assertCurrent();const approved=await facade!.approveRule(request.review);check();if(!equal(approved,draft.intent))throw unavailable();await mutate(n=>{n.rules.push({id:randomUUID(),binding:ruleBinding(draft.intent),createdAt:this.clock(),expiresAt:request.expiresAt,revoked:false});});break;}
          case 'revoke-rule':await mutate(n=>{const r=n.rules.find(r=>r.id===request.ruleId);if(!r)throw unavailable();r.revoked=true;});break;
          case 'prepare-rule':{intent=await this.prepare(s,request.workflowId,scope,request.completion==='verified'?'completed':'completed-unverified',false);check();delivery=await this.hub!.prepareContact(intent,handle);check();break;}
          case 'prepare-notification':{if(!s.workflows.some(w=>w.id===request.workflowId&&w.trigger==='on-demand'))throw unavailable();intent=await this.prepare(s,request.workflowId,scope,'requested',false);check();delivery=await this.hub!.dispatch('contacts','send',{requestId:intent.requestId,...(scope.taskId?{taskId:scope.taskId}:{}),input:intent},handle);check();break;}
          case 'reconcile':delivery=await facade!.reconcile(request.outboxRequestId);check();break;
        }
        check();const receipt=ActionReceiptSchema.parse({...base,outcome:'completed',effect:['reconcile','cancel-gmail'].includes(request.action)?'none':'confirmed'});
        const committed=await this.state(),record=committed.actions.find(a=>a.id===request.requestId);if(!record)throw unavailable();record.receipt=receipt;if(intent)record.intent=intent;if(challenge)record.challenge=challenge as NonNullable<typeof record.challenge>;
        committed.revision++;check();await writeContactAuthority(this.deps.store,committed);check();const status=await this.summary();check();
        return ContactAdminReplySchema.parse({receipt,status,...(intent?{intent}:{}),...(challenge?{challenge}:{}),...(delivery?{result:delivery}:{})});
      }catch{
        // No provider error or request body escapes. A failed write may have committed;
        // a challenge/send may also have dispatched: retain the original journal.
        return ContactAdminReplySchema.parse({receipt:unknownReceipt()});
      }
    }).finally(()=>{if(mutationClaimed)this.pendingMutations--;});
  }
  /** The durable pre-effect record denies only changed authority. Retain every
   * unrelated provider/route/rule and all original action/event identities. A
   * genuinely unprovable restored record keeps its global review fence. */
  private mutationFence(previous:ContactAuthority,next:ContactAuthority):ContactAuthority{
    const blocked=structuredClone(previous);
    if(previous.state!=='ready')return {...blocked,state:'review-required'};
    for(const provider of ['gmail','twilio'] as const)if(!equal(previous.providers[provider]??null,next.providers[provider]??null)){
      this.rotate(blocked,provider);const config=blocked.providers[provider];
      if(config){config.enabled=false;config.connected=false;config.generation=randomUUID();}
    }
    for(const channel of ['gmail','sms','voice','whatsapp','android'] as const)if(!equal(previous.limits[channel],next.limits[channel]))blocked.limits[channel].enabled=false;
    for(const route of blocked.routes)if(!equal(route,next.routes.find(r=>r.id===route.id)??null)){
      route.enabled=false;route.optedIn=false;route.revision=previous.routes.find(r=>r.id===route.id)!.revision+1;
    }
    for(const template of blocked.templates)if(!equal(template,next.templates.find(t=>t.id===template.id)??null)){
      template.enabled=false;template.revision=previous.templates.find(t=>t.id===template.id)!.revision+1;
    }
    for(const workflow of blocked.workflows)if(!equal(workflow,next.workflows.find(w=>w.id===workflow.id)??null)){
      workflow.enabled=false;workflow.revision=previous.workflows.find(w=>w.id===workflow.id)!.revision+1;
    }
    blocked.approvedText=blocked.approvedText.filter(t=>equal(t,next.approvedText.find(n=>n.sid===t.sid)??null));
    for(const rule of blocked.rules)if(!equal(rule,next.rules.find(r=>r.id===rule.id)??null)||blocked.routes.some(r=>r.id===rule.binding.routeId&&!r.enabled)||blocked.templates.some(t=>t.id===rule.binding.templateId&&!t.enabled)||blocked.workflows.some(w=>w.id===rule.binding.workflowId&&!w.enabled))rule.revoked=true;
    return blocked;
  }
  private rotate(n:ContactAuthority,provider:'gmail'|'twilio'){for(const r of n.routes)if(provider==='gmail'?r.channel==='gmail':['sms','voice','whatsapp'].includes(r.channel)){r.enabled=false;r.optedIn=false;r.revision++;r.providerGeneration=randomUUID();for(const rule of n.rules)if(rule.binding.routeId===r.id)rule.revoked=true;}if(provider==='twilio')n.approvedText=[];}
  private async beginOAuth(s:ContactAuthority,scope:ContactAdminScope,check:()=>void){
    await this.cancelOAuth();check();const provider=this.actual(s,'gmail') as GmailProvider,c=s.providers.gmail!,controller=new AbortController();
    const abort=()=>{controller.abort();void this.cancelOAuth(server).catch(()=>{});};scope.signal.addEventListener('abort',abort,{once:true});
    const callback='/oauth/'+randomUUID(),server=createServer((req,res)=>{void (async()=>{
      const pending=this.oauth;let accepted=false;
      try{
        check();if(!pending||pending.server!==server||controller.signal.aborted||req.method!=='GET'||!req.url||req.url.length>8192||req.headers.host!=='127.0.0.1:'+String((server.address() as any)?.port))throw unavailable();
        const url=new URL(req.url,'http://127.0.0.1');if(url.pathname!==callback||url.searchParams.getAll('state').length!==1||url.searchParams.getAll('code').length!==1||url.searchParams.get('state')!==pending.state||url.searchParams.has('error'))throw unavailable();
        const state=pending.state!;pending.state=undefined;server.close();server.closeIdleConnections();
        await provider.finishConnection(state,url.searchParams.get('code')!,controller.signal);check();
        await this.serialize(async()=>{const current=await this.ready();check();if(current.providers.gmail?.generation!==c.generation)throw unavailable();current.providers.gmail.connected=true;current.revision++;await writeContactAuthority(this.deps.store,current);check();});accepted=true;
      }catch{/* Callback text is fixed; never return codes, state or provider errors. */}
      finally{server.close();res.writeHead(accepted?200:400,{'content-type':'text/plain','cache-control':'no-store','content-security-policy':"default-src 'none'"});res.end(accepted?'Connection saved. You can close this window.':'Connection not confirmed. Return to Capri.',()=>{void this.cancelOAuth(server).catch(()=>{});});}
    })();});
    server.headersTimeout=5000;server.requestTimeout=5000;server.maxConnections=4;
    const timer=setTimeout(()=>{controller.abort();void this.cancelOAuth(server).catch(()=>{});},300000);timer.unref();this.oauth={server,controller,provider,timer,detach:()=>scope.signal.removeEventListener('abort',abort)};
    try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});check();const address=server.address();if(!address||typeof address==='string')throw unavailable();const start=await provider.beginConnection('http://127.0.0.1:'+address.port+callback);if(!this.oauth||this.oauth.server!==server||controller.signal.aborted){await provider.cancelConnection(start.state);throw unavailable();}this.oauth.state=start.state;check();
      const url=new URL(start.authorizationUrl);if(url.origin!=='https://accounts.google.com'||url.pathname!=='/o/oauth2/v2/auth'||url.searchParams.get('scope')!=='https://www.googleapis.com/auth/gmail.send')throw unavailable();await this.deps.openAuthorization(url.href);check();
    }catch{await this.cancelOAuth(server);throw unavailable();}
  }
  private async cancelOAuth(expected?:Server){const pending=this.oauth;if(!pending||expected&&pending.server!==expected)return;this.oauth=undefined;pending.controller.abort();pending.detach();clearTimeout(pending.timer);pending.server.close();pending.server.closeAllConnections();if(pending.state)await pending.provider.cancelConnection(pending.state);}
  boundary(){this.fence++;this.drafts.clear();clearContactReviews(this.deps.store);return this.cancelOAuth();}
  async close(){try{await this.boundary();}finally{this.closed=true;await this.tail;}}
  /** The service invokes this before ending the ORIGINAL task context. No stored
   * task/grant is reconstructed; completion text is never used as authority. */
  async completed(taskId:string,scope:ContactAdminScope,handle:HubContext){
    if(!this.hub)return;return this.serialize(async()=>{
      const s=await this.ready(),id=contactCompletionIdentity(taskId);if(s.events.some(e=>e.id===id))return;
      scope.assertCurrent();const task=await this.deps.store.get('task',taskId);scope.assertCurrent();
      const permitted=task?.status==='completed'&&!task.privateSession&&!task.localOnly&&!scope.privateSession;
      const requests:ContactIntent[]=[];
      if(permitted)for(const w of s.workflows)if(w.enabled&&w.trigger==='task-completed')try{requests.push(await this.prepare(s,w.id,scope,task.taskVerified===true?'completed':'completed-unverified',true));}catch{/* Unconfigured workflows remain unavailable; no retrospective retry. */}
      s.events.push({id,retired:!permitted,requests});s.revision++;await writeContactAuthority(this.deps.store,s);scope.assertCurrent();
      for(const intent of requests){scope.assertCurrent();await this.hub!.dispatch('contacts','send',{requestId:intent.requestId,taskId,input:intent},handle);}
    });
  }
}
