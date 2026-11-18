# STS 言語仕様 v0（草案）

STS は仮称。この文書が言語の唯一の規範である。
**許可リスト方式**: この文書に明記された構文と組み込みだけを受理する。それ以外は拒否する（E1000 / E2000）。

## 0. 原則

1. **構文は TypeScript と完全互換。** ソースは TS のパーサでそのまま解析できる。
2. **意味は変えない、絞るだけ。** 受理されたプログラムの意味は「§10 の変換を施した JS の挙動」と定義する。禁止とトラップ以外に、JS と異なる計算結果を生む規則はない。
3. **managed 層は常に JS エンジン上で動く。** C に変換されるのは strict / rt 層だけ。C 側は JS 側と観測上一致しなければならない（戻り値、借用引数への書き込み、トラップの種類と位置）。
4. **関数境界はすべて明示。** 推論するのはローカル変数の型と、呼び出しの型引数だけ。
5. **未定のことを実装が決めない。** 未定の項目は §13。

## 1. モジュール

- ESM のみ。名前付きの `import` / `export` だけ。default export、`export *`、動的 import、`require` は禁止。
- 相対 import は拡張子 `.ts` まで書く。`import { parse } from "npm:yaml"` の形は §7.4。
- モジュール直下に書けるのは次だけ。
  - `import` / `export`
  - `function` 宣言、`type`、`interface`、`class`
  - `const`（初期化式は、リテラル、または不変なレコード・配列のリテラル。型注釈必須）
  - `test(...)` の呼び出し（§9.2）
- モジュール直下の `let`、および可変な値を持つ `const` は禁止（E5002）。
- §12 の組み込み名は予約されている。同名の宣言は禁止。組み込みは import なしで使える。

## 2. 層

層は指示子（文字列だけの文）で決まる。関数本体の先頭に書くとその関数に、ファイルの先頭に書くとそのファイルの全関数に適用される。

| 指示子 | 層 | 概要 |
| --- | --- | --- |
| なし | managed | JS エンジン上で動く。GC あり |
| `"use owned"` | strict | 所有権で管理。GC なし。C に変換される |
| `"use rt"` | rt | strict からメモリ確保・権限・再帰を除いたもの |
| `"use unsafe"` | （予約） | §13 |

呼び出しの規則（違反は E4001）。

| 呼び出し元 ＼ 呼び出し先 | managed | strict | rt |
| --- | --- | --- | --- |
| managed | 可 | 可 | 可 |
| strict | 不可 | 可 | 可 |
| rt | 不可 | 不可 | 可 |

- アロー関数と関数式は、外側の関数の層に属する。指示子は書けない。
- strict / rt では、外側の変数を捕捉する関数（クロージャ）は禁止（E4003）。関数値も v0 では禁止。例外は `ensures` の引数（§9.1）。
- strict / rt で使える型は §3.3 の型だけ（違反は E4002）。

## 3. 型

### 3.1 プリミティブと数値

- `boolean`、`string`（managed のみ）、`null`、`void`、`unknown`（managed のみ）、`never`。`undefined` は存在しない。
- 数値型: `f64`、`f32`、`i8`、`i16`、`i32`、`u8`、`u16`、`u32`、`usize`。
  - `number` は `f64` の別名。
  - `usize` は添字と長さの型。v0 では値の範囲は `u32` と同じ（0 〜 2^32−1）だが、`u32` とは別の型。
  - `i64`、`u64`、`bigint` は予約。
- **暗黙の数値変換はない。** 変換は型と同名の関数で行う: `i32(x)`、`f32(x)`、`usize(x)` など。
  - 整数型への変換は、値が整数でない、または範囲外ならトラップ（T003）。
  - `f32(x)` は最も近い binary32 に丸める。整数から浮動小数への変換は正確。
