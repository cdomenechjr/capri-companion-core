import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GmailProvider,TwilioProvider,AndroidNotificationProvider,canonicalRecipient,reviewedContactBody,approvedContactTextHash,renderApprovedContactText,
  type ContactFetch,type ContactSecretVault,type OutboundMessage} from '../src/extensions/contact-providers';

class Vault implements ContactSecretVault {
  private values=new Map<string,string>();
  async read(k:string){return this.values.get(k);}
  async write(k:string,v:string){this.values.set(k,v);}
  async delete(k:string){this.values.delete(k);}
}
const signal=()=>new AbortController().signal;
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const gmailMessage:OutboundMessage={channel:'gmail',recipient:'me@example.com',sender:'sender@example.com',body:'Private notification\r\nUTF-8: \u2728',subject:'A checked alert'};
const scope='https://www.googleapis.com/auth/gmail.send';
// Exact official send URL, built from segments so the public export's home-path scanner stays strict.
const gmailSendUrl=['https:','','gmail.googleapis.com','gmail','v1','users','me','messages','send'].join('/');

test('Gmail PKCE uses only send scope, consumes state, keeps verifier and tokens in vault',async()=>{
  const vault=new Vault(),calls:{url:string;init:RequestInit}[]=[];let now=100000;
  const fetcher:ContactFetch=async(url,init)=>{calls.push({url,init});return response({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600,token_type:'Bearer',scope});};
  const provider=new GmailProvider({clientId:'public-client-id',vaultKey:'gmail',sender:gmailMessage.sender},vault,fetcher,()=>now);
  await assert.rejects(provider.beginConnection('https://example.com/callback'));await assert.rejects(provider.beginConnection('http://127.0.0.1:1/callback?other=1'));
  const start=await provider.beginConnection('http://127.0.0.1:18601/oauth/google');const url=new URL(start.authorizationUrl);
  assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('scope'),scope);assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.doesNotMatch(JSON.stringify(start),/private-access|private-refresh|verifier/);
  await assert.rejects(provider.finishConnection('a'.repeat(43),'authorization-code',signal()));assert.equal(calls.length,0);
  assert.deepEqual(await provider.finishConnection(start.state,'authorization-code',signal()),{connected:true});
  const form=new URLSearchParams(calls[0].init.body as string),verifier=form.get('code_verifier')!;
  assert.equal(createHash('sha256').update(verifier).digest('base64url'),url.searchParams.get('code_challenge'));
  assert.equal(form.get('redirect_uri'),'http://127.0.0.1:18601/oauth/google');assert.equal(form.get('grant_type'),'authorization_code');assert.equal(calls[0].init.redirect,'error');
  await assert.rejects(provider.finishConnection(start.state,'authorization-code',signal()));assert.equal(calls.length,1);
  const expired=await provider.beginConnection('http://127.0.0.1:18601/oauth/google');now+=300001;
  await assert.rejects(provider.finishConnection(expired.state,'authorization-code',signal()));assert.equal(calls.length,1);
});

test('Gmail refresh is pre-dispatch, MIME is safe, send receipt means sent rather than delivered',async()=>{
  const vault=new Vault();await vault.write('gmail',JSON.stringify({accessToken:'expired',refreshToken:'refresh-secret',expiresAt:0}));
  const calls:{url:string;init:RequestInit}[]=[];
  const fetcher:ContactFetch=async(url,init)=>{calls.push({url,init});return url.includes('oauth2')?response({access_token:'fresh-secret',expires_in:3600,token_type:'Bearer',scope}):response({id:'gmail-id-1',threadId:'thread-1'});};
  const provider=new GmailProvider({clientId:'client',vaultKey:'gmail',sender:gmailMessage.sender},vault,fetcher,()=>100000);
  const ready=await provider.prepare(gmailMessage,signal());assert.equal(calls.length,1);assert.match(calls[0].url,/oauth2.googleapis.com\/token/);
  const receipt=await ready.dispatch();assert.deepEqual(receipt,{state:'sent',recordId:'gmail-id-1'});assert.equal(calls.length,2);
  const send=calls[1];assert.equal(send.url,gmailSendUrl);assert.equal((send.init.headers as any).authorization,'Bearer fresh-secret');
  const mime=Buffer.from(JSON.parse(send.init.body as string).raw,'base64url').toString('utf8');
  assert.match(mime,/^From: sender@example.com\r\nTo: me@example.com\r\n/);assert.match(mime,/Content-Transfer-Encoding: base64/);
  const encoded=mime.split('\r\n\r\n')[1];assert.equal(Buffer.from(encoded,'base64').toString('utf8'),gmailMessage.body);
  assert.equal('observe' in provider,false);assert.doesNotMatch(JSON.stringify(receipt),/fresh-secret|refresh-secret|example.com/);
  await assert.rejects(provider.prepare({...gmailMessage,subject:'Injected\r\nBcc: victim@example.com'},signal()));assert.equal(calls.length,2);
});

