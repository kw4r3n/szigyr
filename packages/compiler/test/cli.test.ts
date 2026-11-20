import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

it("run rejects main with wrong signature or non-managed layer with exit 2 (Q061)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-main-`));
  const bads: [string, string][] = [
    ["param.ts", "export function main(x: i32): void { x + 1; }\n"],
    ["ret.ts", 'export function main(sys: System): i32 { sys.log.info("side effect"); return 3; }\n'],
    ["arity.ts", "export function main(): void {}\n"],
    ["strict-file.ts", '"use owned";\nexport function main(sys: System): void {}\n'],
    ["strict-fn.ts", 'export function main(sys: System): void { "use owned"; }\n'],
    ["rt-fn.ts", 'export function main(): void { "use rt"; }\n'],
    ["generic.ts", "export function main<T>(sys: System): void {}\n"],
  ];
  for (const [name, src] of bads) {
    const f = join(dir, name);
    writeFileSync(f, src);
    const r = sts("run", f);
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
  const f = join(dir, "both.ts");
  writeFileSync(f, BOTH);
  const r = sts("test", "--json", "--backend=both", f);
  const ls = jsonLines(r.out);
  expect(ls.filter((l) => l.kind === "mismatch")).toEqual([]);
  expect(ls.at(-1)).toEqual({ kind: "summary", passed: 1, failed: 1 });
  expect(r.code).toBe(1);
});

it("C traps T006 from the stack bound before the depth limit (Q182, D106)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-stack-`));
  const f = join(dir, "stack.ts");
  const fs = Array.from({ length: 100 }, (_, i) => `readonly f${i}: f64`).join("; ");
  const init = Array.from({ length: 100 }, (_, i) => `f${i}: ${i}`).join(", ");
  // depth 9990 is under the 10000 counter; 800-byte frames exceed an 8 MiB stack only with the stack check
  writeFileSync(f, `type S = Struct<{ ${fs} }>;\nfunction r(n: usize, s: S): f64 { "use owned"; if (n === 0) { return s.f0; } const t: S = { ...s, f1: s.f1 + 1 }; return r(n - 1, t) + s.f2; }\nexport function main(sys: System): void { const s: S = { ${init} }; sys.log.info(\`\${r(9990, s)}\`); }\n`);
  const r = sts("run", "--backend=c", f);
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
  const f = join(dir, "eq.ts");
  writeFileSync(f, EQ);
  const r = sts("test", "--json", "--backend=both", f);
  const ls = jsonLines(r.out);
  expect(ls.filter((l) => l.kind === "mismatch")).toEqual([]);
  expect(ls.at(-1)).toEqual({ kind: "summary", passed: 1, failed: 1 });
});

it("Vec growth that runs out of memory is T006 under both backends, not a process abort (D106)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-oom-`));
  const f = join(dir, "oom.ts");
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
  const f = join(dir, "p.ts");
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
  const f = join(dir, "conly.ts");
  writeFileSync(f, C_ONLY);
  expect(sts("check", f)).toEqual({ code: 0, out: "", err: "" });
  const r = sts("run", "--json", f);
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
  expect(jsonLines(r.err)[0]).toMatchObject({ code: "E4009", range: { start: { line: 1, col: 16 } } });
  expect(sts("run", "--backend=both", f).code).toBe(1);
  const rc = sts("run", "--backend=c", f);
  expect(rc.code).toBe(0);
  expect(rc.out).toBe("42\n");
  const t = sts("test", "--json", f);
  expect(t.code).toBe(1);
  expect(jsonLines(t.out)[0]).toMatchObject({ code: "E4009" });
  const tc = sts("test", "--json", "--backend=c", f);
  expect(tc.code).toBe(0);
  expect(jsonLines(tc.out).at(-1)).toEqual({ kind: "summary", passed: 1, failed: 0 });
});

it("E4009 anchors at the first unsafe operation when there is no c: module", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-conly2-`));
  const f = join(dir, "op.ts");
  writeFileSync(f, `function take(p: Ptr<i32>): i32 {
  "use owned";
  "use unsafe";
  return p.read();
}
export function main(sys: System): void {
  sys.log.info("x");
}
`);
  const r = sts("run", "--json", f);
  expect(r.code).toBe(1);
  expect(jsonLines(r.err)[0]).toMatchObject({ code: "E4009", range: { start: { line: 1, col: 18 } } });
  expect(sts("check", f).code).toBe(0);
});

it("--backend=both stops on first backend diagnostics (E4009) without running C", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-e4009-both-`));
  const cacheDir = join(dir, "cache");
  const f = join(dir, "conly.ts");
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
  const spTs = join(dir, "sp.ts");
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
  const optChk = sts("check", `${CONF}reject/E2009-pkg-option-flag.ts`);
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
  const simpleTs = join(dir, "simple.ts");
  writeFileSync(simpleTs, `function inc(x: i32): i32 { "use owned"; return x + 1; }\nexport function main(sys: System): void { sys.log.info(\`\${inc(1)}\`); }\n`);
  const okRun = spawnSync("node", [CLI, "run", "--backend=c", simpleTs], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cacheDir } });
  expect(okRun.status).toBe(0);
  expect(okRun.stdout.trim()).toBe("2");
  const badCcRun = spawnSync("node", [CLI, "run", "--backend=c", simpleTs], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cacheDir, CC: "/bin/false" } });
  expect(badCcRun.status).toBe(2);
  const nativeDir = join(cacheDir, `${CLI_NAME}-native`);
  expect(readdirSync(nativeDir).filter((n) => n.includes(".tmp"))).toEqual([]);

  // #16f: empty XDG_CACHE_HOME does not create sts-native in CWD
  const emptyXdg = spawnSync("node", [CLI, "run", "--backend=c", simpleTs], { encoding: "utf8", cwd: workDir, env: { ...process.env, XDG_CACHE_HOME: "" } });
  expect(emptyXdg.status).toBe(0);
  expect(existsSync(join(workDir, `${CLI_NAME}-native`))).toBe(false);
});

