// P2 expressions (D012): bidirectional checking. `expr(c, e, want)` types `e` with the contextual type `want`
// (numeric literals Q014, string literals Q016, object / array literals Q021, ok / err Q037, generic calls Q030).
import { NodeFlags, SyntaxKind as K, isId, type Node, type ts } from "./parse.ts";
import type { Checker } from "./checker.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { tparamShells, type FnSym, type Layer, type LocalSym, type ValueSym } from "./modules.ts";
import { BUILTIN_FUNCTIONS, GLOBAL_AUTHORITIES, NAMESPACES, RESERVED, contractBanned, genMember, genMembers, nsMember, nsMembers, opaqueMember, opaqueMembers, stringMember, stringMembers, type Member } from "./builtins.ts";
import { isDeterministic } from "./determinism.ts";
import { isGeneratable } from "./gendesc.ts";
import {
  AUDIO_CONFIG_RECORD, BOOL, ERROR, ERROR_RECORD, F64, NEVER, NULL, NUM_NAMES, STR, UNKNOWN, USIZE, VOID, assignable, audioStateOk, bindTParams, borrowOk, boxable, comparable, field, fn, gen, hasArenaBuf, hasAuthority, hasCap, hasInt64, hasLayout, hasPtr, hasRawPtr, hasTParam,
  isAuthority, isBool, isCopy, isInt, isInt64, isNative, isNull, isNum, isOwned, isOwnedCap, isStr, movesLike, holdsOwned, ownedDeep, ptrTargetOk, isTaggedUnion, kindOf, keyOk, intLiteralFits, literalFits, nonNull, nullable, num, opaque, parseExactInt, result, resultParts, restElem,
  same, sendable, show, subst, tparamHasCap, unify, union, unref, castable, collectTParams, layerOk, type ClassSym, type FnType, type NumName, type Type,
  hasLoneSurrogate,
} from "./types.ts";

const isErr = (t: Type): boolean => t.k === "error";
const hasErr = (t: Type): boolean =>
  t.k === "error" || (t.k === "record" && t.fields.some((f) => hasErr(f.type))) || (t.k === "union" && t.members.some(hasErr)) ||
  (t.k === "tuple" && t.elems.some(hasErr)) || (t.k === "fn" && (t.params.some(hasErr) || hasErr(t.ret))) ||
  ((t.k === "gen" || t.k === "class" || t.k === "iface") && t.args.some(hasErr));

/** A numeric expression made only of literals (Q014): it takes the type of its context. */
export function isLitOnly(e: ts.Expression): boolean {
  switch (e.kind) {
    case K.NumericLiteral: return true;
    case K.ParenthesizedExpression: return isLitOnly((e as ts.ParenthesizedExpression).expression);
    case K.PrefixUnaryExpression: {
      const u = e as ts.PrefixUnaryExpression;
      return (u.operator === K.MinusToken || u.operator === K.TildeToken) && isLitOnly(u.operand);
    }
    case K.BinaryExpression: {
      const b = e as ts.BinaryExpression;
      return (ARITH.has(b.operatorToken.kind) || BIT_OPS.has(b.operatorToken.kind)) && isLitOnly(b.left) && isLitOnly(b.right);
    }
  }
  return false;
}
const ARITH = new Set<K>([K.PlusToken, K.MinusToken, K.AsteriskToken, K.SlashToken, K.PercentToken, K.AsteriskAsteriskToken]);
const COMPOUND: Partial<Record<K, K>> = {
  [K.PlusEqualsToken]: K.PlusToken, [K.MinusEqualsToken]: K.MinusToken, [K.AsteriskEqualsToken]: K.AsteriskToken,
  [K.SlashEqualsToken]: K.SlashToken, [K.PercentEqualsToken]: K.PercentToken, [K.AsteriskAsteriskEqualsToken]: K.AsteriskAsteriskToken,
  [K.AmpersandEqualsToken]: K.AmpersandToken, [K.BarEqualsToken]: K.BarToken, [K.CaretEqualsToken]: K.CaretToken,
  [K.LessThanLessThanEqualsToken]: K.LessThanLessThanToken, [K.GreaterThanGreaterThanEqualsToken]: K.GreaterThanGreaterThanToken, [K.GreaterThanGreaterThanGreaterThanEqualsToken]: K.GreaterThanGreaterThanGreaterThanToken,
};
const BIT_OPS = new Set<K>([
  K.AmpersandToken, K.BarToken, K.CaretToken,
  K.LessThanLessThanToken, K.GreaterThanGreaterThanToken, K.GreaterThanGreaterThanGreaterThanToken,
]);
/** Operands typed from the other side (literals, string literals, null). */
const deferrable = (e: ts.Expression): boolean => isLitOnly(e) || e.kind === K.StringLiteral || e.kind === K.NullKeyword || e.kind === K.NoSubstitutionTemplateLiteral;
const isResultCtorCall = (e: ts.Expression): boolean => {
  if (e.kind !== K.CallExpression) return false;
  const cal = (e as ts.CallExpression).expression;
  if (cal.kind !== K.PropertyAccessExpression) return false;
  const p = cal as ts.PropertyAccessExpression;
  return isId(p.expression) && p.expression.text === "Result" && (p.name.text === "ok" || p.name.text === "err");
};
/** Arguments that need their parameter type before they can be typed (Q030). */
const ctxSensitive = (e: ts.Expression): boolean => deferrable(e) || e.kind === K.ObjectLiteralExpression || e.kind === K.ArrayLiteralExpression || isResultCtorCall(e);
const isFnExpr = (e: ts.Expression): e is ts.ArrowFunction | ts.FunctionExpression => e.kind === K.ArrowFunction || e.kind === K.FunctionExpression;

/** The numeric type a literal takes from `want` (also `N | null`). */
function numCtx(want: Type | undefined): Type | undefined {
  if (!want) return undefined;
  if (want.k === "num") return want;
  const nn = nonNull(want);
  return nn?.k === "num" ? nn : undefined;
}
const sideCtx = (t: Type): Type => nonNull(t) ?? t;

function attachConvertFix(c: Checker, e: ts.Expression, t: Type, want: Type): void {
  if (t.k !== "num" || want.k !== "num" || t.name === want.name) return;
  const d = c.prog.rep.out.at(-1);
  if (d?.code !== "E2002" || attachLitLetFix(c, d, e, want)) return;
  const sf = c.fx.mod.sf;
  const s = e.getStart(sf);
  d.fixes = [{
    title: `convert to '${want.name}'`,
    edits: [{ range: { start: c.fx.mod.pf.position(s), end: c.fx.mod.pf.position(e.end) }, newText: `${want.name}(${sf.text.slice(s, e.end)})` }],
  }];
}

export function checkTo(c: Checker, e: ts.Expression, want: Type, arg = false): Type {
  const t = expr(c, e, want);
  if (!assignable(t, want, arg)) {
    c.at("E2002", e, `expected '${show(want)}', got '${show(t)}'`, { expected: show(want), actual: show(t) });
    attachConvertFix(c, e, t, want);
    return ERROR;
  }
  return t;
}
function attachNonNullCondFix(c: Checker, e: ts.Expression, t: Type): void {
  const nn = nonNull(t);
  if (!nn || isBool(nn)) return;
  const d = c.prog.rep.out.at(-1);
  if (d?.code !== "E2004") return;
  const sf = c.fx.mod.sf, s = e.getStart(sf), txt = sf.text.slice(s, e.end);
  const wrapped = e.kind === K.BinaryExpression || e.kind === K.ConditionalExpression ? `(${txt})` : txt;
  d.fixes = [{
    title: "compare with '!== null'",
    edits: [{ range: { start: c.fx.mod.pf.position(s), end: c.fx.mod.pf.position(e.end) }, newText: `${wrapped} !== null` }],
  }];
}

/** E2004: conditions are boolean only (§3.1). */
export function cond(c: Checker, e: ts.Expression): void {
  const t = expr(c, e);
  if (!isBool(t) && !isErr(t)) {
    c.at("E2004", e, `condition must be boolean, got '${show(t)}'`, { actual: show(t) });
    attachNonNullCondFix(c, e, t);
  }
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
/** A call whose callee name resolves to a module-level function (not shadowed by a local), with that function. */
export const callFns = new WeakMap<Node, FnSym>();
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
  if (t.k === "tuple") return t.elems.some(hasPromise);
  return t.k === "union" && t.members.some(hasPromise);
}
/** P3 inputs (D070): the local each identifier names, and the signature each call was checked against. */
export const localOf = new WeakMap<Node, LocalSym>();
export const callSigs = new WeakMap<Node, FnType>();
/** Initializers of `using` declarations: the one position `Resource.own` / `Resource.ownWith` may be called (SPEC-v1 §5). */
export const usingInitExprs = new WeakSet<Node>();
export interface ResourceMeta { kind: "own" | "ownWith"; valType: Type; ctxType?: Type; cleanupFn?: FnSym }
/** Resolved metadata for `Resource.own` / `Resource.ownWith` calls, read by JS and C/Wasm emitters. */
export const resourceCalls = new WeakMap<ts.CallExpression, ResourceMeta>();
/** Q042: `panic("...")` literals, the one string strict / rt code may write. Q012: `ensures` arguments, the one function expression. */
const panicLits = new WeakSet<Node>();
export const ensuresArgs = new WeakSet<Node>();
export function expr(c: Checker, e: ts.Expression, want?: Type): Type {
  const t = exprUnrecorded(c, e, want);
  exprTypes.set(e, t);
  // E4002 for a value without an annotation (Q027, Q042, Q053); function values are E4003's; Resource binding allowed as using init
  if (c.fx.layer !== "managed" && t.k !== "fn" && !(t.k === "resource" && usingInitExprs.has(e)) && !layerOk(t) && !panicLits.has(e)) c.at("E4002", e, `'${show(t)}' cannot be used in ${c.fx.layer} code`);
  if (!promiseOk.has(e) && !PROMISE_CONTAINERS.has(e.kind) && hasPromise(t)) c.at("E2002", e, "a Promise can only be awaited or returned");
  if (t.k === "error") c.firstError ??= { node: e, mod: c.mod };
  return t;
}
function exprUnrecorded(c: Checker, e: ts.Expression, want?: Type): Type {
  switch (e.kind) {
    case K.Identifier: return ident(c, e as ts.Identifier);
    case K.NumericLiteral: return numLit(c, e, e as ts.NumericLiteral, false, want);
    case K.StringLiteral: case K.NoSubstitutionTemplateLiteral: return strLit((e as ts.StringLiteral).text, want);
    case K.TrueKeyword: case K.FalseKeyword: return BOOL;
    case K.NullKeyword: return NULL;
    case K.RegularExpressionLiteral:
      if (c.fx.layer !== "managed") {
        c.at("E4001", e, "regular expression literals are managed-only", { callerLayer: c.fx.layer, calleeLayer: "managed" });
        return ERROR;
      }
      return opaque("RegExp");
    case K.ThisKeyword:
      return c.fx.thisType ?? ERROR; // P1 rejects 'this' outside an instance method
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
      const w = want && unref(nonNull(want) ?? want);
      return checkArrow(c, e as ts.ArrowFunction, w?.k === "fn" ? w : undefined, false);
    }
    case K.AsExpression: case K.NonNullExpression: case K.SatisfiesExpression:
      expr(c, (e as ts.AsExpression | ts.NonNullExpression | ts.SatisfiesExpression).expression);
      return ERROR;
    case K.PostfixUnaryExpression:
      return incDec(c, e as ts.PostfixUnaryExpression);
  }
  return ERROR; // P1 rejects every other kind
}

const numValue = (n: ts.NumericLiteral): number => Number(n.text.replace(/_/g, ""));

function numLit(c: Checker, anchor: Node, lit: ts.NumericLiteral, neg: boolean, want: Type | undefined): Type {
  const t = (numCtx(want) ?? F64) as { k: "num"; name: NumName };
  if (isInt(t)) {
    const raw = lit.getText(c.fx.mod.sf);
    const v = parseExactInt(raw, neg);
    if (!intLiteralFits(v, t.name)) {
      const shown = v !== null ? String(v) : `${neg ? "-" : ""}${raw}`;
      c.at("E2008", anchor, `literal ${shown} does not fit '${t.name}'`, { value: shown, type: t.name });
    }
    return t;
  }
  const value = neg ? -numValue(lit) : numValue(lit);
  if (!literalFits(value, t.name)) c.at("E2008", anchor, `literal ${value} does not fit '${t.name}'`, { value: String(value), type: t.name });
  return t;
}

function strLit(value: string, want: Type | undefined): Type {
  const w = want && (nonNull(want) ?? want);
  const lits = w && (w.k === "lit" || (w.k === "union" && w.members.some((m) => m.k === "lit")));
  return lits && !hasLoneSurrogate(value) ? { k: "lit", value } : STR; // Q238
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
      case "cconst":
        c.noteUnsafeOp(id);
        if (!c.fx.unsafe) c.at("E4008", id, `the C constant '${name}' can only be read in a function with 'use unsafe'`);
        if (c.fx.contract) c.at("E6002", id, `a contract cannot refer to the C constant '${name}'`);
        return sym.type;
      case "fn": // reached only in value position (calls resolve the callee themselves)
        if (c.fx.layer !== "managed" || sym.layer !== "managed") c.at("E4003", id, `the function '${name}' cannot be used as a value here`); // §2, Q045
        if (c.fx.contract) c.at("E6002", id, `a contract cannot refer to the function value '${name}'`);
        return sym.sig;
      case "cfn": c.at("E4003", id, `the C function '${name}' can only be called`); return sym.sig; // §14.1
      case "class": c.at("E2002", id, `class '${name}' is not a value`); return ERROR;
      case "jsref":
        if (c.fx.contract) c.at("E6002", id, `a contract cannot refer to '${name}'`);
        return opaque("JsRef");
      case "error": return ERROR;
      default: throw new Error(`P2: unexpected symbol kind for '${name}'`);
    }
  }
  const ns = c.mod.nsImports.get(name);
  if (ns) {
    c.at("E2002", id, ns.typeOnly ? `'${name}' is type-only and cannot be used as a value` : `module namespace '${name}' can only be used as a member access receiver`, { name });
    return ERROR;
  }
  if (c.prog.isTypeOnlyValue(c.mod, name)) {
    c.at("E2002", id, `'${name}' is type-only and cannot be used as a value`, { kind: "type-only", name });
    return ERROR;
  }
  unresolved(c, id);
  return ERROR;
}

/** E2000 / E5001 for a name that is not declared (Q006, Q011, Q034). */
function unresolved(c: Checker, id: ts.Identifier): void {
  const name = id.text;
  if (GLOBAL_AUTHORITIES.has(name)) {
    const fix = c.authorityFix(name, id);
    c.at("E5001", id, `'${name}' is a global authority; take it as a parameter`, { name, ...(fix ? { authority: fix.authority } : {}) });
    if (fix?.fixes) c.prog.rep.out.at(-1)!.fixes = fix.fixes;
    return;
  }
  if (name === "Resource") { c.at("E2002", id, "'Resource' is a namespace", { name }); return; }
  if (name === "Result") { c.at("E2002", id, "'Result' is a namespace", { name }); return; }
  if (name === "ok" || name === "err") { c.at("E2000", id, `unknown name '${name}'; use 'Result.${name}(...)'`, { name }); return; }
  if (NAMESPACES.has(name) && !RESERVED.has(name)) { c.at("E2000", id, `'${name}' can only be used as a member access receiver`, { name }); return; }
  if (BUILTIN_FUNCTIONS.has(name)) { c.at("E2002", id, `builtin '${name}' can only be called`, { name }); return; }
  c.at("E2000", id, `unknown name '${name}'`, { name });
}

