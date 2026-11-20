// P2 checker (D012): declarations, statements, control flow, narrowing. Expressions live in expr.ts.
import { NodeFlags, SyntaxKind as K, hasMod, isId, type Node, type ts } from "./parse.ts";
import { Program, declBindings, legalUnion, type ClassValueSym, type FnSym, type Layer, type LocalSym, type Module, type ValueSym } from "./modules.ts";
import { PROMISE_CONTAINERS, assignTarget, checkTo, exprTypes, hasPromise, cond, expr, isLitOnly, localOf, promiseOk, type FnArgRef } from "./expr.ts";
import {
  AUTHORITIES, ERROR, NEVER, NULL, STR, VOID, assignable, hasAuthority, hasPtr, layerOk, crossOk, ptrTargetOk, field, isBool, isErr, isNull, isTaggedUnion, kindOf, nonNull, same, show, subst, bindTParams, unref, union, subUnion,
  type ClassSym, type FnType, type TParam, type Type,
} from "./types.ts";

export interface FnCtx {
  mod: Module;
  layer: Layer;
  /** Declared return type (Promise unwrapped for async); undefined: inferred (arrow without annotation). */
  ret: Type | undefined;
  returns: Type[];
  async: boolean;
  thisType?: Type;
  cls?: ClassSym;
  inCtor: boolean;
  tparams: Map<string, TParam>;
  depth: number;
  /** Set while checking the argument of `requires` / `ensures` (E6002, Q056). */
  contract?: { kind: "requires" | "ensures"; depth: number };
  /** The enclosing named function's parameter list (E5001 fixes, Q073). */
  params?: ts.NodeArray<ts.ParameterDeclaration>;
  /** The function-like node being checked (Q122). */
  node?: Node;
  /** §14.4: the enclosing function carries the `"use unsafe"` modifier (inherited by nested functions). */
  unsafe: boolean;
}

export class Scope {
  readonly vars = new Map<string, LocalSym>();
  readonly parent: Scope | undefined;
  constructor(parent?: Scope) { this.parent = parent; }
  lookup(name: string): LocalSym | undefined { return this.vars.get(name) ?? this.parent?.lookup(name); }
}

let localId = 0;

/** A call to a strict / rt function, or through a function-typed parameter (Q189 (b); see Checker.fnSites). */
export interface FnSite { from: FnSym | undefined; callee: FnSym | number; refs: Map<number, FnArgRef>; node: Node; mod: Module }

export class Checker {
  scope = new Scope();
  /** Untyped `let x = <numeric literal>` locals by id, for the E2003 fix (SPEC §11). */
  litLets = new Map<number, ts.Identifier>();
  narrow = new Map<string, Type>();
  /** Q122: every local id whose narrowings were dropped, in order. A mark is an index into it. */
  kills: string[] = [];
  /** Q122: declaring identifier nodes of locals / parameters that a nested function refers to and that some code assigns. */
  unstable = new Set<Node>();
  fx!: FnCtx;
  /** The module-level function being checked. */
  fn: FnSym | undefined;
  /** Calls to strict / rt functions and through function-typed parameters, for E4005 per instantiation (Q046, Q189 (b)).
   * `callee` is a module function, or the index of a function-typed parameter of `from`; `refs` resolves the
   * callee's function-typed parameters (by their index) to module functions or parameters of `from`. */
  readonly fnSites: FnSite[] = [];
  /** §14.7 (Q196): the E4008 anchor of every unsafe operation (§14.4) recognised, in visit
   * order. Only `run` / `test` read this (they turn the first one, in path order, into
   * E4009); `check` never reports E4009. */
  readonly unsafeOps: { mod: Module; node: Node }[] = [];
  noteUnsafeOp(node: Node): void { this.unsafeOps.push({ mod: this.fx.mod, node }); }

  readonly prog: Program;
  constructor(prog: Program) { this.prog = prog; }

  get mod(): Module { return this.fx.mod; }
  at(code: string, n: Node, message: string, data?: Record<string, unknown>): void { this.prog.rep.at(this.fx.mod, code, n, message, data); }
  report(code: string, start: number, end: number, message: string): void { this.prog.rep.report(this.fx.mod, code, start, end, message); }

  /** Q121: the `this.f` targets of the constructor's initializing statements (readonly fields may be assigned there only). */
  ctorInits = new Set<Node>();
  /** The first expression typed as the error type (D009: only after a diagnostic). */
  firstError: { node: Node; mod: Module } | undefined;
  run(): void {
    for (const mod of this.prog.mods) this.module(mod);
    this.fnGraph();
    this.prog.checkInsts();
    // Fail closed: an error type without any diagnostic would accept anything (D050).
    if (this.firstError && this.prog.rep.out.length === 0) { // any diagnostic, signatures included
      this.prog.rep.at(this.firstError.mod, "E2002", this.firstError.node, "internal: expression has no type");
    }
  }

  // ---- symbols
  declare(name: ts.Identifier, type: Type, opts: { mutable?: boolean; param?: boolean; declared?: Type } = {}): LocalSym {
    const sym: LocalSym = { k: "local", id: ++localId, name: name.text, type, declared: opts.declared ?? type, mutable: !!opts.mutable, param: !!opts.param, fnDepth: this.fx.depth };
    if (this.unstable.has(name)) sym.unstable = true;
    this.scope.vars.set(name.text, sym);
    localOf.set(name, sym);
    return sym;
  }
  value(name: string): ValueSym | undefined { return this.scope.lookup(name) ?? this.prog.lookupValue(this.fx.mod, name); }
  typeOf(t: ts.TypeNode, voidOk = false): Type { return this.prog.typeOf(t, { mod: this.fx.mod, tparams: this.fx.tparams }, voidOk); }

  // ---- narrowing (Q025): keys are `<local id>` or `this`, then `.field` for readonly fields
  keyOf(e: ts.Expression): { key: string; type: Type } | undefined {
    if (e.kind === K.ParenthesizedExpression) return this.keyOf((e as ts.ParenthesizedExpression).expression);
    if (isId(e)) {
      const s = this.scope.lookup(e.text);
      return s && !s.unstable ? { key: `${s.id}`, type: this.narrow.get(`${s.id}`) ?? s.type } : undefined;
    }
    if (e.kind === K.ThisKeyword) return this.fx.thisType ? { key: "this", type: this.fx.thisType } : undefined;
    if (e.kind !== K.PropertyAccessExpression || (e as ts.PropertyAccessExpression).questionDotToken) return undefined;
    const p = e as ts.PropertyAccessExpression;
    const base = this.keyOf(p.expression);
    if (!base) return undefined;
    const key = `${base.key}.${p.name.text}`;
    const bt = unref(base.type);
    const f = bt.k === "record" ? field(bt, p.name.text) : undefined;
    const cf = bt.k === "class" ? bt.cls.fields.get(p.name.text) : undefined;
    if (f?.readonly) return { key, type: this.narrow.get(key) ?? f.type };
    if (cf?.readonly && !cf.static) return { key, type: this.narrow.get(key) ?? subst(cf.type, bindTParams(bt.k === "class" ? bt.cls.tparams : [], bt.k === "class" ? bt.args : [])) };
    return undefined;
  }

