/** P0 only: run synthetic Go/C++ programs with pinned, privately extracted toolchains.
 * node tests/toolchain-preflight.mjs --root .local/go-cpp-preflight [--offline]
 * No npm dependencies, global PATH edits, user Go configuration, or application runtimes.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(new URL('./fixtures/go-cpp-toolchains.json', import.meta.url));
const manifest = JSON.parse(await readFile(fixturePath, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const target = `${process.platform}-${process.arch}`;
const budget = { download: 600_000, extract: 120_000, coldCompile: 300_000, hotCompile: 120_000, execute: 10_000 };
const approvedHosts = new Set(['dl.google.com', 'go.dev', 'ziglang.org']);
const missing = error => error?.code === 'ENOENT';
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

function configuration(args) {
  assert.ok(args.length === 2 || (args.length === 3 && args[2] === '--offline'), 'Use --root ISOLATED_DIRECTORY [--offline]');
  assert.equal(args[0], '--root');
  const root = path.resolve(args[1]);
  const cwd = path.resolve(process.cwd());
  assert.ok(root !== path.parse(root).root && root !== os.homedir() && !inside(root, cwd), 'Root must be an isolated child directory, not a home/workspace root or ancestor');
  assert.ok(!root.split(path.sep).some(segment => ['.runtime', '.aoci', 'runtimes', 'credentials', 'backups'].includes(segment)), 'Refusing an application/runtime/private-data directory');
  assert.ok(manifest.go.targets[target] && manifest.zig.targets[target], `Unsupported P0 host: ${target}`);
  return { root, offline: args.includes('--offline') };
}

function privateEnvironment(runRoot) {
  const home = path.join(runRoot, 'private-home');
  const config = path.join(runRoot, 'private-config');
  const temporary = path.join(runRoot, 'tmp');
  const env = {
    PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin',
    HOME: home, USERPROFILE: home, APPDATA: config, LOCALAPPDATA: path.join(runRoot, 'private-local'),
    XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(runRoot, 'private-cache'),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    // An explicit target ABI and this invalid developer directory prevent native SDK discovery.
    DEVELOPER_DIR: path.join(runRoot, 'NO_APPLE_DEVELOPER_TOOLS'),
    SDKROOT: path.join(runRoot, 'NO_APPLE_SDK'),
    GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOPROXY: 'off', GOSUMDB: 'off',
    GOVCS: '*:off', CGO_ENABLED: '0', GO111MODULE: 'off',
    GOCACHE: path.join(runRoot, 'go-cache'), GOPATH: path.join(runRoot, 'go-path'), GOMODCACHE: path.join(runRoot, 'go-mod-cache'),
    ZIG_GLOBAL_CACHE_DIR: path.join(runRoot, 'zig-global-cache'), ZIG_LOCAL_CACHE_DIR: path.join(runRoot, 'zig-local-cache'),
  };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows'; env.WINDIR = env.SystemRoot;
  }
  return env;
}

async function run(executable, args, { cwd, env, timeout = budget.execute, stdin = '', limit = 4_000_000 }) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, reason, killPromise;
    const terminate = why => {
      reason ??= why;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        // Only this synthetic compiler/run's process tree; no lookup by process name.
        killPromise ??= new Promise(done => {
          const killer = spawn(path.join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => { child.kill(); done(); }); killer.on('close', done);
        });
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => terminate('timeout'), timeout);
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', text => {
        bytes += Buffer.byteLength(text);
        if (bytes > limit) { terminate('output-limit'); return; }
        if (key === 'stdout') stdout += text; else stderr += text;
      });
    }
    child.stdin.on('error', () => {}); child.stdin.end(stdin);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', async code => {
      clearTimeout(timer); if (killPromise) await killPromise;
      resolve({ code, stdout, stderr, reason: reason ?? null, durationMs: Math.round(performance.now() - start) });
    });
  });
}
function passed(result, label) {
  assert.ok(!result.reason && result.code === 0, `${label} failed (${result.reason ?? result.code}): ${(result.stderr || result.stdout).slice(-12_000)}`);
  return result;
}

async function digestFile(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
function validateArtifact(item) {
  const url = new URL(item.url);
  assert.ok(url.protocol === 'https:' && approvedHosts.has(url.hostname) && !url.username && !url.password && !url.port && !url.search && !url.hash, 'Artifact must be an approved fixed official HTTPS source');
  assert.match(item.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(item.size) && item.size > 0 && item.size < 200_000_000, 'Unexpected P0 artifact size');
  assert.match(item.prefix, /^[A-Za-z0-9_.-]+$/);
  assert.ok(!item.executable.includes('..') && !path.isAbsolute(item.executable));
  return url;
}
async function fetchOfficial(url, signal) {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    assert.ok(current.protocol === 'https:' && approvedHosts.has(current.hostname) && !current.username && !current.password, 'Unapproved official-source redirect');
    const response = await fetch(current, { signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location'); await response.body?.cancel();
    assert.ok(location, 'Missing redirect location'); current = new URL(location, current);
  }
  throw new Error('Official download redirect budget exhausted');
}
async function archiveFor(item, archives, offline) {
  const url = validateArtifact(item), archive = path.join(archives, path.basename(url.pathname));
  try {
    const info = await lstat(archive); assert.ok(info.isFile() && !info.isSymbolicLink(), 'Cached artifact is not an ordinary file');
    assert.equal(info.size, item.size, 'Cached artifact size mismatch'); assert.equal(await digestFile(archive), item.sha256, 'Cached artifact hash mismatch');
    return { archive, downloaded: false };
  } catch (error) { if (!missing(error)) throw error; }
  assert.ok(!offline, `Offline artifact is not available: ${path.basename(archive)}`);
  const partial = `${archive}.partial-${randomUUID()}`, handle = await open(partial, 'wx', 0o600);
  let received = 0; const hash = createHash('sha256');
  try {
    const response = await fetchOfficial(url, AbortSignal.timeout(budget.download));
    assert.ok(response.ok && response.body, `Artifact download HTTP ${response.status}`);
    for await (const bytes of response.body) {
      received += bytes.length; assert.ok(received <= item.size, 'Artifact exceeded its pinned size');
      hash.update(bytes); await handle.writeFile(bytes);
    }
    assert.equal(received, item.size, 'Downloaded artifact size mismatch'); assert.equal(hash.digest('hex'), item.sha256, 'Downloaded artifact hash mismatch');
    await handle.sync();
  } catch (error) { await handle.close(); await rm(partial, { force: true }); throw error; }
  await handle.close(); await rename(partial, archive); return { archive, downloaded: true };
}
async function extract(item, archive, destination, env) {
  const tar = process.platform === 'win32' ? path.join(env.SystemRoot, 'System32', 'tar.exe') : '/usr/bin/tar';
  const listing = passed(await run(tar, ['-tf', archive], { cwd: destination, env, timeout: budget.extract, limit: 12_000_000 }), 'Archive listing');
  const entries = listing.stdout.trim().split(/\r?\n/);
  assert.ok(entries.length > 1 && entries.length < 100_000, 'Archive member budget exceeded');
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '');
    assert.ok(!normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..') && !normalized.includes('\0'), 'Unsafe archive member');
    assert.ok(normalized === item.prefix || normalized === `${item.prefix}/` || normalized.startsWith(`${item.prefix}/`), 'Unexpected upstream archive layout');
  }
  passed(await run(tar, ['-xf', archive, '--strip-components=1', '-C', destination], { cwd: destination, env, timeout: budget.extract }), 'Archive extraction');
  const executable = path.join(destination, item.executable);
  assert.ok(inside(await realpath(destination), await realpath(executable)), 'Executable escaped its isolated installation');
  assert.ok((await lstat(executable)).isFile(), 'Missing upstream executable');
  assert.ok((await lstat(path.join(destination, 'LICENSE'))).isFile(), 'Upstream LICENSE was not retained');
  return { executable, entryCount: entries.length };
}

/** Read imports directly; inspection itself must not require Apple developer tools or MSVC. */
function nativeBinary(bytes) {
  if (process.platform === 'darwin') {
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, 'Expected a native little-endian Mach-O 64 binary');
    assert.equal(bytes.readUInt32LE(4), process.arch === 'arm64' ? 0x0100000c : 0x01000007, 'Wrong Mach-O architecture');
    const count = bytes.readUInt32LE(16), dependencies = []; let cursor = 32;
    assert.ok(count < 10_000);
    for (let i = 0; i < count; i++) {
      const command = bytes.readUInt32LE(cursor), size = bytes.readUInt32LE(cursor + 4);
      assert.ok(size >= 8 && cursor + size <= bytes.length, 'Invalid Mach-O load command');
      if ([0xc, 0x80000018, 0x8000001f, 0x20, 0x80000023].includes(command)) {
        const start = cursor + bytes.readUInt32LE(cursor + 8); assert.ok(start < cursor + size);
        dependencies.push(bytes.subarray(start, cursor + size).toString('utf8').split('\0')[0]);
      }
      cursor += size;
    }
    assert.ok(dependencies.every(name => name.startsWith('/usr/lib/') || name.startsWith('/System/Library/')), 'Binary depends on a non-system dylib');
    return { format: 'Mach-O 64', dependencies };
  }
  assert.equal(bytes.subarray(0, 2).toString('ascii'), 'MZ'); const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt32LE(pe), 0x00004550); assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, 'Wrong PE architecture');
  const sectionCount = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20), optional = pe + 24;
  assert.equal(bytes.readUInt16LE(optional), 0x20b, 'Expected PE32+'); const sectionTable = optional + optionalSize;
  const offsetOf = rva => {
    for (let i = 0; i < sectionCount; i++) {
      const section = sectionTable + i * 40, address = bytes.readUInt32LE(section + 12);
      const size = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16));
      if (rva >= address && rva < address + size) return bytes.readUInt32LE(section + 20) + rva - address;
    }
    throw new Error('Invalid PE dependency RVA');
  };
  const imports = bytes.readUInt32LE(optional + 112 + 8), dependencies = [];
  if (imports) for (let cursor = offsetOf(imports), count = 0; ; cursor += 20) {
    assert.ok(cursor + 20 <= bytes.length && ++count < 1000, 'Invalid PE import table');
    const nameRva = bytes.readUInt32LE(cursor + 12); if (!nameRva) break;
    const start = offsetOf(nameRva), end = bytes.indexOf(0, start); assert.ok(end > start && end - start < 256);
    dependencies.push(bytes.subarray(start, end).toString('ascii'));
  }
  const systemDll = /^(?:kernel32|kernelbase|ntdll|msvcrt|ucrtbase|advapi32|ws2_32|user32|bcrypt|shell32|ole32|secur32)\.dll$|^(?:api|ext)-ms-win-[a-z0-9-]+\.dll$/i;
  assert.ok(dependencies.every(name => systemDll.test(name)), `Binary depends on a non-system DLL: ${dependencies.join(', ')}`);
  return { format: 'PE32+ x64', dependencies };
}
function auditCppTrace(trace, installation) {
  assert.ok(trace.includes('-cc1') && /#include [<"].*search starts here:/.test(trace), 'C++ trace did not expose actual compiler include search paths');
  const forbidden = /\/Library\/Developer\/|\/Applications\/[^\r\n]*Xcode|\/opt\/homebrew\/|\/usr\/local\/|(?:[A-Za-z]:)?[\\/]Program Files(?: \(x86\))?[\\/]Microsoft|Visual Studio|Windows Kits/i;
  assert.ok(!forbidden.test(trace), 'C++ compilation consulted an external SDK/compiler installation');
  assert.ok(!/MacOSX[^\s"']*\.sdk|[" ]-isysroot[ =]/i.test(trace), 'C++ compilation selected an external Apple sysroot');
  const start = trace.indexOf('#include <...> search starts here:');
  const end = trace.indexOf('End of search list.', start);
  assert.ok(start >= 0 && end > start);
  const searchPaths = trace.slice(start, end).split(/\r?\n/).slice(1).map(line => line.trim()).filter(Boolean);
  assert.ok(searchPaths.length > 0);
  for (const candidate of searchPaths) assert.ok(inside(installation, path.resolve(candidate.replace(/ \(framework directory\)$/, ''))), `C++ external include search path: ${candidate}`);
  const linkerCommand = trace.split(/\r?\n/).find(line => /^(?:zig ld|ld\.lld|lld-link)(?:\s|$)/.test(line));
  assert.ok(linkerCommand, 'C++ trace did not expose the actual final link command');
  assert.ok(!forbidden.test(linkerCommand), 'Link command consulted an external SDK/compiler');
  return { searchPaths, linkerCommand, externalSdkPaths: [], traceSha256: sha256(trace), forbiddenSdkAudit: 'passed' };
}

const goProgram = `package main
import ("bufio"; "encoding/json"; "fmt"; "os"; "sort"; "strings"; "unicode/utf8"; "unsafe")
func recoverProbe() (out string) { defer func(){if recover()!=nil { out="ok" }}(); panic("synthetic"); }
func main() {
 line,_:=bufio.NewReader(os.Stdin).ReadString('\\n'); if strings.TrimSpace(line)!="算法🚀" { panic("stdin") }
 nums:=[]int{3,1,2}; sort.Ints(nums); counts:=map[string]int{"sum":nums[0]+nums[1]+nums[2]}
 flags:=[]bool{true,false,true}; text:="算法🚀"; if utf8.RuneCountInString(text)!=3 {panic("utf8")}
 raw,_:=json.Marshal(flags); fmt.Printf("P0_GO|sum=%d|bool=%s|rune=%c|utf8=%s|recover=%s|size=%d\\n",counts["sum"],raw,'界',text,recoverProbe(),unsafe.Sizeof(int(0)))
}
`;
const cppProgram = `#include <algorithm>
#include <iostream>
#include <numeric>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
int main() {
 static_assert(sizeof(void*) == 8, "64 bit");
 std::string line; std::getline(std::cin,line); if(line != u8"算法🚀") return 2;
 std::vector<int> nums{3,1,2}; std::sort(nums.begin(),nums.end());
 std::unordered_map<std::string,int> values{{"sum",std::accumulate(nums.begin(),nums.end(),0)}};
 std::vector<bool> flags{false,false,true}; flags[0]=true;
 std::vector<char> chars{'x'}; std::optional<std::string> text=u8"算法🚀";
 std::string caught="no"; try{throw std::runtime_error("synthetic");}catch(const std::exception&){caught="ok";}
 std::cout<<"P0_CPP|sum="<<values["sum"]<<"|bool="<<flags[0]<<","<<flags[1]<<","<<flags[2]<<"|char="<<chars[0]<<"|utf8="<<*text<<"|catch="<<caught<<"|size="<<sizeof(void*)<<"\\n";
}
`;
const bitsHeader = `#pragma once
// Independently authored C++17 standard-header convenience shim, not GCC's private implementation.
#include <algorithm>
#include <array>
#include <bitset>
#include <deque>
#include <functional>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <optional>
#include <queue>
#include <set>
#include <sstream>
#include <stack>
#include <stdexcept>
#include <string>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>
`;

async function probeGo(installation, env, directory) {
  const executable = installation.executable, options = { cwd: directory, env };
  const version = passed(await run(executable, ['version'], options), 'Go version').stdout.trim();
  assert.equal(version, `go version go${manifest.go.version} ${manifest.go.targets[target].target}`);
  // This writes only the new private configuration directory; GOTELEMETRY is a read-only query.
  passed(await run(executable, ['telemetry', 'off'], options), 'Private Go telemetry configuration');
  const telemetry = passed(await run(executable, ['env', 'GOTELEMETRY'], options), 'Go telemetry verification').stdout.trim();
  assert.equal(telemetry, 'off');
  const metadata = JSON.parse(passed(await run(executable, ['env', '-json', 'GOROOT', 'GOVERSION', 'GOOS', 'GOARCH', 'GOTOOLCHAIN', 'GOPROXY', 'GOSUMDB', 'GOWORK', 'CGO_ENABLED', 'GOENV', 'GOCACHE'], options), 'Go effective environment').stdout);
  await writeFile(path.join(directory, 'main.go'), goProgram);
  const binary = path.join(directory, process.platform === 'win32' ? 'go-program.exe' : 'go-program');
  const args = ['build', '-trimpath', '-buildvcs=false', '-o', binary, 'main.go'];
  const cold = passed(await run(executable, args, { ...options, timeout: budget.coldCompile }), 'Go cold compile');
  const hot = passed(await run(executable, args, { ...options, timeout: budget.hotCompile }), 'Go hot compile');
  const result = passed(await run(binary, [], { ...options, stdin: '算法🚀\n' }), 'Go synthetic program');
  assert.equal(result.stdout, 'P0_GO|sum=6|bool=[true,false,true]|rune=界|utf8=算法🚀|recover=ok|size=8\n');
  await writeFile(path.join(directory, 'diagnostic.go'), 'package main\nfunc main() { value := }\n');
  const diagnostic = await run(executable, ['build', '-o', `${binary}-diagnostic`, 'diagnostic.go'], { ...options, timeout: budget.hotCompile });
  assert.ok(diagnostic.code !== 0 && !diagnostic.reason && /diagnostic\.go:2:/.test(diagnostic.stderr), 'Go diagnostics lost the synthetic source location');
  await writeFile(path.join(directory, 'external.go'), 'package main\nimport _ "example.invalid/never-download"\nfunc main() {}\n');
  const external = await run(executable, ['build', '-o', `${binary}-external`, 'external.go'], { ...options, timeout: budget.hotCompile });
  assert.ok(external.code !== 0 && !external.reason && /cannot find package|cannot find module|lookup disabled/.test(external.stderr), 'Go accepted an external dependency');
  return { version, effectiveEnvironment: metadata, telemetry, coldCompileMs: cold.durationMs, hotCompileMs: hot.durationMs, executionMs: result.durationMs,
    sourceSha256: sha256(goProgram), binarySha256: await digestFile(binary), ...nativeBinary(await readFile(binary)), output: result.stdout.trim(), diagnostics: diagnostic.stderr.trim(), externalDependencyRejected: true };
}
async function probeCpp(installation, env, directory) {
  const executable = installation.executable, options = { cwd: directory, env };
  const version = passed(await run(executable, ['version'], options), 'Zig version').stdout.trim(); assert.equal(version, manifest.zig.version);
  await writeFile(path.join(directory, 'program.cpp'), cppProgram);
  const binary = path.join(directory, process.platform === 'win32' ? 'cpp-program.exe' : 'cpp-program');
  // Do not enable -v while Zig first builds its bundled C++ libraries: that traces
  // every internal compile. The second real compile/link still audits the driver.
  const baseArgs = ['c++', '-target', manifest.zig.targets[target].target, '-std=c++17', '-Wno-nullability-completeness', '-Wno-nullability-completeness-on-arrays'];
  const args = [...baseArgs, '-O0', 'program.cpp', '-o', binary];
  // Zig's private libc++ bootstrap can emit substantial vendor-header warnings.
  // P0 measures this rather than changing the upstream package or hiding the risk.
  const cold = passed(await run(executable, args, { ...options, timeout: budget.coldCompile, limit: 64_000_000 }), 'C++ cold compile');
  const hot = passed(await run(executable, [...args, '-v'], { ...options, timeout: budget.hotCompile }), 'C++ hot compile');
  await writeFile(path.join(directory, 'compiler-trace.txt'), hot.stderr);
  const audit = auditCppTrace(hot.stderr, path.dirname(executable));
  const result = passed(await run(binary, [], { ...options, stdin: '算法🚀\n' }), 'C++ synthetic program');
  assert.equal(result.stdout.replaceAll('\r\n', '\n'), 'P0_CPP|sum=6|bool=1,0,1|char=x|utf8=算法🚀|catch=ok|size=8\n');
  const include = path.join(directory, 'compat'); await mkdir(path.join(include, 'bits'), { recursive: true });
  await writeFile(path.join(include, 'bits', 'stdc++.h'), bitsHeader);
  const bitsProgram = '#include <bits/stdc++.h>\nint main(){std::vector<int> v{3,1,2}; std::sort(v.begin(),v.end()); std::cout<<v[0]<<v[1]<<v[2]<<"\\n";}\n';
  await writeFile(path.join(directory, 'bits.cpp'), bitsProgram); const bitsBinary = `${binary}-bits${process.platform === 'win32' ? '.exe' : ''}`;
  const bitsCompile = passed(await run(executable, [...baseArgs, '-I', include, 'bits.cpp', '-o', bitsBinary], { ...options, timeout: budget.hotCompile }), 'C++ private bits shim');
  assert.equal(passed(await run(bitsBinary, [], options), 'C++ bits program').stdout.replaceAll('\r\n', '\n'), '123\n');
  await writeFile(path.join(directory, 'diagnostic.cpp'), '#include <vector>\nint main(){ this_is_a_synthetic_error; }\n');
  const diagnostic = await run(executable, [...baseArgs, 'diagnostic.cpp', '-o', `${binary}-diagnostic`], { ...options, timeout: budget.hotCompile });
  assert.ok(diagnostic.code !== 0 && !diagnostic.reason && /diagnostic\.cpp:2:/.test(diagnostic.stderr), 'C++ diagnostics lost the synthetic source location');
  return { version: `Zig ${version}`, compilerVersion: /^clang version [^\r\n]+/m.exec(hot.stderr)?.[0] ?? 'unavailable', compilerTarget: manifest.zig.targets[target].target, standard: 'c++17', coldCompileMs: cold.durationMs, hotCompileMs: hot.durationMs,
    coldDiagnostics: { bytes: Buffer.byteLength(cold.stderr), warnings: (cold.stderr.match(/warning:/g) ?? []).length, sha256: sha256(cold.stderr), outputBudgetBytes: 64_000_000 },
    executionMs: result.durationMs, sourceSha256: sha256(cppProgram), binarySha256: await digestFile(binary), ...nativeBinary(await readFile(binary)), output: result.stdout.trim(),
    diagnostics: diagnostic.stderr.trim(), sdkAudit: audit, bitsShim: { standardHeadersOnly: true, sha256: sha256(bitsHeader), compileMs: bitsCompile.durationMs, passed: true } };
}

async function main() {
  const { root, offline } = configuration(process.argv.slice(2));
  await mkdir(root, { recursive: true }); assert.ok(!(await lstat(root)).isSymbolicLink(), 'Isolated root must not be a symlink');
  const resolvedRoot = await realpath(root); assert.ok(!inside(resolvedRoot, await realpath(process.cwd())), 'Resolved root is a workspace ancestor');
  const runRoot = path.join(root, 'runs', randomUUID()), archives = path.join(root, 'archives');
  await mkdir(runRoot, { recursive: true }); await mkdir(archives, { recursive: true });
  for (const directory of [path.join(root, 'runs'), archives]) assert.ok(!(await lstat(directory)).isSymbolicLink(), 'Preflight assets must not traverse symlinks');
  const env = privateEnvironment(runRoot);
  for (const key of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'GOCACHE', 'GOPATH', 'GOMODCACHE', 'ZIG_GLOBAL_CACHE_DIR', 'ZIG_LOCAL_CACHE_DIR']) await mkdir(env[key], { recursive: true });
  const report = { schema: 1, phase: 'P0', success: false, startedAt: new Date().toISOString(), target, offline,
    host: { platform: process.platform, architecture: process.arch, osRelease: os.release(), node: process.version },
    manifestSha256: await digestFile(fixturePath), runRoot, budgetsMs: budget,
    isolation: { inheritedEnvironment: false, syntheticCodeOnly: true, modifiedGlobalPath: false, modifiedUserGoConfiguration: false,
      developerDirectory: env.DEVELOPER_DIR, sdkRoot: env.SDKROOT, configuredSdkDirectoriesAbsent: true, globalCacheIsPrivate: true, networkSandbox: false }, artifacts: {}, probes: {} };
  try {
    for (const language of ['go', 'zig']) {
      process.stderr.write(`P0 ${target}: prepare pinned ${language} ${manifest[language].version}\n`);
      const item = manifest[language].targets[target], { archive, downloaded } = await archiveFor(item, archives, offline);
      const destination = path.join(runRoot, `${language}-toolchain`); await mkdir(destination);
      const installation = await extract(item, archive, destination, env);
      report.artifacts[language] = { version: manifest[language].version, url: item.url, sha256: item.sha256, bytes: item.size, downloaded, archiveEntries: installation.entryCount };
      // Probe from a path with spaces and non-ASCII characters, including on Windows.
      const directory = path.join(runRoot, `${language} 合成 probes`); await mkdir(directory);
      process.stderr.write(`P0 ${target}: cold/hot ${language} compilation (private caches; no system SDK)\n`);
      report.probes[language === 'zig' ? 'cpp' : 'go'] = await (language === 'zig' ? probeCpp : probeGo)(installation, env, directory);
    }
    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    const output = path.join(root, 'preflight-results.json'), temporary = `${output}.next-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, output);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  if (!report.success) process.exitCode = 1;
}
await main();
