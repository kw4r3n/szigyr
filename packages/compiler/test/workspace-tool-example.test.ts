import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { main as cliMain } from "../src/cli.ts";
import { analyze, buildNode, check, prove, queryFile, runTestFile, type Backend } from "../src/index.ts";
import { mutateFile } from "../src/mutate.ts";

const EXAMPLE_DIR = resolve(import.meta.dirname, "../../../examples/workspace-tool");
const MAIN_SZIGYR = join(EXAMPLE_DIR, "main.szigyr");
const CORE_SZIGYR = join(EXAMPLE_DIR, "core.szigyr");
const SCAN_SZIGYR = join(EXAMPLE_DIR, "scan.szigyr");

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

function hasTmpFilesRecursive(dir: string): boolean {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".sztmp-")) return true;
    if (ent.isDirectory() && hasTmpFilesRecursive(join(dir, ent.name))) return true;
  }
  return false;
}

function findPlaywright(): { launch: (opts?: Record<string, unknown>) => Promise<any> } | null {
  try {
    const req = createRequire(import.meta.url);
    const pw = (() => {
      try {
        return req("playwright");
      } catch {
        const bin = execFileSync("which", ["playwright"], { encoding: "utf8" }).trim();
        return createRequire(bin)(resolve(dirname(bin), "..", "playwright"));
      }
    })();
    let executablePath: string | undefined;
    try {
      const def = pw.chromium.executablePath();
      if (!existsSync(def)) {
        const cache = join(homedir(), ".cache/ms-playwright");
        if (existsSync(cache)) {
          const dir = readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().at(-1);
          if (dir) {
            executablePath = [
              join(cache, dir, "chrome-linux64/chrome"),
              join(cache, dir, "chrome-linux/chrome"),
            ].find((p) => existsSync(p));
          }
        }
      } else {
        executablePath = def;
      }
    } catch {
      /* fallback */
    }
    if (!executablePath) return null;
    return { launch: (opts) => pw.chromium.launch({ executablePath, ...opts }) };
  } catch {
    return null;
  }
}

