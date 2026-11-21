// Stdio JSON-RPC 2.0 MCP server (`szigyr mcp`) powered by a resident incremental compiler session.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUILTIN_FUNCTIONS, CAPABILITY_NAMES, NAMESPACES, SPEC_RESERVED, genMembers, nsMembers, opaqueMembers, stringMembers, type Member } from "./builtins.ts";
import { analyze, check, CLI_NAME, createParser, explainCode, mutate, prove, queryFile, run, runTestFile, shutdownSmt, type Backend, type Parser } from "./index.ts";
import { GEN_ARITY, OPAQUE_NAMES, show, type GenName, type Type } from "./types.ts";

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

const TIMEOUT_SCHEMA = {
  type: "integer",
  minimum: 100,
  maximum: 300000,
  default: 30000,
  description: "Optional worker timeout in milliseconds (100..300000, default: 30000).",
} as const;

const RESOURCES = [
  {
    uri: "szigyr://spec",
    name: "Szigyr Language Specification v1",
    description: "Normative Szigyr language specification (layers, types, capabilities, ownership, FFI, built-ins, codes).",
    mimeType: "text/markdown",
  },
  {
    uri: "szigyr://builtins",
    name: "Szigyr Built-in Allowlist",
    description: "Machine-readable JSON catalog of built-in functions, namespaces, capabilities, reserved names, and member signatures.",
    mimeType: "application/json",
  },
] as const;

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
    description: "Run top-level `test(...)` blocks in a .szigyr file under js, c, wasm, both, or all backends.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the .szigyr test file." },
        content: { type: "string", description: "Optional unsaved buffer content to test instead of reading `file` from disk." },
        overlays: OVERLAYS_SCHEMA,
        backend: { type: "string", enum: ["js", "c", "wasm", "both", "all"], description: "Target backend (default: js)." },
        timeoutMs: TIMEOUT_SCHEMA,
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
        all: { type: "boolean", description: "Include locally imported modules in mutation targets (default: false)." },
        failOnSurvived: { type: "boolean", description: "Set ok=false when any mutant survives (default: false)." },
        timeoutMs: TIMEOUT_SCHEMA,
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "szigyr_run",
    description: "Compile and execute `main(...)` in a .szigyr file under js, c, wasm, both, or all backends in an isolated subprocess.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the entry .szigyr file." },
        content: { type: "string", description: "Optional unsaved buffer content to run instead of reading `file` from disk." },
        overlays: OVERLAYS_SCHEMA,
        backend: { type: "string", enum: ["js", "c", "wasm", "both", "all"], description: "Target backend (default: js)." },
        timeoutMs: TIMEOUT_SCHEMA,
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "szigyr_prove",
    description: "Run per-function static SMT verification on a Szigyr entry file using native z3/cvc5 or bundled Z3 Wasm, returning obligation statuses, counterexample models, and remaining runtime trap sites.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the entry .szigyr file." },
        content: { type: "string", description: "Optional unsaved buffer content (disables disk prove cache for this call)." },
        overlays: OVERLAYS_SCHEMA,
        all: { type: "boolean", description: "Also prove locally imported modules (default: false)." },
        noCache: { type: "boolean", description: "Disable reading/writing .szigyr-cache/prove.json (default: false)." },
        strict: { type: "boolean", description: "Set ok=false when any obligation is unknown or timed out (default: false)." },
        proveTimeoutMs: { type: "integer", minimum: 1, maximum: 60000, default: 2000, description: "Per-query SMT solver timeout in milliseconds (default: 2000)." },
        timeoutMs: TIMEOUT_SCHEMA,
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
  | { readonly op: "test"; readonly file: string; readonly backend: string; readonly content?: string; readonly overlays?: Record<string, string> }
  | { readonly op: "mutate"; readonly file: string; readonly noCache: boolean; readonly all?: boolean; readonly failOnSurvived?: boolean }
  | { readonly op: "prove"; readonly file: string; readonly noCache: boolean; readonly all?: boolean; readonly strict?: boolean; readonly proveTimeoutMs?: number; readonly content?: string; readonly overlays?: Record<string, string> }
  | { readonly op: "run"; readonly file: string; readonly backend: string; readonly content?: string; readonly overlays?: Record<string, string> };

