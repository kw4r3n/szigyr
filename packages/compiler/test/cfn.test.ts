// §14.6's end flag, observed from the fixture's side of the boundary (stage 3-6).
// A run case cannot see what a boundary call returned once a trap is delivered at its
// exit, so the flag's two effects — a trapping callback answers zero, and a callback
// after the flag is not run at all — are checked here with two programs in one process:
// they share the fixture library, so the second program reads what the first one did.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import * as rt from "../../runtime-js/src/index.ts";
import { run } from "../src/index.ts";
import { ensureSzcb } from "./szcb.ts";

ensureSzcb();

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "szigyr-cfn-"));
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  return join(dir, "main.szigyr");
}

const HEAD = `declare module "c:szcb:szcb.h" {
  function szcb_call(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>, x: i32): i32;
  function szcb_cell(ffi: Ffi): Ptr<i32>;
  function szcb_reset_stats(ffi: Ffi): void;
  function szcb_stat_n(ffi: Ffi): i32;
  function szcb_stat(ffi: Ffi, i: i32): i32;
}
import { szcb_call, szcb_cell, szcb_reset_stats, szcb_stat_n, szcb_stat } from "c:szcb:szcb.h";
`;

const withDecl = (decl: string, name: string): string => HEAD.replace("}\nimport {", `  ${decl}\n}\nimport { ${name} } from "c:szcb:szcb.h";\nimport {`);

/** A program whose main arms the fixture: after `delay` ms, a fixture thread calls bump twice on the cell; then `rest` runs. */
const armed = (delay: number, rest: string, extra = ""): string => project({ "main.szigyr": withDecl("function szcb_start(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>, x: i32, delay: i32, after: Ptr<(ud: Ptr<void>, x: i32) => i32>, aud: Ptr<void>): void;", "szcb_start") + `
function bump(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  const p = ud.cast<i32>();
  p.write(p.read() + 1);
  return x + 1;
}
function arm(ffi: Ffi): void {
  "use owned";
  "use unsafe";
  szcb_reset_stats(ffi);
  const cell = szcb_cell(ffi);
  cell.write(0);
  szcb_start(ffi, cfn(bump), cell.cast<void>(), 1, ${delay}, cfn(bump), cell.cast<void>());
}
${extra}export function main(sys: System): void {
  arm(sys.ffi);
${rest}
}
` });

/** Joins the armed fixture thread and returns "runs n v0 v1": bump's runs, then what the fixture got back. */
async function readCell(): Promise<string> {
  const r = await run(project({ "main.szigyr": withDecl("function szcb_join(ffi: Ffi): void;", "szcb_join") + `
type S = Struct<{ runs: i32; n: i32; v0: i32; v1: i32 }>;
function read(ffi: Ffi): S {
  "use owned";
  "use unsafe";
  szcb_join(ffi);
  const cell = szcb_cell(ffi);
  return { runs: cell.read(), n: szcb_stat_n(ffi), v0: szcb_stat(ffi, 0), v1: szcb_stat(ffi, 1) };
}
export function main(sys: System): void {
  const s = read(sys.ffi);
  sys.log.info(\`\${s.runs} \${s.n} \${s.v0} \${s.v1}\`);
}
` }), { backend: "c" });
  expect(r.diagnostics).toEqual([]);
  expect(r.trap).toBeNull();
  return r.stdout;
}

