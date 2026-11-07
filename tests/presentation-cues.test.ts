import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AttentionLifecycle,CueLedger,PresentationCues,attentionCue,attentionKey,attentionLifecycle,previewAttentionCue,ATTENTION_KEY_LIMIT,ambientAllowed,composePose,cueLedger,cueSpec,idleFlourishEnabled,portraitGameDocked,sampleCueFrame,setIdleFlourish,teleportCue,CUE_SEEN_LIMIT,CUE_STALE_MS,FLOURISH_EVERY_MS,FLOURISH_QUIET_MS,type CueContext,type PresentationCue} from '../src/ui/presentation-cues';
import {STILL,type Pose} from '../src/ui/sprite-state';
import type {CompanionState} from '../src/desktop/companion-state';
import {agentAttention,emptyAgentActivity,reduceAgentActivity} from '../src/ui/agent-activity';

const idle:CueContext={motion:true,game:false,state:'idle',dragging:false,perched:false,resting:false,intensity:1,ambient:false};
const teleport=(id:string,at:number):PresentationCue=>({kind:'teleport',id,at,to:'free'});
const point=(id:string,at:number,label='Codex needs input'):PresentationCue=>({kind:'point',id,at,agent:'codex',label,detail:'capri · task',title:'Codex · capri · task · Needs input'});
const flourish=(id:string,at:number):PresentationCue=>({kind:'flourish',id,at});
const near=(a:number,b:number,m='')=>assert.ok(Math.abs(a-b)<1e-9,m+' expected '+b+' got '+a);
const still=(pose:Pose)=>{for(const key of Object.keys(STILL) as (keyof Pose)[])near(pose[key],STILL[key],key);};
const companion=(patch:Partial<CompanionState>):CompanionState=>({type:'companion',preferred:'follow',mode:'follow',following:true,gameDocked:false,hidden:false,lean:0,idleMs:0,...patch});
const agentMessage=(patch:Record<string,unknown>)=>({type:'agent_activity',event:{id:'e1',agent:'codex',sessionId:'s',taskId:'task-1',project:'capri',kind:'needs_input',summary:'Pick an option',at:new Date(1_000_000).toISOString(),...patch}});

test('higher priority supersedes, lower is outranked, and an outranked attention cue waits instead of being lost',()=>{
 const cues=new PresentationCues();
 assert.equal(cues.request(flourish('f',0),0),'started');
 assert.equal(cues.request(point('p1',10),10),'started','attention cancels a flourish');
 assert.equal(cues.request(flourish('f2',20),20),'outranked');assert.equal(cues.current?.id,'p1');
 assert.equal(cues.request(teleport('t',30),30),'started');assert.equal(cues.current?.kind,'teleport');assert.equal(cues.pending?.id,'p1','superseded attention resumes after the teleport');
 assert.equal(cues.request(point('p2',40),40),'queued');assert.equal(cues.pending?.id,'p2','the newest attention replaces the older waiting one');
 const during=cues.frame(500,idle);assert.equal(during?.kind,'teleport');assert.equal(during?.label,undefined,'teleport never shows an agent label');
 const after=cues.frame(30+cueSpec.teleport.ms,idle);assert.equal(after?.kind,'point');assert.equal(after?.id,'p2');assert.equal(cues.pending,undefined);
 assert.equal(cues.request(point('p3',2000),2000),'started');assert.equal(cues.current?.id,'p3','a newer attention cue cancels the current one');
 assert.equal(cues.frame(2000+cueSpec.point.ms,idle),undefined,'attention is bounded');
});

test('event ids are deduplicated and stale cues from a remount are not replayed',()=>{
 const cues=new PresentationCues();
 assert.equal(cues.request(point('agent:e1',0),0),'started');assert.equal(cues.request(point('agent:e1',0),5),'duplicate');
 cues.cancel();assert.equal(cues.request(point('agent:e1',0),10),'duplicate','cancelled cues are still remembered');
 const remounted=new PresentationCues();assert.equal(remounted.request(point('agent:e2',0),CUE_STALE_MS+1),'stale');assert.equal(remounted.current,undefined);
 assert.equal(remounted.request(point('agent:e2',0),CUE_STALE_MS+2),'duplicate');
});

