import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtemp,rm,stat,readFile,copyFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from '../../src/runner/process.ts';
import { cleanupRunDirectory } from '../../src/runner/index.ts';
import { createWindowsJobControl,setWindowsJobHelperPath,windowsJobCommand } from '../../src/runner/windows-job.ts';
const windows={skip:process.platform!=='win32'?'Requires real Windows 10/11 x64; Win32 ABI and Job semantics are unverified on macOS':false};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const exists=(file:string)=>stat(file).then(()=>true,()=>false);
async function ready(file:string){const start=Date.now();while(!(await exists(file))){if(Date.now()-start>15000)throw new Error('Child never reported readiness');await sleep(25);}}
function descendantSource(marker:string,readyFile:string,exitParent=false){
 const child=`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived'),2500)`;
 return `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore',detached:true});require('node:fs').writeFileSync(${JSON.stringify(readyFile)},String(c.pid));${exitParent?'process.exit(0)':'setInterval(()=>{},1000)'}`;
}
for(const mode of ['stop-before-connect','normal-drain','missing-ack'] as const)test(`private Job control does not deadlock on ${mode}`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'ap-pipe-')),endpoint=process.platform==='win32'?undefined:path.join(root,'c.sock');
 const control=await createWindowsJobControl(endpoint);
 const socket=connect(endpoint??`\\\\.\\pipe\\${control.name}`);
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  if(mode==='stop-before-connect'){
   control.stop();
   socket.once('data',data=>{assert.equal(data.toString(),'stop');socket.end(Buffer.from([0]));});
  }else socket.once('connect',()=>{if(mode==='normal-drain')socket.end(Buffer.from([0]));else socket.destroy();});
  const drained=await Promise.race([control.drained,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Private Job control never completed')),1500);})]);
  assert.equal(drained,mode!=='missing-ack');
  await control.close();
 }finally{if(timer)clearTimeout(timer);socket.destroy();await control.close();await rm(root,{recursive:true,force:true});}
});
test('private Job control closes promptly even if the helper never connects',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'ap-pipe-')),control=await createWindowsJobControl(process.platform==='win32'?undefined:path.join(root,'c.sock'));
 try{control.stop();await control.close();}finally{await control.close();await rm(root,{recursive:true,force:true});}
});
test('Windows native Job launcher executes argv, unicode, stdin, and both output streams',windows,async()=>{
 const args=['','two words','a"b','C:\\中文 path\\','🌳'];const source="let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(1),input}));console.error('stderr ✓')})";
 const r=await runProcess(process.execPath,['-e',source,...args],{cwd:os.tmpdir(),stdin:'输入\n',timeoutMs:20000,outputLimitBytes:16384});assert.equal(r.reason,undefined,JSON.stringify(r));assert.equal(r.code,0);assert.deepEqual(JSON.parse(r.stdout),{args,input:'输入\n'});assert.match(r.stderr,/stderr ✓/);
});
test('Windows Job termination acknowledgement is independent of user diagnostic-looking stderr',windows,async()=>{
 const result=await runProcess(process.execPath,['-e',"console.error('ALGOPRACTICE_TERMINATION_ERROR: synthetic user text');process.exit(125)"],{cwd:os.tmpdir(),timeoutMs:20000,outputLimitBytes:4096});
 assert.equal(result.code,125);assert.equal(result.reason,undefined,JSON.stringify(result));assert.equal(result.terminationError,undefined);
});
test('Windows helper runs from packaged Unicode resources after the working directory changes',windows,async()=>{
 const originalCwd=process.cwd(),originalHelper=windowsJobCommand(process.execPath,[]).executable;
 const root=await mkdtemp(path.join(os.tmpdir(),'algopractice-win-resources-')),resources=path.join(root,'resources 题炼 🌳'),helper=path.join(resources,'windows-job-helper.exe');
 try{
  await mkdir(resources);await copyFile(originalHelper,helper);setWindowsJobHelperPath(helper);process.chdir(root);
  const r=await runProcess(process.execPath,['-e',"process.stdout.write('题炼 🌳');process.stderr.write('resources ✓')"],{cwd:root,timeoutMs:10000,outputLimitBytes:4096});
  assert.equal(r.reason,undefined,JSON.stringify(r));assert.equal(r.code,0);assert.equal(r.stdout,'题炼 🌳');assert.equal(r.stderr,'resources ✓');
  setWindowsJobHelperPath(path.join(resources,'missing-helper.exe'));
  const missing=await runProcess(process.execPath,['-e',''],{cwd:root,timeoutMs:10000,outputLimitBytes:4096});
  assert.equal(missing.reason,'spawn_error');assert.match(missing.stderr,/Windows process helper is unavailable/);
 }finally{process.chdir(originalCwd);setWindowsJobHelperPath(originalHelper);await rm(root,{recursive:true,force:true});}
});
for(const mode of ['cancellation','normal-parent-exit'] as const)test(`Windows Job removes detached descendants on ${mode}`,windows,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'algopractice-win-job-')),marker=path.join(root,'survived'),flag=path.join(root,'ready');const controller=new AbortController();
 try{
  const pending=runProcess(process.execPath,['-e',descendantSource(marker,flag,mode==='normal-parent-exit')],{cwd:root,timeoutMs:20000,outputLimitBytes:16384,signal:controller.signal});await ready(flag);if(mode==='cancellation')controller.abort();const r=await pending;assert.equal(r.reason,mode==='cancellation'?'cancelled':undefined,JSON.stringify(r));
  await sleep(3000);assert.equal(await exists(marker),false,'A descendant survived Job termination');
 }finally{controller.abort();if(await exists(flag)){const pid=Number(await readFile(flag,'utf8'));try{process.kill(pid,'SIGKILL');}catch{}}await rm(root,{recursive:true,force:true});}
});
test('Windows Job removes descendants after the owning Node process dies',windows,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'algopractice-win-owner-')),marker=path.join(root,'survived'),flag=path.join(root,'ready');
 const source=`import {runProcess} from ${JSON.stringify(new URL('../../src/runner/process.ts',import.meta.url).href)};await runProcess(process.execPath,['-e',${JSON.stringify(descendantSource(marker,flag))}],{cwd:${JSON.stringify(root)},timeoutMs:20000,outputLimitBytes:16384});`;
 const owner=spawn(process.execPath,['--input-type=module','-e',source],{stdio:'ignore',windowsHide:true});
 try{await ready(flag);owner.kill('SIGKILL');await new Promise<void>(r=>owner.once('close',()=>r()));await sleep(3000);assert.equal(await exists(marker),false,'A descendant survived owner death');}
 finally{owner.kill('SIGKILL');if(await exists(flag)){const pid=Number(await readFile(flag,'utf8'));try{process.kill(pid,'SIGKILL');}catch{}}await rm(root,{recursive:true,force:true});}
});

