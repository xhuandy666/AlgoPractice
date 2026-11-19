import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

// Isolated renderer fixtures with a mocked bridge and authored problems: no Electron, database, network or runtime.
// Covers the pane dividers (line and grip share one drag gesture) and the library's "show all" recovery from empty filters.
const root = resolve(import.meta.dirname, '..');
const compiled = await build({
  stdin: { resolveDir: root, loader: 'tsx', sourcefile: 'workbench-controls-ui-fixture.tsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import './tokens.css';
    import './src/renderer/styles.css';
    import './src/renderer/shell.css';
    import './src/renderer/workbench-layout.css';
    import { WorkbenchSplitter } from './src/renderer/WorkbenchSplitter';
    import { LibraryPage } from './src/renderer/LibraryPage';

    const calls = [];
    const languages = { python: true, java: true, go: false, cpp: false, cppTemplate: false };
    const problem = (id, title, difficulty, extra = {}) => ({ id, version: 1, content: { title, difficulty, tags: ['数组'], source: 'local', sourceUrl: null },
      capability: { canRun: true, label: '本地可运行' }, capabilities: { ...languages, ...extra.capabilities }, practice: extra.practice ?? { solved: false, practiced: false, reviewDue: false } });
    const problems = [
      problem('p1', '数组求和', '基础', { capabilities: { go: true } }),
      problem('p2', '文本反转', '简单'),
      problem('p3', '输入求和', '中等', { capabilities: { go: true }, practice: { solved: false, practiced: true, reviewDue: false } }),
    ];
    const api = {
      problemPage: async filter => {
        calls.push(['page', filter]);
        const items = problems.filter(item => (!filter.search || item.content.title.includes(filter.search)) && (!filter.difficulty || item.content.difficulty === filter.difficulty)
          && (!filter.language || item.capabilities[filter.language]) && (!filter.support || (filter.support === 'runnable') === item.capability.canRun)
          && (!filter.practice || (filter.practice === 'solved' ? item.practice.solved : filter.practice === 'practiced' ? item.practice.practiced : filter.practice === 'unpracticed' ? !item.practice.practiced : item.practice.reviewDue)));
        return { items, total: items.length, offset: 0, limit: 30, hasMore: false };
      },
      sourceSession: async () => ({ hasSession: false }),
    };
    function Dividers() {
      const [history, setHistory] = useState(380), [results, setResults] = useState(200);
      return <div className="workbench workbench-p2" data-layout="columns" data-statement="false" data-history-size={history} data-results-size={results}
        style={{ width: 1000, height: 600, gridTemplateColumns: 'minmax(0, 1fr) 12px ' + history + 'px', '--results-size': results + 'px' }}>
        <section className="coding-pane"><div className="editor-toolbar">工具栏</div><div className="editor-host">编辑器</div>
          <WorkbenchSplitter side="results" value={results} min={120} max={400} defaultValue={200} onChange={setResults} />
          <div className="results-pane">测试结果</div></section>
        <WorkbenchSplitter side="history" value={history} min={280} max={600} defaultValue={380} onChange={setHistory} />
        <aside className="history-pane">记录与 AI</aside>
      </div>;
    }
    const app = createRoot(document.getElementById('root'));
    window.fixture = { calls,
      dividers() { app.render(<Dividers />); },
      library() { app.render(<LibraryPage api={api} data={{ problems: [], totalProblems: problems.length, lists: [], jobs: [] }} onOpen={() => {}} onImport={() => {}} onChanged={async () => {}} onError={error => calls.push(['error', error])} />); },
    };
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false, outfile: 'workbench-controls-ui-fixture.js', logLevel: 'silent',
});
const browser = await chromium.launch({ headless: true, ...(process.env.ALGOPRACTICE_TEST_BROWSER ? { channel: process.env.ALGOPRACTICE_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
const errors = [], passed = [];
page.on('pageerror', error => errors.push(error.message));
await page.route(/^https?:\/\//, route => route.abort());
const pass = name => { passed.push(name); console.log('PASS', name); };
const frames = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
try {
  await page.setContent('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body><main id="root"></main></body></html>');
  await page.addStyleTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.js')).text });

  await page.evaluate(() => window.fixture.dividers());
  const line = page.getByRole('separator', { name: '调整记录宽度', exact: true });
  const grip = page.getByRole('button', { name: '调整记录宽度选项', exact: true });
  const menu = page.getByRole('group', { name: '调整记录宽度操作', exact: true });
  const width = async () => Number(await line.getAttribute('aria-valuenow'));
  const center = async locator => { const box = await locator.boundingBox(); assert.ok(box && box.width > 0 && box.height > 0); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  const drag = async (from, dx, dy, release = true) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 }); if (release) { await page.mouse.up(); await frames(); }
  };
  await line.waitFor(); assert.equal(await width(), 380);
  assert.equal(await grip.evaluate(element => getComputedStyle(element).cursor), 'col-resize', 'the grip advertises dragging, like the line');

  // The review measured exactly this: 64 px from the grip left the pane unchanged, while the line above it moved.
  await drag(await center(grip), -64, 0);
  assert.equal(await width(), 444, 'dragging the grip left widens the right pane by the pointer travel');
  assert.equal(await menu.count(), 0, 'a drag that ends on the grip does not open the size menu');
  assert.equal(await page.locator('html[data-workbench-resizing]').count(), 0);
  const gripCenter = await center(grip);
  await drag({ x: gripCenter.x, y: gripCenter.y - 120 }, 64, 0);
  assert.equal(await width(), 380, 'the line above the grip moves the pane by the same travel');
  await drag({ x: (await center(grip)).x, y: (await center(grip)).y + 120 }, -30, 0);
  assert.equal(await width(), 410, 'the line below the grip behaves the same');
  pass('Grip and line resize the pane by the same pointer travel, from the center, above and below');

  await drag(await center(grip), -40, 0, false);
  assert.equal(await page.locator('html[data-workbench-resizing=column]').count(), 1);
  assert.equal(await page.locator('.history-splitter[data-dragging=true]').count(), 1);
  assert.equal(await grip.evaluate(element => getComputedStyle(element).visibility), 'visible', 'the grip stays under the pointer while dragging');
  await page.mouse.up(); await frames(); assert.equal(await width(), 450);
  await drag(await center(grip), 700, 0); assert.equal(await width(), 280, 'dragging past the limit stops at the minimum width');
  await drag(await center(grip), -900, 0); assert.equal(await width(), 600, 'and at the maximum width');
  assert.equal(await page.locator('html[data-workbench-resizing]').count(), 0); assert.equal(await menu.count(), 0);
  pass('Dragging shows the resize state, keeps the grip visible, clamps at both limits and releases cleanly');

  await grip.click(); await menu.waitFor(); assert.equal(await width(), 600, 'a still click opens the menu without resizing');
  await menu.getByRole('button', { name: '缩小记录与 AI', exact: true }).click(); assert.equal(await width(), 552);
  await menu.getByRole('button', { name: '恢复默认', exact: true }).click(); assert.equal(await width(), 380);
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
  assert.equal(await grip.evaluate(element => element === document.activeElement), true, 'Escape returns focus to the grip');
  // A press that wobbles less than the 4 px threshold is still a click.
  const still = await center(grip);
  await page.mouse.move(still.x, still.y); await page.mouse.down(); await page.mouse.move(still.x + 2, still.y + 1); await page.mouse.up();
  await menu.waitFor(); assert.equal(await width(), 380);
  await drag(await center(grip), -50, 0); assert.equal(await width(), 430); assert.equal(await menu.count(), 0, 'starting a drag closes an open menu');
  await grip.focus(); await page.keyboard.press('Enter'); await menu.waitFor(); await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
  pass('A still or slightly wobbly click opens the size menu, keyboard activation still works, and a drag closes the menu');

  await line.focus(); await page.keyboard.press('Home'); assert.equal(await width(), 280);
  await page.keyboard.press('ArrowLeft'); assert.equal(await width(), 304); await page.keyboard.press('Enter'); assert.equal(await width(), 380);
  await line.dblclick({ position: { x: 6, y: 40 } }); assert.equal(await width(), 380, 'double click on the line still restores the default');
  const resultsLine = page.getByRole('separator', { name: '调整测试结果高度', exact: true });
  const resultsGrip = page.getByRole('button', { name: '调整测试结果高度选项', exact: true });
  assert.equal(await resultsGrip.evaluate(element => getComputedStyle(element).cursor), 'row-resize');
  await drag(await center(resultsGrip), 0, -50); assert.equal(Number(await resultsLine.getAttribute('aria-valuenow')), 250, 'dragging the results grip up grows the results area');
  await drag(await center(resultsGrip), 0, 400); assert.equal(Number(await resultsLine.getAttribute('aria-valuenow')), 120);
  pass('Keyboard steps, Home and Enter still work on the line, and the horizontal results divider drags from its grip too');

  await page.evaluate(() => window.fixture.library());
  const rows = page.locator('.problem-table-row');
  // Each pill's visible label is a screen-reader span beside the select, so address the select through that span.
  const pill = name => page.locator('label.filter-pill').filter({ has: page.locator('span.sr-only', { hasText: new RegExp('^' + name + '$') }) }).locator('select');
  const progress = pill('练习进度'), language = pill('语言模板'), difficulty = pill('难度');
  const search = page.getByPlaceholder('题名、编号或标签');
  const showAll = page.getByRole('button', { name: '查看全部题目', exact: true }), clear = page.getByRole('button', { name: '清除筛选', exact: true });
  const count = async expected => { await page.waitForFunction(expected => document.querySelectorAll('.problem-table-row').length === expected && document.querySelector('.problem-table').getAttribute('aria-busy') === 'false', expected); };
  await count(3); assert.equal(await clear.count(), 0, 'no clear control without an active filter');

  // Topic tags name the technique, so rows show them only when asked.
  const meta = rows.first().locator('.problem-name p'), topics = page.getByLabel('显示专题', { exact: true });
  assert.equal(await meta.textContent(), '自建样例', 'topic tags are hidden by default'); assert.equal(await topics.isChecked(), false);
  await topics.check(); assert.equal(await meta.textContent(), '数组 · 自建样例');
  await topics.uncheck(); assert.equal(await meta.textContent(), '自建样例');
  pass('Library rows hide topic tags until "显示专题" is checked');

  await progress.selectOption('solved'); await count(0); await showAll.click(); await count(3);
  assert.equal(await progress.inputValue(), '', 'the progress filter is reset together with the list'); assert.equal(await clear.count(), 0);
  await language.selectOption('cpp'); await count(0); await showAll.click(); await count(3); assert.equal(await language.inputValue(), '');
  await progress.selectOption('solved'); await language.selectOption('go'); await count(0); await showAll.click(); await count(3);
  assert.equal(await progress.inputValue(), ''); assert.equal(await language.inputValue(), '');
  pass('"查看全部题目" restores all three samples from a progress filter, a language filter, and both together');

  await search.fill('求和'); await difficulty.selectOption('中等'); await language.selectOption('go'); await progress.selectOption('practiced'); await count(1);
  assert.equal(await rows.first().getByRole('button', { name: '输入求和', exact: true }).count(), 1);
  await clear.click(); await count(3);
  assert.deepEqual([await search.inputValue(), await difficulty.inputValue(), await language.inputValue(), await progress.inputValue()], ['', '', '', '']);
  assert.equal(await clear.count(), 0); assert.equal(await page.locator('.filter-pill[data-active=true]').count(), 0);
  const last = await page.evaluate(() => window.fixture.calls.filter(call => call[0] === 'page').at(-1)[1]);
  assert.deepEqual([last.search, last.difficulty, last.language, last.practice, last.support, last.listId, last.offset], ['', undefined, undefined, undefined, undefined, undefined, 0]);
  pass('"清除筛选" appears only while a filter is active and clears search, difficulty, language and progress in one step');

  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter(call => call[0] === 'error')), []);
  console.log(JSON.stringify({ result: 'passed', assertions: passed.length }));
} catch (error) {
  process.exitCode = 1; console.error(error); console.log(JSON.stringify({ result: 'failed', passed, rendererErrors: errors }));
} finally { await browser.close(); }
