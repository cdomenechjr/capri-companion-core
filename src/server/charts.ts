// Self-contained SVG chart artifacts. Pure code (no Node imports) so the renderer
// can reuse the same strict output checker before it embeds a preview.
// Model input is data only: every string is escaped text content, colors/fonts/
// layout are fixed here, and no markup, CSS, script or resource reference is accepted.

export const chartTypes=['line','bar','pie'] as const;
export type ChartType=typeof chartTypes[number];
export interface ChartSeries {name:string;values:number[]}
export interface ChartSpec {type:ChartType;title:string;description?:string;xLabel?:string;yLabel?:string;labels:string[];series:ChartSeries[];legend:boolean}
export const chartLimits=Object.freeze({maxSeries:8,maxPoints:200,maxCells:1600,maxPieSlices:24,maxTitle:200,maxDescription:600,
  maxAxisLabel:80,maxLabel:60,maxSeriesName:60,maxAbsValue:1e100,maxSvgChars:600_000});
export class ChartInputError extends Error {}

const keys=['type','title','description','xLabel','yLabel','labels','series','legend'];
const fail=(message:string):never=>{throw new ChartInputError(message);};
const plainObject=(value:unknown):value is Record<string,unknown>=>
  typeof value==='object'&&value!==null&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
// Controls, bidirectional overrides, lone surrogates and XML-forbidden code points
// are rejected; markup, script/data URLs and CSS constructs are not chart text.
const invalidText=/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufffe\uffff]|\p{Cs}/u;
const codeLike=/<\s*[a-z!?/]|\b[a-z][a-z0-9+.-]*:\/\/|\b(?:javascript|vbscript|data)\s*:|\burl\s*\(|@import|\bexpression\s*\(/i;
function text(value:unknown,field:string,max:number,required:boolean):string|undefined {
  if(value===undefined&&!required)return undefined;
  if(typeof value==='number'&&Number.isFinite(value)&&field==='label')value=String(value);
  if(typeof value!=='string')return fail(`Chart ${field} must be text.`);
  if(value.length>max*4)return fail(`Chart ${field} is too long.`);
  const result=value.normalize('NFC').trim();
  if(required&&!result)return fail(`Chart ${field} is required.`);
  if([...result].length>max)return fail(`Chart ${field} exceeds ${max} characters.`);
  if(invalidText.test(result))return fail(`Chart ${field} contains control or invalid characters.`);
  if(codeLike.test(result))return fail(`Chart ${field} must be plain text, not markup, styles or URLs.`);
  return result||undefined;
}

/** Validates shape, limits and pie semantics before any file is written. */
export function parseChart(input:unknown):ChartSpec {
  if(!plainObject(input))return fail('Provide chart as an object with type, title, labels and series.');
  for(const key of Object.keys(input))if(!keys.includes(key))return fail(`Unsupported chart field: ${key.slice(0,40)}. Colors, styles and markup are fixed by Capri.`);
  const type=input.type;
  if(typeof type!=='string'||!(chartTypes as readonly string[]).includes(type))return fail('Chart type must be line, bar or pie.');
  if(!Array.isArray(input.labels)||!Array.isArray(input.series))return fail('Chart labels and series must be arrays.');
  const {labels:rawLabels,series:rawSeries}=input;
  if(rawLabels.length<1||rawLabels.length>chartLimits.maxPoints)return fail(`Charts need 1 to ${chartLimits.maxPoints} labels.`);
  if(rawSeries.length<1||rawSeries.length>chartLimits.maxSeries)return fail(`Charts need 1 to ${chartLimits.maxSeries} series.`);
  if(rawLabels.length*rawSeries.length>chartLimits.maxCells)return fail(`Charts support at most ${chartLimits.maxCells} values.`);
  const labels=rawLabels.map(label=>text(label,'label',chartLimits.maxLabel,true)!);
  const series=rawSeries.map((raw:unknown,index):ChartSeries=>{
    if(!plainObject(raw))return fail('Each chart series needs a name and values.');
    for(const key of Object.keys(raw))if(key!=='name'&&key!=='values')return fail(`Unsupported chart series field: ${key.slice(0,40)}.`);
    const name=text(raw.name??`Series ${index+1}`,'series name',chartLimits.maxSeriesName,true)!;
    if(!Array.isArray(raw.values)||raw.values.length!==labels.length)return fail('Each chart series needs exactly one value per label.');
    const values=raw.values.map((value:unknown)=>{
      if(typeof value!=='number'||!Number.isFinite(value))return fail('Chart values must be finite numbers.');
      if(Math.abs(value)>chartLimits.maxAbsValue)return fail('Chart values must be between -1e100 and 1e100.');
      return Object.is(value,-0)?0:value;
    });
    return {name,values};
  });
  if(input.legend!==undefined&&typeof input.legend!=='boolean')return fail('Chart legend must be true or false.');
  if(type==='pie'){
    if(series.length!==1)return fail('Pie charts need exactly one series.');
    if(labels.length>chartLimits.maxPieSlices)return fail(`Pie charts support at most ${chartLimits.maxPieSlices} slices.`);
    if(series[0].values.some(value=>value<0))return fail('Pie chart values cannot be negative.');
    if(!series[0].values.some(value=>value>0))return fail('Pie charts need at least one positive value.');
  }
  return {type:type as ChartType,title:text(input.title,'title',chartLimits.maxTitle,true)!,
    description:text(input.description,'description',chartLimits.maxDescription,false),
    xLabel:type==='pie'?undefined:text(input.xLabel,'x-axis label',chartLimits.maxAxisLabel,false),
    yLabel:type==='pie'?undefined:text(input.yLabel,'y-axis label',chartLimits.maxAxisLabel,false),
    labels,series,legend:input.legend??(type==='pie'||series.length>1)};
}

const escapeXml=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const clip=(value:string,max:number)=>{const chars=[...value];return chars.length>max?chars.slice(0,max-1).join('')+'…':value;};
/** Coordinates are fixed-point decimals inside the canvas; never exponent notation. */
function n(value:number):string {
  if(!Number.isFinite(value))throw Error('Chart geometry is not finite.');
  const rounded=Math.round(value*100)/100;return String(Object.is(rounded,-0)?0:rounded);
}
/** Deterministic, locale-independent value labels. */
export function formatChartValue(value:number):string {
  if(value===0)return '0';
  const abs=Math.abs(value),sign=value<0?'-':'';
  if(abs>=1e15||abs<1e-4)return value.toExponential(2).replace('e+','e');
  for(const [size,suffix] of [[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'k']] as const)
    if(abs>=size)return sign+String(Number((abs/size).toPrecision(3)))+suffix;
  return sign+String(Number(abs.toPrecision(4)));
}
const niceStep=(raw:number)=>{
  const exponent=Math.floor(Math.log10(raw)),base=10**exponent,fraction=raw/base;
  return (fraction<=1?1:fraction<=2?2:fraction<=2.5?2.5:fraction<=5?5:10)*base;
};
/** Axis domain covers every value (and zero for bars); constant data gets a symmetric pad. */
export function chartScale(values:readonly number[],includeZero:boolean):{min:number;max:number;ticks:number[]} {
  let min=Math.min(...values),max=Math.max(...values);
  if(includeZero){min=Math.min(min,0);max=Math.max(max,0);}
  if(min===max){const pad=min===0?1:Math.abs(min)*0.1;min=includeZero&&min>=0?0:min-pad;max=includeZero&&max<=0?0:max+pad;if(min===max)max=min+1;}
  const step=niceStep((max-min)/5);
  let low=Math.floor(min/step)*step,high=Math.ceil(max/step)*step;
  // Floating rounding near extreme magnitudes must never exclude real data.
  if(!(low<=min))low=min;if(!(high>=max))high=max;
  const count=Math.min(12,Math.max(1,Math.round((high-low)/step)));
  // Full double precision, clamped into the domain: rounding closely spaced ticks
  // (e.g. 1.0000000000011) would move them far outside the plot.
  const ticks:number[]=[];
  for(let i=0;i<=count;i++){const tick=i===count?high:Math.min(high,Math.max(low,low+i*step));if(!ticks.length||tick>ticks.at(-1)!)ticks.push(tick);}
  return {min:low,max:high,ticks};
}
/** Tick labels stay distinct: compact labels first, then only as many digits as the ticks need. */
export function chartTickLabels(ticks:readonly number[]):string[] {
  const distinct=(labels:string[])=>labels.every((label,i)=>i===0||label!==labels[i-1]);
  let labels=ticks.map(formatChartValue);
  for(let digits=5;digits<=17&&!distinct(labels);digits++)labels=ticks.map(tick=>tick===0?'0':String(Number(tick.toPrecision(digits))));
  return labels;
}
/** Conservative tick text width: 0.62em per character exceeds Segoe UI/Arial digit and sign advances. */
export const tickFontSize=13;
export const chartTextWidth=(label:string,size=tickFontSize)=>[...label].length*size*0.62;
const maxTickChars=12;
/** Long full-precision tick labels (closely spaced values) become distinct offsets from
 * the first tick, with the exact offset printed once beside the axis. */
export function chartAxisLabels(ticks:readonly number[]):{labels:string[];offset?:number} {
  const labels=chartTickLabels(ticks),longest=(list:string[])=>Math.max(...list.map(label=>[...label].length));
  if(longest(labels)<=maxTickChars||ticks.length<2)return {labels};
  const base=ticks[0],raw=ticks.map(tick=>tick-base),deltas=chartTickLabels(raw).map((label,i)=>i===0?'0':'+'+label);
  const distinct=deltas.every((label,i)=>i===0||raw[i]>raw[i-1]&&label!==deltas[i-1]);
  return distinct&&longest(deltas)<longest(labels)?{labels:deltas,offset:base}:{labels};
}

const W=960,H=540,colors=['#4cf6c2','#ff5fae','#ffd166','#5aa9ff','#c792ea','#ff9b54','#9be564','#ff6b6b'];
const ink='#eef3fb',muted='#a9b6c9',grid='#2a3850',background='#0f1724',font='Segoe UI, Arial, sans-serif';
const header='<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"';

export function chartDescription(spec:ChartSpec):string {
  if(spec.description)return spec.description;
  const values=spec.series.flatMap(s=>s.values);
  const kind=spec.type==='pie'?'Pie chart':spec.type==='bar'?'Bar chart':'Line chart';
  return `${kind} of ${spec.series.map(s=>s.name).join(', ')} across ${spec.labels.length} ${spec.labels.length===1?'category':'categories'}`+
    `${spec.type==='pie'?'':`; values range from ${formatChartValue(Math.min(...values))} to ${formatChartValue(Math.max(...values))}`}.`;
}

/** Renders validated data only. Callers pass the result of parseChart. */
export function renderChartSvg(spec:ChartSpec):string {
  const out:string[]=[],legendWidth=spec.legend?200:0,description=chartDescription(spec);
  out.push(`${header} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="capri-chart-title capri-chart-desc" data-capri-chart="${spec.type}" font-family="${font}">`,
    `<title id="capri-chart-title">${escapeXml(spec.title)}</title>`,`<desc id="capri-chart-desc">${escapeXml(description)}</desc>`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="${background}"/>`,
    `<text x="${W/2}" y="40" font-size="24" font-weight="600" fill="${ink}" text-anchor="middle">${escapeXml(clip(spec.title,70))}</text>`);
  const legend=(entries:{name:string;color:string}[],top:number)=>{
    // Up to 24 pie entries still fit inside the canvas.
    const row=Math.min(24,(H-top-20)/entries.length),size=row<20?12:14;
    entries.forEach((entry,index)=>{const y=top+index*row;
      out.push(`<rect x="${W-legendWidth+16}" y="${n(y-size+2)}" width="${size}" height="${size}" fill="${entry.color}"/>`,
        `<text x="${W-legendWidth+38}" y="${n(y)}" font-size="${size}" fill="${ink}">${escapeXml(clip(entry.name,22))}</text>`);});
  };
  if(spec.type==='pie'){
    const values=spec.series[0].values,total=values.reduce((sum,value)=>sum+value,0);
    const cx=(W-legendWidth)/2,cy=H/2+20,r=190;let angle=-Math.PI/2;
    values.forEach((value,index)=>{
      const color=colors[index%colors.length],share=value/total,percent=(share*100).toFixed(1)+'%';
      const tip=`<title>${escapeXml(spec.labels[index])}: ${escapeXml(formatChartValue(value))} (${percent})</title>`;
      if(value===0)return;
      if(share>=1-1e-12){out.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${r}" fill="${color}" stroke="${background}" stroke-width="2" data-index="${index}">${tip}</circle>`);return;}
      const end=angle+share*2*Math.PI,large=share>0.5?1:0;
      out.push(`<path d="M ${n(cx)} ${n(cy)} L ${n(cx+r*Math.cos(angle))} ${n(cy+r*Math.sin(angle))} A ${r} ${r} 0 ${large} 1 ${n(cx+r*Math.cos(end))} ${n(cy+r*Math.sin(end))} Z" fill="${color}" stroke="${background}" stroke-width="2" data-index="${index}">${tip}</path>`);
      if(share>=0.04){const mid=(angle+end)/2;
        out.push(`<text x="${n(cx+r*0.65*Math.cos(mid))}" y="${n(cy+r*0.65*Math.sin(mid)+5)}" font-size="14" font-weight="600" fill="${background}" text-anchor="middle">${percent}</text>`);}
      angle=end;
    });
    if(spec.legend)legend(spec.labels.map((label,index)=>({name:`${label} (${(values[index]/total*100).toFixed(1)}%)`,color:colors[index%colors.length]})),90);
  }else{
    const scale=chartScale(spec.series.flatMap(s=>s.values),spec.type==='bar'),axis=chartAxisLabels(scale.ticks),tickLabels=axis.labels;
    // Tick text ends 10px left of the axis and starts clear of the rotated y-axis title
    // (which occupies roughly x 12-28), so the margin grows with the widest label.
    const left=Math.max(96,Math.ceil((spec.yLabel?40:8)+Math.max(...tickLabels.map(label=>chartTextWidth(label)))+10));
    const right=W-legendWidth-24,top=70,bottom=H-(spec.xLabel?96:72),plotW=right-left,plotH=bottom-top;
    // Every plotted coordinate must be finite and inside the plot box; otherwise fail closed.
    const y=(value:number)=>{const at=bottom-((value-scale.min)/(scale.max-scale.min))*plotH;
      if(!Number.isFinite(at)||at<top-0.01||at>bottom+0.01)throw Error('Chart geometry is outside the plot.');return at;};
    const band=plotW/spec.labels.length,center=(index:number)=>left+band*(index+0.5);
    scale.ticks.forEach((tick,index)=>out.push(`<line x1="${left}" y1="${n(y(tick))}" x2="${right}" y2="${n(y(tick))}" stroke="${grid}" stroke-width="1"/>`,
      `<text x="${left-10}" y="${n(y(tick)+5)}" font-size="${tickFontSize}" fill="${muted}" text-anchor="end">${escapeXml(tickLabels[index])}</text>`));
    if(axis.offset!==undefined)out.push(`<text x="${left}" y="${top-10}" font-size="12" fill="${muted}">${escapeXml(`Axis values = ${String(axis.offset)} + tick label`)}</text>`);
    if(scale.min<0&&scale.max>0)out.push(`<line x1="${left}" y1="${n(y(0))}" x2="${right}" y2="${n(y(0))}" stroke="${muted}" stroke-width="2"/>`);
    out.push(`<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="${muted}" stroke-width="1.5"/>`,
      `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${muted}" stroke-width="1.5"/>`);
    const every=Math.max(1,Math.ceil(spec.labels.length/Math.max(1,Math.floor(plotW/72))));
    spec.labels.forEach((label,index)=>{if(index%every===0)
      out.push(`<text x="${n(center(index))}" y="${bottom+22}" font-size="13" fill="${ink}" text-anchor="middle">${escapeXml(clip(label,12))}</text>`);});
    if(spec.xLabel)out.push(`<text x="${n(left+plotW/2)}" y="${H-24}" font-size="15" fill="${ink}" text-anchor="middle">${escapeXml(clip(spec.xLabel,60))}</text>`);
    if(spec.yLabel)out.push(`<text x="24" y="${n(top+plotH/2)}" font-size="15" fill="${ink}" text-anchor="middle" transform="rotate(-90 24 ${n(top+plotH/2)})">${escapeXml(clip(spec.yLabel,40))}</text>`);
    const tip=(series:ChartSeries,index:number)=>`<title>${escapeXml(series.name)}, ${escapeXml(spec.labels[index])}: ${escapeXml(formatChartValue(series.values[index]))}</title>`;
    if(spec.type==='bar'){
      const groupW=band*0.8,barW=groupW/spec.series.length,base=y(Math.min(Math.max(0,scale.min),scale.max));
      spec.series.forEach((series,s)=>series.values.forEach((value,index)=>{
        const x=left+band*index+band*0.1+barW*s,barTop=Math.min(base,y(value));
        out.push(`<rect x="${n(x)}" y="${n(barTop)}" width="${n(Math.max(barW-1,0.5))}" height="${n(Math.abs(y(value)-base))}" fill="${colors[s%colors.length]}" data-series="${s}" data-index="${index}">${tip(series,index)}</rect>`);
      }));
    }else{
      spec.series.forEach((series,s)=>{const color=colors[s%colors.length];
        out.push(`<polyline points="${series.values.map((value,index)=>n(center(index))+','+n(y(value))).join(' ')}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" data-series="${s}"/>`);
        if(spec.labels.length<=60)series.values.forEach((value,index)=>
          out.push(`<circle cx="${n(center(index))}" cy="${n(y(value))}" r="4" fill="${color}" data-series="${s}" data-index="${index}">${tip(series,index)}</circle>`));
      });
    }
    if(spec.legend)legend(spec.series.map((series,s)=>({name:series.name,color:colors[s%colors.length]})),90);
  }
  out.push('</svg>\n');
  const svg=out.join('\n');
  if(svg.length>chartLimits.maxSvgChars)throw new ChartInputError('The chart is too large to render.');
  if(!isGeneratedChartSvg(svg))throw Error('Generated chart failed its output check.');
  return svg;
}

