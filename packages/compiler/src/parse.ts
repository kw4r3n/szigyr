// The only module that imports typescript. Uses typescript 7's unstable sync API (see DECISIONS D005):
// a tsgo child process parses; we never call the checker or semantic diagnostics.
import { resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { LanguageVariant, SyntaxKind, type Node, type SourceFile } from "typescript/unstable/ast";
import { createScanner } from "typescript/unstable/ast/scanner";
import type { Position } from "./diagnostics.ts";

export type { Node, SourceFile };
export { SyntaxKind };

export interface SyntaxError { start: number; end: number; code: number; message: string }

export interface ParsedFile {
  path: string;
  sourceFile: SourceFile;
  syntaxErrors: SyntaxError[];
  /** UTF-16 offset -> 1-based line/col. */
  position(offset: number): Position;
  /** 1-based line/col -> offset, or undefined when outside the file. */
  offsetOf(line: number, col: number): number | undefined;
  /** True when offset is where some token (scanner token or AST node) starts. */
  isTokenStart(offset: number): boolean;
}

/** Parse in-memory sources keyed by path (resolved to absolute). Synchronous; spawns and closes one child process. */
export function parseSources(sources: Record<string, string>): Map<string, ParsedFile> {
  const abs: Record<string, string> = {};
  for (const [p, t] of Object.entries(sources)) abs[resolve(p)] = t;
  const names = Object.keys(abs);
  const out = new Map<string, ParsedFile>();
  if (!names.length) return out;
  const api = new API({ cwd: process.cwd(), fs: createVirtualFileSystem(abs) });
  try {
    const program = api.updateSnapshot({ openFiles: names }).getDefaultProjectForFile(names[0]!)!.program;
    for (const p of names) {
      const sf = program.getSourceFile(p);
      if (!sf) throw new Error(`parse: no source file for ${p}`);
      const syntaxErrors = program.getSyntacticDiagnostics(p).map((d) => ({ start: d.pos, end: d.end, code: d.code, message: d.text }));
      out.set(p, wrap(p, sf, syntaxErrors));
    }
  } finally {
    api.close();
  }
  return out;
}

function wrap(path: string, sf: SourceFile, syntaxErrors: SyntaxError[]): ParsedFile {
  let starts: Set<number> | undefined;
  return {
    path, sourceFile: sf, syntaxErrors,
    position(offset) {
      const p = sf.getLineAndCharacterOfPosition(offset);
      return { line: p.line + 1, col: p.character + 1 };
    },
    offsetOf(line, col) {
      const ls = sf.getLineStarts();
      return line >= 1 && line <= ls.length ? ls[line - 1]! + col - 1 : undefined;
    },
    isTokenStart(offset) {
      if (!starts) {
        starts = new Set();
        const sc = createScanner(true, LanguageVariant.Standard, sf.text);
        while (sc.scan() !== SyntaxKind.EndOfFile) starts.add(sc.getTokenStart());
        // shortcut: the plain scanner mis-tokenizes template continuations; AST starts cover those. Revisit if templates need exact tokens.
        const walk = (n: Node): void => { starts!.add(n.getStart(sf)); n.forEachChild(walk); };
        walk(sf);
      }
      return starts.has(offset);
    },
  };
}
