import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {IdSchema,Sha256Schema} from './contracts';
import {canonicalJson,sha256} from './policy';
import {isGeneratedChartSvg} from '../server/charts';

/** Fixed host code, never a manifest-supplied evaluator. Readiness is not success. */
export const availableSkillVerifiers=Object.freeze(['artifact-readback','plan-record','image-attachment',
  'source-citations','command-exit-status','file-backup','file-sha256','defender-evidence']);
export const unavailableSkillVerifiers:Readonly<Record<string,string>>=Object.freeze({
  'desktop-reinspect':'Fresh window observations exist, but no supported validator establishes the requested application effect.',
  'browser-reinspect':'Fresh page observations exist, but no supported validator establishes arbitrary submissions, closes or downloads.',
  'game-workshop-evidence':'The game producer lacks task-correlated build output and isolated test provenance.',
});
export const SkillExecutionBindingSchema=z.object({taskId:IdSchema,runId:IdSchema,sessionEpoch:IdSchema,
  skillId:IdSchema,version:IdSchema,manifestSha256:Sha256Schema,requiredChecks:z.array(IdSchema).min(1).max(16),
  unavailableChecks:z.array(IdSchema).min(1).max(16).optional()}).strict();
export type SkillExecutionBinding=z.infer<typeof SkillExecutionBindingSchema>;
const ReceiptSchema=z.object({id:IdSchema,callId:IdSchema,producer:IdSchema,binding:SkillExecutionBindingSchema,
  check:IdSchema,proof:z.record(z.string(),z.unknown())}).strict();
export type SkillExecutionReceipt=z.infer<typeof ReceiptSchema>;
export interface SkillExecutionJournal {bindings:SkillExecutionBinding[];receipts:SkillExecutionReceipt[]}
const FileWriteBindingSchema=z.object({taskId:IdSchema,runId:IdSchema,sessionEpoch:IdSchema}).strict();
export type FileWriteBinding=z.infer<typeof FileWriteBindingSchema>;
const FileWriteReceiptSchema=z.object({id:IdSchema,callId:IdSchema,binding:FileWriteBindingSchema,
  path:z.string().min(1),sha256:Sha256Schema,bytes:z.number().int().nonnegative(),
  effect:z.object({operation:z.enum(['move','remove','modify']),previousId:IdSchema,fromPath:z.string().min(1)}).strict().optional()}).strict();
export type FileWriteReceipt=z.infer<typeof FileWriteReceiptSchema>;
export const fileWriteEvidenceKind='extension:skills:file-write';
const privateFileWrites=new WeakMap<object,Map<string,FileWriteReceipt>>();
type Dispatch={taskId:string;callId:string;producer:string;bindings:SkillExecutionBinding[];signal:AbortSignal;
  observe:(receipt:SkillExecutionReceipt)=>void;select?:(ids:readonly string[])=>Promise<void>;guard?:()=>Promise<void>;
  fileWrite?:{binding:FileWriteBinding;receipts?:readonly FileWriteReceipt[];observe:(receipt:FileWriteReceipt)=>void}};
const dispatch=new AsyncLocalStorage<Dispatch>();
const issued=new WeakSet<object>();
const privateReceipts=new WeakMap<object,Map<string,SkillExecutionReceipt>>();
export const skillEvidenceKind='extension:skills:evidence';
/** Called only around actual trusted dispatch, never around a cached result. */
export function withSkillDispatch<T>(scope:Dispatch,work:()=>Promise<T>):Promise<T>{return dispatch.run(scope,work);}
/** Producer-only hook. Arguments/results cannot select a task, check or binding. */
export function observeSkillProof(producer:string,check:string,proof:Record<string,unknown>){
  const scope=dispatch.getStore();if(!scope||scope.producer!==producer||scope.signal.aborted)return;
  for(const binding of scope.bindings)if(binding.taskId===scope.taskId&&binding.requiredChecks.includes(check))
    {const receipt=ReceiptSchema.parse({id:randomUUID(),callId:scope.callId,producer,binding,check,proof});issued.add(receipt);scope.observe(receipt);}
}
/** Direct text writes keep a read-back witness without becoming coding skills
 * or claiming reviewed task verification. Only the real host producer calls it. */
