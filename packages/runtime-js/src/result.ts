import { readU8Slice, replaceU8Vec, type Slice, type Vec } from "./collections.ts";
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
  | { readonly k: "arr"; readonly of: TypeDesc }
  | { readonly k: "tup"; readonly e: readonly TypeDesc[] };

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
    case "tup": {
      if (!Array.isArray(x) || x.length !== d.e.length) return bad(`tuple of length ${d.e.length}`);
      for (let i = 0; i < d.e.length; i++) { const e = check(d.e[i]!, x[i], `${path}[${i}]`); if (e) return e; }
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

export function jsonStringify(v: unknown, indent?: number, pos?: Pos): string {
  try {
    return (indent === undefined ? JSON.stringify(v) : JSON.stringify(v, undefined, indent)) ?? "null";
  } catch (e) {
    if (isTrap(e)) throw e;
    return trap("T006", `stringify: ${e instanceof Error ? e.message : String(e)}`, pos);
  }
}

const isPlainObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function jsonGet(v: unknown, key: string): Result<unknown, CastError> {
  if (!isPlainObj(v)) return err({ code: "cast", message: "$: expected object" });
  return Object.hasOwn(v, key) ? ok(v[key]) : err({ code: "cast", message: `$: missing field ${key}` });
}

export function jsonKeys(v: unknown): Result<string[], CastError> {
  return isPlainObj(v) ? ok(Object.keys(v)) : err({ code: "cast", message: "$: expected object" });
}

export function jsonItems(v: unknown): Result<unknown[], CastError> {
  return Array.isArray(v) ? ok(v.slice()) : err({ code: "cast", message: "$: expected array" });
}

// Lazy init keeps module load AudioWorklet-safe where TextEncoder/TextDecoder may be absent.
let utf8Enc: TextEncoder | undefined;
let utf8DecStrict: TextDecoder | undefined;
let utf8DecLossy: TextDecoder | undefined;

export function strEncodeUtf8(s: string, dst: Vec<number>, pos?: Pos): number {
  try {
    const bytes = (utf8Enc ??= new TextEncoder()).encode(s);
    if (bytes.byteLength > 0xffffffff) return trap("T006", "UTF-8 output exceeds usize limit (4GiB)", pos);
    replaceU8Vec(dst, bytes);
    return bytes.byteLength;
  } catch (e) {
    if (isTrap(e)) throw e;
    return trap("T006", `encodeUtf8: ${e instanceof Error ? e.message : String(e)}`, pos);
  }
}

export function strDecodeUtf8(src: Vec<number> | Slice<number>, pos?: Pos): Result<string, { readonly code: string; readonly message: string }> {
  try {
    return ok((utf8DecStrict ??= new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })).decode(readU8Slice(src)));
  } catch (e) {
    if (isTrap(e)) throw e;
    if (e instanceof TypeError) return err({ code: "EINVAL", message: e.message });
    return trap("T006", `decodeUtf8: ${e instanceof Error ? e.message : String(e)}`, pos);
  }
}

export function strDecodeUtf8Lossy(src: Vec<number> | Slice<number>, pos?: Pos): string {
  try {
    return (utf8DecLossy ??= new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })).decode(readU8Slice(src));
  } catch (e) {
    if (isTrap(e)) throw e;
    return trap("T006", `decodeUtf8Lossy: ${e instanceof Error ? e.message : String(e)}`, pos);
  }
}

export interface QueryParam { readonly name: string; readonly value: string }

export const Url = {
  parseQuery(query: string): QueryParam[] {
    const out: QueryParam[] = [];
    for (const [name, value] of new URLSearchParams(query)) out.push({ name, value });
    return out;
  },
  getQueryParam(query: string, name: string): string | null {
    return new URLSearchParams(query).get(name);
  },
  formatQuery(params: readonly QueryParam[]): string {
    const sp = new URLSearchParams();
    for (const p of params) sp.append(p.name, p.value);
    return sp.toString();
  },
  encodeComponent(s: string): string {
    try {
      return encodeURIComponent(s);
    } catch {
      let fixed = "";
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
          if (next >= 0xdc00 && next <= 0xdfff) { fixed += s[i]! + s[i + 1]!; i++; }
          else fixed += "\uFFFD";
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          fixed += "\uFFFD";
        } else {
          fixed += s[i]!;
        }
      }
      return encodeURIComponent(fixed);
    }
  },
  decodeComponent(s: string): Result<string, { readonly code: string; readonly message: string }> {
    try {
      return ok(decodeURIComponent(s));
    } catch (e) {
      return err({ code: "EINVAL", message: e instanceof Error ? e.message : String(e) });
    }
  },
};

