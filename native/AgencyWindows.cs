using System.Diagnostics;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;

static class AgencyWindows {
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int count);
 [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] struct LastInput {public uint size,tick;}
 static uint InputTick(){var info=new LastInput{size=(uint)Marshal.SizeOf<LastInput>()};GetLastInputInfo(ref info);return info.tick;}
 public static object Activity()=>new{lastInputTick=InputTick(),foregroundWindow=GetForegroundWindow().ToInt64()};
 static string Title(IntPtr h){var text=new StringBuilder(1024);GetWindowText(h,text,text.Capacity);return text.ToString();}
 static string Id(AutomationElement e)=>string.Join(".",e.GetRuntimeId());
 static AutomationElement? Find(IntPtr h,string? id){if(string.IsNullOrEmpty(id))return null;var root=AutomationElement.FromHandle(h);var nodes=root.FindAll(TreeScope.Descendants,Condition.TrueCondition);for(int i=0;i<Math.Min(nodes.Count,4000);i++)try{if(Id(nodes[i])==id)return nodes[i];}catch{}throw new Exception("Accessibility element changed. Inspect again.");}
 public static object Inspect(IntPtr h){
  if(!IsWindowVisible(h)||!GetWindowRect(h,out var r))throw new Exception("Window is unavailable.");GetWindowThreadProcessId(h,out var pid);var nodes=new List<object>();bool password=false;
  try{password=AutomationElement.FocusedElement?.Current.IsPassword??false;}catch{}
  try{var root=AutomationElement.FromHandle(h);void Walk(AutomationElement e,int depth){if(depth>20||nodes.Count>=250)return;try{var c=e.Current;if(c.IsPassword)return;var b=c.BoundingRectangle;var patterns=e.GetSupportedPatterns().Select(p=>p.ProgrammaticName).ToArray();nodes.Add(new{id=Id(e),name=c.Name,control=c.ControlType.ProgrammaticName,enabled=c.IsEnabled,offscreen=c.IsOffscreen,x=double.IsFinite(b.X)?b.X-r.Left:0,y=double.IsFinite(b.Y)?b.Y-r.Top:0,width=double.IsFinite(b.Width)?b.Width:0,height=double.IsFinite(b.Height)?b.Height:0,patterns});var child=TreeWalker.ControlViewWalker.GetFirstChild(e);while(child!=null&&nodes.Count<250){Walk(child,depth+1);child=TreeWalker.ControlViewWalker.GetNextSibling(child);}}catch{}}Walk(root,0);}catch{}
  string? screenshot=null;double scale=1;int width=Math.Clamp(r.Right-r.Left,1,7680),height=Math.Clamp(r.Bottom-r.Top,1,4320);
  if(!password){using var bmp=new Bitmap(width,height);using(var g=Graphics.FromImage(bmp)){var dc=g.GetHdc();bool ok;try{ok=PrintWindow(h,dc,2);}finally{g.ReleaseHdc(dc);}if(!ok)g.CopyFromScreen(r.Left,r.Top,0,0,new Size(width,height));}scale=Math.Min(1,1280.0/width);using var scaled=new Bitmap(bmp,new Size(Math.Max(1,(int)(width*scale)),Math.Max(1,(int)(height*scale))));using var stream=new MemoryStream();scaled.Save(stream,ImageFormat.Png);screenshot="data:image/png;base64,"+Convert.ToBase64String(stream.ToArray());}
  return new{windowId=h.ToInt64(),processId=pid,title=Title(h),width,height,screenshotScale=scale,screenshot,elements=nodes,passwordFocused=password,lastInputTick=InputTick(),untrusted=true};
 }
 public static object Interact(string action,JsonElement args){
  var h=new IntPtr(args.GetProperty("windowId").GetInt64());if(!IsWindowVisible(h)||!GetWindowRect(h,out var r))throw new Exception("Target window disappeared.");GetWindowThreadProcessId(h,out var pid);if(args.TryGetProperty("expectedProcessId",out var expected)&&expected.GetUInt32()!=pid)throw new Exception("Window owner changed. Inspect again.");
  if(action=="window"){var command=args.GetProperty("text").GetString();ShowWindow(h,command=="minimize"?6:command=="maximize"?3:9);return new{performed=true,windowId=h.ToInt64()};}
  ShowWindow(h,9);if(!SetForegroundWindow(h))throw new Exception("Could not focus the target window.");Thread.Sleep(100);if(GetForegroundWindow()!=h)throw new Exception("Focus changed. Input was withheld.");
  if(AutomationElement.FocusedElement?.Current.IsPassword==true)throw new Exception("Enter credentials manually.");
  var element=Find(h,args.TryGetProperty("elementId",out var e)?e.GetString():null);if(element?.Current.IsPassword==true)throw new Exception("Password fields require manual input.");
  if(action=="invoke"){if(element==null||!element.TryGetCurrentPattern(InvokePattern.Pattern,out var p))throw new Exception("Element does not support Invoke.");((InvokePattern)p).Invoke();}
  else if(action=="type"&&element!=null){if(!element.TryGetCurrentPattern(ValuePattern.Pattern,out var p)||((ValuePattern)p).Current.IsReadOnly)throw new Exception("Element does not support text entry.");((ValuePattern)p).SetValue(args.GetProperty("text").GetString()!);}
  else if(action=="type"){Program.TypeText(args.GetProperty("text").GetString()!);}
  else if(action=="scroll"){SetCursorPos(r.Left+(r.Right-r.Left)/2,r.Top+(r.Bottom-r.Top)/2);int amount=args.TryGetProperty("amount",out var a)?Math.Clamp(a.GetInt32(),-2400,2400):-600;mouse_event(0x0800,0,0,unchecked((uint)amount),UIntPtr.Zero);}
  else if(action=="click"||action=="drag"){
   int x,y;if(element!=null){var b=element.Current.BoundingRectangle;x=(int)(b.Left+b.Width/2)-r.Left;y=(int)(b.Top+b.Height/2)-r.Top;}else{x=args.GetProperty("x").GetInt32();y=args.GetProperty("y").GetInt32();}if(x<0||y<0||x>=r.Right-r.Left||y>=r.Bottom-r.Top)throw new Exception("Input lies outside target window.");SetCursorPos(r.Left+x,r.Top+y);mouse_event(2,0,0,0,UIntPtr.Zero);try{if(action=="drag"){var tx=args.GetProperty("toX").GetInt32();var ty=args.GetProperty("toY").GetInt32();if(tx<0||ty<0||tx>=r.Right-r.Left||ty>=r.Bottom-r.Top)throw new Exception("Drag destination lies outside the target.");for(int i=1;i<=10;i++){SetCursorPos(r.Left+x+(tx-x)*i/10,r.Top+y+(ty-y)*i/10);Thread.Sleep(15);}}}finally{mouse_event(4,0,0,0,UIntPtr.Zero);}}
  else if(action=="key"){var key=args.GetProperty("text").GetString()!.ToUpperInvariant();var keys=new Dictionary<string,string>{{"ENTER","{ENTER}"},{"TAB","{TAB}"},{"ESCAPE","{ESC}"},{"BACKSPACE","{BACKSPACE}"},{"DELETE","{DELETE}"},{"CTRL+A","^a"},{"CTRL+C","^c"},{"CTRL+V","^v"},{"CTRL+S","^s"},{"CTRL+Z","^z"},{"UP","{UP}"},{"DOWN","{DOWN}"},{"LEFT","{LEFT}"},{"RIGHT","{RIGHT}"},{"HOME","{HOME}"},{"END","{END}"}};if(!keys.TryGetValue(key,out var sequence))throw new Exception("Unsupported key.");System.Windows.Forms.SendKeys.SendWait(sequence);}
  else throw new Exception("Use an accessibility element for text input.");
  return new{performed=true,windowId=h.ToInt64(),lastInputTick=InputTick()};
 }
}
