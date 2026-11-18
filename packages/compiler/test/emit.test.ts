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

describe("run: await and JS exceptions", () => {
  it("compound assignment to an element or property with await on the right, left to right", async () => {
    const main = project({
      "main.ts": `class Acc {
  n: i32;
  constructor(n: i32) {
    this.n = n;
  }
}
async function g(log: Log, x: i32): Promise<i32> {
  log.info(\`g\${x}\`);
  return x;
}
function idx(log: Log): usize {
  log.info("idx");
  return 0;
}
export async function main(sys: System): Promise<void> {
  const xs: Array<i32> = [1, 2];
  xs[idx(sys.log)] += await g(sys.log, 5);
  const a = new Acc(10);
  a.n += await g(sys.log, 7);
  const fs: Array<f32> = [0.5];
  fs[0] *= f32(await g(sys.log, 3));
  sys.log.info(\`\${xs[0]} \${a.n} \${fs[0]}\`);
  xs[1] += await g(sys.log, 2147483647);
}
`,
    });
    const r = await run(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("idx\ng5\ng7\ng3\n6 17 1.5\ng2147483647\n");
    expect(r.trap).toMatchObject({ code: "T001", line: 23, col: 9 });
  });
});

describe("Q035: JS exceptions and stack exhaustion are T006 at the callee name", () => {
  it("in tests", async () => {
    const main = project({
      "main.ts": `function deep(n: f64): f64 {
  return deep(n + 1) + 1;
}
test("parse", (t: Test) => {
  const v: unknown = JSON.parse("{");
});
test("fromCodePoint", (t: Test) => {
  const s: string = String.fromCodePoint(1114112);
});
test("padStart", (t: Test) => {
  const s: string = "x".padStart(4294967295, "y");
});
test("deep", (t: Test) => {
  t.eq(deep(0), 0);
});
test("traps sees T006", (t: Test) => {
  t.traps("T006", () => {
    deep(0);
  });
  t.eq(JSON.parse("1"), JSON.parse("1"));
});
`,
    });
    const r = await runTestFile(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.results.map((x) => [x.name, x.ok, x.trap?.code, x.trap?.pos?.line, x.trap?.pos?.col])).toEqual([
      ["parse", false, "T006", 5, 27],
      ["fromCodePoint", false, "T006", 8, 28],
      ["padStart", false, "T006", 11, 25],
      ["deep", false, "T006", 2, 10],
      ["traps sees T006", true, undefined, undefined, undefined],
    ]);
  });

  it("in run: stack exhaustion through a method", async () => {
    const main = project({
      "main.ts": `class R {
  down(n: f64): f64 {
    return this.down(n + 1);
  }
}
export function main(sys: System): void {
  sys.log.info("before");
  const r = new R();
  sys.log.info(\`\${r.down(0)}\`);
}
`,
    });
    const r = await run(main);
    expect(r.stdout).toBe("before\n");
    expect(r.trap).toMatchObject({ code: "T006", line: 3, col: 17 });
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
