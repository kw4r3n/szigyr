import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CLI_NAME } from "../src/names.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const CONF = new URL("../../../conformance/", import.meta.url).pathname;
const szigyr = (...a: string[]) => { const r = spawnSync("node", [CLI, ...a], { encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const jsonLines = (s: string): any[] => s.trim().split("\n").map((l) => JSON.parse(l));

it("check --json prints one JSON diagnostic per line and exits 1", () => {
  const r = szigyr("check", "--json", `${CONF}reject/E2003-default-f64-let-vs-usize.szigyr`);
  expect(r.code).toBe(1);
  const [d] = jsonLines(r.out);
  expect(d).toMatchObject({ code: "E2003", range: { start: { line: 6, col: 12 } } });
});

it("check exits 0 with no output on an accepted file", () => {
  expect(szigyr("check", `${CONF}accept/02-record-readonly.szigyr`)).toEqual({ code: 0, out: "", err: "" });
});

it("run passes the program's stdout through", () => {
  const r = szigyr("run", `${CONF}run/01-arith-basic.szigyr`);
  expect(r.code).toBe(0);
  expect(r.out).toContain("22");
});

it("run exits 3 on a trap and reports it as JSON on stderr (Q060)", () => {
  const r = szigyr("run", "--json", `${CONF}run/26-trap-div-by-zero.szigyr`);
  expect(r.code).toBe(3);
  expect(jsonLines(r.err)[0]).toMatchObject({ kind: "trap", code: "T007" });
});

it("run exits 1 with diagnostics on stderr and empty stdout when the file does not check", () => {
  const r = szigyr("run", "--json", `${CONF}reject/E1001-var-in-function.szigyr`);
  expect(r).toMatchObject({ code: 1, out: "" });
  expect(jsonLines(r.err)[0].code).toBe("E1001");
});

it("test reports each test and a summary; failures exit 1", () => {
  const ok = szigyr("test", "--json", `${CONF}accept/02-record-readonly.szigyr`);
  expect(ok.code).toBe(0);
  expect(jsonLines(ok.out)).toEqual([
    expect.objectContaining({ kind: "test", name: "records", ok: true }),
    { kind: "summary", passed: 1, failed: 0 },
  ]);
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "t.szigyr"), 'test("bad", (t: Test) => {\n  t.ok(false);\n});\n');
  const bad = szigyr("test", "--json", join(dir, "t.szigyr"));
  expect(bad.code).toBe(1);
  expect(jsonLines(bad.out)[0]).toMatchObject({ kind: "test", name: "bad", ok: false });
});

it("usage errors and missing files exit 2 with a message", () => {
  for (const a of [[], ["nope"], ["check"], ["check", "/no/such.szigyr"], ["run", "--bogus", "x"]]) {
    const r = szigyr(...a);
    expect(r.code).toBe(2);
    expect(r.err).toContain(CLI_NAME);
  }
});

it("run without an exported main is a CLI error, exit 2 (Q061)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "m.szigyr"), "export function f(): void {}\n");
  expect(szigyr("run", join(dir, "m.szigyr")).code).toBe(2);
});

it("run rejects main with wrong signature or non-managed layer with exit 2 (Q061)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-main-`));
  const bads: [string, string][] = [
    ["param.szigyr", "export function main(x: i32): void { x + 1; }\n"],
    ["ret.szigyr", 'export function main(sys: System): i32 { sys.log.info("side effect"); return 3; }\n'],
    ["arity.szigyr", "export function main(): void {}\n"],
    ["strict-file.szigyr", '"use owned";\nexport function main(sys: System): void {}\n'],
    ["strict-fn.szigyr", 'export function main(sys: System): void { "use owned"; }\n'],
    ["rt-fn.szigyr", 'export function main(): void { "use rt"; }\n'],
    ["generic.szigyr", "export function main<T>(sys: System): void {}\n"],
  ];
  for (const [name, src] of bads) {
    const f = join(dir, name);
    writeFileSync(f, src);
    const r = szigyr("run", f);
    expect(r.code, name).toBe(2);
    expect(r.out, name).toBe("");
    expect(r.err, name).toContain(CLI_NAME);
  }
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
  const f = join(dir, "both.szigyr");
  writeFileSync(f, BOTH);
  const r = szigyr("test", "--json", "--backend=both", f);
  const ls = jsonLines(r.out);
  expect(ls.filter((l) => l.kind === "mismatch")).toEqual([]);
  expect(ls.at(-1)).toEqual({ kind: "summary", passed: 1, failed: 1 });
  expect(r.code).toBe(1);
});

