// P2 type representation (D009). Plain objects compared structurally; class / interface by symbol identity.
import type { ts } from "./parse.ts";
import { layout } from "./layout.ts";

export type NumName = "f64" | "f32" | "i8" | "i16" | "i32" | "i64" | "u8" | "u16" | "u32" | "u64" | "usize";
export const NUM_NAMES: readonly NumName[] = ["f64", "f32", "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "usize"];
type PrimName = "boolean" | "string" | "null" | "void" | "unknown" | "never";
/** Builtin generic types (§3.2, §3.3). */
export type GenName = "Array" | "ReadonlyArray" | "Map" | "Set" | "Promise" | "Vec" | "Slice" | "Pool" | "Handle" | "Arena" | "ArenaBuf" | "RingTx" | "RingRx" | "Ref" | "Mut" | "OwnedCell" | "Ptr" | "ConstPtr" | "CType" | "CHandle" | "Port";
export const GEN_ARITY: Record<GenName, number> = {
  Array: 1, ReadonlyArray: 1, Map: 2, Set: 1, Promise: 1, Vec: 1, Slice: 1, Pool: 1, Handle: 1, Arena: 0, ArenaBuf: 1, RingTx: 1, RingRx: 1, Ref: 1, Mut: 1, OwnedCell: 1, Ptr: 1, ConstPtr: 1, CType: 1, CHandle: 1, Port: 2,
};
/** Opaque builtin types: authorities (§7.1), Test, JsRef, the fakes (Q038). */
export const AUTHORITIES = ["System", "Alloc", "Fs", "Clock", "Random", "Log", "Js", "Ffi", "Spawn", "Audio", "Display", "Net", "Proc"] as const; // Ffi: §14.2; Spawn: §15.2; Audio: §15.5; Display: Q279; Net/Proc: Q294-Q295
export const OPAQUE_NAMES = new Set<string>([...AUTHORITIES, "JsRef", "Test", "AudioStream", "DisplaySurface", "HttpServer", "RegExp", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs", "FakeSpawn", "FakeAudio", "FakeDisplay", "FakeNet", "FakeProc"]);

export interface Field { name: string; type: Type; readonly: boolean }
/** Q127: conditions a type parameter takes on from the positions it is used in, checked on every instantiation. */
/** `nopromise`: every user type parameter has it (Q130 addendum): a Promise cannot hide behind a type parameter. */
export type Capability = "Copy" | "Native" | "Owned" | "Send" | "Key" | "Codec";
/** `owner`: the declaring layer for user type parameters (Q068 b): "managed" ones take owned types only when explicitly bounded; strict / rt ones may. */
export interface TParam {
  name: string; id: number; constraint?: Type; caps?: Set<Capability>;
  owner?: "managed" | "strict" | "rt"; allowOwned?: boolean; inParam?: boolean; noPromise?: boolean;
}
/** `min`: builtin optional trailing parameters (Q032). `prefix`: a builtin callback may take a prefix of the parameters. */
export interface FnType {
  k: "fn"; tparams: TParam[]; params: Type[]; rest?: Type; ret: Type; min?: number; prefix?: boolean;
  /** Builtin call-site conditions: `cast` / `codec` / `owned` / `eq` / `copy` constrain the first type argument (Q084, Q086); `trap` checks the code literal (Q058). */
  /** `box` / `chandle` / `castptr`: the §14.4 / §14.5 conditions on the type argument. */
  tcheck?: "cast" | "codec" | "jsonstringify" | "owned" | "eq" | "copy" | "trap" | "box" | "chandle" | "castptr" | "ring" | "alloc" | "ptrnull" | "ptrsizeof";
}

export interface ClassSym {
  name: string;
  decl: ts.ClassDeclaration;
  tparams: TParam[];
  fields: Map<string, { type: Type; readonly: boolean; private: boolean; static: boolean; paramProp?: boolean; node: ts.PropertyDeclaration | ts.ParameterDeclaration }>;
  methods: Map<string, { sig: FnType; private: boolean; static: boolean; node: ts.MethodDeclaration }>;
  ctor: FnType;
  implements: Type[];
}
export interface IfaceSym { name: string; tparams: TParam[]; methods: Map<string, FnType> }

export type Type =
  | { k: "error" }
  | { k: "prim"; name: PrimName }
  | { k: "num"; name: NumName }
  | { k: "lit"; value: string }
  | { k: "record"; fields: Field[]; struct: boolean } // fields sorted by name
  | { k: "union"; members: Type[] }
  | FnType
  | { k: "class"; cls: ClassSym; args: Type[] }
  | { k: "iface"; iface: IfaceSym; args: Type[] }
  | { k: "tparam"; p: TParam }
  | { k: "gen"; name: GenName; args: Type[] }
  | { k: "opaque"; name: string }
  /** Namespace objects (Q034): only usable as the receiver of a member access. */
  | { k: "ns"; name: string }
  /** `keys()` / `values()` results: only usable as a for-of target (Q032). */
  | { k: "iter"; elem: Type }
  /** `Resource.own` / `Resource.ownWith` binding in a `using` declaration (SPEC-v1 §5). */
  | { k: "resource"; inner: Type }
  /** C ABI struct declared in `declare module "c:..."` (SPEC-v1 §9). */
  | { k: "cstruct"; name: string; spec: string; fields: Field[] }
  /** Immutable fixed-length tuple (managed-only). */
  | { k: "tuple"; elems: Type[] };

export const ERROR: Type = { k: "error" };
const prims = new Map<PrimName, Type>();
export const prim = (name: PrimName): Type => { let t = prims.get(name); if (!t) prims.set(name, t = { k: "prim", name }); return t; };
const nums = new Map<NumName, Type>();
export const num = (name: NumName): Type => { let t = nums.get(name); if (!t) nums.set(name, t = { k: "num", name }); return t; };
export const BOOL = prim("boolean"), STR = prim("string"), NULL = prim("null"), VOID = prim("void"), UNKNOWN = prim("unknown"), NEVER = prim("never");
export const F64 = num("f64"), USIZE = num("usize");
export const gen = (name: GenName, ...args: Type[]): Type => ({ k: "gen", name, args });
export const tuple = (elems: Type[]): Type => ({ k: "tuple", elems });
export const opaque = (name: string): Type => ({ k: "opaque", name });
export const fn = (params: Type[], ret: Type, tparams: TParam[] = [], rest?: Type): FnType => ({ k: "fn", tparams, params, ...(rest ? { rest } : {}), ret });
export const restElem = (t: Type): Type | undefined => (t.k === "gen" && (t.name === "Array" || t.name === "ReadonlyArray") && t.args.length === 1 ? t.args[0] : undefined);
export const record = (fields: Field[], struct = false): Type => ({ k: "record", fields: [...fields].sort((a, b) => (a.name < b.name ? -1 : 1)), struct });
export const ro = (name: string, type: Type): Field => ({ name, type, readonly: true });

let tpId = 0;
export const newTParam = (name: string, constraint?: Type): TParam => ({ name, id: ++tpId, ...(constraint ? { constraint } : {}) });

/** Flattened union; a single member collapses. Duplicates (by identity) are dropped. */
export function union(ts: Type[]): Type {
  const out: Type[] = [], lits = new Set<string>(); // string literals dedup by hash: the tags of a big tagged union are read on every `x.kind`
  for (const t of ts.flatMap((x) => (x.k === "union" ? x.members : [x]))) {
    if (t.k === "lit") { if (!lits.has(t.value)) { lits.add(t.value); out.push(t); } } else if (!out.some((o) => same(o, t))) out.push(t);
  }
  return out.length === 1 ? out[0]! : { k: "union", members: out };
}
/** A sub-list of a union's own members: already flat and duplicate-free, so `union()`'s quadratic dedup is skipped (narrowing a big tagged union). */
export const subUnion = (ms: Type[]): Type => (ms.length === 1 ? ms[0]! : { k: "union", members: ms });
export const nullable =(t: Type): Type => union([t, NULL]);
/** `T | null` -> T; otherwise undefined. */
export function nonNull(t: Type): Type | undefined {
  if (t.k !== "union" || !t.members.some(isNull)) return undefined;
  return union(t.members.filter((m) => !isNull(m)));
}
export const isNull = (t: Type): boolean => t.k === "prim" && t.name === "null";
export const isVoid = (t: Type): boolean => t.k === "prim" && t.name === "void";
export const isNum = (t: Type): t is { k: "num"; name: NumName } => t.k === "num";
export const isInt = (t: Type): boolean => t.k === "num" && t.name !== "f64" && t.name !== "f32";
export const isBool = (t: Type): boolean => t.k === "prim" && t.name === "boolean";
export const isStr = (t: Type): boolean => (t.k === "prim" && t.name === "string") || t.k === "lit" || (t.k === "union" && t.members.every((m) => m.k === "lit"));
export const isErr = (t: Type): boolean => t.k === "error";
/** Ref<X> / Mut<X> read as X in P2 (Q020 addendum, Q064). */
export const unref = (t: Type): Type => (t.k === "gen" && (t.name === "Ref" || t.name === "Mut") ? t.args[0]! : t);

export function field(t: Type, name: string): Field | undefined {
  return t.k === "record" || t.k === "cstruct" ? t.fields.find((f) => f.name === name) : undefined;
}
/** The `kind` literal of a tagged-union member. */
export function kindOf(t: Type): string | undefined {
  const f = field(t, "kind");
  return f?.type.k === "lit" ? f.type.value : undefined;
}
export const isTaggedUnion = (t: Type): t is { k: "union"; members: Type[] } => t.k === "union" && t.members.length > 1 && t.members.every((m) => kindOf(m) !== undefined);
/** A narrowed `Result<T, E>` branch (`{ readonly kind: "ok"; readonly value: T }` or `{ readonly kind: "err"; readonly error: E }`). */
export function isResultBranch(t: Type): boolean {
  return t.k === "record" && !t.struct && t.fields.length === 2 && t.fields.every((f) => f.readonly) &&
    ((kindOf(t) === "ok" && !!field(t, "value")) || (kindOf(t) === "err" && !!field(t, "error")));
}
/** Result<T, E> (§8) -> its T and E. */
export function resultParts(t: Type): { ok: Type; err: Type } | undefined {
  if (t.k !== "union" || t.members.length !== 2) return;
  const ok = t.members.find((m) => isResultBranch(m) && kindOf(m) === "ok");
  const er = t.members.find((m) => isResultBranch(m) && kindOf(m) === "err");
  return ok && er ? { ok: field(ok, "value")!.type, err: field(er, "error")!.type } : undefined;
}
export const result = (ok: Type, err: Type): Type => union([
  record([ro("kind", { k: "lit", value: "ok" }), ro("value", ok)]),
  record([ro("kind", { k: "lit", value: "err" }), ro("error", err)]),
]);
export const ERROR_RECORD = record([ro("code", STR), ro("message", STR)]); // IoError, CastError, JsError (§7.1, Q036)
export const AUDIO_CONFIG_RECORD = record([ro("sampleRate", num("u32")), ro("channels", num("u32"))]); // AudioConfig (§15.5, Q283)
export const DISPLAY_CONFIG_RECORD = record([ro("title", STR), ro("width", num("u32")), ro("height", num("u32"))]); // DisplayConfig (Q279)
export const DISPLAY_COLOR_RECORD = record([ro("r", num("u8")), ro("g", num("u8")), ro("b", num("u8")), ro("a", num("u8"))]); // DisplayColor (Q279)
export const DISPLAY_EVENT_UNION = union([
  record([ro("kind", { k: "lit", value: "pointerDown" }), ro("x", F64), ro("y", F64), ro("button", num("u8"))]),
  record([ro("kind", { k: "lit", value: "pointerMove" }), ro("x", F64), ro("y", F64), ro("buttons", num("u8"))]),
  record([ro("kind", { k: "lit", value: "pointerUp" }), ro("x", F64), ro("y", F64), ro("button", num("u8"))]),
  record([ro("kind", { k: "lit", value: "wheel" }), ro("x", F64), ro("y", F64), ro("dx", F64), ro("dy", F64)]),
  record([ro("kind", { k: "lit", value: "keyDown" }), ro("key", STR), ro("repeat", BOOL), ro("shift", BOOL), ro("ctrl", BOOL), ro("alt", BOOL)]),
  record([ro("kind", { k: "lit", value: "keyUp" }), ro("key", STR), ro("shift", BOOL), ro("ctrl", BOOL), ro("alt", BOOL)]),
  record([ro("kind", { k: "lit", value: "close" })]),
]);
export const FS_KIND_UNION = union([{ k: "lit", value: "file" }, { k: "lit", value: "dir" }, { k: "lit", value: "symlink" }, { k: "lit", value: "other" }]);
export const DIR_ENTRY_RECORD = record([ro("name", STR), ro("kind", FS_KIND_UNION)]);
export const FILE_STAT_RECORD = record([ro("kind", FS_KIND_UNION), ro("size", num("u64")), ro("mtimeMs", F64)]);
export const ENV_VAR_RECORD = record([ro("name", STR), ro("value", STR)]);
export const PROC_OPTIONS_RECORD = record([ro("cwd", nullable(STR)), ro("env", gen("ReadonlyArray", ENV_VAR_RECORD)), ro("stdin", nullable(STR)), ro("timeoutMs", nullable(num("u32")))]);
export const PROC_OUTPUT_RECORD = record([ro("exitCode", num("i32")), ro("stdout", STR), ro("stderr", STR), ro("timedOut", BOOL)]);
export const PROC_REQUEST_RECORD = record([ro("program", STR), ro("args", gen("Array", STR)), ro("cwd", nullable(STR)), ro("env", gen("Array", ENV_VAR_RECORD)), ro("stdin", nullable(STR)), ro("timeoutMs", nullable(num("u32")))]);
export const HTTP_HEADER_RECORD = record([ro("name", STR), ro("value", STR)]);
export const HTTP_REQUEST_INIT_RECORD = record([ro("method", STR), ro("headers", gen("ReadonlyArray", HTTP_HEADER_RECORD)), ro("body", nullable(STR)), ro("timeoutMs", nullable(num("u32")))]);
export const HTTP_RESPONSE_RECORD = record([ro("status", num("u16")), ro("headers", gen("Array", HTTP_HEADER_RECORD)), ro("body", STR)]);
export const HTTP_SERVER_CONFIG_RECORD = record([ro("host", STR), ro("port", num("u16"))]);
export const HTTP_SERVER_REQUEST_RECORD = record([ro("method", STR), ro("path", STR), ro("query", STR), ro("headers", gen("Array", HTTP_HEADER_RECORD)), ro("body", STR)]);
export const HTTP_SERVER_RESPONSE_RECORD = record([ro("status", num("u16")), ro("headers", gen("ReadonlyArray", HTTP_HEADER_RECORD)), ro("body", STR)]);
export const HTTP_BODY_UNION = union([
  record([ro("kind", { k: "lit", value: "text" }), ro("value", STR)]),
  record([ro("kind", { k: "lit", value: "bytes" }), ro("value", gen("ReadonlyArray", num("u8")))]),
]);
export const HTTP_SERVER_RAW_RESPONSE_RECORD = record([
  ro("status", num("u16")),
  ro("headers", gen("ReadonlyArray", HTTP_HEADER_RECORD)),
  ro("body", HTTP_BODY_UNION),
]);
export const HTTP_CLIENT_REQUEST_RECORD = record([ro("method", STR), ro("url", STR), ro("headers", gen("Array", HTTP_HEADER_RECORD)), ro("body", nullable(STR))]);
export const QUERY_PARAM_RECORD = record([ro("name", STR), ro("value", STR)]);
export const REGEXP_MATCH_RECORD = record([ro("text", STR), ro("index", USIZE), ro("groups", gen("Array", nullable(STR)))]);
export const DISPOSABLE_IFACE: IfaceSym = { name: "Disposable", tparams: [], methods: new Map([["dispose", fn([], VOID)]]) };
export const ASYNC_DISPOSABLE_IFACE: IfaceSym = { name: "AsyncDisposable", tparams: [], methods: new Map([["disposeAsync", fn([], gen("Promise", VOID))]]) };
export const DISPOSABLE: Type = { k: "iface", iface: DISPOSABLE_IFACE, args: [] };
export const ASYNC_DISPOSABLE: Type = { k: "iface", iface: ASYNC_DISPOSABLE_IFACE, args: [] };

export function same(a: Type, b: Type): boolean {
  if (a === b) return true;
  switch (a.k) {
    case "error": return b.k === "error";
    case "prim": return b.k === "prim" && a.name === b.name;
    case "num": return b.k === "num" && a.name === b.name;
    case "lit": return b.k === "lit" && a.value === b.value;
    case "record":
      return b.k === "record" && a.struct === b.struct && sameFields(a.fields, b.fields);
    case "union": return b.k === "union" && a.members.length === b.members.length && a.members.every((m) => b.members.some((n) => same(m, n)));
    case "fn": return b.k === "fn" && a.params.length === b.params.length && a.params.every((p, i) => same(p, b.params[i]!)) && Boolean(a.rest) === Boolean(b.rest) && (!a.rest || same(a.rest, b.rest!)) && same(a.ret, b.ret);
    case "class": return b.k === "class" && a.cls === b.cls && sameArgs(a.args, b.args);
    case "iface": return b.k === "iface" && a.iface === b.iface && sameArgs(a.args, b.args);
    case "tparam": return b.k === "tparam" && a.p.id === b.p.id;
    case "gen": return b.k === "gen" && a.name === b.name && sameArgs(a.args, b.args);
    case "opaque": case "ns": return b.k === a.k && a.name === b.name;
    case "iter": return b.k === "iter" && same(a.elem, b.elem);
    case "resource": return b.k === "resource" && same(a.inner, b.inner);
    case "cstruct": return b.k === "cstruct" && a.name === b.name && a.spec === b.spec && sameFields(a.fields, b.fields);
    case "tuple": return b.k === "tuple" && sameArgs(a.elems, b.elems);
  }
}
function sameArgs(a: Type[], b: Type[]): boolean { return a.length === b.length && a.every((x, i) => same(x, b[i]!)); }
function sameFields(a: Field[], b: Field[]): boolean {
  return a.length === b.length && a.every((f, i) => { const g = b[i]!; return f.name === g.name && f.readonly === g.readonly && same(f.type, g.type); });
}

/** Fakes assignable to their authority (Q020-10, Q038). */
const FAKE_OF: Record<string, string> = { FakeClock: "Clock", SeededRandom: "Random", MemoryLog: "Log", FakeFs: "Fs", FakeSpawn: "Spawn", FakeAudio: "Audio", FakeDisplay: "Display", FakeNet: "Net", FakeProc: "Proc" };

/** Q020. `arg` enables the argument-position conversions (Vec -> Slice). */
export function assignable(s: Type, t: Type, arg = false): boolean {
  if (s.k === "error" || t.k === "error" || same(s, t)) return true;
  if (s.k === "prim" && s.name === "never") return true;
  if (s.k === "union") return s.members.every((m) => assignable(m, t, arg));
  if (t.k === "union") return t.members.some((m) => assignable(s, m, arg));
  if (s.k === "lit" && t.k === "prim" && t.name === "string") return true;
  if (s.k === "gen" && t.k === "gen") {
    if (t.name === "ReadonlyArray" && (s.name === "Array" || s.name === "ReadonlyArray")) return assignable(s.args[0]!, t.args[0]!);
    if (s.name === "Ptr" && t.name === "ConstPtr") return same(s.args[0]!, t.args[0]!); // §14.4: Ptr reads as ConstPtr, never back
    if (arg && t.name === "Slice" && s.name === "Vec") return same(s.args[0]!, t.args[0]!);
    return false;
  }
  if (s.k === "tuple" && t.k === "tuple") return s.elems.length === t.elems.length && s.elems.every((e, i) => assignable(e, t.elems[i]!));
  if (s.k === "tuple" && t.k === "gen" && t.name === "ReadonlyArray") return s.elems.every((e) => assignable(e, t.args[0]!));
  if (s.k === "fn" && t.k === "fn") {
    if (!t.rest && (s.rest !== undefined || s.params.length > t.params.length)) return false;
    const sMin = s.min ?? s.params.length;
    if (sMin > t.params.length) return false;
    if (t.rest) {
      const tRestEl = restElem(t.rest), sRestEl = s.rest ? restElem(s.rest) : undefined;
      if (!tRestEl || !sRestEl || !assignable(tRestEl, sRestEl)) return false;
      const n = Math.max(s.params.length, t.params.length);
      for (let i = 0; i < n; i++) {
        const tp = i < t.params.length ? t.params[i]! : tRestEl;
        const sp = i < s.params.length ? s.params[i]! : sRestEl;
        if (!assignable(tp, sp)) return false;
      }
    } else {
      if (!t.prefix && s.params.length < t.params.length) return false;
      for (let i = 0; i < s.params.length; i++) {
        if (!assignable(t.params[i]!, s.params[i]!)) return false;
      }
    }
    // a builtin void callback drops the result; a dropped Promise would lose its trap (Q125)
    return assignable(s.ret, t.ret) || (t.ret.k === "prim" && t.ret.name === "void" && !!t.prefix && !(s.ret.k === "gen" && s.ret.name === "Promise"));
  }
  if (s.k === "class" && t.k === "iface") return s.cls.implements.some((i) => same(substClass(i, s), t));
  if (s.k === "opaque" && (s.name === "AudioStream" || s.name === "DisplaySurface" || s.name === "HttpServer") && t.k === "iface" && t.iface === ASYNC_DISPOSABLE_IFACE) return true;
  if (s.k === "tparam" && s.p.constraint) return assignable(s.p.constraint, t, arg);
  if (s.k === "opaque" && t.k === "opaque") return FAKE_OF[s.name] === t.name;
  return false;
}
/** True iff `s` fails assignment to non-rest `t` solely because `s` has a rest param or more params than `t`. */
export function fnExtraParamsOnly(s: FnType, t: FnType): boolean {
  if (t.rest || (s.rest === undefined && s.params.length <= t.params.length)) return false;
  const sMin = s.min ?? s.params.length;
  if (sMin > t.params.length) return false;
  const sRestEl = s.rest ? restElem(s.rest) : undefined;
  for (let i = 0; i < t.params.length; i++) {
    const sp = i < s.params.length ? s.params[i]! : sRestEl;
    if (!sp || !assignable(t.params[i]!, sp)) return false;
  }
  return assignable(s.ret, t.ret) || (t.ret.k === "prim" && t.ret.name === "void" && !!t.prefix && !(s.ret.k === "gen" && s.ret.name === "Promise"));
}
/** An `implements` clause type, with the class's own type parameters replaced by the instance's arguments. */
const substClass = (t: Type, inst: { cls: ClassSym; args: Type[] }): Type => subst(t, bindTParams(inst.cls.tparams, inst.args));

export const bindTParams = (ps: TParam[], args: Type[]): Map<number, Type> => new Map(ps.map((p, i) => [p.id, args[i] ?? ERROR]));

export function subst(t: Type, m: Map<number, Type>): Type {
  if (!m.size) return t;
  switch (t.k) {
    case "tparam": return m.get(t.p.id) ?? t;
    case "record": return { ...t, fields: t.fields.map((f) => ({ ...f, type: subst(f.type, m) })) };
    case "union": return union(t.members.map((x) => subst(x, m)));
    case "fn": return { ...t, params: t.params.map((x) => subst(x, m)), ...(t.rest ? { rest: subst(t.rest, m) } : {}), ret: subst(t.ret, m) };
    case "class": case "iface": case "gen": return { ...t, args: t.args.map((x) => subst(x, m)) } as Type;
    case "iter": return { k: "iter", elem: subst(t.elem, m) };
    case "resource": return { k: "resource", inner: subst(t.inner, m) };
    case "tuple": return tuple(t.elems.map((x) => subst(x, m)));
    default: return t;
  }
}

export function hasTParam(t: Type, ids: Set<number>): boolean {
  switch (t.k) {
    case "tparam": return ids.has(t.p.id);
    case "record": return t.fields.some((f) => hasTParam(f.type, ids));
    case "union": return t.members.some((x) => hasTParam(x, ids));
    case "fn": return t.params.some((x) => hasTParam(x, ids)) || (t.rest ? hasTParam(t.rest, ids) : false) || hasTParam(t.ret, ids);
    case "class": case "iface": case "gen": return t.args.some((x) => hasTParam(x, ids));
    case "iter": return hasTParam(t.elem, ids);
    case "resource": return hasTParam(t.inner, ids);
    case "tuple": return t.elems.some((x) => hasTParam(x, ids));
    default: return false;
  }
}

/** Binds type parameters in `p` from the argument type `a` (first binding wins). */
export function unify(p: Type, a: Type, m: Map<number, Type>, ids: Set<number>): void {
  if (a.k === "error") return;
  switch (p.k) {
    case "tparam":
      if (ids.has(p.p.id) && !m.has(p.p.id) && !(a.k === "prim" && a.name === "never")) m.set(p.p.id, a);
      return;
    case "union": {
      const inner = nonNull(p);
      if (inner) { if (!isNull(a)) unify(inner, nonNull(a) ?? a, m, ids); return; } // T | null: bare null carries no T binding
      const as = a.k === "union" ? a.members : [a]; // tagged unions (Result): match members by kind
      for (const pm of p.members) {
        const k = kindOf(pm);
        const am = k === undefined ? undefined : as.find((x) => kindOf(x) === k);
        if (am) unify(pm, am, m, ids);
      }
      return;
    }
    case "gen":
      if (a.k === "gen" && (a.name === p.name || (p.name === "ReadonlyArray" && a.name === "Array") || (p.name === "Slice" && a.name === "Vec") || (p.name === "Ptr" && a.name === "ConstPtr") || (p.name === "ConstPtr" && a.name === "Ptr"))) p.args.forEach((x, i) => unify(x, a.args[i]!, m, ids));
      else if (p.name === "ReadonlyArray" && a.k === "tuple" && a.elems.length > 0) unify(p.args[0]!, union(a.elems), m, ids);
      return;
    case "tuple":
      if (a.k === "tuple" && a.elems.length === p.elems.length) p.elems.forEach((x, i) => unify(x, a.elems[i]!, m, ids));
      return;
    case "fn":
      if (a.k === "fn") {
        p.params.forEach((x, i) => {
          const ap = i < a.params.length ? a.params[i] : (a.rest ? restElem(a.rest) : undefined);
          if (ap) unify(x, ap, m, ids);
        });
        if (p.rest) {
          if (a.rest) unify(p.rest, a.rest, m, ids);
          else {
            const pEl = restElem(p.rest);
            if (pEl) for (let i = p.params.length; i < a.params.length; i++) unify(pEl, a.params[i]!, m, ids);
          }
        }
        unify(p.ret, a.ret, m, ids);
      }
      return;
    case "record":
      if (a.k === "record") for (const f of p.fields) { const g = field(a, f.name); if (g) unify(f.type, g.type, m, ids); }
      return;
    case "class": case "iface":
      if (a.k === p.k && (a as { args: Type[] }).args.length === p.args.length) p.args.forEach((x, i) => unify(x, (a as { args: Type[] }).args[i]!, m, ids));
      else if (p.k === "iface" && a.k === "class") for (const i of a.cls.implements) { const it = substClass(i, a); if (it.k === "iface" && it.iface === p.iface) unify(p, it, m, ids); }
      return;
    case "resource":
      if (a.k === "resource") unify(p.inner, a.inner, m, ids);
      return;
    default:
  }
}

/** Whether a type parameter satisfies `cap` from explicit bounds or layer context (SPEC-v1 §3.4). */
export function tparamHasCap(p: TParam, cap: Capability): boolean {
  if (p.caps?.has(cap)) return true;
  if ((cap === "Copy" || cap === "Send" || cap === "Codec") && p.caps?.has("Key")) return true;
  if (cap === "Native" && (p.caps?.has("Owned") || p.owner === "strict" || p.owner === "rt")) return true;
  return false;
}
/** Whether a type parameter may hold an owned value inside its declaring body. */
export function tparamMayBeOwned(p: TParam): boolean {
  if (p.constraint || tparamHasCap(p, "Copy") || tparamHasCap(p, "Key")) return false;
  return p.owner === "strict" || p.owner === "rt" || tparamHasCap(p, "Owned") || (!!p.allowOwned && tparamHasCap(p, "Native"));
}
/** Whether a managed type parameter could possibly be instantiated with an authority (Alloc, etc.). */
export function tparamMayBeAuthority(p: TParam): boolean {
  return p.owner !== "strict" && p.owner !== "rt" && !p.constraint && !p.caps?.has("Native") &&
    !tparamHasCap(p, "Copy") && !tparamHasCap(p, "Owned") && !tparamHasCap(p, "Send") && !tparamHasCap(p, "Key") && !tparamHasCap(p, "Codec");
}

/** Copy types (SPEC-v1 §3.3 / §3.4): numbers, boolean, null, string, unions of Copy types, all-readonly records of Copy types (never OwnedStruct). */
export function isCopy(t: Type): boolean {
  switch (t.k) {
    case "num": case "lit": return true;
    case "gen": return t.name === "Handle" || t.name === "ArenaBuf" || t.name === "Ptr" || t.name === "ConstPtr"; // Q188: a handle is three u32s, an ArenaBuf four; §14.4: raw pointers are Copy
    case "prim": return t.name === "boolean" || t.name === "null" || t.name === "string";
    case "record": return !t.struct && t.fields.every((f) => f.readonly && isCopy(f.type));
    case "tuple": return t.elems.every(isCopy);
    case "union": return t.members.every(isCopy);
    case "tparam": return tparamHasCap(t.p, "Copy");
    default: return false;
  }
}
/** Owned types (§5.1): OwnedStruct and native owned containers. */
export const isOwned = (t: Type): boolean => (t.k === "gen" && (t.name === "Vec" || t.name === "Pool" || t.name === "Arena" || t.name === "CHandle" || t.name === "RingTx" || t.name === "RingRx")) || (t.k === "record" && t.struct); // CHandle: §14.5
/** Types satisfying explicit `Owned` capability (always move-only). */
export function isOwnedCap(t: Type): boolean {
  if (t.k === "error") return true;
  if (t.k === "tparam") return tparamHasCap(t.p, "Owned");
  if (t.k === "gen") return t.name === "Vec" || t.name === "Pool" || t.name === "Arena" || t.name === "CHandle" || t.name === "RingTx" || t.name === "RingRx";
  if (t.k === "record" && t.struct) return true;
  return false;
}
/** True when a record has all-readonly Native & Copy fields (not OwnedStruct). */
export const isCopyValueRecord = (t: Extract<Type, { k: "record" }>): boolean =>
  !t.struct && t.fields.every((f) => f.readonly && isCopy(f.type) && layerOk(f.type));

/** Q174: an owned value (directly, in a union, or in a record / Struct field). */
export const holdsOwned = (t: Type): boolean =>
  movesLike(t) || (t.k === "record" && t.fields.some((f) => holdsOwned(f.type))) || (t.k === "union" && t.members.some(holdsOwned)) || (t.k === "tuple" && t.elems.some(holdsOwned));
/** Q174 (案2): an Array / ReadonlyArray / Map / Set / Promise / tuple whose type arguments are, or hold, owned types (E3007). */
export const CONTAINERS = new Set(["Array", "ReadonlyArray", "Map", "Set", "Promise"]);
export const ownedInside = (t: Type | undefined): boolean =>
  !!t && (t.k === "union" ? t.members.some(ownedInside) : t.k === "tuple" ? t.elems.some((a) => holdsOwned(a) || ownedInside(a)) : t.k === "gen" && CONTAINERS.has(t.name) && t.args.some((a) => holdsOwned(a) || ownedInside(a)));

/** Q174: a container holding owned values anywhere inside `t`, through record / union / generic / function types and class / interface members. */
export function ownedDeep(t: Type, seen = new Set<object>()): boolean {
  switch (t.k) {
    case "record": return t.fields.some((f) => ownedDeep(f.type, seen));
    case "union": return t.members.some((m) => ownedDeep(m, seen));
    case "tuple": return ownedInside(t) || t.elems.some((a) => ownedDeep(a, seen));
    case "gen": return ownedInside(t) || t.args.some((a) => ownedDeep(a, seen));
    case "fn": return t.params.some((p) => ownedDeep(p, seen)) || (t.rest ? ownedDeep(t.rest, seen) : false) || ownedDeep(t.ret, seen);
    case "class": case "iface": {
      const sym = t.k === "class" ? t.cls : t.iface;
      if (seen.has(sym)) return false;
      seen.add(sym);
      const m = bindTParams(sym.tparams, t.args);
      const members: Type[] = t.k === "class" ? [...t.cls.fields.values()].map((f) => f.type) : [...t.iface.methods.values()];
      const r = t.args.some((a) => ownedDeep(a, seen)) || members.some((x) => ownedDeep(subst(x, m), seen));
      seen.delete(sym); // only the current path is guarded (a self-referencing class)
      return r;
    }
    case "resource": return ownedDeep(t.inner, seen);
    default: return false;
  }
}

export function movesLike(t: Type): boolean {
  if (t.k === "tparam") return tparamMayBeOwned(t.p);
  if (t.k === "resource") return true;
  if (isResultBranch(t)) return movesLike(field(t, kindOf(t) === "ok" ? "value" : "error")!.type);
  return isOwned(t) || (t.k === "union" && t.members.some(movesLike));
}

export const isAuthority = (t: Type): boolean => t.k === "opaque" && (AUTHORITIES as readonly string[]).includes(t.name);
/** An authority anywhere in `t` (E4006 in rt, §6). */
export const hasAuthority = (t: Type): boolean =>
  isAuthority(t) || (t.k === "record" && t.fields.some((f) => hasAuthority(f.type))) || (t.k === "union" && t.members.some(hasAuthority)) || (t.k === "gen" && t.args.some(hasAuthority)) || (t.k === "tuple" && t.elems.some(hasAuthority)) || (t.k === "resource" && hasAuthority(t.inner));
/** Native data capability (SPEC-v1 §3.4): strict / rt data types excluding authorities, `void`, and `never` (unless return-only). */
export function isNative(t: Type, allowNever = false): boolean {
  switch (t.k) {
    case "error": case "num": case "lit": return true;
    case "tparam": return tparamHasCap(t.p, "Native");
    case "prim": return t.name === "boolean" || t.name === "null" || (allowNever && t.name === "never");
    case "record": return (t.struct || isResultBranch(t)) ? t.fields.every((f) => isNative(f.type)) : isCopyValueRecord(t);
    case "union": return resultParts(t) ? t.members.every((m) => isNative(m)) : t.members.every((m) => isCopy(m) && isNative(m));
    case "gen": return (!ELEMENT_CONTAINERS.has(t.name) || hasLayout(t.args[0]!)) && (
      t.name === "Vec" || t.name === "Slice" || t.name === "Pool" || t.name === "Handle" || t.name === "Arena" ||
      t.name === "ArenaBuf" || t.name === "RingTx" || t.name === "RingRx" || t.name === "Ptr" || t.name === "ConstPtr" ||
      t.name === "CType" || t.name === "CHandle" || ((t.name === "Ref" || t.name === "Mut") && isNative(t.args[0]!))
    );
    default: return false;
  }
}
/** §3.3 (Q040 - Q043): the types strict / rt code may use. Authorities are strict-only (rt: E4006). */
export function layerOk(t: Type): boolean {
  switch (t.k) {
    case "error": case "num": case "lit": return true;
    case "tparam": return tparamHasCap(t.p, "Native");
    case "prim": return t.name === "boolean" || t.name === "null" || t.name === "void" || t.name === "never";
    case "record": return (t.struct || isResultBranch(t)) ? t.fields.every((f) => layerOk(f.type)) : isCopy(t) && t.fields.every((f) => layerOk(f.type)); // Q043
    case "union": return resultParts(t) ? t.members.every((m) => layerOk(m)) : t.members.every((m) => isCopy(m) && layerOk(m));
    case "gen": return (!ELEMENT_CONTAINERS.has(t.name) || hasLayout(t.args[0]!)) && (t.name === "Vec" || t.name === "Slice" || t.name === "Pool" || t.name === "Handle" || t.name === "Arena" || t.name === "ArenaBuf" || t.name === "RingTx" || t.name === "RingRx" || t.name === "Ptr" || t.name === "ConstPtr" || t.name === "CType" || t.name === "CHandle" || ((t.name === "Ref" || t.name === "Mut") && layerOk(t.args[0]!))); // Q229, §14: pointer types are layer-legal; their positions are E4007 / E4008
    case "opaque": return isAuthority(t);
    case "resource": return layerOk(t.inner);
    case "cstruct": return true;
    default: return false;
  }
}

export function show(t: Type): string {
  switch (t.k) {
    case "error": return "<error>";
    case "prim": case "num": case "opaque": case "ns": return t.name;
    case "lit": return JSON.stringify(t.value);
    case "record": return `${t.struct ? "OwnedStruct<" : ""}{ ${t.fields.map((f) => `${f.readonly ? "readonly " : ""}${f.name}: ${show(f.type)}`).join("; ")} }${t.struct ? ">" : ""}`;
    case "union": return t.members.map(show).join(" | ");
    case "fn": return `(${[...t.params.map(show), ...(t.rest ? [`...${show(t.rest)}`] : [])].join(", ")}) => ${show(t.ret)}`;
    case "class": return t.cls.name + (t.args.length ? `<${t.args.map(show).join(", ")}>` : "");
    case "iface": return t.iface.name + (t.args.length ? `<${t.args.map(show).join(", ")}>` : "");
    case "tparam": return t.p.name;
    case "gen": return `${t.name}<${t.args.map(show).join(", ")}>`;
    case "iter": return `Iterator<${show(t.elem)}>`;
    case "resource": return `Resource<${show(t.inner)}>`;
    case "cstruct": return t.name;
    case "tuple": return `[${t.elems.map(show).join(", ")}]`;
  }
}

/** `Map` key / `Set` element types (§3.2, SPEC-v1 §3.4 Key). */
export function keyOk(t: Type): boolean {
  if (t.k === "error") return true;
  if (t.k === "tparam") return tparamHasCap(t.p, "Key");
  return t.k === "num" || t.k === "lit" || (t.k === "prim" && (t.name === "string" || t.name === "boolean")) ||
    (t.k === "union" && t.members.every((m) => m.k === "lit"));
}

/** Types `cast<T>`, `Js.decode<T>`, `Js.encode<T>`, and `JSON.stringify<T>` accept (SPEC-v1 §3.4 Codec). */
export function castable(t: Type): boolean {
  switch (t.k) {
    case "error": case "num": case "lit": return true;
    case "tparam": return tparamHasCap(t.p, "Codec");
    case "prim": return t.name === "boolean" || t.name === "string" || t.name === "null";
    case "record": return !t.struct && t.fields.every((f) => castable(f.type));
    case "union": return t.members.every(castable);
    case "tuple": return t.elems.every(castable);
    case "gen": return (t.name === "Array" || t.name === "ReadonlyArray") && castable(t.args[0]!);
    default: return false;
  }
}

/** `Test.eq` operands (§9.2, Q086): no owned values, function values or authorities anywhere inside. */
export function comparable(t: Type): boolean {
  switch (t.k) {
    case "error": return true;
    case "tparam": return tparamHasCap(t.p, "Copy") || tparamHasCap(t.p, "Codec");
    case "fn": case "opaque": case "ns": case "iter": case "cstruct": return false;
    case "record": return !isOwned(t) && t.fields.every((f) => comparable(f.type));
    case "union": return t.members.every(comparable);
    case "tuple": return t.elems.every(comparable);
    case "gen": return t.name !== "Vec" && t.name !== "Slice" && t.name !== "Pool" && t.name !== "Arena" && t.name !== "OwnedCell" && t.name !== "Promise" && t.name !== "RingTx" && t.name !== "RingRx" && t.name !== "Port" && t.name !== "CHandle" && t.name !== "Ptr" && t.name !== "ConstPtr" && t.name !== "CType" && t.args.every(comparable);
    default: return true;
  }
}

/** Struct field types (SPEC-v1 §3.3: Native non-authority values). */
export function structField(t: Type): boolean {
  switch (t.k) {
    case "error": case "num": case "lit": return true;
    case "tparam": return tparamHasCap(t.p, "Native");
    case "prim": return t.name === "boolean" || t.name === "null";
    case "record": return t.struct ? t.fields.every((f) => structField(f.type)) : isCopyValueRecord(t);
    case "union": return t.members.every((m) => isCopy(m) && structField(m));
    case "gen":
      return t.name === "Vec" || t.name === "Pool" || t.name === "Handle" || t.name === "Arena" || t.name === "ArenaBuf" ||
        t.name === "RingTx" || t.name === "RingRx" || t.name === "CHandle" || t.name === "Ptr" || t.name === "ConstPtr" || t.name === "CType";
    default: return false;
  }
}

/** Whether `t` satisfies capability `cap` (SPEC-v1 §3.4). */
export function hasCap(t: Type, cap: Capability, allowNever = false): boolean {
  if (t.k === "error") return true;
  switch (cap) {
    case "Copy": return isCopy(t);
    case "Native": return isNative(t, allowNever);
    case "Owned": return isOwnedCap(t);
    case "Send": return sendable(t);
    case "Key": return keyOk(t);
    case "Codec": return castable(t);
  }
}

/** Whether `Ref<t>` / `Mut<t>` is allowed (§5.5 / §3.4). */
export const borrowOk = (t: Type): boolean =>
  t.k === "error" || isOwnedCap(t) || (t.k === "gen" && t.name === "Slice") || (t.k === "tparam" && tparamHasCap(t.p, "Owned"));

export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;
export const U64_MAX = (1n << 64n) - 1n;
export const isInt64 = (n: NumName): n is "i64" | "u64" => n === "i64" || n === "u64";

/** True when `t` statically contains `i64` or `u64` (cannot be serialized by `JSON.stringify`). */
export function hasInt64(t: Type): boolean {
  switch (t.k) {
    case "num": return isInt64(t.name);
    case "record": return t.fields.some((f) => hasInt64(f.type));
    case "union": return t.members.some(hasInt64);
    case "gen": return t.args.some(hasInt64);
    case "tuple": return t.elems.some(hasInt64);
    case "resource": return hasInt64(t.inner);
    default: return false;
  }
}

/** Parses a TS numeric literal exactly as a bigint integer when exact, else null. `-0` normalizes to `0n`. */
export function parseExactInt(text: string, neg = false): bigint | null {
  const s = text.replace(/_/g, "");
  if (/^0[xXbBoO]/.test(s)) {
    try {
      const v = BigInt(s);
      return neg && v !== 0n ? -v : v;
    } catch { return null; }
  }
  const m = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  const intPart = m[1] ?? "", fracPart = m[2] ?? m[3] ?? "", exp = m[4] ? Number(m[4]) : 0;
  if (!Number.isSafeInteger(exp)) return null;
  const all = intPart + fracPart;
  const nz = all.replace(/^0+/, "");
  if (!nz) return 0n;
  const k = exp - fracPart.length;
  let digits: string;
  if (k < 0) {
    const shift = -k;
    if (shift >= all.length) return null;
    const cut = all.length - shift;
    if (/[^0]/.test(all.slice(cut))) return null;
    digits = all.slice(0, cut).replace(/^0+/, "");
  } else {
    if (nz.length + k > 21) return null;
    digits = nz + "0".repeat(k);
  }
  const v = digits ? BigInt(digits) : 0n;
  return neg && v !== 0n ? -v : v;
}

/** Integer ranges (§3.1). */
export const INT_RANGE: Partial<Record<NumName, readonly [bigint, bigint]>> = {
  i8: [-128n, 127n], i16: [-32768n, 32767n], i32: [-2147483648n, 2147483647n], i64: [I64_MIN, I64_MAX],
  u8: [0n, 255n], u16: [0n, 65535n], u32: [0n, 4294967295n], u64: [0n, U64_MAX], usize: [0n, 4294967295n],
};
/** Whether an exact bigint value fits integer type `t` (E2008). */
export function intLiteralFits(value: bigint | null, t: NumName): boolean {
  const r = INT_RANGE[t];
  return value !== null && !!r && value >= r[0] && value <= r[1];
}
/** Whether a literal value fits the numeric type (E2008, Q015). */
export function literalFits(value: number, t: NumName): boolean {
  if (!Number.isFinite(value)) return false; // Q255: `1e400` would be a back door to Infinity
  const r = INT_RANGE[t];
  if (r) return Number.isInteger(value) && value >= Number(r[0]) && value <= Number(r[1]);
  if (t === "f32") return Number.isFinite(Math.fround(value));
  return true;
}

/** §10.2 (Q229): `t` has a byte layout, so it can be a container element in strict / rt. */
export const hasLayout = (t: Type): boolean => t.k === "error" || collectTParams(t).length > 0 || layout(t) !== undefined;
/** The element-carrying containers of §3.3 / §15.1: strict / rt code lays their elements out per §10.2. */
export const ELEMENT_CONTAINERS = new Set(["Vec", "Slice", "Pool", "Handle", "ArenaBuf", "RingTx", "RingRx"]);

/** A lone (unpaired) UTF-16 surrogate has no UTF-8 form, so no string-literal type may contain one (E2012, Q238). */
export const hasLoneSurrogate = (s: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

/** §3.3 (Q233): whether a parameter (`ret` false) or return (`ret` true) type of a strict / rt function can cross the
 * managed / C boundary (`never` is return-only). */
export function crossOk(t: Type, ret = false): boolean {
  t = unref(t);
  switch (t.k) {
    case "prim": return t.name === "never" ? ret : true;
    case "record": return t.fields.every((f) => crossOk(f.type));
    case "union": { const n = nonNull(t); return n ? crossOk(n, ret) : t.members.every((m) => crossOk(m)); }
    default: return true;
  }
}
/** The type parameters whose value crosses the boundary as such: `T`, `T | null`, a field of a record or `Result`. */
export function crossTParams(t: Type, out: TParam[] = []): TParam[] {
  t = unref(t);
  if (t.k === "tparam") out.push(t.p);
  else if (t.k === "union") t.members.forEach((m) => crossTParams(m, out));
  else if (t.k === "record") t.fields.forEach((f) => crossTParams(f.type, out));
  return out;
}

/** All type parameters occurring anywhere inside `t`. */
export function collectTParams(t: Type, out: TParam[] = []): TParam[] {
  switch (t.k) {
    case "tparam": out.push(t.p); break;
    case "record": for (const f of t.fields) collectTParams(f.type, out); break;
    case "union": for (const m of t.members) collectTParams(m, out); break;
    case "fn": for (const p of t.params) collectTParams(p, out); collectTParams(t.ret, out); break;
    case "gen": case "class": case "iface": for (const a of t.args) collectTParams(a, out); break;
    case "tuple": for (const e of t.elems) collectTParams(e, out); break;
    case "resource": collectTParams(t.inner, out); break;
  }
  return out;
}
/** A Promise anywhere in `t` except behind a function type (calling the function is checked where it happens). */
export function promiseIn(t: Type): boolean {
  switch (t.k) {
    case "gen": return t.name === "Promise" || t.args.some(promiseIn);
    case "union": return t.members.some(promiseIn);
    case "record": return t.fields.some((f) => promiseIn(f.type));
    case "tuple": return t.elems.some(promiseIn);
    case "class": return t.args.some(promiseIn);
    case "resource": return promiseIn(t.inner);
    default: return false;
  }
}

/** §14.4 / §7.3: `t` mentions Ptr, ConstPtr or CHandle anywhere (function types included). */
/** §14.4.3's call rule counts a bare Ptr / ConstPtr in a signature, not one wrapped in a
 * CHandle: a CHandle's type argument cannot itself hold a Ptr (E4008 where it is written),
 * so the safe side can hold and pass the handle without ever reading the pointer (Q218). */
export function hasRawPtr(t: Type): boolean {
  switch (t.k) {
    case "cstruct": return true;
    case "gen": return t.name === "Ptr" || t.name === "ConstPtr" || t.name === "CType" || (t.name !== "CHandle" && t.args.some(hasRawPtr));
    case "record": return t.fields.some((f) => hasRawPtr(f.type));
    case "union": return t.members.some(hasRawPtr);
    case "tuple": return t.elems.some(hasRawPtr);
    case "fn": return t.params.some(hasRawPtr) || hasRawPtr(t.ret);
    case "class": case "iface": return t.args.some(hasRawPtr);
    case "resource": return hasRawPtr(t.inner);
    default: return false;
  }
}
export function hasPtr(t: Type): boolean {
  switch (t.k) {
    case "gen": return t.name === "Ptr" || t.name === "ConstPtr" || t.name === "CHandle" || t.args.some(hasPtr);
    case "record": return t.fields.some((f) => hasPtr(f.type));
    case "union": return t.members.some(hasPtr);
    case "tuple": return t.elems.some(hasPtr);
    case "fn": return t.params.some(hasPtr) || hasPtr(t.ret);
    case "class": case "iface": return t.args.some(hasPtr);
    case "resource": return hasPtr(t.inner);
    default: return false;
  }
}
/** §15.1 (Q210): `t` is or contains an `ArenaBuf`, which a ring element may not be (the endpoints are isolate-sendable). */
export function hasArenaBuf(t: Type): boolean {
  switch (t.k) {
    case "gen": return t.name === "ArenaBuf" || t.args.some(hasArenaBuf);
    case "record": return t.fields.some((f) => hasArenaBuf(f.type));
    case "union": return t.members.some(hasArenaBuf);
    case "tuple": return t.elems.some(hasArenaBuf);
    case "fn": return t.params.some(hasArenaBuf) || hasArenaBuf(t.ret);
    case "class": case "iface": return t.args.some(hasArenaBuf);
    case "resource": return hasArenaBuf(t.inner);
    default: return false;
  }
}

/** §15.2 / SPEC-v1 §3.4 (Send): types a `Port<S, R>` may carry. */
export function sendable(t: Type): boolean {
  switch (t.k) {
    case "error": return true;
    case "tparam": return tparamHasCap(t.p, "Send");
    case "num": case "lit": return true;
    case "prim": return t.name === "boolean" || t.name === "null" || t.name === "string";
    case "union": return t.members.every(sendable);
    case "tuple": return t.elems.every(sendable);
    case "record": return t.struct ? t.fields.every((f) => sendable(f.type)) : t.fields.every((f) => f.readonly && sendable(f.type));
    case "gen":
      return t.name === "Arena" || ((t.name === "Vec" || t.name === "Pool" || t.name === "Handle" || t.name === "RingTx" || t.name === "RingRx") && t.args.every(sendable));
    default: return false;
  }
}

/** §14.4: types that may sit behind Ptr / ConstPtr. Function types are Ptr-only; the caller decides those. */
export function ptrTargetOk(t: Type): boolean {
  switch (t.k) {
    case "error": case "num": case "cstruct": return true;
    case "tparam": return tparamHasCap(t.p, "Native");
    case "prim": return t.name === "boolean" || t.name === "void" || t.name === "null";
    case "record": return t.struct ? t.fields.every((f) => ptrTargetOk(f.type)) : isCopyValueRecord(t);
    case "union": return t.members.every(ptrTargetOk);
    case "gen":
      return t.name === "CType" || t.name === "Vec" || t.name === "Pool" || t.name === "Handle" || t.name === "Arena" || t.name === "ArenaBuf" || t.name === "RingTx" || t.name === "RingRx" || t.name === "CHandle" ||
        ((t.name === "Ptr" || t.name === "ConstPtr") && ptrTargetOk(t.args[0]!));
    default: return false;
  }
}
/** §14.4 (Q209, Q210): types `Ptr.box` accepts: Copy+Native types, CHandle, and Structs whose fields are all boxable. */
export function boxable(t: Type): boolean {
  if (t.k === "error") return true;
  if (t.k === "tparam") return tparamHasCap(t.p, "Copy") && tparamHasCap(t.p, "Native");
  if (isCopy(t) && isNative(t)) return true;
  if (t.k === "gen" && (t.name === "CHandle" || t.name === "RingTx" || t.name === "RingRx")) return true; // ring endpoints: Q209
  if (t.k === "record" && t.struct) return t.fields.every((f) => boxable(f.type));
  return false;
}
/** SPEC-v1 §3.4 (`Native & Send`): types `audio.open` moves to the real-time audio callback. */
export const audioStateOk = (t: Type): boolean =>
  t.k === "error" || (isNative(t) && sendable(t) && !hasPtr(t) && !hasArenaBuf(t) && (!movesLike(t) || isOwnedCap(t)));
