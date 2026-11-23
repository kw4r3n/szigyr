// Minimal stdio LSP server (`szigyr lsp`) backed by the resident incremental compiler session.
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Diagnostic, Position, Range } from "./diagnostics.ts";
import { callFns, exprTypes, localOf } from "./expr.ts";
import {
  analyze, check, CLI_NAME, createParser, queryFile,
  type Parser, type QuerySymbol,
} from "./index.ts";
import { SyntaxKind as K, isId, type Node, type ParsedFile, type ts } from "./parse.ts";
import { canonPath, type Module, type Program as Decls, type TypeSym, type ValueSym } from "./modules.ts";
import { hasCap, nonNull, show, unref, type Capability, type ClassSym, type Type } from "./types.ts";

export interface LspOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly parser?: Parser;
}

interface LspPos {
  readonly line: number;
  readonly character: number;
}

interface LspRange {
  readonly start: LspPos;
  readonly end: LspPos;
}

interface LspDiag {
  readonly range: LspRange;
  readonly severity: number;
  readonly code: string;
  readonly source: string;
  readonly message: string;
}

const CAPS: readonly Capability[] = ["Native", "Copy", "Owned", "Send", "Key", "Codec"];

const toLspPos = (p: Position): LspPos => ({
  line: Math.max(0, p.line - 1),
  character: Math.max(0, p.col - 1),
});

const toLspRange = (r: Range): LspRange => ({
  start: toLspPos(r.start),
  end: toLspPos(r.end),
});

const cmpPos = (a: LspPos, b: LspPos): number => (a.line - b.line) || (a.character - b.character);
const rangesOverlap = (a: LspRange, b: LspRange): boolean => cmpPos(a.start, b.end) <= 0 && cmpPos(b.start, a.end) <= 0;

function uriToPath(uri: string): { path: string; canon: string } | undefined {
  if (!uri.startsWith("file:")) return undefined;
  try {
    const abs = resolve(fileURLToPath(uri));
    return { path: abs, canon: canonPath(abs) };
  } catch {
    return undefined;
  }
}

function findNarrowest(node: Node, sf: ts.SourceFile, off: number): Node | undefined {
  if (off < node.getStart(sf) || off > node.end) return undefined;
  let inner: Node | undefined;
  node.forEachChild((child: Node) => {
    if (!inner) inner = findNarrowest(child, sf, off);
  });
  return inner ?? node;
}

function formatSymbolHover(sym: QuerySymbol): string {
  const head = sym.kind === "type" || sym.kind === "class" || sym.kind === "interface"
    ? `${sym.kind} ${sym.name}: ${sym.type}`
    : `${sym.kind} ${sym.name}${sym.type}`;
  const meta: string[] = [];
  if (sym.layer) meta.push(`layer: \`${sym.layer}\``);
  if (sym.unsafe) meta.push("unsafe");
  if (sym.pure !== undefined) meta.push(`pure: \`${sym.pure}\``);
  if (sym.mutatable !== undefined) meta.push(`mutatable: \`${sym.mutatable}\``);
  if (sym.caps?.length) meta.push(`caps: ${sym.caps.map((c) => `\`${c}\``).join(", ")}`);
  const parts = [`\`\`\`ts\n${head}\n\`\`\``];
  if (meta.length) parts.push(meta.join(" · "));
  if (sym.fields?.length) {
    parts.push(sym.fields.map((f) => `- \`${f.readonly ? "readonly " : ""}${f.name}: ${f.type}\``).join("\n"));
  }
  if (sym.methods?.length) {
    parts.push(sym.methods.map((m) => `- \`${m.name}${m.type}\``).join("\n"));
  }
  return parts.join("\n\n");
}

function formatTypeHover(t: Type): string {
  const caps = CAPS.filter((c) => hasCap(t, c));
  const capLine = caps.length ? `\n\ncaps: ${caps.map((c) => `\`${c}\``).join(", ")}` : "";
  return `\`\`\`ts\n${show(t)}\n\`\`\`${capLine}`;
}