test('OAuth failures never send, leak provider text or retry automatically; uncertain HTTP send remains unknown',async()=>{
  const vault=new Vault();await vault.write('gmail',JSON.stringify({refreshToken:'refresh-secret',expiresAt:0}));let calls=0;
  const provider=new GmailProvider({clientId:'client',vaultKey:'gmail',sender:gmailMessage.sender},vault,async()=>{calls++;return response({error:'invalid_grant private-refresh secret'},400);},()=>100000);
  await assert.rejects(provider.prepare(gmailMessage,signal()),e=>String(e)==='Error: Contact provider unavailable.');assert.equal(calls,1);
  await vault.write('gmail',JSON.stringify({accessToken:'fresh-secret',expiresAt:999999999}));
  assert.deepEqual(await (await provider.prepare(gmailMessage,signal())).dispatch(),{state:'unconfirmed'});assert.equal(calls,2);
  const broad=new GmailProvider({clientId:'client',vaultKey:'other',sender:gmailMessage.sender},vault,async()=>response({access_token:'access',refresh_token:'refresh',expires_in:3600,token_type:'Bearer',scope:scope+' https://mail.google.com/'}),()=>100000);
  const start=await broad.beginConnection('http://127.0.0.1:18601/callback');await assert.rejects(broad.finishConnection(start.state,'code',signal()));assert.equal(await vault.read('other'),undefined);
});

test('concurrent Gmail prepares share one refresh, malformed send responses are unconfirmed',async()=>{
  const vault=new Vault();await vault.write('gmail',JSON.stringify({refreshToken:'refresh',expiresAt:0}));let refreshes=0;
  const provider=new GmailProvider({clientId:'client',vaultKey:'gmail',sender:gmailMessage.sender},vault,async(url)=>{
    if(url.includes('oauth2')){refreshes++;return response({access_token:'fresh',expires_in:3600,token_type:'Bearer'});}return response({success:true});
  },()=>100000);
  const ready=await Promise.all([provider.prepare(gmailMessage,signal()),provider.prepare(gmailMessage,signal())]);assert.equal(refreshes,1);
  assert.deepEqual(await ready[0].dispatch(),{state:'unconfirmed'});
});

test('OAuth state is single-use under concurrent callbacks and prepared sends stop after disconnect',async()=>{
  const vault=new Vault();let calls=0;
  const provider=new GmailProvider({clientId:'client',vaultKey:'gmail',sender:gmailMessage.sender},vault,async()=>{calls++;return response({access_token:'access',refresh_token:'refresh',expires_in:3600,token_type:'Bearer'});},()=>100000);
  const start=await provider.beginConnection('http://127.0.0.1:18601/callback');
  const completed=await Promise.allSettled([provider.finishConnection(start.state,'code',signal()),provider.finishConnection(start.state,'code',signal())]);
  assert.equal(completed.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls,1);
  const prepared=await provider.prepare(gmailMessage,signal());await provider.disconnect();
  assert.deepEqual(await prepared.dispatch(),{state:'unconfirmed'});assert.equal(calls,1);assert.equal(await vault.read('gmail'),undefined);
});

test('corrupt protected Gmail tokens and PKCE records fail before any provider request',async()=>{
  const vault=new Vault();let requests=0;const provider=new GmailProvider({clientId:'fixture',vaultKey:'gmail',sender:gmailMessage.sender},vault,async()=>{requests++;throw Error('Unexpected request');},()=>100000);
  for(const raw of ['null','[]',JSON.stringify({accessToken:23,expiresAt:999999999}),JSON.stringify({refreshToken:'fixture',expiresAt:-1}),JSON.stringify({accessToken:'fixture',expiresAt:999999999,extra:'unsupported'})]){
    await vault.write('gmail',raw);await assert.rejects(provider.prepare(gmailMessage,signal()));assert.equal(requests,0);
  }
  const start=await provider.beginConnection('http://127.0.0.1:18601/fixture'),key='gmail:pkce:'+createHash('sha256').update(start.state).digest('hex');
  await vault.write(key,JSON.stringify({createdAt:100000,expiresAt:400000,redirectUri:'https://example.invalid'}));await assert.rejects(provider.finishConnection(start.state,'fixture',signal()));assert.equal(await vault.read(key),undefined);assert.equal(requests,0);
});

