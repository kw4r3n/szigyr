// Stage 4-2..4: `sts mutate` mutation testing engine (SPEC §16.2, Q275–Q277).
// JS-only execution with 1-build runtime mutant switches, per-test reachability,
// step-fuel timeout abortion, per-function diff caching, and shrunk witness search.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyze, CliError, type Analysis } from "./index.ts";
import type { Diagnostic, Range } from "./diagnostics.ts";
import { SyntaxKind as K, isId, type Node, type ParsedFile, type Parser, type ts } from "./parse.ts";
import { assignTarget, callFns, exprTypes, forAllMeta, isolateCalls, localOf } from "./expr.ts";
import { sliceGroups, type SliceGroupEntry } from "./ownership.ts";
import { elemDesc } from "./layout.ts";
import { emitGenDesc, genDescOf, isGeneratable } from "./gendesc.ts";
import { canonPath, declBindings, type FnSym, type Module, type Program as Decls } from "./modules.ts";
import { isDeterministic } from "./determinism.ts";
import {
  NUM_NAMES, field, isInt, isStr, literalFits, movesLike, nonNull, resultParts, same, unref,
  type FnType, type NumName, type Type,
} from "./types.ts";
import { CLI_NAME, RUNTIME_GLOBAL } from "./names.ts";
import { DETMATH_PATH, dmBinding } from "./detmath.ts";
import * as rt from "../../runtime-js/src/index.ts";
import { FakeClock, FakeFs, MemoryLog, SeededRandom, TestAlloc } from "../../std/src/index.ts";

const MUTATE_VERSION = "1";
const RT = RUNTIME_GLOBAL;
const IMP = `${RUNTIME_GLOBAL}_imp`;
const EXPORTS = `${RUNTIME_GLOBAL}_ex`;
const SOURCE_URL = `${CLI_NAME}:`;
const MARK = `${RUNTIME_GLOBAL}@`;
const P = `${RUNTIME_GLOBAL}_P`, AP = `${RUNTIME_GLOBAL}_ap`, ENS = `${RUNTIME_GLOBAL}_ens`;
const O = `${RUNTIME_GLOBAL}_o`, KEY = `${RUNTIME_GLOBAL}_k`, V = `${RUNTIME_GLOBAL}_v`, R = `${RUNTIME_GLOBAL}_r`;
const MUT_FNS = `${RUNTIME_GLOBAL}_mutFns`;
const RT_NAMESPACES = ["Vec", "Pool", "Arena", "Ring", "OwnedCell", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs", "TestAlloc"];
const DROP_MODS = new Set<K>([K.ExportKeyword, K.ReadonlyKeyword, K.PrivateKeyword, K.PublicKeyword, K.ProtectedKeyword, K.DeclareKeyword, K.AbstractKeyword, K.OverrideKeyword]);
const COMPOUND: Partial<Record<K, string>> = {
  [K.PlusEqualsToken]: "+", [K.MinusEqualsToken]: "-", [K.AsteriskEqualsToken]: "*",
  [K.SlashEqualsToken]: "/", [K.PercentEqualsToken]: "%", [K.AsteriskAsteriskEqualsToken]: "**",
};
const THROWING: Record<string, readonly string[]> = {
  JSON: ["stringify"], String: ["fromCodePoint"],
  string: ["padStart", "padEnd", "replaceAll", "toUpperCase", "toLowerCase"],
  Array: ["push", "concat", "join"], ReadonlyArray: ["concat", "join"], Map: ["set"], Set: ["add"],
};
const INT_OP: Record<string, string> = { "+": "add", "-": "sub", "*": "mul" };
const ARITH_MUT: Record<string, string> = { "+": "-", "-": "+", "*": "+" };
const CMP_MUT: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">", "===": "!==", "!==": "===" };
const LOGIC_MUT: Record<string, string> = { "&&": "||", "||": "&&" };

export interface Witness {
  readonly args: unknown[];
  readonly base: unknown;
  readonly mutant: unknown;
}

export interface MutantReport {
  readonly file: string;
  readonly fn: string;
  readonly id: number;
  readonly op: string;
  readonly range: Range;
  readonly status: "killed" | "survived" | "timeout";
  readonly cached: boolean;
  readonly deadCode?: true;
  readonly witness?: Witness | null;
}

export interface MutateSummary {
  readonly killed: number;
  readonly survived: number;
  readonly timeout: number;
  readonly cached: number;
}

export interface BaselineFailure {
  readonly file: string;
  readonly name: string;
  readonly failure: string;
  readonly trap?: string;
  readonly pos?: rt.Pos;
}

export interface MutateResult {
  readonly diagnostics: Diagnostic[];
  readonly baselineFailure: BaselineFailure | null;
  readonly mutants: MutantReport[];
  readonly summary: MutateSummary;
}

export interface MutateOptions {
  /** Read/write `.sts-cache/mutate.json` (default: true). */
  cache?: boolean;
  /** Override cache file path (default: `.sts-cache/mutate.json` in cwd). */
  cacheFile?: string;
  /** Shared parser instance (D161). */
  parser?: Parser;
  /** Pre-computed analysis. */
  analysis?: Analysis;
}

/** Thrown by `c:` import stubs and `"use unsafe"` stubs during JS-only mutation execution (Q275). */
class COnlyReached extends Error { constructor() { super("C-only code reached"); } }
/** Thrown when step fuel exceeds limit (Q276). */
class StepLimitReached extends Error { constructor() { super("step limit reached"); } }
/** Thrown only when the witness-tested target function's OWN leading `requires` fails at depth 1 (Q277). */
class OwnRequiresTrap extends rt.Trap { constructor(pos?: rt.Pos) { super("T004", "requires violated", pos); } }

interface MutantSpec {
  id: number;
  fnId: number;
  fn: string;
  op: string;
  range: Range;
  isDeleteStmt: boolean;
}

interface CacheEntry {
  key: string;
  results: { op: string; status: "killed" | "survived" | "timeout"; deadCode?: true; witness?: Witness | null }[];
}
type CacheStore = Record<string, CacheEntry>;

const displayPath = (p: string): string => relative(process.cwd(), p) || p;

