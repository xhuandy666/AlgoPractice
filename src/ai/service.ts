import { randomUUID } from 'node:crypto';
import type { AiConnectionResult, AiConversationMemory, AiEvent, AiPatchApplication, AiProviderConfig, AiProviderState, AiRepository, AiRequestInput, AiRequestRecord, AiRequestSnapshot, AiTrustedContext, AiUsage } from '../shared/ai.ts';
import { canonicalJson, identifier, normalizeProviderConfig, sha256, validateRequestInput } from './canonical.ts';
import { assertMode, buildRequestSnapshot, requestHash } from './context.ts';
import { CredentialVault } from './credential-vault.ts';
import { AiServiceError, checkAbort, publicAiError, withAbort } from './errors.ts';
import { patchCode, validateResponse, validationRepairHint } from './policy.ts';
import { chatCompletion, combineUsage } from './provider.ts';
import { degradedConversationMemory, planConversationMemory, summarizedConversationMemory, summaryMessages, validateConversationSummary } from './conversation-memory.ts';

export interface AiServiceOptions {
  repository: AiRepository;
  vault: Pick<CredentialVault, 'secureStorageAvailable' | 'hasKey' | 'setKey' | 'clearKey' | 'withKey'>;
  /** Trusted database resolver, not renderer-supplied context. */
  resolveContext(input: AiRequestInput): AiTrustedContext | Promise<AiTrustedContext>;
  resolveProvider(): AiProviderConfig | null | Promise<AiProviderConfig | null>;
  onEvent?(event: AiEvent): void;
  fetchImpl?: typeof fetch;
}
interface ActiveRequest { controller: AbortController; promise: Promise<AiRequestRecord>; snapshot: AiRequestSnapshot; hash: string; }
const terminal = (record: AiRequestRecord) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(record.status);
export class AiService {
  readonly #options: AiServiceOptions;
  readonly #active = new Map<string, ActiveRequest>();
  readonly #preparing = new Map<AbortController, { requestId: string; attemptId: string }>();
  readonly #probes = new Map<string, { controller: AbortController; promise: Promise<AiConnectionResult> }>();
  readonly #pending = new Map<string, { inputHash: string; promise: Promise<AiRequestRecord> }>();
  readonly #attemptTails = new Map<string, Promise<void>>();
  #epoch = 0;
  constructor(options: AiServiceOptions) { this.#options = options; }
  #repository<T>(operation: (repository: AiRepository) => T): T { try { return operation(this.#options.repository); } catch (error) { if (error instanceof AiServiceError) throw error; throw new AiServiceError('STORAGE'); } }
  async #provider(): Promise<AiProviderConfig | null> { try { const config = await this.#options.resolveProvider(); return config === null ? null : normalizeProviderConfig(config); } catch (error) { if (error instanceof AiServiceError) throw error; throw new AiServiceError('INVALID_CONFIG'); } }
  async #context(input: AiRequestInput): Promise<AiTrustedContext> { try { return await this.#options.resolveContext(input); } catch (error) { if (error instanceof AiServiceError) throw error; throw new AiServiceError('INVALID_REQUEST'); } }
  #validatedStored(record: AiRequestRecord): AiRequestRecord {
    try {
      if (record.requestHash !== requestHash(record.snapshot) || record.attemptId !== record.snapshot.attemptId || sha256(record.snapshot.code) !== record.snapshot.codeHash) throw new AiServiceError('STORAGE');
      if (record.status === 'completed') { if (!record.response) throw new AiServiceError('STORAGE'); return structuredClone({ ...record, response: validateResponse(canonicalJson(record.response), record.snapshot) }); }
      return structuredClone(record);
    } catch { throw new AiServiceError('STORAGE'); }
  }
  #emit(snapshot: AiRequestSnapshot, requestId: string, phase: AiEvent['phase'], receivedBytes?: number) {
    try { this.#options.onEvent?.({ requestId, attemptId: snapshot.attemptId, problemId: snapshot.problemId, codeHash: snapshot.codeHash, kind: snapshot.kind, phase, ...(receivedBytes !== undefined ? { receivedBytes } : {}) }); } catch { /* Observers cannot mutate request state. */ }
  }
  async providerState(): Promise<AiProviderState> {
    const config = await this.#provider();
    // Merely opening settings must not prompt for or wait on the OS keychain.
    // The vault still requires OS encryption when saving or decrypting a Key.
    return { config, hasKey: config ? await this.#options.vault.hasKey(config) : false, secureStorageAvailable: null };
  }
  async setKey(key: string): Promise<{ hasKey: true }> { const provider = await this.#provider(); if (!provider) throw new AiServiceError('NOT_CONFIGURED'); await this.stopAll(); return this.#options.vault.setKey(provider, key); }
  async clearKey(): Promise<void> { const provider = await this.#provider(); await this.stopAll(); if (provider) await this.#options.vault.clearKey(provider); }
  recoverInterrupted(): number { if (this.#active.size || this.#preparing.size || this.#probes.size) throw new AiServiceError('INVALID_REQUEST'); return this.#repository(repository => repository.recoverInterruptedAIRequests()); }
  cancel(requestId: string): void { identifier(requestId); this.#active.get(requestId)?.controller.abort(); for (const [controller, input] of this.#preparing) if (input.requestId === requestId) controller.abort(); }
  cancelAttempt(attemptId: string): void { identifier(attemptId); for (const active of this.#active.values()) if (active.snapshot.attemptId === attemptId) active.controller.abort(); for (const [controller, input] of this.#preparing) if (input.attemptId === attemptId) controller.abort(); }
  isAttemptBusy(attemptId: string): boolean { identifier(attemptId); return [...this.#active.values()].some(active => active.snapshot.attemptId === attemptId)
    || [...this.#preparing.values()].some(input => input.attemptId === attemptId); }
  async stopAll(): Promise<void> {
    this.#epoch++;
    for (const controller of this.#preparing.keys()) controller.abort();
    for (const active of this.#active.values()) active.controller.abort();
    for (const probe of this.#probes.values()) probe.controller.abort();
    const pending: Promise<unknown>[] = [...this.#pending.values()].map(value => value.promise);
    pending.push(...[...this.#probes.values()].map(probe => probe.promise));
    await Promise.allSettled(pending);
  }
  #matchesInput(record: AiRequestRecord, input: AiRequestInput): boolean {
    const snapshot = record.snapshot;
    return record.attemptId === input.attemptId && snapshot.kind === input.kind && snapshot.level === undefined && snapshot.question === input.question
      && snapshot.officialSubmissionId === input.officialSubmissionId && (!input.runId || snapshot.runId === input.runId)
      && canonicalJson(snapshot.selectedNoteIds) === canonicalJson(input.noteIds ?? []) && canonicalJson(snapshot.selectedConversationIds) === canonicalJson(input.conversationIds ?? []);
  }
  async request(rawInput: AiRequestInput): Promise<AiRequestRecord> {
    const input = validateRequestInput(rawInput), inputHash = sha256(canonicalJson({ ...input, noteIds: input.noteIds ?? [], conversationIds: input.conversationIds ?? [] }));
    const pending = this.#pending.get(input.requestId);
    if (pending) { if (pending.inputHash !== inputHash) throw new AiServiceError('REQUEST_CONFLICT'); return pending.promise; }
    const epoch = this.#epoch, controller = new AbortController(), previous = this.#attemptTails.get(input.attemptId) ?? Promise.resolve();
    this.#preparing.set(controller, { requestId: input.requestId, attemptId: input.attemptId });
    // Serialize logical requests for one attempt, including the summary call and main
    // answer. Separate attempts remain independent. Same IDs still coalesce above.
    const promise = Promise.resolve().then(async () => {
      await withAbort(previous, controller.signal); checkAbort(controller.signal);
      return this.#request(input, epoch, controller);
    }).finally(() => { this.#pending.delete(input.requestId); this.#preparing.delete(controller); });
    this.#pending.set(input.requestId, { inputHash, promise });
    const tail = promise.then(() => {}, () => {}); this.#attemptTails.set(input.attemptId, tail);
    void tail.then(() => { if (this.#attemptTails.get(input.attemptId) === tail) this.#attemptTails.delete(input.attemptId); });
    return promise;
  }
  async #request(input: AiRequestInput, epoch: number, controller: AbortController): Promise<AiRequestRecord> {
    try {
      const resolved = await withAbort(this.#context(input), controller.signal), context = JSON.parse(canonicalJson(resolved)) as AiTrustedContext;
      assertMode(context); if (context.attemptId !== input.attemptId) throw new AiServiceError('INVALID_REQUEST'); checkAbort(controller.signal);
      if (epoch !== this.#epoch) throw new AiServiceError('CANCELLED');
      const existing = this.#repository(repository => repository.getAIRequest(input.requestId));
      if (existing) {
        if (!this.#matchesInput(existing, input)) throw new AiServiceError('REQUEST_CONFLICT');
        const active = this.#active.get(input.requestId); if (active) return active.promise;
        if (terminal(existing)) return this.#validatedStored(existing);
        return structuredClone(this.#repository(repository => repository.finishAIRequest(existing.id, { status: 'interrupted', response: null, error: publicAiError(new AiServiceError('INTERRUPTED')), usage: null, cachedFromRequestId: null })));
      }
      const provider = await withAbort(this.#provider(), controller.signal); if (!provider) throw new AiServiceError('NOT_CONFIGURED');
      checkAbort(controller.signal); if (epoch !== this.#epoch) throw new AiServiceError('CANCELLED');
      // Validate current evidence before spending a call on history compaction.
      buildRequestSnapshot(input, context, provider);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(provider.timeoutMs)]);
      const prepared = await this.#memory(input.attemptId, provider, signal);
      const snapshot = buildRequestSnapshot(input, context, provider, prepared.memory), hash = requestHash(snapshot);
      const concurrent = this.#active.get(input.requestId); if (concurrent) { if (concurrent.hash !== hash) throw new AiServiceError('REQUEST_CONFLICT'); return concurrent.promise; }
      const seed = this.#repository(repository => repository.beginAIRequest({ id: input.requestId, attemptId: input.attemptId, requestHash: hash, snapshot }));
      if (seed.requestHash !== hash) throw new AiServiceError('REQUEST_CONFLICT'); if (terminal(seed)) return this.#validatedStored(seed);
      const promise = Promise.resolve().then(() => this.#execute(input, snapshot, signal, prepared.usages, prepared.error)).finally(() => { this.#active.delete(input.requestId); });
      this.#active.set(input.requestId, { controller, promise, snapshot, hash }); this.#emit(snapshot, input.requestId, 'queued'); return promise;
    } finally { this.#preparing.delete(controller); }
  }
  async #memory(attemptId: string, provider: AiProviderConfig, signal: AbortSignal): Promise<{ memory: AiConversationMemory; usages: Array<AiUsage | null>; error?: unknown }> {
    const records = this.#repository(repository => repository.listAIRequests(attemptId)).flatMap(record => {
      try { return record.attemptId === attemptId ? [this.#validatedStored(record)] : []; } catch { return []; }
    });
    const plan = planConversationMemory(records), usages: Array<AiUsage | null> = [];
    if (!plan.summarizeRounds.length) return { memory: plan.memory, usages };
    try {
      const summary = await withAbort(this.#options.vault.withKey(provider, async key => {
        checkAbort(signal);
        const completion = await withAbort(chatCompletion({ config: { ...provider, maxOutputTokens: Math.min(provider.maxOutputTokens, 2048) }, key,
          messages: summaryMessages(plan), signal, fetchImpl: this.#options.fetchImpl }), signal);
        usages.push(completion.usage); checkAbort(signal);
        if (key.length >= 6 && completion.content.includes(key)) throw new AiServiceError('POLICY_VIOLATION');
        const summary = validateConversationSummary(completion.content);
        if (key.length >= 6 && summary.includes(key)) throw new AiServiceError('POLICY_VIOLATION');
        return summary;
      }), signal);
      return { memory: summarizedConversationMemory(plan, summary), usages };
    } catch (error) {
      // Failed compaction cannot move the cursor or clear older useful memory.
      // Cancellation/timeout and secret echoes terminate this logical request; other
      // summary failures explicitly fall back to old summary + recent five rounds.
      return { memory: degradedConversationMemory(plan.memory), usages,
        ...(signal.aborted || error instanceof AiServiceError && error.detail.code === 'POLICY_VIOLATION' ? { error } : {}) };
    }
  }
  async #execute(input: AiRequestInput, snapshot: AiRequestSnapshot, signal: AbortSignal, usages: Array<AiUsage | null>, preparationError?: unknown): Promise<AiRequestRecord> {
    const finish = (completion: Parameters<AiRepository['finishAIRequest']>[1]) => this.#repository(repository => repository.finishAIRequest(input.requestId, completion));
    try {
      checkAbort(signal);
      if (preparationError) throw preparationError;
      const cached = this.#repository(repository => repository.findCompletedAIRequest(requestHash(snapshot)));
      if (cached?.response && cached.id !== input.requestId && cached.status === 'completed') {
        let valid = null; try { if (cached.requestHash === requestHash(cached.snapshot) && cached.requestHash === requestHash(snapshot)) valid = validateResponse(canonicalJson(this.#validatedStored(cached).response), snapshot); } catch { /* Ignore invalid cached records; never return raw content. */ }
        if (valid) {
          assertMode(await withAbort(this.#context(input), signal)); checkAbort(signal);
          const result = finish({ status: 'completed', response: valid, error: null, usage: combineUsage(usages), cachedFromRequestId: cached.id });
          this.#repository(repository => repository.markAIHelpUsed(input.attemptId, input.requestId)); this.#emit(snapshot, input.requestId, 'completed'); return structuredClone(result);
        }
      }
      this.#repository(repository => repository.setAIRequestPhase(input.requestId, 'streaming'));
      this.#emit(snapshot, input.requestId, 'connecting');
      const response = await withAbort(this.#options.vault.withKey(snapshot.provider, async key => {
        checkAbort(signal);
        let messages = snapshot.messages;
        for (let attempt = 0; attempt < 2; attempt++) {
          const completion = await withAbort(chatCompletion({ config: snapshot.provider, key, messages, signal, fetchImpl: this.#options.fetchImpl,
            onProgress: receivedBytes => this.#emit(snapshot, input.requestId, 'receiving', receivedBytes) }), signal);
          usages.push(completion.usage); checkAbort(signal); this.#emit(snapshot, input.requestId, 'validating');
          if (key.length >= 6 && completion.content.includes(key)) throw new AiServiceError('POLICY_VIOLATION');
          let secretEcho = false;
          try {
            const answer = validateResponse(completion.content, snapshot);
            // A provider echoing the Authorization secret cannot persist it as a model answer.
            if (key.length >= 6 && canonicalJson(answer).includes(key)) { secretEcho = true; throw new AiServiceError('POLICY_VIOLATION'); }
            return answer;
          } catch (error) {
            if (secretEcho || !(error instanceof AiServiceError) || !['FORMAT_INVALID', 'POLICY_VIOLATION'].includes(error.detail.code) || attempt === 1) throw error;
            checkAbort(signal); this.#repository(repository => repository.setAIRequestPhase(input.requestId, 'repairing')); this.#emit(snapshot, input.requestId, 'repairing');
            const repair = canonicalJson({ task: 'One format repair only. Return the required JSON for the SAME requested action and user request, respecting the unchanged system policy. Follow the fixed repair guidance and the original user request. Do not invent missing evidence.', reason: error.detail.code, repairHint: validationRepairHint(error) });
            // Keep the original system/user role order for compatible APIs that reject consecutive user messages.
            messages = snapshot.messages.map((message, index) => index === snapshot.messages.length - 1 ? { ...message, content: `${message.content}\n\n${repair}` } : message);
          }
        }
        throw new AiServiceError('FORMAT_INVALID');
      }), signal);
      // A trusted mode change during the call must prevent publication too.
      assertMode(await withAbort(this.#context(input), signal)); checkAbort(signal);
      const result = finish({ status: 'completed', response, error: null, usage: combineUsage(usages), cachedFromRequestId: null });
      this.#repository(repository => repository.markAIHelpUsed(input.attemptId, input.requestId)); this.#emit(snapshot, input.requestId, 'completed'); return structuredClone(result);
    } catch (error) {
      // Persist only fixed, classified errors; never persist a partial answer, provider body, or arbitrary exception.
      const detail = publicAiError(error, 'PROVIDER');
      const already = this.#repository(repository => repository.getAIRequest(input.requestId));
      if (already && terminal(already)) return structuredClone(already);
      const result = finish({ status: detail.code === 'CANCELLED' ? 'cancelled' : 'failed', response: null, error: detail, usage: combineUsage(usages), cachedFromRequestId: null });
      this.#emit(snapshot, input.requestId, result.status === 'cancelled' ? 'cancelled' : 'failed'); return structuredClone(result);
    }
  }
  testConnection(): Promise<AiConnectionResult> {
    const id = randomUUID(), controller = new AbortController();
    const promise = Promise.resolve().then(async (): Promise<AiConnectionResult> => {
      let provider: AiProviderConfig | null = null;
      const result: AiConnectionResult = { testedAt: new Date().toISOString(), providerId: '', model: '', status: 'failed', streaming: null, structuredOutput: null, usageAvailable: null, usage: null, error: null };
      try {
        provider = await withAbort(this.#provider(), controller.signal); if (!provider) throw new AiServiceError('NOT_CONFIGURED'); result.providerId = provider.id; result.model = provider.model;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(provider.timeoutMs)]);
        const completion = await withAbort(this.#options.vault.withKey(provider, key => chatCompletion({ config: provider!, key, signal, fetchImpl: this.#options.fetchImpl,
          messages: [{ role: 'system', content: 'Connection capability check only. Respond with exactly the JSON object {"ok":true}. No commentary, tools or personal data.' }, { role: 'user', content: 'Return the JSON object now.' }] })), signal);
        checkAbort(signal); result.streaming = completion.streaming; result.usage = completion.usage; result.usageAvailable = completion.usage !== null;
        let value: unknown; try { value = JSON.parse(completion.content); } catch { throw new AiServiceError('FORMAT_INVALID'); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || (value as { ok?: unknown }).ok !== true) throw new AiServiceError('FORMAT_INVALID');
        result.status = 'passed'; result.structuredOutput = true;
      } catch (error) { result.error = publicAiError(error); result.status = result.error.code === 'NOT_CONFIGURED' ? 'not-configured' : 'failed'; if (result.error.code === 'FORMAT_INVALID') result.structuredOutput = false; }
      return result;
    }).finally(() => { this.#probes.delete(id); });
    this.#probes.set(id, { controller, promise }); return promise;
  }
  async preparePatch(requestId: string): Promise<AiPatchApplication> {
    identifier(requestId); const record = this.#repository(repository => repository.getAIRequest(requestId));
    if (!record || record.status !== 'completed' || !record.response) throw new AiServiceError('INVALID_REQUEST');
    const snapshot = record.snapshot, response = this.#validatedStored(record).response!;
    // Official review reads the submitted snapshot; application must instead compare
    // it to the latest editable draft and must not resolve that old submission again.
    const current = await this.#context({ requestId, attemptId: snapshot.attemptId, kind: 'diagnosis', question: snapshot.question });
    assertMode(current);
    if (!current.isActive || current.attemptId !== snapshot.attemptId || current.problemId !== snapshot.problemId || current.problemVersion !== snapshot.problemVersion || current.language !== snapshot.language || current.draftScopeId !== snapshot.draftScopeId || sha256(current.code) !== snapshot.codeHash
      || current.draftRevision !== snapshot.draftRevision || current.answerFormat !== snapshot.answerFormat
      || current.specVersion !== snapshot.specVersion || current.testConfigDigest !== snapshot.testConfigDigest) throw new AiServiceError('STALE_PATCH');
    const code = response.patch ? patchCode(current.code, response.patch) : response.completeSolution ? response.completeSolution.code : null;
    if (code === null) throw new AiServiceError('INVALID_REQUEST');
    return { requestId, attemptId: current.attemptId, problemId: current.problemId, problemVersion: current.problemVersion, language: current.language, draftScopeId: current.draftScopeId,
      expectedDraftRevision: current.draftRevision, baseCodeHash: snapshot.codeHash, code,
      ...(current.answerFormat !== undefined ? { answerFormat: current.answerFormat, specVersion: current.specVersion, testConfigDigest: current.testConfigDigest } : {}) };
  }
}
