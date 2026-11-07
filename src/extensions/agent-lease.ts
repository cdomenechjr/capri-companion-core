import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {inspectSupervisedRun,type SupervisorControl,type SupervisorIdentity,type SupervisorInspection} from './supervisor';

export type LeaseProvider='codex'|'claude-api';
export type AgentNativeLeaseClaim=Readonly<{protocol:'capri-native-agent-lease-v1';sessionId:string;hostId:string;creatorCreated:string;startedAt:string;controlRoot:string;controlToken:string;helperPath:string;helperSha256:string;workspaceSha256:string}>;
export type AgentLeaseRecord=Readonly<{token:string;pid:number;owner:string;generation?:number;native?:AgentNativeLeaseClaim}>;
/** Return true only from a trusted supervisor/operator proving the entire specific
 * token-owned provider tree is gone. A missing parent PID is never sufficient.
 * Native pid/creatorCreated identify the exact creating host; the armed journal
 * separately pins its guardian. Use the token-bound native Job ledger, never
 * infer armed termination from either process identity disappearing.
 */
export type AgentLeaseInspector=(record:AgentLeaseRecord,provider:LeaseProvider)=>Promise<boolean>;
export type AgentLeaseRelease='released'|'missing'|'ownership-changed'|'recovery-required';
export type AgentLeaseRecovery={provider:LeaseProvider;state:'available'|'recovered'|'recovery-required';
  reason?:'active'|'inspector-required'|'tree-unconfirmed'|'unreadable-record'|'ownership-changed'|'inspection-failed';record?:AgentLeaseRecord};
export type AgentLease={readonly token:string;readonly record:AgentLeaseRecord;release():AgentLeaseRelease;retain():void};
export class AgentStopUnconfirmed extends Error {}
const busyInstances=new WeakSet<object>();
export class AgentLeaseBusy extends Error {constructor(){super('Agent provider occupied');this.name='AgentLeaseBusy';busyInstances.add(this);}}
export const isAgentLeaseBusy=(value:unknown):value is AgentLeaseBusy=>typeof value==='object'&&value!==null&&busyInstances.has(value);
const providerKey=(provider:LeaseProvider|'claude'):LeaseProvider=>provider==='claude'?'claude-api':provider;
const hex=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const exact=(value:any,fields:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const canonical=(value:any):string=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):value);
export const agentLeaseDigest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function nativeClaim(value:any):asserts value is AgentNativeLeaseClaim{
 if(!exact(value,['protocol','sessionId','hostId','creatorCreated','startedAt','controlRoot','controlToken','helperPath','helperSha256','workspaceSha256'])||value.protocol!=='capri-native-agent-lease-v1'||typeof value.sessionId!=='string'||!value.sessionId||value.sessionId.length>128||!hex.test(value.hostId)||!/^\d{1,20}$/.test(value.creatorCreated)||BigInt(value.creatorCreated)<=0n||!Number.isFinite(Date.parse(value.startedAt))||!hex.test(value.controlToken)||!hex.test(value.helperSha256)||!hex.test(value.workspaceSha256)||!path.isAbsolute(value.controlRoot)||!path.isAbsolute(value.helperPath))throw Error('Invalid native agent lease claim');
}
function regularBytes(file:string,max=65536){
 const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size<1||info.size>max)throw Error('Invalid owned lease record');
 const fd=fs.openSync(file,'r');try{const opened=fs.fstatSync(fd);if(opened.dev!==info.dev||opened.ino!==info.ino||opened.nlink!==1||opened.size!==info.size)throw Error('Lease record changed');const bytes=fs.readFileSync(fd);if(bytes.length!==info.size)throw Error('Lease record changed');return bytes;}finally{fs.closeSync(fd);}
}
/** The actual final pathname is flushed and read back before the caller may
 * authorize a later launch/ACK phase. Checkpoints never replace older evidence. */
