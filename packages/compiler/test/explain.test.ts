import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { explainCode } from "../src/explain.ts";
import { check, createParser } from "../src/index.ts";

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
  expect(explainCode("E3003")!.remediation).toContain("Destructure");
  expect(explainCode("E3003")!.remediation).not.toContain("without reusing the parent");
  expect(explainCode("E1000")!.kinds?.enum).toContain("string-literal union");
  expect(explainCode("E1000")!.kinds?.["public-modifier"]).toContain("Remove 'public'");
  expect(explainCode("E2002")!.kinds?.["spread-non-rest"]).toContain("...rest");

  for (const code of ["E1000", "E2002"]) {
    for (const [kind, text] of Object.entries(explainCode(code)!.kinds ?? {})) {
      expect(text, `${code}.kinds.${kind}`).not.toMatch(/\b(Eq|Hash|Ord)\b/);
      expect(text, `${code}.kinds.${kind}`).not.toMatch(/Q\d{2,3}/);
      expect(text, `${code}.kinds.${kind}`).not.toContain("§");
      expect(text, `${code}.kinds.${kind}`).not.toContain("SPEC-v1");
      expect(text, `${code}.kinds.${kind}`).not.toContain("use strict");
    }
  }
});

it("explains every E1000 and E2002 data.kind emitted across conformance/reject/", () => {
  const rejectDir = fileURLToPath(new URL("../../../conformance/reject", import.meta.url));
  const parser = createParser();
  const seen = new Map<string, Set<string>>([["E1000", new Set()], ["E2002", new Set()]]);
  try {
    for (const name of readdirSync(rejectDir).sort()) {
      const p = join(rejectDir, name);
      const entry = statSync(p).isDirectory() ? join(p, "main.szigyr") : p;
      if (!entry.endsWith(".szigyr")) continue;
      parser.evict?.();
      for (const d of check(entry, parser)) {
        if ((d.code === "E1000" || d.code === "E2002") && typeof d.data?.kind === "string") {
          seen.get(d.code)!.add(d.data.kind);
          const msg = explainCode(d.code)?.kinds?.[d.data.kind];
          expect(typeof msg === "string" && msg.trim().length > 0, `missing explain ${d.code}.kinds.${d.data.kind} (from ${name})`).toBe(true);
        }
      }
    }
  } finally {
    parser.close();
  }
  expect(seen.get("E1000")!.size).toBeGreaterThan(20);
  expect(seen.get("E2002")!.size).toBeGreaterThan(5);
});
