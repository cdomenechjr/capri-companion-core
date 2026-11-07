import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/server/store';
import {createService} from '../src/server/service';
import {defaults} from '../src/shared';
import {legacyCapriPersonality,legacyCapriVoiceDirection} from '../src/character';

for(const custom of [false,true])test(custom?'character update preserves the user’s custom instructions':'character update replaces the old default dialogue profile while keeping devices, data and provider choice',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'capri-character-'));const store=await new Store(dir,randomBytes(32)).init();
 await store.put('settings',{...defaults,id:'main',characterRevision:2,personality:custom?'User-defined companion instructions':legacyCapriPersonality,voiceInstructions:custom?'User-defined delivery':legacyCapriVoiceDirection,providerMode:'local',microphoneId:'chosen-mic',voiceSpeed:custom?.95:1.08});
 await store.put('memory',{text:'Keep this preference',confirmed:true});const service=await createService({store,adminToken:'character-test-admin',key:()=>undefined});
 try{const response=await service.app.inject({method:'GET',url:'/v1/settings',headers:{authorization:'Bearer character-test-admin'}});const settings=response.json();assert.equal(settings.characterRevision,4);assert.equal(settings.providerMode,'local');assert.equal(settings.microphoneId,'chosen-mic');assert.equal(settings.personality,custom?'User-defined companion instructions':defaults.personality);assert.equal(settings.voiceInstructions,custom?'User-defined delivery':defaults.voiceInstructions);assert.equal(settings.voiceSpeed,custom?.95:1);assert.equal((await store.list('memory'))[0].text,'Keep this preference');}finally{await service.app.close();await rm(dir,{recursive:true,force:true});}
});
