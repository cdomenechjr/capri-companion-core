import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CreativeStudio} from '../src/ui/CreativeStudio';
import {ProviderSettings} from '../src/ui/ProviderSettings';
import {beginSubmission,cancelSubmission,capabilityLoader,composePrompt,createStudioRun,emptyStudioDraft,exportFileName,galleryNeedsReload,imageAvailability,imageCapabilityKey,importReference,referenceSendable,referenceStatus,runImageRequest,settleOutcome,studioActionLabel,studioStep,STOPPED_MESSAGE,type CapabilityState,type StudioDraft,type StudioEvent,type StudioOutcome,type StudioRun} from '../src/ui/creative-brief';
import {defaults} from '../src/shared';

// Mirrors main.tsx: the parent owns the draft and the run; Studio pages come and go.
function parentHarness(initial:StudioDraft){
 const run=createStudioRun();let draft=initial;const setDraft=(f:(d:StudioDraft)=>StudioDraft)=>{draft=f(draft);};const toasts:string[]=[];
 const settle=(outcome:StudioOutcome,generation:number)=>setDraft(d=>studioStep(d,{type:'settled',outcome,generation}).draft);
 // Same sequence as CreativeStudio's dispatch/submit for an explicit click.
 const click=(type:'generate'|'variant',request:(route:string,method?:string,body?:any)=>Promise<any>,ready=true)=>{
  const step=beginSubmission(run,draft,{type,ready});if(!step.request)return undefined;draft=step.draft;
  return runImageRequest(step.request,step.generation,{run,request,settle}).then(r=>{if(r.current&&r.outcome.kind==='created')toasts.push('Image created');return r;});
 };
 return {run,get draft(){return draft;},setDraft,click,toasts,stop:()=>cancelSubmission(run,setDraft)};
}
// Mirrors one mounted CreativeStudio gallery: its reload guard and the effect keyed on revision and referenceId.
function galleryPage(app:ReturnType<typeof parentHarness>,request:(route:string,method?:string,body?:any)=>Promise<any>){
 const page={mounted:true,ids:[] as string[],loading:true,error:'',checked:undefined as string|undefined,loads:0,revision:undefined as number|undefined};
 async function reload(){
  const load=++page.loads;const checked=app.draft.referenceId;const current=()=>page.mounted&&load===page.loads;page.loading=true;page.error='';
  try{const rows=await request('/v1/attachments');if(current())Object.assign(page,{ids:rows.map((r:any)=>r.id),loading:false,checked});}
  catch(e:any){if(current())Object.assign(page,{loading:false,error:e.message,checked});}
 }
 const status=()=>referenceStatus(app.draft.referenceId,page);
 return {page,reload,status,label:()=>studioActionLabel(app.draft.outcome.kind==='pending',status()),canCreate:()=>referenceSendable(status()),
  effect:()=>{const previous=page.revision;page.revision=app.draft.revision;return galleryNeedsReload(previous,app.draft.revision,app.draft.referenceId,page.ids)?reload():undefined;}};
}
const deferred=()=>{let resolve!:(v:any)=>void,reject!:(e:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(r=>setImmediate(r));

const apply=(draft:StudioDraft,events:StudioEvent[])=>{const requests:any[]=[];for(const e of events){const step=studioStep(draft,e);draft=step.draft;if(step.request)requests.push(step.request);}return {draft,requests};};

test('brief composes a concise editable prompt in subject, style, composition order',()=>{
 assert.equal(composePrompt({subject:'  a rooftop   garden above a neon city. ',style:'soft pink light, rain',composition:'wide wallpaper\n crop'}),'A rooftop garden above a neon city. Style: soft pink light, rain. Composition and use: wide wallpaper crop.');
 assert.equal(composePrompt({subject:'',style:'',composition:''}),'');
 assert.equal(composePrompt({subject:'',style:'ink wash',composition:''}),'Style: ink wash.');
 assert.equal(composePrompt({subject:'x'.repeat(9000),style:'',composition:''}).length,8000);
});

test('brief edits rebuild the prompt until the user edits it, and rebuild restores it',()=>{
 let {draft}=apply(emptyStudioDraft,[{type:'brief',patch:{subject:'a fox'}},{type:'brief',patch:{style:'pixel art'}}]);
 assert.equal(draft.prompt,'A fox. Style: pixel art.');assert.equal(draft.promptEdited,false);
 draft=apply(draft,[{type:'prompt',text:'A fox in pixel art, holding a lantern'},{type:'brief',patch:{composition:'icon'}}]).draft;
 assert.equal(draft.prompt,'A fox in pixel art, holding a lantern');assert.equal(draft.promptEdited,true);
 draft=studioStep(draft,{type:'rebuild'}).draft;
 assert.equal(draft.prompt,'A fox. Style: pixel art. Composition and use: icon.');assert.equal(draft.promptEdited,false);
});

test('navigating, editing options, selecting references and settling never request an image',()=>{
 const events:StudioEvent[]=[{type:'brief',patch:{subject:'a city'}},{type:'prompt',text:'A city at dusk'},{type:'reference',id:'img-1'},{type:'select',id:'img-2'},{type:'rebuild'},{type:'reference',id:''},
  {type:'cancel'},{type:'settled',outcome:{kind:'created',attachmentId:'img-3'},generation:1}];
 const {draft,requests}=apply({...emptyStudioDraft,lastRequest:{prompt:'Earlier'},outcome:{kind:'pending',request:{prompt:'Earlier'},generation:1}},events);
 assert.deepEqual(requests,[]);
 assert.equal(draft.prompt,'A city.');assert.equal(draft.outcome.kind,'unconfirmed','Stop leaves the pending submission unconfirmed');
 assert.equal(draft.selectedId,'img-2','a reply after Stop does not settle the outcome');
});

test('generation needs an explicit ready click, sends the reference only when chosen and blocks while pending',()=>{
 const base=apply(emptyStudioDraft,[{type:'brief',patch:{subject:'a koi pond'}}]).draft;
 assert.equal(studioStep(base,{type:'generate',ready:false,generation:1}).request,undefined,'unavailable images do not send');
 assert.equal(studioStep({...base,prompt:'  ',promptEdited:true},{type:'generate',ready:true,generation:1}).request,undefined,'empty prompts do not send');
 const first=studioStep(base,{type:'generate',ready:true,generation:1});
 assert.deepEqual(first.request,{prompt:'A koi pond.'});assert.deepEqual(first.draft.outcome,{kind:'pending',request:{prompt:'A koi pond.'},generation:1});
 assert.equal(studioStep(first.draft,{type:'generate',ready:true,generation:2}).request,undefined,'a pending request blocks a second click');
 assert.equal(studioStep(first.draft,{type:'variant',ready:true,generation:2}).request,undefined);
 const edit=studioStep({...base,referenceId:'img-9'},{type:'generate',ready:true,generation:1});
 assert.deepEqual(edit.request,{prompt:'A koi pond.',attachmentId:'img-9'});
 // The parent-owned run also blocks a double click before React re-renders the stale draft.
 const run=createStudioRun();assert.ok(beginSubmission(run,base,{type:'generate',ready:true}).request);
 assert.equal(beginSubmission(run,base,{type:'generate',ready:true}).request,undefined,'an in-flight submission blocks a click from a stale draft');
 const refused=createStudioRun();beginSubmission(refused,base,{type:'generate',ready:false});
 assert.deepEqual(refused,{generation:0,pending:0},'a refused click claims no generation');
});

test('variants rerun the last request only on click and keep the draft after failures',()=>{
 let {draft,requests}=apply(emptyStudioDraft,[{type:'brief',patch:{subject:'a lighthouse'}},{type:'reference',id:'ref-1'},{type:'generate',ready:true,generation:1}]);
 assert.equal(requests.length,1);
 draft=apply(draft,[{type:'settled',outcome:{kind:'unconfirmed',message:'Monthly application budget reached.'},generation:1},{type:'brief',patch:{style:'watercolor'}},{type:'reference',id:''}]).draft;
 assert.equal(draft.prompt,'A lighthouse. Style: watercolor.','drafts survive a failed request');
 assert.equal(draft.outcome.kind,'unconfirmed','failures are not retried');
 const variant=studioStep(draft,{type:'variant',ready:true,generation:2});
 assert.deepEqual(variant.request,{prompt:'A lighthouse.',attachmentId:'ref-1'},'variant repeats the exact previous request');
 assert.equal(studioStep(emptyStudioDraft,{type:'variant',ready:true,generation:1}).request,undefined,'no previous request means no variant');
});

test('only a service receipt with an attachment id reports creation',()=>{
 assert.deepEqual(settleOutcome({attachmentId:'new'},undefined),{kind:'created',attachmentId:'new'});
 assert.equal(settleOutcome({ok:true},undefined).kind,'unconfirmed','a reply without a receipt is not acceptance');
 assert.equal(settleOutcome({attachmentId:''},undefined).kind,'unconfirmed');
 assert.equal(settleOutcome(undefined,new TypeError('Failed to fetch')).kind,'unconfirmed');
 assert.equal(settleOutcome(undefined,new Error('The service could not complete this action.')).kind,'unconfirmed');
 assert.deepEqual(settleOutcome(undefined,new Error("Error invoking remote method 'capri:request': Error: Image generation and editing are disabled in Settings.")),{kind:'unconfirmed',message:'Image generation and editing are disabled in Settings.'});
});

test('thrown errors never count as rejected because message text does not prove pre-dispatch',()=>{
 const kind=(e:unknown)=>settleOutcome(undefined,e).kind;
 // The transport strips status and error types, and provider messages are forwarded verbatim.
 for(const message of['Image generation and editing are disabled in Settings.','Images need a configured image provider. Local mode will not spend OpenAI credits.','Connect OpenAI in Settings first.','Monthly application budget reached. Local plans and memory remain available.','Monthly application budget cannot cover an image reservation.','OpenAI image allowance reached. After restoring access, reselect OpenAI.','Source image not found.','Invalid source image encoding.','Source image content does not match its format.'])
  assert.equal(kind(new Error(message)),'unconfirmed',message);
 assert.equal(kind(new Error('Provider returned no image.')),'unconfirmed');
 assert.equal(kind(new SyntaxError('Unexpected token < in JSON at position 0')),'unconfirmed');
 assert.equal(kind(new Error("Error invoking remote method 'capri:request': TypeError: fetch failed")),'unconfirmed');
 assert.equal(kind(new Error('Your request was rejected as a result of our safety system.')),'unconfirmed','provider errors after dispatch are not treated as safe refusals');
 assert.equal(kind(new TypeError('Connect OpenAI in Settings first.')),'unconfirmed','a transport TypeError is never a refusal');
 assert.equal(kind(''),'unconfirmed');
});

test('a request started before navigating away settles into the parent draft and refreshes the reopened gallery',async()=>{
 // The parent (main.tsx) owns the draft and run; Studio may unmount and remount at any time.
 const app=parentHarness({...emptyStudioDraft,prompt:'A fox.'});const reply=deferred();const calls:string[]=[];
 const request=(route:string,method='GET')=>{calls.push(method+' '+route);return reply.promise;};
 const done=app.click('generate',request)!;
 assert.deepEqual(calls,['POST /v1/images'],'the POST is dispatched synchronously with no awaited preflight');
 await tick();
 // First Studio unmounts; a new one mounts and loads the gallery keyed on the current revision.
 const mountedRevision=app.draft.revision;assert.equal(app.draft.outcome.kind,'pending');
 assert.equal(app.click('generate',request),undefined,'the reopened page cannot resubmit while pending');
 reply.resolve({attachmentId:'new'});
 const {outcome,current}=await done;
 assert.deepEqual(outcome,{kind:'created',attachmentId:'new'});assert.equal(current,true);
 assert.equal(app.draft.outcome.kind,'created');assert.equal(app.draft.selectedId,'new','the returned image becomes the active preview');
 assert.notEqual(app.draft.revision,mountedRevision,'settling changes the revision that keys the gallery reload');
 assert.deepEqual(app.toasts,['Image created']);
 assert.deepEqual(calls,['POST /v1/images'],'exactly one image request, no retry');
});

test('Stop before dispatch prevents the paid POST, even from a stale page',async()=>{
 const app=parentHarness({...emptyStudioDraft,prompt:'A fox.'});const calls:string[]=[];const request=async(route:string,method='GET')=>{calls.push(method+' '+route);return {attachmentId:'x'};};
 // A click is accepted, then Stop lands before the request helper runs.
 const step=beginSubmission(app.run,app.draft,{type:'generate',ready:true});app.setDraft(()=>step.draft);
 app.stop();
 const result=await runImageRequest(step.request!,step.generation,{run:app.run,request,settle:()=>assert.fail('a stopped submission never settles')});
 assert.equal(result.sent,false);assert.deepEqual(calls,[],'no POST /v1/images after Stop');
 assert.deepEqual(app.draft.outcome,{kind:'unconfirmed',message:STOPPED_MESSAGE});
 assert.deepEqual(app.toasts,[]);
});

test('Stop while pending keeps the outcome unconfirmed and a late receipt neither settles it nor toasts',async()=>{
 const app=parentHarness({...emptyStudioDraft,prompt:'A fox.'});const reply=deferred();const calls:string[]=[];
 const done=app.click('generate',(route,method='GET')=>{calls.push(method+' '+route);return reply.promise;})!;
 await tick();app.stop();
 assert.deepEqual(app.draft.outcome,{kind:'unconfirmed',message:STOPPED_MESSAGE},'Stop does not claim the provider was never reached');
 const revision=app.draft.revision;
 reply.resolve({attachmentId:'late'});const {current}=await done;
 assert.equal(current,false);assert.equal(app.draft.outcome.kind,'unconfirmed');assert.notEqual(app.draft.selectedId,'late');
 assert.equal(app.draft.revision,revision+1,'the late reply only refreshes the gallery');
 assert.deepEqual(app.toasts,[],'no success toast after Stop');
 assert.deepEqual(calls,['POST /v1/images'],'nothing is retried');
});

test('an old reply after Stop cannot settle a newer request',async()=>{
 const app=parentHarness({...emptyStudioDraft,prompt:'A fox.'});const first=deferred(),second=deferred();const replies=[first,second];const bodies:any[]=[];
 const request=(_route:string,_method?:string,body?:any)=>{bodies.push(body);return replies[bodies.length-1].promise;};
 const a=app.click('generate',request)!;await tick();app.stop();
 const b=app.click('variant',request)!;assert.ok(b,'Stop frees the user to submit again by click');
 const newer=app.draft.outcome;assert.equal(newer.kind,'pending');
 first.resolve({attachmentId:'old-reply'});assert.equal((await a).current,false);
 assert.deepEqual(app.draft.outcome,newer,'the newer request stays pending');assert.deepEqual(app.toasts,[]);
 second.reject(new Error('Provider returned no image.'));const r=await b;
 assert.equal(r.current,true);assert.deepEqual(app.draft.outcome,{kind:'unconfirmed',message:'Provider returned no image.'});
 assert.deepEqual(app.toasts,[],'neither reply produced a success toast');assert.equal(bodies.length,2);
});

test('an imported same-prompt attachment during a failed generation never confirms creation',async()=>{
 const app=parentHarness({...emptyStudioDraft,prompt:'Imported image'});const server:{id:string;prompt:string}[]=[];const reply=deferred();const calls:string[]=[];
 const request=(route:string,method='GET',body?:any)=>{calls.push(method+' '+route);
  if(route==='/v1/images')return reply.promise;
  if(method==='POST'){const row={id:'imp-'+server.length,prompt:'Imported image'};server.push(row);return Promise.resolve(row);}
  return Promise.resolve(server.slice());};
 const done=app.click('generate',request)!;
 // While generation is pending the user imports a reference whose stored prompt matches exactly.
 const imported=await request('/v1/attachments','POST',{base64:'AA==',mime:'image/png'});app.setDraft(d=>studioStep(d,{type:'reference',id:imported.id}).draft);
 reply.reject(new TypeError('fetch failed'));const {outcome}=await done;
 assert.equal(outcome.kind,'unconfirmed');assert.equal(app.draft.outcome.kind,'unconfirmed');
 assert.notEqual(app.draft.selectedId,imported.id,'the import is not treated as the generated image');
 assert.deepEqual(app.toasts,[]);
 assert.deepEqual(calls.filter(c=>c.includes('/v1/images')),['POST /v1/images'],'no retry');
 assert.ok(!calls.includes('GET /v1/attachments'),'gallery contents are not read as evidence');
});

test('an import finishing after navigating away and back resolves in the reopened gallery before any edit is sent',async()=>{
 const app=parentHarness({...emptyStudioDraft,prompt:'A fox.'});const server=[{id:'old-1'}];const stored=deferred();const calls:{call:string;body?:any}[]=[];
 const request=(route:string,method='GET',body?:any)=>{calls.push({call:method+' '+route,body});
  if(route==='/v1/images')return Promise.resolve({attachmentId:'edit-1'});
  if(method==='POST')return stored.promise.then(()=>{server.push({id:'imp-7'});return {id:'imp-7'};});
  return Promise.resolve(server.slice());};
 const images=()=>calls.filter(c=>c.call==='POST /v1/images');
 const first=galleryPage(app,request);await first.effect();
 const importing=importReference({base64:'AA==',mime:'image/png'},{request,setDraft:app.setDraft});
 // Navigate away mid-import, then reopen Studio; its gallery loads before the import is stored.
 first.page.mounted=false;const second=galleryPage(app,request);await second.effect();
 assert.deepEqual(second.page.ids,['old-1']);assert.equal(second.label(),'Create image');
 stored.resolve(undefined);assert.equal(await importing,'imp-7');
 assert.equal(app.draft.referenceId,'imp-7','the import completes into the parent draft, not the unmounted page');
 // Rendered before the effect runs: the reference is pending, never "No reference".
 assert.deepEqual(second.status(),{kind:'loading'});assert.equal(second.label(),'Waiting for reference');assert.equal(second.canCreate(),false);
 assert.equal(app.click('generate',request,second.canCreate()),undefined,'an unresolved reference cannot be submitted');
 const reloading=second.effect();assert.ok(reloading,'a new unresolved reference reloads the mounted gallery');
 assert.deepEqual(second.status(),{kind:'loading'});await reloading;
 assert.deepEqual(second.status(),{kind:'resolved'});assert.equal(second.label(),'Edit reference');assert.ok(second.page.ids.includes('imp-7'));
 assert.equal(second.effect(),undefined,'a resolved reference does not reload again');
 assert.deepEqual(images(),[],'no paid POST before an explicit click');
 const r=await app.click('generate',request,second.canCreate());
 assert.equal(r?.sent,true);assert.deepEqual(images().map(c=>c.body),[{prompt:'A fox.',attachmentId:'imp-7'}],'exactly the visible reference is sent once');
});

test('an unresolved or unloadable reference keeps its id, blocks submission and explains why',()=>{
 const empty={ids:['a'],loading:false,error:'',checked:'gone'};
 assert.deepEqual(referenceStatus('',empty),{kind:'none'});assert.deepEqual(referenceStatus('a',{...empty,loading:true}),{kind:'resolved'});
 assert.deepEqual(referenceStatus('gone',{...empty,checked:''}),{kind:'loading'},'a load from before the choice cannot prove it missing');
 const missing=referenceStatus('gone',empty);assert.equal(missing.kind,'unavailable');assert.equal(referenceSendable(missing),false);
 const failed=referenceStatus('gone',{...empty,error:'Request failed'});assert.equal(failed.kind,'unavailable');assert.match((failed as any).message,/could not be loaded: Request failed/);
 assert.equal(studioActionLabel(false,failed),'Waiting for reference');
 assert.equal(galleryNeedsReload(3,3,'gone',['a']),true);assert.equal(galleryNeedsReload(3,3,'a',['a']),false);assert.equal(galleryNeedsReload(3,4,'',[]),true);
 const draft={...emptyStudioDraft,prompt:'A fox.',referenceId:'imp-7'};const calls:string[]=[];
 const html=renderToStaticMarkup(React.createElement(CreativeStudio,{draft,setDraft:()=>{},run:createStudioRun(),capabilityKey:'k',request:async(route:string,method='GET')=>{calls.push(method+' '+route);return [];},loadUrl:async()=>''}));
 assert.match(html,/Loading the chosen reference/);assert.doesNotMatch(html,/No reference/);assert.match(html,/Waiting for reference/);
 assert.deepEqual(calls.filter(c=>c.includes('/v1/images')),[]);
});

test('raising the monthly budget invalidates image availability while Settings stays mounted',()=>{
 const settings={...defaults,imageProviderMode:'openai'};const status={routing:{active:'openai'},providerConfigured:true,budget:{spent:75,limit:75}};
 const before=imageCapabilityKey(settings,status);
 assert.notEqual(imageCapabilityKey({...settings,monthlyBudget:100},status),before,'a confirmed settings save changes the key');
 assert.notEqual(imageCapabilityKey(settings,{...status,budget:{spent:75,limit:100}}),before,'a refreshed status limit changes the key');
 assert.equal(imageCapabilityKey({...settings},{...status,budget:{...status.budget}}),before,'unrelated re-renders do not refetch');
 assert.notEqual(imageCapabilityKey({...settings,imageProviderMode:'disabled'},status),before);
 assert.notEqual(imageCapabilityKey(settings,status,1),before,'a confirmed service refresh changes the key');
});

// Mirrors main.tsx's refresh (re-read settings/status, then advance the capability
// revision) feeding a mounted ProviderSettings' capability loader.
function settingsApp(){
 const service={imageBlocked:true,calls:[] as string[]};const settings={...defaults,imageProviderMode:'openai'};const status={routing:{active:'openai'},providerConfigured:true,budget:{spent:5,limit:75}};
 const request=async(route:string,method='GET',body?:any):Promise<any>=>{service.calls.push(method+' '+route);
  if(route==='/v1/capabilities')return {images:service.imageBlocked?{available:false,mode:'openai',reason:'OpenAI blocked image access for this key.'}:{available:true,mode:'openai'},reasoning:{provider:'openai'}};
  if(route==='/v1/connection'&&method==='POST'){if(!body?.key)throw Error('No key');service.imageBlocked=false;return {ok:true};}
  if(route==='/v1/settings')return {...settings};if(route==='/v1/status')return {...status,budget:{...status.budget}};return {};};
 const app={settings:{...settings} as any,status:{...status} as any,revision:0,availability:imageAvailability(undefined)};
 const loader=capabilityLoader(request,state=>{app.availability=imageAvailability(state.caps,state.error);});
 const render=()=>loader.sync(imageCapabilityKey(app.settings,app.status,app.revision));
 const refresh=async()=>{const [s,st]=await Promise.all([request('/v1/settings'),request('/v1/status')]);app.settings=s;app.status=st;app.revision++;render();};
 const receive=(event:any)=>{if(['connection','changed','usage'].includes(event.type))void refresh();};
 return {service,app,request,render,refresh,receive};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('a connection event that clears an image block updates mounted Settings without navigation or image requests',async()=>{
 const {service,app,render,receive}=settingsApp();render();await flush();
 assert.equal(app.availability.tag,'UNAVAILABLE');
 const scalarsBefore=imageCapabilityKey(app.settings,app.status);
 service.imageBlocked=false;receive({type:'connection'});await flush();await flush();
 assert.equal(imageCapabilityKey(app.settings,app.status),scalarsBefore,'mode, configured flag and budget are unchanged');
 assert.equal(app.availability.tag,'OPENAI IMAGES CONFIGURED');assert.equal(app.availability.ready,true);
 assert.equal(service.calls.filter(c=>c==='GET /v1/capabilities').length,2);
 assert.deepEqual(service.calls.filter(c=>c.includes('/v1/images')),[]);
});

test('replacing a configured key restores image availability in mounted Settings; the revision carries no key data',async()=>{
 const {service,app,request,render,refresh}=settingsApp();render();await flush();
 assert.equal(app.availability.ready,false);
 const scalarsBefore=imageCapabilityKey(app.settings,app.status);const secret=['sk','test','replacement','0000'].join('-'); // Fake key from parts keeps the public secret scanner strict.
 // Same as main.tsx's run(): confirmed work, then refresh.
 await request('/v1/connection','POST',{key:secret});await refresh();await flush();
 assert.equal(imageCapabilityKey(app.settings,app.status),scalarsBefore);
 assert.equal(app.availability.tag,'OPENAI IMAGES CONFIGURED');
 const key=imageCapabilityKey(app.settings,app.status,app.revision);assert.ok(!key.includes(secret)&&!key.includes('sk-'),key);
 assert.equal(render(),false,'re-rendering with the same revision does not re-read');
 assert.deepEqual(service.calls.filter(c=>c.includes('/v1/images')),[]);
});

test('capability loader publishes only the newest read and reports failures without dropping the key',async()=>{
 const holds:Array<(v:any)=>void>=[];const published:CapabilityState[]=[];
 const loader=capabilityLoader(()=>new Promise(resolve=>holds.push(resolve)),s=>published.push(s));
 loader.sync('a');loader.sync('b');holds[1]({images:{available:true}});holds[0]({images:{available:false}});await flush();
 assert.deepEqual(published,[{caps:{images:{available:true}},error:''}] as CapabilityState[],'the stale read is ignored');
 loader.close();assert.equal(loader.sync('b'),true,'a closed loader reads again when remounted');
 const failing=capabilityLoader(async()=>{throw Error('offline');},s=>published.push(s));failing.sync('x');await flush();
 const last=published[published.length-1];assert.equal(imageAvailability(last.caps,last.error).tag,'STATUS UNKNOWN');
});

test('availability explains local-follow and disabled modes and labels OpenAI images with local reasoning',()=>{
 const reason='Images need a configured image provider. Local mode will not spend OpenAI credits. Explicitly select the OpenAI image provider to allow cloud images with local reasoning.';
 const follow=imageAvailability({images:{available:false,mode:'follow',reason},reasoning:{provider:'local'}});
 assert.equal(follow.ready,false);assert.equal(follow.tag,'LOCAL ONLY');assert.equal(follow.message,reason);
 const disabled=imageAvailability({images:{available:false,mode:'disabled',reason:'Image generation and editing are disabled in Settings.'},reasoning:{provider:'openai'}});
 assert.equal(disabled.ready,false);assert.equal(disabled.tag,'IMAGES OFF');assert.match(disabled.message,/disabled/);
 const mixed=imageAvailability({images:{available:true,mode:'openai',reason:''},reasoning:{provider:'local'}});
 assert.equal(mixed.ready,true);assert.equal(mixed.tag,'OPENAI IMAGES · LOCAL REASONING');assert.match(mixed.message,/metered credits/);
 const cloud=imageAvailability({images:{available:true,mode:'follow',reason:''},reasoning:{provider:'openai'}});
 assert.equal(cloud.ready,true);assert.match(cloud.message,/not test-generated/);
 assert.equal(imageAvailability(undefined).ready,false);
 const failed=imageAvailability(undefined,'Request failed');assert.equal(failed.ready,false);assert.match(failed.message,/Nothing is sent/);
});

test('export names keep the attachment id, a readable slug and the stored format',()=>{
 assert.equal(exportFileName({id:'abc-123',mime:'image/png',prompt:'A Neon Fox!'}),'Capri-a-neon-fox-abc-123.png');
 assert.equal(exportFileName({id:'../x',mime:'image/jpeg'}),'Capri-x.jpg');
 assert.equal(exportFileName({id:'w',mime:'image/webp',prompt:'Imported image'}),'Capri-imported-image-w.webp');
});

test('rendering the studio and provider settings issues no image request and shows the explicit image policy',()=>{
 const calls:string[]=[];const request=async(route:string,method='GET')=>{calls.push(method+' '+route);return method==='GET'&&route==='/v1/attachments'?[]:{};};
 const draft={...emptyStudioDraft,brief:{subject:'a fox',style:'',composition:''},prompt:'A fox.'};
 const run:StudioRun=createStudioRun();
 const studio=renderToStaticMarkup(React.createElement(CreativeStudio,{draft,setDraft:()=>{},run,capabilityKey:'k',request,loadUrl:async()=>''}));
 assert.match(studio,/aria-label="Subject"/);assert.match(studio,/aria-label="Composition \/ use"/);assert.match(studio,/A fox\./);
 assert.match(studio,/CHECKING/);assert.match(studio,/<button type="button" class="primary" disabled="">/,'create stays disabled until availability is known');
 assert.match(studio,/Nothing is generated until you click/);
 const pending=renderToStaticMarkup(React.createElement(CreativeStudio,{draft:{...draft,outcome:{kind:'pending',request:{prompt:'A fox.'},generation:1},lastRequest:{prompt:'A fox.'}},setDraft:()=>{},run,capabilityKey:'k',request,loadUrl:async()=>''}));
 assert.match(pending,/Creating… this can take up to a minute/);assert.match(pending,/New variant/);
 const settings=renderToStaticMarkup(React.createElement(ProviderSettings,{status:{routing:{active:'local'},budget:{spent:0}},settings:{...defaults,imageProviderMode:'openai'},save:async()=>{},run:async()=>{}}));
 assert.match(settings,/aria-label="Image provider"/);assert.match(settings,/<option value="openai" selected="">/);
 assert.ok(!calls.some(c=>c.includes('/v1/images')),'no image request during render: '+calls.join(', '));
 assert.deepEqual(run,{generation:0,pending:0},'rendering claims no submission');
});
