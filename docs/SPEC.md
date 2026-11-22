# Szigyr Language Specification v1

Normative reference for **Szigyr** (`szigyr`, `.szigyr`). Unlisted syntax/types/built-ins rejected (`E1000`/`E2000`).

## 0. Principles

1. **TS syntax, sound semantics**: TS-parseable `.szigyr` with sound ops (`indexOf`->`usize|null`, `JSON.parse`->`Result`, `charCodeAt` `T002`, int ovf `T001`).
2. **Three layers**: `managed` (JS GC), `strict` (`"use owned"`, compiled C/Wasm without in-kernel GC/RC; `Vec`/`Pool`/`Arena` are JS-backed across the managed boundary), `rt` (`"use rt"`, `strict` sans alloc/auth/recursion).
3. **Backend parity**: Non-C-only code matches across JS/C/Wasm (returns, `Mut` writes, stdout, trap code+pos).
4. **Explicit boundaries**: Param/return/layer/auth/generic bounds (`T extends ...`) explicit; inference local-only (locals, call type args).
5. **Capability effects**: No ambient globals (`console`, `Date`, `Math.random`, ...); effects use capability args.

## 1. Modules & Top-Level

- **ESM only**: Named `import`/`export` (`import {a as b} from "./x.szigyr"`, `export {a}`, or inline `export`), named re-exports (`export {a, b as c} from "./x.szigyr"`), module namespace imports (`import * as ns from "./x.szigyr"`, `ns.Type` in type positions / `ns.val` in value positions; exporting `ns` itself `E7001`), and type-only `import type`/`export type` (`import {type T, v}`, `export {type T, v}`) on `.szigyr` and `c:` modules (value use `E2002`).
  - Relative paths start `./` or `../`, end `.szigyr` (canonical realpath id). Special: `"npm:<pkg>"` (§7), `"c:<pkg>:<header>"` (§9).
  - Acyclic `import`/`export` chains of any depth; cycles fail at use (`E2000`).
  - Forbidden: `export default`/`export *` (`E1003`); `import()`, `require()`, local default imports, side-effect imports, `import type` on `npm:`, `c:`/`npm:` re-exports, missing target (`E7001`).
- **Top-level**: `import`/`export`, `function`, `type`, `interface`, `class`, `const` (typed `E2006`; lit or immutable record/array lit, incl. `const {a,b}:T={...}`; `Native & Copy` readable in `strict`/`rt`), `test(...)`, `declare module "c:..."`. Top-level `let` or mutable/non-lit `const`/`static`: `E5002`.
- **Reserved (`E1000` decl)**: §12 globals, §13 reserved, `__szigyr_rt*`, `__proto__`/`constructor`/`prototype`/`toString`/`valueOf`. Values/types share duplicate check (`E1000`).

## 2. Layers, Directives & Functions

File-top directives (before `import`) set default layer for top-level `function` decls (not methods/`test`); fn-top overrides. Bad directives: `E1000` (`"use unsafe"` errs: `E1009`; `"use strict"` is NOT a Szigyr directive—use `"use owned"` or omit for `managed`). There is no `"use managed"` override, so files mixing `managed` functions (e.g. `main(sys: System)`) with `"use owned"`/`"use rt"` helpers omit the file-top directive and annotate those helpers per function (or split modules).

|Directive|Layer/Mod|Rules|
|---|---|---|
|*(none)*|`managed`|JS GC, `async`/`await`, closures, `Array`/`Map`/`Set`/`string`/`npm:`.|
|`"use owned"`|`strict`|Ownership/move/borrow, `Native` data, C/Wasm compiled.|
|`"use rt"`|`rt`|`strict` sans alloc (`E4004`), auth (`E4006`), recursion (`E4005`).|
|`"use unsafe"`|mod (`strict`/`rt`)|`Ptr`/`ConstPtr`/`CType`/`CStruct`/`CHandle` ops, `c:` calls, `cfn` (`E1009` elsewhere).|

Calls (`E4001`): `managed`->{`managed`,`strict`,`rt`, safe-sig `strict+unsafe`}; `strict`->{`strict`,`rt`, safe-sig `strict+unsafe`}; `rt`->{`rt`}; `rt+unsafe`->{`rt`,`rt+unsafe`}. (`strict+unsafe` w/ raw `Ptr` needs `"use unsafe"` per §9; `rt+unsafe` is restricted to `rt+unsafe`/`cfn` because it omits `Ffi` authority.)

- **Arrows/fn-exprs**: Inherit layer, no directives; forbidden in `strict`/`rt` (`E4003`) **except** `ensures((r:R)=>...)`.
- **Fn params (`strict`/`rt`)**: Param/nested-param types allow `(a:A)=>R` (not returns/locals/fields/type-args `E4003`, except `Ptr`/`ConstPtr` fn ptrs in §9). Args: module-level non-generic `strict`/`rt` fn or forwarded param (`E4003`; `rt`->`rt`; safe rejects `rt+unsafe`: `E4001`); specialized.
- **Poly-recursion (`E4010`)**: `strict`/`rt` generic cycle growing a type param (`f<Box<T>>`) rejected.
- **`rt` recursion (`E4005`)**: Any call-graph cycle (direct/mutual/via fn params) rejected even if uncalled.

## 3. Types & Capability Matrix

### 3.1 Primitives & Numerics

