import { describe, expect, it } from "vitest";
import { Trap, Vec, OwnedCell, at, setAt, nn, idxOrNull, charCodeAt, type Pos } from "../src/index.ts";

const pos: Pos = { file: "a.ts", line: 1, col: 2 };
const code = (f: () => unknown): string | undefined => { try { f(); } catch (e) { if (e instanceof Trap) return e.code; throw e; } return undefined; };

describe("Vec", () => {
  it("typed backing store, growth past capacity", () => {
    const v = Vec.create<number>(null, 1, "i32");
    for (let i = 0; i < 100; i++) v.push(i);
    expect(v.length).toBe(100);
    expect(v.get(99)).toBe(99);
    expect(v.pop()).toBe(99);
    expect(v.length).toBe(99);
  });
  it("f32 stores rounded values; non-numeric elements use arrays", () => {
    const f = Vec.create<number>(null, 2, "f32");
    f.push(0.1);
    expect(f.get(0)).toBe(Math.fround(0.1));
    const o = Vec.create<{ x: number }>(null, 0);
    o.push({ x: 1 });
    expect(o.get(0)).toEqual({ x: 1 });
  });
  it("index trap at length (not capacity)", () => {
    const v = Vec.create<number>(null, 8, "u8");
    v.push(1);
    expect(code(() => v.get(1, pos))).toBe("T002");
    expect(code(() => v.set(1, 5))).toBe("T002");
    expect(code(() => v.get(-1))).toBe("T002");
    expect(code(() => v.get(0.5))).toBe("T002");
    v.set(0, 9);
    expect(v.get(0)).toBe(9);
  });
  it("pop on empty is null; clear; fill covers length only", () => {
    const v = Vec.create<number>(null, 4, "i32");
    expect(v.pop()).toBeNull();
    v.push(1); v.push(2);
    v.fill(7);
    expect([v.get(0), v.get(1)]).toEqual([7, 7]);
    v.clear();
    expect(v.length).toBe(0);
    v.push(3);
    expect(v.get(0)).toBe(3);
  });
});

describe("Slice", () => {
  const mk = () => { const v = Vec.create<number>(null, 8, "i32"); for (let i = 0; i < 6; i++) v.push(i * i); return v; };
  it("is a view of the same buffer", () => {
    const v = mk();
    const s = v.slice(1, 4);
    s.set(0, 100);
    s.fill(7);
    expect([0, 1, 2, 3, 4, 5].map((i) => v.get(i))).toEqual([0, 7, 7, 7, 16, 25]);
    expect(s.slice(1, 3).get(0)).toBe(7);
  });
  it("range rules: start <= end <= length", () => {
    const v = mk();
    expect(v.slice(0, 6).length).toBe(6);
    expect(v.slice(6, 6).length).toBe(0);
    expect(code(() => v.slice(0, 7, pos))).toBe("T002");
    expect(code(() => v.slice(4, 3))).toBe("T002");
    expect(code(() => v.slice(-1, 3))).toBe("T002");
    const s = v.slice(2, 4);
    expect(code(() => s.slice(0, 3))).toBe("T002");
    expect(code(() => s.get(2))).toBe("T002");
    expect(code(() => s.set(2, 1))).toBe("T002");
  });
  it("view() covers the whole vec; fill on array-backed", () => {
    const v = mk();
    expect(v.view().length).toBe(6);
    const o = Vec.create<boolean>(null, 2);
    o.push(false); o.push(false);
    o.slice(1, 2).fill(true);
    expect([o.get(0), o.get(1)]).toEqual([false, true]);
  });
});

describe("at / setAt", () => {
  it("Array, Vec, Slice", () => {
    expect(at([1, 2], 1)).toBe(2);
    expect(code(() => at([1, 2], 2, pos))).toBe("T002");
    const a = [1];
    expect(code(() => setAt(a, 1, 5))).toBe("T002");
    setAt(a, 0, 5);
    expect(a[0]).toBe(5);
    const v = Vec.create<number>(null, 1, "i32");
    expect(code(() => at(v, 0))).toBe("T002");
  });
});

describe("OwnedCell", () => {
  it("take / put / isEmpty and misuse", () => {
    const c = OwnedCell.create(5);
    expect(c.isEmpty()).toBe(false);
    expect(code(() => c.put(1, pos))).toBe("T008");
    expect(c.take()).toBe(5);
    expect(c.isEmpty()).toBe(true);
    expect(code(() => c.take(pos))).toBe("T008");
    c.put(6);
    expect(c.take()).toBe(6);
  });
  it("a null payload counts as full", () => {
    const c = OwnedCell.create<null>(null);
    expect(c.isEmpty()).toBe(false);
    expect(c.take()).toBeNull();
  });
});

describe("normalization", () => {
  it("nn, idxOrNull, charCodeAt", () => {
    expect(nn(undefined)).toBeNull();
    expect(nn(0)).toBe(0);
    expect(nn(null)).toBeNull();
    expect(idxOrNull(-1)).toBeNull();
    expect(idxOrNull(0)).toBe(0);
    expect(charCodeAt("A", 0)).toBe(65);
    expect(code(() => charCodeAt("A", 1, pos))).toBe("T002");
  });
});

describe("Vec.pack / Vec.unpack (§15.2)", () => {
  const rec = JSON.stringify({ t: "rec", z: 8, a: 4, f: [{ n: "x", o: 0, l: { t: "num", n: "i32", z: 4, a: 4 } }, { n: "b", o: 4, l: { t: "bool", z: 1, a: 1 } }] }) as `{${string}`;
  it("round-trips numeric and packed elements", () => {
    const v = Vec.create<number>(null, 4, "i32");
    v.push(3); v.push(-5);
    const u = Vec.unpack<number>(v.pack());
    expect([u.length, u.get(0), u.get(1)]).toEqual([2, 3, -5]);
    const r = Vec.create<{ x: number; b: boolean }>(null, 1, rec);
    r.push({ x: 9, b: true });
    expect(Vec.unpack<{ x: number; b: boolean }>(r.pack()).get(0)).toEqual({ x: 9, b: true });
  });
  it("an empty Vec received from an isolate still grows on push", () => {
    const v = Vec.unpack<number>(Vec.create<number>(null, 0, "i32").pack());
    v.push(7); v.push(8);
    expect([v.length, v.get(0), v.get(1)]).toEqual([2, 7, 8]);
    const r = Vec.unpack<{ x: number; b: boolean }>(Vec.create<{ x: number; b: boolean }>(null, 0, rec).pack());
    r.push({ x: 1, b: false });
    expect(r.get(0)).toEqual({ x: 1, b: false });
  });
});
