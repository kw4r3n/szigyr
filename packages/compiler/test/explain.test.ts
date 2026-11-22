import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { explainCode } from "../src/explain.ts";

it("covers every diagnostic and trap code listed in docs/SPEC.md §13", () => {
  const spec = readFileSync(new URL("../../../docs/SPEC.md", import.meta.url), "utf8");
  const sec13 = spec.slice(spec.indexOf("## 13."));
  const errLine = sec13.split("\n").find((l) => l.startsWith("- **Errors**:")) ?? "";
  const trapLine = sec13.split("\n").find((l) => l.startsWith("- **Traps**:")) ?? "";
  const errCodes = [...new Set([...errLine.matchAll(/\b([EW]\d{4})\b/g)].map((m) => m[1]!))];
  const trapCodes = [...new Set([...trapLine.matchAll(/\b(T\d{3})\b/g)].map((m) => m[1]!))];

  expect(errCodes.length).toBeGreaterThan(40);
  expect(trapCodes.length).toBe(15);

  for (const code of [...errCodes, ...trapCodes]) {
    const entry = explainCode(code);
    expect(entry, `missing explainCode(${code})`).toBeDefined();
    expect(entry!.code).toBe(code);
  }
});

it("keeps explain entries free of hallucinated capabilities, stale filenames, and invalid directives", () => {
  const spec = readFileSync(new URL("../../../docs/SPEC.md", import.meta.url), "utf8");
  const sec13 = spec.slice(spec.indexOf("## 13."));
  const allCodes = [...new Set([...sec13.matchAll(/\b([EW]\d{4}|T\d{3})\b/g)].map((m) => m[1]!))];

  for (const code of allCodes) {
    const entry = explainCode(code)!;
    const text = `${entry.title}\n${entry.description}\n${entry.remediation}`;
    expect(text, code).not.toMatch(/\b(Eq|Hash|Ord)\b/);
    expect(text, code).not.toContain("SPEC-v1");
  }

  for (const code of ["E1009", "E2011", "E4001"]) {
    const entry = explainCode(code)!;
    const text = `${entry.description}\n${entry.remediation}`;
    expect(text, code).not.toContain("use strict");
  }

  expect(explainCode("E2011")!.description).toContain("managed");
  expect(explainCode("E3007")!.description).not.toContain("Result");
  expect(explainCode("E3007")!.remediation).toContain("Result");
  expect(explainCode("E4004")!.description).not.toContain("using");
  expect(explainCode("W8001")).toMatchObject({ phase: "P3" });
  expect(explainCode("W8001")!.description).toContain("managed loop");
  expect(explainCode("T007")!.description).not.toMatch(/overflowed signed MIN/i);
  expect(explainCode("T009")!.description).toContain("i64/u64");
  expect(explainCode("T009")!.remediation).toContain("64-bit");
  expect(explainCode("T011")!.description).toContain("Pool");
  expect(explainCode("T012")!.description).toContain("Arena.view");
});