  /** Facts that hold when `e` evaluates to `when`. */
  facts(e: ts.Expression, when: boolean): Map<string, Type> {
    const out = new Map<string, Type>();
    if (e.kind === K.ParenthesizedExpression) return this.facts((e as ts.ParenthesizedExpression).expression, when);
    if (e.kind === K.PrefixUnaryExpression && (e as ts.PrefixUnaryExpression).operator === K.ExclamationToken) return this.facts((e as ts.PrefixUnaryExpression).operand, !when);
    if (e.kind !== K.BinaryExpression) return out;
    const b = e as ts.BinaryExpression;
    const op = b.operatorToken.kind;
    if ((op === K.AmpersandAmpersandToken && when) || (op === K.BarBarToken && !when)) {
      const l = this.facts(b.left, when);
      const saved = this.narrow;
      this.narrow = new Map([...saved, ...l]);
      const r = this.facts(b.right, when);
      this.narrow = saved;
      return new Map([...l, ...r]);
    }
    if (op !== K.EqualsEqualsEqualsToken && op !== K.ExclamationEqualsEqualsToken) return out;
    const eq = (op === K.EqualsEqualsEqualsToken) === when;
    for (const [x, y] of [[b.left, b.right], [b.right, b.left]] as const) {
      if (y.kind === K.NullKeyword) { // x === null
        const r = this.keyOf(x);
        const nn = r && nonNull(r.type);
        if (r && nn) out.set(r.key, eq ? NULL : nn);
      } else if (y.kind === K.StringLiteral && x.kind === K.PropertyAccessExpression && (x as ts.PropertyAccessExpression).name.text === "kind") { // x.kind === "a"
        const r = this.keyOf((x as ts.PropertyAccessExpression).expression);
        const t = r && unref(r.type);
        if (r && t && isTaggedUnion(t)) {
          const v = (y as ts.StringLiteral).text;
          out.set(r.key, subUnion(t.members.filter((m) => (kindOf(m) === v) === eq)));
        }
      } else if (y.kind === K.StringLiteral) { // x === "a" on a string-literal union
        const r = this.keyOf(x);
        if (r && r.type.k === "union" && r.type.members.every((m) => m.k === "lit")) {
          const v = (y as ts.StringLiteral).text;
          const rest = r.type.members.filter((m) => (m.k === "lit" && m.value === v) === eq);
          if (rest.length) out.set(r.key, subUnion(rest));
        }
      }
    }
    return out;
  }
  /** Adds facts, except those about locals assigned since `mark` (Q122). */
  withFacts(f: Map<string, Type>, mark?: number, end?: number): void {
    const dead = mark === undefined ? undefined : this.killedSince(mark, end);
    const add = [...f].filter(([k]) => !dead || !isDead(k, dead));
    if (add.length) this.narrow = new Map([...this.narrow, ...add]);
  }
  /** An assignment to the key (a local or a `this.f` path) ends the narrowings on it and below (Q025), and is logged so that saved states drop them too (Q122). */
  forget(key: string): void {
    this.kills.push(key);
    const dead = new Set([key]);
    for (const k of [...this.narrow.keys()]) if (isDead(k, dead)) this.narrow.delete(k);
  }
  /** The assignment target `e` (parentheses removed): ends its narrowings; returns the target and its key, if it has one (Q133). */
  assigned(e: ts.Expression): { node: ts.Expression; key?: string } {
    const node = assignTarget(e);
    const k = this.keyOf(node)?.key;
    if (k) this.forget(k);
    return { node, key: k };
  }
  mark(): number { return this.kills.length; }
  killedSince(mark: number, end?: number): Set<string> { return new Set(this.kills.slice(mark, end)); }
  /** `saved` without the narrowings of keys assigned since `mark`: the state after code that may have run (Q122). */
  restore(saved: Map<string, Type>, mark: number): void {
    const dead = this.killedSince(mark);
    this.narrow = dead.size ? new Map([...saved].filter(([k]) => !isDead(k, dead))) : saved;
  }
  /**
   * Q133: the one entry for code that runs conditionally (the right side of `&&` / `||` / `??`, a branch of `?:`, an optional call,
   * a loop body). It starts from the current narrowings plus `facts`; afterwards the narrowings it added are gone and those it
   * assigned stay ended. `if` and `switch` join their branches themselves (Q131, Q122 3).
   */
  branch<T>(f: () => T, facts?: Map<string, Type>, factsMark?: number, factsEnd?: number): T {
    const saved = this.narrow, m = this.mark();
    this.narrow = new Map(saved);
    if (facts) this.withFacts(facts, factsMark, factsEnd ?? m);
    try { return f(); } finally { this.restore(saved, m); }
  }

  // ---- modules
  private module(mod: Module): void {
    this.unsafeTypes(mod);
    this.unstable = capturedAssigned(mod.sf);
    for (const s of mod.sf.statements) {
      this.fx = { mod, layer: "managed", ret: undefined, returns: [], async: false, inCtor: false, tparams: new Map(), depth: 0, unsafe: false };
      this.scope = new Scope();
      this.narrow = new Map();
      switch (s.kind) {
        case K.FunctionDeclaration: {
          const sym = mod.values.get((s as ts.FunctionDeclaration).name!.text);
          if (sym?.k !== "fn") break;
          this.fn = sym;
          if (sym.layer !== "managed") this.layerSig(sym);
          this.fnBody(s as ts.FunctionDeclaration, sym.sig, { layer: sym.layer, unsafe: sym.unsafe, params: (s as ts.FunctionDeclaration).parameters });
          this.fn = undefined;
          break;
        }
        case K.ClassDeclaration: this.classBody(mod.values.get((s as ts.ClassDeclaration).name!.text) as ClassValueSym); break;
        case K.VariableStatement:
          for (const d of (s as ts.VariableStatement).declarationList.declarations) {
            const b = declBindings(d)[0];
            const sym = b && mod.values.get(b.id.text);
            if (sym?.k !== "const" || !d.type) continue;
            this.moduleConst(b!.el ? this.typeOf(d.type) : sym.type, d.initializer!); // Q225 (b): a destructuring checks the whole record once
          }
          break;
        case K.ExpressionStatement: expr(this, (s as ts.ExpressionStatement).expression); break; // test(...) (§9.2)
      }
    }
  }

  /** §3.3, §6: a strict / rt signature uses §3.3 types (E4002); rt takes no authority (E4006); `async` is managed-only (Q069). */
  private layerSig(f: FnSym): void {
    const d = f.decl;
    const kw = (d.modifiers ?? []).find((m) => m.kind === K.AsyncKeyword);
    if (kw) this.at("E4002", kw, `${f.layer} functions cannot be async`);
    d.parameters.forEach((p, i) => { if (p.type) this.layerParamType(f.sig.params[i] ?? ERROR, p.type, f.layer); });
    if (d.type) this.layerType(f.sig.ret, d.type, f.layer);
    d.parameters.forEach((p, i) => { const t = f.sig.params[i]; if (p.type && t && t.k !== "fn" && layerOk(t) && !crossOk(t)) this.at("E4002", p.type, `'${show(t)}' cannot cross the managed / C boundary (Q233)`); });
    if (d.type && layerOk(f.sig.ret) && !crossOk(f.sig.ret, true)) this.at("E4002", d.type, `'${show(f.sig.ret)}' cannot cross the managed / C boundary (Q233)`);
  }
  /** Q189 (b): a function type may be written as the parameter type of a strict / rt function (and, recursively,
   * as a parameter type inside one). Its return type is not a parameter position, so it goes through layerType. */
  layerParamType(t: Type, node: Node, layer: Layer): void {
    if (t.k !== "fn") { this.layerType(t, node, layer); return; }
    if (layer === "rt" && hasAuthDeep(t)) this.at("E4006", node, "rt functions cannot take authorities");
    const f = node.kind === K.FunctionType ? (node as ts.FunctionTypeNode) : undefined;
    t.params.forEach((pt, i) => this.layerParamType(pt, f?.parameters[i]?.type ?? node, layer));
    this.layerType(t.ret, f?.type ?? node, layer);
  }
  layerType(t: Type, node: Node, layer: Layer): void {
    if (layer === "rt" && hasAuthority(t)) this.at("E4006", node, "rt functions cannot take authorities");
    else if (t.k === "fn") this.at("E4003", node, `a function value cannot be used in ${layer} code`); // §2: function values are E4003
    else if (!layerOk(t)) this.at("E4002", node, `'${show(t)}' cannot be used in ${layer} code`);
  }

