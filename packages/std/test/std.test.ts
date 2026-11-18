import { describe, expect, it } from "vitest";
import { Trap, panic, requires, type Pos } from "../../runtime-js/src/index.ts";
import { FakeClock, SeededRandom, MemoryLog, FakeFs, TestAlloc, createSystem, nodeFs, nodeJs, runMain } from "../src/index.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fakes", () => {
  it("FakeClock", () => {
    const c = FakeClock.create(0);
    expect(c.nowMs()).toBe(0);
    c.advance(1500);
    expect(c.nowMs()).toBe(1500);
  });
  it("SeededRandom is deterministic, in range, seed-dependent", () => {
    const a = SeededRandom.create(42), b = SeededRandom.create(42), c = SeededRandom.create(43);
    const xs = Array.from({ length: 5 }, () => a.nextU32());
    expect(Array.from({ length: 5 }, () => b.nextU32())).toEqual(xs);
    expect(xs).not.toEqual(Array.from({ length: 5 }, () => c.nextU32()));
    expect(xs[0]).toBe(2581720956); // mulberry32(42), pins the algorithm (D020)
    for (let i = 0; i < 1000; i++) {
      const f = a.nextF64();
      expect(f >= 0 && f < 1).toBe(true);
      const u = a.nextU32();
      expect(Number.isInteger(u) && u >= 0 && u <= 4294967295).toBe(true);
    }
  });
  it("MemoryLog records in order, entries() is a copy", () => {
    const l = MemoryLog.create();
    l.info("a"); l.warn("b"); l.error("c");
    const e = l.entries();
    expect(e).toEqual([{ level: "info", message: "a" }, { level: "warn", message: "b" }, { level: "error", message: "c" }]);
    l.info("d");
    expect(e.length).toBe(3);
  });
  it("FakeFs", () => {
    const fs = FakeFs.create();
    expect(fs.readText("/x")).toEqual({ kind: "err", error: { code: "ENOENT", message: expect.any(String) } });
    expect(fs.writeText("/x", "hi")).toEqual({ kind: "ok", value: null });
    expect(fs.readText("/x")).toEqual({ kind: "ok", value: "hi" });
  });
  it("TestAlloc", () => { expect(TestAlloc.create()).toBeDefined(); });
});

describe("node authorities", () => {
  it("Fs: errors become IoError, success round-trips", () => {
    const p = join(mkdtempSync(join(tmpdir(), "sts-")), "f.txt");
    expect(nodeFs.writeText(p, "héllo")).toEqual({ kind: "ok", value: null });
    expect(nodeFs.readText(p)).toEqual({ kind: "ok", value: "héllo" });
    expect(nodeFs.readText(p + ".missing")).toEqual({ kind: "err", error: { code: "ENOENT", message: expect.any(String) } });
    expect(nodeFs.writeText("/nonexistent-dir-sts/x", "")).toMatchObject({ kind: "err" });
  });
  it("Js: traps and stack exhaustion pass through (§8)", async () => {
    const boom = (): never => panic("x");
    expect(() => nodeJs.call(boom, [])).toThrow(Trap);
    expect(() => nodeJs.get({ get a(): number { return panic("y"); } }, "a")).toThrow(Trap);
    await expect(nodeJs.await(Promise.reject(new Trap("T006", "z")))).rejects.toBeInstanceOf(Trap);
    const deep = (): number => deep() + 1;
    expect(() => nodeJs.call(deep, [])).toThrow(RangeError);
  });
  it("Js: exceptions become JsError (code = name)", async () => {
    expect(nodeJs.call(Math.max, [1, 3])).toEqual({ kind: "ok", value: 3 });
    expect(nodeJs.call(() => { throw new RangeError("bad"); }, [])).toEqual({ kind: "err", error: { code: "RangeError", message: "bad" } });
    expect(nodeJs.get({ a: 1 }, "a")).toEqual({ kind: "ok", value: 1 });
    expect(nodeJs.get(null, "a")).toMatchObject({ kind: "err", error: { code: "TypeError" } });
    expect(await nodeJs.await(Promise.resolve(2))).toEqual({ kind: "ok", value: 2 });
    expect(await nodeJs.await(Promise.reject(new Error("no")))).toMatchObject({ kind: "err", error: { message: "no" } });
    expect(nodeJs.decode(5, { k: "num", t: "i32" })).toEqual({ kind: "ok", value: 5 });
    expect(nodeJs.decode("x", { k: "num", t: "i32" })).toMatchObject({ kind: "err", error: { code: "cast" } });
    expect(nodeJs.encode(7)).toBe(7);
  });
  it("System has the six members; Log routes to the writers (Q059)", () => {
    const out: string[] = [], errs: string[] = [];
    const sys = createSystem((s) => out.push(s), (s) => errs.push(s));
    expect(Object.keys(sys).sort()).toEqual(["alloc", "clock", "fs", "js", "log", "random"]);
    sys.log.info("a"); sys.log.warn("b"); sys.log.error("c");
    expect([out, errs]).toEqual([["a\n"], ["b\n", "c\n"]]);
    const r = sys.random.nextF64();
    expect(r >= 0 && r < 1).toBe(true);
    expect(Math.abs(sys.clock.nowMs() - Date.now())).toBeLessThan(1000);
  });
});

describe("runMain", () => {
  const pos: Pos = { file: "m.ts", line: 2, col: 3 };
  it("collects stdout / stderr, awaits async main", async () => {
    const r = await runMain(async (sys) => { sys.log.info("x"); await Promise.resolve(); sys.log.warn("w"); });
    expect(r).toEqual({ stdout: "x\n", stderr: "w\n" });
  });
  it("keeps output before a trap and reports it", async () => {
    const r = await runMain((sys) => { sys.log.info("before"); requires(false, pos); sys.log.info("after"); });
    expect(r.stdout).toBe("before\n");
    expect(r.trap).toMatchObject({ code: "T004", pos });
  });
  it("stack exhaustion is T006 (Q035); other errors propagate", async () => {
    const f = (): number => f() + 1;
    expect((await runMain(() => void f())).trap?.code).toBe("T006");
    await expect(runMain(() => { throw new TypeError("bug"); })).rejects.toThrow("bug");
  });
});