it("runs through a symlink to cli.ts and from a path containing % # ?", () => {
  const d = mkdtempSync(join(tmpdir(), "sts-link-%#?-"));
  symlinkSync(CLI, join(d, "sts"));
  const r = spawnSync(join(d, "sts"), ["check", "--json", `${CONF}reject/E1001-var-in-function.ts`], { encoding: "utf8" });
  expect(r.status).toBe(1);
  expect(jsonLines(r.stdout)[0].code).toBe("E1001");
});

it("CC may carry arguments; an unwritable cache directory is a CBuildError, exit 2 (D150)", () => {
  const f = tmpFile(`function inc(x: i32): i32 { "use owned"; return x + 1; }\nexport function main(sys: System): void { sys.log.info(\`\${inc(1)}\`); }\n`);
  const cache = mkdtempSync(join(tmpdir(), "sts-d150-"));
  const ok = spawnSync("node", [CLI, "run", "--backend=c", f], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cache, CC: "cc -O1 -DSTS_D150" } });
  expect(ok).toMatchObject({ status: 0, stdout: "2\n" });
  const bad = spawnSync("node", [CLI, "run", "--backend=c", f], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: "/proc/nope" } });
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain("cache directory");
  expect(bad.stderr).not.toContain("    at ");
});

it("the native cache drops entries unused for 7 days once it holds more than 500, and a hit refreshes its entry (D149)", () => {
  const f = tmpFile(`function inc(x: i32): i32 { "use owned"; return x + 1; }\nexport function main(sys: System): void { sys.log.info(\`\${inc(2)}\`); }\n`);
  const cache = mkdtempSync(join(tmpdir(), "sts-d149-"));
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
  const d = mkdtempSync(join(tmpdir(), "sts-q253-"));
  writeFileSync(join(d, "a.ts"), "export class C { x: f64 = 1; }\nexport function mk(): C { return new C(); }\nexport function use(c: C): f64 { return c.x; }\n");
  symlinkSync("a.ts", join(d, "link.ts"));
  const main = join(d, "main.ts");
  writeFileSync(main, `import { mk } from "./a.ts";\nimport { use } from "./link.ts";\nexport function main(sys: System): void { sys.log.info(\`\${use(mk())}\`); }\n`);
  expect(sts("check", main)).toEqual({ code: 0, out: "", err: "" });
  expect(sts("run", main)).toMatchObject({ code: 0, out: "1\n" });
  expect(sts("run", join(d, "link.ts")).err).toContain("no exported function 'main'"); // the entry may itself be the link
});

// Q252: user input mistakes are CLI errors (exit 2) without a stack; internal errors exit 70.
const tmpFile = (src: string): string => { const f = join(mkdtempSync(join(tmpdir(), "sts-q252-")), "a.ts"); writeFileSync(f, src); return f; };

it("a directory as the entry file is a CLI error (Q252)", () => {
  const r = sts("check", CONF);
  expect(r.code).toBe(2);
  expect(r.err).toContain("not a file");
});

it("run with an unresolvable npm: import is a CLI error naming the specifier (Q252)", () => {
  const f = tmpFile(`import { x } from "npm:nonexistent-pkg-xyz";\nexport function main(sys: System): void { sys.log.info("hi"); }\n`);
  const r = sts("run", "--json", f);
  expect(r.code).toBe(2);
  expect(r.err).toContain("npm:nonexistent-pkg-xyz");
  expect(r.err).not.toContain("    at ");
});

it("a source nested too deeply is a CLI error, not a raw RangeError (Q252)", () => {
  const f = tmpFile(`export function main(sys: System): void {\n  const a: i32 = 1;\n  const b: i32 = ${Array(20000).fill("a").join(" + ")};\n}\n`);
  const r = sts("check", f);
  expect(r.code).toBe(2);
  expect(r.err).toBe("sts: source nests too deeply\n");
});
