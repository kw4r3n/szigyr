// The only module that imports typescript. Uses typescript 7's unstable sync API (see DECISIONS D005):
// a tsgo child process parses; we never call the checker or semantic diagnostics.
import { realpathSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { API, type Snapshot } from "typescript/unstable/sync";
import { type FileSystem } from "typescript/unstable/fs";
import { LanguageVariant, NodeFlags, SyntaxKind, type Identifier, type InterfaceDeclaration, type ModifierLike, type NodeArray, type Node, type ParameterDeclaration, type SourceFile } from "typescript/unstable/ast";
import { createScanner } from "typescript/unstable/ast/scanner";
import type { Position } from "./diagnostics.ts";

export type { Node, SourceFile };
export type * as ts from "typescript/unstable/ast";
export { NodeFlags, SyntaxKind };

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
  /** Start of the first token at or after offset (skips trivia). For tokens the AST has no node for (`as`, `satisfies`). */
  tokenAfter(offset: number): number;
}

/** One tsgo process for several parse rounds (one check or resident session). Paths not in `sources` are read from disk/overlays. */
export interface Parser {
  /** Parse more files (absolute or relative paths). Missing files are absent from the result. */
  parse(paths: string[]): Map<string, ParsedFile>;
  /** Clears JS-side AST cache at the start of an analysis pass so every node is fresh (no stale WeakMap entries). */
  beginRun?(): void;
  /** Reads current source text (in-memory sources/overlay if set, otherwise disk). */
  readText?(path: string): string | undefined;
  /** Sets or clears an in-memory buffer override (used by editors/MCP). */
  setOverlay?(path: string, content: string): void;
  clearOverlay?(path?: string): void;
  /** Drops tracked files so subsequent parse() rounds do not accumulate open files in tsgo. */
  evict?(): void;
  close(): void;
}

const normPath = (p: string): string => {
  const r = resolve(p);
  try { return realpathSync(r); } catch { return r; }
};

function readDisk(p: string): string | undefined {
  try { return statSync(p).isFile() ? readFileSync(p, "utf8") : undefined; }
  catch { return undefined; }
}

