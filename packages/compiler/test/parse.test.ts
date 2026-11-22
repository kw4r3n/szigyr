import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createParser, parseSources, SyntaxKind } from "../src/parse.ts";

it("parses in-memory sources: AST, positions, syntax errors, token starts", () => {
  const r = parseSources({ "/m/ok.ts": "let a = 1;\nconst b = `x${a}y`;\n", "/m/bad.ts": "let x = ;\n" });
  const ok = r.get("/m/ok.ts")!;
  expect(ok.syntaxErrors).toEqual([]);
  expect(ok.sourceFile.statements.map((s) => s.kind)).toEqual([SyntaxKind.FirstStatement, SyntaxKind.FirstStatement]);
  expect(ok.position(ok.offsetOf(2, 7)!)).toEqual({ line: 2, col: 7 });
  expect(ok.isTokenStart(ok.offsetOf(1, 5)!)).toBe(true); // `a`
  expect(ok.isTokenStart(ok.offsetOf(1, 6)!)).toBe(false); // space
  expect(ok.offsetOf(99, 1)).toBeUndefined();
  const bad = r.get("/m/bad.ts")!;
  expect(bad.syntaxErrors[0]).toMatchObject({ start: 8, code: 1109 });
});

it("parser session parses more files in later rounds; missing files are absent; tokenAfter skips trivia", () => {
  const p = createParser({ "/m/a.ts": "const x = y /* c */ as T;\n", "/m/b.ts": "export const b = 1;\n" });
  try {
    const a = p.parse(["/m/a.ts"]).get("/m/a.ts")!;
    expect(a.position(a.tokenAfter(11))).toEqual({ line: 1, col: 21 }); // `as` after `y` and a comment
    expect([...p.parse(["/m/b.ts", "/m/missing.ts"]).keys()]).toEqual(["/m/b.ts"]);
  } finally {
    p.close();
  }
});

it("maps .szigyr files to virtual .ts for tsgo while preserving .szigyr paths", () => {
  const mem = parseSources({ "/m/entry.szigyr": 'export function f(): i32 { return 1; }\n' });
  const pf = mem.get("/m/entry.szigyr")!;
  expect(pf.path).toBe("/m/entry.szigyr");
  expect(pf.syntaxErrors).toEqual([]);

  const dir = mkdtempSync(join(tmpdir(), "szigyr-parse-"));
  const dep = join(dir, "dep.szigyr");
  const main = join(dir, "main.szigyr");
  writeFileSync(dep, "export const K: i32 = 7;\n");
  writeFileSync(main, 'import { K } from "./dep.szigyr";\nexport function g(): i32 { return K; }\n');
  const p = createParser();
  try {
    const r1 = p.parse([main]);
    expect(r1.get(main)?.syntaxErrors).toEqual([]);
    const r2 = p.parse([dep, join(dir, "missing.szigyr")]);
    expect([...r2.keys()]).toEqual([dep]);
    expect(r2.get(dep)?.syntaxErrors).toEqual([]);
  } finally {
    p.close();
  }
});

it("evict() closes tracked files cleanly on next parse() without stale entries", () => {
  const p = createParser({ "/m/one.szigyr": "export const A: i32 = 1;\n", "/m/two.szigyr": "export const B: i32 = 2;\n" });
  try {
    expect(p.parse(["/m/one.szigyr"]).get("/m/one.szigyr")?.syntaxErrors).toEqual([]);
    p.evict?.();
    const r2 = p.parse(["/m/two.szigyr"]);
    expect([...r2.keys()]).toEqual(["/m/two.szigyr"]);
    expect(r2.get("/m/two.szigyr")?.syntaxErrors).toEqual([]);
    p.evict?.();
    // Re-parsing a previously evicted file produces a fresh AST cleanly.
    const r3 = p.parse(["/m/one.szigyr"]);
    expect(r3.get("/m/one.szigyr")?.syntaxErrors).toEqual([]);
  } finally {
    p.close();
  }
});
