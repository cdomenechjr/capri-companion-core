/** Change speech pace without changing sample rate or the speaker's pitch.
 * Waveform similarity overlap-add is bounded to short, local TTS buffers.
 */
export function speechTempo(input:Float32Array, sampleRate:number, speed:number):Float32Array {
 if (!Number.isFinite(speed)||speed<.7||speed>1.4||!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>48000) throw Error('Invalid speech tempo.');
 if (speed===1||!input.length) return input;
 const length=Math.round(input.length/speed);
 const window=Math.round(sampleRate*.04), hop=Math.floor(window/2), search=Math.round(sampleRate*.012);
 const output=new Float32Array(length+window), weights=new Float32Array(length+window);
 const fade=Float32Array.from({length:window},(_,i)=>Math.sin(Math.PI*(i+.5)/window)**2);
 let previous=0;
 for(let target=0;target<length;target+=hop) {
  const expected=Math.round(target*speed);
  let start=Math.min(expected,Math.max(0,input.length-window));
  if(target&&expected+window+search<input.length) {
   let best=-Infinity;
   const lo=Math.max(0,expected-search), hi=Math.min(input.length-window,expected+search);
   // A coarse correlation search preserves local waveform phase while leaving
   // the nominal timeline tied to the requested output duration.
   for(let candidate=lo;candidate<=hi;candidate+=3) {
    let dot=0,energy=1e-12;
    for(let i=0;i<hop;i+=4) {const v=input[candidate+i], r=input[previous+hop+i]||0;dot+=v*r;energy+=v*v;}
    const score=dot/Math.sqrt(energy);
    if(score>best){best=score;start=candidate;}
   }
  }
  for(let i=0;i<window&&start+i<input.length;i++){output[target+i]+=input[start+i]*fade[i];weights[target+i]+=fade[i];}
  previous=start;
 }
 for(let i=0;i<length;i++)if(weights[i]>1e-8)output[i]/=weights[i];
 return output.subarray(0,length);
}
