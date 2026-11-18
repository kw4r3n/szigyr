import { Trap, type Pos } from "../../runtime-js/src/index.ts";
import type { System } from "./types.ts";
import { createSystem } from "./node.ts";

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Set when main ended in a trap. Output written before the trap is kept. */
  readonly trap?: { readonly code: string; readonly message: string; readonly pos?: Pos };
}

/** Runs `main` against a real System whose Log is captured. Awaits a Promise result. Stack exhaustion is T006 (Q035). */
export async function runMain(main: (sys: System) => void | Promise<void>): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const sys = createSystem((s) => (stdout += s), (s) => (stderr += s));
  try {
    await main(sys);
    return { stdout, stderr };
  } catch (e) {
    if (e instanceof Trap) return { stdout, stderr, trap: { code: e.code, message: e.message, pos: e.pos } };
    if (e instanceof RangeError && /call stack/i.test(e.message)) return { stdout, stderr, trap: { code: "T006", message: e.message } };
    throw e;
  }
}
