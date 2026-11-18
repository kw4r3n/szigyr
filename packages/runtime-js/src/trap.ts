/** Opaque to the runtime: the translator passes it, the host reads it back. Q060 (no range: start only). */
export interface Pos { readonly file: string; readonly line: number; readonly col: number }

export type TrapCode = "T001" | "T002" | "T003" | "T004" | "T005" | "T006" | "T007" | "T008" | "T009" | "T010";

/** Not catchable from STS code; only hosts (test runner, main caller) see it. */
export class Trap extends Error {
  constructor(readonly code: TrapCode, message: string, readonly pos?: Pos) {
    super(`${code}: ${message}`);
    this.name = "Trap";
  }
}

export function trap(code: TrapCode, message: string, pos?: Pos): never {
  throw new Trap(code, message, pos);
}

// Contracts (SPEC 9.1). `ensures` takes the predicate and the return value: the translator calls it on every return path.
export function requires(cond: boolean, pos?: Pos): void { if (!cond) trap("T004", "requires violated", pos); }
export function ensures<R>(pred: (r: R) => boolean, r: R, pos?: Pos): void { if (!pred(r)) trap("T005", "ensures violated", pos); }
export function invariant(cond: boolean, pos?: Pos): void { if (!cond) trap("T010", "invariant violated", pos); }
export function panic(msg: string, pos?: Pos): never { return trap("T006", msg, pos); }
