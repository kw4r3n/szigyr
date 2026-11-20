import { describe, expect, it } from "vitest";
import { createRng, formatArgs, generateRaw, materializeArgs, shrinkRaw, Vec, type GenDesc } from "../src/index.ts";

describe("arbitrary value generator & shrinker", () => {
  it("createRng is deterministic mulberry32 with a fixed default seed", () => {
    const a = createRng();
    const b = createRng();
    const s1 = Array.from({ length: 10 }, () => a());
    const s2 = Array.from({ length: 10 }, () => b());
    expect(s1).toEqual(s2);
    expect(s1.every((x) => x >= 0 && x < 1)).toBe(true);
    const c = createRng(123);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(s1.slice(0, 5));
  });

  it("mixes boundary values for integers and floats", () => {
    const rng = createRng(1);
    const i32Desc: GenDesc = { k: "num", t: "i32" };
    const f64Desc: GenDesc = { k: "num", t: "f64" };
    const f32Desc: GenDesc = { k: "num", t: "f32" };
    const ints: number[] = [];
    const floats: number[] = [];
    const f32s: number[] = [];
    for (let i = 0; i < 200; i++) {
      const [iv, fv, fv32] = generateRaw([i32Desc, f64Desc, f32Desc], rng, 10) as [number, number, number];
      ints.push(iv);
      floats.push(fv);
      f32s.push(fv32);
    }
    expect(ints).toContain(0);
    expect(ints).toContain(1);
    expect(ints).toContain(-1);
    expect(ints).toContain(2147483647);
    expect(ints).toContain(-2147483648);
    expect(floats.some((x) => Number.isNaN(x))).toBe(true);
    expect(floats).toContain(Infinity);
    expect(floats).toContain(-Infinity);
    expect(floats).toContain(0);
    expect(f32s.every((x) => Object.is(x, Math.fround(x)))).toBe(true);
  });

  it("materializeArgs creates fresh non-aliasing containers on every call", () => {
    const descs: GenDesc[] = [
      { k: "vec", of: { k: "num", t: "i32" }, elem: "i32" },
      { k: "arr", of: { k: "num", t: "i32" } },
      { k: "set", of: { k: "num", t: "i32" } },
      { k: "map", key: { k: "str" }, val: { k: "num", t: "i32" } },
      { k: "rec", f: [{ n: "buf", d: { k: "vec", of: { k: "num", t: "i32" }, elem: "i32" } }, { n: "n", d: { k: "num", t: "i32" } }] },
    ];
    const raw = [[1, 2], [3, 4], [5, 6], [["k", 7]], { buf: [8], n: 9 }];
    const a1 = materializeArgs(descs, raw) as [Vec<number>, number[], Set<number>, Map<string, number>, { buf: Vec<number>; n: number }];
    const a2 = materializeArgs(descs, raw) as [Vec<number>, number[], Set<number>, Map<string, number>, { buf: Vec<number>; n: number }];

    expect(a1[0]).toBeInstanceOf(Vec);
    expect(a1[0].get(0)).toBe(1);
    a1[0].push(99);
    a1[1].push(99);
    a1[2].add(99);
    a1[3].set("x", 99);
    a1[4].buf.push(99);
    a1[4].n = 999;

    expect(a2[0].length).toBe(2);
    expect(a2[1]).toEqual([3, 4]);
    expect(a2[2].has(99)).toBe(false);
    expect(a2[3].has("x")).toBe(false);
    expect(a2[4].buf.length).toBe(1);
    expect(a2[4].n).toBe(9);
  });

  it("shrinkRaw deterministically shrinks numbers, strings, arrays, vecs towards 0 / empty", () => {
    const descs: GenDesc[] = [
      { k: "num", t: "i32" },
      { k: "arr", of: { k: "num", t: "i32" } },
      { k: "str" },
    ];
    const raw = [12345, [10, 20, 30, 40], "abcdef"];
    const shrunk = shrinkRaw(descs, raw, (c) => {
      const [n, xs, s] = c as [number, number[], string];
      return n >= 5 && xs.length >= 2 && s.length >= 2;
    });
    expect(shrunk[0]).toBe(5);
    expect((shrunk[1] as number[]).length).toBe(2);
    expect(shrunk[1]).toEqual([0, 0]);
    expect((shrunk[2] as string).length).toBe(2);
  });

  it("formatArgs produces JSON-friendly output including NaN and Infinity", () => {
    const descs: GenDesc[] = [
      { k: "num", t: "f64" },
      { k: "num", t: "f64" },
      { k: "vec", of: { k: "num", t: "i32" }, elem: "i32" },
      { k: "map", key: { k: "str" }, val: { k: "bool" } },
    ];
    const fmt = formatArgs(descs, [NaN, -Infinity, [1, 2], [["a", true]]]);
    expect(JSON.stringify(fmt)).toBe('["NaN","-Infinity",[1,2],[["a",true]]]');
  });
});
