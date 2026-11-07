import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canonicalJson,sha256} from '../src/extensions/policy';
import {withSkillDispatch,observeSkillProof,retainSkillReceipt,verifySkillExecution,registerSkillFileReader,
  discardPrivateSkillEvidence,type SkillExecutionBinding,type SkillExecutionJournal,type SkillExecutionReceipt} from '../src/extensions/skill-verification';
import {observeFileWrite,observeFileWriteEffect,retainFileWrite,verifyFileWrites,fileWriteEvidenceKind,skillFileFollowup,registerSkillFileAbsenceReader,type FileWriteReceipt} from '../src/extensions/skill-verification';
import {skillCopyTargets,skillCommandCheck,renderedChartRequested,renderedChartRequest} from '../src/extensions/skill-verification';
import {isGeneratedChartSvg,parseChart,renderChartSvg} from '../src/server/charts';

test('explicit rendered-chart requests are distinguished from chart data and ordinary documents',()=>{
  for(const text of ['Create a line chart of monthly sales','Could you make a bar graph of revenue?','Plot monthly sales','Chart our weekly visitors',
    'Write the summary and then draw a pie chart of the budget','Save it as an svg','I want you to generate a scatter plot of x and y'])
    assert.equal(renderedChartRequested(text),true,text);
  for(const text of ['Export the monthly sales data as CSV','Create the chart data for monthly sales as a CSV','Write a memo about the plot of the novel',
    'Create a report without a chart','Make a spreadsheet of chart data','Create a markdown table of sales','Summarize the chart I sent'])
    assert.equal(renderedChartRequested(text),false,text);
  // Naming a container keeps the drawn-chart obligation and reports the format no SVG can prove.
  for(const [text,container] of [['Create a bar chart as a PDF','pdf'],['Make a line graph of revenue in a Word document','word'],
    ['Create a PDF report with a bar chart of sales','pdf'],['Draw a pie chart and save it as a PDF','pdf'],['Create a slide deck and include a bar chart','slide deck'],
    ['Create a bar chart in report.docx','report'],['Generate a bar chart as sales.pptx','pptx'],['Make a bar chart as a spreadsheet','spreadsheet']] as const)
    assert.deepEqual(renderedChartRequest(text),{rendered:true,container},text);
  for(const text of ['Create a line chart of monthly sales','Create a line chart of monthly sales as sales.svg','Save it as an svg',
    'Create a line chart of monthly sales and save the data as CSV','Make a bar chart of the numbers from sales.csv'])
    assert.deepEqual(renderedChartRequest(text),{rendered:true},text);
  for(const text of ['Create the chart data for monthly sales as a CSV','Create a PDF report without a chart'])
    assert.deepEqual(renderedChartRequest(text),{rendered:false},text);
  // Source-data references and external-resource limits never cancel an explicit drawing request.
  for(const text of ['Create a bar chart using the chart data below','Create a bar chart with no images loaded from the internet',
    'Draw a line chart of monthly sales','Render a pie chart from the data for the chart in sales.csv','Make a bar chart without any external images',
    'Plot data for Q1','Draw a bar chart, not a table'])
    assert.equal(renderedChartRequested(text),true,text);
  for(const text of ['Make bar chart data only','Give me the data for the chart, not the chart itself','Create a spreadsheet with no graphs','Export a summary without any rendered charts'])
    assert.equal(renderedChartRequested(text),false,text);
  // An ordinary numeric plot noun is a chart; narrative plots remain writing.
  for(const text of ['Create a plot of monthly sales','Make a plot of temperature readings','Plot the quarterly revenue'])
    assert.equal(renderedChartRequested(text),true,text);
  for(const text of ['Create a plot for my novel','Make a plot twist for the story','Plot the storyline of my book','Generate a plot about a heist movie'])
    assert.equal(renderedChartRequested(text),false,text);
  // Source data named in a document is input, not the requested output container.
  for(const text of ['Create a line chart using data in the spreadsheet','Make a bar chart from the spreadsheet','Create a pie chart based on the PDF report',
    'Draw a line chart with the numbers from sales.xlsx','Chart the values in the document','Create a line chart of sales using data from report.docx'])
    assert.deepEqual(renderedChartRequest(text),{rendered:true},text);
  // Explicit embedded/export output remains a container even alongside a source reference.
  for(const [text,container] of [['Create a line chart in the spreadsheet using data from sales.csv','spreadsheet'],
    ['Create a spreadsheet with a line chart','spreadsheet'],['Create a bar chart using data in the spreadsheet and save it as a PDF','pdf'],
    ['Insert a chart into the document using the data in the spreadsheet','document']] as const)
    assert.deepEqual(renderedChartRequest(text),{rendered:true,container},text);
  // Output requirements in a later clause keep their omitted object or document reference.
  for(const [text,container] of [['Draw a line chart and export as a PDF','pdf'],['Create a line chart and save as report.pdf','report'],
    ['Create a PDF report and draw a bar chart in it','pdf'],['Create a PDF report, then draw a bar chart in it','pdf'],['Draw a bar chart and then save to sales.xlsx','xlsx'],
    ['Make a line chart of sales and turn it into a slide deck','slide deck'],['Draw a pie chart using data in the spreadsheet and export as a PDF','pdf']] as const)
    assert.deepEqual(renderedChartRequest(text),{rendered:true,container},text);
  // Separate data-only exports, svg outputs and source references are not chart containers.
  for(const text of ['Draw a line chart and export the data as CSV','Create a line chart and save as sales.svg','Draw a bar chart and save the table as a spreadsheet',
    'Create a line chart using data in the spreadsheet and save it as an svg','Draw a bar chart from report.pdf and export as sales.svg'])
    assert.deepEqual(renderedChartRequest(text),{rendered:true},text);
});

