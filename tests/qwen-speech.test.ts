import test from 'node:test';
import assert from 'node:assert/strict';
import {speechChunks,QwenSpeech} from '../src/server/qwen-speech';

test('quality voice keeps every word and punctuation across bounded utterances',()=>{
 const text="Okay, choom. Here's the plan: we're gonna make this work. ".repeat(14).trim();
 const chunks=speechChunks(text);
 assert.ok(chunks.length>1);assert.ok(chunks.every(c=>c.length<=160));
 assert.equal(chunks.join(' '),text);
 assert.throws(()=>speechChunks('x'.repeat(161)),/too long/);
});

test('an unprepared quality voice fails clearly rather than substituting another speaker',async()=>{
 const speech=new QwenSpeech('nonexistent-capri-quality-voice-test');
 assert.equal(speech.status().ready,false);
 await assert.rejects(speech.generate('Test line.','synthetic.wav',new AbortController().signal),/setup-quality-voice/);
});
