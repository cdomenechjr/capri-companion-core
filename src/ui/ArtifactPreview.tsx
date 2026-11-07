import React,{useEffect,useState} from 'react';
import {chartCaption,isGeneratedChartSvg} from '../server/charts';

export interface ChartPreview {src:string;title:string;description:string}
const hex=(bytes:ArrayBuffer)=>[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
/** A chart preview is shown only when the authenticated artifact row's generated SVG
 * passes the strict generator check and matches the saved file's size and SHA-256.
 * It is embedded as an image (no script, no external loads), never injected as markup. */
export async function chartPreview(row:any,subtle:SubtleCrypto|null|undefined=globalThis.crypto?.subtle):Promise<ChartPreview|undefined>{
 if(row?.format!=='svg'||!isGeneratedChartSvg(row.preview)||!subtle||typeof row.sha256!=='string')return undefined;
 const bytes=new TextEncoder().encode(row.preview);
 if(bytes.length!==row.bytes||hex(await subtle.digest('SHA-256',bytes))!==row.sha256)return undefined;
 const caption=chartCaption(row.preview);if(!caption)return undefined;
 return {src:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(row.preview),...caption};
}
export function ChartFigure({preview}:{preview:ChartPreview}){
 return <figure className="artifact-chart"><img src={preview.src} alt={preview.title} width={960} height={540} draggable={false}/><figcaption>{preview.description}</figcaption></figure>;
}
function ArtifactItem({artifact:a}:{artifact:any}){
 const chart=a.format==='svg';const [preview,setPreview]=useState<ChartPreview|null|undefined>(chart?undefined:null);const [error,setError]=useState('');
 useEffect(()=>{if(!chart)return;let live=true;setPreview(undefined);void chartPreview(a).catch(()=>undefined).then(p=>{if(live)setPreview(p??null);});return()=>{live=false;};},[a.id,a.sha256,a.preview]);
 const verified=a.verification?.every((v:any)=>v.passed);
 return <details className="capability-item"><summary>{a.path?.split(/[\\/]/).pop()} <span className="tag">{chart?'svg chart':a.format}</span></summary><p>{a.path}</p>
  {chart?(preview?<ChartFigure preview={preview}/>:<p className="small muted">{preview===undefined?'Checking chart preview…':'Chart preview unavailable: the saved chart did not pass its preview check.'}</p>):<pre>{a.preview}</pre>}
  <p className="small muted">{a.bytes?.toLocaleString()} bytes · {verified?'File verification passed':'Review required'}{a.sha256?' · SHA-256 '+String(a.sha256).slice(0,12)+'…':''}</p>
  <button className="secondary" onClick={()=>{setError('');void window.capri?.agency?.('openArtifact',{id:a.id}).catch((e:any)=>setError(e?.message||'The artifact could not be opened.'));}}>Open artifact</button>{error&&<p role="alert">{error}</p>}</details>;
}
export function ArtifactPreviewList({artifacts}:{artifacts:any[]}){return <section className="card section-card"><h2>Created artifacts</h2>{artifacts.slice().reverse().map(a=><ArtifactItem key={a.id} artifact={a}/>)}{!artifacts.length&&<p className="muted">Documents, spreadsheets, slides, charts and other files will appear here.</p>}</section>;}
