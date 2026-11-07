import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,rename,link} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {deflateSync} from 'node:zlib';
import {CursorSettingsSchema,CursorStatusSchema} from '../src/extensions/contracts';
import {CursorController,CursorHostError,PrivateCursorCache,validateAni,validateCur,cursorRoles,approvedCursorHashes,
  type CursorNative,type CursorNativeSession,type CursorNativeReply,type CursorFile,type CursorEnvironment,type CursorAccessibility} from '../src/extensions/cursor';

const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
// Original neutral, generated 2x2 solid-colour cursors. No private asset bytes.
function cur(color=0):Buffer{
  const b=Buffer.alloc(22+40+16+8);b.writeUInt16LE(2,2);b.writeUInt16LE(1,4);b[6]=2;b[7]=2;
  b.writeUInt32LE(64,14);b.writeUInt32LE(22,18);b.writeUInt32LE(40,22);b.writeInt32LE(2,26);b.writeInt32LE(4,30);
  b.writeUInt16LE(1,34);b.writeUInt16LE(32,36);b.fill(color,62,78);return b;
}
function chunk(name:string,data:Buffer):Buffer{const h=Buffer.alloc(8);h.write(name);h.writeUInt32LE(data.length,4);return Buffer.concat([h,data,Buffer.alloc(data.length&1)]);}
function pngChunk(name:string,data:Buffer):Buffer{
  const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(name,4);data.copy(b,8);
  let crc=0xffffffff;for(const value of b.subarray(4,-4)){crc^=value;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}b.writeUInt32BE((crc^0xffffffff)>>>0,b.length-4);return b;
}
function pngCur(options:{color?:number;rows?:Buffer;palette?:Buffer;transparency?:Buffer;pngWidth?:number;interlace?:number;tail?:Buffer}={}):Buffer{
  const color=options.color??6,h=Buffer.alloc(13);h.writeUInt32BE(options.pngWidth??2);h.writeUInt32BE(2,4);h[8]=8;h[9]=color;h[12]=options.interlace??0;
  const rows=options.rows??Buffer.alloc((2*(color===3?1:color===2?3:4)+1)*2);
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',h),
    ...(options.palette?[pngChunk('PLTE',options.palette)]:[]),...(options.transparency?[pngChunk('tRNS',options.transparency)]:[]),
    pngChunk('IDAT',Buffer.concat([deflateSync(rows),options.tail??Buffer.alloc(0)])),pngChunk('IEND',Buffer.alloc(0))]);
  const directory=Buffer.alloc(22);directory.writeUInt16LE(2,2);directory.writeUInt16LE(1,4);directory[6]=2;directory[7]=2;directory.writeUInt32LE(png.length,14);directory.writeUInt32LE(22,18);
  return Buffer.concat([directory,png]);
}
function ani(options:{sequence?:number[];rates?:number[];frames?:Buffer[];headerWidth?:number;headerHeight?:number;steps?:number;rate?:number}={}):Buffer{
  const frames=options.frames??[cur(),cur(90)],seq=options.sequence,steps=options.steps??seq?.length??frames.length,h=Buffer.alloc(36);
  h.writeUInt32LE(36);h.writeUInt32LE(frames.length,4);h.writeUInt32LE(steps,8);h.writeUInt32LE(options.headerWidth??0,12);h.writeUInt32LE(options.headerHeight??0,16);
  h.writeUInt32LE(options.rate??6,28);h.writeUInt32LE(seq?3:1,32);
  const words=(items:number[])=>{const b=Buffer.alloc(items.length*4);items.forEach((v,i)=>b.writeUInt32LE(v,i*4));return b;};
  const payload=Buffer.concat([Buffer.from('ACON'),chunk('anih',h),...(seq?[chunk('seq ',words(seq))]:[]),...(options.rates?[chunk('rate',words(options.rates))]:[]),chunk('LIST',Buffer.concat([Buffer.from('fram'),...frames.map(f=>chunk('icon',f))]))]);
  const head=Buffer.alloc(8);head.write('RIFF');head.writeUInt32LE(payload.length,4);return Buffer.concat([head,payload]);
}
async function fixture(names=['NormalSelect.ani','Busy.ani']){
  const root=await mkdtemp(path.join(os.tmpdir(),'capri-cursor-test-')),source=path.join(root,'source'),cachePath=path.join(root,'private');await mkdir(source);
  const bytes=ani({sequence:[1,0,1]}),hashes=Object.fromEntries(names.map(n=>[n,sha(bytes)]));
  for(const name of names)await writeFile(path.join(source,name),bytes);
  const cache=new PrivateCursorCache(cachePath,hashes);
  return {root,source,cachePath,cache,bytes,hashes,clean:()=>rm(root,{recursive:true,force:true})};
}
const environment:CursorEnvironment={gameDocked:false,locked:false,reducedMotion:false};
const compatibleAccessibility=():CursorAccessibility=>({compatible:true,highContrast:false,pointerBaseSize:32,pointerSize:1});
const incompatibleAccessibility:CursorAccessibility[]=[
  {...compatibleAccessibility(),compatible:false,highContrast:true},
  {...compatibleAccessibility(),compatible:false,pointerBaseSize:64},
  {...compatibleAccessibility(),compatible:false,pointerSize:2},
  {compatible:false,highContrast:null,pointerBaseSize:null,pointerSize:null},
];
const settings=()=>CursorSettingsSchema.parse({enabled:true});

