import React,{useEffect,useRef,useState} from 'react';
import {State} from '../shared';
import {AvatarMotion} from './avatar-motion';

function CanonClip({name,active,rate}:{name:string;active:boolean;rate:number}){
 const ref=useRef<HTMLVideoElement>(null);
 useEffect(()=>{const video=ref.current;if(!video)return;video.muted=true;if(active)void video.play().catch(()=>{});else video.pause();return()=>video.pause();},[active]);
 useEffect(()=>{if(ref.current)ref.current.playbackRate=rate;},[rate]);
 return <video ref={ref} className={'canon-clip '+(active?'playing':'held')} src={'/character/'+name+'.mp4'} poster="/character/poster.png" muted playsInline loop preload="auto" aria-hidden="true"/>;
}

/** Original character clips follow output audio; microphone noise never talks. */
export function Avatar({state='idle',level=0,intensity=1,preview=false,followSystemMotion=false}:{state?:State;level?:number;intensity?:number;preview?:boolean;followSystemMotion?:boolean}){
 const [reaction,setReaction]=useState(false);const [perched,setPerched]=useState(false);
 const [reduced,setReduced]=useState(()=>typeof window!=='undefined'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
 const motion=useRef(new AvatarMotion());const live=useRef({state,level,preview});live.current={state,level,preview};
 const [beat,setBeat]=useState(()=>motion.current.update(state,0,performance.now()));
 useEffect(()=>{const preference=window.matchMedia('(prefers-reduced-motion: reduce)');const update=()=>setReduced(preference.matches);preference.addEventListener('change',update);return()=>preference.removeEventListener('change',update);},[]);
 useEffect(()=>{let frame=0;let last='';const tick=(now:number)=>{const current=live.current;const energy=current.preview&&current.state==='speaking'?Math.max(0,Math.sin(now/160))*.62:current.level;const value=motion.current.update(current.state,energy,now);const key=JSON.stringify(value);if(last!==key){last=key;setBeat(value);}frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);},[]);
 useEffect(()=>{if(state!=='idle')return;const timer=setInterval(()=>setPerched(value=>!value),16000);return()=>clearInterval(timer);},[state]);
 useEffect(()=>{if(!reaction)return;const timer=setTimeout(()=>setReaction(false),800);return()=>clearTimeout(timer);},[reaction]);
 const animated=(!reduced||!followSystemMotion)&&intensity>0;
 const acting=state==='speaking'||state==='working'||beat.celebrating;
 const clip=state==='working'||beat.celebrating||beat.emphasis?'motion':'dialogue';
 const playing=animated&&(state==='working'||beat.celebrating||beat.talking);
 const showClip=acting&&animated;
 const pose=state==='thinking'||state==='listening'||perched?'perch':'idle';
 return <div className={'avatar-art canon-capri '+state+(reaction?' reacting':'')+(beat.emphasis?' accent-beat':'')+(animated?' motion-enabled':' still-projection')} style={{'--voice-level':level,'--gesture-side':beat.side,'--motion':intensity} as React.CSSProperties} onClick={()=>setReaction(true)} onDoubleClick={()=>setPerched(value=>!value)} aria-label={'Capri from Cyberpunk: Edgerunners 2 — '+state}>
  <div className="capri-projection-ring"/><div className="capri-signal-fragments"><i/><i/><i/><i/></div>
  <div className={'capri-sprite '+(showClip?'behind-clip':'')}><img className={'capri-pose '+pose} src={'/character/'+pose+'.png'} alt="Capri — Project Capricorn" draggable={false}/></div>
  {showClip&&<div className={'capri-anime-window '+(playing?'voiced':'speech-hold')} data-speaking={state==='speaking'&&beat.talking?'true':'false'}>
   <div className={'clip-layer '+(clip==='dialogue'?'visible':'')}><CanonClip name="dialogue" active={playing&&clip==='dialogue'} rate={1}/></div>
   <div className={'clip-layer '+(clip==='motion'?'visible':'')}><CanonClip name="motion" active={playing&&clip==='motion'} rate={state==='working'?.85:1}/></div>
   <span className="clip-reticle top"/><span className="clip-reticle bottom"/>
  </div>}
  <div className="projection-label">PROJECT CAPRICORN <span>CP—02</span></div>
 </div>;
}
