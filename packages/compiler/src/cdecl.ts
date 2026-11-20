// The C side of a `c:` declaration (SPEC §14.2): the specifier's shape and the mapping from
// STS types to the C types the header check probes for and the C backend emits. Shared by
// headercheck.ts (the _Static_assert probe) and emit-c.ts (Ptr / ConstPtr values and calls).
import type { NumName, Type } from "./types.ts";

/** `c:<package>:<header>`: the package is a pkg-config name, the header an angle-bracket path. */
export function parseCSpec(spec: string): { pkg: string; header: string } | undefined {
  const m = /^c:([^:]+):(.+)$/.exec(spec);
  return m ? { pkg: m[1]!, header: m[2]! } : undefined;
}

/** Splits `pkg-config --cflags` / `--libs` output respecting shell quotes and backslash escapes. */
export function splitFlags(s: string): string[] {
  const out: string[] = [];
  let cur = "", inArg = false, q: "'" | '"' | "" = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q === "'") { if (ch === "'") q = ""; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = "";
      else if (ch === "\\" && i + 1 < s.length && /["\\$`\n]/.test(s[i + 1]!)) cur += s[++i]!;
      else cur += ch;
      continue;
    }
    if (/\s/.test(ch)) { if (inArg) { out.push(cur); cur = ""; inArg = false; } continue; }
    inArg = true;
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === "\\" && i + 1 < s.length) cur += s[++i]!;
    else cur += ch;
  }
  if (inArg) out.push(cur);
  return out;
}

/** `$CC` (default `cc`) as a command and its leading arguments, so `CC="ccache cc"` and `CC="cc -m64"` work (D150). */
export function ccCommand(): [string, string[]] {
  const [cmd = "cc", ...args] = splitFlags(process.env.CC || "cc");
  return [cmd, args];
}

const CINT: Record<NumName, string> = {
  i8: "int8_t", i16: "int16_t", i32: "int32_t", u8: "uint8_t", u16: "uint16_t", u32: "uint32_t",
  usize: "size_t", f32: "float", f64: "double",
};

/** The C type of a declared parameter or return (§14.2's table). */
export function cTypeOf(t: Type): string {
  return cDecl(t, "");
}

/** The C declaration of `d` with the STS type `t`, built inside out so nested pointers compose:
 * `ConstPtr<Ptr<i32>>` is `int32_t *const *`, `Ptr<Ptr<(x: i32) => i32>>` is `int32_t (**)(int32_t)`.
 * `const` qualifies the pointee of a `ConstPtr` (a function has no qualifier). */
function cDecl(t: Type, d: string): string {
  if (t.k === "fn") return cDecl({ k: "gen", name: "Ptr", args: [t] }, d); // not a legal value position; keeps the mapping total
  if (t.k === "gen" && (t.name === "Ptr" || t.name === "ConstPtr")) {
    const p = t.args[0]!, c = t.name === "ConstPtr" ? "const " : "";
    if (p.k === "fn") return cDecl(p.ret, `(*${d})(${p.params.map((x) => cDecl(x, "")).join(", ") || "void"})`);
    if (p.k === "gen" && (p.name === "Ptr" || p.name === "ConstPtr")) return cDecl(p, `${c}*${d}`);
    return `${c}${cPointeeOf(p)} *${d}`;
  }
  const b = t.k === "num" ? CINT[t.name] : t.k === "prim" && t.name === "boolean" ? "bool" : "void";
  return d ? `${b} ${d}` : b;
}

/** The C type a Ptr / ConstPtr points at (§14.2): the table again for numbers and boolean,
 * `void` for void, the literal name for CType, the full type for a nested pointer or a function
 * pointer, and `void` for any other STS type. */
export function cPointeeOf(t: Type): string {
  switch (t.k) {
    case "num": return CINT[t.name];
    case "prim": return t.name === "boolean" ? "bool" : "void";
    case "gen": {
      if (t.name === "CType") { const a = t.args[0]; return a?.k === "lit" ? a.value : "void"; }
      if (t.name === "Ptr" || t.name === "ConstPtr") return cTypeOf(t);
      return "void";
    }
    case "fn": return cTypeOf(t);
    default: return "void";
  }
}
