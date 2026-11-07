import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store,retainPairedAndroidJournalAcrossRollback} from '../src/server/store';
import {AndroidNotificationProvider} from '../src/extensions/contact-providers';
import {defaultExtensionSettings} from '../src/extensions/contracts';
import {contactPolicy} from '../src/extensions/policy';
import {StorePairedAndroidTransport,androidJournalKind,androidProtocol,notificationDigest} from '../src/extensions/paired-android';
const signal=()=>new AbortController().signal;
async function fixture(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'capri-paired-test-')),key=randomBytes(32);let store=await new Store(dir,key).init();
 for(const id of ['phone-a','phone-b'])await store.put('device',{id,role:'phone',revoked:false});
 let now=1000;const transport=new StorePairedAndroidTransport(store,()=>now),a:any[]=[],b:any[]=[];
 const socket=(out:any[])=>({readyState:1,send:(raw:string)=>{out.push(JSON.parse(raw));}}),sa=socket(a),sb=socket(b);
 const detach=transport.attach('phone-a',sa);transport.attach('phone-b',sb);
 const enable=(id='phone-a',permission='granted')=>transport.capability(id,{protocol:androidProtocol,permission,channelEnabled:true});
 return {transport,store,dir,key,a,b,sa,sb,detach,enable,advance:()=>now+=120001,close:async()=>{transport.close();await store.close();await rm(dir,{recursive:true,force:true});}};
}

test('pairing alone is unavailable; exact targeted service acceptance and authenticated OS receipt are distinct',async()=>{
 const f=await fixture();try{
  assert.equal(await f.transport.paired('phone-a'),false);f.enable();assert.equal(await f.transport.paired('phone-a'),true);
  const provider=new AndroidNotificationProvider(f.transport),prepared=await provider.prepare({channel:'android',sender:'desktop',recipient:'phone-a',body:'fixture exact body'},signal());
  const result=await prepared.dispatch();assert.equal(result.state,'accepted');assert.equal(f.a.length,1);assert.equal(f.b.length,0);
  const e=f.a[0];assert.equal(e.deviceId,'phone-a');assert.equal(e.bodySha256,notificationDigest(e.body));assert.equal(e.notificationId,result.recordId);
  const ack={deviceId:e.deviceId,notificationId:e.notificationId,bodySha256:e.bodySha256,state:'delivered'};
  await assert.rejects(f.transport.acknowledge('phone-b',ack));await assert.rejects(f.transport.acknowledge('phone-a',{...ack,bodySha256:'0'.repeat(64)}));
  await f.transport.acknowledge('phone-a',ack);assert.equal((await provider.observe!({channel:'android',sender:'desktop',recipient:'phone-a',body:e.body},result.recordId!,signal())).state,'delivered');
  assert.equal((await f.transport.reconcile('phone-b')).length,0);assert.equal(JSON.stringify(await f.store.export()).includes('fixture exact body'),false);
  assert.equal(JSON.stringify(await f.store.list(androidJournalKind)).includes('fixture exact body'),false);
 }finally{await f.close();}
});

test('duplicates, conflict, Stop, revoked permission, stale capability and offline status never repost',async()=>{
 const f=await fixture();try{
  f.enable();const input={deviceId:'phone-a',notificationId:'notice-1',body:'bound bytes'};
  await Promise.all([f.transport.notify(input,signal()),f.transport.notify(input,signal())]);assert.equal(f.a.length,1);
  await assert.rejects(f.transport.notify({...input,body:'changed'},signal()));await assert.rejects(f.transport.notify({...input,deviceId:'phone-b'},signal()));
  f.transport.stop('phone-a');assert.equal(await f.transport.paired('phone-a'),false);f.enable('phone-a','denied');assert.equal(await f.transport.paired('phone-a'),false);
  f.enable();f.advance();assert.equal(await f.transport.paired('phone-a'),false);f.enable();f.detach();assert.equal(await f.transport.paired('phone-a'),false);
  f.transport.attach('phone-a',f.sa);f.enable();await f.store.put('device',{id:'phone-a',role:'phone',revoked:true});await assert.rejects(f.transport.notify({...input,notificationId:'revoked'},signal()));assert.equal(f.a.length,1);
 }finally{await f.close();}
});

