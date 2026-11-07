// Original, deterministic, code-generated neutral companion graphics for CAPRI_PUBLIC_BUILD=1 (MIT, Capri Project).
// Reads no files: no character artwork, fonts, voice or models are inputs, so the public build never depends on private assets.
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Frame counts and rates mirror src/ui/sprite-state.ts `clips`; tests/public-assets.test.ts keeps them in sync.
export const neutralClips=Object.freeze({idle:[16,8],blink:[4,8],blink_glitch:[4,8],grin:[16,8],glitch:[10,15],dangle:[24,10],sleep:[16,6],wake:[13,15],perch:[16,8],perch_blink:[4,8],perch_blink_glitch:[4,8],perch_glitch:[10,15],mouth:[5,12]});
export const CELL_WIDTH=240,CELL_HEIGHT=384;
export const neutralProvenance=Object.freeze({source:'scripts/neutral-assets.mjs',author:'Capri Project',license:'MIT',kind:'original code-generated neutral graphics'});

const crcTable=Uint32Array.from({length:256},(_,index)=>{let n=index;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;});
function crc32(bytes){let n=0xffffffff;for(const byte of bytes)n=crcTable[(n^byte)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type,'latin1'),length=Buffer.alloc(4),check=Buffer.alloc(4);length.writeUInt32BE(data.length);check.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([length,t,data,check]);}
/** Minimal 8-bit RGBA, noninterlaced PNG encoder (filter 0 rows). */
export function encodePng(width,height,rgba){
 if(!(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&rgba.length===width*height*4))throw Error('Invalid PNG raster.');
 const stride=width*4+1,raw=Buffer.alloc(stride*height);for(let y=0;y<height;y++)raw.set(rgba.subarray(y*width*4,(y+1)*width*4),y*stride+1);
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
/** Single-image ICO wrapping a PNG (Vista+ format); size 256 is stored as 0. */
export function encodeIco(png,size){const dir=Buffer.alloc(22);dir.writeUInt16LE(1,2);dir.writeUInt16LE(1,4);dir[6]=size>=256?0:size;dir[7]=size>=256?0:size;dir.writeUInt16LE(1,10);dir.writeUInt16LE(32,12);dir.writeUInt32LE(png.length,14);dir.writeUInt32LE(22,18);return Buffer.concat([dir,png]);}

// Signed-distance shapes, anti-aliased by one pixel; `soft` adds an outer glow falloff.
const hex=(value,alpha=1)=>[parseInt(value.slice(1,3),16)/255,parseInt(value.slice(3,5),16)/255,parseInt(value.slice(5,7),16)/255,alpha];
const ink={line:'#38e8d0',accent:'#ff3d8b',shell:'#141826',plate:'#0a0d16',eye:'#7ff9ff',spark:'#f4f7ff'};
const circle=(cx,cy,r,color,soft=0)=>({d:(x,y)=>Math.hypot(x-cx,y-cy)-r,box:[cx-r,cy-r,cx+r,cy+r],color,soft});
const rounded=(cx,cy,hw,hh,r,color,soft=0)=>{r=Math.min(r,hw,hh);return {d:(x,y)=>{const qx=Math.abs(x-cx)-hw+r,qy=Math.abs(y-cy)-hh+r;return Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r;},box:[cx-hw,cy-hh,cx+hw,cy+hh],color,soft};};
const capsule=(ax,ay,bx,by,r,color,soft=0)=>({d:(x,y)=>{const px=x-ax,py=y-ay,vx=bx-ax,vy=by-ay,t=Math.max(0,Math.min(1,(px*vx+py*vy)/((vx*vx+vy*vy)||1)));return Math.hypot(px-vx*t,py-vy*t)-r;},box:[Math.min(ax,bx)-r,Math.min(ay,by)-r,Math.max(ax,bx)+r,Math.max(ay,by)+r],color,soft});
const diamond=(cx,cy,r,color,soft=0)=>({d:(x,y)=>(Math.abs(x-cx)+Math.abs(y-cy)-r)/Math.SQRT2,box:[cx-r,cy-r,cx+r,cy+r],color,soft});

function paint(buffer,width,height,shapes,transform){
 const {angle=0,px=0,py=0,dx=0,dy=0}=transform||{},cos=Math.cos(-angle),sin=Math.sin(-angle);
 for(const shape of shapes){
  const pad=shape.soft+2,[x0,y0,x1,y1]=angle?[0,0,width,height]:[shape.box[0]+dx-pad,shape.box[1]+dy-pad,shape.box[2]+dx+pad,shape.box[3]+dy+pad];
  const [r,g,b,a]=shape.color;
  for(let y=Math.max(0,Math.floor(y0));y<Math.min(height,Math.ceil(y1));y++)for(let x=Math.max(0,Math.floor(x0));x<Math.min(width,Math.ceil(x1));x++){
   let lx=x+.5-dx-px,ly=y+.5-dy-py;if(angle){const rx=lx*cos-ly*sin,ry=lx*sin+ly*cos;lx=rx;ly=ry;}
   const d=shape.d(lx+px,ly+py);let cover=Math.max(0,Math.min(1,.5-d));if(shape.soft&&d>0)cover=Math.max(cover,(1-Math.min(1,d/shape.soft))**2*.6);
   const sa=cover*a;if(sa<=0)continue;const i=(y*width+x)*4,da=buffer[i+3],oa=sa+da*(1-sa);
   buffer[i]=(r*sa+buffer[i]*da*(1-sa))/oa;buffer[i+1]=(g*sa+buffer[i+1]*da*(1-sa))/oa;buffer[i+2]=(b*sa+buffer[i+2]*da*(1-sa))/oa;buffer[i+3]=oa;
  }
 }
}
const wave=(i,n,phase=0)=>Math.sin((i/n+phase)*Math.PI*2);
function eyes(cx,cy,mode,open){
 const out=[];for(const x of [cx-22,cx+22]){
  if(mode==='grin')out.push(capsule(x-8,cy+5,x,cy-4,2.8,hex(ink.eye)),capsule(x,cy-4,x+8,cy+5,2.8,hex(ink.eye)));
  else out.push(rounded(x,cy,7,Math.max(1.4,10*open),3,hex(ink.eye),mode==='open'&&open>.5?5:0));
 }
 return out;
}
function zGlyph(x,y,s,alpha){const c=hex(ink.line,alpha);return [capsule(x,y,x+s,y,1.8,c),capsule(x+s,y,x,y+s,1.8,c),capsule(x,y+s,x+s,y+s,1.8,c)];}
/** Neutral holographic companion: a visor-faced shell with a chest core and antenna. Feet rest on the bottom edge. */
function figure({seated=false,eye='open',open=1,tilt=0,pulse=.5,droop=0,mouth=true,floor=true}){
 const head=seated?168:128,body=seated?{cy:288,hh:58}:{cy:262,hh:84},shapes=[];
 if(floor&&!seated)shapes.push(rounded(120,375,56,4,4,hex(ink.line,.35+.2*pulse),8));
 if(seated)for(const x of [100,140])shapes.push(capsule(x,body.cy+40,x+(x<120?-6:6),378,12,hex(ink.line)),capsule(x,body.cy+40,x+(x<120?-6:6),378,9,hex(ink.shell)));
 shapes.push(rounded(120,body.cy,50,body.hh+4,46,hex(ink.line),4),rounded(120,body.cy,46,body.hh,42,hex(ink.shell)));
 for(const side of [-1,1])shapes.push(capsule(120+side*54,body.cy-36,120+side*64,body.cy+30,11,hex(ink.line)),capsule(120+side*54,body.cy-36,120+side*64,body.cy+30,8,hex(ink.shell)));
 shapes.push(diamond(120,body.cy-14,17,hex(ink.accent),6+8*pulse),diamond(120,body.cy-14,7,hex(ink.spark,.5+.4*pulse)));
 const hy=head+droop;
 shapes.push(capsule(120,hy-60,120+tilt,hy-90,3,hex(ink.line)),circle(120+tilt,hy-94,7,hex(ink.accent),6+6*pulse));
 shapes.push(circle(120,hy,62,hex(ink.accent),5),circle(120,hy,58,hex(ink.shell)),rounded(120,hy-4,44,28,20,hex(ink.plate)));
 shapes.push(...eyes(120,hy-8,eye,open));
 if(mouth)shapes.push(rounded(120,hy+16,8,1.4,1.4,hex(ink.line,.8)));
 return shapes;
}
const unit=(seed)=>{const n=Math.sin(seed*12.9898)*43758.5453;return n-Math.floor(n);};
/** Deterministic horizontal-band displacement with a magenta/cyan split, the neutral equivalent of a glitch frame. */
function glitch(buffer,width,height,i,strength){
 const bands=7,band=Math.ceil(height/bands),copy=buffer.slice(),mix=.3*strength;
 for(let b=0;b<bands;b++){
  const shift=Math.round((unit(i*31+b*7+1)*2-1)*18*strength);if(!shift)continue;const tint=b%2?[1,.24,.55]:[.22,.91,.82];
  for(let y=b*band;y<Math.min(height,(b+1)*band);y++)for(let x=0;x<width;x++){
   const sx=x-shift,o=(y*width+x)*4;if(sx<0||sx>=width){buffer.fill(0,o,o+4);continue;}
   const s=(y*width+sx)*4;for(let c=0;c<3;c++)buffer[o+c]=copy[s+c]*(1-mix)+tint[c]*mix;buffer[o+3]=copy[s+3];
  }
 }
}
function frameOf(name,i,n){
 const perch=name.startsWith('perch'),pulse=.5+.5*wave(i,n),tilt=wave(i,n)*6;
 if(name==='mouth'){const k=i;return {shapes:[rounded(120,144,9+k*1.5,2+k*2.6,6,hex(ink.line)),rounded(120,144,7+k*1.5,Math.max(.8,k*2.6),5,hex(ink.plate))]};}
 const blink=/blink/.test(name)?Math.abs(1-2*i/(n-1)):1;
 if(name==='dangle')return {shapes:figure({tilt:0,pulse,open:1,floor:false}),transform:{angle:wave(i,n)*.22,px:120,py:34,dy:8}};
 if(name==='sleep')return {shapes:[...figure({eye:'closed',open:0,pulse:.2+.2*pulse,droop:6,tilt:-4}),...[0,1,2].flatMap(z=>{const t=(i/n+z/3)%1;return zGlyph(176+z*10+t*8,96-t*60,8+z*3,Math.sin(t*Math.PI)*.9);})]};
 if(name==='wake'){const t=i/(n-1);return {shapes:figure({open:t,eye:t<.15?'closed':'open',pulse:t,droop:6*(1-t),tilt:tilt*t})};}
 if(name==='grin')return {shapes:figure({eye:'grin',pulse,tilt,seated:perch})};
 return {shapes:figure({seated:perch,open:blink,pulse,tilt}),glitch:/glitch/.test(name)?(name.includes('blink')?(i===1||i===2?.8:.25):Math.sin(Math.PI*(i+.5)/n)):0};
}
/** Renders one sprite sheet: `frames` cells of CELL_WIDTH x CELL_HEIGHT laid out left to right. */
export function renderClip(name){
 const spec=neutralClips[name];if(!spec)throw Error('Unknown neutral clip.');const [frames]=spec,width=CELL_WIDTH*frames,height=CELL_HEIGHT,rgba=Buffer.alloc(width*height*4);
 for(let i=0;i<frames;i++){
  const cell=new Float32Array(CELL_WIDTH*CELL_HEIGHT*4),frame=frameOf(name,i,frames);paint(cell,CELL_WIDTH,CELL_HEIGHT,frame.shapes,frame.transform);
  if(frame.glitch)glitch(cell,CELL_WIDTH,CELL_HEIGHT,i+name.length,frame.glitch);
  for(let y=0;y<CELL_HEIGHT;y++)for(let x=0;x<CELL_WIDTH;x++){const s=(y*CELL_WIDTH+x)*4,o=(y*width+i*CELL_WIDTH+x)*4;for(let c=0;c<4;c++)rgba[o+c]=Math.round(Math.max(0,Math.min(1,cell[s+c]))*255);}
 }
 return {width,height,rgba};
}
/** Neutral app icon: chest-core diamond inside a ring, original geometry. */
export function renderIcon(size=256){
 const buffer=new Float32Array(size*size*4),k=size/256,c=128*k;
 paint(buffer,size,size,[circle(c,c,120*k,hex(ink.shell)),circle(c,c,104*k,hex(ink.line),6*k),circle(c,c,92*k,hex(ink.shell)),diamond(c,c,62*k,hex(ink.accent),10*k),diamond(c,c,26*k,hex(ink.spark,.85))]);
 const rgba=Buffer.alloc(size*size*4);for(let i=0;i<rgba.length;i++)rgba[i]=Math.round(Math.max(0,Math.min(1,buffer[i]))*255);return {width:size,height:size,rgba};
}
const sha256=(bytes)=>createHash('sha256').update(bytes).digest('hex');
/** Every generated file, relative to the UI `character` directory, plus the window/installer icon. Deterministic bytes. */
export function neutralAssetFiles(){
 const files=new Map(),clips={};
 for(const [name,[frames,fps]] of Object.entries(neutralClips)){const {width,height,rgba}=renderClip(name),png=encodePng(width,height,rgba);files.set('sprites/'+name+'.png',png);clips[name]={frames,fps,height:name.startsWith('perch')?1:1.11,sha256:sha256(png)};
  if(name==='idle'||name==='perch'){const first=Buffer.alloc(CELL_WIDTH*CELL_HEIGHT*4);for(let y=0;y<CELL_HEIGHT;y++)rgba.copy(first,y*CELL_WIDTH*4,y*width*4,y*width*4+CELL_WIDTH*4);files.set(name+'.png',encodePng(CELL_WIDTH,CELL_HEIGHT,first));}}
 files.set('poster.png',files.get('idle.png'));
 const icon=renderIcon(256),iconPng=encodePng(icon.width,icon.height,icon.rgba);files.set('chip.png',iconPng);files.set('chip.ico',encodeIco(iconPng,256));
 files.set('sprites/manifest.json',Buffer.from(JSON.stringify({provenance:neutralProvenance,clips},null,2)+'\n'));
 return {character:files,icon:{png:iconPng,ico:encodeIco(iconPng,256)}};
}
/** Writes the neutral set: `<uiDir>/character/**` and `<distDir>/icon.{png,ico}`. Never writes outside the given output directories. */
export async function writeNeutralAssets(uiDir,distDir){
 const {character,icon}=neutralAssetFiles();
 for(const [relative,bytes] of character){const file=path.join(uiDir,'character',relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);}
 await writeFile(path.join(distDir,'icon.png'),icon.png);await writeFile(path.join(distDir,'icon.ico'),icon.ico);
 return [...character.keys()];
}