function symbolAtDeclName(narrow: Node, sf: ts.SourceFile, symbols: readonly QuerySymbol[], line1: number): QuerySymbol | undefined {
  const p = narrow.parent;
  if (!p) return undefined;
  let targetName: string | undefined;
  if (
    (p.kind === K.FunctionDeclaration || p.kind === K.ClassDeclaration || p.kind === K.InterfaceDeclaration || p.kind === K.TypeAliasDeclaration)
    && (p as { name?: Node }).name === narrow
  ) {
    targetName = narrow.getText(sf);
  } else if (p.kind === K.MethodDeclaration && (p as ts.MethodDeclaration).name === narrow && p.parent?.kind === K.ClassDeclaration) {
    const clsName = (p.parent as ts.ClassDeclaration).name?.getText(sf);
    if (clsName) targetName = `${clsName}.${narrow.getText(sf)}`;
  } else if (p.kind === K.VariableDeclaration && (p as ts.VariableDeclaration).name === narrow) {
    targetName = narrow.getText(sf);
  }
  if (!targetName) return undefined;
  return symbols.find((s) => s.name === targetName && s.range.start.line <= line1 && line1 <= s.range.end.line);
}

function paramHoverType(narrow: Node, decls: ReturnType<typeof analyze>["decls"]): Type | undefined {
  if (!decls || !narrow.parent || narrow.parent.kind !== K.Parameter) return undefined;
  const param = narrow.parent as ts.ParameterDeclaration;
  if (param.name !== narrow) return undefined;
  const fnNode = param.parent;
  if (fnNode.kind === K.FunctionDeclaration) {
    const f = decls.fns.find((x) => x.decl === fnNode);
    const idx = (fnNode as ts.FunctionDeclaration).parameters.indexOf(param);
    return f && idx >= 0 ? f.sig.params[idx] : undefined;
  }
  if (fnNode.kind === K.MethodDeclaration && fnNode.parent?.kind === K.ClassDeclaration) {
    for (const mod of decls.mods) {
      for (const sym of mod.types.values()) {
        if (sym.k === "class" && sym.cls.decl === fnNode.parent) {
          const mName = (fnNode as ts.MethodDeclaration).name;
          if (mName && mName.kind === K.Identifier) {
            const m = sym.cls.methods.get((mName as ts.Identifier).text);
            const idx = (fnNode as ts.MethodDeclaration).parameters.indexOf(param);
            return m && idx >= 0 ? m.sig.params[idx] : undefined;
          }
        }
      }
    }
  }
  return undefined;
}

interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

function offsetInLine(pf: ParsedFile, line1: number, col1: number): number | undefined {
  if (line1 < 1 || col1 < 1) return undefined;
  const off = pf.offsetOf(line1, col1);
  if (off === undefined || off > pf.sourceFile.text.length) return undefined;
  return pf.position(off).line === line1 ? off : undefined;
}

