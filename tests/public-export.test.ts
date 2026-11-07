import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
// @ts-expect-error The audited exporter is native JavaScript outside the app TS graph.
import {exportPublicCore,PublicExportError,parseArguments} from '../scripts/export-public-core.mjs';

const hash = (bytes:Buffer|string) => createHash('sha256').update(bytes).digest('hex');
const encode = (value:unknown) => JSON.stringify(value,null,2)+'\n';
type ReviewFile = {path:string;sha256:string;license:'MIT'|'notice';noticePaths?:string[]};
type Review = {version:number;files:ReviewFile[];notices:string[];publicBuild:{mode:string;entry:string;manifest?:string}};
const notices = ['LICENSE','THIRD-PARTY-NOTICES.txt','development/UPSTREAM-LICENSE.txt'];
const fixtureHome = ['C:','Users','fixture-owner'].join('/');
const credentialedFixtureUrl = (scheme:string,suffix:string) => [scheme,'://','fixture-account',':','fixture-password','@example.invalid/',suffix].join('');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'capri-public-export-'));
  const source = path.join(root,'source'), destination = path.join(root,'public-core');
  fs.mkdirSync(source);
  const write = (file:string, content:string|Buffer) => { fs.mkdirSync(path.dirname(path.join(source,file)),{recursive:true}); fs.writeFileSync(path.join(source,file),content); };
  const files = new Map<string,string>([
    ['package.json',encode({name:'private-companion',version:'0.7.0-dev.1',private:true,license:'UNLICENSED',repository:'https://example.invalid/private',dependencies:{example:'1.0.0'},devDependencies:{typescript:'5.9.0',tsx:'4.20.0'},scripts:{build:'node scripts/build.mjs',postinstall:'should-never-execute',secret:fixtureHome+'/tools/node.exe'},build:{appId:'private.app',extraResources:[{from:'models',to:'models'}],win:{icon:'assets/character/private.ico'}}})],
    ['pnpm-lock.yaml',"lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      example:\n        specifier: 1.0.0\n        version: 1.0.0\n"],
    ['tsconfig.json',encode({compilerOptions:{noEmit:true},include:['src']})],
    // Like the real build module, importing this file alone performs no build.
    ['scripts/build.mjs',"import fs from 'node:fs';\nexport async function buildCapri() {\nif (process.env.CAPRI_PUBLIC_BUILD !== '1') throw Error('Private path must not run');\nfs.mkdirSync('dist',{recursive:true});\nfs.writeFileSync('dist/neutral.json', JSON.stringify({neutral:true,credentialConfigured:false}));\n}\n"],
    ['src/core.ts','// Original MIT core\nexport const value = 7;\n'],
    ['LICENSE','MIT License\n\nCopyright (c) Original core contributors\n\nKeep this original notice byte-for-byte.\n'],
    ['THIRD-PARTY-NOTICES.txt','MIT adaptations: Original MIT contributors.\nExcluded character artwork retains its separate rights; no artwork is bundled.\n'],
    ['development/UPSTREAM-LICENSE.txt','MIT License\n\nCopyright (c) 2026 Capri Desktop contributors\n\nOriginal upstream notice must remain intact.\n'],
  ]);
  for (const [file,content] of files) write(file,content);
  let review:Review;
  function saveReview() { write('development/public-core-manifest.json',encode(review)); }
  function refresh() {
    review = {version:1,files:[...files.keys()].map(file => ({path:file,sha256:hash(fs.readFileSync(path.join(source,file))),license:notices.includes(file)?'notice':'MIT',...(!notices.includes(file)?{noticePaths:['development/UPSTREAM-LICENSE.txt']}:{} )})),notices:[...notices],publicBuild:{mode:'environment',entry:'scripts/build.mjs'}};
    saveReview(); return review;
  }
  refresh();
  return {root,source,destination,files,write,refresh,saveReview,get review(){return review;},run:()=>exportPublicCore({source,destination}),cleanup:()=>{const resolved=path.resolve(root);assert.ok(path.basename(resolved).startsWith('capri-public-export-'));assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));fs.rmSync(resolved,{recursive:true,force:true});}};
}

function rejected(f:ReturnType<typeof fixture>, reason:string) {
  assert.throws(f.run,(error:unknown) => {
    assert.ok(error instanceof PublicExportError);
    assert.ok((error as any).report.rejections.some((row:any) => row.reason === reason),encode((error as any).report));
    return true;
  });
  assert.equal(fs.existsSync(f.destination),false,'preflight rejection must not create output');
}

