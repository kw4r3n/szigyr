#!/usr/bin/env node
// CLI (Q060, Q061, Q110). Exit codes: 0 ok, 1 compile errors or failed tests, 2 usage / CLI error, 3 trap, 70 internal error (Q252).
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { analyze, buildBrowser, buildNode, check, CLI_NAME, CliError, createParser, explainCode, mutate, prove, queryFile, run, shutdownSmt, type Backend, type BrowserBuildMode, type Diagnostic, type NodeBuildBackend, type NodeBuildMode, type RunResult } from "./index.ts";
import { dedupeDiagnostics } from "./diagnostics.ts";
import { serveMcp } from "./mcp.ts";
import { serveLsp } from "./lsp.ts";
import { runTestPass, startWatch } from "./watch.ts";
import { CUnsupported } from "./emit-c.ts";
import { CBuildError } from "./native.ts";

const USAGE = `usage: ${CLI_NAME} <check|run|test|mutate|prove|query|explain|build|mcp|lsp> [--json] [--watch] [--fix] [--no-cache] [--all] [--filter=<pat>] [--strict] [--timeout=<ms>] [--fail-on-survived] [--backend=js|c|both|wasm|all] [--target=node|browser] [--mode=app|lib] [--release] [-o <dir>] <file...|code...>`;

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (ch === 10 || ch === 0x2028 || ch === 0x2029) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function toOffset(starts: readonly number[], textLen: number, line: number, col: number): number | undefined {
  if (line < 1 || line > starts.length || col < 1) return undefined;
  const off = starts[line - 1]! + col - 1;
  return off >= 0 && off <= textLen ? off : undefined;
}

export function applyDiagnosticFixes(diagnostics: readonly Diagnostic[]): { file: string; applied: number }[] {
  const byFile = new Map<string, { display: string; fixes: NonNullable<Diagnostic["fixes"]>[number][] }>();
  for (const d of diagnostics) {
    const fix = d.fixes?.[0];
    if (!fix?.edits.length) continue;
    const absPath = resolve(d.file);
    let entry = byFile.get(absPath);
    if (!entry) byFile.set(absPath, entry = { display: d.file, fixes: [] });
    entry.fixes.push(fix);
  }
  const editsOverlap = (a: { startOff: number; endOff: number }, b: { startOff: number; endOff: number }): boolean =>
    a.startOff === b.startOff && a.endOff === b.endOff
      ? true
      : a.startOff < b.endOff && b.startOff < a.endOff;
  const results: { file: string; applied: number }[] = [];
  for (const [absPath, { display, fixes }] of byFile) {
    const text = readFileSync(absPath, "utf8");
    const starts = lineStartsOf(text);
    const acceptedKeys = new Set<string>();
    const accepted: { startOff: number; endOff: number; newText: string }[] = [];
    for (const fix of fixes) {
      const unique: { startOff: number; endOff: number; newText: string; key: string }[] = [];
      const seenInFix = new Set<string>();
      let ok = true;
      for (const e of fix.edits) {
        const startOff = toOffset(starts, text.length, e.range.start.line, e.range.start.col);
        const endOff = toOffset(starts, text.length, e.range.end.line, e.range.end.col);
        if (startOff === undefined || endOff === undefined || endOff < startOff) { ok = false; break; }
        const key = `${startOff}:${endOff}:${e.newText}`;
        if (seenInFix.has(key)) continue;
        seenInFix.add(key);
        unique.push({ startOff, endOff, newText: e.newText, key });
      }
      if (!ok) continue;
      const novel = unique.filter((r) => !acceptedKeys.has(r.key));
      if (!novel.length) continue;
      const selfClash = unique.some((a, i) => unique.some((b, j) => i < j && editsOverlap(a, b)));
      const accClash = !selfClash && novel.some((a) => accepted.some((b) => editsOverlap(a, b)));
      if (selfClash || accClash) continue;
      for (const r of novel) {
        acceptedKeys.add(r.key);
        accepted.push({ startOff: r.startOff, endOff: r.endOff, newText: r.newText });
      }
    }
    if (!accepted.length) continue;
    accepted.sort((a, b) => a.startOff - b.startOff || a.endOff - b.endOff);
    let updated = text;
    for (let i = accepted.length - 1; i >= 0; i--) {
      const e = accepted[i]!;
      updated = updated.slice(0, e.startOff) + e.newText + updated.slice(e.endOff);
    }
    writeFileSync(absPath, updated, "utf8");
    results.push({ file: display, applied: accepted.length });
  }
  return results;
}

