// One command: `pnpm bench`. Runs bench/kernels.ts under the C and JS backends and bench/hand.c built with the C backend's flags,
// checks that the checksums agree, and prints a Markdown table (ms per call; ratio = STS-C / hand C).
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../packages/compiler/src/index.ts";
import { CFLAGS } from "../packages/compiler/src/native.ts";

const here = import.meta.dirname;
type Row = Map<string, { ms: number; sum: string }>;
const parse = (out: string): Row => new Map(out.trim().split("\n").map((l) => { const [k, ms, sum] = l.split(" "); return [k!, { ms: +ms!, sum: sum! }]; }));
const fmtSum = (s: string): string => String(Number(s));

async function sts(backend: "js" | "c"): Promise<Row> {
  const r = await run(join(here, "kernels.ts"), { backend });
  if (r.diagnostics.length || r.trap) throw new Error(`STS-${backend}: ${JSON.stringify(r.diagnostics.length ? r.diagnostics : r.trap)}`);
  return parse(r.stdout);
}

const exe = join(mkdtempSync(join(tmpdir(), "sts-bench-")), "hand");
const flags = CFLAGS.filter((f) => f !== "-shared" && f !== "-fPIC");
execFileSync(process.env.CC ?? "cc", [...flags, join(here, "hand.c"), "-lm", "-o", exe], { stdio: "inherit" });
const hand = parse(execFileSync(exe, { encoding: "utf8" }));
const c = await sts("c");
const js = await sts("js");

console.log(`flags: ${flags.join(" ")}`);
console.log("| kernel | hand C (ms) | STS-C (ms) | STS-JS (ms) | STS-C / hand C |");
console.log("| --- | ---: | ---: | ---: | ---: |");
let bad = false;
for (const [k, h] of hand) {
  const x = c.get(k)!, y = js.get(k)!;
  if (fmtSum(x.sum) !== fmtSum(h.sum) || fmtSum(y.sum) !== fmtSum(h.sum)) { bad = true; console.error(`checksum mismatch in ${k}: hand ${h.sum}, C ${x.sum}, JS ${y.sum}`); }
  console.log(`| ${k} | ${h.ms.toFixed(3)} | ${x.ms.toFixed(3)} | ${y.ms.toFixed(3)} | ${(x.ms / h.ms).toFixed(2)} |`);
}
if (bad) process.exit(1);
