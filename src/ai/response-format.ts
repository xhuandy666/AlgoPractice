import type { AiKind } from '../shared/ai.ts';

const MAX_CONTENT_CHARS = 128 * 1024;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_WRAPPER_CHARS = 512;
const defaultTitles: Record<AiKind, string> = {
  chat: '一起梳理这道题', hint: '一个思路提示', diagnosis: '检查当前代码',
  'official-review': '官方提交复盘', 'note-draft': '复盘笔记草稿',
};

function invalid(): never { throw new Error('Invalid AI response format'); }
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Locate one complete object without treating braces inside JSON strings as delimiters. */
function objectEnd(body: string, start: number): number {
  const stack: string[] = []; let quoted = false, escaped = false;
  for (let index = start; index < body.length; index++) {
    const char = body[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') { stack.push(char); if (stack.length > 64) return invalid(); }
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) return invalid();
      if (!stack.length) return index + 1;
    }
  }
  return invalid();
}

function unwrapObject(body: string): unknown {
  const start = body.indexOf('{'); if (start < 0) return invalid();
  const end = objectEnd(body, start);
  let prefix = body.slice(0, start), suffix = body.slice(end);
  if (prefix.length > MAX_WRAPPER_CHARS || suffix.length > MAX_WRAPPER_CHARS) return invalid();
  const opening = /```(?:json)?\s*$/i.exec(prefix), closing = /^\s*```(?:\s|$)/.exec(suffix);
  if (Boolean(opening) !== Boolean(closing)) return invalid();
  if (opening && closing) { prefix = prefix.slice(0, opening.index); suffix = suffix.slice(closing[0].length); }
  // Multiple objects, a surrounding array, another code block, or a partial second object are ambiguous.
  if (/[{}\[\]`]/.test(prefix + suffix)) return invalid();
  return JSON.parse(body.slice(start, end));
}

function plainChat(body: string): Record<string, unknown> {
  if (body.length > 8000 || !body.trim() || /^(?:[\[{"]|true\b|false\b|null\b)/i.test(body)) return invalid();
  // A broken structured answer must never become displayed prose. Complete non-JSON code fences
  // remain ordinary Markdown examples; they cannot create a patch or an apply action.
  if (/```\s*json\b/i.test(body) || /"(?:schemaVersion|kind|explanation|patch|completeSolution|noteDraft)"\s*:/.test(body)) return invalid();
  const prose = body.replace(/```(?!\s*json\b)[^\n]*\n[\s\S]*?```/gi, '');
  if (/[{}]/.test(prose) || !/[\u3400-\u9fff]|[a-z]{2,}\s+[a-z]{2,}/i.test(prose)) return invalid();
  return { schemaVersion: 2, kind: 'chat', explanation: body };
}

/** Formatting compatibility only. Identity, evidence and code proposals are validated by policy.ts. */
export function decodeResponseFormat(raw: string, kind: AiKind): unknown {
  if (typeof raw !== 'string' || raw.length > MAX_CONTENT_CHARS || Buffer.byteLength(raw, 'utf8') > MAX_CONTENT_BYTES) return invalid();
  const body = raw.trim(); if (!body) return invalid();
  let decoded: unknown;
  try { decoded = JSON.parse(body); }
  catch {
    const structured = body.startsWith('{') || /\{\s*(?:"|})/.test(body) || /```\s*json\b/i.test(body);
    // Once a response presents itself as JSON, any malformed object, wrapper or extra object
    // must go through the existing repair path rather than falling back to visible prose.
    if (structured) decoded = unwrapObject(body);
    else { if (kind !== 'chat') return invalid(); decoded = plainChat(body); }
  }
  if (!record(decoded)) return invalid();
  // Only absent presentation/optional fields receive defaults. Explicit null/wrong types are not repaired,
  // and schemaVersion/kind/explanation/unknown fields remain untouched for the strict validator.
  return { title: defaultTitles[kind], nextSteps: [], evidence: [], inferences: [], patch: null,
    completeSolution: null, noteDraft: null, ...decoded };
}