- **数値リテラルは文脈の型になる**（代入先、もう一方のオペランド、仮引数の型）。文脈がなければ `f64`。整数型の文脈で、非整数または範囲外のリテラルはコンパイルエラー（E2008）。
- 算術。
  - `+`、`-`、`*`: 両辺は同じ数値型（違えば E2003）。整数型で結果が範囲外ならトラップ（T001）。
  - `/`、`**`: 浮動小数型のみ。整数型の `/` は禁止（E2007）。
  - `%`: 浮動小数型のみ。
  - 整数の除算は `divTrunc(a, b)`（0 方向に切り捨て）と `rem(a, b)`。`b` が 0 ならトラップ（T007）。`divTrunc` は結果が範囲外ならトラップ（T001）。`rem` の結果は常に範囲内で、`rem(MIN, -1)` は 0 を返す（トラップしない）。整数型に -0 はなく、整数演算の結果の -0 は +0 にそろえる（Q090）。
  - 折り返し演算は `wrapAdd(a, b)`、`wrapSub(a, b)`、`wrapMul(a, b)`（同じ整数型）。
  - 単項 `-`: 符号つき整数と浮動小数のみ。結果が範囲外ならトラップ（T001）。
  - `++`、`--` は禁止。`+= 1` と書く。複合代入 `+=`、`-=`、`*=` は対応する演算と同じ規則。
  - `f32` の演算結果は、1演算ごとに binary32 に丸める。
- 比較 `<`、`<=`、`>`、`>=`、`===`、`!==`: 両辺は同じ型。`==`、`!=` は禁止（E1002）。
- ビット演算 `&`、`|`、`^`、`~`、`<<`、`>>`、`>>>`: `i32` と `u32` のみ。
  - `>>` は `i32` のみ（算術シフト）。`>>>` は `u32` のみ（論理シフト）。
  - シフト量は同じ型で 0 〜 31。範囲外はトラップ（T009）。
  - `<<` であふれたビットは捨てる（トラップしない）。
- 条件式（`if`、`while`、`for`、三項演算子、`&&`、`||`、`!`）のオペランドは `boolean` のみ（E2004）。

### 3.2 managed の複合型

- **レコード**: `type P = { readonly x: f64; y: f64 }`。閉じた正確な型。余剰プロパティ不可、幅による部分型なし。省略可能プロパティ（`?`）は禁止（E1008）。
- **タグつき union**: 各メンバがレコードで、共通フィールド `kind` に互いに異なる文字列リテラル型を持つ。絞り込みは `x.kind === "..."` と `switch (x.kind)`。`switch` は全メンバを網羅すること（E2005）。
- **文字列リテラルの union**: `type Color = "red" | "green"`。
- **`T | null`**: 絞り込みは `x === null` / `x !== null`。`??` と `?.` を使える。
- 上記以外の union と intersection は禁止。
- **コレクション**: `Array<T>`（不変）、`ReadonlyArray<T>`（共変）、`Map<K, V>`、`Set<T>`。`K` と `Set` の `T` は `string`、数値型、`boolean`、文字列リテラル型、文字列リテラル型だけの union のみ。ほかの union は E2002（Q081）。
  - `T[]` という書き方は禁止。`Array<T>` に統一する。
  - 添字と `length` の型は `usize`。添字アクセスは範囲検査され、範囲外はトラップ（T002）。
  - タプル型と配列の分割代入は禁止。
- **関数型**: `(a: A) => B`。managed のみ。引数は反変、戻り値は共変。
- **class**: 継承なし（`extends` 禁止）。フィールドは型つきで宣言する。`private`、`readonly`、`static`、`implements` は可。getter / setter、省略可能メンバ、index signature、`abstract`、`#private` は禁止。メソッドは呼び出し位置でしか参照できない（`const f = obj.m` は禁止）。
- **interface**: メソッドのシグネチャだけを持つ。class が `implements` で明示的に実装する。構造的な適合は認めない。`extends` は禁止。
- **ジェネリクス**: 関数、`type`、`class`、`interface` に型引数を書ける。制約は `T extends I`（`I` は interface）だけ。既定の型引数は禁止。
- **`unknown`**: 使うには `cast<T>(x): Result<T, CastError>` で実行時に検証する。`T` はプリミティブ、レコード、タグつき union、`Array`、`T | null` の組み合わせに限る。
- **文字列**: JS の文字列そのまま（`length` は UTF-16 の符号単位数）。strict / rt 層に文字列型はない。

禁止する型機能（E1004 〜、なければ E1000）:
`any`、`object`、`Function`、`{}`、`symbol`、`enum`、`namespace`、`as`（`as const` を含む）、非 null 表明 `!`、`satisfies`、型述語（`x is T`）、関数オーバーロード、宣言のマージ、`declare`、conditional / mapped / template literal / indexed access 型、`keyof`、型の `typeof`、ユーティリティ型（`Partial` など）、省略可能引数、既定引数、残余引数。

### 3.3 strict / rt の型

