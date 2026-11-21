// Stage 4-2..4: `sts mutate` mutation testing engine (SPEC §16.2, Q275–Q278).
// JS-only execution with 1-build runtime mutant switches, per-test reachability,
// step-fuel timeout abortion, per-function diff caching, and shrunk witness search.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { loadNpmModule } from "./bundle-npm.ts";
import { analyze, CliError, type Analysis } from "./index.ts";
import { CACHE_DIR } from "./names.ts";
import type { Diagnostic, Range } from "./diagnostics.ts";
import { emitFile, EXPORTS, IMP, MUT_FNS, RT, SOURCE_URL, type EmitMutate, type MutantSpec } from "./emit.ts";
import { SyntaxKind as K, isId, type Node, type Parser, type ts } from "./parse.ts";
import { callFns, localOf } from "./expr.ts";
import { genDescOf, isGeneratable } from "./gendesc.ts";
import { canonPath, type ConstSym, type FnSym, type Module, type Program as Decls, type TypeSym } from "./modules.ts";
import { isDeterministic, isMutatable } from "./determinism.ts";
import type { ClassSym, Type } from "./types.ts";
import * as rt from "../../runtime-js/src/index.ts";
import { FakeAudio, FakeClock, FakeFs, MemoryLog, SeededRandom, TestAlloc } from "../../std/src/index.ts";

const MUTATE_VERSION = "4";

export interface SkippedTarget {
  readonly fn: string;
  readonly reason: "unsafe" | "test-helper" | "not-mutatable";
}

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
  readonly targets: number;
  readonly killed: number;
  readonly survived: number;
  readonly timeout: number;
  readonly cached: number;
  readonly skipped: readonly SkippedTarget[];
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

/** Mutated target functions exclude test helpers whose parameter types contain `Test` (Q278). */
export function hasTestType(t: Type, seen = new Set<unknown>()): boolean {
  switch (t.k) {
    case "opaque": return t.name === "Test";
    case "record": return t.fields.some((f) => hasTestType(f.type, seen));
    case "union": return t.members.some((m) => hasTestType(m, seen));
    case "gen": return t.args.some((a) => hasTestType(a, seen));
    case "fn": return t.params.some((p) => hasTestType(p, seen)) || hasTestType(t.ret, seen);
    case "class": {
      if (t.args.some((a) => hasTestType(a, seen))) return true;
      if (seen.has(t.cls)) return false;
      seen.add(t.cls);
      const r = [...t.cls.fields.values()].some((f) => !f.static && hasTestType(f.type, seen));
      seen.delete(t.cls);
      return r;
    }
    default: return false;
  }
}

interface CacheEntry {
  key: string;
  results: { op: string; status: "killed" | "survived" | "timeout"; deadCode?: true; witness?: Witness | null }[];
}
type CacheStore = Record<string, CacheEntry>;

const displayPath = (p: string): string => relative(process.cwd(), p) || p;