  /** E4005 (Q046, Q189 (b)): recursion among rt instantiations. An instantiation is a strict / rt function
   * plus the concrete functions bound to its function-typed parameters; edges resolve function names and
   * forwarded parameters through the caller's instantiation, so a cycle is judged on the calls that can
   * actually happen. Functions without function-typed parameters are their own single instantiation. */
  private fnGraph(): void {
    interface Inst { f: FnSym; m: Map<number, FnSym> }
    const fid = new Map<FnSym, number>(this.prog.fns.map((f, i) => [f, i]));
    const fnParams = (f: FnSym): number[] => f.sig.params.flatMap((pt, i) => (unref(pt).k === "fn" ? [i] : []));
    const key = (x: Inst): string => `${fid.get(x.f)}|${[...x.m].map(([i, g]) => `${i}:${fid.get(g)}`).join(",")}`;
    const insts = new Map<string, Inst>();
    const edges = new Map<string, { to: Inst; site: FnSite }[]>();
    const queue: Inst[] = [];
    const add = (f: FnSym, m: Map<number, FnSym>): Inst => {
      const x: Inst = { f, m };
      const k = key(x);
      const got = insts.get(k);
      if (got) return got;
      insts.set(k, x); queue.push(x);
      return x;
    };
    const resolve = (site: FnSite, cur: Inst | undefined): Inst | undefined => {
      const callee = typeof site.callee === "number" ? cur?.m.get(site.callee) : site.callee;
      if (!callee) return undefined;
      const m = new Map<number, FnSym>();
      for (const j of fnParams(callee)) {
        const r = site.refs.get(j);
        const g = r ? ("fn" in r ? r.fn : cur?.m.get(r.param)) : undefined;
        if (!g) return undefined;
        m.set(j, g);
      }
      return add(callee, m);
    };
    for (const f of this.prog.fns) if (f.layer !== "managed" && !fnParams(f).length) add(f, new Map());
    for (const site of this.fnSites) if (!site.from || site.from.layer === "managed") resolve(site, undefined);
    for (let q = queue.shift(); q; q = queue.shift()) {
      const fromKey = key(q);
      for (const site of this.fnSites) {
        if (site.from !== q.f) continue;
        const to = resolve(site, q);
        if (!to) continue;
        let list = edges.get(fromKey);
        if (!list) edges.set(fromKey, list = []);
        list.push({ to, site });
      }
    }
    const reaches = (from: Inst, to: Inst): boolean => {
      const target = key(to), seen = new Set<string>(), todo = [from];
      while (todo.length) {
        const x = todo.pop()!;
        if (key(x) === target) return true;
        if (seen.has(key(x))) continue;
        seen.add(key(x));
        for (const e of edges.get(key(x)) ?? []) todo.push(e.to);
      }
      return false;
    };
    const reported = new Set<Node>();
    for (const [fromKey, es] of edges) {
      const from = insts.get(fromKey)!;
      if (from.f.layer !== "rt") continue;
      for (const e of es) if (!reported.has(e.site.node) && reaches(e.to, from)) {
        reported.add(e.site.node);
        this.prog.rep.at(e.site.mod, "E4005", e.site.node, `recursive call to '${e.to.f.name}' in rt code`);
      }
    }
    // Q227 (a): calls by name never depend on an instantiation, so a cycle of them is recursion even when
    // nothing calls the function (a function with function-typed parameters has no instantiation then).
    const direct = new Map<FnSym, FnSite[]>();
    for (const s of this.fnSites) if (typeof s.callee !== "number" && s.from?.layer === "rt") (direct.get(s.from) ?? direct.set(s.from, []).get(s.from)!).push(s);
    const reachesF = (from: FnSym, to: FnSym): boolean => {
      const seen = new Set<FnSym>(), todo = [from];
      for (let x = todo.pop(); x; x = todo.pop()) {
        if (x === to) return true;
        if (seen.has(x)) continue;
        seen.add(x);
        for (const s of direct.get(x) ?? []) todo.push(s.callee as FnSym);
      }
      return false;
    };
    for (const [from, ss] of direct) for (const s of ss) if (!reported.has(s.node) && reachesF(s.callee as FnSym, from)) {
      reported.add(s.node);
      this.prog.rep.at(s.mod, "E4005", s.node, `recursive call to '${(s.callee as FnSym).name}' in rt code`);
    }
  }


  /** Module-level const and static field initializers (Q054, Q072). */
  private moduleConst(t: Type, init: ts.Expression): void {
    if (mutable(t)) { this.at("E5002", init, "module-level const must have an immutable type"); return; }
    checkTo(this, init, t);
  }

  /** Checks a function-like body against `sig`. Returns the inferred return type for arrows without annotation. */
  fnBody(
    d: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.ArrowFunction | ts.FunctionExpression,
    sig: FnType,
    o: { layer?: Layer; unsafe?: boolean; thisType?: Type; cls?: ClassSym; inCtor?: boolean; inferRet?: boolean; params?: ts.NodeArray<ts.ParameterDeclaration> },
  ): Type {
    const outer = { fx: this.fx, scope: this.scope, narrow: this.narrow };
    const isAsync = hasMod(d, K.AsyncKeyword);
    let ret: Type | undefined = o.inferRet ? undefined : sig.ret;
    if (ret && isAsync) ret = ret.k === "gen" && ret.name === "Promise" ? ret.args[0] : ret.k === "error" ? ERROR : (this.at("E2002", d.type ?? d, "an async function must return Promise<T>"), ERROR);
    const nested = d.kind === K.ArrowFunction || d.kind === K.FunctionExpression;
    const tparams = new Map(outer.fx.tparams);
    for (const p of sig.tparams) tparams.set(p.name, p);
    this.fx = {
      mod: outer.fx.mod,
      layer: o.layer ?? (nested ? outer.fx.layer : "managed"),
      unsafe: o.unsafe ?? (nested ? outer.fx.unsafe : false),
      ret, returns: [], async: isAsync,
      inCtor: !!o.inCtor, tparams, depth: nested ? outer.fx.depth + 1 : 0,
      ...(o.thisType ? { thisType: o.thisType } : d.kind === K.ArrowFunction && outer.fx.thisType ? { thisType: outer.fx.thisType } : {}), // Q120
      ...(o.cls ? { cls: o.cls } : nested && outer.fx.cls ? { cls: outer.fx.cls } : {}),
      ...(o.params ? { params: o.params } : nested && outer.fx.params ? { params: outer.fx.params } : {}),
      ...(nested && outer.fx.contract ? { contract: outer.fx.contract } : {}),
      node: d,
    };
    this.scope = new Scope(nested ? outer.scope : undefined);
    this.narrow = nested ? new Map(outer.narrow) : new Map();
    d.parameters.forEach((p, i) => {
      if (isId(p.name)) { const t = sig.params[i] ?? ERROR; this.declare(p.name, unref(t), { param: true, mutable: true, declared: t }); }
    });
    let result: Type = VOID;
    const body = d.body!;
    if (body.kind !== K.Block) {
      // a void callback's expression body is evaluated for effect (Q074)
      const r = this.fx.ret;
      if (!r || isPromise(r)) promiseOk.add(body as ts.Expression); // Q130
      const t = r && !isVoidish(r) ? checkTo(this, body as ts.Expression, r) : r ? this.discard(body as ts.Expression) : expr(this, body as ts.Expression);
      if (!r) this.onlyPromise(body as ts.Expression, t);
      result = t;
    } else {
      const reach = this.block((body as ts.Block).statements, true);
      const r = this.fx.ret;
      const anchor = d.kind === K.ArrowFunction ? (d as ts.ArrowFunction).equalsGreaterThanToken : (d as { name?: Node }).name ?? d;
      if (r && reach && !isVoidish(r) && r.k !== "error") {
        this.at("E2002", anchor, "function can reach its end without returning a value");
      }
      if (!r) {
        const rs = this.fx.returns.filter((t) => !(t.k === "prim" && t.name === "never"));
        result = rs.length ? union(rs) : this.fx.returns.length ? NEVER : VOID;
        if (result.k === "union" && !legalUnion(result) && !rs.some((t) => t.k === "error")) { // Q126
          this.at("E2002", anchor, `the inferred return type '${show(result)}' is not an allowed union; annotate the return type`);
          result = ERROR;
        } else if (reach && !isVoidish(result) && result.k !== "error" && !rs.some((t) => t.k === "error")) { // Q221
          this.at("E2002", anchor, "function can reach its end without returning a value");
          result = ERROR;
        }
      }
    }
    this.fx = outer.fx; this.scope = outer.scope; this.narrow = outer.narrow;
    return isAsync && o.inferRet ? { k: "gen", name: "Promise", args: [result] } : result;
  }

