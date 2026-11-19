// §14.6's end flag, observed from the fixture's side of the boundary (stage 3-6).
// A run case cannot see what a boundary call returned once a trap is delivered at its
// exit, so the flag's two effects — a trapping callback answers zero, and a callback
// after the flag is not run at all — are checked here with two programs in one process:
// they share the fixture library, so the second program reads what the first one did.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ensureStscb } from "./stscb.ts";

ensureStscb();

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sts-cfn-"));
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  return join(dir, "main.ts");
}

const HEAD = `declare module "c:stscb:stscb.h" {
  function stscb_call(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>, x: i32): i32;
  function stscb_cell(ffi: Ffi): Ptr<i32>;
  function stscb_reset_stats(ffi: Ffi): void;
  function stscb_stat_n(ffi: Ffi): i32;
  function stscb_stat(ffi: Ffi, i: i32): i32;
}
import { stscb_call, stscb_cell, stscb_reset_stats, stscb_stat_n, stscb_stat } from "c:stscb:stscb.h";
`;

describe("cfn and the end flag", () => {
  it("a trapping callback answers zero, and after the flag the callback is not run", async () => {
    const a = project({ "main.ts": HEAD + `
function bump(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  const p = ud.cast<i32>();
  p.write(p.read() + 1);
  return x + 1;
}
function run3(ffi: Ffi): void {
  "use owned";
  "use unsafe";
  stscb_reset_stats(ffi);
  const cell = stscb_cell(ffi);
  cell.write(0);
  const a = stscb_call(ffi, cfn(bump), cell.cast<void>(), 1);
  const b = stscb_call(ffi, cfn(bump), cell.cast<void>(), 2147483647);
  const c = stscb_call(ffi, cfn(bump), cell.cast<void>(), 5);
}
export function main(sys: System): void {
  run3(sys.ffi);
}
` });
    const ra = await run(a, { backend: "c" });
    expect(ra.diagnostics).toEqual([]);
    expect(ra.stdout).toBe("");
    expect(ra.trap?.code).toBe("T001"); // bump's second call overflowed; delivered as run3 returned (§15.4 (1))

    const b = project({ "main.ts": HEAD + `
type S = Struct<{ runs: i32; n: i32; v0: i32; v1: i32; v2: i32 }>;
function read(ffi: Ffi): S {
  "use owned";
  "use unsafe";
  const cell = stscb_cell(ffi);
  return { runs: cell.read(), n: stscb_stat_n(ffi), v0: stscb_stat(ffi, 0), v1: stscb_stat(ffi, 1), v2: stscb_stat(ffi, 2) };
}
export function main(sys: System): void {
  const s = read(sys.ffi);
  sys.log.info(\`\${s.runs} \${s.n} \${s.v0} \${s.v1} \${s.v2}\`);
}
` });
    const rb = await run(b, { backend: "c" });
    expect(rb.diagnostics).toEqual([]);
    expect(rb.trap).toBeNull();
    // bump ran twice (the cell), the fixture invoked the trampoline three times, and the
    // values it got back were 2 (bump ran), 0 (bump trapped), 0 (the flag: bump not run).
    expect(rb.stdout).toBe("2 3 2 0 0\n");
  }, 120000);
});