it("C traps T006 from the stack bound before the depth limit (Q182, D106)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-stack-`));
  const f = join(dir, "stack.szigyr");
  const fs = Array.from({ length: 100 }, (_, i) => `readonly f${i}: f64`).join("; ");
  const init = Array.from({ length: 100 }, (_, i) => `f${i}: ${i}`).join(", ");
  // depth 9990 is under the 10000 counter; 800-byte frames exceed an 8 MiB stack only with the stack check
  writeFileSync(f, `type S = Struct<{ ${fs} }>;\nfunction r(n: usize, s: S): f64 { "use owned"; if (n === 0) { return s.f0; } const t: S = { ...s, f1: s.f1 + 1 }; return r(n - 1, t) + s.f2; }\nexport function main(sys: System): void { const s: S = { ${init} }; sys.log.info(\`\${r(9990, s)}\`); }\n`);
  const r = szigyr("run", "--backend=c", f);
  expect(r.out + r.err).toMatch(/T006/);
});

const EQ = `type V2 = Struct<{ readonly x: f32; readonly y: f32 }>;
type Ev = { readonly kind: "move"; readonly to: V2 } | { readonly kind: "stop" };
function mk(alloc: Alloc): Vec<V2> {
  "use owned";
  const v = Vec.create<V2>(alloc, 1);
  v.push({ x: 0.5, y: -1 });
  v.push({ x: 2, y: 3 });
  return v;
}
function ev(n: i32): Ev {
  "use rt";
  if (n > 0) return { kind: "move", to: { x: 1, y: 2 } };
  return { kind: "stop" };
}
function first(v: Ref<Vec<V2>>): V2 {
  "use rt";
  return v[0];
}
test("eq through C", (t: Test) => {
  const v = mk(TestAlloc.create());
  t.eq(first(v), { x: 0.5, y: -1 });
  t.eq(v[1], { y: 3, x: 2 });
  t.eq(ev(1), { kind: "move", to: { x: 1, y: 2 } });
  t.eq(ev(0), { kind: "stop" });
});
test("eq fails the same way", (t: Test) => {
  t.eq(ev(1), { kind: "stop" });
});
`;

it("t.eq on values from C (packed Vec<Struct>, unions) agrees under --backend=both", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-eq-`));
  const f = join(dir, "eq.szigyr");
  writeFileSync(f, EQ);
  const r = szigyr("test", "--json", "--backend=both", f);
  const ls = jsonLines(r.out);
  expect(ls.filter((l) => l.kind === "mismatch")).toEqual([]);
  expect(ls.at(-1)).toEqual({ kind: "summary", passed: 1, failed: 1 });
});

it("Vec growth that runs out of memory is T006 under both backends, not a process abort (D106)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-oom-`));
  const f = join(dir, "oom.szigyr");
  writeFileSync(f, `function g(a: Alloc): usize {\n  "use owned";\n  const v = Vec.create<f64>(a, 1);\n  for (let k: i32 = 0; k < 2000000000; k += 1) v.push(2);\n  return v.length;\n}\nexport function main(sys: System): void {\n  sys.log.info("go");\n  sys.log.info(\`\${g(sys.alloc)}\`);\n}\n`);
  // ~11 GB of address space: V8 starts, and growing to 2e9 doubles fails with a RangeError
  const r = spawnSync("sh", ["-c", `ulimit -v 11000000 && exec node "$0" run --backend=both "$1"`, CLI, f], { encoding: "utf8" });
  expect(r.stdout).toBe("go\n");
  expect(r.stderr).toMatch(/trap T006 at .*:4:\d+/);
  expect(r.stderr).not.toMatch(/mismatch|FATAL|out of memory/);
  expect(r.status).toBe(3);
}, 60_000);

