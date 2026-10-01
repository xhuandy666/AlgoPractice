import type { DesktopBridge } from './bridge.ts';
import type { PageResult, ProblemPageFilter } from './learning.ts';
import type { ReviewPlanQuery, ReviewSession } from './review-plan.ts';

/** A captured entry view, not a global “last used” list. Pagination is resolved only once. */
export type PracticeNavigationSource =
  | { readonly kind: 'library'; readonly label: string; readonly filter: Readonly<Omit<ProblemPageFilter, 'offset' | 'limit'>> }
  | { readonly kind: 'review'; readonly label: string; readonly query: Readonly<Omit<ReviewPlanQuery, 'offset' | 'limit'>> }
  | { readonly kind: 'frozen'; readonly label: string; readonly problemIds: readonly string[]; readonly sessionId?: string };

export type PracticeNavigationReader = Pick<DesktopBridge, 'problemPage' | 'reviewPlan'>;
export interface PracticeNavigationPosition {
  index: number; total: number; previousId: string | null; nextId: string | null;
}

function uniqueIds(ids: readonly string[]): string[] { return [...new Set(ids.filter(Boolean))]; }

export function makeLibraryPracticeSource(filter: ProblemPageFilter, label = '全部题库'): PracticeNavigationSource {
  const { offset: _offset, limit: _limit, ...captured } = filter;
  return Object.freeze({ kind: 'library', label, filter: Object.freeze({ ...captured, ...(captured.ids ? { ids: [...captured.ids] } : {}) }) });
}

export function makeReviewPracticeSource(query: ReviewPlanQuery, label = '复习列表'): PracticeNavigationSource {
  const { offset: _offset, limit: _limit, ...captured } = query;
  return Object.freeze({ kind: 'review', label, query: Object.freeze(captured) });
}

export function makeFrozenPracticeSource(problemIds: readonly string[], label: string): PracticeNavigationSource {
  return Object.freeze({ kind: 'frozen', label, problemIds: Object.freeze(uniqueIds(problemIds)) });
}

export function makeReviewSessionPracticeSource(session: ReviewSession): PracticeNavigationSource {
  return Object.freeze({ kind: 'frozen', label: '本轮复习', sessionId: session.id, problemIds: Object.freeze(uniqueIds(session.problemIds)) });
}

export function practiceNavigationPosition(problemIds: readonly string[], currentProblemId: string): PracticeNavigationPosition {
  const index = problemIds.indexOf(currentProblemId);
  return { index, total: problemIds.length, previousId: index > 0 ? problemIds[index - 1] : null,
    nextId: index >= 0 && index + 1 < problemIds.length ? problemIds[index + 1] : null };
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) { const error = new Error('Navigation request superseded'); error.name = 'AbortError'; throw error; }
}

/** Use the same list query/order as the entry page, including rows beyond its visible page. */
export async function resolvePracticeNavigation(source: PracticeNavigationSource, api?: PracticeNavigationReader, signal?: AbortSignal): Promise<string[]> {
  checkAborted(signal);
  if (source.kind === 'frozen') return uniqueIds(source.problemIds);
  if (!api) throw new Error('题目顺序需要在桌面应用中读取。');
  const result: string[] = []; let offset = 0, total: number | undefined, reviewIdentity: string | undefined;
  for (;;) {
    checkAborted(signal);
    let page: PageResult<{ id?: string; problemId?: string }>;
    if (source.kind === 'library') page = await api.problemPage({ ...source.filter, offset, limit: 100 });
    else {
      const snapshot = await api.reviewPlan({ ...source.query, offset, limit: 100 });
      // The repository identity is revision:settings-digest:observation-time. The clock may
      // advance between pages, but plans/settings or a local-day boundary cannot mix views.
      const identity = `${snapshot.snapshotVersion.split(':', 2).join(':')}:${snapshot.summary.date}:${snapshot.summary.timeZone}`;
      if (reviewIdentity !== undefined && reviewIdentity !== identity) throw new Error('复习列表已变化，请返回复习计划重新进入。');
      reviewIdentity = identity; page = snapshot.items;
    }
    checkAborted(signal);
    if (page.offset !== offset || !Number.isSafeInteger(page.total) || page.total < 0 || (total !== undefined && total !== page.total)
      || page.items.length > page.limit || (page.hasMore && !page.items.length)) throw new Error('题目列表已变化，请返回来源列表重新进入。');
    total ??= page.total;
    for (const item of page.items) {
      const id = source.kind === 'library' ? item.id : item.problemId;
      if (!id) throw new Error('题目列表缺少身份，请返回来源列表重新进入。');
      result.push(id);
    }
    offset += page.items.length;
    if (offset > total || (page.hasMore ? offset >= total : offset !== total)) throw new Error('题目列表已变化，请返回来源列表重新进入。');
    if (!page.hasMore) return uniqueIds(result);
  }
}
