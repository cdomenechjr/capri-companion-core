import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {Config,State,TaskSpec,Activity} from './types';
import {validateReleaseVersionConfig,releaseMetadataPaths} from './versioning';

export function atomicJson(file:string,value:unknown){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
export function exclusiveJson(file:string,value:unknown){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});try{fs.linkSync(tmp,file);}catch(error:any){if(error.code==='EEXIST')throw Object.assign(Error('A coordinator control request is already pending; wait for acceptance before sending another.'),{code:'EEXIST'});throw error;}}finally{try{fs.unlinkSync(tmp);}catch(error:any){if(error.code!=='ENOENT')throw error;}}}
export function readJson<T>(file:string):T{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
export function isAlive(pid:number){try{process.kill(pid,0);return true;}catch(e:any){return e.code==='EPERM';}}
export function within(root:string,target:string){const rel=path.relative(path.resolve(root),path.resolve(target));return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
export function safeRelative(file:string){return typeof file==='string'&&file.length>0&&!file.includes('\\')&&!file.startsWith('/')&&!file.includes(':')&&!file.split('/').some(p=>p==='..'||p==='.git'||p==='.env'||p.startsWith('.env.'));}
export function allowedFile(file:string,allowed:string[]){return safeRelative(file)&&allowed.some(rule=>rule.endsWith('/')?file.startsWith(rule):file===rule);}
export function fingerprint(spec:TaskSpec){return crypto.createHash('sha256').update(JSON.stringify([spec.goal.toLowerCase().replace(/\s+/g,' ').trim(),[...spec.allowedPaths].sort()])).digest('hex');}
export function validateSpec(value:any,checks:string[]):asserts value is TaskSpec{
 if(!value||typeof value!=='object'||!/^[-a-zA-Z0-9_]{1,80}$/.test(value.id)||!['codex','claude'].includes(value.owner)||typeof value.goal!=='string'||!value.goal.trim())throw Error('Invalid task identity/goal');
 for(const field of ['allowedPaths','dependencies','resources','acceptance'])if(!Array.isArray(value[field])||value[field].some((v:any)=>typeof v!=='string'))throw Error('Invalid task '+field);
 if(!value.allowedPaths.length||value.allowedPaths.some((p:string)=>!safeRelative(p)))throw Error('Task requires safe explicit allowedPaths');
 if(value.dependencies.includes(value.id)||value.acceptance.length===0||value.acceptance.some((id:string)=>!checks.includes(id)))throw Error('Invalid dependencies or acceptance checks');
}
// The model supplies five planning fields, never a checkout, commit, lifecycle,
// release kind, dependency, acceptance override, or any other runtime authority.
export function projectProposal(value:any,checks:string[]):TaskSpec{
 const fields=['id','owner','goal','allowedPaths','resources'];
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).some(key=>!fields.includes(key))||fields.some(key=>!Object.hasOwn(value,key)))throw Error('Model proposal contains fields outside the planning contract.');
 if(!Array.isArray(value.allowedPaths)||!Array.isArray(value.resources))throw Error('Invalid model proposal paths/resources.');
 const spec:TaskSpec={id:value.id,owner:value.owner,goal:value.goal,allowedPaths:[...value.allowedPaths],resources:[...value.resources],dependencies:[],acceptance:[...checks],priority:0};validateSpec(spec,checks);
 if(spec.allowedPaths.some(rule=>releaseMetadataPaths.some(file=>file===rule||rule.endsWith('/')&&file.startsWith(rule))))throw Error('Automatic proposals cannot own release metadata; use narrower product paths.');
 return spec;
}
export function loadConfig(file:string):Config{
 const raw=readJson<any>(file);const repo=path.resolve(path.dirname(file),'../..',raw.repo||'.');const defaults={version:1,developmentRoot:'..',stateDir:'../runtime/coordinator',worktreeRoot:'../worktrees',profileRoot:'../profiles',referenceRoot:'../references/mochiiwuff-capri-desktop',candidateBranch:'codex/candidate',continuous:false,timeoutMs:3600000,maxRepairAttempts:1,pollMs:30000,maxProposalsPerCycle:2,maxQueuedTasks:12,proposalAllowedPaths:['src/','tests/'],roadmapFile:'development/ROADMAP.md'};
 const config={...defaults,...raw,repo} as Config;
 config.operatorAllowedPaths=config.operatorAllowedPaths??[...config.proposalAllowedPaths];
 for(const key of ['developmentRoot','stateDir','worktreeRoot','profileRoot','referenceRoot','tasksFile','roadmapFile'] as const)config[key]=path.resolve(repo,config[key]);
 config.prompts=Object.fromEntries(Object.entries(config.prompts||{}).map(([k,v])=>[k,path.resolve(repo,v)])) as Config['prompts'];
 if(config.version!==1||!config.agents?.codex?.command||!config.agents?.claude?.command||!Array.isArray(config.checks)||config.checks.length===0)throw Error('Invalid coordinator config');
 if(!/^codex\/[a-z0-9._/-]+$/i.test(config.candidateBranch)||config.candidateBranch.includes('..'))throw Error('Candidate branch must use codex/ prefix');
 if(!Number.isFinite(config.timeoutMs)||config.timeoutMs<1000||config.timeoutMs>3600000||config.maxRepairAttempts<0||config.maxRepairAttempts>1||config.maxProposalsPerCycle<1||config.maxProposalsPerCycle>4)throw Error('Invalid coordinator bounds');
 const checkIds=new Set<string>();
 for(const check of config.checks){if(!/^[a-z0-9_-]+$/i.test(check.id)||checkIds.has(check.id)||typeof check.command!=='string'||!Array.isArray(check.args)||check.args.some(v=>typeof v!=='string')||check.scope!==undefined&&check.scope!=='task')throw Error('Invalid check');checkIds.add(check.id);}
 validateReleaseVersionConfig(config.releaseVersioning);
 if(!within(config.developmentRoot,config.stateDir)||!within(config.developmentRoot,config.worktreeRoot)||!within(config.developmentRoot,config.profileRoot))throw Error('Runtime paths must remain inside developmentRoot');
 if(within(config.repo,config.stateDir)||within(config.repo,config.worktreeRoot))throw Error('State and worktrees must be outside repo');
 return config;
}
export function validateDependencyGraph(tasks:Pick<TaskSpec,'id'|'dependencies'>[]){const byId=new Map<string,Pick<TaskSpec,'id'|'dependencies'>>();for(const task of tasks){if(byId.has(task.id))throw Error('Duplicate task '+task.id);if(!Array.isArray(task.dependencies)||task.dependencies.some(id=>typeof id!=='string'))throw Error('Invalid task dependencies');byId.set(task.id,task);}for(const task of tasks)for(const dep of task.dependencies)if(!byId.has(dep))throw Error('Unknown dependency '+dep);const visiting=new Set<string>(),visited=new Set<string>();function visit(id:string){if(visiting.has(id))throw Error('Cyclic task dependency');if(visited.has(id))return;visiting.add(id);for(const dep of byId.get(id)!.dependencies)visit(dep);visiting.delete(id);visited.add(id);}for(const task of tasks)visit(task.id);}
export function readTasks(config:Config):TaskSpec[]{const specs=readJson<TaskSpec[]>(config.tasksFile);if(!Array.isArray(specs))throw Error('Task file must be an array');for(const spec of specs)validateSpec(spec,config.checks.map(c=>c.id));validateDependencyGraph(specs);return specs;}
export class Lease{
 token=crypto.randomUUID();held=false;
 constructor(readonly file:string){}
 acquire(){fs.mkdirSync(path.dirname(this.file),{recursive:true});try{const fd=fs.openSync(this.file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token:this.token,startedAt:new Date().toISOString()}));fs.closeSync(fd);this.held=true;}catch(e:any){if(e.code!=='EEXIST')throw e;let previous:any;try{previous=readJson(this.file);}catch{throw Error('Coordinator lock is unreadable; inspect it before recovery');}if(isAlive(previous.pid))throw Error('Coordinator already running with PID '+previous.pid);fs.unlinkSync(this.file);this.acquire();}}
 release(){if(!this.held)return;try{if(readJson<any>(this.file).token===this.token)fs.unlinkSync(this.file);}finally{this.held=false;}}
}
export function saveState(file:string,state:State){state.updatedAt=new Date().toISOString();state.generation++;atomicJson(file,state);}
export function redact(text:string){return text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g,'[redacted]').replace(/(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[^\s"']+/gi,'$1[redacted]');}
export function appendEvent(file:string,event:Activity,seen:Set<string>){if(seen.has(event.id))return false;seen.add(event.id);fs.mkdirSync(path.dirname(file),{recursive:true});fs.appendFileSync(file,JSON.stringify({...event,summary:redact(event.summary).slice(0,2000)})+'\n',{mode:0o600});return true;}
