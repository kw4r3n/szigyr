// Phase P1 (Q003): the syntax allowlist. Every node kind is accepted only by an explicit case below;
// anything else falls to a default branch that reports E1000. Anchors follow docs/DIAGNOSTICS.md.
import { dirname, resolve } from "node:path";
import type { Diagnostic } from "./diagnostics.ts";
import { DETMATH_PATH } from "./detmath.ts";
import { NodeFlags, SyntaxKind as K, type Node, type ParsedFile, type ts } from "./parse.ts";
import { RUNTIME_GLOBAL } from "./names.ts";

/** §12 global names; declaring any of them is E1000 (Q010). */
const BUILTIN_NAMES = new Set([
  "boolean", "string", "number", "f64", "f32", "i8", "i16", "i32", "u8", "u16", "u32", "usize", "null", "void", "unknown", "never",
  "Array", "ReadonlyArray", "Map", "Set", "Promise", "Result", "Struct", "Vec", "Slice", "Pool", "Handle", "Arena", "ArenaBuf", "Ref", "Mut", "OwnedCell",
  "System", "Alloc", "Fs", "Net", "Clock", "Random", "Log", "Js", "Ffi", "Spawn", "JsRef", "JsError", "CastError", "IoError", "Test",
  "Ptr", "ConstPtr", "CType", "CHandle", "cfn", "Port",
  "wrapAdd", "wrapSub", "wrapMul", "divTrunc", "rem", "ok", "err", "panic", "cast", "requires", "ensures", "invariant", "test",
  "Math", "Number", "JSON", "String", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs", "TestAlloc", "DetMath",
]);
/** Q004: type names rejected as E1000 rather than E2000. */
const E1000_TYPE_NAMES = new Set([
  "Function", "Partial", "Required", "Readonly", "Record", "Pick", "Omit", "Exclude", "Extract", "NonNullable", "Parameters",
  "ConstructorParameters", "ReturnType", "InstanceType", "ThisParameterType", "OmitThisParameter", "ThisType", "Awaited",
  "Uppercase", "Lowercase", "Capitalize", "Uncapitalize", "NoInfer",
]);
/** Q123: names the emitted strict-mode ESM cannot bind (reserved words, `eval` / `arguments`). */
const RESERVED_WORDS = new Set(["implements", "interface", "let", "package", "private", "protected", "public", "static", "yield", "await", "enum", "eval", "arguments"]);
/** Q123: member names with a special meaning on JS objects and classes. */
const SPECIAL_MEMBERS = new Set(["__proto__", "constructor", "prototype", "then"]);
const DIRECTIVES = new Set(["use owned", "use rt"]);
/** §14.4: a modifier on strict / rt functions, never a layer of its own (E1009 when misplaced). */
const UNSAFE_DIRECTIVE = "use unsafe";
const CONTRACTS = new Set(["requires", "ensures", "invariant"]);
/** Q054: annotation heads that make a module-level const mutable. */
const MUTABLE_TYPES = new Set(["Array", "Map", "Set", "Vec", "Pool", "Arena"]);
// Bitwise compound and logical assignments are not in SPEC (Q071): they fall to E1000.
const BINARY_OPS = new Set<K>([
  K.PlusToken, K.MinusToken, K.AsteriskToken, K.SlashToken, K.PercentToken, K.AsteriskAsteriskToken,
  K.LessThanToken, K.LessThanEqualsToken, K.GreaterThanToken, K.GreaterThanEqualsToken, K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken,
  K.AmpersandToken, K.BarToken, K.CaretToken, K.LessThanLessThanToken, K.GreaterThanGreaterThanToken, K.GreaterThanGreaterThanGreaterThanToken,
  K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionQuestionToken,
  K.EqualsToken, K.PlusEqualsToken, K.MinusEqualsToken, K.AsteriskEqualsToken, K.SlashEqualsToken, K.PercentEqualsToken, K.AsteriskAsteriskEqualsToken,
]);
const PREFIX_OPS = new Set<K>([K.MinusToken, K.ExclamationToken, K.TildeToken]);

/** Codes owned by phase P1 (Q003). */
export const P1_CODE = /^(E1\d{3}|E5002|E6001|E6003|E7001|E7002)$/;

type FnKind = "function" | "method" | "other";

