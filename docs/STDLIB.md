# Szigyr Standard Library & Capability Reference

Full signatures and structural record definitions backing `docs/SPEC.md` (`szigyr://spec`) and machine catalog `szigyr://builtins`. Types marked *(managed)* trap/err `E4001`/`E4002` in `"use owned"` (`strict`) and `"use rt"` (`rt`); marked *(unsafe)* require `"use unsafe"`.

## 1. Structural Record & Union Aliases

- `IoError` / `CastError` / `JsError` = `{readonly code:string;readonly message:string}`
- `AudioConfig` = `{readonly sampleRate:u32;readonly channels:u32}`
- `DisplayConfig` = `{readonly title:string;readonly width:u32;readonly height:u32}`
- `DisplayColor` = `{readonly r:u8;readonly g:u8;readonly b:u8;readonly a:u8}`
- `DisplayEvent` =
  - `{readonly kind:"pointerDown";readonly x:f64;readonly y:f64;readonly button:u8}`
  - `|{readonly kind:"pointerMove";readonly x:f64;readonly y:f64;readonly buttons:u8}`
  - `|{readonly kind:"pointerUp";readonly x:f64;readonly y:f64;readonly button:u8}`
  - `|{readonly kind:"wheel";readonly x:f64;readonly y:f64;readonly dx:f64;readonly dy:f64}`
  - `|{readonly kind:"keyDown";readonly key:string;readonly repeat:boolean;readonly shift:boolean;readonly ctrl:boolean;readonly alt:boolean}`
  - `|{readonly kind:"keyUp";readonly key:string;readonly shift:boolean;readonly ctrl:boolean;readonly alt:boolean}`
  - `|{readonly kind:"close"}`
- `DirEntry` = `{readonly name:string;readonly kind:"file"|"dir"|"symlink"|"other"}`
- `FileStat` = `{readonly kind:"file"|"dir"|"symlink"|"other";readonly size:u64;readonly mtimeMs:f64}`
- `EnvVar` = `{readonly name:string;readonly value:string}`
- `ProcOptions` = `{readonly cwd:string|null;readonly env:ReadonlyArray<EnvVar>;readonly stdin:string|null;readonly timeoutMs:u32|null}`
- `ProcOutput` = `{readonly exitCode:i32;readonly stdout:string;readonly stderr:string;readonly timedOut:boolean}`
- `ProcRequest` = `{readonly program:string;readonly args:Array<string>;readonly cwd:string|null;readonly env:Array<EnvVar>;readonly stdin:string|null;readonly timeoutMs:u32|null}`
- `HttpHeader` = `{readonly name:string;readonly value:string}`
- `HttpRequestInit` = `{readonly method:string;readonly headers:ReadonlyArray<HttpHeader>;readonly body:string|null;readonly timeoutMs:u32|null}`
- `HttpResponse` = `{readonly status:u16;readonly headers:Array<HttpHeader>;readonly body:string}`
- `HttpServerConfig` = `{readonly host:string;readonly port:u16}`
- `HttpServerRequest` = `{readonly method:string;readonly path:string;readonly query:string;readonly headers:Array<HttpHeader>;readonly body:string}` *(`query`: without leading `?`, `""` if absent)*
- `HttpServerResponse` = `{readonly status:u16;readonly headers:ReadonlyArray<HttpHeader>;readonly body:string}`
- `HttpBody` = `{readonly kind:"text";readonly value:string}|{readonly kind:"bytes";readonly value:ReadonlyArray<u8>}`
- `HttpServerRawResponse` = `{readonly status:u16;readonly headers:ReadonlyArray<HttpHeader>;readonly body:HttpBody}`
- `HttpClientRequest` = `{readonly method:string;readonly url:string;readonly headers:Array<HttpHeader>;readonly body:string|null}`
- `QueryParam` = `{readonly name:string;readonly value:string}`
- `RegExpMatch` = `{readonly text:string;readonly index:usize;readonly groups:Array<string|null>}` *(0-based capture groups: `groups[0]` = group 1)*
- `Disposable` = `{dispose():void}`; `AsyncDisposable` = `{disposeAsync():Promise<void>}`

