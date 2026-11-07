import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,realpath,rm,link,truncate} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/server/store';
import {Assistant} from '../src/server/assistant';
import {HostTools} from '../src/server/host';
import type {commandProcess} from '../src/server/commands';
import {defaults} from '../src/shared';
import {createExtensionHub,hubRecordKinds,type HubHostContext,type HubContext} from '../src/extensions/hub';
import {defaultExtensionSettings} from '../src/extensions/contracts';
import {resolveSkillHostFacts,skillRecordKinds,builtInSkill,skillManifestSha256} from '../src/extensions/skills';
import {skillEvidenceKind,fileWriteEvidenceKind,observeSkillProof} from '../src/extensions/skill-verification';

const done=(text='Done.')=>({output:[{type:'message',content:[{type:'output_text',text}]}]});
const call=(name:string,args:any,id='produce-1')=>({output:[{type:'function_call',name,arguments:JSON.stringify(args),call_id:id}]});
async function fixture(options:{handlers?:string[];privateSession?:boolean;images?:boolean;coding?:boolean;research?:boolean;skillsEnabled?:boolean;command?:typeof commandProcess}={}){
  const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'capri-skill-task-'))),workspace=path.join(directory,'workspace');await mkdir(workspace);
  const store=await new Store(directory,randomBytes(32)).init(),events:any[]=[];
  const settings=async()=>({...defaults,providerMode:'local' as const,roots:[workspace]});
  const host=new HostTools(store,settings,async()=>true,async()=>{throw Error('No native calls allowed in this fixture.');},{command:options.command});
  const saved=defaultExtensionSettings();saved.skills.enabled=options.skillsEnabled??true;await store.put(hubRecordKinds.settings,{id:'main',schemaVersion:1,settings:saved});
  const hub=await createExtensionHub({store,clock:Date.now,profile:'self-test',skillFacts:async()=>resolveSkillHostFacts({
    capabilities:[{id:'artifacts',available:true},{id:'images',available:!!options.images},{id:'coding',available:!!options.coding}],tools:['create_artifact','add_plan','update_plan',...(options.images?['generate_image']:[]),...(options.coding?['read_file','list_files','write_file','run_command']:[]),...(options.research?['web_search_local','browser_read']:[])],availableVerifiers:options.handlers})});
  let handle:HubContext,source:HubHostContext;let heldGrant:unknown,epoch='session-1';
  const ai=new Assistant(store,settings,()=>undefined,event=>events.push(event),(name,args,signal,id)=>host.run(name,args,signal,id),async(phase,task)=>{
    if(phase==='start'){
      host.begin(task.id,task.text);heldGrant=host.access.get(task.id);
      source={authority:'task',taskId:task.id,privateSession:!!task.privateSession,localOnly:!!task.localOnly,privacyEpoch:epoch,signal:ai.controllers.get(task.id)!.signal};
      handle=hub.context(()=>{if(host.access.get(task.id)!==heldGrant)throw Error('Grant revoked.');return source;});
    }else if(phase==='end'){host.end(task.id);hub.releaseContext(handle);}
  });
  ai.extensions={hub,context:()=>handle};ai.router.available=async()=>true;
  const artifact={path:'memo.md',format:'md',title:'Memo',sections:[{heading:'Test',text:'Neutral test content.'}]};
  const requests:string[]=[];
  const run=async(responses:any[],text='Create a markdown document',id='task-1')=>{let index=0;ai.call=async endpoint=>{requests.push(endpoint);const response=responses[index++];if(typeof response==='function')return response();return response??done();};await ai.chat(text,!!options.privateSession,id);await ai.jobs.get(id);return store.get('task',id);};
  return {store,host,hub,ai,events,workspace,artifact,run,requests,source:()=>source,setEpoch:(value:string)=>{epoch=value;},
    async close(){await ai.shutdown();host.close();await hub.close();await store.close();await rm(directory,{recursive:true,force:true});}};
}

test('ordinary document and research questions answer/store/emit with ready skills on or off, without claiming verified workflows',async()=>{
  for(const skillsEnabled of [true,false])for(const text of [
    'What is the difference between a PDF document and a spreadsheet?',
    'What does a citation mean in research?',
    'Explain how to create a PDF document.',
    'Compare a PDF document and a spreadsheet.',
    'Write a letter to my landlord',
    'Make a table comparing X and Y',
    'Write a Python script that sorts a list',
    'Fix this Python code snippet',
  ]){
    const f=await fixture({research:true,coding:true,skillsEnabled});try{
      const answer='A neutral informational answer for this question.',task=await f.run([async()=>{
        const selection=await f.hub.selectSkills({text},f.ai.extensions!.context('task-1'));
        assert.equal(selection.selected.length>0,skillsEnabled,'The regression exercises ready recipes, not missing handlers.');
        return done(answer);
      }],text);
      assert.equal(task?.status,'completed',text);assert.equal(task?.taskVerified,false,text);
      const messages=(await f.store.list('message')).filter(row=>row.role==='assistant');
      assert.equal(messages.length,1);assert.equal(messages[0].text,answer);assert.equal(messages[0].taskVerified,false);
      assert.equal(f.events.filter(event=>event.type==='message'&&event.message.text===answer).length,1);
      assert.equal(f.events.filter(event=>event.state==='success'&&event.taskVerified===false).length,1);
      assert.deepEqual(await f.store.list('artifact'),[]);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
    }finally{await f.close();}
  }
});

test('actual read_file plus a document explanation completes without requiring an invented artifact',async()=>{
  const f=await fixture({coding:true});try{
    await writeFile(path.join(f.workspace,'existing-note.md'),'A neutral note to explain.');
    const answer='The note contains a neutral statement.';
    const task=await f.run([call('read_file',{path:'existing-note.md'}),done(answer)],'What does this document say? Read existing-note.md and explain it.');
    assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,false);assert.equal(task?.evidence.toolsSucceeded.read_file,1);
    assert.equal((await f.store.list('message')).find(row=>row.role==='assistant')?.text,answer);
    assert.equal(f.events.some(event=>event.type==='message'&&event.message.text===answer),true);
    assert.deepEqual(await f.store.list('artifact'),[]);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
  }finally{await f.close();}
});

