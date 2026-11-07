import {Document,Packer,Paragraph,HeadingLevel} from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import {mkdir,writeFile,readFile,stat,rename,unlink,lstat,realpath,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Artifact} from '../agency';
import {NoSideEffectError} from './policy';
import {ChartInputError,chartLimits,isGeneratedChartSvg,parseChart,renderChartSvg} from './charts';

const documentFormats=['docx','xlsx','pptx','pdf','html','md','csv'];
/** Resolves the path the desktop may hand to the shell for a stored artifact row.
 * Documents keep their existing behavior. An SVG opens only as the genuine generated
 * chart: the bounded, regular, non-aliased file is re-read and its bytes must match the
 * stored size/SHA-256 and pass the generated-chart check. Extension or labels never suffice. */
export async function openableArtifactPath(row:any):Promise<string>{
 if(!row||typeof row.path!=='string')throw Error('Artifact not found.');
 if(documentFormats.includes(row.format))return row.path;
 if(row.format!=='svg')throw Error('Artifact not found.');
 const refuse=():never=>{throw Error('This chart no longer matches its verified artifact and was not opened.');};
 const target=row.path;
 if(!path.isAbsolute(target)||path.extname(target).toLowerCase()!=='.svg'||!Number.isSafeInteger(row.bytes)||row.bytes<=0||row.bytes>chartLimits.maxSvgChars*4||
  typeof row.sha256!=='string'||!/^[0-9a-f]{64}$/.test(row.sha256)||!Array.isArray(row.verification)||!row.verification.length||!row.verification.every((v:any)=>v?.passed===true))refuse();
 let data:Buffer;
 try{
  // A hard link is another name for the same bytes; only a sole directory entry opens.
  const link=await lstat(target);if(!link.isFile()||link.isSymbolicLink()||link.nlink!==1||link.size!==row.bytes)refuse();
  const real=await realpath(target),same=process.platform==='win32'?real.toLowerCase()===path.resolve(target).toLowerCase():real===path.resolve(target);if(!same)refuse();
  const handle=await open(target,'r');
  try{const info=await handle.stat();if(!info.isFile()||info.nlink!==1||info.size!==row.bytes||info.ino!==link.ino||info.dev!==link.dev)refuse();
   data=Buffer.alloc(row.bytes+1);const {bytesRead}=await handle.read(data,0,row.bytes+1,0);if(bytesRead!==row.bytes)refuse();data=data.subarray(0,bytesRead);}
  finally{await handle.close();}
 }catch(error){if(error instanceof Error&&/no longer matches/.test(error.message))throw error;return refuse();}
 const text=data.toString('utf8');
 if(createHash('sha256').update(data).digest('hex')!==row.sha256||!Buffer.from(text,'utf8').equals(data)||!isGeneratedChartSvg(text))refuse();
 return target;
}
/** The existing Open action: only a verified path ever reaches the shell callback. */
export async function openArtifact(row:any,openPath:(target:string)=>Promise<string>):Promise<{opened:true}>{
 const target=await openableArtifactPath(row);const result=await openPath(target);if(result)throw Error(result);return {opened:true};
}

