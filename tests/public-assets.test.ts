import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,cp,symlink,link,access,realpath} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {deflateSync} from 'node:zlib';
import {clips,type ClipName} from '../src/ui/sprite-state';
import {builtInSprites,clipNames,loadSpriteSheets,sheetGeometry,trustedPackSprites,type SheetImage,type AssetPackSprites} from '../src/ui/asset-pack';
import {AssetPackError,AssetPackManifestSchema,assetPackManifestName,assetPackSprites,importAssetPack,listAssetPacks,loadAssetPack,readAssetPackFile,
  removeAssetPack,resolveAssetPackRequest,safeRelativePath,validatePngSheet,type AssetPackOptions} from '../src/desktop/asset-packs';

// All fixtures are original neutral graphics generated here or by scripts/neutral-assets.mjs. No private asset bytes are read.
type Neutral={neutralClips:Record<string,[number,number]>;CELL_WIDTH:number;CELL_HEIGHT:number;neutralProvenance:{license:string};
  encodePng(width:number,height:number,rgba:Buffer):Buffer;neutralAssetFiles():{character:Map<string,Buffer>;icon:{png:Buffer;ico:Buffer}}};
const neutralModule=pathToFileURL(path.resolve('scripts/neutral-assets.mjs')).href;
let neutral:Neutral;
before(async()=>{neutral=await import(neutralModule);});
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const solidPng=(width:number,height:number,rgba=[56,232,208,255])=>{const raw=Buffer.alloc(width*height*4);for(let i=0;i<raw.length;i+=4)raw.set(rgba,i);return neutral.encodePng(width,height,raw);};
// 2x2 32bpp DIB cursor with hotspot (hx,hy).
function cur(hx=0,hy=0):Buffer{
  const b=Buffer.alloc(22+40+16+8);b.writeUInt16LE(2,2);b.writeUInt16LE(1,4);b[6]=2;b[7]=2;b.writeUInt16LE(hx,10);b.writeUInt16LE(hy,12);
  b.writeUInt32LE(64,14);b.writeUInt32LE(22,18);b.writeUInt32LE(40,22);b.writeInt32LE(2,26);b.writeInt32LE(4,30);b.writeUInt16LE(1,34);b.writeUInt16LE(32,36);b.fill(200,62,78);return b;
}
const riff=(name:string,data:Buffer)=>{const h=Buffer.alloc(8);h.write(name,'latin1');h.writeUInt32LE(data.length,4);return Buffer.concat([h,data,Buffer.alloc(data.length&1)]);};
// Like the pinned pack: header width/height zero and more steps than frames, driven by a sequence chunk.
function ani(sequence=[0,1,0]):Buffer{
  const header=Buffer.alloc(36);header.writeUInt32LE(36,0);header.writeUInt32LE(2,4);header.writeUInt32LE(sequence.length,8);header.writeUInt32LE(5,28);header.writeUInt32LE(3,32);
  const seq=Buffer.alloc(sequence.length*4);sequence.forEach((v,i)=>seq.writeUInt32LE(v,i*4));
  const body=Buffer.concat([Buffer.from('ACON','latin1'),riff('anih',header),riff('seq ',seq),riff('LIST',Buffer.concat([Buffer.from('fram','latin1'),riff('icon',cur()),riff('icon',cur(1,1))]))]);
  return riff('RIFF',body);
}
// Tiny complete sprite set: 8x12 cells, so mouth and idle cells match.
const tinySprites=()=>new Map(clipNames.map(clip=>[clip,solidPng(clips[clip][0]*8,12)]));
async function fixture(root:string,{files=tinySprites() as Map<ClipName,Buffer>,extra=[] as {kind:string;path:string;bytes:Buffer}[],mutate=(m:any)=>m}={}){
  const source=path.join(root,'source-'+Math.random().toString(16).slice(2));await mkdir(path.join(source,'sprites'),{recursive:true});await mkdir(path.join(source,'cursors'),{recursive:true});
  const entries:any[]=[];
  for(const [clip,bytes] of files){await writeFile(path.join(source,'sprites',clip+'.png'),bytes);entries.push({kind:'sprite',clip,path:'sprites/'+clip+'.png',sha256:sha(bytes),bytes:bytes.length});}
  for(const file of extra){await writeFile(path.join(source,...file.path.split('/')),file.bytes);entries.push({kind:file.kind,path:file.path,sha256:sha(file.bytes),bytes:file.bytes.length});}
  const manifest=mutate({schemaVersion:1,name:'Neutral test pack',provenance:{source:'tests/public-assets.test.ts',license:'MIT',author:'Capri tests'},files:entries});
  await writeFile(path.join(source,assetPackManifestName),JSON.stringify(manifest));return source;
}
async function scratch(){const root=await mkdtemp(path.join(os.tmpdir(),'capri-assets-'));return {root,options:{packsRoot:path.join(root,'profile','asset-packs')} as AssetPackOptions};}
const enabled={privateImportsEnabled:true};