test('a generated svg verifies a chart sourced from a document; only real embedded-output requests stay unavailable',async()=>{
  const svg=renderChartSvg(parseChart({type:'line',title:'Sales',labels:['Jan','Feb','Mar'],series:[{name:'Units',values:[3,-1,4]}]}));
  const generated=isGeneratedChartSvg(svg);
  const f=fixture(),file={path:'canonical/sales.svg',sha256:sha256(svg),bytes:Buffer.byteLength(svg)};f.files.set(file.path,file);
  await f.store.put('artifact',{id:'artifact-1',taskId:'task-1',format:'svg',preview:svg,...file});await f.issue('create_artifact',{rowId:'artifact-1',...file});
  const verify=(request:string)=>verifySkillExecution(f.journal,{store:f.store,signal:f.controller.signal,answer:'Done.',citations:[],request,assertBinding:async()=>{}});
  assert.equal(generated,true,'fixture is the generated chart shape the verifier accepts');
  for(const request of ['Create a line chart using data in the spreadsheet','Create a line chart of monthly sales','Make a bar chart from report.docx','Visualize monthly sales','Create a plot of monthly sales'])
    assert.deepEqual(await verify(request),{verified:true,missing:[],unavailable:[]},request);
  assert.deepEqual(await verify('Create a line chart in the spreadsheet using data from sales.csv'),
    {verified:false,missing:[],unavailable:['skill-1:rendered-chart-spreadsheet']});
  // An unrelated csv/markdown file still cannot complete a sourced or embedded chart request.
  for(const [format,name] of [['csv','sales.csv'],['md','sales.md']] as const){
    const g=fixture(),other={path:'canonical/'+name,sha256:sha256('actual '+format),bytes:9};g.files.set(other.path,other);
    await g.store.put('artifact',{id:'artifact-1',taskId:'task-1',format,...other});await g.issue('create_artifact',{rowId:'artifact-1',...other});
    for(const request of ['Create a line chart using data in the spreadsheet','Create a line chart in the spreadsheet using data from sales.csv','Visualize monthly sales'])
      assert.equal((await verifySkillExecution(g.journal,{store:g.store,signal:g.controller.signal,answer:'Done.',citations:[],request,assertBinding:async()=>{}})).verified,false,format+': '+request);
  }
});

