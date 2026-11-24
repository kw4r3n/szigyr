// P3 (D070): ownership and borrowing (§5), run only when P1 and P2 report nothing (Q003). Reads P2's types and symbols.
import { NodeFlags, SyntaxKind as K, hasMod, isId, isParamProp, type Node, type ts } from "./parse.ts";
import type { LocalSym, Module, Program } from "./modules.ts";
import { assignTarget, callSigs, ensuresArgs, exprTypes, localOf } from "./expr.ts";
import { genFx } from "./builtins.ts";
import { isResultBranch, kindOf, movesLike, ownedDeep, show, tparamHasCap, unref, type Type } from "./types.ts";

/** Moved locals (by id) and the expression that moved each; null on a path that cannot be reached. */
type State = Map<number, Node> | null;
const join = (a: State, b: State): State => (!a ? b && new Map(b) : !b ? new Map(a) : new Map([...b, ...a]));
const copy = (s: State): State => s && new Map(s);

/** read: used only. move: §5.2 (initializers, right sides, by-value arguments, return, Struct fields, spread / destructuring sources). store: a managed container (E3007). */
type Ctx = "read" | "move" | "store";
type Mode = "ref" | "mut" | "move";
type ActiveBorrow = { sym: LocalSym; mode: "ref" | "mut"; node: Node; base: boolean; path: string[]; slice: boolean; ptrSlice?: boolean };
interface Use { sym: LocalSym; mode: Mode; node: Node; path: string[]; slice: boolean; arg: number; sliceName?: Node; ptrSlice?: boolean }
/** A place (§5.5): its root local, the field path from the root, and whether it is a `v.slice(a, b)` of that path (Q190). */
interface Place { sym: LocalSym; id: ts.Identifier; path: string[]; slice: boolean; sliceName?: ts.Identifier; ptrSlice?: boolean }
/** Two field paths denote overlapping places when one is a prefix of the other (Q190 (a)). */
const pathsOverlap = (a: string[], b: string[]): boolean => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
/** A pair of uses of one root in one call conflicts (E3005) when their places overlap (Q190 (a)) and they are not both `slice` arguments — that pair is decided by the runtime overlap check instead (Q190 (b), T013). */
const placesConflict = (a: Use, b: Use): boolean => !(a.slice && b.slice && !a.ptrSlice && !b.ptrSlice) && pathsOverlap(a.path, b.path); // §14.4: no runtime check for Ptr slices

/** One slice argument of a runtime-checked group (Q190 (b)): its index, its mode, and its `slice` member name (the T013 anchor). */
export interface SliceGroupEntry { arg: number; mut: boolean; name: Node }
/**
 * Calls whose same-root `slice` arguments are checked for overlap at runtime instead of E3005 (Q190 (b)):
 * per call, the groups (one per root) with at least two slice arguments and at least one `Mut` pair.
 * Read by the JS and C emitters and by the rt trap-site listing (traps.ts).
 */
export const sliceGroups = new WeakMap<Node, SliceGroupEntry[][]>();
interface Frame { loop: boolean; label?: string; depth: number; breaks: State[]; continues: State[]; moves: { sym: LocalSym; node: Node }[] }

const strip = (e: ts.Expression): ts.Expression => {
  while (e.kind === K.ParenthesizedExpression) e = (e as ts.ParenthesizedExpression).expression;
  return e;
};
const genName = (t: Type | undefined): string | undefined => { const u = t && unref(t); return u?.k === "gen" ? u.name : undefined; };
const borrowMode = (t: Type | undefined): "ref" | "mut" | undefined => (t?.k === "gen" && t.name === "Ref" ? "ref" : t?.k === "gen" && t.name === "Mut" ? "mut" : undefined);
const isNever = (t: Type | undefined): boolean => t?.k === "prim" && t.name === "never";

