import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { check, CLI_NAME, run, runTestFile } from "../src/index.ts";

const tmpRoots: string[] = [];
function makeTmp(prefix = `${CLI_NAME}-p3-`): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function writeTmp(dir: string, rel: string, src: string): string {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, src);
  return p;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("Phase 3: Result<Owned, E> and OwnedCell.withRef / withMut", () => {
  it("runs Result<Owned, Native> and OwnedCell.withMut struct writeback identically on js, c, and wasm", async () => {
    const dir = makeTmp();
    const f = writeTmp(
      dir,
      "parity.szigyr",
      [
        `type BufBox = Struct<{ data: Vec<f32>; n: u32 }>;`,
        ``,
        `function bumpBox(b: Mut<BufBox>): f32 {`,
        `  "use rt";`,
        `  b.n += 1;`,
        `  b.data[0] = b.data[0] + f32(b.n);`,
        `  return b.data[0];`,
        `}`,
        ``,
        `function readBox(b: Ref<BufBox>): u32 {`,
        `  "use rt";`,
        `  return b.n + u32(b.data.length);`,
        `}`,
        ``,
        `function mkBox(alloc: Alloc, okFlag: boolean): Result<BufBox, "bad" | "oom"> {`,
        `  "use owned";`,
        `  if (!okFlag) return err("bad");`,
        `  const v = Vec.create<f32>(alloc, 2);`,
        `  v.push(2.0);`,
        `  v.push(4.0);`,
        `  return ok({ data: v, n: 5 });`,
        `}`,
        ``,
        `function rtTransform(): Result<BufBox, i32> {`,
        `  "use rt";`,
        `  return err(-7);`,
        `}`,
        ``,
        `export function main(sys: System): void {`,
        `  const r = mkBox(sys.alloc, true);`,
        `  if (r.kind === "err") panic("no");`,
        `  const b0 = bumpBox(r.value);`,
        `  r.value.n += 2;`,
        `  const moved = r.value;`,
        ``,
        `  const rErr = mkBox(sys.alloc, false);`,
        `  const errMsg = rErr.kind === "err" ? rErr.error : "ok";`,
        ``,
        `  const rtE = rtTransform();`,
        `  const rtCode = rtE.kind === "err" ? rtE.error : 0;`,
        ``,
        `  const cellVec = Vec.create<f32>(sys.alloc, 2);`,
        `  cellVec.push(1.0);`,
        `  cellVec.push(3.0);`,
        `  const cell = OwnedCell.create<BufBox>({ data: cellVec, n: 10 });`,
        `  const cbOut = cell.withMut((bx) => {`,
        `    const v = bumpBox(bx);`,
        `    return v + f32(readBox(bx));`,
        `  });`,
        `  const persisted = cell.withRef((bx) => \`\${bx.n}:\${bx.data[0]}\`);`,
        ``,
        `  sys.log.info(\`\${b0}:\${moved.n}:\${errMsg}:\${rtCode}:\${cbOut}:\${persisted}\`);`,
        `}`,
        ``,
      ].join("\n"),
    );

    expect(check(f)).toEqual([]);
    const expected = "8:8:bad:-7:25:11:12\n";
    for (const backend of ["js", "c", "wasm"] as const) {
      const r = await run(f, { backend });
      expect(r.diagnostics, backend).toEqual([]);
      expect(r.trap, backend).toBeNull();
      expect(r.stdout, backend).toBe(expected);
    }
  });

  it("enforces soundness and layer boundaries on Result<Owned, E> and OwnedCell borrows", () => {
    const dir = makeTmp();
    const expectCode = (name: string, src: string, code: string) => {
      const p = writeTmp(dir, `${name}.szigyr`, src);
      const ds = check(p);
      expect(ds.map((d) => `${d.code}:${d.message}`), name).toContainEqual(expect.stringMatching(new RegExp(`^${code}:`)));
    };

    // Strict / rt cannot hold managed errors in Result<Owned, E>
    expectCode("strict-str-err", `export function f(a: Alloc): Result<Vec<f32>, string> { "use owned"; return err("no"); }`, "E4002");
    expectCode("rt-str-err", `export function f(r: Result<Vec<f32>, string>): i32 { "use rt"; return r.kind === "ok" ? 1 : 0; }`, "E4002");

    // Result<Owned, Native> is still banned as Struct field, Vec/Pool element, audio state, Ptr.box, module const
    expectCode("struct-field-res", `type S = Struct<{ r: Result<Vec<f32>, i32> }>;`, "E4002");
    expectCode("vec-elem-res", `export function f(a: Alloc): Vec<Result<Vec<f32>, i32>> { return Vec.create<Result<Vec<f32>, i32>>(a, 1); }`, "E4002");
    expectCode(
      "audio-res",
      `function rnd(st: Result<Vec<f32>, i32>, out: Mut<Slice<f32>>, n: usize): void { "use rt"; }\nexport async function main(sys: System): Promise<void> { const r = await sys.audio.open<Result<Vec<f32>, i32>>({ sampleRate: 48000, channels: 1 }, err(1), rnd); }`,
      "E2013",
    );
    expectCode("ptr-box-res", `export function f(a: Alloc): void { "use owned"; "use unsafe"; const p = Ptr.box<Result<Vec<f32>, i32>>(a, err(1)); }`, "E4007");
    expectCode("top-const-res", `const R: Result<Vec<f32>, i32> = err(1);`, "E5002");

    // E3007 managed containers/closures/classes still reject Result<Owned, E>
    expectCode("class-field-res", `class C { r: Result<Vec<f32>, string>; constructor() { this.r = err("e"); } }`, "E3007");
    expectCode("param-prop-res", `class C { constructor(readonly r: Result<Vec<f32>, string>) {} }`, "E3007");
    expectCode("tuple-res", `function f(): [Result<Vec<f32>, string>, i32] { return [err("e"), 0]; }`, "E3007");
    expectCode("record-res", `type R = { readonly r: Result<Vec<f32>, string> };\nfunction f(): R { return { r: err("e") }; }`, "E3007");
    expectCode("generic-fn-res", `function id<T>(x: T): T { return x; }\nfunction f(): void { const r: Result<Vec<f32>, string> = id(err("e")); }`, "E3007");

    // E3005 exclusivity
    expectCode(
      "pair-rvalue-aliasing",
      `function pair(a: Mut<Vec<f32>>, b: Mut<Vec<f32>>): void { "use rt"; }\nfunction f(a: Alloc): void { const r: Result<Vec<f32>, i32> = ok(Vec.create<f32>(a, 1)); if (r.kind === "ok") pair(r.value, r.value); }`,
      "E3005",
    );
    expectCode(
      "withmut-aliasing",
      `function pair(a: Mut<Vec<f32>>, b: Mut<Vec<f32>>): void { "use rt"; }\nfunction f(c: OwnedCell<Vec<f32>>): void { c.withMut((v) => { pair(v, v); }); }`,
      "E3005",
    );

    // OwnedCell borrow mode & async/escape/reassign checks
    expectCode("withref-byval-param", `function f(c: OwnedCell<Vec<f32>>): usize { return c.withRef((v: Vec<f32>) => v.length); }`, "E2002");
    expectCode("withref-mut-param", `function f(c: OwnedCell<Vec<f32>>): usize { return c.withRef((v: Mut<Vec<f32>>) => v.length); }`, "E2002");
    expectCode("withmut-ref-param", `function f(c: OwnedCell<Vec<f32>>): usize { return c.withMut((v: Ref<Vec<f32>>) => v.length); }`, "E2002");
    expectCode("withref-async-ret", `async function g(): Promise<usize> { return 1; }\nfunction f(c: OwnedCell<Vec<f32>>): void { const p = c.withRef((v) => g()); }`, "E2002");
    expectCode("withmut-async-arrow", `function f(c: OwnedCell<Vec<f32>>): void { const p = c.withMut(async (v) => {}); }`, "E2002");
    expectCode("withref-closure-capture", `function f(c: OwnedCell<Vec<f32>>): usize { const g = c.withRef((v) => (): usize => v.length); return g(); }`, "E3004");
    expectCode("withmut-reassign-borrow", `function f(a: Alloc, c: OwnedCell<Vec<f32>>): void { c.withMut((v) => { v = Vec.create<f32>(a, 1); }); }`, "E3004");
    expectCode("async-unannotated-borrow", `function useCb(cb: (v: Mut<Vec<f32>>) => Promise<void>): void {}\nfunction f(): void { useCb(async (v): Promise<void> => {}); }`, "E3004");
  });

  it("traps T008 on OwnedCell empty/conflicting borrows, recovers on trap, and supports Port & forAll", async () => {
    const dir = makeTmp();
    const f = writeTmp(
      dir,
      "runtime.szigyr",
      [
        `async function worker(port: Port<Result<Vec<i32>, string>, i32>): Promise<void> {`,
        `  const v = await port.recv();`,
        `  if (v === null) return;`,
        `  const alloc = TestAlloc.create();`,
        `  if (v === 0) {`,
        `    port.send(err("zero"));`,
        `    return;`,
        `  }`,
        `  const out = Vec.create<i32>(alloc, 2);`,
        `  out.push(v);`,
        `  out.push(v * 2);`,
        `  port.send(ok(out));`,
        `}`,
        ``,
        `function checkResVec(r: Result<Vec<i32>, i32>): boolean {`,
        `  if (r.kind === "ok") return r.value.length >= 0;`,
        `  return r.error === r.error;`,
        `}`,
        ``,
        `test("OwnedCell T008 borrow checks and trap recovery", (t: Test) => {`,
        `  const alloc = TestAlloc.create();`,
        `  const v = Vec.create<i32>(alloc, 4);`,
        `  v.push(10);`,
        `  const cell = OwnedCell.create<Vec<i32>>(v);`,
        ``,
        `  // Conflicting re-entrant ops trap T008`,
        `  t.traps("T008", () => {`,
        `    cell.withRef((_r) => { const _x = cell.take(); });`,
        `  });`,
        `  t.traps("T008", () => {`,
        `    cell.withRef((_r) => { cell.withMut((_m) => {}); });`,
        `  });`,
        `  t.traps("T008", () => {`,
        `    cell.withMut((_m) => { const _x = cell.take(); });`,
        `  });`,
        `  t.traps("T008", () => {`,
        `    cell.withMut((_m) => { cell.withRef((_r) => {}); });`,
        `  });`,
        `  t.traps("T008", () => {`,
        `    cell.withMut((_m) => { cell.withMut((_m2) => {}); });`,
        `  });`,
        ``,
        `  // Trap inside callback releases borrow lock via finally`,
        `  t.traps("T006", () => {`,
        `    cell.withRef((_r) => { panic("boom-ref"); });`,
        `  });`,
        `  t.traps("T006", () => {`,
        `    cell.withMut((m) => { m.push(20); panic("boom-mut"); });`,
        `  });`,
        `  t.eq(cell.withRef((r) => r.length), usize(2));`,
        `  t.eq(cell.withMut((m) => { m.push(30); return m[2]; }), 30);`,
        ``,
        `  // Empty cell traps T008 on withRef / withMut`,
        `  const taken = cell.take();`,
        `  t.eq(taken.length, usize(3));`,
        `  t.traps("T008", () => { cell.withRef((r) => r.length); });`,
        `  t.traps("T008", () => { cell.withMut((m) => m.length); });`,
        ``,
        `  // forAll on Result<Vec<i32>, i32>`,
        `  forAll(checkResVec);`,
        `});`,
        ``,
        `test("Port carrying Result<Owned, string>", async (t: Test) => {`,
        `  const sp = FakeSpawn.create();`,
        `  const port = sp.isolate(worker);`,
        `  port.send(7);`,
        `  const rep = await port.recv();`,
        `  port.close();`,
        `  t.ok(rep !== null);`,
        `  if (rep !== null) {`,
        `    t.ok(rep.kind === "ok");`,
        `    if (rep.kind === "ok") {`,
        `      t.eq(rep.value.length, usize(2));`,
        `    }`,
        `  }`,
        `});`,
        ``,
      ].join("\n"),
    );

    expect(check(f)).toEqual([]);
    const res = await runTestFile(f);
    expect(res.diagnostics).toEqual([]);
    expect(res.results).toEqual([
      { name: "OwnedCell T008 borrow checks and trap recovery", ok: true },
      { name: "Port carrying Result<Owned, string>", ok: true },
    ]);
  });
});