function resolveDefinition(
  decls: Decls,
  mod: Module,
  narrow: Node,
  docUriOf: (path: string) => string,
): LspLocation | null {
  const locOf = (m: Module, n: Node): LspLocation => ({
    uri: docUriOf(m.pf.path),
    range: {
      start: toLspPos(m.pf.position(n.getStart(m.sf))),
      end: toLspPos(m.pf.position(n.end)),
    },
  });
  const fileStart = (m: Module): LspLocation => ({
    uri: docUriOf(m.pf.path),
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  });
  const defOfValue = (sym: ValueSym | undefined, localMod: Module): LspLocation | null => {
    if (!sym) return null;
    switch (sym.k) {
      case "fn": case "cfn": return locOf(sym.mod, sym.decl.name ?? sym.decl);
      case "cconst": return locOf(sym.mod, sym.decl.name);
      case "const": return locOf(sym.mod, sym.bind?.name ?? sym.decl.name);
      case "class": return locOf(sym.mod, sym.cls.decl.name ?? sym.cls.decl);
      case "local": return sym.decl ? locOf(localMod, sym.decl) : null;
      default: return null;
    }
  };
  const defOfType = (sym: TypeSym | undefined): LspLocation | null => {
    if (!sym) return null;
    switch (sym.k) {
      case "alias": case "rec-iface": case "iface": case "cstruct": return locOf(sym.mod, sym.decl.name);
      case "class": return locOf(sym.mod, sym.cls.decl.name ?? sym.cls.decl);
      default: return null;
    }
  };
  const defOfClassMember = (cls: ClassSym, memberName: string): LspLocation | null => {
    const clsMod = decls.mods.find((m) => m.sf === cls.decl.getSourceFile());
    if (!clsMod) return null;
    const entry = cls.methods.get(memberName) ?? cls.fields.get(memberName);
    if (!entry) return null;
    const target = (entry.node as { name?: Node }).name ?? entry.node;
    return locOf(clsMod, target);
  };

  const p = narrow.parent;
  if (
    narrow.kind === K.StringLiteral
    && p
    && (p.kind === K.ImportDeclaration || p.kind === K.ExportDeclaration)
    && (p as ts.ImportDeclaration | ts.ExportDeclaration).moduleSpecifier === narrow
  ) {
    const spec = (narrow as ts.StringLiteral).text;
    const targetCanon = canonPath(dirname(mod.pf.path), spec);
    const targetMod = decls.mods.find((m) => m.pf.path === targetCanon);
    return targetMod ? fileStart(targetMod) : null;
  }

  if (!isId(narrow)) return null;

  if (p?.kind === K.ImportSpecifier) {
    const ispec = p as ts.ImportSpecifier;
    if (ispec.name === narrow || ispec.propertyName === narrow) {
      const imp = mod.imports.get(ispec.name.text);
      if (!imp) return null;
      return defOfValue(decls.lookupExportedValue(imp.mod, imp.name), imp.mod)
        ?? defOfType(decls.lookupExportedType(imp.mod, imp.name));
    }
  }
  if (p?.kind === K.NamespaceImport && (p as ts.NamespaceImport).name === narrow) {
    const ns = mod.nsImports.get(narrow.text);
    return ns ? fileStart(ns.mod) : null;
  }
  if (p?.kind === K.ExportSpecifier) {
    const espec = p as ts.ExportSpecifier;
    if (espec.name === narrow || espec.propertyName === narrow) {
      const exp = mod.exports.get(espec.name.text);
      if (exp?.k === "reexport") {
        return defOfValue(decls.lookupExportedValue(exp.mod, exp.name), exp.mod)
          ?? defOfType(decls.lookupExportedType(exp.mod, exp.name));
      }
      if (exp?.k === "local") {
        return defOfValue(decls.lookupValue(mod, exp.local), mod)
          ?? defOfType(decls.lookupType(mod, exp.local));
      }
    }
  }
  if (p?.kind === K.QualifiedName) {
    const qn = p as ts.QualifiedName;
    if (isId(qn.left)) {
      const ns = mod.nsImports.get(qn.left.text);
      if (ns) {
        if (qn.left === narrow) return fileStart(ns.mod);
        if (qn.right === narrow) return defOfType(decls.lookupExportedType(ns.mod, qn.right.text));
      }
    }
  }
  if (
    (p?.kind === K.TypeReference && (p as ts.TypeReferenceNode).typeName === narrow)
    || (p?.kind === K.ExpressionWithTypeArguments && (p as ts.ExpressionWithTypeArguments).expression === narrow)
  ) {
    return defOfType(decls.lookupType(mod, narrow.text));
  }
  if (p?.kind === K.PropertyAccessExpression && (p as ts.PropertyAccessExpression).name === narrow) {
    const pa = p as ts.PropertyAccessExpression;
    if (isId(pa.expression)) {
      const ns = mod.nsImports.get(pa.expression.text);
      if (ns) {
        return defOfValue(decls.lookupExportedValue(ns.mod, narrow.text), ns.mod)
          ?? defOfType(decls.lookupExportedType(ns.mod, narrow.text));
      }
      const vs = decls.lookupValue(mod, pa.expression.text);
      if (vs?.k === "class") return defOfClassMember(vs.cls, narrow.text);
    }
    const recvT = exprTypes.get(pa.expression);
    const u = recvT ? unref(nonNull(unref(recvT)) ?? unref(recvT)) : undefined;
    if (u?.k === "class") return defOfClassMember(u.cls, narrow.text);
    const callNode = pa.parent?.kind === K.CallExpression && (pa.parent as ts.CallExpression).expression === pa ? pa.parent : undefined;
    const cf = callNode ? callFns.get(callNode) : undefined;
    return cf ? defOfValue(cf, cf.mod) : null;
  }

  const locSym = localOf.get(narrow);
  if (locSym) return defOfValue(locSym, mod);

  const ns = mod.nsImports.get(narrow.text);
  if (ns) return fileStart(ns.mod);

  return defOfValue(decls.lookupValue(mod, narrow.text), mod)
    ?? defOfType(decls.lookupType(mod, narrow.text));
}

