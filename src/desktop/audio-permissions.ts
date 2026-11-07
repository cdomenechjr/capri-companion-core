export function companionAudioPermission(localUrl:string,documentUrl:string,requestingOrigin:string,permission:string){
 if(!['media','speaker-selection'].includes(permission))return false;
 try{
  const service=new URL(localUrl);const document=new URL(documentUrl);const request=new URL(requestingOrigin);
  return service.protocol==='http:'&&service.hostname==='127.0.0.1'&&document.origin===service.origin&&request.origin===service.origin&&!document.username&&!document.password&&!request.username&&!request.password;
 }catch{return false;}
}
