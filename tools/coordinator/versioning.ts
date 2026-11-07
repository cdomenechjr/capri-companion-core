// Trusted coordinator policy. Models never select release versions or task kinds.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import type {Config,State,Task,ReleaseBatch,ReleaseFinalization,PublicationReceipt} from './types';

export const releaseIntentFile='development/release-intent.json';
export const releaseMetadataPaths=['package.json','src/version.ts',releaseIntentFile];
const hex=/^[a-f0-9]{64}$/,commit=/^[a-f0-9]{40}$/;
const digest=(value:unknown)=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const git=(repo:string,...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024}).trim();
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const same=(a:unknown,b:unknown)=>isDeepStrictEqual(canonical(a),canonical(b));
const integer=(value:unknown,min=0)=>Number.isSafeInteger(value)&&Number(value)>=min;
export const publicationReceiptFile=(config:Pick<Config,'developmentRoot'>)=>path.join(config.developmentRoot,'runtime','release-publication.json');
export const releaseVersioningEnabled=(config:Config)=>config.releaseVersioning?.enabled===true;
export const supersededFinalization=(task:Task)=>task.kind==='release-finalization'&&task.outcome==='superseded';

export function validateReleaseVersionConfig(value:unknown){
 if(value===undefined)return;
 const v=value as any;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(key=>!['enabled','previewPrefix'].includes(key))||typeof v.enabled!=='boolean'||typeof v.previewPrefix!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev$/.test(v.previewPrefix)||v.previewPrefix.length>60)throw Error('Release versioning requires an explicit enabled flag and approved X.Y.Z-dev preview prefix.');
}
export function receiptIdentity(value:Omit<PublicationReceipt,'id'>){return digest([value.schemaVersion,value.sourceCommit,value.version,value.sequence,value.manifestSha256,value.artifactSha256,value.artifactBytes,value.publisherKeyId,value.publishedAt]);}
export function validatePublicationReceipt(value:any):PublicationReceipt{
 const fields=['schemaVersion','sourceCommit','version','sequence','manifestSha256','artifactSha256','artifactBytes','publisherKeyId','publishedAt','id'];
 if(!value||Object.keys(value).length!==fields.length||fields.some(key=>!Object.hasOwn(value,key))||value.schemaVersion!==1||!commit.test(value.sourceCommit||'')||typeof value.version!=='string'||value.version.length>80||!integer(value.sequence,1)||!integer(value.artifactBytes,1)||!integer(value.publishedAt)||['manifestSha256','artifactSha256','publisherKeyId','id'].some(key=>!hex.test(value[key]||'')))throw Error('Invalid operator publication receipt.');
 const {id,...payload}=value;if(receiptIdentity(payload)!==id)throw Error('Publication receipt identity changed.');return value;
}
function unaliased(file:string){let current=path.parse(path.resolve(file)).root;for(const part of path.relative(current,path.resolve(file)).split(path.sep).filter(Boolean)){current=path.join(current,part);const info=fs.lstatSync(current);if(info.isSymbolicLink())throw Error('Release coordination paths must not contain aliases.');}}
export function readPublicationReceipt(config:Pick<Config,'developmentRoot'>){
 const file=publicationReceiptFile(config);if(!fs.existsSync(file))return undefined;unaliased(file);const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>16384)throw Error('Publication receipt must be a bounded operator-owned regular file.');
 return validatePublicationReceipt(JSON.parse(fs.readFileSync(file,'utf8')));
}
function packageContent(repo:string,ref:string){if(!git(repo,'ls-tree',ref,'--','package.json'))return null;const value=JSON.parse(git(repo,'show',ref+':package.json'));delete value.version;if(value.build?.directories)delete value.build.directories.output;return canonical(value);}
export function productPath(file:string){return file!=='src/version.ts'&&(file.startsWith('src/')||file.startsWith('native/')&&!/^native\/(?:publish|bin|obj)\//.test(file)||file.startsWith('assets/')||file.startsWith('android/app/src/main/java/')||['scripts/build.mjs','scripts/neutral-assets.mjs','pnpm-lock.yaml'].includes(file));}
export function productDigest(repo:string,ref:string){
 const entries=git(repo,'ls-tree','-r','-z',ref).split('\0').filter(Boolean).flatMap(entry=>{const separator=entry.indexOf('\t');const file=entry.slice(separator+1);return productPath(file)?[[file,entry.slice(0,separator)]]:[];});
 return digest([entries,packageContent(repo,ref)]);
}
export function planningDigest(config:Config,state:State,candidate:string){
 const ref=git(candidate,'rev-parse','HEAD'),files=git(candidate,'ls-tree','-r','-z',ref).split('\0').filter(entry=>entry.slice(entry.indexOf('\t')+1).startsWith('tests/'));
 return digest([productDigest(candidate,ref),files,fs.readFileSync(config.roadmapFile,'utf8'),fs.readFileSync(config.tasksFile,'utf8'),state.tasks.filter(task=>task.kind!=='release-finalization'&&!supersededFinalization(task)&&['blocked','failed'].includes(task.phase)).map(task=>[task.id,task.phase,task.error]).sort()]);
}
function previewNumber(version:string,prefix:string){const text=version.startsWith(prefix+'.')?version.slice(prefix.length+1):'';if(!/^(0|[1-9]\d*)$/.test(text)||!integer(Number(text),1))throw Error('Version is outside the approved preview line: '+prefix+'.N');return Number(text);}
const ancestor=(repo:string,older:string,newer:string)=>{try{git(repo,'merge-base','--is-ancestor',older,newer);return true;}catch{return false;}};
const active=(task:Task)=>!!task.run||['queued','running','review','integration'].includes(task.phase);
export function activeReleaseBatch(state:State){const rs=state.releaseVersioning;return rs?.batches.find(batch=>batch.contract.batchId===rs.pendingBatchId&&['queued','ready'].includes(batch.stage));}
export function supersedeReleaseBatch(state:State,batch:ReleaseBatch){
 batch.stage='superseded';if(state.releaseVersioning?.pendingBatchId===batch.contract.batchId)delete state.releaseVersioning.pendingBatchId;
 const task=state.tasks.find(row=>row.id===batch.taskId);if(task&&task.phase!=='completed'){task.outcome='superseded';task.phase='blocked';task.error='Coordinator superseded an obsolete release-metadata batch; no product acceptance was completed.';}
}

// Mutates coordinator-owned records only; callers persist under the coordinator lease.
export function planReleaseFinalization(config:Config,state:State,candidate:string):{changed:boolean;barrier:boolean;task?:Task}{
 if(!releaseVersioningEnabled(config))return {changed:false,barrier:false};validateReleaseVersionConfig(config.releaseVersioning);
 const prefix=config.releaseVersioning!.previewPrefix,head=git(candidate,'rev-parse','HEAD');
 if(head!==state.candidateCommit)throw Error('Candidate checkpoint changed before release finalization.');
 const rs=state.releaseVersioning??={batches:[]};if(!Array.isArray(rs.batches)||rs.batches.length>512)throw Error('Release batch history needs operator inspection.');
 let changed=false;const receipt=readPublicationReceipt(config);
 if(receipt){
  if(rs.anchor&&receipt.sequence===rs.anchor.sequence&&receipt.id!==rs.anchor.id)throw Error('Conflicting operator publication receipt.');
  if(!rs.anchor||receipt.sequence>rs.anchor.sequence){
   if(!ancestor(candidate,receipt.sourceCommit,head)||JSON.parse(git(candidate,'show',receipt.sourceCommit+':package.json')).version!==receipt.version)throw Error('Publication receipt is not an ancestor of this candidate/version.');
   previewNumber(receipt.version,prefix);rs.anchor=receipt;changed=true;
   for(const batch of rs.batches)if(batch.finalizedCommit===receipt.sourceCommit&&batch.contract.targetVersion===receipt.version){batch.stage='published';if(rs.pendingBatchId===batch.contract.batchId)delete rs.pendingBatchId;}
  }
 }
 let pending=activeReleaseBatch(state);
 const newProductQueue=state.tasks.some(task=>task.kind!=='release-finalization'&&active(task));
 if(pending&&(newProductQueue||!rs.anchor||!same(pending.contract.previous,{sourceCommit:rs.anchor.sourceCommit,version:rs.anchor.version,sequence:rs.anchor.sequence,receiptId:rs.anchor.id})||head!==(pending.stage==='ready'?pending.finalizedCommit:pending.contract.productCommit))){supersedeReleaseBatch(state,pending);changed=true;pending=undefined;}
 if(pending)return {changed,barrier:pending.stage==='ready'};
 if(!rs.anchor||newProductQueue||state.proposalRun||state.tasks.some(task=>active(task)||!supersededFinalization(task)&&['blocked','failed'].includes(task.phase)))return {changed,barrier:false};
 if(productDigest(candidate,rs.anchor.sourceCommit)===productDigest(candidate,head))return {changed,barrier:false};
 const contributors=state.tasks.filter(task=>task.kind!=='release-finalization'&&task.phase==='completed'&&task.outcome==='changed'&&task.commit&&task.integratedCommit&&task.integratedCommit!==rs.anchor!.sourceCommit&&ancestor(candidate,rs.anchor!.sourceCommit,task.integratedCommit)&&ancestor(candidate,task.integratedCommit,head)).map(task=>({id:task.id,implementationCommit:task.commit!,integrationCommit:task.integratedCommit!})).sort((a,b)=>a.id.localeCompare(b.id));
 if(!contributors.length)return {changed,barrier:false};
 const contentDigest=productDigest(candidate,head);
 const previousReady=rs.batches.find(batch=>batch.contract.previous.receiptId===rs.anchor!.id&&batch.contract.productDigest===contentDigest&&batch.finalizedCommit===head&&state.tasks.find(task=>task.id===batch.taskId)?.phase==='completed');
 if(previousReady){previousReady.stage='ready';rs.pendingBatchId=previousReady.contract.batchId;return {changed:true,barrier:true};}
 const batchId=digest([rs.anchor.id,head,contentDigest,contributors]),id='release-finalize-'+batchId.slice(0,24),existing=state.tasks.find(task=>task.id===id);
 if(existing)return {changed,barrier:!supersededFinalization(existing)};
 const metadata=JSON.parse(git(candidate,'show',head+':package.json'));
 const highest=Math.max(previewNumber(metadata.version,prefix),previewNumber(rs.anchor.version,prefix),...rs.batches.map(batch=>previewNumber(batch.contract.targetVersion,prefix)));
 if(!integer(highest+1,1))throw Error('Preview version sequence exhausted.');
 const targetVersion=prefix+'.'+(highest+1),contract:ReleaseFinalization={schemaVersion:1,batchId,previous:{sourceCommit:rs.anchor.sourceCommit,version:rs.anchor.version,sequence:rs.anchor.sequence,receiptId:rs.anchor.id},productCommit:head,productDigest:contentDigest,targetVersion,outputDirectory:'release-'+targetVersion+'-candidate',contributors};
 const task:Task={id,owner:'codex',kind:'release-finalization',origin:'coordinator',releaseFinalization:contract,goal:'Finalize the coordinator-prepared preview metadata only. The host chooses the version and exact release intent. Independent Claude review and all normal acceptance/integration checks remain required. Contract: '+JSON.stringify(contract),allowedPaths:[...releaseMetadataPaths],dependencies:contributors.map(row=>row.id),resources:['release-finalization'],acceptance:config.checks.map(check=>check.id),priority:1000,phase:'queued',attempts:0,fingerprint:digest(['host-release-finalization',batchId])};
 rs.batches.push({contract,taskId:id,stage:'queued'});rs.pendingBatchId=batchId;state.tasks.push(task);return {changed:true,barrier:false,task};
}
export class StaleReleaseFinalization extends Error{}
export function assertFinalizationCheckpoint(task:Task,state:State,candidate:string){
 const contract=task.releaseFinalization,batch=activeReleaseBatch(state);
 if(task.kind!=='release-finalization'||!contract||batch?.taskId!==task.id||batch.stage!=='queued'||git(candidate,'rev-parse','HEAD')!==contract.productCommit)throw new StaleReleaseFinalization('The coordinator release batch is obsolete; preserve its work and finalize the next product checkpoint.');
}
function preparedMetadata(task:Task){const contract=task.releaseFinalization;if(task.kind!=='release-finalization'||task.origin!=='coordinator'||!contract||!task.worktree||task.baseCommit!==contract.productCommit)throw Error('Only a coordinator-prepared release task can edit release metadata.');const original=JSON.parse(git(task.worktree,'show',contract.productCommit+':package.json'));original.version=contract.targetVersion;if(!original.build?.directories)throw Error('Candidate has no established packaging output.');original.build.directories.output=contract.outputDirectory;return original;}
export function writeReleaseFinalization(task:Task){
 const metadata=preparedMetadata(task),worktree=task.worktree!;if(git(worktree,'rev-parse','HEAD')!==task.releaseFinalization!.productCommit)throw new StaleReleaseFinalization('Finalization checkout no longer matches its prepared product checkpoint.');
 fs.writeFileSync(path.join(worktree,'package.json'),JSON.stringify(metadata,null,2)+'\n');fs.mkdirSync(path.dirname(path.join(worktree,releaseIntentFile)),{recursive:true});fs.writeFileSync(path.join(worktree,releaseIntentFile),JSON.stringify(task.releaseFinalization,null,2)+'\n');
 assertReleaseFinalizationDiff(task);
}
export function assertReleaseFinalizationDiff(task:Task){
 const expected=preparedMetadata(task),worktree=task.worktree!,contract=task.releaseFinalization!;
 const files=git(worktree,'diff','--name-only','--no-renames',contract.productCommit).split(/\r?\n/).filter(Boolean);
 if(files.some(file=>!['package.json',releaseIntentFile].includes(file)))throw Error('Release finalization changed files outside the prepared metadata patch.');
 const version=fs.readFileSync(path.join(worktree,'src','version.ts'),'utf8').replace(/\r\n/g,'\n').trim(),before=git(worktree,'show',contract.productCommit+':src/version.ts').replace(/\r\n/g,'\n').trim();
 if(version!==before||!/^import\s+metadata\s+from\s+['"]\.\.\/package\.json['"];\s*export\s+const\s+version\s*=\s*metadata\.version;?$/.test(version))throw Error('Preserve the package-derived src/version.ts single source of truth.');
 if(!same(JSON.parse(fs.readFileSync(path.join(worktree,'package.json'),'utf8')),expected)||!same(JSON.parse(fs.readFileSync(path.join(worktree,releaseIntentFile),'utf8')),contract))throw Error('Release metadata differs from the exact coordinator-prepared version/output/intent.');
}
export function markFinalizationIntegrated(state:State,task:Task,head:string){const batch=state.releaseVersioning?.batches.find(row=>row.taskId===task.id);if(task.kind!=='release-finalization'||!batch||batch.stage!=='queued')throw new StaleReleaseFinalization('Release finalization lost its prepared batch.');batch.stage='ready';batch.finalizedCommit=head;state.releaseVersioning!.pendingBatchId=batch.contract.batchId;}
