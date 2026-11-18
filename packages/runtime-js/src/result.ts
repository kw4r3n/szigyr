import { RANGE, type NumType, type IntType } from "./num.ts";

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
      if (typeof x !== "number") return bad(d.t);
      if (d.t === "f64") return null;
      if (d.t === "f32") return Number.isNaN(x) || Math.fround(x) === x ? null : bad("f32");
      const [lo, hi] = RANGE[d.t as IntType];
      return Number.isInteger(x) && x >= lo && x <= hi ? null : bad(d.t);
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
  const e = check(desc, x, "$");
  return e === null ? ok(x as T) : err({ code: "cast", message: e });
}
