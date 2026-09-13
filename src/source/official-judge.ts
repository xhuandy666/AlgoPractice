import type { OfficialError, OfficialJudgeResult, OfficialSubmission } from '../shared/official.ts';

const ORIGIN = 'https://leetcode.cn';
const MAX_RESPONSE = 512 * 1024;
type ObjectData = Record<string, unknown>;
const object = (value: unknown): value is ObjectData => value !== null && typeof value === 'object' && !Array.isArray(value);

export class OfficialJudgeError extends Error {
  constructor(readonly detail: OfficialError, readonly uncertain = false) { super(detail.message); this.name = 'OfficialJudgeError'; }
}
export function officialUrl(path: string): string {
  const url = new URL(path, ORIGIN);
  if (url.protocol !== 'https:' || url.hostname !== 'leetcode.cn' || url.port || url.username || url.password || url.hash) {
    throw new OfficialJudgeError({ code: 'protocol', message: '官方判题请求地址无效。' });
  }
  return url.href;
}
export function officialProblemSlug(sourceUrl: string | undefined): string {
  if (!sourceUrl) throw new Error('这道题还没有力扣题目链接。');
  let url: URL;
  try { url = new URL(officialUrl(sourceUrl)); } catch { throw new Error('仅支持力扣国服题目。'); }
  const match = /^\/problems\/([a-z0-9][a-z0-9-]*)\/(?:description\/?)?$/.exec(`${url.pathname.replace(/\/$/, '')}/`);
  if (!match || url.search) throw new Error('力扣题目链接无效，请重新导入题目。');
  return match[1];
}
export function officialSubmissionUrl(id: string): string {
  if (!/^\d{1,30}$/.test(id)) throw new Error('Invalid official submission id');
  return `${ORIGIN}/submissions/detail/${id}/`;
}
export function validCsrfCookie(cookie: { name: string; value: string; domain?: string; path?: string; expirationDate?: number }): boolean {
  return cookie.name === 'csrftoken' && ['leetcode.cn', '.leetcode.cn'].includes(cookie.domain ?? '')
    && cookie.path === '/' && /^[A-Za-z0-9_-]{16,256}$/.test(cookie.value)
    && (!cookie.expirationDate || cookie.expirationDate * 1000 > Date.now());
}
const optionalString = (value: unknown): string | undefined => typeof value === 'string' ? value.slice(0, 32_000) : undefined;
const count = (value: unknown): number | undefined => {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && (number as number) >= 0 ? number as number : undefined;
};
const verdicts: Record<number, OfficialJudgeResult['status']> = {
  10: 'accepted', 11: 'wrong_answer', 12: 'memory_limit', 13: 'output_limit',
  14: 'timeout', 15: 'runtime_error', 16: 'internal_error', 20: 'compile_error',
};
/** LeetCode check fixtures use STARTED/PENDING while judging and SUCCESS for a terminal verdict. */
export function parseOfficialCheck(data: unknown): { pending: boolean; result?: OfficialJudgeResult } {
  if (!object(data)) throw new OfficialJudgeError({ code: 'protocol', message: '力扣返回了无法识别的判题结果，请稍后继续查询。' });
  if (data.state === 'PENDING' || data.state === 'STARTED') return { pending: true };
  if (data.state !== 'SUCCESS' || (!Number.isSafeInteger(data.status_code) && typeof data.status_msg !== 'string')) {
    throw new OfficialJudgeError({ code: 'protocol', message: '力扣返回了无法识别的判题结果，请稍后继续查询。' });
  }
  const result: OfficialJudgeResult = {
    status: verdicts[data.status_code as number] ?? 'unknown',
    statusMessage: optionalString(data.status_msg) ?? '力扣已完成判题',
  };
  if (Number.isSafeInteger(data.status_code)) result.statusCode = data.status_code as number;
  const passed = count(data.total_correct), total = count(data.total_testcases);
  if (passed !== undefined && (total === undefined || passed <= total)) result.passedCases = passed;
  if (total !== undefined) result.totalCases = total;
  const fields: Array<[keyof OfficialJudgeResult, unknown]> = [
    ['runtime', data.status_runtime], ['memory', data.status_memory],
    ['compileError', data.full_compile_error ?? data.compile_error], ['runtimeError', data.full_runtime_error ?? data.runtime_error],
    ['input', data.last_testcase ?? data.input], ['expectedOutput', data.expected_output], ['actualOutput', data.code_output],
  ];
  for (const [key, value] of fields) {
    const text = optionalString(value);
    if (text !== undefined) (result as unknown as ObjectData)[key] = text;
  }
  return { pending: false, result };
}
export interface OfficialJudgeTransport {
  authenticated(signal?: AbortSignal): Promise<boolean>;
  submit(input: Pick<OfficialSubmission, 'slug' | 'sourceId' | 'language' | 'code'>, signal?: AbortSignal): Promise<string>;
  check(submissionId: string, signal?: AbortSignal): Promise<{ pending: boolean; result?: OfficialJudgeResult }>;
}
/** Uses the isolated Electron session; neither cookies nor CSRF values leave this main-process transport. */
export class LeetCodeOfficialJudge implements OfficialJudgeTransport {
  constructor(private readonly options: { fetchImpl: typeof fetch; csrfToken: () => Promise<string | undefined> }) {}

