// Stage 6 SMT-LIB2 verification condition generator, loop auto-invariant verifier, and function cache (Q289-Q292).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Diagnostic, Range } from "./diagnostics.ts";
import { DETMATH_PATH } from "./detmath.ts";
import { analyze, type Analysis } from "./index.ts";
import { callFns, exprTypes, localOf } from "./expr.ts";
import { canonPath, directiveOf, displayPath, type ConstSym, type FnSym, type LocalSym, type Module, type Program as Decls } from "./modules.ts";
import { CACHE_DIR } from "./names.ts";
import { NodeFlags, SyntaxKind as K, isId, type Node, type Parser, type ts } from "./parse.ts";
import { detectSolver, runSmtBatch, type SmtQuery, type SmtValue } from "./smt.ts";
import { trapSites, type TrapSite } from "./traps.ts";
import { isBool, isInt, isTaggedUnion, kindOf, nonNull, show, unref, type Type } from "./types.ts";

const PROVE_VERSION = "3";

export type ObligationKind = "T001" | "T002" | "T003" | "T004" | "T005" | "T007" | "T009" | "T010";
export type ObligationStatus = "proved" | "failed" | "unknown" | "timeout";

export interface ProveObligation {
  readonly kind: ObligationKind;
  readonly label: string;
  readonly range: Range;
  readonly status: ObligationStatus;
  readonly counterexample?: Record<string, SmtValue>;
}

export interface ProveFnResult {
  readonly file: string;
  readonly fn: string;
  readonly layer: string;
  readonly solver: string;
  readonly cached: boolean;
  readonly obligations: readonly ProveObligation[];
  readonly summary: { readonly proved: number; readonly failed: number; readonly unknown: number; readonly timeout: number };
  readonly remainingRtTrapSites?: readonly TrapSite[];
}

export interface ProvedChecks {
  readonly anchors: ReadonlySet<Node>;
  readonly provedPrivateRequires: ReadonlySet<FnSym>;
}

export interface ProveOptions {
  readonly all?: boolean;
  readonly cache?: boolean;
  readonly cacheFile?: string;
  readonly timeoutMs?: number;
  readonly analysis?: Analysis;
  readonly parser?: Parser;
  /** Canonical paths already proved in an earlier CLI entry file under `--all`. */
  readonly skipFiles?: ReadonlySet<string>;
}

export interface ProveResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly solver: string;
  readonly functions: readonly ProveFnResult[];
  readonly summary: {
    readonly functions: number;
    readonly proved: number;
    readonly failed: number;
    readonly unknown: number;
    readonly timeout: number;
    readonly cached: number;
  };
  readonly proved: ProvedChecks;
}

const INT_BOUNDS: Record<string, readonly [bigint, bigint, boolean, number]> = {
  i8: [-128n, 127n, true, 8],
  i16: [-32768n, 32767n, true, 16],
  i32: [-2147483648n, 2147483647n, true, 32],
  i64: [-9223372036854775808n, 9223372036854775807n, true, 64],
  u8: [0n, 255n, false, 8],
  u16: [0n, 65535n, false, 16],
  u32: [0n, 4294967295n, false, 32],
  u64: [0n, 18446744073709551615n, false, 64],
  usize: [0n, 4294967295n, false, 32],
};

const SEQ_CONTAINER = new Set(["Vec", "Slice", "Array", "ReadonlyArray", "ArenaBuf", "Pool"]);
const MAX_U32 = 4294967295n;
const INT_CONV = new Set(Object.keys(INT_BOUNDS));
const ARITH_ASSIGN: Partial<Record<K, "+" | "-" | "*">> = {
  [K.PlusEqualsToken]: "+",
  [K.MinusEqualsToken]: "-",
  [K.AsteriskEqualsToken]: "*",
};
const BIT_ASSIGN = new Set<K>([
  K.AmpersandEqualsToken, K.BarEqualsToken, K.CaretEqualsToken,
  K.LessThanLessThanEqualsToken, K.GreaterThanGreaterThanEqualsToken, K.GreaterThanGreaterThanGreaterThanEqualsToken,
]);
const SHIFT_ASSIGN = new Set<K>([
  K.LessThanLessThanEqualsToken, K.GreaterThanGreaterThanEqualsToken, K.GreaterThanGreaterThanGreaterThanEqualsToken,
]);
const truncDivSmt = (l: string, r: string, signed: boolean): string =>
  signed
    ? `(ite (>= ${l} 0) (ite (> ${r} 0) (div ${l} ${r}) (- (div ${l} (- ${r})))) (ite (> ${r} 0) (- (div (- ${l}) ${r})) (div (- ${l}) (- ${r}))))`
    : `(div ${l} ${r})`;
const truncRemSmt = (l: string, r: string, signed: boolean): string =>
  `(- ${l} (* ${r} ${truncDivSmt(l, r, signed)}))`;

const smtInt = (v: bigint): string => (v < 0n ? `(- ${-v})` : `${v}`);
const inBounds = (term: string, lo: bigint, hi: bigint): string => `(and (>= ${term} ${smtInt(lo)}) (<= ${term} ${smtInt(hi)}))`;
const isSignedInt = (t: Type): boolean => t.k === "num" && INT_BOUNDS[t.name]?.[2] === true;
const isContainer = (t: Type): boolean => {
  const u = unref(t);
  return u.k === "gen" && SEQ_CONTAINER.has(u.name);
};
const isStrLitLike = (t: Type): boolean => {
  const u = unref(t);
  if (u.k === "lit") return true;
  return u.k === "union" && u.members.length > 0 && u.members.every((m) => unref(m).k === "lit");
};

function strip(e: ts.Expression): ts.Expression {
  while (e.kind === K.ParenthesizedExpression || e.kind === K.SatisfiesExpression) {
    e = e.kind === K.ParenthesizedExpression ? (e as ts.ParenthesizedExpression).expression : (e as ts.SatisfiesExpression).expression;
  }
  return e;
}

function intLitValue(e: ts.Expression, sf: ts.SourceFile): bigint | undefined {
  const s = strip(e);
  if (s.kind === K.NumericLiteral) {
    const raw = s.getText(sf).replace(/_/g, "");
    if (/^(?:0[xXbBoO][0-9a-fA-F]+|\d+)$/.test(raw)) return BigInt(raw);
    return undefined;
  }
  if (s.kind === K.PrefixUnaryExpression && (s as ts.PrefixUnaryExpression).operator === K.MinusToken) {
    const inner = intLitValue((s as ts.PrefixUnaryExpression).operand, sf);
    return inner !== undefined ? -inner : undefined;
  }
  return undefined;
}

function hasContractOrLoop(f: FnSym): boolean {
  let found = false;
  const walk = (n: Node): void => {
    if (found) return;
    if (n.kind === K.CallExpression && isId((n as ts.CallExpression).expression)) {
      const t = ((n as ts.CallExpression).expression as ts.Identifier).text;
      if (t === "requires" || t === "ensures" || t === "invariant") { found = true; return; }
    }
    n.forEachChild(walk);
  };
  if (f.decl.body) walk(f.decl.body);
  return found;
}

interface State {
  terminated: boolean;
  env: Map<string, string>;
  inexact: Set<string>;
  assumptions: string[];
  modelVars: Map<string, string>;
}

const cloneState = (s: State): State => ({
  terminated: s.terminated,
  env: new Map(s.env),
  inexact: new Set(s.inexact),
  assumptions: [...s.assumptions],
  modelVars: new Map(s.modelVars),
});

interface PendingObligation {
  readonly kind: ObligationKind;
  readonly label: string;
  readonly anchor: Node;
  readonly anchorKey: string;
  readonly range: Range;
  readonly goal: string;
  readonly assumptions: readonly string[];
  readonly modelVars: ReadonlyMap<string, string>;
  readonly exact: boolean;
  readonly calleeKey?: string;
}

interface FieldTerm {
  readonly smt: string;
  readonly exact: boolean;
}

interface TermVal {
  readonly smt: string;
  readonly exact: boolean;
  readonly constVal?: bigint;
  readonly containerLen?: string;
  readonly recordFields?: ReadonlyMap<string, FieldTerm>;
}

interface CondVal {
  readonly smt: string;
  readonly exact: boolean;
}

interface ExtractedContracts {
  readonly requires: ts.CallExpression[];
  readonly ensures: ts.ArrowFunction[];
}

function extractContracts(f: FnSym): ExtractedContracts {
  const requires: ts.CallExpression[] = [];
  const ensures: ts.ArrowFunction[] = [];
  const ss = f.decl.body?.statements ?? [];
  let i = 0;
  while (i < ss.length && ss[i]!.kind === K.ExpressionStatement && (ss[i] as ts.ExpressionStatement).expression.kind === K.StringLiteral) i++;
  for (; i < ss.length; i++) {
    const s = ss[i]!;
    if (s.kind !== K.ExpressionStatement) break;
    const ex = (s as ts.ExpressionStatement).expression;
    if (ex.kind !== K.CallExpression || !isId((ex as ts.CallExpression).expression)) break;
    const nm = ((ex as ts.CallExpression).expression as ts.Identifier).text;
    if (nm === "requires") requires.push(ex as ts.CallExpression);
    else if (nm === "ensures" && (ex as ts.CallExpression).arguments[0]?.kind === K.ArrowFunction) {
      ensures.push((ex as ts.CallExpression).arguments[0] as ts.ArrowFunction);
    } else break;
  }
  return { requires, ensures };
}

class FnProver {
  readonly decls: Decls;
  readonly f: FnSym;
  readonly preamble: string[] = [];
  readonly obligations: PendingObligation[] = [];
  readonly unsignedDivAnchors = new Set<Node>();
  nonLinear = false;
  private vid = 0;
  private readonly contracts: Map<FnSym, ExtractedContracts>;
  private readonly tagIds = new Map<string, bigint>();
  private loopDepth = 0;
  private loopBreaks: State[] = [];
  private loopContinues: State[] = [];

  constructor(decls: Decls, f: FnSym, contracts: Map<FnSym, ExtractedContracts>) {
    this.decls = decls;
    this.f = f;
    this.contracts = contracts;
  }

  private tagId(s: string): bigint {
    let id = this.tagIds.get(s);
    if (id === undefined) {
      id = BigInt(this.tagIds.size + 1);
      this.tagIds.set(s, id);
    }
    return id;
  }

  private withTempEnv<T>(
    st: State,
    entries: ReadonlyMap<string, string>,
    inexactKeys: ReadonlySet<string> | undefined,
    fn: () => T,
  ): T {
    const savedEnv: [string, string | undefined][] = [];
    const savedInexact: [string, boolean][] = [];
    for (const [k, v] of entries) {
      savedEnv.push([k, st.env.get(k)]);
      savedInexact.push([k, st.inexact.has(k)]);
      st.env.set(k, v);
      if (inexactKeys?.has(k)) st.inexact.add(k); else st.inexact.delete(k);
    }
    try {
      return fn();
    } finally {
      for (const [k, old] of savedEnv) {
        if (old === undefined) st.env.delete(k); else st.env.set(k, old);
      }
      for (const [k, was] of savedInexact) {
        if (was) st.inexact.add(k); else st.inexact.delete(k);
      }
    }
  }

  fresh(sort: "Int" | "Bool", prefix: string, bounds?: readonly [bigint, bigint]): string {
    const sym = `${prefix.replace(/[^A-Za-z0-9_]/g, "_")}_${++this.vid}`;
    this.preamble.push(`(declare-const ${sym} ${sort})`);
    if (sort === "Int" && bounds) this.preamble.push(`(assert ${inBounds(sym, bounds[0], bounds[1])})`);
    return sym;
  }

  freshForType(t: Type, prefix: string): string {
    const u = unref(t);
    if (u.k === "num" && INT_BOUNDS[u.name]) {
      const [lo, hi] = INT_BOUNDS[u.name]!;
      return this.fresh("Int", prefix, [lo, hi]);
    }
    if (isBool(u)) return this.fresh("Bool", prefix);
    return this.fresh("Int", prefix);
  }

  addObligation(kind: ObligationKind, label: string, anchor: Node, mod: Module, state: State, goal: string, exact: boolean, calleeKey?: string): void {
    const startOff = anchor.getStart(mod.sf);
    const range = {
      start: mod.pf.position(startOff),
      end: mod.pf.position(anchor.end),
    };
    this.obligations.push({
      kind,
      label,
      anchor,
      anchorKey: anchorKeyOf(anchor, mod.sf),
      range,
      goal,
      assumptions: [...state.assumptions],
      modelVars: new Map(state.modelVars),
      exact,
      calleeKey,
    });
  }

  /** Initializes function parameters with their type bounds (integers, container lengths, struct fields) and leading `requires`. */
  initEntry(): State {
    const st: State = { terminated: false, env: new Map(), inexact: new Set(), assumptions: [], modelVars: new Map() };
    for (const p of this.f.decl.parameters) {
      if (!isId(p.name)) continue;
      const sym = localOf.get(p.name);
      if (!sym) continue;
      this.initLocal(st, sym, sym.name);
    }
    const cs = this.contracts.get(this.f)!;
    for (const req of cs.requires) {
      const c = this.evalPureBool(req.arguments[0]!, st, this.f.mod, new Map());
      st.assumptions.push(c.smt);
    }
    return st;
  }

  private initLocal(st: State, sym: LocalSym, display: string, freshNonNull = true): void {
    const u = unref(sym.type);
    const key = `sym:${sym.id}`;
    st.inexact.delete(key);
    st.inexact.delete(`len:${sym.id}`);
    st.inexact.delete(`nn:${sym.id}`);
    if (u.k === "num" && INT_BOUNDS[u.name]) {
      const [lo, hi] = INT_BOUNDS[u.name]!;
      const v = this.fresh("Int", display, [lo, hi]);
      st.env.set(key, v);
      st.modelVars.set(display, v);
    } else if (isBool(u)) {
      const v = this.fresh("Bool", display);
      st.env.set(key, v);
      st.modelVars.set(display, v);
    } else if (isContainer(u)) {
      const lv = this.fresh("Int", `${display}_len`, [0n, MAX_U32]);
      st.env.set(`len:${sym.id}`, lv);
      st.modelVars.set(`${display}.length`, lv);
    } else if (u.k === "record") {
      this.initRecordFields(st, `field:${sym.id}`, `len:${sym.id}`, display, u);
    } else if (u.k === "union") {
      if (isTaggedUnion(u)) {
        const tagV = this.fresh("Int", `${display}_kind`);
        const eqs = u.members.map((m) => `(= ${tagV} ${smtInt(this.tagId(kindOf(m)!))})`);
        st.assumptions.push(eqs.length === 1 ? eqs[0]! : `(or ${eqs.join(" ")})`);
        st.env.set(`field:${sym.id}.kind`, tagV);
        st.modelVars.set(`${display}.kind`, tagV);
        for (const m of u.members) {
          const mu = unref(m);
          if (mu.k === "record") this.initRecordFields(st, `field:${sym.id}`, `len:${sym.id}`, display, mu, true);
        }
      } else if (nonNull(u) && freshNonNull) {
        const b = this.fresh("Bool", `${display}_nn`);
        st.env.set(`nn:${sym.id}`, b);
        const inner = unref(nonNull(u)!);
        if (inner.k === "num" && INT_BOUNDS[inner.name]) {
          const [lo, hi] = INT_BOUNDS[inner.name]!;
          const v = this.fresh("Int", display, [lo, hi]);
          st.env.set(key, v);
        } else if (isBool(inner)) {
          st.env.set(key, this.fresh("Bool", display));
        } else if (isContainer(inner)) {
          const lv = this.fresh("Int", `${display}_len`, [0n, MAX_U32]);
          st.env.set(`len:${sym.id}`, lv);
        }
      }
    }
  }

