import { assertAnswerFormat, type AnswerFormat } from '../shared/answer-format';

/** Saved preferences are not contracts; explicit selections and active attempts are. */
export function selectPracticeFormat(nativeFormat: AnswerFormat, preferredFormat: unknown, requested: unknown,
  hasActiveFunctionAttempt: () => boolean): AnswerFormat {
  const format = requested ?? preferredFormat ?? nativeFormat;
  assertAnswerFormat(format);
  if (requested === undefined && format === 'function' && nativeFormat === 'acm' && !hasActiveFunctionAttempt()) return 'acm';
  return format;
}
