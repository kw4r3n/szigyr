// Platform-neutral JS <-> Wasm runtime bridge (Q280, Q281). Zero Node imports: runs identically in Node, browsers, and Web Workers.
import type { ElemKind, NATIVE_HOST } from "./collections.ts";
import { isTrap, type Pos } from "./trap.ts";

export interface WasmAudioSpec { init: string; render: string; free: string }
export interface WasmMeta {
  files: string[];
  poss: [number, number, number][];
  lits: string[];
  fns: Record<string, { nargs: number; isVoid: boolean }>;
  audio?: Record<string, WasmAudioSpec>;
}

export type WasmHost = typeof NATIVE_HOST;

interface WasmExports {
  memory: WebAssembly.Memory;
  __stack_pointer: WebAssembly.Global;
  sts_alloc(n: number): number;
  sts_dealloc(p: number): void;
  sts_empty_ptr(): number;
  sts_get_depth(): number;
  sts_set_depth(d: number): void;
  sts_defer_enter(): number;
  sts_defer_leave(prev: number): void;
  sts_nvecs_get(): number;
  sts_npools_get(): number;
  sts_narenas_get(): number;
  sts_sync_frame(v0: number, p0: number, a0: number): void;
  sts_run_wb(id: number, fr: number): void;
  [k: string]: unknown;
}

interface Frame {
  vals: unknown[];
  bufMap: Map<ArrayBufferLike, { ptr: number; wbRange: () => [number, number] }>;
  slicePins: { ab: ArrayBufferLike; byteOff: number; byteLen: number; ptr: number }[];
  allocs: number[];
  arenaNotes: Map<object, { off: number; desc: string }[]>;
  wb: { id: number; fr: number } | undefined;
}