/** Main entry for `sts mutate` on a single file (called inside `exclusive` from `index.ts`). */
export async function mutateFile(entryFile: string, opts: MutateOptions = {}): Promise<MutateResult> {
  const emptySummary: MutateSummary = { killed: 0, survived: 0, timeout: 0, cached: 0 };
  const a = opts.analysis ?? analyze(entryFile, opts.parser);
  if (a.diagnostics.length) return { diagnostics: a.diagnostics, baselineFailure: null, mutants: [], summary: emptySummary };

  const decls = a.decls!;
  const entryPath = canonPath(entryFile);
  const entryMod = decls.mods.find((m) => m.pf.path === entryPath)!;
  const entryDisplay = displayPath(entryPath);

  // Q275: target functions are top-level `function` declarations in this file that are safe and §7.3 deterministic.
  const targets: { fnId: number; sym: FnSym }[] = [];
  for (const f of decls.fns) {
    if (f.mod === entryMod && !f.unsafe && isDeterministic(f.sig, false)) {
      targets.push({ fnId: targets.length, sym: f });
    }
  }
  const targetByDecl = new Map<Node, number>(targets.map((t) => [t.sym.decl, t.fnId]));
  const unsafeDecls = new Set<Node>(decls.fns.filter((f) => f.unsafe).map((f) => f.decl));

  // Emit ONE JS build containing all mutants, reachability hooks, step fuel, and C-only stubs.
  const allMutants: MutantSpec[] = [];
  const nextMutId = (): number => allMutants.length + 1;
  const emitted = new Map<string, EmittedMut>();
  for (const pf of a.files) {
    const isEntry = pf.path === entryPath;
    emitted.set(
      pf.path,
      emitForMutate(
        pf,
        displayPath(pf.path),
        isEntry,
        isEntry ? targetByDecl : new Map(),
        unsafeDecls,
        allMutants,
        nextMutId,
        isEntry ? targets.map((t) => t.sym.name) : [],
      ),
    );
  }

  // Resolve npm: imports (same as index.ts).
  const npm = new Map<string, unknown>();
  for (const [path, e] of emitted) {
    for (const spec of e.imports) {
      if (!spec.startsWith("npm:") || npm.has(spec)) continue;
      const name = spec.slice(4);
      let url = name;
      try { url = pathToFileURL(createRequire(path).resolve(name)).href; } catch { /* fall back to Node resolution */ }
      try { npm.set(spec, await import(url)); } catch (err) {
        if ((err as { code?: string }).code === "ERR_MODULE_NOT_FOUND") throw new CliError(`cannot resolve '${spec}'`);
        throw err;
      }
    }
  }

  // Set stack locator for T006 stack-exhaustion traps.
  const frame = new RegExp(`${SOURCE_URL}(.+?):(\\d+):(\\d+)\\)?$`, "gm");
  rt.setStackLocator((e) => {
    for (const m of (e.stack ?? "").matchAll(frame)) {
      const p = emitted.get(m[1]!)?.calls.get(`${m[2]}:${m[3]}`);
      if (p) return p;
    }
    return undefined;
  });
  rt.setForeignTrapCheck(undefined);

  // Per-run isolated runtime state (mutant switch, reachability, step fuel, own-requires watch, local test registry).
  type TestFn = (t: rt.Test) => void | Promise<void>;
  const registeredTests: { name: string; fn: TestFn }[] = [];
  const mutState = {
    m: 0,
    steps: 0,
    stepLimit: Infinity,
    recording: false,
    reached: new Set<number>(),
    watchFn: -1,
    watchDepth: 0,
  };

  const mutRt = {
    ...rt,
    FakeClock, SeededRandom, MemoryLog, FakeFs, TestAlloc,
    get m(): number { return mutState.m; },
    test(name: string, fn: TestFn): void { registeredTests.push({ name, fn }); },
    hit(fnId: number): void { if (mutState.recording) mutState.reached.add(fnId); },
    step(): void { if (++mutState.steps > mutState.stepLimit) throw new StepLimitReached(); },
    cOnly(): never { throw new COnlyReached(); },
    enter(fnId: number): void { if (mutState.watchFn === fnId) mutState.watchDepth++; },
    leave(fnId: number): void { if (mutState.watchFn === fnId) mutState.watchDepth--; },
    ownReq(fnId: number, cond: boolean, pos?: rt.Pos): void {
      if (!cond) {
        if (mutState.watchFn === fnId && mutState.watchDepth === 1) throw new OwnRequiresTrap(pos);
        rt.trap("T004", "requires violated", pos);
      }
    },
    guarded(recv: unknown, name: string, args: unknown[], pos?: rt.Pos): unknown {
      try {
        return (recv as Record<string, (...a: unknown[]) => unknown>)[name]!(...args);
      } catch (e) {
        if (e instanceof rt.Trap || e instanceof COnlyReached || e instanceof StepLimitReached) throw e;
        return rt.trap("T006", `${name}: ${e instanceof Error ? e.message : String(e)}`, pos);
      }
    },
    mArith(id: number, t: string, orig: string, mut: string, l: number, r: number, pos?: rt.Pos): number {
      const o = mutState.m === id ? mut : orig;
      if (t !== "f32" && t !== "f64") {
        if (o === "+") return rt.add(t as rt.IntType, l, r, pos);
        if (o === "-") return rt.sub(t as rt.IntType, l, r, pos);
        return rt.mul(t as rt.IntType, l, r, pos);
      }
      const res = o === "+" ? l + r : o === "-" ? l - r : l * r;
      return t === "f32" ? rt.f32(res) : res;
    },
    mCmp(id: number, orig: string, mut: string, l: unknown, r: unknown): boolean {
      const o = mutState.m === id ? mut : orig;
      switch (o) {
        case "<": return (l as number) < (r as number);
        case "<=": return (l as number) <= (r as number);
        case ">": return (l as number) > (r as number);
        case ">=": return (l as number) >= (r as number);
        case "===": return l === r;
        default: return l !== r;
      }
    },
    mLogic(id: number, orig: string, fa: () => boolean, fb: () => boolean): boolean {
      const o = mutState.m === id ? (orig === "&&" ? "||" : "&&") : orig;
      const a = fa();
      return o === "&&" ? (a && fb()) : (a || fb());
    },
    async mLogicAsync(id: number, orig: string, fa: () => Promise<boolean>, fb: () => Promise<boolean>): Promise<boolean> {
      const o = mutState.m === id ? (orig === "&&" ? "||" : "&&") : orig;
      const a = await fa();
      return o === "&&" ? (a && (await fb())) : (a || (await fb()));
    },
  };

  // Instantiate entry module and dependencies.
  const done = new Map<string, Record<string, unknown>>();
  const instantiate = (path: string): Record<string, unknown> => {
    let ex = done.get(path);
    if (ex) return ex;
    ex = {};
    done.set(path, ex);
    const f = new Function(RT, IMP, EXPORTS, emitted.get(path)!.js) as (r: unknown, imp: (k: string) => unknown, e: Record<string, unknown>) => Record<string, unknown>;
    f(mutRt, (k) => (k.startsWith("npm:") ? npm.get(k) : instantiate(k)), ex);
    return ex;
  };
  let entryEx: Record<string, unknown> = {};
  const loadRejected = await rt.capturing(async () => { entryEx = instantiate(entryPath); });
  if (loadRejected.length) throw loadRejected[0];

  const fnTable = (entryEx[MUT_FNS] ?? {}) as Record<string, (...args: unknown[]) => unknown>;

  // Map top-level `test(...)` statements in entry file to source text (1-to-1 with registeredTests, §1 / §9.2).
  const testSources: string[] = [];
  for (const s of entryMod.sf.statements) {
    if (s.kind === K.ExpressionStatement) {
      const ex = (s as ts.ExpressionStatement).expression;
      if (ex.kind === K.CallExpression && isId((ex as ts.CallExpression).expression) && ((ex as ts.CallExpression).expression as ts.Identifier).text === "test") {
        testSources.push(s.getText(entryMod.sf));
      }
    }
  }

  // Helper to run one test function cleanly.
  type RunOutcome = { ok: true } | { ok: false; kind: "conly" | "timeout" | "fail" | "trap"; failure?: string; trap?: string; pos?: rt.Pos };
  async function runOneTest(fn: TestFn, mId: number, limit: number, record: boolean): Promise<RunOutcome> {
    mutState.m = mId;
    mutState.steps = 0;
    mutState.stepLimit = limit;
    mutState.recording = record;
    mutState.reached = new Set();
    mutState.watchFn = -1;
    mutState.watchDepth = 0;
    try {
      const rejected = await rt.capturing(() => fn(new rt.Test()));
      if (rejected.length) throw rejected[0];
      return { ok: true };
    } catch (x) {
      if (x instanceof COnlyReached) return { ok: false, kind: "conly" };
      if (x instanceof StepLimitReached) return { ok: false, kind: "timeout" };
      const e = rt.asTrap(x);
      if (e) return { ok: false, kind: "trap", failure: e.message, trap: e.code, pos: e.pos };
      if (x instanceof Error && x.constructor.name === "Failure") {
        return { ok: false, kind: "fail", failure: x.message, pos: (x as { pos?: rt.Pos }).pos };
      }
      throw x; // unexpected internal error
    } finally {
      mutState.recording = false;
    }
  }

  // Q276: baseline m = 0 run. Collect reached functions and step count S per test.
  interface BaselineTest {
    name: string;
    source: string;
    fn: TestFn;
    steps: number;
    reached: Set<number>;
  }
  const activeTests: BaselineTest[] = [];
  for (let i = 0; i < registeredTests.length; i++) {
    const t = registeredTests[i]!;
    const out = await runOneTest(t.fn, 0, Infinity, true);
    if (!out.ok) {
      if (out.kind === "conly") continue; // Q275: skip tests that reach C-only code
      return {
        diagnostics: [],
        baselineFailure: { file: entryDisplay, name: t.name, failure: out.failure ?? out.kind, ...(out.trap ? { trap: out.trap } : {}), ...(out.pos ? { pos: out.pos } : {}) },
        mutants: [],
        summary: emptySummary,
      };
    }
    activeTests.push({ name: t.name, source: testSources[i] ?? "", fn: t.fn, steps: mutState.steps, reached: new Set(mutState.reached) });
  }

  // Cache load (Q277).
  const useCache = opts.cache !== false;
  const cacheFile = opts.cacheFile ?? resolve(".sts-cache", "mutate.json");
  const cacheStore: CacheStore = useCache ? readCache(cacheFile) : {};
  let cacheDirty = false;

  // Group collected mutants by target function.
  const mutantsByFn = new Map<number, MutantSpec[]>();
  for (const m of allMutants) {
    let list = mutantsByFn.get(m.fnId);
    if (!list) mutantsByFn.set(m.fnId, list = []);
    list.push(m);
  }

  const reports: MutantReport[] = [];
  for (const target of targets) {
    const fnMutants = mutantsByFn.get(target.fnId) ?? [];
    if (!fnMutants.length) continue;

    const reaching = activeTests.filter((t) => t.reached.has(target.fnId));
    const cacheId = `${entryPath}::${target.sym.name}`;
    const key = computeCacheKey(decls, target.sym, reaching);
    const hit = useCache ? cacheStore[cacheId] : undefined;

    if (hit && hit.key === key && hit.results.length === fnMutants.length && hit.results.every((r, i) => r.op === fnMutants[i]!.op)) {
      for (let i = 0; i < fnMutants.length; i++) {
        const spec = fnMutants[i]!;
        const cr = hit.results[i]!;
        reports.push({
          file: entryDisplay, fn: spec.fn, id: spec.id, op: spec.op, range: spec.range,
          status: cr.status, cached: true,
          ...(cr.deadCode ? { deadCode: true } : {}),
          ...(cr.status === "survived" ? { witness: cr.witness ?? null } : {}),
        });
      }
      continue;
    }

    const fnResults: CacheEntry["results"] = [];
    const fnImpl = fnTable[target.sym.name];
    for (const spec of fnMutants) {
      let status: "killed" | "survived" | "timeout" = "survived";
      for (const t of reaching) {
        const limit = Math.max(t.steps * 8 + 1000, 10_000);
        const out = await runOneTest(t.fn, spec.id, limit, false);
        if (!out.ok) {
          status = out.kind === "timeout" ? "timeout" : "killed";
          break;
        }
      }
      let witness: Witness | null | undefined;
      if (status === "survived") {
        witness = fnImpl ? await findWitness(target.sym, target.fnId, fnImpl, spec.id, mutState) : null;
      }
      const deadCode = status === "survived" && spec.isDeleteStmt ? true : undefined;
      fnResults.push({ op: spec.op, status, ...(deadCode ? { deadCode } : {}), ...(status === "survived" ? { witness: witness ?? null } : {}) });
      reports.push({
        file: entryDisplay, fn: spec.fn, id: spec.id, op: spec.op, range: spec.range,
        status, cached: false,
        ...(deadCode ? { deadCode } : {}),
        ...(status === "survived" ? { witness: witness ?? null } : {}),
      });
    }

    if (useCache) {
      cacheStore[cacheId] = { key, results: fnResults };
      cacheDirty = true;
    }
  }

  if (useCache && cacheDirty) writeCache(cacheFile, cacheStore);

  let killed = 0, survived = 0, timeout = 0, cached = 0;
  for (const r of reports) {
    if (r.status === "killed") killed++;
    else if (r.status === "timeout") timeout++;
    else survived++;
    if (r.cached) cached++;
  }
  return { diagnostics: [], baselineFailure: null, mutants: reports, summary: { killed, survived, timeout, cached } };
}

