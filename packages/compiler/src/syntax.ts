// Phase P1 (Q003): the syntax allowlist. Every node kind is accepted only by an explicit case below;
// anything else falls to a default branch that reports E1000. Anchors follow docs/DIAGNOSTICS.md.
import type { Diagnostic } from "./diagnostics.ts";
import { NodeFlags, SyntaxKind as K, type Node, type ParsedFile, type ts } from "./parse.ts";

/** §12 global names; declaring any of them is E1000 (Q010). */
const BUILTIN_NAMES = new Set([
  "boolean", "string", "number", "f64", "f32", "i8", "i16", "i32", "u8", "u16", "u32", "usize", "null", "void", "unknown", "never",
  "Array", "ReadonlyArray", "Map", "Set", "Promise", "Result", "Struct", "Vec", "Slice", "Ref", "Mut", "OwnedCell",
  "System", "Alloc", "Fs", "Net", "Clock", "Random", "Log", "Js", "Ffi", "Spawn", "JsRef", "JsError", "CastError", "IoError", "Test",
  "wrapAdd", "wrapSub", "wrapMul", "divTrunc", "rem", "ok", "err", "panic", "cast", "requires", "ensures", "invariant", "test",
  "Math", "Number", "JSON", "String", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs", "TestAlloc",
]);
/** Q004: type names rejected as E1000 rather than E2000. */
const E1000_TYPE_NAMES = new Set([
  "Function", "Partial", "Required", "Readonly", "Record", "Pick", "Omit", "Exclude", "Extract", "NonNullable", "Parameters",
  "ConstructorParameters", "ReturnType", "InstanceType", "ThisParameterType", "OmitThisParameter", "ThisType", "Awaited",
  "Uppercase", "Lowercase", "Capitalize", "Uncapitalize", "NoInfer",
]);
const DIRECTIVES = new Set(["use owned", "use rt"]);
const CONTRACTS = new Set(["requires", "ensures", "invariant"]);
/** Q054: annotation heads that make a module-level const mutable. */
const MUTABLE_TYPES = new Set(["Array", "Map", "Set", "Vec"]);
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
export const P1_CODE = /^(E1\d{3}|E5002|E6001|E6003|E7001)$/;

type FnKind = "function" | "method" | "other";