function snapshot(root:string) {
  const files:Record<string,string> = {};
  function walk(relative='') {
    for (const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})) {
      const name = relative ? relative+'/'+entry.name : entry.name;
      if (entry.isDirectory()) walk(name);
      else files[name] = entry.isSymbolicLink()?'alias:'+fs.readlinkSync(path.join(root,name)):hash(fs.readFileSync(path.join(root,name)));
    }
  }
  walk(); return files;
}

test('public export copies only reviewed sources, retains notices/lock, and never alters source or copies private material', () => {
  const f = fixture();
  try {
    for (const file of ['.git/config','.git/objects/private','.env','.env.example','assets/character/private.png','models/private.onnx','profiles/capri.sqlite','runtime/state.json','release/private.exe','node_modules/private/index.js','src/unreviewed.ts']) f.write(file,'DO-NOT-EXPORT-private-sentinel');
    const before = snapshot(f.source);
    const report = f.run();
    assert.deepEqual(snapshot(f.source),before);
    assert.equal(report.status,'exported');
    for (const file of notices.concat('pnpm-lock.yaml')) assert.deepEqual(fs.readFileSync(path.join(f.destination,file)),fs.readFileSync(path.join(f.source,file)));
    const actual = snapshot(f.destination);
    assert.deepEqual(Object.keys(actual).sort(),[...report.files.map((file:any)=>file.path),'PUBLIC-EXPORT-MANIFEST.json'].sort());
    for (const file of report.files) assert.equal(actual[file.path],file.sha256);
    for (const file of Object.keys(actual)) {
      const text = fs.readFileSync(path.join(f.destination,file),'utf8');
      assert.equal(text.includes('DO-NOT-EXPORT-private-sentinel'),false,file);
      assert.equal(text.includes(fixtureHome),false,file);
      assert.equal(text.includes(f.source),false,file);
    }
    for (const privateName of ['.git','assets','models','profiles','runtime','release','node_modules']) assert.equal(fs.existsSync(path.join(f.destination,privateName)),false);
    const rejectionReport = JSON.parse(fs.readFileSync(path.join(f.destination,'PUBLIC-EXPORT-REJECTIONS.json'),'utf8'));
    assert.ok(rejectionReport.excluded.some((entry:any)=>entry.path==='src/unreviewed.ts'&&entry.reason==='not_reviewed'));
    assert.equal(rejectionReport.rejections.length,0);
    const pkg = JSON.parse(fs.readFileSync(path.join(f.destination,'package.json'),'utf8'));
    const original = JSON.parse(f.files.get('package.json')!);
    assert.deepEqual(pkg.dependencies,original.dependencies);
    assert.deepEqual(pkg.devDependencies,original.devDependencies);
    assert.equal(pkg.version,original.version);
    assert.equal(pkg.license,'MIT');
    assert.equal(pkg.name,'capri-companion-core');
    assert.equal(pkg.scripts.postinstall,undefined);
    assert.equal(pkg.build.extraResources,undefined);
    assert.equal(pkg.build.win.icon,undefined);
    assert.equal(fs.readFileSync(path.join(f.destination,'.gitattributes'),'utf8'),'* -text\n');
    const attributes=report.files.find((file:any)=>file.path==='.gitattributes');
    assert.equal(attributes.origin,'generated');
    assert.equal(attributes.sourceSha256,undefined);
    assert.match(fs.readFileSync(path.join(f.destination,'.env.example'),'utf8'),/^OPENAI_API_KEY=\nANTHROPIC_API_KEY=\n/);
    // Only this known tiny fixture is built; no real checkout or app is executed.
    execFileSync(process.execPath,['scripts/public-build.mjs'],{cwd:f.destination,env:{...process.env,CAPRI_PUBLIC_BUILD:'0'},windowsHide:true});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.destination,'dist/neutral.json'),'utf8')),{neutral:true,credentialConfigured:false});
  } finally { f.cleanup(); }
});

test('public build reports a failure from the explicit build entry instead of succeeding after import', () => {
  const f=fixture();
  try {
    const entry="export async function buildCapri() {\nif (process.env.CAPRI_PUBLIC_BUILD !== '1') throw Error('Private path must not run');\nthrow Error('Neutral fixture build failed');\n}\n";
    f.files.set('scripts/build.mjs',entry);f.write('scripts/build.mjs',entry);f.refresh();f.run();
    const run=spawnSync(process.execPath,['scripts/public-build.mjs'],{cwd:f.destination,env:{...process.env,CAPRI_PUBLIC_BUILD:'0'},windowsHide:true,encoding:'utf8'});
    assert.notEqual(run.status,0);assert.match(run.stderr,/Neutral fixture build failed/);
    assert.equal(fs.existsSync(path.join(f.destination,'dist')),false);
  } finally {f.cleanup();}
});