test('fresh zero-outcome document planning executes real writer and verifies its own read-back before success',async()=>{
  const f=await fixture();try{
    assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
    const task=await f.run([call('create_artifact',f.artifact),done('Saved memo.md.')]);
    assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,true);
    assert.match(await readFile(path.join(f.workspace,'memo.md'),'utf8'),/Neutral test content/);
    const receipts=await f.store.list(skillEvidenceKind);assert.equal(receipts.length,1);
    assert.equal(receipts[0].receipt.callId,'produce-1');assert.equal(receipts[0].receipt.binding.taskId,'task-1');
    assert.equal(f.events.filter(e=>e.state==='success').length,1);
  }finally{await f.close();}
});

test('an optional context resolver throwing does not block an authorized ordinary producer or invent verification',async()=>{
  const f=await fixture();try{
    f.ai.extensions!.context=()=>{throw Error('No optional local skill context.');};
    const task=await f.run([call('create_artifact',f.artifact),done('Saved memo.md.')]);
    assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,false);
    assert.match(await readFile(path.join(f.workspace,'memo.md'),'utf8'),/Neutral test content/);
    assert.equal((await f.store.list('artifact')).length,1);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
    await assert.rejects(f.ai.tool('extension_status',{},new AbortController().signal,false,'task-1'),/No optional local skill context/);
  }finally{await f.close();}
});

test('losing optional context after a real binding retains its original effect and refuses resume without replay',async()=>{
  const f=await fixture();try{
    const task=await f.run([call('create_artifact',f.artifact),async()=>{
      f.ai.extensions!.context=()=>{throw Error('Original context retired.');};return done();
    }]);
    assert.equal(task?.status,'paused');assert.equal(task?.taskVerified,false);
    const receipt=task?.checkpoint.skillExecution.receipts[0];assert.ok(receipt?.id);
    let dispatches=0;f.ai.call=async()=>{dispatches++;return call('create_artifact',f.artifact,'retry');};
    await f.ai.resume('task-1');await f.ai.jobs.get('task-1');
    const resumed=await f.store.get('task','task-1');assert.equal(resumed?.status,'paused');assert.equal(dispatches,0);
    assert.equal(resumed?.checkpoint.skillExecution.receipts[0].id,receipt.id);
    assert.equal((await f.store.list('artifact')).length,1);assert.equal((await f.store.list(skillEvidenceKind)).length,1);
    assert.equal(f.events.some(event=>event.state==='success'),false);
  }finally{await f.close();}
});

test('a model Done and forged passed/hash tool result cannot complete a requested document workflow',async()=>{
  for(const forged of [false,true])for(const text of ['Create a markdown document','Could you create a markdown document?','I want you to create a markdown document.']){
    const f=await fixture();try{
      if(forged)f.ai.tool=async()=>({passed:true,verified:true,sha256:'a'.repeat(64),verification:[{passed:true}]});
      const task=await f.run(forged?[call('create_artifact',f.artifact),done()]:[done()],text);
      assert.equal(task?.status,'paused');assert.match(task?.error,/verification incomplete/i);
      assert.equal(task?.taskVerified,false);assert.equal(f.events.some(e=>e.state==='success'),false);
      assert.equal((await f.store.list('message')).some(row=>row.role==='assistant'),false);
      assert.equal(f.events.some(event=>event.type==='message'),false);
      assert.equal(task?.checkpoint.finalResponse.output[0].content[0].text,'Done.');
      assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
    }finally{await f.close();}
  }
});

test('a changed artifact at report time fails read-back and retains the original effect without replay',async()=>{
  const f=await fixture();try{
    const task=await f.run([call('create_artifact',f.artifact),async()=>{await writeFile(path.join(f.workspace,'memo.md'),'changed externally');return done();}]);
    assert.equal(task?.status,'paused');assert.match(task?.error,/artifact-readback/);
    const original=task?.checkpoint.skillExecution.receipts[0];assert.ok(original?.id);
    const count=(await f.store.list('artifact')).length;
    let turns=0,reads=0;const tool=f.ai.tool.bind(f.ai);
    f.ai.tool=async(...args)=>{if(args[0]==='read_file')reads++;return tool(...args);};
    f.ai.call=async()=>++turns===1?call('create_artifact',f.artifact,'cached-write'):turns===2?call('read_file',{path:'memo.md'},'fresh-read'):done();
    await f.ai.resume('task-1');await f.ai.jobs.get('task-1');
    const resumed=await f.store.get('task','task-1');assert.equal(resumed?.status,'paused');
    assert.equal(turns,3);assert.equal(reads,1,'Incomplete read-back permits fresh reconciliation on ordinary Resume.');
    assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
    assert.equal((await f.store.list('artifact')).length,count);assert.equal(await readFile(path.join(f.workspace,'memo.md'),'utf8'),'changed externally');
    assert.equal(resumed?.checkpoint.skillExecution.receipts[0].id,original.id);assert.equal((await f.store.list(skillEvidenceKind)).length,1);
  }finally{await f.close();}
});

test('prior-task artifact rows and receipts cannot verify another task',async()=>{
  const f=await fixture();try{
    assert.equal((await f.run([call('create_artifact',f.artifact),done()]))?.taskVerified,true);
    const old=(await f.store.list('artifact'))[0];f.ai.tool=async()=>old;
    const task=await f.run([call('create_artifact',f.artifact,'other-call'),done()],'Create a markdown document','task-2');
    assert.equal(task?.status,'paused');assert.equal(task?.taskVerified,false);assert.equal((await f.store.list('artifact')).length,1);
  }finally{await f.close();}
});

test('grant revocation, review revocation, privacy epoch and Stop prevent verified completion after a real effect',async()=>{
  for(const boundary of ['grant','review','epoch','private','stop'] as const){
    const f=await fixture();try{
      const task=await f.run([call('create_artifact',f.artifact),async()=>{
        if(boundary==='grant')f.host.access.revoke('task-1');
        if(boundary==='review'){const skill=builtInSkill('document-artifacts')!;await f.store.put(skillRecordKinds.review,{id:skill.manifest.id,skillId:skill.manifest.id,version:skill.manifest.version,manifestSha256:skillManifestSha256(skill.manifest),sourceSha256:skill.manifest.sourceSha256,reviewedAt:Date.now(),revoked:true});}
        if(boundary==='epoch')f.source().privacyEpoch='session-2';
        if(boundary==='private')f.source().privateSession=true;
        if(boundary==='stop')await f.ai.stop();
        return done('Done; do not trust this completion.');
      }]);
      assert.notEqual(task?.status,'completed',boundary);assert.equal(f.events.some(e=>e.state==='success'),false,boundary);
      assert.equal((await f.store.list('artifact')).length,1,boundary);
      assert.equal(task?.checkpoint.skillExecution.receipts.length,1,boundary);
    }finally{await f.close();}
  }
});

