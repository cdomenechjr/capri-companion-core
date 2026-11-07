import React,{useEffect,useReducer,useRef,useState} from 'react';
import {z} from 'zod';
import {defaultExtensionSettings,type CodexConnection,type DeliveryReceipt,type ExtensionSettings as ExtensionSettingsRecord,type ExtensionStatus,type FeatureCapability} from '../extensions/contracts';
import {
  agentJobBadge,capabilityBadge,contactReviewKey,createActionRunner,createContactReviewController,createSkillsSession,cursorBadge,defaultExtensionRequest,deliveryBadge,displayTaskId,displayText,
  emptyTeachForm,extensionRoutes,missingEpochMessage,privateFlowsAllowed,readCodexConnection,readExtensionSettings,readExtensionStatus,readKey,readOverview,resultTone,scopeKey,
  scopedRunner,securityJobBadge,securityOperationLabel,updatesBadge,uiActionSchemas,
  type ActionRunner,type AgentsOverviewSchema,type Badge,type ContactReview,type ContactReviewController,type ContactsOverviewSchema,type ExtensionRequest,type PrivacyEpoch,type ReadView,
  type SecurityOverviewSchema,type SkillCatalogEntry,type SkillCatalogSchema,type SkillsSession,type TeachForm,type UiAction,type UiActionInput,
} from './extensions-api';
export {emptyTeachForm,type TeachForm};

/*
 * 0.7 extension controls. Rendering and navigation never call the service: every read and action starts
 * from a click. Pass one runner from main.tsx so pending receipts survive page changes.
 */
type Overviews={security:ReadView<z.infer<typeof SecurityOverviewSchema>>;contacts:ReadView<z.infer<typeof ContactsOverviewSchema>>;agents:ReadView<z.infer<typeof AgentsOverviewSchema>>};
export interface ExtensionSettingsProps {
  request?:ExtensionRequest;
  runner?:ActionRunner;
  /** Server-owned private-session state from main.tsx, never model input. */
  privateSession?:boolean;
  /** The main renderer's trusted privacy epoch; changes on every private boundary, Stop and close. Required for private review flows. */
  privacyEpoch?:PrivacyEpoch;
  chooseFolder?:()=>Promise<string|null>;
  clock?:()=>number;
  initial?:{status?:ReadView<ExtensionStatus>;settings?:ReadView<ExtensionSettingsRecord>;overviews?:Partial<Overviews>;codexConnection?:ReadView<CodexConnection>};
}
export interface ExtensionContext {
  status:ReadView<ExtensionStatus>;settings:ReadView<ExtensionSettingsRecord>;privateSession:boolean;privacyEpoch?:PrivacyEpoch;now:number;runner:ActionRunner;request:ExtensionRequest;
  /**
   * The settings view was read after the latest settings write and no settings write is unsettled. Writes that carry
   * sibling values need it, so a default or stale value never overwrites a saved one (for example an update disable).
   */
  settingsConfirmed:boolean;
  act:<A extends UiAction>(action:A,input:UiActionInput<A>,options?:{slot?:string;taskId?:string})=>void;
}

function useRunner(props:{runner?:ActionRunner;request?:ExtensionRequest}):ActionRunner {
  const ref=useRef<ActionRunner|null>(null);ref.current??=props.runner??createActionRunner({request:props.request});
  const [,changed]=useReducer((n:number)=>n+1,0);
  useEffect(()=>ref.current!.subscribe(changed),[]);
  return ref.current;
}
/**
 * Newest-wins read started only by a click, with one outstanding transport call per key across remounts (the
 * runner's read gate). When the privacy fence changes the view is discarded during render (before anything paints)
 * and reads started under the old fence are ignored when they settle. Returns [view, reload, busy].
 */
function useRead<T>(runner:ActionRunner,key:string,initial:ReadView<T>|undefined,load:()=>Promise<ReadView<T>>,fence=''):[ReadView<T>,()=>Promise<void>,boolean] {
  const [state,setState]=useState<{fence:string;view:ReadView<T>}>({fence,view:initial??{kind:'unchecked'}});
  const generation=useRef(0);const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;generation.current++;};},[]);
  let view=state.view;
  if(state.fence!==fence){generation.current++;view={kind:'unchecked'};setState({fence,view});}
  const reload=async()=>{
    if(runner.reads.busy(key))return;
    const mine=++generation.current;setState(s=>({fence,view:s.fence===fence&&s.view.kind==='ready'?s.view:{kind:'loading'}}));
    const next=await load();if(mounted.current&&mine===generation.current)setState({fence,view:next});};
  return [view,reload,view.kind==='loading'||runner.reads.busy(key)];
}
const statusOf=(view:ReadView<ExtensionStatus>)=>view.kind==='ready'?view.data:undefined;
/** Last observed settings, or nothing. Never defaults: a default must not be written back as if it were saved. */
const settingsOf=(view:ReadView<ExtensionSettingsRecord>)=>view.kind==='ready'?view.data:undefined;
type SettingsMark={writes:number;clean:boolean};
/**
 * A settings write that carries sibling values: the confirmed saved values of `keys` with `patch` applied, or nothing
 * when the saved values are missing or not confirmed current. Defaults are never substituted.
 */
export function confirmedWrite<T extends object,K extends keyof T>(saved:T|undefined,confirmed:boolean,keys:readonly K[],patch:Partial<Pick<T,K>>):Pick<T,K>|undefined {
  if(!saved||!confirmed)return undefined;
  const out={} as Pick<T,K>;for(const k of keys)out[k]=(k in patch?patch[k]:saved[k]) as T[K];return out;
}
const settingsKey=readKey(extensionRoutes.settings);
/** New dispatch only when the service reports the action ready. Recovery controls do not use this gate. */
export const actionReady=(capability:FeatureCapability|undefined,action:string)=>!!capability?.available&&capability.actions.includes(action);
const serviceMissing=(view:ReadView<unknown>)=>view.kind==='unsupported';

export function BadgeTag({badge}:{badge:Badge}){return <span className={'tag'+(badge.tone?' '+badge.tone:'')} title={badge.text}>{badge.tag}</span>;}
function BadgeLine({badge}:{badge:Badge}){return <div className={'ext-badge-line '+badge.tone}><BadgeTag badge={badge}/><p className="small">{badge.text}</p></div>;}
export function ActionNote({runner,slot}:{runner:ActionRunner;slot:string}){
  const view=runner.outcome(slot);if(!view)return null;
  return <p className={'ext-outcome '+view.state+' '+resultTone(view.state)} role={view.state==='rejected'||view.state==='invalid'?'alert':'status'}>{view.state==='pending'&&<i aria-hidden="true"/>}{view.message}</p>;
}
function ReadNote({view,what}:{view:ReadView<unknown>;what:string}){
  if(view.kind==='unchecked')return <p className="small muted">{what} not loaded. Nothing is read until you click.</p>;
  if(view.kind==='loading')return <p className="small muted" role="status">Reading {what.toLowerCase()}…</p>;
  if(view.kind==='unsupported'||view.kind==='error')return <p className="ext-outcome warn" role="status">{view.message}</p>;
  return null;
}
function Toggle({id,label,hint,checked,disabled,onChange}:{id:string;label:string;hint:string;checked:boolean;disabled?:boolean;onChange:(value:boolean)=>void}){
  return <div className="settings-row"><label htmlFor={id}>{label}<small>{hint}</small></label><input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/></div>;
}

