import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {inflateSync} from 'node:zlib';
import {mkdir,open,readdir,realpath,rename,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {CursorSettingsSchema,type CursorSettings,type CursorStatus,type CursorSuspensionReason} from './contracts';

// Original implementation; no upstream code or private asset bytes copied.
// The only approved pack is privately imported, never bundled or exported.
export const approvedCursorHashes:Readonly<Record<string,string>>=Object.freeze({
  'Busy.ani':'5046dc0374455902e2603cb916cf638579bf0d0db57b45f9945bae37eee80773',
  'diagonal resize1.ani':'e8343797bf9faaf6e23c8fced388de303cb37b59571c7d9ae082d258cc6fbcb9',
  'diagonal resize2.ani':'e85baf76669fb418b0c81efbc9dad959f766c7b83c21f19a543f574dacee5e7c',
  'horizontal.ani':'c40ce7a83325409d77d7dc6140d775c63b184e299f5519b428d9bf131c53893e',
  'LinkSelect.ani':'2d09d447892f42097be8f32f4b96694377129faed39b0a889fbd622be3823225',
  'Move.ani':'9f9d18108e0276e4c17e13fbefb6c6804113281a8df50d77b5861e04e913da44',
  'NormalSelect.ani':'97e3e2e41beec976d576a182f5d1a9325aebc497aca2c8f414da826ca7b27e87',
  'text select.ani':'33f2f4d93b3d8f703f83d5d9747d72a299a51ba0ee886dcf898a1b96b5feb2d3',
  'vertical.ani':'3d977a8f2c7404a17e5ea2ed55bccfc16637ea6e38f2029d549892d5f6b88150',
});
export const cursorRoles:Readonly<Record<string,readonly number[]>>=Object.freeze({
  'NormalSelect.ani':[32512],'text select.ani':[32513],'Busy.ani':[32514,32650],
  'diagonal resize1.ani':[32642],'diagonal resize2.ani':[32643],
  'horizontal.ani':[32644],'vertical.ani':[32645],'Move.ani':[32646],'LinkSelect.ani':[32649],
});
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function requireValid(ok:unknown,message:string):asserts ok {if(!ok)throw Error(message);}
const maxFileBytes=4*1024*1024;
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const crcTable=Uint32Array.from({length:256},(_,index)=>{let n=index;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;});
function crc32(bytes:Buffer):number {let n=0xffffffff;for(const byte of bytes)n=crcTable[(n^byte)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
/** Only bounded, noninterlaced 8-bit RGB/RGBA/indexed PNGs reach the Windows decoder.
 * Validate every chunk CRC and the complete zlib stream, including row filters.
 * Compressed metadata, APNG and unknown encodings fail closed. */
function validatePng(image:Buffer,width:number,height:number){
  requireValid(image.length>=57&&image.subarray(0,8).equals(pngSignature),'Invalid cursor PNG.');
  let p=8,channels=0,color=0,palette=0,ended=false,idatEnded=false;const compressed:Buffer[]=[],seen=new Set<string>();
  while(p<image.length){
    requireValid(p+12<=image.length,'Truncated PNG chunk.');const size=image.readUInt32BE(p),end=p+12+size;
    requireValid(end<=image.length,'Invalid PNG chunk bounds.');const type=image.toString('latin1',p+4,p+8),data=image.subarray(p+8,p+8+size);
    requireValid(crc32(image.subarray(p+4,end-4))===image.readUInt32BE(end-4),'PNG CRC mismatch.');
    if(type==='IHDR'){
      requireValid(p===8&&size===13&&data.readUInt32BE(0)===width&&data.readUInt32BE(4)===height&&data[8]===8&&[2,3,6].includes(data[9])&&data[10]===0&&data[11]===0&&data[12]===0,'Unsupported PNG dimensions/encoding.');
      color=data[9];channels=color===6?4:color===2?3:1;
    }else{
      requireValid(channels>0,'Missing PNG header.');
      if(type==='IDAT'){requireValid(!idatEnded&&size>0&&(color!==3||palette>0),'Invalid PNG data order/palette.');compressed.push(data);}
      else{
        if(compressed.length)idatEnded=true;
        if(type==='IEND'){requireValid(size===0&&compressed.length>0&&end===image.length,'Invalid PNG end.');ended=true;}
        else{
          requireValid(!seen.has(type)&&!compressed.length,'Invalid PNG metadata order.');
          if(type==='PLTE'){requireValid(color===3&&size>0&&size<=768&&size%3===0,'Invalid PNG palette.');palette=size/3;}
          else if(type==='tRNS')requireValid(color===3&&palette>0&&size>0&&size<=palette,'Invalid PNG transparency.');
          else requireValid((type==='pHYs'&&size===9&&data[8]<=1)||(type==='gAMA'&&size===4&&data.readUInt32BE(0)>0)||
            (type==='cHRM'&&size===32)||(type==='sRGB'&&size===1&&data[0]<=3),'Unsupported PNG metadata.');seen.add(type);
        }
      }
    }
    p=end;
  }
  requireValid(ended,'Missing PNG end.');const stride=width*channels+1,expected=stride*height,data=Buffer.concat(compressed);
  const inflated=inflateSync(data,{maxOutputLength:expected,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
  requireValid(inflated.buffer.length===expected&&inflated.engine.bytesWritten===data.length,'PNG decompression size/stream mismatch.');
  for(let y=0;y<height;y++)requireValid(inflated.buffer[y*stride]<=4,'Invalid PNG row filter.');
  if(color===3){
    let previous=Buffer.alloc(width);
    for(let y=0;y<height;y++){
      const row=Buffer.alloc(width),filter=inflated.buffer[y*stride];
      for(let x=0;x<width;x++){
        const a=x?row[x-1]:0,b=previous[x],c=x?previous[x-1]:0,p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
        const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):pa<=pb&&pa<=pc?a:pb<=pc?b:c;
        row[x]=(inflated.buffer[y*stride+x+1]+predictor)&255;requireValid(row[x]<palette,'PNG palette index out of bounds.');
      }
      previous=row;
    }
  }
}

/** Supports bounded Windows DIB and validated RGB/RGBA/indexed PNG CUR images.
 * Compressed/extended DIB and unsupported PNG inputs fail closed.
 * All directory entries, pixels, palettes, masks and hotspots are checked. */
export function validateCur(bytes:Buffer):{width:number;height:number}[] {
  requireValid(bytes.length>=22&&bytes.length<=maxFileBytes,'Invalid CUR size.');
  requireValid(bytes.readUInt16LE(0)===0&&bytes.readUInt16LE(2)===2,'Expected CUR.');
  const count=bytes.readUInt16LE(4);requireValid(count>0&&count<=16&&6+16*count<=bytes.length,'Invalid CUR directory.');
  let end=6+16*count;const dimensions:{width:number;height:number}[]=[];
  for(let i=0;i<count;i++){
    const p=6+i*16,w=bytes[p]||256,h=bytes[p+1]||256,size=bytes.readUInt32LE(p+8),offset=bytes.readUInt32LE(p+12);
    requireValid(w<=256&&h<=256&&bytes[p+3]===0&&bytes.readUInt16LE(p+4)<w&&bytes.readUInt16LE(p+6)<h,'Invalid CUR dimensions/hotspot.');
    requireValid(offset===end&&size>=40&&offset+size<=bytes.length,'Invalid CUR image bounds.');
    const image=bytes.subarray(offset,offset+size);
    if(image.subarray(0,8).equals(pngSignature)){
      requireValid(bytes[p+2]===0,'Invalid PNG CUR palette.');validatePng(image,w,h);dimensions.push({width:w,height:h});end=offset+size;continue;
    }
    const bpp=image.readUInt16LE(14);
    requireValid(image.readUInt32LE(0)===40&&image.readInt32LE(4)===w&&image.readInt32LE(8)===h*2&&
      image.readUInt16LE(12)===1&&[1,4,8,24,32].includes(bpp)&&image.readUInt32LE(16)===0,'Unsupported CUR bitmap.');
    const colors=image.readUInt32LE(32),palette=bpp<=8?(colors||2**bpp):0;
    requireValid((bpp<=8?palette<=2**bpp:colors===0)&&(!bytes[p+2]||bytes[p+2]===palette),'Invalid CUR palette.');
    const pixelBytes=Math.ceil(w*bpp/32)*4*h,maskBytes=Math.ceil(w/32)*4*h;
    requireValid(size===40+palette*4+pixelBytes+maskBytes&&[0,pixelBytes,pixelBytes+maskBytes].includes(image.readUInt32LE(20)), 'Invalid CUR pixel/mask size.');
    dimensions.push({width:w,height:h});end=offset+size;
  }
  requireValid(end===bytes.length,'Trailing CUR bytes.');return dimensions;
}

export interface ValidatedAni {sha256:string;frames:number;steps:number;durationMs:number;firstFrame:Buffer}
export function validateAni(bytes:Buffer,expectedSha256:string):ValidatedAni {
  requireValid(/^[a-f0-9]{64}$/.test(expectedSha256)&&bytes.length>=56&&bytes.length<=maxFileBytes,'Invalid ANI size/hash.');
  requireValid(digest(bytes)===expectedSha256,'Cursor SHA-256 mismatch.');
  requireValid(bytes.toString('latin1',0,4)==='RIFF'&&bytes.readUInt32LE(4)===bytes.length-8&&bytes.toString('latin1',8,12)==='ACON','Invalid RIFF ACON.');
  let header:Buffer|undefined,rate:Buffer|undefined,sequence:Buffer|undefined,seenFrames=false;
  const frames:Buffer[]=[];
  function chunks(start:number,end:number,kind:'root'|'frames'|'info'){
    for(let p=start;p<end;){
      requireValid(p+8<=end,'Truncated RIFF chunk.');const id=bytes.toString('latin1',p,p+4),n=bytes.readUInt32LE(p+4),s=p+8,e=s+n;
      requireValid(e+(n&1)<=end,'Invalid RIFF chunk size.');const data=bytes.subarray(s,e);
      if(kind==='info'){requireValid(n<=65536,'Oversize ANI metadata.');}
      else if(kind==='frames'){requireValid(id==='icon'&&frames.length<128,'Invalid ANI frame chunk.');validateCur(data);frames.push(data);}
      else if(id==='anih'){requireValid(!header&&n===36,'Invalid/duplicate ANI header.');header=data;}
      else if(id==='rate'){requireValid(!rate,'Duplicate ANI rate.');rate=data;}
      else if(id==='seq '){requireValid(!sequence,'Duplicate ANI sequence.');sequence=data;}
      else if(id==='LIST'){
        requireValid(n>=4,'Invalid ANI list.');const type=bytes.toString('latin1',s,s+4);
        if(type==='fram'){requireValid(!seenFrames,'Duplicate ANI frames.');seenFrames=true;chunks(s+4,e,'frames');}
        else {requireValid(type==='INFO','Unsupported ANI list.');chunks(s+4,e,'info');}
      }else requireValid(id==='JUNK'&&n<=65536,'Unsupported ANI chunk.');
      p=e+(n&1);
    }
  }
  chunks(12,bytes.length,'root');requireValid(header&&seenFrames,'Missing ANI header/frames.');
  const h=header!,count=h.readUInt32LE(4),steps=h.readUInt32LE(8),width=h.readUInt32LE(12),height=h.readUInt32LE(16),jiffies=h.readUInt32LE(28),flags=h.readUInt32LE(32);
  requireValid(h.readUInt32LE(0)===36&&count>0&&count<=128&&count===frames.length&&steps>0&&steps<=1024,'Invalid ANI frame/step count.');
  requireValid(width<=256&&height<=256&&[0,1,4,8,24,32].includes(h.readUInt32LE(20))&&h.readUInt32LE(24)<=1&&jiffies>=1&&jiffies<=600&&(flags===1||flags===3),'Invalid ANI header bounds.');
  for(const frame of frames)for(const d of validateCur(frame))requireValid((!width||width===d.width)&&(!height||height===d.height),'ANI/CUR dimensions disagree.');
  requireValid((flags===3)===!!sequence&&(!sequence?steps===count:sequence.length===steps*4)&&(!rate||rate.length===steps*4),'Invalid ANI sequence/rate lengths.');
  let total=0,first=0;
  for(let i=0;i<steps;i++){
    const index=sequence?sequence.readUInt32LE(i*4):i,r=rate?rate.readUInt32LE(i*4):jiffies;
    requireValid(index<count&&r>=1&&r<=600,'Invalid ANI sequence/rate value.');if(i===0)first=index;total+=r;
  }
  requireValid(total<=3600,'ANI animation exceeds one minute.');
  return {sha256:expectedSha256,frames:count,steps,durationMs:total*1000/60,firstFrame:Buffer.from(frames[first])};
}

export interface CursorFile {role:number;path:string;sha256:string}
export interface ImportedCursorPack {directory:string;animated:CursorFile[];static:CursorFile[]}
const inside=(root:string,target:string)=>{const rel=path.relative(root,target);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
async function privateRead(file:string):Promise<Buffer>{
  const before=await lstat(file);requireValid(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=maxFileBytes,'Cursor path is not a private regular file.');
  const handle=await open(file,'r');try{
    const after=await handle.stat();requireValid(before.dev===after.dev&&before.ino===after.ino&&after.isFile()&&after.nlink===1&&after.size<=maxFileBytes,'Cursor path changed.');
    const data=Buffer.alloc(after.size);let offset=0;
    while(offset<data.length){const read=await handle.read(data,offset,data.length-offset,offset);requireValid(read.bytesRead>0,'Cursor file truncated.');offset+=read.bytesRead;}
    const final=await handle.stat();requireValid(final.size===after.size&&final.mtimeMs===after.mtimeMs,'Cursor file changed during read.');return data;
  }finally{await handle.close();}
}

/** Construct only from trusted host configuration: cacheRoot belongs to the private
 * CAPRI_PROFILE_DIR, outside the source/public export tree. Hash overrides are for
 * neutral fixtures or separately operator-reviewed packs, never model input. */
export class PrivateCursorCache {
  constructor(readonly cacheRoot:string,private readonly hashes:Readonly<Record<string,string>>=approvedCursorHashes){
    requireValid(path.isAbsolute(cacheRoot),'Cursor cache must be absolute.');
    requireValid(path.resolve(cacheRoot)!==process.cwd()&&!inside(process.cwd(),path.resolve(cacheRoot)),'Cursor cache must be outside the working tree.');
    requireValid(Object.keys(hashes).every(k=>Object.hasOwn(cursorRoles,k)&&/^[a-f0-9]{64}$/.test(hashes[k])),'Invalid approved cursor list.');
    this.hashes=Object.freeze({...hashes});
  }
  async importFolder(selectedFolder:string):Promise<ImportedCursorPack>{
    await mkdir(this.cacheRoot,{recursive:true,mode:0o700});const root=await realpath(this.cacheRoot),source=await realpath(selectedFolder),workingTree=await realpath(process.cwd());
    requireValid(root!==workingTree&&!inside(workingTree,root),'Cursor cache aliases the working tree.');
    requireValid(root!==source&&!inside(root,source)&&!inside(source,root),'Cursor source/cache paths overlap.');
    const names=await readdir(source),chosen:string[]=[];
    for(const name of names){const approved=Object.keys(cursorRoles).find(k=>k.toLowerCase()===name.toLowerCase());
      if(approved){requireValid(approved===name&&Object.hasOwn(this.hashes,name),'Unapproved or aliased cursor filename.');chosen.push(name);}}
    requireValid(chosen.length>0,'No approved cursor files.');
    const stage=path.join(root,'.import-'+randomUUID()),destination=path.join(root,'pack-'+randomUUID());await mkdir(stage,{mode:0o700});
    try{
      for(const name of chosen){
        const file=path.join(source,name);requireValid(await realpath(file)===file,'Cursor file alias.');
        const bytes=await privateRead(file),ani=validateAni(bytes,this.hashes[name]);
        for(const [suffix,data] of [['',bytes],['.cur',ani.firstFrame]] as const){const out=await open(path.join(stage,name+suffix),'wx',0o600);try{await out.writeFile(data);await out.sync();}finally{await out.close();}}
      }
      await rename(stage,destination);return await this.load(destination);
    }catch(error){await rm(stage,{recursive:true,force:true});await rm(destination,{recursive:true,force:true});throw error;}
  }
  async load(directory:string):Promise<ImportedCursorPack>{
    const root=await realpath(this.cacheRoot),dir=await realpath(directory),workingTree=await realpath(process.cwd());
    requireValid(root!==workingTree&&!inside(workingTree,root),'Cursor cache aliases the working tree.');
    requireValid(path.dirname(dir)===root&&/^pack-[a-f0-9-]{36}$/.test(path.basename(dir)),'Cursor pack is outside private cache.');
    const names=(await readdir(dir)).sort(),animated:CursorFile[]=[],staticFiles:CursorFile[]=[];
    for(const name of names){
      if(name.endsWith('.ani.cur'))continue;
      requireValid(Object.hasOwn(cursorRoles,name)&&Object.hasOwn(this.hashes,name),'Unapproved cache file.');
      const file=path.join(dir,name);requireValid(await realpath(file)===file,'Aliased cached cursor.');
      const ani=validateAni(await privateRead(file),this.hashes[name]),staticPath=file+'.cur',first=await privateRead(staticPath);
      requireValid(first.equals(ani.firstFrame),'Static cursor mismatch.');
      for(const role of cursorRoles[name]){animated.push({role,path:file,sha256:ani.sha256});staticFiles.push({role,path:staticPath,sha256:digest(first)});}
    }
    requireValid(animated.length>0&&names.length===new Set(animated.map(f=>f.path)).size*2,'Incomplete or unexpected cache files.');
    return {directory:dir,animated,static:staticFiles};
  }
}

/** Read-only native cursor-status/heartbeat observations. Null means unavailable.
 * Native-size resources do not yet support accessible scaling/contrast adaptation. */
export interface CursorAccessibility {compatible:boolean;highContrast:boolean|null;pointerBaseSize:number|null;pointerSize:number|null}
const accessibilityCompatible=(a:CursorAccessibility)=>a.compatible===true&&a.highContrast===false&&a.pointerBaseSize===32&&a.pointerSize===1;
const boundedSizeOrNull=(value:unknown,maximum:number)=>value===null||(typeof value==='number'&&Number.isInteger(value)&&value>=1&&value<=maximum);
function validAccessibility(value:unknown):value is CursorAccessibility {
  if(!value||typeof value!=='object')return false;const a=value as CursorAccessibility;
  return typeof a.compatible==='boolean'&&(a.highContrast===null||typeof a.highContrast==='boolean')&&
    boundedSizeOrNull(a.pointerBaseSize,256)&&boundedSizeOrNull(a.pointerSize,15);
}
export interface CursorNativeReply {ok:boolean;reason?:'owner-conflict'|'locked'|'accessibility'|'host-unavailable';watchdogExpiresAt?:number;recovered?:boolean;recoveryRequired?:boolean;active?:boolean;accessibility?:CursorAccessibility}
export interface CursorNativeSession {readonly recovered?:boolean;request(action:'heartbeat'|'apply'|'restore'|'status'|'close',files?:CursorFile[]):Promise<CursorNativeReply>}
export interface CursorNative {arm(leaseMs:number):Promise<CursorNativeSession>}

/** Real native transport. No shell, installers, registry schemes, pointer movement,
 * or desktop startup wiring. The independent watchdog holds the logon mutex and
 * marker before acknowledging arm; it restores on EOF, parent exit or lease expiry.
 * markerDirectory MUST be one stable per-user private directory shared by ALL
 * development/runtime profiles, never CAPRI_PROFILE_DIR. Native marker names add
 * the actual logon authentication ID and Windows session; do not add a profile ID. */
export class WindowsCursorNative implements CursorNative {
  constructor(private readonly helper:string,private readonly markerDirectory:string){}
  async arm(leaseMs:number):Promise<CursorNativeSession>{
    requireValid(process.platform==='win32'&&path.isAbsolute(this.helper)&&path.isAbsolute(this.markerDirectory),'Windows cursor host unavailable.');
    const child=spawn(this.helper,['--cursor-watchdog'],{windowsHide:true,detached:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();
    const lines=createInterface({input:child.stdout});let failed=false,serial=0;
    const pending=new Map<number,{resolve:(reply:CursorNativeReply)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
    const fail=()=>{failed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Cursor watchdog unavailable.'));}pending.clear();};
    child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);
    lines.on('line',line=>{
      if(line.length>4096){fail();child.stdin.end();return;}
      try{
        const value=JSON.parse(line),p=pending.get(value.id);if(!p)return;
        const validExpiry=value.watchdogExpiresAt==null||(Number.isSafeInteger(value.watchdogExpiresAt)&&value.watchdogExpiresAt>=0);
        requireValid(typeof value.ok==='boolean'&&validExpiry&&[undefined,null,'owner-conflict','locked','accessibility','host-unavailable'].includes(value.reason),'Invalid cursor receipt.');
        requireValid(value.accessibility===undefined||validAccessibility(value.accessibility),'Invalid cursor accessibility receipt.');
        for(const flag of ['recovered','recoveryRequired','active'])requireValid(value[flag]===undefined||typeof value[flag]==='boolean','Invalid cursor receipt.');
        const reply:CursorNativeReply={ok:value.ok};
        if(value.reason)reply.reason=value.reason;
        if(value.accessibility!==undefined)reply.accessibility={...value.accessibility};
        if(value.watchdogExpiresAt!=null)reply.watchdogExpiresAt=value.watchdogExpiresAt;
        for(const flag of ['recovered','recoveryRequired','active'] as const)if(value[flag]!==undefined)reply[flag]=value[flag];
        pending.delete(value.id);clearTimeout(p.timer);p.resolve(reply);
      }catch{fail();child.stdin.end();}
    });
    function request(action:string,files?:CursorFile[]):Promise<CursorNativeReply>{
      if(failed)return Promise.reject(Error('Cursor watchdog unavailable.'));
      return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('Cursor watchdog response timed out.'));child.stdin.end();},5000);
        pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,action,files,ownerPid:process.pid,leaseMs,markerDirectory:thisMarker})+'\n');});
    }
    const thisMarker=this.markerDirectory;
    const ready=await request('arm');if(!ready.ok){child.stdin.end();throw new CursorHostError(ready);}
    return {recovered:ready.recovered,request:async(action,files)=>{const reply=await request(action,files);if(action==='close')child.stdin.end();return reply;}};
  }
}
export class CursorHostError extends Error {constructor(readonly reply:CursorNativeReply){super('Cursor host could not acquire recovery ownership.');}}

