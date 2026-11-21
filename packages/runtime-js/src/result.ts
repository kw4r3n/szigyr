import { RANGE, RANGE64, type Int32Type, type NumType } from "./num.ts";
import { isTrap, Trap, trap, type Pos } from "./trap.ts";

export type Result<T, E> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "err"; readonly error: E };
export const ok = <T>(value: T): Result<T, never> => ({ kind: "ok", value });
export const err = <E>(error: E): Result<never, E> => ({ kind: "err", error });

/** Q036 */
export interface CastError { readonly code: string; readonly message: string }

/** Type descriptor the translator passes to cast / js.decode. `union` covers tagged unions and `T | null`. */
export type TypeDesc =
  | { readonly k: "boolean" } | { readonly k: "string" } | { readonly k: "null" }
  | { readonly k: "num"; readonly t: NumType }
  | { readonly k: "lit"; readonly v: readonly string[] }
  | { readonly k: "rec"; readonly f: { readonly [name: string]: TypeDesc } }
  | { readonly k: "union"; readonly m: readonly TypeDesc[] }
  | { readonly k: "arr"; readonly of: TypeDesc };

/** Returns an error message, or null when `x` has the type. Records are exact: extra properties fail. */
function check(d: TypeDesc, x: unknown, path: string): string | null {
  const bad = (what: string): string => `${path}: expected ${what}`;
  switch (d.k) {
    case "boolean": return typeof x === "boolean" ? null : bad("boolean");
    case "string": return typeof x === "string" ? null : bad("string");
    case "null": return x === null ? null : bad("null");
    case "num": {
      if (d.t === "i64" || d.t === "u64") {
        if (typeof x !== "bigint") return bad(d.t);
        const [lo, hi] = RANGE64[d.t];
        return x >= lo && x <= hi ? null : bad(d.t);
      }
      if (typeof x !== "number") return bad(d.t);
      if (d.t === "f64") return null;
      if (d.t === "f32") return Number.isNaN(x) || Math.fround(x) === x ? null : bad("f32");
      const [lo, hi] = RANGE[d.t as Int32Type];
      return Number.isInteger(x) && x >= lo && x <= hi && !Object.is(x, -0) ? null : bad(d.t); // -0 is not an integer value (Q090, Q141)
    }
    case "lit": return typeof x === "string" && d.v.includes(x) ? null : bad(d.v.map((s) => JSON.stringify(s)).join(" | "));
    case "arr": {
      if (!Array.isArray(x)) return bad("array");
      for (let i = 0; i < x.length; i++) { const e = check(d.of, x[i], `${path}[${i}]`); if (e) return e; }
      return null;
    }
    case "rec": {
      if (typeof x !== "object" || x === null || Array.isArray(x)) return bad("record");
      const keys = Object.keys(x);
      const names = Object.keys(d.f);
      if (keys.length !== names.length) return bad(`exactly {${names.join(", ")}}`);
      for (const n of names) {
        if (!Object.hasOwn(x, n)) return bad(`field ${n}`);
        const e = check(d.f[n] as TypeDesc, (x as Record<string, unknown>)[n], `${path}.${n}`);
        if (e) return e;
      }
      return null;
    }
    case "union": {
      let last = bad("union member");
      for (const m of d.m) { const e = check(m, x, path); if (e === null) return null; last = e; }
      return last;
    }
  }
}

/** cast<T>(x) with the descriptor of T. Returns x itself (no copy) when valid. */
export function cast<T>(x: unknown, desc: TypeDesc): Result<T, CastError> {
  try {
    const e = check(desc, x, "$");
    return e === null ? ok(x as T) : err({ code: "cast", message: e });
  } catch (e) {
    if (isTrap(e)) throw e;
    return err({ code: "cast", message: e instanceof Error ? e.message : String(e) });
  }
}

/** JSON.parse (Q035): a syntax error is `err({ code: "SyntaxError", message })`; any other exception (stack exhaustion) is a panic (T006). */
export function jsonParse(text: string, pos?: Pos): Result<unknown, { readonly code: string; readonly message: string }> {
  try {
    return ok(JSON.parse(text));
  } catch (e) {
    if (e instanceof Trap) throw e;
    if (e instanceof SyntaxError) return err({ code: e.name, message: e.message });
    return trap("T006", `parse: ${e instanceof Error ? e.message : String(e)}`, pos);
  }
}
