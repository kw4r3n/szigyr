import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PACKAGE_NAMES } from "../src/names.ts";

it("package.json names match names.ts", () => {
  const got = ["compiler", "runtime-js", "std"].map(
    (p) => JSON.parse(readFileSync(new URL(`../../${p}/package.json`, import.meta.url), "utf8")).name,
  );
  expect(got).toEqual(PACKAGE_NAMES);
});
