import { useEffect, useMemo, useState } from 'react';
import { practiceNavigationPosition, resolvePracticeNavigation, type PracticeNavigationReader, type PracticeNavigationSource } from '../shared/practice-navigation';

/** Source changes only on a new entry. Changing the active question keeps the frozen order. */
export function usePracticeNavigation(api: PracticeNavigationReader | undefined, source: PracticeNavigationSource | null, currentProblemId: string) {
  const [state, setState] = useState<{ source: PracticeNavigationSource | null; problemIds: string[]; loading: boolean; error: string }>({ source: null, problemIds: [], loading: false, error: '' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    if (!source) { setState({ source: null, problemIds: [], loading: false, error: '' }); return; }
    setState({ source, problemIds: [], loading: true, error: '' });
    void resolvePracticeNavigation(source, api, controller.signal).then(problemIds => {
      if (!controller.signal.aborted) setState({ source, problemIds, loading: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ source, problemIds: [], loading: false, error: error instanceof Error ? error.message : '未能读取题目顺序。' });
    });
    return () => controller.abort();
  }, [api, source, revision]);
  // A render between source replacement and effect cleanup must never expose old neighbors.
  const problemIds = state.source === source ? state.problemIds : [];
  const position = useMemo(() => practiceNavigationPosition(problemIds, currentProblemId), [problemIds, currentProblemId]);
  return { ...position, label: source?.label ?? '', problemIds, loading: Boolean(source && (state.source !== source || state.loading)),
    error: state.source === source ? state.error : '', reload: () => setRevision(value => value + 1) };
}
