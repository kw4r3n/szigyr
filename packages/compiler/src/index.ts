import { dirname, relative, resolve } from "node:path";
import type { Diagnostic, RunResult } from "./diagnostics.ts";
import { createParser, SyntaxKind, type ParsedFile, type ts } from "./parse.ts";
import { checkSyntax } from "./syntax.ts";
export * from "./diagnostics.ts";
export * from "./names.ts";

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented`);
    this.name = "NotImplementedError";
  }
}

/** Entry file plus every file reachable through relative static imports, parsed with one tsgo process. */
interface Program {
  files: ParsedFile[];
  /** E7001 for relative imports whose file does not exist (Q009). */
  missing: Diagnostic[];
}

function loadProgram(entryFile: string): Program {
  const parser = createParser();
  const files = new Map<string, ParsedFile>();
  const missing: Diagnostic[] = [];
  try {
    const entry = parser.parse([entryFile]).get(resolve(entryFile));
    if (!entry) throw new Error(`cannot read ${entryFile}`);
    files.set(entry.path, entry);
    let round = [entry];
    while (round.length) { // one parse round per import depth (~1ms each, D007)
      const wanted = new Map<string, { from: ParsedFile; spec: ts.StringLiteral }>();
      for (const pf of round) {
        for (const s of pf.sourceFile.statements) {
          if (s.kind !== SyntaxKind.ImportDeclaration) continue;
          const spec = (s as ts.ImportDeclaration).moduleSpecifier;
          if (spec.kind !== SyntaxKind.StringLiteral) continue;
          const t = (spec as ts.StringLiteral).text;
          if (!/^\.\.?\//.test(t) || !t.endsWith(".ts")) continue; // npm: and malformed specifiers are not loaded
          const p = resolve(dirname(pf.path), t);
          if (!files.has(p) && !wanted.has(p)) wanted.set(p, { from: pf, spec: spec as ts.StringLiteral });
        }
      }
      const got = parser.parse([...wanted.keys()]);
      round = [];
      for (const [p, w] of wanted) {
        const pf = got.get(p);
        if (pf) { files.set(p, pf); round.push(pf); continue; }
        const sf = w.from.sourceFile;
        missing.push({
          code: "E7001", severity: "error", message: `cannot find module '${w.spec.text}'`, file: displayPath(w.from.path),
          range: { start: w.from.position(w.spec.getStart(sf)), end: w.from.position(w.spec.end) },
        });
      }
    }
  } finally {
    parser.close();
  }
  return { files: [...files.values()], missing };
}

const displayPath = (p: string): string => relative(process.cwd(), p) || p;

/** Phases run in order P1 -> P2 -> P3 and stop at the first phase with an error (Q003). Only P1 exists so far. */
export function check(entryFile: string): Diagnostic[] {
  const prog = loadProgram(entryFile);
  const p1 = [...prog.missing, ...prog.files.flatMap((f) => checkSyntax(f, displayPath(f.path)))];
  return p1;
}

export async function run(_entryFile: string): Promise<RunResult> {
  throw new NotImplementedError("run");
}
