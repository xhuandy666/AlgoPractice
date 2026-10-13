import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';

// Compile this authored helper once with the Windows .NET Framework compiler during setup/build.
// Runtime launches execute the packaged helper directly; no PowerShell or dynamic compilation.
// P/Invoke execution is covered by Windows-only tests; macOS compilation cannot validate Win32 ABI.
export const WINDOWS_JOB_SOURCE = String.raw`
using System;
using System.Text;
using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;
public static class APJobLauncher {
 class JobTerminationException:Exception {public JobTerminationException(Exception cause):base("Job termination did not complete: "+cause.Message,cause){}}
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
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {public long user,kernel,periodUser,periodKernel;public uint faults,total,active,terminated;}
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
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out ACCOUNTING info,uint size,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static int Main(string[] args) {
  try {
   uint ownerPid;
   if((args.Length!=3 && args.Length!=4) || !UInt32.TryParse(args[2],out ownerPid) || ownerPid==0)throw new ArgumentException("Expected executable, quoted command, owner PID, and optional private control pipe");
   return Run(args[0],args[1],ownerPid,args.Length==4?args[3]:null);
  } catch(Exception error) {Console.Error.WriteLine((error is JobTerminationException?"ALGOPRACTICE_TERMINATION_ERROR: ":"ALGOPRACTICE_LAUNCHER_ERROR: ")+error.Message);return 125;}
 }
 static void Check(bool value) {if(!value)throw new Win32Exception(Marshal.GetLastWin32Error());}
 static void TerminateAndDrain(IntPtr job,ref PI child) {
  Stopwatch deadline=Stopwatch.StartNew();
  Check(TerminateJobObject(job,125));
  try {
   // TerminateProcess is asynchronous. Waiting for the launcher itself is not a user-process barrier.
   if(child.process!=IntPtr.Zero && WaitForSingleObject(child.process,1000)!=0)throw new TimeoutException("The main process did not exit within the teardown deadline");
  } finally {
   if(child.thread!=IntPtr.Zero){CloseHandle(child.thread);child.thread=IntPtr.Zero;}
   if(child.process!=IntPtr.Zero){CloseHandle(child.process);child.process=IntPtr.Zero;}
  }
  // ActiveProcesses falls to zero only after terminated processes exit and process references release.
  // Release our own primary process handle first, then wait for the exact Job, not a PID snapshot.
  for(;;){
   ACCOUNTING info;Check(QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero));
   if(info.active==0)return;
   if(deadline.ElapsedMilliseconds>=1000)throw new TimeoutException("Associated processes did not drain within the teardown deadline");
   Thread.Sleep(5);
  }
 }
 public static int Run(string executable,string command,uint ownerPid,string pipeName) {
  IntPtr job=IntPtr.Zero,owner=IntPtr.Zero,attributes=IntPtr.Zero,jobList=IntPtr.Zero,handles=IntPtr.Zero;bool initialized=false;PI child=new PI();
  NamedPipeClientStream control=null;ManualResetEvent stop=new ManualResetEvent(false);
  try {
   owner=OpenProcess(0x00100000,false,ownerPid);Check(owner!=IntPtr.Zero);
   if(pipeName!=null){
    if(!pipeName.StartsWith("algopractice-job-",StringComparison.Ordinal) || pipeName.Length>160)throw new ArgumentException("Invalid private control pipe");
    // Duplex control must use an overlapped handle: the watcher keeps a read pending
    // while normal completion writes the final ACK. A synchronous handle serializes
    // that write behind the blocked read, making successful commands wait for timeout.
    // .NET's ReadByte/WriteByte wrappers use separate overlapped operations on this handle.
    control=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.Asynchronous);control.Connect(1000);
    Thread watcher=new Thread(delegate(){try{control.ReadByte();}catch{}finally{try{stop.Set();}catch(ObjectDisposedException){}}});watcher.IsBackground=true;watcher.Start();
   }
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
   if(stop.WaitOne(0))return 125;
   Check(CreateProcessW(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,null,ref startup,out child));
   Check(ResumeThread(child.thread)!=0xffffffff);
   uint wait=WaitForMultipleObjects(3,new IntPtr[]{child.process,owner,stop.SafeWaitHandle.DangerousGetHandle()},false,0xffffffff);
   if(wait==1)return 125; // Owner died: finally terminates the Job and every remaining associated descendant.
   if(wait==2)return 125; // Host requested timeout/cancel/output-limit over the private pipe, not user stdin.
   Check(wait==0);uint code;Check(GetExitCodeProcess(child.process,out code));return unchecked((int)code);
  } finally {
   Exception failure=null;
   try{if(job!=IntPtr.Zero)TerminateAndDrain(job,ref child);}catch(Exception error){failure=error;}
   finally{
    if(job!=IntPtr.Zero)CloseHandle(job); // KILL_ON_JOB_CLOSE remains the fail-closed fallback.
    if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);if(child.process!=IntPtr.Zero)CloseHandle(child.process);
    if(owner!=IntPtr.Zero)CloseHandle(owner);
    if(initialized)DeleteProcThreadAttributeList(attributes);
    if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);
    // This host-only acknowledgement cannot be displaced or forged by user stdout/stderr.
    if(control!=null){try{control.WriteByte(failure==null?(byte)0:(byte)1);control.Flush();}catch{}control.Dispose();}stop.Dispose();
   }
   if(failure!=null)throw new JobTerminationException(failure);
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
export function windowsJobCommand(executable: string, args: string[], ownerPid = process.pid, controlPipe?: string): { executable: string; args: string[] } {
  const helper = configuredHelperPath ?? path.join(process.cwd(), '.runtime-tools', 'windows-job-helper.exe');
  const command = [executable, ...args].map(quoteWindowsArgument).join(' ');
  const helperArgs = [executable, command, String(ownerPid), ...(controlPipe ? [controlPipe] : [])];
  if ([helper, ...helperArgs].map(quoteWindowsArgument).join(' ').length > 32766) throw new Error('Windows launcher command exceeds the supported command-line limit');
  return { executable: helper, args: helperArgs };
}

/** Host-only per-launch control. The user process inherits only stdin/stdout/stderr, never this pipe. */
export async function createWindowsJobControl(endpoint?: string): Promise<{ name: string; drained: Promise<boolean>; stop(): void; close(): Promise<void> }> {
  const name = `algopractice-job-${process.pid}-${randomUUID()}`;
  let connection: Socket | undefined, stopped = false;
  let settle: (drained: boolean) => void;
  const drained = new Promise<boolean>(resolve => { settle = resolve; });
  const server = createServer(socket => {
    if (connection) { socket.destroy(); return; }
    connection = socket;
    socket.once('data', data => settle(data.length === 1 && data[0] === 0));
    socket.once('close', () => settle(false));
    socket.on('error', () => settle(false));
    if (stopped) socket.end('stop');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // A local socket endpoint lets the identical host protocol run in non-Windows unit tests.
    server.listen(endpoint ?? `\\\\.\\pipe\\${name}`, () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', () => {});
  return {
    name,
    drained,
    stop() { if (!stopped) { stopped = true; connection?.end('stop'); } },
    close() { connection?.destroy(); return new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
