import { dirname, relative, resolve } from "node:path";
import type { Diagnostic, RunResult } from "./diagnostics.ts";
import { createParser, SyntaxKind, type Node, type ParsedFile, type ts } from "./parse.ts";
import { DETMATH_PATH } from "./detmath.ts";
import { checkSyntax } from "./syntax.ts";
import { Program as Decls, Reporter, canonPath, checkImportNames, type Module } from "./modules.ts";
import { Checker } from "./checker.ts";
import { checkOwnership } from "./ownership.ts";
import { checkHeaders } from "./headercheck.ts";
import { trapSites, type TrapSite } from "./traps.ts";
import { isDeterministic } from "./determinism.ts";
import { emitFile, EXPORTS, IMP, RT, SOURCE_URL } from "./emit.ts";
import { loopBoundaryWarnings } from "./boundary.ts";
import { emitC } from "./emit-c.ts";
import { loadNative, nativePathOf } from "./native.ts";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as rt from "../../runtime-js/src/index.ts";
import { FakeClock, FakeFs, MemoryLog, SeededRandom, TestAlloc, runMain } from "../../std/src/index.ts";
export * from "./diagnostics.ts";
export * from "./names.ts";

/** A user input mistake the CLI reports without a stack, exit 2 (Q252). */
export class CliError extends Error {}

/** Entry file plus every file reachable through relative static imports, parsed with one tsgo process. */
interface Program {
  files: ParsedFile[];
  /** E7001 for relative imports whose file does not exist (Q009). */
  missing: Diagnostic[];
}