// ---- Diff cache (Q277)

function readCache(file: string): CacheStore {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CacheStore) : {};
  } catch { return {}; }
}

function writeCache(file: string, store: CacheStore): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2));
}

/** Q277: hash of (target fn + transitive callees source text, sorted [testName, testSource] reaching fn, version). */
function computeCacheKey(decls: Decls, target: FnSym, reaching: readonly { name: string; source: string }[]): string {
  const seen = new Set<string>();
  const parts: [string, string][] = [];
  const visitFn = (f: FnSym): void => {
    const id = `fn:${f.mod.pf.path}:${f.name}`;
    if (seen.has(id)) return;
    seen.add(id);
    parts.push([id, f.decl.getText(f.mod.sf)]);
    walkDeps(f.mod, f.decl.body);
  };
  const walkDeps = (mod: Module, root: Node | undefined): void => {
    if (!root) return;
    const visit = (n: Node): void => {
      if (n.kind === K.CallExpression) {
        const cf = callFns.get(n);
        if (cf) visitFn(cf);
      }
      if (isId(n) && !localOf.has(n)) {
        const p = n.parent;
        const isPropName = p?.kind === K.PropertyAccessExpression && (p as ts.PropertyAccessExpression).name === n;
        if (!isPropName) {
          const sym = decls.lookupValue(mod, n.text);
          if (sym?.k === "fn") visitFn(sym);
          else if (sym?.k === "const") {
            const cid = `const:${sym.mod.pf.path}:${n.text}`;
            if (!seen.has(cid)) { seen.add(cid); parts.push([cid, sym.decl.getText(sym.mod.sf)]); }
          } else if (sym?.k === "class") {
            const cid = `class:${sym.mod.pf.path}:${sym.cls.name}`;
            if (!seen.has(cid)) {
              seen.add(cid);
              parts.push([cid, sym.cls.decl.getText(sym.mod.sf)]);
              walkDeps(sym.mod, sym.cls.decl);
            }
          }
        }
      }
      n.forEachChild(visit);
    };
    visit(root);
  };
  visitFn(target);
  parts.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const tests = reaching.map((t) => [t.name, t.source] as [string, string]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify({ v: MUTATE_VERSION, parts, tests })).digest("hex");
}

// ---- Instrumented JS emitter (SPEC §10 + §16.2 Q275–Q276)

interface EmittedMut {
  js: string;
  imports: string[];
  calls: Map<string, rt.Pos>;
}

type AnyNode = Node & Record<string, unknown>;

const numValue = (n: ts.NumericLiteral): number => Number(n.text.replace(/_/g, ""));
const unwrapParens = (e: ts.Expression): ts.Expression => (e.kind === K.ParenthesizedExpression ? unwrapParens((e as ts.ParenthesizedExpression).expression) : e);
const isCaseExpr = (n: Node): boolean => n.parent?.kind === K.CaseClause && (n.parent as ts.CaseClause).expression === n;

