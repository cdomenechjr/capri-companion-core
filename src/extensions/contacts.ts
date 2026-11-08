import {randomBytes,randomInt,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {retainPairedAndroidJournalAcrossRollback,type Store} from '../server/store';
import {ActionReceiptSchema,ExtensionActionSchema,ContactIntentSchema,ContactRouteSchema,ContactApprovalSchema,ContactExactReviewSchema,ContactReviewApprovalInputSchema,DeliveryReceiptSchema,IdSchema,defaultExtensionSettings,
  type ContactExactReview,type ContactApproval,type ActionReceipt,type ContactIntent,type ContactRoute,type DeliveryReceipt,type ExtensionActionContext,type ExtensionDependencies,type ExtensionModule} from './contracts';
import {canonicalJson,contactPolicy,featureCapability,sha256,type ContactPolicyContext} from './policy';
import {canonicalRecipient,equalContactDigest,OutboundMessageSchema,reviewedContactBody,validateMessage,renderApprovedContactText,type ContactChannel,type ContactProvider,type OutboundMessage,type ProviderObservation} from './contact-providers';
import {retainContactAuthorityAcrossRollback,type ApprovedText} from './contact-admin';

export interface ContactChannelPolicy {
  enabled:boolean; configured:boolean; sender:string;
  /** Explicit opt-in is per canonical recipient, including self and challenge destinations. */
  optedInRecipientHashes:readonly string[];
  approvedTemplateSids?:readonly string[];
  /** Conservative maximum cost of this payload, including SMS segments / bounded call duration. */
  maxDispatchCostMicros:number; dailyBudgetMicros:number;
  maxPerMinute:number; maxPerDay:number;
  quietHours?:{startMinute:number;endMinute:number;timeZone:string};
}
const channelPolicySchema=z.object({enabled:z.boolean(),configured:z.boolean(),sender:z.string().min(1).max(254),
  optedInRecipientHashes:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000),approvedTemplateSids:z.array(z.string().regex(/^HX[a-fA-F0-9]{32}$/)).max(100).optional(),
  maxDispatchCostMicros:z.number().int().nonnegative().safe(),dailyBudgetMicros:z.number().int().nonnegative().max(1e12).safe(),
  maxPerMinute:z.number().int().min(1).max(60),maxPerDay:z.number().int().min(1).max(1000),
  quietHours:z.object({startMinute:z.number().int().min(0).max(1439),endMinute:z.number().int().min(0).max(1439),timeZone:z.string().min(1).max(100)}).strict().optional(),
}).strict();
export interface ResolvedContact {
  whatsappTemplate?:ApprovedText;
  context:Omit<ContactPolicyContext,'now'>;
  /** Server-owned task/workflow state, independent of conversation model preference. */
  execution:{active:boolean;localOnly:boolean};
  message:OutboundMessage;
  channelPolicy:ContactChannelPolicy;
}
export interface ContactsDependencies {
  store:Pick<Store,'get'|'put'>;clock:()=>number;providers:readonly ContactProvider[];
  /** Resolve only from authenticated UI, active task/privacy state and reviewed workflow rendering.
   * Never merge tool input into this result. Called again immediately before dispatch. */
  resolve(intent:ContactIntent):Promise<ResolvedContact>;
  /** UI-only opt-in for a verification round trip; not a grant for ordinary content. */
  resolveVerification?(routeId:string):Promise<{route:Omit<ContactRoute,'verification'>;channel:ContactChannel;recipient:string;channelPolicy:ContactChannelPolicy;whatsappTemplateSid?:string;whatsappTemplate?:ApprovedText}>;
  availability?:()=>Promise<{enabled:boolean;configured:boolean;ready:boolean}>;
  draftRetentionMs?:number;
  /** Host-only live scope, never supplied from request JSON. Re-read after every await. */
  reviewScope?:()=>{authority:'trusted-ui'|'task';privacyEpoch:string;privateSession:boolean};
}
type Phase='queued'|'dispatching'|'final';
interface OutboxEntry {
  providerConfigurationId?:string;
  intent:ContactIntent;createdAt:number;phase:Phase;receipt:DeliveryReceipt;
  draft?:OutboundMessage;fingerprint:string;channel:ContactChannel;
  reservedAt?:number;reservedCost?:number;approvalId?:string;
  /** Legacy liability with intact identity but no trustworthy reservation time/cost.
   * This is an observation upper bound, never an invented dispatch timestamp. */
  usageObservedAt?:number;
  verificationChallengeId?:string;
  draftPrivacy?:'nonprivate'|'manual-private';
  contentRedacted?:boolean;
  awaitingReview?:boolean;
  exactApproval?:{approval:ContactApproval;authorizationSha256:string;privacyEpoch:string};
  approvalAction?:{requestId:string;digest:string;receipt:ActionReceipt};
}
interface Challenge {
  id:string;routeId:string;revision:number;recipientSha256:string;adapter:string;
  digest:string;salt:string;createdAt:number;expiresAt:number;attempts:number;used:boolean;
  requestId?:string;
  code?:string;
}
interface ConsumedApproval {id:string;expiresAt:number}
interface ColdUsage {requestId:string;channel:ContactChannel;reservedAt?:number;reservedCost?:number;observedAt?:number}
interface Journal {version:3;entries:OutboxEntry[];challenges:Challenge[];consumedApprovals:ConsumedApproval[];verifiedRoutes:ContactRoute[];archiveHead?:string;approvalHead?:string;archivedUnconfirmed?:number;archivedReservations?:{channel:ContactChannel;count:number;cost:number}[];usageClock?:number;
  /** Durable before linked writes; pins unknown legacy liabilities across interrupted migration. */
  accountingMigration?:{version:1;observedAt:number};
  accounting?:{version:1;head?:string;recent:ColdUsage[]}}
interface ArchivedReceipt {version:1;entry:OutboxEntry;previous?:string}
interface ContactResolution {resolved?:ResolvedContact;provider?:ContactProvider;approvalId?:string;reason?:string}
const kind='contact-outbox',journalId='main',receiptKind='contact-outbox-receipt',approvalKind='contact-outbox-approval';
const expirySchema=z.number().int().nonnegative().safe();
const consumedApprovalSchema=z.object({id:IdSchema,expiresAt:expirySchema});
const approvalRecordSchema=consumedApprovalSchema.extend({previous:IdSchema.optional()});
const entrySchema=z.object({intent:ContactIntentSchema,createdAt:z.number().int().nonnegative(),phase:z.enum(['queued','dispatching','final']),receipt:DeliveryReceiptSchema,
  providerConfigurationId:IdSchema.optional(),
  draft:OutboundMessageSchema.optional(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),channel:z.enum(['gmail','sms','voice','whatsapp','android']),
  reservedAt:expirySchema.optional(),reservedCost:expirySchema.optional(),usageObservedAt:expirySchema.optional(),approvalId:IdSchema.optional(),verificationChallengeId:IdSchema.optional(),
  draftPrivacy:z.enum(['nonprivate','manual-private']).optional(),contentRedacted:z.boolean().optional(),awaitingReview:z.boolean().optional(),
  exactApproval:z.object({approval:ContactApprovalSchema,authorizationSha256:z.string().regex(/^[a-f0-9]{64}$/),privacyEpoch:z.uuid()}).strict().optional(),
  approvalAction:z.object({requestId:IdSchema,digest:z.string().regex(/^[a-f0-9]{64}$/),receipt:ActionReceiptSchema}).strict().optional()});
const journalFields={entries:z.array(entrySchema).max(10000),challenges:z.array(z.object({
  id:IdSchema,routeId:IdSchema,revision:z.number().int().positive(),recipientSha256:z.string(),adapter:IdSchema,digest:z.string(),salt:z.string(),
  createdAt:z.number(),expiresAt:z.number(),attempts:z.number().int(),used:z.boolean(),requestId:IdSchema.optional(),code:z.string().optional(),
})).max(1000),verifiedRoutes:z.array(ContactRouteSchema).max(1000)};
function checkEntries(j:{entries:OutboxEntry[]},ctx:z.RefinementCtx){
  if(new Set(j.entries.map(e=>e.intent.requestId)).size!==j.entries.length)ctx.addIssue({code:'custom',message:'Duplicate outbox identity.'});
  for(const e of j.entries){
    if(e.receipt.requestId!==e.intent.requestId||!same(e.receipt.binding,e.intent.binding)||
      (e.reservedAt===undefined)!==(e.reservedCost===undefined)||e.phase==='dispatching'&&e.reservedAt===undefined||
      e.phase==='final'&&e.receipt.state==='pending'||e.phase!=='final'&&e.receipt.state!=='pending')
      ctx.addIssue({code:'custom',message:'Inconsistent outbox evidence.'});
    if(e.exactApproval&&(e.exactApproval.approval.requestId!==e.intent.requestId||!same(e.exactApproval.approval.binding,e.intent.binding))||
      e.approvalAction&&(!e.exactApproval||e.approvalAction.receipt.requestId!==e.approvalAction.requestId||e.approvalAction.receipt.feature!=='contacts'||e.approvalAction.receipt.action!=='approve'||e.approvalAction.receipt.delivery))
      ctx.addIssue({code:'custom',message:'Inconsistent exact approval evidence.'});
  }
}
const coldUsageSchema=z.object({requestId:IdSchema,channel:z.enum(['gmail','sms','voice','whatsapp','android']),reservedAt:expirySchema.optional(),reservedCost:expirySchema.optional(),observedAt:expirySchema.optional()}).strict()
  .refine(r=>(r.reservedAt!==undefined&&r.reservedCost!==undefined&&r.observedAt===undefined)||(r.reservedAt===undefined&&r.reservedCost===undefined&&r.observedAt!==undefined));
