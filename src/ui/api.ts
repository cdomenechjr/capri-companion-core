declare global {interface Window {capri?:{agency?:(action:string,args?:any)=>Promise<any>;companion?:(action:string,args?:any)=>Promise<any>;place?:(phase:string,x:number,y:number)=>void;desktopPreferences?:(patch?:any)=>Promise<any>;signal:(event:any)=>void;request:(method:string,route:string,body?:any)=>Promise<any>;window:(action:string)=>Promise<any>;chooseFolder:()=>Promise<string|null>;wakeStatus:()=>Promise<any>;startLocalEngine?:()=>Promise<any>;wakeAudio:(samples:number[])=>Promise<boolean>;connectRemote:(url:string,code:string)=>Promise<any>;useLocal:()=>Promise<any>;onEvent:(cb:(event:any)=>void)=>()=>void}}}
/**
 * `signal` cancels a browser request in flight. The desktop bridge has no cancellation, so there an aborted signal only
 * prevents the request from starting; one already sent settles normally and callers must keep counting it until then.
 */
let privacyEpoch:string|undefined;
let captureGeneration=0;
let captureBoundary:Promise<unknown>=Promise.resolve();
const captures=new Map<string,{generation:number;token:Promise<string>}>();
async function rawRequest(route:string,method:string,body?:any,signal?:AbortSignal):Promise<any>{signal?.throwIfAborted();if(window.capri)return window.capri.request(method,route,body);const token=sessionStorage.getItem('capri-token')||'';const res=await fetch(route,{method,signal,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const json=await res.json();if(!res.ok)throw Error(json.error||'Request failed');return json;}
async function request(route:string,method:string,body?:any,signal?:AbortSignal):Promise<any>{
 const bound=(route==='/v1/chat'||route==='/v1/voice/call')&&method==='POST'?{...body,...(body?.private?{privacyEpoch}: {})}:body;
 const result=await rawRequest(route,method,bound,signal);
 if(route==='/v1/extensions/session'&&typeof result?.privacyEpoch==='string')privacyEpoch=result.privacyEpoch;
 return result;
}
export async function api(route:string,method='GET',body?:any,options:{signal?:AbortSignal}={}):Promise<any>{
 options.signal?.throwIfAborted();
 if(route==='/v1/stop'||route==='/v1/extensions/session'&&method==='POST'||route==='/v1/voice/local/capture'&&method==='DELETE'){
  const closingCaptures=[...captures];captureGeneration++;captures.clear();
  // Snapshot the original sessions synchronously. Never obtain a fresh owner
  // token to close an old capture, and never let delayed cleanup close its heir.
  const closing=captureBoundary.catch(()=>{}).then(async()=>{
   if(route!=='/v1/voice/local/capture')return request(route,method,body,options.signal);
   await Promise.all(closingCaptures.map(async([sessionId,capture])=>{let captureToken:string;try{captureToken=await capture.token;}catch{return;}await request(route,method,{sessionId,captureToken},options.signal);}));return {closed:true};
  });captureBoundary=closing;return closing;
 }
 if(route!=='/v1/voice/local/detect'||method!=='POST')return request(route,method,body,options.signal);
 const id=body?.sessionId;if(typeof id!=='string')throw Error('Invalid detector session.');
 let capture=captures.get(id);if(!capture){const generation=captureGeneration;capture={generation,token:captureBoundary.then(()=>{if(generation!==captureGeneration)throw Error('Capture ended.');return request('/v1/voice/local/capture','GET');}).then(value=>{if(typeof value.captureToken!=='string')throw Error('Capture owner unavailable.');return value.captureToken;})};captures.set(id,capture);}
 const current=capture;const abort=()=>{if(captures.get(id)===current)captures.delete(id);const closing=captureBoundary.catch(()=>{}).then(()=>current.token).then(captureToken=>request('/v1/voice/local/detect/'+encodeURIComponent(id),'DELETE',{captureToken}));captureBoundary=closing;void closing.catch(()=>{});};
 options.signal?.addEventListener('abort',abort,{once:true});
 try{const captureToken=await current.token;options.signal?.throwIfAborted();if(current.generation!==captureGeneration||captures.get(id)!==current)throw Error('Capture ended.');return await request(route,method,{...body,captureToken},options.signal);}
 finally{options.signal?.removeEventListener('abort',abort);}
}
/** Only events emitted directly by the live Voice owner can close its capture.
 * Mirrored/presentation events go straight to the receiver without this path. */
export function dispatchLocalVoiceEvent(event:any,receive:(event:any)=>void,forward?:(event:any)=>void){
 if(event?.type==='voice'&&event.active===false)void api('/v1/voice/local/capture','DELETE').catch(()=>{});
 receive(event);forward?.(event);
}
export async function imageUrl(id:string){if(window.capri){const result=await api('/v1/attachments/'+id);return 'data:'+result.mime+';base64,'+result.base64;}const response=await fetch('/v1/attachments/'+id,{headers:{Authorization:'Bearer '+sessionStorage.getItem('capri-token')}});return URL.createObjectURL(await response.blob());}
export function download(data:any,name:string,type='application/json'){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
