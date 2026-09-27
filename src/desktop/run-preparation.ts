import { randomUUID } from 'node:crypto';

/** An in-memory, one-shot intent; never restored from disk or replayed at startup. */
export class RunPreparations {
  #pending: { token: string; identity: string; expires: number; release: () => void } | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly now = Date.now) {}
  create(identity: string, release: () => void): string {
    this.cancel();
    const token = randomUUID();
    this.#pending = { token, identity, expires: this.now() + 30 * 60_000, release };
    this.#timer = setTimeout(() => this.cancel(token), 30 * 60_000);
    this.#timer.unref();
    return token;
  }
  assertCurrent(token: string, identity: string) {
    const pending = this.#pending;
    if (pending && pending.expires < this.now()) this.cancel();
    if (!pending || pending.token !== token || pending.identity !== identity || pending.expires < this.now()) {
      throw new Error('练习或代码已变化，请重新点击运行。');
    }
  }
  consume(token: string, identity: string) { this.assertCurrent(token, identity); this.cancel(token); }
  cancel(token?: string) {
    if (!this.#pending || (token !== undefined && this.#pending.token !== token)) return;
    if (this.#timer) clearTimeout(this.#timer); this.#timer = null;
    const pending = this.#pending; this.#pending = null; pending.release();
  }
}
