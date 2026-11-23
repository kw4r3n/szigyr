"use strict";
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function loadDefaultVscode() {
  try {
    return require("vscode");
  } catch {
    return undefined;
  }
}

function findWorkspaceCli(startDir) {
  let cur = startDir ? resolve(startDir) : undefined;
  while (cur) {
    const candidate = join(cur, "packages", "compiler", "src", "cli.ts");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

function createExtension(vscodeApi) {
  const vscode = vscodeApi ?? loadDefaultVscode();
  let client = undefined;

  const toLspPos = (pos) => ({ line: pos.line, character: pos.character });
  const toVsPos = (pos) => new vscode.Position(pos.line, pos.character);
  const toVsRange = (r) => new vscode.Range(toVsPos(r.start), toVsPos(r.end));

  const mapSeverity = (sev) => {
    switch (sev) {
      case 2: return vscode.DiagnosticSeverity.Warning;
      case 3: return vscode.DiagnosticSeverity.Information;
      case 4: return vscode.DiagnosticSeverity.Hint;
      default: return vscode.DiagnosticSeverity.Error;
    }
  };

  const mapSymbolKind = (kind) => {
    switch (kind) {
      case 5: return vscode.SymbolKind.Class;
      case 6: return vscode.SymbolKind.Method;
      case 11: return vscode.SymbolKind.Interface;
      case 12: return vscode.SymbolKind.Function;
      case 14: return vscode.SymbolKind.Constant;
      case 23: return vscode.SymbolKind.Struct;
      default: return vscode.SymbolKind.Variable;
    }
  };

  const mapDocumentSymbol = (s) => {
    const sym = new vscode.DocumentSymbol(
      s.name,
      s.detail ?? "",
      mapSymbolKind(s.kind),
      toVsRange(s.range),
      toVsRange(s.selectionRange ?? s.range),
    );
    if (Array.isArray(s.children) && s.children.length) {
      sym.children = s.children.map(mapDocumentSymbol);
    }
    return sym;
  };

  class SzigyrLspClient {
    constructor(command, args, cwd, diagCollection) {
      this.diagCollection = diagCollection;
      this.seq = 1;
      this.pending = new Map();
      this.chunks = [];
      this.bufferedBytes = 0;
      this.disposed = false;
      this.proc = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      this.proc.stdout.on("data", (chunk) => this.onData(chunk));
      this.proc.on("exit", () => this.rejectAll(new Error("szigyr lsp exited")));
      this.proc.on("error", (err) => this.rejectAll(err));
      this.exitP = new Promise((r) => this.proc.once("close", (code) => r(code ?? 0)));
      this.readyP = this.initialize(cwd);
    }

    async initialize(cwd) {
      const rootUri = cwd ? vscode.Uri.file(cwd).toString() : null;
      await this.requestRaw("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: false },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix"] } } },
          },
        },
      });
      this.notifyRaw("initialized", {});
    }

    rejectAll(err) {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    }

    writeFrame(payload) {
      if (this.disposed || !this.proc.stdin.writable) return;
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      const hdr = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
      this.proc.stdin.write(Buffer.concat([hdr, body]));
    }

    requestRaw(method, params) {
      const id = this.seq++;
      return new Promise((resolveReq, rejectReq) => {
        this.pending.set(id, { resolve: resolveReq, reject: rejectReq });
        this.writeFrame({ jsonrpc: "2.0", id, method, params });
      });
    }

    async request(method, params) {
      await this.readyP;
      if (this.disposed) return null;
      return await this.requestRaw(method, params);
    }

    notifyRaw(method, params) {
      this.writeFrame({ jsonrpc: "2.0", method, params });
    }

    async notify(method, params) {
      await this.readyP;
      if (!this.disposed) this.notifyRaw(method, params);
    }

    onData(chunk) {
      const piece = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      this.chunks.push(piece);
      this.bufferedBytes += piece.length;
      let buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.bufferedBytes);
      let consumed = false;
      while (true) {
        const sep = buf.indexOf("\r\n\r\n");
        if (sep < 0) {
          if (buf.length > MAX_HEADER_BYTES) buf = Buffer.alloc(0);
          break;
        }
        const header = buf.subarray(0, sep).toString("ascii");
        const m = /^content-length:\s*(\d+)\s*$/im.exec(header);
        if (!m) {
          buf = buf.subarray(sep + 4);
          consumed = true;
          continue;
        }
        const len = Number(m[1]);
        if (!Number.isSafeInteger(len) || len < 0 || len > MAX_BODY_BYTES) {
          buf = buf.subarray(sep + 4);
          consumed = true;
          continue;
        }
        const bodyStart = sep + 4;
        if (buf.length < bodyStart + len) break;
        const body = buf.subarray(bodyStart, bodyStart + len).toString("utf8");
        buf = buf.subarray(bodyStart + len);
        consumed = true;
        this.handleMessage(body);
      }
      if (consumed || buf.length === 0) {
        this.chunks = buf.length ? [buf] : [];
        this.bufferedBytes = buf.length;
      } else if (this.chunks.length > 1) {
        this.chunks = [buf];
      }
    }

    handleMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if ("id" in msg && msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "LSP error"));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === "textDocument/publishDiagnostics" && msg.params) {
        const uri = vscode.Uri.parse(msg.params.uri);
        const list = (msg.params.diagnostics ?? []).map((d) => {
          const diag = new vscode.Diagnostic(toVsRange(d.range), d.message, mapSeverity(d.severity));
          if (d.code !== undefined) diag.code = d.code;
          if (d.source) diag.source = d.source;
          return diag;
        });
        this.diagCollection.set(uri, list);
      }
    }

    async stop() {
      if (this.disposed) return await this.exitP;
      this.disposed = true;
      try {
        await Promise.race([
          this.requestRaw("shutdown", null),
          new Promise((r) => setTimeout(r, 1500)),
        ]);
        this.notifyRaw("exit", null);
      } catch {
        // ignore errors during teardown
      }
      const timer = setTimeout(() => {
        try { this.proc.kill("SIGKILL"); } catch { /* ignore */ }
      }, 1500);
      try {
        return await this.exitP;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  function resolveSpawnSpec(docPath) {
    const cfg = vscode.workspace.getConfiguration("szigyr.lsp");
    if (cfg.get("enable") === false) return undefined;
    const rawCmd = String(cfg.get("command") ?? "").trim();
    const rawArgs = cfg.get("args");
    const args = Array.isArray(rawArgs) && rawArgs.length ? rawArgs.map(String) : ["lsp"];
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? (docPath ? dirname(docPath) : undefined);
    const cwd = wsRoot ?? process.cwd();
    if (rawCmd) {
      if (rawCmd.endsWith(".ts") || rawCmd.endsWith(".js") || rawCmd.endsWith(".mjs")) {
        return { command: process.execPath, args: [rawCmd, ...args], cwd };
      }
      return { command: rawCmd, args, cwd };
    }
    const cliTs = findWorkspaceCli(wsRoot) ?? findWorkspaceCli(docPath ? dirname(docPath) : undefined);
    if (cliTs) return { command: process.execPath, args: [cliTs, ...args], cwd };
    return { command: "szigyr", args, cwd };
  }

  function activate(context) {
    const firstSzigyr = vscode.workspace.textDocuments.find((d) => d.languageId === "szigyr");
    const spec = resolveSpawnSpec(firstSzigyr?.uri?.fsPath);
    if (!spec) return;

    const diagCollection = vscode.languages.createDiagnosticCollection("szigyr");
    client = new SzigyrLspClient(spec.command, spec.args, spec.cwd, diagCollection);
    const c = client;

    const sendOpen = (doc) => {
      if (doc.languageId !== "szigyr") return;
      void c.notify("textDocument/didOpen", {
        textDocument: { uri: doc.uri.toString(), languageId: doc.languageId, version: doc.version, text: doc.getText() },
      });
    };
    for (const doc of vscode.workspace.textDocuments) sendOpen(doc);

    const selector = [{ language: "szigyr", scheme: "file" }];
    context.subscriptions.push(
      diagCollection,
      { dispose: () => { void c.stop(); } },
      vscode.workspace.onDidOpenTextDocument(sendOpen),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId !== "szigyr") return;
        void c.notify("textDocument/didChange", {
          textDocument: { uri: e.document.uri.toString(), version: e.document.version },
          contentChanges: [{ text: e.document.getText() }],
        });
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.languageId !== "szigyr") return;
        void c.notify("textDocument/didSave", { textDocument: { uri: doc.uri.toString() } });
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.languageId !== "szigyr") return;
        diagCollection.delete(doc.uri);
        void c.notify("textDocument/didClose", { textDocument: { uri: doc.uri.toString() } });
      }),
      vscode.languages.registerHoverProvider(selector, {
        async provideHover(doc, pos) {
          const res = await c.request("textDocument/hover", {
            textDocument: { uri: doc.uri.toString() },
            position: toLspPos(pos),
          });
          if (!res?.contents) return null;
          const val = typeof res.contents === "string" ? res.contents : res.contents.value ?? "";
          const md = new vscode.MarkdownString(val);
          return new vscode.Hover(md, res.range ? toVsRange(res.range) : undefined);
        },
      }),
      vscode.languages.registerDefinitionProvider(selector, {
        async provideDefinition(doc, pos) {
          const res = await c.request("textDocument/definition", {
            textDocument: { uri: doc.uri.toString() },
            position: toLspPos(pos),
          });
          if (!res) return null;
          const items = Array.isArray(res) ? res : [res];
          const locs = items.map((loc) => new vscode.Location(vscode.Uri.parse(loc.uri), toVsRange(loc.range)));
          return locs.length === 1 ? locs[0] : locs;
        },
      }),
      vscode.languages.registerDocumentSymbolProvider(selector, {
        async provideDocumentSymbols(doc) {
          const res = await c.request("textDocument/documentSymbol", {
            textDocument: { uri: doc.uri.toString() },
          });
          return Array.isArray(res) ? res.map(mapDocumentSymbol) : [];
        },
      }),
      vscode.languages.registerCodeActionsProvider(
        selector,
        {
          async provideCodeActions(doc, range, ctx) {
            const diags = (ctx.diagnostics ?? []).map((d) => ({
              range: { start: toLspPos(d.range.start), end: toLspPos(d.range.end) },
              message: d.message,
              ...(d.code !== undefined ? { code: String(d.code) } : {}),
            }));
            const res = await c.request("textDocument/codeAction", {
              textDocument: { uri: doc.uri.toString() },
              range: { start: toLspPos(range.start), end: toLspPos(range.end) },
              context: { diagnostics: diags },
            });
            if (!Array.isArray(res)) return [];
            return res.map((a) => {
              const ca = new vscode.CodeAction(a.title, vscode.CodeActionKind.QuickFix);
              ca.isPreferred = !!a.isPreferred;
              if (a.edit?.changes) {
                const edit = new vscode.WorkspaceEdit();
                for (const [u, list] of Object.entries(a.edit.changes)) {
                  const uri = vscode.Uri.parse(u);
                  for (const item of list) edit.replace(uri, toVsRange(item.range), item.newText);
                }
                ca.edit = edit;
              }
              return ca;
            });
          },
        },
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
      ),
    );
  }

  async function deactivate() {
    if (!client) return undefined;
    const c = client;
    client = undefined;
    return await c.stop();
  }

  return { activate, deactivate };
}

const defaultExt = createExtension();
module.exports = {
  activate: defaultExt.activate,
  deactivate: defaultExt.deactivate,
  createExtension,
};
