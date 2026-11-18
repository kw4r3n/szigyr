// P2 checker (D012): declarations, statements, control flow, narrowing. Expressions live in expr.ts.
import { NodeFlags, SyntaxKind as K, type Node, type ts } from "./parse.ts";
import { Program, type ClassValueSym, type Layer, type LocalSym, type Module, type ValueSym } from "./modules.ts";
import { checkTo, cond, expr, isLitOnly } from "./expr.ts";
import {
  ERROR, NULL, STR, VOID, assignable, field, isTaggedUnion, kindOf, nonNull, same, show, subst, bindTParams, unref, union,
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
}

export class Scope {
  readonly vars = new Map<string, LocalSym>();
  readonly parent: Scope | undefined;
  constructor(parent?: Scope) { this.parent = parent; }
  lookup(name: string): LocalSym | undefined { return this.vars.get(name) ?? this.parent?.lookup(name); }
}

let localId = 0;
const isId = (n: Node | undefined): n is ts.Identifier => n?.kind === K.Identifier;
const hasMod = (n: Node, k: K): boolean => !!(n as Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers?.some((m) => m.kind === k);

export class Checker {
  scope = new Scope();
  narrow = new Map<string, Type>();
  fx!: FnCtx;

  readonly prog: Program;
  constructor(prog: Program) { this.prog = prog; }

  get mod(): Module { return this.fx.mod; }
  at(code: string, n: Node, message: string, data?: Record<string, unknown>): void { this.prog.rep.at(this.fx.mod, code, n, message, data); }
  report(code: string, start: number, end: number, message: string): void { this.prog.rep.report(this.fx.mod, code, start, end, message); }

  run(): void {
    for (const mod of this.prog.mods) this.module(mod);
  }

  // ---- symbols
  declare(name: ts.Identifier, type: Type, opts: { mutable?: boolean; param?: boolean; declared?: Type } = {}): LocalSym {
    const sym: LocalSym = { k: "local", id: ++localId, name: name.text, type, declared: opts.declared ?? type, mutable: !!opts.mutable, param: !!opts.param, fnDepth: this.fx.depth };
    this.scope.vars.set(name.text, sym);
    return sym;
  }
  value(name: string): ValueSym | undefined { return this.scope.lookup(name) ?? this.prog.lookupValue(this.fx.mod, name); }
  typeOf(t: ts.TypeNode): Type { return this.prog.typeOf(t, { mod: this.fx.mod, tparams: this.fx.tparams }); }

  // ---- narrowing (Q025): keys are `<local id>` or `this`, then `.field` for readonly fields
  keyOf(e: ts.Expression): { key: string; type: Type } | undefined {
    if (e.kind === K.ParenthesizedExpression) return this.keyOf((e as ts.ParenthesizedExpression).expression);
    if (isId(e)) {
      const s = this.scope.lookup(e.text);
      return s ? { key: `${s.id}`, type: this.narrow.get(`${s.id}`) ?? s.type } : undefined;
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
          out.set(r.key, union(t.members.filter((m) => (kindOf(m) === v) === eq)));
        }
      } else if (y.kind === K.StringLiteral) { // x === "a" on a string-literal union
        const r = this.keyOf(x);
        if (r && r.type.k === "union" && r.type.members.every((m) => m.k === "lit")) {
          const v = (y as ts.StringLiteral).text;
          const rest = r.type.members.filter((m) => (m.k === "lit" && m.value === v) === eq);
          if (rest.length) out.set(r.key, union(rest));
        }
      }
    }
    return out;
  }
  withFacts(f: Map<string, Type>): void { if (f.size) this.narrow = new Map([...this.narrow, ...f]); }
  /** An assignment to local `id` ends its narrowings (Q025). */
  forget(id: number): void {
    for (const k of [...this.narrow.keys()]) if (k === `${id}` || k.startsWith(`${id}.`)) this.narrow.delete(k);
  }

  // ---- modules
  private module(mod: Module): void {
    for (const s of mod.sf.statements) {
      this.fx = { mod, layer: "managed", ret: undefined, returns: [], async: false, inCtor: false, tparams: new Map(), depth: 0 };
      this.scope = new Scope();
      this.narrow = new Map();
      switch (s.kind) {
        case K.FunctionDeclaration: {
          const sym = mod.values.get((s as ts.FunctionDeclaration).name!.text);
          if (sym?.k === "fn") this.fnBody(s as ts.FunctionDeclaration, sym.sig, { layer: sym.layer, params: (s as ts.FunctionDeclaration).parameters });
          break;
        }
        case K.ClassDeclaration: this.classBody(mod.values.get((s as ts.ClassDeclaration).name!.text) as ClassValueSym); break;
        case K.VariableStatement:
          for (const d of (s as ts.VariableStatement).declarationList.declarations) {
            const sym = mod.values.get((d.name as ts.Identifier).text);
            if (sym?.k !== "const" || !d.type) continue;
            this.moduleConst(sym.type, d.initializer!);
          }
          break;
        case K.ExpressionStatement: expr(this, (s as ts.ExpressionStatement).expression); break; // test(...) (§9.2)
        case K.InterfaceDeclaration: this.ifaceMethods(s as ts.InterfaceDeclaration); break;
      }
    }
  }

  private ifaceMethods(_d: ts.InterfaceDeclaration): void { /* signatures were resolved in Program */ }

  /** Module-level const and static field initializers (Q054, Q072). */
  private moduleConst(t: Type, init: ts.Expression): void {
    if (mutable(t)) { this.at("E5002", init, "module-level const must have an immutable type"); return; }
    checkTo(this, init, t);
  }

  /** Checks a function-like body against `sig`. Returns the inferred return type for arrows without annotation. */
  fnBody(
    d: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.ArrowFunction | ts.FunctionExpression,
    sig: FnType,
    o: { layer?: Layer; thisType?: Type; cls?: ClassSym; inCtor?: boolean; inferRet?: boolean; params?: ts.NodeArray<ts.ParameterDeclaration> },
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
      ret, returns: [], async: isAsync,
      inCtor: !!o.inCtor, tparams, depth: nested ? outer.fx.depth + 1 : 0,
      ...(o.thisType ? { thisType: o.thisType } : nested && outer.fx.thisType ? { thisType: outer.fx.thisType } : {}),
      ...(o.cls ? { cls: o.cls } : nested && outer.fx.cls ? { cls: outer.fx.cls } : {}),
      ...(o.params ? { params: o.params } : nested && outer.fx.params ? { params: outer.fx.params } : {}),
      ...(nested && outer.fx.contract ? { contract: outer.fx.contract } : {}),
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
      const t = r && !isVoidish(r) ? checkTo(this, body as ts.Expression, r) : expr(this, body as ts.Expression);
      result = t;
    } else {
      const reach = this.block((body as ts.Block).statements, true);
      const r = this.fx.ret;
      if (r && reach && !isVoidish(r) && r.k !== "error") {
        const anchor = d.kind === K.ArrowFunction ? (d as ts.ArrowFunction).equalsGreaterThanToken : (d as { name?: Node }).name ?? d;
        this.at("E2002", anchor, "function can reach its end without returning a value");
      }
      if (!r) result = this.fx.returns.length ? union(this.fx.returns) : VOID;
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
    let ctor: ts.ConstructorDeclaration | undefined;
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
        ctor = m as ts.ConstructorDeclaration;
        this.fnBody(ctor, cls.ctor, { layer: "managed", thisType, cls, inCtor: true, params: ctor.parameters });
      }
    }
    // Q029: every instance field without an initializer is assigned by a top-level `this.f = ...` in the constructor
    const assigned = new Set<string>();
    for (const s of ctor?.body?.statements ?? []) {
      if (s.kind !== K.ExpressionStatement) continue;
      const b = (s as ts.ExpressionStatement).expression;
      if (b.kind !== K.BinaryExpression || (b as ts.BinaryExpression).operatorToken.kind !== K.EqualsToken) continue;
      const l = (b as ts.BinaryExpression).left;
      if (l.kind === K.PropertyAccessExpression && (l as ts.PropertyAccessExpression).expression.kind === K.ThisKeyword) assigned.add((l as ts.PropertyAccessExpression).name.text);
    }
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
        const t = expr(this, (s as ts.ExpressionStatement).expression);
        return !(t.k === "prim" && t.name === "never");
      }
      case K.IfStatement: {
        const x = s as ts.IfStatement;
        cond(this, x.expression);
        const yes = this.facts(x.expression, true), no = this.facts(x.expression, false);
        const saved = this.narrow;
        this.narrow = new Map(saved); this.withFacts(yes);
        const a = this.stmt(x.thenStatement);
        this.narrow = new Map(saved); this.withFacts(no);
        const b = x.elseStatement ? this.stmt(x.elseStatement) : true;
        this.narrow = saved;
        if (!a && b) this.withFacts(no);
        else if (a && !b) this.withFacts(yes);
        return a || b;
      }
      case K.WhileStatement: {
        const x = s as ts.WhileStatement;
        this.loopEntry(x.statement);
        cond(this, x.expression);
        this.loopBody(x.statement, this.facts(x.expression, true));
        if (isTrue(x.expression)) return hasBreak(x.statement);
        this.withFacts(this.facts(x.expression, false));
        return true;
      }
      case K.DoStatement: {
        const x = s as ts.DoStatement;
        this.loopEntry(x.statement);
        const r = this.loopBody(x.statement, new Map());
        cond(this, x.expression);
        return (r && !isTrue(x.expression)) || hasBreak(x.statement);
      }
      case K.ForStatement: {
        const x = s as ts.ForStatement;
        const saved = this.scope;
        this.scope = new Scope(saved);
        if (x.initializer?.kind === K.VariableDeclarationList) this.varList(x.initializer as ts.VariableDeclarationList);
        else if (x.initializer) expr(this, x.initializer as ts.Expression);
        this.loopEntry(x.statement, x.incrementor);
        if (x.condition) cond(this, x.condition);
        const outer = this.narrow;
        this.loopBody(x.statement, x.condition ? this.facts(x.condition, true) : new Map(), () => { if (x.incrementor) expr(this, x.incrementor); });
        this.narrow = outer;
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
        if (d.type) { const at = this.typeOf(d.type); if (!assignable(elem, at)) this.at("E2002", d.name, "element type does not match the annotation"); elem = at; }
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

  /** Drops narrowings of locals assigned inside a loop: they do not hold on later iterations (Q025). */
  private loopEntry(body: Node, extra?: Node): void {
    const names = new Set<string>();
    const walk = (n: Node): void => {
      if (n.kind === K.BinaryExpression && isAssignOp((n as ts.BinaryExpression).operatorToken.kind) && isId((n as ts.BinaryExpression).left)) names.add(((n as ts.BinaryExpression).left as ts.Identifier).text);
      n.forEachChild(walk);
    };
    walk(body);
    if (extra) walk(extra);
    for (const n of names) { const s = this.scope.lookup(n); if (s) this.forget(s.id); }
  }
  private loopBody(body: ts.Statement, f: Map<string, Type>, after?: () => void): boolean {
    const saved = this.narrow;
    this.narrow = new Map(saved); this.withFacts(f);
    const r = this.stmt(body);
    after?.();
    this.narrow = saved;
    return r;
  }

  private returnStmt(r: ts.ReturnStatement): void {
    const want = this.fx.ret;
    if (!r.expression) {
      if (want && !isVoidish(want) && want.k !== "error") this.at("E2002", r, "missing return value");
      if (!want) this.fx.returns.push(VOID);
      return;
    }
    if (!want) { this.fx.returns.push(expr(this, r.expression)); return; }
    if (isVoidish(want)) { expr(this, r.expression); this.at("E2002", r.expression, "a void function cannot return a value"); return; }
    checkTo(this, r.expression, want);
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
    const saved = this.narrow;
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
      this.narrow = new Map(saved);
      if (tagged) {
        const ms = tagged.members.filter((m) => fall.includes(kindOf(m)!));
        if (ms.length) this.narrow.set(tagged.key, union(ms));
      }
      const r = this.blockNoScope(c.statements);
      if (!r) fall = [];
      if (i === clauses.length - 1) reachEnd = r;
    });
    this.narrow = saved;
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
        checkTo(this, init, unref(declared));
        t = unref(declared);
      } else if ((init.kind === K.ObjectLiteralExpression || (init.kind === K.ArrayLiteralExpression && !(init as ts.ArrayLiteralExpression).elements.length)) && isId(d.name)) {
        this.at("E2006", d.name, "cannot determine the type without an annotation");
        t = ERROR;
      } else if (init.kind === K.StringLiteral && !mutableDecl) {
        t = { k: "lit", value: (init as ts.StringLiteral).text }; // Q016
      } else {
        t = expr(this, init);
        if (t.k === "lit" || (t.k === "union" && t.members.every((m) => m.k === "lit") && mutableDecl)) t = mutableDecl ? STR : t;
        if (t.k === "iter") { this.at("E2002", init, "keys() / values() can only be iterated"); t = ERROR; }
      }
      if (isId(d.name)) this.declare(d.name, t, { mutable: mutableDecl });
      else this.destructure(d.name as ts.ObjectBindingPattern, t);
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
}

function isAssignOp(k: K): boolean {
  return k === K.EqualsToken || k === K.PlusEqualsToken || k === K.MinusEqualsToken || k === K.AsteriskEqualsToken || k === K.SlashEqualsToken || k === K.PercentEqualsToken || k === K.AsteriskAsteriskEqualsToken;
}
const isStringStmt = (s: ts.Statement): boolean => s.kind === K.ExpressionStatement && (s as ts.ExpressionStatement).expression.kind === K.StringLiteral;
const isTrue = (e: ts.Expression): boolean => e.kind === K.TrueKeyword;
const isVoidish = (t: Type): boolean => t.k === "prim" && t.name === "void";

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

function sameSig(a: FnType, b: FnType): boolean {
  return a.params.length === b.params.length && a.params.every((p, i) => same(p, b.params[i]!)) && same(a.ret, b.ret);
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
