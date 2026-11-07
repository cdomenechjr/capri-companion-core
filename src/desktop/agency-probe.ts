import {app,BrowserWindow} from 'electron';
import {randomUUID} from 'node:crypto';

/** Integration test against an isolated window belonging to Capri, never another app. */
export async function agencyProbe(native:(action:string,args:any,signal:AbortSignal)=>Promise<any>){
 app.setAccessibilitySupportEnabled(true);
 const title=`Capri agency test fixture (${process.pid}, ${randomUUID()})`;
 const win=new BrowserWindow({width:600,height:400,show:false,title,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const controller=new AbortController();
 const disappeared=()=>Error('The owned Capri agency test fixture disappeared before verification.');
 win.once('closed',()=>controller.abort(disappeared()));
 const assertFixture=()=>{if(win.isDestroyed()||win.webContents.isDestroyed())throw disappeared();};
 // Check after failed calls too, so closing the fixture cannot look like a readiness timeout.
 const callNative=async(action:string,args:any)=>{
  assertFixture();
  try{const result=await native(action,args,controller.signal);assertFixture();return result;}
  catch(error){assertFixture();throw error;}
 };
 try{
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><title>${title}</title><label>Agency field<input aria-label="Agency field" id="field"></label><button id="verify" onclick="document.getElementById('result').innerText=document.getElementById('field').value">Verify field</button><p id="result"></p>`));
  assertFixture();
  const handle=win.getNativeWindowHandle();
  const windowId=handle.length>=8?Number(handle.readBigUInt64LE()):handle.readUInt32LE();
  win.show();
  win.focus();
  console.log('CAPRI_AGENCY_FIXTURE_READY '+JSON.stringify({windowId,processId:process.pid,title}));

  const waitForElement=async(name:string,control:RegExp)=>{
   const deadline=Date.now()+30_000;
   let foregroundWindow:unknown;
   let elementAvailable=false;
   let timedOut=false;
   const timeout=()=>Error(`Capri agency fixture readiness timed out waiting for ${name}. Activate this test window: "${title}" (windowId ${windowId}, processId ${process.pid}). Native foregroundWindow=${String(foregroundWindow)}; requested accessibility element available=${elementAvailable}. No ${name==='Agency field'?'type':'invoke'} was dispatched.`);
   // Bound in-flight native reads as well as the polling interval.
   const timer=setTimeout(()=>{timedOut=true;controller.abort(timeout());},30_000);
   try{
    while(Date.now()<deadline){
     const activity=await callNative('activity',{});
     foregroundWindow=activity.foregroundWindow;
     elementAvailable=false;
     if(foregroundWindow===windowId){
      const inspected=await callNative('inspect',{windowId});
      if(inspected.windowId!==windowId||inspected.processId!==process.pid||inspected.title!==title)throw Error('Native inspection no longer identifies the owned Capri agency test fixture. Input was withheld.');
      const element=inspected.elements?.find((e:any)=>e.name===name&&control.test(e.control)&&typeof e.id==='string'&&e.id.length>0&&e.enabled!==false&&e.offscreen!==true);
      elementAvailable=!!element;
      if(element){
       // Inspect may take time. Prove actual foreground identity again immediately
       // before returning its fresh UIA reference to the single input dispatch.
       foregroundWindow=(await callNative('activity',{})).foregroundWindow;
       if(foregroundWindow===windowId&&Date.now()<deadline)return element;
      }
     }
     await new Promise(resolve=>setTimeout(resolve,Math.min(500,Math.max(0,deadline-Date.now()))));
    }
    throw timeout();
   }catch(error){
    assertFixture();
    if(timedOut||Date.now()>=deadline)throw timeout();
    throw error;
   }finally{clearTimeout(timer);}
  };

  const field=await waitForElement('Agency field',/Edit/);
  await callNative('type',{windowId,elementId:field.id,text:'Native agency verified',expectedProcessId:process.pid});
  const button=await waitForElement('Verify field',/Button/);
  await callNative('invoke',{windowId,elementId:button.id,expectedProcessId:process.pid});
  await new Promise(resolve=>setTimeout(resolve,150));
  assertFixture();
  const value=await win.webContents.executeJavaScript('document.getElementById("result").innerText');
  assertFixture();
  if(value!=='Native agency verified')throw Error('Native interaction did not change the fixture.');
  return {passed:true,inspect:true,type:true,invoke:true,verified:true};
 }catch(error){
  assertFixture();
  throw error;
 }finally{
  controller.abort();
  if(!win.isDestroyed())win.destroy();
 }
}