test('neutral generator mirrors the sprite state machine clips and produces valid original sheets', ()=>{
  assert.deepEqual(Object.fromEntries(Object.entries(clips).map(([k,[f,fps]])=>[k,[f,fps]])),Object.fromEntries(Object.entries(neutral.neutralClips)));
  const {character,icon}=neutral.neutralAssetFiles();
  for(const clip of clipNames){
    const png=character.get('sprites/'+clip+'.png')!;const {width,height}=validatePngSheet(png);
    assert.equal(height,384);assert.deepEqual(sheetGeometry(clip,width,height),{cell:neutral.CELL_WIDTH,height:neutral.CELL_HEIGHT});
  }
  for(const name of ['idle.png','perch.png','poster.png','chip.png'])assert.ok(validatePngSheet(character.get(name)!).width>0,name);
  const manifest=JSON.parse(character.get('sprites/manifest.json')!.toString());assert.equal(manifest.provenance.license,'MIT');
  for(const clip of clipNames)assert.equal(manifest.clips[clip].sha256,sha(character.get('sprites/'+clip+'.png')!));
  assert.equal(icon.ico.readUInt16LE(2),1);assert.ok(icon.ico.subarray(22).equals(icon.png));
  // Sprites are drawn, not blank: the idle sheet has opaque and transparent pixels.
  assert.ok(new Set(character.get('sprites/idle.png')!.subarray(-64)).size>1);
  // Deterministic: the reviewed output is reproducible byte for byte.
  assert.equal(sha(neutral.neutralAssetFiles().character.get('sprites/glitch.png')!),manifest.clips.glitch.sha256);
});

test('public UI styles do not depend on bundled or missing fonts', async()=>{
  for(const name of (await readdir('src/ui')).filter(n=>n.endsWith('.css'))){
    const css=await readFile(path.join('src/ui',name),'utf8');
    assert.doesNotMatch(css,/@font-face/i,name);assert.doesNotMatch(css,/url\([^)]*\.(woff2?|ttf|otf|eot)/i,name);
  }
});

test('build.mjs keeps the explicit public signal and private behaviour unchanged', async()=>{
  const script=await readFile('scripts/build.mjs','utf8');
  assert.match(script,/process\.env\.CAPRI_PUBLIC_BUILD==='1'/);
  const [, publicBranch='', privateBranch='']=/if\(publicBuild\)\{([\s\S]*?)\n\}else\{([\s\S]*?)\n\}/.exec(script)??[];
  assert.doesNotMatch(publicBranch,/assets\/|android/);assert.match(publicBranch,/writeNeutralAssets/);
  for(const line of ["cp('assets/character','dist/ui/character',{recursive:true})","cp('assets/character','android/app/src/main/assets/character',{recursive:true})","cp('assets/character/chip.png','dist/icon.png')"])assert.ok(privateBranch.includes(line),line);
  assert.match(script,/if\(!publicBuild\)await cp\('assets\/character\/chip\.ico','assets\/icon\.ico'\)/);
});

