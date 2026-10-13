import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, stat } from 'node:fs/promises';
import { runCode, defaultRuntimePath, runnerDriverVersion } from '../../src/runner/index.ts';
import { goFunctionSource, goWrapper } from '../../src/runner/go-wrapper.ts';
import { cppWrapper, CPP_BITS_HEADER } from '../../src/runner/cpp-wrapper.ts';
import { nativeDiagnostics, byteColumnToEditor } from '../../src/runner/native-diagnostics.ts';
import { supportsAdapter, supportsValueType, validateValue } from '../../src/runner/values.ts';
import type { Adapter, Language, RunEvent, RunRequest, TestCase } from '../../src/runner/types.ts';

const nativeLanguages = ['go', 'cpp'] as const;
const runtimeRoot = process.env.ALGOPRACTICE_NATIVE_TEST_ROOT ? path.resolve(process.env.ALGOPRACTICE_NATIVE_TEST_ROOT) : undefined;
const legacyRoot = process.env.ALGOPRACTICE_LEGACY_TEST_ROOT ? path.resolve(process.env.ALGOPRACTICE_LEGACY_TEST_ROOT) : runtimeRoot;
const legacyPaths = { python: defaultRuntimePath('python', legacyRoot), java: defaultRuntimePath('java', legacyRoot) };
const legacyAvailable = Object.fromEntries(await Promise.all((['python', 'java'] as const).map(async language => [language, !!runtimeRoot && await access(legacyPaths[language]).then(() => true, () => false)]))) as Record<'python' | 'java', boolean>;
const paths = { go: process.env.ALGOPRACTICE_GO_TEST_PATH ?? defaultRuntimePath('go', runtimeRoot), cpp: process.env.ALGOPRACTICE_CPP_TEST_PATH ?? defaultRuntimePath('cpp', runtimeRoot) };
const available = Object.fromEntries(await Promise.all(nativeLanguages.map(async language => [language, !!runtimeRoot && await access(paths[language]).then(() => true, () => false)]))) as Record<'go' | 'cpp', boolean>;
const skip = (language: 'go' | 'cpp') => available[language] ? false : 'Set ALGOPRACTICE_NATIVE_TEST_ROOT to an isolated prepared toolchain root (optional GO/CPP_TEST_PATH).';
const fn = (language: 'go' | 'cpp', go: string, cpp: string) => language === 'go' ? go : `class Solution { public: ${cpp} };`;
test('Explicit native verification includes all four prepared environments', { skip: !runtimeRoot }, () => {
  assert.ok(nativeLanguages.every(language => available[language]), 'Explicit native verification must not silently skip missing Go/C++ toolchains.');
  assert.ok((['python', 'java'] as const).every(language => legacyAvailable[language]), 'Explicit native verification must include Python/Java character regressions.');
});
async function check(language: 'go' | 'cpp', request: Omit<RunRequest, 'language'>, status = 'passed', options: { signal?: AbortSignal; onEvent?: (event: RunEvent) => void } = {}) {
  const result = await runCode({ language, runtimePath: paths[language], ...request }, { runtimeRoot, ...options });
  assert.equal(result.status, status, JSON.stringify(result, null, 2)); return result;
}
test('ASCII character and recursive language capabilities are explicit', () => {
  for (const char of ['a', '\0', '\n', '\x7f']) assert.doesNotThrow(() => validateValue(char, 'char'));
  for (const char of ['', 'ab', '中', '🌳', 65]) assert.throws(() => validateValue(char as never, 'char'));
  for (const language of ['python', 'java', 'go', 'cpp'] as Language[]) assert.equal(supportsValueType(language, { array: { array: 'char' } }), true);
  assert.equal(supportsValueType('go', { array: 'bigint' }), true);
  assert.equal(supportsAdapter('cpp', { method: 'solve', params: [{ array: 'bigint' }], returns: 'int' }), false);
  for (const language of ['python', 'java', 'go', 'cpp'] as const) assert.match(runnerDriverVersion(language), /-v1$/);
});
test('C++ bigint is rejected before inspection or compilation', async () => {
  const events: RunEvent[] = [];
  const result = await runCode({ language: 'cpp', code: '', mode: 'function', adapter: { method: 'solve', params: [], returns: { list: 'bigint' } }, cases: [{ args: [] }] }, { onEvent: event => events.push(event) });
  assert.equal(result.status, 'invalid_request'); assert.match(result.diagnostics[0].message, /bigint/); assert.deepEqual(events.map(event => event.phase), ['queued', 'finished']);
});
test('Go package preparation is comment-aware and does not rewrite complete main packages', () => {
  const code = '// package main is mentioned, not declared\nimport "sort"\nfunc solve(x []int) []int { sort.Ints(x); return x }';
  assert.equal(goFunctionSource(code), `package main\n//line solution.go:1:1\n${code}`);
  const complete = '/* leading comment */\npackage main\nfunc solve(x int) int { return x }';
  assert.equal(goFunctionSource(complete), complete);
  assert.equal(goFunctionSource('package other\nfunc solve() {}'), 'package other\nfunc solve() {}');
});
test('Native diagnostics handle Windows drives, UTF-8 columns and runner-only locations', () => {
  const code = '\tconst char* 文本="🌳"; missing();';
  const column = Buffer.byteLength(code.slice(0, code.indexOf('missing'))) + 1;
  assert.equal(byteColumnToEditor(code, column), code.indexOf('missing') + 1);
  const diagnostic = nativeDiagnostics(`C:\\中文\\solution.cpp:1:${column}: error: missing identifier`, 'compile', { language: 'cpp', mode: 'function', code })[0];
  assert.equal(diagnostic.source, 'user'); assert.equal(diagnostic.line, 1); assert.equal(diagnostic.column, code.indexOf('missing') + 1);
  const wrapper = nativeDiagnostics('runner.cpp:12:3: error: no member solve', 'compile', { language: 'cpp', mode: 'function', code })[0];
  assert.equal(wrapper.source, 'runner'); assert.equal(wrapper.line, undefined);
  const included = nativeDiagnostics(`In file included from runner.cpp:38:\n./solution.cpp:1:${column}: error: missing identifier`, 'compile', { language: 'cpp', mode: 'function', code });
  assert.equal(included.length, 1); assert.equal(included[0].source, 'user'); assert.equal(included[0].column, code.indexOf('missing') + 1);
});
test('Generated portable wrappers use isolated result files and do not depend on GNU headers', () => {
  const adapter: Adapter = { method: 'solve', params: [{ array: 'char' }], returns: { array: 'char' } };
  assert.match(goWrapper(adapter, [{ args: [['a', '\0']] }]), /\[\]byte\{byte\(97\),byte\(0\)\}/);
  assert.match(cppWrapper(adapter, [{ args: [['a']] }]), /std::ofstream/);
  assert.match(CPP_BITS_HEADER, /#include <vector>/); assert.doesNotMatch(CPP_BITS_HEADER, /ext\//);
});
for (const language of ['python', 'java'] as const) {
  const options = { skip: legacyAvailable[language] ? false : 'Native regression requires prepared Python/Java in NATIVE_TEST_ROOT or LEGACY_TEST_ROOT.' };
  const charScenarios: { name: string; adapter: Adapter; cases: TestCase[]; python: string; java: string }[] = [
    { name: 'scalar ASCII char', adapter: { method: 'solve', params: ['char'], returns: 'char' }, cases: [{ args: ['\0'], expected: '\0' }, { args: ['\x7f'], expected: '\x7f' }], python: 'class Solution:\n def solve(self,x): return x', java: 'class Solution {public char solve(char x){return x;}}' },
    { name: 'ASCII character board void observation', adapter: { method: 'solve', params: [{ array: { array: 'char' } }], returns: 'void', inPlaceArg: 0 }, cases: [{ args: [[['a', 'b'], []]], expected: [['z', 'b'], []] }, { args: [[]], expected: [] }], python: 'class Solution:\n def solve(self,x):\n  if x: x[0][0]="z"', java: 'class Solution {public void solve(char[][] x){if(x.length>0)x[0][0]=\'z\';}}' },
    { name: 'generic character list', adapter: { method: 'solve', params: [{ list: 'char' }], returns: { list: 'char' } }, cases: [{ args: [['a', '\n', '\0']], expected: ['a', '\n', '\0'] }, { args: [[]], expected: [] }], python: 'class Solution:\n def solve(self,x): return x', java: 'class Solution {public List<Character> solve(List<Character> x){return x;}}' },
    { name: 'character active prefix', adapter: { method: 'solve', params: [{ array: 'char' }], returns: 'int', inPlaceArg: 0, inPlaceRange: { end: 'return' } }, cases: [{ args: [['a', 'b']], expected: ['z'] }, { args: [[]], expected: [] }], python: 'class Solution:\n def solve(self,x):\n  if x: x[0]="z"; return 1\n  return 0', java: 'class Solution {public int solve(char[] x){if(x.length==0)return 0;x[0]=\'z\';return 1;}}' },
  ];
  for (const scenario of charScenarios) test(`${language}: ${scenario.name}`, options, async () => {
    const result = await runCode({ language, runtimePath: legacyPaths[language], mode: 'function', code: scenario[language], adapter: scenario.adapter, cases: scenario.cases });
    assert.equal(result.status, 'passed', JSON.stringify(result, null, 2));
  });
}

interface Scenario { name: string; adapter: Adapter; cases: TestCase[]; go: string; cpp: string; status?: string; }
const scenarios: Scenario[] = [
  { name: 'int32 boundaries', adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [-2147483648], expected: -2147483648 }, { args: [2147483647], expected: 2147483647 }], go: 'func solve(x int) int {return x}', cpp: 'int solve(int x) {return x;}' },
  { name: 'int64 precision and signed boundaries', adapter: { method: 'solve', params: ['int64'], returns: 'int64' }, cases: [{ args: ['9007199254740993'], expected: '9007199254740993' }, { args: ['-9223372036854775808'], expected: '-9223372036854775808' }, { args: ['9223372036854775807'], expected: '9223372036854775807' }], go: 'func solve(x int64) int64 {return x}', cpp: 'long long solve(long long x) {return x;}' },
  { name: 'Unicode, NUL and JSON escaping', adapter: { method: 'solve', params: ['string'], returns: 'string' }, cases: [{ args: ['你好 🌳\n\t\0"\\'], expected: '你好 🌳\n\t\0"\\' }, { args: [''], expected: '' }], go: 'func solve(x string) string {return x}', cpp: 'string solve(string x) {return x;}' },
  { name: 'empty nested arrays', adapter: { method: 'solve', params: [{ array: { list: 'int' } }], returns: { array: { list: 'int' } } }, cases: [{ args: [[[1, -2], [], [3]]], expected: [[1, -2], [], [3]] }, { args: [[]], expected: [] }], go: 'func solve(x [][]int) [][]int {return x}', cpp: 'vector<vector<int>> solve(vector<vector<int>> x) {return x;}' },
  { name: 'float tolerance', adapter: { method: 'solve', params: ['float'], returns: 'float', compare: { kind: 'float' } }, cases: [{ args: [0.1], expected: 0.3 }], go: 'func solve(x float64) float64 {return x+0.2}', cpp: 'double solve(double x) {return x+0.2;}' },
  { name: 'nonfinite output is rejected', adapter: { method: 'solve', params: [], returns: 'float' }, cases: [{ args: [] }], go: 'import "math"\nfunc solve() float64 {return math.Inf(1)}', cpp: 'double solve() {return numeric_limits<double>::infinity();}', status: 'runtime_error' },
  { name: 'invalid UTF8 is not silently replaced', adapter: { method: 'solve', params: [], returns: 'string' }, cases: [{ args: [] }], go: 'func solve() string {return string([]byte{255})}', cpp: 'string solve() {return string(1,char(255));}', status: 'runtime_error' },
  { name: 'bool arrays including vector bool', adapter: { method: 'solve', params: [{ array: 'boolean' }], returns: { array: 'boolean' } }, cases: [{ args: [[true, false, true]], expected: [true, false, true] }, { args: [[]], expected: [] }], go: 'func solve(x []bool) []bool {return x}', cpp: 'vector<bool> solve(vector<bool> x) {return x;}' },
  { name: 'ASCII char arrays including control bytes', adapter: { method: 'solve', params: [{ array: 'char' }], returns: { array: 'char' } }, cases: [{ args: [['a', '\n', '\0', '\x7f']], expected: ['a', '\n', '\0', '\x7f'] }, { args: [[]], expected: [] }], go: 'func solve(x []byte) []byte {return x}', cpp: 'vector<char> solve(vector<char> x) {return x;}' },
  { name: 'character board in-place void', adapter: { method: 'solve', params: [{ array: { array: 'char' } }], returns: 'void', inPlaceArg: 0 }, cases: [{ args: [[['a', 'b'], []]], expected: [['z', 'b'], []] }, { args: [[]], expected: [] }], go: 'func solve(x [][]byte) {if len(x)>0 {x[0][0]=\'z\'}}', cpp: 'void solve(vector<vector<char>>& x) {if(!x.empty())x[0][0]=\'z\';}' },
  { name: 'multiset preserves duplicate count', adapter: { method: 'solve', params: [{ array: 'int' }], returns: { array: 'int' }, compare: { kind: 'multiset' } }, cases: [{ args: [[1, 2, 1]], expected: [2, 1, 1] }], go: 'func solve(x []int) []int {return x}', cpp: 'vector<int> solve(vector<int> x) {return x;}' },
  { name: 'effective prefix', adapter: { method: 'solve', params: [{ array: 'int' }], returns: 'int', inPlaceArg: 0, inPlaceRange: { end: 'return' } }, cases: [{ args: [[3, 2, 2, 3]], expected: [2, 2] }, { args: [[3, 3]], expected: [] }], go: 'func solve(x []int) int {k:=0;for _,v:=range x {if v!=3 {x[k]=v;k++}};return k}', cpp: 'int solve(vector<int>& x) {int k=0;for(int v:x)if(v!=3)x[k++]=v;return k;}' },
  { name: 'invalid effective prefix', adapter: { method: 'solve', params: [{ array: 'int' }], returns: 'int', inPlaceArg: 0, inPlaceRange: { end: 'return' } }, cases: [{ args: [[1]], expected: [1] }], go: 'func solve(x []int) int {return 5}', cpp: 'int solve(vector<int>& x) {return 5;}', status: 'runtime_error' },
  { name: 'linked-list reversal and empty list', adapter: { method: 'solve', params: ['listnode'], returns: 'listnode' }, cases: [{ args: [[1, 2, 3]], expected: [3, 2, 1] }, { args: [null], expected: [] }], go: 'func solve(x *ListNode) *ListNode {var previous *ListNode;for x!=nil {next:=x.Next;x.Next=previous;previous=x;x=next};return previous}', cpp: 'ListNode* solve(ListNode* x) {ListNode* p=nullptr;while(x){auto n=x->next;x->next=p;p=x;x=n;}return p;}' },
  { name: 'tree shape and trailing nulls', adapter: { method: 'solve', params: ['treenode'], returns: 'treenode' }, cases: [{ args: [[1, null, 2, 3]], expected: [1, null, 2, 3, null, null] }, { args: [[]], expected: [] }], go: 'func solve(x *TreeNode) *TreeNode {return x}', cpp: 'TreeNode* solve(TreeNode* x) {return x;}' },
  { name: 'list cycle is rejected', adapter: { method: 'solve', params: ['listnode'], returns: 'listnode' }, cases: [{ args: [[1]], expected: [1] }], go: 'func solve(x *ListNode) *ListNode {x.Next=x;return x}', cpp: 'ListNode* solve(ListNode* x) {x->next=x;return x;}', status: 'runtime_error' },
  { name: 'shared tree is rejected', adapter: { method: 'solve', params: ['treenode'], returns: 'treenode' }, cases: [{ args: [[1, 2]], expected: [1, 2] }], go: 'func solve(x *TreeNode) *TreeNode {x.Right=x.Left;return x}', cpp: 'TreeNode* solve(TreeNode* x) {x->right=x->left;return x;}', status: 'runtime_error' },
  { name: 'debug stdout stays separate from structured result', adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [2], expected: 2 }], go: 'import "fmt"\nfunc solve(x int) int {fmt.Println("debug: 999");return x}', cpp: 'int solve(int x) {cout<<"debug: 999\\n";return x;}' },
  { name: 'each case starts with fresh globals', adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [2], expected: 3 }, { args: [2], expected: 3 }], go: 'var count int\nfunc solve(x int) int {count++;return x+count}', cpp: 'int count=0; int solve(int x) {return x+(++count);}' },
  { name: 'int32 output overflow is rejected', adapter: { method: 'solve', params: [], returns: 'int' }, cases: [{ args: [] }], go: 'func solve() int {return 2147483648}', cpp: 'long long solve() {return 2147483648LL;}', status: 'runtime_error' },
];
for (const language of nativeLanguages) {
  for (const scenario of scenarios) test(`${language}: ${scenario.name}`, { skip: skip(language) }, async () => {
    const result = await check(language, { mode: 'function', code: fn(language, scenario.go, scenario.cpp), adapter: scenario.adapter, cases: scenario.cases }, scenario.status);
    if (scenario.name.startsWith('debug')) assert.match(result.stdout, /debug: 999/);
  });
  test(`${language}: ACM EOF Unicode and exact newline semantics`, { skip: skip(language) }, async () => {
    const code = language === 'go' ? 'package main\nimport("io";"os")\nfunc main(){io.Copy(os.Stdout,os.Stdin)}' : '#include <bits/stdc++.h>\nint main(){std::cout<<std::cin.rdbuf();}';
    await check(language, { mode: 'acm', code, acmCompare: 'exact', cases: [{ stdin: '你好 🌳\n', expected: '你好 🌳\n' }, { stdin: '', expected: '' }] });
    await check(language, { mode: 'acm', code, acmCompare: 'exact', cases: [{ stdin: '42\n', expected: '42' }] }, 'wrong_answer');
  });
  test(`${language}: compiler errors point to original user line with Unicode/tab column`, { skip: skip(language) }, async () => {
    const code = fn(language, 'func solve(x int) int {\n\t文本:="🌳"; _=文本; return missing\n}', 'int solve(int x) {\n\tstring 文本="🌳"; return missing;\n}');
    const result = await check(language, { mode: 'function', code, adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1] }] }, 'compile_error');
    assert.ok(result.diagnostics.some(d => d.source === 'user' && d.line === 2 && d.column === code.split('\n')[1].indexOf('missing') + 1), JSON.stringify(result.diagnostics));
  });
  test(`${language}: wrapper signature errors never mark original editor text`, { skip: skip(language) }, async () => {
    const result = await check(language, { mode: 'function', code: fn(language, 'func other(x int) int {return x}', 'int other(int x) {return x;}'), adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1] }] }, 'internal_error');
    assert.ok(result.diagnostics.every(d => d.source === 'runner' && d.line === undefined));
  });
  for (const phase of ['queued', 'compile', 'run'] as const) test(`${language}: cancellation at ${phase} resolves once`, { skip: skip(language) }, async () => {
    const controller = new AbortController(), events: RunEvent[] = [];
    await check(language, { mode: 'function', code: fn(language, 'func solve(x int) int {return x}', 'int solve(int x) {return x;}'), adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1] }, { args: [2] }] }, 'cancelled', { signal: controller.signal, onEvent: event => { events.push(event); if (event.phase === phase) controller.abort(); } });
    assert.equal(events.filter(event => event.phase === 'finished').length, 1); assert.ok(!events.some(event => event.caseIndex === 1));
  });
  test(`${language}: structured output limit includes UTF-8 bytes`, { skip: skip(language) }, async () => {
    const code = fn(language, 'import "strings"\nfunc solve() string {return strings.Repeat("🌳",10000)}', 'string solve() {string out;for(int i=0;i<10000;i++)out+="🌳";return out;}');
    const result = await check(language, { mode: 'function', code, outputLimitBytes: 4096, adapter: { method: 'solve', params: [], returns: 'string' }, cases: [{ args: [] }] }, 'output_limit');
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 4096);
  });
  test(`${language}: structured output budget is cumulative across cases`, { skip: skip(language) }, async () => {
    const code = fn(language, 'import "strings"\nfunc solve() string {return strings.Repeat("x",2000)}', 'string solve() {return string(2000,\'x\');}');
    const result = await check(language, { mode: 'function', code, outputLimitBytes: 3000, adapter: { method: 'solve', params: [], returns: 'string' }, cases: [{ args: [] }, { args: [] }] }, 'output_limit');
    assert.equal(result.caseResults[0].status, 'completed'); assert.equal(result.caseResults[1].status, 'output_limit');
  });
  test(`${language}: total execution deadline spans every case`, { skip: skip(language) }, async () => {
    // Leave startup margin under concurrent CI load. Two sleeping cases still
    // exceed the shared budget, so a per-case timer reset cannot satisfy this.
    const code = fn(language, 'import "time"\nfunc solve(x int) int {if x>1 {time.Sleep(3*time.Second)};return x}', 'int solve(int x) {if(x>1){std::this_thread::sleep_for(std::chrono::seconds(3));}return x;}');
    const cppCode = language === 'cpp' ? '#include <chrono>\n#include <thread>\n' + code : code;
    let executionStarted = 0;
    const result = await check(language, { mode: 'function', code: cppCode, timeoutMs: 4000, adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1], expected: 1 }, { args: [2], expected: 2 }, { args: [3], expected: 3 }] }, 'timeout', { onEvent: event => { if (event.phase === 'run' && !executionStarted) executionStarted = performance.now(); } });
    assert.equal(result.caseResults[0].status, 'passed');
    assert.ok(performance.now() - executionStarted < 5500, 'The four-second deadline must cover every case together, not reset for each case');
  });
  test(`${language}: compilation has its own bounded timeout`, { skip: skip(language) }, async () => {
    const result = await check(language, { mode: 'function', compileTimeoutMs: 1, timeoutMs: 10000, code: fn(language, 'func solve(x int) int {return x}', 'int solve(int x) {return x;}'), adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1] }] }, 'timeout');
    assert.equal(result.caseResults.length, 0); assert.ok(result.diagnostics.every(d => d.phase === 'compile'));
  });
  for (const phase of ['compile', 'run'] as const) test(`${language}: active ${phase} cancellation stops work`, { skip: skip(language) }, async () => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await check(language, { mode: 'function', code: fn(language, 'func solve(x int) int {for {} }', 'int solve(int x) {for(;;){} }'), adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1] }] }, 'cancelled', { signal: controller.signal, onEvent: event => { if (event.phase === phase) timer = setTimeout(() => controller.abort(), 50); } });
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  });
  test(`${language}: completed run removes its exact temporary source directory`, { skip: skip(language) }, async () => {
    const code = fn(language, 'import("os";"fmt")\nfunc solve(x int) int {dir,_:=os.Getwd();fmt.Println(dir);return x}', 'int solve(int x) {cout<<filesystem::current_path().string()<<"\\n";return x;}');
    const result = await check(language, { mode: 'function', code: language === 'cpp' ? '#include <filesystem>\n' + code : code, adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1], expected: 1 }] });
    const directory = result.stdout.trim(); assert.match(path.basename(directory), /^algopractice-run-/); assert.equal(await stat(directory).then(() => true, () => false), false);
  });
}
test('Go: big integers preserve decimal precision', { skip: skip('go') }, async () => {
  await check('go', { mode: 'function', code: 'import "math/big"\nfunc solve(x *big.Int) *big.Int {return new(big.Int).Add(x,big.NewInt(1))}', adapter: { method: 'solve', params: ['bigint'], returns: 'bigint' }, cases: [{ args: ['999999999999999999999999999999'], expected: '1000000000000000000000000000000' }] });
});
test('Go: complete package main and nil slice canonicalize correctly', { skip: skip('go') }, async () => {
  await check('go', { mode: 'function', code: '// comment\npackage main\nfunc solve() []byte {return nil}', adapter: { method: 'solve', params: [], returns: { array: 'char' } }, cases: [{ args: [], expected: [] }] });
});
test('Go: panic stack points to original source', { skip: skip('go') }, async () => {
  const result = await check('go', { mode: 'function', code: 'func solve(x int) int {\n panic("synthetic panic")\n}', adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1] }] }, 'runtime_error');
  assert.equal(result.diagnostics[0].source, 'user'); assert.equal(result.diagnostics[0].line, 2);
});
test('Go: rune return is not silently treated as byte char', { skip: skip('go') }, async () => {
  const result = await check('go', { mode: 'function', code: 'func solve(x byte) rune {return rune(x)}', adapter: { method: 'solve', params: ['char'], returns: 'char' }, cases: [{ args: ['a'], expected: 'a' }] }, 'runtime_error');
  assert.equal(result.diagnostics[0].code, 'invalid_return');
});
test('C++: exceptions and signal exits are runtime errors without invented source positions', { skip: skip('cpp') }, async () => {
  for (const body of ['throw std::runtime_error("synthetic user exception");', 'std::abort();']) {
    const result = await check('cpp', { mode: 'function', code: `class Solution {public: int solve(int x) {${body}}};`, adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1] }] }, 'runtime_error');
    assert.ok(result.diagnostics.every(d => d.source === 'user' && d.line === undefined));
  }
});
