import type { State } from '../shared';

/** Generation can finish before the last audio packet plays. Track playback separately. */
export class VoiceState {
 playing=false;
 state:State='listening';
 accept(type:string):State|undefined {
  if(type==='output_audio_buffer.started'){this.playing=true;return this.state='speaking';}
  if(type==='input_audio_buffer.speech_started'){this.playing=false;return this.state='listening';}
  if(type==='output_audio_buffer.stopped'||type==='output_audio_buffer.cleared'){this.playing=false;return this.state='listening';}
  if(type==='response.created'&&!this.playing)return this.state='thinking';
  if(type==='response.done'&&!this.playing)return this.state='listening';
 }
 visible(taskState:State):State{return this.playing?'speaking':taskState;}
 reset(){this.playing=false;this.state='idle';}
}