test('CAPRI_PUBLIC_BUILD=1 builds a runnable neutral desktop output from a checkout without assets, fonts or models', {timeout:180000}, async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'capri-public-build-'));
  try{
    for(const entry of ['src','scripts'])await cp(entry,path.join(root,entry),{recursive:true});
    await cp('package.json',path.join(root,'package.json'));await cp('tsconfig.json',path.join(root,'tsconfig.json'));
    try{await symlink(path.resolve('node_modules'),path.join(root,'node_modules'),'junction');}catch{t.skip('Cannot link node_modules into the temporary checkout.');return;}
    // Restricted leftovers from an earlier private build (original placeholder bytes, not real assets) must not survive.
    const leftovers=['dist/ui/fonts/display.woff2','dist/ui/old-font.ttf','dist/ui/character/capri-motion.gif','dist/ui/character/motion.mp4','dist/ui/character/sprites/legacy.png','dist/voice/designed-a.wav','dist/models/silero_vad.onnx'];
    for(const p of leftovers){await mkdir(path.dirname(path.join(root,p)),{recursive:true});await writeFile(path.join(root,p),'restricted leftover');}
    const run=spawnSync(process.execPath,['scripts/build.mjs'],{cwd:root,env:{...process.env,CAPRI_PUBLIC_BUILD:'1'},encoding:'utf8',timeout:170000});
    assert.equal(run.status,0,run.stderr||run.stdout);
    const exists=(p:string)=>access(path.join(root,p)).then(()=>true,()=>false);
    assert.equal(await exists('assets'),false,'public build must not create or read assets/');
    assert.equal(await exists('android'),false,'public build must not write Android sources');
    for(const p of ['dist/main.cjs','dist/preload.cjs','dist/cloud.cjs','dist/ui/app.js','dist/ui/index.html','dist/icon.png','dist/icon.ico'])assert.ok(await exists(p),p);
    assert.equal(JSON.parse(await readFile(path.join(root,'dist/build-info.json'),'utf8')).assets,'neutral');
    const {character}=neutral.neutralAssetFiles();
    for(const [relative,bytes] of character)assert.ok((await readFile(path.join(root,'dist/ui/character',...relative.split('/')))).equals(bytes),relative);
    assert.deepEqual((await readdir(path.join(root,'dist/ui/character/sprites'))).sort(),[...character.keys()].filter(k=>k.startsWith('sprites/')).map(k=>k.slice(8)).sort());
    // Every sprite URL the renderer requests resolves inside the neutral output, including the static fallback image.
    for(const url of [...Object.values(builtInSprites),'/character/idle.png'])assert.ok(await exists('dist/ui'+url),url);
    // The whole dist is exactly the public allowlist: no seeded leftovers, fonts or media anywhere.
    const walk=async(dir:string,prefix=''):Promise<string[]>=>(await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?walk(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]))).flat();
    const expected=['main.cjs','preload.cjs','cloud.cjs','build-info.json','icon.png','icon.ico','ui/app.js','ui/index.html','ui/mic-worklet.js',...[...character.keys()].map(k=>'ui/character/'+k)];
    const output=await walk(path.join(root,'dist'));
    assert.deepEqual(output.filter(f=>!['ui/app.css','THIRD-PARTY-NOTICES.txt'].includes(f)).sort(),expected.sort());
    for(const p of leftovers)assert.equal(await exists(p),false,p);
    // Cleanup never follows links or leaves this checkout's dist: each refusal happens before anything is deleted.
    const outside=await mkdtemp(path.join(os.tmpdir(),'capri-public-outside-'));
    try{
      await mkdir(path.join(outside,'dist'));await writeFile(path.join(outside,'keep.txt'),'outside');await writeFile(path.join(outside,'dist','keep.txt'),'outside dist');
      const publicRun=(cwd:string,script='scripts/build.mjs')=>spawnSync(process.execPath,[script],{cwd,env:{...process.env,CAPRI_PUBLIC_BUILD:'1'},encoding:'utf8',timeout:170000});
      const intact=async()=>{assert.equal(await readFile(path.join(outside,'keep.txt'),'utf8'),'outside');assert.equal(await readFile(path.join(outside,'dist','keep.txt'),'utf8'),'outside dist');};
      const foreign=publicRun(outside,path.join(root,'scripts','build.mjs'));
      assert.notEqual(foreign.status,0);assert.match(foreign.stderr,/must run from the checkout/);await intact();
      if(await symlink(outside,path.join(root,'dist','ui','linked'),'junction').then(()=>true,()=>false)){
        const nested=publicRun(root);assert.notEqual(nested.status,0);assert.match(nested.stderr,/refuses to clean linked or aliased output/);await intact();
        assert.ok(await exists('dist/main.cjs'),'refused cleanup deletes nothing');
        await rm(path.join(root,'dist'),{recursive:true,force:true});await intact();
        await symlink(outside,path.join(root,'dist'),'junction');
        const aliased=publicRun(root);assert.notEqual(aliased.status,0);assert.match(aliased.stderr,/not a real directory inside this checkout/);await intact();
        await rm(path.join(root,'dist'),{recursive:true,force:true});await intact();
      }
    }finally{await rm(outside,{recursive:true,force:true});}
    // A private font import is refused rather than silently bundled.
    await writeFile(path.join(root,'src/ui/font-probe.woff2'),Buffer.from('not a font'));
    // Built from parts so the public exporter's import-closure scan does not mistake this synthetic module text for a real test import.
    const fontProbeSpecifier='./'+'font-probe.woff2';
    await writeFile(path.join(root,'src/ui/main.tsx'),`import '${fontProbeSpecifier}';\n`+await readFile(path.join(root,'src/ui/main.tsx'),'utf8'));
    const refused=spawnSync(process.execPath,['scripts/build.mjs'],{cwd:root,env:{...process.env,CAPRI_PUBLIC_BUILD:'1'},encoding:'utf8',timeout:170000});
    assert.notEqual(refused.status,0);assert.match(refused.stderr+refused.stdout,/cannot bundle private asset, font/);
    if(await exists('dist'))assert.ok((await walk(path.join(root,'dist'))).every(f=>!/\.(woff2?|ttf|otf)$/.test(f)),'refused build leaves no font output');
  }finally{await rm(root,{recursive:true,force:true});}
});

