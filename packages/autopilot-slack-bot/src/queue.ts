interface QueuedTask {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * スレッド単位で直列実行しつつ、異なるスレッドを上限 concurrency まで並行実行するキュー。
 */
export class ThreadQueue {
  private readonly queues = new Map<string, QueuedTask[]>();
  private readonly activeThreads = new Set<string>();
  private readonly waitingOrder: string[] = [];
  private readonly idleResolvers: Array<() => void> = [];
  private running = 0;

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new Error(`concurrency は正の整数で指定すること: ${concurrency}`);
    }
  }

  enqueue(key: string, run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let list = this.queues.get(key);
      if (!list) {
        list = [];
        this.queues.set(key, list);
        this.waitingOrder.push(key);
      }
      list.push({ run, resolve, reject });
      this.pump();
    });
  }

  hasPendingOrActive(key: string): boolean {
    return this.activeThreads.has(key) || (this.queues.get(key)?.length ?? 0) > 0;
  }

  activeCount(): number {
    return this.running;
  }

  pendingCount(): number {
    let total = 0;
    for (const list of this.queues.values()) total += list.length;
    return total;
  }

  async drain(): Promise<void> {
    if (this.running === 0 && this.pendingCount() === 0) return;
    await new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const nextKey = this.pickNextThread();
      if (!nextKey) break;

      const list = this.queues.get(nextKey)!;
      const item = list.shift()!;
      if (list.length === 0) {
        this.queues.delete(nextKey);
      } else {
        // ラウンドロビンで次の周回に後ろへ回す。
        this.waitingOrder.push(nextKey);
      }

      this.activeThreads.add(nextKey);
      this.running++;

      void this.execute(nextKey, item);
    }

    if (this.running === 0 && this.pendingCount() === 0) {
      while (this.idleResolvers.length > 0) {
        this.idleResolvers.shift()!();
      }
    }
  }

  private pickNextThread(): string | null {
    const len = this.waitingOrder.length;
    for (let i = 0; i < len; i++) {
      const key = this.waitingOrder.shift()!;
      const list = this.queues.get(key);
      if (!list || list.length === 0) {
        this.queues.delete(key);
        continue;
      }
      if (this.activeThreads.has(key)) {
        this.waitingOrder.push(key);
        continue;
      }
      return key;
    }
    return null;
  }

  private async execute(key: string, item: QueuedTask): Promise<void> {
    try {
      await item.run();
      item.resolve();
    } catch (e) {
      item.reject(e);
    } finally {
      this.activeThreads.delete(key);
      this.running--;
      this.pump();
    }
  }
}
