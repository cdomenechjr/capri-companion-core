// Bundled into resources/native/managed-preview.cjs; Root copies the reviewed
// bundle, Node, verifier and helpers OUTSIDE all replaceable snapshots before use.
//
// ROOT HANDOFF (commands below are documentation; workers never execute setup):
// Root first independently accepts/signs/publishes the complete immutable ZIP.
// Create dedicated owner-protected local directories $External, $Maintenance,
// $HostRoot and $Profiles, all separate from installed Capri and from each other.
// Preserve original 0.6 snapshots/pointer. Do not launch them with a new switch;
// Root explicitly promotes the first accepted managed-capable 0.7 normal baseline.
// $Snapshot is that broker-verified COMPLETE snapshot directory (win-unpacked/...),
// $Archive is its exact signed ZIP, $NodeSource is the reviewed Node executable.
// Run EACH copy command separately, once, into previously empty destinations:
// Copy-Item -LiteralPath "$Snapshot\win-unpacked\resources\native\managed-preview.cjs" -Destination "$External\managed-preview.cjs"
// Copy-Item -LiteralPath "$Snapshot\win-unpacked\resources\native\update-launcher.cjs" -Destination "$External\update-launcher.cjs"
// Copy-Item -LiteralPath "$Snapshot\win-unpacked\resources\native\Capri.ProcessSupervisor.exe" -Destination "$External\Capri.ProcessSupervisor.exe"
// Copy-Item -LiteralPath "$Snapshot\win-unpacked\resources\native\Capri.Windows.exe" -Destination "$External\Capri.Windows.exe"
// Copy-Item -LiteralPath "$Snapshot\win-unpacked\resources\native\launch-managed-preview.cmd" -Destination "$External\launch-managed-preview.cmd"
// Copy-Item -LiteralPath $NodeSource -Destination "$External\node.exe"
// Copy-Item -LiteralPath $Snapshot -Destination "$Maintenance\app" -Recurse
// Copy-Item -LiteralPath $Archive -Destination "$Maintenance\package.zip"
// & "$External\node.exe" "$External\managed-preview.cjs" describe
//
// describe prints the exact public configuration schema and this user's hashed
// owner identity. Root fills every field from its trusted public pins/records:
// - installationId is a NEW fixed UUID, shared by all profile generations;
// - root=$HostRoot; profilesRoot=$Profiles; appData is actual app.getPath(appData);
// - node/controller/launcher/supervisor/windowsHelper each pin an external file;
// - maintenance={root:$Maintenance,snapshot:<accepted UpdateSnapshot>};
// - brokerJournal/attestationRoot reference retained trusted published evidence;
// - keys/feed/channel/arch/minimumSequence/dataVersion are operator public trust.
// Do not put private signing/TLS/provider material in this file. Root supplies
// existing state.json plus snapshots/<id>/{app,package.zip} under $HostRoot and a
// CLOSED isolated profile at $Profiles/<generation UUID>; bootstrap never creates
// a missing vault, overwrites a pointer, copies the installed profile or registers
// startup. Use the promoted 0.7 normal baseline for start; 0.6 remains preserved.
// Root hashes the exact public config bytes to $ConfigSha256, then separately:
// & "$External\node.exe" "$External\managed-preview.cjs" bootstrap --config $Config --config-sha256 $ConfigSha256 --generation $Generation
// & "$External\launch-managed-preview.cmd" "$External\node.exe" "$External\managed-preview.cjs" start $Config $ConfigSha256
// & "$External\launch-managed-preview.cmd" "$External\node.exe" "$External\managed-preview.cjs" status $Config $ConfigSha256
// & "$External\launch-managed-preview.cmd" "$External\node.exe" "$External\managed-preview.cjs" stop $Config $ConfigSha256
//
// Normal Quit confirms the captured app's exit, then closes the controller and
// control socket. Run the same start command to launch again. Owner Stop keeps
// the app/writer alive with updates suspended; an explicit start authenticates
// to that controller, confirms the old app's exit and launches a fresh epoch.
// start refuses an already-active controller or any uncertain retirement.
// stop confirms owner/helper exit and closes the controller; start then creates
// a new one. None of these operations resubmits saved task/update requests.
//
// Bootstrap is offline-only and protects generated LOCAL backup/control keys.
// Actual signed bootstrap, native helper/maintenance-to-normal round trip, ACLs,
// safeStorage and physical cursor recovery still require Root acceptance.
import path from 'node:path';
import {ManagedUpdateController,ManagedConfigSchema,managedOwnerSha256,loadManagedTrust,managedHash,readManagedFile,managedControlKey,serveManagedControl,managedControlCommand,bootstrapManagedHost} from '../src/extensions/managed-update-host.ts';
import {UpdateStateSchema} from '../src/extensions/updates.ts';
import {z} from 'zod';

