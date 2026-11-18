// P2 expressions (D012): bidirectional checking. `expr(c, e, want)` types `e` with the contextual type `want`
// (numeric literals Q014, string literals Q016, object / array literals Q021, ok / err Q037, generic calls Q030).
import { SyntaxKind as K, type Node, type ts } from "./parse.ts";
import type { Checker } from "./checker.ts";
import { tparamShells, type Layer, type LocalSym } from "./modules.ts";
import { BUILTIN_FUNCTIONS, GLOBAL_AUTHORITIES, NAMESPACES, RESERVED, genMember, nsMember, opaqueMember, stringMember, type Member } from "./builtins.ts";
import { isDeterministic } from "./determinism.ts";
import {
  BOOL, ERROR, ERROR_RECORD, F64, NEVER, NULL, NUM_NAMES, STR, UNKNOWN, USIZE, VOID, assignable, bindTParams, field, fn, gen, hasTParam,
  isBool, isInt, isNull, isNum, isOwned, isStr, isTaggedUnion, kindOf, literalFits, nonNull, nullable, num, opaque, result, resultParts,
  same, show, subst, unify, union, unref, castable, comparable, isCopy, keyOk, type FnType, type NumName, type Type,
} from "./types.ts";

const isId = (n: Node | undefined): n is ts.Identifier => n?.kind === K.Identifier;
const isErr = (t: Type): boolean => t.k === "error";

/** A numeric expression made only of literals (Q014): it takes the type of its context. */
export function isLitOnly(e: ts.Expression): boolean {
  switch (e.kind) {
    case K.NumericLiteral: return true;
    case K.ParenthesizedExpression: return isLitOnly((e as ts.ParenthesizedExpression).expression);
    case K.PrefixUnaryExpression: return (e as ts.PrefixUnaryExpression).operator === K.MinusToken && isLitOnly((e as ts.PrefixUnaryExpression).operand);
    case K.BinaryExpression: {
      const b = e as ts.BinaryExpression;
      return ARITH.has(b.operatorToken.kind) && isLitOnly(b.left) && isLitOnly(b.right);
    }
  }
  return false;
}
const ARITH = new Set<K>([K.PlusToken, K.MinusToken, K.AsteriskToken, K.SlashToken, K.PercentToken, K.AsteriskAsteriskToken]);
const COMPOUND: Partial<Record<K, K>> = {
  [K.PlusEqualsToken]: K.PlusToken, [K.MinusEqualsToken]: K.MinusToken, [K.AsteriskEqualsToken]: K.AsteriskToken,
  [K.SlashEqualsToken]: K.SlashToken, [K.PercentEqualsToken]: K.PercentToken, [K.AsteriskAsteriskEqualsToken]: K.AsteriskAsteriskToken,
};
/** Operands typed from the other side (literals, string literals, null). */
const deferrable = (e: ts.Expression): boolean => isLitOnly(e) || e.kind === K.StringLiteral || e.kind === K.NullKeyword || e.kind === K.NoSubstitutionTemplateLiteral;
/** Arguments that need their parameter type before they can be typed (Q030). */
const ctxSensitive = (e: ts.Expression): boolean => deferrable(e) || e.kind === K.ObjectLiteralExpression || e.kind === K.ArrayLiteralExpression ||
  (e.kind === K.CallExpression && isId((e as ts.CallExpression).expression) && ["ok", "err"].includes(((e as ts.CallExpression).expression as ts.Identifier).text));
const isFnExpr = (e: ts.Expression): e is ts.ArrowFunction | ts.FunctionExpression => e.kind === K.ArrowFunction || e.kind === K.FunctionExpression;

/** The numeric type a literal takes from `want` (also `N | null`). */
function numCtx(want: Type | undefined): Type | undefined {
  if (!want) return undefined;
  if (want.k === "num") return want;
  const nn = nonNull(want);
  return nn?.k === "num" ? nn : undefined;
}
const sideCtx = (t: Type): Type => nonNull(t) ?? t;

export function checkTo(c: Checker, e: ts.Expression, want: Type, arg = false): Type {
  const t = expr(c, e, want);
  if (!assignable(t, want, arg)) { c.at("E2002", e, `expected '${show(want)}', got '${show(t)}'`); return ERROR; }
  return t;
}
/** E2004: conditions are boolean only (§3.1). */
export function cond(c: Checker, e: ts.Expression): void {
  const t = expr(c, e);
  if (!isBool(t) && !isErr(t)) c.at("E2004", e, `condition must be boolean, got '${show(t)}'`);
}