/** Simulation only: models the independent native lease so controller tests never
 * spawn a mutation-capable helper. Native Win32/kill/lock checks remain root-owned. */
class FakeHost implements CursorNative {
  now=10000;owner?:FakeSession;events:string[]=[];roles:CursorFile[]=[];failRole?:number;closeFails=false;dead=false;locked=false;crashMarker=false;recoverFails=false;
  accessibility=compatibleAccessibility();
  safetyReason():'locked'|'accessibility'|undefined {return this.locked?'locked':!this.accessibility.compatible?'accessibility':undefined;}
  async arm(ms:number):Promise<FakeSession>{
    this.events.push('arm');if(this.owner)throw new CursorHostError({ok:false,reason:'owner-conflict'});
    if(this.crashMarker&&this.recoverFails)throw Error('recovery unavailable');
    const recovered=this.crashMarker;this.crashMarker=false;
    return this.owner=new FakeSession(this,ms,recovered);
  }
  restore(){this.events.push('restore');this.roles=[];this.crashMarker=false;}
  advance(ms:number){this.now+=ms;const owner=this.owner;if(owner&&(this.dead||this.now>=owner.expiry)){this.restore();this.owner=undefined;owner.alive=false;}
    else if(owner&&this.roles.length&&this.safetyReason()){owner.suspendedReason=this.safetyReason();this.restore();}}
}
class FakeSession implements CursorNativeSession {
  expiry:number;alive=true;suspendedReason?:'locked'|'accessibility';
  constructor(readonly host:FakeHost,readonly ms:number,readonly recovered:boolean){this.expiry=host.now+ms;}
  async request(action:'heartbeat'|'apply'|'restore'|'status'|'close',files?:CursorFile[]):Promise<CursorNativeReply>{
    const h=this.host;h.events.push(action);
    // An old watchdog cannot mutate or restore after another owner holds the lease.
    if(!this.alive||h.owner!==this)throw Error('stale owner');
    if(action==='heartbeat'){if(h.now>=this.expiry)throw Error('expired');this.expiry=h.now+this.ms;
      const reason=h.safetyReason()??this.suspendedReason;if(reason){h.restore();return {ok:false,reason,accessibility:{...h.accessibility}};}}
    if(action==='apply'){
      const reason=h.safetyReason()??this.suspendedReason;if(reason)return {ok:false,reason,accessibility:{...h.accessibility}};
      h.crashMarker=true;
      for(const file of files!){h.roles.push({...file});if(file.role===h.failRole){h.restore();return {ok:false,reason:'host-unavailable'};}}
    }
    if(action==='close'||action==='restore'){
      if(h.closeFails)return {ok:false,recoveryRequired:true};h.restore();
      if(action==='close'){this.alive=false;h.owner=undefined;}
    }
    return {ok:true,watchdogExpiresAt:this.expiry,accessibility:{...h.accessibility}};
  }
}

