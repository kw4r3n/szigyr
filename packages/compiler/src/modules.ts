// P2 declarations (D011): one Module per file, top-level symbols, imports, type-node resolution, signatures, layers.
// Signatures come from annotations only (§10: "シグネチャはすべて注釈されているので、構文だけから取り出せる").
import { dirname, resolve } from "node:path";
import type { Diagnostic } from "./diagnostics.ts";
import { SyntaxKind as K, type Node, type ParsedFile, type ts } from "./parse.ts";
import { RESERVED, builtinType, isGenName } from "./builtins.ts";
import {
  ERROR, GEN_ARITY, NULL, VOID, assignable, bindTParams, demand, fn, isTaggedUnion, hasAuthority, kindOf, layerOk, needOk, newTParam, nonNull, record, result, show, subst, union,
  type ClassSym, type Field, type FnType, type IfaceSym, type TParam, type Type,
} from "./types.ts";

export type Layer = "managed" | "strict" | "rt";

export interface FnSym { k: "fn"; name: string; decl: ts.FunctionDeclaration; mod: Module; layer: Layer; sig: FnType }
export interface ConstSym { k: "const"; decl: ts.VariableDeclaration; mod: Module; type: Type }
export interface ClassValueSym { k: "class"; cls: ClassSym; mod: Module }
/** `declared`: the annotated type before Ref / Mut are read through (contracts, Q056). */
export interface LocalSym {
  k: "local"; id: number; name: string; type: Type; declared: Type; mutable: boolean; param: boolean; fnDepth: number;
  /** Captured by a nested function and assigned after its declaration: never narrowed (Q122). */
  unstable?: boolean;
}
export type ValueSym = FnSym | ConstSym | ClassValueSym | { k: "jsref" } | LocalSym;

export type TypeSym =
  | { k: "alias"; decl: ts.TypeAliasDeclaration; mod: Module; tparams?: TParam[]; body?: Type; busy?: boolean }
  | { k: "class"; cls: ClassSym; mod: Module }
  | { k: "iface"; iface: IfaceSym; decl: ts.InterfaceDeclaration; mod: Module };

export interface Module {
  pf: ParsedFile;
  file: string;
  sf: ts.SourceFile;
  /** File directive (Q039); applies to module-level `function` declarations only. */
  layer: Layer;
  values: Map<string, ValueSym>;
  types: Map<string, TypeSym>;
  /** exported name -> local name */
  exports: Map<string, string>;
  /** local name -> imported module and exported name (relative imports only) */
  imports: Map<string, { mod: Module; name: string }>;
}

export class Reporter {
  readonly out: Diagnostic[] = [];
  report(mod: Module, code: string, start: number, end: number, message: string, data?: Record<string, unknown>): void {
    if (this.out.some((d) => d.code === code && d.file === mod.file && d.range.start.line === mod.pf.position(start).line && d.range.start.col === mod.pf.position(start).col)) return; // Q133: one per code and position
    this.out.push({ code, severity: "error", message, file: mod.file, range: { start: mod.pf.position(start), end: mod.pf.position(end) }, ...(data ? { data } : {}) });
  }
  at(mod: Module, code: string, n: Node, message: string, data?: Record<string, unknown>): void {
    this.report(mod, code, n.getStart(mod.sf), n.end, message, data);
  }
}

const DIRECTIVE_LAYER: Record<string, Layer> = { "use owned": "strict", "use rt": "rt" };
/** The directive of a statement list (first statement, Q039), if any. */
export function directiveOf(list: readonly ts.Statement[]): Layer | undefined {
  const s = list[0];
  if (s?.kind !== K.ExpressionStatement || (s as ts.ExpressionStatement).expression.kind !== K.StringLiteral) return undefined;
  return DIRECTIVE_LAYER[((s as ts.ExpressionStatement).expression as ts.StringLiteral).text];
}

