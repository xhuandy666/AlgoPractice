import type { ProblemContent } from './library';
import type { Language, TestCase } from '../runner/types';

/** Answer syntax is independent from practice / strict / coached training modes. */
export type AnswerFormat = 'function' | 'acm';
export type AcmCompare = 'normalized' | 'exact';
export interface AcmTestCase { stdin: string; expected?: string; }
export interface AcmTestConfig {
  version: 1;
  cases: AcmTestCase[];
  compare: AcmCompare;
}
export interface PracticeSpec {
  problemId: string;
  problemVersion: string;
  answerFormat: AnswerFormat;
  specVersion: string;
  source: 'native' | 'custom';
  expectedOutputSource: 'native-samples' | 'user' | 'none';
  inputDescription: string;
  outputDescription: string;
  /** A disposable execution view; never persist over the original problem snapshot. */
  content: ProblemContent;
}
export const ACM_FREE_SPEC_VERSION = 'acm-free-v1';
export const NATIVE_SPEC_VERSION = 'native-v1';
export const ACM_STARTERS: Record<Language, string> = {
  python: 'import sys\n\ndef main():\n    data = sys.stdin.read()\n    # 在这里解析输入、实现算法，并使用 print 输出结果。\n    pass\n\nif __name__ == "__main__":\n    main()\n',
  java: 'import java.io.*;\nimport java.nio.charset.StandardCharsets;\n\npublic class Main {\n    public static void main(String[] args) throws Exception {\n        String input = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);\n        // 在这里解析输入、实现算法，并使用 System.out 输出结果。\n    }\n}\n',
};
export function assertAnswerFormat(value: unknown): asserts value is AnswerFormat {
  if (value !== 'function' && value !== 'acm') throw new Error('答题格式无效。');
}
/** Bound IPC payloads before snapshots, probes, or execution. Empty stdin/expected are valid. */
export function validateAcmTestConfig(value: unknown): AcmTestConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ACM 测试配置无效。');
  const input = value as AcmTestConfig;
  if (input.version !== 1 || !['normalized', 'exact'].includes(input.compare)
    || !Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 50) throw new Error('请提供 1–50 组有效的 ACM 用例。');
  let total = 0;
  const cases = input.cases.map(test => {
    if (!test || typeof test !== 'object' || typeof test.stdin !== 'string'
      || (Object.hasOwn(test, 'expected') && typeof test.expected !== 'string')) throw new Error('标准输入与期望输出必须是文本。');
    total += new TextEncoder().encode(test.stdin).length + new TextEncoder().encode(test.expected ?? '').length;
    if (total > 1024 * 1024) throw new Error('ACM 输入输出总大小不能超过 1 MiB。');
    return { stdin: test.stdin, ...(Object.hasOwn(test, 'expected') ? { expected: test.expected! } : {}) };
  });
  return { version: 1, compare: input.compare, cases };
}
/** Canonical bytes used for SHA-256 in main and for comparing pending renderer edits. */
export function serializeAcmTestConfig(value: AcmTestConfig): string {
  const normalized = validateAcmTestConfig(value);
  return JSON.stringify({ cases: normalized.cases.map(test => ({
    ...(Object.hasOwn(test, 'expected') ? { expected: test.expected } : {}), stdin: test.stdin,
  })), compare: normalized.compare, version: normalized.version });
}
export function defaultAcmTestConfig(content: ProblemContent): AcmTestConfig {
  const native = content.mode === 'acm' ? content.cases.filter(test => typeof test.stdin === 'string') : [];
  return { version: 1, compare: content.acmCompare ?? 'normalized', cases: native.length ? native.map(test => ({
    stdin: test.stdin!, ...(typeof test.expected === 'string' ? { expected: test.expected } : {}),
  })) : [{ stdin: '' }] };
}
export function resolvePracticeSpec(content: ProblemContent, problemVersion: string, answerFormat: AnswerFormat = content.mode,
  testConfig?: AcmTestConfig): PracticeSpec {
  assertAnswerFormat(answerFormat);
  if (answerFormat === 'function' && content.mode !== 'function') throw new Error('此题尚无可用的函数式适配器，请使用 ACM 格式。');
  const native = answerFormat === content.mode;
  const tests = answerFormat === 'acm' ? validateAcmTestConfig(testConfig ?? defaultAcmTestConfig(content)) : undefined;
  return { problemId: content.id, problemVersion, answerFormat, specVersion: native ? NATIVE_SPEC_VERSION : ACM_FREE_SPEC_VERSION,
    source: native ? 'native' : 'custom',
    expectedOutputSource: tests ? !tests.cases.some(test => Object.hasOwn(test, 'expected')) ? 'none'
      : native && serializeAcmTestConfig(tests) === serializeAcmTestConfig(defaultAcmTestConfig(content)) ? 'native-samples' : 'user'
      : content.cases.some(test => Object.hasOwn(test, 'expected')) ? 'native-samples' : 'none',
    inputDescription: answerFormat === 'function' ? '按题目签名传入结构化参数。' : native ? '每组用例一次性传入 stdin，随后关闭输入流（EOF）。' : '自定义输入输出，尚无已验证样例；自行约定输入编码。每组输入后关闭 stdin（EOF）。',
    outputDescription: answerFormat === 'function' ? '返回题目约定的值。' : '将答案写到 stdout。未设置期望输出时仅查看输出，不判为通过。',
    content: answerFormat === 'function' ? content : { ...content, mode: 'acm', adapter: undefined,
      starter: native ? { ...ACM_STARTERS, ...content.starter } : { ...ACM_STARTERS },
      cases: tests!.cases as TestCase[], acmCompare: tests!.compare,
      supportReason: native ? content.supportReason : '本地 ACM 自由练习；测试输入和期望输出由用户提供，不是力扣官方判题。' },
  };
}
