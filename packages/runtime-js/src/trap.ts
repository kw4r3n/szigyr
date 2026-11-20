/** Opaque to the runtime: the translator passes it, the host reads it back. Q060 (no range: start only). */
export interface Pos { readonly file: string; readonly line: number; readonly col: number }

export type TrapCode = "T001" | "T002" | "T003" | "T004" | "T005" | "T006" | "T007" | "T008" | "T009" | "T010" | "T011" | "T012" | "T013" | "T014" | "T015";

/** Not catchable from STS code; only hosts (test runner, main caller) see it. */
export class Trap extends Error {
  readonly code: TrapCode;
  readonly pos?: Pos;
  constructor(code: TrapCode, message: string, pos?: Pos) {
    super(`${code}: ${message}`);
    this.code = code;
    this.pos = pos;
    this.name = "Trap";
  }
}

export function trap(code: TrapCode, message: string, pos?: Pos): never {
  throw new Trap(code, message, pos);
}

let foreignTrapCheck: (() => void) | undefined;
/** The host of a C backend program installs the §15.4 (2) check: it throws the trap recorded
 * on another thread, if one is waiting. Installed per program load; unset for JS programs. */
export function setForeignTrapCheck(f: (() => void) | undefined): void { foreignTrapCheck = f; }
/** §15.4 (2): a value reaches its await resumption only after the foreign-trap check. */
export function task<T>(v: T): T { foreignTrapCheck?.(); return v; }

/** A trap from another thread or isolate, on its way to the managed side (§15.4). */
export interface ForeignTrap { code: string; file?: string; line?: number; col?: number }
let isolateTrap: ForeignTrap | undefined;
/** §15.4: the first foreign trap recorded wins; later ones are dropped. */
export function noteIsolateTrap(t: ForeignTrap): void { isolateTrap ??= t; }
/** Claims the recorded isolate trap, if any (the surfacing points of §15.4). */
export function takeIsolateTrap(): ForeignTrap | undefined { const t = isolateTrap; isolateTrap = undefined; return t; }

let stackLocator: ((e: Error) => Pos | undefined) | undefined;
/** The host maps a JS stack-overflow error to the source call where it happened (Q035, D032). */
export function setStackLocator(f: ((e: Error) => Pos | undefined) | undefined): void { stackLocator = f; }
/** A Trap, or JS stack exhaustion: what the Js boundary must pass through instead of turning it into a JsError (§8). */
export const isTrap = (e: unknown): boolean => e instanceof Trap || (e instanceof RangeError && /call stack/i.test(e.message));
/** `e` as a trap: a Trap itself, or any RangeError (stack exhaustion, string / array / Map length limits: syntax that no builtin wraps) as T006 (Q035). Anything else is undefined. */
export function asTrap(e: unknown): Trap | undefined {
  if (e instanceof Trap) return e;
  if (e instanceof RangeError) return new Trap("T006", e.message, stackLocator?.(e));
  return undefined;
}

// Q140: a Promise nobody awaits can reject after its caller finished. Node reports that as `unhandledRejection` once the microtask queue drains.
const sinks: unknown[][] = [];
const onRejection = (e: unknown): void => { sinks.at(-1)?.push(e); };
/** Runs `f` and, after it settles, lets pending rejections surface; returns those that nobody handled (the innermost caller collects them). */
export async function capturing(f: () => unknown): Promise<unknown[]> {
  const sink: unknown[] = [];
  if (!sinks.length) process.on("unhandledRejection", onRejection);
  sinks.push(sink);
  try {
    await f();
    await new Promise<void>((r) => setImmediate(r));
    return sink;
  } finally {
    sinks.pop();
    if (!sinks.length) process.off("unhandledRejection", onRejection);
  }
}
/** A builtin that may throw a JS exception (Q035): the exception is a panic (T006) at the builtin's name. */
export function guarded(recv: unknown, name: string, args: unknown[], pos?: Pos): unknown {
  try {
    return (recv as Record<string, (...a: unknown[]) => unknown>)[name]!(...args);
  } catch (e) {
    if (e instanceof Trap) throw e;
    return trap("T006", `${name}: ${e instanceof Error ? e.message : String(e)}`, pos);
  }
}

// Contracts (SPEC 9.1). `ensures` takes the predicate and the return value: the translator calls it on every return path.
export function requires(cond: boolean, pos?: Pos): void { if (!cond) trap("T004", "requires violated", pos); }
export function ensures<R>(pred: (r: R) => boolean, r: R, pos?: Pos): void { if (!pred(r)) trap("T005", "ensures violated", pos); }
export function invariant(cond: boolean, pos?: Pos): void { if (!cond) trap("T010", "invariant violated", pos); }
export function panic(msg: string, pos?: Pos): never { return trap("T006", msg, pos); }
