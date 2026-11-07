import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
// @ts-expect-error Operator evaluation is native JavaScript outside the application TS graph.
import {words,wordErrors,encodeWav,decodeWav,concatenate,addNoise,percentile,summarize,utterances,writeArtifact,loadCorpus,generateCorpus,corpusRecipeHash,archiveCorpus} from '../scripts/listening-fixtures.mjs';

test('WER normalizes punctuation and counts real substitutions, insertions and deletions',()=>{
  assert.deepEqual(words('Capri’s 12-minute PLAN!'),['capris','12','minute','plan']);
  assert.equal(wordErrors('Hello, Capri!','hello capri').wer,0);
  assert.deepEqual(wordErrors('one two three','one four three'),{errors:1,substitutions:1,deletions:0,insertions:0,referenceWords:3,hypothesisWords:3,wer:1/3});
  const deletion=wordErrors('one two three','one three');assert.equal(deletion.deletions,1);assert.equal(deletion.errors,1);
  const insertion=wordErrors('one three','one two three');assert.equal(insertion.insertions,1);assert.equal(insertion.wer,.5);
  assert.equal(wordErrors('','').wer,0);assert.equal(wordErrors('','noise words').wer,2);assert.equal(wordErrors('one two','').deletions,2);
  assert.throws(()=>wordErrors('a '.repeat(4097),'a'),/4096 words/);
});

test('PCM16 round trip preserves bounds, sample rate and waveform precision',()=>{
  const original=Float32Array.from([-1,-.5,0,.5,1,1.4,-1.4]);
  const bytes=encodeWav(original,16000),decoded=decodeWav(bytes);
  assert.equal(bytes.length,44+original.length*2);assert.equal(decoded.sampleRate,16000);assert.equal(decoded.samples.length,original.length);
  decoded.samples.forEach((value:number,index:number)=>assert.ok(Math.abs(value-Math.max(-1,Math.min(1,original[index])))<2/32768));
  assert.throws(()=>encodeWav(new Float32Array([Number.NaN]),16000));
  assert.throws(()=>encodeWav(new Float32Array(0),16000));
  assert.throws(()=>encodeWav(new Float32Array(1),0));
  assert.throws(()=>encodeWav(new Float32Array(8000*121),8000));
});

test('WAVE parser rejects malformed length, channels, unsupported encoding and truncation',()=>{
  const source=encodeWav(new Float32Array([.1,.2,.3,.4]),16000);
  const channels=Buffer.from(source);channels.writeUInt16LE(2,22);assert.throws(()=>decodeWav(channels),/mono PCM16/);
  const float=Buffer.from(source);float.writeUInt16LE(3,20);assert.throws(()=>decodeWav(float));
  const overrun=Buffer.from(source);overrun.writeUInt32LE(1000,40);assert.throws(()=>decodeWav(overrun),/Truncated/);
  assert.throws(()=>decodeWav(source.subarray(0,-1)),/RIFF/);
  const wrongRate=Buffer.from(source);wrongRate.writeUInt32LE(0,24);assert.throws(()=>decodeWav(wrongRate),/sample rate/);
});

test('natural pauses retain every sample and are inserted only between parts',()=>{
  const first=new Float32Array([.25,.5]),second=new Float32Array([-.25]);
  const audio=concatenate([first,second],8000,.001);
  assert.equal(audio.length,11);assert.deepEqual(Array.from(audio),[.25,.5,0,0,0,0,0,0,0,0,-.25]);
  assert.deepEqual(Array.from(concatenate([first],8000,1)),[.25,.5]);
  assert.throws(()=>concatenate([],16000,1));assert.throws(()=>concatenate([first],16000,-1));assert.throws(()=>concatenate([first],16000,6));
});

test('noise transformation is deterministic, leaves source intact and measures its requested SNR',()=>{
  const source=Float32Array.from({length:16000},(_,i)=>Math.sin(i*.2)*.15),copy=source.slice();
  const one=addNoise(source,15,7),two=addNoise(source,15,7),other=addNoise(source,15,8);
  assert.deepEqual(one,two);assert.notDeepEqual(one,other);assert.deepEqual(source,copy);
  const signal=source.reduce((sum,n)=>sum+n*n,0),noise=one.reduce((sum:number,n:number,i:number)=>sum+(n-source[i])**2,0);
  assert.ok(Math.abs(10*Math.log10(signal/noise)-15)<.001);
  assert.deepEqual(addNoise(new Float32Array(20),15,7),new Float32Array(20));
  assert.throws(()=>addNoise(source,15,0));assert.throws(()=>addNoise(source,-1,7));assert.throws(()=>addNoise(source,Infinity,7));
});

