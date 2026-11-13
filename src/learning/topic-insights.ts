import type { ProblemStruggleSignals, StruggleReason, TopicInsight } from '../shared/learning.ts';

/** Thresholds for objective struggle signals on a problem that has never been solved. */
export const STRUGGLE_THRESHOLDS = { officialRejected: 2, failedRuns: 3, aiHelps: 2 } as const;

/** Why a practiced problem currently looks hard, judged on its current state rather than lifetime totals:
 * - the user's latest self-rating of Again/Hard always counts;
 * - objective signals (repeated official rejections, repeated local failures, repeated AI help) count only while
 *   the problem has never been solved and the latest self-rating is not Good/Easy;
 * - "never solved" alone is unverified, not weak: most LeetCode problems cannot pass locally. */
export function struggleReasons(signal: ProblemStruggleSignals): StruggleReason[] {
  const reasons: StruggleReason[] = [];
  if (signal.rating !== null && signal.rating <= 2) reasons.push('rated-hard');
  const settled = (signal.rating !== null && signal.rating >= 3) || signal.passedRuns > 0 || signal.officialAccepted > 0;
  if (!settled) {
    if (signal.officialRejected >= STRUGGLE_THRESHOLDS.officialRejected) reasons.push('official-failures');
    if (signal.failedRuns >= STRUGGLE_THRESHOLDS.failedRuns) reasons.push('local-failures');
    if (signal.aiHelps >= STRUGGLE_THRESHOLDS.aiHelps) reasons.push('ai-help');
  }
  return reasons;
}

/** Topics (tags) ranked by how many practiced problems currently struggle. A problem counts under every tag it has;
 * untagged problems are skipped. Only topics with at least `minimumPracticed` problems and one struggle qualify.
 * Ties break on the struggling share, then the tag, so the order is stable. Recommendations are filled in later. */
export function rankTopics(signals: readonly ProblemStruggleSignals[], limit = 3, minimumPracticed = 2): TopicInsight[] {
  const topics = new Map<string, TopicInsight>();
  for (const signal of signals) {
    const reasons = struggleReasons(signal);
    for (const tag of new Set(signal.tags.map(item => item.trim()).filter(Boolean))) {
      let topic = topics.get(tag);
      if (!topic) { topic = { tag, practiced: 0, struggling: 0, reasons: { 'rated-hard': 0, 'official-failures': 0, 'local-failures': 0, 'ai-help': 0 }, strugglingProblems: [], recommended: [] }; topics.set(tag, topic); }
      topic.practiced++;
      if (!reasons.length) continue;
      topic.struggling++;
      for (const reason of reasons) topic.reasons[reason]++;
      topic.strugglingProblems.push({ id: signal.problemId, title: signal.title });
    }
  }
  return [...topics.values()]
    .filter(topic => topic.practiced >= minimumPracticed && topic.struggling > 0)
    .sort((a, b) => b.struggling - a.struggling || b.struggling / b.practiced - a.struggling / a.practiced || a.tag.localeCompare(b.tag, 'zh-CN'))
    .slice(0, limit)
    .map(topic => ({ ...topic, strugglingProblems: [...topic.strugglingProblems].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 3) }));
}
