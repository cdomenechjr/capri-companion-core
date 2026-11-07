import {createHash,createPublicKey,verify} from 'node:crypto';
import type {TaskPermission} from '../agency';
import {
  ContactApprovalSchema,ContactIntentSchema,ContactRouteSchema,ContactRuleSchema,ContactTemplateSchema,
  ContactWorkflowSchema,CursorLeaseSchema,DeliveryReceiptSchema,ExtensionSettingsSchema,FeatureSchema,ReleaseManifestSchema,
  ReviewedSkillManifestSchema,TaskGrantSchema,
  type AgentProvider,type ContactApproval,type ContactBinding,type ContactIntent,type ContactRoute,
  type ContactRule,type ContactTemplate,type ContactWorkflow,type ExtensionSettings,type ExtensionStatus,
  type FeatureCapability,type ReleaseArtifact,type ReleaseManifest,type TaskGrant,
} from './contracts';

/** Exact UTF-8 digest; do not normalize bodies after review. No I/O or secret access. */
export function sha256(value:string):string {return createHash('sha256').update(value,'utf8').digest('hex');}
/** Version 1 signing format: sorted object keys recursively, array order preserved, no whitespace. */
export function canonicalJson(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)
    return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalJson((value as Record<string,unknown>)[k])).join(',')+'}';
  throw new TypeError('Only JSON values are supported.');
}
export function bindingMatches(a:ContactBinding,b:ContactBinding):boolean {
  return a.routeId===b.routeId&&a.routeRevision===b.routeRevision&&a.recipientId===b.recipientId&&
    a.recipientSha256===b.recipientSha256&&a.workflowId===b.workflowId&&a.templateId===b.templateId&&
    a.templateVersion===b.templateVersion&&a.bodySha256===b.bodySha256;
}
const validNow=(now:number)=>Number.isSafeInteger(now)&&now>=0;
const active=(record:{createdAt:number;expiresAt:number;revoked:boolean},now:number)=>
  !record.revoked&&record.createdAt<=now&&record.expiresAt>now&&record.expiresAt>record.createdAt;
export type PolicyDecision = {allowed:true;reason:'self'|'rule'|'approval'|'ready'} |
  {allowed:false;reason:string;approvalRequired:boolean};
const deny=(reason:string,approvalRequired=false):PolicyDecision=>({allowed:false,reason,approvalRequired});

/** All context fields come from trusted Store/session state, never model input. */
export interface ContactPolicyContext {
  now:number;
  settings:ExtensionSettings;
  route?:ContactRoute;
  workflow?:ContactWorkflow;
  template?:ContactTemplate;
  privateSession:boolean;
  containsPrivateContent:boolean;
  rules:readonly ContactRule[];
  approvals:readonly ContactApproval[];
}
export function contactPolicy(input:unknown,context:ContactPolicyContext):PolicyDecision {
  const intent=ContactIntentSchema.safeParse(input),settings=ExtensionSettingsSchema.safeParse(context.settings);
  if(!intent.success||!settings.success||!validNow(context.now)||typeof context.privateSession!=='boolean'||
    typeof context.containsPrivateContent!=='boolean')return deny('invalid-request');
  if(!settings.data.contacts.enabled)return deny('disabled');
  const r=ContactRouteSchema.safeParse(context.route),w=ContactWorkflowSchema.safeParse(context.workflow),t=ContactTemplateSchema.safeParse(context.template);
  if(!r.success||!w.success||!t.success)return deny('unverified-route');
  const route=r.data,workflow=w.data,template=t.data;
  if(!route.enabled||route.verification.verifiedAt>context.now||route.verification.expiresAt<=context.now||
    route.verification.expiresAt<=route.verification.verifiedAt)return deny('unverified-route');
  if(!workflow.enabled||!workflow.templateIds.includes(template.id))return deny('disabled-workflow');
  const expected:ContactBinding={routeId:route.id,routeRevision:route.revision,recipientId:route.recipientId,
    recipientSha256:route.recipientSha256,workflowId:workflow.id,templateId:template.id,
    templateVersion:template.version,bodySha256:template.bodySha256};
  if(!bindingMatches(intent.data.binding,expected))return deny('binding-mismatch');
  const privateContent=context.privateSession||context.containsPrivateContent||template.contentClass==='private';
  if(workflow.automatic){
    if(!settings.data.contacts.automaticEnabled)return deny('automatic-disabled');
    if(privateContent)return deny('private-automatic-content');
  }
  // Private manual content needs a one-use, exact-request UI approval, even for self.
  const approval=context.approvals.find(value=>{
    const parsed=ContactApprovalSchema.safeParse(value);
    return parsed.success&&active(parsed.data,context.now)&&parsed.data.requestId===intent.data.requestId&&
      bindingMatches(parsed.data.binding,expected);
  });
  if(approval)return {allowed:true,reason:'approval'};
  if(!privateContent){
    if(route.kind==='self')return {allowed:true,reason:'self'};
    if(context.rules.some(value=>{
      const parsed=ContactRuleSchema.safeParse(value);
      return parsed.success&&active(parsed.data,context.now)&&bindingMatches(parsed.data.binding,expected);
    }))return {allowed:true,reason:'rule'};
  }
  return deny('approval-required',true);
}

