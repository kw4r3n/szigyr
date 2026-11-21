// JS backend (SPEC §10, D030): one file -> the body of a module factory `(rt, imp) => exports`.
// Splices the source text: every node prints as its own text with its children replaced by their emission,
// type syntax deleted, and the §10 rewrites applied to the nodes that need them. Types come from P2 (exprTypes).
import { dirname } from "node:path";
import { NodeFlags, SyntaxKind as K, isId, type Node, type ParsedFile, type ts } from "./parse.ts";
import type { Range } from "./diagnostics.ts";
import { assignTarget, audioOpenCalls, callSigs, exprTypes, forAllMeta, isolateCalls, localOf, resourceCalls } from "./expr.ts";
import { sliceGroups, type SliceGroupEntry } from "./ownership.ts";
import { elemDesc } from "./layout.ts";
import { emitGenDesc, genDescOf } from "./gendesc.ts";
import { canonPath, declBindings } from "./modules.ts";
import { NUM_NAMES, bindTParams, field, isInt, isInt64, isStr, literalFits, movesLike, nonNull, parseExactInt, resultParts, same, subst, unref, type FnType, type NumName, type Type } from "./types.ts";
import { CLI_NAME, RUNTIME_GLOBAL } from "./names.ts";
import { DETMATH_PATH, dmBinding } from "./detmath.ts";
import type { Pos } from "../../runtime-js/src/index.ts";

export const RT = RUNTIME_GLOBAL;
export const IMP = `${RUNTIME_GLOBAL}_imp`;
/** The module's exports object, created by the host so that an import cycle can see it early (Q100). */
export const EXPORTS = `${RUNTIME_GLOBAL}_ex`;
export const MUT_FNS = `${RUNTIME_GLOBAL}_mutFns`;
/** `//# sourceURL` prefix of generated modules, so stack frames name the source file. */
export const SOURCE_URL = `${CLI_NAME}:`;
const MARK = `${RUNTIME_GLOBAL}@`;
const P = `${RUNTIME_GLOBAL}_P`, AP = `${RUNTIME_GLOBAL}_ap`, ENS = `${RUNTIME_GLOBAL}_ens`;
// Synthetic parameters: user code inside the right side / ensures predicates must not see them.
const O = `${RUNTIME_GLOBAL}_o`, KEY = `${RUNTIME_GLOBAL}_k`, V = `${RUNTIME_GLOBAL}_v`, R = `${RUNTIME_GLOBAL}_r`;
/** Builtin namespaces that are runtime values (the rest are JS globals). */
const RT_NAMESPACES = ["Vec", "Pool", "Arena", "Ring", "OwnedCell", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs", "FakeSpawn", "FakeAudio", "TestAlloc"];
const DROP_MODS = new Set<K>([K.ExportKeyword, K.ReadonlyKeyword, K.PrivateKeyword, K.PublicKeyword, K.ProtectedKeyword, K.DeclareKeyword, K.AbstractKeyword, K.OverrideKeyword]);
const COMPOUND: Partial<Record<K, string>> = {
  [K.PlusEqualsToken]: "+", [K.MinusEqualsToken]: "-", [K.AsteriskEqualsToken]: "*",
  [K.SlashEqualsToken]: "/", [K.PercentEqualsToken]: "%", [K.AsteriskAsteriskEqualsToken]: "**",
};
/** §12 members that can throw a JS exception (Q035): parse errors, out-of-range code points, string / array / Map / Set size limits. */
const THROWING: Record<string, readonly string[]> = {
  JSON: ["stringify"], String: ["fromCodePoint"],
  string: ["padStart", "padEnd", "replaceAll", "toUpperCase", "toLowerCase"],
  Array: ["push", "concat", "join"], ReadonlyArray: ["concat", "join"], Map: ["set"], Set: ["add"],
};
const INT_OP: Record<string, string> = { "+": "add", "-": "sub", "*": "mul" };
const ARITH_MUT: Record<string, string> = { "+": "-", "-": "+", "*": "+" };
const CMP_MUT: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">", "===": "!==", "!==": "===" };
const LOGIC_MUT: Record<string, string> = { "&&": "||", "||": "&&" };
const numValue = (n: ts.NumericLiteral): number => Number(n.text.replace(/_/g, ""));
const unwrapParens = (e: ts.Expression): ts.Expression => (e.kind === K.ParenthesizedExpression ? unwrapParens((e as ts.ParenthesizedExpression).expression) : e);
/** Whether `n` is a `switch` `case` expression, including parenthesized forms (`case (1):`). */
const isCaseExpr = (n: Node): boolean => {
  let cur = n;
  while (cur.parent?.kind === K.ParenthesizedExpression) cur = cur.parent;
  return cur.parent?.kind === K.CaseClause && (cur.parent as ts.CaseClause).expression === cur;
};
/** Whether `n` is the whole boolean literal condition of `while`/`do`/`for` (checker/ownership rely on it for return/move soundness). */
const isLoopCondLit = (n: Node): boolean => {
  let cur = n;
  while (cur.parent?.kind === K.ParenthesizedExpression) cur = cur.parent;
  const p = cur.parent;
  if (!p) return false;
  if (p.kind === K.WhileStatement) return (p as ts.WhileStatement).expression === cur;
  if (p.kind === K.DoStatement) return (p as ts.DoStatement).expression === cur;
  if (p.kind === K.ForStatement) return (p as ts.ForStatement).condition === cur;
  return false;
};

export interface MutantSpec {
  id: number;
  fnId: number;
  fn: string;
  op: string;
  range: Range;
  isDeleteStmt: boolean;
}

export interface EmitMutate {
  targets: Map<Node, { id: number; name: string }>;
  unsafeDecls: Set<Node>;
  mutants: MutantSpec[];
  exportFns: string[];
}

export interface Emitted {
  /** Factory body: `new Function(RT, IMP, js)` returns the exports object. */
  js: string;
  /** Relative imports (absolute paths) and npm specifiers (`npm:x`) that `IMP` is called with. */
  imports: string[];
  /** Generated `line:col` of each call's name (as V8 reports frames under SOURCE_URL) -> source position (Q035). */
  calls: Map<string, Pos>;
}

type AnyNode = Node & Record<string, unknown>;

