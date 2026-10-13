import path from 'node:path';
import type { Language } from './types.ts';

export function runtimeStorageRoot(root?: string): string { return path.resolve(root ?? process.env.ALGOPRACTICE_RUNTIME_DIR ?? path.join(process.cwd(), '.runtime')); }
export function defaultRuntimePath(language: Language, root = runtimeStorageRoot()): string {
  if (language === 'python') return path.join(root, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  if (language === 'go') return path.join(root, 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
  if (language === 'cpp') return path.join(root, 'cpp', process.platform === 'win32' ? 'zig.exe' : 'zig');
  return path.join(root, 'java', process.platform === 'darwin' ? 'Contents/Home/bin/java' : process.platform === 'win32' ? 'bin/java.exe' : 'bin/java');
}
/** Lexical host path equality only; realpath/link validation remains separate. */
export function sameRuntimePath(first: string, second: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.win32.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(first) === normalize(second);
}
/** Reuse only the exact host-trusted test installation's preparation cache. */
export function runtimeCompilationRoot(language: Language, executable: string, ownedRoot: string, testRoot?: string): string {
  if (!testRoot || !path.isAbsolute(executable)) return ownedRoot;
  const trustedRoot = runtimeStorageRoot(testRoot), expected = defaultRuntimePath(language, trustedRoot);
  return sameRuntimePath(executable, expected) ? trustedRoot : ownedRoot;
}
export function compilerPath(executable: string): string { return path.join(path.dirname(executable), process.platform === 'win32' ? 'javac.exe' : 'javac'); }
