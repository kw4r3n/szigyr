import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CLI_NAME, PACKAGE_NAMES } from "../src/names.ts";

it("package.json names match names.ts", () => {
  const got = ["compiler", "runtime-js", "std"].map(
    (p) => JSON.parse(readFileSync(new URL(`../../${p}/package.json`, import.meta.url), "utf8")).name,
  );
  expect(got).toEqual(PACKAGE_NAMES);
});

it("the compiler package's bin is named CLI_NAME", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(Object.keys(pkg.bin)).toEqual([CLI_NAME]);
});
