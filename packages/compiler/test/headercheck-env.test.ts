import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { check } from "../src/index.ts";
import { ensureStscb } from "./stscb.ts";

// D160: the pkg-config answers are cached per process; a changed PKG_CONFIG_PATH must not return the earlier answer.
it("the header check follows PKG_CONFIG_PATH changes within one process (D160)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sts-hc-"));
  const f = join(dir, "main.ts");
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