/** Only call with adapter evidence from a trusted transport/observation, not error text. */
export function deliveryOutcome(intent:ContactIntent,adapter:string,receipt:unknown):'pending'|'accepted'|'sent'|'delivered'|'rejected'|'unconfirmed' {
  const parsedIntent=ContactIntentSchema.safeParse(intent),parsed=DeliveryReceiptSchema.safeParse(receipt);
  if(!parsedIntent.success||!parsed.success)return 'unconfirmed';
  const r=parsed.data;
  if(r.requestId!==intent.requestId||r.adapter!==adapter||!bindingMatches(r.binding,intent.binding))return 'unconfirmed';
  return r.state;
}

export function featureCapability(input:{enabled:boolean;configured:boolean;supported:boolean;trusted?:boolean;
  ready?:boolean;verification?:FeatureCapability['verification'];actions?:string[]}):FeatureCapability {
  const reason:FeatureCapability['reason']=!input.supported?'unsupported':!input.configured?'unconfigured':
    !input.enabled?'disabled':input.trusted===false?'untrusted':input.ready===false?'unavailable':'ready';
  return {available:reason==='ready',enabled:input.enabled,configured:input.configured,
    reason,verification:input.verification??'none',actions:reason==='ready'?[...(input.actions??[])]:[]};
}
export function defaultExtensionStatus(now:number):ExtensionStatus {
  if(!validNow(now))throw new TypeError('Invalid observation time.');
  const features={} as ExtensionStatus['features'];
  for(const feature of FeatureSchema.options)features[feature]=featureCapability({enabled:false,configured:false,supported:true});
  features.updates={...features.updates,reason:'untrusted'};
  return {schemaVersion:1,observedAt:now,features,cursor:{state:'inactive',recoveryAvailable:false},
    listening:{state:'disabled',owner:'desktop',localOnly:true},
    agents:['codex','claude-api'].map(provider=>({provider:provider as AgentProvider,
      capability:featureCapability({enabled:false,configured:false,supported:true})})),updates:{state:'untrusted'}};
}
export function decorativeMotionAllowed(input:{gameDocked:boolean;reducedMotion:boolean;intensity:number}):boolean {
  return !input.gameDocked&&!input.reducedMotion&&Number.isFinite(input.intensity)&&input.intensity>0;
}

/** Host renews only for the original live owner; a missed lease cannot be resurrected. */
export function cursorLeasePolicy(input:unknown,context:{now:number;ownerId:string;ownerAlive:boolean}):
  {action:'renew';expiresAt:number}|{action:'restore';reason:'invalid-lease'|'owner-lost'|'lease-expired'} {
  const lease=CursorLeaseSchema.safeParse(input);
  if(!lease.success||!validNow(context.now)||!validNow(context.now+lease.data.leaseMs))
    return {action:'restore',reason:'invalid-lease'};
  if(context.ownerAlive!==true||context.ownerId!==lease.data.ownerId)return {action:'restore',reason:'owner-lost'};
  if(lease.data.expiresAt<=context.now)return {action:'restore',reason:'lease-expired'};
  if(lease.data.expiresAt>context.now+lease.data.leaseMs)return {action:'restore',reason:'invalid-lease'};
  return {action:'renew',expiresAt:context.now+lease.data.leaseMs};
}