- 数値型、`boolean`。
- **`Struct<{ ... }>`**: 値型。`type V3 = Struct<{ readonly x: f32; readonly y: f32; readonly z: f32 }>`。
  - フィールドの型は、数値型、`boolean`、他の `Struct`、`Vec<T>`。
  - 値はオブジェクトリテラルで作る（型注釈のある文脈で）。
  - **Copy の判定**: 全フィールドが `readonly` で、かつ全フィールドの型が Copy なら、その Struct は Copy。それ以外は移動のみ（所有型）。数値型と `boolean` は Copy。
- **`Vec<T>`**: 所有される可変長配列。`T` は Copy 型のみ（v0）。所有型。

  | 操作 | 受け手の借用 | 確保 | 備考 |
  | --- | --- | --- | --- |
  | `Vec.create<T>(alloc: Alloc, capacity: usize): Vec<T>` | — | あり | 長さ 0 で作る |
  | `v.length` | Ref | なし | `usize` |
  | `v[i]`（読み） | Ref | なし | 範囲外は T002 |
  | `v[i] = x`（書き） | Mut | なし | 範囲外は T002 |
  | `v.push(x)` | Mut | あり | |
  | `v.pop(): T \| null` | Mut | なし | |
  | `v.clear()` | Mut | なし | |
  | `v.fill(x)` | Mut | なし | |
  | `v.slice(start, end)` | Ref / Mut | なし | 実引数の位置でのみ書ける（§5.5） |

- **`Slice<T>`**: `Vec<T>` の連続部分への借用ビュー。型としては `Ref<Slice<T>>` / `Mut<Slice<T>>` の形で、パラメータにだけ現れる。`s.length`、`s[i]`、`s.fill(x)`、`s.slice(a, b)` を使える。
  - `Vec<T>` の変数（または `Ref<Vec<T>>` / `Mut<Vec<T>>` のパラメータ）は、`Ref<Slice<T>>` / `Mut<Slice<T>>` のパラメータにそのまま渡せる。全体へのビューになる。
  - `v.slice(start, end)` は `start <= end <= v.length` でなければトラップ（T002）。
- **`Ref<T>` / `Mut<T>`**: 借用（§5.5）。
- **タグつき union** と **`T | null`**: メンバや `T` が Copy 型のときに限り使える。`Result<T, E>` も同じ条件。
- strict / rt の関数の型引数は、この節の型に限る。

## 4. 文と式

- `var` は禁止（E1001）。`let` は初期化必須。
- 使える制御構文: `if` / `else`、`while`、`do` / `while`、`for (;;)`、`for (const x of ...)`、`switch`（網羅必須）、`break`、`continue`、`return`。ラベルは禁止。
- `for...of` の対象は `Array`、`ReadonlyArray`、`Set`、`Map` の `keys()` / `values()`。
- `throw`、`try`、`catch`、`finally` は禁止（E1007）。回復不能なエラーは `panic(msg)`、回復可能なエラーは `Result`。
- `async` / `await` は managed のみ。
- 分割代入は、レコードの `const { x, y } = p` だけ。
- オブジェクトのスプレッド `{ ...a, x: 1 }` は、結果が注釈の型と正確に一致するとき可。配列のスプレッドは managed で可。
- テンプレートリテラルは managed で可（タグつきは禁止）。
- 禁止: `with`、`eval`、`delete`、`in`、`instanceof`、値の `typeof`、`void` 演算子、カンマ演算子、`arguments`、ジェネレータ、`new Function`、`Proxy`、`Reflect`、`Symbol`、`for...in`、`this` のクラス外での使用。

## 5. 所有権

### 5.1 用語

- **Copy 型**: 数値型、`boolean`、Copy の Struct、Copy 型だけからなる union。代入や引数渡しで複製される（どちらも不変なので、複製か共有かは観測できない）。
- **所有型**: 非 Copy の Struct と `Vec<T>`。ちょうど1つの束縛に所有される。

### 5.2 移動

所有型の値は、次の操作で移動する。

1. 別の変数への代入、または初期化（`const b = a`）。
2. 値渡しパラメータ（型が `Ref` / `Mut` でないパラメータ）への実引数。
3. `return`。
4. Struct リテラルのフィールドへの格納。

移動元の変数は、それ以後使えない（E3001）。`let` 変数は、再代入すればまた使える。

### 5.3 検査