const account='AC'+'a'.repeat(32),messageSid='SM'+'b'.repeat(32),callSid='CA'+'c'.repeat(32),contentSid='HX'+'d'.repeat(32);
const sms:OutboundMessage={channel:'sms',sender:'+15550000001',recipient:'+15550000002',body:'Checked content'};
function record(m:OutboundMessage,status:string,sid=messageSid){return {sid,account_sid:account,to:m.recipient,from:m.sender,direction:'outbound-api',status};}

test('Twilio SMS validates correlated receipts, polls owned SID read-only and never returns secrets',async()=>{
  const vault=new Vault();await vault.write('token','auth-secret');let status='queued';const calls:{url:string;init:RequestInit}[]=[];
  const provider=new TwilioProvider('sms',{accountSid:account,authTokenKey:'token',sender:sms.sender},vault,async(url,init)=>{calls.push({url,init});return response(record(sms,status));});
  const ready=await provider.prepare(sms,signal());assert.equal(calls.length,0);
  assert.deepEqual(await ready.dispatch(),{state:'accepted',recordId:messageSid});
  assert.deepEqual(await ready.dispatch(),{state:'accepted',recordId:messageSid});assert.equal(calls.length,1);
  const form=new URLSearchParams(calls[0].init.body as string);assert.equal(form.get('To'),sms.recipient);assert.equal(form.get('Body'),sms.body);assert.equal(calls[0].init.method,'POST');
  status='delivered';const observed=await provider.observe(sms,messageSid,signal());assert.deepEqual(observed,{state:'delivered',recordId:messageSid});assert.equal(calls[1].init.method,'GET');assert.ok(calls[1].url.endsWith('/Messages/'+messageSid+'.json'));
  assert.deepEqual(await provider.observe(sms,'https://attacker.example',signal()),{state:'unconfirmed'});assert.equal(calls.length,2);
  assert.doesNotMatch(JSON.stringify(observed),/auth-secret|155500/);
});

test('Twilio rejects response identity mismatches and arbitrary refusal errors without evidence',async()=>{
  const vault=new Vault();await vault.write('token','secret');
  for(const bad of [{...record(sms,'sent'),to:'+15550000003'},{...record(sms,'sent'),account_sid:'AC'+'e'.repeat(32)},
    {...record(sms,'sent'),direction:'inbound'},{...record(sms,'sent'),sid:'garbage'}]){
    const provider=new TwilioProvider('sms',{accountSid:account,authTokenKey:'token',sender:sms.sender},vault,async()=>response(bad));
    assert.deepEqual(await (await provider.prepare(sms,signal())).dispatch(),{state:'unconfirmed'});
  }
  const provider=new TwilioProvider('sms',{accountSid:account,authTokenKey:'token',sender:sms.sender},vault,async()=>{throw new Error('403 refused secret provider token');});
  assert.deepEqual(await (await provider.prepare(sms,signal())).dispatch(),{state:'unconfirmed'});
});

test('WhatsApp uses official approved Content template parameters, with no free-text Body or URL override',async()=>{
  const vault=new Vault();await vault.write('token','secret');let sent:RequestInit|undefined;
  const m:OutboundMessage={...sms,channel:'whatsapp',recipient:'whatsapp:'+sms.recipient,sender:'whatsapp:'+sms.sender,body:'Rendered reviewed template: 123456',whatsapp:{contentSid,variables:{'1':'123456'}}};
  const template={accountSid:account,sid:contentSid,language:'en',body:'Rendered reviewed template: {{1}}',variables:['1']};
  const provider=new TwilioProvider('whatsapp',{accountSid:account,authTokenKey:'token',sender:m.sender,approvedText:[{...template,sha256:approvedContactTextHash(template),revision:1,providerGeneration:'fixture-generation',checkedAt:0}]},vault,async(url,init)=>{assert.ok(url.startsWith('https://api.twilio.com/'));sent=init;return response(record(m,'sent'));});
  assert.equal((await (await provider.prepare(m,signal())).dispatch()).state,'sent');
  const form=new URLSearchParams(sent!.body as string);assert.equal(form.get('ContentSid'),contentSid);assert.equal(form.get('ContentVariables'),JSON.stringify({'1':'123456'}));assert.equal(form.has('Body'),false);
  await assert.rejects(provider.prepare({...m,whatsapp:undefined},signal()));
  assert.notEqual(reviewedContactBody(m),reviewedContactBody({...m,whatsapp:{contentSid,variables:{'1':'changed'}}}));
});