const accountingFields={archiveHead:IdSchema.optional(),approvalHead:IdSchema.optional(),archivedUnconfirmed:expirySchema.optional(),archivedReservations:z.array(z.object({channel:z.enum(['gmail','sms','voice','whatsapp','android']),count:expirySchema,cost:expirySchema}).strict()).max(5).optional(),usageClock:expirySchema.optional(),
  accounting:z.object({version:z.literal(1),head:IdSchema.optional(),recent:z.array(coldUsageSchema).max(10000)}).strict().optional()};
function checkJournal(j:Pick<Journal,'entries'|'accounting'|'archiveHead'>,ctx:z.RefinementCtx){checkEntries(j,ctx);if(j.accounting&&(j.accounting.head!==j.archiveHead||new Set(j.accounting.recent.map(r=>r.requestId)).size!==j.accounting.recent.length))ctx.addIssue({code:'custom',message:'Inconsistent usage index.'});}
const journalSchema=z.object({version:z.literal(3),...journalFields,...accountingFields,consumedApprovals:z.array(consumedApprovalSchema).max(100000),
  accountingMigration:z.object({version:z.literal(1),observedAt:expirySchema}).strict().optional()}).superRefine((j,ctx)=>{
    checkJournal(j,ctx);if(!j.accounting&&!j.accountingMigration||!j.accountingMigration&&j.consumedApprovals.length>10000)ctx.addIssue({code:'custom',message:'Incomplete usage migration.'});
  });
const previousJournalSchema=z.object({version:z.literal(2),...journalFields,...accountingFields,consumedApprovals:z.array(consumedApprovalSchema).max(10000),accountingMigration:z.never().optional()}).superRefine(checkJournal);
// Read-only compatibility with the old hot ledger, including an over-cap approval array written
// before its schema rejected subsequent reads. Migration writes one bounded record per live ID.
const legacyJournalSchema=z.object({version:z.literal(1),...journalFields,...accountingFields,consumedApprovals:z.array(z.union([IdSchema,consumedApprovalSchema])).max(100000),accountingMigration:z.never().optional()}).superRefine(checkJournal);
const archivedSchema=z.object({version:z.literal(1),entry:entrySchema,previous:IdSchema.optional()}).superRefine((r,ctx)=>{
  checkEntries({entries:[r.entry]},ctx);
  if(r.entry.phase!=='final'||r.entry.draft!==undefined)ctx.addIssue({code:'custom',message:'Invalid archived receipt.'});
});
const emptyJournal=():Journal=>({version:3,entries:[],challenges:[],consumedApprovals:[],verifiedRoutes:[],accounting:{version:1,recent:[]}});
function parseJournal(raw:unknown):Journal{
  if(raw===undefined)return emptyJournal();
  if((raw as {version?:number}|null)?.version===3)return journalSchema.parse(raw) as Journal;
  if((raw as {version?:number}|null)?.version===2)return {...previousJournalSchema.parse(raw),version:3} as Journal;
  const old=legacyJournalSchema.parse(raw);
  return {...old,version:3,consumedApprovals:old.consumedApprovals.map(a=>typeof a==='string'?{id:a,expiresAt:Number.MAX_SAFE_INTEGER}:a)};
}
async function archived(store:Pick<Store,'get'>,requestId:string):Promise<ArchivedReceipt|undefined>{
  const raw=await store.get(receiptKind,requestId);if(!raw)return undefined;
  const record=archivedSchema.parse(raw) as ArchivedReceipt;
  if(record.entry.intent.requestId!==requestId)throw unavailable();return record;
}
async function writeArchive(store:Pick<Store,'get'|'put'>,requestId:string,record:ArchivedReceipt){
  archivedSchema.parse(record);await store.put(receiptKind,{id:requestId,...record});
  if(!same(await archived(store,requestId),record))throw unavailable();
}
const automaticPrivate=(r:ResolvedContact|undefined)=>!!r&&r.context.workflow?.automatic!==false&&
  (r.context.privateSession===true||r.context.containsPrivateContent===true||r.context.template?.contentClass==='private');
async function consumed(store:Pick<Store,'get'>,id:string):Promise<z.infer<typeof approvalRecordSchema>|undefined>{
  const raw=await store.get(approvalKind,id);if(!raw)return undefined;
  const record=approvalRecordSchema.parse(raw);if(record.id!==id)throw unavailable();return record;
}
async function rememberApproval(store:Pick<Store,'get'|'put'>,approval:ConsumedApproval,head?:string,relink=false):Promise<string|undefined>{
  const old=await consumed(store,approval.id);
  if(old&&!relink)return head;
  const record={...approval,expiresAt:Math.max(old?.expiresAt??0,approval.expiresAt),previous:head};
  await store.put(approvalKind,record);if(!same(await consumed(store,record.id),record))throw unavailable();
  return approval.id;
}
// A single desktop service must own the profile. Also serialize multiple facades on that Store.
const locks=new WeakMap<object,Promise<unknown>>();
async function serialized<T>(store:object,run:()=>Promise<T>):Promise<T>{
  const before=locks.get(store)??Promise.resolve();const result=before.catch(()=>{}).then(run);locks.set(store,result);
  try{return await result;}finally{if(locks.get(store)===result)locks.delete(store);}
}
// Match Store's JSON representation, where absent optional fields and undefined are identical.
const storedJson=(value:unknown)=>canonicalJson(JSON.parse(JSON.stringify(value)));
function same(a:unknown,b:unknown){return storedJson(a)===storedJson(b);}
const unavailable=()=>new Error('Contact operation unavailable.');
const safeClock=(clock:()=>number)=>{const now=clock();if(!Number.isSafeInteger(now)||now<0)throw unavailable();return now;};
const messageFingerprint=(m:OutboundMessage)=>sha256(storedJson(m));
function retainedEvidence(current:OutboxEntry,older?:OutboxEntry):OutboxEntry {
  const next=structuredClone(current);if(!older)return next;
  if(!same(current.intent,older.intent)||current.channel!==older.channel)throw unavailable();
  if(current.receipt.adapter!==older.receipt.adapter)throw unavailable();
  const record=(r:DeliveryReceipt)=>r.evidence.source==='service-receipt'||r.evidence.source==='observed-record'?r.evidence.recordId:undefined;
  if(record(current.receipt)&&record(older.receipt)&&record(current.receipt)!==record(older.receipt))throw unavailable();
  if(current.providerConfigurationId&&older.providerConfigurationId&&current.providerConfigurationId!==older.providerConfigurationId)throw unavailable();
  if(current.reservedAt!==undefined&&older.reservedAt!==undefined&&(current.reservedAt!==older.reservedAt||current.reservedCost!==older.reservedCost))throw unavailable();
  next.providerConfigurationId??=older.providerConfigurationId;
  if(current.usageObservedAt!==undefined||older.usageObservedAt!==undefined)next.usageObservedAt=Math.max(current.usageObservedAt??0,older.usageObservedAt??0);
  const rank=(r:DeliveryReceipt)=>r.state==='delivered'?3:r.state==='sent'?2:0;
  if(rank(older.receipt)>rank(next.receipt)||older.receipt.state==='accepted'&&(['pending','unconfirmed'].includes(next.receipt.state)||next.receipt.evidence.source==='trusted-pre-dispatch')){next.receipt=structuredClone(older.receipt);next.phase='final';}
  if(older.reservedAt!==undefined){next.reservedAt=Math.max(next.reservedAt??0,older.reservedAt);next.reservedCost=Math.max(next.reservedCost??0,older.reservedCost??0);}
  if(next.reservedAt!==undefined||next.usageObservedAt!==undefined){
    if(current.approvalId&&older.approvalId&&current.approvalId!==older.approvalId)throw unavailable();
    next.approvalId??=older.approvalId;next.exactApproval??=structuredClone(older.exactApproval);next.approvalAction??=structuredClone(older.approvalAction);
    if(next.receipt.evidence.source==='trusted-pre-dispatch'||next.phase==='queued'){
      // A pre-dispatch denial from one generation cannot erase the other
      // generation's durable possible-dispatch reservation or consumed approval.
      next.phase='final';next.receipt={...next.receipt,state:'unconfirmed',evidence:{source:'none'}};
    }
  }
  return next;
}
const dayMs=86400000;
function usage(e:OutboxEntry,observedAt:number):ColdUsage|undefined {
  if(e.reservedAt!==undefined)return {requestId:e.intent.requestId,channel:e.channel,reservedAt:e.reservedAt,reservedCost:e.reservedCost};
  if(e.usageObservedAt!==undefined)return {requestId:e.intent.requestId,channel:e.channel,observedAt:e.usageObservedAt};
  // Only a genuine host pre-dispatch denial or a never-dispatched queue proves
  // zero reservation. Arbitrary legacy unknowns/provider refusals do not.
  if(e.phase==='queued'||e.receipt.state==='rejected'&&e.receipt.evidence.source==='trusted-pre-dispatch')return;
  e.usageObservedAt??=observedAt;
  return {requestId:e.intent.requestId,channel:e.channel,observedAt:e.usageObservedAt};
}
const recentUsage=(r:ColdUsage,now:number)=>now-(r.reservedAt??r.observedAt!)<dayMs;
/** One bounded compatibility pass (or offline rollback reconstruction). Original
 * receipt identities/times remain authoritative; lifetime totals are never used
 * as rolling usage. Missing/cyclic/oversized history fails closed. New operations
 * maintain the bounded index, so ordinary budget checks never walk cold history. */
