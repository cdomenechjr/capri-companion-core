// Operator-owned local evaluation. No app profile, microphone or cloud provider is used.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const utterances = Object.freeze([
  {id:'capri-project',category:'name-command',text:'Capri, open my project folder and show the latest notes.'},
  {id:'names',category:'names',text:'My name is Jordan, and my friend is named Alex.'},
  {id:'reminder',category:'time',text:'Please remind me at nine fifteen tomorrow morning.'},
  {id:'timer',category:'numbers',text:'Set a timer for twelve minutes and thirty seconds.'},
  {id:'research',category:'research',text:'Compare these two documents and cite the differences.'},
  {id:'stop',category:'cancellation',text:'Stop the current task and keep my draft.'},
  {id:'natural-pause',category:'pause',parts:['Please make a backup of my project.', 'Then tell me where the backup was saved.'],gapSeconds:1.2},
  {id:'long-turn',category:'long',parts:[
    'Capri, help me organize my work for tomorrow. First, check the project notes and list the unfinished tasks. Next, prepare a short briefing with links to the original sources.',
    'Keep the research separate from my private conversation. Save the document in the project folder, show me a preview, and ask before sending anything to another person.'
  ],gapSeconds:0.7}
]);

export function words(text) {
  if(typeof text !== 'string') throw TypeError('Transcript must be text.');
  return text.normalize('NFKC').toLowerCase().replace(/[’']/gu,'').match(/[\p{L}\p{N}]+/gu) || [];
}

export function wordErrors(reference, hypothesis) {
  const a=words(reference), b=words(hypothesis);
  if(a.length>4096||b.length>4096)throw Error('Evaluation transcript exceeds 4096 words.');
  // Each cell retains the chosen edit counts; ties prefer substitution, then deletion.
  let previous=Array.from({length:b.length+1},(_,i)=>({errors:i,substitutions:0,deletions:0,insertions:i}));
  for(let i=1;i<=a.length;i++) {
    const current=[{errors:i,substitutions:0,deletions:i,insertions:0}];
    for(let j=1;j<=b.length;j++) {
      if(a[i-1]===b[j-1]) current.push({...previous[j-1]});
      else {
        const candidates=[
          {...previous[j-1],errors:previous[j-1].errors+1,substitutions:previous[j-1].substitutions+1},
          {...previous[j],errors:previous[j].errors+1,deletions:previous[j].deletions+1},
          {...current[j-1],errors:current[j-1].errors+1,insertions:current[j-1].insertions+1}
        ];
        current.push(candidates.reduce((best,row)=>row.errors<best.errors?row:best));
      }
    }
    previous=current;
  }
  return {...previous[b.length],referenceWords:a.length,hypothesisWords:b.length,wer:previous[b.length].errors/Math.max(1,a.length)};
}

export function encodeWav(samples, sampleRate) {
  if(!(samples instanceof Float32Array)||!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>48000||!samples.length||samples.length>sampleRate*120) throw Error('Use mono audio between zero and 120 seconds at 8–48 kHz.');
  if(samples.some(n=>!Number.isFinite(n))) throw Error('Audio contains a non-finite sample.');
  const out=Buffer.alloc(44+samples.length*2);
  out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(sampleRate,24);out.writeUInt32LE(sampleRate*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(samples.length*2,40);
  samples.forEach((n,i)=>out.writeInt16LE(Math.round(Math.max(-1,Math.min(1,n))*32767),44+i*2));
  return out;
}

export function decodeWav(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<44||bytes.length>120*48000*2+4096||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.readUInt32LE(4)+8!==bytes.length) throw Error('Invalid bounded RIFF/WAVE input.');
  let sampleRate=0,format=false,data;
  for(let offset=12;offset<bytes.length;) {
    if(offset+8>bytes.length) throw Error('Truncated WAVE chunk header.');
    const name=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8,end=start+size;
    if(end>bytes.length) throw Error('Truncated WAVE chunk.');
    if(name==='fmt ') {
      if(format||size<16||bytes.readUInt16LE(start)!==1||bytes.readUInt16LE(start+2)!==1||bytes.readUInt16LE(start+14)!==16||bytes.readUInt16LE(start+12)!==2) throw Error('Expected one mono PCM16 format.');
      sampleRate=bytes.readUInt32LE(start+4);
      if(sampleRate<8000||sampleRate>48000||bytes.readUInt32LE(start+8)!==sampleRate*2) throw Error('Invalid PCM sample rate.');
      format=true;
    }
    if(name==='data') {if(data)throw Error('Duplicate WAVE data.');data=bytes.subarray(start,end);}
    offset=end+(size%2);
    if(offset>bytes.length) throw Error('Missing WAVE chunk padding.');
  }
  if(!format||!data||!data.length||data.length%2||data.length>sampleRate*120*2)throw Error('Missing or oversized PCM16 samples.');
  const samples=new Float32Array(data.length/2);
  for(let i=0;i<samples.length;i++) samples[i]=data.readInt16LE(i*2)/32768;
  return {samples,sampleRate};
}

export function concatenate(parts, sampleRate, gapSeconds=0) {
  if(!Array.isArray(parts)||!parts.length||parts.some(p=>!(p instanceof Float32Array)||!p.length)||!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>48000||!Number.isFinite(gapSeconds)||gapSeconds<0||gapSeconds>5) throw Error('Invalid audio concatenation.');
  const gap=Math.round(sampleRate*gapSeconds),size=parts.reduce((n,p)=>n+p.length,0)+gap*(parts.length-1);
  if(size>sampleRate*120) throw Error('Combined audio exceeds 120 seconds.');
  const out=new Float32Array(size);let at=0;
  for(const p of parts) {if(p.some(n=>!Number.isFinite(n)))throw Error('Invalid sample.');out.set(p,at);at+=p.length+gap;}
  return out;
}

export function addNoise(samples,snrDb=15,seed=7) {
  if(!(samples instanceof Float32Array)||!samples.length||samples.some(n=>!Number.isFinite(n))||!Number.isFinite(snrDb)||snrDb<0||snrDb>60||!Number.isInteger(seed)||seed<1||seed>0xffffffff) throw Error('Invalid noise parameters.');
  let state=seed>>>0;const raw=new Float32Array(samples.length);
  for(let i=0;i<raw.length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;raw[i]=((state>>>0)/0x100000000)*2-1;}
  const rms=a=>Math.sqrt(a.reduce((sum,n)=>sum+n*n,0)/a.length);
  const target=rms(samples)/10**(snrDb/20),scale=target/Math.max(1e-12,rms(raw));
  return Float32Array.from(samples,(n,i)=>Math.max(-1,Math.min(1,n+raw[i]*scale)));
}

export function percentile(values,p) {
  if(!Array.isArray(values)||!values.length||values.some(v=>!Number.isFinite(v))||!Number.isFinite(p)||p<0||p>1) throw Error('Invalid percentile values.');
  const sorted=[...values].sort((a,b)=>a-b),at=(sorted.length-1)*p,lo=Math.floor(at),hi=Math.ceil(at);
  return sorted[lo]+(sorted[hi]-sorted[lo])*(at-lo);
}

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function writeArtifact(file,bytes) {
  if(fs.existsSync(file)) {
    const existing=fs.lstatSync(file);
    if(!existing.isFile()||existing.isSymbolicLink()||existing.nlink>1)throw Error('Refusing an aliased evaluation artifact.');
  }
  const temporary=path.join(path.dirname(file),'.evaluation-'+crypto.randomUUID()+'.part');
  try {fs.writeFileSync(temporary,bytes,{flag:'wx'});fs.renameSync(temporary,file);}
  finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
const writeJson=(file,value)=>writeArtifact(file,JSON.stringify(value,null,2)+'\n');
function safeOutput(directory) {
  const requested=path.resolve(directory),source=fs.realpathSync(repo);
  if(requested===source||requested.startsWith(source+path.sep))throw Error('Evaluation audio must remain outside source.');
  fs.mkdirSync(requested,{recursive:true});const actual=fs.realpathSync(requested);
  if(actual===source||actual.startsWith(source+path.sep))throw Error('Output aliases the source checkout.');
  return actual;
}
function modelFile(root,relative) {
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative))throw Error('Expected a relative model file.');
  const base=fs.realpathSync(root),file=path.resolve(base,relative);
  if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.realpathSync(file).startsWith(base+path.sep))throw Error('Model file is missing or escapes the model directory.');
  return file;
}