- 検査は制御フローに沿って行う。分岐の一方で移動した変数は、合流後は移動済みとして扱う。
- ループ本体の中で、ループの外で宣言された変数を移動するのはエラー（E3002）。同じ反復の中で必ず再代入される場合は可。
- 所有型フィールドだけを取り出す部分移動（`const v = s.buf`）はエラー（E3003）。分解するなら `const { buf, n } = s` で全体を移動する。

### 5.4 破棄

所有型の値は、移動されないままスコープを抜けると破棄される。破棄は観測できない（デストラクタはない）。

### 5.5 借用

パラメータの型に `Ref<T>`（読み取り）または `Mut<T>`（排他的な書き込み）を書く。`T` は所有型か `Slice<U>`。

- **実引数は場所式に限る**（E3008）: ローカル変数、受け取った `Ref` / `Mut` パラメータ、それらのフィールドパス（`s.buf`）、`v.slice(a, b)`。
- 呼び出し側には借用の記号を書かない。モードは呼び出し先のシグネチャで決まる。
- 借用で渡した変数は、呼び出しの後もそのまま使える。
- `const` と `let` の違いは再代入の可否だけ。所有していれば `Mut` で渡せる。
- `Ref` で受け取った値を `Mut` に渡すことはできない（E3006）。`Mut` で受け取った値を `Ref` に渡すのは可。
- **排他性**（E3005）: 1つの呼び出しの中で、ある変数を `Mut` で渡すなら、同じ変数を他の実引数（`Ref`、`Mut`、値渡しのいずれでも）に使えない。メソッド呼び出しの受け手も実引数の1つとして数える。
  - v0 では、フィールドや `slice` の範囲が重ならなくても、根の変数が同じなら重複とみなす。
  - 実引数の式の評価結果が Copy 値なら、その式の中の借用は評価が終わった時点で終了する。`v.push(v.length)` は可。
- **二級性**（E3004）: `Ref<T>` / `Mut<T>` 型の値は、
  1. ローカル変数に代入できない。
  2. フィールドや配列の要素に格納できない。
  3. `return` できない。
  4. クロージャに捕捉できない。
  5. 型引数にできない。
  6. 他の関数の `Ref` / `Mut` パラメータに渡すことはできる。

### 5.6 managed 層での所有型

- 所有型の値は、managed 層のコードの中でも §5.2 〜 §5.5 の規則に従う。
- 所有型の値は、managed のレコード、class のフィールド、`Array`、`Map`、`Set`、クロージャの捕捉に入れられない（E3007）。置けるのはローカル変数、引数、戻り値だけ。
- 長く保持するには `OwnedCell<T>` を使う。`OwnedCell` 自体は managed の値。

  | 操作 | 挙動 |
  | --- | --- |
  | `OwnedCell.create<T>(v: T): OwnedCell<T>` | `v` を移動して入れる |
  | `cell.take(): T` | 取り出す。空ならトラップ（T008） |
  | `cell.put(v: T): void` | 入れる。空でなければトラップ（T008） |
  | `cell.isEmpty(): boolean` | |

## 6. rt 層

strict の規則に加えて、次を禁止する。

- 表で「確保あり」の操作（E4004）。
- 権限型のパラメータ（E4006）。`Alloc` も含む。
- rt 関数の間の再帰（直接・相互とも。E4005）。
- `OwnedCell`。

使えるのは、数値演算、Struct、借用した `Vec` / `Slice` の読み書き、他の rt 関数の呼び出し。

トラップしうる演算（整数の溢れ、範囲外アクセスなど）は、v0 では許可する。コンパイラは、rt 関数ごとのトラップしうる箇所の一覧を出せること（段階 2）。

## 7. 権限

### 7.1 権限型

`System`、`Alloc`、`Fs`、`Net`、`Clock`、`Random`、`Log`、`Js`、`Ffi`（予約）、`Spawn`（予約）。いずれも不透明な組み込み型。

- プログラムの入口は `export function main(sys: System): void`（または `Promise<void>`）。
- 個別の権限は `sys.alloc`、`sys.fs`、`sys.clock` のように `System` から取り出して、必要な関数にだけ渡す。
- 権限は値として渡せる。managed のレコードや class のフィールドにも入れられる。
- 段階 1 で実装する最小の API。これ以外は `docs/OPEN_QUESTIONS.md` に提案を書いてから足す。

  | 権限 | メソッド |
  | --- | --- |
  | `Log` | `info(msg: string): void`、`warn(msg: string): void`、`error(msg: string): void` |
  | `Clock` | `nowMs(): f64` |
  | `Random` | `nextF64(): f64`（0 以上 1 未満）、`nextU32(): u32` |
  | `Fs` | `readText(path: string): Result<string, IoError>`、`writeText(path: string, text: string): Result<null, IoError>` |
  | `Alloc` | メソッドなし。`Vec.create` などに渡すだけ |
  | `Net` | 予約 |

