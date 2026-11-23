import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32 as nodeCrc32, gunzipSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { main as cliMain } from "../src/cli.ts";
import { analyze, buildNode, check, prove, queryFile, run, runTestFile, type Backend } from "../src/index.ts";
import { mutateFile } from "../src/mutate.ts";

const EXAMPLE_DIR = resolve(import.meta.dirname, "../../../examples/gzlog");
const PARSE_SZIGYR = join(EXAMPLE_DIR, "parse.szigyr");
const ZLIB_SZIGYR = join(EXAMPLE_DIR, "zlib.szigyr");
const CORE_SZIGYR = join(EXAMPLE_DIR, "core.szigyr");
const MAIN_SZIGYR = join(EXAMPLE_DIR, "main.szigyr");

function hasZlib(): boolean {
  try {
    execFileSync("pkg-config", ["--exists", "zlib"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const tmpRoots: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await cliMain(argv, (s) => { out += s; }, (s) => { err += s; });
  return { code, out, err };
}

function hexCrc32(buf: Buffer): string {
  return (nodeCrc32(buf) >>> 0).toString(16).padStart(8, "0");
}

function hasTmpFilesRecursive(dir: string): boolean {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".sztmp-")) return true;
    if (ent.isDirectory() && hasTmpFilesRecursive(join(dir, ent.name))) return true;
  }
  return false;
}

describe("examples/gzlog portable core & SMT kernels", () => {
  it("passes check with zero diagnostics and reports expected query metadata for parse and core", () => {
    expect(check(CORE_SZIGYR)).toEqual([]);

    const qParse = queryFile(PARSE_SZIGYR);
    expect(qParse.diagnostics).toEqual([]);
    for (const fnName of ["scanLogBytes", "classifyLine", "isGzipMagic", "copySlice"]) {
      expect(qParse.symbols.find((s) => s.name === fnName)).toMatchObject({
        kind: "function",
        layer: "rt",
        deterministic: true,
        mutatable: true,
      });
    }
    for (const fnName of ["indexLinesByLevel", "appendSlice"]) {
      expect(qParse.symbols.find((s) => s.name === fnName)).toMatchObject({
        kind: "function",
        layer: "strict",
        deterministic: true,
        mutatable: true,
      });
    }

    const qCore = queryFile(CORE_SZIGYR);
    expect(qCore.diagnostics).toEqual([]);
    for (const fnName of ["runGzlog", "parseCliArgs", "collectFiles"]) {
      expect(qCore.symbols.find((s) => s.name === fnName)).toMatchObject({
        kind: "function",
        layer: "managed",
        mutatable: true,
      });
    }
  });

  it("passes all colocated unit and forAll tests identically across js, c, and wasm", async () => {
    const backends: Backend[] = ["js", "c", "wasm"];
    const namesByBackend: string[][] = [];
    for (const backend of backends) {
      const r = await runTestFile(CORE_SZIGYR, { backend, all: true });
      expect(r.diagnostics, `diagnostics for ${backend}`).toEqual([]);
      expect(r.results.length).toBeGreaterThanOrEqual(9);
      for (const t of r.results) {
        expect(t.ok, `${backend} test ${t.name}: ${t.failure ?? ""}`).toBe(true);
      }
      namesByBackend.push(r.results.map((t) => t.name));
    }
    expect(namesByBackend[1]).toEqual(namesByBackend[0]);
    expect(namesByBackend[2]).toEqual(namesByBackend[0]);
  }, 120_000);

  it("achieves zero surviving mutants across parse.szigyr and core.szigyr", async () => {
    const res = await mutateFile(CORE_SZIGYR, { all: true, cache: false });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    expect(res.summary.targets).toBeGreaterThanOrEqual(30);
    expect(res.summary.killed).toBeGreaterThan(500);
    expect(res.summary.survived).toBe(0);
    expect(res.summary.skippedTests ?? []).toEqual([]);
  }, 120_000);
});