export const artifactFormats=[...documentFormats,'svg'];
export async function createArtifact(target:string,args:any,signal?:AbortSignal):Promise<Artifact>{
 signal?.throwIfAborted();
 const format=String(args.format);if(!artifactFormats.includes(format)||path.extname(target).toLowerCase()!=='.'+format)throw new NoSideEffectError('Choose a matching artifact format and file extension.');
 const title=String(args.title||'Capri artifact').slice(0,300);const sections=(args.sections||[]).slice(0,100);let data:Buffer;let preview='';
 if(format==='svg'){
  // Chart data is validated before any filesystem effect; the SVG itself is the checked preview.
  const raw=args.chart,input=raw&&typeof raw==='object'&&!Array.isArray(raw)&&raw.title===undefined?{...raw,title}:raw;
  let chart;try{chart=parseChart(input);}catch(error){if(error instanceof ChartInputError)throw new NoSideEffectError(error.message);throw error;}
  try{preview=renderChartSvg(chart);}catch(error){throw new NoSideEffectError(error instanceof ChartInputError?error.message:'The chart could not be rendered safely.');}
  data=Buffer.from(preview,'utf8');
 }else if(format==='docx'){
  const children=[new Paragraph({text:title,heading:HeadingLevel.TITLE}),...sections.flatMap((s:any)=>[new Paragraph({text:String(s.heading||''),heading:HeadingLevel.HEADING_1}),...String(s.text||'').split('\n').map(text=>new Paragraph(text))])];
  data=await Packer.toBuffer(new Document({sections:[{children}]}));
 }else if(format==='xlsx'){
  const book=new ExcelJS.Workbook();for(const s of (args.sheets||[{name:'Sheet1',rows:args.rows||[]}]).slice(0,30)){const sheet=book.addWorksheet(String(s.name||'Sheet').replace(/[\\/*?:\[\]]/g,'').slice(0,31));for(const row of (s.rows||[]).slice(0,10000))sheet.addRow(row.map((v:any)=>typeof v==='number'?v:String(v??'')));sheet.getRow(1).font={bold:true};sheet.columns.forEach(c=>{c.width=24;});sheet.views=[{state:'frozen',ySplit:1}];}data=Buffer.from(await book.xlsx.writeBuffer());
 }else if(format==='pptx'){
  const deck=new PptxGenJS();deck.layout='LAYOUT_WIDE';deck.author='Capri';deck.title=title;for(const s of (sections.length?sections:[{heading:title,text:''}])){const slide=deck.addSlide();slide.background={color:'101725'};slide.addText(String(s.heading||title),{x:.6,y:.5,w:12.1,h:.8,fontSize:28,bold:true,color:'4CF6C2',breakLine:false});slide.addText(String(s.text||''),{x:.7,y:1.7,w:11.9,h:4.7,fontSize:20,color:'FFFFFF',breakLine:false,fit:'shrink',valign:'top'});}data=await deck.write({outputType:'nodebuffer'}) as Buffer;
 }else if(format==='pdf'){
  const pdf=await PDFDocument.create();const font=await pdf.embedFont(StandardFonts.Helvetica);let page=pdf.addPage(),y=790;
  const text=[title,...sections.flatMap((s:any)=>[s.heading||'',s.text||''])].join('\n\n').replace(/[^\x20-\x7e\n]/g,'?');
  for(const raw of text.split('\n')){const words=raw.split(/\s+/);let line='';for(const word of words){if(font.widthOfTextAtSize(line+' '+word,11)>480){if(y<55){page=pdf.addPage();y=790;}page.drawText(line,{x:48,y,size:11,font,color:rgb(.06,.09,.14)});y-=16;line=word;}else line+=(line?' ':'')+word;}if(y<55){page=pdf.addPage();y=790;}page.drawText(line,{x:48,y,size:11,font});y-=18;}data=Buffer.from(await pdf.save());
 }else if(format==='csv'){
  data=Buffer.from((args.rows||[]).map((r:any[])=>r.map(v=>'"'+String(v??'').replace(/"/g,'""').replace(/^([=+@-])/,'\'$1')+'"').join(',')).join('\r\n'));
 }else if(format==='html'){
  const esc=(s:any)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  preview='<!doctype html><html><meta charset="utf-8"><title>'+esc(title)+'</title><style>body{max-width:800px;margin:50px auto;font:18px/1.6 system-ui;padding:20px;color:#172230}h1,h2{line-height:1.2}pre{white-space:pre-wrap}</style><h1>'+esc(title)+'</h1>'+sections.map((s:any)=>'<h2>'+esc(s.heading||'')+'</h2><pre>'+esc(s.text||'')+'</pre>').join('')+'</html>';data=Buffer.from(preview);
 }else data=Buffer.from('# '+title+'\n\n'+sections.map((s:any)=>'## '+String(s.heading||'')+'\n\n'+String(s.text||'')).join('\n\n'));
 signal?.throwIfAborted();await mkdir(path.dirname(target),{recursive:true});const temporary=target+'.capri-'+randomUUID()+'.tmp';try{await writeFile(temporary,data,{signal});signal?.throwIfAborted();await rename(temporary,target);}catch(error){await unlink(temporary).catch(()=>{});throw error;}const actual=await readFile(target),saved=await lstat(target);const passed=actual.equals(data)&&saved.size>0&&(format!=='svg'||saved.isFile()&&saved.nlink===1&&isGeneratedChartSvg(actual.toString('utf8')));
 return {path:target,format,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),preview:preview||[title,...sections.map((s:any)=>s.heading||'')].join('\n'),verification:[{method:format==='svg'?'Read-back SHA-256 and self-contained chart SVG check':'Read-back SHA-256 and format generation',passed}]};
}