export function observeFileWrite(file:{path:string;sha256:string;bytes:number}){
  const scope=dispatch.getStore();if(!scope?.fileWrite||scope.producer!=='write_file'||scope.signal.aborted||scope.taskId!==scope.fileWrite.binding.taskId)return;
  const receipt=FileWriteReceiptSchema.parse({id:randomUUID(),callId:scope.callId,binding:scope.fileWrite.binding,...file});
  issued.add(receipt);scope.fileWrite.observe(receipt);
}
/** Only a fixed host operation with before/after observations may extend a write.
 * The original effect identity and bytes remain in the journal. */
export function observeFileWriteEffect(previous:FileWriteReceipt,operation:'move'|'remove'|'modify',file:{path:string;sha256:string;bytes:number}){
  const scope=dispatch.getStore();if(!scope?.fileWrite||scope.producer!=='run_command'||scope.signal.aborted||
    scope.taskId!==previous.binding.taskId||canonicalJson(scope.fileWrite.binding)!==canonicalJson(previous.binding))return;
  const receipt=FileWriteReceiptSchema.parse({id:randomUUID(),callId:scope.callId,binding:scope.fileWrite.binding,path:file.path,sha256:file.sha256,bytes:file.bytes,
    effect:{operation,previousId:previous.id,fromPath:previous.path}});
  issued.add(receipt);scope.fileWrite.observe(receipt);
}
/** Deliberately bounded syntax, not arbitrary shell/hash output interpretation. */
export function skillFileFollowup(command:string){
  let match=/^Move-Item\s+-LiteralPath\s+'([^'\r\n]+)'\s+-Destination\s+'([^'\r\n]+)'\s*$/i.exec(command);
  if(match)return {operation:'move' as const,source:match[1],destination:match[2]};
  match=/^Remove-Item\s+-LiteralPath\s+'([^'\r\n]+)'\s*$/i.exec(command);
  if(match)return {operation:'remove' as const,source:match[1]};
  match=/^Set-Content\s+-LiteralPath\s+'([^'\r\n]+)'\s+-Value\s+'([^'\r\n]*)'\s+-NoNewline\s+-Encoding\s+utf8\s*$/i.exec(command);
  if(match)return {operation:'modify' as const,source:match[1],content:match[2]};
}
export async function retainFileWrite(store:{put:(kind:string,row:any)=>Promise<any>},receipt:FileWriteReceipt,privateSession:boolean){
  if(!issued.has(receipt))throw Error('Untrusted file write receipt.');
  if(privateSession){let records=privateFileWrites.get(store);if(!records){records=new Map();privateFileWrites.set(store,records);}records.set(receipt.id,structuredClone(receipt));}
  else await store.put(fileWriteEvidenceKind,{id:receipt.id,receipt});
}
export async function verifyFileWrites(receipts:FileWriteReceipt[],binding:FileWriteBinding,store:StoreReader,signal:AbortSignal,previousBindings:FileWriteBinding[]=[]){
  const bindings=[binding,...previousBindings];
  if(!receipts.length||bindings.some(value=>!FileWriteBindingSchema.safeParse(value).success||value.taskId!==binding.taskId))return false;
  const parsedReceipts=receipts.map(raw=>FileWriteReceiptSchema.safeParse(raw));if(parsedReceipts.some(parsed=>!parsed.success))return false;
  const values=parsedReceipts.flatMap(parsed=>parsed.success?[parsed.data]:[]),seen=new Set<string>(),current=new Map<string,FileWriteReceipt>();
  for(const receipt of values){
    signal.throwIfAborted();
    if(seen.has(receipt.id)||!bindings.some(value=>canonicalJson(receipt.binding)===canonicalJson(value)))return false;seen.add(receipt.id);
    const original=privateFileWrites.get(store)?.get(receipt.id)??(await store.get(fileWriteEvidenceKind,receipt.id))?.receipt;
    if(!original||canonicalJson(original)!==canonicalJson(receipt))return false;
    if(receipt.effect){const {operation,previousId,fromPath}=receipt.effect,previous=current.get(fromPath);
      if(!previous||previous.id!==previousId||previous.effect?.operation==='remove'||canonicalJson(previous.binding)!==canonicalJson(receipt.binding)||
        (operation==='modify'?receipt.path!==fromPath:receipt.sha256!==previous.sha256||receipt.bytes!==previous.bytes)||
        (operation==='move'?receipt.path===fromPath||current.has(receipt.path):receipt.path!==fromPath))return false;
      current.delete(fromPath);
    }
    current.set(receipt.path,receipt);
  }
  for(const receipt of current.values())try{
    if(receipt.effect?.operation==='remove'){
      if(await readSkillFileAbsence(store,receipt.path,binding.taskId,signal)!==receipt.path)return false;
    }else{const file=await readSkillFile(store,receipt.path,binding.taskId,signal);
      if(file.path!==receipt.path||file.sha256!==receipt.sha256||file.bytes!==receipt.bytes)return false;}
  }catch{return false;}
  signal.throwIfAborted();return true;
}
/** Persist only receipts issued by the in-process producer hook. Private proof never enters Store. */
export async function retainSkillReceipt(store:{put:(kind:string,row:any)=>Promise<any>},receipt:SkillExecutionReceipt,privateSession:boolean){
  if(!issued.has(receipt))throw Error('Untrusted skill receipt.');
  if(privateSession){let records=privateReceipts.get(store);if(!records){records=new Map();privateReceipts.set(store,records);}records.set(receipt.id,structuredClone(receipt));}
  else await store.put(skillEvidenceKind,{id:receipt.id,receipt});
}
export function discardPrivateSkillEvidence(store:object,taskId?:string){
  if(!taskId){privateReceipts.delete(store);privateFileWrites.delete(store);return;}
  const records=privateReceipts.get(store);if(records)for(const [id,receipt] of records)if(receipt.binding.taskId===taskId)records.delete(id);
  const files=privateFileWrites.get(store);if(files)for(const [id,receipt] of files)if(receipt.binding.taskId===taskId)files.delete(id);
}
export function currentSkillDispatch(){return dispatch.getStore();}
export async function assertSkillDispatch(){const scope=dispatch.getStore();await scope?.guard?.();scope?.signal.throwIfAborted();}
export async function bindSelectedSkillChecks(ids:readonly string[]){await dispatch.getStore()?.select?.(ids);}
type FileReader=(target:string,taskId:string,signal:AbortSignal)=>Promise<{path:string;sha256:string;bytes:number}>;
const readers=new WeakMap<object,FileReader>();
const absenceReaders=new WeakMap<object,(target:string,taskId:string,signal:AbortSignal)=>Promise<string>>();
export function registerSkillFileReader(store:object,reader:FileReader){readers.set(store,reader);}
export function registerSkillFileAbsenceReader(store:object,reader:(target:string,taskId:string,signal:AbortSignal)=>Promise<string>){absenceReaders.set(store,reader);}
export async function readSkillFileAbsence(store:object,target:string,taskId:string,signal:AbortSignal){
  const reader=absenceReaders.get(store);if(!reader)throw Error('A grant-scoped absence witness is unavailable.');return reader(target,taskId,signal);
}
export async function readSkillFile(store:object,target:string,taskId:string,signal:AbortSignal){
  const reader=readers.get(store);if(!reader)throw Error('A grant-scoped file witness is unavailable.');return reader(target,taskId,signal);
}
/** Only a literal single-file copy has a fixed source/destination witness. No shell output is parsed. */
export function skillCopyTargets(command:string):{source:string;destination:string}|undefined{
  const match=/^Copy-Item\s+-LiteralPath\s+'([^'\r\n]+)'\s+-Destination\s+'([^'\r\n]+)'\s*$/i.exec(command);
  return match?{source:match[1],destination:match[2]}:undefined;
}
export function skillHashTarget(command:string):string|undefined{
  return /^Get-FileHash\s+-LiteralPath\s+'([^'\r\n]+)'\s+-Algorithm\s+SHA256\s*$/i.exec(command)?.[1];
}
export const skillCommandToolchains=Object.freeze(['javascript','dotnet','python','cargo','go']);
/** Fixed command forms, not an executable evaluator or permission to run them.
 * Help, collection-only, arbitrary modules/scripts and shell composition do not
 * establish a project build/test. The normal host approval still applies. */
