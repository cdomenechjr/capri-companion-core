import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {relevant,projectSuggestion} from '../src/server/context';
import {Assistant} from '../src/server/assistant';
import {Store} from '../src/server/store';
import {defaults,RecordData} from '../src/shared';

const row=(id:string,content:Partial<RecordData>={}):RecordData=>({id,updatedAt:'2026-01-01T00:00:00Z',...content});
const ids=(records:RecordData[])=>records.map(record=>record.id);

test('retrieval excludes unrelated records and ignores metadata values and JSON keys',()=>{
 const records=[row('Terraria',{text:'Mint tea',source:'Terraria',origin:'Terraria',metadata:{project:'Terraria'},confirmed:true}),row('actual',{text:'Terraria workshop'}),row('other',{text:'Coffee',updatedAt:'2026-10-01T00:00:00Z',confirmed:true})];
 assert.deepEqual(ids(relevant(records,'Terraria')),['actual']);
 for(const query of ['confirmed','updatedAt','source','metadata','2026','absent'])assert.deepEqual(relevant(records,query),[],query);
});

test('text, title, project and category are searchable without coercing non-text fields',()=>{
 const records=[row('text',{text:'Orchard sketches'}),row('title',{title:'Orchard checklist'}),row('project',{project:'Orchard'}),row('category',{category:'orchard'}),row('invalid',{text:{orchard:true},title:['orchard'],project:123,category:null})];
 assert.deepEqual(new Set(ids(relevant(records,'orchard'))),new Set(['text','title','project','category']));
 assert.deepEqual(ids(relevant([records[3],records[0]],'orchard')),['text','category']);
});

test('case, punctuation, Unicode and short terms match whole words',()=>{
 const records=[row('mods',{title:'Terraria: MODS!'}),row('short',{text:'AI café notes'}),row('rust',{text:'Rust tools'}),row('substring',{text:'Trust and rusty tools'})];
 assert.deepEqual(ids(relevant(records,'terraria—mods?')),['mods']);
 assert.deepEqual(ids(relevant(records,'ＡＩ, CAFE\u0301!')),['short']);
 assert.deepEqual(ids(relevant(records,'RUST')),['rust']);
});

test('empty, punctuation-only and conversational filler queries have no matches',()=>{
 const records=[row('filler',{text:'I have a plan for you',confirmed:true})];
 for(const query of ['', ' \n ', '?!—', 'Can you please tell me about my'])assert.deepEqual(relevant(records,query),[],query);
});

test('relevance outranks confirmation and recency, and repeated words do not inflate scores',()=>{
 const records=[row('partial',{text:'Terraria Terraria Terraria',confirmed:true,updatedAt:'2026-10-01T00:00:00Z'}),row('complete',{text:'Terraria workshop'}),row('unrelated',{text:'Tea preferences',confirmed:true,updatedAt:'2026-10-02T00:00:00Z'})];
 assert.deepEqual(ids(relevant(records,'Terraria workshop')),['complete','partial']);
 assert.deepEqual(ids(relevant(records,'Terraria workshop Terraria workshop')),['complete','partial']);
});

test('complete project names outrank partial names and text mentions',()=>{
 const records=[row('partial',{project:'Atlas Professional',text:'Continue Atlas Pro',confirmed:true}),row('short',{project:'Atlas',text:'Continue Atlas Pro'}),row('mention',{text:'Please continue Atlas Pro',confirmed:true}),row('exact',{project:'ATLAS-Pro',title:'Checklist'})];
 assert.deepEqual(ids(relevant(records,'Please continue Atlas—Pro!')),['exact','short','partial','mention']);
 assert.equal(relevant(records,'atlas')[0].id,'short');
 assert.deepEqual(relevant([row('substring',{project:'Superatlas'})],'atlas'),[]);
});

test('confirmation and timestamp break relevance ties, then preserve input order without mutation',()=>{
 const records=[row('invalid-date',{text:'Tea',updatedAt:'invalid'}),row('new',{text:'Tea',updatedAt:'2026-10-01T00:00:00Z'}),row('confirmed',{text:'Tea',confirmed:true}),row('tie-a',{text:'Tea'}),row('tie-b',{text:'Tea'}),row('truthy',{text:'Tea',confirmed:'false'})];
 const snapshot=structuredClone(records);
 const expected=['confirmed','new','tie-a','tie-b','truthy','invalid-date'];
 assert.deepEqual(ids(relevant(records,'tea')),expected);
 assert.deepEqual(ids(relevant(records,'tea')),expected);
 assert.deepEqual(records,snapshot);
 assert.equal(relevant(records,'tea')[0],records[2]);
});

test('limits are finite, nonnegative integers with a default and a hard cap',()=>{
 const records=Array.from({length:130},(_,i)=>row(String(i),{text:'Tea'}));
 assert.equal(relevant(records,'tea').length,20);
 assert.equal(relevant(records,'tea',2.9).length,2);
 assert.equal(relevant(records,'tea',10000).length,100);
 for(const limit of [0,-1,0.5,NaN,Infinity,-Infinity])assert.deepEqual(relevant(records,'tea',limit),[]);
 assert.deepEqual(relevant([],'tea'),[]);
});