/** The host computes local-day due state from its journal; this never starts a scan. */
export function securitySchedulePolicy(context:{settings:ExtensionSettings;profile:'user'|'development'|'self-test';
  hostAvailable:boolean;due:boolean;active:boolean;gameDocked:boolean}):PolicyDecision {
  const settings=ExtensionSettingsSchema.safeParse(context.settings);
  if(!settings.success)return deny('invalid-settings');
  if(context.profile!=='user')return deny('non-user-profile');
  if(!settings.data.security.enabled||!settings.data.security.dailyQuickScan)return deny('disabled');
  if(context.hostAvailable!==true)return deny('unavailable');
  if(context.due!==true)return deny('not-due');
  if(context.active!==false||context.gameDocked!==false)return deny('deferred');
  return {allowed:true,reason:'ready'};
}

export interface AgentPolicyContext {
  now:number;settings:ExtensionSettings;localOnly:boolean;privateSession:boolean;
  configuredProviders:readonly AgentProvider[];
  grant?:TaskGrant;
  parentGrant?:TaskPermission; // freshly resolved from TaskAccess, not a stale snapshot
}
export function agentPolicy(input:{taskId:string;provider:AgentProvider;workspaceId:string},context:AgentPolicyContext):PolicyDecision {
  const settings=ExtensionSettingsSchema.safeParse(context.settings),g=TaskGrantSchema.safeParse(context.grant);
  if(!settings.success||!validNow(context.now)||typeof context.privateSession!=='boolean'||typeof context.localOnly!=='boolean'||
    !['codex','claude-api'].includes(input.provider))return deny('invalid-request');
  const enabled=input.provider==='codex'?settings.data.agents.codexEnabled:settings.data.agents.claudeApiEnabled;
  if(!enabled)return deny('disabled');
  if(context.localOnly)return deny('local-only'); // Both runtime delegates can use remote inference.
  if(context.privateSession)return deny('private-session'); // No persistent CLI/provider handoff for private tasks.
  if(!context.configuredProviders.includes(input.provider))return deny('unconfigured');
  if(!g.success||!active(g.data,context.now))return deny('grant-required');
  const grant=g.data,parent=context.parentGrant;
  if(!parent||parent.revoked||parent.taskId!==grant.taskId||parent.mode!==grant.mode||
    parent.createdAt!==grant.createdAt||parent.request!==grant.request||grant.taskId!==input.taskId)return deny('grant-revoked');
  if(!grant.providers.includes(input.provider)||!grant.workspaceIds.includes(input.workspaceId))return deny('outside-task-scope');
  if(input.provider==='claude-api'&&!grant.allowPaid)return deny('paid-not-authorized');
  return {allowed:true,reason:'ready'};
}

export function skillPolicy(input:unknown,context:{now:number;enabled:boolean;localOnly:boolean;sourceSha256:string;
  availableCapabilities?:readonly string[];availableDependencies?:readonly string[];availableVerifiers?:readonly string[];verifiedChecks?:readonly string[]}):PolicyDecision {
  const parsed=ReviewedSkillManifestSchema.safeParse(input);
  if(!parsed.success||!validNow(context.now))return deny('invalid-manifest');
  if(!context.enabled)return deny('disabled');
  const {manifest,review}=parsed.data;
  if(review.revoked||review.reviewedAt>context.now||review.skillId!==manifest.id||review.version!==manifest.version||
    review.sourceSha256!==manifest.sourceSha256||context.sourceSha256!==manifest.sourceSha256||
    review.manifestSha256!==sha256(canonicalJson(manifest)))return deny('review-required',true);
  if(context.localOnly&&(!manifest.localOnly||manifest.permissions.some(p=>p==='network'||p==='delegate')))return deny('local-only');
  if(manifest.requiredCapabilities.some(id=>!context.availableCapabilities?.includes(id)))return deny('missing-capability');
  if(manifest.dependencies.some(id=>!context.availableDependencies?.includes(id)))return deny('missing-dependency');
  if(manifest.verification.some(v=>v.kind==='source-sha256'?v.sha256!==context.sourceSha256:
    !context.availableVerifiers?.includes(v.checkId)))return deny('verification-required');
  // This only authorizes loading; execution still intersects TaskAccess/host grants.
  return {allowed:true,reason:'ready'};
}

