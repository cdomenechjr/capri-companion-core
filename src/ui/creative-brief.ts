import type { ImageProviderMode } from '../shared';
// Pure Image Studio state. Only explicit generate/variant events produce an
// image request; every other change edits the draft without spending.
export type CreativeBrief = {subject:string;style:string;composition:string};
export type ImageRequest = {prompt:string;attachmentId?:string};
export type StudioOutcome =
 |{kind:'idle'}
 |{kind:'pending';request:ImageRequest;generation:number}
 |{kind:'created';attachmentId:string}
 |{kind:'rejected';message:string}
 |{kind:'unconfirmed';message:string};
// `revision` advances whenever a request settles so any mounted gallery,
// including one opened after navigating away mid-request, reloads.
export type StudioDraft = {brief:CreativeBrief;prompt:string;promptEdited:boolean;referenceId:string;selectedId:string;outcome:StudioOutcome;lastRequest?:ImageRequest;revision:number};
export type StudioEvent =
 |{type:'brief';patch:Partial<CreativeBrief>}
 |{type:'prompt';text:string}
 |{type:'rebuild'}
 |{type:'reference';id:string}
 |{type:'select';id:string}
 |{type:'generate';ready:boolean;generation:number}
 |{type:'variant';ready:boolean;generation:number}
 |{type:'settled';outcome:StudioOutcome;generation:number}
 |{type:'cancel'};
// Parent-owned submission identity. It outlives Studio page mounts so Stop and
// late replies are resolved against the current submission, not a stale page.
export type StudioRun = {generation:number;pending:number};
export const createStudioRun=():StudioRun=>({generation:0,pending:0});
export const STOPPED_MESSAGE = 'Stopped before Capri replied. The service was asked to cancel it.';
export const emptyStudioDraft:StudioDraft = {brief:{subject:'',style:'',composition:''},prompt:'',promptEdited:false,referenceId:'',selectedId:'',outcome:{kind:'idle'},revision:0};
export const PROMPT_LIMIT = 8000;

const clean=(text:string)=>text.replace(/\s+/g,' ').trim().replace(/[\s.]+$/,'');
export function composePrompt(brief:CreativeBrief){
 const subject=clean(brief.subject),style=clean(brief.style),composition=clean(brief.composition);const parts:string[]=[];
 if(subject)parts.push(subject[0].toUpperCase()+subject.slice(1)+'.');
 if(style)parts.push('Style: '+style+'.');
 if(composition)parts.push('Composition and use: '+composition+'.');
 return parts.join(' ').slice(0,PROMPT_LIMIT);
}

export function studioStep(draft:StudioDraft,event:StudioEvent):{draft:StudioDraft;request?:ImageRequest}{
 switch(event.type){
  case 'brief':{const brief={...draft.brief,...event.patch};return {draft:{...draft,brief,prompt:draft.promptEdited?draft.prompt:composePrompt(brief)}};}
  case 'prompt':return {draft:{...draft,prompt:event.text.slice(0,PROMPT_LIMIT),promptEdited:true}};
  case 'rebuild':return {draft:{...draft,prompt:composePrompt(draft.brief),promptEdited:false}};
  case 'reference':return {draft:{...draft,referenceId:event.id}};
  case 'select':return {draft:{...draft,selectedId:event.id}};
  case 'generate':case 'variant':{
   if(!event.ready||draft.outcome.kind==='pending')return {draft};
   const request=event.type==='variant'?draft.lastRequest:draft.prompt.trim()?{prompt:draft.prompt.trim(),...(draft.referenceId?{attachmentId:draft.referenceId}:{})}:undefined;
   if(!request)return {draft};
   return {draft:{...draft,lastRequest:request,outcome:{kind:'pending',request,generation:event.generation}},request};
  }
  // A reply for anything but the current pending submission (stopped, or
  // superseded) only refreshes the gallery; it never changes the outcome.
  case 'settled':{
   const current=draft.outcome.kind==='pending'&&draft.outcome.generation===event.generation;
   if(!current)return {draft:{...draft,revision:draft.revision+1}};
   return {draft:{...draft,outcome:event.outcome,selectedId:event.outcome.kind==='created'?event.outcome.attachmentId:draft.selectedId,revision:draft.revision+1}};
  }
  case 'cancel':return draft.outcome.kind==='pending'?{draft:{...draft,outcome:{kind:'unconfirmed',message:STOPPED_MESSAGE}}}:{draft};
 }
}