function applyOverlays(parser: Parser, file: string, content: string | undefined, overlays: Record<string, string> | undefined): string[] {
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
  return applied;
}

function workerBackends(backend: string): Backend[] {
  return backend === "all" ? ["js", "c", "wasm"] : backend === "both" ? ["js", "c"] : [backend as Backend];
}

async function handleWorker(req: WorkerReq): Promise<[unknown, boolean?]> {
  const parser = createParser();
  try {
    const t0 = performance.now();
    const ms = (): number => +(performance.now() - t0).toFixed(2);
    if (req.op === "test") {
      const backends = workerBackends(req.backend);
      applyOverlays(parser, req.file, req.content, req.overlays);
      const analysis = analyze(req.file, parser);
      const rs: Awaited<ReturnType<typeof runTestFile>>[] = [];
      for (const b of backends) {
        const r = await runTestFile(req.file, { backend: b, analysis });
        if (r.diagnostics.length) {
          return [{ ok: false, file: req.file, backend: req.backend, diagnostics: r.diagnostics, results: [], durationMs: ms() }];
        }
        rs.push(r);
      }
      const r0 = rs[0]!;
      let mismatch: unknown;
      if (rs.length >= 2) {
        const key = (t: (typeof r0.results)[number] | undefined): string =>
          JSON.stringify(t && [t.name, t.ok, t.trap ? null : t.failure, t.trap?.code, t.pos?.file, t.pos?.line, t.pos?.col]);
        if (rs.slice(1).some((rk) => rk.results.length !== r0.results.length || r0.results.some((t, i) => key(t) !== key(rk.results[i])))) {
          mismatch = Object.fromEntries(backends.map((b, i) => [b, rs[i]!.results]));
        }
      }
      const ok = !mismatch && r0.results.every((t) => t.ok);
      return [{ ok, file: req.file, backend: req.backend, diagnostics: [], results: r0.results, ...(mismatch ? { mismatch } : {}), durationMs: ms() }];
    }
    if (req.op === "run") {
      const backends = workerBackends(req.backend);
      applyOverlays(parser, req.file, req.content, req.overlays);
      const analysis = analyze(req.file, parser);
      const rs: Awaited<ReturnType<typeof run>>[] = [];
      for (const b of backends) {
        const r = await run(req.file, { backend: b, analysis });
        if (r.diagnostics.length) {
          return [{ ok: false, file: req.file, backend: req.backend, diagnostics: r.diagnostics, stdout: "", durationMs: ms() }];
        }
        rs.push(r);
      }
      const r0 = rs[0]!;
      let mismatch: unknown;
      if (rs.length >= 2) {
        const key0 = JSON.stringify([r0.stdout, r0.trap]);
        if (rs.slice(1).some((rk) => JSON.stringify([rk.stdout, rk.trap]) !== key0)) {
          mismatch = Object.fromEntries(backends.map((b, i) => [b, { stdout: rs[i]!.stdout, trap: rs[i]!.trap }]));
        }
      }
      const ok = !mismatch && !r0.trap;
      return [{ ok, file: req.file, backend: req.backend, diagnostics: [], stdout: r0.stdout, ...(r0.trap ? { trap: r0.trap } : {}), ...(mismatch ? { mismatch } : {}), durationMs: ms() }];
    }
    if (req.op === "prove") {
      applyOverlays(parser, req.file, req.content, req.overlays);
      const useCache = !req.noCache && req.content === undefined && req.overlays === undefined;
      const r = await prove(req.file, {
        cache: useCache,
        parser,
        ...(req.all ? { all: true } : {}),
        ...(req.proveTimeoutMs !== undefined ? { timeoutMs: req.proveTimeoutMs } : {}),
      });
      const { proved: _proved, ...rest } = r;
      const ok = r.diagnostics.length === 0
        && r.summary.failed === 0
        && (!req.strict || (r.summary.unknown === 0 && r.summary.timeout === 0));
      return [{ ok, file: req.file, ...rest, durationMs: ms() }];
    }
    const r = await mutate(req.file, { cache: !req.noCache, parser, ...(req.all ? { all: true } : {}) });
    const ok = r.diagnostics.length === 0 && !r.baselineFailure && !(req.failOnSurvived && r.summary.survived > 0);
    return [{ ok, file: req.file, ...r, durationMs: ms() }];
  } finally {
    await shutdownSmt();
    parser.close();
  }
}