// Strict allowlist for exactly what renderChartSvg emits. Anything else (scripts,
// styles, foreign objects, links, entities or external references) fails closed.
const elements=new Set(['svg','title','desc','rect','text','line','polyline','circle','path']);
const numeric=/^-?\d+(?:\.\d+)?$/;
const attributes:Record<string,RegExp>={
  width:numeric,height:numeric,x:numeric,y:numeric,x1:numeric,y1:numeric,x2:numeric,y2:numeric,cx:numeric,cy:numeric,r:numeric,
  'stroke-width':numeric,'font-size':numeric,'font-weight':/^600$/,viewBox:/^0 0 \d+ \d+$/,role:/^img$/,
  'aria-labelledby':/^capri-chart-title capri-chart-desc$/,id:/^capri-chart-(?:title|desc)$/,'data-capri-chart':/^(?:line|bar|pie)$/,
  'data-series':/^\d+$/,'data-index':/^\d+$/,'font-family':/^Segoe UI, Arial, sans-serif$/,fill:/^(?:#[0-9a-f]{6}|none)$/,stroke:/^#[0-9a-f]{6}$/,
  'text-anchor':/^(?:middle|end)$/,'stroke-linejoin':/^round$/,'stroke-linecap':/^round$/,
  points:/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?(?: -?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?)*$/,d:/^[MLAZ0-9 .-]+$/,transform:/^rotate\(-90 \d+(?:\.\d+)? \d+(?:\.\d+)?\)$/,
};
/** True only for well-formed output of this renderer; used before writing and before preview embedding. */
export function isGeneratedChartSvg(value:unknown):value is string {
  if(typeof value!=='string'||value.length>chartLimits.maxSvgChars||!value.startsWith(header)||!value.endsWith('</svg>\n'))return false;
  const body=value.slice('<?xml version="1.0" encoding="UTF-8"?>\n'.length),stack:string[]=[];let root=0;
  for(const token of body.match(/<[^<>]*>|[^<>]+|[<>]/g)??[]){
    if(token[0]!=='<'){if(token==='>'||!stack.length&&token.trim()||/&(?!(?:amp|lt|gt|quot|#39);)/.test(token))return false;continue;}
    const tag=/^<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z][a-zA-Z0-9-]*="[^"<>&]*")*)\s*(\/?)>$/.exec(token);
    if(!tag||!elements.has(tag[2]))return false;
    const [,closing,name,attrs,selfClosing]=tag;
    if(closing){if(attrs||selfClosing||stack.pop()!==name)return false;continue;}
    if(name==='svg'?root++>0||stack.length:!stack.length)return false;
    const seen=new Set<string>();
    for(const [,key,attr] of attrs.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g)){
      if(seen.has(key))return false;seen.add(key);
      if(name==='svg'&&key==='xmlns'){if(attr!=='http://www.w3.org/2000/svg')return false;continue;}
      if(!Object.hasOwn(attributes,key)||!attributes[key].test(attr))return false;
    }
    if(!selfClosing)stack.push(name);
  }
  return root===1&&stack.length===0;
}
/** Plain-text title/description for captions; derived only from a checked SVG. */
export function chartCaption(svg:string):{title:string;description:string}|undefined {
  if(!isGeneratedChartSvg(svg))return undefined;
  const decode=(s:string)=>s.replace(/&(amp|lt|gt|quot|#39);/g,(_,e)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[e as string]!));
  const title=/<title id="capri-chart-title">([^<]*)<\/title>/.exec(svg)?.[1],description=/<desc id="capri-chart-desc">([^<]*)<\/desc>/.exec(svg)?.[1];
  return title===undefined||description===undefined?undefined:{title:decode(title),description:decode(description)};
}