  private initRecordFields(
    st: State,
    fieldPrefix: string,
    lenPrefix: string,
    displayPrefix: string,
    rec: Extract<Type, { k: "record" }>,
    skipExisting = false,
  ): void {
    for (const f of rec.fields) {
      const fu = unref(f.type);
      const fk = `${fieldPrefix}.${f.name}`;
      const lk = `${lenPrefix}.${f.name}`;
      const dk = `${displayPrefix}.${f.name}`;
      if (fu.k === "num" && INT_BOUNDS[fu.name]) {
        if (skipExisting && st.env.has(fk)) continue;
        const [lo, hi] = INT_BOUNDS[fu.name]!;
        const v = this.fresh("Int", dk, [lo, hi]);
        st.env.set(fk, v);
        st.modelVars.set(dk, v);
      } else if (isBool(fu)) {
        if (skipExisting && st.env.has(fk)) continue;
        const v = this.fresh("Bool", dk);
        st.env.set(fk, v);
        st.modelVars.set(dk, v);
      } else if (isContainer(fu)) {
        if (skipExisting && st.env.has(lk)) continue;
        const lv = this.fresh("Int", `${dk}_len`, [0n, MAX_U32]);
        st.env.set(lk, lv);
        st.modelVars.set(`${dk}.length`, lv);
      } else if (fu.k === "record") {
        this.initRecordFields(st, fk, lk, dk, fu, skipExisting);
      }
    }
  }

  private typeOf(n: Node): Type {
    return unref(exprTypes.get(n) ?? (isId(n) ? localOf.get(n)?.type : undefined) ?? { k: "error" });
  }

  /** Evaluates a side-effect-free contract/invariant expression, with optional local overrides (e.g. `ensures` param `r`). */
  evalPureInt(e0: ts.Expression, st: State, mod: Module, overrides: Map<number, TermVal>, trackNonLinear = true): TermVal {
    const e = strip(e0);
    if (e.kind === K.StringLiteral) {
      return { smt: smtInt(this.tagId((e as ts.StringLiteral).text)), exact: true };
    }
    const t = this.typeOf(e);
    const lit = intLitValue(e, mod.sf);
    if (lit !== undefined) return { smt: smtInt(lit), exact: true, constVal: lit };

    if (e.kind === K.Identifier) {
      const id = e as ts.Identifier;
      const sym = localOf.get(id);
      if (sym) {
        const ov = overrides.get(sym.id);
        if (ov) return ov;
        const val = st.env.get(`sym:${sym.id}`);
        if (val !== undefined) return { smt: val, exact: !st.inexact.has(`sym:${sym.id}`) };
      } else {
        const gv = this.decls.lookupValue(mod, id.text);
        if (gv?.k === "const" && gv.decl.initializer && !gv.bind) {
          return this.evalPureInt(gv.decl.initializer, st, gv.mod, overrides, trackNonLinear);
        }
      }
      return { smt: this.freshForType(t, id.text), exact: false };
    }

    if (e.kind === K.PropertyAccessExpression) {
      const p = e as ts.PropertyAccessExpression;
      if (isId(p.expression) && !localOf.has(p.expression)) {
        const ns = mod.nsImports.get(p.expression.text);
        if (ns && !ns.typeOnly) {
          const gv = this.decls.lookupExportedValue(ns.mod, p.name.text);
          if (gv?.k === "const" && gv.decl.initializer && !gv.bind) {
            return this.evalPureInt(gv.decl.initializer, st, gv.mod, overrides, trackNonLinear);
          }
        }
      }
      if (p.name.text === "length") {
        const lk = this.lengthKeyOf(p.expression);
        if (lk && st.env.has(lk)) return { smt: st.env.get(lk)!, exact: true };
      }
      const fk = this.fieldKeyOf(p);
      if (fk && st.env.has(fk)) return { smt: st.env.get(fk)!, exact: !st.inexact.has(fk) };
      return { smt: this.freshForType(t, p.name.text), exact: false };
    }

    if (e.kind === K.PrefixUnaryExpression && (e as ts.PrefixUnaryExpression).operator === K.MinusToken && isInt(t)) {
      const u = this.evalPureInt((e as ts.PrefixUnaryExpression).operand, st, mod, overrides, trackNonLinear);
      return { smt: `(- ${u.smt})`, exact: u.exact, ...(u.constVal !== undefined ? { constVal: -u.constVal } : {}) };
    }

    if (e.kind === K.BinaryExpression && isInt(t)) {
      const b = e as ts.BinaryExpression;
      const l = this.evalPureInt(b.left, st, mod, overrides, trackNonLinear);
      const r = this.evalPureInt(b.right, st, mod, overrides, trackNonLinear);
      const exact = l.exact && r.exact;
      switch (b.operatorToken.kind) {
        case K.PlusToken: return { smt: `(+ ${l.smt} ${r.smt})`, exact, ...(l.constVal !== undefined && r.constVal !== undefined ? { constVal: l.constVal + r.constVal } : {}) };
        case K.MinusToken: return { smt: `(- ${l.smt} ${r.smt})`, exact, ...(l.constVal !== undefined && r.constVal !== undefined ? { constVal: l.constVal - r.constVal } : {}) };
        case K.AsteriskToken:
          if (trackNonLinear && l.constVal === undefined && r.constVal === undefined) this.nonLinear = true;
          return { smt: `(* ${l.smt} ${r.smt})`, exact, ...(l.constVal !== undefined && r.constVal !== undefined ? { constVal: l.constVal * r.constVal } : {}) };
        case K.PercentToken:
          if (r.constVal === undefined && trackNonLinear) this.nonLinear = true;
          if (r.constVal !== undefined && r.constVal !== 0n) {
            const smt = truncRemSmt(l.smt, r.smt, isSignedInt(t));
            const constVal = l.constVal !== undefined ? l.constVal % r.constVal : undefined;
            return { smt, exact, ...(constVal !== undefined ? { constVal } : {}) };
          }
          break;
      }
    }

    if (e.kind === K.CallExpression && isId((e as ts.CallExpression).expression) && isInt(t)) {
      const c = e as ts.CallExpression;
      const name = (c.expression as ts.Identifier).text;
      if ((name === "divTrunc" || name === "rem") && c.arguments.length === 2) {
        const l = this.evalPureInt(c.arguments[0]!, st, mod, overrides, trackNonLinear);
        const r = this.evalPureInt(c.arguments[1]!, st, mod, overrides, trackNonLinear);
        if (r.constVal === undefined && trackNonLinear) this.nonLinear = true;
        if (r.constVal !== undefined && r.constVal !== 0n) {
          const signed = isSignedInt(t);
          const smt = name === "divTrunc" ? truncDivSmt(l.smt, r.smt, signed) : truncRemSmt(l.smt, r.smt, signed);
          return { smt, exact: l.exact && r.exact };
        }
      }
      if (INT_CONV.has(name) && c.arguments.length === 1) {
        const at = this.typeOf(c.arguments[0]!);
        if (isInt(at)) return this.evalPureInt(c.arguments[0]!, st, mod, overrides, trackNonLinear);
      }
    }

    if (e.kind === K.ConditionalExpression) {
      const c = e as ts.ConditionalExpression;
      const k = this.evalPureBool(c.condition, st, mod, overrides, trackNonLinear);
      const a = this.evalPureInt(c.whenTrue, st, mod, overrides, trackNonLinear);
      const b = this.evalPureInt(c.whenFalse, st, mod, overrides, trackNonLinear);
      return { smt: `(ite ${k.smt} ${a.smt} ${b.smt})`, exact: k.exact && a.exact && b.exact };
    }

    return { smt: this.freshForType(t, "u"), exact: false };
  }

  evalPureBool(e0: ts.Expression, st: State, mod: Module, overrides: Map<number, TermVal>, trackNonLinear = true): CondVal {
    const e = strip(e0);
    if (e.kind === K.TrueKeyword) return { smt: "true", exact: true };
    if (e.kind === K.FalseKeyword) return { smt: "false", exact: true };

    if (e.kind === K.Identifier) {
      const id = e as ts.Identifier;
      const sym = localOf.get(id);
      if (sym) {
        const ov = overrides.get(sym.id);
        if (ov) return { smt: ov.smt, exact: ov.exact };
        const val = st.env.get(`sym:${sym.id}`);
        if (val !== undefined) return { smt: val, exact: true };
      }
      return { smt: this.fresh("Bool", id.text), exact: false };
    }

    if (e.kind === K.PropertyAccessExpression) {
      const p = e as ts.PropertyAccessExpression;
      if (isId(p.expression) && !localOf.has(p.expression)) {
        const ns = mod.nsImports.get(p.expression.text);
        if (ns && !ns.typeOnly) {
          const gv = this.decls.lookupExportedValue(ns.mod, p.name.text);
          if (gv?.k === "const" && gv.decl.initializer && !gv.bind) {
            return this.evalPureBool(gv.decl.initializer, st, gv.mod, overrides, trackNonLinear);
          }
        }
      }
      const fk = this.fieldKeyOf(p);
      if (fk && st.env.has(fk)) return { smt: st.env.get(fk)!, exact: !st.inexact.has(fk) };
    }

    if (e.kind === K.PrefixUnaryExpression && (e as ts.PrefixUnaryExpression).operator === K.ExclamationToken) {
      const inner = this.evalPureBool((e as ts.PrefixUnaryExpression).operand, st, mod, overrides, trackNonLinear);
      return { smt: `(not ${inner.smt})`, exact: inner.exact };
    }

    if (e.kind === K.BinaryExpression) {
      const b = e as ts.BinaryExpression;
      const k = b.operatorToken.kind;
      if (k === K.AmpersandAmpersandToken || k === K.BarBarToken) {
        const l = this.evalPureBool(b.left, st, mod, overrides, trackNonLinear);
        const r = this.evalPureBool(b.right, st, mod, overrides, trackNonLinear);
        return { smt: `(${k === K.AmpersandAmpersandToken ? "and" : "or"} ${l.smt} ${r.smt})`, exact: l.exact && r.exact };
      }
      if (k === K.EqualsEqualsEqualsToken || k === K.ExclamationEqualsEqualsToken) {
        const lt = this.typeOf(b.left), rt = this.typeOf(b.right);
        const eq = k === K.EqualsEqualsEqualsToken;
        if ((lt.k === "prim" && lt.name === "null") || (rt.k === "prim" && rt.name === "null")) {
          const nonNullSide = lt.k === "prim" && lt.name === "null" ? b.right : b.left;
          const nnKey = this.nnKeyOf(nonNullSide);
          if (nnKey && st.env.has(nnKey)) {
            const sym = st.env.get(nnKey)!;
            return { smt: eq ? `(not ${sym})` : sym, exact: true };
          }
          return { smt: this.fresh("Bool", "nn_cmp"), exact: false };
        }
        if (isInt(lt) && isInt(rt)) {
          const l = this.evalPureInt(b.left, st, mod, overrides, trackNonLinear);
          const r = this.evalPureInt(b.right, st, mod, overrides, trackNonLinear);
          const core = `(= ${l.smt} ${r.smt})`;
          return { smt: eq ? core : `(not ${core})`, exact: l.exact && r.exact };
        }
        if (isBool(lt) && isBool(rt)) {
          const l = this.evalPureBool(b.left, st, mod, overrides, trackNonLinear);
          const r = this.evalPureBool(b.right, st, mod, overrides, trackNonLinear);
          const core = `(= ${l.smt} ${r.smt})`;
          return { smt: eq ? core : `(not ${core})`, exact: l.exact && r.exact };
        }
        if (isStrLitLike(lt) || isStrLitLike(rt) || strip(b.left).kind === K.StringLiteral || strip(b.right).kind === K.StringLiteral) {
          const l = this.evalPureInt(b.left, st, mod, overrides, trackNonLinear);
          const r = this.evalPureInt(b.right, st, mod, overrides, trackNonLinear);
          const core = `(= ${l.smt} ${r.smt})`;
          return { smt: eq ? core : `(not ${core})`, exact: l.exact && r.exact };
        }
      }
      const CMP: Partial<Record<K, string>> = {
        [K.LessThanToken]: "<",
        [K.LessThanEqualsToken]: "<=",
        [K.GreaterThanToken]: ">",
        [K.GreaterThanEqualsToken]: ">=",
      };
      const op = CMP[k];
      if (op && isInt(this.typeOf(b.left)) && isInt(this.typeOf(b.right))) {
        const l = this.evalPureInt(b.left, st, mod, overrides, trackNonLinear);
        const r = this.evalPureInt(b.right, st, mod, overrides, trackNonLinear);
        return { smt: `(${op} ${l.smt} ${r.smt})`, exact: l.exact && r.exact };
      }
    }

    if (e.kind === K.ConditionalExpression) {
      const c = e as ts.ConditionalExpression;
      const cond = this.evalPureBool(c.condition, st, mod, overrides, trackNonLinear);
      const t = this.evalPureBool(c.whenTrue, st, mod, overrides, trackNonLinear);
      const f = this.evalPureBool(c.whenFalse, st, mod, overrides, trackNonLinear);
      return { smt: `(ite ${cond.smt} ${t.smt} ${f.smt})`, exact: cond.exact && t.exact && f.exact };
    }

    return { smt: this.fresh("Bool", "cond"), exact: false };
  }

  private lengthKeyOf(e0: ts.Expression): string | undefined {
    const e = strip(e0);
    if (isId(e)) {
      const sym = localOf.get(e);
      return sym ? `len:${sym.id}` : undefined;
    }
    if (e.kind === K.PropertyAccessExpression) {
      const p = e as ts.PropertyAccessExpression;
      const lk = this.lengthKeyOf(p.expression);
      return lk ? `${lk}.${p.name.text}` : undefined;
    }
    return undefined;
  }

  private isLenCall(e0: ts.Expression): boolean {
    const e = strip(e0);
    if (e.kind !== K.CallExpression) return false;
    const c = e as ts.CallExpression;
    if (c.expression.kind !== K.PropertyAccessExpression) return false;
    const p = c.expression as ts.PropertyAccessExpression;
    const recvT = this.typeOf(p.expression);
    if (p.name.text === "filled" && c.arguments.length === 3 && isId(p.expression) && p.expression.text === "Vec" && !localOf.has(p.expression)) {
      return true;
    }
    if (p.name.text === "slice" && c.arguments.length === 2) {
      return recvT.k === "gen" && (recvT.name === "Vec" || recvT.name === "Slice");
    }
    if (p.name.text === "view" && c.arguments.length === 1) {
      return (recvT.k === "gen" || recvT.k === "opaque") && recvT.name === "Arena";
    }
    return false;
  }

  private fieldKeyOf(p: ts.PropertyAccessExpression): string | undefined {
    const base = strip(p.expression);
    if (isId(base)) {
      const sym = localOf.get(base);
      return sym ? `field:${sym.id}.${p.name.text}` : undefined;
    }
    if (base.kind === K.PropertyAccessExpression) {
      const fk = this.fieldKeyOf(base as ts.PropertyAccessExpression);
      return fk ? `${fk}.${p.name.text}` : undefined;
    }
    return undefined;
  }

  private nnKeyOf(e0: ts.Expression): string | undefined {
    const e = strip(e0);
    if (isId(e)) {
      const sym = localOf.get(e);
      return sym ? `nn:${sym.id}` : undefined;
    }
    return undefined;
  }

