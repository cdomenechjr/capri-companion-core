// Operator-only offline signing CLI. No installation/publication or key generation.
// Usage: node scripts/sign-release.mjs <outside-source-config.json> <release.json>
//        <independent-attestation.json> <output.json> <exact-commit>
// Config: {schemaVersion:1,keyId,keyFile,attestationKeys:{id:Ed25519PublicPEM},workspaceRoots:[...]}
// Config, key and attestation must be outside all source roots (including all sibling
// worktrees), protected by operator ACLs. Workspace roots only add exclusions. The signer
// does not accept a worker's self-signed check result. The operator pins independent
// attestation keys in this external config, never in release.json or the attestation.
// Attestation envelope: {evidence,signature:{algorithm:'ed25519',keyId,value}} where evidence
// is {schemaVersion:1,commit,releaseSha256,artifacts:[{sha256,bytes}],owner,reviewer,
//     checkedAt,expiresAt,checks:{typecheck:'passed',test:'passed',build:'passed'},review:'passed'}.
// releaseSha256 is SHA256(canonical release payload), binding version, sequence, schema,
// channel, timestamps and every artifact. The independent check authority must attest
// this exact commit/archive after real checks + review. This CLI cannot create evidence.
import * as fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const hex=/^[a-f0-9]{64}$/;
const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const validId=v=>typeof v==='string'&&v.length<=200&&id.test(v)&&!/[\r\n]/.test(v);
const semver=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/;
const digest=b=>createHash('sha256').update(b).digest('hex');
const integer=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
const shape=(o,keys,optional=[])=>o&&typeof o==='object'&&!Array.isArray(o)&&keys.every(k=>Object.hasOwn(o,k))&&Object.keys(o).every(k=>keys.includes(k)||optional.includes(k));
export function canonicalReleaseJson(value){
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonicalReleaseJson).join(',')+']';
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalReleaseJson(value[k])).join(',')+'}';
 throw Error('Non-canonical release value.');
}
export function validateSigningRelease(r){
 if(!shape(r,['schemaVersion','version','sequence','channel','publishedAt','expiresAt','migration','artifacts'])||r.schemaVersion!==1||typeof r.version!=='string'||r.version.length>80||!semver.test(r.version)||!integer(r.sequence,1)||!['stable','preview'].includes(r.channel)||!integer(r.publishedAt)||!integer(r.expiresAt)||r.expiresAt<=r.publishedAt)throw Error('Invalid release payload.');
 const m=r.migration;
 if(!shape(m,['readMin','readMax','writeVersion','backupRequired','reversible'])||!integer(m.readMin,1)||!integer(m.readMax,1)||!integer(m.writeVersion,1)||m.readMin>m.readMax||m.writeVersion<m.readMin||m.writeVersion>m.readMax||m.backupRequired!==true||typeof m.reversible!=='boolean')throw Error('Invalid migration compatibility.');
 if(!Array.isArray(r.artifacts)||!r.artifacts.length||r.artifacts.length>8)throw Error('Invalid release artifacts.');
 const seen=new Set();
 for(const a of r.artifacts){
  if(!shape(a,['platform','arch','url','sha256','bytes'],['publisherKeyId'])||!['win32','android'].includes(a.platform)||!['x64','arm64'].includes(a.arch)||typeof a.url!=='string'||!hex.test(a.sha256)||!integer(a.bytes,1)||a.publisherKeyId!==undefined&&!validId(a.publisherKeyId))throw Error('Invalid release artifact.');
  const url=new URL(a.url),target=a.platform+':'+a.arch;
  if(url.protocol!=='https:'||url.username||url.password||url.hash||seen.has(target))throw Error('Unsafe or duplicate artifact target.');seen.add(target);
 }return r;
}
export function verifySigningAttestation(envelope,release,{trustedKeys,commit,now=Date.now()}){
 validateSigningRelease(release);
 if(!shape(envelope,['evidence','signature'])||!shape(envelope.signature,['algorithm','keyId','value']))throw Error('Independent attestation required.');
 const e=envelope.evidence,s=envelope.signature;
 if(!shape(e,['schemaVersion','commit','releaseSha256','artifacts','owner','reviewer','checkedAt','expiresAt','checks','review'])||e.schemaVersion!==1||typeof e.commit!=='string'||!/^([a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/.test(e.commit)||e.commit!==commit||e.releaseSha256!==digest(canonicalReleaseJson(release))||!validId(e.owner)||!validId(e.reviewer)||e.owner===e.reviewer||e.review!=='passed'||!shape(e.checks,['typecheck','test','build'])||Object.values(e.checks).some(v=>v!=='passed')||!integer(now)||!integer(e.checkedAt)||!integer(e.expiresAt)||e.checkedAt>now||e.expiresAt<=now||e.expiresAt<=e.checkedAt||now-e.checkedAt>86400000||!Array.isArray(e.artifacts)||canonicalReleaseJson(e.artifacts)!==canonicalReleaseJson(release.artifacts.map(({sha256,bytes})=>({sha256,bytes}))))throw Error('Attestation is stale, incomplete or bound to different bytes/commit.');
 const pem=Object.hasOwn(trustedKeys,s.keyId)?trustedKeys[s.keyId]:undefined;
 if(s.algorithm!=='ed25519'||!validId(s.keyId)||!pem||typeof s.value!=='string'||s.value.length!==88||!/^[A-Za-z0-9+/]{86}==$/.test(s.value))throw Error('Untrusted independent attestation.');
 const key=createPublicKey(pem);
 if(key.asymmetricKeyType!=='ed25519'||!verify(null,Buffer.from(canonicalReleaseJson(e)),key,Buffer.from(s.value,'base64')))throw Error('Invalid independent attestation signature.');
 return e;
}
function noAliases(file){
 const absolute=path.resolve(file);let cursor=absolute;
 for(;;){const s=fs.lstatSync(cursor);if(s.isSymbolicLink()||!s.isDirectory()&&!s.isFile()||s.isFile()&&s.nlink!==1)throw Error('Operator file aliases are forbidden.');const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
 if(fs.realpathSync(absolute).toLowerCase()!==absolute.toLowerCase())throw Error('Operator file aliases are forbidden.');return absolute;
}
function outside(file,roots){const resolved=noAliases(file);if(!path.isAbsolute(file)||roots.some(root=>{const r=path.resolve(root).toLowerCase(),v=resolved.toLowerCase();return v===r||v.startsWith(r+path.sep);}))throw Error('Operator trust and signing material must be outside source workspaces.');
 let cursor=path.dirname(resolved);for(;;){if(fs.existsSync(path.join(cursor,'.git')))throw Error('Operator material cannot be in a Git checkout.');const next=path.dirname(cursor);if(next===cursor)break;cursor=next;}return resolved;}
function operatorOnly(file){
 if(process.platform!=='win32'){
  const s=fs.statSync(file);if((s.mode&0o077)!==0||s.uid!==process.getuid())throw Error('Operator-only permissions required.');return;
 }
 // Check actual Windows reparse attributes and ACL SIDs; do not infer ownership from
 // a file name. SYSTEM/Administrators and the invoking operator are the only readers.
 const encoded=Buffer.from(file).toString('base64');
 const script="$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'));$allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544');$acl=Get-Acl -LiteralPath $p;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;if($allowed -notcontains $owner){throw 'Operator ownership required'};foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value){throw 'Operator-only permissions required'}};while($p){$i=Get-Item -LiteralPath $p -Force;if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Operator aliases forbidden'};if($i.PSIsContainer){$a=Get-Acl -LiteralPath $p;foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $allowed -notcontains $r.IdentityReference.Value -and ([long]$r.FileSystemRights -band 852306) -ne 0){throw 'Operator parent directory is writable by another identity'}}};$p=[IO.Path]::GetDirectoryName($p)}";
 execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,stdio:'pipe'});
}
function bounded(file,max){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.nlink!==1||stat.size>max)throw Error('Invalid operator input.');return fs.readFileSync(file);}
export async function signReleaseFiles({configFile,releaseFile,attestationFile,outputFile,commit,now=Date.now()}){
 const checkout=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),parent=path.dirname(checkout);
 const developmentRoot=path.basename(parent).toLowerCase()==='worktrees'?path.dirname(parent):parent;
 const fixedRoots=[checkout,path.join(developmentRoot,'capri'),path.join(developmentRoot,'worktrees'),path.join(developmentRoot,'candidate')];
 const configPath=outside(configFile,fixedRoots);operatorOnly(configPath);const config=JSON.parse(bounded(configPath,65536).toString());
 if(!shape(config,['schemaVersion','keyId','keyFile','attestationKeys','workspaceRoots'])||config.schemaVersion!==1||!validId(config.keyId)||typeof config.keyFile!=='string'||!config.attestationKeys||Array.isArray(config.attestationKeys)||!Object.keys(config.attestationKeys).length||!Array.isArray(config.workspaceRoots)||config.workspaceRoots.some(r=>typeof r!=='string'||!path.isAbsolute(r)))throw Error('Invalid external operator signing config.');
 const roots=[...fixedRoots,...config.workspaceRoots];outside(configPath,roots);const keyFile=outside(config.keyFile,roots),attestation=outside(attestationFile,roots);
 operatorOnly(keyFile);operatorOnly(attestation);
 const release=validateSigningRelease(JSON.parse(bounded(noAliases(releaseFile),1024*1024).toString()));
 if(release.publishedAt>now||release.expiresAt<=now)throw Error('Release is not currently valid.');
 verifySigningAttestation(JSON.parse(bounded(attestation,1024*1024).toString()),release,{trustedKeys:config.attestationKeys,commit,now});
 // Read the private key only AFTER verifying exact independent acceptance. Never log it.
 const bytes=bounded(keyFile,16384);let key;
 try{key=createPrivateKey(bytes);}finally{bytes.fill(0);}
 if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 signing key required.');
 const envelope={release,signature:{algorithm:'ed25519',keyId:config.keyId,value:sign(null,Buffer.from(canonicalReleaseJson(release)),key).toString('base64')}};
 const output=path.resolve(outputFile);noAliases(path.dirname(output));
 // Exclusive output: preserve earlier signed artifacts; never replace trust/key/evidence files.
 const fd=fs.openSync(output,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(envelope,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 return {output,sha256:digest(canonicalReleaseJson(release)),sequence:release.sequence};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [configFile,releaseFile,attestationFile,outputFile,commit,...extra]=process.argv.slice(2);
  if(!configFile||!releaseFile||!attestationFile||!outputFile||!commit||extra.length)throw Error('Usage: node scripts/sign-release.mjs <external-config> <release.json> <external-attestation> <new-output.json> <exact-commit>');
  console.log(JSON.stringify(await signReleaseFiles({configFile,releaseFile,attestationFile,outputFile,commit})));
 }catch{console.error('Release signing refused. Verify external operator trust, exact independent check/review evidence, commit and artifact bytes.');process.exitCode=1;}
}