const hasMod = (n: Node, k: K): boolean => !!(n as Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers?.some((m) => m.kind === k);
const isId = (n: Node | undefined): n is ts.Identifier => n?.kind === K.Identifier;

/** Syntactic export table: exported name -> local name (E7001 check in P1, and module linking). */
export function exportTable(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sf.statements) {
    if (s.kind === K.ExportDeclaration) {
      const ec = (s as ts.ExportDeclaration).exportClause;
      if (ec?.kind === K.NamedExports) for (const e of (ec as ts.NamedExports).elements) out.set(e.name.text, (e.propertyName as ts.Identifier | undefined)?.text ?? e.name.text);
      continue;
    }
    if (!hasMod(s, K.ExportKeyword)) continue;
    if (s.kind === K.VariableStatement) {
      for (const d of (s as ts.VariableStatement).declarationList.declarations) if (isId(d.name)) out.set(d.name.text, d.name.text);
    } else {
      const name = (s as Node & { name?: Node }).name;
      if (isId(name)) out.set(name.text, name.text);
    }
  }
  return out;
}

/** Top-level declared names (values and types share one namespace for this check). */
function declaredNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const s of sf.statements) {
    if (s.kind === K.VariableStatement) for (const d of (s as ts.VariableStatement).declarationList.declarations) { if (isId(d.name)) out.add(d.name.text); }
    else if (s.kind === K.ImportDeclaration) {
      const nb = (s as ts.ImportDeclaration).importClause?.namedBindings;
      if (nb?.kind === K.NamedImports) for (const e of (nb as ts.NamedImports).elements) out.add(e.name.text);
    } else { const n = (s as Node & { name?: Node }).name; if (isId(n)) out.add(n.text); }
  }
  return out;
}

/** P1 part of Q009: imported names must be exported by the target; exported names must exist. */
export function checkImportNames(files: ParsedFile[], display: (p: string) => string): Diagnostic[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out: Diagnostic[] = [];
  const diag = (pf: ParsedFile, n: Node, message: string): void => {
    out.push({ code: "E7001", severity: "error", message, file: display(pf.path), range: { start: pf.position(n.getStart(pf.sourceFile)), end: pf.position(n.end) } });
  };
  for (const pf of files) {
    const own = declaredNames(pf.sourceFile);
    for (const s of pf.sourceFile.statements) {
      if (s.kind === K.ExportDeclaration) {
        const ec = (s as ts.ExportDeclaration).exportClause;
        if (ec?.kind === K.NamedExports) for (const e of (ec as ts.NamedExports).elements) {
          const local = (e.propertyName ?? e.name) as ts.Identifier;
          if (!own.has(local.text)) diag(pf, local, `cannot export unknown name '${local.text}'`);
        }
      }
      if (s.kind !== K.ImportDeclaration) continue;
      const d = s as ts.ImportDeclaration;
      const target = byPath.get(resolve(dirname(pf.path), (d.moduleSpecifier as ts.StringLiteral).text));
      const nb = d.importClause?.namedBindings;
      if (!target || nb?.kind !== K.NamedImports) continue;
      const ex = exportTable(target.sourceFile);
      for (const e of (nb as ts.NamedImports).elements) {
        const name = (e.propertyName ?? e.name) as ts.Identifier;
        if (!ex.has(name.text)) diag(pf, name, `module does not export '${name.text}'`);
      }
    }
  }
  return out;
}

/** The program's symbol tables, built in two passes: shells, then signatures (needs all type names). */
export class Program {
  readonly mods: Module[] = [];
  readonly fns: FnSym[] = [];
  private readonly byPath = new Map<string, Module>();
  readonly rep: Reporter;
  /** Q127: every instantiation of a user type parameter, checked against its conditions once all bodies are checked. */
  readonly insts: { mod: Module; node: Node; p: TParam; arg: Type }[] = [];

  constructor(files: ParsedFile[], display: (p: string) => string, rep: Reporter) {
    this.rep = rep;
    for (const pf of files) {
      const sf = pf.sourceFile;
      const mod: Module = {
        pf, sf, file: display(pf.path), layer: directiveOf(sf.statements) ?? "managed",
        values: new Map(), types: new Map(), exports: exportTable(sf), imports: new Map(),
      };
      this.mods.push(mod);
      this.byPath.set(pf.path, mod);
    }
    for (const mod of this.mods) this.shells(mod);
    for (const mod of this.mods) this.classIfaceConstraints(mod); // before any type reference is resolved (D013)
    for (const mod of this.mods) this.signatures(mod);
  }

