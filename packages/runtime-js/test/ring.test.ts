import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { Ring, Trap } from "../src/index.ts";

const code = (f: () => unknown): string | undefined => { try { f(); } catch (e) { if (e instanceof Trap) return e.code; throw e; } return undefined; };

describe("Ring", () => {
  it("capacity must be a power of two in 1..2^31 (T014)", () => {
    expect(code(() => Ring.create(null, 0, "i32"))).toBe("T014");
    expect(code(() => Ring.create(null, 3, "i32"))).toBe("T014");
    expect(code(() => Ring.create(null, 6, "i32"))).toBe("T014");
    expect(code(() => Ring.create(null, 2 ** 31 + 1, "i32"))).toBe("T014");
    expect(code(() => Ring.create(null, 1, "i32"))).toBeUndefined();
    expect(code(() => Ring.create(null, 1024, "i32"))).toBeUndefined();
  });
  it("push / pop in order; full discards, empty is null; slots wrap", () => {
    const { tx, rx } = Ring.create<number>(null, 4, "i32");
    expect(rx.pop()).toBe(null);
    expect(tx.push(1)).toBe(true);
    expect(tx.push(2)).toBe(true);
    expect(rx.pop()).toBe(1);
    expect(tx.push(3)).toBe(true);
    expect(tx.push(4)).toBe(true);
    expect(tx.push(5)).toBe(true);
    expect(tx.push(6)).toBe(false); // full: 2, 3, 4, 5 are in
    expect([rx.pop(), rx.pop(), rx.pop(), rx.pop(), rx.pop()]).toEqual([2, 3, 4, 5, null]);
    for (let i = 0; i < 1000; i++) { // many wraparounds of the slot index and the counters
      expect(tx.push(i)).toBe(true);
      expect(rx.pop()).toBe(i);
    }
  });
  it("numeric elements use their typed representation (f32 rounds)", () => {
    const { tx, rx } = Ring.create<number>(null, 2, "f32");
    tx.push(0.1);
    expect(rx.pop()).toBe(Math.fround(0.1));
  });
  it("packed (10.2 layout) elements round-trip through the buffer bytes", () => {
    const elem = JSON.stringify({
      t: "rec", z: 8, a: 4,
      f: [
        { n: "x", o: 0, l: { t: "num", n: "i32", z: 4, a: 4 } },
        { n: "b", o: 4, l: { t: "bool", z: 1, a: 1 } },
      ],
    }) as `{${string}`;
    const { tx, rx } = Ring.create<{ x: number; b: boolean }>(null, 2, elem);
    tx.push({ x: 7, b: true });
    tx.push({ x: -2, b: false });
    expect(rx.pop()).toEqual({ x: 7, b: true });
    expect(rx.pop()).toEqual({ x: -2, b: false });
  });
  it("a type-parameter ring adopts its representation with the values in order", () => {
    const { tx, rx } = Ring.create<number>(null, 4);
    tx.push(5);
    tx.push(6);
    expect(tx.sab).toBe(null);
    tx.adopt("i32");
    expect(tx.sab).not.toBe(null);
    expect(rx.pop()).toBe(5);
    expect(tx.push(7)).toBe(true);
    expect(rx.pop()).toBe(6);
    expect(rx.pop()).toBe(7);
    expect(rx.pop()).toBe(null);
  });
  it("two Workers: one pushes, the other pops; every value exactly once, in order", async () => {
    const n = 100_000, cap = 256;
    const { tx } = Ring.create<number>(null, cap, "i32");
    const sab = tx.sab;
    if (!sab) throw new Error("ring has no buffer");
    const url = new URL("../src/index.ts", import.meta.url).href;
    const src = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { Ring } = await import(workerData.url);
        const pair = Ring.fromShared(workerData.sab, workerData.cap, "i32");
        if (workerData.role === "tx") {
          let sent = 0;
          while (sent < workerData.n) if (pair.tx.push(sent)) sent++;
          parentPort.postMessage({ sent });
        } else {
          let want = 0, sum = 0;
          while (want < workerData.n) {
            const v = pair.rx.pop();
            if (v === null) continue;
            if (v !== want) { parentPort.postMessage({ error: "order: got " + v + ", want " + want }); return; }
            sum += v; want++;
          }
          parentPort.postMessage({ received: want, sum });
        }
      })().catch((e) => parentPort.postMessage({ error: String(e) }));
    `;
    const run = (role: string): Promise<{ sent?: number; received?: number; sum?: number; error?: string }> =>
      new Promise((res, rej) => {
        const w = new Worker(src, { eval: true, workerData: { url, sab, cap, n, role } });
        w.once("message", (m) => { void w.terminate(); res(m as { sent?: number }); });
        w.once("error", rej);
      });
    const [a, b] = await Promise.all([run("tx"), run("rx")]);
    expect(a).toEqual({ sent: n });
    expect(b).toEqual({ received: n, sum: (n * (n - 1)) / 2 });
  }, 60_000);
});
