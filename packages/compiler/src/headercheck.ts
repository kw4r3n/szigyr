// P4: the header check (SPEC §14.2, SPEC-v1 §9). Every `c:` declaration (function, const, CStruct)
// and `Ptr.sizeOf<CType<"...">>()` is probed against the real C header using `pkg-config` and
// `cc -std=gnu11` `_Static_assert`s. Any failure is E2009: at the `declare module` specifier
// when the package or the header is missing, at the declaration name or call otherwise. Runs under
// all-phase recovery in `analyze` (skipping declarations with invalid P2 types/signatures).
// Probes are cached per process on their exact text and flags.
import { execFileSync } from "node:child_process";
import { SyntaxKind as K, type ts } from "./parse.ts";
import type { Module, Program, Reporter } from "./modules.ts";
import { C_IDENT, ccCommand, cTypeOf, isValidCHeader, isValidPkgName, parseCSpec, sanitizeCflags, splitFlags } from "./cdecl.ts";
import { INT_RANGE, I64_MIN, isBool, isErr, type Type } from "./types.ts";

interface ProbeRes { ok: boolean; stderr: string }

const pkgKnown = new Map<string, boolean>();
const pkgFlags = new Map<string, string[]>();
const probeCache = new Map<string, ProbeRes>();

/** D160: the environment pkg-config answers from is part of the cache key (the caches live as long as the process, and the environment can change in it). */
const pkgEnv = (pkg: string): string => ["PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "PKG_CONFIG_SYSROOT_DIR"].map((k) => process.env[k] ?? "").join("\0") + `\0${pkg}`;

function pkgExists(pkg: string): boolean {
  if (!isValidPkgName(pkg)) return false;
  const k = pkgEnv(pkg);
  let ok = pkgKnown.get(k);
  if (ok === undefined) {
    try { execFileSync("pkg-config", ["--exists", "--", pkg], { stdio: "ignore" }); ok = true; } catch { ok = false; }
    pkgKnown.set(k, ok);
  }
  return ok;
}

function cflagsOf(pkg: string): string[] {
  if (!isValidPkgName(pkg)) return [];
  const k = pkgEnv(pkg);
  let flags = pkgFlags.get(k);
  if (flags === undefined) {
    try { flags = sanitizeCflags(splitFlags(execFileSync("pkg-config", ["--cflags", "--", pkg], { encoding: "utf8" }))); }
    catch { flags = []; }
    pkgFlags.set(k, flags);
  }
  return flags;
}

function probe(source: string, cflags: string[]): ProbeRes {
  const [cc, ccArgs] = ccCommand();
  const key = `${cc}\0${ccArgs.join("\0")}\0${cflags.join("\0")}\0${source}`;
  let res = probeCache.get(key);
  if (res === undefined) {
    try {
      execFileSync(cc, [...ccArgs, "-std=gnu11", ...cflags, "-fsyntax-only", "-x", "c", "-"], { input: source, stdio: ["pipe", "ignore", "pipe"], encoding: "utf8", timeout: 60_000 });
      res = { ok: true, stderr: "" };
    } catch (e) {
      const raw = String((e as { stderr?: string }).stderr ?? "").trim();
      res = { ok: false, stderr: raw.length > 1500 ? raw.slice(0, 1500) : raw };
    }
    probeCache.set(key, res);
  }
  return res;
}

function firstErrLine(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /\berror:/i.test(l)) ?? lines[0] ?? "";
}

function canProbeCType(t: Type): boolean {
  if (t.k === "num") return true;
  if (t.k === "prim") return t.name === "boolean";
  if (t.k === "gen" && (t.name === "Ptr" || t.name === "ConstPtr")) return canProbePointee(t.args[0]!);
  return false;
}
function canProbePointee(t: Type): boolean {
  if (t.k === "error") return false;
  if (t.k === "num") return t.name !== "usize";
  if (t.k === "prim") return t.name === "boolean" || t.name === "void";
  if (t.k === "cstruct") return true;
  if (t.k === "gen" && t.name === "CType") { const a = t.args[0]; return a?.k === "lit" && C_IDENT.test(a.value); }
  if (t.k === "gen" && (t.name === "Ptr" || t.name === "ConstPtr")) return canProbePointee(t.args[0]!);
  if (t.k === "fn") return (t.ret.k === "prim" && t.ret.name === "void" || canProbeCType(t.ret)) && t.params.every(canProbeCType);
  return true;
}

const SZ_TYPE_MACROS =
  `#define SZ_IS_INT(x) _Generic((x), _Bool: 1, char: 1, signed char: 1, unsigned char: 1, short: 1, unsigned short: 1, int: 1, unsigned int: 1, long: 1, unsigned long: 1, long long: 1, unsigned long long: 1, default: 0)\n` +
  `#define SZ_IS_FLT(x) _Generic((x), float: 1, double: 1, long double: 1, default: 0)\n`;