test('missing handler remains unavailable and cannot inherit earlier outcome facts',async()=>{
  const f=await fixture({handlers:[]});try{
    f.host.begin('planning','Create a document');const source:HubHostContext={authority:'task',taskId:'planning',privateSession:false,localOnly:true,privacyEpoch:'epoch',signal:new AbortController().signal};
    const context=f.hub.context(()=>source),selection=await f.hub.selectSkills({text:'Create a markdown document'},context);
    assert.deepEqual(selection.selected,[]);assert.equal(selection.unavailable[0].state,'verification-required');
    assert.deepEqual(selection.unavailable[0].missing.checks,['artifact-readback']);assert.match(selection.unavailable[0].verifierReasons!['artifact-readback'],/not installed/);
  }finally{await f.close();}
});

test('installing a missing handler on resume permits planning without upgrading the retained unverified answer',async()=>{
  const handlers:string[]=[],f=await fixture({handlers});try{
    const task=await f.run([done('Useful saved-file draft.')],'Save a markdown document');
    assert.equal(task?.status,'paused');assert.equal(task?.checkpoint.skillExecution.bindings.length,0);
    handlers.push('artifact-readback');let turns=0;f.ai.call=async()=>{turns++;return done();};
    await f.ai.resume('task-1');await f.ai.jobs.get('task-1');
    const resumed=await f.store.get('task','task-1');assert.equal(resumed?.status,'paused');assert.equal(resumed?.taskVerified,false);
    assert.equal(resumed?.checkpoint.skillExecution.bindings.length,1);assert.deepEqual(resumed?.checkpoint.skillExecution.receipts,[]);
    assert.equal(turns,1);assert.deepEqual(await f.store.list('artifact'),[]);assert.equal(f.events.some(event=>event.state==='success'||event.type==='message'),false);
  }finally{await f.close();}
});

test('private proof stays ephemeral and is discarded at its boundary',async()=>{
  const f=await fixture({privateSession:true});try{
    const task=await f.run([call('create_artifact',f.artifact),done()]);assert.equal(task?.status,'completed');
    assert.deepEqual(await f.store.list(skillEvidenceKind),[]);assert.equal(JSON.stringify(await f.store.list('task')).includes('manifestSha256'),false);
  }finally{await f.close();}
});

test('verified plan creation and update preserve private classification and task-scoped change events',async()=>{
  for(const privateSession of [false,true]){
    const f=await fixture({privateSession});try{
      const task=await f.run([call('add_plan',{title:'Neutral reminder',dueAt:''},'plan-add'),async()=>{
        const [plan]=await f.store.list('plan');assert.ok(plan);
        return call('update_plan',{id:plan.id,title:'Updated neutral reminder'},'plan-update');
      },done('Saved the reminder.')],'Create a reminder');
      assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,true);
      const [plan]=await f.store.list('plan');assert.equal(plan.title,'Updated neutral reminder');
      assert.equal(plan.contentClass,privateSession?'private':undefined);
      assert.equal(plan.originTaskId,privateSession?'task-1':undefined);
      const changes=f.events.filter(event=>event.type==='changed'&&event.kind==='plan');
      assert.equal(changes.length,2);assert.equal(changes.every(event=>event.taskId==='task-1'),true);
      assert.equal(f.events.some(event=>event.type==='changed'&&event.kind==='task'&&event.taskId==='task-1'),true);
      assert.equal((await f.store.list(skillEvidenceKind)).length,privateSession?0:2);
    }finally{await f.close();}
  }
});

test('private verification failure retains its checkpoint while persisting only the private error summary',async()=>{
  const f=await fixture({privateSession:true});try{
    const task=await f.run([done('Done without an artifact.')]);
    assert.equal(task?.status,'paused');assert.equal(task?.taskVerified,false);assert.equal(task?.result,undefined);
    assert.equal(task?.error,'Private task ended. Review within the active session.');
    assert.equal(f.ai.privateCheckpoints.has('task-1'),true);
    assert.equal((f.ai.privateCheckpoints.get('task-1') as any).finalResponse.output[0].content[0].text,'Done without an artifact.');
    assert.equal(f.events.some(event=>event.type==='message'),false);
    assert.equal(f.events.some(event=>event.state==='success'),false);
    assert.equal(JSON.stringify(await f.store.list('task')).includes('Done without an artifact.'),false);assert.deepEqual(await f.store.list('message'),[]);
    assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
  }finally{await f.close();}
});

test('Stop discards a paused private final draft even without service composition',async()=>{
  const f=await fixture({privateSession:true});try{
    const task=await f.run([done('Private ephemeral draft.')]);assert.equal(task?.status,'paused');assert.equal(f.ai.privateCheckpoints.has('task-1'),true);
    await f.ai.stop();assert.equal(f.ai.privateCheckpoints.has('task-1'),false);assert.equal(f.ai.privateRequests.has('task-1'),false);
    await assert.rejects(f.ai.resume('task-1'),/Private tasks cannot resume/);
    assert.deepEqual(await f.store.list('message'),[]);assert.equal(JSON.stringify(await f.store.list('task')).includes('Private ephemeral draft.'),false);
    assert.equal(f.events.some(event=>event.state==='success'),false);
  }finally{await f.close();}
});