describe("cfn and the end flag", () => {
  it("a trapping callback answers zero, and after the flag the callback is not run", async () => {
    const a = project({ "main.szigyr": HEAD + `
function bump(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  const p = ud.cast<i32>();
  p.write(p.read() + 1);
  return x + 1;
}
function run3(ffi: Ffi): void {
  "use owned";
  "use unsafe";
  szcb_reset_stats(ffi);
  const cell = szcb_cell(ffi);
  cell.write(0);
  const a = szcb_call(ffi, cfn(bump), cell.cast<void>(), 1);
  const b = szcb_call(ffi, cfn(bump), cell.cast<void>(), 2147483647);
  const c = szcb_call(ffi, cfn(bump), cell.cast<void>(), 5);
}
export function main(sys: System): void {
  run3(sys.ffi);
}
` });
    const ra = await run(a, { backend: "c" });
    expect(ra.diagnostics).toEqual([]);
    expect(ra.stdout).toBe("");
    expect(ra.trap?.code).toBe("T001"); // bump's second call overflowed; delivered as run3 returned (§15.4 (1))

    const b = project({ "main.szigyr": HEAD + `
type S = Struct<{ runs: i32; n: i32; v0: i32; v1: i32; v2: i32 }>;
function read(ffi: Ffi): S {
  "use owned";
  "use unsafe";
  const cell = szcb_cell(ffi);
  return { runs: cell.read(), n: szcb_stat_n(ffi), v0: szcb_stat(ffi, 0), v1: szcb_stat(ffi, 1), v2: szcb_stat(ffi, 2) };
}
export function main(sys: System): void {
  const s = read(sys.ffi);
  sys.log.info(\`\${s.runs} \${s.n} \${s.v0} \${s.v1} \${s.v2}\`);
}
` });
    const rb = await run(b, { backend: "c" });
    expect(rb.diagnostics).toEqual([]);
    expect(rb.trap).toBeNull();
    // bump ran twice (the cell), the fixture invoked the trampoline three times, and the
    // values it got back were 2 (bump ran), 0 (bump trapped), 0 (the flag: bump not run).
    expect(rb.stdout).toBe("2 3 2 0 0\n");
  }, 120000);

  it("main trapping in managed code raises the flag: a callback still pending is not run (§14.6)", async () => {
    const ra = await run(armed(1000, `  panic("main");`), { backend: "c" });
    expect(ra.diagnostics).toEqual([]);
    expect(ra.trap?.code).toBe("T006");
    expect(await readCell()).toBe("0 2 0 0\n"); // both calls came after main's trap: the flag answered zero without running bump
  }, 120000);

  it("a C thread trapping after main's own trap does not displace it (§15.4, D144)", async () => {
    // An npm package blocks the main thread for 1.5 s in the first macrotask after main, so the
    // fixture thread's trap 200 ms after main's panic lands before runNow finishes. Main's trap came first.
    const a = project({ "main.szigyr": `import { block } from "npm:blockpkg";\n` + withDecl("function szcb_start(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>, x: i32, delay: i32, after: Ptr<(ud: Ptr<void>, x: i32) => i32>, aud: Ptr<void>): void;", "szcb_start") + `
function boom(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  return x + 1;
}
function arm(ffi: Ffi): void {
  "use owned";
  "use unsafe";
  const cell = szcb_cell(ffi);
  szcb_start(ffi, cfn(boom), cell.cast<void>(), 2147483647, 200, cfn(boom), cell.cast<void>());
}
export function main(sys: System): void {
  const b = sys.js.call(block, []);
  arm(sys.ffi);
  panic("main");
}
`, "node_modules/blockpkg/package.json": JSON.stringify({ name: "blockpkg", type: "module", main: "index.js" }),
      "node_modules/blockpkg/index.js": "export const block = () => { setImmediate(() => { const t = Date.now(); while (Date.now() - t < 1500); }); };\n" });
    const ra = await run(a, { backend: "c" });
    expect(ra.diagnostics).toEqual([]);
    expect(ra.trap).toMatchObject({ code: "T006", line: 27, col: 3 }); // panic("main"), not boom's T001
  }, 120000);

  it("an isolate starting after the flag is up does not lower it (D146)", async () => {
    const a = armed(4000, `  const p = sys.spawn.isolate(idle);`, `function idle(port: Port<i32, i32>): void {\n}\n`);
    const ra = await run(a, { backend: "c" });
    expect(ra.diagnostics).toEqual([]);
    expect(ra.trap).toBeNull();
    // main ended, so the flag is up. The loader keeps the program installed: start one more
    // isolate on the same addon, as a spawn would, and wait until it ran (its init came first).
    expect(await rt.spawnIsolate(realpathSync(a), "idle").recv()).toBeNull();
    expect(await readCell()).toBe("0 2 0 0\n");
  }, 120000);

  it("an isolate trap left from an earlier run does not surface in the next one", async () => {
    rt.noteIsolateTrap({ code: "T006" });
    const r = await run(project({ "main.szigyr": `export function main(sys: System): void {\n  sys.log.info("ok");\n}\n` }));
    expect(r.trap).toBeNull();
    expect(r.stdout).toBe("ok\n");
  }, 120000);

  it("Resource.ownWith in C native backend: get, take, LIFO cleanup, and trap unwinding", async () => {
    const entry = project({
      "main.szigyr": HEAD + `
function cleanPtr(cell: Ptr<i32>, p: Ptr<i32>): void {
  "use owned";
  "use unsafe";
  const v = p.unbox();
  cell.write(cell.read() * 10 + v);
}
function runNormal(a: Alloc, ffi: Ffi): i32 {
  "use owned";
  "use unsafe";
  const cell = szcb_cell(ffi);
  cell.write(0);
  using r1 = Resource.ownWith<Ptr<i32>, Ptr<i32>>(Ptr.box<i32>(a, 1), cell, cleanPtr);
  using r2 = Resource.ownWith<Ptr<i32>, Ptr<i32>>(Ptr.box<i32>(a, 2), cell, cleanPtr);
  using r3 = Resource.ownWith<Ptr<i32>, Ptr<i32>>(Ptr.box<i32>(a, 9), cell, cleanPtr);
  const g = r1.get().read();
  const p3 = r3.take();
  return g + p3.unbox();
}
function runTrap(a: Alloc, ffi: Ffi): void {
  "use owned";
  "use unsafe";
  const cell = szcb_cell(ffi);
  cell.write(0);
  using r1 = Resource.ownWith<Ptr<i32>, Ptr<i32>>(Ptr.box<i32>(a, 3), cell, cleanPtr);
  using r2 = Resource.ownWith<Ptr<i32>, Ptr<i32>>(Ptr.box<i32>(a, 4), cell, cleanPtr);
  if (r1.get().read() === 3 && r2.get().read() === 4) {
    panic("boom");
  }
}
function readCell(ffi: Ffi): i32 {
  "use owned";
  "use unsafe";
  return szcb_cell(ffi).read();
}
export function main(sys: System): void {
  const s = runNormal(sys.alloc, sys.ffi);
  sys.log.info(\`\${s}:\${readCell(sys.ffi)}\`);
  runTrap(sys.alloc, sys.ffi);
}
`,
    });
    const r = await run(entry, { backend: "c" });
    expect(r.diagnostics).toEqual([]);
    expect(r.trap).toMatchObject({ code: "T006" });
    expect(r.stdout).toBe("10:21\n");
    const cellEntry = project({
      "main.szigyr": HEAD + `function readCell(ffi: Ffi): i32 {\n  "use owned";\n  "use unsafe";\n  return szcb_cell(ffi).read();\n}\nexport function main(sys: System): void {\n  sys.log.info(\`\${readCell(sys.ffi)}\`);\n}\n`,
    });
    const r2 = await run(cellEntry, { backend: "c" });
    expect(r2.trap).toBeNull();
    expect(r2.stdout).toBe("43\n");
  }, 120000);
});
