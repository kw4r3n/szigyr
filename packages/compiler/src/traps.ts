// §6 (stage 2): the places an rt function can trap, by trap code and source position (anchors: docs/DIAGNOSTICS.md).
import { SyntaxKind as K, type Node, type ParsedFile, type ts } from "./parse.ts";
import { directiveOf } from "./modules.ts";
import { exprTypes } from "./expr.ts";
import { sliceGroups } from "./ownership.ts";
import { isInt, unref, type Type } from "./types.ts";

export interface TrapSite { code: string; line: number; col: number }

const INT_CONV = new Set(["i8", "i16", "i32", "u8", "u16", "u32", "usize"]);
const CALL_TRAPS: Record<string, string[]> = { divTrunc: ["T001", "T007"], rem: ["T001", "T007"], panic: ["T006"], requires: ["T004"], ensures: ["T005"], invariant: ["T010"] };
const INT_OPS = new Set<K>([K.PlusToken, K.MinusToken, K.AsteriskToken, K.PlusEqualsToken, K.MinusEqualsToken, K.AsteriskEqualsToken]);
const SHIFTS = new Set<K>([K.LessThanLessThanToken, K.GreaterThanGreaterThanToken, K.GreaterThanGreaterThanGreaterThanToken]);
const int = (n: Node): boolean => { const t: Type | undefined = exprTypes.get(n); return !!t && isInt(t); };

/** For each rt function declared in `pf` (after a successful check), its trap sites in source order. */
export function trapSites(pf: ParsedFile): Record<string, TrapSite[]> {
  const sf = pf.sourceFile;
  const fileLayer = directiveOf(sf.statements);
  const out: Record<string, TrapSite[]> = {};
  for (const s of sf.statements) {
    if (s.kind !== K.FunctionDeclaration) continue;
    const d = s as ts.FunctionDeclaration;
    if ((directiveOf(d.body!.statements) ?? fileLayer) !== "rt") continue;
    const sites: TrapSite[] = [];
    const add = (code: string, n: Node): void => { sites.push({ code, ...pf.position(n.getStart(sf)) }); };
    const walk = (n: Node): void => {
      if (n.kind === K.BinaryExpression) {
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
          for (const code of CALL_TRAPS[name] ?? []) add(code, c);
        } else if (c.kind === K.PropertyAccessExpression && (c as ts.PropertyAccessExpression).name.text === "slice") {
          const r = exprTypes.get((c as ts.PropertyAccessExpression).expression);
          const u = r && unref(r);
          if (u?.k === "gen" && (u.name === "Vec" || u.name === "Slice")) add("T002", (c as ts.PropertyAccessExpression).name);
        } else if (c.kind === K.PropertyAccessExpression && ["get", "set", "remove"].includes((c as ts.PropertyAccessExpression).name.text)) {
          const r = exprTypes.get((c as ts.PropertyAccessExpression).expression);
          const u = r && unref(r);
          if (u?.k === "gen" && u.name === "Pool") add("T011", (c as ts.PropertyAccessExpression).name); // Q188 (a)
        } else if (c.kind === K.PropertyAccessExpression && (c as ts.PropertyAccessExpression).name.text === "view") {
          const r = exprTypes.get((c as ts.PropertyAccessExpression).expression);
          const u = r && unref(r);
          if (u?.k === "gen" && u.name === "Arena") add("T012", (c as ts.PropertyAccessExpression).name); // Q188 (b)
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