test('same-session private review, settings and grant failures retain checkpoint drafts until actual Stop',async()=>{
  for(const boundary of ['review','settings','grant'] as const){
    const f=await fixture({privateSession:true});try{
      const answer='Private draft retained for its live owner after '+boundary;
      const task=await f.run([async()=>{
        if(boundary==='review'){
          const skill=builtInSkill('document-artifacts')!;
          await f.store.put(skillRecordKinds.review,{id:skill.manifest.id,skillId:skill.manifest.id,version:skill.manifest.version,
            manifestSha256:skillManifestSha256(skill.manifest),sourceSha256:skill.manifest.sourceSha256,reviewedAt:Date.now(),revoked:true});
        }else if(boundary==='settings'){
          const settings=defaultExtensionSettings();settings.skills.enabled=false;
          await f.store.put(hubRecordKinds.settings,{id:'main',schemaVersion:1,settings});
        }else f.host.end('task-1');
        return done(answer);
      }]);
      assert.equal(task?.status,'paused',boundary);assert.equal(task?.taskVerified,false);
      assert.equal(f.source().privacyEpoch,'session-1');assert.equal(f.source().signal.aborted,false);
      assert.equal((f.ai.privateCheckpoints.get('task-1') as any)?.finalResponse.output[0].content[0].text,answer,boundary);
      assert.equal(f.ai.privateRequests.has('task-1'),true);
      assert.deepEqual(await f.store.list('message'),[]);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
      assert.equal(JSON.stringify(await f.store.list('task')).includes(answer),false);
      assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
      await f.ai.stop();assert.equal(f.ai.privateCheckpoints.has('task-1'),false);assert.equal(f.ai.privateRequests.has('task-1'),false);
    }finally{await f.close();}
  }
});

test('select_skills supplies advice; only a later producing call starts outcome verification',async()=>{
  for(const produce of [false,true]){
    const f=await fixture();try{
      const tool=f.ai.tool.bind(f.ai);let selection:any;
      f.ai.tool=async(...args)=>{const result=await tool(...args);if(args[0]==='select_skills')selection=result;return result;};
      const responses=[call('select_skills',{text:'Create a markdown document'},'select-1'),...(produce?[call('create_artifact',f.artifact)]:[]),done()];
      const task=await f.run(responses,'Hello Capri');
      assert.equal(selection.selection.selected[0].skillId,'document-artifacts');assert.equal(selection.guidance[0].skillId,'document-artifacts');
      assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,produce);
      assert.equal((await f.store.list(skillEvidenceKind)).length,produce?1:0);
    }finally{await f.close();}
  }
});

test('a legacy checkpoint cannot turn a cached artifact result into newly manufactured proof',async()=>{
  const f=await fixture();try{
    await f.run([call('create_artifact',f.artifact),done()]);
    const completed=await f.store.get('task','task-1'),artifact=(await f.store.list('artifact'))[0];
    // Simulate a legacy checkpoint which retained an effect but predates skill receipts.
    const {createHash}=await import('node:crypto');
    const key=createHash('sha256').update('create_artifact:'+JSON.stringify(f.artifact)).digest('hex');
    await f.store.put('task',{...completed,status:'interrupted',taskVerified:false,checkpoint:{input:[],executed:[[key,artifact]],actions:1,elapsedMs:0,phase:'recover',sources:[]}});
    const receipts=(await f.store.list(skillEvidenceKind)).length;let turn=0;
    f.ai.call=async()=>++turn===1?call('create_artifact',f.artifact,'cached-legacy'):done();
    await f.ai.resume('task-1');await f.ai.jobs.get('task-1');
    const resumed=await f.store.get('task','task-1');assert.equal(resumed?.status,'paused');assert.match(resumed?.error,/artifact-readback/);
    assert.equal(resumed?.checkpoint.skillExecution.receipts.length,0);assert.equal((await f.store.list(skillEvidenceKind)).length,receipts);
    assert.equal((await f.store.list('artifact')).length,1);
  }finally{await f.close();}
});

test('a restarted task session keeps original effects but refuses to transplant execution evidence across epochs',async()=>{
  const f=await fixture();try{
    await f.run([call('create_artifact',f.artifact),{output:[]}]);
    const paused=await f.store.get('task','task-1'),receiptId=paused?.checkpoint.skillExecution.receipts[0].id;
    assert.equal(paused?.status,'paused');f.setEpoch('restarted-session');let dispatches=0;
    const real=f.ai.tool.bind(f.ai);f.ai.tool=async(...args)=>{dispatches++;return real(...args);};f.ai.call=async()=>done();
    await f.ai.resume('task-1');await f.ai.jobs.get('task-1');
    const resumed=await f.store.get('task','task-1');assert.notEqual(resumed?.status,'completed');assert.equal(dispatches,0);
    assert.equal(resumed?.checkpoint.skillExecution.receipts[0].id,receiptId);assert.equal((await f.store.list('artifact')).length,1);
  }finally{await f.close();}
});

test('same-session resume reuses the original artifact receipt without dispatching its write again',async()=>{
  const f=await fixture();try{
    const paused=await f.run([call('create_artifact',f.artifact),{output:[]}]);assert.equal(paused?.status,'paused');
    const receiptId=paused?.checkpoint.skillExecution.receipts[0].id;let turn=0;
    f.ai.call=async()=>++turn===1?call('create_artifact',f.artifact,'cached-resume'):done('The recorded artifact is still present.');
    await f.ai.resume('task-1');await f.ai.jobs.get('task-1');
    const resumed=await f.store.get('task','task-1');assert.equal(resumed?.status,'completed');assert.equal(resumed?.taskVerified,true);
    assert.equal((await f.store.list('artifact')).length,1);const receipts=await f.store.list(skillEvidenceKind);
    assert.equal(receipts.length,1);assert.equal(receipts[0].id,receiptId);
  }finally{await f.close();}
});

test('ordinary Resume continues a saved-file workflow when its retained draft has no effect proof',async()=>{
  const f=await fixture();try{
    const answer='Here is the retained memo draft.';
    const task=await f.run([done(answer)],'Save a markdown document');
    assert.equal(task?.status,'paused');assert.equal(task?.checkpoint.finalResponse.output[0].content[0].text,answer);
    assert.equal((await f.store.list('message')).filter(row=>row.role==='assistant').length,0);
    assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
    let turns=0;
    const responses=[call('create_artifact',f.artifact),done('Saved the requested document.')];f.ai.call=async()=>{turns++;return responses.shift()??done();};
    await f.ai.resume('task-1');await f.ai.jobs.get('task-1');
    const completed=await f.store.get('task','task-1');assert.equal(completed?.status,'completed');assert.equal(completed?.taskVerified,true);
    assert.equal(turns,2);assert.equal((await f.store.list('artifact')).length,1);
    const messages=(await f.store.list('message')).filter(row=>row.role==='assistant');assert.equal(messages.length,1);
    assert.equal(messages[0].text,'Saved the requested document.');assert.equal(messages[0].taskVerified,true);
  }finally{await f.close();}
});