/** `tests`: keep the module's top-level `test(...)` calls (§9.2, §10.10). `file`: path reported in trap positions. */
/** `native`: strict / rt function declarations compiled to C (D101), with their key in `rt.native`. */
/** `mut`: optional mutation testing instrumentation (`szigyr mutate`, SPEC §16.2). */
export function emitFile(
  pf: ParsedFile,
  file: string,
  tests: boolean,
  native?: Map<Node, string>,
  extraExports?: Set<string>,
  mut?: EmitMutate,
  keyOf: (absPath: string) => string = (p) => p,
): Emitted {
  const sf = pf.sourceFile, text = sf.text;
  const poss: string[] = [];
  const marks: Pos[] = [];
  /** A comment the generated code keeps in front of a call; its generated line:col maps a JS stack frame back to `n` (D032). */
  const mark = (n: Node): string => { const p = pf.position(n.getStart(sf)); marks.push({ file, line: p.line, col: p.col }); return `/*${MARK}${marks.length - 1}*/`; };
  const imports: string[] = [];
  const exported: string[] = [];
  const dmUsed = new Set<string>(); // §12 (Q191): DetMath members this file calls
  let needAp = false;

  // Mutation instrumentation state (active only when `mut` is passed).
  let curFnId = -1;
  let curFnName = "";
  let inContract = 0;
  let narrowedSyms = new Set<number>();
  let narrowedProps = new Set<string>();
  const canMutate = (): boolean => !!mut && curFnId >= 0 && inContract === 0;

  const pos = (offset: number): string => {
    const p = pf.position(offset);
    poss.push(`{file:${JSON.stringify(file)},line:${p.line},col:${p.col}}`);
    return `${P}[${poss.length - 1}]`;
  };
  const at = (n: Node): string => pos(n.getStart(sf));
  const rangeOf = (n: Node): Range => ({ start: pf.position(n.getStart(sf)), end: pf.position(n.end) });
  const typeOf = (n: Node): Type | undefined => { const t = exprTypes.get(n); return t && unref(t); };
  const numName = (n: Node): string | undefined => { const t = typeOf(n); return t?.k === "num" ? t.name : undefined; };
  const skipWs = (i: number): number => { while (/\s/.test(text[i] ?? "")) i++; return i; };
  const addMutant = (opName: string, n: Node, isDeleteStmt = false): number => {
    const id = mut!.mutants.length + 1;
    mut!.mutants.push({ id, fnId: curFnId, fn: curFnName, op: opName, range: rangeOf(n), isDeleteStmt });
    return id;
  };
  const emitPreFn = (fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): string | undefined => {
    if (!fn.body || fn.body.kind !== K.Block) return undefined;
    const ss = (fn.body as ts.Block).statements;
    let i = 0;
    while (i < ss.length && ss[i]!.kind === K.ExpressionStatement && (ss[i] as ts.ExpressionStatement).expression.kind === K.StringLiteral) {
      if (((ss[i] as ts.ExpressionStatement).expression as ts.StringLiteral).text === "use unsafe") return undefined;
      i++;
    }
    const checks: string[] = [];
    inContract++;
    try {
      for (; i < ss.length; i++) {
        const s = ss[i]!;
        if (s.kind !== K.ExpressionStatement) break;
        const ex = (s as ts.ExpressionStatement).expression;
        if (ex.kind !== K.CallExpression || (ex as ts.CallExpression).expression.kind !== K.Identifier || ((ex as ts.CallExpression).expression as ts.Identifier).text !== "requires") break;
        checks.push(`if (!(${gen((ex as ts.CallExpression).arguments[0]!)})) return false;`);
      }
    } finally { inContract--; }
    if (!checks.length) return undefined;
    const ps = fn.parameters.map((p) => (p.name as ts.Identifier).text).join(", ");
    return `(${ps}) => { ${checks.join(" ")} return true; }`;
  };

  /** Collect locals / properties narrowed anywhere in `root`, so narrowing guards are never mutated unsafely. */
  function scanNarrowing(root: Node): { syms: Set<number>; props: Set<string> } {
    const syms = new Set<number>(), props = new Set<string>();
    const visit = (n: Node): void => {
      if (n.kind === K.Identifier) {
        const s = localOf.get(n), t = exprTypes.get(n);
        if (s && t && !same(unref(t), unref(s.type))) syms.add(s.id);
      } else if (n.kind === K.PropertyAccessExpression) {
        const p = n as ts.PropertyAccessExpression;
        const ot = exprTypes.get(p.expression), pt = exprTypes.get(p);
        if (ot && pt) {
          const uo = unref(ot);
          const f = uo.k === "record" ? field(uo, p.name.text) : undefined;
          const ft = f ? f.type : uo.k === "class" ? (() => {
            const cf = uo.cls.fields.get(p.name.text);
            return cf ? subst(cf.type, bindTParams(uo.cls.tparams, uo.args)) : undefined;
          })() : undefined;
          if (ft && !same(unref(pt), unref(ft))) props.add(p.name.text);
        }
      }
      n.forEachChild(visit);
    };
    visit(root);
    return { syms, props };
  }
  function isNarrowedTarget(e: ts.Expression): boolean {
    const u = unwrapParens(e);
    if (isId(u)) { const s = localOf.get(u); return !!s && narrowedSyms.has(s.id); }
    if (u.kind === K.PropertyAccessExpression) {
      const p = u as ts.PropertyAccessExpression;
      return narrowedProps.has(p.name.text) || isNarrowedTarget(p.expression);
    }
    return false;
  }
  function hasActiveNarrowing(e: ts.Expression): boolean {
    const u = unwrapParens(e);
    if (u.kind === K.PrefixUnaryExpression && (u as ts.PrefixUnaryExpression).operator === K.ExclamationToken) return hasActiveNarrowing((u as ts.PrefixUnaryExpression).operand);
    if (u.kind !== K.BinaryExpression) return false;
    const b = u as ts.BinaryExpression, k = b.operatorToken.kind;
    if (k === K.AmpersandAmpersandToken || k === K.BarBarToken) return hasActiveNarrowing(b.left) || hasActiveNarrowing(b.right);
    if (k !== K.EqualsEqualsEqualsToken && k !== K.ExclamationEqualsEqualsToken) return false;
    for (const [x, y] of [[b.left, b.right], [b.right, b.left]] as const) {
      const ux = unwrapParens(x), uy = unwrapParens(y);
      if (uy.kind === K.NullKeyword && isNarrowedTarget(ux)) return true;
      if (uy.kind === K.StringLiteral) {
        if (ux.kind === K.PropertyAccessExpression && (ux as ts.PropertyAccessExpression).name.text === "kind" && isNarrowedTarget((ux as ts.PropertyAccessExpression).expression)) return true;
        if (isNarrowedTarget(ux)) return true;
      }
    }
    return false;
  }
  function inConditionContext(n: Node): boolean {
    let cur: Node | undefined = n;
    while (cur?.parent) {
      const p: Node = cur.parent;
      if (p.kind === K.ParenthesizedExpression || p.kind === K.PrefixUnaryExpression) { cur = p; continue; }
      if (p.kind === K.BinaryExpression) {
        const bk = (p as ts.BinaryExpression).operatorToken.kind;
        return bk === K.AmpersandAmpersandToken || bk === K.BarBarToken;
      }
      if (p.kind === K.IfStatement && (p as ts.IfStatement).expression === cur) return true;
      if (p.kind === K.WhileStatement && (p as ts.WhileStatement).expression === cur) return true;
      if (p.kind === K.DoStatement && (p as ts.DoStatement).expression === cur) return true;
      if (p.kind === K.ForStatement && (p as ts.ForStatement).condition === cur) return true;
      if (p.kind === K.ConditionalExpression && (p as ts.ConditionalExpression).condition === cur) return true;
      return false;
    }
    return false;
  }

  /** The `>` closing a type argument / parameter list, from `i` on, past whitespace, comments and a trailing comma. */
  const closeAngle = (i: number, end: number): number => {
    while (i < end) {
      if (text.startsWith("/*", i)) i = text.indexOf("*/", i + 2) + 2;
      else if (text.startsWith("//", i)) { const nl = text.indexOf("\n", i); if (nl < 0) return -1; i = nl; }
      else if (text[i] === ">") return i;
      else i++;
    }
    return -1;
  };

  /** Default: the node's text with each child replaced by its emission and type syntax deleted. */
  function splice(n: Node): string {
    const a = n as AnyNode;
    const cuts: { s: number; e: number; out: string }[] = [];
    const lists = [a.typeArguments, a.typeParameters] as (ts.NodeArray<Node> | undefined)[];
    n.forEachChild((c) => {
      const list = lists.find((l) => l?.includes(c));
      if (list) {
        if (c !== list[0]) return;
        const e = closeAngle(list.end, n.end); // the list starts just after its `<` (a node's pos is the previous token's end)
        cuts.push({ s: list.pos - 1, e: e < 0 ? list.end : e + 1, out: "" });
      } else if (a.type === c) {
        cuts.push({ s: c.pos - 1, e: c.end, out: "" }); // `: T`: the type starts just after its `:`
      } else if (DROP_MODS.has(c.kind) || c.kind === K.HeritageClause) {
        cuts.push({ s: c.getStart(sf), e: skipWs(c.end), out: "" });
      } else cuts.push({ s: c.getStart(sf), e: c.end, out: gen(c) });
    });
    let out = "", cur = n.getStart(sf);
    for (const c of cuts) { out += text.slice(cur, c.s) + c.out; cur = c.e; }
    return out + text.slice(cur, n.end);
  }

  function loopBody(stmt: ts.Statement): string {
    if (stmt.kind === K.Block) {
      const b = stmt as ts.Block;
      return `{\n${RT}.step();\n${emitStmtsWithUsing(b.statements, (s) => gen(s))}\n}`;
    }
    return `{ ${RT}.step(); ${gen(stmt)} }`;
  }

  function withMutTarget(targetNode: Node, bodyNode: ts.Block | undefined, emitFn: () => string): string {
    const mt = mut?.targets.get(targetNode);
    if (!mt) return emitFn();
    const prevFnId = curFnId, prevFnName = curFnName, prevSyms = narrowedSyms, prevProps = narrowedProps;
    curFnId = mt.id;
    curFnName = mt.name;
    const nw = bodyNode ? scanNarrowing(bodyNode) : { syms: new Set<number>(), props: new Set<string>() };
    narrowedSyms = nw.syms;
    narrowedProps = nw.props;
    try { return emitFn(); } finally {
      curFnId = prevFnId; curFnName = prevFnName; narrowedSyms = prevSyms; narrowedProps = prevProps;
    }
  }

  function gen(n: Node): string {
    switch (n.kind) {
      case K.TypeAliasDeclaration: case K.InterfaceDeclaration: case K.ModuleDeclaration: return ""; // ModuleDeclaration: `declare module "c:..."` (§14.1) declares C functions and has no runtime form
      case K.NumericLiteral: {
        const nt = numName(n) as NumName | undefined;
        const orig = nt === "f32" ? `${RT}.f32(${splice(n)})` : nt && isInt64(nt) ? `${parseExactInt(n.getText(sf), false)!}n` : splice(n); // Q015
        const t = canMutate() && !isCaseExpr(n) ? typeOf(n) : undefined;
        if (t?.k === "num") {
          if (isInt64(t.name)) {
            const v = parseExactInt(n.getText(sf), false)!;
            const mutVal = v === 0n ? "1n" : "0n";
            const id = addMutant(v === 0n ? "0 -> 1" : "num -> 0", n);
            return `(${RT}.m === ${id} ? ${mutVal} : ${orig})`;
          }
          const v = numValue(n as ts.NumericLiteral);
          const mutVal = v === 0 ? 1 : 0;
          if (literalFits(mutVal, t.name)) {
            const id = addMutant(v === 0 ? "0 -> 1" : "num -> 0", n);
            return `(${RT}.m === ${id} ? ${mutVal} : ${orig})`;
          }
        }
        return orig;
      }
      case K.TrueKeyword: case K.FalseKeyword: {
        if (canMutate() && !isCaseExpr(n) && !isLoopCondLit(n) && typeOf(n)?.k === "prim") {
          const val = n.kind === K.TrueKeyword;
          const id = addMutant(val ? "true -> false" : "false -> true", n);
          return `(${RT}.m === ${id} ? ${!val} : ${val})`;
        }
        return splice(n);
      }
      case K.AwaitExpression: // §15.4 (2), D145: a recorded foreign trap (a C thread's or an isolate's) surfaces before the next task, on both backends
        return `${RT}.task(await ${gen((n as ts.AwaitExpression).expression)})`;
      case K.PrefixUnaryExpression: return prefix(n as ts.PrefixUnaryExpression);
      case K.BinaryExpression: return binary(n as ts.BinaryExpression);
      case K.ElementAccessExpression: {
        const e = n as ts.ElementAccessExpression;
        return `${RT}.at(${gen(e.expression)}, ${gen(e.argumentExpression)}, ${at(e.argumentExpression)})`; // `?.[]` is not in the language (E1000)
      }
      case K.PropertyAccessExpression: {
        const p = n as ts.PropertyAccessExpression;
        const callee = n.parent?.kind === K.CallExpression && (n.parent as ts.CallExpression).expression === n;
        return p.questionDotToken && !callee ? `${RT}.nn(${splice(n)})` : splice(n); // §10.7
      }
      case K.CallExpression: return call(n as ts.CallExpression);
      case K.NewExpression: {
        const ne = n as ts.NewExpression, groups = sliceGroups.get(n);
        if (!groups || !ne.arguments) return mark(n) + splice(n);
        // Q190 (b): as in `call`, the arguments are evaluated first, then the overlap check (T013), then the construction.
        const refs = ne.arguments.map((_, i) => `${V}[${i}]`);
        const body = `(...${V}) => { ${checkStmts(groups, refs)} return new ${gen(ne.expression)}(${refs.join(", ")}); }`;
        needAp = true;
        return ne.arguments.some(hasAwait) ? `${mark(n)}(await ${AP}(async ${body}, ${ne.arguments.map(gen).join(", ")}))` : `${mark(n)}${AP}(${body}, ${ne.arguments.map(gen).join(", ")})`;
      }
      case K.Identifier: { // the name of a called function or method: where stack exhaustion is reported (Q035)
        const pa = n.parent, called = (c: Node | undefined, x: Node): boolean => c?.kind === K.CallExpression && (c as ts.CallExpression).expression === x;
        return called(pa, n) || (pa?.kind === K.PropertyAccessExpression && (pa as ts.PropertyAccessExpression).name === n && called(pa.parent, pa)) ? mark(n) + splice(n) : splice(n);
      }
      case K.IfStatement: return mut ? ifStmt(n as ts.IfStatement) : splice(n);
      case K.WhileStatement: {
        if (!mut) break;
        const w = n as ts.WhileStatement;
        return `while (${gen(w.expression)}) ${loopBody(w.statement)}`;
      }
      case K.DoStatement: {
        if (!mut) break;
        const d = n as ts.DoStatement;
        return `do ${loopBody(d.statement)} while (${gen(d.expression)});`;
      }
      case K.ForStatement: {
        if (!mut) break;
        const f = n as ts.ForStatement;
        return `for (${f.initializer ? gen(f.initializer) : ""}; ${f.condition ? gen(f.condition) : ""}; ${f.incrementor ? gen(f.incrementor) : ""}) ${loopBody(f.statement)}`;
      }
      case K.ForOfStatement: {
        if (!mut) break;
        const f = n as ts.ForOfStatement;
        return `for (${gen(f.initializer)} of ${gen(f.expression)}) ${loopBody(f.statement)}`;
      }
      case K.ExpressionStatement: return mut ? exprStmt(n as ts.ExpressionStatement) : splice(n);
      case K.ArrowFunction: {
        if (!mut) break;
        const af = n as ts.ArrowFunction;
        if (af.body.kind !== K.Block && inContract === 0) {
          const isAsync = !!af.modifiers?.some((x) => x.kind === K.AsyncKeyword);
          const ps = af.parameters.map((p) => p.name.getText(sf)).join(", ");
          return `${isAsync ? "async " : ""}(${ps}) => (${RT}.step(), (${gen(af.body)}))`;
        }
        break;
      }
      case K.CaseClause: case K.DefaultClause: {
        const cc = n as ts.CaseClause | ts.DefaultClause;
        const head = n.kind === K.CaseClause ? `case ${gen((cc as ts.CaseClause).expression)}:` : "default:";
        if (!cc.statements.length) return head;
        const body = cc.statements.some(isUsingStmt) ? emitStmtsWithUsing(cc.statements, (s) => gen(s)) : cc.statements.map((s) => gen(s)).join("\n");
        return `${head} {\n${body}\n}`;
      }
      case K.Block: return block(n as ts.Block);
      case K.FunctionDeclaration: {
        const f = n as ts.FunctionDeclaration;
        if (mut?.unsafeDecls.has(n)) return `function ${f.name!.text}() { ${RT}.cOnly(); }`; // Q275: C-only stub
        const key = native?.get(n);
        const isTop = n.parent?.kind === K.SourceFile && !f.typeParameters?.length && !f.modifiers?.some((m) => m.kind === K.AsyncKeyword) && !!f.name && !!f.body;
        const pre = isTop ? emitPreFn(f) : undefined;
        const tail = pre ? `\n${RT}.setPre(${f.name!.text}, ${pre});` : "";
        if (key === "!generic") return `function ${f.name!.text}() { throw new Error("internal: a generic strict / rt function runs only through its C instances (D104)"); }`;
        if (key) {
          const ps = f.parameters.map((p) => p.name.getText(sf));
          return `function ${f.name!.text}(${ps.join(", ")}) { return ${RT}.native.${key}(${ps.join(", ")}); }${tail}`;
        }
        return withMutTarget(n, f.body, () => splice(n) + tail);
      }
      case K.MethodDeclaration: {
        const md = n as ts.MethodDeclaration;
        return withMutTarget(n, md.body, () => splice(n));
      }
    }
    return splice(n);
  }

  function ifStmt(s: ts.IfStatement): string {
    const u = unwrapParens(s.expression);
    const alreadyBoolLit = u.kind === K.TrueKeyword || u.kind === K.FalseKeyword;
    let condJs = gen(s.expression);
    if (canMutate() && !alreadyBoolLit && !hasActiveNarrowing(s.expression)) {
      const idT = addMutant("if -> true", s.expression);
      const idF = addMutant("if -> false", s.expression);
      condJs = `${RT}.m === ${idT} ? true : ${RT}.m === ${idF} ? false : (${condJs})`;
    }
    return `if (${condJs}) ${gen(s.thenStatement)}${s.elseStatement ? ` else ${gen(s.elseStatement)}` : ""}`;
  }

  function exprStmt(s: ts.ExpressionStatement): string {
    const u = unwrapParens(s.expression);
    if (u.kind === K.CallExpression && isId((u as ts.CallExpression).expression)) {
      const cname = ((u as ts.CallExpression).expression as ts.Identifier).text;
      if (cname === "requires" || cname === "ensures" || cname === "invariant") return splice(s);
    }
    const orig = splice(s);
    if (!canMutate()) return orig;
    const deletable = u.kind === K.CallExpression || (u.kind === K.BinaryExpression &&
      ((u as ts.BinaryExpression).operatorToken.kind === K.EqualsToken || COMPOUND[(u as ts.BinaryExpression).operatorToken.kind] !== undefined));
    if (!deletable) return orig;
    const et = typeOf(u);
    if (et?.k === "prim" && et.name === "never") return orig;
    if (u.kind === K.BinaryExpression && (u as ts.BinaryExpression).operatorToken.kind === K.EqualsToken) {
      const lhs = assignTarget((u as ts.BinaryExpression).left);
      if (isId(lhs)) {
        const sym = localOf.get(lhs);
        if (sym && (movesLike(sym.type) || (nonNull(sym.type) !== undefined && narrowedSyms.has(sym.id)))) return orig;
      } else if (lhs.kind === K.PropertyAccessExpression && narrowedProps.has((lhs as ts.PropertyAccessExpression).name.text)) {
        return orig;
      }
    }
    const id = addMutant("delete-stmt", s, true);
    return `{ if (${RT}.m !== ${id}) { ${orig} } }`;
  }

  /** `body(o)` with `o` bound to the receiver of a `?.`: null short-circuits before the arguments are evaluated (§10.7). */
  function optional(recv: string, awaited: boolean, body: (o: string) => string): string {
    needAp = true;
    const f = `(${O}) => ${O} == null ? null : ${body(O)}`;
    return awaited ? `(await ${AP}(async ${f}, ${recv}))` : `${AP}(${f}, ${recv})`;
  }

  function prefix(u: ts.PrefixUnaryExpression): string {
    const t = numName(u) as NumName | undefined;
    if (u.operator === K.MinusToken && u.operand.kind === K.NumericLiteral) { // negative literal (Q015); `-0` of an integer type is +0 (Q090)
      const rawText = u.getText(sf);
      if (t && isInt64(t)) {
        const v = parseExactInt(u.operand.getText(sf), true)!;
        const orig = `${v}n`;
        if (canMutate() && !isCaseExpr(u)) {
          const mutVal = v === 0n ? "1n" : "0n";
          const id = addMutant(v === 0n ? "0 -> 1" : "num -> 0", u);
          return `(${RT}.m === ${id} ? ${mutVal} : ${orig})`;
        }
        return orig;
      }
      const orig = t === "f32" ? `${RT}.f32(${rawText})` : t && isInt(typeOf(u)!) ? `(${rawText} + 0)` : rawText;
      if (canMutate() && !isCaseExpr(u) && t) {
        const v = -numValue(u.operand as ts.NumericLiteral);
        const mutVal = v === 0 ? 1 : 0;
        if (literalFits(mutVal, t as NumName)) {
          const id = addMutant(v === 0 ? "0 -> 1" : "num -> 0", u);
          return `(${RT}.m === ${id} ? ${mutVal} : ${orig})`;
        }
      }
      return orig;
    }
    if (u.operator === K.MinusToken && t && isInt(typeOf(u)!)) return `${RT}.neg(${JSON.stringify(t)}, ${gen(u.operand)}, ${at(u)})`;
    if (u.operator === K.TildeToken && t === "u32") return `${RT}.toU32(${splice(u)})`;
    if (u.operator === K.TildeToken && t === "u64") return `${RT}.toU64(${splice(u)})`;
    return splice(u);
  }

  /** `l op r` for a numeric type: range check (int + - *), rounding (f32), u32 normalization, shifts. */
  function op(t: string | undefined, o: string, l: string, r: string, anchor: string): string {
    if (t && INT_OP[o] && t !== "f32" && t !== "f64") return `${RT}.${INT_OP[o]}(${JSON.stringify(t)}, ${l}, ${r}, ${anchor})`;
    if (t === "f32" && ["+", "-", "*", "/", "%", "**"].includes(o)) return `${RT}.f32((${l}) ${o} (${r}))`;
    if (o === "<<") return `${RT}.shl(${JSON.stringify(t)}, ${l}, ${r}, ${anchor})`;
    if (o === ">>") return `${RT}.shr(${l}, ${r}, ${anchor})`;
    if (o === ">>>") return `${RT}.ushr(${l}, ${r}, ${anchor})`;
    if (t === "u32" && ["&", "|", "^"].includes(o)) return `${RT}.toU32((${l}) ${o} (${r}))`;
    return `((${l}) ${o} (${r}))`;
  }

  function binary(b: ts.BinaryExpression): string {
    const k = b.operatorToken.kind;
    const o = b.operatorToken.getText(sf);
    const anchor = (): string => at(b.operatorToken);
    const left = k === K.EqualsToken || COMPOUND[k] !== undefined ? assignTarget(b.left) : b.left; // Q133: the target without its parentheses
    if (k === K.EqualsToken && left.kind === K.ElementAccessExpression) {
      const e = left as ts.ElementAccessExpression;
      return `${RT}.setAt(${gen(e.expression)}, ${gen(e.argumentExpression)}, ${gen(b.right)}, ${at(e.argumentExpression)})`;
    }
    const base = COMPOUND[k];
    if (base !== undefined) {
      const t = numName(b);
      const plain = !(t && (t === "f32" || (isInt(typeOf(b)!) && INT_OP[base])));
      // Check `plain` before `gen(b.right)` so we never walk `b.right` twice (#1).
      if (plain && left.kind !== K.ElementAccessExpression) return splice(b);
      const rhs = gen(b.right);
      // Element / property targets evaluate the receiver (and index) once by passing them to an arrow; the right side runs inside it,
      // after the read, as in JS. With `await` on the right the arrow is async and awaited (§10.1 order unchanged).
      const aw = hasAwait(b.right), fa = aw ? "async " : "", apCall = aw ? `(await ${AP}` : AP, close = aw ? ")" : "";
      if (left.kind === K.ElementAccessExpression) {
        needAp = true;
        const e = left as ts.ElementAccessExpression, ip = at(e.argumentExpression);
        return `${apCall}(${fa}(${O}, ${KEY}) => { const ${V} = ${op(t, base, `${RT}.at(${O}, ${KEY}, ${ip})`, rhs, anchor())}; ${RT}.setAt(${O}, ${KEY}, ${V}, ${ip}); return ${V}; }, ${gen(e.expression)}, ${gen(e.argumentExpression)})${close}`;
      }
      if (left.kind === K.PropertyAccessExpression) {
        needAp = true;
        const p = left as ts.PropertyAccessExpression, f = p.name.text;
        return `${apCall}(${fa}(${O}) => ${O}.${f} = ${op(t, base, `${O}.${f}`, rhs, anchor())}, ${gen(p.expression)})${close}`;
      }
      const l = gen(left);
      return `${l} = ${op(t, base, l, rhs, anchor())}`;
    }
    const t = numName(b);
    if (t && ARITH_MUT[o] && canMutate()) {
      const mutO = ARITH_MUT[o]!;
      const id = addMutant(`${o} -> ${mutO}`, b.operatorToken);
      return `${RT}.mArith(${id}, ${JSON.stringify(t)}, ${JSON.stringify(o)}, ${JSON.stringify(mutO)}, ${gen(left)}, ${gen(b.right)}, ${anchor()})`;
    }
    if (t && ["+", "-", "*", "/", "%", "**", "<<", ">>", ">>>", "&", "|", "^"].includes(o)) return op(t, o, gen(left), gen(b.right), anchor());
    if ((o === "===" || o === "!==") && unwrapParens(left).kind !== K.NullKeyword && unwrapParens(b.right).kind !== K.NullKeyword) {
      const isHdl = (n: Node): boolean => {
        const pt = typeOf(n);
        if (!pt) return false;
        const u = nonNull(unref(pt)) ?? unref(pt);
        return u.k === "gen" && u.name === "Handle";
      };
      if (isHdl(left) || isHdl(b.right)) {
        if (canMutate() && !(hasActiveNarrowing(b) && inConditionContext(b))) {
          const mutO = CMP_MUT[o]!;
          const id = addMutant(`${o} -> ${mutO}`, b.operatorToken);
          return `${RT}.mCmpHandle(${id}, ${JSON.stringify(o)}, ${gen(left)}, ${gen(b.right)})`;
        }
        const call = `${RT}.handleEq(${gen(left)}, ${gen(b.right)})`;
        return o === "===" ? call : `!${call}`;
      }
    }
    if (CMP_MUT[o] && canMutate()) {
      const skipNarrow = (o === "===" || o === "!==") && hasActiveNarrowing(b) && inConditionContext(b);
      if (!skipNarrow) {
        const mutO = CMP_MUT[o]!;
        const id = addMutant(`${o} -> ${mutO}`, b.operatorToken);
        return `${RT}.mCmp(${id}, ${JSON.stringify(o)}, ${JSON.stringify(mutO)}, ${gen(left)}, ${gen(b.right)})`;
      }
    }
    if (LOGIC_MUT[o] && canMutate() && !hasActiveNarrowing(b)) {
      const mutO = LOGIC_MUT[o]!;
      const id = addMutant(`${o} -> ${mutO}`, b.operatorToken);
      const lJs = gen(left), rJs = gen(b.right);
      if (hasAwait(left) || hasAwait(b.right)) {
        return `(await ${RT}.mLogicAsync(${id}, ${JSON.stringify(o)}, async () => (${lJs}), async () => (${rJs})))`;
      }
      return `${RT}.mLogic(${id}, ${JSON.stringify(o)}, () => (${lJs}), () => (${rJs}))`;
    }
    return splice(b);
  }

  /** Q190 (b): one `checkSlices` statement per runtime-checked group; `refs` are the evaluated argument values, in order. */
  function checkStmts(groups: SliceGroupEntry[][], refs: string[]): string {
    return groups.map((g) => `${RT}.checkSlices([${g.map((x) => `[${refs[x.arg]}, ${x.mut}, ${at(x.name)}]`).join(", ")}]);`).join(" ");
  }

  /** Q190 (b): evaluate the arguments left to right, run the overlap checks (T013), then call with the evaluated values. */
  function grouped(e: ts.CallExpression, groups: SliceGroupEntry[][], args: string[], bound: (refs: string[]) => string): string {
    needAp = true;
    const refs = e.arguments.map((_, i) => `${V}[${i}]`);
    const body = `(...${V}) => { ${checkStmts(groups, refs)} return ${bound(refs)}; }`;
    return e.arguments.some(hasAwait) ? `(await ${AP}(async ${body}, ${args.join(", ")}))` : `${AP}(${body}, ${args.join(", ")})`;
  }

  /** Q190 (b) for a method call: the receiver is evaluated before the arguments, as usual. */
  function groupedProp(e: ts.CallExpression, groups: SliceGroupEntry[][], args: string[], awaited: boolean): string {
    const p = e.expression as ts.PropertyAccessExpression;
    if (p.questionDotToken) return optional(gen(p.expression), awaited, (o) => grouped(e, groups, args, (refs) => `${RT}.nn(${o}.${p.name.text}(${refs.join(", ")}))`)); // §10.7: short-circuit before evaluating args once
    needAp = true;
    const refs = e.arguments.map((_, i) => `${V}[${i}]`);
    const body = `(${O}, ...${V}) => { ${checkStmts(groups, refs)} return ${O}.${p.name.text}(${refs.join(", ")}); }`;
    return awaited ? `(await ${AP}(async ${body}, ${gen(p.expression)}, ${args.join(", ")}))` : `${AP}(${body}, ${gen(p.expression)}, ${args.join(", ")})`;
  }

  function call(e: ts.CallExpression): string {
    const callee = e.expression;
    const iso = isolateCalls.get(e); // §15.2: receiver dispatch (nodeSpawn/browserSpawn or FakeSpawn)
    if (iso) {
      const p = callee as ts.PropertyAccessExpression;
      const args = `${JSON.stringify(keyOf(iso.path))}, ${JSON.stringify(iso.name)}, ${gen(e.arguments[0]!)}`;
      if (p.questionDotToken) return optional(gen(p.expression), false, (o) => `${o}.isolate(${args})`);
      return `${gen(p.expression)}.isolate(${args})`;
    }
    const ao = audioOpenCalls.get(e); // §15.5: pass callback JS fn reference + native callback id
    if (ao) {
      const p = callee as ts.PropertyAccessExpression;
      const spec = `{ fn: ${gen(e.arguments[2]!)}, id: ${ao.id}, native: ${RT}.native }`;
      if (p.questionDotToken) return optional(gen(p.expression), false, (o) => `${o}.open(${gen(e.arguments[0]!)}, ${gen(e.arguments[1]!)}, ${spec})`);
      return `${gen(p.expression)}.open(${gen(e.arguments[0]!)}, ${gen(e.arguments[1]!)}, ${spec})`;
    }
    if (mut && callee.kind === K.Identifier) {
      const name = (callee as ts.Identifier).text;
      if (name === "requires" || name === "invariant") {
        inContract++;
        try { return `${RT}.${name}(${gen(e.arguments[0]!)}, ${at(callee)})`; } finally { inContract--; }
      }
      if (name === "ensures") throw new Error("emit: ensures outside a function body prologue");
    }
    const args = e.arguments.map(gen);
    const groups = sliceGroups.get(e); // Q190 (b)
    const inst = native?.get(e); // D104: a managed call of a generic strict / rt function goes to its C instance
    if (inst) {
      // Q189 (b): function-typed arguments exist only at compile time; the C instance does not take them
      const sig = callSigs.get(e);
      const keep = sig ? sig.params.flatMap((pt, i) => (unref(pt).k === "fn" ? [] : [i])) : args.map((_, i) => i);
      return groups ? grouped(e, groups, args, (refs) => `${mark(callee)}${RT}.native.${inst}(${keep.map((i) => refs[i]).join(", ")})`) : `${mark(callee)}${RT}.native.${inst}(${keep.map((i) => args[i]).join(", ")})`;
    }
    const self = typeOf(e);
    const q = (s: string): string => JSON.stringify(s);
    if (callee.kind === K.Identifier) {
      const name = (callee as ts.Identifier).text;
      const t = self?.k === "num" ? self.name : "";
      if ((NUM_NAMES as readonly string[]).includes(name)) return `${RT}.convert(${q(name)}, ${args[0]}, ${at(callee)})`;
      switch (name) {
        case "wrapAdd": case "wrapSub": case "wrapMul": return `${RT}.${name}(${q(t)}, ${args.join(", ")})`;
        case "divTrunc": case "rem": return `${RT}.${name}(${q(t)}, ${args.join(", ")}, ${at(callee)})`;
        case "ok": case "err": return `${RT}.${name}(${args[0]})`;
        case "panic": case "requires": case "invariant": return `${RT}.${name}(${args[0]}, ${at(callee)})`;
        case "cast": return `${RT}.cast(${args[0]}, ${desc(resultParts(self!)!.ok)})`;
        case "test": return `${RT}.test(${args.join(", ")})`;
        case "forAll": {
          const meta = forAllMeta.get(e)!;
          const descs = `[${meta.params.map((p) => emitGenDesc(genDescOf(p))).join(", ")}]`;
          const pre = meta.checkBool ? emitPreFn(unwrapParens(e.arguments[0]!) as ts.ArrowFunction | ts.FunctionExpression) : undefined;
          return `${RT}.forAll(${args[0]}, ${descs}, ${meta.checkBool}, ${at(callee)}${pre ? `, ${pre}` : ""})`;
        }
        case "ensures": throw new Error("emit: ensures outside a function body prologue");
      }
      // Reuse `args` instead of calling `splice(e)` so arguments are never visited twice (#1).
      return groups ? grouped(e, groups, args, (refs) => `${gen(callee)}(${refs.join(", ")})`) : `${gen(callee)}(${args.join(", ")})`;
    }
    if (callee.kind !== K.PropertyAccessExpression) return `${gen(callee)}(${args.join(", ")})`;
    const p = callee as ts.PropertyAccessExpression, m = p.name.text;
    const recv = p.expression;
    const withArgs = (extra: string[]): string => `${gen(callee)}(${[...args, ...extra].join(", ")})`;
    const nn = (s: string): string => (p.questionDotToken ? `${RT}.nn(${s})` : s);
    const awaited = e.arguments.some(hasAwait);
    if (recv.kind === K.Identifier && ((recv as ts.Identifier).text === "Vec" || (recv as ts.Identifier).text === "Pool") && m === "create" && !typeOf(recv)) {
      const el = self?.k === "gen" ? self.args[0] : undefined;
      return withArgs([q(elemDesc(el))]);
    }
    if (recv.kind === K.Identifier && (recv as ts.Identifier).text === "Arena" && m === "create" && !typeOf(recv)) return withArgs([]); // no element type (Q188 (b))
    if (recv.kind === K.Identifier && (recv as ts.Identifier).text === "Ring" && m === "create" && !typeOf(recv)) {
      const txf = self?.k === "record" ? self.fields.find((f) => f.name === "tx")?.type : undefined;
      const el = txf?.k === "gen" ? txf.args[0] : undefined;
      return withArgs([q(elemDesc(el)), at(p.name)]); // T014 at the member name (15.1)
    }
    if (recv.kind === K.Identifier && (recv as ts.Identifier).text === "Resource" && !typeOf(recv)) {
      if (m === "own") return `({ v: ${args[0]}, f: ${args[1]}, a: true })`;
      if (m === "ownWith") return `({ v: ${args[0]}, c: ${args[1]}, f: ${args[2]}, a: true })`;
    }
    const r0 = typeOf(recv);
    const r = r0 && (nonNull(r0) ?? r0);
    if (r?.k === "resource") {
      if (m === "borrow" || m === "get") return `${gen(recv)}.v`;
      if (m === "take") return `(${O} => (${O}.a = false, ${O}.v))(${gen(recv)})`;
    }
    const ns = recv.kind === K.Identifier && !r0 ? (recv as ts.Identifier).text : undefined;
    if (ns === "Math" && m === "sqrt" && self?.k === "num" && self.name === "f32") return `${RT}.f32(Math.sqrt(${args[0]}))`;
    if (ns === "DetMath") { dmUsed.add(m); return `${dmBinding(m)}(${args.join(", ")})`; } // §12 (Q191): the bundled module, imported below under a hidden name
    if (ns === "JSON" && m === "parse") return `${RT}.jsonParse(${args[0]}, ${at(p.name)})`; // Q035: a syntax error is an `err`, other exceptions are T006
    // Q035: builtins that can throw a JS exception panic (T006) at their name.
    const throws = ns ? THROWING[ns] : r?.k === "gen" ? THROWING[r.name] : r && isStr(r) ? THROWING.string : undefined;
    if (throws?.includes(m)) {
      const guarded = (o: string): string => `${RT}.guarded(${o}, ${q(m)}, [${args.join(", ")}], ${at(p.name)})`;
      return p.questionDotToken ? optional(gen(recv), awaited, guarded) : guarded(ns ?? gen(recv));
    }
    if (r?.k === "gen") {
      if ((r.name === "Array" || r.name === "ReadonlyArray") && (m === "pop" || m === "find")) return nn(`${RT}.nn(${withArgs([])})`);
      if ((r.name === "Array" || r.name === "ReadonlyArray") && (m === "indexOf" || m === "findIndex")) return nn(`${RT}.idxOrNull(${withArgs([])})`);
      if (r.name === "Map" && m === "get") return nn(`${RT}.nn(${withArgs([])})`);
      if ((r.name === "Vec" || r.name === "Slice") && m === "slice") return nn(withArgs([at(p.name)]));
      if (r.name === "OwnedCell" && (m === "take" || m === "put")) return nn(withArgs([at(p.name)]));
      if (r.name === "Pool" && (m === "get" || m === "set" || m === "remove")) return nn(withArgs([at(p.name)])); // T011 at the member name (Q188 (a))
      if (r.name === "Arena" && m === "alloc") { const nn2 = self && nonNull(self); const el = nn2?.k === "gen" ? nn2.args[0] : undefined; return nn(withArgs([q(elemDesc(el))])); } // Q188 (b)
      if (r.name === "Arena" && m === "view") { const el = self?.k === "gen" ? self.args[0] : undefined; return nn(withArgs([q(elemDesc(el)), at(p.name)])); } // T012 at the member name (Q188 (b))
    } else if (r && isStr(r)) {
      if (m === "indexOf") return nn(`${RT}.idxOrNull(${withArgs([])})`);
      if (m === "codePointAt") return nn(`${RT}.nn(${withArgs([])})`);
      if (m === "charCodeAt") { const f = (o: string): string => `${RT}.charCodeAt(${o}, ${args[0]}, ${at(p.name)})`; return p.questionDotToken ? optional(gen(recv), awaited, f) : f(gen(recv)); }
    } else if (r?.k === "opaque") {
      if (r.name === "Js" && m === "decode") return nn(withArgs([desc(resultParts(self!)!.ok)]));
      if (r.name === "Js" && m === "callback") return nn(withArgs([desc(resultParts((typeOf(e.arguments[0]!) as FnType).params[0]!)!.ok)]));
      if (r.name === "FakeAudio" && m === "renderFrames") return nn(withArgs([at(p.name)]));
      if (r.name === "Test") return nn(withArgs([at(p.name)]));
    }
    if (groups) return groupedProp(e, groups, args, awaited);
    return nn(withArgs([]));
  }

  const isUsingStmt = (s: ts.Statement): boolean =>
    s.kind === K.VariableStatement && !!((s as ts.VariableStatement).declarationList.flags & NodeFlags.Using);

  function wrapUsingDecls(decls: readonly ts.VariableDeclaration[], idx: number, isAwaitUsing: boolean, rest: string): string {
    if (idx >= decls.length) return rest;
    const d = decls[idx]!;
    const name = (d.name as ts.Identifier).text;
    const init = gen(d.initializer!);
    const inner = wrapUsingDecls(decls, idx + 1, isAwaitUsing, rest);
    const dt = typeOf(d.name);
    let cleanup: string;
    if (dt?.k === "resource") {
      const meta = resourceCalls.get(assignTarget(d.initializer!) as ts.CallExpression);
      cleanup = meta?.kind === "ownWith"
        ? `if (${name}.a) { ${name}.a = false; ${name}.f(${name}.c, ${name}.v); }`
        : `if (${name}.a) { ${name}.a = false; ${name}.f(${name}.v); }`;
    } else if (isAwaitUsing) {
      cleanup = `${RT}.task(await ${name}.disposeAsync());`;
    } else {
      cleanup = `${name}.dispose();`;
    }
    return `const ${name} = ${init};\ntry {\n${inner}\n} finally {\n${cleanup}\n}`;
  }

  function emitStmtsWithUsing(ss: readonly ts.Statement[], emitOne: (s: ts.Statement, idx: number) => string, offset = 0): string {
    const out: string[] = [];
    for (let k = 0; k < ss.length; k++) {
      const s = ss[k]!;
      if (isUsingStmt(s)) {
        const dl = (s as ts.VariableStatement).declarationList;
        const isAwaitUsing = (dl.flags & NodeFlags.AwaitUsing) === NodeFlags.AwaitUsing;
        const rest = emitStmtsWithUsing(ss.slice(k + 1), emitOne, offset + k + 1);
        out.push(wrapUsingDecls(dl.declarations, 0, isAwaitUsing, rest));
        break;
      }
      out.push(emitOne(s, offset + k));
    }
    return out.join("\n");
  }

  /** Function bodies: contracts (§10.8), `using` LIFO cleanup (§5), and optional mutation instrumentation (§16.2). */
  function block(b: ts.Block): string {
    const fnLike = b.parent && [K.FunctionDeclaration, K.MethodDeclaration, K.ArrowFunction, K.FunctionExpression, K.Constructor].includes(b.parent.kind);
    const isCallNamed = (s: ts.Statement, nm: string): ts.CallExpression | undefined => {
      if (s.kind !== K.ExpressionStatement) return undefined;
      const e = (s as ts.ExpressionStatement).expression;
      return e.kind === K.CallExpression && isId((e as ts.CallExpression).expression) && ((e as ts.CallExpression).expression as ts.Identifier).text === nm
        ? (e as ts.CallExpression) : undefined;
    };
    const ss = b.statements;
    const hasUsing = ss.some(isUsingStmt);
    const targetEntry = mut && b.parent && (b.parent.kind === K.FunctionDeclaration || b.parent.kind === K.MethodDeclaration) ? mut.targets.get(b.parent) : undefined;
    const isTargetBody = !!targetEntry;
    const targetFnId = targetEntry ? targetEntry.id : -1;
    let reqEnd = 0;
    if (isTargetBody) {
      while (reqEnd < ss.length && ss[reqEnd]!.kind === K.ExpressionStatement && (ss[reqEnd] as ts.ExpressionStatement).expression.kind === K.StringLiteral) reqEnd++;
      while (reqEnd < ss.length && isCallNamed(ss[reqEnd]!, "requires")) reqEnd++;
    }
    const emitStmt = (s: ts.Statement, idx: number): string => {
      if (isTargetBody && idx < reqEnd) {
        const rc = isCallNamed(s, "requires");
        if (rc) {
          inContract++;
          try { return `${RT}.ownReq(${targetFnId}, ${gen(rc.arguments[0]!)}, ${at(rc.expression)});`; } finally { inContract--; }
        }
      }
      return gen(s);
    };
    const last = fnLike ? ss.map((s) => !!isCallNamed(s, "ensures")).lastIndexOf(true) : -1;
    if (last < 0 && !mut && !hasUsing) return splice(b);
    let inner: string;
    if (last < 0) {
      inner = emitStmtsWithUsing(ss, emitStmt);
    } else {
      const head: string[] = [], checks: string[] = [];
      for (let i = 0; i <= last; i++) {
        const s = ss[i]!;
        const ec = isCallNamed(s, "ensures");
        if (ec) {
          inContract++;
          try { checks.push(`${RT}.ensures(${gen(ec.arguments[0]!)}, ${R}, ${at(ec.expression)});`); } finally { inContract--; }
        } else {
          head.push(emitStmt(s, i));
        }
      }
      const isAsync = !!(b.parent as AnyNode as { modifiers?: ts.NodeArray<Node> }).modifiers?.some((x) => x.kind === K.AsyncKeyword);
      const rest = emitStmtsWithUsing(ss.slice(last + 1), emitStmt, last + 1);
      const run = isAsync ? `await (async () => {\n${rest}\n})()` : `(() => {\n${rest}\n})()`;
      inner = `${head.join("\n")}\nconst ${ENS} = (${R}) => { ${checks.join(" ")} return ${R}; };\nreturn ${ENS}(${run});`;
      if (!mut) return `{\n${inner}\n}`;
    }
    if (mut && isTargetBody) return `{\n${RT}.hit(${targetFnId}); ${RT}.step(); ${RT}.enter(${targetFnId});\ntry {\n${inner}\n} finally { ${RT}.leave(${targetFnId}); }\n}`;
    if (mut && fnLike && inContract === 0) return `{\n${RT}.step();\n${inner}\n}`;
    return `{\n${inner}\n}`;
  }

  // ---- module level (§1): imports become calls of IMP, `export` becomes the returned object.
  const body: string[] = [];
  const values = new Set<string>(), fns = new Set<string>();
  for (const s of sf.statements) {
    if (s.kind === K.FunctionDeclaration || s.kind === K.ClassDeclaration) {
      values.add((s as ts.FunctionDeclaration).name!.text);
      if (s.kind === K.FunctionDeclaration) fns.add((s as ts.FunctionDeclaration).name!.text);
    }
    else if (s.kind === K.VariableStatement) for (const d of (s as ts.VariableStatement).declarationList.declarations) for (const b of declBindings(d)) values.add(b.id.text);
    else if (s.kind === K.ImportDeclaration) for (const x of ((s as ts.ImportDeclaration).importClause!.namedBindings as ts.NamedImports).elements) values.add(x.name.text);
  }
  for (const s of sf.statements) {
    if (s.kind === K.ImportDeclaration) {
      const d = s as ts.ImportDeclaration;
      const spec = (d.moduleSpecifier as ts.StringLiteral).text;
      if (spec.startsWith("c:")) {
        if (mut) {
          const decls = sf.statements.filter((st): st is ts.ModuleDeclaration => {
            if (st.kind !== K.ModuleDeclaration) return false;
            const md = st as ts.ModuleDeclaration;
            return md.name.kind === K.StringLiteral && (md.name as ts.StringLiteral).text === spec && md.body?.kind === K.ModuleBlock;
          });
          const constNames = new Set<string>(), typeNames = new Set<string>();
          for (const md of decls) for (const st of (md.body as ts.ModuleBlock).statements) {
            if (st.kind === K.VariableStatement) for (const vd of (st as ts.VariableStatement).declarationList.declarations) if (isId(vd.name)) constNames.add(vd.name.text);
            if (st.kind === K.TypeAliasDeclaration) typeNames.add((st as ts.TypeAliasDeclaration).name.text);
          }
          const stubs = (d.importClause!.namedBindings as ts.NamedImports).elements.flatMap((x) => {
            const orig = (x.propertyName ?? x.name).text;
            if (typeNames.has(orig)) return [];
            return [constNames.has(orig) ? `${x.name.text} = 0` : `${x.name.text} = () => ${RT}.cOnly()`];
          });
          if (stubs.length) body.push(`const ${stubs.join(", ")};`);
        }
        continue; // §14: C declarations have no JS value; in mutate mode functions become COnlyReached stubs (Q275)
      }
      const key = spec.startsWith("npm:") ? spec : keyOf(canonPath(dirname(pf.path), spec));
      imports.push(key);
      const els = (d.importClause!.namedBindings as ts.NamedImports).elements.map((x) => (x.propertyName ? `${x.propertyName.text}: ${x.name.text}` : x.name.text));
      body.push(`const { ${els.join(", ")} } = ${IMP}(${JSON.stringify(key)});`);
      continue;
    }
    if (s.kind === K.ExportDeclaration) {
      for (const x of ((s as ts.ExportDeclaration).exportClause as ts.NamedExports).elements) {
        const local = (x.propertyName ?? x.name).text;
        if (values.has(local)) exported.push(x.propertyName ? `${x.name.text}: ${local}` : local); // types have no runtime value
      }
      continue;
    }
    if ((s as unknown as { modifiers?: ts.NodeArray<Node> }).modifiers?.some((x) => x.kind === K.ExportKeyword)) {
      if (s.kind === K.VariableStatement) for (const d of (s as ts.VariableStatement).declarationList.declarations) for (const b of declBindings(d)) exported.push(b.id.text);
      else if (s.kind === K.FunctionDeclaration || s.kind === K.ClassDeclaration) exported.push((s as ts.FunctionDeclaration).name!.text);
    }
    if (s.kind === K.ExpressionStatement && !tests) {
      const ex = (s as ts.ExpressionStatement).expression;
      if (ex.kind === K.CallExpression && (ex as ts.CallExpression).expression.kind === K.Identifier && ((ex as ts.CallExpression).expression as ts.Identifier).text === "test") continue; // §10.10
    }
    body.push(gen(s));
  }
  if (dmUsed.size) { // §12 (Q191): import the bundled DetMath module under names users cannot write
    const dmKey = keyOf(DETMATH_PATH);
    imports.push(dmKey);
    const els = [...dmUsed].sort().map((n) => `${n}: ${dmBinding(n)}`);
    body.unshift(`const { ${els.join(", ")} } = ${IMP}(${JSON.stringify(dmKey)});`);
  }
  // §15.2: isolate entry functions are readable by the isolate loader whether or not they are
  // declared `export` (who may *import* a name stays a static question for P1 / P2).
  for (const n of extraExports ?? []) if (!exported.includes(n)) exported.push(n);
  const mutTableExport = mut?.exportFns.length ? `${MUT_FNS}: { ${mut.exportFns.join(", ")} }` : "";
  const finalExports = [...exported, ...(mutTableExport ? [mutTableExport] : [])];
  const prelude = [
    `"use strict";`,
    `const { ${RT_NAMESPACES.join(", ")} } = ${RT};`,
    `const ${P} = [${poss.join(",")}];`,
    // Q100: function declarations are hoisted, so they are exported before the imports run and an import cycle can use them.
    `Object.assign(${EXPORTS}, { ${exported.filter((x) => fns.has(x.split(": ").at(-1)!)).join(", ")} });`,
    ...(needAp ? [`const ${AP} = (f, ...a) => f(...a);`] : []),
  ];
  const js = `${prelude.join("\n")}\n${body.join("\n")}\nreturn Object.assign(${EXPORTS}, { ${finalExports.join(", ")} });\n//# sourceURL=${SOURCE_URL}${keyOf(pf.path)}`;
  // new Function puts the body after a 2-line header, so body line 1 is line 3 of the frames.
  const calls = new Map<string, Pos>();
  let line = 3, ls = 0;
  for (const m of js.matchAll(new RegExp(`/\\*${MARK}(\\d+)\\*/`, "g"))) {
    for (let i = js.indexOf("\n", ls); i !== -1 && i < m.index; i = js.indexOf("\n", i + 1)) { line++; ls = i + 1; }
    calls.set(`${line}:${m.index + m[0].length - ls + 1}`, marks[+m[1]!]!);
  }
  return { js, imports, calls };
}

