import {clips,type ClipName} from './sprite-state';

/**
 * Browser-safe adapter between the one SpriteAvatar state machine and a privately imported sprite pack.
 * The desktop host (src/desktop/asset-packs.ts) validates and serves pack files; the UI only ever receives
 * same-origin `/asset-packs/<id>/sprites/<clip>.png?v=<sha>` URLs and always keeps the built-in set as fallback.
 * Packs never touch audio, voice or the sprite state machine: they replace sheet images only.
 */
export type SpriteSheetSet=Readonly<Record<ClipName,string>>;
export interface AssetPackSprites {id:string;revision:string;sprites:SpriteSheetSet}
export const clipNames=Object.freeze(Object.keys(clips) as ClipName[]);
export const defaultSpriteBase='/character/sprites/';
export const builtInSprites:SpriteSheetSet=Object.freeze(Object.fromEntries(clipNames.map(name=>[name,defaultSpriteBase+name+'.png'])) as Record<ClipName,string>);
export const packIdPattern=/^pack-[a-f0-9]{32}$/;
export const packSpritePath=(id:string,clip:ClipName)=>'/asset-packs/'+id+'/sprites/'+clip+'.png';
const revisionPattern=/^[a-f0-9]{16,64}$/;

/** Accepts only a complete, host-shaped descriptor; anything else (partial, foreign URLs, model-supplied values) yields undefined. */
export function trustedPackSprites(value:unknown):AssetPackSprites|undefined{
 if(!value||typeof value!=='object')return undefined;const pack=value as Partial<AssetPackSprites>;
 if(typeof pack.id!=='string'||!packIdPattern.test(pack.id)||typeof pack.revision!=='string'||!revisionPattern.test(pack.revision)||!pack.sprites||typeof pack.sprites!=='object')return undefined;
 const sprites=pack.sprites as Record<string,unknown>;if(Object.keys(sprites).length!==clipNames.length)return undefined;
 for(const clip of clipNames){const url=sprites[clip];if(typeof url!=='string'||url!==packSpritePath(pack.id,clip)+'?v='+pack.revision)return undefined;}
 return {id:pack.id,revision:pack.revision,sprites:Object.freeze({...sprites}) as SpriteSheetSet};
}
/** Sheet geometry used by the renderer; undefined when an image cannot hold the clip's frame count. */
export function sheetGeometry(clip:ClipName,width:number,height:number):{cell:number;height:number}|undefined{
 const frames=clips[clip][0];if(!(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&width<=32768&&height<=4096)||width%frames)return undefined;
 return {cell:width/frames,height};
}
export interface SheetImage {src:string;readonly width:number;readonly height:number;onload:((...args:never[])=>unknown)|null;onerror:((...args:never[])=>unknown)|null}
export type SpriteSheetResult<T extends SheetImage=SheetImage>={source:'pack'|'built-in';images:Record<ClipName,T>}|{source:'unavailable'};
/**
 * Loads one complete sheet set. A pack is all-or-nothing: if any pack sheet fails to load or has impossible geometry
 * (or the mouth cell differs from the idle cell), the whole built-in set is used instead so art styles never mix.
 * `unavailable` means the built-in set itself failed and the caller shows its static fallback image.
 */
export function loadSpriteSheets<T extends SheetImage>(pack:AssetPackSprites|undefined,create:()=>T,done:(result:SpriteSheetResult<T>)=>void):()=>void{
 let active=true;const trusted=pack&&trustedPackSprites(pack);
 const attempt=(set:SpriteSheetSet,source:'pack'|'built-in',fail:()=>void)=>{
  const images={} as Record<ClipName,T>;let loaded=0,settled=false;
  const failOnce=()=>{if(!settled&&active){settled=true;fail();}};
  for(const clip of clipNames){const image=images[clip]=create();
   image.onload=()=>{if(settled||!active)return;if(!sheetGeometry(clip,image.width,image.height))return failOnce();
    if(++loaded===clipNames.length){const idle=sheetGeometry('idle',images.idle.width,images.idle.height)!,mouth=sheetGeometry('mouth',images.mouth.width,images.mouth.height)!;
     if(idle.cell!==mouth.cell||idle.height!==mouth.height)return failOnce();settled=true;done({source,images});}};
   image.onerror=failOnce;image.src=set[clip];}
 };
 const builtIn=()=>attempt(builtInSprites,'built-in',()=>done({source:'unavailable'}));
 if(trusted)attempt(trusted.sprites,'pack',builtIn);else builtIn();
 return()=>{active=false;};
}
