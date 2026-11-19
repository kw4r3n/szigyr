// P2 type representation (D009). Plain objects compared structurally; class / interface by symbol identity.
import type { ts } from "./parse.ts";

export type NumName = "f64" | "f32" | "i8" | "i16" | "i32" | "u8" | "u16" | "u32" | "usize";
export const NUM_NAMES: readonly NumName[] = ["f64", "f32", "i8", "i16", "i32", "u8", "u16", "u32", "usize"];
export type PrimName = "boolean" | "string" | "null" | "void" | "unknown" | "never";
/** Builtin generic types (§3.2, §3.3). */
export type GenName = "Array" | "ReadonlyArray" | "Map" | "Set" | "Promise" | "Vec" | "Slice" | "Pool" | "Handle" | "Arena" | "ArenaBuf" | "RingTx" | "RingRx" | "Ref" | "Mut" | "OwnedCell" | "Ptr" | "ConstPtr" | "CType" | "CHandle" | "Port";
export const GEN_ARITY: Record<GenName, number> = {
  Array: 1, ReadonlyArray: 1, Map: 2, Set: 1, Promise: 1, Vec: 1, Slice: 1, Pool: 1, Handle: 1, Arena: 0, ArenaBuf: 1, RingTx: 1, RingRx: 1, Ref: 1, Mut: 1, OwnedCell: 1, Ptr: 1, ConstPtr: 1, CType: 1, CHandle: 1, Port: 2,
};
/** Opaque builtin types: authorities (§7.1), Test, JsRef, the fakes (Q038). */
export const AUTHORITIES = ["System", "Alloc", "Fs", "Clock", "Random", "Log", "Js", "Ffi", "Spawn"] as const; // Ffi: §14.2; Spawn: §15.2
export const OPAQUE_NAMES = new Set<string>([...AUTHORITIES, "JsRef", "Test", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs"]);

export interface Field { name: string; type: Type; readonly: boolean }
/** Q127: conditions a type parameter takes on from the positions it is used in, checked on every instantiation. */
/** `nopromise`: every user type parameter has it (Q130 addendum): a Promise cannot hide behind a type parameter. */
export type Need = "key" | "copy" | "field" | "borrow" | "eq" | "nopromise" | "noabuf" | "send" | "noauth";
/** `owner`: the declaring layer for user type parameters (Q068 b): "managed" ones never take owned types, strict / rt ones may. */
export interface TParam { name: string; id: number; constraint?: Type; need?: Set<Need>; owner?: "managed" | "strict" | "rt" }
/** `min`: builtin optional trailing parameters (Q032). `prefix`: a builtin callback may take a prefix of the parameters. */
export interface FnType {
  k: "fn"; tparams: TParam[]; params: Type[]; ret: Type; min?: number; prefix?: boolean;
  /** Builtin call-site conditions: `cast` / `eq` / `copy` constrain the first type argument (Q084, Q086); `trap` checks the code literal (Q058). */
  /** `box` / `chandle` / `castptr`: the §14.4 / §14.5 conditions on the type argument. */
  tcheck?: "cast" | "eq" | "copy" | "trap" | "box" | "chandle" | "castptr" | "ring";
}

export interface ClassSym {
  name: string;
  decl: ts.ClassDeclaration;
  tparams: TParam[];
  fields: Map<string, { type: Type; readonly: boolean; private: boolean; static: boolean; node: ts.PropertyDeclaration }>;
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
  | { k: "iter"; elem: Type };

export const ERROR: Type = { k: "error" };
const prims = new Map<PrimName, Type>();
export const prim = (name: PrimName): Type => { let t = prims.get(name); if (!t) prims.set(name, t = { k: "prim", name }); return t; };
const nums = new Map<NumName, Type>();
export const num = (name: NumName): Type => { let t = nums.get(name); if (!t) nums.set(name, t = { k: "num", name }); return t; };
export const BOOL = prim("boolean"), STR = prim("string"), NULL = prim("null"), VOID = prim("void"), UNKNOWN = prim("unknown"), NEVER = prim("never");
export const F64 = num("f64"), USIZE = num("usize");
export const gen = (name: GenName, ...args: Type[]): Type => ({ k: "gen", name, args });
export const opaque = (name: string): Type => ({ k: "opaque", name });
export const fn = (params: Type[], ret: Type, tparams: TParam[] = []): FnType => ({ k: "fn", tparams, params, ret });
export const record = (fields: Field[], struct = false): Type => ({ k: "record", fields: [...fields].sort((a, b) => (a.name < b.name ? -1 : 1)), struct });
export const ro = (name: string, type: Type): Field => ({ name, type, readonly: true });

let tpId = 0;
export const newTParam = (name: string, constraint?: Type): TParam => ({ name, id: ++tpId, ...(constraint ? { constraint } : {}) });

/** Flattened union; a single member collapses. Duplicates (by identity) are dropped. */
export function union(ts: Type[]): Type {
  const out: Type[] = [];
  for (const t of ts.flatMap((x) => (x.k === "union" ? x.members : [x]))) if (!out.some((o) => same(o, t))) out.push(t);
  return out.length === 1 ? out[0]! : { k: "union", members: out };
}
export const nullable = (t: Type): Type => union([t, NULL]);
/** `T | null` -> T; otherwise undefined. */
export function nonNull(t: Type): Type | undefined {
  if (t.k !== "union" || !t.members.some(isNull)) return undefined;
  return union(t.members.filter((m) => !isNull(m)));
}
export const isNull = (t: Type): boolean => t.k === "prim" && t.name === "null";
export const isNum = (t: Type): t is { k: "num"; name: NumName } => t.k === "num";
export const isInt = (t: Type): boolean => t.k === "num" && t.name !== "f64" && t.name !== "f32";
export const isBool = (t: Type): boolean => t.k === "prim" && t.name === "boolean";
export const isStr = (t: Type): boolean => (t.k === "prim" && t.name === "string") || t.k === "lit" || (t.k === "union" && t.members.every((m) => m.k === "lit"));
export const isErr = (t: Type): boolean => t.k === "error";
/** Ref<X> / Mut<X> read as X in P2 (Q020 addendum, Q064). */
export const unref = (t: Type): Type => (t.k === "gen" && (t.name === "Ref" || t.name === "Mut") ? t.args[0]! : t);

export function field(t: Type, name: string): Field | undefined {
  return t.k === "record" ? t.fields.find((f) => f.name === name) : undefined;
}
/** The `kind` literal of a tagged-union member. */
export function kindOf(t: Type): string | undefined {
  const f = field(t, "kind");
  return f?.type.k === "lit" ? f.type.value : undefined;
}
export const isTaggedUnion = (t: Type): t is { k: "union"; members: Type[] } => t.k === "union" && t.members.length > 1 && t.members.every((m) => kindOf(m) !== undefined);
/** Result<T, E> (§8) -> its T and E. */
export function resultParts(t: Type): { ok: Type; err: Type } | undefined {
  if (t.k !== "union" || t.members.length !== 2) return;
  const ok = t.members.find((m) => kindOf(m) === "ok"), er = t.members.find((m) => kindOf(m) === "err");
  const v = ok && field(ok, "value"), e = er && field(er, "error");
  return v && e ? { ok: v.type, err: e.type } : undefined;
}
export const result = (ok: Type, err: Type): Type => union([
  record([ro("kind", { k: "lit", value: "ok" }), ro("value", ok)]),
  record([ro("kind", { k: "lit", value: "err" }), ro("error", err)]),
]);
export const ERROR_RECORD = record([ro("code", STR), ro("message", STR)]); // IoError, CastError, JsError (§7.1, Q036)

export function same(a: Type, b: Type): boolean {
  if (a === b) return true;
  switch (a.k) {
    case "error": return b.k === "error";
    case "prim": return b.k === "prim" && a.name === b.name;
    case "num": return b.k === "num" && a.name === b.name;
    case "lit": return b.k === "lit" && a.value === b.value;
    case "record":
      return b.k === "record" && a.struct === b.struct && a.fields.length === b.fields.length &&
        a.fields.every((f, i) => { const g = b.fields[i]!; return f.name === g.name && f.readonly === g.readonly && same(f.type, g.type); });
    case "union": return b.k === "union" && a.members.length === b.members.length && a.members.every((m) => b.members.some((n) => same(m, n)));
    case "fn": return b.k === "fn" && a.params.length === b.params.length && a.params.every((p, i) => same(p, b.params[i]!)) && same(a.ret, b.ret);
    case "class": return b.k === "class" && a.cls === b.cls && sameArgs(a.args, b.args);
    case "iface": return b.k === "iface" && a.iface === b.iface && sameArgs(a.args, b.args);
    case "tparam": return b.k === "tparam" && a.p.id === b.p.id;
    case "gen": return b.k === "gen" && a.name === b.name && sameArgs(a.args, b.args);
    case "opaque": case "ns": return b.k === a.k && a.name === b.name;
    case "iter": return b.k === "iter" && same(a.elem, b.elem);
  }
}
const sameArgs = (a: Type[], b: Type[]): boolean => a.length === b.length && a.every((x, i) => same(x, b[i]!));

/** Fakes assignable to their authority (Q020-10, Q038). */
const FAKE_OF: Record<string, string> = { FakeClock: "Clock", SeededRandom: "Random", MemoryLog: "Log", FakeFs: "Fs" };

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
  if (s.k === "fn" && t.k === "fn") {
    if (s.params.length > t.params.length || (!t.prefix && s.params.length !== t.params.length)) return false;
    // a builtin void callback drops the result; a dropped Promise would lose its trap (Q125)
    return s.params.every((p, i) => assignable(t.params[i]!, p)) && (assignable(s.ret, t.ret) || (t.ret.k === "prim" && t.ret.name === "void" && !!t.prefix && !(s.ret.k === "gen" && s.ret.name === "Promise")));
  }
  if (s.k === "class" && t.k === "iface") return s.cls.implements.some((i) => same(substClass(i, s), t));
  if (s.k === "tparam" && s.p.constraint) return assignable(s.p.constraint, t, arg);
  if (s.k === "opaque" && t.k === "opaque") return FAKE_OF[s.name] === t.name;
  return false;
}
/** An `implements` clause type, with the class's own type parameters replaced by the instance's arguments. */
export const substClass = (t: Type, inst: { cls: ClassSym; args: Type[] }): Type => subst(t, bindTParams(inst.cls.tparams, inst.args));

export const bindTParams = (ps: TParam[], args: Type[]): Map<number, Type> => new Map(ps.map((p, i) => [p.id, args[i] ?? ERROR]));

export function subst(t: Type, m: Map<number, Type>): Type {
  if (!m.size) return t;
  switch (t.k) {
    case "tparam": return m.get(t.p.id) ?? t;
    case "record": return { ...t, fields: t.fields.map((f) => ({ ...f, type: subst(f.type, m) })) };
    case "union": return union(t.members.map((x) => subst(x, m)));
    case "fn": return { ...t, params: t.params.map((x) => subst(x, m)), ret: subst(t.ret, m) };
    case "class": case "iface": case "gen": return { ...t, args: t.args.map((x) => subst(x, m)) } as Type;
    case "iter": return { k: "iter", elem: subst(t.elem, m) };
    default: return t;
  }
}

export function hasTParam(t: Type, ids: Set<number>): boolean {
  switch (t.k) {
    case "tparam": return ids.has(t.p.id);
    case "record": return t.fields.some((f) => hasTParam(f.type, ids));
    case "union": return t.members.some((x) => hasTParam(x, ids));
    case "fn": return t.params.some((x) => hasTParam(x, ids)) || hasTParam(t.ret, ids);
    case "class": case "iface": case "gen": return t.args.some((x) => hasTParam(x, ids));
    case "iter": return hasTParam(t.elem, ids);
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
      if (a.k === "gen" && (a.name === p.name || (p.name === "ReadonlyArray" && a.name === "Array") || (p.name === "Slice" && a.name === "Vec"))) p.args.forEach((x, i) => unify(x, a.args[i]!, m, ids));
      return;
    case "fn":
      if (a.k === "fn") { p.params.forEach((x, i) => { if (a.params[i]) unify(x, a.params[i]!, m, ids); }); unify(p.ret, a.ret, m, ids); }
      return;
    case "record":
      if (a.k === "record") for (const f of p.fields) { const g = field(a, f.name); if (g) unify(f.type, g.type, m, ids); }
      return;
    case "class": case "iface":
      if (a.k === p.k && (a as { args: Type[] }).args.length === p.args.length) p.args.forEach((x, i) => unify(x, (a as { args: Type[] }).args[i]!, m, ids));
      else if (p.k === "iface" && a.k === "class") for (const i of a.cls.implements) { const it = substClass(i, a); if (it.k === "iface" && it.iface === p.iface) unify(p, it, m, ids); }
      return;
    default:
  }
}

/** Copy types (§5.1): numbers, boolean, Copy Structs, unions of Copy types. Plain records count when all-readonly (Q043). */
export function isCopy(t: Type): boolean {
  switch (t.k) {
    case "num": case "lit": return true;
    case "gen": return t.name === "Handle" || t.name === "ArenaBuf" || t.name === "Ptr" || t.name === "ConstPtr"; // Q188: a handle is three u32s, an ArenaBuf four; §14.4: raw pointers are Copy
    case "prim": return t.name === "boolean" || t.name === "null";
    case "record": return t.fields.every((f) => f.readonly && isCopy(f.type));
    case "union": return t.members.every(isCopy);
    default: return false;
  }
}
/** Owned types (§5.1): non-Copy Structs and Vec. */
export const isOwned = (t: Type): boolean => (t.k === "gen" && (t.name === "Vec" || t.name === "Pool" || t.name === "Arena" || t.name === "CHandle" || t.name === "RingTx" || t.name === "RingRx")) || (t.k === "record" && t.struct && !isCopy(t)); // CHandle: §14.5
/**
 * P3: values that move. Owned types, unions holding one, and strict / rt type parameters (Q049; managed ones never are, Q068 b)
 * unless their instantiations cannot be owned: an interface constraint (only classes implement one), or a `key` / `copy` / `eq` condition (Q153).
 */
/** Q174: an owned value (directly, in a union, or in a record / Struct field). */
export const holdsOwned = (t: Type): boolean =>
  movesLike(t) || (t.k === "record" && t.fields.some((f) => holdsOwned(f.type))) || (t.k === "union" && t.members.some(holdsOwned));
/** Q174 (案2): an Array / ReadonlyArray / Map / Set / Promise whose type arguments are, or hold, owned types (E3007). */
export const CONTAINERS = new Set(["Array", "ReadonlyArray", "Map", "Set", "Promise"]);
export const ownedInside = (t: Type | undefined): boolean =>
  !!t && (t.k === "union" ? t.members.some(ownedInside) : t.k === "gen" && CONTAINERS.has(t.name) && t.args.some((a) => holdsOwned(a) || ownedInside(a)));

/** Q174: a container holding owned values anywhere inside `t`, through record / union / generic / function types and class / interface members. */
export function ownedDeep(t: Type, seen = new Set<object>()): boolean {
  switch (t.k) {
    case "record": return t.fields.some((f) => ownedDeep(f.type, seen));
    case "union": return t.members.some((m) => ownedDeep(m, seen));
    case "gen": return ownedInside(t) || t.args.some((a) => ownedDeep(a, seen));
    case "fn": return t.params.some((p) => ownedDeep(p, seen)) || ownedDeep(t.ret, seen);
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
    default: return false;
  }
}

export function movesLike(t: Type): boolean {
  if (t.k === "tparam") return (t.p.owner === "strict" || t.p.owner === "rt") && !t.p.constraint && !["key", "copy", "eq"].some((n) => t.p.need?.has(n as Need));
  return isOwned(t) || (t.k === "union" && t.members.some(movesLike));
}

const isAuthority = (t: Type): boolean => t.k === "opaque" && (AUTHORITIES as readonly string[]).includes(t.name);
/** An authority anywhere in `t` (E4006 in rt, §6). */
export const hasAuthority = (t: Type): boolean =>
  isAuthority(t) || (t.k === "record" && t.fields.some((f) => hasAuthority(f.type))) || (t.k === "union" && t.members.some(hasAuthority)) || (t.k === "gen" && t.args.some(hasAuthority));
/** §3.3 (Q040 - Q043): the types strict / rt code may use. Authorities are strict-only (rt: E4006). */
export function layerOk(t: Type): boolean {
  switch (t.k) {
    case "error": case "num": case "lit": case "tparam": return true;
    case "prim": return t.name === "boolean" || t.name === "null" || t.name === "void" || t.name === "never";
    case "record": return t.struct ? t.fields.every((f) => layerOk(f.type)) : isCopy(t); // Q043
    case "union": return t.members.every((m) => isCopy(m) && layerOk(m));
    case "gen": return t.name === "Vec" || t.name === "Slice" || t.name === "Pool" || t.name === "Handle" || t.name === "Arena" || t.name === "ArenaBuf" || t.name === "RingTx" || t.name === "RingRx" || t.name === "Ptr" || t.name === "ConstPtr" || t.name === "CType" || t.name === "CHandle" || ((t.name === "Ref" || t.name === "Mut") && layerOk(t.args[0]!)); // §14: pointer types are layer-legal; their positions are E4007 / E4008
    case "opaque": return isAuthority(t);
    default: return false;
  }
}

export function show(t: Type): string {
  switch (t.k) {
    case "error": return "<error>";
    case "prim": case "num": case "opaque": case "ns": return t.name;
    case "lit": return JSON.stringify(t.value);
    case "record": return `${t.struct ? "Struct<" : ""}{ ${t.fields.map((f) => `${f.readonly ? "readonly " : ""}${f.name}: ${show(f.type)}`).join("; ")} }${t.struct ? ">" : ""}`;
    case "union": return t.members.map(show).join(" | ");
    case "fn": return `(${t.params.map(show).join(", ")}) => ${show(t.ret)}`;
    case "class": return t.cls.name + (t.args.length ? `<${t.args.map(show).join(", ")}>` : "");
    case "iface": return t.iface.name + (t.args.length ? `<${t.args.map(show).join(", ")}>` : "");
    case "tparam": return t.p.name;
    case "gen": return `${t.name}<${t.args.map(show).join(", ")}>`;
    case "iter": return `Iterator<${show(t.elem)}>`;
  }
}

/** `Map` key / `Set` element types (§3.2, Q081). Type parameters cannot be checked here. */
export const keyOk = (t: Type): boolean =>
  t.k === "error" || t.k === "tparam" || t.k === "num" || t.k === "lit" || (t.k === "prim" && (t.name === "string" || t.name === "boolean")) ||
  (t.k === "union" && t.members.every((m) => m.k === "lit"));

/** Types `cast<T>`, `js.decode<T>` and `JSON.stringify<T>` accept (§3.2 `unknown`, Q084): primitives, closed records, tagged / literal unions, `Array`, `T | null`. */
export function castable(t: Type): boolean {
  switch (t.k) {
    case "num": case "lit": return true;
    case "prim": return t.name === "boolean" || t.name === "string" || t.name === "null";
    case "record": return !t.struct && t.fields.every((f) => castable(f.type));
    case "union": return t.members.every(castable);
    case "gen": return t.name === "Array" && castable(t.args[0]!);
    default: return false;
  }
}

/** `Test.eq` operands (§9.2, Q086): no owned values, function values or authorities anywhere inside. */
export function comparable(t: Type): boolean {
  switch (t.k) {
    case "fn": case "opaque": case "ns": case "iter": return false;
    case "record": return !isOwned(t) && t.fields.every((f) => comparable(f.type));
    case "union": return t.members.every(comparable);
    case "gen": return t.name !== "Vec" && t.name !== "Slice" && t.name !== "Pool" && t.name !== "Arena" && t.name !== "OwnedCell" && t.name !== "Promise" && t.name !== "RingTx" && t.name !== "RingRx" && t.args.every(comparable);
    default: return true;
  }
}

/** Struct field types (§3.3, Q086): numbers, boolean, Struct, Vec. */
export const structField = (t: Type): boolean => t.k === "error" || t.k === "tparam" || t.k === "num" || isBool(t) || (t.k === "record" && t.struct) || (t.k === "gen" && (t.name === "Vec" || t.name === "Pool" || t.name === "Handle" || t.name === "Arena" || t.name === "ArenaBuf" || t.name === "RingTx" || t.name === "RingRx" || t.name === "CHandle" || t.name === "Ptr" || t.name === "ConstPtr" || t.name === "CType")); // Arena as a field: Q214; CHandle as a field: §14.5. Ptr / CType in a field are the checker's E4008 / E4007, not E4002

/** Integer ranges (§3.1). */
export const INT_RANGE: Partial<Record<NumName, [number, number]>> = {
  i8: [-128, 127], i16: [-32768, 32767], i32: [-2147483648, 2147483647],
  u8: [0, 255], u16: [0, 65535], u32: [0, 4294967295], usize: [0, 4294967295],
};
/** Whether a literal value fits the numeric type (E2008, Q015). */
export function literalFits(value: number, t: NumName): boolean {
  const r = INT_RANGE[t];
  if (r) return Number.isInteger(value) && value >= r[0] && value <= r[1];
  if (t === "f32") return !Number.isFinite(value) || Number.isFinite(Math.fround(value));
  return true;
}

/** Q127: whether a type that is not a type parameter meets a condition. */
export function needOk(n: Need, t: Type): boolean {
  switch (n) {
    case "key": return keyOk(t);
    case "copy": return t.k === "error" || isCopy(t);
    case "field": return structField(t);
    case "borrow": return t.k === "error" || isOwned(t) || (t.k === "gen" && t.name === "Slice");
    case "eq": return comparable(t);
    case "noabuf": return t.k === "error" || !hasArenaBuf(t);
    case "send": return sendable(t);
    case "nopromise": return !promiseIn(t);
    case "noauth": return !hasAuthority(t);
  }
}
/** Needs that propagate structurally into type parameters nested inside composite types (records, unions, generics). */
export const DEEP_NEEDS = new Set<Need>(["eq", "noabuf", "send", "nopromise", "noauth"]);
/** All type parameters occurring anywhere inside `t`. */
export function collectTParams(t: Type, out: TParam[] = []): TParam[] {
  switch (t.k) {
    case "tparam": out.push(t.p); break;
    case "record": for (const f of t.fields) collectTParams(f.type, out); break;
    case "union": for (const m of t.members) collectTParams(m, out); break;
    case "fn": for (const p of t.params) collectTParams(p, out); collectTParams(t.ret, out); break;
    case "gen": case "class": case "iface": for (const a of t.args) collectTParams(a, out); break;
  }
  return out;
}
/** A Promise anywhere in `t` except behind a function type (calling the function is checked where it happens). */
function promiseIn(t: Type): boolean {
  switch (t.k) {
    case "gen": return t.name === "Promise" || t.args.some(promiseIn);
    case "union": return t.members.some(promiseIn);
    case "record": return t.fields.some((f) => promiseIn(f.type));
    case "class": return t.args.some(promiseIn);
    default: return false;
  }
}
/** `t` meets `n`, or is a type parameter, which then requires `n` of whatever instantiates it (Q127). */
export function demand(t: Type, n: Need): boolean {
  if (t.k === "tparam") { (t.p.need ??= new Set()).add(n); return true; }
  if (!needOk(n, t)) return false;
  if (DEEP_NEEDS.has(n)) for (const p of collectTParams(t)) (p.need ??= new Set()).add(n);
  return true;
}

/** §14.4 / §7.3: `t` mentions Ptr, ConstPtr or CHandle anywhere (function types included). */
/** §14.4.3's call rule counts a bare Ptr / ConstPtr in a signature, not one wrapped in a
 * CHandle: a CHandle's type argument cannot itself hold a Ptr (E4008 where it is written),
 * so the safe side can hold and pass the handle without ever reading the pointer (Q218). */
export function hasRawPtr(t: Type): boolean {
  switch (t.k) {
    case "gen": return t.name === "Ptr" || t.name === "ConstPtr" || (t.name !== "CHandle" && t.args.some(hasRawPtr));
    case "record": return t.fields.some((f) => hasRawPtr(f.type));
    case "union": return t.members.some(hasRawPtr);
    case "fn": return t.params.some(hasRawPtr) || hasRawPtr(t.ret);
    case "class": case "iface": return t.args.some(hasRawPtr);
    default: return false;
  }
}
export function hasPtr(t: Type): boolean {
  switch (t.k) {
    case "gen": return t.name === "Ptr" || t.name === "ConstPtr" || t.name === "CHandle" || t.args.some(hasPtr);
    case "record": return t.fields.some((f) => hasPtr(f.type));
    case "union": return t.members.some(hasPtr);
    case "fn": return t.params.some(hasPtr) || hasPtr(t.ret);
    case "class": case "iface": return t.args.some(hasPtr);
    default: return false;
  }
}
/** §15.1 (Q210): `t` is or contains an `ArenaBuf`, which a ring element may not be (the endpoints are isolate-sendable). */
export function hasArenaBuf(t: Type): boolean {
  switch (t.k) {
    case "gen": return t.name === "ArenaBuf" || t.args.some(hasArenaBuf);
    case "record": return t.fields.some((f) => hasArenaBuf(f.type));
    case "union": return t.members.some(hasArenaBuf);
    case "fn": return t.params.some(hasArenaBuf) || hasArenaBuf(t.ret);
    case "class": case "iface": return t.args.some(hasArenaBuf);
    default: return false;
  }
}
/** §15.2: `t` is, or contains, a type that may not cross to an isolate: the arena / pool family
 * (their ids are per-isolate), a CHandle, or one of the types §15.2 lists as unsendable. */
function hasUnsendable(t: Type): boolean {
  switch (t.k) {
    case "gen": return t.name === "Pool" || t.name === "Arena" || t.name === "ArenaBuf" || t.name === "CHandle" ||
      t.name === "Array" || t.name === "ReadonlyArray" || t.name === "Map" || t.name === "Set" || t.name === "Promise" ||
      t.name === "Port" || t.name === "OwnedCell" || t.args.some(hasUnsendable);
    case "record": return t.fields.some((f) => hasUnsendable(f.type));
    case "union": return t.members.some(hasUnsendable);
    case "fn": case "class": case "iface": case "opaque": return true;
    case "prim": return t.name === "unknown";
    default: return false;
  }
}

/** §15.2 (Q200, Q210): the types a `Port<S, R>` may carry. A type parameter defers to the `send`
 * condition (Q127), as do type parameters in the positions this type's sendability depends on. */
export function sendable(t: Type): boolean {
  switch (t.k) {
    case "error": return true;
    case "tparam": return demand(t, "send");
    case "num": case "lit": return true;
    case "prim": return t.name === "boolean" || t.name === "null" || t.name === "string";
    case "union": return t.members.every(sendable);
    case "record": return t.struct ? !hasUnsendable(t) : t.fields.every((f) => f.readonly && sendable(f.type));
    case "gen":
      if (t.name === "Vec" || t.name === "RingTx" || t.name === "RingRx") { t.args.forEach((a) => void sendable(a)); return !hasUnsendable(t); }
      return t.name === "Handle";
    default: return false;
  }
}

/** §14.4: types that may sit behind Ptr / ConstPtr. Function types are Ptr-only; the caller decides those. */
export function ptrTargetOk(t: Type): boolean {
  switch (t.k) {
    case "error": case "num": case "tparam": return true;
    case "prim": return t.name === "boolean" || t.name === "void" || t.name === "null";
    case "record": return t.struct ? t.fields.every((f) => ptrTargetOk(f.type)) : isCopy(t);
    case "union": return t.members.every(ptrTargetOk);
    case "gen":
      return t.name === "CType" || t.name === "Vec" || t.name === "Pool" || t.name === "Handle" || t.name === "Arena" || t.name === "ArenaBuf" || t.name === "RingTx" || t.name === "RingRx" || t.name === "CHandle" ||
        ((t.name === "Ptr" || t.name === "ConstPtr") && ptrTargetOk(t.args[0]!));
    default: return false;
  }
}
/** §14.4 (Q209, Q210): types `Ptr.box` accepts: Copy types, CHandle, and Structs whose fields are all boxable. */
export function boxable(t: Type): boolean {
  if (isCopy(t)) return true;
  if (t.k === "gen" && (t.name === "CHandle" || t.name === "RingTx" || t.name === "RingRx")) return true; // ring endpoints: Q209
  if (t.k === "record" && t.struct) return t.fields.every((f) => boxable(f.type));
  return false;
}
