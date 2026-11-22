import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Arena, Trap, Vec, panic, requires, setForeignTrapCheck, stopFakeIsolates, takeIsolateTrap, type Pos } from "../../runtime-js/src/index.ts";
import { ALLOC, FakeAudio, FakeClock, FakeFs, FakeNet, FakeProc, FakeSpawn, MemoryLog, SeededRandom, TestAlloc, createSystem, nodeFs, nodeJs, runMain } from "../src/index.ts";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fakes", () => {
  it("FakeClock advance and sleep", async () => {
    const c = FakeClock.create(0);
    expect(c.nowMs()).toBe(0);
    c.advance(1500);
    expect(c.nowMs()).toBe(1500);
    await c.sleep(250);
    expect(c.nowMs()).toBe(1750);
    await c.sleep(-10);
    await c.sleep(Number.NaN);
    await c.sleep(Number.POSITIVE_INFINITY);
    expect(c.nowMs()).toBe(1750);
  });
  it("FakeAudio open, renderFrames, close, and EINVAL", async () => {
    const a = FakeAudio.create();
    const bad = await a.open({ sampleRate: 0, channels: 2 }, null, { fn: () => {}, id: 0 });
    expect(bad).toEqual({ kind: "err", error: { code: "EINVAL", message: expect.any(String) } });
    const state = { v: 1 };
    const r = await a.open({ sampleRate: 48000, channels: 2 }, state, {
      id: 0,
      fn(st, out, frames) {
        const s = st as { v: number };
        for (let i = 0; i < frames; i++) {
          out.set(i * 2, s.v * 0.25);
          out.set(i * 2 + 1, -s.v * 0.25);
        }
        s.v += 1;
      },
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.value.isOpen()).toBe(true);
    expect(a.renderFrames(0)).toEqual([]);
    expect(a.renderFrames(2)).toEqual([0.25, -0.25, 0.25, -0.25]);
    expect(a.renderFrames(1)).toEqual([0.5, -0.5]);
    await r.value.close();
    await r.value.close();
    expect(r.value.isOpen()).toBe(false);
    expect(() => a.renderFrames(4)).toThrow(/^T006:/);
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
    expect(fs.writeText("/x", "hé")).toEqual({ kind: "ok", value: null });
    expect(fs.readText("/x")).toEqual({ kind: "ok", value: "hé" });

    const dst = Vec.create<number>(ALLOC, 4, "u8");
    dst.push(99); dst.push(77);
    expect(fs.readBytes("/x", dst)).toEqual({ kind: "ok", value: 3 });
    expect([dst.length, dst.get(0), dst.get(1), dst.get(2)]).toEqual([3, 104, 195, 169]);
    expect(fs.readBytes("/missing", dst)).toEqual({ kind: "err", error: { code: "ENOENT", message: expect.any(String) } });
    expect([dst.length, dst.get(0), dst.get(1), dst.get(2)]).toEqual([3, 104, 195, 169]);

    const src = Vec.create<number>(ALLOC, 4, "u8");
    src.push(1); src.push(2); src.push(3); src.push(4);
    expect(fs.writeBytes("/slice", src.slice(1, 3))).toEqual({ kind: "ok", value: null });
    src.set(1, 255); // copy isolation
    expect(fs.readBytes("/slice", dst)).toEqual({ kind: "ok", value: 2 });
    expect([dst.length, dst.get(0), dst.get(1)]).toEqual([2, 2, 3]);

    expect(fs.mkdir("/a/b")).toEqual({ kind: "ok", value: null });
    expect(fs.exists("/a")).toBe(true);
    expect(fs.exists("/a/b")).toBe(true);
    expect(fs.exists("/missing")).toBe(false);
    expect(fs.writeTextAtomic("/a/b/z.txt", "hi")).toEqual({ kind: "ok", value: null });
    expect(fs.writeBytesAtomic("/a/b/a.bin", src.slice(0, 2))).toEqual({ kind: "ok", value: null });
    const st = fs.stat("/a/b/a.bin");
    expect(st.kind).toBe("ok");
    if (st.kind === "ok") {
      expect(st.value.kind).toBe("file");
      expect(st.value.size).toBe(2n);
      expect(st.value.mtimeMs).toBeGreaterThan(0);
    }
    const dir = fs.readDir("/a/b");
    expect(dir).toEqual({ kind: "ok", value: [{ name: "a.bin", kind: "file" }, { name: "z.txt", kind: "file" }] });
    expect(fs.rename("/a/b/z.txt", "/a/b/m.txt")).toEqual({ kind: "ok", value: null });
    expect(fs.rename("/a/b", "/a/c")).toEqual({ kind: "ok", value: null });
    expect(fs.readText("/a/c/m.txt")).toEqual({ kind: "ok", value: "hi" });
    expect(fs.rename("/a/c/m.txt", "/a/c").kind).toBe("err"); // EISDIR
    expect(fs.rename("/a/c/m.txt/sub", "/a/x").kind).toBe("err"); // ENOTDIR
    expect(fs.rename("/missing", "/a/x").kind).toBe("err"); // ENOENT
    expect(fs.mkdir("/a/c/m.txt/sub").kind).toBe("err"); // EEXIST/ENOTDIR
    expect(fs.writeTextAtomic("/a/c", "x").kind).toBe("err"); // EISDIR
    expect(fs.remove("/").kind).toBe("err"); // EBUSY
    expect(fs.remove("/a").kind).toBe("ok");
    expect(fs.exists("/a")).toBe(false);
    expect(fs.remove("/a").kind).toBe("err"); // ENOENT

    // Strict parent directory enforcement (parity with nodeFs) and addSymlink semantics
    const missingWrites = [
      fs.writeText("/no-parent/a.txt", "hi"),
      fs.writeBytes("/no-parent/b.bin", src),
      fs.writeTextAtomic("/no-parent/c.txt", "hi"),
      fs.writeBytesAtomic("/no-parent/d.bin", src),
    ];
    for (const r of missingWrites) expect(r).toMatchObject({ kind: "err", error: { code: "ENOENT" } });

    expect(fs.mkdir("/sym/sub")).toEqual({ kind: "ok", value: null });
    expect(fs.writeText("/sym/sub/real.txt", "payload")).toEqual({ kind: "ok", value: null });
    expect(fs.addSymlink("/sym/sub/link.txt", "real.txt")).toEqual({ kind: "ok", value: null });
    expect(fs.addSymlink("/sym/broken", "/sym/missing.txt")).toEqual({ kind: "ok", value: null });
    expect(fs.addSymlink("/sym/loopA", "loopB")).toEqual({ kind: "ok", value: null });
    expect(fs.addSymlink("/sym/loopB", "loopA")).toEqual({ kind: "ok", value: null });
    expect(fs.addSymlink("/sym/sub/link.txt", "other")).toMatchObject({ kind: "err", error: { code: "EEXIST" } });
    expect(fs.addSymlink("/sym/no-dir/x", "y")).toMatchObject({ kind: "err", error: { code: "ENOENT" } });

    expect(fs.stat("/sym/sub/link.txt")).toMatchObject({ kind: "ok", value: { kind: "symlink" } });
    expect(fs.readDir("/sym/sub")).toEqual({
      kind: "ok",
      value: [{ name: "link.txt", kind: "symlink" }, { name: "real.txt", kind: "file" }],
    });
    expect(fs.exists("/sym/sub/link.txt")).toBe(true);
    expect(fs.exists("/sym/broken")).toBe(false);
    expect(fs.exists("/sym/loopA")).toBe(false);
    expect(fs.readText("/sym/sub/link.txt")).toEqual({ kind: "ok", value: "payload" });
    expect(fs.readBytes("/sym/sub/link.txt", dst)).toEqual({ kind: "ok", value: 7 });
    expect(fs.readText("/sym/broken")).toMatchObject({ kind: "err", error: { code: "ENOENT" } });
    expect(fs.readText("/sym/loopA")).toMatchObject({ kind: "err", error: { code: "ELOOP" } });

    expect(fs.rename("/sym/sub/link.txt", "/sym/sub/moved-link")).toEqual({ kind: "ok", value: null });
    expect(fs.readText("/sym/sub/moved-link")).toEqual({ kind: "ok", value: "payload" });
    expect(fs.writeTextAtomic("/sym/sub/moved-link", "overwritten")).toEqual({ kind: "ok", value: null });
    expect(fs.stat("/sym/sub/moved-link")).toMatchObject({ kind: "ok", value: { kind: "file" } });
    expect(fs.readText("/sym/sub/real.txt")).toEqual({ kind: "ok", value: "payload" });
    expect(fs.remove("/sym/broken")).toEqual({ kind: "ok", value: null });
    expect(fs.stat("/sym/broken")).toMatchObject({ kind: "err", error: { code: "ENOENT" } });
    expect(fs.remove("/sym")).toEqual({ kind: "ok", value: null });
  });
  it("FakeSpawn roundtrip, alloc 2nd param, trap forwarding, and deadlock detection", async () => {
    setForeignTrapCheck(() => {
      const ft = takeIsolateTrap();
      if (ft) throw new Trap(ft.code as Trap["code"], ft.message ?? "trap in isolate");
    });
    try {
      takeIsolateTrap();
      const sp = FakeSpawn.create();
      // 1) Roundtrip with Vec & Arena + alloc 2nd param
      const p1 = sp.isolate("m", "w", async (port, alloc) => {
        const msg = await port.recv() as { ar: Arena } | null;
        if (!msg) return;
        const ab = msg.ar.alloc(2, 42, "u8");
        if (!ab) return;
        const v = Vec.create<number>(alloc, 2, "u8");
        v.push(msg.ar.view<number>(ab, "u8").get(1));
        v.push(99);
        port.send(v);
      });
      const ar = Arena.create(ALLOC, 64);
      p1.send({ ar });
      const res = await p1.recv() as Vec<number> | null;
      p1.close();
      expect(res).not.toBeNull();
      expect([res!.length, res!.get(0), res!.get(1)]).toEqual([2, 42, 99]);

      // 2) Trap propagation from worker
      const p2 = sp.isolate("m", "trapW", async (port) => {
        await port.recv();
        panic("worker failed");
      });
      p2.send(1);
      await expect(p2.recv()).rejects.toMatchObject({ code: "T006" });
      p2.close();

      // 3) Deadlock detection when both sides await recv without sending
      const p3 = sp.isolate("m", "deadW", async (port) => {
        await port.recv();
      });
      await expect(p3.recv()).rejects.toMatchObject({ code: "T006", message: expect.stringContaining("deadlock") });
      p3.close();
    } finally {
      stopFakeIsolates();
      takeIsolateTrap();
      setForeignTrapCheck(undefined);
    }
  });
  it("FakeProc env, cwd, args, onRun, calls, and errors", async () => {
    const p = FakeProc.create();
    p.setEnv("MODE", "test");
    p.setCwd("/work");
    p.setArgs(["--flag", "val"]);
    expect(p.env("MODE")).toBe("test");
    expect(p.env("MISSING")).toBeNull();
    expect(p.cwd()).toBe("/work");
    expect(p.args()).toEqual(["--flag", "val"]);

    expect(await p.run("", [])).toEqual({ kind: "err", error: { code: "EINVAL", message: expect.any(String) } });
    expect(await p.run("missing", [])).toEqual({ kind: "err", error: { code: "ENOENT", message: expect.any(String) } });

    p.onRun((req) => ({ kind: "ok", value: { exitCode: 0, stdout: `${req.program}:${req.args.join(",")}:${req.stdin ?? ""}`, stderr: "", timedOut: false } }));
    const res = await p.run("echo", ["a", "b"], { cwd: "/sub", env: [{ name: "K", value: "V" }], stdin: "in", timeoutMs: 50 });
    expect(res).toEqual({ kind: "ok", value: { exitCode: 0, stdout: "echo:a,b:in", stderr: "", timedOut: false } });
    p.onRun(() => ({ kind: "err", error: { code: "EACCES", message: "denied" } }));
    expect(await p.run("denied", [])).toEqual({ kind: "err", error: { code: "EACCES", message: "denied" } });
    expect(p.calls()).toHaveLength(4);
    expect(p.calls()[2]).toEqual({
      program: "echo",
      args: ["a", "b"],
      cwd: "/sub",
      env: [{ name: "K", value: "V" }],
      stdin: "in",
      timeoutMs: 50,
    });
  });
  it("FakeNet serve, loopback fetch, onFetch, close, and errors", async () => {
    const n = FakeNet.create();
    expect((await n.serve({ host: "bad host", port: 0 }, async () => ({ status: 200, headers: [], body: "" }))).kind).toBe("err");
    expect((await n.serve({ host: "127.0.0.1", port: -1 }, async () => ({ status: 200, headers: [], body: "" }))).kind).toBe("err");
    expect((await n.fetch("http://127.0.0.1:9999/")).kind).toBe("err"); // ECONNREFUSED

    const srvRes = await n.serve({ host: "127.0.0.1", port: 0 }, async (req) => ({
      status: 201,
      headers: [{ name: "X-Method", value: req.method }],
      body: `${req.path}?${req.query}:${req.body}`,
    }));
    expect(srvRes.kind).toBe("ok");
    if (srvRes.kind !== "ok") return;
    const srv = srvRes.value;
    expect(srv.port).toBeGreaterThan(0);
    expect((await n.serve({ host: "127.0.0.1", port: srv.port }, async () => ({ status: 200, headers: [], body: "" }))).kind).toBe("err"); // EADDRINUSE

    const r1 = await n.fetch(`http://127.0.0.1:${srv.port}/items?q=42`, {
      method: "POST",
      headers: [{ name: "Content-Type", value: "text/plain" }],
      body: "hello",
      timeoutMs: 1000,
    });
    expect(r1).toEqual({
      kind: "ok",
      value: { status: 201, headers: [{ name: "x-method", value: "POST" }], body: "/items?q=42:hello" },
    });
    await srv.disposeAsync();
    expect(srv.isOpen()).toBe(false);
    expect((await n.fetch(`http://127.0.0.1:${srv.port}/`)).kind).toBe("err");

    n.onFetch((req) => ({ kind: "ok", value: { status: 200, headers: [], body: `mock:${req.url}` } }));
    const r2 = await n.fetch("https://example.invalid/api");
    expect(r2).toEqual({ kind: "ok", value: { status: 200, headers: [], body: "mock:https://example.invalid/api" } });
    expect(n.requests().map((r) => r.url)).toContain("https://example.invalid/api");

    // stop() inside handler + waitClosed()
    let stopTarget: { stop(): void; waitClosed(): Promise<void>; isOpen(): boolean } | undefined;
    const gsRes = await n.serve({ host: "127.0.0.1", port: 0 }, async () => {
      stopTarget?.stop();
      return { status: 200, headers: [], body: "bye" };
    });
    expect(gsRes.kind).toBe("ok");
    if (gsRes.kind === "ok") {
      stopTarget = gsRes.value;
      expect(stopTarget.isOpen()).toBe(true);
      const gr = await n.fetch(`http://127.0.0.1:${gsRes.value.port}/shutdown`);
      expect(gr).toEqual({ kind: "ok", value: { status: 200, headers: [], body: "bye" } });
      await stopTarget.waitClosed();
      expect(stopTarget.isOpen()).toBe(false);
    }
  });
  it("TestAlloc", () => { expect(TestAlloc.create()).toBeDefined(); });
});