export interface CursorEnvironment {gameDocked:boolean;locked:boolean;reducedMotion:boolean;accessibility?:CursorAccessibility}
/** Host-only API: import -> enable(cache directory, parsed UI settings, fresh host
 * environment); updateEnvironment on presence/accessibility changes; stop on Stop,
 * disable and Quit. Never expose raw native commands or hash overrides as tools.
 * Hub wiring: read helper {action:'cursor-status',args:{}} without --cursor-watchdog,
 * map !unlocked to locked and copy its accessibility object into the environment.
 * Refresh those observations on accessibility/presence changes, including while
 * suspended. Unknown native accessibility fields are null/compatible:false.
 * Legacy environments may omit accessibility: the watchdog still independently
 * checks it before each mutation and every 50 ms, reporting 'accessibility' on its
 * heartbeat/status. Display that reason as preserving Windows accessibility pointers;
 * scaling and contrast adaptation are not supported. Recovery is reported separately.
 * No replay after faults/trial expiry; a fresh enable is required. */
export class CursorController {
  private session?:CursorNativeSession;private pack?:string;private settings?:CursorSettings;
  private environment:CursorEnvironment={gameDocked:false,locked:false,reducedMotion:false};
  private current:CursorStatus={state:'inactive',recoveryAvailable:false};private timer?:ReturnType<typeof setInterval>;
  private expiresAt?:number;private queue:Promise<unknown>=Promise.resolve();
  private recovery:'none'|'restored'|'required'='none';
  constructor(private readonly cache:PrivateCursorCache,private readonly native:CursorNative,private readonly now=Date.now){}
  status():CursorStatus{return {...this.current};}
  recoveryStatus():'none'|'restored'|'required'{return this.current.state==='recovery-required'?'required':this.recovery;}
  private serialized<T>(operation:()=>Promise<T>):Promise<T>{const next=this.queue.then(operation);this.queue=next.catch(()=>{});return next;}
  /** Call on the next desktop launch even when the enabled preference is false.
   * Acquires exclusive recovery ownership, restores a stale marker, then releases.
   * A competing live owner is observed, never forcibly restored or displaced. */
  recover():Promise<CursorStatus>{return this.serialized(async()=>{
    if(this.session)return this.status();
    try{this.session=await this.native.arm(15000);if(this.session.recovered)this.recovery='restored';await this.release();}
    catch(error){const reason=error instanceof CursorHostError?error.reply.reason:undefined;
      this.current=reason==='owner-conflict'?{state:'suspended',suspensionReason:reason,recoveryAvailable:true}:{state:'recovery-required',recoveryAvailable:true};}
    return this.status();
  });}
  enable(directory:string,input:CursorSettings,environment:CursorEnvironment):Promise<CursorStatus>{return this.serialized(async()=>{
    await this.close();this.settings=CursorSettingsSchema.parse(input);this.environment=this.copyEnvironment(environment);
    if(!this.settings.enabled)return this.status();
    this.pack=(await this.cache.load(directory)).directory;this.expiresAt=this.settings.durationMs?this.now()+this.settings.durationMs:undefined;
    await this.refresh();
    if(this.settings&&this.current.state!=='recovery-required'){
      this.timer=setInterval(()=>{void this.tick();},Math.max(100,Math.floor(this.settings.watchdogLeaseMs/3)));this.timer.unref?.();
    }
    return this.status();
  });}
  updateEnvironment(environment:CursorEnvironment):Promise<CursorStatus>{return this.serialized(async()=>{
    const before=this.environment.accessibility,after=environment.accessibility;
    const changed=this.environment.gameDocked!==environment.gameDocked||this.environment.locked!==environment.locked||this.environment.reducedMotion!==environment.reducedMotion||
      before?.compatible!==after?.compatible||before?.highContrast!==after?.highContrast||before?.pointerBaseSize!==after?.pointerBaseSize||before?.pointerSize!==after?.pointerSize;
    this.environment=this.copyEnvironment(environment);if(this.settings&&(changed||this.current.state==='suspended'))await this.refresh();return this.status();
  });}
  tick():Promise<CursorStatus>{return this.serialized(async()=>{
    if(!this.settings)return this.status();
    if(this.expiresAt!==undefined&&this.now()>=this.expiresAt){await this.close();return this.status();}
    try{if(this.session){const r=await this.session.request('heartbeat'),incompatible=r.accessibility!==undefined&&!accessibilityCompatible(r.accessibility);if(!r.ok||incompatible){
        const reason=r.reason??(incompatible?'accessibility':undefined);
        if((reason==='locked'||reason==='accessibility')&&!r.recoveryRequired){await this.release();if(this.current.state!=='recovery-required')this.current={state:'suspended',suspensionReason:reason,recoveryAvailable:true};return this.status();}
        throw new CursorHostError(r);
      }this.current={...this.current,watchdogExpiresAt:r.watchdogExpiresAt};}
      else if(this.current.state==='suspended')await this.refresh();
    }catch{await this.fault();}return this.status();
  });}
  stop():Promise<CursorStatus>{return this.serialized(async()=>{await this.close();return this.status();});}
  private copyEnvironment(environment:CursorEnvironment):CursorEnvironment{return {...environment,...(environment.accessibility?{accessibility:{...environment.accessibility}}:{})};}
  private reason():CursorSuspensionReason|undefined{
    if(this.environment.locked)return 'locked';if(this.environment.gameDocked)return 'game-docked';
    if(this.environment.accessibility&&!accessibilityCompatible(this.environment.accessibility))return 'accessibility';
    if(this.settings?.intensity===0)return 'intensity-zero';return undefined;
  }
  private async refresh(){
    if(this.expiresAt!==undefined&&this.now()>=this.expiresAt){await this.close();return;}
    const reason=this.reason();
    if(reason){await this.release();if(this.current.state!=='recovery-required')this.current={state:'suspended',suspensionReason:reason,recoveryAvailable:true};return;}
    let dispatched=false;
    try{
      const pack=await this.cache.load(this.pack!); // Revalidate every resume, including static first-frame bytes.
      this.session??=await this.native.arm(this.settings!.watchdogLeaseMs);
      if(this.session.recovered)this.recovery='restored';
      dispatched=true;
      const reply=await this.session.request('apply',this.environment.reducedMotion?pack.static:pack.animated);
      if(!reply.ok)throw new CursorHostError(reply);
      if(reply.accessibility!==undefined&&!accessibilityCompatible(reply.accessibility))throw new CursorHostError({...reply,ok:false,reason:'accessibility'});
      this.current={state:'active',watchdogExpiresAt:reply.watchdogExpiresAt,recoveryAvailable:true,...(this.expiresAt===undefined?{}:{expiresAt:this.expiresAt})};
    }catch(error){
      await this.release();
      if(this.current.state==='recovery-required'){this.halt();return;}
      const reply=error instanceof CursorHostError?error.reply:undefined;
      if(!reply&&dispatched){this.halt();this.recovery='restored';} // close has confirmed restoration; never replay the unconfirmed apply.
      if(reply?.recoveryRequired){this.halt();this.current={state:'recovery-required',recoveryAvailable:true};return;}
      if(reply?.reason==='host-unavailable')this.halt(); // A rejected/rolled-back apply needs a fresh explicit enable.
      this.current={state:'suspended',suspensionReason:reply?.reason??(this.environment.reducedMotion?'reduced-motion':'host-unavailable'),recoveryAvailable:true};
    }
  }
  private async release(){
    const session=this.session;this.session=undefined;if(!session)return;
    try{const r=await session.request('close');if(!r.ok)throw Error();this.current={state:'inactive',recoveryAvailable:true};}
    catch{this.current={state:'recovery-required',recoveryAvailable:true};}
  }
  private async fault(){await this.close();this.current={state:'recovery-required',recoveryAvailable:true};}
  private halt(){if(this.timer)clearInterval(this.timer);this.timer=undefined;this.settings=undefined;}
  private async close(){if(this.timer)clearInterval(this.timer);this.timer=undefined;this.settings=undefined;this.pack=undefined;this.expiresAt=undefined;await this.release();if(this.current.state!=='recovery-required')this.current={state:'inactive',recoveryAvailable:this.current.recoveryAvailable};}
}