  async #request(path: string, init: RequestInit, signal?: AbortSignal, submitting = false): Promise<unknown> {
    const url = officialUrl(path);
    let response: Response;
    try {
      response = await this.options.fetchImpl(url, { ...init, credentials: 'include', redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    } catch {
      throw new OfficialJudgeError({ code: 'network', message: submitting
        ? '未能确认力扣是否收到提交。为避免重复提交，请先在力扣提交记录中核对。'
        : '暂时无法连接力扣，请稍后重试。' }, submitting);
    }
    if (response.status === 401) throw new OfficialJudgeError({ code: 'authentication', message: '请先登录力扣国服，再提交代码。' });
    if (response.status === 429) throw new OfficialJudgeError({ code: 'rate_limit', message: '力扣暂时限制了请求频率，请稍后再试。' });
    if (response.status === 403) throw new OfficialJudgeError({ code: 'verification', message: '力扣需要重新登录或完成验证，请打开力扣登录窗口处理后重试。' });
    if (!response.ok || response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new OfficialJudgeError({ code: response.status >= 300 && response.status < 400 ? 'verification' : 'rejected',
        message: submitting ? '力扣未返回有效的提交编号，请到官方提交记录中核对。' : '力扣暂时无法完成查询，请稍后重试。' },
      submitting && (response.status >= 500 || response.redirected || (response.status >= 300 && response.status < 400)));
    }
    try {
      if (!/\bapplication\/json\b/i.test(response.headers.get('content-type') ?? '')) {
        throw new OfficialJudgeError({ code: 'verification', message: '力扣返回了验证页面，请打开力扣登录窗口完成验证。' }, submitting);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No body');
      let bytes = 0;
      const decoder = new TextDecoder();
      let text = '';
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_RESPONSE) { await reader.cancel(); throw new Error('Oversized response'); }
          text += decoder.decode(next.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof OfficialJudgeError) throw error;
      throw new OfficialJudgeError({ code: 'protocol', message: submitting
        ? '未能读取力扣提交编号，请先在官方提交记录中核对，避免重复提交。' : '力扣返回的数据暂时无法读取，请稍后继续查询。' }, submitting);
    }
  }
  async #headers(referer: string, requireCsrf = false): Promise<HeadersInit> {
    const csrf = await this.options.csrfToken();
    if (requireCsrf && !csrf) throw new OfficialJudgeError({ code: 'authentication', message: '登录状态需要刷新，请打开力扣登录窗口后重试。' });
    return { 'Content-Type': 'application/json', Accept: 'application/json', Origin: ORIGIN,
      Referer: officialUrl(referer), ...(csrf ? { 'X-CSRFToken': csrf } : {}) };
  }
  async authenticated(signal?: AbortSignal): Promise<boolean> {
    const data = await this.#request('/graphql/', { method: 'POST', headers: await this.#headers('/'),
      body: JSON.stringify({ query: 'query globalData { userStatus { isSignedIn } }', operationName: 'globalData' }) }, signal);
    if (object(data) && object(data.data) && object(data.data.userStatus) && typeof data.data.userStatus.isSignedIn === 'boolean') return data.data.userStatus.isSignedIn;
    throw new OfficialJudgeError({ code: 'protocol', message: '暂时无法确认力扣登录状态，请打开登录窗口后重试。' });
  }
  async submit(input: Pick<OfficialSubmission, 'slug' | 'sourceId' | 'language' | 'code'>, signal?: AbortSignal): Promise<string> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(input.slug) || !/^\d{1,30}$/.test(input.sourceId) || !['python', 'java'].includes(input.language)) {
      throw new OfficialJudgeError({ code: 'protocol', message: '题目缺少官方提交信息，请重新导入题目。' });
    }
    const data = await this.#request(`/problems/${input.slug}/submit/`, { method: 'POST',
      headers: await this.#headers(`/problems/${input.slug}/`, true), body: JSON.stringify({
        lang: input.language === 'python' ? 'python3' : 'java', question_id: input.sourceId, typed_code: input.code,
      }) }, signal, true);
    if (object(data)) {
      const value = data.submission_id;
      const id = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : '';
      if (/^\d{1,30}$/.test(id)) return id;
    }
    throw new OfficialJudgeError({ code: 'protocol', message: '力扣没有返回提交编号，请先到官方提交记录中核对。' }, true);
  }
  async check(submissionId: string, signal?: AbortSignal) {
    const resultUrl = officialSubmissionUrl(submissionId);
    return parseOfficialCheck(await this.#request(`${resultUrl}check/`, { method: 'GET', headers: { Accept: 'application/json', Referer: resultUrl } }, signal));
  }
}