export async function main(argv: string[], out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const rawJson = argv.includes("--json");
  const dashIdx = argv.indexOf("--");
  const parseOpts = (raw: string[]) => parseArgs({
    args: raw, allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      watch: { type: "boolean", short: "w" },
      fix: { type: "boolean" },
      "no-cache": { type: "boolean" },
      all: { type: "boolean" },
      filter: { type: "string" },
      strict: { type: "boolean" },
      release: { type: "boolean" },
      timeout: { type: "string" },
      "fail-on-survived": { type: "boolean" },
      backend: { type: "string" },
      target: { type: "string" },
      mode: { type: "string", default: "app" },
      "out-dir": { type: "string", short: "o", default: "dist" },
    },
  });
  let args;
  try {
    args = parseOpts(dashIdx >= 0 ? argv.slice(0, dashIdx) : argv);
    if (dashIdx >= 0 && args.positionals[0] !== "run") args = parseOpts(argv);
  } catch (e) {
    err(rawJson ? `${JSON.stringify({ kind: "error", code: "CLI_USAGE", message: (e as Error).message, usage: USAGE })}\n` : `${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (args.values.help) {
    out(`${USAGE}\n`);
    return 0;
  }
  const [cmd, ...files] = args.positionals;
  const progArgs = dashIdx >= 0 && cmd === "run" ? argv.slice(dashIdx + 1) : [];
  const json = !!args.values.json;
  const watch = !!args.values.watch;
  const fix = !!args.values.fix;
  const noCache = !!args.values["no-cache"];
  const all = !!args.values.all;
  const filter = args.values.filter as string | undefined;
  const strict = !!args.values.strict;
  const release = !!args.values.release;
  const rawTimeout = args.values.timeout as string | undefined;
  const failOnSurvived = !!args.values["fail-on-survived"];
  const rawBackend = args.values.backend as string | undefined;
  const target = args.values.target as string | undefined;
  const backend = rawBackend ?? (cmd === "build" && target === "node" ? "c" : "js");
  const mode = args.values.mode as string;
  const outDir = args.values["out-dir"] as string;
  const backends: Backend[] = backend === "all" ? ["js", "c", "wasm"] : backend === "both" ? ["js", "c"] : [backend as Backend];
  const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
  const diags = (ds: readonly Diagnostic[]): string => ds.map((d) => json ? line({ kind: "diagnostic", ...d }) : `${d.file}:${d.range.start.line}:${d.range.start.col}: ${d.severity} ${d.code}: ${d.message}\n`).join("");
  const parser = createParser(); // D161: one tsgo process for every file of this command (spawned on first use)
  try {
    if (cmd !== "check" && cmd !== "run" && cmd !== "test" && cmd !== "mutate" && cmd !== "prove" && cmd !== "query" && cmd !== "explain" && cmd !== "build" && cmd !== "mcp" && cmd !== "lsp") {
      throw new CliError(cmd ? `unknown command '${cmd}'\n${USAGE}` : USAGE);
    }
    let timeoutMs: number | undefined;
    if (rawTimeout !== undefined) {
      if (!/^\d+$/.test(rawTimeout) || Number(rawTimeout) <= 0 || Number(rawTimeout) > 2_147_483_647) {
        throw new CliError(`--timeout must be a positive integer (ms, <= 2147483647), got '${rawTimeout}'\n${USAGE}`);
      }
      timeoutMs = Number(rawTimeout);
    }
    if (cmd === "mcp" || cmd === "lsp") {
      if (files.length || rawBackend !== undefined || noCache || watch || fix || all || filter !== undefined || strict || release || rawTimeout !== undefined || failOnSurvived || target !== undefined) {
        throw new CliError(`${cmd}: takes no positional arguments or build/watch/backend flags\n${USAGE}`);
      }
    } else if (cmd === "explain") {
      if (!files.length) throw new CliError(`explain: at least one code required\n${USAGE}`);
    } else if (!files.length || ((cmd === "run" || cmd === "build") && files.length > 1)) {
      throw new CliError(`${cmd}: ${cmd === "run" || cmd === "build" ? "exactly one" : "at least one"} file required\n${USAGE}`);
    }
    if (watch && cmd !== "check" && cmd !== "test") throw new CliError(`${cmd}: --watch is only supported for check and test\n${USAGE}`);
    if (fix && cmd !== "check") throw new CliError(`${cmd}: --fix is only supported for check\n${USAGE}`);
    if (fix && watch) throw new CliError(`check: --fix cannot be combined with --watch\n${USAGE}`);
    if (!["js", "c", "both", "wasm", "all"].includes(backend)) throw new CliError(`unknown backend '${backend}'\n${USAGE}`);
    if ((cmd === "mutate" || cmd === "query" || cmd === "explain") && backend !== "js") throw new CliError(`${cmd}: JS backend only (--backend=${backend} is not supported)\n${USAGE}`);
    if (cmd === "prove" && (rawBackend !== undefined || watch || fix || failOnSurvived || target !== undefined || release)) {
      throw new CliError(`prove: unsupported flag(s)\n${USAGE}`);
    }
    if (release && cmd !== "build") throw new CliError(`${cmd}: --release is only supported for build\n${USAGE}`);
    if (strict && cmd !== "prove") throw new CliError(`${cmd}: --strict is only supported for prove\n${USAGE}`);
    if (rawTimeout !== undefined && cmd !== "prove" && cmd !== "build") throw new CliError(`${cmd}: --timeout is only supported for prove and build\n${USAGE}`);
    if (noCache && cmd !== "mutate" && cmd !== "prove" && !(cmd === "build" && release)) throw new CliError(`${cmd}: --no-cache is only supported for mutate, prove, and build --release\n${USAGE}`);
    if (all && cmd !== "test" && cmd !== "mutate" && cmd !== "prove") throw new CliError(`${cmd}: --all is only supported for test, mutate, and prove\n${USAGE}`);
    if (filter !== undefined && cmd !== "test") throw new CliError(`${cmd}: --filter is only supported for test\n${USAGE}`);
    if (filter === "") throw new CliError(`test: --filter requires a non-empty pattern\n${USAGE}`);
    if (failOnSurvived && cmd !== "mutate") throw new CliError(`${cmd}: --fail-on-survived is only supported for mutate\n${USAGE}`);
    if (cmd === "build") {
      if (target !== "browser" && target !== "node") throw new CliError(`build: missing or unknown --target '${target ?? ""}' (expected --target=node or --target=browser)\n${USAGE}`);
      if (mode !== "app" && mode !== "lib") throw new CliError(`build: unknown --mode '${mode}' (expected app or lib)\n${USAGE}`);
      if (target === "browser" && rawBackend !== undefined) throw new CliError(`build: --backend is not supported with --target=browser\n${USAGE}`);
      if (target === "node" && !["c", "js", "wasm"].includes(backend)) throw new CliError(`build: --backend=${backend} is not supported with --target=node (expected c, js, or wasm)\n${USAGE}`);
    }
    if (cmd === "mcp") {
      return await serveMcp({ parser });
    }
    if (cmd === "lsp") {
      return await serveLsp({ parser });
    }
    if (cmd === "explain") {
      const entries = files.map((code) => {
        const entry = explainCode(code);
        if (!entry) throw new CliError(`unknown diagnostic or trap code '${code}'`);
        return entry;
      });
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        out(json
          ? line({ kind: "explain", ...entry })
          : `${i > 0 ? "\n" : ""}${entry.code} [${entry.phase}]: ${entry.title}\n${entry.description}\nfix: ${entry.remediation}\n`);
      }
      return 0;
    }
    for (const f of files) { if (!existsSync(f)) throw new CliError(`no such file: ${f}`); if (!statSync(f).isFile()) throw new CliError(`not a file: ${f}`); }

    if (cmd === "build") {
      const analysis = analyze(files[0]!, parser);
      if (analysis.diagnostics.length) { err(diags(analysis.diagnostics)); return 1; }
      const provedRes = release && (target === "browser" || backend !== "js")
        ? await prove(files[0]!, { analysis, all: true, cache: !noCache, parser, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
        : undefined;
      if (provedRes && provedRes.diagnostics.length) { err(diags(provedRes.diagnostics)); return 1; }
      const r = target === "browser"
        ? buildBrowser(files[0]!, { outDir, mode: mode as BrowserBuildMode, analysis, parser, ...(provedRes ? { proved: provedRes.proved } : {}) })
        : buildNode(files[0]!, { outDir, mode: mode as NodeBuildMode, backend: backend as NodeBuildBackend, analysis, parser, ...(provedRes ? { proved: provedRes.proved } : {}) });
      if (r.diagnostics.length) { err(diags(r.diagnostics)); return 1; }
      out(json
        ? line({
          kind: "build",
          target,
          mode,
          ...(target === "node" ? { backend } : {}),
          ...(release ? { release: true, provedEliminated: r.provedEliminated ?? 0 } : {}),
          outDir: r.outDir,
          files: r.files,
        })
        : `${r.outDir} (${r.files.length} files${release ? `, release: ${r.provedEliminated ?? 0} checks eliminated` : ""})\n`);
      return 0;
    }

    if (cmd === "prove") {
      let solver = "";
      let fnCount = 0, proved = 0, failed = 0, unknown = 0, timeout = 0, cached = 0;
      const skipped: { file: string; fn: string; reason: string }[] = [];
      const seen = new Set<string>();
      for (const f of files) {
        const analysis = all ? analyze(f, parser) : undefined;
        const r = await prove(f, { cache: !noCache, all, parser, ...(analysis ? { analysis, skipFiles: seen } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
        if (r.diagnostics.length) { out(diags(r.diagnostics)); return 1; }
        if (analysis) for (const pf of analysis.files) seen.add(pf.path);
        if (r.solver) solver = r.solver;
        fnCount += r.summary.functions;
        proved += r.summary.proved;
        failed += r.summary.failed;
        unknown += r.summary.unknown;
        timeout += r.summary.timeout;
        cached += r.summary.cached;
        skipped.push(...r.summary.skipped);
        for (const fn of r.functions) {
          if (json) {
            out(line({ kind: "prove-fn", ...fn }));
          } else {
            const s = fn.summary;
            out(`FN ${fn.file} ${fn.fn} [${fn.layer}] proved=${s.proved} failed=${s.failed} unknown=${s.unknown} timeout=${s.timeout}${fn.cached ? " cached" : ""}\n`);
            for (const o of fn.obligations) {
              if (o.status !== "proved") {
                const cx = o.counterexample ? ` model=${JSON.stringify(o.counterexample)}` : "";
                out(`  ${o.status.toUpperCase()} ${fn.file}:${o.range.start.line}:${o.range.start.col} ${o.kind} (${o.label})${cx}\n`);
              }
            }
          }
        }
      }
      out(json
        ? line({ kind: "prove-summary", solver, functions: fnCount, proved, failed, unknown, timeout, cached, ...(skipped.length ? { skipped } : {}) })
        : `proved=${proved} failed=${failed} unknown=${unknown} timeout=${timeout} (${cached} cached; ${fnCount} functions${skipped.length ? `, ${skipped.length} skipped` : ""}, solver=${solver})\n`);
      return failed > 0 || (strict && (unknown > 0 || timeout > 0)) ? 1 : 0;
    }

    if (cmd === "query") {
      let bad = false;
      for (const f of files) {
        const r = queryFile(f, parser);
        if (r.diagnostics.length) {
          out(diags(r.diagnostics));
          if (r.diagnostics.some((d) => d.severity === "error")) bad = true;
        }
        for (const sym of r.symbols) {
          if (json) {
            const { kind: symbolKind, ...rest } = sym;
            out(line({ kind: "symbol", file: r.file, symbolKind, ...rest }));
          } else {
            const tags = [
              sym.layer ? `${sym.layer}${sym.unsafe ? ",unsafe" : ""}` : "",
              sym.pure !== undefined ? `pure=${sym.pure}` : "",
              sym.mutatable !== undefined ? `mutatable=${sym.mutatable}` : "",
              sym.caps?.length ? `caps=${sym.caps.join(",")}` : "",
              sym.implements?.length ? `implements=${sym.implements.join(",")}` : "",
              sym.fields?.length ? `fields=${sym.fields.length}` : "",
              sym.methods?.length ? `methods=${sym.methods.length}` : "",
              sym.ctor ? `ctor=${sym.ctor}` : "",
              sym.rtTrapSites?.length ? `traps=${sym.rtTrapSites.map((t) => `${t.code}@${t.line}:${t.col}`).join(",")}` : "",
            ].filter(Boolean).join(" ");
            out(`${sym.exported ? "export " : ""}${sym.kind} ${sym.name}: ${sym.type}${tags ? ` [${tags}]` : ""}\n`);
          }
        }
      }
      return bad ? 1 : 0;
    }
    if (cmd === "check") {
      if (watch) return await startWatch({ files, mode: "check", json, backends, out, err, parser });
      let ds = dedupeDiagnostics(files.flatMap((f) => check(f, parser)));
      if (fix) {
        const applied = applyDiagnosticFixes(ds);
        if (applied.length) {
          ds = dedupeDiagnostics(files.flatMap((f) => check(f, parser)));
          for (const item of applied) {
            out(json ? line({ kind: "fixed", file: item.file, applied: item.applied }) : `fixed ${item.file} (${item.applied} edit(s))\n`);
          }
        }
      }
      out(diags(ds));
      return ds.some((d) => d.severity === "error") ? 1 : 0;
    }
    if (cmd === "mutate") {
      let targets = 0, killed = 0, survived = 0, timeout = 0, cached = 0;
      const skipped: { fn: string; reason: string }[] = [];
      const skippedTests: string[] = [];
      const seen = new Set<string>();
      for (const f of files) {
        const analysis = all ? analyze(f, parser) : undefined;
        const r = await mutate(f, { cache: !noCache, all, parser, ...(analysis ? { analysis, skipFiles: seen } : {}) });
        if (r.diagnostics.length) { out(diags(r.diagnostics)); return 1; }
        if (r.baselineFailure) {
          const bf = r.baselineFailure;
          out(json
            ? line({ kind: "baseline-failure", file: bf.file, name: bf.name, failure: bf.failure, ...(bf.trap ? { trap: bf.trap } : {}), ...(bf.pos ? { pos: bf.pos } : {}) })
            : `FAIL baseline ${bf.name}: ${bf.failure}${bf.pos ? ` (${bf.pos.file}:${bf.pos.line}:${bf.pos.col})` : ""}\n`);
          return 1;
        }
        if (analysis) for (const pf of analysis.files) seen.add(pf.path);
        targets += r.summary.targets;
        killed += r.summary.killed;
        survived += r.summary.survived;
        timeout += r.summary.timeout;
        cached += r.summary.cached;
        skipped.push(...r.summary.skipped);
        if (r.summary.skippedTests) skippedTests.push(...r.summary.skippedTests);
        for (const m of r.mutants) {
          if (json) {
            out(line({
              kind: "mutant", file: m.file, fn: m.fn, id: m.id, op: m.op, range: m.range, status: m.status, cached: m.cached,
              ...(m.deadCode ? { deadCode: true } : {}),
              ...(m.status === "survived" ? { witness: m.witness ?? null } : {}),
            }));
          } else {
            const loc = `${m.file}:${m.range.start.line}:${m.range.start.col}`;
            const tag = m.status === "survived" ? "SURVIVED" : m.status;
            const extra = [
              m.deadCode ? "deadCode" : "",
              m.cached ? "cached" : "",
              m.status === "survived" && m.witness ? `witness=${JSON.stringify(m.witness)}` : "",
            ].filter(Boolean).join(" ");
            out(`${tag} ${loc} ${m.fn} [${m.op}]${extra ? ` ${extra}` : ""}\n`);
          }
        }
      }
      if (!json && skipped.length) {
        out(`skipped: ${skipped.map((s) => `${s.fn} (${s.reason})`).join(", ")}\n`);
      }
      out(json
        ? line({ kind: "summary", targets, killed, survived, timeout, cached, skipped, ...(skippedTests.length ? { skippedTests } : {}) })
        : `${killed} killed, ${timeout} timeout, ${survived} survived (${cached} cached; ${targets} targets, ${skipped.length} skipped${skippedTests.length ? `, ${skippedTests.length} c-only test(s) skipped` : ""})\n`);
      return failOnSurvived && survived > 0 ? 1 : 0;
    }
    if (cmd === "run") {
      const rs: RunResult[] = [];
      const analysis = analyze(files[0]!, parser); // D162: one analysis for all backends
      for (const b of backends) {
        const cur = await run(files[0]!, { backend: b, analysis, args: progArgs }); // diagnostics go to stderr: stdout is the program's (Q060)
        if (cur.diagnostics.length) { err(diags(cur.diagnostics)); return 1; }
        rs.push(cur);
      }
      const r = rs[0]!;
      const runKey = (x: RunResult) => JSON.stringify([x.stdout, x.stderr ?? "", x.trap, x.exitCode ?? 0]);
      if (rs.length >= 2 && rs.some((cur) => runKey(cur) !== runKey(r))) { // D101: --backend=both / --backend=all
        if (json) {
          const byBackend = Object.fromEntries(backends.map((b, k) => [b, { stdout: rs[k]!.stdout, stderr: rs[k]!.stderr ?? "", trap: rs[k]!.trap, exitCode: rs[k]!.exitCode ?? 0 }]));
          err(line({ kind: "mismatch", ...byBackend }));
        } else {
          const fmt = (x: RunResult) => `stdout=${JSON.stringify(x.stdout)} stderr=${JSON.stringify(x.stderr ?? "")} exitCode=${x.exitCode ?? 0} trap=${x.trap ? `${x.trap.code}@${x.trap.file}:${x.trap.line}:${x.trap.col}` : "none"}`;
          const label = backends.length === 2 ? "js and c" : "js, c, and wasm";
          const pad = Math.max(...backends.map((b) => b.length)) + 1;
          err(`mismatch between ${label} backends:\n${backends.map((b, k) => `  ${(`${b}:`).padEnd(pad)} ${fmt(rs[k]!)}`).join("\n")}\n`);
        }
        return 1;
      }
      out(r.stdout);
      if (r.stderr) err(r.stderr);
      if (!r.trap) return r.exitCode ?? 0;
      const { code, file, line: l, col, message } = r.trap;
      err(json ? line({ kind: "trap", code, file, range: { start: { line: l, col }, end: { line: l, col } }, ...(message ? { message } : {}) }) : `trap ${code} at ${file}:${l}:${col}\n${message ? `${message}\n` : ""}`);
      return 3;
    }
    if (watch) return await startWatch({ files, mode: "test", json, backends, ...(all ? { all: true } : {}), ...(filter !== undefined ? { filter } : {}), out, err, parser });
    const tr = await runTestPass({ files, backends, json, ...(all ? { all: true } : {}), ...(filter !== undefined ? { filter } : {}), out, diags, parser });
    return tr.failed || tr.bad ? 1 : 0;
  } catch (e) {
    if (e instanceof CUnsupported || e instanceof CBuildError) {
      err(rawJson ? line({ kind: "error", code: "CLI_ERROR", message: e.message }) : `${CLI_NAME}: ${e.message}\n`);
      return 2;
    }
    if (e instanceof RangeError && /call stack/.test(e.message)) {
      err(rawJson ? line({ kind: "error", code: "CLI_STACK", message: "source nests too deeply" }) : `${CLI_NAME}: source nests too deeply\n`);
      return 2; // Q252
    }
    if (!(e instanceof CliError) && !(e instanceof Error && /(?:no exported function|invalid) 'main'/.test(e.message))) {
      err(rawJson ? line({ kind: "error", code: "INTERNAL", message: (e as Error).message ?? String(e), ...((e as Error).stack ? { stack: (e as Error).stack } : {}) }) : `${(e as Error).stack ?? e}\n`);
      return 70; // internal errors keep their stack (Q252)
    }
    err(rawJson ? line({ kind: "error", code: "CLI_ERROR", message: (e as Error).message }) : `${CLI_NAME}: ${(e as Error).message}\n`);
    return 2;
  } finally {
    await shutdownSmt();
    parser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s));
}
