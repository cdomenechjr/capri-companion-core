/** Only ordinary HTTPS links can leave the companion's sandbox. */
export function externalLink(input:string){
 try{const url=new URL(input);if(url.protocol!=='https:'||url.username||url.password)return undefined;return url.href;}catch{return undefined;}
}
