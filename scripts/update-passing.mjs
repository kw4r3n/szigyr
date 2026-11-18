// Rewrites conformance/PASSING.txt with the cases that pass now, among those whose name starts with one of
// the given prefixes (the checks implemented so far). Run: pnpm conformance:update-passing
import { writeFileSync } from "node:fs";
import * as compiler from "../packages/compiler/src/index.ts";
import { loadCases, runCase } from "../packages/compiler/test/harness.ts";

const prefixes = process.argv.slice(2);
if (!prefixes.length) { console.error("usage: update-passing.mjs <case-name-prefix>..."); process.exit(2); }
const pass = [], fail = [];
for (const c of loadCases("conformance")) {
  if (prefixes.some((p) => c.name.startsWith(p))) ((await runCase(c, compiler)).length ? fail : pass).push(c.name);
}
writeFileSync("conformance/PASSING.txt", pass.sort().map((n) => `${n}\n`).join(""));
console.log(`PASSING.txt: ${pass.length} cases; ${fail.length} selected but failing${fail.length ? `: ${fail.join(" ")}` : ""}`);