/** The type P2 gave each checked expression (last check wins), read by the JS emitter (§10, D030). */
export const exprTypes = new WeakMap<Node, Type>();
export function expr(c: Checker, e: ts.Expression, want?: Type): Type {
  const t = exprUnrecorded(c, e, want);
  exprTypes.set(e, t);
  return t;
}
function exprUnrecorded(c: Checker, e: ts.Expression, want?: Type): Type {
  switch (e.kind) {
    case K.Identifier: return ident(c, e as ts.Identifier);
    case K.NumericLiteral: return numLit(c, e, numValue(e as ts.NumericLiteral), want);
    case K.StringLiteral: case K.NoSubstitutionTemplateLiteral: return strLit((e as ts.StringLiteral).text, want);
    case K.TrueKeyword: case K.FalseKeyword: return BOOL;
    case K.NullKeyword: return NULL;
    case K.ThisKeyword: return c.fx.thisType ?? ERROR;
    case K.ParenthesizedExpression: return expr(c, (e as ts.ParenthesizedExpression).expression, want);
    case K.AsExpression: return expr(c, (e as ts.AsExpression).expression, want); // `as const` is a no-op (Q026)
    case K.TemplateExpression:
      for (const sp of (e as ts.TemplateExpression).templateSpans) {
        const t = expr(c, sp.expression);
        if (!isErr(t) && !isStr(t) && !isNum(t) && !isBool(t)) c.at("E2002", sp.expression, `cannot embed '${show(t)}' in a template`); // Q027
      }
      return STR;
    case K.AwaitExpression: {
      const t = expr(c, (e as ts.AwaitExpression).expression);
      if (t.k === "gen" && t.name === "Promise") return t.args[0]!;
      if (!isErr(t)) c.at("E2002", (e as ts.AwaitExpression).expression, "await needs a Promise");
      return ERROR;
    }
    case K.ConditionalExpression: return conditional(c, e as ts.ConditionalExpression, want);
    case K.BinaryExpression: return binary(c, e as ts.BinaryExpression, want);
    case K.PrefixUnaryExpression: return prefix(c, e as ts.PrefixUnaryExpression, want);
    case K.CallExpression: return call(c, e as ts.CallExpression, want);
    case K.NewExpression: return newExpr(c, e as ts.NewExpression, want);
    case K.PropertyAccessExpression: return propValue(c, e as ts.PropertyAccessExpression);
    case K.ElementAccessExpression: return element(c, e as ts.ElementAccessExpression, false);
    case K.ObjectLiteralExpression: return objLit(c, e as ts.ObjectLiteralExpression, want);
    case K.ArrayLiteralExpression: return arrLit(c, e as ts.ArrayLiteralExpression, want);
    case K.ArrowFunction: case K.FunctionExpression: {
      const w = want && unref(want);
      return checkArrow(c, e as ts.ArrowFunction, w?.k === "fn" ? w : undefined, false);
    }
  }
  throw new Error(`P2: unhandled expression kind ${e.kind}`); // P1 rejects every other kind
}

const numValue = (n: ts.NumericLiteral): number => Number(n.text.replace(/_/g, ""));

function numLit(c: Checker, anchor: Node, value: number, want: Type | undefined): Type {
  const t = (numCtx(want) ?? F64) as { k: "num"; name: NumName };
  if (!literalFits(value, t.name)) c.at("E2008", anchor, `literal ${value} does not fit '${t.name}'`);
  return t;
}

function strLit(value: string, want: Type | undefined): Type {
  const w = want && (nonNull(want) ?? want);
  const lits = w && (w.k === "lit" || (w.k === "union" && w.members.some((m) => m.k === "lit")));
  return lits ? { k: "lit", value } : STR;
}

// ---- names
function ident(c: Checker, id: ts.Identifier): Type {
  const name = id.text;
  const local = c.scope.lookup(name);
  if (local) { contractLocal(c, id, local); return c.narrow.get(`${local.id}`) ?? local.type; }
  const sym = c.prog.lookupValue(c.mod, name);
  if (sym) {
    switch (sym.k) {
      case "const": return sym.type;
      case "fn":
        if (c.fx.contract) c.at("E6002", id, `a contract cannot refer to the function value '${name}'`);
        return sym.sig;
      case "class": c.at("E2002", id, `class '${name}' is not a value`); return ERROR;
      case "jsref":
        if (c.fx.contract) c.at("E6002", id, `a contract cannot refer to '${name}'`);
        return opaque("JsRef");
      default: return ERROR;
    }
  }
  unresolved(c, id);
  return ERROR;
}

/** E2000 / E5001 for a name that is not declared (Q006, Q011, Q034). */
function unresolved(c: Checker, id: ts.Identifier): void {
  const name = id.text;
  if (GLOBAL_AUTHORITIES.has(name)) {
    const fix = c.authorityFix(name);
    c.at("E5001", id, `'${name}' is a global authority; take it as a parameter`, { name, ...(fix ? { authority: fix.authority } : {}) });
    if (fix?.fixes) c.prog.rep.out.at(-1)!.fixes = fix.fixes;
    return;
  }
  if (NAMESPACES.has(name) && !RESERVED.has(name)) { c.at("E2000", id, `'${name}' can only be used as a member access receiver`); return; }
  if (BUILTIN_FUNCTIONS.has(name)) { c.at("E2002", id, `builtin '${name}' can only be called`); return; }
  c.at("E2000", id, `unknown name '${name}'`);
}

/** E6002 (Q056): what a contract may refer to. */
function contractLocal(c: Checker, id: ts.Identifier, s: LocalSym): void {
  const k = c.fx.contract;
  if (!k || s.fnDepth > k.depth) return; // declared inside the contract expression (e.g. the `r` of ensures)
  const ok = s.param && s.fnDepth === k.depth && (k.kind === "requires" || !(isOwned(unref(s.declared)) || s.declared !== s.type));
  if (!ok) c.at("E6002", id, `a contract cannot refer to '${s.name}'`);
}

// ---- members
type MemberResult = { kind: "value"; type: Type; readonly: boolean } | { kind: "method"; sig: FnType; managedOnly?: boolean; layer?: Layer } | { kind: "variadic" } | { kind: "error" };
const MERR: MemberResult = { kind: "error" };

/** True when `id` names a namespace object, not shadowed by a declaration. */
const isNamespace = (c: Checker, id: ts.Identifier): boolean => NAMESPACES.has(id.text) && !c.scope.lookup(id.text) && !c.prog.lookupValue(c.mod, id.text);

