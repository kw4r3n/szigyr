// §12 allowlist for P2 (D010): builtin type names, global values, namespace and member tables (signatures from Q032, Q033, Q038).
import {
  AUDIO_CONFIG_RECORD, ASYNC_DISPOSABLE, BOOL, DISPOSABLE, ERROR_RECORD, F64, NULL, STR, UNKNOWN, USIZE, VOID, fn, gen, newTParam, nullable, num, opaque, result, record, ro, unref,
  type FnType, type GenName, type NumName, type Type, AUTHORITIES, NUM_NAMES, GEN_ARITY, OPAQUE_NAMES,
} from "./types.ts";
import { DETMATH_BINARY, DETMATH_UNARY } from "./detmath.ts";

/** Names reserved by §13 / Q011 that resolve to nothing (E2000). */
export const RESERVED = new Set(["bigint", "undefined", "Net"]); // Ffi resolves since §14, Spawn since §15.2, i64/u64 in §3.1

/** Q006: unresolved names that are global authorities (E5001). */
export const GLOBAL_AUTHORITIES = new Set([
  "console", "Date", "fetch", "process", "globalThis", "window", "self", "global", "setTimeout", "setInterval", "clearTimeout",
  "clearInterval", "setImmediate", "queueMicrotask", "performance", "crypto", "navigator", "document", "localStorage",
  "sessionStorage", "XMLHttpRequest", "WebSocket", "Worker", "Deno", "Bun", "require",
]);

/** Namespace objects (Q034). */
export const NAMESPACES = new Set(["Math", "Number", "JSON", "String", "Promise", "Vec", "Pool", "Arena", "Ring", "OwnedCell", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs", "FakeAudio", "TestAlloc", "DetMath", "Ptr", "CHandle"]);
/** Builtin functions handled by the checker (§12). */
export const BUILTIN_FUNCTIONS = new Set([...NUM_NAMES, "wrapAdd", "wrapSub", "wrapMul", "divTrunc", "rem", "ok", "err", "panic", "cast", "requires", "ensures", "invariant", "test", "forAll", "cfn"]);
/** §13: the identifier-like names it reserves (declaring or referencing one is E1000 / E2000, Q231). */
export const SPEC_RESERVED = ["bigint", "undefined", "FixedArray", "Rc", "Weak", "Net", "decreases"];
/** §12 global names, §13 reserved names; declaring any of them is E1000 (Q010, Q231). The tables here plus the names only the resolver and §7.1 know. */
export const CAPABILITY_NAMES = new Set(["Copy", "Native", "Owned", "Send", "Key", "Codec"]);

export const BUILTIN_NAMES = new Set<string>([
  ...SPEC_RESERVED,
  "boolean", "string", "number", "null", "void", "unknown", "never", "Result", "Struct", "RingPair", "JsError", "CastError", "IoError", "AudioConfig", "Resource", "Disposable", "AsyncDisposable", "CStruct",
  ...Object.keys(GEN_ARITY), ...OPAQUE_NAMES, ...NAMESPACES, ...BUILTIN_FUNCTIONS,
]);

/** §7.3: builtin types that make a function nondeterministic when a parameter type contains them (D132; determinism.ts). */
export const NONDET_GEN: Record<GenName, boolean> = {
  Array: false, ReadonlyArray: false, Map: false, Set: false, Promise: false, Vec: false, Slice: false, Pool: false, Handle: false, Arena: false, ArenaBuf: false,
  Ref: false, Mut: false, OwnedCell: false, CType: false, RingTx: true, RingRx: true, Ptr: true, ConstPtr: true, CHandle: true, Port: true, // §15.1, §14.4, §14.5, §15.2
};
/** The opaque ones (keys: OPAQUE_NAMES): the authorities, `JsRef`, `AudioStream` and the fakes, not `Test`. */
export const NONDET_OPAQUE: Record<string, boolean> = {
  ...Object.fromEntries(AUTHORITIES.map((a) => [a, true])), JsRef: true, Test: false, AudioStream: true, FakeClock: true, SeededRandom: true, MemoryLog: true, FakeFs: true, FakeAudio: true,
};

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
    case "AudioConfig": return AUDIO_CONFIG_RECORD;
    case "Disposable": return DISPOSABLE;
    case "AsyncDisposable": return ASYNC_DISPOSABLE;
  }
  if ((NUM_NAMES as readonly string[]).includes(name)) return num(name as NumName);
  if (OPAQUE_NAMES.has(name) && !["FakeClock", "SeededRandom", "MemoryLog", "FakeFs", "FakeAudio"].includes(name)) return opaque(name);
  return undefined;
}
export const isGenName = (n: string): n is GenName => Object.hasOwn(GEN_ARITY, n);