// Generated PNG structure fixtures: every chunk carries a valid CRC, so only structural rules can reject them.
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;});
function pngChunk(type:string,data:Buffer|number[]=[]):Buffer{
  const body=Buffer.concat([Buffer.from(type,'latin1'),Buffer.from(data)]),out=Buffer.alloc(body.length+8);let crc=0xffffffff;
  for(const v of body)crc=crcTable[(crc^v)&255]^(crc>>>8);out.writeUInt32BE(body.length-4);body.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;
}
function ihdr(width:number,height:number,colorType:number,{depth=8,interlace=0}={}):Buffer{const h=Buffer.alloc(13);h.writeUInt32BE(width);h.writeUInt32BE(height,4);h[8]=depth;h[9]=colorType;h[12]=interlace;return pngChunk('IHDR',h);}
const idat=(rows:number[][])=>pngChunk('IDAT',deflateSync(Buffer.from(rows.flat())));
const png=(...chunks:Buffer[])=>Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),...chunks,pngChunk('IEND')]);

test('PNG validation enforces palette, transparency and chunk-order rules on CRC-valid inputs', ()=>{
  const plte=pngChunk('PLTE',[0,0,0,56,232,208]),indexed=idat([[0,0,1,0,1],[0,1,1,0,0]]),rgba=idat([[0,...Array(8).fill(9)]]);
  const gray=idat([[0,7,7]]),gama=pngChunk('gAMA',[0,0,177,143]),text=pngChunk('tEXt',Buffer.from('Comment\0neutral','latin1'));
  // Positive controls: indexed with palette (+ tRNS/bKGD after it), RGBA with color-space metadata and text, filtered rows.
  for(const ok of [png(ihdr(4,2,3),plte,indexed),png(ihdr(4,2,3),gama,plte,pngChunk('tRNS',[0,255]),pngChunk('bKGD',[1]),pngChunk('pHYs',[0,0,11,19,0,0,11,19,1]),indexed,text),
    png(ihdr(2,1,6),pngChunk('sRGB',[0]),text,rgba,pngChunk('tIME',[7,234,11,5,12,0,0])),png(ihdr(2,1,0),pngChunk('tRNS',[0,7]),gray),
    png(ihdr(2,2,3),plte,idat([[1,1,0],[2,0,0]]))])assert.ok(validatePngSheet(ok).width>0);
  const bad:[string,Buffer][]=[
    ['indexed without PLTE',png(ihdr(4,2,3),indexed)],
    ['PLTE after IDAT',png(ihdr(4,2,3),indexed,plte)],
    ['tRNS before PLTE',png(ihdr(4,2,3),pngChunk('tRNS',[0]),plte,indexed)],
    ['bKGD before PLTE',png(ihdr(4,2,3),pngChunk('bKGD',[0]),plte,indexed)],
    ['gAMA after PLTE',png(ihdr(4,2,3),plte,gama,indexed)],
    ['palette index out of range',png(ihdr(4,2,3),plte,idat([[0,0,1,2,1],[0,0,0,0,0]]))],
    ['filtered index out of range',png(ihdr(2,2,3),plte,idat([[1,1,1],[0,0,0]]))],
    ['empty palette',png(ihdr(4,2,3),pngChunk('PLTE',[]),indexed)],
    ['palette not a multiple of three',png(ihdr(4,2,3),pngChunk('PLTE',[0,0,0,1]),indexed)],
    ['tRNS longer than palette',png(ihdr(4,2,3),plte,pngChunk('tRNS',[0,0,0]),indexed)],
    ['bKGD index outside palette',png(ihdr(4,2,3),plte,pngChunk('bKGD',[2]),indexed)],
    ['PLTE in grayscale',png(ihdr(2,1,0),plte,gray)],
    ['tRNS in RGBA',png(ihdr(2,1,6),pngChunk('tRNS',[0,0,0,0,0,0]),rgba)],
    ['wrong tRNS size for grayscale',png(ihdr(2,1,0),pngChunk('tRNS',[0,0,0,0,0,0]),gray)],
    ['16-bit tRNS sample for 8-bit depth',png(ihdr(2,1,0),pngChunk('tRNS',[1,0]),gray)],
    ['duplicate PLTE',png(ihdr(4,2,3),plte,plte,indexed)],
    ['duplicate gAMA',png(ihdr(2,1,6),gama,gama,rgba)],
    ['sRGB with iCCP',png(ihdr(2,1,6),pngChunk('sRGB',[0]),pngChunk('iCCP',Buffer.from('icc\0\0x','latin1')),rgba)],
    ['invalid sRGB intent',png(ihdr(2,1,6),pngChunk('sRGB',[9]),rgba)],
    ['wrong gAMA size',png(ihdr(2,1,6),pngChunk('gAMA',[0,1]),rgba)],
    ['pHYs after IDAT',png(ihdr(2,1,6),rgba,pngChunk('pHYs',[0,0,0,1,0,0,0,1,0]))],
    ['text keyword missing',png(ihdr(2,1,6),pngChunk('tEXt',Buffer.from('\0x','latin1')),rgba)],
    ['IDAT split by text',png(ihdr(2,2,6),pngChunk('IDAT',deflateSync(Buffer.from([0,...Array(8).fill(1),0,...Array(8).fill(1)])).subarray(0,6)),text,pngChunk('IDAT',deflateSync(Buffer.from([0,...Array(8).fill(1),0,...Array(8).fill(1)])).subarray(6)))],
    ['unknown ancillary chunk',png(ihdr(2,1,6),pngChunk('vpAg',Array(9).fill(0)),rgba)],
    ['IHDR not first',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),text,ihdr(2,1,6),rgba,pngChunk('IEND')])],
    ['16-bit depth',png(ihdr(1,1,6,{depth:16}),idat([[0,...Array(8).fill(1)]]))],
    ['interlaced',png(ihdr(2,1,6,{interlace:1}),rgba)],
    ['bad row filter',png(ihdr(2,1,6),idat([[5,...Array(8).fill(9)]]))],
    ['short image data',png(ihdr(2,2,6),rgba)],
    ['data after IEND',Buffer.concat([png(ihdr(2,1,6),rgba),text])],
  ];
  for(const [name,bytes] of bad)assert.throws(()=>validatePngSheet(bytes),AssetPackError,name);
});