function member(c: Checker, p: ts.PropertyAccessExpression, inCall: boolean): MemberResult {
  const name = p.name as ts.Identifier; // private names are E1000 in P1
  const recvNode = p.expression;
  if (isId(recvNode) && isNamespace(c, recvNode)) {
    if (recvNode.text === "Math" && name.text === "random") {
      const fix = c.authorityFix("random");
      c.at("E5001", name, "Math.random is a global authority; take a Random", { name: "Math.random", authority: "Random" });
      if (fix?.fixes) c.prog.rep.out.at(-1)!.fixes = fix.fixes;
      return MERR;
    }
    const m = nsMember(recvNode.text, name.text);
    if (m === undefined) { c.at("E2001", name, `'${recvNode.text}.${name.text}' is not in the allowlist`); return MERR; }
    if (m === "variadic") return inCall ? { kind: "variadic" } : (c.at("E2002", name, "a method can only be called"), MERR);
    return fromMember(c, m, name, inCall);
  }
  if (isId(recvNode) && !c.scope.lookup(recvNode.text)) {
    const sym = c.prog.lookupValue(c.mod, recvNode.text);
    if (sym?.k === "class") { // static members
      const f = sym.cls.fields.get(name.text), me = sym.cls.methods.get(name.text);
      if (f?.static && (!f.private || c.fx.cls === sym.cls)) return { kind: "value", type: f.type, readonly: f.readonly };
      if (me?.static && (!me.private || c.fx.cls === sym.cls)) return inCall ? { kind: "method", sig: me.sig, layer: "managed" } : (c.at("E2002", name, "a method can only be called"), MERR);
      c.at("E2002", name, `'${sym.cls.name}' has no static member '${name.text}'`);
      return MERR;
    }
  }
  let recv = expr(c, recvNode);
  if (isErr(recv)) return MERR;
  if (p.questionDotToken) {
    const nn = nonNull(recv);
    if (!nn) { c.at("E2002", name, "'?.' needs a nullable receiver"); return MERR; }
    const r = lookupMember(c, unref(nn), name, inCall);
    if (r.kind === "value") return { ...r, type: nullable(r.type) };
    if (r.kind === "method") return { ...r, sig: { ...r.sig, ret: nullable(r.sig.ret) } };
    return r;
  }
  recv = unref(recv);
  if (nonNull(recv)) { c.at("E2002", name, `'${show(recv)}' may be null`); return MERR; }
  return lookupMember(c, recv, name, inCall);
}

function fromMember(c: Checker, m: Member, name: ts.Identifier, inCall: boolean): MemberResult {
  if (m.kind === "prop") return { kind: "value", type: m.type, readonly: m.readonly };
  if (!inCall) { c.at("E2002", name, "a method can only be called"); return MERR; }
  return { kind: "method", sig: m.sig, ...(m.managedOnly ? { managedOnly: true } : {}) };
}

function lookupMember(c: Checker, t: Type, name: ts.Identifier, inCall: boolean): MemberResult {
  const n = name.text;
  const missing = (code: string): MemberResult => { c.at(code, name, `'${show(t)}' has no member '${n}'`); return MERR; };
  switch (t.k) {
    case "record": {
      const f = field(t, n);
      return f ? { kind: "value", type: f.type, readonly: f.readonly } : missing("E2002");
    }
    case "class": {
      const m = bindTParams(t.cls.tparams, t.args);
      const f = t.cls.fields.get(n), me = t.cls.methods.get(n);
      const visible = (x: { private: boolean; static: boolean }): boolean => !x.static && (!x.private || c.fx.cls === t.cls);
      if (f && visible(f)) return { kind: "value", type: subst(f.type, m), readonly: f.readonly };
      if (me && visible(me)) return inCall ? { kind: "method", sig: subst(me.sig, m) as FnType, layer: "managed" } : missing("E2002");
      return missing("E2002");
    }
    case "iface": {
      const s = t.iface.methods.get(n);
      if (!s || !inCall) return missing("E2002");
      return { kind: "method", sig: subst(s, bindTParams(t.iface.tparams, t.args)) as FnType, layer: "managed" };
    }
    case "union": { // a field common to every member of a tagged union (`kind`, §3.2)
      const fs = t.members.map((m) => field(m, n));
      if (!isTaggedUnion(t) || fs.some((f) => !f)) return missing("E2002");
      return { kind: "value", type: union(fs.map((f) => f!.type)), readonly: fs.every((f) => f!.readonly) };
    }
    case "tparam": return t.p.constraint ? lookupMember(c, t.p.constraint, name, inCall) : missing("E2002");
    case "gen": {
      if ((t.name === "Array" || t.name === "ReadonlyArray") && (n === "includes" || n === "indexOf") && !isErr(t.args[0]!) && !eqable(t.args[0]!)) { // Q032
        c.at("E2002", name, `'${n}' needs an element type that supports '===', not '${show(t.args[0]!)}'`);
        return MERR;
      }
      const m = genMember(t, n);
      return m ? fromMember(c, m, name, inCall) : missing("E2001");
    }
    case "opaque": { const m = opaqueMember(t.name, n); return m ? fromMember(c, m, name, inCall) : missing("E2001"); }
    case "num": return missing("E2001");
    case "prim": if (t.name === "boolean") return missing("E2001"); break;
  }
  if (isStr(t)) {
    const m = stringMember(n);
    return m ? fromMember(c, m, name, inCall) : missing("E2001");
  }
  return missing("E2002");
}

function propValue(c: Checker, p: ts.PropertyAccessExpression): Type {
  const r = member(c, p, false);
  if (r.kind !== "value") return ERROR;
  const k = c.keyOf(p);
  return k && c.narrow.has(k.key) ? c.narrow.get(k.key)! : r.type;
}

function element(c: Checker, e: ts.ElementAccessExpression, write: boolean): Type {
  const t = unref(expr(c, e.expression));
  const idx = e.argumentExpression;
  if (isErr(t)) { expr(c, idx, USIZE); return ERROR; }
  if (t.k === "gen" && ["Array", "ReadonlyArray", "Vec", "Slice"].includes(t.name)) {
    checkTo(c, idx, USIZE);
    if (write && t.name === "ReadonlyArray") { c.at("E2002", idx, "ReadonlyArray cannot be written"); return ERROR; }
    return t.args[0]!;
  }
  const builtin = isStr(t) || (t.k === "gen") || t.k === "opaque";
  c.at(builtin ? "E2001" : "E2002", idx, `'${show(t)}' cannot be indexed`); // Q007
  return ERROR;
}

