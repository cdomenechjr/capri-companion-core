import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { Settings } from '../shared';
import { CapriError } from './policy';

export const OLLAMA_URL = 'http://127.0.0.1:11434';
const billingCodes = new Set(['credit_balance_exhausted','insufficient_quota','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded','application_budget_exceeded']);
export class ProviderError extends CapriError {
 constructor(message:string,status:number,public code='',public errorType=''){super(message,status);}
}
export function exhausted(error:any){return error instanceof ProviderError && (billingCodes.has(error.code)||(!error.code&&error.errorType==='insufficient_quota'));}
export function providerCommand(text:string):'local'|'openai'|undefined {
 const match=text.trim().match(/^(?:(?:hey[ ,]+)?capri[ ,:]+)?(?:please\s+)?(?:switch(?:\s+(?:me|yourself))?(?:\s+(?:back|over))?\s+to|use|start using|change(?:\s+(?:your|the))?\s+(?:provider|model)\s+to)\s+(?:the\s+)?(local(?:\s+(?:build|model|version|mode|ai))?|open\s?ai(?:\s+(?:model|version|mode|ai))?)(?:\s+(?:please|now))?[.!?]*$/i);
 return match ? /^local/i.test(match[1])?'local':'openai' : undefined;
}
function messagesFor(body:any){
 const messages:any[]=[{role:'system',content:"You are the local backend of the Capri Windows companion, running on the user's own PC. The user deliberately selected a fictional Capri persona. Answer as Capri in English with original, playful dialogue. Be truthful about tools and runtime capabilities.\n"+String(body.instructions||'')+"\nAnswer the latest request directly. For ordinary conversation, stay in the Capri persona without volunteering an identity disclaimer. You are an AI assistant; never deny being an AI. This request is executing locally with downloaded model weights. Actual actions require tool evidence."}];
 const input=typeof body.input==='string'?[{role:'user',content:body.input}]:body.input||[];
 for(const item of input){
  if(item.type==='function_call'){
   let args:any;try{args=JSON.parse(item.arguments||'{}');}catch{throw new CapriError('A previous tool call was invalid; it was not repeated.');}
   messages.push({role:'assistant',content:'',tool_calls:[{id:item.call_id,type:'function',function:{name:item.name,arguments:args}}]});
  }else if(item.type==='function_call_output')messages.push({role:'tool',tool_call_id:item.call_id,content:String(item.output).slice(0,10000)});
  else if(item.role){
   const parts=Array.isArray(item.content)?item.content:[];
   const content=typeof item.content==='string'?item.content:parts.filter((p:any)=>p.type==='input_text'||p.type==='output_text').map((p:any)=>p.text).join('\n');
   const images=parts.filter((p:any)=>p.type==='input_image'&&/^data:image\/(png|jpeg|webp);base64,/.test(p.image_url)).map((p:any)=>p.image_url.split(',')[1]);
   messages.push({role:item.role==='developer'?'system':item.role,content:String(content).slice(-10000),...(images.length?{images}: {})});
  }
 }
 // Drop old complete conversational turns before the active tool sequence.
 let bytes=messages.reduce((n,m)=>n+m.content.length,0);
 while(bytes>23000&&messages.length>3&&messages[1].role!=='tool'&&!messages[1].tool_calls){bytes-=messages[1].content.length;messages.splice(1,1);}
 return messages;
}