- `IoError` は `{ readonly code: string; readonly message: string }`。

### 7.2 大域の権限はない

使える大域の名前は §12 の一覧だけ。`console`、`Date`、`Math.random`、`fetch`、`process`、`globalThis`、`setTimeout` などは使えない（E5001。対応する権限を受け取る修正候補を付ける）。

### 7.3 決定的な関数

パラメータの型に、権限型、関数型、interface 型、`unknown`、`JsRef` のいずれも含まない関数を「決定的」と呼ぶ。コンパイラはこれを判定して問い合わせに答えられること。テストのキャッシュとミューテーションテストの対象選別に使う。

### 7.4 npm（`Js` 権限）

- `import { parse } from "npm:yaml"` で束縛される名前の型は `JsRef`（不透明）。
- `JsRef` に対してできる操作は、`Js` 権限のメソッドだけ。

  | メソッド | 型 |
  | --- | --- |
  | `js.call(f: JsRef, args: Array<JsRef>)` | `Result<JsRef, JsError>` |
  | `js.get(obj: JsRef, key: string)` | `Result<JsRef, JsError>` |
  | `js.await(v: JsRef)` | `Promise<Result<JsRef, JsError>>` |
  | `js.decode<T>(v: JsRef)` | `Result<T, CastError>`（`T` の条件は `cast` と同じ） |
  | `js.encode<T>(v: T)` | `JsRef` |

- JS 側で投げられた例外は、境界で `JsError` に変換される。
- `npm:` の import と `JsRef` は managed 層でのみ使える。

## 8. エラーとトラップ

- `Result<T, E>` は次の型の別名。`ok(v)` と `err(e)` で作る。

  ```ts
  type Result<T, E> =
    | { readonly kind: "ok"; readonly value: T }
    | { readonly kind: "err"; readonly error: E };
  ```

- `panic(msg: string): never` はトラップを起こす。
- **トラップは回復不能。** STS のコードからは捕捉できない。受け取るのはホスト（テストランナー、`main` の呼び出し元）だけ。
- トラップの種類。

  | コード | 原因 |
  | --- | --- |
  | T001 | 整数演算の結果が範囲外 |
  | T002 | 添字が範囲外 |
  | T003 | 数値変換の失敗 |
  | T004 | `requires` の違反 |
  | T005 | `ensures` の違反 |
  | T006 | `panic` |
  | T007 | 0 による整数除算 |
  | T008 | `OwnedCell` の誤用 |
  | T009 | シフト量が範囲外 |
  | T010 | `invariant` の違反 |

## 9. 契約とテスト

### 9.1 契約

- `requires(cond: boolean)`: 関数本体の先頭（指示子の直後）に 0 個以上書ける。参照できるのは引数だけ。
- `ensures((r: R) => boolean)`: `requires` の後に 0 個以上書ける。`r` は戻り値。式の中で参照できるのは `r` と Copy 型の引数だけ。この関数式は、strict / rt のクロージャ禁止の例外とする。
- `invariant(cond: boolean)`: ループ本体の先頭に書ける。
- 位置の違反は E6001、参照の違反は E6002。
- 契約の式は、その関数と同じ層の制限に従う。
- v0 では、契約は開発時も出力時も実行時に検査する。違反はトラップ（T004 / T005 / T010）。

### 9.2 テスト

- モジュール直下に `test("名前", (t: Test) => { ... })` と書く（E6003）。非同期なら `async (t: Test) => { ... }`。
- テストの本体は managed 層のコード。
- `Test` のメソッド。

  | メソッド | 挙動 |
  | --- | --- |
  | `t.ok(cond: boolean)` | 偽なら失敗 |
  | `t.eq<T>(a: T, b: T)` | 構造的に比較。`T` は managed の値か Copy 型（プリミティブ、レコード、union、`Array`、Copy の Struct） |
  | `t.eqSlice<T>(a: Ref<Slice<T>>, b: Ref<Slice<T>>)` | 長さと全要素を比較。`Vec` を移動せずに比べるためのもの |
  | `t.traps(code: string, f: () => void)` | `f` が指定のコードでトラップしなければ失敗。トラップを観測する唯一の手段 |

