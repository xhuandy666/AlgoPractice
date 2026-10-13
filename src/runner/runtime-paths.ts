import path from 'node:path';
import type { Language } from './types.ts';

export function runtimeStorageRoot(root?: string): string { return path.resolve(root ?? process.env.ALGOPRACTICE_RUNTIME_DIR ?? path.join(process.cwd(), '.runtime')); }
export function defaultRuntimePath(language: Language, root = runtimeStorageRoot()): string {
  if (language === 'python') return path.join(root, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  if (language === 'go') return path.join(root, 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
  if (language === 'cpp') return path.join(root, 'cpp', process.platform === 'win32' ? 'zig.exe' : 'zig');
  return path.join(root, 'java', process.platform === 'darwin' ? 'Contents/Home/bin/java' : process.platform === 'win32' ? 'bin/java.exe' : 'bin/java');
}
export function compilerPath(executable: string): string { return path.join(path.dirname(executable), process.platform === 'win32' ? 'javac.exe' : 'javac'); }