test('import rejects a CRC-valid indexed sprite sheet that lacks its required palette', async()=>{
  const {root,options}=await scratch();
  try{
    const sprites=tinySprites(),width=clips.blink[0]*8,rows=Array.from({length:12},()=>[0,...Array(width).fill(0)]);
    sprites.set('blink',png(ihdr(width,12,3),idat(rows)));
    await assert.rejects(importAssetPack(await fixture(root,{files:sprites}),enabled,options),/palette/);assert.deepEqual(await listAssetPacks(options),[]);
    sprites.set('blink',png(ihdr(width,12,3),pngChunk('PLTE',[56,232,208]),idat(rows)));
    assert.equal((await importAssetPack(await fixture(root,{files:sprites}),enabled,options)).files.length,clipNames.length,'the same sheet with its palette imports');
  }finally{await rm(root,{recursive:true,force:true});}
});

class FakeImage implements SheetImage {
  static sizes=new Map<string,[number,number]|'error'>();static requested:string[]=[];
  width=0;height=0;onload:(()=>void)|null=null;onerror:(()=>void)|null=null;private value='';
  get src(){return this.value;}
  set src(url:string){this.value=url;FakeImage.requested.push(url);const size=FakeImage.sizes.get(url)??[clips[(url.match(/\/(\w+)\.png/)?.[1]??'idle') as ClipName][0]*240,384];
    queueMicrotask(()=>{if(size==='error')this.onerror?.();else{[this.width,this.height]=size;this.onload?.();}});}
}
const packId='pack-'+'a'.repeat(32),revision='b'.repeat(32);
const pack:AssetPackSprites={id:packId,revision,sprites:Object.fromEntries(clipNames.map(c=>[c,'/asset-packs/'+packId+'/sprites/'+c+'.png?v='+revision])) as AssetPackSprites['sprites']};
const load=(p:AssetPackSprites|undefined)=>new Promise<string>(resolve=>loadSpriteSheets(p,()=>new FakeImage(),result=>resolve(result.source)));

test('sprite loader uses a complete trusted pack and otherwise falls back to the built-in set as a whole', async()=>{
  FakeImage.sizes.clear();FakeImage.requested=[];
  assert.equal(await load(pack),'pack');assert.equal(await load(undefined),'built-in');
  FakeImage.sizes.set(pack.sprites.sleep,'error');assert.equal(await load(pack),'built-in');
  FakeImage.sizes.clear();FakeImage.sizes.set(pack.sprites.idle,[1000,384]);assert.equal(await load(pack),'built-in','frame count must divide the sheet');
  FakeImage.sizes.clear();FakeImage.sizes.set(pack.sprites.mouth,[5*200,384]);assert.equal(await load(pack),'built-in','mouth cell must match idle cell');
  FakeImage.sizes.clear();FakeImage.sizes.set(builtInSprites.idle,'error');assert.equal(await load(undefined),'unavailable');
  FakeImage.sizes.clear();
  // Untrusted descriptors never reach the network: partial sets, foreign hosts, traversal and mismatched revisions fall back.
  for(const bad of [{...pack,sprites:{...pack.sprites,idle:'https://example.com/idle.png'}},{...pack,sprites:{...pack.sprites,idle:'/asset-packs/'+packId+'/sprites/../../x.png?v='+revision}},
    {...pack,id:'../etc'},{...pack,revision:'zz'},{...pack,sprites:Object.fromEntries(Object.entries(pack.sprites).slice(1))}]){
    assert.equal(trustedPackSprites(bad),undefined);FakeImage.requested=[];assert.equal(await load(bad as AssetPackSprites),'built-in');
    assert.ok(FakeImage.requested.every(url=>url.startsWith('/character/sprites/')));
  }
});

