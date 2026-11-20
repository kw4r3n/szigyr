// Rewrites conformance/PASSING.txt with the cases that pass now, among those whose name starts with one of
// the given prefixes (the checks implemented so far). Run: pnpm conformance:update-passing
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as compiler from "../packages/compiler/src/index.ts";
import { loadCases, passingRemovals, runCase } from "../packages/compiler/test/harness.ts";

const allowRemove = process.argv.includes("--allow-remove");
const prefixes = process.argv.slice(2).filter((a) => a !== "--allow-remove");
if (!prefixes.length) { console.error("usage: update-passing.mjs [--allow-remove] <case-name-prefix>..."); process.exit(2); }
const pass = [], fail = [];
for (const c of loadCases("conformance")) {
  if (prefixes.some((p) => c.name.startsWith(p))) ((await runCase(c, compiler)).length ? fail : pass).push(c.name);
}
const old = existsSync("conformance/PASSING.txt") ? readFileSync("conformance/PASSING.txt", "utf8").split("\n").filter(Boolean) : [];
const removed = passingRemovals(old, pass);
if (removed.length && !allowRemove) { console.error(`PASSING.txt not written: ${removed.length} listed case(s) would be dropped (failing or no longer selected): ${removed.join(" ")}\nfix them, or pass --allow-remove`); process.exit(1); }
writeFileSync("conformance/PASSING.txt", pass.sort().map((n) => `${n}\n`).join(""));
console.log(`PASSING.txt: ${pass.length} cases; ${fail.length} selected but failing${fail.length ? `: ${fail.join(" ")}` : ""}`);
