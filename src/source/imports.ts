import { createHash } from 'node:crypto';
import type { Adapter, TestCase, ValueType } from '../runner/types.ts';
import { observedType, validateType } from '../runner/values.ts';
import type { ProblemContent } from '../shared/library.ts';
import { checkCancelled, nonempty, record, SourceError, type ObjectValue } from './errors.ts';
import { parseSource } from './identify.ts';
import { parseLosslessJSON } from './json.ts';
import { typedValue } from './problem-content.ts';
import { LeetCodeCnSourceAdapter } from './index.ts';
import type { FetchOptions, ImportInput, ImportPreview, ImportPreviewItem, ParsedImport } from './types.ts';

const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
function invalid(message: string): never { throw new SourceError('INVALID_IMPORT', message); }
function text(value: unknown, label: string, limit = 1048576): string { if (typeof value !== 'string' || Buffer.byteLength(value) > limit) return invalid(`${label} 必须是长度受限的文本。`); return value; }
function strings(value: unknown, label: string): string[] {
  if (value === undefined || value === '') return [];
  if (typeof value === 'string') value = value.split(/[,;|]/).map(v => v.trim()).filter(Boolean);
  if (!Array.isArray(value) || value.length > 100 || !value.every(v => typeof v === 'string' && v.length <= 1000)) return invalid(`${label} 必须为字符串列表。`);
  return [...new Set(value as string[])];
}
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; const obj = record(value); if (obj) return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stable(obj[key])}`).join(',')}}`; return JSON.stringify(value); }

