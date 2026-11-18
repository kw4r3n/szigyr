// JS backend (SPEC §10, D030): one file -> the body of a module factory `(rt, imp) => exports`.
// Splices the source text: every node prints as its own text with its children replaced by their emission,
// type syntax deleted, and the §10 rewrites applied to the nodes that need them. Types come from P2 (exprTypes).
import { resolve, dirname } from "node:path";
import { SyntaxKind as K, type Node, type ParsedFile, type ts } from "./parse.ts";
import { exprTypes } from "./expr.ts";
import { NUM_NAMES, isInt, isStr, nonNull, resultParts, unref, type Type } from "./types.ts";
import { RUNTIME_GLOBAL } from "./names.ts";

export const RT = RUNTIME_GLOBAL;
export const IMP = `${RUNTIME_GLOBAL}_imp`;
const P = `${RUNTIME_GLOBAL}_P`, AP = `${RUNTIME_GLOBAL}_ap`, ENS = `${RUNTIME_GLOBAL}_ens`;
// Synthetic parameters: user code inside the right side / ensures predicates must not see them.
const O = `${RUNTIME_GLOBAL}_o`, KEY = `${RUNTIME_GLOBAL}_k`, V = `${RUNTIME_GLOBAL}_v`, R = `${RUNTIME_GLOBAL}_r`;
/** Builtin namespaces that are runtime values (the rest are JS globals). */
const RT_NAMESPACES = ["Vec", "OwnedCell", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs", "TestAlloc"];
const DROP_MODS = new Set<K>([K.ExportKeyword, K.ReadonlyKeyword, K.PrivateKeyword, K.PublicKeyword, K.ProtectedKeyword, K.DeclareKeyword, K.AbstractKeyword, K.OverrideKeyword]);
const COMPOUND: Partial<Record<K, string>> = {
  [K.PlusEqualsToken]: "+", [K.MinusEqualsToken]: "-", [K.AsteriskEqualsToken]: "*",
  [K.SlashEqualsToken]: "/", [K.PercentEqualsToken]: "%", [K.AsteriskAsteriskEqualsToken]: "**",
};
const INT_OP: Record<string, string> = { "+": "add", "-": "sub", "*": "mul" };

export interface Emitted {
  /** Factory body: `new Function(RT, IMP, js)` returns the exports object. */
  js: string;
  /** Relative imports (absolute paths) and npm specifiers (`npm:x`) that `IMP` is called with. */
  imports: string[];
}

type AnyNode = Node & Record<string, unknown>;

/** `tests`: keep the module's top-level `test(...)` calls (§9.2, §10.10). `file`: path reported in trap positions. */
export function emitFile(pf: ParsedFile, file: string, tests: boolean): Emitted {
  const sf = pf.sourceFile, text = sf.text;
  const poss: string[] = [];
  const imports: string[] = [];
  const exported: string[] = [];
  let needAp = false;

  const pos = (offset: number): string => {
    const p = pf.position(offset);
    poss.push(`{file:${JSON.stringify(file)},line:${p.line},col:${p.col}}`);
    return `${P}[${poss.length - 1}]`;
  };
  const at = (n: Node): string => pos(n.getStart(sf));
  const typeOf = (n: Node): Type | undefined => { const t = exprTypes.get(n); return t && unref(t); };
  const numName = (n: Node): string | undefined => { const t = typeOf(n); return t?.k === "num" ? t.name : undefined; };
  const skipWs = (i: number): number => { while (/\s/.test(text[i] ?? "")) i++; return i; };
  const backWs = (i: number): number => { while (i > 0 && /\s/.test(text[i - 1]!)) i--; return i; };

  /** Default: the node's text with each child replaced by its emission and type syntax deleted. */
  function splice(n: Node): string {
    const a = n as AnyNode;
    const cuts: { s: number; e: number; out: string }[] = [];
    const lists = [a.typeArguments, a.typeParameters] as (ts.NodeArray<Node> | undefined)[];
    n.forEachChild((c) => {
      const list = lists.find((l) => l?.includes(c));
      if (list) {
        if (c !== list[0]) return;
        const s = text.lastIndexOf("<", c.getStart(sf));
        const e = skipWs(list.end);
        cuts.push({ s, e: text[e] === ">" ? e + 1 : e, out: "" });
      } else if (a.type === c && n.kind !== K.AsExpression) {
        cuts.push({ s: text.lastIndexOf(":", c.getStart(sf)), e: c.end, out: "" }); // `: T`
      } else if (DROP_MODS.has(c.kind) || c.kind === K.HeritageClause) {
        cuts.push({ s: c.getStart(sf), e: skipWs(c.end), out: "" });
      } else cuts.push({ s: c.getStart(sf), e: c.end, out: gen(c) });
    });
    let out = "", cur = n.getStart(sf);
    for (const c of cuts) { out += text.slice(cur, c.s) + c.out; cur = c.e; }
    return out + text.slice(cur, n.end);
  }

  function gen(n: Node): string {
    switch (n.kind) {
      case K.TypeAliasDeclaration: case K.InterfaceDeclaration: return "";
      case K.AsExpression: return gen((n as ts.AsExpression).expression); // `as const` (Q026)
      case K.NumericLiteral: return numName(n) === "f32" ? `${RT}.f32(${splice(n)})` : splice(n); // Q015
      case K.PrefixUnaryExpression: return prefix(n as ts.PrefixUnaryExpression);
      case K.BinaryExpression: return binary(n as ts.BinaryExpression);
      case K.ElementAccessExpression: {
        const e = n as ts.ElementAccessExpression;
        return `${RT}.at(${gen(e.expression)}, ${gen(e.argumentExpression)}, ${at(e.argumentExpression)})`;
      }
      case K.PropertyAccessExpression: {
        const p = n as ts.PropertyAccessExpression;
        const callee = n.parent?.kind === K.CallExpression && (n.parent as ts.CallExpression).expression === n;
        return p.questionDotToken && !callee ? `${RT}.nn(${splice(n)})` : splice(n); // §10.7
      }
      case K.CallExpression: return call(n as ts.CallExpression);
      case K.Block: return block(n as ts.Block);
    }
    return splice(n);
  }

  function prefix(u: ts.PrefixUnaryExpression): string {
    const t = numName(u);
    if (u.operator === K.MinusToken && u.operand.kind === K.NumericLiteral) return t === "f32" ? `${RT}.f32(${splice(u)})` : splice(u); // negative literal (Q015)
    if (u.operator === K.MinusToken && t && isInt(typeOf(u)!)) return `${RT}.neg(${JSON.stringify(t)}, ${gen(u.operand)}, ${at(u)})`;
    if (u.operator === K.TildeToken && t === "u32") return `${RT}.toU32(${splice(u)})`;
    return splice(u);
  }

  /** `l op r` for a numeric type: range check (int + - *), rounding (f32), u32 normalization, shifts. */
  function op(t: string | undefined, o: string, l: string, r: string, anchor: string): string {
    if (t && INT_OP[o] && t !== "f32" && t !== "f64") return `${RT}.${INT_OP[o]}(${JSON.stringify(t)}, ${l}, ${r}, ${anchor})`;
    if (t === "f32" && ["+", "-", "*", "/", "%", "**"].includes(o)) return `${RT}.f32(${l} ${o} ${r})`;
    if (o === "<<") return `${RT}.shl(${JSON.stringify(t)}, ${l}, ${r}, ${anchor})`;
    if (o === ">>") return `${RT}.shr(${l}, ${r}, ${anchor})`;
    if (o === ">>>") return `${RT}.ushr(${l}, ${r}, ${anchor})`;
    if (t === "u32" && ["&", "|", "^"].includes(o)) return `${RT}.toU32(${l} ${o} ${r})`;
    return `${l} ${o} ${r}`;
  }

  function binary(b: ts.BinaryExpression): string {
    const k = b.operatorToken.kind;
    const o = b.operatorToken.getText(sf);
    const anchor = (): string => at(b.operatorToken);
    if (k === K.EqualsToken && b.left.kind === K.ElementAccessExpression) {
      const e = b.left as ts.ElementAccessExpression;
      return `${RT}.setAt(${gen(e.expression)}, ${gen(e.argumentExpression)}, ${gen(b.right)}, ${at(e.argumentExpression)})`;
    }
    const base = COMPOUND[k];
    if (base !== undefined) {
      const t = numName(b);
      const rhs = gen(b.right);
      const plain = !(t && (t === "f32" || (isInt(typeOf(b)!) && INT_OP[base])));
      // shortcut: element / property targets evaluate the right side inside an arrow, so `await` there is unsupported (no case needs it).
      if (b.left.kind === K.ElementAccessExpression) {
        needAp = true;
        const e = b.left as ts.ElementAccessExpression, ip = at(e.argumentExpression);
        return `${AP}((${O}, ${KEY}) => { const ${V} = ${op(t, base, `${RT}.at(${O}, ${KEY}, ${ip})`, rhs, anchor())}; ${RT}.setAt(${O}, ${KEY}, ${V}, ${ip}); return ${V}; }, ${gen(e.expression)}, ${gen(e.argumentExpression)})`;
      }
      if (plain) return splice(b);
      if (b.left.kind === K.PropertyAccessExpression) {
        needAp = true;
        const p = b.left as ts.PropertyAccessExpression, f = p.name.text;
        return `${AP}((${O}) => ${O}.${f} = ${op(t, base, `${O}.${f}`, rhs, anchor())}, ${gen(p.expression)})`;
      }
      const l = gen(b.left);
      return `${l} = ${op(t, base, l, rhs, anchor())}`;
    }
    const t = numName(b);
    if (t && ["+", "-", "*", "/", "%", "**", "<<", ">>", ">>>", "&", "|", "^"].includes(o)) return op(t, o, gen(b.left), gen(b.right), anchor());
    return splice(b);
  }

  function call(e: ts.CallExpression): string {
    const callee = e.expression;
    const args = e.arguments.map(gen);
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
        case "ensures": throw new Error("emit: ensures outside a function body prologue");
      }
      return splice(e);
    }
    if (callee.kind !== K.PropertyAccessExpression) return splice(e);
    const p = callee as ts.PropertyAccessExpression, m = p.name.text;
    const recv = p.expression;
    const withArgs = (extra: string[]): string => `${gen(callee)}(${[...args, ...extra].join(", ")})`;
    const nn = (s: string): string => (p.questionDotToken ? `${RT}.nn(${s})` : s);
    if (recv.kind === K.Identifier && (recv as ts.Identifier).text === "Vec" && m === "create" && !typeOf(recv)) {
      const el = self?.k === "gen" ? self.args[0] : undefined;
      return withArgs([q(el?.k === "num" ? el.name : "other")]);
    }
    const r0 = typeOf(recv);
    const r = r0 && (nonNull(r0) ?? r0);
    if (r?.k === "gen") {
      if ((r.name === "Array" || r.name === "ReadonlyArray") && (m === "pop" || m === "find")) return nn(`${RT}.nn(${withArgs([])})`);
      if ((r.name === "Array" || r.name === "ReadonlyArray") && (m === "indexOf" || m === "findIndex")) return nn(`${RT}.idxOrNull(${withArgs([])})`);
      if (r.name === "Map" && m === "get") return nn(`${RT}.nn(${withArgs([])})`);
      if ((r.name === "Vec" || r.name === "Slice") && m === "slice") return nn(withArgs([at(p.name)]));
      if (r.name === "OwnedCell" && (m === "take" || m === "put")) return nn(withArgs([at(p.name)]));
    } else if (r && isStr(r)) {
      if (m === "indexOf") return nn(`${RT}.idxOrNull(${withArgs([])})`);
      if (m === "codePointAt") return nn(`${RT}.nn(${withArgs([])})`);
      if (m === "charCodeAt") return nn(`${RT}.charCodeAt(${gen(recv)}, ${args[0]}, ${at(p.name)})`);
    } else if (r?.k === "opaque") {
      if (r.name === "Js" && m === "decode") return nn(withArgs([desc(resultParts(self!)!.ok)]));
      if (r.name === "Test") return nn(withArgs([at(p.name)]));
    }
    return nn(withArgs([]));
  }

  /** Function bodies: contracts (§10.8). `ensures` checks the result of the rest of the body, so every return path. */
  function block(b: ts.Block): string {
    const fnLike = b.parent && [K.FunctionDeclaration, K.MethodDeclaration, K.ArrowFunction, K.FunctionExpression, K.Constructor].includes(b.parent.kind);
    const isEnsures = (s: ts.Statement): boolean => s.kind === K.ExpressionStatement && (s as ts.ExpressionStatement).expression.kind === K.CallExpression &&
      ((s as ts.ExpressionStatement).expression as ts.CallExpression).expression.kind === K.Identifier &&
      (((s as ts.ExpressionStatement).expression as ts.CallExpression).expression as ts.Identifier).text === "ensures";
    const ss = b.statements;
    const last = fnLike ? ss.map(isEnsures).lastIndexOf(true) : -1;
    if (last < 0) return splice(b);
    const head = ss.slice(0, last + 1).filter((s) => !isEnsures(s)).map(gen);
    const checks = ss.filter(isEnsures).map((s) => {
      const c = (s as ts.ExpressionStatement).expression as ts.CallExpression;
      return `${RT}.ensures(${gen(c.arguments[0]!)}, ${R}, ${at(c.expression)});`;
    });
    const isAsync = !!(b.parent as AnyNode as { modifiers?: ts.NodeArray<Node> }).modifiers?.some((x) => x.kind === K.AsyncKeyword);
    const rest = ss.slice(last + 1).map(gen).join("\n");
    const run = isAsync ? `await (async () => {\n${rest}\n})()` : `(() => {\n${rest}\n})()`;
    return `{\n${head.join("\n")}\nconst ${ENS} = (${R}) => { ${checks.join(" ")} return ${R}; };\nreturn ${ENS}(${run});\n}`;
  }

  // ---- module level (§1): imports become calls of IMP, `export` becomes the returned object.
  const body: string[] = [];
  const values = new Set<string>();
  for (const s of sf.statements) {
    if (s.kind === K.FunctionDeclaration || s.kind === K.ClassDeclaration) values.add((s as ts.FunctionDeclaration).name!.text);
    else if (s.kind === K.VariableStatement) for (const d of (s as ts.VariableStatement).declarationList.declarations) values.add((d.name as ts.Identifier).text);
    else if (s.kind === K.ImportDeclaration) for (const x of ((s as ts.ImportDeclaration).importClause!.namedBindings as ts.NamedImports).elements) values.add(x.name.text);
  }
  for (const s of sf.statements) {
    if (s.kind === K.ImportDeclaration) {
      const d = s as ts.ImportDeclaration;
      const spec = (d.moduleSpecifier as ts.StringLiteral).text;
      const key = spec.startsWith("npm:") ? spec : resolve(dirname(pf.path), spec);
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
      if (s.kind === K.VariableStatement) for (const d of (s as ts.VariableStatement).declarationList.declarations) exported.push((d.name as ts.Identifier).text);
      else if (s.kind === K.FunctionDeclaration || s.kind === K.ClassDeclaration) exported.push((s as ts.FunctionDeclaration).name!.text);
    }
    if (s.kind === K.ExpressionStatement && !tests) {
      const ex = (s as ts.ExpressionStatement).expression;
      if (ex.kind === K.CallExpression && (ex as ts.CallExpression).expression.kind === K.Identifier && ((ex as ts.CallExpression).expression as ts.Identifier).text === "test") continue; // §10.10
    }
    body.push(gen(s));
  }
  const prelude = [
    `"use strict";`,
    `const { ${RT_NAMESPACES.join(", ")} } = ${RT};`,
    `const ${P} = [${poss.join(",")}];`,
    ...(needAp ? [`const ${AP} = (f, ...a) => f(...a);`] : []),
  ];
  return { js: `${prelude.join("\n")}\n${body.join("\n")}\nreturn { ${exported.join(", ")} };\n`, imports };
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