- **テストに本物の権限は渡されない。** 必要なら偽の権限を自分で作る: `FakeClock.create(0)`、`SeededRandom.create(42)`、`MemoryLog.create()`、`FakeFs.create()`、`TestAlloc.create()`。
- テストは `sts test` のときだけ登録される。それ以外のビルドでは除去される。

## 10. 開発時の変換（JS バックエンド）

変換はファイル単位で行う。他のファイルについて必要なのは、export された宣言のシグネチャだけ（シグネチャはすべて注釈されているので、構文だけから取り出せる）。

1. 型注釈、`type`、`interface` を取り除く。
2. 整数型の `+`、`-`、`*`、単項 `-`、複合代入に範囲検査を入れる（T001）。
3. `f32` の演算結果を `Math.fround` で丸める。
4. `u32` のビット演算の結果を符号なしに正規化する。シフト量を検査する（T009）。
5. 変換関数、`wrap*`、`divTrunc`、`rem` をランタイム関数の呼び出しにする。
6. 添字アクセスに範囲検査を入れる（T002）。
7. `undefined` を返しうる組み込み（`Map.get`、`Array.find`、`pop` など）と `?.` の結果を `null` に正規化する。
8. 契約を検査コードにする。`ensures` はすべての `return` の経路で検査する。
9. 値の表現。
   - Struct: プレーンなオブジェクト。
   - `Vec<数値型>`: 対応する TypedArray を包んだもの。それ以外の `Vec`: 配列を包んだもの。
   - `Slice`: 同じバッファへのビュー。
   - 移動、借用、破棄: 何も生成しない（検査はコンパイル時に済んでいる）。
10. `test(...)` はテスト実行時だけ残す。
11. ソースマップを出す。トラップの位置はソース上の位置で報告する。

生成される JS が人間に読める必要はない。

### 10.1 C バックエンドが一致させるべきこと（段階 2）

- 評価順は左から右（オペランド、実引数とも）。
- 浮動小数点は IEEE 754 の binary32 / binary64。積和の融合と fast-math は禁止。
- strict / rt で使える `Math` の関数は、両方で結果が正確に一致するものに限る: `abs`、`sqrt`、`floor`、`ceil`、`trunc`、`round`、`min`、`max`、`sign`、`fround`。`round` などは JS の定義に合わせること。`sin` や `exp` などは strict / rt では使えない（標準ライブラリの数学関数は §13）。
- トラップは、種類とソース上の位置が JS 側と一致すること。

## 11. 診断

`--json` を付けると、診断を1行に1つの JSON で出す。

```json
{"code":"E3001","severity":"error","message":"use of moved value 'buf'","file":"src/a.ts","range":{"start":{"line":12,"col":9},"end":{"line":12,"col":12}},"data":{"variable":"buf","movedAt":{"line":10,"col":14}},"fixes":[{"title":"...","edits":[{"range":{"start":{"line":12,"col":9},"end":{"line":12,"col":12}},"newText":"..."}]}]}
```

- 行と列は 1 始まり。
- `message` は英語で短く書く。機械が読むのは `code` と `data`。
- `fixes` は、機械的に直せるときに付ける（例: `usize` と比較される `let i = 0` に対して `let i: usize = 0`）。
- コードの初期割り当て。追加は連番で行い、一度割り当てた意味は変えない。

  | コード | 意味 |
  | --- | --- |
  | E1000 | 仕様にない構文 |
  | E1001 | `var` |
  | E1002 | `==` / `!=` |
  | E1003 | default export、`export *` |
  | E1004 | `any` |
  | E1005 | `as` |
  | E1006 | 非 null 表明 `!` |
  | E1007 | `throw` / `try` |
  | E1008 | 省略可能なプロパティや引数、既定引数 |
  | E2000 | 仕様にない大域名 |
  | E2001 | 仕様にない組み込みメンバ |
  | E2002 | 型の不一致 |
  | E2003 | 数値型の混在 |
  | E2004 | 条件式が `boolean` でない |
  | E2005 | `switch` が網羅的でない |
  | E2006 | 必須の型注釈がない |
  | E2007 | 整数型の `/` |
  | E2008 | 数値リテラルが型の範囲外 |
  | E3001 | 移動済みの値の使用 |
  | E3002 | ループ内での外側の変数の移動 |
  | E3003 | 部分移動 |
  | E3004 | 借用の二級性の違反 |
  | E3005 | 排他性の違反 |
  | E3006 | `Ref` から `Mut` への変換 |
  | E3007 | 所有型の値を managed のコンテナやクロージャに入れた |
  | E3008 | 借用の実引数が場所式でない |
  | E4001 | 層の呼び出し規則の違反 |
  | E4002 | strict / rt で使えない型 |
  | E4003 | strict / rt でのクロージャや関数値 |
  | E4004 | rt でのメモリ確保 |
  | E4005 | rt での再帰 |
  | E4006 | rt での権限 |
  | E5001 | 大域の権限の使用 |
  | E5002 | モジュール直下の可変状態 |
  | E6001 | 契約の位置が不正 |
  | E6002 | 契約が参照できない名前を参照 |
  | E6003 | `test` がモジュール直下にない |
  | E7001 | 不正な import / export の形 |

