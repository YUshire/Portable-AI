Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PortableNative {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct SI {
    public uint cb; public string reserved, desktop, title; public uint x,y,xsize,ysize,xchars,ychars,fill,flags; public ushort show, reservedSize; public IntPtr reservedData, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PI {public IntPtr process,thread;public uint pid,tid;}
  [StructLayout(LayoutKind.Sequential)] struct Basic {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
  [StructLayout(LayoutKind.Sequential)] struct IO {public ulong a,b,c,d,e,f;}
  [StructLayout(LayoutKind.Sequential)] struct Limits {public Basic basic;public IO io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref Limits limits,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("cfgmgr32.dll",CharSet=CharSet.Unicode)] public static extern uint CM_Locate_DevNodeW(out uint node,string id,uint flags);
  [DllImport("cfgmgr32.dll")] public static extern uint CM_Get_Parent(out uint parent,uint child,uint flags);
  [DllImport("cfgmgr32.dll",CharSet=CharSet.Unicode)] public static extern uint CM_Get_Device_IDW(uint node,StringBuilder id,uint size,uint flags);
  [DllImport("cfgmgr32.dll",CharSet=CharSet.Unicode)] public static extern uint CM_Request_Device_EjectW(uint node,out int veto,StringBuilder name,uint size,uint flags);
  public static string Quote(string value) {
    StringBuilder result=new StringBuilder("\"");int slashes=0;
    foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='"'){result.Append('\\',slashes*2+1);result.Append(c);}else{result.Append('\\',slashes);result.Append(c);}slashes=0;}
    result.Append('\\',slashes*2);result.Append('"');return result.ToString();
  }
  public static int Guard(string app,string command,string cwd) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception();
    PI pi=new PI();bool created=false;
    try {
      Limits l=new Limits();l.basic.flags=0x2800; // Kill-on-close; allow only explicit helper breakaway.
      if(!SetInformationJobObject(job,9,ref l,(uint)Marshal.SizeOf(typeof(Limits))))throw new Win32Exception();
      SI si=new SI();si.cb=(uint)Marshal.SizeOf(typeof(SI));si.flags=0x100;si.input=GetStdHandle(-10);si.output=GetStdHandle(-11);si.error=GetStdHandle(-12);
      if(!CreateProcess(app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,4,IntPtr.Zero,cwd,ref si,out pi))throw new Win32Exception();created=true;
      if(!AssignProcessToJobObject(job,pi.process))throw new Win32Exception();
      if(ResumeThread(pi.thread)==0xffffffff)throw new Win32Exception();
      WaitForSingleObject(pi.process,0xffffffff);uint code;GetExitCodeProcess(pi.process,out code);return (int)code;
    } catch {if(created)TerminateProcess(pi.process,1);throw;}
    finally {if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);CloseHandle(job);}
  }
  public static uint Detached(string app,string command,string cwd,bool guarded) {
    SI si=new SI();si.cb=(uint)Marshal.SizeOf(typeof(SI));PI pi;
    bool ok=CreateProcess(app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x09000000,IntPtr.Zero,cwd,ref si,out pi);
    if(!ok&&!guarded&&Marshal.GetLastWin32Error()==5)ok=CreateProcess(app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x08000000,IntPtr.Zero,cwd,ref si,out pi);
    if(!ok)throw new Win32Exception();uint pid=pi.pid;CloseHandle(pi.thread);CloseHandle(pi.process);return pid;
  }
}
'@