// ---- assignment targets
function lvalue(c: Checker, e: ts.Expression): Type {
  if (e.kind === K.ParenthesizedExpression) return lvalue(c, (e as ts.ParenthesizedExpression).expression);
  if (isId(e)) {
    const s = c.scope.lookup(e.text);
    if (s) {
      if (!s.mutable) c.at("E2002", e, `'${e.text}' is const`);
      c.forget(s.id);
      return s.mutable ? s.type : ERROR;
    }
    if (c.prog.lookupValue(c.mod, e.text)) { c.at("E2002", e, `'${e.text}' cannot be assigned`); return ERROR; }
    unresolved(c, e);
    return ERROR;
  }
  if (e.kind === K.PropertyAccessExpression) {
    const p = e as ts.PropertyAccessExpression;
    const r = member(c, p, false);
    if (r.kind !== "value") return ERROR;
    const ctorThis = c.fx.inCtor && p.expression.kind === K.ThisKeyword;
    if (r.readonly && !ctorThis) { c.at("E2002", p.name, `'${p.name.text}' is readonly`); return ERROR; }
    return r.type;
  }
  if (e.kind === K.ElementAccessExpression) return element(c, e as ts.ElementAccessExpression, true);
  c.at("E2002", e, "invalid assignment target");
  return ERROR;
}

// ---- operators (§3.1, Q008, Q017 - Q019)
/** Types two operands; a literal side takes its type from the other side (Q014). */
function operands(c: Checker, l: ts.Expression, r: ts.Expression, want: Type | undefined): [Type, Type] {
  const L = deferrable(l), R = deferrable(r);
  if (L && R) { const ctx = numCtx(want) ?? (isLitOnly(l) && isLitOnly(r) ? F64 : undefined); return [expr(c, l, ctx), expr(c, r, ctx)]; }
  if (L) { const rt = expr(c, r); return [expr(c, l, sideCtx(rt)), rt]; }
  if (R) { const lt = expr(c, l); return [lt, expr(c, r, sideCtx(lt))]; }
  return [expr(c, l), expr(c, r)];
}

/** SPEC §11 fix for an E2003 just reported at `op`: an operand that is an untyped `let x = 0` gets the other side's type. */
function numFix(c: Checker, op: Node, l: ts.Expression, r: ts.Expression, lt: Type, rt: Type): void {
  const d = c.prog.rep.out.at(-1);
  if (d?.code !== "E2003" || d.range.start.line !== c.fx.mod.pf.position(op.getStart(c.fx.mod.sf)).line || d.range.start.col !== c.fx.mod.pf.position(op.getStart(c.fx.mod.sf)).col) return;
  for (const [side, other] of [[l, rt], [r, lt]] as const) {
    if (!isId(side) || other.k !== "num") continue;
    const sym = c.scope.lookup(side.text);
    const name = sym && c.litLets.get(sym.id);
    if (!name || sym.type.k !== "num" || sym.type.name === other.name) continue;
    const pos = c.fx.mod.pf.position(name.end);
    (d.fixes ??= []).push({ title: `declare '${name.text}' as '${other.name}'`, edits: [{ range: { start: pos, end: pos }, newText: `: ${other.name}` }] });
  }
}

function arith(c: Checker, op: Node, kind: K, lt: Type, rt: Type): Type {
  if (isErr(lt) || isErr(rt)) return ERROR;
  if (isNum(lt) && isNum(rt)) {
    if (lt.name !== rt.name) { c.at("E2003", op, `cannot mix '${lt.name}' and '${rt.name}'`); return ERROR; }
    if (kind === K.SlashToken && isInt(lt)) { c.at("E2007", op, "integer '/' is not allowed; use divTrunc"); return ERROR; }
    if ((kind === K.PercentToken || kind === K.AsteriskAsteriskToken) && isInt(lt)) { c.at("E2002", op, "this operator is for floating-point types only"); return ERROR; }
    return lt;
  }
  c.at("E2002", op, `operator cannot be applied to '${show(lt)}' and '${show(rt)}'`);
  return ERROR;
}

function binary(c: Checker, b: ts.BinaryExpression, want: Type | undefined): Type {
  const op = b.operatorToken;
  const k = op.kind;
  if (k === K.EqualsToken) {
    const lt = lvalue(c, b.left);
    if (isErr(lt)) { expr(c, b.right); return ERROR; }
    checkTo(c, b.right, lt);
    return lt;
  }
  const base = COMPOUND[k];
  if (base !== undefined) {
    const lt = lvalue(c, b.left);
    const rt = expr(c, b.right, isNum(lt) ? lt : undefined);
    const r = arith(c, op, base, lt, rt);
    numFix(c, op, b.left, b.right, lt, rt);
    return r;
  }
  switch (k) {
    case K.AmpersandAmpersandToken: case K.BarBarToken: {
      const lt = expr(c, b.left);
      if (!isBool(lt) && !isErr(lt)) c.at("E2004", b.left, "operand must be boolean");
      const saved = c.narrow;
      c.narrow = new Map(saved); c.withFacts(c.facts(b.left, k === K.AmpersandAmpersandToken));
      const rt = expr(c, b.right);
      c.narrow = saved;
      if (!isBool(rt) && !isErr(rt)) c.at("E2004", b.right, "operand must be boolean");
      return BOOL;
    }
    case K.QuestionQuestionToken: {
      const lt = expr(c, b.left);
      if (isErr(lt)) { expr(c, b.right); return ERROR; }
      const inner = nonNull(lt);
      if (!inner) { c.at("E2002", op, "'??' needs a nullable left operand"); return ERROR; }
      const rt = expr(c, b.right, inner);
      if (assignable(rt, inner)) return inner;
      if (assignable(rt, lt)) return lt;
      c.at("E2002", b.right, `expected '${show(inner)}', got '${show(rt)}'`);
      return ERROR;
    }
    case K.EqualsEqualsEqualsToken: case K.ExclamationEqualsEqualsToken: {
      const [lt, rt] = operands(c, b.left, b.right, undefined);
      if (isErr(lt) || isErr(rt)) return BOOL;
      equality(c, op, lt, rt);
      numFix(c, op, b.left, b.right, lt, rt);
      return BOOL;
    }
    case K.LessThanToken: case K.LessThanEqualsToken: case K.GreaterThanToken: case K.GreaterThanEqualsToken: {
      const [lt, rt] = operands(c, b.left, b.right, undefined);
      if (isErr(lt) || isErr(rt)) return BOOL;
      if (isNum(lt) && isNum(rt)) { if (lt.name !== rt.name) c.at("E2003", op, `cannot compare '${lt.name}' and '${rt.name}'`); }
      else c.at("E2002", op, "relational operators need numbers of the same type"); // Q018
      numFix(c, op, b.left, b.right, lt, rt);
      return BOOL;
    }
    case K.AmpersandToken: case K.BarToken: case K.CaretToken:
    case K.LessThanLessThanToken: case K.GreaterThanGreaterThanToken: case K.GreaterThanGreaterThanGreaterThanToken: {
      const [lt, rt] = operands(c, b.left, b.right, want);
      if (isErr(lt) || isErr(rt)) return ERROR;
      if (isNum(lt) && isNum(rt) && lt.name !== rt.name) { c.at("E2003", op, `cannot mix '${lt.name}' and '${rt.name}'`); return ERROR; }
      const okTypes = k === K.GreaterThanGreaterThanToken ? ["i32"] : k === K.GreaterThanGreaterThanGreaterThanToken ? ["u32"] : ["i32", "u32"];
      if (!isNum(lt) || !okTypes.includes(lt.name)) { c.at("E2002", op, `bit operator cannot be applied to '${show(lt)}'`); return ERROR; }
      return lt;
    }
  }
  if (ARITH.has(k)) {
    const [lt, rt] = operands(c, b.left, b.right, want);
    if (k === K.PlusToken && isStr(lt) && isStr(rt)) { c.at("E2002", op, "use a template literal to concatenate strings"); return ERROR; } // Q019
    const r = arith(c, op, k, lt, rt);
    numFix(c, op, b.left, b.right, lt, rt);
    return r;
  }
  return ERROR;
}

