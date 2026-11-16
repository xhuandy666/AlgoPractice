import type { LibraryProblem, ProblemContent } from '../shared/library';
import type { PageResult, ProblemListItem, ProblemPageFilter } from '../shared/learning';
import type { PreparedProblemRefresh } from '../shared/bridge';
import { LANGUAGES } from '../shared/languages';

// Import improvements (e.g. in-place void problems) only reach problems imported earlier through an explicit
// statement refresh. This refreshes a list's read-only LeetCode problems one by one through the same guarded
// preview/apply path, and saves a new version only when the refreshed content becomes locally runnable. New
// versions never touch active or archived practice snapshots. Upgraded problems stop being candidates, so a
// stopped or cancelled pass resumes naturally.

export interface BulkRefreshApi {
  problemPage(filter: ProblemPageFilter): Promise<PageResult<ProblemListItem>>;
  previewProblemRefresh(problemId: string): Promise<PreparedProblemRefresh>;
  applyProblemRefresh(previewId: string): Promise<LibraryProblem>;
}
export interface BulkRefreshProgress { done: number; total: number; upgraded: number; current: string }
export interface BulkRefreshOutcome { status: 'completed' | 'cancelled' | 'stopped'; total: number; upgraded: number; unchanged: number; error?: string }

export function isLocallyRunnable(content: ProblemContent): boolean {
  return (content.mode === 'acm' || Boolean(content.adapter)) && content.cases.length > 0 && LANGUAGES.some(language => Boolean(content.starter[language]?.trim()));
}

/** LeetCode problems of a list that cannot run locally yet, in list order. */
export async function readOnlyCandidates(api: Pick<BulkRefreshApi, 'problemPage'>, listId: string, signal?: AbortSignal): Promise<{ id: string; title: string }[]> {
  const result: { id: string; title: string }[] = [];
  // Advance by what the page actually returned; the server may cap the page below the requested limit.
  for (let offset = 0; ;) {
    signal?.throwIfAborted();
    const page = await api.problemPage({ listId, support: 'reading', offset, limit: 100 });
    for (const item of page.items) if (item.content.source === 'leetcode-cn' && item.content.sourceUrl) result.push({ id: item.id, title: item.content.title });
    if (!page.hasMore || !page.items.length) return result;
    offset += page.items.length;
  }
}

const describe = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '') : String(error);
export async function refreshReadOnlyProblems(api: BulkRefreshApi, candidates: readonly { id: string; title: string }[], options: {
  signal: AbortSignal; wait: (ms: number, signal: AbortSignal) => Promise<void>; onProgress?: (progress: BulkRefreshProgress) => void; spacingMs?: number;
}): Promise<BulkRefreshOutcome> {
  let upgraded = 0, unchanged = 0;
  const total = candidates.length, outcome = (status: BulkRefreshOutcome['status'], error?: string): BulkRefreshOutcome => ({ status, total, upgraded, unchanged, ...(error ? { error } : {}) });
  for (let index = 0; index < total; index++) {
    if (options.signal.aborted) return outcome('cancelled');
    if (index > 0) { try { await options.wait(options.spacingMs ?? 1000, options.signal); } catch { return outcome('cancelled'); } }
    if (options.signal.aborted) return outcome('cancelled');
    options.onProgress?.({ done: index, total, upgraded, current: candidates[index].title });
    try {
      const prepared = await api.previewProblemRefresh(candidates[index].id);
      if (prepared.changed && isLocallyRunnable(prepared.after)) { await api.applyProblemRefresh(prepared.id); upgraded++; } else unchanged++;
    } catch (error) { return outcome('stopped', describe(error)); }
  }
  return outcome('completed');
}
