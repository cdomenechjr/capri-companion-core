import path from 'node:path';
import {lstatSync, mkdirSync, realpathSync,readFileSync} from 'node:fs';
import type {FastifyInstance} from 'fastify';
import type {Store} from '../server/store';
import {defaults} from '../shared';
import metadata from '../../package.json';
import {createHash} from 'node:crypto';
import net from 'node:net';

/** Run synchronously in the entry module, before the first await/ready event.
 * Electron's Chromium session follows these paths even while writer acquisition
 * is pending. Selecting a cache directory grants no vault/Store ownership. */
export function prepareDesktopStartup(app:{setPath(name:string,value:string):void;requestSingleInstanceLock():boolean;on(event:'second-instance',listener:()=>void):unknown},directory:string,singleInstance:boolean,focus:()=>void){
 mkdirSync(directory,{recursive:true});
 app.setPath('userData',directory);app.setPath('sessionData',directory);
 if(singleInstance&&!app.requestSingleInstanceLock())return false;
 if(singleInstance)app.on('second-instance',focus);
 return true;
}

/** OS ownership is the listening handle, never a connection or a PID file. The
 * trusted installation identity stays fixed when the selected directory changes. */
export async function acquireProfileWriter(identity:{installationId:string;ownerSha256:string}):Promise<{owned():boolean;close():Promise<void>}> {
 if(!/^[0-9a-f-]{36}$/i.test(identity.installationId)||!/^[a-f0-9]{64}$/.test(identity.ownerSha256))throw Error('Invalid stable profile owner.');
 const name=createHash('sha256').update('capri-profile-writer-v1\0'+identity.ownerSha256+'\0'+identity.installationId.toLowerCase()).digest('hex');
 const address=process.platform==='win32'?'\\\\.\\pipe\\capri-writer-'+name:path.join('/tmp','capri-writer-'+name+'.sock');
 const server=net.createServer(socket=>socket.destroy());let closed=false;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen({path:address,exclusive:true},()=>{server.removeListener('error',reject);resolve();});});
 server.on('error',()=>{closed=true;});
 return {owned:()=>!closed&&server.listening,close:async()=>{if(closed)return;closed=true;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}

/** Strict spelling check is used for managed roots, including missing tails.
 * Unlike runtimeProfile's compatibility resolver it refuses all junctions. */
export function managedDirectory(directory:string,appData:string):string {
 if(!path.isAbsolute(directory)||directory.includes('~')||directory.startsWith('\\\\')||path.resolve(directory)!==directory)throw Error('Managed paths must be canonical local paths.');
 let current=path.parse(directory).root,missing=false;
 for(const part of path.relative(current,directory).split(path.sep).filter(Boolean)){
  current=path.join(current,part);if(missing)continue;
  try{const info=lstatSync(current);if(info.isSymbolicLink()||!info.isDirectory())throw Error('Managed path contains an alias.');if(realpathSync.native(current).toLowerCase()!==current.toLowerCase())throw Error('Managed path identity changed.');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;missing=true;}
 }
 return runtimeProfile(appData,{CAPRI_PROFILE_DIR:directory}).path;
}

/** Recovery generations cannot fall back to the ordinary per-directory gate.
 * The marker is public routing metadata, never a credential or trust grant. */
export function assertManagedProfileLaunch(directory:string,env:NodeJS.ProcessEnv=process.env){
 let current=directory;
 for(;;){const marker=path.join(current,'.capri-managed.json');
  try{const info=lstatSync(marker);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>4096)throw Error('Invalid managed profile marker.');
   const value=JSON.parse(readFileSync(marker,'utf8'));if(value.schemaVersion!==1||typeof value.trustFile!=='string'||typeof value.trustSha256!=='string'||Object.keys(value).sort().join(',')!=='schemaVersion,trustFile,trustSha256'||env.CAPRI_MANAGED_TRUST!==value.trustFile||env.CAPRI_MANAGED_TRUST_SHA256!==value.trustSha256||!env.CAPRI_MANAGED_CHANNEL)throw Error('A captured managed launcher is required for this profile.');return value;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const parent=path.dirname(current);if(parent===current)return;current=parent;
 }
}

/** Only the host's compiled build-info and package identity enter this function.
 * Neutral builds use the public namespace even before a sanitized package rename.
 * An absent/damaged compiled identity must never fall back into the private vault. */
export function compiledProfileIdentity(buildInfo:unknown,packageName=metadata.name):'capri-companion'|'capri-companion-core'{
 const info=buildInfo as {version?:unknown;assets?:unknown}|null;
 if(!info||info.version!==metadata.version||!['private','neutral'].includes(String(info.assets)))throw Error('The compiled product identity is missing or invalid.');
 return packageName==='capri-companion-core'||info.assets==='neutral'?'capri-companion-core':'capri-companion';
}

// Resolve existing ancestors too: a fresh profile may be below a junction.
// Only directory metadata is inspected, never a vault or database.
function resolvedDirectory(directory: string): string {
  try { return realpathSync.native(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      if (lstatSync(directory).isSymbolicLink()) throw Error('Cannot use an unresolved profile directory alias.');
    } catch (entryError) {
      if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(resolvedDirectory(parent), path.basename(directory));
  }
}

export function runtimeProfile(appData: string, env: NodeJS.ProcessEnv = process.env, identity: 'capri-companion'|'capri-companion-core' = metadata.name === 'capri-companion-core' ? 'capri-companion-core' : 'capri-companion') {
  const custom = env.CAPRI_PROFILE_DIR;
  if (custom && !path.isAbsolute(custom)) throw new Error('CAPRI_PROFILE_DIR must be an absolute development profile path.');
  const installed = path.resolve(appData, 'capri-companion');
  let directory = path.resolve(appData, identity);
  if (custom || identity === 'capri-companion-core') {
    directory = resolvedDirectory(path.resolve(custom || directory));
    const installedDirectory = resolvedDirectory(installed);
    const compare = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const relative = path.relative(compare(installedDirectory), compare(directory));
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Development profiles must be separate from the installed Capri profile.');
    }
  }
  const port = env.CAPRI_DEV_PORT ? Number(env.CAPRI_DEV_PORT) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('CAPRI_DEV_PORT must be a valid port, or 0 for an available port.');
  return {path:directory, port, development:!!custom};
}

export async function seedProfileSettings(store: Pick<Store, 'get' | 'put'>, profile: {path: string; development: boolean}, documents: string) {
  const existing = await store.get('settings', 'main');
  if (existing && profile.development) return existing;
  const workspace = path.join(profile.development ? profile.path : documents, profile.development ? 'Workspace' : 'Capri Workspace');
  mkdirSync(workspace, {recursive: true});
  if (existing) return existing;
  return store.put('settings', {...defaults, providerMode:'local', id:'main', roots:[workspace],
    ...(profile.development ? {startAtLogin:false, muted:true, wakeEnabled:false, voiceGreeting:false} : {})});
}

export function loginItemPolicy(mode: {development: boolean; packaged: boolean; selfTest: boolean; uiSmoke: boolean}, setLoginItem: (openAtLogin: boolean) => void) {
  const isolated = mode.development || mode.selfTest || mode.uiSmoke;
  return {
    apply(startAtLogin: boolean) {
      if (mode.packaged && !isolated) setLoginItem(startAtLogin);
    },
    protectSettings(app: FastifyInstance, settings: () => Promise<{startAtLogin: boolean}>) {
      if (!isolated) return;
      // onSettings runs after persistence, so reject here before saving anything.
      app.addHook('preValidation', async req => {
        if (req.method !== 'PATCH' || req.routeOptions.url !== '/v1/settings') return;
        const patch = req.body as {startAtLogin?: unknown} | null;
        if (patch?.startAtLogin !== undefined && patch.startAtLogin !== (await settings()).startAtLogin) {
          throw Object.assign(Error('Windows startup cannot be changed from a development preview or self-test. Use the installed Capri app to change Start with Windows.'), {statusCode:403});
        }
      });
    }
  };
}