/** Credentials are only attached to the fixed OpenAI origin, never the local adapter. */
export class ProviderRouter {
 private probe?:{at:number;value:any};
 constructor(private store:Store,private settings:()=>Promise<Settings>,private key:()=>string|undefined,private emit:(event:any)=>void){}
 async selected(){const settings=await this.settings();const block=await this.store.get('connection','fallback');return settings.providerMode==='local'||(!this.key()&&settings.localFallback)|| (settings.localFallback&&block?.active)?'local':'openai';}
 async available(){const settings=await this.settings();return !!this.key()||settings.providerMode==='local'||settings.localFallback;}
 async imageStatus(){
  const settings=await this.settings();const mode=settings.imageProviderMode??'follow';const configured=!!this.key();const block=await this.store.get('connection','images');
  let reason='';
  if(mode==='disabled')reason='Image generation and editing are disabled in Settings.';
  else if(mode!=='openai'&&(mode!=='follow'||await this.selected()==='local'))reason='Images need a configured image provider. Local mode will not spend OpenAI credits. Explicitly select the OpenAI image provider to allow cloud images with local reasoning.';
  else if(!configured)reason='Connect OpenAI in Settings first.';
  else if(block?.active)reason=String(block.reason||'OpenAI image access is unavailable.');
  return {available:!reason,provider:'openai',mode,model:settings.imageModel,configured,reason,verification:'configuration' as const};
 }
 async blockImages(reason:string,code:string,status?:number){await this.store.put('connection',{id:'images',active:true,reason,code,status});this.emit({type:'connection'});}
 async clearImageBlock(){await this.store.put('connection',{id:'images',active:false,reason:'',code:''});}
 async clearImageModelBlock(){
  const block=await this.store.get('connection','images');
  if(block?.active&&(block.status===404||['model_not_found','model_not_available'].includes(block.code)))await this.clearImageBlock();
 }
 async block(reason:string,code:string){await this.store.put('connection',{id:'fallback',active:true,reason,code});this.emit({type:'connection'});this.emit({type:'notice',text:'Using local AI: '+reason});}
 async switch(mode:'auto'|'local'|'openai'){
  const old=await this.settings();await this.store.put('settings',{...old,id:'main',providerMode:mode});
  if(mode!=='local'){
   await this.store.put('connection',{id:'fallback',active:false,reason:'',code:''});
   await this.clearImageBlock();
  }
  this.emit({type:'changed',kind:'settings'});this.emit({type:'connection'});return this.status();
 }
 async localStatus(force=false){
  if(!force&&this.probe&&Date.now()-this.probe.at<10000)return this.probe.value;
  const settings=await this.settings();let value:any;
  try{const response=await fetch(OLLAMA_URL+'/api/tags',{signal:AbortSignal.timeout(2500),redirect:'error'});if(!response.ok)throw Error('Local server returned HTTP '+response.status);const data=await response.json() as any;const ready=(data.models||[]).some((m:any)=>m.name===settings.localModel||m.model===settings.localModel);value={ready,running:true,model:settings.localModel,reason:ready?'':'Download '+settings.localModel+' in Ollama.'};}
  catch{value={ready:false,running:false,model:settings.localModel,reason:'Ollama is not running. Start Ollama to use local AI.'};}
  this.probe={at:Date.now(),value};return value;
 }
 async status(force=false){const s=await this.settings();const block=await this.store.get('connection','fallback');const active=await this.selected();const local=await this.localStatus(force);return {mode:s.providerMode,active,fallbackEnabled:s.localFallback,reason:block?.active?block.reason:!this.key()?'No OpenAI key is configured.':'',creditExhausted:!!block?.active,local};}
 async openai(endpoint:string,body:any,signal?:AbortSignal){
  const key=this.key();if(!key)throw new ProviderError('Connect OpenAI or enable local AI in Settings.',503,'missing_key');
  const response=await fetch('https://api.openai.com/v1/'+endpoint,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000),redirect:'error'});
  const data=await response.json() as any;if(!response.ok)throw new ProviderError(data.error?.message||'OpenAI request failed.',response.status,String(data.error?.code||''),String(data.error?.type||''));return data;
 }
 async local(body:any,signal?:AbortSignal){
  const config=await this.settings();if(/cloud/i.test(config.localModel))throw new CapriError('Choose a downloaded local model, not a cloud model.');
  const tools=(body.tools||[]).filter((t:any)=>t.type==='function').map((t:any)=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}));
  let response:Response;
  try{response=await fetch(OLLAMA_URL+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:config.localModel,messages:messagesFor(body),tools,stream:false,think:false,keep_alive:'5m',options:{num_ctx:config.localContext,num_predict:1200,temperature:0.6}}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000),redirect:'error'});}catch(error:any){if(signal?.aborted)throw error;throw new CapriError('Local AI could not answer. Make sure Ollama is running and the local model is downloaded. '+(error.name==='TimeoutError'?'The request timed out; previous tools were not replayed.':''),503);}
  const data=await response.json() as any;if(!response.ok)throw new CapriError(data.error||'Local model request failed.',response.status);
  if(!data.done||!data.message)throw new CapriError('Local AI returned an incomplete response.');
  const output:any[]=[];for(const call of data.message.tool_calls||[]){if(!tools.some((t:any)=>t.function.name===call.function?.name))throw new CapriError('Local AI requested an unavailable tool.');output.push({type:'function_call',name:call.function.name,arguments:JSON.stringify(call.function.arguments||{}),call_id:call.id||randomUUID()});}
  if(data.message.content)output.push({type:'message',content:[{type:'output_text',text:data.message.content,annotations:[]}]});
  return {output,provider:'local',usage:{input_tokens:data.prompt_eval_count||0,output_tokens:data.eval_count||0}};
 }
}