for(const mode of ['timeout','cancelled','output_limit'] as const)test(`Windows Job drains a running native binary before immediate directory cleanup on ${mode}`,windows,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'algopractice-win-binary-')),binary=path.join(root,'program.exe'),flag=path.join(root,'ready'),controller=new AbortController();
 await copyFile(process.execPath,binary);
 const source=`require('node:fs').writeFileSync(${JSON.stringify(flag)},String(process.pid));${mode==='output_limit'?"process.stdout.write('x'.repeat(8192));":''}setInterval(()=>{},1000)`;
 const pending=runProcess(binary,['-e',source],{cwd:root,timeoutMs:mode==='timeout'?2000:20000,outputLimitBytes:4096,signal:controller.signal});
 try{
  if(mode==='cancelled'){await ready(flag);controller.abort();}
  const result=await pending;
  assert.equal(result.reason,mode,JSON.stringify(result));assert.equal(result.terminationError,undefined,JSON.stringify(result));
  assert.equal(await exists(flag),true,'The actual copied binary must have executed before termination');
  // No sleep or global temp sweep: cleanup is attempted immediately after the Job barrier.
  await cleanupRunDirectory(root);
  await assert.rejects(stat(root),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
 }finally{controller.abort();await pending;await cleanupRunDirectory(root);}
});

test('Windows normal parent exit drains a detached descendant holding the native binary image',windows,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'algopractice-win-image-tree-')),binary=path.join(root,'program.exe'),flag=path.join(root,'descendant-ready');
 await copyFile(process.execPath,binary);
 const leaf=`require('node:fs').writeFileSync(${JSON.stringify(flag)},String(process.pid));setInterval(()=>{},1000)`;
 const source=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore',detached:true});const timer=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(flag)})){clearInterval(timer);process.exit(0);}},10)`;
 try{
  const result=await runProcess(binary,['-e',source],{cwd:root,timeoutMs:20000,outputLimitBytes:4096});
  assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.reason,undefined,JSON.stringify(result));assert.equal(result.terminationError,undefined);
  assert.equal(await exists(flag),true,'The detached descendant must have held program.exe before parent exit');
  await cleanupRunDirectory(root);
  await assert.rejects(stat(root),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
 }finally{await cleanupRunDirectory(root);}
});