it("two Workers run C-backend strict code at the same time without sharing runtime state (D111)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-thr-`));
  // Each call grows a Vec from capacity 1 (host calls) and recurses; the last call of main overflows i32 (T001).
  // Both Workers load the same addon, so before D111 they shared one env, jmp_buf and Vec list.
  const f = join(dir, "p.szigyr");
  writeFileSync(f, `function deep(n: i32): i32 {\n  "use owned";\n  if (n === 0) return 0;\n  return deep(n - 1) + 1;\n}\nfunction work(a: Alloc, m: i32): i32 {\n  "use owned";\n  let s: i32 = 0;\n  for (let r: i32 = 0; r < 40; r += 1) {\n    const v = Vec.create<i32>(a, 1);\n    for (let k: i32 = 0; k < 20000; k += 1) v.push(k & 1);\n    for (let k: usize = 0; k < v.length; k += 1) s = s + v[k];\n    s = s + deep(200) - 200;\n  }\n  return s * m;\n}\nexport function main(sys: System): void {\n  for (let i: i32 = 0; i < 40; i += 1) sys.log.info(\`\${work(sys.alloc, 1)}\`);\n  sys.log.info(\`\${work(sys.alloc, 10000)}\`);\n}\n`);
  const idx = new URL("../src/index.ts", import.meta.url).href;
  writeFileSync(join(dir, "w.mjs"), `import { parentPort } from "node:worker_threads";\nconst { run } = await import(${JSON.stringify(idx)});\nconst out = [];\nfor (let i = 0; i < 8; i += 1) { const r = await run(${JSON.stringify(f)}, { backend: "c" }); out.push(r.diagnostics.map((d) => d.code).join() + r.stdout + "|" + (r.trap ? r.trap.code + "@" + r.trap.line : "")); }\nparentPort.postMessage(out);\n`);
  writeFileSync(join(dir, "main.mjs"), `import { Worker } from "node:worker_threads";\nconst go = () => new Promise((res, rej) => { const w = new Worker(${JSON.stringify(join(dir, "w.mjs"))}); w.on("message", res); w.on("error", rej); });\nconsole.log(JSON.stringify(await Promise.all([go(), go()])));\n`);
  const r = spawnSync("node", [join(dir, "main.mjs")], { encoding: "utf8" });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  const one = `${"400000\n".repeat(40)}|T001@15`;
  expect(JSON.parse(r.stdout)).toEqual([Array(8).fill(one), Array(8).fill(one)]);
}, 120_000);

// §14.7 (Q196): a C-only program stops with E4009 on the JS backend, before executing
// anything; `check` never reports E4009, and the C backend runs the program.
const C_ONLY = `declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_libversion_number(ffi: Ffi): i32;
}
function add(a: i32, b: i32): i32 {
  "use owned";
  return a + b;
}
export function main(sys: System): void {
  sys.log.info(\`\${add(20, 22)}\`);
}
test("in main", (t: Test) => {
  t.eq(add(1, 2), 3);
});
`;

it("run / test of a C-only program stop with E4009 on js and both; check is clean; C runs it", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-conly-`));
  const f = join(dir, "conly.szigyr");
  writeFileSync(f, C_ONLY);
  expect(szigyr("check", f)).toEqual({ code: 0, out: "", err: "" });
  const r = szigyr("run", "--json", f);
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
  expect(jsonLines(r.err)[0]).toMatchObject({ code: "E4009", range: { start: { line: 1, col: 16 } } });
  expect(szigyr("run", "--backend=both", f).code).toBe(1);
  const rc = szigyr("run", "--backend=c", f);
  expect(rc.code).toBe(0);
  expect(rc.out).toBe("42\n");
  const t = szigyr("test", "--json", f);
  expect(t.code).toBe(1);
  expect(jsonLines(t.out)[0]).toMatchObject({ code: "E4009" });
  const tc = szigyr("test", "--json", "--backend=c", f);
  expect(tc.code).toBe(0);
  expect(jsonLines(tc.out).at(-1)).toEqual({ kind: "summary", passed: 1, failed: 0 });
});

it("E4009 anchors at the first unsafe operation when there is no c: module", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-conly2-`));
  const f = join(dir, "op.szigyr");
  writeFileSync(f, `function take(p: Ptr<i32>): i32 {
  "use owned";
  "use unsafe";
  return p.read();
}
export function main(sys: System): void {
  sys.log.info("x");
}
`);
  const r = szigyr("run", "--json", f);
  expect(r.code).toBe(1);
  expect(jsonLines(r.err)[0]).toMatchObject({ code: "E4009", range: { start: { line: 1, col: 18 } } });
  expect(szigyr("check", f).code).toBe(0);
});

