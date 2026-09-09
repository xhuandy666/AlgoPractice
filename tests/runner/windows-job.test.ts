import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,rm,stat,readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from '../../src/runner/process.ts';
const windows={skip:process.platform!=='win32'?'Requires real Windows 10/11 x64; Win32 ABI and Job semantics are unverified on macOS':false};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const exists=(file:string)=>stat(file).then(()=>true,()=>false);
async function ready(file:string){const start=Date.now();while(!(await exists(file))){if(Date.now()-start>15000)throw new Error('Child never reported readiness');await sleep(25);}}
function descendantSource(marker:string,readyFile:string,exitParent=false){
 const child=`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived'),2500)`;
 return `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore',detached:true});require('node:fs').writeFileSync(${JSON.stringify(readyFile)},String(c.pid));${exitParent?'process.exit(0)':'setInterval(()=>{},1000)'}`;
}
test('Windows native Job launcher executes argv, unicode, stdin, and both output streams',windows,async()=>{
 const args=['','two words','a"b','C:\\中文 path\\','🌳'];const source="let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(1),input}));console.error('stderr ✓')})";
 const r=await runProcess(process.execPath,['-e',source,...args],{cwd:os.tmpdir(),stdin:'输入\n',timeoutMs:20000,outputLimitBytes:16384});assert.equal(r.reason,undefined,JSON.stringify(r));assert.equal(r.code,0);assert.deepEqual(JSON.parse(r.stdout),{args,input:'输入\n'});assert.match(r.stderr,/stderr ✓/);
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
