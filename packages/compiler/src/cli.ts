#!/usr/bin/env node
// CLI (Q060, Q061, Q110). Exit codes: 0 ok, 1 compile errors or failed tests, 2 usage / CLI error, 3 trap, 70 internal error (Q252).
import { existsSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { analyze, buildBrowser, buildNode, check, CLI_NAME, CliError, createParser, explainCode, mutate, queryFile, run, type Backend, type BrowserBuildMode, type Diagnostic, type NodeBuildBackend, type NodeBuildMode, type RunResult } from "./index.ts";
import { serveMcp } from "./mcp.ts";
import { runTestPass, startWatch } from "./watch.ts";
import { CUnsupported } from "./emit-c.ts";
import { CBuildError } from "./native.ts";

const USAGE = `usage: ${CLI_NAME} <check|run|test|mutate|query|explain|build|mcp> [--json] [--watch] [--no-cache] [--backend=js|c|both|wasm] [--target=node|browser] [--mode=app|lib] [-o <dir>] <file...|code>`;

export async function main(argv: string[], out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const rawJson = argv.includes("--json");
  let args;
  try {
    args = parseArgs({
      args: argv, allowPositionals: true,
      options: {
        json: { type: "boolean" },
        watch: { type: "boolean", short: "w" },
        "no-cache": { type: "boolean" },
        backend: { type: "string" },
        target: { type: "string" },
        mode: { type: "string", default: "app" },
        "out-dir": { type: "string", short: "o", default: "dist" },
      },
    });
  } catch (e) {
    err(rawJson ? `${JSON.stringify({ kind: "error", code: "CLI_USAGE", message: (e as Error).message, usage: USAGE })}\n` : `${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const [cmd, ...files] = args.positionals;
  const json = !!args.values.json;
  const watch = !!args.values.watch;
  const noCache = !!args.values["no-cache"];
  const rawBackend = args.values.backend as string | undefined;
  const target = args.values.target as string | undefined;
  const backend = rawBackend ?? (cmd === "build" && target === "node" ? "c" : "js");
  const mode = args.values.mode as string;
  const outDir = args.values["out-dir"] as string;
  const backends: Backend[] = backend === "both" ? ["js", "c"] : [backend as Backend];
  const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
  const diags = (ds: readonly Diagnostic[]): string => ds.map((d) => json ? line(d) : `${d.file}:${d.range.start.line}:${d.range.start.col}: ${d.severity} ${d.code}: ${d.message}\n`).join("");
  const parser = createParser(); // D161: one tsgo process for every file of this command (spawned on first use)
  try {
    if (cmd !== "check" && cmd !== "run" && cmd !== "test" && cmd !== "mutate" && cmd !== "query" && cmd !== "explain" && cmd !== "build" && cmd !== "mcp") {
      throw new CliError(cmd ? `unknown command '${cmd}'\n${USAGE}` : USAGE);
    }
    if (cmd === "mcp") {
      if (files.length || rawBackend !== undefined || noCache || watch || target !== undefined) {
        throw new CliError(`mcp: takes no positional arguments or build/watch/backend flags\n${USAGE}`);
      }
    } else if (cmd === "explain") {
      if (files.length !== 1) throw new CliError(`explain: exactly one code required\n${USAGE}`);
    } else if (!files.length || ((cmd === "run" || cmd === "build") && files.length > 1)) {
      throw new CliError(`${cmd}: ${cmd === "run" || cmd === "build" ? "exactly one" : "at least one"} file required\n${USAGE}`);
    }
    if (watch && cmd !== "check" && cmd !== "test") throw new CliError(`${cmd}: --watch is only supported for check and test\n${USAGE}`);
    if (!["js", "c", "both", "wasm"].includes(backend)) throw new CliError(`unknown backend '${backend}'\n${USAGE}`);
    if ((cmd === "mutate" || cmd === "query" || cmd === "explain") && backend !== "js") throw new CliError(`${cmd}: JS backend only (--backend=${backend} is not supported)\n${USAGE}`);
    if (noCache && cmd !== "mutate") throw new CliError(`${cmd}: --no-cache is only supported for mutate\n${USAGE}`);
    if (cmd === "build") {
      if (target !== "browser" && target !== "node") throw new CliError(`build: missing or unknown --target '${target ?? ""}' (expected --target=node or --target=browser)\n${USAGE}`);
      if (mode !== "app" && mode !== "lib") throw new CliError(`build: unknown --mode '${mode}' (expected app or lib)\n${USAGE}`);
      if (target === "browser" && rawBackend !== undefined) throw new CliError(`build: --backend is not supported with --target=browser\n${USAGE}`);
      if (target === "node" && !["c", "js", "wasm"].includes(backend)) throw new CliError(`build: --backend=${backend} is not supported with --target=node (expected c, js, or wasm)\n${USAGE}`);
    }
    if (cmd === "mcp") {
      return await serveMcp({ parser });
    }
    if (cmd === "explain") {
      const entry = explainCode(files[0]!);
      if (!entry) throw new CliError(`unknown diagnostic or trap code '${files[0]}'`);
      out(json
        ? line({ kind: "explain", ...entry })
        : `${entry.code} [${entry.phase}]: ${entry.title}\n${entry.description}\nfix: ${entry.remediation}\n`);
      return 0;
    }
    for (const f of files) { if (!existsSync(f)) throw new CliError(`no such file: ${f}`); if (!statSync(f).isFile()) throw new CliError(`not a file: ${f}`); }

    if (cmd === "build") {
      const r = target === "browser"
        ? buildBrowser(files[0]!, { outDir, mode: mode as BrowserBuildMode, parser })
        : buildNode(files[0]!, { outDir, mode: mode as NodeBuildMode, backend: backend as NodeBuildBackend, parser });
      if (r.diagnostics.length) { err(diags(r.diagnostics)); return 1; }
      out(json
        ? line({ kind: "build", target, mode, ...(target === "node" ? { backend } : {}), outDir: r.outDir, files: r.files })
        : `${r.outDir} (${r.files.length} files)\n`);
      return 0;
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
      const ds = files.flatMap((f) => check(f, parser));
      out(diags(ds));
      return ds.some((d) => d.severity === "error") ? 1 : 0;
    }
    if (cmd === "mutate") {
      let targets = 0, killed = 0, survived = 0, timeout = 0, cached = 0;
      const skipped: { fn: string; reason: string }[] = [];
      for (const f of files) {
        const r = await mutate(f, { cache: !noCache, parser });
        if (r.diagnostics.length) { out(diags(r.diagnostics)); return 1; }
        if (r.baselineFailure) {
          const bf = r.baselineFailure;
          out(json
            ? line({ kind: "baseline-failure", file: bf.file, name: bf.name, failure: bf.failure, ...(bf.trap ? { trap: bf.trap } : {}), ...(bf.pos ? { pos: bf.pos } : {}) })
            : `FAIL baseline ${bf.name}: ${bf.failure}${bf.pos ? ` (${bf.pos.file}:${bf.pos.line}:${bf.pos.col})` : ""}\n`);
          return 1;
        }
        targets += r.summary.targets;
        killed += r.summary.killed;
        survived += r.summary.survived;
        timeout += r.summary.timeout;
        cached += r.summary.cached;
        skipped.push(...r.summary.skipped);
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
      out(json
        ? line({ kind: "summary", targets, killed, survived, timeout, cached, skipped })
        : `${killed} killed, ${timeout} timeout, ${survived} survived (${cached} cached; ${targets} targets, ${skipped.length} skipped)\n`);
      return 0;
    }
    if (cmd === "run") {
      const rs: RunResult[] = [];
      const analysis = analyze(files[0]!, parser); // D162: one analysis for both backends
      for (const b of backends) {
        const cur = await run(files[0]!, { backend: b, analysis }); // diagnostics go to stderr: stdout is the program's (Q060)
        if (cur.diagnostics.length) { err(diags(cur.diagnostics)); return 1; }
        rs.push(cur);
      }
      const r = rs[0]!;
      if (rs.length === 2 && JSON.stringify([rs[0]!.stdout, rs[0]!.trap]) !== JSON.stringify([rs[1]!.stdout, rs[1]!.trap])) { // D101: --backend=both
        err(line({ kind: "mismatch", js: { stdout: rs[0]!.stdout, trap: rs[0]!.trap }, c: { stdout: rs[1]!.stdout, trap: rs[1]!.trap } }));
        return 1;
      }
      out(r.stdout);
      if (!r.trap) return 0;
      const { code, file, line: l, col, message } = r.trap;
      err(json ? line({ kind: "trap", code, file, range: { start: { line: l, col }, end: { line: l, col } }, ...(message ? { message } : {}) }) : `trap ${code} at ${file}:${l}:${col}\n${message ? `${message}\n` : ""}`);
      return 3;
    }
    if (watch) return await startWatch({ files, mode: "test", json, backends, out, err, parser });
    const tr = await runTestPass({ files, backends, json, out, diags, parser });
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
    parser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s));
}
