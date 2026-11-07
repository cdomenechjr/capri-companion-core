import { Voice } from './voice';
declare global {interface Window {nativeApi:{request:(id:string,method:string,route:string,body:string)=>void;event:(json:string)=>void};capriResponse:(id:string,value:string,error:string)=>void;capriVoice:any;capriPrivate:boolean}}
const pending=new Map<string,{resolve:(value:any)=>void;reject:(e:Error)=>void}>();
window.capri={...window.capri,request:(method:string,route:string,body?:any)=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();pending.set(id,{resolve,reject});window.nativeApi.request(id,method,route,JSON.stringify(body||{}));})} as any;
window.capriResponse=(id,value,error)=>{const p=pending.get(id);if(!p)return;pending.delete(id);error?p.reject(Error(error)):p.resolve(JSON.parse(value));};
window.capriVoice=new Voice(event=>window.nativeApi.event(JSON.stringify(event)),()=>!!window.capriPrivate);
window.addEventListener('pagehide',()=>void window.capriVoice.stop());