describe("examples/workspace-tool real-app dogfood verification", () => {
  it("passes check with zero diagnostics and exposes expected layer and Mutatable metadata", () => {
    expect(check(MAIN_SZIGYR)).toEqual([]);

    const qScan = queryFile(SCAN_SZIGYR);
    expect(qScan.diagnostics).toEqual([]);
    expect(qScan.symbols.find((s) => s.name === "scanBytes")).toMatchObject({
      kind: "function",
      layer: "rt",
      pure: true,
      mutatable: true,
    });

    const qCore = queryFile(CORE_SZIGYR);
    expect(qCore.diagnostics).toEqual([]);
    for (const fnName of ["scanWorkspace", "saveWorkspaceFile", "runWorkspaceTool", "runSelfCheck"]) {
      expect(qCore.symbols.find((s) => s.name === fnName)).toMatchObject({
        kind: "function",
        layer: "managed",
        pure: false,
        mutatable: true,
      });
    }

    const qMain = queryFile(MAIN_SZIGYR);
    expect(qMain.diagnostics).toEqual([]);
    expect(qMain.symbols.find((s) => s.name === "main")).toMatchObject({
      kind: "function",
      layer: "managed",
      pure: false,
      mutatable: false,
    });
  });

  it("passes all colocated unit and forAll tests identically across js, c, and wasm", async () => {
    const backends: Backend[] = ["js", "c", "wasm"];
    const namesByBackend: string[][] = [];
    for (const backend of backends) {
      const r = await runTestFile(MAIN_SZIGYR, { backend });
      expect(r.diagnostics, `diagnostics for ${backend}`).toEqual([]);
      expect(r.results.length).toBeGreaterThanOrEqual(6);
      for (const t of r.results) {
        expect(t.ok, `${backend} test ${t.name}: ${t.failure ?? ""}`).toBe(true);
      }
      namesByBackend.push(r.results.map((t) => t.name));
    }
    expect(namesByBackend[1]).toEqual(namesByBackend[0]);
    expect(namesByBackend[2]).toEqual(namesByBackend[0]);
  }, 120_000);

  it("proves all scan.szigyr rt obligations cleanly with zero failures or unknowns", async () => {
    const res = await prove(MAIN_SZIGYR, { all: true, cache: false });
    expect(res.diagnostics).toEqual([]);
    expect(res.summary.failed).toBe(0);
    expect(res.summary.unknown).toBe(0);
    expect(res.summary.timeout).toBe(0);
    expect(res.summary.proved).toBeGreaterThan(0);
  }, 120_000);

  it("achieves zero surviving mutants across all workspace-tool modules", async () => {
    const res = await mutateFile(MAIN_SZIGYR, { all: true, cache: false });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    expect(res.summary.targets).toBeGreaterThan(25);
    expect(res.summary.killed).toBeGreaterThan(200);
    expect(res.summary.survived).toBe(0);
  }, 120_000);

  it("runs real Fs/Proc/Net subcommands via CLI -- argument passthrough", async () => {
    const ws = makeTmp("szigyr-ws-cli-");
    writeFileSync(join(ws, "seed.txt"), "seed line\n");

    const saveRes = await runCli([
      "run", MAIN_SZIGYR, "--",
      "save", "--root", ws, "--path", "sub/alpha.txt", "--body", "hello\nszigyr\n",
    ]);
    expect(saveRes.code, saveRes.err).toBe(0);
    expect(JSON.parse(saveRes.out)).toMatchObject({ path: "sub/alpha.txt", backedUp: false, bytes: 13, newlines: 2 });

    const scanRes = await runCli(["run", MAIN_SZIGYR, "--", "scan", "--root", ws]);
    expect(scanRes.code, scanRes.err).toBe(0);
    const scanned = JSON.parse(scanRes.out) as { fileCount: number; files: { path: string }[] };
    expect(scanned.fileCount).toBe(2);
    expect(scanned.files.map((f) => f.path)).toEqual(["seed.txt", "sub/alpha.txt"]);

    const execRes = await runCli([
      "run", MAIN_SZIGYR, "--",
      "exec", "--root", ws, "--bin", process.execPath,
      "--arg", "-e", "--arg", "process.stdout.write(process.env.SZIGYR_WORKSPACE + ':' + process.cwd())",
    ]);
    expect(execRes.code, execRes.err).toBe(0);
    expect(JSON.parse(execRes.out)).toMatchObject({ exitCode: 0, stdout: `${ws}:${ws}`, timedOut: false });

    const delRes = await runCli(["run", MAIN_SZIGYR, "--", "delete", "--root", ws, "--path", "seed.txt"]);
    expect(delRes.code, delRes.err).toBe(0);
    expect(JSON.parse(delRes.out)).toEqual({ ok: true, path: "seed.txt" });
    expect(existsSync(join(ws, "seed.txt"))).toBe(false);

    const selfWs = makeTmp("szigyr-ws-cli-self-");
    const scRes = await runCli([
      "run", MAIN_SZIGYR, "--",
      "selfcheck", "--root", selfWs, "--bin", process.execPath, "--arg", "-e", "--arg", "process.stdout.write('ok')",
    ]);
    expect(scRes.code, scRes.err).toBe(0);
    expect(scRes.out.trim()).toMatch(/^selfcheck:ok:files=3:saved=true:snap=.*:run=0:ok$/);
    expect(hasTmpFilesRecursive(ws)).toBe(false);
    expect(hasTmpFilesRecursive(selfWs)).toBe(false);
  }, 60_000);

  const pw = findPlaywright();
  it("builds relocated release --target=node bundle and serves real HTTP + UI requests cleanly", async () => {
    const analysis = analyze(MAIN_SZIGYR);
    expect(analysis.diagnostics).toEqual([]);
    const proveRes = await prove(MAIN_SZIGYR, { analysis, all: true, cache: false });
    expect(proveRes.diagnostics).toEqual([]);
    expect(proveRes.summary.failed).toBe(0);
    expect(proveRes.summary.unknown).toBe(0);

    const distDir = makeTmp("szigyr-ws-node-");
    const built = buildNode(MAIN_SZIGYR, { outDir: distDir, backend: "c", analysis, proved: proveRes.proved });
    expect(built.diagnostics).toEqual([]);
    expect(built.files).toContain("program.node");
    expect(built.files).toContain("main.js");
    expect(built.provedEliminated).toBeGreaterThan(0);

    const relocated = makeTmp("szigyr-ws-reloc-");
    cpSync(distDir, relocated, { recursive: true });

    const selfWs = makeTmp("szigyr-ws-reloc-self-");
    const selfOut = execFileSync(
      process.execPath,
      [join(relocated, "main.js"), "selfcheck", "--root", selfWs, "--bin", process.execPath, "--arg", "-e", "--arg", "process.stdout.write('ok')"],
      { cwd: relocated, encoding: "utf8" },
    );
    expect(selfOut.trim()).toMatch(/^selfcheck:ok:files=3:saved=true:snap=.*:run=0:ok$/);

    const wsRoot = makeTmp("szigyr-ws-serve-");
    mkdirSync(join(wsRoot, "docs"), { recursive: true });
    writeFileSync(join(wsRoot, "docs/init.txt"), "initial\n");

    const child = spawn(
      process.execPath,
      [join(relocated, "main.js"), "serve", "--root", wsRoot, "--host", "127.0.0.1", "--port", "0"],
      { cwd: relocated, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderrText = "";
    child.stderr.on("data", (chunk: Buffer) => { stderrText += chunk.toString("utf8"); });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const listeningUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
      const timer = setTimeout(() => rejectUrl(new Error(`timeout waiting for listening= line; stderr=${stderrText}`)), 15_000);
      rl.on("line", (line) => {
        if (line.startsWith("listening=")) {
          clearTimeout(timer);
          resolveUrl(line.slice("listening=".length).trim());
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        rejectUrl(new Error(`server exited early with ${code}; stderr=${stderrText}`));
      });
    });

    const exitPromise = new Promise<number | null>((r) => child.once("close", (code) => r(code)));
    let shutdownSent = false;
    try {
      const htmlRes = await fetch(`${listeningUrl}/`);
      expect(htmlRes.status).toBe(200);
      expect(await htmlRes.text()).toContain("szigyr workspace-tool");

      const scanRes1 = await fetch(`${listeningUrl}/api/scan`);
      expect(scanRes1.status).toBe(200);
      const scanData1 = await scanRes1.json() as { fileCount: number; files: { path: string }[] };
      expect(scanData1.fileCount).toBe(1);
      expect(scanData1.files[0]?.path).toBe("docs/init.txt");

      const saveRes = await fetch(`${listeningUrl}/api/save`, {
        method: "POST",
        body: JSON.stringify({ path: "notes/hi.txt", content: "hi\nszigyr\n" }),
      });
      expect(saveRes.status).toBe(200);
      expect(await saveRes.json()).toMatchObject({ path: "notes/hi.txt", bytes: 10, newlines: 2 });

      const fileRes = await fetch(`${listeningUrl}/api/file?path=${encodeURIComponent("notes/hi.txt")}`);
      expect(fileRes.status).toBe(200);
      expect(await fileRes.text()).toBe("hi\nszigyr\n");

      const snapRes = await fetch(`${listeningUrl}/api/snapshot`, {
        method: "POST",
        body: JSON.stringify({ src: "notes/hi.txt", dst: "notes/hi.bin" }),
      });
      expect(snapRes.status).toBe(200);
      expect(await snapRes.json()).toMatchObject({ src: "notes/hi.txt", dst: "notes/hi.bin", bytes: 10 });

      const runRes = await fetch(`${listeningUrl}/api/run`, {
        method: "POST",
        body: JSON.stringify({ program: process.execPath, args: ["-e", "process.stdout.write('served-ok')"], timeoutMs: 3000 }),
      });
      expect(runRes.status).toBe(200);
      expect(await runRes.json()).toMatchObject({ exitCode: 0, stdout: "served-ok", timedOut: false });

      const delRes = await fetch(`${listeningUrl}/api/delete`, {
        method: "POST",
        body: JSON.stringify({ path: "notes/hi.bin" }),
      });
      expect(delRes.status).toBe(200);
      expect(await delRes.json()).toEqual({ ok: true, path: "notes/hi.bin" });

      // UTF-8 Japanese path roundtrip via real nodeFs + HTTP query Url.getQueryParam
      const jpSave = await fetch(`${listeningUrl}/api/save`, {
        method: "POST",
        body: JSON.stringify({ path: "notes/日本語.txt", content: "こんにちは\n" }),
      });
      expect(jpSave.status).toBe(200);
      const jpFile = await fetch(`${listeningUrl}/api/file?path=${encodeURIComponent("notes/日本語.txt")}`);
      expect(jpFile.status).toBe(200);
      expect(await jpFile.text()).toBe("こんにちは\n");

      if (pw) {
        const browser = await pw.launch();
        try {
          const page = await browser.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (e: Error) => pageErrors.push(String(e)));

          await page.goto(`${listeningUrl}/`, { waitUntil: "load" });
          await page.waitForFunction(
            () => (document.getElementById("files-body")?.textContent ?? "").includes("notes/hi.txt"),
            undefined,
            { timeout: 10_000 },
          );
          await page.fill("#file-path", "ui-note.txt");
          await page.fill("#file-content", "from-ui\n");
          await page.click("#save-btn");
          await page.waitForFunction(
            () => (document.getElementById("summary")?.textContent ?? "").includes("files=4"),
            undefined,
            { timeout: 10_000 },
          );
          expect(pageErrors).toEqual([]);
        } finally {
          await browser.close();
        }
      }

      const shutRes = await fetch(`${listeningUrl}/api/shutdown`, { method: "POST" });
      shutdownSent = true;
      expect(shutRes.status).toBe(200);
      expect(await shutRes.json()).toEqual({ stopped: true });
    } finally {
      if (!shutdownSent && child.exitCode === null) {
        try {
          await fetch(`${listeningUrl}/api/shutdown`, { method: "POST" });
        } catch {
          child.kill("SIGTERM");
        }
      }
      rl.close();
    }

    const exitCode = await exitPromise;
    expect(exitCode, stderrText).toBe(0);
    expect(hasTmpFilesRecursive(wsRoot)).toBe(false);
    expect(hasTmpFilesRecursive(selfWs)).toBe(false);
  }, 120_000);
});
