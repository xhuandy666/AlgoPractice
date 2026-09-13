/** Renderer-visible AI data. Credentials never appear in these structures. */
export const AI_POLICY_VERSION = 'tilian-ai-policy-v2';
export const AI_PROMPT_VERSION = 'tilian-adaptive-coach-v2.3';
/** Historical record compatibility only. New coach requests have no help levels. */
export const AI_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export type AiLevel = typeof AI_LEVELS[number];
export type AiKind = 'hint' | 'diagnosis' | 'note-draft';
export type AiMode = 'practice' | 'strict' | 'coached';
export type AiJson = null | boolean | number | string | AiJson[] | { [key: string]: AiJson };
export type AiProviderCompatibility = 'openai-compatible' | 'deepseek' | 'glm' | 'qwen';

export interface AiProviderConfig {
  /** Stable non-secret configuration identity; change when switching providers. */
  id: string;
  /** HTTPS API base (e.g. https://host/v1) or full /chat/completions endpoint. HTTP is limited to loopback. */
  baseUrl: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** False supports providers without JSON mode; responses are still validated locally. */
  jsonMode: boolean;
  /** Request stream_options.include_usage only when enabled. Unknown usage remains null. */
  includeUsage: boolean;
  /** Optional for old settings/snapshots. Named profiles send only documented non-thinking options. */
  compatibility?: AiProviderCompatibility;
}
export type AiProviderPresetId = 'deepseek-cn' | 'glm-cn' | 'qwen-cn';
export interface AiProviderPreset {
  id: AiProviderPresetId;
  label: string;
  description: string;
  docsUrl: string;
  verifiedAt: string;
  config: Readonly<Omit<AiProviderConfig, 'id'>>;
}
/** Public, renderer-safe configuration suggestions. No credentials, network calls or availability promises. */
export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = Object.freeze([
  { id: 'deepseek-cn' as const, label: 'DeepSeek', description: 'DeepSeek V4 Flash；关闭思考，使用 JSON 输出。',
    docsUrl: 'https://api-docs.deepseek.com/api/create-chat-completion', verifiedAt: '2026-09-09',
    config: Object.freeze({ compatibility: 'deepseek' as const, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', temperature: 0.2, maxOutputTokens: 4096, timeoutMs: 120000, jsonMode: true, includeUsage: true }) },
  { id: 'glm-cn' as const, label: '智谱 GLM', description: 'GLM-4.7-Flash；关闭思考，使用 JSON 输出。模型和额度以账户为准。',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash', verifiedAt: '2026-09-09',
    config: Object.freeze({ compatibility: 'glm' as const, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash', temperature: 0.2, maxOutputTokens: 4096, timeoutMs: 120000, jsonMode: true, includeUsage: false }) },
  { id: 'qwen-cn' as const, label: '阿里云 Qwen', description: 'Qwen Flash，北京地域；Key 须与地域一致，可改为业务空间专属地址。关闭思考，使用 JSON 输出。',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope', verifiedAt: '2026-09-09',
    config: Object.freeze({ compatibility: 'qwen' as const, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-flash', temperature: 0.2, maxOutputTokens: 4096, timeoutMs: 120000, jsonMode: true, includeUsage: true }) },
].map(preset => Object.freeze(preset)));
/** Call only after the user chooses a preset; configId should be a new application-owned identity. */
export function createAiProviderPreset(presetId: string, configId: string): AiProviderConfig {
  const preset = AI_PROVIDER_PRESETS.find(entry => entry.id === presetId);
  if (!preset || typeof configId !== 'string' || !configId.trim() || configId.length > 256 || /[\u0000-\u001f\u007f]/.test(configId)) throw new Error('AI 预设或配置标识无效。');
  return { id: configId, ...preset.config };
}
export interface AiProviderState { config: AiProviderConfig | null; hasKey: boolean; /** null means OS encryption has not been probed; credential operations check it when needed. */ secureStorageAvailable: boolean | null; }
export interface AiRequestInput {
  requestId: string;
  attemptId: string;
  kind: AiKind;
  /** Optional user request. Empty means assess the supplied problem and current work. */
  question: string;
  runId?: string;
  noteIds?: string[];
  conversationIds?: string[];
}
export interface AiDiagnostic { message: string; source: 'user' | 'runner'; line?: number; column?: number; }
export interface AiCaseEvidence { index: number; status: string; actual?: AiJson; expected?: AiJson; }
export interface AiRunEvidence {
  id: string; attemptId: string; problemVersion: string; codeHash: string;
  status: string; trustworthyExpected: boolean;
  diagnostics: AiDiagnostic[]; caseResults: AiCaseEvidence[]; stdout: string; stderr: string;
}
export interface AiOfficialEvidence {
  id: string; attemptId: string; problemVersion: string; codeHash: string;
  status: string; statusMessage: string;
  passedCases?: number; totalCases?: number; runtime?: string; memory?: string;
  compileError?: string; runtimeError?: string; input?: string; actualOutput?: string; expectedOutput?: string;
}
/** Construct only in main/business code, using the persisted Attempt and Draft/Run. Never accept this object from IPC. */
export interface AiTrustedContext {
  attemptId: string; problemId: string; problemVersion: string; language: 'python' | 'java';
  mode: AiMode; isActive: boolean; draftScopeId: string; draftRevision: number;
  code: string;
  reasoning?: string;
  problem: { title: string; description: string; constraints: string[] };
  run: AiRunEvidence | null;
  official?: AiOfficialEvidence | null;
  /** Explicitly selected historical evidence; never evidence for the current code. */
  previousRun?: { code: string; run: AiRunEvidence } | null;
  conversation: Array<{ id: string; role: 'user' | 'assistant'; content: string }>;
  notes: Array<{ id: string; version: string; title: string; markdown: string }>;
}
export interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface AiRequestSnapshot {
  policyVersion: string; promptVersion: string;
  attemptId: string; problemId: string; problemVersion: string; language: 'python' | 'java';
  mode: AiMode; isActive: boolean; draftScopeId: string; draftRevision: number;
  codeHash: string; code: string; kind: AiKind; question: string;
  /** Read-only fields on snapshots saved by the old coach. Never emitted for new requests. */
  level?: AiLevel; unlockCompleteSolution?: boolean;
  runId: string | null; run: AiRunEvidence | null;
  official?: AiOfficialEvidence | null;
  previousRun?: { code: string; run: AiRunEvidence } | null;
  provider: AiProviderConfig;
  /** Exactly what the provider receives, after deterministic context clipping. */
  messages: AiMessage[];
  selectedNoteIds: string[]; selectedConversationIds: string[];
  clippedFields: string[];
}
export interface AiEvidenceReference {
  runId: string;
  kind: 'compiler' | 'exception' | 'test' | 'official';
  /** Exact bounded excerpt from supplied diagnostic/output, or the named case result. */
  quote: string;
  caseIndex?: number;
}
export interface AiInference { text: string; reason: string; }
export interface AiPatchEdit { startLine: number; endLine: number; replacement: string; }
export interface AiPatch { baseCodeHash: string; edits: AiPatchEdit[]; }
export interface AiResponse {
  schemaVersion: 1 | 2;
  kind: AiKind;
  /** Present only on historical schemaVersion 1 answers. */
  level?: AiLevel;
  title: string;
  explanation: string;
  nextSteps: string[];
  evidence: AiEvidenceReference[];
  inferences: AiInference[];
  patch: AiPatch | null;
  completeSolution: { explanation: string; code: string } | null;
  /** Always a proposal; saving a NoteVersion requires a separate user action. */
  noteDraft: { title: string; markdown: string; tags: string[] } | null;
}
export type AiErrorCode = 'NOT_CONFIGURED' | 'CREDENTIAL_UNAVAILABLE' | 'INVALID_CONFIG' | 'INVALID_REQUEST'
  | 'STRICT_MODE' | 'L4_LOCKED' | 'AUTH' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK' | 'PROVIDER'
  | 'UNSUPPORTED_RESPONSE' | 'RESPONSE_TOO_LARGE' | 'FORMAT_INVALID' | 'POLICY_VIOLATION'
  | 'CANCELLED' | 'INTERRUPTED' | 'STALE_PATCH' | 'REQUEST_CONFLICT' | 'STORAGE';
export interface AiError { code: AiErrorCode; message: string; retryable: boolean; httpStatus?: number; retryAfterMs?: number; }
export interface AiUsage {
  source: 'provider'; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  /** Includes a possible single format-repair call. Missing provider usage is not estimated. */
  calls: number;
}
export type AiRequestStatus = 'pending' | 'streaming' | 'repairing' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface AiRequestSeed { id: string; attemptId: string; requestHash: string; snapshot: AiRequestSnapshot; }
export interface AiRequestCompletion {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  response: AiResponse | null; error: AiError | null; usage: AiUsage | null; cachedFromRequestId: string | null;
}
export interface AiRequestRecord extends AiRequestSeed {
  status: AiRequestStatus; response: AiResponse | null; error: AiError | null; usage: AiUsage | null;
  cachedFromRequestId: string | null; createdAt: string; finishedAt: string | null;
}
export interface AiHelpState { automaticShownAt: string | null; dismissedAt: string | null; }
export interface AiRepository {
  beginAIRequest(input: AiRequestSeed): AiRequestRecord;
  setAIRequestPhase(id: string, phase: 'streaming' | 'repairing'): AiRequestRecord;
  finishAIRequest(id: string, completion: AiRequestCompletion): AiRequestRecord;
  getAIRequest(id: string): AiRequestRecord | null;
  findCompletedAIRequest(requestHash: string): AiRequestRecord | null;
  listAIRequests(attemptId: string): AiRequestRecord[];
  recoverInterruptedAIRequests(): number;
  getAIHelpState(attemptId: string): AiHelpState;
  markAIHelpShown(attemptId: string): boolean;
  dismissAIHelp(attemptId: string): void;
  markAIHelpUsed(attemptId: string, requestId: string, legacyLevel?: AiLevel): void;
}
export interface AiEvent {
  requestId: string; attemptId: string; problemId: string; codeHash: string;
  phase: 'queued' | 'connecting' | 'receiving' | 'validating' | 'repairing' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  /** Progress only; raw/unvalidated model content must never be published in an event. */
  receivedBytes?: number;
}
export interface AiPatchApplication {
  requestId: string; attemptId: string; problemId: string; problemVersion: string; language: 'python' | 'java';
  draftScopeId: string; expectedDraftRevision: number; baseCodeHash: string; code: string;
}
export interface AiConnectionResult {
  testedAt: string; providerId: string; model: string;
  status: 'passed' | 'failed' | 'not-configured';
  streaming: boolean | null; structuredOutput: boolean | null; usageAvailable: boolean | null;
  usage: AiUsage | null; error: AiError | null;
}
export interface AiHelpRun {
  id: string; attemptId: string; status: string; language: 'python' | 'java';
  /** Count only actual user-code execution with trustworthy expected results. */
  executed: boolean; attributableToUser: boolean; trustworthyExpected: boolean;
  diagnostics: AiDiagnostic[];
}
export interface AiHelpDecision { show: boolean; reason: 'compile-error' | 'three-failures' | null; consecutiveFailures: number; }
