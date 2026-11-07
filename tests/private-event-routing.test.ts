import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {createService,hash} from '../src/server/service';
import {Store} from '../src/server/store';
import {PrivateSessions} from '../src/server/private-sessions';

async function fixture(){
 const rows=new Map<string,any>(),events:any[]=[];
 const store={get:async(k:string,id:string)=>structuredClone(rows.get(k+':'+id)),list:async(k:string)=>[...rows].filter(([key])=>key.startsWith(k+':')).map(([,v])=>structuredClone(v)),put:async(k:string,v:any)=>{const row={...v,id:v.id??randomUUID()};rows.set(k+':'+row.id,structuredClone(row));return row;},remove:async(k:string,id:string)=>{rows.delete(k+':'+id);},close:async()=>{},export:async()=>({})} as unknown as Store;
 for(const token of ['phone-a','phone-b'])await store.put('device',{id:hash(token),role:'phone',revoked:false});
 const s=await createService({store,adminToken:'admin-fixture',key:()=>undefined,onEvent:e=>events.push(e)});await s.app.ready();
 const http=async(token:string,url:string,payload?:any,method:'GET'|'POST'|'DELETE'=payload===undefined?'GET':'POST')=>s.app.inject({method,url,headers:{authorization:'Bearer '+token},...(payload===undefined?{}:{payload})});
 const privacy=async(token:string,value:boolean)=>{const old=(await http(token,'/v1/extensions/session')).json();const result=await http(token,'/v1/extensions/session',{privateSession:value,revision:old.revision+1});assert.equal(result.statusCode,200);return result.json();};
 const open=async(token:string,ticket?:string)=>{ticket??=(await http(token,'/v1/event-ticket',{})).json().ticket;const received:any[]=[];let done!:()=>void;const ready=new Promise<void>(resolve=>done=resolve);const ws=await s.app.injectWS('/v1/events?ticket='+ticket,{}, {onInit:ws=>{ws.on('message',data=>{const e=JSON.parse(String(data));received.push(e);if(e.type==='ready')done();});ws.on('close',done);}});await ready;return {ws,received};};
 return {...s,store,rows,events,http,privacy,open};
}
const reply=(taskId:string,text='private fixture')=>({type:'message',message:{taskId,text,id:randomUUID(),role:'assistant'}});

test('private task binds before fast reply/HTTP receipt and reaches only its live device, never desktop onEvent',async()=>{
 const f=await fixture();try{
  const a=await f.privacy('phone-a',true),wa=await f.open('phone-a'),wb=await f.open('phone-b');
  f.assistant.chat=async(_text,_private,id)=>{f.emit(reply(id!));f.emit({type:'state',taskId:id,state:'error',error:'private error'});return {id,status:'completed'};};
  const response=await f.http('phone-a','/v1/chat',{id:'fast',text:'secret',private:true,privacyEpoch:a.privacyEpoch});assert.equal(response.statusCode,200);await setImmediate();
  assert.equal(wa.received.filter(e=>e.type==='message').length,1);assert.equal(wa.received.find(e=>e.type==='message').privacyEpoch,a.privacyEpoch);
  assert.equal(wb.received.some(e=>e.type==='message'||e.type==='state'),false);assert.equal(f.events.some(e=>e.type==='message'||e.type==='state'),false);
  const off=await f.privacy('phone-a',false);await f.privacy('phone-a',true);f.emit(reply('fast'));await setImmediate();assert.equal(wa.received.filter(e=>e.type==='message').length,1);
  assert.equal((await f.http('phone-a','/v1/chat',{id:'fast',text:'secret',private:true,privacyEpoch:off.privacyEpoch})).statusCode,409);
  wa.ws.close();wb.ws.close();
 }finally{await f.app.close();}
});

test('legacy public traffic remains public; private flags and foreign/unknown IDs never establish a private audience',async()=>{
 const f=await fixture();try{
  const a=await f.open('phone-a'),b=await f.open('phone-b');f.assistant.chat=async(_t,_p,id)=>{f.emit(reply(id!,'public'));return {id};};
  assert.equal((await f.http('phone-a','/v1/chat',{id:'legacy-public',text:'hello'})).statusCode,200);
  assert.equal((await f.http('phone-a','/v1/chat',{id:'legacy-private',text:'secret',private:true,owner:hash('phone-a'),approved:true})).statusCode,409);
  f.emit({...reply('unknown'),privateSession:true});f.emit(reply('unknown-no-flag'));await setImmediate();
  assert.equal(a.received.filter(e=>e.type==='message').length,1);assert.equal(b.received.filter(e=>e.type==='message').length,1);
  const pa=await f.privacy('phone-a',true);assert.equal((await f.http('phone-b','/v1/chat',{id:'forged',text:'secret',private:true,privacyEpoch:pa.privacyEpoch})).statusCode,409);
  a.ws.close();b.ws.close();
 }finally{await f.app.close();}
});