test('asset paths reject traversal, absolute, alias and device forms', ()=>{
  for(const ok of ['sprites/idle.png','idle.png','a/b/c.cur','cursors/busy-1.ani'])assert.equal(safeRelativePath(ok,ok.endsWith('.png')?'sprite':ok.endsWith('.cur')?'cursor':'animated-cursor'),true,ok);
  for(const bad of ['../idle.png','sprites/../idle.png','/idle.png','C:/idle.png','c:idle.png','sprites\\idle.png','./idle.png','.idle.png','Idle.png','idle.png:evil.png',
    'progra~1/idle.png','con.png','sprites/nul.png','lpt1/idle.png','a/b/c/d.png','idle.png.exe','sprites.d/idle.png','idle.PNG','idle.cur',''])assert.equal(safeRelativePath(bad,'sprite'),false,bad);
});

test('manifest metadata is strict and bounded', ()=>{
  const base={schemaVersion:1,name:'Pack',provenance:{source:'here',license:'MIT'},files:[{kind:'sprite',clip:'idle',path:'idle.png',sha256:'a'.repeat(64),bytes:10}]};
  assert.equal(AssetPackManifestSchema.safeParse(base).success,true);
  const variants=[{...base,schemaVersion:2},{...base,extra:true},{...base,name:''},{...base,name:'bad\u0007name'},{...base,provenance:{source:'here'}},{...base,provenance:{...base.provenance,trust:'approved'}},
    {...base,files:[]},{...base,files:[{...base.files[0],clip:'dance'}]},{...base,files:[{...base.files[0],sha256:'A'.repeat(64)}]},{...base,files:[{...base.files[0],kind:'animated-cursor'}]},
    {...base,files:[{...base.files[0],kind:'script',path:'run.js'}]},{...base,files:[{...base.files[0],bytes:-1}]},{...base,files:[base.files[0],{...base.files[0],path:'other.png'}]},
    {...base,files:[base.files[0],{...base.files[0],clip:'blink'}]},{...base,files:[{...base.files[0],path:'../idle.png'}]}];
  for(const variant of variants)assert.equal(AssetPackManifestSchema.safeParse(variant).success,false,JSON.stringify(variant));
});

