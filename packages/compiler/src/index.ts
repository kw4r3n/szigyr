import type { Diagnostic, RunResult } from "./diagnostics.ts";
export * from "./diagnostics.ts";
export * from "./names.ts";

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented`);
    this.name = "NotImplementedError";
  }
}

export function check(_entryFile: string): Diagnostic[] {
  throw new NotImplementedError("check");
}

export async function run(_entryFile: string): Promise<RunResult> {
  throw new NotImplementedError("run");
}