## 12. 組み込みの許可リスト

ここにない大域名は E2000、ここにないメンバは E2001。追加が必要なら `docs/OPEN_QUESTIONS.md` に書く。

- **型**: `boolean`、`string`、`number`、`f64`、`f32`、`i8`、`i16`、`i32`、`u8`、`u16`、`u32`、`usize`、`null`、`void`、`unknown`、`never`、`Array`、`ReadonlyArray`、`Map`、`Set`、`Promise`、`Result`、`Struct`、`Vec`、`Slice`、`Ref`、`Mut`、`OwnedCell`、§7.1 の権限型、`JsRef`、`JsError`、`CastError`、`IoError`、`Test`。
- **関数**: 数値型と同名の変換関数、`wrapAdd`、`wrapSub`、`wrapMul`、`divTrunc`、`rem`、`ok`、`err`、`panic`、`cast`、`requires`、`ensures`、`invariant`、`test`。
- **`Math`**:
  - 全層: `abs`、`sqrt`、`floor`、`ceil`、`trunc`、`round`、`min`、`max`、`sign`、`fround`、定数 `PI`、`E`。
  - managed のみ: `sin`、`cos`、`tan`、`asin`、`acos`、`atan`、`atan2`、`exp`、`log`、`log2`、`log10`、`pow`、`hypot`、`cbrt`。
  - `random` は使えない。
- **`Number`**: `isFinite`、`isNaN`、`isInteger`、`parseFloat`、`MAX_SAFE_INTEGER`、`EPSILON`。
- **`JSON`**: `parse`（戻り値は `Result<unknown, JsError>`。構文エラーは `err` で、`error.code` は `"SyntaxError"`）、`stringify`。JS の例外を投げるほかの組み込みとスタックの枯渇は T006（Q035）。
- **`string` のメンバ**: `length`、`slice`、`indexOf`、`includes`、`startsWith`、`endsWith`、`split`、`trim`、`toUpperCase`、`toLowerCase`、`padStart`、`padEnd`、`replaceAll`（文字列の引数のみ）、`charCodeAt`、`codePointAt`。`String.fromCodePoint`。
- **`Array` のメンバ**: `length`、`push`、`pop`、`slice`、`map`、`filter`、`reduce`（初期値必須）、`forEach`、`find`、`findIndex`、`some`、`every`、`includes`、`indexOf`、`join`、`concat`、`reverse`、`sort`（比較関数必須）、`fill`。
- **`Map` のメンバ**: `get`（`V | null`）、`set`、`has`、`delete`、`size`、`clear`、`keys`、`values`、`forEach`。反復の順序は挿入順。
- **`Set` のメンバ**: `add`、`has`、`delete`、`size`、`clear`、`values`、`forEach`。
- **`Promise`**: `await` と `Promise.all` のみ。`await` のオペランドには、両方の枝が Promise の式である条件式（`await (c ? g() : h())`）も書ける（Q130）。
- **標準ライブラリの偽の権限**: `FakeClock`、`SeededRandom`、`MemoryLog`、`FakeFs`、`TestAlloc`。

## 13. 予約と未定

実装しない。使われたら E1000 か E2000 で拒否する。括弧内は導入予定の段階。

