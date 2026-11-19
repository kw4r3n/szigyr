// Builds the C translation unit into a Node-API addon with the installed `cc` and loads it (D101). No node-gyp, no npm dependency.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { threadId } from "node:worker_threads";
import { CLI_NAME } from "./names.ts";

export const CFLAGS = ["-std=gnu11", "-O2", "-ffp-contract=off", "-fno-fast-math", "-fwrapv", "-fexcess-precision=standard", "-falign-loops=32", "-shared", "-fPIC", "-w"];

/** Error of the C toolchain (missing compiler or headers, compile failure): a CLI / internal error, not a diagnostic. */
export class CBuildError extends Error {
  constructor(msg: string) { super(msg); this.name = "CBuildError"; }
}

const loaded = new Map<string, Record<string, (...a: unknown[]) => unknown>>();

/** Compiles (cached by source hash) and loads the addon; `host` is passed to its `init`. */
export function loadNative(c: string, host: object, pkgs: string[] = []): Record<string, (...a: unknown[]) => unknown> {
  const inc = resolve(process.execPath, "../../include/node");
  if (!existsSync(join(inc, "node_api.h"))) throw new CBuildError(`C backend: Node-API headers not found at ${inc}`);
  // §14.2: the `c:` declarations' packages contribute their cflags to the compile and their libs to the link.
  let pkgCflags: string[] = [], pkgLibs: string[] = [];
  if (pkgs.length) {
    try {
      pkgCflags = execFileSync("pkg-config", ["--cflags", ...pkgs], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
      pkgLibs = execFileSync("pkg-config", ["--libs", ...pkgs], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
    } catch { throw new CBuildError(`C backend: pkg-config could not resolve: ${pkgs.join(", ")}`); }
  }
  const hash = createHash("sha256").update(c).update(CFLAGS.join(" ")).update(pkgCflags.join(" ")).update(pkgLibs.join(" ")).update(process.version).digest("hex").slice(0, 24);
  let mod = loaded.get(hash);
  if (!mod) {
    // A per-user cache: a loaded addon runs native code, so the directory must be ours and closed to others.
    const dir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), `${CLI_NAME}-native`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = statSync(dir);
    if ((process.getuid && st.uid !== process.getuid()) || (st.mode & 0o022)) throw new CBuildError(`C backend: cache directory ${dir} is not private to this user`);
    const out = join(dir, `${hash}.node`);
    if (!existsSync(out)) {
      // Workers of one process share the pid, so the temporary names also carry the thread id (D111).
      const tmp = `${out}.${process.pid}.${threadId}.tmp`, src = `${tmp}.c`;
      writeFileSync(src, c);
      try { execFileSync(process.env.CC ?? "cc", [...CFLAGS, ...pkgCflags, `-I${inc}`, src, "-o", tmp, "-lm", ...pkgLibs], { stdio: ["ignore", "ignore", "pipe"] }); }
      catch (e) {
        const err = e as { code?: string; stderr?: Buffer };
        throw new CBuildError(err.code === "ENOENT" ? "C backend: no C compiler ('cc') found" : `C backend: compiling ${src} failed:\n${err.stderr?.toString() ?? String(e)}`);
      }
      renameSync(src, join(dir, `${hash}.c`));
      renameSync(tmp, out);
    }
    const m = { exports: {} as Record<string, (...a: unknown[]) => unknown> };
    process.dlopen(m, out);
    mod = m.exports;
    loaded.set(hash, mod);
  }
  mod.init!(host);
  return mod;
}
