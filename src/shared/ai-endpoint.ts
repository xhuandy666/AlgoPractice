/** Public URL identity shared by the settings form and the credential-bound provider. */
export function normalizeAiBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('AI 接口地址无效。');
  let url: URL; try { url = new URL(value.trim()); } catch { throw new Error('AI 接口地址无效。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new Error('AI 接口地址需使用 HTTPS，且不能包含凭据、查询或片段。');
  return url.href.replace(/\/+$/, '');
}
export function aiCompletionEndpoint(baseUrl: string): string {
  const base = normalizeAiBaseUrl(baseUrl); return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}