test('tickets are single-use, reject forged/expired epochs/revoked devices; replacement and disconnect retire old private replies',async()=>{
 const f=await fixture();try{
  const session=await f.privacy('phone-a',true),ticket=(await f.http('phone-a','/v1/event-ticket',{})).json().ticket;
  const a=await f.open('phone-a',ticket),reused=await f.open('phone-a',ticket),forged=await f.open('phone-a','forged');
  assert.equal(reused.received.length,0);assert.equal(forged.received.length,0);
  const expiring=(await f.http('phone-b','/v1/event-ticket',{})).json().ticket,now=Date.now;try{Date.now=()=>now()+31000;assert.equal((await f.open('phone-b',expiring)).received.length,0);}finally{Date.now=now;}
  f.assistant.chat=async(_t,_p,id)=>({id});await f.http('phone-a','/v1/chat',{id:'old-socket',text:'secret',private:true,privacyEpoch:session.privacyEpoch});
  const replacement=await f.open('phone-a');f.emit(reply('old-socket'));await setImmediate();assert.equal(replacement.received.some(e=>e.type==='message'),false);
  assert.equal((await f.http('phone-a','/v1/chat',{id:'old-client-new-id',text:'secret',private:true,privacyEpoch:session.privacyEpoch})).statusCode,409);
  const stale=(await f.http('phone-a','/v1/event-ticket',{})).json().ticket;await f.privacy('phone-a',false);assert.equal((await f.open('phone-a',stale)).received.length,0);
  const revoke=(await f.http('phone-b','/v1/event-ticket',{})).json().ticket;await f.http('admin-fixture','/v1/devices/'+hash('phone-b'),undefined,'DELETE');assert.equal((await f.open('phone-b',revoke)).received.length,0);
  a.ws.close();replacement.ws.close();
 }finally{await f.app.close();}
});

test('privacy transition during pre-controller await prevents dispatch, and remote private host forwarding is denied',async()=>{
 const f=await fixture();try{
  const p=await f.privacy('phone-a',true);let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(resolve=>entered=resolve);f.assistant.router.available=async()=>{entered();await new Promise<void>(resolve=>release=resolve);return true;};
  let calls=0;f.assistant.call=async()=>{calls++;return {};};
  const request=f.http('phone-a','/v1/chat',{id:'before-controller',text:'secret',private:true,privacyEpoch:p.privacyEpoch});await waiting;await f.privacy('phone-a',false);release();assert.equal((await request).statusCode,409);assert.equal(calls,0);
  const next=await f.privacy('phone-a',true);f.assistant.chat=async(_t,_p,id)=>({id});await f.http('phone-a','/v1/chat',{id:'private-host',text:'secret',private:true,privacyEpoch:next.privacyEpoch});
  await assert.rejects(f.assistant.host('write_file',{text:'private'},new AbortController().signal,'private-host'),/Private computer actions/);assert.equal((await f.store.list('remoteRequest')).length,0);
 }finally{await f.app.close();}
});

test('trusted private plan tags cannot be overridden and are excluded from phone records; manual public plans remain',async()=>{
 const f=await fixture();try{
  await f.assistant.tool('add_plan',{title:'private plan',dueAt:'',contentClass:'public'},new AbortController().signal,true,'private-plan-task');
  await f.http('phone-a','/v1/records/plan',{title:'user-created public plan',contentClass:'private'});
  const all=await f.store.list('plan');assert.equal(all.find(p=>p.title==='private plan')!.contentClass,'private');
  const phone=(await f.http('phone-a','/v1/records/plan')).json();assert.deepEqual(phone.map((p:any)=>p.title),['user-created public plan']);
 }finally{await f.app.close();}
});

test('private tombstones survive retirement/restored classification and cannot be rebound as public',()=>{
 const gate=new PrivateSessions();gate.bind('private',true,{owner:'a',epoch:'1'},'digest');gate.end('a','1');assert.equal(gate.audience(reply('private')),false);assert.throws(()=>gate.bind('private',false,{owner:'b',epoch:'2'},'digest'));
 const restarted=new PrivateSessions();restarted.restore('private',true);assert.equal(restarted.audience(reply('private')),false);
});