/** `await` in `e`, not counting nested functions. */
function hasAwait(e: Node): boolean {
  if (e.kind === K.AwaitExpression) return true;
  if (e.kind === K.ArrowFunction || e.kind === K.FunctionExpression) return false;
  return !!e.forEachChild((c) => (hasAwait(c) ? true : undefined));
}

/** TypeDesc (runtime-js result.ts) of a `cast` / `js.decode` target type (§3.2). */
function desc(t: Type): string {
  switch (t.k) {
    case "prim": return `{k:${JSON.stringify(t.name)}}`;
    case "num": return `{k:"num",t:${JSON.stringify(t.name)}}`;
    case "lit": return `{k:"lit",v:[${JSON.stringify(t.value)}]}`;
    case "record": return `{k:"rec",f:{${t.fields.map((f) => `${JSON.stringify(f.name)}:${desc(f.type)}`).join(",")}}}`;
    case "union":
      if (t.members.every((m) => m.k === "lit")) return `{k:"lit",v:${JSON.stringify(t.members.map((m) => (m as { value: string }).value))}}`;
      return `{k:"union",m:[${t.members.map(desc).join(",")}]}`;
    case "gen": if (t.name === "Array" || t.name === "ReadonlyArray") return `{k:"arr",of:${desc(t.args[0]!)}}`;
  }
  throw new Error(`emit: no cast descriptor for type kind ${t.k}`); // P2 limits cast targets (§3.2)
}
