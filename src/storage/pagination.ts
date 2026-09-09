import type { PageRequest, PageResult } from '../shared/learning.ts';

export function pageBounds(input: PageRequest): Required<PageRequest> {
  const offset = input.offset ?? 0, limit = input.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid page offset');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Page limit must be between 1 and 100');
  return { offset, limit };
}
export function pageResult<T>(items: T[], total: number, bounds: Required<PageRequest>): PageResult<T> {
  return { items, total, ...bounds, hasMore: bounds.offset + items.length < total };
}
export function searchText(value: string | undefined): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 500) throw new Error('Search must be text within 500 characters');
  return value.trim();
}
export const literalLike = (value: string) => `%${value.replace(/[\\%_]/g, match => `\\${match}`)}%`;

// ECMAScript String.trim whitespace; SQLite trim() alone removes only ASCII spaces.
export const SQL_TRIM_WHITESPACE = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