export function ExtensionSettings(props:ExtensionSettingsProps){
  const request=props.request??defaultExtensionRequest,clock=props.clock??Date.now;
  const runner=useRunner(props);
  // Contacts and agents hold private content (exact messages, prompts); they are fenced by the trusted privacy scope.
  const fence=scopeKey({epoch:props.privacyEpoch,privateSession:!!props.privateSession});
  const fenceRef=useRef(fence);fenceRef.current=fence;
  const gate={gate:runner.reads};
  const [status,reloadStatus,statusBusy]=useRead(runner,readKey(extensionRoutes.status),props.initial?.status,()=>readExtensionStatus(request,clock,gate));
  // Each settings view remembers whether it was read after the latest settings write with none unsettled.
  const [marks]=useState(()=>{const m=new WeakMap<object,SettingsMark>();
    if(props.initial?.settings)m.set(props.initial.settings,{writes:runner.writeCount(),clean:runner.unsettled('settings')===0});return m;});
  const [settings,reloadSettings]=useRead(runner,settingsKey,props.initial?.settings,()=>{
    const mark={writes:runner.writeCount(),clean:runner.unsettled('settings')===0};
    return readExtensionSettings(request,clock,gate).then(view=>{marks.set(view,mark);return view;});});
  const mark=marks.get(settings);
  const settingsConfirmed=settings.kind==='ready'&&!!mark?.clean&&mark.writes===runner.writeCount()&&runner.unsettled('settings')===0&&!runner.reads.open(settingsKey);
  const [security,reloadSecurity,securityBusy]=useRead(runner,readKey(extensionRoutes.overview.security),props.initial?.overviews?.security,()=>readOverview(request,'security',clock,gate));
  const [contacts,reloadContacts,contactsBusy]=useRead(runner,readKey(extensionRoutes.overview.contacts),props.initial?.overviews?.contacts,()=>readOverview(request,'contacts',clock,gate),fence);
  const [agents,reloadAgents,agentsBusy]=useRead(runner,readKey(extensionRoutes.overview.agents),props.initial?.overviews?.agents,()=>readOverview(request,'agents',clock,gate),fence);
  const refresh=()=>Promise.all([reloadStatus(),reloadSettings()]);
  const after:Partial<Record<string,()=>Promise<void>>>={security:reloadSecurity,contacts:reloadContacts,agents:reloadAgents};
  const actWith=(r:ActionRunner,fenced:boolean):ExtensionContext['act']=>(action,input,options)=>{
    const started=fence,done=r.run(action,input,options);if(!done)return;
    // A receipt is the only success signal; a follow-up read happens only because the user acted, and never across a privacy boundary.
    void done.then(result=>{if((result.state==='completed'||result.state==='queued')&&(!fenced||fenceRef.current===started))void Promise.all([refresh(),after[action.split('/')[0]]?.()]);});
  };
  // A unique namespace per privacy fence: a new fence deletes the old fence's outcomes and fences its late receipts.
  const fencedRunner=scopedRunner(runner,runner.namespace('ext',fence));
  const ctx:ExtensionContext={status,settings,settingsConfirmed,privateSession:!!props.privateSession,privacyEpoch:props.privacyEpoch,now:clock(),runner,request,act:actWith(runner,false)};
  const fenced:ExtensionContext={...ctx,runner:fencedRunner,act:actWith(fencedRunner,true)};
  return <section className="card section-card extension-settings" aria-label="Capri 0.7 extensions">
    <div className="ext-head"><h2>Extensions</h2><button className="secondary" disabled={statusBusy} onClick={()=>void refresh()}>Check status</button></div>
    <ReadNote view={status} what="Status"/>
    {status.kind==='ready'&&<p className="small muted">Status observed {new Date(status.observedAt).toLocaleTimeString()}. Unconfigured providers stay unavailable.</p>}
    {!settingsConfirmed&&settings.kind!=='unsupported'&&<p className="small muted ext-settings-unconfirmed" role="status">Saved settings are not confirmed{runner.unsettled('settings')>0?' while a settings change is unsettled':''}. Check status before changing them; Restore normal cursor stays available.</p>}
    {runner.pendingCount()>0&&<p className="small" role="status">{runner.pendingCount()} request{runner.pendingCount()===1?'':'s'} waiting for receipts.</p>}
    {runner.abandonedCount()>0&&<p className="small" role="status">{runner.abandonedCount()} timed-out request{runner.abandonedCount()===1?' has':'s have'} not settled. Their outcome is unknown; nothing is resent.</p>}
    <CursorControls {...ctx} chooseFolder={props.chooseFolder??(()=>window.capri?.chooseFolder()??Promise.resolve(null))}/>
    <SecurityControls {...ctx} overview={security} load={reloadSecurity} loading={securityBusy}/>
    {/* Keyed by the fence: forms, prompts and exact-message previews are discarded on every privacy boundary. */}
    <ContactsControls key={'contacts:'+fence} {...fenced} overview={contacts} load={reloadContacts} loading={contactsBusy}/>
    <AgentControls key={'agents:'+fence} {...fenced} overview={agents} load={reloadAgents} loading={agentsBusy} initialConnection={props.initial?.codexConnection}/>
    <UpdateControls {...ctx}/>
  </section>;
}