function emitForMutate(
  pf: ParsedFile,
  file: string,
  tests: boolean,
  targetByDecl: Map<Node, number>,
  unsafeDecls: Set<Node>,
  allMutants: MutantSpec[],
  nextMutId: () => number,
  extraMutExports: string[],
): EmittedMut {
  const sf = pf.sourceFile, text = sf.text;
  const poss: string[] = [];
  const marks: rt.Pos[] = [];
  const mark = (n: Node): string => { const p = pf.position(n.getStart(sf)); marks.push({ file, line: p.line, col: p.col }); return `/*${MARK}${marks.length - 1}*/`; };
  const imports: string[] = [];
  const exported: string[] = [];
  const dmUsed = new Set<string>();
  let needAp = false;

  // Mutation context for the current target function.
  let curFnId = -1;
  let curFnName = "";
  let inContract = 0;
  let narrowedSyms = new Set<number>();
  let narrowedProps = new Set<string>();
  const canMutate = (): boolean => curFnId >= 0 && inContract === 0;

  const pos = (offset: number): string => {
    const p = pf.position(offset);
    poss.push(`{file:${JSON.stringify(file)},line:${p.line},col:${p.col}}`);
    return `${P}[${poss.length - 1}]`;
  };
  const at = (n: Node): string => pos(n.getStart(sf));
  const rangeOf = (n: Node): Range => ({ start: pf.position(n.getStart(sf)), end: pf.position(n.end) });
  const typeOf = (n: Node): Type | undefined => { const t = exprTypes.get(n); return t && unref(t); };
  const numName = (n: Node): string | undefined => { const t = typeOf(n); return t?.k === "num" ? t.name : undefined; };
  const skipWs = (i: number): number => { while (/\s/.test(text[i] ?? "")) i++; return i; };
  const q = (s: string): string => JSON.stringify(s);

  const addMutant = (opName: string, n: Node, isDeleteStmt = false): number => {
    const id = nextMutId();
    allMutants.push({ id, fnId: curFnId, fn: curFnName, op: opName, range: rangeOf(n), isDeleteStmt });
    return id;
  };

  /** Leading `requires(...)` precondition predicate for `forAll` (emitted with `inContract > 0` so never mutated). */
  const emitPreFn = (fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): string | undefined => {
    if (!fn.body || fn.body.kind !== K.Block) return undefined;
    const ss = (fn.body as ts.Block).statements;
    let i = 0;
    while (i < ss.length && ss[i]!.kind === K.ExpressionStatement && (ss[i] as ts.ExpressionStatement).expression.kind === K.StringLiteral) i++;
    const checks: string[] = [];
    inContract++;
    try {
      for (; i < ss.length; i++) {
        const s = ss[i]!;
        if (s.kind !== K.ExpressionStatement) break;
        const ex = (s as ts.ExpressionStatement).expression;
        if (ex.kind !== K.CallExpression || (ex as ts.CallExpression).expression.kind !== K.Identifier || ((ex as ts.CallExpression).expression as ts.Identifier).text !== "requires") break;
        checks.push(`if (!(${gen((ex as ts.CallExpression).arguments[0]!)})) return false;`);
      }
    } finally { inContract--; }
    if (!checks.length) return undefined;
    const ps = fn.parameters.map((p) => (p.name as ts.Identifier).text).join(", ");
    return `(${ps}) => { ${checks.join(" ")} return true; }`;
  };

  /** Collect symbols / readonly properties narrowed anywhere in `root`, so narrowing guards are never broken. */
  function scanNarrowing(root: Node): { syms: Set<number>; props: Set<string> } {
    const syms = new Set<number>(), props = new Set<string>();
    const visit = (n: Node): void => {
      if (n.kind === K.Identifier) {
        const s = localOf.get(n), t = exprTypes.get(n);
        if (s && t && !same(unref(t), unref(s.type))) syms.add(s.id);
      } else if (n.kind === K.PropertyAccessExpression) {
        const p = n as ts.PropertyAccessExpression;
        const ot = exprTypes.get(p.expression), pt = exprTypes.get(p);
        if (ot && pt) {
          const uo = unref(ot);
          const f = uo.k === "record" ? field(uo, p.name.text) : undefined;
          if (f && !same(unref(pt), unref(f.type))) props.add(p.name.text);
        }
      }
      n.forEachChild(visit);
    };
    visit(root);
    return { syms, props };
  }

  /** Whether expression `e` tests a narrowed local/property (`x === null`, `x.kind === "..."`, string-lit union). */
  function isNarrowedTarget(e: ts.Expression): boolean {
    const u = unwrapParens(e);
    if (isId(u)) { const s = localOf.get(u); return !!s && narrowedSyms.has(s.id); }
    if (u.kind === K.PropertyAccessExpression) {
      const p = u as ts.PropertyAccessExpression;
      return narrowedProps.has(p.name.text) || isNarrowedTarget(p.expression);
    }
    return false;
  }
  function hasActiveNarrowing(e: ts.Expression): boolean {
    const u = unwrapParens(e);
    if (u.kind === K.PrefixUnaryExpression && (u as ts.PrefixUnaryExpression).operator === K.ExclamationToken) return hasActiveNarrowing((u as ts.PrefixUnaryExpression).operand);
    if (u.kind !== K.BinaryExpression) return false;
    const b = u as ts.BinaryExpression, k = b.operatorToken.kind;
    if (k === K.AmpersandAmpersandToken || k === K.BarBarToken) return hasActiveNarrowing(b.left) || hasActiveNarrowing(b.right);
    if (k !== K.EqualsEqualsEqualsToken && k !== K.ExclamationEqualsEqualsToken) return false;
    for (const [x, y] of [[b.left, b.right], [b.right, b.left]] as const) {
      const ux = unwrapParens(x), uy = unwrapParens(y);
      if (uy.kind === K.NullKeyword && isNarrowedTarget(ux)) return true;
      if (uy.kind === K.StringLiteral) {
        if (ux.kind === K.PropertyAccessExpression && (ux as ts.PropertyAccessExpression).name.text === "kind" && isNarrowedTarget((ux as ts.PropertyAccessExpression).expression)) return true;
        if (isNarrowedTarget(ux)) return true;
      }
    }
    return false;
  }
  function inConditionContext(n: Node): boolean {
    let cur: Node | undefined = n;
    while (cur?.parent) {
      const p: Node = cur.parent;
      if (p.kind === K.ParenthesizedExpression || p.kind === K.PrefixUnaryExpression) { cur = p; continue; }
      if (p.kind === K.BinaryExpression) {
        const bk = (p as ts.BinaryExpression).operatorToken.kind;
        if (bk === K.AmpersandAmpersandToken || bk === K.BarBarToken) return true;
        return false;
      }
      if (p.kind === K.IfStatement && (p as ts.IfStatement).expression === cur) return true;
      if (p.kind === K.WhileStatement && (p as ts.WhileStatement).expression === cur) return true;
      if (p.kind === K.DoStatement && (p as ts.DoStatement).expression === cur) return true;
      if (p.kind === K.ForStatement && (p as ts.ForStatement).condition === cur) return true;
      if (p.kind === K.ConditionalExpression && (p as ts.ConditionalExpression).condition === cur) return true;
      return false;
    }
    return false;
  }

  const closeAngle = (i: number, end: number): number => {
    while (i < end) {
      if (text.startsWith("/*", i)) i = text.indexOf("*/", i + 2) + 2;
      else if (text.startsWith("//", i)) { const nl = text.indexOf("\n", i); if (nl < 0) return -1; i = nl; }
      else if (text[i] === ">") return i;
      else i++;
    }
    return -1;
  };

  function splice(n: Node): string {
    const a = n as AnyNode;
    const cuts: { s: number; e: number; out: string }[] = [];
    const lists = [a.typeArguments, a.typeParameters] as (ts.NodeArray<Node> | undefined)[];
    n.forEachChild((c) => {
      const list = lists.find((l) => l?.includes(c));
      if (list) {
        if (c !== list[0]) return;
        const e = closeAngle(list.end, n.end);
        cuts.push({ s: list.pos - 1, e: e < 0 ? list.end : e + 1, out: "" });
      } else if (a.type === c) {
        cuts.push({ s: c.pos - 1, e: c.end, out: "" });
      } else if (DROP_MODS.has(c.kind) || c.kind === K.HeritageClause) {
        cuts.push({ s: c.getStart(sf), e: skipWs(c.end), out: "" });
      } else cuts.push({ s: c.getStart(sf), e: c.end, out: gen(c) });
    });
    let out = "", cur = n.getStart(sf);
    for (const c of cuts) { out += text.slice(cur, c.s) + c.out; cur = c.e; }
    return out + text.slice(cur, n.end);
  }

  /** Wrap a loop body statement with `${RT}.step();` at its top. */
  function loopBody(stmt: ts.Statement): string {
    if (stmt.kind === K.Block) {
      const b = stmt as ts.Block;
      return `{\n${RT}.step();\n${b.statements.map(gen).join("\n")}\n}`;
    }
    return `{ ${RT}.step(); ${gen(stmt)} }`;
  }

  function gen(n: Node): string {
    switch (n.kind) {
      case K.TypeAliasDeclaration: case K.InterfaceDeclaration: case K.ModuleDeclaration: return "";
      case K.NumericLiteral: {
        const lit = n as ts.NumericLiteral;
        const t = typeOf(n);
        const orig = t?.k === "num" && t.name === "f32" ? `${RT}.f32(${splice(n)})` : splice(n);
        if (canMutate() && !isCaseExpr(n) && t?.k === "num") {
          const v = numValue(lit);
          const mutVal = v === 0 ? 1 : 0;
          if (literalFits(mutVal, t.name)) {
            const id = addMutant(v === 0 ? "0 -> 1" : "num -> 0", n);
            return `(${RT}.m === ${id} ? ${mutVal} : ${orig})`;
          }
        }
        return orig;
      }
      case K.TrueKeyword: case K.FalseKeyword: {
        const val = n.kind === K.TrueKeyword;
        if (canMutate() && !isCaseExpr(n) && typeOf(n)?.k === "prim") {
          const id = addMutant(val ? "true -> false" : "false -> true", n);
          return `(${RT}.m === ${id} ? ${!val} : ${val})`;
        }
        return val ? "true" : "false";
      }
      case K.AwaitExpression:
        return `${RT}.task(await ${gen((n as ts.AwaitExpression).expression)})`;
      case K.PrefixUnaryExpression: return prefix(n as ts.PrefixUnaryExpression);
      case K.BinaryExpression: return binary(n as ts.BinaryExpression);
      case K.ElementAccessExpression: {
        const e = n as ts.ElementAccessExpression;
        return `${RT}.at(${gen(e.expression)}, ${gen(e.argumentExpression)}, ${at(e.argumentExpression)})`;
      }
      case K.PropertyAccessExpression: {
        const p = n as ts.PropertyAccessExpression;
        const callee = n.parent?.kind === K.CallExpression && (n.parent as ts.CallExpression).expression === n;
        return p.questionDotToken && !callee ? `${RT}.nn(${splice(n)})` : splice(n);
      }
      case K.CallExpression: return call(n as ts.CallExpression);
      case K.NewExpression: {
        const ne = n as ts.NewExpression, groups = sliceGroups.get(n);
        if (!groups || !ne.arguments) return mark(n) + splice(n);
        const refs = ne.arguments.map((_, i) => `${V}[${i}]`);
        const body = `(...${V}) => { ${checkStmts(groups, refs)} return new ${gen(ne.expression)}(${refs.join(", ")}); }`;
        needAp = true;
        return ne.arguments.some(hasAwait) ? `${mark(n)}(await ${AP}(async ${body}, ${ne.arguments.map(gen).join(", ")}))` : `${mark(n)}${AP}(${body}, ${ne.arguments.map(gen).join(", ")})`;
      }
      case K.Identifier: {
        const pa = n.parent, called = (c: Node | undefined, x: Node): boolean => c?.kind === K.CallExpression && (c as ts.CallExpression).expression === x;
        return called(pa, n) || (pa?.kind === K.PropertyAccessExpression && (pa as ts.PropertyAccessExpression).name === n && called(pa.parent, pa)) ? mark(n) + splice(n) : splice(n);
      }
      case K.IfStatement: return ifStmt(n as ts.IfStatement);
      case K.WhileStatement: {
        const w = n as ts.WhileStatement;
        return `while (${gen(w.expression)}) ${loopBody(w.statement)}`;
      }
      case K.DoStatement: {
        const d = n as ts.DoStatement;
        return `do ${loopBody(d.statement)} while (${gen(d.expression)});`;
      }
      case K.ForStatement: {
        const f = n as ts.ForStatement;
        const init = f.initializer ? gen(f.initializer) : "";
        const cond = f.condition ? gen(f.condition) : "";
        const inc = f.incrementor ? gen(f.incrementor) : "";
        return `for (${init}; ${cond}; ${inc}) ${loopBody(f.statement)}`;
      }
      case K.ForOfStatement: {
        const f = n as ts.ForOfStatement;
        return `for (${gen(f.initializer)} of ${gen(f.expression)}) ${loopBody(f.statement)}`;
      }
      case K.ExpressionStatement: return exprStmt(n as ts.ExpressionStatement);
      case K.ArrowFunction: {
        const af = n as ts.ArrowFunction;
        if (af.body.kind !== K.Block && inContract === 0) {
          const isAsync = !!af.modifiers?.some((x) => x.kind === K.AsyncKeyword);
          const ps = af.parameters.map((p) => p.name.getText(sf)).join(", ");
          return `${isAsync ? "async " : ""}(${ps}) => (${RT}.step(), (${gen(af.body)}))`;
        }
        return splice(n);
      }
      case K.Block: return block(n as ts.Block);
      case K.FunctionDeclaration: {
        const f = n as ts.FunctionDeclaration;
        if (unsafeDecls.has(n)) return `function ${f.name!.text}() { ${RT}.cOnly(); }`; // Q275: C-only stub
        const isTop = n.parent?.kind === K.SourceFile && !f.typeParameters?.length && !f.modifiers?.some((m) => m.kind === K.AsyncKeyword) && !!f.name && !!f.body;
        const pre = isTop ? emitPreFn(f) : undefined;
        const tail = pre ? `\n${RT}.setPre(${f.name!.text}, ${pre});` : "";
        const tid = targetByDecl.get(n);
        if (tid === undefined) return splice(n) + tail;
        const prevFnId = curFnId, prevFnName = curFnName, prevSyms = narrowedSyms, prevProps = narrowedProps;
        curFnId = tid;
        curFnName = f.name!.text;
        const nw = f.body ? scanNarrowing(f.body) : { syms: new Set<number>(), props: new Set<string>() };
        narrowedSyms = nw.syms;
        narrowedProps = nw.props;
        try { return splice(n) + tail; } finally {
          curFnId = prevFnId; curFnName = prevFnName; narrowedSyms = prevSyms; narrowedProps = prevProps;
        }
      }
    }
    return splice(n);
  }

  function ifStmt(s: ts.IfStatement): string {
    const u = unwrapParens(s.expression);
    const alreadyBoolLit = u.kind === K.TrueKeyword || u.kind === K.FalseKeyword;
    let condJs = gen(s.expression);
    if (canMutate() && !alreadyBoolLit && !hasActiveNarrowing(s.expression)) {
      const idT = addMutant("if -> true", s.expression);
      const idF = addMutant("if -> false", s.expression);
      condJs = `${RT}.m === ${idT} ? true : ${RT}.m === ${idF} ? false : (${condJs})`;
    }
    return `if (${condJs}) ${gen(s.thenStatement)}${s.elseStatement ? ` else ${gen(s.elseStatement)}` : ""}`;
  }

  function exprStmt(s: ts.ExpressionStatement): string {
    const u = unwrapParens(s.expression);
    // Contract calls (`requires`, `ensures`, `invariant`) are never mutated and never deleted.
    if (u.kind === K.CallExpression && isId((u as ts.CallExpression).expression)) {
      const cname = ((u as ts.CallExpression).expression as ts.Identifier).text;
      if (cname === "requires" || cname === "ensures" || cname === "invariant") return splice(s);
    }
    const orig = splice(s);
    if (!canMutate()) return orig;
    let deletable = false;
    if (u.kind === K.CallExpression) {
      deletable = true;
    } else if (u.kind === K.BinaryExpression) {
      const bk = (u as ts.BinaryExpression).operatorToken.kind;
      if (bk === K.EqualsToken || COMPOUND[bk] !== undefined) deletable = true;
    }
    if (!deletable) return orig;
    // Type & ownership safety for statement deletion:
    const et = typeOf(u);
    if (et?.k === "prim" && et.name === "never") return orig; // deleting `panic(...)` / never-call could fall off end of non-void fn
    if (u.kind === K.BinaryExpression && (u as ts.BinaryExpression).operatorToken.kind === K.EqualsToken) {
      const lhs = assignTarget((u as ts.BinaryExpression).left);
      if (isId(lhs)) {
        const sym = localOf.get(lhs);
        if (sym && (movesLike(sym.type) || (nonNull(sym.type) !== undefined && narrowedSyms.has(sym.id)))) return orig;
      }
    }
    const id = addMutant("delete-stmt", s, true);
    return `{ if (${RT}.m !== ${id}) { ${orig} } }`;
  }

  function optional(recv: string, awaited: boolean, body: (o: string) => string): string {
    needAp = true;
    const f = `(${O}) => ${O} == null ? null : ${body(O)}`;
    return awaited ? `(await ${AP}(async ${f}, ${recv}))` : `${AP}(${f}, ${recv})`;
  }

  function prefix(u: ts.PrefixUnaryExpression): string {
    const t = numName(u);
    if (u.operator === K.MinusToken && u.operand.kind === K.NumericLiteral) {
      const lit = u.operand as ts.NumericLiteral;
      const rawText = u.getText(sf);
      const orig = t === "f32" ? `${RT}.f32(${rawText})` : (t && isInt(typeOf(u)!) ? `(${rawText} + 0)` : rawText);
      if (canMutate() && !isCaseExpr(u) && t) {
        const v = -numValue(lit);
        const mutVal = v === 0 ? 1 : 0;
        if (literalFits(mutVal, t as NumName)) {
          const id = addMutant(v === 0 ? "0 -> 1" : "num -> 0", u);
          return `(${RT}.m === ${id} ? ${mutVal} : ${orig})`;
        }
      }
      return orig;
    }
    if (u.operator === K.MinusToken && t && isInt(typeOf(u)!)) return `${RT}.neg(${q(t)}, ${gen(u.operand)}, ${at(u)})`;
    if (u.operator === K.TildeToken && t === "u32") return `${RT}.toU32(${splice(u)})`;
    return splice(u);
  }

  function op(t: string | undefined, o: string, l: string, r: string, anchor: string): string {
    if (t && INT_OP[o] && t !== "f32" && t !== "f64") return `${RT}.${INT_OP[o]}(${q(t)}, ${l}, ${r}, ${anchor})`;
    if (t === "f32" && ["+", "-", "*", "/", "%", "**"].includes(o)) return `${RT}.f32((${l}) ${o} (${r}))`;
    if (o === "<<") return `${RT}.shl(${q(t!)}, ${l}, ${r}, ${anchor})`;
    if (o === ">>") return `${RT}.shr(${l}, ${r}, ${anchor})`;
    if (o === ">>>") return `${RT}.ushr(${l}, ${r}, ${anchor})`;
    if (t === "u32" && ["&", "|", "^"].includes(o)) return `${RT}.toU32((${l}) ${o} (${r}))`;
    return `((${l}) ${o} (${r}))`;
  }

  function binary(b: ts.BinaryExpression): string {
    const k = b.operatorToken.kind;
    const o = b.operatorToken.getText(sf);
    const anchor = (): string => at(b.operatorToken);
    const left = k === K.EqualsToken || COMPOUND[k] !== undefined ? assignTarget(b.left) : b.left;
    if (k === K.EqualsToken && left.kind === K.ElementAccessExpression) {
      const e = left as ts.ElementAccessExpression;
      return `${RT}.setAt(${gen(e.expression)}, ${gen(e.argumentExpression)}, ${gen(b.right)}, ${at(e.argumentExpression)})`;
    }
    const base = COMPOUND[k];
    if (base !== undefined) {
      const t = numName(b);
      const rhs = gen(b.right);
      const plain = !(t && (t === "f32" || (isInt(typeOf(b)!) && INT_OP[base])));
      const aw = hasAwait(b.right), fa = aw ? "async " : "", apCall = aw ? `(await ${AP}` : AP, close = aw ? ")" : "";
      if (left.kind === K.ElementAccessExpression) {
        needAp = true;
        const e = left as ts.ElementAccessExpression, ip = at(e.argumentExpression);
        return `${apCall}(${fa}(${O}, ${KEY}) => { const ${V} = ${op(t, base, `${RT}.at(${O}, ${KEY}, ${ip})`, rhs, anchor())}; ${RT}.setAt(${O}, ${KEY}, ${V}, ${ip}); return ${V}; }, ${gen(e.expression)}, ${gen(e.argumentExpression)})${close}`;
      }
      if (plain) return splice(b);
      if (left.kind === K.PropertyAccessExpression) {
        needAp = true;
        const p = left as ts.PropertyAccessExpression, f = p.name.text;
        return `${apCall}(${fa}(${O}) => ${O}.${f} = ${op(t, base, `${O}.${f}`, rhs, anchor())}, ${gen(p.expression)})${close}`;
      }
      const l = gen(left);
      return `${l} = ${op(t, base, l, rhs, anchor())}`;
    }
    const t = numName(b);
    // Operator (1): numeric binary `+` <-> `-`, `*` -> `+`
    if (t && ARITH_MUT[o] && canMutate()) {
      const mutO = ARITH_MUT[o]!;
      const id = addMutant(`${o} -> ${mutO}`, b.operatorToken);
      return `${RT}.mArith(${id}, ${q(t)}, ${q(o)}, ${q(mutO)}, ${gen(left)}, ${gen(b.right)}, ${anchor()})`;
    }
    if (t && ["+", "-", "*", "/", "%", "**", "<<", ">>", ">>>", "&", "|", "^"].includes(o)) return op(t, o, gen(left), gen(b.right), anchor());
    // Operator (2): `<` <-> `<=`, `>` <-> `>=`, `===` <-> `!==`
    if (CMP_MUT[o] && canMutate()) {
      const skipNarrow = (o === "===" || o === "!==") && hasActiveNarrowing(b) && inConditionContext(b);
      if (!skipNarrow) {
        const mutO = CMP_MUT[o]!;
        const id = addMutant(`${o} -> ${mutO}`, b.operatorToken);
        return `${RT}.mCmp(${id}, ${q(o)}, ${q(mutO)}, ${gen(left)}, ${gen(b.right)})`;
      }
    }
    // Operator (3): `&&` <-> `||`
    if (LOGIC_MUT[o] && canMutate() && !hasActiveNarrowing(b)) {
      const mutO = LOGIC_MUT[o]!;
      const id = addMutant(`${o} -> ${mutO}`, b.operatorToken);
      const lJs = gen(left), rJs = gen(b.right);
      if (hasAwait(left) || hasAwait(b.right)) {
        return `(await ${RT}.mLogicAsync(${id}, ${q(o)}, async () => (${lJs}), async () => (${rJs})))`;
      }
      return `${RT}.mLogic(${id}, ${q(o)}, () => (${lJs}), () => (${rJs}))`;
    }
    return splice(b);
  }

  function checkStmts(groups: SliceGroupEntry[][], refs: string[]): string {
    return groups.map((g) => `${RT}.checkSlices([${g.map((x) => `[${refs[x.arg]}, ${x.mut}, ${at(x.name)}]`).join(", ")}]);`).join(" ");
  }
  function grouped(e: ts.CallExpression, groups: SliceGroupEntry[][], args: string[], bound: (refs: string[]) => string): string {
    needAp = true;
    const refs = e.arguments.map((_, i) => `${V}[${i}]`);
    const body = `(...${V}) => { ${checkStmts(groups, refs)} return ${bound(refs)}; }`;
    return e.arguments.some(hasAwait) ? `(await ${AP}(async ${body}, ${args.join(", ")}))` : `${AP}(${body}, ${args.join(", ")})`;
  }
  function groupedProp(e: ts.CallExpression, groups: SliceGroupEntry[][], args: string[], awaited: boolean): string {
    const p = e.expression as ts.PropertyAccessExpression;
    if (p.questionDotToken) return optional(gen(p.expression), awaited, (o) => grouped(e, groups, args, (refs) => `${RT}.nn(${o}.${p.name.text}(${refs.join(", ")}))`));
    needAp = true;
    const refs = e.arguments.map((_, i) => `${V}[${i}]`);
    const body = `(${O}, ...${V}) => { ${checkStmts(groups, refs)} return ${O}.${p.name.text}(${refs.join(", ")}); }`;
    return awaited ? `(await ${AP}(async ${body}, ${gen(p.expression)}, ${args.join(", ")}))` : `${AP}(${body}, ${gen(p.expression)}, ${args.join(", ")})`;
  }

  function call(e: ts.CallExpression): string {
    const callee = e.expression;
    const iso = isolateCalls.get(e);
    if (iso) return `(${gen((callee as ts.PropertyAccessExpression).expression)}, ${RT}.spawnIsolate(${q(iso.path)}, ${q(iso.name)}))`;
    // Contract calls: never mutate inside `requires`, `ensures`, `invariant`.
    if (callee.kind === K.Identifier) {
      const name = (callee as ts.Identifier).text;
      if (name === "requires" || name === "invariant") {
        inContract++;
        const arg0 = gen(e.arguments[0]!);
        inContract--;
        return `${RT}.${name}(${arg0}, ${at(callee)})`;
      }
      if (name === "ensures") throw new Error("mutate: ensures outside a function body prologue");
    }
    const args = e.arguments.map(gen);
    const groups = sliceGroups.get(e);
    const self = typeOf(e);
    if (callee.kind === K.Identifier) {
      const name = (callee as ts.Identifier).text;
      const t = self?.k === "num" ? self.name : "";
      if ((NUM_NAMES as readonly string[]).includes(name)) return `${RT}.convert(${q(name)}, ${args[0]}, ${at(callee)})`;
      switch (name) {
        case "wrapAdd": case "wrapSub": case "wrapMul": return `${RT}.${name}(${q(t)}, ${args.join(", ")})`;
        case "divTrunc": case "rem": return `${RT}.${name}(${q(t)}, ${args.join(", ")}, ${at(callee)})`;
        case "ok": case "err": return `${RT}.${name}(${args[0]})`;
        case "panic": return `${RT}.panic(${args[0]}, ${at(callee)})`;
        case "cast": return `${RT}.cast(${args[0]}, ${desc(resultParts(self!)!.ok)})`;
        case "test": return `${RT}.test(${args.join(", ")})`;
        case "forAll": {
          const meta = forAllMeta.get(e)!;
          const descs = `[${meta.params.map((p) => emitGenDesc(genDescOf(p))).join(", ")}]`;
          const pre = meta.checkBool ? emitPreFn(unwrapParens(e.arguments[0]!) as ts.ArrowFunction | ts.FunctionExpression) : undefined;
          return `${RT}.forAll(${args[0]}, ${descs}, ${meta.checkBool}, ${at(callee)}${pre ? `, ${pre}` : ""})`;
        }
      }
      return groups ? grouped(e, groups, args, (refs) => `${gen(callee)}(${refs.join(", ")})`) : splice(e);
    }
    if (callee.kind !== K.PropertyAccessExpression) return splice(e);
    const p = callee as ts.PropertyAccessExpression, m = p.name.text;
    const recv = p.expression;
    const withArgs = (extra: string[]): string => `${gen(callee)}(${[...args, ...extra].join(", ")})`;
    const nn = (s: string): string => (p.questionDotToken ? `${RT}.nn(${s})` : s);
    const awaited = e.arguments.some(hasAwait);
    if (recv.kind === K.Identifier && ((recv as ts.Identifier).text === "Vec" || (recv as ts.Identifier).text === "Pool") && m === "create" && !typeOf(recv)) {
      const el = self?.k === "gen" ? self.args[0] : undefined;
      return withArgs([q(elemDesc(el))]);
    }
    if (recv.kind === K.Identifier && (recv as ts.Identifier).text === "Arena" && m === "create" && !typeOf(recv)) return withArgs([]);
    if (recv.kind === K.Identifier && (recv as ts.Identifier).text === "Ring" && m === "create" && !typeOf(recv)) {
      const txf = self?.k === "record" ? self.fields.find((f) => f.name === "tx")?.type : undefined;
      const el = txf?.k === "gen" ? txf.args[0] : undefined;
      return withArgs([q(elemDesc(el)), at(p.name)]);
    }
    const r0 = typeOf(recv);
    const r = r0 && (nonNull(r0) ?? r0);
    const ns = recv.kind === K.Identifier && !r0 ? (recv as ts.Identifier).text : undefined;
    if (ns === "DetMath") { dmUsed.add(m); return `${dmBinding(m)}(${args.join(", ")})`; }
    if (ns === "JSON" && m === "parse") return `${RT}.jsonParse(${args[0]}, ${at(p.name)})`;
    const throws = ns ? THROWING[ns] : r?.k === "gen" ? THROWING[r.name] : r && isStr(r) ? THROWING.string : undefined;
    if (throws?.includes(m)) {
      const guarded = (o: string): string => `${RT}.guarded(${o}, ${q(m)}, [${args.join(", ")}], ${at(p.name)})`;
      return p.questionDotToken ? optional(gen(recv), awaited, guarded) : guarded(ns ?? gen(recv));
    }
    if (r?.k === "gen") {
      if ((r.name === "Array" || r.name === "ReadonlyArray") && (m === "pop" || m === "find")) return nn(`${RT}.nn(${withArgs([])})`);
      if ((r.name === "Array" || r.name === "ReadonlyArray") && (m === "indexOf" || m === "findIndex")) return nn(`${RT}.idxOrNull(${withArgs([])})`);
      if (r.name === "Map" && m === "get") return nn(`${RT}.nn(${withArgs([])})`);
      if ((r.name === "Vec" || r.name === "Slice") && m === "slice") return nn(withArgs([at(p.name)]));
      if (r.name === "OwnedCell" && (m === "take" || m === "put")) return nn(withArgs([at(p.name)]));
      if (r.name === "Pool" && (m === "get" || m === "set" || m === "remove")) return nn(withArgs([at(p.name)]));
      if (r.name === "Arena" && m === "alloc") { const nn2 = self && nonNull(self); const el = nn2?.k === "gen" ? nn2.args[0] : undefined; return nn(withArgs([q(elemDesc(el))])); }
      if (r.name === "Arena" && m === "view") { const el = self?.k === "gen" ? self.args[0] : undefined; return nn(withArgs([q(elemDesc(el)), at(p.name)])); }
    } else if (r && isStr(r)) {
      if (m === "indexOf") return nn(`${RT}.idxOrNull(${withArgs([])})`);
      if (m === "codePointAt") return nn(`${RT}.nn(${withArgs([])})`);
      if (m === "charCodeAt") { const f = (o: string): string => `${RT}.charCodeAt(${o}, ${args[0]}, ${at(p.name)})`; return p.questionDotToken ? optional(gen(recv), awaited, f) : f(gen(recv)); }
    } else if (r?.k === "opaque") {
      if (r.name === "Js" && m === "decode") return nn(withArgs([desc(resultParts(self!)!.ok)]));
      if (r.name === "Js" && m === "callback") return nn(withArgs([desc(resultParts((typeOf(e.arguments[0]!) as FnType).params[0]!)!.ok)]));
      if (r.name === "Test") return nn(withArgs([at(p.name)]));
    }
    if (groups) return groupedProp(e, groups, args, awaited);
    return nn(withArgs([]));
  }

  function block(b: ts.Block): string {
    const fnLike = b.parent && [K.FunctionDeclaration, K.MethodDeclaration, K.ArrowFunction, K.FunctionExpression, K.Constructor].includes(b.parent.kind);
    const isTargetBody = b.parent?.kind === K.FunctionDeclaration && targetByDecl.has(b.parent);
    const targetFnId = isTargetBody ? targetByDecl.get(b.parent!)! : -1;
    const isCallNamed = (s: ts.Statement, nm: string): ts.CallExpression | undefined => {
      if (s.kind !== K.ExpressionStatement) return undefined;
      const e = (s as ts.ExpressionStatement).expression;
      return e.kind === K.CallExpression && isId((e as ts.CallExpression).expression) && ((e as ts.CallExpression).expression as ts.Identifier).text === nm
        ? (e as ts.CallExpression) : undefined;
    };
    const isDir = (s: ts.Statement): boolean => s.kind === K.ExpressionStatement && (s as ts.ExpressionStatement).expression.kind === K.StringLiteral;
    const ss = b.statements;

    // Emit a leading `requires` statement of a target function using `ownReq(fnId, ...)` (for witness T004 distinction).
    let reqEnd = 0;
    if (isTargetBody) {
      while (reqEnd < ss.length && isDir(ss[reqEnd]!)) reqEnd++;
      while (reqEnd < ss.length && isCallNamed(ss[reqEnd]!, "requires")) reqEnd++;
    }
    const emitStmt = (s: ts.Statement, idx: number): string => {
      if (isTargetBody && idx < reqEnd) {
        const rc = isCallNamed(s, "requires");
        if (rc) {
          inContract++;
          const arg0 = gen(rc.arguments[0]!);
          inContract--;
          return `${RT}.ownReq(${targetFnId}, ${arg0}, ${at(rc.expression)});`;
        }
      }
      return gen(s);
    };

    const lastEns = fnLike ? ss.map((s) => !!isCallNamed(s, "ensures")).lastIndexOf(true) : -1;
    let inner: string;
    if (lastEns < 0) {
      inner = ss.map((s, i) => emitStmt(s, i)).join("\n");
    } else {
      const head: string[] = [];
      const checks: string[] = [];
      for (let i = 0; i <= lastEns; i++) {
        const s = ss[i]!;
        const ec = isCallNamed(s, "ensures");
        if (ec) {
          inContract++;
          const pred = gen(ec.arguments[0]!);
          inContract--;
          checks.push(`${RT}.ensures(${pred}, ${R}, ${at(ec.expression)});`);
        } else {
          head.push(emitStmt(s, i));
        }
      }
      const isAsync = !!(b.parent as AnyNode as { modifiers?: ts.NodeArray<Node> }).modifiers?.some((x) => x.kind === K.AsyncKeyword);
      const rest = ss.slice(lastEns + 1).map((s, i) => emitStmt(s, lastEns + 1 + i)).join("\n");
      const run = isAsync ? `await (async () => {\n${rest}\n})()` : `(() => {\n${rest}\n})()`;
      inner = `${head.join("\n")}\nconst ${ENS} = (${R}) => { ${checks.join(" ")} return ${R}; };\nreturn ${ENS}(${run});`;
    }

    if (isTargetBody) {
      return `{\n${RT}.hit(${targetFnId}); ${RT}.step(); ${RT}.enter(${targetFnId});\ntry {\n${inner}\n} finally { ${RT}.leave(${targetFnId}); }\n}`;
    }
    if (fnLike && inContract === 0) {
      return `{\n${RT}.step();\n${inner}\n}`;
    }
    return `{\n${inner}\n}`;
  }

  // ---- Module level (§1)
  const body: string[] = [];
  const values = new Set<string>(), fns = new Set<string>();
  for (const s of sf.statements) {
    if (s.kind === K.FunctionDeclaration || s.kind === K.ClassDeclaration) {
      values.add((s as ts.FunctionDeclaration).name!.text);
      if (s.kind === K.FunctionDeclaration) fns.add((s as ts.FunctionDeclaration).name!.text);
    } else if (s.kind === K.VariableStatement) {
      for (const d of (s as ts.VariableStatement).declarationList.declarations) for (const b of declBindings(d)) values.add(b.id.text);
    } else if (s.kind === K.ImportDeclaration) {
      for (const x of ((s as ts.ImportDeclaration).importClause!.namedBindings as ts.NamedImports).elements) values.add(x.name.text);
    }
  }
  for (const s of sf.statements) {
    if (s.kind === K.ImportDeclaration) {
      const d = s as ts.ImportDeclaration;
      const spec = (d.moduleSpecifier as ts.StringLiteral).text;
      if (spec.startsWith("c:")) {
        // Q275: stub C imports so JS builds and throws COnlyReached when called.
        const stubs = (d.importClause!.namedBindings as ts.NamedImports).elements.map((x) => `${x.name.text} = () => ${RT}.cOnly()`);
        if (stubs.length) body.push(`const ${stubs.join(", ")};`);
        continue;
      }
      const key = spec.startsWith("npm:") ? spec : canonPath(dirname(pf.path), spec);
      imports.push(key);
      const els = (d.importClause!.namedBindings as ts.NamedImports).elements.map((x) => (x.propertyName ? `${x.propertyName.text}: ${x.name.text}` : x.name.text));
      body.push(`const { ${els.join(", ")} } = ${IMP}(${q(key)});`);
      continue;
    }
    if (s.kind === K.ExportDeclaration) {
      for (const x of ((s as ts.ExportDeclaration).exportClause as ts.NamedExports).elements) {
        const local = (x.propertyName ?? x.name).text;
        if (values.has(local)) exported.push(x.propertyName ? `${x.name.text}: ${local}` : local);
      }
      continue;
    }
    if ((s as unknown as { modifiers?: ts.NodeArray<Node> }).modifiers?.some((x) => x.kind === K.ExportKeyword)) {
      if (s.kind === K.VariableStatement) for (const d of (s as ts.VariableStatement).declarationList.declarations) for (const b of declBindings(d)) exported.push(b.id.text);
      else if (s.kind === K.FunctionDeclaration || s.kind === K.ClassDeclaration) exported.push((s as ts.FunctionDeclaration).name!.text);
    }
    if (s.kind === K.ExpressionStatement && !tests) {
      const ex = (s as ts.ExpressionStatement).expression;
      if (ex.kind === K.CallExpression && isId((ex as ts.CallExpression).expression) && ((ex as ts.CallExpression).expression as ts.Identifier).text === "test") continue;
    }
    body.push(gen(s));
  }
  if (dmUsed.size) {
    imports.push(DETMATH_PATH);
    const els = [...dmUsed].sort().map((n) => `${n}: ${dmBinding(n)}`);
    body.unshift(`const { ${els.join(", ")} } = ${IMP}(${q(DETMATH_PATH)});`);
  }
  const mutTableExport = extraMutExports.length ? `${MUT_FNS}: { ${extraMutExports.join(", ")} }` : "";
  const finalExports = [...exported, ...(mutTableExport ? [mutTableExport] : [])];
  const prelude = [
    `"use strict";`,
    `const { ${RT_NAMESPACES.join(", ")} } = ${RT};`,
    `const ${P} = [${poss.join(",")}];`,
    `Object.assign(${EXPORTS}, { ${exported.filter((x) => fns.has(x.split(": ").at(-1)!)).join(", ")} });`,
    ...(needAp ? [`const ${AP} = (f, ...a) => f(...a);`] : []),
  ];
  const js = `${prelude.join("\n")}\n${body.join("\n")}\nreturn Object.assign(${EXPORTS}, { ${finalExports.join(", ")} });\n//# sourceURL=${SOURCE_URL}${pf.path}`;
  const calls = new Map<string, rt.Pos>();
  let line = 3, ls = 0;
  for (const m of js.matchAll(new RegExp(`/\\*${MARK}(\\d+)\\*/`, "g"))) {
    for (let i = js.indexOf("\n", ls); i !== -1 && i < m.index; i = js.indexOf("\n", i + 1)) { line++; ls = i + 1; }
    calls.set(`${line}:${m.index + m[0].length - ls + 1}`, marks[+m[1]!]!);
  }
  return { js, imports, calls };
}

