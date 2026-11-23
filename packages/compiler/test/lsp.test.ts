import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI_PATH = resolve(import.meta.dirname, "../src/cli.ts");

const tmpRoots: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

class LspClient {
  readonly proc: ReturnType<typeof spawn>;
  private buf = Buffer.alloc(0);
  private readonly messages: Record<string, any>[] = [];
  private readonly waiters: { pred: (m: Record<string, any>) => boolean; resolve: (m: Record<string, any>) => void }[] = [];
  private seq = 1;

  constructor(cwd?: string) {
    this.proc = spawn(process.execPath, [CLI_PATH, "lsp"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep < 0) break;
      const hdr = this.buf.subarray(0, sep).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(hdr);
      if (!m) {
        this.buf = this.buf.subarray(sep + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = sep + 4;
      if (this.buf.length < start + len) break;
      const body = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      const parsed = JSON.parse(body) as Record<string, any>;
      const idx = this.waiters.findIndex((w) => w.pred(parsed));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w!.resolve(parsed);
      } else {
        this.messages.push(parsed);
      }
    }
  }

  waitFor(pred: (m: Record<string, any>) => boolean, timeoutMs = 15_000): Promise<Record<string, any>> {
    const idx = this.messages.findIndex(pred);
    if (idx >= 0) {
      const [hit] = this.messages.splice(idx, 1);
      return Promise.resolve(hit!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const wi = this.waiters.findIndex((w) => w.resolve === finish);
        if (wi >= 0) this.waiters.splice(wi, 1);
        reject(new Error("LspClient timeout waiting for message"));
      }, timeoutMs);
      const finish = (m: Record<string, any>): void => {
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push({ pred, resolve: finish });
    });
  }

  private writeFrame(obj: unknown, splitHalf = false): void {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const hdr = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    const frame = Buffer.concat([hdr, body]);
    if (splitHalf && frame.length > 8) {
      const mid = Math.floor(frame.length / 2);
      this.proc.stdin!.write(frame.subarray(0, mid));
      this.proc.stdin!.write(frame.subarray(mid));
    } else {
      this.proc.stdin!.write(frame);
    }
  }

  async request(method: string, params?: unknown, splitHalf = false): Promise<Record<string, any>> {
    const id = this.seq++;
    this.writeFrame({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }, splitHalf);
    return await this.waitFor((m) => m.id === id);
  }

  notify(method: string, params?: unknown, splitHalf = false): void {
    this.writeFrame({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }, splitHalf);
  }

  async waitForDiagnostics(uri: string): Promise<Record<string, any>[]> {
    const msg = await this.waitFor((m) => m.method === "textDocument/publishDiagnostics" && m.params?.uri === uri);
    return msg.params.diagnostics as Record<string, any>[];
  }

  async shutdownAndExit(): Promise<number> {
    const r = await this.request("shutdown");
    expect(r.result).toBeNull();
    this.notify("exit");
    return await new Promise<number>((res) => this.proc.once("close", (code) => res(code ?? -1)));
  }
}

function applyLspEdits(text: string, edits: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]): string {
  const lines = text.split("\n");
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const toOff = (p: { line: number; character: number }) => starts[p.line]! + p.character;
  const sorted = [...edits].sort((a, b) => toOff(b.range.start) - toOff(a.range.start));
  let cur = text;
  for (const e of sorted) {
    const s = toOff(e.range.start);
    const end = toOff(e.range.end);
    cur = cur.slice(0, s) + e.newText + cur.slice(end);
  }
  void lines;
  return cur;
}