test('public Git attributes replace reviewed source rules without bypassing hashes, scans or exact notices', () => {
  const f=fixture();
  try {
    const sourceAttributes='* text=auto\n*.ts text eol=lf\n*.md text eol=lf\n*.json text eol=lf\n';
    f.files.set('.gitattributes',sourceAttributes);
    for (const [content,reason] of [
      ['# Personal path '+fixtureHome+'/private\n* text=auto\n','absolute_user_path'],
      ['SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0\n* text=auto\n','non_mit_source_notice'],
    ]) {
      f.write('.gitattributes',content);f.refresh();rejected(f,reason);
    }
    f.write('.gitattributes',sourceAttributes);f.refresh();
    f.write('.gitattributes','* text eol=crlf\n');rejected(f,'reviewed_hash_mismatch');
    f.write('.gitattributes',sourceAttributes);
    const before=snapshot(f.source),report=f.run();
    assert.deepEqual(snapshot(f.source),before);
    assert.equal(fs.readFileSync(path.join(f.source,'.gitattributes'),'utf8'),sourceAttributes);
    assert.equal(fs.readFileSync(path.join(f.destination,'.gitattributes'),'utf8'),'* -text\n');
    for (const file of notices) assert.deepEqual(fs.readFileSync(path.join(f.destination,file)),fs.readFileSync(path.join(f.source,file)));
    const attributes=report.files.find((file:any)=>file.path==='.gitattributes');
    assert.equal(attributes.origin,'sanitized');
    assert.equal(attributes.license,'MIT');
    assert.equal(attributes.sourceSha256,hash(sourceAttributes));
    assert.equal(attributes.sha256,hash('* -text\n'));
    assert.equal(attributes.bytes,Buffer.byteLength('* -text\n'));
    assert.notEqual(attributes.sha256,attributes.sourceSha256);
    assert.equal(report.contentSha256,hash(JSON.stringify(report.files)));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.destination,'PUBLIC-EXPORT-MANIFEST.json'),'utf8')),report);
  } finally {f.cleanup();}
});

// Only disposable, fully local fixture repositories are used. Neither user Git
// configuration/attributes/hooks nor a private checkout's history is consulted.
function fixtureGit(root:string,autocrlf:string) {
  const emptyConfig=path.join(root,'empty-git-config'),emptyAttributes=path.join(root,'empty-git-attributes');
  const emptyTemplate=path.join(root,'empty-git-template'),emptyHooks=path.join(root,'empty-git-hooks');
  fs.writeFileSync(emptyConfig,'');fs.writeFileSync(emptyAttributes,'');fs.mkdirSync(emptyTemplate);fs.mkdirSync(emptyHooks);
  const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^GIT_/i.test(name))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:emptyConfig,GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_OPTIONAL_LOCKS:'0',GIT_CEILING_DIRECTORIES:root};
  const configuration=['-c','core.autocrlf='+autocrlf,'-c','core.attributesFile='+emptyAttributes,'-c','core.hooksPath='+emptyHooks,'-c','core.fsmonitor=false','-c','init.templateDir='+emptyTemplate,'-c','gc.auto=0','-c','maintenance.auto=false','-c','protocol.allow=never','-c','protocol.file.allow=always','-c','submodule.recurse=false','-c','commit.gpgSign=false','-c','user.name=Public export fixture','-c','user.email=public-export-fixture@example.invalid'];
  return (cwd:string,...args:string[])=>execFileSync('git',[...configuration,...args],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});
}