  /** Evaluates an expression while emitting trap obligations (`T001`/`T002`/`T003`/`T004`/`T007`/`T009`) and updating state. */
  async checkExpr(e0: ts.Expression, st: State): Promise<TermVal> {
    if (st.terminated) return { smt: "0", exact: false };
    const e = strip(e0);
    const t = this.typeOf(e);
    const mod = this.f.mod;

    if (e.kind === K.NumericLiteral) {
      const lit = intLitValue(e, mod.sf);
      if (lit !== undefined) return { smt: smtInt(lit), exact: true, constVal: lit };
      return { smt: this.freshForType(t, "lit"), exact: false };
    }
    if (e.kind === K.TrueKeyword) return { smt: "true", exact: true };
    if (e.kind === K.FalseKeyword) return { smt: "false", exact: true };
    if (e.kind === K.NullKeyword) return { smt: "false", exact: true };
    if (e.kind === K.StringLiteral) return { smt: smtInt(this.tagId((e as ts.StringLiteral).text)), exact: true };

    if (e.kind === K.Identifier) {
      const id = e as ts.Identifier;
      const sym = localOf.get(id);
      if (sym) {
        const val = st.env.get(`sym:${sym.id}`);
        if (val !== undefined) return { smt: val, exact: !st.inexact.has(`sym:${sym.id}`) };
      } else {
        const gv = this.decls.lookupValue(mod, id.text);
        if (gv?.k === "const" && gv.decl.initializer && !gv.bind) {
          return this.evalPureInt(gv.decl.initializer, st, gv.mod, new Map());
        }
      }
      return { smt: this.freshForType(t, id.text), exact: false };
    }

    if (e.kind === K.PostfixUnaryExpression) {
      return this.checkIncDec(e as ts.PostfixUnaryExpression, st);
    }

    if (e.kind === K.PrefixUnaryExpression) {
      const u = e as ts.PrefixUnaryExpression;
      if (u.operator === K.PlusPlusToken || u.operator === K.MinusMinusToken) return this.checkIncDec(u, st);
      if (u.operator === K.MinusToken && u.operand.kind === K.NumericLiteral) {
        const lit = intLitValue(e, mod.sf);
        if (lit !== undefined) return { smt: smtInt(lit), exact: true, constVal: lit };
        return { smt: this.freshForType(t, "nlit"), exact: false };
      }
      const v = await this.checkExpr(u.operand, st);
      if (u.operator === K.ExclamationToken) {
        return { smt: `(not ${v.smt})`, exact: v.exact };
      }
      if (u.operator === K.MinusToken && isInt(t)) {
        const [lo, hi] = INT_BOUNDS[(t as Extract<Type, { k: "num" }>).name]!;
        const neg = `(- ${v.smt})`;
        this.addObligation("T001", "unary '-' overflow check", u, mod, st, inBounds(neg, lo, hi), v.exact);
        st.assumptions.push(inBounds(neg, lo, hi));
        return { smt: neg, exact: v.exact, ...(v.constVal !== undefined ? { constVal: -v.constVal } : {}) };
      }
      return { smt: this.freshForType(t, "pre"), exact: false };
    }

    if (e.kind === K.PropertyAccessExpression) {
      const p = e as ts.PropertyAccessExpression;
      if (isId(p.expression) && !localOf.has(p.expression)) {
        const ns = mod.nsImports.get(p.expression.text);
        if (ns && !ns.typeOnly) {
          const gv = this.decls.lookupExportedValue(ns.mod, p.name.text);
          if (gv?.k === "const" && gv.decl.initializer && !gv.bind) {
            return this.evalPureInt(gv.decl.initializer, st, gv.mod, new Map());
          }
        }
      }
      if (p.name.text === "length") {
        const lk = this.lengthKeyOf(p.expression);
        if (lk && st.env.has(lk)) return { smt: st.env.get(lk)!, exact: true };
        if (this.isLenCall(p.expression)) {
          const base = await this.checkExpr(p.expression, st);
          return { smt: base.containerLen ?? base.smt, exact: base.exact };
        }
        if (isContainer(this.typeOf(p.expression))) {
          return { smt: this.fresh("Int", "len", [0n, MAX_U32]), exact: true };
        }
      }
      const fk = this.fieldKeyOf(p);
      if (fk && st.env.has(fk)) return { smt: st.env.get(fk)!, exact: !st.inexact.has(fk) };
      await this.checkExpr(p.expression, st);
      return { smt: this.freshForType(t, p.name.text), exact: false };
    }

    if (e.kind === K.ElementAccessExpression) {
      const a = e as ts.ElementAccessExpression;
      const arrVal = await this.checkExpr(a.expression, st);
      const lenTerm = this.isLenCall(a.expression) ? arrVal : this.containerLen(a.expression, st);
      const idx = await this.checkExpr(a.argumentExpression, st);
      this.addObligation("T002", "index in bounds [0, length)", a.argumentExpression, mod, st, `(and (>= ${idx.smt} 0) (< ${idx.smt} ${lenTerm.smt}))`, idx.exact && lenTerm.exact);
      st.assumptions.push(`(and (>= ${idx.smt} 0) (< ${idx.smt} ${lenTerm.smt}))`);
      return { smt: this.freshForType(t, "elem"), exact: false };
    }

    if (e.kind === K.ConditionalExpression) {
      const c = e as ts.ConditionalExpression;
      const cond = await this.checkExpr(c.condition, st);
      const thenSt = cloneState(st);
      thenSt.assumptions.push(cond.smt);
      const tv = await this.checkExpr(c.whenTrue, thenSt);
      const elseSt = cloneState(st);
      elseSt.assumptions.push(`(not ${cond.smt})`);
      const fv = await this.checkExpr(c.whenFalse, elseSt);
      this.joinInto(st, thenSt, elseSt, cond.smt, st.assumptions.length);
      return { smt: `(ite ${cond.smt} ${tv.smt} ${fv.smt})`, exact: cond.exact && tv.exact && fv.exact };
    }

    if (e.kind === K.ObjectLiteralExpression) {
      const rf = new Map<string, FieldTerm>();
      for (const pr of (e as ts.ObjectLiteralExpression).properties) {
        if (pr.kind === K.PropertyAssignment) {
          const pa = pr as ts.PropertyAssignment;
          const pv = await this.checkExpr(pa.initializer, st);
          const pn = pa.name.kind === K.Identifier || pa.name.kind === K.StringLiteral ? (pa.name as ts.Identifier | ts.StringLiteral).text : undefined;
          if (pn) {
            rf.set(pn, { smt: pv.smt, exact: pv.exact });
            if (pv.recordFields) for (const [sk, sv] of pv.recordFields) rf.set(`${pn}.${sk}`, sv);
          }
        } else if (pr.kind === K.ShorthandPropertyAssignment) {
          const sp = pr as ts.ShorthandPropertyAssignment;
          if (!isId(sp.name)) continue;
          const pv = await this.checkExpr(sp.name, st);
          rf.set(sp.name.text, { smt: pv.smt, exact: pv.exact });
          const rs = localOf.get(sp.name);
          if (rs) {
            const pfx = `field:${rs.id}.`;
            for (const [k, fv] of st.env) {
              if (k.startsWith(pfx)) rf.set(`${sp.name.text}.${k.slice(pfx.length)}`, { smt: fv, exact: !st.inexact.has(k) });
            }
          }
        } else if (pr.kind === K.SpreadAssignment) {
          await this.checkExpr((pr as ts.SpreadAssignment).expression, st);
        }
      }
      return { smt: this.freshForType(t, "obj"), exact: false, ...(rf.size ? { recordFields: rf } : {}) };
    }

    if (e.kind === K.ArrayLiteralExpression) {
      for (const el of (e as ts.ArrayLiteralExpression).elements) {
        if (el.kind === K.SpreadElement) await this.checkExpr((el as ts.SpreadElement).expression, st);
        else await this.checkExpr(el, st);
      }
      return { smt: this.freshForType(t, "arr"), exact: false };
    }

    if (e.kind === K.BinaryExpression) {
      return this.checkBinary(e as ts.BinaryExpression, st);
    }

    if (e.kind === K.CallExpression) {
      return this.checkCall(e as ts.CallExpression, st);
    }

    return { smt: this.freshForType(t, "expr"), exact: false };
  }

  private containerLen(arrExpr: ts.Expression, st: State): TermVal {
    const lk = this.lengthKeyOf(arrExpr);
    if (lk && st.env.has(lk)) return { smt: st.env.get(lk)!, exact: true };
    const v = this.fresh("Int", "len", [0n, MAX_U32]);
    return { smt: v, exact: true };
  }

  private async checkBinary(b: ts.BinaryExpression, st: State): Promise<TermVal> {
    const k = b.operatorToken.kind;
    const mod = this.f.mod;
    const t = this.typeOf(b);

    if (k === K.EqualsToken) return this.checkAssign(b, undefined, st);
    const comp = ARITH_ASSIGN[k];
    if (comp) return this.checkAssign(b, comp, st);
    if (k === K.SlashEqualsToken || k === K.PercentEqualsToken || BIT_ASSIGN.has(k)) {
      const left = this.assignTargetNode(b.left);
      const lt = this.typeOf(left);
      if (left.kind === K.ElementAccessExpression) {
        const a = left as ts.ElementAccessExpression;
        const arrVal = await this.checkExpr(a.expression, st);
        const lenTerm = this.isLenCall(a.expression) ? arrVal : this.containerLen(a.expression, st);
        const idx = await this.checkExpr(a.argumentExpression, st);
        this.addObligation("T002", "index in bounds [0, length)", a.argumentExpression, mod, st, `(and (>= ${idx.smt} 0) (< ${idx.smt} ${lenTerm.smt}))`, idx.exact && lenTerm.exact);
        st.assumptions.push(`(and (>= ${idx.smt} 0) (< ${idx.smt} ${lenTerm.smt}))`);
        const rhs = await this.checkExpr(b.right, st);
        if (k === K.PercentEqualsToken && isInt(lt)) {
          const cur: TermVal = { smt: this.freshForType(lt, "cur"), exact: false };
          return this.checkedIntRem(lt as Extract<Type, { k: "num" }>, cur, rhs, b.operatorToken, st, "%=");
        }
        if (SHIFT_ASSIGN.has(k)) {
          const bits = isInt(lt) && INT_BOUNDS[(lt as Extract<Type, { k: "num" }>).name]![3] === 64 ? 64n : 32n;
          this.addObligation("T009", `shift count in [0, ${bits - 1n}]`, b.operatorToken, mod, st, `(and (>= ${rhs.smt} 0) (< ${rhs.smt} ${smtInt(bits)}))`, rhs.exact);
        }
        return { smt: this.freshForType(t, "comp"), exact: false };
      }
      if (k === K.PercentEqualsToken && isInt(lt)) {
        const cur = await this.checkExpr(left, st);
        const rhs = await this.checkExpr(b.right, st);
        const val = this.checkedIntRem(lt as Extract<Type, { k: "num" }>, cur, rhs, b.operatorToken, st, "%=");
        this.writePlace(left, val, st);
        return val;
      }
      const cur = await this.checkExpr(left, st);
      const rhs = await this.checkExpr(b.right, st);
      if (SHIFT_ASSIGN.has(k)) {
        const bits = isInt(lt) && INT_BOUNDS[(lt as Extract<Type, { k: "num" }>).name]![3] === 64 ? 64n : 32n;
        this.addObligation("T009", `shift count in [0, ${bits - 1n}]`, b.operatorToken, mod, st, `(and (>= ${rhs.smt} 0) (< ${rhs.smt} ${smtInt(bits)}))`, rhs.exact);
      }
      const bitOp = k === K.AmpersandEqualsToken ? "&" : k === K.BarEqualsToken ? "|" : k === K.CaretEqualsToken ? "^" : undefined;
      const val = bitOp && isInt(lt) && !isSignedInt(lt)
        ? this.unsignedBitwiseTerm(lt as Extract<Type, { k: "num" }>, bitOp, cur, rhs, st)
        : { smt: this.freshForType(t, BIT_ASSIGN.has(k) ? "bitcomp" : "fcomp"), exact: false };
      this.writePlace(left, val, st);
      return val;
    }

    if (k === K.AmpersandAmpersandToken) {
      const l = await this.checkExpr(b.left, st);
      const rSt = cloneState(st);
      rSt.assumptions.push(l.smt);
      const r = await this.checkExpr(b.right, rSt);
      const fSt = cloneState(st);
      fSt.assumptions.push(`(not ${l.smt})`);
      this.joinInto(st, rSt, fSt, l.smt, st.assumptions.length);
      return { smt: `(and ${l.smt} ${r.smt})`, exact: l.exact && r.exact };
    }

    if (k === K.BarBarToken) {
      const l = await this.checkExpr(b.left, st);
      const rSt = cloneState(st);
      rSt.assumptions.push(`(not ${l.smt})`);
      const r = await this.checkExpr(b.right, rSt);
      const tSt = cloneState(st);
      tSt.assumptions.push(l.smt);
      this.joinInto(st, tSt, rSt, l.smt, st.assumptions.length);
      return { smt: `(or ${l.smt} ${r.smt})`, exact: l.exact && r.exact };
    }

    const l = await this.checkExpr(b.left, st);
    const r = await this.checkExpr(b.right, st);

    if (k === K.EqualsEqualsEqualsToken || k === K.ExclamationEqualsEqualsToken) {
      const eq = k === K.EqualsEqualsEqualsToken;
      const lt = this.typeOf(b.left), rt = this.typeOf(b.right);
      if ((lt.k === "prim" && lt.name === "null") || (rt.k === "prim" && rt.name === "null")) {
        const nonNullSide = lt.k === "prim" && lt.name === "null" ? b.right : b.left;
        const nnKey = this.nnKeyOf(nonNullSide);
        if (nnKey && st.env.has(nnKey)) {
          const sym = st.env.get(nnKey)!;
          return { smt: eq ? `(not ${sym})` : sym, exact: true };
        }
        return { smt: this.fresh("Bool", "nn_eq"), exact: false };
      }
      if ((isInt(lt) && isInt(rt)) || (isBool(lt) && isBool(rt)) || isStrLitLike(lt) || isStrLitLike(rt) || strip(b.left).kind === K.StringLiteral || strip(b.right).kind === K.StringLiteral) {
        const expr = `(= ${l.smt} ${r.smt})`;
        return { smt: eq ? expr : `(not ${expr})`, exact: l.exact && r.exact };
      }
      return { smt: this.fresh("Bool", "eq"), exact: false };
    }

    const CMP: Partial<Record<K, string>> = {
      [K.LessThanToken]: "<",
      [K.LessThanEqualsToken]: "<=",
      [K.GreaterThanToken]: ">",
      [K.GreaterThanEqualsToken]: ">=",
    };
    if (CMP[k]) {
      if (isInt(this.typeOf(b.left)) && isInt(this.typeOf(b.right))) {
        return { smt: `(${CMP[k]} ${l.smt} ${r.smt})`, exact: l.exact && r.exact };
      }
      return { smt: this.fresh("Bool", "fcmp"), exact: false };
    }

    if (k === K.LessThanLessThanToken || k === K.GreaterThanGreaterThanToken || k === K.GreaterThanGreaterThanGreaterThanToken) {
      const bits = isInt(t) && INT_BOUNDS[(t as Extract<Type, { k: "num" }>).name]![3] === 64 ? 64n : 32n;
      this.addObligation("T009", `shift count in [0, ${bits - 1n}]`, b.operatorToken, mod, st, `(and (>= ${r.smt} 0) (< ${r.smt} ${smtInt(bits)}))`, r.exact);
      return { smt: this.freshForType(t, "sh"), exact: false };
    }

    if (isInt(t) && !isSignedInt(t) && (k === K.AmpersandToken || k === K.BarToken || k === K.CaretToken)) {
      const op = k === K.AmpersandToken ? "&" : k === K.BarToken ? "|" : "^";
      return this.unsignedBitwiseTerm(t as Extract<Type, { k: "num" }>, op, l, r, st);
    }
    if (isInt(t) && (k === K.PlusToken || k === K.MinusToken || k === K.AsteriskToken)) {
      const op = k === K.PlusToken ? "+" : k === K.MinusToken ? "-" : "*";
      return this.checkedIntArith(t as Extract<Type, { k: "num" }>, op, l, r, b.operatorToken, st);
    }
    if (isInt(t) && k === K.PercentToken) {
      return this.checkedIntRem(t as Extract<Type, { k: "num" }>, l, r, b.operatorToken, st, "%");
    }

    return { smt: this.freshForType(t, "bin"), exact: false };
  }

