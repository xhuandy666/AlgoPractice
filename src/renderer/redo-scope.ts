import type { Language } from '../shared/languages';
import type { AttemptListItem, AttemptPageFilter, PageResult } from '../shared/learning';

export const REDO_SCOPE_PREFIX = 'redo:';

/** Draft scope for a from-scratch rewrite. It never touches the ordinary practice draft. Opening a scope starts an
 * attempt, so repeated clicks would leave a trail of empty active attempts; an unfinished rewrite of the same problem
 * and language is therefore resumed. Once it is finished, the next rewrite starts blank again. */
export async function redoScope(api: { attemptPage(filter: AttemptPageFilter): Promise<PageResult<AttemptListItem>> },
  problemId: string, language: Language, newId: () => string): Promise<string> {
  // Newest first; a problem rarely has more than a few active scopes (practice, a review session, a restore).
  const page = await api.attemptPage({ problemId, language, state: 'active', limit: 100 });
  return page.items.find(item => item.attempt.draftScopeId.startsWith(REDO_SCOPE_PREFIX))?.attempt.draftScopeId ?? `${REDO_SCOPE_PREFIX}${newId()}`;
}