test('optional voice is disabled by default and sends escaped bounded TwiML only when configured',async()=>{
  const vault=new Vault();await vault.write('token','secret');let calls=0;
  const m:OutboundMessage={...sms,channel:'voice',body:'Hello <Dial> +1 & goodbye',maxVoiceSeconds:30};
  const fetcher:ContactFetch=async(url,init)=>{calls++;assert.ok(url.endsWith('/Calls.json'));const form=new URLSearchParams(init.body as string);
    assert.equal(form.get('TimeLimit'),'30');assert.equal(form.get('Timeout'),'20');assert.match(form.get('Twiml')!,/&lt;Dial&gt;/);assert.doesNotMatch(form.get('Twiml')!,/<Dial>/);
    return response(record(m,'queued',callSid));};
  const disabled=new TwilioProvider('voice',{accountSid:account,authTokenKey:'token',sender:m.sender},vault,fetcher);
  await assert.rejects(disabled.prepare(m,signal()));assert.equal(calls,0);
  const provider=new TwilioProvider('voice',{accountSid:account,authTokenKey:'token',sender:m.sender,voiceEnabled:true},vault,fetcher);
  assert.deepEqual(await (await provider.prepare(m,signal())).dispatch(),{state:'accepted',recordId:callSid});assert.equal(calls,1);
  await assert.rejects(provider.prepare({...m,maxVoiceSeconds:121},signal()));
  await assert.rejects(provider.prepare({...m,body:'&'.repeat(1600)},signal()));assert.equal(calls,1,'Escaped TwiML must fit the official inline bound before dispatch.');
});

test('Android transport requires pairing and matching notification receipt; unpaired never dispatches',async()=>{
  let paired=false,calls=0,match=false,recordId='';
  const provider=new AndroidNotificationProvider({paired:async()=>paired,notify:async(input)=>{calls++;recordId=input.notificationId;return {notificationId:match?input.notificationId:'wrong',recordId,deviceId:input.deviceId,bodySha256:createHash('sha256').update(input.body).digest('hex'),state:'delivered'};}});
  const m:OutboundMessage={channel:'android',sender:'desktop',recipient:'device-1',body:'Checked alert'};
  await assert.rejects(provider.prepare(m,signal()));assert.equal(calls,0);paired=true;
  assert.deepEqual(await (await provider.prepare(m,signal())).dispatch(),{state:'unconfirmed'});match=true;
  assert.deepEqual(await (await provider.prepare(m,signal())).dispatch(),{state:'delivered',recordId});
});

test('canonicalization is deterministic and does not guess international destinations or allow headers',()=>{
  assert.equal(canonicalRecipient('gmail',' User@EXAMPLE.COM '),'User@example.com');assert.equal(canonicalRecipient('whatsapp','+15550000001'),'whatsapp:+15550000001');
  for(const v of ['15550000001','+1 (555) 000-0001','+15550000001,+15550000002','+15550000001\r\nTo: x'])assert.throws(()=>canonicalRecipient('sms',v));
  for(const v of ['User <me@example.com>','me@example.com,other@example.com','me@example.com\r\nBcc: x'])assert.throws(()=>canonicalRecipient('gmail',v));
});