async function main(){
 const [command,...args]=process.argv.slice(2),options=new Map();
 if(command==='describe'&&!args.length){console.log(JSON.stringify({ownerSha256:managedOwnerSha256(),configurationSchema:z.toJSONSchema(ManagedConfigSchema)},null,2));return;}
 if(!['start','status','stop','bootstrap'].includes(command))throw Error('Unsupported managed command.');
 for(let i=0;i<args.length;i+=2){if(!['--config','--config-sha256','--generation'].includes(args[i])||options.has(args[i])||!args[i+1])throw Error('Invalid managed command.');options.set(args[i],args[i+1]);}
 if(command!=='bootstrap'&&options.has('--generation'))throw Error('Generation is bootstrap-only.');
 const trust=await loadManagedTrust(options.get('--config'),options.get('--config-sha256'));
 if(path.resolve(process.execPath).toLowerCase()!==trust.config.node.path.toLowerCase()||managedHash(await readManagedFile(process.execPath,512*1024*1024))!==trust.config.node.sha256||path.resolve(process.argv[1]).toLowerCase()!==trust.config.controller.path.toLowerCase())throw Error('Pinned external controller/Node required.');
 if(command==='bootstrap'){
  const state=UpdateStateSchema.parse(JSON.parse((await readManagedFile(path.join(trust.config.root,'state.json'))).toString()));
  await bootstrapManagedHost(trust,{generation:options.get('--generation'),state});(await managedControlKey(trust,true)).fill(0);
  // Initial key protection is explicit bootstrap; start never creates a missing key.
  const controller=await new ManagedUpdateController(trust).open();try{await controller.initializeBackup();}finally{await controller.stop();}
  console.log('Managed bootstrap verified offline.');return;
 }
 const key=await managedControlKey(trust);
 if(command!=='start'){console.log(JSON.stringify(await managedControlCommand(trust,key,command)));return;}
 // An existing suspended owner is a supported explicit relaunch. Only a missing
 // listener permits creating a new controller; authentication/refusal/unknown
 // retirement must never be mistaken for absence.
 try{console.log(JSON.stringify(await managedControlCommand(trust,Buffer.from(key),'start')));key.fill(0);return;}
 catch(error){if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error;}
 const controller=await new ManagedUpdateController(trust).open();let closeControl,closing;
 const close=()=>closing??=(async()=>{try{await controller.stop();}finally{await closeControl?.();}})();
 // Allow the stop RPC reply to drain before removing its authenticated channel.
 controller.onClosed=()=>setTimeout(()=>void close(),30);
 try{closeControl=await serveManagedControl(controller,key,()=>void close());}
 catch(error){await close();throw error;}
 try{await controller.start();console.log('Managed controller started.');}
 catch{console.error('Managed startup requires recovery. Authenticated status/stop remain available; no work is resumed.');}
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void close());
}
main().catch(()=>{console.error('Managed preview refused. Inspect public trust pins and retained ownership/recovery state.');process.exitCode=1;});