async function rebuildAccounting(store:Pick<Store,'get'>,j:Journal,now:number,observationNow=now,prior?:(e:OutboxEntry)=>Promise<OutboxEntry|undefined>){
  const observation=j.accountingMigration?.observedAt??Math.max(observationNow,j.usageClock??0),recent:ColdUsage[]=[],seen=new Set<string>(),writes=new Map<string,ArchivedReceipt>();
  const observedUsage=async(e:OutboxEntry)=>{
    if(prior&&e.reservedAt===undefined&&e.usageObservedAt===undefined){
      const old=await prior(e);
      if(old){
        // A get-only legacy source cannot remember its observation. Reuse only
        // this original identity's validated durable target evidence, before
        // assigning a fresh bound; unrelated requests still observe now.
        retainedEvidence(e,old);e.usageObservedAt=old.usageObservedAt;
      }
    }
    return usage(e,observation);
  };
  const indexed=new Map(j.accounting?.recent.map(r=>[r.requestId,r]));
  const possible=new Map<ContactChannel,{count:number;cost:number;ambiguous:boolean}>();
  let cursor=j.archiveHead,unconfirmed=0;
  while(cursor){
    if(seen.has(cursor)||seen.size>=100000)throw unavailable();seen.add(cursor);
    const record=await archived(store,cursor);if(!record)throw unavailable();
    const e=record.entry,hot=j.entries.find(h=>h.intent.requestId===cursor);
    if(hot){const merged=retainedEvidence(e,hot);if(!same(merged,e))throw unavailable();}
    const before=e.usageObservedAt,r=await observedUsage(e);
    const indexedUsage=indexed.get(cursor);
    // A fenced, interrupted rollback can have advanced a linked receipt before its
    // final main write. Accept only monotonic evidence for that same identity/channel;
    // never lose a known reservation or substitute another timestamp/cost for it.
    const advanced=j.accountingMigration&&r&&r.channel===indexedUsage?.channel&&indexedUsage.observedAt!==undefined&&
      (r.reservedAt!==undefined||r.observedAt!==undefined&&r.observedAt>=indexedUsage.observedAt);
    if(indexedUsage&&(!r||!same(indexedUsage,r))&&!advanced)throw unavailable();indexed.delete(cursor);
    if(r){const total=possible.get(r.channel)??{count:0,cost:0,ambiguous:false};total.count++;total.cost+=r.reservedCost??0;total.ambiguous||=r.observedAt!==undefined;possible.set(r.channel,total);}
    if(e.usageObservedAt!==before)writes.set(cursor,record);
    if(r&&recentUsage(r,now))recent.push(r);
    if(recent.length>10000)throw unavailable();
    if(e.receipt.state==='unconfirmed')unconfirmed++;
    cursor=record.previous;
  }
  if(unconfirmed<(j.archivedUnconfirmed??0))throw unavailable();
  if(indexed.size)throw unavailable();
  // The linked dedup chain must account for every legacy aggregate reservation.
  // Aggregate counts alone cannot establish either an identity or a timestamp.
  // Exact reconstruction above covers unknowns AND confirmed records.
  for(const channel of ['gmail','sms','voice','whatsapp','android'] as const){
    const legacy=(j.archivedReservations??[]).filter(r=>r.channel===channel),total=possible.get(channel);
    if(legacy.reduce((n,r)=>n+r.count,0)>(total?.count??0)||!total?.ambiguous&&legacy.reduce((n,r)=>n+r.cost,0)>(total?.cost??0))throw unavailable();
  }
  j.archivedUnconfirmed=unconfirmed;
  j.accounting={version:1,head:j.archiveHead,recent};
  for(const e of j.entries)await observedUsage(e);
  return writes;
}
// Approval lists may acquire this service's exact approval; all other trusted authority
// (including revocation, route verification, workflow, template and cost policy) stays pinned.
const authorizationFingerprint=(r:ResolvedContact)=>sha256(storedJson({...r,context:{...r.context,approvals:[]}}));
interface LiveReview {preview:Pick<ContactExactReview,'requestId'|'reviewId'|'privacyEpoch'|'reviewDigest'|'revision'|'binding'|'expiresAt'>;authorizationSha256:string}
const liveReviews=new WeakMap<object,Map<string,LiveReview>>();
export const clearContactReviews=(store:object)=>liveReviews.delete(store);
function quiet(policy:ContactChannelPolicy,now:number):boolean {
  const q=policy.quietHours;if(!q)return false;
  if(!Number.isInteger(q.startMinute)||!Number.isInteger(q.endMinute)||q.startMinute<0||q.startMinute>1439||q.endMinute<0||q.endMinute>1439)throw unavailable();
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:q.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const minute=Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value);
  return q.startMinute===q.endMinute|| (q.startMinute<q.endMinute?minute>=q.startMinute&&minute<q.endMinute:minute>=q.startMinute||minute<q.endMinute);
}

/** Encrypted bounded hot journal plus indexed, content-free durable receipt records. Each cold
 * read/write is one request; the linked archive is only walked by offline rollback migration.
 * Keep all three contact record kinds when restoring a profile backup or rolling back code. Replacing
 * the ledger with an older snapshot defeats any local idempotency scheme; fail closed if lost.
 * No background retry, cross-channel fallback, or network activity is started by construction. */