test('a portrait remounted immediately does not replay cues its scope already consumed',()=>{
 const before=new PresentationCues(cueLedger('test:remount'));
 assert.equal(before.request(point('agent:r1',0),0),'started');assert.equal(before.request(flourish('preview:f',0),0),'outranked');
 // Navigating away and back within the stale window: the retained cue list is handed to a fresh player.
 const after=new PresentationCues(cueLedger('test:remount'));
 assert.equal(after.request(point('agent:r1',0),100),'duplicate');assert.equal(after.request(flourish('preview:f',0),100),'duplicate');
 assert.equal(after.current,undefined);assert.equal(after.frame(100,idle),undefined,'nothing restarts');
 assert.equal(after.request(point('agent:r2',90),100),'started','new events still play after a remount');
 assert.equal(new PresentationCues(cueLedger('test:other')).request(point('agent:r1',0),100),'started','scopes are independent');
 assert.equal(new PresentationCues().request(point('agent:r1',0),100),'started','an unscoped player keeps a private ledger');
 const ledger=new CueLedger();for(let i=0;i<=CUE_SEEN_LIMIT;i++)ledger.add('id'+i);assert.equal(ledger.has('id0'),false,'the ledger is bounded');assert.equal(ledger.has('id'+CUE_SEEN_LIMIT),true);
});

test('game docking reaches every cue-bearing portrait, not only the floating construct',()=>{
 assert.equal(portraitGameDocked(undefined,true),true,'portraits without placement still learn about docking');
 assert.equal(portraitGameDocked(companion({gameDocked:true}),undefined),true);assert.equal(portraitGameDocked(companion({}),false),false);assert.equal(portraitGameDocked(undefined,undefined),false);
 const game={...idle,game:portraitGameDocked(undefined,true),ambient:true};
 const cues=new PresentationCues();cues.request(point('p',0),0);const f=cues.frame(1500,game)!;assert.equal(f.pointer,0);still(f.pose);assert.equal(f.label,'Codex needs input');
 const previews=new PresentationCues();assert.equal(previews.request(teleport('t',0),0),'started');assert.equal(previews.frame(10,game),undefined,'preview teleport is cancelled while docked');
 assert.equal(previews.request(flourish('f',20),20),'started');assert.equal(previews.frame(30,game),undefined,'preview flourish is cancelled while docked');
 const source=readFileSync('src/ui/main.tsx','utf8');const portraits=source.match(/<Avatar\b[^>]*\bcues=[^>]*>/g)||[];
 assert.equal(portraits.length,3,'floating, chat and preview portraits');
 for(const tag of portraits){assert.match(tag,/gameDocked=\{companion\.gameDocked\}/,tag);assert.match(tag,/ cueScope="(live|preview)"[\s/>]/,tag);}
 const avatar=readFileSync('src/ui/SpriteAvatar.tsx','utf8');assert.match(avatar,/game=portraitGameDocked\(p\.companion,p\.gameDocked\)/);
});

test('reduced motion, intensity zero and game docking drop teleport visuals but keep the attention label still and readable',()=>{
 for(const context of [{...idle,motion:false},{...idle,intensity:0},{...idle,game:true},{...idle,intensity:NaN}]){
  const cues=new PresentationCues();cues.request(point('p',0),0);cues.request(teleport('t',5),5);
  const frame=cues.frame(10,context);assert.equal(frame?.kind,'point','the teleport is cancelled and attention resumes');
  assert.equal(frame?.label,'Codex needs input');assert.equal(frame?.pointer,0);assert.equal(frame?.alpha,1);assert.equal(frame?.slice,0);still(frame!.pose);
  for(const t of [100,400,3000]){const f=sampleCueFrame(point('p',0),t,context)!;still(f.pose);assert.equal(f.pointer,0);}
  assert.equal(sampleCueFrame(flourish('f',0),300,context),undefined);
  const ambient=new PresentationCues();for(let now=0;now<=FLOURISH_EVERY_MS*3;now+=500)assert.equal(ambient.frame(now,{...context,ambient:true}),undefined);
 }
});