/** Main entry for `sts mutate` on a single file (called inside `exclusive` from `index.ts`). */
export async function mutateFile(entryFile: string, opts: MutateOptions = {}): Promise<MutateResult> {
  const emptySummary: MutateSummary = { targets: 0, killed: 0, survived: 0, timeout: 0, cached: 0, skipped: [] };
  const a = opts.analysis ?? analyze(entryFile, opts.parser);
  if (a.diagnostics.length) return { diagnostics: a.diagnostics, baselineFailure: null, mutants: [], summary: emptySummary };

  const decls = a.decls!;
  const entryPath = canonPath(entryFile);
  const entryMod = decls.mods.find((m) => m.pf.path === entryPath)!;
  const entryDisplay = displayPath(entryPath);

  // SPEC-v1 §7: target functions and class methods are safe, do not take Test, and pass isMutatable.
  interface MutTarget { readonly fnId: number; readonly name: string; readonly decl: Node; readonly pure: boolean; readonly fnSym?: FnSym; readonly clsSym?: ClassSym }
  const targets: MutTarget[] = [];
  const skipped: SkippedTarget[] = [];
  for (const f of decls.fns) {
    if (f.mod !== entryMod) continue;
    if (f.unsafe) { skipped.push({ fn: f.name, reason: "unsafe" }); continue; }
    if (f.sig.params.some((p) => hasTestType(p))) { skipped.push({ fn: f.name, reason: "test-helper" }); continue; }
    if (!isMutatable(f.sig, false)) { skipped.push({ fn: f.name, reason: "not-mutatable" }); continue; }
    targets.push({ fnId: targets.length, name: f.name, decl: f.decl, pure: isDeterministic(f.sig, false), fnSym: f });
  }
  for (const [clsName, sym] of entryMod.types) {
    if (sym.k !== "class" || sym.mod !== entryMod) continue;
    const clsType: Type = { k: "class", cls: sym.cls, args: sym.cls.tparams.map((p) => ({ k: "tparam", p })) };
    for (const [mName, m] of sym.cls.methods) {
      const qName = `${clsName}.${mName}`;
      const extra = m.static ? [] : [clsType];
      if (m.sig.params.some((p) => hasTestType(p)) || extra.some((e) => hasTestType(e))) { skipped.push({ fn: qName, reason: "test-helper" }); continue; }
      if (!isMutatable(m.sig, false, extra)) { skipped.push({ fn: qName, reason: "not-mutatable" }); continue; }
      targets.push({ fnId: targets.length, name: qName, decl: m.node, pure: false, clsSym: sym.cls });
    }
  }
  const targetByDecl = new Map(targets.map((t) => [t.decl, { id: t.fnId, name: t.name }]));
  const unsafeDecls = new Set<Node>(decls.fns.filter((f) => f.unsafe).map((f) => f.decl));

  // Emit ONE JS build containing all mutants, reachability hooks, step fuel, and C-only stubs (#8).
  const allMutants: MutantSpec[] = [];
  const emitted = new Map<string, { js: string; imports: string[]; calls: Map<string, rt.Pos> }>();
  for (const pf of a.files) {
    const isEntry = pf.path === entryPath;
    const mut: EmitMutate = {
      targets: isEntry ? targetByDecl : new Map(),
      unsafeDecls,
      mutants: allMutants,
      exportFns: isEntry ? targets.filter((t) => t.fnSym && t.pure).map((t) => t.name) : [],
    };
    emitted.set(pf.path, emitFile(pf, displayPath(pf.path), isEntry, undefined, undefined, mut));
  }

  // Resolve npm: imports (same as index.ts).
  const npm = new Map<string, unknown>();
  for (const [path, e] of emitted) {
    for (const spec of e.imports) {
      if (!spec.startsWith("npm:") || npm.has(spec)) continue;
      npm.set(spec, (await loadNpmModule(path, spec)).mod);
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
    FakeAudio, FakeClock, SeededRandom, MemoryLog, FakeFs, TestAlloc,
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
    mCmpHandle(id: number, orig: string, l: rt.PoolHandle | null, r: rt.PoolHandle | null): boolean {
      const o = mutState.m === id ? (orig === "===" ? "!==" : "===") : orig;
      const eq = rt.handleEq(l, r);
      return o === "===" ? eq : !eq;
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

  // Map top-level `test(...)` statements in entry file to AST nodes and source text (1-to-1 with registeredTests, §1 / §9.2).
  const testAsts: { source: string; node: Node }[] = [];
  for (const s of entryMod.sf.statements) {
    if (s.kind === K.ExpressionStatement) {
      const ex = (s as ts.ExpressionStatement).expression;
      if (ex.kind === K.CallExpression && isId((ex as ts.CallExpression).expression) && ((ex as ts.CallExpression).expression as ts.Identifier).text === "test") {
        testAsts.push({ source: s.getText(entryMod.sf), node: s });
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
      if (x instanceof rt.TestFailure) return { ok: false, kind: "fail", failure: x.message, pos: x.pos };
      throw x; // unexpected internal error
    } finally {
      mutState.recording = false;
    }
  }

  // Q276: baseline m = 0 run. Collect reached functions and step count S per test.
  interface BaselineTest {
    name: string;
    source: string;
    node: Node;
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
    const ta = testAsts[i];
    activeTests.push({ name: t.name, source: ta?.source ?? "", node: ta?.node ?? entryMod.sf, fn: t.fn, steps: mutState.steps, reached: new Set(mutState.reached) });
  }

  // Cache load (Q277).
  const useCache = opts.cache !== false;
  const cacheFile = opts.cacheFile ?? resolve(CACHE_DIR, "mutate.json");
  const cacheStore: CacheStore = useCache ? readCache(cacheFile) : {};
  let cacheDirty = false;

  // Group collected mutants by target function.
  const mutantsByFn = new Map<number, MutantSpec[]>();
  for (const m of allMutants) {
    let list = mutantsByFn.get(m.fnId);
    if (!list) mutantsByFn.set(m.fnId, list = []);
    list.push(m);
  }

  const sourceLines = entryMod.sf.text.split("\n");
  const isEquivalentLine = (line: number): boolean => {
    const cur = sourceLines[line - 1] ?? "";
    if (/\/\/\s*szigyr-equivalent:\s*\S/.test(cur)) return true;
    const prev = line >= 2 ? (sourceLines[line - 2] ?? "") : "";
    return /^\s*\/\/\s*szigyr-equivalent:\s*\S/.test(prev);
  };

  const reports: MutantReport[] = [];
  for (const target of targets) {
    const fnMutants = (mutantsByFn.get(target.fnId) ?? []).filter((m) => !isEquivalentLine(m.range.start.line));
    if (!fnMutants.length) continue;

    const reaching = activeTests.filter((t) => t.reached.has(target.fnId));
    const cacheId = `${entryPath}::${target.name}`;
    const key = computeCacheKey(decls, entryMod, target, reaching);
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
    const fnImpl = target.fnSym ? fnTable[target.name] : undefined;
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
        witness = target.pure && target.fnSym && fnImpl ? await findWitness(target.fnSym, target.fnId, fnImpl, spec.id, mutState) : null;
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
  return { diagnostics: [], baselineFailure: null, mutants: reports, summary: { targets: targets.length, killed, survived, timeout, cached, skipped } };
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

/** Q277: hash of (target fn + transitive refs across signatures/bodies/types/consts/classes, reaching tests + helpers, version). */
function computeCacheKey(decls: Decls, entryMod: Module, target: { readonly fnSym?: FnSym; readonly clsSym?: ClassSym }, reaching: readonly { name: string; source: string; node: Node }[]): string {
  const seen = new Set<string>();
  const parts: [string, string][] = [];
  const visitFn = (f: FnSym): void => {
    const id = `fn:${f.mod.pf.path}:${f.name}`;
    if (seen.has(id)) return;
    seen.add(id);
    parts.push([id, f.decl.getText(f.mod.sf)]);
    walkDeps(f.mod, f.decl);
  };
  const visitType = (sym: TypeSym | undefined): void => {
    if (!sym) return;
    if (sym.k === "alias") {
      const id = `alias:${sym.mod.pf.path}:${sym.decl.name.text}`;
      if (seen.has(id)) return;
      seen.add(id);
      parts.push([id, sym.decl.getText(sym.mod.sf)]);
      walkDeps(sym.mod, sym.decl);
    } else if (sym.k === "class") {
      const id = `class:${sym.mod.pf.path}:${sym.cls.name}`;
      if (seen.has(id)) return;
      seen.add(id);
      parts.push([id, sym.cls.decl.getText(sym.mod.sf)]);
      walkDeps(sym.mod, sym.cls.decl);
    } else if (sym.k === "iface") {
      const id = `iface:${sym.mod.pf.path}:${sym.iface.name}`;
      if (seen.has(id)) return;
      seen.add(id);
      parts.push([id, sym.decl.getText(sym.mod.sf)]);
      walkDeps(sym.mod, sym.decl);
    }
  };
  const visitConst = (sym: ConstSym): void => {
    const id = `const:${sym.mod.pf.path}:${sym.decl.name.getText(sym.mod.sf)}`;
    if (seen.has(id)) return;
    seen.add(id);
    parts.push([id, sym.decl.getText(sym.mod.sf)]);
    walkDeps(sym.mod, sym.decl);
  };
  const isNonValueNamePos = (n: Node): boolean => {
    const p = n.parent;
    if (!p) return false;
    if (p.kind === K.PropertyAccessExpression && (p as ts.PropertyAccessExpression).name === n) return true;
    if (p.kind === K.PropertyAssignment && (p as ts.PropertyAssignment).name === n) return true;
    if (p.kind === K.BindingElement && (p as ts.BindingElement).propertyName === n) return true;
    if (p.kind === K.TypeReference && (p as ts.TypeReferenceNode).typeName === n) return true;
    if ((p.kind === K.PropertySignature || p.kind === K.PropertyDeclaration || p.kind === K.MethodDeclaration || p.kind === K.MethodSignature) && (p as { name?: Node }).name === n) return true;
    return false;
  };
  const walkDeps = (mod: Module, root: Node | undefined): void => {
    if (!root) return;
    const visit = (n: Node): void => {
      if (n.kind === K.CallExpression) {
        const cf = callFns.get(n);
        if (cf) visitFn(cf);
      } else if (n.kind === K.TypeReference) {
        const tn = (n as ts.TypeReferenceNode).typeName;
        if (isId(tn)) visitType(decls.lookupType(mod, tn.text));
      } else if (isId(n) && !localOf.has(n) && !isNonValueNamePos(n)) {
        const sym = decls.lookupValue(mod, n.text);
        if (sym?.k === "fn") visitFn(sym);
        else if (sym?.k === "const") visitConst(sym);
        else if (sym?.k === "class") visitType({ k: "class", cls: sym.cls, mod: sym.mod });
      }
      n.forEachChild(visit);
    };
    visit(root);
  };
  if (target.fnSym) visitFn(target.fnSym);
  else if (target.clsSym) visitType({ k: "class", cls: target.clsSym, mod: entryMod });
  for (const t of reaching) walkDeps(entryMod, t.node);
  parts.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const tests = reaching.map((t) => [t.name, t.source] as [string, string]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify({ v: MUTATE_VERSION, parts, tests })).digest("hex");
}

// ---- Witness search & shrinking (Q274, Q277) — wired directly to runtime-js `arbitrary.ts` & compiler `gendesc.ts`.

function formatJsonVal(v: unknown): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? (Object.is(v, -0) ? "-0" : v) : String(v);
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
  if (t.k === "gen") {
    if (t.name === "Mut" || t.name === "Array" || t.name === "Map" || t.name === "Set") return true;
    if (t.name === "ReadonlyArray") return isMutableParam(t.args[0]!);
    return false;
  }
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

  const shrunk = isAsync
    ? await rt.shrinkRawAsync(descs, foundRaw, async (cand) => {
      const base = await invokeAsync(0, cand), mut = await invokeAsync(mutantId, cand);
      return !(base.kind === "ownReq" && mut.kind === "ownReq") && !sameOutcome(base, mut);
    })
    : rt.shrinkRaw(descs, foundRaw, (cand) => {
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
