import { createHash } from 'node:crypto';
import { checkCancelled, failSchema, nonempty, record, requiredCount, requiredString, SourceError, type ObjectValue } from './errors.ts';
import { parseSource } from './identify.ts';
import { SourceTransport, type SourceAdapterOptions } from './transport.ts';
import { problemContent } from './problem-content.ts';
import type { FetchOptions, ProblemReference, SourceAdapter, SourcePlan, SourceProblemContent, SourceProblemMetadata, SourceReference } from './types.ts';
export { SourceError } from './errors.ts';
export type { SourceErrorCode } from './errors.ts';
export { parseSource, identifySources } from './identify.ts';
export type * from './types.ts';
export type { SourceAdapterOptions } from './transport.ts';
export { parseImportInput, previewImport } from './imports.ts';

function problemReference(value: unknown): ProblemReference {
  const q = record(value) ?? failSchema('question'); const slug = requiredString(q.titleSlug, 'question.titleSlug');
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) return failSchema('question.titleSlug');
  const id = q.id ?? q.questionId; const sourceId = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : requiredString(id, 'question.id');
  const premium = q.paidOnly ?? q.isPaidOnly; if (typeof premium !== 'boolean') return failSchema('question.paidOnly');
  return { sourceKey: `leetcode-cn:problem:${slug}`, slug, sourceId, frontendId: requiredString(q.questionFrontendId, 'question.questionFrontendId'),
    title: requiredString(q.title, 'question.title'), translatedTitle: nonempty(q.translatedTitle) ? q.translatedTitle : null,
    difficulty: requiredString(q.difficulty, 'question.difficulty'), premiumOnly: premium, canonicalUrl: `https://leetcode.cn/problems/${slug}/` };
}
function dataField(next: ObjectValue, field: string): unknown {
  const state = record(record(record(next.props)?.pageProps)?.dehydratedState);
  if (!Array.isArray(state?.queries)) return failSchema('dehydratedState.queries');
  for (const value of state.queries) { const data = record(record(record(value)?.state)?.data); if (data && Object.hasOwn(data, field)) return data[field]; }
  return failSchema(field);
}
const FAVORITE_HEADER = 'query favoriteDetailV2($favoriteSlug: String!) { favoriteDetailV2(favoriteSlug: $favoriteSlug) { name slug questionNumber isPublicFavorite lastModified } }';
// Normal site operation, verified against the CN endpoint; no schema introspection.
const FAVORITE_PAGE = 'query favoriteQuestionList($favoriteSlug: String!, $limit: Int, $skip: Int) { favoriteQuestionList(favoriteSlug: $favoriteSlug, limit: $limit, skip: $skip, version: "v2") { questions { difficulty id paidOnly questionFrontendId title titleSlug translatedTitle } totalLength hasMore } }';

