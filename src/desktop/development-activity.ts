import {open, stat} from 'node:fs/promises';
import {normalizeAgentActivity, type AgentActivityEvent} from '../development';
/** Bounded tail reader, never executes event content or feeds it into the assistant. */
export function watchDevelopmentActivity(file:string, receive:(event:AgentActivityEvent)=>void, intervalMs=1000) {
  let offset=0, pending='', busy=false, disposed=false;
  const seen=new Set<string>();
  const tick=async()=>{
    if(busy||disposed)return; busy=true;
    try {
      const info=await stat(file);
      if(info.size<offset){offset=0;pending='';}
      if(info.size-offset>256*1024){offset=Math.max(0,info.size-256*1024);pending='';}
      if(info.size===offset)return;
      const handle=await open(file,'r'); let bytesRead=0; const buffer=Buffer.alloc(Math.min(256*1024,info.size-offset));
      try {({bytesRead}=await handle.read(buffer,0,buffer.length,offset));} finally {await handle.close();}
      offset+=bytesRead;pending+=buffer.subarray(0,bytesRead).toString('utf8');
      const lines=pending.split('\n');pending=lines.pop()!.slice(-64*1024);
      for(const line of lines){try {const event=normalizeAgentActivity(JSON.parse(line));if(!event||seen.has(event.id)||disposed)continue;seen.add(event.id);if(seen.size>1000)seen.delete(seen.values().next().value!);receive(event);}catch{/* partial or malformed event is data, not a runtime error */}}
    } catch {/* No coordinator, rotated log or an unavailable path is normal. */}
    finally {busy=false;}
  };
  const timer=setInterval(()=>void tick(),intervalMs); timer.unref();void tick();
  return ()=>{disposed=true;clearInterval(timer);};
}
