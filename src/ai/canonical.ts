import { normalizeAiBaseUrl, aiCompletionEndpoint } from '../shared/ai-endpoint.ts';
import { createHash } from 'node:crypto';
import { type AiProviderConfig, type AiRequestInput } from '../shared/ai.ts';
import { AiServiceError } from './errors.ts';

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function canonicalJson(value: unknown): string {
  const visit = (entry: unknown, depth: number): unknown => {
    if (depth > 32) throw new AiServiceError('INVALID_REQUEST');
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(item => visit(item, depth + 1));
    if (entry && typeof entry === 'object' && (Object.getPrototypeOf(entry) === Object.prototype || Object.getPrototypeOf(entry) === null)) {
      return Object.fromEntries(Object.keys(entry).sort().filter(key => (entry as Record<string, unknown>)[key] !== undefined).map(key => [key, visit((entry as Record<string, unknown>)[key], depth + 1)]));
    }
    throw new AiServiceError('INVALID_REQUEST');
  };
  return JSON.stringify(visit(value, 0));
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new AiServiceError('INVALID_REQUEST');
  return value;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function normalizeProviderConfig(input: unknown): AiProviderConfig {
  if (!object(input)) throw new AiServiceError('INVALID_CONFIG');
  const allowed = ['id', 'baseUrl', 'model', 'temperature', 'maxOutputTokens', 'timeoutMs', 'jsonMode', 'includeUsage', 'compatibility'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new AiServiceError('INVALID_CONFIG');
  let id: string;
  try { id = identifier(input.id); } catch { throw new AiServiceError('INVALID_CONFIG'); }
  if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048 || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 || /[\u0000-\u001f\u007f]/.test(input.model)) throw new AiServiceError('INVALID_CONFIG');
  let baseUrl: string; try { baseUrl = normalizeAiBaseUrl(input.baseUrl); } catch { throw new AiServiceError('INVALID_CONFIG'); }
  const temperature = input.temperature ?? 0.2, maxOutputTokens = input.maxOutputTokens ?? 2048, timeoutMs = input.timeoutMs ?? 60000;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2 || typeof maxOutputTokens !== 'number' || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 8192 || typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw new AiServiceError('INVALID_CONFIG');
  if ((input.jsonMode !== undefined && typeof input.jsonMode !== 'boolean') || (input.includeUsage !== undefined && typeof input.includeUsage !== 'boolean')) throw new AiServiceError('INVALID_CONFIG');
  if (input.compatibility !== undefined && (typeof input.compatibility !== 'string' || !['openai-compatible', 'deepseek', 'glm', 'qwen'].includes(input.compatibility))) throw new AiServiceError('INVALID_CONFIG');
  if (input.compatibility === 'glm' && (temperature > 1 || Math.abs(temperature * 100 - Math.round(temperature * 100)) > 1e-9)) throw new AiServiceError('INVALID_CONFIG');
  return { id, baseUrl, model: input.model.trim(), temperature, maxOutputTokens, timeoutMs, jsonMode: input.jsonMode === true, includeUsage: input.includeUsage !== false,
    ...(input.compatibility !== undefined ? { compatibility: input.compatibility as AiProviderConfig['compatibility'] } : {}) };
}
export function completionEndpoint(config: AiProviderConfig): string {
  const base = normalizeProviderConfig(config).baseUrl;
  return aiCompletionEndpoint(base);
}
export function validateRequestInput(value: unknown): AiRequestInput {
  if (!object(value) || Object.keys(value).some(key => !['requestId', 'attemptId', 'kind', 'question', 'runId', 'noteIds', 'conversationIds'].includes(key))) throw new AiServiceError('INVALID_REQUEST');
  const requestId = identifier(value.requestId), attemptId = identifier(value.attemptId);
  if (!['hint', 'diagnosis', 'note-draft'].includes(String(value.kind)) || typeof value.question !== 'string' || value.question.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.question)) throw new AiServiceError('INVALID_REQUEST');
  const ids = (input: unknown, maximum: number) => { if (input === undefined) return undefined; if (!Array.isArray(input) || input.length > maximum) throw new AiServiceError('INVALID_REQUEST'); const result = input.map(identifier); if (new Set(result).size !== result.length) throw new AiServiceError('INVALID_REQUEST'); return result; };
  const noteIds = ids(value.noteIds, 3), conversationIds = ids(value.conversationIds, 6);
  return { requestId, attemptId, kind: value.kind as AiRequestInput['kind'], question: value.question.trim(), ...(value.runId !== undefined ? { runId: identifier(value.runId) } : {}), ...(noteIds ? { noteIds } : {}), ...(conversationIds ? { conversationIds } : {}) };
}
