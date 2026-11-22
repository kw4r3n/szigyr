// P2 declarations (D011): one Module per file, top-level symbols, imports, type-node resolution, signatures, layers.
// Signatures come from annotations only (§10: "シグネチャはすべて注釈されているので、構文だけから取り出せる").
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Diagnostic } from "./diagnostics.ts";
import { NodeFlags, SyntaxKind as K, hasMod, isId, type Node, type ParsedFile, type ts } from "./parse.ts";
/** The absolute path with symlinks resolved, so one file reached through two names is one module (Q253). A path that does not exist stays as resolved (E7001). */
export function canonPath(...p: string[]): string {
  const r = resolve(...p);
  try { return realpathSync(r); } catch { return r; }
}
import { CAPABILITY_NAMES, RESERVED, builtinType, isGenName } from "./builtins.ts";
import {
  ERROR, GEN_ARITY, NULL, VOID, gen, assignable, bindTParams, borrowOk, collectTParams, crossOk, crossTParams, fn, isTaggedUnion, sendable, hasArenaBuf, hasAuthority, hasCap, hasLayout, field, isNative, keyOk, kindOf, layerOk, promiseIn, structField, tparamHasCap, tparamMayBeAuthority, holdsOwned, ownedDeep, CONTAINERS, newTParam, nonNull, record, result, show, subst, union,
  type Capability, type ClassSym, type Field, type FnType, type IfaceSym, type TParam, type Type,
  hasLoneSurrogate,
} from "./types.ts";

export type Layer = "managed" | "strict" | "rt";

export interface FnSym { k: "fn"; name: string; decl: ts.FunctionDeclaration; mod: Module; layer: Layer; sig: FnType; unsafe: boolean }
/** A C function from a `declare module "c:..."` block (§14.1): callable, never a value. */
export interface CFnSym { k: "cfn"; name: string; decl: ts.FunctionDeclaration; mod: Module; spec: string; sig: FnType }
/** A C constant from a `declare module "c:..."` block (SPEC-v1 §9). */
export interface CConstSym { k: "cconst"; name: string; decl: ts.VariableDeclaration; mod: Module; spec: string; type: Type }
/** A C struct from a `declare module "c:..."` block (SPEC-v1 §9). */
export interface CStructSym { k: "cstruct"; name: string; decl: ts.TypeAliasDeclaration; mod: Module; spec: string; type: Extract<Type, { k: "cstruct" }> | { k: "error" } }
/** `bind`: the element of a record destructuring (`const { a, b }: T = ...`, Q225 (b)); `type` is then the field's type. */
export interface ConstSym { k: "const"; decl: ts.VariableDeclaration; mod: Module; type: Type; bind?: ts.BindingElement }
export interface ClassValueSym { k: "class"; cls: ClassSym; mod: Module }
/** `declared`: the annotated type before Ref / Mut are read through (contracts, Q056). */
export interface LocalSym {
  k: "local"; id: number; name: string; type: Type; declared: Type; mutable: boolean; param: boolean; fnDepth: number;
  /** Captured by a nested function and assigned after its declaration: never narrowed (Q122). */
  unstable?: boolean;
}
export type ValueSym = FnSym | ConstSym | ClassValueSym | CFnSym | CConstSym | { k: "jsref" } | { k: "error" } | LocalSym;

export type TypeSym =
  | { k: "alias"; decl: ts.TypeAliasDeclaration; mod: Module; tparams?: TParam[]; body?: Type; busy?: boolean }
  | { k: "class"; cls: ClassSym; mod: Module }
  | { k: "iface"; iface: IfaceSym; decl: ts.InterfaceDeclaration; mod: Module }
  | CStructSym
  | { k: "error" };

export type ExportEntry =
  | { k: "local"; local: string; typeOnly: boolean }
  | { k: "reexport"; mod: Module; name: string; typeOnly: boolean };

export interface Module {
  pf: ParsedFile;
  file: string;
  sf: ts.SourceFile;
  /** File directive (Q039); applies to module-level `function` declarations only. */
  layer: Layer;
  values: Map<string, ValueSym>;
  types: Map<string, TypeSym>;
  /** exported name -> local or re-exported symbol entry */
  exports: Map<string, ExportEntry>;
  /** local name -> imported module and exported name (relative imports only) */
  imports: Map<string, { mod: Module; name: string; typeOnly: boolean }>;
  /** local name -> module namespace import (`import * as ns from "./x.szigyr"`) */
  nsImports: Map<string, { mod: Module; typeOnly: boolean }>;
  /** C value names imported as type-only, for clearer E2002 diagnostics if used in value position. */
  typeOnlyCValues: Set<string>;
  /** `declare module "c:..."` blocks of this file: specifier -> C function name -> symbol (§14.1). */
  cdecls: Map<string, Map<string, CFnSym>>;
  /** `declare module "c:..."` constants (SPEC-v1 §9). */
  cconsts: Map<string, Map<string, CConstSym>>;
  /** `declare module "c:..."` CStructs (SPEC-v1 §9). */
  cstructs: Map<string, Map<string, CStructSym>>;
}

export class Reporter {
  readonly out: Diagnostic[] = [];
  private readonly seen = new Set<string>();
  report(mod: Module, code: string, start: number, end: number, message: string, data?: Record<string, unknown>, severity: "error" | "warning" = "error"): void {
    const key = `${code} ${mod.file} ${start}`;
    if (this.seen.has(key)) return; // Q133: one per code and position
    this.seen.add(key);
    this.out.push({ code, severity, message, file: mod.file, range: { start: mod.pf.position(start), end: mod.pf.position(end) }, ...(data ? { data } : {}) });
  }
  /** Wxxxx (Q187): reported by `check`, never blocks `run` / `test`. */
  warn(mod: Module, code: string, n: Node, message: string, data?: Record<string, unknown>): void { this.report(mod, code, n.getStart(mod.sf), n.end, message, data, "warning"); }
  at(mod: Module, code: string, n: Node, message: string, data?: Record<string, unknown>): void {
    this.report(mod, code, n.getStart(mod.sf), n.end, message, data);
  }
}

const DIRECTIVE_LAYER: Record<string, Layer> = { "use owned": "strict", "use rt": "rt" };
/** The layer directive of a statement list (Q039): the first layer directive among the leading
 * string literals ("use unsafe" may sit before it, §14.4). */
