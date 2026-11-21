// Browser Web Worker isolate host (SPEC §15.2, zero Node imports).
import { getHostIdSab } from "./collections.ts";
import { asTrap, noteIsolateTrap, type ForeignTrap } from "./trap.ts";
import { Port, type Channel, type Envelope } from "./port.ts";

export interface BrowserIsolateConfig {
  workerUrl: string | URL;
  wasmUrl?: string | null;
  wasmBytes?: Uint8Array | null;
}

let browserCfg: BrowserIsolateConfig | undefined;
export function setBrowserIsolateConfig(cfg: BrowserIsolateConfig | undefined): void { browserCfg = cfg; }

const liveWorkers = new Set<Worker>();
let nextWorkerPrefix = 1;

/** §15.2: starts a browser module Web Worker isolate and returns its Port without waiting. */
export function spawnIsolate(path: string, name: string): Port {
  const cfg = browserCfg;
  if (!cfg) throw new Error("spawnIsolate: browser isolate config not installed");
  const w = new Worker(cfg.workerUrl, { type: "module" });
  liveWorkers.add(w);
  let onMsg: ((m: Envelope) => void) | undefined;
  let gone: (() => void) | undefined;
  let closed = false;
  w.addEventListener("message", (ev: MessageEvent) => {
    const m = ev.data as Envelope;
    if (m && typeof m === "object" && "c" in m) { liveWorkers.delete(w); gone?.(); return; }
    onMsg?.(m);
  });
  w.addEventListener("error", (ev: ErrorEvent) => {
    liveWorkers.delete(w);
    noteIsolateTrap({ code: "T006", message: ev.message || "worker error" });
    gone?.();
  });
  const ch: Channel = {
    post: (msg, transfer) => { if (!closed) w.postMessage(msg, (transfer ?? []) as Transferable[]); },
    onMessage: (f) => { onMsg = f; },
    onClose: (f) => { gone = f; },
    close: () => { closed = true; },
  };
  w.postMessage({ init: { path, name, wasmUrl: cfg.wasmUrl ?? null, wasmBytes: cfg.wasmBytes ?? null, idSab: getHostIdSab(), workerPrefix: nextWorkerPrefix++ } });
  return new Port(ch);
}

/** Q207: terminates still-running browser Workers when `main` ends. */
export async function stopIsolates(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
  for (const w of liveWorkers) w.terminate();
  liveWorkers.clear();
}

/** Worker-side entry runner: creates the Port over DedicatedWorkerGlobalScope and forwards traps. */
export function isolateMainBrowser(f: (port: Port) => unknown, queued?: Envelope[]): void {
  const g = globalThis as unknown as {
    addEventListener(type: string, fn: (ev: MessageEvent) => void): void;
    postMessage(msg: unknown, transfer?: Transferable[]): void;
    close(): void;
  };
  let onMsg: ((m: Envelope) => void) | undefined;
  g.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as Record<string, unknown>;
    if (d && typeof d === "object" && !("init" in d)) onMsg?.(d as Envelope);
  });
  const ch: Channel = {
    post: (msg, transfer) => { g.postMessage(msg, (transfer ?? []) as Transferable[]); },
    onMessage: (f2) => {
      onMsg = f2;
      if (queued) for (const m of queued.splice(0)) f2(m);
    },
    onClose: () => {},
    close: () => { try { g.close(); } catch { /* closed */ } },
  };
  const port = new Port(ch);
  void (async () => {
    try {
      await f(port);
    } catch (e) {
      const t = asTrap(e);
      const ft: ForeignTrap = t ? { code: t.code, ...(t.pos ? { file: t.pos.file, line: t.pos.line, col: t.pos.col } : {}) } : { code: "T006", message: String(e) };
      try { g.postMessage({ t: ft }); } catch { /* main gone */ }
    }
    port.close();
  })();
}