// AudioWorkletGlobalScope in Chromium lacks TextDecoder, so provide a UTF-8 fallback.
const DEC = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
function decodeUtf8(u8: Uint8Array): string {
  if (DEC) return DEC.decode(u8);
  let s = "", i = 0;
  while (i < u8.length) {
    const b = u8[i++]!;
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xe0) s += String.fromCharCode(((b & 0x1f) << 6) | (u8[i++]! & 0x3f));
    else if (b < 0xf0) s += String.fromCharCode(((b & 0x0f) << 12) | ((u8[i++]! & 0x3f) << 6) | (u8[i++]! & 0x3f));
    else {
      const cp = (((b & 0x07) << 18) | ((u8[i++]! & 0x3f) << 12) | ((u8[i++]! & 0x3f) << 6) | (u8[i++]! & 0x3f)) - 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return s;
}
const isSabBuf = (b: ArrayBufferLike): boolean => typeof SharedArrayBuffer !== "undefined" && b instanceof SharedArrayBuffer;

function createBridge(meta: WasmMeta, host: WasmHost): {
  imports: WebAssembly.Imports;
  attach(instance: WebAssembly.Instance): Record<string, (...a: unknown[]) => unknown>;
} {
  let exp!: WasmExports;
  let mem!: WebAssembly.Memory;
  let curBuf: ArrayBufferLike | null = null;
  let curU8!: Uint8Array;
  let curI32!: Int32Array;
  let curU32!: Uint32Array;
  let curDv!: DataView;

  const syncMem = (): void => {
    const b = mem.buffer;
    if (curBuf === b) return;
    curBuf = b;
    curU8 = new Uint8Array(b);
    curI32 = new Int32Array(b);
    curU32 = new Uint32Array(b);
    curDv = new DataView(b);
  };

  const frames: Frame[] = [];
  const cur = (): Frame => frames[frames.length - 1]!;
  const pushVal = (v: unknown): number => { const xs = cur().vals; xs.push(v); return xs.length - 1; };
  const pinned: ({ sab: ArrayBufferLike; atomic: boolean; cap: number; pos: Int32Array; u8: Uint8Array; onPush?: (b: Uint8Array) => void } | null)[] = [];

  const cstr = (ptr: number): string => {
    syncMem();
    const start = ptr >>> 0;
    let end = start;
    while (curU8[end] !== 0) end++;
    return decodeUtf8(curU8.subarray(start, end));
  };

  const posOf = (pos: number): Pos | undefined => {
    const e = pos >= 0 ? meta.poss[pos] : undefined;
    return e ? { file: meta.files[e[0]] ?? "", line: e[1], col: e[2] } : undefined;
  };
  const trapAt = (code: number, pos: number): never => {
    const p = posOf(pos);
    return host.trap(code, p?.file ?? "", p?.line ?? 0, p?.col ?? 0);
  };

  const pinBuffer = (
    ab: ArrayBufferLike,
    initOff: number,
    initLen: number,
    wbRange: () => [number, number],
    pos = -1,
    zeroTail = false,
  ): number => {
    const f = cur();
    const hit = f.bufMap.get(ab);
    if (hit) return hit.ptr;
    const total = ab.byteLength;
    if (total === 0) return exp.sts_empty_ptr() >>> 0;
    const ptr = exp.sts_alloc(total) >>> 0;
    if (ptr === 0) trapAt(6, pos);
    f.allocs.push(ptr);
    syncMem();
    if (initLen > 0) curU8.set(new Uint8Array(ab, initOff, initLen), ptr + initOff);
    if (zeroTail) {
      if (initOff > 0) curU8.fill(0, ptr, ptr + initOff);
      const end = initOff + initLen;
      if (end < total) curU8.fill(0, ptr + end, ptr + total);
    }
    f.bufMap.set(ab, { ptr, wbRange });
    return ptr;
  };

  const pinSlice = (ab: ArrayBufferLike, byteOff: number, byteLen: number, pos = -1): number => {
    const f = cur();
    const hit = f.bufMap.get(ab);
    if (hit) return (hit.ptr + byteOff) >>> 0;
    if (byteLen === 0) return exp.sts_empty_ptr() >>> 0;
    const ptr = exp.sts_alloc(byteLen) >>> 0;
    if (ptr === 0) trapAt(6, pos);
    f.allocs.push(ptr);
    syncMem();
    curU8.set(new Uint8Array(ab, byteOff, byteLen), ptr);
    f.slicePins.push({ ab, byteOff, byteLen, ptr });
    return ptr;
  };

  const imports: WebAssembly.Imports = {
    env: {
      sts_trap: (code: number, pos: number): never => trapAt(code, pos),
      sts_fail: (msgPtr: number): never => { throw new Error(cstr(msgPtr)); },
      sts_fmod: (a: number, b: number): number => a % b,

      sts_get: (oH: number, kPtr: number): number => pushVal((cur().vals[oH] as Record<string, unknown>)[cstr(kPtr)]),
      sts_set: (oH: number, kPtr: number, vH: number): void => {
        const f = cur();
        (f.vals[oH] as Record<string, unknown>)[cstr(kPtr)] = f.vals[vH];
      },
      sts_mkobj: (): number => pushVal({}),
      sts_num: (vH: number): number => cur().vals[vH] as number,
      sts_i64: (vH: number): bigint => cur().vals[vH] as bigint,
      sts_u64: (vH: number): bigint => BigInt.asIntN(64, cur().vals[vH] as bigint),
      sts_bool: (vH: number): number => (cur().vals[vH] ? 1 : 0),
      sts_mknum: (d: number): number => pushVal(d),
      sts_mki64: (x: bigint): number => pushVal(x),
      sts_mku64: (x: bigint): number => pushVal(BigInt.asUintN(64, x)),
      sts_mkbool: (b: number): number => pushVal(b !== 0),
      sts_mknull: (): number => pushVal(null),
      sts_isnull: (vH: number): number => (cur().vals[vH] === null ? 1 : 0),
      sts_mklit: (k: number): number => pushVal(meta.lits[k]),
      sts_lit_in: (vH: number): number => {
        const idx = meta.lits.indexOf(cur().vals[vH] as string);
        if (idx < 0) throw new Error("unknown string literal");
        return idx;
      },
      sts_callm: (oH: number, mPtr: number, n: number, argsPtr: number): number => {
        const f = cur();
        const obj = f.vals[oH] as Record<string, (...a: unknown[]) => unknown>;
        const m = cstr(mPtr);
        syncMem();
        const args: unknown[] = [];
        const base = argsPtr >>> 2;
        for (let i = 0; i < (n >>> 0); i++) args.push(f.vals[curI32[base + i]!]);
        return pushVal(obj[m]!(...args));
      },

      sts_reg_wb: (id: number, frPtr: number): void => { cur().wb = { id, fr: frPtr >>> 0 }; },
      sts_clear_wb: (): void => { cur().wb = undefined; },
      sts_box_ref: (oH: number): number => {
        const r = cur().vals[oH] as { sab: ArrayBufferLike; cap: number; shared?: { onPush?: (b: Uint8Array) => void } };
        const sab = r.sab;
        let idx = pinned.indexOf(null);
        const slot = { sab, atomic: isSabBuf(sab), cap: r.cap, pos: new Int32Array(sab, 0, 2), u8: new Uint8Array(sab), onPush: r.shared?.onPush };
        if (idx < 0) { idx = pinned.length; pinned.push(slot); } else pinned[idx] = slot;
        return -(idx + 1);
      },
      sts_box_unref: (h: number): number => {
        if (h < 0) pinned[~h] = null;
        return 0;
      },

      sts_vec_in: (oH: number, _es: number, descPtr: number, out3Ptr: number): void => {
        const vec = cur().vals[oH] as { buf: unknown; len: number };
        if (!ArrayBuffer.isView(vec.buf)) host.adopt(vec as never, cstr(descPtr) as ElemKind);
        const esU = _es >>> 0;
        const view = vec.buf as ArrayBufferView & { length: number };
        const initLen = Math.min((vec.len >>> 0) * esU, view.byteLength);
        const ptr = pinBuffer(view.buffer, view.byteOffset, initLen, () => {
          const curView = vec.buf as ArrayBufferView;
          return [curView.byteOffset, Math.min((vec.len >>> 0) * esU, curView.byteLength)];
        });
        syncMem();
        const cap = Math.floor(view.byteLength / esU);
        const base = out3Ptr >>> 2;
        curU32[base] = (ptr + view.byteOffset) >>> 0;
        curU32[base + 1] = vec.len >>> 0;
        curU32[base + 2] = Math.min(cap, 0xffffffff) >>> 0;
      },
      sts_vec_create: (allocH: number, cap: number, elemPtr: number, pos: number): number => {
        let v: unknown;
        try { v = host.create(cur().vals[allocH], cap >>> 0, cstr(elemPtr) as ElemKind); }
        catch (e) { if (isTrap(e)) throw e; trapAt(6, pos); }
        return pushVal(v);
      },
      sts_vec_grow: (oH: number, oldDataPtr: number, newCap: number, curLen: number, esize: number, pos: number, out2Ptr: number): void => {
        const f = cur();
        const vec = f.vals[oH] as { buf: ArrayBufferView; len: number };
        const oldView = vec.buf;
        const oldAb = oldView.buffer;
        const lenU = curLen >>> 0, esU = esize >>> 0, capU = newCap >>> 0, oldPtrU = oldDataPtr >>> 0;
        if (lenU > 0) {
          syncMem();
          const bytes = lenU * esU;
          new Uint8Array(oldAb, oldView.byteOffset, bytes).set(curU8.subarray(oldPtrU, oldPtrU + bytes));
        }
        f.bufMap.delete(oldAb);
        try { host.reserve(vec as never, capU, lenU); }
        catch (e) { if (isTrap(e)) throw e; trapAt(6, pos); }
        const newView = vec.buf;
        const initLen = Math.min(lenU * esU, newView.byteLength);
        const newPtr = pinBuffer(
          newView.buffer,
          newView.byteOffset,
          initLen,
          () => [newView.byteOffset, Math.min((vec.len >>> 0) * esU, newView.byteLength)],
          pos,
        );
        syncMem();
        const base = out2Ptr >>> 2;
        curU32[base] = (newPtr + newView.byteOffset) >>> 0;
        curU32[base + 1] = capU;
      },
      sts_vec_sync: (oH: number, len: number): void => {
        (cur().vals[oH] as { len: number }).len = len >>> 0;
      },
      sts_slice_in: (oH: number, es: number, descPtr: number, out2Ptr: number): void => {
        const o = cur().vals[oH] as Record<string, unknown>;
        const esU = es >>> 0;
        if (!("off" in o)) {
          const vec = o as { buf: unknown; len: number };
          if (!ArrayBuffer.isView(vec.buf)) host.adopt(vec as never, cstr(descPtr) as ElemKind);
          const view = vec.buf as ArrayBufferView;
          const byteLen = Math.min((vec.len >>> 0) * esU, view.byteLength);
          const ptr = pinSlice(view.buffer, view.byteOffset, byteLen);
          syncMem();
          const base = out2Ptr >>> 2;
          curU32[base] = ptr >>> 0;
          curU32[base + 1] = vec.len >>> 0;
          return;
        }
        if (!ArrayBuffer.isView(o.buf)) host.adopt(o as never, cstr(descPtr) as ElemKind);
        const view = o.buf as ArrayBufferView;
        const boff = typeof o.boff === "number" ? o.boff : 0;
        const off = (o.off as number) >>> 0;
        const len = (o.length as number) >>> 0;
        const byteOff = view.byteOffset + boff + off * esU;
        const byteLen = len * esU;
        const ptr = pinSlice(view.buffer, byteOff, byteLen);
        syncMem();
        const base = out2Ptr >>> 2;
        curU32[base] = ptr >>> 0;
        curU32[base + 1] = len;
      },

      sts_pool_in: (oH: number, _es: number, descPtr: number, u7Ptr: number, d2Ptr: number): void => {
        const p = cur().vals[oH] as {
          buf: unknown; gens: Uint32Array; occ: Uint8Array; nextFree: Int32Array;
          len: number; capacity: number; id: number; freeHead: number; nextFresh: number;
        };
        if (!ArrayBuffer.isView(p.buf)) host.adoptPool(p as never, cstr(descPtr) as ElemKind);
        const esU = _es >>> 0;
        const view = p.buf as ArrayBufferView;
        const pData = pinBuffer(
          view.buffer,
          view.byteOffset,
          Math.min((p.nextFresh >>> 0) * esU, view.byteLength),
          () => [view.byteOffset, Math.min((p.nextFresh >>> 0) * esU, view.byteLength)],
        ) + view.byteOffset;
        const pGens = pinBuffer(
          p.gens.buffer,
          p.gens.byteOffset,
          Math.min((p.nextFresh >>> 0) * 4, p.gens.byteLength),
          () => [p.gens.byteOffset, Math.min((p.nextFresh >>> 0) * 4, p.gens.byteLength)],
          -1,
          true,
        ) + p.gens.byteOffset;
        const pOcc = pinBuffer(
          p.occ.buffer,
          p.occ.byteOffset,
          Math.min(p.nextFresh >>> 0, p.occ.byteLength),
          () => [p.occ.byteOffset, Math.min(p.nextFresh >>> 0, p.occ.byteLength)],
          -1,
          true,
        ) + p.occ.byteOffset;
        const pNext = pinBuffer(
          p.nextFree.buffer,
          p.nextFree.byteOffset,
          Math.min((p.nextFresh >>> 0) * 4, p.nextFree.byteLength),
          () => [p.nextFree.byteOffset, Math.min((p.nextFresh >>> 0) * 4, p.nextFree.byteLength)],
        ) + p.nextFree.byteOffset;
        syncMem();
        const base = u7Ptr >>> 2;
        curU32[base] = pData >>> 0;
        curU32[base + 1] = pGens >>> 0;
        curU32[base + 2] = pOcc >>> 0;
        curU32[base + 3] = pNext >>> 0;
        curU32[base + 4] = p.len >>> 0;
        curU32[base + 5] = p.capacity >>> 0;
        curU32[base + 6] = p.id >>> 0;
        curDv.setFloat64(d2Ptr >>> 0, p.freeHead, true);
        curDv.setFloat64((d2Ptr >>> 0) + 8, p.nextFresh, true);
      },
      sts_pool_create: (allocH: number, cap: number, elemPtr: number, pos: number): number => {
        let p: unknown;
        try { p = host.createPool(cur().vals[allocH], cap >>> 0, cstr(elemPtr) as ElemKind); }
        catch (e) { if (isTrap(e)) throw e; trapAt(6, pos); }
        return pushVal(p);
      },
      sts_pool_sync: (oH: number, len: number, freeHead: number, nextFresh: number): void => {
        const p = cur().vals[oH] as { len: number; freeHead: number; nextFresh: number };
        p.len = len >>> 0; p.freeHead = freeHead; p.nextFresh = nextFresh;
      },

      sts_arena_in: (oH: number, u4Ptr: number): void => {
        const a = cur().vals[oH] as { buf: Uint8Array; used: number; gen: number };
        const ptr = pinBuffer(
          a.buf.buffer,
          a.buf.byteOffset,
          Math.min(a.used >>> 0, a.buf.byteLength),
          () => [a.buf.byteOffset, Math.min(a.used >>> 0, a.buf.byteLength)],
        );
        syncMem();
        const base = u4Ptr >>> 2;
        curU32[base] = (ptr + a.buf.byteOffset) >>> 0;
        curU32[base + 1] = a.buf.length >>> 0;
        curU32[base + 2] = a.used >>> 0;
        curU32[base + 3] = a.gen >>> 0;
      },
      sts_arena_create: (allocH: number, bytes: number, pos: number): number => {
        let a: unknown;
        try { a = host.createArena(cur().vals[allocH], bytes >>> 0); }
        catch (e) { if (isTrap(e)) throw e; trapAt(6, pos); }
        return pushVal(a);
      },
      sts_arena_note: (oH: number, off: number, descPtr: number): void => {
        const f = cur(), a = f.vals[oH] as object;
        const offU = off >>> 0, desc = cstr(descPtr);
        let notes = f.arenaNotes.get(a);
        if (!notes) f.arenaNotes.set(a, notes = []);
        if (notes.length && notes[notes.length - 1]!.off === offU) notes[notes.length - 1]!.desc = desc;
        else notes.push({ off: offU, desc });
      },
      sts_arena_reset_notes: (oH: number): void => {
        const f = cur();
        f.arenaNotes.delete(f.vals[oH] as object);
      },
      sts_arena_sync: (oH: number, used: number, gen: number): void => {
        const f = cur();
        const a = f.vals[oH] as { used: number; gen: number; noteC: (off: number, desc: string) => void };
        a.used = used >>> 0; a.gen = gen >>> 0;
        const notes = f.arenaNotes.get(a);
        if (notes) {
          for (const n of notes) a.noteC(n.off, n.desc);
          f.arenaNotes.delete(a);
        }
      },

      sts_ring_in: (oH: number, descPtr: number): number => {
        const r = cur().vals[oH] as { sab: SharedArrayBuffer | null; cap: number };
        if (!r.sab) host.adoptRing(r as never, cstr(descPtr) as ElemKind);
        return r.cap >>> 0;
      },
      sts_ring_create: (allocH: number, cap: number, elemPtr: number, pos: number): number => {
        let r: unknown;
        try { r = host.createRing(cur().vals[allocH], cap >>> 0, cstr(elemPtr) as ElemKind); }
        catch (e) { if (isTrap(e)) throw e; trapAt(6, pos); }
        return pushVal(r);
      },
      sts_ring_push: (oH: number, srcPtr: number, esize: number): number => {
        const p = oH < 0 ? pinned[~oH]! : undefined;
        const r = p ?? (cur().vals[oH] as { sab: ArrayBufferLike; cap: number; shared?: { onPush?: (b: Uint8Array) => void } });
        const sab = r.sab, cap = r.cap, es = esize >>> 0, ptr = srcPtr >>> 0;
        const atomic = p ? p.atomic : isSabBuf(sab);
        const pos = p ? p.pos : new Int32Array(sab, 0, 2);
        const tail = (atomic ? Atomics.load(pos, 1) : pos[1]!) >>> 0;
        const head = (atomic ? Atomics.load(pos, 0) : pos[0]!) >>> 0;
        if (((tail - head) >>> 0) >= cap) return 0;
        syncMem();
        const off = 8 + (tail & (cap - 1)) * es;
        const dst = p ? p.u8.subarray(off, off + es) : new Uint8Array(sab, off, es);
        dst.set(curU8.subarray(ptr, ptr + es));
        if (atomic) Atomics.store(pos, 1, (tail + 1) | 0);
        else {
          pos[1] = (tail + 1) | 0;
          const cb = p ? p.onPush : (r as { shared?: { onPush?: (b: Uint8Array) => void } }).shared?.onPush;
          if (cb) cb(dst.slice());
        }
        return 1;
      },
      sts_ring_pop: (oH: number, dstPtr: number, esize: number): number => {
        const p = oH < 0 ? pinned[~oH]! : undefined;
        const r = p ?? (cur().vals[oH] as { sab: ArrayBufferLike; cap: number });
        const sab = r.sab, cap = r.cap, es = esize >>> 0, ptr = dstPtr >>> 0;
        const atomic = p ? p.atomic : isSabBuf(sab);
        const pos = p ? p.pos : new Int32Array(sab, 0, 2);
        const head = (atomic ? Atomics.load(pos, 0) : pos[0]!) >>> 0;
        const tail = (atomic ? Atomics.load(pos, 1) : pos[1]!) >>> 0;
        if (head === tail) return 0;
        syncMem();
        const off = 8 + (head & (cap - 1)) * es;
        const src = p ? p.u8.subarray(off, off + es) : new Uint8Array(sab, off, es);
        curU8.set(src, ptr);
        if (atomic) Atomics.store(pos, 0, (head + 1) | 0);
        else pos[0] = (head + 1) | 0;
        return 1;
      },
    },
  };

  const attach = (instance: WebAssembly.Instance): Record<string, (...a: unknown[]) => unknown> => {
    exp = instance.exports as unknown as WasmExports;
    mem = exp.memory;
    const sp = exp.__stack_pointer;
    const api: Record<string, (...a: unknown[]) => unknown> = {
      sts_poll: () => null,
      sts_finish: () => null,
    };
    for (const [name, spec] of Object.entries(meta.fns)) {
      const fn = exp[`w_${name}`] as (...args: number[]) => number | void;
      api[name] = (...args: unknown[]): unknown => {
        const f: Frame = { vals: [undefined], bufMap: new Map(), slicePins: [], allocs: [], arenaNotes: new Map(), wb: undefined };
        const argHandles = args.slice(0, spec.nargs).map((v) => { f.vals.push(v); return f.vals.length - 1; });
        const v0 = exp.sts_nvecs_get() >>> 0;
        const p0 = exp.sts_npools_get() >>> 0;
        const a0 = exp.sts_narenas_get() >>> 0;
        const savedDepth = exp.sts_get_depth();
        const savedDefer = exp.sts_defer_enter();
        const savedSp = sp.value as number;
        frames.push(f);
        exp.sts_set_depth(0);
        let res: unknown;
        try {
          res = fn(...argHandles);
        } finally {
          try {
            try {
              // Run any un-unwound defers while stack slots above savedSp remain intact.
              exp.sts_defer_leave(savedDefer);
            } finally {
              sp.value = savedSp;
              if (f.wb) {
                const { id, fr } = f.wb;
                f.wb = undefined;
                exp.sts_run_wb(id, fr);
              }
              exp.sts_sync_frame(v0, p0, a0);
              syncMem();
              for (const [ab, { ptr, wbRange }] of f.bufMap) {
                const [off, len] = wbRange();
                if (len > 0) new Uint8Array(ab, off, len).set(curU8.subarray(ptr + off, ptr + off + len));
              }
              for (const sPin of f.slicePins) {
                if (sPin.byteLen > 0) new Uint8Array(sPin.ab, sPin.byteOff, sPin.byteLen).set(curU8.subarray(sPin.ptr, sPin.ptr + sPin.byteLen));
              }
              for (const ptr of f.allocs) exp.sts_dealloc(ptr);
            }
          } finally {
            exp.sts_set_depth(savedDepth);
            frames.pop();
          }
        }
        return spec.isVoid ? undefined : f.vals[res as number];
      };
    }
    for (const [id, spec] of Object.entries(meta.audio ?? {})) {
      const initFn = exp[spec.init] as (h: number) => number;
      const renderFn = exp[spec.render] as (box: number, out: number, samples: number, frames: number) => void;
      const freeFn = exp[spec.free] as (box: number) => void;
      let outPtr = 0, outCap = 0;
      const runAudio = <T>(fn: () => T): T => {
        const f: Frame = { vals: [undefined], bufMap: new Map(), slicePins: [], allocs: [], arenaNotes: new Map(), wb: undefined };
        const v0 = exp.sts_nvecs_get() >>> 0, p0 = exp.sts_npools_get() >>> 0, a0 = exp.sts_narenas_get() >>> 0;
        const savedDepth = exp.sts_get_depth(), savedDefer = exp.sts_defer_enter(), savedSp = sp.value as number;
        frames.push(f); exp.sts_set_depth(0);
        try { return fn(); } finally {
          try {
            exp.sts_defer_leave(savedDefer);
          } finally {
            sp.value = savedSp;
            exp.sts_sync_frame(v0, p0, a0);
            for (const ptr of f.allocs) exp.sts_dealloc(ptr);
            exp.sts_set_depth(savedDepth);
            frames.pop();
          }
        }
      };
      (api as Record<string, unknown>)[`sts_audio_${id}`] = {
        init(state: unknown): number {
          return runAudio(() => {
            const f = cur(); f.vals.push(state);
            return initFn(f.vals.length - 1) >>> 0;
          });
        },
        render(boxPtr: number, outF32: Float32Array, nFrames: number): void {
          const bytes = outF32.byteLength;
          if (bytes > outCap) {
            if (outPtr) exp.sts_dealloc(outPtr);
            outPtr = exp.sts_alloc(bytes) >>> 0;
            if (!outPtr) throw new Error("wasm audio: out of memory");
            outCap = bytes;
          }
          if (bytes) { syncMem(); curU8.fill(0, outPtr, outPtr + bytes); }
          runAudio(() => { renderFn(boxPtr >>> 0, outPtr, outF32.length >>> 0, nFrames >>> 0); });
          if (bytes) { syncMem(); outF32.set(new Float32Array(curBuf!, outPtr, outF32.length)); }
        },
        free(boxPtr: number): void {
          if (boxPtr) runAudio(() => { freeFn(boxPtr >>> 0); });
          if (outPtr) { exp.sts_dealloc(outPtr); outPtr = 0; outCap = 0; }
        },
      };
    }
    return api;
  };

  return { imports, attach };
}

/** Instantiates a compiled Wasm module asynchronously (works in both Node and browser for modules of any size). */
export async function instantiateWasmAsync(
  bytesOrModule: BufferSource | WebAssembly.Module,
  meta: WasmMeta,
  host: WasmHost,
): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const b = createBridge(meta, host);
  const inst = bytesOrModule instanceof WebAssembly.Module
    ? await WebAssembly.instantiate(bytesOrModule, b.imports)
    : (await WebAssembly.instantiate(bytesOrModule, b.imports)).instance;
  return b.attach(inst);
}

/** Synchronous instantiation for test/Node callers where module size fits sync compilation limits. */
export function instantiateWasm(
  bytes: BufferSource,
  meta: WasmMeta,
  host: WasmHost,
): Record<string, (...a: unknown[]) => unknown> {
  const b = createBridge(meta, host);
  return b.attach(new WebAssembly.Instance(new WebAssembly.Module(bytes), b.imports));
}
