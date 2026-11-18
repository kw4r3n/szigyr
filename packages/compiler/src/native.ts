// Builds the C translation unit into a Node-API addon with the installed `cc` and loads it (D101). No node-gyp, no npm dependency.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_NAME } from "./names.ts";

export const CFLAGS = ["-std=gnu11", "-O2", "-ffp-contract=off", "-fno-fast-math", "-fwrapv", "-fexcess-precision=standard", "-falign-loops=32", "-shared", "-fPIC", "-w"];

/** Error of the C toolchain (missing compiler or headers, compile failure): a CLI / internal error, not a diagnostic. */
export class CBuildError extends Error {
  constructor(msg: string) { super(msg); this.name = "CBuildError"; }
}

const loaded = new Map<string, Record<string, (...a: unknown[]) => unknown>>();

/** Compiles (cached by source hash) and loads the addon; `host` is passed to its `init`. */
export function loadNative(c: string, host: object): Record<string, (...a: unknown[]) => unknown> {
  const inc = resolve(process.execPath, "../../include/node");
  if (!existsSync(join(inc, "node_api.h"))) throw new CBuildError(`C backend: Node-API headers not found at ${inc}`);
  const hash = createHash("sha256").update(c).update(CFLAGS.join(" ")).update(process.version).digest("hex").slice(0, 24);
  let mod = loaded.get(hash);
  if (!mod) {
    // A per-user cache: a loaded addon runs native code, so the directory must be ours and closed to others.
    const dir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), `${CLI_NAME}-native`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = statSync(dir);
    if ((process.getuid && st.uid !== process.getuid()) || (st.mode & 0o022)) throw new CBuildError(`C backend: cache directory ${dir} is not private to this user`);
    const out = join(dir, `${hash}.node`);
    if (!existsSync(out)) {
      const src = join(dir, `${hash}.c`);
      writeFileSync(src, c);
      const tmp = `${out}.${process.pid}.tmp`;
      try { execFileSync(process.env.CC ?? "cc", [...CFLAGS, `-I${inc}`, src, "-o", tmp, "-lm"], { stdio: ["ignore", "ignore", "pipe"] }); }
      catch (e) {
        const err = e as { code?: string; stderr?: Buffer };
        throw new CBuildError(err.code === "ENOENT" ? "C backend: no C compiler ('cc') found" : `C backend: compiling ${src} failed:\n${err.stderr?.toString() ?? String(e)}`);
      }
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
