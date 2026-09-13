import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCode, defaultRuntimePath } from '../../src/runner/index.ts';
import type { Adapter, RunRequest, TestCase } from '../../src/runner/types.ts';

const reports: object[]=[];
const startedAt=new Date().toISOString();
const startDirectories=new Set((await readdir(os.tmpdir())).filter(n=>n.startsWith('algopractice-run-')));
interface Scenario {name:string; adapter:Adapter; cases:TestCase[]; python:string; java:string; expected?:string;}
const fn=(body:string)=>`class Solution:\n    def solve(self, x):\n        ${body.replaceAll('\n','\n        ')}`;
const javaFn=(signature:string,body:string)=>`class Solution { public ${signature} { ${body} } }`;
const scenarios:Scenario[]=[
 {name:'int32 arithmetic',adapter:{method:'solve',params:['int'],returns:'int'},cases:[{args:[-7],expected:-14}],python:fn('return x*2'),java:javaFn('int solve(int x)','return x*2;')},
 {name:'empty array',adapter:{method:'solve',params:[{array:'int'}],returns:'int'},cases:[{args:[[]],expected:0}],python:fn('return len(x)'),java:javaFn('int solve(int[] x)','return x.length;')},
 {name:'array mutation returning array',adapter:{method:'solve',params:[{array:'int'}],returns:{array:'int'}},cases:[{args:[[3,-1,3]],expected:[-1,3,3]}],python:fn('return sorted(x)'),java:javaFn('int[] solve(int[] x)','Arrays.sort(x);return x;')},
 {name:'two dimensional array',adapter:{method:'solve',params:[{array:{array:'int'}}],returns:'int'},cases:[{args:[[[1,2],[],[3]]],expected:6}],python:fn('return sum(sum(r) for r in x)'),java:javaFn('int solve(int[][] x)','int s=0;for(int[] r:x)for(int v:r)s+=v;return s;')},
 {name:'boolean',adapter:{method:'solve',params:['boolean'],returns:'boolean'},cases:[{args:[false],expected:true}],python:fn('return not x'),java:javaFn('boolean solve(boolean x)','return !x;')},
 {name:'unicode and JSON escaping',adapter:{method:'solve',params:['string'],returns:'string'},cases:[{args:['你好 🌳\n"\\\t'],expected:'你好 🌳\n"\\\t'}],python:fn('return x'),java:javaFn('String solve(String x)','return x;')},
 {name:'int64 above JS precision',adapter:{method:'solve',params:['int64'],returns:'int64'},cases:[{args:['9007199254740993'],expected:'9007199254740994'}],python:fn('return x+1'),java:javaFn('long solve(long x)','return x+1;')},
 {name:'int64 minimum',adapter:{method:'solve',params:['int64'],returns:'int64'},cases:[{args:['-9223372036854775808'],expected:'-9223372036854775808'}],python:fn('return x'),java:javaFn('long solve(long x)','return x;')},
 {name:'big integer',adapter:{method:'solve',params:['bigint'],returns:'bigint'},cases:[{args:['999999999999999999999999999999999999'],expected:'1000000000000000000000000000000000000'}],python:fn('return x+1'),java:javaFn('BigInteger solve(BigInteger x)','return x.add(BigInteger.ONE);')},
 {name:'int64 nested array',adapter:{method:'solve',params:[{array:'int64'}],returns:{array:'int64'}},cases:[{args:[['9007199254740993','9223372036854775807']],expected:['9007199254740993','9223372036854775807']}],python:fn('return x'),java:javaFn('long[] solve(long[] x)','return x;')},
 {name:'float tolerance',adapter:{method:'solve',params:['float'],returns:'float',compare:{kind:'float',absoluteTolerance:1e-8}},cases:[{args:[0.1],expected:0.3}],python:fn('return x+0.2'),java:javaFn('double solve(double x)','return x+0.2;')},
 {name:'float array tolerance',adapter:{method:'solve',params:[{array:'float'}],returns:{array:'float'},compare:{kind:'float'}},cases:[{args:[[0.1+0.2,1]],expected:[0.3,1]}],python:fn('return x'),java:javaFn('double[] solve(double[] x)','return x;')},
 {name:'multiset duplicates',adapter:{method:'solve',params:[{array:'int'}],returns:{array:'int'},compare:{kind:'multiset'}},cases:[{args:[[1,2,1]],expected:[2,1,1]}],python:fn('return x'),java:javaFn('int[] solve(int[] x)','return x;')},
 {name:'multiset rejects incorrect multiplicity',adapter:{method:'solve',params:[{array:'int'}],returns:{array:'int'},compare:{kind:'multiset'}},cases:[{args:[[1,2,1]],expected:[2,2,1]}],python:fn('return x'),java:javaFn('int[] solve(int[] x)','return x;'),expected:'wrong_answer'},
 {name:'generic list',adapter:{method:'solve',params:[{list:'int'}],returns:{list:'int'}},cases:[{args:[[3,2,1]],expected:[1,2,3]}],python:fn('return sorted(x)'),java:javaFn('List<Integer> solve(List<Integer> x)','Collections.sort(x);return x;')},
 {name:'nested generic list',adapter:{method:'solve',params:[{list:{list:'int'}}],returns:{list:{list:'int'}}},cases:[{args:[[[1],[],[2,3]]],expected:[[1],[],[2,3]]}],python:fn('return x'),java:javaFn('List<List<Integer>> solve(List<List<Integer>> x)','return x;')},
 {name:'reverse ListNode',adapter:{method:'solve',params:['listnode'],returns:'listnode'},cases:[{args:[[1,2,3]],expected:[3,2,1]}],python:fn('prev=None\nwhile x:\n    nxt=x.next\n    x.next=prev\n    prev=x\n    x=nxt\nreturn prev'),java:javaFn('ListNode solve(ListNode x)','ListNode p=null;while(x!=null){ListNode n=x.next;x.next=p;p=x;x=n;}return p;')},
 {name:'empty ListNode',adapter:{method:'solve',params:['listnode'],returns:'listnode'},cases:[{args:[[]],expected:[]}],python:fn('return x'),java:javaFn('ListNode solve(ListNode x)','return x;')},
 {name:'TreeNode invert',adapter:{method:'solve',params:['treenode'],returns:'treenode'},cases:[{args:[[4,2,7,1,3,6,9]],expected:[4,7,2,9,6,3,1]}],python:fn('if x:\n    x.left,x.right=self.solve(x.right),self.solve(x.left)\nreturn x'),java:javaFn('TreeNode solve(TreeNode x)','if(x!=null){TreeNode t=x.left;x.left=solve(x.right);x.right=solve(t);}return x;')},
 {name:'empty TreeNode',adapter:{method:'solve',params:['treenode'],returns:'treenode'},cases:[{args:[null],expected:[]}],python:fn('return x'),java:javaFn('TreeNode solve(TreeNode x)','return x;')},
 {name:'in-place void array',adapter:{method:'solve',params:[{array:'int'}],returns:{array:'int'},inPlaceArg:0},cases:[{args:[[3,1,2]],expected:[1,2,3]}],python:fn('x.sort()'),java:javaFn('void solve(int[] x)','Arrays.sort(x);')},
 {name:'fresh Solution per case',adapter:{method:'solve',params:['int'],returns:'int'},cases:[{args:[2],expected:3},{args:[2],expected:3}],python:'class Solution:\n    def __init__(self): self.n=0\n    def solve(self,x):\n        self.n+=1\n        return x+self.n',java:'class Solution {int n=0; public int solve(int x){return x+(++n);}}'},
 {name:'debug stdout separate from result',adapter:{method:'solve',params:['int'],returns:'int'},cases:[{args:[2],expected:2}],python:fn('print("debug: 999")\nreturn x'),java:javaFn('int solve(int x)','System.out.println("debug: 999");return x;')},
 {name:'unjudged result is completed',adapter:{method:'solve',params:['int'],returns:'int'},cases:[{args:[2]}],python:fn('return x'),java:javaFn('int solve(int x)','return x;'),expected:'completed'},
 {name:'partial wrong answer aggregate',adapter:{method:'solve',params:['int'],returns:'int'},cases:[{args:[2],expected:2},{args:[3],expected:4}],python:fn('return x'),java:javaFn('int solve(int x)','return x;'),expected:'wrong_answer'},
];
async function check(name:string,request:RunRequest,status:string,signal?:AbortSignal){
  const result=await runCode(request,{signal}); reports.push({name,language:request.language,request,result,expectedStatus:status,passed:result.status===status});
  assert.equal(result.status,status,JSON.stringify(result,null,2));return result;
}
for(const scenario of scenarios) for(const language of ['python','java'] as const){
  test(`${language}: ${scenario.name}`,async()=>{await check(scenario.name,{language,mode:'function',code:scenario[language],adapter:scenario.adapter,cases:scenario.cases},scenario.expected??'passed');});
}
for(const language of ['python','java'] as const){
  test(`${language}: ACM multiline unicode EOF`,async()=>{
    await check('ACM multiline unicode EOF',{language,mode:'acm',stdin:'你好\n🌳\n',cases:[{stdin:'你好\n🌳\n',expected:'你好\n🌳\n'}],code:language==='python'?'import sys\nprint(sys.stdin.read(),end="")':'public class Main {public static void main(String[] a)throws Exception{System.out.write(System.in.readAllBytes());}}'},'passed');
  });
  test(`${language}: ACM empty input`,async()=>{await check('ACM empty input',{language,mode:'acm',stdin:'',code:language==='python'?'import sys\nprint(len(sys.stdin.read()))':'public class Main{public static void main(String[] a)throws Exception{System.out.println(System.in.readAllBytes().length);}}',cases:[{stdin:'',expected:'0'}]},'passed');});
  test(`${language}: syntax error`,async()=>{await check('syntax error',{language,mode:'acm',code:language==='python'?'def broken(':'public class Main { broken !!! }'},'compile_error');});
  test(`${language}: runtime exception`,async()=>{await check('runtime exception',{language,mode:'acm',code:language==='python'?'raise ValueError("test exception")':'public class Main{public static void main(String[] a){throw new IllegalStateException("test exception");}}'},'runtime_error');});
  test(`${language}: timeout`,async()=>{await check('timeout',{language,mode:'acm',timeoutMs:250,code:language==='python'?'while True: pass':'public class Main{public static void main(String[] a){while(true){}}}'},'timeout');});
  test(`${language}: output limit`,async()=>{const result=await check('output limit',{language,mode:'acm',outputLimitBytes:4096,code:language==='python'?'while True: print("x"*1000)':'public class Main{public static void main(String[] a){while(true){System.out.println("x".repeat(1000));}}}'},'output_limit');assert.ok(Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)<=4096);});
  test(`${language}: user cancellation`,async()=>{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),1000);try{await check('user cancellation',{language,mode:'acm',timeoutMs:10000,code:language==='python'?'while True: pass':'public class Main{public static void main(String[] a){while(true){}}}'},'cancelled',controller.signal);}finally{clearTimeout(timer);}});
  test(`${language}: missing runtime`,async()=>{await check('missing runtime',{language,mode:'acm',code:'',runtimePath:'/does-not-exist/algopractice-runtime'},'environment_error');});
  test(`${language}: reject unsafe integer Number`,async()=>{await check('reject unsafe integer Number',{language,mode:'function',code:'',adapter:{method:'solve',params:['int64'],returns:'int64'},cases:[{args:[9007199254740992],expected:'1'}]},'invalid_request');});
  test(`${language}: cycle output is rejected`,async()=>{await check('cycle output rejected',{language,mode:'function',adapter:{method:'solve',params:['listnode'],returns:'listnode'},cases:[{args:[[1]],expected:[1]}],code:language==='python'?fn('x.next=x\nreturn x'):javaFn('ListNode solve(ListNode x)','x.next=x;return x;')},'runtime_error');});
}