export function checkOwnership(prog: Program): void {
  for (const mod of prog.mods) new ModuleCheck(prog, mod).run();
  const seen = new Set<string>();
  for (const { mod, node, p, arg } of prog.insts) { // Q068 (b): managed generics never take owned types (D090)
    const key = `${mod.file}:${node.pos}:${p.id}`;
    if (p.owner !== "managed" || (p.allowOwned && (tparamHasCap(p, "Owned") || tparamHasCap(p, "Native"))) || !movesLike(arg) || seen.has(key)) continue;
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
      if ((name === "Ref" || name === "Mut") && (!(p.kind === K.Parameter && p.type === r) || isParamProp(p))) {
        this.at("E3004", r, `'${name}' can only be the type of a parameter`, { kind: "borrow-position", type: name });
      } else if (name === "Ref" || name === "Mut") {
        if (p.initializer) this.at("E3004", r, `a '${name}' borrow parameter cannot have a default value`, { kind: "borrow-default", type: name });
        const f = p.parent as ts.FunctionLikeDeclaration;
        if (f.modifiers?.some((m) => m.kind === K.AsyncKeyword)) this.at("E3004", r, "an async function cannot take a borrow; it would outlive the call", { kind: "async-borrow", type: name });
      } else if (name === "Slice") {
        const q = r.parent as ts.TypeReferenceNode;
        const outer = q.kind === K.TypeReference && isId(q.typeName) ? q.typeName.text : undefined;
        if (outer !== "Ref" && outer !== "Mut" && outer !== "Ptr" && outer !== "ConstPtr" && outer !== "Resource") this.at("E3004", r, "'Slice' can only appear as 'Ref<Slice<T>>' or 'Mut<Slice<T>>'", { kind: "slice-position" });
      } else if (name === "Resource") {
        const vd = r.parent as ts.VariableDeclaration;
        const vdl = vd?.parent as ts.VariableDeclarationList;
        const ok = vd?.kind === K.VariableDeclaration && vd.type === r && vdl?.kind === K.VariableDeclarationList &&
          (vdl.flags & NodeFlags.Using) && (vdl.flags & NodeFlags.AwaitUsing) !== NodeFlags.AwaitUsing;
        if (!ok) this.at("E3004", r, "'Resource' can only be the type of a 'using' declaration", { kind: "resource-position" });
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
  readonly active: ActiveBorrow[];
  /** Roots `unbox`ed by an earlier argument of the call being walked (§14.4): a later borrow of one is E3005. */
  readonly pendingMut: { sym: LocalSym; node: Node }[];
  readonly e3005 = new Set<Node>();
  /** Where the current call's own entries start in `active`. */
  callMark = 0;
  /** §15.2 / §5.6: expressions sitting in an `await` operand (through parentheses and conditionals,
   * as in P2's allowAwaited): a `Port.recv` call there is the one place its Promise may sit. */
  private readonly awaited = new WeakSet<Node>();
  private markAwaited(e: Node): void {
    this.awaited.add(e);
    if (e.kind === K.ParenthesizedExpression) this.markAwaited((e as ts.ParenthesizedExpression).expression);
    else if (e.kind === K.ConditionalExpression) { const cd = e as ts.ConditionalExpression; this.markAwaited(cd.whenTrue); this.markAwaited(cd.whenFalse); }
  }
  readonly m: ModuleCheck;
  /** Function nesting depth, as P2 counts it in `LocalSym.fnDepth`. */
  readonly depth: number;
  readonly ensuresFn: boolean;
  /** Lowest `fnDepth` from which borrows may still be read inside a synchronous non-escaping `OwnedCell` callback. */
  readonly syncBorrowMinDepth: number;
  constructor(
    m: ModuleCheck,
    depth: number,
    ensuresFn = false,
    syncBorrowMinDepth = depth,
    active: ActiveBorrow[] = [],
    pendingMut: { sym: LocalSym; node: Node }[] = [],
  ) {
    this.m = m;
    this.depth = depth;
    this.ensuresFn = ensuresFn;
    this.syncBorrowMinDepth = syncBorrowMinDepth;
    this.active = active;
    this.pendingMut = pendingMut;
  }

  get loopDepth(): number { return this.frames.filter((f) => f.loop).length; }

  body(d: ts.FunctionLikeDeclaration): void {
    for (const p of d.parameters) {
      if (p.initializer) {
        const s0 = copy(this.state);
        this.ex(p.initializer, "move");
        this.state = join(s0, this.state);
      }
    }
    if (d.modifiers?.some((m) => m.kind === K.AsyncKeyword)) {
      for (const p of d.parameters) {
        if (!p.type && isId(p.name)) {
          const sym = localOf.get(p.name);
          const bm = sym && borrowMode(sym.declared);
          if (bm) this.m.at("E3004", p.name, "an async function cannot take a borrow; it would outlive the call", { kind: "async-borrow", type: bm === "ref" ? "Ref" : "Mut" });
        }
      }
    }
    if (d.kind === K.Constructor) {
      for (const p of d.parameters) {
        if (!isParamProp(p) || !isId(p.name)) continue;
        const sym = localOf.get(p.name);
        if (sym && !borrowMode(sym.declared) && movesLike(sym.type)) {
          this.m.at("E3007", p.name, `the owned value '${sym.name}' cannot be put in a managed container`, { variable: sym.name, kind: "managed-container" });
        }
      }
    }
    for (const p of d.parameters) {
      if (p.name.kind === K.ObjectBindingPattern) {
        const pt = exprTypes.get(p.name);
        const bm = borrowMode(pt);
        if (bm) {
          for (const el of (p.name as ts.ObjectBindingPattern).elements) {
            if (!isId(el.name)) continue;
            const sym = localOf.get(el.name);
            if (sym && movesLike(sym.type)) {
              this.m.at("E3004", el.name, `cannot move owned field '${sym.name}' out of a ${bm === "ref" ? "Ref" : "Mut"} borrow`, { variable: sym.name, kind: "move-out-of-borrow" });
            }
          }
        } else if (pt) {
          this.checkPartialDestructure(p.name as ts.ObjectBindingPattern, unref(pt));
        }
        this.declared(p.name);
      } else if (p.name.kind === K.ArrayBindingPattern) {
        this.declared(p.name);
      }
    }
    const b = d.body;
    if (!b) return;
    if (b.kind === K.Block) this.stmts((b as ts.Block).statements);
    else this.ex(b as ts.Expression, "move");
  }

  private checkPartialDestructure(p: ts.ObjectBindingPattern, srcType: Type): void {
    if (srcType.k !== "record") return;
    const bound = new Set<string>();
    for (const el of p.elements) {
      if (!isId(el.name)) continue;
      const prop = el.propertyName && isId(el.propertyName) ? el.propertyName : el.name;
      bound.add(prop.text);
    }
    const omitted = srcType.fields.filter((f) => !bound.has(f.name) && movesLike(f.type));
    if (omitted.length > 0) {
      const names = omitted.map((f) => f.name);
      const allOwned = srcType.fields.filter((f) => movesLike(f.type)).map((f) => f.name);
      this.m.at(
        "E3003",
        p,
        `cannot partially destructure owned struct; bind remaining owned field(s): ${names.map((n) => `'${n}'`).join(", ")} (e.g. 'const { ${allOwned.join(", ")} } = ...')`,
        { field: names[0]!, fields: names },
      );
    }
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
      case K.LabeledStatement: this.stmt((s as ts.LabeledStatement).statement); return;
      case K.WhileStatement: {
        const x = s as ts.WhileStatement;
        this.loop(() => {
          this.ex(x.expression, "read");
          const out = isTrue(x.expression) ? null : copy(this.state);
          this.stmt(x.statement);
          return out;
        }, false, loopLabelOf(x));
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
        }, x.expression.kind === K.FalseKeyword, loopLabelOf(x)); // `do … while (false)` has no back edge
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
        }, false, loopLabelOf(x));
        return;
      }
      case K.ForOfStatement: {
        const x = s as ts.ForOfStatement;
        this.ex(x.expression, "read");
        this.loop(() => {
          const out = copy(this.state);
          if (x.initializer.kind === K.VariableDeclarationList) {
            for (const d of (x.initializer as ts.VariableDeclarationList).declarations) this.declared(d.name);
          }
          this.stmt(x.statement);
          return out;
        }, false, loopLabelOf(x));
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
      case K.FunctionDeclaration: {
        const fd = s as ts.FunctionDeclaration;
        if (fd.name) this.declared(fd.name);
        new Flow(this.m, this.depth + 1).body(fd);
        return;
      }
      case K.BreakStatement: this.target(false, (s as ts.BreakStatement).label?.text)?.breaks.push(this.state); this.state = null; return;
      case K.ContinueStatement: this.target(true, (s as ts.ContinueStatement).label?.text)?.continues.push(this.state); this.state = null; return;
      case K.ReturnStatement: {
        const r = (s as ts.ReturnStatement).expression;
        if (r) this.ex(r, "move");
        this.state = null;
        return;
      }
    }
    // P1 and P2 reject every other statement kind
  }

  private push(loop: boolean, label?: string): Frame {
    const f: Frame = { loop, label, depth: this.loopDepth + (loop ? 1 : 0), breaks: [], continues: [], moves: [] };
    this.frames.push(f);
    return f;
  }
  private target(loop: boolean, label?: string): Frame | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (label ? f.label === label : !loop || f.loop) return f;
    }
    return undefined;
  }

  /**
   * One pass over a loop. `iter` runs the condition and the body, and returns the state that leaves through the condition.
   * The back edge (the body's end joined with its `continue`s) must not hold an outer local the loop moved (E3002, §5.3).
   */
  private loop(iter: (f: Frame) => State, once = false, label?: string): void {
    const f = this.push(true, label);
    const out = iter(f);
    const back = f.continues.reduce(join, this.state);
    if (!once) for (const mv of f.moves) {
      if (back?.get(mv.sym.id) === mv.node) this.m.at("E3002", mv.node, `'${mv.sym.name}' is moved inside a loop`, { variable: mv.sym.name });
    }
    this.frames.pop();
    // later iterations leave with the back-edge state; a move it holds is reported above
    this.state = f.breaks.reduce(join, out ? join(out, back) : null);
  }

  private vars(list: ts.VariableDeclarationList): void {
    for (const d of list.declarations) {
      // destructuring moves the whole value (§5.3, Q052); taking only Copy fields out of a borrow just reads it
      const isBorrowInit = d.name.kind === K.ObjectBindingPattern && !!d.initializer && isId(strip(d.initializer))
        && !!borrowMode(localOf.get(strip(d.initializer) as ts.Identifier)?.declared);
      const copyOut = isBorrowInit
        && (d.name as ts.ObjectBindingPattern).elements.every((el) => isId(el.name) && !movesLike(localOf.get(el.name)?.type ?? { k: "error" }));
      if (d.name.kind === K.ObjectBindingPattern && !!d.initializer && !isBorrowInit) {
        const p = d.name as ts.ObjectBindingPattern;
        const srcType = unref(exprTypes.get(p) ?? exprTypes.get(strip(d.initializer)) ?? { k: "error" });
        this.checkPartialDestructure(p, srcType);
      }
      if (d.initializer) this.ex(d.initializer, copyOut ? "read" : "move");
      this.declared(d.name);
    }
  }
  private declared(n: ts.BindingName): void {
    if (isId(n)) { const s = localOf.get(n); if (s) { this.declDepth.set(s.id, this.loopDepth); this.state?.delete(s.id); } return; }
    if (n.kind === K.ObjectBindingPattern || n.kind === K.ArrayBindingPattern) {
      for (const el of (n as ts.ObjectBindingPattern | ts.ArrayBindingPattern).elements) {
        if (el.name) this.declared(el.name as ts.BindingName);
      }
    }
  }

  // ---- expressions
  ex(e0: ts.Expression, ctx: Ctx): void {
    const e = strip(e0);
    if (ctx === "store" && !isId(e) && e.kind !== K.PropertyAccessExpression && movesLike(unref(exprTypes.get(e) ?? { k: "error" }))) {
      this.m.at("E3007", e, "an owned value cannot be put in a managed container", { kind: "managed-container" }); // a temporary (B-8, Q048)
      ctx = "move";
    }
    switch (e.kind) {
      case K.Identifier: this.ident(e as ts.Identifier, ctx); return;
      case K.PropertyAccessExpression: {
        const p = e as ts.PropertyAccessExpression;
        const bt = unref(exprTypes.get(p.expression) ?? { k: "error" });
        const pt = unref(exprTypes.get(p) ?? { k: "error" });
        const resultExtract = ctx !== "read" && isResultBranch(bt) && movesLike(pt) &&
          ((kindOf(bt) === "ok" && p.name.text === "value") || (kindOf(bt) === "err" && p.name.text === "error"));
        if (resultExtract) {
          if (this.resBorrowCall(strip(p.expression))) {
            this.m.at("E3004", p.expression, "cannot move out of a borrowed Resource", { kind: "borrow-escape" });
            this.place(p.expression);
          } else {
            this.ex(p.expression, ctx);
          }
          return;
        }
        if (this.resBorrowCall(strip(p.expression))) this.place(p.expression);
        else this.ex(p.expression, "read");
        if (ctx !== "read" && movesLike(pt)) {
          const ownedFields = bt.k === "record" ? bt.fields.filter((f) => movesLike(f.type)).map((f) => f.name) : [];
          const srcNode = strip(p.expression);
          const srcName = isId(srcNode) ? srcNode.text : "...";
          const hint = ownedFields.length
            ? `destructure every owned field (e.g. 'const { ${ownedFields.join(", ")} } = ${srcName}')`
            : "destructure the whole value";
          this.m.at("E3003", p, `cannot move the field '${p.name.text}' out of its struct; ${hint}`, { field: p.name.text });
        }
        return;
      }
      case K.ElementAccessExpression: {
        const x = e as ts.ElementAccessExpression;
        if (this.resBorrowCall(strip(x.expression))) this.place(x.expression);
        else this.ex(x.expression, "read");
        const opt = !!(x.flags & NodeFlags.OptionalChain), optState = opt ? copy(this.state) : undefined;
        const mark = this.active.length;
        const r = this.placeOf(x.expression);
        if (r) this.active.push({ sym: r.sym, mode: "ref", node: r.id, base: true, path: r.path, slice: false });
        this.ex(x.argumentExpression, "read");
        this.active.length = mark;
        if (opt) this.state = join(optState!, this.state);
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
      case K.PrefixUnaryExpression: {
        const u = e as ts.PrefixUnaryExpression;
        if (u.operator === K.PlusPlusToken || u.operator === K.MinusMinusToken) {
          const mark = this.active.length;
          this.lhs(assignTarget(u.operand));
          this.active.length = mark;
        } else this.ex(u.operand, "read");
        return;
      }
      case K.PostfixUnaryExpression: {
        const mark = this.active.length;
        this.lhs(assignTarget((e as ts.PostfixUnaryExpression).operand));
        this.active.length = mark;
        return;
      }
      case K.AwaitExpression: this.markAwaited((e as ts.AwaitExpression).expression); this.ex((e as ts.AwaitExpression).expression, "read"); return;
      case K.TemplateExpression: for (const sp of (e as ts.TemplateExpression).templateSpans) this.ex(sp.expression, "read"); return;
      case K.ObjectLiteralExpression: {
        const t = exprTypes.get(e);
        const fieldCtx: Ctx = t?.k === "record" && (t.struct || isResultBranch(t)) ? "move" : "store"; // a Struct or Result branch takes ownership; a managed record cannot (§5.6)
        for (const p of (e as ts.ObjectLiteralExpression).properties) {
          if (p.kind === K.PropertyAssignment) this.ex((p as ts.PropertyAssignment).initializer, fieldCtx);
          else if (p.kind === K.ShorthandPropertyAssignment) this.ident((p as ts.ShorthandPropertyAssignment).name as ts.Identifier, fieldCtx);
          else if (p.kind === K.MethodDeclaration) new Flow(this.m, this.depth + 1).body(p as ts.MethodDeclaration);
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
      case K.ArrowFunction: case K.FunctionExpression: new Flow(this.m, this.depth + 1, ensuresArgs.has(e)).body(e as ts.ArrowFunction); return; // captures: `ident`
    }
    // literals, `this`, `null`: nothing to track
  }

  private ident(id: ts.Identifier, ctx: Ctx): void {
    const sym = localOf.get(id);
    if (!sym) return; // functions, module constants, namespaces
    const borrow = borrowMode(sym.declared) !== undefined;
    const isResource = sym.type.k === "resource";
    if (sym.fnDepth < this.depth && !this.captured.has(sym.id)) { // captured by this nested function (§5.5, §5.6, Q012)
      if (borrow) {
        if (!(this.ensuresFn && sym.fnDepth === this.depth - 1) && !(sym.fnDepth >= this.syncBorrowMinDepth)) {
          this.captured.add(sym.id);
          this.m.at("E3004", id, `the borrow '${sym.name}' cannot be captured by a closure`, { variable: sym.name, kind: "closure-capture" });
          return;
        }
      } else if (isResource) { this.captured.add(sym.id); this.m.at("E3004", id, `the resource '${sym.name}' cannot be captured by a closure`, { variable: sym.name, kind: "resource-escape" }); return; }
      else if (movesLike(sym.type)) { this.captured.add(sym.id); this.m.at("E3007", id, `the owned value '${sym.name}' cannot be captured by a closure`, { variable: sym.name, kind: "closure-capture" }); return; }
    }
    this.useCheck(id, sym);
    if (isResource) {
      let cur: Node = id;
      while (cur.parent?.kind === K.ParenthesizedExpression) cur = cur.parent;
      const pa = cur.parent;
      const okResMethod = pa?.kind === K.PropertyAccessExpression
        && (pa as ts.PropertyAccessExpression).expression === cur
        && pa.parent?.kind === K.CallExpression
        && (pa.parent as ts.CallExpression).expression === pa
        && ((pa as ts.PropertyAccessExpression).name.text === "borrow"
          || (pa as ts.PropertyAccessExpression).name.text === "get"
          || (pa as ts.PropertyAccessExpression).name.text === "take");
      if (!okResMethod) {
        this.m.at("E3004", id, `the resource '${sym.name}' cannot escape its 'using' binding; call '.borrow()', '.get()', or '.take()' directly`, { variable: sym.name, kind: "resource-escape" });
        return;
      }
    }
    if (ctx === "read") return;
    if (borrow) { this.m.at("E3004", id, `the borrow '${sym.name}' cannot be stored, returned or passed by value`, { variable: sym.name, kind: "borrow-escape" }); return; } // Q064
    if (!movesLike(sym.type)) return;
    if (ctx === "store") { this.m.at("E3007", id, `the owned value '${sym.name}' cannot be put in a managed container`, { variable: sym.name, kind: "managed-container" }); return; }
    this.moved(id, sym);
  }

  private exclusive(n: Node, sym: LocalSym, conflict?: Node, enclosing = false): void {
    if (this.e3005.has(n)) return;
    this.e3005.add(n);
    const msg = enclosing
      ? `'${sym.name}' conflicts with an enclosing borrow or assignment`
      : `'${sym.name}' is used by another argument of this call`;
    this.m.at("E3005", n, msg, {
      variable: sym.name,
      ...(conflict ? { conflictAt: this.m.mod.pf.position(conflict.getStart(this.m.mod.sf)) } : {}),
    });
  }

  private useCheck(id: ts.Identifier, sym: LocalSym): void {
    const at = this.state?.get(sym.id);
    if (!at) return;
    const p = this.m.mod.pf.position(at.getStart(this.m.mod.sf));
    if (sym.type.k === "tparam") {
      this.m.at("E3001", id, `use of moved value '${sym.name}' (type parameter '${sym.type.p.name}' is move-only unless constrained with '${sym.type.p.name} extends Copy')`, { variable: sym.name, movedAt: p, typeParam: sym.type.p.name });
      return;
    }
    this.m.at("E3001", id, `use of moved value '${sym.name}'`, { variable: sym.name, movedAt: p });
  }

  private moved(id: ts.Identifier, sym: LocalSym): void {
    if (!this.state) return;
    const a = this.active.find((x) => x.sym.id === sym.id);
    if (a?.base) this.m.at("E3001", a.node, `'${sym.name}' is moved while this access to it is being evaluated`, { variable: sym.name, movedAt: this.m.mod.pf.position(id.getStart(this.m.mod.sf)) });
    else if (a) this.exclusive(id, sym, a.node);
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
    if (k === K.QuestionQuestionEqualsToken || k === K.BarBarEqualsToken || k === K.AmpersandAmpersandEqualsToken) {
      const logical = k !== K.QuestionQuestionEqualsToken;
      const l = assignTarget(b.left);
      if (isId(l)) {
        const sym = localOf.get(l);
        if (sym) {
          this.useCheck(l, sym);
          if (borrowMode(sym.declared)) {
            this.m.at("E3004", l, `the borrow parameter '${sym.name}' cannot be reassigned`, { variable: sym.name, kind: "reassign-borrow" });
          } else {
            const cAct = this.active.find((x) => x.sym.id === sym.id);
            if (cAct) this.exclusive(l, sym, cAct.node, true);
            if (sym.fnDepth < this.depth) this.ident(l, "read");
          }
        }
        const s0 = copy(this.state);
        this.ex(b.right, logical ? "read" : "move");
        this.state = join(s0, this.state);
        return;
      }
      const mark = this.active.length;
      const base = this.lhs(l);
      const bt = base && unref(exprTypes.get(base) ?? { k: "error" });
      const struct = l.kind === K.PropertyAccessExpression && bt?.k === "record" && bt.struct;
      const vecElem = l.kind === K.ElementAccessExpression && (genName(bt) === "Vec" || genName(bt) === "Slice");
      const s0 = copy(this.state);
      this.ex(b.right, logical ? "read" : struct ? "move" : vecElem ? "read" : "store");
      this.state = join(s0, this.state);
      this.active.length = mark;
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
    if (k === K.PlusEqualsToken || k === K.MinusEqualsToken || k === K.AsteriskEqualsToken || k === K.SlashEqualsToken || k === K.PercentEqualsToken || k === K.AsteriskAsteriskEqualsToken ||
      k === K.AmpersandEqualsToken || k === K.BarEqualsToken || k === K.CaretEqualsToken || k === K.LessThanLessThanEqualsToken || k === K.GreaterThanGreaterThanEqualsToken || k === K.GreaterThanGreaterThanGreaterThanEqualsToken) {
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
      if (borrowMode(sym.declared)) { this.m.at("E3004", l, `the borrow parameter '${sym.name}' cannot be reassigned`, { variable: sym.name, kind: "reassign-borrow" }); return; } // Q151
      const cAct = this.active.find((x) => x.sym.id === sym.id);
      if (cAct) this.exclusive(l, sym, cAct.node, true); // Q170: overwriting a borrowed root
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
    if (l.kind !== K.PropertyAccessExpression && l.kind !== K.ElementAccessExpression) return undefined;
    const obj = l.kind === K.PropertyAccessExpression ? (l as ts.PropertyAccessExpression).expression : (l as ts.ElementAccessExpression).expression;
    const tmp = this.sliceCall(strip(obj)); // Q222 (b): a written `slice` / `view` is not a borrowed argument or a receiver
    if (tmp) this.m.at("E3004", tmp.name, `'${tmp.name.text}' can only be a borrowed argument or a receiver`, { kind: "borrow-temp-position" });
    const root = this.placeOf(obj);
    this.place(obj);
    const target = l.kind === K.PropertyAccessExpression ? this.placeOf(l) : this.placeOf(obj);
    const cAct = root && this.active.find((x) => x.sym.id === root.sym.id && (!target || pathsOverlap(x.path, target.path)));
    if (root && cAct) this.exclusive(l, root.sym, cAct.node, true); // Q170: a write under a borrow of the same place (Q190: a disjoint field is another place)
    if (root) this.active.push({ sym: root.sym, mode: "mut", node: root.id, base: true, path: target?.path ?? root.path, slice: false }); // popped by the caller
    if (l.kind === K.ElementAccessExpression) this.ex((l as ts.ElementAccessExpression).argumentExpression, "read");
    if (!tmp && this.isReadOnly(obj)) this.m.at("E3006", l, root ? `cannot write through the Ref '${root.sym.name}'` : "cannot write through a Ref or ConstPtr", { ...(root ? { variable: root.sym.name } : {}), kind: "readonly-ref" });
    return obj;
  }

  /** Whether `e0` may refer to a `Ref` parameter or `ConstPtr` slice/borrow (through field paths, `slice`/`view`, or `?:`). */
  private isReadOnly(e0: ts.Expression, allowBorrow = false): boolean {
    const e = strip(e0);
    if (isId(e)) { const sym = localOf.get(e); return !!sym && borrowMode(sym.declared) === "ref"; }
    if (e.kind === K.PropertyAccessExpression && !(e as ts.PropertyAccessExpression).questionDotToken) return this.isReadOnly((e as ts.PropertyAccessExpression).expression);
    if (e.kind === K.ConditionalExpression) { const c = e as ts.ConditionalExpression; return this.isReadOnly(c.whenTrue, allowBorrow) || this.isReadOnly(c.whenFalse, allowBorrow); }
    const sc = this.sliceCall(e);
    if (sc) return genName(exprTypes.get(sc.expression)) === "ConstPtr" || this.isReadOnly(sc.expression);
    if (allowBorrow) {
      const bc = this.borrowCall(e);
      if (bc) return genName(exprTypes.get(bc.expression)) === "ConstPtr";
    }
    return false;
  }

  // ---- places (§5.5): a local, a borrowed parameter, a field path of one, or `v.slice(a, b)` of one
  /** The place `e0` denotes (Q190): field paths are compared segment by segment; a `slice` keeps the outermost member name as its trap anchor. */
  private placeOf(e0: ts.Expression, sliceName?: ts.Identifier, allowBorrow = false): Place | undefined {
    const e = strip(e0);
    if (isId(e)) { const sym = localOf.get(e); return sym && { sym, id: e, path: [], slice: false }; }
    if (e.kind === K.PropertyAccessExpression && !(e as ts.PropertyAccessExpression).questionDotToken) {
      const p = e as ts.PropertyAccessExpression;
      const inner = this.placeOf(p.expression, sliceName);
      return inner && { ...inner, path: [...inner.path, p.name.text] };
    }
    const slice = this.sliceCall(e);
    if (slice) {
      const name = sliceName ?? (slice.name as ts.Identifier);
      const g = genName(exprTypes.get(slice.expression));
      if (g === "Ptr" || g === "ConstPtr") { // §14.4: the root is a variable or parameter, through offset / cast only
        const root = this.ptrRoot(slice.expression);
        return root && { ...root, slice: true, ptrSlice: true, sliceName: name };
      }
      const inner = this.placeOf(slice.expression, name);
      return inner && { ...inner, slice: true, sliceName: name };
    }
    if (allowBorrow) {
      const bc = this.borrowCall(e);
      if (bc) { // §14.4: `p.borrow()` is a place only in a borrowed argument position
        const root = this.ptrRoot(bc.expression);
        return root && { ...root, slice: true, ptrSlice: true, sliceName: bc.name as ts.Identifier };
      }
    }
    const rb = this.resBorrowCall(e);
    if (rb) return this.placeOf(rb.expression, sliceName);
    return undefined;
  }
  /** The root of a Ptr place (§14.4): a local or parameter, or that under `.offset(...)` / `.cast()` calls. */
  private ptrRoot(e0: ts.Expression): Place | undefined {
    const e = strip(e0);
    if (isId(e)) { const sym = localOf.get(e); return sym && { sym, id: e, path: [], slice: false }; }
    if (e.kind === K.CallExpression) {
      const p = (e as ts.CallExpression).expression;
      if (p.kind === K.PropertyAccessExpression && ((p as ts.PropertyAccessExpression).name.text === "offset" || (p as ts.PropertyAccessExpression).name.text === "cast")) {
        const g = genName(exprTypes.get((p as ts.PropertyAccessExpression).expression));
        if (g === "Ptr" || g === "ConstPtr") return this.ptrRoot((p as ts.PropertyAccessExpression).expression);
      }
    }
    return undefined;
  }
  /** The callee of a call to a builtin method that only a borrowed argument can hold (D132 `param`), when `borrow` says whether it is `p.borrow()`. */
  private paramCall(e: ts.Expression, borrow: boolean): ts.PropertyAccessExpression | undefined {
    if (e.kind !== K.CallExpression) return undefined;
    const p = (e as ts.CallExpression).expression;
    if (p.kind !== K.PropertyAccessExpression || ((p as ts.PropertyAccessExpression).name.text === "borrow") !== borrow) return undefined;
    return genFx(exprTypes.get((p as ts.PropertyAccessExpression).expression), (p as ts.PropertyAccessExpression).name.text)?.recv === "param" ? p as ts.PropertyAccessExpression : undefined;
  }
  /** A range-producing call's callee: `X.slice(a, b)` on a Vec / Slice / Ptr / ConstPtr (Q013, §14.4), `a.view(b)` on an Arena (Q188 (b)). */
  private sliceCall(e: ts.Expression): ts.PropertyAccessExpression | undefined { return this.paramCall(e, false); }
  /** `p.borrow()` on a `Ptr` / `ConstPtr` (§14.4). */
  private borrowCall(e: ts.Expression): ts.PropertyAccessExpression | undefined { return this.paramCall(e, true); }
  /** `r.borrow()` / `r.take()` on a `Resource<T>` binding (SPEC-v1 §5). */
  private resCall(e: ts.Expression, name: "borrow" | "take"): ts.PropertyAccessExpression | undefined {
    if (e.kind !== K.CallExpression) return undefined;
    const p = (e as ts.CallExpression).expression;
    if (p.kind !== K.PropertyAccessExpression || (p as ts.PropertyAccessExpression).name.text !== name) return undefined;
    return exprTypes.get((p as ts.PropertyAccessExpression).expression)?.k === "resource" ? p as ts.PropertyAccessExpression : undefined;
  }
  private resBorrowCall(e: ts.Expression): ts.PropertyAccessExpression | undefined { return this.resCall(e, "borrow"); }
  private resTakeCall(e: ts.Expression): ts.PropertyAccessExpression | undefined { return this.resCall(e, "take"); }
  /** Walks a place in evaluation order: the root is used, `slice` bounds are read. */
  private place(e0: ts.Expression, allowBorrow = false): void {
    const e = strip(e0);
    if (isId(e)) { this.ident(e, "read"); return; }
    if (e.kind === K.PropertyAccessExpression) { this.place((e as ts.PropertyAccessExpression).expression); return; }
    const s = this.sliceCall(e);
    if (s) { this.place(s.expression); for (const a of (e as ts.CallExpression).arguments) this.ex(a, "read"); return; }
    if (allowBorrow) {
      const bc = this.borrowCall(e);
      if (bc) { this.place(bc.expression); return; }
    }
    const rb = this.resBorrowCall(e);
    if (rb) { this.place(rb.expression); return; }
    this.ex(e, "read");
  }
  /**
   * A borrow of `e` with `mode`. Not a place: E3008, unless it is a receiver (a temporary receiver is fine).
   * `Mut` of something reached through a `Ref`: E3006 at the argument, or at the member name for a receiver (Q050).
   */
  private borrow(e: ts.Expression, mode: "ref" | "mut", member?: ts.Identifier, arg = -1): Use | undefined {
    const r = this.placeOf(e, undefined, !member);
    if (!r) {
      if (!member) this.m.at("E3008", strip(e), "a borrowed argument must be a variable, a field path or 'v.borrowSlice(a, b)'", { kind: "invalid-borrow-place" });
      else if (mode === "mut" && this.isReadOnly(e)) this.m.at("E3006", member, "cannot mutate through a Ref", { kind: "readonly-ref" });
      this.place(e, !member); // a `slice` here is still in a borrowing position (Q013)
      return undefined;
    }
    const node = strip(e);
    // Q170: within one call either side `Mut` conflicts; an outer borrow conflicts only with an inner `Mut` (Q065, Q067).
    // Q190: disjoint field paths are different places (a); a sibling pair of `slice` arguments is left to the runtime check (b).
    const cActIdx = this.active.findIndex((x, i) => x.sym.id === r.sym.id && pathsOverlap(x.path, r.path)
      && (mode === "mut" || (i >= this.callMark && x.mode === "mut"))
      && !(i >= this.callMark && x.slice && r.slice && !x.ptrSlice && !r.ptrSlice));
    if (cActIdx >= 0) this.exclusive(node, r.sym, this.active[cActIdx]!.node, cActIdx < this.callMark);
    const cPend = this.pendingMut.find((s) => s.sym.id === r.sym.id);
    if (cPend) this.exclusive(node, r.sym, cPend.node); // §14.4: an earlier `unbox` of this call
    this.active.push({ sym: r.sym, mode, node, base: false, path: r.path, slice: r.slice, ptrSlice: r.ptrSlice }); // popped by `call`; active while `slice` bounds are evaluated
    this.place(e, !member);
    if (mode === "mut") {
      if (borrowMode(r.sym.declared) === "ref") this.m.at("E3006", member ?? strip(e), `'${r.sym.name}' is borrowed as Ref and cannot be passed as Mut`, { variable: r.sym.name, kind: "readonly-ref" });
      else if (this.isReadOnly(e, !member)) this.m.at("E3006", member ?? strip(e), "a 'ConstPtr' slice or borrow cannot be passed as Mut", { variable: r.sym.name, kind: "readonly-constptr" });
    }
    return { sym: r.sym, mode, node, path: r.path, slice: r.slice, arg, sliceName: r.sliceName, ptrSlice: r.ptrSlice };
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
    const pmMark = this.pendingMut.length;
    let store = false;
    if (callee.kind === K.PropertyAccessExpression) {
      const p = callee as ts.PropertyAccessExpression;
      const g = genName(exprTypes.get(p.expression));
      const fx = e.kind === K.CallExpression ? genFx(exprTypes.get(p.expression), p.name.text) : undefined; // D132
      if (this.resBorrowCall(e)) {
        this.m.at("E3004", p.name, "'borrow' can only be a borrowed argument or a receiver", { kind: "borrow-temp-position" });
        this.ex(p.expression, "read");
      } else if (this.resTakeCall(e)) {
        this.ex(p.expression, "move");
      } else if (fx?.recv === "param") this.m.at("E3004", p.name, `'${p.name.text}' can only be a borrowed argument or a receiver`, { kind: "borrow-temp-position" }); // Q013, §14.4; view: Q188 (b)
      if (this.resBorrowCall(e) || this.resTakeCall(e)) {
        // handled above
      } else if (fx?.recv === "param" && (g === "Ptr" || g === "ConstPtr")) {
        this.ex(p.expression, "read"); // a pointer is Copy: the place is its pointee
      } else if (g === "Ptr" && e.kind === K.CallExpression && p.name.text === "unbox") {
        const root = this.ptrRoot(p.expression); // §14.4: the receiver form, and Mut use of the root
        if (!root) this.m.at("E3008", strip(p.expression), "'unbox' needs a variable or parameter, optionally through 'offset' / 'cast'", { kind: "invalid-unbox-root" });
        else {
          const c = this.active.find((x) => x.sym.id === root.sym.id) ?? this.pendingMut.find((s) => s.sym.id === root.sym.id);
          if (c) this.exclusive(e, root.sym, c.node);
        }
        this.ex(p.expression, "read");
      } else if (fx && fx.recv !== "none") {
        const u = this.borrow(p.expression, fx.recv === "mut" ? "mut" : "ref", p.name as ts.Identifier);
        if (u) uses.push(u);
      } else {
        this.ex(p.expression, "read");
        store = g === "Array" || g === "ReadonlyArray" || g === "Map" || g === "Set";
      }
    } else if (isId(callee) && !localOf.has(callee) && !sig) {
      // builtins (e.g. ok/err) move their owned arguments
    } else this.ex(callee, "read");
    const opt = !!(e.flags & NodeFlags.OptionalChain), optState = opt ? copy(this.state) : undefined; // Q220: ?. short-circuits before args
    const syncCellCb = e.kind === K.CallExpression && callee.kind === K.PropertyAccessExpression &&
      genName(exprTypes.get((callee as ts.PropertyAccessExpression).expression)) === "OwnedCell" &&
      ((callee as ts.PropertyAccessExpression).name.text === "withRef" || (callee as ts.PropertyAccessExpression).name.text === "withMut");
    args.forEach((a, i) => {
      const p = sig?.params[i];
      const mode = borrowMode(p);
      if (mode) { const u = this.borrow(a, mode, undefined, i); if (u) uses.push(u); return; }
      const x = strip(a);
      if (x.kind === K.SpreadElement) { this.ex((x as ts.SpreadElement).expression, "read"); return; }
      if (syncCellCb && i === 0 && (x.kind === K.ArrowFunction || x.kind === K.FunctionExpression) && !hasMod(x, K.AsyncKeyword)) {
        const sub = new Flow(this.m, this.depth + 1, false, this.syncBorrowMinDepth, this.active, this.pendingMut);
        sub.callMark = this.active.length;
        sub.body(x as ts.FunctionLikeDeclaration);
        return;
      }
      let unboxRoot: { sym: LocalSym; node: Node } | undefined;
      if (x.kind === K.CallExpression) { // §14.4 / §5: `p.unbox()` or `r.take()` as an argument counts as a Mut/move use of `p`/`r`
        const cp = (x as ts.CallExpression).expression;
        if (cp.kind === K.PropertyAccessExpression && (cp as ts.PropertyAccessExpression).name.text === "unbox" && genName(exprTypes.get((cp as ts.PropertyAccessExpression).expression)) === "Ptr") {
          const root = this.ptrRoot((cp as ts.PropertyAccessExpression).expression);
          if (root) { uses.push({ sym: root.sym, mode: "mut", node: x, path: root.path, slice: false, arg: i }); unboxRoot = { sym: root.sym, node: x }; }
        } else if (this.resTakeCall(x)) {
          const rexpr = strip(this.resTakeCall(x)!.expression);
          const sym = isId(rexpr) ? localOf.get(rexpr) : undefined;
          if (sym) { uses.push({ sym, mode: "move", node: x, path: [], slice: false, arg: i }); unboxRoot = { sym, node: x }; }
        }
      }
      if (isId(x) && !store) {
        const sym = localOf.get(x);
        const before = sym && this.state?.get(sym.id);
        this.ex(a, "move");
        if (sym && !before && this.state?.get(sym.id) === x) uses.push({ sym, mode: "move", node: x, path: [], slice: false, arg: i });
        return;
      }
      this.ex(a, store ? "store" : "move");
      if (unboxRoot) this.pendingMut.push(unboxRoot); // push after evaluating this argument so `p.unbox()` does not conflict with itself
    });
    // E3005 (§5.5): a variable passed as Mut takes part in no other argument; moving it while borrowed is rejected too (Q152).
    // Q190 (a): places are field paths, not just roots.
    uses.forEach((u, j) => {
      const v = uses.slice(0, j).find((w) => w.sym.id === u.sym.id && (w.mode !== "ref" || u.mode !== "ref") && placesConflict(w, u));
      if (v) this.exclusive(u.node, u.sym, v.node);
    });
    // Q190 (b): record the slice groups the emitters must check at runtime (T013).
    const byRoot = new Map<string, Use[]>(); // keyed by root and field path: slices of two fields are different memory (Q239)
    for (const u of uses) if (u.slice && !u.ptrSlice && u.arg >= 0) { const k = `${u.sym.id}:${u.path.join(".")}`, l = byRoot.get(k) ?? []; l.push(u); byRoot.set(k, l); }
    const groups: SliceGroupEntry[][] = [];
    for (const l of byRoot.values()) {
      if (l.length < 2) continue;
      const sorted = [...l].sort((a, b) => a.arg - b.arg);
      if (sorted.some((u, j) => sorted.slice(0, j).some((w) => w.mode === "mut" || u.mode === "mut")))
        groups.push(sorted.map((u) => ({ arg: u.arg, mut: u.mode === "mut", name: u.sliceName! })));
    }
    if (groups.length) sliceGroups.set(e, groups);
    this.active.length = mark;
    this.callMark = outerMark;
    this.pendingMut.length = pmMark;
    const recv = callee.kind === K.PropertyAccessExpression ? exprTypes.get((callee as ts.PropertyAccessExpression).expression) : undefined;
    // Q174 (案2): an inferred container-of-owned type (a written one is P2's); a receiver of such a type was reported where it came from
    const res = exprTypes.get(e);
    // §15.2 (Q207): `port.recv()` with an owned R is exempt as the operand of `await`, and E3007 everywhere else
    const awaitedRecv = e.kind === K.CallExpression && callee.kind === K.PropertyAccessExpression &&
      (callee as ts.PropertyAccessExpression).name.text === "recv" && genName(recv) === "Port" && this.awaited.has(e);
    if (res && ownedDeep(res) && !(recv && ownedDeep(recv)) && !awaitedRecv) {
      const targ = e.typeArguments?.find((a) => this.m.prog.insts.some((x) => x.node === a && movesLike(x.arg)));
      this.m.at("E3007", targ ?? (e.kind === K.NewExpression && e.typeArguments ? e.typeArguments[e.typeArguments.length - 1]! : isId(callee) ? callee : callee.kind === K.PropertyAccessExpression ? (callee as ts.PropertyAccessExpression).name : callee), "this expression has a managed container type that holds an owned value", { kind: "managed-container", actual: show(res) });
    }
    if (isNever(exprTypes.get(e))) this.state = null;
    if (opt) this.state = join(optState!, this.state);
  }
}

const loopLabelOf = (n: Node): string | undefined => n.parent?.kind === K.LabeledStatement ? (n.parent as ts.LabeledStatement).label.text : undefined;
const isTrue = (e: ts.Expression): boolean => e.kind === K.TrueKeyword;