/** E6002 (Q056): what a contract may refer to. */
function contractLocal(c: Checker, id: ts.Identifier, s: LocalSym): void {
  const k = c.fx.contract;
  if (!k || k.kind === "invariant" || s.fnDepth > k.depth) return; // declared inside the contract expression (e.g. the `r` of ensures)
  const ok = s.param && s.fnDepth === k.depth && (k.kind === "requires" || !movesLike(s.declared));
  if (!ok) c.at("E6002", id, `a contract cannot refer to '${s.name}'`);
}

// ---- members
type MemberResult = { kind: "value"; type: Type; readonly: boolean; optRaw?: Type } | { kind: "method"; sig: FnType; managedOnly?: boolean; layer?: Layer } | { kind: "variadic" } | { kind: "error" };
const MERR: MemberResult = { kind: "error" };

/** True when `id` names a builtin namespace object, not shadowed by a declaration. */
const isNamespace = (c: Checker, id: ts.Identifier): boolean => NAMESPACES.has(id.text) && !c.scope.lookup(id.text) && !c.prog.lookupValue(c.mod, id.text) && !c.mod.nsImports.has(id.text) && !c.prog.isTypeOnlyValue(c.mod, id.text);

const lookupNs = (c: Checker, id: ts.Identifier) =>
  !c.scope.lookup(id.text) ? c.mod.nsImports.get(id.text) : undefined;

function classStaticMember(c: Checker, cls: ClassSym, name: ts.Identifier, inCall: boolean): MemberResult {
  const f = cls.fields.get(name.text), me = cls.methods.get(name.text);
  if (f?.static && (!f.private || c.fx.cls === cls)) return { kind: "value", type: f.type, readonly: f.readonly };
  if (me?.static && (!me.private || c.fx.cls === cls)) return inCall ? { kind: "method", sig: me.sig, layer: "managed" } : (c.at("E2002", name, "a method can only be called"), MERR);
  c.at("E2002", name, `'${cls.name}' has no static member '${name.text}'`);
  return MERR;
}

function lookupModuleFn(c: Checker, e: ts.Expression): { sym?: FnSym; nonFn?: ValueSym; typeOnly?: string; missingProp?: ts.PropertyAccessExpression } {
  if (isId(e)) {
    if (c.scope.lookup(e.text)) return {};
    const sym = c.prog.lookupValue(c.mod, e.text);
    if (sym) return sym.k === "fn" ? { sym } : { nonFn: sym };
    if (c.prog.isTypeOnlyValue(c.mod, e.text)) return { typeOnly: e.text };
    return {};
  }
  if (e.kind === K.PropertyAccessExpression) {
    const p = e as ts.PropertyAccessExpression;
    if (!isId(p.expression)) return {};
    const ns = lookupNs(c, p.expression);
    if (!ns) return {};
    if (p.questionDotToken) return { missingProp: p };
    if (ns.typeOnly) return { typeOnly: p.expression.text };
    const sym = c.prog.lookupExportedValue(ns.mod, p.name.text);
    if (sym) return sym.k === "fn" ? { sym } : { nonFn: sym };
    if (c.prog.isExportedTypeOnly(ns.mod, p.name.text)) return { typeOnly: p.name.text };
    return { missingProp: p };
  }
  return {};
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! : 1 + Math.min(prev[j]!, cur[j - 1]!, prev[j - 1]!);
    }
    prev = cur;
  }
  return prev[n]!;
}

