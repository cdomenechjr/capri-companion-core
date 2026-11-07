import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import {allowedFile,within} from './storage';
import {runCommand} from './process';
import type {Config,Task,CheckResult} from './types';
import {assertReleaseFinalizationDiff,releaseMetadataPaths} from './versioning';

export function git(cwd:string,...args:string[]){return execFileSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true,maxBuffer:10*1024*1024}).trim();}
export function gitRaw(cwd:string,...args:string[]){return execFileSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true,maxBuffer:10*1024*1024});}
export function linkDirectory(target:string,link:string){if(fs.existsSync(link))return;if(!fs.existsSync(target))return;fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(target,link,process.platform==='win32'?'junction':'dir');}
function realNativeParent(directory:string){
 if(!path.isAbsolute(directory)||path.resolve(directory)!==directory||/^[\\/]{2}|[\x00-\x1f]/.test(directory))throw Error('Native output requires an absolute local directory without traversal');
 let current=path.parse(directory).root;for(const part of path.relative(current,directory).split(path.sep).filter(Boolean)){current=path.join(current,part);const info=fs.lstatSync(current);if(info.isSymbolicLink()||!info.isDirectory())throw Error('Native output parents must be real directories without aliases');}
 // Resolve ordinary OS 8.3/case spellings only after rejecting every reparse
 // ancestor. Containment and legacy-target comparison then use physical paths.
 return fs.realpathSync.native(directory);
}
export function isolateNativeOutput(config:Pick<Config,'repo'|'worktreeRoot'>,worktree:string):{path:string;status:'absent'|'preserved'|'unlinked'}{
 const root=realNativeParent(config.worktreeRoot),checkout=realNativeParent(worktree),repo=realNativeParent(config.repo);
 if(checkout===root||!within(root,checkout)||within(repo,checkout)||within(checkout,repo))throw Error('Native output isolation requires a separate worktree inside worktreeRoot');
 const native=path.join(checkout,'native'),publish=path.join(native,'publish');
 let parent;try{parent=fs.lstatSync(native);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {path:publish,status:'absent'};throw error;}
 if(parent.isSymbolicLink()||!parent.isDirectory())throw Error('Worktree native parent must be a real directory');realNativeParent(native);
 let entry;try{entry=fs.lstatSync(publish);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {path:publish,status:'absent'};throw error;}
 if(!entry.isSymbolicLink()){if(!entry.isDirectory())throw Error('Worktree native/publish must be a real directory or approved legacy link');return {path:publish,status:'preserved'};}
 // Inspect the canonical native tree only for a legacy link. Fresh source
 // builds do not require a canonical native/publish or a prebuilt helper.
 const expected=realNativeParent(path.join(repo,'native','publish'));
 let physical;try{physical=fs.realpathSync.native(publish);}catch{throw Error('Legacy native output link has an unavailable target');}
 const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
 if(!same(physical,expected))throw Error('Native output link does not target canonical native/publish');
 const after=fs.lstatSync(publish);if(!after.isSymbolicLink()||after.dev!==entry.dev||after.ino!==entry.ino||!same(fs.realpathSync.native(publish),expected))throw Error('Legacy native output link changed during validation');
 fs.unlinkSync(publish); // Remove this link only. Never recurse into its target.
 try{fs.lstatSync(publish);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {path:publish,status:'unlinked'};throw error;}
 throw Error('Legacy native output link removal could not be confirmed');
}
export function runtimeLinks(config:Config,worktree:string){isolateNativeOutput(config,worktree);linkDirectory(path.join(config.repo,'node_modules'),path.join(worktree,'node_modules'));linkDirectory(path.join(config.developmentRoot,'runtime','models'),path.join(worktree,'models'));}
export function prepareCandidate(config:Config){const candidate=path.join(config.worktreeRoot,'candidate');const canonical=(p:string)=>{const resolved=fs.realpathSync.native(path.resolve(p));return process.platform==='win32'?resolved.toLowerCase():resolved;};fs.mkdirSync(config.worktreeRoot,{recursive:true});if(fs.existsSync(candidate)){if(canonical(git(candidate,'rev-parse','--show-toplevel'))!==canonical(candidate)||git(candidate,'branch','--show-current')!==config.candidateBranch)throw Error('Candidate checkout has unexpected identity');if(changedFiles(candidate).length)throw Error('Candidate has uncommitted content; preserve/review before starting');}else{let branchExists=true;try{git(config.repo,'rev-parse','--verify',config.candidateBranch);}catch{branchExists=false;}git(config.repo,'worktree','add',...(branchExists?[]:['-b',config.candidateBranch]),candidate,branchExists?config.candidateBranch:'HEAD');}runtimeLinks(config,candidate);return candidate;}
export function prepareTask(config:Config,task:Task,candidate:string,runId:string){
 const suffix=runId.slice(0,8)+'-'+task.attempts;const name=task.owner+'-'+task.id+'-'+suffix;const worktree=path.resolve(config.worktreeRoot,name);if(!within(config.worktreeRoot,worktree))throw Error('Unsafe worktree path');
 const branch='codex/'+name;git(config.repo,'worktree','add','-b',branch,worktree,git(candidate,'rev-parse','HEAD'));runtimeLinks(config,worktree);task.worktree=worktree;task.branch=branch;task.baseCommit=git(worktree,'rev-parse','HEAD');task.profile=path.join(config.profileRoot,name);fs.mkdirSync(task.profile,{recursive:true});task.port=18600+(task.owner==='codex'?0:100)+(task.attempts%50);return worktree;
}
export function prepareIntegrationRepair(config:Config,task:Task,candidate:string,runId:string,commit:string){
 const previousWorktree=task.worktree,previousBase=task.baseCommit,feedback=task.error;git(config.repo,'update-ref','refs/capri/integration-repairs/'+task.id+'/'+crypto.randomUUID(),commit);prepareTask(config,task,candidate,runId);task.integrationRepairHistory=[...(task.integrationRepairHistory||[]),{at:new Date().toISOString(),commit,previousWorktree,previousBase,repairWorktree:task.worktree!,candidateCommit:task.baseCommit!}];
 try{git(task.worktree!,'cherry-pick','--no-commit',commit);}catch(error){if(!git(task.worktree!,'diff','--name-only','--diff-filter=U'))throw error;git(task.worktree!,'cherry-pick','--quit');}
 task.commit=undefined;task.review=undefined;checkScope(task);task.error='Integration repair on current candidate '+task.baseCommit+'. Prior approved commit '+commit+' has been applied. Resolve any conflict markers only inside the assigned files; preserve the current candidate interfaces and behavior. The coordinator handles staging and commits.\n'+(feedback||'');return task.worktree!;
}
export function changedFiles(worktree:string,base?:string){const ref=base||'HEAD';const tracked=gitRaw(worktree,'diff','--no-renames','--name-only','-z',ref).split('\0');const staged=gitRaw(worktree,'diff','--cached','--no-renames','--name-only','-z',ref).split('\0');const untracked=gitRaw(worktree,'ls-files','--others','--exclude-standard','-z').split('\0');return [...new Set([...tracked,...staged,...untracked].filter(Boolean))].sort();}
export function refreshCleanIndex(worktree:string){const dirty=changedFiles(worktree);if(dirty.length)throw Error('Candidate has uncommitted content; integration stopped: '+dirty.join(', '));const expected=git(worktree,'rev-parse','HEAD^{tree}'),before=git(worktree,'write-tree');if(before!==expected)throw Error('Candidate index differs from HEAD; integration stopped');git(worktree,'add','--renormalize','--','.');if(git(worktree,'write-tree')!==expected){git(worktree,'read-tree',before);throw Error('Index renormalization changed candidate content; original index restored without changing files');}if(changedFiles(worktree).length)throw Error('Candidate content changed during index refresh; integration stopped');}
export function checkScope(task:Task){const files=changedFiles(task.worktree!,task.baseCommit);for(const file of files){if(!allowedFile(file,task.allowedPaths))throw Error('Task changed an unowned file: '+file);if(task.origin==='continuous'&&releaseMetadataPaths.some(metadata=>metadata.toLowerCase()===file.toLowerCase()))throw Error('A model-proposed product task cannot edit release metadata: '+file);const target=path.resolve(task.worktree!,file);if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('Worker-created symbolic link is not allowed: '+file);if(fs.existsSync(target)&&!within(task.worktree!,fs.realpathSync(target)))throw Error('Changed path escapes worktree: '+file);}if(task.kind==='release-finalization')assertReleaseFinalizationDiff(task);return files;}
export function snapshotTask(task:Task){const files=checkScope(task);if(!files.length)return undefined;git(task.worktree!,'add','--',...files);const tree=git(task.worktree!,'write-tree');const previous=git(task.worktree!,'rev-parse','HEAD');git(task.worktree!,'update-ref','refs/capri/attempts/'+task.id+'/'+crypto.randomUUID(),previous);task.commit=git(task.worktree!,'-c','user.name=Capri Coordinator','-c','user.email=capri-coordinator@localhost','commit-tree',tree,'-p',task.baseCommit!,'-m',task.id+': '+task.result!.summary.slice(0,150)+'\n\nCapri-Task: '+task.id);git(task.worktree!,'reset','--soft',task.commit);return task.commit;}
function expandArgs(args:string[],cwd:string){return args.flatMap(arg=>{if(!arg.includes('*'))return [arg];const dir=path.dirname(arg),base=path.basename(arg),pattern=new RegExp('^'+base.split('*').map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$');const expanded=fs.readdirSync(path.resolve(cwd,dir)).filter(name=>pattern.test(name)).sort().map(name=>path.join(dir,name));if(!expanded.length)throw Error('Check glob matched no files: '+arg);return expanded;});}
export async function validate(config:Config,ids:string[],cwd:string,signal?:AbortSignal){const results:CheckResult[]=[];for(const id of ids){const check=config.checks.find(c=>c.id===id);if(!check)throw Error('Unknown check '+id);const result=await runCommand(check.command,expandArgs(check.args,cwd),cwd,check.timeoutMs||300000,signal);results.push({id,passed:result.code===0,...result});if(result.code!==0)break;}return results;}
// A registered task-specific gate may depend on source introduced by that task.
// Global regressions always run, and every assigned acceptance gate remains mandatory.
export function candidateCheckIds(config:Config,task:Pick<Task,'acceptance'>,completedChecks:string[]=[]){
 const known=new Set(config.checks.map(check=>check.id));
 const required=new Set([...task.acceptance,...completedChecks]);
 if([...required].some(id=>!known.has(id)))throw Error('Unknown candidate acceptance check');
 return config.checks.filter(check=>check.scope!=='task'||required.has(check.id)).map(check=>check.id);
}
export async function integrate(config:Config,task:Task,candidate:string,signal?:AbortSignal,completedChecks:string[]=[]){
 if(!task.commit)throw Error('Cannot integrate a task without a commit');refreshCleanIndex(candidate);const before=git(candidate,'rev-parse','HEAD');
 try{git(candidate,'cherry-pick',task.commit);const checks=await validate(config,candidateCheckIds(config,task,completedChecks),candidate,signal);if(checks.some(c=>!c.passed))throw Error('Combined candidate checks failed:\n'+checks.filter(c=>!c.passed).map(c=>c.id+': '+c.output).join('\n'));const dirty=changedFiles(candidate);if(dirty.length)throw Error('Validation changed candidate content: '+dirty.join(', '));return {commit:git(candidate,'rev-parse','HEAD'),checks};}
 catch(error){const evidence=path.join(config.stateDir,'integration-failures',task.id+'-'+Date.now());fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'status.txt'),gitRaw(candidate,'status','--porcelain'));fs.writeFileSync(path.join(evidence,'tracked.patch'),gitRaw(candidate,'diff','HEAD'));fs.writeFileSync(path.join(evidence,'error.txt'),String(error));try{git(candidate,'cherry-pick','--abort');}catch{/* Failed checks occur after completed cherry-pick. */}if(!within(config.worktreeRoot,candidate)||path.basename(candidate)!=='candidate')throw Error('Refusing rollback outside candidate');git(candidate,'reset','--hard',before);throw Error(String(error)+'\nCandidate restored to '+before+'. Diagnostics preserved: '+evidence);}
}
