import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, Download, RotateCcw, ImagePlus, X, SlidersHorizontal } from 'lucide-react';
import { api, imageUrl } from './api';
import { beginSubmission, capabilityLoader, exportFileName, galleryNeedsReload, imageAvailability, importReference, referenceSendable, referenceStatus, runImageRequest, studioActionLabel, studioStep, type CapabilityState, type ImageAvailability, type ImageRequest, type StudioDraft, type StudioEvent, type StudioRun } from './creative-brief';

type Request = (route:string,method?:string,body?:any)=>Promise<any>;
type Image = {id:string;mime?:string;prompt?:string;url:string};

/** Reads GET /v1/capabilities (configuration only, never a paid call) whenever `key` changes. */
export function useImageCapabilities(request:Request,key:string){
 const [state,setState]=useState<CapabilityState>({error:''});
 useEffect(()=>{const loader=capabilityLoader(request,setState);loader.sync(key);return loader.close;},[request,key]);
 return imageAvailability(state.caps,state.error);
}

export function ImageAvailabilityNote({availability,onSettings}:{availability:ImageAvailability;onSettings?:()=>void}){
 return <div className={'image-availability '+availability.tone} role="status"><span className={'tag '+availability.tone}>{availability.tag}</span><p className="small muted">{availability.message}</p>{!availability.ready&&onSettings&&<button type="button" className="secondary" onClick={onSettings}><SlidersHorizontal size={13}/> Image settings</button>}</div>;
}

function OutcomeLine({draft}:{draft:StudioDraft}){
 const o=draft.outcome;
 if(o.kind==='pending')return <p className="studio-outcome pending" role="status" aria-live="polite"><i/>{o.request.attachmentId?'Editing the reference':'Creating'}… this can take up to a minute. Your brief stays here.</p>;
 if(o.kind==='created')return <p className="studio-outcome created" role="status">Image created and saved to your gallery.</p>;
 if(o.kind==='rejected')return <p className="studio-outcome rejected" role="alert">Not created: {o.message} Your brief is unchanged and nothing was retried.</p>;
 if(o.kind==='unconfirmed')return <p className="studio-outcome unconfirmed" role="alert">Result unconfirmed: {o.message} The request may have reached the provider. Check the gallery before running again; nothing is retried automatically.</p>;
 return null;
}