test('neutral ANI accepts zero optional dimensions and a sequence longer than frame count; static follows first sequence entry',()=>{
  const b=ani({sequence:[1,0,1],rates:[6,12,18]}),result=validateAni(b,sha(b));
  assert.equal(result.frames,2);assert.equal(result.steps,3);assert.equal(result.durationMs,600);assert.deepEqual(result.firstFrame,cur(90));
  assert.deepEqual(validateCur(result.firstFrame),[{width:2,height:2}]);
});
test('ANI rejects malformed RIFF, duplicate/unsupported chunks, frame/step/rate bounds and hash changes',()=>{
  const valid=ani(),variants:Buffer[]=[];
  for(const [offset,value] of [[4,1],[16,0xffffffff],[20,35],[24,129],[28,0],[32,257],[40,33],[44,2],[48,0],[52,9],[56,9]] as const){const b=Buffer.from(valid);b.writeUInt32LE(value,offset);variants.push(b);}
  variants.push(ani({sequence:[0,2]}),ani({sequence:[0,1],rates:[6]}),ani({rate:601}),ani({rate:600,sequence:Array(7).fill(0)}),ani({steps:3}),ani({headerWidth:3}));
  const disguised=Buffer.from(valid);disguised[0]|=128;variants.push(disguised);
  for(const [i,b] of variants.entries())assert.throws(()=>validateAni(b,sha(b)),`malformed ANI variant ${i}`);
  assert.throws(()=>validateAni(valid,'0'.repeat(64)),/SHA-256/);
  assert.throws(()=>validateAni(valid.subarray(0,30),sha(valid.subarray(0,30))));
  const extra=Buffer.concat([valid,chunk('anih',Buffer.alloc(36))]);extra.writeUInt32LE(extra.length-8,4);assert.throws(()=>validateAni(extra,sha(extra)),/duplicate/);
});
test('CUR rejects hotspot, image overlap/truncation, excessive dimensions and compressed/unsupported bitmap encodings',()=>{
  const valid=cur();
  for(const [offset,width,value] of [[10,2,2],[12,2,2],[14,4,100000],[18,4,0],[22,4,124],[26,4,257],[30,4,2],[34,2,2],[36,2,16],[38,4,1],[42,4,5],[54,4,1]] as const){
    const b=Buffer.from(valid);if(width===2)b.writeUInt16LE(value,offset);else b.writeUInt32LE(value,offset);assert.throws(()=>validateCur(b),`offset ${offset}`);
  }
  assert.throws(()=>validateCur(Buffer.concat([valid,Buffer.from([0])])));
});
test('generated PNG-backed CUR/ANI checks CRC, dimensions, palette indices, row filters and bounded complete inflation',()=>{
  for(const color of [2,6]){const b=ani({frames:[pngCur({color})]});assert.equal(validateAni(b,sha(b)).frames,1);}
  const palette=Buffer.from([0,0,0,255,255,255]),transparency=Buffer.from([0,255]);
  for(let filter=0;filter<=4;filter++)validateCur(pngCur({color:3,palette,transparency,rows:Buffer.from([filter,0,0,filter,0,0])}));
  const badCrc=pngCur();badCrc[45]^=1;
  for(const bytes of [badCrc,pngCur({pngWidth:3}),pngCur({interlace:1}),pngCur({rows:Buffer.alloc(100000)}),
    pngCur({rows:Buffer.alloc(1)}),pngCur({rows:Buffer.from([5,...Array(17).fill(0)])}),pngCur({tail:Buffer.from([0])}),
    pngCur({color:3}),pngCur({color:3,palette:Buffer.alloc(4)}),pngCur({color:3,palette,transparency:Buffer.alloc(3)}),
    pngCur({color:3,palette,rows:Buffer.from([1,1,1,0,0,0])})])assert.throws(()=>validateCur(bytes));
});
test('private import is atomic, ignores unrelated installers, maps Busy independently and preserves absent roles',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.source,'install.cmd'),'never executed');const pack=await f.cache.importFolder(f.source);
    assert.equal(pack.animated.length,3);assert.deepEqual(pack.animated.map(x=>x.role),[32514,32650,32512]);
    assert.equal(pack.animated[0].path,pack.animated[1].path);assert.deepEqual(await readFile(pack.static[0].path),cur(90));
    assert.equal((await readdir(f.cachePath)).length,1);assert.equal((await readdir(pack.directory)).length,4);
    assert.equal(Object.keys(approvedCursorHashes).length,9);assert.equal(Object.keys(cursorRoles).length,9);
    // A malformed second import cannot replace the first committed generation.
    await writeFile(path.join(f.source,'NormalSelect.ani'),Buffer.from('bad'));
    await assert.rejects(f.cache.importFolder(f.source));assert.deepEqual(await readdir(f.cachePath),[path.basename(pack.directory)]);
    assert.equal((await f.cache.load(pack.directory)).animated.length,3);
  }finally{await f.clean();}
});
test('cache rejects case aliases, hardlinks, source/cache aliases and tampered static/animated bytes',async()=>{
  const f=await fixture(['NormalSelect.ani']);try{
    await rename(path.join(f.source,'NormalSelect.ani'),path.join(f.source,'normalselect.ani'));await assert.rejects(f.cache.importFolder(f.source),/aliased/);
    await rename(path.join(f.source,'normalselect.ani'),path.join(f.source,'NormalSelect.ani'));
    await link(path.join(f.source,'NormalSelect.ani'),path.join(f.source,'alias'));await assert.rejects(f.cache.importFolder(f.source),/private regular/);await rm(path.join(f.source,'alias'));
    await assert.rejects(f.cache.importFolder(f.cachePath),/overlap/);
    const pack=await f.cache.importFolder(f.source);await writeFile(pack.static[0].path,cur(5));await assert.rejects(f.cache.load(pack.directory),/Static cursor mismatch/);
    await writeFile(pack.static[0].path,cur(90));await writeFile(pack.animated[0].path,ani());await assert.rejects(f.cache.load(pack.directory),/SHA-256/);
    await assert.rejects(f.cache.load(f.source),/outside private cache/);
  }finally{await f.clean();}
});
test('private cursor cache cannot be configured inside the source working tree',()=>{
  assert.throws(()=>new PrivateCursorCache(path.join(process.cwd(),'assets','private-cursors')),/outside the working tree/);
});
test('controller arms before apply, stays enabled beyond five minutes, renews lease, Stop restores once',async()=>{
  const f=await fixture(),host=new FakeHost(),controller=new CursorController(f.cache,host,()=>host.now);try{
    const pack=await f.cache.importFolder(f.source),state=await controller.enable(pack.directory,settings(),environment);
    assert.equal(state.state,'active');assert.equal(state.expiresAt,undefined);assert.deepEqual(host.events,['arm','apply']);
    await controller.updateEnvironment({...environment});assert.deepEqual(host.events,['arm','apply']); // Frequent presence events must not restart ANI playback.
    for(let i=0;i<70;i++){host.advance(5000);assert.equal((await controller.tick()).state,'active');}
    assert.equal(host.roles.length,3);assert.ok(host.owner);assert.ok(controller.status().watchdogExpiresAt!>host.now);
    const copy=controller.status();copy.state='inactive';assert.equal(controller.status().state,'active');CursorStatusSchema.parse(controller.status());
    assert.equal((await controller.stop()).state,'inactive');assert.equal(host.roles.length,0);const count=host.events.length;await controller.stop();assert.equal(host.events.length,count);
  }finally{await controller.stop();await f.clean();}
});
test('optional bounded trial expires and does not resume on a later environment event',async()=>{
  const f=await fixture(),host=new FakeHost(),c=new CursorController(f.cache,host,()=>host.now);try{
    const p=await f.cache.importFolder(f.source);await c.enable(p.directory,{...settings(),durationMs:1000},environment);host.advance(1001);
    assert.equal((await c.updateEnvironment({...environment,reducedMotion:true})).state,'inactive');assert.equal(host.roles.length,0);
    await c.tick();assert.equal(host.events.filter(e=>e==='apply').length,1);
  }finally{await c.stop();await f.clean();}
});
test('game, lock and zero intensity restore while reduced motion uses validated static first frame',async()=>{
  const f=await fixture(),host=new FakeHost(),c=new CursorController(f.cache,host,()=>host.now);try{
    const p=await f.cache.importFolder(f.source);await c.enable(p.directory,settings(),environment);
    assert.equal((await c.updateEnvironment({...environment,gameDocked:true})).suspensionReason,'game-docked');assert.equal(host.roles.length,0);
    assert.equal((await c.updateEnvironment({...environment,locked:true})).suspensionReason,'locked');
    await c.updateEnvironment({...environment,reducedMotion:true});assert.ok(host.roles.every(f=>f.path.endsWith('.ani.cur')));
    await c.enable(p.directory,{...settings(),intensity:0},environment);assert.equal(c.status().suspensionReason,'intensity-zero');assert.equal(host.roles.length,0);
  }finally{await c.stop();await f.clean();}
});
test('native lock observation suspends independently of stale host presence and resumes with a new lease',async()=>{
  const f=await fixture(),host=new FakeHost(),c=new CursorController(f.cache,host,()=>host.now);try{
    const p=await f.cache.importFolder(f.source);await c.enable(p.directory,settings(),environment);const old=host.owner;host.locked=true;
    assert.equal((await c.tick()).suspensionReason,'locked');assert.equal(host.roles.length,0);host.locked=false;
    assert.equal((await c.tick()).state,'active');assert.notEqual(host.owner,old);
  }finally{await c.stop();await f.clean();}
});

