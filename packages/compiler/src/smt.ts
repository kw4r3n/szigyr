// Stage 6 SMT-LIB2 solver adapter: external `z3` / `cvc5` (`SZIGYR_SMT` override) with `z3-solver` Wasm fallback.
import { execFileSync, spawn } from "node:child_process";
import { basename } from "node:path";

export type SmtStatus = "unsat" | "sat" | "unknown" | "timeout" | "error";
export type SmtValue = string | number | boolean;

export interface SmtQuery {
  readonly assertion: string;
  /** Maps user-facing variable name -> SMT symbol name. */
  readonly modelVars?: ReadonlyMap<string, string>;
}

export interface SmtCheckResult {
  readonly status: SmtStatus;
  readonly model?: Record<string, SmtValue>;
  readonly error?: string;
}

export interface SmtSolverInfo {
  readonly kind: "z3" | "cvc5" | "z3-wasm" | "custom";
  readonly id: string;
  readonly cmd?: string;
}

export interface SmtBatchOptions {
  readonly timeoutMs?: number;
  readonly logic?: "QF_LIA" | "QF_NIA";
}

const binProbeCache = new Map<string, { ok: boolean; id: string }>();

function probeBinary(cmd: string): { ok: boolean; id: string } {
  const cached = binProbeCache.get(cmd);
  if (cached) return cached;
  try {
    const out = execFileSync(cmd, ["--version"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const first = out.trim().split(/\r?\n/)[0]?.trim() || basename(cmd);
    const res = { ok: true, id: first };
    binProbeCache.set(cmd, res);
    return res;
  } catch {
    const res = { ok: false, id: "" };
    binProbeCache.set(cmd, res);
    return res;
  }
}

function inferKind(cmd: string): SmtSolverInfo["kind"] {
  const b = basename(cmd).toLowerCase();
  if (b.includes("z3")) return "z3";
  if (b.includes("cvc5")) return "cvc5";
  return "custom";
}

/** Detects which SMT solver backend is active (respecting `SZIGYR_SMT`). */
export function detectSolver(): SmtSolverInfo {
  const env = process.env.SZIGYR_SMT?.trim();
  if (env) {
    if (env.toLowerCase() === "wasm") return { kind: "z3-wasm", id: "z3-wasm@5.4.1" };
    const kind = inferKind(env);
    const probed = probeBinary(env);
    return { kind, cmd: env, id: probed.ok ? probed.id : basename(env) };
  }
  const z3 = probeBinary("z3");
  if (z3.ok) return { kind: "z3", cmd: "z3", id: z3.id };
  const cvc5 = probeBinary("cvc5");
  if (cvc5.ok) return { kind: "cvc5", cmd: "cvc5", id: cvc5.id };
  return { kind: "z3-wasm", id: "z3-wasm@5.4.1" };
}

type Z3WasmModule = Awaited<ReturnType<(typeof import("z3-solver"))["init"]>>;
let wasmPromise: Promise<Z3WasmModule> | undefined;
let wasmApi: Z3WasmModule | undefined;
let wasmQueue: Promise<unknown> = Promise.resolve();

async function getWasm(): Promise<Z3WasmModule> {
  if (wasmApi) return wasmApi;
  if (!wasmPromise) {
    wasmPromise = import("z3-solver").then((m) => m.init()).then((api) => {
      wasmApi = api;
      return api;
    });
  }
  return wasmPromise;
}

/** Terminates `z3-solver` background Emscripten pthreads so Node/CLI processes can exit cleanly. */
export async function shutdownSmt(): Promise<void> {
  const p = wasmPromise;
  const api = wasmApi;
  wasmPromise = undefined;
  wasmApi = undefined;
  wasmQueue = Promise.resolve();
  try {
    const resolved = api ?? (p ? await p : undefined);
    if (resolved) {
      const m = await import("z3-solver");
      await m.killThreads(resolved.em);
    }
  } catch {
    // Ignore errors during teardown if WASM failed to init
  }
}

function runExternal(solver: SmtSolverInfo, script: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  const cmd = solver.cmd!;
  const args = solver.kind === "cvc5"
    ? ["--lang=smt2", `--tlimit=${timeoutMs}`, "--produce-models", "-"]
    : ["-smt2", "-in"];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs + 2000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { stdout += d; });
    child.stderr.on("data", (d: string) => { stderr += d; });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${e.message}`, timedOut });
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut });
    });
    child.stdin.end(script);
  });
}

const utf8 = new TextEncoder();

async function evalWasmSmtLib2(wasm: Z3WasmModule, ctx: unknown, script: string): Promise<string> {
  // z3-solver@5.4.1's eval_smtlib2_string passes str via ccall (stringToUTF8OnStack), which restores the Emscripten C stack before the async pthread reads it.
  const em = wasm.em as {
    _malloc?: (n: number) => number;
    _free?: (p: number) => void;
    HEAPU8?: Uint8Array;
    async_call?: <T>(fn: () => void) => Promise<T>;
    _async_Z3_eval_smtlib2_string?: (ctx: number, ptr: number) => void;
  };
  if (em._malloc && em._free && em.HEAPU8 && em.async_call && em._async_Z3_eval_smtlib2_string) {
    const bytes = utf8.encode(`${script}\0`);
    const ptr = em._malloc(bytes.length);
    if (!ptr) throw new Error("z3-wasm: malloc failed");
    em.HEAPU8.set(bytes, ptr);
    try {
      return await em.async_call<string>(() => em._async_Z3_eval_smtlib2_string!(ctx as number, ptr));
    } finally {
      em._free(ptr);
    }
  }
  return await wasm.Z3.eval_smtlib2_string(ctx as Parameters<Z3WasmModule["Z3"]["eval_smtlib2_string"]>[0], script);
}

function runWasm(script: string): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  const task = wasmQueue.then(async () => {
    const wasm = await getWasm();
    const { Z3 } = wasm;
    const cfg = Z3.mk_config();
    const ctx = Z3.mk_context(cfg);
    Z3.del_config(cfg);
    try {
      const stdout = await evalWasmSmtLib2(wasm, ctx, script);
      return { stdout, stderr: "", timedOut: false };
    } finally {
      Z3.del_context(ctx);
    }
  });
  wasmQueue = task.catch(() => undefined);
  return task;
}

type SExpr = string | SExpr[];

function tokenizeSExpr(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch <= " ") { i++; continue; }
    if (ch === ";") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "(" || ch === ")") { tokens.push(ch); i++; continue; }
    if (ch === "|") {
      const start = i++;
      while (i < src.length && src[i] !== "|") i++;
      if (i < src.length) i++;
      tokens.push(src.slice(start, i));
      continue;
    }
    if (ch === "\"") {
      const start = i++;
      while (i < src.length) {
        if (src[i] === "\"" && src[i + 1] === "\"") { i += 2; continue; }
        if (src[i] === "\"") { i++; break; }
        i++;
      }
      tokens.push(src.slice(start, i));
      continue;
    }
    const start = i;
    while (i < src.length && src[i]! > " " && src[i] !== "(" && src[i] !== ")" && src[i] !== ";") i++;
    tokens.push(src.slice(start, i));
  }
  return tokens;
}

function parseSExprs(src: string): SExpr[] {
  const tokens = tokenizeSExpr(src);
  let pos = 0;
  const parseOne = (): SExpr => {
    const tok = tokens[pos++]!;
    if (tok !== "(") return tok;
    const items: SExpr[] = [];
    while (pos < tokens.length && tokens[pos] !== ")") items.push(parseOne());
    if (tokens[pos] === ")") pos++;
    return items;
  };
  const out: SExpr[] = [];
  while (pos < tokens.length) out.push(parseOne());
  return out;
}

function decodeSmtValue(v: SExpr): SmtValue | undefined {
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^\d+$/.test(v)) {
      const bi = BigInt(v);
      return bi <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bi) : v;
    }
    if (v.startsWith("\"") && v.endsWith("\"")) return v.slice(1, -1);
    return v;
  }
  if (v.length === 2 && v[0] === "-" && typeof v[1] === "string" && /^\d+$/.test(v[1])) {
    const bi = -BigInt(v[1]);
    return bi >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(bi) : bi.toString();
  }
  return undefined;
}

function decodeValueList(pairList: SExpr[], symToName: ReadonlyMap<string, string>): Record<string, SmtValue> {
  const out: Record<string, SmtValue> = {};
  for (const pair of pairList) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") continue;
    const rawSym = pair[0].startsWith("|") && pair[0].endsWith("|") ? pair[0].slice(1, -1) : pair[0];
    const name = symToName.get(rawSym) ?? symToName.get(pair[0]);
    if (!name) continue;
    const val = decodeSmtValue(pair[1]!);
    if (val !== undefined) out[name] = val;
  }
  return out;
}

/** Parses SMT-LIB2 `(get-value (...))` output into `displayName -> value`. */
export function parseGetValue(output: string, symToName: ReadonlyMap<string, string>): Record<string, SmtValue> {
  const out: Record<string, SmtValue> = {};
  for (const expr of parseSExprs(output)) {
    if (Array.isArray(expr)) Object.assign(out, decodeValueList(expr, symToName));
  }
  return out;
}

function buildHeader(solver: SmtSolverInfo, logic: "QF_LIA" | "QF_NIA", timeoutMs: number, withModels: boolean): string[] {
  const lines: string[] = [];
  if (withModels) lines.push("(set-option :produce-models true)");
  lines.push(`(set-logic ${logic})`);
  if (solver.kind === "z3" || solver.kind === "z3-wasm") lines.push(`(set-option :timeout ${Math.max(1, Math.floor(timeoutMs))})`);
  return lines;
}

function parseBatchStatuses(stdout: string, count: number): { statuses: SmtStatus[]; errors: string[] } {
  const statuses: SmtStatus[] = [];
  const errors: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "unsat" || line === "sat" || line === "unknown") {
      statuses.push(line);
    } else if (line.startsWith("(:reason-unknown")) {
      if (statuses.at(-1) === "unknown" && /timeout|canceled/i.test(line)) {
        statuses[statuses.length - 1] = "timeout";
      }
    } else if (line.startsWith("(error")) {
      errors.push(line);
      statuses.push(/timeout|canceled/i.test(line) ? "timeout" : "error");
    }
  }
  while (statuses.length < count) statuses.push("error");
  return { statuses: statuses.slice(0, count), errors };
}

/** Runs a batch of verification queries against one shared SMT preamble, lazily fetching models for `sat` queries. */
export async function runSmtBatch(
  preamble: string,
  queries: readonly SmtQuery[],
  opts: SmtBatchOptions = {},
): Promise<SmtCheckResult[]> {
  if (!queries.length) return [];
  const solver = detectSolver();
  const timeoutMs = opts.timeoutMs ?? 2000;
  const logic = opts.logic ?? "QF_LIA";
  const isZ3 = solver.kind === "z3" || solver.kind === "z3-wasm";
  const run = (script: string) => (solver.kind === "z3-wasm" ? runWasm(script) : runExternal(solver, script, timeoutMs));

  const phase1 = [
    ...buildHeader(solver, logic, timeoutMs, false),
    preamble,
    ...queries.map((q) => `(push 1)\n(assert ${q.assertion})\n(check-sat)${isZ3 ? "\n(get-info :reason-unknown)" : ""}\n(pop 1)`),
    "",
  ].join("\n");

  const r1 = await run(phase1);
  if (r1.timedOut) return queries.map(() => ({ status: "timeout" }));

  const { statuses, errors } = parseBatchStatuses(r1.stdout, queries.length);
  const results: SmtCheckResult[] = statuses.map((status, i) => ({
    status,
    ...(status === "error" && (errors[i] ?? errors[0] ?? r1.stderr.trim()) ? { error: errors[i] ?? errors[0] ?? r1.stderr.trim() } : {}),
  }));

  const satQueries = queries
    .map((q, i) => ({ q, i }))
    .filter(({ q, i }) => statuses[i] === "sat" && q.modelVars && q.modelVars.size > 0);
  if (!satQueries.length) return results;

  const modelScript = [
    ...buildHeader(solver, logic, timeoutMs, true),
    preamble,
    ...satQueries.map(({ q }) => {
      const syms = [...q.modelVars!.values()];
      return `(push 1)\n(assert ${q.assertion})\n(check-sat)\n(get-value (${syms.join(" ")}))\n(pop 1)`;
    }),
    "",
  ].join("\n");

  const r2 = await run(modelScript);
  const sexprs = parseSExprs(r2.stdout);
  let cursor = 0;
  for (const { q, i } of satQueries) {
    while (cursor < sexprs.length) {
      const tok = sexprs[cursor++];
      if (typeof tok === "string" && (tok === "sat" || tok === "unsat" || tok === "unknown")) {
        if (tok === "sat" && cursor < sexprs.length && Array.isArray(sexprs[cursor])) {
          const symToName = new Map<string, string>();
          for (const [disp, sym] of q.modelVars!) symToName.set(sym, disp);
          results[i] = { status: "sat", model: decodeValueList(sexprs[cursor++] as SExpr[], symToName) };
        }
        break;
      }
    }
  }
  return results;
}