function hasAwait(e: Node): boolean {
  if (e.kind === K.AwaitExpression) return true;
  if (e.kind === K.ArrowFunction || e.kind === K.FunctionExpression) return false;
  return !!e.forEachChild((c) => (hasAwait(c) ? true : undefined));
}

function desc(t: Type): string {
  switch (t.k) {
    case "prim": return `{k:${JSON.stringify(t.name)}}`;
    case "num": return `{k:"num",t:${JSON.stringify(t.name)}}`;
    case "lit": return `{k:"lit",v:[${JSON.stringify(t.value)}]}`;
    case "record": return `{k:"rec",f:{${t.fields.map((f) => `${JSON.stringify(f.name)}:${desc(f.type)}`).join(",")}}}`;
    case "union":
      if (t.members.every((m) => m.k === "lit")) return `{k:"lit",v:${JSON.stringify(t.members.map((m) => (m as { value: string }).value))}}`;
      return `{k:"union",m:[${t.members.map(desc).join(",")}]}`;
    case "gen": if (t.name === "Array" || t.name === "ReadonlyArray") return `{k:"arr",of:${desc(t.args[0]!)}}`;
  }
  throw new Error(`mutate: no cast descriptor for type kind ${t.k}`);
}

// ---- Witness search & shrinking (Q274, Q277) — wired directly to runtime-js `arbitrary.ts` & compiler `gendesc.ts`.