test('teleport dissolves and returns fully visible within its bound, with feet anchored while seated',()=>{
 const cue=teleport('t',0);let lowest=1;
 for(let t=0;t<cueSpec.teleport.ms;t+=10){const f=sampleCueFrame(cue,t,{...idle,perched:true})!;lowest=Math.min(lowest,f.alpha);near(f.pose.x,0);near(f.pose.y,0);assert.ok(f.alpha>0&&f.alpha<=1);}
 assert.ok(lowest<.2,'she visibly dematerialises');
 assert.ok(sampleCueFrame(cue,cueSpec.teleport.ms-1,idle)!.alpha>.99,'she is back by the end');
 assert.equal(sampleCueFrame(cue,cueSpec.teleport.ms,idle),undefined);
 const half=sampleCueFrame(cue,400,{...idle,intensity:.5})!,full=sampleCueFrame(cue,400,idle)!;assert.ok(half.slice<full.slice&&half.alpha>full.alpha,'intensity scales the effect');
 const dragged=new PresentationCues();dragged.request(cue,0);assert.equal(dragged.frame(100,{...idle,dragging:true}),undefined,'a drag cancels the teleport');
});

test('pointing leans toward the label, keeps seated contact and drops the pose during a drag',()=>{
 const cue=point('p',0);const mid=sampleCueFrame(cue,1500,idle)!;assert.ok(mid.pose.rotate>3&&mid.pose.x>5&&mid.pointer>.9);
 const seated=sampleCueFrame(cue,1500,{...idle,perched:true})!;near(seated.pose.x,0);near(seated.pose.y,0);assert.ok(seated.pose.rotate>3);
 const dragged=sampleCueFrame(cue,1500,{...idle,dragging:true})!;still(dragged.pose);assert.equal(dragged.pointer,0);assert.equal(dragged.label,'Codex needs input');
 const speaking=sampleCueFrame(cue,1500,{...idle,state:'speaking'})!;assert.equal(speaking.label,'Codex needs input','attention is not suppressed by speech, and never uses the caption');
 near(sampleCueFrame(cue,0,idle)!.pointer,0);assert.ok(sampleCueFrame(cue,cueSpec.point.ms-1,idle)!.pointer<.01,'eases out before ending');
});

test('the idle flourish only plays when idle and stops for listening, speaking, drags and sleep without resuming',()=>{
 assert.equal(ambientAllowed(idle),true);for(const patch of [{state:'listening'},{state:'speaking'},{state:'thinking'},{dragging:true},{resting:true}] as Partial<CueContext>[])assert.equal(ambientAllowed({...idle,...patch}),false);
 const ctx={...idle,ambient:true};const cues=new PresentationCues();
 assert.equal(cues.frame(0,ctx),undefined);assert.equal(cues.frame(FLOURISH_EVERY_MS-1,ctx),undefined);
 const start=FLOURISH_EVERY_MS;const first=cues.frame(start,ctx);assert.equal(first?.kind,'flourish');
 assert.equal(cues.frame(start+300,{...ctx,state:'speaking'}),undefined,'speech cancels it');
 assert.equal(cues.frame(start+320,ctx),undefined,'a cancelled flourish never resumes');
 assert.equal(cues.frame(start+FLOURISH_QUIET_MS-1,ctx),undefined,'stays quiet right after speaking');
 const nextAt=start+FLOURISH_EVERY_MS;for(let now=start+FLOURISH_QUIET_MS;now<nextAt;now+=1000)assert.equal(cues.frame(now,ctx),undefined);
 assert.equal(cues.frame(nextAt,ctx)?.kind,'flourish');
 for(const patch of [{state:'listening'},{dragging:true},{resting:true}] as Partial<CueContext>[]){const c=new PresentationCues();c.frame(0,ctx);for(let now=0;now<=FLOURISH_EVERY_MS*2;now+=250)assert.equal(c.frame(now,{...ctx,...patch}),undefined);}
 const off=new PresentationCues();for(let now=0;now<=FLOURISH_EVERY_MS*2;now+=250)assert.equal(off.frame(now,idle),undefined,'disabled flourish never plays');
 const busy=new PresentationCues();busy.frame(0,ctx);busy.request(point('p',FLOURISH_EVERY_MS),FLOURISH_EVERY_MS);assert.equal(busy.frame(FLOURISH_EVERY_MS,ctx)?.kind,'point','an ambient flourish never interrupts attention');
});

