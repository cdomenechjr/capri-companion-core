import { request } from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { CapriError, privateAddress, publicUrl } from './policy';

/** Pin the checked DNS answer to the TLS connection; redirects need a new review. */
export async function readPublicHtml(input:string,signal:AbortSignal){
 const url=await publicUrl(input);const hostname=url.hostname.replace(/^\[|\]$/g,'');
 const addresses=await dns.lookup(hostname,{all:true});
 if(!addresses.length||addresses.some(a=>privateAddress(a.address)))throw new CapriError('Private-network address refused.',403);
 const address=addresses[0];
 const content=await new Promise<string>((resolve,reject)=>{
  const req=request(url,{method:'GET',family:address.family,servername:net.isIP(hostname)?undefined:hostname,lookup:((_host:any,_options:any,done:any)=>done(null,address.address,address.family)) as any,signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{Accept:'text/html,text/plain','User-Agent':'Capri/0.1 (personal research)'}},res=>{
   if((res.statusCode||500)>=300||!/^(text\/|application\/(rss\+xml|xml))/i.test(String(res.headers['content-type']))){res.resume();reject(new CapriError('The page is not readable text or redirects elsewhere.'));return;}
   let bytes=0;const chunks:Buffer[]=[];res.on('data',chunk=>{bytes+=chunk.length;if(bytes>512000){res.destroy(new CapriError('Page is too large.'));return;}chunks.push(chunk);});
   res.on('error',reject);res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
  });req.on('error',reject);req.end();
 });
 return {url:url.href,html:content,untrusted:true,retrievedAt:new Date().toISOString()};
}
export async function readPublicPage(input:string,signal:AbortSignal){const {html,...rest}=await readPublicHtml(input,signal);return {...rest,content:html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,18000)};}
