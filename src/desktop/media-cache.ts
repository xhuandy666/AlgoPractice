import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ProblemContent } from '../shared/library';

// Exact origins observed in public LeetCode CN problem statements. No wildcard,
// cookies, arbitrary redirects or renderer network access is allowed.
const imageHosts = new Set(['assets.leetcode.com', 'assets.leetcode.cn', 'pic.leetcode.cn', 'aliyun-lc-upload.oss-cn-hangzhou.aliyuncs.com']);
const maxImages = 20;
const maxImageBytes = 8 * 1024 * 1024;
const localImage = /^algopractice:\/\/app\/media\/([a-f0-9]{64})$/;
const imageMagic = (bytes: Uint8Array) => {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true;
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return true;
  if (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a') return true;
  return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
};

interface ImageSource { start: number; end: number; value: string; quoted: boolean; }
const space = (value: string | undefined) => value !== undefined && /[\t\n\f\r ]/.test(value);
function tagEnd(html: string, start: number): number {
  let quote = '';
  for (let cursor = start; cursor < html.length; cursor++) {
    const char = html[cursor];
    if (quote) { if (char === quote) quote = ''; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return cursor;
  }
  return -1;
}
// Keep source offsets so only the src attribute value changes. Quoted alt text,
// data-src, comments, and raw-text elements must never become image requests.
function imageSources(html: string): ImageSource[] {
  const images: ImageSource[] = [];
  let offset = 0;
  while (offset < html.length) {
    const start = html.indexOf('<', offset); if (start < 0) break;
    if (html.startsWith('<!--', start)) { const end = html.indexOf('-->', start + 4); offset = end < 0 ? html.length : end + 3; continue; }
    const tag = /^<([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])/i.exec(html.slice(start));
    const end = tagEnd(html, start + 1); if (end < 0) break;
    offset = end + 1;
    if (!tag) continue;
    const name = tag[1].toLowerCase();
    if (name === 'plaintext') break;
    if (['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes'].includes(name)) {
      const closing = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi'); closing.lastIndex = offset;
      const close = closing.exec(html); if (!close) break;
      const closeEnd = tagEnd(html, close.index + 2); offset = closeEnd < 0 ? html.length : closeEnd + 1; continue;
    }
    if (name !== 'img') continue;
    let cursor = start + tag[0].length;
    while (cursor < end) {
      while (space(html[cursor]) || html[cursor] === '/') cursor++;
      const attributeStart = cursor;
      while (cursor < end && !space(html[cursor]) && !['/', '=', '>'].includes(html[cursor])) cursor++;
      if (cursor === attributeStart) break;
      const attribute = html.slice(attributeStart, cursor).toLowerCase();
      while (space(html[cursor])) cursor++;
      if (html[cursor] !== '=') { if (attribute === 'src') break; continue; }
      cursor++; while (space(html[cursor])) cursor++;
      const quote = html[cursor] === '"' || html[cursor] === "'" ? html[cursor++] : '';
      const valueStart = cursor;
      if (quote) { while (cursor < end && html[cursor] !== quote) cursor++; }
      else { while (cursor < end && !space(html[cursor])) cursor++; }
      const valueEnd = cursor;
      if (quote) cursor++;
      if (attribute === 'src') {
        images.push({ start: valueStart, end: valueEnd, value: html.slice(valueStart, valueEnd), quoted: Boolean(quote) });
        break; // HTML uses the first occurrence of a duplicate attribute.
      }
    }
  }
  return images;
}
function attributeValue(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()];
    const number = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : whole;
  });
}
async function imageBytes(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (!response.ok || !response.body || !/^image\/(png|jpe?g|gif|webp)\b/i.test(response.headers.get('content-type') || '')
    || Number(response.headers.get('content-length')) > maxImageBytes) {
    await response.body?.cancel().catch(() => {}); throw new Error('Unsupported or oversized image response');
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
      size += value.byteLength; if (size > maxImageBytes) throw new Error('Image exceeds 8 MiB'); chunks.push(value);
    }
    const bytes = Buffer.concat(chunks); if (!imageMagic(bytes)) throw new Error('Invalid image bytes'); return bytes;
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
function validLocalFile(path: string, hash: string): boolean {
  try {
    const stat = statSync(path); if (!stat.isFile() || stat.size > maxImageBytes) return false;
    const bytes = readFileSync(path); return imageMagic(bytes) && createHash('sha256').update(bytes).digest('hex') === hash;
  } catch { return false; }
}

export async function cacheProblemMedia(content: ProblemContent, directory: string, signal?: AbortSignal): Promise<ProblemContent> {
  signal?.throwIfAborted();
  if (content.descriptionFormat !== 'html') return content;
  const images = imageSources(content.description); if (!images.length) return content;
  mkdirSync(directory, { recursive: true });
  const missing: string[] = [];
  const cached = new Map<string, string | null>();
  const replacements: Array<ImageSource & { replacement: string }> = [];
  for (const image of images) {
    signal?.throwIfAborted();
    const original = attributeValue(image.value);
    try {
      const existing = localImage.exec(original);
      if (existing) {
        if (!validLocalFile(join(directory, existing[1]), existing[1])) throw new Error('Missing or invalid cached image');
        continue;
      }
      const url = new URL(original);
      if (url.protocol !== 'https:' || !imageHosts.has(url.hostname) || url.port || url.username || url.password) throw new Error('Unsupported image origin');
      let local = cached.get(url.href);
      if (local === null) throw new Error('Image already unavailable');
      if (local === undefined) {
        if (cached.size >= maxImages) throw new Error('Image count limit');
        cached.set(url.href, null);
        const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000);
        const response = await fetch(url, { signal: combined, redirect: 'error', credentials: 'omit' });
        const bytes = await imageBytes(response, combined); signal?.throwIfAborted();
        const hash = createHash('sha256').update(bytes).digest('hex'); const target = join(directory, hash);
        if (!validLocalFile(target, hash)) {
          const temporary = `${target}.${randomUUID()}.partial`;
          try { writeFileSync(temporary, bytes, { mode: 0o600 }); renameSync(temporary, target); }
          finally { if (existsSync(temporary)) unlinkSync(temporary); }
        }
        local = `algopractice://app/media/${hash}`; cached.set(url.href, local);
      }
      replacements.push({ ...image, replacement: local });
    } catch (error) {
      if (signal?.aborted) throw error;
      missing.push(original.slice(0, 2048));
      // An unavailable image has no src, so the renderer displays its placeholder.
      replacements.push({ ...image, replacement: image.quoted ? '' : '""' });
    }
  }
  let html = content.description;
  for (const image of replacements.reverse()) html = html.slice(0, image.start) + image.replacement + html.slice(image.end);
  return { ...content, description: html, media: { complete: missing.length === 0, missingUrls: [...new Set(missing)] } };
}
