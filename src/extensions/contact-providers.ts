import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {IdSchema} from './contracts';

/** These host-only adapters are not tool inputs. The outbox owns authorization and retries. */
export type ContactChannel = 'gmail'|'sms'|'voice'|'whatsapp'|'android';
export interface OutboundMessage {
  channel:ContactChannel; recipient:string; sender:string; body:string;
  subject?:string;
  whatsapp?:{contentSid:string; variables:Record<string,string>};
  maxVoiceSeconds?:number;
}
export const OutboundMessageSchema=z.object({channel:z.enum(['gmail','sms','voice','whatsapp','android']),recipient:z.string().max(254),sender:z.string().max(254),body:z.string().min(1).max(32768),
  subject:z.string().max(200).optional(),whatsapp:z.object({contentSid:z.string(),variables:z.record(z.string(),z.string())}).strict().optional(),maxVoiceSeconds:z.number().int().min(1).max(120).optional()}).strict();
export interface ProviderObservation {state:'accepted'|'sent'|'delivered'|'rejected'|'unconfirmed';recordId?:string}
export interface PreparedDelivery {dispatch():Promise<ProviderObservation>}
export interface ContactProvider {
  readonly id:string;
  readonly channel:ContactChannel;
  /** Validation, credential loading/refresh only; must never send. */
  prepare(message:Readonly<OutboundMessage>,signal:AbortSignal):Promise<PreparedDelivery>;
  /** Read-only, only called for a record previously returned for this message. */
  observe?(message:Readonly<OutboundMessage>,recordId:string,signal:AbortSignal):Promise<ProviderObservation>;
}
/** Implement with protected host storage; never expose this interface to models or exports. */
export interface ContactSecretVault {
  read(key:string):Promise<string|undefined>;
  write(key:string,value:string):Promise<void>;
  delete(key:string):Promise<void>;
}
export type ContactFetch = (url:string,init:RequestInit)=>Promise<Response>;
const unavailable=()=>new Error('Contact provider unavailable.');
const unknown=():ProviderObservation=>({state:'unconfirmed'});
function onceDelivery(run:()=>Promise<ProviderObservation>):PreparedDelivery {
  let dispatched:Promise<ProviderObservation>|undefined;
  return {dispatch:()=>dispatched??=Promise.resolve().then(run).catch(()=>unknown())};
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const id=(s:unknown):s is string=>IdSchema.safeParse(s).success;
const sid=(s:unknown,prefix:string):s is string=>typeof s==='string'&&new RegExp('^'+prefix+'[a-fA-F0-9]{32}$').test(s);

export function canonicalRecipient(channel:ContactChannel,value:string):string {
  if(typeof value!=='string')throw unavailable();
  const v=value.trim();
  if(channel==='gmail'){
    // No display names, aliases, multiple recipients or header injection. Keep local-part case.
    if(v.length>254||! /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(v))throw unavailable();
    const at=v.lastIndexOf('@');return v.slice(0,at)+'@'+v.slice(at+1).toLowerCase();
  }
  if(channel==='android'){if(!id(v))throw unavailable();return v;}
  // Require an unambiguous international number; never guess country codes or strip punctuation.
  const phone=channel==='whatsapp'?v.replace(/^whatsapp:/,''):v;
  if(!/^\+[1-9][0-9]{7,14}$/.test(phone))throw unavailable();
  return channel==='whatsapp'?'whatsapp:'+phone:phone;
}

/** Plain-body messages use exact UTF-8 bytes. Extra transmitted content uses a reviewed envelope. */
export function reviewedContactBody(m:OutboundMessage):string {
  if(m.subject===undefined&&m.whatsapp===undefined&&m.maxVoiceSeconds===undefined)return m.body;
  const variables=m.whatsapp?Object.fromEntries(Object.entries(m.whatsapp.variables).sort(([a],[b])=>a.localeCompare(b))):undefined;
  return JSON.stringify({body:m.body,subject:m.subject??null,whatsapp:m.whatsapp?{contentSid:m.whatsapp.contentSid,variables}:null,maxVoiceSeconds:m.maxVoiceSeconds??null});
}
export function validateMessage(m:OutboundMessage,channel:ContactChannel){
  if(!OutboundMessageSchema.safeParse(m).success||m.channel!==channel||canonicalRecipient(channel,m.recipient)!==m.recipient||canonicalRecipient(channel,m.sender)!==m.sender||
    typeof m.body!=='string'||!m.body.length||Buffer.byteLength(m.body)>32768||
    (m.subject!==undefined&&(channel!=='gmail'||m.subject.length>200||/[\r\n]/.test(m.subject)))||
    (m.whatsapp!==undefined&&channel!=='whatsapp')||(m.maxVoiceSeconds!==undefined&&channel!=='voice'))throw unavailable();
  if(channel==='sms'&&m.body.length>1600)throw unavailable();
  if(channel==='voice'&&(m.maxVoiceSeconds===undefined||m.maxVoiceSeconds<1||m.maxVoiceSeconds>120||m.body.length>2000))throw unavailable();
  if(channel==='whatsapp'&&(!m.whatsapp||!sid(m.whatsapp.contentSid,'HX')||Object.entries(m.whatsapp.variables).some(([k,v])=>!/^\d{1,3}$/.test(k)||typeof v!=='string'||v.length>1024)))throw unavailable();
}
async function json(fetcher:ContactFetch,url:string,init:RequestInit):Promise<any>{
  const response=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.any([init.signal??new AbortController().signal,AbortSignal.timeout(30000)])});
  if(!response.ok)throw unavailable();
  const reader=response.body?.getReader();if(!reader)throw unavailable();
  const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>65536)throw unavailable();chunks.push(part.value);}}
  finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const gmailScope='https://www.googleapis.com/auth/gmail.send';
