import {z} from 'zod';
import type {TaskPermission} from '../agency';
import type {Store} from '../server/store';

// Additive records: parse only the extension subtree, never legacy Settings.
export const extensionContractVersion = 1 as const;
export const IdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const TimestampSchema = z.number().int().nonnegative().safe(); // Unix milliseconds
const summary = z.string().max(240); // Apply existing display redaction before rendering.
export const FeatureSchema = z.enum(['cursor','listening','skills','agents','security','contacts','assets','updates']);
export type ExtensionFeature = z.infer<typeof FeatureSchema>;
export const FeatureCapabilitySchema = z.object({
  available:z.boolean(), configured:z.boolean(), enabled:z.boolean(),
  verification:z.enum(['none','configuration','local-probe','verified']),
  reason:z.enum(['ready','disabled','unconfigured','unsupported','untrusted','unavailable']),
  actions:z.array(IdSchema).max(32),
}).strict().superRefine((c,ctx)=>{
  if(c.available!==(c.reason==='ready')||(c.available&&(!c.enabled||!c.configured))||(!c.available&&c.actions.length>0))
    ctx.addIssue({code:'custom',message:'Capability readiness and actions must agree.'});
});
export type FeatureCapability = z.infer<typeof FeatureCapabilitySchema>;
export const CursorSettingsSchema = z.object({
  // Zero means this session, until disable/Stop/Quit; positive values are optional trials.
  enabled:z.boolean().default(false), durationMs:z.union([z.literal(0),z.number().int().min(1000).max(300000)]).default(0),
  watchdogLeaseMs:z.number().int().min(1000).max(60000).default(15000),
  intensity:z.number().min(0).max(1).default(1),
}).strict();
export type CursorSettings = z.infer<typeof CursorSettingsSchema>;
export const CursorSuspensionReasonSchema = z.enum(['reduced-motion','game-docked','intensity-zero','locked','accessibility','owner-conflict','host-unavailable']);
export type CursorSuspensionReason = z.infer<typeof CursorSuspensionReasonSchema>;
export const CursorLeaseSchema = z.object({
  ownerId:IdSchema,expiresAt:TimestampSchema,leaseMs:z.number().int().min(1000).max(60000),
}).strict();
export type CursorLease = z.infer<typeof CursorLeaseSchema>;
export const CursorStatusSchema = z.object({
  state:z.enum(['inactive','active','suspended','restoring','recovery-required','unsupported']),
  suspensionReason:CursorSuspensionReasonSchema.optional(),watchdogExpiresAt:TimestampSchema.optional(),
  expiresAt:TimestampSchema.optional(), recoveryAvailable:z.boolean(),
}).strict().refine(s=>(s.state==='suspended')===(s.suspensionReason!==undefined),{message:'Suspension needs a bounded reason, only while suspended.'});
export type CursorStatus = z.infer<typeof CursorStatusSchema>;
export const ListeningSettingsSchema = z.object({
  enabled:z.boolean().default(false), mode:z.enum(['wake','push-to-talk']).default('wake'),
  localOnly:z.literal(true).default(true), noiseSuppression:z.boolean().default(true),
  vadThreshold:z.number().min(0).max(1).default(0.5),
  silenceMs:z.number().int().min(200).max(5000).default(800),
}).strict();
export type ListeningSettings = z.infer<typeof ListeningSettingsSchema>;
export const SecuritySettingsSchema = z.object({
  enabled:z.boolean().default(true),dailyQuickScan:z.boolean().default(true),localHour:z.literal(9).default(9),
  deferDuringActivity:z.literal(true).default(true),deferDuringGames:z.literal(true).default(true),
}).strict();
export type SecuritySettings = z.infer<typeof SecuritySettingsSchema>;
export const ExtensionSettingsSchema = z.object({
  cursor:CursorSettingsSchema.prefault({}), listening:ListeningSettingsSchema.prefault({}),
  skills:z.object({enabled:z.boolean().default(false)}).strict().prefault({}),
  agents:z.object({codexEnabled:z.boolean().default(false),claudeApiEnabled:z.boolean().default(false)}).strict().prefault({}),
  security:SecuritySettingsSchema.prefault({}),
  contacts:z.object({enabled:z.boolean().default(false),automaticEnabled:z.boolean().default(false)}).strict().prefault({}),
  assets:z.object({privateImportsEnabled:z.boolean().default(false)}).strict().prefault({}),
  // This preference grants no trust. Unconfigured/portable builds remain unavailable.
  updates:z.object({automatic:z.boolean().default(true),channel:z.enum(['stable','preview']).default('stable')}).strict().prefault({}),
}).strict().prefault({});
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;
export function defaultExtensionSettings():ExtensionSettings {return ExtensionSettingsSchema.parse(undefined);}

