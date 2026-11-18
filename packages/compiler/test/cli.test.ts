import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CLI_NAME } from "../src/names.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const CONF = new URL("../../../conformance/", import.meta.url).pathname;
const sts = (...a: string[]) => { const r = spawnSync("node", [CLI, ...a], { encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const jsonLines = (s: string): any[] => s.trim().split("\n").map((l) => JSON.parse(l));

it("check --json prints one JSON diagnostic per line and exits 1", () => {
  const r = sts("check", "--json", `${CONF}reject/E2003-default-f64-let-vs-usize.ts`);
  expect(r.code).toBe(1);
  const [d] = jsonLines(r.out);
  expect(d).toMatchObject({ code: "E2003", range: { start: { line: 6, col: 12 } } });
});

it("check exits 0 with no output on an accepted file", () => {
  expect(sts("check", `${CONF}accept/02-record-readonly.ts`)).toEqual({ code: 0, out: "", err: "" });
});

it("run passes the program's stdout through", () => {
  const r = sts("run", `${CONF}run/01-arith-basic.ts`);
  expect(r.code).toBe(0);
  expect(r.out).toContain("22");
});

it("run exits 3 on a trap and reports it as JSON on stderr (Q060)", () => {
  const r = sts("run", "--json", `${CONF}run/26-trap-div-by-zero.ts`);
  expect(r.code).toBe(3);
  expect(jsonLines(r.err)[0]).toMatchObject({ kind: "trap", code: "T007" });
});

it("run exits 1 with diagnostics on stderr and empty stdout when the file does not check", () => {
  const r = sts("run", "--json", `${CONF}reject/E1001-var-in-function.ts`);
  expect(r).toMatchObject({ code: 1, out: "" });
  expect(jsonLines(r.err)[0].code).toBe("E1001");
});

it("test reports each test and a summary; failures exit 1", () => {
  const ok = sts("test", "--json", `${CONF}accept/02-record-readonly.ts`);
  expect(ok.code).toBe(0);
  expect(jsonLines(ok.out)).toEqual([
    expect.objectContaining({ kind: "test", name: "records", ok: true }),
    { kind: "summary", passed: 1, failed: 0 },
  ]);
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "t.ts"), 'test("bad", (t: Test) => {\n  t.ok(false);\n});\n');
  const bad = sts("test", "--json", join(dir, "t.ts"));
  expect(bad.code).toBe(1);
  expect(jsonLines(bad.out)[0]).toMatchObject({ kind: "test", name: "bad", ok: false });
});

it("usage errors and missing files exit 2 with a message", () => {
  for (const a of [[], ["nope"], ["check"], ["check", "/no/such.ts"], ["run", "--bogus", "x"]]) {
    const r = sts(...a);
    expect(r.code).toBe(2);
    expect(r.err).toContain(CLI_NAME);
  }
});

it("run without an exported main is a CLI error, exit 2 (Q061)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "m.ts"), "export function f(): void {}\n");
  expect(sts("run", join(dir, "m.ts")).code).toBe(2);
});