  // ---- classes (§3.2, Q029)
  private classBody(v: ClassValueSym): void {
    const cls = v.cls;
    const thisType: Type = { k: "class", cls, args: cls.tparams.map((p) => ({ k: "tparam", p })) };
    const tparams = new Map(cls.tparams.map((p) => [p.name, p]));
    this.fx = { ...this.fx, tparams };
    for (const h of cls.decl.heritageClauses ?? []) h.types.forEach((t, i) => this.implementsCheck(cls, cls.implements[i] ?? ERROR, t));
    const ctor = cls.decl.members.find((m) => m.kind === K.Constructor) as ts.ConstructorDeclaration | undefined;
    // Q029: `this.f = ...` as a top-level constructor statement. Q121: up to the last of them, `this` is only such a target.
    const stmts = ctor?.body?.statements ?? [];
    const initOf = (s: ts.Statement): ts.PropertyAccessExpression | undefined => {
      if (s.kind !== K.ExpressionStatement) return undefined;
      const b = (s as ts.ExpressionStatement).expression;
      if (b.kind !== K.BinaryExpression || (b as ts.BinaryExpression).operatorToken.kind !== K.EqualsToken) return undefined;
      const l = assignTarget((b as ts.BinaryExpression).left);
      return l.kind === K.PropertyAccessExpression && (l as ts.PropertyAccessExpression).expression.kind === K.ThisKeyword ? l as ts.PropertyAccessExpression : undefined;
    };
    const inits = stmts.map(initOf);
    // the prefix ends where every field without an initializer has been assigned (or at the last assignment if some never is)
    const need = new Set([...cls.fields].filter(([, f]) => !f.static && !f.node.initializer).map(([n]) => n));
    let end = need.size ? inits.findIndex((x) => x && need.delete(x.name.text) && !need.size) : -1;
    if (need.size) end = inits.findLastIndex((x) => x !== undefined);
    const prefix = stmts.slice(0, end + 1);
    this.ctorInits = new Set(inits.slice(0, end + 1).filter((x) => x !== undefined));
    // Q121 addendum: fields with an initializer, then those assigned by earlier top-level `this.f = ...`, may be read
    const done = new Set([...cls.fields].filter(([, f]) => !f.static && f.node.initializer).map(([n]) => n));
    const isThisField = (n: Node): n is ts.PropertyAccessExpression => n.kind === K.PropertyAccessExpression && (n as ts.PropertyAccessExpression).expression.kind === K.ThisKeyword;
    const walk = (n: Node, inFn: boolean): void => {
      if (!inFn && isThisField(n) && done.has(n.name.text)) return;
      if (n.kind === K.ThisKeyword) { this.at("E2002", n, "'this' is used before every field is initialized"); return; }
      if (n.kind === K.ReturnStatement && !inFn) this.at("E2002", n, "'return' before every field is initialized");
      if (!inFn && n.kind === K.BinaryExpression && (n as ts.BinaryExpression).operatorToken.kind === K.EqualsToken && isThisField(assignTarget((n as ts.BinaryExpression).left))) {
        walk((n as ts.BinaryExpression).right, inFn); // a write; only a top-level one counts as assigned
        return;
      }
      const f = inFn || FN_KINDS.has(n.kind);
      n.forEachChild((ch) => walk(ch, f));
    };
    prefix.forEach((st, i) => {
      walk(inits[i] ? ((st as ts.ExpressionStatement).expression as ts.BinaryExpression).right : st, false);
      if (inits[i]) done.add(inits[i]!.name.text);
    });
    for (const m of cls.decl.members) {
      if (m.kind === K.PropertyDeclaration) {
        const p = m as ts.PropertyDeclaration;
        const f = cls.fields.get((p.name as ts.Identifier).text)!;
        if (!p.initializer) continue;
        this.fx = { ...this.fx, thisType, cls };
        if (f.static) this.moduleConst(f.type, p.initializer);
        else checkTo(this, p.initializer, f.type);
      } else if (m.kind === K.MethodDeclaration) {
        const md = m as ts.MethodDeclaration;
        const me = cls.methods.get((md.name as ts.Identifier).text)!;
        this.fnBody(md, me.sig, { layer: "managed", ...(me.static ? {} : { thisType }), cls, params: md.parameters });
      } else if (m.kind === K.Constructor) {
        this.fnBody(ctor!, cls.ctor, { layer: "managed", thisType, cls, inCtor: true, params: ctor!.parameters });
      }
    }
    this.ctorInits = new Set();
    // Q029: every instance field without an initializer is assigned by a top-level `this.f = ...` in the constructor
    const assigned = new Set(inits.flatMap((x) => (x ? [x.name.text] : [])));
    for (const [name, f] of cls.fields) {
      if (!f.static && !f.node.initializer && !assigned.has(name)) this.at("E2002", f.node.name, `field '${name}' is not initialized`);
    }
  }

  private implementsCheck(cls: ClassSym, it: Type, node: Node): void {
    if (it.k === "error") return;
    if (it.k !== "iface") { this.at("E2002", node, "a class can only implement an interface"); return; }
    const m = bindTParams(it.iface.tparams, it.args);
    for (const [name, sig] of it.iface.methods) {
      const own = cls.methods.get(name);
      const want = subst(sig, m) as FnType;
      if (!own || own.static || own.private || !sameSig(own.sig, want)) {
        this.at("E2002", node, `'${cls.name}' does not implement '${name}' of '${it.iface.name}' as declared`);
        return;
      }
    }
  }

  // ---- statements (§4). Each returns whether it can complete normally (Q023).
  block(list: readonly ts.Statement[], fnTop = false): boolean {
    const saved = this.scope;
    this.scope = new Scope(saved);
    let reach = true;
    let i = 0;
    if (fnTop) while (i < list.length && isStringStmt(list[i]!)) i++; // directives (Q039)
    for (; i < list.length; i++) if (!this.stmt(list[i]!)) reach = false;
    this.scope = saved;
    return reach;
  }

