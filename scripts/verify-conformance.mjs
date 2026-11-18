// Static checks on conformance/: counts, SPEC §11 coverage, syntax, header positions. Run: pnpm verify:conformance
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { loadCases } from "../packages/compiler/test/harness.ts";

const problems = [];
let cases = [];
try { cases = loadCases("conformance"); } catch (e) { problems.push(`header: ${e.message}`); }

const count = (k) => cases.filter((c) => c.kind === k).length;
console.log(`accept=${count("accept")} reject=${count("reject")} run=${count("run")}`);

// (b) every E code in the SPEC §11 table appears in some reject header
const spec = readFileSync("docs/SPEC.md", "utf8");
const sec = spec.slice(spec.indexOf("## 11."), spec.indexOf("## 12."));
const codes = [...sec.matchAll(/^\s*\| (E\d{4}) \|/gm)].map((m) => m[1]);
const used = new Set(cases.filter((c) => c.kind === "reject").map((c) => c.at.code));
const missing = codes.filter((c) => !used.has(c));
if (missing.length) problems.push(`no reject case for: ${missing.join(" ")}`);

// all .ts files under conformance/
const files = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []);
const leafStarts = (sf) => {
  const s = new Set();
  const walk = (n) => { const ch = n.getChildren(sf); if (!ch.length) s.add(n.getStart(sf)); else ch.forEach(walk); };
  walk(sf);
  return s;
};
const parsed = new Map();
for (const f of files("conformance")) {
  const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
  parsed.set(f, sf);
  for (const d of sf.parseDiagnostics) { // parseDiagnostics is internal but present in 6.x
    const p = sf.getLineAndCharacterOfPosition(d.start);
    problems.push(`${f}:${p.line + 1}:${p.character + 1}: syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
}

// (d) expected positions must be the start of a token
for (const c of cases) {
  const w = c.at ?? c.trap;
  const sf = parsed.get(c.entry);
  if (!w || !sf) continue;
  const lines = sf.getLineStarts();
  if (w.line < 1 || w.line > lines.length) { problems.push(`${c.entry}: position ${w.line}:${w.col} is outside the file`); continue; }
  const off = lines[w.line - 1] + w.col - 1;
  if (!leafStarts(sf).has(off)) problems.push(`${c.entry}: ${w.line}:${w.col} is not the start of a token`);
}

if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("ok");
