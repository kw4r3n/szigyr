// Incremental watch loop for `szigyr check --watch` and `szigyr test --watch`.
import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { dedupeDiagnostics, type Diagnostic } from "./diagnostics.ts";
import { analyze, createParser, runTestFile, type Backend, type Parser } from "./index.ts";
import { canonPath } from "./modules.ts";

export interface WatchCycleInfo {
  readonly ok: boolean;
  readonly errors: number;
  readonly durationMs: number;
}

export interface WatchOptions {
  readonly files: string[];
  readonly mode: "check" | "test";
  readonly json: boolean;
  readonly backends: Backend[];
  readonly all?: boolean;
  readonly filter?: string;
  readonly out: (s: string) => void;
  readonly err?: (s: string) => void;
  readonly parser?: Parser;
  readonly debounceMs?: number;
  readonly signal?: AbortSignal;
  readonly onCycle?: (info: WatchCycleInfo) => void;
}

export interface TestPassParams {
  readonly files: string[];
  readonly backends: Backend[];
  readonly json: boolean;
  readonly all?: boolean;
  readonly filter?: string;
  readonly out: (s: string) => void;
  readonly diags: (ds: readonly Diagnostic[]) => string;
  readonly parser: Parser;
}

export interface TestPassResult {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly bad: boolean;
  readonly dirs: string[];
}

const jsonLine = (o: unknown): string => `${JSON.stringify(o)}\n`;

/** Executes one `test` pass over `files` and `backends`, shared by CLI `test` and `watch`. */
export async function runTestPass(params: TestPassParams): Promise<TestPassResult> {
  const { files, backends, json, all, filter, out, diags, parser } = params;
  let failed = 0, passed = 0, skipped = 0, bad = false;
  const dirs = new Set<string>();
  const seenByBackend = backends.map(() => new Set<string>());
  for (const f of files) {
    dirs.add(dirname(canonPath(f)));
    const rs: Awaited<ReturnType<typeof runTestFile>>[] = [];
    let diag = false;
    const analysis = analyze(f, parser);
    for (const pf of analysis.files) dirs.add(dirname(pf.path));
    for (const [k, b] of backends.entries()) {
      const cur = await runTestFile(f, {
        backend: b,
        analysis,
        ...(all ? { all: true, skipTestFiles: seenByBackend[k] } : {}),
        ...(filter !== undefined ? { filter } : {}),
      });
      if (cur.diagnostics.length) { out(diags(cur.diagnostics)); bad = true; diag = true; break; }
      if (all) for (const pf of analysis.files) seenByBackend[k]!.add(pf.path);
      rs.push(cur);
    }
    if (diag) continue;
    const r = rs[0]!;
    skipped += r.skipped ?? 0;
    // D101: --backend=both / --backend=all compares each test's outcome, trap code and position; a trap's message is not compared.
    const key = (t: (typeof r.results)[number] | undefined): string => JSON.stringify(t && [t.name, t.ok, t.trap ? null : t.failure, t.trap?.code, t.pos?.file, t.pos?.line, t.pos?.col]);
    if (rs.length >= 2 && rs.some((cur) => cur.results.length !== r.results.length)) { // Q266: a result count that differs is a mismatch too
      failed++;
      const counts = Object.fromEntries(backends.map((b, k) => [b, rs[k]!.results.length]));
      out(json
        ? jsonLine({ kind: "mismatch", file: f, ...counts })
        : `MISMATCH ${f}: backend test count differs (${backends.map((b, k) => `${b}=${rs[k]!.results.length}`).join(", ")})\n`);
    }
    for (const [i, t] of r.results.entries()) {
      const outFile = all && t.file && canonPath(t.file) !== canonPath(f) ? t.file : f;
      if (rs.length >= 2 && rs.slice(1).some((cur) => key(t) !== key(cur.results[i]))) {
        failed++;
        const resultsByBackend = Object.fromEntries(backends.map((b, k) => [b, rs[k]!.results[i] ?? null]));
        const label = backends.length === 2 ? "js and c" : "js, c, and wasm";
        const pad = Math.max(...backends.map((b) => b.length)) + 1;
        const fmtRes = (res: (typeof r.results)[number] | undefined) =>
          res ? (res.ok ? "ok" : `FAIL ${res.failure ?? res.trap?.code ?? ""}`) : "missing";
        out(json
          ? jsonLine({ kind: "mismatch", file: outFile, name: t.name, ...resultsByBackend })
          : `MISMATCH ${all && outFile !== f ? `${outFile} > ` : ""}${t.name}: ${label} backends disagree\n${backends.map((b, k) => `  ${(`${b}:`).padEnd(pad)} ${fmtRes(rs[k]!.results[i])}`).join("\n")}\n`);
        continue;
      }
      if (t.ok) passed++; else failed++;
      const pos = t.pos ? { file: t.pos.file, line: t.pos.line, col: t.pos.col } : undefined;
      out(json ? jsonLine({ kind: "test", file: outFile, name: t.name, ok: t.ok, ...(t.failure ? { failure: t.failure } : {}), ...(t.trap ? { trap: t.trap.code } : {}), ...(pos ? { pos } : {}), ...(t.detail ? { detail: t.detail } : {}) })
        : `${t.ok ? "ok" : "FAIL"} ${all && outFile !== f ? `${outFile} > ` : ""}${t.name}${t.ok ? "" : `: ${t.failure ?? ""}${pos ? ` (${pos.file}:${pos.line}:${pos.col})` : ""}`}\n`);
    }
  }
  out(json ? jsonLine({ kind: "summary", passed, failed, ...(skipped ? { skipped } : {}) }) : `${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}\n`);
  return { passed, failed, skipped, bad, dirs: [...dirs] };
}