test('evidence-only Resume reads back the restored artifact and reuses the answer and original receipt without model or effect replay',async()=>{
  const f=await fixture();try{
    const answer='Original answer awaiting artifact verification.';let original='';
    const paused=await f.run([call('create_artifact',f.artifact),async()=>{
      original=await readFile(path.join(f.workspace,'memo.md'),'utf8');
      await writeFile(path.join(f.workspace,'memo.md'),'External mismatch.');return done(answer);
    }]);
    assert.equal(paused?.status,'paused');const receipt=paused?.checkpoint.skillExecution.receipts[0];assert.ok(receipt);
    await writeFile(path.join(f.workspace,'memo.md'),original);
    let turns=0;f.ai.call=async()=>{turns++;throw Error('No new model turn is needed for complete retained evidence.');};
    await f.ai.resume('task-1');await f.ai.jobs.get('task-1');
    const completed=await f.store.get('task','task-1');assert.equal(completed?.status,'completed');assert.equal(completed?.taskVerified,true);
    assert.equal(completed?.result,answer);assert.equal(turns,0);
    assert.equal((await f.store.list('artifact')).length,1);assert.deepEqual((await f.store.list(skillEvidenceKind))[0].receipt,receipt);
    assert.equal((await f.store.list(skillEvidenceKind)).length,1);assert.equal(f.events.filter(event=>event.type==='message').length,1);
  }finally{await f.close();}
});

test('explicitly saving a standalone script needs real file proof, while retaining the useful chat code draft',async()=>{
  const f=await fixture({coding:true});try{
    const answer='def sorted_copy(values): return sorted(values)';
    const task=await f.run([done(answer)],'Write a Python script and save it as sort.py');
    assert.equal(task?.status,'paused');assert.equal(task?.taskVerified,false);assert.match(task?.error,/saved output.*read-back proof/);
    assert.equal(task?.checkpoint.finalResponse.output[0].content[0].text,answer);
    assert.equal((await f.store.list('message')).some(row=>row.role==='assistant'),false);
    assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
  }finally{await f.close();}
});

test('unsupported toolchains return useful explicitly unverified replies with persisted precise reasons',async()=>{
  for(const language of ['Ruby','Java','C++']){
    const f=await fixture({coding:true});try{
      const answer='A useful repair draft, still requiring project verification.';
      const task=await f.run([done(answer)],`Fix the ${language} project and run tests`);
      assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,false);assert.match(task?.result,/Task unverified/);
      assert.match(task?.result,/Project command verification is unavailable/);assert.ok(task?.result.startsWith(answer));assert.equal(task?.verifierReasons.length,1);
      const message=(await f.store.list('message')).find(row=>row.role==='assistant');assert.equal(message?.taskVerified,false);
      assert.deepEqual(message?.verifierReasons,task?.verifierReasons);assert.equal(message?.text,task?.result);
      assert.equal(f.events.some(event=>event.taskVerified===true||event.message?.taskVerified===true),false);
      assert.deepEqual(await f.store.list(skillEvidenceKind),[]);assert.equal(task?.actions,0);
    }finally{await f.close();}
  }
});

test('ordinary new text files and note edits execute once and read back without coding obligations',async()=>{
  for(const [text,target,before] of [
    ['Write my shopping list to shoppinglist/list.txt','shoppinglist/list.txt',null],
    ['Edit notes.md to add milk','notes.md','Existing notes.'],
    ['Save this to a file named list.txt','list.txt',null],
  ] as const){
    const f=await fixture({coding:true});try{
      if(before!==null)await writeFile(path.join(f.workspace,target),before);
      let writes=0,commands=0;const tool=f.ai.tool.bind(f.ai);f.ai.tool=async(name,...args)=>{if(name==='write_file')writes++;if(name==='run_command')commands++;return tool(name,...args);};
      const args={path:target,content:'Milk and bread.'};
      const task=await f.run([call('write_file',args,'actual-write'),call('write_file',args,'cached-write'),call('read_file',{path:target},'read-written'),done('Saved the list.')],text);
      assert.equal(task?.status,'completed',text);assert.equal(task?.taskVerified,false);assert.equal(writes,1);assert.equal(commands,0);
      assert.equal(await readFile(path.join(f.workspace,target),'utf8'),args.content);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
      const [backup]=await f.store.list('backup');assert.equal(backup.before,before);
      const [witness]=await f.store.list(fileWriteEvidenceKind);assert.equal(witness.receipt.callId,'actual-write');assert.equal(witness.receipt.binding.taskId,'task-1');
      if(before===null){assert.match(task?.result,/no prior bytes/i);assert.match(task?.result,/restore_file cannot remove/i);}
    }finally{await f.close();}
  }
});

test('missing or forged direct saved output stays incomplete, even without a coding recipe',async()=>{
  for(const mode of ['missing','forged','changed','receipt-forged'] as const){
    const f=await fixture({coding:true});try{
      if(mode==='forged')f.ai.tool=async()=>({path:'list.txt',verified:true,passed:true,sha256:'a'.repeat(64)});
      const args={path:'list.txt',content:'Milk.'},responses=mode==='missing'?[done()]:[call('write_file',args),async()=>{
        if(mode==='changed')await writeFile(path.join(f.workspace,'list.txt'),'Changed externally.');
        if(mode==='receipt-forged'){const [row]=await f.store.list(fileWriteEvidenceKind);row.receipt.callId='another-call';await f.store.put(fileWriteEvidenceKind,row);}
        return done();
      }];
      const task=await f.run(responses,'Save this to a file named list.txt');
      assert.equal(task?.status,'paused',mode);assert.equal(task?.taskVerified,false);assert.match(task?.error,/read-back proof/);
      assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
    }finally{await f.close();}
  }
});