describe("node authorities", () => {
  it("Fs: errors become IoError, success round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "szigyr-"));
    const p = join(dir, "f.txt");
    expect(nodeFs.writeText(p, "héllo")).toEqual({ kind: "ok", value: null });
    expect(nodeFs.readText(p)).toEqual({ kind: "ok", value: "héllo" });
    expect(nodeFs.readText(p + ".missing")).toEqual({ kind: "err", error: { code: "ENOENT", message: expect.any(String) } });
    expect(nodeFs.writeText("/nonexistent-dir-szigyr/x", "")).toMatchObject({ kind: "err" });

    const bp = join(dir, "all.bin");
    const src = Vec.create<number>(ALLOC, 256, "u8");
    for (let i = 0; i < 256; i++) src.push(i);
    expect(nodeFs.writeBytes(bp, src)).toEqual({ kind: "ok", value: null });
    const dst = Vec.create<number>(ALLOC, 4, "u8");
    dst.push(9); dst.push(8); dst.push(7);
    expect(nodeFs.readBytes(bp + ".missing", dst)).toEqual({ kind: "err", error: { code: "ENOENT", message: expect.any(String) } });
    expect([dst.length, dst.get(0), dst.get(1), dst.get(2)]).toEqual([3, 9, 8, 7]);
    expect(nodeFs.readBytes(bp, dst)).toEqual({ kind: "ok", value: 256 });
    expect(dst.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(dst.get(i)).toBe(i);
    expect(nodeFs.readBytes(bp, src.slice(0, 10) as never)).toBeDefined(); // keep slice test below:
    const sOut = Vec.create<number>(ALLOC, 4, "u8");
    expect(nodeFs.writeBytes(join(dir, "sub.bin"), src.slice(10, 14))).toEqual({ kind: "ok", value: null });
    expect(nodeFs.readBytes(join(dir, "sub.bin"), sOut)).toEqual({ kind: "ok", value: 4 });
    expect([sOut.get(0), sOut.get(1), sOut.get(2), sOut.get(3)]).toEqual([10, 11, 12, 13]);

    expect(nodeFs.mkdir(join(dir, "nested/sub"))).toEqual({ kind: "ok", value: null });
    expect(nodeFs.exists(join(dir, "nested/sub"))).toBe(true);
    expect(nodeFs.writeTextAtomic(join(dir, "nested/sub/b.txt"), "atomic")).toEqual({ kind: "ok", value: null });
    expect(nodeFs.writeBytesAtomic(join(dir, "nested/sub/a.bin"), src.slice(0, 3))).toEqual({ kind: "ok", value: null });
    expect(nodeFs.writeTextAtomic(join(dir, "nested"), "bad").kind).toBe("err"); // EISDIR
    expect(readdirSync(dir).some((e) => e.startsWith(".sztmp-"))).toBe(false);
    const st = nodeFs.stat(join(dir, "nested/sub/a.bin"));
    expect(st.kind).toBe("ok");
    if (st.kind === "ok") { expect(st.value.kind).toBe("file"); expect(st.value.size).toBe(3n); }
    expect(nodeFs.readDir(join(dir, "nested/sub"))).toEqual({
      kind: "ok",
      value: [{ name: "a.bin", kind: "file" }, { name: "b.txt", kind: "file" }],
    });
    expect(nodeFs.rename(join(dir, "nested/sub/b.txt"), join(dir, "nested/sub/c.txt"))).toEqual({ kind: "ok", value: null });
    expect(nodeFs.readText(join(dir, "nested/sub/c.txt"))).toEqual({ kind: "ok", value: "atomic" });
    expect(nodeFs.remove(join(dir, "nested"))).toEqual({ kind: "ok", value: null });
    expect(nodeFs.exists(join(dir, "nested"))).toBe(false);
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
  it("Js.callback: the first argument is checked like decode (Q128)", () => {
    const seen: unknown[] = [];
    const f = nodeJs.callback((r) => { seen.push(r); }, { k: "num", t: "i32" }) as (...a: unknown[]) => unknown;
    expect(f(5, "extra")).toBeUndefined();
    f("x");
    f();
    expect(seen).toMatchObject([{ kind: "ok", value: 5 }, { kind: "err", error: { code: "cast" } }, { kind: "err", error: { code: "cast" } }]);
    const bad = { get a(): number { throw new Error("boom-cb"); } };
    const recDesc = { k: "rec" as const, f: { a: { k: "num" as const, t: "i32" as const } } };
    expect(nodeJs.decode(bad, recDesc)).toEqual({ kind: "err", error: { code: "cast", message: "boom-cb" } });
    const cbSeen: unknown[] = [];
    const cb = nodeJs.callback((r) => { cbSeen.push(r); }, recDesc) as (...a: unknown[]) => unknown;
    cb(bad);
    expect(cbSeen).toEqual([{ kind: "err", error: { code: "cast", message: "boom-cb" } }]);
  });
  it("Js.new, Js.invoke, Js.set, Js.object, Js.fn handle edge cases and preserve Traps", () => {
    class Counter {
      v: number;
      constructor(init: number) { this.v = init; }
      add(delta: number): number { return this.v + delta; }
    }
    const cRes = nodeJs.new(Counter, [10]);
    expect(cRes.kind).toBe("ok");
    if (cRes.kind !== "ok") return;
    expect(nodeJs.invoke(cRes.value, "add", [5])).toEqual({ kind: "ok", value: 15 });
    expect(nodeJs.set(cRes.value, "v", 20)).toEqual({ kind: "ok", value: null });
    expect(nodeJs.invoke(cRes.value, "add", [5])).toEqual({ kind: "ok", value: 25 });

    // Non-constructor, throwing ctor, missing/non-function method, frozen property set
    expect(nodeJs.new(() => 1, [])).toMatchObject({ kind: "err", error: { code: "TypeError" } });
    function Boom(): void { throw new RangeError("bad ctor"); }
    expect(nodeJs.new(Boom, [])).toEqual({ kind: "err", error: { code: "RangeError", message: "bad ctor" } });
    expect(nodeJs.invoke(cRes.value, "missing", [])).toMatchObject({ kind: "err", error: { code: "TypeError" } });
    expect(nodeJs.invoke(cRes.value, "v", [])).toMatchObject({ kind: "err", error: { code: "TypeError" } });
    expect(nodeJs.set(Object.freeze({ x: 1 }), "x", 2)).toMatchObject({ kind: "err", error: { code: "TypeError" } });

    // object builder incl. empty and __proto__ own property safety
    expect(nodeJs.object([])).toEqual({});
    const built = nodeJs.object([
      { key: "ok", value: 42 },
      { key: "__proto__", value: "safe-own" },
    ]) as Record<string, unknown>;
    expect(built.ok).toBe(42);
    expect(Object.prototype.hasOwnProperty.call(built, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(built, "__proto__")?.value).toBe("safe-own");
    expect(Object.getPrototypeOf(built)).toBe(Object.prototype);

    // fn multi-arg returning wrapper & Trap passthrough through call/invoke/new
    const sumFn = nodeJs.fn((args) => args.reduce<number>((a, b) => a + (b as number), 0)) as (...a: unknown[]) => unknown;
    expect(sumFn()).toBe(0);
    expect(sumFn(1, 2, 3, 4)).toBe(10);
    const trapFn = nodeJs.fn(() => { throw new Trap("T006", "cb boom", { file: "t.szigyr", line: 1, col: 1 }); });
    expect(() => nodeJs.call(trapFn, [])).toThrow(Trap);
    const host = { run(cb: () => unknown) { return cb(); } };
    expect(() => nodeJs.invoke(host, "run", [trapFn])).toThrow(Trap);
    class TrapCtor { constructor(cb: () => unknown) { cb(); } }
    expect(() => nodeJs.new(TrapCtor, [trapFn])).toThrow(Trap);
  });
  it("System has the ten members; Log routes to the writers (Q059)", () => {
    const out: string[] = [], errs: string[] = [];
    const sys = createSystem((s) => out.push(s), (s) => errs.push(s));
    expect(Object.keys(sys).sort()).toEqual(["alloc", "audio", "clock", "fs", "js", "log", "net", "proc", "random", "spawn"]);
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

describe("Q140: a rejected Promise nobody awaits (separate process: vitest reports unhandled rejections itself)", () => {
  const node = (body: string) => {
    const r = spawnSync("node", ["--input-type=module", "-e", body], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const rt = new URL("../../runtime-js/src/index.ts", import.meta.url).href;
  const std = new URL("../src/index.ts", import.meta.url).href;

  it("runMain reports the late rejection as a trap and returns", () => {
    const r = node(`import { panic } from "${rt}"; import { runMain } from "${std}";
const g = async () => { panic("late"); };
const res = await runMain((sys) => { void g(); sys.log.info("done"); });
console.log(JSON.stringify(res));`);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ stdout: "done\n", trap: { code: "T006" } });
  });

  it("runTests blames the test that left the Promise, and the next test still runs", () => {
    const r = node(`import { panic, test, runTests } from "${rt}";
const h = async () => { panic("x"); };
test("floating", (t) => { void h(); t.ok(true); });
test("after", (t) => { t.ok(true); });
console.log(JSON.stringify((await runTests()).map((x) => [x.name, x.ok, x.trap?.code])));`);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([["floating", false, "T006"], ["after", true, null]]);
  });
});