## 2. Capabilities (`System`) & Handles

`System`: `alloc:Alloc`, `fs:Fs`, `clock:Clock`, `random:Random`, `log:Log`, `js:Js`, `ffi:Ffi`, `spawn:Spawn`, `audio:Audio`, `display:Display`, `net:Net`, `proc:Proc`.

- `Log`: `info(msg:string):void`, `warn(msg:string):void`, `error(msg:string):void`.
- `Clock`: `nowMs():f64`, `sleep(ms:f64):Promise<void>`*(managed)*.
- `Random`: `nextF64():f64` *(`[0,1)`)*, `nextU32():u32`.
- `Fs`: `readText(p:string):Result<string,IoError>`, `writeText(p:string,t:string):Result<null,IoError>`, `readBytes(p:string,dst:Mut<Vec<u8>>):Result<usize,IoError>` *(overwrites `dst` on ok, leaves `dst` unchanged on err; `EFBIG` if `>2^32-1`)*, `writeBytes(p:string,data:Ref<Slice<u8>>):Result<null,IoError>`; *(managed-only:)* `exists(p:string):boolean`, `stat(p:string):Result<FileStat,IoError>` *(lstat)*, `readDir(p:string):Result<Array<DirEntry>,IoError>` *(sorted lexicographically)*, `mkdir(p:string):Result<null,IoError>` *(recursive & idempotent like `mkdir -p`; `ok(null)` if dir exists)*, `remove(p:string):Result<null,IoError>` *(file/recursive dir; `ENOENT` if missing)*, `rename(from:string,to:string):Result<null,IoError>`, `writeTextAtomic(p:string,text:string):Result<null,IoError>`, `writeBytesAtomic(p:string,data:Ref<Slice<u8>>):Result<null,IoError>`.
- `Proc` *(managed)*: `run(program:string,args:ReadonlyArray<string>,opts?:ProcOptions):Promise<Result<ProcOutput,IoError>>` *(direct exec, never shell)*, `env(name:string):string|null`, `cwd():string`, `args():Array<string>`, `setExitCode(code:u8):void`.
- `Net` *(managed)*: `fetch(url:string,init?:HttpRequestInit):Promise<Result<HttpResponse,IoError>>` *(`http:`/`https:` UTF-8)*, `serve(cfg:HttpServerConfig,handler:(req:HttpServerRequest)=>Promise<HttpServerResponse>):Promise<Result<HttpServer,IoError>>`, `serveRaw(cfg:HttpServerConfig,handler:(req:HttpServerRequest)=>Promise<HttpServerRawResponse>):Promise<Result<HttpServer,IoError>>` *(`port: 0` assigns an ephemeral port; duplicate open `host:port` returns `IoError` `EADDRINUSE`; `--target=browser` compiles cleanly and returns `ENOSYS` at runtime)*.
  - `HttpServer` (`AsyncDisposable`): `host:string`, `port:u16`, `stop():void`, `waitClosed():Promise<void>`, `close():Promise<void>`, `disposeAsync():Promise<void>`, `isOpen():boolean` *(`close()`/`disposeAsync()` are idempotent even after `stop()` + `waitClosed()`)*.