/**
 * D132: the effects of a builtin method, declared once next to its signature and read by the other passes.
 * - `recv`: how the receiver is borrowed (§3.3, §14.4, §15.1; ownership.ts). `param`: only as a borrowed argument (else E3004),
 *   in the parameter's mode. `none`: not borrowed (managed values, authorities, `Ptr`, namespaces).
 * - `mutates`: changes the receiver or the outside world.
 * - `contract`: callable inside a contract (Q134, Q232: E6002 when false, judged by the receiver type; expr.ts `bannedCall`).
 * - `traps`: the codes the §6 rt trap-site list gives at the member name (traps.ts).
 */
export interface Fx { recv: "ref" | "mut" | "param" | "none"; mutates: boolean; contract: boolean; traps: readonly string[] }
const fx = (recv: Fx["recv"], mutates: boolean, contract = !mutates, traps: readonly string[] = []): Fx => ({ recv, mutates, contract, traps });
const RD = fx("none", false), WR = fx("none", true), REF = fx("ref", false), MUT = fx("mut", true);
const NUL = (f: Fx): Fx => ({ ...f, traps: ["T015"] }); // §14.4: a null Ptr / ConstPtr traps at the member name
const PRD = NUL(RD), PWR = NUL(WR), PARAM = NUL(fx("param", false));
const PORT_FX = fx("none", true, false); // changes the port's state or the outside world: a contract cannot call it (Q230 (a))

export type Member =
  | { kind: "prop"; type: Type; readonly: boolean }
  /** `managedOnly`: E4001 from strict / rt (Q044). */
  | { kind: "method"; sig: FnType; fx: Fx; managedOnly?: boolean };
type Members = Record<string, Member>;

const prop = (type: Type): Member => ({ kind: "prop", type, readonly: true });
const m = (f: Fx, params: Type[], ret: Type, extra: Partial<FnType> = {}): Member => ({ kind: "method", sig: { ...fn(params, ret), ...extra }, fx: f });
const cb = (params: Type[], ret: Type): FnType => ({ ...fn(params, ret), prefix: true });
const mo = (x: Member): Member => ({ ...x, managedOnly: true } as Member);
const ioResult = (t: Type): Type => result(t, ERROR_RECORD);
const pick = <M>(sigs: Record<string, M>, name: string): M | undefined => (Object.hasOwn(sigs, name) ? sigs[name] : undefined);
const mapValues = (o: Members, f: (x: Member) => Member): Members => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

const LOG: Members = { info: m(WR, [STR], VOID), warn: m(WR, [STR], VOID), error: m(WR, [STR], VOID) };
const RANDOM: Members = { nextF64: m(WR, [], F64), nextU32: m(WR, [], num("u32")) };
const FS: Members = { readText: m(RD, [STR], ioResult(STR)), writeText: m(WR, [STR, STR], ioResult(NULL)) };
const AUDIO: Members = { open: mo(m(PORT_FX, [AUDIO_CONFIG_RECORD, UNKNOWN, UNKNOWN], gen("Promise", ioResult(opaque("AudioStream"))))) };

