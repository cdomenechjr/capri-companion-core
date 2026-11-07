import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {z} from 'zod';
import {IdSchema, SecurityJobSchema, SecurityOperationSchema, SecuritySettingsSchema,
  type SecurityEvidence, type SecurityJob, type SecurityOperation, type SecuritySettings} from './contracts';

// All text shown to users is fixed here. Paths, threat names, resource lists, task IDs,
// native exception messages and project names never enter an alert summary.
export const securitySummaries = {
  'no-detection':'Defender completed the requested scan; no detections were observed.',
  remediated:'Defender reports a threat remediated under its existing policy.',
  'action-required':'Defender reports a threat requiring review in Windows Security.',
  unavailable:'Microsoft Defender is unavailable, passive, or not permitted for this operation.',
  uncertain:'The Defender result could not be verified. Review Windows Security; the engine may still be running.',
  healthy:'Defender protection and definition status were observed. This is not a clean scan result.',
  findings:'Security health needs review. No settings were changed.',
  failed:'Defender reported an operation failure. Review Windows Security.',
  cancelled:'The operation was cancelled; no clean scan result is available.',
  unconfirmed:'Monitoring stopped. The Defender engine may continue; no engine cancellation was requested.',
} satisfies Record<SecurityEvidence['outcome'],string>;

const DetectionSchema=z.object({id:IdSchema,action:z.enum(['remediated','action-required','uncertain'])}).strict();
const HealthSchema=z.object({
  available:z.boolean(),mode:z.enum(['normal','passive','disabled','unknown']),
  antivirusEnabled:z.boolean(),realTimeProtection:z.boolean(),serviceEnabled:z.boolean(),
  signaturesOutOfDate:z.boolean().nullable(),signatureVersion:z.string().max(100),
  signatureUpdatedAt:z.number().int().nonnegative().nullable(),
  firewallEnabled:z.boolean().nullable(),pendingReboot:z.boolean().nullable(),
  startupEntryCount:z.number().int().nonnegative().nullable(),
}).strict();
export type DefenderHealth=z.infer<typeof HealthSchema>;
const ObservationSchema=z.object({
  requestId:IdSchema,operation:SecurityOperationSchema,
  phase:z.enum(['not-dispatched','returned']),
  error:z.enum(['unavailable','access-denied','busy','invalid-target','failed']).optional(),
  health:HealthSchema.optional(),
  // This record is issued only by the fixed native adapter after event-log correlation.
  scan:z.object({recordId:IdSchema,scanId:IdSchema,completed:z.boolean(),cancelled:z.boolean(),
    failed:z.boolean().optional(),correlated:z.boolean(),exclusiveWindow:z.boolean()}).strict().optional(),
  detections:z.array(DetectionSchema).max(1000).optional(),detectionsComplete:z.boolean().optional(),
  signatureUpdateVerified:z.boolean().optional(),
}).strict();
export type DefenderObservation=z.infer<typeof ObservationSchema>;
export interface SecurityHost {
  readonly platform:string;
  /** Trusted native transport, never model-supplied observation data. Abort stops
   * monitoring only. Implementations must never invoke global CancelScan/Stop-MpScan. */
  invoke(operation:SecurityOperation,input:{requestId:string;target?:string},signal:AbortSignal):Promise<unknown>;
}