test('an unavailable optional check never excuses missing or forged available artifact evidence',async()=>{
  for(const mode of ['missing','forged','valid','failed','uncertain'] as const){
    const f=await fixture({coding:true});try{
      if(mode==='forged')f.ai.tool=async()=>({passed:true,verified:true,sha256:'a'.repeat(64)});
      if(mode==='failed')f.ai.tool=async()=>({code:1,output:'Build failed.'});
      if(mode==='uncertain')f.ai.tool=async()=>({error:'Outcome unknown.',uncertain:true});
      const task=await f.run([...(mode==='missing'?[]:[call('create_artifact',f.artifact)]),done('A useful Ruby repair and memo draft.')],
        'Fix the Ruby project and run tests and save a markdown document');
      assert.equal(task?.status,mode==='valid'?'completed':'paused',mode);assert.equal(task?.taskVerified,false);
      assert.equal(f.events.some(event=>event.taskVerified===true||event.message?.taskVerified===true),false);
      if(mode==='valid'){assert.match(task?.result,/unavailable for ruby/);assert.equal((await f.store.list('artifact')).length,1);}
      else assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
    }finally{await f.close();}
  }
});

test('unsupported Java toolchains retain available write checks and report command limitations without verified claims',async()=>{
  for(const mode of ['valid','failed-command','forged-write','changed-file'] as const){
    let commands=0;const f=await fixture({coding:true,command:async()=>{commands++;return {code:mode==='failed-command'?1:0,output:'Injected toolchain exit receipt.',untrusted:true};}});
    try{
      if(mode==='forged-write')f.ai.tool=async()=>({passed:true,verified:true});
      const args={path:'Example.java',content:'class Example {}'};
      const task=await f.run([call('write_file',args,'java-write'),...(mode==='forged-write'?[]:[call('run_command',{command:'mvn test',target:'selected project'},'java-test')]),async()=>{
        if(mode==='changed-file')await writeFile(path.join(f.workspace,args.path),'External mismatch.');return done('Java source draft and observed command status.');
      }],'Fix the Java project and run tests');
      assert.equal(task?.status,mode==='valid'?'completed':'paused',mode);assert.equal(task?.taskVerified,false);
      assert.equal(f.events.some(event=>event.taskVerified===true||event.message?.taskVerified===true),false);
      if(mode==='valid'){
        assert.match(task?.result,/Task unverified/);assert.match(task?.result,/unavailable for java/);assert.equal(commands,1);
        const [receipt]=await f.store.list(skillEvidenceKind);assert.equal(receipt.receipt.check,'file-backup');
        assert.deepEqual(receipt.receipt.binding.requiredChecks,['file-backup']);assert.deepEqual(receipt.receipt.binding.unavailableChecks,['command-exit-status']);
      }else{
        assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
        assert.match(task?.error,mode==='failed-command'?/observed command failed/:/file-backup/);
      }
    }finally{await f.close();}
  }
});

test('unavailable-only replies still recheck review, grants and the actual session at completion',async()=>{
  for(const boundary of ['review','grant','epoch','private','stop'] as const){
    const f=await fixture({coding:true});try{
      const task=await f.run([async()=>{
        if(boundary==='review'){const skill=builtInSkill('coding-workbench')!;await f.store.put(skillRecordKinds.review,{id:skill.manifest.id,skillId:skill.manifest.id,version:skill.manifest.version,manifestSha256:skillManifestSha256(skill.manifest),sourceSha256:skill.manifest.sourceSha256,reviewedAt:Date.now(),revoked:true});}
        if(boundary==='grant')f.host.access.revoke('task-1');
        if(boundary==='epoch')f.source().privacyEpoch='new-epoch';
        if(boundary==='private')f.source().privateSession=true;
        if(boundary==='stop')await f.ai.stop();
        return done('An unverified Ruby draft.');
      }],'Fix the Ruby project and run tests');
      assert.notEqual(task?.status,'completed',boundary);assert.equal(task?.taskVerified,false);
      assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
    }finally{await f.close();}
  }
});

test('direct text write resumes reuse original readback receipts and never replay a completed write',async()=>{
  const f=await fixture({coding:true});try{
    const args={path:'list.txt',content:'Milk.'};let original='';
    const paused=await f.run([call('write_file',args,'original-write'),async()=>{
      original=await readFile(path.join(f.workspace,args.path),'utf8');await writeFile(path.join(f.workspace,args.path),'External mismatch.');return done('Saved draft.');
    }],'Save this to a file named list.txt');
    assert.equal(paused?.status,'paused');const receipt=paused?.checkpoint.fileWrites.receipts[0];assert.ok(receipt.id);
    await writeFile(path.join(f.workspace,args.path),original);let writes=0,turns=0;const tool=f.ai.tool.bind(f.ai);
    f.ai.tool=async(name,...values)=>{if(name==='write_file')writes++;return tool(name,...values);};
    f.ai.call=async()=>++turns===1?call('write_file',args,'cached-resume'):done('Saved draft.');
    await f.ai.resume('task-1');await f.ai.jobs.get('task-1');
    const completed=await f.store.get('task','task-1');assert.equal(completed?.status,'completed');assert.equal(completed?.taskVerified,false);
    assert.equal(writes,0);assert.equal((await f.store.list('backup')).length,1);assert.deepEqual((await f.store.list(fileWriteEvidenceKind))[0].receipt,receipt);
    assert.equal((await f.store.list(fileWriteEvidenceKind)).length,1);
  }finally{await f.close();}
});

test('a new code file uses observed absence and byte readback without claiming restorable prior bytes',async()=>{
  for(const code of [0,1]){
    let commands=0;const f=await fixture({coding:true,command:async()=>{commands++;return {code,output:'Fake test receipt.',untrusted:true};}});
    try{
      const task=await f.run([call('write_file',{path:'new.ts',content:'export const value = 1;'},'create-code'),call('run_command',{command:'npm test',target:'selected project'},'test-code'),done('Saved the code and recorded the command.')],
        'Write code for the project and run tests');
      assert.equal(task?.status,code===0?'completed':'paused');assert.equal(task?.taskVerified,code===0);assert.equal(commands,1);
      const [backup]=await f.store.list('backup');assert.equal(backup.before,null);
      const receipt=(await f.store.list(skillEvidenceKind)).find(row=>row.receipt.check==='file-backup')!.receipt;
      assert.equal(receipt.proof.priorState,'absent');assert.equal(receipt.proof.priorSha256,undefined);
      if(code===0){assert.match(task?.result,/restore_file cannot remove/);assert.ok(task?.restoreLimitations.length);}
      else assert.match(task?.error,/command-exit-status/);
    }finally{await f.close();}
  }
});

