// P3 (D070): ownership and borrowing (§5), run only when P1 and P2 report nothing (Q003). Reads P2's types and symbols.
import { SyntaxKind as K, type Node, type ts } from "./parse.ts";
import type { LocalSym, Module, Program } from "./modules.ts";
import { assignTarget, callSigs, exprTypes, localOf } from "./expr.ts";
import { movesLike, show, unref, type Type } from "./types.ts";

/** Moved locals (by id) and the expression that moved each; null on a path that cannot be reached. */
type State = Map<number, Node> | null;
const join = (a: State, b: State): State => (!a ? b && new Map(b) : !b ? new Map(a) : new Map([...b, ...a]));
const copy = (s: State): State => s && new Map(s);

/** read: used only. move: §5.2 (initializers, right sides, by-value arguments, return, Struct fields, spread / destructuring sources). store: a managed container (E3007). */
type Ctx = "read" | "move" | "store";
type Mode = "ref" | "mut" | "move";
interface Use { sym: LocalSym; mode: Mode; node: Node }
interface Frame { loop: boolean; depth: number; breaks: State[]; continues: State[]; moves: { sym: LocalSym; node: Node }[] }

const isId = (n: Node | undefined): n is ts.Identifier => n?.kind === K.Identifier;
const strip = (e: ts.Expression): ts.Expression => {
  while (e.kind === K.ParenthesizedExpression) e = (e as ts.ParenthesizedExpression).expression;
  return e;
};
const genName = (t: Type | undefined): string | undefined => { const u = t && unref(t); return u?.k === "gen" ? u.name : undefined; };
const borrowMode = (t: Type | undefined): "ref" | "mut" | undefined => (t?.k === "gen" && t.name === "Ref" ? "ref" : t?.k === "gen" && t.name === "Mut" ? "mut" : undefined);
/** Vec / Slice methods that need `Mut` of the receiver (§3.3). */
const MUT_METHODS = new Set(["push", "pop", "clear", "fill"]);
const FN_EXPR = new Set<K>([K.ArrowFunction, K.FunctionExpression]);
/** A managed container (or a Promise) whose element is owned (Q174). */
const CONTAINERS = new Set(["Array", "ReadonlyArray", "Map", "Set", "Promise"]);
const ownedInside = (t: Type | undefined): boolean =>
  !!t && (t.k === "union" ? t.members.some(ownedInside) : t.k === "gen" && CONTAINERS.has(t.name) && t.args.some((a) => movesLike(a) || ownedInside(a)));
const isNever = (t: Type | undefined): boolean => t?.k === "prim" && t.name === "never";

export function checkOwnership(prog: Program): void {
  for (const mod of prog.mods) new ModuleCheck(prog, mod).run();
  const seen = new Set<string>();
  for (const { mod, node, p, arg } of prog.insts) { // Q068 (b): managed generics never take owned types (D090)
    const key = `${mod.file}:${node.pos}:${p.id}`;
    if (p.owner !== "managed" || !movesLike(arg) || seen.has(key)) continue;
    seen.add(key);
    prog.rep.at(mod, "E3007", node, `'${p.name}' of a managed generic cannot be instantiated with the owned type '${show(arg)}'`);
  }
}

class ModuleCheck {
  readonly prog: Program;
  readonly mod: Module;
  constructor(prog: Program, mod: Module) { this.prog = prog; this.mod = mod; }
  at(code: string, n: Node, message: string, data?: Record<string, unknown>): void { this.prog.rep.at(this.mod, code, n, message, data); }

  run(): void {
    this.typePositions(this.mod.sf);
    for (const s of this.mod.sf.statements) {
      if (s.kind === K.FunctionDeclaration) new Flow(this, 0).body(s as ts.FunctionDeclaration);
      else if (s.kind === K.ExpressionStatement) new Flow(this, 0).ex((s as ts.ExpressionStatement).expression, "read"); // test(...)
      else if (s.kind === K.ClassDeclaration) {
        for (const m of (s as ts.ClassDeclaration).members) {
          if (m.kind === K.MethodDeclaration || m.kind === K.Constructor) new Flow(this, 0).body(m as ts.FunctionLikeDeclaration);
          else if (m.kind === K.PropertyDeclaration && (m as ts.PropertyDeclaration).initializer) new Flow(this, 0).ex((m as ts.PropertyDeclaration).initializer!, "store");
        }
      }
    }
  }