function suggestMembers(query: string, candidates: readonly string[]): string[] {
  const q = query.toLowerCase();
  return candidates
    .map((name) => {
      const nl = name.toLowerCase();
      const dist = levenshtein(q, nl);
      const pref = q.length >= 2 && (nl.startsWith(q) || q.startsWith(nl));
      return { name, dist, pref };
    })
    .filter((x) => x.dist <= 2 || x.pref)
    .sort((a, b) => a.dist - b.dist || (a.pref === b.pref ? 0 : a.pref ? -1 : 1) || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((x) => x.name);
}

const didYouMean = (suggestions: readonly string[]): string =>
  suggestions.length ? ` (did you mean ${suggestions.map((s) => `'${s}'`).join(", ")}?)` : "";

function reportUnknownBuiltinMember(c: Checker, name: ts.Identifier, t: Type, available: readonly string[]): MemberResult {
  const n = name.text;
  const recv = show(t);
  if (t.k === "gen" && (t.name === "Array" || t.name === "ReadonlyArray") && n === "at") {
    c.at("E2001", name, `'${recv}' has no member 'at'; use indexing '[i]' and 'length'`, { receiver: recv, member: n, suggestions: ["[i]", "length"] });
    return MERR;
  }
  if (t.k === "gen" && (t.name === "Vec" || t.name === "Slice") && n === "slice") {
    c.at("E2001", name, `'${recv}' has no member 'slice'; use 'borrowSlice(a, b)' (returns a borrowed Slice, arg/recv only)`, { receiver: recv, member: n, suggestions: ["borrowSlice"] });
    return MERR;
  }
  if (isStr(t)) {
    if (n === "replace") {
      c.at("E2001", name, `'${recv}' has no member 'replace'; use 'replaceAll()'`, { receiver: recv, member: n, suggestions: ["replaceAll"] });
      return MERR;
    }
    if (n === "substring" || n === "substr") {
      c.at("E2001", name, `'${recv}' has no member '${n}'; use 'slice()'`, { receiver: recv, member: n, suggestions: ["slice"] });
      return MERR;
    }
    if (n === "charAt") {
      c.at("E2001", name, `'${recv}' has no member 'charAt'; use 'slice(i, i + 1)' or 'charCodeAt(i)'`, { receiver: recv, member: n, suggestions: ["slice", "charCodeAt"] });
      return MERR;
    }
  }
  const suggestions = suggestMembers(n, available);
  c.at("E2001", name, `'${recv}' has no member '${n}'${didYouMean(suggestions)}`, { receiver: recv, member: n, ...(suggestions.length ? { suggestions } : {}) });
  return MERR;
}

function member(c: Checker, p: ts.PropertyAccessExpression, inCall: boolean): MemberResult {
  const name = p.name as ts.Identifier; // private names are E1000 in P1
  const recvNode = p.expression;
  if (isId(recvNode) && recvNode.text === "Resource" && !c.scope.lookup("Resource") && !c.prog.lookupValue(c.mod, "Resource")) {
    if (name.text === "own" || name.text === "ownWith") c.at("E2002", name, "a method can only be called");
    else {
      const suggestions = suggestMembers(name.text, ["own", "ownWith"]);
      c.at("E2001", name, `'Resource' has no member '${name.text}'${didYouMean(suggestions)}`, { receiver: "Resource", member: name.text, ...(suggestions.length ? { suggestions } : {}) });
    }
    return MERR;
  }
  if (isId(recvNode) && recvNode.text === "Result" && !c.scope.lookup("Result") && !c.prog.lookupValue(c.mod, "Result")) {
    if (name.text === "ok" || name.text === "err") c.at("E2002", name, "a method can only be called");
    else {
      const suggestions = suggestMembers(name.text, ["ok", "err"]);
      c.at("E2001", name, `'Result' has no member '${name.text}'${didYouMean(suggestions)}`, { receiver: "Result", member: name.text, ...(suggestions.length ? { suggestions } : {}) });
    }
    return MERR;
  }
  if (isId(recvNode) && isNamespace(c, recvNode)) {
    if (recvNode.text === "Math" && name.text === "random") {
      const fix = c.authorityFix("random", p);
      c.at("E5001", name, "Math.random is a global authority; take a Random", { name: "Math.random", authority: "Random" });
      if (fix?.fixes) c.prog.rep.out.at(-1)!.fixes = fix.fixes;
      return MERR;
    }
    const m = nsMember(recvNode.text, name.text);
    if (m === undefined) {
      if (recvNode.text === "Number" && name.text === "parseInt") {
        const alts = ["parseI32", "parseU32", "parseI64", "parseU64"];
        c.at("E2001", name, `'Number.parseInt' is not in the allowlist; use 'Number.parseI32', 'Number.parseU32', 'Number.parseI64', or 'Number.parseU64'`, { namespace: "Number", member: "parseInt", suggestions: alts });
        return MERR;
      }
      const suggestions = suggestMembers(name.text, Object.keys(nsMembers(recvNode.text)));
      c.at("E2001", name, `'${recvNode.text}.${name.text}' is not in the allowlist${didYouMean(suggestions)}`, { namespace: recvNode.text, member: name.text, ...(suggestions.length ? { suggestions } : {}) });
      return MERR;
    }
    if (m === "variadic") return inCall ? { kind: "variadic" } : (c.at("E2002", name, "a method can only be called", { member: name.text }), MERR);
    return fromMember(c, m, name, inCall);
  }
  if (isId(recvNode) && !c.scope.lookup(recvNode.text)) {
    const ns = c.mod.nsImports.get(recvNode.text);
    if (ns) {
      if (p.questionDotToken) { c.at("E2002", name, "'?.' cannot be used on a module namespace"); return MERR; }
      if (ns.typeOnly) { c.at("E2002", recvNode, `'${recvNode.text}' is type-only and cannot be used as a value`, { kind: "type-only", name: recvNode.text }); return MERR; }
      const sym = c.prog.lookupExportedValue(ns.mod, name.text);
      if (!sym) {
        if (c.prog.isExportedTypeOnly(ns.mod, name.text)) c.at("E2002", name, `'${name.text}' is type-only and cannot be used as a value`, { kind: "type-only", name: name.text });
        else c.at("E2001", name, `module '${recvNode.text}' has no exported value '${name.text}'`, { receiver: recvNode.text, member: name.text });
        return MERR;
      }
      switch (sym.k) {
        case "const": return { kind: "value", type: sym.type, readonly: true };
        case "fn":
          if (c.fx.layer !== "managed" || sym.layer !== "managed") c.at("E4003", name, `the function '${sym.name}' cannot be used as a value here`);
          if (c.fx.contract) c.at("E6002", name, `a contract cannot refer to the function value '${sym.name}'`);
          return { kind: "value", type: sym.sig, readonly: true };
        case "class": c.at("E2002", name, `class '${sym.cls.name}' is not a value`); return MERR;
        case "jsref":
          if (c.fx.contract) c.at("E6002", name, `a contract cannot refer to '${name.text}'`);
          return { kind: "value", type: opaque("JsRef"), readonly: true };
        default: return MERR;
      }
    }
    const sym = c.prog.lookupValue(c.mod, recvNode.text);
    if (sym?.k === "class") return classStaticMember(c, sym.cls, name, inCall);
  }
  if (recvNode.kind === K.PropertyAccessExpression && isId((recvNode as ts.PropertyAccessExpression).expression)) {
    const outer = recvNode as ts.PropertyAccessExpression;
    const ns = lookupNs(c, outer.expression as ts.Identifier);
    if (ns) {
      if (outer.questionDotToken) { c.at("E2002", outer.name, "'?.' cannot be used on a module namespace"); return MERR; }
      if (ns.typeOnly) { c.at("E2002", outer.expression, `'${(outer.expression as ts.Identifier).text}' is type-only and cannot be used as a value`, { kind: "type-only", name: (outer.expression as ts.Identifier).text }); return MERR; }
      const sym = c.prog.lookupExportedValue(ns.mod, outer.name.text);
      if (sym?.k === "class") {
        if (p.questionDotToken) { c.at("E2002", name, "'?.' cannot be used on a class static member"); return MERR; }
        return classStaticMember(c, sym.cls, name, inCall);
      }
    }
  }
  let recv = expr(c, recvNode);
  if (isErr(recv)) return MERR;
  if (p.questionDotToken) {
    const nn = nonNull(recv);
    if (!nn) { c.at("E2002", name, "'?.' needs a nullable receiver"); return MERR; }
    const r = lookupMember(c, unref(nn), name, inCall);
    if (r.kind === "value") return { ...r, optRaw: r.type, type: nullable(r.type) };
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
  const missing = (code: string): MemberResult => { c.at(code, name, `'${show(t)}' has no member '${n}'`, { receiver: show(t), member: n }); return MERR; };
  switch (t.k) {
    case "record": case "cstruct": {
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
      if (isStr(t)) break;
      const fs = t.members.map((m) => field(m, n));
      if (!isTaggedUnion(t) || fs.some((f) => !f)) return missing("E2002");
      // writing the tag through the union could flip it under a caller's narrowing (Q122)
      // a write through the union is sound only if every member's field has one type (Q234)
      return { kind: "value", type: union(fs.map((f) => f!.type)), readonly: n === "kind" || fs.some((f) => f!.readonly) || fs.some((f) => !same(f!.type, fs[0]!.type)) };
    }
    case "tparam": return t.p.constraint ? lookupMember(c, t.p.constraint, name, inCall) : missing("E2002");
    case "gen": {
      if ((t.name === "Array" || t.name === "ReadonlyArray") && (n === "includes" || n === "indexOf") && !isErr(t.args[0]!) && !eqable(t.args[0]!)) { // Q032
        c.at("E2002", name, `'${n}' needs an element type that supports '===', not '${show(t.args[0]!)}'`);
        return MERR;
      }
      const m = genMember(t, n);
      return m ? fromMember(c, m, name, inCall) : reportUnknownBuiltinMember(c, name, t, Object.keys(genMembers(t)));
    }
    case "tuple": return n === "length" ? { kind: "value", type: USIZE, readonly: true } : reportUnknownBuiltinMember(c, name, t, ["length"]);
    case "opaque": { const m = opaqueMember(t.name, n); return m ? fromMember(c, m, name, inCall) : reportUnknownBuiltinMember(c, name, t, Object.keys(opaqueMembers(t.name))); }
    case "resource": {
      if (!inCall) return reportUnknownBuiltinMember(c, name, t, ["borrow", "get", "take"]);
      if (n === "borrow") {
        if (!isErr(t.inner) && !isOwnedCap(t.inner)) { c.at("E2001", name, "'borrow' requires an Owned Resource; use 'get()' for Ptr / ConstPtr"); return MERR; }
        return { kind: "method", sig: fn([], t.inner), layer: undefined };
      }
      if (n === "get") {
        if (!isErr(t.inner) && !isCopy(t.inner)) { c.at("E2001", name, "'get' requires a Ptr / ConstPtr Resource; use 'borrow()' or 'take()' for Owned values"); return MERR; }
        return { kind: "method", sig: fn([], t.inner), layer: undefined };
      }
      if (n === "take") {
        if (c.fx.contract) c.at("E6002", name, "contracts cannot call 'take'");
        return { kind: "method", sig: fn([], t.inner), layer: undefined };
      }
      return reportUnknownBuiltinMember(c, name, t, ["borrow", "get", "take"]);
    }
    case "num": return missing("E2001");
    case "prim": if (t.name === "boolean") return missing("E2001"); break;
  }
  if (isStr(t)) {
    const m = stringMember(n);
    if (!m) return reportUnknownBuiltinMember(c, name, t, Object.keys(stringMembers()));
    if (!c.callAllowed("managed")) {
      c.at("E4001", name, `string member '${n}' is managed-only`, { callerLayer: c.fx.layer, calleeLayer: "managed" });
      return MERR;
    }
    return fromMember(c, m, name, inCall);
  }
  return missing("E2002");
}

function propValue(c: Checker, p: ts.PropertyAccessExpression): Type {
  const r = member(c, p, false);
  if (r.kind !== "value") return ERROR;
  const k = c.keyOf(p);
  return k && c.narrow.has(k.key) ? c.narrow.get(k.key)! : r.type;
}

function constIndex(c: Checker, e0: ts.Expression): bigint | null {
  const e = assignTarget(e0);
  if (e.kind === K.NumericLiteral) return parseExactInt(e.getText(c.fx.mod.sf), false);
  if (e.kind === K.PrefixUnaryExpression) {
    const p = e as ts.PrefixUnaryExpression;
    if (p.operator === K.MinusToken && p.operand.kind === K.NumericLiteral) return parseExactInt(p.operand.getText(c.fx.mod.sf), true);
  }
  return null;
}

function element(c: Checker, e: ts.ElementAccessExpression, write: boolean): Type {
  if (write && (e.flags & NodeFlags.OptionalChain || e.questionDotToken)) {
    c.at("E2002", e, "optional chaining cannot be used on an assignment target");
    return ERROR;
  }
  let t = expr(c, e.expression);
  const idx = e.argumentExpression;
  if (isErr(t)) { expr(c, idx, USIZE); return ERROR; }
  const opt = !!e.questionDotToken;
  if (opt) {
    const nn = nonNull(t);
    if (!nn) { c.at("E2002", e.expression, "'?.[]' needs a nullable receiver"); return ERROR; }
    t = nn;
  }
  t = unref(t);
  const elemType = (): Type => {
    if (t.k === "gen" && ["Array", "ReadonlyArray", "Vec", "Slice"].includes(t.name)) {
      checkTo(c, idx, USIZE);
      if (write && t.name === "ReadonlyArray") { c.at("E2002", idx, "ReadonlyArray cannot be written"); return ERROR; }
      return t.args[0]!;
    }
    if (t.k === "tuple") {
      checkTo(c, idx, USIZE);
      if (write) { c.at("E2002", idx, "tuple elements are readonly and cannot be assigned"); return ERROR; }
      const k = constIndex(c, idx);
      if (k !== null) {
        if (k < 0n) return ERROR; // negative index already reported E2008 by checkTo(..., USIZE)
        if (k >= BigInt(t.elems.length)) {
          c.at("E2002", idx, `tuple index ${k} is out of bounds for tuple of length ${t.elems.length}`);
          return ERROR;
        }
        return t.elems[Number(k)]!;
      }
      if (assignTarget(idx).kind === K.NumericLiteral) return ERROR; // non-integer literal (e.g. 1.5) already reported E2008
      if (t.elems.every((el) => same(el, t.elems[0]!))) return t.elems[0]!;
      c.at("E2002", idx, `dynamic index on heterogeneous tuple '${show(t)}' is not allowed; use a constant index literal`);
      return ERROR;
    }
    if (isStr(t)) {
      c.at("E2001", idx, `'string' cannot be indexed; use 'charCodeAt(i)', 'codePointAt(i)', or 'slice(i, i + 1)'`, { receiver: show(t), suggestions: ["charCodeAt", "codePointAt", "slice"] });
      return ERROR;
    }
    const builtin = (t.k === "gen") || t.k === "opaque";
    c.at(builtin ? "E2001" : "E2002", idx, `'${show(t)}' cannot be indexed`); // Q007
    return ERROR;
  };
  const r = opt ? c.branch(elemType) : elemType();
  return opt && !isErr(r) ? nullable(r) : r;
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
    if (c.mod.nsImports.has(e.text) || c.prog.isTypeOnlyValue(c.mod, e.text) || c.prog.lookupValue(c.mod, e.text)) {
      c.at("E2002", e, `'${e.text}' cannot be assigned`);
      return ERROR;
    }
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
  const ctx = numCtx(want);
  if (L && R) { const d = ctx ?? (isLitOnly(l) && isLitOnly(r) ? F64 : undefined); return [expr(c, l, d), expr(c, r, d)]; }
  if (L) { const rt = expr(c, r, ctx); return [expr(c, l, sideCtx(rt)), rt]; }
  if (R) { const lt = expr(c, l, ctx); return [lt, expr(c, r, sideCtx(lt))]; }
  return [expr(c, l, ctx), expr(c, r, ctx)];
}

/** Attaches a `: <type>` declaration fix to `d` when `side` is an unannotated literal `let` binding. */
function attachLitLetFix(c: Checker, d: Diagnostic, side: ts.Expression, other: Type): boolean {
  const u = assignTarget(side);
  if (!isId(u) || other.k !== "num") return false;
  const sym = c.scope.lookup(u.text);
  const name = sym && c.litLets.get(sym.id);
  if (!name || sym.type.k !== "num" || sym.type.name === other.name) return false;
  const pos = c.fx.mod.pf.position(name.end);
  (d.fixes ??= []).push({ title: `declare '${name.text}' as '${other.name}'`, edits: [{ range: { start: pos, end: pos }, newText: `: ${other.name}` }] });
  return true;
}

/** SPEC §11 fix for an E2003 just reported at `op`: an operand that is an untyped `let x = 0` gets the other side's type, or else explicit numeric casts. */
function numFix(c: Checker, op: Node, l: ts.Expression, r: ts.Expression, lt: Type, rt: Type, lhsFixed = false, want?: Type): void {
  const d = c.prog.rep.out.at(-1);
  const sf = c.fx.mod.sf, pf = c.fx.mod.pf;
  if (d?.code !== "E2003" || d.range.start.line !== pf.position(op.getStart(sf)).line || d.range.start.col !== pf.position(op.getStart(sf)).col) return;
  attachLitLetFix(c, d, l, rt);
  attachLitLetFix(c, d, r, lt);
  if (d.fixes?.length || lt.k !== "num" || rt.k !== "num" || lt.name === rt.name) return;
  const mk = (node: ts.Expression, target: string, label: string) => {
    const s = node.getStart(sf);
    return { title: `convert ${label} to '${target}'`, edits: [{ range: { start: pf.position(s), end: pf.position(node.end) }, newText: `${target}(${sf.text.slice(s, node.end)})` }] };
  };
  const fixes = lhsFixed ? [mk(r, lt.name, "right")] : want?.k === "num" && want.name === lt.name
    ? [mk(r, lt.name, "right"), mk(l, rt.name, "left")]
    : [mk(l, rt.name, "left"), mk(r, lt.name, "right")];
  d.fixes = fixes;
}

function attachStrTemplateFix(c: Checker, b: ts.BinaryExpression, op: Node, lt: Type, rt: Type): void {
  if (b.operatorToken.kind !== K.PlusToken || !c.callAllowed("managed")) return;
  const okMix = (isStr(lt) && (isNum(rt) || isBool(rt))) || (isStr(rt) && (isNum(lt) || isBool(lt)));
  if (!okMix) return;
  const d = c.prog.rep.out.at(-1);
  const sf = c.fx.mod.sf, pf = c.fx.mod.pf;
  if (d?.code !== "E2002" || d.range.start.line !== pf.position(op.getStart(sf)).line || d.range.start.col !== pf.position(op.getStart(sf)).col) return;
  const part = (e: ts.Expression): string => {
    if (e.kind === K.StringLiteral || e.kind === K.NoSubstitutionTemplateLiteral) {
      const val = (e as ts.StringLiteral).text;
      if (!/[`$\\\r\n]/.test(val)) return val;
    }
    return `\${${e.getText(sf)}}`;
  };
  d.fixes = [{
    title: "use template literal",
    edits: [{ range: { start: pf.position(b.getStart(sf)), end: pf.position(b.end) }, newText: `\`${part(b.left)}${part(b.right)}\`` }],
  }];
}

function arith(c: Checker, op: Node, kind: K, lt: Type, rt: Type): Type {
  if (isErr(lt) || isErr(rt)) return ERROR;
  if (isNum(lt) && isNum(rt)) {
    if (lt.name !== rt.name) { c.at("E2003", op, `cannot mix '${lt.name}' and '${rt.name}'`, { left: lt.name, right: rt.name }); return ERROR; }
    if (kind === K.SlashToken && isInt(lt)) { c.at("E2007", op, "integer '/' is not allowed; use divTrunc", { type: lt.name }); return ERROR; }
    if (kind === K.AsteriskAsteriskToken && isInt(lt)) { c.at("E2002", op, "integer '**' is not allowed; convert to f64 or use Math.pow", { kind: "int-pow", type: lt.name }); return ERROR; }
    if (kind === K.AsteriskAsteriskToken && !c.callAllowed("managed")) c.at("E4001", op, "'**' is managed-only", { callerLayer: c.fx.layer, calleeLayer: "managed" }); // Q180: pow is not exact (§10.1)
    return lt;
  }
  c.at("E2002", op, `operator cannot be applied to '${show(lt)}' and '${show(rt)}'`, { left: show(lt), right: show(rt) });
  return ERROR;
}

function bitOp(c: Checker, op: Node, kind: K, lt: Type, rt: Type): Type {
  if (isErr(lt) || isErr(rt)) return ERROR;
  if (isNum(lt) && isNum(rt) && lt.name !== rt.name) {
    c.at("E2003", op, `cannot mix '${lt.name}' and '${rt.name}'`, { left: lt.name, right: rt.name });
    return ERROR;
  }
  const okTypes = kind === K.GreaterThanGreaterThanToken
    ? ["i32", "i64"]
    : kind === K.GreaterThanGreaterThanGreaterThanToken
    ? ["u32", "u64"]
    : kind === K.LessThanLessThanToken
    ? ["i32", "u32", "i64", "u64"]
    : ["u8", "u16", "i32", "u32", "i64", "u64"];
  if (!isNum(lt) || !isNum(rt) || !okTypes.includes(lt.name)) {
    const hint = !isNum(lt) || !isNum(rt) ? ""
      : kind === K.GreaterThanGreaterThanToken && ["u32", "u64"].includes(lt.name) ? "; use '>>>' for unsigned right shift"
      : kind === K.GreaterThanGreaterThanGreaterThanToken && ["i32", "i64"].includes(lt.name) ? "; use '>>' for signed right shift"
      : "";
    c.at("E2002", op, `bit operator cannot be applied to '${show(lt)}' and '${show(rt)}'${hint}`);
    return ERROR;
  }
  return lt;
}

function incDec(c: Checker, u: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression): Type {
  const op = u.operator === K.PlusPlusToken ? "++" : "--";
  const lt = lvalue(c, u.operand);
  if (isErr(lt)) return ERROR;
  if (!isNum(lt)) {
    c.at("E2002", u, `'${op}' cannot be applied to '${show(lt)}'`, { op, actual: show(lt) });
    return ERROR;
  }
  return lt;
}

function attachIntOpFix(c: Checker, b: ts.BinaryExpression, op: Node, code: string, fnName: string, compound: boolean): void {
  const d = c.prog.rep.out.at(-1);
  const sf = c.fx.mod.sf;
  const pos = c.fx.mod.pf.position(op.getStart(sf));
  if (d?.code !== code || d.range.start.line !== pos.line || d.range.start.col !== pos.col) return;
  if (compound) {
    const tgt = assignTarget(b.left);
    if (!isId(tgt)) return;
    (d.fixes ??= []).push({
      title: `use ${fnName}`,
      edits: [{ range: { start: c.fx.mod.pf.position(b.getStart(sf)), end: c.fx.mod.pf.position(b.end) }, newText: `${tgt.text} = ${fnName}(${tgt.text}, ${b.right.getText(sf)})` }],
    });
  } else {
    (d.fixes ??= []).push({
      title: `use ${fnName}`,
      edits: [{ range: { start: c.fx.mod.pf.position(b.getStart(sf)), end: c.fx.mod.pf.position(b.end) }, newText: `${fnName}(${b.left.getText(sf)}, ${b.right.getText(sf)})` }],
    });
  }
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
  if (k === K.QuestionQuestionEqualsToken) {
    const lt = lvalue(c, b.left);
    if (isErr(lt)) { expr(c, b.right); return ERROR; }
    const inner = nonNull(lt);
    if (!inner) { c.at("E2002", b, "'??=' needs a nullable left operand"); expr(c, b.right); return ERROR; }
    const rt = c.branch(() => expr(c, b.right, inner));
    if (assignable(rt, inner)) return inner;
    if (assignable(rt, lt)) return lt;
    c.at("E2002", b.right, `expected '${show(inner)}', got '${show(rt)}'`);
    return ERROR;
  }
  const base = COMPOUND[k];
  if (base !== undefined) {
    const lt = lvalue(c, b.left);
    const rt = expr(c, b.right, isNum(lt) ? lt : undefined);
    if (BIT_OPS.has(base)) {
      const r = bitOp(c, op, base, lt, rt);
      numFix(c, op, b.left, b.right, lt, rt, true);
      return r;
    }
    if (k === K.PlusEqualsToken && isStr(lt) && isStr(rt)) {
      if (lt.k !== "prim" || lt.name !== "string") {
        c.at("E2002", op, `operator cannot be applied to '${show(lt)}' and '${show(rt)}'`, { left: show(lt), right: show(rt) });
        return ERROR;
      }
      if (!c.callAllowed("managed")) {
        c.at("E4001", op, "string concatenation is managed-only", { callerLayer: c.fx.layer, calleeLayer: "managed" });
        return ERROR;
      }
      return STR;
    }
    const r = arith(c, op, base, lt, rt);
    if (k === K.SlashEqualsToken) attachIntOpFix(c, b, op, "E2007", "divTrunc", true);
    numFix(c, op, b.left, b.right, lt, rt, true);
    return r;
  }
  switch (k) {
    case K.AmpersandAmpersandToken: case K.BarBarToken: {
      const m0 = c.mark();
      const lt = expr(c, b.left);
      if (!isBool(lt) && !isErr(lt)) { c.at("E2004", b.left, "operand must be boolean", { actual: show(lt) }); attachNonNullCondFix(c, b.left, lt); }
      const rt = c.branch(() => expr(c, b.right), c.facts(b.left, k === K.AmpersandAmpersandToken), m0);
      if (!isBool(rt) && !isErr(rt)) { c.at("E2004", b.right, "operand must be boolean", { actual: show(rt) }); attachNonNullCondFix(c, b.right, rt); }
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
      if (isNum(lt) && isNum(rt)) { if (lt.name !== rt.name) c.at("E2003", op, `cannot compare '${lt.name}' and '${rt.name}'`, { left: lt.name, right: rt.name }); }
      else if (isStr(lt) && isStr(rt)) {
        if (!c.callAllowed("managed")) c.at("E4001", op, "string relational comparison is managed-only", { callerLayer: c.fx.layer, calleeLayer: "managed" });
      }
      else c.at("E2002", op, "relational operators need numbers of the same type or strings"); // Q018
      numFix(c, op, b.left, b.right, lt, rt);
      return BOOL;
    }
    case K.AmpersandToken: case K.BarToken: case K.CaretToken:
    case K.LessThanLessThanToken: case K.GreaterThanGreaterThanToken: case K.GreaterThanGreaterThanGreaterThanToken: {
      const [lt, rt] = operands(c, b.left, b.right, want);
      return bitOp(c, op, k, lt, rt);
    }
  }
  if (ARITH.has(k)) {
    const [lt, rt] = operands(c, b.left, b.right, want);
    if (k === K.PlusToken && isStr(lt) && isStr(rt)) {
      if (!c.callAllowed("managed")) {
        c.at("E4001", op, "string concatenation is managed-only", { callerLayer: c.fx.layer, calleeLayer: "managed" });
        return ERROR;
      }
      return STR;
    }
    const r = arith(c, op, k, lt, rt);
    if (k === K.SlashToken) attachIntOpFix(c, b, op, "E2007", "divTrunc", false);
    attachStrTemplateFix(c, b, op, lt, rt);
    numFix(c, op, b.left, b.right, lt, rt, false, want);
    return r;
  }
  return ERROR; // P1 rejects every other binary operator
}

/** Q017: element types for which `===` works (the `T` of `T | null` counts). */
function eqable(t: Type): boolean {
  const a = nonNull(t) ?? t;
  return isNum(a) || isBool(a) || isStr(a) || a.k === "class" || (a.k === "gen" && a.name === "Handle") || (a.k === "tparam" && tparamHasCap(a.p, "Key"));
}

/** Q058: the first argument of `t.traps` / `t.trapsAsync` is a string literal naming an implemented trap (T001 - T015). */
function trapCode(c: Checker, a: ts.Expression, name = "traps"): void {
  const ok = (a.kind === K.StringLiteral || a.kind === K.NoSubstitutionTemplateLiteral) && /^T(00[1-9]|01[0-5])$/.test((a as ts.StringLiteral).text);
  if (!ok) c.at("E2002", a, `the first argument of '${name}' must be a trap code literal "T001" - "T015"`);
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
  if (isNum(a) && isNum(b)) { if (a.name !== b.name) c.at("E2003", op, `cannot compare '${a.name}' and '${b.name}'`, { left: a.name, right: b.name }); return; }
  if ((isBool(a) && isBool(b)) || (isStr(a) && isStr(b)) || ((a.k === "class" || (a.k === "gen" && a.name === "Handle") || (a.k === "tparam" && tparamHasCap(a.p, "Key"))) && same(a, b))) return;
  c.at("E2002", op, `cannot compare '${show(lt)}' and '${show(rt)}'`);
}

function prefix(c: Checker, u: ts.PrefixUnaryExpression, want: Type | undefined): Type {
  if (u.operator === K.PlusPlusToken || u.operator === K.MinusMinusToken) return incDec(c, u);
  if (u.operator === K.MinusToken && isLitOnly(u.operand)) { // negative literal (Q015): anchor at '-'
    if (u.operand.kind === K.NumericLiteral) return numLit(c, u, u.operand as ts.NumericLiteral, true, want);
    const t = expr(c, u.operand, numCtx(want) ?? F64);
    return negate(c, u, t);
  }
  if (u.operator === K.ExclamationToken) {
    const t = expr(c, u.operand);
    if (!isBool(t) && !isErr(t)) c.at("E2004", u.operand, "operand must be boolean", { actual: show(t) });
    return BOOL;
  }
  const t = expr(c, u.operand, want);
  if (u.operator === K.MinusToken) return negate(c, u, t);
  if (isErr(t)) return ERROR;
  if (!isNum(t) || !["i32", "u32", "i64", "u64"].includes(t.name)) { c.at("E2002", u, `'~' cannot be applied to '${show(t)}'`); return ERROR; }
  return t;
}
function negate(c: Checker, u: Node, t: Type): Type {
  if (isErr(t)) return ERROR;
  if (!isNum(t) || ["u8", "u16", "u32", "u64", "usize"].includes(t.name)) { c.at("E2002", u, `unary '-' cannot be applied to '${show(t)}'`); return ERROR; }
  return t;
}

function conditional(c: Checker, e: ts.ConditionalExpression, want: Type | undefined): Type {
  const m0 = c.mark();
  cond(c, e.condition);
  const saved = c.narrow, m1 = c.mark();
  const tb = (ctx?: Type): Type => c.branch(() => (want ? checkTo(c, e.whenTrue, want) : expr(c, e.whenTrue, ctx)), c.facts(e.condition, true), m0, m1);
  const fb = (ctx?: Type): Type => c.branch(() => (want ? checkTo(c, e.whenFalse, want) : expr(c, e.whenFalse, ctx)), c.facts(e.condition, false), m0, m1);
  let a: Type, b: Type;
  if (!want && deferrable(e.whenTrue) && !deferrable(e.whenFalse)) { // a literal takes its type from the other branch (§3.1, Q237)
    b = fb();
    c.narrow = saved;
    a = tb(sideCtx(b));
  } else {
    a = tb();
    c.narrow = saved; // the two branches are alternatives
    b = fb(deferrable(e.whenFalse) ? sideCtx(a) : undefined);
  }
  c.restore(saved, m1);
  if (want) return isErr(a) || isErr(b) ? ERROR : want;
  if (isErr(a) || isErr(b)) return ERROR;
  if (assignable(a, b)) return b;
  if (assignable(b, a)) return a;
  if (isNull(a) || isNull(b) || (isStr(a) && isStr(b))) {
    const u = union([a, b]);
    if (u.k === "union" && hasRawPtr(u)) { c.at("E4008", e, "'Ptr' / 'ConstPtr' cannot be a member of a union or 'T | null'"); return ERROR; }
    return u;
  }
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
  if (t.k !== "record" && t.k !== "cstruct") { c.at("E2002", e, `an object literal is not a '${show(t)}'`); return ERROR; }
  const rec = t;
  const given = new Set<string>();
  let bad = false;
  for (const p of e.properties) {
    if (p.kind === K.SpreadAssignment) { // Q053
      const st = unref(expr(c, (p as ts.SpreadAssignment).expression));
      if (isErr(st)) { bad = true; continue; }
      if ((st.k !== "record" && st.k !== "cstruct") || st.fields.some((f) => !field(rec, f.name) || !assignable(f.type, field(rec, f.name)!.type))) {
        c.at("E2002", (p as ts.SpreadAssignment).expression, "spread does not match the record type");
        return ERROR;
      }
      for (const f of st.fields) given.add(f.name);
      continue;
    }
    if (p.kind !== K.PropertyAssignment && p.kind !== K.ShorthandPropertyAssignment) { bad = true; continue; }
    if (!isId(p.name) || p.name.text === "__proto__") { bad = true; continue; }
    const name = p.name;
    const f = field(rec, name.text);
    if (!f) { c.at("E2002", e, `'${show(rec)}' has no field '${name.text}'`); return ERROR; }
    given.add(name.text);
    if (p.kind === K.PropertyAssignment) { if (isErr(checkTo(c, (p as ts.PropertyAssignment).initializer, f.type))) bad = true; }
    else {
      const vt = ident(c, name);
      exprTypes.set(name, vt); // the narrowed type, for the C backend (a shorthand name is not typed through expr)
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
  if (w?.k === "tuple") {
    if (e.elements.some((x) => x.kind === K.SpreadElement)) {
      c.at("E2002", e, "spread element is not allowed in a tuple literal");
      return ERROR;
    }
    if (e.elements.length !== w.elems.length) {
      c.at("E2002", e, `expected tuple of length ${w.elems.length}, got ${e.elements.length}`, { expected: show(w) });
      return ERROR;
    }
    let bad = false;
    e.elements.forEach((x, i) => {
      if (isErr(checkTo(c, x, w.elems[i]!))) bad = true;
    });
    return bad ? ERROR : w;
  }
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
      const sp = e.elements.find((x) => x.kind === K.SpreadElement) as ts.SpreadElement | undefined;
      if (!sp) { c.at("E2006", e, "an array literal of literals that share no type needs a type from its context"); return ERROR; } // Q235
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

/** Arrow functions and function expressions (parameter types inferred from contextual fn type when present, else E2006; return inferred when not annotated). */
function checkArrow(c: Checker, e: ts.ArrowFunction | ts.FunctionExpression, want: FnType | undefined, inferRet: boolean, openIds?: Set<number>): FnType {
  if (c.fx.layer !== "managed" && !ensuresArgs.has(e)) c.at("E4003", e, `a function expression cannot be written in ${c.fx.layer} code`); // §2, Q012
  const tps = tparamShells(e.typeParameters, "managed", true);
  const outerTps = c.fx.tparams;
  c.fx.tparams = new Map([...outerTps, ...tps.map((p) => [p.name, p] as const)]);
  e.typeParameters?.forEach((d, i) => { if (d.constraint) c.prog.resolveConstraint(d.constraint, tps[i]!, { mod: c.mod, tparams: c.fx.tparams }); });
  const params: Type[] = [];
  let rest: Type | undefined;
  let pi = 0;
  for (let i = 0; i < e.parameters.length; i++) {
    const p = e.parameters[i]!;
    if (p.dotDotDotToken) {
      let rt: Type;
      if (!p.type) {
        const wt = want && !want.tparams.length ? want.rest : undefined;
        if (wt && !isErr(wt) && !(openIds && hasTParam(wt, openIds))) rt = wt;
        else { c.at("E2006", p.name, "parameter needs a type annotation"); rt = ERROR; }
      } else {
        c.walkTypePos(p.type, "sig", { unsafe: c.fx.unsafe, cdecl: false });
        rt = c.typeOf(p.type);
        const u = unref(rt);
        if (!isErr(u) && !restElem(u)) {
          c.at("E2002", p.type, `rest parameter must have type 'Array<T>' or 'ReadonlyArray<T>', got '${show(rt)}'`, { kind: "bad-rest-type", actual: show(rt) });
          rt = ERROR;
        }
      }
      if (i === e.parameters.length - 1) rest = rt;
      continue;
    }
    const idx = pi++;
    if (!p.type) {
      const wt = want && !want.tparams.length ? want.params[idx] : undefined;
      if (wt && !isErr(wt) && !(openIds && hasTParam(wt, openIds))) params.push(wt);
      else { c.at("E2006", p.name, "parameter needs a type annotation"); params.push(ERROR); }
    } else {
      c.walkTypePos(p.type, "sig", { unsafe: c.fx.unsafe, cdecl: false });
      params.push(c.typeOf(p.type));
    }
  }
  let ret = e.type ? (c.walkTypePos(e.type, "sig", { unsafe: c.fx.unsafe, cdecl: false }), c.typeOf(e.type, true)) : undefined;
  c.fx.tparams = outerTps;
  if (!ret && want && !inferRet) ret = want.ret;
  const firstDef = e.parameters.findIndex((p) => !p.dotDotDotToken && !!p.initializer);
  const sig: FnType = { ...fn(params, ret ?? ERROR, tps, rest), ...(firstDef >= 0 ? { min: firstDef } : {}) };
  const got = c.fnBody(e, sig, { inferRet: !ret });
  return { ...fn(params, ret ?? got, tps, rest), ...(firstDef >= 0 ? { min: firstDef } : {}) };
}

// ---- calls
/** §15.2: `spawn.isolate(f)` calls the checker accepted: the entry function's module path and name. Read by the emitter. */
export const isolateCalls = new WeakMap<Node, { path: string; name: string }>();
/** §15.5: `audio.open(cfg, state, render)` calls the checker accepted. Read by the emitter. */
export const audioOpenCalls = new WeakMap<Node, { path: string; name: string; key: string; id: number }>();
/** §16.1: `forAll(f)` calls the checker accepted: parameter types and whether `false` return is a failure. Read by the emitter. */
export const forAllMeta = new WeakMap<Node, { params: Type[]; checkBool: boolean }>();

/** §15.5 (Q283): `audio.open<S>(config, state, render)`. `render` is a module-level non-generic safe
 * `"use rt"` function taking `(st: Mut<S> | S, out: Mut<Slice<f32>>, frames: usize): void`. */
function audioOpenCall(c: Checker, e: ts.CallExpression, p: ts.PropertyAccessExpression): Type {
  if (!c.callAllowed("managed")) c.at("E4001", p.name, `'open' is managed-only`, { callerLayer: c.fx.layer, calleeLayer: "managed" });
  const args = e.arguments;
  if (args.length !== 3) { c.at("E2013", p.name, `'open' takes 3 arguments (config, state, render)`, { reason: "arity" }); return ERROR; }
  let S: Type | undefined;
  if (e.typeArguments) {
    if (e.typeArguments.length !== 1) { c.at("E2013", p.name, `'open' takes 1 type argument`, { reason: "type-arity" }); return ERROR; }
    S = c.typeOf(e.typeArguments[0]!);
    if (!isErr(S) && !audioStateOk(S)) { c.at("E2013", e.typeArguments[0]!, `'${show(S)}' cannot be passed as audio callback state`, { reason: "invalid-state", actual: show(S) }); return ERROR; }
  }
  checkTo(c, args[0]!, AUDIO_CONFIG_RECORD, true);
  const stRaw = S ? checkTo(c, args[1]!, S, true) : expr(c, args[1]!);
  const st = S ?? unref(stRaw);
  if (!S && !isErr(st) && !audioStateOk(st)) { c.at("E2013", args[1]!, `'${show(st)}' cannot be passed as audio callback state`, { reason: "invalid-state", actual: show(st) }); return ERROR; }
  const a = args[2]!;
  const bad = (msg: string, reason = "invalid-callback"): Type => { c.at("E2013", a, msg, { reason }); return ERROR; };
  const fnRef = lookupModuleFn(c, a);
  if (!fnRef.sym) {
    if (fnRef.typeOnly) return bad(`'${fnRef.typeOnly}' is type-only and cannot be used as an audio callback`);
    if (fnRef.nonFn || fnRef.missingProp) return bad(`'${a.getText(c.fx.mod.sf)}' is not a module-level function`);
    return bad(`'open' takes the name of a module-level 'use rt' function`);
  }
  const sym = fnRef.sym;
  if (sym.sig.tparams.length) return bad(`the audio callback '${sym.name}' cannot be generic`);
  if (sym.layer !== "rt") return bad(`the audio callback '${sym.name}' must be a 'use rt' function (got ${sym.layer})`);
  if (sym.unsafe) return bad(`the audio callback '${sym.name}' cannot use 'use unsafe'`);
  if (sym.sig.min !== undefined) return bad(`the audio callback '${sym.name}' cannot have default parameters`);
  if (isErr(st)) return ERROR;
  const sig = sym.sig;
  const wantSt = isOwned(st) ? gen("Mut", st) : st;
  const wantOut = gen("Mut", gen("Slice", num("f32")));
  const hasParamErr = sig.params.some(hasErr) || isErr(sig.ret);
  const sigOk = sig.params.length === 3 && same(sig.params[0]!, wantSt) && same(sig.params[1]!, wantOut) && same(sig.params[2]!, USIZE) && same(sig.ret, VOID);
  if (!sigOk) return hasParamErr ? ERROR : bad(`the audio callback '${sym.name}' must have signature (st: ${show(wantSt)}, out: Mut<Slice<f32>>, frames: usize): void`);
  const key = `${sym.mod.pf.path}\0${sym.name}`;
  let entry = c.prog.audioCallbacks.get(key);
  if (!entry) {
    entry = { fn: sym, state: st, key, id: c.prog.audioCallbacks.size };
    c.prog.audioCallbacks.set(key, entry);
  }
  audioOpenCalls.set(e, { path: sym.mod.pf.path, name: sym.name, key, id: entry.id });
  return gen("Promise", result(opaque("AudioStream"), ERROR_RECORD));
}

/** SPEC-v1 §5: `Resource.own(val, cleanup)` / `Resource.ownWith(val, ctx, cleanup)` in a `using` initializer. */
function resourceCall(c: Checker, e: ts.CallExpression, p: ts.PropertyAccessExpression, want: Type | undefined): Type {
  const m = p.name.text;
  if (m !== "own" && m !== "ownWith") {
    const suggestions = suggestMembers(m, ["own", "ownWith"]);
    c.at("E2001", p.name, `'Resource' has no member '${m}'${didYouMean(suggestions)}`, { receiver: "Resource", member: m, ...(suggestions.length ? { suggestions } : {}) });
    return ERROR;
  }
  if (c.fx.contract) c.at("E6002", p.name, "contracts cannot construct a Resource");
  if (!usingInitExprs.has(e)) c.at("E3004", p.name, `'Resource.${m}' can only be used as the initializer of a 'using' declaration`);
  const args = e.arguments;
  const wantArgs = m === "own" ? 2 : 3;
  const maxTArgs = m === "own" ? 1 : 2;
  if (args.length !== wantArgs) { c.at("E2002", p.name, `'Resource.${m}' takes ${wantArgs} argument(s)`); return ERROR; }
  if (e.typeArguments && e.typeArguments.length !== maxTArgs) { c.at("E2002", p.name, `'Resource.${m}' takes ${maxTArgs} type argument(s)`); return ERROR; }

  const cleanupArg = args[wantArgs - 1]!;
  const fnRef = lookupModuleFn(c, cleanupArg);

  const valArg = args[0]!;
  let v0 = valArg;
  while (v0.kind === K.ParenthesizedExpression) v0 = (v0 as ts.ParenthesizedExpression).expression;
  const valParamIdx = m === "own" ? 0 : 1;
  const valParamT = fnRef.sym && fnRef.sym.sig.tparams.length === 0 && fnRef.sym.sig.params.length === wantArgs - 1
    ? fnRef.sym.sig.params[valParamIdx]
    : undefined;
  let T: Type;
  if (e.typeArguments?.[0]) {
    T = c.typeOf(e.typeArguments[0]!);
    c.walkTypePos(e.typeArguments[0]!, "local", { unsafe: c.fx.unsafe, cdecl: false });
    checkTo(c, valArg, T);
  } else if (want?.k === "resource") {
    T = want.inner;
    checkTo(c, valArg, T);
  } else if (ctxSensitive(v0) && valParamT && !isErr(valParamT) && !(valParamT.k === "gen" && (valParamT.name === "Ref" || valParamT.name === "Mut"))) {
    T = valParamT;
    checkTo(c, valArg, T);
  } else {
    T = unref(expr(c, valArg));
  }
  if (!isErr(T)) {
    const isRawPtr = T.k === "gen" && (T.name === "Ptr" || T.name === "ConstPtr");
    if (isRawPtr) {
      c.noteUnsafeOp(p.name);
      if (!c.fx.unsafe) c.at("E4008", p.name, `'Resource.${m}' on '${show(T)}' can only be used with 'use unsafe'`);
    } else if (!isOwnedCap(T)) {
      c.at("E2002", e.typeArguments?.[0] ?? valArg, `'Resource.${m}' requires an Owned value or (in unsafe) Ptr / ConstPtr, not '${show(T)}'`);
    }
  }

  let C: Type | undefined;
  if (m === "ownWith") {
    const ctxArg = args[1]!;
    if (e.typeArguments?.[1]) {
      C = c.typeOf(e.typeArguments[1]!);
      c.walkTypePos(e.typeArguments[1]!, "local", { unsafe: c.fx.unsafe, cdecl: false });
      checkTo(c, ctxArg, C);
    } else if (
      fnRef.sym &&
      fnRef.sym.sig.tparams.length === 0 &&
      fnRef.sym.sig.params.length === 2 &&
      !isErr(fnRef.sym.sig.params[0]!) &&
      !(fnRef.sym.sig.params[0]!.k === "gen" && (fnRef.sym.sig.params[0]!.name === "Ref" || fnRef.sym.sig.params[0]!.name === "Mut"))
    ) {
      C = fnRef.sym.sig.params[0]!;
      checkTo(c, ctxArg, C);
    } else {
      C = unref(expr(c, ctxArg));
    }
    const cNode = e.typeArguments?.[1] ?? ctxArg;
    if (!isErr(C)) {
      if (hasRawPtr(C)) {
        c.noteUnsafeOp(cNode);
        if (!c.fx.unsafe) c.at("E4008", cNode, `'Resource.ownWith' context with Ptr / ConstPtr can only be used with 'use unsafe'`);
      }
      if (c.fx.layer === "rt") {
        if (hasAuthority(C)) c.at("E4006", cNode, "rt functions cannot pass authorities in 'Resource.ownWith'");
        else if (!(isCopy(C) && isNative(C))) c.at("E4002", cNode, `'Resource.ownWith' context must be Copy & Native in rt code, not '${show(C)}'`);
      } else if (c.fx.layer === "strict") {
        if (!isAuthority(C) && !(isCopy(C) && isNative(C))) c.at("E4002", cNode, `'Resource.ownWith' context must be an authority or Copy & Native in strict code, not '${show(C)}'`);
      } else if (movesLike(C)) {
        c.at("E2002", cNode, `'Resource.ownWith' context cannot be an Owned type ('${show(C)}')`);
      }
    }
  }

  const expParams = m === "own" ? [T] : [C!, T];
  let cleanupFn: FnSym | undefined;
  const checkCleanupSym = (sym: FnSym): FnSym | undefined => {
    if (sym.sig.tparams.length) { c.at("E4003", cleanupArg, `the generic function '${sym.name}' cannot be used as a cleanup callback`); return undefined; }
    if (sym.sig.min !== undefined) { c.at("E2002", cleanupArg, `cleanup function '${sym.name}' cannot have default parameters`); return undefined; }
    if (!c.callCheck(sym)) {
      const calleeTag = sym.layer === "rt" && sym.unsafe ? "rt+unsafe" : sym.layer;
      c.at("E4001", cleanupArg, `a ${c.fx.layer} function cannot use the ${calleeTag} function '${sym.name}' as cleanup`, { callerLayer: c.fx.layer, calleeLayer: calleeTag });
    }
    if (sym.sig.params.some(hasRawPtr) || hasRawPtr(sym.sig.ret)) {
      c.noteUnsafeOp(cleanupArg);
      if (!c.fx.unsafe) c.at("E4008", cleanupArg, `'${sym.name}' has Ptr in its signature; using it as cleanup is an unsafe operation`);
    }
    if (!expParams.some(isErr) && !sym.sig.params.some(hasErr) && !isErr(sym.sig.ret)) {
      const okSig = sym.sig.params.length === expParams.length &&
        sym.sig.params.every((pt, i) => !(pt.k === "gen" && (pt.name === "Ref" || pt.name === "Mut")) && same(pt, expParams[i]!)) &&
        same(sym.sig.ret, VOID);
      if (!okSig) c.at("E2002", cleanupArg, `expected cleanup (${expParams.map(show).join(", ")}) => void, got '${show(sym.sig)}'`);
    }
    if (sym.layer !== "managed") c.fnSites.push({ from: c.fn, callee: sym, refs: new Map(), node: cleanupArg, mod: c.mod });
    return sym;
  };
  if (fnRef.sym) {
    cleanupFn = checkCleanupSym(fnRef.sym);
  } else if (fnRef.typeOnly) {
    c.at("E2002", cleanupArg, `'${fnRef.typeOnly}' is type-only and cannot be used as a value`, { kind: "type-only", name: fnRef.typeOnly });
  } else if (c.fx.layer !== "managed") {
    c.at("E4003", cleanupArg, "cleanup must be the name of a module-level strict / rt function");
  } else {
    checkTo(c, cleanupArg, fn(expParams, VOID));
  }

  if (isErr(T)) return ERROR;
  resourceCalls.set(e, { kind: m, valType: T, ...(C ? { ctxType: C } : {}), ...(cleanupFn ? { cleanupFn } : {}) });
  return { k: "resource", inner: T };
}

/** `Result.ok(v)` / `Result.err(e)` constructor calls, inferred from contextual `Result<T, E>` (Q037). */
function resultCall(c: Checker, e: ts.CallExpression, p: ts.PropertyAccessExpression, want: Type | undefined): Type {
  const m = p.name.text;
  if (m !== "ok" && m !== "err") {
    const suggestions = suggestMembers(m, ["ok", "err"]);
    c.at("E2001", p.name, `'Result' has no member '${m}'${didYouMean(suggestions)}`, { receiver: "Result", member: m, ...(suggestions.length ? { suggestions } : {}) });
    return ERROR;
  }
  if (e.typeArguments) { c.at("E2002", p.name, "expects 0 type argument(s)"); return ERROR; }
  if (e.arguments.length !== 1) { c.at("E2002", p.name, `'Result.${m}' takes 1 argument(s)`); return ERROR; }
  if (!want) { c.at("E2006", p.name, `cannot infer the Result type of 'Result.${m}'`); return ERROR; }
  const parts = resultParts(nonNull(want) ?? want);
  if (!parts) { if (!isErr(want)) c.at("E2002", e, `'Result.${m}(...)' is not a '${show(want)}'`); return ERROR; }
  checkTo(c, e.arguments[0]!, m === "ok" ? parts.ok : parts.err);
  return nonNull(want) ?? want;
}

/** §15.2 (Q200, Q207, Q287): `spawn.isolate<S, R>(f)`. The argument is the *name* of a module-level (imports
 * included), non-generic, managed function `(port: Port<R, S>): void | Promise<void>` or
 * `(port: Port<R, S>, alloc: Alloc): void | Promise<void>`; any other expression or signature is E2011
 * at the argument. Explicit type arguments name the caller's `Port<S, R>` and must match the entry's own parameter. */
function isolateCall(c: Checker, e: ts.CallExpression, p: ts.PropertyAccessExpression): Type {
  if (e.arguments.length !== 1) { c.at("E2011", p.name, `'isolate' takes one argument: the entry function's name`, { reason: "arity" }); return ERROR; }
  const a = e.arguments[0]!;
  const bad = (msg: string, reason = "invalid-entry"): Type => { c.at("E2011", a, msg, { reason }); return ERROR; };
  let S: Type | undefined, R: Type | undefined;
  if (e.typeArguments) {
    if (e.typeArguments.length !== 2) { c.at("E2002", p.name, `'isolate' takes 2 type argument(s)`, { expected: "2", actual: String(e.typeArguments.length) }); return ERROR; }
    S = c.typeOf(e.typeArguments[0]!); R = c.typeOf(e.typeArguments[1]!);
    [S, R].forEach((t, i) => { if (!isErr(t) && !sendable(t)) c.at("E2010", e.typeArguments![i]!, `'${show(t)}' cannot be sent to an isolate`, { actual: show(t) }); });
    if (isErr(S) || isErr(R)) return ERROR;
  }
  const isoFnRef = lookupModuleFn(c, a);
  if (!isoFnRef.sym) {
    if (isoFnRef.typeOnly) return bad(`'${isoFnRef.typeOnly}' is type-only and cannot be an isolate entry`, "not-module-fn");
    return bad(`'isolate' takes the name of a module-level managed function`, "not-module-fn");
  }
  const sym = isoFnRef.sym;
  if (sym.sig.tparams.length) return bad(`the isolate entry '${sym.name}' cannot be generic`, "generic-entry");
  if (sym.sig.min !== undefined || sym.sig.rest) return bad(`the isolate entry '${sym.name}' cannot have default or rest parameters`);
  if (sym.layer !== "managed") return bad(`the isolate entry '${sym.name}' is a ${sym.layer} function; isolates run managed functions`, "non-managed-entry");
  const sig = sym.sig;
  const portT = sig.params.length === 1 || sig.params.length === 2 ? unref(sig.params[0]!) : undefined;
  const allocT = sig.params.length === 2 ? unref(sig.params[1]!) : undefined;
  if ((portT && isErr(portT)) || (allocT && isErr(allocT))) return ERROR; // the entry's own signature already reported (e.g. its E2010)
  const allocOk = !allocT || same(allocT, opaque("Alloc"));
  const retOk = same(sig.ret, VOID) || (sig.ret.k === "gen" && sig.ret.name === "Promise" && same(sig.ret.args[0]!, VOID));
  if (!portT || portT.k !== "gen" || portT.name !== "Port" || !allocOk || !retOk) {
    return bad(`the isolate entry '${sym.name}' must take '(port: Port<R, S>)' or '(port: Port<R, S>, alloc: Alloc)' and return 'void' or 'Promise<void>'`);
  }
  const fR = portT.args[0]!, fS = portT.args[1]!; // the entry's Port<R, S>: it sends R, receives S
  if ((S && !same(S, fS)) || (R && !same(R, fR))) return bad(`the isolate entry '${sym.name}' does not match the given type arguments`);
  isolateCalls.set(e, { path: sym.mod.pf.path, name: sym.name });
  const names = c.prog.isolateEntries.get(sym.mod.pf.path) ?? new Set<string>();
  names.add(sym.name);
  c.prog.isolateEntries.set(sym.mod.pf.path, names);
  return gen("Port", fS, fR);
}

const MATH_POLY = new Set(["abs", "sqrt", "floor", "ceil", "trunc", "round", "sign"]);
const NUMBER_POLY = new Set(["isFinite", "isNaN", "isInteger"]);
type FloatNum = { k: "num"; name: "f32" | "f64" };
const isFloatNum = (t: Type): t is FloatNum => t.k === "num" && (t.name === "f32" || t.name === "f64");
const wantFloatType = (want: Type | undefined): FloatNum => {
  const n = numCtx(want);
  return (n?.k === "num" && n.name === "f32" ? num("f32") : F64) as FloatNum;
};

function floatPolyArg(c: Checker, a: ts.Expression, wantFloat: FloatNum): Type {
  if (isLitOnly(a)) return expr(c, a, wantFloat);
  const t = expr(c, a);
  if (isErr(t)) return ERROR;
  if (isFloatNum(t)) return t;
  c.at("E2002", a, `expected 'f32' or 'f64', got '${show(t)}'`, { expected: "f32 | f64", actual: show(t) });
  attachConvertFix(c, a, t, wantFloat);
  return ERROR;
}

function callFnSym(c: Checker, sym: FnSym, e: ts.CallExpression, anchor: Node, want: Type | undefined): Type {
  callFns.set(e, sym);
  if (!c.callCheck(sym)) {
    const isRtUnsafe = sym.layer === "rt" && sym.unsafe;
    const calleeTag = isRtUnsafe ? "rt+unsafe" : sym.layer;
    const extra = isRtUnsafe ? " (rt+unsafe functions can only be called from rt+unsafe or passed to 'cfn')" : "";
    c.at("E4001", anchor, `a ${c.fx.layer} function cannot call the ${calleeTag} function '${sym.name}'${extra}`, { callerLayer: c.fx.layer, calleeLayer: calleeTag });
  }
  if (sym.sig.params.some(hasRawPtr) || hasRawPtr(sym.sig.ret)) { // §14.4.3: an unsafe operation (Q218: a CHandle in the signature does not count)
    c.noteUnsafeOp(anchor);
    if (!c.fx.unsafe) c.at("E4008", anchor, `'${sym.name}' has Ptr in its signature; calling it is an unsafe operation`, { op: sym.name });
  }
  if (c.fx.contract && !isDeterministic(sym.sig, sym.unsafe)) c.at("E6002", anchor, `a contract can only call deterministic functions ('${sym.name}' is not)`, { kind: "nondet-call", name: sym.name });
  const got = callSig(c, sym.sig, e, anchor, want, sym.layer === "managed" ? undefined : sym.layer);
  if (sym.layer !== "managed") c.fnSites.push({ from: c.fn, callee: sym, refs: callFnArgs.get(e) ?? new Map(), node: anchor, mod: c.mod, targs: callTArgs.get(e) }); // Q189 (b): E4005 per instantiation
  return got;
}

function call(c: Checker, e: ts.CallExpression, want: Type | undefined): Type {
  // `a?.m(args)`: the arguments may not run (Q133)
  if (e.flags & NodeFlags.OptionalChain && !optCall.has(e)) { optCall.add(e); try { return c.branch(() => call(c, e, want)); } finally { optCall.delete(e); } } // D161: the marker must not outlive this visit; a shared parser hands the next entry the same nodes
  const callee = e.expression;
  if (isId(callee) && !c.scope.lookup(callee.text)) {
    const sym = c.prog.lookupValue(c.mod, callee.text);
    if (!sym && c.mod.nsImports.has(callee.text)) { c.at("E2002", callee, `module namespace '${callee.text}' is not callable`, { name: callee.text }); return ERROR; }
    if (!sym && c.prog.isTypeOnlyValue(c.mod, callee.text)) { c.at("E2002", callee, `'${callee.text}' is type-only and cannot be used as a value`, { kind: "type-only", name: callee.text }); return ERROR; }
    if (!sym && BUILTIN_FUNCTIONS.has(callee.text)) return builtinCall(c, e, callee, want);
    if (sym?.k === "fn") return callFnSym(c, sym, e, callee, want);
    if (sym?.k === "cfn") { // §14.1 / §14.3: unsafe callers only; rt + unsafe drops the Ffi argument
      c.noteUnsafeOp(callee); // §14.4.2
      if (!c.fx.unsafe) c.at("E4008", callee, `the C function '${sym.name}' can only be called from a function with 'use unsafe'`, { op: sym.name });
      if (c.fx.contract) c.at("E6002", callee, `a contract cannot call the C function '${sym.name}'`, { kind: "nondet-call", name: sym.name });
      const sig = c.fx.layer === "rt" ? { ...sym.sig, params: sym.sig.params.slice(1) } : sym.sig;
      return callSig(c, sig, e, callee, want);
    }
    if (sym?.k === "class") { c.at("E2002", callee, `use 'new ${callee.text}(...)'`); return ERROR; }
    if (!sym) { unresolved(c, callee); return ERROR; }
  }
  if (callee.kind === K.PropertyAccessExpression) {
    const p = callee as ts.PropertyAccessExpression;
    if (isId(p.expression)) {
      const nsMod = lookupNs(c, p.expression);
      if (nsMod) {
        if (p.questionDotToken) { c.at("E2002", p.name, "'?.' cannot be used on a module namespace"); return ERROR; }
        if (nsMod.typeOnly) { c.at("E2002", p.expression, `'${p.expression.text}' is type-only and cannot be used as a value`, { kind: "type-only", name: p.expression.text }); return ERROR; }
        const sym = c.prog.lookupExportedValue(nsMod.mod, p.name.text);
        if (!sym) {
          if (c.prog.isExportedTypeOnly(nsMod.mod, p.name.text)) c.at("E2002", p.name, `'${p.name.text}' is type-only and cannot be used as a value`, { kind: "type-only", name: p.name.text });
          else c.at("E2001", p.name, `module '${p.expression.text}' has no exported value '${p.name.text}'`, { receiver: p.expression.text, member: p.name.text });
          return ERROR;
        }
        if (sym.k === "fn") return callFnSym(c, sym, e, p.name, want);
        if (sym.k === "class") { c.at("E2002", p.name, `use 'new ${p.expression.text}.${p.name.text}(...)'`); return ERROR; }
        if (sym.k === "const") {
          const ct = unref(sym.type);
          if (ct.k === "fn") return callSig(c, ct, e, p.name, want);
          if (!isErr(ct)) c.at("E2002", p.name, `'${show(ct)}' is not callable`);
          return ERROR;
        }
        if (sym.k === "jsref") { c.at("E2002", p.name, `'JsRef' is not callable`); return ERROR; }
        return ERROR;
      }
    }
    if (isId(p.expression) && p.expression.text === "Resource" && !c.scope.lookup("Resource") && !c.prog.lookupValue(c.mod, "Resource")) return resourceCall(c, e, p, want);
    if (isId(p.expression) && p.expression.text === "Result" && !c.scope.lookup("Result") && !c.prog.lookupValue(c.mod, "Result")) return resultCall(c, e, p, want);
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
      const ring = isId(p.expression) && p.expression.text === "Ring" && isNamespace(c, p.expression);
      if ((vec && (p.name.text === "create" || p.name.text === "filled")) || ((pool || arena || ring) && p.name.text === "create") || (rt && unref(rt).k === "gen" && (unref(rt) as { name: string }).name === "Vec" && p.name.text === "push")) c.at("E4004", p.name, `'${p.name.text}' allocates`, { op: p.name.text });
      if (isId(p.expression) && p.expression.text === "Ptr" && isNamespace(c, p.expression) && p.name.text === "box") c.at("E4004", p.name, "'Ptr.box' allocates", { op: "Ptr.box" }); // §14.4
      if (rt && unref(rt).k === "gen" && (unref(rt) as { name: string }).name === "Ptr" && p.name.text === "unbox") c.at("E4004", p.name, "'unbox' allocates", { op: "unbox" }); // §14.4
    }
    if (m.kind === "error") return ERROR;
    const ns = isId(p.expression) && isNamespace(c, p.expression) ? p.expression.text : undefined;
    if (m.kind === "variadic") { // Math.min / Math.max (Q033, f32/f64 polymorphic)
      if (!e.arguments.length) { c.at("E2002", p.name, "expects at least one argument"); return ERROR; }
      if (e.typeArguments) { c.at("E2002", p.name, "expects 0 type argument(s)"); return ERROR; }
      const firstSpread = e.arguments.findIndex((a) => a.kind === K.SpreadElement);
      if (firstSpread >= 0 && !c.callAllowed("managed")) {
        c.at("E4001", e.arguments[firstSpread]!, "call spread '...' is managed-only", { callerLayer: c.fx.layer, calleeLayer: "managed" });
        return ERROR;
      }
      const cached: (Type | undefined)[] = [];
      let ft: FloatNum | undefined;
      let ftArg: ts.Expression | undefined;
      for (let i = 0; i < e.arguments.length; i++) {
        const a = e.arguments[i]!;
        if (a.kind === K.SpreadElement) {
          const sp = (a as ts.SpreadElement).expression;
          if (ctxSensitive(sp)) continue;
          const st = expr(c, sp);
          cached[i] = st;
          const re = restElem(unref(st));
          if (re && isFloatNum(re)) { ft = re; ftArg = a; break; }
          continue;
        }
        if (isLitOnly(a)) continue;
        const at = expr(c, a);
        cached[i] = at;
        if (isFloatNum(at)) { ft = at; ftArg = a; break; }
      }
      const target = ft ?? wantFloatType(want);
      for (let i = 0; i < e.arguments.length; i++) {
        const a = e.arguments[i]!;
        if (a.kind === K.SpreadElement) {
          const sp = (a as ts.SpreadElement).expression;
          const st = cached[i] ?? (sp.kind === K.ArrayLiteralExpression ? checkTo(c, sp, gen("Array", target), true) : expr(c, sp));
          if (isErr(st)) continue;
          const re = restElem(unref(st));
          if (!re) { c.at("E2002", a, `spread argument '...' must have type 'Array<T>' or 'ReadonlyArray<T>', got '${show(st)}'`, { actual: show(st) }); continue; }
          if (isFloatNum(re)) {
            if (re.name !== target.name) c.at("E2003", a, `cannot mix '${target.name}' and '${re.name}'`, { left: target.name, right: re.name });
          } else if (!isErr(re)) {
            c.at("E2002", a, `expected '${target.name}', got '${show(re)}'`, { expected: target.name, actual: show(re) });
          }
          continue;
        }
        if (isLitOnly(a)) { checkTo(c, a, target, true); continue; }
        const at = cached[i] ?? expr(c, a);
        if (isErr(at)) continue;
        if (isFloatNum(at)) {
          if (at.name !== target.name) {
            c.at("E2003", a, `cannot mix '${target.name}' and '${at.name}'`, { left: target.name, right: at.name });
            const d = c.prog.rep.out.at(-1);
            if (d?.code === "E2003") {
              attachLitLetFix(c, d, a, target);
              if (ftArg) attachLitLetFix(c, d, ftArg, at);
            }
          }
        } else {
          c.at("E2002", a, `expected '${target.name}', got '${show(at)}'`, { expected: target.name, actual: show(at) });
          attachConvertFix(c, a, at, target);
        }
      }
      return target;
    }
    if (m.kind === "method") {
      if (ns === "Math" && MATH_POLY.has(p.name.text)) {
        if (e.arguments.length !== 1) { c.at("E2002", p.name, `expects 1 argument(s), got ${e.arguments.length}`); return ERROR; }
        if (e.typeArguments) { c.at("E2002", p.name, "expects 0 type argument(s)"); return ERROR; }
        return floatPolyArg(c, e.arguments[0]!, wantFloatType(want));
      }
      if (ns === "Number" && NUMBER_POLY.has(p.name.text)) {
        if (e.arguments.length !== 1) { c.at("E2002", p.name, `expects 1 argument(s), got ${e.arguments.length}`); return ERROR; }
        if (e.typeArguments) { c.at("E2002", p.name, "expects 0 type argument(s)"); return ERROR; }
        floatPolyArg(c, e.arguments[0]!, F64 as FloatNum);
        return BOOL;
      }
      const rt0 = exprTypes.get(p.expression);
      const recvGen = rt0 && unref(rt0).k === "gen" ? (unref(rt0) as { name: string }).name : undefined;
      if (p.name.text === "isolate" && rt0 && unref(rt0).k === "opaque" && ((unref(rt0) as { name: string }).name === "Spawn" || (unref(rt0) as { name: string }).name === "FakeSpawn")) return isolateCall(c, e, p); // §15.2
      if (p.name.text === "open" && rt0 && unref(rt0).k === "opaque" && ((unref(rt0) as { name: string }).name === "Audio" || (unref(rt0) as { name: string }).name === "FakeAudio")) return audioOpenCall(c, e, p); // §15.5
      if (p.name.text === "recv" && recvGen === "Port") {
        const R = (unref(rt0!) as { args: Type[] }).args[1]!;
        // §15.2 / §5.6: with an owned R, whether the Promise may sit here is P3's E3007 to judge, not Q130's E2002
        if (holdsOwned(R) || ownedDeep(R)) promiseOk.add(e);
      }
      if ((m.managedOnly || m.layer === "managed") && !c.callAllowed("managed")) c.at("E4001", p.name, `'${p.name.text}' is managed-only`, { callerLayer: c.fx.layer, calleeLayer: "managed" }); // Q044
      if (m.sig.tcheck === "trap" && e.arguments[0]) trapCode(c, e.arguments[0], p.name.text);
      unsafeOp(c, p);
      if (e.questionDotToken) {
        c.at("E2002", p.name, "'?.' cannot be used to call a method directly; call it normally or via 'o?.m()'");
        return ERROR;
      }
      return callSig(c, m.sig, e, p.name, want);
    }
    if (e.questionDotToken) {
      if (!c.callAllowed("managed")) { c.at("E4001", e, "'?.()' is managed-only", { callerLayer: c.fx.layer, calleeLayer: "managed" }); return ERROR; }
      const nn = nonNull(m.type);
      if (!nn) { c.at("E2002", p.name, "'?.()' needs a nullable callee"); return ERROR; }
      const fnT = unref(nn);
      if (fnT.k === "fn") {
        const r = callSig(c, fnT, e, p.name, want);
        return isErr(r) ? ERROR : nullable(r);
      }
      if (!isErr(fnT)) c.at("E2002", p.name, `'${show(m.type)}' is not callable`);
      return ERROR;
    }
    if (p.questionDotToken && (e.flags & NodeFlags.OptionalChain) && m.optRaw && unref(m.optRaw).k === "fn") {
      const r = callSig(c, unref(m.optRaw) as FnType, e, p.name, want);
      return isErr(r) ? ERROR : nullable(r);
    }
    if (m.type.k === "fn") return callSig(c, m.type, e, p.name, want);
    if (!isErr(m.type)) c.at("E2002", p.name, `'${show(m.type)}' is not callable`);
    return ERROR;
  }
  if (isId(callee)) fnCalleeIds.add(callee);
  const t0 = expr(c, callee);
  if (e.questionDotToken) {
    if (!c.callAllowed("managed")) { c.at("E4001", e, "'?.()' is managed-only", { callerLayer: c.fx.layer, calleeLayer: "managed" }); return ERROR; }
    const nn = isErr(t0) ? undefined : nonNull(t0);
    if (!isErr(t0) && !nn) { c.at("E2002", callee, "'?.()' needs a nullable callee"); return ERROR; }
    const fnT = nn ? unref(nn) : ERROR;
    if (fnT.k === "fn") {
      const r = callSig(c, fnT, e, callee, want);
      return isErr(r) ? ERROR : nullable(r);
    }
    if (!isErr(fnT)) c.at("E2002", callee, `'${show(t0)}' is not callable`);
    return ERROR;
  }
  const t = unref(t0);
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
  const firstSpread = args.findIndex((a) => a.kind === K.SpreadElement);
  if (firstSpread >= 0) {
    if (!c.callAllowed("managed")) {
      c.at("E4001", args[firstSpread]!, "call spread '...' is managed-only", { callerLayer: c.fx.layer, calleeLayer: "managed" });
      return ERROR;
    }
    if (!sig.rest || firstSpread < sig.params.length) {
      c.at("E2002", args[firstSpread]!, sig.rest ? "spread argument '...' cannot appear before fixed parameters" : "spread argument '...' is only valid for a rest parameter", { kind: "spread-non-rest" });
      return ERROR;
    }
  }
  const min = sig.min ?? sig.params.length;
  if (args.length < min || (!sig.rest && args.length > sig.params.length)) {
    const expStr = sig.rest ? `at least ${min}` : (min === sig.params.length ? `${min}` : `${min}-${sig.params.length}`);
    c.at("E2002", anchor, `expects ${expStr} argument(s), got ${args.length}`);
    return ERROR;
  }
  const restEl = sig.rest ? restElem(sig.rest) : undefined;
  const paramType = (a: ts.Expression, i: number): Type =>
    i < sig.params.length ? sig.params[i]! : (restEl ? (a.kind === K.SpreadElement ? gen("ReadonlyArray", restEl) : restEl) : ERROR);
  const argNode = (a: ts.Expression): ts.Expression => (a.kind === K.SpreadElement ? (a as ts.SpreadElement).expression : a);
  const ids = new Set(sig.tparams.map((p) => p.id));
  const m = new Map<number, Type>();
  if (e.typeArguments) for (const t of e.typeArguments) c.walkTypePos(t, sig.tcheck === "castptr" || sig.tcheck === "ptrnull" || sig.tcheck === "ptrsizeof" ? "ptrarg" : sig.tcheck === "chandle" ? "chandlearg" : "typearg", { unsafe: c.fx.unsafe, cdecl: false }); // §14.4, §14.5; Q219: cast / CHandle targets are pointees
  if (e.typeArguments) {
    if (e.typeArguments.length !== sig.tparams.length) { c.at("E2002", anchor, `expects ${sig.tparams.length} type argument(s)`); return ERROR; }
    sig.tparams.forEach((p, i) => m.set(p.id, c.typeOf(e.typeArguments![i]!, sig.tcheck === "castptr" || sig.tcheck === "chandle" || sig.tcheck === "ptrnull" || sig.tcheck === "ptrsizeof"))); // Q217, §14.5: pointees may be void
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
      const p = paramType(a, i);
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
    const p = paramType(a, i), x = argNode(a);
    if (!open(p)) { checkTo(c, x, unref(subst(p, m)), true); done[i] = true; }
    else if (!isFnExpr(x) && !ctxSensitive(x)) { const t = expr(c, x); unify(unref(p), t, m, ids); later[i] = t; }
  });
  const needsArrowParamBind = (): boolean => args.some((a, i) => {
    if (done[i] || later[i]) return false;
    const x = argNode(a);
    if (!isFnExpr(x)) return false;
    if (!x.parameters.some((p) => !p.type)) return false;
    const sp = unref(subst(paramType(a, i), m));
    if (sp.k !== "fn") return false;
    return x.parameters.some((p, pi) => !p.type && !!(p.dotDotDotToken ? sp.rest : sp.params[pi]) && hasTParam((p.dotDotDotToken ? sp.rest! : sp.params[pi]!), ids));
  });
  if (needsArrowParamBind()) {
    if (want && sig.tparams.some((p) => !m.has(p.id))) unify(sig.ret, want, m, ids);
    if (needsArrowParamBind()) {
      args.forEach((a, i) => {
        const x = argNode(a);
        if (done[i] || later[i] || isFnExpr(x)) return;
        const p = paramType(a, i);
        if (!open(p)) { checkTo(c, x, unref(subst(p, m)), true); done[i] = true; }
        else { const t = expr(c, x); unify(unref(p), t.k === "lit" ? STR : t, m, ids); later[i] = t; }
      });
    }
  }
  if (want && sig.ret.k === "tparam" && ids.has(sig.ret.p.id) && !m.has(sig.ret.p.id)) {
    const retId = new Set([sig.ret.p.id]);
    const inFnParam = sig.params.some((sp) => {
      const u = unref(sp);
      return u.k === "fn" && u.params.some((pt) => hasTParam(pt, retId));
    });
    if (!inFnParam) unify(sig.ret, want, m, ids);
  }
  args.forEach((a, i) => { // 2: function expressions
    const x = argNode(a);
    if (done[i] || later[i] || !isFnExpr(x)) return;
    const rawP = paramType(a, i);
    const p = unref(subst(rawP, m));
    const t = checkArrow(c, x, p.k === "fn" ? p : undefined, p.k === "fn" && hasTParam(p.ret, ids), ids);
    unify(unref(rawP), t, m, ids);
    later[i] = t;
  });
  if (want && sig.tparams.some((p) => !m.has(p.id))) unify(sig.ret, want, m, ids); // 3: the context
  args.forEach((a, i) => { // 4: literals
    if (done[i] || later[i]) return;
    const p = paramType(a, i), x = argNode(a);
    if (open(p)) { const t = expr(c, x); unify(unref(p), t.k === "lit" ? STR : t, m, ids); later[i] = t; }
    else { checkTo(c, x, unref(subst(p, m)), true); done[i] = true; }
  });
  const unbound = sig.tparams.filter((p) => !m.has(p.id));
  if (unbound.length) {
    c.at("E2006", anchor, `cannot infer type argument(s) ${unbound.map((p) => p.name).join(", ")}`, { kind: "infer-type-args", tparams: unbound.map((p) => p.name) });
    return ERROR;
  }
  for (const [i, p] of sig.tparams.entries()) { // `T extends I` (§3.2)
    const b = m.get(p.id)!;
    if (p.constraint && !isErr(b) && !assignable(b, subst(p.constraint, m))) {
      c.at("E2002", e.typeArguments?.[i] ?? anchor, `'${show(b)}' does not implement '${show(p.constraint)}'`, { expected: show(p.constraint), actual: show(b) });
      return ERROR;
    }
  }
  const tc = sig.tcheck;
  if (tc && tc !== "trap" && sig.tparams[0]) { // Q084, Q086; §14.4 / §14.5 / SPEC-v1 §3.4
    const b = m.get(sig.tparams[0].id)!;
    const targ = e.typeArguments?.[0] ?? anchor;
    if (tc === "box") { // the anchor is the type argument, or the boxed value (DIAGNOSTICS E4007)
      if (!isErr(b) && !boxable(b)) { c.at("E4007", e.typeArguments?.[0] ?? args[1] ?? anchor, `'${show(b)}' cannot be boxed`, { actual: show(b) }); return ERROR; }
    } else if (tc === "chandle") {
      if (!isErr(b) && (b.k === "fn" || hasPtr(b))) { c.at("E4008", targ, `'${show(b)}' cannot sit inside CHandle`, { actual: show(b) }); return ERROR; }
      if (!isErr(b) && !ptrTargetOk(b)) { c.at("E4007", targ, `'${show(b)}' cannot sit inside CHandle`, { actual: show(b) }); return ERROR; }
    } else if (tc === "castptr") {
      if (!isErr(b) && (b.k === "fn" || !ptrTargetOk(b))) { c.at("E2001", targ, `cannot cast a pointer to '${show(b)}'`, { actual: show(b) }); return ERROR; }
    } else if (tc === "ptrnull") {
      if (!isErr(b) && b.k !== "fn" && !ptrTargetOk(b)) { c.at("E4007", targ, `'${show(b)}' cannot sit behind Ptr`, { actual: show(b) }); return ERROR; }
    } else if (tc === "ptrsizeof") {
      const okSize = isErr(b) || b.k === "cstruct" || (b.k === "gen" && (b.name === "CType" || b.name === "Ptr" || b.name === "ConstPtr")) ||
        (hasCap(b, "Copy") && hasCap(b, "Native") && hasLayout(b));
      if (!okSize) { c.at("E4007", targ, `'Ptr.sizeOf' cannot size '${show(b)}'`, { actual: show(b) }); return ERROR; }
      if (b.k === "gen" && b.name === "CType" && b.args[0]?.k === "lit") c.prog.ptrSizeOfs.push({ mod: c.mod, node: targ, cname: b.args[0].value });
    } else if (tc === "ring") { // §15.1 (Q199, Q210): the element is Copy+Native (E4002) and not ArenaBuf (and generic ring elements need Send)
      if (!isErr(b) && (!hasCap(b, "Copy") || !hasCap(b, "Native") || !hasLayout(b))) { c.at("E4002", targ, `'${show(b)}' is not allowed as the type argument here`, { requiredCap: "Copy & Native", actual: show(b) }); return ERROR; }
      if (!isErr(b) && (hasArenaBuf(b) || (collectTParams(b).length > 0 && !sendable(b)))) { c.at("E2002", targ, `a ring element cannot be or contain an ArenaBuf, and generic ring elements need 'Send', not '${show(b)}'`, { actual: show(b) }); return ERROR; }
    } else if (tc === "alloc") { // Q215 (c): no type parameter in the element, so JS and C size it alike; then Copy+Native (E4002)
      if (!isErr(b) && collectTParams(b).length) { c.at("E2002", targ, `the element of 'alloc' cannot be or contain a type parameter, not '${show(b)}'`, { reason: "concrete-type-required", actual: show(b) }); return ERROR; }
      if (!isErr(b) && (!isCopy(b) || !isNative(b) || !hasLayout(b))) { c.at("E4002", targ, `'${show(b)}' is not allowed as the type argument here`, { requiredCap: "Copy & Native", actual: show(b) }); return ERROR; }
    } else if (tc === "copy") {
      if (!isErr(b) && (!hasCap(b, "Copy") || !hasCap(b, "Native") || !hasLayout(b))) { c.at("E4002", targ, `'${show(b)}' is not allowed as the type argument here`, { requiredCap: "Copy & Native", actual: show(b) }); return ERROR; }
    } else if (tc === "eq") {
      if (!isErr(b) && !comparable(b)) { c.at("E2002", targ, `'${show(b)}' is not allowed as the type argument here`, { requiredCap: "Copy", actual: show(b) }); return ERROR; }
    } else if (tc === "codec") {
      if (!isErr(b) && !castable(b)) { c.at("E2002", targ, `'${show(b)}' is not allowed as the type argument here`, { requiredCap: "Codec", actual: show(b) }); return ERROR; }
    } else if (tc === "jsonstringify") {
      if (!isErr(b)) {
        if (collectTParams(b).length > 0) {
          c.at("E2002", targ, `'${show(b)}' contains a type parameter; JSON.stringify requires a concrete JSON-serializable Codec type without i64/u64`, { reason: "concrete-type-required", actual: show(b), requiredCap: "Codec" });
          return ERROR;
        }
        if (!castable(b)) {
          c.at("E2002", targ, `'${show(b)}' is not allowed as the type argument here`, { requiredCap: "Codec", actual: show(b) });
          return ERROR;
        }
        if (hasInt64(b)) {
          c.at("E2002", targ, `'${show(b)}' contains i64/u64, which JSON.stringify cannot serialize; convert to string or f64 first`, { reason: "json-int64", actual: show(b) });
          return ERROR;
        }
      }
    } else if (tc === "cast") {
      if (!isErr(b)) {
        if (collectTParams(b).length > 0) {
          c.at("E2002", targ, `'${show(b)}' contains a type parameter; a concrete Codec type is required here (managed generics are erased)`, { reason: "concrete-type-required", actual: show(b), requiredCap: "Codec" });
          return ERROR;
        }
        if (!castable(b)) {
          c.at("E2002", targ, `'${show(b)}' does not satisfy 'Codec' and cannot be checked or decoded at run time`, { reason: "missing-capability", actual: show(b), requiredCap: "Codec" });
          return ERROR;
        }
      }
    } else if (tc === "owned") {
      if (!isErr(b) && !isOwnedCap(b)) { c.at("E2002", targ, `'${show(b)}' must be an Owned type`, { requiredCap: "Owned", actual: show(b) }); return ERROR; }
    }
  }
  args.forEach((a, i) => {
    const t = later[i];
    if (!t || isErr(t)) return;
    const p = unref(subst(paramType(a, i), m));
    if (!assignable(t, p, true)) c.at("E2002", argNode(a), `expected '${show(p)}', got '${show(t)}'`);
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
        c.at("E4001", a, `a ${c.fx.layer} function parameter cannot be passed to an rt function parameter`, { callerLayer: c.fx.layer, calleeLayer: target });
      const idx = c.fn.sig.params.findIndex((p, i) => unref(p).k === "fn" && c.fn!.decl.parameters[i]?.name.kind === K.Identifier && (c.fn!.decl.parameters[i]!.name as ts.Identifier).text === a.text);
      if (idx >= 0) return { ref: { param: idx }, t: local.declared };
    }
  }
  const fnRef = lookupModuleFn(c, a);
  if (fnRef.sym) {
    const sym = fnRef.sym;
    if (sym.sig.tparams.length) { c.at("E4003", a, `the generic function '${sym.name}' cannot be used as a function argument`); return undefined; }
    if (sym.layer === "rt" && sym.unsafe) { c.at("E4001", a, `the rt + unsafe function '${sym.name}' can only be passed to 'cfn'`, { callerLayer: c.fx.layer, calleeLayer: "rt+unsafe" }); return undefined; } // §14.6
    if (sym.layer === "managed" || (target === "rt" && sym.layer !== "rt"))
      c.at("E4001", a, `a ${target} function parameter cannot take the ${sym.layer} function '${sym.name}'`, { callerLayer: c.fx.layer, calleeLayer: sym.layer });
    return { ref: { fn: sym }, t: sym.sig };
  }
  if (fnRef.typeOnly) {
    c.at("E2002", a, `'${fnRef.typeOnly}' is type-only and cannot be used as a value`, { kind: "type-only", name: fnRef.typeOnly });
    return undefined;
  }
  c.at("E4003", a, "a function argument must be the name of a module-level strict / rt function or a function parameter of the caller");
  return undefined;
}

function hasBitOp(e: ts.Expression): boolean {
  switch (e.kind) {
    case K.ParenthesizedExpression: return hasBitOp((e as ts.ParenthesizedExpression).expression);
    case K.PrefixUnaryExpression: {
      const u = e as ts.PrefixUnaryExpression;
      return u.operator === K.TildeToken || hasBitOp(u.operand);
    }
    case K.BinaryExpression: {
      const b = e as ts.BinaryExpression;
      return BIT_OPS.has(b.operatorToken.kind) || hasBitOp(b.left) || hasBitOp(b.right);
    }
    default: return false;
  }
}

function exactIntLit(c: Checker, e: ts.Expression, target: NumName): boolean {
  let cur = e;
  while (cur.kind === K.ParenthesizedExpression) cur = (cur as ts.ParenthesizedExpression).expression;
  if (cur.kind === K.ConditionalExpression) {
    const ce = cur as ts.ConditionalExpression;
    return exactIntLit(c, ce.whenTrue, target) && exactIntLit(c, ce.whenFalse, target);
  }
  if (isLitOnly(cur) && hasBitOp(cur)) return true;
  let neg = false;
  if (cur.kind === K.PrefixUnaryExpression && (cur as ts.PrefixUnaryExpression).operator === K.MinusToken) {
    neg = true;
    cur = (cur as ts.PrefixUnaryExpression).operand;
  }
  if (cur.kind !== K.NumericLiteral) return false;
  const raw = cur.getText(c.fx.mod.sf);
  if (raw.includes(".") || (!/^0[xXbBoO]/.test(raw) && /[eE]/.test(raw))) return false;
  return intLiteralFits(parseExactInt(raw, neg), target);
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
    const target = name as NumName;
    const wantArg = isInt(num(target)) && exactIntLit(c, args[0]!, target) ? num(target) : undefined;
    const t = expr(c, args[0]!, wantArg);
    if (!isErr(t) && !isNum(t)) c.at("E2002", args[0]!, `cannot convert '${show(t)}'`);
    return num(target);
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
    case "cfn": { // §14.6: the name of a module-level rt function, as a Ptr to it
      c.noteUnsafeOp(callee); // §14.4.4
      if (!c.fx.unsafe) c.at("E4008", callee, "'cfn' can only be used in a function with 'use unsafe'", { op: "cfn" });
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
      const fnRef = lookupModuleFn(c, a);
      if (!fnRef.sym) {
        if (fnRef.typeOnly) c.at("E2002", a, `'${fnRef.typeOnly}' is type-only and cannot be used as a value`, { kind: "type-only", name: fnRef.typeOnly });
        else c.at("E4003", a, "'cfn' takes the name of a module-level rt function", { kind: "cfn-arg" });
        return ERROR;
      }
      const sym = fnRef.sym;
      if (sym.sig.tparams.length) { c.at("E4003", a, `'cfn' cannot take the generic function '${sym.name}'`, { kind: "generic-fn", name: sym.name }); return ERROR; }
      if (sym.sig.min !== undefined) { c.at("E4003", a, `'cfn' cannot take '${sym.name}' because it has default parameters`); return ERROR; }
      if (sym.layer !== "rt") { c.at("E4001", a, `'cfn' takes an rt function, not the ${sym.layer} function '${sym.name}'`, { callerLayer: c.fx.layer, calleeLayer: sym.layer }); return ERROR; }
      if (sym.sig.params.some((p) => !boundary(p)) || !(boundary(sym.sig.ret) || (sym.sig.ret.k === "prim" && sym.sig.ret.name === "void"))) {
        c.at("E4007", a, `the signature of '${sym.name}' cannot cross the C boundary`, { actual: show(sym.sig) });
        return ERROR;
      }
      return gen("Ptr", sym.sig);
    }
    case "panic":
      if (args[0]?.kind === K.StringLiteral || args[0]?.kind === K.NoSubstitutionTemplateLiteral) panicLits.add(args[0]); // Q042
      if (arity(1)) checkTo(c, args[0]!, STR);
      return NEVER;
    case "cast": { // §3.2
      if (!c.callAllowed("managed")) c.at("E4001", callee, "'cast' is managed-only", { callerLayer: c.fx.layer, calleeLayer: "managed" });
      if (!arity(1)) return ERROR;
      let t: Type | undefined;
      if (e.typeArguments?.length === 1) t = c.typeOf(e.typeArguments[0]!);
      else if (want) t = resultParts(want)?.ok;
      checkTo(c, args[0]!, UNKNOWN);
      if (!t) { c.at("E2006", callee, "cannot infer the type argument of 'cast'", { kind: "cast" }); return ERROR; }
      if (!isErr(t) && ownedDeep(t)) return ERROR; // P2 (modules.ts) already reported E3007 on the type argument
      if (!isErr(t)) {
        const targ = e.typeArguments?.[0] ?? callee;
        if (collectTParams(t).length > 0) {
          c.at("E2002", targ, `'${show(t)}' contains a type parameter; a concrete Codec type is required here (managed generics are erased)`, { reason: "concrete-type-required", actual: show(t), requiredCap: "Codec" });
          return ERROR;
        }
        if (!castable(t)) {
          c.at("E2002", targ, `'${show(t)}' does not satisfy 'Codec' and cannot be checked or decoded at run time`, { reason: "missing-capability", actual: show(t), requiredCap: "Codec" });
          return ERROR;
        }
      }
      return result(t, ERROR_RECORD);
    }
    case "requires": case "invariant": case "ensures": {
      if (!arity(1)) return VOID;
      const saved = c.fx.contract;
      c.fx.contract = { kind: name, depth: c.fx.depth };
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
      const t = checkArrow(c, f, fn([opaque("Test")], VOID), true);
      if (!isErr(t.params[0]!) && !same(t.params[0]!, opaque("Test"))) c.at("E2002", f.parameters[0]!.type ?? f, "test body takes 't: Test'");
      return VOID;
    }
    case "forAll": case "fuzzContracts": { // §16.1, Q273, Q274
      const isFuzz = name === "fuzzContracts";
      if (c.fx.contract) { c.at("E6002", callee, `'${name}' cannot be used inside a contract`, { kind: "forAll-in-contract" }); return ERROR; }
      if (e.typeArguments) { c.at("E2002", callee, `'${name}' takes no type arguments`); return VOID; }
      if (!arity(1)) return VOID;
      const a = args[0]!;
      const checkParams = (ps: Type[], anchor: (i: number) => Node): boolean => {
        let bad = false;
        ps.forEach((p, i) => {
          if (!hasErr(p) && !isGeneratable(p)) {
            c.at("E6005", anchor(i), `parameter type '${show(p)}' cannot be generated by '${name}'`, { type: show(p) });
            bad = true;
          }
        });
        return !bad;
      };
      if (!isFuzz && isFnExpr(a)) {
        if (a.modifiers?.some((m) => m.kind === K.AsyncKeyword)) { c.at("E2002", a, "'forAll' callback cannot be async"); return VOID; }
        if (a.typeParameters?.length) { c.at("E2002", a, "'forAll' callback cannot be generic"); return VOID; }
        if (!a.parameters.length) { c.at("E2002", a, "'forAll' function must have at least one parameter"); return VOID; }
        const sig = checkArrow(c, a, undefined, true);
        if (sig.rest) { c.at("E2002", a, "'forAll' does not support rest parameters"); return VOID; }
        if (!isErr(sig.ret) && !isBool(sig.ret) && !(sig.ret.k === "prim" && sig.ret.name === "void")) {
          c.at("E2002", a, `'forAll' callback must return 'boolean' or 'void', got '${show(sig.ret)}'`);
          return VOID;
        }
        if (checkParams(sig.params, (i) => a.parameters[i]!.type ?? a.parameters[i]!.name)) forAllMeta.set(e, { params: sig.params, checkBool: true });
        return VOID;
      }
      if (isFuzz && isFnExpr(a)) {
        c.at("E2002", a, "'fuzzContracts' takes a module-level function name; use 'forAll((...) => ...)' for inline predicates");
        return VOID;
      }
      const fnRef = lookupModuleFn(c, a);
      if (fnRef.typeOnly) { c.at("E2002", a, `'${fnRef.typeOnly}' is type-only and cannot be used as a value`, { kind: "type-only", name: fnRef.typeOnly }); return VOID; }
      if (fnRef.missingProp) {
        c.at("E2001", fnRef.missingProp.name, `module '${(fnRef.missingProp.expression as ts.Identifier).text}' has no exported value '${fnRef.missingProp.name.text}'`, { receiver: (fnRef.missingProp.expression as ts.Identifier).text, member: fnRef.missingProp.name.text });
        return VOID;
      }
      if (!isFuzz) {
        if (fnRef.sym?.k === "fn") {
          const fnSym = fnRef.sym;
          const msg = isBool(fnSym.sig.ret)
            ? `'forAll' takes an inline predicate '(a: A, ...) => boolean | void', not function '${fnSym.name}'; wrap as '(...) => ${fnSym.name}(...)' to assert its boolean result, or use 'fuzzContracts(${fnSym.name})' to fuzz contracts/traps only`
            : `'forAll' takes an inline predicate '(a: A, ...) => boolean | void', not function '${fnSym.name}'; use 'fuzzContracts(${fnSym.name})' to fuzz its contracts and traps`;
          c.at("E2002", a, msg);
          return VOID;
        }
        if (isId(a) && !c.scope.lookup(a.text) && !fnRef.nonFn) { unresolved(c, a); return VOID; }
        c.at("E2002", a, "'forAll' takes an inline predicate '(a: A, ...) => boolean | void' (use 'fuzzContracts(fn)' for module-level functions)");
        return VOID;
      }
      const sym = fnRef.sym ?? fnRef.nonFn;
      if (!sym) { if (isId(a) && !c.scope.lookup(a.text)) unresolved(c, a); else c.at("E2002", a, "'fuzzContracts' takes a module-level function name (use 'forAll((...) => ...)' for inline predicates)"); return VOID; }
      if (sym.k === "cfn") { c.at("E4003", a, `the C function '${sym.name}' cannot be passed to 'fuzzContracts'`, { kind: "cfn-in-forAll", name: sym.name }); return VOID; }
      if (sym.k !== "fn") { c.at("E2002", a, `'${a.getText(c.fx.mod.sf)}' is not a function`); return VOID; }
      if (sym.sig.tparams.length) { c.at("E2002", a, `'fuzzContracts' cannot take generic function '${sym.name}'`); return VOID; }
      if (sym.layer === "rt" && sym.unsafe) { c.at("E4001", a, `the rt + unsafe function '${sym.name}' cannot be passed to 'fuzzContracts'`, { callerLayer: c.fx.layer, calleeLayer: "rt+unsafe" }); return VOID; }
      if (sym.unsafe) { c.at("E4008", a, `the unsafe function '${sym.name}' cannot be passed to 'fuzzContracts'`, { op: sym.name }); return VOID; }
      if (hasPromise(sym.sig.ret)) { c.at("E2002", a, "'fuzzContracts' does not support async functions or Promise returns"); return VOID; }
      if (sym.sig.rest) { c.at("E2002", a, "'fuzzContracts' does not support rest parameters"); return VOID; }
      if (!sym.sig.params.length) { c.at("E2002", a, "'fuzzContracts' function must have at least one parameter"); return VOID; }
      if (checkParams(sym.sig.params, () => a)) forAllMeta.set(e, { params: sym.sig.params, checkBool: false });
      return VOID;
    }
  }
  throw new Error(`P2: unhandled builtin '${name}'`);
}

/**
 * Q232: a contract cannot call a builtin method whose `contract` is false, judged by the receiver's type (not the name).
 * A user interface / class / record-field method is not banned here. Fail closed: a receiver whose type is unknown,
 * an error, or not one of the kinds below falls back to the name over every builtin receiver (`contractBanned`).
 */
function bannedCall(c: Checker, p: ts.PropertyAccessExpression, recv: Type | undefined): boolean {
  const n = p.name.text;
  const bad = (m: Member | "variadic" | undefined): boolean => m !== undefined && m !== "variadic" && m.kind === "method" && !m.fx.contract;
  const by = (t: Type): boolean => {
    t = unref(t);
    switch (t.k) {
      case "class": case "iface": case "record": case "tuple": case "fn": return false;
      case "union": return t.members.some(by); // `T | null` and unions of builtins: banned when any member is
      case "tparam": return t.p.constraint ? by(t.p.constraint) : contractBanned().has(n);
      case "gen": return bad(genMember(t, n));
      case "opaque": return bad(opaqueMember(t.name, n));
      case "prim": case "lit": return isStr(t) ? bad(stringMember(n)) : t.k === "prim" && t.name === "null" ? false : contractBanned().has(n);
      default: return contractBanned().has(n);
    }
  };
  if (!recv) {
    if (isId(p.expression)) {
      const id = p.expression.text;
      if (c.mod.nsImports.has(id)) return false;
      if (NAMESPACES.has(id)) return bad(nsMember(id, n)); // a namespace (`Vec`, `Math`) has no type
      return c.prog.lookupValue(c.mod, id)?.k === "class" ? false : contractBanned().has(n); // a static call on a user class (Q232)
    }
    if (p.expression.kind === K.PropertyAccessExpression && isId((p.expression as ts.PropertyAccessExpression).expression)) {
      const outer = p.expression as ts.PropertyAccessExpression;
      const ns = lookupNs(c, outer.expression as ts.Identifier);
      if (ns && !ns.typeOnly && c.prog.lookupExportedValue(ns.mod, outer.name.text)?.k === "class") return false;
    }
    return contractBanned().has(n);
  }
  return by(recv);
}

/** Q134: a contract only observes. Assignments and mutating builtin calls inside it are E6002; user calls are not analysed. */
function observeOnly(c: Checker, root: Node): void {
  const walk = (n: Node): void => {
    if (n.kind === K.BinaryExpression && (COMPOUND[(n as ts.BinaryExpression).operatorToken.kind] !== undefined || (n as ts.BinaryExpression).operatorToken.kind === K.EqualsToken || (n as ts.BinaryExpression).operatorToken.kind === K.QuestionQuestionEqualsToken)) {
      c.at("E6002", n, "a contract cannot assign");
    } else if ((n.kind === K.PrefixUnaryExpression || n.kind === K.PostfixUnaryExpression) && [K.PlusPlusToken, K.MinusMinusToken].includes((n as ts.PrefixUnaryExpression).operator)) {
      c.at("E6002", n, "a contract cannot assign");
    } else if (n.kind === K.CallExpression && (n as ts.CallExpression).expression.kind === K.PropertyAccessExpression) {
      const p = (n as ts.CallExpression).expression as ts.PropertyAccessExpression;
      if (bannedCall(c, p, exprTypes.get(p.expression))) c.at("E6002", p.name, `a contract cannot call '${p.name.text}'`);
    }
    const sig = n.kind === K.CallExpression || n.kind === K.NewExpression ? callSigs.get(n) : undefined;
    (n as ts.CallExpression).arguments?.forEach((a, i) => { // Q175: a contract neither consumes nor mutably borrows
      const p = sig ? (i < sig.params.length ? sig.params[i] : sig.rest ? restElem(sig.rest) : undefined) : undefined;
      if (!p) return;
      const mode = p.k === "gen" && (p.name === "Ref" || p.name === "Mut") ? p.name : undefined;
      const arg = a.kind === K.SpreadElement ? (a as ts.SpreadElement).expression : a;
      if (mode === "Mut" || (!mode && movesLike(unref(exprTypes.get(arg) ?? ERROR)))) c.at("E6002", a, mode ? "a contract cannot pass a Mut borrow" : "a contract cannot move a value");
    });
    n.forEachChild(walk);
  };
  walk(root);
}

function newExpr(c: Checker, e: ts.NewExpression, want: Type | undefined): Type {
  const id = e.expression;
  const checkClass = (sym: ValueSym, anchor: Node, label: string): Type => {
    if (sym.k === "class") {
      const cls = sym.cls;
      const self: Type = { k: "class", cls, args: cls.tparams.map((p) => ({ k: "tparam", p })) };
      return callSig(c, { ...cls.ctor, tparams: cls.tparams, ret: self }, e, anchor, want);
    }
    c.at("E2002", anchor, `'${label}' is not a class`);
    return ERROR;
  };
  if (id.kind === K.PropertyAccessExpression && isId((id as ts.PropertyAccessExpression).expression)) {
    const p = id as ts.PropertyAccessExpression;
    const ns = lookupNs(c, p.expression as ts.Identifier);
    if (ns) {
      if (p.questionDotToken) { c.at("E2002", p.name, "'?.' cannot be used on a module namespace"); return ERROR; }
      if (ns.typeOnly) { c.at("E2002", p.expression, `'${(p.expression as ts.Identifier).text}' is type-only and cannot be used as a value`, { kind: "type-only", name: (p.expression as ts.Identifier).text }); return ERROR; }
      const sym = c.prog.lookupExportedValue(ns.mod, p.name.text);
      if (!sym) {
        if (c.prog.isExportedTypeOnly(ns.mod, p.name.text)) c.at("E2002", p.name, `'${p.name.text}' is type-only and cannot be used as a value`, { kind: "type-only", name: p.name.text });
        else c.at("E2001", p.name, `module '${(p.expression as ts.Identifier).text}' has no exported value '${p.name.text}'`, { receiver: (p.expression as ts.Identifier).text, member: p.name.text });
        return ERROR;
      }
      return checkClass(sym, p.name, `${(p.expression as ts.Identifier).text}.${p.name.text}`);
    }
  }
  if (!isId(id)) { c.at("E2002", id, "'new' needs a class name"); return ERROR; }
  const sym = c.scope.lookup(id.text) ? undefined : c.prog.lookupValue(c.mod, id.text);
  if (sym) return checkClass(sym, id, id.text);
  if (!c.scope.lookup(id.text) && c.prog.isTypeOnlyValue(c.mod, id.text)) {
    c.at("E2002", id, `'${id.text}' is type-only and cannot be used as a value`, { kind: "type-only", name: id.text });
    return ERROR;
  }
  if ((id.text === "Map" || id.text === "Set") && !c.scope.lookup(id.text)) { // Q029
    if (e.arguments?.length) { c.at("E2001", id, `'new ${id.text}' takes no arguments`); return ERROR; }
    const n = id.text === "Map" ? 2 : 1;
    if (e.typeArguments) {
      if (e.typeArguments.length !== n) { c.at("E2002", id, `'${id.text}' takes ${n} type argument(s)`); return ERROR; }
      for (const t of e.typeArguments) c.walkTypePos(t, "typearg", { unsafe: c.fx.unsafe, cdecl: false }); // §14.4
      const targs = e.typeArguments.map((t) => c.typeOf(t));
      if (!keyOk(targs[0]!)) { c.at("E2002", e.typeArguments[0]!, `a ${id.text} ${id.text === "Map" ? "key" : "element"} is a string, number, boolean or string literal union`); return ERROR; } // Q081
      return gen(id.text, ...targs);
    }
    const w = want && (nonNull(want) ?? want);
    if (w?.k === "gen" && w.name === id.text) return w;
    if (w && isErr(w)) return ERROR;
    c.at("E2006", id, `cannot infer the type arguments of '${id.text}'`);
    return ERROR;
  }
  if (id.text === "RegExp" && !c.scope.lookup(id.text)) {
    c.at("E2002", id, `'new RegExp(...)' is not allowed; use a regex literal '/.../' or 'RegExp.compile(pattern, flags)'`);
    return ERROR;
  }
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
    case "read": case "write": case "offset":
      if (!hasCap(T, "Copy") && T.k !== "cstruct") bad();
      return;
    case "slice":
      if (!hasCap(T, "Copy")) bad();
      return;
    case "borrow": if (!borrowOk(T)) bad(); return;
    case "unbox": if (!boxable(T)) bad(); return;
  }
}
