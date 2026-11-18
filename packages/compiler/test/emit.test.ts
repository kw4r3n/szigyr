// JS backend (SPEC §10) and the run / test entries, beyond what conformance/run covers.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run, runTestFile } from "../src/index.ts";
import { loadCases } from "./harness.ts";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sts-emit-"));
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  return join(dir, "main.ts");
}

describe("run", () => {
  it("links relative and npm imports, drops test(...), checks compound element writes", async () => {
    const main = project({
      "main.ts": `import { twice } from "./lib.ts";
import { triple } from "npm:fakepkg";
export function main(sys: System): void {
  const r = sys.js.call(triple, [sys.js.encode<f64>(2)]);
  if (r.kind === "ok") {
    const d = sys.js.decode<f64>(r.value);
    if (d.kind === "ok") {
      sys.log.info(\`\${twice(d.value)}\`);
    }
  }
  const xs: Array<i32> = [1, 2];
  xs[1] += 5;
  sys.log.info(\`\${xs[1]}\`);
  xs[2] += 1;
}
test("not registered by run", (t: Test) => {
  t.ok(false);
});
`,
      "lib.ts": "export function twice(x: f64): f64 {\n  return x * 2;\n}\n",
      "node_modules/fakepkg/package.json": JSON.stringify({ name: "fakepkg", type: "module", main: "index.js" }),
      "node_modules/fakepkg/index.js": "export const triple = (x) => x * 3;\n",
    });
    const r = await run(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("12\n7\n");
    expect(r.trap).toMatchObject({ code: "T002", line: 14, col: 6 });
  });

  it("keeps user names visible in compound right sides and ensures predicates; exports only values", async () => {
    const main = project({
      "main.ts": `import { bump, Box } from "./lib.ts";
export function main(sys: System): void {
  const xs: Array<i32> = [1, 2];
  const o: i32 = 10;
  const k: i32 = 20;
  const v: i32 = 30;
  xs[0] += o + k + v;
  const b: Box = { total: 1 };
  bump(b, 5);
  sys.log.info(\`\${xs[0]} \${b.total} \${atLeast(3, 2)}\`);
  sys.log.info(\`\${atLeast(3, 5)}\`);
}
function atLeast(x: i32, r: i32): i32 {
  ensures((out: i32) => out >= r);
  return x;
}
`,
      "lib.ts": `type Box = { total: i32 };
export { Box };
export function bump(o: Box, v: i32): void {
  o.total += v;
}
`,
    });
    const r = await run(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("61 6 3\n");
    expect(r.trap).toMatchObject({ code: "T005", line: 14, col: 3 });
  });
});

describe("runTestFile", () => {
  it("reports passing, failing and trapping tests", async () => {
    const main = project({
      "main.ts": `function f(x: i32): i32 {
  return x + 1;
}
test("passes", (t: Test) => {
  t.eq(f(1), 2);
  t.traps("T001", () => {
    f(2147483647);
  });
});
test("fails", (t: Test) => {
  t.eq(f(1), 3);
});
test("traps", (t: Test) => {
  const m: i32 = 2147483647;
  t.eq(f(m), 0);
});
`,
    });
    const r = await runTestFile(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.results.map((x) => [x.name, x.ok])).toEqual([["passes", true], ["fails", false], ["traps", false]]);
    expect(r.results[1]!.pos).toMatchObject({ line: 11, col: 5 });
    expect(r.results[2]!.trap).toMatchObject({ code: "T001", pos: { line: 2, col: 12 } });
  });

  // Goal: every stage-1 accept case with test(...) passes its own tests.
  const root = fileURLToPath(new URL("../../../conformance", import.meta.url));
  const cases = loadCases(root).filter((c) => c.kind === "accept" && c.stage <= 1 && /\btest\(/.test(readFileSync(c.entry, "utf8")));
  it.each(cases.map((c) => [c.name, c.entry]))("%s", async (_name, entry) => {
    const r = await runTestFile(entry);
    expect(r.diagnostics).toEqual([]);
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
  });
});
