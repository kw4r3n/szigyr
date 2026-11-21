import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main as cliMain } from "../src/cli.ts";
import { check, run } from "../src/index.ts";

const tmpRoots: string[] = [];
function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

async function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    const u = (req.url ?? "/").split("?")[0]!;
    const rel = u === "/" ? "index.html" : u.replace(/^\/+/, "");
    const abs = resolve(dir, rel);
    if (!abs.startsWith(resolve(dir)) || !existsSync(abs)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
    res.end(readFileSync(abs));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const code = await cliMain(argv, (s) => { out += s; }, (s) => { err += s; });
  return { code, out, err };
}

const pw = findPlaywright();

describe("sys.js practicality upgrades (new, invoke, set, object, fn)", () => {
  it("typechecks valid forms including ReadonlyArray args and rejects contract/layer/return misuse", () => {
    const dir = makeTmp("szigyr-jsinterop-chk-");
    const okFile = join(dir, "ok.szigyr");
    writeFileSync(okFile, `export function okAll(js: Js, ctor: JsRef, f: JsRef, ro: ReadonlyArray<JsRef>): void {
  const obj = js.object([{ key: "empty", value: js.object([]) }, { key: "n", value: js.encode<i32>(1) }]);
  const inst = js.new(ctor, ro);
  const inv = js.invoke(obj, "m", ro);
  const called = js.call(f, ro);
  const s = js.set(obj, "k", obj);
  const f0 = js.fn((): JsRef => obj);
  const fArr = js.fn((args: Array<JsRef>): JsRef => args[0]);
  const fRo = js.fn((args: ReadonlyArray<JsRef>): JsRef => args[0]);
  if (inst.kind === "ok" && inv.kind === "ok" && called.kind === "ok" && s.kind === "ok") {
    const _r = js.call(f0, [fArr, fRo]);
  }
}
`);
    expect(check(okFile)).toEqual([]);

    const badCases: [string, string, string][] = [
      ["bad-fn-ret", "E2002", `function f(js: Js): JsRef { return js.fn((args: Array<JsRef>): string => "nope"); }\n`],
      ["new-in-contract", "E6002", `function f(js: Js, c: JsRef): boolean { requires(js.new(c, []).kind === "ok"); return true; }\n`],
      ["invoke-in-contract", "E6002", `function f(js: Js, o: JsRef): boolean { requires(js.invoke(o, "m", []).kind === "ok"); return true; }\n`],
      ["set-in-contract", "E6002", `function f(js: Js, o: JsRef): boolean { requires(js.set(o, "k", o).kind === "ok"); return true; }\n`],
      ["object-in-owned", "E4002", `function f(js: Js): void { "use owned"; const _x = js.object([]); }\n`],
      ["object-in-rt", "E4006", `function f(js: Js): void { "use rt"; const _x = js.object([]); }\n`],
    ];
    for (const [name, code, src] of badCases) {
      const p = join(dir, `${name}.szigyr`);
      writeFileSync(p, src);
      const ds = check(p);
      expect(ds.map((d) => d.code), name).toContain(code);
    }
  });

  it("drives class ctors, this-bound methods, property writes, object schemas, and sorting callbacks across run, node, browser, and Chromium", async () => {
    const srcDir = makeTmp("szigyr-jsinterop-src-");
    const nm = join(srcDir, "node_modules", "js-kit");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "package.json"), JSON.stringify({
      name: "js-kit",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./index.mjs" },
    }));
    writeFileSync(join(nm, "index.mjs"), `export class Vec3 {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  add(other) { return new Vec3(this.x + other.x, this.y + other.y, this.z + other.z); }
  lenSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
}

export const schema = {
  num: () => ({ parse(v) { if (typeof v !== "number") throw new Error("not number"); return v; } }),
  str: () => ({ parse(v) { if (typeof v !== "string") throw new Error("not string"); return v; } }),
  object: (shape) => ({
    shape,
    validate(val) {
      if (!val || typeof val !== "object") return { ok: false, error: "not object" };
      const out = {};
      for (const [k, s] of Object.entries(this.shape)) {
        try { out[k] = s.parse(val[k]); } catch (e) { return { ok: false, error: e.message }; }
      }
      return { ok: true, value: out };
    },
  }),
};

export function sortWith(xs, cmp) {
  return [...xs].sort(cmp);
}
`);

    const entry = join(srcDir, "app.szigyr");
    writeFileSync(entry, `import { Vec3, schema, sortWith } from "npm:js-kit";

type Validated = { readonly ok: boolean; readonly value: { readonly count: i32; readonly name: string } };

function runClassAndSchema(js: Js): string {
  const v1r = js.new(Vec3, [js.encode<f64>(1), js.encode<f64>(2), js.encode<f64>(3)]);
  const v2r = js.new(Vec3, [js.encode<f64>(4), js.encode<f64>(5), js.encode<f64>(6)]);
  if (v1r.kind === "err" || v2r.kind === "err") return "new-err";
  if (js.set(v1r.value, "x", js.encode<f64>(10)).kind === "err") return "set-err";
  const sumR = js.invoke(v1r.value, "add", [v2r.value]);
  if (sumR.kind === "err") return "add-err";
  const lenR = js.invoke(sumR.value, "lenSq", []);
  if (lenR.kind === "err") return "len-err";
  const len = js.decode<f64>(lenR.value);
  if (len.kind === "err") return "len-dec-err";

  const numS = js.invoke(schema, "num", []);
  const strS = js.invoke(schema, "str", []);
  if (numS.kind === "err" || strS.kind === "err") return "field-schema-err";
  const shape = js.object([{ key: "count", value: numS.value }, { key: "name", value: strS.value }]);
  const objS = js.invoke(schema, "object", [shape]);
  if (objS.kind === "err") return "obj-schema-err";
  const payload = js.encode<{ readonly count: i32; readonly name: string }>({ count: 7, name: "sz" });
  const valR = js.invoke(objS.value, "validate", [payload]);
  if (valR.kind === "err") return "validate-err";
  const parsed = js.decode<Validated>(valR.value);
  if (parsed.kind === "err" || !parsed.value.ok) return "validate-dec-err";

  const cmp = js.fn((args: Array<JsRef>): JsRef => {
    const a = js.decode<i32>(args[0]);
    const b = js.decode<i32>(args[1]);
    if (a.kind !== "ok" || b.kind !== "ok") panic("bad cmp arg");
    return js.encode<i32>(a.value - b.value);
  });
  const sortedR = js.call(sortWith, [js.encode<Array<i32>>([30, 10, 20]), cmp]);
  if (sortedR.kind === "err") return "sort-err";
  const sorted = js.decode<Array<i32>>(sortedR.value);
  if (sorted.kind === "err") return "sort-dec-err";

  return \`len=\${len.value};val=\${parsed.value.value.name}:\${parsed.value.value.count};sorted=\${sorted.value.join(",")}\`;
}

export function main(sys: System): void {
  sys.log.info(runClassAndSchema(sys.js));
}

export function mainTrap(sys: System): void {
  const cmpBoom = sys.js.fn((args: Array<JsRef>): JsRef => {
    const a = sys.js.decode<i32>(args[0]);
    if (a.kind === "ok" && a.value === 13) panic("cmp boom");
    return sys.js.encode<i32>(0);
  });
  sys.js.call(sortWith, [sys.js.encode<Array<i32>>([10, 13, 5]), cmpBoom]);
}
`);

    const wantOut = "len=326;val=sz:7;sorted=10,20,30\n";

    // 1. Direct szigyr run (+ trap propagation inside js.fn)
    const rOk = await run(entry);
    expect(rOk.diagnostics).toEqual([]);
    expect(rOk.trap).toBeNull();
    expect(rOk.stdout).toBe(wantOut);

    const trapEntry = join(srcDir, "trap.szigyr");
    writeFileSync(trapEntry, `import { mainTrap } from "./app.szigyr";\nexport function main(sys: System): void { mainTrap(sys); }\n`);
    const rTrap = await run(trapEntry);
    expect(rTrap.diagnostics).toEqual([]);
    expect(rTrap.trap).toMatchObject({ code: "T006" });
    expect(rTrap.trap!.file).toContain("app.szigyr");
    expect(rTrap.trap!.line).toBeGreaterThan(0);

    // 2. Relocated standalone Node build
    const nodeOut = makeTmp("szigyr-jsinterop-node-out-");
    const nodeIso = makeTmp("szigyr-jsinterop-node-iso-");
    expect((await runCli(["build", "--target=node", "-o", nodeOut, entry])).code).toBe(0);
    cpSync(nodeOut, nodeIso, { recursive: true });
    rmSync(nodeOut, { recursive: true, force: true });
    expect(execFileSync(process.execPath, [join(nodeIso, "main.js")], { encoding: "utf8" })).toBe(wantOut);

    // 3. Relocated standalone Browser build (Node ESM execution + Chromium)
    const brOut = makeTmp("szigyr-jsinterop-br-out-");
    const brIso = makeTmp("szigyr-jsinterop-br-iso-");
    expect((await runCli(["build", "--target=browser", "-o", brOut, entry])).code).toBe(0);
    cpSync(brOut, brIso, { recursive: true });
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(brOut, { recursive: true, force: true });

    for (const rel of ["app.js", "program.js", "szigyr-worker.js", "szigyr-worklet.js"]) {
      expect(readFileSync(join(brIso, rel), "utf8")).not.toMatch(/["']node:/);
    }

    let esmStdout = "";
    const mod = await import(pathToFileURL(join(brIso, "app.js")).href) as {
      load: () => Promise<{ run: (fn?: unknown, opts?: Record<string, unknown>) => Promise<{ trap: unknown; stdout: string }> }>;
    };
    const loaded = await mod.load();
    const esmRes = await loaded.run(undefined, { stdout: (s: string) => { esmStdout += s; } });
    expect(esmRes.trap).toBeNull();
    expect(esmStdout).toBe(wantOut);

    if (pw) {
      const srv = await serveDir(brIso);
      const browser = await pw.launch();
      try {
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (e: Error) => pageErrors.push(e.message));
        await page.goto(srv.url);
        const res = await page.evaluate(`(async () => {
          const { start } = await import("./app.js");
          return start();
        })()`) as { trap: unknown; stdout: string };
        expect(pageErrors).toEqual([]);
        expect(res.trap).toBeNull();
        expect(res.stdout).toBe(wantOut);
      } finally {
        await browser.close();
        await srv.close();
      }
    }
  }, 60000);
});