  /** E3004 (§5.5 二級性 5): `Ref` / `Mut` written anywhere but as the whole type of a parameter. */
  private typePositions(n: Node): void {
    if (n.kind === K.TypeReference) {
      const r = n as ts.TypeReferenceNode;
      const p = r.parent as ts.ParameterDeclaration;
      const name = isId(r.typeName) ? r.typeName.text : undefined;
      if ((name === "Ref" || name === "Mut") && !(p.kind === K.Parameter && p.type === r)) {
        this.at("E3004", r, `'${name}' can only be the type of a parameter`);
      } else if (name === "Ref" || name === "Mut") {
        const f = p.parent as ts.FunctionLikeDeclaration;
        if (f.modifiers?.some((m) => m.kind === K.AsyncKeyword)) this.at("E3004", r, "an async function cannot take a borrow; it would outlive the call (Q171)");
      } else if (name === "Slice") {
        const q = r.parent as ts.TypeReferenceNode;
        const outer = q.kind === K.TypeReference && isId(q.typeName) ? q.typeName.text : undefined;
        if (outer !== "Ref" && outer !== "Mut") this.at("E3004", r, "'Slice' can only appear as 'Ref<Slice<T>>' or 'Mut<Slice<T>>' (§3.2, Q173)");
      }
    }
    n.forEachChild((c) => this.typePositions(c));
  }
}

/** One function body (or a module-level expression): the moved-state walk of §5.3. */
class Flow {
  state: State = new Map();
  readonly frames: Frame[] = [];
  /** Loop depth at each local's declaration; parameters and outer locals count as 0. */
  readonly declDepth = new Map<number, number>();
  /** Captured locals already reported in this function (E3004 / E3007 once per local). */
  readonly captured = new Set<number>();
  /**
   * Borrows in force while sibling operands are evaluated (§5.5, Q170): a call's receiver and borrowed arguments, and the
   * root of an element access (`ref`) or of an assignment target (`mut`, a `base`). A move of the variable meanwhile is
   * E3005 (E3001 for a base); an inner `Mut` borrow of it is E3005. Reads and inner `Ref` borrows stay allowed (Q065, Q067).
   */
  readonly active: { sym: LocalSym; mode: "ref" | "mut"; node: Node; base: boolean }[] = [];
  readonly e3005 = new Set<Node>();
  /** Where the current call's own entries start in `active`. */
  callMark = 0;
  readonly m: ModuleCheck;
  /** Function nesting depth, as P2 counts it in `LocalSym.fnDepth`. */
  readonly depth: number;
  constructor(m: ModuleCheck, depth: number) { this.m = m; this.depth = depth; }

  get loopDepth(): number { return this.frames.filter((f) => f.loop).length; }

  body(d: ts.FunctionLikeDeclaration): void {
    const b = d.body;
    if (!b) return;
    if (b.kind === K.Block) this.stmts((b as ts.Block).statements);
    else this.ex(b as ts.Expression, "move");
  }

  // ---- statements
  stmts(list: readonly ts.Statement[]): void { for (const s of list) this.stmt(s); }

