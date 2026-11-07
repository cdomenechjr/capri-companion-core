import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/server/store';
import {createService} from '../src/server/service';
import {ProviderError} from '../src/server/providers';
import {defaults} from '../src/shared';

const auth={authorization:'Bearer test-research-admin'};
const citation={title:'Primary source',url:'https://example.com/research'};
const success=()=>({output:[{type:'web_search_call'},{type:'message',content:[{type:'output_text',text:'A new sourced update.',annotations:[{type:'url_citation',...citation}]}]}],usage:{input_tokens:100,output_tokens:50}});
const failure=()=>new ProviderError('Fake research provider unavailable.',503,'server_error');
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

async function fixture(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'capri-research-lifecycle-'));
 const store=await new Store(dir,randomBytes(32)).init();
 await store.put('settings',{...defaults,id:'main',providerMode:'openai',localFallback:false});
 const events:any[]=[];
 const service=await createService({store,adminToken:'test-research-admin',key:()=> 'fake-key-never-sent',onEvent:event=>events.push(event)});
 const topic=await store.put('topic',{id:'subscribed-topic',title:'Original topic',active:true,lastAttempt:'2000-01-01T00:00:00.000Z',refreshedAt:'2000-01-01T00:00:00.000Z',lastError:'Previous failure',custom:'Preserved user data'});
 const priorKnowledge=await store.put('knowledge',{id:topic.id,title:topic.title,text:'Previously saved research.',citations:[citation],retrievedAt:topic.refreshedAt});
 const entered=deferred<{body:any;signal?:AbortSignal}>();const response=deferred<any>();let calls=0;
 service.assistant.router.openai=async(endpoint,body,signal)=>{calls++;assert.equal(endpoint,'responses');entered.resolve({body,signal});return response.promise;};
 service.assistant.router.local=async()=>{throw Error('Unexpected local provider call.');};
 return {store,service,topic,priorKnowledge,events,entered,response,calls:()=>calls,close:async()=>{
  // Release a pending fake even if an assertion fails, so shutdown cannot hang.
  response.resolve(success());await service.app.close();await rm(dir,{recursive:true,force:true});
 }};
}

for(const outcome of ['success','failure'] as const){
 for(const change of ['deletion','pause','title edit'] as const){
  test(`${change} during ${outcome} discards obsolete research without rewriting the subscription`,async()=>{
   const f=await fixture();
   try{
    const refresh=f.service.assistant.refreshTopics();await f.entered.promise;
    const attempt=await f.store.get('topic',f.topic.id);assert.ok(attempt?.lastAttempt);
    const changed=await f.service.app.inject(change==='deletion'
     ?{method:'DELETE',url:'/v1/records/topic/'+f.topic.id,headers:auth}
     :{method:'POST',url:'/v1/records/topic',headers:auth,payload:{id:f.topic.id,title:change==='title edit'?'Edited topic':f.topic.title,active:change!=='pause'}});
    assert.equal(changed.statusCode,200);
    const current=await f.store.get('topic',f.topic.id);
    const eventsBefore=f.events.length;
    if(outcome==='success')f.response.resolve(success());else f.response.reject(failure());
    await refresh;
    assert.deepEqual(await f.store.get('topic',f.topic.id),current);
    assert.deepEqual(await f.store.get('knowledge',f.topic.id),f.priorKnowledge);
    assert.deepEqual(f.events.slice(eventsBefore).filter(e=>e.type==='changed'&&['topic','knowledge'].includes(e.kind)),[]);
    await f.service.assistant.refreshTopics();assert.equal(f.calls(),1,'discarding a result must not repeat research');
   }finally{await f.close();}
  });
 }
}

