// P2 expressions (D012): bidirectional checking. `expr(c, e, want)` types `e` with the contextual type `want`
// (numeric literals Q014, string literals Q016, object / array literals Q021, ok / err Q037, generic calls Q030).
import { NodeFlags, SyntaxKind as K, type Node, type ts } from "./parse.ts";
import type { Checker } from "./checker.ts";
import { tparamShells, type FnSym, type Layer, type LocalSym } from "./modules.ts";
import { BUILTIN_FUNCTIONS, GLOBAL_AUTHORITIES, NAMESPACES, RESERVED, genMember, nsMember, opaqueMember, stringMember, type Member } from "./builtins.ts";
import { isDeterministic } from "./determinism.ts";
import {
  BOOL, ERROR, ERROR_RECORD, F64, NEVER, NULL, NUM_NAMES, STR, UNKNOWN, USIZE, VOID, assignable, bindTParams, boxable, field, fn, gen, hasPtr, hasTParam,
  isBool, isCopy, isInt, isNull, isNum, isOwned, isStr, movesLike, ownedDeep, ptrTargetOk, isTaggedUnion, kindOf, literalFits, nonNull, nullable, num, opaque, result, resultParts,
  same, show, subst, unify, union, unref, castable, demand, layerOk, type FnType, type NumName, type Type,
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
/** Type arguments of each call of a generic function, for the C backend's instantiation (D104). */
export const callTArgs = new WeakMap<Node, Type[]>();
/** Q189 (b): what an argument for a function-typed parameter of a strict / rt callee resolved to: a module
 * function, or the caller's own function-typed parameter (by parameter index in the caller's signature).
 * Read by the checker (E4005 per instantiation) and the C backend (the D104 key). */
export type FnArgRef = { fn: FnSym } | { param: number };
export const callFnArgs = new WeakMap<Node, Map<number, FnArgRef>>();
/** Q189 (b): identifiers used as the callee of a call: the one place besides a function-typed argument where a function-typed parameter may appear. */
const fnCalleeIds = new WeakSet<Node>();
/** Q130: the only expressions that may have a Promise type: `await` operands, `Promise.all` arguments, returns of Promise functions. */
export const promiseOk = new WeakSet<Node>();
const optCall = new WeakSet<Node>();
/** Q130: these get their Promise type from a sub-expression, which is the one reported. */
export const PROMISE_CONTAINERS = new Set<K>([K.ObjectLiteralExpression, K.ArrayLiteralExpression, K.ConditionalExpression, K.ParenthesizedExpression, K.BinaryExpression]);
/** Q130: an `await` operand may be a conditional expression whose branches (nested conditionals included) are Promise expressions. */
function allowAwaited(c: Checker, e: Node): void {
  promiseOk.add(e);
  if (e.kind === K.ParenthesizedExpression) allowAwaited(c, (e as ts.ParenthesizedExpression).expression);
  else if (e.kind === K.ConditionalExpression) { allowAwaited(c, (e as ts.ConditionalExpression).whenTrue); allowAwaited(c, (e as ts.ConditionalExpression).whenFalse); }
}
/** A Promise, also inside `| null` or as array elements (`xs.map(g)`). Other holders only get one from a reported expression. */
export function hasPromise(t: Type): boolean {
  if (t.k === "gen") return t.name === "Promise" || ((t.name === "Array" || t.name === "ReadonlyArray") && hasPromise(t.args[0]!));
  return t.k === "union" && t.members.some(hasPromise);
}
/** P3 inputs (D070): the local each identifier names, and the signature each call was checked against. */
export const localOf = new WeakMap<Node, LocalSym>();
export const callSigs = new WeakMap<Node, FnType>();
/** Q042: `panic("...")` literals, the one string strict / rt code may write. Q012: `ensures` arguments, the one function expression. */
const panicLits = new WeakSet<Node>();
const ensuresArgs = new WeakSet<Node>();
export function expr(c: Checker, e: ts.Expression, want?: Type): Type {
  const t = exprUnrecorded(c, e, want);
  exprTypes.set(e, t);
  // E4002 for a value without an annotation (Q027, Q042, Q053); function values are E4003's
  if (c.fx.layer !== "managed" && t.k !== "fn" && !layerOk(t) && !panicLits.has(e)) c.at("E4002", e, `'${show(t)}' cannot be used in ${c.fx.layer} code`);
  if (!promiseOk.has(e) && !PROMISE_CONTAINERS.has(e.kind) && hasPromise(t)) c.at("E2002", e, "a Promise can only be awaited or returned");
  if (t.k === "error") c.firstError ??= { node: e, mod: c.mod };
  return t;
}
function exprUnrecorded(c: Checker, e: ts.Expression, want?: Type): Type {
  switch (e.kind) {
    case K.Identifier: return ident(c, e as ts.Identifier);
    case K.NumericLiteral: return numLit(c, e, numValue(e as ts.NumericLiteral), want);
    case K.StringLiteral: case K.NoSubstitutionTemplateLiteral: return strLit((e as ts.StringLiteral).text, want);
    case K.TrueKeyword: case K.FalseKeyword: return BOOL;
    case K.NullKeyword: return NULL;
    case K.ThisKeyword:
      if (!c.fx.thisType) throw new Error("P2: 'this' without an instance type"); // P1 allows it only where there is one (Q120)
      return c.fx.thisType;
    case K.ParenthesizedExpression:
      if (promiseOk.has(e)) promiseOk.add((e as ts.ParenthesizedExpression).expression);
      return expr(c, (e as ts.ParenthesizedExpression).expression, want);
    case K.TemplateExpression:
      for (const sp of (e as ts.TemplateExpression).templateSpans) {
        const t = expr(c, sp.expression);
        if (!isErr(t) && !isStr(t) && !isNum(t) && !isBool(t)) c.at("E2002", sp.expression, `cannot embed '${show(t)}' in a template`); // Q027
      }
      return STR;
    case K.AwaitExpression: {
      allowAwaited(c, (e as ts.AwaitExpression).expression);
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
  if (local) {
    localOf.set(id, local); contractLocal(c, id, local);
    // Q189 (b): a function-typed parameter of strict / rt code may only be called or passed on as a
    // function-typed argument (callSig intercepts the latter, so it never reaches here)
    if (c.fx.layer !== "managed" && local.param && local.declared.k === "fn" && !fnCalleeIds.has(id))
      c.at("E4003", id, `the function parameter '${name}' can only be called or passed to a function parameter`);
    return c.narrow.get(`${local.id}`) ?? local.type;
  }
  const sym = c.prog.lookupValue(c.mod, name);
  if (sym) {
    switch (sym.k) {
      case "const": return sym.type;
      case "fn": // reached only in value position (calls resolve the callee themselves)
        if (c.fx.layer !== "managed" || sym.layer !== "managed") c.at("E4003", id, `the function '${name}' cannot be used as a value here`); // §2, Q045
        if (c.fx.contract) c.at("E6002", id, `a contract cannot refer to the function value '${name}'`);
        return sym.sig;
      case "cfn": c.at("E4003", id, `the C function '${name}' can only be called`); return sym.sig; // §14.1
      case "class": c.at("E2002", id, `class '${name}' is not a value`); return ERROR;
      case "jsref":
        if (c.fx.contract) c.at("E6002", id, `a contract cannot refer to '${name}'`);
        return opaque("JsRef");
      default: throw new Error(`P2: unexpected symbol kind for '${name}'`);
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
      // writing the tag through the union could flip it under a caller's narrowing (Q122)
      return { kind: "value", type: union(fs.map((f) => f!.type)), readonly: n === "kind" || fs.every((f) => f!.readonly) };
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
/** Q133: the target of an assignment with its parentheses removed. Every reader of assignment targets goes through this. */
export function assignTarget(e: ts.Expression): ts.Expression {
  while (e.kind === K.ParenthesizedExpression) e = (e as ts.ParenthesizedExpression).expression;
  return e;
}

function lvalue(c: Checker, e0: ts.Expression): Type {
  const e = c.assigned(e0).node; // ends the target's narrowings, a `this.f` path included (Q133)
  if (isId(e)) {
    const s = c.scope.lookup(e.text);
    if (s) {
      localOf.set(e, s);
      if (!s.mutable) c.at("E2002", e, `'${e.text}' is const`);
      c.forget(`${s.id}`); // an unstable local has no key above, but is logged all the same
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
    const ctorThis = c.fx.inCtor && c.ctorInits.has(p); // Q121
    if (r.readonly && !ctorThis) { c.at("E2002", p.name, `'${p.name.text}' is readonly`); return ERROR; }
    exprTypes.set(p, r.type); // P3 reads it when the assignment's value is used (Q172)
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
    if (kind === K.AsteriskAsteriskToken && !c.callAllowed("managed")) c.at("E4001", op, "'**' is managed-only"); // Q180: pow is not exact (§10.1)
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
    checkTo(c, b.right, lt); // narrowing by the assignment is a statement's (Checker.assignNarrow, Q133)
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
      const m0 = c.mark();
      const lt = expr(c, b.left);
      if (!isBool(lt) && !isErr(lt)) c.at("E2004", b.left, "operand must be boolean");
      const rt = c.branch(() => expr(c, b.right), c.facts(b.left, k === K.AmpersandAmpersandToken), m0);
      if (!isBool(rt) && !isErr(rt)) c.at("E2004", b.right, "operand must be boolean");
      return BOOL;
    }
    case K.QuestionQuestionToken: {
      const lt = expr(c, b.left);
      if (isErr(lt)) { expr(c, b.right); return ERROR; }
      const inner = nonNull(lt);
      if (!inner) { c.at("E2002", op, "'??' needs a nullable left operand"); return ERROR; }
      const rt = c.branch(() => expr(c, b.right, inner));
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
  throw new Error(`P2: unhandled binary operator ${k}`); // P1 allows only the operators above
}

/** Q017: element types for which `===` works (the `T` of `T | null` counts). */
function eqable(t: Type): boolean {
  const a = nonNull(t) ?? t;
  return isNum(a) || isBool(a) || isStr(a) || a.k === "class";
}

/** Q058: the first argument of `t.traps` is a string literal naming an implemented trap (T001 - T013). */
function trapCode(c: Checker, a: ts.Expression): void {
  const ok = (a.kind === K.StringLiteral || a.kind === K.NoSubstitutionTemplateLiteral) && /^T(00[1-9]|01[0-3])$/.test((a as ts.StringLiteral).text);
  if (!ok) c.at("E2002", a, "the first argument of 'traps' must be a trap code literal \"T001\" - \"T013\"");
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
  const m0 = c.mark();
  cond(c, e.condition);
  const saved = c.narrow, m1 = c.mark();
  const a = c.branch(() => (want ? checkTo(c, e.whenTrue, want) : expr(c, e.whenTrue)), c.facts(e.condition, true), m0, m1);
  c.narrow = saved; // the two branches are alternatives
  const b = c.branch(() => (want ? checkTo(c, e.whenFalse, want) : expr(c, e.whenFalse, deferrable(e.whenFalse) ? sideCtx(a) : undefined)), c.facts(e.condition, false), m0, m1);
  c.restore(saved, m1);
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
    else { // only spreads: the element type comes from the first spread (arrays only, like the loop below)
      const sp = e.elements.find((x) => x.kind === K.SpreadElement) as ts.SpreadElement;
      const st = expr(c, sp.expression);
      if (st.k === "gen" && (st.name === "Array" || st.name === "ReadonlyArray")) elem = st.args[0]!;
      else { if (!isErr(st)) c.at("E2002", sp.expression, `cannot spread '${show(st)}' into an array`); return ERROR; }
    }
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
  if (c.fx.layer !== "managed" && !ensuresArgs.has(e)) c.at("E4003", e, `a function expression cannot be written in ${c.fx.layer} code`); // §2, Q012
  const tps = tparamShells(e.typeParameters, "managed");
  const outerTps = c.fx.tparams;
  c.fx.tparams = new Map([...outerTps, ...tps.map((p) => [p.name, p] as const)]);
  e.typeParameters?.forEach((d, i) => { if (d.constraint) { const t = c.typeOf(d.constraint); if (t.k === "iface") tps[i]!.constraint = t; else if (!isErr(t)) c.at("E2002", d.constraint, "a constraint must be an interface"); } });
  const params = e.parameters.map((p) => {
    if (!p.type) { c.at("E2006", p.name, "parameter needs a type annotation"); return ERROR; }
    c.walkTypePos(p.type, "sig", { unsafe: c.fx.unsafe, cdecl: false });
    return c.typeOf(p.type);
  });
  let ret = e.type ? (c.walkTypePos(e.type, "sig", { unsafe: c.fx.unsafe, cdecl: false }), c.typeOf(e.type, true)) : undefined;
  c.fx.tparams = outerTps;
  if (!ret && want && !inferRet) ret = want.ret;
  const sig = fn(params, ret ?? ERROR, tps);
  const got = c.fnBody(e, sig, { inferRet: !ret });
  return fn(params, ret ?? got, tps);
}

// ---- calls
function call(c: Checker, e: ts.CallExpression, want: Type | undefined): Type {
  // `a?.m(args)`: the arguments may not run (Q133)
  if (e.flags & NodeFlags.OptionalChain && !optCall.has(e)) { optCall.add(e); return c.branch(() => call(c, e, want)); }
  const callee = e.expression;
  if (isId(callee) && !c.scope.lookup(callee.text)) {
    const sym = c.prog.lookupValue(c.mod, callee.text);
    if (!sym && BUILTIN_FUNCTIONS.has(callee.text)) return builtinCall(c, e, callee, want);
    if (sym?.k === "fn") {
      if (!c.callCheck(sym)) c.at("E4001", callee, `a ${c.fx.layer} function cannot call the ${sym.layer} function '${sym.name}'`);
      if (sym.sig.params.some(hasPtr) || hasPtr(sym.sig.ret)) { // §14.4.3: an unsafe operation
        c.noteUnsafeOp(callee);
        if (!c.fx.unsafe) c.at("E4008", callee, `'${sym.name}' has Ptr in its signature; calling it is an unsafe operation`);
      }
      if (c.fx.contract && !isDeterministic(sym.sig, sym.layer === "rt" && sym.unsafe)) c.at("E6002", callee, `a contract can only call deterministic functions ('${sym.name}' is not)`);
      const got = callSig(c, sym.sig, e, callee, want, sym.layer === "managed" ? undefined : sym.layer);
      if (sym.layer !== "managed") c.fnSites.push({ from: c.fn, callee: sym, refs: callFnArgs.get(e) ?? new Map(), node: callee, mod: c.mod }); // Q189 (b): E4005 per instantiation
      return got;
    }
    if (sym?.k === "cfn") { // §14.1 / §14.3: unsafe callers only; rt + unsafe drops the Ffi argument
      c.noteUnsafeOp(callee); // §14.4.2
      if (!c.fx.unsafe) c.at("E4008", callee, `the C function '${sym.name}' can only be called from a function with 'use unsafe'`);
      const sig = c.fx.layer === "rt" ? { ...sym.sig, params: sym.sig.params.slice(1) } : sym.sig;
      return callSig(c, sig, e, callee, want);
    }
    if (sym?.k === "class") { c.at("E2002", callee, `use 'new ${callee.text}(...)'`); return ERROR; }
    if (!sym) { unresolved(c, callee); return ERROR; }
  }
  if (callee.kind === K.PropertyAccessExpression) {
    const p = callee as ts.PropertyAccessExpression;
    const a0 = e.arguments[0];
    if (a0 && isId(p.expression) && p.expression.text === "Promise" && p.name.text === "all" && isNamespace(c, p.expression)) { // Q130
      if (a0.kind === K.CallExpression) promiseOk.add(a0); // an array made right here, such as `xs.map(g)`; a variable or field holding one is rejected
      if (a0.kind === K.ArrayLiteralExpression) for (const x of (a0 as ts.ArrayLiteralExpression).elements) promiseOk.add(x);
    }
    const m = member(c, p, true);
    if (c.fx.layer === "rt") { // E4004: the allocating operations of §3.3
      const rt = exprTypes.get(p.expression);
      const vec = isId(p.expression) && p.expression.text === "Vec" && isNamespace(c, p.expression);
      const pool = isId(p.expression) && p.expression.text === "Pool" && isNamespace(c, p.expression);
      const arena = isId(p.expression) && p.expression.text === "Arena" && isNamespace(c, p.expression);
      if (((vec || pool || arena) && p.name.text === "create") || (rt && unref(rt).k === "gen" && (unref(rt) as { name: string }).name === "Vec" && p.name.text === "push")) c.at("E4004", p.name, `'${p.name.text}' allocates`);
      if (isId(p.expression) && p.expression.text === "Ptr" && isNamespace(c, p.expression) && p.name.text === "box") c.at("E4004", p.name, "'Ptr.box' allocates"); // §14.4
      if (rt && unref(rt).k === "gen" && (unref(rt) as { name: string }).name === "Ptr" && p.name.text === "unbox") c.at("E4004", p.name, "'unbox' allocates"); // §14.4
    }
    if (m.kind === "error") return ERROR;
    if (m.kind === "variadic") { // Math.min / Math.max (Q033)
      if (!e.arguments.length) c.at("E2002", p.name, "expects at least one argument");
      for (const a of e.arguments) checkTo(c, a, F64, true);
      return F64;
    }
    if (m.kind === "method") {
      if ((m.managedOnly || m.layer === "managed") && !c.callAllowed("managed")) c.at("E4001", p.name, `'${p.name.text}' is managed-only`); // Q044
      if (m.sig.tcheck === "trap" && e.arguments[0]) trapCode(c, e.arguments[0]);
      unsafeOp(c, p);
      return callSig(c, m.sig, e, p.name, want);
    }
    if (m.type.k === "fn") return callSig(c, m.type, e, p.name, want);
    if (!isErr(m.type)) c.at("E2002", p.name, `'${show(m.type)}' is not callable`);
    return ERROR;
  }
  if (isId(callee)) fnCalleeIds.add(callee);
  const t = unref(expr(c, callee));
  if (t.k === "fn") {
    const got = callSig(c, t, e, callee, want, c.fx.layer === "managed" ? undefined : c.fx.layer);
    // Q189 (b): a call through a function-typed parameter of the enclosing strict / rt function
    if (c.fx.layer !== "managed" && isId(callee) && c.fn) {
      const idx = c.fn.sig.params.findIndex((p, i) => unref(p).k === "fn" && c.fn!.decl.parameters[i]?.name.kind === K.Identifier && (c.fn!.decl.parameters[i]!.name as ts.Identifier).text === (callee as ts.Identifier).text);
      if (idx >= 0) c.fnSites.push({ from: c.fn, callee: idx, refs: callFnArgs.get(e) ?? new Map(), node: callee, mod: c.mod });
    }
    return got;
  }
  if (!isErr(t)) c.at("E2002", callee, `'${show(t)}' is not callable`);
  return ERROR;
}

/** A call against a signature, inferring type arguments (Q014, Q030): plain arguments, then arrows, then the context, then literals. */
function callSig(c: Checker, sig: FnType, e: ts.CallExpression | ts.NewExpression, anchor: Node, want: Type | undefined, q189?: Layer): Type {
  const args = e.arguments ?? ([] as unknown as ts.NodeArray<ts.Expression>);
  callSigs.set(e, sig);
  const min = sig.min ?? sig.params.length;
  if (args.length < min || args.length > sig.params.length) {
    c.at("E2002", anchor, `expects ${min === sig.params.length ? min : `${min}-${sig.params.length}`} argument(s), got ${args.length}`);
    return ERROR;
  }
  const ids = new Set(sig.tparams.map((p) => p.id));
  const m = new Map<number, Type>();
  if (e.typeArguments) for (const t of e.typeArguments) c.walkTypePos(t, "typearg", { unsafe: c.fx.unsafe, cdecl: false }); // §14.4
  if (e.typeArguments) {
    if (e.typeArguments.length !== sig.tparams.length) { c.at("E2002", anchor, `expects ${sig.tparams.length} type argument(s)`); return ERROR; }
    sig.tparams.forEach((p, i) => m.set(p.id, c.typeOf(e.typeArguments![i]!)));
  }
  const open = (t: Type): boolean => hasTParam(subst(t, m), ids);
  const later: (Type | undefined)[] = [];
  const done: boolean[] = [];
  // Q189 (b): arguments for function-typed parameters are not values. They are resolved here, before the
  // generic passes, and checked for an exact type match once type arguments are known.
  const fnChecks: { a: ts.Expression; t: Type; i: number }[] = [];
  if (q189) {
    const refs = new Map<number, FnArgRef>();
    args.forEach((a, i) => {
      const p = sig.params[i]!;
      if (unref(p).k !== "fn") return;
      done[i] = true;
      const r = fnArgRef(c, a, q189);
      if (!r) return;
      refs.set(i, r.ref);
      fnChecks.push({ a, t: r.t, i });
      unify(unref(p), r.t, m, ids);
    });
    if (refs.size) callFnArgs.set(e, refs);
  }
  args.forEach((a, i) => { // 1: arguments that do not need context
    if (done[i]) return; // Q189 (b): function-typed arguments were resolved by the pre-pass
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
  if ((tc === "cast" || tc === "eq" || tc === "copy" || tc === "box" || tc === "chandle" || tc === "castptr") && sig.tparams[0]) { // Q084, Q086; §14.4 / §14.5
    const b = m.get(sig.tparams[0].id)!;
    if (tc === "box") { // the anchor is the type argument, or the boxed value (DIAGNOSTICS E4007)
      if (!isErr(b) && !boxable(b)) { c.at("E4007", e.typeArguments?.[0] ?? args[1] ?? anchor, `'${show(b)}' cannot be boxed`); return ERROR; }
    } else if (tc === "chandle") {
      if (!isErr(b) && (b.k === "fn" || hasPtr(b))) { c.at("E4008", e.typeArguments?.[0] ?? anchor, `'${show(b)}' cannot sit inside CHandle`); return ERROR; }
      if (!isErr(b) && !ptrTargetOk(b)) { c.at("E4007", e.typeArguments?.[0] ?? anchor, `'${show(b)}' cannot sit inside CHandle`); return ERROR; }
    } else if (tc === "castptr") {
      if (!isErr(b) && (b.k === "fn" || !ptrTargetOk(b))) { c.at("E2001", e.typeArguments?.[0] ?? anchor, `cannot cast a pointer to '${show(b)}'`); return ERROR; }
    } else if (!isErr(b) && !(tc === "cast" ? castable(b) : demand(b, tc))) {
      c.at(tc === "copy" ? "E4002" : "E2002", e.typeArguments?.[0] ?? anchor, `'${show(b)}' is not allowed as the type argument here`); // Q086: `Vec.create` is §3.3
      return ERROR;
    }
  }
  args.forEach((a, i) => {
    const t = later[i];
    if (!t || isErr(t)) return;
    const p = unref(subst(sig.params[i]!, m));
    if (!assignable(t, p, true)) c.at("E2002", a, `expected '${show(p)}', got '${show(t)}'`);
  });
  for (const { a, t, i } of fnChecks) { // Q189 (b): parameter and return types must match exactly
    const p = unref(subst(sig.params[i]!, m));
    if (p.k === "fn" && t.k === "fn" && !same(p, t)) c.at("E2002", a, `expected '${show(p)}', got '${show(t)}'`);
  }
  sig.tparams.forEach((p, i) => c.prog.insts.push({ mod: c.mod, node: e.typeArguments?.[i] ?? anchor, p, arg: m.get(p.id)! })); // Q127
  callTArgs.set(e, sig.tparams.map((p) => m.get(p.id)!));
  return subst(sig.ret, m);
}

/** Q189 (b): resolves one argument of a function-typed parameter. `target` is the layer of the function
 * whose parameter it is: an rt parameter takes rt functions only, a strict one strict or rt (E4001).
 * A forwarded parameter of the caller may hold what the caller's own layer allows, so forwarding a
 * strict parameter into an rt parameter is E4001 too (Q212). Anything else is E4003. */
function fnArgRef(c: Checker, a: ts.Expression, target: Layer): { ref: FnArgRef; t: Type } | undefined {
  if (isId(a)) {
    const local = c.scope.lookup(a.text);
    if (local?.param && local.declared.k === "fn" && c.fx.layer !== "managed" && c.fn) {
      if (target === "rt" && c.fx.layer !== "rt")
        c.at("E4001", a, `a ${c.fx.layer} function parameter cannot be passed to an rt function parameter`);
      const idx = c.fn.sig.params.findIndex((p, i) => unref(p).k === "fn" && c.fn!.decl.parameters[i]?.name.kind === K.Identifier && (c.fn!.decl.parameters[i]!.name as ts.Identifier).text === a.text);
      if (idx >= 0) return { ref: { param: idx }, t: local.declared };
    } else if (!local) {
      const sym = c.prog.lookupValue(c.mod, a.text);
      if (sym?.k === "fn") {
        if (sym.sig.tparams.length) { c.at("E4003", a, `the generic function '${sym.name}' cannot be used as a function argument`); return undefined; }
        if (sym.layer === "rt" && sym.unsafe) { c.at("E4001", a, `the rt + unsafe function '${sym.name}' can only be passed to 'cfn'`); return undefined; } // §14.6
        if (sym.layer === "managed" || (target === "rt" && sym.layer !== "rt"))
          c.at("E4001", a, `a ${target} function parameter cannot take the ${sym.layer} function '${sym.name}'`);
        return { ref: { fn: sym }, t: sym.sig };
      }
    }
  }
  c.at("E4003", a, "a function argument must be the name of a module-level strict / rt function or a function parameter of the caller");
  return undefined;
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
    case "cfn": { // §14.6: the name of a module-level rt function, as a Ptr to it
      c.noteUnsafeOp(callee); // §14.4.4
      if (!c.fx.unsafe) c.at("E4008", callee, "'cfn' can only be used in a function with 'use unsafe'");
      if (!arity(1)) return ERROR;
      const a = args[0]!;
      const pointeeOk = (t: Type): boolean => {
        const x = t.k === "gen" ? t.args[0]! : undefined;
        if (!x) return true;
        if (x.k === "num" && x.name === "usize") return false;
        return x.k === "gen" && (x.name === "Ptr" || x.name === "ConstPtr") ? pointeeOk(x) : true;
      };
      const boundary = (t: Type): boolean =>
        t.k === "num" || isBool(t) || (t.k === "gen" && (t.name === "Ptr" || t.name === "ConstPtr") && pointeeOk(t));
      if (!isId(a) || c.scope.lookup(a.text)) { c.at("E4003", a, "'cfn' takes the name of a module-level rt function"); return ERROR; }
      const sym = c.prog.lookupValue(c.mod, a.text);
      if (sym?.k !== "fn") { c.at("E4003", a, "'cfn' takes the name of a module-level rt function"); return ERROR; }
      if (sym.sig.tparams.length) { c.at("E4003", a, `'cfn' cannot take the generic function '${sym.name}'`); return ERROR; }
      if (sym.layer !== "rt") { c.at("E4001", a, `'cfn' takes an rt function, not the ${sym.layer} function '${sym.name}'`); return ERROR; }
      if (sym.sig.params.some((p) => !boundary(p)) || !(boundary(sym.sig.ret) || (sym.sig.ret.k === "prim" && sym.sig.ret.name === "void"))) {
        c.at("E4007", a, `the signature of '${sym.name}' cannot cross the C boundary`);
        return ERROR;
      }
      return gen("Ptr", sym.sig);
    }
    case "panic":
      if (args[0]?.kind === K.StringLiteral || args[0]?.kind === K.NoSubstitutionTemplateLiteral) panicLits.add(args[0]); // Q042
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
      if (!isErr(t) && !castable(t) && !ownedDeep(t)) { c.at("E2002", e.typeArguments?.[0] ?? callee, `'${show(t)}' cannot be checked at run time`); return ERROR; } // Q084
      return result(t, ERROR_RECORD);
    }
    case "requires": case "invariant": case "ensures": {
      if (!arity(1)) return VOID;
      const saved = c.fx.contract;
      if (name !== "invariant") c.fx.contract = { kind: name, depth: c.fx.depth };
      if (name === "ensures") {
        const a = args[0]!;
        const r = c.fx.ret ?? ERROR;
        const pred = r.k === "prim" && r.name === "void" ? fn([], BOOL) : fn([r], BOOL); // Q129: a void function's ensures takes no argument
        if (!isFnExpr(a)) c.at("E2002", a, `ensures takes '${show(pred)}'`);
        else {
          ensuresArgs.add(a);
          const t = checkArrow(c, a, pred, false);
          if (!assignable(t, pred)) c.at("E2002", a, `expected '${show(pred)}'`);
        }
      } else checkTo(c, args[0]!, BOOL);
      c.fx.contract = saved;
      observeOnly(c, args[0]!);
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
  throw new Error(`P2: unhandled builtin '${name}'`);
}

/** Builtin methods that change their receiver or the outside world (§3.3, §7.1, §7.4, §12). */
const MUTATORS = new Set(["push", "pop", "reverse", "sort", "fill", "set", "delete", "clear", "add", "take", "put", "info", "warn", "error", "writeText", "nextF64", "nextU32", "call", "await", "advance"]);
/** Q134: a contract only observes. Assignments and mutating builtin calls inside it are E6002; user calls are not analysed. */
function observeOnly(c: Checker, root: Node): void {
  const walk = (n: Node): void => {
    if (n.kind === K.BinaryExpression && (COMPOUND[(n as ts.BinaryExpression).operatorToken.kind] !== undefined || (n as ts.BinaryExpression).operatorToken.kind === K.EqualsToken)) {
      c.at("E6002", n, "a contract cannot assign");
    } else if ((n.kind === K.PrefixUnaryExpression || n.kind === K.PostfixUnaryExpression) && [K.PlusPlusToken, K.MinusMinusToken].includes((n as ts.PrefixUnaryExpression).operator)) {
      c.at("E6002", n, "a contract cannot assign");
    } else if (n.kind === K.CallExpression && (n as ts.CallExpression).expression.kind === K.PropertyAccessExpression) {
      const p = (n as ts.CallExpression).expression as ts.PropertyAccessExpression;
      const recv = exprTypes.get(p.expression);
      const builtin = !recv || unref(nonNull(recv) ?? recv).k !== "class"; // a namespace (`Vec`, `Math`) has no type here
      if (builtin && MUTATORS.has(p.name.text)) c.at("E6002", p.name, `a contract cannot call '${p.name.text}'`);
    }
    const sig = n.kind === K.CallExpression || n.kind === K.NewExpression ? callSigs.get(n) : undefined;
    (n as ts.CallExpression).arguments?.forEach((a, i) => { // Q175: a contract neither consumes nor mutably borrows
      const p = sig?.params[i];
      if (!p) return;
      const mode = p.k === "gen" && (p.name === "Ref" || p.name === "Mut") ? p.name : undefined;
      if (mode === "Mut" || (!mode && movesLike(unref(exprTypes.get(a) ?? ERROR)))) c.at("E6002", a, mode ? "a contract cannot pass a Mut borrow" : "a contract cannot move a value");
    });
    n.forEachChild(walk);
  };
  walk(root);
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
      for (const t of e.typeArguments) c.walkTypePos(t, "typearg", { unsafe: c.fx.unsafe, cdecl: false }); // §14.4
      const targs = e.typeArguments.map((t) => c.typeOf(t));
      if (!demand(targs[0]!, "key")) { c.at("E2002", e.typeArguments[0]!, `a ${id.text} ${id.text === "Map" ? "key" : "element"} is a string, number, boolean or string literal union`); return ERROR; } // Q081
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


/** §14.4 / §14.5: the unsafe operations reached through a member call. `Ptr.box`, `CHandle.create`,
 * and every Ptr / ConstPtr / CHandle member need an unsafe function (E4008, anchor: the member name);
 * which Ptr members a pointee type allows is the §14.4 table (E2001, anchor: the member name). */
function unsafeOp(c: Checker, p: ts.PropertyAccessExpression): void {
  const name = p.name.text;
  const recvNode = p.expression;
  if (isId(recvNode) && isNamespace(c, recvNode) && (recvNode.text === "Ptr" || recvNode.text === "CHandle")) {
    c.noteUnsafeOp(p.name); // §14.4.4: Ptr.box, CHandle.create
    if (!c.fx.unsafe) c.at("E4008", p.name, `'${recvNode.text}.${name}' can only be used in a function with 'use unsafe'`);
    return;
  }
  const rt = exprTypes.get(recvNode);
  const recv = rt ? unref(rt) : undefined;
  if (recv?.k !== "gen" || (recv.name !== "Ptr" && recv.name !== "ConstPtr" && recv.name !== "CHandle")) return;
  c.noteUnsafeOp(p.name); // §14.4.4: a member of Ptr / ConstPtr / CHandle
  if (!c.fx.unsafe) { c.at("E4008", p.name, `'${name}' can only be used in a function with 'use unsafe'`); return; }
  if (recv.name === "CHandle") return;
  const T = recv.args[0]!;
  const bad = (): void => c.at("E2001", p.name, `'${name}' cannot be used on '${show(recv)}'`);
  switch (name) {
    case "isNull": case "cast": return; // cast's target is callSig's `castptr` check
    case "read": case "write": case "offset": case "slice":
      if (T.k === "tparam") { demand(T, "copy"); return; }
      if (!isCopy(T)) bad();
      return;
    case "borrow": if (!movesLike(T)) bad(); return;
    case "unbox": if (!boxable(T)) bad(); return;
  }
}