function loadProgram(entryFile: string): Program {
  const parser = createParser();
  const files = new Map<string, ParsedFile>();
  const missing: Diagnostic[] = [];
  try {
    const entryPath = canonPath(entryFile);
    const entry = parser.parse([entryPath]).get(entryPath);
    if (!entry) throw new Error(`cannot read ${entryFile}`);
    files.set(entry.path, entry);
    let round = [entry];
    while (round.length) { // one parse round per import depth (~1ms each, D007)
      const wanted = new Map<string, { from: ParsedFile; spec: ts.StringLiteral }>();
      for (const pf of round) {
        for (const s of pf.sourceFile.statements) {
          if (s.kind !== SyntaxKind.ImportDeclaration) continue;
          const spec = (s as ts.ImportDeclaration).moduleSpecifier;
          if (spec.kind !== SyntaxKind.StringLiteral) continue;
          const t = (spec as ts.StringLiteral).text;
          if (!/^\.\.?\//.test(t) || !t.endsWith(".ts")) continue; // npm: and malformed specifiers are not loaded
          const p = canonPath(dirname(pf.path), t);
          if (!files.has(p) && !wanted.has(p)) wanted.set(p, { from: pf, spec: spec as ts.StringLiteral });
        }
      }
      const got = parser.parse([...wanted.keys()]);
      round = [];
      for (const [p, w] of wanted) {
        const pf = got.get(p);
        if (pf) { files.set(p, pf); round.push(pf); continue; }
        const sf = w.from.sourceFile;
        missing.push({
          code: "E7001", severity: "error", message: `cannot find module '${w.spec.text}'`, file: displayPath(w.from.path),
          range: { start: w.from.position(w.spec.getStart(sf)), end: w.from.position(w.spec.end) },
        });
      }
    }
    // §12 (Q191): a program that uses `DetMath.<name>` gets the bundled module added to it;
    // the emitter imports it under a name users cannot write.
    let usesDetMath = false;
    const scan = (n: Node): void => {
      if (usesDetMath) return;
      if (n.kind === SyntaxKind.PropertyAccessExpression) {
        const pa = n as ts.PropertyAccessExpression;
        if (pa.expression.kind === SyntaxKind.Identifier && (pa.expression as ts.Identifier).text === "DetMath") { usesDetMath = true; return; }
      }
      n.forEachChild(scan);
    };
    for (const pf of files.values()) scan(pf.sourceFile);
    if (usesDetMath && !files.has(DETMATH_PATH)) {
      const dm = parser.parse([DETMATH_PATH]).get(DETMATH_PATH);
      if (dm) files.set(dm.path, dm);
    }
  } finally {
    parser.close();
  }
  return { files: [...files.values()], missing };
}

const displayPath = (p: string): string => relative(process.cwd(), p) || p;

/** Phases run in order P1 -> P2 -> P3 and stop at the first phase with an error (Q003). */
export function check(entryFile: string): Diagnostic[] {
  const a = analyze(entryFile);
  return [...a.diagnostics, ...(a.warnings ?? [])];
}

/** P1 + P2 + P3 over the program; on success the expression types are in `exprTypes` for the emitter. */
function analyze(entryFile: string): { files: ParsedFile[]; diagnostics: Diagnostic[]; warnings?: Diagnostic[]; decls?: Decls; unsafeOps?: { mod: Module; node: Node }[] } {
  const prog = loadProgram(entryFile);
  const p1 = [...prog.missing, ...prog.files.flatMap((f) => checkSyntax(f, displayPath(f.path)))];
  if (!p1.length) p1.push(...checkImportNames(prog.files, displayPath));
  if (p1.length) return { files: prog.files, diagnostics: p1 };
  const rep = new Reporter();
  const decls = new Decls(prog.files, displayPath, rep);
  const chk = new Checker(decls);
  chk.run();
  if (!rep.out.length) checkOwnership(decls);
  if (rep.out.length) return { files: prog.files, diagnostics: rep.out, decls, unsafeOps: chk.unsafeOps };
  const hdrs = new Reporter();
  checkHeaders(decls, hdrs); // P4 (§14.2): the header check runs only on a program clean through P3
  if (hdrs.out.length) return { files: prog.files, diagnostics: hdrs.out, decls, unsafeOps: chk.unsafeOps };
  const warns = new Reporter();
  loopBoundaryWarnings(decls, warns);
  return { files: prog.files, diagnostics: [], warnings: warns.out, decls, unsafeOps: chk.unsafeOps };
}

/** §14.7 (Q196): a program is C-only when one of its files declares a `c:` module or uses an
 * unsafe operation (§14.4). The E4009 anchor is the first `c:` specifier or unsafe operation
 * found in the program's files in path order (an operation's anchor is its E4008 anchor).
 * Only `run` / `test` report this, before executing; `check` never does. */
function cOnlyDiagnostic(files: ParsedFile[], ops: { mod: Module; node: Node }[]): Diagnostic | undefined {
  let best: { pf: ParsedFile; node: Node } | undefined;
  const offer = (pf: ParsedFile, node: Node): void => {
    if (!best || pf.path < best.pf.path || (pf.path === best.pf.path && node.getStart(pf.sourceFile) < best.node.getStart(best.pf.sourceFile))) best = { pf, node };
  };
  for (const pf of files) {
    for (const s of pf.sourceFile.statements) {
      if (s.kind === SyntaxKind.ModuleDeclaration) {
        const name = (s as ts.ModuleDeclaration).name;
        if (name.kind === SyntaxKind.StringLiteral && (name as ts.StringLiteral).text.startsWith("c:")) offer(pf, name);
      } else if (s.kind === SyntaxKind.ImportDeclaration) {
        const spec = (s as ts.ImportDeclaration).moduleSpecifier;
        if (spec.kind === SyntaxKind.StringLiteral && (spec as ts.StringLiteral).text.startsWith("c:")) offer(pf, spec);
      }
    }
  }
  for (const op of ops) offer(op.mod.pf, op.node);
  if (!best) return undefined;
  const { pf, node } = best;
  return {
    code: "E4009", severity: "error",
    message: "program is C-only (a 'c:' module or an unsafe operation); run it with --backend=c",
    file: displayPath(pf.path),
    range: { start: pf.position(node.getStart(pf.sourceFile)), end: pf.position(node.end) },
  };
}

/** §7.3 query (Q062): for each top-level function of the entry file, whether it is deterministic. Assumes P1 passes. */
export function deterministicFunctions(entryFile: string): Record<string, boolean> {
  const prog = loadProgram(entryFile);
  const decls = new Decls(prog.files, displayPath, new Reporter());
  const entry = decls.mods.find((m) => m.pf.path === canonPath(entryFile))!;
  return Object.fromEntries(decls.fns.filter((f) => f.mod === entry).map((f) => [f.name, isDeterministic(f.sig, f.layer === "rt" && f.unsafe)]));
}

/** §6 (stage 2): for each rt function of the entry file, where it can trap. Throws if the program does not check. */
export function rtTrapSites(entryFile: string): Record<string, TrapSite[]> {
  const a = analyze(entryFile);
  if (a.diagnostics.length) throw new Error(`${entryFile}: the program has diagnostics`);
  return trapSites(a.files.find((f) => f.path === canonPath(entryFile))!);
}

/** Which backend runs strict / rt functions (D101). Managed code always runs on the JS engine. */
export type Backend = "js" | "c";
export interface RunOptions { backend?: Backend }

/** The host object the C addon calls back into: traps (D103) and Vec creation (D102). */
const HOST = {
  trap: (code: number, file: string, line: number, col: number): never => rt.trap(`T${String(code).padStart(3, "0")}` as rt.TrapCode, "trap in C", file ? { file, line, col } : undefined),
  create: (alloc: unknown, cap: number, elem: rt.ElemKind): unknown => rt.Vec.create(alloc, cap, elem),
  createPool: (alloc: unknown, cap: number, elem: rt.ElemKind): unknown => rt.Pool.create(alloc, cap, elem),
  createArena: (alloc: unknown, bytes: number): unknown => rt.Arena.create(alloc, bytes),
  createRing: (alloc: unknown, cap: number, elem: rt.ElemKind): unknown => rt.Ring.create(alloc, cap, elem),
  adoptRing: (v: rt.RingTx | rt.RingRx, elem: rt.ElemKind): void => v.adopt(elem),
  adoptPool: (v: rt.Pool, elem: rt.ElemKind): void => v.adopt(elem),
  adopt: (v: rt.Vec | rt.Slice, elem: rt.ElemKind): void => v.adopt(elem),
  reserve: (v: rt.Vec, cap: number, len: number): void => v.reserve(cap, len),
};

/** Emits every file and evaluates them as module factories in memory (D031). Returns the entry's exports and, for a C backend program, its native module. */
async function load(files: ParsedFile[], entryFile: string, tests: boolean, decls?: Decls, backend: Backend = "js"): Promise<{ ex: Record<string, unknown>; native: Record<string, (...a: unknown[]) => unknown> | undefined }> {
  const entry = canonPath(entryFile);
  rt.takeIsolateTrap(); // D144: a record a previous program in this process left behind is not this program's
  const c = backend === "c" && decls ? emitC(decls) : undefined;
  const native = c ? loadNative(c.c, HOST, c.pkgs) : undefined;
  // §15.4 (2): a foreign trap (a C thread's, or an isolate's) is polled at every task boundary
  // (emit wraps each await in rt.task; Port.recv checks too). The first one recorded wins.
  rt.setForeignTrapCheck(() => {
    if (native) {
      const v = native.sts_poll!();
      if (Array.isArray(v)) rt.trap(`T${String(v[0]).padStart(3, "0")}` as rt.TrapCode, "trap in C", v[1] ? { file: v[1] as string, line: v[2] as number, col: v[3] as number } : undefined);
    }
    const t = rt.takeIsolateTrap();
    if (t) rt.trap(t.code as rt.TrapCode, t.message ?? "trap in an isolate", t.file ? { file: t.file, line: t.line!, col: t.col! } : undefined);
  });
  const emitted = new Map(files.map((f) => [f.path, emitFile(f, displayPath(f.path), tests && f.path === entry, c?.keys as Map<never, string> | undefined, decls?.isolateEntries.get(f.path))]));
  const npm = new Map<string, unknown>();
  for (const [path, e] of emitted) {
    for (const spec of e.imports) {
      if (!spec.startsWith("npm:") || npm.has(spec)) continue;
      const name = spec.slice(4);
      let url = name;
      try { url = pathToFileURL(createRequire(path).resolve(name)).href; } catch { /* shortcut: fall back to Node's own resolution from the compiler */ }
      try { npm.set(spec, await import(url)); } catch (e) {
        if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") throw new CliError(`cannot resolve '${spec}'`); // Q252
        throw e;
      }
    }
  }
  // Q035: stack exhaustion is reported at the innermost source call found in the JS stack.
  const frame = new RegExp(`${SOURCE_URL}(.+?):(\\d+):(\\d+)\\)?$`, "gm");
  rt.setStackLocator((e) => {
    for (const m of (e.stack ?? "").matchAll(frame)) {
      const p = emitted.get(m[1]!)?.calls.get(`${m[2]}:${m[3]}`);
      if (p) return p;
    }
    return undefined;
  });
  // §15.2: an isolate loads this same program in a Worker; the runtime keeps what it needs here.
  rt.setIsolateProgram({
    files: [...emitted].map(([path, e]) => [path, { js: e.js, imports: e.imports, calls: [...e.calls] }] as [string, { js: string; imports: string[]; calls: [string, rt.Pos][] }]),
    runtimeUrl: new URL("../../runtime-js/src/index.ts", import.meta.url).href,
    stdUrl: new URL("../../std/src/index.ts", import.meta.url).href,
    nativePath: native ? (nativePathOf(native) ?? null) : null,
    rtName: RT, impName: IMP, exportsName: EXPORTS,
    framePattern: frame.source,
  });
  const done = new Map<string, Record<string, unknown>>();
  const instantiate = (path: string): Record<string, unknown> => {
    let ex = done.get(path);
    if (ex) return ex;
    // Q100: the module fills `ex` with its function declarations before its imports run, so an import cycle sees them.
    ex = {};
    done.set(path, ex);
    const f = new Function(RT, IMP, EXPORTS, emitted.get(path)!.js) as (rt: unknown, imp: (k: string) => unknown, ex: Record<string, unknown>) => Record<string, unknown>;
    f(native ? { ...RUNTIME, native } : RUNTIME, (k) => (k.startsWith("npm:") ? npm.get(k) : instantiate(k)), ex);
    return ex;
  };
  return { ex: instantiate(entry), native };
}

/** The runtime object generated code receives: runtime-js plus the std fakes. */
const RUNTIME = { ...rt, FakeClock, SeededRandom, MemoryLog, FakeFs, TestAlloc };

/** D060: the stack locator, the test registry and the unhandled-rejection sink are per process, so runs in one process are queued. */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(f: () => Promise<T>): Promise<T> {
  const r = queue.then(f);
  queue = r.catch(() => undefined);
  return r;
}

/** `load`, then rethrows an unhandled rejection of the module bodies (Q140). */
async function loadChecked(files: ParsedFile[], entryFile: string, tests: boolean, decls?: Decls, backend?: Backend): Promise<{ ex: Record<string, unknown>; native: Record<string, (...a: unknown[]) => unknown> | undefined }> {
  let out: { ex: Record<string, unknown>; native: Record<string, (...a: unknown[]) => unknown> | undefined } = { ex: {}, native: undefined };
  const rejected = await rt.capturing(async () => { out = await load(files, entryFile, tests, decls, backend); });
  if (rejected.length) throw rejected[0];
  return out;
}

/** Q061: `sts run` entry must be an exported managed `function main(sys: System): void | Promise<void>`. */
function checkMain(decls: Decls, entryFile: string): void {
  const mod = decls.mods.find((m) => m.pf.path === canonPath(entryFile));
  const local = mod?.exports.get("main");
  const sym = local !== undefined ? decls.lookupValue(mod!, local) : undefined;
  if (sym?.k !== "fn") throw new Error(`${entryFile}: no exported function 'main'`);
  const { layer, sig } = sym;
  const p0 = sig.params[0];
  const retOk = (sig.ret.k === "prim" && sig.ret.name === "void") ||
    (sig.ret.k === "gen" && sig.ret.name === "Promise" && sig.ret.args[0]?.k === "prim" && sig.ret.args[0].name === "void");
  if (layer !== "managed" || sig.tparams.length !== 0 || sig.params.length !== 1 || p0?.k !== "opaque" || p0.name !== "System" || !retOk) {
    throw new Error(`${entryFile}: invalid 'main' (must be managed '(sys: System): void | Promise<void>')`);
  }
}

/** Checks, emits and runs `main(sys)` of the entry file with a real System (Q059, Q061). */
export const run = (entryFile: string, opts: RunOptions = {}): Promise<RunResult> => exclusive(() => runNow(entryFile, opts.backend));
async function runNow(entryFile: string, backend?: Backend): Promise<RunResult> {
  const a = analyze(entryFile);
  if (a.diagnostics.length) return { diagnostics: a.diagnostics, stdout: "", trap: null };
  const e4009 = backend !== "c" ? cOnlyDiagnostic(a.files, a.unsafeOps ?? []) : undefined; // §14.7
  if (e4009) return { diagnostics: [e4009], stdout: "", trap: null };
  checkMain(a.decls!, entryFile);
  const { ex, native } = await loadChecked(a.files, entryFile, false, a.decls, backend);
  const main = ex.main;
  if (typeof main !== "function") throw new Error(`${entryFile}: no exported function 'main'`); // Q061: a CLI error, not a diagnostic
  const r = await runMain(main as Parameters<typeof runMain>[0]);
  await rt.stopIsolates(); // Q207: main ending stops isolates still running; undelivered messages are discarded
  // §14.6 / §15.4 (3), D144: main ending, by a trap too, raises the end flag. A foreign trap that
  // never surfaced was recorded first, so it is the reported one; only then main's own trap.
  const v = native?.sts_finish!();
  const t = rt.takeIsolateTrap();
  // Only stack exhaustion outside any source call (Q035) has no position.
  const trap = t ? { code: t.code, file: t.file ?? "", line: t.line ?? 0, col: t.col ?? 0 }
    : Array.isArray(v) ? { code: `T${String(v[0]).padStart(3, "0")}`, file: v[1] as string, line: v[2] as number, col: v[3] as number }
    : r.trap ? { code: r.trap.code, file: r.trap.pos?.file ?? "", line: r.trap.pos?.line ?? 0, col: r.trap.pos?.col ?? 0 } : null;
  return { diagnostics: [], stdout: r.stdout, trap };
}

/** `sts test`: checks, emits the entry file's `test(...)` calls and runs them in order (§9.2, D022). */
export const runTestFile = (entryFile: string, opts: RunOptions = {}): Promise<{ diagnostics: Diagnostic[]; results: rt.TestResult[] }> => exclusive(() => runTestFileNow(entryFile, opts.backend));
async function runTestFileNow(entryFile: string, backend?: Backend): Promise<{ diagnostics: Diagnostic[]; results: rt.TestResult[] }> {
  const a = analyze(entryFile);
  if (a.diagnostics.length) return { diagnostics: a.diagnostics, results: [] };
  const e4009 = backend !== "c" ? cOnlyDiagnostic(a.files, a.unsafeOps ?? []) : undefined; // §14.7
  if (e4009) return { diagnostics: [e4009], results: [] };
  rt.clearTests();
  await loadChecked(a.files, entryFile, true, a.decls, backend);
  try { return { diagnostics: [], results: await rt.runTests() }; } finally { rt.clearTests(); }
}