test('durable pre-post claim, lost ack and encrypted Store restart preserve reservations with read-only reconciliation',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'capri-paired-restart-')),key=randomBytes(32);let store=await new Store(dir,key).init();let sends=0;
 try{
  await store.put('device',{id:'phone-a',role:'phone',revoked:false});const input={deviceId:'phone-a',notificationId:'uncertain-post',body:'transient private payload'};
  await store.put(androidJournalKind,{id:input.notificationId,notificationId:input.notificationId,deviceId:input.deviceId,bodySha256:notificationDigest(input.body),state:'unconfirmed'});
  await store.close();store=await new Store(dir,key).init();const transport=new StorePairedAndroidTransport(store);transport.attach('phone-a',{readyState:1,send:()=>{sends++;}});transport.capability('phone-a',{protocol:androidProtocol,permission:'granted',channelEnabled:true});
  assert.equal((await transport.notify(input,signal())).state,'unconfirmed');assert.equal(sends,0);assert.equal((await transport.reconcile('phone-a'))[0].state,'unconfirmed');
  const accepted={...input,notificationId:'ack-lost'};assert.equal((await transport.notify(accepted,signal())).state,'accepted');assert.equal(sends,1);transport.close();await store.close();store=await new Store(dir,key).init();
  const restarted=new StorePairedAndroidTransport(store);assert.equal((await restarted.notify(accepted,signal())).state,'accepted');assert.equal(sends,1);assert.equal(JSON.stringify(await store.export()).includes(input.body),false);
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});

test('socket replacement or owned Stop during durable claim fences the old socket and never sends to a new one',async()=>{
 for(const boundary of ['replace','stop','abort'] as const){const f=await fixture();try{
  f.enable();const original=f.store.put.bind(f.store),controller=new AbortController();let intercepted=false;
  f.store.put=async(kind,value)=>{const row=await original(kind,value);if(kind===androidJournalKind&&!intercepted){intercepted=true;if(boundary==='replace'){f.transport.attach('phone-a',f.sb);f.enable();}else if(boundary==='stop')f.transport.stop('phone-a');else controller.abort();}return row;};
  const result=await f.transport.notify({deviceId:'phone-a',notificationId:'fenced',body:'never posted'},controller.signal);assert.equal(result.state,'unconfirmed');assert.equal(f.a.length+f.b.length,0);
 }finally{await f.close();}}
});

test('provider rejects forged device/body/record receipts even when notification id matches',async()=>{
 for(const corrupt of ['device','body','record'] as const){const provider=new AndroidNotificationProvider({paired:async()=>true,notify:async v=>({notificationId:v.notificationId,deviceId:corrupt==='device'?'other':v.deviceId,bodySha256:corrupt==='body'?'0'.repeat(64):notificationDigest(v.body),recordId:corrupt==='record'?'other':v.notificationId,state:'delivered'})});
 assert.equal((await (await provider.prepare({channel:'android',sender:'desktop',recipient:'phone-a',body:'bound'},signal())).dispatch()).state,'unconfirmed');}
});

test('rollback retains no-repost claims separately from generic exports and rejects identity conflicts',async()=>{
 const f=await fixture();try{
  f.enable();await f.transport.notify({deviceId:'phone-a',notificationId:'rollback',body:'never exported'},signal());
  const rows=new Map<string,any>(),target={get:async(_k:string,id:string)=>rows.get(id),put:async(_k:string,row:any)=>{rows.set(row.id,structuredClone(row));return row;}};
  await retainPairedAndroidJournalAcrossRollback(f.store,target);assert.equal(rows.get('rollback').state,'accepted');
  rows.get('rollback').bodySha256='0'.repeat(64);await assert.rejects(retainPairedAndroidJournalAcrossRollback(f.store,target),/identity conflict/);
 }finally{await f.close();}
});

test('a nonpersisting journal helper is never acceptance or permission to post',async()=>{
 const f=await fixture();try{
  f.enable();const original=f.store.put.bind(f.store);f.store.put=async(kind,value)=>kind===androidJournalKind?{...value,id:value.id}:original(kind,value);
  await assert.rejects(f.transport.notify({deviceId:'phone-a',notificationId:'lost-write',body:'must not post'},signal()),/journal could not be confirmed/);assert.equal(f.a.length,0);
 }finally{await f.close();}
});

test('a trusted private-origin reminder classification denies an automatic verified self Android route',()=>{
 const settings=defaultExtensionSettings();settings.contacts={enabled:true,automaticEnabled:true};const bodySha256=notificationDigest('private reminder'),recipientSha256=notificationDigest('phone-a');
 const binding={routeId:'route',routeRevision:1,recipientId:'phone-a',recipientSha256,workflowId:'reminders',templateId:'reminder',templateVersion:1,bodySha256};
 const decision=contactPolicy({requestId:'private-automatic',binding},{now:1000,settings,privateSession:false,containsPrivateContent:true,rules:[],approvals:[],
  route:{id:'route',revision:1,adapter:'paired-android',recipientId:'phone-a',recipientSha256,kind:'self',enabled:true,verification:{method:'user-challenge',recordId:'observed-challenge',verifiedAt:1,expiresAt:10000}},
  workflow:{id:'reminders',enabled:true,automatic:true,templateIds:['reminder']},template:{id:'reminder',version:1,bodySha256,contentClass:'private'}});
 assert.equal(decision.allowed,false);assert.equal(decision.reason,'private-automatic-content');
});
