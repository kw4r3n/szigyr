// C backend for strict / rt functions (D101-D103): one translation unit for the program's module-level strict / rt functions,
// plus a Node-API wrapper per function that managed JS calls. Every subexpression goes through a temporary, in source order (D103).
import { readFileSync } from "node:fs";
import { SyntaxKind as K, type Node, type ts } from "./parse.ts";
import { exprTypes } from "./expr.ts";
import type { FnSym, Module, Program } from "./modules.ts";
import { isCopy, isInt, nonNull, isNull, isBool, unref, show, type NumName, type Type } from "./types.ts";

/** A construct the C backend does not translate yet: the run stops with this error (never a silent fallback to JS). */
export class CUnsupported extends Error {
  constructor(where: string, what: string) { super(`C backend: ${what} is not supported (${where})`); this.name = "CUnsupported"; }
}

export interface EmittedC { c: string; keys: Map<ts.FunctionDeclaration, string> }

const RANGE: Record<string, [string, string]> = {
  i8: ["-128LL", "127LL"], i16: ["-32768LL", "32767LL"], i32: ["-2147483648LL", "2147483647LL"],
  u8: ["0LL", "255LL"], u16: ["0LL", "65535LL"], u32: ["0LL", "4294967295LL"], usize: ["0LL", "4294967295LL"],
};
const CNUM: Record<NumName, string> = { f64: "double", f32: "float", i8: "int8_t", i16: "int16_t", i32: "int32_t", u8: "uint8_t", u16: "uint16_t", u32: "uint32_t", usize: "uint32_t" };
const TRAP: Record<string, number> = { T001: 1, T002: 2, T003: 3, T004: 4, T005: 5, T006: 6, T007: 7, T008: 8, T009: 9, T010: 10 };
const numText = (n: ts.NumericLiteral): number => Number(n.text.replace(/_/g, ""));
const isGen = (t: Type, n: string): boolean => t.k === "gen" && t.name === n;
const isStruct = (t: Type): t is Extract<Type, { k: "record" }> => t.k === "record" && t.struct;
const elemOf = (t: Type): Type => (t as { args: Type[] }).args[0]!;
const borrowMode = (t: Type): "Ref" | "Mut" | undefined => (t.k === "gen" && (t.name === "Ref" || t.name === "Mut") ? t.name : undefined);

interface Local { c: string; t: Type; ptr: boolean }

