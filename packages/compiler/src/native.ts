// Builds the C translation unit into a Node-API addon with the installed `cc` and loads it (D101). No node-gyp, no npm dependency.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { threadId } from "node:worker_threads";
import { ccCommand, splitFlags } from "./cdecl.ts";
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

function touch(p: string): void { const now = new Date(); try { utimesSync(p, now, now); } catch { /* raced with a prune */ } }

/** D149: past ~500 entries, delete (also stale `.tmp*`) what has not been used for 7 days. Processes and isolate workers share the directory, so races are ignored. */
function prune(dir: string, keep: string): void {
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

/** Compiles (cached by source hash) and loads the addon; `host` is passed to its `init`. */
export function loadNative(c: string, host: object, pkgs: string[] = []): Record<string, (...a: unknown[]) => unknown> {
  const inc = resolve(process.execPath, "../../include/node");
  if (!existsSync(join(inc, "node_api.h"))) throw new CBuildError(`C backend: Node-API headers not found at ${inc}`);
  // §14.2: the `c:` declarations' packages contribute their cflags to the compile and their libs to the link.
  let pkgCflags: string[] = [], pkgLibs: string[] = [];
  if (pkgs.length) {
    try {
      pkgCflags = splitFlags(execFileSync("pkg-config", ["--cflags", "--", ...pkgs], { encoding: "utf8" }));
      pkgLibs = splitFlags(execFileSync("pkg-config", ["--libs", "--", ...pkgs], { encoding: "utf8" }));
    } catch { throw new CBuildError(`C backend: pkg-config could not resolve: ${pkgs.join(", ")}`); }
  }
  const [cc, ccArgs] = ccCommand();
  const hash = createHash("sha256").update(process.env.CC || "cc").update("\0").update(c).update("\0").update(CFLAGS.join(" ")).update("\0").update(pkgCflags.join(" ")).update("\0").update(pkgLibs.join(" ")).update("\0").update(process.version).digest("hex").slice(0, 24);
  let mod = loaded.get(hash);
  if (mod) touch(pathOf.get(mod)!); // a long-lived process keeps its entry fresh too (D149)
  else {
    // A per-user cache: a loaded addon runs native code, so the directory must be ours and closed to others.
    const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), `${CLI_NAME}-native`);
    let st;
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); st = statSync(dir); } catch (e) { throw new CBuildError(`C backend: cache directory ${dir} is not usable: ${(e as Error).message}`); } // D150
    if ((process.getuid && st.uid !== process.getuid()) || (st.mode & 0o022)) throw new CBuildError(`C backend: cache directory ${dir} is not private to this user`);
    const out = join(dir, `${hash}.node`);
    if (existsSync(out)) touch(out); // age = last use (D149)
    else {
      // Workers of one process share the pid, so the temporary names also carry the thread id (D111).
      const tmp = `${out}.${process.pid}.${threadId}.tmp`, src = `${tmp}.c`;
      writeFileSync(src, c);
      let ok = false;
      try {
        execFileSync(cc, [...ccArgs, ...CFLAGS, ...pkgCflags, `-I${inc}`, src, "-o", tmp, "-lm", ...pkgLibs], { stdio: ["ignore", "ignore", "pipe"] });
        renameSync(tmp, out);
        ok = true;
      } catch (e) {
        const err = e as { code?: string; stderr?: Buffer };
        throw new CBuildError(err.code === "ENOENT" ? `C backend: no C compiler ('${cc}') found` : `C backend: compiling ${src} failed:\n${err.stderr?.toString() ?? String(e)}`);
      } finally {
        rmSync(src, { force: true });
        if (!ok) rmSync(tmp, { force: true });
      }
      prune(dir, `${hash}.node`);
    }
    const m = { exports: {} as Record<string, (...a: unknown[]) => unknown> };
    process.dlopen(m, out);
    mod = m.exports;
    pathOf.set(mod, out);
    loaded.set(hash, mod);
  }
  mod.init!(host);
  return mod;
}
