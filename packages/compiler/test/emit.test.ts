// JS backend (SPEC §10) and the run / test entries, beyond what conformance/run covers.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as rt from "../../runtime-js/src/index.ts";
import { instantiateWasmAsync } from "../../runtime-js/src/wasm-bridge.ts";
import { check, run, runTestFile } from "../src/index.ts";
import { loadCases } from "./harness.ts";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "szigyr-emit-"));
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  return join(dir, "main.szigyr");
}

describe("run", () => {
  it("links relative and npm imports, drops test(...), checks compound element writes", async () => {
    const main = project({
      "main.szigyr": `import { twice } from "./lib.szigyr";
import { triple } from "npm:fakepkg";
export function main(sys: System): void {
  const r = sys.js.call(triple, [sys.js.encode<f64>(2)]);
  if (r.kind === "ok") {
    const d = sys.js.decode<f64>(r.value);
    if (d.kind === "ok") {
      sys.log.info(\`\${twice(d.value)}\`);
    }
  }
  const xs: Array<i32> = [1, 2];
  xs[1] += 5;
  sys.log.info(\`\${xs[1]}\`);
  xs[2] += 1;
}
test("not registered by run", (t: Test) => {
  t.ok(false);
});
`,
      "lib.szigyr": "export function twice(x: f64): f64 {\n  return x * 2;\n}\n",
      "node_modules/fakepkg/package.json": JSON.stringify({ name: "fakepkg", type: "module", main: "index.js" }),
      "node_modules/fakepkg/index.js": "export const triple = (x) => x * 3;\n",
    });
    const r = await run(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("12\n7\n");
    expect(r.trap).toMatchObject({ code: "T002", line: 14, col: 6 });
  });

  it("keeps user names visible in compound right sides and ensures predicates; exports only values", async () => {
    const main = project({
      "main.szigyr": `import { bump, Box } from "./lib.szigyr";
export function main(sys: System): void {
  const xs: Array<i32> = [1, 2];
  const o: i32 = 10;
  const k: i32 = 20;
  const v: i32 = 30;
  xs[0] += o + k + v;
  const b: Box = { total: 1 };
  bump(b, 5);
  sys.log.info(\`\${xs[0]} \${b.total} \${atLeast(3, 2)}\`);
  sys.log.info(\`\${atLeast(3, 5)}\`);
}
function atLeast(x: i32, r: i32): i32 {
  ensures((out: i32) => out >= r);
  return x;
}
`,
      "lib.szigyr": `type Box = { total: i32 };
export { Box };
export function bump(o: Box, v: i32): void {
  o.total += v;
}
`,
    });
    const r = await run(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("61 6 3\n");
    expect(r.trap).toMatchObject({ code: "T005", line: 14, col: 3 });
  });
});

describe("run: await and JS exceptions", () => {
  it("compound assignment to an element or property with await on the right, left to right", async () => {
    const main = project({
      "main.szigyr": `class Acc {
  n: i32;
  constructor(n: i32) {
    this.n = n;
  }
}
async function g(log: Log, x: i32): Promise<i32> {
  log.info(\`g\${x}\`);
  return x;
}
function idx(log: Log): usize {
  log.info("idx");
  return 0;
}
export async function main(sys: System): Promise<void> {
  const xs: Array<i32> = [1, 2];
  xs[idx(sys.log)] += await g(sys.log, 5);
  const a = new Acc(10);
  a.n += await g(sys.log, 7);
  const fs: Array<f32> = [0.5];
  fs[0] *= f32(await g(sys.log, 3));
  sys.log.info(\`\${xs[0]} \${a.n} \${fs[0]}\`);
  xs[1] += await g(sys.log, 2147483647);
}
`,
    });
    const r = await run(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("idx\ng5\ng7\ng3\n6 17 1.5\ng2147483647\n");
    expect(r.trap).toMatchObject({ code: "T001", line: 23, col: 9 });
  });

  it("an isolate trap surfaces at the next await of any promise, on both backends (§15.4 (2))", async () => {
    const main = project({
      "main.szigyr": `import { later } from "npm:laterpkg";
function boom(port: Port<i32, i32>): void {
  panic("boom");
}
export async function main(sys: System): Promise<void> {
  const p = sys.spawn.isolate(boom);
  const t = sys.js.call(later, []);
  if (t.kind === "ok") {
    const r = await sys.js.await(t.value);
  }
  sys.log.info("after");
}
`,
      "node_modules/laterpkg/package.json": JSON.stringify({ name: "laterpkg", type: "module", main: "index.js" }),
      // generous: the isolate only has to start and trap within this time
      "node_modules/laterpkg/index.js": "export const later = () => new Promise((r) => setTimeout(r, 3000));\n",
    });
    for (const backend of ["js", "c"] as const) {
      const r = await run(main, { backend });
      expect(r.diagnostics).toEqual([]);
      expect([backend, r.stdout]).toEqual([backend, ""]);
      expect(r.trap).toMatchObject({ code: "T006", line: 3, col: 3 });
    }
  }, 120000);

  it("an isolate resolves each npm: import from the importing module's own directory", async () => {
    const main = project({
      "main.szigyr": `import { tripled } from "./sub/lib.szigyr";
function echo(port: Port<f64, f64>): void {
  port.send(2);
}
export async function main(sys: System): Promise<void> {
  const p = sys.spawn.isolate(echo);
  const x = await p.recv();
  if (x !== null) {
    sys.log.info(\`\${tripled(sys.js, x)}\`);
  }
}
`,
      "sub/lib.szigyr": `import { triple } from "npm:subpkg";
export function tripled(js: Js, x: f64): f64 {
  const r = js.call(triple, [js.encode<f64>(x)]);
  if (r.kind === "ok") {
    const d = js.decode<f64>(r.value);
    if (d.kind === "ok") {
      return d.value;
    }
  }
  return -1;
}
`,
      "sub/node_modules/subpkg/package.json": JSON.stringify({ name: "subpkg", type: "module", main: "index.js" }),
      "sub/node_modules/subpkg/index.js": "export const triple = (x) => x * 3;\n",
    });
    const r = await run(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.trap).toBeNull();
    expect(r.stdout).toBe("6\n");
  }, 120000);
});

describe("Q035: JS exceptions and stack exhaustion are T006 at the callee name", () => {
  it("in tests", async () => {
    const main = project({
      "main.szigyr": `function deep(n: f64): f64 {
  return deep(n + 1) + 1;
}
test("fromCodePoint", (t: Test) => {
  const s: string = String.fromCodePoint(1114112);
});
test("padStart", (t: Test) => {
  const s: string = "x".padStart(4294967295, "y");
});
test("deep", (t: Test) => {
  t.eq(deep(0), 0);
});
test("traps sees T006", (t: Test) => {
  t.traps("T006", () => {
    deep(0);
  });
  t.eq(JSON.parse("1"), JSON.parse("1"));
  t.eq(JSON.parse("{").kind, "err");
});
test("repeat", (t: Test) => {
  const s: string = "x".repeat(4294967295);
});
`,
    });
    const r = await runTestFile(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.results.map((x) => [x.name, x.ok, x.trap?.code, x.trap?.pos?.line, x.trap?.pos?.col])).toEqual([
      ["fromCodePoint", false, "T006", 5, 28],
      ["padStart", false, "T006", 8, 25],
      ["deep", false, "T006", 2, 10],
      ["traps sees T006", true, undefined, undefined, undefined],
      ["repeat", false, "T006", 21, 25],
    ]);
  });

  it("in run: stack exhaustion through a method", async () => {
    const main = project({
      "main.szigyr": `class R {
  down(n: f64): f64 {
    return this.down(n + 1);
  }
}
export function main(sys: System): void {
  sys.log.info("before");
  const r = new R();
  sys.log.info(\`\${r.down(0)}\`);
}
`,
    });
    const r = await run(main);
    expect(r.stdout).toBe("before\n");
    expect(r.trap).toMatchObject({ code: "T006", line: 3, col: 17 });
  });
});

describe("runTestFile", () => {
  it("reports passing, failing and trapping tests", async () => {
    const main = project({
      "main.szigyr": `function f(x: i32): i32 {
  return x + 1;
}
test("passes", (t: Test) => {
  t.eq(f(1), 2);
  t.traps("T001", () => {
    f(2147483647);
  });
});
test("fails", (t: Test) => {
  t.eq(f(1), 3);
});
test("traps", (t: Test) => {
  const m: i32 = 2147483647;
  t.eq(f(m), 0);
});
`,
    });
    const r = await runTestFile(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.results.map((x) => [x.name, x.ok])).toEqual([["passes", true], ["fails", false], ["traps", false]]);
    expect(r.results[1]!.pos).toMatchObject({ line: 11, col: 5 });
    expect(r.results[2]!.trap).toMatchObject({ code: "T001", pos: { line: 2, col: 12 } });
  });

  // Goal: every stage-1 accept case with test(...) passes its own tests.
  const root = fileURLToPath(new URL("../../../conformance", import.meta.url));
  const cases = loadCases(root).filter((c) => c.kind === "accept" && c.stage <= 1 && /\btest\(/.test(readFileSync(c.entry, "utf8")));
  it.each(cases.map((c) => [c.name, c.entry]))("%s", async (_name, entry) => {
    const r = await runTestFile(entry);
    expect(r.diagnostics).toEqual([]);
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
  });
});

describe("D060: Js boundary, optional chains, cycles, JS limits, concurrent runs", () => {
  it("js.encode refuses a function, so no Szigyr code can run inside js.call (Q128); the boundary guard is tested in std", async () => {
    const main = project({
      "main.szigyr": `export function main(sys: System): void {
  const f = sys.js.encode<() => void>((): void => {
    panic("x");
  });
  sys.log.info(sys.js.call(f, []).kind);
}
`,
    });
    const r = await run(main);
    expect(r.diagnostics.map((d) => d.code)).toContain("E2002");
    expect(r.trap).toBeNull();
  });

  it("`?.` on rewritten member calls short-circuits on null", async () => {
    const main = project({
      "main.szigyr": `function show(x: u16 | null): string {
  return x === null ? "null" : \`\${x}\`;
}
function showS(x: string | null): string {
  return x === null ? "null" : "str";
}
function go(sys: System, n: string | null, s: string | null): void {
  sys.log.info(show(n?.charCodeAt(0)));
  sys.log.info(show(s?.charCodeAt(1)));
  sys.log.info(showS(n?.padStart(4294967295, "y")));
  sys.log.info(showS(s?.padStart(4294967295, "y")));
}
export function main(sys: System): void {
  go(sys, null, "ab");
}
`,
    });
    const r = await run(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("null\n98\nnull\n");
    expect(r.trap).toMatchObject({ code: "T006", line: 11 });
  });

  it("a negative zero literal of an integer type is +0 (Q090)", async () => {
    const main = project({
      "main.szigyr": `export function main(sys: System): void {
  const z: i32 = -0;
  const f: f64 = -0;
  sys.log.info(\`\${1 / f64(z)} \${1 / f}\`);
  const p = JSON.parse("-0");
  if (p.kind === "ok") {
    const c = cast<i32>(p.value);
    sys.log.info(c.kind);
  }
}
`,
    });
    const r = await run(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("Infinity -Infinity\nerr\n");
  });

  it("-0 is +0 in every integer context (Q090)", async () => {
    const main = project({
      "main.szigyr": `type Box = { v: u32 };
function inv(x: f64): f64 {
  return 1 / x;
}
function invU(x: u32): f64 {
  return 1 / f64(x);
}
function ret(): usize {
  return -0;
}
function pick(c: boolean): u8 {
  return c ? -0 : 1;
}
export function main(sys: System): void {
  const u: u32 = -0;
  const s: usize = -0;
  const b: u8 = -0;
  const h: i16 = -0x0;
  const box: Box = { v: -0 };
  const xs: Array<u16> = [-0];
  const out: Array<f64> = [invU(u), inv(f64(s)), inv(f64(b)), inv(f64(h)), invU(box.v), inv(f64(xs[0])), invU(-0), inv(f64(ret())), inv(f64(pick(true)))];
  sys.log.info(out.join(","));
}
`,
    });
    const r = await run(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("Infinity,Infinity,Infinity,Infinity,Infinity,Infinity,Infinity,Infinity,Infinity\n");
  });

  it("an import cycle sees the function declarations of the other module (Q100)", async () => {
    const main = project({
      "main.szigyr": `import { isEven } from "./even.szigyr";
export function main(sys: System): void {
  sys.log.info(\`\${isEven(10)} \${isEven(7)}\`);
}
`,
      "even.szigyr": `import { isOdd } from "./odd.szigyr";
export function isEven(n: i32): boolean {
  return n === 0 ? true : isOdd(n - 1);
}
`,
      "odd.szigyr": `import { isEven } from "./even.szigyr";
export function isOdd(n: i32): boolean {
  return n === 0 ? false : isEven(n - 1);
}
`,
    });
    const r = await run(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("true false\n");
  });

  it("JS RangeErrors from syntax no builtin wraps are T006 (Q035)", async () => {
    const main = project({
      "main.szigyr": `function grow(s: string, n: i32): string {
  return n === 0 ? s : grow(\`\${s}\${s}\`, n - 1);
}
export function main(sys: System): void {
  sys.log.info("start");
  const big: string = grow("ab", 40);
  sys.log.info(\`\${big}!\`);
}
`,
    });
    const r = await run(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("start\n");
    expect(r.trap).toMatchObject({ code: "T006" });
  });

  it("runs started together do not mix their traps or output", async () => {
    const mk = (n: number) => project({
      "main.szigyr": `export function main(sys: System): void {
  sys.log.info("${n}");
${"\n".repeat(n)}  panic("x");
}
`,
    });
    const [a, b, c] = await Promise.all([run(mk(1)), run(mk(5)), run(mk(9))]);
    expect([a, b, c].map((r) => [r.stdout, r.trap?.code, r.trap?.line])).toEqual([["1\n", "T006", 4], ["5\n", "T006", 8], ["9\n", "T006", 12]]);
  });
});

// Q130 rejects a floating Promise in the source, so the Q140 host fallback is tested in packages/std/test/std.test.ts.
it("a Promise that is neither awaited nor returned is E2002 (Q130)", () => {
  const main = project({
    "main.szigyr": `async function g(): Promise<void> {
  panic("late");
}
export function main(sys: System): void {
  const p = g();
  sys.log.info("done");
}
test("floating", (t: Test) => {
  const q = g();
  t.ok(true);
});
`,
  });
  expect(check(main).map((d) => `${d.code} ${d.range.start.line}:${d.range.start.col}`)).toEqual(["E2002 5:13", "E2002 9:13"]);
});

// 1B null fixed layout (SPEC-v1 §3.3): Pool<null> and Arena.alloc<null> check cleanly in rt code.
it("Pool<null> and Arena.alloc<null> check cleanly in rt code (1B null layout)", () => {
  for (const body of ["const p = Pool.create<null>(sys.alloc, 4);\n  sys.log.info(`${go(p)}`);", "const a = Arena.create(sys.alloc, 64);\n  sys.log.info(`${go2(a)}`);"]) {
    const main = project({
      "main.szigyr": `function go(p: Mut<Pool<null>>): usize {\n  "use rt";\n  const h = p.insert(null);\n  return p.length;\n}\nfunction go2(a: Mut<Arena>): usize {\n  "use rt";\n  const b = a.alloc<null>(2, null);\n  return a.remaining;\n}\nexport function main(sys: System): void {\n  ${body}\n}\n`,
    });
    expect(check(main)).toEqual([]);
  }
});

describe("C Arena (D116, Q246)", () => {
  it("a reset in C drops the notes of earlier generations: only live bufs are replayed at the boundary exit", async () => {
    const main = project({
      "main.szigyr": `function churn(a: Mut<Arena>, n: i32): usize {
  "use rt";
  let last: usize = 0;
  for (let i: i32 = 0; i < n; i += 1) {
    a.reset();
    const b = a.alloc<f32>(4, 1);
    if (b !== null) { last = b.length; }
  }
  return last;
}
export function main(sys: System): void {
  const a = Arena.create(sys.alloc, 64);
  sys.log.info(\`\${churn(a, 1000)} \${a.remaining}\`);
}
`,
    });
    const proto = rt.Arena.prototype as unknown as { noteC: (...a: unknown[]) => void };
    const orig = proto.noteC;
    let notes = 0;
    proto.noteC = function (this: unknown, ...a: unknown[]) { notes++; return orig.apply(this, a); };
    try {
      for (const backend of ["js", "c"] as const) {
        const r = await run(main, { backend });
        expect(r.trap).toBeNull();
        expect(r.stdout).toBe("4 48\n");
      }
    } finally { proto.noteC = orig; }
    expect(notes).toBe(1);
  }, 120000);
});

describe("Batch D: using trap unwinding & AudioStream AsyncDisposable", () => {
  it("unwinds nested Resource.ownWith cleanups in LIFO order on trap across js, c, and wasm", async () => {
    const main = project({
      "main.szigyr": `type Tag = "a" | "b";
type Item = Struct<{ id: Tag; n: i32 }>;
function freeItem(log: Log, it: Item): void {
  "use owned";
  log.info(it.id);
}
function boom(log: Log): void {
  "use owned";
  using a = Resource.ownWith<Item, Log>({ id: "a", n: 1 }, log, freeItem);
  using b = Resource.ownWith<Item, Log>({ id: "b", n: 2 }, log, freeItem);
  if (a.borrow().n === 1 && b.borrow().n === 2) {
    panic("trap!");
  }
}
export function main(sys: System): void {
  boom(sys.log);
}
`,
    });
    for (const backend of ["js", "c", "wasm"] as const) {
      const r = await run(main, { backend });
      expect(r.diagnostics).toEqual([]);
      expect(r.trap).toMatchObject({ code: "T006" });
      expect(r.stdout).toBe("b\na\n");
    }
  }, 120000);

  it("closes FakeAudio AudioStream on exiting `await using` block across js, c, and wasm", async () => {
    const main = project({
      "main.szigyr": `function render(st: f64, out: Mut<Slice<f32>>, frames: usize): void {
  "use rt";
  for (let i: usize = 0; i < frames; i += 1) {
    out[i] = f32(st);
  }
}
export async function main(sys: System): Promise<void> {
  const fa = FakeAudio.create();
  const r = await fa.open({ sampleRate: 48000, channels: 1 }, 0, render);
  if (r.kind === "ok") {
    const ref = r.value;
    {
      await using stream = ref;
      sys.log.info(\`in:\${stream.isOpen()}\`);
    }
    sys.log.info(\`out:\${ref.isOpen()}\`);
  }
}
`,
    });
    for (const backend of ["js", "c", "wasm"] as const) {
      const r = await run(main, { backend });
      expect(r.diagnostics).toEqual([]);
      expect(r.trap).toBeNull();
      expect(r.stdout).toBe("in:true\nout:false\n");
    }
  }, 120000);
});

describe("string-literal union members and numeric fast paths", () => {
  it("allows string members on string-literal unions and reports E2001 on invalid members", async () => {
    const okMain = project({
      "main.szigyr": `type Cat = "firewall" | "gpu";
function inspect(c: Cat, maybe: Cat | null): string {
  const idx = c.indexOf("w");
  const mlen = maybe?.length ?? usize(0);
  return \`\${c.length}:\${c.startsWith("fire")}:\${idx === null ? 99 : idx}:\${c.charCodeAt(0)}:\${mlen}\`;
}
export function main(sys: System): void {
  sys.log.info(inspect("firewall", "gpu"));
  sys.log.info(inspect("gpu", null));
}
`,
    });
    const r = await run(okMain);
    expect(r.diagnostics).toEqual([]);
    expect(r.trap).toBeNull();
    expect(r.stdout).toBe("8:true:4:102:3\n3:false:99:103:0\n");

    const badMain = project({
      "main.szigyr": `type Cat = "a" | "b";
export function f(c: Cat): string {
  return c.charAt(0);
}
`,
    });
    const ds = check(badMain);
    expect(ds.map((d) => d.code)).toContain("E2001");
    expect(ds.find((d) => d.code === "E2001")?.data?.suggestions).toEqual(["slice", "charCodeAt"]);
  });

  it("preserves numeric fast-path execution and trap fidelity", async () => {
    const okAndTrap = project({
      "main.szigyr": `function widenAll(b: u8, n: u32): string {
  const a1: u32 = u32(b);
  const a2: usize = usize(b);
  const a3: i32 = i32(b);
  const a4: f64 = f64(b);
  const a5: f32 = f32(b);
  const a6: i64 = i64(b);
  const a7: u64 = u64(b);
  const a8: usize = usize(n);
  const a9: u32 = u32(a8);
  const c1: u32 = u32(0x7f);
  const c2: u32 = u32(-0);
  const c3: i8 = i8(-128);
  return \`\${a1},\${a2},\${a3},\${a4},\${a5},\${a6},\${a7},\${a9},\${c1},\${c2},\${c3}\`;
}
function narrowU8(x: u16): u8 {
  return u8(x);
}
export function main(sys: System): void {
  sys.log.info(widenAll(200, 4000000000));
  sys.log.info(\`\${narrowU8(255)}\`);
}
test("traps on out-of-range casts and 32-bit overflows", (t: Test) => {
  t.traps("T003", () => { const _ = u8(256); });
  t.traps("T003", () => { const _ = u32(-1); });
  t.traps("T003", () => { const _ = i32(1.5); });
  t.traps("T003", () => { const _ = i64(9223372036854775807.0); });
  t.traps("T003", () => { const _ = narrowU8(256); });
  t.traps("T001", () => { const a: i32 = 2147483647; const _ = a + 1; });
  t.traps("T001", () => { const a: u8 = 0; const _ = a - 1; });
  t.traps("T001", () => { const a: i16 = 300; const _ = a * 200; });
  t.traps("T001", () => { const a: i8 = -128; const _ = -a; });
  t.traps("T001", () => { let a: u8 = 250; a += 10; });
});
`,
    });
    const r = await run(okAndTrap);
    expect(r.diagnostics).toEqual([]);
    expect(r.trap).toBeNull();
    expect(r.stdout).toBe("200,200,200,200,200,200,200,4000000000,127,0,-128\n255\n");
    const tr = await runTestFile(okAndTrap);
    expect(tr.diagnostics).toEqual([]);
    expect(tr.results.map((x) => x.ok)).toEqual([true]);

    const trapCases: [string, string, number, number][] = [
      ["export function main(sys: System): void {\n  const x: u16 = 256;\n  sys.log.info(`${u8(x)}`);\n}", "T003", 3, 19],
      ["export function main(sys: System): void {\n  const x: i32 = 2147483647;\n  sys.log.info(`${x + 1}`);\n}", "T001", 3, 21],
      ["export function main(sys: System): void {\n  const x: u8 = 0;\n  sys.log.info(`${x - 1}`);\n}", "T001", 3, 21],
      ["export function main(sys: System): void {\n  const x: i16 = 300;\n  sys.log.info(`${x * 200}`);\n}", "T001", 3, 21],
      ["export function main(sys: System): void {\n  const x: i8 = -128;\n  sys.log.info(`${-x}`);\n}", "T001", 3, 19],
      ["export function main(sys: System): void {\n  let x: u8 = 250;\n  x += 10;\n  sys.log.info(`${x}`);\n}", "T001", 3, 5],
    ];
    for (const [src, code, line, col] of trapCases) {
      const m = project({ "main.szigyr": src });
      const res = await run(m);
      expect(res.diagnostics).toEqual([]);
      expect(res.trap).toMatchObject({ code, line, col });
    }
  });

  it("#10 & #11 regressions: C/Wasm === null side effects, multi-using trap unwinding, wasm audio OOM cap reset, isolate port.close vs trap, and generic Ring across isolate", async () => {
    // 1) === null / null === expr side effects & inner-cleanup trap still unwinds outer using and keeps first trap (JS, C, Wasm)
    const strictNullAndDefer = project({
      "main.szigyr": `type Msg = "clean:1" | "clean:2";
type Tag = Struct<{ id: i32 }>;
function logMsg(log: Log, m: Msg): void {
  "use owned";
  log.info(m);
}
function recordAndNull(v: Mut<Vec<i32>>, n: i32): i32 | null {
  "use owned";
  v.push(n);
  return null;
}
export function testNullSides(alloc: Alloc): usize {
  "use owned";
  const v = Vec.create<i32>(alloc, 4);
  const a = recordAndNull(v, 10) === null;
  const b = null === recordAndNull(v, 20);
  return a && b ? v.length : 0;
}
function cleanupWithTrace(log: Log, tag: Tag): void {
  "use owned";
  if (tag.id === 1) {
    logMsg(log, "clean:1");
  } else {
    logMsg(log, "clean:2");
    const m: i32 = 2147483647;
    const _ov = m + 1; // T001 inside inner cleanup!
    if (_ov === 0) logMsg(log, "clean:2");
  }
}
export function runMultiDeferTrap(log: Log): i32 {
  "use owned";
  using _outer = Resource.ownWith<Tag, Log>({ id: 1 }, log, cleanupWithTrace);
  using _inner = Resource.ownWith<Tag, Log>({ id: 2 }, log, cleanupWithTrace);
  const z: i32 = 0;
  return divTrunc(1, z); // T007 primary trap!
}
export function main(sys: System): void {
  sys.log.info(\`sides:\${testNullSides(sys.alloc)}\`);
  const _boom = runMultiDeferTrap(sys.log);
  sys.log.info(\`done:\${_boom}\`);
}
`,
    });
    for (const backend of ["js", "c", "wasm"] as const) {
      const rDefer = await run(strictNullAndDefer, { backend });
      expect(rDefer.diagnostics, backend).toEqual([]);
      expect(rDefer.stdout, backend).toBe("sides:2\nclean:2\nclean:1\n");
      expect(rDefer.trap, backend).toMatchObject({ code: "T007" });
    }

    // 2) wasm-bridge audio.render allocation failure resets outCap cleanly instead of writing to ptr 0 on next call
    let allocCount = 0;
    const mem = new WebAssembly.Memory({ initial: 1 });
    const mockInst = {
      exports: {
        memory: mem,
        __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, 4096),
        sz_alloc: (n: number) => (++allocCount === 1 ? 0 : 128),
        sz_dealloc: () => {},
        sz_empty_ptr: () => 16,
        sz_get_depth: () => 0,
        sz_set_depth: () => {},
        sz_defer_enter: () => 0,
        sz_defer_step: () => 0,
        sz_defer_leave: () => {},
        sz_nvecs_get: () => 0,
        sz_npools_get: () => 0,
        sz_narenas_get: () => 0,
        sz_sync_frame: () => {},
        sz_run_wb: () => {},
        aud_render: () => {},
      },
    } as unknown as WebAssembly.Instance;
    const origInstantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = (async () => ({ instance: mockInst })) as unknown as typeof WebAssembly.instantiate;
    try {
      const api = await instantiateWasmAsync(
        new Uint8Array([0]),
        { files: [], poss: [], lits: [], fns: {}, audio: { a: { init: "aud_init", render: "aud_render", free: "aud_free" } } },
        rt.NATIVE_HOST,
      );
      const audio = api.sz_audio_a as unknown as { render(box: number, out: Float32Array, n: number): void };
      expect(() => audio.render(0, new Float32Array(2), 1)).toThrow("out of memory");
      expect(() => audio.render(0, new Float32Array(2), 1)).not.toThrow();
      expect(allocCount).toBe(2);
    } finally {
      WebAssembly.instantiate = origInstantiate;
    }

    // 3) #11: isolate calling port.close() before trapping still surfaces trap to main, & generic Ring.create<T> works across isolate
    const isoFile = project({
      "main.szigyr": `function workerTrapAfterClose(port: Port<i32, i32>): void {
  port.close();
  panic("after-close-trap");
}
export async function main(sys: System): Promise<void> {
  const p = sys.spawn.isolate(workerTrapAfterClose);
  const _v = await p.recv();
  await sys.clock.sleep(30);
  sys.log.info(\`got:\${_v === null ? "null" : "val"}\`);
}
`,
    });
    const rTrapIso = await run(isoFile);
    expect(rTrapIso.diagnostics).toEqual([]);
    expect(rTrapIso.trap).toMatchObject({ code: "T006" });

    const ringIso = project({
      "main.szigyr": `function makeG<T extends Copy & Native & Send>(alloc: Alloc, cap: usize): RingPair<T> {
  "use owned";
  return Ring.create<T>(alloc, cap);
}
async function workerPush(port: Port<i32, RingTx<i32>>): Promise<void> {
  const tx = await port.recv();
  if (tx === null) return;
  tx.push(42);
  port.send(0);
}
export async function main(sys: System): Promise<void> {
  const { tx, rx } = makeG<i32>(sys.alloc, 4);
  const p = sys.spawn.isolate(workerPush);
  p.send(tx);
  const _done = await p.recv();
  const res = rx.pop();
  sys.log.info(\`ring:\${res ?? -1}\`);
}
`,
    });
    const rRingIso = await run(ringIso);
    expect(rRingIso.diagnostics).toEqual([]);
    expect(rRingIso.trap).toBeNull();
    expect(rRingIso.stdout.trim()).toBe("ring:42");

    // Queue-mode Ring<T> without concrete element type cannot be split over Port.send
    const { tx: unTx } = rt.Ring.create<number>(rt.NATIVE_HOST, 4);
    const dummyPort = new rt.Port({
      post() {},
      onMessage() {},
      onClose() {},
      close() {},
    });
    expect(() => dummyPort.send(unTx)).toThrow(/cannot split a queue-mode Ring/);
  }, 60_000);
});
