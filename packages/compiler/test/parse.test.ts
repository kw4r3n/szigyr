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