function fixture(check='artifact-readback'){
  const rows=new Map<string,any>(),files=new Map<string,{path:string;sha256:string;bytes:number}>();
  const store={async get(kind:string,id:string){return structuredClone(rows.get(kind+':'+id));},async put(kind:string,row:any){rows.set(kind+':'+row.id,structuredClone(row));return row;}};
  registerSkillFileReader(store,async target=>{const file=files.get(target);if(!file)throw Error('Unavailable');return file;});
  const binding:SkillExecutionBinding={taskId:'task-1',runId:'run-1',sessionEpoch:'epoch-1',skillId:'skill-1',version:'1',manifestSha256:'a'.repeat(64),requiredChecks:[check]};
  const journal:SkillExecutionJournal={bindings:[binding],receipts:[]},controller=new AbortController();let active=true;
  async function issue(producer:string,proof:Record<string,unknown>,privateSession=false,callId=randomUUID(),proofCheck=check){
    const issued:SkillExecutionReceipt[]=[];
    await withSkillDispatch({taskId:binding.taskId,callId,producer,bindings:[binding],signal:controller.signal,observe:r=>issued.push(r)},async()=>observeSkillProof(producer,proofCheck,proof));
    for(const receipt of issued){await retainSkillReceipt(store,receipt,privateSession);journal.receipts.push(receipt);}return issued[0];
  }
  const verify=(answer='Done.',citations:{url:string}[]=[])=>verifySkillExecution(journal,{store,signal:controller.signal,answer,citations,assertBinding:async b=>{assert.equal(active,true,'grant revoked');assert.deepEqual(b,binding);}});
  return {store,files,binding,journal,controller,issue,verify,revoke:()=>{active=false;}};
}
async function artifact(){
  const f=fixture(),file={path:'canonical/memo.md',sha256:sha256('actual bytes'),bytes:12};f.files.set(file.path,file);
  await f.store.put('artifact',{id:'artifact-1',taskId:'task-1',...file});
  await f.issue('create_artifact',{rowId:'artifact-1',...file});return f;
}

test('generic csv or markdown receipts cannot satisfy a chart requested inside a document container',async()=>{
  for(const [format,name] of [['csv','sales.csv'],['md','sales.md'],['pdf','sales.pdf']] as const){
    const f=fixture(),file={path:'canonical/'+name,sha256:sha256('actual '+format),bytes:9};f.files.set(file.path,file);
    await f.store.put('artifact',{id:'artifact-1',taskId:'task-1',format,...file});await f.issue('create_artifact',{rowId:'artifact-1',...file});
    const verify=(request:string)=>verifySkillExecution(f.journal,{store:f.store,signal:f.controller.signal,answer:'Done.',citations:[],request,assertBinding:async()=>{}});
    for(const request of ['Create a bar chart as a PDF','Create a PDF report with a bar chart of sales','Draw a pie chart and save it as a PDF','Create a bar chart',
      'Create a bar chart using the chart data below','Create a bar chart with no images loaded from the internet','Draw a line chart of monthly sales'])
      assert.deepEqual(await verify(request),{verified:false,missing:['skill-1:artifact-readback'],unavailable:[]},format+': '+request);
    // Explicit data-only and ordinary document requests keep their own read-back proof.
    for(const request of ['Create the chart data for monthly sales as a CSV','Export the monthly sales data as CSV','Create a PDF report without a chart'])
      assert.deepEqual(await verify(request),{verified:true,missing:[],unavailable:[]},format+': '+request);
  }
});

