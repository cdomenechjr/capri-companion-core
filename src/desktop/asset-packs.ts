import {createHash,randomUUID} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {lstat,mkdir,open,readdir,realpath,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {validateAni,validateCur} from '../extensions/cursor';
import {clipNames,packIdPattern,packSpritePath,sheetGeometry,type AssetPackSprites} from '../ui/asset-pack';
import type {ClipName} from '../ui/sprite-state';

// Original implementation. Privately imported asset packs: user-selected character sprites and cursors that are
// validated, hash-pinned and copied into the private profile. Files are only ever read as bytes and decoded by
// bounded validators; nothing is executed, and imports never enter the source checkout, build output or a public export.
export const assetPackManifestName='capri-asset-pack.json';
const maxManifestBytes=256*1024,maxPngBytes=24*1024*1024,maxCursorBytes=4*1024*1024,maxPackBytes=128*1024*1024,maxFiles=64;
const sha256Pattern=/^[a-f0-9]{64}$/;
const reservedSegment=/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/;
const extensionFor={sprite:'.png',cursor:'.cur','animated-cursor':'.ani'} as const;
export type AssetFileKind=keyof typeof extensionFor;
/** Lowercase relative POSIX paths only: no drive, root, `..`, dot segments, backslashes, colons, `~` short names or device names. */
export function safeRelativePath(value:string,kind:AssetFileKind):boolean{
  if(typeof value!=='string'||value.length>160||!value.endsWith(extensionFor[kind]))return false;
  const segments=value.split('/');
  return segments.length<=3&&segments.every(segment=>/^[a-z0-9][a-z0-9_-]{0,47}(\.(png|cur|ani))?$/.test(segment)&&!reservedSegment.test(segment))&&
    segments.slice(0,-1).every(segment=>!segment.includes('.'));
}
const text=(max:number)=>z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/);
const FileSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('sprite'),clip:z.enum(clipNames as unknown as [ClipName,...ClipName[]]),path:z.string(),sha256:z.string().regex(sha256Pattern),bytes:z.number().int().positive().max(maxPngBytes)}).strict(),
  z.object({kind:z.literal('cursor'),path:z.string(),sha256:z.string().regex(sha256Pattern),bytes:z.number().int().positive().max(maxCursorBytes)}).strict(),
  z.object({kind:z.literal('animated-cursor'),path:z.string(),sha256:z.string().regex(sha256Pattern),bytes:z.number().int().positive().max(maxCursorBytes)}).strict(),
]).refine(file=>safeRelativePath(file.path,file.kind),{message:'Unsafe or mismatched asset path.'});
const ProvenanceSchema=z.object({source:text(512),license:text(128),author:text(128).optional(),notes:text(1024).optional()}).strict();
/** Author-supplied manifest. Its hashes pin content; it never grants trust, settings or redistribution rights. */
export const AssetPackManifestSchema=z.object({schemaVersion:z.literal(1),name:text(64),provenance:ProvenanceSchema,files:z.array(FileSchema).min(1).max(maxFiles)}).strict()
  .superRefine((manifest,context)=>{
    const paths=new Set<string>(),clipsSeen=new Set<string>();let total=0;
    for(const file of manifest.files){
      if(paths.has(file.path))context.addIssue({code:'custom',message:'Duplicate asset path.'});paths.add(file.path);
      if(file.kind==='sprite'){if(clipsSeen.has(file.clip))context.addIssue({code:'custom',message:'Duplicate sprite clip.'});clipsSeen.add(file.clip);}
      total+=file.bytes;
    }
    if(total>maxPackBytes)context.addIssue({code:'custom',message:'Asset pack too large.'});
  });
export type AssetPackManifest=z.infer<typeof AssetPackManifestSchema>;
export type AssetPackFile=AssetPackManifest['files'][number];
const RecordSchema=z.object({schemaVersion:z.literal(1),id:z.string().regex(packIdPattern),name:text(64),provenance:ProvenanceSchema,files:z.array(FileSchema).min(1).max(maxFiles),
  importedAt:z.string().max(40),private:z.literal(true),redistributable:z.literal(false)}).strict();
