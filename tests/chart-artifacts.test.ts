import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,realpath,rm,stat,symlink,readdir,link,unlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseChart,renderChartSvg,isGeneratedChartSvg,chartScale,chartCaption,formatChartValue,chartLimits,ChartInputError} from '../src/server/charts';
import {createArtifact,openArtifact,openableArtifactPath} from '../src/server/artifacts';
import {NoSideEffectError} from '../src/server/policy';
import {agencyTools} from '../src/agency-tools';
import {capabilities} from '../src/server/capabilities';
import {builtInSkill} from '../src/extensions/skills';
import {chartPreview,ChartFigure,ArtifactPreviewList} from '../src/ui/ArtifactPreview';
import {Store} from '../src/server/store';
import {Assistant} from '../src/server/assistant';
import {HostTools} from '../src/server/host';
import {defaults} from '../src/shared';
import {createExtensionHub,hubRecordKinds,type HubHostContext,type HubContext} from '../src/extensions/hub';
import {defaultExtensionSettings} from '../src/extensions/contracts';
import {resolveSkillHostFacts} from '../src/extensions/skills';
import {skillEvidenceKind} from '../src/extensions/skill-verification';

const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const tempDir=async(prefix:string)=>realpath(await mkdtemp(path.join(os.tmpdir(),prefix)));
const numbers=(svg:string,attr:string)=>[...svg.matchAll(new RegExp(' '+attr+'="(-?[\\d.]+)"','g'))].map(m=>Number(m[1]));
const line=(over:any={})=>({type:'line',title:'Monthly sales',xLabel:'Month',yLabel:'Units',labels:['Jan','Feb','Mar','Apr'],series:[{name:'North',values:[3,7,2,9]},{name:'South',values:[1,4,6,5]}],...over});
// Plot bounds used by the renderer (left/right/top/bottom of the axis box).
const plot=(svg:string)=>{const axis=[...svg.matchAll(/<line x1="(\d+)" y1="(\d+)" x2="(\d+)" y2="(\d+)" stroke="#a9b6c9" stroke-width="1.5"\/>/g)];
  const vertical=axis.find(m=>m[1]===m[3])!,horizontal=axis.find(m=>m[2]===m[4])!;
  return {left:Number(vertical[1]),top:Number(vertical[2]),bottom:Number(vertical[4]),right:Number(horizontal[3])};};

test('line charts place every point inside the plot with ticks spanning the data',()=>{
  const svg=renderChartSvg(parseChart(line()));
  assert.equal(isGeneratedChartSvg(svg),true);
  assert.match(svg,/<title id="capri-chart-title">Monthly sales<\/title>/);assert.match(svg,/<desc id="capri-chart-desc">Line chart of North, South across 4 categories; values range from 1 to 9\.<\/desc>/);
  assert.match(svg,/role="img" aria-labelledby="capri-chart-title capri-chart-desc"/);
  const box=plot(svg),polylines=[...svg.matchAll(/points="([^"]+)"/g)].map(m=>m[1].split(' ').map(p=>p.split(',').map(Number)));
  assert.equal(polylines.length,2);
  for(const points of polylines){assert.equal(points.length,4);for(const [x,y] of points){assert.ok(x>box.left&&x<box.right);assert.ok(y>=box.top&&y<=box.bottom);}
    for(let i=1;i<points.length;i++)assert.ok(points[i][0]>points[i-1][0],'x increases with label order');}
  // Higher values are drawn higher (smaller y): North Apr=9 is the top-most point.
  const north=polylines[0];assert.equal(Math.min(...north.map(p=>p[1])),north[3][1]);assert.ok(north[2][1]>north[1][1]);
  const scale=chartScale([3,7,2,9,1,4,6,5],false);assert.ok(scale.min<=1&&scale.max>=9&&scale.ticks[0]===scale.min&&scale.ticks.at(-1)===scale.max);
  assert.equal(numbers(svg,'cx').length,8);assert.match(svg,/>Month<\/text>/);assert.match(svg,/>Units<\/text>/);
});

test('bar charts keep a zero baseline for negative, zero and mixed values',()=>{
  const svg=renderChartSvg(parseChart({type:'bar',title:'Profit',labels:['A','B','C','D'],series:[{name:'Net',values:[-5,0,10,-0]}]}));
  assert.equal(isGeneratedChartSvg(svg),true);
  const box=plot(svg),bars=[...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="#4cf6c2" data-series="0" data-index="(\d)">/g)]
    .map(m=>({y:Number(m[2]),h:Number(m[4]),i:Number(m[5])}));
  assert.equal(bars.length,4);
  const zero=Number(/<line x1="\d+" y1="([\d.]+)" x2="\d+" y2="[\d.]+" stroke="#a9b6c9" stroke-width="2"\/>/.exec(svg)![1]);
  assert.ok(zero>box.top&&zero<box.bottom,'zero line is drawn inside a mixed-sign plot');
  const [neg,nil,pos,negZero]=bars;
  assert.ok(Math.abs(neg.y-zero)<0.02&&neg.y+neg.h<=box.bottom+0.01,'negative bars extend down from zero');
  assert.ok(Math.abs(pos.y+pos.h-zero)<0.02&&pos.y>=box.top-0.01,'positive bars extend up to zero');
  assert.equal(nil.h,0);assert.equal(negZero.h,0);assert.ok(pos.h>neg.h);
  const positive=renderChartSvg(parseChart({type:'bar',title:'Only positive',labels:['x','y'],series:[{name:'s',values:[4,8]}]}));
  const scale=chartScale([4,8],true);assert.equal(scale.min,0);assert.ok(numbers(positive,'height').every(h=>h>=0));
});

