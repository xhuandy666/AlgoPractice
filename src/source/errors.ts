export type SourceErrorCode =
  | 'INVALID_URL' | 'UNSUPPORTED_SOURCE' | 'WRONG_SOURCE_KIND' | 'INVALID_IMPORT'
  | 'NETWORK_ERROR' | 'TIMEOUT' | 'CANCELLED' | 'AUTH_REQUIRED' | 'ACCESS_DENIED'
  | 'ACCESS_CHALLENGE' | 'NOT_FOUND' | 'NOT_FOUND_OR_RESTRICTED'
  | 'RATE_LIMITED' | 'HTTP_ERROR' | 'REDIRECT_BLOCKED' | 'GRAPHQL_ERROR'
  | 'RESPONSE_TOO_LARGE' | 'INVALID_CONTENT' | 'SCHEMA_CHANGED'
  | 'INCOMPLETE_PLAN' | 'PLAN_TOO_LARGE' | 'SOURCE_CHANGED' | 'PUBLIC_LIST_MEMBERS_UNAVAILABLE';

export class SourceError extends Error {
  readonly code: SourceErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, string | number | boolean | null>;
  constructor(code: SourceErrorCode, message: string, details: SourceError['details'] = {}, retryable = false) {
    super(message); this.name = 'SourceError'; this.code = code; this.details = details; this.retryable = retryable;
  }
  toJSON() { return { code: this.code, message: this.message, retryable: this.retryable, details: this.details }; }
}
export type ObjectValue = Record<string, unknown>;
export const record = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
export const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export function failSchema(field: string): never { throw new SourceError('SCHEMA_CHANGED', '来源字段缺失或结构发生变化，不能视为空数据。', { field }); }
export function requiredString(value: unknown, field: string): string { if (!nonempty(value)) return failSchema(field); return value; }
export function requiredCount(value: unknown, field: string): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return failSchema(field); return value; }
export function checkCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new SourceError('CANCELLED', '操作已取消。'); }
