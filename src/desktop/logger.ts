import { existsSync, mkdirSync, renameSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FILE_BYTES = 1024 * 1024;
const RETAINED_GENERATIONS = 4;
// Keep this list limited to operational metadata. Unknown fields are never persisted.
const STRING_FIELDS = new Set(['language', 'result', 'status', 'operation', 'category', 'version', 'platform', 'arch']);
const NUMBER_FIELDS = new Set(['durationMs', 'count', 'generation', 'bytes', 'attempt', 'schemaVersion']);
const BOOLEAN_FIELDS = new Set(['interrupted', 'cancelled', 'recovered']);

/** Pass identifiers, status codes and counters only; never code, problem text or credentials. */
export function createLogger(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'application.jsonl');
  return (event: string, fields: Record<string, string | number | boolean | null> = {}) => {
    try {
      const safe: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (STRING_FIELDS.has(key) && typeof value === 'string' && /^[a-zA-Z0-9_.:-]+$/.test(value) && !/^(sk-|Bearer)/i.test(value)) safe[key] = value.slice(0, 120);
        else if (NUMBER_FIELDS.has(key) && typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
        else if (BOOLEAN_FIELDS.has(key) && typeof value === 'boolean') safe[key] = value;
      }
      const name = typeof event === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(event) && !/^sk-/i.test(event) ? event : 'invalid.event';
      const line = JSON.stringify({ at: new Date().toISOString(), event: name, ...safe }) + '\n';
      // Rotate before appending: a complete UTF-8 JSON record must fit in this generation.
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
        const oldest = `${file}.${RETAINED_GENERATIONS}`; if (existsSync(oldest)) unlinkSync(oldest);
        for (let i = RETAINED_GENERATIONS - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line, { mode: 0o600 });
    } catch { console.warn('Operational log could not be written.'); }
  };
}