for (const autocrlf of ['true','false']) test(`public export local Git clone preserves every raw byte and stays clean with autocrlf=${autocrlf}`, () => {
  const f=fixture();
  try {
    f.files.set('.gitattributes','* text=auto\n*.ts text eol=lf\n*.md text eol=lf\n*.json text eol=lf\n');
    for (const [extension,prefix,content] of [
      ['ts','src','export const neutral = true;\n'],
      ['mjs','scripts','export const neutral = true;\n'],
      ['md','src','# Neutral fixture\n\nNo private data.\n'],
      ['json','src','{\n  "neutral": true\n}\n'],
    ]) for (const ending of ['lf','crlf']) f.files.set(`${prefix}/fixture-${ending}.${extension}`,ending==='crlf'?content.replace(/\n/g,'\r\n'):content);
    f.files.set('THIRD-PARTY-NOTICES.txt',f.files.get('THIRD-PARTY-NOTICES.txt')!.replace(/\n/g,'\r\n'));
    for (const [file,content] of f.files) f.write(file,content);
    f.refresh();const before=snapshot(f.source),report=f.run(),expected=snapshot(f.destination);
    const git=fixtureGit(f.root,autocrlf);
    git(f.destination,'init','--initial-branch=main');
    git(f.destination,'add','--all');git(f.destination,'commit','-m','Neutral exported byte fixture');
    for (const [file,digest] of Object.entries(expected)) assert.equal(hash(git(f.destination,'cat-file','blob',`HEAD:${file}`)),digest,'stored blob '+file);
    const clone=path.join(f.root,'clone-autocrlf-'+autocrlf);
    git(f.root,'clone','--no-hardlinks','--',f.destination,clone);
    assert.equal(git(clone,'status','--porcelain=v1','--untracked-files=all').toString(),'');
    const checkBytes=()=>{
      for (const [file,digest] of Object.entries(expected)) assert.equal(hash(fs.readFileSync(path.join(clone,file))),digest,'cloned bytes '+file);
      const manifest=JSON.parse(fs.readFileSync(path.join(clone,'PUBLIC-EXPORT-MANIFEST.json'),'utf8'));
      assert.deepEqual(manifest,report);
      for (const file of manifest.files) assert.equal(hash(fs.readFileSync(path.join(clone,file.path))),file.sha256,'manifest binding '+file.path);
      for (const file of notices) assert.deepEqual(fs.readFileSync(path.join(clone,file)),fs.readFileSync(path.join(f.source,file)));
    };
    checkBytes();
    for (const file of Object.keys(expected)) {
      const target=path.join(clone,file),stat=fs.statSync(target),bytes=fs.readFileSync(target);
      fs.writeFileSync(target,bytes);
      // Force a fresh content comparison rather than relying on Git's stat cache.
      fs.utimesSync(target,stat.atime,new Date(stat.mtimeMs+3000));
    }
    assert.equal(git(clone,'status','--porcelain=v1','--untracked-files=all').toString(),'','identical-byte rewrites must stay clean');
    checkBytes();assert.deepEqual(snapshot(f.source),before);
  } finally {f.cleanup();}
});

test('public export rejects unsafe destinations, aliases, traversal, existing directories, and aliased selected sources', () => {
  const f = fixture();
  try {
    for (const destination of [f.source,path.join(f.source,'nested'),f.root,f.source+'-parent/../escape',path.parse(f.root).root]) assert.throws(()=>exportPublicCore({source:f.source,destination}),PublicExportError);
    fs.mkdirSync(f.destination);
    fs.writeFileSync(path.join(f.destination,'keep.txt'),'unchanged');
    assert.throws(f.run,PublicExportError);
    assert.equal(fs.readFileSync(path.join(f.destination,'keep.txt'),'utf8'),'unchanged');
    fs.rmSync(f.destination,{recursive:true});
    const target = path.join(f.root,'actual-parent');
    fs.mkdirSync(target);
    const alias = path.join(f.root,'alias-parent');
    fs.symlinkSync(target,alias,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>exportPublicCore({source:f.source,destination:path.join(alias,'export')}),PublicExportError);
    const sourceAlias = path.join(f.root,'source-alias');
    fs.symlinkSync(f.source,sourceAlias,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>exportPublicCore({source:sourceAlias,destination:f.destination}),PublicExportError);
    fs.mkdirSync(path.join(f.source,'src/aliased-parent'));
    f.write('src/aliased-parent/core.ts','export const x=1;');
    fs.symlinkSync(path.join(f.source,'src/aliased-parent'),path.join(f.source,'src/link'),process.platform==='win32'?'junction':'dir');
    f.review.files.push({path:'src/link/core.ts',sha256:hash('export const x=1;'),license:'MIT'});f.saveReview();
    rejected(f,'unsafe_or_unreadable_source');
  } finally { f.cleanup(); }
});

