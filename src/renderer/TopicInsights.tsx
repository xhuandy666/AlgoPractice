import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge, LibraryIndex } from '../shared/bridge';
import type { Language } from '../shared/languages';
import type { StruggleReason, TopicInsight } from '../shared/learning';
import { HelpHint } from './HelpHint';
import { Icon } from './ui';
import './topic-insights.css';

export const struggleReasonLabel: Record<StruggleReason, string> = {
  'rated-hard': '自评「忘记 / 困难」', 'official-failures': '官方提交多次未通过', 'local-failures': '本地多次失败', 'ai-help': '多次求助 AI',
};
const REASON_ORDER: readonly StruggleReason[] = ['rated-hard', 'official-failures', 'local-failures', 'ai-help'];

/** Weakest practiced topics. Fetched on mount and when the library changes (runs, imports), never polled.
 * Renders nothing until at least one topic qualifies, and keeps the last result if a refresh fails.
 * `onRedo` reopens struggling problems for a from-scratch rewrite; `onOpen` opens new problems normally. */
export function TopicInsightsCard({ api, language, library, onOpen, onRedo }: {
  api: DesktopBridge | undefined; language: Language; library: LibraryIndex;
  onOpen: (problemIds: string[], label: string) => void; onRedo: (problemIds: string[], label: string) => void;
}) {
  const [topics, setTopics] = useState<TopicInsight[]>([]);
  const generation = useRef(0);
  useEffect(() => {
    if (!api) return;
    const current = ++generation.current;
    void api.topicInsights(language).then(result => { if (current === generation.current) setTopics(result.topics); }).catch(() => { /* Optional card: keep the previous result. */ });
    return () => { generation.current++; };
  }, [api, language, library]);
  if (!topics.length) return null;
  return <section className="topic-card dash-card" aria-label="薄弱专题">
    <div className="dash-card-heading">
      <span className="dash-tile" data-tone="red" aria-hidden="true"><Icon name="target" size={20} /></span>
      <div>
        <div className="heading-with-help"><h3>薄弱专题</h3>
          <HelpHint label="薄弱专题说明">依据每道练习过的题目的当前状态统计：最近自评为「忘记 / 困难」，或尚未解出且官方提交、本地运行多次失败、多次求助 AI。仅未解出而无其他困难迹象的题目不计入。题目计入其每个标签；至少练习过 2 道题的专题才会显示。</HelpHint>
        </div>
        <p>根据最近的自评、提交与运行情况，列出需要加强的专题</p>
      </div>
    </div>
    <ol className="topic-list">
      {topics.map(topic => <li key={topic.tag} className="topic-row">
        <div className="topic-head"><strong>{topic.tag}</strong><span>练过 {topic.practiced} 题 · 吃力 {topic.struggling} 题</span></div>
        <ul className="topic-reasons">{REASON_ORDER.filter(reason => topic.reasons[reason] > 0).map(reason => <li key={reason}>{struggleReasonLabel[reason]} {topic.reasons[reason]}</li>)}</ul>
        <div className="topic-actions">
          {topic.strugglingProblems.length > 0 && <button type="button" className="button" title="从模板重新编写，原练习草稿保持不变；未完成的重练将从上次进度继续" onClick={() => onRedo(topic.strugglingProblems.map(problem => problem.id), `薄弱专题 · ${topic.tag} · 重练`)}>重练：{topic.strugglingProblems[0].title}</button>}
          {topic.recommended.length > 0 && <button type="button" className="text-button" onClick={() => onOpen(topic.recommended.map(problem => problem.id), `薄弱专题 · ${topic.tag} · 新题`)}>练新题：{topic.recommended[0].title}</button>}
        </div>
      </li>)}
    </ol>
  </section>;
}