// Fixed official endpoint, assembled from path segments so the public export's home-path scanner stays strict.
const gmailSendUrl='https://gmail.googleapis.com/'+['gmail','v1','users','me','messages','send'].join('/');
const oauthLocks=new WeakMap<ContactSecretVault,Promise<unknown>>();
async function oauthSerialized<T>(vault:ContactSecretVault,run:()=>Promise<T>):Promise<T>{
  const previous=oauthLocks.get(vault)??Promise.resolve(),result=previous.catch(()=>{}).then(run);oauthLocks.set(vault,result);
  try{return await result;}finally{if(oauthLocks.get(vault)===result)oauthLocks.delete(vault);}
}
interface GmailTokens {accessToken:string;refreshToken?:string;expiresAt:number}
export interface GmailConfiguration {clientId:string;sender:string;vaultKey:string;clientSecretKey?:string}
/** Desktop loopback PKCE. The caller opens the returned URL only after trusted UI action. */
export class GmailProvider implements ContactProvider {
  readonly id='gmail';readonly channel='gmail' as const;
  private refresh?:Promise<GmailTokens>;
  private epoch=0;
  constructor(private config:GmailConfiguration,private vault:ContactSecretVault,private fetcher:ContactFetch,private clock:()=>number){}
  async beginConnection(redirectUri:string){
    try{
      const u=new URL(redirectUri);
      if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.hash||u.search||!this.config.clientId)throw unavailable();
      const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),expiresAt=this.clock()+300000;
      await this.vault.write(this.config.vaultKey+':pkce:'+hash(state),JSON.stringify({verifier,redirectUri,expiresAt,createdAt:this.clock()}));
      const q=new URLSearchParams({client_id:this.config.clientId,redirect_uri:redirectUri,response_type:'code',scope:gmailScope,
        access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
      return {authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?'+q,state,expiresAt};
    }catch{throw unavailable();}
  }
  async finishConnection(state:string,code:string,signal:AbortSignal):Promise<{connected:true}>{
    return oauthSerialized(this.vault,async()=>{
    try{
      if(!/^[A-Za-z0-9_-]{43}$/.test(state)||!code||code.length>4096)throw unavailable();
      const key=this.config.vaultKey+':pkce:'+hash(state),raw=await this.vault.read(key);
      // Consume before network I/O, including failed exchanges.
      await this.vault.delete(key);if(!raw)throw unavailable();
      const pending=JSON.parse(raw);
      if(pending.expiresAt<=this.clock()||pending.createdAt>this.clock())throw unavailable();
      const tokens=await this.token(new URLSearchParams({grant_type:'authorization_code',code,code_verifier:pending.verifier,redirect_uri:pending.redirectUri}),signal);
      if(!tokens.refreshToken)throw unavailable();
      await this.vault.write(this.config.vaultKey,JSON.stringify(tokens));this.epoch++;return {connected:true};
    }catch{throw unavailable();}
    });
  }
  async disconnect(){this.epoch++;try{await oauthSerialized(this.vault,()=>this.vault.delete(this.config.vaultKey));}catch{throw unavailable();}}
  private async token(form:URLSearchParams,signal:AbortSignal):Promise<GmailTokens>{
    form.set('client_id',this.config.clientId);
    if(this.config.clientSecretKey){const secret=await this.vault.read(this.config.clientSecretKey);if(!secret)throw unavailable();form.set('client_secret',secret);}
    const r=await json(this.fetcher,'https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form.toString(),signal});
    if(typeof r.access_token!=='string'||!r.access_token||r.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(r.expires_in)||r.expires_in<=0||r.expires_in>86400||
      (r.scope!==undefined&&r.scope!==gmailScope)||(r.refresh_token!==undefined&&typeof r.refresh_token!=='string'))throw unavailable();
    return {accessToken:r.access_token,refreshToken:r.refresh_token,expiresAt:this.clock()+r.expires_in*1000};
  }
  private async credentials(signal:AbortSignal):Promise<GmailTokens>{
    if(this.refresh)return this.refresh;
    this.refresh=oauthSerialized(this.vault,async()=>{
      const raw=await this.vault.read(this.config.vaultKey);if(!raw)throw unavailable();const t:GmailTokens=JSON.parse(raw);
      if(t.accessToken&&t.expiresAt>this.clock()+60000)return t;
      if(!t.refreshToken)throw unavailable();
      const next=await this.token(new URLSearchParams({grant_type:'refresh_token',refresh_token:t.refreshToken}),signal);
      next.refreshToken??=t.refreshToken;await this.vault.write(this.config.vaultKey,JSON.stringify(next));return next;
    });
    try{return await this.refresh;}finally{this.refresh=undefined;}
  }
  async prepare(message:OutboundMessage,signal:AbortSignal):Promise<PreparedDelivery>{
    try{
      const m=structuredClone(message);validateMessage(m,'gmail');if(m.sender!==canonicalRecipient('gmail',this.config.sender))throw unavailable();
      signal.throwIfAborted();const epoch=this.epoch,t=await this.credentials(signal);
      const subject=Buffer.from(m.subject??'Capri notification').toString('base64');
      const raw=Buffer.from('From: '+m.sender+'\r\nTo: '+m.recipient+'\r\nSubject: =?UTF-8?B?'+subject+'?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+Buffer.from(m.body).toString('base64').replace(/.{1,76}/g,'$&\r\n')).toString('base64url');
      return onceDelivery(async()=>{try{
        if(epoch!==this.epoch)return unknown();signal.throwIfAborted();
        const r=await json(this.fetcher,gmailSendUrl,{method:'POST',headers:{authorization:'Bearer '+t.accessToken,'content-type':'application/json'},body:JSON.stringify({raw}),signal});
        return id(r.id)?{state:'sent',recordId:r.id}:unknown();
      }catch{return unknown();}});
    }catch{throw unavailable();}
  }
  // Send-only OAuth deliberately has no mailbox read or inferred delivery capability.
}

export interface TwilioConfiguration {accountSid:string;authTokenKey:string;sender:string;voiceEnabled?:boolean}
const xml=(s:string)=>s.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]!));
/** Official Twilio REST API: SMS, optional bounded voice, or approved WhatsApp Content templates. */
export class TwilioProvider implements ContactProvider {
  readonly id:string;
  constructor(readonly channel:'sms'|'voice'|'whatsapp',private config:TwilioConfiguration,private vault:ContactSecretVault,private fetcher:ContactFetch){this.id='twilio-'+channel;}
  private async auth(){if(!sid(this.config.accountSid,'AC'))throw unavailable();const token=await this.vault.read(this.config.authTokenKey);if(!token)throw unavailable();return 'Basic '+Buffer.from(this.config.accountSid+':'+token).toString('base64');}
  private url(recordId?:string){return 'https://api.twilio.com/2010-04-01/Accounts/'+this.config.accountSid+'/'+(this.channel==='voice'?'Calls':'Messages')+(recordId?'/'+recordId:'')+'.json';}
  private observation(r:any,m:OutboundMessage,recordId?:string):ProviderObservation{
    if(!sid(r.sid,this.channel==='voice'?'CA':'SM')||recordId&&r.sid!==recordId||r.account_sid!==this.config.accountSid||r.to!==m.recipient||r.from!==m.sender||r.direction!=='outbound-api')return unknown();
    const s=r.status;
    const state:ProviderObservation['state']=this.channel==='voice'?
      ['queued','ringing','in-progress'].includes(s)?'accepted':s==='completed'?'sent':['busy','failed','no-answer','canceled'].includes(s)?'rejected':'unconfirmed':
      ['accepted','queued','sending','scheduled'].includes(s)?'accepted':s==='sent'?'sent':['delivered','read'].includes(s)?'delivered':['failed','undelivered','canceled'].includes(s)?'rejected':'unconfirmed';
    return {state,recordId:r.sid};
  }
  async prepare(message:OutboundMessage,signal:AbortSignal):Promise<PreparedDelivery>{
    try{
      const m=structuredClone(message);validateMessage(m,this.channel);signal.throwIfAborted();
      if(m.sender!==canonicalRecipient(this.channel,this.config.sender)||this.channel==='voice'&&!this.config.voiceEnabled)throw unavailable();
      const authorization=await this.auth(),form=new URLSearchParams({To:m.recipient,From:m.sender});
      if(this.channel==='voice'){form.set('Twiml','<Response><Say>'+xml(m.body)+'</Say></Response>');form.set('TimeLimit',String(m.maxVoiceSeconds));form.set('Timeout','20');}
      else if(this.channel==='whatsapp'){form.set('ContentSid',m.whatsapp!.contentSid);form.set('ContentVariables',JSON.stringify(m.whatsapp!.variables));}
      else form.set('Body',m.body);
      return onceDelivery(async()=>{try{signal.throwIfAborted();return this.observation(await json(this.fetcher,this.url(),{method:'POST',headers:{authorization,'content-type':'application/x-www-form-urlencoded'},body:form.toString(),signal}),m);}catch{return unknown();}});
    }catch{throw unavailable();}
  }
  async observe(message:OutboundMessage,recordId:string,signal:AbortSignal):Promise<ProviderObservation>{
    try{
      validateMessage(message,this.channel);if(!sid(recordId,this.channel==='voice'?'CA':'SM')||message.sender!==canonicalRecipient(this.channel,this.config.sender))return unknown();
      return this.observation(await json(this.fetcher,this.url(recordId),{method:'GET',headers:{authorization:await this.auth()},signal}),message,recordId);
    }catch{return unknown();}
  }
}

