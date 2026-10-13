import type { Language } from '../runner/types';
import type { ProblemContent } from './library';
import { LANGUAGES, languageLabel } from './languages';
import { supportsAdapter } from '../runner/values';
export const missingLanguageTemplateReason = (language: Language) => `当前缓存缺少 ${languageLabel(language)} 模板。线上题可在题库主动刷新题面与语言模板；进行中的旧练习仍保留原始快照。`;
export const unsupportedAdapterReason = (language: Language) => `${languageLabel(language)} 本地函数适配暂不支持此签名中的类型；可保存代码，或使用 ACM 自定义输入输出练习。`;

/** One runnable-content decision shared by the queue and its presentation. */
export function capability(content: ProblemContent, language?: Language) {
  const hasStatement = Boolean(content.description.trim());
  const templates = (language ? [language] : LANGUAGES).some(id => Boolean(content.starter[id]?.trim()) && (content.mode !== 'function' || !content.adapter || supportsAdapter(id, content.adapter)));
  if (language && content.mode === 'function' && content.adapter && content.starter[language]?.trim() && !supportsAdapter(language, content.adapter)) return { level: 'statement-only', label: '题面可读', canRun: false, reason: unsupportedAdapterReason(language) };
  if (language && !content.starter[language]?.trim()) return { level: hasStatement ? 'statement-only' : 'link-only', label: hasStatement ? '题面可读' : '仅链接', canRun: false, reason: missingLanguageTemplateReason(language) };
  if (!templates || (content.mode === 'function' && !content.adapter) || !content.cases.length) return { level: hasStatement ? 'statement-only' : 'link-only', label: hasStatement ? '题面可读' : '仅链接', canRun: false, reason: content.supportReason || '题面、函数签名、语言模板或用例尚未准备完整。' };
  const expected = content.cases.every(test => Object.hasOwn(test, 'expected'));
  return { level: expected ? 'sample-verified' : 'execution-only', label: expected ? hasStatement ? '本地可运行' : '本地可运行 · 缺题面' : '可运行 · 仅看输出', canRun: true,
    reason: expected ? '使用已缓存的本地用例，结果不等同于官方 AC。' : '用例没有完整的可信期望值，只展示实际输出。' };
}