test('reviewed MIT supervisor C# source is exported with portable setup and complete source inventory', () => {
  const f=fixture();
  try {
    const source='// Original MIT-owned neutral source fixture.\nnamespace Neutral; internal static class Program { static int Main() => 0; }\n';
    const project='<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0-windows</TargetFramework><SelfContained>true</SelfContained></PropertyGroup></Project>\n';
    f.files.set('tools/process-supervisor/Program.cs',source);f.files.set('tools/process-supervisor/ProcessSupervisor.csproj',project);
    f.files.set('tools/coordinator/cli.ts','export const notLaunchedByExport=true;\n');
    f.files.set('tools/coordinator/config.json',encode({agents:{codex:{command:fixtureHome+'/codex.exe'},claude:{command:fixtureHome+'/claude.exe'}},processSupervisor:fixtureHome+'/private/helper.exe',continuous:true}));
    for(const [file,content] of f.files)f.write(file,content);
    for(const file of ['tools/process-supervisor/Unreviewed.cs','tools/process-supervisor/config.json','tools/process-supervisor/Capri.ProcessSupervisor.exe','tools/process-supervisor/bin/Debug/private.cs','tools/process-supervisor/obj/project.assets.json','tools/process-supervisor/runtime/private.cs','tools/unrelated/Hidden.cs'])f.write(file,'PRIVATE-OUTPUT-SENTINEL');
    f.refresh();const before=snapshot(f.source),report=f.run();assert.deepEqual(snapshot(f.source),before);
    for(const file of ['tools/process-supervisor/Program.cs','tools/process-supervisor/ProcessSupervisor.csproj']){
      assert.deepEqual(fs.readFileSync(path.join(f.destination,file)),fs.readFileSync(path.join(f.source,file)));
      assert.equal(report.files.find((item:any)=>item.path===file).sourceSha256,hash(fs.readFileSync(path.join(f.source,file))));
    }
    const excluded=JSON.parse(fs.readFileSync(path.join(f.destination,'PUBLIC-EXPORT-REJECTIONS.json'),'utf8')).excluded;
    assert.ok(excluded.some((item:any)=>item.path==='tools/process-supervisor/Unreviewed.cs'&&item.reason==='not_reviewed'));
    assert.ok(excluded.some((item:any)=>item.path==='tools/process-supervisor/bin'&&item.reason==='private_or_generated_path'));
    assert.ok(excluded.some((item:any)=>item.path==='tools/process-supervisor/obj'&&item.reason==='private_or_generated_path'));
    assert.ok(excluded.some((item:any)=>item.path==='tools/process-supervisor/runtime'&&item.reason==='private_or_generated_path'));
    assert.ok(excluded.some((item:any)=>item.path==='tools/process-supervisor/Capri.ProcessSupervisor.exe'));
    for(const file of ['bin','obj','runtime','Capri.ProcessSupervisor.exe','Unreviewed.cs','config.json'])assert.equal(fs.existsSync(path.join(f.destination,'tools/process-supervisor',file)),false);
    const readme=fs.readFileSync(path.join(f.destination,'README.md'),'utf8');
    assert.match(readme,/\.NET 10 SDK/);assert.match(readme,/dotnet publish tools\/process-supervisor\/ProcessSupervisor\.csproj -c Release -r win-x64/);
    assert.match(readme,/-p:IncludeNativeLibrariesForSelfExtract=true -o \.\.\/capri-core-runtime\/tools\/process-supervisor/);
    assert.match(readme,/\$env:CAPRI_PROCESS_SUPERVISOR = \(Resolve-Path/);assert.match(readme,/Get-FileHash -LiteralPath \$env:CAPRI_PROCESS_SUPERVISOR -Algorithm SHA256/);
    assert.match(readme,/does not establish.*adapter wiring is complete/);assert.match(readme,/must refuse to run without the reviewed helper/);
    assert.equal(readme.includes(fixtureHome),false);assert.equal(readme.includes('PRIVATE-OUTPUT-SENTINEL'),false);
    assert.match(fs.readFileSync(path.join(f.destination,'.env.example'),'utf8'),/^CAPRI_PROCESS_SUPERVISOR=$/m);
    const ignores=fs.readFileSync(path.join(f.destination,'.gitignore'),'utf8');assert.ok(ignores.includes('tools/process-supervisor/bin/'));assert.ok(ignores.includes('tools/process-supervisor/obj/'));
    const config=JSON.parse(fs.readFileSync(path.join(f.destination,'tools/coordinator/config.json'),'utf8'));
    assert.equal(config.processSupervisor,undefined,'do not invent a not-yet-integrated configuration field or copy a host path');
    assert.deepEqual(config.agents,{codex:{command:'codex'},claude:{command:'claude'}});assert.equal(config.continuous,false);
  } finally {f.cleanup();}
});

test('supervisor source exception never admits configuration, binaries, generated trees or unrelated tools', () => {
  const f=fixture();
  try {
    const cases:[string,string][]=[
      ['tools/process-supervisor/config.json','supervisor_requires_csharp_source'],
      ['tools/process-supervisor/Capri.ProcessSupervisor.exe','supervisor_requires_csharp_source'],
      ['tools/process-supervisor/bin/Debug/Program.cs','private_or_generated_path'],
      ['tools/process-supervisor/obj/Generated.cs','private_or_generated_path'],
      ['tools/process-supervisor/publish/Program.cs','private_or_generated_path'],
      ['tools/process-supervisor/runtime/Program.cs','private_or_generated_path'],
      ['tools/process-supervisor-other/Program.cs','outside_source_allowlist'],
      ['tools/unrelated/Program.cs','outside_source_allowlist']
    ];
    for(const [file,reason] of cases){f.write(file,'neutral fixture bytes');f.refresh();f.review.files.push({path:file,sha256:hash('neutral fixture bytes'),license:'MIT'});f.saveReview();rejected(f,reason);fs.unlinkSync(path.join(f.source,file));}
    const file='tools/process-supervisor/Program.cs',secretPath='// Personal path '+fixtureHome+'/Documents/private\n';
    f.write(file,secretPath);f.refresh();f.review.files.push({path:file,sha256:hash(secretPath),license:'MIT'});f.saveReview();rejected(f,'absolute_user_path');
    const source='// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0\nclass Program {}\n';
    f.write(file,source);f.refresh();f.review.files.push({path:file,sha256:hash(source),license:'MIT'});f.saveReview();rejected(f,'non_mit_source_notice');
  } finally {f.cleanup();}
});

test('reviewed hashes, local dependency closure, and provenance notices are mandatory', () => {
  const f = fixture();
  try {
    f.write('src/core.ts','export const changed = true;');
    rejected(f,'reviewed_hash_mismatch');
    f.refresh();
    f.review.files=f.review.files.filter(file=>file.path!=='development/UPSTREAM-LICENSE.txt');
    f.review.notices=f.review.notices.filter(file=>file!=='development/UPSTREAM-LICENSE.txt');f.saveReview();
    rejected(f,'existing_notice_must_be_reviewed_and_retained');
    f.refresh();
    const missingImport=['import {missing} from ',"'./not-reviewed'",';\nexport {missing};\n'].join('');
    f.write('src/core.ts',missingImport);f.refresh();
    rejected(f,'unreviewed_local_import');
    f.write('src/core.ts',f.files.get('src/core.ts')!);f.refresh();
    f.review.files[0].path='../escape.ts';f.saveReview();
    rejected(f,'invalid_file_record');
  } finally { f.cleanup(); }
});

test('public build guard and MIT-only source gate reject private-only or non-MIT implementations', () => {
  const f = fixture();
  try {
    f.write('scripts/build.mjs',"import fs from 'node:fs';\nfs.cpSync('assets/character','dist/character',{recursive:true});\n");f.refresh();
    rejected(f,'public_build_environment_guard_missing');
    f.write('scripts/build.mjs',f.files.get('scripts/build.mjs')!);
    f.write('src/core.ts','// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0\nexport const forbidden=1;\n');f.refresh();
    rejected(f,'non_mit_source_notice');
  } finally { f.cleanup(); }
});

test('selected secrets, home paths, binaries, old character art, and hardlink aliases fail without leaking values', () => {
  const f = fixture();
  try {
    const candidates:[string,string,string][] = [
      ['.env','OPENAI_API_KEY=private-config-sentinel','private_or_generated_path'],
      ['assets/character/private.svg','<svg/>','private_artwork_path'],
      ['src/model.onnx','downloaded-model-sentinel','non_source_or_binary_file'],
      ['src/private.ts','export const home='+JSON.stringify(fixtureHome.replaceAll('/','\\')+'\\Documents')+';','absolute_user_path'],
      ['src/private.ts',"export const key='sk-proj-"+'a'.repeat(32)+"';",'credential_material'],
      ['src/private.json',encode({nested:{apiKey:'private-configured-key'}}),'configured_credential_json'],
      ['src/private.json',encode({databaseUrl:credentialedFixtureUrl('postgres','database')}),'credentialed_connection_url'],
      ['src/private.ts',"export const art='data:image/png;base64,"+'a'.repeat(120)+"';",'embedded_media_or_font'],
    ];
    for (const [file,content,reason] of candidates) {
      f.write(file,content);f.refresh();
      f.review.files.push({path:file,sha256:hash(content),license:'MIT'});f.saveReview();
      rejected(f,reason);
      let report='';try { f.run(); } catch(error:any) { report=encode(error.report); }
      assert.equal(report.includes('fixture-owner'),false);
      assert.equal(report.includes('a'.repeat(32)),false);
      fs.unlinkSync(path.join(f.source,file));
    }
    fs.linkSync(path.join(f.source,'src/core.ts'),path.join(f.source,'src/linked.ts'));
    f.refresh();f.review.files.push({path:'src/linked.ts',sha256:hash(fs.readFileSync(path.join(f.source,'src/linked.ts'))),license:'MIT'});f.saveReview();
    rejected(f,'unsafe_or_unreadable_source');
  } finally { f.cleanup(); }
});

test('explicit public asset manifest accepts original code-generated SVG/JSON and rejects external image references', () => {
  const f = fixture();
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>\n';
    f.files.set('assets/public/neutral.svg',svg);
    f.files.set('scripts/generate-public-assets.mjs','export const originalNeutralArtwork=true;\n');
    f.files.set('development/public-assets.json',encode({version:1,license:'MIT',generatedBy:'scripts/generate-public-assets.mjs',files:[{path:'assets/public/neutral.svg',sha256:hash(svg),provenance:'original-code-generated'}]}));
    for (const [file,content] of f.files) f.write(file,content);
    f.write('scripts/build.mjs',"// Reviewed build consumes development/public-assets.json only.\nexport const neutral=true;\n");f.refresh();
    f.review.publicBuild={mode:'assets',entry:'scripts/build.mjs',manifest:'development/public-assets.json'};f.saveReview();
    const report=f.run();
    assert.ok(report.files.some((file:any)=>file.path==='assets/public/neutral.svg'));
    assert.equal(fs.readFileSync(path.join(f.destination,'assets/public/neutral.svg'),'utf8'),svg);
    fs.rmSync(f.destination,{recursive:true});
    const unsafe='<svg><image href="https://example.invalid/private.png"/></svg>';
    f.write('assets/public/neutral.svg',unsafe);
    f.write('development/public-assets.json',encode({version:1,license:'MIT',generatedBy:'scripts/generate-public-assets.mjs',files:[{path:'assets/public/neutral.svg',sha256:hash(unsafe),provenance:'original-code-generated'}]}));f.refresh();
    f.review.publicBuild={mode:'assets',entry:'scripts/build.mjs',manifest:'development/public-assets.json'};f.saveReview();
    rejected(f,'non_neutral_svg_reference');
  } finally { f.cleanup(); }
});

