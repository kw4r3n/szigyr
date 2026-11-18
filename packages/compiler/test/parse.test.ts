import { expect, it } from "vitest";
import { parseSources, SyntaxKind } from "../src/parse.ts";

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