it("--backend=both stops on first backend diagnostics (E4009) without running C", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-e4009-both-`));
  const cacheDir = join(dir, "cache");
  const f = join(dir, "conly.szigyr");
  const marker = join(dir, "marker.txt");
  writeFileSync(f, `function add(a: i32, b: i32): i32 {
  "use owned";
  return a + b;
}
function take(p: Ptr<i32>): i32 {
  "use owned";
  "use unsafe";
  return p.read();
}
export function main(sys: System): void {
  sys.fs.writeText(${JSON.stringify(marker)}, "ran");
}
test("runs", (t: Test) => {
  t.eq(add(1, 2), 3);
});
`);
  const env = { ...process.env, XDG_CACHE_HOME: cacheDir };
  const r = spawnSync("node", [CLI, "run", "--json", "--backend=both", f], { encoding: "utf8", env });
  expect(r.status).toBe(1);
  expect(r.stdout).toBe("");
  expect(jsonLines(r.stderr)[0]).toMatchObject({ code: "E4009" });
  expect(existsSync(marker)).toBe(false);
  const t = spawnSync("node", [CLI, "test", "--json", "--backend=both", f], { encoding: "utf8", env });
  expect(t.status).toBe(1);
  expect(jsonLines(t.stdout)[0]).toMatchObject({ code: "E4009" });
  expect(existsSync(join(cacheDir, `${CLI_NAME}-native`))).toBe(false);
});

it("C FFI honors quoted pkg-config flags with spaces, CC consistency/hash, empty XDG_CACHE_HOME, and tmp cleanup (#16)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-cffi16-`));
  const incDir = join(dir, "inc dir");
  const pcDir = join(dir, "pc");
  const cacheDir = join(dir, "cache");
  const workDir = join(dir, "cwd");
  mkdirSync(incDir, { recursive: true });
  mkdirSync(pcDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(incDir, "sp.h"), "#include <stddef.h>\nstatic inline size_t sp_fn(size_t a) { return a + 41; }\n");
  writeFileSync(join(pcDir, "sp.pc"), `Name: sp\nDescription: space path test\nVersion: 1.0\nCflags: -I"${incDir}"\nLibs:\n`);
  const spTs = join(dir, "sp.szigyr");
  writeFileSync(spTs, `declare module "c:sp:sp.h" {
  function sp_fn(ffi: Ffi, a: usize): usize;
}
import { sp_fn } from "c:sp:sp.h";
function go(ffi: Ffi): usize {
  "use owned";
  "use unsafe";
  return sp_fn(ffi, 1);
}
export function main(sys: System): void {
  sys.log.info(\`\${go(sys.ffi)}\`);
}
`);
  // #16b: package name starting with '-' is not parsed as a pkg-config option
  const optChk = szigyr("check", `${CONF}reject/E2009-pkg-option-flag.szigyr`);
  expect(optChk.code).toBe(1);
  expect(optChk.out).toContain("pkg-config does not know the package '--version'");

  // #16c: quoted Cflags path with space succeeds in both check and C run
  const spEnv = { ...process.env, PKG_CONFIG_PATH: pcDir, XDG_CACHE_HOME: cacheDir };
  const chk = spawnSync("node", [CLI, "check", spTs], { encoding: "utf8", env: spEnv });
  expect(chk.status, chk.stdout + chk.stderr).toBe(0);
  const runSp = spawnSync("node", [CLI, "run", "--backend=c", spTs], { encoding: "utf8", env: spEnv });
  expect(runSp.status, runSp.stderr).toBe(0);
  expect(runSp.stdout.trim()).toBe("42");

  // #16d: headercheck honors CC
  const chkFalse = spawnSync("node", [CLI, "check", "--json", spTs], { encoding: "utf8", env: { ...spEnv, CC: "/bin/false" } });
  expect(chkFalse.status).toBe(1);
  expect(jsonLines(chkFalse.stdout)[0]).toMatchObject({ code: "E2009" });

  // #16e & #16g: native cache hash includes CC, and failed build removes *.tmp* files
  const simpleTs = join(dir, "simple.szigyr");
  writeFileSync(simpleTs, `function inc(x: i32): i32 { "use owned"; return x + 1; }\nexport function main(sys: System): void { sys.log.info(\`\${inc(1)}\`); }\n`);
  const okRun = spawnSync("node", [CLI, "run", "--backend=c", simpleTs], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cacheDir } });
  expect(okRun.status).toBe(0);
  expect(okRun.stdout.trim()).toBe("2");
  const badCcRun = spawnSync("node", [CLI, "run", "--backend=c", simpleTs], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cacheDir, CC: "/bin/false" } });
  expect(badCcRun.status).toBe(2);
  const nativeDir = join(cacheDir, `${CLI_NAME}-native`);
  expect(readdirSync(nativeDir).filter((n) => n.includes(".tmp"))).toEqual([]);

  // #16f: empty XDG_CACHE_HOME does not create szigyr-native in CWD
  const emptyXdg = spawnSync("node", [CLI, "run", "--backend=c", simpleTs], { encoding: "utf8", cwd: workDir, env: { ...process.env, XDG_CACHE_HOME: "" } });
  expect(emptyXdg.status).toBe(0);
  expect(existsSync(join(workDir, `${CLI_NAME}-native`))).toBe(false);
});

