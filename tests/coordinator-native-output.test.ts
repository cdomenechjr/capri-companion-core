import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isolateNativeOutput,runtimeLinks} from '../tools/coordinator/git';
import type {Config} from '../tools/coordinator/types';

const linkType=process.platform==='win32'?'junction':'dir';
function fixture(t:test.TestContext){
 const parent=fs.realpathSync.native(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'capri-native-output-')),repo=path.join(root,'repo'),worktreeRoot=path.join(root,'worktrees');
 fs.mkdirSync(repo);fs.mkdirSync(worktreeRoot);const config={repo,worktreeRoot,developmentRoot:root} as Config;
 const worktree=(name:string,native=true)=>{const directory=path.join(worktreeRoot,name);fs.mkdirSync(directory);if(native){fs.mkdirSync(path.join(directory,'native'));fs.writeFileSync(path.join(directory,'native','Program.cs'),'// Neutral uncompiled worktree source\n');}return directory;};
 const canonical=()=>{const directory=path.join(repo,'native','publish');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'Capri.Windows.exe'),'NEUTRAL-NOT-EXECUTABLE\r\n');fs.writeFileSync(path.join(repo,'native','Program.cs'),'// Neutral canonical source\r\n');return directory;};
 t.after(()=>{const resolved=path.resolve(root);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('capri-native-output-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:100});});return {root,repo,worktreeRoot,config,worktree,canonical};
}
function snapshot(directory:string){const files:Record<string,string>={};function walk(relative=''){for(const entry of fs.readdirSync(path.join(directory,relative),{withFileTypes:true})){const name=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory())walk(name);else{assert.equal(entry.isSymbolicLink(),false);files[name]=createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex');}}}walk();return files;}

test('runtime links keep dependencies/models while native outputs stay local to separate worktrees',t=>{
 const f=fixture(t),canonical=f.canonical(),first=f.worktree('first'),second=f.worktree('second');
 fs.mkdirSync(path.join(f.repo,'node_modules'));fs.writeFileSync(path.join(f.repo,'node_modules','neutral.txt'),'dependencies');fs.mkdirSync(path.join(f.root,'runtime','models'),{recursive:true});fs.writeFileSync(path.join(f.root,'runtime','models','neutral.txt'),'models');
 const before=snapshot(f.repo);for(const worktree of [first,second]){runtimeLinks(f.config,worktree);assert.equal(fs.realpathSync.native(path.join(worktree,'node_modules')),path.join(f.repo,'node_modules'));assert.equal(fs.realpathSync.native(path.join(worktree,'models')),path.join(f.root,'runtime','models'));assert.equal(fs.existsSync(path.join(worktree,'native','publish')),false);fs.mkdirSync(path.join(worktree,'native','publish'));}
 fs.writeFileSync(path.join(first,'native','publish','local.txt'),'first');fs.writeFileSync(path.join(second,'native','publish','local.txt'),'second');
 assert.equal(fs.readFileSync(path.join(first,'native','publish','local.txt'),'utf8'),'first');assert.equal(fs.readFileSync(path.join(second,'native','publish','local.txt'),'utf8'),'second');assert.equal(fs.existsSync(path.join(canonical,'local.txt')),false);assert.deepEqual(snapshot(f.repo),before);
 const nodeLink=fs.lstatSync(path.join(first,'node_modules'));runtimeLinks(f.config,first);assert.equal(fs.lstatSync(path.join(first,'node_modules')).ino,nodeLink.ino);assert.deepEqual(snapshot(f.repo),before);
});

test('fresh/public source needs no canonical native output or local native parent',t=>{
 const f=fixture(t),worktree=f.worktree('fresh',false);assert.equal(fs.existsSync(path.join(f.repo,'native')),false);
 assert.equal(isolateNativeOutput(f.config,worktree).status,'absent');runtimeLinks(f.config,worktree);assert.equal(fs.existsSync(path.join(worktree,'native')),false);assert.equal(fs.existsSync(path.join(f.repo,'native')),false);
 fs.mkdirSync(path.join(worktree,'native'));assert.equal(isolateNativeOutput(f.config,worktree).status,'absent');fs.mkdirSync(path.join(worktree,'native','publish'));assert.equal(fs.lstatSync(path.join(worktree,'native','publish')).isSymbolicLink(),false);
});

test('exact legacy directory junction is unlinked without touching its canonical target or source bytes',t=>{
 const f=fixture(t),canonical=f.canonical(),worktree=f.worktree('legacy'),publish=path.join(worktree,'native','publish');fs.symlinkSync(canonical,publish,linkType);const before=snapshot(f.repo),source=fs.readFileSync(path.join(worktree,'native','Program.cs'));
 assert.equal(fs.lstatSync(publish).isSymbolicLink(),true);assert.equal(isolateNativeOutput(f.config,worktree).status,'unlinked');assert.throws(()=>fs.lstatSync(publish),(error:any)=>error.code==='ENOENT');assert.deepEqual(snapshot(f.repo),before);assert.deepEqual(fs.readFileSync(path.join(worktree,'native','Program.cs')),source);
 fs.mkdirSync(publish);assert.equal(fs.existsSync(path.join(publish,'Capri.Windows.exe')),false,'old helpers are not copied');fs.writeFileSync(path.join(publish,'local.txt'),'isolated');assert.deepEqual(snapshot(f.repo),before);assert.equal(isolateNativeOutput(f.config,worktree).status,'preserved');
});

test('existing real per-worktree native output is preserved byte for byte',t=>{
 const f=fixture(t),worktree=f.worktree('real'),publish=path.join(worktree,'native','publish');fs.mkdirSync(publish);fs.writeFileSync(path.join(publish,'owned-output.bin'),'neutral owned output\0\r\n');const before=snapshot(worktree),identity=fs.lstatSync(publish).ino;
 assert.equal(isolateNativeOutput(f.config,worktree).status,'preserved');runtimeLinks(f.config,worktree);assert.equal(fs.lstatSync(publish).ino,identity);assert.deepEqual(snapshot(worktree),before);assert.equal(fs.existsSync(path.join(f.repo,'native')),false);
});

test('foreign and dangling links are refused and retained without modifying either target',t=>{
 const f=fixture(t),canonical=f.canonical(),foreign=path.join(f.root,'foreign-output');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'keep.txt'),'foreign bytes');const before=snapshot(f.repo),worktree=f.worktree('foreign'),publish=path.join(worktree,'native','publish');fs.symlinkSync(foreign,publish,linkType);
 assert.throws(()=>isolateNativeOutput(f.config,worktree),/does not target/);assert.equal(fs.lstatSync(publish).isSymbolicLink(),true);assert.equal(fs.readFileSync(path.join(foreign,'keep.txt'),'utf8'),'foreign bytes');assert.deepEqual(snapshot(f.repo),before);
 const missing=path.join(f.root,'empty-then-missing');fs.mkdirSync(missing);const dangling=f.worktree('dangling'),danglingLink=path.join(dangling,'native','publish');fs.symlinkSync(missing,danglingLink,linkType);fs.rmdirSync(missing);
 assert.throws(()=>isolateNativeOutput(f.config,dangling),/unavailable target/);assert.equal(fs.lstatSync(danglingLink).isSymbolicLink(),true);assert.equal(fs.existsSync(canonical),true);assert.deepEqual(snapshot(f.repo),before);
});

test('aliased worktree/native/root parents are rejected before removing an otherwise matching link',t=>{
 const f=fixture(t),canonical=f.canonical(),outside=path.join(f.root,'outside-native');fs.mkdirSync(outside);fs.symlinkSync(canonical,path.join(outside,'publish'),linkType);
 const worktree=f.worktree('aliased-native',false);fs.symlinkSync(outside,path.join(worktree,'native'),linkType);assert.throws(()=>isolateNativeOutput(f.config,worktree),/real directory/);assert.equal(fs.lstatSync(path.join(outside,'publish')).isSymbolicLink(),true);
 const real=f.worktree('real-worktree'),alias=path.join(f.worktreeRoot,'worktree-alias');fs.symlinkSync(canonical,path.join(real,'native','publish'),linkType);fs.symlinkSync(real,alias,linkType);assert.throws(()=>isolateNativeOutput(f.config,alias),/without aliases/);assert.equal(fs.lstatSync(path.join(real,'native','publish')).isSymbolicLink(),true);
 const rootAlias=path.join(f.root,'root-alias');fs.symlinkSync(f.worktreeRoot,rootAlias,linkType);assert.throws(()=>isolateNativeOutput({...f.config,worktreeRoot:rootAlias},real),/without aliases/);
});

test('canonical native aliases, outside checkouts and unexpected regular files are never removed',t=>{
 const f=fixture(t),foreign=path.join(f.root,'source-native-alias');fs.mkdirSync(path.join(foreign,'publish'),{recursive:true});fs.writeFileSync(path.join(foreign,'publish','keep.txt'),'keep');fs.symlinkSync(foreign,path.join(f.repo,'native'),linkType);
 const worktree=f.worktree('source-alias'),publish=path.join(worktree,'native','publish');fs.symlinkSync(path.join(foreign,'publish'),publish,linkType);assert.throws(()=>isolateNativeOutput(f.config,worktree),/without aliases/);assert.equal(fs.lstatSync(publish).isSymbolicLink(),true);assert.equal(fs.readFileSync(path.join(foreign,'publish','keep.txt'),'utf8'),'keep');
 const outside=path.join(f.root,'outside-checkout');fs.mkdirSync(outside);assert.throws(()=>isolateNativeOutput(f.config,outside),/separate worktree/);assert.throws(()=>isolateNativeOutput(f.config,f.repo),/separate worktree/);
 const plain=f.worktree('regular-file');fs.writeFileSync(path.join(plain,'native','publish'),'not an output directory');assert.throws(()=>isolateNativeOutput(f.config,plain),/real directory or approved/);assert.equal(fs.readFileSync(path.join(plain,'native','publish'),'utf8'),'not an output directory');
});