test('host accessibility observations suspend without arming, including static reduced-motion cursors; compatible settings resume',async()=>{
  const f=await fixture(),host=new FakeHost(),c=new CursorController(f.cache,host,()=>host.now);try{
    const p=await f.cache.importFolder(f.source);
    for(const accessibility of incompatibleAccessibility){
      await c.stop();const arms=host.events.filter(e=>e==='arm').length;
      const state=await c.enable(p.directory,settings(),{...environment,reducedMotion:true,accessibility});
      assert.equal(state.suspensionReason,'accessibility');CursorStatusSchema.parse(state);
      assert.equal(host.events.filter(e=>e==='arm').length,arms);assert.equal(host.roles.length,0);
      assert.equal((await c.updateEnvironment({...environment,reducedMotion:true,accessibility:compatibleAccessibility()})).state,'active');
      assert.ok(host.roles.every(file=>file.path.endsWith('.ani.cur')));
    }
    await c.updateEnvironment({...environment,accessibility:incompatibleAccessibility[0]});assert.equal(host.roles.length,0);
    assert.equal((await c.updateEnvironment(environment)).state,'active'); // Legacy inputs remain supported; native still verifies safety.
  }finally{await c.stop();await f.clean();}
});

test('native accessibility changes restore independently of Node, reject stale presence and require a new compatible lease',async()=>{
  const f=await fixture(),host=new FakeHost(),c=new CursorController(f.cache,host,()=>host.now);try{
    const p=await f.cache.importFolder(f.source);
    for(const accessibility of incompatibleAccessibility){
      await c.enable(p.directory,settings(),environment);const old=host.owner!;assert.equal(host.crashMarker,true);
      host.accessibility={...accessibility};host.advance(1); // Simulated independent watchdog polling while Node is idle.
      assert.equal(host.roles.length,0);assert.equal(host.crashMarker,false);
      assert.equal((await c.tick()).suspensionReason,'accessibility');assert.equal(host.owner,undefined);
      assert.equal((await c.tick()).suspensionReason,'accessibility');assert.equal(host.roles.length,0);
      host.accessibility=compatibleAccessibility();assert.equal((await c.tick()).state,'active');assert.notEqual(host.owner,old);
      await assert.rejects(old.request('close'));assert.equal(host.roles.length,3);
    }
  }finally{await c.stop();await f.clean();}
});

