export type Language = 'python' | 'java';
export type ValueType = 'int' | 'int64' | 'bigint' | 'float' | 'boolean' | 'string' | 'listnode' | 'treenode' | { array: ValueType } | { list: ValueType };
// int64/bigint use decimal strings on the JS/IPC boundary. Never Number.
export type WireValue = null | boolean | number | string | WireValue[];
export interface Adapter {
  method: string;
  params: ValueType[];
  /** void is valid only when observing an array/list via inPlaceArg. */
  returns: ValueType | 'void';
  inPlaceArg?: number;
  // Observe [start,end), optionally taking end from the integer method return (LeetCode-style k).
  inPlaceRange?: { start?: number; end: number | 'return' };
  compare?: { kind: 'exact' | 'float' | 'multiset'; absoluteTolerance?: number; relativeTolerance?: number };
}
export interface TestCase { args?: WireValue[]; stdin?: string; expected?: WireValue; }
export interface RunRequest {
  language: Language;
  code: string;
  mode: 'acm' | 'function';
  stdin?: string;
  adapter?: Adapter;
  cases?: TestCase[];
  timeoutMs?: number;
  compileTimeoutMs?: number;
  outputLimitBytes?: number;
  runtimePath?: string;
  acmCompare?: 'normalized' | 'exact';
}
export type RunStatus = 'passed' | 'completed' | 'wrong_answer' | 'compile_error' | 'runtime_error' | 'timeout' | 'cancelled' | 'output_limit' | 'environment_error' | 'invalid_request' | 'internal_error';
export interface Diagnostic {
  phase: 'request' | 'environment' | 'compile' | 'run' | 'compare';
  message: string;
  source?: 'user' | 'runner';
  file?: string;
  /** One-based position in the user's original editor text; omitted for wrapper-only failures. */
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  code?: string;
}
export interface RunEvent {
  runId: string;
  sequence: number;
  at: string;
  phase: 'queued' | 'compile' | 'run' | 'finished';
  caseIndex?: number;
  status?: RunStatus;
}
export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
  /** Optional archive identifier; otherwise the runner creates a UUID. */
  runId?: string;
}
export interface CaseResult { index: number; status: RunStatus; actual?: WireValue; expected?: WireValue; stdout: string; stderr: string; durationMs: number; }
export interface RunResult {
  status: RunStatus;
  diagnostics: Diagnostic[];
  stdout: string;
  stderr: string;
  caseResults: CaseResult[];
  runtimeVersion: string;
  durationMs: number;
  executionScope: 'local-user-code-not-sandboxed';
  hostPlatform: string;
}
