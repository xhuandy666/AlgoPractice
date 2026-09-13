import path from 'node:path';

// Compile this authored helper once with the Windows .NET Framework compiler during setup/build.
// Runtime launches execute the packaged helper directly; no PowerShell or dynamic compilation.
// P/Invoke execution is covered by Windows-only tests; macOS compilation cannot validate Win32 ABI.
export const WINDOWS_JOB_SOURCE = String.raw`
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class APJobLauncher {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI {
  public int cb;public string reserved;public string desktop;public string title;
  public int x,y,xSize,ySize,xCount,yCount,fill,flags;public short show,reserved2;public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct SIX {public SI startup;public IntPtr attributes;}
 [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr process,thread;public uint pid,tid;}
 [StructLayout(LayoutKind.Sequential)] struct BASIC {
  public long processTime,jobTime;public uint flags;public UIntPtr minWorking,maxWorking;public uint active;public UIntPtr affinity;public uint priority,schedule;
 }
 [StructLayout(LayoutKind.Sequential)] struct IO {public ulong r,w,o,rb,wb,ob;}
 [StructLayout(LayoutKind.Sequential)] struct LIMITS {public BASIC basic;public IO io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref LIMITS limits,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,UIntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string exe,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX startup,out PI process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int number);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint timeout);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static int Main(string[] args) {
  try {
   uint ownerPid;
   if(args.Length!=3 || !UInt32.TryParse(args[2],out ownerPid) || ownerPid==0)throw new ArgumentException("Expected executable, quoted command, and owner PID");
   return Run(args[0],args[1],ownerPid);
  } catch(Exception error) {Console.Error.WriteLine("ALGOPRACTICE_LAUNCHER_ERROR: "+error.GetBaseException().Message);return 125;}
 }
 static void Check(bool value) {if(!value)throw new Win32Exception(Marshal.GetLastWin32Error());}
 public static int Run(string executable,string command,uint ownerPid) {
  IntPtr job=IntPtr.Zero,owner=IntPtr.Zero,attributes=IntPtr.Zero,jobList=IntPtr.Zero,handles=IntPtr.Zero;bool initialized=false;PI child=new PI();
  try {
   owner=OpenProcess(0x00100000,false,ownerPid);Check(owner!=IntPtr.Zero);
   job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
   LIMITS limits=new LIMITS();limits.basic.flags=0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; never allow breakaway.
   Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(LIMITS))));
   IntPtr bytes=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref bytes);Check(bytes!=IntPtr.Zero);
   attributes=Marshal.AllocHGlobal(bytes);Check(InitializeProcThreadAttributeList(attributes,2,0,ref bytes));initialized=true;
   jobList=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobList,job);
   // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns the Job at CreateProcess time, avoiding spawn-then-assign races.
   Check(UpdateProcThreadAttribute(attributes,0,new UIntPtr(0x0002000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
   IntPtr[] std={GetStdHandle(-10),GetStdHandle(-11),GetStdHandle(-12)};
   handles=Marshal.AllocHGlobal(IntPtr.Size*3);
   for(int i=0;i<3;i++){Check(std[i]!=IntPtr.Zero && std[i]!=new IntPtr(-1));Check(SetHandleInformation(std[i],1,1));Marshal.WriteIntPtr(handles,IntPtr.Size*i,std[i]);}
   // PROC_THREAD_ATTRIBUTE_HANDLE_LIST: only stdin/out/err are inherited, never the Job handle.
   Check(UpdateProcThreadAttribute(attributes,0,new UIntPtr(0x00020002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
   SIX startup=new SIX();startup.startup.cb=Marshal.SizeOf(typeof(SIX));startup.startup.flags=0x100;startup.startup.input=std[0];startup.startup.output=std[1];startup.startup.error=std[2];startup.attributes=attributes;
   Check(CreateProcessW(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,null,ref startup,out child));
   Check(ResumeThread(child.thread)!=0xffffffff);
   uint wait=WaitForMultipleObjects(2,new IntPtr[]{child.process,owner},false,0xffffffff);
   if(wait==1)return 125; // Owner died: finally terminates the Job and every remaining associated descendant.
   Check(wait==0);uint code;Check(GetExitCodeProcess(child.process,out code));return unchecked((int)code);
  } finally {
   if(job!=IntPtr.Zero){TerminateJobObject(job,125);CloseHandle(job);}
   if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);if(child.process!=IntPtr.Zero)CloseHandle(child.process);
   if(owner!=IntPtr.Zero)CloseHandle(owner);
   if(initialized)DeleteProcThreadAttributeList(attributes);
   if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);
  }
 }
}
`;

export function quoteWindowsArgument(value: string): string {
  if (value.includes('\0')) throw new Error('Process argument contains NUL');
  let out = '"', slashes = 0;
  for (const character of value) {
    if (character === '\\') { slashes++; continue; }
    if (character === '"') out += '\\'.repeat(slashes * 2 + 1) + '"';
    else out += '\\'.repeat(slashes) + character;
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}
let configuredHelperPath: string | undefined;
export function setWindowsJobHelperPath(executable: string): void {
  if (!path.isAbsolute(executable)) throw new Error('Windows process helper path must be absolute');
  configuredHelperPath = executable;
}
export function windowsJobCommand(executable: string, args: string[], ownerPid = process.pid): { executable: string; args: string[] } {
  const helper = configuredHelperPath ?? path.join(process.cwd(), '.runtime-tools', 'windows-job-helper.exe');
  const command = [executable, ...args].map(quoteWindowsArgument).join(' ');
  const helperArgs = [executable, command, String(ownerPid)];
  if ([helper, ...helperArgs].map(quoteWindowsArgument).join(' ').length > 32766) throw new Error('Windows launcher command exceeds the supported command-line limit');
  return { executable: helper, args: helperArgs };
}