export const SkillVerificationSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('source-sha256'),sha256:Sha256Schema}).strict(),
  z.object({kind:z.literal('registered-check'),checkId:IdSchema}).strict(),
]);
export type SkillVerification = z.infer<typeof SkillVerificationSchema>;
export const SkillManifestSchema = z.object({
  schemaVersion:z.literal(1), id:IdSchema, version:IdSchema, name:z.string().min(1).max(100),
  description:summary, sourceSha256:Sha256Schema, entrypoint:IdSchema,
  permissions:z.array(z.enum(['workspace-read','workspace-write','host-tools','network','delegate'])).max(5),
  requiredCapabilities:z.array(IdSchema).max(32).default([]),
  dependencies:z.array(IdSchema).max(64).default([]),
  verification:z.array(SkillVerificationSchema).max(32).default([]),
  localOnly:z.boolean(),
}).strict();
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
// Review is a separate trusted UI record. Downloaded manifests cannot approve themselves.
export const SkillReviewSchema = z.object({
  skillId:IdSchema, version:IdSchema, manifestSha256:Sha256Schema, sourceSha256:Sha256Schema,
  reviewedAt:TimestampSchema, revoked:z.boolean(),
}).strict();
export type SkillReview = z.infer<typeof SkillReviewSchema>;
export const ReviewedSkillManifestSchema = z.object({manifest:SkillManifestSchema,review:SkillReviewSchema}).strict();
export type ReviewedSkillManifest = z.infer<typeof ReviewedSkillManifestSchema>;
export const JobStateSchema = z.enum(['pending','running','needs-approval','completed','failed','cancelled','unconfirmed']);
export type JobState = z.infer<typeof JobStateSchema>;
export const AgentProviderSchema = z.enum(['codex','claude-api']);
/** Nonsecret runtime configuration evidence. Authentication/catalog != inference entitlement. */
export const CodexModelSchema=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/).refine(v=>!/(?:token|secret|sk-)/i.test(v));
export const CodexConnectionSchema=z.object({
  state:z.enum(['unconfigured','needs-sign-in','checking','connecting','authenticated','busy','unavailable','cancelled','expired']),
  authenticated:z.boolean(),inferenceVerified:z.literal(false),model:CodexModelSchema.optional(),
  models:z.array(CodexModelSchema).max(100),sessionId:IdSchema.optional(),
}).strict();
export type CodexConnection=z.infer<typeof CodexConnectionSchema>;
export type AgentProvider = z.infer<typeof AgentProviderSchema>;
export const TaskGrantSchema = z.object({
  taskId:IdSchema,request:z.string().min(1).max(12000),mode:z.enum(['scoped','full']),
  createdAt:TimestampSchema,revoked:z.boolean(),expiresAt:TimestampSchema,
  providers:z.array(AgentProviderSchema).max(2),workspaceIds:z.array(IdSchema).max(32),allowPaid:z.boolean(),
}).strict().refine(g=>g.expiresAt>g.createdAt,{message:'Grant must expire after creation.'});
// Extends TaskAccess; it is not a second task engine or an HTTP authority record.
export type TaskGrant = z.infer<typeof TaskGrantSchema> & TaskPermission;
export const AgentJobSchema = z.object({
  id:IdSchema,taskId:IdSchema,requestId:IdSchema,provider:AgentProviderSchema,
  workspaceId:IdSchema,state:JobStateSchema,createdAt:TimestampSchema,updatedAt:TimestampSchema,
  summary,receiptId:IdSchema.optional(),
}).strict();
export type AgentJob = z.infer<typeof AgentJobSchema>;
export const SecurityOperationSchema = z.enum(['status','quick-scan','full-scan','custom-scan','update-signatures']);
export type SecurityOperation = z.infer<typeof SecurityOperationSchema>;
export const SecurityEvidenceSchema = z.object({
  id:IdSchema,jobId:IdSchema,source:z.literal('windows-defender'),observedAt:TimestampSchema,
  outcome:z.enum(['no-detection','remediated','action-required','unavailable','uncertain','healthy','findings','failed','cancelled','unconfirmed']),
  recordId:IdSchema.optional(),summary,
}).strict();
export type SecurityEvidence = z.infer<typeof SecurityEvidenceSchema>;
export const SecurityJobSchema = z.object({
  id:IdSchema,taskId:IdSchema,requestId:IdSchema,operation:SecurityOperationSchema,
  targetId:IdSchema.optional(),state:JobStateSchema,createdAt:TimestampSchema,
  evidence:z.array(SecurityEvidenceSchema).max(100),
}).strict();
export type SecurityJob = z.infer<typeof SecurityJobSchema>;

