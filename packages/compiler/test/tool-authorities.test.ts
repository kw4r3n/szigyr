import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { main as cliMain } from "../src/cli.ts";
import { check, CLI_NAME, mutate, run, type Diagnostic } from "../src/index.ts";

const tempDirs: string[] = [];
function makeTmp(prefix = "tool"): string {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const runCli = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
  let out = "", err = "";
  const code = await cliMain(argv, (s) => { out += s; }, (s) => { err += s; });
  return { code, out, err };
};

const offset = (src: string, p: { line: number; col: number }): number =>
  src.split("\n").slice(0, p.line - 1).reduce((n, l) => n + l.length + 1, 0) + p.col - 1;

function fixOnce(src: string): { d: Diagnostic; fixed: string; after: Diagnostic[] } {
  const dir = makeTmp("fix");
  const f = join(dir, "main.szigyr");
  writeFileSync(f, src);
  const d = check(f)[0]!;
  const edits = [...d.fixes![0]!.edits].sort((a, b) => offset(src, b.range.start) - offset(src, a.range.start));
  let fixed = src;
  for (const e of edits) fixed = fixed.slice(0, offset(src, e.range.start)) + e.newText + fixed.slice(offset(src, e.range.end));
  writeFileSync(f, fixed);
  return { d, fixed, after: check(f) };
}

