import { asTrap, capturing, takeIsolateTrap, task, trap, type Pos, type Trap, type TrapCode } from "./trap.ts";
import { stopFakeIsolates } from "./port.ts";
import type { Slice } from "./collections.ts";
import { createRng, formatArgs, generateRaw, materializeArgs, shrinkRaw, type GenDesc } from "./arbitrary.ts";

export interface TestResult {
  readonly name: string;
  readonly ok: boolean;
  /** Set when ok is false. */
  readonly failure?: string;
  /** Set when the test failed by an uncaught trap. */
  readonly trap?: { readonly code: TrapCode; readonly pos?: Pos };
  /** Position of the failed assertion, when the translator passed one. */
  readonly pos?: Pos;
  /** Structured failure data (expected/actual, index, counterexample). */
  readonly detail?: Record<string, unknown>;
}

export class TestFailure extends Error {
  readonly pos?: Pos;
  readonly detail?: Record<string, unknown>;
  constructor(msg: string, pos?: Pos, detail?: Record<string, unknown>) {
    super(msg);
    this.pos = pos;
    this.detail = detail;
  }
}

/** SameValueZero for numbers; structural for arrays, plain objects, Map, Set (Q058). */
export function deepEq(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b || (a !== a && b !== b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  if (a instanceof Map || b instanceof Map)
    return a instanceof Map && b instanceof Map && a.size === b.size && [...a].every(([k, v]) => b.has(k) && deepEq(v, b.get(k)));
  if (a instanceof Set || b instanceof Set)
    return a instanceof Set && b instanceof Set && a.size === b.size && [...a].every((v) => b.has(v));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** `pos` is the trailing argument of every method: where the call is in the source. */
export class Test {
  ok(cond: boolean, pos?: Pos): void { if (!cond) throw new TestFailure("t.ok: condition is false", pos); }
  eq<T>(a: T, b: T, pos?: Pos): void {
    if (!deepEq(a, b)) throw new TestFailure(`t.eq: ${show(a)} !== ${show(b)}`, pos, { kind: "eq", actual: safeDetailVal(a), expected: safeDetailVal(b) });
  }
  eqSlice<T>(a: Slice<T>, b: Slice<T>, pos?: Pos): void {
    if (a.length !== b.length)
      throw new TestFailure(`t.eqSlice: length ${a.length} !== ${b.length}`, pos, { kind: "eqSlice", actualLength: a.length, expectedLength: b.length });
    for (let i = 0; i < a.length; i++) {
      const av = a.get(i), bv = b.get(i);
      if (!deepEq(av, bv))
        throw new TestFailure(`t.eqSlice: [${i}] ${show(av)} !== ${show(bv)}`, pos, { kind: "eqSlice", index: i, actualLength: a.length, expectedLength: b.length, actual: safeDetailVal(av), expected: safeDetailVal(bv) });
    }
  }
  /** Fails unless `f` traps with exactly `code`. Other exceptions propagate. */
  traps(code: string, f: () => void, pos?: Pos): void {
    try { f(); } catch (x) {
      const e = asTrap(x);
      if (!e) throw x;
      if (e.code === code) return;
      throw new TestFailure(`t.traps: expected ${code}, got ${e.code}`, pos, { kind: "traps", expectedCode: code, actualCode: e.code });
    }
    throw new TestFailure(`t.traps: expected ${code}, no trap`, pos, { kind: "traps", expectedCode: code, actualCode: null });
  }
}
const show = (x: unknown): string => {
  try { return JSON.stringify(x, (_, v) => (typeof v === "bigint" ? String(v) : v)) ?? String(x); } catch { return String(x); }
};
function safeDetailVal(v: unknown, seen = new Set<unknown>()): unknown {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "bigint" || typeof v === "symbol" || typeof v === "function") return String(v);
  if (typeof v !== "object") return undefined;
  if (seen.has(v)) return "[Circular]";
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => safeDetailVal(x, seen));
    if (v instanceof Map) return [...v.entries()].map(([k, val]) => [safeDetailVal(k, seen), safeDetailVal(val, seen)]);
    if (v instanceof Set) return [...v.values()].map((x) => safeDetailVal(x, seen));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = safeDetailVal(val, seen);
    return out;
  } catch { return String(v); } finally { seen.delete(v); }
}