test('composed poses stay inside the canvas margin and seated contact',()=>{
 const wild:Pose={x:14,y:-14,rotate:5,sx:1.05,sy:1.04,glow:1};const sum=composePose(wild,wild);near(sum.x,14);near(sum.y,-14);near(sum.rotate,5);near(sum.sx,1.05);near(sum.sy,1.04);near(sum.glow,1);
 const seated=composePose(wild,wild,true);near(seated.x,0);near(seated.y,0);
 for(const cue of [teleport('t',0),point('p',0),flourish('f',0)])for(let t=0;t<cueSpec[cue.kind].ms;t+=25){const p=sampleCueFrame(cue,t,{...idle,intensity:2})!.pose;assert.ok(Math.abs(p.x)<=14&&Math.abs(p.y)<=14&&Math.abs(p.rotate)<=5&&p.glow<=1);}
});

test('attention cues come only from fresh normalized needs_input events, with the activity panel redaction',()=>{
 const now=1_000_000+5000;
 const cue=attentionCue(agentMessage({taskId:'deploy token=abc123secret',project:'capri  api_key=sk-zzzzzzzzzzzz'}),now,42)!;
 assert.equal(cue.kind,'point');assert.equal(cue.id,'agent:e1','raw id kept for deduplication');assert.equal(cue.at,42);
 if(cue.kind!=='point')throw Error('expected point');
 assert.equal(cue.label,'Codex needs input');assert.ok(!/abc123secret|sk-z/.test(cue.detail+cue.title),'secrets never displayed: '+cue.detail);assert.match(cue.detail,/\[redacted\]/);assert.match(cue.title,/^Codex · capri /);
 for(const kind of ['started','working','thinking','error','completed'])assert.equal(attentionCue(agentMessage({kind}),now,0),undefined,kind);
 assert.equal(attentionCue(agentMessage({}),1_000_000+10*60000,0),undefined,'an old backlog event does not point');
 assert.equal(attentionCue(agentMessage({agent:'other'}),now,0),undefined);assert.equal(attentionCue(agentMessage({id:''}),now,0),undefined);
 assert.equal(attentionCue({type:'caption',text:'needs_input'},now,0),undefined);assert.equal(attentionCue(null,now,0),undefined);
});

const at=(ms:number)=>new Date(1_000_000+ms).toISOString();
const wall=1_000_000+5000;
const pointOf=(seen:{cue?:PresentationCue})=>{assert.equal(seen.cue?.kind,'point');return seen.cue!;};

test('newer progress for the same task cancels the active attention cue and prunes it from retained lists',()=>{
 const attention=new AttentionLifecycle(),ledger=new CueLedger(),cues=new PresentationCues(ledger,attention);
 const raised=pointOf(attention.observe(agentMessage({id:'n1',at:at(0)}),wall,0));
 assert.equal(cues.request(raised,0),'started');assert.equal(cues.frame(100,idle)?.label,'Codex needs input');
 assert.deepEqual(attention.observe(agentMessage({id:'c1',kind:'completed',at:at(10)}),wall,120),{changed:true});
 assert.equal(attention.superseded(raised),true);
 assert.equal(cues.frame(140,idle),undefined,'completion clears the label well before its six seconds');assert.equal(cues.current,undefined);
 assert.equal(new PresentationCues(new CueLedger(),attention).request(raised,150),'superseded','a remount with the retained cue cannot restore it');
 for(const kind of ['started','working','thinking','error']){
  const a=new AttentionLifecycle(),p=new PresentationCues(new CueLedger(),a);p.request(pointOf(a.observe(agentMessage({id:'n',at:at(0)}),wall,0)),0);
  assert.equal(a.observe(agentMessage({id:'u',kind,at:at(1)}),wall,10).changed,true,kind);assert.equal(p.frame(20,idle),undefined,kind+' answers attention');
 }
});