export function directiveOf(list: readonly ts.Statement[]): Layer | undefined {
  for (const s of list) {
    if (s.kind !== K.ExpressionStatement || (s as ts.ExpressionStatement).expression.kind !== K.StringLiteral) break;
    const layer = DIRECTIVE_LAYER[((s as ts.ExpressionStatement).expression as ts.StringLiteral).text];
    if (layer) return layer;
  }
  return undefined;
}
/** Whether a statement list carries the `"use unsafe"` modifier among its leading directives (§14.4). */
function unsafeOf(list: readonly ts.Statement[]): boolean {
  for (const s of list) {
    if (s.kind !== K.ExpressionStatement || (s as ts.ExpressionStatement).expression.kind !== K.StringLiteral) break;
    if (((s as ts.ExpressionStatement).expression as ts.StringLiteral).text === "use unsafe") return true;
  }
  return false;
}

/** Q225 (b): the names a module-level const declaration binds: its identifier, or the names of a record destructuring
 * (with the element they come from). Tuple / array destructuring binds nothing here (P1 rejects it). */
export function declBindings(d: ts.VariableDeclaration): { id: ts.Identifier; el?: ts.BindingElement }[] {
  if (isId(d.name)) return [{ id: d.name }];
  if (d.name.kind !== K.ObjectBindingPattern) return [];
  return (d.name as ts.ObjectBindingPattern).elements.flatMap((el) => (isId(el.name) ? [{ id: el.name, el }] : []));
}

/** Syntactic exported names (including re-exports) for P1 import/export name checks. */
function exportNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const s of sf.statements) {
    if (s.kind === K.ExportDeclaration) {
      const ec = (s as ts.ExportDeclaration).exportClause;
      if (ec?.kind === K.NamedExports) for (const e of (ec as ts.NamedExports).elements) out.add(e.name.text);
      continue;
    }
    if (!hasMod(s, K.ExportKeyword)) continue;
    if (s.kind === K.VariableStatement) {
      for (const d of (s as ts.VariableStatement).declarationList.declarations) for (const b of declBindings(d)) out.add(b.id.text);
    } else {
      const name = (s as Node & { name?: Node }).name;
      if (isId(name)) out.add(name.text);
    }
  }
  return out;
}

/** Top-level declared names (values and types share one namespace for this check). */
function declaredNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const s of sf.statements) {
    if (s.kind === K.VariableStatement) for (const d of (s as ts.VariableStatement).declarationList.declarations) for (const b of declBindings(d)) out.add(b.id.text);
    else if (s.kind === K.ImportDeclaration) {
      const ic = (s as ts.ImportDeclaration).importClause;
      if (ic?.name) out.add(ic.name.text);
      const nb = ic?.namedBindings;
      if (nb?.kind === K.NamespaceImport) out.add((nb as ts.NamespaceImport).name.text);
      else if (nb?.kind === K.NamedImports) for (const e of (nb as ts.NamedImports).elements) out.add(e.name.text);
    } else { const n = (s as Node & { name?: Node }).name; if (isId(n)) out.add(n.text); }
  }
  return out;
}

