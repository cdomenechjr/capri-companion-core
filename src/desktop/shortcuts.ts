// Keep this module independent of Electron so the renderer and tests share the
// exact shortcut without registering keys outside the desktop main process.
export const stopAccelerator='Control+Alt+Shift+X';
export const stopShortcutLabel=stopAccelerator.replace('Control','Ctrl');
export const stopShortcutFailure=`${stopShortcutLabel} could not be registered. Use Stop in Capri or the tray. If another app uses this shortcut, close it and restart Capri to retry.`;

export interface StopShortcutStatus {registered:boolean}
interface StopActions {
 stopLocal:()=>void;
 abortWorkers:()=>void;
 broadcastStop:()=>void;
 stopRemote:()=>Promise<unknown>;
}

export function stopShortcutText(status?:StopShortcutStatus){
 return status?.registered?stopShortcutLabel:status?stopShortcutFailure:`${stopShortcutLabel} · shortcut availability unconfirmed`;
}

export function registerStopShortcut(register:(accelerator:string,handler:()=>void)=>boolean,actions:StopActions):StopShortcutStatus {
 try {
  return {registered:register(stopAccelerator,()=>{
   actions.stopLocal();
   actions.abortWorkers();
   // The existing desktop broadcast resets host grants and speech playback,
   // and stops the owning renderer's voice and wake listening.
   actions.broadcastStop();
   void actions.stopRemote().catch(()=>{});
  })};
 }catch{
  // A thrown registration error, like a false result, never proves availability.
  return {registered:false};
 }
}
