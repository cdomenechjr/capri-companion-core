type Device=Pick<MediaDeviceInfo,'kind'|'label'|'deviceId'>;
const prefix='capri-device:';
const hardware=(d:Device)=>!['default','communications'].includes(d.deviceId);

// Chromium device IDs depend on origin. Match named hardware again after the
// loopback service receives a new port on restart instead of saving a stale ID.
export function audioDeviceValue(device:Device,devices:Device[]){
 if(!device.label)return device.deviceId;
 const peers=devices.filter(d=>hardware(d)&&d.kind===device.kind&&d.label===device.label);
 return prefix+encodeURIComponent(JSON.stringify([device.label,Math.max(0,peers.findIndex(d=>d.deviceId===device.deviceId))]));
}
export function resolveNamedDevice(value:string,kind:MediaDeviceKind,devices:Device[]){
 if(!value.startsWith(prefix))return value;
 let name:string,index:number;
 try{[name,index]=JSON.parse(decodeURIComponent(value.slice(prefix.length)));if(typeof name!=='string'||!name||!Number.isInteger(index)||index<0||index>100)throw Error();}
 catch{throw Error('Invalid saved audio device. Choose it again in Settings.');}
 const selected=devices.filter(d=>hardware(d)&&d.kind===kind&&d.label===name)[index];
 if(!selected)throw Error('The selected audio device is disconnected: '+name+'. Choose another in Settings.');
 return selected.deviceId;
}
export async function audioDeviceId(value:string,kind:MediaDeviceKind){
 return value.startsWith(prefix)?resolveNamedDevice(value,kind,await navigator.mediaDevices.enumerateDevices()):value;
}