function durableNew(file:string,value:unknown){
 const bytes=Buffer.from(JSON.stringify(value)),fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const actual=fs.openSync(file,'r+');try{fs.fsyncSync(actual);}finally{fs.closeSync(actual);}
 if(!regularBytes(file).equals(bytes))throw Error('Durable lease readback changed');return bytes;
}
function durableReplace(file:string,value:unknown,expected:Buffer){
 if(!regularBytes(file).equals(expected))throw Error('Native journal head changed before transition');const temporary=file+'.'+randomUUID()+'.tmp';try{durableNew(temporary,value);if(!regularBytes(file).equals(expected))throw Error('Native journal head changed during transition');fs.renameSync(temporary,file);const fd=fs.openSync(file,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(!regularBytes(file).equals(Buffer.from(JSON.stringify(value))))throw Error('Durable journal head readback changed');}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
const journalHead=(provider:LeaseProvider,record:AgentLeaseRecord,phase:'claimed'|'prepared'|'armed',checkpointSha256:string)=>({schemaVersion:1,protocol:'capri-native-agent-journal-head-v1',provider,leaseSha256:agentLeaseDigest(record),phase,checkpointSha256});
export function ensureAgentLeaseDirectory(directory:string){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||path.resolve(directory)!==directory||directory.includes('\0')||directory.includes('~')||directory.startsWith('\\\\'))throw Error('Agent ownership paths must be canonical absolute local paths');
 let current=path.parse(directory).root;for(const part of path.relative(current,directory).split(path.sep).filter(Boolean)){current=path.join(current,part);if(!fs.existsSync(current))try{fs.mkdirSync(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}const info=fs.lstatSync(current);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Agent ownership directory contains an alias');}
 if(fs.realpathSync.native(directory).toLowerCase()!==directory.toLowerCase())throw Error('Agent ownership directory identity changed');return directory;
}
type Generation={number:number;record:AgentLeaseRecord;raw:Buffer;sha256:string;settlement?:{raw:Buffer;sha256:string}};
function leaseRecord(value:any):AgentLeaseRecord{
 if(!value||!Number.isSafeInteger(value.pid)||value.pid<=0||typeof value.token!=='string'||!value.token||value.token.length>4096||typeof value.owner!=='string'||!value.owner||value.owner.length>4096||Object.keys(value).some(key=>!['token','pid','owner','generation','native'].includes(key))||value.generation!==undefined&&(!Number.isSafeInteger(value.generation)||value.generation<1))throw Error('Invalid lease record');if(value.native)nativeClaim(value.native);
 return Object.freeze({token:value.token,pid:value.pid,owner:value.owner,...(value.generation!==undefined?{generation:value.generation}:{}),...(value.native?{native:Object.freeze(value.native)}:{})});
}
/** One slot per provider (two total), shared by runtime and development supervisors.
 * Disk authority is an immutable generation chain, never provider.json. Exclusive
 * creation elects N+1; a settlement of old N cannot delete or unlock newer N+1.
 * Missing/corrupt history is unknown. No generation/settlement is ever replaced.
 */
export class AgentLeasePool {
  private held=new Map<LeaseProvider,{record:AgentLeaseRecord;active:boolean}>();
  constructor(readonly directory?:string,readonly initializationError?:string){}
  acquire(provider:LeaseProvider|'claude',owner:string,native?:AgentNativeLeaseClaim):AgentLease {
    if(this.initializationError)throw Error(this.initializationError);
    const key=providerKey(provider),token=randomUUID();if(native)nativeClaim(native);
    if(!['codex','claude-api'].includes(key))throw Error('Invalid provider');if(this.held.has(key))throw new AgentLeaseBusy();
    if(typeof owner!=='string'||!owner||owner.length>4096)throw Error('Invalid lease owner');
    let generation:Generation|undefined;const before=this.directory?this.snapshot(key):undefined;
    if(before?.active||before?.foreign||before?.orphan)throw new AgentLeaseBusy();
    const record=leaseRecord({token,pid:process.pid,owner,...(this.directory?{generation:(before?.history.at(-1)?.number||0)+1}:{}),...(native?{native:structuredClone(native)}:{})});
    if(this.directory){
      ensureAgentLeaseDirectory(this.directory);
      if(native){const directory=ensureAgentLeaseDirectory(path.join(this.directory,'runs',token));durableNew(path.join(directory,'claim.json'),record);durableNew(path.join(directory,'head.json'),journalHead(key,record,'claimed',agentLeaseDigest(record)));}
      generation=this.claimGeneration(key,record,before!.history);
      if(native)durableNew(path.join(this.directory,'runs',token,'reserved.json'),{schemaVersion:1,provider:key,leaseSha256:agentLeaseDigest(record)});
      // Compatibility/status hint only. Never replace/delete another hint: the
      // authoritative generation already identifies this exact new owner.
      const file=path.join(this.directory,key+'.json');try{durableNew(file,record);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const existing=this.read(file);if(!existing||!this.history(key).some(row=>agentLeaseDigest(row.record)===agentLeaseDigest(existing.record)))throw Error('Foreign legacy provider record requires independent recovery');}
    }
    else if(native)throw Error('Native ownership requires a durable shared lease pool');
    this.held.set(key,{record,active:true});
    let outcome:AgentLeaseRelease|undefined,retained=false;
    return {token,record,retain:()=>{if(outcome||retained)return;retained=true;const slot=this.held.get(key);if(slot?.record.token===token)slot.active=false;},release:()=>{
      if(outcome)return outcome;
      // Retained leases require the inspector path, never a late release callback.
      if(retained)return 'recovery-required';
      // Native claims are settled only through their exact journal inspector.
      if(native){retained=true;const slot=this.held.get(key);if(slot?.record.token===token)slot.active=false;return 'recovery-required';}
      outcome='released';
      try{
        if(this.directory){
          this.settle(key,generation!,{kind:'legacy-release',recordSha256:agentLeaseDigest(record)});
          const file=path.join(this.directory,key+'.json'),current=this.read(file),history=this.history(key);
          if(current===undefined)outcome='missing';
          else if(!history.some(row=>agentLeaseDigest(row.record)===agentLeaseDigest(current.record))||history.at(-1)?.record.token!==token)outcome='ownership-changed';
        }
      }catch{outcome='recovery-required';}
      finally{if(this.held.get(key)?.record.token===token)this.held.delete(key);}
      return outcome;
    }};
  }
  private read(file:string):{text:string;record:AgentLeaseRecord}|undefined{
    let text:string;
    try{text=regularBytes(file).toString('utf8');}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    return {text,record:leaseRecord(JSON.parse(text))};
  }
  private generationDirectory(provider:LeaseProvider){return path.join(this.directory!,'generations',provider);}
  private generationFile(provider:LeaseProvider,number:number,suffix=''){return path.join(this.generationDirectory(provider),String(number).padStart(16,'0')+suffix+'.json');}
  private history(provider:LeaseProvider):Generation[]{
    if(!this.directory)return [];const directory=this.generationDirectory(provider);if(!fs.existsSync(directory)){if(this.reservations(provider).some(record=>record.generation!==undefined))throw Error('Native generation history is missing');return [];}
    ensureAgentLeaseDirectory(directory);const entries=fs.readdirSync(directory);if(entries.length>40001||entries.some(name=>name!=='ledger.json'&&!/^\d{16}(?:\.anchor|\.settled(?:\.anchor)?)?\.json$/.test(name)))throw Error('Invalid generation history');const numbers=entries.filter(name=>/^\d{16}\.json$/.test(name)).map(name=>Number(name.slice(0,16))).sort((a,b)=>a-b),rows:Generation[]=[];
    if(!numbers.length){if(entries.length)throw Error('Generation history was removed');return [];}
    const ledger=JSON.parse(regularBytes(path.join(directory,'ledger.json')).toString('utf8'));if(!exact(ledger,['schemaVersion','protocol','provider','firstSha256'])||ledger.schemaVersion!==1||ledger.protocol!=='capri-agent-generation-ledger-v1'||ledger.provider!==provider)throw Error('Generation ledger changed');
    for(const [offset,number] of numbers.entries()){
      if(number!==offset+1)throw Error('Generation history has a missing/reused sequence');const raw=regularBytes(this.generationFile(provider,number)),value=JSON.parse(raw.toString('utf8')),record=leaseRecord(value.record),previous=rows.at(-1),sha256=createHash('sha256').update(raw).digest('hex');
      if(!exact(value,['schemaVersion','protocol','provider','generation','previousSha256','previousSettlementSha256','record','recordSha256'])||value.schemaVersion!==1||value.protocol!=='capri-agent-generation-v1'||value.provider!==provider||value.generation!==number||record.generation!==undefined&&record.generation!==number||value.recordSha256!==agentLeaseDigest(record)||value.previousSha256!==(previous?.sha256??null)||value.previousSettlementSha256!==(previous?.settlement?.sha256??null)||previous&&!previous.settlement)throw Error('Generation chain binding changed');
      const anchor=JSON.parse(regularBytes(this.generationFile(provider,number,'.anchor')).toString('utf8'));if(!exact(anchor,['schemaVersion','provider','generation','sha256'])||anchor.schemaVersion!==1||anchor.provider!==provider||anchor.generation!==number||anchor.sha256!==sha256||number===1&&ledger.firstSha256!==sha256)throw Error('Generation anchor changed');
      const row:Generation={number,record,raw,sha256};const settled=this.generationFile(provider,number,'.settled');if(fs.existsSync(settled)){const bytes=regularBytes(settled);this.validateSettlement(provider,row,JSON.parse(bytes.toString('utf8')));row.settlement={raw:bytes,sha256:createHash('sha256').update(bytes).digest('hex')};const witness=JSON.parse(regularBytes(this.generationFile(provider,number,'.settled.anchor')).toString('utf8'));if(!exact(witness,['schemaVersion','provider','generation','sha256'])||witness.schemaVersion!==1||witness.provider!==provider||witness.generation!==number||witness.sha256!==row.settlement.sha256)throw Error('Settlement anchor changed');}rows.push(row);
    }
    if(entries.filter(name=>/^\d{16}\.anchor\.json$/.test(name)).length!==rows.length||entries.filter(name=>/\.settled\.json$/.test(name)).length!==rows.filter(row=>row.settlement).length||entries.filter(name=>/\.settled\.anchor\.json$/.test(name)).length!==rows.filter(row=>row.settlement).length)throw Error('Generation authority or settlement is missing');
    for(const record of this.reservations(provider))if(record.generation!==undefined&&!rows.some(row=>row.number===record.generation&&agentLeaseDigest(row.record)===agentLeaseDigest(record)))throw Error('Reserved native generation history is missing or changed');return rows;
  }
  private claimGeneration(provider:LeaseProvider,record:AgentLeaseRecord,history:Generation[]){
    const number=(history.at(-1)?.number||0)+1;if(record.generation!==undefined&&record.generation!==number)throw Error('Generation allocation changed');const directory=ensureAgentLeaseDirectory(this.generationDirectory(provider)),previous=history.at(-1),value={schemaVersion:1,protocol:'capri-agent-generation-v1',provider,generation:number,previousSha256:previous?.sha256??null,previousSettlementSha256:previous?.settlement?.sha256??null,record,recordSha256:agentLeaseDigest(record)};
    let raw:Buffer;try{raw=durableNew(this.generationFile(provider,number),value);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new AgentLeaseBusy();throw error;}const sha256=createHash('sha256').update(raw).digest('hex');durableNew(this.generationFile(provider,number,'.anchor'),{schemaVersion:1,provider,generation:number,sha256});if(number===1)durableNew(path.join(directory,'ledger.json'),{schemaVersion:1,protocol:'capri-agent-generation-ledger-v1',provider,firstSha256:sha256});return {number,record,raw,sha256};
  }
  private validateSettlement(provider:LeaseProvider,generation:Generation,value:any){
    if(!exact(value,['schemaVersion','protocol','provider','generation','generationSha256','recordSha256','record','evidence'])||value.schemaVersion!==1||value.protocol!=='capri-agent-generation-settlement-v1'||value.provider!==provider||value.generation!==generation.number||value.generationSha256!==generation.sha256||value.recordSha256!==agentLeaseDigest(generation.record)||agentLeaseDigest(value.record)!==agentLeaseDigest(generation.record))throw Error('Generation settlement binding changed');
    if(generation.record.native){const evidence=new AgentLeaseJournal(this,provider,generation.record).evidence();if(agentLeaseDigest(value.evidence)!==agentLeaseDigest(evidence))throw Error('Native generation proof changed');}
    else if(!exact(value.evidence,['kind','recordSha256'])||!['legacy-release','legacy-inspector'].includes(value.evidence.kind)||value.evidence.recordSha256!==value.recordSha256)throw Error('Legacy generation settlement changed');
  }
  private settle(provider:LeaseProvider,generation:Generation,evidence:unknown){
    if(!regularBytes(this.generationFile(provider,generation.number)).equals(generation.raw))throw Error('Settled generation changed');const value={schemaVersion:1,protocol:'capri-agent-generation-settlement-v1',provider,generation:generation.number,generationSha256:generation.sha256,recordSha256:agentLeaseDigest(generation.record),record:generation.record,evidence:generation.record.native?new AgentLeaseJournal(this,provider,generation.record).evidence():evidence},file=this.generationFile(provider,generation.number,'.settled');
    let raw:Buffer;try{raw=durableNew(file,value);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;raw=regularBytes(file);this.validateSettlement(provider,generation,JSON.parse(raw.toString('utf8')));}
    const anchor={schemaVersion:1,provider,generation:generation.number,sha256:createHash('sha256').update(raw).digest('hex')},anchorFile=this.generationFile(provider,generation.number,'.settled.anchor');try{durableNew(anchorFile,anchor);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||!regularBytes(anchorFile).equals(Buffer.from(JSON.stringify(anchor))))throw error;}
  }
  private snapshot(provider:LeaseProvider){
    const history=this.history(provider),mirror=this.directory?this.read(path.join(this.directory,provider+'.json')):undefined,latest=history.at(-1),active=latest&&!latest.settlement?latest:undefined,foreign=mirror&&!history.some(row=>agentLeaseDigest(row.record)===agentLeaseDigest(mirror.record))?mirror.record:undefined;
    const orphan=!active?this.orphaned(provider).find(record=>!history.some(row=>agentLeaseDigest(row.record)===agentLeaseDigest(record))):undefined;return {history,mirror,active,foreign,orphan};
  }
  peek(provider:LeaseProvider):{state:'available'}|{state:'occupied';record:AgentLeaseRecord;active:boolean}|{state:'unknown'}{
    if(this.initializationError||!['codex','claude-api'].includes(provider))return {state:'unknown'};try{const slot=this.held.get(provider);if(!this.directory)return slot?{state:'occupied',record:slot.record,active:slot.active}:{state:'available'};const state=this.snapshot(provider),record=state.foreign??state.active?.record??state.orphan??slot?.record;return record?{state:'occupied',record,active:!!slot?.active&&slot.record.token===record.token}:{state:'available'};}catch{return {state:'unknown'};}
  }
  private reservations(provider:LeaseProvider):AgentLeaseRecord[]{
    if(!this.directory)return [];const root=path.join(this.directory,'runs');if(!fs.existsSync(root))return [];ensureAgentLeaseDirectory(root);const entries=fs.readdirSync(root);if(entries.length>10000)throw Error('Native ownership history requires operator maintenance');const records:AgentLeaseRecord[]=[];
    for(const token of entries){if(!uuid.test(token))throw Error('Unexpected native journal directory');const directory=path.join(root,token);ensureAgentLeaseDirectory(directory);const reserved=path.join(directory,'reserved.json'),advanced=fs.existsSync(path.join(directory,'prepared.json'))||fs.existsSync(path.join(directory,'armed.json'));if(!fs.existsSync(reserved)){if(advanced)throw Error('Advanced native journal lost its reservation');continue;}
      const record=leaseRecord(JSON.parse(regularBytes(path.join(directory,'claim.json')).toString('utf8'))),value=JSON.parse(regularBytes(reserved).toString('utf8'));if(!record.native)throw Error('Native reservation lost its claim');if(record.token!==token||!exact(value,['schemaVersion','provider','leaseSha256'])||value.schemaVersion!==1||!['codex','claude-api'].includes(value.provider)||value.leaseSha256!==agentLeaseDigest(record))throw Error('Native reservation changed');if(value.provider===provider)records.push(record);
    }return records;
  }
  private orphaned(provider:LeaseProvider){return this.reservations(provider).filter(record=>!new AgentLeaseJournal(this,provider,record).isSettled());}
  /** Trusted startup/operator route, never an inference retry. Corrupt/unreadable
   * records are retained for supervisor/operator repair; no arbitrary force-clear.
   * Settles only the immutable generation inspected. No check/unlink race exists;
   * neither a late inspector nor a legacy status hint can unlock a newer owner.
   */
  async reconcile(provider:LeaseProvider,inspectStopped?:AgentLeaseInspector):Promise<AgentLeaseRecovery>{
    const required=(reason:AgentLeaseRecovery['reason'],record?:AgentLeaseRecord):AgentLeaseRecovery=>({provider,state:'recovery-required',reason,record});
    if(this.initializationError||!['codex','claude-api'].includes(provider))return required('unreadable-record');
    const slot=this.held.get(provider);
    if(slot?.active)return required('active',slot.record);
    let before:AgentLeaseRecord|undefined,captured:Generation|undefined,known:Generation[]=[];
    try{const state=this.directory?this.snapshot(provider):undefined;before=state?.foreign??state?.active?.record??state?.orphan??slot?.record;known=state?.history??[];captured=before?known.find(row=>agentLeaseDigest(row.record)===agentLeaseDigest(before)):undefined;}catch{return required('unreadable-record');}
    if(!before)return {provider,state:'available'};
    if(slot&&agentLeaseDigest(slot.record)!==agentLeaseDigest(before))return required('ownership-changed',before);
    if(!inspectStopped)return required('inspector-required',before);
    try{
      if(!await inspectStopped(before,provider))return required('tree-unconfirmed',before);
    }catch{return required('inspection-failed',before);}
    try{
      if(this.held.get(provider)!==slot)return required('ownership-changed');
      if(this.directory){let generation=captured;
        if(!generation){let state=this.snapshot(provider);generation=state.history.find(row=>agentLeaseDigest(row.record)===agentLeaseDigest(before));
        if(!generation){if(before.generation!==undefined)return required('unreadable-record',before);if(state.active||state.foreign&&agentLeaseDigest(state.foreign)!==agentLeaseDigest(before))return required('ownership-changed',before);try{generation=this.claimGeneration(provider,before,state.history);}catch(error){if(!isAgentLeaseBusy(error))throw error;state=this.snapshot(provider);generation=state.history.find(row=>agentLeaseDigest(row.record)===agentLeaseDigest(before));if(!generation)return required('ownership-changed',before);}}
        }
        this.settle(provider,generation,{kind:'legacy-inspector',recordSha256:agentLeaseDigest(before)});
        if(!before.native){const mirror=this.read(path.join(this.directory,provider+'.json'));if(mirror&&!known.some(row=>agentLeaseDigest(row.record)===agentLeaseDigest(mirror.record))&&agentLeaseDigest(mirror.record)!==agentLeaseDigest(before))return required('ownership-changed',before);}
      }
      if(slot)this.held.delete(provider);
      return {provider,state:'recovered'};
    }catch{return required('unreadable-record');}
  }
  /** Boolean compatibility API; use reconcile when the host needs recovery detail. */
  async recover(provider:LeaseProvider,inspectStopped:AgentLeaseInspector):Promise<boolean>{
    return (await this.reconcile(provider,inspectStopped)).state==='recovered';
  }
}

export type AgentLeaseJournalState={phase:'claimed'}|{phase:'prepared';control:SupervisorControl}|{phase:'armed';control:SupervisorControl;supervisor:SupervisorIdentity};
/** Immutable ordered evidence shared by runtime/development. The slot itself is
 * the durable claimed checkpoint. Neither a PID disappearance nor a terminal
 * text result authorizes armed recovery. Never adopt an armed key from disk. */
export class AgentLeaseJournal {
 readonly directory:string;
 private readonly binding:string;
 constructor(readonly pool:AgentLeasePool,readonly provider:LeaseProvider,readonly record:AgentLeaseRecord){
  if(!pool.directory||!record.native||!uuid.test(record.token)||!['codex','claude-api'].includes(provider))throw Error('A durable native lease is required');nativeClaim(record.native);
  this.directory=path.join(pool.directory,'runs',record.token);if(!fs.existsSync(this.directory))throw Error('Native lease journal is missing');ensureAgentLeaseDirectory(this.directory);this.binding=agentLeaseDigest(record);if(agentLeaseDigest(JSON.parse(regularBytes(path.join(this.directory,'claim.json')).toString('utf8')))!==this.binding)throw Error('Original native lease claim changed');
 }
 private file(phase:string){return path.join(this.directory,phase+'.json');}
 private readCheckpoint(phase:'prepared'|'armed'){
  const raw=regularBytes(this.file(phase)),value=JSON.parse(raw.toString('utf8'));
  if(!exact(value,['schemaVersion','protocol','provider','leaseSha256','phase','previousSha256','value'])||value.schemaVersion!==1||value.protocol!=='capri-native-agent-journal-v1'||value.provider!==this.provider||value.leaseSha256!==this.binding||value.phase!==phase)throw Error('Native lease journal binding changed');return {raw,value};
 }
 private checkControl(control:SupervisorControl){
  const native=this.record.native!;
  if(!control||control.root!==native.controlRoot||control.directory!==path.join(native.controlRoot,native.controlToken)||control.token!==native.controlToken||control.creatorPid!==this.record.pid||control.helperPath!==native.helperPath||control.helperSha256!==native.helperSha256||control.cwdSha256!==native.workspaceSha256||control.scopeSha256!==agentLeaseDigest({provider:this.provider,lease:this.record})||!hex.test(control.requestSha256)||!hex.test(control.commandSha256))throw Error('Prepared lease control differs from its claim');
  const request=regularBytes(path.join(control.directory,'request.json'));if(createHash('sha256').update(request).digest('hex')!==control.requestSha256)throw Error('Prepared control request changed');
 }
 read():AgentLeaseJournalState{
  const head=JSON.parse(regularBytes(this.file('head')).toString('utf8'));if(!exact(head,['schemaVersion','protocol','provider','leaseSha256','phase','checkpointSha256'])||head.schemaVersion!==1||head.protocol!=='capri-native-agent-journal-head-v1'||head.provider!==this.provider||head.leaseSha256!==this.binding||!['claimed','prepared','armed'].includes(head.phase)||!hex.test(head.checkpointSha256))throw Error('Native journal head changed');
  const preparedExists=fs.existsSync(this.file('prepared')),armedExists=fs.existsSync(this.file('armed'));if(head.phase==='claimed'){if(preparedExists||armedExists||head.checkpointSha256!==this.binding)throw Error('Claimed journal ordering changed');return {phase:'claimed'};}if(!preparedExists)throw Error('Native prepared checkpoint missing');
  const prepared=this.readCheckpoint('prepared');if(prepared.value.previousSha256!==this.binding)throw Error('Prepared checkpoint chain changed');const control=prepared.value.value as SupervisorControl;this.checkControl(control);
  if(head.phase==='prepared'){if(armedExists||head.checkpointSha256!==createHash('sha256').update(prepared.raw).digest('hex'))throw Error('Prepared journal ordering changed');return {phase:'prepared',control};}if(!armedExists)throw Error('Native armed checkpoint missing');const armed=this.readCheckpoint('armed');if(head.checkpointSha256!==createHash('sha256').update(armed.raw).digest('hex')||armed.value.previousSha256!==createHash('sha256').update(prepared.raw).digest('hex'))throw Error('Armed checkpoint chain changed');
  const identity=armed.value.value as SupervisorIdentity;if(agentLeaseDigest(Object.fromEntries(Object.keys(control).map(key=>[key,(identity as any)[key]])))!==agentLeaseDigest(control)||identity.armed?.creatorCreated!==this.record.native!.creatorCreated||identity.armed?.creatorPid!==this.record.pid||!hex.test(identity.armedSha256))throw Error('Armed identity differs from claimed creator/control');
  return {phase:'armed',control,supervisor:identity};
 }
 prepare(control:SupervisorControl){if(fs.existsSync(this.file('settled'))||this.read().phase!=='claimed')throw Error('Native preparation already recorded or settled');const head=regularBytes(this.file('head'));this.checkControl(control);const raw=durableNew(this.file('prepared'),{schemaVersion:1,protocol:'capri-native-agent-journal-v1',provider:this.provider,leaseSha256:this.binding,phase:'prepared',previousSha256:this.binding,value:control});durableReplace(this.file('head'),journalHead(this.provider,this.record,'prepared',createHash('sha256').update(raw).digest('hex')),head);if(this.read().phase!=='prepared')throw Error('Prepared checkpoint readback failed');}
 arm(identity:SupervisorIdentity){const before=this.read();if(fs.existsSync(this.file('settled'))||before.phase!=='prepared')throw Error('Native arming lacks prepared ordering or is settled');const head=regularBytes(this.file('head')),previous=regularBytes(this.file('prepared')),raw=durableNew(this.file('armed'),{schemaVersion:1,protocol:'capri-native-agent-journal-v1',provider:this.provider,leaseSha256:this.binding,phase:'armed',previousSha256:createHash('sha256').update(previous).digest('hex'),value:identity});durableReplace(this.file('head'),journalHead(this.provider,this.record,'armed',createHash('sha256').update(raw).digest('hex')),head);const after=this.read();if(after.phase!=='armed'||agentLeaseDigest(after.supervisor)!==agentLeaseDigest(identity))throw Error('Armed checkpoint readback failed');}
 settled(inspection:SupervisorInspection|{state:'not-dispatched';creatorCreated:string}){const value={schemaVersion:1,protocol:'capri-native-agent-settlement-v1',provider:this.provider,leaseSha256:this.binding,inspection};const file=this.file('settled');if(fs.existsSync(file)){if(!regularBytes(file).equals(Buffer.from(JSON.stringify(value))))throw Error('Native settlement changed');return;}durableNew(file,value);}
 isSettled(){
  const file=this.file('settled');if(!fs.existsSync(file))return false;const value=JSON.parse(regularBytes(file).toString('utf8'));if(!exact(value,['schemaVersion','protocol','provider','leaseSha256','inspection'])||value.schemaVersion!==1||value.protocol!=='capri-native-agent-settlement-v1'||value.provider!==this.provider||value.leaseSha256!==this.binding)throw Error('Native settlement binding changed');const state=this.read();
  if(value.inspection?.state==='stopped'){if(state.phase!=='armed'||agentLeaseDigest(inspectSupervisedRun(state.supervisor))!==agentLeaseDigest(value.inspection))throw Error('Native terminal settlement proof changed');return true;}
  if(!exact(value.inspection,['state','creatorCreated'])||value.inspection.state!=='not-dispatched'||value.inspection.creatorCreated!==this.record.native!.creatorCreated||state.phase==='armed'||fs.existsSync(path.join(this.record.native!.controlRoot,this.record.native!.controlToken,'ack.json')))throw Error('No-dispatch settlement changed');return true;
 }
 evidence(){
  if(!this.isSettled())throw Error('Native generation cannot settle without exact lifecycle proof');const state=this.read(),head=regularBytes(this.file('head')),settled=regularBytes(this.file('settled'));
  return {kind:'native-journal-v1',phase:state.phase,journalHeadSha256:createHash('sha256').update(head).digest('hex'),settlementSha256:createHash('sha256').update(settled).digest('hex'),settlement:JSON.parse(settled.toString('utf8')),identity:state.phase==='armed'?state.supervisor:null,terminalEnvelope:state.phase==='armed'?JSON.parse(regularBytes(path.join(state.supervisor.directory,'terminal.json')).toString('utf8')):null};
 }
 uncertain(reason:string){durableNew(this.file('unconfirmed-'+randomUUID()),{schemaVersion:1,provider:this.provider,leaseSha256:this.binding,reason:reason.slice(0,1000)});}
}
/** Windows may report TEMP with an 8.3 ancestor. Resolve only this trusted OS
 * base before deriving the default; arbitrary supplied ownership paths remain
 * strict. Reject reparse ancestors before resolution so a junction cannot be
 * laundered into a trusted root. Keep the existing per-user basename unchanged. */
export function sharedAgentLeaseDirectory(tempRoot=os.tmpdir(),userHome=os.homedir()){
 const proposed=tempRoot.replaceAll('/',path.sep);if(!path.isAbsolute(proposed)||path.resolve(proposed)!==proposed||proposed.includes('\0')||proposed.startsWith('\\\\'))throw Error('Invalid trusted OS temporary directory');
 let current=path.parse(proposed).root;for(const part of path.relative(current,proposed).split(path.sep).filter(Boolean)){current=path.join(current,part);const info=fs.lstatSync(current);if(!info.isDirectory()||info.isSymbolicLink())throw Error('OS temporary directory contains a reparse alias');}
 const canonical=fs.realpathSync.native(proposed);ensureAgentLeaseDirectory(canonical);const userKey=createHash('sha256').update(userHome).digest('hex').slice(0,16);return path.join(canonical,'capri-agent-leases-'+userKey);
}
// Invalid/inaccessible/reparse TEMP disables ONLY shared dispatch. Disabled
// features and explicitly isolated memory hosts may still import this module.
// Keep a disk directory and an explicit error: never fall back to a memory pool.
function defaultSharedAgentLeases(){
 try{return new AgentLeasePool(sharedAgentLeaseDirectory());}
 catch(error){const directory=path.join(os.tmpdir(),'capri-agent-leases-'+createHash('sha256').update(os.homedir()).digest('hex').slice(0,16));return new AgentLeasePool(directory,'Shared agent lease directory is unavailable: '+String((error as Error).message));}
}
export const sharedAgentLeases=defaultSharedAgentLeases();
const exec=promisify(execFile);
const stopping=new WeakMap<ChildProcess,Promise<void>>();
/** Release a lease only after observing close, never merely after requesting kill. */
export async function stopAgentProcess(child:ChildProcess):Promise<void>{
  const existing=stopping.get(child);if(existing)return existing;
  const pending=stopOwnedProcess(child);stopping.set(child,pending);return pending;
}
async function stopOwnedProcess(child:ChildProcess):Promise<void>{
  if(child.exitCode!==null||child.signalCode!==null)return;
  if(!child.pid) return; // spawn failure owns no process
  const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  if(process.platform==='win32')await exec('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000}).catch(()=>{});
  else {try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AgentStopUnconfirmed('Process stop unconfirmed')),5000);})]);}
  finally{clearTimeout(timer);}
}