/** Stored next to the copied files in the private profile; records provenance and the exact pinned hashes. */
export type AssetPackRecord=z.infer<typeof RecordSchema>;
export interface LoadedAssetPack {id:string;name:string;directory:string;record:AssetPackRecord;files:readonly (AssetPackFile&{file:string})[]}
export type AssetPackLoad={status:'ready';pack:LoadedAssetPack}|{status:'fallback';reason:'disabled'|'missing'|'invalid'};
export interface AssetPackOptions {
  /** Absolute private directory inside CAPRI_PROFILE_DIR, e.g. `<profile>/asset-packs`. */
  packsRoot:string;
  /** Source checkout; imports may never land inside it. Defaults to the process working directory. */
  workingTree?:string;
  /** Build/resources/export directories that must never receive imports (dist, packaged resources, public exports). */
  protectedRoots?:readonly string[];
  /** Lowers the cumulative byte bound for one import/reload (manifest plus files); it can never raise the built-in pack limit. */
  maxTotalBytes?:number;
}
export class AssetPackError extends Error {}
function requireValid(ok:unknown,message:string):asserts ok {if(!ok)throw new AssetPackError(message);}
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const inside=(root:string,target:string)=>{const rel=path.relative(root,target);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};

const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const crcTable=Uint32Array.from({length:256},(_,index)=>{let n=index;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;});
function crc32(bytes:Buffer):number {let n=0xffffffff;for(const byte of bytes)n=crcTable[(n^byte)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
// Supported subset: 8-bit, noninterlaced, color types 0/2/3/4/6. Per color type: channels, PLTE rule and exact tRNS/bKGD sizes
// (0 = chunk not allowed). Ancillary chunks are never decompressed or interpreted; APNG and unknown chunks fail closed.
const pngColor:Record<number,{channels:number;palette:'forbidden'|'optional'|'required';trns:number;bkgd:number}>={
  0:{channels:1,palette:'forbidden',trns:2,bkgd:2},2:{channels:3,palette:'optional',trns:6,bkgd:6},3:{channels:1,palette:'required',trns:-1,bkgd:1},
  4:{channels:2,palette:'forbidden',trns:0,bkgd:2},6:{channels:4,palette:'optional',trns:0,bkgd:6},
};
const pngOnce=new Set(['PLTE','tRNS','sRGB','gAMA','cHRM','iCCP','pHYs','bKGD','tIME']);
const pngBeforePalette=new Set(['sRGB','gAMA','cHRM','iCCP']),pngAfterPalette=new Set(['tRNS','bKGD']),pngBeforeData=new Set(['PLTE','tRNS','bKGD','pHYs',...pngBeforePalette]);
const pngText=new Set(['tEXt','zTXt','iTXt']);
/** Latin-1 keyword of 1–79 printable characters terminated by NUL; returns the offset after the NUL. */
function pngKeyword(data:Buffer):number{const nul=data.indexOf(0);requireValid(nul>=1&&nul<=79&&data.subarray(0,nul).every(b=>(b>=32&&b<=126)||b>=161),'Invalid PNG keyword.');return nul+1;}
/** 16-bit sample fields must fit the 8-bit depth (high byte zero). */
const pngSamples=(data:Buffer)=>{for(let i=0;i<data.length;i+=2)requireValid(data[i]===0,'PNG sample out of range.');};
function validatePngMetadata(type:string,data:Buffer,colorType:number,paletteEntries:number){
  const color=pngColor[colorType];
  switch(type){
    case 'PLTE':requireValid(color.palette!=='forbidden'&&data.length>0&&data.length%3===0&&data.length<=768,'Invalid PNG palette.');break;
    case 'tRNS':
      if(colorType===3)requireValid(paletteEntries>0&&data.length>=1&&data.length<=paletteEntries,'Invalid PNG transparency.');
      else{requireValid(color.trns>0&&data.length===color.trns,'Invalid PNG transparency.');pngSamples(data);}
      break;
    case 'bKGD':
      requireValid(data.length===color.bkgd,'Invalid PNG background.');
      if(colorType===3)requireValid(data[0]<paletteEntries,'Invalid PNG background.');else pngSamples(data);
      break;
    case 'gAMA':requireValid(data.length===4&&data.readUInt32BE(0)>0,'Invalid PNG gamma.');break;
    case 'cHRM':requireValid(data.length===32,'Invalid PNG chromaticity.');break;
    case 'sRGB':requireValid(data.length===1&&data[0]<=3,'Invalid PNG sRGB intent.');break;
    case 'iCCP':{const at=pngKeyword(data);requireValid(data[at]===0&&data.length>at+1,'Invalid PNG ICC profile.');break;}
    case 'pHYs':requireValid(data.length===9&&data[8]<=1,'Invalid PNG pixel size.');break;
    case 'tIME':requireValid(data.length===7&&data[2]>=1&&data[2]<=12&&data[3]>=1&&data[3]<=31&&data[4]<=23&&data[5]<=59&&data[6]<=60,'Invalid PNG time.');break;
    case 'tEXt':pngKeyword(data);break;
    case 'zTXt':{const at=pngKeyword(data);requireValid(data[at]===0,'Invalid PNG text.');break;}
    case 'iTXt':{
      const at=pngKeyword(data);requireValid(at+2<=data.length&&data[at]<=1&&data[at+1]===0,'Invalid PNG text.');
      const language=data.indexOf(0,at+2);requireValid(language>=0&&data.indexOf(0,language+1)>=0,'Invalid PNG text.');break;
    }
    default:throw new AssetPackError('Unsupported PNG chunk.');
  }
}
/** Reverses PNG row filters (bit depth 8) so palette indices can be checked against the palette size. */
function unfilterPng(filtered:Buffer,width:number,height:number,bpp:number):Buffer{
  const rowBytes=width*bpp,out=Buffer.alloc(rowBytes*height);
  for(let y=0;y<height;y++){
    const filter=filtered[y*(rowBytes+1)],src=y*(rowBytes+1)+1,row=y*rowBytes,prior=row-rowBytes;
    for(let x=0;x<rowBytes;x++){
      const a=x>=bpp?out[row+x-bpp]:0,b=y>0?out[prior+x]:0,c=x>=bpp&&y>0?out[prior+x-bpp]:0;let predictor=0;
      if(filter===1)predictor=a;else if(filter===2)predictor=b;else if(filter===3)predictor=(a+b)>>1;
      else if(filter===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);predictor=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
      out[row+x]=(filtered[src+x]+predictor)&255;
    }
  }
  return out;
}
/**
 * Bounded 8-bit noninterlaced PNG check: CRCs, IHDR first, spec chunk ordering/multiplicity (palette before data and
 * transparency/background after it, color-space chunks before the palette, contiguous IDAT, IEND last), palette and
 * transparency requirements per color type, exact zlib stream size, row filters and in-range palette indices.
 */
export function validatePngSheet(image:Buffer):{width:number;height:number}{
  requireValid(image.length>=57&&image.length<=maxPngBytes&&image.subarray(0,8).equals(pngSignature),'Invalid PNG.');
  let p=8,width=0,height=0,colorType=-1,paletteEntries=0,metadataBytes=0,ended=false,idatEnded=false;const compressed:Buffer[]=[],seen=new Set<string>();
  while(p<image.length){
    requireValid(!ended&&p+12<=image.length,'Truncated PNG chunk.');const size=image.readUInt32BE(p),end=p+12+size;
    requireValid(size<=0x7fffffff&&end<=image.length,'Invalid PNG chunk bounds.');const type=image.toString('latin1',p+4,p+8),data=image.subarray(p+8,p+8+size);
    requireValid(crc32(image.subarray(p+4,end-4))===image.readUInt32BE(end-4),'PNG CRC mismatch.');
    if(type==='IHDR'){
      requireValid(p===8&&size===13&&data[8]===8&&pngColor[data[9]]!==undefined&&data[10]===0&&data[11]===0&&data[12]===0,'Unsupported PNG encoding.');
      width=data.readUInt32BE(0);height=data.readUInt32BE(4);colorType=data[9];
      requireValid(width>0&&height>0&&width<=32768&&height<=4096&&width*height<=16*1024*1024,'PNG dimensions out of bounds.');
    }else{
      requireValid(colorType>=0,'Missing PNG header.');
      if(type==='IDAT'){
        requireValid(!idatEnded&&size>0,'Invalid PNG data order.');
        requireValid(pngColor[colorType].palette!=='required'||paletteEntries>0,'Indexed PNG requires a palette before image data.');compressed.push(data);
      }else{
        if(compressed.length)idatEnded=true;
        if(type==='IEND'){requireValid(size===0&&compressed.length>0&&end===image.length,'Invalid PNG end.');ended=true;}
        else{
          requireValid(pngText.has(type)||type==='tIME'||pngBeforeData.has(type),'Unsupported PNG chunk.');
          requireValid(!(pngOnce.has(type)&&seen.has(type)),'Duplicate PNG chunk.');
          requireValid(!(pngBeforeData.has(type)&&compressed.length),'Invalid PNG chunk order.');
          requireValid(!(pngBeforePalette.has(type)&&seen.has('PLTE')),'Invalid PNG chunk order.');
          requireValid(!(type==='PLTE'&&[...pngAfterPalette].some(t=>seen.has(t))),'Invalid PNG chunk order.');
          requireValid(!(type==='sRGB'&&seen.has('iCCP'))&&!(type==='iCCP'&&seen.has('sRGB')),'Conflicting PNG color space.');
          metadataBytes+=size;requireValid(metadataBytes<=1024*1024,'PNG metadata too large.');
          validatePngMetadata(type,data,colorType,paletteEntries);
          if(type==='PLTE')paletteEntries=size/3;
          seen.add(type);
        }
      }
    }
    p=end;
  }
  requireValid(ended,'Missing PNG end.');
  const channels=pngColor[colorType].channels,stride=width*channels+1,expected=stride*height,data=Buffer.concat(compressed);let inflated:{buffer:Buffer;engine:{bytesWritten:number}};
  try{inflated=inflateSync(data,{maxOutputLength:expected,info:true}) as unknown as typeof inflated;}catch{throw new AssetPackError('Invalid PNG data stream.');}
  requireValid(inflated.buffer.length===expected&&inflated.engine.bytesWritten===data.length,'PNG decompression size/stream mismatch.');
  for(let y=0;y<height;y++)requireValid(inflated.buffer[y*stride]<=4,'Invalid PNG row filter.');
  if(colorType===3){const indices=unfilterPng(inflated.buffer,width,height,1);for(const index of indices)requireValid(index<paletteEntries,'PNG palette index out of range.');}
  return {width,height};
}
/** Decodes nothing executable: sprites are PNG sheets that fit their clip, cursors are bounded CUR/ANI structures. Returns sprite cell geometry. */
export function validateAssetFile(file:AssetPackFile,bytes:Buffer):{cell:number;height:number}|undefined{
  requireValid(bytes.length===file.bytes&&digest(bytes)===file.sha256,'Asset hash/size mismatch: '+file.path);
  if(file.kind==='sprite'){const {width,height}=validatePngSheet(bytes),geometry=sheetGeometry(file.clip,width,height);requireValid(geometry,'Sprite sheet does not fit clip: '+file.path);return geometry;}
  else if(file.kind==='cursor'){try{validateCur(bytes);}catch{throw new AssetPackError('Invalid cursor: '+file.path);}}
  else{try{validateAni(bytes,file.sha256);}catch{throw new AssetPackError('Invalid animated cursor: '+file.path);}}
  return undefined;
}
/** Validates files one at a time, so each buffer can be released before the next file is read; `finish` applies cross-file rules. */
class SetValidator {
  private geometry=new Map<string,{cell:number;height:number}>();
  add(file:AssetPackFile,bytes:Buffer){const geometry=validateAssetFile(file,bytes);if(file.kind==='sprite'&&geometry)this.geometry.set(file.clip,geometry);}
  finish(){const idle=this.geometry.get('idle'),mouth=this.geometry.get('mouth');requireValid(!idle||!mouth||(idle.cell===mouth.cell&&idle.height===mouth.height),'Mouth overlay cell must match the idle cell.');}
}
/** Cumulative actual bytes read by one import or reload, including the manifest/record. */
interface ByteBudget {remaining:number}
const byteBudget=(options:AssetPackOptions):ByteBudget=>({remaining:Math.min(maxPackBytes+maxManifestBytes,Math.max(0,options.maxTotalBytes??Infinity))});
/** Identity is derived from the pinned content, not from author-chosen names. */
export function assetPackId(manifest:Pick<AssetPackManifest,'name'|'provenance'|'files'>):string{
  const files=[...manifest.files].sort((a,b)=>a.path<b.path?-1:1).map(f=>[f.kind,f.kind==='sprite'?f.clip:'',f.path,f.sha256,f.bytes]);
  const p=manifest.provenance;return 'pack-'+digest(Buffer.from(JSON.stringify([manifest.name,[p.source,p.license,p.author??'',p.notes??''],files]))).slice(0,32);
}
/** `exact` sizes come from the pinned manifest/record and are checked against the opened handle before any allocation. */
type ReadSize={exact:number}|{max:number};
/**
 * Reads one private regular file through a single handle. The path must resolve to itself (no symlink/junction/case/short-name
 * alias) and to the same file identity both before and after open, so a replaced path or parent cannot evade the size/hash checks.
 * Growth or truncation during the read is rejected.
 */
async function privateRead(file:string,label:string,size:ReadSize,budget?:ByteBudget):Promise<Buffer>{
  const fits=(bytes:bigint)=>'exact' in size?bytes===BigInt(size.exact):bytes<=BigInt(size.max);
  const sizeError='Asset size mismatch (file changed or manifest size not exact): '+label;
  const before=await lstat(file,{bigint:true});requireValid(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n,'Asset path is not a private regular file: '+label);
  requireValid(fits(before.size),sizeError);
  const handle=await open(file,'r');try{
    const opened=await handle.stat({bigint:true}),same=(s:typeof opened)=>s.dev===opened.dev&&s.ino===opened.ino;
    requireValid(same(before)&&opened.isFile()&&opened.nlink===1n,'Asset path changed: '+label);requireValid(fits(opened.size),sizeError);
    let real:string;try{real=await realpath(file);}catch{throw new AssetPackError('Asset path changed: '+label);}
    requireValid(real===file&&same(await lstat(file,{bigint:true})),'Asset path changed: '+label);
    const length=Number(opened.size);
    if(budget){requireValid(length<=budget.remaining,'Asset pack exceeds its total byte bound.');budget.remaining-=length;}
    const data=Buffer.alloc(length);let offset=0;
    while(offset<data.length){const read=await handle.read(data,offset,data.length-offset,offset);requireValid(read.bytesRead>0,'Asset file truncated during read: '+label);offset+=read.bytesRead;}
    requireValid((await handle.read(Buffer.alloc(1),0,1,length)).bytesRead===0,'Asset file grew during read: '+label);
    const final=await handle.stat({bigint:true});
    requireValid(same(final)&&final.size===opened.size&&final.mtimeNs===opened.mtimeNs&&final.nlink===1n,'Asset file changed during read: '+label);return data;
  }finally{await handle.close();}
}
/** realpath must equal the lexical join: rejects symlinks/junctions in any component, case aliases and 8.3 short names. */
async function exactFile(root:string,relative:string,size:ReadSize,budget:ByteBudget):Promise<Buffer>{
  const file=path.join(root,...relative.split('/'));let real:string;
  try{real=await realpath(file);}catch{throw new AssetPackError('Missing asset file: '+relative);}
  requireValid(real===file,'Aliased asset path: '+relative);return privateRead(file,relative,size,budget);
}
const limitFor=(file:AssetPackFile)=>file.kind==='sprite'?maxPngBytes:maxCursorBytes;
/** Reads exactly the declared size (never more than the per-kind bound) and validates it before the next file is opened. */
async function readPinned(root:string,file:AssetPackFile,budget:ByteBudget,validator:SetValidator):Promise<Buffer>{
  requireValid(file.bytes<=limitFor(file),'Asset file too large: '+file.path);
  const bytes=await exactFile(root,file.path,{exact:file.bytes},budget);validator.add(file,bytes);return bytes;
}
async function privateRoot(options:AssetPackOptions,create:boolean):Promise<string>{
  requireValid(path.isAbsolute(options.packsRoot),'Asset pack root must be absolute.');
  const guardedRoots=[options.workingTree??process.cwd(),...(options.protectedRoots??[])];
  for(const guarded of guardedRoots)requireValid(!inside(path.resolve(guarded),path.resolve(options.packsRoot)),'Asset packs must stay in the private profile, outside source, build and export trees.');
  if(create)await mkdir(options.packsRoot,{recursive:true,mode:0o700});
  const root=await realpath(options.packsRoot);
  for(const guarded of guardedRoots){
    let real:string;try{real=await realpath(guarded);}catch{real=path.resolve(guarded);}
    requireValid(!inside(real,root)&&!inside(root,real),'Asset packs must stay in the private profile, outside source, build and export trees.');
  }
  return root;
}
async function listTree(directory:string,prefix=''):Promise<string[]>{
  const out:string[]=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const relative=prefix+entry.name;requireValid(!entry.isSymbolicLink(),'Linked entry in asset pack.');
    if(entry.isDirectory())out.push(...await listTree(path.join(directory,entry.name),relative+'/'));else{requireValid(entry.isFile(),'Unexpected asset pack entry.');out.push(relative);}
  }
  return out;
}

/**
 * Validates `sourceFolder/capri-asset-pack.json` and every listed file, then copies them into a new private pack directory.
 * Requires the trusted UI setting `assets.privateImportsEnabled`; never a model/tool argument. Unlisted source files are ignored.
 */
export async function importAssetPack(sourceFolder:string,settings:{privateImportsEnabled:boolean},options:AssetPackOptions):Promise<LoadedAssetPack>{
  requireValid(settings.privateImportsEnabled===true,'Private asset imports are disabled.');
  const root=await privateRoot(options,true);let source:string;
  try{source=await realpath(sourceFolder);}catch{throw new AssetPackError('Asset pack folder not found.');}
  requireValid(!inside(root,source)&&!inside(source,root),'Asset source and private pack paths overlap.');
  const budget=byteBudget(options),raw=await exactFile(source,assetPackManifestName,{max:maxManifestBytes},budget);let parsed:unknown;
  try{parsed=JSON.parse(raw.toString('utf8'));}catch{throw new AssetPackError('Asset pack manifest is not JSON.');}
  const result=AssetPackManifestSchema.safeParse(parsed);requireValid(result.success,'Invalid asset pack manifest.');const manifest=result.data;
  const id=assetPackId(manifest),destination=path.join(root,id);
  const record:AssetPackRecord={schemaVersion:1,id,name:manifest.name,provenance:manifest.provenance,files:manifest.files,importedAt:new Date().toISOString(),private:true,redistributable:false};
  // Each source file is size-checked against its opened handle, read, validated and staged before the next one is opened.
  const stage=path.join(root,'.import-'+randomUUID());await mkdir(stage,{mode:0o700});let existing=false;
  try{
    const write=async(relative:string,data:Buffer)=>{const file=path.join(stage,...relative.split('/'));await mkdir(path.dirname(file),{recursive:true,mode:0o700});const out=await open(file,'wx',0o600);try{await out.writeFile(data);await out.sync();}finally{await out.close();}};
    const validator=new SetValidator();
    for(const file of manifest.files)await write(file.path,await readPinned(source,file,budget,validator));
    validator.finish();
    try{await lstat(destination);existing=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!existing){await write('pack.json',Buffer.from(JSON.stringify(record,null,2)));await rename(stage,destination);}
  }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
  if(existing)await rm(stage,{recursive:true,force:true});
  return requireReady(id,options);
}
async function requireReady(id:string,options:AssetPackOptions):Promise<LoadedAssetPack>{
  const loaded=await loadAssetPack(id,{privateImportsEnabled:true},options);requireValid(loaded.status==='ready','Imported asset pack failed verification.');return loaded.pack;
}
/** Re-verifies the stored record, exact file set and every hash on each load. Never throws: callers keep the built-in fallback. */
export async function loadAssetPack(id:string,settings:{privateImportsEnabled:boolean},options:AssetPackOptions):Promise<AssetPackLoad>{
  if(settings.privateImportsEnabled!==true)return {status:'fallback',reason:'disabled'};
  if(typeof id!=='string'||!packIdPattern.test(id))return {status:'fallback',reason:'invalid'};
  try{
    const root=await privateRoot(options,false),directory=path.join(root,id);
    try{await lstat(directory);}catch{return {status:'fallback',reason:'missing'};}
    requireValid(await realpath(directory)===directory,'Aliased asset pack directory.');
    const budget=byteBudget(options),parsed=RecordSchema.safeParse(JSON.parse((await exactFile(directory,'pack.json',{max:maxManifestBytes},budget)).toString('utf8')));
    requireValid(parsed.success&&parsed.data.id===id&&assetPackId(parsed.data)===id,'Asset pack record mismatch.');const record=parsed.data;
    const listed=new Set(record.files.map(f=>f.path));requireValid(new Set(record.files.map(f=>f.path)).size===record.files.length,'Duplicate asset path.');
    const tree=await listTree(directory);requireValid(tree.length===listed.size+1&&tree.every(entry=>entry==='pack.json'||listed.has(entry)),'Unexpected files in asset pack.');
    const validator=new SetValidator();for(const file of record.files)await readPinned(directory,file,budget,validator);validator.finish();
    return {status:'ready',pack:{id,name:record.name,directory,record,files:Object.freeze(record.files.map(f=>({...f,file:path.join(directory,...f.path.split('/'))})))}};
  }catch{return {status:'fallback',reason:'invalid'};}
}
export async function listAssetPacks(options:AssetPackOptions):Promise<string[]>{
  try{const root=await privateRoot(options,false);return (await readdir(root,{withFileTypes:true})).filter(e=>e.isDirectory()&&packIdPattern.test(e.name)).map(e=>e.name).sort();}catch{return [];}
}
/** User-initiated deletion from the trusted UI. */
export async function removeAssetPack(id:string,options:AssetPackOptions):Promise<boolean>{
  requireValid(packIdPattern.test(id),'Invalid asset pack id.');const root=await privateRoot(options,false),directory=path.join(root,id);
  try{await lstat(directory);}catch{return false;}await rm(directory,{recursive:true,force:true});return true;
}

/**
 * Desktop adapter for final integration: a ready pack with a complete sprite set yields the descriptor that
 * SpriteAvatar's `assetPack` prop accepts. Incomplete sprite sets keep the built-in sprites (cursor-only packs are fine).
 */
export function assetPackSprites(pack:LoadedAssetPack):AssetPackSprites|undefined{
  const sprites=new Map(pack.files.filter(f=>f.kind==='sprite').map(f=>[(f as {clip:ClipName}).clip,f.sha256]));
  if(!clipNames.every(clip=>sprites.has(clip)))return undefined;
  const revision=digest(Buffer.from(clipNames.map(clip=>sprites.get(clip)).join(','))).slice(0,32);
  return {id:pack.id,revision,sprites:Object.freeze(Object.fromEntries(clipNames.map(clip=>[clip,packSpritePath(pack.id,clip)+'?v='+revision]))) as AssetPackSprites['sprites']};
}
/** Maps an authenticated UI GET path (query already stripped) to the pinned sprite file; undefined means 404. */
export function resolveAssetPackRequest(pack:LoadedAssetPack,urlPath:string):(AssetPackFile&{file:string;contentType:'image/png'})|undefined{
  const match=/^\/asset-packs\/(pack-[a-f0-9]{32})\/sprites\/([a-z_]+)\.png$/.exec(urlPath);
  if(!match||match[1]!==pack.id)return undefined;
  const entry=pack.files.find(f=>f.kind==='sprite'&&f.clip===match[2]);return entry?{...entry,file:entry.file,contentType:'image/png'}:undefined;
}
/** Serves bytes only after re-reading the private copy and re-checking its pinned hash. */
export async function readAssetPackFile(entry:AssetPackFile&{file:string}):Promise<Buffer>{
  requireValid(entry.bytes<=limitFor(entry),'Asset file too large.');
  const bytes=await privateRead(entry.file,entry.path,{exact:entry.bytes});requireValid(bytes.length===entry.bytes&&digest(bytes)===entry.sha256,'Asset file changed after import.');return bytes;
}
