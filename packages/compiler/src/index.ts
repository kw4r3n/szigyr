import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Diagnostic, RunResult } from "./diagnostics.ts";
import { createParser, SyntaxKind, type Node, type ParsedFile, type Parser, type ts } from "./parse.ts";
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
export { createParser, type Parser } from "./parse.ts";

/** A user input mistake the CLI reports without a stack, exit 2 (Q252). */
export class CliError extends Error {}

/** Entry file plus every file reachable through relative static imports, parsed with one tsgo process. */
interface Program {
  files: ParsedFile[];
  /** E7001 for relative imports whose file does not exist (Q009). */
  missing: Diagnostic[];
}

/** D161: the relative `.ts` specifiers a source text names, found without parsing (a candidate may sit in a comment or a string; the AST rounds below decide what is imported). */
const SPEC = /\b(?:from|import)\s*["'](\.\.?\/[^"'\n]*\.ts)["']/g;

/** One tsgo process (the caller's `shared` one, kept open for the next file, or its own). */
function loadProgram(entryFile: string, shared?: Parser): Program {
  const parser = shared ?? createParser();
  const files = new Map<string, ParsedFile>();
  const missing: Diagnostic[] = [];
  try {
    const entryPath = canonPath(entryFile);
    const entry = parser.parse([entryPath]).get(entryPath);
    if (!entry) throw new Error(`cannot read ${entryFile}`);
    files.set(entry.path, entry);
    // D161: every file the import chain may reach is parsed in one call, not one call per depth (each call re-sends every open file to tsgo: O(depth^2)).
    const pre = new Map<string, ParsedFile>([[entry.path, entry]]);
    const todo = [entry.path], texts = new Set([entry.path]);
    for (let p = todo.pop(); p !== undefined; p = todo.pop()) {
      let text: string;
      try { text = pre.get(p)?.sourceFile.text ?? readFileSync(p, "utf8"); } catch { continue; }
      for (const m of text.matchAll(SPEC)) {
        const q = canonPath(dirname(p), m[1]!);
        if (!texts.has(q)) { texts.add(q); todo.push(q); }
      }
    }
    for (const [p, pf] of parser.parse([...texts].filter((p) => p !== entry.path))) pre.set(p, pf);
    const parse = (ps: string[]): Map<string, ParsedFile> => {
      const rest = ps.filter((p) => !pre.has(p));
      const got = rest.length ? parser.parse(rest) : new Map<string, ParsedFile>();
      return new Map(ps.flatMap((p) => { const pf = pre.get(p) ?? got.get(p); return pf ? [[p, pf] as const] : []; }));
    };
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
      const got = parse([...wanted.keys()]);
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
    if (!shared) parser.close();
  }
  return { files: [...files.values()], missing };
}

const displayPath = (p: string): string => relative(process.cwd(), p) || p;

/** Phases run in order P1 -> P2 -> P3 and stop at the first phase with an error (Q003). */
export function check(entryFile: string, parser?: Parser): Diagnostic[] {
  const a = analyze(entryFile, parser);
  return [...a.diagnostics, ...(a.warnings ?? [])];
}

export interface Analysis { files: ParsedFile[]; diagnostics: Diagnostic[]; warnings?: Diagnostic[]; decls?: Decls; unsafeOps?: { mod: Module; node: Node }[] }