/** Members of an opaque builtin type. */
export function opaqueMembers(name: string): Members {
  const lit = (v: string): Type => ({ k: "lit", value: v });
  const table: Record<string, () => Members> = {
    System: () => ({ alloc: prop(opaque("Alloc")), fs: prop(opaque("Fs")), clock: prop(opaque("Clock")), random: prop(opaque("Random")), log: prop(opaque("Log")), js: prop(opaque("Js")), ffi: prop(opaque("Ffi")), spawn: prop(opaque("Spawn")), audio: prop(opaque("Audio")) }),
    Log: () => LOG,
    Clock: () => ({ nowMs: m(RD, [], F64), sleep: mo(m(PORT_FX, [F64], gen("Promise", VOID))) }),
    Random: () => RANDOM,
    Fs: () => FS,
    Alloc: () => ({}),
    Ffi: () => ({}), // §14: the Ffi value itself has no members; it is only passed to C functions
    // §15.2: `isolate` never reaches callSig; expr.ts checks the call itself (E2011) because the
    // argument is a function *name*, not a value. This entry only lets member() resolve the name.
    Spawn: () => ({ isolate: m(PORT_FX, [UNKNOWN], VOID) }),
    // §15.5: `open` is checked in expr.ts (audioOpenCall, E2013) because `render` is a function name.
    Audio: () => AUDIO,
    AudioStream: () => ({ sampleRate: prop(num("u32")), channels: prop(num("u32")), close: mo(m(PORT_FX, [], gen("Promise", VOID))), disposeAsync: mo(m(PORT_FX, [], gen("Promise", VOID))), isOpen: mo(m(RD, [], BOOL)) }),
    JsRef: () => ({}),
    Js: () => {
      const J = opaque("JsRef"), jr = result(J, ERROR_RECORD);
      const argsT = gen("ReadonlyArray", J);
      const entryT = record([ro("key", STR), ro("value", J)]);
      const T = newTParam("T"), U = newTParam("T"), A = newTParam("T");
      return {
        // Q128: the callback gets its one argument from JS, checked like `decode` does.
        callback: m(RD, [fn([result({ k: "tparam", p: A }, ERROR_RECORD)], VOID)], J, { tparams: [A], tcheck: "cast" }),
        fn: m(RD, [cb([gen("Array", J)], J)], J),
        call: m(WR, [J, argsT], jr),
        new: m(WR, [J, argsT], jr),
        invoke: m(WR, [J, STR, argsT], jr),
        get: m(RD, [J, STR], jr),
        set: m(WR, [J, STR, J], result(NULL, ERROR_RECORD)),
        object: m(RD, [gen("ReadonlyArray", entryT)], J),
        await: m(WR, [J], gen("Promise", jr)),
        decode: m(RD, [J], result({ k: "tparam", p: T }, ERROR_RECORD), { tparams: [T], tcheck: "cast" }),
        encode: m(RD, [{ k: "tparam", p: U }], J, { tparams: [U], tcheck: "codec" }), // Q128
      };
    },
    Test: () => {
      const T = newTParam("T"), U = newTParam("T");
      const tT: Type = { k: "tparam", p: T }, tU: Type = { k: "tparam", p: U };
      return mapValues({
        ok: m(RD, [BOOL], VOID), eq: m(RD, [tT, tT], VOID, { tparams: [T], tcheck: "eq" }),
        eqSlice: m(RD, [gen("Ref", gen("Slice", tU)), gen("Ref", gen("Slice", tU))], VOID, { tparams: [U] }),
        traps: m(RD, [STR, fn([], VOID)], VOID, { tcheck: "trap" }),
      }, mo);
    },
    FakeClock: () => ({ nowMs: m(RD, [], F64), advance: m(WR, [F64], VOID), sleep: mo(m(PORT_FX, [F64], gen("Promise", VOID))) }),
    SeededRandom: () => RANDOM,
    MemoryLog: () => ({ ...LOG, entries: m(RD, [], gen("Array", record([ro("level", { k: "union", members: [lit("info"), lit("warn"), lit("error")] }), ro("message", STR)]))) }),
    FakeFs: () => FS,
    FakeAudio: () => ({ ...AUDIO, renderFrames: mo(m(PORT_FX, [USIZE], gen("Array", num("f32")))) }),
  };
  return Object.hasOwn(table, name) ? table[name]!() : {};
}
export const opaqueMember = (name: string, member: string): Member | undefined => pick(opaqueMembers(name), member);

export function stringMembers(): Members {
  return {
    length: prop(USIZE),
    slice: m(RD, [USIZE, USIZE], STR, { min: 1 }), indexOf: m(RD, [STR], nullable(USIZE)), includes: m(RD, [STR], BOOL), startsWith: m(RD, [STR], BOOL),
    endsWith: m(RD, [STR], BOOL), split: m(RD, [STR], gen("Array", STR)), trim: m(RD, [], STR), toUpperCase: m(RD, [], STR), toLowerCase: m(RD, [], STR),
    padStart: m(RD, [USIZE, STR], STR), padEnd: m(RD, [USIZE, STR], STR), replaceAll: m(RD, [STR, STR], STR),
    charCodeAt: m(RD, [USIZE], num("u16")), codePointAt: m(RD, [USIZE], nullable(num("u32"))),
  };
}
export const stringMember = (name: string): Member | undefined => pick(stringMembers(), name);

