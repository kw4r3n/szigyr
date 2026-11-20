import { expect, it } from "vitest";
import { ccCommand, splitFlags } from "../src/cdecl.ts";

it("splitFlags parses pkg-config output like a POSIX shell word split (D150)", () => {
  expect(splitFlags("-I/usr/include -lfoo")).toEqual(["-I/usr/include", "-lfoo"]);
  expect(splitFlags("  -a \t -b\n")).toEqual(["-a", "-b"]);
  expect(splitFlags("-I'/a b/c' -L\"/d e\"")).toEqual(["-I/a b/c", "-L/d e"]);
  expect(splitFlags("-I\\ x\\\\y -D\"A\\\"B\" -D'C\\D'")).toEqual(["-I x\\y", '-DA"B', "-DC\\D"]);
  expect(splitFlags('"a\\nb"')).toEqual(["a\\nb"]);
  expect(splitFlags("'' x")).toEqual(["", "x"]);
  expect(splitFlags("")).toEqual([]);
  expect(splitFlags(" \n")).toEqual([]);
});

it("ccCommand splits $CC into a command and leading arguments (D150)", () => {
  const old = process.env.CC;
  try {
    process.env.CC = "ccache  cc -m64";
    expect(ccCommand()).toEqual(["ccache", ["cc", "-m64"]]);
    process.env.CC = "";
    expect(ccCommand()).toEqual(["cc", []]);
  } finally { if (old === undefined) delete process.env.CC; else process.env.CC = old; }
});
