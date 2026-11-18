import { Trap, type Pos, type TrapCode } from "./trap.ts";
import type { Slice } from "./collections.ts";

export interface TestResult {
  readonly name: string;
  readonly ok: boolean;
  /** Set when ok is false. */
  readonly failure?: string;
  /** Set when the test failed by an uncaught trap. */
  readonly trap?: { readonly code: TrapCode; readonly pos?: Pos };
  /** Position of the failed assertion, when the translator passed one. */
  readonly pos?: Pos;
}

class Failure extends Error { constructor(msg: string, readonly pos?: Pos) { super(msg); } }

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
  ok(cond: boolean, pos?: Pos): void { if (!cond) throw new Failure("t.ok: condition is false", pos); }
  eq<T>(a: T, b: T, pos?: Pos): void { if (!deepEq(a, b)) throw new Failure(`t.eq: ${show(a)} !== ${show(b)}`, pos); }
  eqSlice<T>(a: Slice<T>, b: Slice<T>, pos?: Pos): void {
    if (a.length !== b.length) throw new Failure(`t.eqSlice: length ${a.length} !== ${b.length}`, pos);
    for (let i = 0; i < a.length; i++)
      if (!deepEq(a.get(i), b.get(i))) throw new Failure(`t.eqSlice: [${i}] ${show(a.get(i))} !== ${show(b.get(i))}`, pos);
  }
  /** Fails unless `f` traps with exactly `code`. Other exceptions propagate. */
  traps(code: string, f: () => void, pos?: Pos): void {
    try { f(); } catch (e) {
      if (!(e instanceof Trap)) throw e;
      if (e.code === code) return;
      throw new Failure(`t.traps: expected ${code}, got ${e.code}`, pos);
    }
    throw new Failure(`t.traps: expected ${code}, no trap`, pos);
  }
}
const show = (x: unknown): string => { try { return JSON.stringify(x) ?? String(x); } catch { return String(x); } };

type TestFn = (t: Test) => void | Promise<void>;
const registry: { name: string; fn: TestFn }[] = [];
/** Registers; the translator emits these calls only for `sts test`. Duplicate names are allowed (Q058). */
export function test(name: string, fn: TestFn): void { registry.push({ name, fn }); }
export function clearTests(): void { registry.length = 0; }

/** Runs registered tests in order. A failed assertion ends only that test. */
export async function runTests(): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const { name, fn } of [...registry]) {
    try { await fn(new Test()); out.push({ name, ok: true }); }
    catch (e) {
      if (e instanceof Failure) out.push({ name, ok: false, failure: e.message, pos: e.pos });
      else if (e instanceof Trap) out.push({ name, ok: false, failure: e.message, trap: { code: e.code, pos: e.pos }, pos: e.pos });
      else throw e; // internal error: do not hide it
    }
  }
  return out;
}