  private shells(mod: Module): void {
    for (const s of mod.sf.statements) {
      switch (s.kind) {
        case K.ImportDeclaration: {
          const d = s as ts.ImportDeclaration;
          const spec = (d.moduleSpecifier as ts.StringLiteral).text;
          const nb = d.importClause?.namedBindings as ts.NamedImports;
          const target = this.byPath.get(resolve(dirname(mod.pf.path), spec));
          for (const e of nb.elements) {
            if (spec.startsWith("npm:")) mod.values.set(e.name.text, { k: "jsref" }); // §7.4
            else if (target) mod.imports.set(e.name.text, { mod: target, name: ((e.propertyName ?? e.name) as ts.Identifier).text });
          }
          break;
        }
        case K.TypeAliasDeclaration: { const d = s as ts.TypeAliasDeclaration; mod.types.set(d.name.text, { k: "alias", decl: d, mod }); break; }
        case K.InterfaceDeclaration: {
          const d = s as ts.InterfaceDeclaration;
          mod.types.set(d.name.text, { k: "iface", decl: d, mod, iface: { name: d.name.text, tparams: tparamShells(d.typeParameters, "managed"), methods: new Map() } });
          break;
        }
        case K.ClassDeclaration: {
          const d = s as ts.ClassDeclaration;
          const cls: ClassSym = { name: d.name!.text, decl: d, tparams: tparamShells(d.typeParameters, "managed"), fields: new Map(), methods: new Map(), ctor: fn([], VOID), implements: [] };
          mod.types.set(cls.name, { k: "class", cls, mod });
          mod.values.set(cls.name, { k: "class", cls, mod });
          break;
        }
        case K.FunctionDeclaration: {
          const d = s as ts.FunctionDeclaration;
          const f: FnSym = { k: "fn", name: d.name!.text, decl: d, mod, layer: directiveOf(d.body!.statements) ?? mod.layer, sig: fn([], ERROR) };
          mod.values.set(f.name, f);
          this.fns.push(f);
          break;
        }
        case K.VariableStatement:
          for (const d of (s as ts.VariableStatement).declarationList.declarations) mod.values.set((d.name as ts.Identifier).text, { k: "const", decl: d, mod, type: ERROR });
          break;
      }
    }
  }

  /** Constraints of class and interface type parameters, so that every `Box<X>` reference can be checked (§3.2). */
  private classIfaceConstraints(mod: Module): void {
    for (const t of mod.types.values()) {
      if (t.mod !== mod || t.k === "alias") continue;
      const [decl, ps] = t.k === "iface" ? [t.decl, t.iface.tparams] : [t.cls.decl, t.cls.tparams];
      this.constraints(decl.typeParameters, ps, { mod, tparams: new Map(ps.map((p) => [p.name, p])) });
    }
  }

  private signatures(mod: Module): void {
    const env = (tps: TParam[] = []): TypeEnv => ({ mod, tparams: new Map(tps.map((p) => [p.name, p])) });
    for (const t of mod.types.values()) {
      if (t.mod !== mod) continue;
      if (t.k === "alias") this.aliasBody(t);
      else if (t.k === "iface") {
        const e = env(t.iface.tparams);
        for (const m of t.decl.members) {
          const ms = m as ts.MethodSignatureDeclaration;
          t.iface.methods.set((ms.name as ts.Identifier).text, this.signature(ms, ms.name, e));
        }
      }
    }
    for (const v of mod.values.values()) {
      if (v.k === "fn" && v.mod === mod) { v.sig = this.signature(v.decl, v.decl.name!, env()); for (const p of v.sig.tparams) p.owner = v.layer; }
      else if (v.k === "class" && v.mod === mod) this.classMembers(v.cls, env(v.cls.tparams));
      else if (v.k === "const" && v.mod === mod) {
        if (!v.decl.type) this.rep.at(mod, "E2006", v.decl.name, "module-level const needs a type annotation");
        else v.type = this.typeOf(v.decl.type, env());
      }
    }
  }

  private classMembers(cls: ClassSym, e: TypeEnv): void {
    const mod = e.mod;
    for (const h of cls.decl.heritageClauses ?? []) for (const t of h.types) cls.implements.push(this.typeRef(t.expression as ts.Identifier, t.typeArguments, t, e));
    for (const m of cls.decl.members) {
      if (m.kind === K.PropertyDeclaration) {
        const p = m as ts.PropertyDeclaration;
        const name = (p.name as ts.Identifier).text;
        if (!p.type) this.rep.at(mod, "E2006", p.name, "field needs a type annotation");
        cls.fields.set(name, {
          type: p.type ? this.typeOf(p.type, e) : ERROR, readonly: hasMod(p, K.ReadonlyKeyword),
          private: hasMod(p, K.PrivateKeyword), static: hasMod(p, K.StaticKeyword), node: p,
        });
      } else if (m.kind === K.MethodDeclaration) {
        const md = m as ts.MethodDeclaration;
        cls.methods.set((md.name as ts.Identifier).text, { sig: this.signature(md, md.name, e), private: hasMod(md, K.PrivateKeyword), static: hasMod(md, K.StaticKeyword), node: md });
      } else if (m.kind === K.Constructor) {
        cls.ctor = this.signature(m as ts.ConstructorDeclaration, undefined, e);
      }
    }
  }