  private unsignedBitwiseTerm(t: Extract<Type, { k: "num" }>, op: "&" | "|" | "^", l: TermVal, r: TermVal, st: State): TermVal {
    if (l.constVal !== undefined && r.constVal !== undefined) {
      const cv = op === "&" ? (l.constVal & r.constVal) : op === "|" ? (l.constVal | r.constVal) : (l.constVal ^ r.constVal);
      return { smt: smtInt(cv), exact: l.exact && r.exact, constVal: cv };
    }
    const v = this.freshForType(t, "bit");
    if (op === "&") {
      st.assumptions.push(`(<= ${v} ${l.smt})`, `(<= ${v} ${r.smt})`);
    } else {
      st.assumptions.push(`(<= ${v} (+ ${l.smt} ${r.smt}))`);
      if (op === "|") st.assumptions.push(`(>= ${v} ${l.smt})`, `(>= ${v} ${r.smt})`);
      st.assumptions.push(
        `(=> (and (<= ${l.smt} 255) (<= ${r.smt} 255)) (<= ${v} 255))`,
        `(=> (and (<= ${l.smt} 65535) (<= ${r.smt} 65535)) (<= ${v} 65535))`,
        `(=> (and (<= ${l.smt} 4294967295) (<= ${r.smt} 4294967295)) (<= ${v} 4294967295))`,
      );
    }
    return { smt: v, exact: false };
  }

  private async checkIncDec(u: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression, st: State): Promise<TermVal> {
    const op = u.operator === K.PlusPlusToken ? "+" : "-";
    const left = this.assignTargetNode(u.operand);
    const lt = this.typeOf(left);
    const one: TermVal = { smt: "1", exact: true, constVal: 1n };
    if (left.kind === K.ElementAccessExpression) {
      const a = left as ts.ElementAccessExpression;
      const arrVal = await this.checkExpr(a.expression, st);
      const lenTerm = this.isLenCall(a.expression) ? arrVal : this.containerLen(a.expression, st);
      const idx = await this.checkExpr(a.argumentExpression, st);
      this.addObligation("T002", "index in bounds [0, length)", a.argumentExpression, this.f.mod, st, `(and (>= ${idx.smt} 0) (< ${idx.smt} ${lenTerm.smt}))`, idx.exact && lenTerm.exact);
      st.assumptions.push(`(and (>= ${idx.smt} 0) (< ${idx.smt} ${lenTerm.smt}))`);
      if (isInt(lt)) {
        const cur: TermVal = { smt: this.freshForType(lt, "cur"), exact: false };
        return this.checkedIntArith(lt as Extract<Type, { k: "num" }>, op, cur, one, u, st);
      }
      return { smt: this.freshForType(lt, "incdec"), exact: false };
    }
    const cur = await this.checkExpr(left, st);
    const val = isInt(lt)
      ? this.checkedIntArith(lt as Extract<Type, { k: "num" }>, op, cur, one, u, st)
      : { smt: this.freshForType(lt, "incdec"), exact: false };
    this.writePlace(left, val, st);
    return val;
  }

  private checkedIntRem(t: Extract<Type, { k: "num" }>, l: TermVal, r: TermVal, anchor: Node, st: State, label = "%"): TermVal {
    if (r.constVal === undefined) this.nonLinear = true;
    const nonZero = `(not (= ${r.smt} 0))`;
    this.addObligation("T007", `${label} divisor != 0`, anchor, this.f.mod, st, nonZero, r.exact);
    st.assumptions.push(nonZero);
    const smt = truncRemSmt(l.smt, r.smt, isSignedInt(t));
    const constVal = l.constVal !== undefined && r.constVal !== undefined && r.constVal !== 0n ? l.constVal % r.constVal : undefined;
    return { smt, exact: l.exact && r.exact, ...(constVal !== undefined ? { constVal } : {}) };
  }

  private checkedIntArith(t: Extract<Type, { k: "num" }>, op: "+" | "-" | "*", l: TermVal, r: TermVal, anchor: Node, st: State): TermVal {
    const [lo, hi] = INT_BOUNDS[t.name]!;
    if (op === "*" && l.constVal === undefined && r.constVal === undefined) this.nonLinear = true;
    const resSmt = `(${op} ${l.smt} ${r.smt})`;
    const exact = l.exact && r.exact;
    const okExpr = inBounds(resSmt, lo, hi);
    this.addObligation("T001", `${t.name} '${op}' overflow check`, anchor, this.f.mod, st, okExpr, exact);
    st.assumptions.push(okExpr);
    const constVal = l.constVal !== undefined && r.constVal !== undefined
      ? (op === "+" ? l.constVal + r.constVal : op === "-" ? l.constVal - r.constVal : l.constVal * r.constVal)
      : undefined;
    return { smt: resSmt, exact, ...(constVal !== undefined ? { constVal } : {}) };
  }

  private assignTargetNode(e: ts.Expression): ts.Expression {
    return strip(e);
  }

  private async checkAssign(b: ts.BinaryExpression, op: "+" | "-" | "*" | undefined, st: State): Promise<TermVal> {
    const left = this.assignTargetNode(b.left);
    const lt = this.typeOf(left);
    const mod = this.f.mod;

    if (left.kind === K.ElementAccessExpression) {
      const a = left as ts.ElementAccessExpression;
      const arrVal = await this.checkExpr(a.expression, st);
      const lenTerm = this.isLenCall(a.expression) ? arrVal : this.containerLen(a.expression, st);
      const idx = await this.checkExpr(a.argumentExpression, st);
      if (op && isInt(lt)) {
        this.addObligation("T002", "index in bounds [0, length)", a.argumentExpression, mod, st, `(and (>= ${idx.smt} 0) (< ${idx.smt} ${lenTerm.smt}))`, idx.exact && lenTerm.exact);
        st.assumptions.push(`(and (>= ${idx.smt} 0) (< ${idx.smt} ${lenTerm.smt}))`);
        const rhs = await this.checkExpr(b.right, st);
        const cur: TermVal = { smt: this.freshForType(lt, "cur"), exact: false };
        return this.checkedIntArith(lt as Extract<Type, { k: "num" }>, op, cur, rhs, b.operatorToken, st);
      }
      const rhs = await this.checkExpr(b.right, st);
      this.addObligation("T002", "index in bounds [0, length)", a.argumentExpression, mod, st, `(and (>= ${idx.smt} 0) (< ${idx.smt} ${lenTerm.smt}))`, idx.exact && lenTerm.exact);
      st.assumptions.push(`(and (>= ${idx.smt} 0) (< ${idx.smt} ${lenTerm.smt}))`);
      return rhs;
    }

    if (op) {
      const cur = await this.checkExpr(left, st);
      const rhs = await this.checkExpr(b.right, st);
      const val = isInt(lt)
        ? this.checkedIntArith(lt as Extract<Type, { k: "num" }>, op, cur, rhs, b.operatorToken, st)
        : { smt: this.freshForType(lt, "opassn"), exact: false };
      this.writePlace(left, val, st);
      return val;
    }

    const rhs = await this.checkExpr(b.right, st);
    this.assignPlaceFromExpr(left, b.right, rhs, st);
    return rhs;
  }

  private writePlace(left: ts.Expression, val: TermVal, st: State): void {
    const l = strip(left);
    if (isId(l)) {
      const sym = localOf.get(l);
      if (sym) {
        const key = `sym:${sym.id}`;
        st.env.set(key, val.smt);
        if (val.exact) st.inexact.delete(key); else st.inexact.add(key);
      }
      return;
    }
    if (l.kind === K.PropertyAccessExpression) {
      const fk = this.fieldKeyOf(l as ts.PropertyAccessExpression);
      if (fk) {
        st.env.set(fk, val.smt);
        if (val.exact) st.inexact.delete(fk); else st.inexact.add(fk);
      }
    }
  }

  private assignPlaceFromExpr(left: ts.Expression, rhsNode: ts.Expression, rhsVal: TermVal, st: State): void {
    const l = strip(left);
    const lt = this.typeOf(l);
    if (isInt(lt) || isBool(lt)) {
      this.writePlace(l, rhsVal, st);
      return;
    }
    if (isId(l)) {
      const sym = localOf.get(l);
      if (!sym) return;
      if (lt.k === "union" && nonNull(lt)) {
        if (strip(rhsNode).kind === K.NullKeyword) st.env.set(`nn:${sym.id}`, "false");
        else if (this.typeOf(rhsNode).k !== "union") {
          st.env.set(`nn:${sym.id}`, "true");
          st.env.set(`sym:${sym.id}`, rhsVal.smt);
          if (rhsVal.exact) st.inexact.delete(`sym:${sym.id}`); else st.inexact.add(`sym:${sym.id}`);
        } else {
          const b = this.fresh("Bool", `${sym.name}_nn`);
          st.env.set(`nn:${sym.id}`, b);
          st.env.set(`sym:${sym.id}`, this.freshForType(nonNull(lt)!, sym.name));
          if (rhsVal.containerLen !== undefined) {
            st.env.set(`len:${sym.id}`, rhsVal.containerLen);
            if (rhsVal.exact) st.inexact.delete(`len:${sym.id}`); else st.inexact.add(`len:${sym.id}`);
          }
        }
        return;
      }
      if (lt.k === "record") {
        this.bindRecordFromExpr(sym.id, sym.name, lt, rhsNode, st, rhsVal);
        return;
      }
      if (isContainer(lt)) {
        const len = rhsVal.containerLen ?? this.exprContainerLength(rhsNode, st);
        if (len) {
          st.env.set(`len:${sym.id}`, len);
          if (rhsVal.exact || rhsVal.containerLen === undefined) st.inexact.delete(`len:${sym.id}`); else st.inexact.add(`len:${sym.id}`);
        } else {
          st.env.set(`len:${sym.id}`, this.fresh("Int", `${sym.name}_len`, [0n, MAX_U32]));
          st.inexact.delete(`len:${sym.id}`);
        }
      }
    }
  }

  private extractRecordFields(expr0: ts.Expression, st: State, mod: Module, val?: TermVal): Map<string, FieldTerm> {
    if (val?.recordFields) return new Map(val.recordFields);
    const e = strip(expr0);
    const out = new Map<string, FieldTerm>();
    if (e.kind === K.ObjectLiteralExpression) {
      for (const pr of (e as ts.ObjectLiteralExpression).properties) {
        if (pr.kind === K.PropertyAssignment) {
          const pa = pr as ts.PropertyAssignment;
          const pn = pa.name.kind === K.Identifier || pa.name.kind === K.StringLiteral ? (pa.name as ts.Identifier | ts.StringLiteral).text : undefined;
          if (!pn) continue;
          const iv = strip(pa.initializer);
          const it = this.typeOf(iv);
          if (iv.kind === K.ObjectLiteralExpression) {
            for (const [sk, sv] of this.extractRecordFields(iv, st, mod)) out.set(`${pn}.${sk}`, sv);
          } else if (isBool(it)) {
            const b = this.evalPureBool(iv, st, mod, new Map());
            out.set(pn, { smt: b.smt, exact: b.exact });
          } else {
            const n = this.evalPureInt(iv, st, mod, new Map());
            out.set(pn, { smt: n.smt, exact: n.exact });
          }
        } else if (pr.kind === K.ShorthandPropertyAssignment) {
          const sp = (pr as ts.ShorthandPropertyAssignment).name;
          if (!isId(sp)) continue;
          const rs = localOf.get(sp);
          if (rs) {
            const sv = st.env.get(`sym:${rs.id}`);
            if (sv !== undefined) out.set(sp.text, { smt: sv, exact: !st.inexact.has(`sym:${rs.id}`) });
            const pfx = `field:${rs.id}.`;
            for (const [k, fv] of st.env) {
              if (k.startsWith(pfx)) out.set(`${sp.text}.${k.slice(pfx.length)}`, { smt: fv, exact: !st.inexact.has(k) });
            }
          }
        }
      }
      return out;
    }
    if (isId(e)) {
      const rs = localOf.get(e);
      if (rs) {
        const pfx = `field:${rs.id}.`;
        for (const [k, fv] of st.env) {
          if (k.startsWith(pfx)) out.set(k.slice(pfx.length), { smt: fv, exact: !st.inexact.has(k) });
        }
        return out;
      }
      const gv = this.decls.lookupValue(mod, e.text);
      if (gv?.k === "const" && gv.decl.initializer && !gv.bind) {
        return this.extractRecordFields(gv.decl.initializer, st, gv.mod);
      }
      return out;
    }
    if (e.kind === K.PropertyAccessExpression) {
      const p = e as ts.PropertyAccessExpression;
      if (isId(p.expression) && !localOf.has(p.expression)) {
        const ns = mod.nsImports.get(p.expression.text);
        if (ns && !ns.typeOnly) {
          const gv = this.decls.lookupExportedValue(ns.mod, p.name.text);
          if (gv?.k === "const" && gv.decl.initializer && !gv.bind) {
            return this.extractRecordFields(gv.decl.initializer, st, gv.mod);
          }
        }
      }
      const fk = this.fieldKeyOf(p);
      if (fk) {
        const pfx = `${fk}.`;
        for (const [k, fv] of st.env) {
          if (k.startsWith(pfx)) out.set(k.slice(pfx.length), { smt: fv, exact: !st.inexact.has(k) });
        }
      }
    }
    return out;
  }

  private bindRecordFromExpr(
    symId: number,
    display: string,
    rec: Extract<Type, { k: "record" }>,
    rhs0: ts.Expression,
    st: State,
    rhsVal?: TermVal,
  ): void {
    const fields = this.extractRecordFields(rhs0, st, this.f.mod, rhsVal);
    if (fields.size > 0) {
      this.initRecordFields(st, `field:${symId}`, `len:${symId}`, display, rec, true);
      for (const [path, fv] of fields) {
        const fk = `field:${symId}.${path}`;
        st.env.set(fk, fv.smt);
        if (fv.exact) st.inexact.delete(fk); else st.inexact.add(fk);
        if (this.loopDepth === 0) st.modelVars.set(`${display}.${path}`, fv.smt);
      }
      const sr = strip(rhs0);
      const srcLenPfx = isId(sr) && localOf.get(sr)
        ? `len:${localOf.get(sr)!.id}.`
        : sr.kind === K.PropertyAccessExpression && this.lengthKeyOf(sr)
        ? `${this.lengthKeyOf(sr)}.`
        : undefined;
      if (srcLenPfx) {
        for (const [k, lv] of st.env) {
          if (k.startsWith(srcLenPfx)) {
            const lk = `len:${symId}.${k.slice(srcLenPfx.length)}`;
            st.env.set(lk, lv);
            if (st.inexact.has(k)) st.inexact.add(lk); else st.inexact.delete(lk);
          }
        }
      }
      return;
    }
    this.initRecordFields(st, `field:${symId}`, `len:${symId}`, display, rec);
  }

  private exprContainerLength(e0: ts.Expression, st: State): string | undefined {
    const e = strip(e0);
    const lk = this.lengthKeyOf(e);
    if (lk && st.env.has(lk)) return st.env.get(lk);
    if (e.kind === K.CallExpression && (e as ts.CallExpression).expression.kind === K.PropertyAccessExpression) {
      const p = (e as ts.CallExpression).expression as ts.PropertyAccessExpression;
      if (isId(p.expression) && p.expression.text === "Vec" && p.name.text === "create") return "0";
    }
    return undefined;
  }