/** Runs an incremental resident `check` / `test` watch loop until aborted or signaled. */
export async function startWatch(opts: WatchOptions): Promise<number> {
  const { files, mode, json, backends, all, filter, out } = opts;
  const debounceMs = opts.debounceMs ?? 30;
  const parser = opts.parser ?? createParser();
  const ownParser = !opts.parser;
  const diags = (ds: readonly Diagnostic[]): string => ds.map((d) =>
    json ? jsonLine({ kind: "diagnostic", ...d }) : `${d.file}:${d.range.start.line}:${d.range.start.col}: ${d.severity} ${d.code}: ${d.message}\n`,
  ).join("");

  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let queued = false;
  let stopped = !!opts.signal?.aborted;
  let finish!: () => void;
  const done = new Promise<void>((r) => { finish = r; });

  const schedule = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void kick();
    }, debounceMs);
  };

  const syncWatches = (dirs: Set<string>): void => {
    for (const [d, w] of watchers) {
      if (!dirs.has(d)) { try { w.close(); } catch { /* ignored */ } watchers.delete(d); }
    }
    for (const d of dirs) {
      if (watchers.has(d)) continue;
      try {
        const w = watch(d, { persistent: true }, (_ev, filename) => {
          if (!filename || String(filename).endsWith(".szigyr")) schedule();
        });
        w.on("error", () => { /* directory may have vanished */ });
        watchers.set(d, w);
      } catch {
        /* ignore unreadable dirs until restored */
      }
    }
  };

  const runCycle = async (): Promise<void> => {
    const t0 = performance.now();
    if (json) out(jsonLine({ kind: "watch-start", mode, files }));
    const dirs = new Set<string>(files.map((f) => dirname(canonPath(f))));
    let errors = 0;
    if (mode === "check") {
      const all: Diagnostic[] = [];
      for (const f of files) {
        const a = analyze(f, parser);
        for (const pf of a.files) dirs.add(dirname(pf.path));
        all.push(...a.diagnostics, ...(a.warnings ?? []));
      }
      const deduped = dedupeDiagnostics(all);
      if (deduped.length) out(diags(deduped));
      errors = deduped.filter((d) => d.severity === "error").length;
    } else {
      const res = await runTestPass({ files, backends, json, ...(all ? { all: true } : {}), ...(filter !== undefined ? { filter } : {}), out, diags, parser });
      for (const d of res.dirs) dirs.add(d);
      errors = res.failed + (res.bad ? 1 : 0);
    }
    syncWatches(dirs);
    const durationMs = +(performance.now() - t0).toFixed(2);
    const ok = errors === 0;
    out(json
      ? jsonLine({ kind: "watch-done", mode, ok, errors, durationMs })
      : `[watch] ${ok ? "ok" : `${errors} error(s)`} (${durationMs}ms)\n`);
    opts.onCycle?.({ ok, errors, durationMs });
  };

  const kick = async (): Promise<void> => {
    if (stopped) return;
    if (running) { queued = true; return; }
    running = true;
    try {
      await runCycle();
    } finally {
      running = false;
      if (stopped) finish();
      else if (queued) { queued = false; schedule(); }
    }
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (!running) finish();
  };

  opts.signal?.addEventListener("abort", stop, { once: true });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (!stopped) {
      await kick();
      if (!stopped) await done;
    }
  } finally {
    opts.signal?.removeEventListener("abort", stop);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (timer) clearTimeout(timer);
    for (const w of watchers.values()) try { w.close(); } catch { /* ignored */ }
    watchers.clear();
    if (ownParser) parser.close();
  }
  return 0;
}
