import { readFileSync, writeFileSync } from "node:fs";
import { cast, err, isTrap, ok, readU8Slice, replaceU8Vec, spawnIsolate, type Result } from "../../runtime-js/src/index.ts";
import { ALLOC, type Alloc, type Audio, type AudioCallbackSpec, type AudioConfig, type AudioStream, type Clock, type Fs, type IoError, type Js, type JsError, type JsRef, type Log, type Random, type Spawn, type System } from "./types.ts";

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
  readBytes(path, dst) {
    try {
      const raw = readFileSync(path);
      if (raw.byteLength > 0xffffffff) return err({ code: "EFBIG", message: "file exceeds usize limit (4GiB)" });
      replaceU8Vec(dst, raw);
      return ok(raw.byteLength);
    } catch (e) { return err(ioError(e)); }
  },
  writeBytes(path, data) {
    try { writeFileSync(path, readU8Slice(data)); return ok(null); } catch (e) { return err(ioError(e)); }
  },
};

export const nodeSpawn: Spawn = {
  isolate: (path, name) => spawnIsolate(path, name),
};

const jsError = (e: unknown): JsError => ({
  code: e instanceof Error ? e.name : "Error",
  message: e instanceof Error ? e.message : String(e),
});
// Traps are not catchable from STS code (§8): they pass through the Js boundary.
const guard = <T>(f: () => T): Result<T, JsError> => { try { return ok(f()); } catch (e) { if (isTrap(e)) throw e; return err(jsError(e)); } };

export const nodeJs: Js = {
  call: (f, args) => guard(() => (f as (...a: JsRef[]) => JsRef)(...args)),
  new: (ctor, args) => guard(() => Reflect.construct(ctor as new (...a: JsRef[]) => JsRef, args)),
  invoke: (obj, method, args) => guard(() => {
    const f = (obj as Record<string, unknown>)[method];
    if (typeof f !== "function") throw new TypeError(`${method} is not a function`);
    return Reflect.apply(f, obj, args);
  }),
  get: (obj, key) => guard(() => (obj as Record<string, JsRef>)[key]),
  set: (obj, key, value) => guard(() => { (obj as Record<string, JsRef>)[key] = value; return null; }),
  object: (entries) => {
    const o: Record<string, JsRef> = {};
    for (const e of entries) Object.defineProperty(o, e.key, { value: e.value, enumerable: true, writable: true, configurable: true });
    return o;
  },
  await: async (v) => { try { return ok(await v); } catch (e) { if (isTrap(e)) throw e; return err(jsError(e)); } },
  decode: (v, desc) => cast(v, desc),
  encode: (v) => v,
  callback: (f, desc) => (...a: unknown[]): void => { f(cast(a[0], desc)); },
  fn: (f) => (...args: JsRef[]): JsRef => f(args),
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
  return { alloc: ALLOC, fs: nodeFs, clock: nodeClock, random: nodeRandom, log: createLog(stdout, stderr), js: nodeJs, spawn: nodeSpawn, audio: nodeAudio };
}