test('fixed artifact validator reads current bytes and Store record; passed flags are irrelevant',async()=>{
  const f=await artifact();assert.equal((await f.verify()).verified,true);
  f.files.get('canonical/memo.md')!.sha256=sha256('changed');assert.equal((await f.verify()).verified,false);
  const empty=fixture();empty.journal.receipts.push({id:'fake',callId:'call',producer:'create_artifact',binding:empty.binding,check:'artifact-readback',proof:{passed:true,sha256:'a'.repeat(64)}});
  assert.equal((await empty.verify()).verified,false);
  await assert.rejects(retainSkillReceipt(empty.store,empty.journal.receipts[0],false),/Untrusted/);
});

test('direct write follow-ups preserve original identities and require a bound chain plus fresh final file/absence observations',async()=>{
  for(const mode of ['valid','wrong-task','wrong-run','wrong-session','wrong-parent','forged-row','duplicate','changed','recreated','private-ended'] as const){
    const f=fixture(),binding={taskId:'task-1',runId:'run-1',sessionEpoch:'epoch-1'},receipts:FileWriteReceipt[]=[];
    const file={path:'canonical/scratch.txt',sha256:sha256('Original bytes.'),bytes:15},moved={...file,path:'canonical/final.txt'},modified={...moved,sha256:sha256('Final bytes.'),bytes:12};
    f.files.set(file.path,file);registerSkillFileAbsenceReader(f.store,async target=>{if(f.files.has(target))throw Error('File present.');return target;});
    const issue=async(producer:string,work:()=>void)=>{
      const issued:FileWriteReceipt[]=[];await withSkillDispatch({taskId:binding.taskId,callId:randomUUID(),producer,bindings:[],signal:f.controller.signal,observe:()=>assert.fail('No skill binding.'),
        fileWrite:{binding,receipts,observe:receipt=>issued.push(receipt)}},async()=>work());
      for(const receipt of issued){await retainFileWrite(f.store,receipt,mode==='private-ended');receipts.push(receipt);}
    };
    await issue('write_file',()=>observeFileWrite(file));const original=structuredClone(receipts[0]);
    await issue('run_command',()=>observeFileWriteEffect(receipts.at(-1)!,'move',moved));f.files.delete(file.path);f.files.set(moved.path,moved);
    await issue('run_command',()=>observeFileWriteEffect(receipts.at(-1)!,'modify',modified));f.files.set(modified.path,modified);
    if(mode==='wrong-task')receipts[1].binding={...binding,taskId:'other-task'};
    if(mode==='wrong-run')receipts[1].binding={...binding,runId:'other-run'};
    if(mode==='wrong-session')receipts[1].binding={...binding,sessionEpoch:'other-epoch'};
    if(mode==='wrong-parent')receipts[1].effect!.previousId='unrelated-effect';
    if(mode==='forged-row')await f.store.put(fileWriteEvidenceKind,{id:receipts[1].id,receipt:{...receipts[1],sha256:sha256('forged')}});
    if(mode==='duplicate')receipts.push(receipts[1]);
    if(mode==='changed')f.files.set(modified.path,{...modified,sha256:sha256('Unobserved change.')});
    if(mode==='private-ended')discardPrivateSkillEvidence(f.store,binding.taskId);
    const verify=()=>verifyFileWrites(receipts,binding,f.store,f.controller.signal);
    assert.equal(await verify(),['valid','recreated'].includes(mode),mode);assert.deepEqual(receipts[0],original);
    if(mode==='valid'||mode==='recreated'){
      // The original sequence is reusable for read-only reconciliation; it is
      // never reissued as a new write or rehashed into another effect identity.
      assert.equal(await verify(),true);const ids=receipts.map(receipt=>receipt.id);
      await issue('run_command',()=>observeFileWriteEffect(receipts.at(-1)!,'remove',modified));f.files.delete(modified.path);
      if(mode==='recreated')f.files.set(modified.path,modified);
      assert.equal(await verify(),mode==='valid');assert.deepEqual(receipts.slice(0,3).map(receipt=>receipt.id),ids);
    }
  }
});