export function skillCommandCheck(command:unknown):{toolchain:string;operation:string}|undefined{
  if(typeof command!=='string'||command.length>8000||/[;&|<>`\r\n$]/.test(command))return;
  const tokens=command.trim().split(/\s+/),head=tokens.shift()?.toLowerCase();let toolchain:string|undefined,operation:string|undefined;
  if(head==='npm'||head==='pnpm'){
    toolchain='javascript';if(tokens[0]==='run')tokens.shift();const action=tokens.shift();
    if(['test','check','build'].includes(action!))operation=action;
    if(!tokens.every(t=>['--','--run','--watch=false','--runInBand','--noEmit'].includes(t)))return;
  }else if(head==='dotnet'||head==='cargo'||head==='go'){
    toolchain=head;const action=tokens.shift();
    if((head==='dotnet'?['build','test']:head==='cargo'?['build','test','check']:['build','test','vet']).includes(action!))operation=action==='vet'?'check':action;
    const flags=head==='dotnet'?['--no-restore','--no-build','--nologo']:head==='cargo'?['--release','--workspace','--all-targets','--all-features','--locked','--offline']:['-v','-race','-count=1'];
    if(!tokens.every(t=>flags.includes(t)||!t.startsWith('-')&&/^[a-zA-Z0-9_./\\:-]+$/.test(t)))return;
  }else if(['python','python3','py','pytest'].includes(head!)){
    toolchain='python';let action:string|undefined;
    if(head==='pytest')action='pytest';
    else {if(head==='py'&&tokens[0]==='-3')tokens.shift();if(tokens.shift()!=='-m')return;action=tokens.shift();}
    if(['pytest','unittest','build'].includes(action!))operation=action==='build'?'build':'test';
    const flags=action==='pytest'?['-q','-v','-x','--disable-warnings']:action==='unittest'?['discover','-v','-q','-s','-p','-t']:['--wheel','--sdist','--no-isolation'];
    if(!tokens.every(t=>flags.includes(t)||!t.startsWith('-')&&/^[a-zA-Z0-9_./\\:*?-]+$/.test(t)))return;
  }
  return toolchain&&operation?{toolchain,operation}:undefined;
}
/** Request text can only narrow readiness; it cannot add handlers or grants. */
export function requestedSkillToolchains(text:string):string[]{
  const names:Record<string,RegExp>={javascript:/\b(?:javascript|typescript|node|npm|pnpm)\b/i,dotnet:/\b(?:dotnet|csharp|c#|\.net)\b/i,
    python:/\b(?:python|pytest|unittest)\b/i,cargo:/\b(?:cargo|rust)\b/i,go:/\b(?:golang|go (?:project|module|build|test|code|language|repository|repo))\b/i,
    ruby:/\b(?:ruby|rails|rake|rspec)\b/i,java:/\b(?:java|maven|gradle)\b/i,cpp:/\b(?:cmake|msbuild)\b|\bc\+\+(?=\W|$)/i,
    swift:/\b(?:swift|xcode)\b/i,php:/\b(?:php|composer|phpunit)\b/i,kotlin:/\b(?:kotlin|scala|sbt)\b/i,
    fortran:/\bfortran\b/i,haskell:/\b(?:haskell|cabal)\b/i,elixir:/\b(?:elixir|erlang|rebar)\b/i,lua:/\blua\b/i,zig:/\bzig\b/i,julia:/\bjulia\b/i};
  return Object.keys(names).filter(name=>names[name].test(text));
}
export function commandVerifierReason(toolchains:readonly string[]):string|undefined{
  const unsupported=toolchains.filter(name=>!skillCommandToolchains.includes(name));
  return unsupported.length?'Project command verification is unavailable for '+unsupported.join(', ')+'. Supported fixed handlers: '+skillCommandToolchains.join(', ')+'.':undefined;
}
const chartContainers='pdf|docx?|word|xlsx|excel|spreadsheet|pptx|powerpoint|slide\\s+deck|slides?|deck|presentation|csv|markdown|md|html|web\\s*page|document|report|memo|png|jpe?g';
const chartContainer=new RegExp('\\b(?:as|in|into|inside|within|to|embedded\\s+in)\\s+(?:(?:an?|the|my|our|your|this|that|one|single|new)\\s+)*('+chartContainers+')\\b|'+
  '\\b(?:as|into|to)\\s+[\\w-]+\\.(pdf|docx|xlsx|pptx|csv|md|html|png|jpe?g)\\b|\\b('+chartContainers+')\\b[\\w\\s]{0,30}?\\b(?:with|containing|including|that\\s+(?:has|includes|contains))\\b','i');
/** Input-source wording ("using data in the spreadsheet", "from report.docx") names
 * where numbers come from, not the requested output format. */
const chartSource=new RegExp('\\b(?:using|use|from|based\\s+on|with|according\\s+to|(?:drawn|taken|pulled|sourced|read|loaded|imported)\\s+from|'+
  '(?:data|numbers|values|figures|rows|columns|entries|results|totals|records)\\s+(?:in|from|inside|within))\\s+'+
  '(?:(?:the|my|our|your|this|that|these|an?|attached|existing|current|provided|uploaded|shared|following|data|numbers|values|figures|rows|columns|in|from|inside|within|sheet|tab|contents?)\\s+)*'+
  '(?:[\\w-]+\\.(?:pdf|docx?|xlsx|pptx|csv|md|html)\\b|(?:'+chartContainers+')\\b)','gi');
/** Narrative "plot" (story/novel/land) is not a numeric chart. */
const narrativePlot=/\b(?:novels?|stor(?:y|ies)|storyline|books?|films?|movies?|screenplays?|narratives?|fiction|characters?|chapters?|episodes?|scenes?|tales?|twists?|holes?|land|garden|grave|murder|scheme|conspiracy)\b/i;
/** Classifies an explicit request for a drawn chart. Chart data or "no chart"
 * wording stays an ordinary document/data export. Naming a document container
 * does NOT cancel the drawn-chart obligation: Capri renders charts only as
 * standalone SVG, so `container` reports an embedded/export format that no
 * saved artifact can prove. */
export function renderedChartRequest(text:string):{rendered:boolean;container?:string}{
  // File names such as sales.pptx keep their extension inside the clause.
  const clauses=text.slice(0,4000).split(/[.!?;]+(?=\s|$)|\n+|\band (?:then )?|,\s*then\b/i).map(clause=>clause.trim()
    .replace(/^(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?/i,'').replace(/^i (?:(?:want|need)|would like)(?: you)? to\s+/i,''));
  const noun=/\b(?:charts?|graphs?|svg|(?:line|bar|pie|scatter)\s+plots?)\b/i,
    action=/^(?:create|make|draw|render|generate|produce|prepare|build|design|add|include|insert|embed|save|export|give me)\b/i,
    // Only wording that names chart DATA as the object, or negates the chart itself,
    // is removed before matching. Source-data references ("using the chart data
    // below") and resource limits ("no images from the internet") keep the obligation.
    chartData=/\b(?:charts?|graphs?|plots?)\s+data\b|\bdata\s+for\s+(?:(?:an?|the|my|your|our)\s+)?(?:\w+\s+)?(?:charts?|graphs?|plots?)\b/gi,
    noChart=/\b(?:no|without(?:\s+(?:an?|any))?|not\s+(?:an?|the|any))\s+(?:(?:rendered|drawn|actual)\s+)?(?:(?:line|bar|pie|scatter)\s+)?(?:charts?|graphs?|plots?|svgs?)\b/gi,
    // A separate clause about the data/table is its own export, not the chart's container.
    dataClause=/\b(?:data|table|raw|numbers|values|figures)\b/i,
    // An export directive in another clause applies to the chart when its object is the
    // chart, a pronoun, or omitted entirely ("and export as a PDF", "and save as report.pdf").
    // A named non-chart object ("export the data as CSV") stays its own export.
    reference=/^(?:save|export|put|convert|turn|deliver|output|place|embed|insert|add|include|attach|download|print|publish|send|share|write)\s+(?:(?:it|them|this|that|both|everything|all|the\s+(?:chart|graph|plot|figure|visual(?:ization)?)s?)\b|(?=(?:as|to|into|in|inside|within)\b))/i,
    makeInto=new RegExp('^(?:make|turn|convert)\\s+(?:it|them|this|that|the\\s+(?:chart|graph|plot)s?)\\s+(?:into\\s+)?(?:(?:an?|the)\\s+)?('+chartContainers+')\\b','i'),
    embedding=/^(?:add|include|insert|embed|attach|put)\b/i,
    // "...draw a bar chart in it" places the chart inside a document named elsewhere.
    anaphor=/\b(?:in|into|inside|within|to|on)\s+(?:it|them|this|that|there)\b/i;
  const charts=clauses.filter(clause=>{
    // A leading imperative "Plot data for Q1" is an action, not a chart-data noun.
    const kept=clause.replace(chartData,(match,offset:number)=>offset?' ':match).replace(noChart,' ');
    // An ordinary "plot of monthly sales" is a chart; a novel's plot is writing.
    const numericPlot=/\bplots?\b/i.test(kept)&&!narrativePlot.test(kept);
    return /^(?:chart|graph|visuali[sz]e)\b/i.test(kept)||/^plot\b/i.test(kept)&&numericPlot||action.test(kept)&&(noun.test(kept)||numericPlot);
  });
  if(!charts.length)return {rendered:false};
  const format=(match:RegExpMatchArray|null)=>match?(match[1]??match[2]??match[3]).toLowerCase().replace(/\s+/g,' '):undefined;
  const output=(clause:string,pattern:RegExp)=>format(clause.replace(chartSource,' ').match(pattern));
  let container:string|undefined;
  for(const clause of charts)container??=output(clause,chartContainer);
  for(const clause of clauses)if(!charts.includes(clause)){
    if(reference.test(clause))container??=output(clause,chartContainer);
    container??=output(clause,makeInto);
  }
  // "Create a PDF report and include a bar chart" / "...and draw a bar chart in it"
  // embeds the chart in that document.
  if(charts.some(clause=>embedding.test(clause)||anaphor.test(clause.replace(chartSource,' '))))for(const clause of clauses)
    if(!charts.includes(clause)&&!dataClause.test(clause))container??=output(clause,new RegExp('\\b('+chartContainers+')\\b','i'));
  return container?{rendered:true,container}:{rendered:true};
}
export function renderedChartRequested(text:string):boolean{return renderedChartRequest(text).rendered;}
type StoreReader={get:(kind:string,id:string)=>Promise<any>};
export async function verifySkillExecution(journal:SkillExecutionJournal,options:{store:StoreReader;signal:AbortSignal;
  assertBinding:(binding:SkillExecutionBinding)=>Promise<void>;answer:string;citations:readonly {url:string}[];request?:string}):Promise<{verified:boolean;missing:string[];unavailable:string[]}>{
  const missing:string[]=[],unavailable:string[]=[],seen=new Set<string>(),chartRequest=renderedChartRequest(options.request??'');
  for(const raw of journal.bindings){
    const binding=SkillExecutionBindingSchema.parse(raw);await options.assertBinding(binding);options.signal.throwIfAborted();
    unavailable.push(...(binding.unavailableChecks??[]).map(check=>binding.skillId+':'+check));
    for(const check of binding.requiredChecks){
      const receipts=journal.receipts.flatMap(raw=>{const parsed=ReceiptSchema.safeParse(raw);return parsed.success&&parsed.data.check===check&&canonicalJson(parsed.data.binding)===canonicalJson(binding)?[parsed.data]:[];});
      let valid=receipts.length>0,renderedChart=false;const sourceUrls=new Set<string>(),commands=new Map<string,Record<string,unknown>>();
      const lastRecord=new Map<unknown,string>();
      if(['artifact-readback','plan-record','file-backup'].includes(check))for(const receipt of receipts)
        lastRecord.set(check==='plan-record'?receipt.proof.rowId:receipt.proof.path,receipt.id);
      for(const receipt of receipts){
        // A duplicated identity is evidence corruption, not a second observation.
        if(seen.has(receipt.id)){valid=false;break;}seen.add(receipt.id);
        const original=privateReceipts.get(options.store)?.get(receipt.id)??(await options.store.get(skillEvidenceKind,receipt.id))?.receipt;
        if(!original||canonicalJson(original)!==canonicalJson(receipt)){valid=false;break;}
        const p=receipt.proof;let passed=false;
        try{
          if(check==='artifact-readback'&&receipt.producer==='create_artifact'){
            const row=await options.store.get('artifact',String(p.rowId));
            passed=!!row&&row.taskId===binding.taskId&&row.path===p.path&&row.sha256===p.sha256&&row.bytes===p.bytes&&
              Number(p.bytes)>0;
            if(lastRecord.get(p.path)===receipt.id){const file=await readSkillFile(options.store,String(p.path),binding.taskId,options.signal);
              passed=passed&&file.path===p.path&&file.sha256===p.sha256&&file.bytes===p.bytes;
              // Only the current saved bytes of a generated chart prove a rendered chart.
              if(passed&&row.format==='svg'&&/\.svg$/i.test(String(p.path))&&isGeneratedChartSvg(row.preview)&&
                sha256(row.preview)===p.sha256&&Buffer.byteLength(row.preview,'utf8')===p.bytes)renderedChart=true;}
          }else if(check==='plan-record'&&['add_plan','update_plan'].includes(receipt.producer)){
            const row=await options.store.get('plan',String(p.rowId));passed=!!row&&
              (lastRecord.get(p.rowId)!==receipt.id||sha256(canonicalJson(row))===p.recordSha256);
          }else if(check==='image-attachment'&&receipt.producer==='generate_image'){
            const row=await options.store.get('attachment',String(p.rowId));
            passed=!!row&&row.mime==='image/png'&&typeof row.base64==='string'&&sha256(row.base64)===p.contentSha256&&
              Buffer.from(row.base64,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
          }else if(check==='source-citations'&&['web_search_local','browser_read'].includes(receipt.producer)){
            const urls=Array.isArray(p.urls)?p.urls.filter((url):url is string=>typeof url==='string'&&/^https?:\/\//.test(url)):[];
            urls.forEach(url=>sourceUrls.add(url));passed=urls.length>0;
          }else if(check==='command-exit-status'&&receipt.producer==='run_command'){
            // Keep reproduction failures. Only the last receipt for the SAME command/target/cwd
            // can supersede them; a successful unrelated command cannot repair a failing build.
            passed=Number.isInteger(p.code)&&typeof p.cwd==='string'&&!!p.cwd.trim()&&typeof p.target==='string'&&!!p.target.trim()&&typeof p.command==='string';
            const command=skillCommandCheck(p.command),copy=typeof p.command==='string'&&skillCopyTargets(p.command);
            const toolchains=requestedSkillToolchains(options.request??'');
            const relevant=binding.skillId==='file-backups'?!!copy:!!command&&(!toolchains.length||toolchains.includes(command.toolchain));
            if(passed&&relevant)commands.set(canonicalJson([p.command,p.cwd,p.target]),p);
          }else if(check==='file-sha256'&&receipt.producer==='run_command'){
            if(binding.skillId==='download-inspection'&&typeof p.target==='string'){
              const target=await readSkillFile(options.store,p.target,binding.taskId,options.signal);
              passed=target.path===p.target&&target.sha256===p.sha256&&target.bytes===p.bytes;
            }else{
              const source=await readSkillFile(options.store,String(p.source),binding.taskId,options.signal);
              const destination=await readSkillFile(options.store,String(p.destination),binding.taskId,options.signal);
              passed=source.path!==destination.path&&source.path===p.source&&destination.path===p.destination&&
                source.sha256===p.sha256&&destination.sha256===p.sha256&&source.bytes===p.bytes&&destination.bytes===p.bytes;
            }
          }else if(check==='file-backup'&&receipt.producer==='write_file'){
            const row=await options.store.get('backup',String(p.backupId));
            passed=!!row&&row.path===p.path&&row.afterHash===p.sha256&&
              (typeof row.before==='string'?(p.priorSha256===undefined||sha256(row.before)===p.priorSha256):
                row.before===null&&p.priorState==='absent'&&p.priorSha256===undefined);
            if(lastRecord.get(p.path)===receipt.id){const file=await readSkillFile(options.store,String(p.path),binding.taskId,options.signal);passed=passed&&file.sha256===p.sha256;}
          }else if(check==='defender-evidence'&&receipt.producer==='security_job'){
            const row=await options.store.get('extension:security:request',String(p.requestId));const job=row?.record?.job;
            const evidence=job?.evidence?.at(-1);
            passed=!!job&&job.id===p.jobId&&job.requestId===p.requestId&&job.taskId===binding.taskId&&job.operation===p.operation&&
              row.record.intentSha256===p.intentSha256&&job.state==='completed'&&['no-detection','remediated'].includes(evidence?.outcome)&&
              evidence?.source==='windows-defender'&&evidence?.jobId===job.id;
            if(binding.skillId==='download-inspection'){
              const inspected=journal.receipts.filter(r=>r.check==='file-sha256'&&canonicalJson(r.binding)===canonicalJson(binding)&&typeof r.proof.target==='string');
              passed=passed&&p.operation==='custom-scan'&&inspected.some(r=>p.intentSha256===sha256(JSON.stringify([binding.taskId,'custom-scan',String(r.proof.target).toLowerCase(),null])));
            }
          }
        }catch{/* Missing grants, changed records or unreadable bytes remain incomplete. */}
        if(!passed){valid=false;break;}
      }
      if(check==='artifact-readback'&&chartRequest.rendered){
        valid=valid&&renderedChart;
        // A standalone SVG cannot prove a chart embedded in or exported as another format.
        if(valid&&chartRequest.container)unavailable.push(binding.skillId+':rendered-chart-'+chartRequest.container.replace(/\s+/g,'-'));
      }
      if(check==='source-citations'){
        const cited=[...options.citations.map(c=>c.url),...Array.from(options.answer.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g),match=>match[1])];
        valid=valid&&cited.length>0&&cited.every(url=>sourceUrls.has(url));
      }
      if(check==='command-exit-status'){
        valid=valid&&commands.size>0&&[...commands.values()].every(proof=>proof.code===0);
        if(binding.skillId!=='file-backups')for(const [pattern,operation] of [[/\b(?:build|compile)\b/i,'build'],[/\btests?\b/i,'test']] as const)
          if(pattern.test(options.request??''))valid=valid&&[...commands.values()].some(p=>skillCommandCheck(p.command)?.operation===operation);
      }
      if(!valid)missing.push(binding.skillId+':'+check);
    }
    await options.assertBinding(binding);options.signal.throwIfAborted();
  }
  return {verified:missing.length===0&&unavailable.length===0,missing,unavailable};
}