  stmt(s: ts.Statement): void {
    switch (s.kind) {
      case K.Block: this.stmts((s as ts.Block).statements); return;
      case K.VariableStatement: this.vars((s as ts.VariableStatement).declarationList); return;
      case K.ExpressionStatement: this.ex((s as ts.ExpressionStatement).expression, "read"); return;
      case K.IfStatement: {
        const x = s as ts.IfStatement;
        this.ex(x.expression, "read");
        const s0 = copy(this.state);
        this.stmt(x.thenStatement);
        const a = this.state;
        this.state = s0;
        if (x.elseStatement) this.stmt(x.elseStatement);
        this.state = join(a, this.state);
        return;
      }
      case K.WhileStatement: {
        const x = s as ts.WhileStatement;
        this.loop(() => {
          this.ex(x.expression, "read");
          const out = isTrue(x.expression) ? null : copy(this.state);
          this.stmt(x.statement);
          return out;
        });
        return;
      }
      case K.DoStatement: {
        const x = s as ts.DoStatement;
        this.loop((f) => {
          this.stmt(x.statement);
          this.state = f.continues.reduce(join, this.state);
          f.continues = [];
          this.ex(x.expression, "read");
          return isTrue(x.expression) ? null : copy(this.state);
        }, x.expression.kind === K.FalseKeyword); // `do … while (false)` has no back edge
        return;
      }
      case K.ForStatement: {
        const x = s as ts.ForStatement;
        if (x.initializer?.kind === K.VariableDeclarationList) this.vars(x.initializer as ts.VariableDeclarationList);
        else if (x.initializer) this.ex(x.initializer as ts.Expression, "read");
        this.loop((f) => {
          if (x.condition) this.ex(x.condition, "read");
          const out = !x.condition || isTrue(x.condition) ? null : copy(this.state);
          this.stmt(x.statement);
          this.state = f.continues.reduce(join, this.state);
          f.continues = [];
          if (x.incrementor) this.ex(x.incrementor, "read");
          return out;
        });
        return;
      }
      case K.ForOfStatement: {
        const x = s as ts.ForOfStatement;
        this.ex(x.expression, "read");
        this.loop(() => {
          const out = copy(this.state);
          for (const d of (x.initializer as ts.VariableDeclarationList).declarations) this.declared(d.name);
          this.stmt(x.statement);
          return out;
        });
        return;
      }
      case K.SwitchStatement: {
        const x = s as ts.SwitchStatement;
        this.ex(x.expression, "read");
        const s0 = copy(this.state);
        const f = this.push(false);
        let fall: State = null;
        for (const c of x.caseBlock.clauses) {
          if (c.kind === K.CaseClause) this.ex((c as ts.CaseClause).expression, "read");
          this.state = join(s0, fall);
          this.stmts(c.statements);
          fall = this.state;
        }
        this.frames.pop();
        // P2 requires the switch to be exhaustive, so some clause always runs (Q024)
        this.state = f.breaks.reduce(join, x.caseBlock.clauses.length ? fall : s0);
        return;
      }
      case K.BreakStatement: this.target(false).breaks.push(this.state); this.state = null; return;
      case K.ContinueStatement: this.target(true).continues.push(this.state); this.state = null; return;
      case K.ReturnStatement: {
        const r = (s as ts.ReturnStatement).expression;
        if (r) this.ex(r, "move");
        this.state = null;
        return;
      }
    }
    // P1 and P2 reject every other statement kind
  }

  private push(loop: boolean): Frame {
    const f: Frame = { loop, depth: this.loopDepth + (loop ? 1 : 0), breaks: [], continues: [], moves: [] };
    this.frames.push(f);
    return f;
  }
  private target(loop: boolean): Frame {
    for (let i = this.frames.length - 1; i >= 0; i--) if (!loop || this.frames[i]!.loop) return this.frames[i]!;
    throw new Error("P3: break / continue outside a loop"); // P1 rejects it (Q124)
  }

  /**
   * One pass over a loop. `iter` runs the condition and the body, and returns the state that leaves through the condition.
   * The back edge (the body's end joined with its `continue`s) must not hold an outer local the loop moved (E3002, §5.3).
   */
  private loop(iter: (f: Frame) => State, once = false): void {
    const f = this.push(true);
    const out = iter(f);
    const back = f.continues.reduce(join, this.state);
    if (!once) for (const mv of f.moves) {
      if (back?.get(mv.sym.id) === mv.node) this.m.at("E3002", mv.node, `'${mv.sym.name}' is moved inside a loop`);
    }
    this.frames.pop();
    // later iterations leave with the back-edge state; a move it holds is reported above
    this.state = f.breaks.reduce(join, out ? join(out, back) : null);
  }