export class ContactsService {
  private providers:Map<string,ContactProvider>;
  constructor(private deps:ContactsDependencies){
    this.providers=new Map(deps.providers.map(p=>[p.id,p]));
    if(this.providers.size!==deps.providers.length||deps.providers.some(p=>!IdSchema.safeParse(p.id).success))throw unavailable();
    if(deps.draftRetentionMs!==undefined&&(!Number.isSafeInteger(deps.draftRetentionMs)||deps.draftRetentionMs<60000||deps.draftRetentionMs>30*86400000))throw unavailable();
  }
  private now(){return safeClock(this.deps.clock);}
  private uiScope(epoch:string){
    const scope=this.deps.reviewScope?.();
    if(!scope||scope.authority!=='trusted-ui'||!z.uuid().safeParse(epoch).success||scope.privacyEpoch!==epoch)throw unavailable();
    return scope;
  }
  private reviews(){let reviews=liveReviews.get(this.deps.store);if(!reviews){reviews=new Map();liveReviews.set(this.deps.store,reviews);}
    for(const [id,r]of reviews)if(r.preview.expiresAt<=this.now())reviews.delete(id);return reviews;}
  private async load():Promise<Journal>{
    const raw=await this.deps.store.get(kind,journalId);
    try{
      const j=parseJournal(raw);
      const original=storedJson(j);
      const migrating=raw!==undefined&&(raw.version!==3||!!j.accountingMigration);
      if(migrating){
        j.accountingMigration??={version:1,observedAt:Math.max(this.now(),j.usageClock??0)};
        // Validate the complete bounded history without writing it. Then fence old status
        // writers with a read-back format3 snapshot BEFORE changing any linked record.
        // The marker and hot observations survive a crash at every subsequent await.
        const writes=await rebuildAccounting(this.deps.store,j,this.now());
        const seen=new Set<string>();let head=j.approvalHead;
        while(head){if(seen.has(head)||seen.size>=100000)throw unavailable();seen.add(head);const a=await consumed(this.deps.store,head);if(!a)throw unavailable();head=a.previous;}
        for(const e of j.entries)this.redact(e);
        await this.save(j);
        for(const [id,record]of writes)await writeArchive(this.deps.store,id,record);
      }
      for(const e of j.entries)usage(e,Math.max(this.now(),j.usageClock??0));
      // The dispatch marker already binds each consumed approval atomically. Write the index
      // before removing the legacy list; interrupted migration can safely repeat these writes.
      const unique=new Map<string,ConsumedApproval>();
      for(const a of j.consumedApprovals)if(a.expiresAt>this.now()){
        const old=unique.get(a.id);if(!old||old.expiresAt<a.expiresAt)unique.set(a.id,a);
      }
      for(const a of unique.values())j.approvalHead=await rememberApproval(this.deps.store,a,j.approvalHead,true);
      j.consumedApprovals=[];
      delete j.accountingMigration;
      if(migrating||storedJson(j)!==original)await this.save(j);
      return j;
    }catch{throw unavailable();}
  }
  private async save(j:Journal){
    j.usageClock=Math.max(j.usageClock??0,this.now(),...j.entries.map(e=>e.reservedAt??0));
    journalSchema.parse(j);await this.deps.store.put(kind,{id:journalId,...j});
    const observed=journalSchema.parse(await this.deps.store.get(kind,journalId));if(!same(observed,j))throw unavailable();
  }
  private receipt(intent:ContactIntent,adapter:string,state:DeliveryReceipt['state'],code?:string):DeliveryReceipt {
    return {id:randomUUID(),requestId:intent.requestId,binding:structuredClone(intent.binding),adapter,state,observedAt:this.now(),
      evidence:code?{source:'trusted-pre-dispatch',code}:{source:'none'}};
  }
  private publicEntry(e:OutboxEntry):DeliveryReceipt{return structuredClone(e.receipt);}
  private deny(e:OutboxEntry,code:string){e.phase='final';e.receipt=this.receipt(e.intent,e.receipt.adapter,'rejected',code);}
  private redact(e:OutboxEntry,r?:ResolvedContact){
    if(e.contentRedacted||automaticPrivate(r)||(e.receipt.evidence.source==='trusted-pre-dispatch'&&e.receipt.evidence.code==='private-automatic-content')){
      delete e.draft;delete e.draftPrivacy;e.contentRedacted=true;
    }
  }
  private async recover(j:Journal){
    const now=this.now(),retention=this.deps.draftRetentionMs??7*86400000;
    for(const e of j.entries){
      if(e.phase==='dispatching'){e.phase='final';e.receipt=this.receipt(e.intent,e.receipt.adapter,'unconfirmed');}
      this.redact(e);
      // Older denials carried no privacy marker. Reclassify using trusted host state only;
      // known private denials above are scrubbed even if the resolver is unavailable. A status
      // facade with no task context must not erase an otherwise legitimate nonprivate draft.
      if(e.draft&&!e.draftPrivacy&&e.phase==='final'&&e.receipt.evidence.source==='trusted-pre-dispatch'){
        try{const r=await this.deps.resolve(structuredClone(e.intent));this.redact(e,r);if(e.draft)e.draftPrivacy=r.context.workflow?.automatic===false?'manual-private':'nonprivate';}
        catch{/* Preserve other drafts until trusted classification or normal retention. */}
      }
      if(now-e.createdAt>retention)delete e.draft;
    }
    // Retain the exact intent, fingerprint, reservation, outcome and evidence for every retired
    // request. Archive only outside the budget window and after draft retention. Cold writes
    // and read-back precede the atomic hot-ledger removal/head update, so crashes lose no IDs.
    // At most 64 cold writes per operation avoid a long archive rewrite at the hot-ledger cap.
    const retained:OutboxEntry[]=[];let archivedCount=0;
    for(const e of j.entries){
      if(archivedCount<64&&e.phase==='final'&&!e.draft&&now-e.createdAt>retention&&(e.reservedAt===undefined||now-e.reservedAt>=86400000)){
        await writeArchive(this.deps.store,e.intent.requestId,{version:1,entry:e,previous:j.archiveHead});
        j.archiveHead=e.intent.requestId;archivedCount++;
        const r=usage(e,Math.max(now,j.usageClock??0));
        if(r&&recentUsage(r,now)&&!j.accounting!.recent.some(x=>x.requestId===r.requestId))j.accounting!.recent.push(r);
        if(e.receipt.state==='unconfirmed'){
          j.archivedUnconfirmed=(j.archivedUnconfirmed??0)+1;
          if(e.reservedCost!==undefined){const all=j.archivedReservations??=[],usage=all.find(x=>x.channel===e.channel)??{channel:e.channel,count:0,cost:0};if(!all.includes(usage))all.push(usage);usage.count++;usage.cost+=e.reservedCost;j.archivedReservations=all;}
        }
      }else retained.push(e);
    }
    j.entries=retained;
    j.accounting!.head=j.archiveHead;
    j.accounting!.recent=j.accounting!.recent.filter(r=>recentUsage(r,now));
    j.challenges=j.challenges.filter(c=>c.expiresAt>now);
  }
  private proofFor(j:Journal,current:Omit<ContactRoute,'verification'>):ContactRoute|undefined {
    const proof=j.verifiedRoutes.find(r=>r.id===current.id);
    if(!proof||proof.verification.method!=='user-challenge'||proof.verification.verifiedAt>this.now()||
      proof.verification.expiresAt<=this.now()||proof.verification.expiresAt<=proof.verification.verifiedAt)return undefined;
    const {verification,...identity}=proof;return same(identity,current)?structuredClone(proof):undefined;
  }
  private async resolve(intent:ContactIntent,j:Journal,challengeId?:string,dispatchProof?:OutboxEntry):Promise<ContactResolution>{
    let r:ResolvedContact|undefined,provider:ContactProvider|undefined;
    const denied=(reason:string):ContactResolution=>({resolved:r,provider,reason});
    try{
    r=challengeId?await this.verificationResolution(challengeId,j):structuredClone(await this.deps.resolve(structuredClone(intent)));
    if(r.execution?.active!==true)return denied('inactive-task');
    if(r.execution.localOnly!==false)return denied('local-only');
    r.message=OutboundMessageSchema.parse(r.message);
    // The host may have presentation whitespace; approval always binds canonical routing.
    r.message.recipient=canonicalRecipient(r.message.channel,r.message.recipient);
    r.message.sender=canonicalRecipient(r.message.channel,r.message.sender);
    provider=this.providers.get(r.context.route?.adapter??'');if(!provider||provider.channel!==r.message.channel)return denied('unavailable');
    const p=channelPolicySchema.parse(r.channelPolicy);r.channelPolicy=p;
    if(!p.enabled)return denied('disabled');
    if(!p.configured)return denied('unconfigured');
    if(canonicalRecipient(r.message.channel,p.sender)!==r.message.sender)return denied('sender-mismatch');
    if(!p.optedInRecipientHashes.includes(sha256(r.message.recipient)))return denied('recipient-opt-in-required');
    if(!Number.isSafeInteger(p.dailyBudgetMicros)||p.dailyBudgetMicros<0||p.dailyBudgetMicros>1e12||!Number.isSafeInteger(p.maxDispatchCostMicros)||p.maxDispatchCostMicros<0||p.maxDispatchCostMicros>p.dailyBudgetMicros||
      !Number.isInteger(p.maxPerMinute)||p.maxPerMinute<1||p.maxPerMinute>60||!Number.isInteger(p.maxPerDay)||p.maxPerDay<1||p.maxPerDay>1000)return denied('invalid-budget');
    if(['sms','voice','whatsapp'].includes(r.message.channel)&&p.maxDispatchCostMicros===0)return denied('invalid-budget');
    if(r.message.channel==='whatsapp'&&(!r.message.whatsapp||!p.approvedTemplateSids?.includes(r.message.whatsapp.contentSid)))return denied('unreviewed-template');
    if(r.message.channel==='whatsapp'&&(!r.whatsappTemplate||r.whatsappTemplate.checkedAt>this.now()||this.now()-r.whatsappTemplate.checkedAt>86400000||r.whatsappTemplate.sid!==r.message.whatsapp!.contentSid||renderApprovedContactText(r.whatsappTemplate,r.message.whatsapp!.variables)!==r.message.body))return denied('unreviewed-template');
    if(r.context.route?.recipientSha256!==sha256(r.message.recipient)||r.context.template?.bodySha256!==sha256(reviewedContactBody(r.message)))return denied('binding-mismatch');
    if(!challengeId){
      // Host/model verification claims cannot replace this service's completed round trip.
      const {verification,...identity}=r.context.route!;
      const proof=this.proofFor(j,identity);if(!proof)return denied('unverified-route');
      r.context.route=proof;
    }
    const available=[];
    for(const a of r.context.approvals){
      const used=await consumed(this.deps.store,IdSchema.parse(a.id));
      // An expired consumed ID cannot revive its old exact-request approval, even if a caller
      // extends the expiry. New approval IDs are required. No unbounded hot list is retained.
      if(!used||dispatchProof?.phase==='dispatching'&&dispatchProof.intent.requestId===intent.requestId&&dispatchProof.approvalId===a.id)available.push(a);
    }
    r.context.approvals=available;
    const exact=j.entries.find(e=>e.intent.requestId===intent.requestId)?.exactApproval;
    if(exact){
      const scope=this.deps.reviewScope?.();
      if(!scope||scope.privacyEpoch!==exact.privacyEpoch||exact.approval.expiresAt<=this.now()||exact.approval.revoked||
        authorizationFingerprint(r)!==exact.authorizationSha256)return denied('review-invalidated');
      if(!await consumed(this.deps.store,exact.approval.id)||dispatchProof?.phase==='dispatching'&&dispatchProof.intent.requestId===intent.requestId&&dispatchProof.approvalId===exact.approval.id)r.context.approvals=[exact.approval,...r.context.approvals];
    }
    // Only service-created, fixed code content uses the challenge path. A tool cannot set it.
    const decision=challengeId?{allowed:true,reason:'ready'} as const:contactPolicy(intent,{...r.context,now:this.now()});
    if(!decision.allowed)return {resolved:r,provider,reason:decision.reason};
    const approvalId=decision.reason==='approval'?r.context.approvals.find(a=>a.requestId===intent.requestId&&a.createdAt<=this.now()&&a.expiresAt>this.now()&&!a.revoked&&same(a.binding,intent.binding))?.id:undefined;
    return {resolved:r,provider,approvalId};
    }catch{return denied('unavailable');} // Resolution/validation cannot dispatch a message.
  }
  /** Only ContactIntent is accepted. Destination/body/privacy/approval overrides are rejected. */
  async enqueue(input:unknown):Promise<DeliveryReceipt>{
    const intent=ContactIntentSchema.parse(input);
    return serialized(this.deps.store,async()=>{
      const j=await this.load();await this.recover(j);
      const cold=await archived(this.deps.store,intent.requestId);
      const old=cold?.entry??j.entries.find(e=>e.intent.requestId===intent.requestId);
      if(old){if(!same(old.intent,intent))throw new Error('Contact request ID conflict.');await this.save(j);return this.publicEntry(old);}
      if(j.entries.length>=10000)throw unavailable(); // Only live queues/recent retained drafts occupy hot capacity.
      const {resolved:r,provider,reason}=await this.resolve(intent,j);
      const draft=OutboundMessageSchema.safeParse(r?.message);
      const adapter=IdSchema.safeParse(r?.context?.route?.adapter);
      const entry:OutboxEntry={intent,createdAt:this.now(),phase:'queued',receipt:this.receipt(intent,provider?.id??(adapter.success?adapter.data:'contacts'),'pending'),
        providerConfigurationId:await provider?.configurationId?.(),
        draft:draft.success?draft.data:undefined,fingerprint:sha256(storedJson(draft.success?draft.data:intent)),channel:draft.success?draft.data.channel:'android',
        draftPrivacy:r&&(r.context.privateSession||r.context.containsPrivateContent||r.context.template?.contentClass==='private')?'manual-private':'nonprivate',awaitingReview:reason==='approval-required'};
      this.redact(entry,r);
      if(reason&&!(reason==='approval-required'&&this.deps.reviewScope)||!r||!provider)this.deny(entry,reason??'unavailable');j.entries.push(entry);await this.save(j);return this.publicEntry(entry);
    });
  }
  private budget(j:Journal,e:OutboxEntry,p:ContactChannelPolicy):boolean {
    // Once expired usage has been archived, moving the clock backwards cannot
    // recreate its old allowance. The durable high-water mark survives restart.
    if(this.now()<(j.usageClock??0))return false;
    // Rolling windows are stricter than local-day reset and cannot double-spend across midnight.
    const unique=new Map<string,ColdUsage>();
    for(const r of [...j.accounting!.recent,...j.entries.map(x=>usage(x,Math.max(this.now(),j.usageClock??0))).filter((x):x is ColdUsage=>!!x)]){
      const old=unique.get(r.requestId);if(old&&!same(old,r))return false;unique.set(r.requestId,r);
    }
    const recent=[...unique.values()].filter(r=>r.channel===e.channel&&recentUsage(r,this.now()));
    // Identity-complete but unresolvable legacy liabilities hold this channel
    // for one durable observation window. No invented invoice/time or refund.
    if(recent.some(r=>r.observedAt!==undefined))return false;
    return recent.length<p.maxPerDay&&recent.filter(x=>this.now()-x.reservedAt!<60000).length<p.maxPerMinute&&
      recent.reduce((s,x)=>s+x.reservedCost!,0)+p.maxDispatchCostMicros<=p.dailyBudgetMicros;
  }
  async dispatch(requestId:string,signal:AbortSignal):Promise<DeliveryReceipt>{
    IdSchema.parse(requestId);
    return serialized(this.deps.store,async()=>{
      const j=await this.load();await this.recover(j);
      const cold=await archived(this.deps.store,requestId);if(cold){await this.save(j);return this.publicEntry(cold.entry);}
      const e=j.entries.find(x=>x.intent.requestId===requestId);if(!e)throw unavailable();
      if(e.phase!=='queued'){await this.save(j);return this.publicEntry(e);}
      try{
        const {resolved:r,provider,approvalId,reason}=await this.resolve(e.intent,j,e.verificationChallengeId);
        this.redact(e,r);
        if(signal.aborted)this.deny(e,'cancelled');
        else if(reason==='approval-required'&&e.awaitingReview&&!e.exactApproval){await this.save(j);return this.publicEntry(e);}
        else if(reason||!r||!provider)this.deny(e,reason??'unavailable');
        else if(provider.configurationId&&e.providerConfigurationId!==await provider.configurationId())this.deny(e,'provider-changed');
        else if(!e.draft||messageFingerprint(r.message)!==e.fingerprint)this.deny(e,'payload-changed');
        else if(quiet(r.channelPolicy,this.now())){await this.save(j);return this.publicEntry(e);}
        else if(!this.budget(j,e,r.channelPolicy))this.deny(e,'budget-or-rate-limit');
        else{
          const prepared=await provider.prepare(structuredClone(r.message),signal);
          // Preparation may refresh credentials. Re-read all trusted authority after that wait.
          const fresh=await this.resolve(e.intent,j,e.verificationChallengeId);
          this.redact(e,fresh.resolved);
          if(signal.aborted)this.deny(e,'cancelled');
          else if(fresh.reason||!fresh.resolved||!fresh.provider||!same(fresh.resolved,r)||fresh.approvalId!==approvalId||!this.budget(j,e,fresh.resolved.channelPolicy))this.deny(e,'authority-changed');
          else if(quiet(fresh.resolved.channelPolicy,this.now())){await this.save(j);return this.publicEntry(e);}
          else{
            e.phase='dispatching';e.reservedAt=this.now();e.reservedCost=r.channelPolicy.maxDispatchCostMicros;
            if(approvalId)e.approvalId=approvalId;
            if(approvalId){
              const a=r.context.approvals.find(a=>a.id===approvalId)!;
              j.approvalHead=await rememberApproval(this.deps.store,{id:approvalId,expiresAt:a.expiresAt},j.approvalHead);
            }
            // One atomic encrypted record binds reservation, approval consumption and intent.
            await this.save(j);
            // Storage is an await too. Recheck edits/revocation after the durable marker;
            // a lost/stale authority here keeps uncertain evidence and never dispatches.
            const final=await this.resolve(e.intent,j,e.verificationChallengeId,e);
            if(signal.aborted||final.reason||!final.resolved||!same(final.resolved,fresh.resolved)||final.approvalId!==approvalId)throw unavailable();
            let observation:ProviderObservation;
            try{observation=await prepared.dispatch();}catch{observation={state:'unconfirmed'};}
            e.receipt=this.receipt(e.intent,e.receipt.adapter,'unconfirmed');
            e.receipt=this.observed(e,observation,'service-receipt');e.phase='final';
            await this.save(j);return this.publicEntry(e);
          }
        }
      }catch{
        // A failed journal write may already have persisted the dispatch marker. Never dispatch
        // after it fails, and never replace a possible-dispatch marker with safe-retry evidence.
        if(e.phase==='dispatching'){e.phase='final';e.receipt=this.receipt(e.intent,e.receipt.adapter,'unconfirmed');}
        else if(e.phase!=='final')this.deny(e,'unavailable');
      }
      await this.save(j);return this.publicEntry(e);
    });
  }
  /** Exact content is returned only here, never by generic reads. No provider preparation,
   * journal write, approval consumption or dispatch occurs during review. */
  async reviewDetails(requestId:string,privacyEpoch:string):Promise<ContactExactReview>{
    IdSchema.parse(requestId);this.uiScope(privacyEpoch);
    return serialized(this.deps.store,async()=>{
      const j=await this.load(),e=j.entries.find(e=>e.intent.requestId===requestId);
      if(!e||e.phase!=='queued'||!e.draft||e.contentRedacted||e.verificationChallengeId||e.exactApproval)throw unavailable();
      const checked=await this.resolve(e.intent,j),r=checked.resolved;
      const scope=this.uiScope(privacyEpoch);
      if(!r||!checked.provider||checked.reason&&checked.reason!=='approval-required'||automaticPrivate(r)||
        r.context.privateSession!==scope.privateSession||messageFingerprint(r.message)!==e.fingerprint||!this.budget(j,e,r.channelPolicy))throw unavailable();
      if(r.message.channel==='whatsapp'&&(!r.whatsappTemplate||renderApprovedContactText(r.whatsappTemplate,r.message.whatsapp!.variables)!==r.message.body))throw unavailable();
      validateMessage(r.message,r.message.channel);
      const preview=ContactExactReviewSchema.parse({requestId,reviewId:randomUUID(),privacyEpoch,reviewDigest:'0'.repeat(64),revision:1,expiresAt:this.now()+120000,
        binding:e.intent.binding,channel:r.message.channel,destination:r.message.recipient,sender:r.message.sender,
        content:r.message.channel==='voice'?{kind:'call',script:r.message.body,maxVoiceSeconds:r.message.maxVoiceSeconds}:r.message.channel==='whatsapp'?{kind:'message',body:JSON.stringify({renderedText:r.message.body,contentSid:r.message.whatsapp!.contentSid,variables:r.message.whatsapp!.variables,language:r.whatsappTemplate!.language,templateSha256:r.whatsappTemplate!.sha256},null,2)}:
          {kind:'message',body:r.message.body,...(r.message.subject!==undefined?{subject:r.message.subject}:{})},
        contentClass:scope.privateSession||r.context.containsPrivateContent?'private':r.context.template!.contentClass});
      const authorizationSha256=authorizationFingerprint(r);
      preview.reviewDigest=sha256(storedJson({preview,authorizationSha256}));
      this.uiScope(privacyEpoch);const reviews=this.reviews();
      for(const [id,old]of reviews)if(old.preview.requestId===requestId)reviews.delete(id);
      if(reviews.size>=1000)throw unavailable();
      const {content:_content,destination:_destination,sender:_sender,routeLabel:_label,channel:_channel,contentClass:_class,...identity}=preview;
      reviews.set(preview.reviewId,{preview:structuredClone(identity),authorizationSha256});
      return preview;
    });
  }
  /** Atomically bind a one-use approval in the original encrypted outbox. Dispatch
   * remains a separate operation with its existing durable consumption/receipt protocol. */
  async approve(input:unknown):Promise<ContactIntent>;
  async approve(input:unknown,actionRequestId:string):Promise<ContactIntent|ActionReceipt>;
  async approve(input:unknown,actionRequestId?:string):Promise<ContactIntent|ActionReceipt>{
    const value=ContactReviewApprovalInputSchema.parse(input);this.uiScope(value.privacyEpoch);
    if(actionRequestId)IdSchema.parse(actionRequestId);
    return serialized(this.deps.store,async()=>{
      const j=await this.load(),e=j.entries.find(e=>e.intent.requestId===value.requestId),digest=sha256(storedJson(value));
      const prior=actionRequestId&&(j.entries.find(e=>e.approvalAction?.requestId===actionRequestId)?.approvalAction??(await archived(this.deps.store,value.requestId))?.entry.approvalAction);
      if(prior){
        if(prior.requestId!==actionRequestId||prior.digest!==digest)throw unavailable();
        this.uiScope(value.privacyEpoch);return structuredClone(prior.receipt);
      }
      const reviews=this.reviews(),review=reviews.get(value.reviewId),p=review?.preview;
      if(!p||p.expiresAt<=this.now()||p.requestId!==value.requestId||p.privacyEpoch!==value.privacyEpoch||p.reviewDigest!==value.reviewDigest||p.revision!==value.revision||
        p.binding.routeId!==value.routeId||p.binding.routeRevision!==value.routeRevision||p.binding.bodySha256!==value.bodySha256)throw unavailable();
      // Even a failed approval attempt needs a new explicit review; never reuse a stale click.
      reviews.delete(value.reviewId);
      if(!e||e.phase!=='queued'||e.exactApproval||!same(e.intent.binding,p.binding))throw unavailable();
      const checked=await this.resolve(e.intent,j),r=checked.resolved,scope=this.uiScope(value.privacyEpoch);
      if(!r||!checked.provider||checked.reason&&checked.reason!=='approval-required'||automaticPrivate(r)||r.context.privateSession!==scope.privateSession||
        authorizationFingerprint(r)!==review!.authorizationSha256||messageFingerprint(r.message)!==e.fingerprint||!this.budget(j,e,r.channelPolicy)||p.expiresAt<=this.now())throw unavailable();
      e.exactApproval={approval:{id:p.reviewId,requestId:p.requestId,binding:p.binding,createdAt:this.now(),expiresAt:p.expiresAt,revoked:false},
        authorizationSha256:review!.authorizationSha256,privacyEpoch:value.privacyEpoch};
      if(actionRequestId)e.approvalAction={requestId:actionRequestId,digest,receipt:{id:randomUUID(),requestId:actionRequestId,feature:'contacts',action:'approve',observedAt:this.now(),outcome:'pending',effect:'queued'}};
      this.uiScope(value.privacyEpoch);await this.save(j);this.uiScope(value.privacyEpoch);
      return structuredClone(e.intent);
    });
  }
  async recordApprovalReceipt(outboxId:string,receipt:ActionReceipt):Promise<ActionReceipt>{
    ActionReceiptSchema.parse(receipt);
    return serialized(this.deps.store,async()=>{
      const j=await this.load(),e=j.entries.find(e=>e.intent.requestId===outboxId);
      if(!e?.approvalAction||e.approvalAction.requestId!==receipt.requestId||receipt.feature!=='contacts'||receipt.action!=='approve')throw unavailable();
      e.approvalAction.receipt=structuredClone(receipt);await this.save(j);return receipt;
    });
  }
  async reviewOverview(){
    return serialized(this.deps.store,async()=>{
      const j=await this.load(),outbox=[];
      for(const e of j.entries.slice(-100)){
        if(e.verificationChallengeId)continue; // Even a body hash can disclose a short fixed code.
        let visible=false;
        try{const r=await this.deps.resolve(structuredClone(e.intent)),scope=this.deps.reviewScope?.();
          if(!scope||scope.authority!=='trusted-ui'||!r.execution.active||r.context.privateSession!==scope.privateSession||automaticPrivate(r))continue;
          outbox.push({receipt:this.publicEntry(e),channel:e.channel,draftKept:!!e.draft,approvalRequired:e.phase==='queued'&&e.awaitingReview===true&&!e.exactApproval});visible=true;
        }catch{/* An ended or unavailable task cannot expose private draft metadata. */}
        // Restart/ended tasks lose draft/review authority, not their public
        // delivery evidence. This classification was persisted by the host.
        if(!visible){const scope=this.deps.reviewScope?.();if(scope?.authority==='trusted-ui'&&!scope.privateSession&&!e.contentRedacted&&(e.draftPrivacy==='nonprivate'||e.verificationChallengeId))outbox.push({receipt:this.publicEntry(e),channel:e.channel,draftKept:false,approvalRequired:false});}
      }
      return outbox;
    });
  }
  private observed(e:OutboxEntry,o:ProviderObservation,source:'service-receipt'|'observed-record'):DeliveryReceipt {
    if(!o||typeof o!=='object')return this.receipt(e.intent,e.receipt.adapter,'unconfirmed');
    const receipt:DeliveryReceipt={id:randomUUID(),requestId:e.intent.requestId,binding:e.intent.binding,adapter:e.receipt.adapter,
      state:o.state,observedAt:this.now(),evidence:o.recordId?{source,recordId:o.recordId}:{source:'none'}};
    const parsed=DeliveryReceiptSchema.safeParse(receipt);
    return parsed.success?parsed.data:this.receipt(e.intent,e.receipt.adapter,'unconfirmed');
  }
  /** GET-like operation, with crash recovery. Returns no draft, recipient, or provider error. */
  async get(requestId:string):Promise<DeliveryReceipt|undefined>{
    IdSchema.parse(requestId);return serialized(this.deps.store,async()=>{const j=await this.load();await this.recover(j);await this.save(j);
      const e=(await archived(this.deps.store,requestId))?.entry??j.entries.find(x=>x.intent.requestId===requestId);return e?this.publicEntry(e):undefined;});
  }
  async verificationChallenge(requestId:string):Promise<string|undefined>{
    IdSchema.parse(requestId);return serialized(this.deps.store,async()=>{
      const j=await this.load();return ((await archived(this.deps.store,requestId))?.entry??j.entries.find(e=>e.intent.requestId===requestId))?.verificationChallengeId;
    });
  }
  async cancel(requestId:string):Promise<DeliveryReceipt|undefined>{
    IdSchema.parse(requestId);return serialized(this.deps.store,async()=>{const j=await this.load();await this.recover(j);
      const cold=await archived(this.deps.store,requestId);if(cold){await this.save(j);return this.publicEntry(cold.entry);}
      const e=j.entries.find(x=>x.intent.requestId===requestId);
      if(e?.phase==='queued'&&e.draft){try{this.redact(e,await this.deps.resolve(structuredClone(e.intent)));}catch{/* No content is added on cancellation. */}}
      if(e?.phase==='queued')this.deny(e,'cancelled');await this.save(j);return e?this.publicEntry(e):undefined;});
  }
  async reconcile(requestId:string,signal:AbortSignal):Promise<DeliveryReceipt|undefined>{
    IdSchema.parse(requestId);return serialized(this.deps.store,async()=>{
      const j=await this.load();await this.recover(j);
      const cold=await archived(this.deps.store,requestId);if(cold){await this.save(j);return this.publicEntry(cold.entry);}
      const e=j.entries.find(x=>x.intent.requestId===requestId);
      if(!e)return undefined;
      const ev=e.receipt.evidence,provider=this.providers.get(e.receipt.adapter);
      if(e.draft&&provider?.observe&&(!provider.configurationId||e.providerConfigurationId===await provider.configurationId())&&(ev.source==='service-receipt'||ev.source==='observed-record')){
        try{const o=await provider.observe(structuredClone(e.draft),ev.recordId,signal);
          if(o.recordId===ev.recordId&&o.state!=='unconfirmed'){
            // A stale status poll cannot regress confirmed transmission/delivery to acceptance.
            if(e.receipt.state!=='delivered'&&(e.receipt.state!=='sent'||!['accepted','rejected'].includes(o.state)))e.receipt=this.observed(e,o,'observed-record');
          }
        }catch{/* Preserve evidence; no send or raw error dump. */}
      }
      await this.save(j);return this.publicEntry(e);
    });
  }