test('exported coordinator uses runtime CLI discovery and an empty isolated opt-in queue', () => {
  const f = fixture();
  try {
    f.files.set('tools/coordinator/cli.ts','export const coordinator=true;\n');
    f.files.set('tools/coordinator/config.json',encode({agents:{codex:{command:fixtureHome+'/versioned/codex.exe'},claude:{command:fixtureHome+'/.local/bin/claude.exe'}},continuous:true,stateDir:fixtureHome+'/runtime'}));
    for (const [file,content] of f.files) f.write(file,content);
    f.refresh();const report=f.run();
    const config=JSON.parse(fs.readFileSync(path.join(f.destination,'tools/coordinator/config.json'),'utf8'));
    assert.deepEqual(config.agents,{codex:{command:'codex'},claude:{command:'claude'}});
    assert.equal(config.continuous,false);
    assert.equal(path.isAbsolute(config.stateDir),false);
    assert.match(config.stateDir,/^\.\.\/capri-core-runtime\//);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.destination,config.tasksFile),'utf8')),[]);
    assert.equal(config.checks.find((check:any)=>check.id==='build').args[0],'scripts/public-build.mjs');
    assert.equal(report.files.find((file:any)=>file.path==='tools/coordinator/config.json').origin,'sanitized');
    for (const prompt of Object.values(config.prompts) as string[]) assert.equal(fs.existsSync(path.join(f.destination,prompt)),true);
  } finally { f.cleanup(); }
});

test('export CLI requires explicit source and rejects ambiguous flags without any app or account action', () => {
  assert.throws(()=>parseArguments([]),/explicitly supplied/);
  assert.throws(()=>parseArguments(['--source','a','--source','b']),/Usage/);
  assert.throws(()=>parseArguments(['--source','--destination','a']),/Usage/);
  assert.throws(()=>parseArguments(['--publish','yes']),/Usage/);
});

test('public package dependencies cannot retain local/private references or change the preserved lock by substitution', () => {
  const f=fixture();
  try {
    const pkg=JSON.parse(f.files.get('package.json')!);
    const lock=fs.readFileSync(path.join(f.source,'pnpm-lock.yaml'));
    for (const spec of ['file:../private-module','link:../private-module','workspace:*','git+ssh://example.invalid/private',credentialedFixtureUrl('https','private.tgz')]) {
      f.write('package.json',encode({...pkg,dependencies:{example:spec}}));f.refresh();
      rejected(f,'invalid_reviewed_package');
      assert.deepEqual(fs.readFileSync(path.join(f.source,'pnpm-lock.yaml')),lock);
    }
  } finally { f.cleanup(); }
});

// Simulates an already installed local tsx only inside a disposable export fixture.
// It records argv/env/order and exits as requested; it never executes real tests.
function fixtureTsx(destination:string) {
  const file=path.join(destination,'node_modules/tsx/dist/cli.mjs');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,`import fs from 'node:fs';
fs.appendFileSync('fixture-order.log','test\\n');
fs.writeFileSync('fixture-test-evidence.json',JSON.stringify({publicBuild:process.env.CAPRI_PUBLIC_BUILD,args:process.argv.slice(2),cwd:process.cwd(),neutral:fs.existsSync('dist/neutral.json')}));
process.exitCode=Number(process.env.CAPRI_FIXTURE_TEST_EXIT || 0);
`);
}

