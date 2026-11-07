import {createHash} from 'node:crypto';
import {z} from 'zod';
import {IdSchema,Sha256Schema} from './contracts';
import type {PairedAndroidTransport} from './contact-providers';
import type {Store} from '../server/store';

export const androidJournalKind='paired-android-receipt';
export const androidProtocol='capri-android-notifications-v1';
export const notificationDigest=(body:string)=>createHash('sha256').update(body,'utf8').digest('hex');
const claim=z.object({notificationId:IdSchema,deviceId:IdSchema,bodySha256:Sha256Schema});
export const AndroidCapabilitySchema=z.object({protocol:z.literal(androidProtocol),permission:z.enum(['granted','denied']),channelEnabled:z.boolean()}).strict();
export const AndroidAckSchema=claim.extend({state:z.enum(['delivered','rejected','unconfirmed'])}).strict();
export type AndroidReceipt={notificationId:string;deviceId:string;bodySha256:string;recordId:string;state:'accepted'|'delivered'|'rejected'|'unconfirmed'};
type Socket={readyState:number;send(data:string,callback?:(error?:Error)=>void):void};
// One serializer per encrypted Store, including across adapter re-creation on Stop.
const locks=new WeakMap<object,Promise<unknown>>();
function serial<T>(store:object,run:()=>Promise<T>):Promise<T>{const next=(locks.get(store)??Promise.resolve()).catch(()=>{}).then(run);locks.set(store,next.catch(()=>{}));return next;}

/** Only the authenticated service may attach a socket or submit a capability/ack.
 * Pairing identifies a device, never its OS permission. Bodies are transient and
 * sent only to that socket; durable claims contain exact hashes, never payloads. */
export class StorePairedAndroidTransport implements PairedAndroidTransport {
 private sockets=new Map<string,Socket>();
 private capabilities=new Map<string,{allowed:boolean;permission:'granted'|'denied';channelEnabled:boolean;socket:Socket;at:number}>();
 constructor(private store:Pick<Store,'get'|'list'|'put'>,private clock=Date.now){}
 private async write(row:{id:string;notificationId:string;deviceId:string;bodySha256:string;state:string}){
  await this.store.put(androidJournalKind,row);const saved=await this.store.get(androidJournalKind,row.id);
  if(!saved||saved.id!==row.id||saved.notificationId!==row.notificationId||saved.deviceId!==row.deviceId||saved.bodySha256!==row.bodySha256||saved.state!==row.state)throw Error('Notification journal could not be confirmed.');
 }
 attach(deviceId:string,socket:Socket){this.sockets.set(deviceId,socket);this.capabilities.delete(deviceId);return ()=>{if(this.sockets.get(deviceId)===socket){this.sockets.delete(deviceId);this.capabilities.delete(deviceId);}};}
 capability(deviceId:string,input:unknown){const value=AndroidCapabilitySchema.parse(input),socket=this.sockets.get(deviceId);if(!socket)throw Error('Device offline.');this.capabilities.set(deviceId,{allowed:value.permission==='granted'&&value.channelEnabled,permission:value.permission,channelEnabled:value.channelEnabled,socket,at:this.clock()});}
 async paired(deviceId:string){const device=await this.store.get('device',deviceId),socket=this.sockets.get(deviceId),cap=this.capabilities.get(deviceId);return device?.role==='phone'&&device.revoked===false&&socket?.readyState===1&&cap?.socket===socket&&cap.allowed&&cap.at<=this.clock()&&this.clock()-cap.at<120000;}
 stop(deviceId:string){this.capabilities.delete(deviceId);}
 async status(deviceId:string){const cap=this.capabilities.get(deviceId),fresh=!!cap&&cap.at<=this.clock()&&this.clock()-cap.at<120000;return {protocol:androidProtocol,available:await this.paired(deviceId),online:this.sockets.get(deviceId)?.readyState===1,permission:fresh?cap.permission:'unknown',channelEnabled:fresh?cap.channelEnabled:false};}
 async notify(input:{deviceId:string;notificationId:string;body:string},signal:AbortSignal):Promise<AndroidReceipt>{
  const binding=claim.parse({...input,bodySha256:notificationDigest(input.body)}),recordId=input.notificationId;
  if(!input.body||Buffer.byteLength(input.body)>32768)throw Error('Invalid notification.');
  return serial(this.store,async()=>{
   const old=await this.store.get(androidJournalKind,recordId);
   if(old){if(old.deviceId!==binding.deviceId||old.bodySha256!==binding.bodySha256)throw Error('Notification ID conflict.');return this.receipt(old);}
   signal.throwIfAborted();if(!await this.paired(input.deviceId))throw Error('Notification permission or live device unavailable.');
   const socket=this.sockets.get(input.deviceId)!,capability=this.capabilities.get(input.deviceId);
   const live=()=>!signal.aborted&&this.sockets.get(input.deviceId)===socket&&this.capabilities.get(input.deviceId)===capability;
   // A crash at any point after this reservation cannot cause a second post.
   await this.write({id:recordId,...binding,state:'unconfirmed'});
   if(!live()||!await this.paired(input.deviceId))return {...binding,recordId,state:'unconfirmed'};
   // Durable service acceptance is distinct from observed OS posting.
   await this.write({id:recordId,...binding,state:'accepted'});
   if(!live()||!await this.paired(input.deviceId)||!live())return this.uncertain(recordId,binding);
   try{socket.send(JSON.stringify({type:'android-notification',protocol:androidProtocol,...binding,body:input.body}),()=>{});}catch{return this.uncertain(recordId,binding);}
   return {...binding,recordId,state:'accepted'};
  });
 }
 private async uncertain(id:string,binding:z.infer<typeof claim>):Promise<AndroidReceipt>{await this.write({id,...binding,state:'unconfirmed'});return {...binding,recordId:id,state:'unconfirmed'};}
 private receipt(row:any):AndroidReceipt{return {...claim.parse(row),recordId:row.id,state:['accepted','delivered','rejected'].includes(row.state)?row.state:'unconfirmed'};}
 async acknowledge(owner:string,input:unknown){const ack=AndroidAckSchema.parse(input);if(ack.deviceId!==owner)throw Error('Notification owner mismatch.');return serial(this.store,async()=>{const row=await this.store.get(androidJournalKind,ack.notificationId);if(!row||row.deviceId!==owner||row.bodySha256!==ack.bodySha256)throw Error('Notification receipt mismatch.');if(row.state!=='delivered')await this.write({id:row.id,...claim.parse(row),state:ack.state});return {recorded:true};});}
 async observe(input:{deviceId:string;notificationId:string;body:string}):Promise<AndroidReceipt|undefined>{const row=await this.store.get(androidJournalKind,input.notificationId);return row&&row.deviceId===input.deviceId&&row.bodySha256===notificationDigest(input.body)?this.receipt(row):undefined;}
 async reconcile(owner:string){return (await this.store.list(androidJournalKind)).filter(row=>row.deviceId===owner).map(row=>this.receipt(row));}
 close(){this.sockets.clear();this.capabilities.clear();}
}