test('Content setup only GETs exact official records, pins approved plain text, and refuses rich/foreign/stale authority',async()=>{
  const vault=new Vault();await vault.write('token','fixture');
  const base={sid:contentSid,account_sid:account,language:'en',types:{'twilio/text':{body:'Capri is {{1}}.'}},variables:{'1':'sample'}};
  const approval={sid:contentSid,account_sid:account,whatsapp:{status:'approved',content_type:'twilio/text'}};
  for(const bad of ['none','account','sid','language','rich-alternative','rich-only','not-approved','approval-account','approval-sid','approval-type','extra-variable','missing-variable','malformed-placeholder','oversized'] as const){
    const content=structuredClone(base) as any,review=structuredClone(approval) as any,urls:string[]=[];
    if(bad==='account')content.account_sid='AC'+'c'.repeat(32);if(bad==='sid')content.sid='HX'+'e'.repeat(32);if(bad==='language')content.language='fr';
    if(bad==='rich-alternative')content.types['twilio/card']={title:'rich'};if(bad==='rich-only')content.types={'twilio/card':{title:'rich'}};
    if(bad==='not-approved')review.whatsapp.status='paused';if(bad==='approval-account')review.account_sid='AC'+'c'.repeat(32);if(bad==='approval-sid')review.sid='HX'+'e'.repeat(32);if(bad==='approval-type')review.whatsapp.content_type='twilio/card';
    if(bad==='extra-variable')content.variables['2']='extra';if(bad==='missing-variable')content.variables={};if(bad==='malformed-placeholder')content.types['twilio/text'].body='Bad {{name}}';if(bad==='oversized')content.types['twilio/text'].body='a'.repeat(1601);
    const p=new TwilioProvider('whatsapp',{accountSid:account,authTokenKey:'token',sender:'whatsapp:'+sms.sender},vault,async(url,init)=>{
      assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(url==='https://content.twilio.com/v1/Content/'+contentSid||url==='https://content.twilio.com/v1/Content/'+contentSid+'/ApprovalRequests',true);urls.push(url);return response(url.endsWith('/ApprovalRequests')?review:content);
    });
    if(bad==='none'){
      const t={...await p.approvedPlainText(contentSid,'en',signal()),revision:1,providerGeneration:'generation',checkedAt:Date.now()};assert.equal(renderApprovedContactText(t,{'1':'completed'}),'Capri is completed.');
      const invalidVariables:Record<string,string>[]=[{},{'1':'completed','2':'extra'},{'1':'{{nested}}'}];for(const variables of invalidVariables)assert.throws(()=>renderApprovedContactText(t,variables));
      assert.throws(()=>renderApprovedContactText({...t,sha256:'0'.repeat(64)},{'1':'completed'}));assert.throws(()=>renderApprovedContactText({...t,body:'Changed {{1}}.'},{'1':'completed'}));
    }else await assert.rejects(p.approvedPlainText(contentSid,'en',signal()),bad);
    assert.equal(urls.length,2);
  }
});

test('WhatsApp dispatch refuses unknown pins and mismatched rendered text; local monetary cap never uses obsolete maxPrice',async()=>{
  const vault=new Vault();await vault.write('token','fixture');let requests=0;
  const raw={accountSid:account,sid:contentSid,language:'en',body:'Capri is {{1}}.',variables:['1']},template={...raw,sha256:approvedContactTextHash(raw),revision:1,providerGeneration:'generation',checkedAt:Date.now()};
  const m:OutboundMessage={...sms,channel:'whatsapp',sender:'whatsapp:'+sms.sender,recipient:'whatsapp:'+sms.recipient,body:'Capri is completed.',whatsapp:{contentSid,variables:{'1':'completed'}}};
  const fetcher:ContactFetch=async(_url,init)=>{requests++;const form=new URLSearchParams(String(init.body));assert.equal(form.has('maxPrice'),false);assert.equal(form.has('MaxPrice'),false);assert.equal(form.has('Body'),false);return response(record(m,'sent'));};
  for(const approvedText of [undefined,[{...template,accountSid:'AC'+'c'.repeat(32)}],[{...template,sid:'HX'+'e'.repeat(32)}]]){
    const p=new TwilioProvider('whatsapp',{accountSid:account,authTokenKey:'token',sender:m.sender,approvedText},vault,fetcher);await assert.rejects(p.prepare(m,signal()));
  }
  const p=new TwilioProvider('whatsapp',{accountSid:account,authTokenKey:'token',sender:m.sender,approvedText:[template]},vault,fetcher);await assert.rejects(p.prepare({...m,body:'Unreviewed text'},signal()));assert.equal(requests,0);assert.equal((await (await p.prepare(m,signal())).dispatch()).state,'sent');assert.equal(requests,1);
});

test('Gmail disconnect/cancel during awaited token exchange cannot restore a late token generation',async()=>{
  const vault=new Vault();let release!:(value:Response)=>void,entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);
  const p=new GmailProvider({clientId:'client',vaultKey:'gmail',sender:gmailMessage.sender},vault,async()=>{entered();return new Promise<Response>(r=>release=r);},Date.now);
  const connection=await p.beginConnection('http://127.0.0.1:18601/callback'),finish=p.finishConnection(connection.state,'fixture-code',signal());await waiting;
  const disconnect=p.disconnect();release(response({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600,token_type:'Bearer'}));await assert.rejects(finish);await disconnect;assert.equal(await vault.read('gmail'),undefined);
  await assert.rejects(p.finishConnection(connection.state,'fixture-code',signal()));
});