/** Q017: element types for which `===` works (the `T` of `T | null` counts). */
function eqable(t: Type): boolean {
  const a = nonNull(t) ?? t;
  return isNum(a) || isBool(a) || isStr(a) || a.k === "class";
}

/** Q058: the first argument of `t.traps` is a string literal naming a trap (T001 - T010). */
function trapCode(c: Checker, a: ts.Expression): void {
  const ok = (a.kind === K.StringLiteral || a.kind === K.NoSubstitutionTemplateLiteral) && /^T(00[1-9]|010)$/.test((a as ts.StringLiteral).text);
  if (!ok) c.at("E2002", a, "the first argument of 'traps' must be a trap code literal \"T001\" - \"T010\"");
}

/** Q017: which types `===` / `!==` accept. */
function equality(c: Checker, op: Node, lt: Type, rt: Type): void {
  if (isNull(lt) || isNull(rt)) {
    const other = isNull(lt) ? rt : lt;
    if (isNull(other) || nonNull(other)) return;
    c.at("E2002", op, `'${show(other)}' is never null`);
    return;
  }
  const a = nonNull(lt) ?? lt, b = nonNull(rt) ?? rt;
  if (isNum(a) && isNum(b)) { if (a.name !== b.name) c.at("E2003", op, `cannot compare '${a.name}' and '${b.name}'`); return; }
  if ((isBool(a) && isBool(b)) || (isStr(a) && isStr(b)) || (a.k === "class" && same(a, b))) return;
  c.at("E2002", op, `cannot compare '${show(lt)}' and '${show(rt)}'`);
}

function prefix(c: Checker, u: ts.PrefixUnaryExpression, want: Type | undefined): Type {
  if (u.operator === K.MinusToken && isLitOnly(u.operand)) { // negative literal (Q015): anchor at '-'
    if (u.operand.kind === K.NumericLiteral) return numLit(c, u, -numValue(u.operand as ts.NumericLiteral), want);
    const t = expr(c, u.operand, numCtx(want) ?? F64);
    return negate(c, u, t);
  }
  if (u.operator === K.ExclamationToken) {
    const t = expr(c, u.operand);
    if (!isBool(t) && !isErr(t)) c.at("E2004", u.operand, "operand must be boolean");
    return BOOL;
  }
  const t = expr(c, u.operand, want);
  if (u.operator === K.MinusToken) return negate(c, u, t);
  if (isErr(t)) return ERROR;
  if (!isNum(t) || (t.name !== "i32" && t.name !== "u32")) { c.at("E2002", u, `'~' cannot be applied to '${show(t)}'`); return ERROR; }
  return t;
}
function negate(c: Checker, u: Node, t: Type): Type {
  if (isErr(t)) return ERROR;
  if (!isNum(t) || ["u8", "u16", "u32", "usize"].includes(t.name)) { c.at("E2002", u, `unary '-' cannot be applied to '${show(t)}'`); return ERROR; }
  return t;
}

function conditional(c: Checker, e: ts.ConditionalExpression, want: Type | undefined): Type {
  cond(c, e.condition);
  const saved = c.narrow;
  c.narrow = new Map(saved); c.withFacts(c.facts(e.condition, true));
  const a = want ? checkTo(c, e.whenTrue, want) : expr(c, e.whenTrue);
  c.narrow = new Map(saved); c.withFacts(c.facts(e.condition, false));
  const b = want ? checkTo(c, e.whenFalse, want) : expr(c, e.whenFalse, deferrable(e.whenFalse) ? sideCtx(a) : undefined);
  c.narrow = saved;
  if (want) return isErr(a) || isErr(b) ? ERROR : want;
  if (isErr(a) || isErr(b)) return ERROR;
  if (assignable(a, b)) return b;
  if (assignable(b, a)) return a;
  if (isNull(a) || isNull(b) || (isStr(a) && isStr(b))) return union([a, b]);
  c.at("E2002", e.whenFalse, `branches have different types '${show(a)}' and '${show(b)}'`);
  return ERROR;
}