export function corpusRecipeHash() {return sha(JSON.stringify({version:1,utterances,noise:{snrDb:15,seed:7},syntheticVoice:'Kokoro English voice1',humanBundle:'sherpa-onnx-whisper-tiny.en/test_wavs'}));}

export function archiveCorpus(directory) {
  const root=fs.realpathSync(directory),frozen=loadCorpus(root),history=path.join(root,'history');
  fs.mkdirSync(history,{recursive:true});
  if(!fs.realpathSync(history).startsWith(root+path.sep))throw Error('Corpus history aliases another directory.');
  const target=fs.mkdtempSync(path.join(history,frozen.manifestSha256.slice(0,12)+'-'));
  for(const file of ['manifest.json',...frozen.manifest.cases.map(row=>row.file),...(fs.existsSync(path.join(root,'report.json'))?['report.json']:[])]) {
    const source=path.join(root,file);
    if(!fs.realpathSync(source).startsWith(root+path.sep)||!fs.lstatSync(source).isFile())throw Error('Invalid corpus history input.');
    fs.copyFileSync(source,path.join(target,file),fs.constants.COPYFILE_EXCL);
  }
  return target;
}

export async function generateCorpus({models=path.join(repo,'models'),output=path.join(repo,'..','runtime','listening-evaluation'),regenerate=false,onProgress=()=>{}}={}) {
  const directory=safeOutput(output);
  if(fs.existsSync(path.join(directory,'manifest.json'))&&!regenerate) {
    const frozen=loadCorpus(directory);
    if(frozen.manifest.recipeSha256!==corpusRecipeHash())throw Error('The existing corpus has another recipe; preserve it or explicitly use --regenerate.');
    onProgress('Reusing the frozen, hash-checked evaluation corpus.');return {directory,manifest:frozen.manifest};
  }
  if(fs.existsSync(path.join(directory,'manifest.json'))&&regenerate)onProgress('Archived prior corpus: '+archiveCorpus(directory));
  const config=JSON.parse(fs.readFileSync(modelFile(models,'speech.json'),'utf8'));
  const sherpa=require('sherpa-onnx-node');
  const keys=['model','voices','tokens','lexicon'];
  const kokoro=Object.fromEntries(keys.map(key=>[key,modelFile(models,config.tts?.[key])]));
  const tts=await sherpa.OfflineTts.createAsync({model:{kokoro,numThreads:2,provider:'cpu'},maxNumSentences:1});
  const cases=[];
  function save(id,audio,reference,source,variant='original',extra={}) {
    if(!/^[a-z0-9-]+$/.test(id))throw Error('Invalid fixture identity.');
    const bytes=encodeWav(audio.samples,audio.sampleRate),name=id+'.wav';
    writeArtifact(path.join(directory,name),bytes);
    const row={id,file:name,reference,source,variant,sampleRate:audio.sampleRate,seconds:audio.samples.length/audio.sampleRate,sha256:sha(bytes),...extra};cases.push(row);return row;
  }
  for(const prompt of utterances) {
    const chunks=[];let sampleRate;
    for(const text of prompt.parts||[prompt.text]) {
      const audio=await tts.generateAsync({text,sid:1,speed:1,enableExternalBuffer:false});
      const rate=audio.sampleRate||tts.sampleRate;
      if(sampleRate&&sampleRate!==rate)throw Error('TTS changed its sample rate.');sampleRate=rate;chunks.push(audio.samples);
    }
    const samples=concatenate(chunks,sampleRate,prompt.gapSeconds||0),reference=prompt.parts?.join(' ')||prompt.text;
    save(prompt.id,{samples,sampleRate},reference,{kind:'synthetic',engine:'Kokoro',voice:1},'original',{category:prompt.category,insertedPauseSeconds:prompt.gapSeconds||0});
    if(['capri-project','names','reminder'].includes(prompt.id))save(prompt.id+'-noise15',{samples:addNoise(samples,15,7),sampleRate},reference,{kind:'synthetic',engine:'Kokoro',voice:1},'deterministic-noise-15dB',{baseId:prompt.id,category:prompt.category,seed:7});
    onProgress('Generated '+prompt.id);
  }
  const transcripts=modelFile(models,'sherpa-onnx-whisper-tiny.en/test_wavs/trans.txt');
  for(const line of fs.readFileSync(transcripts,'utf8').trim().split(/\r?\n/)) {
    const match=line.match(/^([\w.-]+\.wav)\s+(.+)$/);if(!match)throw Error('Invalid bundled human transcript.');
    const original=modelFile(models,'sherpa-onnx-whisper-tiny.en/test_wavs/'+match[1]),bytes=fs.readFileSync(original),audio=decodeWav(bytes);
    save('human-'+match[1].replace(/\.wav$/,''),audio,match[2],{kind:'human',bundle:'sherpa-onnx-whisper-tiny.en/test_wavs',file:match[1],originalSha256:sha(bytes)},'original',{category:'human-read-speech'});
  }
  const ttsModelHashes=Object.fromEntries(keys.map(key=>[key,sha(fs.readFileSync(kokoro[key]))]));
  const manifest={version:1,createdAt:new Date().toISOString(),recipeSha256:corpusRecipeHash(),syntheticVoice:'Kokoro English voice1 (evaluation only; app voice unchanged)',ttsModelHashes,uniqueUtterances:utterances.length+cases.filter(row=>row.source.kind==='human').length,cases,limitations:['Known-text synthetic speech and three bundled read-speech clips are a limited regression corpus.','TTS regeneration can vary; frozen WAV hashes identify the benchmark and ordinary reruns reuse them.','No microphone, acoustic echo, spontaneous speech, accent coverage or real-call quality is measured.','The long-turn fixture exercises offline model limits; runtime chunking must be tested separately.']};
  writeJson(path.join(directory,'manifest.json'),manifest);return {directory,manifest};
}

