// W8001 (Q187): a call from managed code to a strict / rt function inside a synchronous loop crosses the layer boundary on every iteration.
import { NodeFlags, SyntaxKind as K, type Node, type ts } from "./parse.ts";
import type { Program as Decls, Reporter } from "./modules.ts";
import { callFns } from "./expr.ts";

const FN_LIKE = new Set([K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.Constructor, K.GetAccessor, K.SetAccessor]);

/** Whether a node directly contains `await` or `await using` within its enclosing loop body (stopping at nested functions/loops). */
function hasDirectAwait(n: Node): boolean {
  if (n.kind === K.AwaitExpression) return true;
  if (n.kind === K.VariableDeclarationList && (n.flags & NodeFlags.AwaitUsing) === NodeFlags.AwaitUsing) return true;
  if (FN_LIKE.has(n.kind) || n.kind === K.WhileStatement || n.kind === K.DoStatement) return false;
  if (n.kind === K.ForStatement) {
    const init = (n as ts.ForStatement).initializer;
    return !!init && hasDirectAwait(init);
  }
  if (n.kind === K.ForOfStatement || n.kind === K.ForInStatement) {
    return hasDirectAwait((n as ts.ForOfStatement).expression);
  }
  let found = false;
  n.forEachChild((c) => {
    if (!found && hasDirectAwait(c)) found = true;
  });
  return found;
}

export function loopBoundaryWarnings(decls: Decls, rep: Reporter): void {
  const native = new Set(decls.fns.filter((f) => f.layer !== "managed").map((f) => f.decl as Node));
  for (const mod of decls.mods) {
    const walk = (n: Node, inSyncLoop: boolean): void => {
      if (native.has(n)) return; // inside strict / rt, calls stay in C
      if (FN_LIKE.has(n.kind)) { n.forEachChild((c) => walk(c, false)); return; } // a function body runs when called, not per iteration of an outer loop
      if (n.kind === K.CallExpression && inSyncLoop) {
        const callee = (n as ts.CallExpression).expression;
        let f = callFns.get(n);
        let anchor: Node = callee;
        if (!f && callee.kind === K.Identifier) {
          const v = decls.lookupValue(mod, (callee as ts.Identifier).text);
          if (v?.k === "fn") f = v;
        } else if (callee.kind === K.PropertyAccessExpression) {
          anchor = (callee as ts.PropertyAccessExpression).name;
        }
        if (f && f.layer !== "managed")
          rep.warn(mod, "W8001", anchor, `call to the ${f.layer} function '${f.name}' inside a loop crosses the layer boundary on every iteration`, { callee: f.name, layer: f.layer });
      }
      switch (n.kind) {
        case K.WhileStatement: case K.DoStatement: {
          const x = n as ts.WhileStatement | ts.DoStatement;
          const sync = !(hasDirectAwait(x.expression) || hasDirectAwait(x.statement));
          walk(x.expression, sync);
          walk(x.statement, sync);
          return;
        }
        case K.ForStatement: {
          const x = n as ts.ForStatement;
          if (x.initializer) walk(x.initializer, inSyncLoop);
          const parts = [x.condition, x.incrementor, x.statement];
          const sync = !parts.some((c) => !!c && hasDirectAwait(c));
          for (const c of parts) if (c) walk(c, sync);
          return;
        }
        case K.ForOfStatement: case K.ForInStatement: {
          const x = n as ts.ForOfStatement;
          walk(x.initializer, inSyncLoop);
          walk(x.expression, inSyncLoop);
          walk(x.statement, !hasDirectAwait(x.statement));
          return;
        }
      }
      n.forEachChild((c) => walk(c, inSyncLoop));
    };
    walk(mod.sf, false);
  }
}
