// Builds the C translation unit into a Node-API addon with the installed `cc` and loads it (D101). No node-gyp, no npm dependency.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { threadId } from "node:worker_threads";
import { ccCommand, isValidPkgName, sanitizeCflags, splitFlags } from "./cdecl.ts";
import { CLI_NAME } from "./names.ts";

export const CFLAGS = ["-std=gnu11", "-O2", "-ffp-contract=off", "-fno-fast-math", "-fwrapv", "-fexcess-precision=standard", "-falign-loops=32", "-shared", "-fPIC", "-w"];

/** Error of the C toolchain (missing compiler or headers, compile failure): a CLI / internal error, not a diagnostic. */
export class CBuildError extends Error {
  constructor(msg: string) { super(msg); this.name = "CBuildError"; }
}

const loaded = new Map<string, Record<string, (...a: unknown[]) => unknown>>();
const pathOf = new WeakMap<object, string>();
/** The `.node` file a loaded native module came from; an isolate loads the same file (§15.2, D111). */
export function nativePathOf(mod: object): string | undefined { return pathOf.get(mod); }
const progOf = new WeakMap<object, number>();
/** What `init` returned on this thread: the program handle an isolate passes to its own `init` (D165). */
export function nativeProgOf(mod: object): number | undefined { return progOf.get(mod); }

export function touchCacheEntry(p: string): void { const now = new Date(); try { utimesSync(p, now, now); } catch { /* raced with a prune */ } }

/** D149: past ~500 entries, delete (also stale `.tmp*`) what has not been used for 7 days. Processes and isolate workers share the directory, so races are ignored. */
export function pruneCacheDir(dir: string, keep: string): void {
  try {
    const names = readdirSync(dir);
    if (names.length <= 500) return;
    const cutoff = Date.now() - 7 * 864e5;
    for (const n of names) {
      const p = join(dir, n);
      try { if (n !== keep && statSync(p).mtimeMs < cutoff) rmSync(p, { force: true }); } catch { /* gone already */ }
    }
  } catch { /* the cache is only an optimisation */ }
}

/** Creates and verifies a private (`0o700`, owned by uid) cache directory under XDG_CACHE_HOME. */
export function ensurePrivateCacheDir(suffix: string, label: string): string {
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), `${CLI_NAME}-${suffix}`);
  let st;
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); st = statSync(dir); } catch (e) { throw new CBuildError(`${label}: cache directory ${dir} is not usable: ${(e as Error).message}`); } // D150
  if ((process.getuid && st.uid !== process.getuid()) || (st.mode & 0o022)) throw new CBuildError(`${label}: cache directory ${dir} is not private to this user`);
  return dir;
}

function resolveToolchain(pkgs: string[]): { inc: string; cc: string; ccArgs: string[]; pkgCflags: string[]; pkgLibs: string[] } {
  const inc = resolve(process.execPath, "../../include/node");
  if (!existsSync(join(inc, "node_api.h"))) throw new CBuildError(`C backend: Node-API headers not found at ${inc}`);
  // §14.2: the `c:` declarations' packages contribute their cflags to the compile and their libs to the link.
  let pkgCflags: string[] = [], pkgLibs: string[] = [];
  if (pkgs.length) {
    for (const p of pkgs) if (!isValidPkgName(p)) throw new CBuildError(`C backend: invalid pkg-config package name '${p}'`);
    try {
      pkgCflags = sanitizeCflags(splitFlags(execFileSync("pkg-config", ["--cflags", "--", ...pkgs], { encoding: "utf8" })));
      pkgLibs = splitFlags(execFileSync("pkg-config", ["--libs", "--", ...pkgs], { encoding: "utf8" }));
    } catch { throw new CBuildError(`C backend: pkg-config could not resolve: ${pkgs.join(", ")}`); }
  }
  const [cc, ccArgs] = ccCommand();
  return { inc, cc, ccArgs, pkgCflags, pkgLibs };
}

function compileWithToolchain(c: string, outPath: string, tc: ReturnType<typeof resolveToolchain>): void {
  mkdirSync(dirname(outPath), { recursive: true });
  // Workers of one process share the pid, so the temporary names also carry the thread id (D111).
  const tmp = `${outPath}.${process.pid}.${threadId}.tmp`, src = `${tmp}.c`;
  writeFileSync(src, c);
  let ok = false;
  try {
    execFileSync(tc.cc, [...tc.ccArgs, ...CFLAGS, ...tc.pkgCflags, `-I${tc.inc}`, src, "-o", tmp, "-lm", ...tc.pkgLibs], { stdio: ["ignore", "ignore", "pipe"] });
    renameSync(tmp, outPath);
    ok = true;
  } catch (e) {
    const err = e as { code?: string; stderr?: Buffer };
    throw new CBuildError(err.code === "ENOENT" ? `C backend: no C compiler ('${tc.cc}') found` : `C backend: compiling ${src} failed:\n${err.stderr?.toString() ?? String(e)}`);
  } finally {
    rmSync(src, { force: true });
    if (!ok) rmSync(tmp, { force: true });
  }
}

/** Compiles generated C source into a standalone Node-API `.node` shared object at `outPath`. */
export function compileNativeAddon(c: string, outPath: string, pkgs: string[] = []): void {
  compileWithToolchain(c, outPath, resolveToolchain(pkgs));
}

/** Compiles (cached by source hash) and loads the addon; `host` is passed to its `init`. */
export function loadNative(c: string, host: object, pkgs: string[] = []): Record<string, (...a: unknown[]) => unknown> {
  const tc = resolveToolchain(pkgs);
  const hash = createHash("sha256").update(process.env.CC || "cc").update("\0").update(c).update("\0").update(CFLAGS.join(" ")).update("\0").update(tc.pkgCflags.join(" ")).update("\0").update(tc.pkgLibs.join(" ")).update("\0").update(process.version).digest("hex").slice(0, 24);
  let mod = loaded.get(hash);
  if (mod) touchCacheEntry(pathOf.get(mod)!); // a long-lived process keeps its entry fresh too (D149)
  else {
    // A per-user cache: a loaded addon runs native code, so the directory must be ours and closed to others.
    const dir = ensurePrivateCacheDir("native", "C backend");
    const out = join(dir, `${hash}.node`);
    if (existsSync(out)) touchCacheEntry(out); // age = last use (D149)
    else {
      compileWithToolchain(c, out, tc);
      pruneCacheDir(dir, `${hash}.node`);
    }
    const m = { exports: {} as Record<string, (...a: unknown[]) => unknown> };
    process.dlopen(m, out);
    mod = m.exports;
    pathOf.set(mod, out);
    loaded.set(hash, mod);
  }
  progOf.set(mod, mod.init!(host) as number);
  return mod;
}
