import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/server/store';
import {createService} from '../src/server/service';
import {SpeechOutput,defaultSpeechPreferences} from '../src/server/speech-output';
import {defaults} from '../src/shared';
import {version} from '../src/version';
import {wav} from '../src/server/local-speech';
test('provider-neutral speech is authenticated, cancellation is routed, phrase downloads require explicit confirmation, and versions agree',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'capri-speech-service-'));const store=await new Store(directory,randomBytes(32)).init();await store.put('settings',{...defaults,id:'main',localFallback:false});
 const bytes=wav(new Float32Array(1600),24000);const output=new SpeechOutput({directory:path.join(directory,'cache'),key:()=>undefined,saveKey:async()=>{},preferences:async()=>({...defaultSpeechPreferences,provider:'local'}),local:async()=>({base64:bytes.toString('base64'),mime:'audio/wav'})});
 const {app}=await createService({store,adminToken:'test-admin',key:()=>undefined,speechOutput:output});const headers={authorization:'Bearer test-admin'};
 try{
  assert.equal((await app.inject({method:'GET',url:'/health'})).json().version,version);
  assert.equal((await app.inject({method:'GET',url:'/v1/status',headers})).json().version,version);
  assert.equal((await app.inject({method:'POST',url:'/v1/voice/speak',payload:{requestId:'no-auth',text:'Hello'}})).statusCode,401);
  const audio=await app.inject({method:'POST',url:'/v1/voice/speak',headers,payload:{requestId:'speech',text:'Hello',private:true}});assert.equal(audio.statusCode,200);assert.equal(audio.json().provider,'local');
  assert.equal((await app.inject({method:'DELETE',url:'/v1/voice/speak/cancelled',headers})).json().cancelled,true);
  assert.equal((await app.inject({method:'POST',url:'/v1/voice/speak',headers,payload:{requestId:'cancelled',text:'Hello'}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url:'/v1/voice/phrase-pack',headers,payload:{}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/v1/stop',headers,payload:{}})).statusCode,200);
 }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});
