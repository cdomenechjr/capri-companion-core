import test from 'node:test';
import assert from 'node:assert/strict';
import {audioDeviceValue,resolveNamedDevice} from '../src/ui/audio-devices';
test('selected audio hardware survives changed Chromium IDs and a missing device never silently selects a different microphone',()=>{
 const before=[{kind:'audioinput' as const,label:'USB headset',deviceId:'old-mic'},{kind:'audiooutput' as const,label:'CABLE Input',deviceId:'old-output'}];
 const after=before.map(d=>({...d,deviceId:d.deviceId.replace('old','new')}));
 const mic=audioDeviceValue(before[0],before);const cable=audioDeviceValue(before[1],before);
 assert.equal(resolveNamedDevice(mic,'audioinput',after),'new-mic');assert.equal(resolveNamedDevice(cable,'audiooutput',after),'new-output');
 assert.throws(()=>resolveNamedDevice(mic,'audioinput',[]),/disconnected/);assert.throws(()=>resolveNamedDevice(mic,'audiooutput',after),/disconnected/);
 assert.throws(()=>resolveNamedDevice('capri-device:%xx','audioinput',after),/Invalid/);
 const duplicates=[before[0],{...before[0],deviceId:'second-mic'}];
 assert.equal(resolveNamedDevice(audioDeviceValue(duplicates[1],duplicates),'audioinput',duplicates),'second-mic');
});