export function createParser(sources?: Record<string, string>): Parser {
  const abs: Record<string, string> = {};
  for (const [p, t] of Object.entries(sources ?? {})) abs[resolve(p)] = t;
  const overlays = new Map<string, string>();
  const vfsFiles = new Map<string, string>();
  const entries = new Map<string, { vp: string; text: string }>();
  const pendingClose: string[] = [];
  const fs: FileSystem = {
    readFile: (f) => (vfsFiles.has(f) ? vfsFiles.get(f)! : undefined),
    fileExists: (f) => (vfsFiles.has(f) ? true : undefined),
  };
  let api: API | undefined;
  let snap: Snapshot | undefined;
  let seq = 0;

  const readText = (raw: string): string | undefined => {
    const p = resolve(raw);
    if (sources) return abs[p];
    return overlays.get(normPath(p)) ?? overlays.get(p) ?? readDisk(p);
  };

  return {
    readText,
    beginRun() {
      api?.clearSourceFileCache();
    },
    setOverlay(path, content) {
      overlays.set(normPath(path), content);
    },
    clearOverlay(path) {
      if (path === undefined) overlays.clear();
      else { overlays.delete(normPath(path)); overlays.delete(resolve(path)); }
    },
    evict() {
      for (const cur of entries.values()) {
        pendingClose.push(cur.vp);
        vfsFiles.delete(cur.vp);
      }
      entries.clear();
    },
    parse(paths) {
      const out = new Map<string, ParsedFile>();
      const want = paths.map((p) => resolve(p));
      if (!want.length) return out;
      const openFiles: string[] = [];
      const closeFiles: string[] = pendingClose.splice(0);
      for (const p of want) {
        const text = readText(p);
        const cur = entries.get(p);
        if (text === undefined) {
          if (cur) {
            closeFiles.push(cur.vp);
            vfsFiles.delete(cur.vp);
            entries.delete(p);
          }
          continue;
        }
        if (!cur || cur.text !== text) {
          // Monotonic virtual `.ts` paths avoid Go-side cache collisions across delete/recreate cycles and re-parse in ~1ms.
          const vp = `${p}@${++seq}.ts`;
          if (cur) {
            closeFiles.push(cur.vp);
            vfsFiles.delete(cur.vp);
          }
          vfsFiles.set(vp, text);
          openFiles.push(vp);
          entries.set(p, { vp, text });
        }
      }
      if (openFiles.length || closeFiles.length || (!snap && entries.size > 0)) {
        api ??= new API({ cwd: process.cwd(), fs });
        snap?.dispose();
        snap = api.updateSnapshot({
          ...(openFiles.length ? { openFiles } : {}),
          ...(closeFiles.length ? { closeFiles, fileChanges: { deleted: closeFiles } } : {}),
        });
      }
      if (!snap) return out;
      for (const p of want) {
        const cur = entries.get(p);
        if (!cur) continue;
        const program = snap.getDefaultProjectForFile(cur.vp)?.program;
        const sf = program?.getSourceFile(cur.vp);
        if (!program || !sf) continue;
        const syntaxErrors = program.getSyntacticDiagnostics(cur.vp).map((d) => ({ start: d.pos, end: d.end, code: d.code, message: d.text }));
        out.set(p, wrap(p, sf, syntaxErrors));
      }
      return out;
    },
    close() {
      snap?.dispose();
      snap = undefined;
      // Q318: api.close() sends SIGTERM, and the child can answer it by writing "context canceled" to the stderr it inherited. SIGKILL first: nothing is left to flush.
      // shortcut: reaches the client's private fields (typescript 7.0.2); if they move this does nothing, drop it once close() is silent upstream
      try { (api as unknown as { client?: { channel?: { child?: { kill(signal: string): boolean } } } } | undefined)?.client?.channel?.child?.kill("SIGKILL"); } catch { /* already gone */ }
      api?.close();
      api = undefined;
      vfsFiles.clear();
      entries.clear();
      pendingClose.length = 0;
      overlays.clear();
    },
  };
}

/** Parse in-memory sources keyed by path (resolved to absolute). Synchronous; spawns and closes one child process. */
export function parseSources(sources: Record<string, string>): Map<string, ParsedFile> {
  const parser = createParser(sources);
  try {
    const out = parser.parse(Object.keys(sources));
    for (const p of Object.keys(sources)) if (!out.has(resolve(p))) throw new Error(`parse: no source file for ${p}`);
    return out;
  } finally {
    parser.close();
  }
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
      if (line < 1 || line > ls.length || col < 1) return undefined;
      const start = ls[line - 1]!;
      let end = line < ls.length ? ls[line]! : sf.text.length;
      if (line < ls.length) {
        if (end > start && sf.text.charCodeAt(end - 1) === 10) end--;
        if (end > start && sf.text.charCodeAt(end - 1) === 13) end--;
      }
      const off = start + col - 1;
      return off <= end ? off : undefined;
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
    tokenAfter(offset) {
      const sc = createScanner(true, LanguageVariant.Standard, sf.text, offset);
      sc.scan();
      return sc.getTokenStart();
    },
  };
}

export const isId = (n: Node | undefined): n is Identifier => n?.kind === SyntaxKind.Identifier;
export const hasMod = (n: Node, k: SyntaxKind): boolean => !!(n as Node & { modifiers?: NodeArray<ModifierLike> }).modifiers?.some((m) => m.kind === k);
export const isParamProp = (p: ParameterDeclaration): boolean =>
  hasMod(p, SyntaxKind.PrivateKeyword) || hasMod(p, SyntaxKind.PublicKeyword) || hasMod(p, SyntaxKind.ReadonlyKeyword);
export const isRecordInterface = (d: InterfaceDeclaration): boolean =>
  !d.members.some((m) => m.kind === SyntaxKind.MethodSignature) &&
  (d.members.some((m) => m.kind === SyntaxKind.PropertySignature) || !!d.heritageClauses?.length);
