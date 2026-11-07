import React,{useEffect,useRef,useState} from 'react';
import type {State} from '../shared';
import {SpriteState,clips,ClipName,mouthShape,poseMatrix} from './sprite-state';
import {PresentationCues,attentionLifecycle,composePose,cueLedger,idleFlourishEnabled,portraitGameDocked,type CueFrame,type PresentationCue} from './presentation-cues';
import type {CompanionState} from '../desktop/companion-state';
import {loadSpriteSheets,type AssetPackSprites} from './asset-pack';

type Attention={id:string;label:string;detail:string;title:string};
// Teleport glitch: horizontal strips shift by a stable per-strip offset, tapering to zero at her feet so contact holds.
function drawSlices(context:CanvasRenderingContext2D,image:HTMLImageElement,sx:number,cell:number,width:number,height:number,cue:CueFrame){
 const strips=10,bucket=Math.floor(cue.t/60),source=image.height/strips,dest=height/strips;
 for(let i=0;i<strips;i++){const n=Math.sin((i+1)*12.9898+bucket*78.233)*43758.5453;const dx=((n-Math.floor(n))*2-1)*cue.slice*18*(1-i/(strips-1));context.drawImage(image,sx,i*source,cell,source,-width/2+dx,-height+i*dest,width,dest+.5);}
}
function drawBeam(context:CanvasRenderingContext2D,c:HTMLCanvasElement,x:number,height:number,width:number,beam:number){
 const cx=c.width/2+x,w=width*.55*(.4+.6*beam),feet=c.height/2+height/2;const g=context.createLinearGradient(cx-w/2,0,cx+w/2,0);g.addColorStop(0,'#ff174d00');g.addColorStop(.5,'#ff3d7a');g.addColorStop(1,'#ff174d00');
 context.save();context.globalCompositeOperation='lighter';context.globalAlpha=beam*.45;context.fillStyle=g;context.fillRect(cx-w/2,feet-height-20,w,height+20);context.globalAlpha=beam*.8;context.fillStyle='#00ffc0';context.fillRect(cx-w*.7,feet-2,w*1.4,3);context.restore();
}
// Marching chevrons from her head to the attention label in the top-right corner. Only drawn when motion is allowed.
function drawPointer(context:CanvasRenderingContext2D,c:HTMLCanvasElement,[a,b,cc,d,e,f]:number[],width:number,height:number,cue:CueFrame){
 const x=width*.12,y=-height*.82,hx=a*x+cc*y+e,hy=b*x+d*y+f,tx=c.width-36,ty=44,angle=Math.atan2(ty-hy,tx-hx);
 context.save();context.strokeStyle='#ffc94d';context.lineWidth=5;context.lineCap='round';context.lineJoin='round';context.shadowColor='#ffc94d';context.shadowBlur=10;
 for(let i=0;i<3;i++){const s=(i/3+cue.t/900)%1;context.globalAlpha=cue.pointer*Math.sin(Math.PI*s);context.save();context.translate(hx+(tx-hx)*(.25+.65*s),hy+(ty-hy)*(.25+.65*s));context.rotate(angle);context.beginPath();context.moveTo(-9,-11);context.lineTo(3,0);context.lineTo(-9,11);context.stroke();context.restore();}
 context.restore();
}
export function SpriteAvatar({state='idle',level=0,intensity=1,followSystemMotion=false,companion,gameDocked,onPlace,cues,cueScope,ambient=false,assetPack}:{state?:State;level?:number;intensity?:number;followSystemMotion?:boolean;companion?:CompanionState;gameDocked?:boolean;onPlace?:(phase:string,x:number,y:number)=>void;preview?:boolean;cues?:readonly PresentationCue[];cueScope?:string;ambient?:boolean;assetPack?:AssetPackSprites}){
 const canvas=useRef<HTMLCanvasElement>(null);const sheets=useRef<Record<ClipName,HTMLImageElement>>(undefined);const machine=useRef(new SpriteState());const [player]=useState(()=>new PresentationCues(cueScope?cueLedger(cueScope):undefined,cueScope?attentionLifecycle(cueScope):undefined));const live=useRef({state,level,intensity,followSystemMotion,companion,gameDocked,ambient});live.current={state,level,intensity,followSystemMotion,companion,gameDocked,ambient};const drag=useRef<{x:number;y:number;moved:boolean}|null>(null);const [failed,setFailed]=useState(false);const [attention,setAttention]=useState<Attention>();const shown=useRef('');
 // The player deduplicates ids through its scope's ledger and ignores stale cues, so re-renders and remounts never replay one.
 useEffect(()=>{const now=performance.now();for(const cue of cues||[])player.request(cue,now);},[cues]);
 // A privately imported pack swaps sheet images only; the previous set keeps drawing until a complete replacement loads.
 const packKey=assetPack?assetPack.id+':'+assetPack.revision:'';
 useEffect(()=>loadSpriteSheets(assetPack,()=>new Image(),result=>{if(result.source==='unavailable'){sheets.current=undefined;setFailed(true);}else{sheets.current=result.images;setFailed(false);}}),[packKey]);
 useEffect(()=>{let active=true,frame=0;
  let last=0;const draw=(now:number)=>{if(!active)return;frame=requestAnimationFrame(draw);const images=sheets.current;if(now-last<32||!images)return;last=now;const c=canvas.current;if(!c)return;const context=c.getContext('2d');if(!context)return;const p=live.current;const reduced=p.followSystemMotion&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;const motion=p.intensity>0&&!reduced;
   const perched=!!(p.companion?.following||p.companion?.seated),dragging=!!drag.current?.moved||p.companion?.clip==='dangle',game=portraitGameDocked(p.companion,p.gameDocked);
   const beat=machine.current.update(now,{state:p.state,perched,dragging,idleMs:p.companion?.idleMs||0,motion,game,intensity:p.intensity});
   const cue=player.frame(now,{motion,game,state:p.state,dragging,perched,resting:beat.clip==='sleep'||beat.clip==='wake',intensity:p.intensity,ambient:p.ambient&&idleFlourishEnabled()});
   const labelled=cue?.label?cue.id:'';if(labelled!==shown.current){shown.current=labelled;setAttention(cue?.label?{id:cue.id,label:cue.label,detail:cue.detail||'',title:cue.title||''}:undefined);}
   const image=images[beat.clip];const cell=image.width/clips[beat.clip][0];const scale=Math.min(c.width/cell,c.height/image.height)/1.14;const width=cell*scale,height=image.height*scale;const pose=cue?composePose(beat.pose,cue.pose,perched):beat.pose;const alpha=cue?.alpha??1;context.clearRect(0,0,c.width,c.height);
   if(cue&&cue.beam>.02)drawBeam(context,c,pose.x,height,width,cue.beam);
   const matrix=poseMatrix(pose,p.companion?.lean||0,c.width,c.height,height);context.save();
   // lean, rotation and squash all pivot on her feet so seated poses keep their contact point
   context.transform(...matrix);context.globalAlpha=alpha;
   if(pose.glow>.02){context.save();context.globalCompositeOperation='lighter';context.globalAlpha=Math.min(.3,pose.glow*.3)*alpha;const echo=pose.glow*6;context.drawImage(image,cell*beat.frame,0,cell,image.height,-width/2-echo,-height,width,height);context.drawImage(image,cell*beat.frame,0,cell,image.height,-width/2+echo,-height,width,height);context.restore();}
   if(cue&&cue.slice>.02)drawSlices(context,image,cell*beat.frame,cell,width,height,cue);else context.drawImage(image,cell*beat.frame,0,cell,image.height,-width/2,-height,width,height);const shape=mouthShape(p.state,beat.clip,p.level);if(shape>=0){const mouth=images.mouth,mouthCell=mouth.width/clips.mouth[0];context.drawImage(mouth,shape*mouthCell,0,mouthCell,mouth.height,-width/2,-height,width,height);}context.restore();
   if(cue&&cue.pointer>.02)drawPointer(context,c,matrix,width,height,cue);};frame=requestAnimationFrame(draw);return()=>{active=false;cancelAnimationFrame(frame);};
 },[]);
 return <div className={'avatar-art sprite-avatar '+state} aria-label={'Capri — '+state}><canvas ref={canvas} width={480} height={600} onPointerDown={e=>{if(companion?.mode!=='free')return;drag.current={x:e.screenX,y:e.screenY,moved:false};e.currentTarget.setPointerCapture(e.pointerId);onPlace?.('start',e.screenX,e.screenY);}} onPointerMove={e=>{const d=drag.current;if(!d)return;if(Math.hypot(e.screenX-d.x,e.screenY-d.y)>5)d.moved=true;if(d.moved)onPlace?.('move',e.screenX,e.screenY);}} onPointerUp={e=>{const d=drag.current;drag.current=null;if(d)onPlace?.('end',e.screenX,e.screenY);if(!d?.moved)machine.current.react(performance.now());}} onPointerCancel={()=>{drag.current=null;onPlace?.('end',0,0);}} onClick={()=>machine.current.react(performance.now())} onDoubleClick={()=>{if(companion)void window.capri?.companion?.('follow');}}/>{failed&&<img src="/character/idle.png" alt="Capri"/>}
  {/* A separate attention label: it never replaces the voice caption. Text is redacted display data rendered as text nodes. */}
  {attention&&<div className="attention-callout" role="status" title={attention.title}><b>{attention.label}</b><span>{attention.detail}</span></div>}</div>;
}
