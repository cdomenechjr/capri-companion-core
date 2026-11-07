using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.IO;
using System.Windows.Automation;
class Program {
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
 delegate bool EnumProc(IntPtr hwnd, IntPtr param);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int command);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern uint SendInput(uint count,INPUT[] inputs,int size);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd,IntPtr hdc,uint flags);
 [StructLayout(LayoutKind.Sequential)] struct RECT {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] struct INPUT {public uint type;public INPUTUNION data;}
 [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {[FieldOffset(0)]public MOUSEINPUT mouse;[FieldOffset(0)]public KEYBDINPUT keyboard;}
 [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {public int dx,dy;public uint mouseData,dwFlags,time;public UIntPtr dwExtraInfo;}
 [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {public ushort wVk,wScan;public uint dwFlags,time;public UIntPtr dwExtraInfo;}
 static INPUT Key(char value,bool up)=>new INPUT{type=1,data=new INPUTUNION{keyboard=new KEYBDINPUT{wScan=value,dwFlags=(uint)(4|(up?2:0))}}};
 static IntPtr Window(JsonElement args){var hwnd=new IntPtr(args.GetProperty("windowId").GetInt64());if(!IsWindowVisible(hwnd))throw new Exception("The target window is no longer visible. Inspect the desktop again.");return hwnd;}
 static string Title(IntPtr hwnd){var text=new StringBuilder(1024);GetWindowText(hwnd,text,text.Capacity);return text.ToString();}
 static object Windows(){var windows=new List<object>();EnumWindows((hwnd,_)=>{var title=Title(hwnd);if(IsWindowVisible(hwnd)&&title.Length>0&&GetWindowRect(hwnd,out var r))windows.Add(new{windowId=hwnd.ToInt64(),title,x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top});return true;},IntPtr.Zero);return new{windows};}
 static object Inspect(IntPtr hwnd){if(!GetWindowRect(hwnd,out var r))throw new Exception("Window bounds unavailable.");int width=Math.Clamp(r.Right-r.Left,1,7680),height=Math.Clamp(r.Bottom-r.Top,1,4320);using var bmp=new Bitmap(width,height);using(var graphics=Graphics.FromImage(bmp)){var dc=graphics.GetHdc();bool ok;try{ok=PrintWindow(hwnd,dc,2);}finally{graphics.ReleaseHdc(dc);}if(!ok)graphics.CopyFromScreen(r.Left,r.Top,0,0,new Size(width,height));}var scale=Math.Min(1,1280.0/width);using var scaled=new Bitmap(bmp,new Size((int)(width*scale),(int)(height*scale)));using var stream=new MemoryStream();scaled.Save(stream,ImageFormat.Png);var nodes=new List<object>();try{var root=AutomationElement.FromHandle(hwnd);void Walk(AutomationElement node,int depth){if(depth>4||nodes.Count>=180)return;try{var current=node.Current;if(current.IsPassword)return;var bounds=current.BoundingRectangle;nodes.Add(new{name=current.Name,control=current.ControlType.ProgrammaticName,enabled=current.IsEnabled,x=bounds.X-r.Left,y=bounds.Y-r.Top,width=bounds.Width,height=bounds.Height});var child=TreeWalker.ControlViewWalker.GetFirstChild(node);while(child!=null&&nodes.Count<180){Walk(child,depth+1);child=TreeWalker.ControlViewWalker.GetNextSibling(child);}}catch{}}Walk(root,0);}catch{}return new{windowId=hwnd.ToInt64(),title=Title(hwnd),width,height,screenshotScale=scale,screenshot="data:image/png;base64,"+Convert.ToBase64String(stream.ToArray()),elements=nodes,untrusted=true};}
 internal static void TypeText(string text){if(text.Length>8000)throw new Exception("Text is too long.");foreach(char c in text){var input=new[]{Key(c,false),Key(c,true)};if(SendInput(2,input,Marshal.SizeOf<INPUT>())!=2)throw new Exception("Keyboard input was blocked.");}}
 [STAThread] static int Main(){try{System.Windows.Forms.Application.SetHighDpiMode(System.Windows.Forms.HighDpiMode.PerMonitorV2);if(Environment.GetCommandLineArgs().Contains("--cursor-watchdog"))return CursorWatchdog.Run();if(Environment.GetCommandLineArgs().Contains("--presence"))return PresenceMonitor.Run();var request=JsonDocument.Parse(Console.In.ReadToEnd()).RootElement;var action=request.GetProperty("action").GetString();var args=request.GetProperty("args");object result;
 if(action=="security")result=Security.Run(args);
 else if(action=="cursor-status")result=CursorWatchdog.Status();
 else if(action=="activity")result=AgencyWindows.Activity();
 else if(action=="windows")result=Windows();
 else if(action=="launch"){var app=args.GetProperty("app").GetString()!;if(!(new[]{"notepad.exe","calc.exe","explorer.exe"}.Contains(app)||(args.TryGetProperty("full",out var full)&&full.GetBoolean()&&Path.IsPathFullyQualified(app)&&app.EndsWith(".exe",StringComparison.OrdinalIgnoreCase))))throw new Exception("Application is not allowlisted.");var process=Process.Start(new ProcessStartInfo(app){UseShellExecute=true});result=new{launched=true,processId=process?.Id};}
 else {var hwnd=Window(args);if(action=="inspect")result=AgencyWindows.Inspect(hwnd);else if(new[]{"click","type","key","invoke","scroll","drag","window"}.Contains(action!))result=AgencyWindows.Interact(action!,args);else{ShowWindow(hwnd,9);if(!SetForegroundWindow(hwnd))throw new Exception("Could not focus the target. Activate it and retry.");Thread.Sleep(120);if(action=="click"){GetWindowRect(hwnd,out var r);int x=args.GetProperty("x").GetInt32(),y=args.GetProperty("y").GetInt32();if(x<0||y<0||x>=r.Right-r.Left||y>=r.Bottom-r.Top)throw new Exception("Click is outside the target window.");SetCursorPos(r.Left+x,r.Top+y);var inputs=new[]{new INPUT{type=0,data=new INPUTUNION{mouse=new MOUSEINPUT{dwFlags=2}}},new INPUT{type=0,data=new INPUTUNION{mouse=new MOUSEINPUT{dwFlags=4}}}};if(SendInput(2,inputs,Marshal.SizeOf<INPUT>())!=2)throw new Exception("Mouse input was blocked.");}
 else if(action=="type"){var text=args.GetProperty("text").GetString()!;if(text.Length>8000)throw new Exception("Text is too long.");foreach(char c in text){var input=new[]{Key(c,false),Key(c,true)};if(SendInput(2,input,Marshal.SizeOf<INPUT>())!=2)throw new Exception("Keyboard input was blocked.");}}
 else if(action=="key"){var key=args.GetProperty("text").GetString()!.ToUpperInvariant();var keys=new Dictionary<string,string>{{"ENTER","{ENTER}"},{"TAB","{TAB}"},{"ESCAPE","{ESC}"},{"BACKSPACE","{BACKSPACE}"},{"DELETE","{DELETE}"},{"CTRL+A","^a"},{"CTRL+C","^c"},{"CTRL+V","^v"},{"CTRL+S","^s"},{"CTRL+Z","^z"},{"UP","{UP}"},{"DOWN","{DOWN}"},{"LEFT","{LEFT}"},{"RIGHT","{RIGHT}"}};if(!keys.TryGetValue(key,out var sequence))throw new Exception("Unsupported key combination.");System.Windows.Forms.SendKeys.SendWait(sequence);}
 else throw new Exception("Unsupported desktop action.");result=new{performed=true,windowId=hwnd.ToInt64(),title=Title(hwnd),note="Input was delivered; inspect the window to verify the result."};}}
 Console.Write(JsonSerializer.Serialize(result));return 0;}catch(Exception error){Console.Write(JsonSerializer.Serialize(new{error=error.Message}));return 1;}}
}
