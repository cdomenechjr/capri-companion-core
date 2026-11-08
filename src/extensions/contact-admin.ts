import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Store} from '../server/store';
import {ActionReceiptSchema,DeliveryReceiptSchema,ContactReviewApprovalInputSchema,ContactBindingSchema,ContactIntentSchema,ContactRuleSchema,IdSchema,Sha256Schema,TimestampSchema,type ContactIntent,type DeliveryReceipt} from './contracts';
import {canonicalJson} from './policy';

export const ContactAdminChannelSchema=z.enum(['gmail','sms','voice','whatsapp','android']);
export type AdminChannel=z.infer<typeof ContactAdminChannelSchema>;
const revision=z.number().int().positive().safe();
const text=z.string().min(1).max(1600);
export const ContactLimitsSchema=z.object({enabled:z.boolean(),unitCostMicros:z.number().int().nonnegative().max(1e9).default(0),maxDispatchCostMicros:z.number().int().nonnegative().max(1e9),dailyBudgetMicros:z.number().int().nonnegative().max(1e12),
  maxPerMinute:z.number().int().min(1).max(60),maxPerDay:z.number().int().min(1).max(1000),
  quietHours:z.object({startMinute:z.number().int().min(0).max(1439),endMinute:z.number().int().min(0).max(1439),timeZone:z.string().min(1).max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}})}).strict().optional()}).strict();
export const zeroContactLimits=()=>({enabled:false,unitCostMicros:0,maxDispatchCostMicros:0,dailyBudgetMicros:0,maxPerMinute:1,maxPerDay:1});
export const AdminRouteSchema=z.object({id:IdSchema,recipientId:IdSchema,revision,channel:ContactAdminChannelSchema,destination:z.string().min(1).max(254),kind:z.enum(['self','contact']),enabled:z.boolean(),optedIn:z.boolean(),providerGeneration:IdSchema}).strict();
export const AdminTemplateSchema=z.object({id:IdSchema,revision,enabled:z.boolean(),body:text,subject:z.string().max(200).refine(v=>!/[\r\n]/.test(v)).optional(),contentClass:z.enum(['public','personal','private']),
  maxVoiceSeconds:z.number().int().min(1).max(120).optional(),whatsappSid:z.string().regex(/^HX[0-9a-fA-F]{32}$/).optional()}).strict();
export const AdminWorkflowSchema=z.object({id:IdSchema,revision,enabled:z.boolean(),trigger:z.enum(['on-demand','task-completed']),routeId:IdSchema,templateId:IdSchema}).strict();
export const ApprovedTextSchema=z.object({accountSid:z.string().regex(/^AC[0-9a-fA-F]{32}$/),sid:z.string().regex(/^HX[0-9a-fA-F]{32}$/),language:z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),body:text,
  variables:z.array(z.string().regex(/^[1-9][0-9]{0,2}$/)).max(100),sha256:Sha256Schema,revision,providerGeneration:IdSchema,checkedAt:TimestampSchema}).strict();
