import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Isolated renderer fixtures with a mocked bridge and authored learning data: no Electron, database, network or runtime.
// Covers the home page (sample-first starter, direct review entry, growth details) and the interview page (list scope, pool feedback).
const root = resolve(import.meta.dirname, '..');
const compiled = await build({
  plugins: [{ name: 'no-interview-workbench', setup(build) {
    // The interview workbench pulls in the code editor; this fixture only configures a session and never enters one.
    build.onResolve({ filter: /^\.\/InterviewWorkbench$/ }, () => ({ path: 'interview-workbench', namespace: 'ui-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'ui-fixture' }, () => ({ contents: 'export function InterviewWorkbench() { return null; }', loader: 'tsx', resolveDir: root }));
  } }],
  stdin: { resolveDir: root, loader: 'tsx', sourcefile: 'learning-flow-ui-fixture.tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import './tokens.css';
    import './src/renderer/styles.css';
    import './src/renderer/shell.css';
    import './src/renderer/interview.css';
    import './src/renderer/learning-center.css';
    import { TodayPage } from './src/renderer/TodayPage';
    import { InterviewPage } from './src/renderer/InterviewPage';
    import { rewardProfile } from './src/renderer/rewards';

    const calls = [], TODAY = '2026-11-19';
    // Playwright's blank page is not a secure context, so the browser offers no randomUUID there; the desktop app always has it.
    let requests = 0; if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => 'fixture-request-' + (++requests) });
    const day = (date, values = {}) => ({ date, activeMs: 0, attempts: 0, completedProblems: 0, runs: 0, passedRuns: 0, practiceRuns: 0, officialAccepted: 0, reviewCount: 0, ...values });
    const statistics = (days, totals = {}) => ({ activeMs: days.reduce((sum, row) => sum + row.activeMs, 0), attempts: 0, runs: 0, passedRuns: 0, reviewedItems: 0, solvedProblems: 0, officialSolvedProblems: 0, days, ...totals });
    const profiles = {
      newcomer: rewardProfile(statistics([]), TODAY),
      learner: rewardProfile(statistics([day('2026-11-18', { runs: 4, passedRuns: 2, practiceRuns: 2, completedProblems: 2, activeMs: 50 * 60000 }),
        day(TODAY, { runs: 45, passedRuns: 1, practiceRuns: 40, officialAccepted: 1, completedProblems: 1, reviewCount: 1, activeMs: 25 * 60000 })], { runs: 49, passedRuns: 3, reviewedItems: 8, solvedProblems: 3, officialSolvedProblems: 1 }), TODAY),
    };
    const sample = { id: 'array-total', version: 1, content: { title: '数组求和', difficulty: '基础', tags: ['数组'], source: 'local', sourceUrl: null }, capability: { canRun: true, label: '本地可运行' },
      capabilities: { python: true, java: true, go: true, cpp: true, cppTemplate: true }, practice: { solved: false, practiced: false, reviewDue: false } };
    const summary = { date: TODAY, timeZone: 'UTC', budget: 5, reviewedToday: 1, firstAssessedToday: 0, remainingBudget: 4, totalCount: 9, dueCount: 2, overdueCount: 0, deferredCount: 0, postponedCount: 0,
      suspendedCount: 0, unassessedCount: 0, pendingAssessmentCount: 0, plannedCount: 2, extraDueCount: 0 };
    const session = { id: 'session-1', problemIds: ['r1', 'r2', 'r3'], position: 0, currentProblemId: 'r1', status: 'active', skippedProblemIds: [], createdAt: TODAY, updatedAt: TODAY, endedAt: null };
    let ongoing = null, planned = 2, failStart = false, lists = [];

    const titles = { 'two-sum': '两数之和', 'lru-cache': 'LRU 缓存', 'min-stack': '最小栈', 'trie': '实现 Trie' };
    const candidate = id => ({ problem: { id, version: 1, content: { title: titles[id], difficulty: '中等', tags: [] } }, difficulty: 'medium', weight: 1 });
    const api = {
      onLibraryChanged: () => () => {},
      learningDashboard: async () => ({ date: TODAY, timeZone: 'UTC', dailyPracticeGoal: 3, from: '2025-11-20', to: TODAY, days: [{ date: TODAY, activeMs: 25 * 60000, completedProblems: 1, reviewCount: 1 }], totals: { activeMs: 25 * 60000, completedProblems: 3, activeDays: 2 } }),
      reviewPlan: async () => ({ summary: { ...summary, plannedCount: planned }, items: [], total: 0 }),
      reviewSession: async id => { calls.push(['session', id ?? null]); return ongoing; },
      startReviewSession: async input => { calls.push(['start', input]); if (failStart) throw new Error('复习会话暂时无法开始。'); return session; },
      interviewState: async () => ({ active: null, history: [], datasets: [] }),
      previewInterview: async rules => {
        calls.push(['preview', rules]);
        const scope = rules.listId ? { listId: rules.listId, title: '面试经典', total: 4, cached: 3 } : null;
        const link = { problemId: 'trie', title: '实现 Trie', reason: '仅保存题目引用；题面、模板或测试尚未获取。' };
        const recent = rules.excludeRecentDays > 0 && rules.listId;
        return { id: 'preview-' + calls.length, pool: { algorithmVersion: 'fixture', rules, evaluatedAt: TODAY, dataset: null, scope,
          candidates: recent ? [candidate('min-stack')].slice(0, 0) : ['two-sum', 'lru-cache', 'min-stack'].slice(0, rules.listId ? 2 : 3).map(candidate),
          selectedIds: recent ? [] : ['two-sum'],
          exclusions: [...(recent ? [{ problemId: 'two-sum', title: '两数之和', reason: '近期已经练习' }, { problemId: 'lru-cache', title: 'LRU 缓存', reason: '近期已经练习' }] : []), ...(rules.listId ? [link] : [])],
          shortages: recent ? ['中等题需要 1 道，可用 0 道，缺 1 道。'] : [] } };
      },
    };
    const app = createRoot(document.getElementById('root'));
    const record = name => (...args) => { calls.push([name, ...args]); };
    let view = { kind: 'today', profile: 'newcomer' };
    function render() {
      if (view.kind === 'interview') { app.render(<InterviewPage api={api} lists={lists} onError={record('error')} onNavigate={record('navigate')} />); return; }
      app.render(<TodayPage key={view.profile + ':' + view.generation} api={api} profile={profiles[view.profile]} library={{ problems: view.sampleHidden ? [] : [sample], totalProblems: 3, lists: [], jobs: [] }}
        onOpenProblems={record('open')} onReviewPlan={record('plan')} onStartReview={record('review')} onSettings={record('settings')} onArchives={record('archives')} onBrowse={record('browse')} onNavigate={record('navigate')} onError={record('error')} />);
    }
    let generation = 0;
    window.fixture = { calls, profiles,
      today(profile, options = {}) { ongoing = options.ongoing ? { ...session, position: 1, currentProblemId: 'r2' } : null; planned = options.planned ?? 2; failStart = false; view = { kind: 'today', profile, sampleHidden: options.sampleHidden, generation: ++generation }; render(); },
      failStart(next) { failStart = next; },
      interview(next) { lists = next; view = { kind: 'interview' }; render(); },
    };
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false, outfile: 'learning-flow-ui-fixture.js', logLevel: 'silent',
});
const browser = await chromium.launch({ headless: true, ...(process.env.ALGOPRACTICE_TEST_BROWSER ? { channel: process.env.ALGOPRACTICE_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
const errors = [], passed = [];
page.on('pageerror', error => errors.push(error.message));
await page.route(/^https?:\/\//, route => route.abort());
const pass = name => { passed.push(name); console.log('PASS', name); };
// Optional screenshots for a visual check: set LEARNING_FLOW_UI_EVIDENCE_DIR to a folder.
const evidence = process.env.LEARNING_FLOW_UI_EVIDENCE_DIR ? resolve(process.env.LEARNING_FLOW_UI_EVIDENCE_DIR) : null; if (evidence) await mkdir(evidence, { recursive: true });
const shot = async name => { if (evidence) await page.screenshot({ path: join(evidence, name), fullPage: true }); };
const calls = name => page.evaluate(name => window.fixture.calls.filter(call => call[0] === name), name);
const wait = (predicate, argument) => page.waitForFunction(predicate, argument);
try {
  await page.setContent('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body><main id="root"></main></body></html>');
  await page.addStyleTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.js')).text });

  await page.evaluate(() => window.fixture.today('newcomer'));
  const starter = page.getByRole('region', { name: '新手任务', exact: true });
  await starter.getByText('完成 0 / 3 · 先跑通一道样例，再导入自己的题单', { exact: true }).waitFor();
  assert.deepEqual(await starter.locator('.starter-path li strong').allTextContents(), ['运行一次代码', '解出第一道题', '导入自己的题单']);
  await starter.getByText('自带样例「数组求和」已就绪，打开后按 ⌘ / Ctrl + Enter', { exact: true }).waitFor();
  await shot('home-newcomer.png'); await starter.getByRole('button', { name: '试做「数组求和」', exact: true }).click();
  assert.deepEqual(await calls('open'), [['open', ['array-total'], '自带样例 · 数组求和']], 'the first step opens the sample itself, not the library');
  await starter.getByRole('button', { name: '导入题单', exact: true }).click(); assert.deepEqual((await calls('navigate')).at(-1), ['navigate', 'sources']);
  await page.evaluate(() => window.fixture.today('newcomer', { sampleHidden: true }));
  await starter.getByRole('button', { name: '打开题库', exact: true }).click(); assert.equal((await calls('browse')).length, 1, 'without a ready sample the step falls back to the library');
  pass('The newcomer path starts with running the built-in sample directly and leaves importing a list as the third step');

  await page.evaluate(() => window.fixture.today('learner'));
  const reviewCard = page.getByRole('region', { name: '复习计划摘要', exact: true });
  await reviewCard.getByRole('heading', { name: '今天推荐复习 2 题', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '新手任务', exact: true }).count(), 0);
  await page.evaluate(() => window.fixture.failStart(true));
  await reviewCard.getByRole('button', { name: '开始今日 2 题', exact: true }).click();
  await reviewCard.getByRole('alert').filter({ hasText: '没能开始复习：复习会话暂时无法开始。' }).waitFor(); assert.equal((await calls('review')).length, 0);
  assert.equal(await page.getByText('学习记录读取失败').count(), 0, 'a failed start is not reported as a failure to read the learning record');
  await page.evaluate(() => window.fixture.failStart(false));
  await reviewCard.getByRole('button', { name: '开始今日 2 题', exact: true }).click(); await wait(() => window.fixture.calls.some(call => call[0] === 'review'));
  assert.equal(await reviewCard.getByRole('alert').count(), 0); const starts = await calls('start'); assert.equal(starts.length, 2); assert.equal(starts[0][1].requestId, starts[1][1].requestId, 'a retry reuses the request so it cannot open a second session');
  assert.deepEqual(Object.keys(starts[0][1]), ['requestId'], "today's recommended queue is started, not a hand-picked list");
  const opened = (await calls('review'))[0]; assert.equal(opened[1], 'r1'); assert.equal(opened[2].id, 'session-1'); assert.equal(opened[3].kind, 'frozen'); assert.ok(JSON.stringify(opened[3]).includes('"r1","r2","r3"'), 'neighbour navigation follows the session queue');
  await reviewCard.getByRole('button', { name: '查看复习计划', exact: true }).click(); assert.equal((await calls('plan')).length, 1);
  await page.evaluate(() => window.fixture.today('learner', { ongoing: true }));
  await reviewCard.getByRole('heading', { name: '本轮复习进行到第 2 / 3 题', exact: true }).waitFor();
  const startsBefore = (await calls('start')).length; await reviewCard.getByRole('button', { name: '继续本轮复习', exact: true }).click();
  await wait(() => window.fixture.calls.filter(call => call[0] === 'review').length === 2);
  assert.equal((await calls('start')).length, startsBefore, 'continuing reads the session in progress instead of starting another');
  assert.deepEqual((await calls('session')).at(-1), ['session', 'session-1']); assert.equal((await calls('review'))[1][1], 'r2');
  await page.evaluate(() => window.fixture.today('learner', { planned: 0 }));
  await reviewCard.getByRole('heading', { name: '今天暂无推荐复习', exact: true }).waitFor();
  assert.equal(await reviewCard.getByRole('button').count(), 1); assert.equal(await reviewCard.getByRole('button', { name: '查看复习计划', exact: true }).count(), 1);
  pass("The home summary starts today's review or continues the round in progress in one click, and keeps the plan as a secondary entry");

  await page.evaluate(() => window.fixture.today('learner'));
  const dialog = page.getByRole('dialog', { name: '成长详情', exact: true });
  const ladderButton = page.getByRole('button', { name: '查看段位阶梯', exact: true });
  await shot('home-learner.png'); await ladderButton.click(); await dialog.waitFor(); await shot('growth-ranks.png');
  const profile = await page.evaluate(() => { const value = window.fixture.profiles.learner; return { level: value.level, rank: value.rank.name, next: value.nextRank.name, todayXp: value.todayXp }; });
  assert.deepEqual(await dialog.locator('.rank-ladder li strong').allTextContents(), ['青铜', '白银', '黄金', '铂金', '钻石', '大师', '王者']);
  assert.equal(await dialog.locator('.rank-ladder li[aria-current=step] strong').textContent(), profile.rank);
  assert.equal(await dialog.locator('.rank-ladder li[data-state=next] strong').textContent(), profile.next);
  const summaryText = await dialog.locator('.growth-summary').textContent();
  assert.ok(summaryText.includes(`升到 Lv.${profile.level + 1} 还差`) && summaryText.includes(`升级后晋升${profile.next}`), summaryText);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(await ladderButton.evaluate(element => element === document.activeElement), true, 'closing returns focus to the button that opened the dialog');
  pass('The rank card opens the whole ladder, marks the current and next tier, and separates the next level from the next tier');

  await page.getByRole('button', { name: '经验明细', exact: true }).click(); await dialog.waitFor();
  const rows = await dialog.locator('.xp-sources tbody tr').evaluateAll(list => list.map(row => [...row.children].map(cell => cell.textContent)));
  assert.equal(rows.length, 6); assert.deepEqual(rows.find(row => row[0] === '其他练习运行'), ['其他练习运行', '40（计入 30）', '2 XP', '30', '60 XP'], 'a capped source shows both what happened and what counted');
  assert.equal(rows.reduce((sum, row) => sum + parseInt(row[4], 10), 0), profile.todayXp, 'the breakdown adds up to the total on the home page');
  await dialog.getByRole('heading', { name: `今日经验 · ${profile.todayXp} XP`, exact: true }).waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  pass("Today's experience is itemized by source with its unit, daily cap and counted amount");

  const badge = page.getByRole('button', { name: '温故知新：8 / 10，查看条件和下一步', exact: true });
  await badge.focus(); await page.keyboard.press('Enter'); await dialog.waitFor();
  const item = dialog.locator('[data-achievement="review-10"]'); await shot('growth-achievement.png');
  assert.equal(await item.evaluate(element => element === document.activeElement), true, 'the chosen badge is focused inside the dialog');
  assert.ok((await item.textContent()).includes('复习 10 道不同的题目') && (await item.textContent()).includes('8 / 10') && (await item.textContent()).includes('同一道题重复复习只计一次'));
  assert.equal(await dialog.locator('.growth-achievements li').count(), 10);
  assert.equal(await dialog.locator('[data-achievement="first-pass"]').getByRole('button').count(), 0, 'an unlocked badge offers no action');
  const reviewsBefore = (await calls('review')).length;
  await item.getByRole('button', { name: '开始今日复习（2 题）', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  await wait(count => window.fixture.calls.filter(call => call[0] === 'review').length === count + 1, reviewsBefore);
  await page.getByRole('button', { name: '条件与进度', exact: true }).click(); await dialog.waitFor();
  await dialog.locator('[data-achievement="pass-10"]').getByRole('button', { name: '去题库练习', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  assert.equal((await calls('browse')).length, 2);
  pass('Each badge opens by mouse or keyboard to its condition, progress and next step, and the step starts the matching task');

  for (const width of [1280, 820, 375]) {
    await page.setViewportSize({ width, height: 900 }); await page.getByRole('button', { name: '条件与进度', exact: true }).click(); await dialog.waitFor();
    const fit = await page.evaluate(() => { const box = document.querySelector('.growth-dialog').getBoundingClientRect(); return { left: box.left, right: box.right, inner: innerWidth, scroll: document.querySelector('.growth-dialog').scrollWidth, client: document.querySelector('.growth-dialog').clientWidth }; });
    assert.ok(fit.left >= 0 && fit.right <= fit.inner && fit.scroll <= fit.client + 1, JSON.stringify({ width, fit }));
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  pass('The growth dialog fits 1280, 820 and 375 px wide windows without horizontal scrolling');

  const list = { id: 'list-a', title: '面试经典', source: 'leetcode-cn', revision: 1, chapters: [], createdAt: '2026-11-19', updatedAt: '2026-11-19', items: ['two-sum', 'lru-cache', 'min-stack', 'trie'].map((problemId, position) => ({ key: 'k' + position, problemId, position })) };
  await page.evaluate(list => window.fixture.interview([list]), list);
  const scope = page.getByLabel('题目范围', { exact: true });
  await scope.waitFor(); assert.deepEqual(await scope.locator('option').allTextContents(), ['全部题库', '面试经典 · 4 题']);
  await page.getByText('想用一张力扣题单组卷？先导入题单，再回到这里选择它。').waitFor();
  await page.locator('.interview-scope').getByRole('button', { name: '导入题单', exact: true }).click(); assert.deepEqual((await calls('navigate')).at(-1), ['navigate', 'sources']);
  await scope.selectOption('list-a'); await page.getByText('只从这张题单里抽题，数量不够时不会用其他题目补。').waitFor();
  await page.getByRole('button', { name: '检查本场题池', exact: true }).click();
  const pool = page.getByRole('complementary', { name: '题池检查', exact: true });
  await pool.getByText('《面试经典》共 4 题，其中 1 题还没有缓存到本机，不能抽取', { exact: true }).waitFor();
  const first = (await calls('preview')).at(-1)[1]; assert.equal(first.listId, 'list-a'); assert.equal(first.excludeRecentDays, 14);
  const shortage = pool.getByRole('alert'); await shortage.getByText('有 2 道题因为最近 14 天内练过而没有入选。', { exact: true }).waitFor();
  assert.equal(await pool.getByRole('button', { name: '开始本场面试', exact: true }).count(), 0);
  await pool.getByText('未入选的题目（3）', { exact: true }).click(); await shot('interview-shortage.png');
  const groups = await pool.locator('.interview-exclusions li').allTextContents();
  assert.ok(groups[0].includes('近期已经练习') && groups[0].includes('2 题') && groups[0].includes('两数之和、LRU 缓存'), JSON.stringify(groups));
  assert.ok(groups[1].includes('实现 Trie') && !groups.join().includes('lru-cache'), 'excluded problems are named by title, not by internal id');
  await shortage.getByRole('button', { name: '包含近期练过的题，重新检查', exact: true }).click();
  await pool.getByText('2', { exact: true }).waitFor(); await pool.getByRole('button', { name: '开始本场面试', exact: true }).waitFor();
  await shot('interview-ready.png'); const second = (await calls('preview')).at(-1)[1]; assert.equal(second.excludeRecentDays, 0); assert.equal(second.listId, 'list-a', 'the list scope is kept when the recent filter is lifted');
  assert.equal(await page.getByLabel('排除近期天数', { exact: true }).inputValue(), '0'); assert.equal(await pool.getByRole('alert').count(), 0);
  assert.equal(await pool.locator('.interview-pool-count').textContent(), '2 道符合条件的 Python 题目');
  pass('A study list scopes the interview pool; a shortage caused by recent practice is explained and fixed in one click without losing the scope');

  await page.evaluate(() => window.fixture.interview([]));
  await wait(() => document.querySelector('select[aria-label="题目范围"]').value === '');
  assert.deepEqual(await scope.locator('option').allTextContents(), ['全部题库']); await pool.getByText('请先检查题池', { exact: true }).waitFor();
  pass('Removing the selected list returns the scope to the whole library and discards the stale pool check');

  // The one reported error is the review start this test made fail on purpose.
  assert.deepEqual(errors, []); assert.deepEqual(await calls('error'), [['error', '复习会话暂时无法开始。']]);
  console.log(JSON.stringify({ result: 'passed', assertions: passed.length }));
} catch (error) {
  process.exitCode = 1; console.error(error); console.log(JSON.stringify({ result: 'failed', passed, rendererErrors: errors }));
} finally { await browser.close(); }
