/** Code on the error raised when the app's own integrity_check finds damage. SQLite's own corruption errors carry
 * errcode 11 (SQLITE_CORRUPT) or 26 (SQLITE_NOTADB) instead; callers classify both as damage by structure, never by
 * message text. */
export const SQLITE_INTEGRITY_FAILURE = 'ALGOPRACTICE_SQLITE_INTEGRITY';
export function integrityFailure(message = 'SQLite integrity check failed'): Error {
  return Object.assign(new Error(message), { code: SQLITE_INTEGRITY_FAILURE });
}