test('macOS: ordinary child cannot survive parent completion',async()=>{
 const marker=path.join(os.tmpdir(),`algopractice-child-${process.pid}.txt`);await rm(marker,{force:true});
 const result=await check('ordinary child cleanup',{language:'python',mode:'acm',code:`import subprocess,sys\np=subprocess.Popen([sys.executable,'-c',${JSON.stringify(`import time,pathlib\ntime.sleep(1)\npathlib.Path(${JSON.stringify(marker)}).write_text('survived')`)}])\nprint(p.pid)`},'completed');
 const pid=Number(result.stdout.trim());await new Promise(r=>setTimeout(r,1200));
 let markerExists=true;try{await stat(marker);}catch{markerExists=false;}assert.equal(markerExists,false);
 // kill(pid,0) can still see a reparented zombie; marker absence proves no code ran after delay.
 reports.push({name:'ordinary child delayed-write evidence',pid,markerExists,passed:!markerExists});
});
test('macOS: unicode and space runtime path',{skip:process.platform!=='darwin'?'Uses a macOS executable symlink; Windows has native Job argument/path coverage':false},async()=>{
 const root=path.join(os.tmpdir(),'algopractice 中文 runtime');await mkdir(root,{recursive:true});
 const {symlink}=await import('node:fs/promises'); const link=path.join(root,'python3');await rm(link,{force:true});await symlink(defaultRuntimePath('python'),link);
 await check('unicode space runtime path',{language:'python',mode:'acm',code:'print("路径正确")',runtimePath:link,cases:[{expected:'路径正确'}]},'passed');await rm(root,{recursive:true,force:true});
});
test('temporary run directories are cleaned',async()=>{const now=(await readdir(os.tmpdir())).filter(n=>n.startsWith('algopractice-run-')&&!startDirectories.has(n));assert.deepEqual(now,[]);reports.push({name:'temporary directories cleanup',remaining:now,passed:true});});
after(async()=>{
 await mkdir('evidence',{recursive:true});await writeFile('evidence/runner-results.json',JSON.stringify({startedAt,completedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,osRelease:os.release(),node:process.version,summary:{scenarios:reports.length,passed:reports.filter((r:any)=>r.passed).length,failed:reports.filter((r:any)=>!r.passed).length},reports},null,2)+'\n');
});