export class LeetCodeCnSourceAdapter implements SourceAdapter {
  private readonly transport: SourceTransport;
  constructor(options: SourceAdapterOptions = {}) { this.transport = new SourceTransport(options); }
  async fetchPlan(input: string | SourceReference, options: FetchOptions = {}): Promise<SourcePlan> {
    const source = parseSource(typeof input === 'string' ? input : input.canonicalUrl);
    if (source.kind === 'problem') throw new SourceError('WRONG_SOURCE_KIND', 'fetchPlan 需要学习计划或收藏链接。');
    checkCancelled(options.signal);
    if (source.kind === 'public-list') return this.fetchFavorite(source, options);
    const page = await this.transport.html(source.canonicalUrl, options); const value = dataField(page.next, 'studyPlanV2Detail');
    if (value === null) throw new SourceError('NOT_FOUND_OR_RESTRICTED', '页面 HTTP 200 但计划数据为 null；不能证明这是空题单。');
    const plan = record(value) ?? failSchema('studyPlanV2Detail');
    if (plan.slug !== source.slug) return failSchema('studyPlanV2Detail.slug');
    if (!Array.isArray(plan.planSubGroups)) return failSchema('planSubGroups');
    let itemCount = 0; const seen = new Set<string>(); const duplicates = new Set<string>();
    const sections = plan.planSubGroups.map((value: unknown) => {
      const group = record(value) ?? failSchema('planSubGroups[]'); const declaredCount = requiredCount(group.questionNum, 'questionNum');
      if (!Array.isArray(group.questions)) return failSchema('questions');
      if (group.questions.length !== declaredCount) throw new SourceError('INCOMPLETE_PLAN', '章节成员数与来源声明不一致，可能需要分页或访问权限。', { declaredCount, actualCount: group.questions.length });
      itemCount += group.questions.length;
      if (itemCount > this.transport.maxPlanItems) throw new SourceError('PLAN_TOO_LARGE', '题单超过本次导入上限。', { maxPlanItems: this.transport.maxPlanItems });
      const questions = group.questions.map(problemReference);
      questions.forEach(q => { if (seen.has(q.sourceKey)) duplicates.add(q.sourceKey); seen.add(q.sourceKey); });
      return { slug: requiredString(group.slug, 'group.slug'), name: requiredString(group.name, 'group.name'), declaredCount, questions };
    });
    if (typeof plan.premiumOnly !== 'boolean') return failSchema('plan.premiumOnly');
    return { source, name: requiredString(plan.name, 'plan.name'), premiumOnly: plan.premiumOnly, sections, itemCount, uniqueItemCount: seen.size,
      duplicateSourceKeys: [...duplicates], completeness: 'matches-embedded-section-counts', pagination: 'all-members-embedded-in-one-response', observation: page.observation };
  }
  private async fetchFavorite(source: SourceReference, options: FetchOptions): Promise<SourcePlan> {
    const header = async () => {
      const response = await this.transport.graphql(FAVORITE_HEADER, { favoriteSlug: source.slug }, source.canonicalUrl, options);
      if (response.data.favoriteDetailV2 === null) throw new SourceError('NOT_FOUND_OR_RESTRICTED', '收藏不存在或当前会话无权查看；没有把它解释成空题单。');
      const detail = record(response.data.favoriteDetailV2) ?? failSchema('favoriteDetailV2');
      if (detail.slug !== source.slug) return failSchema('favoriteDetailV2.slug');
      if (typeof detail.isPublicFavorite !== 'boolean') return failSchema('favoriteDetailV2.isPublicFavorite');
      if (!detail.isPublicFavorite && this.transport.sessionMode !== 'user-session') throw new SourceError('AUTH_REQUIRED', '私有收藏需要用户自己的正常登录会话。');
      requiredString(detail.lastModified, 'favoriteDetailV2.lastModified');
      return { detail, response, count: requiredCount(detail.questionNumber, 'favoriteDetailV2.questionNumber') };
    };
    const initial = await header();
    if (initial.count > this.transport.maxPlanItems) throw new SourceError('PLAN_TOO_LARGE', '收藏超过本次导入上限。', { declaredCount: initial.count, maxPlanItems: this.transport.maxPlanItems });
    const questions: ProblemReference[] = []; const seen = new Set<string>(); const observations = [initial.response.observation];
    let hasMore = initial.count > 0; let pageCount = 0;
    while (hasMore) {
      checkCancelled(options.signal);
      if (++pageCount > this.transport.maxPages) throw new SourceError('INCOMPLETE_PLAN', '收藏超过分页请求上限，未返回部分题单作为成功结果。', { fetchedCount: questions.length, declaredCount: initial.count });
      const response = await this.transport.graphql(FAVORITE_PAGE, { favoriteSlug: source.slug, limit: this.transport.pageSize, skip: questions.length }, source.canonicalUrl, options);
      observations.push(response.observation);
      const page = record(response.data.favoriteQuestionList) ?? failSchema('favoriteQuestionList');
      if (requiredCount(page.totalLength, 'favoriteQuestionList.totalLength') !== initial.count) throw new SourceError('SOURCE_CHANGED', '收藏在分页期间发生变化，请重新读取预览。', {}, true);
      if (!Array.isArray(page.questions) || typeof page.hasMore !== 'boolean') return failSchema('favoriteQuestionList.questions/hasMore');
      if (page.questions.length === 0 || page.questions.length > this.transport.pageSize) throw new SourceError('INCOMPLETE_PLAN', '收藏分页没有按声明推进。', { fetchedCount: questions.length });
      for (const item of page.questions) { const q = problemReference(item); if (seen.has(q.sourceKey)) throw new SourceError('INCOMPLETE_PLAN', '收藏分页出现重复成员，可能发生重排；已停止。'); seen.add(q.sourceKey); questions.push(q); }
      hasMore = page.hasMore;
      if (questions.length > initial.count || (hasMore && questions.length >= initial.count)) throw new SourceError('INCOMPLETE_PLAN', '收藏总数与分页结束标记不一致。');
    }
    if (questions.length !== initial.count) throw new SourceError('INCOMPLETE_PLAN', '收藏分页提前结束，成员未完整获取。', { fetchedCount: questions.length, declaredCount: initial.count });
    const final = await header(); observations.push(final.response.observation);
    if (final.count !== initial.count || final.detail.lastModified !== initial.detail.lastModified || final.detail.isPublicFavorite !== initial.detail.isPublicFavorite) throw new SourceError('SOURCE_CHANGED', '收藏在读取期间发生变化，请重新读取预览。', {}, true);
    return { source, name: requiredString(initial.detail.name, 'favorite.name'), premiumOnly: false,
      sections: [{ slug: `${source.slug}-all`, name: '全部题目', declaredCount: initial.count, questions }], itemCount: questions.length, uniqueItemCount: questions.length,
      duplicateSourceKeys: [], completeness: 'matches-declared-total-and-pagination', pagination: 'offset-pages-verified', observation: initial.response.observation, observations,
      visibility: initial.detail.isPublicFavorite ? 'public' : 'private', ...(nonempty(initial.detail.lastModified) ? { sourceRevision: initial.detail.lastModified } : {}) };
  }
  private async question(input: string | SourceReference, options: FetchOptions) {
    const source = parseSource(typeof input === 'string' ? input : input.canonicalUrl);
    if (source.kind !== 'problem') throw new SourceError('WRONG_SOURCE_KIND', '需要单题链接。');
    const page = await this.transport.html(source.canonicalUrl, options); const value = dataField(page.next, 'question');
    if (value === null) throw new SourceError('NOT_FOUND_OR_RESTRICTED', '当前来源未提供题面，可能不存在或需要相应访问权限。');
    const q = record(value) ?? failSchema('question'); const problem = problemReference(q);
    if (problem.slug !== source.slug) return failSchema('question.titleSlug');
    return { source, page, q, problem };
  }
  async fetchProblem(input: string | SourceReference, options: FetchOptions = {}): Promise<SourceProblemMetadata> {
    const { source, page, q, problem } = await this.question(input, options);
    let metadata: ObjectValue | null = null;
    if (nonempty(q.metaData)) { try { metadata = record(JSON.parse(q.metaData)); } catch { return failSchema('question.metaData'); } }
    const templates: SourceProblemMetadata['templates'] = [];
    if (!Array.isArray(q.codeSnippets)) return failSchema('question.codeSnippets');
    for (const value of q.codeSnippets) { const s = record(value); if (s && (s.langSlug === 'python3' || s.langSlug === 'java') && nonempty(s.code)) templates.push({ language: s.langSlug, characterCount: s.code.length, sha256: createHash('sha256').update(s.code).digest('hex') }); }
    const params = metadata && Array.isArray(metadata.params) ? metadata.params : []; const returnInfo = record(metadata?.return);
    return { source, problem, fields: { statement: nonempty(q.content), translatedStatement: nonempty(q.translatedContent), functionMetadata: metadata !== null, sampleCases: nonempty(q.exampleTestcases) || nonempty(q.sampleTestCase) || nonempty(q.jsonExampleTestcases) },
      functionSignature: metadata ? { name: nonempty(metadata.name) ? metadata.name : null, parameterTypes: params.map(p => record(p)?.type).filter(nonempty), returnType: nonempty(returnInfo?.type) ? returnInfo.type : null } : null,
      templates, observation: page.observation, limitation: 'metadata-only; no statement, sample text, or template body retained' };
  }
  async fetchProblemContent(input: string | SourceReference, options: FetchOptions = {}): Promise<SourceProblemContent> {
    const { source, page, q, problem } = await this.question(input, options);
    return problemContent(q, source, problem, page.observation);
  }
}
export async function fetchProblemContent(input: string | SourceReference, options: FetchOptions & { adapter?: LeetCodeCnSourceAdapter } = {}) {
  return (options.adapter ?? new LeetCodeCnSourceAdapter()).fetchProblemContent(input, options);
}