export function loadCorpus(directory) {
  const root=fs.realpathSync(directory),file=path.join(root,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));
  if(manifest.version!==1||!Array.isArray(manifest.cases)||manifest.cases.length<1||manifest.cases.length>100)throw Error('Invalid corpus manifest.');
  const seen=new Set();
  const cases=manifest.cases.map(row=>{
    if(!row||typeof row.id!=='string'||seen.has(row.id)||typeof row.file!=='string'||!/^[-a-z0-9]+\.wav$/.test(row.file)||typeof row.reference!=='string'||row.reference.length>10000)throw Error('Invalid corpus entry.');
    seen.add(row.id);const target=path.join(root,row.file);
    if(!fs.realpathSync(target).startsWith(root+path.sep))throw Error('Corpus audio escapes its root.');
    const bytes=fs.readFileSync(target);if(sha(bytes)!==row.sha256)throw Error('Corpus audio hash changed: '+row.id);
    const audio=decodeWav(bytes);
    if(audio.sampleRate!==row.sampleRate||Math.abs(audio.samples.length/audio.sampleRate-row.seconds)>1e-6)throw Error('Corpus metadata mismatch.');
    return {...row,audio};
  });
  return {manifest,cases,manifestSha256:sha(fs.readFileSync(file))};
}

export function summarize(rows,coldLoadMs) {
  if(!rows.length)throw Error('No benchmark cases.');
  const totals=rows.reduce((out,row)=>({errors:out.errors+row.words.errors,referenceWords:out.referenceWords+row.words.referenceWords,decodeMs:out.decodeMs+row.decodeMs,seconds:out.seconds+row.seconds}),{errors:0,referenceWords:0,decodeMs:0,seconds:0});
  const group=kind=>{
    const selected=rows.filter(row=>row.source.kind===kind),errors=selected.reduce((n,row)=>n+row.words.errors,0),referenceWords=selected.reduce((n,row)=>n+row.words.referenceWords,0);
    return {cases:selected.length,errors,referenceWords,wer:errors/Math.max(1,referenceWords)};
  };
  return {coldLoadMs,caseCount:rows.length,errors:totals.errors,referenceWords:totals.referenceWords,wer:totals.errors/Math.max(1,totals.referenceWords),warmLatencyMs:{p50:percentile(rows.map(row=>row.decodeMs),.5),p95:percentile(rows.map(row=>row.decodeMs),.95)},realTimeFactor:totals.decodeMs/(totals.seconds*1000),groups:{synthetic:group('synthetic'),human:group('human')}};
}