test('Python, Cargo and Go coding tasks use original host command receipts and real backup read-back',async()=>{
  for(const [toolchain,command] of [['Python','python -m pytest -q'],['Cargo','cargo test --workspace'],['Go','go test ./...']])for(const code of [0,1]){
    let dispatched=0;
    const f=await fixture({coding:true,command:async(_exe,args,cwd,signal)=>{signal.throwIfAborted();dispatched++;assert.equal(args.at(-1),command);assert.equal(cwd,f.workspace);return {code,output:'Untrusted fake toolchain output.',untrusted:true};}});
    try{
      await writeFile(path.join(f.workspace,'code.txt'),'Prior source content.');
      const task=await f.run([call('write_file',{path:'code.txt',content:'Reviewed replacement.'},'write-source'),call('run_command',{command,target:'selected project'},'test-source'),done('Repair draft and command outcome.')],`Fix the ${toolchain} project and run tests`);
      assert.equal(dispatched,1);assert.equal(task?.status,code===0?'completed':'paused');assert.equal(task?.taskVerified,code===0);
      const receipts=await f.store.list(skillEvidenceKind),commandReceipt=receipts.find(row=>row.receipt.check==='command-exit-status')!.receipt;
      assert.equal(commandReceipt.callId,'test-source');assert.deepEqual(commandReceipt.proof,{command,target:'selected project',cwd:f.workspace,code});
      assert.equal(receipts.find(row=>row.receipt.check==='file-backup')!.receipt.callId,'write-source');
      if(code!==0){assert.match(task?.error,/command-exit-status/);assert.ok(task?.checkpoint.finalResponse);assert.equal(f.events.some(event=>event.state==='success'),false);}
    }finally{await f.close();}
  }
});

test('privacy change while a fake image reservation waits prevents provider dispatch',async()=>{
  const f=await fixture({images:true});try{
    f.ai.key=()=> 'fake-key-never-sent';f.ai.router.imageStatus=async()=>({available:true,model:'fake',provider:'openai',reason:'',verification:'configuration'} as any);
    f.ai.reserve=async()=>{f.source().privacyEpoch='changed-before-dispatch';return {id:'fake-reservation',updatedAt:''};};f.ai.settle=async()=>{};
    const task=await f.run([call('generate_image',{prompt:'A neutral test image'}),done()],'Create a picture image');
    assert.notEqual(task?.status,'completed');assert.equal(f.requests.includes('images/generations'),false);assert.equal((await f.store.list('attachment')).length,0);
    assert.equal(f.events.some(event=>event.state==='success'),false);
  }finally{await f.close();}
});

test('an in-flight image survives skill review or settings changes without verified completion or replay',async()=>{
  for(const boundary of ['unchanged','revoked','changed-review','disabled'] as const){
    const f=await fixture({images:true});try{
      f.ai.key=()=> 'fake-key-never-sent';f.ai.router.imageStatus=async()=>({available:true,model:'fake',provider:'openai',reason:'',verification:'configuration'} as any);
      const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7V8AAAAASUVORK5CYII=';
      const task=await f.run([call('generate_image',{prompt:'A neutral test image'}),async()=>{
        assert.equal(f.requests.at(-1),'images/generations','Change authority after the fake provider was dispatched.');
        assert.equal((await f.store.list('attachment')).length,0);
        if(boundary==='disabled'){
          const settings=defaultExtensionSettings();settings.skills.enabled=false;
          await f.store.put(hubRecordKinds.settings,{id:'main',schemaVersion:1,settings});
        }else if(boundary!=='unchanged'){
          const skill=builtInSkill('creative-studio')!;
          await f.store.put(skillRecordKinds.review,{id:skill.manifest.id,skillId:skill.manifest.id,version:skill.manifest.version,
            manifestSha256:boundary==='changed-review'?'0'.repeat(64):skillManifestSha256(skill.manifest),
            sourceSha256:skill.manifest.sourceSha256,reviewedAt:Date.now(),revoked:boundary==='revoked'});
        }
        return {data:[{b64_json:base64}]};
      },done('Created the image.')],'Create a picture image');
      const [attachment]=await f.store.list('attachment');assert.ok(attachment,boundary);assert.equal(attachment.base64,base64);
      assert.equal(f.requests.filter(endpoint=>endpoint==='images/generations').length,1);
      assert.equal((await f.store.list('usage')).find(row=>row.category==='image')?.reserved,false);
      if(boundary==='unchanged'){
        assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,true);
      }else{
        assert.equal(task?.status,'paused',boundary);assert.equal(task?.taskVerified,false);assert.match(task?.error,/skill verification incomplete/i);
        assert.equal(f.events.some(event=>event.state==='success'||event.type==='message'),false);
        assert.equal(f.events.some(event=>event.type==='changed'&&event.kind==='attachment'),true);
        const recorded=task?.checkpoint.executed[0][1];assert.equal(recorded.attachmentId,attachment.id);assert.equal(recorded.uncertain,false);
        const [receipt]=await f.store.list(skillEvidenceKind);assert.equal(receipt.receipt.proof.rowId,attachment.id);
        let dispatches=0;const tool=f.ai.tool.bind(f.ai);f.ai.tool=async(...args)=>{dispatches++;return tool(...args);};
        f.ai.call=async endpoint=>{assert.equal(endpoint,'responses','Resume must not replay the image provider.');return done();};
        await f.ai.resume('task-1');await f.ai.jobs.get('task-1');
        const resumed=await f.store.get('task','task-1');assert.equal(resumed?.status,'paused');assert.equal(resumed?.taskVerified,false);
        assert.equal(dispatches,0);assert.equal((await f.store.list('attachment')).length,1);
        assert.equal(resumed?.checkpoint.executed[0][1].attachmentId,attachment.id);
        assert.equal(resumed?.checkpoint.skillExecution.receipts[0].id,receipt.id);
        assert.equal(f.events.some(event=>event.state==='success'||event.type==='message'),false);
      }
    }finally{await f.close();}
  }
});