export function CreativeStudio({draft,setDraft,run,capabilityKey,notify,openSettings,request=api,loadUrl=imageUrl}:{draft:StudioDraft;setDraft:React.Dispatch<React.SetStateAction<StudioDraft>>;run:StudioRun;capabilityKey:string;notify?:(message:string)=>void;openSettings?:()=>void;request?:Request;loadUrl?:(id:string)=>Promise<string>}){
 const [images,setImages]=useState<Image[]>([]);const [loaded,setLoaded]=useState(false);const [notice,setNotice]=useState('');const [importing,setImporting]=useState(false);
 const [gallery,setGallery]=useState<{loading:boolean;error:string;checked?:string}>({loading:true,error:''});
 const availability=useImageCapabilities(request,capabilityKey+'|'+draft.outcome.kind);
 const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const loads=useRef(0);const imageIds=useRef<string[]>([]);const referenceId=useRef(draft.referenceId);referenceId.current=draft.referenceId;
 async function reload(){
  const load=++loads.current;const checked=referenceId.current;const current=()=>mounted.current&&load===loads.current;
  setGallery(g=>({...g,loading:true,error:''}));
  try{const rows=await request('/v1/attachments');const next:Image[]=await Promise.all(rows.map(async(a:any)=>({...a,url:await loadUrl(a.id)})));if(current()){imageIds.current=next.map(i=>i.id);setImages(next);setLoaded(true);setGallery({loading:false,error:'',checked});}}
  catch(e:any){if(current())setGallery({loading:false,error:String(e?.message||e),checked});}
 }
 // Reloads on mount, whenever a request settles, and when the draft names a
 // reference this gallery has not resolved, even one chosen by an earlier page.
 const revision=useRef<number|undefined>(undefined);
 useEffect(()=>{const previous=revision.current;revision.current=draft.revision;if(galleryNeedsReload(previous,draft.revision,draft.referenceId,imageIds.current))void reload();},[draft.revision,draft.referenceId]);
 async function submit(req:ImageRequest,generation:number){
  const {outcome,current}=await runImageRequest(req,generation,{run,request,settle:(outcome,generation)=>setDraft(d=>studioStep(d,{type:'settled',outcome,generation}).draft)});
  if(current&&outcome.kind==='created')notify?.('Image created');
 }
 // Spending happens only here, from an explicit click that studioStep accepts.
 function dispatch(event:Exclude<StudioEvent,{type:'generate'|'variant'}>|{type:'generate';ready:boolean}|{type:'variant';ready:boolean}){
  if(event.type==='generate'||event.type==='variant'){const step=beginSubmission(run,draft,event);if(!step.request)return;setDraft(step.draft);void submit(step.request,step.generation);return;}
  setDraft(d=>studioStep(d,event).draft);
 }
 async function importImage(file:File){
  setNotice('');setImporting(true);
  try{if(file.size>6*1024*1024)throw Error('Choose an image under 6 MB.');const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});await importReference({base64:data,mime:file.type},{request,setDraft});}
  catch(e:any){setNotice(e.message);}finally{setImporting(false);}
 }
 const pending=draft.outcome.kind==='pending';const ready=availability.ready&&loaded;
 const reference=images.find(i=>i.id===draft.referenceId);const referenceState=referenceStatus(draft.referenceId,{...gallery,ids:images.map(i=>i.id)});
 const canCreate=ready&&referenceSendable(referenceState);const clearReference=<button type="button" className="icon-button" title="Clear reference" aria-label="Clear reference" onClick={()=>dispatch({type:'reference',id:''})}><X size={14}/></button>;const selected=images.find(i=>i.id===draft.selectedId)||images[images.length-1];
 const field=(key:'subject'|'style'|'composition',label:string,placeholder:string)=><label>{label}<input aria-label={label} value={draft.brief[key]} placeholder={placeholder} onChange={e=>dispatch({type:'brief',patch:{[key]:e.target.value}})}/></label>;
 return <section className="card section-card creative-studio"><div className="card-heading"><h2>From imagination to image</h2><span className="tag">METERED AI</span></div>
  <ImageAvailabilityNote availability={availability} onSettings={openSettings}/>
  {notice&&<p className="studio-outcome rejected" role="alert">{notice}</p>}
  {gallery.error&&<p className="studio-outcome rejected" role="alert">Your gallery could not be loaded: {gallery.error} <button type="button" className="text-link" onClick={()=>void reload()}><RotateCcw size={12}/> Retry</button></p>}
  <div className="studio-layout"><div className="studio-brief">
   <span className="eyebrow">BRIEF</span>
   {field('subject','Subject','A rooftop garden above a neon city')}{field('style','Style','Rain-soaked, soft pink light, anime cel shading')}{field('composition','Composition / use','Wide shot for a desktop wallpaper')}
   <label>Prompt<textarea aria-label="Image prompt" value={draft.prompt} onChange={e=>dispatch({type:'prompt',text:e.target.value})} placeholder="Fill in the brief, or write the full prompt yourself…"/></label>
   <div className="studio-prompt-meta small muted"><span>{draft.promptEdited?'Edited by you':'Built from the brief'} · {draft.prompt.length}/8000</span>{draft.promptEdited&&<button type="button" className="text-link" onClick={()=>dispatch({type:'rebuild'})}><RotateCcw size={12}/> Rebuild from brief</button>}</div>
   <div className="studio-reference">{reference?<><img src={reference.url} alt=""/><span className="small">Reference for edits<br/><span className="muted">Sent to OpenAI with the prompt when you click.</span></span>{clearReference}</>
    :referenceState.kind==='loading'?<><span className="small muted" role="status">Loading the chosen reference… Create stays off until it appears.</span>{clearReference}</>
    :referenceState.kind==='unavailable'?<><span className="small" role="alert">Reference unavailable: {referenceState.message} Nothing is sent while it is chosen.</span>{clearReference}</>
    :<span className="small muted">No reference — a new image is created. Pick one from the gallery to edit it.</span>}<label className="secondary file-label"><ImagePlus size={14}/> {importing?'Importing…':'Import reference'}<input hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={importing} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void importImage(file);}}/></label></div>
   <div className="button-row"><button type="button" className="primary" disabled={!canCreate||pending||!draft.prompt.trim()} onClick={()=>dispatch({type:'generate',ready:canCreate})}><Sparkles size={16}/>{studioActionLabel(pending,referenceState)}</button>{draft.lastRequest&&<button type="button" className="secondary" disabled={!ready||pending} title="Runs the last request again for a new variant" onClick={()=>dispatch({type:'variant',ready})}><RotateCcw size={14}/> New variant</button>}</div>
   <OutcomeLine draft={draft}/>
   <p className="small muted">Nothing is generated until you click. Each image reserves $1 against your application budget; usage is estimated conservatively.</p>
  </div>
  <figure className="studio-preview">{selected?<><img src={selected.url} alt={selected.prompt||'Selected image'}/><figcaption><span>{selected.prompt}</span><span className="studio-preview-actions"><button type="button" className="secondary" onClick={()=>dispatch({type:'reference',id:selected.id})}>{selected.id===draft.referenceId?'Reference ✓':'Use as reference'}</button><a className="primary studio-download" href={selected.url} download={exportFileName(selected)}><Download size={14}/> Download</a></span></figcaption></>:<div className="empty-small"><Sparkles size={30}/><h3>Your next idea belongs here.</h3><p>{loaded?'Created images appear here for preview and download.':'Loading your gallery…'}</p></div>}</figure></div>
  {images.length>0&&<div className="image-grid">{images.slice().reverse().map(a=><figure key={a.id} className={a.id===selected?.id?'selected':''}><button type="button" className="studio-thumb" aria-label="Preview image" onClick={()=>dispatch({type:'select',id:a.id})}><img src={a.url} alt={a.prompt}/></button><figcaption><button type="button" className="text-link" onClick={()=>dispatch({type:'reference',id:a.id===draft.referenceId?'':a.id})}>{a.id===draft.referenceId?'REFERENCE ✓':'Use as reference'}</button>{a.prompt}<a href={a.url} download={exportFileName(a)} title="Download image"><Download size={16}/></a></figcaption></figure>)}</div>}
 </section>;
}
