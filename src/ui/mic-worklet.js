class CapriMicrophone extends AudioWorkletProcessor {
 constructor(options){super();this.paired=!!options?.processorOptions?.paired;this.samples=[];this.reference=[];this.valid=true;this.phase=0;this.sequence=0;this.start=0;}
 /**
  * Input 0 is the microphone. In paired mode input 1 is Capri's rendered playback from the same context: one resampling
  * phase picks the same instants from both, so each reference sample was rendered when its microphone sample was captured.
  * Paired packets carry a monotonic 16 kHz sample index; a quantum without the reference input (or the microphone) makes
  * that packet's reference invalid. Unpaired capture keeps the original Float32Array messages.
  */
 process(inputs){
  const data=inputs[0]?.[0];if(!data){if(this.paired)this.valid=false;return true;}
  const channels=this.paired?inputs[1]||[]:[];if(this.paired&&!channels.length)this.valid=false;
  const step=sampleRate/16000;
  for(let i=0;i<data.length;i++){if(this.phase<=0){this.samples.push(data[i]);if(this.paired){let sum=0;for(const c of channels)sum+=c[i];this.reference.push(channels.length?sum/channels.length:0);}this.phase+=step;}this.phase--;}
  if(this.samples.length>=1600){
   const samples=new Float32Array(this.samples);this.samples=[];
   if(!this.paired)this.port.postMessage(samples);
   else{const reference=new Float32Array(this.reference),nextStart=this.start+samples.length;
    // postMessage transfers and synchronously detaches both buffers; capture the next offset while length is intact.
    this.port.postMessage({sequence:this.sequence++,startSample:this.start,sampleRate:16000,samples,reference,referenceValid:this.valid},[samples.buffer,reference.buffer]);this.start=nextStart;this.reference=[];this.valid=true;}
  }
  return true;
 }
}
registerProcessor('capri-microphone',CapriMicrophone);