// ---- literals with context (Q021)
function objLit(c: Checker, e: ts.ObjectLiteralExpression, want: Type | undefined): Type {
  if (!want) { c.at("E2006", e, "an object literal needs a type from its context"); return ERROR; }
  let t = unref(nonNull(want) ?? want);
  if (isErr(t)) return ERROR;
  if (t.k === "union" && isTaggedUnion(t)) {
    const kp = e.properties.find((p) => p.kind === K.PropertyAssignment && isId(p.name) && p.name.text === "kind") as ts.PropertyAssignment | undefined;
    const kv = kp?.initializer.kind === K.StringLiteral ? (kp.initializer as ts.StringLiteral).text : undefined;
    const m = t.members.find((x) => kindOf(x) === kv);
    if (!m) { c.at("E2002", e, `no member of '${show(t)}' has this kind`); return ERROR; }
    t = m;
  }
  if (t.k !== "record") { c.at("E2002", e, `an object literal is not a '${show(t)}'`); return ERROR; }
  const rec = t;
  const given = new Set<string>();
  let bad = false;
  for (const p of e.properties) {
    if (p.kind === K.SpreadAssignment) { // Q053
      const st = unref(expr(c, (p as ts.SpreadAssignment).expression));
      if (isErr(st)) { bad = true; continue; }
      if (st.k !== "record" || st.fields.some((f) => !field(rec, f.name) || !assignable(f.type, field(rec, f.name)!.type))) {
        c.at("E2002", (p as ts.SpreadAssignment).expression, "spread does not match the record type");
        return ERROR;
      }
      for (const f of st.fields) given.add(f.name);
      continue;
    }
    const name = (p as ts.PropertyAssignment).name as ts.Identifier;
    const f = field(rec, name.text);
    if (!f) { c.at("E2002", e, `'${show(rec)}' has no field '${name.text}'`); return ERROR; }
    given.add(name.text);
    if (p.kind === K.PropertyAssignment) { if (isErr(checkTo(c, (p as ts.PropertyAssignment).initializer, f.type))) bad = true; }
    else {
      const vt = ident(c, name);
      if (!assignable(vt, f.type)) { c.at("E2002", name, `expected '${show(f.type)}', got '${show(vt)}'`); bad = true; }
    }
  }
  const miss = rec.fields.find((f) => !given.has(f.name));
  if (miss && !bad) { c.at("E2002", e, `missing field '${miss.name}'`); return ERROR; }
  return bad ? ERROR : rec;
}

function arrLit(c: Checker, e: ts.ArrayLiteralExpression, want: Type | undefined): Type {
  const w = want && unref(nonNull(want) ?? want);
  if (w && isErr(w)) return ERROR;
  let elem: Type | undefined;
  if (w) {
    if (w.k !== "gen" || (w.name !== "Array" && w.name !== "ReadonlyArray")) { c.at("E2002", e, `an array literal is not a '${show(w)}'`); return ERROR; }
    elem = w.args[0]!;
  } else if (!e.elements.length) { c.at("E2006", e, "an empty array literal needs a type from its context"); return ERROR; }
  else {
    const first = e.elements.find((x) => x.kind !== K.SpreadElement && !deferrable(x));
    if (first) elem = expr(c, first);
    else if (e.elements.every((x) => isLitOnly(x))) elem = F64;
    else if (e.elements.every((x) => x.kind === K.StringLiteral || x.kind === K.NoSubstitutionTemplateLiteral)) elem = STR;
    else { const sp = e.elements.find((x) => x.kind === K.SpreadElement) as ts.SpreadElement | undefined; const st = sp && expr(c, sp.expression); elem = st?.k === "gen" ? st.args[0]! : ERROR; }
    if (elem.k === "lit") elem = STR;
    if (isErr(elem)) return ERROR;
  }
  let bad = false;
  for (const x of e.elements) {
    if (x.kind === K.SpreadElement) {
      const st = expr(c, (x as ts.SpreadElement).expression);
      if (!isErr(st) && !(st.k === "gen" && (st.name === "Array" || st.name === "ReadonlyArray") && assignable(st.args[0]!, elem))) { c.at("E2002", (x as ts.SpreadElement).expression, "spread element type mismatch"); bad = true; }
    } else if (isErr(checkTo(c, x, elem))) bad = true;
  }
  return bad ? ERROR : gen("Array", elem);
}

/** Arrow functions and function expressions (Q022: parameters annotated, return inferred when not annotated). */
export function checkArrow(c: Checker, e: ts.ArrowFunction | ts.FunctionExpression, want: FnType | undefined, inferRet: boolean): FnType {
  const tps = tparamShells(e.typeParameters);
  const outerTps = c.fx.tparams;
  c.fx.tparams = new Map([...outerTps, ...tps.map((p) => [p.name, p] as const)]);
  e.typeParameters?.forEach((d, i) => { if (d.constraint) { const t = c.typeOf(d.constraint); if (t.k === "iface") tps[i]!.constraint = t; else if (!isErr(t)) c.at("E2002", d.constraint, "a constraint must be an interface"); } });
  const params = e.parameters.map((p) => {
    if (!p.type) { c.at("E2006", p.name, "parameter needs a type annotation"); return ERROR; }
    return c.typeOf(p.type);
  });
  let ret = e.type ? c.typeOf(e.type, true) : undefined;
  c.fx.tparams = outerTps;
  if (!ret && want && !inferRet) ret = want.ret;
  const sig = fn(params, ret ?? ERROR, tps);
  const got = c.fnBody(e, sig, { inferRet: !ret });
  return fn(params, ret ?? got, tps);
}