  private vars(list: ts.VariableDeclarationList): void {
    for (const d of list.declarations) {
      // destructuring moves the whole value (§5.3, Q052); taking only Copy fields out of a borrow just reads it
      const copyOut = !isId(d.name) && d.initializer && isId(strip(d.initializer)) && borrowMode(localOf.get(strip(d.initializer) as ts.Identifier)?.declared)
        && (d.name as ts.ObjectBindingPattern).elements.every((el) => isId(el.name) && !movesLike(localOf.get(el.name)?.type ?? { k: "error" }));
      if (d.initializer) this.ex(d.initializer, copyOut ? "read" : "move");
      this.declared(d.name);
    }
  }
  private declared(n: ts.BindingName): void {
    if (isId(n)) { const s = localOf.get(n); if (s) { this.declDepth.set(s.id, this.loopDepth); this.state?.delete(s.id); } return; }
    for (const el of (n as ts.ObjectBindingPattern).elements) this.declared(el.name as ts.BindingName);
  }

  // ---- expressions
  ex(e0: ts.Expression, ctx: Ctx): void {
    const e = strip(e0);
    if (ctx === "store" && !isId(e) && e.kind !== K.PropertyAccessExpression && movesLike(unref(exprTypes.get(e) ?? { k: "error" }))) {
      this.m.at("E3007", e, "an owned value cannot be put in a managed container"); // a temporary (B-8, Q048)
      ctx = "move";
    }
    switch (e.kind) {
      case K.Identifier: this.ident(e as ts.Identifier, ctx); return;
      case K.PropertyAccessExpression: {
        const p = e as ts.PropertyAccessExpression;
        this.ex(p.expression, "read");
        if (ctx !== "read" && movesLike(unref(exprTypes.get(p) ?? { k: "error" }))) this.m.at("E3003", p, `cannot move the field '${p.name.text}' out of its struct; destructure the whole value`);
        return;
      }
      case K.ElementAccessExpression: {
        const x = e as ts.ElementAccessExpression;
        this.ex(x.expression, "read");
        const mark = this.active.length;
        const r = this.rootOf(x.expression);
        if (r) this.active.push({ sym: r.sym, mode: "ref", node: r.id, base: true });
        this.ex(x.argumentExpression, "read");
        this.active.length = mark;
        return;
      }
      case K.CallExpression: case K.NewExpression: this.call(e as ts.CallExpression); return;
      case K.BinaryExpression: this.binary(e as ts.BinaryExpression, ctx); return;
      case K.ConditionalExpression: {
        const c = e as ts.ConditionalExpression;
        this.ex(c.condition, "read");
        const s0 = copy(this.state);
        this.ex(c.whenTrue, ctx);
        const a = this.state;
        this.state = s0;
        this.ex(c.whenFalse, ctx);
        this.state = join(a, this.state);
        return;
      }
      case K.PrefixUnaryExpression: this.ex((e as ts.PrefixUnaryExpression).operand, "read"); return;
      case K.AwaitExpression: this.ex((e as ts.AwaitExpression).expression, "read"); return;
      case K.TemplateExpression: for (const sp of (e as ts.TemplateExpression).templateSpans) this.ex(sp.expression, "read"); return;
      case K.ObjectLiteralExpression: {
        const t = exprTypes.get(e);
        const fieldCtx: Ctx = t?.k === "record" && t.struct ? "move" : "store"; // a Struct takes ownership; a managed record cannot (§5.6)
        for (const p of (e as ts.ObjectLiteralExpression).properties) {
          if (p.kind === K.PropertyAssignment) this.ex((p as ts.PropertyAssignment).initializer, fieldCtx);
          else if (p.kind === K.ShorthandPropertyAssignment) this.ident((p as ts.ShorthandPropertyAssignment).name as ts.Identifier, fieldCtx);
          else if (p.kind === K.SpreadAssignment) this.ex((p as ts.SpreadAssignment).expression, fieldCtx); // Q053
        }
        return;
      }
      case K.ArrayLiteralExpression:
        for (const x of (e as ts.ArrayLiteralExpression).elements) {
          if (x.kind === K.SpreadElement) this.ex((x as ts.SpreadElement).expression, "read");
          else this.ex(x, "store");
        }
        return;
      case K.ArrowFunction: case K.FunctionExpression: new Flow(this.m, this.depth + 1).body(e as ts.ArrowFunction); return; // captures: `ident`
    }
    // literals, `this`, `null`: nothing to track
  }

