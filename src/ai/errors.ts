import type { AiError, AiErrorCode } from '../shared/ai.ts';

const messages: Record<AiErrorCode, string> = {
  NOT_CONFIGURED: '尚未配置 AI 接口、模型或本应用的 API Key；真实模型连接未验证。',
  CREDENTIAL_UNAVAILABLE: '系统凭据存储不可用或无法解密；密钥未降级为明文，请重新配置或稍后重试。',
  INVALID_CONFIG: 'AI 配置无效，请检查接口地址、模型与参数。',
  INVALID_REQUEST: 'AI 请求或练习上下文无效，请重新选择当前练习。',
  STRICT_MODE: '严格面试进行中，当前模式不允许 AI 解题帮助。',
  L4_LOCKED: '完整解法需要先主动解锁 L4。',
  AUTH: 'AI 服务拒绝凭据或访问权限，请检查本应用的接口配置。',
  RATE_LIMITED: 'AI 服务暂时限流，请稍后手动重试。',
  TIMEOUT: 'AI 请求超时；未校验的部分回答未展示。',
  NETWORK: '无法连接 AI 服务，请检查网络和接口配置。',
  PROVIDER: 'AI 服务暂时未能完成请求，请稍后手动重试。',
  UNSUPPORTED_RESPONSE: '接口未返回受支持的聊天响应，请检查兼容地址、模型、JSON 模式或流式用量选项。',
  RESPONSE_TOO_LARGE: 'AI 响应超过本次大小上限，已停止接收。',
  FORMAT_INVALID: 'AI 回答未通过结构校验，格式修复后仍不可用；未展示原始回答。',
  POLICY_VIOLATION: 'AI 回答未通过回答结构或证据检查，未展示原始回答。',
  CANCELLED: 'AI 请求已停止，部分回答未展示。',
  INTERRUPTED: '上次 AI 请求在应用退出时中断，未自动重试。',
  STALE_PATCH: '代码或题面已经改变，请重新分析后再应用建议。',
  REQUEST_CONFLICT: '该 AI 请求标识已用于另一份上下文，请创建新请求。',
  STORAGE: 'AI 记录未能保存，请保留数据目录并稍后重试。',
};
export class AiServiceError extends Error {
  readonly detail: AiError;
  constructor(code: AiErrorCode, extra: Pick<AiError, 'httpStatus' | 'retryAfterMs'> = {}) {
    super(messages[code]); this.name = 'AiServiceError';
    this.detail = { code, message: messages[code], retryable: ['RATE_LIMITED', 'TIMEOUT', 'NETWORK', 'PROVIDER', 'STORAGE'].includes(code), ...extra };
  }
}
/** Do not include provider bodies, URLs, error causes or arbitrary exception messages. */
export function publicAiError(error: unknown, fallback: AiErrorCode = 'PROVIDER'): AiError {
  const detail = error instanceof AiServiceError && Object.hasOwn(messages, error.detail.code) ? error.detail : null;
  const result = new AiServiceError(detail?.code ?? fallback).detail;
  // Project only known safe fields, even if a caller adds arbitrary properties
  // or overwrites Error.message/detail.message while handling a provider failure.
  if (detail && Number.isInteger(detail.httpStatus) && detail.httpStatus! >= 100 && detail.httpStatus! <= 599) result.httpStatus = detail.httpStatus;
  if (detail && typeof detail.retryAfterMs === 'number' && Number.isFinite(detail.retryAfterMs) && detail.retryAfterMs >= 0) result.retryAfterMs = detail.retryAfterMs;
  return result;
}
export function aborted(signal: AbortSignal): never {
  throw new AiServiceError(signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED');
}
export function checkAbort(signal: AbortSignal): void { if (signal.aborted) aborted(signal); }
export async function withAbort<T>(promise: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cancel = () => { if (settled) return; settled = true; signal.removeEventListener('abort', cancel); try { aborted(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { if (settled) { discard?.(value); return; } settled = true; signal.removeEventListener('abort', cancel); resolve(value); }, error => { if (settled) return; settled = true; signal.removeEventListener('abort', cancel); reject(error); });
    if (signal.aborted) cancel();
  });
}