test('constant and extreme values produce finite deterministic geometry',()=>{
  for(const values of [[5,5,5],[0,0,0],[-3,-3,-3],[1e100,-1e100,0],[1e-9,2e-9,3e-9],[1e99,1e99,1e99]]){
    for(const type of ['line','bar']){
      const spec=parseChart({type,title:'Edge',labels:['a','b','c'],series:[{name:'s',values}]});
      const first=renderChartSvg(spec),second=renderChartSvg(parseChart({type,title:'Edge',labels:['a','b','c'],series:[{name:'s',values}]}));
      assert.equal(first,second,'deterministic');assert.equal(isGeneratedChartSvg(first),true);
      assert.doesNotMatch(first,/NaN|Infinity|e[+-]?\d+"/,'coordinates are fixed-point');
      const box=plot(first);for(const y of [...numbers(first,'cy'),...numbers(first,'y').filter((_,i)=>i>0)])assert.ok(y>=0&&y<=540,String(values));
      if(type==='line')for(const y of numbers(first,'cy'))assert.ok(y>=box.top-0.01&&y<=box.bottom+0.01);
      const scale=chartScale(values,type==='bar');assert.ok(scale.max>scale.min);assert.ok(Math.min(...values)>=scale.min&&Math.max(...values)<=scale.max);
    }
  }
  assert.equal(formatChartValue(1234567),'1.23M');assert.equal(formatChartValue(-0.5),'-0.5');assert.equal(formatChartValue(1e100),'1.00e100');
});

test('closely spaced positive and negative values keep full-precision ticks inside the plot',()=>{
  for(const values of [[1.0000000000011,1.0000000000012],[-1.0000000000012,-1.0000000000011],[123456.78900000001,123456.78900000003],[-5.000000000001e-10,-5e-10],[1,1+2**-52]]){
    const scale=chartScale(values,false);
    assert.ok(scale.max>scale.min&&scale.min<=Math.min(...values)&&scale.max>=Math.max(...values),String(values));
    assert.ok(scale.ticks.every((tick,i)=>Number.isFinite(tick)&&tick>=scale.min&&tick<=scale.max&&(i===0||tick>scale.ticks[i-1])),String(scale.ticks));
    for(const type of ['line','bar']){
      const svg=renderChartSvg(parseChart({type,title:'Close',labels:['a','b'],series:[{name:'s',values}]}));assert.equal(isGeneratedChartSvg(svg),true);
      const box=plot(svg),grid=[...svg.matchAll(/<line x1="\d+" y1="(-?[\d.]+)" x2="\d+" y2="(-?[\d.]+)" stroke="#2a3850"/g)].map(m=>[Number(m[1]),Number(m[2])]);
      assert.ok(grid.length>=2,'grid lines are drawn');
      for(const [y1,y2] of grid){assert.equal(y1,y2);assert.ok(y1>=box.top-0.01&&y1<=box.bottom+0.01,`${values} tick y ${y1}`);}
      const labels=[...svg.matchAll(/<text x="\d+" y="(-?[\d.]+)" font-size="13" fill="#a9b6c9" text-anchor="end">([^<]+)<\/text>/g)];
      assert.equal(labels.length,grid.length);assert.equal(new Set(labels.map(m=>m[2])).size,labels.length,'tick labels stay distinct');
      for(const m of labels)assert.ok(Number(m[1])>=box.top&&Number(m[1])<=box.bottom+5.01);
      if(type==='line')for(const y of numbers(svg,'cy'))assert.ok(y>=box.top-0.01&&y<=box.bottom+0.01);
      else for(const [y,h] of [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)" fill="#4cf6c2"/g)].map(m=>[Number(m[1]),Number(m[2])]))
        assert.ok(y>=box.top-0.01&&y+h<=box.bottom+0.01);
    }
  }
  const [low,high]=chartScale([1.0000000000011,1.0000000000012],false).ticks.filter((_,i,all)=>i===0||i===all.length-1);
  assert.ok(low<=1.0000000000011&&high>=1.0000000000012&&low>1,'ticks are not rounded to 1');
});

test('tick text fits the canvas, clears the y-axis title and keeps close values distinct',()=>{
  const ticksOf=(svg:string)=>[...svg.matchAll(/<text x="(\d+)" y="(-?[\d.]+)" font-size="13" fill="#a9b6c9" text-anchor="end">([^<]+)<\/text>/g)].map(m=>({end:Number(m[1]),label:m[3]}));
  const offsetOf=(svg:string)=>/<text x="(\d+)" y="([\d.]+)" font-size="12" fill="#a9b6c9">Axis values = (-?[\d.e+-]+) \+ tick label<\/text>/.exec(svg);
  const cases:[number[],boolean][]=[[[1.0000000000011,1.0000000000012],true],[[-1.0000000000012,-1.0000000000011],true],[[123456.78900000001,123456.78900000003],true],
    [[1,1+2**-52],true],[[-5.000000000001e-10,-5e-10],true],[[3,7,2,9],false],[[5,5,5],false],[[-3,-3,-3],false],[[1e100,-1e100,0],false],[[1e-9,2e-9,3e-9],false],[[-1234567,250],false]];
  for(const [values,offset] of cases)for(const type of ['line','bar'])for(const yLabel of ['Units',undefined]){
    const spec=parseChart({type,title:'Close',yLabel,labels:values.map((_,i)=>'p'+i),series:[{name:'s',values}]}),svg=renderChartSvg(spec);
    assert.equal(isGeneratedChartSvg(svg),true);
    const box=plot(svg),ticks=ticksOf(svg),scale=chartScale(values,type==='bar');
    assert.equal(ticks.length,scale.ticks.length,String(values));
    assert.equal(new Set(ticks.map(t=>t.label)).size,ticks.length,`${values} tick labels stay distinct`);
    // Conservative width (0.62em per character at 13px) from the anchored end.
    for(const {end,label} of ticks){const start=end-[...label].length*13*0.62;
      assert.ok(end<box.left,`${label} ends left of the axis`);
      assert.ok(start>=(yLabel?36:0),`${values} ${yLabel??'-'}: "${label}" starts at ${start}, inside the canvas and clear of the y-axis title`);}
    // Bars include the zero baseline, so close values never need an offset there.
    const caption=offsetOf(svg);assert.equal(!!caption,offset&&type==='line',`${type} ${values} offset caption`);
    if(caption){
      const base=Number(caption[3]);assert.ok(Number(caption[1])+caption[0].length*12*0.62<960,'offset caption fits');
      assert.ok(Number(caption[2])<box.top&&Number(caption[2])>46,'offset caption sits between the title and the plot');
      // Offsets reconstruct the true tick values: base + delta matches each tick.
      ticks.forEach((t,i)=>{const value=base+(i===0?0:Number(t.label));assert.ok(Math.abs(value-scale.ticks[i])<=Math.abs(scale.ticks[i])*1e-15+1e-300,`${t.label} -> ${value}`);});
      assert.ok(base<=Math.min(...values),'offset is at or below the data');
    }
  }
  // The finding's sample: the full-precision label no longer clips into the y-axis title.
  const sample=renderChartSvg(parseChart({type:'line',title:'Close',yLabel:'Units',labels:['a','b'],series:[{name:'s',values:[1.0000000000011,1.0000000000012]}]}));
  assert.doesNotMatch(sample,/>1\.00000000000112</);assert.match(sample,/Axis values = 1\.000000000001\d* \+ tick label/);
});

test('pie charts show proportional slices, a full circle for one value and reject invalid data',()=>{
  const svg=renderChartSvg(parseChart({type:'pie',title:'Share',labels:['A','B','C','D'],series:[{name:'Share',values:[1,1,2,0]}]}));
  assert.equal(isGeneratedChartSvg(svg),true);
  assert.equal([...svg.matchAll(/<path d="M /g)].length,3,'zero slice is not drawn');
  assert.match(svg,/A \(25\.0%\)/);assert.match(svg,/C \(50\.0%\)/);assert.match(svg,/D \(0\.0%\)/);
  assert.doesNotMatch(svg,/data-index="3"/);
  const full=renderChartSvg(parseChart({type:'pie',title:'All',labels:['Only','None'],series:[{values:[7,0]}]}));
  assert.match(full,/<circle cx="[\d.]+" cy="[\d.]+" r="190"/);
  for(const [bad,reason] of [
    [{values:[1,-1]},/negative/],[{values:[0,0]},/positive/],
  ] as const)assert.throws(()=>parseChart({type:'pie',title:'Bad',labels:['a','b'],series:[bad]}),reason);
  assert.throws(()=>parseChart({type:'pie',title:'Bad',labels:['a','b'],series:[{values:[1,2]},{values:[3,4]}]}),/exactly one series/);
  const many=Array.from({length:chartLimits.maxPieSlices+1},(_,i)=>'s'+i);
  assert.throws(()=>parseChart({type:'pie',title:'Bad',labels:many,series:[{values:many.map(()=>1)}]}),/at most 24 slices/);
});

test('invalid shapes, non-finite values and resource limits are rejected before rendering',()=>{
  const bad:any[]=[undefined,null,[],'chart',{...line(),type:'scatter'},{...line(),labels:[]},{...line(),series:[]},
    {...line(),series:[{name:'x',values:[1,2]}]},{...line(),series:[{name:'x',values:[1,2,NaN,4]}]},{...line(),series:[{name:'x',values:[1,2,Infinity,4]}]},
    {...line(),series:[{name:'x',values:['1',2,3,4]}]},{...line(),series:[{name:'x',values:[1,2,3,1e101]}]},{...line(),legend:'yes'},
    {...line(),color:'#ff0000'},{...line(),style:'fill:red'},{...line(),series:[{name:'x',values:[1,2,3,4],color:'red'}]},
    {...line(),labels:Array.from({length:chartLimits.maxPoints+1},(_,i)=>'l'+i)},
    {...line(),series:Array.from({length:chartLimits.maxSeries+1},()=>({values:[1,2,3,4]}))},
    {...line(),title:'x'.repeat(chartLimits.maxTitle+1)},{...line(),title:''},{...line(),labels:['a','b','c',{}]},
    {...line(),title:'bad\u0000title'},{...line(),title:'rtl\u202eoverride'}];
  for(const input of bad)assert.throws(()=>parseChart(input),ChartInputError,JSON.stringify(input)?.slice(0,80));
  assert.throws(()=>parseChart(Object.create({type:'line'})),ChartInputError);
  // The largest accepted chart (8 series x 200 points, maximal names) still renders within the output bound.
  const longName=(i:number)=>('n'+i).padEnd(chartLimits.maxSeriesName,'x'),longLabel=(i:number)=>('l'+i).padEnd(chartLimits.maxLabel,'y');
  for(const type of ['line','bar']){
    const svg=renderChartSvg(parseChart({type,title:'T'.repeat(chartLimits.maxTitle),description:'D'.repeat(chartLimits.maxDescription),labels:Array.from({length:chartLimits.maxPoints},(_,i)=>longLabel(i)),
      series:Array.from({length:chartLimits.maxSeries},(_,s)=>({name:longName(s),values:Array.from({length:chartLimits.maxPoints},(_,i)=>(i*7919+s*104729)%1000-500)}))}));
    assert.equal(isGeneratedChartSvg(svg),true);assert.ok(svg.length<=chartLimits.maxSvgChars);
  }
});

test('text is escaped and markup, styles, URLs and external resources are rejected',()=>{
  const svg=renderChartSvg(parseChart(line({title:'Q&A "quoted" \'apostrophe\' 5 > 3',labels:['A&B','x < 5','c>','d'],series:[{name:'Tom & Jerry',values:[1,2,3,4]}]})));
  assert.equal(isGeneratedChartSvg(svg),true);
  assert.match(svg,/Q&amp;A &quot;quoted&quot; &#39;apostrophe&#39; 5 &gt; 3/);assert.match(svg,/>A&amp;B</);assert.match(svg,/>x &lt; 5</);assert.match(svg,/Tom &amp; Jerry/);
  assert.equal(chartCaption(svg)?.title,'Q&A "quoted" \'apostrophe\' 5 > 3');
  for(const title of ['<script>alert(1)</script>','<img src=x onerror=alert(1)>','javascript:alert(1)','see https://example.invalid/x','fill: url(#a)','@import "x"','data:text/html,hi','<!ENTITY x>','</title><script>'])
    assert.throws(()=>parseChart(line({title})),/plain text/,title);
  assert.throws(()=>parseChart(line({labels:['a','b','c','<svg onload=alert(1)>']})),/plain text/);
  for(const output of [svg,renderChartSvg(parseChart({type:'pie',title:'P',labels:['a'],series:[{values:[1]}]}))]){
    assert.doesNotMatch(output,/href|<script|<style|style=|<image|<foreignObject|<use|on[a-z]+=|url\(|@import|<!DOCTYPE|<!ENTITY|http:\/\/(?!www\.w3\.org\/2000\/svg")|https:/i);
  }
  const tampered=[svg.replace('</svg>','<script>alert(1)</script></svg>'),svg.replace('</svg>','<image href="https://example.invalid/a.png"/></svg>'),
    svg.replace('</svg>','<style>*{fill:url(https://example.invalid)}</style></svg>'),svg.replace('<rect ','<rect onload="alert(1)" '),
    svg.replace('<rect ','<rect style="fill:red" '),svg.replace('<?xml version="1.0" encoding="UTF-8"?>\n','<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///c:/x">]>'),
    svg.replace('Q&amp;A','&x;Q&amp;A'),svg.replace('</svg>','<foreignObject><div/></foreignObject></svg>'),svg.replace('</svg>','<a href="javascript:alert(1)"><text>x</text></a></svg>'),
    svg.replace('fill="#0f1724"','fill="url(#p)"'),svg.replace('xmlns="http://www.w3.org/2000/svg"','xmlns="http://www.w3.org/1999/xhtml"'),
    svg.replace('</svg>\n','</svg>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>\n'),svg+'<!-- trailing -->',svg.replace('<rect ','<rect x="1" ')];
  for(const value of tampered){assert.notEqual(value,svg);assert.equal(isGeneratedChartSvg(value),false,value.slice(-120));}
});

test('createArtifact writes an svg chart with read-back SHA-256 and leaves no file for invalid input or Stop',async()=>{
  const dir=await tempDir('capri-chart-');try{
    const target=path.join(dir,'out','sales.svg');
    const artifact=await createArtifact(target,{format:'svg',title:'Sales',chart:{type:'bar',labels:['Q1','Q2'],series:[{name:'Units',values:[10,-2]}]}});
    const bytes=await readFile(target);
    assert.equal(artifact.format,'svg');assert.equal(artifact.bytes,bytes.length);assert.equal((await stat(target)).size,bytes.length);
    assert.equal(artifact.sha256,sha(bytes));assert.equal(artifact.preview,bytes.toString('utf8'));
    assert.deepEqual(artifact.verification,[{method:'Read-back SHA-256 and self-contained chart SVG check',passed:true}]);
    assert.match(bytes.toString('utf8'),/<title id="capri-chart-title">Sales<\/title>/,'top-level title is used when chart.title is omitted');
    for(const [file,args,reason] of [
      ['bad.svg',{format:'svg',title:'x'},/Provide chart/],['bad.svg',{format:'svg',title:'x',chart:{type:'pie',labels:['a'],series:[{values:[-1]}]}},/negative/],
      ['bad.svg',{format:'svg',title:'x',chart:{...line(),title:'<script>'}},/plain text/],['bad.png',{format:'svg',title:'x',chart:line()},/matching artifact format/],
      ['bad.svg',{format:'svg',title:'x',chart:{...line(),labels:Array.from({length:1000},(_,i)=>String(i))}},/1 to 200 labels/],
    ] as const)await assert.rejects(createArtifact(path.join(dir,'invalid',file),args),(error:any)=>error instanceof NoSideEffectError&&reason.test(error.message));
    await assert.rejects(stat(path.join(dir,'invalid')),/ENOENT/);
    const stopped=new AbortController();stopped.abort();
    await assert.rejects(createArtifact(path.join(dir,'stopped','chart.svg'),{format:'svg',title:'x',chart:line()},stopped.signal));
    await assert.rejects(stat(path.join(dir,'stopped')),/ENOENT/);
    // Existing document formats are unchanged.
    const md=await createArtifact(path.join(dir,'memo.md'),{format:'md',title:'Memo',sections:[{heading:'H',text:'Body'}]});assert.equal(await readFile(md.path,'utf8'),'# Memo\n\n## H\n\nBody');assert.equal(md.preview,'Memo\nH');
    const csv=await createArtifact(path.join(dir,'t.csv'),{format:'csv',title:'T',rows:[['a',1]]});assert.equal(csv.verification[0].method,'Read-back SHA-256 and format generation');
    const docx=await createArtifact(path.join(dir,'d.docx'),{format:'docx',title:'D',sections:[{text:'x'}]});assert.deepEqual([...(await readFile(docx.path)).subarray(0,2)],[0x50,0x4b]);
    assert.deepEqual((await readdir(path.join(dir,'out'))),['sales.svg'],'no temporary file remains');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Open passes only a re-verified genuine chart path to the shell callback',async()=>{
  const dir=await tempDir('capri-chart-open-');try{
    const target=path.join(dir,'chart.svg'),artifact=await createArtifact(target,{format:'svg',title:'Open me',chart:line()});
    const row={...artifact,id:'artifact-1',taskId:'task-1'};const opened:string[]=[];const shell=async(p:string)=>{opened.push(p);return '';};
    assert.deepEqual(await openArtifact(row,shell),{opened:true});assert.deepEqual(opened,[target]);
    // A genuine generated chart relocated with its matching stored metadata still opens.
    const moved=path.join(dir,'moved','chart.svg');await mkdir(path.dirname(moved));await copyFile(target,moved);
    assert.equal(await openableArtifactPath({...row,path:moved}),moved);
    const refused=async(value:any,reason=/no longer matches|not found/)=>{opened.length=0;await assert.rejects(openArtifact(value,shell),reason);assert.deepEqual(opened,[]);};
    await refused({...row,sha256:'0'.repeat(64)});await refused({...row,bytes:row.bytes+1});await refused({...row,verification:[{method:'x',passed:false}]});
    await refused({...row,verification:[]});await refused({...row,path:'chart.svg'});await refused({...row,path:path.join(dir,'missing.svg')});
    await refused({...row,format:'exe'});await refused(undefined);await refused({...row,path:target.replace(/\.svg$/,'.html')});
    // Tampered bytes with the same size, then an active/external SVG whose forged row hash matches.
    const original=await readFile(target),changed=Buffer.from(original),at=changed.indexOf('Monthly');assert.ok(at>0);changed[at]='X'.charCodeAt(0);await writeFile(target,changed);
    await refused(row);
    for(const active of [original.toString('utf8').replace('</svg>','<script>alert(1)</script></svg>'),original.toString('utf8').replace('</svg>','<image href="https://example.invalid/x.png"/></svg>'),
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>']){
      const forged=path.join(dir,'forged-'+randomBytes(4).toString('hex')+'.svg');await writeFile(forged,active);
      await refused({...row,path:forged,bytes:Buffer.byteLength(active),sha256:sha(active)});
    }
    await writeFile(target,original);assert.equal(await openableArtifactPath(row),target);
    // An alias to a genuine chart is not opened (skipped where symlinks need privileges).
    const alias=path.join(dir,'alias.svg');let linked=true;try{await symlink(target,alias,'file');}catch{linked=false;}
    if(linked)await refused({...row,path:alias});
    // A hard link shares the genuine bytes and identity checks but is a second name: both names are refused.
    const hard=path.join(dir,'hard.svg');await link(target,hard);
    assert.equal((await stat(target)).nlink,2);await refused({...row,path:hard});await refused(row);
    await unlink(hard);assert.equal(await openableArtifactPath(row),target,'a sole directory entry opens again');
    // Original document rows keep their existing Open behavior.
    const md=await createArtifact(path.join(dir,'memo.md'),{format:'md',title:'Memo',sections:[]});opened.length=0;
    assert.deepEqual(await openArtifact({...md,id:'m'},shell),{opened:true});assert.deepEqual(opened,[md.path]);
    await assert.rejects(openArtifact(row,async()=>'No application is associated'),/No application/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('tool schema, capability and reviewed document skill advertise real svg charts',()=>{
  const tool:any=agencyTools.find(t=>t.name==='create_artifact');
  assert.ok(tool.parameters.properties.format.enum.includes('svg'));
  const chart=tool.parameters.properties.chart;assert.deepEqual(chart.properties.type.enum,['line','bar','pie']);assert.equal(chart.additionalProperties,false);
  assert.equal(chart.properties.series.items.additionalProperties,false);assert.equal(chart.properties.labels.maxItems,chartLimits.maxPoints);
  assert.deepEqual(Object.keys(chart.properties).sort(),['description','labels','legend','series','title','type','xLabel','yLabel']);
  assert.ok(capabilities(false).find(c=>c.id==='artifacts')!.operations.some(op=>/svg/.test(op)));
  const skill=builtInSkill('document-artifacts')!;const steps=skill.recipe.steps.join(' ');
  assert.match(steps,/format svg/);assert.doesNotMatch(steps,/no rendered chart/);assert.match(skill.manifest.description,/rendered charts/);
});

test('renderer preview embeds only verified generated bytes as an image',async()=>{
  const dir=await tempDir('capri-chart-preview-');try{
    const artifact=await createArtifact(path.join(dir,'p.svg'),{format:'svg',title:'Preview',chart:{type:'pie',labels:['a','b'],series:[{values:[1,3]}]}});
    const row={...artifact,id:'a1'};const preview=await chartPreview(row);
    assert.ok(preview);assert.equal(preview.title,'Preview');assert.match(preview.description,/Pie chart/);
    assert.equal(decodeURIComponent(preview.src.slice('data:image/svg+xml;charset=utf-8,'.length)),await readFile(artifact.path,'utf8'));
    assert.equal(await chartPreview({...row,sha256:'f'.repeat(64)}),undefined);
    assert.equal(await chartPreview({...row,bytes:row.bytes-1}),undefined);
    const active=String(row.preview).replace('</svg>','<script>alert(1)</script></svg>');assert.equal(await chartPreview({...row,preview:active,sha256:sha(active),bytes:Buffer.byteLength(active)}),undefined);
    assert.equal(await chartPreview({...row,format:'html'}),undefined);assert.equal(await chartPreview(row,null),undefined);
    const figure=renderToStaticMarkup(React.createElement(ChartFigure,{preview}));
    assert.match(figure,/^<figure class="artifact-chart"><img src="data:image\/svg\+xml;charset=utf-8,%3C%3Fxml/);assert.doesNotMatch(figure,/<svg|<script/);
    assert.match(figure,/alt="Preview"/);assert.match(figure,/<figcaption>Pie chart/);
    const list=renderToStaticMarkup(React.createElement(ArtifactPreviewList,{artifacts:[row,{id:'d',format:'md',path:'C:/w/m.md',preview:'# Memo',bytes:6,verification:[{passed:true}]}]}));
    assert.doesNotMatch(list,/<svg|&lt;svg/,'raw chart markup is never injected or dumped');assert.match(list,/Checking chart preview/);assert.match(list,/<pre># Memo<\/pre>/);
    assert.match(list,/svg chart/);assert.equal(list.match(/Open artifact/g)?.length,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});

const done=(text='Done.')=>({output:[{type:'message',content:[{type:'output_text',text}]}]});
const call=(name:string,args:any,id='produce-1')=>({output:[{type:'function_call',name,arguments:JSON.stringify(args),call_id:id}]});
async function taskFixture(){
  const directory=await tempDir('capri-chart-task-'),workspace=path.join(directory,'workspace');await mkdir(workspace);
  const store=await new Store(directory,randomBytes(32)).init(),events:any[]=[];
  const settings=async()=>({...defaults,providerMode:'local' as const,roots:[workspace]});
  const host=new HostTools(store,settings,async()=>true,async()=>{throw Error('No native calls allowed in this fixture.');});
  const saved=defaultExtensionSettings();saved.skills.enabled=true;await store.put(hubRecordKinds.settings,{id:'main',schemaVersion:1,settings:saved});
  const hub=await createExtensionHub({store,clock:Date.now,profile:'self-test',skillFacts:async()=>resolveSkillHostFacts({capabilities:[{id:'artifacts',available:true}],tools:['create_artifact']})});
  let handle:HubContext,source:HubHostContext,heldGrant:unknown;
  const ai=new Assistant(store,settings,()=>undefined,event=>events.push(event),(name,args,signal,id)=>host.run(name,args,signal,id),async(phase,task)=>{
    if(phase==='start'){host.begin(task.id,task.text);heldGrant=host.access.get(task.id);
      source={authority:'task',taskId:task.id,privateSession:!!task.privateSession,localOnly:!!task.localOnly,privacyEpoch:'session-1',signal:ai.controllers.get(task.id)!.signal};
      handle=hub.context(()=>{if(host.access.get(task.id)!==heldGrant)throw Error('Grant revoked.');return source;});
    }else if(phase==='end'){host.end(task.id);hub.releaseContext(handle);}
  });
  ai.extensions={hub,context:()=>handle};ai.router.available=async()=>true;
  const chart={path:'sales.svg',format:'svg',title:'Sales',chart:{type:'line',labels:['Jan','Feb','Mar'],series:[{name:'Units',values:[3,-1,4]}]}};
  const run=async(responses:any[],text='Create a line chart of monthly sales as sales.svg',id='task-1')=>{let index=0;ai.call=async()=>{const response=responses[index++];if(typeof response==='function')return response();return response??done();};await ai.chat(text,false,id);await ai.jobs.get(id);return store.get('task',id);};
  return {store,host,ai,events,workspace,chart,run,async close(){await ai.shutdown();host.close();await hub.close();await store.close();await rm(directory,{recursive:true,force:true});}};
}

test('a chart task verifies against the actual saved svg and its own task receipt',async()=>{
  const f=await taskFixture();try{
    const task=await f.run([call('create_artifact',f.chart),done('Saved sales.svg.')]);
    assert.equal(task?.status,'completed',task?.error);assert.equal(task?.taskVerified,true);
    const bytes=await readFile(path.join(f.workspace,'sales.svg'));assert.equal(isGeneratedChartSvg(bytes.toString('utf8')),true);
    const [row]=await f.store.list('artifact');assert.equal(row.taskId,'task-1');assert.equal(row.format,'svg');assert.equal(row.sha256,sha(bytes));assert.equal(row.bytes,bytes.length);
    const receipts=await f.store.list(skillEvidenceKind);assert.equal(receipts.length,1);
    assert.equal(receipts[0].receipt.binding.taskId,'task-1');assert.equal(receipts[0].receipt.check,'artifact-readback');assert.equal(receipts[0].receipt.proof.sha256,row.sha256);
    assert.equal(await openableArtifactPath(row),row.path);
  }finally{await f.close();}
  const changed=await taskFixture();try{
    const task=await changed.run([call('create_artifact',changed.chart),async()=>{await writeFile(path.join(changed.workspace,'sales.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');return done('Saved sales.svg.');}]);
    assert.notEqual(task?.taskVerified,true,'an externally replaced chart is not verified');
    const [row]=await changed.store.list('artifact');await assert.rejects(openableArtifactPath(row),/no longer matches/);
    assert.equal(changed.events.some(event=>event.state==='success'&&event.taskVerified===true),false);
  }finally{await changed.close();}
});

test('an explicit rendered-chart request needs the saved generated svg, not a csv or markdown receipt',async()=>{
  const csv={path:'sales.csv',format:'csv',title:'Sales',rows:[['Month','Units'],['Jan',3],['Feb',-1]]};
  const md={path:'sales.md',format:'md',title:'Sales',sections:[{heading:'Chart',text:'Jan 3, Feb -1'}]};
  for(const [args,text] of [[csv,'Create a line chart of monthly sales'],[md,'Make a bar graph of monthly sales'],[csv,'Plot monthly sales'],
    [csv,'Create a bar chart as a PDF'],[md,'Create a bar chart as a PDF'],[md,'Create a PDF report with a line chart of monthly sales'],[csv,'Draw a pie chart and save it as a PDF'],
    [csv,'Create a bar chart using the chart data below'],[csv,'Create a bar chart with no images loaded from the internet'],[csv,'Draw a line chart of monthly sales']] as const){
    const f=await taskFixture();try{
      const task=await f.run([call('create_artifact',args),done('Here is your chart.')],text);
      assert.notEqual(task?.taskVerified,true,`${args.format} alone does not satisfy: ${text}`);
      const receipts=await f.store.list(skillEvidenceKind);assert.ok(receipts.length>=1,'the document receipt itself was recorded');
      assert.equal(f.events.some(event=>event.state==='success'&&event.taskVerified===true),false);
    }finally{await f.close();}
  }
  // A genuine saved chart verifies without a path in the request, alongside its data export.
  const both=await taskFixture();try{
    const task=await both.run([call('create_artifact',both.chart),call('create_artifact',csv,'produce-2'),done('Saved.')],'Create a line chart of monthly sales and save the data as CSV');
    assert.equal(task?.status,'completed',task?.error);assert.equal(task?.taskVerified,true);
    assert.deepEqual((await both.store.list('artifact')).map((row:any)=>row.format).sort(),['csv','svg']);
  }finally{await both.close();}
  // A genuine SVG is real chart evidence, but it cannot prove a chart embedded in a PDF.
  const container=await taskFixture();try{
    const task=await container.run([call('create_artifact',container.chart),done('Saved sales.svg.')],'Create a line chart of monthly sales as a PDF');
    assert.notEqual(task?.taskVerified,true,'an svg does not verify a chart requested as a PDF');
    assert.deepEqual((await container.store.list('artifact')).map((row:any)=>row.format),['svg'],'the saved chart is retained');
    assert.equal(container.events.some(event=>event.state==='success'&&event.taskVerified===true),false);
  }finally{await container.close();}
  // Export/container requirements stated in another clause still bind the whole request.
  for(const text of ['Draw a line chart and export as a PDF','Create a line chart and save as report.pdf','Create a PDF report and draw a bar chart in it']){
    const split=await taskFixture();try{
      const task=await split.run([call('create_artifact',split.chart),done('Saved sales.svg.')],text);
      assert.notEqual(task?.taskVerified,true,`a standalone svg does not verify: ${text}`);
      assert.deepEqual((await split.store.list('artifact')).map((row:any)=>row.format),['svg'],'the saved chart is retained');
      assert.equal(split.events.some(event=>event.state==='success'&&event.taskVerified===true),false,text);
    }finally{await split.close();}
  }
  // Ordinary svg output and a separate data-only export remain usable.
  for(const text of ['Create a line chart and save as sales.svg','Draw a line chart from report.pdf and export as sales.svg']){
    const svgOnly=await taskFixture();try{
      const task=await svgOnly.run([call('create_artifact',svgOnly.chart),done('Saved sales.svg.')],text);
      assert.equal(task?.status,'completed',text+': '+task?.error);assert.equal(task?.taskVerified,true,text);
    }finally{await svgOnly.close();}
  }
  const dataExport=await taskFixture();try{
    const task=await dataExport.run([call('create_artifact',dataExport.chart),call('create_artifact',csv,'produce-2'),done('Saved.')],'Draw a line chart of monthly sales and export the data as CSV');
    assert.equal(task?.status,'completed',task?.error);assert.equal(task?.taskVerified,true);
  }finally{await dataExport.close();}
  // Keyword-free and plot-noun requests select, bind and verify the real saved SVG; a
  // spreadsheet named only as the data source is not an output container.
  for(const text of ['Visualize monthly sales','Create a plot of monthly sales','Create a line chart using data in the spreadsheet']){
    const positive=await taskFixture();try{
      const task=await positive.run([call('create_artifact',positive.chart),done('Saved sales.svg.')],text);
      assert.equal(task?.status,'completed',text+': '+task?.error);assert.equal(task?.taskVerified,true,text);
      assert.deepEqual((await positive.store.list(skillEvidenceKind)).map((row:any)=>row.receipt.binding.skillId),['document-artifacts'],text);
    }finally{await positive.close();}
  }
  for(const [args,text] of [[csv,'Visualize monthly sales'],[md,'Create a plot of monthly sales'],[csv,'Create a line chart using data in the spreadsheet']] as const){
    const other=await taskFixture();try{
      const task=await other.run([call('create_artifact',args),done('Here is your chart.')],text);
      assert.notEqual(task?.taskVerified,true,`${args.format} alone does not satisfy: ${text}`);
      assert.equal(other.events.some(event=>event.state==='success'&&event.taskVerified===true),false,text);
    }finally{await other.close();}
  }
  // Ordinary data-only exports keep verifying from their own read-back.
  for(const text of ['Export the monthly sales data as CSV','Create the chart data for monthly sales as a CSV']){
    const data=await taskFixture();try{
      const task=await data.run([call('create_artifact',csv),done('Saved sales.csv.')],text);
      assert.equal(task?.status,'completed',task?.error);assert.equal(task?.taskVerified,true,text);
    }finally{await data.close();}
  }
});

test('a final answer with no saved chart never completes a drawn-chart request',async()=>{
  for(const text of ['Draw a line chart of monthly sales','Render a pie chart of the budget','Plot monthly sales',
    'Create a bar chart using the chart data below','Create a bar chart with no images loaded from the internet',
    'Visualize monthly sales','Create a plot of monthly sales','Create a line chart using data in the spreadsheet']){
    const f=await taskFixture();try{
      const task=await f.run([done('Here is your chart: Jan 3, Feb -1, Mar 4.')],text,'task-answer');
      assert.notEqual(task?.status,'completed',text);assert.notEqual(task?.taskVerified,true,text);
      assert.deepEqual(await f.store.list('artifact'),[],text);
      assert.equal(f.events.some(event=>event.state==='success'),false,text);
    }finally{await f.close();}
  }
});

test('Stop during a chart dispatch writes no chart and reports no success',async()=>{
  const f=await taskFixture();try{
    const run=f.host.run.bind(f.host);let reached=false;
    f.host.run=async(name,args,signal,id)=>{if(name==='create_artifact'){reached=true;f.ai.stop();}return run(name,args,signal,id);};
    const task=await f.run([call('create_artifact',f.chart),done('Saved sales.svg.')]);
    assert.equal(reached,true);assert.notEqual(task?.status,'completed');assert.notEqual(task?.taskVerified,true);
    await assert.rejects(stat(path.join(f.workspace,'sales.svg')),/ENOENT/);
    assert.deepEqual(await f.store.list('artifact'),[]);assert.deepEqual(await f.store.list(skillEvidenceKind),[]);
    assert.equal(f.events.some(event=>event.state==='success'),false);
  }finally{await f.close();}
});