test('private import validates, pins and copies a pack that the sprite adapter can serve', async()=>{
  const {root,options}=await scratch();
  try{
    const source=await fixture(root,{extra:[{kind:'cursor',path:'cursors/normal.cur',bytes:cur(1,1)},{kind:'animated-cursor',path:'cursors/busy.ani',bytes:ani()}]});
    await writeFile(path.join(source,'notes.exe'),'MZ unlisted files are ignored and never executed');
    await assert.rejects(importAssetPack(source,{privateImportsEnabled:false},options),/disabled/);
    const pack=await importAssetPack(source,enabled,options);
    assert.match(pack.id,/^pack-[a-f0-9]{32}$/);assert.equal(path.dirname(pack.directory),await realpath(options.packsRoot));
    const record=JSON.parse(await readFile(path.join(pack.directory,'pack.json'),'utf8'));
    assert.equal(record.private,true);assert.equal(record.redistributable,false);assert.equal(record.provenance.license,'MIT');assert.equal(record.files.length,clipNames.length+2);
    assert.ok(!(await readdir(pack.directory)).includes('notes.exe'));
    assert.deepEqual(await listAssetPacks(options),[pack.id]);
    assert.equal((await importAssetPack(source,enabled,options)).id,pack.id,'re-import is idempotent');
    const sprites=assetPackSprites(pack)!;assert.deepEqual(trustedPackSprites(sprites),sprites);
    const idle=resolveAssetPackRequest(pack,'/asset-packs/'+pack.id+'/sprites/idle.png')!;assert.equal(idle.contentType,'image/png');
    assert.ok((await readAssetPackFile(idle)).equals(tinySprites().get('idle')!));
    for(const bad of ['/asset-packs/'+pack.id+'/sprites/../pack.json','/asset-packs/'+pack.id+'/cursors/busy.ani','/asset-packs/pack-'+'0'.repeat(32)+'/sprites/idle.png','/asset-packs/'+pack.id+'/sprites/dance.png'])
      assert.equal(resolveAssetPackRequest(pack,bad),undefined,bad);
    assert.equal((await loadAssetPack(pack.id,{privateImportsEnabled:false},options)).status,'fallback');
    assert.deepEqual(await loadAssetPack('pack-'+'0'.repeat(32),enabled,options),{status:'fallback',reason:'missing'});
    assert.deepEqual(await loadAssetPack('../'+pack.id,enabled,options),{status:'fallback',reason:'invalid'});
    // Corruption after import, or a planted file, falls back instead of rendering unverified bytes.
    await writeFile(path.join(pack.directory,'planted.png'),solidPng(8,12));assert.deepEqual(await loadAssetPack(pack.id,enabled,options),{status:'fallback',reason:'invalid'});
    await rm(path.join(pack.directory,'planted.png'));assert.equal((await loadAssetPack(pack.id,enabled,options)).status,'ready');
    await writeFile(path.join(pack.directory,'sprites','idle.png'),solidPng(16*8,12,[255,0,0,255]));
    assert.deepEqual(await loadAssetPack(pack.id,enabled,options),{status:'fallback',reason:'invalid'});await assert.rejects(readAssetPackFile(idle),/changed/);
    await rm(path.join(pack.directory,'sprites','idle.png'));assert.deepEqual(await loadAssetPack(pack.id,enabled,options),{status:'fallback',reason:'invalid'});
    assert.equal(await removeAssetPack(pack.id,options),true);assert.deepEqual(await listAssetPacks(options),[]);
    // A cursor-only pack imports but keeps the built-in sprites.
    const cursors=await importAssetPack(await fixture(root,{files:new Map(),extra:[{kind:'cursor',path:'cursors/normal.cur',bytes:cur()}]}),enabled,options);
    assert.equal(assetPackSprites(cursors),undefined);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('import rejects hash, content, alias and destination violations without leaving partial packs', async()=>{
  const {root,options}=await scratch();
  try{
    const reject=async(source:string,pattern:RegExp,opts=options)=>{await assert.rejects(importAssetPack(source,enabled,opts),pattern);assert.deepEqual(await listAssetPacks(options),[]);};
    await reject(await fixture(root,{mutate:m=>{m.files[0].sha256='0'.repeat(64);return m;}}),/hash\/size mismatch/);
    await reject(await fixture(root,{mutate:m=>{m.files[0].path='../outside.png';return m;}}),/Invalid asset pack manifest/);
    await reject(await fixture(root,{mutate:m=>{m.trusted=true;return m;}}),/Invalid asset pack manifest/);
    const wrongFrames=tinySprites();wrongFrames.set('idle',solidPng(15*8+3,12));await reject(await fixture(root,{files:wrongFrames}),/does not fit clip/);
    const mismatch=tinySprites();mismatch.set('mouth',solidPng(5*9,12));await reject(await fixture(root,{files:mismatch}),/Mouth overlay/);
    const truncated=tinySprites();truncated.set('blink',truncated.get('blink')!.subarray(0,40));await reject(await fixture(root,{files:truncated}),/./);
    const apng=tinySprites(),base=apng.get('wake')!;const acTL=Buffer.alloc(20);acTL.writeUInt32BE(8);acTL.write('acTL',4);
    { // Insert a CRC-valid APNG control chunk after IHDR.
      const data=Buffer.alloc(8);data.writeUInt32BE(1);const body=Buffer.concat([Buffer.from('acTL'),data]);let crc=0xffffffff;for(const v of body){crc^=v;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
      body.copy(acTL,4);acTL.writeUInt32BE((crc^0xffffffff)>>>0,16);apng.set('wake',Buffer.concat([base.subarray(0,33),acTL,base.subarray(33)]));
    }
    await reject(await fixture(root,{files:apng}),/Unsupported PNG chunk/);
    await reject(await fixture(root,{files:new Map(),extra:[{kind:'cursor',path:'bad.cur',bytes:cur(5,0)}]}),/Invalid cursor/);
    await reject(await fixture(root,{files:new Map(),extra:[{kind:'animated-cursor',path:'bad.ani',bytes:ani([0,2])}]}),/Invalid animated cursor/);
    await reject(await fixture(root,{files:new Map(),extra:[{kind:'cursor',path:'disguised.cur',bytes:solidPng(2,2)}]}),/Invalid cursor/);
    // Case alias: the manifest names sprites/idle.png but the file on disk is IDLE.png.
    const aliased=await fixture(root);await rm(path.join(aliased,'sprites','idle.png'));await writeFile(path.join(aliased,'sprites','IDLE.png'),tinySprites().get('idle')!);
    await reject(aliased,/Aliased asset path|Missing asset file/);
    // Directory junction alias.
    const linked=await fixture(root),real=path.join(root,'elsewhere');await cp(path.join(linked,'sprites'),real,{recursive:true});await rm(path.join(linked,'sprites'),{recursive:true});
    const junction=await symlink(real,path.join(linked,'sprites'),'junction').then(()=>true,()=>false);if(junction)await reject(linked,/Aliased asset path/);
    // Missing manifest or folder.
    const empty=path.join(root,'empty');await mkdir(empty);await reject(empty,/Missing asset file/);await reject(path.join(root,'nope'),/not found/);
    // Destinations inside the source checkout or a protected build/export root are refused.
    const good=await fixture(root);
    await assert.rejects(importAssetPack(good,enabled,{packsRoot:path.resolve('dist','asset-packs-probe')}),/private profile/);
    await assert.rejects(importAssetPack(good,enabled,{...options,protectedRoots:[path.join(root,'profile')]}),/private profile/);
    await assert.rejects(importAssetPack(good,enabled,{packsRoot:path.join(good,'packs')}),/overlap/);
    await assert.rejects(importAssetPack(good,enabled,{packsRoot:'relative/packs'}),/absolute/);
    assert.deepEqual((await readdir(options.packsRoot)).filter(n=>n.startsWith('.import-')),[]);
  }finally{await rm(root,{recursive:true,force:true});await rm(path.resolve('dist','asset-packs-probe'),{recursive:true,force:true});}
});

test('import and reload enforce exact declared sizes per opened file and a cumulative actual byte bound', async()=>{
  const {root,options}=await scratch();
  try{
    const reject=async(source:string,pattern:RegExp,opts=options)=>{await assert.rejects(importAssetPack(source,enabled,opts),pattern);assert.deepEqual(await listAssetPacks(options),[]);
      assert.deepEqual((await readdir(options.packsRoot)).filter(n=>n.startsWith('.import-')),[]);};
    // Underdeclared first file fails on its own size mismatch, before the (missing) second file is ever opened.
    const under=await fixture(root,{mutate:m=>{m.files[0].bytes=10;return m;}});await rm(path.join(under,'sprites',clipNames[1]+'.png'));
    await reject(under,/size mismatch/);
    await reject(await fixture(root,{mutate:m=>{m.files[0].bytes+=1;return m;}}),/size mismatch/);
    // Cumulative actual bytes (manifest/record plus every file) are bounded on import and reload; the exact total passes, one byte less does not.
    const source=await fixture(root),spriteBytes=[...tinySprites().values()].reduce((sum,b)=>sum+b.length,0);
    await reject(source,/total byte bound/,{...options,maxTotalBytes:(await readFile(path.join(source,assetPackManifestName))).length+spriteBytes-1});
    const pack=await importAssetPack(source,enabled,options);
    const storedTotal=(await readFile(path.join(pack.directory,'pack.json'))).length+spriteBytes;
    assert.equal((await loadAssetPack(pack.id,enabled,{...options,maxTotalBytes:storedTotal})).status,'ready');
    assert.deepEqual(await loadAssetPack(pack.id,enabled,{...options,maxTotalBytes:storedTotal-1}),{status:'fallback',reason:'invalid'});
    assert.equal((await loadAssetPack(pack.id,enabled,{...options,maxTotalBytes:Number.MAX_SAFE_INTEGER})).status,'ready','the option cannot raise the built-in bound');
    // Reload and serving reject grown, truncated, same-size-changed, hard-linked and re-aliased stored files.
    const idle=resolveAssetPackRequest(pack,'/asset-packs/'+pack.id+'/sprites/idle.png')!,original=tinySprites().get('idle')!,stored=path.join(pack.directory,'sprites','idle.png');
    const expectChanged=async(pattern:RegExp)=>{assert.deepEqual(await loadAssetPack(pack.id,enabled,options),{status:'fallback',reason:'invalid'});await assert.rejects(readAssetPackFile(idle),pattern);};
    await writeFile(stored,Buffer.concat([original,Buffer.alloc(64)]));await expectChanged(/size mismatch/);
    await writeFile(stored,original.subarray(0,original.length-1));await expectChanged(/size mismatch/);
    const flipped=Buffer.from(original);flipped[flipped.length-20]^=1;await writeFile(stored,flipped);await expectChanged(/changed after import/);
    await writeFile(stored,original);assert.equal((await loadAssetPack(pack.id,enabled,options)).status,'ready');assert.ok((await readAssetPackFile(idle)).equals(original));
    const outsideLink=path.join(root,'hardlink.png');if(await link(stored,outsideLink).then(()=>true,()=>false)){await expectChanged(/not a private regular file/);await rm(outsideLink);}
    const copy=path.join(root,'sprites-copy');await cp(path.join(pack.directory,'sprites'),copy,{recursive:true});await rm(path.join(pack.directory,'sprites'),{recursive:true});
    if(await symlink(copy,path.join(pack.directory,'sprites'),'junction').then(()=>true,()=>false))await expectChanged(/Asset path changed/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('SpriteAvatar keeps one state machine and loads sheets only through the asset-pack adapter', ()=>{
  const source=readFileSync('src/ui/SpriteAvatar.tsx','utf8');
  assert.equal(source.match(/new SpriteState\(\)/g)?.length,1);assert.match(source,/loadSpriteSheets\(assetPack/);
  assert.doesNotMatch(source,/'\/character\/sprites\/'/);assert.doesNotMatch(source,/new Audio|speechSynthesis|AudioContext/);
  assert.match(source,/failed&&<img src="\/character\/idle\.png"/);
});
