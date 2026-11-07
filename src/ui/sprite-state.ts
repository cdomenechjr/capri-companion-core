import type {State} from '../shared';
export const clips={idle:[16,8,1.11],blink:[4,8,1.11],blink_glitch:[4,8,1.11],grin:[16,8,1.11],glitch:[10,15,1.11],dangle:[24,10,1.11],sleep:[16,6,1.11],wake:[13,15,1.11],perch:[16,8,1],perch_blink:[4,8,1],perch_blink_glitch:[4,8,1],perch_glitch:[10,15,1],mouth:[5,12,1.11]} as const;
export type ClipName=keyof typeof clips;
/** Canvas transform layered over the sprite clip: offsets in canvas px, rotate in degrees, scale anchored at her feet, glow drives the afterimage flourish. */
export type Pose={x:number;y:number;rotate:number;sx:number;sy:number;glow:number};
export const STILL:Pose=Object.freeze({x:0,y:0,rotate:0,sx:1,sy:1,glow:0});
export type Cue='success'|'error'|'listening'|'thinking'|'poke'|'wake'|'settle';
type Key=readonly [ms:number,pose:Partial<Pose>];
// Short exposure sheets (idea from upstream acting.js, natively reimplemented): anticipation, key pose, settle.
export const cues:Record<Cue,{priority:number;keys:readonly Key[]}>={
 success:{priority:3,keys:[[90,{y:4,sx:1.03,sy:.96}],[110,{y:-10,sx:.98,sy:1.03,glow:1}],[240,{y:-8,rotate:1.5,glow:.6}],[140,{y:2,sx:1.02,sy:.98,glow:.2}],[220,{}]]},
 error:{priority:3,keys:[[45,{x:-6,rotate:-1.5,glow:1}],[45,{x:5,rotate:1.2,glow:.8}],[45,{x:-4,rotate:-.8,glow:.5}],[50,{x:2}],[260,{y:3,rotate:-2,sy:.985}],[320,{}]]},
 listening:{priority:2,keys:[[90,{y:-5,sy:1.02}],[200,{}]]},
 thinking:{priority:2,keys:[[160,{x:1,rotate:1}],[260,{}]]},
 poke:{priority:1,keys:[[70,{y:2,sx:1.015,sy:.98}],[110,{y:-6,sy:1.02}],[220,{}]]},
 wake:{priority:1,keys:[[140,{y:3,sx:1.02,sy:.97}],[180,{y:-5,sx:.985,sy:1.03}],[320,{}]]},
 settle:{priority:1,keys:[[300,{y:2,rotate:-1}],[200,{y:-1,rotate:.5}],[500,{}]]},
};
export const cueLength=(cue:Cue)=>cues[cue].keys.reduce((sum,[ms])=>sum+ms,0);
const WAKE_MS=13/15*1000,GLITCH_MS=10/15*1000,STAY_AWAKE_MS=30000;
type Hold='listening'|'thinking'|'sleep';
const holdRate:Record<Hold,number>={listening:200,thinking:320,sleep:900};
const smooth=(t:number)=>t*t*(3-2*t);
const mix=(a:Pose,b:Pose,t:number):Pose=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,rotate:a.rotate+(b.rotate-a.rotate)*t,sx:a.sx+(b.sx-a.sx)*t,sy:a.sy+(b.sy-a.sy)*t,glow:a.glow+(b.glow-a.glow)*t});
const add=(a:Pose,b:Pose):Pose=>({x:a.x+b.x,y:a.y+b.y,rotate:a.rotate+b.rotate,sx:a.sx+b.sx-1,sy:a.sy+b.sy-1,glow:a.glow+b.glow});
const clamp=(v:number,low:number,high:number)=>Math.min(high,Math.max(low,v));
export function sampleCue(cue:Cue,t:number):Pose|undefined{
 if(!(t>=0))return undefined;let start=0,from:Pose=STILL;
 for(const [ms,to] of cues[cue].keys){const target={...STILL,...to};if(t<start+ms)return mix(from,target,smooth((t-start)/ms));start+=ms;from=target;}
 return undefined;
}
/** Sustained attitude while a state lasts: leaning in to listen, a slow pondering sway, sleepy breathing. */
export function holdPose(kind:Hold,now:number):Pose{
 if(kind==='listening')return {x:0,y:-3,rotate:2.5,sx:1.012,sy:1.012,glow:0};
 if(kind==='thinking')return {x:-2,y:-2+Math.sin(now/700),rotate:-3+Math.sin(now/1300)*1.2,sx:1,sy:1,glow:0};
 const breath=Math.sin(now/1500);return {x:0,y:5+breath*1.5,rotate:-1.5,sx:1,sy:1+breath*.008,glow:0};
}
/** Intensity scales every motion delta proportionally; seated poses keep their ledge contact; limits keep her inside the canvas margin. */
export function scalePose(pose:Pose,intensity:number,perched=false):Pose{
 const k=Number.isFinite(intensity)?clamp(intensity,0,2):0;if(k<=0)return STILL;
 return {x:perched?0:clamp(pose.x*k,-14,14),y:perched?0:clamp(pose.y*k,-14,14),rotate:clamp(pose.rotate*k,-5,5),sx:1+clamp((pose.sx-1)*k,-.05,.05),sy:1+clamp((pose.sy-1)*k,-.05,.04),glow:clamp(pose.glow*Math.min(1,k),0,1)};
}
/**
 * Canvas matrix [a,b,c,d,e,f] for the whole pose. Rotation (pose plus companion lean) and scale share one pivot at her
 * feet, so the window contact point stays put; draw the frame with its bottom centre at the local origin.
 */
