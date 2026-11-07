// Offline desktop branch. No service/UI, settings seed, provider, microphone,
// scan scheduler, startup registration or normal application import is needed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store,retainPairedAndroidJournalAcrossRollback} from '../server/store';
import {retainContactJournalAcrossRollback} from '../extensions/contacts';
import {WindowsCursorNative} from '../extensions/cursor';
import {ManagedChannel,managedGeneration,managedHash,readManagedFile,type ManagedTrust} from '../extensions/managed-update-host';
import type {acquireProfileWriter} from './runtime-profile';
import {canonicalJson} from '../extensions/policy';
import {z} from 'zod';

export interface ProtectedStorage {isEncryptionAvailable():boolean;encryptString(value:string):Buffer;decryptString(bytes:Buffer):string}
const File=z.object({path:z.string(),bytes:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const Profile=z.object({schemaVersion:z.literal(1),dataVersion:z.literal(1),files:z.array(File).min(2).max(50000),directories:z.array(z.string()).max(50000)}).strict();
const safeRelative=(value:string)=>{if(!value||value.includes('\\')||value.includes(':')||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$|[<>"|?*\x00-\x1f]/.test(p)))throw Error('Invalid profile entry.');return value;};
const maxProfileBytes=256*1024*1024;
export async function captureClosedProfile(directory:string):Promise<Buffer>{
 const files:z.infer<typeof File>[]=[],directories:string[]=[];let size=0;
 async function visit(dir:string,prefix:string){for(const entry of await fs.readdir(dir,{withFileTypes:true})){
  const name=safeRelative(prefix+entry.name),file=path.join(dir,entry.name),info=await fs.lstat(file);
  if(info.isSymbolicLink()||!info.isDirectory()&&!info.isFile()||info.isFile()&&info.nlink!==1)throw Error('Aliased profile cannot be backed up.');
  if(info.isDirectory()){directories.push(name);await visit(file,name+'/');}
  else{size+=info.size;if(size>maxProfileBytes)throw Error('Complete profile exceeds supported backup bound.');const bytes=await readManagedFile(file,maxProfileBytes);files.push({path:name,bytes:bytes.toString('base64'),sha256:managedHash(bytes)});}
 }}await visit(directory,'');
 files.sort((a,b)=>a.path.localeCompare(b.path));directories.sort();
 return Buffer.from(canonicalJson({schemaVersion:1,dataVersion:1,files,directories}));
}
export function parseClosedProfile(bytes:Uint8Array){
 if(bytes.length>384*1024*1024)throw Error('Profile backup exceeds supported bound.');
 const profile=Profile.parse(JSON.parse(Buffer.from(bytes).toString()));const seen=new Set<string>();let total=0;
 for(const item of [...profile.directories.map(path=>({path,bytes:undefined,sha256:undefined})),...profile.files]){
  safeRelative(item.path);const name=item.path.toLowerCase();if(seen.has(name))throw Error('Profile backup alias.');seen.add(name);
  if(item.bytes!==undefined){const decoded=Buffer.from(item.bytes,'base64');total+=decoded.length;if(decoded.toString('base64')!==item.bytes||managedHash(decoded)!==item.sha256||total>maxProfileBytes)throw Error('Profile backup integrity changed.');}
 }
 const fileNames=new Set(profile.files.map(f=>f.path.toLowerCase()));
 for(const entry of seen){let parent=entry;while(parent.includes('/')){parent=parent.slice(0,parent.lastIndexOf('/'));if(fileNames.has(parent))throw Error('Profile backup path conflict.');}}
 if(!fileNames.has('private.config')||!fileNames.has('data/capri.sqlite'))throw Error('Existing complete profile required.');return profile;
}
export async function restoreClosedProfile(bytes:Uint8Array,directory:string){
 const profile=parseClosedProfile(bytes);await fs.mkdir(directory); // a NEW physical generation; never overwrite failed data.
 for(const dir of profile.directories)await fs.mkdir(path.join(directory,...dir.split('/')),{recursive:true});
 for(const file of profile.files){const target=path.join(directory,...file.path.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});const h=await fs.open(target,'wx',0o600);try{await h.writeFile(Buffer.from(file.bytes,'base64'));await h.sync();}finally{await h.close();}}
 if(!Buffer.from(bytes).equals(await captureClosedProfile(directory)))throw Error('Complete restore readback failed.');
}
export async function openExistingProfile(directory:string,protection:ProtectedStorage){
 if(!protection.isEncryptionAvailable())throw Error('Protected storage unavailable.');
 // Check BOTH required files before Store's creating constructor/init can run.
 const encrypted=await readManagedFile(path.join(directory,'private.config'),1024*1024);await readManagedFile(path.join(directory,'data','capri.sqlite'),maxProfileBytes);
 const vault=JSON.parse(protection.decryptString(encrypted));if(typeof vault.storageKey!=='string'||Buffer.from(vault.storageKey,'base64').length!==32||Buffer.from(vault.storageKey,'base64').toString('base64')!==vault.storageKey)throw Error('Existing vault key invalid.');
 const store=await new Store(path.join(directory,'data'),Buffer.from(vault.storageKey,'base64'),undefined,true).init();
 try{await store.verifyAll();if(!await store.get('settings','main'))throw Error('Existing settings missing.');return store;}catch(error){await store.close();throw error;}
}

/** Testable fixed operations; generation IDs are validated under operator roots.
 * There is deliberately no arbitrary kind/path/eval/command RPC. */
export async function createMaintenanceOperations(options:{trust:ManagedTrust;generation:string;gate:Awaited<ReturnType<typeof acquireProfileWriter>>;protection:ProtectedStorage;restoreCursor?:()=>Promise<boolean>}){
 const {trust,gate,protection}=options;let closed=false;const c=trust.config,source=managedGeneration(c,options.generation);
 await trust.assert();
 if(!gate.owned()||!protection.isEncryptionAvailable())throw Error('Offline protected writer unavailable.');
 const existing=await openExistingProfile(source,protection);await existing.close();
 const ready=async()=>{await trust.assert();if(closed||!gate.owned())throw Error('Maintenance writer ownership lost.');};
 const verify=async(bytes:Buffer)=>{parseClosedProfile(bytes);
  const data=JSON.parse(bytes.toString()) as z.infer<typeof Profile>;
  const vault=JSON.parse(protection.decryptString(Buffer.from(data.files.find(f=>f.path==='private.config')!.bytes,'base64')));
  if(Buffer.from(vault.storageKey??'','base64').length!==32)throw Error('Backup vault key missing.');
  // Verify actual encrypted SQLite records using a temporary generated directory
  // outside every selected generation, then close before removing it.
  const temp=path.join(c.root,'verify-'+randomBytes(16).toString('hex'));await restoreClosedProfile(bytes,temp);
  try{const store=await openExistingProfile(temp,protection);await store.close();}finally{await fs.rm(temp,{recursive:true,force:true});}
  return true;
 };
 let tail:Promise<unknown>=Promise.resolve();
 const operate=async(method:string,input:unknown):Promise<unknown>=>{await ready();
  if(method==='ready'){z.object({}).strict().parse(input);const store=await openExistingProfile(source,protection);try{const settings=await store.get('extension:settings','main');return {dataVersion:1,generation:options.generation,writer:true,automatic:settings?.settings?.updates?.automatic??true};}finally{await store.close();}}
  if(method==='cursor-restored'){z.object({}).strict().parse(input);if(options.restoreCursor)return options.restoreCursor();
   if(managedHash(await readManagedFile(c.windowsHelper.path,512*1024*1024))!==c.windowsHelper.sha256)throw Error('Cursor helper changed.');
   const native=new WindowsCursorNative(c.windowsHelper.path,path.join(c.appData,'capri-runtime','cursor-recovery')),session=await native.arm(15000);const reply=await session.request('close');return reply.ok===true&&!reply.recoveryRequired;
  }
  if(method==='backup-key'){const {initialize}=z.object({initialize:z.boolean()}).strict().parse(input);const file=path.join(c.root,'backup-key.dpapi');let wrapped:Buffer;
   try{wrapped=await readManagedFile(file,65536);}catch(error){if(!initialize||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const key=randomBytes(32);try{const encoded=key.toString('base64');wrapped=protection.encryptString(encoded);if(wrapped.includes(key)||wrapped.includes(Buffer.from(encoded)))throw Error('Backup key was not protected.');const h=await fs.open(file,'wx',0o600);try{await h.writeFile(wrapped);await h.sync();}finally{await h.close();}}finally{key.fill(0);}wrapped=await readManagedFile(file,65536);}
   const value=protection.decryptString(wrapped),key=Buffer.from(value,'base64');try{if(key.length!==32||key.toString('base64')!==value||wrapped.includes(key))throw Error('Protected backup key invalid.');return {key:value};}finally{key.fill(0);}
  }
  if(method==='backup'){z.object({}).strict().parse(input);const store=await openExistingProfile(source,protection);await store.close();const bytes=await captureClosedProfile(source);await verify(bytes);return {dataVersion:1,bytes:bytes.toString('base64')};}
  if(method==='verify'){const {bytes,dataVersion}=z.object({bytes:z.string(),dataVersion:z.literal(1)}).strict().parse(input);return dataVersion===1&&await verify(Buffer.from(bytes,'base64'));}
  if(method==='migrate'){z.object({writeVersion:z.literal(1)}).strict().parse(input);const store=await openExistingProfile(source,protection);await store.close();return {dataVersion:1};}
  if(method==='restore'){const {bytes,generation}=z.object({bytes:z.string(),generation:z.string().uuid()}).strict().parse(input);if(generation===options.generation)throw Error('Fresh restore generation required.');const decoded=Buffer.from(bytes,'base64');await verify(decoded);await restoreClosedProfile(decoded,managedGeneration(c,generation));return {generation,dataVersion:1};}
  if(method==='retain'){const {generation}=z.object({generation:z.string().uuid()}).strict().parse(input);if(generation===options.generation)throw Error('Distinct recovery stores required.');
   const failed=await openExistingProfile(source,protection);let recovered:Store|undefined;
   try{recovered=await openExistingProfile(managedGeneration(c,generation),protection);await retainContactJournalAcrossRollback(failed,recovered);await retainPairedAndroidJournalAcrossRollback(failed,recovered);await recovered.verifyAll();}finally{await recovered?.close();await failed.close();}
   return {retained:true};
  }
  if(method==='journal'){const request=z.object({operation:z.enum(['get','put','list']),generation:z.string().uuid(),kind:z.enum(['contact-outbox','contact-outbox-receipt','contact-outbox-approval','paired-android-receipt']),id:z.string().min(1).max(256).optional(),value:z.record(z.string(),z.unknown()).optional()}).strict().parse(input);
   if(request.operation==='list'&&request.kind!=='paired-android-receipt'||request.operation==='put'&&request.generation===options.generation||request.operation!=='list'&&!request.id||request.operation==='put'&&request.value?.id!==request.id)throw Error('Invalid fixed journal operation.');
   const store=await openExistingProfile(managedGeneration(c,request.generation),protection);
   try{if(request.operation==='list')return store.list(request.kind);if(request.operation==='get')return await store.get(request.kind,request.id!)??null;return await store.put(request.kind,request.value);}finally{await store.close();}
  }
  if(method==='close'){z.object({}).strict().parse(input);closed=true;return {closed:true};}
  throw Error('Unsupported offline operation.');
 };
 return (method:string,input:unknown)=>{const work=tail.then(()=>operate(method,input));tail=work.catch(()=>{});return work;};
}

export async function runUpdateMaintenance(options:{trust:ManagedTrust;gate:Awaited<ReturnType<typeof acquireProfileWriter>>;protection:ProtectedStorage;quit:()=>void}){
 const generation=process.env.CAPRI_MANAGED_GENERATION!,epoch=process.env.CAPRI_MANAGED_EPOCH!;
 const operate=await createMaintenanceOperations({...options,generation});
 const channel=new ManagedChannel(process.stdin,process.stdout,process.env.CAPRI_MANAGED_CHANNEL!,epoch);
 channel.onLost=()=>options.quit();channel.handler=async(method,input)=>{const result=await operate(method,input);if(method==='close')setTimeout(options.quit,20);return result;};
}
