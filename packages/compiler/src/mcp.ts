// Stdio JSON-RPC 2.0 MCP server (`szigyr mcp`) powered by a resident incremental compiler session.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyze, check, CLI_NAME, createParser, explainCode, mutate, queryFile, run, runTestFile, type Backend, type Parser } from "./index.ts";

export interface McpOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly parser?: Parser;
}

const OVERLAYS_SCHEMA = {
  type: "object",
  additionalProperties: { type: "string" },
  description: "Optional map of file paths to unsaved buffer contents for multi-file analysis.",
} as const;

const TOOLS = [
  {
    name: "szigyr_check",
    description: "Typecheck and verify a .szigyr file (P1 syntax, P2 types/capabilities, P3 ownership, P4 C headers) using the resident parser.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the entry .szigyr file." },
        content: { type: "string", description: "Optional unsaved buffer content to check instead of reading `file` from disk." },
        overlays: OVERLAYS_SCHEMA,
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "szigyr_query",
    description: "Inspect declared symbols, resolved types, layers, capabilities, Purity/Mutatable flags, and rt trap sites for a .szigyr file.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the entry .szigyr file." },
        content: { type: "string", description: "Optional unsaved buffer content to query instead of reading `file` from disk." },
        overlays: OVERLAYS_SCHEMA,
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "szigyr_explain",
    description: "Return documentation and remediation advice for a Szigyr error or trap code (e.g., E2007, T002).",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Diagnostic or trap code." },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "szigyr_test",
    description: "Run top-level `test(...)` blocks in a .szigyr file under js, c, wasm, or both backends.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the .szigyr test file." },
        backend: { type: "string", enum: ["js", "c", "wasm", "both"], description: "Target backend (default: js)." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "szigyr_mutate",
    description: "Run mutation testing over Mutatable functions and class methods in a .szigyr file.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the .szigyr file." },
        noCache: { type: "boolean", description: "Disable cached mutation results." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "szigyr_run",
    description: "Compile and execute `main(...)` in a .szigyr file under js, c, wasm, or both backends in an isolated subprocess.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the entry .szigyr file." },
        backend: { type: "string", enum: ["js", "c", "wasm", "both"], description: "Target backend (default: js)." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
];