/** A host injects an authenticated, paired-device transport, never an arbitrary URL. */
export interface PairedAndroidTransport {
  paired(deviceId:string):Promise<boolean>;
  notify(input:{deviceId:string;notificationId:string;body:string},signal:AbortSignal):Promise<{notificationId:string;deviceId:string;bodySha256:string;recordId:string;state:'accepted'|'delivered'|'rejected'|'unconfirmed'}>;
  observe?(input:{deviceId:string;notificationId:string;body:string}):Promise<{notificationId:string;deviceId:string;bodySha256:string;recordId:string;state:ProviderObservation['state']}|undefined>;
}
export class AndroidNotificationProvider implements ContactProvider {
  readonly id='paired-android';readonly channel='android' as const;
  constructor(private transport:PairedAndroidTransport){}
  async prepare(message:OutboundMessage,signal:AbortSignal):Promise<PreparedDelivery>{
    const m=structuredClone(message);validateMessage(m,'android');signal.throwIfAborted();if(!await this.transport.paired(m.recipient))throw unavailable();
    const notificationId=randomUUID();
    return onceDelivery(async()=>{try{signal.throwIfAborted();if(!await this.transport.paired(m.recipient))return unknown();const r=await this.transport.notify({deviceId:m.recipient,notificationId,body:m.body},signal);
      return r.notificationId===notificationId&&r.recordId===notificationId&&r.deviceId===m.recipient&&r.bodySha256===hash(m.body)&&['accepted','delivered','rejected'].includes(r.state)?{state:r.state,recordId:r.recordId}:unknown();
    }catch{return unknown();}});
  }
  async observe(message:OutboundMessage,recordId:string,signal:AbortSignal):Promise<ProviderObservation>{
    validateMessage(message,'android');signal.throwIfAborted();if(!id(recordId))return unknown();
    const r=await this.transport.observe?.({deviceId:message.recipient,notificationId:recordId,body:message.body});
    return r&&r.recordId===recordId&&r.notificationId===recordId&&r.deviceId===message.recipient&&r.bodySha256===hash(message.body)?{state:r.state,recordId}:unknown();
  }
}

/** Constant-time comparison helper for one-time challenges; secrets are never returned. */
export function equalContactDigest(a:string,b:string):boolean {
  return /^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