function arrayMembers(T: Type, readonly: boolean): Members {
  const A = newTParam("A"), U = newTParam("U");
  const tA: Type = { k: "tparam", p: A }, tU: Type = { k: "tparam", p: U };
  const pred = cb([T, USIZE], BOOL);
  const sigs: Members = {
    length: prop(USIZE),
    slice: m(RD, [USIZE, USIZE], gen("Array", T), { min: 0 }),
    map: m(RD, [cb([T, USIZE], tU)], gen("Array", tU), { tparams: [U] }),
    filter: m(RD, [pred], gen("Array", T)),
    reduce: m(RD, [cb([tA, T, USIZE], tA), tA], tA, { tparams: [A] }),
    forEach: m(RD, [cb([T, USIZE], VOID)], VOID),
    find: m(RD, [pred], nullable(T)), findIndex: m(RD, [pred], nullable(USIZE)), some: m(RD, [pred], BOOL), every: m(RD, [pred], BOOL),
    includes: m(RD, [T], BOOL), indexOf: m(RD, [T], nullable(USIZE)), join: m(RD, [STR], STR, { min: 0 }),
    concat: m(RD, [gen("ReadonlyArray", T)], gen("Array", T)),
  };
  if (!readonly) {
    Object.assign(sigs, {
      push: m(WR, [T], USIZE), pop: m(WR, [], nullable(T)), reverse: m(WR, [], gen("Array", T)),
      sort: m(WR, [cb([T, T], F64)], gen("Array", T)), fill: m(WR, [T, USIZE, USIZE], gen("Array", T), { min: 1 }),
    });
  }
  return sigs;
}