const SYMBOL_KIND: Record<QuerySymbol["kind"], number> = {
  function: 12,
  cfn: 12,
  const: 14,
  type: 23,
  class: 5,
  method: 6,
  interface: 11,
};

/** Runs the stdio JSON-RPC 2.0 LSP server until `exit` notification or stdin EOF. */
export async function serveLsp(opts: LspOptions = {}): Promise<number> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const parser = opts.parser ?? createParser();
  const ownParser = !opts.parser;

  const openDocs = new Map<string, { uri: string; path: string }>();
  const diagCache = new Map<string, { raw: Diagnostic[]; lsp: LspDiag[] }>();

  let shutdownRequested = false;
  let exitCode: number | undefined;
  let resolveDone!: (code: number) => void;
  const doneP = new Promise<number>((r) => { resolveDone = r; });

  const send = (msg: unknown): void => {
    const json = JSON.stringify(msg);
    const body = Buffer.from(json, "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`, "ascii");
    output.write(Buffer.concat([header, body]));
  };

  const publishFor = (doc: { uri: string; path: string }, canon: string): void => {
    const all = check(doc.path, parser);
    const mine = all.filter((d) => {
      try { return canonPath(d.file) === canon; } catch { return resolve(d.file) === doc.path; }
    });
    const lsp: LspDiag[] = mine.map((d) => ({
      range: toLspRange(d.range),
      severity: d.severity === "warning" ? 2 : 1,
      code: d.code,
      source: CLI_NAME,
      message: d.message,
    }));
    diagCache.set(canon, { raw: mine, lsp });
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: doc.uri, diagnostics: lsp } });
  };

  const refreshOpenDocs = (priorityCanon?: string): void => {
    if (priorityCanon) {
      const first = openDocs.get(priorityCanon);
      if (first) publishFor(first, priorityCanon);
    }
    for (const [canon, doc] of openDocs) {
      if (canon !== priorityCanon) publishFor(doc, canon);
    }
  };

  const handleRequest = (method: string, params: Record<string, unknown> | undefined): unknown => {
    switch (method) {
      case "initialize":
        return {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
            hoverProvider: true,
            definitionProvider: true,
            codeActionProvider: { codeActionKinds: ["quickfix"] },
            documentSymbolProvider: true,
          },
          serverInfo: { name: CLI_NAME, version: "1.0.0" },
        };
      case "shutdown":
        shutdownRequested = true;
        return null;
      case "textDocument/hover": {
        const td = params?.textDocument as { uri?: string } | undefined;
        const pos = params?.position as LspPos | undefined;
        const loc = typeof td?.uri === "string" ? uriToPath(td.uri) : undefined;
        if (!loc || !pos) return null;
        const a = analyze(loc.path, parser);
        const pf: ParsedFile | undefined = a.files.find((f) => canonPath(f.path) === loc.canon);
        if (!pf) return null;
        const line1 = pos.line + 1;
        const col1 = pos.character + 1;
        const off = pf.offsetOf(line1, col1);
        if (off === undefined) return null;
        const narrow = findNarrowest(pf.sourceFile, pf.sourceFile, off);
        if (!narrow) return null;

        const q = queryFile(loc.path, parser);
        const sym = symbolAtDeclName(narrow, pf.sourceFile, q.symbols, line1);
        if (sym) {
          return {
            contents: { kind: "markdown", value: formatSymbolHover(sym) },
            range: {
              start: toLspPos(pf.position(narrow.getStart(pf.sourceFile))),
              end: toLspPos(pf.position(narrow.end)),
            },
          };
        }

        const pType = paramHoverType(narrow, a.decls);
        if (pType && pType.k !== "error") {
          return {
            contents: { kind: "markdown", value: formatTypeHover(pType) },
            range: {
              start: toLspPos(pf.position(narrow.getStart(pf.sourceFile))),
              end: toLspPos(pf.position(narrow.end)),
            },
          };
        }

        let cur: Node | undefined = narrow;
        while (cur && cur.kind !== K.SourceFile && cur.kind !== K.Block) {
          const hit = exprTypes.get(cur);
          if (hit && hit.k !== "error") {
            return {
              contents: { kind: "markdown", value: formatTypeHover(hit) },
              range: {
                start: toLspPos(pf.position(cur.getStart(pf.sourceFile))),
                end: toLspPos(pf.position(cur.end)),
              },
            };
          }
          cur = cur.parent;
        }
        return null;
      }
      case "textDocument/definition": {
        const td = params?.textDocument as { uri?: string } | undefined;
        const pos = params?.position as LspPos | undefined;
        const loc = typeof td?.uri === "string" ? uriToPath(td.uri) : undefined;
        if (!loc || !pos) return null;
        const a = analyze(loc.path, parser);
        if (!a.decls) return null;
        const pf = a.files.find((f) => canonPath(f.path) === loc.canon);
        const mod = pf ? a.decls.mods.find((m) => m.pf.path === pf.path) : undefined;
        if (!pf || !mod) return null;
        const off = offsetInLine(pf, pos.line + 1, pos.character + 1);
        if (off === undefined) return null;
        const narrow = findNarrowest(pf.sourceFile, pf.sourceFile, off);
        if (!narrow) return null;
        return resolveDefinition(a.decls, mod, narrow, (p) => openDocs.get(canonPath(p))?.uri ?? pathToFileURL(p).href);
      }
      case "textDocument/codeAction": {
        const td = params?.textDocument as { uri?: string } | undefined;
        const reqRange = params?.range as LspRange | undefined;
        const uri = td?.uri;
        const loc = typeof uri === "string" ? uriToPath(uri) : undefined;
        if (!loc || !uri || !reqRange) return [];
        const doc = openDocs.get(loc.canon) ?? { uri, path: loc.path };
        if (!diagCache.has(loc.canon)) publishFor(doc, loc.canon);
        const cached = diagCache.get(loc.canon);
        if (!cached) return [];
        const actions: unknown[] = [];
        for (let i = 0; i < cached.raw.length; i++) {
          const raw = cached.raw[i]!;
          const lsp = cached.lsp[i]!;
          if (!raw.fixes?.length || !rangesOverlap(lsp.range, reqRange)) continue;
          for (const fix of raw.fixes) {
            if (!fix.edits.length) continue;
            actions.push({
              title: fix.title,
              kind: "quickfix",
              diagnostics: [lsp],
              isPreferred: true,
              edit: {
                changes: {
                  [uri]: fix.edits.map((e) => ({ range: toLspRange(e.range), newText: e.newText })),
                },
              },
            });
          }
        }
        return actions;
      }
      case "textDocument/documentSymbol": {
        const td = params?.textDocument as { uri?: string } | undefined;
        const loc = typeof td?.uri === "string" ? uriToPath(td.uri) : undefined;
        if (!loc) return [];
        const q = queryFile(loc.path, parser);
        const byClass = new Map<string, { name: string; detail: string; kind: number; range: LspRange; selectionRange: LspRange; children: unknown[] }>();
        const top: { name: string; detail: string; kind: number; range: LspRange; selectionRange: LspRange; children?: unknown[] }[] = [];
        for (const s of q.symbols) {
          const r = toLspRange(s.range);
          if (s.kind === "method") {
            const [clsName, mName] = s.name.split(".", 2);
            const clsNode = clsName ? byClass.get(clsName) : undefined;
            if (clsNode && mName) {
              clsNode.children.push({ name: mName, detail: s.type, kind: SYMBOL_KIND.method, range: r, selectionRange: r });
              continue;
            }
          }
          const node = {
            name: s.name,
            detail: s.type,
            kind: SYMBOL_KIND[s.kind],
            range: r,
            selectionRange: r,
            ...(s.kind === "class" ? { children: [] as unknown[] } : {}),
          };
          if (s.kind === "class") byClass.set(s.name, node as typeof node & { children: unknown[] });
          top.push(node);
        }
        return top;
      }
      default:
        throw { code: -32601, message: `method not found: ${method}` };
    }
  };

  const handleNotification = (method: string, params: Record<string, unknown> | undefined): void => {
    if (method === "textDocument/didOpen") {
      const td = params?.textDocument as { uri?: string; text?: string } | undefined;
      const uri = td?.uri;
      const text = td?.text;
      const loc = typeof uri === "string" ? uriToPath(uri) : undefined;
      if (!loc || typeof uri !== "string" || typeof text !== "string") return;
      openDocs.set(loc.canon, { uri, path: loc.path });
      parser.setOverlay?.(loc.path, text);
      refreshOpenDocs(loc.canon);
      return;
    }
    if (method === "textDocument/didChange") {
      const td = params?.textDocument as { uri?: string } | undefined;
      const uri = td?.uri;
      const changes = params?.contentChanges as { text?: string }[] | undefined;
      const loc = typeof uri === "string" ? uriToPath(uri) : undefined;
      const last = changes?.at(-1);
      if (!loc || typeof uri !== "string" || typeof last?.text !== "string") return;
      openDocs.set(loc.canon, { uri, path: loc.path });
      parser.setOverlay?.(loc.path, last.text);
      refreshOpenDocs(loc.canon);
      return;
    }
    if (method === "textDocument/didSave") {
      const td = params?.textDocument as { uri?: string; text?: string } | undefined;
      const loc = typeof td?.uri === "string" ? uriToPath(td.uri) : undefined;
      if (!loc) return;
      if (typeof td?.text === "string") parser.setOverlay?.(loc.path, td.text);
      refreshOpenDocs(loc.canon);
      return;
    }
    if (method === "textDocument/didClose") {
      const td = params?.textDocument as { uri?: string } | undefined;
      const loc = typeof td?.uri === "string" ? uriToPath(td.uri) : undefined;
      if (!loc) return;
      const existing = openDocs.get(loc.canon);
      openDocs.delete(loc.canon);
      diagCache.delete(loc.canon);
      parser.clearOverlay?.(loc.path);
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: existing?.uri ?? td!.uri!, diagnostics: [] } });
      refreshOpenDocs();
      return;
    }
    if (method === "exit") {
      exitCode = shutdownRequested ? 0 : 1;
      finish();
    }
  };

  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", onEnd);
    input.pause();
    if ("unref" in input && typeof (input as { unref?: () => void }).unref === "function") {
      (input as { unref: () => void }).unref();
    }
    if (ownParser) parser.close();
    resolveDone(exitCode ?? (shutdownRequested ? 0 : 0));
  };

  let buf = Buffer.alloc(0);
  let queue: Promise<void> = Promise.resolve();

  const dispatchMessage = (raw: string): void => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return;
    const method = msg.method;
    const params = msg.params as Record<string, unknown> | undefined;
    if ("id" in msg && msg.id !== undefined) {
      const id = msg.id;
      try {
        const result = handleRequest(method, params);
        send({ jsonrpc: "2.0", id, result });
      } catch (e) {
        const errObj = e && typeof e === "object" && "code" in e && "message" in e
          ? { code: Number((e as { code: unknown }).code), message: String((e as { message: unknown }).message) }
          : { code: -32603, message: e instanceof Error ? e.message : String(e) };
        send({ jsonrpc: "2.0", id, error: errObj });
      }
    } else {
      handleNotification(method, params);
    }
  };

  const onData = (chunk: Buffer | string): void => {
    const piece = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    buf = Buffer.concat([buf, piece]);
    while (true) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) break;
      const header = buf.subarray(0, sep).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        buf = buf.subarray(sep + 4);
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = sep + 4;
      if (buf.length < bodyStart + len) break;
      const body = buf.subarray(bodyStart, bodyStart + len).toString("utf8");
      buf = buf.subarray(bodyStart + len);
      queue = queue.then(() => { if (!closed) dispatchMessage(body); });
    }
  };

  const onEnd = (): void => {
    void queue.finally(finish);
  };

  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onEnd);
  return await doneP;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await serveLsp();
}
