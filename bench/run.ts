// One command: `pnpm bench`. Runs bench/kernels.szigyr under the JS backend, default C backend, release C backend (checks proved & eliminated),
// and bench/hand.c built with the C backend's flags, checks that all checksums agree, and prints a Markdown table.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, buildNode, createParser, prove, run, shutdownSmt } from "../packages/compiler/src/index.ts";
import { CFLAGS } from "../packages/compiler/src/native.ts";

const here = import.meta.dirname;
type Row = Map<string, { ms: number; sum: string }>;
const parse = (out: string): Row => new Map(out.trim().split("\n").map((l) => { const [k, ms, sum] = l.split(" "); return [k!, { ms: +ms!, sum: sum! }]; }));
const fmtSum = (s: string): string => String(Number(s));

async function sts(backend: "js" | "c"): Promise<Row> {
  const r = await run(join(here, "kernels.szigyr"), { backend });
  if (r.diagnostics.length || r.trap) throw new Error(`STS-${backend}: ${JSON.stringify(r.diagnostics.length ? r.diagnostics : r.trap)}`);
  return parse(r.stdout);
}

const tmpDir = mkdtempSync(join(tmpdir(), "sts-bench-"));
const parser = createParser();
try {
  const kernelsPath = join(here, "kernels.szigyr");
  const exe = join(tmpDir, "hand");
  const flags = CFLAGS.filter((f) => f !== "-shared" && f !== "-fPIC");
  execFileSync(process.env.CC ?? "cc", [...flags, join(here, "hand.c"), "-lm", "-o", exe], { stdio: "inherit" });
  const hand = parse(execFileSync(exe, { encoding: "utf8" }));

  const analysis = analyze(kernelsPath, parser);
  if (analysis.diagnostics.length) throw new Error(`bench analyze failed: ${JSON.stringify(analysis.diagnostics)}`);
  const pr = await prove(kernelsPath, { analysis, all: true, cache: false, parser });
  if (pr.diagnostics.length || pr.summary.failed > 0) {
    throw new Error(`bench prove failed: ${JSON.stringify(pr.diagnostics.length ? pr.diagnostics : pr.functions.filter((f) => f.summary.failed > 0))}`);
  }
  const relDir = join(tmpDir, "rel");
  const relBuild = buildNode(kernelsPath, { outDir: relDir, mode: "app", backend: "c", analysis, parser, proved: pr.proved });
  if (relBuild.diagnostics.length) throw new Error(`bench release build failed: ${JSON.stringify(relBuild.diagnostics)}`);
  const rel = parse(execFileSync(process.execPath, [join(relDir, "main.js")], { encoding: "utf8" }));

  const c = await sts("c");
  const js = await sts("js");

  console.log(`flags: ${flags.join(" ")}`);
  console.log(`proved: ${relBuild.provedEliminated ?? 0} checks eliminated`);
  console.log("| kernel | hand C (ms) | STS-C (ms) | STS-C rel (ms) | STS-JS (ms) | dev / hand C | rel / hand C |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  let bad = false;
  for (const [k, h] of hand) {
    const x = c.get(k)!, r = rel.get(k)!, y = js.get(k)!;
    if (fmtSum(x.sum) !== fmtSum(h.sum) || fmtSum(r.sum) !== fmtSum(h.sum) || fmtSum(y.sum) !== fmtSum(h.sum)) {
      bad = true;
      console.error(`checksum mismatch in ${k}: hand ${h.sum}, C ${x.sum}, C-rel ${r.sum}, JS ${y.sum}`);
    }
    console.log(`| ${k} | ${h.ms.toFixed(3)} | ${x.ms.toFixed(3)} | ${r.ms.toFixed(3)} | ${y.ms.toFixed(3)} | ${(x.ms / h.ms).toFixed(2)} | ${(r.ms / h.ms).toFixed(2)} |`);
  }
  if (bad) process.exitCode = 1;
} finally {
  await shutdownSmt();
  parser.close();
  rmSync(tmpDir, { recursive: true, force: true });
}
