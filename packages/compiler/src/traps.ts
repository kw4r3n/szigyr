// §6 (stage 2): the places an rt function can trap, by trap code and source position (anchors: docs/DIAGNOSTICS.md).
import { SyntaxKind as K, type Node, type ParsedFile, type ts } from "./parse.ts";
import { directiveOf } from "./modules.ts";
import { exprTypes, localOf } from "./expr.ts";
import { sliceGroups } from "./ownership.ts";
import { isInt, type Type } from "./types.ts";
import { genFx } from "./builtins.ts";

export interface TrapSite { code: string; line: number; col: number }

const INT_CONV = new Set(["i8", "i16", "i32", "u8", "u16", "u32", "usize"]);
const CALL_TRAPS: Record<string, string[]> = { divTrunc: ["T001", "T007"], rem: ["T007"], panic: ["T006"], requires: ["T004"], ensures: ["T005"], invariant: ["T010"] };
const INT_OPS = new Set<K>([K.PlusToken, K.MinusToken, K.AsteriskToken, K.PlusEqualsToken, K.MinusEqualsToken, K.AsteriskEqualsToken]);
const SHIFTS = new Set<K>([K.LessThanLessThanToken, K.GreaterThanGreaterThanToken, K.GreaterThanGreaterThanGreaterThanToken]);
const int = (n: Node): boolean => { const t: Type | undefined = exprTypes.get(n); return !!t && isInt(t); };

/** For each rt function declared in `pf` (after a successful check), its trap sites in source order. */
export function trapSites(pf: ParsedFile): Record<string, TrapSite[]> {
  const sf = pf.sourceFile;
  const fileLayer = directiveOf(sf.statements);
  const cImports = new Set<string>();
  for (const s of sf.statements) {
    if (s.kind !== K.ImportDeclaration) continue;
    const d = s as ts.ImportDeclaration, nb = d.importClause?.namedBindings;
    if (d.moduleSpecifier.kind === K.StringLiteral && (d.moduleSpecifier as ts.StringLiteral).text.startsWith("c:") && nb?.kind === K.NamedImports) {
      for (const e of (nb as ts.NamedImports).elements) cImports.add(e.name.text);
    }
  }
  const out: Record<string, TrapSite[]> = {};
  for (const s of sf.statements) {
    if (s.kind !== K.FunctionDeclaration) continue;
    const d = s as ts.FunctionDeclaration;
    if ((directiveOf(d.body!.statements) ?? fileLayer) !== "rt") continue;
    const sites: TrapSite[] = [];
    const add = (code: string, n: Node): void => { sites.push({ code, ...pf.position(n.getStart(sf)) }); };
    const walk = (n: Node): void => {
      if (n.kind === K.Identifier) {
        const name = (n as ts.Identifier).text;
        const p = n.parent;
        const isPropKey = p?.kind === K.PropertyAccessExpression && (p as ts.PropertyAccessExpression).name === n;
        const isPropAssign = p?.kind === K.PropertyAssignment && (p as ts.PropertyAssignment).name === n;
        const isCallee = p?.kind === K.CallExpression && (p as ts.CallExpression).expression === n;
        const isDeclName = (p?.kind === K.VariableDeclaration && (p as ts.VariableDeclaration).name === n) ||
          (p?.kind === K.BindingElement && (p as ts.BindingElement).name === n);
        if (!isPropKey && !isPropAssign && !isCallee && !isDeclName && cImports.has(name) && !localOf.has(n)) {
          const t = exprTypes.get(n);
          if (t?.k === "num" && t.name === "usize") add("T003", n);
        }
      } else if (n.kind === K.PropertyAccessExpression) {
        const pa = n as ts.PropertyAccessExpression;
        const rt = exprTypes.get(pa.expression);
        const ft = exprTypes.get(pa);
        const isPlainLhs = pa.parent?.kind === K.BinaryExpression &&
          (pa.parent as ts.BinaryExpression).operatorToken.kind === K.EqualsToken &&
          (pa.parent as ts.BinaryExpression).left === pa;
        if (!isPlainLhs && rt?.k === "cstruct" && ft?.k === "num" && ft.name === "usize") add("T003", pa.name);
      } else if (n.kind === K.ObjectBindingPattern) {
        if (exprTypes.get(n)?.k === "cstruct") {
          for (const el of (n as ts.ObjectBindingPattern).elements) {
            const ft = el.name ? exprTypes.get(el.name) : undefined;
            if (el.name && ft?.k === "num" && ft.name === "usize") add("T003", (el.propertyName ?? el.name) as Node);
          }
        }
      } else if (n.kind === K.BinaryExpression) {
        const b = n as ts.BinaryExpression, k = b.operatorToken.kind;
        if (INT_OPS.has(k) && int(b)) add("T001", b.operatorToken); // the operation's own type: assignment targets have none recorded
        if (SHIFTS.has(k)) add("T009", b.operatorToken);
      } else if (n.kind === K.PrefixUnaryExpression && (n as ts.PrefixUnaryExpression).operator === K.MinusToken && int(n) && (n as ts.PrefixUnaryExpression).operand.kind !== K.NumericLiteral) {
        add("T001", n);
      } else if (n.kind === K.ElementAccessExpression) {
        add("T002", (n as ts.ElementAccessExpression).argumentExpression);
      } else if (n.kind === K.CallExpression) {
        const c = (n as ts.CallExpression).expression;
        if (c.kind === K.Identifier) {
          const name = (c as ts.Identifier).text;
          if (INT_CONV.has(name)) add("T003", c);
          if (cImports.has(name) && !localOf.has(c)) {
            const ret = exprTypes.get(n);
            if (ret?.k === "num" && ret.name === "usize") add("T003", c); // §14.2 (D121)
          }
          for (const code of CALL_TRAPS[name] ?? []) add(code, c);
        } else if (c.kind === K.PropertyAccessExpression) { // D132: e.g. `slice` T002, Pool T011 (Q188 (a)), `view` T012 (Q188 (b))
          const pa = c as ts.PropertyAccessExpression;
          for (const code of genFx(exprTypes.get(pa.expression), pa.name.text)?.traps ?? []) add(code, pa.name);
        }
        // Q190 (b): a runtime-checked slice group can trap T013 at each later entry that may overlap an earlier Mut pair.
        for (const g of sliceGroups.get(n) ?? []) for (let j = 1; j < g.length; j++) if (g.slice(0, j).some((w) => w.mut || g[j]!.mut)) add("T013", g[j]!.name);
      }
      n.forEachChild(walk);
    };
    walk(d.body!);
    out[d.name!.text] = sites.sort((a, b) => a.line - b.line || a.col - b.col);
  }
  return out;
}