- **Primitives**: `boolean`, `string` (`managed`), `null` (1B layout, all layers), `void` (return only `E2002`, plus `Ptr<void>`/`ConstPtr<void>` in §9), `unknown` (`managed`), `never` (bottom/return only; no `strict`/`rt` param `E4002`). No `undefined` (`E2000`).
- **Numerics**: `i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`, `usize` (`0..2^32-1`, distinct from `u32`), `f32`, `f64` (`number` alias). `i64`/`u64` use plain contextual literals (no `1n` `bigint` suffix, `E1000`), map to JS `bigint` via `js.decode`/`encode`, and are statically rejected (`E2002`) in `JSON.stringify`.
- **Explicit casts**: `i32(x)`, `i64(x)`, `f32(x)`, `usize(x)`, etc. (integer casts `i8..u64`/`usize` preserve exact in-range integer literals directly in the target integer type; out-of-range or float arguments convert dynamically and trap `T003`; `f32` rounds binary32).
- **Literals**: Contextually typed (annotation, sibling, cmp `===`/`!==`/`<`/`<=`/`>`/`>=`, param, element, index=`usize`, ternary); else `f64`. Unary `-`+lit is one literal (`-0`->`+0` in ints). Non-int in int ctx, out-of-range, or non-finite (`1e400`) -> `E2008` (use `Number.POSITIVE_INFINITY`/`NEGATIVE_INFINITY`/`NaN`).
- **Ops**: `+ - *` same numeric (`E2003`, int ovf `T001`), `+`/`+=` also *managed* `string` (`string + string` / `string += string`; `E4001` in `strict`/`rt`, `string + num` is `E2002`, literal-union LHS `+=` is `E2002`); `/` float-only (`E2007`); `%`/`%=` float (IEEE `fmod`, `f32` rounded) or same-int (`rem` semantics, `T007` on 0, `MIN % -1 === 0`); `**` float-only (`E2002` int, `strict`/`rt` `E4001`); same-int (`i8..u64,usize`) `divTrunc(a,b)` (`T007`/`T001`), `rem(a,b)` (`T007`, `rem(MIN,-1)===0`), `wrapAdd/Sub/Mul`; unary `-` signed int/float (`T001`, unsigned `E2002`). `f32` rounds each op. `++`/`--`: allowed **only** as a standalone statement or `for`-loop incrementor (same checked semantics as `+= 1`/`-= 1`, int ovf `T001`; value-producing positions `E1000`). Bitwise `& | ^` and compound `&= |= ^=` (`u8`/`u16`/`i32`/`u32`/`i64`/`u64`), `~` / `<<` / `<<=` (`i32`/`u32`/`i64`/`u64`), `>>`/`>>=` (`i32`/`i64`), `>>>`/`>>>=` (`u32`/`u64`), shift outside `0..31`/`0..63` traps `T009`, `<<`/`<<=` truncates. Logical assignments (`&&=`, `||=`, `??=`): `E1000`. `< <= > >=`: same numeric or *managed* `string`/lit (`E4001` in `strict`/`rt`, UTF-16 code-unit order; `E2002` otherwise). Conditions: `boolean` (`E2004`).

### 3.2 Built-in Capabilities & Explicit Bounds

Bounds are **never inferred** from bodies. Write `T extends C` or `T extends C1 & C2` (`&` allowed **only** in type-param `extends`, `E1000` elsewhere; contradictory `Copy & Owned`: `E2002`).
- `Copy`: Duplicated value. `Native`: Binary layout (`strict`/`rt`/C/Wasm). `Owned` *(derived)*: `Native & !Copy` (move-only). `Send`: Cross-thread safe. `Key`: Scalar eq/hash. `Codec`: Runtime-checked (`cast`, `js.decode`/`encode`, `JSON.stringify`).
- `Disposable` `{ dispose():void }` (`using`, `managed`/`strict`); `AsyncDisposable` `{ disposeAsync():Promise<void> }` (`await using`, `managed`).
- **Defaults**: Unconstrained `managed` `<T>` implies `!Owned` (`Owned` arg `E3007`). `strict`/`rt` `<T>` implies `Native` (`E4002`). User `interface` bounds: `managed`-only.

### 3.3 Type x Capability Matrix (`Y`=yes, `-`=no; `A`=All, `M`=managed, `U`=unsafe)

|Type|L|Copy|Native|Owned|Send|Key|Codec|
|---|---|---|---|---|---|---|---|
|Numerics (`i8..u64,usize,f32,f64`)|A|Y|Y|-|Y|Y|Y|
|`boolean`|A|Y|Y|-|Y|Y|Y|
|`null` (1B)|A|Y|Y|-|Y|-|Y|
|String lit/union (`E2012` surr)|A|Y|Y|-|Y|Y|Y|
|`string`|M|Y|-|-|Y|Y|Y|
|`{readonly f:T}`|A|∀f:Copy|∀f:Native&Copy|-|∀f:Send|-|∀f:Codec|
|Mutable `{f:T}` (`!Owned`)|M|-|-|-|-|-|∀f:Codec|
|`Struct<{...}>` (fields `Native`)|A|ro&Copy|Y|!Copy|∀f:Send|-|ro&∀f:Codec|
|Tagged union/`T\|null`/`Result`|A|∀m:Copy|∀m:Native&Copy (`Result`: ∀m:Native)|-|∀m:Send|-|∀m:Codec|
|`Array<T>`/`T[]` / `ReadonlyArray<T>`/`readonly T[]` (`!Owned`)|M|-|-|-|-|-|∀T:Codec|
|`[T0, T1, ...]` / `readonly [T0, ...]` (`!Owned`)|M|∀e:Copy|-|-|∀e:Send|-|∀e:Codec|
|`Map<K,V>`/`Set<K>` (`!Owned` V)|M|-|-|-|-|-|-|
|`Vec<T>` / `Pool<T>`|A|-|Y|Y|T:Send|-|-|
|`Handle<T>` (`===`)|A|Y|Y|-|T:Send|-|-|
|`Arena` / `RingTx<T>` / `RingRx<T>`|A|-|Y|Y|Y|-|-|
|`ArenaBuf<T>`|A|Y|Y|-|-|-|-|
|`CHandle<T>`|A|-|Y|Y|-|-|-|
|`Ptr`/`ConstPtr`/`CType`/`CStruct`|U|Ptr/CStruct|-|-|-|-|-|
|`class`/`interface`/`(a)=>R`/`OwnedCell`/`Port`/`AudioStream`/`HttpServer`/`RegExp`|M|-|-|-|-|-|-|
|Authorities/`JsRef`/`unknown`/`Test`|M/strict (`rt` `E4006`)|-|-|-|-|-|-|

**Slot-only**: `Promise<T>` (ret), `void` (ret), `Ref<T>`/`Mut<T>` (param), `Slice<T>` (`Ref`/`Mut`/`Ptr.slice`), `Resource<T>` (`using`).

### 3.4 Capability Rules by Construct

- `Vec`/`Slice`/`Pool`/`Handle`/`ArenaBuf`: `T extends Native & Copy` (`Arena.alloc<T>`: concrete `T`, `E2002`).
- `Ring*`: `T extends Native & Copy & Send`. `Port`/`spawn.isolate`: `S extends Send, R extends Send`. `audio.open<S>`: `S extends Native & Send`.
- `Ref<T>`/`Mut<T>`/`OwnedCell<T>`: `T extends Owned` (`Ref`/`Mut` also `Slice<U extends Native & Copy>`).
- `strict`/`rt` vals & `Struct` fields: `Native` (authorities `strict`-only, `rt` `E4006`).
- `Map`/`Set`/`.includes`/`.indexOf`: `K extends Key`. `cast`/`js.decode`/`js.callback`: **concrete** `T extends Codec` (no type params; managed generics erased, `E2002`). `js.encode`: `T extends Codec`. `JSON.stringify`: **concrete** `T extends Codec` without `i64`/`u64` (`E2002`).
- `===`/`!==`: `Key`, `Handle<T>`, `class` (ref), `null`, or `T|null` of those (`E2002`; `==`/`!=` `E1002`).
- `t.eq<T>`: Generic `Codec` or `Copy`. Direct: `Codec`, `Map`, `Set`, `Handle`, `ArenaBuf`, `class` (no `Owned`/fn/authority).
- `Ptr.box<T>` (unsafe): JS-free `Native` (`Copy`, `Ring*`, `CHandle`, or `Struct` of them; no `Vec`/`Pool`/`Arena` `E4007`).