const provider=z.object({generation:IdSchema,enabled:z.boolean(),connected:z.boolean(),sender:z.string().max(254),clientId:z.string().max(512).optional(),accountSid:z.string().regex(/^AC[0-9a-fA-F]{32}$/).optional(),voiceEnabled:z.boolean().optional()}).strict();
export const ContactAuthoritySchema=z.object({version:z.literal(1),revision,state:z.enum(['ready','review-required','retention-required']),
  providers:z.object({gmail:provider.optional(),twilio:provider.optional()}).strict(),
  limits:z.record(ContactAdminChannelSchema,ContactLimitsSchema),routes:z.array(AdminRouteSchema).max(100),templates:z.array(AdminTemplateSchema).max(100),workflows:z.array(AdminWorkflowSchema).max(100),
  rules:z.array(ContactRuleSchema).max(100),approvedText:z.array(ApprovedTextSchema).max(100),
  events:z.array(z.object({id:IdSchema,retired:z.boolean(),requests:z.array(ContactIntentSchema).max(100)}).strict()).max(10000),
  actions:z.array(z.object({id:IdSchema,digest:Sha256Schema,receipt:ActionReceiptSchema.optional(),intent:ContactIntentSchema.optional(),challenge:z.object({challengeId:IdSchema,requestId:IdSchema,expiresAt:TimestampSchema}).strict().optional()}).strict()).max(10000).default([]),
}).strict();
export type ContactAuthority=z.infer<typeof ContactAuthoritySchema>;
export type AdminRoute=z.infer<typeof AdminRouteSchema>;
export type AdminTemplate=z.infer<typeof AdminTemplateSchema>;
export type ApprovedText=z.infer<typeof ApprovedTextSchema>;
const keys={requestId:IdSchema,expectedRevision:revision};
const op=<const A extends string,T extends z.ZodRawShape>(action:A,shape:T)=>z.object({...keys,action:z.literal(action),...shape}).strict();
/** IPC ONLY. No generic HTTP/tool route accepts these administration inputs. */
export const ContactAdminRequestSchema=z.union([
  op('recover-setup',{confirmation:z.literal('disable-unprovable-permissions')}),
  op('status',{}),op('configure-gmail',{clientId:z.string().min(1).max(512).regex(/^[A-Za-z0-9._-]+$/),sender:z.string().min(1).max(254)}),
  op('connect-gmail',{}),op('cancel-gmail',{}),op('disconnect-gmail',{}),
  op('configure-twilio',{accountSid:z.string().regex(/^AC[0-9a-fA-F]{32}$/),authToken:z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/),sender:z.string().min(1).max(254),voiceEnabled:z.boolean()}),op('disable-twilio',{}),
  op('save-route',{routeId:IdSchema.optional(),channel:ContactAdminChannelSchema,destination:z.string().min(1).max(254),kind:z.enum(['self','contact']),optedIn:z.boolean()}),op('disable-route',{routeId:IdSchema}),
  op('verify-begin',{routeId:IdSchema}),op('verify-complete',{routeId:IdSchema,challengeId:IdSchema,code:z.string().regex(/^\d{6}$/)}),
  op('set-limits',{channel:ContactAdminChannelSchema,limits:ContactLimitsSchema}),
  op('save-template',{templateId:IdSchema.optional(),definition:AdminTemplateSchema.omit({id:true,revision:true})}),
  op('save-workflow',{workflowId:IdSchema.optional(),definition:AdminWorkflowSchema.omit({id:true,revision:true})}),
  op('recheck-whatsapp',{contentSid:z.string().regex(/^HX[0-9a-fA-F]{32}$/),language:z.string().min(2).max(10)}),
  op('add-rule',{outboxRequestId:IdSchema,review:ContactReviewApprovalInputSchema,expiresAt:TimestampSchema}),op('revoke-rule',{ruleId:IdSchema}),
  op('prepare-rule',{workflowId:IdSchema,completion:z.enum(['verified','unverified']).default('unverified')}),op('prepare-notification',{workflowId:IdSchema,taskId:IdSchema.optional()}),op('reconcile',{outboxRequestId:IdSchema}),
]);
export type ContactAdminRequest=z.infer<typeof ContactAdminRequestSchema>;
export const ContactAdminStatusSchema=z.object({revision,state:z.enum(['ready','review-required','retention-required']),
  channels:z.array(z.object({channel:ContactAdminChannelSchema,configured:z.boolean(),enabled:z.boolean(),ready:z.boolean(),secretStored:z.boolean(),limits:ContactLimitsSchema}).strict()).max(5),
  routes:z.array(z.object({id:IdSchema,revision,channel:ContactAdminChannelSchema,kind:z.enum(['self','contact']),enabled:z.boolean(),optedIn:z.boolean(),verified:z.boolean(),verificationExpiresAt:TimestampSchema.optional()}).strict()).max(100),
  templates:z.array(z.object({id:IdSchema,revision,enabled:z.boolean()}).strict()).max(100),
  workflows:z.array(z.object({id:IdSchema,revision,enabled:z.boolean(),trigger:z.enum(['on-demand','task-completed'])}).strict()).max(100),
  rules:z.array(z.object({id:IdSchema,revoked:z.boolean(),expiresAt:TimestampSchema}).strict()).max(100),
  oauthPending:z.boolean(),billing:z.literal('local-conservative-estimate'),
}).strict();
export type ContactAdminStatus=z.infer<typeof ContactAdminStatusSchema>;
/** A six-digit challenge's unkeyed body digest is itself a code oracle. Keep
 * the full original receipt encrypted; expose only correlated service evidence. */
