// §12 allowlist for P2 (D010): builtin type names, global values, namespace and member tables (signatures from Q032, Q033, Q038).
import {
  BOOL, ERROR_RECORD, F64, NULL, STR, UNKNOWN, USIZE, VOID, fn, gen, newTParam, nullable, num, opaque, result, record, ro,
  type FnType, type GenName, type NumName, type Type, NUM_NAMES, GEN_ARITY, OPAQUE_NAMES,
} from "./types.ts";
import { DETMATH_BINARY, DETMATH_UNARY } from "./detmath.ts";

/** Names reserved by §13 / Q011 that resolve to nothing (E2000). */
export const RESERVED = new Set(["i64", "u64", "bigint", "undefined", "Net"]); // Ffi resolves since §14, Spawn since §15.2 (opaque authority types)

/** Q006: unresolved names that are global authorities (E5001). */
export const GLOBAL_AUTHORITIES = new Set([
  "console", "Date", "fetch", "process", "globalThis", "window", "self", "global", "setTimeout", "setInterval", "clearTimeout",
  "clearInterval", "setImmediate", "queueMicrotask", "performance", "crypto", "navigator", "document", "localStorage",
  "sessionStorage", "XMLHttpRequest", "WebSocket", "Worker", "Deno", "Bun", "require",
]);