  private collectArgBindings(
    target: FnSym,
    args: readonly ts.Expression[],
    argVals: readonly TermVal[],
    st: State,
  ): { env: Map<string, string>; inexact: Set<string>; pMap: Map<number, TermVal> } {
    const env = new Map<string, string>();
    const inexact = new Set<string>();
    const pMap = new Map<number, TermVal>();
    target.decl.parameters.forEach((p, idx) => {
      if (!isId(p.name)) return;
      const ps = localOf.get(p.name);
      if (!ps) return;
      const av = argVals[idx];
      if (av) pMap.set(ps.id, av);
      const argNode = args[idx];
      if (!argNode) {
        if (!p.initializer) return;
        this.withTempEnv(st, env, inexact, () => {
          const pu = unref(ps.type);
          if (pu.k === "record" || isTaggedUnion(pu)) {
            const rf = this.extractRecordFields(p.initializer!, st, target.mod);
            for (const [path, fv] of rf) {
              const fk = `field:${ps.id}.${path}`;
              env.set(fk, fv.smt);
              if (!fv.exact) inexact.add(fk);
            }
          } else if (isContainer(pu)) {
            const iv = strip(p.initializer!);
            if (iv.kind === K.ArrayLiteralExpression) {
              env.set(`len:${ps.id}`, smtInt(BigInt((iv as ts.ArrayLiteralExpression).elements.length)));
            } else {
              const lv = this.exprContainerLength(p.initializer!, st);
              if (lv !== undefined) env.set(`len:${ps.id}`, lv);
              else {
                env.set(`len:${ps.id}`, this.fresh("Int", `${ps.name}_def_len`, [0n, MAX_U32]));
                inexact.add(`len:${ps.id}`);
              }
            }
          } else if (isBool(pu)) {
            const bv = this.evalPureBool(p.initializer!, st, target.mod, pMap);
            pMap.set(ps.id, { smt: bv.smt, exact: bv.exact });
          } else if (isInt(pu) || isStrLitLike(pu)) {
            pMap.set(ps.id, this.evalPureInt(p.initializer!, st, target.mod, pMap));
          } else {
            pMap.set(ps.id, { smt: this.freshForType(ps.type, `${ps.name}_def`), exact: false });
          }
        });
        return;
      }
      const lk = this.lengthKeyOf(argNode);
      if (lk && st.env.has(lk)) {
        env.set(`len:${ps.id}`, st.env.get(lk)!);
        if (st.inexact.has(lk)) inexact.add(`len:${ps.id}`);
      } else if (this.isLenCall(argNode) && av) {
        env.set(`len:${ps.id}`, av.smt);
        if (!av.exact) inexact.add(`len:${ps.id}`);
      }
      const pu = unref(ps.type);
      if (pu.k === "record" || isTaggedUnion(pu)) {
        const rf = this.extractRecordFields(argNode, st, this.f.mod, av);
        for (const [path, fv] of rf) {
          const fk = `field:${ps.id}.${path}`;
          env.set(fk, fv.smt);
          if (!fv.exact) inexact.add(fk);
        }
        const sa = strip(argNode);
        const srcLenPfx = isId(sa) && localOf.get(sa)
          ? `len:${localOf.get(sa)!.id}.`
          : sa.kind === K.PropertyAccessExpression && this.lengthKeyOf(sa)
          ? `${this.lengthKeyOf(sa)}.`
          : undefined;
        if (srcLenPfx) {
          for (const [k, lv] of st.env) {
            if (k.startsWith(srcLenPfx)) {
              const dstk = `len:${ps.id}.${k.slice(srcLenPfx.length)}`;
              env.set(dstk, lv);
              if (st.inexact.has(k)) inexact.add(dstk);
            }
          }
        }
      }
    });
    return { env, inexact, pMap };
  }

  private allocRetRecordFields(
    rec: Extract<Type, { k: "record" }>,
    pathPrefix: string,
    displayPrefix: string,
    retFields: Map<string, FieldTerm>,
    eSymId: number | undefined,
    env: Map<string, string>,
  ): void {
    for (const f of rec.fields) {
      const fu = unref(f.type);
      const relPath = pathPrefix ? `${pathPrefix}.${f.name}` : f.name;
      const disp = `${displayPrefix}.${f.name}`;
      if (fu.k === "num" && INT_BOUNDS[fu.name]) {
        const [lo, hi] = INT_BOUNDS[fu.name]!;
        const sym = this.fresh("Int", disp, [lo, hi]);
        retFields.set(relPath, { smt: sym, exact: true });
        if (eSymId !== undefined) env.set(`field:${eSymId}.${relPath}`, sym);
      } else if (isBool(fu)) {
        const sym = this.fresh("Bool", disp);
        retFields.set(relPath, { smt: sym, exact: true });
        if (eSymId !== undefined) env.set(`field:${eSymId}.${relPath}`, sym);
      } else if (isContainer(fu)) {
        const lv = this.fresh("Int", `${disp}_len`, [0n, MAX_U32]);
        if (eSymId !== undefined) env.set(`len:${eSymId}.${relPath}`, lv);
      } else if (fu.k === "record") {
        this.allocRetRecordFields(fu, relPath, disp, retFields, eSymId, env);
      }
    }
  }

  private havocTarget(e0: ts.Expression, st: State): void {
    const e = strip(e0);
    if (isId(e)) {
      const sym = localOf.get(e);
      if (sym) this.initLocal(st, sym, sym.name);
    } else if (e.kind === K.PropertyAccessExpression) {
      const fk = this.fieldKeyOf(e as ts.PropertyAccessExpression);
      if (fk) st.env.set(fk, this.freshForType(this.typeOf(e), (e as ts.PropertyAccessExpression).name.text));
    }
  }

  private async checkTargetCall(target: FnSym, anchor: Node, c: ts.CallExpression, st: State, mod: Module, retT: Type): Promise<TermVal | undefined> {
    const argVals: TermVal[] = [];
    for (const a of c.arguments) argVals.push(await this.checkExpr(a, st));
    const cs = this.contracts.get(target);
    const calleeKey = `${target.mod.pf.path}::${target.name}`;
    if (cs?.requires.length) {
      const { env: reqEnv, inexact: reqInexact, pMap } = this.collectArgBindings(target, c.arguments, argVals, st);
      this.withTempEnv(st, reqEnv, reqInexact, () => {
        for (const req of cs.requires) {
          const cond = this.evalPureBool(req.arguments[0]!, st, target.mod, pMap);
          this.addObligation("T004", `requires for ${target.name}`, anchor, mod, st, cond.smt, cond.exact, calleeKey);
        }
      });
    }
    // Havoc Mut<Vec<T>> / Mut<Struct> args BEFORE evaluating ensures (Mut<Slice<T>> length cannot change)
    target.sig.params.forEach((pt, idx) => {
      if (pt.k === "gen" && pt.name === "Mut") {
        const inner = unref(pt.args[0]!);
        if (!(inner.k === "gen" && inner.name === "Slice")) {
          const argNode = c.arguments[idx];
          if (argNode) this.havocTarget(argNode, st);
        }
      }
    });
    if (!cs?.ensures.length) return undefined;
    const retVar = this.freshForType(retT, `${target.name}_ret`);
    const { env: postEnv, inexact: postInexact, pMap } = this.collectArgBindings(target, c.arguments, argVals, st);
    const firstParam = cs.ensures.map((e) => e.parameters[0]?.name).find((n): n is ts.Identifier => !!n && isId(n));
    const firstESym = firstParam ? localOf.get(firstParam) : undefined;
    let retRecordFields: Map<string, FieldTerm> | undefined;
    let retContainerLen: string | undefined;
    if (retT.k === "record") {
      retRecordFields = new Map();
      this.allocRetRecordFields(retT, "", `${target.name}_ret`, retRecordFields, firstESym?.id, postEnv);
    } else if (isContainer(retT)) {
      retContainerLen = this.fresh("Int", `${target.name}_len`, [0n, MAX_U32]);
      if (firstESym) postEnv.set(`len:${firstESym.id}`, retContainerLen);
    }
    const retTerm: TermVal = {
      smt: retContainerLen ?? retVar,
      exact: true,
      ...(retContainerLen !== undefined ? { containerLen: retContainerLen } : {}),
      ...(retRecordFields?.size ? { recordFields: retRecordFields } : {}),
    };
    for (const ens of cs.ensures) {
      const ep = ens.parameters[0]?.name;
      if (!ep || !isId(ep) || ens.body.kind === K.Block) continue;
      const eSym = localOf.get(ep);
      const eMap = new Map(pMap);
      if (eSym) {
        eMap.set(eSym.id, retTerm);
        if (firstESym && eSym.id !== firstESym.id) {
          if (retRecordFields) {
            for (const [rp, fv] of retRecordFields) postEnv.set(`field:${eSym.id}.${rp}`, fv.smt);
          } else if (retContainerLen !== undefined) {
            postEnv.set(`len:${eSym.id}`, retContainerLen);
          }
        }
      }
      this.withTempEnv(st, postEnv, postInexact, () => {
        const post = this.evalPureBool(ens.body as ts.Expression, st, target.mod, eMap);
        st.assumptions.push(post.smt);
      });
    }
    return retTerm;
  }

  private async checkCall(c: ts.CallExpression, st: State): Promise<TermVal> {
    const callee = c.expression;
    const mod = this.f.mod;
    const retT = this.typeOf(c);

    if (isId(callee) && !localOf.has(callee)) {
      const name = callee.text;
      if (INT_CONV.has(name) && c.arguments.length === 1) {
        const arg = await this.checkExpr(c.arguments[0]!, st);
        const at = this.typeOf(c.arguments[0]!);
        const [lo, hi] = INT_BOUNDS[name]!;
        if (isInt(at)) {
          const ok = inBounds(arg.smt, lo, hi);
          this.addObligation("T003", `${name}(...) range check`, callee, mod, st, ok, arg.exact);
          st.assumptions.push(ok);
          return { smt: arg.smt, exact: arg.exact, ...(arg.constVal !== undefined ? { constVal: arg.constVal } : {}) };
        }
        this.addObligation("T003", `${name}(float) range/integrality check`, callee, mod, st, "false", false);
        return { smt: this.freshForType(retT, name), exact: false };
      }

      if ((name === "divTrunc" || name === "rem") && c.arguments.length === 2) {
        const l = await this.checkExpr(c.arguments[0]!, st);
        const r = await this.checkExpr(c.arguments[1]!, st);
        if (name === "rem") return this.checkedIntRem(retT as Extract<Type, { k: "num" }>, l, r, callee, st, "rem");
        if (r.constVal === undefined) this.nonLinear = true;
        const signed = isSignedInt(retT);
        const [lo] = INT_BOUNDS[(retT as Extract<Type, { k: "num" }>).name]!;
        const nonZero = `(not (= ${r.smt} 0))`;
        this.addObligation("T007", `${name} divisor != 0`, callee, mod, st, nonZero, r.exact);
        if (signed) {
          const noMinDiv = `(not (and (= ${l.smt} ${smtInt(lo)}) (= ${r.smt} (- 1))))`;
          this.addObligation("T001", `${name} signed MIN / -1 check`, callee, mod, st, noMinDiv, l.exact && r.exact);
          st.assumptions.push(nonZero, noMinDiv);
        } else {
          this.unsignedDivAnchors.add(callee);
          st.assumptions.push(nonZero);
        }
        const exact = l.exact && r.exact;
        const smt = truncDivSmt(l.smt, r.smt, signed);
        let constVal: bigint | undefined;
        if (l.constVal !== undefined && r.constVal !== undefined && r.constVal !== 0n && !(signed && l.constVal === lo && r.constVal === -1n)) {
          constVal = l.constVal / r.constVal;
        }
        return { smt, exact, ...(constVal !== undefined ? { constVal } : {}) };
      }

      if (name === "panic") {
        for (const a of c.arguments) await this.checkExpr(a, st);
        st.terminated = true;
        return { smt: this.freshForType(retT, "panic"), exact: false };
      }

      const target = callFns.get(c);
      if (target) {
        const retTerm = await this.checkTargetCall(target, callee, c, st, mod, retT);
        if (retTerm) return retTerm;
      } else {
        for (const a of c.arguments) await this.checkExpr(a, st);
      }
      return { smt: this.freshForType(retT, name), exact: false };
    }

    if (callee.kind === K.PropertyAccessExpression) {
      const p = callee as ts.PropertyAccessExpression;
      const target = callFns.get(c);
      if (target) {
        const retTerm = await this.checkTargetCall(target, p.name, c, st, mod, retT);
        return retTerm ?? { smt: this.freshForType(retT, target.name), exact: false };
      }
      const m = p.name.text;
      await this.checkExpr(p.expression, st);
      const recvT = this.typeOf(p.expression);
      if (isId(p.expression) && p.expression.text === "Vec" && m === "create") {
        for (const a of c.arguments) await this.checkExpr(a, st);
        return { smt: this.fresh("Int", "vec", [0n, MAX_U32]), exact: true };
      }
      if (isId(p.expression) && p.expression.text === "Vec" && m === "filled") {
        const argTerms: TermVal[] = [];
        for (const a of c.arguments) argTerms.push(await this.checkExpr(a, st));
        const a1 = argTerms[1];
        if (a1) return { smt: a1.smt, exact: a1.exact, containerLen: a1.smt };
        return { smt: this.fresh("Int", "vec", [0n, MAX_U32]), exact: false };
      }
      if ((recvT.k === "gen" || recvT.k === "opaque") && recvT.name === "Arena") {
        const argTerms: TermVal[] = [];
        for (const a of c.arguments) argTerms.push(await this.checkExpr(a, st));
        if (m === "alloc" && argTerms.length >= 1) {
          const a0 = argTerms[0]!;
          return { smt: a0.smt, exact: a0.exact, containerLen: a0.smt };
        }
        if (m === "view" && c.arguments.length === 1) {
          const s0 = strip(c.arguments[0]!);
          if (isId(s0)) {
            const sym = localOf.get(s0);
            if (sym && st.env.has(`len:${sym.id}`)) {
              const lv = st.env.get(`len:${sym.id}`)!;
              const exact = !st.inexact.has(`len:${sym.id}`);
              return { smt: lv, exact, containerLen: lv };
            }
          }
        }
        return { smt: this.freshForType(retT, m), exact: false };
      }
      if (recvT.k === "gen" && (recvT.name === "Vec" || recvT.name === "Slice") && m === "slice" && c.arguments.length === 2) {
        const lenTerm = this.containerLen(p.expression, st);
        const a = await this.checkExpr(c.arguments[0]!, st);
        const b = await this.checkExpr(c.arguments[1]!, st);
        const ok = `(and (>= ${a.smt} 0) (<= ${a.smt} ${b.smt}) (<= ${b.smt} ${lenTerm.smt}))`;
        this.addObligation("T002", "slice bounds 0 <= a <= b <= length", p.name, mod, st, ok, a.exact && b.exact && lenTerm.exact);
        st.assumptions.push(ok);
        return { smt: `(- ${b.smt} ${a.smt})`, exact: a.exact && b.exact };
      }
      if (recvT.k === "gen" && recvT.name === "Vec") {
        for (const a of c.arguments) await this.checkExpr(a, st);
        const lk = this.lengthKeyOf(p.expression);
        if (lk) {
          const curLen = st.env.get(lk) ?? this.fresh("Int", "vlen", [0n, MAX_U32]);
          if (m === "push") {
            const nv = this.fresh("Int", "vpush", [0n, MAX_U32]);
            st.assumptions.push(`(= ${nv} (+ ${curLen} 1))`);
            st.env.set(lk, nv);
          } else if (m === "pop") {
            const nv = this.fresh("Int", "vpop", [0n, MAX_U32]);
            st.assumptions.push(`(= ${nv} (ite (> ${curLen} 0) (- ${curLen} 1) 0))`);
            st.env.set(lk, nv);
          } else if (m === "clear") {
            st.env.set(lk, "0");
          }
        }
        return { smt: this.freshForType(retT, m), exact: false };
      }
      for (const a of c.arguments) await this.checkExpr(a, st);
      return { smt: this.freshForType(retT, m), exact: false };
    }

    for (const a of c.arguments) await this.checkExpr(a, st);
    return { smt: this.freshForType(retT, "call"), exact: false };
  }