/** P1 + P2 + P3 over the program; on success the expression types are in `exprTypes` for the emitter. */
export function analyze(entryFile: string, parser?: Parser): Analysis {
  const prog = loadProgram(entryFile, parser);
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
/** `analysis`: the result of `analyze` for this entry file, reused instead of analysing again (D162: `--backend=both` runs both backends over one analysis). */
export interface RunOptions { backend?: Backend; analysis?: Analysis }

/** Q265: the cause an isolate's abnormal end recorded (no position, not a Trap); the foreign-trap check below rethrows it as main's own trap. */
let isolateCause: string | undefined;

/** Emits every file and evaluates them as module factories in memory (D031). Returns the entry's exports and, for a C backend program, its native module. */
async function load(files: ParsedFile[], entryFile: string, tests: boolean, decls?: Decls, backend: Backend = "js"): Promise<{ ex: Record<string, unknown>; native: Record<string, (...a: unknown[]) => unknown> | undefined }> {
  const entry = canonPath(entryFile);
  isolateCause = undefined;
  rt.takeIsolateTrap(); // D144: a record a previous program in this process left behind is not this program's
  const c = backend === "c" && decls ? emitC(decls) : undefined;
  const native = c ? loadNative(c.c, rt.NATIVE_HOST, c.pkgs) : undefined;
  // §15.4 (2): a foreign trap (a C thread's, or an isolate's) is polled at every task boundary
  // (emit wraps each await in rt.task; Port.recv checks too). The first one recorded wins.
  rt.setForeignTrapCheck(() => {
    if (native) {
      const v = native.sts_poll!();
      if (Array.isArray(v)) rt.trap(`T${String(v[0]).padStart(3, "0")}` as rt.TrapCode, "trap in C", v[1] ? { file: v[1] as string, line: v[2] as number, col: v[3] as number } : undefined);
    }
    const t = rt.takeIsolateTrap();
    if (t) { isolateCause = t.message; rt.trap(t.code as rt.TrapCode, t.message ?? "trap in an isolate", t.file ? { file: t.file, line: t.line!, col: t.col! } : undefined); }
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
export const run = (entryFile: string, opts: RunOptions = {}): Promise<RunResult> => exclusive(() => runNow(entryFile, opts.backend, opts.analysis));
async function runNow(entryFile: string, backend?: Backend, analysis?: Analysis): Promise<RunResult> {
  const a = analysis ?? analyze(entryFile);
  if (a.diagnostics.length) return { diagnostics: a.diagnostics, stdout: "", trap: null };
  const e4009 = backend !== "c" ? cOnlyDiagnostic(a.files, a.unsafeOps ?? []) : undefined; // §14.7
  if (e4009) return { diagnostics: [e4009], stdout: "", trap: null };
  checkMain(a.decls!, entryFile);
  const { ex, native } = await loadChecked(a.files, entryFile, false, a.decls, backend);
  const main = ex.main;
  if (typeof main !== "function") throw new Error(`${entryFile}: no exported function 'main'`); // Q061: a CLI error, not a diagnostic
  // §14.6 / §15.4, D144: main ending, by a trap too, raises the end flag at once, before any later task
  // runs, and claims the C record. A C record there claimed the flag before main ended, so it wins over
  // main's own trap; a C trap after that is never recorded (§15.4: not observed after main ends).
  let v: unknown;
  const finish = (): void => { v ??= native?.sts_finish!() ?? null; };
  const m = main as (sys: unknown) => unknown;
  const r = await runMain((sys) => {
    let p: unknown;
    try { p = m(sys); } catch (e) { finish(); throw e; }
    if (p instanceof Promise) return p.finally(finish);
    finish();
    return p as void;
  });
  await rt.stopIsolates(); // Q207: main ending stops isolates still running; undelivered messages are discarded
  // §15.4 (3): an isolate record may have landed after main trapped (stopIsolates lets messages land), so it does not beat main's own.
  const t = rt.takeIsolateTrap();
  const c = Array.isArray(v) ? { code: `T${String(v[0]).padStart(3, "0")}`, file: v[1] as string, line: v[2] as number, col: v[3] as number } : null;
  const iso = t ? { code: t.code, file: t.file ?? "", line: t.line ?? 0, col: t.col ?? 0, ...(t.message ? { message: t.message } : {}) } : null; // Q265: only an isolate record carries a message
  // Only stack exhaustion outside any source call (Q035) has no position.
  const own = r.trap ? { code: r.trap.code, file: r.trap.pos?.file ?? "", line: r.trap.pos?.line ?? 0, col: r.trap.pos?.col ?? 0, ...(isolateCause && r.trap.message === `${r.trap.code}: ${isolateCause}` ? { message: isolateCause } : {}) } : null;
  const trap = own ? (c ?? own) : (iso ?? c);
  return { diagnostics: [], stdout: r.stdout, trap };
}

/** `sts test`: checks, emits the entry file's `test(...)` calls and runs them in order (§9.2, D022). */
export const runTestFile = (entryFile: string, opts: RunOptions = {}): Promise<{ diagnostics: Diagnostic[]; results: rt.TestResult[] }> => exclusive(() => runTestFileNow(entryFile, opts.backend, opts.analysis));
async function runTestFileNow(entryFile: string, backend?: Backend, analysis?: Analysis): Promise<{ diagnostics: Diagnostic[]; results: rt.TestResult[] }> {
  const a = analysis ?? analyze(entryFile);
  if (a.diagnostics.length) return { diagnostics: a.diagnostics, results: [] };
  const e4009 = backend !== "c" ? cOnlyDiagnostic(a.files, a.unsafeOps ?? []) : undefined; // §14.7
  if (e4009) return { diagnostics: [e4009], results: [] };
  rt.clearTests();
  await loadChecked(a.files, entryFile, true, a.decls, backend);
  try { return { diagnostics: [], results: await rt.runTests() }; } finally { rt.clearTests(); }
}