  stmt(s: ts.Statement): boolean {
    switch (s.kind) {
      case K.Block: return this.block((s as ts.Block).statements);
      case K.VariableStatement: this.varList((s as ts.VariableStatement).declarationList); return true;
      case K.ExpressionStatement: {
        const t = this.discard((s as ts.ExpressionStatement).expression);
        this.assignNarrow((s as ts.ExpressionStatement).expression);
        return !(t.k === "prim" && t.name === "never");
      }
      case K.IfStatement: {
        const x = s as ts.IfStatement;
        const m0 = this.mark();
        cond(this, x.expression);
        const yes = this.facts(x.expression, true), no = this.facts(x.expression, false);
        const saved = this.narrow, m1 = this.mark();
        this.narrow = new Map(saved); this.withFacts(yes, m0, m1);
        const a = this.stmt(x.thenStatement);
        const endA = this.narrow;
        this.narrow = new Map(saved); this.withFacts(no, m0, m1);
        const b = x.elseStatement ? this.stmt(x.elseStatement) : true;
        // Q122: only the branch that completes reaches here; if both do, an assignment in either ends the narrowing
        if (a && b) { const endB = this.narrow; this.narrow = new Map([...endA].filter(([k, t]) => { const u = endB.get(k); return !!u && same(t, u); })); } // Q131: what holds on both paths
        else if (a) this.narrow = endA;
        return a || b;
      }
      case K.WhileStatement: {
        const x = s as ts.WhileStatement;
        this.loopEntry(x.statement, x.expression);
        const m0 = this.mark();
        cond(this, x.expression);
        const m1 = this.mark();
        this.loopBody(x.statement, this.facts(x.expression, true), undefined, m0);
        if (isTrue(x.expression)) return hasBreak(x.statement);
        if (!hasBreak(x.statement)) this.withFacts(this.facts(x.expression, false), m0, m1); // Q122: a break exits without the condition
        return true;
      }
      case K.DoStatement: {
        const x = s as ts.DoStatement;
        this.loopEntry(x.statement, x.expression);
        const r = this.loopBody(x.statement, new Map());
        cond(this, x.expression);
        return (r && !isTrue(x.expression)) || hasBreak(x.statement);
      }
      case K.ForStatement: {
        const x = s as ts.ForStatement;
        const saved = this.scope;
        this.scope = new Scope(saved);
        if (x.initializer?.kind === K.VariableDeclarationList) this.varList(x.initializer as ts.VariableDeclarationList);
        else if (x.initializer) { this.discard(x.initializer as ts.Expression); this.assignNarrow(x.initializer as ts.Expression); }
        this.loopEntry(x.statement, x.incrementor, x.condition);
        const m0 = this.mark();
        if (x.condition) cond(this, x.condition);
        const outer = this.narrow, m1 = this.mark();
        this.loopBody(x.statement, x.condition ? this.facts(x.condition, true) : new Map(), () => { if (x.incrementor) this.discard(x.incrementor); }, m0);
        this.restore(outer, m1);
        this.scope = saved;
        return (!x.condition || isTrue(x.condition)) ? hasBreak(x.statement) : true;
      }
      case K.ForOfStatement: {
        const x = s as ts.ForOfStatement;
        const t = unref(expr(this, x.expression));
        let elem: Type = ERROR;
        if (t.k === "gen" && (t.name === "Array" || t.name === "ReadonlyArray" || t.name === "Set")) elem = t.args[0]!;
        else if (t.k === "iter") elem = t.elem;
        else if (t.k !== "error") this.at("E2002", x.expression, `cannot iterate over '${show(t)}'`);
        const saved = this.scope;
        this.scope = new Scope(saved);
        const d = (x.initializer as ts.VariableDeclarationList).declarations[0]!;
        if (d.type) { const at = this.typeOf(d.type); this.walkTypePos(d.type, "local", { unsafe: this.fx.unsafe, cdecl: false }); if (!assignable(elem, at)) this.at("E2002", d.name, "element type does not match the annotation"); elem = at; }
        if (isId(d.name)) this.declare(d.name, elem);
        this.loopEntry(x.statement);
        this.loopBody(x.statement, new Map());
        this.scope = saved;
        return true;
      }
      case K.SwitchStatement: return this.switchStmt(s as ts.SwitchStatement);
      case K.BreakStatement: case K.ContinueStatement: return false;
      case K.ReturnStatement: this.returnStmt(s as ts.ReturnStatement); return false;
    }
    throw new Error(`P2: unhandled statement kind ${s.kind}`); // P1 rejects every other kind
  }

  /** An expression whose value is dropped. Q125: a dropped Promise would lose its trap, so it is an error. */
  discard(e: ts.Expression): Type {
    const t = expr(this, e);
    // Q130 reports the Promise-typed sub-expression; a container (`c ? g() : null`) is reported here as a whole
    const assign = e.kind === K.BinaryExpression && isAssignOp((e as ts.BinaryExpression).operatorToken.kind);
    if (isPromise(t) && !assign && PROMISE_CONTAINERS.has(e.kind)) this.at("E2002", e, "a Promise must be awaited or returned");
    return t;
  }

  /**
   * Q131 / Q133: `x = e` written as a whole statement (or a `for` initializer) narrows a stable `T | null` local to T when e is not
   * nullable. An assignment inside an expression only ends narrowings (`lvalue`), so nothing conditional can leave one behind.
   */
  private assignNarrow(e: ts.Expression): void {
    if (e.kind !== K.BinaryExpression || (e as ts.BinaryExpression).operatorToken.kind !== K.EqualsToken) return;
    const b = e as ts.BinaryExpression;
    const l = assignTarget(b.left);
    const s = isId(l) ? this.scope.lookup(l.text) : undefined;
    const inner = s && !s.unstable ? nonNull(s.type) : undefined;
    const rt = exprTypes.get(b.right);
    if (inner && rt && !isErr(rt) && !isNull(rt) && !nonNull(rt)) this.narrow.set(`${s!.id}`, inner);
  }

  /** Drops narrowings of locals assigned inside a loop: they do not hold on later iterations (Q025). */
  private loopEntry(body: Node, ...extra: (Node | undefined)[]): void {
    const targets: ts.Expression[] = [];
    const walk = (n: Node): void => {
      if (n.kind === K.BinaryExpression && isAssignOp((n as ts.BinaryExpression).operatorToken.kind)) targets.push((n as ts.BinaryExpression).left);
      n.forEachChild(walk);
    };
    walk(body);
    for (const x of extra) if (x) walk(x);
    for (const t of targets) this.assigned(t);
  }
  private loopBody(body: ts.Statement, f: Map<string, Type>, after?: () => void, factsMark?: number): boolean {
    return this.branch(() => { const r = this.stmt(body); after?.(); return r; }, f, factsMark);
  }

  /** Q130: an inferred return type may be a Promise, not an array or union holding one. */
  private onlyPromise(e: ts.Expression, t: Type): void {
    if (hasPromise(t) && !(t.k === "gen" && t.name === "Promise")) this.at("E2002", e, "a Promise can only be awaited or returned");
  }

  private returnStmt(r: ts.ReturnStatement): void {
    const want = this.fx.ret;
    if (!r.expression) {
      if (want && !isVoidish(want) && want.k !== "error") this.at("E2002", r, "missing return value");
      if (!want) this.fx.returns.push(VOID);
      return;
    }
    if (!want || isPromise(want)) promiseOk.add(r.expression); // Q130
    if (!want) { const t = expr(this, r.expression); this.onlyPromise(r.expression, t); this.fx.returns.push(t); return; }
    if (isVoidish(want)) { expr(this, r.expression); this.at("E2002", r.expression, "a void function cannot return a value"); return; }
    checkTo(this, r.expression, unref(want)); // a `Ref` / `Mut` return type is P3's E3004 (§5.5)
  }

  private switchStmt(x: ts.SwitchStatement): boolean {
    const d = x.expression;
    const t = expr(this, d);
    const kw = x.getStart(this.mod.sf);
    // discriminant kinds (Q024): tagged-union `kind`, string-literal union, or other (default required)
    let tagged: { key: string; members: Type[] } | undefined;
    let labels: Type[] | undefined;
    if (d.kind === K.PropertyAccessExpression && (d as ts.PropertyAccessExpression).name.text === "kind") {
      const r = this.keyOf((d as ts.PropertyAccessExpression).expression);
      const rt = r && unref(r.type);
      if (r && rt && isTaggedUnion(rt)) { tagged = { key: r.key, members: rt.members }; labels = rt.members.map((m) => field(m, "kind")!.type); }
    }
    if (!labels && t.k === "union" && t.members.every((m) => m.k === "lit")) labels = t.members;
    const seen = new Set<string>();
    let hasDefault = false;
    let reachEnd = false;
    const clauses = x.caseBlock.clauses;
    let fall: string[] = [];
    const caseLits = new Set(clauses.flatMap((c) => (c.kind === K.CaseClause && (c as ts.CaseClause).expression.kind === K.StringLiteral ? [((c as ts.CaseClause).expression as ts.StringLiteral).text] : [])));
    const saved = this.narrow, m0 = this.mark();
    const savedScope = this.scope;
    this.scope = new Scope(savedScope); // the case block is one scope
    clauses.forEach((c, i) => {
      if (c.kind === K.DefaultClause) {
        hasDefault = true;
        for (const m of tagged?.members ?? []) if (!caseLits.has(kindOf(m)!)) fall.push(kindOf(m)!); // default: kinds no case names
      }
      else {
        const e = (c as ts.CaseClause).expression;
        const lt = expr(this, e, t.k === "error" ? undefined : t);
        const lit = e.kind === K.StringLiteral ? (e as ts.StringLiteral).text : isLitOnly(e) || e.kind === K.TrueKeyword || e.kind === K.FalseKeyword ? e.getText(this.mod.sf) : undefined;
        if (t.k !== "error" && lt.k !== "error") {
          if (lit === undefined || !assignable(lt, t)) this.at("E2002", e, "case label must be a literal of the discriminant type");
          else if (seen.has(lit)) this.at("E2002", e, "duplicate case label");
        }
        if (lit !== undefined) { seen.add(lit); fall.push(lit); }
      }
      this.restore(saved, m0); // Q122: a previous case may fall through after an assignment
      this.narrow = new Map(this.narrow);
      if (tagged && !this.killedSince(m0).has(tagged.key.split(".")[0]!)) {
        const ms = tagged.members.filter((m) => fall.includes(kindOf(m)!));
        if (ms.length) this.narrow.set(tagged.key, subUnion(ms));
      }
      const r = this.blockNoScope(c.statements);
      if (!r) fall = [];
      if (i === clauses.length - 1) reachEnd = r;
    });
    this.restore(saved, m0);
    this.scope = savedScope;
    const exhaustive = hasDefault || (!!labels && labels.every((l) => l.k === "lit" && seen.has(l.value)));
    if (!exhaustive && t.k !== "error") this.report("E2005", kw, kw + "switch".length, "switch is not exhaustive");
    return !exhaustive || reachEnd || clauses.length === 0 || hasBreak(x.caseBlock, true);
  }
  private blockNoScope(list: readonly ts.Statement[]): boolean {
    let reach = true;
    for (const s of list) if (!this.stmt(s)) reach = false;
    return reach;
  }