// Only a service receipt carrying the new attachment id establishes creation.
// Gallery contents never do: a same-prompt item may be an import or another
// request. The renderer transport strips HTTP status and error types, and the
// service forwards provider messages verbatim, so no thrown message proves the
// request stopped before dispatch: every thrown error stays unconfirmed.
export function settleOutcome(result:any,error:unknown):StudioOutcome{
 if(typeof result?.attachmentId==='string'&&result.attachmentId)return {kind:'created',attachmentId:result.attachmentId};
 if(error===undefined)return {kind:'unconfirmed',message:'Capri returned no image receipt.'};
 const raw=error instanceof Error?error.message:String(error||'');
 const message=raw.replace(/^Error invoking remote method '[^']*':\s*/,'').replace(/^(?:(?:Type)?Error:\s*)+/,'').trim();
 return {kind:'unconfirmed',message:message||'The connection ended before Capri replied.'};
}

type Request = (route:string,method?:string,body?:any)=>Promise<any>;
// Accepts an explicit click: claims a new generation and returns the request to
// send, or nothing when the click is refused or another submission is in flight.
export function beginSubmission(run:StudioRun,draft:StudioDraft,event:{type:'generate'|'variant';ready:boolean}):{draft:StudioDraft;request?:ImageRequest;generation:number}{
 if(run.pending)return {draft,generation:run.generation};
 const generation=run.generation+1;const step=studioStep(draft,{...event,generation});
 if(step.request){run.generation=generation;run.pending=generation;}
 return {...step,generation};
}
// Stop invalidates the current submission at once, wherever Studio is mounted.
export function cancelSubmission(run:StudioRun,setDraft:(update:(draft:StudioDraft)=>StudioDraft)=>void){run.generation++;run.pending=0;setDraft(d=>studioStep(d,{type:'cancel'}).draft);}
// Runs one accepted request. The POST is issued synchronously, with no awaited
// preflight, after confirming the submission is still current. It holds no
// component state, so the reply reaches the parent draft after navigation.
// Returns whether the reply settled the current submission.
export async function runImageRequest(req:ImageRequest,generation:number,{run,request,settle}:{run:StudioRun;request:Request;settle:(outcome:StudioOutcome,generation:number)=>void}){
 if(run.generation!==generation)return {outcome:{kind:'unconfirmed',message:STOPPED_MESSAGE} as StudioOutcome,current:false,sent:false};
 let result:any,error:unknown;
 try{result=await request('/v1/images','POST',req);}catch(e){error=e;}
 const outcome=settleOutcome(result,error);const current=run.generation===generation;
 if(current)run.pending=0;
 settle(outcome,generation);return {outcome,current,sent:true};
}

// The chosen reference is sent only once the current gallery has resolved it.
// `checked` is the reference id that was current when the latest load began.
export type GalleryLoad = {ids:string[];loading:boolean;error:string;checked?:string};
export type ReferenceStatus = {kind:'none'|'resolved'|'loading'}|{kind:'unavailable';message:string};
export function referenceStatus(referenceId:string,gallery:GalleryLoad):ReferenceStatus{
 if(!referenceId)return {kind:'none'};
 if(gallery.ids.includes(referenceId))return {kind:'resolved'};
 if(gallery.loading||gallery.checked!==referenceId)return {kind:'loading'};
 if(gallery.error)return {kind:'unavailable',message:'The gallery could not be loaded: '+gallery.error};
 return {kind:'unavailable',message:'This reference is no longer in your gallery. Clear it or pick another.'};
}
export const referenceSendable=(status:ReferenceStatus)=>status.kind==='none'||status.kind==='resolved';
export const studioActionLabel=(pending:boolean,status:ReferenceStatus)=>pending?'Creating…':status.kind==='resolved'?'Edit reference':status.kind==='none'?'Create image':'Waiting for reference';
// A mounted gallery reloads when a request settles, and when the parent draft
// names a reference it has not resolved (e.g. an import finished elsewhere).
export const galleryNeedsReload=(previousRevision:number|undefined,revision:number,referenceId:string,ids:string[])=>previousRevision!==revision||(!!referenceId&&!ids.includes(referenceId));
// Stores an imported image and selects it in the parent-owned draft, so it
// completes correctly even if the Studio page that started it has unmounted.
export async function importReference(body:{base64:string;mime:string},{request,setDraft}:{request:Request;setDraft:(update:(draft:StudioDraft)=>StudioDraft)=>void}){
 const row=await request('/v1/attachments','POST',body);
 if(typeof row?.id!=='string'||!row.id)throw Error('Capri returned no attachment for the import.');
 setDraft(d=>studioStep(d,{type:'reference',id:row.id}).draft);return row.id as string;
}

