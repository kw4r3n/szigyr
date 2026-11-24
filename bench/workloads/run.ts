// One command: `pnpm bench:workloads`. Builds and runs t1..t5 (C dev, C release, Wasm, and Rust if rustc is present)
// plus the `m` allocation/boundary micro-benchmarks (C, Wasm, and Rust if present, plus Wasm alloc_small scaling).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, buildNode, createParser, prove, shutdownSmt } from "../../packages/compiler/src/index.ts";

const here = import.meta.dirname;
const RUNS = 3;
const TASKS = [
  { id: "t1", label: "t1 tokenizer (16,000,000 B)" },
  { id: "t2", label: "t2 word frequency (4,000,000 words)" },
  { id: "t3", label: "t3 binary search tree (800,000 keys)" },
  { id: "t4", label: "t4 grouping (8,000,000 pairs)" },
  { id: "t5", label: "t5 event merge (2 x 4,000,000 events)" },
] as const;
const MICRO_NAMES = ["alloc_small", "push_grow", "call_scalar", "call_slice_small", "call_slice_large"] as const;
const WASM_ALLOC_COUNTS = [10000, 20000, 40000, 1000000] as const;

interface TaskSample {
  bestMs: number;
  checksum: string;
}

interface MicroRow {
  n: number;
  totalMs: number;
  perOpNs: number;
  chk: string;
}

