import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {EventEmitter,once} from 'node:events';
import {createHash} from 'node:crypto';
import {PassThrough,Writable} from 'node:stream';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {Options} from '@anthropic-ai/claude-agent-sdk';
import {Store} from '../src/server/store';
import {AgentLeasePool,AgentLeaseJournal,agentLeaseDigest,AgentStopUnconfirmed,type AgentLeaseRecord} from '../src/extensions/agent-lease';
import {inspectSupervisedRun} from '../src/extensions/supervisor';
import {RuntimeAgents,CodexRuntimeConnection,codexExecutableConfiguration,officialCodexLoginUrl,AgentNeedsSupervision,createNativeRuntimeAgentFactory,createCodexDriver,createClaudeDriver,validateAgentWorkspace,agentEnvironment,agentJournalKind,agentResultKind,
  type AgentAuthority,type AgentDriver,type AgentDriverContext,type AgentSpawn,type ClaudeSdkDriver} from '../src/extensions/agents';
import {ActionReceiptSchema,defaultExtensionSettings,type ExtensionActionContext,type ExtensionAction} from '../src/extensions/contracts';

const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,5));
async function within(predicate:()=>unknown|Promise<unknown>,ms=15000){const end=Date.now()+ms;while(!await predicate()){if(Date.now()>end)throw Error('Owned neutral fixture deadline exceeded');await pause();}}
async function until(predicate:()=>unknown|Promise<unknown>){const end=Date.now()+3000;while(!await predicate()){if(Date.now()>end)throw Error('Condition not observed; the job may not have started. Inspect its start receipt and journal.');await pause();}}
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {resolve,promise};}
// This neutral test driver owns no OS process. Production must supply actual
// native stop and exact-token tree proof, never infer this from a ready flag.
const fakeLifecycle={stop:async()=>{},inspectStopped:async()=>true};
function fixture(driver?:AgentDriver){
  // Windows TEMP may use an 8.3 parent alias; valid fixtures must use its actual canonical path.
  const directory=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capri-runtime-agents-'));
  const root=path.join(directory,'project'),configDir=path.join(directory,'provider');fs.mkdirSync(root);fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(root,'sample.txt'),'fixture');
  const settings=defaultExtensionSettings();settings.agents.codexEnabled=true;settings.agents.claudeApiEnabled=true;
  const grant={taskId:'task-1',request:'Inspect the project',mode:'scoped' as const,createdAt:100,revoked:false,expiresAt:100000,providers:['codex','claude-api'] as const,workspaceIds:['workspace-1'],allowPaid:true};
  const authority:AgentAuthority={settings,localOnly:false,privateSession:false,grant:{...grant,providers:[...grant.providers]},parentGrant:{...grant},
    workspace:{id:'workspace-1',root,writable:true,excludedRoots:[path.join(directory,'excluded')]},
    configuration:{provider:'codex',executable:process.execPath,configDir,isolated:true,model:'configured-codex-model'}};
  const rows=new Map<string,any>(),events:any[]=[],approvalRequests:any[]=[];const leases=new AgentLeasePool();
  const store={get:async(kind:string,id:string)=>structuredClone(rows.get(kind+':'+id)),list:async(kind:string)=>[...rows.entries()].filter(([key])=>key.startsWith(kind+':')).map(([,value])=>structuredClone(value)),
    put:async(kind:string,value:any)=>{rows.set(kind+':'+value.id,structuredClone(value));return value;},remove:async(kind:string,id:string)=>{rows.delete(kind+':'+id);}};
  const deps={store,clock:()=>1000,host:{run:async()=>{throw Error('Unexpected host call');}},transport:{request:async()=>{throw Error('Unexpected transport call');}},
    resolveAuthority:async()=>authority,leases,drivers:driver?{codex:{...driver,ownedLifecycle:driver.ownedLifecycle??fakeLifecycle},'claude-api':{...driver,ownedLifecycle:driver.ownedLifecycle??fakeLifecycle}}:{} as Partial<Record<'codex'|'claude-api',AgentDriver>>,
    approveTool:async(request:any)=>{approvalRequests.push(request);return true;},onActivity:(job:any)=>events.push(job),timeoutMs:1000};
  const module=new RuntimeAgents(deps),controller=new AbortController();
  const context:ExtensionActionContext={signal:controller.signal,authority:'task',taskId:'task-1',privateSession:false,localOnly:false};
  const request:ExtensionAction={requestId:'request-1',taskId:'task-1',input:{provider:'codex',workspaceId:'workspace-1',prompt:'Inspect sample.txt'}};
  const row=()=>{const record=rows.get(agentJournalKind+':request-1');assert.ok(record,'Agent did not start: no dispatch journal exists; inspect the start receipt.');return record;};
  return {module,deps,authority,context,request,root,configDir,rows,events,controller,leases,approvalRequests,row,directory,
    async cleanup(){await module.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
function driverContext(f:ReturnType<typeof fixture>,patch:Partial<AgentDriverContext>={}):AgentDriverContext {
  return {configuration:f.authority.configuration!,workspace:f.authority.workspace!,prompt:'Fixture prompt',signal:f.context.signal,
    beforeDispatch:async()=>{},approve:async()=>true,event:()=>{},...patch};
}
/** Entire subprocess transport is simulated. Never executes Codex or a model turn. */
function fakeCodex(handler:(message:any,reply:(message:any)=>void,child:any)=>void){
  const messages:any[]=[],calls:any[]=[];let child:any;
  const spawn:AgentSpawn=(command,args,options)=>{
    calls.push({command,args,options});child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.pid=undefined;child.exitCode=null;child.signalCode=null;
    child.stdin=new Writable({write(chunk,_encoding,callback){try{const message=JSON.parse(String(chunk));messages.push(message);handler(message,reply,child);callback();}catch(error){callback(error as Error);}}});
    const reply=(message:any)=>child.stdout.write(JSON.stringify(message)+'\n');
    return child as ChildProcessWithoutNullStreams;
  };
  return {spawn,messages,calls,get child(){return child;}};
}
function handshake(message:any,reply:(message:any)=>void){
  if(message.method==='initialize')reply({id:message.id,result:{userAgent:'fake'}});
  else if(message.method==='account/read')reply({id:message.id,result:{account:{type:'chatgpt'}}});
  else if(message.method==='thread/start')reply({id:message.id,result:{thread:{id:'thread-1'}}});
}

/** Entire login/account/catalog transport is fake; no CLI/account/network calls. */
function connectionFixture(options:{authenticated?:boolean;url?:string;timeoutMs?:number;catalog?:(message:any)=>unknown}={}){
  const f=fixture();let configuration=f.authority.configuration as Extract<NonNullable<AgentAuthority['configuration']>,{provider:'codex'}>;
  let authenticated=options.authenticated??false,replyServer:((message:any)=>void)|undefined,stops=0;
  const opened:string[]=[],saved:typeof configuration[]=[];
  const fake=fakeCodex((message,reply)=>{
    replyServer=reply;
    if(message.method==='initialize')reply({id:message.id,result:{userAgent:'fake'}});
    else if(message.method==='account/login/start')reply({id:message.id,result:{type:'chatgpt',loginId:'login-1',authUrl:options.url??'https://auth.openai.com/oauth/authorize?state=ephemeral-fixture'}});
    else if(message.method==='account/read')reply({id:message.id,result:{requiresOpenaiAuth:true,account:authenticated?{type:'chatgpt',email:'private-fixture@example.invalid',planType:'plus',workspaceName:'Private fixture'}:null}});
    else if(message.method==='model/list')reply({id:message.id,result:options.catalog?.(message)??{data:[{id:'picker-1',model:'catalog-model',displayName:'Private fixture label',hidden:false}],nextCursor:null}});
  });
  const leases=new AgentLeasePool(path.join(f.directory,'connection-leases'));
  const driver={...createCodexDriver(fake.spawn,async()=>{stops++;fake.child.emit('close');}),ownedLifecycle:fakeLifecycle};
  const optionsForConnection={configuration:()=>configuration,save:async(next:typeof configuration)=>{saved.push(structuredClone(next));configuration=next;},
    workspace:f.authority.workspace!,open:async(url:string)=>{opened.push(url);},timeoutMs:options.timeoutMs??1000};
  const connection=new CodexRuntimeConnection(optionsForConnection,driver,leases),controller=new AbortController();
  const complete=(patch:Record<string,unknown>={})=>{authenticated=true;replyServer!({method:'account/login/completed',params:{loginId:'login-1',success:true,error:null,...patch}});};
  const notify=(message:any)=>replyServer!(message);
  const idle=()=>until(()=>!connection.snapshot().sessionId);
  return {...f,connection,driver,optionsForConnection,leases,fake,opened,saved,complete,notify,idle,get stops(){return stops;},get configuration(){return configuration;},signal:controller.signal,
    async cleanup(){await connection.close();await f.cleanup();}};
}

test('fresh isolated Codex inspection reports needs-sign-in without login or inference',async()=>{
  const f=connectionFixture();try{
    assert.equal(f.connection.snapshot().state,'needs-sign-in');assert.equal(f.connection.ready(),false);assert.equal(f.fake.calls.length,0);
    f.connection.start('inspect',f.signal);await f.idle();
    assert.equal(f.connection.snapshot().state,'needs-sign-in');assert.equal(f.stops,1);
    assert.deepEqual(f.fake.messages.filter(m=>m.method).map(m=>m.method),['initialize','initialized','account/read']);
    assert.deepEqual(f.fake.messages.find(m=>m.method==='account/read').params,{refreshToken:false});
    assert.equal(f.fake.calls[0].options.env.CODEX_HOME,f.configDir);assert.equal(f.fake.calls[0].options.env.USERPROFILE,f.configDir);
    for(const restriction of ['mcp_servers={}','notify=[]','features.hooks=false','web_search="disabled"','forced_login_method="chatgpt"','cli_auth_credentials_store="file"'])assert.ok(f.fake.calls[0].args.includes(restriction));
    assert.equal(f.rows.size,0);assert.equal(f.opened.length,0);
  }finally{await f.cleanup();}
});

test('executable replacement preserves runtime home and model without inheriting any developer model',async()=>{
  const f=connectionFixture();try{
    const before=structuredClone(f.configuration),replacement=codexExecutableConfiguration(process.execPath,path.join(f.directory,'unused-new-home'),before);
    assert.equal(replacement.model,before.model);assert.equal(replacement.configDir,before.configDir);assert.deepEqual(f.configuration,before);
    const fresh=codexExecutableConfiguration(process.execPath,path.join(f.directory,'fresh-home'));assert.equal(fresh.model,undefined);
    await f.connection.configure(async()=>{await f.optionsForConnection.save(replacement);});assert.equal(f.configuration.model,before.model);assert.equal(f.configuration.configDir,before.configDir);
    assert.equal(f.fake.calls.length,0,'configuration never launches a model or account request');
  }finally{await f.cleanup();}
});

test('runtime cannot dispatch with an undefined model or treat setup as an inference probe',async()=>{
  const f=fixture();let spawns=0;try{
    if(f.authority.configuration?.provider!=='codex')throw Error('Wrong fixture provider');delete f.authority.configuration.model;
    const driver=createCodexDriver(()=>{spawns++;throw Error('Undefined model must not spawn');});
    await assert.rejects(driver.run(driverContext(f)),/explicit runtime model/);assert.equal(spawns,0);
  }finally{await f.cleanup();}
});

test('lost connection evidence gates new jobs but never replaces an original receipt or replays its result',async()=>{
  let starts=0,connected=true;const f=fixture({async run(ctx){starts++;await ctx.beforeDispatch();return {state:'completed'};}});
  const module=new RuntimeAgents({...f.deps,canStart:()=>connected});try{
    const initial=await module.action('start',f.request,f.context);await until(()=>f.row().job.state==='completed');connected=false;
    const repeated=await module.action('start',f.request,f.context);assert.equal(repeated.id,initial.id);assert.equal(repeated.outcome,'completed');assert.ok(await module.readResult(initial.jobId!,f.context));
    const fresh=await module.action('start',{...f.request,requestId:'new-needs-connection'},f.context);assert.equal(fresh.error?.code,'unavailable');assert.equal(starts,1);assert.equal(f.rows.has(agentJournalKind+':new-needs-connection'),false);
  }finally{await module.close();await f.cleanup();}
});

test('Stop fences a pending executable dialog before it can save configuration',async()=>{
  const f=connectionFixture(),entered=deferred(),dialog=deferred();let saved=false;
  try{
    const configuring=f.connection.configure(async signal=>{entered.resolve();await dialog.promise;signal.throwIfAborted();saved=true;});
    const outcome=assert.rejects(configuring);await entered.promise;await f.connection.close();dialog.resolve();await outcome;assert.equal(saved,false);assert.equal(f.leases.peek('codex').state,'available');
  }finally{dialog.resolve();await f.cleanup();}
});

test('managed user-completed login matches its ID, reads account and bounded catalog, then preserves explicit runtime model',async()=>{
  const f=connectionFixture();try{
    const session=f.connection.start('connect',f.signal);await until(()=>f.opened.length===1);
    assert.equal(f.connection.snapshot().sessionId,session);assert.equal(f.connection.ready(),false);
    assert.deepEqual(f.fake.messages.find(m=>m.method==='account/login/start').params,{type:'chatgpt'});
    f.complete({loginId:'foreign-login'});await pause();assert.equal(f.fake.messages.some(m=>m.method==='account/read'),false);
    f.complete();await f.idle();assert.equal(f.connection.snapshot().authenticated,true);assert.equal(f.connection.snapshot().inferenceVerified,false);
    assert.equal(f.connection.snapshot().model,'configured-codex-model');assert.equal(f.connection.ready(),false,'never silently substitute the catalog default');
    await f.connection.selectModel('catalog-model');assert.equal(f.configuration.model,'catalog-model');assert.equal(f.connection.ready(),true);
    assert.equal(f.saved.length,1);assert.equal(f.configuration.configDir,f.configDir);
    const development=f.leases.acquire('codex','development:neutral');assert.equal(f.connection.snapshot().state,'busy');assert.equal(f.connection.ready(),true,'the live runtime lease must not revoke its own authentication evidence');development.release();
    f.complete();await pause();assert.equal(f.fake.messages.filter(m=>m.method==='account/read').length,1,'late duplicate never repeats read/login/inference');
    const exposed=JSON.stringify({connection:f.connection.snapshot(),saved:f.saved,rows:[...f.rows],events:f.events});
    for(const privateText of ['ephemeral-fixture','private-fixture@example.invalid','Private fixture','authUrl','accessToken','login-1'])assert.equal(exposed.includes(privateText),false);
    assert.equal(f.fake.messages.some(m=>/^(thread|turn)\//.test(m.method??'')),false);
  }finally{await f.cleanup();}
});

test('duplicate early completion, failed completion and account disagreement cannot establish authentication',async()=>{
  for(const scenario of ['duplicate','failed','account-missing'] as const){
    const f=connectionFixture();try{
      f.connection.start('connect',f.signal);await until(()=>f.opened.length===1);
      if(scenario==='duplicate'){f.complete();f.complete();}
      else if(scenario==='failed')f.complete({success:false,error:'Private provider detail'});
      else f.notify({method:'account/login/completed',params:{loginId:'login-1',success:true,error:null}});
      await f.idle();assert.equal(f.connection.snapshot().authenticated,false);assert.equal(f.connection.ready(),false);assert.equal(f.saved.length,0);
      assert.equal(JSON.stringify(f.connection.snapshot()).includes('Private provider detail'),false);
    }finally{await f.cleanup();}
  }
});

test('cancel requires exact setup session and sends only its matching login ID; late success cannot revive it',async()=>{
  const f=connectionFixture();try{
    const session=f.connection.start('connect',f.signal);await until(()=>f.opened.length===1);
    await assert.rejects(f.connection.cancel('other-session'));assert.equal(f.connection.snapshot().sessionId,session);
    await f.connection.cancel(session);f.complete();await pause();
    assert.equal(f.connection.snapshot().state,'cancelled');assert.equal(f.connection.ready(),false);
    assert.deepEqual(f.fake.messages.find(m=>m.method==='account/login/cancel').params,{loginId:'login-1'});
    assert.equal(f.fake.messages.some(m=>m.method==='account/read'),false);assert.equal(f.leases.peek('codex').state,'available');
  }finally{await f.cleanup();}
});

test('bounded setup expiry cancels login and keeps authentication unavailable',async()=>{
  const f=connectionFixture({timeoutMs:30});try{
    f.connection.start('connect',f.signal);await f.idle();assert.equal(f.connection.snapshot().state,'expired');
    f.complete();await pause();assert.equal(f.connection.snapshot().authenticated,false);assert.equal(f.leases.peek('codex').state,'available');
  }finally{await f.cleanup();}
});

test('official login URL allowlist rejects hostile/malformed URLs before opening any browser',async()=>{
  const syntheticUserInfo=new URL('https://auth.openai.com/');
  syntheticUserInfo.username='fixture-user';syntheticUserInfo.password='fixture-password';
  for(const url of ['http://auth.openai.com/oauth/authorize','https://auth.openai.com.evil.invalid/','https://auth.openai.com@evil.invalid/',syntheticUserInfo.href,'https://auth.openai.com:8443/','https://auth.openai.com./','https://127.0.0.1/','file:///fixture','javascript:fixture','https://auth.openai.com/\n','https://auth.openai.com/\\evil','https://chatgpt.com/#code=fixture','invalid']){
    assert.throws(()=>officialCodexLoginUrl(url));const f=connectionFixture({url});try{
      f.connection.start('connect',f.signal);await f.idle();assert.equal(f.opened.length,0,url);assert.equal(f.connection.snapshot().authenticated,false);assert.equal(f.fake.messages.some(m=>m.method==='account/read'),false);
    }finally{await f.cleanup();}
  }
});

test('active development lease and setup exclude configuration changes and runtime starts across pools',async()=>{
  const f=connectionFixture(),other=new AgentLeasePool(f.leases.directory);try{
    const development=other.acquire('codex','development:neutral');assert.equal(f.connection.snapshot().state,'busy');
    assert.throws(()=>f.connection.start('connect',f.signal));await assert.rejects(f.connection.configure(async()=>{}));assert.equal(f.fake.calls.length,0);development.release();
    const session=f.connection.start('connect',f.signal);await until(()=>f.opened.length===1);
    await assert.rejects(f.connection.configure(async()=>{}));assert.throws(()=>other.acquire('codex','runtime:other'));
    await f.connection.cancel(session);const next=other.acquire('codex','development:after');next.release();
  }finally{await f.cleanup();}
});

test('root Stop closes owned setup, releases only confirmed ownership and never starts inference',async()=>{
  const f=connectionFixture();try{
    f.connection.start('connect',f.signal);await until(()=>f.opened.length===1);await f.connection.close();
    assert.equal(f.connection.snapshot().state,'unavailable');assert.equal(f.leases.peek('codex').state,'available');assert.equal(f.stops,1);
    f.complete();assert.equal(f.connection.snapshot().authenticated,false);assert.equal(f.fake.messages.some(m=>/^(thread|turn)\//.test(m.method??'')),false);
  }finally{await f.cleanup();}
});

test('setup timeout stops exact ownership even while the browser opener is pending',async()=>{
  const f=connectionFixture(),opened=deferred(),browser=deferred();let stopped=0;
  const connection=new CodexRuntimeConnection({...f.optionsForConnection,timeoutMs:30,open:async()=>{opened.resolve();await browser.promise;}},
    {...f.driver,ownedLifecycle:{stop:async()=>{stopped++;},inspectStopped:async()=>true}},f.leases);
  try{
    connection.start('connect',f.signal);await opened.promise;await until(()=>!connection.snapshot().sessionId);
    assert.equal(connection.snapshot().state,'expired');assert.equal(stopped,1);assert.equal(f.leases.peek('codex').state,'available');
    browser.resolve();await pause();assert.equal(f.fake.messages.some(m=>m.method==='account/read'),false);
  }finally{browser.resolve();await connection.close();await f.cleanup();}
});

test('uncertain setup Stop retains shared provider ownership and never advertises authenticated',async()=>{
  const f=connectionFixture({authenticated:true});const connection=new CodexRuntimeConnection(f.optionsForConnection,{...f.driver,ownedLifecycle:{stop:async()=>{},inspectStopped:async()=>false}},f.leases);
  try{connection.start('inspect',f.signal);await until(()=>!connection.snapshot().sessionId);assert.equal(connection.snapshot().authenticated,false);assert.notEqual(f.leases.peek('codex').state,'available');}
  finally{await connection.close();await f.cleanup();}
});

test('catalog is bounded, rejects cursor loops and never accepts a model from outside inspected results',async()=>{
  const f=connectionFixture({authenticated:true,catalog:()=>({data:[{model:'catalog-model',hidden:false}],nextCursor:'same-cursor'})});try{
    f.connection.start('inspect',f.signal);await f.idle();assert.equal(f.connection.snapshot().authenticated,false);
    assert.equal(f.fake.messages.filter(m=>m.method==='model/list').length,2);await assert.rejects(f.connection.selectModel('unlisted-model'));assert.equal(f.saved.length,0);
  }finally{await f.cleanup();}
});

test('catalog pagination uses returned IDs and does not persist provider labels or account secrets',async()=>{
  const f=connectionFixture({authenticated:true,catalog:m=>({data:[{model:m.params.cursor?'model-two':'model-one',hidden:false,displayName:'Untrusted private display text'}],nextCursor:m.params.cursor?null:'page-two'})});try{
    f.connection.start('inspect',f.signal);await f.idle();assert.deepEqual(f.connection.snapshot().models,['model-one','model-two']);
    await f.connection.selectModel('model-two');assert.equal(f.configuration.model,'model-two');assert.equal(f.configuration.configDir,f.configDir);
    assert.equal(f.opened.length,0);assert.equal(f.connection.snapshot().inferenceVerified,false);assert.equal(JSON.stringify(f.connection.snapshot()).includes('Untrusted private display text'),false);
  }finally{await f.cleanup();}
});

test('setup rejects server requests rather than supplying tools, tokens or authentication callbacks',async()=>{
  const f=connectionFixture();try{
    f.connection.start('connect',f.signal);await until(()=>f.opened.length===1);
    f.notify({id:'hostile-request',method:'account/chatgptAuthTokens/refresh',params:{reason:'fixture'}});
    await until(()=>f.fake.messages.some(m=>m.id==='hostile-request'));
    assert.deepEqual(f.fake.messages.find(m=>m.id==='hostile-request').error,{code:-32601,message:'Request denied by application'});
    assert.equal(f.saved.length,0);await f.connection.close();
  }finally{await f.cleanup();}
});

test('configured probes and injected drivers without owned lifecycle cannot dispatch or journal',async()=>{
  let runs=0;
  const f=fixture();
  const providers=['codex','claude-api'] as const;
  const leaseDirectory=path.join(f.directory,'must-not-create');
  const module=new RuntimeAgents({...f.deps,leases:new AgentLeasePool(leaseDirectory),providerStatus:async()=>providers.map(provider=>({provider,enabled:true,configured:true,ready:true}))});
  try{
    for(const provider of providers){
      f.authority.configuration=provider==='codex'?{provider,executable:process.execPath,model:'configured',configDir:f.configDir,isolated:true}:
        {provider,apiKey:'fake-api-key',budgetUsd:1,model:'configured',configDir:f.configDir,isolated:true};
      for(const driver of [undefined,{async run(){runs++;return {state:'completed' as const};}},provider==='codex'?createCodexDriver():createClaudeDriver()]){
        f.deps.drivers[provider]=driver;
        const receipt=await module.action('start',{...f.request,input:{...f.request.input,provider}},f.context);
        assert.equal(receipt.outcome,'rejected');assert.equal(receipt.effect,'none');assert.equal(receipt.error?.code,'unavailable');
        assert.match(receipt.error!.message,/supervision/);assert.equal(receipt.jobId,undefined);assert.equal(f.rows.size,0);assert.equal(fs.existsSync(leaseDirectory),false);
      }
    }
    const status=await module.status(f.context.signal);
    assert.equal(status.capability.available,false);assert.equal(status.feature,'agents');
    if(status.feature!=='agents')throw Error('Unexpected feature');
    assert.ok(status.agents.every(a=>a.capability.reason==='unavailable'&&a.capability.verification==='none'));
    assert.equal(runs,0);
    await assert.rejects(createCodexDriver().run(driverContext(f)),AgentNeedsSupervision);
    await assert.rejects(createClaudeDriver().run(driverContext(f)),AgentNeedsSupervision);
    assert.equal(f.leases.directory,undefined);f.leases.acquire('codex','fixture-unused').release();
  }finally{await module.close();await f.cleanup();}
});

test('trusted fake lifecycle stops on cancellation and needs exact-token proof before releasing',async()=>{
  const entered=deferred(),ended=deferred();let stopCalls=0,proofCalls=0;let token='';
  const f=fixture({ownedLifecycle:{async stop(record,provider){stopCalls++;assert.equal(provider,'codex');assert.equal(record.token,token);assert.ok(Object.isFrozen(record));ended.resolve();},
    async inspectStopped(record){proofCalls++;assert.equal(record.token,token);return false;}},
    async run(ctx){token=ctx.leaseToken!;await ctx.beforeDispatch();entered.resolve();await ended.promise;return {state:'completed'};}});
  try{
    const receipt=await f.module.action('start',f.request,f.context);assert.equal(receipt.outcome,'pending');await entered.promise;
    f.controller.abort();await f.module.close();
    assert.equal(stopCalls,1);assert.equal(proofCalls,1);assert.equal(f.row().receipt.effect,'unknown');assert.equal(f.row().job.state,'unconfirmed');
    assert.throws(()=>f.leases.acquire('codex','other'));
    assert.equal((await f.module.recover(async record=>record.token===token))[0].state,'recovered');
    f.leases.acquire('codex','after-proof').release();
    assert.equal(f.row().receipt.effect,'unknown');assert.equal(stopCalls,1);
  }finally{await f.cleanup();}
});

test('a completed fake provider still requires stopped-tree proof before any confirmed result',async()=>{
  let stops=0,proofs=0;
  const f=fixture({ownedLifecycle:{async stop(record){stops++;assert.equal(record.token,f.row().leaseToken);},async inspectStopped(){proofs++;return false;}},
    async run(ctx){await ctx.beforeDispatch();return {state:'completed'};}});
  try{
    const receipt=await f.module.action('start',f.request,f.context);assert.equal(receipt.outcome,'pending');
    await until(()=>f.row().job.state==='unconfirmed');await f.module.close();
    assert.equal(stops,1);assert.equal(proofs,1);assert.equal(f.row().receipt.effect,'unknown');
    assert.equal(await f.module.readResult(receipt.jobId!,f.context),undefined);assert.throws(()=>f.leases.acquire('codex','unproven-tree'));
  }finally{await f.cleanup();}
});

test('per-controller memory lease defaults create no disk records and isolate legacy controllers',async()=>{
  const first=new AgentLeasePool(),second=new AgentLeasePool();
  assert.equal(first.directory,undefined);assert.equal(second.directory,undefined);
  const a=first.acquire('codex','development:first'),b=second.acquire('codex','development:second');
  assert.throws(()=>first.acquire('codex','same-controller'));
  a.release();b.release();assert.equal((await first.reconcile('codex')).state,'available');
});

test('leases cap both supervisors at one per provider and require independent stale recovery',async()=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capri-agent-leases-test-'));
  try{
    const development=new AgentLeasePool(dir),runtime=new AgentLeasePool(dir);
    const a=development.acquire('codex','development:task');assert.throws(()=>runtime.acquire('codex','runtime:task'));
    const b=runtime.acquire('claude-api','runtime:task');assert.throws(()=>development.acquire('claude','development:task'));
    assert.equal(await new AgentLeasePool(dir).recover('codex',async()=>false),false);
    a.release();a.release();const c=runtime.acquire('codex','runtime:other');c.release();b.release();
    fs.writeFileSync(path.join(dir,'codex.json'),JSON.stringify({pid:123,token:'old',owner:'old'}));
    assert.equal(await runtime.recover('codex',async record=>record.token==='old'),true);
    runtime.acquire('codex','new').release();
    assert.throws(()=>runtime.acquire('other' as any,'invalid'));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('restart recovery needs specific tree proof and never clears an active or changed owner',async()=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capri-agent-recovery-'));
  try{
    const pool=new AgentLeasePool(dir),lease=pool.acquire('codex','development:session-1');let inspections=0;
    assert.equal((await pool.reconcile('codex',async()=>{inspections++;return true;})).reason,'active');
    assert.equal(inspections,0);
    // A restarted supervisor sees disk ownership. A dead parent alone proves nothing.
    const restarted=new AgentLeasePool(dir);
    assert.equal((await restarted.reconcile('codex')).reason,'inspector-required');
    assert.equal(await restarted.recover('codex',async record=>{assert.equal(record.token,lease.token);return false;}),false);
    assert.throws(()=>restarted.acquire('codex','runtime:other'));
    const waiting=deferred<boolean>(),started=deferred();
    const recovery=restarted.reconcile('codex',async record=>{assert.ok(Object.isFrozen(record));started.resolve();return waiting.promise;});
    await started.promise;
    const replacement={pid:456,owner:'runtime:different-job',token:'replacement'};
    fs.writeFileSync(path.join(dir,'codex.json'),JSON.stringify(replacement));waiting.resolve(true);
    assert.equal((await recovery).reason,'ownership-changed');
    assert.equal(lease.release(),'ownership-changed');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'codex.json'),'utf8')),replacement);
    assert.equal(await restarted.recover('codex',async record=>record.token==='replacement'),true);
    pool.acquire('codex','development:new').release();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('retained unconfirmed leases have a trusted recovery route in memory and on disk',async()=>{
  for(const disk of [false,true]){
    const dir=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capri-agent-retain-'));
    try{
      const pool=new AgentLeasePool(disk?dir:undefined),lease=pool.acquire('claude-api','runtime:job-1');
      lease.retain();assert.equal(lease.release(),'recovery-required');assert.throws(()=>pool.acquire('claude','other'));
      assert.equal((await pool.reconcile('claude-api',async()=>{throw Error('unavailable native supervisor');})).reason,'inspection-failed');
      assert.equal((await pool.reconcile('claude-api',async()=>false)).reason,'tree-unconfirmed');
      assert.equal(await pool.recover('claude-api',async record=>record.token===lease.token&&record.owner==='runtime:job-1'),true);
      const next=pool.acquire('claude','runtime:job-2');
      assert.equal(lease.release(),'recovery-required');assert.throws(()=>pool.acquire('claude','other'));next.release();
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('a removed retained lease needs proof and cannot clear a newly acquired disk owner',async()=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capri-agent-missing-'));
  try{
    const pool=new AgentLeasePool(dir),file=path.join(dir,'codex.json'),lease=pool.acquire('codex','runtime:job');lease.retain();fs.unlinkSync(file);
    assert.equal((await pool.reconcile('codex')).reason,'inspector-required');
    assert.equal((await pool.reconcile('codex',async()=>false)).reason,'tree-unconfirmed');
    const otherPool=new AgentLeasePool(dir),started=deferred(),late=deferred<boolean>();
    const stale=new AgentLeasePool(dir).reconcile('codex',async record=>{assert.equal(record.token,lease.token);started.resolve();return late.promise;});await started.promise;
    assert.throws(()=>otherPool.acquire('codex','development:must-wait'),'Deleting an advisory mirror cannot release the unconfirmed generation');
    assert.equal(await pool.recover('codex',async record=>record.token===lease.token),true);
    const other=otherPool.acquire('codex','development:new-owner');late.resolve(true);assert.equal((await stale).reason,'ownership-changed');
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).owner,'development:new-owner');assert.equal(lease.release(),'recovery-required');assert.equal(otherPool.peek('codex').state,'occupied');assert.throws(()=>pool.acquire('codex','must-not-clear-newer'));other.release();pool.acquire('codex','runtime:next').release();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('missing corrupt unreadable and replaced files do not throw on release or wedge local slots',async()=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capri-agent-release-'));
  try{
    const pool=new AgentLeasePool(dir),file=path.join(dir,'codex.json');
    let lease=pool.acquire('codex','runtime:first');fs.unlinkSync(file);
    assert.equal(lease.release(),'missing');assert.equal(lease.release(),'missing');
    lease=pool.acquire('codex','runtime:corrupt');fs.writeFileSync(file,'{broken');
    assert.equal(lease.release(),'recovery-required');
    assert.throws(()=>{try{throw Error('original run failure');}finally{lease.release();}},/original run failure/);
    let inspections=0;
    assert.equal((await pool.reconcile('codex',async()=>{inspections++;return true;})).reason,'unreadable-record');assert.equal(inspections,0);
    assert.equal(fs.readFileSync(file,'utf8'),'{broken');
    // Simulate a trusted operator repairing a damaged record after independent cleanup.
    fs.unlinkSync(file);lease=pool.acquire('codex','runtime:unreadable');fs.unlinkSync(file);fs.mkdirSync(file);
    assert.equal(lease.release(),'recovery-required');assert.equal((await pool.reconcile('codex')).reason,'unreadable-record');
    fs.rmdirSync(file);lease=pool.acquire('codex','runtime:changed');
    const replacement={token:lease.token,pid:process.pid,owner:'development:other-owner'};
    fs.writeFileSync(file,JSON.stringify(replacement));assert.equal(lease.release(),'ownership-changed');
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),replacement);
    assert.equal(await pool.recover('codex',async()=>true),true);pool.acquire('codex','runtime:after-repair').release();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('runtime restart and unconfirmed-stop recovery reconcile only the matching journal without replay',async()=>{
  let turns=0;
  const f=fixture({async run(ctx){await ctx.beforeDispatch();turns++;if(turns===1)throw new AgentStopUnconfirmed('fake tree still running');return {state:'completed'};}});
  const leaseDir=path.join(f.directory,'leases');f.deps.leases=new AgentLeasePool(leaseDir);
  let restarted:RuntimeAgents|undefined;
  try{
    const first=await f.module.action('start',f.request,f.context);assert.equal(first.outcome,'pending');await until(()=>turns===1);await f.module.close();
    assert.equal(f.row().receipt.effect,'unknown');
    // Simulate a journal interrupted before final persistence, retaining its lease token.
    const row=f.row();row.job.state='running';f.rows.set(agentJournalKind+':request-1',row);
    f.deps.leases=new AgentLeasePool(leaseDir);restarted=new RuntimeAgents(f.deps);
    assert.equal((await restarted.recover())[0].reason,'inspector-required');
    assert.equal(f.row().job.state,'unconfirmed');assert.equal(f.row().receipt.effect,'unknown');
    const next={...f.request,requestId:'request-2'};
    assert.equal((await restarted.action('start',next,f.context)).error?.code,'unavailable');
    assert.equal((await restarted.recover(async()=>false))[0].reason,'tree-unconfirmed');
    const reports=await restarted.recover(async(record,provider)=>{
      assert.equal(provider,'codex');assert.equal(record.token,f.row().leaseToken);assert.equal(record.owner,'runtime:'+first.jobId);return true;
    });
    assert.equal(reports[0].state,'recovered');
    assert.equal((await restarted.action('start',f.request,f.context)).outcome,'unconfirmed');assert.equal(turns,1);
    assert.equal(f.row().receipt.effect,'unknown');
    assert.equal((await restarted.action('start',next,f.context)).outcome,'pending');
    await until(()=>f.rows.get(agentJournalKind+':request-2')?.job.state==='completed');assert.equal(turns,2);
  }finally{await restarted?.close();await f.cleanup();}
});

test('runtime recovery never inspects or clears another job or a changed lease token',async()=>{
  const f=fixture({async run(ctx){await ctx.beforeDispatch();throw new AgentStopUnconfirmed('fixture');}});
  const dir=path.join(f.directory,'leases');f.deps.leases=new AgentLeasePool(dir);
  try{
    await f.module.action('start',f.request,f.context);await until(()=>f.row().job.state==='unconfirmed');await f.module.close();
    const file=path.join(dir,'codex.json'),original=fs.readFileSync(file,'utf8');let inspections=0;
    for(const change of [{owner:'runtime:other-job'},{token:'different-token'}]){
      fs.writeFileSync(file,JSON.stringify({...JSON.parse(original),...change}));
      const restarted=new RuntimeAgents({...f.deps,leases:new AgentLeasePool(dir)});
      assert.equal((await restarted.recover(async()=>{inspections++;return true;}))[0].reason,'tree-unconfirmed');
      assert.equal(inspections,0);assert.notEqual(fs.readFileSync(file,'utf8'),original);await restarted.close();
    }
  }finally{await f.cleanup();}
});

test('Codex performs handshake, account probe, scoped turn, matching completion and fixed streamed activity',async()=>{
  const f=fixture();let dispatches=0;const events:string[]=[];
  const fake=fakeCodex((message,reply)=>{
    handshake(message,reply);
    if(message.method==='turn/start'){
      reply({id:message.id,result:{turn:{id:'turn-1'}}});
      reply({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});
      reply({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',delta:'private <script>provider output</script>'}});
      reply({method:'turn/completed',params:{threadId:'wrong-thread',turn:{id:'turn-1',status:'completed'}}});
      reply({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
    }
  });
  try{
    const result=await createCodexDriver(fake.spawn).run(driverContext(f,{beforeDispatch:async()=>{dispatches++;},event:state=>events.push(state)}));
    assert.equal(result.state,'completed');assert.equal(dispatches,1);assert.deepEqual(events,['running']);
    assert.deepEqual(fake.messages.filter(m=>m.method).map(m=>m.method),['initialize','initialized','account/read','thread/start','turn/start']);
    assert.equal(fake.messages[2].params.refreshToken,false);
    const turn=fake.messages.at(-1).params;assert.equal(turn.model,'configured-codex-model');assert.equal(turn.sandboxPolicy.networkAccess,false);
    assert.deepEqual(turn.sandboxPolicy.readOnlyAccess.readableRoots,[f.root]);assert.deepEqual(turn.sandboxPolicy.writableRoots,[f.root]);
    assert.equal(fake.calls[0].options.env.CODEX_HOME,f.configDir);assert.ok(fake.calls[0].args.includes('features.hooks=false'));
    assert.ok(fake.calls[0].args.some((v:string)=>v.includes('trust_level="untrusted"')));
  }finally{await f.cleanup();}
});

test('Codex approvals bind thread, turn and observed file changes; shell and permission escalation denied',async()=>{
  const f=fixture();const approvalInputs:any[]=[];
  const fake=fakeCodex((message,reply)=>{
    handshake(message,reply);
    if(message.method==='turn/start'){
      reply({id:message.id,result:{turn:{id:'turn-1'}}});reply({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});
      reply({method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'change-1',type:'fileChange',changes:[{path:path.join(f.root,'sample.txt'),diff:'new text',kind:{type:'update'}}]}}});
      for(const [id,method,extra] of [
        [201,'item/fileChange/requestApproval',{itemId:'change-1'}],
        [202,'item/fileChange/requestApproval',{itemId:'missing'}],
        [203,'item/commandExecution/requestApproval',{command:'read outside',approved:true}],
        [204,'item/permissions/requestApproval',{permissions:{network:{enabled:true}}}],
        [205,'item/fileChange/requestApproval',{itemId:'change-1',turnId:'stale'}]
      ] as const)reply({id,method,params:{threadId:'thread-1',turnId:'turn-1',...extra}});
    }
    if(message.id===205&&message.result)reply({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  });
  try{
    await createCodexDriver(fake.spawn).run(driverContext(f,{approve:async(tool,input)=>{approvalInputs.push({tool,input});return true;}}));
    assert.equal(approvalInputs.length,1);assert.equal(approvalInputs[0].tool,'Write');
    await until(()=>fake.messages.some(m=>m.id===201&&m.result));
    assert.equal(fake.messages.find(m=>m.id===201&&m.result).result.decision,'accept');
    assert.equal(fake.messages.find(m=>m.id===202&&m.result).result.decision,'decline');
    assert.equal(fake.messages.find(m=>m.id===203&&m.result).result.decision,'decline');
    assert.deepEqual(fake.messages.find(m=>m.id===204&&m.result).result,{permissions:{},scope:'turn'});
    assert.equal(fake.messages.find(m=>m.id===205&&m.result).result.decision,'decline');
  }finally{await f.cleanup();}
});

test('Codex cancel sends interrupt; stalled handshake and malformed/disconnected transport never complete',async()=>{
  const f=fixture();const controller=new AbortController();
  const fake=fakeCodex((message,reply)=>{
    handshake(message,reply);
    if(message.method==='turn/start')reply({id:message.id,result:{turn:{id:'turn-1'}}});
  });
  try{
    const running=createCodexDriver(fake.spawn).run(driverContext(f,{signal:controller.signal}));
    await until(()=>fake.messages.some(m=>m.method==='turn/start'));await pause();controller.abort();
    assert.equal((await running).state,'unconfirmed');assert.ok(fake.messages.some(m=>m.method==='turn/interrupt'));
    const stalled=fakeCodex(()=>{}),abort=new AbortController();const hanging=createCodexDriver(stalled.spawn).run(driverContext(f,{signal:abort.signal}));
    abort.abort();await assert.rejects(hanging,/stopped/);
    const malformed=fakeCodex((_m,_reply,child)=>child.stdout.write('bad json\n'));
    await assert.rejects(createCodexDriver(malformed.spawn).run(driverContext(f)),/protocol/);
    const disconnected=fakeCodex((message,reply,child)=>{handshake(message,reply);if(message.method==='turn/start')child.emit('close',1);});
    await assert.rejects(createCodexDriver(disconnected.spawn).run(driverContext(f)),/connection lost/);
  }finally{await f.cleanup();}
});

test('Codex declines API-key login for signed-in CLI route and never starts inference',async()=>{
  const f=fixture();let dispatched=false;
  const fake=fakeCodex((message,reply)=>{
    if(message.method==='initialize')reply({id:message.id,result:{}});
    if(message.method==='account/read')reply({id:message.id,result:{account:{type:'apiKey'}}});
  });
  try{await assert.rejects(createCodexDriver(fake.spawn).run(driverContext(f,{beforeDispatch:async()=>{dispatched=true;}})),/sign-in/);assert.equal(dispatched,false);assert.equal(fake.messages.some(m=>m.method==='turn/start'),false);}
  finally{await f.cleanup();}
});

test('runtime persists before dispatch, serializes duplicate requests, and never replays completions',async()=>{
  let f:ReturnType<typeof fixture>;const finish=deferred();let turns=0;
  const driver:AgentDriver={async run(ctx){turns++;assert.equal(f.row().dispatched,false);await ctx.beforeDispatch();assert.equal(f.row().dispatched,true);await finish.promise;return {state:'completed'};}};
  f=fixture(driver);
  try{
    const [first,duplicate]=await Promise.all([f.module.action('start',f.request,f.context),f.module.action('start',f.request,f.context)]);
    ActionReceiptSchema.parse(first);assert.equal(first.outcome,'pending');assert.equal(first.jobId,duplicate.jobId);assert.equal(turns,1);
    const conflicting=await f.module.action('start',{...f.request,input:{...f.request.input,prompt:'another intent'}},f.context);assert.equal(conflicting.error?.code,'conflict');
    finish.resolve();await until(()=>f.row().job.state==='completed');
    assert.equal((await f.module.action('start',f.request,f.context)).outcome,'completed');assert.equal(turns,1);
    const fresh=new RuntimeAgents(f.deps);await fresh.recover();assert.equal((await fresh.action('start',f.request,f.context)).outcome,'completed');await fresh.close();assert.equal(turns,1);
  }finally{finish.resolve();await f.cleanup();}
});

test('live authority denies local-only/private/disabled/paid/revoked/wrong workspace and model-supplied approval',async()=>{
  let calls=0;const f=fixture({async run(){calls++;return {state:'completed'};}});
  try{
    const original=structuredClone(f.authority);
    for(const change of [
      ()=>{f.authority.localOnly=true;},()=>{f.authority.privateSession=true;},
      ()=>{f.authority.settings.agents.codexEnabled=false;},()=>{f.authority.parentGrant!.revoked=true;},
      ()=>{f.authority.grant!.workspaceIds=[];},()=>{f.authority.grant!.expiresAt=999;},
      ()=>{f.authority.configuration=undefined;}
    ]){
      Object.assign(f.authority,structuredClone(original));change();assert.equal((await f.module.action('start',f.request,f.context)).outcome,'rejected');
    }
    Object.assign(f.authority,structuredClone(original));
    assert.equal((await f.module.action('start',{...f.request,input:{...f.request.input,approved:true}},f.context)).error?.code,'invalid-request');
    f.authority.configuration={provider:'claude-api',apiKey:'fake-only',budgetUsd:1,model:'configured-claude-model',configDir:f.configDir,isolated:true};f.authority.grant!.allowPaid=false;
    assert.equal((await f.module.action('start',{...f.request,input:{...f.request.input,provider:'claude-api'}},f.context)).outcome,'rejected');
    assert.equal(calls,0);
  }finally{await f.cleanup();}
});

test('grant revocation during an approval is rechecked and arbitrary summary content never reaches activity',async()=>{
  let allowed:boolean|undefined;const f=fixture({async run(ctx){await ctx.beforeDispatch();allowed=await ctx.approve('Write',{file_path:path.join(ctx.workspace.root,'sample.txt'),approved:true});ctx.event('running');return {state:'completed'};}});
  f.deps.approveTool=async request=>{f.approvalRequests.push(request);f.authority.parentGrant!.revoked=true;return true;};
  try{
    await f.module.action('start',f.request,f.context);await until(()=>f.row().job.state==='unconfirmed');
    assert.equal(allowed,false);assert.equal(f.approvalRequests.length,1);
    assert.ok(f.events.every(event=>!JSON.stringify(event).includes('approved')));
  }finally{await f.cleanup();}
});

test('Stop after dispatch preserves unknown effects, duplicate never restarts, and private prompt is absent from journal',async()=>{
  let turns=0;const f=fixture({async run(ctx){turns++;await ctx.beforeDispatch();await new Promise<void>(resolve=>ctx.signal.addEventListener('abort',()=>resolve(),{once:true}));return {state:'unconfirmed'};}});
  try{
    await f.module.action('start',f.request,f.context);await until(()=>f.row().dispatched);f.controller.abort();await until(()=>f.row().job.state==='unconfirmed');
    const receipt=await f.module.action('start',f.request,{...f.context,signal:new AbortController().signal});ActionReceiptSchema.parse(receipt);
    assert.equal(receipt.outcome,'unconfirmed');assert.equal(receipt.effect,'unknown');assert.equal(turns,1);
    assert.equal(JSON.stringify([...f.rows.values()]).includes('Inspect sample.txt'),false);
  }finally{await f.cleanup();}
});

test('restart converts orphan pending records to unknown, without automatic resubmission',async()=>{
  const f=fixture();let turns=0;
  try{
    const journal={id:'request-1',digest:'a'.repeat(64),dispatched:true,job:{id:'job-1',taskId:'task-1',requestId:'request-1',provider:'codex',workspaceId:'workspace-1',state:'running',createdAt:100,updatedAt:100,summary:'Running'},
      receipt:{id:'receipt-1',requestId:'request-1',feature:'agents',action:'start',observedAt:100,outcome:'pending',effect:'queued',jobId:'job-1'}};
    await f.deps.store.put(agentJournalKind,journal);const unused:AgentDriver={async run(){turns++;return {state:'completed'};}};f.deps.drivers={codex:unused,'claude-api':unused};
    await f.module.recover();assert.equal(f.row().job.state,'unconfirmed');assert.equal(f.row().receipt.effect,'unknown');assert.equal(turns,0);
    const inspected=await f.module.action('inspect',{requestId:'inspect-1',taskId:'task-1',input:{jobId:'job-1'}},f.context);assert.equal(inspected.outcome,'unconfirmed');
    assert.equal((await f.module.action('inspect',{requestId:'inspect-2',taskId:'another',input:{jobId:'job-1'}},{...f.context,taskId:'another'})).outcome,'rejected');
  }finally{await f.cleanup();}
});

test('unconfirmed process shutdown retains its lease and uncertain effects',async()=>{
  const f=fixture({async run(ctx){await ctx.beforeDispatch();throw new AgentStopUnconfirmed('fixture');}});
  try{
    await f.module.action('start',f.request,f.context);await until(()=>f.row().job.state==='unconfirmed');await pause();
    assert.throws(()=>f.leases.acquire('codex','next'));assert.equal(f.row().receipt.effect,'unknown');
  }finally{await f.cleanup();}
});

test('workspace validation rejects excluded roots, secret files, junctions and hardlink aliases',async()=>{
  const f=fixture();const w=f.authority.workspace!;
  try{
    assert.equal(validateAgentWorkspace(w),f.root);
    assert.throws(()=>validateAgentWorkspace({...w,excludedRoots:[f.root]}));
    assert.throws(()=>validateAgentWorkspace({...w,excludedRoots:[path.join(f.root,'nested-secret')]}));
    fs.writeFileSync(path.join(f.root,'.env'),'fake fixture');assert.throws(()=>validateAgentWorkspace(w));fs.unlinkSync(path.join(f.root,'.env'));
    const outside=path.join(f.directory,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(f.root,'alias'),process.platform==='win32'?'junction':'dir');
    assert.throws(()=>validateAgentWorkspace(w));fs.unlinkSync(path.join(f.root,'alias'));
    fs.linkSync(path.join(f.root,'sample.txt'),path.join(outside,'linked.txt'));assert.throws(()=>validateAgentWorkspace(w));
  }finally{await f.cleanup();}
});

test('Claude SDK uses only explicit API key/budget/model, isolated sources, scoped canUseTool and no arbitrary tools',async()=>{
  const f=fixture();let options!:Options;const permissions:any[]=[];let closed=false,loads=0;
  const sdk:ClaudeSdkDriver={query(input){options=input.options;return {
    async *[Symbol.asyncIterator](){
      yield {type:'system',subtype:'init',apiKeySource:'ANTHROPIC_API_KEY',session_id:'sdk-session-1'} as any;
      const ask=options.canUseTool!;
      for(const [tool,value] of [['Write',{file_path:path.join(f.root,'sample.txt')}],['Read',{file_path:path.join(f.directory,'outside.txt'),approved:true}],['Bash',{command:'anything',approved:true}],['Glob',{pattern:'../../*'}]] as const){
        permissions.push(await ask(tool,value,{signal:new AbortController().signal,toolUseID:'tool-1',requestId:'approval-1'}));
      }
      yield {type:'result',subtype:'success',is_error:false,permission_denials:[],session_id:'sdk-session-1',result:'Fake final report'} as any;
    },close(){closed=true;}
  };}};
  try{
    const configuration={provider:'claude-api' as const,apiKey:'fake-api-key-never-live',budgetUsd:2,model:'configured-claude-model',configDir:f.configDir,isolated:true as const};
    const driver=createClaudeDriver(async()=>{loads++;return sdk;});
    await assert.rejects(driver.run(driverContext(f,{configuration:{...configuration,apiKey:''}})),/unconfigured/);assert.equal(loads,0);
    const result=await driver.run(driverContext(f,{configuration}));assert.equal(result.state,'completed');assert.equal(closed,true);
    assert.deepEqual(permissions.map(p=>p.behavior),['allow','deny','deny','deny']);
    assert.deepEqual(options.settingSources,[]);assert.deepEqual(options.mcpServers,{});assert.equal(options.strictMcpConfig,true);
    assert.equal(options.maxBudgetUsd,2);assert.equal(options.model,'configured-claude-model');assert.equal(options.permissionMode,'default');
    assert.equal(options.persistSession,false);assert.deepEqual(options.allowedTools,[]);assert.equal(options.env!.ANTHROPIC_API_KEY,'fake-api-key-never-live');
    assert.equal(options.env!.ANTHROPIC_AUTH_TOKEN,undefined);assert.equal(options.env!.CLAUDE_CODE_OAUTH_TOKEN,undefined);
  }finally{await f.cleanup();}
});

test('packaged Claude constructor launches only its pinned absolute executable with isolated API environment',async()=>{
  const f=fixture();let options!:Options,output='',launches=0,verified=0;
  const executable=path.join(f.directory,process.platform==='win32'?'neutral-sdk.exe':'neutral-sdk');fs.copyFileSync(process.execPath,executable);fs.chmodSync(executable,0o755);
  const sdk:ClaudeSdkDriver={query(input){options=input.options;
    assert.equal(options.pathToClaudeCodeExecutable,executable);
    const child=options.spawnClaudeCodeProcess!({command:executable,args:['-e','process.stdout.write(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,api:!!process.env.ANTHROPIC_API_KEY,oauth:!!process.env.CLAUDE_CODE_OAUTH_TOKEN}));'],
      cwd:f.root,env:options.env??{},signal:options.abortController!.signal});
    child.stdout.on('data',chunk=>{output+=chunk;});const closed=once(child as ChildProcessWithoutNullStreams,'close');
    return {async *[Symbol.asyncIterator](){await closed;
      yield {type:'system',subtype:'init',apiKeySource:'ANTHROPIC_API_KEY',session_id:'neutral-session'} as any;
      yield {type:'result',subtype:'success',is_error:false,permission_denials:[],session_id:'neutral-session',result:'Neutral subprocess finished'} as any;
    },close(){}};
  }};
  const spawnNeutral:AgentSpawn=(command,args,spawnOptions)=>{launches++;assert.equal(command,executable);assert.equal(spawnOptions?.cwd,f.root);return spawn(command,args,spawnOptions) as ChildProcessWithoutNullStreams;};
  const configuration={provider:'claude-api' as const,apiKey:'fake-only-not-a-credential',budgetUsd:1,model:'neutral',configDir:f.configDir,isolated:true as const};
  try{
    const driver=createClaudeDriver(async()=>sdk,spawnNeutral,async()=>{}, {claudeExecutable:executable,verify(kind){assert.equal(kind,'claude-api');verified++;}});
    const result=await driver.run(driverContext(f,{configuration}));
    assert.equal(result.state,'completed');assert.equal(launches,1);assert.ok(verified>=3);
    assert.deepEqual(JSON.parse(output),{cwd:f.root,home:f.configDir,api:true,oauth:false});
    const bad:ClaudeSdkDriver={query(input){input.options.spawnClaudeCodeProcess!({command:'node',args:[],cwd:f.root,env:{},signal:new AbortController().signal});throw Error('Unexpected fallback');}};
    await assert.rejects(createClaudeDriver(async()=>bad,spawnNeutral,async()=>{}, {claudeExecutable:executable,verify(){}}).run(driverContext(f,{configuration})),/differs from packaged/);
    assert.equal(launches,1);
  }finally{await f.cleanup();}
});

test('Claude budget/permission error results stay unconfirmed and never retry',async()=>{
  const f=fixture();let queries=0;
  const configuration={provider:'claude-api' as const,apiKey:'fake-only',budgetUsd:1,model:'configured-model',configDir:f.configDir,isolated:true as const};
  try{
    for(const [subtype,denials,reason] of [['error_max_budget_usd',[],'quota'],['success',[{}],'permission-denied']] as const){
      const sdk:ClaudeSdkDriver={query(){queries++;return {async *[Symbol.asyncIterator](){yield {type:'system',subtype:'init',apiKeySource:'ANTHROPIC_API_KEY',session_id:'sdk-session-1'} as any;yield {type:'result',subtype,is_error:subtype!=='success',permission_denials:denials,session_id:'sdk-session-1',result:'Fake report'} as any;},close(){}};}};
      const result=await createClaudeDriver(async()=>sdk).run(driverContext(f,{configuration}));assert.equal(result.state,'unconfirmed');assert.equal(result.reason,reason);
    }
    assert.equal(queries,2);
  }finally{await f.cleanup();}
});

test('sanitized environment excludes arbitrary authentication and startup settings',()=>{
  const env=agentEnvironment(path.resolve('fake-runtime-home'));
  const allowed=/^(?:path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all|home|userprofile|no_color|enable_claudeai_mcp_servers)$/i;
  assert.ok(Object.keys(env).every(key=>allowed.test(key)));assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.OPENAI_API_KEY,undefined);
});

test('Claude cancellation closes a stalled SDK stream without waiting for another message',async()=>{
  const f=fixture(),controller=new AbortController(),entered=deferred();let closed=false;
  const configuration={provider:'claude-api' as const,apiKey:'fake-only',budgetUsd:1,model:'configured-model',configDir:f.configDir,isolated:true as const};
  const sdk:ClaudeSdkDriver={query(){return {async *[Symbol.asyncIterator](){entered.resolve();await new Promise(()=>{});},close(){closed=true;}};}};
  try{
    const result=createClaudeDriver(async()=>sdk).run(driverContext(f,{configuration,signal:controller.signal}));
    await entered.promise;controller.abort();assert.equal((await result).state,'unconfirmed');assert.equal(closed,true);
  }finally{await f.cleanup();}
});

test('Claude rejects OAuth provenance and mismatched session completion even with success text',async()=>{
  const f=fixture();const configuration={provider:'claude-api' as const,apiKey:'fake-only',budgetUsd:1,model:'configured-model',configDir:f.configDir,isolated:true as const};
  try{
    for(const [apiKeySource,resultSession] of [['oauth','sdk-session-1'],['ANTHROPIC_API_KEY','wrong-session']] as const){
      const sdk:ClaudeSdkDriver={query(){return {async *[Symbol.asyncIterator](){yield {type:'system',subtype:'init',apiKeySource,session_id:'sdk-session-1'} as any;yield {type:'result',subtype:'success',is_error:false,permission_denials:[],session_id:resultSession,result:'Fake report'} as any;},close(){}};}};
      const result=await createClaudeDriver(async()=>sdk).run(driverContext(f,{configuration}));assert.equal(result.state,'unconfirmed');assert.equal(result.reason,'authentication');
    }
  }finally{await f.cleanup();}
});

test('authority revoked between startup and dispatch prevents the turn and records no effect',async()=>{
  const f=fixture({async run(ctx){f.authority.parentGrant!.revoked=true;await ctx.beforeDispatch();throw Error('Unexpected dispatch');}});
  try{
    await f.module.action('start',f.request,f.context);await until(()=>f.row().job.state==='failed');
    assert.equal(f.row().dispatched,false);assert.equal(f.row().receipt.outcome,'rejected');assert.equal(f.row().receipt.effect,'none');
  }finally{await f.cleanup();}
});

test('unverified journal write prevents process startup and releases the unused slot',async()=>{
  let calls=0;const f=fixture({async run(){calls++;return {state:'completed'};}});
  f.deps.store.get=async()=>undefined;
  try{
    assert.equal((await f.module.action('start',f.request,f.context)).outcome,'rejected');assert.equal(calls,0);
    f.leases.acquire('codex','independent-next').release();
  }finally{await f.cleanup();}
});

test('cancelling an already completed job does not claim a cancellation receipt',async()=>{
  const f=fixture({async run(ctx){await ctx.beforeDispatch();return {state:'completed'};}});
  try{
    const queued=await f.module.action('start',f.request,f.context);await until(()=>f.row().job.state==='completed');await pause();
    const receipt=await f.module.action('cancel',{requestId:'cancel-1',taskId:'task-1',input:{jobId:queued.jobId}},f.context);
    ActionReceiptSchema.parse(receipt);assert.equal(receipt.outcome,'rejected');assert.equal(receipt.error?.code,'conflict');
  }finally{await f.cleanup();}
});

test('Codex captures only authoritative final items for the exact response-bound thread and turn',async()=>{
  const f=fixture();
  const fake=fakeCodex((message,reply)=>{
    handshake(message,reply);
    if(message.method==='turn/start'){
      // Deliberately deliver notifications before the start response (no turn/started required).
      for(const [threadId,turnId,id,phase,text] of [
        ['wrong-thread','turn-1','wrong-thread','final_answer','wrong thread'],
        ['thread-1','wrong-turn','wrong-turn','final_answer','wrong turn'],
        ['thread-1','turn-1','commentary','commentary','working'],
        ['thread-1','turn-1','answer','final_answer','Answer <script>untrusted</script>']
      ])reply({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id,phase,text}}});
      reply({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'answer',delta:'not authoritative'}});
      reply({id:message.id,result:{turn:{id:'turn-1'}}});
      reply({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
      reply({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'late',text:'late answer'}}});
    }
  });
  try{
    const result=await createCodexDriver(fake.spawn).run(driverContext(f));
    assert.deepEqual(result.report,{source:{provider:'codex',threadId:'thread-1',turnId:'turn-1',itemIds:['answer']},text:'Answer <script>untrusted</script>',truncated:false});
  }finally{await f.cleanup();}
});

test('Codex malformed final items fail closed and large final text is bounded',async()=>{
  const f=fixture();
  try{
    for(const text of [{malformed:true},'x'.repeat(40000)]){
      const fake=fakeCodex((message,reply)=>{
        handshake(message,reply);
        if(message.method==='turn/start'){
          reply({id:message.id,result:{turn:{id:'turn-1'}}});
          reply({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'answer',phase:'final_answer',text}}});
          reply({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
        }
      });
      const result=await createCodexDriver(fake.spawn).run(driverContext(f));
      if(typeof text==='string'){assert.equal(result.report!.text.length,32768);assert.equal(result.report!.truncated,true);}
      else {assert.equal(result.state,'unconfirmed');assert.equal(result.report,undefined);}
    }
  }finally{await f.cleanup();}
});

test('Claude captures its session-bound final result and rejects malformed or mismatched finals',async()=>{
  const f=fixture();const configuration={provider:'claude-api' as const,apiKey:'fake-only',budgetUsd:1,model:'configured-model',configDir:f.configDir,isolated:true as const};
  try{
    for(const [session,result] of [['session-1','A final answer'],['other-session','wrong answer'],['session-1',{invalid:true}]] as const){
      const sdk:ClaudeSdkDriver={query(){return {async *[Symbol.asyncIterator](){
        yield {type:'system',subtype:'init',apiKeySource:'ANTHROPIC_API_KEY',session_id:'session-1'} as any;
        yield {type:'result',subtype:'success',is_error:false,permission_denials:[],session_id:session,result} as any;
      },close(){}};}};
      const value=await createClaudeDriver(async()=>sdk).run(driverContext(f,{configuration}));
      if(session==='session-1'&&typeof result==='string')assert.deepEqual(value.report,{source:{provider:'claude-api',sessionId:'session-1'},text:result,truncated:false});
      else {assert.equal(value.report,undefined);assert.equal(value.state,'unconfirmed');}
    }
  }finally{await f.cleanup();}
});

const finalReport=()=>({source:{provider:'codex' as const,threadId:'thread-1',turnId:'turn-1',itemIds:['answer']},text:'Answer <script>do not execute</script>',truncated:false});

test('task results preserve escaped reports, observed file hashes, explicit verification limits and restart retrieval without replay',async()=>{
  let turns=0;const f=fixture({async run(ctx){turns++;await ctx.beforeDispatch();
    fs.writeFileSync(path.join(ctx.workspace.root,'sample.txt'),'changed');fs.writeFileSync(path.join(ctx.workspace.root,'new.txt'),'added');
    fs.unlinkSync(path.join(ctx.workspace.root,'removed.txt'));return {state:'completed',report:finalReport()};
  }});
  fs.writeFileSync(path.join(f.root,'removed.txt'),'removed');
  try{
    const started=await f.module.action('start',f.request,f.context);assert.equal(started.outcome,'pending');const jobId=started.jobId!;
    await until(async()=>!!await f.module.readResult(jobId,f.context));
    const result=(await f.module.readResult(jobId,f.context))!;
    assert.equal(result.report!.text,'Answer &lt;script&gt;do not execute&lt;/script&gt;');assert.equal(result.untrusted,true);assert.equal(result.verification,'unverified');
    assert.ok(result.limitations.includes('shell-and-build-unavailable'));assert.ok(result.limitations.includes('task-verification-required'));
    assert.equal(result.changesObserved,true);assert.deepEqual(result.changedFiles.map(c=>[c.path,c.kind]),[['new.txt','added'],['removed.txt','deleted'],['sample.txt','modified']]);
    assert.match(result.changedFiles[2].beforeSha256!,/^[a-f0-9]{64}$/);assert.notEqual(result.changedFiles[2].beforeSha256,result.changedFiles[2].afterSha256);
    assert.ok(f.events.every(event=>!JSON.stringify(event).includes('script')));
    result.report!.text='caller mutation';assert.notEqual((await f.module.readResult(jobId,f.context))!.report!.text,'caller mutation');
    assert.equal((await f.module.action('start',f.request,f.context)).jobId,jobId);
    const restarted=new RuntimeAgents(f.deps);await restarted.recover();assert.deepEqual(await restarted.readResult(jobId,f.context),await f.module.readResult(jobId,f.context));
    await restarted.close();assert.equal(turns,1);
  }finally{await f.cleanup();}
});

test('result access checks task identity, live grants, privacy, local-only restrictions and exact workspace binding',async()=>{
  const f=fixture({async run(ctx){await ctx.beforeDispatch();return {state:'completed',report:finalReport()};}});
  try{
    const started=await f.module.action('start',f.request,f.context);assert.equal(started.outcome,'pending');const jobId=started.jobId!;
    await until(async()=>!!await f.module.readResult(jobId,f.context));
    for(const context of [{...f.context,taskId:'wrong-task'},{...f.context,privateSession:true},{...f.context,localOnly:true},{...f.context,signal:AbortSignal.abort()}])assert.equal(await f.module.readResult(jobId,context),undefined);
    const original=structuredClone(f.authority);
    for(const change of [()=>{f.authority.parentGrant!.revoked=true;},()=>{f.authority.localOnly=true;},()=>{f.authority.privateSession=true;},
      ()=>{f.authority.workspace!.writable=false;},()=>{f.authority.grant!.createdAt=101;f.authority.parentGrant!.createdAt=101;}]){
      Object.assign(f.authority,structuredClone(original));change();assert.equal(await f.module.readResult(jobId,f.context),undefined);
      assert.equal((await f.module.action('inspect',{requestId:'inspect',taskId:'task-1',input:{jobId}},f.context)).outcome,'rejected');
      assert.equal((await f.module.action('start',f.request,f.context)).outcome,'rejected');
    }
    Object.assign(f.authority,original);assert.ok(await f.module.readResult(jobId,f.context));
  }finally{await f.cleanup();}
});

test('result retrieval rejects malformed, mismatched, orphaned and modified records',async()=>{
  const f=fixture({async run(ctx){await ctx.beforeDispatch();return {state:'completed',report:finalReport()};}});
  try{
    const started=await f.module.action('start',f.request,f.context);assert.equal(started.outcome,'pending');const jobId=started.jobId!;
    await until(async()=>!!await f.module.readResult(jobId,f.context));const key=agentResultKind+':'+jobId,original=structuredClone(f.rows.get(key));
    for(const patch of [{jobId:'other-job'},{taskId:'other-task'},{requestId:'other-request'},{provider:'claude-api'},{scopeSha256:'0'.repeat(64)},
      {report:{...original.report,text:'changed'}},{changedFiles:'malformed'},{verification:'verified'}]){
      f.rows.set(key,{...original,...patch});assert.equal(await f.module.readResult(jobId,f.context),undefined);
    }
    f.rows.set(key,original);assert.equal(await f.module.readResult('unknown-job',f.context),undefined);
    const journals=[...f.rows.entries()].filter(([key])=>key.startsWith(agentJournalKind+':'));for(const [key] of journals)f.rows.delete(key);
    const restarted=new RuntimeAgents(f.deps);await restarted.recover();assert.equal(await restarted.readResult(jobId,f.context),undefined);await restarted.close();
  }finally{await f.cleanup();}
});

test('cancelled and newly private jobs discard late final replies and retain unknown effects',async()=>{
  for(const revoke of [false,true]){
    const entered=deferred(),finish=deferred();const f=fixture({async run(ctx){await ctx.beforeDispatch();entered.resolve();await finish.promise;return {state:'completed',report:finalReport()};}});
    try{
      const started=await f.module.action('start',f.request,f.context);assert.equal(started.outcome,'pending');await entered.promise;
      if(revoke)f.authority.privateSession=true;else f.controller.abort();finish.resolve();
      await until(()=>f.row().job.state==='unconfirmed');await pause();
      assert.equal(f.row().receipt.effect,'unknown');assert.equal(await f.module.readResult(started.jobId!,{...f.context,signal:new AbortController().signal}),undefined);
      assert.equal([...f.rows.keys()].some(key=>key.startsWith(agentResultKind+':')),false);
    }finally{finish.resolve();await f.cleanup();}
  }
});

test('malformed or wrong-provider driver reports never create task results',async()=>{
  for(const report of [{...finalReport(),text:123},{...finalReport(),source:{provider:'claude-api',sessionId:'wrong-provider'}}]){
    const f=fixture({async run(ctx){await ctx.beforeDispatch();return {state:'completed',report} as any;}});
    try{
      const started=await f.module.action('start',f.request,f.context);assert.equal(started.outcome,'pending');await until(()=>f.row().job.state==='unconfirmed');await pause();
      assert.equal(await f.module.readResult(started.jobId!,f.context),undefined);assert.equal(f.row().receipt.effect,'unknown');
    }finally{await f.cleanup();}
  }
});

test('result records use the existing encrypted Store and survive a fresh module without inference',async()=>{
  let turns=0;const f=fixture({async run(ctx){turns++;await ctx.beforeDispatch();return {state:'completed',report:finalReport()};}});
  const store=await new Store(path.join(f.directory,'encrypted-store'),Buffer.alloc(32,37)).init();
  Object.assign(f.deps.store,{get:store.get.bind(store),put:store.put.bind(store),list:store.list.bind(store),remove:store.remove.bind(store)});
  try{
    const started=await f.module.action('start',f.request,f.context);assert.equal(started.outcome,'pending');
    await until(async()=>!!await f.module.readResult(started.jobId!,f.context));
    assert.equal(fs.readFileSync(store.file).includes(Buffer.from('do not execute')),false);
    const restarted=new RuntimeAgents(f.deps);await restarted.recover();assert.ok(await restarted.readResult(started.jobId!,f.context));await restarted.close();assert.equal(turns,1);
  }finally{await store.close();await f.cleanup();}
});

test('authority is rechecked after result persistence and after an asynchronous result read',async()=>{
  const f=fixture({async run(ctx){await ctx.beforeDispatch();return {state:'completed',report:finalReport()};}});
  const originalPut=f.deps.store.put,originalGet=f.deps.store.get;
  try{
    f.deps.store.put=async(kind,value)=>{const saved=await originalPut(kind,value);if(kind===agentResultKind)f.authority.privateSession=true;return saved;};
    const started=await f.module.action('start',f.request,f.context);assert.equal(started.outcome,'pending');
    await until(()=>f.row().job.state==='unconfirmed');await pause();
    assert.equal(f.row().receipt.effect,'unknown');assert.equal(f.rows.has(agentResultKind+':'+started.jobId),false);
    assert.equal(f.row().resultSha256,undefined);
    f.authority.privateSession=false;f.deps.store.put=originalPut;
    const next=await f.module.action('start',{...f.request,requestId:'next-request'},f.context);assert.equal(next.outcome,'pending');
    await until(async()=>!!await f.module.readResult(next.jobId!,f.context));
    f.deps.store.get=async(kind,id)=>{const value=await originalGet(kind,id);if(kind===agentResultKind)f.authority.localOnly=true;return value;};
    assert.equal(await f.module.readResult(next.jobId!,f.context),undefined);
  }finally{f.deps.store.get=originalGet;f.deps.store.put=originalPut;await f.cleanup();}
});

test('partial provider report and observed changes remain unverified on a quota outcome',async()=>{
  const f=fixture({async run(ctx){await ctx.beforeDispatch();fs.writeFileSync(path.join(ctx.workspace.root,'sample.txt'),'partial');return {state:'unconfirmed',reason:'quota',report:finalReport()};}});
  try{
    const started=await f.module.action('start',f.request,f.context);assert.equal(started.outcome,'pending');
    await until(async()=>!!await f.module.readResult(started.jobId!,f.context));
    const result=(await f.module.readResult(started.jobId!,f.context))!;
    assert.equal(result.state,'unconfirmed');assert.equal(result.verification,'unverified');assert.equal(result.changedFiles.length,1);
    assert.ok(result.report);assert.equal(f.row().receipt.effect,'unknown');assert.equal(f.row().receipt.error.retry,'read-only-reconcile');
  }finally{await f.cleanup();}
});

function nativeClaim(f:ReturnType<typeof fixture>,jobId:string){return {
  protocol:'capri-native-agent-lease-v1' as const,sessionId:jobId,hostId:'a'.repeat(64),creatorCreated:'123456789',startedAt:new Date().toISOString(),
  controlRoot:path.join(f.directory,'control'),controlToken:'b'.repeat(64),helperPath:path.join(f.directory,'neutral-helper.exe'),helperSha256:'c'.repeat(64),
  workspaceSha256:createHash('sha256').update(f.root.toLowerCase()).digest('hex')
};}

test('native runtime factory without a pinned helper is unavailable without global pool or provider effects',async()=>{
  const f=fixture();const leases=new AgentLeasePool(path.join(f.directory,'isolated-leases'));
  const factory=createNativeRuntimeAgentFactory({controlRoot:path.join(f.directory,'control'),leases,helperPath:path.join(f.directory,'missing.exe'),helperSha256:'0'.repeat(64)});
  const module=new RuntimeAgents({...f.deps,...factory,providerStatus:async()=>[{provider:'codex',enabled:true,configured:true,ready:true}]});
  try{
    assert.equal(factory.configuration().available,false);
    assert.match(factory.configuration().reason!,/native runtime supervision/);
    assert.equal((await module.status(f.context.signal)).capability.available,false);
    assert.equal((await module.action('start',f.request,f.context)).error?.code,'unavailable');
    assert.equal(f.rows.size,0);assert.equal(fs.existsSync(leases.directory!),false);
    assert.equal(fs.existsSync(path.join(f.directory,'control')),false);
  }finally{await module.close();await f.cleanup();}
});

test('a ready provider probe cannot substitute for missing packaged Claude resources',async()=>{
  const f=fixture(),helperPath=path.join(f.directory,'inert-helper.exe');fs.writeFileSync(helperPath,'never executed');
  f.authority.configuration={provider:'claude-api',apiKey:'fake-only',budgetUsd:1,model:'neutral',configDir:f.configDir,isolated:true};
  const leases=new AgentLeasePool(path.join(f.directory,'isolated-leases'));
  const factory=createNativeRuntimeAgentFactory({controlRoot:path.join(f.directory,'control'),leases,helperPath,helperSha256:createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex')});
  const module=new RuntimeAgents({...f.deps,...factory,providerStatus:async()=>[{provider:'claude-api',enabled:true,configured:true,ready:true}]});
  try{
    assert.equal(factory.configuration('claude-api').available,false);
    const status=await module.status(f.context.signal);assert.equal(status.feature,'agents');
    assert.equal(status.feature==='agents'&&status.agents.find(row=>row.provider==='claude-api')?.capability.available,false);
    const receipt=await module.action('start',{...f.request,input:{...f.request.input,provider:'claude-api'}},f.context);
    assert.equal(receipt.error?.code,'unavailable');assert.equal(f.rows.size,0);assert.equal(fs.existsSync(leases.directory!),false);
  }finally{await module.close();await f.cleanup();}
});

for(const relation of ['equal','pool-ancestor','pool-descendant'] as const)test('native runtime rejects '+relation+' lease/workspace overlap before any ownership effects',async()=>{
  const f=fixture(),directory=relation==='equal'?f.root:relation==='pool-ancestor'?f.directory:path.join(f.root,'lease-pool');
  fs.mkdirSync(directory,{recursive:true});
  const helperPath=path.join(f.directory,'neutral-helper.exe');fs.writeFileSync(helperPath,'never executed');
  const leases=new AgentLeasePool(directory),acquire=leases.acquire.bind(leases);let acquires=0,creators=0,spawns=0;
  leases.acquire=(...args)=>{acquires++;return acquire(...args);};
  const factory=createNativeRuntimeAgentFactory({leases,controlRoot:path.join(f.directory,'control'),helperPath,
    helperSha256:createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex'),creatorState:async()=>{creators++;return {state:'alive',created:'123456789'};},
    spawnGuardian(){spawns++;throw Error('Overlapping layout must not launch');}});
  const module=new RuntimeAgents({...f.deps,...factory});
  const tree=(root:string):string[]=>fs.readdirSync(root,{withFileTypes:true}).flatMap(entry=>{const file=path.join(root,entry.name);return [path.relative(f.directory,file),...(entry.isDirectory()?tree(file):[])];}).sort();
  const before=tree(f.directory);
  try{
    // Direct trusted claim tests the actual boundary on every platform, even
    // where the native helper is honestly unavailable. Windows action also
    // reaches this boundary with a pinned inert file; it is never executed.
    await assert.rejects(factory.drivers.codex.ownedLifecycle!.claim!({provider:'codex',jobId:'overlap-job',workspace:f.authority.workspace!,signal:f.context.signal}),/lease pool overlaps/);
    assert.equal((await module.action('start',f.request,f.context)).error?.code,'unavailable');
    assert.equal(acquires,0);assert.equal(creators,0);assert.equal(spawns,0);assert.equal(f.rows.size,0);
    assert.deepEqual(tree(f.directory),before);assert.equal(fs.existsSync(path.join(f.directory,'control')),false);
  }finally{await module.close();await f.cleanup();}
});

test('runtime Stop while native creator lookup is pending cannot claim, register or launch afterward',async()=>{
  const entered=deferred(),lookup=deferred();let claims=0,registers=0,runs=0;
  const f=fixture();const leases=new AgentLeasePool(path.join(f.directory,'isolated-leases'));
  const module=new RuntimeAgents({...f.deps,leases,drivers:{codex:{ownedLifecycle:{...fakeLifecycle,
    async claim(input){entered.resolve();await lookup.promise;claims++;return nativeClaim(f,input.jobId);},register(){registers++;}},
    async run(){runs++;return {state:'completed'};}}}});
  try{
    const start=module.action('start',f.request,f.context);await entered.promise;
    const close=module.close();lookup.resolve();const receipt=await start;await close;
    assert.equal(receipt.outcome,'cancelled');assert.equal(claims,1);assert.equal(registers,0);assert.equal(runs,0);
    assert.equal(fs.existsSync(leases.directory!),false);assert.equal(f.rows.size,0);
  }finally{await module.close();await f.cleanup();}
});

test('native runtime passes complete claims and cannot accept results before durable generation settlement',async()=>{
  let record:AgentLeaseRecord|undefined,runs=0;
  const f=fixture();const leases=new AgentLeasePool(path.join(f.directory,'isolated-leases'));
  const module=new RuntimeAgents({...f.deps,leases,drivers:{codex:{ownedLifecycle:{
    async claim(input){return nativeClaim(f,input.jobId);},register(value){record=value;},
    async stop(value,key){assert.deepEqual(value,record);new AgentLeaseJournal(leases,key,value).settled({state:'not-dispatched',creatorCreated:value.native!.creatorCreated});},
    async inspectStopped(value,key){assert.deepEqual(value,record);return new AgentLeaseJournal(leases,key,value).isSettled();}},
    async run(ctx){runs++;assert.deepEqual(ctx.leaseRecord,record);assert.ok(record?.generation);assert.equal(record?.native?.sessionId,f.row().job.id);
      // Neutral injected driver performs no OS launch. The immutable settlement
      // verifies whole generation release before any result is made readable.
      await ctx.beforeDispatch();return {state:'completed',report:finalReport()};}}}});
  try{
    const receipt=await module.action('start',f.request,f.context);assert.equal(receipt.outcome,'pending');
    await until(async()=>!!await module.readResult(receipt.jobId!,f.context));
    assert.equal(leases.peek('codex').state,'available');assert.equal(f.row().receipt.outcome,'completed');
    assert.deepEqual(f.row().leaseRecord,record);assert.equal(runs,1);
    assert.equal((await module.action('start',f.request,f.context)).jobId,receipt.jobId);assert.equal(runs,1);
  }finally{await module.close();await f.cleanup();}
});

test('native claim Store readback failure stops the unused claim and never launches a transport',async()=>{
  const f=fixture();let runs=0,stops=0;const leases=new AgentLeasePool(path.join(f.directory,'isolated-leases'));
  const module=new RuntimeAgents({...f.deps,leases,store:{...f.deps.store,get:async(kind,id)=>{const value=await f.deps.store.get(kind,id);if(value?.leaseRecord)value.leaseRecord.native.hostId='d'.repeat(64);return value;}},
    drivers:{codex:{ownedLifecycle:{async claim(input){return nativeClaim(f,input.jobId);},register(){},
      async stop(value,key){stops++;new AgentLeaseJournal(leases,key,value).settled({state:'not-dispatched',creatorCreated:value.native!.creatorCreated});},
      async inspectStopped(value,key){return new AgentLeaseJournal(leases,key,value).isSettled();}},async run(){runs++;return {state:'completed'};}}}});
  try{
    const receipt=await module.action('start',f.request,f.context);assert.equal(receipt.error?.code,'unavailable');
    assert.equal(stops,1);assert.equal(runs,0);assert.equal(leases.peek('codex').state,'available');
  }finally{await module.close();await f.cleanup();}
});

test('runtime factory recovers orphan pre-ACK leases only with exact creator birth and preserves foreign live owners',async()=>{
  const f=fixture(),directory=path.join(f.directory,'isolated-leases'),leases=new AgentLeasePool(directory);
  const factory=createNativeRuntimeAgentFactory({controlRoot:path.join(f.directory,'control'),leases,helperPath:path.join(f.directory,'missing.exe'),helperSha256:'c'.repeat(64),
    creatorState:async(_pid,created)=>({state:created==='123456789'?'dead':'alive',created})});
  const module=new RuntimeAgents({...f.deps,...factory});
  try{
    const old=leases.acquire('codex','runtime:orphan-job',nativeClaim(f,'orphan-job'));old.retain();
    assert.equal((await module.recover())[0].state,'recovered');assert.equal(f.rows.size,0);
    const foreign=leases.acquire('codex','runtime:foreign-job',{...nativeClaim(f,'foreign-job'),creatorCreated:'987654321'});foreign.retain();
    assert.equal((await module.recover())[0].state,'recovery-required');
    const observed=leases.peek('codex');assert.equal(observed.state,'occupied');if(observed.state==='occupied')assert.equal(observed.record.token,foreign.token);
    assert.equal(f.rows.size,0);assert.throws(()=>new AgentLeasePool(directory).acquire('codex','other'));
  }finally{await module.close();await f.cleanup();}
});

// Optional dedicated acceptance mode is invoked by the trusted native release
// gate, not the portable public test command. Missing helper/pin is a FAILURE;
// no real providers, installed profiles, shared pool, or account calls are used.
if(process.env.CAPRI_RUNTIME_OWNERSHIP_NATIVE_TESTS==='1'){
  const nativeHelper=process.env.CAPRI_PROCESS_SUPERVISOR??'',nativePin=process.env.CAPRI_PROCESS_SUPERVISOR_SHA256??'';
  const checkNative=()=>{assert.equal(process.platform,'win32');assert.ok(path.isAbsolute(nativeHelper));assert.match(nativePin,/^[a-f0-9]{64}$/);
    assert.equal(createHash('sha256').update(fs.readFileSync(nativeHelper)).digest('hex'),nativePin);};
  const neutralCodex=`const fs=require('node:fs'),rl=require('node:readline'),{spawn}=require('node:child_process');
const options=JSON.parse(fs.readFileSync('fixture-options.json','utf8'));let buffer='';
function send(value){process.stdout.write(JSON.stringify(value)+'\\n');}
rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{userAgent:'neutral'}});
if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt'}}});
if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread-1'}}});
if(m.method==='turn/start'){
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit'],windowsHide:true});
  fs.writeFileSync('fixture-dispatched.json',JSON.stringify({pid:process.pid,descendant:child.pid}));
  send({id:m.id,result:{turn:{id:'turn-1'}}});
  if(options.exitAfterDispatch){process.exit(0);return;}
  if(!options.hang){send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'answer-1',type:'agentMessage',phase:'final_answer',text:'Neutral owned fixture'}}});
    send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});setTimeout(()=>process.exit(0),20);}
}});`;
  const neutralClaude=`const fs=require('node:fs'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit'],windowsHide:true});
fs.writeFileSync('fixture-dispatched.json',JSON.stringify({pid:process.pid,descendant:child.pid}));
process.stdout.write(JSON.stringify({type:'system',subtype:'init',apiKeySource:'ANTHROPIC_API_KEY',session_id:'session-1'})+'\\n');
process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,permission_denials:[],session_id:'session-1',result:'Neutral SDK owned fixture'})+'\\n');
setInterval(()=>{},1000);`;
  function nativeFixture(provider:'codex'|'claude-api'='codex',hang=false,beforeSdk?:()=>void){
    checkNative();const f=fixture();f.deps.timeoutMs=20000;
    fs.writeFileSync(path.join(f.root,'app-server'),neutralCodex);fs.writeFileSync(path.join(f.root,'neutral-sdk.cjs'),neutralClaude);
    fs.writeFileSync(path.join(f.root,'fixture-options.json'),JSON.stringify({hang}));
    const leases=new AgentLeasePool(path.join(f.directory,'isolated-leases'));
    let guardian:ChildProcessWithoutNullStreams|undefined;
    const sdk:ClaudeSdkDriver={query({options}){
      const child=options.spawnClaudeCodeProcess!({command:process.execPath,args:[path.join(f.root,'neutral-sdk.cjs')],cwd:f.root,env:options.env??{},signal:options.abortController!.signal});
      const lines:any[]=[];let tail='',ended=false;child.stdout.on('data',chunk=>{tail+=chunk.toString();let newline;while((newline=tail.indexOf('\n'))>=0){lines.push(JSON.parse(tail.slice(0,newline)));tail=tail.slice(newline+1);}});child.on('exit',()=>{ended=true;});
      return {close(){child.kill('SIGTERM');},async *[Symbol.asyncIterator](){while(!ended||lines.length){if(lines.length)yield lines.shift();else await pause();}}} as any;
    }};
    const factory=createNativeRuntimeAgentFactory({controlRoot:path.join(f.directory,'control'),leases,helperPath:nativeHelper,helperSha256:nativePin,loadClaude:async()=>{beforeSdk?.();return sdk;},
      spawnGuardian(command,args,options){assert.equal(options.detached,true);assert.equal(options.windowsHide,true);assert.equal(command,nativeHelper);
        guardian=spawn(command,args,options) as ChildProcessWithoutNullStreams;return guardian;}});
    const module=new RuntimeAgents({...f.deps,...factory});
    if(provider==='claude-api')f.authority.configuration={provider,apiKey:'neutral-not-a-credential',model:'neutral',budgetUsd:0.01,configDir:f.configDir,isolated:true};
    const request={...f.request,input:{...f.request.input,provider}};
    const readProof=()=>{const row=f.row();assert.ok(row.leaseRecord?.native);assert.ok(row.supervisor);
      const log=new AgentLeaseJournal(leases,provider,row.leaseRecord),state=log.read();assert.equal(state.phase,'armed');
      if(state.phase!=='armed')throw Error('Missing armed checkpoint');assert.deepEqual(state.supervisor,row.supervisor);
      const proof=inspectSupervisedRun(row.supervisor);assert.equal(proof.state,'stopped');if(proof.state==='stopped')assert.equal(proof.proof.activeProcesses,0);
      assert.equal(log.isSettled(),true);assert.equal(leases.peek(provider).state,'available');return proof;};
    return {...f,module,request,factory,leases,readProof,get guardian(){return guardian;},async cleanup(){await module.close();await f.cleanup();}};
  }

  test('native Codex setup uses durable owned app-server identity and zero-tree settlement without inference',async()=>{
    const f=nativeFixture();let owned:AgentLeaseRecord|undefined,opened=0;
    fs.writeFileSync(path.join(f.root,'app-server'),`const rl=require('node:readline');
function send(m){process.stdout.write(JSON.stringify(m)+'\\n');}
rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{userAgent:'neutral-setup'}});
if(m.method==='account/login/start'){send({id:m.id,result:{type:'chatgpt',loginId:'native-login',authUrl:'https://auth.openai.com/oauth/authorize?state=neutral'}});send({method:'account/login/completed',params:{loginId:'native-login',success:true,error:null}});}
if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt'},requiresOpenaiAuth:true}});
if(m.method==='model/list')send({id:m.id,result:{data:[{model:'neutral-catalog-model',hidden:false}],nextCursor:null}});
if(/^(thread|turn)\\//.test(m.method||''))process.exit(23);
});setInterval(()=>{},1000);`);
    const original=f.factory.drivers.codex,driver={...original,ownedLifecycle:{...original.ownedLifecycle!,register(record:AgentLeaseRecord,provider:'codex'|'claude-api'){owned=record;original.ownedLifecycle!.register!(record,provider);}}};
    const connection=new CodexRuntimeConnection({configuration:()=>f.authority.configuration as any,save:async()=>assert.fail('setup cannot choose a model'),workspace:f.authority.workspace!,open:async()=>{opened++;},timeoutMs:15000},driver,f.leases);
    try{
      connection.start('connect',f.context.signal);await within(()=>!connection.snapshot().sessionId);
      assert.equal(opened,1);assert.equal(connection.snapshot().authenticated,true);assert.equal(connection.snapshot().inferenceVerified,false);assert.ok(owned?.native);
      const journal=new AgentLeaseJournal(f.leases,'codex',owned!),state=journal.read();assert.equal(state.phase,'armed');assert.equal(journal.isSettled(),true);assert.equal(f.leases.peek('codex').state,'available');
      if(state.phase!=='armed')throw Error('Missing setup arming');const proof=inspectSupervisedRun(state.supervisor);assert.equal(proof.state,'stopped');if(proof.state==='stopped')assert.equal(proof.proof.activeProcesses,0);
      assert.equal(f.rows.size,0,'setup never creates an inference job/result');
    }finally{await connection.close();await f.cleanup();}
  });

  for(const provider of ['codex','claude-api'] as const)test('native runtime '+provider+' normal completion has durable armed readback and signed zero-tree settlement',async()=>{
    const f=nativeFixture(provider);
    try{
      const started=await f.module.action('start',f.request,f.context);assert.equal(started.outcome,'pending');
      await within(async()=>!!await f.module.readResult(started.jobId!,f.context));
      const result=(await f.module.readResult(started.jobId!,f.context))!;
      assert.equal(result.state,'completed');assert.equal(result.report?.source.provider,provider);assert.equal(result.verification,'unverified');
      f.readProof();const dispatch=JSON.parse(fs.readFileSync(path.join(f.root,'fixture-dispatched.json'),'utf8'));assert.ok(dispatch.descendant);
      assert.equal((await f.module.action('start',f.request,f.context)).jobId,started.jobId);f.readProof();
    }finally{await f.cleanup();}
  });

  test('native runtime rechecks physical lease/workspace separation before spawning a guardian',async()=>{
    const f=nativeFixture('claude-api',false,()=>{
      fs.renameSync(f.leases.directory!,backup);
      fs.symlinkSync(f.root,f.leases.directory!,process.platform==='win32'?'junction':'dir');
    }),backup=path.join(f.directory,'original-pool');
    try{
      assert.equal((await f.module.action('start',f.request,f.context)).outcome,'pending');
      await within(()=>f.row().job.state==='unconfirmed');await f.module.close();
      assert.equal(f.guardian,undefined);assert.equal(f.row().supervisor,undefined);
      assert.equal(fs.existsSync(path.join(f.root,'fixture-dispatched.json')),false);
      assert.equal(fs.existsSync(path.join(f.directory,'control',f.row().leaseRecord.native.controlToken)),false);
      const head=JSON.parse(fs.readFileSync(path.join(backup,'runs',f.row().leaseRecord.token,'head.json'),'utf8'));
      assert.equal(head.phase,'claimed');assert.notEqual(f.leases.peek('claude-api').state,'available');
      assert.throws(()=>new AgentLeasePool(f.leases.directory).acquire('claude-api','other-owner'));
      assert.equal(fs.existsSync(path.join(f.root,'runs')),false);
    }finally{
      if(fs.existsSync(backup)){if(fs.lstatSync(f.leases.directory!).isSymbolicLink())fs.unlinkSync(f.leases.directory!);fs.renameSync(backup,f.leases.directory!);}
      await f.cleanup();
    }
  });

  test('native runtime explicit Stop cancels only the exact owned Job and never replays partial work',async()=>{
    const f=nativeFixture('codex',true),sibling=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    try{
      const started=await f.module.action('start',f.request,f.context);assert.equal(started.outcome,'pending');
      await within(()=>fs.existsSync(path.join(f.root,'fixture-dispatched.json')));const identity=f.row().supervisor;
      const result=await f.module.action('cancel',{requestId:'stop-1',taskId:'task-1',input:{jobId:started.jobId}},f.context);
      assert.equal(result.effect,'unknown');assert.equal(result.outcome,'unconfirmed');assert.deepEqual(f.row().supervisor,identity);
      f.readProof();assert.equal(sibling.exitCode,null);assert.equal(sibling.signalCode,null);
      assert.equal((await f.module.action('start',f.request,f.context)).outcome,'unconfirmed');
      assert.equal(await f.module.readResult(started.jobId!,f.context),undefined);
    }finally{sibling.kill('SIGKILL');await once(sibling,'close');await f.cleanup();}
  });

  test('native runtime two host factories share capacity and a contender launches only after exact settlement',async()=>{
    const f=nativeFixture('codex',true),otherLeases=new AgentLeasePool(f.leases.directory);
    let otherSpawns=0;const otherRows=new Map<string,any>();
    const otherStore={get:async(k:string,id:string)=>structuredClone(otherRows.get(k+':'+id)),
      put:async(k:string,v:any)=>{otherRows.set(k+':'+v.id,structuredClone(v));return v;},
      list:async(k:string)=>[...otherRows].filter(([key])=>key.startsWith(k+':')).map(([,v])=>structuredClone(v)),remove:async(k:string,id:string)=>{otherRows.delete(k+':'+id);}};
    const otherFactory=createNativeRuntimeAgentFactory({controlRoot:path.join(f.directory,'other-control'),leases:otherLeases,helperPath:nativeHelper,helperSha256:nativePin,
      spawnGuardian(exe,args,options){otherSpawns++;return spawn(exe,args,options) as ChildProcessWithoutNullStreams;}});
    const module=new RuntimeAgents({...f.deps,...otherFactory,store:otherStore}),request={...f.request,requestId:'request-2'};
    try{
      assert.equal((await f.module.action('start',f.request,f.context)).outcome,'pending');await within(()=>fs.existsSync(path.join(f.root,'fixture-dispatched.json')));
      assert.equal((await module.action('start',request,f.context)).error?.code,'unavailable');assert.equal(otherSpawns,0);
      assert.equal((await module.recover())[0].state,'recovery-required');assert.equal(otherSpawns,0);
      assert.equal(f.row().job.state,'running');assert.equal(f.guardian!.exitCode,null);assert.equal(otherRows.size,0);
      await f.module.close();f.readProof();
      fs.writeFileSync(path.join(f.root,'fixture-options.json'),JSON.stringify({hang:false}));
      const started=await module.action('start',request,f.context);assert.equal(started.outcome,'pending');
      await within(async()=>!!await module.readResult(started.jobId!,f.context));assert.equal(otherSpawns,1);
      assert.equal(otherLeases.peek('codex').state,'available');assert.equal(f.row().receipt.effect,'unknown');
    }finally{await module.close();await f.cleanup();}
  });

  test('native runtime main exit cleans descendants holding pipes and cannot become task success',async()=>{
    const f=nativeFixture('codex',true);
    fs.writeFileSync(path.join(f.root,'fixture-options.json'),JSON.stringify({hang:true,exitAfterDispatch:true}));
    try{
      assert.equal((await f.module.action('start',f.request,f.context)).outcome,'pending');
      await within(()=>f.row().job.state==='unconfirmed');await f.module.close();
      const proof=f.readProof();assert.equal(proof.state,'stopped');if(proof.state==='stopped'){assert.equal(proof.proof.reason,'main-exited');assert.equal(proof.proof.mainExitCode,0);}
      assert.equal(f.row().receipt.effect,'unknown');assert.equal(f.row().job.state,'unconfirmed');
    }finally{await f.cleanup();}
  });

  test('native runtime failed armed Store callback never ACKs or executes a provider',async()=>{
    const f=nativeFixture();
    const module=new RuntimeAgents({...f.deps,...f.factory,store:{...f.deps.store,get:async(kind,id)=>{const row=await f.deps.store.get(kind,id);if(row?.supervisor)throw Error('Neutral Store readback rejection');return row;}}});
    try{
      assert.equal((await module.action('start',f.request,f.context)).outcome,'pending');
      await within(()=>f.leases.peek('codex').state==='available');await module.close();
      assert.equal(fs.existsSync(path.join(f.root,'fixture-dispatched.json')),false);
      const row=f.row();assert.ok(row.supervisor);assert.equal(fs.existsSync(path.join(row.supervisor.directory,'ack.json')),false);
      assert.equal(inspectSupervisedRun(row.supervisor).state,'stopped');assert.notEqual(row.receipt.outcome,'completed');
    }finally{await module.close();await f.cleanup();}
  });

  test('native runtime Stop during a delayed armed callback prevents late ACK and preserves unknown effects',async()=>{
    const f=nativeFixture(),blocked=deferred(),release=deferred();let gated=false;
    const module=new RuntimeAgents({...f.deps,...f.factory,store:{...f.deps.store,get:async(kind,id)=>{
      const row=await f.deps.store.get(kind,id);if(row?.supervisor&&!gated){gated=true;blocked.resolve();await release.promise;}return row;
    }}});
    try{
      assert.equal((await module.action('start',f.request,f.context)).outcome,'pending');await blocked.promise;
      const closing=module.close(),identity=f.row().supervisor;
      await within(()=>inspectSupervisedRun(identity).state==='stopped');
      assert.equal(fs.existsSync(path.join(identity.directory,'ack.json')),false);
      assert.equal(fs.existsSync(path.join(f.root,'fixture-dispatched.json')),false);
      release.resolve();await closing;
      assert.equal(fs.existsSync(path.join(identity.directory,'ack.json')),false);
      assert.notEqual(f.row().receipt.outcome,'completed');assert.equal(f.leases.peek('codex').state,'available');
    }finally{release.resolve();await module.close();await f.cleanup();}
  });

  test('native runtime creator crash recovers signed whole-tree proof and orphan journal without replay',async()=>{
    const f=nativeFixture('codex',true),file=path.join(f.directory,'creator.mts'),journalFile=path.join(f.directory,'creator-store.json');
    const agentsUrl=pathToFileURL(path.resolve('src/extensions/agents.ts')).href,leasesUrl=pathToFileURL(path.resolve('src/extensions/agent-lease.ts')).href;
    const source=`import fs from 'node:fs';import {RuntimeAgents,createNativeRuntimeAgentFactory} from ${JSON.stringify(agentsUrl)};import {AgentLeasePool} from ${JSON.stringify(leasesUrl)};
const options=JSON.parse(process.argv[2]),rows=new Map();const persist=()=>{const fd=fs.openSync(options.journal,'w');try{fs.writeFileSync(fd,JSON.stringify([...rows]));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
const store={put:async(k,v)=>{rows.set(k+':'+v.id,structuredClone(v));persist();return v;},get:async(k,id)=>structuredClone(rows.get(k+':'+id)),list:async k=>[...rows].filter(([key])=>key.startsWith(k+':')).map(([,v])=>structuredClone(v)),remove:async(k,id)=>{rows.delete(k+':'+id);persist();}};
const factory=createNativeRuntimeAgentFactory({leases:new AgentLeasePool(options.leases),controlRoot:options.control,helperPath:options.helper,helperSha256:options.pin});
const module=new RuntimeAgents({...factory,store,clock:()=>1000,host:{run:async()=>{throw Error('No host');}},transport:{request:async()=>{throw Error('No transport');}},resolveAuthority:async()=>options.authority,timeoutMs:20000});
const controller=new AbortController();const receipt=await module.action('start',options.request,{signal:controller.signal,authority:'task',taskId:'task-1',privateSession:false,localOnly:false});
if(receipt.outcome!=='pending')throw Error('Neutral runtime child could not start');
const timer=setInterval(()=>{if(fs.existsSync(options.dispatched)){clearInterval(timer);process.exit(71);}},10);`;
    fs.writeFileSync(file,source);
    const loader=pathToFileURL(createRequire(path.join(process.cwd(),'package.json')).resolve('tsx')).href;
    const child=spawn(process.execPath,['--import',loader,file,JSON.stringify({leases:f.leases.directory,control:path.join(f.directory,'control'),helper:nativeHelper,pin:nativePin,
      journal:journalFile,authority:f.authority,request:f.request,dispatched:path.join(f.root,'fixture-dispatched.json')})],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString();});child.stdout.resume();
    try{
      const [code]=await once(child,'close');assert.equal(code,71,stderr);
      const values=new Map<string,any>(JSON.parse(fs.readFileSync(journalFile,'utf8'))),record=values.get(agentJournalKind+':request-1');
      assert.ok(record.supervisor);assert.ok(record.leaseRecord.native);assert.equal(record.dispatched,true);
      await within(()=>inspectSupervisedRun(record.supervisor).state==='stopped');
      const proof=inspectSupervisedRun(record.supervisor);assert.equal(proof.state,'stopped');if(proof.state==='stopped')assert.equal(proof.proof.reason,'creator-exited');
      for(const [key,value] of values)f.rows.set(key,value);
      // New host instance recovers the orphan generation from durable native
      // evidence, converts the Store receipt to unknown, and never relaunches.
      assert.equal((await f.module.recover())[0].state,'recovered');
      assert.equal(f.row().receipt.effect,'unknown');assert.equal(f.row().job.state,'unconfirmed');
      assert.equal((await f.module.action('start',f.request,f.context)).outcome,'unconfirmed');
      assert.equal(f.guardian,undefined);assert.equal(f.leases.peek('codex').state,'available');
    }finally{if(child.exitCode===null){child.kill('SIGKILL');await once(child,'close');}await f.cleanup();}
  });

  test('native runtime forced guardian loss preserves uncertain ownership even with a dead guardian',async()=>{
    const f=nativeFixture('codex',true);
    try{
      assert.equal((await f.module.action('start',f.request,f.context)).outcome,'pending');await within(()=>fs.existsSync(path.join(f.root,'fixture-dispatched.json')));
      // Test owns the original captured object; this deliberately simulates
      // external forced death rather than using the adapter's safe kill method.
      const guardian=f.guardian!;const rawKill=Object.getPrototypeOf(guardian).kill;rawKill.call(guardian,'SIGKILL');
      await within(()=>f.row().job.state==='unconfirmed');await f.module.close();
      assert.equal(inspectSupervisedRun(f.row().supervisor).state,'recovery-required');
      assert.equal((await f.module.recover())[0].state,'recovery-required');assert.throws(()=>new AgentLeasePool(f.leases.directory).acquire('codex','foreign'));
      assert.equal(f.row().receipt.effect,'unknown');assert.equal(fs.existsSync(path.join(f.row().supervisor.directory,'terminal.json')),false);
    }finally{await f.cleanup();}
  });
}