test('total execution deadline spans all cases',async()=>{
 let executionStarted=0;
 const r=await runCode({language:'python',mode:'function',timeoutMs:4000,adapter:{method:'solve',params:['int'],returns:'int'},cases:[{args:[1],expected:1},{args:[2],expected:2},{args:[3],expected:3}],code:'import time\nclass Solution:\n    def solve(self,x):\n        if x > 1: time.sleep(3)\n        return x'}, {onEvent:event=>{if(event.phase==='run'&&!executionStarted)executionStarted=performance.now();}});
 assert.equal(r.status,'timeout',JSON.stringify(r));
 assert.equal(r.caseResults[0].status,'passed',JSON.stringify(r));
 // Measure execution only: interpreter validation and compilation do not consume this deadline.
 // The two slow cases need at least 6 seconds if the budget accidentally resets per case.
 assert.ok(performance.now()-executionStarted<5500,'The 4-second budget must cover all cases together');
});
test('truncated UTF8 stays within byte budget',async()=>{const r=await check('UTF8 output truncation',{language:'python',mode:'acm',outputLimitBytes:4096,code:'while True: print("🌳"*1000)'},'output_limit');assert.ok(Buffer.byteLength(r.stdout)+Buffer.byteLength(r.stderr)<=4096);});
for(const language of ['python','java'] as const){
 test(`${language}: tree expected trailing null normalization`,async()=>{await check('tree normalization',{language,mode:'function',adapter:{method:'solve',params:['treenode'],returns:'treenode'},cases:[{args:[[1]],expected:[1,null,null]}],code:language==='python'?fn('return x'):javaFn('TreeNode solve(TreeNode x)','return x;')},'passed');});
 test(`${language}: null ListNode expected normalization`,async()=>{await check('null ListNode normalization',{language,mode:'function',adapter:{method:'solve',params:['listnode'],returns:'listnode'},cases:[{args:[null],expected:null}],code:language==='python'?fn('return x'):javaFn('ListNode solve(ListNode x)','return x;')},'passed');});
}