export const ContactRouteSchema = z.object({
  id:IdSchema,revision:z.number().int().positive(),adapter:IdSchema,recipientId:IdSchema,
  recipientSha256:Sha256Schema,kind:z.enum(['self','contact']),enabled:z.boolean(),
  verification:z.object({method:z.enum(['adapter-identity','user-challenge']),
    recordId:IdSchema,verifiedAt:TimestampSchema,expiresAt:TimestampSchema}).strict(),
}).strict();
export type ContactRoute = z.infer<typeof ContactRouteSchema>;
export const ContactWorkflowSchema = z.object({
  id:IdSchema,enabled:z.boolean(),automatic:z.boolean(),templateIds:z.array(IdSchema).max(100),
}).strict();
export type ContactWorkflow = z.infer<typeof ContactWorkflowSchema>;
export const ContactTemplateSchema = z.object({
  id:IdSchema,version:z.number().int().positive(),bodySha256:Sha256Schema,
  contentClass:z.enum(['public','personal','private']),
}).strict();
export type ContactTemplate = z.infer<typeof ContactTemplateSchema>;
// Digest the exact final UTF-8 body after interpolation, never only the template source.
export const ContactBindingSchema = z.object({
  routeId:IdSchema,routeRevision:z.number().int().positive(),recipientId:IdSchema,recipientSha256:Sha256Schema,
  workflowId:IdSchema,templateId:IdSchema,templateVersion:z.number().int().positive(),bodySha256:Sha256Schema,
}).strict();
export type ContactBinding = z.infer<typeof ContactBindingSchema>;
export const ContactIntentSchema = z.object({requestId:IdSchema,binding:ContactBindingSchema}).strict();
export type ContactIntent = z.infer<typeof ContactIntentSchema>;
export const ContactRuleSchema = z.object({
  id:IdSchema,binding:ContactBindingSchema,createdAt:TimestampSchema,expiresAt:TimestampSchema,revoked:z.boolean(),
}).strict();
export type ContactRule = z.infer<typeof ContactRuleSchema>;
export const ContactApprovalSchema = ContactRuleSchema.extend({requestId:IdSchema});
export type ContactApproval = z.infer<typeof ContactApprovalSchema>;
/** Ephemeral, authenticated UI only. Never include in status, activity or exports. */
export const ContactExactReviewSchema=z.object({
  requestId:IdSchema,reviewId:IdSchema,privacyEpoch:z.uuid(),reviewDigest:Sha256Schema,revision:z.number().int().positive(),expiresAt:TimestampSchema,
  binding:ContactBindingSchema,channel:z.enum(['gmail','sms','voice','android']),destination:z.string().min(1).max(254),sender:z.string().min(1).max(254),
  routeLabel:z.string().max(120).optional(),
  content:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('message'),subject:z.string().max(200).optional(),body:z.string().min(1).max(32768)}).strict(),
    z.object({kind:z.literal('call'),script:z.string().min(1).max(2000),maxVoiceSeconds:z.number().int().min(1).max(120)}).strict(),
  ]),contentClass:z.enum(['public','personal','private']),
}).strict();
export type ContactExactReview=z.infer<typeof ContactExactReviewSchema>;
export const ContactReviewApprovalInputSchema=z.object({requestId:IdSchema,reviewId:IdSchema,reviewDigest:Sha256Schema,revision:z.number().int().positive(),
  routeId:IdSchema,routeRevision:z.number().int().positive(),bodySha256:Sha256Schema,privacyEpoch:z.uuid()}).strict();
