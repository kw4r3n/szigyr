import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CLI_NAME } from "../src/names.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const CONF = new URL("../../../conformance/", import.meta.url).pathname;
const sts = (...a: string[]) => { const r = spawnSync("node", [CLI, ...a], { encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const jsonLines = (s: string): any[] => s.trim().split("\n").map((l) => JSON.parse(l));

it("check --json prints one JSON diagnostic per line and exits 1", () => {
  const r = sts("check", "--json", `${CONF}reject/E2003-default-f64-let-vs-usize.ts`);
  expect(r.code).toBe(1);
  const [d] = jsonLines(r.out);
  expect(d).toMatchObject({ code: "E2003", range: { start: { line: 6, col: 12 } } });
});

it("check exits 0 with no output on an accepted file", () => {
  expect(sts("check", `${CONF}accept/02-record-readonly.ts`)).toEqual({ code: 0, out: "", err: "" });
});

it("run passes the program's stdout through", () => {
  const r = sts("run", `${CONF}run/01-arith-basic.ts`);
  expect(r.code).toBe(0);
  expect(r.out).toContain("22");
});

it("run exits 3 on a trap and reports it as JSON on stderr (Q060)", () => {
  const r = sts("run", "--json", `${CONF}run/26-trap-div-by-zero.ts`);
  expect(r.code).toBe(3);
  expect(jsonLines(r.err)[0]).toMatchObject({ kind: "trap", code: "T007" });
});

it("run exits 1 with diagnostics on stderr and empty stdout when the file does not check", () => {
  const r = sts("run", "--json", `${CONF}reject/E1001-var-in-function.ts`);
  expect(r).toMatchObject({ code: 1, out: "" });
  expect(jsonLines(r.err)[0].code).toBe("E1001");
});

it("test reports each test and a summary; failures exit 1", () => {
  const ok = sts("test", "--json", `${CONF}accept/02-record-readonly.ts`);
  expect(ok.code).toBe(0);
  expect(jsonLines(ok.out)).toEqual([
    expect.objectContaining({ kind: "test", name: "records", ok: true }),
    { kind: "summary", passed: 1, failed: 0 },
  ]);
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "t.ts"), 'test("bad", (t: Test) => {\n  t.ok(false);\n});\n');
  const bad = sts("test", "--json", join(dir, "t.ts"));
  expect(bad.code).toBe(1);
  expect(jsonLines(bad.out)[0]).toMatchObject({ kind: "test", name: "bad", ok: false });
});

it("usage errors and missing files exit 2 with a message", () => {
  for (const a of [[], ["nope"], ["check"], ["check", "/no/such.ts"], ["run", "--bogus", "x"]]) {
    const r = sts(...a);
    expect(r.code).toBe(2);
    expect(r.err).toContain(CLI_NAME);
  }
});

it("run without an exported main is a CLI error, exit 2 (Q061)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "m.ts"), "export function f(): void {}\n");
  expect(sts("run", join(dir, "m.ts")).code).toBe(2);
});

// D101-D103: the same tests under the JS and the C backend. A trap in C is the same JS trap, `Mut` writes reach the caller,
// and a Vec grown in C is the same JS object with the new buffer.
const BOTH = `type Acc = Struct<{ n: i32; total: i32 }>;
function addAll(a: Mut<Acc>, s: Ref<Slice<i32>>): void {
  "use rt";
  for (let i: usize = 0; i < s.length; i += 1) {
    a.n += 1;
    a.total += s[i];
  }
}
function grow(v: Mut<Vec<i32>>, n: i32): void {
  "use owned";
  for (let i: i32 = 0; i < n; i += 1) {
    v.push(i);
  }
}
test("growth, writes and traps", (t: Test) => {
  const v = Vec.create<i32>(TestAlloc.create(), 1);
  grow(v, 9);
  t.eq(v.length, 9);
  t.eq(v[8], 8);
  const a: Acc = { n: 0, total: 0 };
  addAll(a, v.slice(2, 5));
  t.eq(a.n, 3);
  t.eq(a.total, 9);
  t.traps("T001", () => {
    const w = Vec.create<i32>(TestAlloc.create(), 2);
    w.push(2147483647);
    w.push(1);
    const b: Acc = { n: 0, total: 0 };
    addAll(b, w);
  });
});
test("a failing test fails on both", (t: Test) => {
  const a: Acc = { n: 0, total: 0 };
  const v = Vec.create<i32>(TestAlloc.create(), 1);
  v.push(5);
  addAll(a, v);
  t.eq(a.total, 6);
});
`;

it("test --backend=both runs each test under JS and C and agrees", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-both-`));
  const f = join(dir, "both.ts");
  writeFileSync(f, BOTH);
  const r = sts("test", "--json", "--backend=both", f);
  const ls = jsonLines(r.out);
  expect(ls.filter((l) => l.kind === "mismatch")).toEqual([]);
  expect(ls.at(-1)).toEqual({ kind: "summary", passed: 1, failed: 1 });
  expect(r.code).toBe(1);
});

it("run --backend=c stops with an internal error on an unsupported construct", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-unsup-`));
  const f = join(dir, "unsup.ts");
  // A switch over a floating-point value is SPEC-legal but not translated to C yet.
  writeFileSync(f, `function g(x: f64): i32 {\n  "use rt";\n  switch (x) {\n    case 1.5: return 1;\n    default: return 0;\n  }\n}\nexport function main(sys: System): void {\n  sys.log.info(\`\${g(1.5)}\`);\n}\n`);
  const ok = sts("run", f);
  expect(ok.out.trim()).toBe("1");
  const r = sts("run", "--backend=c", f);
  expect(r.code).toBe(2);
  expect(r.err).toMatch(/C backend: .* not supported/);
});