test('accessibility already incompatible at native dispatch does not mutate; restoration failures remain recovery-required',async()=>{
  const f=await fixture(),host=new FakeHost(),c=new CursorController(f.cache,host,()=>host.now);try{
    const p=await f.cache.importFolder(f.source);host.accessibility=incompatibleAccessibility[1];
    assert.equal((await c.enable(p.directory,settings(),environment)).suspensionReason,'accessibility');assert.equal(host.crashMarker,false);assert.equal(host.roles.length,0);
    host.accessibility=compatibleAccessibility();await c.tick();host.closeFails=true;
    assert.equal((await c.updateEnvironment({...environment,accessibility:incompatibleAccessibility[0]})).state,'recovery-required');
    assert.equal(c.recoveryStatus(),'required');
  }finally{host.closeFails=false;host.advance(60001);await c.stop();await f.clean();}
});

test('controller snapshots accessibility inputs and conservatively handles contradictory compatibility flags',async()=>{
  const f=await fixture(),host=new FakeHost(),c=new CursorController(f.cache,host,()=>host.now);try{
    const p=await f.cache.importFolder(f.source),accessibility=compatibleAccessibility();
    await c.enable(p.directory,settings(),{...environment,accessibility});accessibility.highContrast=true;
    assert.equal((await c.tick()).state,'active'); // Caller mutation cannot alter a stored host observation.
    assert.equal((await c.updateEnvironment({...environment,accessibility})).suspensionReason,'accessibility');assert.equal(host.roles.length,0);
    await c.updateEnvironment({...environment,accessibility:compatibleAccessibility()});const applies=host.events.filter(e=>e==='apply').length;
    await c.updateEnvironment({...environment,accessibility:compatibleAccessibility()});assert.equal(host.events.filter(e=>e==='apply').length,applies);
  }finally{await c.stop();await f.clean();}
});