  private ident(id: ts.Identifier, ctx: Ctx): void {
    const sym = localOf.get(id);
    if (!sym) return; // functions, module constants, namespaces
    const borrow = borrowMode(sym.declared) !== undefined;
    if (sym.fnDepth < this.depth && !this.captured.has(sym.id)) { // captured by this nested function (§5.5, §5.6, Q012)
      if (borrow) { this.captured.add(sym.id); this.m.at("E3004", id, `the borrow '${sym.name}' cannot be captured by a closure`); return; }
      if (movesLike(sym.type)) { this.captured.add(sym.id); this.m.at("E3007", id, `the owned value '${sym.name}' cannot be captured by a closure`); return; }
    }
    this.useCheck(id, sym);
    if (ctx === "read") return;
    if (borrow) { this.m.at("E3004", id, `the borrow '${sym.name}' cannot be stored, returned or passed by value`); return; } // Q064
    if (!movesLike(sym.type)) return;
    if (ctx === "store") { this.m.at("E3007", id, `the owned value '${sym.name}' cannot be put in a managed container`); return; }
    this.moved(id, sym);
  }

  private exclusive(n: Node, sym: LocalSym): void {
    if (this.e3005.has(n)) return;
    this.e3005.add(n);
    this.m.at("E3005", n, `'${sym.name}' is used by another argument of this call`);
  }

  private useCheck(id: ts.Identifier, sym: LocalSym): void {
    const at = this.state?.get(sym.id);
    if (!at) return;
    const p = this.m.mod.pf.position(at.getStart(this.m.mod.sf));
    this.m.at("E3001", id, `use of moved value '${sym.name}'`, { variable: sym.name, movedAt: p });
  }

  private moved(id: ts.Identifier, sym: LocalSym): void {
    if (!this.state) return;
    const a = this.active.find((x) => x.sym.id === sym.id);
    if (a?.base) this.m.at("E3001", a.node, `'${sym.name}' is moved while this access to it is being evaluated`, { variable: sym.name, movedAt: this.m.mod.pf.position(id.getStart(this.m.mod.sf)) });
    else if (a) this.exclusive(id, sym);
    this.state.set(sym.id, id);
    const d = this.declDepth.get(sym.id) ?? 0;
    for (const f of this.frames) if (f.loop && f.depth > d) f.moves.push({ sym, node: id });
  }

  private binary(b: ts.BinaryExpression, ctx: Ctx): void {
    const k = b.operatorToken.kind;
    if (k === K.EqualsToken) {
      this.assign(b);
      const l = assignTarget(b.left);
      if (ctx !== "read" && (isId(l) || l.kind === K.PropertyAccessExpression)) this.ex(l, ctx); // the value of `x = v` is `x` (Q172)
      return;
    }
    if (k === K.AmpersandAmpersandToken || k === K.BarBarToken || k === K.QuestionQuestionToken) {
      const inner: Ctx = k === K.QuestionQuestionToken ? ctx : "read";
      this.ex(b.left, inner);
      const s0 = copy(this.state);
      this.ex(b.right, inner);
      this.state = join(s0, this.state);
      return;
    }
    if (k === K.PlusEqualsToken || k === K.MinusEqualsToken || k === K.AsteriskEqualsToken || k === K.SlashEqualsToken || k === K.PercentEqualsToken || k === K.AsteriskAsteriskEqualsToken) {
      const mark = this.active.length;
      this.lhs(assignTarget(b.left));
      this.ex(b.right, "read");
      this.active.length = mark;
      return;
    }
    this.ex(b.left, "read");
    this.ex(b.right, "read");
  }

