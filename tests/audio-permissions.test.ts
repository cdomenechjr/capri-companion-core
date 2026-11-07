import test from 'node:test';
import assert from 'node:assert/strict';
import {companionAudioPermission} from '../src/desktop/audio-permissions';

test('audio devices are visible to Capri with normalized origins, while foreign pages and other permissions stay denied',()=>{
 const local='http://127.0.0.1:4000';
 assert.equal(companionAudioPermission(local,local+'/',local+'/','media'),true);
 assert.equal(companionAudioPermission(local,local+'/?avatar=1',local,'speaker-selection'),true);
 for(const origin of ['http://127.0.0.1:4001','http://127.0.0.1.evil.test:4000','https://example.com','file:///tmp/test','null'])assert.equal(companionAudioPermission(local,local+'/',origin,'media'),false);
 assert.equal(companionAudioPermission(local,'https://example.com',local,'media'),false);
 assert.equal(companionAudioPermission(local,local+'/',local,'display-capture'),false);
 assert.equal(companionAudioPermission(local,local+'/',local,'geolocation'),false);
});