function hasRustc(): boolean {
  try {
    execFileSync("rustc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function parseTaskOutput(out: string): TaskSample {
  for (const line of out.trim().split("\n")) {
    if (!line.startsWith("task=")) continue;
    const kv = new Map<string, string>();
    for (const part of line.trim().split(/\s+/)) {
      const eq = part.indexOf("=");
      if (eq > 0) kv.set(part.slice(0, eq), part.slice(eq + 1));
    }
    const bestMs = Number(kv.get("best_ms"));
    const checksum = kv.get("checksum");
    if (!Number.isFinite(bestMs) || !checksum) break;
    return { bestMs, checksum };
  }
  throw new Error(`failed to parse task output:\n${out}`);
}

function parseMicroOutput(out: string): Map<string, MicroRow> {
  const rows = new Map<string, MicroRow>();
  for (const line of out.trim().split("\n")) {
    if (!line.startsWith("micro=")) continue;
    const kv = new Map<string, string>();
    for (const part of line.trim().split(/\s+/)) {
      const eq = part.indexOf("=");
      if (eq > 0) kv.set(part.slice(0, eq), part.slice(eq + 1));
    }
    const name = kv.get("micro");
    const n = Number(kv.get("n"));
    const totalMs = Number(kv.get("total_ms"));
    const perOpNs = Number(kv.get("per_op_ns"));
    const chk = kv.get("chk");
    if (!name || !Number.isFinite(n) || !Number.isFinite(totalMs) || !Number.isFinite(perOpNs) || chk === undefined) {
      throw new Error(`failed to parse micro line: ${line}`);
    }
    rows.set(name, { n, totalMs, perOpNs, chk });
  }
  return rows;
}

function runCommandBest(cmd: string, args: readonly string[], runs: number): TaskSample {
  let bestMs = Infinity;
  let checksum = "";
  for (let i = 0; i < runs; i++) {
    const sample = parseTaskOutput(execFileSync(cmd, args, { encoding: "utf8" }));
    if (checksum && sample.checksum !== checksum) {
      throw new Error(`checksum mismatch across runs of ${cmd} ${args.join(" ")}: ${checksum} vs ${sample.checksum}`);
    }
    checksum = sample.checksum;
    if (sample.bestMs < bestMs) bestMs = sample.bestMs;
  }
  return { bestMs, checksum };
}

function compileRust(srcPath: string, outBin: string): void {
  execFileSync("rustc", ["--edition", "2021", "-C", "opt-level=3", "-o", outBin, srcPath], { stdio: "inherit" });
}

function fmtCell(ms: number, baseMs?: number): string {
  const base = `${ms.toFixed(1)} ms`;
  return baseMs !== undefined && baseMs > 0 ? `${base} (${(ms / baseMs).toFixed(2)}x)` : base;
}

function fmtNs(ns: number): string {
  return ns >= 100 ? `${ns.toFixed(1)} ns` : `${ns.toFixed(2)} ns`;
}

const rustAvailable = hasRustc();
if (!rustAvailable) console.log("note: rustc not found; omitting Rust columns");

const tmpDir = mkdtempSync(join(tmpdir(), "szigyr-workloads-"));
const parser = createParser();
try {
  let bad = false;

  console.log("## Workloads (min best_ms over 3 runs)");
  console.log(rustAvailable
    ? "| Task | checksum | szigyr C dev | szigyr C release | szigyr Wasm | rust-same | rust-idiom |"
    : "| Task | checksum | szigyr C dev | szigyr C release | szigyr Wasm |");
  console.log(rustAvailable
    ? "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
    : "| --- | ---: | ---: | ---: | ---: |");

  for (const task of TASKS) {
    const dir = join(here, task.id);
    const szPath = join(dir, `${task.id}.szigyr`);
    const analysis = analyze(szPath, parser);
    if (analysis.diagnostics.length) throw new Error(`${task.id} analyze failed: ${JSON.stringify(analysis.diagnostics)}`);

    const cDevDir = join(tmpDir, `${task.id}-c-dev`);
    const cDevBuild = buildNode(szPath, { outDir: cDevDir, mode: "app", backend: "c", analysis, parser });
    if (cDevBuild.diagnostics.length) throw new Error(`${task.id} C dev build failed: ${JSON.stringify(cDevBuild.diagnostics)}`);

    const pr = await prove(szPath, { analysis, all: true, cache: false, parser });
    if (pr.diagnostics.length) throw new Error(`${task.id} prove failed: ${JSON.stringify(pr.diagnostics)}`);
    const cRelDir = join(tmpDir, `${task.id}-c-rel`);
    const cRelBuild = buildNode(szPath, { outDir: cRelDir, mode: "app", backend: "c", analysis, parser, proved: pr.proved });
    if (cRelBuild.diagnostics.length) throw new Error(`${task.id} C release build failed: ${JSON.stringify(cRelBuild.diagnostics)}`);

    const wasmDir = join(tmpDir, `${task.id}-wasm`);
    const wasmBuild = buildNode(szPath, { outDir: wasmDir, mode: "app", backend: "wasm", analysis, parser });
    if (wasmBuild.diagnostics.length) throw new Error(`${task.id} Wasm build failed: ${JSON.stringify(wasmBuild.diagnostics)}`);

    const samples: Record<string, TaskSample> = {
      cDev: runCommandBest(process.execPath, [join(cDevDir, "main.js")], RUNS),
      cRel: runCommandBest(process.execPath, [join(cRelDir, "main.js")], RUNS),
      wasm: runCommandBest(process.execPath, [join(wasmDir, "main.js")], RUNS),
    };
    if (rustAvailable) {
      const sameBin = join(tmpDir, `${task.id}-rust-same`);
      const idiomBin = join(tmpDir, `${task.id}-rust-idiom`);
      compileRust(join(dir, `${task.id}_same.rs`), sameBin);
      compileRust(join(dir, `${task.id}_idiom.rs`), idiomBin);
      samples.rustSame = runCommandBest(sameBin, [], RUNS);
      samples.rustIdiom = runCommandBest(idiomBin, [], RUNS);
    }

    const chks = new Set(Object.values(samples).map((s) => s.checksum));
    const checksum = chks.size === 1 ? [...chks][0]! : "MISMATCH";
    if (chks.size !== 1) {
      bad = true;
      console.error(`checksum mismatch in ${task.id}: ${Object.entries(samples).map(([k, v]) => `${k}=${v.checksum}`).join(", ")}`);
    }

    const base = samples.rustSame?.bestMs;
    const cols = [
      task.label,
      checksum,
      fmtCell(samples.cDev!.bestMs, base),
      fmtCell(samples.cRel!.bestMs, base),
      fmtCell(samples.wasm!.bestMs, base),
      ...(rustAvailable ? [fmtCell(samples.rustSame!.bestMs), fmtCell(samples.rustIdiom!.bestMs, base)] : []),
    ];
    console.log(`| ${cols.join(" | ")} |`);
  }

  const mPath = join(here, "m", "m.szigyr");
  const mAnalysis = analyze(mPath, parser);
  if (mAnalysis.diagnostics.length) throw new Error(`m analyze failed: ${JSON.stringify(mAnalysis.diagnostics)}`);

  const mCDir = join(tmpDir, "m-c");
  const mCBuild = buildNode(mPath, { outDir: mCDir, mode: "app", backend: "c", analysis: mAnalysis, parser });
  if (mCBuild.diagnostics.length) throw new Error(`m C build failed: ${JSON.stringify(mCBuild.diagnostics)}`);

  const mWasmDir = join(tmpDir, "m-wasm");
  const mWasmBuild = buildNode(mPath, { outDir: mWasmDir, mode: "app", backend: "wasm", analysis: mAnalysis, parser });
  if (mWasmBuild.diagnostics.length) throw new Error(`m Wasm build failed: ${JSON.stringify(mWasmBuild.diagnostics)}`);

  const mCMain = join(mCDir, "main.js");
  const mWasmMain = join(mWasmDir, "main.js");
  const mC = parseMicroOutput(execFileSync(process.execPath, [mCMain], { encoding: "utf8" }));
  const mWasm = parseMicroOutput(execFileSync(process.execPath, [mWasmMain], { encoding: "utf8" }));
  let mRust: Map<string, MicroRow> | undefined;
  if (rustAvailable) {
    const mRustBin = join(tmpDir, "m-rust");
    compileRust(join(here, "m", "m.rs"), mRustBin);
    mRust = parseMicroOutput(execFileSync(mRustBin, [], { encoding: "utf8" }));
  }

  console.log("");
  console.log("## Allocation and boundary (`m`)");
  console.log(rustAvailable
    ? "| Measurement | n | szigyr C | szigyr Wasm | Rust |"
    : "| Measurement | n | szigyr C | szigyr Wasm |");
  console.log(rustAvailable
    ? "| --- | ---: | ---: | ---: | ---: |"
    : "| --- | ---: | ---: | ---: |");

  for (const name of MICRO_NAMES) {
    const cRow = mC.get(name)!;
    const wRow = mWasm.get(name)!;
    const rRow = mRust?.get(name);
    if (cRow.chk !== wRow.chk || (rRow && rRow.chk !== cRow.chk)) {
      bad = true;
      console.error(`micro checksum mismatch in ${name}: C=${cRow.chk}, Wasm=${wRow.chk}${rRow ? `, Rust=${rRow.chk}` : ""}`);
    }
    const cols = [
      name,
      String(cRow.n),
      `${fmtNs(cRow.perOpNs)} (${cRow.totalMs} ms)`,
      `${fmtNs(wRow.perOpNs)} (${wRow.totalMs} ms)`,
      ...(rustAvailable ? [rRow ? `${fmtNs(rRow.perOpNs)} (${rRow.totalMs.toFixed(3)} ms)` : "n/a"] : []),
    ];
    console.log(`| ${cols.join(" | ")} |`);
  }

  console.log("");
  console.log("## Wasm `alloc_small` scaling");
  console.log("| Count (N) | total_ms | per_op_ns | vs 10,000 | chk |");
  console.log("| ---: | ---: | ---: | ---: | ---: |");

  let base10k: number | undefined;
  for (const count of WASM_ALLOC_COUNTS) {
    const row = count === 1000000
      ? mWasm.get("alloc_small")!
      : parseMicroOutput(execFileSync(process.execPath, [mWasmMain, String(count), "alloc_small"], { encoding: "utf8" })).get("alloc_small")!;
    if (base10k === undefined) base10k = row.totalMs;
    const ratio = base10k > 0 ? `${(row.totalMs / base10k).toFixed(2)}x` : "n/a";
    console.log(`| ${count} | ${row.totalMs} | ${fmtNs(row.perOpNs)} | ${ratio} | ${row.chk} |`);
  }

  if (bad) process.exitCode = 1;
} finally {
  await shutdownSmt();
  parser.close();
  rmSync(tmpDir, { recursive: true, force: true });
}
