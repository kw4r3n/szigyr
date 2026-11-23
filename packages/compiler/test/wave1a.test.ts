import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { emitFile } from "../src/emit.ts";
import { analyze, buildBrowser, buildNode, check, CLI_NAME, mutate, prove, queryFile, run, shutdownSmt } from "../src/index.ts";

const tmpRoots: string[] = [];
function makeProject(files: Record<string, string>, prefix = `${CLI_NAME}-w1a-`): { dir: string; entry: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  for (const [rel, src] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  return { dir, entry: join(dir, "main.szigyr") };
}

afterAll(async () => {
  await shutdownSmt();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("Wave 1-A TS syntax relaxations", () => {
  it("supports npm: default, namespace, and combined imports for ESM & CJS in run, buildNode, and buildBrowser", async () => {
    const { entry } = makeProject({
      "node_modules/esm-def/package.json": JSON.stringify({ name: "esm-def", type: "module", main: "index.mjs" }),
      "node_modules/esm-def/index.mjs": `export default function addTwo(x) { return x + 2; }\n`,
      "node_modules/esm-mix/package.json": JSON.stringify({ name: "esm-mix", type: "module", main: "index.mjs" }),
      "node_modules/esm-mix/index.mjs": `export default function defMul(x) { return x * 10; }\nexport const extra = 5;\n`,
      "node_modules/cjs-fn/package.json": JSON.stringify({ name: "cjs-fn", main: "index.cjs" }),
      "node_modules/cjs-fn/index.cjs": `module.exports = function subOne(x) { return x - 1; };\n`,
      "node_modules/cjs-obj/package.json": JSON.stringify({ name: "cjs-obj", main: "index.cjs" }),
      "node_modules/cjs-obj/index.cjs": `exports.double = (x) => x * 2;\n`,
      "main.szigyr": [
        `import addTwo from "npm:esm-def";`,
        `import defMul, { extra } from "npm:esm-mix";`,
        `import subOne from "npm:cjs-fn";`,
        `import * as cjsNs from "npm:cjs-obj";`,
        `function call1(sys: System, fn: JsRef, arg: i32): i32 {`,
        `  const r = sys.js.call(fn, [sys.js.encode<i32>(arg)]);`,
        `  if (r.kind !== "ok") return -1;`,
        `  const d = sys.js.decode<i32>(r.value);`,
        `  return d.kind === "ok" ? d.value : -2;`,
        `}`,
        `export function main(sys: System): void {`,
        `  const a = call1(sys, addTwo, 3);`,
        `  const b = call1(sys, defMul, 4);`,
        `  const ex = sys.js.decode<i32>(extra);`,
        `  const c = call1(sys, subOne, 9);`,
        `  const fnDbl = sys.js.get(cjsNs, "double");`,
        `  const d = fnDbl.kind === "ok" ? call1(sys, fnDbl.value, 6) : -3;`,
        `  const e = ex.kind === "ok" ? ex.value : -4;`,
        `  sys.log.info(\`\${a},\${b},\${e},\${c},\${d}\`);`,
        `}`,
        ``,
      ].join("\n"),
    });

    const direct = await run(entry);
    expect(direct.diagnostics).toEqual([]);
    expect(direct.trap).toBeNull();
    expect(direct.stdout).toBe("5,40,5,8,12\n");

    const nodeOut = mkdtempSync(join(tmpdir(), "szigyr-w1a-bnode-"));
    tmpRoots.push(nodeOut);
    const nb = buildNode(entry, { outDir: nodeOut, backend: "js" });
    expect(nb.diagnostics).toEqual([]);
    const nodeIso = mkdtempSync(join(tmpdir(), "szigyr-w1a-niso-"));
    tmpRoots.push(nodeIso);
    cpSync(nodeOut, nodeIso, { recursive: true });
    const nodeApp = await import(pathToFileURL(join(nodeIso, "app.js")).href) as {
      load: () => Promise<{ run: (fn?: unknown, opts?: Record<string, unknown>) => Promise<{ trap: unknown; stdout: string }>; stop: () => Promise<void> }>;
    };
    const nLoaded = await nodeApp.load();
    const nRes = await nLoaded.run();
    await nLoaded.stop();
    expect(nRes.trap).toBeNull();
    expect(nRes.stdout).toBe("5,40,5,8,12\n");

    const brOut = mkdtempSync(join(tmpdir(), "szigyr-w1a-bbr-"));
    tmpRoots.push(brOut);
    const bb = buildBrowser(entry, { outDir: brOut });
    expect(bb.diagnostics).toEqual([]);
    const brIso = mkdtempSync(join(tmpdir(), "szigyr-w1a-biso-"));
    tmpRoots.push(brIso);
    cpSync(brOut, brIso, { recursive: true });
    let brStdout = "";
    const brApp = await import(pathToFileURL(join(brIso, "app.js")).href) as {
      load: () => Promise<{ run: (fn?: unknown, opts?: Record<string, unknown>) => Promise<{ trap: unknown }> }>;
    };
    const bLoaded = await brApp.load();
    const bRes = await bLoaded.run(undefined, { stdout: (s: string) => { brStdout += s; } });
    expect(bRes.trap).toBeNull();
    expect(brStdout).toBe("5,40,5,8,12\n");
  });

  it("emits W8001 warning when calling ns.strictFn() inside a managed loop", () => {
    const { entry } = makeProject({
      "native.szigyr": `export function step(x: i32): i32 { "use owned"; return x + 1; }\n`,
      "main.szigyr": [
        `import * as n from "./native.szigyr";`,
        `export function runLoop(xs: readonly i32[]): i32 {`,
        `  let acc: i32 = 0;`,
        `  for (const x of xs) acc += n.step(x);`,
        `  return acc;`,
        `}`,
        ``,
      ].join("\n"),
    });
    const diags = check(entry);
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
    expect(diags.filter((d) => d.code === "W8001")).toMatchObject([
      { code: "W8001", severity: "warning", range: { start: { line: 4, col: 32 } } },
    ]);
  });

  it("suppresses W8001 on loops directly containing await or await using while keeping inner sync loops and async arrow caveats", () => {
    const { entry } = makeProject({
      "native.szigyr": `export function step(x: i32): i32 { "use rt"; return x + 1; }\n`,
      "main.szigyr": [
        `import { step } from "./native.szigyr";`,
        `class Guard implements AsyncDisposable {`,
        `  async disposeAsync(): Promise<void> {}`,
        `}`,
        `export async function workerLoop(port: Port<i32, i32>, clock: Clock): Promise<i32> {`,
        `  let acc: i32 = 0;`,
        `  while (true) {`,
        `    const v = await port.recv();`,
        `    if (v === null) break;`,
        `    acc += step(v);`,
        `    for (let j: i32 = 0; j < 2; j += 1) {`,
        `      acc += step(j);`, // inner sync loop still warns (line 12, col 14)
        `    }`,
        `  }`,
        `  for (let i: i32 = 0; i < 2; i += 1) {`,
        `    await clock.sleep(1);`,
        `    acc += step(i);`,
        `  }`,
        `  for (let i: i32 = 0; i < 2; i += 1) {`,
        `    await using _g = new Guard();`,
        `    acc += step(i);`,
        `  }`,
        `  for (let i: i32 = 0; i < 2; i += 1) {`,
        `    const _fn = async (): Promise<void> => { await clock.sleep(1); };`,
        `    acc += step(i);`, // await inside nested arrow does NOT suppress sync loop warning (line 25, col 12)
        `  }`,
        `  return acc;`,
        `}`,
        ``,
      ].join("\n"),
    });
    const diags = check(entry);
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
    expect(diags.filter((d) => d.code === "W8001")).toMatchObject([
      { code: "W8001", severity: "warning", range: { start: { line: 12, col: 14 } } },
      { code: "W8001", severity: "warning", range: { start: { line: 25, col: 12 } } },
    ]);
  });

  it("erases import type / export type from emitted JS and allows type-only class types while rejecting value uses", () => {
    const { dir, entry } = makeProject({
      "types.szigyr": [
        `export class Box {`,
        `  readonly v: i32;`,
        `  constructor(v: i32) { this.v = v; }`,
        `}`,
        `export function make(v: i32): Box { return new Box(v); }`,
        ``,
      ].join("\n"),
      "barrel.szigyr": [
        `export { make } from "./types.szigyr";`,
        `export type { Box } from "./types.szigyr";`,
        ``,
      ].join("\n"),
      "main.szigyr": [
        `import type { Box } from "./barrel.szigyr";`,
        `import type * as tb from "./types.szigyr";`,
        `import { make } from "./barrel.szigyr";`,
        `export function useBox(b: Box | null, c: tb.Box): i32 {`,
        `  return (b?.v ?? 0) + c.v;`,
        `}`,
        `export function main(sys: System): void {`,
        `  const a = make(10);`,
        `  sys.log.info(\`\${useBox(a, make(5))}\`);`,
        `}`,
        ``,
      ].join("\n"),
    });
    const a = analyze(entry);
    expect(a.diagnostics).toEqual([]);
    const mainPf = a.files.find((f) => f.path.endsWith("main.szigyr"))!;
    const barrelPf = a.files.find((f) => f.path.endsWith("barrel.szigyr"))!;
    const mainEm = emitFile(mainPf, "main.szigyr", false);
    const barrelEm = emitFile(barrelPf, "barrel.szigyr", false);
    // `import type` and `export type` emit zero runtime dependencies on `types.szigyr` in main.szigyr
    expect(mainEm.imports).toEqual([join(dir, "barrel.szigyr")]);
    expect(barrelEm.imports).toEqual([join(dir, "types.szigyr")]);
    expect(barrelEm.js).not.toContain("Box");

    // Reject `new Box()` when `Box` was imported with `import type`
    const bad = makeProject({
      "types.szigyr": `export class Box { readonly v: i32; constructor(v: i32) { this.v = v; } }\n`,
      "main.szigyr": `import type { Box } from "./types.szigyr";\nexport function f(): Box { return new Box(1); }\n`,
    });
    const badDiags = check(bad.entry);
    expect(badDiags).toMatchObject([{ code: "E2002", data: { kind: "type-only", name: "Box" } }]);
  });

  it("supports prove, mutate, and queryFile with type annotations, ns.CONST, ns.fn, and re-exports, and rejects satisfies", async () => {
    const { dir, entry } = makeProject({
      "defs.szigyr": [
        `export const LIMIT: i32 = 100;`,
        `export function clampAdd(a: i32, b: i32): i32 {`,
        `  "use owned";`,
        `  requires(a >= 0 && a <= LIMIT);`,
        `  requires(b >= 0 && b <= LIMIT);`,
        `  ensures((r: i32) => r >= 0 && r <= 200);`,
        `  return a + b;`,
        `}`,
        ``,
      ].join("\n"),
      "reexp.szigyr": [
        `export { LIMIT, clampAdd } from "./defs.szigyr";`,
        ``,
      ].join("\n"),
      "main.szigyr": [
        `import * as r from "./reexp.szigyr";`,
        `export function sumPair(x: i32, y: i32): i32 {`,
        `  "use owned";`,
        `  requires(x >= 0 && x <= r.LIMIT);`,
        `  requires(y >= 0 && y <= r.LIMIT);`,
        `  const v: i32 = r.clampAdd(x, y);`,
        `  return v + i32(1);`,
        `}`,
        `test("sumPair", (t: Test) => {`,
        `  t.eq(sumPair(10, 20), 31);`,
        `  t.eq(sumPair(0, r.LIMIT), 101);`,
        `});`,
        ``,
      ].join("\n"),
    });

    const badSat = makeProject({
      "main.szigyr": `export function f(): i32 { return 1 satisfies i32; }\n`,
    });
    expect(check(badSat.entry)).toMatchObject([{ code: "E1000" }]);

    const pRes = await prove(entry, { cache: false, cacheFile: join(dir, "prove.json") });
    expect(pRes.diagnostics).toEqual([]);
    expect(pRes.summary.failed).toBe(0);
    expect(pRes.summary.unknown).toBe(0);
    expect(pRes.summary.proved).toBeGreaterThan(0);

    const mRes = await mutate(entry, { cache: false, cacheFile: join(dir, "mutate.json") });
    expect(mRes.diagnostics).toEqual([]);
    expect(mRes.baselineFailure).toBeNull();
    expect(mRes.summary.survived).toBe(0);

    const qRes = queryFile(join(dir, "reexp.szigyr"));
    expect(qRes.diagnostics).toEqual([]);
  });
});
