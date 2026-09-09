import type { Language } from '../runner/types';
import type { ProblemContent } from './library';

/** One runnable-content decision shared by the queue and its presentation. */
export function capability(content: ProblemContent, language?: Language) {
  const hasStatement = Boolean(content.description.trim());
  const templates = language ? Boolean(content.starter[language]?.trim()) : Boolean(content.starter.python?.trim() || content.starter.java?.trim());
  if (!templates || (content.mode === 'function' && !content.adapter) || !content.cases.length) return { level: hasStatement ? 'statement-only' : 'link-only', label: hasStatement ? '题面可读' : '仅链接', canRun: false, reason: content.supportReason || '题面、函数签名、语言模板或用例尚未准备完整。' };
  const expected = content.cases.every(test => Object.hasOwn(test, 'expected'));
  return { level: expected ? 'sample-verified' : 'execution-only', label: expected ? hasStatement ? '本地可运行' : '本地可运行 · 缺题面' : '可运行 · 仅看输出', canRun: true,
    reason: expected ? '使用已缓存的本地用例，结果不等同于官方 AC。' : '用例没有完整的可信期望值，只展示实际输出。' };
}
