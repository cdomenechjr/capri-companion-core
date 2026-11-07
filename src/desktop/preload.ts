import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('capri',{
 agency:(action:string,args?:any)=>ipcRenderer.invoke('capri:agency',action,args),
 companion:(action:string,args?:any)=>ipcRenderer.invoke('capri:companion',action,args),
 place:(phase:string,x:number,y:number)=>ipcRenderer.send('capri:place',phase,x,y),
 desktopPreferences:(patch?:any)=>ipcRenderer.invoke('capri:desktopPreferences',patch),
 signal:(event:any)=>ipcRenderer.send('capri:signal',event),
 request:(method:string,route:string,body?:any)=>ipcRenderer.invoke('capri:request',method,route,body),
 window:(action:string)=>ipcRenderer.invoke('capri:window',action),
 chooseFolder:()=>ipcRenderer.invoke('capri:chooseFolder'),
 startLocalEngine:()=>ipcRenderer.invoke('capri:startLocalEngine'),
 wakeStatus:()=>ipcRenderer.invoke('capri:wakeStatus'),
 wakeAudio:(samples:number[])=>ipcRenderer.invoke('capri:wakeAudio',samples),
 connectRemote:(url:string,code:string)=>ipcRenderer.invoke('capri:remote',url,code),
 useLocal:()=>ipcRenderer.invoke('capri:local'),
 onEvent:(listener:(event:any)=>void)=>{const handler=(_event:any,value:any)=>listener(value);ipcRenderer.on('capri:event',handler);return ()=>ipcRenderer.removeListener('capri:event',handler);},
});