/** Members of builtin generic types. */
export function genMembers(t: { name: GenName; args: Type[] }): Members {
  const [a, b] = t.args as [Type, Type];
  switch (t.name) {
    case "Array": return arrayMembers(a, false);
    case "ReadonlyArray": return arrayMembers(a, true);
    case "Map": return {
      get: m(RD, [a], nullable(b)), set: m(WR, [a, b], t as Type), has: m(RD, [a], BOOL), delete: m(WR, [a], BOOL), size: prop(USIZE), clear: m(WR, [], VOID),
      keys: m(RD, [], { k: "iter", elem: a }), values: m(RD, [], { k: "iter", elem: b }), forEach: m(RD, [cb([b, a], VOID)], VOID),
    };
    case "Set": return {
      add: m(WR, [a], t as Type), has: m(RD, [a], BOOL), delete: m(WR, [a], BOOL), size: prop(USIZE), clear: m(WR, [], VOID),
      values: m(RD, [], { k: "iter", elem: a }), forEach: m(RD, [cb([a], VOID)], VOID),
    };
    case "Vec": case "Slice": return {
      length: prop(USIZE), fill: m(MUT, [a], VOID), slice: m(fx("param", false, true, ["T002"]), [USIZE, USIZE], gen("Slice", a)),
      ...(t.name === "Vec" ? { push: m(MUT, [a], VOID), pop: m(MUT, [], nullable(a)), clear: m(MUT, [], VOID) } : {}),
    };
    case "Pool": {
      const h = gen("Handle", a);
      return {
        length: prop(USIZE), capacity: prop(USIZE),
        insert: m(MUT, [a], nullable(h)), get: m(fx("ref", false, true, ["T011"]), [h], a), set: m(fx("mut", true, false, ["T011"]), [h, a], VOID),
        remove: m(fx("mut", true, false, ["T011"]), [h], a), has: m(REF, [h], BOOL),
      };
    }
    case "Arena": {
      const T = newTParam("T"), tT: Type = { k: "tparam", p: T };
      return {
        remaining: prop(USIZE), reset: m(MUT, [], VOID),
        alloc: m(MUT, [USIZE, tT], nullable(gen("ArenaBuf", tT)), { tparams: [T], tcheck: "alloc" }), // Q215 (c)
        view: m(fx("param", false, true, ["T012"]), [gen("ArenaBuf", tT)], gen("Slice", tT), { tparams: [T], tcheck: "copy" }),
      };
    }
    case "ArenaBuf": return { length: prop(USIZE) };
    case "RingTx": return { push: m(MUT, [a], BOOL) }; // §15.1: no allocation
    case "RingRx": return { pop: m(MUT, [], nullable(a)) };
    case "OwnedCell": return { take: m(WR, [], a), put: m(WR, [a], VOID), isEmpty: m(RD, [], BOOL) };
    case "Ptr": { // §14.4: which of these a given T allows is the checker's E2001 table, not this list
      const U = newTParam("U"), tU: Type = { k: "tparam", p: U };
      return {
        isNull: m(RD, [], BOOL), read: m(PRD, [], a), write: m(PWR, [a], VOID),
        offset: m(PRD, [USIZE], gen("Ptr", a)), slice: m(PARAM, [USIZE], gen("Slice", a)),
        borrow: m(PARAM, [], a), unbox: m(PWR, [], a),
        cast: m(RD, [], gen("Ptr", tU), { tparams: [U], tcheck: "castptr" }),
      };
    }
    case "ConstPtr": {
      const U = newTParam("U"), tU: Type = { k: "tparam", p: U };
      return {
        isNull: m(RD, [], BOOL), read: m(PRD, [], a),
        offset: m(PRD, [USIZE], gen("ConstPtr", a)), slice: m(PARAM, [USIZE], gen("Slice", a)),
        borrow: m(PARAM, [], a),
        cast: m(RD, [], gen("ConstPtr", tU), { tparams: [U], tcheck: "castptr" }),
      };
    }
    case "CHandle": return { get: m(REF, [], gen("Ptr", a)) }; // §14.5
    // §15.2: S is sent, R is received; recv's Promise may be awaited (and, for an owned R, only awaited: §5.6)
    case "Port": return { send: m(PORT_FX, [a], VOID), recv: m(PORT_FX, [], gen("Promise", nullable(b))), close: m(PORT_FX, [], VOID) };
    default: return {}; // Promise: await and Promise.all only (§12); Ref / Mut are unwrapped before lookup
  }
}
/** undefined = not in the allowlist (E2001). */
export const genMember = (t: { name: GenName; args: Type[] }, name: string): Member | undefined => pick(genMembers(t), name);
/** The effects of a method on a builtin generic receiver, seen through `Ref` / `Mut`. */
export function genFx(t: Type | undefined, name: string): Fx | undefined {
  const u = t && unref(t);
  const x = u?.k === "gen" ? genMember(u, name) : undefined;
  return x?.kind === "method" ? x.fx : undefined;
}

