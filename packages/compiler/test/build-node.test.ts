import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main as cliMain } from "../src/cli.ts";
import { buildNode, run } from "../src/index.ts";

const runCli = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
  let out = "", err = "";
  const code = await cliMain(argv, (s) => { out += s; }, (s) => { err += s; });
  return { code, out, err };
};

const fxDir = mkdtempSync(join(tmpdir(), "szigyr-bnode-c-"));
const prevPkgPath = process.env.PKG_CONFIG_PATH;
process.env.PKG_CONFIG_PATH = prevPkgPath ? `${fxDir}:${prevPkgPath}` : fxDir;

writeFileSync(join(fxDir, "bnode.h"), `#ifndef BNODE_H
#define BNODE_H
#include <stdint.h>
typedef struct BNodeVec {
  int32_t x;
  int32_t y;
} BNodeVec;
BNodeVec *bn_make(int32_t x, int32_t y);
void bn_free(BNodeVec *p);
int32_t bn_dot(const BNodeVec *a, const BNodeVec *b);
#endif
`);
writeFileSync(join(fxDir, "bnode.c"), `#include "bnode.h"
#include <stdlib.h>
BNodeVec *bn_make(int32_t x, int32_t y) {
  BNodeVec *p = malloc(sizeof *p);
  p->x = x; p->y = y;
  return p;
}
void bn_free(BNodeVec *p) { free(p); }
int32_t bn_dot(const BNodeVec *a, const BNodeVec *b) { return a->x * b->x + a->y * b->y; }
`);
execFileSync(process.env.CC || "cc", ["-O2", "-shared", "-fPIC", join(fxDir, "bnode.c"), "-o", join(fxDir, "libbnode.so")]);
writeFileSync(join(fxDir, "bnode.pc"), `Name: bnode
Description: temp build-node C FFI test lib
Version: 1.0.0
Cflags: -I${fxDir}
Libs: -L${fxDir} -Wl,-rpath,${fxDir} -lbnode
`);

afterAll(() => {
  if (prevPkgPath === undefined) delete process.env.PKG_CONFIG_PATH;
  else process.env.PKG_CONFIG_PATH = prevPkgPath;
  rmSync(fxDir, { recursive: true, force: true });
});

