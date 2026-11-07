using System.Diagnostics;
using System.IO;
using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

// Original implementation. No cursor artwork or upstream code is embedded.
// All system mutation happens on this independent watchdog's owning thread while
// holding the user/logon/session mutex. Never write a Windows cursor scheme.
internal static class CursorWatchdog {
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr LoadImage(IntPtr instance,string file,uint type,int x,int y,uint flags);
 [DllImport("user32.dll",SetLastError=true)] static extern bool SetSystemCursor(IntPtr cursor,uint role);
 [DllImport("user32.dll")] static extern bool DestroyCursor(IntPtr cursor);
 [DllImport("user32.dll",SetLastError=true)] static extern bool SystemParametersInfo(uint action,uint param,IntPtr value,uint flags);
 [DllImport("user32.dll",EntryPoint="SystemParametersInfoW",SetLastError=true)] static extern bool ReadHighContrast(uint action,uint param,ref HIGHCONTRAST value,uint flags);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder name,int length,out int needed);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int size,out int needed);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,ref PROCESS_BASIC_INFORMATION data,int size,out int returned);
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_BASIC_INFORMATION {public IntPtr Reserved1,Peb,Reserved2,Reserved3,Pid,ParentPid;}
 [StructLayout(LayoutKind.Sequential)] struct LUID {public uint Low;public int High;}
 [StructLayout(LayoutKind.Sequential)] struct HIGHCONTRAST {public uint Size,Flags;public IntPtr Scheme;}
 [StructLayout(LayoutKind.Sequential)] struct TOKEN_STATISTICS {public LUID TokenId,AuthenticationId;public long Expiration;public int Type,Impersonation;public uint DynamicCharged,DynamicAvailable,GroupCount,PrivilegeCount;public LUID ModifiedId;}
 static readonly HashSet<uint> Roles=new(){32512,32513,32514,32642,32643,32644,32645,32646,32649,32650};
 static string AuthenticationId(IntPtr token){
  int size=Marshal.SizeOf<TOKEN_STATISTICS>();var data=Marshal.AllocHGlobal(size);
  try{if(!GetTokenInformation(token,10,data,size,out _))throw new Exception("Logon identity unavailable.");var s=Marshal.PtrToStructure<TOKEN_STATISTICS>(data);return $"{s.AuthenticationId.High:x8}{s.AuthenticationId.Low:x8}";}finally{Marshal.FreeHGlobal(data);}
 }
 static bool Unlocked(){var desktop=OpenInputDesktop(0,false,1);if(desktop==IntPtr.Zero)return false;try{var name=new StringBuilder(128);return GetUserObjectInformation(desktop,2,name,256,out _)&&name.ToString()=="Default";}finally{CloseDesktop(desktop);}}
 static bool Restore()=>SystemParametersInfo(0x0057,0,IntPtr.Zero,0); // SPI_SETCURSORS, no persistence flags.
 internal sealed record CursorAccessibility(bool compatible,bool? highContrast,int? pointerBaseSize,int? pointerSize);
 // Read only. Native-size imported resources are not yet scaled with verified
 // hotspots or recoloured for contrast, so preserve accessibility pointers instead.
 // CursorBaseSize's absent-value default is documented by Microsoft's accessibility
 // resource (MousePointer; no code copied):
 // https://github.com/microsoft/winget-dsc/blob/main/resources/Microsoft.Windows.Setting.Accessibility/Microsoft.Windows.Setting.Accessibility.psm1
 static int? ReadSize(RegistryKey? key,string name,int fallback,int maximum){
  var raw=key?.GetValue(name,null,RegistryValueOptions.DoNotExpandEnvironmentNames);
  if(raw==null)return fallback;
  if(raw is int number)return number>=1&&number<=maximum?number:null;
  if(raw is string text&&int.TryParse(text,System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out number))return number>=1&&number<=maximum?number:null;
  return null;
 }
 static CursorAccessibility Accessibility(){
  bool? contrast=null;int? baseSize=null,size=null;
  try{
   var info=new HIGHCONTRAST{Size=(uint)Marshal.SizeOf<HIGHCONTRAST>()};
   if(ReadHighContrast(0x0042,info.Size,ref info,0))contrast=(info.Flags&1)!=0; // SPI_GETHIGHCONTRAST, HCF_HIGHCONTRASTON.
   using var cursors=Registry.CurrentUser.OpenSubKey(@"Control Panel\Cursors",writable:false);
   using var accessibility=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Accessibility",writable:false);
   baseSize=ReadSize(cursors,"CursorBaseSize",32,256);size=ReadSize(accessibility,"CursorSize",1,15);
  }catch{} // Unknown/unreadable observations are incompatible, never assumed safe.
  return new(contrast==false&&baseSize==32&&size==1,contrast,baseSize,size);
 }
 static string? SafetyReason()=>!Unlocked()?"locked":!Accessibility().compatible?"accessibility":null;
 sealed class CursorSuspendedException(string reason):Exception {internal readonly string Reason=reason;}
 static void Reply(int id,bool ok,string? reason=null,long? expires=null,bool recovered=false,bool recoveryRequired=false,bool active=false){Console.WriteLine(JsonSerializer.Serialize(new{id,ok,reason,watchdogExpiresAt=expires,recovered,recoveryRequired,active,accessibility=Accessibility()}));Console.Out.Flush();}
 internal static object Status()=>new{supported=OperatingSystem.IsWindows(),unlocked=Unlocked(),accessibility=Accessibility()};
 static void Marker(string file,string owner){
  var temporary=file+"."+Guid.NewGuid().ToString("N")+".tmp";
  try{using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)){var bytes=Encoding.UTF8.GetBytes(owner);stream.Write(bytes);stream.Flush(true);}File.Move(temporary,file,true);}finally{if(File.Exists(temporary))File.Delete(temporary);}
 }
 static void Apply(JsonElement input,string marker,string owner,Func<bool> permitted){
  void Guard(){if(!permitted())throw new Exception("Cursor owner no longer permitted.");var reason=SafetyReason();if(reason!=null)throw new CursorSuspendedException(reason);}
  Guard();
  var files=input.GetProperty("files");if(files.ValueKind!=JsonValueKind.Array||files.GetArrayLength()<1||files.GetArrayLength()>10)throw new Exception("Invalid cursor roles.");
  var handles=new List<(uint role,IntPtr cursor)>();var roles=new HashSet<uint>();
  try{
   foreach(var file in files.EnumerateArray()){
    var role=file.GetProperty("role").GetUInt32();var path=file.GetProperty("path").GetString()!;var hash=file.GetProperty("sha256").GetString()!;
    if(!Roles.Contains(role)||!roles.Add(role)||!System.IO.Path.IsPathFullyQualified(path)||!(path.EndsWith(".ani",StringComparison.Ordinal)||path.EndsWith(".ani.cur",StringComparison.Ordinal)))throw new Exception("Invalid cursor file.");
    // Keep a read-only, non-delete/non-write sharing handle until LoadImage returns.
    // Busy is loaded twice: SetSystemCursor consumes each independent owned handle.
    using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
    if(stream.Length<22||stream.Length>4*1024*1024||!Convert.ToHexString(SHA256.HashData(stream)).Equals(hash,StringComparison.OrdinalIgnoreCase))throw new Exception("Cursor integrity changed.");
    var cursor=LoadImage(IntPtr.Zero,path,2,0,0,0x0010); // IMAGE_CURSOR, LR_LOADFROMFILE, never LR_SHARED.
    if(cursor==IntPtr.Zero)throw new Exception("Cursor load failed.");handles.Add((role,cursor));
   }
   Guard();
   Marker(marker,owner); // Durable crash recovery BEFORE the first system mutation.
   for(int i=0;i<handles.Count;i++){
    Guard();
    var item=handles[i];if(!SetSystemCursor(item.cursor,item.role))throw new Exception("Cursor role failed.");
    handles[i]=(item.role,IntPtr.Zero); // Windows consumes the handle on success.
   }
  }finally{foreach(var item in handles)if(item.cursor!=IntPtr.Zero)DestroyCursor(item.cursor);}
 }
 internal static int Run(){
  Mutex? lease=null;bool owned=false,dirty=false;string? marker=null;int lastId=0;
  try{
   // Capture the actual creating process, then pin its PID, start time, logon and
   // terminal session. A reused PID, replacement parent or different logon fails.
   using var self=Process.GetCurrentProcess();var basic=new PROCESS_BASIC_INFORMATION();
   if(NtQueryInformationProcess(self.Handle,0,ref basic,Marshal.SizeOf<PROCESS_BASIC_INFORMATION>(),out _)!=0)throw new Exception("Parent unavailable.");
   using var parent=Process.GetProcessById(basic.ParentPid.ToInt32());var started=parent.StartTime.ToUniversalTime();
   using var identity=WindowsIdentity.GetCurrent();var auth=AuthenticationId(identity.Token);
   if(!OpenProcessToken(parent.Handle,8,out var parentToken))throw new Exception("Owner unavailable.");
   try{using var parentIdentity=new WindowsIdentity(parentToken);if(parent.SessionId!=self.SessionId||parentIdentity.User?.Value!=identity.User?.Value||AuthenticationId(parentToken)!=auth)throw new Exception("Owner session mismatch.");}finally{CloseHandle(parentToken);}
   bool Alive(){try{return !parent.HasExited&&parent.StartTime.ToUniversalTime()==started&&parent.SessionId==self.SessionId;}catch{return false;}}
   // Console.In is a synchronized TextReader; ReadLineAsync can synchronously
   // block. Always read on a worker so idle stdin cannot stop lease/parent checks.
   var first=Task.Run(()=>Console.In.ReadLine());if(!first.Wait(5000)||first.Result==null)throw new Exception("Arm timed out.");
   using var initial=JsonDocument.Parse(first.Result);var arm=initial.RootElement;lastId=arm.GetProperty("id").GetInt32();
   int duration=arm.GetProperty("leaseMs").GetInt32();
   if(arm.GetProperty("action").GetString()!="arm"||arm.GetProperty("ownerPid").GetInt32()!=parent.Id||duration<1000||duration>60000||!Alive())throw new Exception("Invalid recovery owner.");
   string directory=arm.GetProperty("markerDirectory").GetString()!;if(!Path.IsPathFullyQualified(directory))throw new Exception("Private recovery directory required.");
   lease=new Mutex(false,$"Local\\Capri.Cursor.{identity.User!.Value}.{auth}.{self.SessionId}");
   try{owned=lease.WaitOne(0);}catch(AbandonedMutexException){owned=true;dirty=true;}
   if(!owned){Reply(lastId,false,"owner-conflict");return 2;}
   Directory.CreateDirectory(directory);marker=Path.Combine(directory,$"cursor-{auth}-{self.SessionId}.recovery");
   bool recovered=File.Exists(marker)||dirty;
   if(recovered){dirty=true;if(!Restore()){Reply(lastId,false,"host-unavailable",recoveryRequired:true);return 3;}File.Delete(marker);dirty=false;}
   string owner=$"{parent.Id}:{started.Ticks}:{auth}:{self.SessionId}:{Guid.NewGuid():N}";
   long expiry=Environment.TickCount64+duration;string? suspendedReason=null;
   string? ObserveSafety(){
    var reason=SafetyReason();
    if(dirty&&reason!=null){
     if(!Restore())throw new Exception("Cursor suspension recovery failed.");
     File.Delete(marker);dirty=false;suspendedReason=reason;
    }
    return reason??suspendedReason; // A restored session needs a fresh owner before resuming.
   }
   long WallExpiry()=>DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+Math.Max(0,expiry-Environment.TickCount64);
   Reply(lastId,true,expires:WallExpiry(),recovered:recovered);
   var line=Task.Run(()=>Console.In.ReadLine());
   while(true){
    // This is independent of the Node event loop, and late heartbeats never revive
    // an expired lease. The mutex remains held through restoration and cleanup.
    if(!Alive()||Environment.TickCount64>=expiry)break;
    ObserveSafety(); // Independent of Node: also detects accessibility changes while stdin is idle.
    if(!line.Wait(50))continue;var text=line.Result;if(text==null)break;
    if(text.Length>32768)throw new Exception("Cursor command too large.");
    using var document=JsonDocument.Parse(text);var request=document.RootElement;lastId=request.GetProperty("id").GetInt32();
    if(!Alive()||Environment.TickCount64>=expiry)break;
    if(request.GetProperty("ownerPid").GetInt32()!=parent.Id)throw new Exception("Owner changed.");
    var action=request.GetProperty("action").GetString();
    var suspension=ObserveSafety();
    if(action=="heartbeat"){
     expiry=Environment.TickCount64+duration;Reply(lastId,suspension==null,suspension,WallExpiry(),active:dirty);
    }else if(action=="apply"){
     if(suspension!=null){Reply(lastId,false,suspension,WallExpiry());}
     else{
      try{Apply(request,marker,owner,()=>Alive()&&Environment.TickCount64<expiry);dirty=true;Reply(lastId,true,expires:WallExpiry(),active:true);}
      catch(Exception error){
       // Includes failed loads and partial SetSystemCursor. Never report rollback
       // success unless SPI_SETCURSORS succeeded; retain the marker on failure.
       dirty=true;if(!File.Exists(marker))Marker(marker,owner);
       bool restored=Restore();if(restored){File.Delete(marker);dirty=false;}
       suspendedReason=(error as CursorSuspendedException)?.Reason;
       Reply(lastId,false,suspendedReason??"host-unavailable",WallExpiry(),recoveryRequired:!restored);
      }
     }
    }else if(action=="restore"||action=="close"){
     bool restored=!dirty||Restore();if(restored){File.Delete(marker);dirty=false;}
     Reply(lastId,restored,restored?null:"host-unavailable",WallExpiry(),recoveryRequired:!restored);
     if(action=="close")return restored?0:3;
    }else if(action=="status")Reply(lastId,suspension==null,suspension,expires:WallExpiry(),active:dirty);
    else throw new Exception("Unsupported cursor command.");
    line=Task.Run(()=>Console.In.ReadLine());
   }
   return 0;
  }catch{try{Reply(lastId,false,"host-unavailable",recoveryRequired:dirty);}catch{}return 1;}
  finally{
   if(owned){try{if(dirty&&Restore()){if(marker!=null)File.Delete(marker);dirty=false;}}catch{}finally{lease!.ReleaseMutex();}}
   lease?.Dispose();
  }
 }
}