test('percentiles are ordered, interpolate and reject empty or nonfinite samples',()=>{
  assert.equal(percentile([10,1,4,2],.5),3);assert.equal(percentile([1,100],.95),95.05);assert.equal(percentile([5],1),5);
  assert.throws(()=>percentile([],.5));assert.throws(()=>percentile([1,Number.NaN],.5));assert.throws(()=>percentile([1],1.1));
});

test('aggregate metrics use word-weighted error and separate synthetic from human evidence',()=>{
  const rows=[{source:{kind:'synthetic'},words:wordErrors('one two','one three'),decodeMs:100,seconds:2},{source:{kind:'human'},words:wordErrors('one two three four five six','one two three four five six'),decodeMs:300,seconds:3}];
  const report=summarize(rows,400);
  assert.equal(report.referenceWords,8);assert.equal(report.errors,1);assert.equal(report.wer,1/8);assert.equal(report.realTimeFactor,.08);
  assert.equal(report.groups.synthetic.wer,.5);assert.equal(report.groups.human.wer,0);assert.equal(report.warmLatencyMs.p50,200);assert.equal(report.coldLoadMs,400);
});

test('fixed corpus covers names, numbers, pauses, long speech and safe Stop wording',()=>{
  assert.equal(utterances.length,8);assert.equal(new Set(utterances.map((u:{id:string})=>u.id)).size,8);
  assert.ok(utterances.some((u:{category:string})=>u.category==='names'));assert.ok(utterances.some((u:{category:string})=>u.category==='numbers'));
  const pause=utterances.find((u:{id:string})=>u.id==='natural-pause');assert.equal(pause.parts.length,2);assert.ok(pause.gapSeconds>=1);
  const long=utterances.find((u:{id:string})=>u.id==='long-turn');assert.ok(words(long.parts.join(' ')).length>50);
});

test('artifact replacement is atomic and never writes through a hard link to another file',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'capri-listening-artifact-'));
  try {
    const file=path.join(root,'report.json'),linked=path.join(root,'linked.json');
    writeArtifact(file,'first');writeArtifact(file,'second');assert.equal(fs.readFileSync(file,'utf8'),'second');
    fs.linkSync(file,linked);
    assert.throws(()=>writeArtifact(linked,'overwrite'),/aliased/);
    assert.equal(fs.readFileSync(file,'utf8'),'second');assert.equal(fs.readFileSync(linked,'utf8'),'second');
    assert.deepEqual(fs.readdirSync(root).sort(),['linked.json','report.json']);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('ordinary generation reuses frozen hash-checked audio without loading TTS or touching models',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'capri-listening-frozen-'));
  try {
    const bytes=encodeWav(new Float32Array([.1,.2,.3]),16000),hash=createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(root,'fixture.wav'),bytes);
    const manifest={version:1,recipeSha256:corpusRecipeHash(),cases:[{id:'fixture',file:'fixture.wav',sha256:hash,sampleRate:16000,seconds:3/16000,reference:'test',source:{kind:'synthetic'}}]};
    fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));
    const loaded=await generateCorpus({output:root,models:path.join(root,'models-do-not-exist')});
    assert.deepEqual(loaded.manifest,manifest);assert.deepEqual(fs.readFileSync(path.join(root,'fixture.wav')),bytes);
    assert.equal(loadCorpus(root).cases.length,1);
    fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({diagnostic:true}));
    const archive=archiveCorpus(root);assert.ok(archive.startsWith(path.join(root,'history')+path.sep));
    assert.deepEqual(fs.readFileSync(path.join(archive,'fixture.wav')),bytes);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(archive,'manifest.json'),'utf8')),manifest);assert.equal(JSON.parse(fs.readFileSync(path.join(archive,'report.json'),'utf8')).diagnostic,true);
    const changed=Buffer.from(bytes);changed[44]^=1;fs.writeFileSync(path.join(root,'fixture.wav'),changed);
    await assert.rejects(generateCorpus({output:root}),/hash changed/);
    fs.writeFileSync(path.join(root,'fixture.wav'),bytes);manifest.recipeSha256='changed';fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));
    await assert.rejects(generateCorpus({output:root}),/another recipe/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