test('parent secrets are absent from child environment',async()=>{
 process.env.ALGOPRACTICE_FAKE_SECRET='synthetic-test-only';
 try{await check('minimal environment',{language:'python',mode:'acm',code:'import os\nprint(os.environ.get("ALGOPRACTICE_FAKE_SECRET", "absent"))',cases:[{expected:'absent'}]},'passed');}finally{delete process.env.ALGOPRACTICE_FAKE_SECRET;}
});
test('Java ordinary child cleanup',async()=>{
 const marker=path.join(os.tmpdir(),`algopractice-java-child-${process.pid}.txt`);await rm(marker,{force:true});
 const code=`public class Main { public static void main(String[] a)throws Exception { Process p=new ProcessBuilder(System.getProperty("java.home")+"/bin/java","-cp",System.getProperty("java.class.path"),"Main$Child",${JSON.stringify(marker)}).inheritIO().start();System.out.println(p.pid()); } static class Child {public static void main(String[] a)throws Exception{Thread.sleep(1000);java.nio.file.Files.writeString(java.nio.file.Path.of(a[0]),"survived");}} }`;
 const result=await check('Java ordinary child cleanup',{language:'java',mode:'acm',code},'completed');await new Promise(r=>setTimeout(r,1200));
 let exists=true;try{await stat(marker);}catch{exists=false;}assert.equal(exists,false);reports.push({name:'Java child delayed-write evidence',pid:Number(result.stdout.trim()),markerExists:exists,passed:!exists});
});