export function poseMatrix(pose:Pose,lean:number,width:number,height:number,spriteHeight:number):[number,number,number,number,number,number]{
 const angle=((Number.isFinite(lean)?lean:0)+pose.rotate)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
 return [cos*pose.sx,sin*pose.sx,-sin*pose.sy,cos*pose.sy,width/2+pose.x,height/2+spriteHeight/2+pose.y];
}
export class SpriteState{
 private clip:ClipName='idle';private since=0;private nextBlink=3000;private nextGlitch=35000;private blinkCount=0;private sleeping=false;private reactionUntil=0;
 private state:State='idle';private alertUntil=0;private awakeUntil=0;private cue?:{name:Cue;at:number};private queued?:{name:Cue;at:number};private hold?:Hold;private holdWeight=0;private last=0;
 private waking(now:number){return this.clip==='wake'&&now-this.since<WAKE_MS;}
 private wake(now:number){this.sleeping=false;this.clip='wake';this.since=now;this.awakeUntil=now+STAY_AWAKE_MS;this.queued=undefined;this.play('wake',now);}
 /** Starts a transient reaction unless a more important one is still playing; a future start waits in the queue. */
 play(name:Cue,now:number,at=now){
  if(at>now){this.queued={name,at};return;}
  const current=this.cue;if(current&&now-current.at<cueLength(current.name)&&cues[current.name].priority>cues[name].priority)return;this.cue={name,at};
 }
 react(now:number){if(this.sleeping){this.wake(now);this.reactionUntil=0;}else{this.reactionUntil=now+2000;this.play('poke',now);}}
 private enter(state:State,now:number){
  this.state=state;
  if((state==='success'||state==='error')&&this.sleeping)this.wake(now);
  // A reaction that wakes her starts once she has finished waking up.
  const after=now+(this.waking(now)?WAKE_MS-(now-this.since):0);
  // The newest outcome wins: a success clears a pending glitch, an error clears a pending grin, and neither keeps a stale queued cue.
  if(state==='success'||state==='error')this.queued=undefined;
  if(state==='success'){this.alertUntil=0;this.reactionUntil=after+1600;this.play(state,now,after);}
  if(state==='error'){this.reactionUntil=0;this.alertUntil=after+GLITCH_MS;this.nextGlitch=Math.max(this.nextGlitch,now+45000);this.play(state,now,after);}
  if(state==='listening'||state==='thinking')this.play(state,now);
 }
 update(now:number,{perched=false,dragging=false,state='idle',idleMs=0,motion=true,game=false,intensity=1}:{perched?:boolean;dragging?:boolean;state?:State;idleMs?:number;motion?:boolean;game?:boolean;intensity?:number}){
  // A cue that came due before this frame starts first, so a state change in the same frame can supersede it.
  const promote=()=>{if(this.queued&&now>=this.queued.at){this.cue=this.queued;this.queued=undefined;}};
  // Game docking has no sleep or wake-up animation: she is simply awake and reactions apply immediately.
  if(game&&(this.sleeping||this.clip==='wake')){this.sleeping=false;this.clip=perched?'perch':'idle';this.since=now;}
  promote();if(state!==this.state)this.enter(state,now);promote();
  let wanted:ClipName=perched?'perch':'idle';
  if(dragging)wanted='dangle';
  else if(state==='speaking'||state==='thinking'||state==='working'||state==='listening'){if(this.sleeping)this.wake(now);wanted=this.waking(now)?'wake':wanted;}
  else if(now<this.alertUntil&&motion&&!game&&!this.waking(now))wanted=perched?'perch_glitch':'glitch';
  else if(now<this.reactionUntil&&!this.waking(now))wanted='grin';
  else if(idleMs>=120000&&!perched&&motion&&!game&&now>=this.awakeUntil){if(!this.sleeping)this.play('settle',now);this.sleeping=true;wanted='sleep';}
  else if(this.sleeping){this.wake(now);wanted='wake';}
  else if(this.waking(now))wanted='wake';
  else if(motion&&!game&&now>=this.nextGlitch){wanted=perched?'perch_glitch':'glitch';this.nextGlitch=now+45000;}
  else if((this.clip==='glitch'||this.clip==='perch_glitch')&&now-this.since<GLITCH_MS&&!game)wanted=this.clip;
  else if(motion&&!game&&now>=this.nextBlink){this.blinkCount++;wanted=perched?(this.blinkCount%5===0?'perch_blink_glitch':'perch_blink'):(this.blinkCount%5===0?'blink_glitch':'blink');this.nextBlink=now+4000;}
  else if(!game&&(['blink','perch_blink','blink_glitch','perch_blink_glitch'].includes(this.clip))&&now-this.since<500)wanted=this.clip;
  if(wanted!==this.clip){this.clip=wanted;this.since=now;}
  // Game docking and reduced motion hold every body clip on its first frame; the speaking mouth still follows real playback.
  const [frames,fps,height]=clips[this.clip];const frame=motion&&!game?Math.floor((now-this.since)*fps/1000)%frames:0;
  return {clip:this.clip,frame,height,mouth:state==='speaking'&&this.clip==='idle',pose:this.pose(now,state,{perched,dragging,motion,game,intensity}),reaction:this.reaction(now)};
 }
 private reaction(now:number){const cue=this.cue;return cue&&now-cue.at<cueLength(cue.name)?cue.name:undefined;}
 private pose(now:number,state:State,{perched,dragging,motion,game,intensity}:{perched:boolean;dragging:boolean;motion:boolean;game:boolean;intensity:number}):Pose{
  const dt=clamp(now-this.last,0,1000);this.last=now;
  const target:Hold|undefined=this.sleeping?'sleep':state==='listening'||state==='thinking'?state:undefined;
  if(target&&(this.hold===target||this.holdWeight<=0)){this.hold=target;this.holdWeight=Math.min(1,this.holdWeight+dt/holdRate[target]);}
  else if(this.hold){this.holdWeight=Math.max(0,this.holdWeight-dt/holdRate[this.hold]);if(this.holdWeight<=0)this.hold=undefined;}
  if(!motion||game||dragging||!(intensity>0))return STILL;
  let pose=this.hold&&this.holdWeight>0?mix(STILL,holdPose(this.hold,now),smooth(this.holdWeight)):STILL;
  const cue=this.cue&&sampleCue(this.cue.name,now-this.cue.at);if(cue)pose=add(pose,cue);
  return scalePose(pose,intensity,perched);
 }
}
export function mouthShape(state:State,clip:ClipName,level:number){return state==='speaking'&&clip==='idle'&&Number.isFinite(level)&&level>.018?Math.min(4,Math.max(0,Math.floor(level*9))):-1;}
