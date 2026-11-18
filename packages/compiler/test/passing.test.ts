// Regression guard: every case listed in conformance/PASSING.txt still passes (pnpm conformance:update-passing writes it).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as compiler from "../src/index.ts";
import { loadCases, runCase } from "./harness.ts";

const root = fileURLToPath(new URL("../../../conformance", import.meta.url));

it("cases in conformance/PASSING.txt still pass", async () => {
  const names = readFileSync(`${root}/PASSING.txt`, "utf8").split("\n").filter(Boolean);
  const cases = new Map(loadCases(root).map((c) => [c.name, c]));
  const fails: string[] = [];
  for (const n of names) {
    const c = cases.get(n);
    if (!c) { fails.push(`${n}: no such case`); continue; }
    for (const f of await runCase(c, compiler)) fails.push(`${n}: ${f}`);
  }
  expect(names.length).toBeGreaterThan(0);
  expect(fails).toEqual([]);
}, 60_000);