  private joinInto(target: State, thenSt: State, elseSt: State, condSmt: string, baseAssumpLen: number): void {
    if (thenSt.terminated && elseSt.terminated) {
      target.terminated = true;
      return;
    }
    if (thenSt.terminated) {
      target.env = elseSt.env;
      target.inexact = elseSt.inexact;
      target.assumptions = elseSt.assumptions;
      return;
    }
    if (elseSt.terminated) {
      target.env = thenSt.env;
      target.inexact = thenSt.inexact;
      target.assumptions = thenSt.assumptions;
      return;
    }
    const base = target.assumptions.slice(0, baseAssumpLen);
    const exT = thenSt.assumptions.slice(baseAssumpLen);
    const exF = elseSt.assumptions.slice(baseAssumpLen);
    const thenBranch = exT.length ? `(and ${condSmt} ${exT.join(" ")})` : condSmt;
    const elseBranch = exF.length ? `(and (not ${condSmt}) ${exF.join(" ")})` : `(not ${condSmt})`;
    const eqsT: string[] = [];
    const eqsF: string[] = [];
    const nextEnv = new Map<string, string>();
    const nextInexact = new Set<string>();
    for (const [k, tv] of thenSt.env) {
      const ev = elseSt.env.get(k);
      if (ev === undefined) continue;
      if (thenSt.inexact.has(k) || elseSt.inexact.has(k)) nextInexact.add(k);
      if (tv === ev) {
        nextEnv.set(k, tv);
        continue;
      }
      const sort: "Int" | "Bool" = k.startsWith("nn:") ? "Bool" : "Int";
      const jv = this.fresh(sort, k.startsWith("len:") ? "jlen" : "j");
      nextEnv.set(k, jv);
      eqsT.push(`(= ${jv} ${tv})`);
      eqsF.push(`(= ${jv} ${ev})`);
    }
    target.env = nextEnv;
    target.inexact = nextInexact;
    target.assumptions = [...base];
    if (eqsT.length || exT.length || exF.length) {
      const lhs = eqsT.length ? `(and ${thenBranch} ${eqsT.join(" ")})` : thenBranch;
      const rhs = eqsF.length ? `(and ${elseBranch} ${eqsF.join(" ")})` : elseBranch;
      target.assumptions.push(`(or ${lhs} ${rhs})`);
    }
  }

  /** Collects variable/field/container-length keys mutated anywhere inside `root`. */
  private collectModSet(root: Node): Set<string> {
    const out = new Set<string>();
    const markSym = (sym: LocalSym): void => {
      out.add(`sym:${sym.id}`);
      out.add(`nn:${sym.id}`);
      out.add(`len:${sym.id}`);
      const u = unref(sym.type);
      if (u.k === "record") for (const f of u.fields) { out.add(`field:${sym.id}.${f.name}`); out.add(`len:${sym.id}.${f.name}`); }
    };
    const walk = (n: Node): void => {
      if (n.kind === K.BinaryExpression) {
        const b = n as ts.BinaryExpression;
        const k = b.operatorToken.kind;
        if (k === K.EqualsToken || ARITH_ASSIGN[k] || k === K.SlashEqualsToken || k === K.PercentEqualsToken || BIT_ASSIGN.has(k)) {
          const lt = strip(b.left);
          if (isId(lt)) {
            const sym = localOf.get(lt);
            if (sym) markSym(sym);
          } else if (lt.kind === K.PropertyAccessExpression) {
            const fk = this.fieldKeyOf(lt as ts.PropertyAccessExpression);
            if (fk) out.add(fk);
          }
        }
      } else if (n.kind === K.PrefixUnaryExpression || n.kind === K.PostfixUnaryExpression) {
        const u = n as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression;
        if (u.operator === K.PlusPlusToken || u.operator === K.MinusMinusToken) {
          const lt = strip(u.operand);
          if (isId(lt)) {
            const sym = localOf.get(lt);
            if (sym) markSym(sym);
          } else if (lt.kind === K.PropertyAccessExpression) {
            const fk = this.fieldKeyOf(lt as ts.PropertyAccessExpression);
            if (fk) out.add(fk);
          }
        }
      } else if (n.kind === K.CallExpression) {
        const c = n as ts.CallExpression;
        if (c.expression.kind === K.PropertyAccessExpression) {
          const p = c.expression as ts.PropertyAccessExpression;
          if ((p.name.text === "push" || p.name.text === "pop" || p.name.text === "clear" || p.name.text === "reset") && isId(strip(p.expression))) {
            const sym = localOf.get(strip(p.expression) as ts.Identifier);
            if (sym) out.add(`len:${sym.id}`);
          }
        }
        if (callFns.has(c)) {
          const fn = callFns.get(c);
          fn?.sig.params.forEach((pt, idx) => {
            if (pt.k === "gen" && pt.name === "Mut" && !(pt.args[0]!.k === "gen" && pt.args[0]!.name === "Slice")) {
              const a = c.arguments[idx];
              if (a && isId(strip(a))) {
                const sym = localOf.get(strip(a) as ts.Identifier);
                if (sym) markSym(sym);
              }
            }
          });
        }
      }
      n.forEachChild(walk);
    };
    walk(root);
    return out;
  }

  private havocModSet(modSet: ReadonlySet<string>, st: State): void {
    for (const key of [...st.env.keys()]) {
      if (!modSet.has(key) && !key.startsWith("field:") && !key.startsWith("len:")) continue;
      if (!modSet.has(key)) {
        // Also check parent struct sym for field:/len: keys
        const m = /^(?:field|len):(\d+)/.exec(key);
        if (!m || !modSet.has(`sym:${m[1]}`)) continue;
      }
      st.inexact.delete(key);
      if (key.startsWith("nn:")) st.env.set(key, this.fresh("Bool", "h_nn"));
      else if (key.startsWith("len:")) st.env.set(key, this.fresh("Int", "h_len", [0n, MAX_U32]));
      else {
        const symId = /^sym:(\d+)$/.exec(key)?.[1];
        const sym = symId ? this.findLocalById(Number(symId)) : undefined;
        const u = sym ? unref(sym.type) : undefined;
        if (u?.k === "num" && INT_BOUNDS[u.name]) {
          const [lo, hi] = INT_BOUNDS[u.name]!;
          st.env.set(key, this.fresh("Int", `h_${sym!.name}`, [lo, hi]));
        } else if (u && isBool(u)) {
          st.env.set(key, this.fresh("Bool", `h_${sym!.name}`));
        } else {
          st.env.set(key, this.fresh("Int", "h_v"));
        }
      }
    }
  }

  private findLocalById(id: number): LocalSym | undefined {
    let found: LocalSym | undefined;
    const walk = (n: Node): void => {
      if (found) return;
      if (isId(n)) {
        const s = localOf.get(n);
        if (s?.id === id) { found = s; return; }
      }
      n.forEachChild(walk);
    };
    walk(this.f.decl);
    return found;
  }

  /** Synthesizes and SMT-verifies safe range auto-invariants for canonical counting `for` loops (Q291). */
  private async synthesizeCountingAutoInvariants(
    fs: ts.ForStatement,
    initSym: LocalSym,
    initType: Extract<Type, { k: "num" }>,
    initTerm: string,
    modSet: ReadonlySet<string>,
    entryAssumptions: readonly string[],
    entryEnv: ReadonlyMap<string, string>,
  ): Promise<string[]> {
    const cond = fs.condition ? strip(fs.condition) : undefined;
    const incr = fs.incrementor ? strip(fs.incrementor) : undefined;
    if (!cond || !incr) return [];

    // Ensure loop variable is never written inside loop body or condition
    const bodyMods = this.collectModSet(fs.statement);
    if (bodyMods.has(`sym:${initSym.id}`)) return [];

    let step: bigint | undefined;
    if (incr.kind === K.BinaryExpression) {
      const ib = incr as ts.BinaryExpression;
      if (!isId(strip(ib.left)) || localOf.get(strip(ib.left) as ts.Identifier)?.id !== initSym.id) return [];
      const ik = ib.operatorToken.kind;
      if (ik === K.PlusEqualsToken || ik === K.MinusEqualsToken) {
        const k = intLitValue(ib.right, this.f.mod.sf);
        if (k !== undefined && k > 0n) step = ik === K.PlusEqualsToken ? k : -k;
      } else if (ik === K.EqualsToken && strip(ib.right).kind === K.BinaryExpression) {
        const rb = strip(ib.right) as ts.BinaryExpression;
        const rk = rb.operatorToken.kind;
        if (isId(strip(rb.left)) && localOf.get(strip(rb.left) as ts.Identifier)?.id === initSym.id && (rk === K.PlusToken || rk === K.MinusToken)) {
          const k = intLitValue(rb.right, this.f.mod.sf);
          if (k !== undefined && k > 0n) step = rk === K.PlusToken ? k : -k;
        }
      }
    } else if (incr.kind === K.PrefixUnaryExpression || incr.kind === K.PostfixUnaryExpression) {
      const iu = incr as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression;
      if ((iu.operator === K.PlusPlusToken || iu.operator === K.MinusMinusToken) &&
        isId(strip(iu.operand)) && localOf.get(strip(iu.operand) as ts.Identifier)?.id === initSym.id) {
        step = iu.operator === K.PlusPlusToken ? 1n : -1n;
      }
    }
    if (step === undefined || cond.kind !== K.BinaryExpression) return [];

    const cb = cond as ts.BinaryExpression;
    const ck = cb.operatorToken.kind;
    const cmp = ck === K.LessThanToken ? "<" : ck === K.LessThanEqualsToken ? "<=" : ck === K.GreaterThanToken ? ">" : ck === K.GreaterThanEqualsToken ? ">=" : undefined;
    if (!cmp) return [];

    // Match LHS as `i` or `i + c` / `i - c` with integer literal c, and RHS referencing no modified variable
    let offset = 0n;
    const lhs = strip(cb.left);
    if (isId(lhs) && localOf.get(lhs)?.id === initSym.id) {
      offset = 0n;
    } else if (lhs.kind === K.BinaryExpression) {
      const lb = lhs as ts.BinaryExpression;
      const lk = lb.operatorToken.kind;
      if (isId(strip(lb.left)) && localOf.get(strip(lb.left) as ts.Identifier)?.id === initSym.id && (lk === K.PlusToken || lk === K.MinusToken)) {
        const c = intLitValue(lb.right, this.f.mod.sf);
        if (c === undefined) return [];
        offset = lk === K.PlusToken ? c : -c;
      } else return [];
    } else return [];

    // Verify RHS doesn't mention any symbol in modSet
    let boundMutated = false;
    const checkBound = (n: Node): void => {
      if (boundMutated) return;
      if (isId(n)) {
        const s = localOf.get(n);
        if (s && (modSet.has(`sym:${s.id}`) || modSet.has(`len:${s.id}`))) boundMutated = true;
      }
      n.forEachChild(checkBound);
    };
    checkBound(cb.right);
    if (boundMutated) return [];

    const tmpSt: State = { terminated: false, env: new Map(entryEnv), inexact: new Set(), assumptions: [...entryAssumptions], modelVars: new Map() };
    const bound = this.evalPureInt(cb.right, tmpSt, this.f.mod, new Map(), false);
    if (!bound.exact) return [];

    const [lo, hi] = INT_BOUNDS[initType.name]!;
    const iTest = this.fresh("Int", "auto_i", [lo, hi]);
    const mkCond = (iv: string): string => `(${cmp} ${offset === 0n ? iv : offset > 0n ? `(+ ${iv} ${smtInt(offset)})` : `(- ${iv} ${smtInt(-offset)})`} ${bound.smt})`;
    const nextI = step > 0n ? `(+ ${iTest} ${smtInt(step)})` : `(- ${iTest} ${smtInt(-step)})`;

    // Candidate invariant templates parameterized over loop index variable
    const candidates: ((iv: string) => string)[] = [];
    if (step > 0n && (cmp === "<" || cmp === "<=")) {
      candidates.push((iv) => `(>= ${iv} ${initTerm})`);
      const shift = offset - step;
      const shifted = (iv: string) => (shift === 0n ? iv : shift > 0n ? `(+ ${iv} ${smtInt(shift)})` : `(- ${iv} ${smtInt(-shift)})`);
      candidates.push((iv) => `(or (= ${iv} ${initTerm}) (${cmp} ${shifted(iv)} ${bound.smt}))`);
    } else if (step < 0n && (cmp === ">" || cmp === ">=")) {
      const kAbs = -step;
      candidates.push((iv) => `(<= ${iv} ${initTerm})`);
      const shift = offset + kAbs;
      const shifted = (iv: string) => (shift === 0n ? iv : shift > 0n ? `(+ ${iv} ${smtInt(shift)})` : `(- ${iv} ${smtInt(-shift)})`);
      candidates.push((iv) => `(or (= ${iv} ${initTerm}) (${cmp} ${shifted(iv)} ${bound.smt}))`);
    }
    if (!candidates.length) return [];

    const baseCtx = entryAssumptions.length ? `(and ${entryAssumptions.join(" ")})` : "true";
    const queries: SmtQuery[] = [];
    for (const cFn of candidates) {
      queries.push({ assertion: `(and ${baseCtx} (not ${cFn(initTerm)}))` });
      queries.push({ assertion: `(and ${baseCtx} ${cFn(iTest)} ${mkCond(iTest)} ${inBounds(nextI, lo, hi)} (not ${cFn(nextI)}))` });
    }
    const res = await runSmtBatch(this.preamble.join("\n"), queries, { timeoutMs: 1000, logic: this.nonLinear ? "QF_NIA" : "QF_LIA" });
    const accepted: ((iv: string) => string)[] = [];
    for (let k = 0; k < candidates.length; k++) {
      if (res[k * 2]?.status === "unsat" && res[k * 2 + 1]?.status === "unsat") accepted.push(candidates[k]!);
    }
    // Note: returned expressions still use `{I}` placeholder replaced with the havoced loop index var
    const iKey = `sym:${initSym.id}`;
    return accepted.map((cFn) => cFn(`__I_${iKey}__`));
  }

  /** Extracts leading `invariant(...)` calls at top of a loop body statement or block. */
  private extractLoopInvariants(body: ts.Statement): { invs: ts.CallExpression[]; rest: ts.Statement[] } {
    const stmts = body.kind === K.Block ? (body as ts.Block).statements : [body];
    const invs: ts.CallExpression[] = [];
    let i = 0;
    for (; i < stmts.length; i++) {
      const s = stmts[i]!;
      if (s.kind !== K.ExpressionStatement) break;
      const ex = (s as ts.ExpressionStatement).expression;
      if (ex.kind !== K.CallExpression || !isId((ex as ts.CallExpression).expression)) break;
      if (((ex as ts.CallExpression).expression as ts.Identifier).text !== "invariant") break;
      invs.push(ex as ts.CallExpression);
    }
    return { invs, rest: stmts.slice(i) };
  }

  private hasBreak(n: Node): boolean {
    let found = false;
    const walk = (x: Node): void => {
      if (found) return;
      if (x.kind === K.BreakStatement) { found = true; return; }
      if (x.kind === K.ForStatement || x.kind === K.WhileStatement || x.kind === K.DoStatement || x.kind === K.SwitchStatement) return;
      x.forEachChild(walk);
    };
    walk(n);
    return found;
  }

