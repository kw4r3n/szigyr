// P4: the header check (SPEC §14.2, Q193). Every `c:` declaration is probed against the real
// C header: pkg-config must know the package, the header must include, and for each function a
// pair of _Static_assert lines (the declared type, and the same type with one extra parameter)
// must compile with `cc -std=gnu11`. Any failure is E2009: at the `declare module` specifier
// when the package or the header is missing, at the function's name otherwise. Runs only when
// P1-P3 are clean (analyze), so a program that does not check never reaches the compiler.
// Probes are cached per process on their exact text and flags.
import { execFileSync } from "node:child_process";
import { SyntaxKind as K, type ts } from "./parse.ts";
import type { Module, Program, Reporter } from "./modules.ts";
import { ccCommand, cTypeOf, parseCSpec, splitFlags } from "./cdecl.ts";

const pkgKnown = new Map<string, boolean>();
const pkgFlags = new Map<string, string[]>();
const probeCache = new Map<string, boolean>();

/** D160: the environment pkg-config answers from is part of the cache key (the caches live as long as the process, and the environment can change in it). */
const pkgEnv = (pkg: string): string => ["PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "PKG_CONFIG_SYSROOT_DIR"].map((k) => process.env[k] ?? "").join("\0") + `\0${pkg}`;

function pkgExists(pkg: string): boolean {
  const k = pkgEnv(pkg);
  let ok = pkgKnown.get(k);
  if (ok === undefined) {
    try { execFileSync("pkg-config", ["--exists", "--", pkg], { stdio: "ignore" }); ok = true; } catch { ok = false; }
    pkgKnown.set(k, ok);
  }
  return ok;
}

function cflagsOf(pkg: string): string[] {
  const k = pkgEnv(pkg);
  let flags = pkgFlags.get(k);
  if (flags === undefined) {
    try { flags = splitFlags(execFileSync("pkg-config", ["--cflags", "--", pkg], { encoding: "utf8" })); }
    catch { flags = []; }
    pkgFlags.set(k, flags);
  }
  return flags;
}

function probe(source: string, cflags: string[]): boolean {
  const [cc, ccArgs] = ccCommand();
  const key = `${cc}\0${ccArgs.join("\0")}\0${cflags.join("\0")}\0${source}`;
  let ok = probeCache.get(key);
  if (ok === undefined) {
    try {
      execFileSync(cc, [...ccArgs, "-std=gnu11", ...cflags, "-fsyntax-only", "-x", "c", "-"], { input: source, stdio: ["pipe", "ignore", "ignore"], timeout: 60_000 });
      ok = true;
    } catch { ok = false; }
    probeCache.set(key, ok);
  }
  return ok;
}

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
    for (const [spec, fns] of mod.cdecls) {
      const cs = parseCSpec(spec);
      const at = specifierOf(mod, spec);
      if (!cs) {
        if (at) rep.at(mod, "E2009", at, `invalid 'c:' specifier '${spec}'`);
        continue;
      }
      if (!pkgExists(cs.pkg)) {
        if (at) rep.at(mod, "E2009", at, `pkg-config does not know the package '${cs.pkg}'`);
        continue;
      }
      const cflags = cflagsOf(cs.pkg);
      const prelude = `#include <stdint.h>\n#include <stdbool.h>\n#include <stddef.h>\n#include <${cs.header}>\nstruct sts_probe { int x; };\n`;
      if (!probe(prelude, cflags)) {
        if (at) rep.at(mod, "E2009", at, `the header '${cs.header}' of the package '${cs.pkg}' cannot be included`);
        continue;
      }
      for (const cf of fns.values()) {
        const ps = cf.sig.params.slice(1).map(cTypeOf); // the Ffi parameter is not passed to C (§14.2)
        const want = `${cTypeOf(cf.sig.ret)} (*)(${ps.join(", ") || "void"})`;
        const more = `${cTypeOf(cf.sig.ret)} (*)(${[...ps, "struct sts_probe"].join(", ")})`;
        const source = `${prelude}_Static_assert(__builtin_types_compatible_p(__typeof__(&${cf.name}), ${want}), "${cf.name}");\n_Static_assert(!__builtin_types_compatible_p(__typeof__(&${cf.name}), ${more}), "${cf.name}");\n`;
        if (!probe(source, cflags)) rep.at(mod, "E2009", cf.decl.name!, `'${cf.name}' does not match the declaration in '${cs.header}'`);
      }
    }
  }
}
