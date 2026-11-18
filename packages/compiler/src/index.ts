import { dirname, relative, resolve } from "node:path";
import type { Diagnostic, RunResult } from "./diagnostics.ts";
import { createParser, SyntaxKind, type ParsedFile, type ts } from "./parse.ts";
import { checkSyntax } from "./syntax.ts";
import { Program as Decls, Reporter, checkImportNames } from "./modules.ts";
import { Checker } from "./checker.ts";
import { isDeterministic } from "./determinism.ts";
import { emitFile, EXPORTS, IMP, RT, SOURCE_URL } from "./emit.ts";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as rt from "../../runtime-js/src/index.ts";
import { FakeClock, FakeFs, MemoryLog, SeededRandom, TestAlloc, runMain } from "../../std/src/index.ts";
export * from "./diagnostics.ts";
export * from "./names.ts";

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented`);
    this.name = "NotImplementedError";
  }
}

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
    const entry = parser.parse([entryFile]).get(resolve(entryFile));
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
          const p = resolve(dirname(pf.path), t);
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
  } finally {
    parser.close();
  }
  return { files: [...files.values()], missing };
}

const displayPath = (p: string): string => relative(process.cwd(), p) || p;

/** Phases run in order P1 -> P2 -> P3 and stop at the first phase with an error (Q003). P3 does not exist yet. */
export function check(entryFile: string): Diagnostic[] {
  return analyze(entryFile).diagnostics;
}

/** P1 + P2 over the program; on success the expression types are in `exprTypes` for the emitter. */
function analyze(entryFile: string): { files: ParsedFile[]; diagnostics: Diagnostic[] } {
  const prog = loadProgram(entryFile);
  const p1 = [...prog.missing, ...prog.files.flatMap((f) => checkSyntax(f, displayPath(f.path)))];
  if (!p1.length) p1.push(...checkImportNames(prog.files, displayPath));
  if (p1.length) return { files: prog.files, diagnostics: p1 };
  const rep = new Reporter();
  new Checker(new Decls(prog.files, displayPath, rep)).run();
  return { files: prog.files, diagnostics: rep.out };
}

/** §7.3 query (Q062): for each top-level function of the entry file, whether it is deterministic. Assumes P1 passes. */
export function deterministicFunctions(entryFile: string): Record<string, boolean> {
  const prog = loadProgram(entryFile);
  const decls = new Decls(prog.files, displayPath, new Reporter());
  const entry = decls.mods.find((m) => m.pf.path === resolve(entryFile))!;
  return Object.fromEntries(decls.fns.filter((f) => f.mod === entry).map((f) => [f.name, isDeterministic(f.sig)]));
}

/** Emits every file and evaluates them as module factories in memory (D031). Returns the entry's exports. */
async function load(files: ParsedFile[], entryFile: string, tests: boolean): Promise<Record<string, unknown>> {
  const entry = resolve(entryFile);
  const emitted = new Map(files.map((f) => [f.path, emitFile(f, displayPath(f.path), tests && f.path === entry)]));
  const npm = new Map<string, unknown>();
  for (const [path, e] of emitted) {
    for (const spec of e.imports) {
      if (!spec.startsWith("npm:") || npm.has(spec)) continue;
      const name = spec.slice(4);
      let url = name;
      try { url = pathToFileURL(createRequire(path).resolve(name)).href; } catch { /* shortcut: fall back to Node's own resolution from the compiler */ }
      npm.set(spec, await import(url));
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
  const done = new Map<string, Record<string, unknown>>();
  const instantiate = (path: string): Record<string, unknown> => {
    let ex = done.get(path);
    if (ex) return ex;
    // Q100: the module fills `ex` with its function declarations before its imports run, so an import cycle sees them.
    ex = {};
    done.set(path, ex);
    const f = new Function(RT, IMP, EXPORTS, emitted.get(path)!.js) as (rt: unknown, imp: (k: string) => unknown, ex: Record<string, unknown>) => Record<string, unknown>;
    f(RUNTIME, (k) => (k.startsWith("npm:") ? npm.get(k) : instantiate(k)), ex);
    return ex;
  };
  return instantiate(entry);
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
async function loadChecked(files: ParsedFile[], entryFile: string, tests: boolean): Promise<Record<string, unknown>> {
  let ex: Record<string, unknown> = {};
  const rejected = await rt.capturing(async () => { ex = await load(files, entryFile, tests); });
  if (rejected.length) throw rejected[0];
  return ex;
}

/** Checks, emits and runs `main(sys)` of the entry file with a real System (Q059, Q061). */
export const run = (entryFile: string): Promise<RunResult> => exclusive(() => runNow(entryFile));
async function runNow(entryFile: string): Promise<RunResult> {
  const a = analyze(entryFile);
  if (a.diagnostics.length) return { diagnostics: a.diagnostics, stdout: "", trap: null };
  const main = (await loadChecked(a.files, entryFile, false)).main;
  if (typeof main !== "function") throw new Error(`${entryFile}: no exported function 'main'`); // Q061: a CLI error, not a diagnostic
  const r = await runMain(main as Parameters<typeof runMain>[0]);
  // Only stack exhaustion outside any source call (Q035) has no position.
  const trap = r.trap ? { code: r.trap.code, file: r.trap.pos?.file ?? "", line: r.trap.pos?.line ?? 0, col: r.trap.pos?.col ?? 0 } : null;
  return { diagnostics: [], stdout: r.stdout, trap };
}

/** `sts test`: checks, emits the entry file's `test(...)` calls and runs them in order (§9.2, D022). */
export const runTestFile = (entryFile: string): Promise<{ diagnostics: Diagnostic[]; results: rt.TestResult[] }> => exclusive(() => runTestFileNow(entryFile));
async function runTestFileNow(entryFile: string): Promise<{ diagnostics: Diagnostic[]; results: rt.TestResult[] }> {
  const a = analyze(entryFile);
  if (a.diagnostics.length) return { diagnostics: a.diagnostics, results: [] };
  rt.clearTests();
  await loadChecked(a.files, entryFile, true);
  try { return { diagnostics: [], results: await rt.runTests() }; } finally { rt.clearTests(); }
}