  /** UI-only. Queue a fixed service-owned code; never return the code or mark a route verified. */
  async beginVerification(routeId:string):Promise<{challengeId:string;requestId:string;expiresAt:number}>{
    IdSchema.parse(routeId);if(!this.deps.resolveVerification)throw unavailable();
    return serialized(this.deps.store,async()=>{const j=await this.load();await this.recover(j);
      const host=await this.deps.resolveVerification!(routeId);
      const c:Challenge={id:randomUUID(),routeId,revision:host.route.revision,adapter:host.route.adapter,recipientSha256:sha256(canonicalRecipient(host.channel,host.recipient)),salt:randomBytes(32).toString('hex'),digest:'',
        createdAt:this.now(),expiresAt:this.now()+300000,attempts:0,used:false,code:String(randomInt(100000,1000000)),requestId:randomUUID()};
      c.digest=sha256(c.salt+c.code);
      if(j.challenges.filter(x=>x.routeId===c.routeId&&this.now()-x.createdAt<60000).length||j.challenges.length>=1000)throw unavailable();
      // Issuing a new challenge invalidates all older ones for the route.
      for(const old of j.challenges)if(old.routeId===c.routeId)old.used=true;
      j.challenges.push(c);
      const r=await this.verificationResolution(c.id,j),route=r.context.route!;
      const intent:ContactIntent={requestId:c.requestId!,binding:{routeId,routeRevision:c.revision,recipientId:route.recipientId,recipientSha256:c.recipientSha256,
        workflowId:'contact-verification',templateId:'contact-code',templateVersion:1,bodySha256:sha256(reviewedContactBody(r.message))}};
      const checked=await this.resolve(intent,j,c.id);if(checked.reason||!checked.provider||!checked.resolved)throw unavailable();
      if(j.entries.length>=10000)throw unavailable();
      j.entries.push({intent,createdAt:this.now(),phase:'queued',receipt:this.receipt(intent,c.adapter,'pending'),draft:r.message,
        providerConfigurationId:await checked.provider.configurationId?.(),
        fingerprint:messageFingerprint(r.message),channel:r.message.channel,verificationChallengeId:c.id});
      await this.save(j);return {challengeId:c.id,requestId:c.requestId!,expiresAt:c.expiresAt};
    });
  }
  private async verificationResolution(challengeId:string,j:Journal):Promise<ResolvedContact>{
    const c=j.challenges.find(x=>x.id===challengeId);
    if(!c||c.used||!c.code||c.createdAt>this.now()||c.expiresAt<=this.now()||!this.deps.resolveVerification)throw unavailable();
    const h=structuredClone(await this.deps.resolveVerification(c.routeId));
    if(h.route.id!==c.routeId||h.route.revision!==c.revision||h.route.adapter!==c.adapter||!h.route.enabled||h.route.recipientSha256!==c.recipientSha256||sha256(canonicalRecipient(h.channel,h.recipient))!==c.recipientSha256)throw unavailable();
    const message:OutboundMessage={channel:h.channel,recipient:canonicalRecipient(h.channel,h.recipient),sender:canonicalRecipient(h.channel,h.channelPolicy.sender),body:'Capri verification code: '+c.code};
    if(h.channel==='whatsapp')message.whatsapp={contentSid:h.whatsappTemplateSid??'',variables:{'1':c.code}};
    if(h.channel==='voice')message.maxVoiceSeconds=30;
    // This temporary context never escapes and cannot authorize user content.
    const route={...h.route,verification:{method:'user-challenge' as const,recordId:c.id,verifiedAt:0,expiresAt:0}};
    if(h.channel==='whatsapp'&&(!h.whatsappTemplate||renderApprovedContactText(h.whatsappTemplate,message.whatsapp!.variables)!==message.body))throw unavailable();
    return {message,whatsappTemplate:h.whatsappTemplate,execution:{active:true,localOnly:false},channelPolicy:h.channelPolicy,context:{settings:defaultExtensionSettings(),route,workflow:undefined,
      template:{id:'contact-code',version:1,bodySha256:sha256(reviewedContactBody(message)),contentClass:'public'},
      privateSession:false,containsPrivateContent:false,rules:[],approvals:[]}};
  }
  /** Trusted UI supplies the code read at the destination. Rebinds to the current route identity.
   * This service currently supports only its own durable challenge proofs, for every adapter.
   * Persist the returned route only via the authenticated UI configuration path. */
  async completeVerification(challengeId:string,code:string,route:Omit<ContactRoute,'verification'>):Promise<ContactRoute>{
    return serialized(this.deps.store,async()=>{
      const j=await this.load(),c=j.challenges.find(x=>x.id===challengeId);
      if(!c||c.used||c.createdAt>this.now()||c.expiresAt<=this.now()||c.attempts>=5)throw unavailable();
      c.attempts++;const e=j.entries.find(x=>x.intent.requestId===c.requestId);
      const delivered=e&&['accepted','sent','delivered'].includes(e.receipt.state)&&e.intent.binding.routeId===c.routeId&&e.intent.binding.routeRevision===c.revision&&
        e.intent.binding.recipientSha256===c.recipientSha256&&e.receipt.adapter===c.adapter;
      const valid=delivered&&route.id===c.routeId&&route.revision===c.revision&&route.adapter===c.adapter&&route.recipientSha256===c.recipientSha256&&
        /^\d{6}$/.test(code)&&equalContactDigest(c.digest,sha256(c.salt+code));
      if(!valid){await this.save(j);throw unavailable();}
      const verified=ContactRouteSchema.parse({...route,verification:{method:'user-challenge',recordId:c.id,verifiedAt:this.now(),expiresAt:this.now()+30*86400000}});
      c.used=true;delete c.code;
      j.verifiedRoutes=j.verifiedRoutes.filter(r=>r.id!==route.id);j.verifiedRoutes.push(verified);
      await this.save(j);return verified;
    });
  }
  /** Resolve proof only against the current trusted UI route revision and identity. */
  async verifiedRoute(current:Omit<ContactRoute,'verification'>):Promise<ContactRoute|undefined>{
    return serialized(this.deps.store,async()=>this.proofFor(await this.load(),current));
  }
  async status(){
    return serialized(this.deps.store,async()=>{const j=await this.load();await this.recover(j);await this.save(j);
      const a=await this.deps.availability?.().catch(()=>undefined);
      return {feature:'contacts' as const,capability:featureCapability({enabled:a?.enabled===true,configured:a?.configured===true,supported:true,ready:a?.ready===true,
        verification:a?.ready?'verified':'none',actions:this.deps.reviewScope?['send','review-details','approve']:['send']}),
        pending:j.entries.filter(e=>e.phase==='queued').length,unconfirmed:(j.archivedUnconfirmed??0)+j.entries.filter(e=>e.receipt.state==='unconfirmed').length};
    });
  }
}