// Null is 1B Native across all layers (SPEC-v1 §3.3); managed-only types (string) still fail cleanly at the C boundary without raw cc errors.
it("null strict/rt boundary types work on both backends while non-Native fields still reject cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  const env = { ...process.env, XDG_CACHE_HOME: join(dir, "cache") };
  const main = `export function main(sys: System): void { sys.log.info("x"); }\n`;
  const okProbes: Record<string, string> = {
    unionNullMember: `type U = { readonly kind: "a"; readonly v: null } | { readonly kind: "b" };\nfunction f(u: U): i32 { "use owned"; return 1; }\n${main}`,
    structResultNull: `type S = Struct<{ readonly r: Result<null, i32> }>;\nfunction f(s: S): i32 { "use owned"; return 1; }\n${main}`,
    resultNullParam: `function f(r: Result<null, i32>): i32 { "use owned"; return 1; }\n${main}`,
    resultNullReturn: `function f(): Result<null, i32> { "use owned"; return ok(null); }\n${main}`,
    genericNull: `function f<T>(x: T): T { "use owned"; return x; }\nexport function main(sys: System): void { const r = f<Result<null, i32>>(ok(null)); sys.log.info("x"); }\n`,
  };
  for (const [name, src] of Object.entries(okProbes)) {
    const f = join(dir, `${name}.szigyr`);
    writeFileSync(f, src);
    const r = spawnSync("node", [CLI, "run", "--backend=both", f], { encoding: "utf8", env });
    expect(r.status, `${name}: ${r.stderr}`).toBe(0);
    expect(r.stdout).toBe("x\n");
  }
  const strFile = join(dir, "structString.szigyr");
  writeFileSync(strFile, `type S = Struct<{ readonly s: string }>;\nfunction f(s: S): i32 { "use owned"; return 1; }\n${main}`);
  const r = spawnSync("node", [CLI, "run", "--backend=c", strFile], { encoding: "utf8", env });
  expect(r.status).toBe(1);
  expect(r.stderr).not.toContain("failed:");
}, 120000);

// Q240 (a): polymorphic recursion is a check error (E4010); the C backend no longer caps type-argument nesting.
it("a polymorphically recursive strict function is rejected by check with E4010 (Q240)", () => {
  const f = tmpFile(`type W<T extends Native> = Struct<{ readonly a: T }>;\nfunction f<T>(x: T, n: i32): i32 { "use owned"; if (n === 0) { return 0; } const p: W<T> = { a: x }; return 1 + f<W<T>>(p, n - 1); }\nexport function main(sys: System): void { sys.log.info(\`\${f<i32>(1, 3)}\`); }\n`);
  const r = spawnSync("node", [CLI, "check", "--json", f], { encoding: "utf8" });
  expect(r.status).toBe(1);
  expect(jsonLines(r.stdout)[0].code).toBe("E4010");
});
it("runs through a symlink to cli.ts and from a path containing % # ?", () => {
  const d = mkdtempSync(join(tmpdir(), "szigyr-link-%#?-"));
  symlinkSync(CLI, join(d, CLI_NAME));
  const r = spawnSync(join(d, CLI_NAME), ["check", "--json", `${CONF}reject/E1001-var-in-function.szigyr`], { encoding: "utf8" });
  expect(r.status).toBe(1);
  expect(jsonLines(r.stdout)[0].code).toBe("E1001");
});