test('attention queued behind a teleport is cancelled by a matching update and does not resume',()=>{
 const attention=new AttentionLifecycle(),cues=new PresentationCues(new CueLedger(),attention);
 const raised=pointOf(attention.observe(agentMessage({id:'n1',at:at(0)}),wall,0));
 cues.request(raised,0);assert.equal(cues.request(teleport('t',10),10),'started');assert.equal(cues.pending?.id,raised.id);
 attention.observe(agentMessage({id:'w1',kind:'working',at:at(5)}),wall,20);
 assert.equal(cues.frame(30,idle)?.kind,'teleport','the teleport itself is unaffected');assert.equal(cues.pending,undefined);
 assert.equal(cues.frame(10+cueSpec.teleport.ms,idle),undefined,'nothing resumes once the teleport ends');
 // A newly queued cue that is answered while it waits is also dropped.
 const later=pointOf(attention.observe(agentMessage({id:'n2',at:at(20)}),wall,40));cues.request(teleport('t2',40),40);assert.equal(cues.request(later,41),'queued');
 attention.observe(agentMessage({id:'c2',kind:'completed',at:at(30)}),wall,50);assert.equal(cues.frame(40+cueSpec.teleport.ms,idle),undefined);
});

test('updates for another agent, project or task and manual previews keep their attention',()=>{
 const attention=new AttentionLifecycle(),cues=new PresentationCues(new CueLedger(),attention);
 const raised=pointOf(attention.observe(agentMessage({id:'n1',at:at(0)}),wall,0));cues.request(raised,0);
 for(const patch of [{agent:'claude'},{taskId:'task-2'},{project:'other'}])assert.equal(attention.observe(agentMessage({id:'x'+JSON.stringify(patch),kind:'completed',at:at(10),...patch}),wall,10).changed,false);
 assert.equal(cues.frame(100,idle)?.id,raised.id,'unrelated completions leave it showing');
 const preview=previewAttentionCue(200);assert.equal(cues.request(preview,200),'started');
 attention.observe(agentMessage({id:'c1',kind:'completed',at:at(20)}),wall,210);
 assert.equal(cues.frame(220,idle)?.id,preview.id,'a manual preview is never cancelled by agent events');
 const open=pointOf(new AttentionLifecycle().observe(agentMessage({id:'n9',project:' Capri ',at:at(0)}),wall,0));
 assert.equal(attentionKey({agent:'codex',project:'capri',taskId:'task-1 '}),(open as {key?:string}).key,'routing identity tolerates whitespace and case');
});

test('progress from a new run or integration session of the same task clears coordinator attention',()=>{
 const attention=new AttentionLifecycle(),cues=new PresentationCues(new CueLedger(),attention);
 cues.request(pointOf(attention.observe(agentMessage({id:'n1',sessionId:'coordinator',at:at(0)}),wall,0)),0);
 assert.equal(attention.observe(agentMessage({id:'s1',sessionId:'run-2',kind:'started',at:at(5)}),wall,10).changed,true);
 assert.equal(cues.frame(20,idle),undefined);
 assert.equal(attention.observe(agentMessage({id:'n0',sessionId:'coordinator',at:at(1)}),wall,30).cue,undefined,'the old run cannot raise it again');
});