  varList(list: ts.VariableDeclarationList): void {
    const mutableDecl = !!(list.flags & NodeFlags.Let);
    for (const d of list.declarations) {
      const init = d.initializer!;
      let t: Type;
      if (d.type) {
        const declared = this.typeOf(d.type);
        this.walkTypePos(d.type, "local", { unsafe: this.fx.unsafe, cdecl: false });
        if (this.fx.layer !== "managed") this.layerType(declared, d.type, this.fx.layer);
        checkTo(this, init, unref(declared));
        t = unref(declared);
      } else if ((init.kind === K.ObjectLiteralExpression || (init.kind === K.ArrayLiteralExpression && !(init as ts.ArrayLiteralExpression).elements.length)) && isId(d.name)) {
        this.at("E2006", d.name, "cannot determine the type without an annotation");
        t = ERROR;
      } else if (init.kind === K.StringLiteral && !mutableDecl) {
        t = { k: "lit", value: (init as ts.StringLiteral).text }; // Q016
        if (this.fx.layer !== "managed") this.at("E4002", init, `strings cannot be used in ${this.fx.layer} code`); // Q042
      } else {
        t = expr(this, init);
        if (t.k === "lit" || (t.k === "union" && t.members.every((m) => m.k === "lit") && mutableDecl)) t = mutableDecl ? STR : t;
        if (t.k === "iter") { this.at("E2002", init, "keys() / values() can only be iterated"); t = ERROR; }
      }
      exprTypes.set(d.name, t); // the declared type, for the C backend (D102)
      if (isId(d.name)) {
        const sym = this.declare(d.name, t, { mutable: mutableDecl });
        if (!d.type && t.k === "num" && isLitOnly(init)) this.litLets.set(sym.id, d.name);
      } else this.destructure(d.name as ts.ObjectBindingPattern, t);
    }
  }

  private destructure(p: ts.ObjectBindingPattern, t0: Type): void {
    const t = unref(t0);
    for (const el of p.elements) {
      const prop = (el.propertyName ?? el.name) as ts.Identifier;
      let ft: Type = ERROR;
      if (t.k === "record") {
        const f = field(t, prop.text);
        if (f) ft = f.type; else this.at("E2002", prop, `no field '${prop.text}'`);
      } else if (t.k !== "error") this.at("E2002", prop, "only records can be destructured");
      exprTypes.set(el.name!, ft);
      this.declare(el.name as ts.Identifier, ft);
    }
  }

  /** Q073 (E5001 fix): the authority a global maps to, and a fix that adds it as a parameter of the enclosing function. */
  authorityFix(global: string): { authority: string; fixes?: { title: string; edits: { range: { start: { line: number; col: number }; end: { line: number; col: number } }; newText: string }[] }[] } | undefined {
    const authority = ({ console: "Log", Date: "Clock", performance: "Clock", random: "Random" } as Record<string, string>)[global];
    if (!authority) return undefined;
    const ps = this.fx.params;
    if (!ps) return { authority };
    const name = authority.toLowerCase();
    const pos = this.mod.pf.position(ps.end);
    return { authority, fixes: [{ title: `take '${name}: ${authority}' as a parameter`, edits: [{ range: { start: pos, end: pos }, newText: `${ps.length ? ", " : ""}${name}: ${authority}` }] }] };
  }

  /** The layer of a called value symbol (E4001); undefined for non-functions. */
  layerOf(sym: ValueSym): Layer | undefined { return sym.k === "fn" ? sym.layer : undefined; }
  /** E4001 (§2): strict calls strict / rt, rt calls rt only. */
  callAllowed(callee: Layer): boolean {
    const from = this.fx.layer;
    return from === "managed" || (from === "strict" && callee !== "managed") || (from === "rt" && callee === "rt");
  }
  /** §2 + §14.3: a direct call to `callee`. An rt + unsafe callee forms its own column of the table:
   * only an rt + unsafe caller reaches it directly; everyone else may only name it to `cfn`. */
  callCheck(callee: FnSym): boolean {
    if (callee.layer === "rt" && callee.unsafe) return this.fx.layer === "rt" && this.fx.unsafe;
    return this.callAllowed(callee.layer);
  }

  // ---- §14: Ptr / ConstPtr / CType / CHandle in written type positions
  /** Walks every written type position of a module once (signatures, aliases, fields, module consts,
   * and the `declare module "c:..."` blocks), reporting E4007 / E4008. Locals are walked in `varList`. */
  unsafeTypes(mod: Module): void {
    const saved = this.fx;
    this.fx = { mod, layer: "managed", ret: undefined, returns: [], async: false, inCtor: false, tparams: new Map(), depth: 0, unsafe: false };
    const sig = { unsafe: false, cdecl: false };
    for (const s of mod.sf.statements) {
      switch (s.kind) {
        case K.FunctionDeclaration: {
          const d = s as ts.FunctionDeclaration;
          const sym = mod.values.get(d.name!.text);
          if (sym?.k !== "fn") break;
          this.fx.tparams = new Map(sym.sig.tparams.map((p) => [p.name, p]));
          const ctx = { unsafe: sym.unsafe, cdecl: false };
          d.parameters.forEach((p) => { if (p.type) this.walkTypePos(p.type, "sig", ctx); });
          if (d.type) this.walkTypePos(d.type, "sig", ctx);
          break;
        }
        case K.ModuleDeclaration: {
          const d = s as ts.ModuleDeclaration;
          if (d.name.kind !== K.StringLiteral || d.body?.kind !== K.ModuleBlock) break;
          const table = mod.cdecls.get((d.name as ts.StringLiteral).text);
          this.fx.tparams = new Map();
          for (const st of (d.body as ts.ModuleBlock).statements) {
            if (st.kind !== K.FunctionDeclaration) continue;
            const f = st as ts.FunctionDeclaration;
            const cs = f.name ? table?.get(f.name.text) : undefined;
            if (cs) this.walkCDecl(f, cs.sig);
          }
          break;
        }
        case K.TypeAliasDeclaration: {
          const d = s as ts.TypeAliasDeclaration;
          const sym = mod.types.get(d.name.text);
          this.fx.tparams = sym?.k === "alias" && sym.tparams ? new Map(sym.tparams.map((p) => [p.name, p])) : new Map();
          this.walkTypePos(d.type, "alias", sig);
          break;
        }
        case K.ClassDeclaration: {
          const d = s as ts.ClassDeclaration;
          const sym = mod.values.get(d.name!.text);
          this.fx.tparams = sym?.k === "class" ? new Map(sym.cls.tparams.map((p) => [p.name, p])) : new Map();
          for (const m of d.members) {
            if (m.kind === K.PropertyDeclaration) { const p = m as ts.PropertyDeclaration; if (p.type) this.walkTypePos(p.type, "field", sig); }
            else if (m.kind === K.MethodDeclaration || m.kind === K.Constructor) {
              const md = m as ts.FunctionLikeDeclaration;
              md.parameters.forEach((p) => { if (p.type) this.walkTypePos(p.type, "sig", sig); });
              if (md.type) this.walkTypePos(md.type, "sig", sig);
            }
          }
          break;
        }
        case K.InterfaceDeclaration: {
          const d = s as ts.InterfaceDeclaration;
          const sym = mod.types.get(d.name.text);
          this.fx.tparams = sym?.k === "iface" ? new Map(sym.iface.tparams.map((p) => [p.name, p])) : new Map();
          for (const m of d.members) {
            const ms = m as ts.MethodSignatureDeclaration;
            ms.parameters.forEach((p) => { if (p.type) this.walkTypePos(p.type, "sig", sig); });
            if (ms.type) this.walkTypePos(ms.type, "sig", sig);
          }
          break;
        }
        case K.VariableStatement:
          this.fx.tparams = new Map();
          for (const d of (s as ts.VariableStatement).declarationList.declarations) if (d.type) this.walkTypePos(d.type, "local", sig);
          break;
      }
    }
    this.fx = saved;
  }