export const ContactVerificationReceiptSchema=z.object({kind:z.literal('verification'),requestId:IdSchema,challengeId:IdSchema,receiptId:IdSchema,adapter:IdSchema,
  state:DeliveryReceiptSchema.shape.state,observedAt:TimestampSchema,evidence:DeliveryReceiptSchema.shape.evidence}).strict().refine(r=>!['accepted','sent','delivered'].includes(r.state)||['service-receipt','observed-record'].includes(r.evidence.source));
export function verificationContactReceipt(challengeId:string,input:DeliveryReceipt){const receipt=DeliveryReceiptSchema.parse(input);return ContactVerificationReceiptSchema.parse({kind:'verification',challengeId,requestId:receipt.requestId,receiptId:receipt.id,adapter:receipt.adapter,state:receipt.state,observedAt:receipt.observedAt,evidence:receipt.evidence});}
export const ContactAdminReplySchema=z.object({requestId:IdSchema.optional(),receipt:ActionReceiptSchema.optional(),status:ContactAdminStatusSchema.optional(),intent:ContactIntentSchema.optional(),
  challenge:z.object({challengeId:IdSchema,requestId:IdSchema,expiresAt:TimestampSchema}).strict().optional(),result:z.union([ActionReceiptSchema,DeliveryReceiptSchema,ContactVerificationReceiptSchema]).optional()}).strict()
  .refine(value=>!!value.receipt||!!value.requestId&&!!value.status);