test('unavailable accessibility observations never hide native lock or non-replayable apply failures',async()=>{
  const f=await fixture(),host=new FakeHost();let failedApply=false,lockedHeartbeat=false;
  const native:CursorNative={arm:async ms=>{const session=await host.arm(ms);return {request:async(action,files)=>{
    if(action==='apply'&&failedApply)return {ok:false,reason:'host-unavailable',accessibility:incompatibleAccessibility[3]};
    if(action==='heartbeat'&&lockedHeartbeat)return {ok:false,reason:'locked',accessibility:incompatibleAccessibility[3]};
    return session.request(action,files);
  }};}};
  const c=new CursorController(f.cache,native,()=>host.now);try{
    const p=await f.cache.importFolder(f.source);await c.enable(p.directory,settings(),environment);lockedHeartbeat=true;
    assert.equal((await c.tick()).suspensionReason,'locked');assert.equal(host.roles.length,0);lockedHeartbeat=false;
    failedApply=true;assert.equal((await c.tick()).suspensionReason,'host-unavailable');
    failedApply=false;const attempts=host.events.filter(e=>e==='arm').length;
    await c.tick();await c.updateEnvironment({...environment,reducedMotion:true});assert.equal(host.events.filter(e=>e==='arm').length,attempts);
  }finally{await c.stop();await f.clean();}
});
test('partial apply failure is rolled back; failed restoration is distinct from suspension',async()=>{
  const f=await fixture(),host=new FakeHost(),c=new CursorController(f.cache,host,()=>host.now);try{
    const p=await f.cache.importFolder(f.source);host.failRole=32650;assert.equal((await c.enable(p.directory,settings(),environment)).state,'suspended');assert.equal(host.roles.length,0);assert.ok(host.events.includes('restore'));
    const attempts=host.events.filter(e=>e==='apply').length;await c.tick();await c.updateEnvironment({...environment,reducedMotion:true});assert.equal(host.events.filter(e=>e==='apply').length,attempts);
    host.failRole=undefined;await c.enable(p.directory,settings(),environment);host.closeFails=true;
    assert.equal((await c.stop()).state,'recovery-required');assert.equal(c.recoveryStatus(),'required');
  }finally{host.closeFails=false;host.advance(60001);await c.stop();await f.clean();}
});
test('competing owner cannot mutate; old watchdog cannot restore a new owner after parent kill or lease expiry',async()=>{
  const f=await fixture(),host=new FakeHost(),one=new CursorController(f.cache,host,()=>host.now),two=new CursorController(f.cache,host,()=>host.now);try{
    const p=await f.cache.importFolder(f.source);await one.enable(p.directory,settings(),environment);const old=host.owner!;
    assert.equal((await two.enable(p.directory,settings(),environment)).suspensionReason,'owner-conflict');assert.equal(host.roles.length,3);
    host.dead=true;host.advance(1);assert.equal(host.roles.length,0);host.dead=false;
    assert.equal((await two.tick()).state,'active');await assert.rejects(old.request('close'));assert.equal(host.roles.length,3);
    assert.equal((await one.tick()).state,'recovery-required');assert.equal(host.roles.length,3);
    host.advance(15000);assert.equal(host.roles.length,0);assert.equal((await two.tick()).state,'recovery-required');
    const count=host.events.filter(e=>e==='apply').length;await two.tick();assert.equal(host.events.filter(e=>e==='apply').length,count);
  }finally{await one.stop();await two.stop();await f.clean();}
});
test('crash marker recovery is observed separately, and cache is revalidated before a suspended resume',async()=>{
  const f=await fixture(),host=new FakeHost(),c=new CursorController(f.cache,host,()=>host.now);try{
    const p=await f.cache.importFolder(f.source);host.crashMarker=true;await c.enable(p.directory,settings(),environment);assert.equal(c.recoveryStatus(),'restored');
    await c.updateEnvironment({...environment,gameDocked:true});const applies=host.events.filter(e=>e==='apply').length;
    await writeFile(p.static[0].path,cur(8));assert.equal((await c.updateEnvironment({...environment,reducedMotion:true})).suspensionReason,'reduced-motion');
    assert.equal(host.events.filter(e=>e==='apply').length,applies);assert.equal(host.roles.length,0);
  }finally{await c.stop();await f.clean();}
});
test('disabled settings never arm or apply',async()=>{
  const f=await fixture(),host=new FakeHost(),c=new CursorController(f.cache,host);try{
    assert.equal((await c.enable('unused',{...settings(),enabled:false},environment)).state,'inactive');assert.deepEqual(host.events,[]);
  }finally{await c.stop();await f.clean();}
});
test('next-launch recovery runs with cursor mode disabled and does not displace a competing live owner',async()=>{
  const f=await fixture(),host=new FakeHost(),c=new CursorController(f.cache,host);try{
    host.crashMarker=true;assert.equal((await c.recover()).state,'inactive');assert.equal(c.recoveryStatus(),'restored');
    assert.equal(host.owner,undefined);assert.equal(host.events.includes('apply'),false);
    const live=await host.arm(15000);assert.equal((await c.recover()).suspensionReason,'owner-conflict');assert.equal(host.owner,live);await live.request('close');
    host.crashMarker=true;host.recoverFails=true;assert.equal((await c.recover()).state,'recovery-required');assert.equal(host.crashMarker,true);
  }finally{await c.stop();await f.clean();}
});
test('unconfirmed apply or lost transport never automatically replays a system mutation',async()=>{
  const f=await fixture(),host=new FakeHost();let calls=0;
  const native:CursorNative={arm:async ms=>{const session=await host.arm(ms);return {request:async(action,files)=>{
    if(action==='apply'){calls++;await session.request(action,files);throw Error('receipt lost after mutation');}return session.request(action,files);
  }};}};
  const c=new CursorController(f.cache,native,()=>host.now);try{
    const p=await f.cache.importFolder(f.source);assert.equal((await c.enable(p.directory,settings(),environment)).suspensionReason,'host-unavailable');assert.equal(c.recoveryStatus(),'restored');
    assert.equal(host.roles.length,0);await c.tick();await c.updateEnvironment({...environment,reducedMotion:true});assert.equal(calls,1);
  }finally{await c.stop();await f.clean();}
});