export interface ContactsModuleOptions extends Omit<ContactsDependencies,'store'|'clock'|'resolve'> {
  resolve(intent:ContactIntent,context:ExtensionActionContext):Promise<ResolvedContact>;
}
/** Shared extension contract facade. UI verification/configuration uses ContactsService through
 * the authenticated host, never task actions. No credentials or route overrides are HTTP inputs. */
export function createContactsModule(deps:ExtensionDependencies,options?:ContactsModuleOptions):ExtensionModule&{
  administration(context:ExtensionActionContext,resolveVerification?:ContactsDependencies['resolveVerification']):ContactsService;
  reviewDetails(requestId:string,epoch:string,context:ExtensionActionContext):Promise<ContactExactReview>;
  reviewOverview(context:ExtensionActionContext):ReturnType<ContactsService['reviewOverview']>;
  delivery(requestId:string,context:ExtensionActionContext):Promise<DeliveryReceipt|undefined>;
} {
  const shutdown=new AbortController();
  const service=(context?:ExtensionActionContext,resolveVerification?:ContactsDependencies['resolveVerification'])=>new ContactsService({store:deps.store,clock:deps.clock,providers:options?.providers??[],resolveVerification,
    availability:options?.availability,draftRetentionMs:options?.draftRetentionMs,reviewScope:options?.reviewScope,
    resolve:async intent=>{
      if(!options||!context)throw unavailable();
      if(context.grant&&(context.grant.revoked||context.grant.taskId!==context.taskId||context.grant.createdAt>safeClock(deps.clock)||context.grant.expiresAt<=safeClock(deps.clock)))throw unavailable();
      const r=structuredClone(await options.resolve(intent,context));
      r.execution.active=r.execution.active&&!shutdown.signal.aborted&&!context.signal.aborted;
      r.execution.localOnly=r.execution.localOnly||context.localOnly;
      r.context.privateSession=r.context.privateSession||context.privateSession;
      return r;
    }});
  return {feature:'contacts',
    administration:(context,resolveVerification)=>service(context,resolveVerification),
    reviewDetails:(id,epoch,context)=>service(context).reviewDetails(id,epoch),
    reviewOverview:context=>service(context).reviewOverview(),
    delivery:(id,context)=>service(context).get(id),
    status:async signal=>{signal.throwIfAborted();const s=await service().status();return {feature:'contacts',capability:s.capability};},
    close:async()=>{shutdown.abort();},
    action:async(action,request,context)=>{
      const parsed=ExtensionActionSchema.parse(request);IdSchema.parse(action);
      const base={id:randomUUID(),requestId:parsed.requestId,feature:'contacts' as const,action,observedAt:safeClock(deps.clock)};
      const reject=(code:NonNullable<ActionReceipt['error']>['code'],message:string,retry:'never'|'after-review'='never'):ActionReceipt=>
        ActionReceiptSchema.parse({...base,outcome:'rejected',effect:'none',error:{code,message,retry}});
      if(action!=='send'&&action!=='approve')return reject('unsupported','Contact action is unsupported.');
      if(parsed.taskId!==context.taskId||context.authority==='task'&&!context.taskId)return reject('forbidden','Contact task scope does not match.');
      if(context.grant&&(context.grant.revoked||context.grant.taskId!==context.taskId||context.grant.createdAt>safeClock(deps.clock)||context.grant.expiresAt<=safeClock(deps.clock)))return reject('forbidden','Contact task grant is inactive.');
      if(!options)return reject('unconfigured','Contact channels are unconfigured.','after-review');
      const signal=AbortSignal.any([context.signal,shutdown.signal]);
      const outbox=service({...context,signal});
      let input=parsed.input;
      if(action==='approve'){
        if(context.authority!=='trusted-ui'||signal.aborted)return reject('forbidden','Exact review requires the current trusted UI.');
        try{const approved=await outbox.approve(input,parsed.requestId);
          if('outcome' in approved)return approved;input=approved;
        }catch{return reject('conflict','Exact review expired or changed. Show the message again.','after-review');}
      }
      const intent=ContactIntentSchema.safeParse(input);
      if(!intent.success||action==='send'&&intent.data.requestId!==parsed.requestId)return reject('invalid-request','Contact intent does not match the request.');
      try{
        if(await outbox.verificationChallenge(intent.data.requestId))return reject('forbidden','Verification is available only through trusted contact administration.');
        if(signal.aborted){
          // Stop must also scrub a queued draft if trusted privacy changed since enqueue.
          const known=await outbox.get(intent.data.requestId);
          if(known&&!same(known.binding,intent.data.binding))return reject('conflict','Contact request ID conflicts with its recorded binding.');
          const existing=await outbox.cancel(intent.data.requestId);
          if(!existing)return ActionReceiptSchema.parse({...base,outcome:'cancelled',effect:'none',error:{code:'cancelled',message:'Contact action was cancelled.',retry:'never'}});
        }else if(action==='send')await outbox.enqueue(intent.data);
        const delivery=await outbox.dispatch(intent.data.requestId,signal);
        // Approval acknowledges only the exact approval record, never a delivery.
        // The original send action/outbox retains its own matching delivery receipt.
        if(action==='approve'){
          const receipt:ActionReceipt=delivery.state==='unconfirmed'?ActionReceiptSchema.parse({...base,outcome:'unconfirmed',effect:'unknown',error:{code:'unconfirmed',message:'Delivery is unconfirmed. Inspect the original outbox record.',retry:'read-only-reconcile'}}):
            ActionReceiptSchema.parse({...base,outcome:'completed',effect:'confirmed'});
          return await outbox.recordApprovalReceipt(intent.data.requestId,receipt);
        }
        const result={...base,observedAt:safeClock(deps.clock),delivery};
        switch(delivery.state){
          case 'accepted':case 'sent':case 'delivered':return ActionReceiptSchema.parse({...result,outcome:'completed',effect:'confirmed'});
          case 'pending':return ActionReceiptSchema.parse({...result,outcome:'pending',effect:'queued'});
          case 'rejected':{
            const code=delivery.evidence.source==='trusted-pre-dispatch'?delivery.evidence.code:undefined;
            if(code==='cancelled')return ActionReceiptSchema.parse({...base,outcome:'cancelled',effect:'none',error:{code:'cancelled',message:'Contact action was cancelled before dispatch.',retry:'never'}});
            return ActionReceiptSchema.parse({...result,outcome:'rejected',effect:'none',error:{code:code==='approval-required'?'approval-required':code==='unavailable'?'unavailable':code==='unconfigured'?'unconfigured':'forbidden',message:'Contact delivery was rejected. Review the draft and permissions.',retry:'after-review'}});
          }
          default:return ActionReceiptSchema.parse({...result,outcome:'unconfirmed',effect:'unknown',error:{code:'unconfirmed',message:'Delivery could not be confirmed. Review the service record.',retry:'read-only-reconcile'}});
        }
      }catch{
        // Storage errors may hide an earlier dispatch of this request ID, even during enqueue.
        return ActionReceiptSchema.parse({...base,outcome:'unconfirmed',effect:'unknown',error:{code:'unconfirmed',message:'Delivery could not be confirmed. Review the service record.',retry:'read-only-reconcile'}});
      }
    }};
}