for(const language of ['python','java'] as const){
 test(`${language}: in-place active prefix`,async()=>{await check('in-place active prefix',{language,mode:'function',adapter:{method:'solve',params:[{array:'int'}],returns:'int',inPlaceArg:0,inPlaceRange:{end:'return'}},cases:[{args:[[3,2,2,3]],expected:[2,2]},{args:[[3,3]],expected:[]}],code:language==='python'?fn('k=0\nfor v in x:\n    if v!=3:\n        x[k]=v\n        k+=1\nreturn k'):javaFn('int solve(int[] x)','int k=0;for(int v:x)if(v!=3)x[k++]=v;return k;')},'passed');});
 test(`${language}: in-place invalid returned range`,async()=>{await check('in-place invalid returned range',{language,mode:'function',adapter:{method:'solve',params:[{array:'int'}],returns:'int',inPlaceArg:0,inPlaceRange:{end:'return'}},cases:[{args:[[1]],expected:[1]}],code:language==='python'?fn('return 10'):javaFn('int solve(int[] x)','return 10;')},'runtime_error');});
 test(`${language}: in-place fixed interval`,async()=>{await check('in-place fixed interval',{language,mode:'function',adapter:{method:'solve',params:[{array:'int'}],returns:{array:'int'},inPlaceArg:0,inPlaceRange:{start:1,end:3}},cases:[{args:[[3,2,1,0]],expected:[1,2]}],code:language==='python'?fn('x.sort()'):javaFn('void solve(int[] x)','Arrays.sort(x);')},'passed');});
 test(`${language}: exact ACM preserves trailing newline`,async()=>{await check('exact ACM mode',{language,mode:'acm',acmCompare:'exact',cases:[{expected:'42'}],code:language==='python'?'print(42)':'public class Main{public static void main(String[] a){System.out.println(42);}}'},'wrong_answer');});
}