  async checkStmt(s: ts.Statement, st: State): Promise<void> {
    if (st.terminated) return;
    const mod = this.f.mod;
    switch (s.kind) {
      case K.Block: {
        for (const sub of (s as ts.Block).statements) {
          await this.checkStmt(sub, st);
          if (st.terminated) break;
        }
        return;
      }
      case K.VariableStatement: {
        for (const d of (s as ts.VariableStatement).declarationList.declarations) {
          if (isId(d.name)) {
            const sym = localOf.get(d.name);
            if (!sym) continue;
            if (d.initializer) {
              const v = await this.checkExpr(d.initializer, st);
              const u = unref(sym.type);
              if (u.k === "num" && INT_BOUNDS[u.name]) {
                const key = `sym:${sym.id}`;
                st.env.set(key, v.smt);
                if (v.exact) st.inexact.delete(key); else st.inexact.add(key);
                if (this.loopDepth === 0) st.modelVars.set(sym.name, v.smt);
              } else if (isBool(u)) {
                const key = `sym:${sym.id}`;
                st.env.set(key, v.smt);
                if (v.exact) st.inexact.delete(key); else st.inexact.add(key);
              } else if (isContainer(u)) {
                const lv = v.containerLen ?? this.exprContainerLength(d.initializer, st);
                if (lv) {
                  st.env.set(`len:${sym.id}`, lv);
                  if (v.exact || v.containerLen === undefined) st.inexact.delete(`len:${sym.id}`); else st.inexact.add(`len:${sym.id}`);
                } else {
                  st.env.set(`len:${sym.id}`, this.fresh("Int", `${sym.name}_len`, [0n, MAX_U32]));
                }
              } else if (u.k === "record") {
                this.bindRecordFromExpr(sym.id, sym.name, u, d.initializer, st, v);
              } else if (u.k === "union") {
                if (isTaggedUnion(u)) {
                  this.initLocal(st, sym, sym.name);
                  const rf = this.extractRecordFields(d.initializer, st, mod, v);
                  for (const [path, fv] of rf) {
                    const fk = `field:${sym.id}.${path}`;
                    st.env.set(fk, fv.smt);
                    if (fv.exact) st.inexact.delete(fk); else st.inexact.add(fk);
                  }
                } else if (nonNull(u)) {
                  this.assignPlaceFromExpr(d.name, d.initializer, v, st);
                }
              }
            } else {
              this.initLocal(st, sym, sym.name);
            }
          } else if (d.initializer) {
            await this.checkExpr(d.initializer, st);
          }
        }
        return;
      }
      case K.ExpressionStatement: {
        const e = (s as ts.ExpressionStatement).expression;
        if (e.kind === K.StringLiteral) return;
        if (e.kind === K.CallExpression && isId((e as ts.CallExpression).expression)) {
          const nm = ((e as ts.CallExpression).expression as ts.Identifier).text;
          if (nm === "requires" || nm === "ensures") return;
          if (nm === "invariant") {
            const c = this.evalPureBool((e as ts.CallExpression).arguments[0]!, st, mod, new Map());
            st.assumptions.push(c.smt);
            return;
          }
        }
        await this.checkExpr(e, st);
        return;
      }
      case K.ReturnStatement: {
        const r = (s as ts.ReturnStatement).expression;
        let retVal: TermVal | undefined;
        if (r) retVal = await this.checkExpr(r, st);
        const cs = this.contracts.get(this.f)!;
        for (const ens of cs.ensures) this.checkEnsures(ens, retVal, st, r);
        st.terminated = true;
        return;
      }
      case K.BreakStatement: {
        this.loopBreaks.push(cloneState(st));
        st.terminated = true;
        return;
      }
      case K.ContinueStatement: {
        this.loopContinues.push(cloneState(st));
        st.terminated = true;
        return;
      }
      case K.IfStatement: {
        const ifs = s as ts.IfStatement;
        const cond = await this.checkExpr(ifs.expression, st);
        const baseLen = st.assumptions.length;
        const thenSt = cloneState(st);
        thenSt.assumptions.push(cond.smt);
        await this.checkStmt(ifs.thenStatement, thenSt);
        const elseSt = cloneState(st);
        elseSt.assumptions.push(`(not ${cond.smt})`);
        if (ifs.elseStatement) await this.checkStmt(ifs.elseStatement, elseSt);
        this.joinInto(st, thenSt, elseSt, cond.smt, baseLen);
        return;
      }
      case K.SwitchStatement: {
        const sw = s as ts.SwitchStatement;
        const disc = await this.checkExpr(sw.expression, st);
        const discT = this.typeOf(sw.expression);
        const branchStates: State[] = [];
        let seenDefault = false;
        let remCond = cloneState(st);
        for (const cl of sw.caseBlock.clauses) {
          const clSt = cloneState(remCond);
          if (cl.kind === K.CaseClause) {
            const cVal = await this.checkExpr(cl.expression, remCond);
            const matchTag = isStrLitLike(discT) && disc.exact && cVal.exact;
            const eq = isInt(discT) || isBool(discT) || matchTag ? `(= ${disc.smt} ${cVal.smt})` : this.fresh("Bool", "case_eq");
            clSt.assumptions.push(eq);
            remCond.assumptions.push(`(not ${eq})`);
          } else {
            seenDefault = true;
          }
          const savedBreaks = this.loopBreaks;
          const swBreaks: State[] = [];
          this.loopBreaks = swBreaks;
          for (const st2 of cl.statements) {
            await this.checkStmt(st2, clSt);
            if (clSt.terminated) break;
          }
          this.loopBreaks = savedBreaks;
          for (const br of swBreaks) { br.terminated = false; branchStates.push(br); }
          if (!clSt.terminated) branchStates.push(clSt);
        }
        if (!seenDefault) branchStates.push(remCond);
        if (!branchStates.length) { st.terminated = true; return; }
        let acc = branchStates[0]!;
        for (let i = 1; i < branchStates.length; i++) {
          const merged = cloneState(st);
          const next = branchStates[i]!;
          const dummy = this.fresh("Bool", "sw_br");
          this.joinInto(merged, acc, next, dummy, st.assumptions.length);
          acc = merged;
        }
        st.env = acc.env;
        st.assumptions = acc.assumptions;
        st.terminated = false;
        return;
      }
      case K.ForStatement:
      case K.WhileStatement:
      case K.DoStatement: {
        await this.checkLoop(s as ts.ForStatement | ts.WhileStatement | ts.DoStatement, st);
        return;
      }
    }
  }

  private async checkLoop(loop: ts.ForStatement | ts.WhileStatement | ts.DoStatement, st: State): Promise<void> {
    const isFor = loop.kind === K.ForStatement;
    const isDo = loop.kind === K.DoStatement;
    const body = loop.statement;
    const { invs, rest } = this.extractLoopInvariants(body);
    const modSet = this.collectModSet(loop);

    // Track for-init symbol for potential canonical counting auto-invariants
    let initSym: LocalSym | undefined;
    let initType: Extract<Type, { k: "num" }> | undefined;
    let initTerm: string | undefined;
    if (isFor && loop.initializer) {
      if (loop.initializer.kind === K.VariableDeclarationList) {
        const dl = loop.initializer as ts.VariableDeclarationList;
        for (const d of dl.declarations) {
          if (isId(d.name)) {
            const sym = localOf.get(d.name);
            if (sym) {
              if (d.initializer) {
                const v = await this.checkExpr(d.initializer, st);
                const u = unref(sym.type);
                if (u.k === "num" && INT_BOUNDS[u.name]) {
                  st.env.set(`sym:${sym.id}`, v.smt);
                  if (dl.declarations.length === 1 && v.exact) {
                    initSym = sym;
                    initType = u as Extract<Type, { k: "num" }>;
                    initTerm = v.smt;
                  }
                } else {
                  this.initLocal(st, sym, sym.name);
                }
              } else this.initLocal(st, sym, sym.name);
            }
          }
        }
      } else {
        await this.checkExpr(loop.initializer as ts.Expression, st);
      }
    }

    // 1. Check base case of explicit invariant(...) calls
    for (const inv of invs) {
      const c = this.evalPureBool(inv.arguments[0]!, st, this.f.mod, new Map());
      this.addObligation("T010", "invariant (entry)", inv.expression, this.f.mod, st, c.smt, c.exact);
    }

    // 2. Synthesize + SMT-verify auto-invariants on canonical counting for-loops
    let autoInvTemplates: string[] = [];
    if (isFor && initSym && initType && initTerm) {
      autoInvTemplates = await this.synthesizeCountingAutoInvariants(
        loop as ts.ForStatement, initSym, initType, initTerm, modSet, st.assumptions, st.env,
      );
    }

    // 3. Havoc modified variables for arbitrary iteration
    const loopSt = cloneState(st);
    this.havocModSet(modSet, loopSt);
    if (initSym && autoInvTemplates.length) {
      const hv = loopSt.env.get(`sym:${initSym.id}`)!;
      const ph = `__I_sym:${initSym.id}__`;
      for (const tmpl of autoInvTemplates) loopSt.assumptions.push(tmpl.replaceAll(ph, hv));
    }

    if (!isDo) {
      for (const inv of invs) {
        const c = this.evalPureBool(inv.arguments[0]!, loopSt, this.f.mod, new Map());
        loopSt.assumptions.push(c.smt);
      }
    }

    const condExpr = isFor ? (loop as ts.ForStatement).condition : (loop as ts.WhileStatement | ts.DoStatement).expression;
    let condAfterHead: CondVal = { smt: "true", exact: true };
    const exitFalseSt = cloneState(loopSt);
    if (!isDo && condExpr) {
      condAfterHead = await this.checkExpr(condExpr, loopSt);
      exitFalseSt.assumptions.push(`(not ${condAfterHead.smt})`);
    } else if (!isDo && !condExpr) {
      exitFalseSt.terminated = true;
    }

    const bodySt = cloneState(loopSt);
    if (!isDo && condExpr) bodySt.assumptions.push(condAfterHead.smt);

    const savedBreaks = this.loopBreaks;
    const savedContinues = this.loopContinues;
    this.loopBreaks = [];
    this.loopContinues = [];
    this.loopDepth++;
    try {
      for (const stmt of rest) {
        await this.checkStmt(stmt, bodySt);
        if (bodySt.terminated) break;
      }
    } finally {
      this.loopDepth--;
    }
    const breaks = this.loopBreaks;
    const continues = this.loopContinues;
    this.loopBreaks = savedBreaks;
    this.loopContinues = savedContinues;

    // 4. Check back-edges (body end + continues): run for-incrementor and verify explicit invariant (step)
    const backEdges: State[] = [...continues];
    if (!bodySt.terminated) backEdges.push(bodySt);
    for (const be of backEdges) {
      if (isFor && (loop as ts.ForStatement).incrementor) {
        await this.checkExpr((loop as ts.ForStatement).incrementor!, be);
      }
      if (isDo && condExpr) {
        const dc = await this.checkExpr(condExpr, be);
        be.assumptions.push(dc.smt);
      }
      for (const inv of invs) {
        const c = this.evalPureBool(inv.arguments[0]!, be, this.f.mod, new Map());
        this.addObligation("T010", "invariant (step)", inv.expression, this.f.mod, be, c.smt, c.exact);
      }
    }

    // 5. Post-loop exit state (if loop broke mid-body, fall back to sound havoc across exits)
    if (breaks.length > 0 || isDo) {
      this.havocModSet(modSet, st);
      if (!this.hasBreak(body) && isDo && condExpr) {
        const dc = this.evalPureBool(condExpr, st, this.f.mod, new Map());
        st.assumptions.push(`(not ${dc.smt})`);
      }
    } else if (exitFalseSt.terminated) {
      st.terminated = true;
    } else {
      st.env = exitFalseSt.env;
      st.inexact = exitFalseSt.inexact;
      st.assumptions = exitFalseSt.assumptions;
    }
  }

  private checkEnsures(ens: ts.ArrowFunction, retVal: TermVal | undefined, st: State, retExpr?: ts.Expression): void {
    const ep = ens.parameters[0]?.name;
    const ov = new Map<number, TermVal>();
    const tmpEnv = new Map<string, string>();
    const tmpInexact = new Set<string>();
    if (ep && isId(ep) && retVal) {
      const sym = localOf.get(ep);
      if (sym) {
        ov.set(sym.id, retVal);
        const su = unref(sym.type);
        if (su.k === "record" && (retVal.recordFields || retExpr)) {
          const rf = this.extractRecordFields(retExpr!, st, this.f.mod, retVal);
          for (const [path, fv] of rf) {
            const fk = `field:${sym.id}.${path}`;
            tmpEnv.set(fk, fv.smt);
            if (!fv.exact) tmpInexact.add(fk);
          }
        } else if (isContainer(su) && (retVal.containerLen || retExpr)) {
          const lv = retVal.containerLen ?? this.exprContainerLength(retExpr!, st);
          if (lv) {
            tmpEnv.set(`len:${sym.id}`, lv);
            if (!retVal.exact && retVal.containerLen !== undefined) tmpInexact.add(`len:${sym.id}`);
          }
        }
      }
    }
    const call = ens.parent as ts.CallExpression;
    this.withTempEnv(st, tmpEnv, tmpInexact, () => {
      if (ens.body.kind !== K.Block) {
        const c = this.evalPureBool(ens.body as ts.Expression, st, this.f.mod, ov);
        this.addObligation("T005", "ensures postcondition", call.expression, this.f.mod, st, c.smt, c.exact);
        return;
      }
      const blk = ens.body as ts.Block;
      if (blk.statements.length === 1 && blk.statements[0]!.kind === K.ReturnStatement && (blk.statements[0] as ts.ReturnStatement).expression) {
        const c = this.evalPureBool((blk.statements[0] as ts.ReturnStatement).expression!, st, this.f.mod, ov);
        this.addObligation("T005", "ensures postcondition", call.expression, this.f.mod, st, c.smt, c.exact);
        return;
      }
      this.addObligation("T005", "ensures postcondition (block)", call.expression, this.f.mod, st, "false", false);
    });
  }

  async run(): Promise<void> {
    if (!this.f.decl.body) return;
    if (this.f.decl.parameters.some((p) => !!p.initializer)) {
      const defSt: State = { terminated: false, env: new Map(), inexact: new Set(), assumptions: [], modelVars: new Map() };
      for (const p of this.f.decl.parameters) {
        if (p.initializer) await this.checkExpr(p.initializer, cloneState(defSt));
        if (isId(p.name)) {
          const sym = localOf.get(p.name);
          if (sym) this.initLocal(defSt, sym, sym.name);
        }
      }
    }
    const st = this.initEntry();
    for (const s of this.f.decl.body.statements) {
      await this.checkStmt(s, st);
      if (st.terminated) break;
    }
    if (!st.terminated) {
      const cs = this.contracts.get(this.f)!;
      for (const ens of cs.ensures) this.checkEnsures(ens, undefined, st);
    }
  }
}

// ---- Diff cache (`.szigyr-cache/prove.json`)

interface CachedObligation {
  readonly kind: ObligationKind;
  readonly label: string;
  readonly anchorKey: string;
  readonly range: Range;
  readonly status: ObligationStatus;
  readonly counterexample?: Record<string, SmtValue>;
  readonly calleeKey?: string;
}

const anchorKeyOf = (n: Node, sf: ts.SourceFile): string => `${n.kind}:${n.getStart(sf)}:${n.end}`;

interface CachedFnEntry {
  readonly key: string;
  readonly obligations: readonly CachedObligation[];
  readonly clearedUnsignedDiv?: readonly string[]; // `${line}:${col}`
}

type ProveCacheStore = Record<string, CachedFnEntry>;

function readProveCache(file: string): ProveCacheStore {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ProveCacheStore) : {};
  } catch { return {}; }
}

function writeProveCache(file: string, store: ProveCacheStore): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2));
}

function computeProveKey(decls: Decls, f: FnSym, solverId: string): string {
  const seen = new Set<string>();
  const parts: [string, string][] = [];
  const visitFn = (g: FnSym): void => {
    const id = `fn:${g.mod.pf.path}:${g.name}`;
    if (seen.has(id)) return;
    seen.add(id);
    parts.push([id, g.decl.getText(g.mod.sf)]);
    walkDeps(g.mod, g.decl);
  };
  const visitConst = (c: ConstSym): void => {
    const id = `const:${c.mod.pf.path}:${c.decl.name.getText(c.mod.sf)}`;
    if (seen.has(id)) return;
    seen.add(id);
    parts.push([id, c.decl.getText(c.mod.sf)]);
  };
  const walkDeps = (mod: Module, root: Node | undefined): void => {
    if (!root) return;
    const visit = (n: Node): void => {
      if (n.kind === K.CallExpression) {
        const cf = callFns.get(n);
        if (cf) visitFn(cf);
      } else if (n.kind === K.PropertyAccessExpression) {
        const p = n as ts.PropertyAccessExpression;
        if (isId(p.expression) && !localOf.has(p.expression)) {
          const ns = mod.nsImports.get(p.expression.text);
          if (ns && !ns.typeOnly) {
            const sym = decls.lookupExportedValue(ns.mod, p.name.text);
            if (sym?.k === "const") visitConst(sym);
          }
        }
      } else if (isId(n) && !localOf.has(n)) {
        const sym = decls.lookupValue(mod, n.text);
        if (sym?.k === "const") visitConst(sym);
      }
      n.forEachChild(visit);
    };
    visit(root);
  };
  visitFn(f);
  parts.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify({ v: PROVE_VERSION, solverId, parts })).digest("hex");
}