export interface RegExpMatch { readonly text: string; readonly index: number; readonly groups: (string | null)[] }

const toRegExpMatch = (m: RegExpExecArray): RegExpMatch => ({
  text: m[0] ?? "",
  index: m.index,
  groups: Array.from(m.slice(1), (g) => g ?? null),
});

/** Immutable, stateless regular expression wrapper (no g/y flags or lastIndex state). */
export class SzRegExp {
  readonly #re: globalThis.RegExp;
  readonly source: string;
  readonly flags: string;
  constructor(re: globalThis.RegExp) {
    this.#re = re;
    this.source = re.source;
    this.flags = re.flags;
  }
  test(s: string): boolean { return this.#re.test(s); }
  exec(s: string): RegExpMatch | null {
    const m = this.#re.exec(s);
    return m ? toRegExpMatch(m) : null;
  }
  findAll(s: string): RegExpMatch[] {
    const g = new globalThis.RegExp(this.#re.source, `${this.flags}g`);
    return Array.from(s.matchAll(g), toRegExpMatch);
  }
  replace(s: string, replacement: string): string { return s.replace(this.#re, replacement); }
  replaceAll(s: string, replacement: string): string {
    return s.replaceAll(new globalThis.RegExp(this.#re.source, `${this.flags}g`), replacement);
  }
  split(s: string): string[] { return s.split(this.#re).map((part) => part ?? ""); }
}

export function regexLit(pattern: string, flags: string): SzRegExp {
  return new SzRegExp(new globalThis.RegExp(pattern, flags));
}

export function regexCompile(pattern: string, flags = ""): Result<SzRegExp, CastError> {
  const seen = new Set<string>();
  for (const ch of flags) {
    if (!"imsu".includes(ch) || seen.has(ch)) {
      return err({ code: "EINVAL", message: `unsupported or duplicate RegExp flag '${ch}'; only 'i', 'm', 's', 'u' are allowed` });
    }
    seen.add(ch);
  }
  try {
    return ok(new SzRegExp(new globalThis.RegExp(pattern, flags)));
  } catch (e) {
    return err({ code: "SyntaxError", message: e instanceof Error ? e.message : String(e) });
  }
}

/** Strict full-string integer parser: rejects whitespace, base prefixes (`0x`), underscores, and trailing junk. */
export function parseIntStrict(kind: "i32" | "u32" | "i64" | "u64", s: string, radix = 10): Result<number | bigint, CastError> {
  if (!Number.isInteger(radix) || radix < 2 || radix > 36) {
    return err({ code: "cast", message: `invalid radix ${radix}; expected integer in 2..36` });
  }
  if (s.length === 0) return err({ code: "cast", message: `invalid ${kind}: empty string` });
  let i = 0;
  let neg = false;
  const first = s.charCodeAt(0);
  if (first === 43 || first === 45) {
    neg = first === 45;
    if (neg && (kind === "u32" || kind === "u64")) {
      return err({ code: "cast", message: `invalid ${kind}: negative sign not allowed` });
    }
    i = 1;
    if (i >= s.length) return err({ code: "cast", message: `invalid ${kind}: missing digits` });
  }
  const [lo, hi] = kind === "i64" || kind === "u64"
    ? RANGE64[kind]
    : [BigInt(RANGE[kind][0]), BigInt(RANGE[kind][1])];
  const base = BigInt(radix);
  const limit = neg ? -lo : hi;
  let acc = 0n;
  let overflow = false;
  for (; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    let d = -1;
    if (ch >= 48 && ch <= 57) d = ch - 48;
    else if (ch >= 97 && ch <= 122) d = ch - 87;
    else if (ch >= 65 && ch <= 90) d = ch - 55;
    if (d < 0 || d >= radix) {
      return err({ code: "cast", message: `invalid ${kind} character '${s[i]}' for radix ${radix}` });
    }
    if (!overflow) {
      acc = acc * base + BigInt(d);
      if (acc > limit) overflow = true;
    }
  }
  if (overflow) return err({ code: "cast", message: `${kind} overflow` });
  const signed = neg ? -acc : acc;
  return ok(kind === "i64" || kind === "u64" ? signed : Number(signed) + 0);
}
