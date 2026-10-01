import type { AiEvidenceReference, AiRequestSnapshot } from '../shared/ai.ts';
import { canonicalJson, sha256 } from './canonical.ts';

export interface AiEvidenceCatalogEntry extends AiEvidenceReference { referenceId: string; }
type EvidenceSource = Pick<AiRequestSnapshot, 'attemptId' | 'problemVersion' | 'codeHash' | 'answerFormat' | 'specVersion' | 'testConfigDigest' | 'run' | 'official' | 'clippedFields'>;

/** Main-process generated citations. The model selects a reference, never invents its provenance. */
export function buildEvidenceCatalog(source: EvidenceSource): AiEvidenceCatalogEntry[] {
  const result: AiEvidenceCatalogEntry[] = [];
  const matches = (row: { attemptId: string; problemVersion: string; codeHash: string } | null | undefined) => !!row
    && row.attemptId === source.attemptId && row.problemVersion === source.problemVersion && row.codeHash === source.codeHash;
  const add = (reference: AiEvidenceReference) => {
    if (!reference.quote.trim() || reference.quote.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reference.quote)) return;
    const referenceId = `ev-${sha256(canonicalJson({ attemptId: source.attemptId, problemVersion: source.problemVersion,
      codeHash: source.codeHash, answerFormat: source.answerFormat, specVersion: source.specVersion,
      testConfigDigest: source.testConfigDigest, reference })).slice(0, 24)}`;
    const entry = { referenceId, ...reference };
    // Keep evidence duplication inside the request's bounded context budget.
    if (result.length < 20 && Buffer.byteLength(canonicalJson([...result, entry])) <= 16 * 1024
      && !result.some(item => item.referenceId === referenceId)) result.push(entry);
  };
  const official = source.official;
  if (matches(official) && official && source.answerFormat !== 'acm') {
    add({ runId: official.id, kind: 'official', quote: canonicalJson(Object.fromEntries(
      ['status', 'statusMessage', 'passedCases', 'totalCases', 'runtime', 'memory'].filter(key => Object.hasOwn(official, key))
        .map(key => [key, official[key as keyof typeof official]]))) });
    for (const field of ['compileError', 'runtimeError', 'input', 'actualOutput', 'expectedOutput'] as const) {
      if (typeof official[field] === 'string') add({ runId: official.id, kind: 'official', quote: official[field]!.slice(0, 2000) });
    }
  }
  const run = source.run;
  if (matches(run) && run && (source.answerFormat === undefined || (run.answerFormat === source.answerFormat
    && run.specVersion === source.specVersion && run.testConfigDigest === source.testConfigDigest))) {
    const kind = run.status === 'compile_error' ? 'compiler' : ['runtime_error', 'timeout', 'output_limit'].includes(run.status) ? 'exception' : null;
    if (kind) {
      for (const diagnostic of run.diagnostics.filter(diagnostic => diagnostic.source === 'user')) add({ runId: run.id, kind, quote: diagnostic.message.slice(0, 2000) });
      if (kind === 'exception') for (const quote of [run.stdout, run.stderr]) add({ runId: run.id, kind, quote: quote.slice(0, 2000) });
    }
    if (run.trustworthyExpected) for (const [position, test] of run.caseResults.entries()) {
      if (!Number.isInteger(test.index) || test.index < 0 || !['passed', 'wrong_answer'].includes(test.status)
        || !Object.hasOwn(test, 'expected') || source.clippedFields.some(field => field === `run.cases.${position}.actual` || field === `run.cases.${position}.expected`)) continue;
      add({ runId: run.id, kind: 'test', caseIndex: test.index, quote: canonicalJson(test) });
    }
  }
  return result;
}

/** Requires both the frozen sent catalog and independently source-bound provenance. */
export function resolveEvidenceReference(referenceId: string, snapshot: AiRequestSnapshot): AiEvidenceReference | null {
  const sent = snapshot.evidenceCatalog?.find(entry => entry.referenceId === referenceId);
  if (!sent) return null;
  const trusted = buildEvidenceCatalog(snapshot).find(entry => entry.referenceId === referenceId);
  if (!trusted || canonicalJson(trusted) !== canonicalJson(sent)) return null;
  const { referenceId: _id, ...reference } = trusted;
  return reference;
}
