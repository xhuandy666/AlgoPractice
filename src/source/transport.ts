import { createHash } from 'node:crypto';
import { checkCancelled, failSchema, nonempty, record, SourceError, type ObjectValue } from './errors.ts';
import type { FetchOptions, Observation } from './types.ts';

export interface SourceAdapterOptions {
  fetchImpl?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number; maxPlanItems?: number;
  pageSize?: number; maxPages?: number; sessionMode?: 'anonymous' | 'user-session';
}
export class SourceTransport {
  readonly sessionMode: 'anonymous' | 'user-session';
  readonly maxPlanItems: number; readonly pageSize: number; readonly maxPages: number;
  private readonly fetchImpl: typeof fetch; private readonly timeoutMs: number; private readonly maxResponseBytes: number;
  constructor(options: SourceAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch; this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024; this.maxPlanItems = options.maxPlanItems ?? 1000;
    this.pageSize = options.pageSize ?? 50; this.maxPages = options.maxPages ?? 20; this.sessionMode = options.sessionMode ?? 'anonymous';
    for (const [name, value, upper] of [['timeoutMs', this.timeoutMs, 30000], ['maxResponseBytes', this.maxResponseBytes, 2 * 1024 * 1024], ['maxPlanItems', this.maxPlanItems, 1000], ['pageSize', this.pageSize, 100], ['maxPages', this.maxPages, 40]] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > upper) throw new RangeError(`${name} must be between 1 and ${upper}`);
    }
  }
  async html(url: string, options: FetchOptions = {}) {
    const response = await this.request(url, undefined, options);
    const embedded = response.text.match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i);
    if (!embedded) {
      if (/cf-chl-|<title>\s*Just a moment/i.test(response.text)) throw new SourceError('ACCESS_CHALLENGE', '来源显示访问验证页面，请在正常登录窗口处理后重试。', { httpStatus: 200 });
      return failSchema('__NEXT_DATA__');
    }
    let next: ObjectValue | null;
    try { next = record(JSON.parse(embedded[1])); } catch { return failSchema('__NEXT_DATA__.json'); }
    if (!next) return failSchema('__NEXT_DATA__');
    return { next, observation: { ...response.observation, buildId: nonempty(next.buildId) ? next.buildId : null } };
  }
  async graphql(query: string, variables: ObjectValue, referer: string, options: FetchOptions = {}) {
    const response = await this.request('https://leetcode.cn/graphql/', { query, variables, referer }, options);
    let body: ObjectValue | null;
    try { body = record(JSON.parse(response.text)); } catch { throw new SourceError('INVALID_CONTENT', '来源未返回可解析的 JSON。'); }
    if (!body) return failSchema('graphql.response');
    if (Array.isArray(body.errors) && body.errors.length) {
      const errors = body.errors.map(record); const codes = errors.map(e => String(record(e?.extensions)?.code ?? '').toUpperCase());
      const messages = errors.map(e => typeof e?.message === 'string' ? e.message : '').join(' ');
      if (codes.some(c => /UNAUTHENTICATED|LOGIN_REQUIRED/.test(c)) || /not logged in|login required|authentication required|请先登录|未登录/i.test(messages)) throw new SourceError('AUTH_REQUIRED', '来源要求有效登录，请重新连接后重试。');
      if (codes.includes('FORBIDDEN') || /permission denied|not authorized|没有权限|无权访问/i.test(messages)) throw new SourceError('ACCESS_DENIED', '当前会话没有访问这个来源的权限。');
      if (codes.some(c => /RATE_LIMIT/.test(c))) throw new SourceError('RATE_LIMITED', '来源限制请求频率，请稍后重试。', {}, true);
      throw new SourceError('GRAPHQL_ERROR', '来源返回接口错误；未使用可能不完整的部分数据。', { errorCount: body.errors.length });
    }
    return { data: record(body.data) ?? failSchema('graphql.data'), observation: response.observation };
  }
  private async request(url: string, post: { query: string; variables: ObjectValue; referer: string } | undefined, options: FetchOptions) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'leetcode.cn' || target.port || target.username || target.password) throw new SourceError('UNSUPPORTED_SOURCE', '来源请求域名无效。');
    checkCancelled(options.signal);
    const deadline = AbortSignal.timeout(this.timeoutMs); const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    try {
      const response = await this.fetchImpl(url, { method: post ? 'POST' : 'GET', redirect: 'manual', credentials: this.sessionMode === 'user-session' ? 'include' : 'omit', signal,
        headers: post ? { Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://leetcode.cn', Referer: post.referer } : { Accept: 'text/html' },
        ...(post ? { body: JSON.stringify({ query: post.query, variables: post.variables }) } : {}),
      });
      const status = response.status;
      const reject = async (error: SourceError): Promise<never> => { try { await response.body?.cancel(); } catch { /* Preserve the site error. */ } throw error; };
      if (status === 401) return reject(new SourceError('AUTH_REQUIRED', '站点要求登录。', { httpStatus: status }));
      if (status === 403) return reject(new SourceError('ACCESS_DENIED', '站点返回 HTTP 403，未尝试绕过限制。', { httpStatus: status }));
      if (status === 404) return reject(new SourceError('NOT_FOUND', '站点返回 HTTP 404。', { httpStatus: status }));
      if (status === 429) {
        const value = response.headers.get('retry-after'); const seconds = value && /^\d+$/.test(value) ? Number(value) : null;
        const dateDelay = value ? Date.parse(value) - Date.now() : NaN;
        const retryAfterMs = seconds !== null ? Math.min(seconds * 1000, 86400000) : Number.isFinite(dateDelay) ? Math.max(0, Math.min(dateDelay, 86400000)) : null;
        return reject(new SourceError('RATE_LIMITED', '站点限制请求频率；不会自动无限重试。', { httpStatus: status, retryAfterMs }, true));
      }
      if (status >= 300 && status < 400) {
        let isLogin = false;
        try { const location = new URL(response.headers.get('location') ?? '', url); isLogin = location.protocol === 'https:' && location.hostname === 'leetcode.cn' && /^\/(accounts\/login|login|account\/login)(?:\/|$)/.test(location.pathname); } catch { /* Invalid redirects stay blocked. */ }
        return reject(new SourceError(isLogin ? 'AUTH_REQUIRED' : 'REDIRECT_BLOCKED', isLogin ? '来源跳转到登录，请重新连接。' : '来源要求未经验证的跳转，已停止请求。', { httpStatus: status }));
      }
      if (status !== 200) return reject(new SourceError('HTTP_ERROR', '站点返回非预期状态。', { httpStatus: status }, status >= 500));
      if (!response.headers.get('content-type')?.toLowerCase().includes(post ? 'application/json' : 'text/html')) return reject(new SourceError('INVALID_CONTENT', post ? '来源未返回 JSON。' : '来源未返回 HTML。', { httpStatus: status }));
      if (Number(response.headers.get('content-length')) > this.maxResponseBytes) return reject(new SourceError('RESPONSE_TOO_LARGE', '来源响应超过大小上限。'));
      if (!response.body) throw new SourceError('INVALID_CONTENT', '来源没有响应正文。');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      while (true) { checkCancelled(options.signal); const part = await reader.read(); if (part.done) break; bytes += part.value.length;
        if (bytes > this.maxResponseBytes) { await reader.cancel(); throw new SourceError('RESPONSE_TOO_LARGE', '来源响应超过大小上限。'); } chunks.push(part.value);
      }
      checkCancelled(options.signal);
      const buffer = Buffer.concat(chunks);
      const observation: Observation = { fetchedAt: new Date().toISOString(), httpStatus: status, responseBytes: bytes, responseSha256: createHash('sha256').update(buffer).digest('hex'), buildId: null,
        transport: post ? 'site-graphql' : 'public-html-embedded-data', authentication: this.sessionMode === 'user-session' ? 'session-transport' : 'none' };
      return { text: buffer.toString('utf8'), observation };
    } catch (error) {
      if (error instanceof SourceError) throw error;
      if (options.signal?.aborted) throw new SourceError('CANCELLED', '操作已取消。');
      if (deadline.aborted || (error instanceof Error && error.name === 'TimeoutError')) throw new SourceError('TIMEOUT', '来源请求超时，未取得完整结果。', {}, true);
      const cause = error instanceof Error ? record(error.cause) : null;
      const transportCode = typeof cause?.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code) ? cause.code : null;
      throw new SourceError('NETWORK_ERROR', '网络传输失败；不能据此认定站点拒绝或来源不存在。', { transportCode }, true);
    }
  }
}
