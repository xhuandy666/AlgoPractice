import path from 'node:path';
import type { Language } from './types.ts';

export function defaultRuntimePath(language: Language, root = process.env.ALGOPRACTICE_RUNTIME_DIR ?? path.join(process.cwd(), '.runtime')): string {
  if (language === 'python') return path.join(root, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  return path.join(root, 'java', process.platform === 'darwin' ? 'Contents/Home/bin/java' : process.platform === 'win32' ? 'bin/java.exe' : 'bin/java');
}
export function compilerPath(executable: string): string { return path.join(path.dirname(executable), process.platform === 'win32' ? 'javac.exe' : 'javac'); }