/** The string literal of the file's `declare module "<spec>"` (the E2009 anchor for a missing package or header). */
function specifierOf(mod: Module, spec: string): ts.StringLiteral | undefined {
  for (const s of mod.sf.statements) {
    if (s.kind !== K.ModuleDeclaration) continue;
    const d = s as ts.ModuleDeclaration;
    if (d.name.kind === K.StringLiteral && (d.name as ts.StringLiteral).text === spec) return d.name as ts.StringLiteral;
  }
  return undefined;
}

export function checkHeaders(prog: Program, rep: Reporter): void {
  for (const mod of prog.mods) {
    const validHeaders: { header: string; cflags: string[] }[] = [];
    let anyHeaderFailed = false;
    for (const [spec, fns] of mod.cdecls) {
      const cs = parseCSpec(spec);
      if (!cs) continue; // P1 already reported E7002
      if (!isValidCHeader(cs.header)) { anyHeaderFailed = true; continue; }
      const at = specifierOf(mod, spec);
      if (!pkgExists(cs.pkg)) {
        anyHeaderFailed = true;
        if (at) rep.at(mod, "E2009", at, `pkg-config does not know the package '${cs.pkg}'`, { pkg: cs.pkg, header: cs.header });
        continue;
      }
      const cflags = cflagsOf(cs.pkg);
      const prelude = `#include <stdint.h>\n#include <stdbool.h>\n#include <stddef.h>\n#include <${cs.header}>\n${SZ_TYPE_MACROS}struct sz_probe { int x; };\n`;
      const inc = probe(prelude, cflags);
      if (!inc.ok) {
        anyHeaderFailed = true;
        const hint = firstErrLine(inc.stderr);
        if (at) rep.at(mod, "E2009", at, `the header '${cs.header}' of the package '${cs.pkg}' cannot be included${hint ? ` (${hint})` : ""}`, { pkg: cs.pkg, header: cs.header, ...(inc.stderr ? { ccStderr: inc.stderr } : {}) });
        continue;
      }
      validHeaders.push({ header: cs.header, cflags });
      for (const cf of fns.values()) {
        if (!cf.sig.params.length || cf.sig.params[0]?.k !== "opaque" || cf.sig.params[0].name !== "Ffi") continue;
        const retOk = (cf.sig.ret.k === "prim" && cf.sig.ret.name === "void") || canProbeCType(cf.sig.ret);
        if (!retOk || !cf.sig.params.slice(1).every(canProbeCType)) continue;
        const ps = cf.sig.params.slice(1).map(cTypeOf); // the Ffi parameter is not passed to C (§14.2)
        const want = `${cTypeOf(cf.sig.ret)} (*)(${ps.join(", ") || "void"})`;
        const more = `${cTypeOf(cf.sig.ret)} (*)(${[...ps, "struct sz_probe"].join(", ")})`;
        const source = `${prelude}_Static_assert(__builtin_types_compatible_p(__typeof__(&${cf.name}), ${want}), "${cf.name}");\n_Static_assert(!__builtin_types_compatible_p(__typeof__(&${cf.name}), ${more}), "${cf.name}");\n`;
        const res = probe(source, cflags);
        if (!res.ok) {
          const hint = firstErrLine(res.stderr);
          rep.at(mod, "E2009", cf.decl.name!, `'${cf.name}' does not match the declaration in '${cs.header}'${hint ? ` (${hint})` : ""}`, { pkg: cs.pkg, header: cs.header, fn: cf.name, expectedC: want, ...(res.stderr ? { ccStderr: res.stderr } : {}) });
        }
      }
      for (const cc of mod.cconsts.get(spec)?.values() ?? []) {
        if (isErr(cc.type) || (cc.type.k !== "num" && !isBool(cc.type))) continue;
        const n = cc.name;
        let check = "";
        if (isBool(cc.type)) {
          check = `_Static_assert(SZ_IS_INT(+(${n})), "${n}");\n_Static_assert(!__builtin_constant_p(${n}) || ((${n}) == 0 || (${n}) == 1), "${n}");\n`;
        } else if (cc.type.k === "num" && (cc.type.name === "f32" || cc.type.name === "f64")) {
          check = `_Static_assert(SZ_IS_INT(+(${n})) || SZ_IS_FLT(+(${n})), "${n}");\n`;
        } else if (cc.type.k === "num") {
          const [lo, hi] = INT_RANGE[cc.type.name]!;
          const ct = cTypeOf(cc.type);
          const loC = lo === I64_MIN ? "(-9223372036854775807LL - 1LL)" : `${lo}LL`;
          const hiU = `${hi}ULL`;
          const rangeExpr = lo < 0n
            ? `(((__typeof__(+(${n})))-1 < 0) ? ((long long)(${n}) >= ${loC} && (long long)(${n}) <= ${hi}LL) : ((unsigned long long)(${n}) <= ${hiU}))`
            : `(((__typeof__(+(${n})))-1 < 0) ? ((long long)(${n}) >= 0 && (unsigned long long)(${n}) <= ${hiU}) : ((unsigned long long)(${n}) <= ${hiU}))`;
          const extExpr = `(sizeof(${n}) <= sizeof(${ct}) && (((__typeof__(+(${n})))-1 < 0) == ((${ct})-1 < 0) || (sizeof(${n}) < sizeof(${ct}) && ((${ct})-1 < 0))))`;
          check = `_Static_assert(SZ_IS_INT(+(${n})), "${n}");\n_Static_assert(__builtin_constant_p(${n}) ? (${rangeExpr}) : (${extExpr}), "${n}");\n`;
        }
        const res = probe(prelude + check, cflags);
        if (!res.ok) {
          const hint = firstErrLine(res.stderr);
          rep.at(mod, "E2009", cc.decl.name, `'${cc.name}' does not match the constant declaration in '${cs.header}'${hint ? ` (${hint})` : ""}`, { pkg: cs.pkg, header: cs.header, const: cc.name, ...(res.stderr ? { ccStderr: res.stderr } : {}) });
        }
      }
      for (const csym of mod.cstructs.get(spec)?.values() ?? []) {
        if (csym.type.k !== "cstruct" || !csym.type.fields.length) continue;
        const S = csym.name;
        const lines = [`_Static_assert(sizeof(${S}) > 0 && sizeof(${S}) <= 4294967295ULL, "${S}");`];
        for (const f of csym.type.fields) {
          if (isErr(f.type)) continue;
          const ok = canProbeCType(f.type) || f.type.k === "cstruct" || (f.type.k === "gen" && f.type.name === "CType" && f.type.args[0]?.k === "lit" && C_IDENT.test(f.type.args[0].value));
          if (!ok) continue;
          lines.push(`_Static_assert(offsetof(${S}, ${f.name}) < sizeof(${S}), "${S}.${f.name}");`);
          if (f.type.k === "num" && f.type.name !== "f32" && f.type.name !== "f64") {
            const ct = cTypeOf(f.type);
            lines.push(
              `_Static_assert(sizeof(((${S} *)0)->${f.name}) == sizeof(${ct}), "${S}.${f.name}");`,
              `_Static_assert(SZ_IS_INT(+(((${S} *)0)->${f.name})), "${S}.${f.name}");`,
              `_Static_assert(((__typeof__(((${S} *)0)->${f.name}))-1 < 0) == ((${ct})-1 < 0), "${S}.${f.name}");`,
            );
          } else {
            lines.push(`_Static_assert(__builtin_types_compatible_p(__typeof__(((${S} *)0)->${f.name}), ${cTypeOf(f.type)}), "${S}.${f.name}");`);
          }
        }
        const res = probe(`${prelude}${lines.join("\n")}\n`, cflags);
        if (!res.ok) {
          const hint = firstErrLine(res.stderr);
          rep.at(mod, "E2009", csym.decl.name, `'${S}' does not match the struct layout in '${cs.header}'${hint ? ` (${hint})` : ""}`, { pkg: cs.pkg, header: cs.header, struct: S, ...(res.stderr ? { ccStderr: res.stderr } : {}) });
        }
      }
    }
    const sizeOfs = prog.ptrSizeOfs.filter((x) => x.mod === mod);
    if (sizeOfs.length) {
      if (mod.cdecls.size === 0) {
        for (const entry of sizeOfs) {
          rep.at(mod, "E2009", entry.node, `'Ptr.sizeOf<CType<"${entry.cname}">>()' requires a 'declare module "c:..."' declaring its C header`, { ctype: entry.cname });
        }
      } else if (!anyHeaderFailed) {
        const hdrLines = validHeaders.map((h) => `#include <${h.header}>`).join("\n");
        const allFlags = [...new Set(validHeaders.flatMap((h) => h.cflags))];
        const combPrelude = `#include <stdint.h>\n#include <stdbool.h>\n#include <stddef.h>\n${hdrLines}\n`;
        for (const entry of sizeOfs) {
          if (!C_IDENT.test(entry.cname)) continue;
          const res = probe(`${combPrelude}_Static_assert(sizeof(${entry.cname}) > 0 && sizeof(${entry.cname}) <= 4294967295ULL, "${entry.cname}");\n`, allFlags);
          if (!res.ok) {
            const hint = firstErrLine(res.stderr);
            rep.at(mod, "E2009", entry.node, `'${entry.cname}' has no known size${hint ? ` (${hint})` : ""}`, { ctype: entry.cname, ...(res.stderr ? { ccStderr: res.stderr } : {}) });
          }
        }
      }
    }
  }
}