test('phone Stop retires pre-controller requests and only cancels tasks owned by that device',async()=>{
 const f=await fixture();try{
  const p=await f.privacy('phone-a',true);let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>entered=resolve);
  f.assistant.router.available=async()=>{entered();await new Promise<void>(resolve=>release=resolve);return true;};let calls=0;f.assistant.call=async()=>{calls++;return {};};
  const other=new AbortController();f.assistant.controllers.set('other-device',other);
  const request=f.http('phone-a','/v1/chat',{id:'pending-stop',text:'private body',private:true,privacyEpoch:p.privacyEpoch});await waiting;assert.equal((await f.http('phone-a','/v1/stop',{})).statusCode,200);release();assert.equal((await request).statusCode,409);assert.equal(calls,0);assert.equal(other.signal.aborted,false);f.assistant.controllers.delete('other-device');
 }finally{await f.app.close();}
});

test('desktop private onEvent honors its owner and persisted private task errors are hidden from other devices',async()=>{
 const f=await fixture();try{
  const p=await f.privacy('admin-fixture',true);f.assistant.chat=async(_text,_private,id)=>{await f.store.put('task',{id,privateSession:true,text:'legacy secret',error:'raw private error'});f.emit(reply(id!));return {id};};
  await f.http('admin-fixture','/v1/chat',{id:'desktop-private',text:'secret',private:true,privacyEpoch:p.privacyEpoch});assert.equal(f.events.filter(e=>e.type==='message').length,1);
  assert.deepEqual((await f.http('phone-b','/v1/records/task')).json(),[]);const owned=(await f.http('admin-fixture','/v1/records/task')).json();assert.equal(JSON.stringify(owned).includes('raw private error'),false);assert.equal(JSON.stringify(owned).includes('legacy secret'),false);
  await f.privacy('admin-fixture',false);f.emit({...reply('desktop-private'),type:'state',taskId:'desktop-private',error:'late secret'});assert.equal(f.events.some(e=>e.error==='late secret'),false);
 }finally{await f.app.close();}
});

test('authenticated paired endpoints deliver to one fake WebSocket and receipts cannot cross device credentials',async()=>{
 const f=await fixture();try{
  const a=await f.open('phone-a'),b=await f.open('phone-b');const capability={protocol:'capri-android-notifications-v1',permission:'granted',channelEnabled:true};
  assert.equal((await f.http('phone-a','/v1/android/capability',capability)).statusCode,200);
  const input={deviceId:hash('phone-a'),notificationId:'paired-endpoint',body:'fake OS post only'};
  const receipt=await f.pairedAndroid.notify(input,new AbortController().signal);assert.equal(receipt.state,'accepted');await setImmediate();
  assert.equal(a.received.filter(e=>e.type==='android-notification').length,1);assert.equal(b.received.some(e=>e.type==='android-notification'),false);assert.equal(f.events.some(e=>e.type==='android-notification'),false);
  const ack={deviceId:receipt.deviceId,notificationId:receipt.notificationId,bodySha256:receipt.bodySha256,state:'delivered'};
  assert.notEqual((await f.http('phone-b','/v1/android/receipt',ack)).statusCode,200);assert.equal((await f.http('phone-a','/v1/android/receipt',ack)).statusCode,200);
  assert.deepEqual((await f.http('phone-b','/v1/android/receipts')).json(),[]);assert.equal((await f.http('phone-a','/v1/android/receipts')).json()[0].state,'delivered');
  assert.equal((await f.http('admin-fixture','/v1/records/paired-android-receipt')).statusCode,400);a.ws.close();b.ws.close();
 }finally{await f.app.close();}
});

test('ticket is rejected if privacy changes during its asynchronous device lookup',async()=>{
 const f=await fixture();try{
  const ticket=(await f.http('phone-a','/v1/event-ticket',{})).json().ticket,original=f.store.get.bind(f.store);let release!:()=>void,entered!:()=>void,held=false;
  const waiting=new Promise<void>(resolve=>entered=resolve);f.store.get=async(kind,id)=>{const row=await original(kind,id);if(kind==='device'&&id===hash('phone-a')&&!held){held=true;entered();await new Promise<void>(resolve=>release=resolve);}return row;};
  const opening=f.open('phone-a',ticket);await waiting;await f.privacy('phone-a',true);release();assert.equal((await opening).received.length,0);
 }finally{await f.app.close();}
});