// ---- calls
function call(c: Checker, e: ts.CallExpression, want: Type | undefined): Type {
  const callee = e.expression;
  if (isId(callee) && !c.scope.lookup(callee.text)) {
    const sym = c.prog.lookupValue(c.mod, callee.text);
    if (!sym && BUILTIN_FUNCTIONS.has(callee.text)) return builtinCall(c, e, callee, want);
    if (sym?.k === "fn") {
      if (!c.callAllowed(sym.layer)) c.at("E4001", callee, `a ${c.fx.layer} function cannot call the ${sym.layer} function '${sym.name}'`);
      if (c.fx.contract && !isDeterministic(sym.sig)) c.at("E6002", callee, `a contract can only call deterministic functions ('${sym.name}' is not)`);
      return callSig(c, sym.sig, e, callee, want);
    }
    if (sym?.k === "class") { c.at("E2002", callee, `use 'new ${callee.text}(...)'`); return ERROR; }
    if (!sym) { unresolved(c, callee); return ERROR; }
  }
  if (callee.kind === K.PropertyAccessExpression) {
    const p = callee as ts.PropertyAccessExpression;
    const m = member(c, p, true);
    if (m.kind === "error") return ERROR;
    if (m.kind === "variadic") { // Math.min / Math.max (Q033)
      if (!e.arguments.length) c.at("E2002", p.name, "expects at least one argument");
      for (const a of e.arguments) checkTo(c, a, F64, true);
      return F64;
    }
    if (m.kind === "method") {
      if ((m.managedOnly || m.layer === "managed") && !c.callAllowed("managed")) c.at("E4001", p.name, `'${p.name.text}' is managed-only`); // Q044
      if (m.sig.tcheck === "trap" && e.arguments[0]) trapCode(c, e.arguments[0]);
      return callSig(c, m.sig, e, p.name, want);
    }
    if (m.type.k === "fn") return callSig(c, m.type, e, p.name, want);
    if (!isErr(m.type)) c.at("E2002", p.name, `'${show(m.type)}' is not callable`);
    return ERROR;
  }
  const t = unref(expr(c, callee));
  if (t.k === "fn") return callSig(c, t, e, callee, want);
  if (!isErr(t)) c.at("E2002", callee, `'${show(t)}' is not callable`);
  return ERROR;
}

/** A call against a signature, inferring type arguments (Q014, Q030): plain arguments, then arrows, then the context, then literals. */
function callSig(c: Checker, sig: FnType, e: ts.CallExpression | ts.NewExpression, anchor: Node, want: Type | undefined): Type {
  const args = e.arguments ?? ([] as unknown as ts.NodeArray<ts.Expression>);
  const min = sig.min ?? sig.params.length;
  if (args.length < min || args.length > sig.params.length) {
    c.at("E2002", anchor, `expects ${min === sig.params.length ? min : `${min}-${sig.params.length}`} argument(s), got ${args.length}`);
    return ERROR;
  }
  const ids = new Set(sig.tparams.map((p) => p.id));
  const m = new Map<number, Type>();
  if (e.typeArguments) {
    if (e.typeArguments.length !== sig.tparams.length) { c.at("E2002", anchor, `expects ${sig.tparams.length} type argument(s)`); return ERROR; }
    sig.tparams.forEach((p, i) => m.set(p.id, c.typeOf(e.typeArguments![i]!)));
  }
  const open = (t: Type): boolean => hasTParam(subst(t, m), ids);
  const later: (Type | undefined)[] = [];
  const done: boolean[] = [];
  args.forEach((a, i) => { // 1: arguments that do not need context
    const p = sig.params[i]!;
    if (!open(p)) { checkTo(c, a, unref(subst(p, m)), true); done[i] = true; }
    else if (!isFnExpr(a) && !ctxSensitive(a)) { const t = expr(c, a); unify(unref(p), t, m, ids); later[i] = t; }
  });
  args.forEach((a, i) => { // 2: function expressions
    if (done[i] || later[i] || !isFnExpr(a)) return;
    const p = unref(subst(sig.params[i]!, m));
    const t = checkArrow(c, a, p.k === "fn" ? p : undefined, p.k === "fn" && hasTParam(p.ret, ids));
    unify(unref(sig.params[i]!), t, m, ids);
    later[i] = t;
  });
  if (want && sig.tparams.some((p) => !m.has(p.id))) unify(sig.ret, want, m, ids); // 3: the context
  args.forEach((a, i) => { // 4: literals
    if (done[i] || later[i]) return;
    const p = sig.params[i]!;
    if (open(p)) { const t = expr(c, a); unify(unref(p), t.k === "lit" ? STR : t, m, ids); later[i] = t; }
    else { checkTo(c, a, unref(subst(p, m)), true); done[i] = true; }
  });
  const unbound = sig.tparams.filter((p) => !m.has(p.id));
  if (unbound.length) {
    c.at("E2006", anchor, `cannot infer type argument(s) ${unbound.map((p) => p.name).join(", ")}`);
    return ERROR;
  }
  for (const [i, p] of sig.tparams.entries()) { // `T extends I` (§3.2)
    const b = m.get(p.id)!;
    if (p.constraint && !isErr(b) && !assignable(b, subst(p.constraint, m))) {
      c.at("E2002", e.typeArguments?.[i] ?? anchor, `'${show(b)}' does not implement '${show(p.constraint)}'`);
      return ERROR;
    }
  }
  const tc = sig.tcheck;
  if ((tc === "cast" || tc === "eq" || tc === "copy") && sig.tparams[0]) { // Q084, Q086
    const b = m.get(sig.tparams[0].id)!;
    if (!isErr(b) && !(tc === "cast" ? castable(b) : tc === "eq" ? comparable(b) : b.k === "tparam" || isCopy(b))) {
      c.at("E2002", e.typeArguments?.[0] ?? anchor, `'${show(b)}' is not allowed as the type argument here`);
      return ERROR;
    }
  }
  args.forEach((a, i) => {
    const t = later[i];
    if (!t || isErr(t)) return;
    const p = unref(subst(sig.params[i]!, m));
    if (!assignable(t, p, true)) c.at("E2002", a, `expected '${show(p)}', got '${show(t)}'`);
  });
  return subst(sig.ret, m);
}

