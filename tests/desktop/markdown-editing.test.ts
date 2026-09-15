import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMarkdownCommand, noteTitle } from '../../src/renderer/markdown-editing';

test('formatting preserves Chinese selections and toggles inline emphasis', () => {
  const bold = applyMarkdownCommand('当前解法可用', 2, 4, 'bold');
  assert.deepEqual(bold, { value: '当前**解法**可用', start: 4, end: 6 });
  assert.deepEqual(applyMarkdownCommand(bold.value, bold.start, bold.end, 'bold'), { value: '当前解法可用', start: 2, end: 4 });
  assert.deepEqual(applyMarkdownCommand('', 0, 0, 'italic'), { value: '*文字*', start: 1, end: 3 });
});
test('heading edits only the current paragraph and can change or remove its level', () => {
  assert.deepEqual(applyMarkdownCommand('前文\n思路\n后文', 4, 4, 'h2'), { value: '前文\n## 思路\n后文', start: 7, end: 7 });
  assert.equal(applyMarkdownCommand('## 思路', 5, 5, 'h1').value, '# 思路');
  assert.equal(applyMarkdownCommand('## 思路', 5, 5, 'h2').value, '思路');
});
test('multiline list selection excludes the following unselected line', () => {
  const list = applyMarkdownCommand('甲\n乙\n丙', 0, 4, 'numbered');
  assert.equal(list.value, '1. 甲\n2. 乙\n丙');
  assert.equal(applyMarkdownCommand(list.value, list.start, list.end, 'numbered').value, '甲\n乙\n丙');
  assert.equal(applyMarkdownCommand('- 甲\n- 乙', 0, 7, 'numbered').value, '1. 甲\n2. 乙');
});
test('link command selects the destination and fenced code handles embedded backticks', () => {
  const link = applyMarkdownCommand('参考解法', 0, 4, 'link');
  assert.equal(link.value, '[参考解法](https://)');
  assert.equal(link.value.slice(link.start, link.end), 'https://');
  const code = applyMarkdownCommand('```py\nx\n```', 0, 11, 'code-block');
  assert.equal(code.value, '````\n```py\nx\n```\n````');
  assert.equal(code.value.slice(code.start, code.end), '```py\nx\n```');
});
test('optional titles are deterministic and whitespace-only input falls back to the subject', () => {
  assert.equal(noteTitle(' 我的方法 ', '# 其他', '两数之和'), '我的方法');
  assert.equal(noteTitle('', '开头\n## **哈希表**解法', '两数之和'), '哈希表解法');
  assert.equal(noteTitle('  ', '正文', '两数之和'), '两数之和 · 笔记');
  assert.equal(noteTitle('', '', ''), '算法 · 笔记');
  assert.equal(noteTitle('题'.repeat(400), '', '').length, 300);
});