/** RFC 4180-style quoted fields, escaped quotes, CRLF, and embedded newlines; never evaluates cells. */
export function parseCSV(input: string): string[][] {
  if (Buffer.byteLength(input) > MAX_IMPORT_BYTES) return invalid('导入文件超过 4 MiB。');
  const source = input.replace(/^\uFEFF/, ''); const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false; let closed = false;
  const pushField = () => { row.push(field); field = ''; closed = false; if (row.length > 64) invalid('CSV 列数超过 64。'); };
  const pushRow = () => { pushField(); if (row.some(value => value.trim() !== '')) rows.push(row); row = []; if (rows.length > 1001) invalid('导入条目超过 1000。'); };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) { if (c === '"') { if (source[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; continue; }
    if (closed && c !== ',' && c !== '\r' && c !== '\n') { if (c === ' ' || c === '\t') continue; return invalid('CSV 引号结束后出现额外字符。'); }
    if (c === '"') { if (field !== '') return invalid('CSV 引号必须从字段开头开始。'); quoted = true; }
    else if (c === ',') pushField();
    else if (c === '\r' || c === '\n') { if (c === '\r' && source[i + 1] === '\n') i++; pushRow(); }
    else field += c;
  }
  if (quoted) return invalid('CSV 引号未闭合。');
  if (field !== '' || row.length || closed) pushRow(); return rows;
}
function fileAdapter(value: unknown): Adapter {
  const raw = record(value); if (!raw || !nonempty(raw.method) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.method) || !Array.isArray(raw.params) || raw.params.length > 20) return invalid('adapter 需要有效 method 和 params。');
  try { raw.params.forEach(t => validateType(t as ValueType)); if(raw.returns!=='void')validateType(raw.returns as ValueType); } catch { return invalid('adapter 包含不支持或不完整的类型。'); }
  const result: Adapter = { method: raw.method, params: raw.params as ValueType[], returns: raw.returns as Adapter['returns'] };
  if (raw.inPlaceArg !== undefined) { if (!Number.isInteger(raw.inPlaceArg) || Number(raw.inPlaceArg) < 0 || Number(raw.inPlaceArg) >= result.params.length) return invalid('inPlaceArg 不指向有效参数。'); result.inPlaceArg = Number(raw.inPlaceArg); }
  if (result.inPlaceArg !== undefined) { const target = result.params[result.inPlaceArg]; if (typeof target === 'string') return invalid('inPlaceArg 只能观察数组或列表参数。'); }
  try { observedType(result); } catch { return invalid('void 返回值必须用 inPlaceArg 明确观察数组或列表参数。'); }
  if (raw.inPlaceRange !== undefined) { const range = record(raw.inPlaceRange); if (result.inPlaceArg === undefined || !range || (range.end !== 'return' && (!Number.isInteger(range.end) || Number(range.end) < 0)) || (range.start !== undefined && (!Number.isInteger(range.start) || Number(range.start) < 0))) return invalid('inPlaceRange 无效。'); result.inPlaceRange = { ...(range.start !== undefined ? { start: Number(range.start) } : {}), end: range.end === 'return' ? 'return' : Number(range.end) };
    if (result.inPlaceRange.end === 'return' && result.returns !== 'int') return invalid('end:return 需要整型返回值。');
    if (typeof result.inPlaceRange.end === 'number' && result.inPlaceRange.end < (result.inPlaceRange.start ?? 0)) return invalid('原地修改范围的结束位置不能小于开始位置。');
  }
  if (raw.compare !== undefined) { const compare = record(raw.compare); if (!compare || !['exact', 'float', 'multiset'].includes(String(compare.kind))) return invalid('compare.kind 不受支持。');
    result.compare = { kind: compare.kind as 'exact' | 'float' | 'multiset' };
    for (const key of ['absoluteTolerance', 'relativeTolerance'] as const) { const value = compare[key]; if (value !== undefined) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return invalid('浮点容差必须为非负有限数。'); result.compare[key] = value; } }
  }
  return result;
}
function fileCases(value: unknown, mode: 'function' | 'acm', adapter?: Adapter): TestCase[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return invalid('cases 必须为最多 100 项的数组。');
  return value.map((entry, i) => {
    const test = record(entry); if (!test) return invalid(`用例 ${i + 1} 必须为对象。`);
    if (mode === 'acm') { if (test.args !== undefined) return invalid('ACM 用例使用 stdin，不使用 args。'); return { stdin: test.stdin === undefined ? '' : text(test.stdin, 'stdin'), ...(Object.hasOwn(test, 'expected') ? { expected: text(test.expected, 'ACM expected') } : {}) }; }
    if (!adapter || !Array.isArray(test.args) || test.args.length !== adapter.params.length || test.stdin !== undefined) return invalid(`函数用例 ${i + 1} 的参数数量/格式不匹配。`);
    try { return { args: test.args.map((value, index) => typedValue(value, adapter.params[index])), ...(Object.hasOwn(test, 'expected') ? { expected: typedValue(test.expected, observedType(adapter)) } : {}) }; }
    catch { return invalid(`函数用例 ${i + 1} 不符合 adapter 类型；int64/bigint 必须保留十进制精度。`); }
  });
}
function contentEntry(raw: ObjectValue, reference: ReturnType<typeof parseSource> | undefined): ProblemContent | undefined {
  const hasContent = ['description', 'adapter', 'cases', 'starter', 'python', 'java'].some(key => raw[key] !== undefined && raw[key] !== '');
  if (!hasContent) return undefined;
  if (!nonempty(raw.title)) return invalid('包含完整内容的文件题目需要 title。');
  if (reference && reference.kind !== 'problem') return invalid('完整题目内容不能关联到题单 URL。');
  const mode = raw.mode === undefined || raw.mode === '' ? 'function' : raw.mode;
  if (mode !== 'function' && mode !== 'acm') return invalid('mode 仅支持 function 或 acm。');
  const adapter = raw.adapter !== undefined ? fileAdapter(raw.adapter) : undefined;
  if (mode === 'acm' && adapter) return invalid('ACM 模式不使用函数 adapter。');
  const starterRaw = raw.starter === undefined ? {} : record(raw.starter); if (!starterRaw) return invalid('starter 必须为对象。');
  const starter: ProblemContent['starter'] = {};
  for (const language of ['python', 'java'] as const) { const code = starterRaw[language] ?? raw[language]; if (code !== undefined && code !== '') starter[language] = text(code, `${language} starter`); }
  const cases = fileCases(raw.cases, mode, adapter);
  const rawId = raw.id === undefined ? createHash('sha256').update(stable(raw)).digest('hex').slice(0, 24) : text(raw.id, 'id', 200);
  if (!/^[A-Za-z0-9_.:-]+$/.test(rawId)) return invalid('文件 id 仅允许字母、数字、点、下划线、冒号和短横线。');
  const id = reference?.sourceKey ?? (rawId.startsWith('file:') ? rawId : `file:${rawId}`);
  const format = raw.descriptionFormat ?? 'plain'; if (format !== 'plain' && format !== 'html') return invalid('descriptionFormat 仅支持 plain 或 html。');
  if (raw.acmCompare !== undefined && !['normalized', 'exact'].includes(String(raw.acmCompare))) return invalid('acmCompare 仅支持 normalized 或 exact。');
  return { id, title: text(raw.title, 'title', 1000), difficulty: typeof raw.difficulty === 'string' ? text(raw.difficulty, 'difficulty', 100) : '未标注', tags: strings(raw.tags, 'tags'),
    ...(reference ? { sourceUrl: reference.canonicalUrl } : {}), description: raw.description === undefined ? '' : text(raw.description, 'description', 2 * 1024 * 1024), descriptionFormat: format,
    constraints: strings(raw.constraints, 'constraints'), mode, ...(adapter ? { adapter } : {}), cases, starter, source: 'file',
    ...(mode === 'acm' && raw.acmCompare !== undefined ? { acmCompare: raw.acmCompare as 'normalized' | 'exact' } : {}),
    supportReason: !cases.length || (mode === 'function' && !adapter) ? '文件缺少可执行适配或用例；可保存题面与代码。' : cases.every(c => Object.hasOwn(c, 'expected')) ? '按用户文件显式提供的测试和比较规则验证；不是官方判题。' : '用户文件包含无期望值用例；相应用例只展示输出。' };
}
export function parseImportInput(input: ImportInput): ParsedImport {
  if (!input || !['url', 'links', 'csv', 'json'].includes(input.kind) || typeof input.text !== 'string') return invalid('导入输入格式无效。');
  if (Buffer.byteLength(input.text) > MAX_IMPORT_BYTES) return invalid('导入文本超过 4 MiB。');
  const parsed: ParsedImport = { inputKind: input.kind, listTitle: input.name?.trim() || '导入题单', entries: [], errors: [], warnings: [] };
  let rows: unknown[];
  if (input.kind === 'url' || input.kind === 'links') {
    rows = (input.kind === 'url' ? [input.text.trim()] : input.text.trim().split(/\s+/)).filter(Boolean).map(url => ({ url }));
  } else if (input.kind === 'csv') {
    const csv = parseCSV(input.text); if (!csv.length) return invalid('CSV 文件为空。');
    const headers = csv[0].map(value => value.trim().toLowerCase());
    if (new Set(headers).size !== headers.length || headers.some(h => !h)) return invalid('CSV 表头不得为空或重复。');
    const known = new Set(['url', 'link', 'id', 'title', 'difficulty', 'tags', 'chapter', 'description', 'python', 'java', 'mode']);
    const ignored = headers.filter(h => !known.has(h)); if (ignored.length) parsed.warnings.push(`忽略未识别的 CSV 列：${ignored.join('、')}`);
    rows = csv.slice(1).map((row, index) => {
      if (row.length !== headers.length) return { __csvError: `CSV 数据行 ${index + 2} 列数与表头不符。` };
      const object: ObjectValue = Object.create(null); headers.forEach((key, i) => { if (known.has(key) && row[i] !== '') object[key] = row[i]; }); return object;
    });
  } else {
    let json: unknown; try { json = parseLosslessJSON(input.text.replace(/^\uFEFF/, '')); } catch { return invalid('JSON 文件无法解析。'); }
    if (Array.isArray(json)) rows = json;
    else { const object = record(json); if (!object || (!Array.isArray(object.problems) && !Array.isArray(object.items))) return invalid('JSON 需要题目数组或 {title, problems:[...]}。');
      if (object.schemaVersion !== undefined && object.schemaVersion !== 1) return invalid('不支持这个文件 schemaVersion。');
      rows = (object.problems ?? object.items) as unknown[]; if (!input.name && nonempty(object.title)) parsed.listTitle = object.title;
    }
  }
  if (!rows.length || rows.length > 1000) return invalid('请提供 1 到 1000 条导入记录。');
  for (let inputIndex = 0; inputIndex < rows.length; inputIndex++) {
    try {
      const raw = typeof rows[inputIndex] === 'string' ? { url: rows[inputIndex] } : record(rows[inputIndex]); if (!raw) return invalid('每条记录必须是链接或对象。');
      if (raw.__csvError) throw new SourceError('INVALID_IMPORT', String(raw.__csvError));
      const url = raw.url ?? raw.link; const reference = url !== undefined ? parseSource(text(url, 'url', 2048)) : undefined;
      const content = contentEntry(raw, reference);
      if (!reference && !content) return invalid('记录需要题目 URL 或包含 title、description 等完整题目内容。');
      parsed.entries.push({ inputIndex, ...(reference ? { reference } : {}), ...(nonempty(raw.title) ? { title: text(raw.title, 'title', 1000) } : {}),
        ...(nonempty(raw.difficulty) ? { difficulty: text(raw.difficulty, 'difficulty', 100) } : {}), tags: strings(raw.tags, 'tags'), chapter: nonempty(raw.chapter) ? text(raw.chapter, 'chapter', 1000) : '全部题目', ...(content ? { content } : {}) });
    } catch (error) { parsed.errors.push({ inputIndex, code: error instanceof SourceError ? error.code : 'INVALID_IMPORT', message: error instanceof SourceError ? error.message : '记录结构无效。' }); }
  }
  return parsed;
}
export async function previewImport(input: ImportInput, options: FetchOptions & { adapter?: LeetCodeCnSourceAdapter } = {}): Promise<ImportPreview> {
  checkCancelled(options.signal); const parsed = parseImportInput(input); const adapter = options.adapter ?? new LeetCodeCnSourceAdapter();
  const preview: ImportPreview = { inputKind: input.kind, source: input.kind === 'csv' || input.kind === 'json' ? 'file' : input.kind === 'links' ? 'links' : 'leetcode-cn', listTitle: parsed.listTitle,
    chapters: [], items: [], duplicates: [], errors: [...parsed.errors], warnings: [...parsed.warnings], complete: false };
  if (parsed.entries.length === 1 && parsed.entries[0].reference) preview.sourceUrl = parsed.entries[0].reference.canonicalUrl;
  const seen = new Map<string, ImportPreviewItem>(); const expanded = new Set<string>(); const chapters = new Map<string, string>();
  const chapterId = (name: string) => { let id = chapters.get(name); if (!id) { id = `chapter-${chapters.size + 1}`; chapters.set(name, id); preview.chapters.push({ id, title: name, order: preview.chapters.length }); } return id; };
  const add = (item: Omit<ImportPreviewItem, 'order'>, inputIndex: number) => {
    const previous = seen.get(item.key);
    if (previous) {
      if (item.content && previous.content && stable(item.content) !== stable(previous.content)) preview.errors.push({ inputIndex, code: 'CONFLICTING_DUPLICATE', message: `相同题目标识 ${item.key} 提供了不同内容，请合并或更改 id。` });
      else if (item.content && !previous.content) previous.content = item.content;
      preview.duplicates.push({ inputIndex, key: item.key, reason: '保留首次成员位置；相同题目内容只导入一次。' }); return;
    }
    const result = { ...item, order: preview.items.length }; seen.set(result.key, result); preview.items.push(result);
    if (preview.items.length > 1000) throw new SourceError('PLAN_TOO_LARGE', '预览的唯一题目超过 1000 条。');
  };
  for (const entry of parsed.entries) {
    checkCancelled(options.signal);
    try {
      const reference = entry.reference;
      if (reference && reference.kind !== 'problem') {
        if (expanded.has(reference.sourceKey)) { preview.duplicates.push({ inputIndex: entry.inputIndex, key: reference.sourceKey, reason: '重复题单链接，未重复请求。' }); continue; }
        expanded.add(reference.sourceKey);
        const plan = await adapter.fetchPlan(reference, options); checkCancelled(options.signal);
        if (parsed.entries.length === 1 && !input.name) preview.listTitle = plan.name;
        for (const section of plan.sections) { const name = parsed.entries.length > 1 ? `${plan.name} / ${section.name}` : section.name;
          for (const question of section.questions) add({ key: question.sourceKey, problemId: question.sourceKey, sourceUrl: question.canonicalUrl, title: question.translatedTitle ?? question.title,
            difficulty: question.difficulty, tags: [], chapterId: chapterId(name), premiumOnly: question.premiumOnly }, entry.inputIndex);
        }
      } else {
        const id = entry.content?.id ?? reference!.sourceKey;
        add({ key: id, problemId: id, ...(reference ? { sourceUrl: reference.canonicalUrl } : {}), title: entry.content?.title ?? entry.title ?? reference!.slug,
          difficulty: entry.content?.difficulty ?? entry.difficulty ?? '待补全', tags: entry.content?.tags ?? entry.tags, chapterId: chapterId(entry.chapter), ...(entry.content ? { content: entry.content } : {}) }, entry.inputIndex);
      }
    } catch (error) {
      if (error instanceof SourceError && error.code === 'CANCELLED') throw error;
      preview.errors.push({ inputIndex: entry.inputIndex, code: error instanceof SourceError ? error.code : 'INVALID_IMPORT', message: error instanceof SourceError ? error.message : '来源预览失败。' });
    }
  }
  if (preview.items.some(item => !item.content && item.difficulty === '待补全')) preview.warnings.push('单题链接的题目名称与难度会在内容补全时更新；此预览未把链接占位视为已缓存题面。');
  preview.complete = preview.errors.length === 0; return preview;
}