function formatJsonVal(v: unknown): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : String(v);
  if (v === undefined) return null;
  if (v === null || typeof v !== "object") return v;
  if (v instanceof rt.Vec || v instanceof rt.Slice) return Array.from({ length: v.length }, (_, i) => formatJsonVal(v.get(i)));
  if (v instanceof Set) return [...v.values()].map(formatJsonVal);
  if (v instanceof Map) return [...v.entries()].map(([k, val]) => [formatJsonVal(k), formatJsonVal(val)]);
  if (Array.isArray(v)) return v.map(formatJsonVal);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = formatJsonVal(val);
  return out;
}

/** Snapshot any STS runtime value (including Vec, Slice, Struct, Map, Set, Array) for structural comparison. */
function snapshot(v: unknown): unknown {
  if (v instanceof rt.Vec || v instanceof rt.Slice) return { __seq: Array.from({ length: v.length }, (_, i) => snapshot(v.get(i))) };
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, val]) => [snapshot(k), snapshot(val)]) };
  if (v instanceof Set) return { __set: [...v.values()].map(snapshot) };
  if (Array.isArray(v)) return v.map(snapshot);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = snapshot(val);
    return out;
  }
  return v;
}

interface CallOutcome {
  kind: "ok" | "trap" | "ownReq" | "timeout" | "conly";
  ret?: unknown;
  muts?: Record<string, unknown>;
  trap?: string;
}