const preMap = new WeakMap<(...args: never[]) => unknown, (...args: unknown[]) => boolean>();
/** Registers a function's own leading `requires` precondition checker for `forAll`. */
export function setPre(fn: (...args: never[]) => unknown, pre: (...args: unknown[]) => boolean): void { preMap.set(fn, pre); }

type Trial = { kind: "ok" } | { kind: "skip" } | { kind: "fail"; reason: string; trap?: Trap; pos?: Pos };

/** Runs property-based testing over 100 valid inputs (max 1,000 precondition skips) and shrinks any counterexample (SPEC §16.1). */
export function forAll(
  fn: (...args: unknown[]) => unknown,
  descs: readonly GenDesc[],
  checkBool: boolean,
  pos?: Pos,
  preArg?: (...args: unknown[]) => boolean,
): void {
  const pre = preArg ?? preMap.get(fn as (...args: never[]) => unknown);
  const runTrial = (raw: readonly unknown[]): Trial => {
    const args = materializeArgs(descs, raw);
    try {
      if (pre && !pre(...args)) return { kind: "skip" };
      const res = fn(...args);
      if (checkBool && res === false) return { kind: "fail", reason: "returned false" };
      return { kind: "ok" };
    } catch (x) {
      if (x instanceof TestFailure) return { kind: "fail", reason: x.message, pos: x.pos };
      const tr = asTrap(x);
      if (tr) return { kind: "fail", reason: tr.code, trap: tr, pos: tr.pos };
      throw x;
    }
  };
  const rng = createRng();
  let passed = 0, rejected = 0;
  while (passed < 100) {
    const raw = generateRaw(descs, rng, Math.min(30, 1 + Math.floor(passed / 3)));
    const res = runTrial(raw);
    if (res.kind === "skip") {
      if (++rejected >= 1000) throw new TestFailure(`forAll: gave up after ${rejected} precondition rejections (${passed} passed)`, pos, { kind: "forAll", passed, rejected });
      continue;
    }
    if (res.kind === "fail") {
      let lastFail = res;
      const shrunk = shrinkRaw(descs, raw, (cand) => {
        const r = runTrial(cand);
        if (r.kind === "fail") { lastFail = r; return true; }
        return false;
      });
      const counterexample = formatArgs(descs, shrunk);
      throw new TestFailure(
        `forAll: counterexample ${JSON.stringify(counterexample)} (${lastFail.trap ? lastFail.trap.code : lastFail.reason})`,
        pos,
        {
          kind: "forAll",
          counterexample: safeDetailVal(counterexample),
          reason: lastFail.trap ? lastFail.trap.code : lastFail.reason,
          ...(lastFail.trap ? { trap: { code: lastFail.trap.code, ...(lastFail.trap.pos ? { pos: lastFail.trap.pos } : {}) } } : {}),
        },
      );
    }
    passed++;
  }
}

type TestFn = (t: Test) => void | Promise<void>;
const registry: { name: string; fn: TestFn }[] = [];
/** Registers; the translator emits these calls only for `szigyr test`. Duplicate names are allowed (Q058). */
export function test(name: string, fn: TestFn): void { registry.push({ name, fn }); }
export function clearTests(): void { registry.length = 0; }

/** Runs registered tests in order. A failed assertion ends only that test. */
export async function runTests(): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const { name, fn } of [...registry]) {
    takeIsolateTrap();
    try {
      const rejected = await capturing(() => fn(new Test()));
      if (rejected.length) throw rejected[0];
      task(undefined);
      const ft = takeIsolateTrap();
      if (ft) trap(ft.code as TrapCode, ft.message ?? "trap in an isolate", ft.file ? { file: ft.file, line: ft.line!, col: ft.col! } : undefined);
      out.push({ name, ok: true });
    }
    catch (x) {
      const e = asTrap(x);
      if (x instanceof TestFailure) out.push({ name, ok: false, failure: x.message, pos: x.pos, ...(x.detail ? { detail: x.detail } : {}) });
      else if (e) out.push({ name, ok: false, failure: e.message, trap: { code: e.code, pos: e.pos }, pos: e.pos });
      else throw x; // internal error: do not hide it
    } finally {
      stopFakeIsolates();
    }
  }
  return out;
}
