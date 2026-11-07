import { realpath, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import {TaskPaused} from '../agency';
export class CapriError extends Error {constructor(message:string,public status=400){super(message);}}
// Trusted guard provenance only: throw before dispatching the requested effect.
// A generic CapriError (or an error message from a tool) makes no such guarantee.
export class NoSideEffectError extends CapriError {}
// A resumable handoff from a trusted guard before the requested effect dispatches.
// Unlike ordinary TaskPaused, this establishes that retrying after resume is safe.
export class NoSideEffectPause extends TaskPaused {}
export function inside(root:string,target:string){const r=path.relative(root,target);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));}
export async function allowedPath(roots:string[],input:string,write=false){
 if(!roots.length)throw new NoSideEffectError('No workspace folder is configured.');
 const candidate=path.resolve(roots[0],input);const normalizedRoots=await Promise.all(roots.map(r=>realpath(r)));
 let probe=candidate,tail:string[]=[];while(true){try{const st=await lstat(probe);if(st.isSymbolicLink())throw new NoSideEffectError('Symbolic links are outside the file tool boundary.');break;}catch(e:any){if(e.code!=='ENOENT')throw e;const parent=path.dirname(probe);if(parent===probe)throw new NoSideEffectError('Path does not exist.');tail.unshift(path.basename(probe));probe=parent;}}
 const resolved=path.join(await realpath(probe),...tail);if(!normalizedRoots.some(r=>inside(r,resolved)))throw new NoSideEffectError('That path is outside your approved folders.',403);
 const rel=normalizedRoots.map(r=>inside(r,resolved)?path.relative(r,resolved):'').find(Boolean)||path.basename(resolved);
 if(rel.split(/[\\/]/).some(p=>/^\.env(?:\.|$)|^\.git$|^\.ssh$|^\.aws$|^credentials|^secret|^capri\.sqlite|^vault|\.pem$|\.pfx$|\.jks$/i.test(p)))throw new NoSideEffectError('Credential and application-state paths are blocked.',403);
 if(write&&resolved===normalizedRoots.find(r=>r===resolved))throw new NoSideEffectError('Choose a file, not the workspace root.');return resolved;
}
export function privateAddress(ip:string){if(net.isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19));}return !net.isIP(ip)||ip==='::'||ip==='::1'||/^f[cd]|^fe[89ab]|^::ffff:/i.test(ip);}
export async function publicUrl(input:string){const u=new URL(input);if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))throw new CapriError('Only public HTTPS URLs without credentials are supported.');const addrs=await dns.lookup(u.hostname.replace(/^\[|\]$/g,''),{all:true});if(!addrs.length||addrs.some(a=>privateAddress(a.address)))throw new CapriError('Private-network addresses are not allowed.',403);return u;}
export function cleanText(input:any,max=12000){if(typeof input!=='string'||!input.trim()||input.length>max)throw new NoSideEffectError('Text is empty or exceeds the allowed length.');return input.trim();}