function okTool(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type WorkerReq =
  | { readonly op: "test"; readonly file: string; readonly backend: string }
  | { readonly op: "mutate"; readonly file: string; readonly noCache: boolean }
  | { readonly op: "run"; readonly file: string; readonly backend: string };

async function handleWorker(req: WorkerReq): Promise<[unknown, boolean?]> {
  const parser = createParser();
  try {
    const t0 = performance.now();
    const ms = (): number => +(performance.now() - t0).toFixed(2);
    if (req.op === "test") {
      const backends: Backend[] = req.backend === "both" ? ["js", "c"] : [req.backend as Backend];
      const analysis = analyze(req.file, parser);
      const rs = [];
      for (const b of backends) {
        const r = await runTestFile(req.file, { backend: b, analysis });
        if (r.diagnostics.length) {
          return [{ ok: false, file: req.file, backend: req.backend, diagnostics: r.diagnostics, results: [], durationMs: ms() }];
        }
        rs.push(r);
      }
      const r0 = rs[0]!;
      let mismatch: unknown;
      if (rs.length === 2) {
        const r1 = rs[1]!;
        const key = (t: (typeof r0.results)[number] | undefined): string => JSON.stringify(t && [t.name, t.ok, t.trap ? null : t.failure, t.trap?.code, t.pos?.file, t.pos?.line, t.pos?.col]);
        if (r1.results.length !== r0.results.length || r0.results.some((t, i) => key(t) !== key(r1.results[i]))) {
          mismatch = { js: r0.results, c: r1.results };
        }
      }
      const ok = !mismatch && r0.results.every((t) => t.ok);
      return [{ ok, file: req.file, backend: req.backend, diagnostics: [], results: r0.results, ...(mismatch ? { mismatch } : {}), durationMs: ms() }];
    }
    if (req.op === "run") {
      const backends: Backend[] = req.backend === "both" ? ["js", "c"] : [req.backend as Backend];
      const analysis = analyze(req.file, parser);
      const rs = [];
      for (const b of backends) {
        const r = await run(req.file, { backend: b, analysis });
        if (r.diagnostics.length) {
          return [{ ok: false, file: req.file, backend: req.backend, diagnostics: r.diagnostics, stdout: "", durationMs: ms() }];
        }
        rs.push(r);
      }
      const r0 = rs[0]!;
      let mismatch: unknown;
      if (rs.length === 2 && JSON.stringify([rs[0]!.stdout, rs[0]!.trap]) !== JSON.stringify([rs[1]!.stdout, rs[1]!.trap])) {
        mismatch = { js: { stdout: rs[0]!.stdout, trap: rs[0]!.trap }, c: { stdout: rs[1]!.stdout, trap: rs[1]!.trap } };
      }
      const ok = !mismatch && !r0.trap;
      return [{ ok, file: req.file, backend: req.backend, diagnostics: [], stdout: r0.stdout, ...(r0.trap ? { trap: r0.trap } : {}), ...(mismatch ? { mismatch } : {}), durationMs: ms() }];
    }
    const r = await mutate(req.file, { cache: !req.noCache, parser });
    return [{ file: req.file, ...r, durationMs: ms() }];
  } finally {
    parser.close();
  }
}

function runWorker(req: WorkerReq): Promise<ReturnType<typeof okTool>> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./mcp.ts", import.meta.url))], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, SZIGYR_MCP_WORKER: "1" },
    });
    let stderr = "";
    let reply: ReturnType<typeof okTool> | undefined;
    child.stdout?.resume(); // discard child/native stdout so JSON-RPC transport is never corrupted
    child.stderr?.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("message", (msg: { okToolArgs: [unknown, boolean?] }) => {
      reply = okTool(msg.okToolArgs[0], msg.okToolArgs[1]);
    });
    child.on("error", (err) => {
      if (!reply) reply = okTool({ ok: false, file: req.file, error: err.message }, true);
      resolvePromise(reply);
    });
    child.on("close", (code, signal) => {
      if (reply) resolvePromise(reply);
      else resolvePromise(okTool({ ok: false, file: req.file, error: `worker exited (code=${code}, signal=${signal})`, ...(stderr.trim() ? { stderr: stderr.trim() } : {}) }, true));
    });
    child.send(req);
  });
}

function parseOverlays(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RpcError(-32602, "'overlays' must be a plain object mapping paths to strings");
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== "string" || typeof v !== "string") throw new RpcError(-32602, "'overlays' values must be strings");
  }
  return raw as Record<string, string>;
}