export const DeliveryReceiptSchema = z.object({
  id:IdSchema,requestId:IdSchema,binding:ContactBindingSchema,adapter:IdSchema,
  state:z.enum(['pending','accepted','sent','delivered','rejected','unconfirmed']),observedAt:TimestampSchema,
  evidence:z.discriminatedUnion('source',[
    z.object({source:z.literal('none')}).strict(),
    z.object({source:z.literal('service-receipt'),recordId:IdSchema}).strict(),
    z.object({source:z.literal('observed-record'),recordId:IdSchema}).strict(),
    z.object({source:z.literal('trusted-pre-dispatch'),code:IdSchema}).strict(),
  ]),
}).strict().superRefine((r,ctx)=>{
  const remote=r.evidence.source==='service-receipt'||r.evidence.source==='observed-record';
  if((r.state==='accepted'||r.state==='sent'||r.state==='delivered')&&!remote)
    ctx.addIssue({code:'custom',message:'Acceptance requires a remote receipt or observed record.'});
  if(r.state==='rejected'&&!remote&&r.evidence.source!=='trusted-pre-dispatch')
    ctx.addIssue({code:'custom',message:'Rejection requires trusted evidence.'});
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

export const MigrationCompatibilitySchema = z.object({
  readMin:z.number().int().positive(),readMax:z.number().int().positive(),writeVersion:z.number().int().positive(),
  backupRequired:z.literal(true),reversible:z.boolean(),
}).strict().refine(m=>m.readMin<=m.readMax&&m.writeVersion>=m.readMin&&m.writeVersion<=m.readMax,
  {message:'Invalid data compatibility range.'});
export type MigrationCompatibility = z.infer<typeof MigrationCompatibilitySchema>;
const httpsUrl=z.url().refine(value=>{
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash;}
  catch {return false;}
},'HTTPS artifact URL without credentials required.');
export const ReleaseArtifactSchema = z.object({
  platform:z.enum(['win32','android']),arch:z.enum(['x64','arm64']),url:httpsUrl,
  sha256:Sha256Schema,bytes:z.number().int().positive().safe(),
  // Legacy advisory metadata, never an additional certificate/trust purchase gate.
  publisherKeyId:IdSchema.optional(),
}).strict();
export type ReleaseArtifact = z.infer<typeof ReleaseArtifactSchema>;
export const ReleaseVersionSchema = z.string().max(80).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/);
export const ReleasePayloadSchema = z.object({
  schemaVersion:z.literal(1),version:ReleaseVersionSchema,sequence:z.number().int().positive().safe(),
  channel:z.enum(['stable','preview']),publishedAt:TimestampSchema,expiresAt:TimestampSchema,
  migration:MigrationCompatibilitySchema,artifacts:z.array(ReleaseArtifactSchema).min(1).max(8),
}).strict().refine(r=>r.expiresAt>r.publishedAt,{message:'Release must have a valid lifetime.'});
export const ReleaseManifestSchema = z.object({
  release:ReleasePayloadSchema,
  signature:z.object({algorithm:z.literal('ed25519'),keyId:IdSchema,
    value:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict(),
}).strict();
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export const ExtensionStatusSchema = z.object({
  schemaVersion:z.literal(1),observedAt:TimestampSchema,
  features:z.object({cursor:FeatureCapabilitySchema,listening:FeatureCapabilitySchema,skills:FeatureCapabilitySchema,
    agents:FeatureCapabilitySchema,security:FeatureCapabilitySchema,contacts:FeatureCapabilitySchema,
    assets:FeatureCapabilitySchema,updates:FeatureCapabilitySchema}).strict(),
  cursor:CursorStatusSchema,
  listening:z.object({state:z.enum(['disabled','ready','listening','unavailable']),owner:z.literal('desktop'),localOnly:z.literal(true)}).strict(),
  agents:z.array(z.object({provider:AgentProviderSchema,capability:FeatureCapabilitySchema}).strict()).max(2),
  updates:z.object({state:z.enum(['untrusted','disabled','checking','current','available','installing','recovery-required']),
    version:ReleaseVersionSchema.optional()}).strict(),
}).strict().superRefine((s,ctx)=>{
  if(s.features.updates.available&&(s.features.updates.verification!=='verified'||s.updates.state!=='available'||!s.updates.version))
    ctx.addIssue({code:'custom',message:'Available updates require verified trust and a candidate version.'});
  if(s.updates.state==='available'&&!s.features.updates.available)
    ctx.addIssue({code:'custom',message:'Update availability must agree.'});
  for(const agent of s.agents)if(agent.capability.available&&!s.features.agents.available)
    ctx.addIssue({code:'custom',message:'Agent availability requires the runtime agent feature.'});
});
export type ExtensionStatus = z.infer<typeof ExtensionStatusSchema>;
// HTTP input carries intent only; no grants, approval booleans or private flags.
export const ExtensionActionSchema = z.object({
  requestId:IdSchema,taskId:IdSchema.optional(),input:z.record(z.string(),z.unknown()),
}).strict();
export type ExtensionAction = z.infer<typeof ExtensionActionSchema>;
export const ExtensionErrorSchema = z.object({
  code:z.enum(['invalid-request','forbidden','approval-required','unconfigured','unsupported','conflict','unavailable','cancelled','unconfirmed']),
  message:summary,retry:z.enum(['never','after-review','read-only-reconcile']),
}).strict();
export type ExtensionError = z.infer<typeof ExtensionErrorSchema>;
export const ActionReceiptSchema = z.object({
  id:IdSchema,requestId:IdSchema,feature:FeatureSchema,action:IdSchema,observedAt:TimestampSchema,
  outcome:z.enum(['completed','pending','rejected','unconfirmed','cancelled']),
  effect:z.enum(['none','queued','confirmed','unknown']),jobId:IdSchema.optional(),
  delivery:DeliveryReceiptSchema.optional(),error:ExtensionErrorSchema.optional(),
}).strict().superRefine((r,ctx)=>{
  if(((r.outcome==='rejected'||r.outcome==='cancelled')&&r.effect!=='none')||(r.outcome==='unconfirmed'&&r.effect!=='unknown'))
    ctx.addIssue({code:'custom',message:'Uncertain effects must remain unconfirmed.'});
  if(r.outcome==='completed'&&(r.effect==='queued'||r.effect==='unknown'))
    ctx.addIssue({code:'custom',message:'Queued or uncertain work is not completed.'});
  if(r.outcome==='pending'&&r.effect==='confirmed')
    ctx.addIssue({code:'custom',message:'Pending work cannot confirm an effect.'});
  const sending=r.feature==='contacts'&&r.action==='send';
  if(r.outcome==='completed'&&sending&&(!r.delivery||!['accepted','sent','delivered'].includes(r.delivery.state)))
    ctx.addIssue({code:'custom',message:'Contact send completion requires delivery acceptance.'});
  if(r.delivery){
    if(!sending||r.delivery.requestId!==r.requestId)
      ctx.addIssue({code:'custom',message:'Delivery does not match this send action.'});
    const expected={pending:'pending',accepted:'completed',sent:'completed',delivered:'completed',rejected:'rejected',unconfirmed:'unconfirmed'} as const;
    if(r.outcome!==expected[r.delivery.state]||(['accepted','sent','delivered'].includes(r.delivery.state)&&r.effect!=='confirmed'))
      ctx.addIssue({code:'custom',message:'Delivery and action outcomes must agree.'});
  }
  if(['rejected','cancelled','unconfirmed'].includes(r.outcome)&&!r.error)
    ctx.addIssue({code:'custom',message:'Non-success outcomes require an error.'});
  if((r.outcome==='completed'||r.outcome==='pending')&&r.error)
    ctx.addIssue({code:'custom',message:'Successful or pending receipts cannot carry an error.'});
  if(r.outcome==='unconfirmed'&&(r.error?.code!=='unconfirmed'||r.error.retry!=='read-only-reconcile'))
    ctx.addIssue({code:'custom',message:'Unknown effects require read-only reconciliation.'});
  if(r.outcome==='cancelled'&&(r.error?.code!=='cancelled'||r.error.retry!=='never'))
    ctx.addIssue({code:'custom',message:'Cancelled requests cannot be retried automatically.'});
  if(r.outcome==='rejected'&&(r.error?.code==='unconfirmed'||r.error?.code==='cancelled'))
    ctx.addIssue({code:'custom',message:'Rejection must establish non-dispatch.'});
});
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;

/** Populated by authenticated UI/session/TaskAccess adapters, never request.input. */
export interface ExtensionActionContext {
  signal:AbortSignal;
  authority:'trusted-ui'|'task';
  taskId?:string;
  grant?:TaskGrant;
  privateSession:boolean;
  localOnly:boolean;
}
export interface ExtensionHost {
  run(operation:string,input:Readonly<Record<string,unknown>>,context:ExtensionActionContext):Promise<unknown>;
}
export interface ExtensionTransport {
  request(operation:string,input:Readonly<Record<string,unknown>>,context:ExtensionActionContext):Promise<unknown>;
}
export interface ExtensionDependencies {
  store:Pick<Store,'get'|'list'|'put'|'remove'>;
  clock:()=>number;
  host:ExtensionHost;
  transport:ExtensionTransport;
}
/** Module status can be assembled into ExtensionStatus without out-of-band state. */
export type ExtensionFeatureStatus =
  | {feature:'cursor';capability:FeatureCapability;cursor:CursorStatus}
  | {feature:'listening';capability:FeatureCapability;listening:ExtensionStatus['listening']}
  | {feature:'agents';capability:FeatureCapability;agents:ExtensionStatus['agents']}
  | {feature:'updates';capability:FeatureCapability;updates:ExtensionStatus['updates']}
  | {feature:'skills'|'security'|'contacts'|'assets';capability:FeatureCapability};
export interface ExtensionModule {
  readonly feature:ExtensionFeature;
  status(signal:AbortSignal):Promise<ExtensionFeatureStatus>;
  action(action:string,request:ExtensionAction,context:ExtensionActionContext):Promise<ActionReceipt>;
  close():Promise<void>;
}
export type ExtensionModuleFactory = (dependencies:ExtensionDependencies)=>ExtensionModule;