  /** Q022: parameters always annotated; return annotated for named functions and methods (anchor: the name). */
  signature(d: ts.SignatureDeclaration, name: Node | undefined, outer: TypeEnv, requireRet = true): FnType {
    const tparams = tparamShells(d.typeParameters, "managed");
    const e: TypeEnv = { mod: outer.mod, tparams: new Map([...outer.tparams, ...tparams.map((p) => [p.name, p] as const)]) };
    this.constraints(d.typeParameters, tparams, e);
    const params = d.parameters.map((p) => {
      if (!p.type) { this.rep.at(e.mod, "E2006", p.name, "parameter needs a type annotation"); return ERROR; }
      return this.typeOf(p.type, e);
    });
    let ret: Type = VOID;
    if (d.type) ret = this.typeOf(d.type, e, true);
    else if (name && requireRet) { this.rep.at(e.mod, "E2006", name, "return type annotation is required"); ret = ERROR; }
    return { ...fn(params, ret, tparams) };
  }

  private constraints(decls: ts.NodeArray<ts.TypeParameterDeclaration> | undefined, ps: TParam[], e: TypeEnv): void {
    decls?.forEach((d, i) => {
      if (!d.constraint) return;
      const c = this.typeOf(d.constraint, e);
      if (c.k !== "iface" && c.k !== "error") this.rep.at(e.mod, "E2002", d.constraint, "a constraint must be an interface");
      else ps[i]!.constraint = c;
    });
  }

  private aliasBody(a: Extract<TypeSym, { k: "alias" }>): Type {
    if (a.body) return a.body;
    if (a.busy) return ERROR; // typeRef reports the cycle (Q085); shortcut: recursive aliases stay unsupported, upgrade with a lazy alias type
    a.busy = true;
    a.tparams ??= tparamShells(a.decl.typeParameters);
    const e: TypeEnv = { mod: a.mod, tparams: new Map(a.tparams.map((p) => [p.name, p])) };
    this.constraints(a.decl.typeParameters, a.tparams, e);
    a.body = this.typeOf(a.decl.type, e);
    a.busy = false;
    return a.body;
  }

  /** Q127: propagates conditions through type parameters instantiated by type parameters, then checks the rest. */
  checkInsts(): void {
    for (let changed = true; changed;) {
      changed = false;
      for (const { p, arg } of this.insts) {
        if (arg.k !== "tparam" || !p.need) continue;
        for (const n of p.need) if (!arg.p.need?.has(n)) { (arg.p.need ??= new Set()).add(n); changed = true; }
      }
    }
    const seen = new Set<string>();
    for (const { mod, node, p, arg } of this.insts) {
      const bad = arg.k === "tparam" ? undefined : [...p.need ?? []].find((n) => !needOk(n, arg));
      const key = `${mod.file}:${node.pos}:${p.id}`;
      if (seen.has(key)) continue;
      if (bad) { seen.add(key); this.rep.at(mod, "E2002", node, `'${show(arg)}' cannot instantiate '${p.name}' (${bad} condition)`); }
      else if (p.owner === "rt" && hasAuthority(arg)) { seen.add(key); this.rep.at(mod, "E4006", node, `'${show(arg)}' cannot instantiate '${p.name}' of an rt function (§6)`); }
      else if (p.owner && p.owner !== "managed" && !layerOk(arg)) { seen.add(key); this.rep.at(mod, "E4002", node, `'${show(arg)}' cannot instantiate '${p.name}' of a strict / rt function (§3.3)`); }
    }
  }

