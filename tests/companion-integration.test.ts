import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GameDocking,Presence,followPosition,clampRect,chooseSeat,isGame} from '../src/desktop/companion-state';
import {SpriteState,clips,mouthShape} from '../src/ui/sprite-state';
const desktop:Presence={windows:[],idleMs:0,fullscreen:false,exclusive:false,locked:false};
const game:Presence={...desktop,foreground:{id:1,path:'C:/Steam/steamapps/common/tModLoader/dotnet/dotnet.exe',eligible:true,rect:{x:0,y:0,width:900,height:600}}};
test('game detection handles Terraria, tModLoader, fullscreen and user rules',()=>{
 assert.equal(isGame(game,[]),true);assert.equal(isGame({...game,foreground:{...game.foreground!,path:game.foreground!.path.replaceAll('/',String.fromCharCode(92))}},[]),true);assert.equal(isGame({...game,foreground:{...game.foreground!,path:'C:/Roblox/RobloxPlayerBeta.exe'}},[]),true);assert.equal(isGame({...game,foreground:{...game.foreground!,path:'C:/Games/Terraria.exe'}},[]),true);
 assert.equal(isGame({...desktop,fullscreen:true},[]),true);assert.equal(isGame(desktop,[]),false);
 assert.equal(isGame({...game,foreground:{...game.foreground!,path:'C:/Games/custom.exe'}},['c:/games/CUSTOM.exe']),true);
});
test('game docking debounces entry and exit and fails safely without changing the user preference',()=>{
 const state=new GameDocking();assert.equal(state.update(game,[],0),false);assert.equal(state.update(game,[],499),false);assert.equal(state.update(game,[],500),true);
 assert.equal(state.update(desktop,[],600),true);assert.equal(state.update(desktop,[],2599),true);assert.equal(state.update(desktop,[],2600),false);
 assert.equal(state.update({...desktop,error:'helper lost'},[],2700),true);assert.equal(state.update(desktop,[],2800),true);assert.equal(state.update(desktop,[],4800),false);
 assert.equal(state.update({...desktop,locked:true},[],5000),true);
});
test('cursor perching and display removal stay bounded at different scales and negative origins',()=>{
 for(const scale of [.5,1,1.5,2])for(const area of [{x:1920,y:0,width:1280,height:720},{x:-1920,y:-1080,width:1920,height:1080}]){
  let body={x:9999,y:9999,width:270*scale,height:337*scale};let lean=0;
  for(let i=0;i<50;i++){const next=followPosition({x:area.x+3,y:area.y+5},area,body,270*scale,lean);body=next.bounds;lean=next.lean;assert.ok(body.x>=area.x&&body.y>=area.y);assert.ok(body.x+body.width<=area.x+area.width&&body.y+body.height<=area.y+area.height);assert.ok(Math.abs(lean)<=8);}
  const moved=clampRect(body,{x:0,y:0,width:800,height:600});assert.ok(moved.x>=0&&moved.y>=0&&moved.x+moved.width<=800);
 }
});
test('window seating skips covered edges and returns to the desktop floor',()=>{
 const body={x:100,y:0,width:200,height:200};const area={x:0,y:0,width:1000,height:800};
 const window={id:1,path:'app.exe',eligible:true,rect:{x:0,y:250,width:500,height:300}};
 assert.equal(chooseSeat([window],body,area).id,1);
 const cover={id:2,path:'overlay.exe',eligible:false,rect:{x:0,y:200,width:500,height:400}};
 assert.equal(chooseSeat([cover,window],body,area).id,0);assert.equal(chooseSeat([],body,area).y,600);
});
test('sprite interactions override ambient motion, sleep wakes, and games suppress decorative glitches',()=>{
 const sprite=new SpriteState();assert.equal(sprite.update(0,{}).clip,'idle');assert.equal(sprite.update(130000,{idleMs:130000}).clip,'sleep');
 sprite.react(130010);assert.equal(sprite.update(130020,{idleMs:0}).clip,'wake');
 assert.match(sprite.update(132000,{perched:true}).clip,/^perch/);assert.equal(sprite.update(132010,{perched:true,dragging:true}).clip,'dangle');
 const quiet=new SpriteState();assert.notEqual(quiet.update(40000,{game:true}).clip,'glitch');assert.equal(quiet.update(41000,{state:'speaking'}).clip,'idle');
 quiet.react(42000);assert.equal(quiet.update(42100,{}).clip,'grin');assert.equal(quiet.update(42200,{dragging:true}).clip,'dangle');
});
test('mouth frames follow playback only and all thirteen sprite strips match their manifest',()=>{
 assert.equal(mouthShape('listening','idle',.9),-1);assert.equal(mouthShape('idle','idle',.9),-1);assert.equal(mouthShape('speaking','perch',.9),-1);assert.equal(mouthShape('speaking','idle',0),-1);assert.equal(mouthShape('speaking','idle',.8),4);
 // The public core ships no character art: verify the neutral sprites its build generated, from a verified neutral build.
 const publicBuild=process.env.CAPRI_PUBLIC_BUILD==='1';
 if(publicBuild)assert.equal(JSON.parse(readFileSync('dist/build-info.json','utf8')).assets,'neutral');
 const sprites=publicBuild?'dist/ui/character/sprites/':'assets/character/sprites/';
 const manifest=JSON.parse(readFileSync(sprites+'manifest.json','utf8'));assert.equal(Object.keys(clips).length,13);
 if(publicBuild){assert.equal(manifest.provenance.license,'MIT');assert.equal(manifest.provenance.kind,'original code-generated neutral graphics');}
 for(const [name,[frames,fps]]of Object.entries(clips)){const png=readFileSync(sprites+name+'.png');assert.equal(png.readUInt32BE(16)%frames,0);assert.equal(png.readUInt32BE(20),384);assert.equal(manifest.clips[name].frames,frames);assert.equal(manifest.clips[name].fps,fps);}
});
