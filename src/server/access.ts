import {TaskPermission,AccessMode,TaskPaused} from '../agency';
import {CapriError} from './policy';
/** Grants originate in the local user interface; model arguments never create grants. */
export class TaskAccess {
 grants=new Map<string,TaskPermission>();
 waitingMs=new Map<string,number>();
 constructor(public mode:AccessMode='scoped'){}
 grant(id:string,request:string){const grant={taskId:id,request,mode:this.mode,createdAt:Date.now(),revoked:false};this.grants.set(id,grant);return grant;}
 get(id?:string){const grant=id?this.grants.get(id):undefined;return grant&&!grant.revoked?grant:undefined;}
 require(id?:string){const grant=this.get(id);if(!grant)throw new CapriError('This task needs local computer authorization.',403);return grant;}
 revoke(id?:string){if(id){this.grants.delete(id);return;}this.grants.clear();}
 setMode(mode:AccessMode){if(mode!==this.mode){this.revoke();this.mode=mode;}}
 async review<T>(id:string|undefined,work:()=>Promise<T>){const start=Date.now();try{return await work();}finally{if(id)this.waitingMs.set(id,(this.waitingMs.get(id)||0)+Date.now()-start);}}
 assertActive(id:string|undefined,signal:AbortSignal){signal.throwIfAborted();if(id&&!this.get(id))throw new TaskPaused('Computer permissions changed. Resume to authorize the task again.');}
}
export function routineCommand(command:string){
 if(/[;&|<>`\r\n]|\$|--%|\b(?:encodedcommand|executionpolicy|start-process|invoke-expression)\b/i.test(command))return false;
 return /^(?:Get-(?:Location|ChildItem|Content|Item|Process|Date)\b|git\s+(?:status|diff|log|show)\b|dotnet\s+(?:build|test|--info|--version)\b|(?:pnpm|npm)\s+(?:run\s+)?(?:test|check|build)\b)/i.test(command.trim());
}