test('project suggestions retain active-plan priority, interests and previous-suggestion suppression',()=>{
 const memories=[row('interest',{text:'I enjoy Terraria modding'})];
 const plans=[row('done',{title:'Finished',done:true}),row('active',{title:'Workshop',done:false})];
 const first=projectSuggestion(memories,plans);
 assert.equal(first,'Got an angle for “Workshop”: we could make a small prototype and test the interesting part first.');
 const second=projectSuggestion(memories,plans,[first!]);
 assert.equal(second,'Project idea from something you mentioned: I enjoy Terraria modding. Want to turn that into something we can build?');
 assert.equal(projectSuggestion(memories,plans,[first!,second!]),undefined);
});

test('task context includes matching memories, plans and knowledge with a fake reasoning response',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'capri-memory-task-'));
 const store=await new Store(directory,randomBytes(32)).init();
 const assistant=new Assistant(store,async()=>({...defaults}),()=>undefined,()=>{},async()=>{throw Error('No host calls expected');});
 const instructions:string[]=[];
 assistant.call=async(_endpoint,body)=>{instructions.push(body.instructions);return {output:[{type:'message',content:[{type:'output_text',text:'Context received.'}]}]};};
 try{
  await store.put('memory',{text:'Terraria modding preference'});
  await store.put('memory',{text:'Unrelated coffee preference',source:'Terraria',confirmed:true});
  await store.put('plan',{title:'Workshop checklist',project:'Terraria'});
  await store.put('plan',{title:'Unrelated groceries',project:'Kitchen'});
  await store.put('knowledge',{title:'Terraria research notes'});
  await store.put('knowledge',{title:'Unrelated astronomy notes',metadata:{query:'Terraria'}});
  await assistant.chat('Terraria',false,'retrieval-context');
  await Promise.all([...assistant.jobs.values()]);
  assert.equal((await store.get('task','retrieval-context'))?.status,'completed');
  assert.equal(instructions.length,1);
  for(const content of ['Terraria modding preference','Workshop checklist','Terraria research notes'])assert.ok(instructions[0].includes(content),content);
  assert.doesNotMatch(instructions[0],/Unrelated/);
  await assistant.chat('Terraria',true,'private-retrieval-context');
  await Promise.all([...assistant.jobs.values()]);
  assert.equal((await store.get('task','private-retrieval-context'))?.status,'completed');
  assert.equal(instructions.length,2);
  for(const content of ['Terraria modding preference','Workshop checklist','Terraria research notes'])assert.ok(!instructions[1].includes(content),content);
  assert.match(instructions[1],/Personal reference data: \[\]\. Project reference data: \[\]\. Research reference data: \[\]/);
 }finally{await assistant.shutdown();await store.close();await rm(directory,{recursive:true,force:true});}
});

test('input retrieval targets correction and deletion using the existing persisted memory tools',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'capri-memory-context-'));
 const store=await new Store(directory,randomBytes(32)).init();
 const assistant=new Assistant(store,async()=>({...defaults}),()=>undefined,()=>{},async()=>{throw Error('No host calls expected');});
 const signal=new AbortController().signal;
 try{
  const tea=await assistant.tool('remember',{text:'My tea preference is mint.',source:'User conversation',category:'preference'},signal,false);
  const unrelated=await store.put('memory',{text:'My keyboard is mechanical.',confirmed:true});
  const target=relevant(await store.list('memory'),'Please correct my tea preference',1)[0];
  assert.equal(target.id,tea.id);
  await assistant.tool('update_memory',{id:target.id,text:'My tea preference is jasmine.'},signal,false);
  const corrected=relevant(await store.list('memory'),'jasmine')[0];
  assert.equal(corrected.id,tea.id);
  assert.equal(corrected.confirmed,true);
  assert.equal(corrected.source,'Corrected by user in conversation');
  assert.equal(corrected.category,'preference');
  assert.deepEqual(relevant(await store.list('memory'),'mint'),[]);
  assert.deepEqual(relevant(await store.list('memory'),'Corrected conversation'),[]);
  const removal=relevant(await store.list('memory'),'Forget my jasmine tea preference',1)[0];
  assert.equal(removal.id,tea.id);
  await assistant.tool('update_memory',{id:removal.id,remove:true},signal,false);
  assert.deepEqual(relevant(await store.list('memory'),'jasmine tea'),[]);
  assert.deepEqual(ids(await store.list('memory')),[unrelated.id]);
 }finally{await assistant.shutdown();await store.close();await rm(directory,{recursive:true,force:true});}
});

test('private correction and deletion do not alter saved memory',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'capri-memory-private-'));
 const store=await new Store(directory,randomBytes(32)).init();
 const assistant=new Assistant(store,async()=>({...defaults}),()=>undefined,()=>{},async()=>{throw Error('No host calls expected');});
 const signal=new AbortController().signal;
 try{
  const original=await store.put('memory',{text:'Jasmine tea',source:'User',confirmed:true});
  for(const args of [{id:original.id,text:'Coffee'},{id:original.id,remove:true}]){
   assert.deepEqual(await assistant.tool('update_memory',args,signal,true),{saved:false,reason:'Private session'});
   assert.deepEqual(await store.get('memory',original.id),original);
  }
 }finally{await assistant.shutdown();await store.close();await rm(directory,{recursive:true,force:true});}
});
