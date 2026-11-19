// Regression guard: every case listed in conformance/PASSING.txt still passes (pnpm conformance:update-passing writes it).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as compiler from "../src/index.ts";
import { execFileSync } from "node:child_process";
import { atCSpecifier, loadCases, missingCPackages, runCase } from "./harness.ts";

const pkgExists = (pkg: string): boolean => {
  try { execFileSync("pkg-config", ["--exists", pkg], { stdio: "ignore" }); return true; } catch { return false; }
};

const root = fileURLToPath(new URL("../../../conformance", import.meta.url));

it("cases in conformance/PASSING.txt still pass", async () => {
  const names = readFileSync(`${root}/PASSING.txt`, "utf8").split("\n").filter(Boolean);
  const cases = new Map(loadCases(root).map((c) => [c.name, c]));
  const fails: string[] = [];
  for (const n of names) {
    const c = cases.get(n);
    if (!c) { fails.push(`${n}: no such case`); continue; }
    if (missingCPackages(c, pkgExists).length && !(c.at?.code === "E2009" && atCSpecifier(c))) continue; // §14.2: needs a C library this environment lacks
    for (const f of await runCase(c, compiler)) fails.push(`${n}: ${f}`);
  }
  expect(names.length).toBeGreaterThan(0);
  expect(fails).toEqual([]);
}, 60_000);
