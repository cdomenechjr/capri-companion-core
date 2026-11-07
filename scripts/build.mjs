import { build } from 'esbuild';
import { mkdir, cp, writeFile, readFile, access, rm, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { writeNeutralAssets } from './neutral-assets.mjs';
// CAPRI_PUBLIC_BUILD=1 builds the sanitized MIT public core: neutral code-generated graphics only. It never reads
// assets/, fonts, voice or models (no private fallback) and never writes generated Android sources into the checkout.
const publicBuild=process.env.CAPRI_PUBLIC_BUILD==='1';
const restrictedRoots=[path.resolve('assets'),path.resolve('models')];
const publicGuard={name:'capri-public-assets-guard',setup(b){b.onLoad({filter:/.*/},args=>{
 const file=path.resolve(args.path);
 if(restrictedRoots.some(root=>file===root||file.startsWith(root+path.sep))||/\.(woff2?|ttf|otf|eot|onnx|mp4|webm|wav|mp3|ogg)$/i.test(file))return {errors:[{text:'CAPRI_PUBLIC_BUILD=1 cannot bundle private asset, font, voice or model file: '+path.relative(process.cwd(),file)}]};
 return undefined;
});}};
// Public output is an exact allowlist: bundles, static UI files, neutral graphics, icons, notices and build info. Anything
// else (earlier private fonts, media, character art) fails the build and the whole dist is removed so it cannot be packaged.
const publicOutputFiles=['main.cjs','preload.cjs','cloud.cjs','build-info.json','icon.png','icon.ico','THIRD-PARTY-NOTICES.txt','ui/app.js','ui/app.css','ui/index.html','ui/mic-worklet.js'];
async function outputFiles(dir,prefix=''){const out=[];for(const entry of await readdir(dir,{withFileTypes:true})){const relative=prefix+entry.name;if(entry.isDirectory()&&!entry.isSymbolicLink())out.push(...await outputFiles(path.join(dir,entry.name),relative+'/'));else out.push(relative);}return out;}
async function enforcePublicOutput(characterFiles){
 const allowed=new Set([...publicOutputFiles,...characterFiles.map(file=>'ui/character/'+file)]),unexpected=(await outputFiles('dist')).filter(file=>!allowed.has(file));
 if(unexpected.length){await removePublicDist();throw Error('CAPRI_PUBLIC_BUILD=1 output contains non-allowlisted files: '+unexpected.join(', '));}
}
// Recursive public cleanup only ever targets this checkout's own dist: the build must run from the checkout containing this
// script, and dist plus every entry under it must be a real path strictly inside it. Symlinks/junctions are refused, not followed.
const checkoutRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const strictlyInside=(parent,child)=>{const relative=path.relative(parent,child);return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
// Inspect the spelling supplied by the caller BEFORE realpath can hide a junction.
// A missing tail is safe to append to the nearest checked physical ancestor; Windows
// 8.3 names and case differences alone are not links and normalize at that boundary.
async function directoryAncestors(directory,allowMissing=false){
 if(!path.isAbsolute(directory))throw Error('Runtime resource output must be an absolute directory.');
 let current=path.parse(directory).root,nearest=current;const tail=[];
 const rootInfo=await lstat(current);
 if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw Error('Runtime resource output is not a real directory inside this checkout (linked or non-directory ancestor).');
 for(const part of path.relative(current,directory).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  if(tail.length){tail.push(part);continue;}
  let info;try{info=await lstat(current);}catch(error){if(allowMissing&&error.code==='ENOENT'){tail.push(part);continue;}throw error;}
  if(info.isSymbolicLink()||!info.isDirectory())throw Error('Runtime resource output is not a real directory inside this checkout (linked or non-directory ancestor).');
  nearest=current;
 }
 return {nearest,tail};
}
async function resolveOutputDirectory(directory,allowMissing=false){
 // Complete all lstat walks before resolving any of the paths.
 const checkout=await directoryAncestors(checkoutRoot),cwd=await directoryAncestors(process.cwd()),output=await directoryAncestors(directory,allowMissing);
 const root=await realpath(checkout.nearest),workingRoot=await realpath(cwd.nearest);
 if(root!==workingRoot)throw Error('CAPRI_PUBLIC_BUILD=1 must run from the checkout that contains scripts/build.mjs.');
 const physical=path.join(await realpath(output.nearest),...output.tail);
 if(!strictlyInside(root,physical))throw Error('Runtime resource output must be a real directory in this checkout.');
 return physical;
}
async function assertRuntimeOutput(directory){
 const physical=await resolveOutputDirectory(directory);
 await assertRealTree(physical,physical);
 return physical;
}
export async function prepareRuntimeOutput(directory=path.resolve('native/publish')){
 const physical=await resolveOutputDirectory(directory,true);
 let existing;try{existing=await lstat(physical);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(existing)await assertRuntimeOutput(physical);
 await mkdir(physical,{recursive:true});
 return assertRuntimeOutput(physical);
}
async function assertRealTree(dir,distRoot){
 for(const entry of await readdir(dir,{withFileTypes:true})){
  const target=path.join(dir,entry.name),info=await lstat(target);
  if(info.isSymbolicLink()||!(info.isDirectory()||info.isFile()))throw Error('CAPRI_PUBLIC_BUILD=1 refuses to clean linked or aliased output: '+path.relative(distRoot,target));
  const physical=await realpath(target);
  if(!strictlyInside(distRoot,physical))throw Error('CAPRI_PUBLIC_BUILD=1 refuses to clean linked or aliased output: '+path.relative(distRoot,target));
  if(info.isDirectory())await assertRealTree(physical,distRoot);
 }
}
async function removePublicDist(){
 const distRoot=await resolveOutputDirectory(path.resolve('dist'),true);let info;
 try{info=await lstat(distRoot);}catch(error){if(error.code==='ENOENT')return;throw error;}
 if(info.isSymbolicLink()||!info.isDirectory())throw Error('CAPRI_PUBLIC_BUILD=1 refuses to clean a dist that is not a real directory inside this checkout.');
 await assertRealTree(distRoot,distRoot);
 await rm(distRoot,{recursive:true,force:true});
}
/** Package the real installed distributions alongside an already compiled updater.
 * Also used by copied-location tests; no provider subprocesses or network calls. */
export async function packageRuntimeResources(nativeDirectory=path.resolve('native/publish')){
nativeDirectory=await assertRuntimeOutput(nativeDirectory);
// The approved SDK is ESM and 0.3.318 ships a native platform executable, not cli.js.
// Preserve its complete distribution (including legal notices) without bundling import.meta
// into CJS or relying on electron-builder's optional dependency/ASAR traversal.
const packageInfo=JSON.parse(await readFile('package.json','utf8'));
const sdkVersion='0.3.318',sdkRoot=path.dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')));
const sdkPackage=JSON.parse(await readFile(path.join(sdkRoot,'package.json'),'utf8'));
if(packageInfo.dependencies['@anthropic-ai/claude-agent-sdk']!==sdkVersion||sdkPackage.version!==sdkVersion)throw Error('Approved Claude SDK dependency differs.');
const platformPackage=`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
if(sdkPackage.optionalDependencies[platformPackage]!==sdkVersion)throw Error('Claude SDK platform is unsupported.');
const platformRoot=path.dirname(createRequire(path.join(sdkRoot,'package.json')).resolve(platformPackage+'/package.json'));
const platformInfo=JSON.parse(await readFile(path.join(platformRoot,'package.json'),'utf8'));
if(platformInfo.version!==sdkVersion||platformInfo.name!==platformPackage)throw Error('Approved Claude SDK native package differs.');
const claudeDirectory=path.join(nativeDirectory,'claude');
// The entire output tree was checked before any resource mutation.
await rm(claudeDirectory,{recursive:true,force:true});
await mkdir(claudeDirectory,{recursive:true});
async function copyDistribution(source,destination){
 await mkdir(destination,{recursive:true});
 for(const entry of await readdir(source,{withFileTypes:true})){
  if(entry.name==='node_modules')continue; // The installed SDK entry has only Node builtin imports.
  const from=path.join(source,entry.name),to=path.join(destination,entry.name),info=await lstat(from);
  if(info.isSymbolicLink()||!info.isFile())throw Error('Unexpected SDK distribution entry: '+entry.name);
  await cp(from,to); // Independent bytes: pnpm's source files may be hardlinked.
 }
 for(const notice of ['README.md','LICENSE.md','package.json'])await access(path.join(destination,notice));
}
await copyDistribution(sdkRoot,path.join(claudeDirectory,'sdk'));
await copyDistribution(platformRoot,path.join(claudeDirectory,'platform'));
await access(path.join(claudeDirectory,'platform',process.platform==='win32'?'claude.exe':'claude'));
const digest=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
// Only an explicitly configured, reviewed helper can become a packaged native resource.
// An absent configuration leaves supervision unavailable; an invalid supplied pin fails the build.
const supervisor=process.env.CAPRI_PROCESS_SUPERVISOR,supervisorPin=process.env.CAPRI_PROCESS_SUPERVISOR_SHA256;
let processSupervisorSha256;
if(supervisor||supervisorPin){
 if(!supervisor||!path.isAbsolute(supervisor)||!supervisor.toLowerCase().endsWith('.exe')||
  !/^[a-f0-9]{64}$/.test(supervisorPin??'')||await digest(supervisor)!==supervisorPin)throw Error('Configured native supervisor pin differs.');
 const info=await lstat(supervisor);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||await realpath(supervisor)!==path.resolve(supervisor))throw Error('Configured native supervisor is aliased.');
 const target=path.join(nativeDirectory,'Capri.ProcessSupervisor.exe');
 if(path.resolve(supervisor)!==target)await cp(supervisor,target);
 if(await digest(target)!==supervisorPin)throw Error('Copied native supervisor pin differs.');
 processSupervisorSha256=supervisorPin;
}
const files={};
for(const file of await outputFiles(claudeDirectory))files['claude/'+file]=await digest(path.join(claudeDirectory,file));
files['update-launcher.cjs']=await digest(path.join(nativeDirectory,'update-launcher.cjs'));
// Copied-location resource tests may package an independently built verifier;
// the normal build always supplies the controller and its two launch entries.
for(const name of ['managed-preview.cjs','launch-managed-preview.cmd','launch-managed-preview.ps1'])if(await access(path.join(nativeDirectory,name)).then(()=>true,()=>false))files[name]=await digest(path.join(nativeDirectory,name));
if(processSupervisorSha256)files['Capri.ProcessSupervisor.exe']=processSupervisorSha256;
const runtimeResources={schemaVersion:1,platform:process.platform,arch:process.arch,claudeSdkVersion:sdkVersion,processSupervisorSha256,files};
await writeFile(path.join(nativeDirectory,'runtime-resources.json'),JSON.stringify(runtimeResources,null,2));
return runtimeResources;
}

export async function buildCapri(){
// Start the public build from an empty dist so nothing a previous private build emitted survives into public output.
if(publicBuild)await removePublicDist();
if(!publicBuild)await cp('assets/character/chip.ico','assets/icon.ico');
let neutralFiles=[];
// External, self-contained Node runtime resource. Existing native extraResources copies it
// to resources/native/update-launcher.cjs (outside app.asar). No source-tree/npm lookup.
const nativeDirectory=await prepareRuntimeOutput();
await build({entryPoints:['scripts/update-launcher.mjs'],bundle:true,platform:'node',format:'cjs',target:'node22',outfile:path.join(nativeDirectory,'update-launcher.cjs')});
await build({entryPoints:['scripts/managed-preview.mjs'],bundle:true,platform:'node',format:'cjs',target:'node22',outfile:path.join(nativeDirectory,'managed-preview.cjs')});
await cp('scripts/launch-managed-preview.cmd',path.join(nativeDirectory,'launch-managed-preview.cmd'));
await cp('scripts/launch-managed-preview.ps1',path.join(nativeDirectory,'launch-managed-preview.ps1'));
await cp('scripts/update-launcher.ps1',path.join(nativeDirectory,'update-launcher.ps1'));
const runtimeResources=await packageRuntimeResources(nativeDirectory);
await mkdir('dist/ui',{recursive:true});
await build({entryPoints:['src/desktop/main.ts'],bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',outfile:'dist/main.cjs',define:{__CAPRI_RUNTIME_RESOURCES__:JSON.stringify(runtimeResources)},plugins:publicBuild?[publicGuard]:[]});
await build({entryPoints:['src/desktop/preload.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:'dist/preload.cjs',plugins:publicBuild?[publicGuard]:[]});
await build({entryPoints:['src/server/cloud.ts'],bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',outfile:'dist/cloud.cjs',plugins:publicBuild?[publicGuard]:[]});
await build({entryPoints:['src/ui/main.tsx'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:'dist/ui/app.js',...(publicBuild?{plugins:[publicGuard]}:{loader:{'.woff2':'file'}}),minify:true});
await cp('src/ui/index.html','dist/ui/index.html');
await cp('src/ui/mic-worklet.js','dist/ui/mic-worklet.js');
if(publicBuild){
 neutralFiles=await writeNeutralAssets('dist/ui','dist');
 if(await access('THIRD-PARTY-NOTICES.txt').then(()=>true,()=>false))await cp('THIRD-PARTY-NOTICES.txt','dist/THIRD-PARTY-NOTICES.txt');
}else{
 await mkdir('android/app/src/main/assets',{recursive:true});
 await build({entryPoints:['src/ui/android-voice.ts'],bundle:true,platform:'browser',format:'iife',target:'es2022',outfile:'android/app/src/main/assets/voice.js',minify:true});
 await cp('src/ui/mic-worklet.js','android/app/src/main/assets/mic-worklet.js');
 await cp('assets/character/chip.png','dist/icon.png');
 await cp('THIRD-PARTY-NOTICES.txt','dist/THIRD-PARTY-NOTICES.txt');
 await cp('assets/character','dist/ui/character',{recursive:true});
 await cp('assets/character','android/app/src/main/assets/character',{recursive:true});
}
if(!publicBuild)await mkdir('models',{recursive:true});
await writeFile('dist/build-info.json',JSON.stringify({version:JSON.parse(await readFile('package.json','utf8')).version,built:new Date().toISOString(),assets:publicBuild?'neutral':'private'}));
if(publicBuild)await enforcePublicOutput(neutralFiles);
console.log(publicBuild?'Built public core with neutral generated assets (no private assets, Android output skipped).':'Built desktop, browser client, and standalone service.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildCapri();
