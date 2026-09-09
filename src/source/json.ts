import { SourceError } from './errors.ts';

/** Retains unsafe JSON integer tokens as decimal strings before JSON.parse can round them. */
export function parseLosslessJSON(text: string): unknown {
  let result = ''; let quoted = false; let escaped = false;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (quoted) { result += c; i++; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; result += c; i++; continue; }
    if (c === '-' || /[0-9]/.test(c)) {
      const match = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (match) { const token = match[0]; result += /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token; i += token.length; continue; }
    }
    result += c; i++;
  }
  return JSON.parse(result);
}
export function jsonValuePrefix(text: string): { value: unknown; consumed: number } {
  const leading = text.length - text.trimStart().length; const input = text.slice(leading);
  let end = 0; let quoted = false; let escaped = false; let depth = 0;
  if (input[0] === '[' || input[0] === '{' || input[0] === '"') {
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') { quoted = false; if (depth === 0) { end = i + 1; break; } } continue; }
      if (c === '"') quoted = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { if (--depth === 0) { end = i + 1; break; } }
    }
  } else { end = input.match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0].length ?? 0; }
  if (!end) throw new SourceError('INVALID_CONTENT', '样例不是完整 JSON 值。');
  return { value: parseLosslessJSON(input.slice(0, end)), consumed: leading + end };
}
export function htmlText(html: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', le: '≤', ge: '≥', times: '×', minus: '−', ndash: '–', mdash: '—' };
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:p|div|pre|ul|ol|li|h[1-6]|br|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, key: string) => {
      if (key[0] !== '#') return entities[key.toLowerCase()] ?? entity;
      const code = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }).replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
