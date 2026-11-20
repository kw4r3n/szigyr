// C backend for strict / rt functions (D101-D103): one translation unit for the program's module-level strict / rt functions,
// plus a Node-API wrapper per function that managed JS calls. Every subexpression goes through a temporary, in source order (D103).
import { readFileSync } from "node:fs";
import { SyntaxKind as K, type Node, type ts } from "./parse.ts";
import { assignTarget, callFnArgs, callFns, callTArgs, exprTypes } from "./expr.ts";
import { sliceGroups } from "./ownership.ts";
import type { CFnSym, FnSym, Module, Program } from "./modules.ts";
import { layout, elemDesc, type Lay } from "./layout.ts";
import { DETMATH_PATH } from "./detmath.ts";
import { cPointeeOf, cTypeOf, parseCSpec } from "./cdecl.ts";
import { AUTHORITIES, isCopy, isInt, isTaggedUnion, kindOf, nonNull, isNull, isBool, unref, show, subst, type Field, type NumName, type Type } from "./types.ts";

/** A construct the C backend does not translate yet: the run stops with this error (never a silent fallback to JS). */
export class CUnsupported extends Error {
  constructor(where: string, what: string) { super(`C backend: ${what} is not supported (${where})`); this.name = "CUnsupported"; }
}

/** `keys`: strict / rt declarations and managed call sites of generic ones -> the addon export (`!generic`: no direct export).
 * `pkgs`: the pkg-config packages of the program's `c:` declarations; the TU includes their headers and the link needs their flags (§14.2). */
export interface EmittedC { c: string; keys: Map<Node, string>; pkgs: string[] }

const RANGE: Record<string, [string, string]> = {
  i8: ["-128LL", "127LL"], i16: ["-32768LL", "32767LL"], i32: ["-2147483648LL", "2147483647LL"],
  u8: ["0LL", "255LL"], u16: ["0LL", "65535LL"], u32: ["0LL", "4294967295LL"], usize: ["0LL", "4294967295LL"],
};
const CNUM: Record<NumName, string> = { f64: "double", f32: "float", i8: "int8_t", i16: "int16_t", i32: "int32_t", u8: "uint8_t", u16: "uint16_t", u32: "uint32_t", usize: "uint32_t" };
const TRAP: Record<string, number> = { T001: 1, T002: 2, T003: 3, T004: 4, T005: 5, T006: 6, T007: 7, T008: 8, T009: 9, T010: 10, T011: 11, T013: 13, T014: 14, T015: 15 };
const numText = (n: ts.NumericLiteral): number => Number(n.text.replace(/_/g, ""));
const isGen = (t: Type, n: string): boolean => t.k === "gen" && t.name === n;
/** Structs, and the all-readonly Copy records strict / rt accepts as Copy Structs (Q043). */
const isStruct = (t: Type): t is Extract<Type, { k: "record" }> => t.k === "record";
const AUTH = new Set<string>(AUTHORITIES);
const hasTParam = (t: Type): boolean => t.k === "tparam" || (t.k === "gen" && t.args.some(hasTParam)) || (t.k === "record" && t.fields.some((f) => hasTParam(f.type))) || (t.k === "union" && t.members.some(hasTParam)) || (t.k === "fn" && (t.params.some(hasTParam) || hasTParam(t.ret)));
const elemOf = (t: Type): Type => (t as { args: Type[] }).args[0]!;
/** The order C uses for record fields (`kind` first, then by name) and tagged union members (by `kind`), so types
 * that differ only in that order share one C type (#19). */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cfields = (t: Extract<Type, { k: "record" }>): Field[] => [...t.fields].sort((a, b) => (a.name === "kind" ? -1 : b.name === "kind" ? 1 : byName(a.name, b.name)));
const umembers = (u: Extract<Type, { k: "union" }>): Type[] => [...u.members].sort((a, b) => byName(kindOf(a)!, kindOf(b)!));
/** The key of a C type: `show` of the type in C order. */
function canon(t: Type): Type {
  if (t.k === "record") return { ...t, fields: cfields(t).map((f) => ({ ...f, type: canon(f.type) })) };
  if (t.k === "union") { const ms = [...t.members]; return { ...t, members: (isTaggedUnion(t) ? umembers(t) : ms.sort((a, b) => byName(show(a), show(b)))).map(canon) }; }
  if (t.k === "gen") return { ...t, args: t.args.map(canon) };
  return t;
}
const ckey = (t: Type): string => show(canon(t));
const borrowMode = (t: Type): "Ref" | "Mut" | undefined => (t.k === "gen" && (t.name === "Ref" || t.name === "Mut") ? t.name : undefined);

interface Local { c: string; t: Type; ptr: boolean }