test('file follow-up recognition accepts only the fixed literal operation, never shell composition or printed proof',()=>{
  assert.deepEqual(skillFileFollowup("Move-Item -LiteralPath 'scratch.txt' -Destination 'final.txt'"),{operation:'move',source:'scratch.txt',destination:'final.txt'});
  assert.deepEqual(skillFileFollowup("Remove-Item -LiteralPath 'scratch.txt'"),{operation:'remove',source:'scratch.txt'});
  assert.deepEqual(skillFileFollowup("Set-Content -LiteralPath 'scratch.txt' -Value 'Final bytes.' -NoNewline -Encoding utf8"),{operation:'modify',source:'scratch.txt',content:'Final bytes.'});
  for(const command of ["Remove-Item -LiteralPath 'scratch.txt'; echo passed",'echo SHA256 abc',"Move-Item scratch.txt final.txt","Remove-Item -LiteralPath 'scratch.txt' -Recurse","Set-Content -LiteralPath 'scratch.txt' -Value 'unbounded'"])
    assert.equal(skillFileFollowup(command),undefined,command);
});

test('wrong task/run/session/version/manifest/check/producer/call and malformed proof never borrow a valid receipt',async()=>{
  for(const field of ['taskId','runId','sessionEpoch','version','manifestSha256'] as const){
    const f=await artifact();f.journal.receipts[0].binding[field]=field==='manifestSha256'?'b'.repeat(64):'different';
    assert.equal((await f.verify()).verified,false,field);
  }
  for(const field of ['producer','callId','check','id'] as const){const f=await artifact();f.journal.receipts[0][field]='forged';assert.equal((await f.verify()).verified,false,field);}
  const f=await artifact();f.journal.receipts[0].proof={passed:true};assert.equal((await f.verify()).verified,false);
  const malformed=await artifact();malformed.journal.receipts[0]={passed:true} as any;assert.equal((await malformed.verify()).verified,false);
});

test('duplicate receipt fails; revocation and Stop abort validation; unchanged resume keeps original identity',async()=>{
  const f=await artifact(),id=f.journal.receipts[0].id;assert.equal((await f.verify()).verified,true);assert.equal((await f.verify()).verified,true);assert.equal(f.journal.receipts[0].id,id);
  f.journal.receipts.push(structuredClone(f.journal.receipts[0]));assert.equal((await f.verify()).verified,false);
  const revoked=await artifact();revoked.revoke();await assert.rejects(revoked.verify(),/grant revoked/);
  const stopped=await artifact();stopped.controller.abort();await assert.rejects(stopped.verify());
});

test('private evidence cannot survive a privacy boundary or be resurrected from its checkpoint',async()=>{
  const f=fixture('plan-record'),row={id:'plan-1',title:'Neutral reminder',dueAt:'',done:false};await f.store.put('plan',row);
  await f.issue('add_plan',{rowId:row.id,recordSha256:sha256(canonicalJson(row))},true);assert.equal((await f.verify()).verified,true);
  discardPrivateSkillEvidence(f.store);assert.equal((await f.verify()).verified,false);
});

test('saved add and update plans verify exact records, not a delivered request or unrelated row',async()=>{
  for(const producer of ['add_plan','update_plan']){
    const f=fixture('plan-record'),row={id:'plan-1',title:'Reminder',dueAt:'2027-01-01T09:00:00-06:00',done:false};await f.store.put('plan',row);
    await f.issue(producer,{rowId:row.id,recordSha256:sha256(canonicalJson(row))});assert.equal((await f.verify()).verified,true);
    await f.store.put('plan',{...row,done:true});assert.equal((await f.verify()).verified,false);
  }
});

test('citations must actually appear in the final answer and match this task observed sources',async()=>{
  const f=fixture('source-citations');await f.issue('web_search_local',{urls:['https://example.com/source']});
  assert.equal((await f.verify()).verified,false);
  assert.equal((await f.verify('See [the source](https://example.com/source).')).verified,true);
  assert.equal((await f.verify('Claim.',[{url:'https://example.com/source'}])).verified,true);
  assert.equal((await f.verify('Claim.',[{url:'https://example.com/unobserved'}])).verified,false);
});

