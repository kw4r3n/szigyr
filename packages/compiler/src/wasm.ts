// Compiles strict / rt C translation units to freestanding Wasm via clang / lld and instantiates them (Q280, Q281).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
import { splitFlags } from "./cdecl.ts";
import { CLI_NAME } from "./names.ts";
import { CBuildError } from "./native.ts";
import { instantiateWasmAsync, type WasmHost, type WasmMeta } from "../../runtime-js/src/index.ts";

export const WASM_CFLAGS = [
  "-std=gnu11", "-O2", "-nostdlib", "-ffreestanding",
  "-ffp-contract=off", "-fno-fast-math", "-fwrapv", "-fexcess-precision=standard", "-w",
  "-Wl,--no-entry", "-Wl,--allow-undefined", "-Wl,--stack-first", "-Wl,-z,stack-size=1048576", "-Wl,--export=__stack_pointer",
];

const wasmCcEnv = (): string | undefined => process.env.SZIGYR_WASM_CC || process.env.STS_WASM_CC;

function wasmCommand(): [string, string[]] {
  const wasmCc = wasmCcEnv();
  if (wasmCc) {
    const [cmd = "clang", ...args] = splitFlags(wasmCc);
    const hasTarget = args.some((a) => a === "-target" || a.startsWith("-target=") || a === "--target" || a.startsWith("--target="));
    return [cmd, hasTarget ? args : ["--target=wasm32", ...args]];
  }
  return ["clang", ["--target=wasm32"]];
}

const compiled = new Map<string, Uint8Array>();

function touch(p: string): void { const now = new Date(); try { utimesSync(p, now, now); } catch { /* raced with a prune */ } }

function prune(dir: string, keep: string): void {
  try {
    const names = readdirSync(dir);
    if (names.length <= 500) return;
    const cutoff = Date.now() - 7 * 864e5;
    for (const n of names) {
      const p = join(dir, n);
      try { if (n !== keep && statSync(p).mtimeMs < cutoff) rmSync(p, { force: true }); } catch { /* gone already */ }
    }
  } catch { /* cache pruning is best-effort */ }
}

/** Compiles freestanding C source to Wasm binary bytes, cached on disk by source hash. */
export function compileWasm(c: string): Uint8Array {
  const [cc, ccArgs] = wasmCommand();
  const hash = createHash("sha256")
    .update(cc).update("\0").update(ccArgs.join(" ")).update("\0").update(WASM_CFLAGS.join(" ")).update("\0").update(c)
    .digest("hex").slice(0, 24);
  const memHit = compiled.get(hash);
  if (memHit) return memHit;

  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), `${CLI_NAME}-wasm`);
  let st;
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); st = statSync(dir); }
  catch (e) { throw new CBuildError(`Wasm backend: cache directory ${dir} is not usable: ${(e as Error).message}`); }
  if ((process.getuid && st.uid !== process.getuid()) || (st.mode & 0o022)) {
    throw new CBuildError(`Wasm backend: cache directory ${dir} is not private to this user`);
  }

  const out = join(dir, `${hash}.wasm`);
  if (existsSync(out)) {
    touch(out);
    const bytes = new Uint8Array(readFileSync(out));
    compiled.set(hash, bytes);
    return bytes;
  }

  const tmp = `${out}.${process.pid}.${threadId}.tmp`, src = `${tmp}.c`, wasmTmp = `${tmp}.wasm`;
  writeFileSync(src, c);
  let ok = false;
  try {
    try {
      execFileSync(cc, [...ccArgs, ...WASM_CFLAGS, src, "-o", wasmTmp], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      const err = e as { code?: string };
      if (!wasmCcEnv() && err.code === "ENOENT") {
        execFileSync("zig", ["cc", "-target", "wasm32-freestanding", ...WASM_CFLAGS, src, "-o", wasmTmp], { stdio: ["ignore", "ignore", "pipe"] });
      } else throw e;
    }
    renameSync(wasmTmp, out);
    ok = true;
  } catch (e) {
    const err = e as { code?: string; stderr?: Buffer };
    throw new CBuildError(err.code === "ENOENT"
      ? `Wasm backend: no wasm compiler ('${cc}' / 'zig') found`
      : `Wasm backend: compiling ${src} failed:\n${err.stderr?.toString() ?? String(e)}`);
  } finally {
    rmSync(src, { force: true });
    if (!ok) rmSync(wasmTmp, { force: true });
  }
  prune(dir, `${hash}.wasm`);
  const bytes = new Uint8Array(readFileSync(out));
  compiled.set(hash, bytes);
  return bytes;
}

/** Compiles (if uncached) and instantiates the Wasm module against `host`. */
export async function loadWasm(
  c: string,
  meta: WasmMeta,
  host: WasmHost,
): Promise<{ exports: Record<string, (...a: unknown[]) => unknown>; bytes: Uint8Array }> {
  const bytes = compileWasm(c);
  const exports = await instantiateWasmAsync(bytes as Uint8Array<ArrayBuffer>, meta, host);
  return { exports, bytes };
}