/** Namespace objects (Q034). */
export const NAMESPACES = new Set(["Math", "Number", "JSON", "String", "Promise", "Vec", "Pool", "Arena", "Ring", "OwnedCell", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs", "TestAlloc", "DetMath", "Ptr", "CHandle"]);
/** Builtin functions handled by the checker (§12). */
export const BUILTIN_FUNCTIONS = new Set([...NUM_NAMES, "wrapAdd", "wrapSub", "wrapMul", "divTrunc", "rem", "ok", "err", "panic", "cast", "requires", "ensures", "invariant", "test", "cfn"]);

/** Builtin type names (§12) that are not generic constructors. Struct and Result are handled by the resolver. */
export function builtinType(name: string): Type | undefined {
  switch (name) {
    case "boolean": return BOOL;
    case "string": return STR;
    case "number": return F64;
    case "null": return NULL;
    case "void": return VOID;
    case "unknown": return UNKNOWN;
    case "never": return { k: "prim", name: "never" };
    case "JsError": case "CastError": case "IoError": return ERROR_RECORD;
  }
  if ((NUM_NAMES as readonly string[]).includes(name)) return num(name as NumName);
  if (OPAQUE_NAMES.has(name) && !["FakeClock", "SeededRandom", "MemoryLog", "FakeFs"].includes(name)) return opaque(name);
  return undefined;
}
export const isGenName = (n: string): n is GenName => Object.hasOwn(GEN_ARITY, n);

export type Member =
  | { kind: "prop"; type: Type; readonly: boolean }
  /** `managedOnly`: E4001 from strict / rt (Q044). */
  | { kind: "method"; sig: FnType; managedOnly?: boolean };

const prop = (type: Type): Member => ({ kind: "prop", type, readonly: true });
const m = (params: Type[], ret: Type, extra: Partial<FnType> = {}): Member => ({ kind: "method", sig: { ...fn(params, ret), ...extra } });
const cb = (params: Type[], ret: Type): FnType => ({ ...fn(params, ret), prefix: true });
const mo = (x: Member): Member => ({ ...x, managedOnly: true } as Member);
const ioResult = (t: Type): Type => result(t, ERROR_RECORD);

const LOG: Record<string, Member> = { info: m([STR], VOID), warn: m([STR], VOID), error: m([STR], VOID) };
const RANDOM: Record<string, Member> = { nextF64: m([], F64), nextU32: m([], num("u32")) };
const FS: Record<string, Member> = { readText: m([STR], ioResult(STR)), writeText: m([STR, STR], ioResult(NULL)) };

function opaqueMember(name: string, member: string): Member | undefined {
  const lit = (v: string): Type => ({ k: "lit", value: v });
  const table: Record<string, () => Record<string, Member>> = {
    System: () => ({ alloc: prop(opaque("Alloc")), fs: prop(opaque("Fs")), clock: prop(opaque("Clock")), random: prop(opaque("Random")), log: prop(opaque("Log")), js: prop(opaque("Js")), ffi: prop(opaque("Ffi")), spawn: prop(opaque("Spawn")) }),
    Log: () => LOG,
    Clock: () => ({ nowMs: m([], F64) }),
    Random: () => RANDOM,
    Fs: () => FS,
    Alloc: () => ({}),
    Ffi: () => ({}), // §14: the Ffi value itself has no members; it is only passed to C functions
    // §15.2: `isolate` never reaches callSig; expr.ts checks the call itself (E2011) because the
    // argument is a function *name*, not a value. This entry only lets member() resolve the name.
    Spawn: () => ({ isolate: m([UNKNOWN], VOID) }),
    JsRef: () => ({}),
    Js: () => {
      const J = opaque("JsRef"), jr = result(J, ERROR_RECORD);
      const T = newTParam("T"), U = newTParam("T"), A = newTParam("T");
      return {
        // Q128: the callback gets its one argument from JS, checked like `decode` does.
        callback: m([fn([result({ k: "tparam", p: A }, ERROR_RECORD)], VOID)], J, { tparams: [A], tcheck: "cast" }),
        call: m([J, gen("Array", J)], jr), get: m([J, STR], jr), await: m([J], gen("Promise", jr)),
        decode: m([J], result({ k: "tparam", p: T }, ERROR_RECORD), { tparams: [T], tcheck: "cast" }), encode: m([{ k: "tparam", p: U }], J, { tparams: [U], tcheck: "cast" }), // Q128
      };
    },
    Test: () => {
      const T = newTParam("T"), U = newTParam("T");
      const tT: Type = { k: "tparam", p: T }, tU: Type = { k: "tparam", p: U };
      return mapValues({
        ok: m([BOOL], VOID), eq: m([tT, tT], VOID, { tparams: [T], tcheck: "eq" }),
        eqSlice: m([gen("Ref", gen("Slice", tU)), gen("Ref", gen("Slice", tU))], VOID, { tparams: [U] }),
        traps: m([STR, fn([], VOID)], VOID, { tcheck: "trap" }),
      }, mo);
    },
    FakeClock: () => ({ nowMs: m([], F64), advance: m([F64], VOID) }),
    SeededRandom: () => RANDOM,
    MemoryLog: () => ({ ...LOG, entries: m([], gen("Array", record([ro("level", { k: "union", members: [lit("info"), lit("warn"), lit("error")] }), ro("message", STR)]))) }),
    FakeFs: () => FS,
  };
  const t = table[name]?.();
  return t && Object.hasOwn(t, member) ? t[member] : undefined;
}
const mapValues = (o: Record<string, Member>, f: (x: Member) => Member): Record<string, Member> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

export function stringMember(name: string): Member | undefined {
  const sigs: Record<string, Member> = {
    length: prop(USIZE),
    slice: m([USIZE, USIZE], STR, { min: 1 }), indexOf: m([STR], nullable(USIZE)), includes: m([STR], BOOL), startsWith: m([STR], BOOL),
    endsWith: m([STR], BOOL), split: m([STR], gen("Array", STR)), trim: m([], STR), toUpperCase: m([], STR), toLowerCase: m([], STR),
    padStart: m([USIZE, STR], STR), padEnd: m([USIZE, STR], STR), replaceAll: m([STR, STR], STR),
    charCodeAt: m([USIZE], num("u16")), codePointAt: m([USIZE], nullable(num("u32"))),
  };
  return Object.hasOwn(sigs, name) ? sigs[name] : undefined;
}

function arrayMember(name: string, T: Type, readonly: boolean): Member | undefined {
  const A = newTParam("A"), U = newTParam("U");
  const tA: Type = { k: "tparam", p: A }, tU: Type = { k: "tparam", p: U };
  const pred = cb([T, USIZE], BOOL);
  const sigs: Record<string, Member> = {
    length: prop(USIZE),
    slice: m([USIZE, USIZE], gen("Array", T), { min: 0 }),
    map: m([cb([T, USIZE], tU)], gen("Array", tU), { tparams: [U] }),
    filter: m([pred], gen("Array", T)),
    reduce: m([cb([tA, T, USIZE], tA), tA], tA, { tparams: [A] }),
    forEach: m([cb([T, USIZE], VOID)], VOID),
    find: m([pred], nullable(T)), findIndex: m([pred], nullable(USIZE)), some: m([pred], BOOL), every: m([pred], BOOL),
    includes: m([T], BOOL), indexOf: m([T], nullable(USIZE)), join: m([STR], STR, { min: 0 }),
    concat: m([gen("ReadonlyArray", T)], gen("Array", T)),
  };
  if (!readonly) {
    Object.assign(sigs, {
      push: m([T], USIZE), pop: m([], nullable(T)), reverse: m([], gen("Array", T)),
      sort: m([cb([T, T], F64)], gen("Array", T)), fill: m([T, USIZE, USIZE], gen("Array", T), { min: 1 }),
    });
  }
  return Object.hasOwn(sigs, name) ? sigs[name] : undefined;
}

/** Members of builtin generic types. undefined = not in the allowlist (E2001). */
export function genMember(t: { name: GenName; args: Type[] }, name: string): Member | undefined {
  const [a, b] = t.args as [Type, Type];
  switch (t.name) {
    case "Array": return arrayMember(name, a, false);
    case "ReadonlyArray": return arrayMember(name, a, true);
    case "Map": {
      const sigs: Record<string, Member> = {
        get: m([a], nullable(b)), set: m([a, b], t as Type), has: m([a], BOOL), delete: m([a], BOOL), size: prop(USIZE), clear: m([], VOID),
        keys: m([], { k: "iter", elem: a }), values: m([], { k: "iter", elem: b }), forEach: m([cb([b, a], VOID)], VOID),
      };
      return Object.hasOwn(sigs, name) ? sigs[name] : undefined;
    }
    case "Set": {
      const sigs: Record<string, Member> = {
        add: m([a], t as Type), has: m([a], BOOL), delete: m([a], BOOL), size: prop(USIZE), clear: m([], VOID),
        values: m([], { k: "iter", elem: a }), forEach: m([cb([a], VOID)], VOID),
      };
      return Object.hasOwn(sigs, name) ? sigs[name] : undefined;
    }
    case "Vec": case "Slice": {
      const sigs: Record<string, Member> = {
        length: prop(USIZE), fill: m([a], VOID), slice: m([USIZE, USIZE], gen("Slice", a)),
        ...(t.name === "Vec" ? { push: m([a], VOID), pop: m([], nullable(a)), clear: m([], VOID) } : {}),
      };
      return Object.hasOwn(sigs, name) ? sigs[name] : undefined;
    }
    case "Pool": {
      const h = gen("Handle", a);
      const sigs: Record<string, Member> = {
        length: prop(USIZE), capacity: prop(USIZE),
        insert: m([a], nullable(h)), get: m([h], a), set: m([h, a], VOID), remove: m([h], a), has: m([h], BOOL),
      };
      return Object.hasOwn(sigs, name) ? sigs[name] : undefined;
    }
    case "Arena": {
      const T = newTParam("T"), tT: Type = { k: "tparam", p: T };
      const sigs: Record<string, Member> = {
        remaining: prop(USIZE), reset: m([], VOID),
        alloc: m([USIZE, tT], nullable(gen("ArenaBuf", tT)), { tparams: [T], tcheck: "copy" }),
        view: m([gen("ArenaBuf", tT)], gen("Slice", tT), { tparams: [T], tcheck: "copy" }),
      };
      return Object.hasOwn(sigs, name) ? sigs[name] : undefined;
    }
    case "ArenaBuf": return name === "length" ? prop(USIZE) : undefined;
    case "RingTx": return name === "push" ? m([a], BOOL) : undefined; // §15.1: Mut receiver (ownership.ts), no allocation
    case "RingRx": return name === "pop" ? m([], nullable(a)) : undefined;
    case "OwnedCell": {
      const sigs: Record<string, Member> = { take: m([], a), put: m([a], VOID), isEmpty: m([], BOOL) };
      return Object.hasOwn(sigs, name) ? sigs[name] : undefined;
    }
    case "Ptr": { // §14.4: which of these a given T allows is the checker's E2001 table, not this list
      const U = newTParam("U"), tU: Type = { k: "tparam", p: U };
      const sigs: Record<string, Member> = {
        isNull: m([], BOOL), read: m([], a), write: m([a], VOID),
        offset: m([USIZE], gen("Ptr", a)), slice: m([USIZE], gen("Slice", a)),
        borrow: m([], a), unbox: m([], a),
        cast: m([], gen("Ptr", tU), { tparams: [U], tcheck: "castptr" }),
      };
      return Object.hasOwn(sigs, name) ? sigs[name] : undefined;
    }
    case "ConstPtr": {
      const U = newTParam("U"), tU: Type = { k: "tparam", p: U };
      const sigs: Record<string, Member> = {
        isNull: m([], BOOL), read: m([], a),
        offset: m([USIZE], gen("ConstPtr", a)), slice: m([USIZE], gen("Slice", a)),
        borrow: m([], a),
        cast: m([], gen("ConstPtr", tU), { tparams: [U], tcheck: "castptr" }),
      };
      return Object.hasOwn(sigs, name) ? sigs[name] : undefined;
    }
    case "CHandle": return name === "get" ? m([], gen("Ptr", a)) : undefined; // §14.5
    case "Port": { // §15.2: S is sent, R is received; recv's Promise may be awaited (and, for an owned R, only awaited: §5.6)
      const sigs: Record<string, Member> = { send: m([a], VOID), recv: m([], gen("Promise", nullable(b))), close: m([], VOID) };
      return Object.hasOwn(sigs, name) ? sigs[name] : undefined;
    }
    default: return undefined; // Promise: await and Promise.all only (§12); Ref / Mut are unwrapped before lookup
  }
}

export { opaqueMember };

const MATH_ALL = ["abs", "sqrt", "floor", "ceil", "trunc", "round", "sign"];
const MATH_MANAGED = ["sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "log2", "log10", "cbrt"];

/** Members of namespace objects (Q032 - Q034, Q038). `min`/`max` are variadic and handled by the checker. */
export function nsMember(ns: string, name: string): Member | "variadic" | undefined {
  const T = newTParam("T"), tT: Type = { k: "tparam", p: T };
  switch (ns) {
    case "Math":
      if (name === "random") return undefined; // E5001, reported by the checker
      if (MATH_ALL.includes(name)) return m([F64], F64);
      if (MATH_MANAGED.includes(name)) return mo(m([F64], F64));
      if (name === "atan2" || name === "pow" || name === "hypot") return mo(m([F64, F64], F64));
      if (name === "fround") return m([F64], num("f32"));
      if (name === "min" || name === "max") return "variadic";
      if (name === "PI" || name === "E") return prop(F64);
      return undefined;
    case "Number": {
      const sigs: Record<string, Member> = {
        isFinite: m([F64], BOOL), isNaN: m([F64], BOOL), isInteger: m([F64], BOOL), parseFloat: m([STR], F64),
        MAX_SAFE_INTEGER: prop(F64), EPSILON: prop(F64),
      };
      return Object.hasOwn(sigs, name) ? mo(sigs[name]!) : undefined;
    }
    case "JSON":
      if (name === "parse") return mo(m([STR], result(UNKNOWN, ERROR_RECORD))); // Q035
      if (name === "stringify") return mo(m([tT], STR, { tparams: [T], tcheck: "cast" }));
      return undefined;
    case "String": return name === "fromCodePoint" ? mo(m([num("u32")], STR)) : undefined;
    case "Promise": return name === "all" ? mo(m([gen("Array", gen("Promise", tT))], gen("Promise", gen("Array", tT)), { tparams: [T] })) : undefined;
    case "DetMath": // §12 (Q191): rt functions, so callable from every layer; f64 only
      if (DETMATH_UNARY.includes(name)) return m([F64], F64);
      if (DETMATH_BINARY.includes(name)) return m([F64, F64], F64);
      return undefined;
    case "Vec": return name === "create" ? m([opaque("Alloc"), USIZE], gen("Vec", tT), { tparams: [T], tcheck: "copy" }) : undefined;
    case "Pool": return name === "create" ? m([opaque("Alloc"), USIZE], gen("Pool", tT), { tparams: [T], tcheck: "copy" }) : undefined;
    case "Arena": return name === "create" ? m([opaque("Alloc"), USIZE], gen("Arena")) : undefined;
    case "Ring": return name === "create" ? m([opaque("Alloc"), USIZE], record([{ name: "tx", type: gen("RingTx", tT), readonly: false }, { name: "rx", type: gen("RingRx", tT), readonly: false }], true), { tparams: [T], tcheck: "ring" }) : undefined; // §15.1 (Q199)
    case "OwnedCell": return name === "create" ? m([tT], gen("OwnedCell", tT), { tparams: [T] }) : undefined;
    case "Ptr": return name === "box" ? m([opaque("Alloc"), tT], gen("Ptr", tT), { tparams: [T], tcheck: "box" }) : undefined; // §14.4
    case "CHandle": return name === "create" ? m([gen("Ptr", tT)], gen("CHandle", tT), { tparams: [T], tcheck: "chandle" }) : undefined; // §14.5
    case "FakeClock": return name === "create" ? mo(m([F64], opaque("FakeClock"))) : undefined;
    case "SeededRandom": return name === "create" ? mo(m([num("u32")], opaque("SeededRandom"))) : undefined;
    case "MemoryLog": return name === "create" ? mo(m([], opaque("MemoryLog"))) : undefined;
    case "FakeFs": return name === "create" ? mo(m([], opaque("FakeFs"))) : undefined;
    case "TestAlloc": return name === "create" ? mo(m([], opaque("Alloc"))) : undefined;
  }
  return undefined;
}
