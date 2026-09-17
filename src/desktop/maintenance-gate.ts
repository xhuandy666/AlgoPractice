/** Coordinates live IPC with database replacement; accepted operations settle before handles close. */
export class MaintenanceGate {
  #phase: 'idle' | 'flush' | 'locked' = 'idle';
  #operations = new Map<symbol, { channel: string; settled: Promise<unknown> }>();
  get phase() { return this.#phase; }

  run<T>(channel: string, operation: () => T | Promise<T>): Promise<T> {
    const flushWrite = this.#phase === 'flush' && ['draft:save', 'note:save', 'interview:save', 'submission:save-remark'].includes(channel);
    const maintenanceRead = ['backup:state', 'app:maintenance-state'].includes(channel);
    if (this.#phase !== 'idle' && !flushWrite && !maintenanceRead) return Promise.reject(new Error('正在恢复数据，请等待完成。'));
    const id = Symbol(channel);
    const promise = Promise.resolve().then(operation);
    this.#operations.set(id, { channel, settled: promise });
    void promise.finally(() => this.#operations.delete(id)).catch(() => {});
    return promise;
  }

  beginFlush() {
    if (this.#phase !== 'idle') throw new Error('已有数据维护任务正在进行。');
    this.#phase = 'flush';
  }

  async lockAndDrain(excludeChannels: string[] = ['backup:restore']) {
    if (this.#phase !== 'flush') throw new Error('数据恢复尚未完成保存准备。');
    this.#phase = 'locked';
    const pending = [...this.#operations.values()].filter(item => !excludeChannels.includes(item.channel)).map(item => item.settled);
    await Promise.allSettled(pending);
  }

  release() { this.#phase = 'idle'; }
}