test('command evidence needs the actual relevant build/test invocation, code, target and cwd; output cannot attest success',async()=>{
  for(const proof of [{command:'npm test',code:0,target:'selected project',cwd:'canonical/project'},
    {command:'Write-Output passed',code:0,target:'selected project',cwd:'canonical/project'},
    {command:'npm test; Write-Output passed',code:0,target:'selected project',cwd:'canonical/project'},
    {command:'npm test',code:1,target:'selected project',cwd:'canonical/project'},
    {command:'npm test',code:null,target:'selected project',cwd:'canonical/project'},
    {command:'npm test',code:0,target:'selected project'}]){
    const f=fixture('command-exit-status');await f.issue('run_command',{...proof,output:'all tests passed',passed:true});
    assert.equal((await f.verify()).verified,proof.command==='npm test'&&proof.code===0&&!!proof.cwd);
  }
});

test('Python, Cargo and Go have bounded project build/test forms; arbitrary exit-zero commands never substitute',async()=>{
  for(const command of ['python -m pytest -q','python3 -m unittest discover -s tests','py -3 -m pytest','pytest tests/test_sort.py',
    'python -m build --wheel','cargo test --workspace','cargo build --release','cargo check --all-targets','go test ./...','go build ./...','go vet ./...']){
    assert.ok(skillCommandCheck(command),command);
    const f=fixture('command-exit-status');await f.issue('run_command',{command,cwd:'canonical/project',target:'selected project',code:0});
    assert.equal((await f.verify()).verified,true,command);
    f.journal.receipts[0].proof.cwd='unrelated/project';assert.equal((await f.verify()).verified,false,'Forged cwd cannot change a receipt.');
  }
  for(const command of ['python -c print(1)','python script.py','python -m unrelated','pytest --collect-only','cargo --version','cargo clean',
    'cargo test --help','go version','go run main.go','go test -run nothing','go test ./...; echo passed','npm test --help']){
    assert.equal(skillCommandCheck(command),undefined,command);
    const f=fixture('command-exit-status');await f.issue('run_command',{command,cwd:'canonical/project',target:'selected project',code:0,passed:true});
    assert.equal((await f.verify()).verified,false,command);
  }
});

test('requested toolchain and build/test operations must match actual receipts, including nonzero outcomes',async()=>{
  const f=fixture('command-exit-status');f.binding.skillId='coding-workbench';
  const verify=(request:string)=>verifySkillExecution(f.journal,{store:f.store,signal:f.controller.signal,assertBinding:async()=>{},answer:'Done.',citations:[],request});
  await f.issue('run_command',{command:'cargo test',cwd:'canonical/project',target:'selected project',code:0});
  assert.equal((await verify('Fix the Python project and run tests')).verified,false);
  assert.equal((await verify('Fix the Rust project and run tests')).verified,true);
  assert.equal((await verify('Build the Rust project')).verified,false);
  assert.equal((await verify('Build and test the Rust project')).verified,false);
  await f.issue('run_command',{command:'cargo build',cwd:'canonical/project',target:'selected project',code:1});
  assert.equal((await verify('Build and test the Rust project')).verified,false);
  await f.issue('run_command',{command:'cargo build',cwd:'canonical/project',target:'selected project',code:0});
  assert.equal((await verify('Build and test the Rust project')).verified,true);
});

test('file backup means restorable prior bytes and matching current target hash, never a new-file marker',async()=>{
  for(const before of [null,'prior content']){
    const f=fixture('file-backup'),file={path:'canonical/code.ts',sha256:sha256('new content'),bytes:11};f.files.set(file.path,file);
    await f.store.put('backup',{id:'backup-1',before,path:file.path,afterHash:file.sha256});
    await f.issue('write_file',{backupId:'backup-1',...file});assert.equal((await f.verify()).verified,before!==null);
  }
});

