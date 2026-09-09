import { SourceError } from './errors.ts';
import type { SourceReference } from './types.ts';

export function parseSource(input: string): SourceReference {
  if (typeof input !== 'string' || input.length > 2048) throw new SourceError('INVALID_URL', '来源链接必须是最多 2048 字符的文本。');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new SourceError('INVALID_URL', '请输入完整的 HTTPS 力扣国服链接。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'leetcode.cn' || url.port || url.username || url.password) throw new SourceError('UNSUPPORTED_SOURCE', '仅支持 https://leetcode.cn 的标准链接。');
  const match = url.pathname.match(/^\/(studyplan|problem-list|problems)\/([A-Za-z0-9_-]+)(?:\/(description|editorial|solutions|submissions))?\/?$/);
  if (!match || (match[3] && match[1] !== 'problems')) throw new SourceError('UNSUPPORTED_SOURCE', '仅识别官方学习计划、收藏题单和单题链接；讨论帖后置。');
  const kind = ({ studyplan: 'study-plan', 'problem-list': 'public-list', problems: 'problem' } as const)[match[1] as 'studyplan' | 'problem-list' | 'problems'];
  return { provider: 'leetcode-cn', kind, slug: match[2], canonicalUrl: `https://leetcode.cn/${match[1]}/${match[2]}/`, sourceKey: `leetcode-cn:${kind}:${match[2]}` };
}
export function identifySources(inputs: readonly string[]) {
  const sources: SourceReference[] = []; const duplicates: Array<{ inputIndex: number; firstInputIndex: number; sourceKey: string }> = [];
  const errors: Array<{ inputIndex: number; error: ReturnType<SourceError['toJSON']> }> = []; const seen = new Map<string, number>();
  inputs.forEach((input, inputIndex) => {
    try { const ref = parseSource(input); const first = seen.get(ref.sourceKey);
      if (first !== undefined) duplicates.push({ inputIndex, firstInputIndex: first, sourceKey: ref.sourceKey });
      else { seen.set(ref.sourceKey, inputIndex); sources.push(ref); }
    } catch (error) { if (!(error instanceof SourceError)) throw error; errors.push({ inputIndex, error: error.toJSON() }); }
  });
  return { sources, duplicates, errors };
}
