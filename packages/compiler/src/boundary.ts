// W8001 (Q187): a call from managed code to a strict / rt function inside a loop crosses the layer boundary on every iteration.
import { SyntaxKind as K, type Node, type ts } from "./parse.ts";
import { resolveFn } from "./emit-c.ts";
import type { Program as Decls, Reporter } from "./modules.ts";

const FN_LIKE = new Set([K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.Constructor, K.GetAccessor, K.SetAccessor]);

export function loopBoundaryWarnings(decls: Decls, rep: Reporter): void {
  const native = new Set(decls.fns.filter((f) => f.layer !== "managed").map((f) => f.decl as Node));
  for (const mod of decls.mods) {
    // shortcut: callees resolve by module-level name, so a local that shadows a strict function's name also warns; resolve through scopes if that shows up.
    const walk = (n: Node, loops: number): void => {
      if (native.has(n)) return; // inside strict / rt, calls stay in C
      if (FN_LIKE.has(n.kind)) { n.forEachChild((c) => walk(c, 0)); return; } // a function body runs when called, not per iteration of an outer loop
      if (n.kind === K.CallExpression && loops > 0) {
        const callee = (n as ts.CallExpression).expression;
        if (callee.kind === K.Identifier) {
          const f = resolveFn(mod, (callee as ts.Identifier).text);
          if (f && f.layer !== "managed")
            rep.warn(mod, "W8001", callee, `call to the ${f.layer} function '${f.name}' inside a loop crosses the layer boundary on every iteration`, { callee: f.name, layer: f.layer });
        }
      }
      switch (n.kind) {
        case K.WhileStatement: case K.DoStatement: n.forEachChild((c) => walk(c, loops + 1)); return;
        case K.ForStatement: {
          const x = n as ts.ForStatement;
          if (x.initializer) walk(x.initializer, loops);
          for (const c of [x.condition, x.incrementor, x.statement]) if (c) walk(c, loops + 1);
          return;
        }
        case K.ForOfStatement: case K.ForInStatement: {
          const x = n as ts.ForOfStatement;
          walk(x.initializer, loops);
          walk(x.expression, loops);
          walk(x.statement, loops + 1);
          return;
        }
      }
      n.forEachChild((c) => walk(c, loops));
    };
    walk(mod.sf, 0);
  }
}
