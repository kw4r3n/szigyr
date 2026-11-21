import { readFileSync, writeFileSync } from "node:fs";
import { cast, err, isTrap, ok, type Result } from "../../runtime-js/src/index.ts";
import { ALLOC, type Alloc, type Audio, type AudioCallbackSpec, type AudioConfig, type AudioStream, type Clock, type Fs, type IoError, type Js, type JsError, type JsRef, type Log, type Random, type System } from "./types.ts";

export { ALLOC };

/** Q059: info -> stdout, warn / error -> stderr, each message + "\n", no prefix. */
export function createLog(stdout: (s: string) => void, stderr: (s: string) => void): Log {
  return { info: (m) => stdout(m + "\n"), warn: (m) => stderr(m + "\n"), error: (m) => stderr(m + "\n") };
}

export const nodeClock: Clock = {
  nowMs: () => Date.now(),
  sleep: (ms) => {
    const d = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 2147483647) : 0;
    return new Promise((r) => setTimeout(r, d));
  },
};
export const nodeRandom: Random = {
  nextF64: () => Math.random(),
  nextU32: () => Math.floor(Math.random() * 2 ** 32),
};

const ioError = (e: unknown): IoError => {
  const x = e as { code?: unknown; message?: unknown };
  return { code: typeof x.code === "string" ? x.code : "EIO", message: String(x.message ?? e) };
};
export const nodeFs: Fs = {
  readText(path) { try { return ok(readFileSync(path, "utf8")); } catch (e) { return err(ioError(e)); } },
  writeText(path, text) { try { writeFileSync(path, text); return ok(null); } catch (e) { return err(ioError(e)); } },
};

const jsError = (e: unknown): JsError => ({
  code: e instanceof Error ? e.name : "Error",
  message: e instanceof Error ? e.message : String(e),
});
// Traps are not catchable from STS code (§8): they pass through the Js boundary.
const guard = <T>(f: () => T): Result<T, JsError> => { try { return ok(f()); } catch (e) { if (isTrap(e)) throw e; return err(jsError(e)); } };

export const nodeJs: Js = {
  call: (f, args) => guard(() => (f as (...a: JsRef[]) => JsRef)(...args)),
  get: (obj, key) => guard(() => (obj as Record<string, JsRef>)[key]),
  await: async (v) => { try { return ok(await v); } catch (e) { if (isTrap(e)) throw e; return err(jsError(e)); } },
  decode: (v, desc) => cast(v, desc),
  encode: (v) => v,
  callback: (f, desc) => (...a: unknown[]): void => { f(cast(a[0], desc)); },
};

let registeredAudio: Audio = {
  async open(_c: AudioConfig, _s: unknown, _cb: AudioCallbackSpec): Promise<Result<AudioStream, IoError>> {
    return err({ code: "ENOSYS", message: "audio host not configured" });
  },
};
/** Compiler / CLI wires SDL3 audio implementation here so `std` stays Node-API-free. */
export function setNodeAudio(audio: Audio): void { registeredAudio = audio; }
export const nodeAudio: Audio = {
  open: (config, state, cb) => registeredAudio.open(config, state, cb),
};

export function createSystem(
  stdout: (s: string) => void = (s) => void process.stdout.write(s),
  stderr: (s: string) => void = (s) => void process.stderr.write(s),
): System {
  return { alloc: ALLOC, fs: nodeFs, clock: nodeClock, random: nodeRandom, log: createLog(stdout, stderr), js: nodeJs, audio: nodeAudio };
}
