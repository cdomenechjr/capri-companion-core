#!/usr/bin/env node
/**
 * Offline only. No microphone, synthesis, downloads, cloud provider or app/profile launch.
 * node scripts/benchmark-listening.mjs --models models --fixtures /isolated/corpus.json --backends whisper,parakeet --repeats 2
 * Corpus: {cases:[{id,wav,transcript,sha256?,speech?,wake?,wakePhrase?}]}. WAV paths are relative to corpus.json.
 * speech=false identifies negative audio for frame false-speech measurement. wake is measured by a clearly labelled
 * transcript phrase proxy, separately from the actual offline keyword spotter when wake.json/models are installed.
 * No accuracy is inferred for unlabelled audio. Output includes transcripts; keep private corpora/reports outside public source/exports.
 * Optional Parakeet paths come ONLY from speech.json recognition.parakeet; this never changes the selected backend.
 */
import {readFileSync,realpathSync,statSync,createReadStream} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';

const require=createRequire(import.meta.url);
export function words(text){return String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}' ]/gu,' ').trim().split(/\s+/).filter(Boolean);}
export function wordErrors(expected,actual){
 const a=words(expected),b=words(actual);let previous=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,previous[j]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));previous=next;}
 return {edits:previous[b.length],words:a.length};
}
export function decodeWav(bytes){
 if(bytes.length<44||bytes.length>16000000||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.readUInt32LE(4)+8!==bytes.length)throw Error('Invalid WAV container.');
 let format,rate,channels,bits,data,align;
 for(let i=12;i+8<=bytes.length;){const size=bytes.readUInt32LE(i+4),start=i+8;if(start+size>bytes.length)throw Error('Truncated WAV chunk.');
  const id=bytes.toString('ascii',i,i+4);if(id==='fmt '){if(size<16)throw Error('Invalid WAV format.');format=bytes.readUInt16LE(start);channels=bytes.readUInt16LE(start+2);rate=bytes.readUInt32LE(start+4);align=bytes.readUInt16LE(start+12);bits=bytes.readUInt16LE(start+14);}
  if(id==='data')data=bytes.subarray(start,start+size);i=start+size+(size%2);
 }
 if(channels!==1||!(format===1&&bits===16||format===3&&bits===32)||!rate||rate<8000||rate>48000||!data?.length||align!==bits/8||data.length%align||data.length/align/rate>120)throw Error('Use mono PCM16/float32 WAV up to 120 seconds at 8–48 kHz.');
 const original=new Float32Array(data.length/align);for(let i=0;i<original.length;i++)original[i]=format===1?data.readInt16LE(i*2)/32768:data.readFloatLE(i*4);
 if(original.some(v=>!Number.isFinite(v)||Math.abs(v)>1.1)){original.fill(0);throw Error('Invalid WAV samples.');}
 if(rate===16000)return {samples:original,sampleRate:16000,sourceSampleRate:rate};
 const samples=new Float32Array(Math.round(original.length*16000/rate));for(let i=0;i<samples.length;i++){const pos=i*rate/16000,a=Math.min(Math.floor(pos),original.length-1),b=Math.min(a+1,original.length-1);samples[i]=original[a]+(original[b]-original[a])*(pos-a);}
 original.fill(0);return {samples,sampleRate:16000,sourceSampleRate:rate};
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileDigest(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
const percentile=(items,q)=>items.length?[...items].sort((a,b)=>a-b)[Math.max(0,Math.ceil(items.length*q)-1)]:null;
function localFile(root,name){if(typeof name!=='string'||path.isAbsolute(name))throw Error('Fixture paths must be relative to the corpus.');
 const file=realpathSync(path.resolve(root,name)),relative=path.relative(root,file);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!statSync(file).isFile())throw Error('Fixture path escapes corpus.');return file;}

export async function benchmarkListening({models,fixtures,backends=['whisper','parakeet'],repeats=2},dependencies={}){
 if(!Number.isInteger(repeats)||repeats<1||repeats>10||!backends.length||backends.some(b=>!['whisper','parakeet'].includes(b))||new Set(backends).size!==backends.length)throw Error('Invalid bounded benchmark options.');
 const corpusFile=realpathSync(fixtures),root=path.dirname(corpusFile),corpusBytes=readFileSync(corpusFile);
 if(corpusBytes.length>1000000)throw Error('Corpus manifest is too large.');const corpus=JSON.parse(corpusBytes.toString('utf8'));
 if(!Array.isArray(corpus.cases)||!corpus.cases.length||corpus.cases.length>100||new Set(corpus.cases.map(c=>c.id)).size!==corpus.cases.length)throw Error('Use 1–100 unique fixture cases.');
 for(const c of corpus.cases)if(typeof c.id!=='string'||!/^[a-zA-Z0-9._-]{1,80}$/.test(c.id)||typeof c.transcript!=='string'||c.transcript.length>16000||
  c.speech!==undefined&&typeof c.speech!=='boolean'||c.wake!==undefined&&typeof c.wake!=='boolean'||c.wakePhrase!==undefined&&(typeof c.wakePhrase!=='string'||!words(c.wakePhrase).length)||
  c.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(c.sha256))throw Error('Invalid labelled fixture case.');
 const manifestBytes=readFileSync(path.join(models,'speech.json'));if(manifestBytes.length>1000000)throw Error('Speech manifest is too large.');const manifest=JSON.parse(manifestBytes.toString('utf8'));
 const {tsImport}=await import('tsx/esm/api');
 const {recognitionConfiguration,SessionSpeechDetector,speechModelFile}=await tsImport('../src/extensions/speech.ts',import.meta.url);
 const makeRecognizer=dependencies.createRecognizer??(config=>require('sherpa-onnx-node').OfflineRecognizer.createAsync(config));
 const makeDetector=dependencies.createDetector??(()=>new SessionSpeechDetector(models));
 const fixtureHashes=new Map();
 const readFixture=c=>{const file=localFile(root,c.wav);if(statSync(file).size>16000000)throw Error('Fixture WAV is too large.');
  const bytes=readFileSync(file),sha256=digest(bytes),expected=c.sha256??fixtureHashes.get(c.id);
  if(expected&&sha256!==expected){bytes.fill(0);throw Error('Fixture hash mismatch: '+c.id);}fixtureHashes.set(c.id,sha256);return {bytes,sha256};};
 const report={schemaVersion:1,mode:'offline-fixtures',corpusSha256:digest(corpusBytes),speechManifestSha256:digest(manifestBytes),repeats,
  wakeMetric:'transcript-phrase-proxy-not-keyword-spotter',resampling:'linear-to-16000-mono',backends:[],vad:[]};
 // VAD is independent of recognition backend. Each case has its own inference state, closed even after failure.
 for(const c of corpus.cases){const {bytes,sha256}=readFixture(c);
  const audio=decodeWav(bytes);bytes.fill(0);const d=makeDetector();let speechFrames=0,frames=0,reason;
  try{for(let pos=0;pos<audio.samples.length;pos+=1600){const f=new Float32Array(1600);f.set(audio.samples.subarray(pos,pos+1600));
   let result;try{result=await d.detect({sessionId:'benchmark',sequence:frames,samples:Buffer.from(f.buffer).toString('base64')});}finally{f.fill(0);}
   if(!result.available){reason=result.reason;break;}frames++;if(result.speech)speechFrames++;
  }}finally{audio.samples.fill(0);await d.close();}
  report.vad.push({id:c.id,sha256,available:!reason,...(reason?{reason}:{frames,speechFrames,
   falseSpeechFrames:c.speech===false?speechFrames:null,falseSpeechRate:c.speech===false&&frames?speechFrames/frames:null,
   missedSpeechCase:c.speech===true?speechFrames===0:null})});
 }
 // Actual existing keyword-spotter model, independent of ASR. A new stream per fixture prevents cross-case context.
 const wakePhrase=corpus.wakePhrase??'Hey Capri';let wakeFiles;
 try{if(typeof wakePhrase!=='string'||wakePhrase.length>100)throw Error();
  const cfg=JSON.parse(readFileSync(speechModelFile(models,'wake.json'),'utf8'));
  wakeFiles={encoder:speechModelFile(models,cfg.encoder),decoder:speechModelFile(models,cfg.decoder),joiner:speechModelFile(models,cfg.joiner),tokens:speechModelFile(models,cfg.tokens),dictionary:speechModelFile(models,'en.phone')};
 }catch{report.wake={available:false,reason:'wake-model-missing-or-invalid'};}
 if(wakeFiles){let temporary;
  try{const dictionary=new Map();for(const line of readFileSync(wakeFiles.dictionary,'utf8').split(/\r?\n/)){const i=line.indexOf(' ');if(i>0&&!dictionary.has(line.slice(0,i)))dictionary.set(line.slice(0,i),line.slice(i+1));}
   const {wakeKeywords}=await tsImport('../src/desktop/wake-keywords.ts',import.meta.url);
   const keywords=wakeKeywords(wakePhrase,dictionary);temporary=await mkdtemp(path.join(os.tmpdir(),'capri-offline-wake-'));const keywordsFile=path.join(temporary,'keywords.txt');await writeFile(keywordsFile,keywords);
   const {encoder,decoder,joiner,tokens}=wakeFiles;const config={modelConfig:{transducer:{encoder,decoder,joiner},tokens,numThreads:2,provider:'cpu'},keywordsFile,keywordsScore:2,keywordsThreshold:.2,numTrailingBlanks:1};
   const spotter=dependencies.createWake?await dependencies.createWake(config):new (require('sherpa-onnx-node').KeywordSpotter)(config);const cases=[];
   for(const c of corpus.cases){if(c.wake===undefined)continue;if(c.wakePhrase&&words(c.wakePhrase).join(' ')!==words(wakePhrase).join(' ')){cases.push({id:c.id,available:false,reason:'wake-phrase-mismatch'});continue;}
    const {bytes}=readFixture(c);const audio=decodeWav(bytes);bytes.fill(0);
    try{const stream=spotter.createStream();let detected=false,detectedAtMs=null;const start=performance.now();
     // One second of digital trailing silence lets the existing trailing-blank rule finish near-end keywords.
     for(let pos=0;pos<audio.samples.length+16000;pos+=1600){const samples=new Float32Array(1600);if(pos<audio.samples.length)samples.set(audio.samples.subarray(pos,pos+1600));
      try{stream.acceptWaveform({samples,sampleRate:16000});while(spotter.isReady(stream))spotter.decode(stream);if(spotter.getResult(stream).keyword){detected=true;detectedAtMs=(pos+1600)/16;break;}}finally{samples.fill(0);}}
     cases.push({id:c.id,available:true,expected:c.wake,detected,correct:detected===c.wake,detectedAtMs,latencyMs:performance.now()-start});
    }finally{audio.samples.fill(0);}}
   report.wake={available:true,mode:'offline-keyword-spotter',phrase:wakePhrase,threshold:.2,keywordsSha256:digest(Buffer.from(keywords)),
    modelSha256:await Promise.all(Object.entries(wakeFiles).map(async([kind,file])=>({kind,sha256:await fileDigest(file)}))),cases,
    falsePositives:cases.filter(c=>c.available&&c.expected===false&&c.detected).length,misses:cases.filter(c=>c.available&&c.expected===true&&!c.detected).length};
  }catch{report.wake={available:false,reason:'wake-native-or-fixture-unavailable'};}finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
 }
 for(const backend of backends){let selected;try{selected=recognitionConfiguration(models,manifest,backend);}catch{report.backends.push({backend,available:false,reason:'model-missing-or-invalid'});continue;}
  const modelFiles=Object.values(selected.config.modelConfig.whisper??selected.config.modelConfig.transducer).filter(f=>typeof f==='string'&&path.isAbsolute(f));modelFiles.push(selected.config.modelConfig.tokens);
  const modelSha256=await Promise.all(modelFiles.map(async file=>({file:path.relative(realpathSync(models),file).replaceAll('\\','/'),sha256:await fileDigest(file)})));
  let recognizer;const start=performance.now();try{recognizer=await makeRecognizer(selected.config);}catch{report.backends.push({backend,available:false,reason:'native-unavailable'});continue;}
  const result={backend,available:true,modelSha256,loadMs:performance.now()-start,cases:[]};let edits=0,referenceWords=0;const latencies=[];
  for(let repeat=0;repeat<repeats;repeat++)for(const c of corpus.cases){const {bytes,sha256}=readFixture(c);
   const audio=decodeWav(bytes);bytes.fill(0);try{const begin=performance.now(),stream=recognizer.createStream();stream.acceptWaveform({samples:audio.samples,sampleRate:16000});const decoded=await recognizer.decodeAsync(stream),latencyMs=performance.now()-begin;
    const text=String(decoded.text??'').trim(),score=wordErrors(c.transcript,text),phrase=words(c.wakePhrase??'hey capri').join(' '),heard=(' '+words(text).join(' ')+' ').includes(' '+phrase+' ');
    edits+=score.edits;referenceWords+=score.words;latencies.push(latencyMs);result.cases.push({id:c.id,repeat,sha256,text,...score,wer:score.words?score.edits/score.words:null,
     latencyMs,audioMs:audio.samples.length/16,sourceSampleRate:audio.sourceSampleRate,wakeProxy:c.wake===undefined?null:{expected:c.wake,heard,correct:heard===c.wake}});
   }finally{audio.samples.fill(0);}}
  result.summary={edits,referenceWords,wer:referenceWords?edits/referenceWords:null,decodeP50Ms:percentile(latencies,.5),decodeP95Ms:percentile(latencies,.95),
   wakeProxyFalsePositives:result.cases.filter(c=>c.wakeProxy?.expected===false&&c.wakeProxy.heard).length,wakeProxyMisses:result.cases.filter(c=>c.wakeProxy?.expected===true&&!c.wakeProxy.heard).length};report.backends.push(result);
 }
 return report;
}

async function main(){const args=process.argv.slice(2);if(args.includes('--help')){console.log('Offline listening benchmark: --models DIR --fixtures CORPUS.json [--backends whisper,parakeet] [--repeats 1..10]\nSee the script header for labelled WAV corpus format. Reports go to stdout; no microphone, network, synthesis or profile access.');return;}
 const options={models:path.resolve('models')};const seen=new Set();for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!['--models','--fixtures','--backends','--repeats'].includes(key)||!value||value.startsWith('--')||seen.has(key))throw Error('Invalid arguments. Use --help.');seen.add(key);
  if(key==='--models'||key==='--fixtures')options[key.slice(2)]=path.resolve(value);else if(key==='--repeats')options.repeats=Number(value);else options.backends=value.split(',');}
 if(!options.fixtures)throw Error('Supply a local labelled --fixtures corpus. Use --help.');console.log(JSON.stringify(await benchmarkListening(options),null,2));}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Offline benchmark failed: check local corpus, model files and runtime. No fallback/download was attempted.');process.exitCode=1;});
