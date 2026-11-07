import type {State} from '../shared';
import type {CompanionMode,CompanionState} from '../desktop/companion-state';
import {normalizeAgentActivity,redactActivity,type AgentActivityEvent,type DevelopmentAgent} from '../development';
import {agentNames,displayTaskId,isAgentActivityMessage} from './agent-activity';
import {STILL,scalePose,type Pose} from './sprite-state';

/**
 * Presentation-only cues layered over the sprite. They never change the voice State, captions, the OS pointer, focus or
 * window bounds. Teleport and pointing ideas come from upstream acting.js/fx.js; this is an original canvas implementation.
 * `at` is the performance.now() time the cue was issued, so a remounted portrait does not replay old cues.
 */
export type PresentationCue={id:string;at:number}&({kind:'teleport';to:CompanionMode}|{kind:'point';agent:DevelopmentAgent;label:string;detail:string;title:string;key?:string}|{kind:'flourish'});
export type PresentationCueKind=PresentationCue['kind'];
export const cueSpec:Record<PresentationCueKind,{priority:number;ms:number}>={teleport:{priority:3,ms:900},point:{priority:2,ms:6000},flourish:{priority:1,ms:1400}};
export const CUE_STALE_MS=1500,CUE_SEEN_LIMIT=200,ATTENTION_FRESH_MS=120000,FLOURISH_EVERY_MS=90000,FLOURISH_QUIET_MS=20000;
const TELEPORT_OUT=360,TELEPORT_GAP=120;
export type CueContext={motion:boolean;game:boolean;state:State;dragging:boolean;perched:boolean;resting:boolean;intensity:number;ambient:boolean};
/** One rendered moment: an intensity-scaled pose, sprite alpha, glitch-slice and beam strength, pointer strength and the attention label. */
export type CueFrame={kind:PresentationCueKind;id:string;t:number;pose:Pose;alpha:number;slice:number;beam:number;pointer:number;label?:string;detail?:string;title?:string};
export type CueResult='started'|'queued'|'duplicate'|'stale'|'outranked'|'superseded';

const clamp=(v:number,low:number,high:number)=>Math.min(high,Math.max(low,v));
const smooth=(t:number)=>{const x=clamp(t,0,1);return x*x*(3-2*x);};
/** Decorative effects need motion, no game docking and a positive intensity. */
export const effectsAllowed=(c:CueContext)=>c.motion&&!c.game&&Number.isFinite(c.intensity)&&c.intensity>0;
/** Ambient flourishes additionally stay out of listening, speaking, any busy state, drags and sleep. */
export const ambientAllowed=(c:CueContext)=>effectsAllowed(c)&&c.state==='idle'&&!c.dragging&&!c.resting;
/** Adds a presentation pose to a sprite pose, keeping the same canvas margin limits and seated contact. */
export function composePose(a:Pose,b:Pose,perched=false):Pose{
 return {x:perched?0:clamp(a.x+b.x,-14,14),y:perched?0:clamp(a.y+b.y,-14,14),rotate:clamp(a.rotate+b.rotate,-5,5),sx:clamp(a.sx+b.sx-1,.95,1.05),sy:clamp(a.sy+b.sy-1,.95,1.04),glow:clamp(a.glow+b.glow,0,1)};
}

/** The same display redaction as the activity panel. Raw ids stay on the event for routing and deduplication only. */
export function attentionText(event:Pick<AgentActivityEvent,'agent'|'project'|'taskId'>){
 const agent=agentNames[event.agent],project=redactActivity(event.project.replace(/\s+/g,' ').trim())||'unknown project',task=displayTaskId(event.taskId);
 return {label:agent+' needs input',detail:project+' · '+task,title:agent+' · '+project+' · '+task+' · Needs input'};
}
/**
 * Raw routing identity for an attention request: agent, project and task. The session is left out on purpose, so progress
 * from a new run or integration session of the same task still clears attention raised by the coordinator. Never displayed.
 */
export function attentionKey(event:Pick<AgentActivityEvent,'agent'|'project'|'taskId'>){return [event.agent,event.project.replace(/\s+/g,' ').trim().toLowerCase(),event.taskId.trim()].join('\n');}
export const ATTENTION_KEY_LIMIT=200;
type Mark={at:number;id:string};
/**
 * Attention lifecycle for one renderer, ordered by event time. A newer started/working/thinking/completed/error update for
 * the same agent/project/task clears its attention, and a needs_input older than that update (or than a newer needs_input)
 * never raises attention again, whatever order the events arrive in.
 */