it("CC may carry arguments; an unwritable cache directory is a CBuildError, exit 2 (D150)", () => {
  const f = tmpFile(`function inc(x: i32): i32 { "use owned"; return x + 1; }\nexport function main(sys: System): void { sys.log.info(\`\${inc(1)}\`); }\n`);
  const cache = mkdtempSync(join(tmpdir(), "szigyr-d150-"));
  const ok = spawnSync("node", [CLI, "run", "--backend=c", f], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cache, CC: "cc -O1 -DSZ_D150" } });
  expect(ok).toMatchObject({ status: 0, stdout: "2\n" });
  const bad = spawnSync("node", [CLI, "run", "--backend=c", f], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: "/proc/nope" } });
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain("cache directory");
  expect(bad.stderr).not.toContain("    at ");
});

it("the native cache drops entries unused for 7 days once it holds more than 500, and a hit refreshes its entry (D149)", () => {
  const f = tmpFile(`function inc(x: i32): i32 { "use owned"; return x + 1; }\nexport function main(sys: System): void { sys.log.info(\`\${inc(2)}\`); }\n`);
  const cache = mkdtempSync(join(tmpdir(), "szigyr-d149-"));
  const env = { ...process.env, XDG_CACHE_HOME: cache };
  const dir = join(cache, `${CLI_NAME}-native`);
  mkdirSync(dir, { mode: 0o700 });
  const old = new Date(Date.now() - 30 * 864e5);
  for (let i = 0; i < 600; i++) { const p = join(dir, i % 3 ? `old${i}.node` : `old${i}.node.1.2.tmp.c`); writeFileSync(p, ""); utimesSync(p, old, old); }
  writeFileSync(join(dir, "recent.node"), "");
  const r = spawnSync("node", [CLI, "run", "--backend=c", f], { encoding: "utf8", env });
  expect(r).toMatchObject({ status: 0, stdout: "3\n" });
  const names = readdirSync(dir);
  expect(names.sort()).toHaveLength(2);
  expect(names).toContain("recent.node");
  const built = names.find((n) => n !== "recent.node")!;
  expect(built).toMatch(/^[0-9a-f]{24}\.node$/);
  utimesSync(join(dir, built), old, old); // a hit must refresh it
  expect(spawnSync("node", [CLI, "run", "--backend=c", f], { encoding: "utf8", env }).status).toBe(0);
  expect(Date.now() - statSync(join(dir, built)).mtimeMs).toBeLessThan(3600e3);
});

it("a module imported under two names (a symlink) loads once, in check and in run (Q253)", () => {
  const d = mkdtempSync(join(tmpdir(), "szigyr-q253-"));
  writeFileSync(join(d, "a.szigyr"), "export class C { x: f64 = 1; }\nexport function mk(): C { return new C(); }\nexport function use(c: C): f64 { return c.x; }\n");
  symlinkSync("a.szigyr", join(d, "link.szigyr"));
  const main = join(d, "main.szigyr");
  writeFileSync(main, `import { mk } from "./a.szigyr";\nimport { use } from "./link.szigyr";\nexport function main(sys: System): void { sys.log.info(\`\${use(mk())}\`); }\n`);
  expect(szigyr("check", main)).toEqual({ code: 0, out: "", err: "" });
  expect(szigyr("run", main)).toMatchObject({ code: 0, out: "1\n" });
  expect(szigyr("run", join(d, "link.szigyr")).err).toContain("no exported function 'main'"); // the entry may itself be the link
});