test('public test wrapper builds neutral assets then enumerates TS/TSX paths serially without a shell and preserves child status', () => {
  const f=fixture();
  try {
    f.files.set('scripts/build.mjs',f.files.get('scripts/build.mjs')!.replace(/\}\n$/,"fs.appendFileSync('fixture-order.log','build\\n');\n}\n"));
    for (const file of ['tests/basic.test.ts','tests/with space.test.tsx','tests/nested/child.test.tsx','tests/not-a-test.ts']) f.files.set(file,'export {};\n');
    f.files.set('tools/coordinator/cli.ts','export const noWorkerIsLaunched=true;\n');
    for (const [file,content] of f.files) f.write(file,content);
    f.refresh();f.run();fixtureTsx(f.destination);
    const pkg=JSON.parse(fs.readFileSync(path.join(f.destination,'package.json'),'utf8'));
    assert.equal(pkg.scripts.test,'node scripts/public-test.mjs');
    const readEvidence=()=>JSON.parse(fs.readFileSync(path.join(f.destination,'fixture-test-evidence.json'),'utf8'));
    const run=(args:string[],code=0)=>spawnSync(process.execPath,args,{cwd:f.root,env:{...process.env,CAPRI_PUBLIC_BUILD:'0',CAPRI_FIXTURE_TEST_EXIT:String(code)},windowsHide:true,encoding:'utf8'});
    const first=run([path.join(f.destination,'scripts/public-test.mjs')]);
    assert.equal(first.status,0,first.stderr);
    assert.equal(readEvidence().publicBuild,'1');
    assert.equal(readEvidence().neutral,true);
    assert.equal(fs.realpathSync.native(readEvidence().cwd),fs.realpathSync.native(f.destination));
    assert.deepEqual(readEvidence().args,['--test','--test-concurrency=1',path.join('tests','basic.test.ts'),path.join('tests','nested','child.test.tsx'),path.join('tests','with space.test.tsx')]);
    assert.equal(readEvidence().args.some((arg:string)=>arg.includes('*')),false);
    assert.equal(fs.readFileSync(path.join(f.destination,'fixture-order.log'),'utf8'),'build\ntest\n');
    const readme=fs.readFileSync(path.join(f.destination,'README.md'),'utf8');
    assert.ok(readme.indexOf('`pnpm build`')<readme.indexOf('`pnpm check`'));
    assert.ok(readme.indexOf('`pnpm check`')<readme.indexOf('`pnpm test`'));

    // The generated coordinator uses the same enumerator, even without TSX files.
    for (const file of ['tests/with space.test.tsx','tests/nested/child.test.tsx']) fs.unlinkSync(path.join(f.destination,file));
    const config=JSON.parse(fs.readFileSync(path.join(f.destination,'tools/coordinator/config.json'),'utf8'));
    const check=config.checks.find((row:any)=>row.id==='test');
    assert.deepEqual(check.args,['scripts/public-test.mjs']);
    const coordinatorCheck=spawnSync(process.execPath,check.args,{cwd:f.destination,env:{...process.env,CAPRI_PUBLIC_BUILD:'0'},windowsHide:true,encoding:'utf8'});
    assert.equal(coordinatorCheck.status,0,coordinatorCheck.stderr);
    assert.deepEqual(readEvidence().args,['--test','--test-concurrency=1',path.join('tests','basic.test.ts')]);
    fs.rmSync(path.join(f.destination,'dist'),{recursive:true});
    const failed=run([path.join(f.destination,'scripts/public-test.mjs')],7);
    assert.equal(failed.status,7,failed.stderr);
    assert.equal(readEvidence().neutral,true,'neutral build must also run before failing tests');
    assert.equal(readEvidence().publicBuild,'1');
  } finally { f.cleanup(); }
});

test('public test wrapper preserves a failed neutral build status and does not dispatch tests', () => {
  const f=fixture();
  try {
    f.files.set('scripts/build.mjs',"export async function buildCapri() {\nif(process.env.CAPRI_PUBLIC_BUILD!=='1') throw Error('Wrong build mode');\nprocess.exitCode=23;\n}\n");
    f.files.set('tests/basic.test.ts','export {};\n');
    for (const [file,content] of f.files) f.write(file,content);
    f.refresh();f.run();fixtureTsx(f.destination);
    const child=spawnSync(process.execPath,['scripts/public-test.mjs'],{cwd:f.destination,env:{...process.env,CAPRI_PUBLIC_BUILD:'0'},windowsHide:true,encoding:'utf8'});
    assert.equal(child.status,23,child.stderr);
    assert.equal(fs.existsSync(path.join(f.destination,'fixture-test-evidence.json')),false);
    assert.equal(fs.existsSync(path.join(f.destination,'fixture-order.log')),false);
  } finally { f.cleanup(); }
});
