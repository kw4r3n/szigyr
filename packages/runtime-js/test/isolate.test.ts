import { describe, expect, it } from "vitest";
import { setIsolateProgram, spawnIsolate, takeIsolateTrap } from "../src/index.ts";

/** Starts an isolate over one module whose body is `js`, waits until its port closes, and returns the recorded trap. */
async function failure(js: string, name: string): Promise<ReturnType<typeof takeIsolateTrap>> {
  takeIsolateTrap();
  setIsolateProgram({
    files: [["/m.ts", { js, imports: [], calls: [] }]], entry: "/m.ts",
    runtimeUrl: new URL("../src/index.ts", import.meta.url).href,
    stdUrl: new URL("../../std/src/index.ts", import.meta.url).href,
    nativePath: null, rtName: "RT", impName: "IMP", exportsName: "EX", framePattern: "^$",
  });
  try {
    expect(await spawnIsolate("/m.ts", name).recv()).toBeNull(); // the trap is posted before the port closes
  } finally { setIsolateProgram(undefined); }
  return takeIsolateTrap();
}

describe("isolate failures (§15.2: recorded as T006)", () => {
  it("a non-trap exception in the entry keeps its cause", async () => {
    const t = await failure(`EX.f = () => { throw new TypeError("runtime bug"); };`, "f");
    expect(t?.code).toBe("T006");
    expect(t?.message).toContain("runtime bug");
  }, 60000);
  it("a bootstrap failure keeps its cause", async () => {
    const t = await failure("", "missing");
    expect(t?.code).toBe("T006");
    expect(t?.message).toContain("isolate entry not found: missing");
  }, 60000);
});
