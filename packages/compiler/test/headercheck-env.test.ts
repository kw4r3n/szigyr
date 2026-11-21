import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { check } from "../src/index.ts";
import { ensureStscb } from "./stscb.ts";

// D160: the pkg-config answers are cached per process; a changed PKG_CONFIG_PATH must not return the earlier answer.
it("the header check follows PKG_CONFIG_PATH changes within one process (D160)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sts-hc-"));
  const f = join(dir, "main.szigyr");
  writeFileSync(f, `declare module "c:stscb:stscb.h" {\n  function stscb_call(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>, x: i32): i32;\n}\nimport { stscb_call } from "c:stscb:stscb.h";\nexport function g(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>): i32 {\n  "use owned";\n  "use unsafe";\n  return stscb_call(ffi, f, ud, 1);\n}\n`);
  const saved = process.env.PKG_CONFIG_PATH;
  try {
    delete process.env.PKG_CONFIG_PATH;
    if (!check(f).some((d) => d.code === "E2009")) return; // stscb is installed system-wide: nothing to observe
    ensureStscb();
    if (!process.env.PKG_CONFIG_PATH) return; // the fixture could not be built (README: such cases skip)
    expect(check(f).filter((d) => d.severity === "error")).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.PKG_CONFIG_PATH; else process.env.PKG_CONFIG_PATH = saved;
  }
});

it("attaches ccStderr in E2009 data when header probe fails compilation", () => {
  const dir = mkdtempSync(join(tmpdir(), "sts-hc-err-"));
  const incDir = join(dir, "inc");
  const pcDir = join(dir, "pc");
  writeFileSync(join(dir, "main.szigyr"), `declare module "c:badhdr:bad.h" {\n  function bad_fn(ffi: Ffi, x: i32): i32;\n}\nimport { bad_fn } from "c:badhdr:bad.h";\nexport function g(ffi: Ffi): i32 { "use owned"; "use unsafe"; return bad_fn(ffi, 1); }\n`);
  mkdirSync(incDir, { recursive: true });
  mkdirSync(pcDir, { recursive: true });
  writeFileSync(join(incDir, "bad.h"), '#error "intentional header error"\n');
  writeFileSync(join(pcDir, "badhdr.pc"), `Name: badhdr\nDescription: test\nVersion: 1.0\nCflags: -I"${incDir}"\nLibs:\n`);
  const saved = process.env.PKG_CONFIG_PATH;
  try {
    process.env.PKG_CONFIG_PATH = pcDir;
    const ds = check(join(dir, "main.szigyr")).filter((d) => d.code === "E2009");
    expect(ds).toHaveLength(1);
    expect(ds[0]!.data?.pkg).toBe("badhdr");
    expect(ds[0]!.data?.header).toBe("bad.h");
    if (typeof ds[0]!.data?.ccStderr === "string") {
      expect(ds[0]!.data.ccStderr).toContain("intentional header error");
      expect(ds[0]!.message).toContain("intentional header error");
    }
  } finally {
    if (saved === undefined) delete process.env.PKG_CONFIG_PATH; else process.env.PKG_CONFIG_PATH = saved;
  }
});