function runWorker(req: WorkerReq, timeoutMs = 30_000): Promise<ReturnType<typeof okTool>> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./mcp.ts", import.meta.url))], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, SZIGYR_MCP_WORKER: "1" },
    });
    let stderr = "";
    let reply: ReturnType<typeof okTool> | undefined;
    let timedOut = false;
    let settled = false;
    const done = (res: ReturnType<typeof okTool>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(res);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      done(okTool({ ok: false, file: req.file, error: `timed out after ${timeoutMs}ms`, timedOut: true }, true));
    }, timeoutMs);
    child.stdout?.resume(); // discard child/native stdout so JSON-RPC transport is never corrupted
    child.stderr?.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("message", (msg: { okToolArgs: [unknown, boolean?] }) => {
      reply = okTool(msg.okToolArgs[0], msg.okToolArgs[1]);
    });
    child.on("error", (err) => {
      if (timedOut) return;
      if (!reply) reply = okTool({ ok: false, file: req.file, error: err.message }, true);
      done(reply);
    });
    child.on("close", (code, signal) => {
      if (timedOut) return;
      if (reply) done(reply);
      else done(okTool({ ok: false, file: req.file, error: `worker exited (code=${code}, signal=${signal})`, ...(stderr.trim() ? { stderr: stderr.trim() } : {}) }, true));
    });
    child.send(req);
  });
}

function parseTimeoutMs(raw: unknown, tool: string): number {
  if (raw === undefined) return 30_000;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 100 || raw > 300_000) {
    throw new RpcError(-32602, `'${tool}' 'timeoutMs' must be a finite integer in [100, 300000]`);
  }
  return raw;
}

function formatMember(m: Member | "variadic") {
  if (m === "variadic") return { kind: "variadic" };
  if (m.kind === "prop") return { kind: "prop", type: show(m.type), readonly: m.readonly };
  return {
    kind: "method",
    signature: show(m.sig),
    ...(m.sig.tparams.length ? { typeParams: m.sig.tparams.map((p) => p.name) } : {}),
    ...(m.sig.min !== undefined ? { minArgs: m.sig.min } : {}),
    ...(m.managedOnly ? { managedOnly: true } : {}),
    mutates: m.fx.mutates,
    contract: m.fx.contract,
  };
}

function formatMembers(ms: Record<string, Member | "variadic">, ns?: string) {
  return Object.fromEntries(Object.entries(ms).map(([k, v]) => {
    const entry = formatMember(v);
    if (ns === "Math" && ["abs", "sqrt", "floor", "ceil", "trunc", "round", "sign"].includes(k)) return [k, { ...entry, signature: "(f32) => f32 | (f64) => f64" }];
    if (ns === "Math" && (k === "min" || k === "max")) return [k, { ...entry, signature: "(...xs: f32[]) => f32 | (...xs: f64[]) => f64" }];
    if (ns === "Number" && ["isFinite", "isNaN", "isInteger"].includes(k)) return [k, { ...entry, signature: "(f32 | f64) => boolean" }];
    if (ns === "JSON" && k === "stringify") return [k, { ...entry, signature: "<T extends Codec (concrete, no i64/u64)>(T) => string" }];
    return [k, entry];
  }));
}

