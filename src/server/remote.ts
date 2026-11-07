import {TaskPaused} from '../agency';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { CapriError, NoSideEffectError, NoSideEffectPause } from './policy';

/** Only trusted host guard instances may establish pre-dispatch provenance. */
export function hostFailure(error:unknown){
 return {error:error instanceof Error?error.message:'Windows action failed.',paused:error instanceof TaskPaused,
  ...(error instanceof NoSideEffectError||error instanceof NoSideEffectPause?{failureEffect:'none' as const}:{})};
}

/** Reconnects return a cached receipt, never execute the same request again. */
export function hostExecutionResult(execution:{[key:string]:unknown;status?:string;result?:any;error?:unknown;paused?:unknown;failureEffect?:unknown}){
 if(execution.status==='completed')return {result:execution.result};
 if(execution.status==='failed'&&execution.failureEffect==='none'&&typeof execution.error==='string'&&execution.error&&typeof execution.paused==='boolean')
  return {error:execution.error,paused:execution.paused,failureEffect:'none' as const};
 return {error:'Previous execution outcome unknown; automatic replay refused.'};
}

/** A cloud coordinator dispatches once; uncertain outcomes are never replayed. */
export class DesktopQueue {
 workers=new Set<WebSocket>();
 pending=new Map<string,{worker?:WebSocket;resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout;name:string;args:any;taskId?:string;expiresAt:number;abort:()=>void;signal:AbortSignal;waitStarted?:number;waitMs?:number}>();
 constructor(private store:Store,private emit:(event:any)=>void){}
 async run(name:string,args:any,signal:AbortSignal,taskId?:string){signal.throwIfAborted();const id=randomUUID();const task=taskId?await this.store.get('task',taskId):undefined;const expiresAt=Math.min(Date.now()+1800000,task?Date.parse(task.expiresAt):Infinity);if(expiresAt<=Date.now())throw new CapriError('The desktop authorization expired. Request the task again.',410);if(task&&!this.workers.size){await this.store.put('task',{...task,status:'waiting',waitingFor:'Windows desktop'});this.emit({type:'changed',kind:'task'});}
  await this.store.put('remoteRequest',{id,taskId,name,args,status:'waiting',expiresAt});
  return new Promise((resolve,reject)=>{const finish=(error?:Error,result?:any)=>{const p=this.pending.get(id);if(!p)return;clearTimeout(p.timer);signal.removeEventListener('abort',p.abort);this.pending.delete(id);void this.store.put('remoteRequest',{id,taskId,name,status:error?'failed':'completed',error:error?.message,expiresAt}).catch(()=>{});error?reject(error):resolve(result);};const abort=()=>{const p=this.pending.get(id);if(p?.worker?.readyState===1)p.worker.send(JSON.stringify({type:'host_cancel',id}));finish(new CapriError('Stopped by you.'));};const timer=setTimeout(()=>finish(new CapriError('The desktop authorization expired. Request the task again.',410)),Math.max(1,expiresAt-Date.now()));this.pending.set(id,{resolve:result=>finish(undefined,result),reject:error=>finish(error),timer,name,args,taskId,expiresAt,abort,signal});signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else void this.dispatch();});
 }
 async dispatch(){const worker=[...this.workers].find(w=>w.readyState===1);if(!worker)return;for(const[id,p]of this.pending){if(p.worker)continue;if(p.expiresAt<Date.now()){p.reject(new CapriError('Desktop authorization expired.',410));continue;}p.worker=worker;clearTimeout(p.timer);p.timer=setTimeout(()=>{worker.send(JSON.stringify({type:'host_cancel',id}));p.reject(new CapriError('Windows action timed out. Outcome may be unknown; check before retrying.'));},240000);if(p.taskId){const task=await this.store.get('task',p.taskId);if(task)await this.store.put('task',{...task,status:'running',waitingFor:undefined});this.emit({type:'changed',kind:'task'});}if(!this.pending.has(id))continue;if(p.signal.aborted){p.abort();continue;}if(worker.readyState!==1){p.reject(new CapriError('Windows disconnected before delivery.'));continue;}worker.send(JSON.stringify({type:'host_call',id,taskId:p.taskId,name:p.name,args:p.args,expiresAt:Math.min(p.expiresAt,Date.now()+45000)}));}}
 add(worker:WebSocket){this.workers.add(worker);void this.dispatch();}
 wait(worker:WebSocket,id:string,waiting:boolean){const p=this.pending.get(id);if(p?.worker!==worker)return;if(waiting){if(p.waitStarted)return;p.waitStarted=Date.now();clearTimeout(p.timer);}else if(p.waitStarted){const duration=Date.now()-p.waitStarted;p.waitMs=(p.waitMs||0)+duration;p.expiresAt+=duration;p.waitStarted=undefined;p.timer=setTimeout(()=>p.reject(new CapriError('Windows action timed out. Check its outcome before retrying.')),240000);}}
 result(worker:WebSocket,message:any){
  const pending=this.pending.get(message.id);if(!pending||pending.worker!==worker)return;
  // Only the assigned paired host can supply this optional failure receipt.
  // Old/unknown packets retain the conservative, unbranded error behavior.
  if(message.error){const text=String(message.error);const known=message.failureEffect==='none';pending.reject(message.paused?(known?new NoSideEffectPause(text):new TaskPaused(text)):(known?new NoSideEffectError(text):new CapriError(text)));}
  else pending.resolve(pending.waitMs?{...message.result,_approvalWaitMs:pending.waitMs}:message.result);
 }
 remove(worker:WebSocket){this.workers.delete(worker);for(const p of this.pending.values())if(p.worker===worker)p.reject(new CapriError('Windows disconnected. The result may be unknown. Automatic replay was refused.'));}
 close(){for(const p of this.pending.values())p.reject(new CapriError('Service stopped.'));}
}