/** Finds private-callee constraints (exported, called outside proved targets, or referenced by value). */
function findExposedCallees(decls: Decls, targetSet: ReadonlySet<FnSym>): Set<FnSym> {
  const exposed = new Set<FnSym>();
  for (const mod of decls.mods) {
    for (const expName of mod.exports.keys()) {
      const sym = decls.lookupExportedValue(mod, expName);
      if (sym?.k === "fn") exposed.add(sym);
    }
    const visit = (n: Node, currentFn: FnSym | undefined): void => {
      const nextFn = n.kind === K.FunctionDeclaration ? decls.fns.find((x) => x.decl === n) : currentFn;
      if (n.kind === K.CallExpression) {
        const target = callFns.get(n);
        if (target && (!nextFn || !targetSet.has(nextFn))) exposed.add(target);
      } else if (n.kind === K.PropertyAccessExpression) {
        const pa = n as ts.PropertyAccessExpression;
        if (isId(pa.expression) && !localOf.has(pa.expression) && !(pa.parent?.kind === K.CallExpression && (pa.parent as ts.CallExpression).expression === pa)) {
          const ns = mod.nsImports.get(pa.expression.text);
          const sym = ns && !ns.typeOnly ? decls.lookupExportedValue(ns.mod, pa.name.text) : undefined;
          if (sym?.k === "fn") exposed.add(sym);
        }
      } else if (isId(n) && !localOf.has(n)) {
        const p = n.parent;
        const skip = !p
          || (p.kind === K.FunctionDeclaration && (p as ts.FunctionDeclaration).name === n)
          || (p.kind === K.CallExpression && (p as ts.CallExpression).expression === n)
          || p.kind === K.ExportSpecifier
          || p.kind === K.ImportSpecifier
          || (p.kind === K.PropertyAccessExpression && (p as ts.PropertyAccessExpression).name === n)
          || (p.kind === K.PropertyAssignment && (p as ts.PropertyAssignment).name === n);
        if (!skip) {
          const sym = decls.lookupValue(mod, n.text);
          if (sym?.k === "fn") exposed.add(sym);
        }
      }
      n.forEachChild((ch) => visit(ch, nextFn));
    };
    visit(mod.sf, undefined);
  }
  return exposed;
}

/** Builds node index of every syntactic obligation anchor in `f` for cache hydration. */
function indexAnchors(f: FnSym): Map<string, Node> {
  const out = new Map<string, Node>();
  const sf = f.mod.sf;
  const add = (n: Node): void => { out.set(anchorKeyOf(n, sf), n); };
  const walk = (n: Node): void => {
    if (n.kind === K.ElementAccessExpression) add((n as ts.ElementAccessExpression).argumentExpression);
    else if (n.kind === K.BinaryExpression) add((n as ts.BinaryExpression).operatorToken);
    else if (n.kind === K.PrefixUnaryExpression || n.kind === K.PostfixUnaryExpression) add(n);
    else if (n.kind === K.PropertyAccessExpression) add((n as ts.PropertyAccessExpression).name);
    else if (n.kind === K.CallExpression) {
      const c = n as ts.CallExpression;
      add(c.expression);
      if (c.expression.kind === K.PropertyAccessExpression) add((c.expression as ts.PropertyAccessExpression).name);
    }
    n.forEachChild(walk);
  };
  for (const p of f.decl.parameters) if (p.initializer) walk(p.initializer);
  if (f.decl.body) walk(f.decl.body);
  return out;
}

function summarize(obs: readonly ProveObligation[]): ProveFnResult["summary"] {
  let proved = 0, failed = 0, unknown = 0, timeout = 0;
  for (const o of obs) {
    if (o.status === "proved") proved++;
    else if (o.status === "failed") failed++;
    else if (o.status === "timeout") timeout++;
    else unknown++;
  }
  return { proved, failed, unknown, timeout };
}

function mergeObligations(
  raw: readonly { obl: PendingObligation; status: ObligationStatus; counterexample?: Record<string, SmtValue> }[],
): {
  merged: ProveObligation[];
  cachedObs: CachedObligation[];
  anchorMap: Map<Node, boolean>;
  clearedKeys: Set<string>;
  callReqStats: Map<string, { allProved: boolean }>;
} {
  const byAnchorKind = new Map<string, {
    kind: ObligationKind;
    label: string;
    anchor: Node;
    anchorKey: string;
    range: Range;
    statuses: ObligationStatus[];
    model?: Record<string, SmtValue>;
    calleeKey?: string;
  }>();
  for (const item of raw) {
    const o = item.obl;
    const key = `${o.kind}@${o.anchorKey}`;
    let grp = byAnchorKind.get(key);
    if (!grp) {
      grp = { kind: o.kind, label: o.label, anchor: o.anchor, anchorKey: o.anchorKey, range: o.range, statuses: [], calleeKey: o.calleeKey };
      byAnchorKind.set(key, grp);
    }
    grp.statuses.push(item.status);
    if (item.status === "failed" && !grp.model && item.counterexample) grp.model = item.counterexample;
  }

  const merged: ProveObligation[] = [];
  const cachedObs: CachedObligation[] = [];
  const anchorOk = new Map<Node, boolean>();
  const clearedKeys = new Set<string>();
  const callReqStats = new Map<string, { allProved: boolean }>();

  for (const grp of byAnchorKind.values()) {
    const status: ObligationStatus = grp.statuses.includes("failed") ? "failed"
      : grp.statuses.includes("timeout") ? "timeout"
      : grp.statuses.includes("unknown") ? "unknown"
      : "proved";
    const pub: ProveObligation = {
      kind: grp.kind,
      label: grp.label,
      range: grp.range,
      status,
      ...(status === "failed" && grp.model ? { counterexample: grp.model } : {}),
    };
    merged.push(pub);
    cachedObs.push({
      ...pub,
      anchorKey: grp.anchorKey,
      ...(grp.calleeKey ? { calleeKey: grp.calleeKey } : {}),
    });
    const prev = anchorOk.get(grp.anchor) ?? true;
    anchorOk.set(grp.anchor, prev && status === "proved");
    if (status === "proved") clearedKeys.add(`${grp.kind}@${grp.range.start.line}:${grp.range.start.col}`);
    if (grp.kind === "T004" && grp.calleeKey) {
      const cur = callReqStats.get(grp.calleeKey) ?? { allProved: true };
      cur.allProved = cur.allProved && status === "proved";
      callReqStats.set(grp.calleeKey, cur);
    }
  }
  return { merged, cachedObs, anchorMap: anchorOk, clearedKeys, callReqStats };
}

/** Runs async per-function SMT verification over `entryFile` (`all: true` includes locally imported modules). */
export async function proveFile(entryFile: string, opts: ProveOptions = {}): Promise<ProveResult> {
  const analysis = opts.analysis ?? analyze(entryFile, opts.parser);
  const solver = detectSolver();
  const empty: ProveResult = {
    diagnostics: analysis.diagnostics,
    solver: solver.id,
    functions: [],
    summary: { functions: 0, proved: 0, failed: 0, unknown: 0, timeout: 0, cached: 0 },
    proved: { anchors: new Set(), provedPrivateRequires: new Set() },
  };
  if (analysis.diagnostics.length || !analysis.decls) return empty;

  const decls = analysis.decls;
  const entryPath = canonPath(entryFile);
  const contracts = new Map<FnSym, ExtractedContracts>();
  for (const f of decls.fns) contracts.set(f, extractContracts(f));

  const fnParamCount = (f: FnSym): number => f.sig.params.filter((p) => unref(p).k === "fn").length;
  const allTargets = decls.fns.filter((f) => {
    if (f.mod.pf.path === DETMATH_PATH) return false;
    if (!opts.all && canonPath(f.mod.pf.path) !== entryPath) return false;
    if (f.unsafe || f.sig.tparams.length > 0 || fnParamCount(f) > 0) return false;
    return f.layer !== "managed" || hasContractOrLoop(f);
  });
  const targets = opts.skipFiles ? allTargets.filter((f) => !opts.skipFiles!.has(f.mod.pf.path)) : allTargets;
  const exposed = findExposedCallees(decls, new Set(allTargets));

  const rtSiteCache = new Map<Module, Record<string, TrapSite[]>>();
  const getRtSites = (mod: Module, fnName: string): TrapSite[] => {
    let map = rtSiteCache.get(mod);
    if (!map) rtSiteCache.set(mod, map = trapSites(mod.pf));
    return map[fnName] ?? [];
  };

  const useCache = opts.cache !== false;
  const cacheFile = opts.cacheFile ?? resolve(CACHE_DIR, "prove.json");
  const cacheStore: ProveCacheStore = useCache ? readProveCache(cacheFile) : {};
  let cacheDirty = false;

  const anchors = new Set<Node>();
  const calleeCalls = new Map<string, { called: number; allProved: boolean }>();
  const fnResults: ProveFnResult[] = new Array(targets.length);
  const concurrency = solver.kind === "z3-wasm" ? 1 : 4;
  let nextIdx = 0;

  const processOne = async (idx: number): Promise<void> => {
    const f = targets[idx]!;
    const fileDisp = displayPath(f.mod.pf.path);
    const cacheId = `${f.mod.pf.path}::${f.name}`;
    const key = computeProveKey(decls, f, solver.id);
    const hit = useCache ? cacheStore[cacheId] : undefined;

    if (hit && hit.key === key) {
      const anchorIndex = indexAnchors(f);
      const clearedKeys = new Set<string>(hit.clearedUnsignedDiv ?? []);
      const okByAnchor = new Map<Node, boolean>();
      const obligations: ProveObligation[] = [];
      for (const o of hit.obligations) {
        if (o.status === "proved") clearedKeys.add(`${o.kind}@${o.range.start.line}:${o.range.start.col}`);
        const n = anchorIndex.get(o.anchorKey);
        if (n) okByAnchor.set(n, (okByAnchor.get(n) ?? true) && o.status === "proved");
        if (o.kind === "T004" && o.calleeKey) {
          const cur = calleeCalls.get(o.calleeKey) ?? { called: 0, allProved: true };
          cur.called++;
          cur.allProved = cur.allProved && o.status === "proved";
          calleeCalls.set(o.calleeKey, cur);
        }
        obligations.push({
          kind: o.kind,
          label: o.label,
          range: o.range,
          status: o.status,
          ...(o.counterexample ? { counterexample: o.counterexample } : {}),
        });
      }
      for (const [n, ok] of okByAnchor) if (ok) anchors.add(n);
      const remaining = f.layer === "rt"
        ? getRtSites(f.mod, f.name).filter((s) => !clearedKeys.has(`${s.code}@${s.line}:${s.col}`))
        : undefined;
      fnResults[idx] = {
        file: fileDisp, fn: f.name, layer: f.layer, solver: solver.id, cached: true,
        obligations, summary: summarize(obligations),
        ...(remaining !== undefined ? { remainingRtTrapSites: remaining } : {}),
      };
      return;
    }

    const prover = new FnProver(decls, f, contracts);
    await prover.run();

    const queries: SmtQuery[] = prover.obligations.map((o) => {
      const ctx = o.assumptions.length ? `(and ${o.assumptions.join(" ")})` : "true";
      return { assertion: `(and ${ctx} (not ${o.goal}))`, modelVars: o.modelVars };
    });

    const smtRes = await runSmtBatch(prover.preamble.join("\n"), queries, {
      timeoutMs: opts.timeoutMs ?? 2000,
      logic: prover.nonLinear ? "QF_NIA" : "QF_LIA",
    });

    const raw = prover.obligations.map((obl, i) => {
      const r = smtRes[i]!;
      let status: ObligationStatus;
      if (r.status === "unsat") status = "proved";
      else if (r.status === "timeout") status = "timeout";
      else if (r.status === "sat") status = obl.exact ? "failed" : "unknown";
      else status = "unknown";
      return { obl, status, ...(status === "failed" && r.model ? { counterexample: r.model } : {}) };
    });

    const { merged, cachedObs, anchorMap, clearedKeys, callReqStats } = mergeObligations(raw);
    for (const [n, ok] of anchorMap) if (ok) anchors.add(n);
    for (const [ck, stat] of callReqStats) {
      const cur = calleeCalls.get(ck) ?? { called: 0, allProved: true };
      cur.called++;
      cur.allProved = cur.allProved && stat.allProved;
      calleeCalls.set(ck, cur);
    }

    const extraDivCleared: string[] = [];
    for (const uNode of prover.unsignedDivAnchors) {
      const pos = f.mod.pf.position(uNode.getStart(f.mod.sf));
      if (clearedKeys.has(`T007@${pos.line}:${pos.col}`)) {
        const k = `T001@${pos.line}:${pos.col}`;
        clearedKeys.add(k);
        extraDivCleared.push(k);
      }
    }

    const remaining = f.layer === "rt"
      ? getRtSites(f.mod, f.name).filter((s) => !clearedKeys.has(`${s.code}@${s.line}:${s.col}`))
      : undefined;

    fnResults[idx] = {
      file: fileDisp, fn: f.name, layer: f.layer, solver: solver.id, cached: false,
      obligations: merged, summary: summarize(merged),
      ...(remaining !== undefined ? { remainingRtTrapSites: remaining } : {}),
    };

    if (useCache) {
      cacheStore[cacheId] = { key, obligations: cachedObs, ...(extraDivCleared.length ? { clearedUnsignedDiv: extraDivCleared } : {}) };
      cacheDirty = true;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, async () => {
      while (nextIdx < targets.length) {
        const myIdx = nextIdx++;
        await processOne(myIdx);
      }
    }),
  );

  if (useCache && cacheDirty) writeProveCache(cacheFile, cacheStore);

  const provedPrivateRequires = new Set<FnSym>();
  for (const f of decls.fns) {
    if (f.layer === "managed" || f.unsafe || f.sig.tparams.length > 0 || fnParamCount(f) > 0) continue;
    if (exposed.has(f)) continue;
    const cs = contracts.get(f);
    if (!cs?.requires.length) continue;
    const ck = `${f.mod.pf.path}::${f.name}`;
    const stat = calleeCalls.get(ck);
    if (stat && stat.called > 0 && stat.allProved) provedPrivateRequires.add(f);
  }
  for (let i = 0; i < targets.length; i++) {
    const f = targets[i]!;
    const fr = fnResults[i]!;
    if (!provedPrivateRequires.has(f) || !fr.remainingRtTrapSites?.length) continue;
    const reqKeys = new Set(contracts.get(f)!.requires.map((r) => {
      const p = f.mod.pf.position(r.expression.getStart(f.mod.sf));
      return `T004@${p.line}:${p.col}`;
    }));
    fnResults[i] = {
      ...fr,
      remainingRtTrapSites: fr.remainingRtTrapSites.filter((s) => !reqKeys.has(`${s.code}@${s.line}:${s.col}`)),
    };
  }

  let proved = 0, failed = 0, unknown = 0, timeout = 0, cached = 0;
  for (const fr of fnResults) {
    proved += fr.summary.proved;
    failed += fr.summary.failed;
    unknown += fr.summary.unknown;
    timeout += fr.summary.timeout;
    if (fr.cached) cached++;
  }

  return {
    diagnostics: [],
    solver: solver.id,
    functions: fnResults,
    summary: { functions: fnResults.length, proved, failed, unknown, timeout, cached },
    proved: { anchors, provedPrivateRequires },
  };
}