  lookupType(mod: Module, name: string, depth = 0): TypeSym | undefined {
    const own = mod.types.get(name);
    if (own || depth > 8) return own;
    const imp = mod.imports.get(name);
    if (!imp) return undefined;
    const local = imp.mod.exports.get(imp.name);
    return local === undefined ? undefined : this.lookupType(imp.mod, local, depth + 1);
  }
  lookupValue(mod: Module, name: string, depth = 0): ValueSym | undefined {
    const own = mod.values.get(name);
    if (own || depth > 8) return own;
    const imp = mod.imports.get(name);
    if (!imp) return undefined;
    const local = imp.mod.exports.get(imp.name);
    return local === undefined ? undefined : this.lookupValue(imp.mod, local, depth + 1);
  }

  /** Resolves a type node (§3, §12). Unknown names are E2000; errors become ERROR (Q003 cascade). */
  /** `voidOk`: the node is a return type, where `void` may be written (Q028). */
  typeOf(t: ts.TypeNode, e: TypeEnv, voidOk = false): Type {
    switch (t.kind) {
      case K.BooleanKeyword: return builtinType("boolean")!;
      case K.StringKeyword: return builtinType("string")!;
      case K.NumberKeyword: return builtinType("number")!;
      case K.VoidKeyword:
        if (voidOk) return VOID;
        this.rep.at(e.mod, "E2002", t, "'void' can only be a return type"); // Q028
        return ERROR;
      case K.UnknownKeyword: return builtinType("unknown")!;
      case K.NeverKeyword: return builtinType("never")!;
      case K.BigIntKeyword: case K.UndefinedKeyword:
        this.rep.at(e.mod, "E2000", t, `'${t.getText(e.mod.sf)}' does not exist`);
        return ERROR;
      case K.LiteralType: {
        const l = (t as ts.LiteralTypeNode).literal;
        return l.kind === K.NullKeyword ? NULL : { k: "lit", value: (l as ts.StringLiteral).text };
      }
      case K.ParenthesizedType: return this.typeOf((t as ts.ParenthesizedTypeNode).type, e, voidOk);
      case K.UnionType: { // §3.2: tagged unions, string-literal unions and `T | null` only (Q080)
        const u = union((t as ts.UnionTypeNode).types.map((x) => this.typeOf(x, e)));
        if (u.k === "union" && u.members.some((m) => m.k === "error")) return ERROR;
        if (!legalUnion(u)) { this.rep.at(e.mod, "E2002", t, `'${show(u)}' is not a tagged union, a string-literal union or 'T | null'`); return ERROR; }
        return u;
      }
      case K.TypeLiteral: return this.recordOf(t as ts.TypeLiteralNode, e, false);
      case K.FunctionType: {
        const f = t as ts.FunctionTypeNode;
        return this.signature(f, undefined, e);
      }
      case K.TypeReference: {
        const r = t as ts.TypeReferenceNode;
        const id = r.typeName as ts.Identifier;
        // Q130: a Promise type is only the whole return type of a function (not a type argument, field, parameter or variable)
        if (id.text === "Promise" && !e.tparams.has("Promise") && !(voidOk && r.parent.kind !== K.TypeReference)) {
          this.rep.at(e.mod, "E2002", r, "'Promise' can only be the return type of a function");
          return ERROR;
        }
        return this.typeRef(id, r.typeArguments, r, e);
      }
    }
    throw new Error(`P2: unhandled type kind ${t.kind}`); // P1 rejects every other kind
  }

  private recordOf(t: ts.TypeLiteralNode, e: TypeEnv, struct: boolean): Type {
    const fields: Field[] = [];
    for (const m of t.members) {
      const p = m as ts.PropertySignatureDeclaration;
      if (!p.type) { this.rep.at(e.mod, "E2006", p.name, "property needs a type annotation"); return ERROR; }
      const name = (p.name as ts.Identifier).text;
      const type = this.typeOf(p.type, e);
      if (struct && !demand(type, "field") && !(type.k === "gen" && (type.name === "Ref" || type.name === "Mut"))) this.rep.at(e.mod, "E2002", p.type, `a Struct field is a number, boolean, Struct or Vec, not '${show(type)}'`); // Q086; a borrow field is P3's E3004 (§5.5)
      fields.push({ name, type, readonly: hasMod(p, K.ReadonlyKeyword) });
    }
    return record(fields, struct);
  }