function sameOutcome(a: CallOutcome, b: CallOutcome): boolean {
  const ak = a.kind === "ownReq" ? "trap" : a.kind;
  const bk = b.kind === "ownReq" ? "trap" : b.kind;
  if (ak !== bk) return false;
  if (ak === "trap") return a.trap === b.trap;
  if (ak !== "ok") return true;
  return rt.deepEq(a.ret, b.ret) && rt.deepEq(a.muts, b.muts);
}

function formatOutcome(o: CallOutcome, hasMuts: boolean, isVoid: boolean): unknown {
  if (o.kind === "trap" || o.kind === "ownReq") return { trap: o.trap ?? "T004" };
  if (o.kind === "timeout") return { timeout: true };
  if (o.kind === "conly") return { cOnly: true };
  if (hasMuts && o.muts && Object.keys(o.muts).length > 0) {
    return isVoid ? { mut: o.muts } : { return: formatJsonVal(o.ret), mut: o.muts };
  }
  return formatJsonVal(o.ret);
}

/** Whether a parameter type can be observably mutated in-place by the callee (Mut<...> or managed mutable container/record). */
function isMutableParam(t: Type): boolean {
  if (t.k === "gen") return t.name === "Mut" || t.name === "Array" || t.name === "Map" || t.name === "Set";
  if (t.k === "record") return !t.struct && t.fields.some((f) => !f.readonly || isMutableParam(f.type));
  if (t.k === "union") return t.members.some(isMutableParam);
  return false;
}

