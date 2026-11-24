// Phase P1 (Q003): the syntax allowlist. Every node kind is accepted only by an explicit case below;
// anything else falls to a default branch that reports E1000. Anchors follow docs/DIAGNOSTICS.md.
import { dirname } from "node:path";
import { BUILTIN_NAMES, CAPABILITY_NAMES } from "./builtins.ts";
import { isValidCHeader } from "./cdecl.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { DETMATH_PATH } from "./detmath.ts";
import { canonPath } from "./modules.ts";
import { NodeFlags, SyntaxKind as K, isId, isParamProp, isRecordInterface, type Node, type ParsedFile, type ts } from "./parse.ts";
import { RUNTIME_GLOBAL } from "./names.ts";

/** Q004: type names rejected as E1000 rather than E2000. */
const E1000_TYPE_NAMES = new Set([
  "Function", "Partial", "Required", "Readonly", "Record", "Pick", "Omit", "Exclude", "Extract", "NonNullable", "Parameters",
  "ConstructorParameters", "ReturnType", "InstanceType", "ThisParameterType", "OmitThisParameter", "ThisType", "Awaited",
  "Uppercase", "Lowercase", "Capitalize", "Uncapitalize", "NoInfer",
]);
/** Q123: names the emitted strict-mode ESM cannot bind (reserved words, `eval` / `arguments`). */
const RESERVED_WORDS = new Set(["implements", "interface", "let", "package", "private", "protected", "public", "static", "yield", "await", "enum", "using", "eval", "arguments"]);
/** Q123: member names with a special meaning on JS objects and classes. */
const SPECIAL_MEMBERS = new Set(["__proto__", "constructor", "prototype", "then"]);
const DIRECTIVES = new Set(["use owned", "use rt"]);
/** §14.4: a modifier on strict / rt functions, never a layer of its own (E1009 when misplaced). */
const UNSAFE_DIRECTIVE = "use unsafe";
const CONTRACTS = new Set(["requires", "ensures", "invariant"]);
/** Q054: annotation heads that make a module-level const mutable. */
const MUTABLE_TYPES = new Set(["Array", "Map", "Set", "Vec", "Pool", "Arena", "OwnedStruct"]);
const BINARY_OPS = new Set<K>([
  K.PlusToken, K.MinusToken, K.AsteriskToken, K.SlashToken, K.PercentToken, K.AsteriskAsteriskToken,
  K.LessThanToken, K.LessThanEqualsToken, K.GreaterThanToken, K.GreaterThanEqualsToken, K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken,
  K.AmpersandToken, K.BarToken, K.CaretToken, K.LessThanLessThanToken, K.GreaterThanGreaterThanToken, K.GreaterThanGreaterThanGreaterThanToken,
  K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionQuestionToken,
  K.EqualsToken, K.PlusEqualsToken, K.MinusEqualsToken, K.AsteriskEqualsToken, K.SlashEqualsToken, K.PercentEqualsToken, K.AsteriskAsteriskEqualsToken,
  K.AmpersandEqualsToken, K.BarEqualsToken, K.CaretEqualsToken, K.LessThanLessThanEqualsToken, K.GreaterThanGreaterThanEqualsToken, K.GreaterThanGreaterThanGreaterThanEqualsToken,
  K.QuestionQuestionEqualsToken, K.BarBarEqualsToken, K.AmpersandAmpersandEqualsToken,
]);
const PREFIX_OPS = new Set<K>([K.MinusToken, K.ExclamationToken, K.TildeToken]);

/** Codes owned by phase P1 (Q003). */
export const P1_CODE = /^(E1\d{3}|E5002|E6001|E6003|E6004|E7001|E7002)$/;

type FnKind = "function" | "method" | "other";