test('a producer-observed absent preimage is distinct from an unauthenticated null backup marker',async()=>{
  for(const mode of ['absent','unknown','missing-row','forged-prior','changed-bytes'] as const){
    const f=fixture('file-backup'),file={path:'canonical/new.ts',sha256:sha256('new content'),bytes:11};f.files.set(file.path,file);
    if(mode!=='missing-row')await f.store.put('backup',{id:'backup-1',before:null,path:file.path,afterHash:file.sha256});
    await f.issue('write_file',{backupId:'backup-1',...file,...(mode==='unknown'?{}:{priorState:'absent'}),...(mode==='forged-prior'?{priorSha256:sha256('invented prior bytes')}:{})});
    if(mode==='changed-bytes')f.files.get(file.path)!.sha256=sha256('external change');
    assert.equal((await f.verify()).verified,mode==='absent',mode);
  }
});

test('available checks on a partially supported workflow never establish verified completion',async()=>{
  const f=fixture('file-backup'),file={path:'canonical/Example.java',sha256:sha256('class Example {}'),bytes:16};f.files.set(file.path,file);
  f.binding.unavailableChecks=['command-exit-status'];
  await f.store.put('backup',{id:'backup-1',before:null,path:file.path,afterHash:file.sha256});
  await f.issue('write_file',{backupId:'backup-1',...file,priorState:'absent'});
  const result=await f.verify();assert.equal(result.verified,false);assert.deepEqual(result.missing,[]);assert.deepEqual(result.unavailable,['skill-1:command-exit-status']);
  f.files.get(file.path)!.sha256=sha256('Wrong bytes.');const failed=await f.verify();
  assert.equal(failed.verified,false);assert.deepEqual(failed.missing,['skill-1:file-backup']);
});

test('direct file witnesses preserve actual readback without claiming a coding skill or trusting result flags',async()=>{
  for(const mode of ['valid','wrong-task','wrong-run','wrong-epoch','duplicate','forged-row','changed-bytes','unissued'] as const){
    const f=fixture(),binding={taskId:'task-1',runId:'run-1',sessionEpoch:'epoch-1'},receipts:FileWriteReceipt[]=[];
    const file={path:'canonical/list.txt',sha256:sha256('Milk.'),bytes:5};f.files.set(file.path,file);
    await withSkillDispatch({taskId:'task-1',callId:'write-1',producer:'write_file',bindings:[],signal:f.controller.signal,observe:()=>assert.fail('No skill binding.'),fileWrite:{binding,observe:receipt=>receipts.push(receipt)}},async()=>observeFileWrite(file));
    assert.equal(receipts.length,1);await retainFileWrite(f.store,receipts[0],false);
    if(mode==='wrong-task')receipts[0].binding.taskId='task-2';
    if(mode==='wrong-run')receipts[0].binding.runId='run-2';
    if(mode==='wrong-epoch')receipts[0].binding.sessionEpoch='epoch-2';
    if(mode==='duplicate')receipts.push(structuredClone(receipts[0]));
    if(mode==='forged-row')await f.store.put(fileWriteEvidenceKind,{id:receipts[0].id,receipt:{...receipts[0],callId:'forged'}});
    if(mode==='changed-bytes')f.files.get(file.path)!.sha256=sha256('Changed.');
    if(mode==='unissued')await assert.rejects(retainFileWrite(f.store,structuredClone(receipts[0]),false),/Untrusted/);
    assert.equal(await verifyFileWrites(receipts,{taskId:'task-1',runId:'run-1',sessionEpoch:'epoch-1'},f.store,f.controller.signal),mode==='valid'||mode==='unissued',mode);
  }
});