describe.skipIf(!hasZlib())("examples/gzlog real zlib C FFI & release node build", () => {
  it("passes check + P4 header verification and query metadata on zlib/main", () => {
    expect(check(MAIN_SZIGYR)).toEqual([]);

    const qZlib = queryFile(ZLIB_SZIGYR);
    expect(qZlib.diagnostics).toEqual([]);
    expect(qZlib.symbols.find((s) => s.name === "z_stream")).toMatchObject({
      kind: "type",
      unsafe: true,
    });
    for (const fnName of ["zlibCrc32", "gzipDecompressInto", "gzipCompressInto"]) {
      expect(qZlib.symbols.find((s) => s.name === fnName)).toMatchObject({
        kind: "function",
        layer: "strict",
        unsafe: true,
      });
    }

    const qMain = queryFile(MAIN_SZIGYR);
    expect(qMain.diagnostics).toEqual([]);
    expect(qMain.symbols.find((s) => s.name === "main")).toMatchObject({
      kind: "function",
      layer: "managed",
      mutatable: false,
    });
  });

  it("proves all parse.szigyr strict/rt obligations cleanly via main.szigyr with zero unknowns", async () => {
    const res = await prove(MAIN_SZIGYR, { all: true, cache: false });
    expect(res.diagnostics).toEqual([]);
    expect(res.summary.failed).toBe(0);
    expect(res.summary.unknown).toBe(0);
    expect(res.summary.timeout).toBe(0);
    expect(res.summary.proved).toBeGreaterThan(0);
  }, 120_000);

  it("keeps zero surviving mutants when running mutate --all from main.szigyr", async () => {
    const res = await mutateFile(MAIN_SZIGYR, { all: true, cache: false });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    expect(res.summary.survived).toBe(0);
    expect(res.summary.killed).toBeGreaterThan(500);
  }, 120_000);

  it("rejects C-only entry on js backend with E4009", async () => {
    const res = await run(MAIN_SZIGYR, { backend: "js" });
    expect(res.diagnostics.some((d) => d.code === "E4009")).toBe(true);
  });

  it("interoperates with node:zlib across stats, grep, multi-member .gz, large >150KB pack/unpack, and error exits", async () => {
    const ws = makeTmp("szigyr-gzlog-ws-");
    mkdirSync(join(ws, "sub"), { recursive: true });

    const appPlain = Buffer.from(
      "INFO boot complete\r\n" +
      "WARN high memory\n" +
      "ERROR disk timeout\n" +
      "error_count = 0\n" +
      "{\"status\":\"debug\"}\n",
      "utf8",
    );
    const part1 = Buffer.from("INFO member1 start\nFATAL upstream timeout\n", "utf8");
    const part2 = Buffer.from("TRACE detail\nWARNING retry disk\n", "utf8");
    const multiGz = Buffer.concat([gzipSync(part1), gzipSync(part2)]);
    const singlePlain = Buffer.from("ERROR single disk error", "utf8");
    const singleGz = gzipSync(singlePlain);

    writeFileSync(join(ws, "app.log"), appPlain);
    writeFileSync(join(ws, "sub/member.log.gz"), multiGz);
    writeFileSync(join(ws, "sub/single.log.gz"), singleGz);
    symlinkSync(join(ws, "app.log"), join(ws, "ignored.symlink"));

    // 1. stats --json over directory (plain + concatenated multi-member + single .gz, symlink skipped)
    const stRes = await runCli(["run", "--backend=c", MAIN_SZIGYR, "--", "stats", ws, "--json"]);
    expect(stRes.code, stRes.err).toBe(0);
    const st = JSON.parse(stRes.out) as {
      fileCount: number;
      totalRawBytes: number;
      totalBytes: number;
      totalLines: number;
      errors: number;
      warns: number;
      infos: number;
      debugs: number;
      others: number;
      files: Array<{ path: string; gzipped: boolean; bytes: number; crc32: string; lines: number }>;
    };
    expect(st.fileCount).toBe(3);
    expect(st.files.map((f) => f.path)).toEqual([
      join(ws, "app.log"),
      join(ws, "sub/member.log.gz"),
      join(ws, "sub/single.log.gz"),
    ]);
    expect(st.files.map((f) => f.gzipped)).toEqual([false, true, true]);
    expect(st.files.map((f) => f.crc32)).toEqual([
      hexCrc32(appPlain),
      hexCrc32(Buffer.concat([part1, part2])),
      hexCrc32(singlePlain),
    ]);
    expect(st.totalBytes).toBe(appPlain.length + part1.length + part2.length + singlePlain.length);
    expect(st.totalLines).toBe(10); // 5 + (2 + 2) + 1
    expect(st.errors).toBe(3); // ERROR disk timeout, FATAL upstream timeout, ERROR single disk error
    expect(st.warns).toBe(2); // WARN high memory, WARNING retry disk
    expect(st.infos).toBe(2); // INFO boot complete, INFO member1 start
    expect(st.debugs).toBe(2); // {"status":"debug"}, TRACE detail
    expect(st.others).toBe(1); // error_count = 0

    // 2. grep across plain and multi-member .gz with --level error -i --json
    const grRes = await runCli([
      "run", "--backend=c", MAIN_SZIGYR, "--",
      "grep", "TIMEOUT|DISK", ws, "--level", "error", "-i", "--json",
    ]);
    expect(grRes.code, grRes.err).toBe(0);
    const gr = JSON.parse(grRes.out) as {
      matchCount: number;
      truncated: boolean;
      matches: Array<{ path: string; lineNo: number; level: string; text: string }>;
    };
    expect(gr.truncated).toBe(false);
    expect(gr.matchCount).toBe(3);
    expect(gr.matches).toEqual([
      { path: join(ws, "app.log"), lineNo: 3, level: "ERROR", text: "ERROR disk timeout" },
      { path: join(ws, "sub/member.log.gz"), lineNo: 2, level: "ERROR", text: "FATAL upstream timeout" },
      { path: join(ws, "sub/single.log.gz"), lineNo: 1, level: "ERROR", text: "ERROR single disk error" },
    ]);

    // 3. Large >150KB file (multi-chunk 65536-byte streaming in deflate, inflate, and zlibCrc32)
    const ioDir = makeTmp("szigyr-gzlog-io-");
    const largeBuf = Buffer.from(
      "2026-11-23T05:00:00Z INFO request completed path=/api/items status=200\n".repeat(2500),
      "utf8",
    );
    expect(largeBuf.length).toBeGreaterThan(150_000);
    const largeSrc = join(ioDir, "large.log");
    const largeGz = join(ioDir, "large.log.gz");
    const largeUnpacked = join(ioDir, "roundtrip.log");
    writeFileSync(largeSrc, largeBuf);

    const pkRes = await runCli(["run", "--backend=c", MAIN_SZIGYR, "--", "pack", largeSrc, largeGz, "--level", "6", "--json"]);
    expect(pkRes.code, pkRes.err).toBe(0);
    const pkJson = JSON.parse(pkRes.out) as { rawBytes: number; gzipBytes: number; crc32: string };
    expect(pkJson.rawBytes).toBe(largeBuf.length);
    expect(pkJson.crc32).toBe(hexCrc32(largeBuf));
    const gzFileBytes = readFileSync(largeGz);
    expect(pkJson.gzipBytes).toBe(gzFileBytes.length);
    expect(gunzipSync(gzFileBytes).equals(largeBuf)).toBe(true);

    const unRes = await runCli(["run", "--backend=c", MAIN_SZIGYR, "--", "unpack", largeGz, largeUnpacked, "--json"]);
    expect(unRes.code, unRes.err).toBe(0);
    expect(JSON.parse(unRes.out)).toMatchObject({
      gzipBytes: gzFileBytes.length,
      rawBytes: largeBuf.length,
      crc32: hexCrc32(largeBuf),
    });
    expect(readFileSync(largeUnpacked).equals(largeBuf)).toBe(true);

    // 4. Empty 0-byte roundtrip
    const emptySrc = join(ioDir, "empty.log");
    const emptyGz = join(ioDir, "empty.log.gz");
    const emptyOut = join(ioDir, "empty.out");
    writeFileSync(emptySrc, Buffer.alloc(0));
    expect((await runCli(["run", "--backend=c", MAIN_SZIGYR, "--", "pack", emptySrc, emptyGz])).code).toBe(0);
    expect(gunzipSync(readFileSync(emptyGz)).length).toBe(0);
    expect((await runCli(["run", "--backend=c", MAIN_SZIGYR, "--", "unpack", emptyGz, emptyOut])).code).toBe(0);
    expect(readFileSync(emptyOut).length).toBe(0);

    expect(hasTmpFilesRecursive(ws)).toBe(false);
    expect(hasTmpFilesRecursive(ioDir)).toBe(false);

    // 5. Real error cases return exit 1 cleanly
    const corruptGz = join(ioDir, "corrupt.gz");
    const truncGz = join(ioDir, "trunc.gz");
    const bombGz = join(ioDir, "bomb.gz");
    writeFileSync(corruptGz, Buffer.from([0x1f, 0x8b, 0x08, 0xff, 0x00, 0x01]));
    const fullForTrunc = gzipSync(Buffer.from("ERROR truncated payload line\n".repeat(40), "utf8"));
    writeFileSync(truncGz, fullForTrunc.subarray(0, 24));
    writeFileSync(bombGz, gzipSync(Buffer.alloc(50_000, 65)));

    const errCases: Array<[string[], string]> = [
      [["stats", corruptGz], "corrupt gzip stream"],
      [["stats", truncGz], "corrupt gzip stream"],
      [["stats", bombGz, "--max-bytes", "4096"], "--max-bytes"],
      [["unpack", largeSrc, join(ioDir, "fail.out")], "not a gzip file"],
      [["pack", largeSrc, join(ioDir, "fail.gz"), "--level", "10"], "invalid --level"],
      [["grep", "[", ws], "invalid pattern"],
    ];
    for (const [args, expectSub] of errCases) {
      const r = await runCli(["run", "--backend=c", MAIN_SZIGYR, "--", ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(expectSub);
    }
  }, 120_000);

  it("builds relocated release --target=node --backend=c bundle with proved checks eliminated and executes standalone", async () => {
    const analysis = analyze(MAIN_SZIGYR);
    expect(analysis.diagnostics).toEqual([]);
    const proveRes = await prove(MAIN_SZIGYR, { analysis, all: true, cache: false });
    expect(proveRes.diagnostics).toEqual([]);
    expect(proveRes.summary.failed).toBe(0);
    expect(proveRes.summary.unknown).toBe(0);

    const outDir = makeTmp("szigyr-gzlog-build-");
    const built = buildNode(MAIN_SZIGYR, { outDir, backend: "c", analysis, proved: proveRes.proved });
    expect(built.diagnostics).toEqual([]);
    expect(built.files).toContain("program.node");
    expect(built.files).toContain("main.js");
    expect(built.provedEliminated).toBeGreaterThan(0);

    const relocDir = makeTmp("szigyr-gzlog-reloc-");
    cpSync(outDir, relocDir, { recursive: true });
    expect(existsSync(join(relocDir, "program.node"))).toBe(true);

    const work = makeTmp("szigyr-gzlog-reloc-work-");
    const sample = Buffer.from("INFO alpha\nERROR timeout on backend\nWARN retry\n", "utf8");
    const samplePath = join(work, "service.log");
    const gzPath = join(work, "service.log.gz");
    const unpackedPath = join(work, "service.unpacked.log");
    writeFileSync(samplePath, sample);

    const relocMain = join(relocDir, "main.js");
    const packOut = JSON.parse(
      execFileSync(process.execPath, [relocMain, "pack", samplePath, gzPath, "--json"], { cwd: relocDir, encoding: "utf8" }),
    ) as { crc32: string; rawBytes: number };
    expect(packOut.rawBytes).toBe(sample.length);
    expect(packOut.crc32).toBe(hexCrc32(sample));
    expect(gunzipSync(readFileSync(gzPath)).equals(sample)).toBe(true);

    const statsOut = JSON.parse(
      execFileSync(process.execPath, [relocMain, "stats", gzPath, "--json"], { cwd: relocDir, encoding: "utf8" }),
    ) as { fileCount: number; errors: number; warns: number; infos: number; files: Array<{ gzipped: boolean; crc32: string }> };
    expect(statsOut).toMatchObject({ fileCount: 1, errors: 1, warns: 1, infos: 1 });
    expect(statsOut.files[0]).toMatchObject({ gzipped: true, crc32: hexCrc32(sample) });

    const grepOut = JSON.parse(
      execFileSync(process.execPath, [relocMain, "grep", "TIMEOUT", gzPath, "--level", "error", "-i", "--json"], {
        cwd: relocDir,
        encoding: "utf8",
      }),
    ) as { matchCount: number; matches: Array<{ lineNo: number; level: string }> };
    expect(grepOut.matchCount).toBe(1);
    expect(grepOut.matches[0]).toMatchObject({ lineNo: 2, level: "ERROR" });

    execFileSync(process.execPath, [relocMain, "unpack", gzPath, unpackedPath], { cwd: relocDir, encoding: "utf8" });
    expect(readFileSync(unpackedPath).equals(sample)).toBe(true);
  }, 120_000);
});