const MATH_ALL = ["abs", "sqrt", "floor", "ceil", "trunc", "round", "sign"];
const MATH_MANAGED = ["sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "log2", "log10", "cbrt"];
const each = (names: readonly string[], x: () => Member): Members => Object.fromEntries(names.map((n) => [n, x()]));

/** Members of namespace objects (Q032 - Q034, Q038). `min`/`max` are variadic and handled by the checker. */
export function nsMembers(ns: string): Record<string, Member | "variadic"> {
  const T = newTParam("T"), tT: Type = { k: "tparam", p: T };
  switch (ns) {
    case "Math": // `random` is absent: E5001, reported by the checker
      return {
        ...each(MATH_ALL, () => m(RD, [F64], F64)), ...each(MATH_MANAGED, () => mo(m(RD, [F64], F64))),
        ...each(["atan2", "pow", "hypot"], () => mo(m(RD, [F64, F64], F64))), fround: m(RD, [F64], num("f32")),
        min: "variadic", max: "variadic", PI: prop(F64), E: prop(F64),
      };
    case "Number": return {
      isFinite: m(RD, [F64], BOOL), isNaN: m(RD, [F64], BOOL), isInteger: m(RD, [F64], BOOL), parseFloat: mo(m(RD, [STR], F64)),
      MAX_SAFE_INTEGER: prop(F64), EPSILON: prop(F64), POSITIVE_INFINITY: prop(F64), NEGATIVE_INFINITY: prop(F64), NaN: prop(F64),
    };
    case "JSON": return {
      parse: mo(m(RD, [STR], result(UNKNOWN, ERROR_RECORD))), // Q035
      stringify: mo(m(RD, [tT], STR, { tparams: [T], tcheck: "codec" })),
    };
    case "String": return { fromCodePoint: mo(m(RD, [num("u32")], STR)) };
    case "Promise": return { all: mo(m(RD, [gen("Array", gen("Promise", tT))], gen("Promise", gen("Array", tT)), { tparams: [T] })) };
    case "DetMath": // §12 (Q191): rt functions, so callable from every layer; f64 only
      return { ...each(DETMATH_UNARY, () => m(RD, [F64], F64)), ...each(DETMATH_BINARY, () => m(RD, [F64, F64], F64)) };
    case "Vec": return { create: m(RD, [opaque("Alloc"), USIZE], gen("Vec", tT), { tparams: [T], tcheck: "copy" }) };
    case "Pool": return { create: m(RD, [opaque("Alloc"), USIZE], gen("Pool", tT), { tparams: [T], tcheck: "copy" }) };
    case "Arena": return { create: m(RD, [opaque("Alloc"), USIZE], gen("Arena")) };
    case "Ring": return { create: m(RD, [opaque("Alloc"), USIZE], record([{ name: "tx", type: gen("RingTx", tT), readonly: false }, { name: "rx", type: gen("RingRx", tT), readonly: false }], true), { tparams: [T], tcheck: "ring" }) }; // §15.1 (Q199)
    case "OwnedCell": return { create: m(RD, [tT], gen("OwnedCell", tT), { tparams: [T], tcheck: "owned" }) };
    case "Ptr": {
      const T2 = newTParam("T"), tT2: Type = { k: "tparam", p: T2 };
      const T3 = newTParam("T"), tT3: Type = { k: "tparam", p: T3 };
      return {
        box: m(WR, [opaque("Alloc"), tT], gen("Ptr", tT), { tparams: [T], tcheck: "box" }),
        null: m(RD, [], gen("Ptr", tT2), { tparams: [T2], tcheck: "ptrnull" }),
        sizeOf: m(RD, [], USIZE, { tparams: [T3], tcheck: "ptrsizeof" }),
      }; // §14.4, SPEC-v1 §9
    }
    case "CHandle": return { create: m(RD, [gen("Ptr", tT)], gen("CHandle", tT), { tparams: [T], tcheck: "chandle" }) }; // §14.5
    case "FakeClock": return { create: mo(m(RD, [F64], opaque("FakeClock"))) };
    case "SeededRandom": return { create: mo(m(RD, [num("u32")], opaque("SeededRandom"))) };
    case "MemoryLog": return { create: mo(m(RD, [], opaque("MemoryLog"))) };
    case "FakeFs": return { create: mo(m(RD, [], opaque("FakeFs"))) };
    case "FakeAudio": return { create: mo(m(RD, [], opaque("FakeAudio"))) };
    case "TestAlloc": return { create: mo(m(RD, [], opaque("Alloc"))) };
  }
  return {};
}
export const nsMember = (ns: string, name: string): Member | "variadic" | undefined => pick(nsMembers(ns), name);

/** Every builtin method with its owner (a generic or opaque type, `Ns.` for a namespace, `string`): the table test and the name sets below. */
export function builtinMethods(): { owner: string; name: string; fx: Fx }[] {
  const out: { owner: string; name: string; fx: Fx }[] = [];
  const add = (owner: string, ms: Record<string, Member | "variadic">): void => {
    for (const [name, x] of Object.entries(ms)) if (x !== "variadic" && x.kind === "method") out.push({ owner, name, fx: x.fx });
  };
  for (const g of Object.keys(GEN_ARITY) as GenName[]) add(g, genMembers({ name: g, args: [UNKNOWN, UNKNOWN] }));
  for (const o of OPAQUE_NAMES) add(o, opaqueMembers(o));
  for (const ns of NAMESPACES) add(`${ns}.`, nsMembers(ns));
  add("string", stringMembers());
  return out;
}
let banned: Set<string> | undefined;
/** Q232: the method names a contract cannot call over every builtin receiver; the fail-closed fallback when a receiver type is unknown (built on first use). */
export const contractBanned = (): Set<string> => (banned ??= new Set(builtinMethods().filter((x) => !x.fx.contract).map((x) => x.name)));