  typeRef(id: ts.Identifier, argNodes: ts.NodeArray<ts.TypeNode> | undefined, whole: Node, e: TypeEnv): Type {
    const name = id.text;
    const args = (argNodes ?? []).map((a) => (name === "Struct" ? ERROR : this.typeOf(a, e, name === "Promise"))); // `Promise<void>` (Q028)
    const arity = (n: number): boolean => {
      if (args.length === n) return true;
      this.rep.at(e.mod, "E2002", whole, `'${name}' takes ${n} type argument(s)`);
      return false;
    };
    const tp = e.tparams.get(name);
    if (tp) return arity(0) ? { k: "tparam", p: tp } : ERROR;
    const sym = this.lookupType(e.mod, name);
    if (sym) {
      if (sym.k === "alias" && sym.busy) { this.rep.at(e.mod, "E2002", whole, `type alias '${name}' refers to itself`); return ERROR; } // Q085
      const body = sym.k === "alias" ? this.aliasBody(sym) : undefined;
      const ps = sym.k === "alias" ? sym.tparams! : sym.k === "class" ? sym.cls.tparams : sym.iface.tparams;
      if (!arity(ps.length)) return ERROR;
      const bad = ps.findIndex((p, i) => p.constraint && args[i]!.k !== "error" && !assignable(args[i]!, subst(p.constraint, bindTParams(ps, args))));
      if (bad >= 0) { this.rep.at(e.mod, "E2002", argNodes![bad]!, `type argument does not implement '${show(ps[bad]!.constraint!)}'`); return ERROR; }
      ps.forEach((p, i) => this.insts.push({ mod: e.mod, node: argNodes![i]!, p, arg: args[i]! })); // Q127
      if (body) return subst(body, bindTParams(ps, args));
      return sym.k === "iface" ? { k: "iface", iface: sym.iface, args } : { k: "class", cls: (sym as Extract<TypeSym, { k: "class" }>).cls, args };
    }
    if (name === "Struct") {
      const a = argNodes?.[0];
      if (argNodes?.length !== 1 || a!.kind !== K.TypeLiteral) { this.rep.at(e.mod, "E2002", whole, "Struct takes one record type literal"); return ERROR; }
      return this.recordOf(a as ts.TypeLiteralNode, e, true);
    }
    if (name === "Result") return arity(2) ? result(args[0]!, args[1]!) : ERROR;
    if (isGenName(name)) {
      if (!arity(GEN_ARITY[name])) return ERROR;
      if ((name === "Ref" || name === "Mut")) { // Q051
        const a = args[0]!;
        if (!demand(a, "borrow")) {
          this.rep.at(e.mod, "E2002", argNodes![0]!, `${name}<T> needs an owned type or Slice`);
          return ERROR;
        }
      }
      if (args.some((a) => a.k === "error")) return ERROR;
      if ((name === "Map" || name === "Set") && !demand(args[0]!, "key")) { // §3.2, Q081, Q127
        this.rep.at(e.mod, "E2002", argNodes![0]!, `a ${name} ${name === "Map" ? "key" : "element"} is a string, number, boolean or string literal union, not '${show(args[0]!)}'`);
        return ERROR;
      }
      if ((name === "Vec" || name === "Slice") && !demand(args[0]!, "copy")) { // §3.3, Q086, Q127
        this.rep.at(e.mod, "E2002", argNodes![0]!, `${name}<T> needs a Copy element type, not '${show(args[0]!)}'`);
        return ERROR;
      }
      return { k: "gen", name, args };
    }
    const b = !RESERVED.has(name) ? builtinType(name) : undefined;
    if (b) return arity(0) ? b : ERROR;
    this.rep.at(e.mod, "E2000", id, `unknown type '${name}'`);
    return ERROR;
  }
}

/** §3.2 (Q080): after removing `null`, a union is a tagged union with distinct `kind` literals or all string literals. */
export function legalUnion(u: Type): boolean {
  const rest = u.k === "union" ? nonNull(u) ?? u : u;
  if (rest.k !== "union" || rest.members.every((m) => m.k === "lit")) return true;
  return isTaggedUnion(rest) && new Set(rest.members.map(kindOf)).size === rest.members.length;
}

export interface TypeEnv { mod: Module; tparams: Map<string, TParam> }

export const tparamShells = (list: ts.NodeArray<ts.TypeParameterDeclaration> | undefined, owner?: "managed"): TParam[] => (list ?? []).map((d) => ({ ...newTParam(d.name.text), need: new Set(["nopromise"] as const), ...(owner ? { owner } : {}) }));