export type ImageCapabilities ={images?:{available:boolean;reason?:string;mode?:ImageProviderMode;provider?:string;model?:string};reasoning?:{provider?:string}};
// Every confirmed setting or status that can change image availability. A
// change re-reads GET /v1/capabilities, e.g. after raising the monthly budget.
// `revision` counts confirmed service refreshes (a key saved or replaced, a
// connection checked or recovered); it carries no key or key-derived value, and
// covers recoveries such as a cleared image block that leave every scalar alone.
export function imageCapabilityKey(settings:any,status:any,revision=0){
 return [settings?.imageProviderMode,settings?.providerMode,settings?.imageModel,settings?.monthlyBudget,status?.routing?.active,status?.providerConfigured,status?.budget?.spent,status?.budget?.limit,revision].join('|');
}
// Reads GET /v1/capabilities (configuration only, never a paid call) each time
// the key changes; only the newest read is published. A failed read keeps the
// last answer but reports the error, so nothing is sent until it is known.
export type CapabilityState = {caps?:ImageCapabilities;error:string};
export function capabilityLoader(request:Request,publish:(state:CapabilityState)=>void){
 let key:string|undefined,load=0,state:CapabilityState={error:''};
 return {
  sync(next:string){
   if(next===key)return false;key=next;const id=++load;
   request('/v1/capabilities').then(caps=>{if(id===load)publish(state={caps,error:''});},(e:any)=>{if(id===load)publish(state={...state,error:String(e?.message||e)});});
   return true;
  },
  close(){load++;key=undefined;},
 };
}
export type ImageAvailability ={ready:boolean;tag:string;tone:'green'|'warn'|'';message:string};
export function imageAvailability(caps:ImageCapabilities|undefined,error=''):ImageAvailability{
 if(error)return {ready:false,tag:'STATUS UNKNOWN',tone:'',message:'Image availability could not be checked: '+error+' Nothing is sent until it can be.'};
 const images=caps?.images;if(!images)return {ready:false,tag:'CHECKING',tone:'',message:'Checking image availability…'};
 const mode=images.mode??'follow';const localReasoning=caps?.reasoning?.provider==='local';
 if(mode==='disabled')return {ready:false,tag:'IMAGES OFF',tone:'',message:'Image generation is disabled. Choose an image provider in Settings to turn it on.'};
 if(!images.available)return {ready:false,tag:mode==='follow'&&localReasoning?'LOCAL ONLY':'UNAVAILABLE',tone:'',message:images.reason||'Image generation is unavailable.'};
 if(mode==='openai'&&localReasoning)return {ready:true,tag:'OPENAI IMAGES · LOCAL REASONING',tone:'warn',message:'Conversation stays on your PC, but images you request are sent to OpenAI and use metered credits.'};
 return {ready:true,tag:'OPENAI IMAGES CONFIGURED',tone:'green',message:'Configured, not test-generated. Each click reserves $1 of your application budget.'};
}

export function exportFileName(image:{id:string;mime?:string;prompt?:string}){
 const ext=image.mime==='image/jpeg'?'jpg':image.mime==='image/webp'?'webp':'png';
 const slug=(image.prompt||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40).replace(/-+$/,'');
 return 'Capri-'+(slug?slug+'-':'')+image.id.replace(/[^A-Za-z0-9_-]/g,'').slice(0,40)+'.'+ext;
}
