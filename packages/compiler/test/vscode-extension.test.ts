import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const EXT_DIR = resolve(import.meta.dirname, "../../../editors/vscode");
const CLI_PATH = resolve(import.meta.dirname, "../src/cli.ts");

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("editors/vscode minimal viewing extension", () => {
  it("ships valid manifest, language configuration, and regex-clean TextMate grammar", () => {
    const pkg = JSON.parse(readFileSync(join(EXT_DIR, "package.json"), "utf8")) as Record<string, any>;
    expect(pkg.main).toBe("./extension.js");
    expect(pkg.contributes.languages[0].extensions).toContain(".szigyr");
    expect(pkg.contributes.grammars[0].scopeName).toBe("source.szigyr");
    expect(pkg.dependencies).toBeUndefined();

    const langCfg = JSON.parse(readFileSync(join(EXT_DIR, "language-configuration.json"), "utf8")) as Record<string, any>;
    expect(langCfg.comments.lineComment).toBe("//");

    const tm = JSON.parse(readFileSync(join(EXT_DIR, "syntaxes/szigyr.tmLanguage.json"), "utf8")) as Record<string, any>;
    expect(tm.scopeName).toBe("source.szigyr");
    const checkPatterns = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) checkPatterns(x); return; }
      const obj = node as Record<string, unknown>;
      for (const k of ["match", "begin", "end"]) {
        if (typeof obj[k] === "string") expect(() => new RegExp(obj[k] as string)).not.toThrow();
      }
      for (const v of Object.values(obj)) checkPatterns(v);
    };
    checkPatterns(tm.repository);
  });

  it("drives szigyr lsp for diagnostics, hover, cross-file definition, documentSymbol, quickfix codeActions, and clean shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "szigyr-vsc-"));
    tmpDirs.push(dir);
    const libPath = join(dir, "lib.szigyr");
    const mainPath = join(dir, "main.szigyr");
    writeFileSync(libPath, `export function addOne(n: i32): i32 {\n  "use rt";\n  return n + 1;\n}\n`);
    writeFileSync(
      mainPath,
      [
        `import { addOne } from "./lib.szigyr";`,
        `export function main(sys: System): void {`,
        `  const v: i32 = addOne(2);`,
        `  if (v == 3) {`,
        `    sys.log.info(\`v=\${v}\`);`,
        `  }`,
        `}`,
        ``,
      ].join("\n"),
    );

    class Position {
      readonly line: number;
      readonly character: number;
      constructor(line: number, character: number) { this.line = line; this.character = character; }
    }
    class Range {
      readonly start: Position;
      readonly end: Position;
      constructor(start: Position, end: Position) { this.start = start; this.end = end; }
    }
    class Location {
      readonly uri: { toString(): string; fsPath: string };
      readonly range: Range;
      constructor(uri: { toString(): string; fsPath: string }, range: Range) { this.uri = uri; this.range = range; }
    }
    class MarkdownString { readonly value: string; constructor(value: string) { this.value = value; } }
    class Hover {
      readonly contents: MarkdownString;
      readonly range?: Range;
      constructor(contents: MarkdownString, range?: Range) { this.contents = contents; this.range = range; }
    }
    class DocumentSymbol {
      readonly name: string;
      readonly detail: string;
      readonly kind: number;
      readonly range: Range;
      readonly selectionRange: Range;
      children: DocumentSymbol[] = [];
      constructor(name: string, detail: string, kind: number, range: Range, selectionRange: Range) {
        this.name = name; this.detail = detail; this.kind = kind; this.range = range; this.selectionRange = selectionRange;
      }
    }
    class Diagnostic {
      readonly range: Range;
      readonly message: string;
      readonly severity: number;
      code?: unknown;
      source?: string;
      constructor(range: Range, message: string, severity: number) { this.range = range; this.message = message; this.severity = severity; }
    }
    class WorkspaceEdit {
      readonly edits: { uri: string; range: Range; newText: string }[] = [];
      replace(uri: { toString(): string }, range: Range, newText: string) {
        this.edits.push({ uri: uri.toString(), range, newText });
      }
    }
    class CodeAction {
      readonly title: string;
      readonly kind: string;
      isPreferred = false;
      edit?: WorkspaceEdit;
      constructor(title: string, kind: string) { this.title = title; this.kind = kind; }
    }

    const mkUri = (fsPath: string) => ({
      fsPath,
      toString: () => pathToFileURL(fsPath).href,
    });
    const docs = [libPath, mainPath].map((p) => {
      let text = readFileSync(p, "utf8");
      return {
        languageId: "szigyr",
        version: 1,
        uri: mkUri(p),
        getText: () => text,
        setText: (next: string) => { text = next; },
      };
    });

    const diagStore = new Map<string, Diagnostic[]>();
    const diagWaiters: (() => void)[] = [];
    const waitForDiag = (uriStr: string, pred: (list: Diagnostic[]) => boolean): Promise<Diagnostic[]> => {
      const cur = diagStore.get(uriStr);
      if (cur && pred(cur)) return Promise.resolve(cur);
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`Timeout waiting for diagnostics on ${uriStr}`)), 10_000);
        const check = () => {
          const v = diagStore.get(uriStr);
          if (v && pred(v)) { clearTimeout(timer); res(v); }
        };
        diagWaiters.push(check);
      });
    };

    const listeners: Record<string, ((e: any) => void)[]> = {};
    const providers: Record<string, any> = {};
    const mockVscode = {
      Position,
      Range,
      Location,
      MarkdownString,
      Hover,
      DocumentSymbol,
      Diagnostic,
      WorkspaceEdit,
      CodeAction,
      CodeActionKind: { QuickFix: "quickfix" },
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
      SymbolKind: { Class: 4, Method: 5, Interface: 10, Function: 11, Constant: 13, Struct: 22, Variable: 12 },
      Uri: {
        file: (p: string) => mkUri(p),
        parse: (u: string) => mkUri(new URL(u).pathname),
      },
      workspace: {
        workspaceFolders: [{ uri: mkUri(dir) }],
        textDocuments: docs,
        getConfiguration: () => ({
          get: (k: string) => (k === "enable" ? true : k === "command" ? CLI_PATH : ["lsp"]),
        }),
        onDidOpenTextDocument: (fn: (d: any) => void) => ((listeners.open ??= []).push(fn), { dispose() {} }),
        onDidChangeTextDocument: (fn: (e: any) => void) => ((listeners.change ??= []).push(fn), { dispose() {} }),
        onDidSaveTextDocument: (fn: (d: any) => void) => ((listeners.save ??= []).push(fn), { dispose() {} }),
        onDidCloseTextDocument: (fn: (d: any) => void) => ((listeners.close ??= []).push(fn), { dispose() {} }),
      },
      languages: {
        createDiagnosticCollection: () => ({
          set: (uri: { toString(): string }, list: Diagnostic[]) => {
            diagStore.set(uri.toString(), list);
            for (const fn of [...diagWaiters]) fn();
          },
          delete: (uri: { toString(): string }) => { diagStore.delete(uri.toString()); },
          dispose: () => {},
        }),
        registerHoverProvider: (_sel: any, p: any) => ((providers.hover = p), { dispose() {} }),
        registerDefinitionProvider: (_sel: any, p: any) => ((providers.definition = p), { dispose() {} }),
        registerDocumentSymbolProvider: (_sel: any, p: any) => ((providers.symbols = p), { dispose() {} }),
        registerCodeActionsProvider: (_sel: any, p: any) => ((providers.codeAction = p), { dispose() {} }),
      },
    };

    const { createExtension } = require(join(EXT_DIR, "extension.js")) as { createExtension: (v: unknown) => { activate: (ctx: { subscriptions: unknown[] }) => void; deactivate: () => Promise<number> } };
    const ext = createExtension(mockVscode);
    const context = { subscriptions: [] as unknown[] };
    ext.activate(context);

    try {
      const mainDoc = docs[1]!;
      const mainDiags = await waitForDiag(mainDoc.uri.toString(), (list) => list.some((d) => d.code === "E1002"));
      expect(mainDiags.map((d) => d.code)).toContain("E1002");

      const hover = await providers.hover.provideHover(mainDoc, new Position(1, 17)); // `main`
      expect(hover.contents.value).toContain("function main");

      const def = await providers.definition.provideDefinition(mainDoc, new Position(2, 18)); // `addOne`
      expect(def.uri.fsPath).toBe(libPath);
      expect(def.range.start.line).toBe(0);
      expect(def.range.start.character).toBe(16);

      const syms = await providers.symbols.provideDocumentSymbols(mainDoc);
      expect(syms.some((s: DocumentSymbol) => s.name === "main")).toBe(true);

      const actions = await providers.codeAction.provideCodeActions(
        mainDoc,
        mainDiags[0]!.range,
        { diagnostics: [mainDiags[0]!] },
      );
      expect(actions.length).toBeGreaterThanOrEqual(1);
      expect(actions[0].edit.edits.some((e: { newText: string }) => e.newText.includes("==="))).toBe(true);
    } finally {
      const code = await ext.deactivate();
      expect(code).toBe(0);
    }
  });
});