  /** `x = v`: the right side moves into a local or a Struct field, or is stored into a managed field / element. */
  private assign(b: ts.BinaryExpression): void {
    const l = assignTarget(b.left);
    if (isId(l)) {
      const sym = localOf.get(l);
      this.ex(b.right, "move");
      if (!sym) return;
      if (borrowMode(sym.declared)) { this.m.at("E3004", l, `the borrow parameter '${sym.name}' cannot be reassigned`); return; } // Q151
      if (sym.fnDepth < this.depth) this.ident(l, "read"); // a captured local (E3004 / E3007)
      this.state?.delete(sym.id); // §5.2: a reassigned `let` is usable again
      return;
    }
    const mark = this.active.length;
    const base = this.lhs(l);
    const bt = base && unref(exprTypes.get(base) ?? { k: "error" });
    const struct = l.kind === K.PropertyAccessExpression && bt?.k === "record" && bt.struct;
    const vecElem = l.kind === K.ElementAccessExpression && (genName(bt) === "Vec" || genName(bt) === "Slice");
    this.ex(b.right, struct ? "move" : vecElem ? "read" : "store");
    this.active.length = mark;
  }

  /** An assignment target `a.f` / `a[i]`: its root is used; writing through `Ref` is E3006 (Q050). Returns the object written to. Leaves the root in `active`. */
  private lhs(l: ts.Expression): ts.Expression | undefined {
    if (isId(l)) { const sym = localOf.get(l); if (sym) this.useCheck(l, sym); return undefined; }
    const obj = l.kind === K.PropertyAccessExpression ? (l as ts.PropertyAccessExpression).expression : (l as ts.ElementAccessExpression).expression;
    const root = this.rootOf(obj);
    this.place(obj);
    if (root) this.active.push({ sym: root.sym, mode: "mut", node: root.id, base: true }); // popped by the caller
    if (l.kind === K.ElementAccessExpression) this.ex((l as ts.ElementAccessExpression).argumentExpression, "read");
    if (root && borrowMode(root.sym.declared) === "ref") this.m.at("E3006", l, `cannot write through the Ref '${root.sym.name}'`);
    return obj;
  }

  // ---- places (§5.5): a local, a borrowed parameter, a field path of one, or `v.slice(a, b)` of one
  private rootOf(e0: ts.Expression): { sym: LocalSym; id: ts.Identifier } | undefined {
    const e = strip(e0);
    if (isId(e)) { const sym = localOf.get(e); return sym && { sym, id: e }; }
    if (e.kind === K.PropertyAccessExpression && !(e as ts.PropertyAccessExpression).questionDotToken) return this.rootOf((e as ts.PropertyAccessExpression).expression);
    const slice = this.sliceCall(e);
    return slice && this.rootOf(slice.expression);
  }
  /** `X.slice(a, b)` on a Vec / Slice: its callee. */
  private sliceCall(e: ts.Expression): ts.PropertyAccessExpression | undefined {
    if (e.kind !== K.CallExpression) return undefined;
    const p = (e as ts.CallExpression).expression;
    if (p.kind !== K.PropertyAccessExpression || (p as ts.PropertyAccessExpression).name.text !== "slice") return undefined;
    const g = genName(exprTypes.get((p as ts.PropertyAccessExpression).expression));
    return g === "Vec" || g === "Slice" ? p as ts.PropertyAccessExpression : undefined;
  }
  /** Walks a place in evaluation order: the root is used, `slice` bounds are read. */
  private place(e0: ts.Expression): void {
    const e = strip(e0);
    if (isId(e)) { this.ident(e, "read"); return; }
    if (e.kind === K.PropertyAccessExpression) { this.place((e as ts.PropertyAccessExpression).expression); return; }
    const s = this.sliceCall(e);
    if (s) { this.place(s.expression); for (const a of (e as ts.CallExpression).arguments) this.ex(a, "read"); return; }
    this.ex(e, "read");
  }
  /**
   * A borrow of `e` with `mode`. Not a place: E3008, unless it is a receiver (a temporary receiver is fine).
   * `Mut` of something reached through a `Ref`: E3006 at the argument, or at the member name for a receiver (Q050).
   */
  private borrow(e: ts.Expression, mode: "ref" | "mut", member?: ts.Identifier): Use | undefined {
    const r = this.rootOf(e);
    if (!r) {
      if (!member) this.m.at("E3008", strip(e), "a borrowed argument must be a variable, a field path or 'v.slice(a, b)'");
      this.place(e); // a `slice` here is still in a borrowing position (Q013)
      return undefined;
    }
    const node = strip(e);
    // Q170: within one call either side `Mut` conflicts; an outer borrow conflicts only with an inner `Mut` (Q065, Q067)
    if (this.active.some((x, i) => x.sym.id === r.sym.id && (mode === "mut" || (i >= this.callMark && x.mode === "mut")))) this.exclusive(node, r.sym);
    this.active.push({ sym: r.sym, mode, node, base: false }); // popped by `call`; active while `slice` bounds are evaluated
    this.place(e);
    if (mode === "mut" && borrowMode(r.sym.declared) === "ref") this.m.at("E3006", member ?? strip(e), `'${r.sym.name}' is borrowed as Ref and cannot be passed as Mut`);
    return { sym: r.sym, mode, node };
  }