/** P1 part of Q009: imported/re-exported names must be exported by the target; local exported names must exist. */
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
        const d = s as ts.ExportDeclaration;
        const ec = d.exportClause;
        if (ec?.kind !== K.NamedExports) continue;
        if (d.moduleSpecifier) {
          if (d.moduleSpecifier.kind !== K.StringLiteral) continue;
          const target = byPath.get(canonPath(dirname(pf.path), (d.moduleSpecifier as ts.StringLiteral).text));
          if (!target) continue;
          const ex = exportNames(target.sourceFile);
          for (const e of (ec as ts.NamedExports).elements) {
            const orig = (e.propertyName ?? e.name) as ts.Identifier;
            if (!ex.has(orig.text)) diag(pf, orig, `module does not export '${orig.text}'`);
          }
        } else {
          for (const e of (ec as ts.NamedExports).elements) {
            const local = (e.propertyName ?? e.name) as ts.Identifier;
            if (!own.has(local.text)) diag(pf, local, `cannot export unknown name '${local.text}'`);
          }
        }
        continue;
      }
      if (s.kind !== K.ImportDeclaration) continue;
      const d = s as ts.ImportDeclaration;
      if (d.moduleSpecifier.kind !== K.StringLiteral) continue;
      const target = byPath.get(canonPath(dirname(pf.path), (d.moduleSpecifier as ts.StringLiteral).text));
      const nb = d.importClause?.namedBindings;
      if (!target || nb?.kind !== K.NamedImports) continue;
      const ex = exportNames(target.sourceFile);
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
  /** §15.2: isolate entry functions by defining module path; the emitter exposes them to the isolate loader. */
  readonly isolateEntries = new Map<string, Set<string>>();
  /** §15.5: registered `audio.open` rt callback functions, keyed by `<path>\0<name>`. */
  readonly audioCallbacks = new Map<string, { fn: FnSym; state: Type; key: string; id: number }>();
  readonly substInsts: { mod: Module; node: Node; t: Type; args: Type[] }[] = [];
  readonly ptrSizeOfs: { mod: Module; node: Node; cname: string }[] = [];

  constructor(files: ParsedFile[], display: (p: string) => string, rep: Reporter) {
    this.rep = rep;
    for (const pf of files) {
      const sf = pf.sourceFile;
      const mod: Module = {
        pf, sf, file: display(pf.path), layer: directiveOf(sf.statements) ?? "managed",
        values: new Map(), types: new Map(), exports: new Map(), imports: new Map(), nsImports: new Map(), typeOnlyCValues: new Set(),
        cdecls: new Map(), cconsts: new Map(), cstructs: new Map(),
      };
      this.mods.push(mod);
      this.byPath.set(pf.path, mod);
    }
    for (const mod of this.mods) this.buildExports(mod);
    for (const mod of this.mods) this.shells(mod);
    for (const mod of this.mods) this.classIfaceConstraints(mod); // before any type reference is resolved (D013)
    for (const mod of this.mods) this.resolveCStructs(mod); // before signatures/aliases reference CStructs
    for (const mod of this.mods) this.signatures(mod);
  }

  private buildExports(mod: Module): void {
    for (const s of mod.sf.statements) {
      if (s.kind === K.ExportDeclaration) {
        const d = s as ts.ExportDeclaration;
        const ec = d.exportClause;
        if (ec?.kind !== K.NamedExports) continue;
        if (d.moduleSpecifier) {
          if (d.moduleSpecifier.kind !== K.StringLiteral) continue;
          const target = this.byPath.get(canonPath(dirname(mod.pf.path), (d.moduleSpecifier as ts.StringLiteral).text));
          if (!target) continue;
          for (const e of (ec as ts.NamedExports).elements) {
            if (!isId(e.name)) continue;
            const orig = (e.propertyName ?? e.name) as ts.Identifier;
            if (!isId(orig)) continue;
            mod.exports.set(e.name.text, { k: "reexport", mod: target, name: orig.text, typeOnly: !!d.isTypeOnly || e.isTypeOnly });
          }
        } else {
          for (const e of (ec as ts.NamedExports).elements) {
            if (!isId(e.name)) continue;
            const local = (e.propertyName ?? e.name) as ts.Identifier;
            if (!isId(local)) continue;
            mod.exports.set(e.name.text, { k: "local", local: local.text, typeOnly: !!d.isTypeOnly || e.isTypeOnly });
          }
        }
        continue;
      }
      if (!hasMod(s, K.ExportKeyword)) continue;
      if (s.kind === K.VariableStatement) {
        for (const d of (s as ts.VariableStatement).declarationList.declarations) {
          for (const b of declBindings(d)) mod.exports.set(b.id.text, { k: "local", local: b.id.text, typeOnly: false });
        }
      } else {
        const name = (s as Node & { name?: Node }).name;
        if (isId(name)) mod.exports.set(name.text, { k: "local", local: name.text, typeOnly: false });
      }
    }
  }

  private shells(mod: Module): void {
    // §14.1: `declare module "c:..."` blocks first, so a `c:` import binds wherever it is written
    for (const s of mod.sf.statements) {
      if (s.kind !== K.ModuleDeclaration) continue;
      const d = s as ts.ModuleDeclaration;
      if (d.name.kind !== K.StringLiteral || d.body?.kind !== K.ModuleBlock) continue;
      const spec = (d.name as ts.StringLiteral).text;
      if (!spec.startsWith("c:")) continue;
      const table = mod.cdecls.get(spec) ?? new Map<string, CFnSym>();
      const ctable = mod.cconsts.get(spec) ?? new Map<string, CConstSym>();
      const stable = mod.cstructs.get(spec) ?? new Map<string, CStructSym>();
      mod.cdecls.set(spec, table);
      mod.cconsts.set(spec, ctable);
      mod.cstructs.set(spec, stable);
      for (const st of (d.body as ts.ModuleBlock).statements) {
        if (st.kind === K.FunctionDeclaration) {
          const f = st as ts.FunctionDeclaration;
          if (f.name && !table.has(f.name.text)) table.set(f.name.text, { k: "cfn", name: f.name.text, decl: f, mod, spec, sig: fn([], ERROR) });
        } else if (st.kind === K.VariableStatement) {
          const dl = (st as ts.VariableStatement).declarationList;
          if (!(dl.flags & NodeFlags.Const)) continue;
          for (const vd of dl.declarations) {
            if (isId(vd.name) && !ctable.has(vd.name.text)) ctable.set(vd.name.text, { k: "cconst", name: vd.name.text, decl: vd, mod, spec, type: ERROR });
          }
        } else if (st.kind === K.TypeAliasDeclaration) {
          const ta = st as ts.TypeAliasDeclaration;
          if (ta.name && !stable.has(ta.name.text)) stable.set(ta.name.text, { k: "cstruct", name: ta.name.text, decl: ta, mod, spec, type: { k: "cstruct", name: ta.name.text, spec, fields: [] } });
        }
      }
    }
    for (const s of mod.sf.statements) {
      switch (s.kind) {
        case K.ImportDeclaration: {
          const d = s as ts.ImportDeclaration;
          if (d.moduleSpecifier.kind !== K.StringLiteral) break;
          const spec = (d.moduleSpecifier as ts.StringLiteral).text;
          const ic = d.importClause;
          const declTypeOnly = ic?.phaseModifier === K.TypeKeyword;
          const nb = ic?.namedBindings;
          if (spec.startsWith("npm:")) {
            if (declTypeOnly) {
              if (ic?.name) { mod.values.set(ic.name.text, { k: "error" }); mod.types.set(ic.name.text, { k: "error" }); }
              if (nb?.kind === K.NamespaceImport) { mod.values.set((nb as ts.NamespaceImport).name.text, { k: "error" }); mod.types.set((nb as ts.NamespaceImport).name.text, { k: "error" }); }
              else if (nb?.kind === K.NamedImports) for (const e of (nb as ts.NamedImports).elements) { mod.values.set(e.name.text, { k: "error" }); mod.types.set(e.name.text, { k: "error" }); }
              break;
            }
            if (ic?.name) mod.values.set(ic.name.text, { k: "jsref" });
            if (nb?.kind === K.NamespaceImport) mod.values.set((nb as ts.NamespaceImport).name.text, { k: "jsref" });
            else if (nb?.kind === K.NamedImports) {
              for (const e of (nb as ts.NamedImports).elements) {
                mod.values.set(e.name.text, e.isTypeOnly ? { k: "error" } : { k: "jsref" }); // §7.4
              }
            }
            break;
          }
          if (spec.startsWith("c:")) { // §14.1: binds this file's own declarations, never another file
            if (ic?.name) { mod.values.set(ic.name.text, { k: "error" }); mod.types.set(ic.name.text, { k: "error" }); }
            if (nb?.kind === K.NamespaceImport) { mod.values.set((nb as ts.NamespaceImport).name.text, { k: "error" }); mod.types.set((nb as ts.NamespaceImport).name.text, { k: "error" }); break; }
            if (nb?.kind !== K.NamedImports) break;
            const fns = mod.cdecls.get(spec);
            const consts = mod.cconsts.get(spec);
            const structs = mod.cstructs.get(spec);
            for (const e of (nb as ts.NamedImports).elements) {
              const orig = (e.propertyName ?? e.name) as ts.Identifier;
              if (!isId(orig)) { mod.values.set(e.name.text, { k: "error" }); mod.types.set(e.name.text, { k: "error" }); continue; }
              const isTO = declTypeOnly || e.isTypeOnly;
              const vs = fns?.get(orig.text) ?? consts?.get(orig.text);
              const ts = structs?.get(orig.text);
              if (vs) {
                if (isTO) mod.typeOnlyCValues.add(e.name.text);
                else mod.values.set(e.name.text, vs);
              } else if (ts) mod.types.set(e.name.text, ts);
              else { mod.values.set(e.name.text, { k: "error" }); mod.types.set(e.name.text, { k: "error" }); }
            }
            break;
          }
          const target = this.byPath.get(canonPath(dirname(mod.pf.path), spec));
          if (ic?.name) { mod.values.set(ic.name.text, { k: "error" }); mod.types.set(ic.name.text, { k: "error" }); }
          if (nb?.kind === K.NamespaceImport) {
            const nsId = (nb as ts.NamespaceImport).name;
            if (target) mod.nsImports.set(nsId.text, { mod: target, typeOnly: declTypeOnly });
            else { mod.values.set(nsId.text, { k: "error" }); mod.types.set(nsId.text, { k: "error" }); }
            break;
          }
          if (!nb || nb.kind !== K.NamedImports) break;
          for (const e of (nb as ts.NamedImports).elements) {
            const orig = (e.propertyName ?? e.name) as ts.Identifier;
            if (target && isId(orig) && target.exports.has(orig.text)) mod.imports.set(e.name.text, { mod: target, name: orig.text, typeOnly: declTypeOnly || e.isTypeOnly });
            else { mod.values.set(e.name.text, { k: "error" }); mod.types.set(e.name.text, { k: "error" }); }
          }
          break;
        }
        case K.TypeAliasDeclaration: { const d = s as ts.TypeAliasDeclaration; if (d.name && d.type) mod.types.set(d.name.text, { k: "alias", decl: d, mod }); break; }
        case K.InterfaceDeclaration: {
          const d = s as ts.InterfaceDeclaration;
          if (!d.name) break;
          mod.types.set(d.name.text, { k: "iface", decl: d, mod, iface: { name: d.name.text, tparams: tparamShells(d.typeParameters, "managed"), methods: new Map() } });
          break;
        }
        case K.ClassDeclaration: {
          const d = s as ts.ClassDeclaration;
          if (!d.name) break;
          const cls: ClassSym = { name: d.name.text, decl: d, tparams: tparamShells(d.typeParameters, "managed"), fields: new Map(), methods: new Map(), ctor: fn([], VOID), implements: [] };
          mod.types.set(cls.name, { k: "class", cls, mod });
          mod.values.set(cls.name, { k: "class", cls, mod });
          break;
        }
        case K.FunctionDeclaration: {
          const d = s as ts.FunctionDeclaration;
          if (!d.name || !d.body) break;
          const f: FnSym = { k: "fn", name: d.name.text, decl: d, mod, layer: directiveOf(d.body.statements) ?? mod.layer, sig: fn([], ERROR), unsafe: unsafeOf(d.body.statements) };
          mod.values.set(f.name, f);
          this.fns.push(f);
          break;
        }
        case K.VariableStatement:
          for (const d of (s as ts.VariableStatement).declarationList.declarations) for (const b of declBindings(d)) mod.values.set(b.id.text, { k: "const", decl: d, mod, type: ERROR, bind: b.el });
          break;
      }
    }
  }

  /** Constraints of class and interface type parameters, so that every `Box<X>` reference can be checked (§3.2). */
  private classIfaceConstraints(mod: Module): void {
    for (const t of mod.types.values()) {
      if (t.k === "error" || t.mod !== mod || t.k === "alias" || t.k === "cstruct") continue;
      const [decl, ps] = t.k === "iface" ? [t.decl, t.iface.tparams] : [t.cls.decl, t.cls.tparams];
      this.constraints(decl.typeParameters, ps, { mod, tparams: new Map(ps.map((p) => [p.name, p])) });
    }
  }

  /** Resolves `type S = CStruct<{ ... }>` declarations in `c:` modules before general signatures (SPEC-v1 §9). */
  private resolveCStructs(mod: Module): void {
    for (const table of mod.cstructs.values()) {
      const ce: TypeEnv = { mod, tparams: new Map(), cscope: table };
      for (const cs of table.values()) {
        const ta = cs.decl;
        const tr = ta.type?.kind === K.TypeReference ? (ta.type as ts.TypeReferenceNode) : undefined;
        const arg0 = tr && isId(tr.typeName) && tr.typeName.text === "CStruct" && tr.typeArguments?.length === 1 ? tr.typeArguments[0] : undefined;
        if (!arg0 || arg0.kind !== K.TypeLiteral) { cs.type = { k: "error" }; continue; }
        const fields: Field[] = [];
        for (const m of (arg0 as ts.TypeLiteralNode).members) {
          if (m.kind !== K.PropertySignature) continue;
          const p = m as ts.PropertySignatureDeclaration;
          if (!isId(p.name)) continue;
          fields.push({ name: p.name.text, type: p.type ? this.typeOf(p.type, ce) : ERROR, readonly: hasMod(p, K.ReadonlyKeyword) });
        }
        if (cs.type.k === "cstruct") cs.type.fields = fields;
      }
      const cyclic: CStructSym[] = [];
      for (const cs of table.values()) {
        if (cs.type.k !== "cstruct") continue;
        const visited = new Set<string>();
        const reachesSelf = (t: Type): boolean => {
          if (t.k !== "cstruct") return false;
          if (t.name === cs.name) return true;
          if (visited.has(t.name)) return false;
          visited.add(t.name);
          return t.fields.some((f) => reachesSelf(f.type));
        };
        if (cs.type.fields.some((f) => reachesSelf(f.type))) cyclic.push(cs);
      }
      for (const cs of cyclic) {
        this.rep.at(mod, "E2002", cs.decl.name, `CStruct '${cs.name}' contains itself by value`);
        if (cs.type.k === "cstruct") cs.type.fields = [];
        cs.type = { k: "error" };
      }
    }
  }

  private signatures(mod: Module): void {
    const env = (tps: TParam[] = [], cscope?: Map<string, CStructSym>): TypeEnv =>
      ({ mod, tparams: new Map(tps.map((p) => [p.name, p])), ...(cscope ? { cscope } : {}) });
    for (const t of mod.types.values()) {
      if (t.k === "error" || t.mod !== mod || t.k === "cstruct") continue;
      if (t.k === "alias") this.aliasBody(t);
      else if (t.k === "iface") {
        const e = env(t.iface.tparams);
        for (const m of t.decl.members) {
          if (m.kind !== K.MethodSignature) continue;
          const ms = m as ts.MethodSignatureDeclaration;
          if (ms.name && isId(ms.name)) t.iface.methods.set(ms.name.text, this.signature(ms, ms.name, e));
        }
      }
    }
    for (const [spec, table] of mod.cconsts) {
      const ce = env([], mod.cstructs.get(spec));
      for (const cc of table.values()) cc.type = cc.decl.type ? this.typeOf(cc.decl.type, ce) : ERROR;
    }
    for (const [spec, table] of mod.cdecls) {
      const ce = env([], mod.cstructs.get(spec));
      for (const cs of table.values()) cs.sig = this.signature(cs.decl, cs.decl.name!, ce);
    }
    for (const v of mod.values.values()) {
      if (v.k === "fn" && v.mod === mod) {
        v.sig = this.signature(v.decl, v.decl.name!, env(), true, v.layer, true);
        for (const t of v.sig.params) if (t.k !== "fn") for (const p of crossTParams(t)) p.inParam = true; // Q233
      }
      else if (v.k === "class" && v.mod === mod) this.classMembers(v.cls, env(v.cls.tparams));
      else if (v.k === "const" && v.mod === mod) {
        if (!v.decl.type) { if (!v.bind || v.bind === (v.decl.name as ts.ObjectBindingPattern).elements.find((el) => isId(el.name))) this.rep.at(mod, "E2006", v.decl.name, "module-level const needs a type annotation"); } // once per declaration
        else if (!v.bind) v.type = this.typeOf(v.decl.type, env());
        else { // Q225 (b): the field of the annotated record
          const whole = this.typeOf(v.decl.type, env());
          const key = (v.bind.propertyName ?? v.bind.name) as ts.Identifier;
          if (!isId(key)) continue;
          const f = whole.k === "record" ? field(whole, key.text) : undefined;
          if (f) v.type = f.type;
          else if (whole.k !== "error") this.rep.at(mod, "E2002", key, whole.k === "record" ? `no field '${key.text}'` : "only records can be destructured");
        }
      }
    }
  }

  private classMembers(cls: ClassSym, e: TypeEnv): void {
    const mod = e.mod;
    for (const h of cls.decl.heritageClauses ?? []) for (const t of h.types) {
      if (isId(t.expression)) cls.implements.push(this.typeRef(t.expression, t.typeArguments, t, e));
      else if (t.expression.kind === K.PropertyAccessExpression && isId((t.expression as ts.PropertyAccessExpression).expression) && isId((t.expression as ts.PropertyAccessExpression).name)) {
        const pa = t.expression as ts.PropertyAccessExpression;
        cls.implements.push(this.qualifiedTypeRef(pa.expression as ts.Identifier, pa.name as ts.Identifier, t.typeArguments, t, e));
      }
    }
    for (const m of cls.decl.members) {
      if (m.kind === K.PropertyDeclaration) {
        const p = m as ts.PropertyDeclaration;
        if (!isId(p.name)) continue;
        const name = p.name.text;
        if (!p.type) this.rep.at(mod, "E2006", p.name, "field needs a type annotation");
        cls.fields.set(name, {
          type: p.type ? this.typeOf(p.type, e) : ERROR, readonly: hasMod(p, K.ReadonlyKeyword),
          private: hasMod(p, K.PrivateKeyword), static: hasMod(p, K.StaticKeyword), node: p,
        });
      } else if (m.kind === K.MethodDeclaration) {
        const md = m as ts.MethodDeclaration;
        if (isId(md.name)) cls.methods.set(md.name.text, { sig: this.signature(md, md.name, e), private: hasMod(md, K.PrivateKeyword), static: hasMod(md, K.StaticKeyword), node: md });
      } else if (m.kind === K.Constructor) {
        cls.ctor = this.signature(m as ts.ConstructorDeclaration, undefined, e);
      }
    }
  }

  /** Q022: parameters always annotated; return annotated for named functions and methods (anchor: the name). */
  signature(d: ts.SignatureDeclaration, name: Node | undefined, outer: TypeEnv, requireRet = true, owner: Layer = "managed", allowOwned = false): FnType {
    const tparams = tparamShells(d.typeParameters, owner, allowOwned);
    const e: TypeEnv = { mod: outer.mod, tparams: new Map([...outer.tparams, ...tparams.map((p) => [p.name, p] as const)]), ...(outer.cscope ? { cscope: outer.cscope } : {}) };
    this.constraints(d.typeParameters, tparams, e);
    const params = d.parameters.map((p) => {
      if (!isId(p.name)) return ERROR;
      if (!p.type) { this.rep.at(e.mod, "E2006", p.name, "parameter needs a type annotation"); return ERROR; }
      return this.typeOf(p.type, e);
    });
    let ret: Type = VOID;
    if (d.type) ret = this.typeOf(d.type, e, true);
    else if (name && requireRet) { this.rep.at(e.mod, "E2006", name, "return type annotation is required"); ret = ERROR; }
    return { ...fn(params, ret, tparams) };
  }

  /** Resolves `T extends C` / `T extends C1 & C2` into capability bounds or a single interface constraint (SPEC-v1 §3.4). */
  resolveConstraint(node: ts.TypeNode, p: TParam, e: TypeEnv): void {
    const branches = node.kind === K.IntersectionType ? (node as ts.IntersectionTypeNode).types
      : node.kind === K.TypeReference ? [node as ts.TypeReferenceNode] : undefined;
    if (!branches) return;
    const caps = new Set<Capability>();
    let iface: Type | undefined;
    for (const b of branches) {
      const ref = b as ts.TypeReferenceNode;
      if (isId(ref.typeName) && CAPABILITY_NAMES.has(ref.typeName.text)) {
        if (ref.typeArguments?.length) {
          this.rep.at(e.mod, "E2002", ref, `capability '${ref.typeName.text}' does not take type arguments`);
          return;
        }
        caps.add(ref.typeName.text as Capability);
        continue;
      }
      const c = this.typeOf(b, e);
      if (c.k === "error") return;
      if (c.k !== "iface") {
        this.rep.at(e.mod, "E2002", b, "a constraint must be a capability (Copy, Native, Owned, Send, Key, Codec) or an interface");
        return;
      }
      if (iface) { this.rep.at(e.mod, "E2002", b, "cannot combine multiple interface constraints"); return; }
      iface = c;
    }
    if (iface && caps.size > 0) {
      this.rep.at(e.mod, "E2002", node, "cannot combine an interface constraint with capability bounds");
      return;
    }
    if (caps.has("Owned") && (caps.has("Copy") || caps.has("Key") || caps.has("Codec"))) {
      const other = caps.has("Copy") ? "Copy" : caps.has("Key") ? "Key" : "Codec";
      this.rep.at(e.mod, "E2002", node, `contradictory type parameter bounds: '${other}' and 'Owned'`);
      return;
    }
    if (iface) p.constraint = iface;
    if (caps.size > 0) p.caps = caps;
  }

  private constraints(decls: ts.NodeArray<ts.TypeParameterDeclaration> | undefined, ps: TParam[], e: TypeEnv): void {
    decls?.forEach((d, i) => { if (d.constraint) this.resolveConstraint(d.constraint, ps[i]!, e); });
  }

  aliasBody(a: Extract<TypeSym, { k: "alias" }>): Type {
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

  /**
   * Q174 (D092): an alias / class / interface instantiation that holds a container of owned values only through the
   * substitution (`Bx<Vec<f32>>` for `type Bx<T> = { readonly xs: Array<T> }`) is E3007 at the written instantiation.
   * An argument that already holds one was reported where it is written.
   */
  private checkSubstInsts(): void {
    for (const { mod, node, t, args } of this.substInsts) {
      if (!args.some((a) => ownedDeep(a)) && ownedDeep(t)) this.rep.at(mod, "E3007", node, `'${show(t)}' holds a managed container of an owned type`, { kind: "managed-owned", actual: show(t) });
    }
  }

  /** Checks every generic instantiation against explicit capability bounds, Promise exclusion, and layer rules (SPEC-v1 §3.4). */
  checkInsts(): void {
    this.checkSubstInsts();
    const seen: Set<string> = new Set();
    for (const { mod, node, p, arg } of this.insts) {
      const key = `${mod.file}:${node.pos}:${p.id}`;
      if (seen.has(key) || arg.k === "error") continue;
      const fail = (code: string, msg: string, data?: Record<string, unknown>): void => { seen.add(key); this.rep.at(mod, code, node, msg, data); };

      if (p.noPromise && arg.k !== "tparam" && promiseIn(arg)) {
        fail("E2002", `'${show(arg)}' cannot instantiate '${p.name}' (Promise cannot be a type argument)`, { kind: "promise-tparam", param: p.name, actual: show(arg) });
        continue;
      }
      if (p.owner === "rt") {
        if (hasAuthority(arg)) { fail("E4006", `'${show(arg)}' cannot instantiate '${p.name}' of an rt function`, { layer: "rt", actual: show(arg) }); continue; }
        if (arg.k === "tparam" && tparamMayBeAuthority(arg.p)) {
          fail("E4006", `'${arg.p.name}' may hold an authority and cannot instantiate '${p.name}' of an rt function`, { layer: "rt", actual: arg.p.name });
          continue;
        }
      }
      let capFailed = false;
      for (const cap of p.caps ?? []) {
        if (!hasCap(arg, cap, !p.inParam)) {
          const code = cap === "Send" ? "E2010" : cap === "Native" ? "E4002" : "E2002";
          fail(code, `'${show(arg)}' cannot instantiate '${p.name}' (requires '${cap}')`, { requiredCap: cap, actual: show(arg), param: p.name });
          capFailed = true;
          break;
        }
      }
      if (capFailed) continue;
      if (p.owner && p.owner !== "managed") {
        if (arg.k === "tparam") {
          if (!tparamHasCap(arg.p, "Native")) {
            fail("E4002", `the managed type parameter '${arg.p.name}' cannot instantiate '${p.name}' of a strict / rt function`, { layer: p.owner, actual: arg.p.name, requiredCap: "Native" });
          }
        } else if (!isNative(arg, !p.inParam) || !crossOk(arg, !p.inParam)) {
          fail("E4002", `'${show(arg)}' cannot instantiate '${p.name}' of a strict / rt function`, { layer: p.owner, actual: show(arg), requiredCap: "Native" });
        }
      }
    }
  }

  /** Follows import/export/re-export chains of any length; a cycle resolves to nothing (Q226). `table` picks the symbol table: types or values. */
  private followLocal<S>(mod: Module, name: string, table: (m: Module) => Map<string, S>, seen: Set<string>, allowTypeOnly: boolean): { sym: S; typeOnly: boolean } | undefined {
    const hop = `L\0${mod.file}\0${name}`;
    if (seen.has(hop)) return undefined;
    seen.add(hop);
    const own = table(mod).get(name);
    if (own) return { sym: own, typeOnly: false };
    const imp = mod.imports.get(name);
    if (!imp) return undefined;
    if (!allowTypeOnly && imp.typeOnly) return undefined;
    const res = this.followExport(imp.mod, imp.name, table, seen, allowTypeOnly);
    return res ? { sym: res.sym, typeOnly: res.typeOnly || imp.typeOnly } : undefined;
  }
  private followExport<S>(mod: Module, name: string, table: (m: Module) => Map<string, S>, seen: Set<string>, allowTypeOnly: boolean): { sym: S; typeOnly: boolean } | undefined {
    const hop = `E\0${mod.file}\0${name}`;
    if (seen.has(hop)) return undefined;
    seen.add(hop);
    const exp = mod.exports.get(name);
    if (!exp) return undefined;
    if (!allowTypeOnly && exp.typeOnly) return undefined;
    const res = exp.k === "local"
      ? this.followLocal(mod, exp.local, table, seen, allowTypeOnly)
      : this.followExport(exp.mod, exp.name, table, seen, allowTypeOnly);
    return res ? { sym: res.sym, typeOnly: res.typeOnly || exp.typeOnly } : undefined;
  }
  lookupType(mod: Module, name: string): TypeSym | undefined { return this.followLocal(mod, name, (m) => m.types, new Set(), true)?.sym; }
  lookupValue(mod: Module, name: string): ValueSym | undefined { return this.followLocal(mod, name, (m) => m.values, new Set(), false)?.sym; }
  lookupExportedType(mod: Module, name: string): TypeSym | undefined { return this.followExport(mod, name, (m) => m.types, new Set(), true)?.sym; }
  lookupExportedValue(mod: Module, name: string): ValueSym | undefined { return this.followExport(mod, name, (m) => m.values, new Set(), false)?.sym; }
  isTypeOnlyValue(mod: Module, name: string): boolean {
    return mod.typeOnlyCValues.has(name) || mod.imports.get(name)?.typeOnly === true || this.followLocal(mod, name, (m) => m.values, new Set(), true)?.typeOnly === true;
  }
  isExportedTypeOnly(mod: Module, name: string): boolean {
    return mod.exports.get(name)?.typeOnly === true || this.followExport(mod, name, (m) => m.values, new Set(), true)?.typeOnly === true;
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
      case K.BigIntKeyword: case K.UndefinedKeyword: {
        const name = t.getText(e.mod.sf);
        this.rep.at(e.mod, "E2000", t, `'${name}' does not exist`, { name });
        return ERROR;
      }
      case K.LiteralType: {
        const l = (t as ts.LiteralTypeNode).literal;
        if (l.kind === K.NullKeyword) return NULL;
        if (l.kind !== K.StringLiteral) return ERROR;
        const v = (l as ts.StringLiteral).text;
        if (hasLoneSurrogate(v)) { this.rep.at(e.mod, "E2012", t, "a string-literal type cannot contain an unpaired surrogate", { kind: "lone-surrogate" }); return ERROR; } // Q238
        return { k: "lit", value: v };
      }
      case K.ParenthesizedType: return this.typeOf((t as ts.ParenthesizedTypeNode).type, e, voidOk);
      case K.UnionType: { // §3.2: tagged unions, string-literal unions and `T | null` only (Q080)
        const u = union((t as ts.UnionTypeNode).types.map((x) => this.typeOf(x, e)));
        if (u.k === "union" && u.members.some((m) => m.k === "error" || (m.k === "record" && m.fields.some((f) => f.type.k === "error")))) return ERROR;
        if (!legalUnion(u)) { this.rep.at(e.mod, "E2002", t, `'${show(u)}' is not a tagged union, a string-literal union or 'T | null'`, { kind: "illegal-union", actual: show(u) }); return ERROR; }
        return u;
      }
      case K.TypeLiteral: return this.recordOf(t as ts.TypeLiteralNode, e, false);
      case K.FunctionType: {
        const f = t as ts.FunctionTypeNode;
        return this.signature(f, undefined, e);
      }
      case K.ArrayType:
        return this.arrayType((t as ts.ArrayTypeNode).elementType, "Array", e);
      case K.TypeOperator: {
        const op = t as ts.TypeOperatorNode;
        if (op.operator === K.ReadonlyKeyword && op.type.kind === K.ArrayType) {
          return this.arrayType((op.type as ts.ArrayTypeNode).elementType, "ReadonlyArray", e);
        }
        return ERROR;
      }
      case K.TypeReference: {
        const r = t as ts.TypeReferenceNode;
        if (r.typeName.kind === K.QualifiedName) {
          const q = r.typeName as ts.QualifiedName;
          if (isId(q.left) && isId(q.right)) return this.qualifiedTypeRef(q.left, q.right, r.typeArguments, r, e);
          return ERROR;
        }
        if (!isId(r.typeName)) return ERROR;
        const id = r.typeName;
        // Q130: a Promise type is only the whole return type of a function (not a type argument, field, parameter or variable)
        if (id.text === "Promise" && !e.tparams.has("Promise") && !(voidOk && r.parent.kind !== K.TypeReference)) {
          this.rep.at(e.mod, "E2002", r, "'Promise' can only be the return type of a function", { kind: "promise-position" });
          return ERROR;
        }
        return this.typeRef(id, r.typeArguments, r, e);
      }
    }
    return ERROR; // P1 reports bad type syntax; recover without throwing
  }

  private recordOf(t: ts.TypeLiteralNode, e: TypeEnv, struct: boolean): Type {
    const fields: Field[] = [];
    for (const m of t.members) {
      if (m.kind !== K.PropertySignature) continue;
      const p = m as ts.PropertySignatureDeclaration;
      if (!isId(p.name)) continue;
      if (!p.type) { this.rep.at(e.mod, "E2006", p.name, "property needs a type annotation", { kind: "missing-annotation" }); return ERROR; }
      const name = p.name.text;
      const type = this.typeOf(p.type, e);
      if (struct && !structField(type) && !(type.k === "gen" && (type.name === "Ref" || type.name === "Mut"))) this.rep.at(e.mod, "E4002", p.type, `a Struct field needs a Native type, not '${show(type)}'`, { requiredCap: "Native", actual: show(type) }); // Q086; a borrow field is P3's E3004 (§5.5)
      fields.push({ name, type, readonly: hasMod(p, K.ReadonlyKeyword) });
    }
    return record(fields, struct);
  }

  private arrayType(elNode: ts.TypeNode, name: "Array" | "ReadonlyArray", e: TypeEnv): Type {
    const el = this.typeOf(elNode, e);
    if (el.k === "error") return ERROR;
    if (holdsOwned(el) && !ownedDeep(el)) {
      this.rep.at(e.mod, "E3007", elNode, `'${name}' cannot hold the owned type '${show(el)}'`, { kind: "managed-owned", container: name, actual: show(el) });
    }
    return { k: "gen", name, args: [el] };
  }

  private instantiateTypeSym(sym: TypeSym, name: string, argNodes: ts.NodeArray<ts.TypeNode> | undefined, args: Type[], whole: Node, e: TypeEnv): Type {
    const arity = (n: number): boolean => {
      if (args.length === n) return true;
      this.rep.at(e.mod, "E2002", whole, `'${name}' takes ${n} type argument(s)`);
      return false;
    };
    if (sym.k === "error") return ERROR;
    if (sym.k === "cstruct") return arity(0) ? sym.type : ERROR;
    if (sym.k === "alias" && sym.busy) { this.rep.at(e.mod, "E2002", whole, `type alias '${name}' refers to itself`); return ERROR; } // Q085
    const body = sym.k === "alias" ? this.aliasBody(sym) : undefined;
    const ps = sym.k === "alias" ? sym.tparams! : sym.k === "class" ? sym.cls.tparams : sym.iface.tparams;
    if (!arity(ps.length)) return ERROR;
    const bad = ps.findIndex((p, i) => p.constraint && args[i]!.k !== "error" && !assignable(args[i]!, subst(p.constraint, bindTParams(ps, args))));
    if (bad >= 0) { this.rep.at(e.mod, "E2002", argNodes![bad]!, `type argument does not implement '${show(ps[bad]!.constraint!)}'`); return ERROR; }
    ps.forEach((p, i) => this.insts.push({ mod: e.mod, node: argNodes![i]!, p, arg: args[i]! })); // Q127
    if (body) {
      const r = subst(body, bindTParams(ps, args));
      this.substInsts.push({ mod: e.mod, node: whole, t: r, args }); // Q174
      return r;
    }
    const t: Type = sym.k === "iface" ? { k: "iface", iface: sym.iface, args } : { k: "class", cls: (sym as Extract<TypeSym, { k: "class" }>).cls, args };
    this.substInsts.push({ mod: e.mod, node: whole, t, args }); // Q174
    return t;
  }

  qualifiedTypeRef(left: ts.Identifier, right: ts.Identifier, argNodes: ts.NodeArray<ts.TypeNode> | undefined, whole: Node, e: TypeEnv): Type {
    const args = (argNodes ?? []).map((a) => this.typeOf(a, e));
    const ns = e.mod.nsImports.get(left.text);
    if (!ns) {
      if (e.mod.types.get(left.text)?.k !== "error") this.rep.at(e.mod, "E2000", left, `unknown namespace '${left.text}'`, { name: left.text });
      return ERROR;
    }
    const sym = this.lookupExportedType(ns.mod, right.text);
    if (!sym) {
      this.rep.at(e.mod, "E2000", right, `unknown type '${left.text}.${right.text}'`, { name: `${left.text}.${right.text}` });
      return ERROR;
    }
    return this.instantiateTypeSym(sym, right.text, argNodes, args, whole, e);
  }

  typeRef(id: ts.Identifier, argNodes: ts.NodeArray<ts.TypeNode> | undefined, whole: Node, e: TypeEnv): Type {
    const name = id.text;
    const args = (argNodes ?? []).map((a) => (name === "Struct" || name === "CStruct" ? ERROR : this.typeOf(a, e, name === "Promise" || name === "Ptr" || name === "ConstPtr" || name === "CHandle"))); // `Promise<void>` (Q028); `Ptr<void>` (§14.4)
    const arity = (n: number): boolean => {
      if (args.length === n) return true;
      this.rep.at(e.mod, "E2002", whole, `'${name}' takes ${n} type argument(s)`);
      return false;
    };
    const tp = e.tparams.get(name);
    if (tp) return arity(0) ? { k: "tparam", p: tp } : ERROR;
    const sym = e.cscope?.get(name) ?? this.lookupType(e.mod, name);
    if (sym) return this.instantiateTypeSym(sym, name, argNodes, args, whole, e);
    if (name === "Struct") {
      const a = argNodes?.[0];
      if (argNodes?.length !== 1 || a!.kind !== K.TypeLiteral) { this.rep.at(e.mod, "E2002", whole, "Struct takes one record type literal"); return ERROR; }
      return this.recordOf(a as ts.TypeLiteralNode, e, true);
    }
    if (name === "CStruct") {
      this.rep.at(e.mod, "E4007", whole, `'CStruct' can only be used in a 'declare module "c:..."' type declaration`, { type: "CStruct" });
      return ERROR;
    }
    const ringElemOk = (a: Type, node: Node, label: string): boolean => {
      if (a.k === "error") return true;
      if (!hasCap(a, "Copy") || !hasCap(a, "Native") || !hasLayout(a)) {
        this.rep.at(e.mod, "E4002", node, `${label} needs a Copy & Native element type, not '${show(a)}'`, { actual: show(a), requiredCap: "Copy & Native" });
        return false;
      }
      if (hasArenaBuf(a)) {
        this.rep.at(e.mod, "E2002", node, `a ring element cannot be or contain an ArenaBuf, not '${show(a)}'`, { actual: show(a) });
        return false;
      }
      if (collectTParams(a).length > 0 && !sendable(a)) {
        this.rep.at(e.mod, "E2002", node, `generic ${label} requires 'Send' on '${show(a)}'`, { actual: show(a), requiredCap: "Send" });
        return false;
      }
      return true;
    };
    if (name === "RingPair") { // §15.1 (Q199): a builtin Struct, spelled out as the record it is defined to equal
      if (!arity(1)) return ERROR;
      const a = args[0]!;
      if (a.k === "error") return ERROR;
      if (!ringElemOk(a, argNodes![0]!, "RingPair<T>")) return ERROR;
      return record([{ name: "tx", type: gen("RingTx", a), readonly: false }, { name: "rx", type: gen("RingRx", a), readonly: false }], true);
    }
    if (name === "Result") return arity(2) ? result(args[0]!, args[1]!) : ERROR;
    if (name === "Resource") return arity(1) ? { k: "resource", inner: args[0]! } : ERROR;
    if (isGenName(name)) {
      if (!arity(GEN_ARITY[name])) return ERROR;
      if ((name === "Ref" || name === "Mut")) { // Q051
        if (!borrowOk(args[0]!)) {
          this.rep.at(e.mod, "E2002", argNodes![0]!, `${name}<T> needs an owned type or Slice`, { kind: "borrow-target", actual: show(args[0]!) });
          return ERROR;
        }
      }
      if (name === "Port") { // §15.2 (Q200, Q210): both type arguments must be sendable, at every position a Port type is written
        for (let i = 0; i < 2; i++) if (!sendable(args[i]!)) { this.rep.at(e.mod, "E2010", argNodes![i]!, `'${show(args[i]!)}' cannot be sent to an isolate`, { actual: show(args[i]!) }); return ERROR; }
      }
      if (args.some((a) => a.k === "error")) return ERROR;
      if ((name === "RingTx" || name === "RingRx") && !ringElemOk(args[0]!, argNodes![0]!, `${name}<T>`)) return ERROR; // §15.1 (Q210)
      if ((name === "Map" || name === "Set") && !keyOk(args[0]!)) { // §3.2, SPEC-v1 §3.4 Key
        this.rep.at(e.mod, "E2002", argNodes![0]!, `a ${name} ${name === "Map" ? "key" : "element"} is a string, number, boolean or string literal union, not '${show(args[0]!)}'`, { requiredCap: "Key", actual: show(args[0]!) });
        return ERROR;
      }
      if ((name === "Vec" || name === "Slice" || name === "Pool" || name === "Handle" || name === "ArenaBuf") && (!hasCap(args[0]!, "Copy") || !hasCap(args[0]!, "Native") || !hasLayout(args[0]!))) { // §3.3, SPEC-v1 §3.4
        this.rep.at(e.mod, "E4002", argNodes![0]!, `${name}<T> needs a Copy & Native element type, not '${show(args[0]!)}'`, { actual: show(args[0]!), requiredCap: "Copy & Native" });
        return ERROR;
      }
      const i = CONTAINERS.has(name) ? args.findIndex((a) => holdsOwned(a) && !ownedDeep(a)) : -1;
      if (i >= 0) this.rep.at(e.mod, "E3007", argNodes![i]!, `'${name}' cannot hold the owned type '${show(args[i]!)}'`, { kind: "managed-owned", container: name, actual: show(args[i]!) });
      return { k: "gen", name, args };
    }
    const b = !RESERVED.has(name) ? builtinType(name) : undefined;
    if (b) return arity(0) ? b : ERROR;
    this.rep.at(e.mod, "E2000", id, `unknown type '${name}'`, { name });
    return ERROR;
  }
}

/** §3.2 (Q080): after removing `null`, a union is a tagged union with distinct `kind` literals or all string literals. */
export function legalUnion(u: Type): boolean {
  const rest = u.k === "union" ? nonNull(u) ?? u : u;
  if (rest.k !== "union" || rest.members.every((m) => m.k === "lit")) return true;
  return isTaggedUnion(rest) && new Set(rest.members.map(kindOf)).size === rest.members.length;
}

export interface TypeEnv { mod: Module; tparams: Map<string, TParam>; cscope?: Map<string, CStructSym> }

export const tparamShells = (list: ts.NodeArray<ts.TypeParameterDeclaration> | undefined, owner?: Layer, allowOwned = false): TParam[] =>
  (list ?? []).map((d) => ({ ...newTParam(d.name.text), noPromise: true, ...(owner ? { owner } : {}), ...(allowOwned ? { allowOwned } : {}) }));
