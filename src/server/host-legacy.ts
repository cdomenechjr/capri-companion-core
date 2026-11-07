import { readFile, writeFile, readdir, mkdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { diffLines } from 'diff';
import { Store } from './store';
import { readPublicPage } from './public-page';
import { Settings } from '../shared';
import { allowedPath, NoSideEffectError, publicUrl } from './policy';
export type Approval = (summary:string,details:any,signal:AbortSignal)=>Promise<boolean>;
export type Native = (action:string,args:any,signal:AbortSignal)=>Promise<any>;
export class LegacyHostTools {
 constructor(private store:Store,private settings:()=>Promise<Settings>,private approve:Approval,private native:Native){}
 async require(summary:string,args:any,signal:AbortSignal){if(!await this.approve(summary,args,signal))throw new NoSideEffectError('You declined this action.',403);signal.throwIfAborted();}
 async run(name:string,args:any,signal:AbortSignal):Promise<any>{signal.throwIfAborted();const settings=await this.settings();
  if(name==='list_files'){const p=await allowedPath(settings.roots,args.path||'.');return (await readdir(p,{withFileTypes:true})).slice(0,250).filter(d=>!d.name.startsWith('.')).map(d=>({name:d.name,directory:d.isDirectory()}));}
  if(name==='read_file'){const p=await allowedPath(settings.roots,args.path);if((await stat(p)).size>128000)throw new NoSideEffectError('Use a file under 128 KB.');return {path:p,content:await readFile(p,'utf8'),untrusted:true};}
  if(name==='write_file'){if(typeof args.content!=='string'||args.content.length>128000)throw new NoSideEffectError('File content exceeds 128 KB.');const p=await allowedPath(settings.roots,args.path,true);if(!/\.(txt|md|json|csv|tsv|xml|yaml|yml|toml|ini|cfg|log|html|css|js|ts|jsx|tsx|py|cs|cpp|c|h|kt|java|sql|save)$/i.test(p))throw new NoSideEffectError('This file extension needs a dedicated editor.');let before:string|null=null;try{before=await readFile(p,'utf8');}catch(e:any){if(e.code!=='ENOENT')throw e;}const backup=await this.store.put('backup',{path:p,before,afterHash:createHash('sha256').update(args.content).digest('hex')});signal.throwIfAborted();await mkdir(path.dirname(p),{recursive:true});await writeFile(p,args.content,'utf8');return {path:p,backupId:backup.id,diff:diffLines(before||'',args.content).map(p=>({added:p.added||false,removed:p.removed||false,value:p.value})),verified:(await readFile(p,'utf8'))===args.content};}
  if(name==='restore_file'){const backup=await this.store.get('backup',args.backupId);if(!backup)throw new NoSideEffectError('Backup not found.',404);const p=await allowedPath(settings.roots,backup.path,true);if(backup.before===null)throw new NoSideEffectError('This backup represents a new file. Delete it manually if no longer needed.');const now=await readFile(p,'utf8');if(createHash('sha256').update(now).digest('hex')!==backup.afterHash)await this.require('Restore over a file that changed after the backup?',{path:p},signal);await writeFile(p,backup.before,'utf8');return {restored:true,path:p};}
  if(name==='open_app'){const apps:Record<string,string>={notepad:'notepad.exe',calculator:'calc.exe',explorer:'explorer.exe'};if(!apps[args.app])throw new NoSideEffectError('App is not approved.');return this.native('launch',{app:apps[args.app]},signal);}
  if(name==='inspect_desktop'){if(args.windowId)await this.require('Share a screenshot and accessibility text of this window with the AI?',{windowId:args.windowId},signal);return this.native(args.windowId?'inspect':'windows',args,signal);}
  if(name==='desktop_input'){if(!Number.isSafeInteger(args.windowId)||!['click','type','key'].includes(args.action))throw new NoSideEffectError('Invalid desktop action.');await this.require('Allow this desktop input?',args,signal);return this.native(args.action,args,signal);}
  if(name==='run_command'){if(!args.target||!args.command||args.command.length>8000)throw new NoSideEffectError('An exact command and target are required.');await this.require('Run this command against the stated target?',args,signal);const cwd=await realpath(settings.roots[0]);return new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',args.command],{cwd,windowsHide:true,signal,env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,USERPROFILE:process.env.USERPROFILE}});let output='';const timer=setTimeout(()=>child.kill(),30000);child.stdout.on('data',b=>{if(output.length<64000)output+=b.toString();});child.stderr.on('data',b=>{if(output.length<64000)output+=b.toString();});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);resolve({code,output,untrusted:true});});});}
  if(name==='browser_read'){const url=await publicUrl(args.url);await this.require('Fetch this public page through your desktop connection?',{url:url.href},signal);return readPublicPage(url.href,signal);}
  throw new NoSideEffectError('Host tool unavailable: '+name);
 }
}