  /** §14.2: a C declaration takes `ffi: Ffi` first; the rest is numbers, boolean, void (return), Ptr, ConstPtr. */
  private walkCDecl(d: ts.FunctionDeclaration, sig: FnType): void {
    const ctx = { unsafe: true, cdecl: true };
    d.parameters.forEach((p) => { if (p.type) this.walkTypePos(p.type, "sig", ctx); });
    if (d.type) this.walkTypePos(d.type, "sig", ctx);
    const first = d.parameters[0];
    const ft = sig.params[0];
    if (!first || !(ft?.k === "opaque" && ft.name === "Ffi")) {
      if (first) this.at("E4007", first.name, "the first parameter of a C function must be 'ffi: Ffi'");
      else this.at("E4007", d.name!, "the first parameter of a C function must be 'ffi: Ffi'");
    }
    d.parameters.forEach((p, i) => { if (i > 0 && p.type) this.checkBoundary(p.type, sig.params[i] ?? ERROR, false); });
    if (d.type) this.checkBoundary(d.type, sig.ret, true);
  }
  private checkBoundary(node: ts.TypeNode, t: Type, isRet: boolean): void {
    if (t.k === "error" || t.k === "num" || isBool(t)) return;
    if (isRet && t.k === "prim" && t.name === "void") return;
    if (t.k === "gen" && (t.name === "Ptr" || t.name === "ConstPtr")) {
      const argNode = (node as ts.TypeReferenceNode).typeArguments?.[0];
      if (argNode) this.checkPointee(argNode, t.args[0]!);
      return;
    }
    this.at("E4007", node, `'${show(t)}' cannot cross the C boundary`);
  }
  /** A pointee maps to void* whatever it is (§14.2), except `usize` anywhere inside it and an
   * unmappable function type's own parameters / return. */
  private checkPointee(node: ts.TypeNode, t: Type): void {
    if (t.k === "num" && t.name === "usize") { this.at("E4007", node, "'usize' cannot sit behind a pointer at the C boundary"); return; }
    if (t.k === "gen" && (t.name === "Ptr" || t.name === "ConstPtr")) {
      const argNode = (node as ts.TypeReferenceNode).typeArguments?.[0];
      if (argNode) this.checkPointee(argNode, t.args[0]!);
      return;
    }
    if (t.k === "fn" && node.kind === K.FunctionType) {
      const f = node as ts.FunctionTypeNode;
      f.parameters.forEach((p, i) => { if (p.type) this.checkBoundary(p.type, t.params[i] ?? ERROR, false); });
      if (f.type) this.checkBoundary(f.type, t.ret, true);
    }
  }

  /** One written type node in position `place`. `ptrarg`: the argument of Ptr / ConstPtr; `chandlearg`: of CHandle. */
  walkTypePos(node: ts.TypeNode, place: "sig" | "local" | "alias" | "field" | "typearg" | "ptrarg" | "chandlearg", ctx: { unsafe: boolean; cdecl: boolean }): void {
    switch (node.kind) {
      case K.TypeReference: {
        const r = node as ts.TypeReferenceNode;
        const name = isId(r.typeName) ? r.typeName.text : "";
        const arg = r.typeArguments?.[0];
        if (name === "Ptr" || name === "ConstPtr") {
          // §14.4.1: writing Ptr / ConstPtr in a position where it may appear at all is an
          // unsafe operation, in whichever context it is written (a C declaration's types
          // belong to the `c:` specifier instead, so cdecl is excluded).
          if (!ctx.cdecl && place !== "field" && place !== "typearg" && place !== "alias" && place !== "chandlearg") this.noteUnsafeOp(r.typeName);
          if (place === "field" || place === "typearg" || place === "alias" || place === "chandlearg") {
            this.at("E4008", r.typeName, `'${name}' cannot be written in this position`);
          } else if (!ctx.cdecl && !ctx.unsafe) {
            this.at("E4008", r.typeName, `'${name}' can only be written in a function with 'use unsafe'`);
          }
          if (arg) {
            if (!ctx.cdecl) {
              const t = this.typeOf(arg, true); // a pointee may be void (§14.4)
              if (t.k === "fn") { if (name === "ConstPtr") this.at("E4007", arg, "a function type can only sit behind Ptr"); }
              else if (t.k !== "error" && !ptrTargetOk(t)) this.at("E4007", arg, `'${show(t)}' cannot sit behind ${name}`);
            }
            this.walkTypePos(arg, "ptrarg", ctx);
          }
          return;
        }
        if (name === "CType") {
          if (place !== "ptrarg" && place !== "chandlearg") this.at("E4007", r, "'CType' can only be a type argument of Ptr, ConstPtr or CHandle");
          const lit = arg?.kind === K.LiteralType ? (arg as ts.LiteralTypeNode).literal : undefined;
          const v = lit?.kind === K.StringLiteral ? (lit as ts.StringLiteral).text : undefined;
          if (arg && (v === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) || v === "bool" || C_RESERVED.has(v))) {
            this.at("E4007", arg, `'${v ?? "?"}' is not a usable C type name`);
          }
          return;
        }
        if (name === "CHandle") {
          if (arg) {
            const t = this.typeOf(arg, true);
            if (t.k === "fn" || hasPtr(t)) this.at("E4008", findPtrRef(arg) ?? arg, "'CHandle' cannot wrap a function type or a type holding Ptr / ConstPtr");
            else if (t.k !== "error" && !ptrTargetOk(t)) this.at("E4007", arg, `'${show(t)}' cannot sit inside CHandle`);
            this.walkTypePos(arg, "chandlearg", ctx);
          }
          return;
        }
        for (const a of r.typeArguments ?? []) this.walkTypePos(a, "typearg", ctx);
        return;
      }
      case K.TypeLiteral:
        for (const m of (node as ts.TypeLiteralNode).members) {
          const p = m as ts.PropertySignatureDeclaration;
          if (p.type) this.walkTypePos(p.type, "field", ctx);
        }
        return;
      case K.UnionType:
        for (const u of (node as ts.UnionTypeNode).types) this.walkTypePos(u, "typearg", ctx);
        return;
      case K.FunctionType: {
        const f = node as ts.FunctionTypeNode;
        for (const p of f.parameters) if (p.type) this.walkTypePos(p.type, place, ctx);
        if (f.type) this.walkTypePos(f.type, place, ctx);
        return;
      }
      case K.ParenthesizedType: this.walkTypePos((node as ts.ParenthesizedTypeNode).type, place, ctx); return;
      default: return;
    }
  }
}

