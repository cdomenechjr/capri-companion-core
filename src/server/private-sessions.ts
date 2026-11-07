import {CapriError} from './policy';

export type Audience={owner:string;epoch:string};
/** Host-owned classification survives scope expiry. A tombstone has no audience,
 * but is still private. Never delete it when a socket or task finishes. */
export class PrivateSessions {
 private tasks=new Map<string,{privateSession:boolean;owner?:string;audience?:Audience;intent?:string}>();
 restore(id:string,privateSession:boolean){this.tasks.set(id,{privateSession});}
 owned(owner:string){return [...this.tasks].filter(([,row])=>row.owner===owner).map(([id])=>id);}
 bind(id:string,privateSession:boolean,audience:Audience,intent:string){
  const old=this.tasks.get(id);
  if(old){if(old.privateSession!==privateSession||old.intent!==intent||old.audience?.owner!==audience.owner||old.audience?.epoch!==audience.epoch)throw new CapriError('Task ID belongs to another request or ended session.',409);return;}
  this.tasks.set(id,{privateSession,owner:audience.owner,audience:{...audience},intent});
 }
 end(owner:string,epoch:string){for(const row of this.tasks.values())if(row.privateSession&&row.audience?.owner===owner&&row.audience.epoch===epoch)row.audience=undefined;}
 audience(event:any):Audience|false|undefined {
  const id=event.taskId??event.message?.taskId;
  const row=typeof id==='string'?this.tasks.get(id):undefined;
  if(row?.privateSession)return row.audience??false;
  // Unknown task messages cannot upgrade themselves to public on a late path.
  if(event.privateSession===true||id&&!row)return false;
  return undefined;
 }
}