/** Q277: search for a minimal witness input where `f` behaves differently under `m = 0` vs `m = mutantId`. */
async function findWitness(
  fnSym: FnSym,
  fnId: number,
  fnImpl: (...args: unknown[]) => unknown,
  mutantId: number,
  mutState: { m: number; steps: number; stepLimit: number; recording: boolean; watchFn: number; watchDepth: number },
): Promise<Witness | null> {
  if (fnSym.sig.tparams.length !== 0 || fnSym.sig.params.length === 0) return null;
  if (!fnSym.sig.params.every(isGeneratable)) return null;

  const descs = fnSym.sig.params.map(genDescOf);
  const paramNames = fnSym.decl.parameters.map((p, i) => (isId(p.name) ? p.name.text : `p${i}`));
  const mutIdx = fnSym.sig.params.flatMap((pt, i) => (isMutableParam(pt) ? [i] : []));
  const isVoid = fnSym.sig.ret.k === "prim" && fnSym.sig.ret.name === "void";
  const isAsync = fnSym.sig.ret.k === "gen" && fnSym.sig.ret.name === "Promise";

  const classifyErr = (x: unknown): CallOutcome => {
    if (x instanceof OwnRequiresTrap) return { kind: "ownReq", trap: "T004" };
    if (x instanceof StepLimitReached) return { kind: "timeout" };
    if (x instanceof COnlyReached) return { kind: "conly" };
    const e = rt.asTrap(x);
    if (e) return { kind: "trap", trap: e.code };
    throw x;
  };
  const arm = (mId: number): void => {
    mutState.m = mId; mutState.steps = 0; mutState.stepLimit = 10_000;
    mutState.recording = false; mutState.watchFn = fnId; mutState.watchDepth = 0;
  };
  const disarm = (): void => { mutState.watchFn = -1; mutState.watchDepth = 0; };

  const invokeSync = (mId: number, raw: readonly unknown[], fmt = false): CallOutcome => {
    const args = rt.materializeArgs(descs, raw);
    arm(mId);
    try {
      const ret = fnImpl(...args);
      const muts: Record<string, unknown> = {};
      for (const i of mutIdx) muts[paramNames[i]!] = fmt ? formatJsonVal(args[i]) : snapshot(args[i]);
      return { kind: "ok", ret: fmt ? ret : snapshot(ret), muts };
    } catch (x) { return classifyErr(x); } finally { disarm(); }
  };

  const invokeAsync = async (mId: number, raw: readonly unknown[], fmt = false): Promise<CallOutcome> => {
    const args = rt.materializeArgs(descs, raw);
    arm(mId);
    try {
      let ret: unknown;
      const rejected = await rt.capturing(async () => { ret = await fnImpl(...args); });
      if (rejected.length) throw rejected[0];
      const muts: Record<string, unknown> = {};
      for (const i of mutIdx) muts[paramNames[i]!] = fmt ? formatJsonVal(args[i]) : snapshot(args[i]);
      return { kind: "ok", ret: fmt ? ret : snapshot(ret), muts };
    } catch (x) { return classifyErr(x); } finally { disarm(); }
  };

  const evalSync = (raw: readonly unknown[]): { skip: boolean; diff: boolean } => {
    const base = invokeSync(0, raw);
    const mut = invokeSync(mutantId, raw);
    if (base.kind === "ownReq" && mut.kind === "ownReq") return { skip: true, diff: false };
    return { skip: false, diff: !sameOutcome(base, mut) };
  };

  const rng = rt.createRng();
  let valid = 0, skipped = 0;
  let foundRaw: unknown[] | undefined;
  while (valid < 200 && skipped < 1000) {
    const size = Math.min(30, 1 + Math.floor(valid / 3));
    const raw = rt.generateRaw(descs, rng, size);
    const r = isAsync
      ? await (async () => {
        const base = await invokeAsync(0, raw), mut = await invokeAsync(mutantId, raw);
        return base.kind === "ownReq" && mut.kind === "ownReq" ? { skip: true, diff: false } : { skip: false, diff: !sameOutcome(base, mut) };
      })()
      : evalSync(raw);
    if (r.skip) { skipped++; continue; }
    valid++;
    if (r.diff) { foundRaw = raw; break; }
  }
  if (!foundRaw) return null;

  const shrunk = isAsync ? foundRaw : rt.shrinkRaw(descs, foundRaw, (cand) => {
    const r = evalSync(cand);
    return !r.skip && r.diff;
  });

  const baseOut = isAsync ? await invokeAsync(0, shrunk, true) : invokeSync(0, shrunk, true);
  const mutOut = isAsync ? await invokeAsync(mutantId, shrunk, true) : invokeSync(mutantId, shrunk, true);
  return {
    args: rt.formatArgs(descs, shrunk),
    base: formatOutcome(baseOut, mutIdx.length > 0, isVoid),
    mutant: formatOutcome(mutOut, mutIdx.length > 0, isVoid),
  };
}