/** Follows import / export chains (including re-exports) to the declaring module's value symbol. */
function resolveValue(mod: Module, name: string, seen = new Set<string>()): Module["values"] extends Map<string, infer V> ? V | undefined : never {
  const own = mod.values.get(name);
  if (own) return own;
  const key = `${mod.pf.path}:${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const imp = mod.imports.get(name);
  if (!imp) return undefined;
  const local = imp.mod.exports.get(imp.name);
  return local === undefined ? undefined : resolveValue(imp.mod, local, seen);
}
/** The function a name refers to in `mod` (local or imported, across re-exports). */
export function resolveFn(mod: Module, name: string): FnSym | undefined {
  const v = resolveValue(mod, name);
  return v?.k === "fn" ? v : undefined;
}
/** The C function a name refers to in `mod`: a `c:` declaration binds in its own file only (§14.1). */
function resolveCFn(mod: Module, name: string): CFnSym | undefined {
  const v = mod.values.get(name);
  return v?.k === "cfn" ? v : undefined;
}
function resolveConst(mod: Module, name: string): Extract<Module["values"] extends Map<string, infer V> ? V : never, { k: "const" }> | undefined {
  const v = resolveValue(mod, name);
  return v?.k === "const" ? v : undefined;
}

/** One C function: a strict / rt function, or one instantiation of a generic one (D104). `fns` is the
 * Q189 (b) part of the key: the concrete function bound to each function-typed parameter (by parameter index).
 * Function-typed parameters have no C parameter; calls through them call the bound instantiation directly. */
interface Inst { f: FnSym; m: Map<number, Type>; fns: Map<number, FnSym>; name: string; params: Type[]; ret: Type }
/** The parameter indices of `f` whose type is a function type (Q189 (b)). */
const fnParamIdx = (f: FnSym): number[] => f.sig.params.flatMap((pt, i) => (unref(pt).k === "fn" ? [i] : []));

export function emitC(prog: Program, display: (path: string) => string): EmittedC | undefined {
  void display;
  // §12 (D117): managed DetMath calls run the JS module directly; C compiles only DetMath functions reached from strict / rt.
  const fns = prog.fns.filter((f) => f.layer !== "managed" && f.mod.pf.path !== DETMATH_PATH);
  if (!fns.length) return undefined;
  const keys = new Map<Node, string>();
  const insts = new Map<string, Inst>();
  const queue: Inst[] = [];
  let fnIndex = 0;
  const fnBase = new Map<FnSym, string>();
  const baseOf = (f: FnSym): string => { let b = fnBase.get(f); if (!b) fnBase.set(f, b = `sts_F${fnIndex++}_${f.name}`); return b; };
  /** The C function for `f` with type arguments `args` and function arguments `fnArgs` (D104 + Q189 (b)). */
  function inst(f: FnSym, args: Type[], fnArgs: Map<number, FnSym>, where: string): Inst {
    if (args.some(hasTParam)) throw new CUnsupported(where, "a generic instantiation that is not concrete");
    const key = `${baseOf(f)}<${args.map(show).join(",")}|${[...fnArgs].map(([j, g]) => `${j}:${baseOf(g)}`).join(",")}>`;
    let i = insts.get(key);
    if (!i) {
      const m = new Map(f.sig.tparams.map((p, k) => [p.id, args[k]!]));
      i = { f, m, fns: fnArgs, name: args.length || fnArgs.size ? `${baseOf(f)}_I${insts.size}` : baseOf(f), params: f.sig.params.map((p) => subst(p, m)), ret: subst(f.sig.ret, m) };
      insts.set(key, i);
      queue.push(i);
    }
    return i;
  }
  /** The concrete function arguments of a call outside strict / rt code: names only (Q189 (b)). */
  function rootFnArgs(e: ts.CallExpression, f: FnSym, where: string): Map<number, FnSym> {
    const out = new Map<number, FnSym>();
    for (const j of fnParamIdx(f)) {
      const r = callFnArgs.get(e)?.get(j);
      if (!r || !("fn" in r)) throw new CUnsupported(where, "a function argument that is not a function name");
      out.set(j, r.fn);
    }
    return out;
  }
  for (const f of fns) {
    if (!f.sig.tparams.length && !fnParamIdx(f).length) keys.set(f.decl, inst(f, [], new Map(), f.name).name);
    else keys.set(f.decl, "!generic"); // called through its instances only (emit.ts)
  }
  // Managed call sites of generic strict / rt functions get the key of their instance (D104).
  for (const mod of prog.mods) {
    if (mod.pf.path === DETMATH_PATH) continue;
    const walk = (n: Node): void => {
      if (n.kind === K.FunctionDeclaration && fns.some((f) => f.decl === n)) return;
      if (n.kind === K.CallExpression && (n as ts.CallExpression).expression.kind === K.Identifier) {
        const fn = callFns.get(n); // as the checker resolved it: a local binding shadows the module name
        if (fn && fn.layer !== "managed" && (fn.sig.tparams.length || fnParamIdx(fn).length)) {
          const p = mod.pf.position(n.getStart(mod.sf));
          const where = `${mod.file}:${p.line}:${p.col}`;
          keys.set(n, inst(fn, callTArgs.get(n as ts.CallExpression) ?? [], rootFnArgs(n as ts.CallExpression, fn, where), where).name);
        }
      }
      n.forEachChild(walk);
    };
    walk(mod.sf);
  }

  const files: string[] = [];
  const poss: string[] = [];
  const typedefs: string[] = [];
  const structs = new Map<string, string>();
  const nullables = new Map<string, string>();
  const unions = new Map<string, string>();
  const lits: string[] = [];
  const helpers: string[] = [];
  /** Structs / unions with no JS <-> C converters (a `null` field, Q233): fine as locals, never reaches the boundary (D140). */
  const noConv = new Set<string>();
  const litId = (s: string): number => { let i = lits.indexOf(s); if (i < 0) { lits.push(s); i = lits.length - 1; } return i; };

  function ctype(t: Type, where: string): string {
    switch (t.k) {
      case "num": return CNUM[t.name];
      case "prim": if (t.name === "boolean") return "bool"; if (t.name === "void" || t.name === "never") return "void"; if (t.name === "null") return "sts_null"; break;
      case "lit": litId(t.value); return "int32_t"; // Q043: only `kind` fields and their comparisons
      case "record": return struct(t, where);
      case "gen":
        if (t.name === "Vec" || t.name === "Slice") {
          const e = elemOf(t);
          if (!layout(e)) throw new CUnsupported(where, `${t.name}<${show(e)}> (an element type without a byte layout, D105)`);
          return t.name === "Vec" ? "sts_vec*" : "sts_slice";
        }
        if (t.name === "Pool") { const e = elemOf(t); if (!layout(e)) throw new CUnsupported(where, `Pool<${show(e)}> (an element type without a byte layout, D105)`); return "sts_pool*"; }
        if (t.name === "RingTx" || t.name === "RingRx") { const e = elemOf(t); if (!layout(e)) throw new CUnsupported(where, `${t.name}<${show(e)}> (an element type without a byte layout, D105)`); return "sts_ring"; }
        if (t.name === "Handle") return "sts_handle";
        if (t.name === "CHandle") return "void *"; // §14.5: the wrapped C pointer itself
        if (t.name === "Arena") return "sts_arena*";
        if (t.name === "ArenaBuf") return "sts_abuf";
        if (t.name === "Ptr" || t.name === "ConstPtr") { // §14.2: the C type of a raw pointer, from the pointee
          const p = elemOf(t);
          if (unref(p).k === "fn") return fpType(p); // §14.6: a function pointer value is its typedef (Ptr and ConstPtr alike)
          const q = isGen(p, "Ptr") || isGen(p, "ConstPtr"); // a nested pointer composes through its own C type (cdecl.ts)
          return t.name === "Ptr" ? `${q ? ctype(p, where) : cPointeeOf(p)} *` : q ? `${ctype(p, where)} const *` : `const ${cPointeeOf(p)} *`;
        }
        if (t.name === "Ref" || t.name === "Mut") { const a = elemOf(t); return isStruct(a) ? `${ctype(a, where)}*` : ctype(a, where); }
        break;
      case "opaque": if (AUTH.has(t.name)) return "napi_value"; break;
      case "union": {
        if (isTaggedUnion(t)) return union(t, where);
        const lu = t as Extract<Type, { k: "union" }>;
        if (lu.members.every((m) => m.k === "lit")) { for (const m of lu.members) litId((m as { value: string }).value); return "int32_t"; }
        const n = nonNull(t);
        if (n && (n.k === "num" || isBool(n) || n.k === "lit" || (n.k === "union" && n.members.every((m) => m.k === "lit")) || (isStruct(n) && isCopy(n)) || isTaggedUnion(n) || (n.k === "gen" && (n.name === "Handle" || n.name === "ArenaBuf")))) {
          const key = ckey(t);
          let name = nullables.get(key);
          if (!name) { const inner = ctype(n, where); name = `sts_N${nullables.size}`; nullables.set(key, name); typedefs.push(`typedef struct { bool some; ${inner} v; } ${name};`); }
          return name;
        }
      }
    }
    throw new CUnsupported(where, `the type '${show(t)}'`);
  }

  const fps = new Map<string, string>();
  /** The C type of a function at the §14.2 boundary: the boundary mapping (cdecl), with a
   * function pointer value written as its typedef so the type composes in any position. */
  function abiType(t: Type): string {
    const u = unref(t);
    if (u.k === "gen" && (u.name === "Ptr" || u.name === "ConstPtr")) return ctype(u, "a C boundary type"); // nested function pointers through their typedefs
    return cTypeOf(u);
  }
  /** `typedef R (*FPn)(params)` for a function type, from the §14.2 boundary mapping. */
  function fpType(fnT: Type): string {
    const f = unref(fnT) as Extract<Type, { k: "fn" }>;
    const key = show(f);
    let name = fps.get(key);
    if (!name) {
      name = `sts_FP${fps.size}`;
      fps.set(key, name);
      typedefs.push(`typedef ${abiType(f.ret)} (*${name})(${f.params.map((x) => abiType(x)).join(", ") || "void"});`);
    }
    return name;
  }

  /** Registers a trap position (the same table FnGen.pos feeds). */
  function posOf(mod: Module, n: Node): number {
    const p = mod.pf.position(n.getStart(mod.sf));
    let fi = files.indexOf(mod.file);
    if (fi < 0) { files.push(mod.file); fi = files.length - 1; }
    poss.push(`{${fi},${p.line},${p.col}}`);
    return poss.length - 1;
  }

  // §14.6: one trampoline per function named by `cfn`, keyed by its instantiation.
  const tramps = new Map<string, { i: Inst; name: string }>();
  function trampoline(f: FnSym, where: string): string {
    const i = inst(f, [], new Map(), where);
    let tr = tramps.get(i.name);
    if (!tr) { tr = { i, name: `cb_${i.name}` }; tramps.set(i.name, tr); }
    return tr.name;
  }

  function struct(t: Extract<Type, { k: "record" }>, where: string): string {
    const key = ckey(t);
    const have = structs.get(key);
    if (have) return have;
    const fs = cfields(t).map((f) => `${ctype(f.type, where)} f_${f.name};`); // nested types are defined first
    const name = `sts_S${structs.size}`;
    structs.set(key, name);
    typedefs.push(`typedef struct { ${fs.join(" ")} } ${name};`);
    // JS <-> C conversion of the struct (boundary, D102). Keys are created in C field order (Q186).
    try {
      if (cfields(t).some((f) => noConv.has(ctype(f.type, where)))) throw new CUnsupported(where, "a nested struct without converters");
      const hs: string[] = [];
      hs.push(`static ${name} in_${name}(napi_value o) { ${name} r; ${cfields(t).map((f) => `r.f_${f.name} = ${inConv(f.type, `sts_get(o, "${f.name}")`, where)};`).join(" ")} return r; }`);
      hs.push(`static napi_value out_${name}(${name} v) { napi_value o; STS_OK(napi_create_object(sts_env, &o)); ${cfields(t).map((f) => `sts_set(o, "${f.name}", ${outConv(f.type, `v.f_${f.name}`, where)});`).join(" ")} return o; }`);
      hs.push(`static void wb_${name}(napi_value o, ${name} *v) { ${cfields(t).map((f) => (isStruct(f.type) && !isCopy(f.type) ? `wb_${ctype(f.type, where)}(sts_get(o, "${f.name}"), &v->f_${f.name});` : `sts_set(o, "${f.name}", ${outConv(f.type, `v->f_${f.name}`, where)});`)).join(" ")} }`);
      helpers.push(...hs);
    } catch (x) { if (!(x instanceof CUnsupported)) throw x; noConv.add(name); }
    return name;
  }

  /** Tagged union (and Result, Q043): a C union of its member structs, which all start with `kind` (D104). */
  function union(t: Extract<Type, { k: "union" }>, where: string): string {
    const key = ckey(t);
    const have = unions.get(key);
    if (have) return have;
    const ms = umembers(t).map((m) => ctype(m, where));
    const name = `sts_U${unions.size}`;
    unions.set(key, name);
    typedefs.push(`typedef union { int32_t kind; ${ms.map((m, i) => `${m} m${i};`).join(" ")} } ${name};`);
    const ks = umembers(t).map((m) => litId(kindOf(m)!));
    if (ms.some((m) => noConv.has(m))) { noConv.add(name); return name; }
    helpers.push(`static ${name} in_${name}(napi_value o) { ${name} r; int32_t k = sts_lit_in(sts_get(o, "kind")); ${ks.map((k, i) => `if (k == ${k}) { r.m${i} = in_${ms[i]}(o); return r; }`).join(" ")} sts_fail("bad union tag"); }`);
    helpers.push(`static napi_value out_${name}(${name} v) { ${ks.map((k, i) => `if (v.kind == ${k}) return out_${ms[i]}(v.m${i});`).join(" ")} sts_fail("bad union tag"); }`);
    return name;
  }
  /** `v` of union `from` as union `to` where their C types differ (#19): a wider union, a sub-union the checker
   * narrowed to, and `T | null` of those. Members move by `kind`; a kind `to` lacks cannot occur (the checker). */
  const cvts = new Set<string>();
  function cvt(v: string, from: Type, to: Type, where: string): string {
    const cf = ctype(from, where), ct = ctype(to, where);
    if (cf === ct) return v;
    const name = `cv_${cf}_${ct}`;
    if (!cvts.has(name)) {
      let body: string;
      if (nonNull(from) && nonNull(to)) body = `${ct} r = {0}; r.some = x.some; if (x.some) r.v = ${cvt("x.v", nonNull(from)!, nonNull(to)!, where)}; return r;`;
      else if (isTaggedUnion(from) && isTaggedUnion(to)) {
        const fm = umembers(from);
        body = `${ct} r; switch (x.kind) { ${fm.flatMap((m, i) => { const j = memberOf(to, kindOf(m)!); return j < 0 ? [] : [`case ${litId(kindOf(m)!)}: r.m${j} = x.m${i}; return r;`]; }).join(" ")} } sts_fail("bad union tag");`;
      } else throw new CUnsupported(where, `converting '${show(from)}' to '${show(to)}'`);
      cvts.add(name);
      helpers.push(`static ${ct} ${name}(${cf} x) { ${body} }`);
    }
    return `${name}(${v})`;
  }
  /** C string literal (octal escapes keep any byte valid). */
  const cstr = (x: string): string => `"${[...Buffer.from(x)].map((b) => (/[A-Za-z0-9_ :,.{}\[\]-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, "0")}`)).join("")}"`;
  /** Element size and the run-time kind string of a Vec / Slice element type (SPEC §10.2). */
  const eargs = (et: Type): string => `${layout(et)!.z}, ${cstr(elemDesc(et))}`;
  const packs = new Map<string, string>();
  /** ld_P / st_P: a value of `t` from / to its packed bytes `l` (SPEC §10.2, D105). */
  function packed(l: Lay, t: Type, where: string): string {
    const key = `${JSON.stringify(l)}|${show(t)}`;
    const have = packs.get(key);
    if (have) return have;
    const ct = ctype(t, where);
    let ld: string, st: string;
    switch (l.t) {
      case "num": ld = `return STS_LD(${ct}, p);`; st = `STS_ST(p, ${ct}, v);`; break;
      case "bool": ld = "return p[0] != 0;"; st = "p[0] = v ? 1 : 0;"; break;
      case "hdl": ld = "sts_handle r; memcpy(&r, p, 12); return r;"; st = "memcpy(p, &v, 12);"; break; // Q188 (a)
      case "abuf": ld = "sts_abuf r; memcpy(&r, p, 16); return r;"; st = "memcpy(p, &v, 16);"; break; // Q188 (b)
      case "lit": {
        const tb = `sts_L${packs.size}_${helpers.length}`;
        helpers.push(`static const int32_t ${tb}[] = {${l.v.map(litId).join(", ")}};`);
        ld = `return ${tb}[STS_LD(uint32_t, p)];`; st = `STS_ST(p, uint32_t, sts_lidx(${tb}, ${l.v.length}, v));`; break;
      }
      case "rec": {
        const r = t as Extract<Type, { k: "record" }>;
        const fs = l.f.map((f) => ({ ...f, p: packed(f.l, r.fields.find((x) => x.name === f.n)!.type, where) }));
        ld = `${ct} r; ${fs.map((f) => `r.f_${f.n} = ld_${f.p}(p + ${f.o});`).join(" ")} return r;`;
        st = fs.map((f) => `st_${f.p}(p + ${f.o}, v.f_${f.n});`).join(" ");
        break;
      }
      case "uni": {
        const u = t as Extract<Type, { k: "union" }>;
        const ms = l.m.map((m, i) => { const k = ((m as Extract<Lay, { t: "rec" }>).f[0]!.l as Extract<Lay, { t: "lit" }>).v[i]!; const j = memberOf(u, k); return { i, j, k, p: packed(m, umembers(u)[j]!, where) }; });
        ld = `${ct} r; switch (STS_LD(uint32_t, p)) { ${ms.map((m) => `case ${m.i}: r.m${m.j} = ld_${m.p}(p); return r;`).join(" ")} } sts_fail("bad union tag");`;
        st = `switch (v.kind) { ${ms.map((m) => `case ${litId(m.k)}: st_${m.p}(p, v.m${m.j}); return;`).join(" ")} } sts_fail("bad union tag");`;
        break;
      }
      case "opt": {
        const sub = packed(l.l, nonNull(t)!, where);
        ld = `${ct} r = {0}; r.some = p[0] != 0; if (r.some) r.v = ld_${sub}(p + ${l.o}); return r;`;
        st = `p[0] = v.some ? 1 : 0; if (v.some) st_${sub}(p + ${l.o}, v.v);`;
        break;
      }
    }
    const name = `P${packs.size}`;
    packs.set(key, name);
    helpers.push(`static ${ct} ld_${name}(const uint8_t *p) { ${ld} }`, `static void st_${name}(uint8_t *p, ${ct} v) { ${st} }`);
    return name;
  }
  const ptrPacks = new Map<string, string>();
  /** ld_Q / st_Q: a pointer value (Ptr / ConstPtr / CHandle) as 8 raw bytes (§14.4's layout for read / write). */
  function ptrPack(t: Type, where: string): string {
    const key = show(t);
    const have = ptrPacks.get(key);
    if (have) return have;
    const ct = ctype(t, where);
    const name = `sts_Q${ptrPacks.size}`;
    ptrPacks.set(key, name);
    helpers.push(`static ${ct} ld_${name}(const uint8_t *p) { ${ct} r; memcpy(&r, p, 8); return r; }`, `static void st_${name}(uint8_t *p, ${ct} v) { memcpy(p, &v, 8); }`);
    return name;
  }
  const isPtrLike = (t: Type): boolean => t.k === "gen" && (t.name === "Ptr" || t.name === "ConstPtr" || t.name === "CHandle");
  /** The ld/st pair for a Copy value's packed bytes: §10.2's layout, or ptrPack for a pointer value. */
  function packOf(t: Type, where: string): string {
    if (isPtrLike(t)) return ptrPack(t, where);
    const l = layout(t);
    if (!l) throw new CUnsupported(where, `'${show(t)}' has no byte layout`);
    return packed(l, t, where);
  }
  /** The byte size of a Copy value's packed form (§10.2, or 8 for a pointer value). */
  function packSize(t: Type, where: string): number {
    if (isPtrLike(t)) return 8;
    const l = layout(t);
    if (!l) throw new CUnsupported(where, `'${show(t)}' has no byte layout`);
    return l.z;
  }
  /** §14.4 (Q209): boxing a value that holds ring endpoints replaces each endpoint's obj
   * with a keep-alive reference (keep); unbox restores it. Statements on the value at `place`. */
  function boxFix(t: Type, place: string, keep: boolean, where: string): string[] {
    if (isGen(t, "RingTx") || isGen(t, "RingRx")) return [`${place}.obj = ${keep ? "sts_box_ref" : "sts_box_unref"}(${place}.obj);`];
    if (t.k === "record") return t.fields.flatMap((f) => boxFix(f.type, `${place}.f_${f.name}`, keep, where));
    if (t.k === "union" && isTaggedUnion(t)) {
      return umembers(t).flatMap((m, j) => {
        const inner = boxFix(m, `${place}.m${j}`, keep, where);
        return inner.length ? [`if (${place}.kind == ${litId(kindOf(m)!)}) { ${inner.join(" ")} }`] : [];
      });
    }
    return [];
  }
  /** Element access on a Vec / Slice data pointer: plain C arrays for numbers, ld_P / st_P otherwise. */
  function elem(et: Type, where: string): { z: string; ld: (d: string, i: string) => string; st: (d: string, i: string, v: string) => string } {
    const ce = ctype(et, where);
    if (et.k === "num") return { z: `sizeof(${ce})`, ld: (d, i) => `((${ce}*)${d})[${i}]`, st: (d, i, v) => `((${ce}*)${d})[${i}] = ${v};` };
    if (isPtrLike(et)) { const p = ptrPack(et, where), at = (d: string, i: string): string => `(uint8_t *)(${d}) + (size_t)(${i}) * 8`; return { z: "8", ld: (d, i) => `ld_${p}(${at(d, i)})`, st: (d, i, v) => `st_${p}(${at(d, i)}, ${v});` }; }
    const l = layout(et);
    if (!l) throw new CUnsupported(where, `${show(et)} (an element type without a byte layout, D105)`); // Pool<null>, Arena.alloc<null> (Q229)
    const p = packed(l, et, where), at = (d: string, i: string): string => `(uint8_t *)(${d}) + (size_t)(${i}) * ${l.z}`;
    return { z: `${l.z}`, ld: (d, i) => `ld_${p}(${at(d, i)})`, st: (d, i, v) => `st_${p}(${at(d, i)}, ${v});` };
  }
  /** Index of the member of tagged union `u` whose kind is `k`. */
  const memberOf = (u: Extract<Type, { k: "union" }>, k: string): number => umembers(u).findIndex((m) => kindOf(m) === k);

  function inConv(t: Type, v: string, where: string): string {
    if (t.k === "num") return `(${CNUM[t.name]})sts_num(${v})`;
    if (isBool(t)) return `sts_bool(${v})`;
    if (t.k === "lit" || (t.k === "union" && t.members.every((m) => m.k === "lit"))) { ctype(t, where); return `sts_lit_in(${v})`; }
    if (isStruct(t) || (t.k === "union" && isTaggedUnion(t))) return `in_${ctype(t, where)}(${v})`;
    if (isGen(t, "Vec")) { ctype(t, where); return `sts_vec_in(${v}, ${eargs(elemOf(t))})`; }
    if (isGen(t, "Pool")) { ctype(t, where); return `sts_pool_in(${v}, ${eargs(elemOf(t))})`; }
    if (isGen(t, "RingTx") || isGen(t, "RingRx")) { ctype(t, where); return `sts_ring_in(${v}, ${eargs(elemOf(t))})`; }
    if (isGen(t, "Ptr") || isGen(t, "ConstPtr")) { const ct = ctype(t, where); return `(${ct})sts_ptr_in(${v})`; }
    if (isGen(t, "CHandle")) return `sts_ptr_in(${v})`;
    if (isGen(t, "Handle")) return `sts_hdl_in(${v})`;
    if (isGen(t, "Arena")) { ctype(t, where); return `sts_arena_in(${v})`; }
    if (isGen(t, "ArenaBuf")) return `sts_abuf_in(${v})`;
    if (isGen(t, "Slice")) { ctype(t, where); return `sts_slice_in(${v}, ${eargs(elemOf(t))})`; }
    if (t.k === "opaque" && AUTH.has(t.name)) return v;
    if ((t as Type).k === "union" && nonNull(t)) { const n = ctype(t, where); return `({ napi_value x_ = ${v}; sts_isnull(x_) ? (${n}){ .some = false } : (${n}){ .some = true, .v = ${inConv(nonNull(t)!, "x_", where)} }; })`; }
    throw new CUnsupported(where, `passing '${show(t)}' between managed code and C`);
  }
  function outConv(t: Type, v: string, where: string): string {
    if (t.k === "num") return `sts_mknum((double)(${v}))`;
    if (isBool(t)) return `sts_mkbool(${v})`;
    if (t.k === "lit" || (t.k === "union" && t.members.every((m) => m.k === "lit"))) return `sts_mklit(${v})`;
    if (isStruct(t) || (t.k === "union" && isTaggedUnion(t))) return `out_${ctype(t, where)}(${v})`;
    if (isGen(t, "Vec")) return `(${v})->obj`;
    if (isGen(t, "Pool")) return `(${v})->obj`;
    if (isGen(t, "RingTx") || isGen(t, "RingRx")) return `(${v}).obj`;
    if (isGen(t, "Ptr") || isGen(t, "ConstPtr") || isGen(t, "CHandle")) return `sts_ptr_out((void *)(uintptr_t)(${v}))`;
    if (isGen(t, "Handle")) return `sts_hdl_out(${v})`;
    if (isGen(t, "Arena")) return `(${v})->obj`;
    if (isGen(t, "ArenaBuf")) return `sts_abuf_out(${v})`;
    if (t.k === "opaque" && AUTH.has(t.name)) return v;
    if ((t as Type).k === "union" && nonNull(t)) { const n = nonNull(t)!; ctype(t, where); return `((${v}).some ? ${outConv(n, `(${v}).v`, where)} : sts_mknull())`; }
    throw new CUnsupported(where, `passing '${show(t)}' between C and managed code`);
  }

  function proto(i: Inst): string {
    const where = `${i.f.mod.file}: ${i.f.name}`;
    const ps = i.f.decl.parameters.flatMap((p, k) => (unref(i.params[k]!).k === "fn" ? [] : [`${ctype(i.params[k]!, where)} u_${(p.name as ts.Identifier).text}`])); // Q189 (b): no runtime value
    return `static ${ctype(i.ret, where)} ${i.name}(${ps.join(", ") || "void"})`;
  }

  /** Node-API wrapper: decode the arguments, call, write `Mut` structs back, sync Vec lengths; a trap returns here by longjmp (D103). */
  function wrapper(i: Inst): string {
    const where = `${i.f.mod.file}: ${i.f.name}`;
    const n = i.params.filter((pt) => unref(pt).k !== "fn").length; // Q189 (b): function-typed parameters are not passed
    const lines: string[] = [];
    const frame: string[] = [], args: string[] = [], wb: string[] = [];
    let j = 0; // the argv position, counting runtime parameters only
    i.params.forEach((pt, k) => {
      if (unref(pt).k === "fn") return;
      const a = unref(pt), at = j++;
      if (borrowMode(pt) && isStruct(a)) {
        frame.push(`${ctype(a, where)} a${k};`);
        lines.push(`  fr->a${k} = ${inConv(a, `argv[${at}]`, where)};`);
        args.push(`&fr->a${k}`);
        if (borrowMode(pt) === "Mut") wb.push(`wb_${ctype(a, where)}(argv[${at}], &fr->a${k});`);
      } else {
        frame.push(`${ctype(pt, where)} a${k};`);
        lines.push(`  fr->a${k} = ${inConv(a, `argv[${at}]`, where)};`);
        args.push(`fr->a${k}`);
      }
    });
    const ret = i.ret;
    const isVoid = ret.k === "prim" && (ret.name === "void" || ret.name === "never");
    return [
      `static napi_value w_${i.name}(napi_env env, napi_callback_info info) {`,
      `  sts_env = env; sts_depth = 0; sts_err = 0; sts_nvecs = 0;`,
      `  size_t argc = ${n}; napi_value argv[${Math.max(n, 1)}]; napi_get_cb_info(env, info, &argc, argv, 0, 0);`,
      `  struct { int ok; ${frame.join(" ")} } *volatile fr = calloc(1, sizeof *fr);`,
      `  if (!fr) { sts_err = "out of memory"; return sts_throw(); }`, // no jump target yet, so not sts_fail
      `  if (setjmp(sts_jb)) { if (fr->ok) { fr->ok = 0; ${wb.join(" ")} } sts_vec_sync(); sts_pool_sync(); sts_arena_sync(); free(fr); return sts_throw(); }`,
      `  if (!sts_stack_lim) sts_stack_init();`, // after setjmp: its sts_fail jumps to sts_jb
      ...lines,
      `  fr->ok = 1;`,
      isVoid ? `  ${i.name}(${args.join(", ")});` : `  ${ctype(ret, where)} r = ${i.name}(${args.join(", ")});`,
      `  fr->ok = 0; ${wb.join(" ")}`,
      `  napi_value res = ${isVoid ? "0" : outConv(ret, "r", where)};`,
      `  if (!res) napi_get_undefined(env, &res);`,
      `  sts_vec_sync(); sts_pool_sync(); sts_arena_sync();`,
      `  { int fc, fp; if (sts_take_ftrap(&fc, &fp)) { sts_trap_code = fc; sts_trap_pos = fp; free(fr); return sts_throw(); } }`, // §15.4 (1): a foreign trap surfaces as this call returns
      `  free(fr); return res;`,
      `}`,
    ].join("\n");
  }

  class FnGen {
    f: FnSym; mod: Module; sf: ts.SourceFile; where: string; i: Inst;
    body: string[] = [];
    scopes: Map<string, Local>[] = [];
    tmp = 0; label = 0;
    loops: { cont: string }[] = [];
    ensures: ts.ArrowFunction[] = [];
    /** Inside a block-bodied ensures predicate: where its `return` goes. */
    pred: { v: string; end: string } | undefined;
    constructor(i: Inst) { this.i = i; this.f = i.f; this.mod = i.f.mod; this.sf = i.f.mod.sf; this.where = `${i.f.mod.file}: ${i.f.name}`; }

    run(): string {
      const f = this.f;
      this.scopes.push(new Map());
      f.decl.parameters.forEach((p, i) => {
        if (p.name.kind !== K.Identifier) throw this.no(p, "a destructured parameter");
        const t = this.i.params[i]!, a = unref(t);
        if (a.k === "fn") return; // Q189 (b): no runtime value; calls through it are resolved in `call`
        const name = (p.name as ts.Identifier).text;
        this.scopes[0]!.set(name, { c: borrowMode(t) && isStruct(a) ? `(*u_${name})` : `u_${name}`, t: a, ptr: false });
      });
      for (const s of f.decl.body!.statements) {
        if (s.kind === K.ExpressionStatement && (s as ts.ExpressionStatement).expression.kind === K.CallExpression) {
          const c = (s as ts.ExpressionStatement).expression as ts.CallExpression;
          if (c.expression.kind === K.Identifier && (c.expression as ts.Identifier).text === "ensures") { this.ensures.push(c.arguments[0] as ts.ArrowFunction); continue; }
        }
        this.stmt(s);
      }
      // Falling off the end: a void function checks its ensures; elsewhere the checker proved it unreachable (Q023).
      if (this.isVoid()) this.checkEnsures(undefined);
      else this.emit(`sts_fail("unreachable end of function");`);
      return `${proto(this.i)} {\n${this.body.join("\n")}\n}`;
    }
    isVoid(): boolean { return this.isVoidT(this.i.ret); }
    isVoidT(r: Type): boolean { return r.k === "prim" && (r.name === "void" || r.name === "never"); }

    /** §9.1: every ensures predicate, with `r` bound to `rv` (absent for void). */
    checkEnsures(rv: string | undefined): void {
      for (const a of this.ensures) {
        const p = a.parameters[0]?.name as ts.Identifier | undefined;
        this.emit("{");
        this.scopes.push(new Map(p && rv !== undefined ? [[p.text, { c: rv, t: this.i.ret, ptr: false }]] : []));
        let c: string;
        if (a.body.kind === K.Block) {
          c = `t${this.tmp++}`;
          const end = `sts_L${this.label++}`;
          this.emit(`bool ${c} = false;`);
          const saved = this.pred;
          this.pred = { v: c, end };
          this.block(() => { for (const x of (a.body as ts.Block).statements) this.stmt(x); });
          this.pred = saved;
          this.emit(`${end}: ;`);
        } else c = this.ex(a.body as ts.Expression);
        this.scopes.pop();
        this.emit(`if (!${c}) sts_trap(5, ${this.pos((a.parent as ts.CallExpression).expression)});`);
        this.emit("}");
      }
    }

    no(n: Node, what: string): CUnsupported { const p = this.mod.pf.position(n.getStart(this.sf)); return new CUnsupported(`${this.mod.file}:${p.line}:${p.col}`, what); }
    pos(n: Node): number {
      const p = this.mod.pf.position(n.getStart(this.sf));
      let fi = files.indexOf(this.mod.file);
      if (fi < 0) { files.push(this.mod.file); fi = files.length - 1; }
      poss.push(`{${fi},${p.line},${p.col}}`);
      return poss.length - 1;
    }
    emit(s: string): void { this.body.push(s); }
    t(type: Type, init: string, n: Node): string { const v = `t${this.tmp++}`; this.emit(`${ctype(type, this.where)} ${v} = ${init};`); void n; return v; }
    typeOf(n: Node): Type {
      let t = exprTypes.get(n) ?? (n.kind === K.Identifier ? this.lookup((n as ts.Identifier).text)?.t : undefined);
      if (!t && n.kind === K.PropertyAccessExpression) { // assignment targets have no recorded type
        const r = this.typeOf((n as ts.PropertyAccessExpression).expression);
        if (isStruct(r)) t = r.fields.find((f) => f.name === (n as ts.PropertyAccessExpression).name.text)?.type;
      }
      if (!t) throw this.no(n, "an expression without a type");
      return unref(this.i.m.size ? subst(t, this.i.m) : t);
    }
    lookup(name: string): Local | undefined { for (let i = this.scopes.length - 1; i >= 0; i--) { const l = this.scopes[i]!.get(name); if (l) return l; } return undefined; }
    block(f: () => void): void { this.emit("{"); this.scopes.push(new Map()); f(); this.scopes.pop(); this.emit("}"); }

    // ---- statements
    stmt(s: ts.Statement): void {
      switch (s.kind) {
        case K.ExpressionStatement: {
          const e = (s as ts.ExpressionStatement).expression;
          if (e.kind === K.StringLiteral) return; // directive
          if (e.kind === K.CallExpression && (e as ts.CallExpression).expression.kind === K.Identifier) {
            const c = e as ts.CallExpression, name = (c.expression as ts.Identifier).text;
            if (name === "requires" || name === "invariant") { const v = this.ex(c.arguments[0]!); this.emit(`if (!${v}) sts_trap(${name === "requires" ? 4 : 10}, ${this.pos(c.expression)});`); return; }
          }
          this.exVoid(e);
          return;
        }
        case K.VariableStatement: {
          for (const d of (s as ts.VariableStatement).declarationList.declarations) this.varDecl(d);
          return;
        }
        case K.Block: this.block(() => { for (const x of (s as ts.Block).statements) this.stmt(x); }); return;
        case K.IfStatement: {
          const i = s as ts.IfStatement;
          this.emit("{");
          const c = this.ex(i.expression);
          this.emit(`if (${c})`); this.block(() => this.stmt(i.thenStatement));
          if (i.elseStatement) { this.emit("else"); this.block(() => this.stmt(i.elseStatement!)); }
          this.emit("}");
          return;
        }
        case K.WhileStatement: {
          const w = s as ts.WhileStatement, cont = `sts_L${this.label++}`;
          this.emit("for (;;) {");
          this.emit(`${cont}: ;`);
          const c = this.ex(w.expression); this.emit(`if (!${c}) break;`);
          this.loops.push({ cont }); this.block(() => this.stmt(w.statement)); this.loops.pop();
          this.emit("}");
          return;
        }
        case K.DoStatement: {
          const w = s as ts.DoStatement, cont = `sts_L${this.label++}`;
          this.emit("for (;;) {");
          this.loops.push({ cont }); this.block(() => this.stmt(w.statement)); this.loops.pop();
          this.emit(`${cont}: ;`);
          const c = this.ex(w.expression); this.emit(`if (!${c}) break;`);
          this.emit("}");
          return;
        }
        case K.ForStatement: {
          const fo = s as ts.ForStatement, cont = `sts_L${this.label++}`;
          this.block(() => {
            if (fo.initializer) {
              if (fo.initializer.kind === K.VariableDeclarationList) for (const d of (fo.initializer as ts.VariableDeclarationList).declarations) this.varDecl(d);
              else this.exVoid(fo.initializer as ts.Expression);
            }
            this.emit("for (;;) {");
            if (fo.condition) { const c = this.ex(fo.condition); this.emit(`if (!${c}) break;`); }
            this.loops.push({ cont }); this.block(() => this.stmt(fo.statement)); this.loops.pop();
            this.emit(`${cont}: ;`);
            if (fo.incrementor) this.block(() => this.exVoid(fo.incrementor!));
            this.emit("}");
          });
          return;
        }
        case K.BreakStatement: this.emit("break;"); return;
        case K.ContinueStatement: this.emit(`goto ${this.loops.at(-1)!.cont};`); return;
        case K.ReturnStatement: {
          const r = s as ts.ReturnStatement;
          if (this.pred) { this.emit(`${this.pred.v} = ${this.ex(r.expression!)}; goto ${this.pred.end};`); return; }
          if (!r.expression) { this.checkEnsures(undefined); this.emit("return;"); return; }
          const want = this.i.ret;
          const v = this.conv(this.ex(r.expression), this.typeOf(r.expression), want);
          if (this.isVoid()) { this.checkEnsures(undefined); this.emit("return;"); return; }
          const rv = `t${this.tmp++}`;
          this.emit(`${ctype(want, this.where)} ${rv} = ${v};`);
          this.checkEnsures(rv);
          this.emit(`return ${rv};`);
          return;
        }
        case K.SwitchStatement: {
          const sw = s as ts.SwitchStatement;
          const dt = this.typeOf(sw.expression);
          const d = this.ex(sw.expression);
          const labels = sw.caseBlock.clauses.map((cl) => {
            if (cl.kind === K.DefaultClause) return undefined;
            const e = (cl as ts.CaseClause).expression;
            if (e.kind !== K.StringLiteral && e.kind !== K.TrueKeyword && e.kind !== K.FalseKeyword && e.kind !== K.NumericLiteral && !(e.kind === K.PrefixUnaryExpression && (e as ts.PrefixUnaryExpression).operand.kind === K.NumericLiteral)) throw this.no(e, "a non-literal case label");
            return this.ex(e);
          });
          const float = dt.k === "num" && !isInt(dt);
          if (float) { // C `case` needs integers: pick the clause with `==` (as `===`: NaN matches nothing, -0 matches 0), then switch on its index
            const sel = `t${this.tmp++}`;
            this.emit(`int ${sel} = -1;`);
            labels.forEach((l, i) => { if (l !== undefined) this.emit(`if (${sel} < 0 && ${d} == ${l}) ${sel} = ${i};`); });
            this.emit(`switch (${sel}) {`);
          } else this.emit(`switch (${d}) {`);
          for (const [i, cl] of sw.caseBlock.clauses.entries()) {
            if (cl.kind === K.DefaultClause) this.emit("default:");
            else this.emit(`case ${float ? i : labels[i]}:`);
            this.block(() => { for (const x of cl.statements) this.stmt(x); });
          }
          this.emit("}");
          return;
        }
      }
      throw this.no(s, `the statement kind ${K[s.kind]}`);
    }

    varDecl(d: ts.VariableDeclaration): void {
      const t0 = exprTypes.get(d.name);
      if (!t0) throw this.no(d, "a declaration without a recorded type");
      const t = this.i.m.size ? subst(t0, this.i.m) : t0; // inside a generic instance (D104)
      const v = this.conv(this.ex(d.initializer!), this.typeOf(d.initializer!), t);
      if (d.name.kind === K.Identifier) {
        const name = (d.name as ts.Identifier).text, c = `u_${name}_${this.tmp++}`;
        this.emit(`${ctype(t, this.where)} ${c} = ${v};`);
        this.scopes.at(-1)!.set(name, { c, t, ptr: false });
        return;
      }
      const src = this.t(t, v, d); // `const { x, y } = s`: whole-value move, then fields
      for (const el of (d.name as ts.ObjectBindingPattern).elements) {
        const prop = (el.propertyName ?? el.name) as ts.Identifier, name = (el.name as ts.Identifier).text, ft = ((x: Type): Type => (this.i.m.size ? subst(x, this.i.m) : x))(exprTypes.get(el.name!)!);
        const c = `u_${name}_${this.tmp++}`;
        this.emit(`${ctype(ft, this.where)} ${c} = ${src}.f_${prop.text};`);
        this.scopes.at(-1)!.set(name, { c, t: ft, ptr: false });
      }
    }

    /** Value of type `from` stored where `to` is expected: wraps into / out of `T | null`. */
    conv(v: string, from: Type, to0: Type): string {
      const to = unref(to0);
      if (from.k === "prim" && from.name === "never" && !(to.k === "prim" && (to.name === "never" || to.name === "void"))) return `((${ctype(to, this.where)}){0})`; // D140: dead path after a trap, but still a typed value
      if (to.k === "union" && isTaggedUnion(to) && from.k === "record") { // a member into its union
        const i = memberOf(to, kindOf(from)!);
        return `((${ctype(to, this.where)}){ .m${i} = ${v} })`;
      }
      if (to.k === "union" && nonNull(to) && !(from.k === "union" && from.members.some(isNull))) {
        const n = ctype(to, this.where);
        return isNull(from) ? `((${n}){ .some = false })` : `((${n}){ .some = true, .v = ${this.conv(v, from, nonNull(to)!)} })`; // a member goes into its union first
      }
      if (to.k === "union" && from.k === "union" && (isTaggedUnion(to) || nonNull(to))) return cvt(v, from, to, this.where);
      return v;
    }

    exVoid(e: ts.Expression): void {
      if (e.kind === K.ParenthesizedExpression) { this.exVoid((e as ts.ParenthesizedExpression).expression); return; }
      const t = exprTypes.get(e);
      if (t && t.k === "prim" && (t.name === "void" || t.name === "never")) {
        if (e.kind === K.ConditionalExpression) { // `c ? f() : g()` of void calls: the chosen branch as a statement
          const c = e as ts.ConditionalExpression, k = this.ex(c.condition);
          this.emit(`if (${k})`); this.block(() => this.exVoid(c.whenTrue));
          this.emit("else"); this.block(() => this.exVoid(c.whenFalse));
          return;
        }
        this.call(e as ts.CallExpression, true);
        return;
      }
      this.ex(e);
    }

    // ---- expressions: each returns a C expression without side effects (a temporary, a literal or a local)
    ex(e: ts.Expression): string {
      switch (e.kind) {
        case K.ParenthesizedExpression: return this.ex((e as ts.ParenthesizedExpression).expression);
        case K.NumericLiteral: return this.lit(numText(e as ts.NumericLiteral), this.typeOf(e));
        case K.TrueKeyword: return "true";
        case K.StringLiteral: case K.NoSubstitutionTemplateLiteral: return `((int32_t)${litId((e as ts.StringLiteral).text)})`; // Q043: a `kind` value
        case K.FalseKeyword: return "false";
        case K.NullKeyword: return "((sts_null){ false })";
        case K.Identifier: return this.ident(e as ts.Identifier);
        case K.PrefixUnaryExpression: return this.prefix(e as ts.PrefixUnaryExpression);
        case K.BinaryExpression: return this.binary(e as ts.BinaryExpression);
        case K.PropertyAccessExpression: return this.prop(e as ts.PropertyAccessExpression);
        case K.ElementAccessExpression: {
          const a = e as ts.ElementAccessExpression;
          const { data, len, et } = this.seq(a.expression);
          const i = this.ex(a.argumentExpression);
          this.emit(`sts_chk(${i}, ${len}, ${this.pos(a.argumentExpression)});`);
          return this.t(et, elem(et, this.where).ld(data, i), e);
        }
        case K.CallExpression: return this.call(e as ts.CallExpression, false)!;
        case K.ConditionalExpression: {
          const c = e as ts.ConditionalExpression, t = this.typeOf(e);
          const r = `t${this.tmp++}`;
          this.emit(`${ctype(t, this.where)} ${r};`);
          const k = this.ex(c.condition);
          this.emit(`if (${k})`); this.block(() => this.emit(`${r} = ${this.conv(this.ex(c.whenTrue), this.typeOf(c.whenTrue), t)};`));
          this.emit("else"); this.block(() => this.emit(`${r} = ${this.conv(this.ex(c.whenFalse), this.typeOf(c.whenFalse), t)};`));
          return r;
        }
        case K.ObjectLiteralExpression: return this.object(e as ts.ObjectLiteralExpression);
      }
      throw this.no(e, `the expression kind ${K[e.kind]}`);
    }

    lit(x: number, t: Type): string {
      if (t.k !== "num") throw new CUnsupported(this.where, `a literal of type ${show(t)}`);
      if (isInt(t)) return `((${CNUM[t.name]})${x}LL)`;
      const s = !Number.isFinite(x) ? (x > 0 ? "INFINITY" : "(-INFINITY)") : Object.is(x, -0) ? "-0.0" : /[.e]/.test(`${x}`) ? `${x}` : `${x}.0`; // 1e999 is Infinity in JS
      return t.name === "f32" ? `((float)${s})` : s;
    }

    ident(id: ts.Identifier): string {
      const l = this.lookup(id.text);
      if (l) return this.t(this.typeOf(id), this.narrow(l.c, l.t, this.typeOf(id)), id); // a snapshot: a later operand may assign the local (D103, Q172)
      const sym = resolveConst(this.mod, id.text);
      if (sym) { // §1: a literal, or a record literal of literals; translated at each use (D104)
        const saved = [this.mod, this.sf] as const;
        this.mod = sym.mod; this.sf = sym.mod.sf;
        try {
          if (sym.bind) { // Q225 (b): `const { a }: T = { a: 1 }` is the property `a` of the initializer's record literal
            const key = ((sym.bind.propertyName ?? sym.bind.name) as ts.Identifier).text;
            const prop = (sym.decl.initializer as ts.ObjectLiteralExpression).properties.find((p) => p.kind === K.PropertyAssignment && (p.name as ts.Identifier | ts.StringLiteral).text === key) as ts.PropertyAssignment | undefined;
            if (!prop) throw this.no(id, `the destructured constant '${id.text}'`);
            return this.conv(this.ex(prop.initializer), this.typeOf(prop.initializer), sym.type);
          }
          return this.conv(this.ex(sym.decl.initializer!), this.typeOf(sym.decl.initializer!), sym.type);
        } finally { [this.mod, this.sf] = saved; }
      }
      throw this.no(id, `the name '${id.text}' here`);
    }

    /** Vec / Slice operand: its data pointer, length and element type. */
    seq(e: ts.Expression): { data: string; len: string; et: Type; vec?: string; slice?: string } {
      const t = this.typeOf(e);
      const et = elemOf(t);
      ctype(t, this.where);
      const v = this.ex(e);
      if (isGen(t, "Vec")) return { data: `${v}->data`, len: `${v}->len`, et, vec: v };
      return { data: `${v}.data`, len: `${v}.len`, et, slice: v };
    }

    prefix(u: ts.PrefixUnaryExpression): string {
      const t = this.typeOf(u);
      if (u.operator === K.MinusToken && u.operand.kind === K.NumericLiteral) return this.lit(-numText(u.operand as ts.NumericLiteral), t);
      const v = this.ex(u.operand);
      switch (u.operator) {
        case K.ExclamationToken: return this.t(t, `!${v}`, u);
        case K.TildeToken: return this.t(t, `~${v}`, u);
        case K.MinusToken:
          if (t.k === "num" && isInt(t)) { const [lo, hi] = RANGE[t.name]!; return this.t(t, `(${CNUM[t.name]})sts_rng(-(int64_t)${v}, ${lo}, ${hi}, ${this.pos(u)})`, u); }
          return this.t(t, `-${v}`, u);
      }
      throw this.no(u, "this prefix operator");
    }

    /** `l op r` on numbers (both already evaluated). */
    arith(t: Type, o: string, l: string, r: string, anchor: Node): string {
      if (t.k !== "num") throw this.no(anchor, `'${o}' on ${show(t)}`);
      const c = CNUM[t.name];
      if (isInt(t)) {
        const [lo, hi] = RANGE[t.name]!;
        switch (o) {
          // the builtins check the exact result against the range of `c`; unlike a widened compare they keep loop-carried values in registers (D108)
          case "+": case "-": case "*": void lo; void hi; return `STS_AOP(${o === "+" ? "add" : o === "-" ? "sub" : "mul"}, ${c}, ${l}, ${r}, ${this.pos(anchor)})`;
          case "&": case "|": case "^": return `(${c})(${l} ${o} ${r})`;
          case "<<": return t.name === "i32" ? `(int32_t)((uint32_t)${l} << sts_amt(${r}, ${this.pos(anchor)}))` : `(uint32_t)(${l} << sts_amt(${r}, ${this.pos(anchor)}))`;
          case ">>": case ">>>": return `(${c})(${l} >> sts_amt(${r}, ${this.pos(anchor)}))`;
        }
      } else {
        switch (o) {
          case "+": case "-": case "*": case "/": return `(${c})(${l} ${o} ${r})`;
          case "%": return `(${c})fmod(${l}, ${r})`;
        }
      }
      throw this.no(anchor, `the operator '${o}'`);
    }

    binary(b: ts.BinaryExpression): string {
      const k = b.operatorToken.kind, o = b.operatorToken.getText(this.sf);
      if (k === K.AmpersandAmpersandToken || k === K.BarBarToken) {
        const r = `t${this.tmp++}`;
        this.emit(`bool ${r} = ${this.ex(b.left)};`);
        this.emit(`if (${k === K.BarBarToken ? "!" : ""}${r})`); this.block(() => this.emit(`${r} = ${this.ex(b.right)};`));
        return r;
      }
      if (k === K.QuestionQuestionToken) { // `a ?? b`: `b` runs only when `a` is null
        const t = this.typeOf(b), lt = this.typeOf(b.left);
        const l = this.ex(b.left), r = `t${this.tmp++}`;
        this.emit(`${ctype(t, this.where)} ${r};`);
        this.emit(`if (${l}.some)`); this.block(() => this.emit(`${r} = ${this.conv(`${l}.v`, nonNull(lt)!, t)};`));
        this.emit("else"); this.block(() => this.emit(`${r} = ${this.conv(this.ex(b.right), this.typeOf(b.right), t)};`));
        return r;
      }
      if (k === K.EqualsToken) return this.assign(b, undefined);
      const COMP: Partial<Record<K, string>> = { [K.PlusEqualsToken]: "+", [K.MinusEqualsToken]: "-", [K.AsteriskEqualsToken]: "*", [K.SlashEqualsToken]: "/", [K.PercentEqualsToken]: "%" };
      if (COMP[k]) return this.assign(b, COMP[k]);
      if (k === K.EqualsEqualsEqualsToken || k === K.ExclamationEqualsEqualsToken) {
        const lt = this.typeOf(b.left), rt = this.typeOf(b.right);
        const neg = k === K.ExclamationEqualsEqualsToken;
        if (isNull(rt) || isNull(lt)) { // `x === null`
          const side = isNull(rt) ? b.left : b.right;
          const v = this.ex(side);
          return this.t({ k: "prim", name: "boolean" }, `${neg ? "" : "!"}${v}.some`, b);
        }
        const ln = lt.k === "union" && !!nonNull(lt), rn = rt.k === "union" && !!nonNull(rt);
        if (ln || rn) { // Q017: `T | null` against `T` (or both nullable)
          const l = this.ex(b.left), r = this.ex(b.right);
          const L = ln ? `${l}.v` : l, R = rn ? `${r}.v` : r;
          const eq = ln && rn ? `(${l}.some == ${r}.some && (!${l}.some || ${L} == ${R}))` : `(${ln ? `${l}.some` : `${r}.some`} && ${L} == ${R})`;
          return this.t({ k: "prim", name: "boolean" }, neg ? `!${eq}` : eq, b);
        }
      }
      const t = this.typeOf(b);
      const l = this.ex(b.left), r = this.ex(b.right);
      const CMP: Partial<Record<K, string>> = { [K.LessThanToken]: "<", [K.LessThanEqualsToken]: "<=", [K.GreaterThanToken]: ">", [K.GreaterThanEqualsToken]: ">=", [K.EqualsEqualsEqualsToken]: "==", [K.ExclamationEqualsEqualsToken]: "!=" };
      if (CMP[k]) return this.t(t, `${l} ${CMP[k]} ${r}`, b);
      return this.t(t, this.arith(t, o, l, r, b.operatorToken), b);
    }

    /** `x = e` / `x op= e` (D103 order). The value of the expression is the stored value. */
    assign(b: ts.BinaryExpression, op: string | undefined): string {
      const left = assignTarget(b.left); // Q133
      if (left.kind === K.ElementAccessExpression) {
        const a = left as ts.ElementAccessExpression;
        const { data, len, et } = this.seq(a.expression);
        const i = this.ex(a.argumentExpression), ip = this.pos(a.argumentExpression);
        const el = elem(et, this.where);
        if (op) {
          this.emit(`sts_chk(${i}, ${len}, ${ip});`);
          const cur = this.t(et, el.ld(data, i), a);
          const r = this.ex(b.right);
          const nv = this.t(et, this.arith(et, op, cur, r, b.operatorToken), b);
          this.emit(el.st(data, i, nv));
          return nv;
        }
        const r = this.t(et, this.conv(this.ex(b.right), this.typeOf(b.right), et), b);
        this.emit(`sts_chk(${i}, ${len}, ${ip});`);
        this.emit(el.st(data, i, r));
        return r;
      }
      const p = this.place(left);
      const lt = this.typeOf(left);
      if (op) {
        const cur = this.t(lt, p, left);
        const r = this.ex(b.right);
        const nv = this.t(lt, this.arith(lt, op, cur, r, b.operatorToken), b);
        this.emit(`${p} = ${nv};`);
        return nv;
      }
      const decl = left.kind === K.Identifier ? this.lookup((left as ts.Identifier).text)?.t : undefined;
      const v = this.conv(this.ex(b.right), this.typeOf(b.right), decl ?? lt);
      this.emit(`${p} = ${v};`);
      return this.t(lt, p, b);
    }

    /** A local of declared type `decl` read where the checker narrowed it to `now`: `T | null` -> `.v`, a union -> its member. */
    narrow(c: string, decl: Type, now: Type): string {
      if (decl.k !== "union") return c;
      if (isNull(now)) return "((sts_null){ false })"; // `T | null` narrowed to `null`
      const inner = nonNull(decl);
      if (inner) {
        if (now.k === "union" && now.members.some(isNull)) return cvt(c, decl, now, this.where); // still `T | null`
        return this.narrow(`${c}.v`, inner, now);
      }
      if (!isTaggedUnion(decl)) return c; // a literal union narrowed to one literal keeps its id
      if (now.k === "union") return cvt(c, decl, now, this.where); // a sub-union (a `switch` with several labels)
      return `${c}.m${memberOf(decl, kindOf(now)!)}`;
    }

    /** An lvalue: a local, or a field path from one (`s.a.b`, `(*u_m).x`). `read`: narrowed locals read as their narrowed type. */
    place(e: ts.Expression, read = false): string {
      if (e.kind === K.ParenthesizedExpression) return this.place((e as ts.ParenthesizedExpression).expression, read);
      if (e.kind === K.Identifier) { const l = this.lookup((e as ts.Identifier).text); if (l) return read ? this.narrow(l.c, l.t, this.typeOf(e)) : l.c; }
      if (e.kind === K.PropertyAccessExpression) {
        const p = e as ts.PropertyAccessExpression;
        const pt = this.typeOf(p.expression);
        if (isStruct(pt)) {
          const c = `${this.place(p.expression, read)}.f_${p.name.text}`, ft = pt.fields.find((f) => f.name === p.name.text)?.type;
          return read && ft ? this.narrow(c, ft, this.typeOf(e)) : c; // a `T | null` field the checker narrowed (`h.p !== null`)
        }
      }
      throw this.no(e, "this assignment target or borrowed place");
    }

    prop(p: ts.PropertyAccessExpression): string {
      const name = p.name.text;
      if (p.expression.kind === K.Identifier && !this.lookup((p.expression as ts.Identifier).text) && (p.expression as ts.Identifier).text === "Math") {
        if (name === "PI") return "3.141592653589793"; if (name === "E") return "2.718281828459045";
      }
      const rt = this.typeOf(p.expression);
      if ((isGen(rt, "Vec") || isGen(rt, "Slice")) && name === "length") { const s = this.seq(p.expression); return this.t({ k: "num", name: "usize" }, s.len, p); }
      if (isGen(rt, "Pool") && (name === "length" || name === "capacity")) return this.t({ k: "num", name: "usize" }, `${this.ex(p.expression)}->${name === "length" ? "len" : "cap"}`, p);
      if (isGen(rt, "Arena") && name === "remaining") { const a = this.ex(p.expression); return this.t({ k: "num", name: "usize" }, `${a}->cap - ${a}->used`, p); }
      if (isGen(rt, "ArenaBuf") && name === "length") return this.t({ k: "num", name: "usize" }, `${this.ex(p.expression)}.len`, p);
      if (isStruct(rt)) {
        const t = this.typeOf(p);
        const base = this.placeOrValue(p.expression), ft = rt.fields.find((f) => f.name === name)?.type;
        return this.t(t, ft ? this.narrow(`${base}.f_${name}`, ft, t) : `${base}.f_${name}`, p);
      }
      if (rt.k === "union" && isTaggedUnion(rt) && name === "kind") return this.t(this.typeOf(p), `${this.placeOrValue(p.expression)}.kind`, p);
      if (rt.k === "opaque" && AUTH.has(rt.name)) return this.t(this.typeOf(p), `sts_get(${this.ex(p.expression)}, "${name}")`, p); // sys.alloc etc.
      throw this.no(p, `the member '${name}'`);
    }
    placeOrValue(e: ts.Expression): string {
      try { return this.place(e, true); } catch (x) { if (x instanceof CUnsupported) return this.ex(e); throw x; }
    }

    object(o: ts.ObjectLiteralExpression): string {
      const t = this.typeOf(o);
      if (!isStruct(t)) throw this.no(o, `an object literal of type ${show(t)}`);
      const name = ctype(t, this.where);
      const r = `t${this.tmp++}`;
      this.emit(`${name} ${r};`);
      for (const pr of o.properties) {
        if (pr.kind === K.SpreadAssignment) {
          const se = (pr as ts.SpreadAssignment).expression, st = unref(this.typeOf(se)), sv = this.ex(se);
          if (!isStruct(st) || ctype(st, this.where) === name) { this.emit(`${r} = ${sv};`); continue; }
          const s = `t${this.tmp++}`; // D140: another C struct type (fewer fields, other readonly): copy field by field
          this.emit(`${ctype(st, this.where)} ${s} = ${sv};`);
          for (const sf of st.fields) { const f = t.fields.find((x) => x.name === sf.name); if (f) this.emit(`${r}.f_${f.name} = ${this.conv(`${s}.f_${f.name}`, sf.type, f.type)};`); }
          continue;
        }
        if (pr.kind === K.ShorthandPropertyAssignment) { const n = (pr as ts.ShorthandPropertyAssignment).name as ts.Identifier; const f = t.fields.find((x) => x.name === n.text)!; this.emit(`${r}.f_${n.text} = ${this.conv(this.ident(n), this.typeOf(n), f.type)};`); continue; }
        if (pr.kind !== K.PropertyAssignment) throw this.no(pr, "this object literal member");
        const pa = pr as ts.PropertyAssignment, f = t.fields.find((x) => x.name === (pa.name as ts.Identifier).text)!;
        this.emit(`${r}.f_${f.name} = ${this.conv(this.ex(pa.initializer), this.typeOf(pa.initializer), f.type)};`);
      }
      return r;
    }

    /** Calls. `stmt`: a void call in statement position. */
    call(e: ts.CallExpression, stmt: boolean): string | undefined {
      const callee = e.expression;
      const t = exprTypes.get(e) ? this.typeOf(e) : { k: "prim", name: "void" } as Type;
      const num = t.k === "num" ? t : undefined;
      if (callee.kind === K.Identifier) {
        const name = (callee as ts.Identifier).text;
        if (!this.lookup(name)) {
          if (num && (CNUM as Record<string, string>)[name] && name === num.name) {
            const at = this.typeOf(e.arguments[0]!), v = this.ex(e.arguments[0]!);
            if (!isInt(num)) return this.t(num, `(${CNUM[num.name]})${v}`, e);
            const [lo, hi] = RANGE[num.name]!;
            return this.t(num, `(${CNUM[num.name]})${isInt(at) ? "sts_cvti" : "sts_cvt"}(${v}, ${lo}, ${hi}, ${this.pos(callee)})`, e);
          }
          switch (name) {
            case "wrapAdd": case "wrapSub": case "wrapMul": {
              const a = this.ex(e.arguments[0]!), b = this.ex(e.arguments[1]!), [lo, hi] = RANGE[num!.name]!;
              const r = name === "wrapMul" ? (["i32", "u32", "usize"].includes(num!.name) ? `sts_wmul32(${a}, ${b}, ${lo}, ${hi})` : `sts_wrap((int64_t)${a} * ${b}, ${lo}, ${hi})`)
                : `sts_wrap((int64_t)${a} ${name === "wrapAdd" ? "+" : "-"} (int64_t)${b}, ${lo}, ${hi})`;
              return this.t(num!, `(${CNUM[num!.name]})${r}`, e);
            }
            case "divTrunc": case "rem": {
              const a = this.ex(e.arguments[0]!), b = this.ex(e.arguments[1]!);
              return this.t(num!, `STS_${name === "rem" ? "REM" : "DIV"}(${CNUM[num!.name]}, ${a}, ${b}, ${this.pos(callee)})`, e); // in the operand type, so loops can vectorize (D108)
            }
            case "cfn": { // §14.6: the trampoline for a module-level rt function, as a Ptr to it
              const a = e.arguments[0]!;
              if (a.kind !== K.Identifier) throw this.no(a, "'cfn' of a non-name");
              const fn = resolveFn(this.mod, (a as ts.Identifier).text);
              if (!fn) throw this.no(a, "'cfn' of an unknown function");
              return this.t(t, trampoline(fn, this.where), e);
            }
            case "panic": this.emit(`sts_trap(6, ${this.pos(callee)});`); return stmt ? undefined : "0";
            case "ok": case "err": { // Result (Q043): a member of the union
              if (t.k !== "union" || !isTaggedUnion(t)) throw this.no(e, `'${name}' of type ${show(t)}`);
              const v = this.ex(e.arguments[0]!), i = memberOf(t, name), mt = umembers(t)[i] as Extract<Type, { k: "record" }>;
              const f = mt.fields.find((x) => x.name !== "kind")!;
              return this.t(t, `((${ctype(t, this.where)}){ .m${i} = { .f_kind = ${litId(name)}, .f_${f.name} = ${this.conv(v, this.typeOf(e.arguments[0]!), f.type)} } })`, e);
            }
          }
          const cbi = this.f.decl.parameters.findIndex((p, k) => unref(this.i.params[k]!).k === "fn" && p.name.kind === K.Identifier && (p.name as ts.Identifier).text === name);
          if (cbi >= 0) { // Q189 (b): a call through a function-typed parameter
            const target = this.i.fns.get(cbi);
            if (!target) throw this.no(callee, `the unspecialized function parameter '${name}'`);
            return this.userCall(e, target, stmt);
          }
          const fn = resolveFn(this.mod, name);
          if (fn) return this.userCall(e, fn, stmt);
          const cf = resolveCFn(this.mod, name);
          if (cf) return this.cCall(e, cf, stmt);
        }
        throw this.no(callee, `calling '${name}'`);
      }
      if (callee.kind !== K.PropertyAccessExpression) throw this.no(callee, "this callee");
      const p = callee as ts.PropertyAccessExpression, m = p.name.text;
      if (p.expression.kind === K.Identifier && !this.lookup((p.expression as ts.Identifier).text)) {
        const ns = (p.expression as ts.Identifier).text;
        if (ns === "Math") {
          const as = e.arguments.map((a) => this.ex(a));
          const F: Record<string, string> = { abs: "fabs", sqrt: "sqrt", floor: "floor", ceil: "ceil", trunc: "trunc", round: "sts_round", sign: "sts_sign" };
          if (F[m]) return this.t(t, `${F[m]}(${as[0]})`, e);
          if (m === "fround") return this.t(t, `(float)${as[0]}`, e);
          if (m === "min" || m === "max") { let acc = as[0]!; for (const x of as.slice(1)) acc = this.t(t, `sts_${m}(${acc}, ${x})`, e); return acc; }
        }
        if (ns === "DetMath") { // §12 (Q191): a direct call of the bundled module's rt function
          const dm = prog.mods.find((x) => x.pf.path === DETMATH_PATH);
          const fn = dm ? resolveFn(dm, m) : undefined;
          if (!fn) throw this.no(p.name, `'DetMath.${m}'`);
          return this.userCall(e, fn, stmt);
        }
        if (ns === "Vec" && m === "create") {
          const el = elemOf(t);
          ctype(t, this.where);
          const a = this.ex(e.arguments[0]!), n = this.ex(e.arguments[1]!);
          return this.t(t, `sts_vec_create(${a}, ${n}, ${cstr(elemDesc(el))}, ${layout(el)!.z}, ${this.pos(p.name)})`, e);
        }
        if (ns === "Pool" && m === "create") {
          const el = elemOf(t);
          ctype(t, this.where);
          const a = this.ex(e.arguments[0]!), n = this.ex(e.arguments[1]!);
          return this.t(t, `sts_pool_create(${a}, ${n}, ${cstr(elemDesc(el))}, ${layout(el)!.z}, ${this.pos(p.name)})`, e);
        }
        if (ns === "Arena" && m === "create") {
          ctype(t, this.where);
          const a = this.ex(e.arguments[0]!), n = this.ex(e.arguments[1]!);
          return this.t(t, `sts_arena_create(${a}, ${n}, ${this.pos(p.name)})`, e);
        }
        if (ns === "Ring" && m === "create") {
          const pair = ctype(t, this.where); // registers the pair Struct and its in_ conversion
          const txf = t.k === "record" ? t.fields.find((f) => f.name === "tx")?.type : undefined;
          const el = txf?.k === "gen" ? txf.args[0]! : elemOf(t);
          const a = this.ex(e.arguments[0]!), n = this.ex(e.arguments[1]!);
          return this.t(t, `in_${pair}(sts_ring_create(${a}, ${n}, ${cstr(elemDesc(el))}, ${this.pos(p.name)}))`, e);
        }
        if (ns === "Ptr" && m === "box") { // §14.4 (Q209): a Copy value is stored packed (§10.2), an owned value in its C form
          this.ex(e.arguments[0]!); // the Alloc is a capability only; C needs nothing of it
          const vt = elemOf(t);
          const xv = this.t(vt, this.conv(this.ex(e.arguments[1]!), this.typeOf(e.arguments[1]!), vt), e);
          const pos = this.pos(p.name), b = `t${this.tmp++}`;
          if (isCopy(vt)) {
            this.emit(`uint8_t *${b} = malloc(${packSize(vt, this.where)}); if (!${b}) sts_trap(6, ${pos});`);
            this.emit(`st_${packOf(vt, this.where)}(${b}, ${xv});`);
          } else {
            const ct = ctype(vt, this.where);
            this.emit(`${ct} *${b} = malloc(sizeof(${ct})); if (!${b}) sts_trap(6, ${pos});`);
            this.emit(`*${b} = ${xv};`);
            for (const fx of boxFix(vt, `(*${b})`, true, this.where)) this.emit(fx);
          }
          return this.t(t, `(${ctype(t, this.where)})${b}`, e);
        }
        if (ns === "CHandle" && m === "create") { // §14.5: no allocation; the handle is the pointer itself
          return this.t(t, this.ex(e.arguments[0]!), e);
        }
        throw this.no(p.name, `'${ns}.${m}'`);
      }
      const rt = this.typeOf(p.expression);
      if (rt.k === "opaque" && AUTH.has(rt.name)) { // Q040: an authority's method calls back into the JS host
        const o = this.ex(p.expression);
        const as = e.arguments.map((a) => outConv(this.typeOf(a), this.ex(a), this.where));
        const arr = `t${this.tmp++}`;
        this.emit(`napi_value ${arr}[${Math.max(as.length, 1)}] = {${as.join(", ") || "0"}};`);
        const r = `sts_callm(${o}, "${m}", ${as.length}, ${arr})`;
        if (this.isVoidT(t)) { this.emit(`${r};`); return stmt ? undefined : "0"; }
        return this.t(t, inConv(t, r, this.where), e);
      }
      if (isGen(rt, "Pool")) {
        const et = elemOf(rt), el = elem(et, this.where);
        const pv = `t${this.tmp++}`;
        this.emit(`sts_pool *${pv} = ${this.ex(p.expression)};`);
        const chk = (h: string): void => this.emit(`if (!sts_pool_valid(${pv}, ${h})) sts_trap(11, ${this.pos(p.name)});`); // T011 at the member name (Q188 (a))
        switch (m) {
          case "insert": {
            const x = this.t(et, this.conv(this.ex(e.arguments[0]!), this.typeOf(e.arguments[0]!), et), e);
            const n = ctype(t, this.where), r = `t${this.tmp++}`;
            this.emit(`${n} ${r};`);
            this.emit(`if (${pv}->len >= ${pv}->cap) { ${r}.some = false; } else { uint32_t pi; if (${pv}->freeHead >= 0) { pi = (uint32_t)${pv}->freeHead; ${pv}->freeHead = ${pv}->nextFree[pi]; ${pv}->gens[pi] += 1; } else pi = (uint32_t)${pv}->nextFresh++; ${pv}->occ[pi] = 1; ${el.st(`${pv}->data`, "pi", x)} ${pv}->len++; ${r}.some = true; ${r}.v.pool = ${pv}->id; ${r}.v.gen = ${pv}->gens[pi]; ${r}.v.idx = pi; }`);
            return this.t(t, r, e);
          }
          case "get": { const h = this.ex(e.arguments[0]!); chk(h); return this.t(t, el.ld(`${pv}->data`, `${h}.idx`), e); }
          case "set": {
            const h = this.ex(e.arguments[0]!);
            const x = this.t(et, this.conv(this.ex(e.arguments[1]!), this.typeOf(e.arguments[1]!), et), e);
            chk(h);
            this.emit(el.st(`${pv}->data`, `${h}.idx`, x));
            return stmt ? undefined : "0";
          }
          case "remove": {
            const h = this.ex(e.arguments[0]!);
            chk(h);
            const ct = ctype(et, this.where), r = `t${this.tmp++}`;
            this.emit(`${ct} ${r} = ${el.ld(`${pv}->data`, `${h}.idx`)};`);
            this.emit(`${pv}->occ[${h}.idx] = 0; ${pv}->nextFree[${h}.idx] = (int32_t)${pv}->freeHead; ${pv}->freeHead = ${h}.idx; ${pv}->len--;`);
            return this.t(t, r, e);
          }
          case "has": { const h = this.ex(e.arguments[0]!); return this.t(t, `sts_pool_valid(${pv}, ${h})`, e); }
        }
        throw this.no(p.name, `the method '${m}' on ${show(rt)}`);
      }
      if (isGen(rt, "Arena")) {
        const pv = `t${this.tmp++}`;
        this.emit(`sts_arena *${pv} = ${this.ex(p.expression)};`);
        switch (m) {
          case "alloc": {
            const et = elemOf(nonNull(t)!), el = elem(et, this.where), lay = layout(et)!;
            const n = this.ex(e.arguments[0]!);
            const x = this.t(et, this.conv(this.ex(e.arguments[1]!), this.typeOf(e.arguments[1]!), et), e);
            const nct = ctype(t, this.where), r = `t${this.tmp++}`;
            this.emit(`${nct} ${r};`);
            this.emit(`{ uint32_t ao = (${pv}->used + ${lay.a - 1}) & ~${lay.a - 1}u; if ((size_t)ao + (size_t)(${n}) * ${lay.z} > ${pv}->cap) { ${r}.some = false; } else { for (uint32_t k = 0; k < ${n}; k++) ${el.st(`((uint8_t *)${pv}->data + ao)`, "k", x)} ${pv}->used = ao + (${n}) * ${lay.z}; sts_arena_note(${pv}, ao, ${cstr(elemDesc(et))}); ${r}.some = true; ${r}.v.arena = ${pv}->id; ${r}.v.gen = ${pv}->gen; ${r}.v.off = ao; ${r}.v.len = ${n}; } }`);
            return this.t(t, r, e);
          }
          case "view": {
            const b = this.ex(e.arguments[0]!);
            return this.t(t, `sts_arena_view(${pv}, ${b}, ${this.pos(p.name)})`, e);
          }
          case "reset": this.emit(`${pv}->gen += 1; ${pv}->used = 0;`); return stmt ? undefined : "0";
        }
        throw this.no(p.name, `the method '${m}' on ${show(rt)}`);
      }
      if (isGen(rt, "RingTx") || isGen(rt, "RingRx")) {
        const et = elemOf(rt), el = elem(et, this.where);
        const rv = `t${this.tmp++}`;
        this.emit(`sts_ring ${rv} = ${this.ex(p.expression)};`);
        const head = `atomic_load_explicit((_Atomic uint32_t *)(${rv}.base), memory_order_acquire)`;
        const tail = `atomic_load_explicit((_Atomic uint32_t *)(${rv}.base + 4), memory_order_acquire)`;
        if (m === "push") {
          const x = this.t(et, this.conv(this.ex(e.arguments[0]!), this.typeOf(e.arguments[0]!), et), e);
          const r = `t${this.tmp++}`;
          this.emit(`bool ${r};`);
          this.emit(`{ uint32_t tl = ${tail}; uint32_t hd = ${head}; if (tl - hd >= ${rv}.cap) { ${r} = false; } else { ${el.st(`(${rv}.base + 8)`, `tl & (${rv}.cap - 1)`, x)} atomic_store_explicit((_Atomic uint32_t *)(${rv}.base + 4), tl + 1, memory_order_release); ${r} = true; } }`);
          return this.t(t, r, e);
        }
        if (m === "pop") {
          const n = ctype(t, this.where), r = `t${this.tmp++}`;
          this.emit(`${n} ${r};`);
          if (nonNull(et)) { // the element is itself nullable: pop's T | null is the element type (as Vec.pop)
            this.emit(`{ uint32_t hd = ${head}; uint32_t tl = ${tail}; if (hd == tl) { ${r}.some = false; } else { ${r} = ${el.ld(`(${rv}.base + 8)`, `hd & (${rv}.cap - 1)`)}; atomic_store_explicit((_Atomic uint32_t *)(${rv}.base), hd + 1, memory_order_release); } }`);
          } else {
            this.emit(`{ uint32_t hd = ${head}; uint32_t tl = ${tail}; if (hd == tl) { ${r}.some = false; } else { ${r}.some = true; ${r}.v = ${el.ld(`(${rv}.base + 8)`, `hd & (${rv}.cap - 1)`)}; atomic_store_explicit((_Atomic uint32_t *)(${rv}.base), hd + 1, memory_order_release); } }`);
          }
          return this.t(t, r, e);
        }
        throw this.no(p.name, `the method '${m}' on ${show(rt)}`);
      }
      if (isGen(rt, "Ptr") || isGen(rt, "ConstPtr")) { // §14.4
        const pt = elemOf(rt);
        const pv = `t${this.tmp++}`;
        this.emit(`${ctype(rt, this.where)} ${pv} = ${this.ex(p.expression)};`);
        const chk = () => this.emit(`if (!${pv}) sts_trap(15, ${this.pos(p.name)});`); // T015 at the member name
        switch (m) {
          case "isNull": return this.t(t, `${pv} == NULL`, e);
          case "cast": return this.t(t, `(${ctype(t, this.where)})${pv}`, e);
          case "read": chk(); return this.t(t, `ld_${packOf(pt, this.where)}((const uint8_t *)${pv})`, e);
          case "write": {
            chk();
            const x = this.t(pt, this.conv(this.ex(e.arguments[0]!), this.typeOf(e.arguments[0]!), pt), e);
            this.emit(`st_${packOf(pt, this.where)}((uint8_t *)${pv}, ${x});`);
            return stmt ? undefined : "0";
          }
          case "offset": {
            chk();
            const n = this.ex(e.arguments[0]!);
            return this.t(t, `(${ctype(t, this.where)})((uint8_t *)${pv} + (size_t)(${n}) * ${packSize(pt, this.where)})`, e);
          }
          case "slice": {
            chk();
            const n = this.ex(e.arguments[0]!);
            return this.t(t, `(sts_slice){ (uint8_t *)${pv}, (size_t)(${n}) }`, e);
          }
          case "borrow": { // reached as a borrowed argument (userCall); the value the parameter receives
            chk();
            if (isStruct(pt)) return `(${ctype(pt, this.where)} *)${pv}`;
            if (isGen(pt, "RingTx") || isGen(pt, "RingRx")) {
              const r = `t${this.tmp++}`;
              this.emit(`sts_ring ${r} = *(sts_ring *)${pv};`);
              this.emit(`${r}.obj = sts_box_peek(${r}.obj);`);
              return this.t(t, r, e);
            }
            if (isGen(pt, "CHandle")) return this.t(t, `*(void **)${pv}`, e);
            throw this.no(p.name, `borrowing a '${show(pt)}' out of a pointer`);
          }
          case "unbox": {
            chk();
            const r = `t${this.tmp++}`;
            if (isCopy(pt)) {
              this.emit(`${ctype(pt, this.where)} ${r} = ld_${packOf(pt, this.where)}((const uint8_t *)${pv});`);
            } else {
              this.emit(`${ctype(pt, this.where)} ${r} = *(${ctype(pt, this.where)} *)${pv};`);
              for (const fx of boxFix(pt, r, false, this.where)) this.emit(fx);
            }
            this.emit(`free(${pv});`);
            return this.t(t, r, e);
          }
        }
        throw this.no(p.name, `the method '${m}' on ${show(rt)}`);
      }
      if (isGen(rt, "CHandle")) { // §14.5: the handle is the pointer itself; get just hands it back typed
        if (m === "get") return this.t(t, this.ex(p.expression), e);
        throw this.no(p.name, `the method '${m}' on ${show(rt)}`);
      }
      if (isGen(rt, "Vec") || isGen(rt, "Slice")) {
        const s = this.seq(p.expression), el = elem(s.et, this.where);
        switch (m) {
          case "push": {
            const x = this.t(s.et, this.conv(this.ex(e.arguments[0]!), this.typeOf(e.arguments[0]!), s.et), e);
            this.emit(`if (${s.vec}->len == ${s.vec}->cap) sts_vec_grow(${s.vec}, ${this.pos(p.name)});`);
            this.emit(el.st(`${s.vec}->data`, `${s.vec}->len`, x));
            this.emit(`${s.vec}->len++;`);
            return stmt ? undefined : "0";
          }
          case "pop": {
            const n = ctype(t, this.where);
            if (nonNull(s.et)) return this.t(t, `${s.vec}->len == 0 ? (${n}){ .some = false } : ${el.ld(`${s.vec}->data`, `--${s.vec}->len`)}`, e); // T | null elements: pop's T | null is the element type
            return this.t(t, `${s.vec}->len == 0 ? (${n}){ .some = false } : (${n}){ .some = true, .v = ${el.ld(`${s.vec}->data`, `--${s.vec}->len`)} }`, e);
          }
          case "clear": this.emit(`${s.vec}->len = 0;`); return stmt ? undefined : "0";
          case "fill": {
            const x = this.t(s.et, this.conv(this.ex(e.arguments[0]!), this.typeOf(e.arguments[0]!), s.et), e);
            this.emit(`for (uint32_t k = 0; k < ${s.len}; k++) ${el.st(s.data, "k", x)}`);
            return stmt ? undefined : "0";
          }
          case "slice": {
            const base = s.vec ? `sts_vslice(${s.vec})` : s.slice!;
            const a = this.ex(e.arguments[0]!), b = this.ex(e.arguments[1]!);
            return this.t({ k: "gen", name: "Slice", args: [s.et] }, `sts_sub(${base}, ${a}, ${b}, ${el.z}, ${this.pos(p.name)})`, e);
          }
        }
      }
      throw this.no(p.name, `the method '${m}' on ${show(rt)}`);
    }

    /** A call of a C function (§14.2): the included header's prototype converts the arguments;
     * a `usize` result is range-checked before it narrows to 32 bits (T003, at the callee's name). */
    cCall(e: ts.CallExpression, cf: CFnSym, stmt: boolean): string | undefined {
      const off = this.f.layer === "rt" ? 1 : 0; // §14.3: an rt caller writes no Ffi argument
      const mapped = e.arguments.map((a, i) => this.conv(this.ex(a), this.typeOf(a), cf.sig.params[i + off]!));
      const args = off ? mapped : mapped.slice(1); // the Ffi value itself is not passed to C
      const call = `${cf.name}(${args.join(", ")})`;
      const ret = cf.sig.ret;
      if (ret.k === "prim" && (ret.name === "void" || ret.name === "never")) { this.emit(`${call};`); return stmt ? undefined : "0"; }
      if (ret.k === "num" && ret.name === "usize") {
        const rv = `t${this.tmp++}`;
        this.emit(`size_t ${rv} = ${call};`);
        this.emit(`if (${rv} > 4294967295ULL) sts_trap(3, ${this.pos(e.expression)});`);
        return this.t(ret, `(uint32_t)${rv}`, e);
      }
      return this.t(ret, call, e);
    }

    userCall(e: ts.CallExpression, fn: FnSym, stmt: boolean): string | undefined {
      if (fn.layer === "managed") throw this.no(e, "a call to managed code");
      const targs = (callTArgs.get(e) ?? []).map((t) => (this.i.m.size ? subst(t, this.i.m) : t));
      const fnArgs = new Map<number, FnSym>(); // Q189 (b): the callee's function arguments, resolved through this instantiation
      for (const j of fnParamIdx(fn)) {
        const r = callFnArgs.get(e)?.get(j);
        const g = r ? ("fn" in r ? r.fn : this.i.fns.get(r.param)) : undefined;
        if (!g) throw this.no(e, "a function argument that cannot be specialized");
        fnArgs.set(j, g);
      }
      const callee = inst(fn, fn.sig.tparams.length ? targs : [], fnArgs, this.where);
      const args = e.arguments.map((a, i) => {
        const pt = callee.params[i]!, inner = unref(pt), mode = borrowMode(pt);
        if (inner.k === "fn") return ""; // Q189 (b): no runtime value (the slot keeps argument indices aligned)
        if (a.kind === K.CallExpression && (a as ts.CallExpression).expression.kind === K.PropertyAccessExpression) {
          const cp = (a as ts.CallExpression).expression as ts.PropertyAccessExpression;
          if ((cp.name.text === "borrow" || cp.name.text === "slice") && (isGen(this.typeOf(cp.expression), "Ptr") || isGen(this.typeOf(cp.expression), "ConstPtr"))) return this.ex(a); // §14.4
        }
        if (mode && isStruct(inner)) return `&${this.place(a)}`;
        if (isGen(inner, "Slice")) {
          const at = this.typeOf(a);
          const v = this.ex(a);
          return isGen(at, "Vec") ? `sts_vslice(${v})` : v;
        }
        return this.conv(this.ex(a), this.typeOf(a), pt);
      });
      const rtArgs = args.filter((_, i) => unref(callee.params[i]!).k !== "fn");
      // Q190 (b): after every argument is evaluated, same-root slice arguments must not overlap when one is Mut (T013, sts_ovl).
      for (const g of sliceGroups.get(e) ?? []) {
        for (let j = 1; j < g.length; j++) for (let i = 0; i < j; i++) {
          if (!g[i]!.mut && !g[j]!.mut) continue;
          const z = (k: number): number => layout(elemOf(unref(callee.params[g[k]!.arg]!)))!.z;
          this.emit(`if (sts_ovl(${args[g[i]!.arg]}, ${args[g[j]!.arg]}, ${z(i)}, ${z(j)})) sts_trap(13, ${this.pos(g[j]!.name)});`);
        }
      }
      this.emit(`if (++sts_depth > 10000 || STS_STACK_LOW()) sts_trap(6, ${this.pos(e.expression)});`);
      const ret = callee.ret;
      if (ret.k === "prim" && (ret.name === "void" || ret.name === "never")) { this.emit(`${callee.name}(${rtArgs.join(", ")}); sts_depth--;`); return stmt ? undefined : "0"; }
      const r = this.t(ret, `${callee.name}(${rtArgs.join(", ")})`, e);
      this.emit("sts_depth--;");
      return r;
    }
  }

  const out: string[] = [];
  const done: Inst[] = [];
  for (let q = queue.shift(); q; q = queue.shift()) { done.push(q); out.push(new FnGen(q).run()); }
  const protos = done.map((i) => `${proto(i)};`);
  const wrappers = done.map(wrapper);

  /** §14.6: the trampoline C calls. It converts the arguments (§14.2, with the usize rule),
   * calls f under its own trap frame on the calling thread, and answers the type's zero
   * once the end flag is up or when f traps (the trap itself is claimed in sts_trap). */
  function trampBody(i: Inst, name: string): string {
    const f = i.f, where = `${f.mod.file}: ${f.name}`;
    const ret = i.ret, isVoid = ret.k === "prim" && (ret.name === "void" || ret.name === "never");
    const zero = isVoid ? "return;" : `return (${abiType(ret)})0;`;
    const ps = i.params.map((pt, k) => `${abiType(pt)} a${k}`);
    const lines: string[] = [
      `static ${abiType(ret)} ${name}(${ps.join(", ") || "void"}) {`,
      `  if (atomic_load(&sts_done)) ${zero}`,
      `  struct { jmp_buf jb; int depth; } *fr = calloc(1, sizeof *fr); if (!fr) ${zero}`,
      `  memcpy(fr->jb, sts_jb, sizeof fr->jb); fr->depth = sts_depth;`,
      `  if (!sts_stack_lim) sts_tramp_stack_init();`,
      `  if (setjmp(sts_jb)) { memcpy(sts_jb, fr->jb, sizeof sts_jb); sts_depth = fr->depth; free(fr); ${zero} }`,
    ];
    i.params.forEach((pt, k) => {
      if (pt.k === "num" && pt.name === "usize") lines.push(`  if (a${k} > (size_t)4294967295ULL) sts_trap(3, ${posOf(f.mod, f.decl.parameters[k]!.name)});`);
    });
    lines.push(`  if (++sts_depth > 10000 || STS_STACK_LOW()) sts_trap(6, ${posOf(f.mod, f.decl.name!)});`);
    const args = i.params.map((pt, k) => (pt.k === "num" && pt.name === "usize" ? `(uint32_t)a${k}` : `a${k}`));
    lines.push(isVoid ? `  ${i.name}(${args.join(", ")});` : `  ${ctype(ret, where)} r = ${i.name}(${args.join(", ")});`);
    lines.push(`  memcpy(sts_jb, fr->jb, sizeof sts_jb); sts_depth = fr->depth; free(fr);`);
    if (!isVoid) lines.push(`  return r;`);
    lines.push(`}`);
    return lines.join("\n");
  }
  const trampProtos = [...tramps.values()].map(({ i, name }) => `static ${abiType(i.ret)} ${name}(${i.params.map((pt) => abiType(pt)).join(", ") || "void"});`);
  const trampBodies = [...tramps.values()].map(({ i, name }) => trampBody(i, name));

  // §14.2: the TU includes every declared `c:` header; the packages go to the link (native.ts).
  const hdrs = new Set<string>(), pkgs = new Set<string>();
  for (const mod of prog.mods) for (const spec of mod.cdecls.keys()) { const cs = parseCSpec(spec); if (cs) { hdrs.add(cs.header); pkgs.add(cs.pkg); } }

  const rtH = readFileSync(new URL("./c/sts_rt.h", import.meta.url), "utf8");
  const c = [
    `static const int STS_POS[][3] = {${poss.join(",") || "{0,0,0}"}};`,
    `static const char *const STS_FILES[] = {${files.map((x) => JSON.stringify(x)).join(",") || "\"\""}};`,
    `static const char *const STS_LITS[] = {${lits.map(cstr).join(",") || "\"\""}};`, // byte-exact, NUL included (#34)
    `#define STS_NLITS ${lits.length}`,
    rtH,
    `static const size_t STS_LITLEN[] = {${lits.map((x) => Buffer.byteLength(x)).join(",") || "0"}};`,
    ...[...hdrs].map((h) => `#include <${h}>`),
    `static double sts_num(napi_value v) { double d; STS_OK(napi_get_value_double(sts_env, v, &d)); return d; }`,
    `static bool sts_bool(napi_value v) { bool b; STS_OK(napi_get_value_bool(sts_env, v, &b)); return b; }`,
    `static napi_value sts_mknum(double d) { napi_value r; STS_OK(napi_create_double(sts_env, d, &r)); return r; }`,
    `static napi_value sts_mkbool(bool b) { napi_value r; STS_OK(napi_get_boolean(sts_env, b, &r)); return r; }`,
    `static napi_value sts_mknull(void) { napi_value r; STS_OK(napi_get_null(sts_env, &r)); return r; }`,
    `static bool sts_isnull(napi_value v) { napi_valuetype t; STS_OK(napi_typeof(sts_env, v, &t)); return t == napi_null; }`,
    `static napi_value sts_mklit(int32_t k) { napi_value r; STS_OK(napi_create_string_utf8(sts_env, STS_LITS[k], STS_LITLEN[k], &r)); return r; }`,
    `static int32_t sts_lit_in(napi_value v) {`,
    `  size_t n; STS_OK(napi_get_value_string_utf8(sts_env, v, NULL, 0, &n));`,
    `  char *b = malloc(n + 1); if (!b) sts_fail("out of memory");`,
    `  if (napi_get_value_string_utf8(sts_env, v, b, n + 1, &n) != napi_ok) { free(b); sts_fail("napi_get_value_string_utf8"); }`,
    `  for (int32_t i = 0; i < STS_NLITS; i++) if (STS_LITLEN[i] == n && memcmp(b, STS_LITS[i], n) == 0) { free(b); return i; }`,
    `  free(b); sts_fail("unknown string literal");`,
    `}`,
    `/** A method of an authority (Q040): a call back into the JS host. */`,
    `static napi_value sts_callm(napi_value o, const char *m, size_t n, napi_value *a) { napi_value f, r; f = sts_get(o, m); STS_OK(napi_call_function(sts_env, o, f, n, a, &r)); return r; }`,
    ...typedefs, ...helpers, ...protos, ...trampProtos, ...out, ...trampBodies, THROW, FTRAP, ...wrappers,
    `NAPI_MODULE_INIT() {`,
    `  napi_value f; STS_INIT_EXPORT("init", sts_init);`,
    `  STS_INIT_EXPORT("sts_poll", sts_poll); STS_INIT_EXPORT("sts_finish", sts_finish);`,
    ...done.map((x) => `  STS_INIT_EXPORT("${x.name}", w_${x.name});`),
    `  return exports;`,
    `}`,
  ].join("\n");
  return { c, keys, pkgs: [...pkgs] };

}

const THROW = `static napi_value sts_throw(void) {
  if (!sts_err && sts_trap_code >= 1) { int fc, fp; if (sts_take_ftrap(&fc, &fp)) { sts_trap_code = fc; sts_trap_pos = fp; } } // §15.4: the first trap to claim the record is the reported one
  if (sts_err) { napi_throw_error(sts_env, "STS_INTERNAL", sts_err); return 0; }
  napi_value host, f, args[4], r;
  napi_get_reference_value(sts_env, sts_host, &host); napi_get_named_property(sts_env, host, "trap", &f);
  int p = sts_trap_pos;
  napi_create_int32(sts_env, sts_trap_code, &args[0]);
  napi_create_string_utf8(sts_env, p >= 0 ? STS_FILES[STS_POS[p][0]] : "", NAPI_AUTO_LENGTH, &args[1]);
  napi_create_int32(sts_env, p >= 0 ? STS_POS[p][1] : 0, &args[2]);
  napi_create_int32(sts_env, p >= 0 ? STS_POS[p][2] : 0, &args[3]);
  napi_call_function(sts_env, host, f, 4, args, &r);
  return 0;
}
static napi_value sts_init(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value h; napi_get_cb_info(env, info, &argc, &h, 0, 0);
  napi_create_reference(env, h, 1, &sts_host); sts_ftrap_reset(); return 0;
}
#define STS_INIT_EXPORT(n, fn) napi_create_function(env, n, NAPI_AUTO_LENGTH, fn, 0, &f); napi_set_named_property(env, exports, n, f)`;

/** §15.4 (2) and (3): the host polls for a recorded foreign trap at a task boundary
 * (sts_poll) and at the end of main (sts_finish, which also claims the end). The answer
 * is [code, file, line, col], or null when no trap is waiting. */
const FTRAP = `static napi_value sts_ftrap_value(napi_env env) {
  int c, p; napi_value r, v;
  if (!sts_take_ftrap(&c, &p)) { napi_get_null(env, &r); return r; }
  napi_create_array_with_length(env, 4, &r);
  napi_create_int32(env, c, &v); napi_set_element(env, r, 0, v);
  napi_create_string_utf8(env, p >= 0 ? STS_FILES[STS_POS[p][0]] : "", NAPI_AUTO_LENGTH, &v); napi_set_element(env, r, 1, v);
  napi_create_int32(env, p >= 0 ? STS_POS[p][1] : 0, &v); napi_set_element(env, r, 2, v);
  napi_create_int32(env, p >= 0 ? STS_POS[p][2] : 0, &v); napi_set_element(env, r, 3, v);
  return r;
}
static napi_value sts_poll(napi_env env, napi_callback_info info) { (void)info; return sts_ftrap_value(env); }
static napi_value sts_finish(napi_env env, napi_callback_info info) {
  (void)info;
  pthread_mutex_lock(&sts_ftrap_mu); atomic_store(&sts_done, 1); pthread_mutex_unlock(&sts_ftrap_mu);
  return sts_ftrap_value(env);
}`;

export const TRAP_CODES = TRAP;