/** C keywords (§14.2): a `CType` name must be a C identifier that is none of these (nor `bool`). */
const C_RESERVED = new Set([
  "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern",
  "float", "for", "goto", "if", "inline", "int", "long", "register", "restrict", "return", "short", "signed",
  "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned", "void", "volatile", "while",
  "_Alignas", "_Alignof", "_Atomic", "_Bool", "_Complex", "_Generic", "_Imaginary", "_Noreturn", "_Static_assert", "_Thread_local",
]);
/** The first Ptr / ConstPtr type name inside a type node (the E4008 anchor for a CHandle argument). */
function findPtrRef(n: Node): Node | undefined {
  if (n.kind === K.TypeReference) {
    const r = n as ts.TypeReferenceNode;
    if (isId(r.typeName) && (r.typeName.text === "Ptr" || r.typeName.text === "ConstPtr")) return r.typeName;
  }
  let out: Node | undefined;
  n.forEachChild((ch) => { out ??= findPtrRef(ch); });
  return out;
}

function isAssignOp(k: K): boolean {
  return k === K.EqualsToken || k === K.PlusEqualsToken || k === K.MinusEqualsToken || k === K.AsteriskEqualsToken || k === K.SlashEqualsToken || k === K.PercentEqualsToken || k === K.AsteriskAsteriskEqualsToken;
}
/** An authority anywhere in `t`, looking through function types too (E4006 for Q189 (b) parameter types). */
function hasAuthDeep(t: Type): boolean {
  switch (t.k) {
    case "opaque": return (AUTHORITIES as readonly string[]).includes(t.name);
    case "fn": return t.params.some(hasAuthDeep) || hasAuthDeep(t.ret);
    case "record": return t.fields.some((f) => hasAuthDeep(f.type));
    case "union": return t.members.some(hasAuthDeep);
    case "gen": case "class": case "iface": return t.args.some(hasAuthDeep);
    default: return false;
  }
}
const isStringStmt = (s: ts.Statement): boolean => s.kind === K.ExpressionStatement && (s as ts.ExpressionStatement).expression.kind === K.StringLiteral;
const isTrue = (e: ts.Expression): boolean => e.kind === K.TrueKeyword;
const isVoidish = (t: Type): boolean => t.k === "prim" && t.name === "void";
const isPromise = hasPromise;
/** Whether narrowing key `k` is `d` or a path below it, for some `d` in `dead`. */
const isDead = (k: string, dead: Set<string>): boolean => { for (let i = k.indexOf("."); i >= 0; i = k.indexOf(".", i + 1)) if (dead.has(k.slice(0, i))) return true; return dead.has(k); };

/** Whether a `break` inside `n` targets `n` (not a nested loop or switch). */
function hasBreak(n: Node, isSwitch = false): boolean {
  let found = false;
  const walk = (x: Node): void => {
    if (found) return;
    if (x.kind === K.BreakStatement) { found = true; return; }
    if (x !== n && (x.kind === K.WhileStatement || x.kind === K.DoStatement || x.kind === K.ForStatement || x.kind === K.ForOfStatement || x.kind === K.SwitchStatement ||
      x.kind === K.ArrowFunction || x.kind === K.FunctionExpression)) return;
    x.forEachChild(walk);
  };
  if (isSwitch) n.forEachChild(walk); else walk(n);
  return found;
}

/** Type parameters correspond by position (Q132); their constraints must match too. */
function sameSig(a: FnType, b0: FnType): boolean {
  if (a.tparams.length !== b0.tparams.length) return false;
  const m = new Map(b0.tparams.map((p, i) => [p.id, { k: "tparam", p: a.tparams[i]! } as Type]));
  const b = subst(b0, m) as FnType;
  const cons = a.tparams.every((p, i) => {
    const q = b0.tparams[i]!.constraint;
    return p.constraint && q ? same(p.constraint, subst(q, m)) : !p.constraint && !q;
  });
  return cons && a.params.length === b.params.length && a.params.every((p, i) => same(p, b.params[i]!)) && same(a.ret, b.ret);
}

/** Q054 / Q072: types a module-level const may not have. */
export function mutable(t: Type): boolean {
  switch (t.k) {
    case "record": return t.fields.some((f) => !f.readonly || mutable(f.type));
    case "union": return t.members.some(mutable);
    case "gen": return t.name !== "ReadonlyArray" || mutable(t.args[0]!);
    case "class": return true;
    default: return false;
  }
}

const FN_KINDS = new Set<K>([K.FunctionDeclaration, K.MethodDeclaration, K.Constructor, K.ArrowFunction, K.FunctionExpression]);
interface LexScope { parent?: LexScope; fn?: Node; vars: Map<string, { id: ts.Identifier; fn: Node }> }
/**
 * Q122: declaring identifier nodes of locals (parameters included) that a nested function refers to
 * and that some code assigns. Lexical-scope-aware across blocks, loops, and functions.
 */
export function capturedAssigned(root: Node): Set<Node> {
  const captured = new Set<Node>(), assigned = new Set<Node>();
  const bind = (n: ts.BindingName | undefined, sc: LexScope): void => {
    if (!n || !sc.fn) return;
    if (isId(n)) { sc.vars.set(n.text, { id: n, fn: sc.fn }); return; }
    if (n.kind === K.ObjectBindingPattern) for (const el of (n as ts.ObjectBindingPattern).elements) bind(el.name, sc);
  };
  const lookup = (name: string, sc: LexScope | undefined): { id: ts.Identifier; fn: Node } | undefined => {
    for (let s = sc; s; s = s.parent) { const v = s.vars.get(name); if (v) return v; }
    return undefined;
  };
  const child = (sc: LexScope | undefined): LexScope => ({ parent: sc, fn: sc?.fn, vars: new Map() });
  const walk = (n: Node | undefined, sc: LexScope | undefined): void => {
    if (!n) return;
    if (FN_KINDS.has(n.kind)) {
      const f = n as ts.FunctionLikeDeclaration, next: LexScope = { parent: sc, fn: n, vars: new Map() };
      for (const p of f.parameters) bind(p.name, next);
      walk(f.body, next);
      return;
    }
    switch (n.kind) {
      case K.Block: { const next = child(sc); n.forEachChild((ch) => walk(ch, next)); return; }
      case K.ForStatement: {
        const x = n as ts.ForStatement, next = child(sc);
        walk(x.initializer, next); walk(x.condition, next); walk(x.incrementor, next); walk(x.statement, next);
        return;
      }
      case K.ForOfStatement: {
        const x = n as ts.ForOfStatement, next = child(sc);
        walk(x.expression, sc); walk(x.initializer, next); walk(x.statement, next);
        return;
      }
      case K.SwitchStatement: {
        const x = n as ts.SwitchStatement;
        walk(x.expression, sc); walk(x.caseBlock, child(sc));
        return;
      }
      case K.VariableDeclaration: {
        const d = n as ts.VariableDeclaration;
        walk(d.initializer, sc);
        if (sc) bind(d.name, sc);
        return;
      }
      case K.PropertyAccessExpression: walk((n as ts.PropertyAccessExpression).expression, sc); return;
      case K.PropertyAssignment: walk((n as ts.PropertyAssignment).initializer, sc); return;
      case K.TypeReference: return;
      case K.BinaryExpression: {
        const b = n as ts.BinaryExpression;
        if (isAssignOp(b.operatorToken.kind)) {
          const l = assignTarget(b.left);
          if (isId(l)) { const bnd = lookup(l.text, sc); if (bnd) assigned.add(bnd.id); }
        }
        break;
      }
      case K.Identifier: {
        const bnd = lookup((n as ts.Identifier).text, sc);
        if (bnd && bnd.fn !== sc?.fn) captured.add(bnd.id);
        return;
      }
    }
    n.forEachChild((ch) => walk(ch, sc));
  };
  walk(root, undefined);
  return new Set([...captured].filter((id) => assigned.has(id)));
}
