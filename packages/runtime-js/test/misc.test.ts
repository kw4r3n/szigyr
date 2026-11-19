import { beforeEach, describe, expect, it } from "vitest";
import { Trap, asTrap, requires, ensures, invariant, panic, ok, err, cast, test, runTests, clearTests, Vec, trap, type TypeDesc, type Pos } from "../src/index.ts";

const pos: Pos = { file: "a.ts", line: 9, col: 1 };
const code = (f: () => unknown): string | undefined => { try { f(); } catch (e) { if (e instanceof Trap) return e.code; throw e; } return undefined; };

describe("contracts and panic", () => {
  it("codes and positions", () => {
    expect(code(() => requires(false, pos))).toBe("T004");
    expect(code(() => ensures((r: number) => r > 0, 0, pos))).toBe("T005");
    expect(code(() => invariant(false))).toBe("T010");
    expect(code(() => panic("boom", pos))).toBe("T006");
    expect(() => { requires(true); ensures((r: number) => r > 0, 1); invariant(true); }).not.toThrow();
    try { trap("T001", "x", pos); } catch (e) { expect((e as Trap).pos).toBe(pos); }
  });
});

describe("Result", () => {
  it("shape per SPEC 8", () => {
    expect(ok(1)).toEqual({ kind: "ok", value: 1 });
    expect(err("e")).toEqual({ kind: "err", error: "e" });
  });
});

describe("cast", () => {
  const point: TypeDesc = { k: "rec", f: { x: { k: "num", t: "i32" }, y: { k: "num", t: "f64" } } };
  const shape: TypeDesc = { k: "union", m: [
    { k: "rec", f: { kind: { k: "lit", v: ["circle"] }, r: { k: "num", t: "f64" } } },
    { k: "rec", f: { kind: { k: "lit", v: ["rect"] }, w: { k: "num", t: "f64" } } },
  ] };
  it("an integer is never -0, a float may be (Q090)", () => {
    expect(cast(-0, { k: "num", t: "i32" }).kind).toBe("err");
    expect(cast(-0, { k: "num", t: "f64" }).kind).toBe("ok");
  });
  it("any RangeError is T006 (Q035)", () => {
    expect(asTrap(new RangeError("Invalid string length"))).toMatchObject({ code: "T006" });
    expect(asTrap(new TypeError("x"))).toBeUndefined();
  });
  it("numbers", () => {
    expect(cast<number>(5, { k: "num", t: "u8" })).toEqual(ok(5));
    expect(cast(256, { k: "num", t: "u8" }).kind).toBe("err");
    expect(cast(1.5, { k: "num", t: "i32" }).kind).toBe("err");
    expect(cast("1", { k: "num", t: "f64" }).kind).toBe("err");
    expect(cast(0.1, { k: "num", t: "f32" }).kind).toBe("err");
    expect(cast(0.5, { k: "num", t: "f32" }).kind).toBe("ok");
  });
  it("records are exact", () => {
    expect(cast({ x: 1, y: 2.5 }, point).kind).toBe("ok");
    expect(cast({ x: 1, y: 2, z: 3 }, point).kind).toBe("err");
    expect(cast({ x: 1 }, point).kind).toBe("err");
    expect(cast(null, point).kind).toBe("err");
    expect(cast([], point).kind).toBe("err");
  });
  it("tagged union, nullable, arrays; error carries the path", () => {
    expect(cast({ kind: "rect", w: 2 }, shape).kind).toBe("ok");
    expect(cast({ kind: "tri" }, shape).kind).toBe("err");
    const nullable: TypeDesc = { k: "union", m: [{ k: "string" }, { k: "null" }] };
    expect(cast(null, nullable).kind).toBe("ok");
    expect(cast(1, nullable).kind).toBe("err");
    const r = cast([{ x: 1, y: 1 }, { x: "a", y: 1 }], { k: "arr", of: point });
    expect(r).toEqual({ kind: "err", error: { code: "cast", message: expect.stringContaining("$[1].x") } });
  });
  it("catches exceptions thrown by getters, proxies, and array length; traps pass through (§7.4, D060)", () => {
    const rec: TypeDesc = { k: "rec", f: { a: { k: "num", t: "i32" } } };
    const getterThrows = { get a(): number { throw new Error("boom-getter"); } };
    expect(cast(getterThrows, rec)).toEqual({ kind: "err", error: { code: "cast", message: "boom-getter" } });
    const proxyOwnKeys = new Proxy({}, { ownKeys() { throw new Error("boom-keys"); } });
    expect(cast(proxyOwnKeys, rec)).toEqual({ kind: "err", error: { code: "cast", message: "boom-keys" } });
    const proxyGet = new Proxy({ a: 1 }, { get() { throw new Error("boom-get"); } });
    expect(cast(proxyGet, rec)).toEqual({ kind: "err", error: { code: "cast", message: "boom-get" } });
    const arrProxy = new Proxy([] as number[], { get(_, k) { if (k === "length") throw new Error("boom-len"); return undefined; } });
    expect(cast(arrProxy, { k: "arr", of: { k: "num", t: "i32" } })).toEqual({ kind: "err", error: { code: "cast", message: "boom-len" } });
    const trapGetter = { get a(): number { return panic("trap-in-getter"); } };
    expect(() => cast(trapGetter, rec)).toThrow(Trap);
  });
});

describe("test runner", () => {
  beforeEach(clearTests);
  it("runs in order, reports failures and traps, survives them", async () => {
    test("pass", (t) => { t.ok(true); t.eq({ a: [1, NaN] }, { a: [1, NaN] }); t.eq(0, -0); });
    test("eq fails", (t) => t.eq([1, 2], [1, 3], pos));
    test("trap outside traps", () => { requires(false, pos); });
    test("traps ok", (t) => t.traps("T002", () => trap("T002", "x")));
    test("traps wrong code", (t) => t.traps("T001", () => trap("T002", "x")));
    test("traps none", (t) => t.traps("T001", () => {}));
    test("eqSlice", (t) => {
      const mk = (xs: number[]) => { const v = Vec.create<number>(null, 4, "i32"); xs.forEach((x) => v.push(x)); return v.view(); };
      t.eqSlice(mk([1, 2]), mk([1, 2]));
      t.eqSlice(mk([1, 2]), mk([1, 3]));
    });
    test("async", async (t) => { await Promise.resolve(); t.ok(false); });
    const rs = await runTests();
    expect(rs.map((r) => [r.name, r.ok])).toEqual([
      ["pass", true], ["eq fails", false], ["trap outside traps", false], ["traps ok", true],
      ["traps wrong code", false], ["traps none", false], ["eqSlice", false], ["async", false],
    ]);
    expect(rs[1]!.pos).toBe(pos);
    expect(rs[2]!.trap).toEqual({ code: "T004", pos });
    expect(rs[6]!.failure).toContain("[1]");
  });
  it("internal errors are not swallowed", async () => {
    test("bug", () => { throw new TypeError("internal"); });
    await expect(runTests()).rejects.toThrow("internal");
  });
});
