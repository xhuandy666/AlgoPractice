import type { Language } from '../runner/types';
import type { LibraryProblem, ProblemContent } from './library';
import { demoProblems } from './demo-problems';

export function demoContent(problem: typeof demoProblems[number]): ProblemContent {
  return { id: problem.id, title: problem.title, difficulty: problem.difficulty, tags: [problem.topic],
    description: problem.description, descriptionFormat: 'plain', constraints: problem.constraints,
    mode: problem.mode, ...(problem.adapter ? { adapter: problem.adapter } : {}), cases: problem.cases,
    starter: problem.starter, source: 'local' };
}
export const previewProblems: LibraryProblem[] = demoProblems.map(problem => ({ id: problem.id, version: 'preview', content: demoContent(problem), createdAt: '', updatedAt: '' }));

export { capability } from './capability';

export const difficultyLabel = (value: string) => ({ easy: '简单', medium: '中等', hard: '困难' }[value.toLowerCase()] || value || '未标注');
export const sourceLabel = (source: ProblemContent['source']) => ({ local: '自建样例', 'leetcode-cn': '力扣国服', file: '文件导入' }[source]);