describe("node target builder & CLI", () => {
  it("builds default native C app with use rt, spawn.isolate, and npm: pkg and runs standalone after relocation", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "szigyr-bnode-src-"));
    const nm = join(srcDir, "node_modules", "node-helper-pkg");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "node-helper-pkg", main: "index.cjs" }));
    writeFileSync(join(nm, "index.cjs"), `exports.formatAns = (n) => "ans=" + n;\n`);

    const entry = join(srcDir, "app.szigyr");
    writeFileSync(entry, [
      `import { formatAns } from "npm:node-helper-pkg";`,
      `function fastSum(a: Ref<Vec<i32>>): i32 {`,
      `  "use rt";`,
      `  let acc: i32 = 0;`,
      `  let i: usize = 0;`,
      `  while (i < a.length) { acc += a[i]; i += 1; }`,
      `  return acc;`,
      `}`,
      `function ownedScale(x: i32): i32 {`,
      `  "use owned";`,
      `  return x * 2;`,
      `}`,
      `async function workerEntry(port: Port<i32, Vec<i32>>): Promise<void> {`,
      `  const v = await port.recv();`,
      `  if (v !== null) port.send(ownedScale(fastSum(v)));`,
      `}`,
      `export async function main(sys: System): Promise<void> {`,
      `  const p = sys.spawn.isolate<Vec<i32>, i32>(workerEntry);`,
      `  const v = Vec.create<i32>(sys.alloc, 4);`,
      `  v.push(10); v.push(20); v.push(5);`,
      `  p.send(v);`,
      `  const res = await p.recv();`,
      `  if (res !== null) {`,
      `    const r = sys.js.call(formatAns, [sys.js.encode<i32>(res)]);`,
      `    if (r.kind === "ok") {`,
      `      const d = sys.js.decode<string>(r.value);`,
      `      if (d.kind === "ok") sys.log.info(d.value);`,
      `    }`,
      `  }`,
      `  p.close();`,
      `}`,
    ].join("\n"));

    const outDir = mkdtempSync(join(tmpdir(), "szigyr-bnode-out-"));
    const r = await runCli(["build", "--target=node", "--json", "-o", outDir, entry]);
    expect(r.code, r.err).toBe(0);
    const meta = JSON.parse(r.out.trim()) as { kind: string; target: string; mode: string; backend: string; outDir: string; files: string[] };
    expect(meta.kind).toBe("build");
    expect(meta.target).toBe("node");
    expect(meta.mode).toBe("app");
    expect(meta.backend).toBe("c");
    expect(meta.files).toContain("program.node");
    expect(meta.files).toContain("main.js");
    expect(meta.files).toContain("app.js");
    expect(meta.files).toContain("package.json");
    expect(existsSync(join(outDir, "program.node"))).toBe(true);
    expect((statSync(join(outDir, "main.js")).mode & 0o111) !== 0).toBe(true);

    // Move outDir to an isolated temp location and delete original source + node_modules.
    const isoDir = mkdtempSync(join(tmpdir(), "szigyr-bnode-iso-"));
    cpSync(outDir, isoDir, { recursive: true });
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });

    const runOut = execFileSync(process.execPath, [join(isoDir, "main.js")], { encoding: "utf8" });
    expect(runOut).toBe("ans=70\n");
    rmSync(isoDir, { recursive: true, force: true });
  });

  it("supports C FFI (declare module c:) and exits 3 on runtime traps in built node apps", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "szigyr-bnode-ffi-"));
    const entry = join(srcDir, "ffi.szigyr");
    writeFileSync(entry, [
      `declare module "c:bnode:bnode.h" {`,
      `  type BNodeVec = CStruct<{ x: i32; y: i32 }>;`,
      `  function bn_make(ffi: Ffi, x: i32, y: i32): Ptr<BNodeVec>;`,
      `  function bn_free(ffi: Ffi, p: Ptr<BNodeVec>): void;`,
      `  function bn_dot(ffi: Ffi, a: ConstPtr<BNodeVec>, b: ConstPtr<BNodeVec>): i32;`,
      `}`,
      `import { BNodeVec, bn_make, bn_free, bn_dot } from "c:bnode:bnode.h";`,
      `function computeFfiDot(f: Ffi): i32 {`,
      `  "use owned";`,
      `  "use unsafe";`,
      `  const a = bn_make(f, 3, 4);`,
      `  const b = bn_make(f, 5, 6);`,
      `  const res = bn_dot(f, a, b);`,
      `  bn_free(f, a);`,
      `  bn_free(f, b);`,
      `  return res;`,
      `}`,
      `function bnodeSize(): usize {`,
      `  "use owned";`,
      `  "use unsafe";`,
      `  return Ptr.sizeOf<BNodeVec>();`,
      `}`,
      `export function main(sys: System): void {`,
      `  const res = computeFfiDot(sys.ffi);`,
      `  sys.log.info(\`sz=\${bnodeSize()},dot=\${res}\`);`,
      `}`,
    ].join("\n"));

    const outDir = mkdtempSync(join(tmpdir(), "szigyr-bnode-ffi-out-"));
    const r = await runCli(["build", "--target=node", "-o", outDir, entry]);
    expect(r.code, r.err).toBe(0);
    const out = execFileSync(process.execPath, [join(outDir, "main.js")], { encoding: "utf8" });
    expect(out).toBe("sz=8,dot=39\n");

    const trapEntry = join(srcDir, "trap.szigyr");
    writeFileSync(trapEntry, [
      `function failDiv(x: i32): i32 { "use rt"; return divTrunc(10, x); }`,
      `export function main(sys: System): void {`,
      `  sys.log.info("before");`,
      `  failDiv(0);`,
      `}`,
    ].join("\n"));
    const trapDir = mkdtempSync(join(tmpdir(), "szigyr-bnode-trap-"));
    expect((await runCli(["build", "--target=node", "-o", trapDir, trapEntry])).code).toBe(0);
    const child = spawnSync(process.execPath, [join(trapDir, "main.js")], { encoding: "utf8" });
    expect(child.status).toBe(3);
    expect(child.stdout).toBe("before\n");
    expect(child.stderr).toContain("T007");
  });

  it("supports --mode=lib, --backend=js, --backend=wasm, and validates CLI flags", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "szigyr-bnode-modes-"));
    const libFile = join(srcDir, "lib.szigyr");
    writeFileSync(libFile, `export function addMul(a: i32, b: i32): i32 { "use rt"; return a * b + 1; }\n`);
    const libOut = mkdtempSync(join(tmpdir(), "szigyr-bnode-lib-"));
    const builtLib = buildNode(libFile, { outDir: libOut, mode: "lib", backend: "c" });
    expect(builtLib.diagnostics).toEqual([]);
    expect(existsSync(join(libOut, "main.js"))).toBe(false);
    expect(existsSync(join(libOut, "program.node"))).toBe(true);
    const loadedMod = await import(pathToFileURL(join(libOut, "app.js")).href) as { load: () => Promise<{ exports: { addMul: (a: number, b: number) => number } }> };
    const loaded = await loadedMod.load();
    expect(loaded.exports.addMul(6, 7)).toBe(43);

    // #14: loaded.run() resets C state (done/ready) and isolateCause across sequential invocations
    const reRunFile = join(srcDir, "rerun.szigyr");
    writeFileSync(reRunFile, [
      `function divRt(x: i32): i32 { "use rt"; return divTrunc(42, x); }`,
      `async function isoEcho(port: Port<i32, i32>): Promise<void> {`,
      `  const v = await port.recv();`,
      `  if (v !== null) port.send(divRt(v));`,
      `}`,
      `export async function main(sys: System): Promise<void> {`,
      `  const args = sys.proc.args();`,
      `  if (args.length > 0 && args[0] === "trap") {`,
      `    divRt(0);`,
      `    return;`,
      `  }`,
      `  const p = sys.spawn.isolate<i32, i32>(isoEcho);`,
      `  p.send(1);`,
      `  const r = await p.recv();`,
      `  p.close();`,
      `  sys.log.info(\`ok:\${r ?? -1}\`);`,
      `}`,
    ].join("\n"));
    const reRunOut = mkdtempSync(join(tmpdir(), "szigyr-bnode-rerun-"));
    const builtReRun = buildNode(reRunFile, { outDir: reRunOut, mode: "lib", backend: "c" });
    expect(builtReRun.diagnostics).toEqual([]);
    const reMod = await import(pathToFileURL(join(reRunOut, "app.js")).href) as {
      load: () => Promise<{ run: (fn?: unknown, opts?: { args?: string[] }) => Promise<{ stdout: string; trap: { code: string } | null; exitCode: number }> }>;
    };
    const reLoaded = await reMod.load();
    const rTrap = await reLoaded.run(undefined, { args: ["trap"] });
    expect(rTrap.trap?.code).toBe("T007");
    expect(rTrap.exitCode).toBe(3);
    const rOk = await reLoaded.run(undefined, { args: ["ok"] });
    expect(rOk.trap).toBeNull();
    expect(rOk.exitCode).toBe(0);
    expect(rOk.stdout).toBe("ok:42\n");

    const appFile = join(srcDir, "app.szigyr");
    writeFileSync(appFile, `function mul(a: i32, b: i32): i32 { "use rt"; return a * b; }\nexport function main(sys: System): void { sys.log.info(\`v=\${mul(6, 7)}\`); }\n`);

    const jsOut = mkdtempSync(join(tmpdir(), "szigyr-bnode-js-"));
    expect((await runCli(["build", "--target=node", "--backend=js", "-o", jsOut, appFile])).code).toBe(0);
    expect(existsSync(join(jsOut, "program.node"))).toBe(false);
    expect(execFileSync(process.execPath, [join(jsOut, "main.js")], { encoding: "utf8" })).toBe("v=42\n");

    const wasmOut = mkdtempSync(join(tmpdir(), "szigyr-bnode-wasm-"));
    expect((await runCli(["build", "--target=node", "--backend=wasm", "-o", wasmOut, appFile])).code).toBe(0);
    expect(existsSync(join(wasmOut, "program.wasm"))).toBe(true);
    expect(execFileSync(process.execPath, [join(wasmOut, "main.js")], { encoding: "utf8" })).toBe("v=42\n");

    // E4009 for C-only under js/wasm
    const unsafeFile = join(srcDir, "unsafe.szigyr");
    writeFileSync(unsafeFile, `function bad(): boolean { "use rt"; "use unsafe"; const p = Ptr.null<u8>(); return p.isNull(); }\nexport function main(sys: System): void {}\n`);
    const rJs = await runCli(["build", "--target=node", "--backend=js", "-o", jsOut, unsafeFile]);
    expect(rJs.code).toBe(1);
    expect(rJs.err).toContain("E4009");
    const rWasm = await runCli(["build", "--target=node", "--backend=wasm", "-o", wasmOut, unsafeFile]);
    expect(rWasm.code).toBe(1);
    expect(rWasm.err).toContain("E4009");

    // Invalid backend on build
    expect((await runCli(["build", "--target=node", "--backend=both", appFile])).code).toBe(2);
    expect((await runCli(["build", "--target=node", "--mode=bad", appFile])).code).toBe(2);
  });

  it("handles dual ESM/CJS exports, opaque CJS defaults, and export * as ns in run (incl. isolate) and build --target=node", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "szigyr-bnode-npmcompat-"));
    const nm = join(srcDir, "node_modules");
    mkdirSync(join(nm, "dual-pkg"), { recursive: true });
    mkdirSync(join(nm, "opaque-cjs"), { recursive: true });
    mkdirSync(join(nm, "reexport-ns"), { recursive: true });

    // Dual ESM/CJS whose CJS lacks static named exports (`three` pattern)
    writeFileSync(join(nm, "dual-pkg", "package.json"), JSON.stringify({
      name: "dual-pkg",
      exports: { ".": { import: "./esm.mjs", require: "./cjs.cjs" } },
    }));
    writeFileSync(join(nm, "dual-pkg", "esm.mjs"), `export const MathBox = { addOne: (x) => x + 1 };\n`);
    writeFileSync(join(nm, "dual-pkg", "cjs.cjs"), `module.exports = (function() { return { MathBox: { addOne: (x) => x - 999 } }; })();\n`);

    // Opaque CJS assigning function + methods (`lodash` pattern)
    writeFileSync(join(nm, "opaque-cjs", "package.json"), JSON.stringify({ name: "opaque-cjs", main: "index.cjs" }));
    writeFileSync(join(nm, "opaque-cjs", "index.cjs"), `function base(n) { return n; } base.triple = (n) => n * 3; module.exports = base;\n`);

    // ESM using ES2020 `export * as ns from ...` (`zod` pattern)
    writeFileSync(join(nm, "reexport-ns", "package.json"), JSON.stringify({ name: "reexport-ns", type: "module", main: "index.js" }));
    writeFileSync(join(nm, "reexport-ns", "sub.js"), `export const bias = 7;\n`);
    writeFileSync(join(nm, "reexport-ns", "index.js"), `export * as sub from "./sub.js";\n`);

    const entry = join(srcDir, "app.szigyr");
    writeFileSync(entry, [
      `import { MathBox } from "npm:dual-pkg";`,
      `import { triple } from "npm:opaque-cjs";`,
      `import { sub } from "npm:reexport-ns";`,
      `function evalJs(sys: System): i32 {`,
      `  const fAdd = sys.js.get(MathBox, "addOne");`,
      `  const fBias = sys.js.get(sub, "bias");`,
      `  if (fAdd.kind !== "ok" || fBias.kind !== "ok") return -1;`,
      `  const r1 = sys.js.call(fAdd.value, [sys.js.encode<i32>(10)]);`,
      `  const r2 = sys.js.call(triple, [sys.js.encode<i32>(4)]);`,
      `  if (r1.kind !== "ok" || r2.kind !== "ok") return -2;`,
      `  const d1 = sys.js.decode<i32>(r1.value);`,
      `  const d2 = sys.js.decode<i32>(r2.value);`,
      `  const d3 = sys.js.decode<i32>(fBias.value);`,
      `  if (d1.kind !== "ok" || d2.kind !== "ok" || d3.kind !== "ok") return -3;`,
      `  return d1.value + d2.value + d3.value;`,
      `}`,
      `async function isoUse(p: Port<i32, i32>): Promise<void> {`,
      `  const n = await p.recv();`,
      `  if (n === null) return;`,
      `  const ref: JsRef = triple;`,
      `  p.send(n + 10);`,
      `}`,
      `export async function main(sys: System): Promise<void> {`,
      `  const sum = evalJs(sys);`,
      `  const iso = sys.spawn.isolate<i32, i32>(isoUse);`,
      `  iso.send(sum);`,
      `  const v = await iso.recv();`,
      `  if (v !== null) sys.log.info(\`res=\${sum},\${v}\`);`,
      `  iso.close();`,
      `}`,
    ].join("\n"));

    // 1. Direct szigyr run (main + Worker isolate)
    const runRes = await run(entry);
    expect(runRes.diagnostics).toEqual([]);
    expect(runRes.trap).toBeNull();
    expect(runRes.stdout).toBe("res=30,40\n");

    // 2. Standalone build --target=node relocated away from node_modules
    const outDir = mkdtempSync(join(tmpdir(), "szigyr-bnode-npmcompat-out-"));
    const isoDir = mkdtempSync(join(tmpdir(), "szigyr-bnode-npmcompat-iso-"));
    expect((await runCli(["build", "--target=node", "-o", outDir, entry])).code).toBe(0);
    cpSync(outDir, isoDir, { recursive: true });
    rmSync(srcDir, { recursive: true, force: true });
    expect(execFileSync(process.execPath, [join(isoDir, "main.js")], { encoding: "utf8" })).toBe("res=30,40\n");
  });

  it("propagates Proc.setExitCode in standalone built node apps while traps override with exit 3", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "szigyr-bnode-exit-"));
    const exitFile = join(srcDir, "exit.szigyr");
    writeFileSync(exitFile, `export function main(sys: System): void {
  sys.log.info("bad arg");
  sys.proc.setExitCode(2);
}
`);
    const exitOut = mkdtempSync(join(tmpdir(), "szigyr-bnode-exit-out-"));
    expect((await runCli(["build", "--target=node", "-o", exitOut, exitFile])).code).toBe(0);
    const child2 = spawnSync(process.execPath, [join(exitOut, "main.js")], { encoding: "utf8" });
    expect(child2.status).toBe(2);
    expect(child2.stdout).toBe("bad arg\n");
    expect(child2.stderr).toBe("");

    const trapExitFile = join(srcDir, "trap-exit.szigyr");
    writeFileSync(trapExitFile, `export function main(sys: System): void {
  sys.proc.setExitCode(5);
  panic("oops");
}
`);
    const trapOut = mkdtempSync(join(tmpdir(), "szigyr-bnode-trapexit-out-"));
    expect((await runCli(["build", "--target=node", "-o", trapOut, trapExitFile])).code).toBe(0);
    const child3 = spawnSync(process.execPath, [join(trapOut, "main.js")], { encoding: "utf8" });
    expect(child3.status).toBe(3);
    expect(child3.stderr).toContain("T006");
  });
});