it("a second load in the same process refreshes the cache entry too (D149)", async () => {
  const f = tmpFile(`function inc(x: i32): i32 { "use owned"; return x + 4; }\nexport function main(sys: System): void { sys.log.info(\`\${inc(1)}\`); }\n`);
  const cache = mkdtempSync(join(tmpdir(), "szigyr-d149b-"));
  const prev = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  try {
    const { run } = await import("../src/index.ts");
    expect((await run(f, { backend: "c" })).stdout).toBe("5\n");
    const dir = join(cache, `${CLI_NAME}-native`), built = readdirSync(dir).find((n) => n.endsWith(".node"))!;
    const old = new Date(Date.now() - 30 * 864e5);
    utimesSync(join(dir, built), old, old);
    await run(f, { backend: "c" }); // served from the in-process map
    expect(Date.now() - statSync(join(dir, built)).mtimeMs).toBeLessThan(3600e3);
  } finally { if (prev === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = prev; }
}, 30_000);

// Q252: user input mistakes are CLI errors (exit 2) without a stack; internal errors exit 70.
const tmpFile = (src: string): string => { const f = join(mkdtempSync(join(tmpdir(), "szigyr-q252-")), "a.szigyr"); writeFileSync(f, src); return f; };

it("a directory as the entry file is a CLI error (Q252)", () => {
  const r = szigyr("check", CONF);
  expect(r.code).toBe(2);
  expect(r.err).toContain("not a file");
});

it("run with an unresolvable npm: import is a CLI error naming the specifier (Q252)", () => {
  const f = tmpFile(`import { x } from "npm:nonexistent-pkg-xyz";\nexport function main(sys: System): void { sys.log.info("hi"); }\n`);
  const r = szigyr("run", "--json", f);
  expect(r.code).toBe(2);
  expect(r.err).toContain("npm:nonexistent-pkg-xyz");
  expect(r.err).not.toContain("    at ");
});

it("a source nested too deeply is a CLI error, not a raw RangeError (Q252)", () => {
  const f = tmpFile(`export function main(sys: System): void {\n  const a: i32 = 1;\n  const b: i32 = ${Array(20000).fill("a").join(" + ")};\n}\n`);
  const r = szigyr("check", f);
  expect(r.code).toBe(2);
  expect(r.err).toBe(`${CLI_NAME}: source nests too deeply\n`);
});

// Q265: an isolate that dies with a non-Trap error (here: an npm module that throws only off the main thread) carries its cause as the trap's message.
it("run shows the cause of an isolate's abnormal end in both modes (Q265)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  mkdirSync(join(dir, "node_modules/thrower"), { recursive: true });
  writeFileSync(join(dir, "node_modules/thrower/package.json"), '{"name":"thrower","version":"1.0.0","main":"index.js"}');
  writeFileSync(join(dir, "node_modules/thrower/index.js"), 'if (!require("node:worker_threads").isMainThread) throw new Error("boom in isolate");\nmodule.exports = { v: 1 };\n');
  writeFileSync(join(dir, "m.szigyr"), `import { v } from "npm:thrower";
function worker(port: Port<string, null>): void {
  port.send("ready");
}
export async function main(sys: System): Promise<void> {
  const p = sys.spawn.isolate(worker);
  const a = await p.recv();
  const b = await p.recv();
}
`);
  const t = szigyr("run", join(dir, "m.szigyr"));
  expect(t.code).toBe(3);
  expect(t.err).toMatch(/^trap T006 at .*\n.*boom in isolate/);
  const j = szigyr("run", "--json", join(dir, "m.szigyr"));
  expect(jsonLines(j.err)[0]).toMatchObject({ kind: "trap", code: "T006", message: expect.stringContaining("boom in isolate") });
}, 60000);

// D161: files that share a module are checked with one tsgo process, which hands back the same AST nodes; the checker's per-node markers (`optCall`) must not leak from one entry's check into the next.
it("check a.ts b.ts reports what each file reports alone, also with a repeated entry (D161)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "shared.szigyr"), `class A { m(s: string | null): usize { return 1; } }
export function main(sys: System): void {
  let x: string | null = null;
  const a: A | null = sys.clock.nowMs() < 0 ? new A() : null;
  const r = a?.m(x = "a");
  sys.log.info(\`\${x.length}\`);
}
`);
  for (const n of ["a", "b"]) writeFileSync(join(dir, `${n}.szigyr`), `import { main } from "./shared.szigyr";\nexport function ${n}(): i32 {\n  return 1;\n}\n`);
  const a = join(dir, "a.szigyr"), b = join(dir, "b.szigyr");
  const alone = szigyr("check", "--json", b).out;
  expect(alone).toContain("E2002");
  expect(szigyr("check", "--json", a, b).out).toBe(szigyr("check", "--json", a).out + alone);
  expect(szigyr("check", "--json", b, a, b).out).toBe(alone + szigyr("check", "--json", a).out + alone);
});