export function emitC(prog: Program, display: (path: string) => string): EmittedC | undefined {
  const fns = prog.fns.filter((f) => f.layer !== "managed");
  if (!fns.length) return undefined;
  const keys = new Map<ts.FunctionDeclaration, string>();
  const names = new Map<FnSym, string>();
  fns.forEach((f, i) => { names.set(f, `F${i}_${f.name}`); keys.set(f.decl, `F${i}_${f.name}`); });

  const files: string[] = [];
  const poss: string[] = [];
  const typedefs: string[] = [];
  const structs = new Map<string, string>();
  const nullables = new Map<string, string>();
  const helpers: string[] = [];

  function ctype(t0: Type, where: string): string {
    const t = t0;
    switch (t.k) {
      case "num": return CNUM[t.name];
      case "prim": if (t.name === "boolean") return "bool"; if (t.name === "void") return "void"; break;
      case "record": if (t.struct) return struct(t, where); break;
      case "gen":
        if (t.name === "Vec") { const e = elemOf(t); if (e.k !== "num") throw new CUnsupported(where, `Vec<${show(e)}> (D102)`); return "sts_vec*"; }
        if (t.name === "Slice") { if (elemOf(t).k !== "num") throw new CUnsupported(where, `Slice<${show(elemOf(t))}>`); return "sts_slice"; }
        if (t.name === "Ref" || t.name === "Mut") { const a = elemOf(t); return isStruct(a) ? `${ctype(a, where)}*` : ctype(a, where); }
        break;
      case "opaque": if (t.name === "Alloc") return "napi_value"; break;
      case "union": {
        const n = nonNull(t);
        if (n && (n.k === "num" || isBool(n) || (isStruct(n) && isCopy(n)))) {
          const key = show(t);
          let name = nullables.get(key);
          if (!name) { const inner = ctype(n, where); name = `N${nullables.size}`; nullables.set(key, name); typedefs.push(`typedef struct { bool some; ${inner} v; } ${name};`); }
          return name;
        }
      }
    }
    throw new CUnsupported(where, `the type '${show(t)}'`);
  }

  function struct(t: Extract<Type, { k: "record" }>, where: string): string {
    const key = show(t);
    const have = structs.get(key);
    if (have) return have;
    const fs = t.fields.map((f) => `${ctype(f.type, where)} f_${f.name};`); // nested types are defined first
    const name = `S${structs.size}`;
    structs.set(key, name);
    typedefs.push(`typedef struct { ${fs.join(" ")} } ${name};`);
    // JS <-> C conversion of the struct (boundary, D102).
    helpers.push(`static ${name} in_${name}(napi_value o) { ${name} r; ${t.fields.map((f) => `r.f_${f.name} = ${inConv(f.type, `sts_get(o, "${f.name}")`, where)};`).join(" ")} return r; }`);
    helpers.push(`static napi_value out_${name}(${name} v) { napi_value o; STS_OK(napi_create_object(sts_env, &o)); ${t.fields.map((f) => `sts_set(o, "${f.name}", ${outConv(f.type, `v.f_${f.name}`, where)});`).join(" ")} return o; }`);
    helpers.push(`static void wb_${name}(napi_value o, ${name} *v) { ${t.fields.map((f) => (isStruct(f.type) && !isCopy(f.type) ? `wb_${ctype(f.type, where)}(sts_get(o, "${f.name}"), &v->f_${f.name});` : `sts_set(o, "${f.name}", ${outConv(f.type, `v->f_${f.name}`, where)});`)).join(" ")} }`);
    return name;
  }

  function inConv(t: Type, v: string, where: string): string {
    if (t.k === "num") return `(${CNUM[t.name]})sts_num(${v})`;
    if (isBool(t)) return `sts_bool(${v})`;
    if (isStruct(t)) return `in_${ctype(t, where)}(${v})`;
    if (isGen(t, "Vec")) { ctype(t, where); return `sts_vec_in(${v})`; }
    if (isGen(t, "Slice")) { ctype(t, where); return `sts_slice_in(${v})`; }
    if (t.k === "opaque" && t.name === "Alloc") return v;
    throw new CUnsupported(where, `passing '${show(t)}' from managed code`);
  }
  function outConv(t: Type, v: string, where: string): string {
    if (t.k === "num") return `sts_mknum((double)(${v}))`;
    if (isBool(t)) return `sts_mkbool(${v})`;
    if (isStruct(t)) return `out_${ctype(t, where)}(${v})`;
    if (isGen(t, "Vec")) return `(${v})->obj`;
    if (t.k === "union" && nonNull(t)) { const n = nonNull(t)!; ctype(t, where); return `((${v}).some ? ${outConv(n, `(${v}).v`, where)} : sts_mknull())`; }
    throw new CUnsupported(where, `returning '${show(t)}' to managed code`);
  }

  function proto(f: FnSym): string {
    const where = `${f.mod.file}: ${f.name}`;
    if (f.sig.tparams.length) throw new CUnsupported(where, "a generic strict / rt function");
    const ps = f.decl.parameters.map((p, i) => `${ctype(f.sig.params[i]!, where)} u_${(p.name as ts.Identifier).text}`);
    return `static ${ctype(f.sig.ret, where)} ${names.get(f)}(${ps.join(", ") || "void"})`;
  }

  /** Node-API wrapper: decode the arguments, call, write `Mut` structs back, sync Vec lengths; a trap returns here by longjmp (D103). */
  function wrapper(f: FnSym): string {
    const where = `${f.mod.file}: ${f.name}`;
    const n = f.decl.parameters.length;
    const lines: string[] = [];
    const frame: string[] = [], args: string[] = [], wb: string[] = [];
    f.sig.params.forEach((pt, i) => {
      const a = unref(pt);
      if (borrowMode(pt) && isStruct(a)) {
        frame.push(`${ctype(a, where)} a${i};`);
        lines.push(`  fr->a${i} = ${inConv(a, `argv[${i}]`, where)};`);
        args.push(`&fr->a${i}`);
        if (borrowMode(pt) === "Mut") wb.push(`wb_${ctype(a, where)}(argv[${i}], &fr->a${i});`);
      } else {
        frame.push(`${ctype(pt, where)} a${i};`);
        lines.push(`  fr->a${i} = ${inConv(a.k === "gen" && a.name === "Slice" ? a : a, `argv[${i}]`, where)};`);
        args.push(`fr->a${i}`);
      }
    });
    const ret = f.sig.ret;
    const isVoid = ret.k === "prim" && ret.name === "void";
    return [
      `static napi_value w_${names.get(f)}(napi_env env, napi_callback_info info) {`,
      `  sts_env = env; sts_depth = 0; sts_err = 0; sts_nvecs = 0;`,
      `  size_t argc = ${n}; napi_value argv[${Math.max(n, 1)}]; napi_get_cb_info(env, info, &argc, argv, 0, 0);`,
      `  struct { int ok; ${frame.join(" ")} } *volatile fr = calloc(1, sizeof *fr);`,
      `  if (setjmp(sts_jb)) { if (fr->ok) { fr->ok = 0; ${wb.join(" ")} } sts_vec_sync(); free(fr); return sts_throw(); }`,
      ...lines,
      `  fr->ok = 1;`,
      isVoid ? `  ${names.get(f)}(${args.join(", ")});` : `  ${ctype(ret, where)} r = ${names.get(f)}(${args.join(", ")});`,
      `  fr->ok = 0; ${wb.join(" ")}`,
      `  napi_value res = ${isVoid ? "0" : outConv(ret, "r", where)};`,
      `  if (!res) napi_get_undefined(env, &res);`,
      `  sts_vec_sync(); free(fr); return res;`,
      `}`,
    ].join("\n");
  }

  class FnGen {
    f: FnSym; mod: Module; sf: ts.SourceFile; where: string;
    body: string[] = [];
    scopes: Map<string, Local>[] = [];
    tmp = 0; label = 0;
    loops: { cont: string }[] = [];
    ensures: ts.ArrowFunction[] = [];
    constructor(f: FnSym) { this.f = f; this.mod = f.mod; this.sf = f.mod.sf; this.where = `${f.mod.file}: ${f.name}`; }

    run(): string {
      const f = this.f;
      this.scopes.push(new Map());
      f.decl.parameters.forEach((p, i) => {
        if (p.name.kind !== K.Identifier) throw this.no(p, "a destructured parameter");
        const t = f.sig.params[i]!, a = unref(t);
        const name = (p.name as ts.Identifier).text;
        this.scopes[0]!.set(name, { c: borrowMode(t) && isStruct(a) ? `(*u_${name})` : `u_${name}`, t: a, ptr: false });
      });
      const ss = f.decl.body!.statements;
      const rv = f.sig.ret;
      if (rv.k === "prim" && rv.name === "void" && ss.some((s) => s.kind === K.ExpressionStatement && ((s as ts.ExpressionStatement).expression as ts.CallExpression).expression?.getText(this.sf) === "ensures")) throw this.no(f.decl, "ensures on a void function");
      for (const s of ss) {
        if (s.kind === K.ExpressionStatement && (s as ts.ExpressionStatement).expression.kind === K.CallExpression) {
          const c = (s as ts.ExpressionStatement).expression as ts.CallExpression;
          if (c.expression.kind === K.Identifier && (c.expression as ts.Identifier).text === "ensures") { this.ensures.push(c.arguments[0] as ts.ArrowFunction); continue; }
        }
        this.stmt(s);
      }
      return `${proto(f)} {\n${this.body.join("\n")}\n}`;
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
      return unref(t);
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
          const w = s as ts.WhileStatement, cont = `L${this.label++}`;
          this.emit("for (;;) {");
          this.emit(`${cont}: ;`);
          const c = this.ex(w.expression); this.emit(`if (!${c}) break;`);
          this.loops.push({ cont }); this.block(() => this.stmt(w.statement)); this.loops.pop();
          this.emit("}");
          return;
        }
        case K.DoStatement: {
          const w = s as ts.DoStatement, cont = `L${this.label++}`;
          this.emit("for (;;) {");
          this.loops.push({ cont }); this.block(() => this.stmt(w.statement)); this.loops.pop();
          this.emit(`${cont}: ;`);
          const c = this.ex(w.expression); this.emit(`if (!${c}) break;`);
          this.emit("}");
          return;
        }
        case K.ForStatement: {
          const fo = s as ts.ForStatement, cont = `L${this.label++}`;
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
          if (!r.expression) { this.emit("return;"); return; }
          const want = this.f.sig.ret;
          const v = this.conv(this.ex(r.expression), this.typeOf(r.expression), want);
          if (this.ensures.length) {
            const rv = `t${this.tmp++}`;
            this.emit(`${ctype(want, this.where)} ${rv} = ${v};`);
            for (const a of this.ensures) {
              const p = a.parameters[0]!.name as ts.Identifier;
              if (a.body.kind === K.Block) throw this.no(a.body, "an ensures predicate with a block body");
              this.emit("{");
              this.scopes.push(new Map([[p.text, { c: rv, t: want, ptr: false }]]));
              const c = this.ex(a.body as ts.Expression);
              this.scopes.pop();
              this.emit(`if (!${c}) sts_trap(5, ${this.pos((a.parent as ts.CallExpression).expression)});`);
              this.emit("}");
            }
            this.emit(`return ${rv};`);
          } else this.emit(`return ${v};`);
          return;
        }
      }
      throw this.no(s, `the statement kind ${K[s.kind]}`);
    }

    varDecl(d: ts.VariableDeclaration): void {
      const t = exprTypes.get(d.name);
      if (!t) throw this.no(d, "a declaration without a recorded type");
      const v = this.conv(this.ex(d.initializer!), this.typeOf(d.initializer!), t);
      if (d.name.kind === K.Identifier) {
        const name = (d.name as ts.Identifier).text, c = `u_${name}_${this.tmp++}`;
        this.emit(`${ctype(t, this.where)} ${c} = ${v};`);
        this.scopes.at(-1)!.set(name, { c, t, ptr: false });
        return;
      }
      const src = this.t(t, v, d); // `const { x, y } = s`: whole-value move, then fields
      for (const el of (d.name as ts.ObjectBindingPattern).elements) {
        const prop = (el.propertyName ?? el.name) as ts.Identifier, name = (el.name as ts.Identifier).text, ft = exprTypes.get(el.name!)!;
        const c = `u_${name}_${this.tmp++}`;
        this.emit(`${ctype(ft, this.where)} ${c} = ${src}.f_${prop.text};`);
        this.scopes.at(-1)!.set(name, { c, t: ft, ptr: false });
      }
    }

    /** Value of type `from` stored where `to` is expected: wraps into / out of `T | null`. */
    conv(v: string, from: Type, to0: Type): string {
      const to = unref(to0);
      if (to.k === "union" && nonNull(to) && !(from.k === "union")) {
        const n = ctype(to, this.where);
        return isNull(from) ? `((${n}){ .some = false })` : `((${n}){ .some = true, .v = ${v} })`;
      }
      return v;
    }

    exVoid(e: ts.Expression): void {
      const t = exprTypes.get(e);
      if (t && t.k === "prim" && (t.name === "void" || t.name === "never")) { this.call(e as ts.CallExpression, true); return; }
      this.ex(e);
    }

    // ---- expressions: each returns a C expression without side effects (a temporary, a literal or a local)
    ex(e: ts.Expression): string {
      switch (e.kind) {
        case K.ParenthesizedExpression: return this.ex((e as ts.ParenthesizedExpression).expression);
        case K.NumericLiteral: return this.lit(numText(e as ts.NumericLiteral), this.typeOf(e));
        case K.TrueKeyword: return "true";
        case K.FalseKeyword: return "false";
        case K.NullKeyword: return "0";
        case K.Identifier: return this.ident(e as ts.Identifier);
        case K.PrefixUnaryExpression: return this.prefix(e as ts.PrefixUnaryExpression);
        case K.BinaryExpression: return this.binary(e as ts.BinaryExpression);
        case K.PropertyAccessExpression: return this.prop(e as ts.PropertyAccessExpression);
        case K.ElementAccessExpression: {
          const a = e as ts.ElementAccessExpression;
          const { data, len, et } = this.seq(a.expression);
          const i = this.ex(a.argumentExpression);
          this.emit(`sts_chk(${i}, ${len}, ${this.pos(a.argumentExpression)});`);
          return this.t(et, `((${ctype(et, this.where)}*)${data})[${i}]`, e);
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
      const s = Object.is(x, -0) ? "-0.0" : /[.e]/.test(`${x}`) ? `${x}` : `${x}.0`;
      return t.name === "f32" ? `((float)${s})` : s;
    }

    ident(id: ts.Identifier): string {
      const l = this.lookup(id.text);
      if (l) {
        const now = this.typeOf(id);
        if (l.t.k === "union" && now.k !== "union") return `${l.c}.v`; // narrowed `T | null`
        return l.c;
      }
      const sym = this.mod.values.get(id.text);
      if (sym?.k === "const") {
        const init = sym.decl.initializer!;
        if (init.kind === K.NumericLiteral) return this.lit(numText(init as ts.NumericLiteral), sym.type);
        if (init.kind === K.PrefixUnaryExpression && (init as ts.PrefixUnaryExpression).operand.kind === K.NumericLiteral) return this.lit(-numText((init as ts.PrefixUnaryExpression).operand as ts.NumericLiteral), sym.type);
        if (init.kind === K.TrueKeyword || init.kind === K.FalseKeyword) return init.kind === K.TrueKeyword ? "true" : "false";
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
          case "+": case "-": return `(${c})sts_rng((int64_t)${l} ${o} (int64_t)${r}, ${lo}, ${hi}, ${this.pos(anchor)})`;
          case "*": return `(${c})sts_mulr(${l}, ${r}, ${lo}, ${hi}, ${this.pos(anchor)})`;
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
        if (lt.k === "union" || rt.k === "union") throw this.no(b, "comparing a nullable value");
      }
      const t = this.typeOf(b);
      const l = this.ex(b.left), r = this.ex(b.right);
      const CMP: Partial<Record<K, string>> = { [K.LessThanToken]: "<", [K.LessThanEqualsToken]: "<=", [K.GreaterThanToken]: ">", [K.GreaterThanEqualsToken]: ">=", [K.EqualsEqualsEqualsToken]: "==", [K.ExclamationEqualsEqualsToken]: "!=" };
      if (CMP[k]) return this.t(t, `${l} ${CMP[k]} ${r}`, b);
      return this.t(t, this.arith(t, o, l, r, b.operatorToken), b);
    }

    /** `x = e` / `x op= e` (D103 order). The value of the expression is the stored value. */
    assign(b: ts.BinaryExpression, op: string | undefined): string {
      const left = b.left;
      if (left.kind === K.ElementAccessExpression) {
        const a = left as ts.ElementAccessExpression;
        const { data, len, et } = this.seq(a.expression);
        const i = this.ex(a.argumentExpression), ip = this.pos(a.argumentExpression);
        const ce = ctype(et, this.where);
        if (op) {
          this.emit(`sts_chk(${i}, ${len}, ${ip});`);
          const cur = this.t(et, `((${ce}*)${data})[${i}]`, a);
          const r = this.ex(b.right);
          const nv = this.t(et, this.arith(et, op, cur, r, b.operatorToken), b);
          this.emit(`((${ce}*)${data})[${i}] = ${nv};`);
          return nv;
        }
        const r = this.ex(b.right);
        this.emit(`sts_chk(${i}, ${len}, ${ip});`);
        this.emit(`((${ce}*)${data})[${i}] = ${r};`);
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
      return p;
    }

    /** An lvalue: a local, or a field path from one (`s.a.b`, `(*u_m).x`). */
    place(e: ts.Expression): string {
      if (e.kind === K.ParenthesizedExpression) return this.place((e as ts.ParenthesizedExpression).expression);
      if (e.kind === K.Identifier) { const l = this.lookup((e as ts.Identifier).text); if (l) return l.c; }
      if (e.kind === K.PropertyAccessExpression) {
        const p = e as ts.PropertyAccessExpression;
        if (isStruct(this.typeOf(p.expression))) return `${this.place(p.expression)}.f_${p.name.text}`;
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
      if (isStruct(rt)) {
        const t = this.typeOf(p);
        const base = this.placeOrValue(p.expression);
        return this.t(t, `${base}.f_${name}`, p);
      }
      throw this.no(p, `the member '${name}'`);
    }
    placeOrValue(e: ts.Expression): string {
      try { return this.place(e); } catch (x) { if (x instanceof CUnsupported) return this.ex(e); throw x; }
    }

    object(o: ts.ObjectLiteralExpression): string {
      const t = this.typeOf(o);
      if (!isStruct(t)) throw this.no(o, `an object literal of type ${show(t)}`);
      const name = ctype(t, this.where);
      const r = `t${this.tmp++}`;
      this.emit(`${name} ${r};`);
      for (const pr of o.properties) {
        if (pr.kind === K.SpreadAssignment) { this.emit(`${r} = ${this.ex((pr as ts.SpreadAssignment).expression)};`); continue; }
        if (pr.kind === K.ShorthandPropertyAssignment) { const n = (pr as ts.ShorthandPropertyAssignment).name as ts.Identifier; this.emit(`${r}.f_${n.text} = ${this.ident(n)};`); continue; }
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
              const a = this.ex(e.arguments[0]!), b = this.ex(e.arguments[1]!), [lo, hi] = RANGE[num!.name]!;
              return this.t(num!, name === "rem" ? `(${CNUM[num!.name]})sts_rem(${a}, ${b}, ${this.pos(callee)})` : `(${CNUM[num!.name]})sts_div(${a}, ${b}, ${lo}, ${hi}, ${this.pos(callee)})`, e);
            }
            case "panic": this.emit(`sts_trap(6, ${this.pos(callee)});`); return stmt ? undefined : "0";
          }
          const fn = this.resolveFn(name);
          if (fn) return this.userCall(e, fn, stmt);
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
        if (ns === "Vec" && m === "create") {
          const el = elemOf(t);
          ctype(t, this.where);
          const a = this.ex(e.arguments[0]!), n = this.ex(e.arguments[1]!);
          return this.t(t, `sts_vec_create(${a}, ${n}, "${(el as { name: string }).name}")`, e);
        }
        throw this.no(p.name, `'${ns}.${m}'`);
      }
      const rt = this.typeOf(p.expression);
      if (isGen(rt, "Vec") || isGen(rt, "Slice")) {
        const s = this.seq(p.expression), ce = ctype(s.et, this.where);
        switch (m) {
          case "push": {
            const x = this.ex(e.arguments[0]!);
            this.emit(`if (${s.vec}->len == ${s.vec}->cap) sts_vec_grow(${s.vec});`);
            this.emit(`((${ce}*)${s.vec}->data)[${s.vec}->len++] = ${x};`);
            return stmt ? undefined : "0";
          }
          case "pop": {
            const n = ctype(t, this.where);
            return this.t(t, `${s.vec}->len == 0 ? (${n}){ .some = false } : (${n}){ .some = true, .v = ((${ce}*)${s.vec}->data)[--${s.vec}->len] }`, e);
          }
          case "clear": this.emit(`${s.vec}->len = 0;`); return stmt ? undefined : "0";
          case "fill": {
            const x = this.ex(e.arguments[0]!);
            this.emit(`for (uint32_t k = 0; k < ${s.len}; k++) ((${ce}*)${s.data})[k] = ${x};`);
            return stmt ? undefined : "0";
          }
          case "slice": {
            const base = s.vec ? `sts_vslice(${s.vec})` : s.slice!;
            const a = this.ex(e.arguments[0]!), b = this.ex(e.arguments[1]!);
            return this.t({ k: "gen", name: "Slice", args: [s.et] }, `sts_sub(${base}, ${a}, ${b}, sizeof(${ce}), ${this.pos(p.name)})`, e);
          }
        }
      }
      throw this.no(p.name, `the method '${m}' on ${show(rt)}`);
    }

    resolveFn(name: string): FnSym | undefined {
      const v = this.mod.values.get(name);
      if (v?.k === "fn") return v;
      const imp = this.mod.imports.get(name);
      if (imp) { const local = imp.mod.exports.get(imp.name); const w = local ? imp.mod.values.get(local) : undefined; if (w?.k === "fn") return w; }
      return undefined;
    }

    userCall(e: ts.CallExpression, fn: FnSym, stmt: boolean): string | undefined {
      if (fn.layer === "managed") throw this.no(e, "a call to managed code");
      const args = e.arguments.map((a, i) => {
        const pt = fn.sig.params[i]!, inner = unref(pt), mode = borrowMode(pt);
        if (mode && isStruct(inner)) return `&${this.place(a)}`;
        if (isGen(inner, "Slice")) {
          const at = this.typeOf(a);
          const v = this.ex(a);
          return isGen(at, "Vec") ? `sts_vslice(${v})` : v;
        }
        return this.conv(this.ex(a), this.typeOf(a), pt);
      });
      this.emit(`if (++sts_depth > 10000) sts_trap(6, ${this.pos(e.expression)});`);
      const ret = fn.sig.ret;
      if (ret.k === "prim" && (ret.name === "void" || ret.name === "never")) { this.emit(`${names.get(fn)}(${args.join(", ")}); sts_depth--;`); return stmt ? undefined : "0"; }
      const r = this.t(ret, `${names.get(fn)}(${args.join(", ")})`, e);
      this.emit("sts_depth--;");
      return r;
    }
  }

  const out: string[] = [];
  for (const f of fns) out.push(new FnGen(f).run());
  const protos = fns.map((f) => `${proto(f)};`);
  const wrappers = fns.map(wrapper);

  const rtH = readFileSync(new URL("./c/sts_rt.h", import.meta.url), "utf8");
  const c = [
    `static const int STS_POS[][3] = {${poss.join(",") || "{0,0,0}"}};`,
    `static const char *const STS_FILES[] = {${files.map((x) => JSON.stringify(x)).join(",") || "\"\""}};`,
    rtH,
    `static double sts_num(napi_value v) { double d; STS_OK(napi_get_value_double(sts_env, v, &d)); return d; }`,
    `static bool sts_bool(napi_value v) { bool b; STS_OK(napi_get_value_bool(sts_env, v, &b)); return b; }`,
    `static napi_value sts_mknum(double d) { napi_value r; STS_OK(napi_create_double(sts_env, d, &r)); return r; }`,
    `static napi_value sts_mkbool(bool b) { napi_value r; STS_OK(napi_get_boolean(sts_env, b, &r)); return r; }`,
    `static napi_value sts_mknull(void) { napi_value r; STS_OK(napi_get_null(sts_env, &r)); return r; }`,
    ...typedefs, ...helpers, ...protos, ...out, THROW, ...wrappers,
    `NAPI_MODULE_INIT() {`,
    `  napi_value f; STS_INIT_EXPORT("init", sts_init);`,
    ...fns.map((x) => `  STS_INIT_EXPORT("${names.get(x)}", w_${names.get(x)});`),
    `  return exports;`,
    `}`,
  ].join("\n");
  return { c, keys };

}

const THROW = `static napi_value sts_throw(void) {
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
  napi_create_reference(env, h, 1, &sts_host); return 0;
}
#define STS_INIT_EXPORT(n, fn) napi_create_function(env, n, NAPI_AUTO_LENGTH, fn, 0, &f); napi_set_named_property(env, exports, n, f)`;

export const TRAP_CODES = TRAP;
