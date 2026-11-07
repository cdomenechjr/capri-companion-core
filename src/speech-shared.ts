export const upstreamVoice='MkTSSXNgnBULS6ek4pon';
export const offlinePhrases={greeting:'Capri online. Miss me, choom?',listening:"I'm listening.",acknowledgement:'On it, choom.',completion:'Done. Your move.',stopped:"I've stopped.",connectionFailure:"Connection's down. I'm still here.",approvalRequest:'Need your okay for this one.',reconnection:'Back on the link.'};
export type SpeechPreferences={provider:'elevenlabs'|'local';voiceId:string;model:string;localEngine:string;speed:number;localVoice:number};
export const defaultSpeechPreferences:SpeechPreferences={provider:'elevenlabs',voiceId:upstreamVoice,model:'eleven_multilingual_v2',localEngine:'designed-hq',speed:1,localVoice:1};
