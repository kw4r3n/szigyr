import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// Q266: stubbed backends, since no program can make the two backends register a different number of tests.
vi.mock("../src/index.ts", async (orig) => ({
  ...(await orig<typeof import("../src/index.ts")>()),
  runTestFile: async (_f: string, o: { backend: string }) => ({ diagnostics: [], results: o.backend === "js" ? [{ name: "a", ok: true }] : [{ name: "a", ok: true }, { name: "b", ok: true }] }),
}));
const { main } = await import("../src/cli.ts");

it("test --backend=both runs each test cleanly when stubbed mismatch fires in json and text modes (Q266)", async () => {
  let out = "";
  const f = join(mkdtempSync(join(tmpdir(), "szigyr-both-")), "t.szigyr");
  writeFileSync(f, 'test("a", (t: Test) => {\n  t.ok(true);\n});\n'); // the real analysis runs on this tiny Szigyr file; the stub supplies the results
  const code = await main(["test", "--json", "--backend=both", f], (s) => (out += s), () => {});
  expect(code).toBe(1);
  expect(out).toContain('"kind":"mismatch"');

  let textOut = "";
  const textCode = await main(["test", "--backend=both", f], (s) => (textOut += s), () => {});
  expect(textCode).toBe(1);
  expect(textOut).toContain("MISMATCH");
  expect(textOut).not.toContain('"kind":"mismatch"');
});
