import type { UpdateCheck } from '../shared/maintenance';
export type { UpdateCheck };

// Shared release discovery for the legacy page link and the application update service. Never sends app cookies,
// authentication tokens, learning records or a machine identifier.
export const RELEASES_API = 'https://api.github.com/repos/xhuandy666/AlgoPractice/releases/latest';
const RELEASE_PAGE = /^https:\/\/github\.com\/xhuandy666\/AlgoPractice\/releases\/tag\/[A-Za-z0-9._-]+$/;
const VERSION = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;


/** Numeric x.y.z comparison; prerelease or malformed versions are not comparable. */
export function compareVersions(a: string, b: string): number | null {
  const x = VERSION.exec(a.trim()), y = VERSION.exec(b.trim()); if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return Math.sign(d); }
  return 0;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
async function releaseText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) throw new Error('更新信息过大，已忽略。');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
export async function latestRelease(fetchImpl: FetchLike, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    // No cookies or credentials of the app session ever go with it.
    response = await fetchImpl(RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'AlgoPractice-update-check' }, credentials: 'omit', redirect: 'error', signal: signal ?? AbortSignal.timeout(10_000) });
  } catch { throw new Error('无法连接 GitHub，请检查网络或代理后重试。'); }
  if (!response.ok) await response.body?.cancel();
  if (response.status === 403 || response.status === 429) throw new Error('GitHub 暂时限制了访问频率，请稍后再试。');
  if (response.status === 404) throw new Error('尚未找到正式发布的版本。');
  if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）。`);
  const text = await releaseText(response);
  let release: Record<string, unknown>;
  try { release = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error('更新信息格式无法识别。'); }
  if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error('更新信息格式无法识别。');
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '', url = typeof release.html_url === 'string' ? release.html_url : '';
  if (release.draft === true || release.prerelease === true || compareVersions(tag, '0.0.0') === null || !RELEASE_PAGE.test(url) || !url.endsWith('/' + tag)) throw new Error('更新信息格式无法识别。');
  return release;
}
export async function checkForUpdate(currentVersion: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<UpdateCheck> {
  const release = await latestRelease(fetchImpl, signal), tag = release.tag_name as string, url = release.html_url as string;
  const latest = tag.replace(/^v/, ''), order = compareVersions(latest, currentVersion);
  return { current: currentVersion, latest, newer: order !== null && order > 0, url,
    name: typeof release.name === 'string' ? release.name.slice(0, 200) : null,
    publishedAt: typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)) ? release.published_at : null };
}
