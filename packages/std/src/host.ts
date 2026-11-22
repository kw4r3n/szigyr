import { asTrap, capturing, type Pos } from "../../runtime-js/src/index.ts";
import type { System } from "./types.ts";
import { createSystem, getProcExitCode } from "./node.ts";

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Set when main ended in a trap. Output written before the trap is kept. */
  readonly trap?: { readonly code: string; readonly message: string; readonly pos?: Pos };
  readonly exitCode?: number;
}

/** Runs `main` against a real System whose Log is captured. Awaits a Promise result. Stack exhaustion is T006 (Q035). */
export async function runMain(main: (sys: System) => void | Promise<void>, opts?: { args?: readonly string[] }): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const sys = createSystem((s) => (stdout += s), (s) => (stderr += s), opts);
  try {
    const rejected = await capturing(() => main(sys)); // Q140
    if (rejected.length) throw rejected[0];
    const exitCode = getProcExitCode(sys.proc);
    return { stdout, stderr, ...(exitCode ? { exitCode } : {}) };
  } catch (e) {
    const t = asTrap(e); // stack exhaustion is T006 (Q035)
    if (t) return { stdout, stderr, trap: { code: t.code, message: t.message, pos: t.pos } };
    throw e;
  }
}
