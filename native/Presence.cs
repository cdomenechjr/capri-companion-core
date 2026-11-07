using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal static class PresenceMonitor {
 [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] struct LastInput {public uint Size,Time;}
 delegate bool Visit(IntPtr hwnd,IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumWindows(Visit callback,IntPtr data);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder text,int count);
 [DllImport("user32.dll",EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr hwnd,int index);
 [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput input);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out Rect rect,int count);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out int value,int count);
 [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
 record Window(long id,object rect,string path,bool eligible);
 static (Window?,Rect) Inspect(IntPtr hwnd,uint owner){
  var r=new Rect();if(hwnd==IntPtr.Zero||!IsWindowVisible(hwnd)||IsIconic(hwnd))return (null,r);
  GetWindowThreadProcessId(hwnd,out uint pid);if(pid==owner||(GetWindowLong(hwnd,-20)&0x20)!=0)return (null,r);
  var kind=new StringBuilder(128);GetClassName(hwnd,kind,128);if(new[]{"Progman","WorkerW","Shell_TrayWnd","Shell_SecondaryTrayWnd","#32768","tooltips_class32"}.Contains(kind.ToString()))return (null,r);
  DwmGetWindowAttribute(hwnd,14,out int cloaked,4);if(cloaked!=0)return (null,r);
  if(DwmGetWindowAttribute(hwnd,9,out r,16)!=0&&!GetWindowRect(hwnd,out r))return (null,r);
  int width=r.Right-r.Left,height=r.Bottom-r.Top;if(width<1||height<1)return (null,r);
  string executable="";try{using var p=Process.GetProcessById((int)pid);executable=p.MainModule?.FileName??"";}catch{}
  var area=System.Windows.Forms.Screen.FromHandle(hwnd).Bounds;
  bool full=r.Left<=area.Left+2&&r.Top<=area.Top+2&&r.Right>=area.Right-2&&r.Bottom>=area.Bottom-2;
  bool eligible=width>=120&&height>=60&&!IsZoomed(hwnd)&&!full&&(GetWindowLong(hwnd,-20)&0x80)==0;
  return (new Window(hwnd.ToInt64(),new{x=r.Left,y=r.Top,width,height},executable,eligible),r);
 }
 internal static int Run(){
  uint owner=0;try{var config=JsonDocument.Parse(Console.ReadLine()??"{}");owner=config.RootElement.GetProperty("ownerPid").GetUInt32();}catch{return 1;}
  _=Task.Run(()=>{while(Console.ReadLine()!=null){}Environment.Exit(0);});
  while(true){try{
   var foregroundHandle=GetForegroundWindow();GetWindowThreadProcessId(foregroundHandle,out uint foregroundPid);var (foreground,r)=Inspect(foregroundHandle,owner);var area=System.Windows.Forms.Screen.FromHandle(foregroundHandle).Bounds;
   bool fullscreen=foreground!=null&&r.Left<=area.Left+2&&r.Top<=area.Top+2&&r.Right>=area.Right-2&&r.Bottom>=area.Bottom-2;
   var windows=new List<Window>();EnumWindows((hwnd,_)=>{if(windows.Count>=200)return false;var (item,_)=Inspect(hwnd,owner);if(item!=null)windows.Add(item);return true;},IntPtr.Zero);
   var input=new LastInput{Size=(uint)Marshal.SizeOf<LastInput>()};GetLastInputInfo(ref input);SHQueryUserNotificationState(out int status);
   Console.WriteLine(JsonSerializer.Serialize(new{foreground,own=foregroundPid==owner,windows,idleMs=(uint)((uint)Environment.TickCount-input.Time),fullscreen,exclusive=status==3,locked=status==1}));
  }catch{Console.WriteLine("{\"error\":\"Desktop detection unavailable\",\"windows\":[],\"idleMs\":0,\"fullscreen\":false,\"exclusive\":false,\"locked\":false}");}Thread.Sleep(250);}
 }
}
