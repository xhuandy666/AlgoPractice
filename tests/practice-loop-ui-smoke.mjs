import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Isolated renderer fixtures with a mocked bridge: no Electron, database, network or runtime.
// Covers the daily loop's shortcuts: resuming from the home page, reading a failed case, a self-written input,
// and rating-then-advancing in a review session.
const root = resolve(import.meta.dirname, '..');
const compiled = await build({
  stdin: { resolveDir: root, loader: 'tsx', sourcefile: 'practice-loop-ui-fixture.tsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import './tokens.css';
    import './src/renderer/styles.css';
    import './src/renderer/shell.css';
    import './src/renderer/learning-center.css';
    import './src/renderer/theme-dark.css';
    import './src/renderer/review-workbench.css';
    import { TodayPage } from './src/renderer/TodayPage';
    import { CaseResults } from './src/renderer/CaseResults';
    import { SelfTestPanel } from './src/renderer/SelfTestPanel';
    import { ReviewSessionBar } from './src/renderer/ReviewSessionBar';
    import { ReviewReferenceDialog } from './src/renderer/ReviewReferenceDialog';
    import { caseInputRows } from './src/renderer/case-input';
    import { rewardProfile } from './src/renderer/rewards';
    import { readPracticeMemory, savePracticeMemory } from './src/renderer/practice-memory';

    const calls = [], TODAY = '2026-11-19';
    const record = name => (...args) => { calls.push([name, ...args]); };
    const item = (id, title, practice = {}) => ({ id, version: 1, content: { title, difficulty: '中等', tags: ['数组'], source: 'leetcode-cn', sourceUrl: null }, capability: { canRun: true, label: '本地可运行' },
      capabilities: { python: true, java: true, go: true, cpp: true }, practice: { solved: false, practiced: false, reviewDue: false, ...practice } });
    let library = { 'two-sum': item('two-sum', '两数之和', { practiced: true }), 'three-sum': item('three-sum', '三数之和') };
    const summary = { date: TODAY, timeZone: 'UTC', budget: 5, reviewedToday: 0, firstAssessedToday: 0, remainingBudget: 5, totalCount: 0, dueCount: 0, overdueCount: 0, deferredCount: 0, postponedCount: 0,
      suspendedCount: 0, unassessedCount: 0, pendingAssessmentCount: 0, plannedCount: 0, extraDueCount: 0 };
    const api = {
      onLibraryChanged: () => () => {},
      learningDashboard: async () => ({ date: TODAY, timeZone: 'UTC', dailyPracticeGoal: 3, from: '2025-11-20', to: TODAY, days: [], totals: { activeMs: 0, completedProblems: 0, activeDays: 0 } }),
      reviewPlan: async () => ({ summary, items: [], total: 0 }), reviewSession: async () => null,
      problemPage: async filter => {
        calls.push(['page', filter]);
        const items = filter.ids ? filter.ids.map(id => library[id]).filter(Boolean)
          : Object.values(library).filter(entry => filter.listId === 'hot100' && (filter.practice !== 'unpracticed' || !entry.practice.practiced));
        return { items: items.slice(0, filter.limit ?? 30), total: items.length, offset: 0, limit: filter.limit ?? 30, hasMore: false };
      },
    };
    const profile = rewardProfile({ activeMs: 0, attempts: 3, runs: 5, passedRuns: 1, reviewedItems: 0, solvedProblems: 1, officialSolvedProblems: 0, days: [] }, TODAY);
    const adapter = { method: 'twoSum', params: [{ array: 'int' }, 'int'], returns: { array: 'int' } };
    const content = { mode: 'function', adapter, starter: { python: 'class Solution:\\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\\n        pass\\n' },
      cases: [{ args: [[2, 7, 11, 15], 9], expected: [0, 1] }, { args: [[3, 2, 4], 6], expected: [1, 2] }, { args: [[3, 3], 6], expected: [0, 1] }] };
    const test = (index, status, actual, extra = {}) => ({ index, status, actual, expected: content.cases[index].expected, stdout: '', stderr: '', durationMs: 3, ...extra });
    const runs = {
      wrong: [test(0, 'passed', [0, 1]), test(1, 'wrong_answer', [0, 2], { stdout: 'seen 3\\n' }), test(2, 'wrong_answer', [1, 1])],
      passed: [test(0, 'passed', [0, 1]), test(1, 'passed', [1, 2]), test(2, 'passed', [0, 1])],
    };
    function SelfTest() {
      const [outcome, setOutcome] = useState(null);
      return <SelfTestPanel problemId="two-sum" adapter={adapter} names={['nums', 'target']} sample={content.cases[0].args} disabled={false} outcome={outcome}
        onRun={args => { calls.push(['self-test', args]); setOutcome({ stale: false, result: { status: 'completed', durationMs: 12, diagnostics: [], stdout: '', stderr: '', caseResults: [{ index: 0, status: 'completed', actual: [args[0].length, args[1]], stdout: 'debug line\\n', stderr: '', durationMs: 12 }] } }); }} />;
    }
    const session = (position, total = 3) => ({ id: 's1', problemIds: Array.from({ length: total }, (_, index) => 'r' + (index + 1)), position, currentProblemId: 'r' + (position + 1), status: 'active', skippedProblemIds: [], createdAt: TODAY, updatedAt: TODAY, endedAt: null });
    const app = createRoot(document.getElementById('root'));
    let generation = 0;
    window.fixture = { calls,
      memory: value => value === undefined ? readPracticeMemory() : savePracticeMemory(value),
      library: next => { library = next(library, item); },
      today(lists = [{ id: 'hot100', title: '热题 100' }]) {
        app.render(<TodayPage key={++generation} api={api} profile={profile} library={{ problems: [], totalProblems: 2, lists, jobs: [] }} onOpenProblems={record('open')} onResume={record('resume')}
          onReviewPlan={record('plan')} onSettings={record('settings')} onArchives={record('archives')} onBrowse={record('browse')} onNavigate={record('navigate')} onError={record('error')} />);
      },
      cases(name) { app.render(<div className="results-pane"><CaseResults key={name} cases={runs[name]} inputOf={index => caseInputRows(content, index)} verdicts={new Map()} exampleOf={() => undefined} designRowsOf={() => null} /></div>); },
      selfTest() { app.render(<div className="results-pane"><SelfTest /></div>); },
      review(position, rated, onCurrent = true, total = 3, reference = null) {
        app.render(<ReviewSessionBar key={++generation} session={session(position, total)} onCurrent={onCurrent} rated={rated} disabled={false} leaveDisabled={false} ratingBlocked={false}
          referenced={reference === 'opened'} onReference={reference ? record('reference') : undefined}
          onNext={record('next')} onRate={record('rate')} onSkip={record('skip')} onReturn={record('return')} onLeave={record('leave')} onEnd={record('end')} />);
      },
      reference(kind, canRate = true) {
        const history = { solved: { python: [], java: [{ id: 'j1', source: 'official', status: 'completed', verdict: 'accepted', answerFormat: 'function' }] }, none: {}, broken: null }[kind];
        const reader = {
          submissionHistory: async filter => { if (!history) throw new Error('记录库暂时不可用。'); const items = history[filter.language] ?? []; return { items, total: items.length, offset: 0, limit: 50, hasMore: false }; },
          submissionHistoryDetail: async (source, id) => ({ id, source, language: 'java', answerFormat: 'function', createdAt: '2026-11-10T08:00:00Z', finishedAt: '2026-11-10T08:00:09Z', code: 'class Solution {\\n    public int[] twoSum(int[] nums, int target) {\\n        return new int[0];\\n    }\\n}\\n' }),
          notePage: async () => ({ items: kind === 'solved' ? [{ id: 'n1' }] : [], total: 0, offset: 0, limit: 5, hasMore: false }),
          note: async id => ({ id, updatedAt: '2026-11-11T09:00:00Z', current: { title: '哈希表一次遍历', markdown: '## 要点\\n\\n先查 **补数** 再放入当前数。' } }),
        };
        app.render(<><button id="opener" autoFocus>对照上次的解法</button><ReviewReferenceDialog key={++generation} api={reader} problem={{ id: 'two-sum', title: '两数之和' }} language="python" canRate={canRate} onRate={record('reference-rate')} onClose={record('reference-close')} /></>);
      },
    };
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false, outfile: 'practice-loop-ui-fixture.js', logLevel: 'silent',
});
const browser = await chromium.launch({ headless: true, ...(process.env.ALGOPRACTICE_TEST_BROWSER ? { channel: process.env.ALGOPRACTICE_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
const errors = [], passed = [];
page.on('pageerror', error => errors.push(error.message));
await page.route(/^https?:\/\//, route => route.abort());
const pass = name => { passed.push(name); console.log('PASS', name); };
const calls = name => page.evaluate(name => window.fixture.calls.filter(call => call[0] === name), name);
// Optional screenshots for a visual check: PRACTICE_LOOP_UI_EVIDENCE_DIR=<directory>.
const evidence = process.env.PRACTICE_LOOP_UI_EVIDENCE_DIR; if (evidence) await mkdir(evidence, { recursive: true });
const shot = async name => { if (evidence) await page.screenshot({ path: join(evidence, name + '.png') }); };
try {
  await page.setContent('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body><main id="root"></main></body></html>');
  await page.addStyleTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.js')).text });
  // Visual check only: UI_SMOKE_THEME=dark renders the same flow in the dark theme.
  if (process.env.UI_SMOKE_THEME === 'dark') await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });

  // Home: nothing remembered keeps the plain entry to the library.
  const hero = page.getByRole('region', { name: '今日概览', exact: true });
  await page.evaluate(() => window.fixture.today());
  await hero.getByRole('button', { name: '开始练习', exact: true }).click();
  assert.equal((await calls('browse')).length, 1); assert.equal((await calls('page')).length, 0, 'nothing is queried without a remembered problem or list');
  pass('Without a remembered practice the home button opens the library');

  // An unsolved remembered problem is continued in one step, with its list for previous / next.
  await page.evaluate(() => { window.fixture.memory({ language: 'java', problemId: 'two-sum', listId: 'hot100', listTitle: '热题 100' }); window.fixture.today(); });
  const resume = hero.locator('.browse-practice');
  await hero.getByText('上次没做完的题', { exact: false }).waitFor();
  assert.equal(await resume.locator('.resume-kind').textContent(), '继续'); assert.equal(await resume.locator('.resume-title').textContent(), '两数之和');
  await shot('home-continue'); await resume.click();
  assert.deepEqual((await calls('resume')).at(-1)[1], { kind: 'continue', problemId: 'two-sum', title: '两数之和', list: { id: 'hot100', title: '热题 100' } });
  await hero.getByRole('button', { name: '去题库选题', exact: true }).click(); assert.equal((await calls('browse')).length, 2, 'the library stays one click away');
  pass('An unsolved remembered problem is offered as "继续" and keeps its study list');

  // Once it is solved, the first unopened problem of that list is next.
  await page.evaluate(() => { window.fixture.library((library, item) => ({ ...library, 'two-sum': item('two-sum', '两数之和', { practiced: true, solved: true }) })); window.fixture.today(); });
  await hero.getByText('《热题 100》里还没做过的第一道', { exact: false }).waitFor();
  assert.equal(await resume.locator('.resume-kind').textContent(), '下一题'); assert.equal(await resume.locator('.resume-title').textContent(), '三数之和');
  await shot('home-next'); await resume.click(); assert.deepEqual((await calls('resume')).at(-1)[1], { kind: 'next', problemId: 'three-sum', title: '三数之和', list: { id: 'hot100', title: '热题 100' } });
  const unpracticed = (await calls('page')).map(call => call[1]).filter(filter => filter.practice === 'unpracticed').at(-1);
  assert.deepEqual([unpracticed.listId, unpracticed.limit], ['hot100', 1]);
  pass('A solved remembered problem moves on to the first unopened problem of the list');

  // A removed problem and a removed list are forgotten without an error.
  await page.evaluate(() => { window.fixture.library(library => ({ 'three-sum': library['three-sum'] })); window.fixture.today([]); });
  await hero.getByRole('button', { name: '开始练习', exact: true }).waitFor();
  await page.waitForFunction(() => { const memory = window.fixture.memory(); return !memory.problemId && !memory.listId; });
  assert.equal((await page.evaluate(() => window.fixture.memory())).language, 'java', 'the language choice survives');
  assert.deepEqual(await calls('error'), []);
  pass('A remembered problem or list that no longer exists is dropped quietly and the language is kept');

  // A wrong answer opens its first failed case with the input in the statement's notation.
  await page.evaluate(() => window.fixture.cases('wrong'));
  const details = page.locator('.case-detail');
  assert.deepEqual(await details.evaluateAll(nodes => nodes.map(node => node.open)), [false, true, false], 'only the first failed case is open');
  const opened = details.nth(1);
  assert.deepEqual(await opened.locator('.case-input pre').allTextContents(), ['nums = [3,2,4]', 'target = 6']);
  const terms = await opened.locator('dt').allTextContents();
  assert.deepEqual(terms, ['输入', '实际输出', '期望输出', '标准输出']);
  assert.deepEqual(await opened.locator('dd pre').allTextContents(), ['nums = [3,2,4]', 'target = 6', '[0,2]', '[1,2]', 'seen 3\n']);
  await shot('failed-case'); await details.nth(2).locator('summary').click();
  assert.deepEqual(await details.nth(2).locator('.case-input pre').allTextContents(), ['nums = [3,3]', 'target = 6'], 'other cases show their input once opened');
  await page.evaluate(() => window.fixture.cases('passed'));
  assert.deepEqual(await details.evaluateAll(nodes => nodes.map(node => node.open)), [false, false, false], 'a passing run keeps every case folded');
  pass('The first failed case opens with input, actual, expected and printed output; a pass stays folded');

  // Self-test: a wrong line is explained in place, a valid input reaches the runner as typed values.
  await page.evaluate(() => window.fixture.selfTest());
  const panel = page.getByRole('region', { name: '自测输入', exact: true }), input = panel.getByRole('textbox', { name: '自测输入内容', exact: true });
  assert.equal(await input.inputValue(), '[2,7,11,15]\n9', 'the first case is offered as a starting point');
  await panel.getByText('每行一个参数，按函数参数的顺序：nums、target', { exact: true }).waitFor();
  await input.fill('[1,2,3]');
  await panel.getByRole('button', { name: '运行这组输入', exact: true }).click();
  assert.equal(await panel.getByRole('alert').textContent(), '需要 2 行输入，每行一个参数（nums、target），现在是 1 行。');
  assert.equal(await input.getAttribute('aria-invalid'), 'true'); assert.equal((await calls('self-test')).length, 0);
  await input.fill('[1,2,3]\n"six"'); await input.press('Control+Enter');
  assert.equal(await panel.getByRole('alert').textContent(), '第 2 行（target）与参数类型不符；需要整数，如 1。');
  await input.fill('[]\n0'); assert.equal(await panel.getByRole('alert').count(), 0, 'editing clears the message');
  await input.press('Control+Enter');
  assert.deepEqual((await calls('self-test')).at(-1)[1], [[], 0]);
  const outcome = panel.getByRole('status');
  await outcome.getByText('运行完成', { exact: true }).waitFor();
  assert.deepEqual(await outcome.locator('dt').allTextContents(), ['输出', '标准输出']);
  assert.deepEqual(await outcome.locator('dd pre').allTextContents(), ['[0,0]', 'debug line\n']);
  assert.equal(await panel.getByText('不判对错', { exact: false }).count(), 1);
  await shot('self-test'); await panel.getByRole('button', { name: '填入示例 1', exact: true }).click(); assert.equal(await input.inputValue(), '[2,7,11,15]\n9');
  pass('A self-test explains a malformed line, sends typed arguments and shows the output without a verdict');

  // Review: one button rates and advances; an already rated problem only advances.
  const bar = page.getByRole('region', { name: '复习会话', exact: true });
  await page.evaluate(() => window.fixture.review(0, false));
  await bar.getByText('复习 · 第 1 / 3 题', { exact: true }).waitFor();
  assert.deepEqual(await bar.getByRole('button').allTextContents(), ['自评并下一题', '跳过本题', '退出并保留进度', '结束本轮']);
  await bar.getByRole('button', { name: '自评并下一题', exact: true }).click(); assert.equal((await calls('next')).length, 1);
  await shot('review-bar'); await page.evaluate(() => window.fixture.review(0, true));
  await bar.getByText('复习 · 第 1 / 3 题 · 今天已自评', { exact: true }).waitFor();
  assert.deepEqual(await bar.getByRole('button').allTextContents(), ['下一题', '跳过本题', '退出并保留进度', '结束本轮']);
  await page.evaluate(() => window.fixture.review(2, false)); await bar.getByRole('button', { name: '自评并完成本轮', exact: true }).waitFor();
  await page.evaluate(() => window.fixture.review(2, true)); await bar.getByRole('button', { name: '完成本轮', exact: true }).waitFor();
  await page.evaluate(() => window.fixture.review(1, null));
  assert.equal(await bar.locator('.review-next').isDisabled(), true, 'the main button waits until the rating state is known');
  await page.evaluate(() => window.fixture.review(1, false, false));
  assert.deepEqual(await bar.getByRole('button').allTextContents(), ['记录本题自评', '回到队列当前题', '退出并保留进度', '结束本轮']);
  await bar.getByText('浏览邻题 · 队列进度保留 · 第 2 / 3 题', { exact: true }).waitFor();
  pass('The review bar offers one rate-and-advance step, a plain next once rated, and the finishing wording on the last problem');

  // Recall review: comparing with the earlier solution is an explicit, optional step that leads into the rating.
  await page.evaluate(() => window.fixture.review(0, false, true, 3, 'offered'));
  assert.deepEqual(await bar.getByRole('button').allTextContents(), ['对照上次的解法', '自评并下一题', '跳过本题', '退出并保留进度', '结束本轮']);
  await bar.getByRole('button', { name: '对照上次的解法', exact: true }).click(); assert.equal((await calls('reference')).length, 1);
  await page.evaluate(() => window.fixture.review(0, false, true, 3, 'opened')); await bar.getByText('复习 · 第 1 / 3 题 · 已对照', { exact: true }).waitFor();
  await page.evaluate(() => window.fixture.reference('solved'));
  const reference = page.getByRole('dialog', { name: '对照上次的解法', exact: true });
  await reference.getByText('两数之和 · 只读，不会改动这次的复习草稿', { exact: true }).waitFor();
  const solution = reference.getByRole('region', { name: '上次通过的代码', exact: true });
  await solution.getByText(/^力扣官方通过 · Java · .+ · 这道题没有 Python 的通过记录$/).waitFor();
  assert.match(await solution.locator('pre').textContent(), /^class Solution \{\n    public int\[\] twoSum/);
  const notes = reference.getByRole('region', { name: '这道题的笔记', exact: true });
  await notes.getByRole('heading', { name: /^哈希表一次遍历/ }).waitFor(); assert.equal(await notes.locator('strong').textContent(), '补数');
  await shot('review-reference');
  await reference.getByRole('button', { name: '对照完了，去自评', exact: true }).click(); assert.equal((await calls('reference-rate')).length, 1);
  await page.keyboard.press('Escape'); assert.equal((await calls('reference-close')).length, 1, 'Escape asks to close instead of leaving a stale dialog');
  await page.evaluate(() => window.fixture.reference('none', false));
  await reference.getByText('这道题还没有通过的代码记录。', { exact: true }).waitFor(); await reference.getByText(/^这道题还没有笔记。/).waitFor();
  assert.equal(await reference.getByRole('button', { name: '对照完了，去自评', exact: true }).count(), 0, 'an already rated problem offers no second rating');
  assert.deepEqual(await reference.locator('footer').getByRole('button').allTextContents(), ['关闭']);
  await page.evaluate(() => window.fixture.reference('broken'));
  assert.equal(await reference.getByRole('alert').textContent(), '没能读取记录：记录库暂时不可用。');
  for (const width of [820, 375]) {
    await page.setViewportSize({ width, height: 720 }); await page.evaluate(() => window.fixture.reference('solved'));
    await solution.locator('pre').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'no horizontal page scroll at ' + width);
    assert.equal(await reference.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'the dialog itself does not scroll sideways at ' + width);
  }
  pass('The compare step shows the latest passing code and notes read-only, leads into the rating, and explains empty and failed reads');

  assert.deepEqual(errors, []); assert.deepEqual(await calls('error'), []);
  console.log(JSON.stringify({ result: 'passed', assertions: passed.length }));
} catch (error) {
  process.exitCode = 1; console.error(error); console.log(JSON.stringify({ result: 'failed', passed, rendererErrors: errors }));
} finally { await browser.close(); }