for(const outcome of ['success','failure'] as const){
 test(`a replacement subscription using the same ID does not receive an old ${outcome}`,async()=>{
  const f=await fixture();
  try{
   const refresh=f.service.assistant.refreshTopics();await f.entered.promise;
   assert.equal((await f.service.app.inject({method:'DELETE',url:'/v1/records/topic/'+f.topic.id,headers:auth})).statusCode,200);
   const replaced=await f.service.app.inject({method:'POST',url:'/v1/records/topic',headers:auth,payload:{id:f.topic.id,title:f.topic.title,active:true}});assert.equal(replaced.statusCode,200);
   const current=await f.store.get('topic',f.topic.id);
   if(outcome==='success')f.response.resolve(success());else f.response.reject(failure());
   await refresh;
   assert.deepEqual(await f.store.get('topic',f.topic.id),current);
   assert.deepEqual(await f.store.get('knowledge',f.topic.id),f.priorKnowledge);
   assert.equal(f.calls(),1);
  }finally{await f.close();}
 });

 test(`Stop ignores a late provider ${outcome} even when the provider ignores cancellation`,async()=>{
  const f=await fixture();
  try{
   const refresh=f.service.assistant.refreshTopics();const {signal}=await f.entered.promise;
   const attempt=await f.store.get('topic',f.topic.id);
   const stopped=await f.service.app.inject({method:'POST',url:'/v1/stop',headers:auth});assert.equal(stopped.statusCode,200);assert.equal(signal?.aborted,true);
   const eventsBefore=f.events.length;
   if(outcome==='success')f.response.resolve(success());else f.response.reject(failure());
   await refresh;
   assert.deepEqual(await f.store.get('topic',f.topic.id),attempt);
   assert.deepEqual(await f.store.get('knowledge',f.topic.id),f.priorKnowledge);
   assert.deepEqual(f.events.slice(eventsBefore).filter(e=>e.type==='changed'&&['topic','knowledge'].includes(e.kind)),[]);
   await f.service.assistant.refreshTopics();assert.equal(f.calls(),1);
   const usage=await f.store.list('usage');assert.equal(usage.length,1);assert.equal(usage[0].reserved,false);
  }finally{await f.close();}
 });
}

test('an unchanged subscription publishes citations and metadata once, with normal routing and budget settlement',async()=>{
 const f=await fixture();
 try{
  const refresh=f.service.assistant.refreshTopics();const {body}=await f.entered.promise;
  assert.equal(f.service.assistant.refreshTopics(),refresh,'concurrent refreshes share one job');
  assert.equal(body.model,defaults.model);assert.equal(body.input,f.topic.title);assert.deepEqual(body.tools,[{type:'web_search'}]);assert.equal(body.max_tool_calls,3);assert.equal(body.max_output_tokens,900);assert.equal(body.store,false);
  f.response.resolve(success());await refresh;
  const knowledge=await f.store.get('knowledge',f.topic.id);assert.ok(knowledge);
  assert.equal(knowledge.title,f.topic.title);assert.equal(knowledge.text,'A new sourced update.');assert.deepEqual(knowledge.citations,[citation]);assert.ok(Date.parse(knowledge.retrievedAt)>Date.parse(f.priorKnowledge.retrievedAt));
  const current=await f.store.get('topic',f.topic.id);assert.ok(current);assert.equal(current.active,true);assert.equal(current.custom,f.topic.custom);assert.equal(current.lastError,'');assert.ok(Date.parse(current.refreshedAt)>Date.parse(f.topic.refreshedAt));
  assert.equal(f.events.filter(e=>e.type==='changed'&&e.kind==='knowledge').length,1);
  await f.service.assistant.refreshTopics();assert.equal(f.calls(),1);
  const usage=await f.store.list('usage');assert.equal(usage.length,1);assert.equal(usage[0].category,'reasoning');assert.equal(usage[0].reserved,false);assert.ok(usage[0].amount>0);
 }finally{await f.close();}
});

test('an unchanged failed subscription records the error and keeps daily throttling and existing knowledge',async()=>{
 const f=await fixture();
 try{
  const refresh=f.service.assistant.refreshTopics();await f.entered.promise;f.response.reject(failure());await refresh;
  const current=await f.store.get('topic',f.topic.id);assert.ok(current);assert.equal(current.lastError,failure().message);assert.equal(current.refreshedAt,f.topic.refreshedAt);assert.equal(current.custom,f.topic.custom);
  assert.deepEqual(await f.store.get('knowledge',f.topic.id),f.priorKnowledge);
  await f.service.assistant.refreshTopics();assert.equal(f.calls(),1);
 }finally{await f.close();}
});
