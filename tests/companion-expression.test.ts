import test from 'node:test';
import assert from 'node:assert/strict';
import {SpriteState,STILL,cues,cueLength,poseMatrix,sampleCue,scalePose,type Cue,type Pose} from '../src/ui/sprite-state';
type Options=NonNullable<Parameters<SpriteState['update']>[1]>;
const near=(actual:number,expected:number,message?:string)=>assert.ok(Math.abs(actual-expected)<1e-9,(message||'')+' expected '+expected+' got '+actual);
const still=(pose:Pose)=>{for(const key of Object.keys(STILL) as (keyof Pose)[])near(pose[key],STILL[key],key);};
/** Steps the machine like the renderer does (about 30 fps) and returns the last beat. */
function run(sprite:SpriteState,from:number,to:number,options:Options,step=32){let beat=sprite.update(from,options);for(let now=from+step;now<=to;now+=step)beat=sprite.update(now,options);return beat;}
test('success is a short hop with a grin and an afterimage flourish that settles back to rest',()=>{
 const sprite=new SpriteState();sprite.update(0,{});
 const start=sprite.update(100,{state:'success'});assert.equal(start.clip,'grin');assert.equal(start.reaction,'success');
 const key=sprite.update(300,{state:'success'});near(key.pose.y,-10);assert.ok(key.pose.sy>1&&key.pose.glow>.9);
 const done=sprite.update(100+cueLength('success')+10,{state:'success'});assert.equal(done.reaction,undefined);still(done.pose);
 assert.notEqual(sprite.update(1800,{state:'success'}).clip,'grin');
});
test('error flinches with a brief glitch, which game docking suppresses entirely',()=>{
 const sprite=new SpriteState();sprite.update(0,{});
 assert.equal(sprite.update(100,{state:'error'}).clip,'glitch');near(sprite.update(145,{state:'error'}).pose.x,-6);
 const after=sprite.update(900,{state:'error'});assert.equal(after.clip,'idle');assert.equal(after.reaction,undefined);still(after.pose);
 assert.equal(sprite.update(950,{state:'error',perched:true}).clip,'perch');
 const docked=new SpriteState();docked.update(0,{game:true});
 for(const now of [100,145,300]){const beat=docked.update(now,{state:'error',game:true});assert.notEqual(beat.clip,'glitch');still(beat.pose);}
});
test('intensity scales every motion delta proportionally and zero intensity is still',()=>{
 const at=(intensity:number,t:number)=>{const sprite=new SpriteState();sprite.update(0,{intensity});sprite.update(100,{state:'success',intensity});return sprite.update(100+t,{state:'success',intensity}).pose;};
 for(const t of [200,440]){const base=at(1,t);for(const k of [.25,.5]){const scaled=at(k,t);near(scaled.y,base.y*k,'y');near(scaled.rotate,base.rotate*k,'rotate');near(scaled.sx-1,(base.sx-1)*k,'sx');near(scaled.sy-1,(base.sy-1)*k,'sy');near(scaled.glow,base.glow*k,'glow');}}
 assert.ok(Math.abs(at(1.5,200).y)>Math.abs(at(1,200).y));
 still(at(0,200));still(at(-1,200));still(at(NaN,200));
 still(new SpriteState().update(5000,{state:'error',intensity:0}).pose);
});
test('reduced motion keeps meaningful still expressions but drops movement, frames and flourishes',()=>{
 const sprite=new SpriteState();sprite.update(0,{motion:false});
 const success=sprite.update(300,{state:'success',motion:false});assert.equal(success.clip,'grin');assert.equal(success.frame,0);still(success.pose);
 const error=sprite.update(2500,{state:'error',motion:false});assert.notEqual(error.clip,'glitch');still(error.pose);
 still(run(sprite,3000,3400,{state:'listening',motion:false}).pose);
 assert.notEqual(sprite.update(200000,{idleMs:200000,motion:false}).clip,'sleep');
});
test('listening perks up then leans in, and the lean releases smoothly when listening ends',()=>{
 const sprite=new SpriteState();sprite.update(980,{});
 const perk=sprite.update(1000,{state:'listening'});assert.equal(perk.reaction,'listening');assert.equal(perk.clip,'idle');
 assert.ok(sprite.update(1090,{state:'listening'}).pose.y<-4);
 const held=run(sprite,1120,1600,{state:'listening'},20);assert.equal(held.reaction,undefined);near(held.pose.rotate,2.5);near(held.pose.y,-3);
 const releasing=run(sprite,1620,1700,{},20);assert.ok(releasing.pose.rotate>0&&releasing.pose.rotate<2.5);
 still(run(sprite,1720,2000,{},20).pose);
 assert.equal(sprite.update(2010,{state:'speaking'}).mouth,true);
});
test('thinking tilts away in a slow sway without changing the clip or speaking mouth',()=>{
 const sprite=new SpriteState();sprite.update(980,{});
 const beat=run(sprite,1000,2000,{state:'thinking'},20);assert.equal(beat.clip,'idle');assert.equal(beat.mouth,false);
 assert.ok(beat.pose.rotate<-1.5&&beat.pose.rotate>-4.5);near(beat.pose.x,-2);
});
test('sleep settles in gradually, wakes gracefully for a reaction and does not doze straight back off',()=>{
 const sprite=new SpriteState();sprite.update(129980,{});
 const doze=sprite.update(130000,{idleMs:130000});assert.equal(doze.clip,'sleep');assert.equal(doze.reaction,'settle');assert.ok(Math.abs(doze.pose.y)<1);
 const asleep=run(sprite,130020,131500,{idleMs:131500},20);assert.equal(asleep.clip,'sleep');assert.ok(asleep.pose.y>3,'sleeping sinks slightly');
 const woken=sprite.update(131520,{state:'success',idleMs:131520});assert.equal(woken.clip,'wake');assert.equal(woken.reaction,'wake');
 assert.equal(sprite.update(132000,{state:'success',idleMs:132000}).clip,'wake');
 assert.equal(sprite.update(132500,{state:'success',idleMs:132500}).clip,'grin','the grin follows the wake-up');
 const fading=sprite.update(132520,{state:'success',idleMs:132520});assert.ok(fading.pose.y<asleep.pose.y);
 assert.notEqual(sprite.update(140000,{idleMs:140000}).clip,'sleep');
 assert.equal(sprite.update(170000,{idleMs:170000}).clip,'sleep');
 const errorWake=new SpriteState();errorWake.update(0,{idleMs:130000});
 assert.equal(errorWake.update(100,{state:'error',idleMs:130000}).clip,'wake');assert.equal(errorWake.update(1000,{state:'error',idleMs:130000}).clip,'glitch');
});
test('a click pokes, but never interrupts a more important reaction',()=>{
 const sprite=new SpriteState();sprite.update(0,{});sprite.react(50);
 const poke=sprite.update(100,{});assert.equal(poke.clip,'grin');assert.equal(poke.reaction,'poke');assert.ok(poke.pose.y!==0);
 sprite.update(1000,{state:'success'});sprite.react(1050);assert.equal(sprite.update(1100,{state:'success'}).reaction,'success');
});
test('seated and dragged poses keep window contact and the drag clip',()=>{
 const sprite=new SpriteState();sprite.update(0,{perched:true});sprite.update(100,{state:'success',perched:true});
 const seated=sprite.update(400,{state:'success',perched:true});near(seated.pose.x,0);near(seated.pose.y,0);assert.ok(seated.pose.sy>1);assert.ok(Math.abs(seated.pose.rotate)>.1);
 // Apply the full canvas transform: her feet stay on the window edge under rotation, lean and squash; her head does move.
 const apply=([a,b,c,d,e,f]:number[],x:number,y:number)=>[a*x+c*y+e,b*x+d*y+f];const W=480,H=600,h=500;
 for(const lean of [0,8,-8]){const m=poseMatrix(seated.pose,lean,W,H,h);const [fx,fy]=apply(m,0,0);near(fx,W/2,'feet x');near(fy,H/2+h/2,'feet y');const [hx,hy]=apply(m,0,-h);assert.ok(Math.abs(hx-W/2)>1&&hy<H/2-h/2+1e-9,'head moves with the pose');}
 const free:Pose={x:3,y:-6,rotate:2,sx:1.03,sy:.97,glow:0};const [fx,fy]=apply(poseMatrix(free,0,W,H,h),0,0);near(fx,W/2+3);near(fy,H/2+h/2-6);
 const rest=poseMatrix(STILL,0,W,H,h);const [lx,ty]=apply(rest,-150,-h);near(lx,W/2-150);near(ty,H/2-h/2,'rest keeps the original centred placement');
 const dragged=sprite.update(420,{state:'success',perched:true,dragging:true});assert.equal(dragged.clip,'dangle');still(dragged.pose);
});
test('the newest outcome supersedes a pending grin or glitch in both directions',()=>{
 const grinThenGlitch=new SpriteState();grinThenGlitch.update(0,{});grinThenGlitch.update(100,{state:'success'});
 const flinch=grinThenGlitch.update(200,{state:'error'});assert.equal(flinch.clip,'glitch');assert.equal(flinch.reaction,'error');
 for(let now=232;now<=4000;now+=32){const beat=grinThenGlitch.update(now,{state:'error'});assert.notEqual(beat.clip,'grin','no stale grin at '+now);assert.notEqual(beat.reaction,'success');}
 const glitchThenGrin=new SpriteState();glitchThenGrin.update(0,{});assert.equal(glitchThenGrin.update(100,{state:'error'}).clip,'glitch');
 const cheer=glitchThenGrin.update(200,{state:'success'});assert.equal(cheer.clip,'grin');assert.equal(cheer.reaction,'success');
 for(let now=232;now<=4000;now+=32){const beat=glitchThenGrin.update(now,{state:'success'});assert.notEqual(beat.clip,'glitch','no stale glitch at '+now);assert.notEqual(beat.reaction,'error');}
});
test('game docking holds the success grin still and suppresses its movement',()=>{
 const docked=new SpriteState();docked.update(0,{game:true});
 for(const now of [100,300,500,900,1400]){const beat=docked.update(now,{state:'success',game:true});assert.equal(beat.clip,'grin');assert.equal(beat.frame,0,'frame at '+now);still(beat.pose);}
 const free=new SpriteState();free.update(0,{});free.update(100,{state:'success'});assert.ok(free.update(500,{state:'success'}).frame>0,'undocked grin still animates');
});
test('game docking freezes every body clip and never dozes, blinks or glitches, while the speaking mouth still works',()=>{
 const docked=new SpriteState();
 for(let now=0;now<=60000;now+=50){
  const beat=docked.update(now,{game:true,idleMs:130000+now,perched:now>30000,state:now>=20000&&now<21000?'speaking':'idle'});
  assert.equal(beat.frame,0,'frame at '+now);assert.ok(beat.clip==='idle'||beat.clip==='perch','clip '+beat.clip+' at '+now);still(beat.pose);
  if(now>=20000&&now<21000)assert.equal(beat.mouth,true);
 }
 const dragged=docked.update(60100,{game:true,dragging:true});assert.equal(dragged.clip,'dangle');assert.equal(dragged.frame,0);
 for(const state of ['listening','thinking','success','error'] as const){const sprite=new SpriteState();sprite.update(0,{game:true});
  for(const now of [100,300,700,1200]){const beat=sprite.update(now,{state,game:true});assert.equal(beat.frame,0,state+' frame at '+now);assert.notEqual(beat.clip,'glitch');assert.notEqual(beat.clip,'wake');still(beat.pose);}}
});
test('entering game docking while asleep or waking stops sleep and wake animation, and outcomes apply at once',()=>{
 const asleep=()=>{const sprite=new SpriteState();sprite.update(0,{});run(sprite,130000,131000,{idleMs:131000});assert.equal(sprite.update(131020,{idleMs:131020}).clip,'sleep');return sprite;};
 const dozing=asleep();
 for(const now of [131100,131400,132000,135000]){const beat=dozing.update(now,{game:true,idleMs:now});assert.equal(beat.clip,'idle','asleep docked at '+now);assert.equal(beat.frame,0);still(beat.pose);}
 const cheer=dozing.update(135100,{state:'success',game:true,idleMs:135100});assert.equal(cheer.clip,'grin','docked success needs no wake-up');assert.equal(cheer.frame,0);still(cheer.pose);
 assert.equal(dozing.update(135500,{state:'success',game:true,idleMs:135500}).frame,0);
 const outcome=asleep();
 const alarm=outcome.update(131100,{state:'error',game:true,idleMs:131100});assert.notEqual(alarm.clip,'wake');assert.notEqual(alarm.clip,'glitch');assert.notEqual(alarm.clip,'sleep');assert.equal(alarm.frame,0);still(alarm.pose);
 const waking=asleep();assert.equal(waking.update(131100,{state:'success',idleMs:131100}).clip,'wake');
 for(const now of [131300,131700,132100,132600]){const beat=waking.update(now,{state:'success',game:true,idleMs:now});assert.equal(beat.clip,'grin','waking docked shows the grin at once at '+now);assert.equal(beat.frame,0);still(beat.pose);}
});
test('outcomes at the wake boundary while docked stay frozen in both directions, and undocking restores motion',()=>{
 for(const [first,second] of [['success','error'],['error','success']] as const){
  const sprite=new SpriteState();sprite.update(0,{idleMs:130000});assert.equal(sprite.update(100,{state:first,idleMs:130000}).clip,'wake');
  for(const now of [500,900,1000,1045,1300,2000]){const state=now>=1000?second:first;const beat=sprite.update(now,{state,game:true,idleMs:130000});
   assert.equal(beat.frame,0,first+'→'+second+' at '+now);assert.notEqual(beat.clip,'wake');assert.notEqual(beat.clip,'glitch');assert.notEqual(beat.clip,'sleep');still(beat.pose);}
  if(second==='success')assert.equal(sprite.update(2100,{state:'success',game:true,idleMs:130000}).clip,'grin','newest outcome shows');
  const free=run(sprite,3000,4000,{});assert.equal(free.clip,'idle');assert.ok(free.frame>0,'undocked idle animates again');
  sprite.update(4100,{state:'success'});assert.ok(sprite.update(4300,{state:'success'}).pose.glow>.5,'undocked flourish returns');
  run(sprite,31000,31100,{});assert.equal(sprite.update(31200,{idleMs:130000}).clip,'sleep','undocked she can doze again');
 }
});
test('a reaction that wakes her waits for the full wake clip before its cue plays',()=>{
 const wakeMs=13/15*1000;
 const sprite=new SpriteState();sprite.update(0,{idleMs:130000});const at=100,after=at+wakeMs;
 assert.equal(sprite.update(at,{state:'success',idleMs:130000}).reaction,'wake');
 for(const now of [400,700,after-5]){const beat=sprite.update(now,{state:'success',idleMs:130000});assert.equal(beat.clip,'wake');assert.notEqual(beat.reaction,'success');near(beat.pose.glow,0,'no flourish during wake');}
 const key=sprite.update(after+200,{state:'success',idleMs:130000});assert.equal(key.clip,'grin');assert.equal(key.reaction,'success');near(key.pose.glow,1,'success key pose lands 200ms after waking');
 assert.equal(sprite.update(after+cueLength('success')-10,{state:'success',idleMs:130000}).reaction,'success','the whole cue plays after waking');
 assert.equal(sprite.update(after+cueLength('success')+10,{state:'success',idleMs:130000}).reaction,undefined);
 const alarmed=new SpriteState();alarmed.update(0,{idleMs:130000});alarmed.update(at,{state:'error',idleMs:130000});
 const waiting=alarmed.update(after-5,{state:'error',idleMs:130000});assert.equal(waiting.clip,'wake');assert.notEqual(waiting.reaction,'error');
 const flinch=alarmed.update(after+45,{state:'error',idleMs:130000});assert.equal(flinch.clip,'glitch');assert.equal(flinch.reaction,'error');near(flinch.pose.x,-6);
 assert.equal(alarmed.update(after+cueLength('error')-10,{state:'error',idleMs:130000}).reaction,'error');
});
test('a newer outcome at the wake boundary supersedes a queued older one in both directions',()=>{
 const after=100+13/15*1000;
 // Error arrives after the queued success came due but before any frame promoted it.
 const late=new SpriteState();late.update(0,{idleMs:130000});late.update(100,{state:'success',idleMs:130000});
 assert.equal(late.update(1000,{state:'error',idleMs:130000}).reaction,'error');
 const flinch=late.update(1045,{state:'error',idleMs:130000});assert.equal(flinch.clip,'glitch');assert.equal(flinch.reaction,'error');near(flinch.pose.x,-6,'error flinch, not a success hop');
 assert.equal(late.update(1200,{state:'error',idleMs:130000}).reaction,'error','stale success never returns');
 // Success arrives after the queued error came due.
 const relief=new SpriteState();relief.update(0,{idleMs:130000});relief.update(100,{state:'error',idleMs:130000});
 assert.equal(relief.update(1000,{state:'success',idleMs:130000}).reaction,'success');
 const hop=relief.update(1200,{state:'success',idleMs:130000});assert.equal(hop.clip,'grin');assert.equal(hop.reaction,'success');near(hop.pose.glow,1);near(hop.pose.x,0,'no error shake');
 // A newer outcome while still waking replaces the queued one and waits for the wake to finish.
 const early=new SpriteState();early.update(0,{idleMs:130000});early.update(100,{state:'success',idleMs:130000});early.update(500,{state:'error',idleMs:130000});
 assert.notEqual(early.update(after-5,{state:'error',idleMs:130000}).reaction,'success');
 const shake=early.update(after+45,{state:'error',idleMs:130000});assert.equal(shake.reaction,'error');assert.equal(shake.clip,'glitch');near(shake.pose.x,-6);
});
test('every reaction returns to rest and scaled poses stay inside the canvas margin',()=>{
 for(const cue of Object.keys(cues) as Cue[]){still(sampleCue(cue,0)!);still(sampleCue(cue,cueLength(cue)-1e-6)!);assert.equal(sampleCue(cue,cueLength(cue)),undefined);assert.equal(sampleCue(cue,-1),undefined);}
 const wild=scalePose({x:100,y:-100,rotate:30,sx:2,sy:0,glow:5},2);
 near(wild.x,14);near(wild.y,-14);near(wild.rotate,5);assert.ok(wild.sx<=1.05+1e-9&&wild.sy>=.95-1e-9&&wild.glow===1);
 still(scalePose({x:5,y:5,rotate:5,sx:1.1,sy:1.1,glow:1},Infinity));
});
