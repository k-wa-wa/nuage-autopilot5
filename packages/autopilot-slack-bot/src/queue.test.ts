import { describe, expect, test } from "bun:test";
import { ThreadQueue } from "./queue.ts";

describe("ThreadQueue", () => {
  test("同一スレッドの連続投入は直列に順番通り実行される", async () => {
    const queue = new ThreadQueue(4);
    const log: string[] = [];

    const p1 = queue.enqueue("C1:100.1", async () => {
      log.push("t1-start");
      await Bun.sleep(40);
      log.push("t1-end");
    });
    const p2 = queue.enqueue("C1:100.1", async () => {
      log.push("t2-start");
      await Bun.sleep(10);
      log.push("t2-end");
    });
    const p3 = queue.enqueue("C1:100.1", async () => {
      log.push("t3-start");
      log.push("t3-end");
    });

    await Promise.all([p1, p2, p3]);
    expect(log).toEqual(["t1-start", "t1-end", "t2-start", "t2-end", "t3-start", "t3-end"]);
  });

  test("異なるスレッドは上限 concurrency まで並行実行される", async () => {
    const queue = new ThreadQueue(2);
    let current = 0;
    let maxObserved = 0;

    const task = async () => {
      current++;
      if (current > maxObserved) maxObserved = current;
      await Bun.sleep(40);
      current--;
    };

    await Promise.all([
      queue.enqueue("C1:1", task),
      queue.enqueue("C1:2", task),
      queue.enqueue("C1:3", task),
      queue.enqueue("C1:4", task),
    ]);

    expect(maxObserved).toBe(2);
    await queue.drain();
    expect(queue.activeCount()).toBe(0);
    expect(queue.pendingCount()).toBe(0);
  });
});