test('a delayed older needs_input never resurrects attention after a newer matching completion',()=>{
 const attention=new AttentionLifecycle(),cues=new PresentationCues(new CueLedger(),attention);let panel=emptyAgentActivity;
 const deliver=(message:unknown,now:number)=>{panel=reduceAgentActivity(panel,message);return attention.observe(message,wall,now);};
 assert.equal(deliver(agentMessage({id:'c1',kind:'completed',at:at(10)}),0).changed,false);
 const late=deliver(agentMessage({id:'n1',at:at(0)}),5);assert.equal(late.cue,undefined);assert.equal(late.changed,false);
 assert.equal(cues.frame(10,idle),undefined);assert.equal(panel.latest.codex?.kind,'completed','the activity panel keeps the newer completion as well');assert.equal(agentAttention(panel),undefined);
 assert.equal(deliver(agentMessage({id:'n-tie',at:at(10)}),6).cue,undefined,'a needs_input at the same instant as the completion is already answered');
 // A newer needs_input supersedes an older one, and the older one arriving late is ignored.
 const fresh=pointOf(deliver(agentMessage({id:'n3',at:at(30)}),7));cues.request(fresh,7);
 assert.equal(deliver(agentMessage({id:'n2',at:at(20)}),8).cue,undefined);assert.equal(cues.frame(9,idle)?.id,fresh.id);
 assert.equal(deliver(agentMessage({id:'c0',kind:'completed',at:at(25)}),9).changed,false,'an older completion does not answer newer attention');assert.equal(cues.frame(10,idle)?.id,fresh.id);
 const replaced=pointOf(deliver(agentMessage({id:'n4',at:at(40)}),11));assert.equal(attention.superseded(fresh),true,'the newer request replaces the older label');
 assert.equal(cues.request(replaced,11),'started');assert.equal(cues.frame(12,idle)?.id,replaced.id);
 assert.equal(deliver(agentMessage({id:'n4',at:at(40)}),12).cue,undefined,'a redelivered event raises nothing');
});

test('the attention lifecycle stays bounded and main.tsx prunes answered cues through the live scope',()=>{
 const attention=new AttentionLifecycle();for(let i=0;i<ATTENTION_KEY_LIMIT+50;i++)attention.observe(agentMessage({id:'w'+i,kind:'working',taskId:'t'+i,at:at(i)}),wall,0);
 assert.equal((attention as unknown as {entries:Map<string,unknown>}).entries.size,ATTENTION_KEY_LIMIT);
 assert.equal(attentionLifecycle('test:scope'),attentionLifecycle('test:scope'));
 const source=readFileSync('src/ui/main.tsx','utf8');assert.match(source,/attentionLifecycle\('live'\)/);assert.match(source,/setLiveCues\(old=>old\.filter\(c=>!attention\.superseded\(c\)\)\)/);
 assert.match(readFileSync('src/ui/SpriteAvatar.tsx','utf8'),/new PresentationCues\(cueScope\?cueLedger\(cueScope\):undefined,cueScope\?attentionLifecycle\(cueScope\):undefined\)/);
});

test('only an explicit, undocked mode change teleports',()=>{
 const follow=companion({});const call=companion({preferred:'call',mode:'call',following:false});const free=companion({preferred:'free',mode:'free',following:false});
 assert.equal(teleportCue(undefined,call,1),undefined,'first state never teleports');
 assert.deepEqual(teleportCue(follow,free,1),{kind:'teleport',id:'teleport:follow:free:1',at:1,to:'free'});
 assert.equal(teleportCue(follow,call,1)?.kind,'teleport');
 assert.equal(teleportCue(follow,companion({mode:'call',gameDocked:true,following:false}),1),undefined,'game docking is not explicit');
 assert.equal(teleportCue(companion({mode:'call',gameDocked:true}),follow,1),undefined,'undocking after a game is not explicit');
 assert.equal(teleportCue(follow,companion({lean:3,idleMs:5000}),1),undefined,'ordinary updates do not teleport');
 assert.equal(teleportCue(follow,{...free,hidden:true},1),undefined);
});

test('the idle flourish preference is renderer-local and defaults on',()=>{
 const store=new Map<string,string>();const storage={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>void store.set(k,v)};
 assert.equal(idleFlourishEnabled(storage),true);setIdleFlourish(false,storage);assert.equal(idleFlourishEnabled(storage),false);setIdleFlourish(true,storage);assert.equal(idleFlourishEnabled(storage),true);
 assert.equal(idleFlourishEnabled({getItem:()=>{throw Error('blocked');}}),true);assert.equal(idleFlourishEnabled(undefined),true);
});