it("--json emits valid JSONL for exit-2 usage/file errors and explain/query/test details", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-json-`));
  const missing = szigyr("check", "--json", join(dir, "does-not-exist.szigyr"));
  expect(missing.code).toBe(2);
  expect(missing.out).toBe("");
  expect(jsonLines(missing.err)[0]).toMatchObject({ kind: "error", code: "CLI_ERROR" });

  const badFlag = szigyr("check", "--json", "--unknown-flag", "x.szigyr");
  expect(badFlag.code).toBe(2);
  expect(jsonLines(badFlag.err)[0]).toMatchObject({ kind: "error", code: "CLI_USAGE" });

  const exText = szigyr("explain", "E2007");
  expect(exText.code).toBe(0);
  expect(exText.out).toContain("E2007 [P2]");
  const exJson = szigyr("explain", "--json", "t015");
  expect(exJson.code).toBe(0);
  expect(jsonLines(exJson.out)[0]).toMatchObject({ kind: "explain", code: "T015", phase: "runtime" });
  const exBad = szigyr("explain", "--json", "E9999");
  expect(exBad.code).toBe(2);
  expect(jsonLines(exBad.err)[0]).toMatchObject({ kind: "error", code: "CLI_ERROR" });

  const qf = join(dir, "mod.szigyr");
  writeFileSync(qf, `export type Pt = Struct<{ readonly x: i32; readonly y: i32 }>;
export function add(a: i32, b: i32): i32 {
  "use rt";
  return a + b;
}
export function useLogAlloc(a: Alloc, l: Log): usize {
  const v = Vec.create<i32>(a, 2);
  l.info("hi");
  return v.length;
}
export function useSys(sys: System): void {
  sys.log.info("sys");
}
export class Counter {
  v: i32;
  constructor(v: i32) { this.v = v; }
  inc(d: i32): i32 {
    this.v += d;
    return this.v;
  }
}
test("details", (t: Test) => {
  t.eq(1 + 1, 3);
});
test("forAll fail", (t: Test) => {
  forAll((n: i32): boolean => n === 999999);
});
`);
  const qRes = szigyr("query", "--json", qf);
  expect(qRes.code).toBe(0);
  const syms = jsonLines(qRes.out);
  expect(syms.find((s) => s.name === "Pt")).toMatchObject({ kind: "symbol", symbolKind: "type", caps: expect.arrayContaining(["Native", "Copy", "Send", "Codec"]) });
  expect(syms.find((s) => s.name === "add")).toMatchObject({
    kind: "symbol", symbolKind: "function", layer: "rt", pure: true, mutatable: true, exported: true,
    rtTrapSites: expect.arrayContaining([expect.objectContaining({ code: "T001" })]),
  });
  expect(syms.find((s) => s.name === "useLogAlloc")).toMatchObject({
    kind: "symbol", symbolKind: "function", layer: "managed", pure: false, mutatable: true, exported: true,
  });
  expect(syms.find((s) => s.name === "useSys")).toMatchObject({
    kind: "symbol", symbolKind: "function", layer: "managed", pure: false, mutatable: false, exported: true,
  });
  expect(syms.find((s) => s.name === "Counter.inc")).toMatchObject({
    kind: "symbol", symbolKind: "method", layer: "managed", pure: true, mutatable: true, exported: true,
  });

  const tRes = szigyr("test", "--json", qf);
  expect(tRes.code).toBe(1);
  const tLines = jsonLines(tRes.out);
  expect(tLines.find((l) => l.name === "details")?.detail).toEqual({ kind: "eq", actual: 2, expected: 3 });
  expect(tLines.find((l) => l.name === "forAll fail")?.detail).toMatchObject({ kind: "forAll", reason: "returned false" });
});

it("run reflects Proc.setExitCode across backends while traps still exit 3", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-exit-`));
  const okFile = join(dir, "exit2.szigyr");
  writeFileSync(okFile, `function helper(x: i32): i32 {
  "use rt";
  return x + 1;
}
export function main(sys: System): void {
  sys.log.info(\`\${helper(4)}\`);
  sys.proc.setExitCode(2);
}
`);
  const rBoth = szigyr("run", "--backend=both", okFile);
  expect(rBoth).toEqual({ code: 2, out: "5\n", err: "" });

  const trapFile = join(dir, "trap3.szigyr");
  writeFileSync(trapFile, `export function main(sys: System): void {
  sys.proc.setExitCode(7);
  panic("boom");
}
`);
  const rTrap = szigyr("run", trapFile);
  expect(rTrap.code).toBe(3);
  expect(rTrap.err).toContain("T006");
});