  // ---- calls
  private call(e: ts.CallExpression | ts.NewExpression): void {
    const callee = e.expression;
    const args = e.arguments ?? [];
    const sig = callSigs.get(e);
    const uses: Use[] = [];
    const mark = this.active.length;
    const outerMark = this.callMark;
    this.callMark = mark;
    let store = false;
    if (callee.kind === K.PropertyAccessExpression) {
      const p = callee as ts.PropertyAccessExpression;
      const g = genName(exprTypes.get(p.expression));
      if ((g === "Vec" || g === "Slice") && e.kind === K.CallExpression) {
        if (p.name.text === "slice") this.m.at("E3004", p.name, "'slice' can only be a borrowed argument or a receiver"); // Q013
        const u = this.borrow(p.expression, MUT_METHODS.has(p.name.text) ? "mut" : "ref", p.name as ts.Identifier);
        if (u) uses.push(u);
      } else {
        this.ex(p.expression, "read");
        store = g === "Array" || g === "ReadonlyArray" || g === "Map" || g === "Set";
      }
    } else if (isId(callee) && !localOf.has(callee) && !sig) {
      store = callee.text === "ok" || callee.text === "err"; // a Result is a managed record (§5.6)
    } else this.ex(callee, "read");
    args.forEach((a, i) => {
      const p = sig?.params[i];
      const mode = borrowMode(p);
      if (mode) { const u = this.borrow(a, mode); if (u) uses.push(u); return; }
      const x = strip(a);
      if (isId(x) && !store) {
        const sym = localOf.get(x);
        const before = sym && this.state?.get(sym.id);
        this.ex(a, "move");
        if (sym && !before && this.state?.get(sym.id) === x) uses.push({ sym, mode: "move", node: x });
        return;
      }
      this.ex(a, store ? "store" : "move");
    });
    // E3005 (§5.5): a variable passed as Mut takes part in no other argument; moving it while borrowed is rejected too (Q152)
    uses.forEach((u, j) => {
      const v = uses.slice(0, j).find((w) => w.sym.id === u.sym.id && (w.mode !== "ref" || u.mode !== "ref"));
      if (v) this.exclusive(u.node, u.sym);
    });
    this.active.length = mark;
    this.callMark = outerMark;
    // a new container, or one derived from a container that already holds owned values (and so is empty), is fine
    const recv = callee.kind === K.PropertyAccessExpression ? exprTypes.get((callee as ts.PropertyAccessExpression).expression) : undefined;
    if (e.kind === K.CallExpression && ownedInside(exprTypes.get(e)) && !ownedInside(recv)) this.m.at("E3007", isId(callee) ? callee : callee.kind === K.PropertyAccessExpression ? (callee as ts.PropertyAccessExpression).name : callee, "this call makes a managed container that holds an owned value (Q174)");
    if (isNever(exprTypes.get(e))) this.state = null;
  }
}

const isTrue = (e: ts.Expression): boolean => e.kind === K.TrueKeyword;
