// Static checks on conformance/: counts, SPEC §11 coverage, syntax, header positions. Run: pnpm verify:conformance
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSources } from "../packages/compiler/src/parse.ts";
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
const paths = files("conformance");
const parsed = parseSources(Object.fromEntries(paths.map((f) => [f, readFileSync(f, "utf8")])));
const get = (f) => parsed.get(resolve(f));
for (const f of paths) {
  const pf = get(f);
  for (const d of pf.syntaxErrors) {
    const p = pf.position(d.start);
    problems.push(`${f}:${p.line}:${p.col}: syntax error: ${d.message}`);
  }
}

// (d) expected positions must be the start of a token
for (const c of cases) {
  const w = c.at ?? c.trap;
  const pf = get(c.entry);
  if (!w || !pf) continue;
  const off = pf.offsetOf(w.line, w.col);
  if (off === undefined) problems.push(`${c.entry}: position ${w.line}:${w.col} is outside the file`);
  else if (!pf.isTokenStart(off)) problems.push(`${c.entry}: ${w.line}:${w.col} is not the start of a token`);
}

if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("ok");