export class AttentionLifecycle{
 private entries=new Map<string,{progress?:Mark;attention?:Mark}>();
 private put(key:string,entry:{progress?:Mark;attention?:Mark}){this.entries.delete(key);this.entries.set(key,entry);if(this.entries.size>ATTENTION_KEY_LIMIT)this.entries.delete(this.entries.keys().next().value!);}
 /** Returns a pointing cue for fresh attention and whether any retained attention cue may have been superseded. */
 observe(message:unknown,wallNow:number,at:number):{cue?:PresentationCue;changed:boolean}{
  if(!isAgentActivityMessage(message))return {changed:false};const event=normalizeAgentActivity(message.event);if(!event)return {changed:false};
  const key=attentionKey(event),when=Date.parse(event.at),id='agent:'+event.id,entry={...this.entries.get(key)};
  if(event.kind==='needs_input'){
   if((entry.progress&&entry.progress.at>=when)||(entry.attention&&(entry.attention.at>when||entry.attention.id===id)))return {changed:false};
   entry.attention={at:when,id};this.put(key,entry);
   return {cue:wallNow-when>ATTENTION_FRESH_MS?undefined:{kind:'point',id,at,agent:event.agent,key,...attentionText(event)},changed:true};
  }
  if(!entry.progress||when>entry.progress.at)entry.progress={at:when,id};
  const changed=!!entry.attention&&entry.attention.at<=when;if(changed)entry.attention=undefined;
  this.put(key,entry);return {changed};
 }
 /** True for an agent attention cue that is no longer the open request for its task. Manual previews carry no key and never are. */
 superseded(cue:PresentationCue){return cue.kind==='point'&&cue.key!==undefined&&this.entries.get(cue.key)?.attention?.id!==cue.id;}
}
const lifecycles=new Map<string,AttentionLifecycle>();
/** One attention lifecycle per cue source in this renderer, shared by the event handler and every portrait of that scope. */
export function attentionLifecycle(scope:string){let lifecycle=lifecycles.get(scope);if(!lifecycle)lifecycles.set(scope,lifecycle=new AttentionLifecycle());return lifecycle;}
/** A pointing cue for a fresh, normalized needs_input event; anything else (or a replayed backlog) yields nothing. */
export function attentionCue(message:unknown,wallNow:number,at:number):PresentationCue|undefined{return new AttentionLifecycle().observe(message,wallNow,at).cue;}
export function previewAttentionCue(at:number):PresentationCue{return {kind:'point',id:'preview:point:'+at,at,agent:'codex',...attentionText({agent:'codex',project:'Preview',taskId:'sample-task'}),label:'Preview · Codex needs input'};}
/** Only a user-chosen mode change teleports: not the first state, not game docking, not hiding. */
export function teleportCue(previous:CompanionState|undefined,next:CompanionState,at:number):PresentationCue|undefined{
 if(!previous||next.gameDocked||next.hidden||previous.gameDocked)return;
 if(next.preferred===previous.preferred||next.mode!==next.preferred||next.mode===previous.mode)return;
 return {kind:'teleport',id:'teleport:'+previous.mode+':'+next.mode+':'+at,at,to:next.mode};
}

/** Samples a cue `t` ms after it started. Returns undefined once it has finished, so every cue is bounded. */
export function sampleCueFrame(cue:PresentationCue,t:number,c:CueContext):CueFrame|undefined{
 const ms=cueSpec[cue.kind].ms;if(!(t>=0)||t>=ms)return;
 const effects=effectsAllowed(c),k=effects?clamp(c.intensity,0,2):0,depth=Math.min(1,k);
 const base={kind:cue.kind,id:cue.id,t,pose:STILL,alpha:1,slice:0,beam:0,pointer:0};
 if(cue.kind==='teleport'){
  if(!effects)return base;
  // Dematerialise, hold a beat as a beam, then rematerialise; alpha always returns to 1 by the end.
  const vanish=t<TELEPORT_OUT?smooth(t/TELEPORT_OUT):t<TELEPORT_OUT+TELEPORT_GAP?1:1-smooth((t-TELEPORT_OUT-TELEPORT_GAP)/(ms-TELEPORT_OUT-TELEPORT_GAP));
  const raw:Pose={x:0,y:-4*vanish,rotate:0,sx:1-.04*vanish,sy:1+.04*vanish,glow:vanish};
  return {...base,pose:scalePose(raw,k,c.perched),alpha:1-.88*depth*vanish,slice:depth*vanish,beam:depth*vanish};
 }
 if(cue.kind==='point'){
  const text={label:cue.label,detail:cue.detail,title:cue.title};if(!effects||c.dragging)return {...base,...text};
  const env=smooth(t/300)*smooth((ms-t)/400),bob=Math.sin(t/260)*.6;
  return {...base,...text,pose:scalePose({x:6*env,y:(-3+bob)*env,rotate:4*env,sx:1,sy:1,glow:0},k,c.perched),pointer:env*depth};
 }
 if(!effects)return;
 const p=t/ms,swell=Math.sin(Math.PI*p);
 return {...base,pose:scalePose({x:0,y:-7*swell,rotate:4*Math.sin(2*Math.PI*p)*(1-p),sx:1+.02*swell,sy:1+.02*swell,glow:swell},k,c.perched)};
}