function buildBuiltinsCatalog() {
  const tp = (name: string, id: number): Type => ({ k: "tparam", p: { name, id } });
  return {
    functions: [...BUILTIN_FUNCTIONS],
    capabilities: [...CAPABILITY_NAMES],
    reserved: SPEC_RESERVED,
    namespaces: Object.fromEntries([...NAMESPACES].map((ns) => [ns, formatMembers(nsMembers(ns), ns)])),
    genericTypes: Object.fromEntries(
      (Object.keys(GEN_ARITY) as GenName[]).map((name) => {
        const arity = GEN_ARITY[name];
        const args = arity === 0 ? [] : arity === 1 ? [tp("T", -1)] : [tp("T", -1), tp("U", -2)];
        return [name, { arity, members: formatMembers(genMembers({ name, args })) }];
      }),
    ),
    opaqueTypes: Object.fromEntries([...OPAQUE_NAMES].map((name) => [name, formatMembers(opaqueMembers(name))])),
    string: formatMembers(stringMembers()),
  };
}

function readResource(uri: unknown) {
  if (typeof uri !== "string" || !uri) throw new RpcError(-32602, "resources/read requires non-empty string 'uri'");
  if (uri === "szigyr://spec") {
    const text = readFileSync(new URL("../../../docs/SPEC.md", import.meta.url), "utf8");
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  }
  if (uri === "szigyr://builtins") {
    const text = JSON.stringify(buildBuiltinsCatalog(), null, 2);
    return { contents: [{ uri, mimeType: "application/json", text }] };
  }
  throw new RpcError(-32602, `unknown resource '${uri}'`);
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
    const applied = applyOverlays(parser, file, content, overlays);
    try { return fn(); } finally {
      for (const p of applied) parser.clearOverlay?.(p);
    }
  };

  const parseTargetWithOverlays = (tool: string, args: Record<string, unknown>) => {
    const file = args.file;
    const content = args.content;
    const overlays = parseOverlays(args.overlays);
    if (typeof file !== "string" || !file) throw new RpcError(-32602, `'${tool}' requires non-empty string 'file'`);
    if (content !== undefined && typeof content !== "string") throw new RpcError(-32602, `'${tool}' 'content' must be a string`);
    const resolvedFile = resolve(file);
    const inOverlays = content !== undefined || (overlays !== undefined && Object.keys(overlays).some((k) => resolve(k) === resolvedFile));
    return { file, content: content as string | undefined, overlays, resolvedFile, inOverlays };
  };

  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (name === "szigyr_check" || name === "szigyr_query") {
      const { file, content, overlays, resolvedFile, inOverlays } = parseTargetWithOverlays(name, args);
      if (!inOverlays && !existsSync(file)) return okTool({ ok: false, error: `no such file: ${file}` }, true);
      const t0 = performance.now();
      if (name === "szigyr_check") {
        const diagnostics = withOverlays(file, content, overlays, () => check(file, parser));
        const durationMs = +(performance.now() - t0).toFixed(2);
        return okTool({
          ok: diagnostics.every((d) => d.severity !== "error"),
          file: relative(process.cwd(), resolvedFile) || resolvedFile,
          diagnostics,
          durationMs,
        });
      }
      const q = withOverlays(file, content, overlays, () => queryFile(file, parser));
      const durationMs = +(performance.now() - t0).toFixed(2);
      return okTool({ ok: q.diagnostics.every((d) => d.severity !== "error"), ...q, durationMs });
    }
    if (name === "szigyr_explain") {
      const code = args.code;
      if (typeof code !== "string" || !code) throw new RpcError(-32602, "'szigyr_explain' requires non-empty string 'code'");
      const entry = explainCode(code);
      if (!entry) return okTool({ error: `unknown diagnostic or trap code '${code}'` }, true);
      return okTool(entry);
    }
    if (name === "szigyr_test" || name === "szigyr_run") {
      const { file, content, overlays, inOverlays } = parseTargetWithOverlays(name, args);
      const backend = (args.backend ?? "js") as string;
      const timeoutMs = parseTimeoutMs(args.timeoutMs, name);
      if (!["js", "c", "wasm", "both", "all"].includes(backend)) throw new RpcError(-32602, `unknown backend '${backend}'`);
      if (!inOverlays && !existsSync(file)) return okTool({ ok: false, error: `no such file: ${file}` }, true);
      return await runWorker({
        op: name === "szigyr_run" ? "run" : "test",
        file,
        backend,
        ...(content !== undefined ? { content } : {}),
        ...(overlays !== undefined ? { overlays } : {}),
      }, timeoutMs);
    }
    if (name === "szigyr_mutate") {
      const file = args.file;
      const noCache = args.noCache;
      const all = args.all;
      const failOnSurvived = args.failOnSurvived;
      const timeoutMs = parseTimeoutMs(args.timeoutMs, name);
      if (typeof file !== "string" || !file) throw new RpcError(-32602, "'szigyr_mutate' requires non-empty string 'file'");
      if (noCache !== undefined && typeof noCache !== "boolean") throw new RpcError(-32602, "'szigyr_mutate' 'noCache' must be a boolean");
      if (all !== undefined && typeof all !== "boolean") throw new RpcError(-32602, "'szigyr_mutate' 'all' must be a boolean");
      if (failOnSurvived !== undefined && typeof failOnSurvived !== "boolean") throw new RpcError(-32602, "'szigyr_mutate' 'failOnSurvived' must be a boolean");
      if (!existsSync(file)) return okTool({ ok: false, error: `no such file: ${file}` }, true);
      return await runWorker({
        op: "mutate",
        file,
        noCache: !!noCache,
        ...(all ? { all: true } : {}),
        ...(failOnSurvived ? { failOnSurvived: true } : {}),
      }, timeoutMs);
    }
    if (name === "szigyr_prove") {
      const { file, content, overlays, inOverlays } = parseTargetWithOverlays(name, args);
      const noCache = args.noCache;
      const all = args.all;
      const strict = args.strict;
      const proveTimeoutMs = args.proveTimeoutMs;
      const timeoutMs = parseTimeoutMs(args.timeoutMs, name);
      if (noCache !== undefined && typeof noCache !== "boolean") throw new RpcError(-32602, "'szigyr_prove' 'noCache' must be a boolean");
      if (all !== undefined && typeof all !== "boolean") throw new RpcError(-32602, "'szigyr_prove' 'all' must be a boolean");
      if (strict !== undefined && typeof strict !== "boolean") throw new RpcError(-32602, "'szigyr_prove' 'strict' must be a boolean");
      if (proveTimeoutMs !== undefined && (typeof proveTimeoutMs !== "number" || !Number.isInteger(proveTimeoutMs) || proveTimeoutMs < 1 || proveTimeoutMs > 60_000)) {
        throw new RpcError(-32602, "'szigyr_prove' 'proveTimeoutMs' must be a finite integer in [1, 60000]");
      }
      if (!inOverlays && !existsSync(file)) return okTool({ ok: false, error: `no such file: ${file}` }, true);
      return await runWorker({
        op: "prove",
        file,
        noCache: !!noCache,
        ...(all ? { all: true } : {}),
        ...(strict ? { strict: true } : {}),
        ...(proveTimeoutMs !== undefined ? { proveTimeoutMs } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(overlays !== undefined ? { overlays } : {}),
      }, timeoutMs);
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
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: CLI_NAME, version: "1.0.0" },
          };
        } else if (method === "ping") {
          result = {};
        } else if (method === "tools/list") {
          result = { tools: TOOLS };
        } else if (method === "resources/list") {
          result = { resources: RESOURCES };
        } else if (method === "resources/read") {
          result = readResource(params.uri);
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