function builtinCall(c: Checker, e: ts.CallExpression, callee: ts.Identifier, want: Type | undefined): Type {
  const name = callee.text;
  const args = e.arguments;
  const arity = (n: number): boolean => {
    if (args.length === n) return true;
    c.at("E2002", callee, `'${name}' expects ${n} argument(s)`);
    return false;
  };
  if ((NUM_NAMES as readonly string[]).includes(name)) { // conversions (§3.1, Q034)
    if (!arity(1)) return ERROR;
    const t = expr(c, args[0]!);
    if (!isErr(t) && !isNum(t)) c.at("E2002", args[0]!, `cannot convert '${show(t)}'`);
    return num(name as NumName);
  }
  switch (name) {
    case "wrapAdd": case "wrapSub": case "wrapMul": case "divTrunc": case "rem": {
      if (!arity(2)) return ERROR;
      const [lt, rt] = operands(c, args[0]!, args[1]!, want);
      if (isErr(lt) || isErr(rt)) return ERROR;
      if (!isInt(lt)) { c.at("E2002", args[0]!, `'${name}' needs an integer type`); return ERROR; }
      if (!same(lt, rt)) { c.at("E2002", args[1]!, `expected '${show(lt)}', got '${show(rt)}'`); return ERROR; }
      return lt;
    }
    case "ok": case "err": { // Q037
      if (!arity(1)) return ERROR;
      if (!want) { c.at("E2006", callee, `cannot infer the Result type of '${name}'`); return ERROR; }
      const parts = resultParts(nonNull(want) ?? want);
      if (!parts) { if (!isErr(want)) c.at("E2002", e, `'${name}(...)' is not a '${show(want)}'`); return ERROR; }
      checkTo(c, args[0]!, name === "ok" ? parts.ok : parts.err);
      return nonNull(want) ?? want;
    }
    case "panic":
      if (arity(1)) checkTo(c, args[0]!, STR);
      return NEVER;
    case "cast": { // §3.2
      if (!c.callAllowed("managed")) c.at("E4001", callee, "'cast' is managed-only");
      if (!arity(1)) return ERROR;
      let t: Type | undefined;
      if (e.typeArguments?.length === 1) t = c.typeOf(e.typeArguments[0]!);
      else if (want) t = resultParts(want)?.ok;
      checkTo(c, args[0]!, UNKNOWN);
      if (!t) { c.at("E2006", callee, "cannot infer the type argument of 'cast'"); return ERROR; }
      if (!isErr(t) && !castable(t)) { c.at("E2002", e.typeArguments?.[0] ?? callee, `'${show(t)}' cannot be checked at run time`); return ERROR; } // Q084
      return result(t, ERROR_RECORD);
    }
    case "requires": case "invariant": case "ensures": {
      if (!arity(1)) return VOID;
      const saved = c.fx.contract;
      if (name !== "invariant") c.fx.contract = { kind: name, depth: c.fx.depth };
      if (name === "ensures") {
        const a = args[0]!;
        const r = c.fx.ret ?? ERROR;
        if (!isFnExpr(a)) c.at("E2002", a, "ensures takes '(r: R) => boolean'");
        else {
          const t = checkArrow(c, a, fn([r], BOOL), false);
          if (!assignable(t, fn([r], BOOL))) c.at("E2002", a, `expected '(r: ${show(r)}) => boolean'`);
        }
      } else checkTo(c, args[0]!, BOOL);
      c.fx.contract = saved;
      return VOID;
    }
    case "test": { // §9.2, Q058
      if (!arity(2)) return VOID;
      if (args[0]!.kind !== K.StringLiteral && args[0]!.kind !== K.NoSubstitutionTemplateLiteral) c.at("E2002", args[0]!, "test name must be a string literal");
      const f = args[1]!;
      if (!isFnExpr(f) || f.parameters.length !== 1) { c.at("E2002", f, "test body must be '(t: Test) => { ... }'"); return VOID; }
      const t = checkArrow(c, f, undefined, true);
      if (!isErr(t.params[0]!) && !same(t.params[0]!, opaque("Test"))) c.at("E2002", f.parameters[0]!.type ?? f, "test body takes 't: Test'");
      return VOID;
    }
  }
  return ERROR;
}

function newExpr(c: Checker, e: ts.NewExpression, want: Type | undefined): Type {
  const id = e.expression;
  if (!isId(id)) { c.at("E2002", id, "'new' needs a class name"); return ERROR; }
  const sym = c.scope.lookup(id.text) ? undefined : c.prog.lookupValue(c.mod, id.text);
  if (sym?.k === "class") {
    const cls = sym.cls;
    const self: Type = { k: "class", cls, args: cls.tparams.map((p) => ({ k: "tparam", p })) };
    return callSig(c, { ...cls.ctor, tparams: cls.tparams, ret: self }, e, id, want);
  }
  if (!sym && (id.text === "Map" || id.text === "Set") && !c.scope.lookup(id.text)) { // Q029
    if (e.arguments?.length) { c.at("E2001", id, `'new ${id.text}' takes no arguments`); return ERROR; }
    const n = id.text === "Map" ? 2 : 1;
    if (e.typeArguments) {
      if (e.typeArguments.length !== n) { c.at("E2002", id, `'${id.text}' takes ${n} type argument(s)`); return ERROR; }
      const targs = e.typeArguments.map((t) => c.typeOf(t));
      if (!keyOk(targs[0]!)) { c.at("E2002", e.typeArguments[0]!, `a ${id.text} ${id.text === "Map" ? "key" : "element"} is a string, number or boolean`); return ERROR; } // Q081
      return gen(id.text, ...targs);
    }
    const w = want && (nonNull(want) ?? want);
    if (w?.k === "gen" && w.name === id.text) return w;
    if (w && isErr(w)) return ERROR;
    c.at("E2006", id, `cannot infer the type arguments of '${id.text}'`);
    return ERROR;
  }
  if (sym) { c.at("E2002", id, `'${id.text}' is not a class`); return ERROR; }
  unresolved(c, id);
  return ERROR;
}