/** Bounded record of consumed cue ids. Shared through cueLedger(scope) so a remounted portrait never replays a cue it already played. */
export class CueLedger{
 private ids:string[]=[];
 has(id:string){return this.ids.includes(id);}
 add(id:string){if(!this.has(id))this.ids=[...this.ids,id].slice(-CUE_SEEN_LIMIT);}
}
const ledgers=new Map<string,CueLedger>();
/** One ledger per cue source in this renderer (live events, settings previews), outliving any single portrait mount. */
export function cueLedger(scope:string){let ledger=ledgers.get(scope);if(!ledger)ledgers.set(scope,ledger=new CueLedger());return ledger;}
/** Game docking suppresses decorative cues on every portrait, including those that do not own desktop placement. */
export const portraitGameDocked=(companion?:{gameDocked:boolean},gameDocked?:boolean)=>!!(gameDocked||companion?.gameDocked);

/** Per-portrait cue player: priority, cancellation, deduplication and the optional idle flourish. */
export class PresentationCues{
 private active?:{cue:PresentationCue;at:number};private queued?:PresentationCue;private nextFlourish?:number;
 constructor(private readonly seen=new CueLedger(),private readonly attention?:AttentionLifecycle){}
 get current(){return this.active?.cue;}
 get pending(){return this.queued;}
 private superseded(cue:PresentationCue){return !!this.attention?.superseded(cue);}
 private expire(now:number){
  // Attention that a newer update for the same task has answered is dropped whether it is showing or waiting.
  if(this.active&&(now-this.active.at>=cueSpec[this.active.cue.kind].ms||this.superseded(this.active.cue)))this.active=undefined;
  if(this.queued&&this.superseded(this.queued))this.queued=undefined;
  if(!this.active&&this.queued){this.active={cue:this.queued,at:now};this.queued=undefined;}
 }
 /** Higher or equal priority supersedes the current cue; an outranked attention cue waits for the current one instead of being lost. */
 request(cue:PresentationCue,now:number):CueResult{
  if(this.seen.has(cue.id))return 'duplicate';this.seen.add(cue.id);
  if(!(now-cue.at<=CUE_STALE_MS))return 'stale';
  if(this.superseded(cue))return 'superseded';
  this.expire(now);const current=this.active?.cue;
  if(current&&cueSpec[current.kind].priority>cueSpec[cue.kind].priority){if(cue.kind!=='point')return 'outranked';this.queued=cue;return 'queued';}
  if(cue.kind==='point')this.queued=undefined;
  else if(current?.kind==='point'&&cue.kind==='teleport')this.queued=this.queued||current;
  this.active={cue,at:now};return 'started';
 }
 cancel(){this.active=undefined;this.queued=undefined;}
 frame(now:number,c:CueContext):CueFrame|undefined{
  this.expire(now);
  const kind=this.active?.cue.kind;
  // Superseding conditions cancel for good: a flourish interrupted by speech or a drag never resumes.
  if((kind==='flourish'&&!ambientAllowed(c))||(kind==='teleport'&&(!effectsAllowed(c)||c.dragging))){this.active=undefined;this.expire(now);}
  if(!c.ambient)this.nextFlourish=undefined;
  else if(!ambientAllowed(c))this.nextFlourish=Math.max(this.nextFlourish??0,now+FLOURISH_QUIET_MS);
  else if(!this.active){
   if(this.nextFlourish===undefined)this.nextFlourish=now+FLOURISH_EVERY_MS;
   else if(now>=this.nextFlourish){this.nextFlourish=now+FLOURISH_EVERY_MS;this.request({kind:'flourish',id:'flourish:'+now,at:now},now);}
  }
  const active=this.active;return active&&sampleCueFrame(active.cue,now-active.at,c);
 }
}

const FLOURISH_KEY='capri-idle-flourish';
/** Renderer-only preference shared by the dashboard and floating windows; personal-data formats are untouched. */
export function idleFlourishEnabled(storage?:Pick<Storage,'getItem'>){try{return (storage??globalThis.localStorage)?.getItem(FLOURISH_KEY)!=='off';}catch{return true;}}
export function setIdleFlourish(enabled:boolean,storage?:Pick<Storage,'setItem'>){try{(storage??globalThis.localStorage)?.setItem(FLOURISH_KEY,enabled?'on':'off');}catch{}}