describe("szigyr lsp stdio server", () => {
  it("handles Content-Length split chunks, UTF-8, diagnostics, quickfix codeActions, hover, documentSymbol, multi-file overlays, and clean shutdown", async () => {
    const dir = makeTmp("szigyr-lsp-");
    const libPath = join(dir, "lib.szigyr");
    const mainPath = join(dir, "main.szigyr");
    const libUri = pathToFileURL(libPath).href;
    const mainUri = pathToFileURL(mainPath).href;

    const libDisk = `export function scale(x: i32): i32 {
  "use rt";
  return x * 2;
}
`;
    const mainBad = `import { scale } from "./lib.szigyr";
// 日本語コメント
export function main(sys: System): void {
  var v: i32 = scale(3);
  if (v == 6) {
    sys.log.info(\`ok=\${v}\`);
  }
}
`;
    writeFileSync(libPath, libDisk);
    writeFileSync(mainPath, mainBad);

    const lsp = new LspClient(dir);
    try {
      const init = await lsp.request("initialize", { processId: null, rootUri: pathToFileURL(dir).href, capabilities: {} }, true);
      expect(init.result.serverInfo.name).toBe("szigyr");
      expect(init.result.capabilities.hoverProvider).toBe(true);
      expect(init.result.capabilities.documentSymbolProvider).toBe(true);
      lsp.notify("initialized", {});

      // Unknown method -> -32601
      const badMethod = await lsp.request("szigyr/nonexistent");
      expect(badMethod.error.code).toBe(-32601);

      // didOpen with split chunk + UTF-8 triggers publishDiagnostics with 0-based positions
      const pDiag1 = lsp.waitForDiagnostics(mainUri);
      lsp.notify("textDocument/didOpen", { textDocument: { uri: mainUri, languageId: "typescript", version: 1, text: mainBad } }, true);
      const diags1 = await pDiag1;
      expect(diags1.map((d) => `${d.range.start.line}:${d.code}`)).toEqual(["3:E1001", "4:E1002"]);

      // codeAction offers quickfix for `var` -> `const`/`let` and `==` -> `===`
      const actionsVar = await lsp.request("textDocument/codeAction", {
        textDocument: { uri: mainUri },
        range: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } },
        context: { diagnostics: [diags1[0]] },
      });
      expect(actionsVar.result.length).toBeGreaterThanOrEqual(1);
      expect(actionsVar.result[0].kind).toBe("quickfix");

      const actionsEq = await lsp.request("textDocument/codeAction", {
        textDocument: { uri: mainUri },
        range: { start: { line: 4, character: 8 }, end: { line: 4, character: 10 } },
        context: { diagnostics: [diags1[1]] },
      });
      expect(actionsEq.result[0].kind).toBe("quickfix");

      const edits = [
        ...actionsVar.result[0].edit.changes[mainUri],
        ...actionsEq.result[0].edit.changes[mainUri],
      ];
      const fixedMain = applyLspEdits(mainBad, edits);
      const pDiagFixed = lsp.waitForDiagnostics(mainUri);
      lsp.notify("textDocument/didChange", {
        textDocument: { uri: mainUri, version: 2 },
        contentChanges: [{ text: fixedMain }],
      });
      expect(await pDiagFixed).toEqual([]);

      // hover on `main` function decl, local `v` usage, and whitespace
      const hoverFn = await lsp.request("textDocument/hover", {
        textDocument: { uri: mainUri },
        position: { line: 2, character: 17 }, // `main`
      });
      expect(hoverFn.result.contents.value).toContain("function main");
      expect(hoverFn.result.contents.value).toContain("managed");

      const hoverLocal = await lsp.request("textDocument/hover", {
        textDocument: { uri: mainUri },
        position: { line: 4, character: 6 }, // `v`
      });
      expect(hoverLocal.result.contents.value).toContain("i32");

      const hoverBlank = await lsp.request("textDocument/hover", {
        textDocument: { uri: mainUri },
        position: { line: 1, character: 0 }, // comment line
      });
      expect(hoverBlank.result).toBeNull();

      // documentSymbol on main & lib
      const syms = await lsp.request("textDocument/documentSymbol", { textDocument: { uri: mainUri } });
      expect(syms.result.some((s: Record<string, any>) => s.name === "main" && s.kind === 12)).toBe(true);

      // Multi-file unsaved overlay: open lib.szigyr and change return type from i32 to string -> main.szigyr reports E2002 without touching disk!
      const pLibOpen = lsp.waitForDiagnostics(libUri);
      const pMainOpenSync = lsp.waitForDiagnostics(mainUri);
      lsp.notify("textDocument/didOpen", { textDocument: { uri: libUri, languageId: "typescript", version: 1, text: libDisk } });
      expect(await pLibOpen).toEqual([]);
      expect(await pMainOpenSync).toEqual([]);

      const pHoverLib = await lsp.request("textDocument/hover", {
        textDocument: { uri: libUri },
        position: { line: 0, character: 16 }, // `scale`
      });
      expect(pHoverLib.result.contents.value).toContain("layer: `rt`");
      expect(pHoverLib.result.contents.value).toContain("pure: `true`");

      const pLibEdited = lsp.waitForDiagnostics(libUri);
      const pMainBroken = lsp.waitForDiagnostics(mainUri);
      lsp.notify("textDocument/didChange", {
        textDocument: { uri: libUri, version: 2 },
        contentChanges: [{ text: `export function scale(x: i32): string {\n  return \`\${x}\`;\n}\n` }],
      });
      expect(await pLibEdited).toEqual([]);
      const mainBrokenDiags = await pMainBroken;
      expect(mainBrokenDiags.some((d) => d.code === "E2002")).toBe(true);

      // Closing lib restores disk version -> main becomes clean again; closing main clears main diagnostics
      const pMainRestored = lsp.waitForDiagnostics(mainUri);
      const pLibCleared = lsp.waitForDiagnostics(libUri);
      lsp.notify("textDocument/didClose", { textDocument: { uri: libUri } });
      expect(await pLibCleared).toEqual([]);
      expect(await pMainRestored).toEqual([]);

      const pMainCleared = lsp.waitForDiagnostics(mainUri);
      lsp.notify("textDocument/didClose", { textDocument: { uri: mainUri } });
      expect(await pMainCleared).toEqual([]);

      const exitCode = await lsp.shutdownAndExit();
      expect(exitCode).toBe(0);
    } finally {
      if (lsp.proc.exitCode === null) lsp.proc.kill();
    }
  }, 60_000);
});