### 3.5 Composites, Subtyping & Forbidden TS

- **Records/`Struct`**: Closed; no `?` (`E1008`), excess props, or dup keys (`E1000`). Spread `{...a,k:v}` needs context (dup explicit keys `E1000`). Style: `{readonly...}` (Copy), `Struct<{...}>` (mutable/owned; same type if all `readonly & Native & Copy`).
- **Unions/`Result`**: Tagged unions (distinct string-lit `kind`, no lone surr `E2012`), string-lit unions, `T|null`. Shared fields readable; writable only if identical non-`readonly` in all members (`E2002`). `Result<T,E>` = `{readonly kind:"ok";readonly value:T}|{readonly kind:"err";readonly error:E}`; `ok`/`err` need context (`E2006`). `Result<T,E>` may carry `Owned` (move-only; after narrowing on `kind`, reading/moving `r.value` or `r.error` moves `r`; `Native` when both `T` and `E` are `Native`).
- **Classes/Interfaces**: Single-level nominal `class` (no `extends` `E1000`, `implements` OK incl. `ns.Iface`, no `abstract`/accessors/index-sigs/`#private`; `private`/`readonly`/`static` fields OK; constructor parameter properties `private`/`public`/`readonly` OK with `public` allowed only there, satisfying definite init on entry, and disallowing `Ref`/`Mut` `E3004` or `Owned` `E3007`; definite init `E2002`; methods `managed`/call-only, `async` OK, no directives; `new C(...)` / `new ns.C(...)`). `interface`: either a nominal method interface (method sigs only, no `extends`/dupes; target of `class implements` and `<T extends I>`) or a field-only record interface (structural record type; supports `extends` across field-only interfaces/records excluding owned `Struct`, covariant field overrides on matching mutability; mixing fields and methods is `E1000`). `Array<T>` (`T[]`) invar; `ReadonlyArray<T>` (`readonly T[]`) covar. `e satisfies T`: checks `e` with context `T` (`E2002`) without widening (`e`'s inferred type is kept; no runtime op).
- **Tuples (`managed`)**: Immutable fixed-length `[T0, T1, ...]`, `readonly [T0, ...]`, and labeled `[x: T0, y: T1]` (non-empty `E1000`, no rest `E1000`/opt `E1008`, no `Owned` `E3007`, `strict`/`rt` `E4002`); `length:usize`, constant index `t[k]` or homogeneous dynamic `t[i]` (`T002`/`E2002`, write `E2002`), local & `for-of` destructuring `const`/`let [a,b]=t` with holes `[,b]` (rest/nested/module-level `E1000`, default `E1008`).
- **Subtyping**: Identity + `never->T`, `T->T|null`, `null->T|null`, lit->`string`/lit-union, member->tagged-union, `class->interface`, `[S0,...]->[T0,...]`, `[T0,...]->ReadonlyArray<U>`, `Array<S>/ReadonlyArray<S>->ReadonlyArray<T>` (`S->T`), fn contra/covariant (including functions with trailing default parameters), `Ptr->ConstPtr`, fake->authority, arg-only `Vec/Ref<Vec>/Mut<Vec>->Ref<Slice>/Mut<Slice>` & `Mut<X>->Ref<X>`.
- **Parameters & Forbidden TS (`E1000` unless noted)**: Trailing default parameters (`x: T = expr`, `undefined`-free) are allowed on functions, methods, constructors, and arrows/fn-exprs (evaluated in callee context, with earlier params in scope; `this` forbidden in ctor defaults and `await` forbidden in async defaults `E1000`; non-trailing defaults and defaults in `c:`/interface/function-type signatures `E1008`; borrow defaults `E3004`; `strict`/`rt` fn-param defaults `E4003`; disallowed on `cfn`/`isolate`/`audio.open`/`Resource.own*` cleanup). **Forbidden**: `any` (`E1004`), `object`, `Function`, `{}`, `symbol`, `bigint`, `enum`, `namespace`, `as` (`E1005`), `!` (`E1006`), `is`, `asserts`, overloads, merging, `declare` (outside `c:`), conditional/mapped/template/indexed types, `keyof`, `typeof`, utility types, non-`readonly[]`/`readonly[...]` type operators (`E1000`), empty tuple `[]`/rest tuple elems/module-level or rest/nested array destructuring (`E1000`), opt `?` params/props/tuple elems & destructuring defaults (`E1008`), rest params (`E1000`), `var` (`E1001`), `throw`/`try`/`catch`/`finally` (`E1007`), `with`/`eval`/`delete`/`in`/`instanceof`/`void` op/comma/`arguments`/generators/`for..in`/labels/regex flags outside `imsu`/`new RegExp`/`tagged-templates`/unscoped `this`.

## 4. Statements, Expressions & Narrowing

- **Control**: `const`, `let`(init req), `using`, `await using`, `if/else`, `while`, `do/while`, `for(;;)`, `for(const|let x of c)` (`Array`/`ReadonlyArray`/`Set`/`Map.keys()/values()/entries()`, incl. tuple destructuring `const|let [k,v]`), `switch` (exhaustive `E2005`: all members, `true`+`false`, or `default`; per-case block scope, no implicit fallthrough for non-empty cases `E2002`, empty `case "a": case "b":` grouping allowed), `break`, `continue`, `return`. Non-`void` fallthrough: `E2002`.
- **Narrowing**: `=== null`/`!== null`, `.kind === "..."`, lit `===`, `switch`, `&&`/`||`/`!`, early `return`/`panic`, assigns narrow `readonly`-path locals/params. `?.` on `T|null` prop/method (`?.[i]`/`f?.()` `E1000`); `??` needs `T|null` lhs.
- **Literals/`new`/Arrows**: Arrow/fn-expr param types are inferred from a contextual function type when present (`arr.map(x => ...)`, typed bindings, `ensures(r => ...)`, `test("...", t => ...)`); without context (`const f = (x) => x`, `forAll((x) => {})`, or unresolved generic type param), annotations are required (`E2006`); ret inferred. Untyped `{...}`/`[]`/`[null]`: `E2006`. Templates (`managed`), regex literals `/pat/flags` (`managed` `E4001`, flags in `imsu` `E1000`), and `string + string` / `+=` (`managed`-only, `E4001` in `strict`/`rt`; `string + number` is `E2002`); templates interpolate `string`/lit/num/`boolean`. `new` (`managed`): `new C(...)`, `new Set<K>()`, `new Map<K,V>()` (`new RegExp` `E2002`).
- **Async (`managed`)**: `Promise<T>` valid only as `await` operand (incl. `await (c?g():h())`), `Promise.all([...])` elem, or async `return` (`E2002`). Unawaited `Promise`: `E2002`.
- **Eval order**: Left-to-right everywhere.

## 5. Ownership, Borrowing & `using`

- **Moves (`E3001`–`E3003`, `E3007`)**: `Owned` moves on assign, by-val arg, `return`, `Struct` field, spread source, `ok`/`err`, or `const {a,b}=x` (partial `Owned` `Struct` move/destructure: `E3003`; moving narrowed `r.value`/`r.error` from `Result<Owned,E>` moves `r` cleanly). Use-after-move: `E3001` (`let` reassignable). Loop move without same-iter reassign: `E3002`. `Owned` in `Array`/`Map`/`Set`/`Promise`/tuples/managed records/classes, unconstrained managed generics, or closure capture: `E3007`. Runtime containers (`Vec`/`Pool`/`Arena`) are backed by host/JS storage synced on boundary exit and reclaimed by host GC once unreferenced, whereas raw C handles (`CHandle`, `Ptr.box`) have no auto-destructor and require `using` / `Resource`.
- **Borrows (`E3004`–`E3006`, `E3008`)**: `Ref<T>`/`Mut<T>` allowed **only** as full param type of non-`async` fns (`E3004` elsewhere, incl. bare `Slice<U>`). Args require places (`E3008`): local, borrow param, field path, `v.slice(a,b)`, `a.view(b)`, `p.slice(n)`, `p.borrow()`, `r.borrow()`. Slice/view/borrow valid only in arg/recv slot (`E3004`, incl. `v.slice(0,2)[0]=1`). `Ref->Mut`: `E3006`.
  - **Exclusivity (`E3005`)**: `Mut` arg forbids overlapping prefix paths of same root in call (recv=arg 0). Same root+path `v.slice`/`a.view` check byte overlap at runtime (`T013`). `Ptr.slice` is static `E3005`.
- **`OwnedCell<T extends Owned>`** (`managed`): `OwnedCell.create<T>(v)`, `c.take():T`, `c.put(v:T)`, `c.isEmpty():boolean`, `c.withRef<R>((v:Ref<T>)=>R):R` *(shared read borrow; re-entrant `withRef` OK; `R` cannot be/contain `Promise`)*, `c.withMut<R>((v:Mut<T>)=>R):R` *(exclusive mutable borrow; `R` cannot be/contain `Promise`)*. Direct inline non-`async` `withRef`/`withMut` callbacks may capture outer `Ref`/`Mut` borrows (outer `E3005` exclusivity applies; escaping closures remain `E3004`). Empty cell or conflicting/re-entrant `take`/`withRef`/`withMut` traps `T008` *(borrow lock always released on exit/trap)*.
- **`using` / `await using`**: LIFO cleanup on any exit (normal, `break`/`continue`/`return`, trap).
  - **`managed`**: `using` takes `Disposable`; `await using` takes `AsyncDisposable` (e.g. `AudioStream`, `HttpServer`).
  - **`strict`, `rt` & `managed`**: `Resource.own<T>(val:T, cleanup:(v:T)=>void):Resource<T>` and `Resource.ownWith<T,C>(val:T, ctx:C, cleanup:(ctx:C,v:T)=>void):Resource<T>` valid **only** in `using r = ...` (`rt` uses a zero-alloc stack defer list). `Resource<T>` bindings cannot escape (`const x=r`, `return r`, `f(r)`, capture: `E3004`). `T`: `Owned` or (`"use unsafe"`) `Ptr`/`ConstPtr`. In `strict`/`rt`, `cleanup` is module-level non-generic `strict`/`rt` fn (unsafe if caller unsafe); `ctx` is `Ffi`/`Alloc` (`strict`-only) or `Native & Copy`. Ops: `r.borrow()` (`Ref`/`Mut` arg/recv for `Owned` `T`), `r.get():T` (`Ptr`/`ConstPtr`/`Copy`), `r.take():T` (disarms cleanup, moves `T`; post-take `E3001`).

## 6. Native Containers (`strict` / `rt`)

Bad index: `T002`; `.create`/`.filled` OOM: `T006`. Process-unique Pool/Arena IDs; `u32` gens (Pool LIFO).

- `Vec.create<T>(alloc:Alloc, cap:usize):Vec<T>` *(alloc; starts `length===0`)* / `Vec.filled<T>(alloc:Alloc, len:usize, init:T):Vec<T>` *(alloc; starts `length===len`)*: `length:usize`, `[i]`, `[i]=x`, `push(x)`*(alloc)*, `pop():T|null`, `clear()`, `fill(x)`, `slice(a,b):Slice<T>`(`T002`).
- `Slice<T>`: `length:usize`, `[i]`, `[i]=x`, `fill(x)`, `slice(a,b):Slice<T>`(`T002`).
- `Pool.create<T>(alloc:Alloc, cap:usize):Pool<T>` *(alloc)*: `length`, `capacity:usize`, `insert(x):Handle<T>|null`, `get(h):T`/`set(h,x)`/`remove(h):T`(`T011`), `has(h):boolean`. `Handle<T>` allows `===`.
- `Arena.create(alloc:Alloc, bytes:usize):Arena` *(alloc)*: `remaining:usize`, `alloc<T>(n:usize, init:T):ArenaBuf<T>|null`*(concrete `T`, `E2002`)*, `view<T>(b:ArenaBuf<T>):Slice<T>`(`T012`), `reset()`. `ArenaBuf<T>`: `length:usize`.
- `Ring.create<T>(alloc:Alloc, cap:usize):RingPair<T>` *(alloc; `cap` 2^k in `1..2^31` else `T014`; holds up to `cap` items)*: `Struct<{tx:RingTx<T>;rx:RingRx<T>}>`. `tx.push(x):boolean`, `rx.pop():T|null`.

## 7. Capabilities, Effects & `npm:`

- **Entry**: `export function main(sys: System): void | Promise<void>` (`managed`). `System`: `alloc:Alloc`, `fs:Fs`, `clock:Clock`, `random:Random`, `log:Log`, `js:Js`, `ffi:Ffi`, `spawn:Spawn`, `audio:Audio`, `net:Net`, `proc:Proc`. Reusable handles (`managed`-storable); globals: `E5001`.
- **Records** *(structural aliases)*: `IoError`/`CastError`/`JsError` = `{readonly code:string;readonly message:string}`; `AudioConfig` = `{readonly sampleRate:u32;readonly channels:u32}`; `DirEntry` = `{readonly name:string;readonly kind:"file"|"dir"|"symlink"|"other"}`; `FileStat` = `{readonly kind:"file"|"dir"|"symlink"|"other";readonly size:u64;readonly mtimeMs:f64}`; `EnvVar` = `{readonly name:string;readonly value:string}`; `ProcOptions` = `{readonly cwd:string|null;readonly env:ReadonlyArray<EnvVar>;readonly stdin:string|null;readonly timeoutMs:u32|null}`; `ProcOutput` = `{readonly exitCode:i32;readonly stdout:string;readonly stderr:string;readonly timedOut:boolean}`; `ProcRequest` = `{readonly program:string;readonly args:Array<string>;readonly cwd:string|null;readonly env:Array<EnvVar>;readonly stdin:string|null;readonly timeoutMs:u32|null}`; `HttpHeader` = `{readonly name:string;readonly value:string}`; `HttpRequestInit` = `{readonly method:string;readonly headers:ReadonlyArray<HttpHeader>;readonly body:string|null;readonly timeoutMs:u32|null}`; `HttpResponse` = `{readonly status:u16;readonly headers:Array<HttpHeader>;readonly body:string}`; `HttpServerConfig` = `{readonly host:string;readonly port:u16}`; `HttpServerRequest` = `{readonly method:string;readonly path:string;readonly query:string;readonly headers:Array<HttpHeader>;readonly body:string}`; `HttpServerResponse` = `{readonly status:u16;readonly headers:ReadonlyArray<HttpHeader>;readonly body:string}`; `HttpClientRequest` = `{readonly method:string;readonly url:string;readonly headers:Array<HttpHeader>;readonly body:string|null}`; `QueryParam` = `{readonly name:string;readonly value:string}`; `RegExpMatch` = `{readonly text:string;readonly index:usize;readonly groups:Array<string|null>}` *(0-based capture groups: `groups[0]` = group 1)*.
- `Log`: `info/warn/error(msg:string):void`. `Clock`: `nowMs():f64`, `sleep(ms:f64):Promise<void>` *(managed)*. `Random`: `nextF64():f64` (`[0,1)`), `nextU32():u32`. `Fs`: `readText(p):Result<string,IoError>`, `writeText(p,t):Result<null,IoError>`, `readBytes(p:string, dst:Mut<Vec<u8>>):Result<usize,IoError>` *(overwrites `dst` on success, leaves `dst` unchanged on error, `EFBIG` if `>2^32-1`)*, `writeBytes(p:string, data:Ref<Slice<u8>>):Result<null,IoError>`, and *(managed-only:)* `exists(p:string):boolean`, `stat(p:string):Result<FileStat,IoError>` *(non-following `lstat`)*, `readDir(p:string):Result<Array<DirEntry>,IoError>` *(sorted lexicographically)*, `mkdir(p:string):Result<null,IoError>` *(recursive)*, `remove(p:string):Result<null,IoError>` *(file or recursive dir; `ENOENT` if missing)*, `rename(from:string,to:string):Result<null,IoError>`, `writeTextAtomic(p:string,text:string):Result<null,IoError>`, `writeBytesAtomic(p:string,data:Ref<Slice<u8>>):Result<null,IoError>`.
- `Proc` *(managed)*: `run(program:string,args:ReadonlyArray<string>,opts?:ProcOptions):Promise<Result<ProcOutput,IoError>>` *(direct exec, never shell)*, `env(name:string):string|null`, `cwd():string`, `args():Array<string>`, `setExitCode(code:u8):void`.
- `Net` *(managed)*: `fetch(url:string,init?:HttpRequestInit):Promise<Result<HttpResponse,IoError>>` *(`http:`/`https:` UTF-8)*, `serve(cfg:HttpServerConfig,handler:(req:HttpServerRequest)=>Promise<HttpServerResponse>):Promise<Result<HttpServer,IoError>>`. `HttpServer` (`AsyncDisposable`): `host:string`, `port:u16`, `stop():void`, `waitClosed():Promise<void>`, `close():Promise<void>`, `disposeAsync():Promise<void>`, `isOpen():boolean`.
- `Js` *(managed)*: `call(f:JsRef, args:ReadonlyArray<JsRef>):Result<JsRef,JsError>`, `new(ctor:JsRef, args:ReadonlyArray<JsRef>):Result<JsRef,JsError>`, `invoke(o:JsRef, m:string, args:ReadonlyArray<JsRef>):Result<JsRef,JsError>`, `get(o:JsRef, k:string):Result<JsRef,JsError>`, `set(o:JsRef, k:string, v:JsRef):Result<null,JsError>`, `object(entries:ReadonlyArray<{readonly key:string;readonly value:JsRef}>):JsRef`, `await(v:JsRef):Promise<Result<JsRef,JsError>>`, `decode<T extends Codec>(v:JsRef):Result<T,CastError>`, `encode<T extends Codec>(v:T):JsRef`, `callback<T extends Codec>(f:(a:Result<T,CastError>)=>void):JsRef`, `fn(f:(args:Array<JsRef>)=>JsRef):JsRef`.
- `Spawn` *(managed)*: `isolate<S extends Send,R extends Send>(entry):Port<S,R>` where `entry` is `(port:Port<R,S>)=>void|Promise<void>` or `(port:Port<R,S>, alloc:Alloc)=>void|Promise<void>` *(runtime supplies `Alloc`; call site stays `spawn.isolate(f)`)*.
- `Audio` *(managed)*: `open<S extends Native & Send>(cfg:AudioConfig, state:S, render):Promise<Result<AudioStream,IoError>>`. `AudioStream` (`AsyncDisposable`): `sampleRate:u32`, `channels:u32`, `close():Promise<void>`, `isOpen():boolean`, `disposeAsync():Promise<void>`.
- **Fakes** *(cap-assignable; `FakeClock`/`SeededRandom`/`MemoryLog`/`FakeFs`/`FakeSpawn`/`FakeAudio`/`FakeNet`/`FakeProc` usable as type annotations as well as namespaces; `Js` and `Ffi` intentionally have no fakes—isolate testable logic in functions taking only required capabilities behind a thin `main(sys: System)`)*: `FakeClock.create(startMs)` (`+ advance(ms)`), `SeededRandom.create(seed:u32)`, `MemoryLog.create()` (`+ entries():Array<{readonly level:"info"|"warn"|"error";readonly message:string}>`), `FakeFs.create()` *(shared byte/UTF-8 + dir/stat/symlink virtual store; requires existing parent dir matching `nodeFs`, `+ addSymlink(path:string,target:string):Result<null,IoError>`)*, `FakeSpawn.create()`, `TestAlloc.create():Alloc`, `FakeAudio.create()` (`+ renderFrames(frames:usize):Array<f32>`, advances active open stream; `open()` closes any previous open stream and `renderFrames` traps `T006` if none open), `FakeProc.create()` (`+ setEnv(name,val)`, `+ setCwd(p)`, `+ setArgs(xs)`, `+ exitCode():u8`, `+ onRun(fn:(req:ProcRequest)=>Result<ProcOutput,IoError>)`, `+ calls():Array<ProcRequest>`), `FakeNet.create()` (`+ onFetch(fn:(req:HttpClientRequest)=>Result<HttpResponse,IoError>)`, `+ requests():Array<HttpClientRequest>`, in-memory loopback `serve` taking precedence over `onFetch` for matching open `host:port`).
- **`Pure`**: Safe (no `"use unsafe"`), local mut (`let`/`Set`/`Array`) OK, no authority/fn/`interface`/`unknown`/`JsRef`/`Ptr*`/`CHandle`/`Ring*`/`Port`/`AudioStream`/fake params.
- **`Mutatable`**: Safe top-level fns/`class` methods not touching `Test`, no `Ffi`/`Js`/`JsRef`/`Ptr*`/`CHandle` params (`Alloc`/`Spawn`/`Port`/fakeables/single-thread `Ring*` OK).
- **`npm:` (`managed`)**: Named, default (`import d from`), namespace (`import * as ns from`), and combined (`import d, { a } from`) ESM/CJS imports bind `JsRef`. Throws -> `JsError`; `js.callback` traps unwind to host. (`import type` on `npm:` is rejected `E7001`.)

## 8. Concurrency & Portable Audio

- **Rings**: Lock/wait/alloc-free SPSC (`SharedArrayBuffer`+`Atomics` or `MessagePort`).
- **Isolates (`managed`)**: `spawn.isolate<S extends Send, R extends Send>(f)` takes module-level non-generic `managed` fn `f` taking `(port:Port<R,S>)` or `(port:Port<R,S>,alloc:Alloc)` and returning `void|Promise<void>` (`E2011`; bad `S`/`R` `E2010`). `Port<S,R>`: `send(x:S)`, `recv():Promise<R|null>`, `close()`. `Owned` `R`: `port.recv()` only under `await`; bind `const m=await port.recv()` & narrow `!==null` before move. `main` exit stops isolates. `FakeSpawn` executes entries in-process asynchronously through `Port` pack/unpack with trap propagation and `T006` deadlock detection.
- **Audio (`managed`)**: `audio.open` moves `state:S` (`Vec`/`Pool`/`Arena`/`Ring*`/`Struct`). `render`: module-level non-generic safe `"use rt"` fn (`E2013`): `(st:Mut<S>|S, out:Mut<Slice<f32>>, frames:usize):void` (`Mut<S>` if `Owned`, else `S`); `out.length===frames*channels` (interleaved PCM `out[frame*channels+ch]`, pre-zeroed).
- **Cross-thread traps**: First trap sets atomic flag; foreign traps surface on main at earliest of `strict`/`rt` return, next `await`/`recv`, or `main` exit. `cfn`/audio emit silence once set.

## 9. C FFI & `"use unsafe"`

- `declare module "c:<pkg>:<header>" { ... }` (`pkg`/`header` non-empty, no space/ctrl/`:`/`<`/`>`/`"`/`\`: `E7002`; 1/spec/file; must import in declaring file, cross-file `E7002`). Allowed: `function f(ffi:Ffi,...):R;` (`Ffi` omitted in C and `"use rt"; "use unsafe"` calls, passed in `strict+unsafe`; rest numeric/`boolean`/`Ptr`/`ConstPtr`, ret same/`void`: `E4007`); `const NAME:T;` (`i8..u64|usize|f32|f64|boolean`); `type S=CStruct<{field:FieldT;...}>;` (`FieldT`: numeric/`boolean`/`Ptr`/`ConstPtr`/`CType`/`CStruct`). Pointees allow `void` (`Ptr<void>`/`ConstPtr<void>`).
- **C map (LP64)**: ints->`intN_t`/`uintN_t`, `usize`->`size_t` (C ret/`cfn` param `<=2^32-1`, `T003`), `f32`/`f64`->`float`/`double`, `boolean`->`bool`, `Ptr`/`ConstPtr`->`P*`/`const P*` (`void`->`void`, `CType<"X">`->`X`, `CStruct`->struct, fn->fn*, `Owned` box->`void`). Pointee `usize`: `E4007`.
- **P4 (`E2009`)**: `check` runs `pkg-config`+`cc -std=gnu11` `_Static_assert`s on prototypes (no `()`), `const`s, `CStruct` layout; attaches `cc` stderr.
- **Unsafe (`E4008` outside `"use unsafe"`)**: Safe code calls `"use unsafe"` `strict` fns whose sigs lack raw `Ptr`/`ConstPtr`/`CType`/`CStruct` (`CHandle<CStruct|CType>` OK). Inside `"use unsafe"`:
  1. `Ptr<T>`/`ConstPtr<T>` (`T` allows `void`; args/ret/locals/`Ptr*`/`cast<U>`; no `Struct`/`Vec`/union/`Ptr.box` `E4008`; null->`T015` except `isNull`/`cast`): `isNull():boolean`, `read():T`*(Copy/`CStruct`)*, `write(x:T):void`*(Copy/`CStruct`)*, `offset(n:usize):Ptr<T>`, `slice(n:usize)`*(arg/recv)*, `borrow()`*(arg/recv boxed `Owned`)*, `cast<U>():Ptr<U>`*(keeps `const`)*, `Ptr.null<T>():Ptr<T>`, `Ptr.sizeOf<T>():usize`*(C `sizeof` Copy/`CStruct`/`Ptr*`/`CType`; !`void`/fn; P4/C)*, `Ptr.box<T>(alloc,x):Ptr<T>`*(non-rt `E4004`, OOM `T006`)*, `unbox():T`*(non-rt `E4004`)*.
  2. `CType<"X">` (`typedef` id; only in `Ptr`/`ConstPtr`/`CHandle`/`cast`).
  3. `CHandle.create<T>(p:Ptr<T>):CHandle<T>`, `h.get():Ptr<T>` (`T`: `CStruct`|`CType`).
  4. `cfn(f)`: module-level non-generic `"use rt"` (or `"use rt"; "use unsafe"`) fn (`E4001`/`E4003`/`E4007`) -> `Ptr<F>` trampoline.
- **C-only (`E4009`)**: `c:`/unsafe needs `--backend=c`; JS/Wasm `run`/`test`/`build` emit `E4009` (`check`/`mutate` proceed).

## 10. Contracts, Testing, `forAll` & `szigyr mutate`

- **Contracts (`E6001` pos, `E6002` ref/mut)**: `requires(cond)` (fn top, params), `ensures((r:R)=>bool)` (after `requires`, `r`+params incl. `Ref`/`Mut` post-state reads; by-value `Owned`/move-only params `E6002`), `invariant(cond)` (loop top). `Pure` observe-only (no assigns/mutators/`Owned` moves/`Mut` borrows). Traps: `T004`/`T005`/`T010`.
- **Tests (`E6003`)**: Top-level `test("name",(t:Test)=>{...})` (`async` OK, `managed`, stripped outside `test`/`mutate`, use fakes). Entry-only by default; `szigyr test --all` also executes colocated `test(...)` in locally imported modules (deduplicated per run); `--filter=<pat>` filters by case-insensitive substring. `Test`: `ok(cond)`, `eq<T>(a,b)`, `eqSlice<T>(a:Ref<Slice<T>>,b:Ref<Slice<T>>)`, `traps(code: string, fn: () => void)`.
- **`forAll` (`E6004`/`E6005`)**: Inside `test(...)` (`E6004`); 100 runs (max 1,000 top-`requires` skips else test fails), deterministic RNG, shrinks counterexamples. Arg: safe module-level non-generic fn or annotated inline `(a:A,...)=>boolean|void` w/ optional top `requires`. Generatable: prims/nums (!`unknown`/`never`), lit/tagged unions, records, tuples, `Struct`, `Array`/`ReadonlyArray`, `Set`/`Map`, `Vec`/`Slice` (+ `Ref`/`Mut` of `Struct`/`Vec`/`Slice`).
- **`szigyr mutate`**: Single-build JS over `Mutatable` fns/classes (`c:`/unsafe stubbed); `--all` includes locally imported modules and their colocated `test(...)` blocks (deduplicated across multiple CLI file arguments), `--fail-on-survived` exits `1` if `survived > 0`. Any `test(...)` block reaching `c:`/`unsafe` code is skipped and reported in `summary.skippedTests` when non-empty (keep safe unit tests in separate `test(...)` blocks from `unsafe`/`c:` tests). 6 ops (`+`/`-`/`*`, cmp, `&&`/`||`, `if` bool, `0`/`1`/bool lit, expr-stmt del->`deadCode` tagging every surviving statement deletion), skipping provably equivalent `Vec.create` capacity hints and min/max/clamp/abs relational tie-breaking (`< <-> <=`, `> <-> >=`). Reachability + step cap `max(S*8+1000,10000)`->`timeout`, `.szigyr-cache/mutate.json`, witness search on `Pure` survivors, `// szigyr-equivalent: <reason>` (or `// szigyr-equivalent[<op>, ...]: <reason>` with `<op>` in `+ -> -`, `- -> +`, `* -> +`, `< -> <=`, `<= -> <`, `> -> >=`, `>= -> >`, `=== -> !==`, `!== -> ===`, `&& -> ||`, `|| -> &&`, `if -> true`, `if -> false`, `0 -> 1`, `num -> 0`, `true -> false`, `false -> true`, `delete-stmt`), summary `{killed,survived,timeout,cached,targets,skipped:[{fn,reason}],skippedTests?:string[]}`.
- **`szigyr prove` & `--release`**: Async per-function SMT-LIB2 verification (`SZIGYR_SMT`/`z3`/`cvc5`, Wasm `z3-solver` fallback) over safe top-level `strict`/`rt` (including parametric generic fns) and contracted fns without function parameters (excluding `unsafe`, fn-param fns, and `class` methods; `--all` deduplicates locally imported modules across multiple CLI file arguments) for integer/slice/contract obligations (`T001`/`T002`/`T003`/`T004`/`T005`/`T007`/`T009`/`T010`; unsigned `&`/`|`/`^` upper-bounded, floats/unmodeled fail-closed to `unknown`; canonical counting `for` loops synthesize SMT-verified auto-invariants). Reports counterexamples (`sat`), caches in `.szigyr-cache/prove.json`, exits `1` on failed obligations, or under `--strict` also on any `unknown`/`timeout` obligation. `szigyr build --release` omits proved checks (and `requires` on private non-generic non-managed callees proved at all sites) in C/Wasm output; dev `run`/`test` keep all checks.

## 11. Layout, Backends & CLI / JSON Contract

- **Layout (LE)**: Numerics natural (`usize` 4B; `i64`/`u64` 8B); `boolean` 1B; `null` 1B (`0`); lit/union `u32` (UTF-16 idx, 4B); Record/`Struct`: `kind`, UTF-16 fields aligned/padded; Tagged: `u32` tag+max; `T|null`: 1B tag+padded `T`; `Handle` 12B; `ArenaBuf` 16B.
- **Parity & Wasm**: C/Wasm: no FMA/fast-math; `strict`/`rt` use `DetMath`. Wasm (`wasm32`, `-nostdlib`) copies active `Slice`/`Vec`/`Arena` ranges across JS (`T013`).
- **CLI**: `szigyr <check|run|test|mutate|prove|build|query|explain|mcp> [--help|-h] [--json] [--watch] [--fix] [--all] [--filter=<pat>] [--fail-on-survived] [--strict] [--release] [--timeout=<ms>] [--backend=js|c|wasm|both|all] [--target=node|browser] [--mode=app|lib] [-o <dir>] [--no-cache] <args>` (`szigyr run ... [-- <args...>]` forwards arguments after `--` to `sys.proc.args()`; `build --target=node` emits `main.js` for `--mode=app` and `app.js` for `--mode=lib`; multi-file `check` deduplicates identical diagnostics across entries).
  - **Node `--mode=lib` host API (`app.js`)**: `const lib = await load(options?)` (`options.npm?: Record<string, unknown>` overrides bundled `npm:` modules) returns `{ exports, native, Vec, createSystem, run, stop }`: `exports` holds JS/BigInt-marshaled module exports, `native` exposes low-level C/Wasm runtime symbols, and `run(mainFn = exports.main, sysOpts?)` executes an entry function (`mainFn` required if the library has no `main`); create host buffers via `lib.Vec.fromTypedArray(alloc, src, elem)` (3 args: `alloc` from `lib.createSystem(...)` or `null`, array/TypedArray `src`, and numeric element name `elem` in `"i8"|"u8"|"i16"|"u16"|"i32"|"u32"|"i64"|"u64"|"usize"|"f32"|"f64"`), view via `vec.asTypedArray()` (zero-copy TypedArray), and release workers/resources via `await lib.stop()`.
  - **Exit**: `0` ok (or `Proc.setExitCode` value in normal `run`/built app), `1` error/fail/mismatch, `2` CLI/`CUnsupported`/`CBuildError`/nesting, `3` trap, `70` internal.
  - **Recovery**: `check`: P1->P2->P3->P4 past recoverable errors (no `<error>` cascades).
  - **`--json` & MCP**: Pure JSONL (`kind: "diagnostic"` on diagnostics; exit 2/70, `forAll`/`t.eq`/trap/mismatch details; on `run`, program `stdout`/`stderr` from `sys.log` pass through unchanged while diagnostics, traps, and backend mismatches emit JSONL on `stderr`). `query` includes `class` (`ctor`/`implements`/`fields`) & `interface` (`methods`); `explain <code>`: docs. `szigyr mcp`: 7 tools (`szigyr_check`/`query`/`explain`/`test`/`mutate`/`prove`/`run`), `resources` (`szigyr://spec`, `szigyr://builtins`), `timeoutMs`, `overlays` on `check`/`query`/`test`/`run`/`prove`, `args` on `szigyr_run`, `all`/`filter`/`summary` on `szigyr_test`, `all`/`failOnSurvived` on `mutate`, `all`/`noCache`/`strict` on `prove`, persistent worker w/ resident parser reuse.

## 12. Built-in Allowlist

- **Types**: §3.3, §5–§7, §9 (plus `RingPair`, `Resource`).
- **Globals**: `i8`..`f64`, `wrapAdd/Sub/Mul`, `divTrunc`, `rem`, `ok`, `err`, `panic(msg):never`, `cast<T extends Codec>(x):Result<T,CastError>`, `requires`, `ensures`, `invariant`, `test`, `forAll`, `cfn`.
- **Namespaces**: `Math` (`abs/sqrt/floor/ceil/trunc/round/sign(F):F` and `min/max(1+ F):F` where `F` is same-type `f32` or `f64`, `fround(f64):f32`, `PI`, `E`; *managed:* `sin/cos/tan/asin/acos/atan/atan2/exp/log/log2/log10/pow/hypot/cbrt`); `DetMath` (*all layers, `rt`-safe:* `sin/cos/tan/atan/exp/log/log10/tanh(f64):f64`, `atan2/pow(f64,f64):f64`); `Number` (*all layers:* `isFinite`/`isNaN`/`isInteger(f32|f64):boolean`, `MAX_SAFE_INTEGER`, `EPSILON`, `POSITIVE_INFINITY`, `NEGATIVE_INFINITY`, `NaN`; *managed:* `parseFloat(s):f64`); `JSON` *(managed:* `parse(s):Result<unknown,JsError>`, `stringify<T extends Codec>(v:T, indent?:u8):string`, requires concrete `T` without `i64`/`u64`, `E2002`, `get(v:unknown,k:string):Result<unknown,CastError>`, `keys(v:unknown):Result<Array<string>,CastError>`, `items(v:unknown):Result<Array<unknown>,CastError>`); `Url` *(managed:* `parseQuery(q:string):Array<QueryParam>`, `getQueryParam(q:string,k:string):string|null`, `formatQuery(xs:ReadonlyArray<QueryParam>):string`, `encodeComponent(s:string):string`, `decodeComponent(s:string):Result<string,IoError>`); `String` *(managed:* `fromCodePoint(c:u32):string`, `encodeUtf8(s:string,dst:Mut<Vec<u8>>):usize` *(overwrites `dst`)*, `decodeUtf8(src:Ref<Slice<u8>>):Result<string,IoError>`, `decodeUtf8Lossy(src:Ref<Slice<u8>>):string`); `RegExp` *(managed:* `compile(pattern:string,flags?:string):Result<RegExp,CastError>`); `Promise.all<T>(ps:Array<Promise<T>>):Promise<Array<T>>`; §5–§9 namespaces & fakes.
- **Members** (`[]` read `Array`/`ReadonlyArray`/`Vec`/`Slice`/tuple, write `Array`/`Vec`/`Slice`):
  - `string`: `length:usize`, `slice(s,e?)`, `indexOf(s):usize|null`, `includes`/`startsWith`/`endsWith`, `split(sep):Array<string>`, `trim`/`toUpperCase`/`toLowerCase`, `padStart`/`padEnd(n,f)`, `repeat(n)`, `replaceAll(a,b)`, `charCodeAt(i):u16` (`T002`), `codePointAt(i):u32|null`.
  - `Array<T>`: `length:usize`, `push(x):usize`, `pop():T|null`, `slice(s?,e?)`, `map((x,i)=>U)`, `filter((x,i)=>bool)`, `reduce((a,x,i)=>A,init)`, `forEach((x,i)=>void)`, `find():T|null`, `findIndex():usize|null`, `some`/`every`/`includes`, `indexOf():usize|null`, `join(sep?)`, `concat(roArr)`, `reverse`, `sort(cmp)`, `fill(x,s?,e?)` (`ReadonlyArray`: no `push/pop/reverse/sort/fill`).
  - `Map<K,V>`: `size:usize`, `get(k):V|null`, `set(k,v):Map`, `has`/`delete`/`clear`/`keys`/`values`/`entries`, `forEach((v,k)=>void)`. `Set<K>`: `size:usize`, `add(x):Set`, `has`/`delete`/`clear`/`values`, `forEach((x)=>void)`.
  - `RegExp` *(managed, stateless — no `g`/`y`)*: `source:string`, `flags:string`, `test(s:string):boolean`, `exec(s:string):RegExpMatch|null`, `findAll(s:string):Array<RegExpMatch>`, `replace(s:string,rep:string):string`, `replaceAll(s:string,rep:string):string`, `split(s:string):Array<string>`.

## 13. Codes, Reserved & Examples

- **Reserved (`E1000` decl/`E2000` ref)**: `bigint`,`undefined`,`FixedArray`,`Rc`,`Weak`,`decreases`.
- **Errors**: E1000 syntax, E1001 var, E1002 `==`/`!=`, E1003 def/`*`-exp, E1004 any, E1005 as, E1006 `!`, E1007 throw/try, E1008 opt/def, E1009 bad-unsafe; E2000 global, E2001 member, E2002 type/cap, E2003 mix-num, E2004 cond, E2005 switch, E2006 annot/ctx, E2007 int`/`, E2008 lit, E2009 C-hdr, E2010 Port, E2011 isolate, E2012 surr, E2013 audio; E3001 moved, E3002 loop-move, E3003 part-move, E3004 borrow, E3005 excl, E3006 Ref->Mut, E3007 Owned-mng, E3008 non-place; E4001 layer, E4002 non-Native, E4003 strict/rt-fn, E4004 rt-alloc, E4005 rt-rec, E4006 rt-auth, E4007 C-type, E4008 unsafe, E4009 C-only, E4010 poly-rec; E5001 global-auth, E5002 top-mut; E6001 ctr-pos, E6002 ctr-ref/mut, E6003 test-pos, E6004 forAll-pos, E6005 forAll-param; E7001 imp/exp, E7002 `c:`-mod; W8001 managed-loop-boundary-call.
- **Traps**: T001 ovf, T002 bounds, T003 cast/usize, T004 requires, T005 ensures, T006 panic/OOM/stack/JS, T007 div0, T008 OwnedCell, T009 shift, T010 invariant, T011 Handle, T012 ArenaBuf, T013 overlap, T014 Ring, T015 null-Ptr.

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