export function validateSecurityTarget(value:unknown):string {
  if(typeof value!=='string'||value.length>240||!/^([A-Za-z]):\\/.test(value)||
    /[\x00-\x1f\x7f*?"<>|]/.test(value)||value.slice(2).includes(':')||value.includes('/')||
    value.split('\\').slice(1).some(p=>p==='.'||p==='..'||/[. ]$/.test(p)||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
    throw new TypeError('Choose an absolute local Windows file or folder path.');
  return path.win32.normalize(value);
}

/** Only observations from SecurityHost may enter this reducer. Exit code 0 is
 * deliberately absent from the evidence contract: it cannot prove a clean scan. */
export function securityOutcome(operation:SecurityOperation,raw:unknown,requestId:string):SecurityEvidence['outcome'] {
  const parsed=ObservationSchema.safeParse(raw);
  if(!parsed.success)return 'uncertain';
  const o=parsed.data;
  if(o.requestId!==requestId||o.operation!==operation)return 'uncertain';
  if(o.error)return o.phase==='not-dispatched'&&['unavailable','access-denied','busy'].includes(o.error)?'unavailable':
    o.phase==='not-dispatched'?'failed':'uncertain';
  if(o.phase!=='returned')return 'uncertain';
  const detections=o.detections??[];
  if(detections.some(d=>d.action==='action-required'))return 'action-required';
  if(detections.some(d=>d.action==='uncertain'))return 'uncertain';
  if(operation==='status'){
    if(!o.health?.available||o.health.mode!=='normal')return 'unavailable';
    if(detections.length)return 'remediated';
    return o.health.antivirusEnabled&&o.health.realTimeProtection&&o.health.serviceEnabled&&
      o.health.signaturesOutOfDate===false&&o.health.firewallEnabled===true&&o.health.pendingReboot===false&&
      o.detectionsComplete===true?'healthy':'findings';
  }
  if(operation==='update-signatures')return o.signatureUpdateVerified===true?'healthy':'uncertain';
  if(!o.scan?.correlated||!o.scan.exclusiveWindow)return 'uncertain';
  if(o.scan.failed)return 'failed';
  if(o.scan.cancelled)return 'cancelled';
  if(!o.scan.completed||o.detectionsComplete!==true)return 'uncertain';
  return detections.length?'remediated':'no-detection';
}

const RequestSchema=z.object({taskId:IdSchema,requestId:IdSchema,operation:SecurityOperationSchema,
  target:z.string().optional(),targetId:IdSchema.optional()}).strict().superRefine((r,c)=>{
  if((r.operation==='custom-scan')!==(r.target!==undefined)||
    (r.targetId!==undefined&&r.operation!=='custom-scan'))c.addIssue({code:'custom',message:'Custom scans require one scoped target.'});
});
export type SecurityRequest=z.infer<typeof RequestSchema>;
export interface SecurityJournal {
  /** Atomic, durable put-if-absent, serialized with the existing request journal.
   * Retain a claimed request even after crash/Stop; never redispatch it. */
  claim(key:string,value:SecurityJournalRecord):Promise<boolean>;
  read(key:string):Promise<SecurityJournalRecord|undefined>;
  save(key:string,value:SecurityJournalRecord):Promise<void>;
}
export interface SecurityJournalRecord {job:SecurityJob;intentSha256:string}
export interface SecurityClock {now():number;localDate(now:number):Date}
const systemClock:SecurityClock={now:Date.now,localDate:now=>new Date(now)};
const clone=(job:SecurityJob):SecurityJob=>SecurityJobSchema.parse(structuredClone(job));

/** Independent module: service wiring must validate current TaskAccess/UI authority
 * and custom-target grants before calling run. This class never creates grants. */
export class SecurityTools {
  private active=new Map<string,{controller:AbortController;taskId:string}>();
  private scanInFlight=false;
  private stopEpoch=0;
  private taskStops=new Map<string,number>();
  constructor(private readonly host:SecurityHost,private readonly journal:SecurityJournal,
    private readonly clock:SecurityClock=systemClock,private readonly id:()=>string=()=>randomUUID()){}

  async run(input:SecurityRequest,signal:AbortSignal):Promise<SecurityJob>{
    const request=RequestSchema.parse(input);
    const stopEpoch=this.stopEpoch,taskStop=this.taskStops.get(request.taskId);
    const target=request.operation==='custom-scan'?validateSecurityTarget(request.target):undefined;
    const key='security-request:'+request.requestId;
    const intentSha256=createHash('sha256').update(JSON.stringify([request.taskId,request.operation,
      target?.toLowerCase()??null,request.targetId??null])).digest('hex');
    const prior=await this.journal.read(key);
    if(prior){
      if(prior.intentSha256!==intentSha256)
        throw new Error('Security request ID conflict.');
      return clone(prior.job);
    }
    const job:SecurityJob={id:this.id(),taskId:request.taskId,requestId:request.requestId,
      operation:request.operation,...(request.targetId?{targetId:request.targetId}:{}),
      state:'pending',createdAt:this.clock.now(),evidence:[]};
    const record=():SecurityJournalRecord=>({job:clone(job),intentSha256});
    if(!await this.journal.claim(key,record())){
      const observed=await this.journal.read(key);
      if(!observed||observed.intentSha256!==intentSha256)
        throw new Error('Security request ID conflict.');
      return clone(observed.job);
    }
    const finish=async(outcome:SecurityEvidence['outcome'],recordId?:string)=>{
      job.state=outcome==='unconfirmed'||outcome==='uncertain'?'unconfirmed':outcome==='cancelled'?'cancelled':
        outcome==='failed'||outcome==='unavailable'?'failed':'completed';
      job.evidence=[{id:this.id(),jobId:job.id,source:'windows-defender',observedAt:this.clock.now(),outcome,
        ...(recordId?{recordId}:{}),summary:request.operation==='update-signatures'&&outcome==='healthy'?
          'Defender definition update completed; current definitions were observed.':securitySummaries[outcome]}];
      await this.journal.save(key,record());return clone(job);
    };
    if(signal.aborted||stopEpoch!==this.stopEpoch||taskStop!==this.taskStops.get(request.taskId))return finish('cancelled');
    if(this.host.platform!=='win32')return finish('unavailable');
    const scan=request.operation.endsWith('-scan');
    if(scan&&this.scanInFlight)return finish('unavailable');
    const controller=new AbortController();
    const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
    this.active.set(job.id,{controller,taskId:request.taskId});
    if(scan)this.scanInFlight=true;
    let dispatched=false;
    try{
      job.state='running';await this.journal.save(key,record());
      if(signal.aborted||controller.signal.aborted)return await finish('cancelled');
      dispatched=true;
      // Race abort independently: a non-cooperative transport must not hold Stop.
      const raw=await new Promise<unknown>((resolve,reject)=>{
        const stop=()=>reject(new Error('Monitoring stopped.'));
        controller.signal.addEventListener('abort',stop,{once:true});
        Promise.resolve().then(()=>{
          controller.signal.throwIfAborted();
          return this.host.invoke(request.operation,{requestId:request.requestId,...(target?{target}:{})},controller.signal);
        }).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',stop));
      });
      if(controller.signal.aborted)return await finish('unconfirmed');
      const parsed=ObservationSchema.safeParse(raw);
      const outcome=securityOutcome(request.operation,raw,request.requestId);
      const correlated=parsed.success&&parsed.data.requestId===request.requestId&&parsed.data.operation===request.operation;
      const recordId=correlated?parsed.data.detections?.find(d=>d.action===outcome)?.id??parsed.data.scan?.recordId:undefined;
      return await finish(outcome,recordId);
    }catch{return await finish(dispatched?'unconfirmed':'failed');}
    finally{
      signal.removeEventListener('abort',abort);this.active.delete(job.id);
      if(scan)this.scanInFlight=false;
    }
  }
  /** Only local jobs for this task are affected; never an engine-wide stop. */
  stop(taskId?:string):void {
    if(taskId){IdSchema.parse(taskId);this.taskStops.set(taskId,(this.taskStops.get(taskId)??0)+1);}else this.stopEpoch++;
    for(const item of this.active.values())if(!taskId||item.taskId===taskId)item.controller.abort();
  }

  /** Read-only detailed status for authenticated UI, with fixed recommendations.
   * This does not configure protection, updates, startup apps or scheduling. */
  async inspect(requestId:string,signal:AbortSignal):Promise<{
    outcome:SecurityEvidence['outcome'];health?:DefenderHealth;recommendations:string[];
  }> {
    IdSchema.parse(requestId);signal.throwIfAborted();
    const unavailable={outcome:'unavailable' as const,recommendations:['Review Microsoft Defender availability in Windows Security.']};
    if(this.host.platform!=='win32')return unavailable;
    try{
      const raw=await this.host.invoke('status',{requestId},signal);signal.throwIfAborted();
      const parsed=ObservationSchema.safeParse(raw),outcome=securityOutcome('status',raw,requestId);
      if(!parsed.success||parsed.data.requestId!==requestId||parsed.data.operation!=='status'||!parsed.data.health)
        return {outcome,recommendations:['Security status could not be verified. Review Windows Security.']};
      const h=parsed.data.health,recommendations:string[]=[];
      if(!h.available||h.mode!=='normal'||!h.realTimeProtection)recommendations.push('Review antivirus protection in Windows Security.');
      if(h.signaturesOutOfDate!==false)recommendations.push('Review security intelligence updates in Windows Security.');
      if(h.firewallEnabled!==true)recommendations.push('Review firewall status in Windows Security.');
      if(h.pendingReboot===true)recommendations.push('Windows reports a pending restart. Review Windows Update.');
      else recommendations.push('Review Windows Update for operating system update status.');
      if(h.startupEntryCount!==null&&h.startupEntryCount>0)recommendations.push('Review startup apps in Windows Settings.');
      return {outcome,health:h,recommendations};
    }catch{
      signal.throwIfAborted();return unavailable;
    }
  }
}

export interface SecurityScheduleJournal {
  /** Atomic durable occurrence claim. Shared with coordinator's existing journal. */
  claimOccurrence(localDay:string):Promise<boolean>;
}
export interface SecurityScheduleContext {
  settings:SecuritySettings;profile:'user'|'development'|'self-test';
  hostAvailable:boolean;active:boolean;gameDocked:boolean;quiet:boolean;
}
/** One same-day catch-up, 09:00 through 21:00 local. No previous-day backlog,
 * automatic retries, full scans, OS scheduled tasks or background timers. */
export class SecurityScheduler {
  constructor(private readonly journal:SecurityScheduleJournal,private readonly clock:SecurityClock=systemClock){}
  async tick(context:SecurityScheduleContext,dispatch:(request:{operation:'quick-scan';occurrence:string})=>Promise<void>):Promise<string>{
    const settings=SecuritySettingsSchema.safeParse(context.settings);
    if(context.profile!=='user')return 'non-user-profile';
    if(!settings.success||!settings.data.enabled||!settings.data.dailyQuickScan)return 'disabled';
    if(context.hostAvailable!==true)return 'unavailable';
    const date=this.clock.localDate(this.clock.now()),hour=date.getHours();
    if(!Number.isFinite(date.getTime())||hour<9||hour>=21)return 'not-due';
    if(context.active!==false||context.gameDocked!==false||context.quiet!==false)return 'deferred';
    const day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
    if(!await this.journal.claimOccurrence(day))return 'already-claimed';
    // Claim before dispatch. Failure/crash remains claimed for read-only review.
    try{await dispatch({operation:'quick-scan',occurrence:day});return 'dispatched';}catch{return 'unconfirmed';}
  }
}

/** Dedicated native transport; unlike generic desktop input it permits long scans.
 * helperPath is host-configured, never taken from tool input. */
export function createWindowsSecurityHost(helperPath:string,platform=process.platform):SecurityHost {
  return {platform,invoke(operation,input,signal){
    SecurityOperationSchema.parse(operation);IdSchema.parse(input.requestId);
    if(input.target!==undefined)validateSecurityTarget(input.target);
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const child=spawn(helperPath,[],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
      let output='',settled=false;
      const done=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);
        signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const abort=()=>{child.kill();done(new Error('Monitoring stopped; Defender may continue.'));};
      const timer=setTimeout(abort,24*60*60*1000);
      child.on('error',()=>done(new Error('Defender helper unavailable.')));
      child.stdin.on('error',()=>done(new Error('Defender helper input unavailable.')));
      child.stderr.on('data',()=>{}); // Never expose native error/path dumps.
      child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>1_000_000)abort();});
      child.on('close',()=>{try{done(undefined,JSON.parse(output));}catch{done(new Error('Defender evidence unavailable.'));}});
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted){abort();return;}
      child.stdin.end(JSON.stringify({action:'security',args:{operation,...input}}));
    });
  }};
}