/** Offline migration/rollback hook. Call before reopening the sole profile owner. Carry forward
 * contact-outbox/main AND its linked contact-outbox-receipt/contact-outbox-approval records.
 * Each indexed record is read/written independently; do not use Store.export (it excludes these
 * private kinds). Keep the current Store intact until this hook succeeds. Format3 makes the
 * historical format1/2 status writer refuse the ledger before it can strip accounting fields. */
export async function retainContactJournalAcrossRollback(current:Pick<Store,'get'>&Partial<Pick<Store,'list'>>,recovered:Pick<Store,'get'|'put'>):Promise<void>{
  await serialized(recovered,async()=>{
    if(current===recovered)return;
    const commitAuthority=await retainContactAuthorityAcrossRollback(current,recovered);
    const read=async(s:Pick<Store,'get'>)=>parseJournal(await s.get(kind,journalId));
    const source=await read(current),target=await read(recovered);
    const observation=target.accountingMigration?.observedAt??source.accountingMigration?.observedAt??Math.max(Date.now(),source.usageClock??0,target.usageClock??0);
    // Validate both histories before changing linked records. An interrupted retention keeps
    // the same observation marker, including when the source is still a legacy snapshot.
    const sourceWrites=await rebuildAccounting(current,source,source.usageClock??0,observation,async e=>{
      const cold=await archived(recovered,e.intent.requestId),hot=target.entries.find(h=>h.intent.requestId===e.intent.requestId);
      return cold?retainedEvidence(cold.entry,hot):hot;
    });
    target.accountingMigration??={version:1,observedAt:observation};
    const targetWrites=await rebuildAccounting(recovered,target,target.usageClock??0,observation);
    journalSchema.parse(target);await recovered.put(kind,{id:journalId,...target});
    if(!same(journalSchema.parse(await recovered.get(kind,journalId)),target))throw unavailable();
    for(const [id,record]of targetWrites)await writeArchive(recovered,id,record);
    const entries=new Map(target.entries.map(e=>[e.intent.requestId,e]));
    const merged:Journal={...target,version:3,challenges:[],consumedApprovals:[],verifiedRoutes:source.verifiedRoutes,usageClock:Math.max(source.usageClock??0,target.usageClock??0,...source.entries.map(e=>e.reservedAt??0),...target.entries.map(e=>e.reservedAt??0))};
    // Floyd's cycle check keeps offline traversal memory bounded even for a damaged chain.
    async function* chain<T extends {previous?:string}>(head:string|undefined,get:(id:string)=>Promise<T|undefined>){
      let cursor=head,fast=head;
      while(cursor){
        const r=await get(cursor);if(!r)throw unavailable();yield {id:cursor,record:r};cursor=r.previous;
        for(let n=0;n<2&&fast;n++){const f=await get(fast);if(!f)throw unavailable();fast=f.previous;}
        if(cursor&&cursor===fast)throw unavailable();
      }
    }
    // Offline-only membership sets distinguish committed target links from orphan records left
    // by an interrupted copy. Runtime lookups never enumerate or cache the cold receipt history.
    const linkedReceipts=new Set<string>(),linkedApprovals=new Set<string>();
    for await(const {id} of chain(target.archiveHead,id=>archived(recovered,id)))linkedReceipts.add(id);
    for await(const {id} of chain(target.approvalHead,id=>consumed(recovered,id)))linkedApprovals.add(id);
    for await(const {id,record} of chain(source.archiveHead,async id=>sourceWrites.get(id)??await archived(current,id))){
      const old=await archived(recovered,id),hot=entries.get(id);
      if(old&&!same(old.entry.intent,record.entry.intent)||hot&&!same(hot.intent,record.entry.intent))throw unavailable();
      const linked=linkedReceipts.has(id);
      let retained=retainedEvidence(record.entry,old?.entry);if(hot)retained=retainedEvidence(retained,hot);delete retained.draft;
      await writeArchive(recovered,id,{...record,entry:retained,previous:linked?old!.previous:merged.archiveHead});
      if(!linked){merged.archiveHead=id;linkedReceipts.add(id);}
      const delta=Number(record.entry.receipt.state==='unconfirmed')-Number(linked&&old?.entry.receipt.state==='unconfirmed');
      if(delta)merged.archivedUnconfirmed=(merged.archivedUnconfirmed??0)+delta;
      entries.delete(id); // A restored queue never overrides a durable terminal receipt.
    }
    for(const e of source.entries){
      const cold=await archived(recovered,e.intent.requestId);
      if(cold){
        const id=e.intent.requestId,linked=linkedReceipts.has(id),retained=retainedEvidence(e,cold.entry);delete retained.draft;
        await writeArchive(recovered,id,{...cold,entry:retained,previous:linked?cold.previous:merged.archiveHead});
        if(!linked){merged.archiveHead=id;linkedReceipts.add(id);}entries.delete(id);continue;
      }
      const old=entries.get(e.intent.requestId);
      if(old&&!same(old.intent,e.intent))throw unavailable();
      // The current ledger is authoritative. A restored snapshot may only add older tombstones.
      // Never resurrect a queued send if either ledger has a dispatch reservation.
      const next=retainedEvidence(e,old);
      if(old&&next.phase==='queued'&&(old.phase!=='queued'||old.reservedAt!==undefined)){
        next.phase='final';next.receipt={...next.receipt,state:'unconfirmed',evidence:{source:'none'}};
        next.reservedAt=old.reservedAt;next.reservedCost=old.reservedCost;
      }
      entries.set(e.intent.requestId,next);
    }
    const copyApproval=async(a:ConsumedApproval)=>{
      const old=await consumed(recovered,a.id);
      if(old&&linkedApprovals.has(a.id)){
        if(old.expiresAt<a.expiresAt){const next={...old,expiresAt:a.expiresAt};await recovered.put(approvalKind,next);if(!same(await consumed(recovered,a.id),next))throw unavailable();}
      }else{merged.approvalHead=await rememberApproval(recovered,a,merged.approvalHead,true);linkedApprovals.add(a.id);}
    };
    for await(const {record} of chain(source.approvalHead,id=>consumed(current,id)))await copyApproval(record);
    for(const a of [...target.consumedApprovals,...source.consumedApprovals])await copyApproval(a);
    merged.entries=[...entries.values()];
    merged.archivedReservations=[];merged.archivedUnconfirmed=0;
    for await(const {record} of chain(merged.archiveHead,id=>archived(recovered,id))){const e=record.entry;if(e.receipt.state==='unconfirmed'){
      merged.archivedUnconfirmed++;if(e.reservedCost!==undefined){let usage=merged.archivedReservations.find(x=>x.channel===e.channel);if(!usage){usage={channel:e.channel,count:0,cost:0};merged.archivedReservations.push(usage);}usage.count++;usage.cost+=e.reservedCost;}
    }}
    // Reconstruct by unique original request, including a RECENT hot reservation
    // just merged into an older cold receipt. Archive position is not its age.
    delete merged.accounting;
    const writes=await rebuildAccounting(recovered,merged,merged.usageClock??0,observation);
    for(const [id,record]of writes)await writeArchive(recovered,id,record);
    delete merged.accountingMigration;
    // Legacy automatic-private denials may already contain text; never copy that text forward.
    for(const e of merged.entries)if(e.contentRedacted||e.receipt.evidence.source==='trusted-pre-dispatch'&&e.receipt.evidence.code==='private-automatic-content'){
      delete e.draft;delete e.draftPrivacy;e.contentRedacted=true;
    }
    // Verification challenges are intentionally invalidated during recovery.
    journalSchema.parse(merged);await recovered.put(kind,{id:journalId,...merged});
    const observed=journalSchema.parse(await recovered.get(kind,journalId));if(!same(observed,merged))throw unavailable();
    // Real managed contactStores already supplies the fixed paired-only list
    // operation. Complete that existing journal before releasing authority, too.
    // Legacy get-only contact fixtures have no paired journal boundary.
    if(current.list)await retainPairedAndroidJournalAcrossRollback({list:current.list.bind(current)},recovered);
    await commitAuthority?.();
  });
}