/** P1 diagnostics for one parsed file. `file` is the path reported in diagnostics. */
export function checkSyntax(pf: ParsedFile, file: string = pf.path): Diagnostic[] {
  const sf = pf.sourceFile;
  const out: Diagnostic[] = [];
  const report = (code: string, start: number, end: number, message: string, data?: Record<string, unknown>): void => {
    out.push({ code, severity: "error", message, file, range: { start: pf.position(start), end: pf.position(end) }, ...(data ? { data } : {}) });
  };
  const at = (code: string, n: Node, message: string, data?: Record<string, unknown>): void => report(code, n.getStart(sf), n.end, message, data);
  /** Attaches a single-edit fix to the diagnostic just reported. */
  const fix = (title: string, start: number, end: number, newText: string): void => {
    out.at(-1)!.fixes = [{ title, edits: [{ range: { start: pf.position(start), end: pf.position(end) }, newText }] }];
  };
  /** `x++` / `x--` whose value is unused (statement or for-incrementor). */
  const unusedIncs = new Set<Node>();
  const e1000 = (n: Node, what: string, data?: Record<string, unknown>): void => at("E1000", n, `${what} is not allowed`, data);
  const nullableFix = (qTok: Node, tNode: ts.TypeNode | undefined): void => {
    if (!tNode) return;
    const txt = sf.text.slice(tNode.getStart(sf), tNode.end);
    const wrapped = tNode.kind === K.FunctionType ? `(${txt})` : txt;
    fix("use '| null'", qTok.getStart(sf), tNode.end, `: ${wrapped} | null`);
  };
  const strictDirectiveDiag = (lit: ts.StringLiteral): boolean => {
    if (lit.text !== "use strict") return false;
    at("E1000", lit, "'use strict' is not a Szigyr directive; use '\"use owned\"' for the strict layer or omit for managed", { kind: "directive", directive: "use strict", suggested: "use owned" });
    fix("replace with '\"use owned\"'", lit.getStart(sf), lit.end, '"use owned"');
    return true;
  };

  // Q070: a parse error is E1000 at the error; the file's AST is not walked further.
  if (pf.syntaxErrors.length) {
    for (const d of pf.syntaxErrors) report("E1000", d.start, Math.max(d.end, d.start), `syntax error: ${d.message}`, { kind: "syntax" });
    return out;
  }

  /** Contract and `test` calls that sit in an allowed position (E6001 / E6003 otherwise). */
  const allowedCalls = new Set<Node>();
  /** Q120 / Q124 / §16.1: what the enclosing function allows. Arrows inherit `thisOk` and `inTest`. */
  let fc = { thisOk: false, async: false, inTest: false, loops: 0, breaks: 0, layer: undefined as string | undefined, labels: new Set<string>() };

  const calleeName = (s: Node): { call: ts.CallExpression; name: string } | undefined => {
    if (s.kind !== K.ExpressionStatement) return;
    const c = (s as ts.ExpressionStatement).expression;
    if (c.kind !== K.CallExpression || !isId((c as ts.CallExpression).expression)) return;
    return { call: c as ts.CallExpression, name: ((c as ts.CallExpression).expression as ts.Identifier).text };
  };
  const declName = (id: ts.Identifier): void => {
    if (BUILTIN_NAMES.has(id.text) || CAPABILITY_NAMES.has(id.text)) at("E1000", id, `'${id.text}' is a builtin name`, { kind: "reserved-name", name: id.text });
    else if (RESERVED_WORDS.has(id.text)) at("E1000", id, `'${id.text}' is a reserved word`, { kind: "reserved-name", name: id.text });
    else if (id.text.startsWith(RUNTIME_GLOBAL)) at("E1000", id, `names starting with '${RUNTIME_GLOBAL}' are reserved`, { kind: "reserved-name", name: id.text });
  };
  const mods = (n: Node, allowed: K[]): void => {
    const ms = (n as Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
    for (const m of ms ?? []) {
      if (m.kind === K.DefaultKeyword) at("E1003", ms![0]!, "default export is not allowed", { kind: "default-export" });
      else if (m.kind === K.PublicKeyword && !allowed.includes(K.PublicKeyword)) {
        at("E1000", m, "'public' modifier is not allowed here (class members are public by default)", { kind: "public-modifier", modifier: "public" });
        let end = m.end;
        while (end < sf.text.length && (sf.text[end] === " " || sf.text[end] === "\t")) end++;
        fix("remove 'public' modifier", m.getStart(sf), end, "");
      }
      else if (!allowed.includes(m.kind)) e1000(m, "this modifier", { kind: "modifier" });
    }
  };

  // ---- same-name declarations in one scope (Q004 declaration merging, Q087)
  const scopes: Set<string>[] = [];
  const claim = (seen: Set<string>, id: ts.Identifier): void => {
    if (seen.has(id.text)) at("E1000", id, `declaration merging ('${id.text}' declared twice)`, { kind: "duplicate-declaration", name: id.text });
    seen.add(id.text);
  };
  const bind = (id: ts.Identifier): void => { const s = scopes.at(-1); if (s) claim(s, id); };
  const scoped = (f: () => void): void => { scopes.push(new Set()); try { f(); } finally { scopes.pop(); } };

  // ---- module level (§1, Q054)
  const topNames = new Set<string>();
  const topName = (id: ts.Identifier | undefined): void => {
    if (!id) return;
    if (topNames.has(id.text)) at("E1000", id, `declaration merging ('${id.text}' declared twice)`, { kind: "duplicate-declaration", name: id.text });
    topNames.add(id.text);
  };
  /** The file-level layer directive, for functions that only add "use unsafe" (§14.4). */
  let fileLayer: string | undefined;
  /** `declare module "c:..."` blocks of this file, specifier -> declared C function names (§14.1). */
  const cDeclares = new Map<string, Set<string>>();
  const cImports = new Set<string>();
  const localNsImports = new Set<string>();
  const stmts = sf.statements;
  for (const s0 of stmts) {
    if (s0.kind === K.ModuleDeclaration) moduleDecl(s0 as ts.ModuleDeclaration); // §14.1: before imports resolve against it
    else if (s0.kind === K.ImportDeclaration) {
      const d = s0 as ts.ImportDeclaration, nb = d.importClause?.namedBindings;
      if (d.moduleSpecifier.kind === K.StringLiteral && (d.moduleSpecifier as ts.StringLiteral).text.startsWith("c:") && nb?.kind === K.NamedImports) {
        for (const e of (nb as ts.NamedImports).elements) cImports.add(e.name.text);
      }
    }
  }
  const topStart = prologue(stmts, true, true);
  fc.layer = fileLayer;
  for (let i = topStart; i < stmts.length; i++) {
    const s = stmts[i]!;
    switch (s.kind) {
      case K.ImportDeclaration: importDecl(s as ts.ImportDeclaration); break;
      case K.ExportDeclaration: exportDecl(s as ts.ExportDeclaration); break;
      case K.ExportAssignment:
        if ((s as ts.ExportAssignment).isExportEquals) at("E7001", s, "'export =' is not allowed", { kind: "export-equals" });
        else at("E1003", s, "default export is not allowed", { kind: "default-export" });
        break;
      case K.ImportEqualsDeclaration: at("E7001", s, "'import =' is not allowed", { kind: "import-equals" }); break;
      case K.FunctionDeclaration:
        if ((s as ts.FunctionDeclaration).body) topName((s as ts.FunctionDeclaration).name);
        fn(s as ts.FunctionDeclaration, "function");
        break;
      case K.ClassDeclaration: topName((s as ts.ClassDeclaration).name); classDecl(s as ts.ClassDeclaration); break;
      case K.InterfaceDeclaration: topName((s as ts.InterfaceDeclaration).name); interfaceDecl(s as ts.InterfaceDeclaration); break;
      case K.TypeAliasDeclaration: topName((s as ts.TypeAliasDeclaration).name); typeAlias(s as ts.TypeAliasDeclaration); break;
      case K.VariableStatement:
        mods(s, [K.ExportKeyword]);
        for (const d of (s as ts.VariableStatement).declarationList.declarations) { if (isId(d.name)) topName(d.name); else if (d.name.kind === K.ObjectBindingPattern) for (const el of (d.name as ts.ObjectBindingPattern).elements) if (isId(el.name)) topName(el.name); } // Q225 (b)
        varList((s as ts.VariableStatement).declarationList, "module");
        break;
      case K.ModuleDeclaration: break; // handled above
      case K.EnumDeclaration: at("E1000", s, "'enum' is not allowed; use a string literal union type (e.g. 'type Kind = \"a\" | \"b\"')", { kind: "enum" }); break;
      case K.ExpressionStatement: {
        const x0 = (s as ts.ExpressionStatement).expression;
        if (x0.kind === K.StringLiteral && (x0 as ts.StringLiteral).text === UNSAFE_DIRECTIVE) { at("E1009", x0, `'${UNSAFE_DIRECTIVE}' at module level`, { directive: UNSAFE_DIRECTIVE }); break; }
        const c = calleeName(s);
        if (c?.name === "test") allowedCalls.add(c.call);
        else if (c?.name !== "forAll" && c?.name !== "fuzzContracts") { e1000(s, "this statement at module level", { kind: "module-statement" }); break; }
        stmt(s);
        break;
      }
      default: e1000(s, "this statement at module level", { kind: "module-statement" });
    }
  }
  return out;

  function peekLayer(list: ts.NodeArray<ts.Statement>, allowDirective: boolean): { layerAt: number; layer: string | undefined; lits: ts.StringLiteral[] } {
    const lits: ts.StringLiteral[] = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      if (s.kind !== K.ExpressionStatement || (s as ts.ExpressionStatement).expression.kind !== K.StringLiteral) break;
      lits.push((s as ts.ExpressionStatement).expression as ts.StringLiteral);
    }
    let layerAt = -1;
    if (allowDirective && lits[0] && DIRECTIVES.has(lits[0].text)) layerAt = 0;
    else if (allowDirective && lits[0]?.text === UNSAFE_DIRECTIVE && lits[1] && DIRECTIVES.has(lits[1].text)) layerAt = 1;
    return { layerAt, layer: layerAt >= 0 ? lits[layerAt]!.text : undefined, lits };
  }

  /** Leading string-literal statements (directives, Q039). Returns the index of the first other statement.
   * §14.4: "use unsafe" may accompany the layer directive in either order; anywhere else it is E1009. */
  function prologue(list: ts.NodeArray<ts.Statement>, allowDirective: boolean, isModule = false): number {
    const { layerAt, layer, lits } = peekLayer(list, allowDirective);
    const i = lits.length;
    if (isModule) fileLayer = layer;
    let unsafeSeen = false;
    lits.forEach((lit, j) => {
      if (DIRECTIVES.has(lit.text)) {
        if (j !== layerAt) e1000(lit, `directive '${lit.text}' here`, { kind: "directive", directive: lit.text });
      } else if (lit.text === UNSAFE_DIRECTIVE) {
        if (isModule || !allowDirective || unsafeSeen || (layer ?? fileLayer) === undefined) {
          at("E1009", lit, `'${UNSAFE_DIRECTIVE}' is only allowed once, in a strict or rt function`, { directive: UNSAFE_DIRECTIVE });
        }
        unsafeSeen = true;
      } else if (!strictDirectiveDiag(lit)) {
        e1000(lit, `directive '${lit.text}' here`, { kind: "directive", directive: lit.text });
      }
    });
    return i;
  }

  /** §14.1 (Q224): a `c:` specifier is `c:` + two non-empty parts without whitespace, control chars, `:`, `<`, `>`, `"` or `\\`. */
  function cSpecifierOk(text: string): boolean {
    if (!text.startsWith("c:")) return false;
    const parts = text.slice(2).split(":");
    return parts.length === 2 && parts[0]!.length > 0 && !/[\s\x00-\x1f\x7f:<>"\\]/.test(parts[0]!) && isValidCHeader(parts[1]!);
  }
  function moduleDecl(d: ts.ModuleDeclaration): void {
    mods(d, [K.DeclareKeyword]);
    if (d.name.kind !== K.StringLiteral) { e1000(d.name, "this module name", { kind: "namespace" }); return; }
    const spec = (d.name as ts.StringLiteral).text;
    if (!spec.startsWith("c:")) { e1000(d, "this module declaration", { kind: "ambient-module" }); return; }
    if (!cSpecifierOk(spec)) at("E7002", d.name, "a 'c:' specifier is 'c:<package>:<header>'", { specifier: spec });
    else if (cDeclares.has(spec)) at("E7002", d.name, `duplicate 'declare module' for '${spec}'`, { specifier: spec });
    if (!d.body || d.body.kind !== K.ModuleBlock) { at("E7002", d.name, "'declare module' needs a body of function declarations", { specifier: spec }); return; }
    const names = cDeclares.get(spec) ?? new Set<string>();
    if (!cDeclares.has(spec)) cDeclares.set(spec, names);
    for (const st of (d.body as ts.ModuleBlock).statements) {
      if (st.kind === K.FunctionDeclaration) {
        const f = st as ts.FunctionDeclaration;
        mods(f, []);
        if (!f.name) { e1000(f, "a C function without a name"); continue; }
        if (names.has(f.name.text)) at("E1000", f.name, `declaration merging ('${f.name.text}' declared twice)`);
        names.add(f.name.text);
        if (f.typeParameters?.length) at("E1000", f.typeParameters[0]!, "type parameters on a C function");
        if (f.body) e1000(f, "a C function declaration has no body");
        params(f.parameters);
        if (f.type) type(f.type);
      } else if (st.kind === K.VariableStatement) {
        const vs = st as ts.VariableStatement, dl = vs.declarationList;
        mods(vs, []);
        if (!(dl.flags & NodeFlags.Const)) {
          if (dl.flags & NodeFlags.Let) e1000(dl, "'let' in a 'c:' module");
          else at("E1001", dl, "'var' is not allowed");
          continue;
        }
        for (const vd of dl.declarations) {
          if (!isId(vd.name)) { e1000(vd.name, "destructuring in a 'c:' module"); continue; }
          if (names.has(vd.name.text)) at("E1000", vd.name, `declaration merging ('${vd.name.text}' declared twice)`);
          names.add(vd.name.text);
          if (vd.exclamationToken) e1000(vd.exclamationToken, "definite assignment assertion");
          if (vd.initializer) e1000(vd.initializer, "a C const declaration cannot have an initializer");
          if (vd.type) type(vd.type);
        }
      } else if (st.kind === K.TypeAliasDeclaration) {
        const ta = st as ts.TypeAliasDeclaration;
        mods(ta, []);
        if (names.has(ta.name.text)) at("E1000", ta.name, `declaration merging ('${ta.name.text}' declared twice)`);
        names.add(ta.name.text);
        if (ta.typeParameters?.length) at("E1000", ta.typeParameters[0]!, "type parameters on a C struct");
        type(ta.type);
      } else {
        e1000(st, "only function, const, and CStruct type declarations in a 'c:' module");
      }
    }
  }

  function specifierOk(text: string): boolean {
    if (text.startsWith("npm:")) return text.length > 4;
    return (text.startsWith("./") || text.startsWith("../")) && text.endsWith(".szigyr");
  }

  function importDecl(d: ts.ImportDeclaration): void {
    const ic = d.importClause;
    if (!ic || d.attributes || (ic.phaseModifier && ic.phaseModifier !== K.TypeKeyword)) {
      at("E7001", d, "invalid import declaration", { kind: "invalid-import" });
      return;
    }
    const isTypeDecl = ic.phaseModifier === K.TypeKeyword;
    const nb = ic.namedBindings;
    const specNode = d.moduleSpecifier;
    const badNamed = (ni: ts.NamedImports): boolean =>
      ni.elements.some((e) => (isTypeDecl && e.isTypeOnly) || (e.propertyName && !(isId(e.propertyName) && e.propertyName.text !== "default")));

    if (specNode.kind === K.StringLiteral && (specNode as ts.StringLiteral).text.startsWith("c:")) {
      const spec = (specNode as ts.StringLiteral).text;
      if (ic.name || nb?.kind !== K.NamedImports || badNamed(nb as ts.NamedImports)) {
        at("E7001", d, "only named imports are allowed from 'c:' modules", { kind: "invalid-import" });
        return;
      }
      if (!cSpecifierOk(spec)) { at("E7002", specNode, "a 'c:' specifier is 'c:<package>:<header>'", { specifier: spec }); return; }
      const declared = cDeclares.get(spec);
      if (!declared) { at("E7002", specNode, `no 'declare module "${spec}"' in this file`, { specifier: spec }); return; }
      for (const e of (nb as ts.NamedImports).elements) {
        const orig = e.propertyName?.text ?? e.name.text;
        if (!declared.has(orig)) at("E7002", e.propertyName ?? e.name, `'${orig}' is not declared in '${spec}'`, { specifier: spec, name: orig });
        declName(e.name); topName(e.name);
      }
      return;
    }
    if (specNode.kind !== K.StringLiteral || !specifierOk((specNode as ts.StringLiteral).text)) {
      const spec = specNode.kind === K.StringLiteral ? (specNode as ts.StringLiteral).text : undefined;
      at("E7001", specNode, "module specifier must be './x.szigyr', '../x.szigyr' or 'npm:name'", { kind: "invalid-specifier", ...(spec !== undefined ? { specifier: spec } : {}) });
      if (specNode.kind === K.StringLiteral) {
        const s = (specNode as ts.StringLiteral).text;
        if (s.startsWith("./") || s.startsWith("../")) {
          const next = s.endsWith(".ts") ? `${s.slice(0, -3)}.szigyr` : `${s}.szigyr`;
          fix(`rewrite module specifier to '${next}'`, specNode.getStart(sf), specNode.end, JSON.stringify(next));
        }
      }
      return;
    }
    const specText = (specNode as ts.StringLiteral).text;
    if (specText.startsWith("npm:")) {
      if (isTypeDecl || (nb?.kind === K.NamedImports && (nb as ts.NamedImports).elements.some((e) => e.isTypeOnly))) {
        at("E7001", d, "type-only import is not allowed for 'npm:' modules", { kind: "invalid-import" });
        return;
      }
      if (nb?.kind === K.NamedImports && (nb as ts.NamedImports).elements.some((e) => e.propertyName && !(isId(e.propertyName) && e.propertyName.text !== "default"))) {
        at("E7001", d, "invalid import specifier", { kind: "invalid-import" });
        return;
      }
      if (ic.name) { declName(ic.name); topName(ic.name); }
      if (nb?.kind === K.NamespaceImport) { declName((nb as ts.NamespaceImport).name); topName((nb as ts.NamespaceImport).name); }
      else if (nb?.kind === K.NamedImports) {
        for (const e of (nb as ts.NamedImports).elements) { declName(e.name); topName(e.name); }
      }
      return;
    }
    if (canonPath(dirname(pf.path), specText) === DETMATH_PATH) { // §12 (Q191); by realpath, so a symlink does not hide it (Q253)
      at("E7001", specNode, "the bundled DetMath module cannot be imported; use the DetMath namespace", { kind: "detmath-import", specifier: specText });
      return;
    }
    if (ic.name) {
      at("E7001", d, "default import is only allowed for 'npm:' modules", { kind: "invalid-import" });
      return;
    }
    if (nb?.kind === K.NamespaceImport) {
      const id = (nb as ts.NamespaceImport).name;
      declName(id); topName(id);
      localNsImports.add(id.text);
      return;
    }
    if (nb?.kind !== K.NamedImports || badNamed(nb as ts.NamedImports)) {
      at("E7001", d, "invalid import declaration", { kind: "invalid-import" });
      return;
    }
    for (const e of (nb as ts.NamedImports).elements) { declName(e.name); topName(e.name); }
  }

  function exportDecl(d: ts.ExportDeclaration): void {
    if (d.moduleSpecifier) {
      if (!d.exportClause || d.exportClause.kind === K.NamespaceExport) {
        at("E1003", d, "'export *' is not allowed", { kind: "export-star" });
        return;
      }
      if (d.exportClause.kind !== K.NamedExports || d.attributes) {
        at("E7001", d, "only 'export { a, b as c } from \"./x.szigyr\"' is allowed", { kind: "invalid-export" });
        return;
      }
      const specNode = d.moduleSpecifier;
      if (specNode.kind !== K.StringLiteral) {
        at("E7001", specNode, "module specifier must be './x.szigyr' or '../x.szigyr'", { kind: "invalid-specifier" });
        return;
      }
      const spec = (specNode as ts.StringLiteral).text;
      if (spec.startsWith("c:") || spec.startsWith("npm:")) {
        at("E7001", d, "re-export is only allowed from relative '.szigyr' modules", { kind: "re-export", specifier: spec });
        return;
      }
      if (!(spec.startsWith("./") || spec.startsWith("../")) || !spec.endsWith(".szigyr")) {
        at("E7001", specNode, "module specifier must be './x.szigyr' or '../x.szigyr'", { kind: "invalid-specifier", specifier: spec });
        if (spec.startsWith("./") || spec.startsWith("../")) {
          const next = spec.endsWith(".ts") ? `${spec.slice(0, -3)}.szigyr` : `${spec}.szigyr`;
          fix(`rewrite module specifier to '${next}'`, specNode.getStart(sf), specNode.end, JSON.stringify(next));
        }
        return;
      }
      if (canonPath(dirname(pf.path), spec) === DETMATH_PATH) {
        at("E7001", specNode, "the bundled DetMath module cannot be re-exported", { kind: "detmath-import", specifier: spec });
        return;
      }
      for (const e of (d.exportClause as ts.NamedExports).elements) {
        if (isId(e.name) && e.name.text === "default") { at("E1003", d, "default export is not allowed", { kind: "default-export" }); return; }
        if ((d.isTypeOnly && e.isTypeOnly) || !isId(e.name) || (e.propertyName && (!isId(e.propertyName) || e.propertyName.text === "default"))) {
          at("E7001", d, "only 'export { a, b as c } from \"./x.szigyr\"' is allowed", { kind: "invalid-export" });
          return;
        }
      }
      return;
    }
    if (d.exportClause?.kind !== K.NamedExports) {
      at("E7001", d, "only 'export { a, b as c }' is allowed", { kind: "invalid-export" });
      return;
    }
    for (const e of (d.exportClause as ts.NamedExports).elements) {
      if (isId(e.name) && e.name.text === "default") { at("E1003", d, "default export is not allowed", { kind: "default-export" }); return; }
      if ((d.isTypeOnly && e.isTypeOnly) || !isId(e.name) || (e.propertyName && !isId(e.propertyName))) { at("E7001", d, "only 'export { a, b as c }' is allowed", { kind: "invalid-export" }); return; }
      const local = (e.propertyName ?? e.name) as ts.Identifier;
      if (cImports.has(local.text)) at("E7001", local, `cannot re-export C function '${local.text}'`, { kind: "c-reexport", name: local.text });
      else if (localNsImports.has(local.text)) at("E7001", local, `cannot export module namespace '${local.text}'`, { kind: "namespace-export", name: local.text });
    }
  }

  // ---- declarations
  function fn(n: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.ConstructorDeclaration, kind: FnKind): void {
    const saved = fc;
    const thisOk = n.kind === K.ArrowFunction ? fc.thisOk : n.kind === K.Constructor || (n.kind === K.MethodDeclaration && !n.modifiers?.some((m) => m.kind === K.StaticKeyword));
    const isTestCb = (n.kind === K.ArrowFunction || n.kind === K.FunctionExpression) && n.parent?.kind === K.CallExpression &&
      allowedCalls.has(n.parent) && (n.parent as ts.CallExpression).arguments[1] === n;
    const inTest = (n.kind === K.ArrowFunction || n.kind === K.FunctionExpression) && (fc.inTest || isTestCb);
    const fnLayer = kind === "function" && n.body?.kind === K.Block
      ? peekLayer((n.body as ts.Block).statements, true).layer
      : undefined;
    const layer = fnLayer ?? (n.kind === K.ArrowFunction || n.kind === K.FunctionExpression ? fc.layer : fileLayer);
    fc = { thisOk, async: !!n.modifiers?.some((m) => m.kind === K.AsyncKeyword), inTest, loops: 0, breaks: 0, layer, labels: new Set<string>() };
    try { scoped(() => fn0(n, kind)); } finally { fc = saved; } // parameters and the top level of the body share one scope
  }
  function fn0(n: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.ConstructorDeclaration, kind: FnKind): void {
    const isAsync = !!n.modifiers?.some((m) => m.kind === K.AsyncKeyword);
    if (n.kind === K.FunctionDeclaration || n.kind === K.FunctionExpression) {
      if (n.kind === K.FunctionDeclaration) { mods(n, [K.ExportKeyword, K.AsyncKeyword]); if (n.name) declName(n.name); }
      else { mods(n, [K.AsyncKeyword]); if (n.name) declName(n.name); }
      if (n.asteriskToken) { // Q004: anchor `function`; the body is not walked (no cascade from `yield`)
        const m = n.modifiers;
        const kw = m?.length ? pf.tokenAfter(m[m.length - 1]!.end) : n.getStart(sf);
        report("E1000", kw, kw + "function".length, "generator is not allowed");
        return;
      }
    } else if (n.kind === K.MethodDeclaration) mods(n, [K.PrivateKeyword, K.StaticKeyword, K.AsyncKeyword]);
    else if (n.kind === K.ArrowFunction) mods(n, [K.AsyncKeyword]);
    else if (n.kind === K.Constructor) mods(n, []);
    typeParams(n.typeParameters);
    params(n.parameters, { allowDefaults: true, allowParamProps: n.kind === K.Constructor, forbidThis: n.kind === K.Constructor, allowRest: fc.layer === undefined, allowDestructure: true, bind: true, layer: fc.layer });
    if (n.type) type(n.type);
    const body = n.body;
    if (!body) { e1000(n, "function overload or declaration without body"); return; }
    if (body.kind !== K.Block) { expr(body as ts.Expression); return; }
    const list = (body as ts.Block).statements;
    let i = prologue(list, kind === "function");
    const start = i;
    const isForAllArg = (n.kind === K.ArrowFunction || n.kind === K.FunctionExpression) && n.parent?.kind === K.CallExpression &&
      isId((n.parent as ts.CallExpression).expression) && ((n.parent as ts.CallExpression).expression as ts.Identifier).text === "forAll" &&
      (n.parent as ts.CallExpression).arguments[0] === n;
    if (kind !== "other") { // Q057: directive, then requires*, then ensures*
      let seenEnsures = false;
      for (; i < list.length; i++) {
        const c = calleeName(list[i]!);
        if (c?.name === "requires" && !seenEnsures) allowedCalls.add(c.call);
        else if (c?.name === "ensures" && !isAsync) { seenEnsures = true; allowedCalls.add(c.call); }
        else break;
      }
    } else if (isForAllArg) { // §16.1 (Q273): leading requires* in direct arrow/fn-expr argument of forAll
      for (; i < list.length; i++) {
        const c = calleeName(list[i]!);
        if (c?.name === "requires") allowedCalls.add(c.call);
        else break;
      }
    }
    for (let j = start; j < list.length; j++) stmt(list[j]!);
  }

  function typeParams(list: ts.NodeArray<ts.TypeParameterDeclaration> | undefined): void {
    const seen = new Set<string>();
    for (const p of list ?? []) {
      claim(seen, p.name);
      mods(p, []);
      declName(p.name);
      if (p.constraint) {
        if (p.constraint.kind === K.TypeReference) type(p.constraint);
        else if (p.constraint.kind === K.IntersectionType && (p.constraint as ts.IntersectionTypeNode).types.every((c) => c.kind === K.TypeReference)) {
          for (const c of (p.constraint as ts.IntersectionTypeNode).types) type(c);
        } else e1000(p.constraint, "this type parameter constraint");
      }
      if (p.defaultType) e1000(p.defaultType, "default type argument");
    }
  }

  function params(list: ts.NodeArray<ts.ParameterDeclaration>, opts?: { allowDefaults?: boolean; allowParamProps?: boolean; forbidThis?: boolean; allowRest?: boolean; allowDestructure?: boolean; bind?: boolean; layer?: string }): void {
    let seenDefault = false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      mods(p, opts?.allowParamProps ? [K.PrivateKeyword, K.PublicKeyword, K.ReadonlyKeyword] : []);
      if (opts?.allowParamProps) {
        const hasPub = !!p.modifiers?.some((m) => m.kind === K.PublicKeyword);
        const hasPriv = !!p.modifiers?.some((m) => m.kind === K.PrivateKeyword);
        if (hasPub && hasPriv) e1000(p.modifiers![0]!, "conflicting access modifiers");
      }
      if (p.dotDotDotToken) {
        if (!opts?.allowRest) {
          if (opts?.layer) e1000(p, `rest parameter in '${opts.layer}' (managed only)`, { kind: "rest-param-layer", layer: opts.layer });
          else e1000(p, "rest parameter", { kind: "rest-param" });
          continue;
        }
        if (i !== list.length - 1) { e1000(p, "non-trailing rest parameter", { kind: "rest-param" }); continue; }
        if (!isId(p.name)) { e1000(p.name, "rest parameter destructuring", { kind: "rest-param" }); continue; }
      }
      if (!isId(p.name)) {
        if (opts?.allowDestructure && (p.name.kind === K.ObjectBindingPattern || p.name.kind === K.ArrayBindingPattern)) {
          if (isParamProp(p)) e1000(p.modifiers![0]!, "parameter property with destructuring", { kind: "param-destructuring" });
          if (p.name.kind === K.ObjectBindingPattern) bindingPattern(p.name as ts.ObjectBindingPattern);
          else arrayBindingPattern(p.name as ts.ArrayBindingPattern);
        } else {
          e1000(p.name, "parameter destructuring", { kind: "param-destructuring" });
          continue;
        }
      } else {
        if (p.name.text === "this") { e1000(p.name, "'this' parameter"); continue; }
        declName(p.name);
        if (opts?.bind) bind(p.name);
        if (opts?.allowParamProps && isParamProp(p) && (SPECIAL_MEMBERS.has(p.name.text) || p.name.text.startsWith(RUNTIME_GLOBAL))) {
          e1000(p.name, `member name '${p.name.text}'`, { kind: "reserved-name", name: p.name.text });
        }
      }
      const idName = isId(p.name) ? { name: p.name.text } : {};
      if (p.questionToken) {
        at("E1008", p.name, "optional parameter is not allowed", { kind: "optional-param", ...idName });
        nullableFix(p.questionToken, p.type);
      } else if (p.initializer) {
        if (!opts?.allowDefaults || p.dotDotDotToken) {
          at("E1008", p.name, "default parameter is not allowed here", { kind: "default-param", ...idName });
        } else {
          seenDefault = true;
          const saved = fc;
          fc = { ...fc, async: false, ...(opts.forbidThis ? { thisOk: false } : {}) };
          try { expr(p.initializer); } finally { fc = saved; }
        }
      } else if (seenDefault && opts?.allowDefaults && !p.dotDotDotToken) {
        at("E1008", p.name, "required parameter cannot follow a default parameter", { kind: "non-trailing-default", ...idName });
      }
      if (p.type) type(p.type);
    }
  }

  function memberName(n: Node & { name: ts.PropertyName; postfixToken?: Node; type?: ts.TypeNode }): void {
    if (!isId(n.name)) e1000(n.name, "this member name", { kind: n.name.kind === K.PrivateIdentifier ? "private-name" : n.name.kind === K.ComputedPropertyName ? "computed-property" : "member-name" });
    else if (SPECIAL_MEMBERS.has(n.name.text) || n.name.text.startsWith(RUNTIME_GLOBAL)) e1000(n.name, `member name '${n.name.text}'`, { kind: "reserved-name", name: n.name.text }); // Q123
    if (n.postfixToken?.kind === K.QuestionToken) {
      at("E1008", n.name, "optional member is not allowed", { kind: "optional-member", ...(isId(n.name) ? { name: n.name.text } : {}) });
      if (n.kind === K.PropertyDeclaration || n.kind === K.PropertySignature) nullableFix(n.postfixToken, n.type);
    } else if (n.postfixToken) e1000(n.postfixToken, "definite assignment assertion");
  }

  function classDecl(c: ts.ClassDeclaration): void {
    mods(c, [K.ExportKeyword]);
    if (c.name) declName(c.name);
    typeParams(c.typeParameters);
    for (const h of c.heritageClauses ?? []) {
      if (h.token !== K.ImplementsKeyword) { e1000(h, "'extends' on a class", { kind: "class-extends" }); continue; }
      for (const t of h.types) {
        const exp = t.expression;
        const ok = isId(exp) || (exp.kind === K.PropertyAccessExpression && isId((exp as ts.PropertyAccessExpression).expression) && isId((exp as ts.PropertyAccessExpression).name));
        if (!ok) e1000(t.expression, "this implements clause", { kind: "implements-clause" });
        for (const a of t.typeArguments ?? []) type(a);
      }
    }
    const members = new Set<string>();
    let hasCtor = false;
    for (const m of c.members) {
      if ((m.kind === K.PropertyDeclaration || m.kind === K.MethodDeclaration) && isId((m as ts.PropertyDeclaration).name)) claim(members, (m as ts.PropertyDeclaration).name as ts.Identifier);
      switch (m.kind) {
        case K.PropertyDeclaration: {
          const p = m as ts.PropertyDeclaration;
          mods(p, [K.PrivateKeyword, K.ReadonlyKeyword, K.StaticKeyword]);
          memberName(p);
          if (p.type) type(p.type);
          const has = (k: K) => !!p.modifiers?.some((x) => x.kind === k);
          if (has(K.StaticKeyword) && (!has(K.ReadonlyKeyword) || !p.initializer || !immutable(p.initializer, p.type))) {
            at("E5002", p.initializer ?? p.name, "static field must be readonly with a literal initializer", { kind: "static-mutable" });
          }
          if (p.initializer) expr(p.initializer);
          break;
        }
        case K.MethodDeclaration: {
          const md = m as ts.MethodDeclaration;
          if (md.asteriskToken) { e1000(md.asteriskToken, "generator method", { kind: "generator" }); break; }
          memberName(md);
          fn(md, "method");
          break;
        }
        case K.Constructor:
          if (hasCtor) e1000(m, "duplicate constructor", { kind: "duplicate-constructor" });
          else {
            hasCtor = true;
            const ctor = m as ts.ConstructorDeclaration;
            fn(ctor, "other");
            for (const p of ctor.parameters) if (isParamProp(p) && isId(p.name)) claim(members, p.name);
          }
          break;
        case K.GetAccessor: case K.SetAccessor:
          e1000(m, "getter/setter accessor", { kind: "class-accessor" });
          break;
        case K.IndexSignature:
          e1000(m, "index signature", { kind: "index-signature" });
          break;
        default: e1000(m, "this class member", { kind: "class-member" });
      }
    }
  }

  function interfaceDecl(d: ts.InterfaceDeclaration): void {
    mods(d, [K.ExportKeyword]);
    declName(d.name);
    typeParams(d.typeParameters);
    const hasMethods = d.members.some((m) => m.kind === K.MethodSignature);
    const names = new Set<string>(); // Q223 (a): a member name once per interface
    if (hasMethods) {
      for (const h of d.heritageClauses ?? []) e1000(h, "'extends' on a method interface", { kind: "interface-extends" });
      for (const m of d.members) {
        if (m.kind === K.PropertySignature) {
          at("E1000", m, "interface cannot mix fields and methods", { kind: "interface-mixed" });
          continue;
        }
        if (m.kind !== K.MethodSignature) { e1000(m, "interface member other than a method signature"); continue; }
        const s = m as ts.MethodSignatureDeclaration;
        mods(s, []);
        memberName(s);
        if (isId(s.name)) claim(names, s.name);
        typeParams(s.typeParameters);
        params(s.parameters, { allowRest: fc.layer === undefined, layer: fc.layer });
        if (s.type) type(s.type);
      }
    } else if (isRecordInterface(d)) {
      for (const h of d.heritageClauses ?? []) {
        if (h.token !== K.ExtendsKeyword) { e1000(h, "this clause on an interface"); continue; }
        for (const t of h.types) {
          const exp = t.expression;
          const ok = isId(exp) || (exp.kind === K.PropertyAccessExpression && isId((exp as ts.PropertyAccessExpression).expression) && isId((exp as ts.PropertyAccessExpression).name));
          if (!ok) e1000(t.expression, "this extends clause");
          for (const a of t.typeArguments ?? []) type(a);
        }
      }
      for (const m of d.members) {
        if (m.kind !== K.PropertySignature) { e1000(m, "interface member other than a property signature"); continue; }
        const p = m as ts.PropertySignatureDeclaration;
        mods(p, [K.ReadonlyKeyword]);
        memberName(p);
        if (isId(p.name)) claim(names, p.name);
        if (p.type) type(p.type);
      }
    } else {
      for (const h of d.heritageClauses ?? []) e1000(h, "'extends' on an interface");
      for (const m of d.members) e1000(m, "interface member other than a method or field signature");
    }
  }

  function typeAlias(d: ts.TypeAliasDeclaration): void {
    mods(d, [K.ExportKeyword]);
    declName(d.name);
    typeParams(d.typeParameters);
    type(d.type);
  }

  function varList(list: ts.VariableDeclarationList, where: "module" | "local" | "for" | "for-of"): void {
    const isUsing = !!(list.flags & NodeFlags.Using);
    const isAwaitUsing = (list.flags & NodeFlags.AwaitUsing) === NodeFlags.AwaitUsing;
    if (isUsing) {
      const stmtParent = list.parent?.parent;
      const inStmtList = !!stmtParent && (stmtParent.kind === K.Block || stmtParent.kind === K.CaseClause || stmtParent.kind === K.DefaultClause);
      if (where !== "local" || !inStmtList) { e1000(list, isAwaitUsing ? "'await using'" : "'using'"); return; }
      if (isAwaitUsing && !fc.async) e1000(list, "'await using' outside an async function");
      for (const d of list.declarations) {
        if (d.exclamationToken) e1000(d.exclamationToken, "definite assignment assertion");
        if (isId(d.name)) { declName(d.name); bind(d.name); }
        else e1000(d.name, "this destructuring");
        if (d.type) type(d.type);
        if (!d.initializer) { e1000(d.name, "declaration without initializer"); continue; }
        expr(d.initializer);
      }
      return;
    }
    const isLet = !!(list.flags & NodeFlags.Let);
    if (!isLet && !(list.flags & NodeFlags.Const)) {
      const s = list.getStart(sf);
      at("E1001", list, "'var' is not allowed");
      fix(`use '${where === "local" || where === "for" ? "let" : "const"}'`, s, s + 3, where === "local" || where === "for" ? "let" : "const"); // 'let' is not allowed at module level
      return;
    }
    if (isLet && where === "module") { at("E5002", list, "module-level 'let' is not allowed", { kind: "module-let" }); return; }
    for (const d of list.declarations) {
      if (d.exclamationToken) e1000(d.exclamationToken, "definite assignment assertion");
      if (isId(d.name)) { declName(d.name); bind(d.name); }
      else if (d.name.kind === K.ObjectBindingPattern && !isLet && where !== "for-of") bindingPattern(d.name as ts.ObjectBindingPattern);
      else if (d.name.kind === K.ArrayBindingPattern && (where === "local" || where === "for-of")) arrayBindingPattern(d.name as ts.ArrayBindingPattern);
      else e1000(d.name, "this destructuring");
      if (d.type) type(d.type);
      if (!d.initializer) { if (where !== "for-of") e1000(d.name, "declaration without initializer"); continue; }
      if (where === "module" && !immutable(d.initializer, d.type)) at("E5002", d.initializer, "module-level const must be an immutable literal", { kind: "module-nonliteral-const" });
      expr(d.initializer);
    }
  }

  function bindingPattern(p: ts.ObjectBindingPattern): void { // Q052: `const { a, b: c } = p` only
    for (const el of p.elements) {
      if (el.dotDotDotToken) { e1000(el, "rest element", { kind: "destructure-rest" }); continue; }
      if (el.propertyName && !isId(el.propertyName)) { e1000(el.propertyName, "this property name", { kind: "destructure-property" }); continue; }
      if (!isId(el.name)) { e1000(el.name ?? el, "nested destructuring", { kind: "nested-destructuring" }); continue; }
      declName(el.name);
      bind(el.name);
      if (el.initializer) at("E1008", el.name, "destructuring default is not allowed", { kind: "destructure-default", name: el.name.text });
    }
  }

  function arrayBindingPattern(p: ts.ArrayBindingPattern): void {
    for (const el of p.elements) {
      if (el.dotDotDotToken) { e1000(el, "rest element", { kind: "destructure-rest" }); continue; }
      if (!el.name) continue;
      if (!isId(el.name)) { e1000(el.name, "nested destructuring", { kind: "nested-destructuring" }); continue; }
      declName(el.name);
      bind(el.name);
      if (el.initializer) at("E1008", el.name, "destructuring default is not allowed", { kind: "destructure-default", name: el.name.text });
    }
  }

  /**
   * Q054: literal-only initializer, and no visibly mutable annotation.
   * shortcut: readonly-ness behind a type alias is not resolved here (needs P2 names); upgrade with module resolution (Q072).
   */
  function immutable(e: ts.Expression, t: ts.TypeNode | undefined): boolean {
    if (t?.kind === K.ArrayType) return false;
    if (t?.kind === K.TypeReference) {
      const tn = (t as ts.TypeReferenceNode).typeName;
      if (isId(tn) && MUTABLE_TYPES.has(tn.text)) return false;
    }
    if (t?.kind === K.TypeLiteral && (t as ts.TypeLiteralNode).members.some((m) => m.kind === K.PropertySignature && !(m as ts.PropertySignatureDeclaration).modifiers?.some((x) => x.kind === K.ReadonlyKeyword))) return false;
    return literal(e);
  }
  function literal(e: ts.Expression): boolean {
    switch (e.kind) {
      case K.NumericLiteral: case K.StringLiteral: case K.NoSubstitutionTemplateLiteral: case K.TrueKeyword: case K.FalseKeyword: case K.NullKeyword: case K.RegularExpressionLiteral:
        return true;
      case K.PrefixUnaryExpression: {
        const u = e as ts.PrefixUnaryExpression;
        return u.operator === K.MinusToken && u.operand.kind === K.NumericLiteral;
      }
      case K.ObjectLiteralExpression:
        return (e as ts.ObjectLiteralExpression).properties.every((p) => p.kind === K.PropertyAssignment && literal((p as ts.PropertyAssignment).initializer));
      case K.ArrayLiteralExpression:
        return (e as ts.ArrayLiteralExpression).elements.every(literal);
      default:
        return false;
    }
  }

  // ---- statements inside functions (§4)
  function loopBody(s: ts.Statement): void {
    fc.loops++; fc.breaks++;
    try { loopBody0(s); } finally { fc.loops--; fc.breaks--; }
  }
  function loopBody0(s: ts.Statement): void {
    if (s.kind === K.Block) {
      for (const b of (s as ts.Block).statements) {
        const c = calleeName(b);
        if (c?.name !== "invariant") break;
        allowedCalls.add(c.call);
      }
    }
    stmt(s);
  }

  function stmt(s: ts.Statement): void {
    switch (s.kind) {
      case K.Block: scoped(() => { for (const b of (s as ts.Block).statements) stmt(b); }); return;
      case K.VariableStatement: mods(s, []); varList((s as ts.VariableStatement).declarationList, "local"); return;
      case K.ExpressionStatement: {
        const x = (s as ts.ExpressionStatement).expression;
        if (x.kind === K.StringLiteral) {
          const lit = x as ts.StringLiteral;
          if (lit.text === UNSAFE_DIRECTIVE) at("E1009", lit, `'${UNSAFE_DIRECTIVE}' is only allowed as a directive of a strict or rt function`, { directive: UNSAFE_DIRECTIVE });
          else if (!strictDirectiveDiag(lit)) e1000(lit, "a string statement after the directive prologue", { kind: "misplaced-directive", directive: lit.text }); // Q176: a misplaced directive is not silently ignored
          return;
        }
        unusedIncs.add(x); expr(x); return;
      }
      case K.IfStatement: {
        const x = s as ts.IfStatement;
        expr(x.expression); stmt(x.thenStatement); if (x.elseStatement) stmt(x.elseStatement);
        return;
      }
      case K.WhileStatement: expr((s as ts.WhileStatement).expression); loopBody((s as ts.WhileStatement).statement); return;
      case K.DoStatement: loopBody((s as ts.DoStatement).statement); expr((s as ts.DoStatement).expression); return;
      case K.ForStatement: scoped(() => {
        const x = s as ts.ForStatement;
        if (x.initializer?.kind === K.VariableDeclarationList) varList(x.initializer as ts.VariableDeclarationList, "for");
        else if (x.initializer) expr(x.initializer as ts.Expression);
        if (x.condition) expr(x.condition);
        if (x.incrementor) { unusedIncs.add(x.incrementor); expr(x.incrementor); }
        loopBody(x.statement);
      }); return;
      case K.ForOfStatement: scoped(() => {
        const x = s as ts.ForOfStatement;
        if (x.awaitModifier) e1000(x.awaitModifier, "'for await'");
        if (x.initializer.kind === K.VariableDeclarationList) varList(x.initializer as ts.VariableDeclarationList, "for-of");
        else e1000(x.initializer, "for-of without 'const' or 'let'");
        expr(x.expression);
        loopBody(x.statement);
      }); return;
      case K.SwitchStatement: {
        const x = s as ts.SwitchStatement;
        expr(x.expression);
        fc.breaks++;
        for (const c of x.caseBlock.clauses) {
          if (c.kind === K.CaseClause) expr((c as ts.CaseClause).expression);
          scoped(() => { for (const b of c.statements) stmt(b); });
        }
        fc.breaks--;
        return;
      }
      case K.BreakStatement: case K.ContinueStatement: {
        const l = (s as ts.BreakStatement).label;
        if (l) {
          if (!fc.labels.has(l.text)) at("E1000", l, `unknown label '${l.text}'`, { kind: "label" });
        } else if (!(s.kind === K.BreakStatement ? fc.breaks : fc.loops)) {
          e1000(s, `'${s.kind === K.BreakStatement ? "break" : "continue"}' outside a loop`, { kind: s.kind === K.BreakStatement ? "break-outside-loop" : "continue-outside-loop" }); // Q124
        }
        return;
      }
      case K.ReturnStatement: { const e = (s as ts.ReturnStatement).expression; if (e) expr(e); return; }
      case K.ThrowStatement: at("E1007", s, "'throw' is not allowed; return 'Result<T, E>' via 'Result.ok(...)' / 'Result.err(...)' or call 'panic(msg)'", { kind: "throw", syntax: "throw" }); return;
      case K.TryStatement: at("E1007", s, "'try' is not allowed; propagate errors via 'Result<T, E>' instead of exceptions", { kind: "try", syntax: "try" }); return;
      case K.ForInStatement: at("E1000", s, "'for..in' is not allowed; use 'for..of' or an index loop", { kind: "for-in" }); return;
      case K.LabeledStatement: {
        const ls = s as ts.LabeledStatement;
        const inner = ls.statement;
        const isLoop = inner.kind === K.WhileStatement || inner.kind === K.DoStatement || inner.kind === K.ForStatement || inner.kind === K.ForOfStatement;
        if (!isLoop) {
          at("E1000", ls.label, "labeled statements are only allowed on loops", { kind: "labeled-statement" });
          stmt(inner);
          return;
        }
        const name = ls.label.text;
        if (fc.labels.has(name)) {
          at("E1000", ls.label, `duplicate label '${name}'`, { kind: "labeled-statement" });
          stmt(inner);
          return;
        }
        fc.labels.add(name);
        try {
          stmt(inner);
        } finally {
          fc.labels.delete(name);
        }
        return;
      }
      case K.EnumDeclaration: at("E1000", s, "'enum' is not allowed; use a string literal union type (e.g. 'type Kind = \"a\" | \"b\"')", { kind: "enum" }); return;
      case K.EmptyStatement: e1000(s, "empty statement ';'", { kind: "empty-statement" }); return;
      case K.FunctionDeclaration: e1000(s, "nested function declaration", { kind: "nested-function" }); return;
      case K.ClassDeclaration: e1000(s, "nested class declaration", { kind: "nested-class" }); return;
      case K.InterfaceDeclaration: e1000(s, "nested interface declaration", { kind: "nested-interface" }); return;
      case K.TypeAliasDeclaration: e1000(s, "nested type alias", { kind: "nested-type" }); return;
      case K.WithStatement: e1000(s, "'with' statement", { kind: "with" }); return;
      case K.DebuggerStatement: e1000(s, "'debugger' statement", { kind: "debugger" }); return;
      default: e1000(s, "this statement");
    }
  }

  // ---- expressions (§3, §4)
  function args(list: ts.NodeArray<ts.Expression> | undefined, allowSpread = false): void {
    for (const a of list ?? []) {
      if (allowSpread && a.kind === K.SpreadElement) expr((a as ts.SpreadElement).expression);
      else expr(a);
    }
  }

  function expr(e: ts.Expression): void {
    switch (e.kind) {
      case K.Identifier: {
        const t = (e as ts.Identifier).text;
        if (t === "arguments" || t === "eval") e1000(e, `'${t}'`, { kind: "reserved-name", name: t });
        return;
      }
      case K.NumericLiteral: case K.StringLiteral: case K.NoSubstitutionTemplateLiteral:
      case K.TrueKeyword: case K.FalseKeyword: case K.NullKeyword:
        return;
      case K.BigIntLiteral: {
        const raw = sf.text.slice(e.getStart(sf), e.end);
        at("E1000", e, "BigInt literals ('1n') are not allowed; use plain numeric literals for i64/u64", { kind: "bigint-literal", text: raw });
        if (/n$/i.test(raw)) fix("remove 'n' suffix", e.getStart(sf), e.end, raw.slice(0, -1));
        return;
      }
      case K.AwaitExpression:
        if (!fc.async) e1000(e, "'await' outside an async function", { kind: "await-outside-async" }); // Q124
        expr((e as ts.AwaitExpression).expression);
        return;
      case K.ThisKeyword: if (!fc.thisOk) e1000(e, "'this' outside an instance method or constructor", { kind: "this-outside-method" }); return; // Q120
      case K.TemplateExpression: for (const sp of (e as ts.TemplateExpression).templateSpans) expr(sp.expression); return;
      case K.ParenthesizedExpression: expr((e as ts.ParenthesizedExpression).expression); return;
      case K.ConditionalExpression: {
        const c = e as ts.ConditionalExpression;
        expr(c.condition); expr(c.whenTrue); expr(c.whenFalse);
        return;
      }
      case K.BinaryExpression: {
        const b = e as ts.BinaryExpression;
        const op = b.operatorToken;
        if (op.kind === K.EqualsEqualsToken || op.kind === K.ExclamationEqualsToken) {
          const opStr = op.kind === K.EqualsEqualsToken ? "==" : "!=";
          const repStr = op.kind === K.EqualsEqualsToken ? "===" : "!==";
          at("E1002", op, "use '===' / '!=='", { op: opStr });
          fix(`use '${repStr}'`, op.getStart(sf), op.end, repStr);
        } else if (!BINARY_OPS.has(op.kind)) {
          const opText = op.getText(sf);
          e1000(op, `operator '${opText}'`, { kind: op.kind === K.InstanceOfKeyword ? "instanceof" : "operator", op: opText });
        }
        let lhs = b.left;
        while (lhs.kind === K.ParenthesizedExpression) lhs = (lhs as ts.ParenthesizedExpression).expression;
        if (op.kind === K.EqualsToken && (lhs.kind === K.ArrayLiteralExpression || lhs.kind === K.ObjectLiteralExpression)) e1000(b.left, "destructuring assignment", { kind: "destructuring-assignment" });
        else expr(b.left);
        expr(b.right);
        return;
      }
      case K.PrefixUnaryExpression: {
        const u = e as ts.PrefixUnaryExpression;
        if (!PREFIX_OPS.has(u.operator)) {
          if (u.operator === K.PlusPlusToken || u.operator === K.MinusMinusToken) {
            if (!unusedIncs.has(u)) {
              const op = u.operator === K.PlusPlusToken ? "++" : "--";
              at("E1000", u, `'${op}' is only allowed as a statement or for-loop incrementor`, { kind: "inc-dec", op });
            }
          } else if (u.operator === K.PlusToken) {
            e1000(u, "unary '+'", { kind: "unary-operator", op: "+" });
          } else {
            e1000(u, "this unary operator");
          }
        }
        expr(u.operand);
        return;
      }
      case K.CallExpression: {
        const c = e as ts.CallExpression;
        const callee = c.expression;
        if (callee.kind === K.ImportKeyword) at("E7001", callee, "dynamic import is not allowed", { kind: "dynamic-import" });
        else if (isId(callee) && callee.text === "require") at("E7001", callee, "'require' is not allowed", { kind: "require" });
        else {
          if (isId(callee) && CONTRACTS.has(callee.text) && !allowedCalls.has(c)) at("E6001", callee, `'${callee.text}' is not allowed here`, { contract: callee.text });
          if (isId(callee) && callee.text === "test" && !allowedCalls.has(c)) at("E6003", callee, "'test' must be at module level", { kind: "misplaced-test" });
          if (isId(callee) && (callee.text === "forAll" || callee.text === "fuzzContracts") && !fc.inTest) at("E6004", callee, `'${callee.text}' must be inside a top-level 'test' callback`, { kind: "misplaced-forAll" });
          expr(callee);
        }
        for (const t of c.typeArguments ?? []) type(t);
        args(c.arguments, true);
        return;
      }
      case K.NewExpression: {
        const x = e as ts.NewExpression;
        expr(x.expression);
        for (const t of x.typeArguments ?? []) type(t);
        args(x.arguments, true);
        return;
      }
      case K.PropertyAccessExpression: {
        const p = e as ts.PropertyAccessExpression;
        expr(p.expression);
        if (p.name.kind !== K.Identifier) e1000(p.name, "private name");
        return;
      }
      case K.ElementAccessExpression: {
        const x = e as ts.ElementAccessExpression;
        expr(x.expression); expr(x.argumentExpression);
        return;
      }
      case K.ObjectLiteralExpression: {
        const keys = new Set<string>(); // Q223 (a): a key once per literal (a spread may still be overridden)
        for (const p of (e as ts.ObjectLiteralExpression).properties) {
          if (p.kind === K.PropertyAssignment) {
            const pa = p as ts.PropertyAssignment;
            if (!isId(pa.name)) e1000(pa.name, "this property name", { kind: pa.name.kind === K.ComputedPropertyName ? "computed-property" : "object-property-name" });
            else if (pa.name.text === "__proto__") e1000(pa.name, "property name '__proto__'", { kind: "reserved-name", name: "__proto__" }); // Q123
            else claim(keys, pa.name as ts.Identifier);
            expr(pa.initializer);
          } else if (p.kind === K.ShorthandPropertyAssignment) {
            const sp = p as ts.ShorthandPropertyAssignment;
            claim(keys, sp.name as ts.Identifier);
            if (sp.objectAssignmentInitializer) e1000(sp, "shorthand initializer", { kind: "shorthand-initializer" });
            expr(sp.name as ts.Identifier);
          } else if (p.kind === K.SpreadAssignment) expr((p as ts.SpreadAssignment).expression);
          else if (p.kind === K.MethodDeclaration) e1000(p, "method shorthand in object literal", { kind: "object-method" });
          else if (p.kind === K.GetAccessor || p.kind === K.SetAccessor) e1000(p, "getter/setter in object literal", { kind: "object-accessor" });
          else e1000(p, "this object literal member", { kind: "object-member" });
        }
        return;
      }
      case K.ArrayLiteralExpression:
        for (const x of (e as ts.ArrayLiteralExpression).elements) {
          if (x.kind === K.SpreadElement) expr((x as ts.SpreadElement).expression);
          else expr(x); // holes (OmittedExpression) fall to E1000
        }
        return;
      case K.ArrowFunction: fn(e as ts.ArrowFunction, "other"); return;
      case K.FunctionExpression: fn(e as ts.FunctionExpression, "other"); return;
      case K.AsExpression: {
        const a = e as ts.AsExpression;
        const s = pf.tokenAfter(a.expression.end); report("E1005", s, s + 2, "'as' is not allowed", { syntax: "as" }); // including `as const` (Q026)
        expr(a.expression);
        return;
      }
      case K.SatisfiesExpression: {
        const x = e as ts.SatisfiesExpression;
        const s = pf.tokenAfter(x.expression.end);
        report("E1000", s, s + "satisfies".length, "'satisfies' is not allowed; use a type annotation instead", { syntax: "satisfies" });
        expr(x.expression);
        return;
      }
      case K.NonNullExpression:
        report("E1006", e.end - 1, e.end, "non-null assertion is not allowed", { syntax: "non-null" });
        expr((e as ts.NonNullExpression).expression);
        return;
      case K.PostfixUnaryExpression: {
        const u = e as ts.PostfixUnaryExpression;
        if (!unusedIncs.has(u)) {
          const op = u.operator === K.PlusPlusToken ? "++" : "--";
          at("E1000", e, `'${op}' is only allowed as a statement or for-loop incrementor`, { kind: "inc-dec", op });
        }
        expr(u.operand);
        return;
      }
      case K.RegularExpressionLiteral: {
        const raw = sf.text.slice(e.getStart(sf), e.end);
        const last = raw.lastIndexOf("/");
        const pattern = raw.slice(1, last);
        const flags = raw.slice(last + 1);
        const seenFlags = new Set<string>();
        let badFlag: string | undefined;
        for (const ch of flags) {
          if (!"imsu".includes(ch) || seenFlags.has(ch)) { badFlag = ch; break; }
          seenFlags.add(ch);
        }
        if (badFlag !== undefined) {
          at("E1000", e, `unsupported or duplicate RegExp flag '${badFlag}'; only 'i', 'm', 's', 'u' are allowed`, { kind: "regex-flag", flags });
        } else {
          try {
            new globalThis.RegExp(pattern, flags);
          } catch (err) {
            at("E1000", e, `invalid regular expression literal: ${err instanceof Error ? err.message : String(err)}`, { kind: "regex-syntax" });
          }
        }
        return;
      }
      case K.TypeOfExpression: e1000(e, "'typeof' operator", { kind: "typeof" }); return;
      case K.DeleteExpression: e1000(e, "'delete' operator", { kind: "delete" }); return;
      case K.VoidExpression: e1000(e, "'void' operator", { kind: "void" }); return;
      case K.TaggedTemplateExpression: e1000(e, "tagged template expression", { kind: "tagged-template" }); return;
      case K.SuperKeyword: e1000(e, "'super'", { kind: "super" }); return;
      case K.YieldExpression: e1000(e, "'yield' expression", { kind: "yield" }); return;
      case K.SpreadElement: e1000(e, "spread argument '...'", { kind: "spread" }); return;
      case K.OmittedExpression: e1000(e, "omitted array element", { kind: "array-hole" }); return;
      case K.ClassExpression: e1000(e, "class expression", { kind: "class-expression" }); return;
      default: e1000(e, "this expression");
    }
  }

  // ---- types (§3)
  function type(t: ts.TypeNode): void {
    switch (t.kind) {
      case K.AnyKeyword: at("E1004", t, "'any' is not allowed", { syntax: "any" }); return;
      case K.BooleanKeyword: case K.StringKeyword: case K.NumberKeyword: case K.VoidKeyword: case K.UnknownKeyword: case K.NeverKeyword:
        return;
      case K.BigIntKeyword: case K.UndefinedKeyword: return; // names, not syntax: E2000 in P2 (Q011)
      case K.LiteralType: {
        const l = (t as ts.LiteralTypeNode).literal;
        if (l.kind !== K.StringLiteral && l.kind !== K.NullKeyword) e1000(t, "this literal type");
        return;
      }
      case K.TypeReference: {
        const r = t as ts.TypeReferenceNode;
        const qOk = r.typeName.kind === K.QualifiedName && isId((r.typeName as ts.QualifiedName).left) && isId((r.typeName as ts.QualifiedName).right);
        if (!isId(r.typeName) && !qOk) e1000(r.typeName, "qualified type name");
        else if (isId(r.typeName) && E1000_TYPE_NAMES.has(r.typeName.text)) e1000(r.typeName, `'${r.typeName.text}'`);
        for (const a of r.typeArguments ?? []) type(a);
        return;
      }
      case K.UnionType: for (const u of (t as ts.UnionTypeNode).types) type(u); return;
      case K.ParenthesizedType: type((t as ts.ParenthesizedTypeNode).type); return;
      case K.TypeLiteral: {
        const ms = (t as ts.TypeLiteralNode).members;
        if (!ms.length) { e1000(t, "'{}' type"); return; }
        const names = new Set<string>();
        for (const m of ms) {
          if (m.kind !== K.PropertySignature) { e1000(m, "this record member"); continue; }
          const p = m as ts.PropertySignatureDeclaration;
          mods(p, [K.ReadonlyKeyword]);
          memberName(p);
          if (isId(p.name)) claim(names, p.name);
          if (p.type) type(p.type);
        }
        return;
      }
      case K.FunctionType: {
        const f = t as ts.FunctionTypeNode;
        typeParams(f.typeParameters); params(f.parameters, { allowRest: fc.layer === undefined, layer: fc.layer }); if (f.type) type(f.type);
        return;
      }
      case K.ArrayType: {
        type((t as ts.ArrayTypeNode).elementType);
        return;
      }
      case K.TupleType: {
        const els = (t as ts.TupleTypeNode).elements;
        if (!els.length) {
          at("E1000", t, "empty tuple types '[]' are not allowed", { kind: "empty-tuple" });
          return;
        }
        for (const el of els) {
          if (el.kind === K.RestType) {
            e1000(el, "rest element in tuple type", { kind: "tuple-rest" });
          } else if (el.kind === K.OptionalType) {
            at("E1008", el, "optional tuple element is not allowed; use 'T | null'", { kind: "optional-tuple-elem" });
          } else if (el.kind === K.NamedTupleMember) {
            const nm = el as ts.NamedTupleMember;
            if (nm.dotDotDotToken) e1000(nm, "rest element in tuple type", { kind: "tuple-rest" });
            else if (nm.questionToken) at("E1008", nm, "optional tuple element is not allowed; use 'T | null'", { kind: "optional-tuple-elem", name: nm.name.text });
            type(nm.type);
          } else {
            type(el);
          }
        }
        return;
      }
      case K.IntersectionType:
        at("E1000", t, "intersection types '&' are only allowed in type parameter constraints", { kind: "intersection-type" });
        return;
      case K.TypeOperator: {
        const op = t as ts.TypeOperatorNode;
        if (op.operator === K.ReadonlyKeyword && (op.type.kind === K.ArrayType || op.type.kind === K.TupleType)) {
          type(op.type);
          return;
        }
        at("E1000", t, "type operator is not allowed", { kind: "type-operator" });
        return;
      }
      case K.TypeQuery:
        at("E1000", t, "'typeof' type query is not allowed", { kind: "type-query" });
        return;
      case K.IndexedAccessType:
        at("E1000", t, "indexed access types are not allowed", { kind: "indexed-access-type" });
        return;
      case K.ConditionalType: e1000(t, "conditional type", { kind: "conditional-type" }); return;
      case K.MappedType: e1000(t, "mapped type", { kind: "mapped-type" }); return;
      case K.ObjectKeyword: e1000(t, "'object' type", { kind: "object-type" }); return;
      case K.SymbolKeyword: e1000(t, "'symbol' type", { kind: "symbol-type" }); return;
      case K.TemplateLiteralType: e1000(t, "template literal type", { kind: "template-literal-type" }); return;
      default: e1000(t, "this type");
    }
  }
}