test('a boundary during final Store write withdraws the saved completion before any success event',async()=>{
  const f=await fixture();try{
    const put=f.store.put.bind(f.store);f.store.put=async(kind,row)=>{const saved=await put(kind,row);if(kind==='message'&&row.role==='assistant')f.source().privacyEpoch='changed-at-report';return saved;};
    const task=await f.run([call('create_artifact',f.artifact),done()]);
    assert.equal(task?.status,'paused');assert.equal(task?.taskVerified,false);
    assert.equal((await f.store.list('message')).some(row=>row.role==='assistant'),false);
    assert.equal(task?.checkpoint.finalResponse.output[0].content[0].text,'Done.');
    assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
    assert.equal((await f.store.list('artifact')).length,1);
  }finally{await f.close();}
});

test('coding verification consumes real backup/read-back and the injected command exit receipt',async()=>{
  let commands=0;
  const f=await fixture({coding:true,command:async(_exe,args,cwd,signal)=>{signal.throwIfAborted();commands++;assert.equal(args.at(-1),'npm test');assert.equal(cwd,f.workspace);return {code:0,output:'Untrusted test output.',untrusted:true};}});
  try{
    await writeFile(path.join(f.workspace,'code.ts'),'const before = 1;');
    const task=await f.run([call('write_file',{path:'code.ts',content:'const after = 2;'},'write-1'),call('run_command',{command:'npm test',target:'selected project'},'test-1'),done()],'Fix the code and run tests');
    assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,true);assert.equal(commands,1);
    assert.equal((await f.store.list('backup'))[0].before,'const before = 1;');
    const receipts=await f.store.list(skillEvidenceKind);assert.deepEqual(receipts.map(row=>row.receipt.check).sort(),['command-exit-status','file-backup']);
  }finally{await f.close();}
});

test('the copy producer hashes actual source and destination bytes instead of trusting printed hashes',async()=>{
  let copies=0;
  const f=await fixture({coding:true,command:async(_exe,args,cwd,signal)=>{signal.throwIfAborted();copies++;assert.equal(args.at(-1),"Copy-Item -LiteralPath 'source.txt' -Destination 'backup.txt'");await copyFile(path.join(cwd,'source.txt'),path.join(cwd,'backup.txt'));return {code:0,output:'Forged printed SHA256: '+ '0'.repeat(64),untrusted:true};}});
  try{
    await writeFile(path.join(f.workspace,'source.txt'),'Neutral fixture bytes.');
    const task=await f.run([call('run_command',{command:"Copy-Item -LiteralPath 'source.txt' -Destination 'backup.txt'",target:'requested file copy'}),done()],'Back up files and verify the copy');
    assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,true);assert.equal(copies,1);
    assert.equal(await readFile(path.join(f.workspace,'backup.txt'),'utf8'),'Neutral fixture bytes.');
    const proof=(await f.store.list(skillEvidenceKind)).find(row=>row.receipt.check==='file-sha256')!.receipt;
    assert.equal(proof.proof.source,path.join(f.workspace,'source.txt'));assert.equal(proof.proof.destination,path.join(f.workspace,'backup.txt'));assert.notEqual(proof.proof.sha256,'0'.repeat(64));
  }finally{await f.close();}
});

test('ordinary final messages retain collected search sources without promoting appended URLs into citation proof',async()=>{
  for(const mode of ['ordinary','uncited-research','cited-research'] as const){
    const f=await fixture({research:true});try{
      const source={title:'Neutral source',url:'https://example.com/source'},tool=f.ai.tool.bind(f.ai);
      f.ai.tool=async(name,args,signal,privateSession,taskId)=>{
        if(name!=='web_search_local')return tool(name,args,signal,privateSession,taskId);
        signal.throwIfAborted();observeSkillProof(name,'source-citations',{urls:[source.url]});return {results:[source]};
      };
      const answer=mode==='cited-research'?'See [the source](https://example.com/source).':'A neutral answer.';
      const task=await f.run([call('web_search_local',{query:'neutral source'}),done(answer)],mode==='ordinary'?'Tell me something.':'Research neutral sources.');
      if(mode==='uncited-research'){
        assert.equal(task?.status,'paused');assert.match(task?.error,/source-citations/);
        assert.equal((await f.store.list('message')).some(row=>row.role==='assistant'),false);
        assert.equal(task?.checkpoint.finalResponse.output[0].content[0].text,answer);
        assert.equal(f.events.some(event=>event.type==='message'||event.state==='success'),false);
        assert.equal((await f.store.list(skillEvidenceKind)).length,1);
      }else{
        assert.equal(task?.status,'completed');assert.equal(task?.taskVerified,mode==='cited-research');
        const message=(await f.store.list('message')).find(row=>row.role==='assistant');
        assert.deepEqual(message?.citations,[source]);
        assert.deepEqual(f.events.find(event=>event.type==='message')?.message.citations,[source]);
      }
    }finally{await f.close();}
  }
});

test('optional pre-command witnesses never block authorized commands or invent uncertain pre-dispatch effects',async()=>{
  for(const invalidWitness of ['oversized','hardlink','directory','destination-outside-root'] as const){
    let commands=0;
    const f=await fixture({coding:true,command:async(_exe,_args,_cwd,signal)=>{signal.throwIfAborted();commands++;return {code:0,output:'Fake authorized command receipt; no copy proof.',untrusted:true};}});
    try{
      const source=path.join(f.workspace,'source.txt');
      if(invalidWitness==='directory')await mkdir(source);
      else{
        await writeFile(source,'Neutral bytes.');
        if(invalidWitness==='oversized')await truncate(source,64*1024*1024+1);
        if(invalidWitness==='hardlink')await link(source,path.join(f.workspace,'linked.txt'));
      }
      const destination=invalidWitness==='destination-outside-root'?'../unapproved-copy.txt':'backup.txt';
      const task=await f.run([call('run_command',{command:`Copy-Item -LiteralPath 'source.txt' -Destination '${destination}'`,target:'requested file copy'}),done()],'Back up files and verify the copy');
      assert.equal(commands,1,invalidWitness);assert.equal(task?.status,'paused');assert.equal(task?.taskVerified,false);
      assert.match(task?.error,/file-sha256/);assert.equal(task?.evidence.sideEffectsUncertain,false);
      const result=task?.checkpoint.executed[0][1];assert.equal(result.code,0);assert.equal(result.uncertain,false);
      const receipts=await f.store.list(skillEvidenceKind);assert.deepEqual(receipts.map(row=>row.receipt.check),['command-exit-status']);
    }finally{await f.close();}
  }
});