test('file copy proof reads BOTH current granted files; printed hashes and ambiguous copy commands do not count',async()=>{
  assert.deepEqual(skillCopyTargets("Copy-Item -LiteralPath 'one.txt' -Destination 'backup.txt'"),{source:'one.txt',destination:'backup.txt'});
  assert.equal(skillCopyTargets("Copy-Item one.txt backup.txt; Get-FileHash backup.txt"),undefined);
  const f=fixture('file-sha256'),sha=sha256('actual bytes');
  f.files.set('source',{path:'source',bytes:12,sha256:sha});f.files.set('copy',{path:'copy',bytes:12,sha256:sha});
  await f.issue('run_command',{source:'source',destination:'copy',sha256:sha,bytes:12});assert.equal((await f.verify()).verified,true);
  f.files.get('copy')!.sha256=sha256('wrong copy');assert.equal((await f.verify()).verified,false);
  const printed=fixture('file-sha256');await printed.issue('run_command',{output:'source and destination '+sha,passed:true});assert.equal((await printed.verify()).verified,false);
});

test('a recorded add followed by update verifies the latest same-task plan without replacing original receipts',async()=>{
  const f=fixture('plan-record'),row={id:'plan-1',title:'First title',dueAt:''};await f.store.put('plan',row);
  const first=await f.issue('add_plan',{rowId:row.id,recordSha256:sha256(canonicalJson(row))});
  const updated={...row,title:'Reviewed title'};await f.store.put('plan',updated);await f.issue('update_plan',{rowId:row.id,recordSha256:sha256(canonicalJson(updated))});
  assert.equal((await f.verify()).verified,true);assert.equal(f.journal.receipts[0].id,first.id);
});

test('image proof is a newly issued producer receipt plus exact saved attachment bytes',async()=>{
  const f=fixture('image-attachment'),base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7V8AAAAASUVORK5CYII=';
  await f.store.put('attachment',{id:'image-1',mime:'image/png',base64});await f.issue('generate_image',{rowId:'image-1',contentSha256:sha256(base64)});
  assert.equal((await f.verify()).verified,true);await f.store.put('attachment',{id:'image-1',mime:'image/png',base64:'forged'});assert.equal((await f.verify()).verified,false);
});

test('download inspection hashes and Defender custom scan must refer to the same canonical target',async()=>{
  for(const scanned of ['canonical/installer.exe','canonical/unrelated.exe']){
    const f=fixture('file-sha256');f.binding.skillId='download-inspection';f.binding.requiredChecks=['file-sha256','defender-evidence'];
    const target='canonical/installer.exe',file={path:target,bytes:12,sha256:sha256('actual bytes')};f.files.set(target,file);
    await f.issue('run_command',{target,...file});
    const intentSha256=sha256(JSON.stringify(['task-1','custom-scan',scanned.toLowerCase(),null]));
    await f.store.put('extension:security:request',{id:'request-1',record:{intentSha256,job:{id:'job-1',taskId:'task-1',requestId:'request-1',operation:'custom-scan',state:'completed',evidence:[{source:'windows-defender',jobId:'job-1',outcome:'no-detection'}]}}});
    await f.issue('security_job',{requestId:'request-1',jobId:'job-1',operation:'custom-scan',intentSha256},false,randomUUID(),'defender-evidence');
    assert.equal((await f.verify()).verified,scanned===target);
  }
});

test('Defender keeps detection/remediation/uncertainty distinctions and requires the correlated journal intent',async()=>{
  for(const outcome of ['no-detection','remediated','action-required','uncertain','unavailable']){
    const f=fixture('defender-evidence'),intentSha256=sha256('trusted operation and canonical target');
    await f.store.put('extension:security:request',{id:'request-1',record:{intentSha256,job:{id:'job-1',taskId:'task-1',requestId:'request-1',operation:'custom-scan',state:'completed',evidence:[{source:'windows-defender',jobId:'job-1',outcome}]}}});
    await f.issue('security_job',{requestId:'request-1',jobId:'job-1',operation:'custom-scan',intentSha256});
    assert.equal((await f.verify()).verified,['no-detection','remediated'].includes(outcome),outcome);
    f.journal.receipts[0].proof.intentSha256=sha256('different target');assert.equal((await f.verify()).verified,false);
  }
});
