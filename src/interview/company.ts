import { createHash } from 'node:crypto';
import { parseCSV } from '../source/imports';
import { parseSource } from '../source/identify';
import type { CompanyEntry, CompanyPreview } from '../shared/interview';
export function normalizeCompany(name: string): string { return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US'); }
const optional = (value: unknown, label: string): string | null => { if (value === undefined || value === null || value === '') return null; if (typeof value !== 'string' || value.length > 1000 || /[\u0000-\u001f]/.test(value)) throw new Error(`${label} 必须为不超过 1000 字的文本。`); return value.trim() || null; };
function url(value: unknown): string | null { const text = optional(value, 'URL'); if (!text) return null; const parsed = new URL(text); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('URL 仅支持不含凭据的 HTTP(S) 地址。'); return parsed.href; }
export function parseCompanyFile(input: { kind: 'csv' | 'json'; text: string; name: string }, knownIds: Set<string>, at = new Date().toISOString()): CompanyPreview {
  if (!input || !['csv', 'json'].includes(input.kind) || typeof input.text !== 'string' || Buffer.byteLength(input.text) > 4 * 1024 * 1024) throw new Error('请选择不超过 4 MiB 的 CSV/JSON 企业文件。');
  const name = optional(input.name, '文件名') || '企业题单'; let rows: unknown[];
  if (input.kind === 'csv') { const csv = parseCSV(input.text); if (csv.length < 2) throw new Error('企业文件没有数据。'); const headers = csv[0].map(v => v.trim()); if (headers.some(v => !v) || new Set(headers).size !== headers.length) throw new Error('CSV 表头不能为空或重复。'); rows = csv.slice(1).map(row => { if (row.length !== headers.length) return null; return Object.fromEntries(headers.map((key, i) => [key, row[i]])); }); }
  else { const parsed = JSON.parse(input.text.replace(/^\uFEFF/, '')); rows = Array.isArray(parsed) ? parsed : parsed?.entries; }
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new Error('企业文件需要 1–1000 条记录。');
  const errors: string[] = [], entries: CompanyEntry[] = [], seen = new Set<string>(); let duplicates = 0;
  rows.forEach((value, index) => { try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记录格式无效。'); const raw = value as Record<string, unknown>;
    const company = optional(raw.company, '公司名称'); if (!company) throw new Error('缺少 company 公司名称。');
    const problemUrl = url(raw.url); let problemId = optional(raw.problemId, '题目标识');
    if (problemUrl) { const source = parseSource(problemUrl); if (source.kind !== 'problem') throw new Error('url 必须指向单题。'); if (problemId && problemId !== source.sourceKey) throw new Error('problemId 与 URL 不一致。'); problemId = source.sourceKey; }
    if (!problemId || !/^[A-Za-z0-9_.:-]+$/.test(problemId)) throw new Error('需要题目 URL 或明确的 problemId。');
    const dataDate = optional(raw.dataDate, '数据日期'); if (dataDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dataDate) || Number.isNaN(Date.parse(dataDate)) || new Date(dataDate).toISOString().slice(0,10) !== dataDate)) throw new Error('dataDate 必须为有效 YYYY-MM-DD。');
    let frequency: number | null = null; if (raw.frequency !== undefined && raw.frequency !== null && raw.frequency !== '') { if (typeof raw.frequency !== 'number' && typeof raw.frequency !== 'string') throw new Error('frequency 必须为非负有限数。'); frequency = Number(raw.frequency); if (!Number.isFinite(frequency) || frequency < 0 || typeof raw.frequency === 'string' && !raw.frequency.trim()) throw new Error('frequency 必须为非负有限数。'); }
    const entry: CompanyEntry = { company, normalizedCompany: normalizeCompany(company), problemId, url: problemUrl, dataDate, sourceUrl: url(raw.sourceUrl), window: optional(raw.window, '统计窗口'), frequency, rawFrequency: raw.frequency === undefined || raw.frequency === null || raw.frequency === '' ? null : String(raw.frequency), frequencyMeaning: optional(raw.frequencyMeaning, '频率口径') };
    const key = JSON.stringify(entry); if (seen.has(key)) { duplicates++; return; } seen.add(key); entries.push(entry);
  } catch (error) { errors.push(`第 ${index + 1} 条：${error instanceof Error ? error.message : '格式错误'}`); } });
  const fileHash = createHash('sha256').update(input.text).digest('hex');
  return { dataset: { id: `company:${fileHash}`, name, fileHash, importedAt: at, entries }, errors, duplicates, missingProblemIds: [...new Set(entries.filter(e => !knownIds.has(e.problemId)).map(e => e.problemId))] };
}
