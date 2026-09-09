import type { AiMessage, AiProviderConfig, AiUsage } from '../shared/ai.ts';
import { completionEndpoint, normalizeProviderConfig } from './canonical.ts';
import { AiServiceError, checkAbort, withAbort } from './errors.ts';

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CONTENT_CHARS = 128 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
export interface ProviderCompletion { content: string; streaming: boolean; usage: AiUsage | null; model: string | null; }
export interface ChatCompletionOptions {
  config: AiProviderConfig; key: string; messages: AiMessage[]; signal: AbortSignal;
  onProgress?: (receivedBytes: number) => void; fetchImpl?: typeof fetch;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function usage(value: unknown): AiUsage | null {
  if (!record(value)) return null;
  const count = (entry: unknown) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0 ? entry : null;
  const inputTokens = count(value.prompt_tokens), outputTokens = count(value.completion_tokens), totalTokens = count(value.total_tokens);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  return { source: 'provider', inputTokens, outputTokens, totalTokens, calls: 1 };
}
function httpError(response: Response): AiServiceError {
  let retryAfterMs: number | undefined;
  if (response.status === 429) {
    const value = response.headers.get('retry-after');
    if (value) { const numeric = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now(); if (Number.isFinite(numeric)) retryAfterMs = Math.max(0, Math.min(300000, Math.round(numeric))); }
  }
  return new AiServiceError(response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'PROVIDER' : 'UNSUPPORTED_RESPONSE', { httpStatus: response.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
}
export function combineUsage(values: Array<AiUsage | null>): AiUsage | null {
  if (!values.some(Boolean)) return null;
  const sum = (field: 'inputTokens' | 'outputTokens' | 'totalTokens') => values.every(value => value?.[field] !== null && value?.[field] !== undefined) ? values.reduce((total, value) => total + value![field]!, 0) : null;
  return { source: 'provider', inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'), calls: values.length };
}
export async function chatCompletion(options: ChatCompletionOptions): Promise<ProviderCompletion> {
  const { key, messages, signal, onProgress } = options; checkAbort(signal);
  const config = normalizeProviderConfig(options.config);
  const body = JSON.stringify({ model: config.model, messages, temperature: config.temperature, max_tokens: config.maxOutputTokens, stream: true,
    ...(config.compatibility === 'deepseek' || config.compatibility === 'glm' ? { thinking: { type: 'disabled' } } : {}),
    ...(config.compatibility === 'qwen' ? { enable_thinking: false } : {}),
    ...(config.jsonMode ? { response_format: { type: 'json_object' } } : {}), ...(config.includeUsage ? { stream_options: { include_usage: true } } : {}) });
  // Bound the bytes actually sent, including the possible repair prompt and JSON escaping.
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new AiServiceError('INVALID_REQUEST');
  let response: Response;
  try {
    response = await withAbort((options.fetchImpl ?? fetch)(completionEndpoint(config), {
      method: 'POST', redirect: 'error', credentials: 'omit', signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
      body,
    }), signal, late => { void late.body?.cancel().catch(() => {}); });
  } catch (error) { checkAbort(signal); if (error instanceof AiServiceError) throw error; throw new AiServiceError('NETWORK'); }
  checkAbort(signal);
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw httpError(response); }
  if (!response.body) throw new AiServiceError('UNSUPPORTED_RESPONSE');
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { await response.body.cancel().catch(() => {}); throw new AiServiceError('RESPONSE_TOO_LARGE'); }
  const contentType = response.headers.get('content-type') ?? '';
  const streaming = /^text\/event-stream\b/i.test(contentType);
  if (!streaming && !/^application\/(?:[a-z0-9.+-]+\+)?json\b/i.test(contentType)) { await response.body.cancel().catch(() => {}); throw new AiServiceError('UNSUPPORTED_RESPONSE'); }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, buffer = '', dataLines: string[] = [], content = '', tokens: AiUsage | null = null, model: string | null = null;
  let done = false, finished = false, sawChoice = false;
  const accept = (value: unknown, stream: boolean) => {
    if (!record(value) || value.error) throw new AiServiceError('UNSUPPORTED_RESPONSE');
    if (typeof value.model === 'string') model = value.model.slice(0, 200);
    const reported = usage(value.usage); if (reported) tokens = reported;
    if (!Array.isArray(value.choices)) throw new AiServiceError('UNSUPPORTED_RESPONSE');
    // Compatible servers may include empty usage/heartbeat chunks; these cannot complete an answer.
    if (value.choices.length === 0 && stream && (value.usage === null || record(value.usage))) return;
    if (value.choices.length !== 1 || !record(value.choices[0])) throw new AiServiceError('UNSUPPORTED_RESPONSE');
    const choice = value.choices[0];
    if (choice.index !== undefined && choice.index !== 0) throw new AiServiceError('UNSUPPORTED_RESPONSE');
    const message = stream ? choice.delta : choice.message;
    if (!record(message) || (message.role !== undefined && message.role !== null && message.role !== 'assistant') || message.tool_calls || message.function_call || message.refusal) throw new AiServiceError('UNSUPPORTED_RESPONSE');
    if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') throw new AiServiceError('UNSUPPORTED_RESPONSE');
    if (finished && typeof message.content === 'string' && message.content.length) throw new AiServiceError('UNSUPPORTED_RESPONSE');
    // reasoning_content and other non-answer fields are never returned, persisted or shown.
    // Their wire bytes still count towards MAX_RESPONSE_BYTES.
    content += typeof message.content === 'string' ? message.content : '';
    if (content.length > MAX_CONTENT_CHARS) throw new AiServiceError('RESPONSE_TOO_LARGE');
    sawChoice = true;
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (choice.finish_reason !== 'stop') throw new AiServiceError('UNSUPPORTED_RESPONSE'); finished = true; }
    if (!stream && (!finished || !content)) throw new AiServiceError('UNSUPPORTED_RESPONSE');
  };
  const event = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n'); dataLines = [];
    if (done) throw new AiServiceError('UNSUPPORTED_RESPONSE');
    if (data.trim() === '[DONE]') { done = true; return; }
    try { accept(JSON.parse(data), true); } catch (error) { if (error instanceof AiServiceError) throw error; throw new AiServiceError('UNSUPPORTED_RESPONSE'); }
  };
  const lines = (flush = false) => {
    while (true) { const end = buffer.indexOf('\n'); if (end < 0) break; const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1); if (!line) event(); else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, '')); }
    if (flush) { if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, '')); buffer = ''; event(); }
  };
  try {
    while (true) {
      checkAbort(signal); const item = await withAbort(reader.read(), signal); checkAbort(signal); if (item.done) break;
      bytes += item.value.byteLength; if (bytes > MAX_RESPONSE_BYTES) throw new AiServiceError('RESPONSE_TOO_LARGE');
      buffer += decoder.decode(item.value, { stream: true }); if (streaming) lines();
      try { onProgress?.(bytes); } catch { /* Progress observers cannot change the provider request. */ }
      if (streaming && done) break; // [DONE] terminates SSE even if the server keeps the connection alive.
    }
    buffer += decoder.decode();
    if (streaming) { lines(true); if (!done || !finished || !sawChoice || !content) throw new AiServiceError('UNSUPPORTED_RESPONSE'); }
    else { try { accept(JSON.parse(buffer), false); } catch (error) { if (error instanceof AiServiceError) throw error; throw new AiServiceError('UNSUPPORTED_RESPONSE'); } }
    checkAbort(signal); return { content, streaming, usage: tokens, model };
  } catch (error) { checkAbort(signal); if (error instanceof AiServiceError) throw error; throw new AiServiceError('UNSUPPORTED_RESPONSE'); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