const durations:[number,string][]=[[0,'This session (until disable, Stop or quit)'],[30000,'30 s trial'],[300000,'5 min trial']];
export function CursorControls(ctx:ExtensionContext&{chooseFolder:()=>Promise<string|null>}){
  const current=statusOf(ctx.status),capability=current?.features.cursor,saved=settingsOf(ctx.settings)?.cursor;
  // The draft only seeds the form; enabling or disabling sends it only once the saved settings are confirmed.
  const [draft,setDraft]=useState(saved??defaultExtensionSettings().cursor);useEffect(()=>{if(saved)setDraft(saved);},[ctx.settings]);
  const missing=serviceMissing(ctx.status),busy=(slot:string)=>ctx.runner.busy(slot),write=!missing&&ctx.settingsConfirmed;
  const configure=(enabled:boolean)=>{const input=confirmedWrite(saved,ctx.settingsConfirmed,['enabled','durationMs','watchdogLeaseMs','intensity'],{enabled,durationMs:draft.durationMs,intensity:draft.intensity});
    if(input)ctx.act('cursor/configure',input);};
  const choose=async()=>{const folder=await ctx.chooseFolder();if(folder)ctx.act('cursor/import',{folder});};
  return <div className="ext-section"><h3>Animated cursor</h3>
    <BadgeLine badge={capabilityBadge(capability)}/>{current&&<BadgeLine badge={cursorBadge(current.cursor,ctx.now)}/>}
    <p className="small muted">Temporary: Capri never changes your Windows cursor scheme. A recovery watchdog restores the normal cursor if Capri stops renewing it.</p>
    <div className="button-row"><button className="secondary" disabled={missing||busy('cursor/import')} onClick={()=>void choose()}>Import cursor folder…</button></div>
    <p className="small muted">The folder is validated against the pinned pack and copied privately outside the app. The path is not kept in this panel.</p>
    <ActionNote runner={ctx.runner} slot="cursor/import"/>
    <label>Duration<select aria-label="Cursor duration" value={draft.durationMs} onChange={e=>setDraft({...draft,durationMs:Number(e.target.value) as 0})}>{durations.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
    <label>Intensity<input aria-label="Cursor intensity" type="range" min="0" max="1" step="0.1" value={draft.intensity} onChange={e=>setDraft({...draft,intensity:Number(e.target.value)})}/></label>
    <div className="button-row">
      <button className="primary" disabled={!write||busy('cursor/configure')} onClick={()=>configure(true)}>{saved?.enabled?'Save cursor settings':'Enable animated cursor'}</button>
      <button className="secondary" disabled={!write||busy('cursor/configure')||!saved?.enabled} onClick={()=>configure(false)}>Disable</button>
      {/* Recovery stays available even when new cursor changes are not. */}
      <button className="secondary" disabled={missing||busy('cursor/restore')} onClick={()=>ctx.act('cursor/restore',{})}>Restore normal cursor</button>
    </div>
    <ActionNote runner={ctx.runner} slot="cursor/configure"/><ActionNote runner={ctx.runner} slot="cursor/restore"/>
  </div>;
}

export function SecurityControls(ctx:ExtensionContext&{overview:Overviews['security'];load:()=>Promise<void>;loading?:boolean}){
  const capability=statusOf(ctx.status)?.features.security,saved=settingsOf(ctx.settings)?.security,missing=serviceMissing(ctx.status);
  const locked=missing||!saved||!ctx.settingsConfirmed||ctx.runner.busy('security/configure');
  const configure=(patch:{enabled?:boolean;dailyQuickScan?:boolean})=>{const input=confirmedWrite(saved,ctx.settingsConfirmed,['enabled','dailyQuickScan'],patch);if(input)ctx.act('security/configure',input);};
  const [target,setTarget]=useState('');const [confirmFull,setConfirmFull]=useState(false);
  const targetOk=uiActionSchemas['security/custom-scan'].safeParse({target}).success;
  const data=ctx.overview.kind==='ready'?ctx.overview.data:undefined;
  const run=(action:'security/health'|'security/quick-scan'|'security/full-scan'|'security/update-signatures',name:string)=>
    <button className="secondary" disabled={!actionReady(capability,name)||ctx.runner.busy(action)} onClick={()=>ctx.act(action,{})}>{securityOperationLabel[name==='health'?'status':name as 'quick-scan']}</button>;
  return <div className="ext-section"><h3>Microsoft Defender</h3>
    <BadgeLine badge={capabilityBadge(capability)}/>
    <p className="small muted">Uses Defender's own scans and evidence. Capri never disables protection, adds exclusions or changes security settings.</p>
    <Toggle id="ext-security-enabled" label="Security tools" hint="Show Defender health and allow scans you start." checked={!!saved?.enabled} disabled={locked} onChange={enabled=>configure({enabled})}/>
    <Toggle id="ext-security-daily" label="Daily quick scan" hint="09:00 local time, deferred while you are active or gaming. Development and self-test profiles never scan automatically." checked={!!saved?.enabled&&!!saved.dailyQuickScan} disabled={locked||!saved?.enabled} onChange={dailyQuickScan=>configure({dailyQuickScan})}/>
    <ActionNote runner={ctx.runner} slot="security/configure"/>
    <div className="button-row">{run('security/health','health')}{run('security/quick-scan','quick-scan')}{run('security/update-signatures','update-signatures')}
      {!confirmFull&&<button className="secondary" disabled={!actionReady(capability,'full-scan')} onClick={()=>setConfirmFull(true)}>Full scan…</button>}</div>
    {confirmFull&&<div className="ext-confirm" role="group" aria-label="Confirm full scan"><p className="small">A full scan checks every drive and can take hours. It runs only now, never on the schedule.</p>
      <div className="button-row"><button className="primary" disabled={!actionReady(capability,'full-scan')||ctx.runner.busy('security/full-scan')} onClick={()=>{setConfirmFull(false);ctx.act('security/full-scan',{});}}>Start full scan</button><button className="secondary" onClick={()=>setConfirmFull(false)}>Keep it off</button></div></div>}
    <label>Custom scan path<input aria-label="Custom scan path" value={target} placeholder="C:\Folder\Downloads" onChange={e=>setTarget(e.target.value)}/></label>
    {target&&!targetOk&&<p className="small audio-problem">Use an absolute local Windows path such as C:\Folder.</p>}
    <button className="secondary" disabled={!targetOk||!actionReady(capability,'custom-scan')||ctx.runner.busy('security/custom-scan')} onClick={()=>ctx.act('security/custom-scan',{target})}>Scan this path</button>
    {(['security/health','security/quick-scan','security/full-scan','security/custom-scan','security/update-signatures'] as const).map(slot=><ActionNote key={slot} runner={ctx.runner} slot={slot}/>)}
    <div className="ext-head"><h4>Results</h4><button className="text-link" disabled={ctx.loading??ctx.overview.kind==='loading'} onClick={()=>void ctx.load()}>Load results</button></div>
    <ReadNote view={ctx.overview} what="Results"/>
    {data&&data.profile!=='user'&&<p className="small muted">This is a {data.profile} profile: scheduled scans never run here.</p>}
    {data?.schedule&&<p className="small muted">{data.schedule.deferred?'Today\'s quick scan is deferred until you are idle.':data.schedule.nextDueAt?'Next quick scan: '+new Date(data.schedule.nextDueAt).toLocaleString():'No scheduled scan pending.'}</p>}
    {data&&!data.jobs.length&&<p className="small muted">No Defender jobs recorded.</p>}
    {data?.jobs.map(job=>{const badge=securityJobBadge(job);const live=job.state==='pending'||job.state==='running';
      return <div className="ext-row" key={job.id}><div><strong>{securityOperationLabel[job.operation]}</strong> <BadgeTag badge={badge}/><p className="small muted">{badge.text}</p>
        {job.evidence.filter(e=>e.jobId===job.id).slice(-3).map(e=><p className="small" key={e.id}>{new Date(e.observedAt).toLocaleString()} · {displayText(e.summary)}</p>)}</div>
        <div className="button-row"><button className="text-link" disabled={ctx.runner.busy('security/inspect:'+job.id)} onClick={()=>ctx.act('security/inspect',{jobId:job.id},{slot:'security/inspect:'+job.id})}>Inspect</button>
          {live&&<button className="text-link" disabled={ctx.runner.busy('security/cancel:'+job.id)} onClick={()=>ctx.act('security/cancel',{jobId:job.id},{slot:'security/cancel:'+job.id})}>Stop monitoring</button>}</div>
        <ActionNote runner={ctx.runner} slot={'security/inspect:'+job.id}/><ActionNote runner={ctx.runner} slot={'security/cancel:'+job.id}/></div>;})}
  </div>;
}

/** Exact recipient and content for one pending request. Rendered only here; never logged or copied into outcomes. */
export function ContactReviewDetails({review}:{review:ContactReview}){
  const c=review.content;
  return <div className="ext-review" role="group" aria-label="Exact message to approve">
    <p className="small"><span className="muted">To</span> {review.destination} <span className="muted">· {review.channel}{review.contentClass==='private'?' · private content':''}</span></p>
    <p className="small"><span className="muted">From</span> {review.sender} · Review expires {new Date(review.expiresAt).toLocaleTimeString()}</p>
    <p className="small muted">Template {displayText(review.binding.templateId,60)} v{review.binding.templateVersion} · workflow {displayText(review.binding.workflowId,60)} · revision {review.revision}</p>
    {c.kind==='message'?<>{c.subject!==undefined&&<p className="small"><span className="muted">Subject</span> {c.subject}</p>}<pre className="ext-review-body">{c.body}</pre></>
      :<><p className="small muted">Call script · maximum {c.maxVoiceSeconds} seconds</p><pre className="ext-review-body">{c.script}</pre></>}
  </div>;
}
export function ContactsControls(ctx:ExtensionContext&{overview:Overviews['contacts'];load:()=>Promise<void>;loading?:boolean}){
  const capability=statusOf(ctx.status)?.features.contacts,saved=settingsOf(ctx.settings)?.contacts,missing=serviceMissing(ctx.status);
  const locked=missing||!saved||!ctx.settingsConfirmed||ctx.runner.busy('contacts/configure');
  const configure=(patch:{enabled?:boolean;automaticEnabled?:boolean})=>{const input=confirmedWrite(saved,ctx.settingsConfirmed,['enabled','automaticEnabled'],patch);if(input)act('contacts/configure',input);};
  const data=ctx.overview.kind==='ready'?ctx.overview.data:undefined;
  const reviewAllowed=actionReady(capability,'review-details')&&privateFlowsAllowed({epoch:ctx.privacyEpoch,privateSession:ctx.privateSession})&&ctx.privacyEpoch!==undefined;
  const reviewScope={epoch:ctx.privacyEpoch,privateSession:ctx.privateSession,reviewAllowed,approveAllowed:actionReady(capability,'approve')};
  // Exact-review previews: one read at a time, dropped on any refresh start, failure, edit, capability withdrawal or approval click.
  // The shared gate keeps one detail read outstanding across boundaries and remounts, even after its deadline.
  const controllerRef=useRef<ContactReviewController|null>(null);
  if(!controllerRef.current||controllerRef.current.closed())controllerRef.current=createContactReviewController({request:ctx.request,gate:ctx.runner.reads,scope:reviewScope});
  const reviewer=controllerRef.current;
  reviewer.sync(reviewScope);
  const [,reviewChanged]=useReducer((n:number)=>n+1,0);
  useEffect(()=>{if(reviewer.closed()){reviewChanged();return;}const off=reviewer.subscribe(reviewChanged);return ()=>{off();reviewer.close();};},[reviewer]);
  const {reviewing,notes:reviewNotes}=reviewer.snapshot();
  const act:ExtensionContext['act']=(action,input,options)=>{reviewer.invalidate();ctx.act(action,input,options);};
  const load=()=>{reviewer.invalidate();return ctx.load();};
  const [gmail,setGmail]=useState({clientId:'',sender:'',clientSecret:''});
  const [twilio,setTwilio]=useState({accountSid:'',sender:'',authToken:'',voiceEnabled:false});
  const [codes,setCodes]=useState<Record<string,string>>({});
  const [rule,setRule]=useState({routeId:'',workflowId:'',templateId:'',expiresInDays:30});
  const [limit,setLimit]=useState<number|''>('');
  const provider=(channel:string)=>data?.providers.find(p=>p.channel===channel);
  const providerText=(channel:string)=>{const p=provider(channel);if(!p)return 'Not configured. Unavailable.';
    return (p.configured?'Configured':'Not configured')+(p.secretStored?' · secret stored (hidden)':' · no secret stored')+(p.senderHint?' · '+displayText(p.senderHint,80):'')+'. Readiness comes from the status check, not this form.';};
  // Secrets leave component state as soon as they are submitted; they are never echoed or logged.
  const saveGmail=()=>{const {clientSecret,...rest}=gmail;setGmail({...gmail,clientSecret:''});act('contacts/configure-gmail',{...rest,...(clientSecret?{clientSecret}:{})});};
  const saveTwilio=()=>{const {authToken,...rest}=twilio;setTwilio({...twilio,authToken:''});act('contacts/configure-twilio',{...rest,...(authToken?{authToken}:{})});};
  const verified=data?.routes.filter(r=>r.verified&&r.enabled)??[];
  return <div className="ext-section"><h3>Messaging · verified contacts</h3>
    <BadgeLine badge={capabilityBadge(capability)}/>
    {ctx.privateSession&&<p className="ext-outcome warn" role="status">Private session: private content is never sent automatically, and manual private sends need your approval for that exact message.</p>}
    <Toggle id="ext-contacts-enabled" label="Messaging" hint="Off by default. Sends only to verified recipients with exact rules or your approval." checked={!!saved?.enabled} disabled={locked} onChange={enabled=>configure({enabled,automaticEnabled:enabled&&!!saved?.automaticEnabled})}/>
    <Toggle id="ext-contacts-auto" label="Automatic sends" hint="Only to your verified self route or exact recipient/workflow/template rules. Never private content." checked={!!saved?.enabled&&!!saved.automaticEnabled} disabled={locked||!saved?.enabled} onChange={automaticEnabled=>configure({automaticEnabled})}/>
    <ActionNote runner={ctx.runner} slot="contacts/configure"/>
    <div className="ext-head"><h4>Providers</h4><button className="text-link" disabled={ctx.loading??ctx.overview.kind==='loading'} onClick={()=>void load()}>Load messaging details</button></div>
    <ReadNote view={ctx.overview} what="Messaging details"/>
    <div className="ext-form" role="group" aria-label="Gmail"><strong>Gmail</strong><p className="small muted">{providerText('gmail')}</p>
      <input aria-label="Gmail OAuth client ID" autoComplete="off" value={gmail.clientId} onChange={e=>setGmail({...gmail,clientId:e.target.value})} placeholder="OAuth client ID"/>
      <input aria-label="Gmail sender address" autoComplete="off" value={gmail.sender} onChange={e=>setGmail({...gmail,sender:e.target.value})} placeholder="Your Gmail address"/>
      <input aria-label="Gmail client secret" type="password" autoComplete="new-password" value={gmail.clientSecret} onChange={e=>setGmail({...gmail,clientSecret:e.target.value})} placeholder="Write-only · blank keeps the stored secret"/>
      <button className="secondary" disabled={missing||!gmail.clientId||!gmail.sender||ctx.runner.busy('contacts/configure-gmail')} onClick={saveGmail}>Save Gmail configuration</button>
      <ActionNote runner={ctx.runner} slot="contacts/configure-gmail"/></div>
    <div className="ext-form" role="group" aria-label="Twilio"><strong>Twilio SMS · voice · WhatsApp</strong><p className="small muted">{providerText('sms')}</p>
      <input aria-label="Twilio account SID" autoComplete="off" value={twilio.accountSid} onChange={e=>setTwilio({...twilio,accountSid:e.target.value})} placeholder="AC…"/>
      <input aria-label="Twilio sender number" autoComplete="off" value={twilio.sender} onChange={e=>setTwilio({...twilio,sender:e.target.value})} placeholder="+15551234567"/>
      <input aria-label="Twilio auth token" type="password" autoComplete="new-password" value={twilio.authToken} onChange={e=>setTwilio({...twilio,authToken:e.target.value})} placeholder="Write-only · blank keeps the stored token"/>
      <label className="ext-inline"><input type="checkbox" checked={twilio.voiceEnabled} onChange={e=>setTwilio({...twilio,voiceEnabled:e.target.checked})}/> Allow voice calls</label>
      <button className="secondary" disabled={missing||!twilio.accountSid||!twilio.sender||ctx.runner.busy('contacts/configure-twilio')} onClick={saveTwilio}>Save Twilio configuration</button>
      <ActionNote runner={ctx.runner} slot="contacts/configure-twilio"/></div>
    <div className="ext-form" role="group" aria-label="Monthly budget"><strong>Monthly message budget</strong>
      {data?.budget&&<p className="small muted">{data.budget.usedThisMonth===null?'Usage unknown':data.budget.usedThisMonth+' used'} of {data.budget.monthlyMessageLimit} this month.</p>}
      <input aria-label="Monthly message limit" type="number" min="0" max="10000" value={limit} onChange={e=>setLimit(e.target.value===''?'':Math.floor(Number(e.target.value)))}/>
      <button className="secondary" disabled={missing||limit===''||ctx.runner.busy('contacts/budget')} onClick={()=>limit!==''&&act('contacts/budget',{monthlyMessageLimit:limit})}>Save budget</button>
      <ActionNote runner={ctx.runner} slot="contacts/budget"/></div>
    {data&&<><h4>Recipients</h4>{!data.routes.length&&<p className="small muted">No recipients configured.</p>}
      {data.routes.map(route=>{const slot=(a:string)=>a+':'+route.id;return <div className="ext-row" key={route.id}><div><strong>{displayText(route.label,80)}</strong> <span className="small muted">{route.channel}{route.kind==='self'?' · you':''}</span>{' '}
        <BadgeTag badge={route.verified?{tag:'VERIFIED',tone:'green',text:'Identity verified by the provider or your challenge.'}:{tag:'NOT VERIFIED',tone:'warn',text:'Nothing is sent to this recipient until verified.'}}/></div>
        {!route.verified&&<div className="button-row"><button className="text-link" disabled={ctx.runner.busy(slot('contacts/verify-begin'))} onClick={()=>act('contacts/verify-begin',{routeId:route.id},{slot:slot('contacts/verify-begin')})}>Send verification code</button>
          <input aria-label={'Verification code for '+displayText(route.label,80)} inputMode="numeric" autoComplete="one-time-code" value={codes[route.id]??''} onChange={e=>setCodes({...codes,[route.id]:e.target.value.trim()})}/>
          <button className="text-link" disabled={!codes[route.id]||ctx.runner.busy(slot('contacts/verify-complete'))} onClick={()=>{const code=codes[route.id]??'';setCodes({...codes,[route.id]:''});act('contacts/verify-complete',{routeId:route.id,code},{slot:slot('contacts/verify-complete')});}}>Verify</button></div>}
        <ActionNote runner={ctx.runner} slot={slot('contacts/verify-begin')}/><ActionNote runner={ctx.runner} slot={slot('contacts/verify-complete')}/></div>;})}
      <h4>Automatic rules</h4>{!data.rules.length&&<p className="small muted">No rules. Every send needs your approval.</p>}
      {data.rules.map(r=><div className="ext-row" key={r.id}><span className="small">{displayText(data.routes.find(x=>x.id===r.routeId)?.label??'Unknown recipient',80)} · {displayText(r.workflowId,60)} · {displayText(r.templateId,60)} · {r.revoked?'revoked':'until '+new Date(r.expiresAt).toLocaleDateString()}</span>
        {!r.revoked&&<button className="text-link" disabled={ctx.runner.busy('contacts/revoke-rule:'+r.id)} onClick={()=>act('contacts/revoke-rule',{ruleId:r.id},{slot:'contacts/revoke-rule:'+r.id})}>Revoke</button>}<ActionNote runner={ctx.runner} slot={'contacts/revoke-rule:'+r.id}/></div>)}
      <div className="ext-form" role="group" aria-label="New rule"><select aria-label="Rule recipient" value={rule.routeId} onChange={e=>setRule({...rule,routeId:e.target.value})}><option value="">Verified recipient…</option>{verified.map(r=><option key={r.id} value={r.id}>{displayText(r.label,80)}</option>)}</select>
        <input aria-label="Rule workflow ID" value={rule.workflowId} onChange={e=>setRule({...rule,workflowId:e.target.value.trim()})} placeholder="Workflow ID"/>
        <input aria-label="Rule template ID" value={rule.templateId} onChange={e=>setRule({...rule,templateId:e.target.value.trim()})} placeholder="Template ID"/>
        <input aria-label="Rule expiry in days" type="number" min="1" max="90" value={rule.expiresInDays} onChange={e=>setRule({...rule,expiresInDays:Math.floor(Number(e.target.value))})}/>
        <button className="secondary" disabled={!rule.routeId||!rule.workflowId||!rule.templateId||ctx.runner.busy('contacts/add-rule')} onClick={()=>act('contacts/add-rule',rule)}>Add exact rule</button>
        <p className="small muted">A rule covers one recipient, workflow and template version. Any edit needs a new rule.</p><ActionNote runner={ctx.runner} slot="contacts/add-rule"/></div>
      <h4>Outbox</h4>{!data.outbox.length&&<p className="small muted">No messages recorded.</p>}
      {data.outbox.map(entry=>{const r=entry.receipt,badge=deliveryBadge(r),key=r.requestId,open=r.state==='pending'||r.state==='unconfirmed';
        return <div className="ext-row" key={key}><div><strong>{displayText(entry.routeLabel??'Recipient',80)}</strong> <span className="small muted">{entry.channel} · {new Date(r.observedAt).toLocaleString()}</span> <BadgeTag badge={badge}/>
          <p className="small muted">{badge.text}{entry.draftKept&&!badge.text.includes('Draft kept')?' Draft kept.':''}</p></div>
          {entry.approvalRequired&&r.state==='pending'&&(()=>{const current=reviewer.current(r);
            return <>{current&&<ContactReviewDetails review={current}/>}
              {reviewNotes[key]&&<p className="ext-outcome warn" role="status">{reviewNotes[key]}</p>}
              {!reviewAllowed&&<p className="small muted">{ctx.privateSession&&ctx.privacyEpoch===undefined?missingEpochMessage:'Exact message review is unavailable on this service, so approval is off. Nothing was approved.'}</p>}</>;})()}
          <div className="button-row">{entry.approvalRequired&&r.state==='pending'&&<>
            <button className="text-link" disabled={!reviewAllowed||reviewing!==null||ctx.runner.reads.busy(contactReviewKey)} onClick={()=>void reviewer.load(r)}>{reviewing===key?'Loading exact message…':'Show exact message'}</button>
            {/* Approval binds the exact review shown above and both live capabilities; the controller rechecks at dispatch. */}
            <button className="text-link" disabled={!reviewer.canApprove(r)||ctx.runner.busy('contacts/approve:'+key)}
              onClick={()=>{const input=reviewer.approve(r);if(input)act('contacts/approve',input,{slot:'contacts/approve:'+key});}}>Approve this exact message</button></>}
            {open&&<button className="text-link" disabled={ctx.runner.busy('contacts/reconcile:'+key)} onClick={()=>act('contacts/reconcile',{requestId:key},{slot:'contacts/reconcile:'+key})}>Check provider record</button>}</div>
          <ActionNote runner={ctx.runner} slot={'contacts/approve:'+key}/><ActionNote runner={ctx.runner} slot={'contacts/reconcile:'+key}/></div>;})}</>}
  </div>;
}

export function AgentControls(ctx:ExtensionContext&{overview:Overviews['agents'];load:()=>Promise<void>;loading?:boolean;initialConnection?:ReadView<CodexConnection>}){
  const [connection,reloadConnection,connectionBusy]=useRead(ctx.runner,readKey(extensionRoutes.codexConnection),ctx.privateSession?undefined:ctx.initialConnection,
    ()=>readCodexConnection(ctx.request,Date.now,{gate:ctx.runner.reads}),scopeKey(ctx));
  const codex=connection.kind==='ready'?connection.data:undefined;
  const setupActive=codex?.state==='connecting'||codex?.state==='checking';
  const setupUnavailable=ctx.privateSession||connectionBusy||setupActive||codex?.state==='busy'||codex?.state==='unconfigured';
  const setupAction=<A extends UiAction,>(action:A,input:UiActionInput<A>)=>{
    ctx.act(action,input);void reloadConnection();
  };
  // A click starts setup; these reads only observe it. No render/refresh signs in
  // or launches a model. Shared action receipt changes also refresh the view.
  const setupReceipts=['agents/connect-codex','agents/inspect-codex','agents/cancel-codex','agents/select-codex-model'].map(a=>{const r=ctx.runner.outcome(a);return r?r.requestId+':'+r.state:'';}).filter(Boolean).join(':');
  useEffect(()=>{if(ctx.privateSession||!setupReceipts)return;const timer=setTimeout(()=>void reloadConnection(),100);return ()=>clearTimeout(timer);},[setupReceipts]);
  useEffect(()=>{if(!setupActive||ctx.privateSession)return;const timer=setInterval(()=>void reloadConnection(),1000);return ()=>clearInterval(timer);},[setupActive,ctx.privateSession]);
  const current=statusOf(ctx.status),saved=settingsOf(ctx.settings)?.agents,missing=serviceMissing(ctx.status);
  const locked=missing||!saved||!ctx.settingsConfirmed||ctx.runner.busy('agents/configure');
  const configure=(patch:{codexEnabled?:boolean;claudeApiEnabled?:boolean})=>{const input=confirmedWrite(saved,ctx.settingsConfirmed,['codexEnabled','claudeApiEnabled'],patch);if(input)ctx.act('agents/configure',input);};
  const data=ctx.overview.kind==='ready'?ctx.overview.data:undefined;
  const providerCapability=(p:'codex'|'claude-api')=>current?.agents.find(a=>a.provider===p)?.capability;
  const [taskId,setTaskId]=useState('');const [grant,setGrant]=useState({providers:[] as ('codex'|'claude-api')[],workspaceIds:[] as string[],allowPaid:false,expiresInMinutes:60});
  const [start,setStart]=useState({provider:'codex' as 'codex'|'claude-api',workspaceId:'',prompt:''});
  const workspaceLabel=(id:string)=>displayText(data?.workspaces.find(w=>w.id===id)?.label??'Workspace',80);
  const flip=<T,>(list:T[],value:T,on:boolean)=>on?[...new Set([...list,value])]:list.filter(v=>v!==value);
  const canStart=!ctx.privateSession&&!!taskId&&!!start.workspaceId&&!!start.prompt.trim()&&actionReady(providerCapability(start.provider),'start');
  return <div className="ext-section"><h3>Coding agents</h3>
    {(['codex','claude-api'] as const).map(p=><div key={p}><strong className="small">{p==='codex'?'Codex (Capri runtime connection)':'Claude API (paid, configuration-gated)'}</strong><BadgeLine badge={capabilityBadge(providerCapability(p))}/></div>)}
    <p className="small muted">Runtime delegation is off by default and separate from development tools. Results are untrusted handoffs: review changes before applying them through your workspace grants.</p>
    <div className="ext-form" role="group" aria-label="Codex connection">
      <p className="small muted">Sign in once for Capri’s isolated runtime using your existing ChatGPT account and plan. This does not buy API credits or change your development Codex configuration. Complete the official sign-in in your browser; Codex stores and refreshes its own credentials.</p>
      <button className="text-link" disabled={ctx.privateSession||connectionBusy} onClick={()=>void reloadConnection()}>Read connection state</button>
      <ReadNote view={connection} what="Codex connection"/>
      {codex&&<p className="small" role="status">{codex.state} · {codex.authenticated?'ChatGPT sign-in observed':'Sign-in not confirmed'} · inference access unverified</p>}
      <div className="button-row">
        <button className="secondary" disabled={setupUnavailable||!codex||ctx.runner.busy('agents/connect-codex')} onClick={()=>setupAction('agents/connect-codex',{})}>Connect Codex</button>
        <button className="text-link" disabled={setupUnavailable||!codex||ctx.runner.busy('agents/inspect-codex')} onClick={()=>setupAction('agents/inspect-codex',{})}>Inspect connection</button>
        <button className="text-link" disabled={ctx.privateSession||!codex?.sessionId||ctx.runner.busy('agents/cancel-codex')} onClick={()=>codex?.sessionId&&setupAction('agents/cancel-codex',{sessionId:codex.sessionId})}>Cancel sign-in</button>
      </div>
      {(['agents/connect-codex','agents/inspect-codex','agents/cancel-codex','agents/select-codex-model'] as const).map(slot=><ActionNote key={slot} runner={ctx.runner} slot={slot}/>)}
      <label>Runtime model<select aria-label="Codex runtime model" value={codex?.model??''} disabled={ctx.privateSession||!codex?.authenticated||setupActive||ctx.runner.busy('agents/select-codex-model')} onChange={e=>setupAction('agents/select-codex-model',{model:e.target.value})}>
        <option value="">Choose from the inspected catalog…</option>{codex?.model&&!codex.models.includes(codex.model)&&<option value={codex.model}>{displayText(codex.model,100)} (saved; inspect catalog)</option>}{codex?.models.map(model=><option key={model} value={model}>{displayText(model,100)}</option>)}
      </select></label>
      <p className="small muted">Setup makes no inference request. Sign-in and this catalog do not prove model access, available quota or task success. Actual task limits and results remain authoritative.</p>
    </div>
    <Toggle id="ext-agents-codex" label="Codex delegation" hint="Task-scoped; connect, choose a runtime model, then grant each task and workspace." checked={!!saved?.codexEnabled} disabled={locked||!saved?.codexEnabled&&(!codex?.authenticated||!codex.model||!codex.models.includes(codex.model))} onChange={codexEnabled=>configure({codexEnabled})}/>
    <Toggle id="ext-agents-claude" label="Claude API delegation" hint="Metered. Needs configuration and a grant that allows paid use." checked={!!saved?.claudeApiEnabled} disabled={locked} onChange={claudeApiEnabled=>configure({claudeApiEnabled})}/>
    <ActionNote runner={ctx.runner} slot="agents/configure"/>
    {ctx.privateSession&&<p className="ext-outcome warn" role="status">Private session: remote agents are never used.</p>}
    <div className="ext-head"><h4>Tasks and workspaces</h4><button className="text-link" disabled={ctx.loading??ctx.overview.kind==='loading'} onClick={()=>void ctx.load()}>Load agent details</button></div>
    <ReadNote view={ctx.overview} what="Agent details"/>
    {data&&<>
      <label>Task<select aria-label="Agent task" value={taskId} onChange={e=>setTaskId(e.target.value)}><option value="">Choose a task…</option>{data.tasks.map(t=><option key={t.id} value={t.id}>{displayText(t.label,80)||displayTaskId(t.id)}</option>)}</select></label>
      <div className="ext-form" role="group" aria-label="Task grant"><strong>Grant for this task</strong>
        {(['codex','claude-api'] as const).map(p=><label className="ext-inline" key={p}><input type="checkbox" checked={grant.providers.includes(p)} onChange={e=>setGrant({...grant,providers:flip(grant.providers,p,e.target.checked)})}/> {p==='codex'?'Codex':'Claude API'}</label>)}
        {data.workspaces.map(w=><label className="ext-inline" key={w.id}><input type="checkbox" checked={grant.workspaceIds.includes(w.id)} onChange={e=>setGrant({...grant,workspaceIds:flip(grant.workspaceIds,w.id,e.target.checked)})}/> {displayText(w.label,80)}</label>)}
        <label className="ext-inline"><input type="checkbox" checked={grant.allowPaid} onChange={e=>setGrant({...grant,allowPaid:e.target.checked})}/> Allow paid use</label>
        <label>Expires after (minutes)<input aria-label="Grant minutes" type="number" min="5" max="1440" value={grant.expiresInMinutes} onChange={e=>setGrant({...grant,expiresInMinutes:Math.floor(Number(e.target.value))})}/></label>
        <button className="secondary" disabled={!taskId||!grant.providers.length||!grant.workspaceIds.length||ctx.runner.busy('agents/grant')} onClick={()=>ctx.act('agents/grant',grant,{taskId})}>Grant</button><ActionNote runner={ctx.runner} slot="agents/grant"/>
        {data.grants.filter(g=>g.taskId===taskId).map(g=><p className="small muted" key={g.taskId+g.expiresAt}>{g.revoked?'Revoked':'Active until '+new Date(g.expiresAt).toLocaleTimeString()} · {g.providers.join(', ')} · {g.workspaceIds.map(workspaceLabel).join(', ')}{g.allowPaid?' · paid allowed':''}</p>)}</div>
      <div className="ext-form" role="group" aria-label="Delegate"><strong>Delegate</strong>
        <select aria-label="Agent provider" value={start.provider} onChange={e=>setStart({...start,provider:e.target.value as 'codex'})}><option value="codex">Codex</option><option value="claude-api">Claude API</option></select>
        <select aria-label="Agent workspace" value={start.workspaceId} onChange={e=>setStart({...start,workspaceId:e.target.value})}><option value="">Workspace…</option>{data.workspaces.map(w=><option key={w.id} value={w.id}>{displayText(w.label,80)}</option>)}</select>
        <textarea aria-label="Agent request" maxLength={12000} value={start.prompt} onChange={e=>setStart({...start,prompt:e.target.value})} placeholder="What should the agent do in the staged copy?"/>
        <button className="primary" disabled={!canStart||ctx.runner.busy('agents/start')} onClick={()=>ctx.act('agents/start',start,{taskId})}>Start agent</button>
        {!actionReady(providerCapability(start.provider),'start')&&<p className="small muted">This provider is unavailable. Nothing will start.</p>}<ActionNote runner={ctx.runner} slot="agents/start"/></div>
      <h4>Jobs</h4>{!data.jobs.length&&<p className="small muted">No agent jobs.</p>}
      {data.jobs.map(job=>{const badge=agentJobBadge(job),live=job.state==='pending'||job.state==='running'||job.state==='needs-approval';
        return <div className="ext-row" key={job.id}><div><strong title={displayTaskId(job.taskId)}>{displayTaskId(job.taskId)}</strong> <span className="small muted">{job.provider} · {workspaceLabel(job.workspaceId)}</span> <BadgeTag badge={badge}/>
          <p className="small muted">{badge.text}</p><p className="small">{displayText(job.summary)}</p></div>
          <div className="button-row"><button className="text-link" disabled={ctx.runner.busy('agents/inspect:'+job.id)} onClick={()=>ctx.act('agents/inspect',{jobId:job.id},{slot:'agents/inspect:'+job.id,taskId:job.taskId})}>Inspect</button>
            {live&&<button className="text-link" disabled={ctx.runner.busy('agents/cancel:'+job.id)} onClick={()=>ctx.act('agents/cancel',{jobId:job.id},{slot:'agents/cancel:'+job.id,taskId:job.taskId})}>Cancel</button>}</div>
          <ActionNote runner={ctx.runner} slot={'agents/inspect:'+job.id}/><ActionNote runner={ctx.runner} slot={'agents/cancel:'+job.id}/></div>;})}</>}
  </div>;
}

export function UpdateControls(ctx:ExtensionContext){
  const current=statusOf(ctx.status),capability=current?.features.updates,saved=settingsOf(ctx.settings)?.updates,missing=serviceMissing(ctx.status);
  // The channel and automatic toggle are sent together, so neither can be written from a default or stale value.
  const locked=missing||!saved||!ctx.settingsConfirmed||ctx.runner.busy('updates/configure');
  const configure=(patch:{automatic?:boolean;channel?:'stable'|'preview'})=>{const input=confirmedWrite(saved,ctx.settingsConfirmed,['automatic','channel'],patch);if(input)ctx.act('updates/configure',input);};
  const [confirmRollback,setConfirmRollback]=useState(false);
  const version=current?.updates.state==='available'&&capability?.available?current.updates.version:undefined;
  const recovery=current?.updates.state==='recovery-required';
  return <div className="ext-section"><h3>Signed updates</h3>
    <BadgeLine badge={capabilityBadge(capability)}/><BadgeLine badge={updatesBadge(current)}/>
    <p className="small muted">Updates install only from releases signed with the operator-pinned key, after hash checks, independent acceptance and a verified profile backup. Trust is configured by the operator, never from a release feed.</p>
    <Toggle id="ext-updates-auto" label="Automatic verified updates" hint="Installs verified updates while idle. This preference grants no trust." checked={!!saved?.automatic} disabled={locked} onChange={automatic=>configure({automatic})}/>
    <label>Channel<select aria-label="Update channel" value={saved?.channel??''} disabled={locked} onChange={e=>configure({channel:e.target.value==='preview'?'preview':'stable'})}>{!saved&&<option value="">Not loaded</option>}<option value="stable">Stable</option><option value="preview">Preview</option></select></label>
    <ActionNote runner={ctx.runner} slot="updates/configure"/>
    <div className="button-row">
      <button className="secondary" disabled={!actionReady(capability,'check')||ctx.runner.busy('updates/check')} onClick={()=>ctx.act('updates/check',{})}>Check for updates</button>
      {version&&<button className="primary" disabled={!actionReady(capability,'stage')||ctx.runner.busy('updates/stage')} onClick={()=>ctx.act('updates/stage',{version})}>Stage {displayText(version,80)}</button>}
      {!confirmRollback&&<button className="secondary" disabled={missing||!(recovery||actionReady(capability,'rollback'))} onClick={()=>setConfirmRollback(true)}>Roll back…</button>}
    </div>
    {confirmRollback&&<div className="ext-confirm" role="group" aria-label="Confirm rollback"><p className="small">Restore the known-good version and its verified backup. Message receipts and the update sequence are kept.</p>
      <div className="button-row"><button className="primary" disabled={ctx.runner.busy('updates/rollback')} onClick={()=>{setConfirmRollback(false);ctx.act('updates/rollback',{});}}>Roll back now</button><button className="secondary" onClick={()=>setConfirmRollback(false)}>Cancel</button></div></div>}
    {(['updates/check','updates/stage','updates/rollback'] as const).map(slot=><ActionNote key={slot} runner={ctx.runner} slot={slot}/>)}
  </div>;
}

// ---- Skills ----------------------------------------------------------------------------------
const skillStateText:Record<SkillCatalogEntry['state'],Badge>={
  ready:{tag:'READY TO USE',tone:'green',text:'Reviewed guidance with installed verification handlers. Task verified is reported only after current-task outcome checks pass. Each tool still needs its normal grant.'},
  disabled:{tag:'OFF',tone:'',text:'Skills are disabled in settings.'},
  unreviewed:{tag:'NEEDS REVIEW',tone:'warn',text:'Not used until you review this exact manifest.'},
  'invalid-review':{tag:'REVIEW INVALID',tone:'error',text:'The stored review could not be read. Review again.'},
  changed:{tag:'CHANGED',tone:'warn',text:'The manifest changed after review. Review again.'},
  revoked:{tag:'REVOKED',tone:'',text:'Review revoked.'},
  'local-only':{tag:'LOCAL ONLY',tone:'warn',text:'Needs network or delegation, which this task does not allow.'},
  'missing-capability':{tag:'MISSING CAPABILITY',tone:'warn',text:'A required capability is unavailable.'},
  'missing-dependency':{tag:'MISSING DEPENDENCY',tone:'warn',text:'A required tool or feature is unavailable.'},
  'verification-required':{tag:'CHECK UNAVAILABLE',tone:'warn',text:'A required fixed verification handler is unavailable. Earlier-task results cannot enable it.'},
};
const missingVerifierText=(id:string)=>({
  'desktop-reinspect':'Window observations cannot yet verify arbitrary application effects.',
  'browser-reinspect':'Page observations cannot yet verify arbitrary submissions, closes or downloads.',
  'game-workshop-evidence':'Task-correlated game build and isolated test proof is unavailable.',
  'command-exit-status':'Fixed project checks support JavaScript, .NET, Python, Cargo and Go build/test/check commands. Other toolchains and arbitrary scripts are unavailable for verified completion.',
}[id]??'This fixed verification handler is not installed.');
const reviewable=new Set<SkillCatalogEntry['state']>(['unreviewed','changed','revoked','invalid-review']);
const list=(text:string)=>text.split(',').map(s=>s.trim()).filter(Boolean);
const rows=(text:string)=>text.split('\n').map(s=>s.trim()).filter(Boolean);
/** Builds the teach-workflow input. The service derives permissions, manifest and digests. */
export function teachInput(form:TeachForm,suffix:string):UiActionInput<'skills/draft'> {
  const slug=form.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'skill';
  return {id:'user-'+slug+'-'+suffix,name:form.name.trim(),description:form.description.trim(),
    recipe:{summary:form.summary.trim(),keywords:list(form.keywords.toLowerCase()),tools:list(form.tools),optionalTools:list(form.optionalTools),
      extensions:form.security?['security']:[],steps:rows(form.steps),verify:rows(form.verify),checks:list(form.checks)}};
}
export interface SkillsPanelProps {request?:ExtensionRequest;runner?:ActionRunner;privateSession?:boolean;
  /** The main renderer's trusted privacy epoch. Without it a private session cannot load, draft or review. */
  privacyEpoch?:PrivacyEpoch;clock?:()=>number;
  capability?:FeatureCapability;initialCatalog?:ReadView<z.infer<typeof SkillCatalogSchema>>}
export function SkillsPanel(props:SkillsPanelProps){
  const request=props.request??defaultExtensionRequest,clock=props.clock??Date.now;
  const runner=useRunner(props);
  const scope={epoch:props.privacyEpoch,privateSession:!!props.privateSession};
  const ref=useRef<SkillsSession|null>(null);
  // A closed session is never reactivated; an effect re-run after cleanup gets a fresh one.
  if(!ref.current||ref.current.closed())ref.current=createSkillsSession({request,runner,clock,scope,initialCatalog:props.initialCatalog});
  const session=ref.current;
  // A privacy boundary discards the private form, catalog and acknowledgements during this render, before paint.
  session.sync(scope);
  const [,changed]=useReducer((n:number)=>n+1,0);
  useEffect(()=>{if(session.closed()){changed();return;}const off=session.subscribe(changed);return ()=>{off();session.close();};},[session]);
  const {catalog,form,acknowledged:checked,allowed:flowsAllowed,runner:skillsRunner,reading}=session.snapshot();
  const setForm=(next:TeachForm)=>session.setForm(next);
  const act=<A extends UiAction>(action:A,input:UiActionInput<A>,slot:string=action,keepForm=true)=>session.act(action,input,slot,!keepForm);
  const data=catalog.kind==='ready'?catalog.data:undefined;
  const allowed=(action:string)=>flowsAllowed&&(props.capability===undefined||actionReady(props.capability,action));
  return <section className="card section-card skills-panel" aria-label="Reviewed skills"><div className="ext-head"><h2>Skills</h2><button className="secondary" disabled={catalog.kind==='loading'||reading||!flowsAllowed} onClick={()=>void session.load()}>Load catalog</button></div>
    {props.capability&&<BadgeLine badge={capabilityBadge(props.capability)}/>}
    <p className="small muted">Skills are reviewed plain-language recipes over Capri's existing tools. They grant no permissions; every tool use keeps its normal review.</p>
    <p className="small muted">Coding readiness covers fixed JavaScript, .NET, Python, Cargo and Go build/test/check commands. Other project toolchains need a supported verifier before Task verified is available.</p>
    {!flowsAllowed&&<p className="ext-outcome warn" role="status">{missingEpochMessage}</p>}
    <ReadNote view={catalog} what="Catalog"/>
    {data&&!data.skills.length&&<p className="small muted">No skills yet.</p>}
    {data?.skills.map(skill=>{const badge=skillStateText[skill.state],m=skill.manifest,slot=(a:string)=>a+':'+skill.skillId,acknowledged=checked[skill.skillId]===skill.manifestSha256;
      return <div className="ext-row skill-row" key={skill.skillId}><div><strong>{displayText(skill.name,100)}</strong> <span className="small muted">{displayText(skill.version,40)} · {skill.provenance.kind==='built-in'?'built in':'yours'}{skill.private?' · private':''}{skill.localOnly?' · local only':''}{skill.draft?' · unsaved draft':''}</span> <BadgeTag badge={badge}/>
        <p className="small muted">{badge.text}</p>
        {skill.paidTools.length>0&&<p className="small">Metered tools: {skill.paidTools.map(t=>displayText(t,40)).join(', ')}</p>}
        {[...skill.missing.capabilities,...skill.missing.dependencies,...skill.missing.checks].length>0&&<p className="small">Missing: {[...skill.missing.capabilities,...skill.missing.dependencies,...skill.missing.checks].map(t=>displayText(t,60)).join(', ')}</p>}
        {skill.missing.checks.map(check=><p className="small muted" key={check}>{displayText(check,60)}: {missingVerifierText(check)}</p>)}
        {m?<details className="detail-row"><summary>Manifest {skill.manifestSha256.slice(0,12)}</summary>
          <p className="small">Permissions: {m.permissions.length?m.permissions.join(', '):'none'}</p>
          <p className="small">Requires: {[...m.requiredCapabilities,...m.dependencies].map(t=>displayText(t,60)).join(', ')||'nothing extra'}</p>
          <p className="small">Checks: {m.verification.map(v=>v.kind==='registered-check'?displayText(v.checkId,60):'source '+v.sha256.slice(0,12)).join(', ')}</p></details>
          :<p className="small muted">Manifest details unavailable; review is disabled.</p>}</div>
        <div className="button-row">
          {skill.draft&&<><button className="text-link" disabled={!flowsAllowed||skillsRunner.busy(slot('skills/save-draft'))} onClick={()=>act('skills/save-draft',{skillId:skill.skillId},slot('skills/save-draft'))}>Save draft</button>
            <button className="text-link" disabled={!flowsAllowed||skillsRunner.busy(slot('skills/discard-draft'))} onClick={()=>act('skills/discard-draft',{skillId:skill.skillId},slot('skills/discard-draft'))}>Discard</button></>}
          {reviewable.has(skill.state)&&m&&!skill.draft&&<><label className="ext-inline"><input type="checkbox" checked={acknowledged} disabled={!flowsAllowed} onChange={e=>session.acknowledge(skill.skillId,e.target.checked?skill.manifestSha256:'')}/> I reviewed these permissions</label>
            <button className="text-link" disabled={!acknowledged||!allowed('review')||skillsRunner.busy(slot('skills/review'))} onClick={()=>act('skills/review',{skillId:skill.skillId,manifestSha256:skill.manifestSha256},slot('skills/review'))}>Approve review</button></>}
          {!reviewable.has(skill.state)&&skill.state!=='disabled'&&!skill.draft&&<button className="text-link" disabled={!flowsAllowed||skillsRunner.busy(slot('skills/revoke'))} onClick={()=>act('skills/revoke',{skillId:skill.skillId},slot('skills/revoke'))}>Revoke review</button>}
        </div>{(['skills/save-draft','skills/discard-draft','skills/review','skills/revoke']).map(a=><ActionNote key={a} runner={skillsRunner} slot={slot(a)}/>)}</div>;})}
    <div className="ext-form" role="group" aria-label="Teach a skill"><h3>Teach Capri a skill</h3>
      {props.privateSession&&<p className="small muted">Private session: this form, private drafts and acknowledgements are discarded when the session ends.</p>}
      <input aria-label="Skill name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Name"/>
      <input aria-label="Skill description" value={form.description} onChange={e=>setForm({...form,description:e.target.value})} placeholder="What it is for"/>
      <input aria-label="Skill goal" value={form.summary} onChange={e=>setForm({...form,summary:e.target.value})} placeholder="Goal in one sentence"/>
      <input aria-label="Skill keywords" value={form.keywords} onChange={e=>setForm({...form,keywords:e.target.value})} placeholder="Keywords, comma separated"/>
      <input aria-label="Skill tools" value={form.tools} onChange={e=>setForm({...form,tools:e.target.value})} placeholder="Required tools, e.g. read_file, create_artifact"/>
      <input aria-label="Skill optional tools" value={form.optionalTools} onChange={e=>setForm({...form,optionalTools:e.target.value})} placeholder="Optional tools"/>
      <textarea aria-label="Skill steps" value={form.steps} onChange={e=>setForm({...form,steps:e.target.value})} placeholder="One step per line"/>
      <textarea aria-label="Skill verification" value={form.verify} onChange={e=>setForm({...form,verify:e.target.value})} placeholder="How to verify before reporting success, one per line"/>
      <input aria-label="Skill checks" value={form.checks} onChange={e=>setForm({...form,checks:e.target.value})} placeholder="Registered checks, e.g. artifact-readback"/>
      <label className="ext-inline"><input type="checkbox" checked={form.security} onChange={e=>setForm({...form,security:e.target.checked})}/> Uses Defender tools</label>
      <button className="primary" disabled={!flowsAllowed||!form.name.trim()||skillsRunner.busy('skills/draft')} onClick={()=>act('skills/draft',teachInput(form,clock().toString(36)),'skills/draft',false)}>Create draft</button>
      <p className="small muted">Drafts are not used until saved and reviewed. Your form stays here if the service rejects it.</p>
      <ActionNote runner={skillsRunner} slot="skills/draft"/></div>
  </section>;
}