- `i64`、`u64`、64 ビットの `usize`（未定）
- `Vec` の非 Copy 要素、`FixedArray<T, N>`、重ならない範囲への同時借用（段階 2 の後半で提案）
- アリーナ、プール、ハンドル、領域ブランドつきポインタ、`Rc` / `Weak`、`using` と破棄可能な資源（段階 2 の後半で提案）
- strict / rt での関数値とコールバック（段階 2 の後半で提案）
- strict / rt 用の数学関数ライブラリ（`sin`、`exp` など。段階 2）
- `Ffi`、`extern` 宣言、`"use unsafe"`、`Ptr<T>`（段階 3）
- isolate と `Spawn`、rt スレッド、ロックフリーのリングバッファ（段階 3）
- `forAll` と性質テスト、ミューテーションテスト（段階 4）
- 本物の権限を使う統合テスト（段階 4）
- `decreases` と静的証明（段階 6）
- タプル、既定引数、interface の `extends`（未定）

## 付録 A: 受理される例

```ts
// A-1: managed。Result とタグつき union
type Shape =
  | { readonly kind: "circle"; readonly r: f64 }
  | { readonly kind: "rect"; readonly w: f64; readonly h: f64 };

export function area(s: Shape): f64 {
  switch (s.kind) {
    case "circle": return Math.PI * s.r * s.r;
    case "rect": return s.w * s.h;
  }
}

test("area of rect", (t: Test) => {
  t.eq(area({ kind: "rect", w: 2, h: 3 }), 6);
});
```

```ts
// A-2: rt。借用と契約
export function mixInto(out: Mut<Slice<f32>>, src: Ref<Slice<f32>>, gain: f32): void {
  "use rt";
  requires(out.length === src.length);
  for (let i: usize = 0; i < out.length; i += 1) {
    out[i] = out[i] + src[i] * gain;
  }
}

test("mixInto adds scaled source", (t: Test) => {
  const alloc = TestAlloc.create();
  const a = Vec.create<f32>(alloc, 2);
  a.push(1); a.push(2);
  const b = Vec.create<f32>(alloc, 2);
  b.push(10); b.push(20);
  mixInto(a, b, 0.5);
  t.eq(a[0], 6);
  t.eq(a[1], 12);
});
```

```ts
// A-3: strict。所有権の移動と Struct
type Buffer = Struct<{ data: Vec<f32>; readonly rate: u32 }>;

export function makeBuffer(alloc: Alloc, n: usize, rate: u32): Buffer {
  "use owned";
  const data = Vec.create<f32>(alloc, n);
  const b: Buffer = { data, rate };   // data はここで移動する
  return b;
}
```

```ts
// A-4: 権限。大域の console ではなく Log を受け取る
export function main(sys: System): void {
  greet(sys.log, "world");
}

function greet(log: Log, name: string): void {
  log.info(`hello, ${name}`);
}
```

## 付録 B: 拒否される例

```ts
// B-1  expect: E3001（移動済みの値の使用）
function f(alloc: Alloc): usize {
  "use owned";
  const a = Vec.create<f32>(alloc, 4);
  const b = a;
  return a.length;
}
```

```ts
// B-2  expect: E3005（同じ変数を Mut と Ref で同時に渡している）
function copyInto(dst: Mut<Slice<f32>>, src: Ref<Slice<f32>>): void { "use rt"; }
function g(v: Mut<Slice<f32>>): void {
  "use rt";
  copyInto(v, v);
}
```

```ts
// B-3  expect: E3004（借用をローカル変数に保存している）
function h(v: Ref<Slice<f32>>): f32 {
  "use rt";
  const w = v;
  return w[0];
}
```

```ts
// B-4  expect: E4004（rt でのメモリ確保）
function p(v: Mut<Vec<f32>>): void {
  "use rt";
  v.push(1);
}
```

```ts
// B-5  expect: E2003（数値型の混在）
function q(a: i32, b: f64): f64 {
  return a + b;
}
```

```ts
// B-6  expect: E2007（整数型の /）
function r(a: i32, b: i32): i32 {
  return a / b;
}
```

```ts
// B-7  expect: E5001（大域の権限）
function s(): void {
  console.log("hi");
}
```

```ts
// B-8  expect: E3007（所有型の値を managed の配列に入れている）
function u(alloc: Alloc): Array<Vec<f32>> {
  const xs: Array<Vec<f32>> = [];
  xs.push(Vec.create<f32>(alloc, 1));
  return xs;
}
```

```ts
// B-9  expect: E1005（as）
function w(x: unknown): string {
  return x as string;
}
```

```ts
// B-10  expect: E4001（rt から managed を呼んでいる）
function managedHelper(x: f64): f64 { return x; }
function z(x: f64): f64 {
  "use rt";
  return managedHelper(x);
}
```
