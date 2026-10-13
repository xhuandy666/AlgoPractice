import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANGUAGES, LANGUAGE_DETAILS, isLanguage, languageFromOfficialSlug } from '../../src/shared/languages.ts';
import { capability } from '../../src/shared/capability.ts';
import { demoContent } from '../../src/shared/presentation.ts';
import { demoProblems } from '../../src/shared/demo-problems.ts';
import { buildPool } from '../../src/interview/sampling.ts';
import { defaultInterviewRules } from '../../src/shared/interview.ts';

test('language IDs are shared, closed and map to separate official/compiler identities', () => {
  assert.deepEqual(LANGUAGES, ['python', 'java', 'go', 'cpp']);
  for (const language of LANGUAGES) {
    assert.equal(isLanguage(language), true);
    assert.equal(languageFromOfficialSlug(LANGUAGE_DETAILS[language].officialSlug), language);
  }
  for (const value of ['golang', 'c++', 'zig', 'rust', 'GO', '', null, {}, ['cpp'], '__proto__']) assert.equal(isLanguage(value), false);
  assert.equal(languageFromOfficialSlug('go'), undefined);
});

test('every authored demo has four templates and capability rejects missing or unsupported local signatures', () => {
  for (const problem of demoProblems) for (const language of LANGUAGES) {
    assert.ok(problem.starter[language].trim()); assert.equal(capability(demoContent(problem), language).canRun, true);
  }
  const content = { ...demoContent(demoProblems[0]), adapter: { method: 'solve', params: [{ array: 'bigint' as const }], returns: 'bigint' as const } };
  assert.equal(capability(content, 'go').canRun, true);
  assert.equal(capability(content, 'cpp').canRun, false);
  assert.match(capability(content, 'cpp').reason, /本地函数适配暂不支持/);
  const missing = { ...content, starter: { python: content.starter.python } };
  assert.equal(capability(missing, 'go').canRun, false); assert.match(capability(missing, 'go').reason, /缺少 Go 模板/);
});

for (const language of ['go', 'cpp'] as const) for (const mode of ['strict', 'coached'] as const) test(`${language} ${mode} interviews use their frozen template and exact language capability`, () => {
  const content = { ...demoContent(demoProblems[0]), difficulty: '简单' };
  const problem = { id: content.id, version: 'fixture-v1', content, createdAt: '', updatedAt: '' };
  const rules = { ...defaultInterviewRules, language, mode, counts: { easy: 1, medium: 0, hard: 0 }, excludeRecentDays: 0, seed: 'four-language-fixture' };
  const pool = buildPool([problem], [], rules, null);
  assert.deepEqual(pool.selectedIds, [content.id]); assert.equal(pool.rules.language, language); assert.equal(pool.rules.mode, mode);
  const missing = buildPool([{ ...problem, content: { ...content, starter: { python: content.starter.python } } }], [], rules, null);
  assert.deepEqual(missing.selectedIds, []); assert.equal(missing.exclusions.length, 1); assert.ok(missing.shortages.length);
});