describe("tool authorities E2E (Fs expansion, Proc, Net)", () => {
  it("runs real nodeFs mkdir, atomic writes without leaked temp files, stat, sorted readDir, rename, remove", async () => {
    const dir = makeTmp("fs");
    const workDir = join(dir, "work");
    const entry = join(dir, "main.szigyr");
    writeFileSync(entry, `
export async function main(sys: System): Promise<void> {
  const root = sys.proc.args()[0];
  const mk = sys.fs.mkdir(\`\${root}/sub/nested\`);
  const e1 = sys.fs.exists(\`\${root}/sub/nested\`);
  const wt = sys.fs.writeTextAtomic(\`\${root}/sub/b.txt\`, "hello atomic");
  const buf = Vec.create<u8>(sys.alloc, 3);
  buf.push(10); buf.push(20); buf.push(30);
  const wb = sys.fs.writeBytesAtomic(\`\${root}/sub/a.bin\`, buf.slice(0, 3));
  const failWrite = sys.fs.writeTextAtomic(\`\${root}/sub\`, "should fail");
  const st = sys.fs.stat(\`\${root}/sub/a.bin\`);
  const rd = sys.fs.readDir(\`\${root}/sub\`);
  const rn = sys.fs.rename(\`\${root}/sub/b.txt\`, \`\${root}/sub/c.txt\`);
  const rt = sys.fs.readText(\`\${root}/sub/c.txt\`);
  const rm = sys.fs.remove(\`\${root}/sub\`);
  const e2 = sys.fs.exists(\`\${root}/sub\`);
  const statStr = st.kind === "ok" ? \`\${st.value.kind}:\${st.value.size}:\${st.value.mtimeMs > 0}\` : st.error.code;
  const dirStr = rd.kind === "ok" ? rd.value.map((d: DirEntry) => \`\${d.name}:\${d.kind}\`).join(",") : rd.error.code;
  const txt = rt.kind === "ok" ? rt.value : rt.error.code;
  if (mk.kind !== "ok" || wt.kind !== "ok" || wb.kind !== "ok" || rn.kind !== "ok" || rm.kind !== "ok") {
    sys.log.error("unexpected fs error");
    return;
  }
  sys.log.info(\`e1=\${e1};fail=\${failWrite.kind};stat=\${statStr};dir=\${dirStr};txt=\${txt};e2=\${e2}\`);
}
`);
    const r = await run(entry, { args: [workDir] });
    expect(r.diagnostics).toEqual([]);
    expect(r.trap).toBeNull();
    expect(r.stdout.trim()).toBe("e1=true;fail=err;stat=file:3:true;dir=a.bin:file,b.txt:file,nested:dir;txt=hello atomic;e2=false");
    expect(existsSync(workDir)).toBe(true);
    expect(readdirSync(workDir).some((n) => n.startsWith(".sztmp-"))).toBe(false);
  });

  it("runs real nodeProc via CLI `--` passthrough, env/cwd/stdin/stdout/stderr/timeout/ENOENT and shell:false", async () => {
    const dir = makeTmp("proc");
    const subDir = join(dir, "sub");
    const entry = join(dir, "main.szigyr");
    writeFileSync(entry, `
export async function main(sys: System): Promise<void> {
  const args = sys.proc.args();
  const hasPath = sys.proc.env("PATH") !== null;
  const noVar = sys.proc.env("SZIGYR_NO_SUCH_VAR_999") === null;
  const curCwd = sys.proc.cwd();
  const bin = ${JSON.stringify(process.execPath)};
  const sub = ${JSON.stringify(subDir)};
  const r1 = await sys.proc.run(bin, [
    "-e",
    "const fs=require('node:fs');const i=fs.readFileSync(0,'utf8');process.stdout.write(process.env.SZ_K+':'+process.argv[1]+':'+i+':'+process.cwd());process.stderr.write('err-line');",
    "; echo pwn"
  ], { cwd: sub, env: [{ name: "SZ_K", value: "v1" }], stdin: "ping", timeoutMs: 5000 });
  const r2 = await sys.proc.run(bin, ["-e", "setTimeout(() => {}, 5000)"], { cwd: null, env: [], stdin: null, timeoutMs: 40 });
  const r3 = await sys.proc.run("szigyr-definitely-no-such-binary-999", []);
  const s1 = r1.kind === "ok" ? \`\${r1.value.exitCode}|\${r1.value.stdout}|\${r1.value.stderr}|\${r1.value.timedOut}\` : r1.error.code;
  const s2 = r2.kind === "ok" ? \`to=\${r2.value.timedOut}\` : r2.error.code;
  const s3 = r3.kind === "ok" ? \`ok:\${r3.value.exitCode}\` : r3.error.code;
  sys.log.info(\`args=\${args.join("|")};path=\${hasPath};noVar=\${noVar};cwdOk=\${curCwd === ${JSON.stringify(process.cwd())}};r1=\${s1};r2=\${s2};r3=\${s3}\`);
}
`);
    execFileSync("mkdir", ["-p", subDir]);
    const cli = await runCli(["run", entry, "--", "alpha", "beta gamma"]);
    expect(cli.code, cli.err).toBe(0);
    expect(cli.out.trim()).toBe(
      `args=alpha|beta gamma;path=true;noVar=true;cwdOk=true;r1=0|v1:; echo pwn:ping:${subDir}|err-line|false;r2=to=true;r3=ENOENT`,
    );
  });

  it("runs real nodeNet serve + await using + loopback fetch, ETIMEDOUT, EINVAL, handler trap propagation, and orphan server cleanup", async () => {
    const dir = makeTmp("net");

    const okFile = join(dir, "ok.szigyr");
    writeFileSync(okFile, `
async function roundtrip(net: Net, clock: Clock): Promise<string> {
  const srvRes = await net.serve({ host: "127.0.0.1", port: 0 }, async (req: HttpServerRequest) => {
    if (req.path === "/slow") {
      await clock.sleep(150);
      return { status: 200, headers: [], body: "late" };
    }
    const hdr = req.headers.find((h: HttpHeader) => h.name === "x-in")?.value ?? "";
    return {
      status: 201,
      headers: [{ name: "X-Out", value: \`\${req.method}:\${req.path}:\${req.query}:\${hdr}\` }],
      body: \`body=\${req.body}\`,
    };
  });
  if (srvRes.kind !== "ok") return \`serve=\${srvRes.error.code}\`;
  await using srv = srvRes.value;
  const port = srv.port;
  const r1 = await net.fetch(\`http://127.0.0.1:\${port}/hello\`);
  const r2 = await net.fetch(\`http://127.0.0.1:\${port}/items?a=1\`, {
    method: "POST",
    headers: [{ name: "X-In", value: "9" }],
    body: "payload",
    timeoutMs: 2000,
  });
  const rSlow = await net.fetch(\`http://127.0.0.1:\${port}/slow\`, {
    method: "GET",
    headers: [],
    body: null,
    timeoutMs: 25,
  });
  const s1 = r1.kind === "ok" ? \`\${r1.value.status}:\${r1.value.body}\` : r1.error.code;
  const xout = r2.kind === "ok" ? (r2.value.headers.find((h: HttpHeader) => h.name === "x-out")?.value ?? "missing") : "err";
  const s2 = r2.kind === "ok" ? \`\${r2.value.status}:\${r2.value.body}:\${xout}\` : r2.error.code;
  const s3 = rSlow.kind === "ok" ? "ok" : rSlow.error.code;
  return \`\${port}|r1=\${s1};r2=\${s2};slow=\${s3}\`;
}

export async function main(sys: System): Promise<void> {
  const s = await roundtrip(sys.net, sys.clock);
  const parts = s.split("|");
  const port = parts[0];
  const after = await sys.net.fetch(\`http://127.0.0.1:\${port}/after\`);
  const badProto = await sys.net.fetch("ftp://127.0.0.1/file");
  const aStr = after.kind === "ok" ? "ok" : "err";
  const bStr = badProto.kind === "ok" ? "ok" : badProto.error.code;
  sys.log.info(\`\${parts[1]};after=\${aStr};bad=\${bStr}\`);
}
`);
    const rOk = await run(okFile);
    expect(rOk.diagnostics).toEqual([]);
    expect(rOk.trap).toBeNull();
    expect(rOk.stdout.trim()).toBe(
      "r1=201:body=;r2=201:body=payload:POST:/items:a=1:9;slow=ETIMEDOUT;after=err;bad=EINVAL",
    );

    const trapFile = join(dir, "trap.szigyr");
    writeFileSync(trapFile, `
export async function main(sys: System): Promise<void> {
  const srvRes = await sys.net.serve({ host: "127.0.0.1", port: 0 }, async (_req: HttpServerRequest) => {
    panic("handler boom");
    return { status: 200, headers: [], body: "" };
  });
  if (srvRes.kind !== "ok") return;
  await using srv = srvRes.value;
  const _r = await sys.net.fetch(\`http://127.0.0.1:\${srv.port}/boom\`);
}
`);
    const rTrap = await run(trapFile);
    expect(rTrap.trap?.code).toBe("T006");
    expect(rTrap.trap?.message).toContain("handler boom");

    const orphanFile = join(dir, "orphan.szigyr");
    writeFileSync(orphanFile, `
export async function main(sys: System): Promise<void> {
  const srvRes = await sys.net.serve({ host: "127.0.0.1", port: 0 }, async (_req: HttpServerRequest) => ({
    status: 200,
    headers: [],
    body: "still up",
  }));
  if (srvRes.kind !== "ok") return;
  sys.log.info(\`\${srvRes.value.port}\`);
}
`);
    const rOrphan = await run(orphanFile);
    expect(rOrphan.diagnostics).toEqual([]);
    expect(rOrphan.trap).toBeNull();
    const orphanPort = Number(rOrphan.stdout.trim());
    expect(orphanPort).toBeGreaterThan(0);
    await expect(fetch(`http://127.0.0.1:${orphanPort}/`)).rejects.toThrow();
  });

  it("kills all mutants under szigyr mutate using FakeFs, FakeProc, FakeNet", async () => {
    const dir = makeTmp("mut");
    const file = join(dir, "mod.szigyr");
    writeFileSync(file, `
function saveConfig(fs: Fs, dir: string, name: string, body: string): i32 {
  if (fs.mkdir(dir).kind !== "ok") return 1;
  if (fs.writeTextAtomic(\`\${dir}/\${name}\`, body).kind !== "ok") return 2;
  return 0;
}

async function runTool(proc: Proc, arg: string): Promise<i32> {
  const r = await proc.run("tool", [arg]);
  if (r.kind !== "ok") return -1;
  return r.value.exitCode;
}

async function fetchStatus(net: Net, port: u16): Promise<u16> {
  const r = await net.fetch(\`http://127.0.0.1:\${port}/ok\`);
  if (r.kind !== "ok") return u16(0);
  return r.value.status;
}

test("fake fs, proc, net kill mutants", async (t: Test) => {
  const fs = FakeFs.create();
  t.eq(saveConfig(fs, "/app", "cfg.txt", "on"), 0);
  const txt = fs.readText("/app/cfg.txt");
  t.eq(txt.kind === "ok" ? txt.value : "", "on");
  const _blocker = fs.writeText("/blocker", "x");
  t.eq(saveConfig(fs, "/blocker/sub", "cfg.txt", "on"), 1);
  const _dirTarget = fs.mkdir("/app/subdir");
  t.eq(saveConfig(fs, "/app", "subdir", "on"), 2);

  const fp = FakeProc.create();
  t.eq(await runTool(fp, "x"), -1);
  fp.onRun((req: ProcRequest) => ok({ exitCode: req.args[0] === "x" ? 7 : 1, stdout: "", stderr: "", timedOut: false }));
  t.eq(await runTool(fp, "x"), 7);
  t.eq(await runTool(fp, "y"), 1);

  const fn = FakeNet.create();
  const s = await fn.serve({ host: "127.0.0.1", port: 0 }, async (_req: HttpServerRequest) => ({ status: 204, headers: [], body: "" }));
  if (s.kind !== "ok") { t.ok(false); return; }
  await using srv = s.value;
  t.eq(await fetchStatus(fn, srv.port), u16(204));
  await srv.close();
  t.eq(await fetchStatus(fn, srv.port), u16(0));
});
`);
    const res = await mutate(file, { cache: false, cacheFile: join(dir, "mut.json") });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    expect(res.mutants.length).toBeGreaterThan(0);
    expect(res.mutants.filter((m) => m.status === "survived")).toEqual([]);
  });

  it("provides E5001 authority fixes for fetch/process and reports E4001 for net.fetch/proc.cwd/fs.mkdir in strict", () => {
    const netFix = fixOnce('export async function f(): Promise<void> {\n  const _r = await fetch("http://127.0.0.1/");\n}\n');
    expect(netFix.d.code).toBe("E5001");
    expect(netFix.fixed).toContain("net: Net");
    expect(netFix.fixed).toContain("net.fetch");
    expect(netFix.after.filter((x) => x.code === "E5001")).toEqual([]);

    const procFix = fixOnce("export function f(): string {\n  return process.cwd();\n}\n");
    expect(procFix.d.code).toBe("E5001");
    expect(procFix.fixed).toContain("proc: Proc");
    expect(procFix.fixed).toContain("proc.cwd");
    expect(procFix.after.filter((x) => x.code === "E5001")).toEqual([]);

    const dir = makeTmp("e4001");
    const strictFile = join(dir, "strict.szigyr");
    writeFileSync(strictFile, `
function a(net: Net): void {
  "use owned";
  net.fetch("http://127.0.0.1/");
}
function b(proc: Proc): void {
  "use owned";
  proc.cwd();
}
function c(fs: Fs): void {
  "use owned";
  fs.mkdir("d");
}
`);
    const codes = check(strictFile).map((d) => `${d.range.start.line}:${d.code}`);
    expect(codes).toContain("4:E4001");
    expect(codes).toContain("8:E4001");
    expect(codes).toContain("12:E4001");
  });

  it("bundles Fs/Proc/Net in buildNode (--backend=c, relocated) and buildBrowser (zero node: imports)", async () => {
    const dir = makeTmp("build");
    const nodeEntry = join(dir, "node-app.szigyr");
    const workSub = join(dir, "node-work");
    writeFileSync(nodeEntry, `
function sumPair(a: i32, b: i32): i32 {
  "use rt";
  return a + b;
}
export async function main(sys: System): Promise<void> {
  const args = sys.proc.args();
  const root = ${JSON.stringify(workSub)};
  const _mk = sys.fs.mkdir(root);
  const _wt = sys.fs.writeTextAtomic(\`\${root}/msg.txt\`, \`\${sumPair(20, 22)}\`);
  const rt = sys.fs.readText(\`\${root}/msg.txt\`);
  const sRes = await sys.net.serve({ host: "127.0.0.1", port: 0 }, async (req: HttpServerRequest) => ({
    status: 200,
    headers: [],
    body: \`net:\${req.path}\`,
  }));
  if (sRes.kind !== "ok") return;
  await using srv = sRes.value;
  const fRes = await sys.net.fetch(\`http://127.0.0.1:\${srv.port}/hi\`);
  const fsOut = rt.kind === "ok" ? rt.value : "err";
  const netOut = fRes.kind === "ok" ? fRes.value.body : "err";
  sys.log.info(\`args=\${args.join(",")};fs=\${fsOut};net=\${netOut}\`);
}
`);
    const nodeOut = join(dir, "node-out");
    const bNode = await runCli(["build", "--target=node", "--backend=c", "-o", nodeOut, nodeEntry]);
    expect(bNode.code, bNode.err).toBe(0);

    const isoDir = makeTmp("node-iso");
    cpSync(nodeOut, isoDir, { recursive: true });
    rmSync(nodeOut, { recursive: true, force: true });
    const stdout = execFileSync(process.execPath, [join(isoDir, "main.js"), "argA", "argB"], { encoding: "utf8" });
    expect(stdout.trim()).toBe("args=argA,argB;fs=42;net=net:/hi");

    const browserEntry = join(dir, "browser-app.szigyr");
    writeFileSync(browserEntry, `
export async function main(sys: System): Promise<void> {
  const bFs = sys.fs.mkdir("/x");
  const bProc = await sys.proc.run("ls", []);
  const bNet = await sys.net.serve({ host: "127.0.0.1", port: 0 }, async (_r: HttpServerRequest) => ({ status: 200, headers: [], body: "" }));
  const fp = FakeProc.create();
  fp.onRun((_r: ProcRequest) => ok({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false }));
  const pr = await fp.run("echo", []);
  const fn = FakeNet.create();
  const ns = await fn.serve({ host: "127.0.0.1", port: 0 }, async (r: HttpServerRequest) => ({ status: 200, headers: [], body: r.path }));
  let nfBody = "err";
  if (ns.kind === "ok") {
    await using srv = ns.value;
    const nf = await fn.fetch(\`http://127.0.0.1:\${srv.port}/b\`);
    if (nf.kind === "ok") nfBody = nf.value.body;
  }
  const c1 = bFs.kind === "err" ? bFs.error.code : "ok";
  const c2 = bProc.kind === "err" ? bProc.error.code : "ok";
  const c3 = bNet.kind === "err" ? bNet.error.code : "ok";
  const pOut = pr.kind === "ok" ? pr.value.stdout : "err";
  sys.log.info(\`enosys=\${c1},\${c2},\${c3};fake=\${pOut},\${nfBody}\`);
}
`);
    const browserOut = join(dir, "browser-out");
    const bBrowser = await runCli(["build", "--target=browser", "-o", browserOut, browserEntry]);
    expect(bBrowser.code, bBrowser.err).toBe(0);

    const emittedJs = ["app.js", "program.js", `${CLI_NAME}-worker.js`, ...readdirSync(join(browserOut, "rt")).map((f) => join("rt", f))];
    for (const rel of emittedJs) {
      expect(readFileSync(join(browserOut, rel), "utf8"), rel).not.toMatch(/["']node:/);
    }

    const appMod = await import(pathToFileURL(join(browserOut, "app.js")).href);
    const loaded = await appMod.load();
    try {
      const bRes = await loaded.run();
      expect(bRes.trap).toBeNull();
      expect(bRes.stdout.trim()).toBe("enosys=ENOSYS,ENOSYS,ENOSYS;fake=ok,/b");
    } finally {
      await loaded.stop();
    }
  });
});