- `Js` *(managed)*: `call(f:JsRef,args:ReadonlyArray<JsRef>):Result<JsRef,JsError>`, `new(ctor:JsRef,args:ReadonlyArray<JsRef>):Result<JsRef,JsError>`, `invoke(o:JsRef,m:string,args:ReadonlyArray<JsRef>):Result<JsRef,JsError>`, `get(o:JsRef,k:string):Result<JsRef,JsError>`, `set(o:JsRef,k:string,v:JsRef):Result<null,JsError>`, `object(entries:ReadonlyArray<{readonly key:string;readonly value:JsRef}>):JsRef`, `await(v:JsRef):Promise<Result<JsRef,JsError>>`, `decode<T extends Codec>(v:JsRef):Result<T,CastError>`, `encode<T extends Codec>(v:T):JsRef`, `callback<T extends Codec>(f:(a:Result<T,CastError>)=>void):JsRef`, `fn(f:(args:Array<JsRef>)=>JsRef):JsRef`.
- `Spawn` *(managed)*: `isolate<S extends Send,R extends Send>(entry):Port<S,R>` where `entry` is module-level non-generic managed fn `(port:Port<R,S>)=>void|Promise<void>` or `(port:Port<R,S>,alloc:Alloc)=>void|Promise<void>` *(runtime supplies `Alloc`; call site stays `spawn.isolate(f)`)*.
  - `Port<S,R>`: `send(x:S):void`, `recv():Promise<R|null>`, `close():void` *(full bidirectional close on caller's handle: drains already-queued msgs then `recv()` resolves `null`; call after reading expected replies)*.
- `Audio` *(managed)*: `open<S extends Native & Send>(cfg:AudioConfig,state:S,render):Promise<Result<AudioStream,IoError>>` (`S` excludes `Result<Owned,E>`, `Ptr*`, `ArenaBuf`; `render`: module-level non-generic safe `"use rt"` fn `(st:Mut<S>|S,out:Mut<Slice<f32>>,frames:usize):void`).
  - `AudioStream` (`AsyncDisposable`): `sampleRate:u32`, `channels:u32`, `close():Promise<void>`, `isOpen():boolean`, `disposeAsync():Promise<void>`.
- `Display` *(managed)*: `open(cfg:DisplayConfig):Promise<Result<DisplaySurface,IoError>>` *(dims `1..16384` else `EINVAL`; Node SDL3 / Browser Canvas 2D)*.
  - `DisplaySurface` (`AsyncDisposable`): `width:u32`, `height:u32`, `clear(c:DisplayColor):void`, `fillRect(x:f64,y:f64,w:f64,h:f64,c:DisplayColor):void`, `strokeRect(x:f64,y:f64,w:f64,h:f64,c:DisplayColor):void`, `drawLine(x1:f64,y1:f64,x2:f64,y2:f64,c:DisplayColor):void`, `drawText(x:f64,y:f64,text:string,c:DisplayColor):void`, `blitRgba(pixels:Ref<Slice<u8>>,srcW:u32,srcH:u32,dx:f64,dy:f64,dw:f64,dh:f64):void` *(`T002` if `<srcW*srcH*4`)*, `present():Promise<void>`, `pollEvents():Array<DisplayEvent>`, `close():Promise<void>`, `disposeAsync():Promise<void>`, `isOpen():boolean`.

## 3. Fakes & Test Harness *(managed creation; capability-subtypable)*

Note: `Fake*` names work as both type annotations and namespaces. `Js` and `Ffi` intentionally have no fakes—isolate testable logic behind functions taking only required capabilities.

- `FakeClock.create(startMs:f64):FakeClock` -> `+ advance(ms:f64):void`.
- `SeededRandom.create(seed:u32):SeededRandom` *(subtype of `Random`)*.
- `MemoryLog.create():MemoryLog` -> `+ entries():Array<{readonly level:"info"|"warn"|"error";readonly message:string}>`.
- `FakeFs.create():FakeFs` *(shared virtual byte/UTF-8 + dir/stat/symlink store; requires existing parent dir matching `nodeFs`)* -> `+ addSymlink(path:string,target:string):Result<null,IoError>`.
- `FakeSpawn.create():FakeSpawn` *(runs isolates in-process asynchronously w/ `Port` pack/unpack, trap propagation, `T006` deadlock detection)*.
- `TestAlloc.create():Alloc`.
- `FakeAudio.create():FakeAudio` -> `+ renderFrames(frames:usize):Array<f32>` *(advances open stream; `open()` closes previous; `renderFrames` traps `T006` if none open)*.
- `FakeDisplay.create():FakeDisplay` -> `+ pushEvent(ev:DisplayEvent):void`, `+ presentCount():usize`, `+ pixelAt(x:u32,y:u32):DisplayColor`, `+ drawnTexts():Array<{readonly x:f64;readonly y:f64;readonly text:string;readonly color:DisplayColor}>` *(latest presented frame; `clear()` resets pending texts)*.
- `FakeProc.create():FakeProc` -> `+ setEnv(name:string,val:string):void`, `+ setCwd(p:string):void`, `+ setArgs(xs:ReadonlyArray<string>):void`, `+ exitCode():u8`, `+ onRun(fn:(req:ProcRequest)=>Result<ProcOutput,IoError>):void`, `+ calls():Array<ProcRequest>`.
- `FakeNet.create():FakeNet` -> `+ onFetch(fn:(req:HttpClientRequest)=>Result<HttpResponse,IoError>):void`, `+ requests():Array<HttpClientRequest>` *(in-memory loopback `serve` overrides `onFetch` for matching open `host:port`)*.
- `Test`: `ok(cond:boolean):void`, `eq<T>(a:T,b:T):void`, `eqSlice<T>(a:Ref<Slice<T>>,b:Ref<Slice<T>>):void`, `traps(code:string,fn:()=>void):void`.

## 4. Native Containers, `OwnedCell`, `Resource` & `Ptr`/`CHandle`

- `Vec<T extends Native & Copy>` (`T002` oob, `T006` OOM): `Vec.create<T>(alloc:Alloc,cap:usize):Vec<T>` *(alloc; `length===0`)*, `Vec.filled<T>(alloc:Alloc,len:usize,init:T):Vec<T>` *(alloc; `length===len`)*; members `length:usize`, `[i]:T`, `[i]=x`, `push(x:T):void`*(alloc)*, `pop():T|null`, `clear():void`, `fill(x:T):void`, `slice(a:usize,b:usize):Slice<T>`(`T002`, arg/recv only).
- `Slice<T extends Native & Copy>`: `length:usize`, `[i]:T`, `[i]=x`, `fill(x:T):void`, `slice(a:usize,b:usize):Slice<T>`(`T002`, arg/recv only).
- `Pool<T extends Native & Copy>` (`u32` LIFO gens, `T011` invalid/stale/foreign handle): `Pool.create<T>(alloc:Alloc,cap:usize):Pool<T>`*(alloc)*; `length:usize`, `capacity:usize`, `insert(x:T):Handle<T>|null`, `get(h:Handle<T>):T`, `set(h:Handle<T>,x:T):void`, `remove(h:Handle<T>):T`, `has(h:Handle<T>):boolean`.
- `Arena` (`T012` post-reset/foreign `ArenaBuf`): `Arena.create(alloc:Alloc,bytes:usize):Arena`*(alloc)*; `remaining:usize`, `alloc<T extends Native & Copy>(n:usize,init:T):ArenaBuf<T>|null` *(concrete `T`)*, `view<T extends Native & Copy>(b:ArenaBuf<T>):Slice<T>` *(arg/recv)*, `reset():void`. `ArenaBuf<T>`: `length:usize`.
- `Ring` (`cap` 2^k in `1..2^31` else `T014`; `T extends Native & Copy & Send`): `Ring.create<T>(alloc:Alloc,cap:usize):RingPair<T>` *(alloc; `RingPair<T>` = `Struct<{tx:RingTx<T>;rx:RingRx<T>}>`)*; `tx.push(x:T):boolean`, `rx.pop():T|null`.
- `OwnedCell<T extends Owned>` *(managed; traps `T008`)*: `OwnedCell.create<T>(v:T):OwnedCell<T>`, `OwnedCell.empty<T>():OwnedCell<T>`, `take():T`, `put(v:T):void`, `isEmpty():boolean`, `withRef<R>((v:Ref<T>)=>R):R`, `withMut<R>((v:Mut<T>)=>R):R` *(`R` cannot be/contain `Promise`)*.
- `Resource<T>` *(`using` only)*: `Resource.own<T>(val:T,cleanup:(v:T)=>void):Resource<T>`, `Resource.ownWith<T,C>(val:T,ctx:C,cleanup:(ctx:C,v:T)=>void):Resource<T>`; `r.borrow():T` *(arg/recv `Ref`/`Mut` for `Owned` `T`)*, `r.get():T` *(`Ptr`/`ConstPtr`/`Copy`)*, `r.take():T` *(disarms cleanup; post-take `E3001`)*.
- `Ptr<T>` / `ConstPtr<T>` / `CHandle<T>` *(unsafe)*: `Ptr.null<T>():Ptr<T>`, `Ptr.sizeOf<T>():usize` *(Copy/`CStruct`/`Ptr*`/`CType`)*, `Ptr.box<T>(alloc:Alloc,x:T):Ptr<T>` *(non-rt)*, `p.isNull():boolean`, `p.read():T`, `p.write(x:T):void`, `p.offset(n:usize):Ptr<T>`, `p.slice(n:usize):Slice<T>`, `p.borrow():T`, `p.cast<U>():Ptr<U>` *(keeps const)*, `p.unbox():T` *(non-rt)*; `CHandle.create<T>(p:Ptr<T>):CHandle<T>`, `h.get():Ptr<T>`.

## 5. Built-in Functions, Namespaces & Managed Members

- **Globals**: `i8(x)`..`f64(x)`, `usize(x)`, `wrapAdd/Sub/Mul(a,b)`, `divTrunc(a,b)`, `rem(a,b)`, `ok(v)`, `err(e)`, `panic(msg:string):never`, `cast<T extends Codec>(x:unknown):Result<T,CastError>`, `requires(c:boolean):void`, `ensures(fn:(r:R)=>boolean):void`, `invariant(c:boolean):void`, `test(name:string,fn:(t:Test)=>void|Promise<void>):void`, `forAll(fn:(...)=>boolean|void):void`, `cfn(f):Ptr<F>`.
- **`Math`**: *(all layers)* `abs/sqrt/floor/ceil/trunc/round/sign(F):F` & `min/max(1+ F):F` *(same `f32`|`f64`)*, `fround(f64):f32`, `PI:f64`, `E:f64`; *(managed)* `sin/cos/tan/asin/acos/atan/atan2/exp/log/log2/log10/pow/hypot/cbrt`.
- **`DetMath`** *(all layers, `rt`-safe, `f64`)*: unary `sin/cos/tan/atan/exp/log/log10/tanh(f64):f64`; binary `atan2/pow(f64,f64):f64`.
- **`Number`**: *(all layers)* `isFinite/isNaN/isInteger(f32|f64):boolean`, `MAX_SAFE_INTEGER:f64`, `EPSILON:f64`, `POSITIVE_INFINITY:f64`, `NEGATIVE_INFINITY:f64`, `NaN:f64`; *(managed)* `parseFloat(s:string):f64`.
- **`JSON`** *(managed)*: `parse(s:string):Result<unknown,JsError>`, `stringify<T extends Codec>(v:T,indent?:u8):string` *(concrete `T`, no `i64`/`u64`)*, `get(v:unknown,k:string):Result<unknown,CastError>`, `keys(v:unknown):Result<Array<string>,CastError>`, `items(v:unknown):Result<Array<unknown>,CastError>`.
- **`Url`** *(managed; `parseQuery`/`getQueryParam` use `URLSearchParams`, stripping optional leading `?` and percent-decoding)*: `parseQuery(q:string):Array<QueryParam>`, `getQueryParam(q:string,k:string):string|null`, `formatQuery(xs:ReadonlyArray<QueryParam>):string`, `encodeComponent(s:string):string`, `decodeComponent(s:string):Result<string,IoError>`.
- **`String`** *(managed)*: `fromCodePoint(c:u32):string`, `encodeUtf8(s:string,dst:Mut<Vec<u8>>):usize` *(overwrites `dst`)*, `decodeUtf8(src:Ref<Slice<u8>>):Result<string,IoError>`, `decodeUtf8Lossy(src:Ref<Slice<u8>>):string`.
- **`RegExp`** *(managed, stateless — no `g`/`y`)*: `RegExp.compile(pattern:string,flags?:string):Result<RegExp,CastError>`; `source:string`, `flags:string`, `test(s:string):boolean`, `exec(s:string):RegExpMatch|null`, `findAll(s:string):Array<RegExpMatch>`, `replace(s:string,rep:string):string`, `replaceAll(s:string,rep:string):string`, `split(s:string):Array<string>`.
- **`Promise`** *(managed)*: `Promise.all<T>(ps:Array<Promise<T>>):Promise<Array<T>>`.
- **`string`** *(managed)*: `length:usize`, `slice(s:usize,e?:usize):string`, `indexOf(s:string):usize|null`, `includes/startsWith/endsWith(s:string):boolean`, `split(sep:string):Array<string>`, `trim/toUpperCase/toLowerCase():string`, `padStart/padEnd(n:usize,f:string):string`, `repeat(n:usize):string`, `replaceAll(a:string,b:string):string`, `charCodeAt(i:usize):u16` (`T002`), `codePointAt(i:usize):u32|null`.
- **`Array<T>` / `ReadonlyArray<T>`** *(managed)*: `length:usize`, `slice(s?:usize,e?:usize):Array<T>`, `map<U>((x:T,i:usize)=>U):Array<U>`, `filter((x:T,i:usize)=>boolean):Array<T>`, `reduce<A>((a:A,x:T,i:usize)=>A,init:A):A`, `forEach((x:T,i:usize)=>void):void`, `find((x:T,i:usize)=>boolean):T|null`, `findIndex((x:T,i:usize)=>boolean):usize|null`, `some/every((x:T,i:usize)=>boolean):boolean`, `includes(x:T):boolean`, `indexOf(x:T):usize|null`, `join(sep?:string):string`, `concat(roArr:ReadonlyArray<T>):Array<T>`; *(Array only:)* `push(x:T):usize`, `pop():T|null`, `reverse():Array<T>`, `sort(cmp:(a:T,b:T)=>f64):Array<T>`, `fill(x:T,s?:usize,e?:usize):Array<T>`.
- **`Map<K extends Key,V>` / `Set<K extends Key>`** *(managed)*: `Map`: `size:usize`, `get(k):V|null`, `set(k,v):Map<K,V>`, `has(k):boolean`, `delete(k):boolean`, `clear():void`, `keys():Iterator<K>`, `values():Iterator<V>`, `entries():Iterator<[K,V]>`, `forEach((v,k)=>void):void`. `Set`: `size:usize`, `add(x):Set<K>`, `has(x):boolean`, `delete(x):boolean`, `clear():void`, `values():Iterator<K>`, `forEach((x)=>void):void`.

## 6. Node `--mode=lib` Host JS API (`app.js`)

- `const lib = await load(options?)` (`options.npm?: Record<string, unknown>` overrides bundled `npm:` modules) -> `{ exports, native, Vec, createSystem, run, stop }`:
  - `exports`: JS/BigInt-marshaled module exports.
  - `native`: low-level C/Wasm runtime symbols.
  - `run(mainFn = exports.main, sysOpts?)`: executes an entry function (`mainFn` required if library has no `main`).
  - `Vec.fromTypedArray(alloc, src, elem)`: creates host buffer from 3 args: `alloc` (`lib.createSystem(...)` or `null`), array/TypedArray `src`, numeric element tag `"i8"|"u8"|"i16"|"u16"|"i32"|"u32"|"i64"|"u64"|"usize"|"f32"|"f64"`.
  - `vec.asTypedArray()`: zero-copy TypedArray view.
  - `await lib.stop()`: stops workers and releases native resources.

## 7. CLI Flags, `mutate` Operator Tags & Canonical Examples

- **CLI (`szigyr <subcmd> [flags] <args>`)**:
  - Subcommands: `check`, `run`, `test`, `mutate`, `prove`, `build`, `query`, `explain`, `mcp`, `lsp`.
  - Flags: `--help`/`-h`, `--json`, `--watch`, `--fix`, `--no-cache`, `--all`, `--filter=<pat>`, `--fail-on-survived`, `--strict`, `--release`, `--timeout=<ms>`, `--backend=js|c|wasm|both|all`, `--target=node|browser`, `--mode=app|lib`, `-o <dir>`.
  - `szigyr run ... [-- <args...>]` forwards args after `--` to `sys.proc.args()`.
- **`szigyr mutate` suppression tags**: `// szigyr-equivalent: <reason>` or `// szigyr-equivalent[<op>,...]: <reason>`, where `<op>` is one of: `+ -> -`, `- -> +`, `* -> +`, `< -> <=`, `<= -> <`, `> -> >=`, `>= -> >`, `=== -> !==`, `!== -> ===`, `&& -> ||`, `|| -> &&`, `if -> true`, `if -> false`, `0 -> 1`, `num -> 0`, `true -> false`, `false -> true`, `delete-stmt`.
- **Canonical Examples**:
```ts
// 1. Managed + Contracts + forAll
export function clamp01(x: f64): f64 { requires(Number.isFinite(x)); ensures((r: f64) => r >= 0 && r <= 1); return x < 0 ? 0 : x > 1 ? 1 : x; }
test("clamp01", (t: Test) => { forAll((x: f64): boolean => { requires(Number.isFinite(x)); const y = clamp01(x); return y >= 0 && y <= 1; }); t.eq(clamp01(2), 1); });

// 2. Portable rt Audio (moved Vec + Ring + await using)
type Delay = Struct<{ buf: Vec<f32>; idx: usize; rx: RingRx<f32>; gain: f32 }>;
function render(st: Mut<Delay>, out: Mut<Slice<f32>>, frames: usize): void {
  "use rt"; let g = st.rx.pop(); while (g !== null) { st.gain = g; g = st.rx.pop(); }
  for (let i: usize = 0; i < frames; i += 1) {
    const d = st.buf[st.idx]; st.buf[st.idx] = f32(DetMath.tanh(f64(d * 0.5 + st.gain)));
    st.idx = (st.idx + 1) === st.buf.length ? 0 : st.idx + 1; out[i] = d;
  }
}
export async function main(sys: System): Promise<void> {
  const { tx, rx } = Ring.create<f32>(sys.alloc, 16); tx.push(0.25);
  const st: Delay = { buf: Vec.create<f32>(sys.alloc, 24000), idx: 0, rx, gain: 0.25 };
  for (let i: usize = 0; i < 24000; i += 1) st.buf.push(0);
  const res = await sys.audio.open({ sampleRate: 48000, channels: 1 }, st, render);
  if (res.kind === "err") { sys.log.error(res.error.message); return; }
  await using stream = res.value; await sys.clock.sleep(100);
}

// 3. Explicit Capability Generics
export function countUnique<K extends Key>(xs: ReadonlyArray<K>): usize { const s = new Set<K>(); for (const x of xs) s.add(x); return s.size; }
export function pushAll<T extends Native & Copy & Send>(tx: Mut<RingTx<T>>, src: Ref<Slice<T>>): usize {
  "use rt"; let n: usize = 0; for (let i: usize = 0; i < src.length; i += 1) if (tx.push(src[i])) n += 1; return n;
}

// 4. C FFI + CStruct + const + Resource.ownWith + take()
declare module "c:sdl3:SDL3/SDL.h" {
  const SDL_AUDIO_F32: u32; type SDL_AudioSpec = CStruct<{ format: u32; channels: i32; freq: i32 }>;
  function SDL_malloc(ffi: Ffi, size: usize): Ptr<void>; function SDL_free(ffi: Ffi, mem: Ptr<void>): void;
}
import { SDL_AUDIO_F32, SDL_AudioSpec, SDL_malloc, SDL_free } from "c:sdl3:SDL3/SDL.h";
function freeMem(ffi: Ffi, p: Ptr<void>): void { "use owned"; "use unsafe"; SDL_free(ffi, p); }
export function makeSpec(ffi: Ffi): CHandle<SDL_AudioSpec> {
  "use owned"; "use unsafe"; using g = Resource.ownWith(SDL_malloc(ffi, Ptr.sizeOf<SDL_AudioSpec>()), ffi, freeMem);
  if (g.get().isNull()) panic("oom");
  g.get().cast<SDL_AudioSpec>().write({ format: SDL_AUDIO_F32, channels: 2, freq: 48000 });
  return CHandle.create(g.take().cast<SDL_AudioSpec>());
}
```