export function releaseSigningPayload(manifest:ReleaseManifest):string {return canonicalJson(manifest.release);}
export interface ReleasePolicyContext {
  now:number;channel:'stable'|'preview';platform:'win32'|'android';arch:'x64'|'arm64';
  currentSequence:number;dataVersion:number;
  trustedKeys:Readonly<Record<string,string>>; // keyId -> pinned Ed25519 PEM public key; never from the manifest
  /** Legacy advisory list; Ed25519 manifest signature authenticates artifact hashes. */
  trustedPublisherKeyIds?:readonly string[];
}
export type ReleaseDecision = {available:true;reason:'verified';artifact:ReleaseArtifact} | {available:false;reason:string};
export function releasePolicy(input:unknown,context:ReleasePolicyContext):ReleaseDecision {
  const parsed=ReleaseManifestSchema.safeParse(input);
  if(!parsed.success||!validNow(context.now)||!Number.isSafeInteger(context.currentSequence)||context.currentSequence<0||
    !Number.isSafeInteger(context.dataVersion)||context.dataVersion<1)return {available:false,reason:'invalid-manifest'};
  const manifest=parsed.data,release=manifest.release;
  const key=Object.hasOwn(context.trustedKeys,manifest.signature.keyId)?context.trustedKeys[manifest.signature.keyId]:undefined;
  if(!key)return {available:false,reason:'untrusted'};
  try {
    const publicKey=createPublicKey(key);
    if(publicKey.asymmetricKeyType!=='ed25519'||!verify(null,Buffer.from(releaseSigningPayload(manifest),'utf8'),publicKey,
      Buffer.from(manifest.signature.value,'base64')))return {available:false,reason:'invalid-signature'};
  }catch{return {available:false,reason:'invalid-signature'};}
  if(release.publishedAt>context.now||release.expiresAt<=context.now)return {available:false,reason:'expired-or-future'};
  if(release.sequence<=context.currentSequence)return {available:false,reason:'rollback-or-current'};
  if(release.channel!==context.channel)return {available:false,reason:'channel-mismatch'};
  if(context.dataVersion<release.migration.readMin||context.dataVersion>release.migration.readMax)
    return {available:false,reason:'incompatible-data'};
  const artifacts=release.artifacts.filter(a=>a.platform===context.platform&&a.arch===context.arch);
  if(artifacts.length!==1)return {available:false,reason:'unsupported-artifact'};
  return {available:true,reason:'verified',artifact:artifacts[0]};
}

/** Trusted host facts only. No installation, network access or Authenticode requirement. */
export function automaticUpdatePolicy(context:{settings:ExtensionSettings;trustedConfiguration:boolean;
  candidateVerified:boolean;artifactHashVerified:boolean;independentAcceptanceVerified:boolean;
  backupVerified:boolean;idle:boolean;aborted:boolean}):PolicyDecision {
  const settings=ExtensionSettingsSchema.safeParse(context.settings);
  if(!settings.success)return deny('invalid-settings');
  if(!settings.data.updates.automatic)return deny('disabled');
  if(context.trustedConfiguration!==true)return deny('untrusted');
  if(context.candidateVerified!==true||context.artifactHashVerified!==true||context.independentAcceptanceVerified!==true)
    return deny('verification-required');
  if(context.backupVerified!==true)return deny('backup-required');
  if(context.aborted!==false)return deny('cancelled');
  if(context.idle!==true)return deny('deferred');
  return {allowed:true,reason:'ready'};
}