/** P1 diagnostics for one parsed file. `file` is the path reported in diagnostics. */
export function checkSyntax(pf: ParsedFile, file: string = pf.path): Diagnostic[] {
  const sf = pf.sourceFile;
  const out: Diagnostic[] = [];
  const report = (code: string, start: number, end: number, message: string): void => {
    out.push({ code, severity: "error", message, file, range: { start: pf.position(start), end: pf.position(end) } });
  };
  const at = (code: string, n: Node, message: string): void => report(code, n.getStart(sf), n.end, message);
  const e1000 = (n: Node, what: string): void => at("E1000", n, `${what} is not allowed`);

  // Q070: a parse error is E1000 at the error; the file's AST is not walked further.
  if (pf.syntaxErrors.length) {
    for (const d of pf.syntaxErrors) report("E1000", d.start, Math.max(d.end, d.start), `syntax error: ${d.message}`);
    return out;
  }

  /** Contract and `test` calls that sit in an allowed position (E6001 / E6003 otherwise). */
  const allowedCalls = new Set<Node>();
  let classDepth = 0;

  const isId = (n: Node | undefined): n is ts.Identifier => n?.kind === K.Identifier;
  const calleeName = (s: Node): { call: ts.CallExpression; name: string } | undefined => {
    if (s.kind !== K.ExpressionStatement) return;
    const c = (s as ts.ExpressionStatement).expression;
    if (c.kind !== K.CallExpression || !isId((c as ts.CallExpression).expression)) return;
    return { call: c as ts.CallExpression, name: ((c as ts.CallExpression).expression as ts.Identifier).text };
  };
  const declName = (id: ts.Identifier): void => {
    if (BUILTIN_NAMES.has(id.text)) at("E1000", id, `'${id.text}' is a builtin name`);
  };
  const mods = (n: Node, allowed: K[]): void => {
    const ms = (n as Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
    for (const m of ms ?? []) {
      if (m.kind === K.DefaultKeyword) at("E1003", ms![0]!, "default export is not allowed");
      else if (!allowed.includes(m.kind)) e1000(m, "this modifier");
    }
  };

  // ---- module level (§1, Q054)
  const topNames = new Set<string>();
  const topName = (id: ts.Identifier | undefined): void => {
    if (!id) return;
    if (topNames.has(id.text)) at("E1000", id, `declaration merging ('${id.text}' declared twice)`);
    topNames.add(id.text);
  };
  const stmts = sf.statements;
  for (let i = prologue(stmts, true); i < stmts.length; i++) {
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
      case K.ExpressionStatement: {
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

  /** Leading string-literal statements (directives, Q039). Returns the index of the first other statement. */
  function prologue(list: ts.NodeArray<ts.Statement>, allowDirective: boolean): number {
    let i = 0;
    for (; i < list.length; i++) {
      const s = list[i]!;
      if (s.kind !== K.ExpressionStatement || (s as ts.ExpressionStatement).expression.kind !== K.StringLiteral) break;
      const lit = (s as ts.ExpressionStatement).expression as ts.StringLiteral;
      if (!(i === 0 && allowDirective && DIRECTIVES.has(lit.text))) e1000(lit, `directive '${lit.text}' here`);
    }
    return i;
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
    if (d.moduleSpecifier.kind !== K.StringLiteral || !specifierOk((d.moduleSpecifier as ts.StringLiteral).text)) {
      at("E7001", d.moduleSpecifier, "module specifier must be './x.ts', '../x.ts' or 'npm:name'");
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
    const isAsync = !!n.modifiers?.some((m) => m.kind === K.AsyncKeyword);
    if (n.kind === K.FunctionDeclaration || n.kind === K.FunctionExpression) {
      if (n.kind === K.FunctionDeclaration) { mods(n, [K.ExportKeyword, K.AsyncKeyword]); if (n.name) declName(n.name); }
      else mods(n, [K.AsyncKeyword]);
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
    for (const p of list ?? []) {
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
    classDepth++;
    for (const m of c.members) {
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
    classDepth--;
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

  function typeAlias(d: ts.TypeAliasDeclaration): void {
    mods(d, [K.ExportKeyword]);
    declName(d.name);
    typeParams(d.typeParameters);
    type(d.type);
  }

  function varList(list: ts.VariableDeclarationList, where: "module" | "local" | "for-of"): void {
    if (list.flags & NodeFlags.Using) { e1000(list, "'using'"); return; }
    const isLet = !!(list.flags & NodeFlags.Let);
    if (!isLet && !(list.flags & NodeFlags.Const)) { at("E1001", list, "'var' is not allowed"); return; }
    if (isLet && where === "module") { at("E5002", list, "module-level 'let' is not allowed"); return; }
    if (isLet && where === "for-of") { e1000(list, "'for (let ... of ...)'"); return; }
    for (const d of list.declarations) {
      if (d.exclamationToken) e1000(d.exclamationToken, "definite assignment assertion");
      if (isId(d.name)) declName(d.name);
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
      case K.Block: for (const b of (s as ts.Block).statements) stmt(b); return;
      case K.VariableStatement: mods(s, []); varList((s as ts.VariableStatement).declarationList, "local"); return;
      case K.ExpressionStatement: expr((s as ts.ExpressionStatement).expression); return;
      case K.IfStatement: {
        const x = s as ts.IfStatement;
        expr(x.expression); stmt(x.thenStatement); if (x.elseStatement) stmt(x.elseStatement);
        return;
      }
      case K.WhileStatement: expr((s as ts.WhileStatement).expression); loopBody((s as ts.WhileStatement).statement); return;
      case K.DoStatement: loopBody((s as ts.DoStatement).statement); expr((s as ts.DoStatement).expression); return;
      case K.ForStatement: {
        const x = s as ts.ForStatement;
        if (x.initializer?.kind === K.VariableDeclarationList) varList(x.initializer as ts.VariableDeclarationList, "local");
        else if (x.initializer) expr(x.initializer as ts.Expression);
        if (x.condition) expr(x.condition);
        if (x.incrementor) expr(x.incrementor);
        loopBody(x.statement);
        return;
      }
      case K.ForOfStatement: {
        const x = s as ts.ForOfStatement;
        if (x.awaitModifier) e1000(x.awaitModifier, "'for await'");
        if (x.initializer.kind === K.VariableDeclarationList) varList(x.initializer as ts.VariableDeclarationList, "for-of");
        else e1000(x.initializer, "for-of without 'const'");
        expr(x.expression);
        loopBody(x.statement);
        return;
      }
      case K.SwitchStatement: {
        const x = s as ts.SwitchStatement;
        expr(x.expression);
        for (const c of x.caseBlock.clauses) {
          if (c.kind === K.CaseClause) expr((c as ts.CaseClause).expression);
          for (const b of c.statements) stmt(b);
        }
        return;
      }
      case K.BreakStatement: case K.ContinueStatement: {
        const l = (s as ts.BreakStatement).label;
        if (l) e1000(l, "label");
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
      case K.ThisKeyword: if (!classDepth) e1000(e, "'this' outside a class"); return;
      case K.TemplateExpression: for (const sp of (e as ts.TemplateExpression).templateSpans) expr(sp.expression); return;
      case K.ParenthesizedExpression: expr((e as ts.ParenthesizedExpression).expression); return;
      case K.AwaitExpression: expr((e as ts.AwaitExpression).expression); return;
      case K.ConditionalExpression: {
        const c = e as ts.ConditionalExpression;
        expr(c.condition); expr(c.whenTrue); expr(c.whenFalse);
        return;
      }
      case K.BinaryExpression: {
        const b = e as ts.BinaryExpression;
        const op = b.operatorToken;
        if (op.kind === K.EqualsEqualsToken || op.kind === K.ExclamationEqualsToken) at("E1002", op, "use '===' / '!=='");
        else if (!BINARY_OPS.has(op.kind)) e1000(op, "this operator");
        if (op.kind === K.EqualsToken && (b.left.kind === K.ArrayLiteralExpression || b.left.kind === K.ObjectLiteralExpression)) e1000(b.left, "destructuring assignment");
        else expr(b.left);
        expr(b.right);
        return;
      }
      case K.PrefixUnaryExpression: {
        const u = e as ts.PrefixUnaryExpression;
        if (!PREFIX_OPS.has(u.operator)) e1000(u, "this unary operator");
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
        const t = a.type;
        const isConst = t.kind === K.TypeReference && isId((t as ts.TypeReferenceNode).typeName) && ((t as ts.TypeReferenceNode).typeName as ts.Identifier).text === "const";
        if (!isConst) { const s = pf.tokenAfter(a.expression.end); report("E1005", s, s + 2, "'as' is not allowed"); }
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
        for (const m of ms) {
          if (m.kind !== K.PropertySignature) { e1000(m, "this record member"); continue; }
          const p = m as ts.PropertySignatureDeclaration;
          mods(p, [K.ReadonlyKeyword]);
          memberName(p);
          if (p.type) type(p.type);
        }
        return;
      }
      case K.FunctionType: {
        const f = t as ts.FunctionTypeNode;
        typeParams(f.typeParameters); params(f.parameters); if (f.type) type(f.type);
        return;
      }
      default: e1000(t, "this type"); // T[], tuples, intersections, keyof, typeof, conditional, mapped, indexed, object, symbol, ...
    }
  }
}