export type ContactAdminReply=z.infer<typeof ContactAdminReplySchema>;
export interface ContactAdminScope {readonly signal:AbortSignal;readonly privacyEpoch:string;readonly revision:number;readonly privateSession:boolean;readonly taskId?:string;readonly localOnly?:boolean;assertCurrent():void}
export const contactAuthorityKind='contact-administration';
export const emptyContactAuthority=():ContactAuthority=>({version:1,revision:1,state:'ready',providers:{},limits:{gmail:zeroContactLimits(),sms:zeroContactLimits(),voice:zeroContactLimits(),whatsapp:zeroContactLimits(),android:zeroContactLimits()},routes:[],templates:[],workflows:[],rules:[],approvedText:[],events:[],actions:[]});
const normalized=(v:unknown)=>canonicalJson(JSON.parse(JSON.stringify(v)));
// Only global revision/Store metadata may differ. Disabled definitions, action or
// event tombstones, quiet hours and nondefault limits are NOT structural emptiness.
export function isEmptyContactAuthority(state:ContactAuthority){return normalized({...state,revision:1})===normalized(emptyContactAuthority());}
export function parseContactAuthority(raw:unknown):ContactAuthority {
  if(raw===undefined)return emptyContactAuthority();const {id:_id,updatedAt:_updatedAt,...value}=raw as Record<string,unknown>;
  const state=ContactAuthoritySchema.parse(value);
  for(const rows of [state.routes,state.templates,state.workflows,state.rules,state.events,state.actions])if(new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('Contact authority unavailable.');
  return state;
}
export async function writeContactAuthority(store:Pick<Store,'get'|'put'>,state:ContactAuthority){
  ContactAuthoritySchema.parse(state);await store.put(contactAuthorityKind,{id:'main',...state});
  if(normalized(parseContactAuthority(await store.get(contactAuthorityKind,'main')))!==normalized(state))throw Error('Contact authority readback failed.');
}
/** One bounded private record. Clocks never select authority. Current revocations win;
 * missing/conflicting versions poison restored permission, while event tombstones union. */
export async function retainContactAuthorityAcrossRollback(source:Pick<Store,'get'>,target:Pick<Store,'get'|'put'>):Promise<(()=>Promise<void>)|undefined>{
  const old=await target.get(contactAuthorityKind,'main'),restored=old===undefined?undefined:parseContactAuthority(old);
  // Fence before reading current authority or walking any journals. Corruption,
  // conflicting identities and interrupted retention cannot expose the backup's
  // otherwise valid (but superseded) configuration to a reopened owner.
  await writeContactAuthority(target,{...(restored??emptyContactAuthority()),state:'retention-required'});
  const raw=await source.get(contactAuthorityKind,'main'),current=raw===undefined?undefined:parseContactAuthority(raw);
  let next=structuredClone(current??restored??emptyContactAuthority());
  const regressed=(rows:{id:string;revision:number}[],older:{id:string;revision:number}[])=>older.some(old=>{const row=rows.find(r=>r.id===old.id);return row&&(row.revision<old.revision||row.revision===old.revision&&normalized(row)!==normalized(old));});
  const emptyMissing=!current&&(!restored||isEmptyContactAuthority(restored));
  const conflict=!current&&!emptyMissing||restored&&current&&(restored.revision>current.revision||restored.revision===current.revision&&normalized(current)!==normalized(restored)||
    regressed(current.routes,restored.routes)||regressed(current.templates,restored.templates)||regressed(current.workflows,restored.workflows)||
    restored.rules.some(old=>{const row=current.rules.find(r=>r.id===old.id);return row&&(old.revoked&&!row.revoked||normalized(old.binding)!==normalized(row.binding));}));
  if(conflict){
    next.state='review-required';next.revision=Math.max(current?.revision??0,restored?.revision??0)+1;next.providers={};next.approvedText=[];
    const routes=new Map(next.routes.map(r=>[r.id,r]));for(const r of restored?.routes??[]){const old=routes.get(r.id);if(!old||r.revision>old.revision)routes.set(r.id,structuredClone(r));}
    next.routes=[...routes.values()];for(const r of next.routes){r.enabled=false;r.optedIn=false;r.revision++;r.providerGeneration=randomUUID();}
    const rules=new Map(next.rules.map(r=>[r.id,r]));for(const r of restored?.rules??[])if(!rules.has(r.id))rules.set(r.id,structuredClone(r));next.rules=[...rules.values()];for(const r of next.rules)r.revoked=true;
    const workflows=new Map(next.workflows.map(w=>[w.id,w]));for(const w of restored?.workflows??[]){const old=workflows.get(w.id);if(!old||w.revision>old.revision)workflows.set(w.id,structuredClone(w));}next.workflows=[...workflows.values()];for(const w of next.workflows){w.enabled=false;w.revision++;}
    for(const t of next.templates){t.enabled=false;t.revision++;}
  }
  if(emptyMissing)next.revision=Math.max(restored?.revision??0,1);
  if(!current&&restored?.state==='retention-required')next.state='retention-required';
  const events=new Map(next.events.map(e=>[e.id,e]));
  for(const e of restored?.events??[]){const present=events.get(e.id);if(!present)events.set(e.id,{...e,retired:true});else{if(normalized(present.requests)!==normalized(e.requests))throw Error('Contact event retention conflict.');present.retired||=e.retired;}}
  next.events=[...events.values()];
  const actions=new Map(next.actions.map(a=>[a.id,a]));
  for(const a of restored?.actions??[]){const present=actions.get(a.id);if(present&&present.digest!==a.digest)throw Error('Contact action retention conflict.');if(!present)actions.set(a.id,{id:a.id,digest:a.digest});}
  next.actions=[...actions.values()];
  // Offline maintenance first persists an unavailable fence. Only the caller that
  // has retained EVERY linked receipt/approval and reservation may restore readiness.
  // A crash or failure between these writes leaves all restored authority blocked.
  const blocked={...next,state:'retention-required' as const};
  await writeContactAuthority(target,blocked);
  return async()=>{try{await writeContactAuthority(target,next);}catch(error){await writeContactAuthority(target,blocked);throw error;}};
}
// Exact rules bind only a server-produced draft, never a UI-supplied digest/body.
export function ruleBinding(intent:ContactIntent){return ContactBindingSchema.parse(intent.binding);}