/** Runs the newline-delimited JSON-RPC 2.0 MCP server until input EOF or termination signal. */
export async function serveMcp(opts: McpOptions = {}): Promise<number> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const parser = opts.parser ?? createParser();
  const ownParser = !opts.parser;

  const send = (msg: unknown): void => {
    output.write(`${JSON.stringify(msg)}\n`);
  };

  const withOverlays = <T>(file: string, content: string | undefined, overlays: Record<string, string> | undefined, fn: () => T): T => {
    const applied: string[] = [];
    if (overlays) {
      for (const [p, text] of Object.entries(overlays)) {
        parser.setOverlay?.(p, text);
        applied.push(p);
      }
    }
    if (content !== undefined) {
      parser.setOverlay?.(file, content);
      applied.push(file);
    }
    try { return fn(); } finally {
      for (const p of applied) parser.clearOverlay?.(p);
    }
  };

  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (name === "szigyr_check" || name === "szigyr_query") {
      const file = args.file;
      const content = args.content;
      const overlays = parseOverlays(args.overlays);
      if (typeof file !== "string" || !file) throw new RpcError(-32602, `'${name}' requires non-empty string 'file'`);
      if (content !== undefined && typeof content !== "string") throw new RpcError(-32602, `'${name}' 'content' must be a string`);
      const resolvedFile = resolve(file);
      const inOverlays = content !== undefined || (overlays !== undefined && Object.keys(overlays).some((k) => resolve(k) === resolvedFile));
      if (!inOverlays && !existsSync(file)) return okTool({ ok: false, error: `no such file: ${file}` }, true);
      const t0 = performance.now();
      if (name === "szigyr_check") {
        const diagnostics = withOverlays(file, content, overlays, () => check(file, parser));
        const durationMs = +(performance.now() - t0).toFixed(2);
        return okTool({ ok: diagnostics.every((d) => d.severity !== "error"), file, diagnostics, durationMs });
      }
      const q = withOverlays(file, content, overlays, () => queryFile(file, parser));
      const durationMs = +(performance.now() - t0).toFixed(2);
      return okTool({ ...q, durationMs });
    }
    if (name === "szigyr_explain") {
      const code = args.code;
      if (typeof code !== "string" || !code) throw new RpcError(-32602, "'szigyr_explain' requires non-empty string 'code'");
      const entry = explainCode(code);
      if (!entry) return okTool({ error: `unknown diagnostic or trap code '${code}'` }, true);
      return okTool(entry);
    }
    if (name === "szigyr_test" || name === "szigyr_run") {
      const file = args.file;
      const backend = (args.backend ?? "js") as string;
      if (typeof file !== "string" || !file) throw new RpcError(-32602, `'${name}' requires non-empty string 'file'`);
      if (!["js", "c", "wasm", "both"].includes(backend)) throw new RpcError(-32602, `unknown backend '${backend}'`);
      if (!existsSync(file)) return okTool({ ok: false, error: `no such file: ${file}` }, true);
      return await runWorker({ op: name === "szigyr_run" ? "run" : "test", file, backend });
    }
    if (name === "szigyr_mutate") {
      const file = args.file;
      const noCache = args.noCache;
      if (typeof file !== "string" || !file) throw new RpcError(-32602, "'szigyr_mutate' requires non-empty string 'file'");
      if (noCache !== undefined && typeof noCache !== "boolean") throw new RpcError(-32602, "'szigyr_mutate' 'noCache' must be a boolean");
      if (!existsSync(file)) return okTool({ ok: false, error: `no such file: ${file}` }, true);
      return await runWorker({ op: "mutate", file, noCache: !!noCache });
    }
    throw new RpcError(-32602, `unknown tool '${name}'`);
  };

  const rl = createInterface({ input, crlfDelay: Infinity });
  const closeRl = (): void => { rl.close(); };
  process.on("SIGINT", closeRl);
  process.on("SIGTERM", closeRl);

  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
          continue;
        }
        msg = parsed as Record<string, unknown>;
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }

      const hasId = Object.hasOwn(msg, "id") && msg.id !== undefined;
      const id = hasId ? msg.id : null;
      const method = msg.method;
      if (typeof method !== "string") {
        if (hasId) send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
        continue;
      }
      if (!hasId || method.startsWith("notifications/")) continue;

      const params = (msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params : {}) as Record<string, unknown>;
      try {
        let result: unknown;
        if (method === "initialize") {
          result = {
            protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: CLI_NAME, version: "1.0.0" },
          };
        } else if (method === "ping") {
          result = {};
        } else if (method === "tools/list") {
          result = { tools: TOOLS };
        } else if (method === "tools/call") {
          const name = params.name;
          if (typeof name !== "string" || !name) throw new RpcError(-32602, "tools/call requires string 'name'");
          const toolArgs = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
          result = await callTool(name, toolArgs);
        } else {
          throw new RpcError(-32601, `Method not found: ${method}`);
        }
        send({ jsonrpc: "2.0", id, result });
      } catch (e) {
        if (e instanceof RpcError) send({ jsonrpc: "2.0", id, error: { code: e.code, message: e.message } });
        else send({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
      }
    }
  } finally {
    process.off("SIGINT", closeRl);
    process.off("SIGTERM", closeRl);
    rl.close();
    if (ownParser) parser.close();
  }
  return 0;
}

if (process.env.SZIGYR_MCP_WORKER === "1" && process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.once("message", (req: WorkerReq) => {
    void (async () => {
      try {
        const okToolArgs = await handleWorker(req);
        process.send!({ okToolArgs }, () => process.exit(0));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.send!({ okToolArgs: [{ ok: false, file: req.file, error: msg }, true] }, () => process.exit(0));
      }
    })();
  });
}
