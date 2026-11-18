#!/usr/bin/env node
// CLI (Q060, Q061, Q110). Exit codes: 0 ok, 1 compile errors or failed tests, 2 usage / CLI error, 3 trap.
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { check, CLI_NAME, run, runTestFile, type Backend, type Diagnostic, type RunResult } from "./index.ts";
import { CUnsupported } from "./emit-c.ts";
import { CBuildError } from "./native.ts";

const USAGE = `usage: ${CLI_NAME} <check|run|test> [--json] [--backend=js|c|both] <file...>`;

class CliError extends Error {}

export async function main(argv: string[], out: (s: string) => void, err: (s: string) => void): Promise<number> {
  let args;
  try {
    args = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" }, backend: { type: "string", default: "js" } } });
  } catch (e) { err(`${(e as Error).message}\n${USAGE}\n`); return 2; }
  const [cmd, ...files] = args.positionals;
  const json = !!args.values.json;
  const backend = args.values.backend as string;
  const backends: Backend[] = backend === "both" ? ["js", "c"] : [backend as Backend];
  const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
  const diags = (ds: Diagnostic[]): string => ds.map((d) => json ? line(d) : `${d.file}:${d.range.start.line}:${d.range.start.col}: ${d.severity} ${d.code}: ${d.message}\n`).join("");
  try {
    if (cmd !== "check" && cmd !== "run" && cmd !== "test") throw new CliError(cmd ? `unknown command '${cmd}'\n${USAGE}` : USAGE);
    if (!files.length || (cmd === "run" && files.length > 1)) throw new CliError(`${cmd}: ${cmd === "run" ? "exactly one" : "at least one"} file required\n${USAGE}`);
    if (!["js", "c", "both"].includes(backend)) throw new CliError(`unknown backend '${backend}'\n${USAGE}`);
    for (const f of files) if (!existsSync(f)) throw new CliError(`no such file: ${f}`);

    if (cmd === "check") {
      const ds = files.flatMap((f) => check(f));
      out(diags(ds));
      return ds.some((d) => d.severity === "error") ? 1 : 0;
    }
    if (cmd === "run") {
      const rs: RunResult[] = [];
      for (const b of backends) rs.push(await run(files[0]!, { backend: b })); // diagnostics go to stderr: stdout is the program's (Q060)
      const r = rs[0]!;
      if (r.diagnostics.length) { err(diags(r.diagnostics)); return 1; }
      if (rs.length === 2 && JSON.stringify([rs[0]!.stdout, rs[0]!.trap]) !== JSON.stringify([rs[1]!.stdout, rs[1]!.trap])) { // D101: --backend=both
        err(line({ kind: "mismatch", js: { stdout: rs[0]!.stdout, trap: rs[0]!.trap }, c: { stdout: rs[1]!.stdout, trap: rs[1]!.trap } }));
        return 1;
      }
      out(r.stdout);
      if (!r.trap) return 0;
      const { code, file, line: l, col } = r.trap;
      err(json ? line({ kind: "trap", code, file, range: { start: { line: l, col }, end: { line: l, col } } }) : `trap ${code} at ${file}:${l}:${col}\n`);
      return 3;
    }
    let failed = 0, passed = 0, bad = false;
    for (const f of files) {
      const rs = [];
      for (const b of backends) rs.push(await runTestFile(f, { backend: b }));
      const r = rs[0]!;
      if (r.diagnostics.length) { out(diags(r.diagnostics)); bad = true; continue; }
      // D101: --backend=both compares each test's outcome, trap code and position; a trap's message is not compared.
      const key = (t: (typeof r.results)[number] | undefined): string => JSON.stringify(t && [t.name, t.ok, t.trap ? null : t.failure, t.trap?.code, t.pos?.file, t.pos?.line, t.pos?.col]);
      for (const [i, t] of r.results.entries()) {
        const other = rs[1]?.results[i];
        if (rs.length === 2 && key(t) !== key(other)) {
          failed++;
          out(line({ kind: "mismatch", file: f, name: t.name, js: t, c: other ?? null }));
          continue;
        }
        if (t.ok) passed++; else failed++;
        const pos = t.pos ? { file: t.pos.file, line: t.pos.line, col: t.pos.col } : undefined;
        out(json ? line({ kind: "test", file: f, name: t.name, ok: t.ok, ...(t.failure ? { failure: t.failure } : {}), ...(t.trap ? { trap: t.trap.code } : {}), ...(pos ? { pos } : {}) })
          : `${t.ok ? "ok" : "FAIL"} ${t.name}${t.ok ? "" : `: ${t.failure ?? ""}${pos ? ` (${pos.file}:${pos.line}:${pos.col})` : ""}`}\n`);
      }
    }
    out(json ? line({ kind: "summary", passed, failed }) : `${passed} passed, ${failed} failed\n`);
    return failed || bad ? 1 : 0;
  } catch (e) {
    if (e instanceof CUnsupported || e instanceof CBuildError) { err(`${CLI_NAME}: ${e.message}\n`); return 2; }
    if (!(e instanceof CliError) && !(e instanceof Error && /no exported function 'main'/.test(e.message))) throw e; // internal errors keep their stack
    err(`${CLI_NAME}: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s));
}