export async function evaluateCorpus({models=path.join(repo,'models'),output=path.join(repo,'..','runtime','listening-evaluation'),onProgress=()=>{}}={}) {
  const directory=safeOutput(output),corpus=loadCorpus(directory),sherpa=require('sherpa-onnx-node');
  const cfg=JSON.parse(fs.readFileSync(modelFile(models,'speech.json'),'utf8'));
  const whisper={featConfig:{sampleRate:16000,featureDim:80},modelConfig:{whisper:{encoder:modelFile(models,cfg.encoder),decoder:modelFile(models,cfg.decoder),language:'en',task:'transcribe'},tokens:modelFile(models,cfg.tokens),numThreads:3,provider:'cpu'},decodingMethod:'greedy_search'};
  const configs=[{id:'whisper-tiny-en',config:whisper}];
  const parakeetPrefix='sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
  let parakeet;
  try {
    const transducer=Object.fromEntries(['encoder','decoder','joiner'].map(key=>[key,modelFile(models,parakeetPrefix+'/'+key+'.int8.onnx')]));
    parakeet={featConfig:{sampleRate:16000,featureDim:80},modelConfig:{transducer,tokens:modelFile(models,parakeetPrefix+'/tokens.txt'),modelType:'nemo_transducer',numThreads:3,provider:'cpu'},decodingMethod:'greedy_search'};
    configs.push({id:'parakeet-tdt-v3-int8',config:parakeet});
  } catch(error) {onProgress('Optional Parakeet unavailable: '+error.message);}
  const report={version:1,createdAt:new Date().toISOString(),corpusManifestSha256:corpus.manifestSha256,driverSha256:sha(fs.readFileSync(fileURLToPath(import.meta.url))),nodeVersion:process.version,logicalCores:(await import('node:os')).cpus().length,recognizerThreads:3,loadConditions:'First recognizer construction per backend in this process; operating-system file cache is not controlled.',normalization:'Unicode NFKC and lowercasing, apostrophe removal and punctuation splitting; number formatting is not normalized.',backends:[],limitations:corpus.manifest.limitations,defaultChanged:false};
  if(!parakeet) report.backends.push({id:'parakeet-tdt-v3-int8',available:false,reason:'The locally configured optional model files are absent.'});
  for(const backend of configs) {
    const start=performance.now(),recognizer=await sherpa.OfflineRecognizer.createAsync(backend.config),coldLoadMs=performance.now()-start;
    const modelHashes={};
    for(const [key,value] of Object.entries(backend.config.modelConfig.whisper||backend.config.modelConfig.transducer||{})) if(typeof value==='string'&&fs.existsSync(value))modelHashes[key]=sha(fs.readFileSync(value));
    modelHashes.tokens=sha(fs.readFileSync(backend.config.modelConfig.tokens));
    // Warm-up is measured separately and excluded from the warm percentile sample.
    const first=corpus.cases[0],warmupStream=recognizer.createStream();warmupStream.acceptWaveform(first.audio);const warmupStart=performance.now();await recognizer.decodeAsync(warmupStream);const warmupDecodeMs=performance.now()-warmupStart;
    const rows=[];
    for(const row of corpus.cases) {
      const stream=recognizer.createStream();stream.acceptWaveform(row.audio);const decodeStart=performance.now(),result=await recognizer.decodeAsync(stream),decodeMs=performance.now()-decodeStart;
      const text=String(result.text||'').trim();
      rows.push({id:row.id,source:row.source,variant:row.variant,category:row.category,reference:row.reference,hypothesis:text,seconds:row.seconds,decodeMs,realTimeFactor:decodeMs/(row.seconds*1000),words:wordErrors(row.reference,text)});
      onProgress(backend.id+': '+row.id+' ('+Math.round(decodeMs)+' ms)');
    }
    report.backends.push({id:backend.id,available:true,modelHashes,warmupDecodeMs,summary:summarize(rows,coldLoadMs),cases:rows});
    writeJson(path.join(directory,'report.json'),report);
  }
  const base=report.backends.find(b=>b.id==='whisper-tiny-en'&&b.available),alternative=report.backends.find(b=>b.id==='parakeet-tdt-v3-int8'&&b.available);
  if(base&&alternative) report.comparison={werDelta:alternative.summary.wer-base.summary.wer,humanWerDelta:alternative.summary.groups.human.wer-base.summary.groups.human.wer,warmP95Ratio:alternative.summary.warmLatencyMs.p95/base.summary.warmLatencyMs.p95,alternativeBelowRealtime:alternative.summary.realTimeFactor<1,interpretation:'This fixed local regression corpus cannot establish microphone accuracy or justify a default change by itself.'};
  report.finishedAt=new Date().toISOString();writeJson(path.join(directory,'report.json'),report);return report;
}

async function main() {
  const args=process.argv.slice(2),mode=args[0]||'all';
  if(!['generate','evaluate','all'].includes(mode)||args.length>2||args.length===2&&args[1]!=='--regenerate'||mode==='evaluate'&&args[1])throw Error('Usage: node scripts/listening-fixtures.mjs [generate|evaluate|all] [--regenerate]');
  const options={onProgress:message=>console.log(message),regenerate:args.includes('--regenerate')};
  if(mode!=='evaluate')await generateCorpus(options);
  if(mode!=='generate') {
    const report=await evaluateCorpus(options);
    console.log(JSON.stringify({report:path.join(repo,'..','runtime','listening-evaluation','report.json'),backends:report.backends.map(({id,available,summary,reason})=>({id,available,summary,reason})),comparison:report.comparison,defaultChanged:false},null,2));
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