/** P1 diagnostics for one parsed file. `file` is the path reported in diagnostics. */
export function checkSyntax(pf: ParsedFile, file: string = pf.path): Diagnostic[] {
  const sf = pf.sourceFile;
  const out: Diagnostic[] = [];
  const report = (code: string, start: number, end: number, message: string): void => {
    out.push({ code, severity: "error", message, file, range: { start: pf.position(start), end: pf.position(end) } });
  };
  const at = (code: string, n: Node, message: string): void => report(code, n.getStart(sf), n.end, message);
  /** Attaches a single-edit fix to the diagnostic just reported. */
  const fix = (title: string, start: number, end: number, newText: string): void => {
    out.at(-1)!.fixes = [{ title, edits: [{ range: { start: pf.position(start), end: pf.position(end) }, newText }] }];
  };
  /** `x++` / `x--` whose value is unused (statement or for-incrementor): `x += 1` is an exact rewrite. */
  const unusedIncs = new Set<Node>();
  const e1000 = (n: Node, what: string): void => at("E1000", n, `${what} is not allowed`);

  // Q070: a parse error is E1000 at the error; the file's AST is not walked further.
  if (pf.syntaxErrors.length) {
    for (const d of pf.syntaxErrors) report("E1000", d.start, Math.max(d.end, d.start), `syntax error: ${d.message}`);
    return out;
  }

  /** Contract and `test` calls that sit in an allowed position (E6001 / E6003 otherwise). */
  const allowedCalls = new Set<Node>();
  /** Q120 / Q124: what the enclosing function allows. Each function resets it; arrows inherit `thisOk`. */
  let fc = { thisOk: false, async: false, loops: 0, breaks: 0 };

  const isId = (n: Node | undefined): n is ts.Identifier => n?.kind === K.Identifier;
  const calleeName = (s: Node): { call: ts.CallExpression; name: string } | undefined => {
    if (s.kind !== K.ExpressionStatement) return;
    const c = (s as ts.ExpressionStatement).expression;
    if (c.kind !== K.CallExpression || !isId((c as ts.CallExpression).expression)) return;
    return { call: c as ts.CallExpression, name: ((c as ts.CallExpression).expression as ts.Identifier).text };
  };
  const declName = (id: ts.Identifier): void => {
    if (BUILTIN_NAMES.has(id.text)) at("E1000", id, `'${id.text}' is a builtin name`);
    else if (RESERVED_WORDS.has(id.text)) at("E1000", id, `'${id.text}' is a reserved word`);
    else if (id.text.startsWith(RUNTIME_GLOBAL)) at("E1000", id, `names starting with '${RUNTIME_GLOBAL}' are reserved`);
  };
  const mods = (n: Node, allowed: K[]): void => {
    const ms = (n as Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
    for (const m of ms ?? []) {
      if (m.kind === K.DefaultKeyword) at("E1003", ms![0]!, "default export is not allowed");
      else if (!allowed.includes(m.kind)) e1000(m, "this modifier");
    }
  };

  // ---- same-name declarations in one scope (Q004 declaration merging, Q087)
  const scopes: Set<string>[] = [];
  const claim = (seen: Set<string>, id: ts.Identifier): void => {
    if (seen.has(id.text)) at("E1000", id, `declaration merging ('${id.text}' declared twice)`);
    seen.add(id.text);
  };
  const bind = (id: ts.Identifier): void => { const s = scopes.at(-1); if (s) claim(s, id); };
  const scoped = (f: () => void): void => { scopes.push(new Set()); try { f(); } finally { scopes.pop(); } };

  // ---- module level (§1, Q054)
  const topNames = new Set<string>();
  const topName = (id: ts.Identifier | undefined): void => {
    if (!id) return;
    if (topNames.has(id.text)) at("E1000", id, `declaration merging ('${id.text}' declared twice)`);
    topNames.add(id.text);
  };
  /** The file-level layer directive, for functions that only add "use unsafe" (§14.4). */
  let fileLayer: string | undefined;
  /** `declare module "c:..."` blocks of this file, specifier -> declared C function names (§14.1). */
  const cDeclares = new Map<string, Set<string>>();
  const stmts = sf.statements;
  for (const s0 of stmts) if (s0.kind === K.ModuleDeclaration) moduleDecl(s0 as ts.ModuleDeclaration); // §14.1: before imports resolve against it
  for (let i = prologue(stmts, true, true); i < stmts.length; i++) {
    const s = stmts[i]!;
    switch (s.kind) {
      case K.ImportDeclaration: importDecl(s as ts.ImportDeclaration); break;
      case K.ExportDeclaration: exportDecl(s as ts.ExportDeclaration); break;
      case K.ExportAssignment:
        if ((s as ts.ExportAssignment).isExportEquals) at("E7001", s, "'export =' is not allowed");
        else at("E1003", s, "default export is not allowed");
        break;
      case K.ImportEqualsDeclaration: at("E7001", s, "'import =' is not allowed"); break;
      case K.FunctionDeclaration:
        if ((s as ts.FunctionDeclaration).body) topName((s as ts.FunctionDeclaration).name);
        fn(s as ts.FunctionDeclaration, "function");
        break;
      case K.ClassDeclaration: topName((s as ts.ClassDeclaration).name); classDecl(s as ts.ClassDeclaration); break;
      case K.InterfaceDeclaration: topName((s as ts.InterfaceDeclaration).name); interfaceDecl(s as ts.InterfaceDeclaration); break;
      case K.TypeAliasDeclaration: topName((s as ts.TypeAliasDeclaration).name); typeAlias(s as ts.TypeAliasDeclaration); break;
      case K.VariableStatement:
        mods(s, [K.ExportKeyword]);
        for (const d of (s as ts.VariableStatement).declarationList.declarations) if (isId(d.name)) topName(d.name);
        varList((s as ts.VariableStatement).declarationList, "module");
        break;
      case K.ModuleDeclaration: break; // handled above
      case K.ExpressionStatement: {
        const x0 = (s as ts.ExpressionStatement).expression;
        if (x0.kind === K.StringLiteral && (x0 as ts.StringLiteral).text === UNSAFE_DIRECTIVE) { at("E1009", x0, `'${UNSAFE_DIRECTIVE}' at module level`); break; }
        const c = calleeName(s);
        if (c?.name === "test") allowedCalls.add(c.call);
        else { e1000(s, "this statement at module level"); break; }
        stmt(s);
        break;
      }
      default: e1000(s, "this statement at module level");
    }
  }
  return out;

  /** Leading string-literal statements (directives, Q039). Returns the index of the first other statement.
   * §14.4: "use unsafe" may accompany the layer directive in either order; anywhere else it is E1009. */
  function prologue(list: ts.NodeArray<ts.Statement>, allowDirective: boolean, isModule = false): number {
    const lits: ts.StringLiteral[] = [];
    let i = 0;
    for (; i < list.length; i++) {
      const s = list[i]!;
      if (s.kind !== K.ExpressionStatement || (s as ts.ExpressionStatement).expression.kind !== K.StringLiteral) break;
      lits.push((s as ts.ExpressionStatement).expression as ts.StringLiteral);
    }
    let layerAt = -1;
    if (allowDirective && lits[0] && DIRECTIVES.has(lits[0].text)) layerAt = 0;
    else if (allowDirective && lits[0]?.text === UNSAFE_DIRECTIVE && lits[1] && DIRECTIVES.has(lits[1].text)) layerAt = 1;
    const layer = layerAt >= 0 ? lits[layerAt]!.text : undefined;
    if (isModule) fileLayer = layer;
    let unsafeSeen = false;
    lits.forEach((lit, j) => {
      if (DIRECTIVES.has(lit.text)) {
        if (j !== layerAt) e1000(lit, `directive '${lit.text}' here`);
      } else if (lit.text === UNSAFE_DIRECTIVE) {
        if (isModule || !allowDirective || unsafeSeen || (layer ?? fileLayer) === undefined) {
          at("E1009", lit, `'${UNSAFE_DIRECTIVE}' is only allowed once, in a strict or rt function`);
        }
        unsafeSeen = true;
      } else e1000(lit, `directive '${lit.text}' here`);
    });
    return i;
  }

  /** §14.1: a `c:` specifier is `c:` + two non-empty parts without space, `:`, `<`, `>`, `"` or `\\`. */
  function cSpecifierOk(text: string): boolean {
    if (!text.startsWith("c:")) return false;
    const parts = text.slice(2).split(":");
    return parts.length === 2 && parts.every((q) => q.length > 0 && !/[ :<>"\\]/.test(q));
  }
  function moduleDecl(d: ts.ModuleDeclaration): void {
    mods(d, [K.DeclareKeyword]);
    if (d.name.kind !== K.StringLiteral) { e1000(d.name, "this module name"); return; }
    const spec = (d.name as ts.StringLiteral).text;
    if (!spec.startsWith("c:")) { e1000(d, "this module declaration"); return; }
    if (!cSpecifierOk(spec)) at("E7002", d.name, "a 'c:' specifier is 'c:<package>:<header>'");
    else if (cDeclares.has(spec)) at("E7002", d.name, `duplicate 'declare module' for '${spec}'`);
    if (!d.body || d.body.kind !== K.ModuleBlock) { at("E7002", d.name, "'declare module' needs a body of function declarations"); return; }
    const names = cDeclares.get(spec) ?? new Set<string>();
    if (!cDeclares.has(spec)) cDeclares.set(spec, names);
    for (const st of (d.body as ts.ModuleBlock).statements) {
      if (st.kind !== K.FunctionDeclaration) { e1000(st, "only function declarations in a 'c:' module"); continue; }
      const f = st as ts.FunctionDeclaration;
      mods(f, []);
      if (!f.name) { e1000(f, "a C function without a name"); continue; }
      if (names.has(f.name.text)) at("E1000", f.name, `declaration merging ('${f.name.text}' declared twice)`);
      names.add(f.name.text);
      if (f.typeParameters?.length) at("E1000", f.typeParameters[0]!, "type parameters on a C function");
      if (f.body) e1000(f, "a C function declaration has no body");
      params(f.parameters);
      if (f.type) type(f.type);
    }
  }

  function specifierOk(text: string): boolean {
    if (text.startsWith("npm:")) return text.length > 4;
    return (text.startsWith("./") || text.startsWith("../")) && text.endsWith(".ts");
  }

  function importDecl(d: ts.ImportDeclaration): void {
    const ic = d.importClause;
    const nb = ic?.namedBindings;
    if (!ic || ic.phaseModifier || ic.name || nb?.kind !== K.NamedImports || d.attributes ||
        (nb as ts.NamedImports).elements.some((e) => e.isTypeOnly || (e.propertyName && !(isId(e.propertyName) && e.propertyName.text !== "default")))) {
      at("E7001", d, "only 'import { a, b as c } from \"...\"' is allowed");
      return;
    }
    if (d.moduleSpecifier.kind === K.StringLiteral && (d.moduleSpecifier as ts.StringLiteral).text.startsWith("c:")) {
      const spec = (d.moduleSpecifier as ts.StringLiteral).text;
      if (!cSpecifierOk(spec)) { at("E7002", d.moduleSpecifier, "a 'c:' specifier is 'c:<package>:<header>'"); return; }
      const declared = cDeclares.get(spec);
      if (!declared) { at("E7002", d.moduleSpecifier, `no 'declare module "${spec}"' in this file`); return; }
      for (const e of (nb as ts.NamedImports).elements) {
        const orig = e.propertyName?.text ?? e.name.text;
        if (!declared.has(orig)) at("E7002", e.propertyName ?? e.name, `'${orig}' is not declared in '${spec}'`);
        declName(e.name); topName(e.name);
      }
      return;
    }
    if (d.moduleSpecifier.kind !== K.StringLiteral || !specifierOk((d.moduleSpecifier as ts.StringLiteral).text)) {
      at("E7001", d.moduleSpecifier, "module specifier must be './x.ts', '../x.ts' or 'npm:name'");
      return;
    }
    const specText = (d.moduleSpecifier as ts.StringLiteral).text;
    if (!specText.startsWith("npm:") && resolve(dirname(pf.path), specText) === DETMATH_PATH) { // §12 (Q191)
      at("E7001", d.moduleSpecifier, "the bundled DetMath module cannot be imported; use the DetMath namespace");
      return;
    }
    for (const e of (nb as ts.NamedImports).elements) { declName(e.name); topName(e.name); }
  }

  function exportDecl(d: ts.ExportDeclaration): void {
    if (d.moduleSpecifier) {
      if (!d.exportClause || d.exportClause.kind === K.NamespaceExport) at("E1003", d, "'export *' is not allowed");
      else at("E7001", d, "re-export is not allowed");
    } else if (d.isTypeOnly || d.exportClause?.kind !== K.NamedExports) {
      at("E7001", d, "only 'export { a, b as c }' is allowed");
    } else {
      for (const e of (d.exportClause as ts.NamedExports).elements) {
        if (isId(e.name) && e.name.text === "default") { at("E1003", d, "default export is not allowed"); return; }
        if (e.isTypeOnly || !isId(e.name) || (e.propertyName && !isId(e.propertyName))) { at("E7001", d, "only 'export { a, b as c }' is allowed"); return; }
      }
    }
  }

  // ---- declarations
  function fn(n: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.ConstructorDeclaration, kind: FnKind): void {
    const saved = fc;
    const thisOk = n.kind === K.ArrowFunction ? fc.thisOk : n.kind === K.Constructor || (n.kind === K.MethodDeclaration && !n.modifiers?.some((m) => m.kind === K.StaticKeyword));
    fc = { thisOk, async: !!n.modifiers?.some((m) => m.kind === K.AsyncKeyword), loops: 0, breaks: 0 };
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
    params(n.parameters);
    for (const p of n.parameters) if (isId(p.name)) bind(p.name);
    if (n.type) type(n.type);
    const body = n.body;
    if (!body) { e1000(n, "function overload or declaration without body"); return; }
    if (body.kind !== K.Block) { expr(body as ts.Expression); return; }
    const list = (body as ts.Block).statements;
    let i = prologue(list, kind === "function");
    const start = i;
    if (kind !== "other") { // Q057: directive, then requires*, then ensures*
      let seenEnsures = false;
      for (; i < list.length; i++) {
        const c = calleeName(list[i]!);
        if (c?.name === "requires" && !seenEnsures) allowedCalls.add(c.call);
        else if (c?.name === "ensures" && !isAsync) { seenEnsures = true; allowedCalls.add(c.call); }
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
      if (p.constraint) { if (p.constraint.kind === K.TypeReference) type(p.constraint); else e1000(p.constraint, "this type parameter constraint"); }
      if (p.defaultType) e1000(p.defaultType, "default type argument");
    }
  }

  function params(list: ts.NodeArray<ts.ParameterDeclaration>): void {
    for (const p of list) {
      mods(p, []);
      if (p.dotDotDotToken) { e1000(p, "rest parameter"); continue; }
      if (!isId(p.name)) { e1000(p.name, "parameter destructuring"); continue; }
      if (p.name.text === "this") { e1000(p.name, "'this' parameter"); continue; }
      declName(p.name);
      if (p.questionToken) at("E1008", p.name, "optional parameter is not allowed");
      else if (p.initializer) at("E1008", p.name, "default parameter is not allowed");
      if (p.type) type(p.type);
    }
  }

  function memberName(n: Node & { name: ts.PropertyName; postfixToken?: Node }): void {
    if (!isId(n.name)) e1000(n.name, "this member name");
    else if (SPECIAL_MEMBERS.has(n.name.text) || n.name.text.startsWith(RUNTIME_GLOBAL)) e1000(n.name, `member name '${n.name.text}'`); // Q123
    if (n.postfixToken?.kind === K.QuestionToken) at("E1008", n.name, "optional member is not allowed");
    else if (n.postfixToken) e1000(n.postfixToken, "definite assignment assertion");
  }

  function classDecl(c: ts.ClassDeclaration): void {
    mods(c, [K.ExportKeyword]);
    if (c.name) declName(c.name);
    typeParams(c.typeParameters);
    for (const h of c.heritageClauses ?? []) {
      if (h.token !== K.ImplementsKeyword) { e1000(h, "'extends' on a class"); continue; }
      for (const t of h.types) {
        if (!isId(t.expression)) e1000(t.expression, "this implements clause");
        for (const a of t.typeArguments ?? []) type(a);
      }
    }
    const members = new Set<string>();
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
            at("E5002", p.initializer ?? p.name, "static field must be readonly with a literal initializer");
          }
          if (p.initializer) expr(p.initializer);
          break;
        }
        case K.MethodDeclaration: {
          const md = m as ts.MethodDeclaration;
          if (md.asteriskToken) { e1000(md.asteriskToken, "generator method"); break; }
          memberName(md);
          fn(md, "method");
          break;
        }
        case K.Constructor: fn(m as ts.ConstructorDeclaration, "other"); break;
        default: e1000(m, "this class member");
      }
    }
  }

  function interfaceDecl(d: ts.InterfaceDeclaration): void {
    mods(d, [K.ExportKeyword]);
    declName(d.name);
    typeParams(d.typeParameters);
    for (const h of d.heritageClauses ?? []) e1000(h, "'extends' on an interface");
    for (const m of d.members) {
      if (m.kind !== K.MethodSignature) { e1000(m, "interface member other than a method signature"); continue; }
      const s = m as ts.MethodSignatureDeclaration;
      mods(s, []);
      memberName(s);
      typeParams(s.typeParameters);
      params(s.parameters);
      if (s.type) type(s.type);
    }
  }

  function incFix(u: Node, op: K, operand: ts.Expression): void {
    if ((op !== K.PlusPlusToken && op !== K.MinusMinusToken) || !unusedIncs.has(u)) return;
    fix(`use '${op === K.PlusPlusToken ? "+=" : "-="} 1'`, u.getStart(sf), u.end, `${sf.text.slice(operand.getStart(sf), operand.end)} ${op === K.PlusPlusToken ? "+=" : "-="} 1`);
  }

  function typeAlias(d: ts.TypeAliasDeclaration): void {
    mods(d, [K.ExportKeyword]);
    declName(d.name);
    typeParams(d.typeParameters);
    type(d.type);
  }

  function varList(list: ts.VariableDeclarationList, where: "module" | "local" | "for-of"): void {
    if (list.flags & NodeFlags.Using) { e1000(list, "'using'"); return; }
    const isLet = !!(list.flags & NodeFlags.Let);
    if (!isLet && !(list.flags & NodeFlags.Const)) {
      const s = list.getStart(sf);
      at("E1001", list, "'var' is not allowed");
      fix(`use '${where === "local" ? "let" : "const"}'`, s, s + 3, where === "local" ? "let" : "const"); // 'let' is not allowed at module level or in for-of
      return;
    }
    if (isLet && where === "module") { at("E5002", list, "module-level 'let' is not allowed"); return; }
    if (isLet && where === "for-of") { e1000(list, "'for (let ... of ...)'"); return; }
    for (const d of list.declarations) {
      if (d.exclamationToken) e1000(d.exclamationToken, "definite assignment assertion");
      if (isId(d.name)) { declName(d.name); bind(d.name); }
      else if (d.name.kind === K.ObjectBindingPattern && !isLet && where !== "for-of") bindingPattern(d.name as ts.ObjectBindingPattern);
      else e1000(d.name, "this destructuring");
      if (d.type) type(d.type);
      if (!d.initializer) { if (where !== "for-of") e1000(d.name, "declaration without initializer"); continue; }
      if (where === "module" && !immutable(d.initializer, d.type)) at("E5002", d.initializer, "module-level const must be an immutable literal");
      expr(d.initializer);
    }
  }

  function bindingPattern(p: ts.ObjectBindingPattern): void { // Q052: `const { a, b: c } = p` only
    for (const el of p.elements) {
      if (el.dotDotDotToken) { e1000(el, "rest element"); continue; }
      if (el.propertyName && !isId(el.propertyName)) { e1000(el.propertyName, "this property name"); continue; }
      if (!isId(el.name)) { e1000(el.name ?? el, "nested destructuring"); continue; }
      declName(el.name);
      bind(el.name);
      if (el.initializer) at("E1008", el.name, "destructuring default is not allowed");
    }
  }

  /**
   * Q054: literal-only initializer, and no visibly mutable annotation.
   * shortcut: readonly-ness behind a type alias is not resolved here (needs P2 names); upgrade with module resolution (Q072).
   */
  function immutable(e: ts.Expression, t: ts.TypeNode | undefined): boolean {
    if (t?.kind === K.TypeReference) {
      const tn = (t as ts.TypeReferenceNode).typeName;
      if (isId(tn) && MUTABLE_TYPES.has(tn.text)) return false;
    }
    if (t?.kind === K.TypeLiteral && (t as ts.TypeLiteralNode).members.some((m) => m.kind === K.PropertySignature && !(m as ts.PropertySignatureDeclaration).modifiers?.some((x) => x.kind === K.ReadonlyKeyword))) return false;
    return literal(e);
  }
  function literal(e: ts.Expression): boolean {
    switch (e.kind) {
      case K.NumericLiteral: case K.StringLiteral: case K.NoSubstitutionTemplateLiteral: case K.TrueKeyword: case K.FalseKeyword: case K.NullKeyword:
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
          if ((x as ts.StringLiteral).text === UNSAFE_DIRECTIVE) at("E1009", x, `'${UNSAFE_DIRECTIVE}' is only allowed as a directive of a strict or rt function`);
          else e1000(x, "a string statement after the directive prologue"); // Q176: a misplaced directive is not silently ignored
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
        if (x.initializer?.kind === K.VariableDeclarationList) varList(x.initializer as ts.VariableDeclarationList, "local");
        else if (x.initializer) expr(x.initializer as ts.Expression);
        if (x.condition) expr(x.condition);
        if (x.incrementor) { unusedIncs.add(x.incrementor); expr(x.incrementor); }
        loopBody(x.statement);
      }); return;
      case K.ForOfStatement: scoped(() => {
        const x = s as ts.ForOfStatement;
        if (x.awaitModifier) e1000(x.awaitModifier, "'for await'");
        if (x.initializer.kind === K.VariableDeclarationList) varList(x.initializer as ts.VariableDeclarationList, "for-of");
        else e1000(x.initializer, "for-of without 'const'");
        expr(x.expression);
        loopBody(x.statement);
      }); return;
      case K.SwitchStatement: {
        const x = s as ts.SwitchStatement;
        expr(x.expression);
        fc.breaks++;
        scoped(() => { // the case block is one scope
          for (const c of x.caseBlock.clauses) {
            if (c.kind === K.CaseClause) expr((c as ts.CaseClause).expression);
            for (const b of c.statements) stmt(b);
          }
        });
        fc.breaks--;
        return;
      }
      case K.BreakStatement: case K.ContinueStatement: {
        const l = (s as ts.BreakStatement).label;
        if (l) e1000(l, "label");
        else if (!(s.kind === K.BreakStatement ? fc.breaks : fc.loops)) e1000(s, `'${s.kind === K.BreakStatement ? "break" : "continue"}' outside a loop`); // Q124
        return;
      }
      case K.ReturnStatement: { const e = (s as ts.ReturnStatement).expression; if (e) expr(e); return; }
      case K.ThrowStatement: at("E1007", s, "'throw' is not allowed"); return;
      case K.TryStatement: at("E1007", s, "'try' is not allowed"); return;
      default: e1000(s, "this statement"); // includes labels, for-in, with, nested declarations (Q055)
    }
  }

  // ---- expressions (§3, §4)
  function args(list: ts.NodeArray<ts.Expression> | undefined): void {
    for (const a of list ?? []) expr(a); // a spread argument falls to E1000 (Q053)
  }

  function expr(e: ts.Expression): void {
    switch (e.kind) {
      case K.Identifier: {
        const t = (e as ts.Identifier).text;
        if (t === "arguments" || t === "eval") e1000(e, `'${t}'`);
        return;
      }
      case K.NumericLiteral: case K.StringLiteral: case K.NoSubstitutionTemplateLiteral:
      case K.TrueKeyword: case K.FalseKeyword: case K.NullKeyword:
        return;
      case K.ThisKeyword: if (!fc.thisOk) e1000(e, "'this' outside an instance method or constructor"); return; // Q120
      case K.TemplateExpression: for (const sp of (e as ts.TemplateExpression).templateSpans) expr(sp.expression); return;
      case K.ParenthesizedExpression: expr((e as ts.ParenthesizedExpression).expression); return;
      case K.AwaitExpression:
        if (!fc.async) e1000(e, "'await' outside an async function"); // Q124
        expr((e as ts.AwaitExpression).expression);
        return;
      case K.ConditionalExpression: {
        const c = e as ts.ConditionalExpression;
        expr(c.condition); expr(c.whenTrue); expr(c.whenFalse);
        return;
      }
      case K.BinaryExpression: {
        const b = e as ts.BinaryExpression;
        const op = b.operatorToken;
        if (op.kind === K.EqualsEqualsToken || op.kind === K.ExclamationEqualsToken) { at("E1002", op, "use '===' / '!=='"); fix(`use '${op.kind === K.EqualsEqualsToken ? "===" : "!=="}'`, op.getStart(sf), op.end, op.kind === K.EqualsEqualsToken ? "===" : "!=="); }
        else if (!BINARY_OPS.has(op.kind)) e1000(op, "this operator");
        if (op.kind === K.EqualsToken && (b.left.kind === K.ArrayLiteralExpression || b.left.kind === K.ObjectLiteralExpression)) e1000(b.left, "destructuring assignment");
        else expr(b.left);
        expr(b.right);
        return;
      }
      case K.PrefixUnaryExpression: {
        const u = e as ts.PrefixUnaryExpression;
        if (!PREFIX_OPS.has(u.operator)) { e1000(u, "this unary operator"); incFix(u, u.operator, u.operand); }
        expr(u.operand);
        return;
      }
      case K.CallExpression: {
        const c = e as ts.CallExpression;
        if (c.questionDotToken) e1000(c, "optional call");
        const callee = c.expression;
        if (callee.kind === K.ImportKeyword) at("E7001", callee, "dynamic import is not allowed");
        else if (isId(callee) && callee.text === "require") at("E7001", callee, "'require' is not allowed");
        else {
          if (isId(callee) && CONTRACTS.has(callee.text) && !allowedCalls.has(c)) at("E6001", callee, `'${callee.text}' is not allowed here`);
          if (isId(callee) && callee.text === "test" && !allowedCalls.has(c)) at("E6003", callee, "'test' must be at module level");
          expr(callee);
        }
        for (const t of c.typeArguments ?? []) type(t);
        args(c.arguments);
        return;
      }
      case K.NewExpression: {
        const x = e as ts.NewExpression;
        expr(x.expression);
        for (const t of x.typeArguments ?? []) type(t);
        args(x.arguments);
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
        if (x.questionDotToken) e1000(x, "'?.[]'");
        expr(x.expression); expr(x.argumentExpression);
        return;
      }
      case K.ObjectLiteralExpression:
        for (const p of (e as ts.ObjectLiteralExpression).properties) {
          if (p.kind === K.PropertyAssignment) {
            const pa = p as ts.PropertyAssignment;
            if (!isId(pa.name)) e1000(pa.name, "this property name");
            else if (pa.name.text === "__proto__") e1000(pa.name, "property name '__proto__'"); // Q123
            expr(pa.initializer);
          } else if (p.kind === K.ShorthandPropertyAssignment) {
            const sp = p as ts.ShorthandPropertyAssignment;
            if (sp.objectAssignmentInitializer) e1000(sp, "shorthand initializer");
            expr(sp.name as ts.Identifier);
          } else if (p.kind === K.SpreadAssignment) expr((p as ts.SpreadAssignment).expression);
          else e1000(p, "this object literal member");
        }
        return;
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
        const s = pf.tokenAfter(a.expression.end); report("E1005", s, s + 2, "'as' is not allowed"); // including `as const` (Q026)
        expr(a.expression);
        return;
      }
      case K.SatisfiesExpression: {
        const x = e as ts.SatisfiesExpression;
        const s = pf.tokenAfter(x.expression.end);
        report("E1000", s, s + "satisfies".length, "'satisfies' is not allowed");
        expr(x.expression);
        return;
      }
      case K.NonNullExpression:
        report("E1006", e.end - 1, e.end, "non-null assertion is not allowed");
        expr((e as ts.NonNullExpression).expression);
        return;
      case K.PostfixUnaryExpression: {
        const u = e as ts.PostfixUnaryExpression;
        e1000(e, "this expression");
        incFix(u, u.operator, u.operand);
        return;
      }
      default: e1000(e, "this expression"); // typeof, void, delete, yield, ++/--, tagged templates, regex, bigint, super, ...
    }
  }

  // ---- types (§3)
  function type(t: ts.TypeNode): void {
    switch (t.kind) {
      case K.AnyKeyword: at("E1004", t, "'any' is not allowed"); return;
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
        if (!isId(r.typeName)) e1000(r.typeName, "qualified type name");
        else if (E1000_TYPE_NAMES.has(r.typeName.text)) e1000(r.typeName, `'${r.typeName.text}'`);
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
        typeParams(f.typeParameters); params(f.parameters); if (f.type) type(f.type);
        return;
      }
      case K.ArrayType: {
        const el = (t as ts.ArrayTypeNode).elementType;
        e1000(t, "this type");
        fix("use 'Array<T>'", t.getStart(sf), t.end, `Array<${sf.text.slice(el.getStart(sf), el.end)}>`);
        return;
      }
      default: e1000(t, "this type"); // T[], tuples, intersections, keyof, typeof, conditional, mapped, indexed, object, symbol, ...
    }
  }
}
