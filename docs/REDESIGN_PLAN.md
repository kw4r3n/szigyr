# Szigyr 根本設計の見直し計画（段階 5 完了時点）

2026-11-21

## 1. 位置づけと前提

- この文書は、段階 5 完了時点における設計監査の洗い出し結果と、根本設計を見直すための作業計画をまとめた設計メモである。
- `docs/SPEC.md`、`docs/DECISIONS.md`、`docs/ROADMAP.md` に反映されるまでは非規範（作業用の基準メモ）として扱う。
- これまでに積み上げた 1,093 件の適合テスト、JS / C / Wasm の 3 バックエンド一致、手書き C 比 1.38 倍以内のベンチマーク資産は捨てず、ゼロからの書き直しは行わない。上流の公理と型モデルから順に引き直し、差分適用する。

---

## 2. 現状の設計課題（棚卸し）

### A. AI フレンドリー性の課題

1. **規範の肥大・分散**
   - `docs/Szigyr-design-v0.md` は「学習データが存在しない言語なので、`SPEC.md` 1 ファイル（目安 1 万トークン以内）を常時コンテキストに置く」と定めているが、`docs/SPEC.md` 単体で 106 KB / 957 行（日本語で概算 4〜5 万トークン）まで膨らんでいる。
   - さらに `docs/SPEC.md` は自己完結しておらず、本文中に 73 件の `Qxxx` 参照を残したまま、`docs/OPEN_QUESTIONS.md`（263 KB / 1,782 行）に日常必須の仕様が散逸している。
   - `indexOf` の `null` 化（Q031）、`string + string` 禁止（Q019）、文脈型なしの `{ x: 1 }` / `ok(1)` が `E2006` になる規則（Q021・Q037）、`===` の型制限（Q017）、組み込みメソッド・`Math`・偽権限の正確なシグネチャ（Q032・Q033・Q038）が `docs/SPEC.md` に統合されていない。

2. **TS 事前学習バイアスとの負の転移＋原則 1 破れ**
   - 拡張子が `.ts` のままで構文も TS 互換のため、AI が持つ TS の慣用句（事前学習バイアス）が強く発火する。
   - 特に `for (let i = 0; i < v.length; i++)` は、`i++` の `E1000` と、型注釈なし `let i = 0` の `f64` 推論による `v.length`（`usize`）との `E2003` という二重トラップになる。
   - 原則 1「意味は変えない、絞るだけ」に反し、`indexOf` の `-1` → `null` 化、`JSON.parse` の例外 → `Result` 化、`charCodeAt` の `NaN` → `T002` など実行時意味論を変えた組み込みが混在しており、AI の TS 知識がそのまま誤りになる。

3. **構造化診断（`data`・`fixes`）の形骸化とコード過積載**
   - `docs/SPEC.md` §11 は「機械が読むのは `code` と `data`」と定めるが、実装上 `data` を出力しているのは全約 50 コード中 `E3001`（`packages/compiler/src/ownership.ts`）、`E5001`（`packages/compiler/src/expr.ts`）、`W8001`（`packages/compiler/src/boundary.ts`）の 3 種のみである。最頻出の `E2002`・`E2003`・`E2005`・`E3005`・`E4001` にも `data` がない。
   - `docs/DIAGNOSTICS.md` のとおり、`E1000` に約 50 種、`E2002` に約 30 種の異質な違反が押し込まれており、機械可読なサブ種別がないため AI は英語 `message` の解釈に頼らざるを得ない。
   - `fixes` は 6 パターン（`var`、`==`/`!=`、`T[]`、`++`/`--`、未注釈 `let i = 0` の `E2003`、4 大域名の `E5001`）のみ。`E2007`（`/` → `divTrunc`）、`E1008`（`x?: T` → `x: T | null`）、`string + string`、欠落 `case` などの自明な修正候補が欠け、`E5001` の fix も仮引数追加だけで呼び出し式（`console.log` → `log.info` 等）は書き換えない。

4. **フェーズ単位の早期停止**
   - `packages/compiler/src/index.ts` の `analyze()` は `P1 → P2 → P3 → P4` の順で実行し、前段に 1 件でもエラーがあると後段を実行しない。
   - そのため AI が書いたコードに複数の誤りがあると、1 回の `check` で全件回収できず「P1 修正 → P2 修正 → P3 修正 → P4 修正」と往復ターン数が増える。

5. **関数本体から暗黙推論される型パラメータ制約**
   - `packages/compiler/src/types.ts` に 12 種の暗黙の型パラメータ制約 `TParam.need`（`key`、`copy`、`layout`、`cross`、`crossp`、`field`、`borrow`、`eq`、`nopromise`、`noabuf`、`send`、`noauth`）があり、構文で明示できず本体解析＋プログラム全体の不動点計算で事後推論される。
   - 原則 6「推論は関数の中だけ。関数境界はすべて明示」および `docs/SPEC.md` §10「他ファイルについて必要なのは export のシグネチャだけ」と矛盾し、AI がシグネチャだけ読んでも呼び出し可否を予測できない。

6. **15 種以上の非直交な型部分集合ルール**
   - 統一的な型能力（トレイト軸）がなく、`packages/compiler/src/types.ts` と `packages/compiler/src/gendesc.ts` に機能別の個別述語が乱立している。
   - `Vec<T>` は `Port` で送れるが `Ptr.box` と `Audio.open` には入れられない、`Result<null, E>` は managed の標準形なのに strict / rt 境界では `E4002`、strict / rt の不変値レコードに `Struct<{ readonly ... }>` と `{ readonly ... }` の 2 通りがあり非互換（`cast<T>` / `JSON.stringify` は後者のみ許可）、`Handle<T>` や `Ptr<T>` に `===` が使えない、など AI が一般則から演繹しにくい非対称が多い。

7. **C FFI の盲目診断と生オフセット手書き**
   - `packages/compiler/src/headercheck.ts` が `cc` 実行時の stderr を破棄しているため、`E2009` 発生時に「関数名誤り・マクロ・プロトタイプ無し・何番目の引数の型違い」の区別が付かない。
   - C 構造体レイアウトや `#define` / `enum` 定数の取り込みがないため、`examples/audio/main.ts` のように `spec32.offset(0).write(33056)` や `4294967295` といった生バイトオフセットとマジックナンバーの手書きを AI に強いている。

8. **AI 向けツール欠如と JSON 契約のブレ**
   - `docs/Szigyr-design-v0.md` が掲げる `query`、`explain <code>`、MCP サーバ、設定なしフォーマッタ、`--watch` / 常駐チェッカ、`sts mutate` の `equivalent` 印が未実装（`deterministicFunctions` と `rtTrapSites` は `packages/compiler/src/index.ts` の内部 API のみ）。
   - `packages/compiler/src/cli.ts` で `--json` 指定時でも exit 2 / 70 のエラーがプレーンテキストになる、診断の出力先がコマンドにより stdout（`check` / `test` / `mutate`）と stderr（`run` / `build`）で割れる、`--backend=both` の `mismatch` は `--json` なしでも常に生 JSON を出す、など出力契約が一貫していない。
   - `packages/runtime-js/src/test.ts` の `forAll` 反例と `t.eq` 差分は構造化フィールドではなく英語文字列 `failure` に埋め込まれている。
   - `packages/compiler/src/mutate.ts` は `isDeterministic` なトップレベル関数だけを対象とするため、`Alloc` や偽権限（`FakeFs`・`FakeClock` 等）を受け取る関数、`RingRx` を使う rt 音声コールバック、`class` メソッドを無言で対象外にするうえ、`summary` にスキップ件数を出さず exit 0 で終わる。

### B. 言語・アーキテクチャ上の構造課題

1. **ポータブル音声（`Audio.open`）の事前確保バッファ不在**
   - `Audio.open` の `state: S` から `Vec`・`Pool`・`Arena`・`CHandle` が除外されており、`FixedArray<T, N>` も未実装で rt 層は確保禁止のため、ディレイラインやウェーブテーブル等の事前確保バッファを持つ実用的なポータブル DSP が書けない。

2. **Wasm 境界の全バッファコピー**
   - `packages/runtime-js/src/wasm-bridge.ts` の `pinBuffer` が呼び出しごとに `ArrayBuffer` 全体を Wasm 線形メモリへコピーイン／書き戻ししており、大きな `Vec` の一部 `slice` を渡す場合でも全バイトコピーが走る。

3. **配布・相互運用・資源管理の抜け**
   - `packages/compiler/src/build-browser.ts` が `npm:` import の解決に対応していない。
   - Linux ネイティブ配布物を生成する `sts build` ターゲットがない（`--target=browser` 専用）。
   - `using` / Drop がなく、`CHandle` と `Ptr.box` が早期 `return` やトラップ時にリークする。
   - `i64` / `u64` がなく、長時間サンプル積算や多くの C API を扱えない。
   - `Js` 権限にコンストラクタ呼び出し（`new`）・プロパティ書き込み・複数引数または戻り値ありの `js.callback` がない。
   - 偽の `Ffi` / `Spawn` がなく、`t.traps("T015", ...)` など C 専用・isolate 系をテストで検証できない。

4. **基盤依存と文書負債**
   - `packages/compiler/src/parse.ts` が `typescript/unstable/sync`（`tsgo` 子プロセス、起動約 105ms）に依存し、常駐チェッカ化されていないため開発ループ `< 10ms` 目標を満たせない。
   - 確定名 `szigyr` / `.szigyr`（`docs/Szigyr-design-v0.md`）と実装の `sts` / `.ts`（`packages/compiler/src/names.ts`）が分裂したままになっている。
   - 文書内の不整合として、`docs/SPEC.md` §11 のコード表に `E2012` が欠落、§13 が実装済みのミューテーションテストを未実装と記載、§9.2 の偽権限一覧に `FakeAudio` が漏れ、`docs/DIAGNOSTICS.md` の `t.traps` 表記が `"T013"` までのままになっている。

---

## 3. 見直しの着手順（依存関係順の 4 ステップ）

### Step 0: 3 つの根本公理のオーナー決定（完了：2026-11-21）

対話（`/grill-me`）により、見直しの前提となる以下の公理とスコープが確定した。

- [x] **公理 1-1（アイデンティティと TS 互換）**: TS パーサ（`tsgo`）互換構文を維持し独自パーサは作らない。一方、拡張子と意味論は `.szigyr` の「TS 構文を借りた健全な別言語」へ振り切り、`indexOf -> null`、`JSON.parse -> Result`、`charCodeAt -> T002` 等の健全な意味論を正面から採用する（旧原則 1 を改定）。
- [x] **公理 1-2（TS 手癖との摩擦）**: 「書き方 1 通り・暗黙推論を増やさない＋構造化診断 `data` / `fixes`」をベースとする。言語側の緩和は今決め打ちせず、Step 2 の素の AI 実測で頻発したミスだけを健全性と仕様の単純さを損なわない範囲で厳選採用する。
- [x] **公理 1-3（ジェネリック制約）**: 関数本体からの暗黙推論（`TParam.need` 12 種）を廃止し、TS 構文互換の組み込み能力制約（例：`T extends Copy`、`T extends Copy & Send`）のシグネチャ明示を必須とする（原則 6「境界明示・ファイル独立」を回復）。
- [x] **公理 2-1（AI 観測 I/O 格上げ）**: `CLAUDE.md` の選別基準を改定し、全フェーズ完走・主要コードの `data`/`fixes`・`E2009` への `cc` stderr 添付・厳密な `--json` 契約（exit 2/70、`forAll`/`t.eq` 反例含む）・`mutate` の `skipped`/`equivalent`・CLI の `query`/`explain` を第一級スコープへ格上げする。MCP・常駐デーモン・フォーマッタは後回しとする。
- [x] **公理 2-2（`SPEC.md` 再編）**: `docs/SPEC.md` は 1 ファイル自己完結（`Qxxx` 参照ゼロ、確定事項は必ず吸収）を維持し、**1 万トークン以内厳守のため英語＋型シグネチャ中心**へ切り替える。
- [x] **公理 3-1（ポータブル rt 音声バッファ）**: `Audio.open` の `state` に事前確保済み `Vec<T>`（および `Pool<T>`・`Arena` 等の `Native & Send` 所有コンテナ）の移動を許可し、当面 `FixedArray<T, N>` は入れない（問題が出た場合のみ `FixedArray<T, N>` 追加へ移行）。
- [x] **公理 3-2（今回サイクルに含める実運用機能）**: 配布の穴解消（Linux ネイティブ `build` 追加、ブラウザ `build` の `npm:` 解消）、`using` 資源解放、C 構造体・定数（`#define`/`enum`）取り込み、Wasm 境界コピー最適化を含める。`i64`/`u64` は今回は実装しないが将来対応可能な設計を保つ。
- [x] **公理 3-3（`using` 資源解放モデル）**: 明示的な `using`（同期解放、strict/managed 対応）＋ `await using`（非同期解放、managed 専用）に限定し、宣言された変数のみスコープ離脱（正常・早期 `return`・トラップ）時に決定的解放する。通常の所有型に自動デストラクタは入れない。
- [x] **移行タイミング（`szigyr` / `.szigyr`）**: Step 1〜2 の新設計文書・新 `SPEC.md` は最初から `szigyr` / `.szigyr` で統一し、実装・適合テスト・CLI の切替（`packages/compiler/src/parse.ts` での `.szigyr` → 仮想 `.ts` マッピング対応を含む）は Step 3 先頭で一括実施する。

### Step 1: 型能力マトリクス 1 枚の設計

- `packages/compiler/src/types.ts` の 12 種の暗黙 `Need` と 15 種以上の個別型述語を、下記の 5 つの組み込みデータ能力（＋派生 `Owned`）と 2 つの資源インターフェースへ統合する。

#### Step 1 詳細: 型能力マトリクス（設計案）

##### 1. 5 つの組み込みデータ能力（＋派生 `Owned`）と 2 つの資源インターフェース

| 能力 / インターフェース | 定義と役割 |
| --- | --- |
| `Copy` | 不変で複製可能な値（移動しない）。 |
| `Native` | 固定バイト配置を持ち strict / rt 層および C / Wasm 境界で使える値。 |
| `Owned`（派生名） | `Native` かつ `!Copy`（一意所有・移動のみ）。`Ref<T>` / `Mut<T>` の借用対象。 |
| `Send` | isolate / AudioWorklet / スレッド境界を安全に転送できる値。 |
| `Key` | スカラー同値比較・ハッシュ可能（`Map` キー、`Set` 要素、`includes` / `indexOf`、スカラー `===`）。 |
| `Codec` | 実行時検証および JSON / JS 境界での変換が可能な純データ型（`cast<T>`、`js.decode<T>`、`js.encode<T>`、`JSON.stringify<T>`）。 |
| `Disposable` | `dispose(): void` を持つ同期資源インターフェース（`using` 用、strict / managed 対応）。 |
| `AsyncDisposable` | `disposeAsync(): Promise<void>` を持つ非同期資源インターフェース（`await using` 用、managed 専用）。 |

**構文規則**:
- 型パラメータ制約は `T extends C` および `T extends C1 & C2` とする（`IntersectionType` は P1 の型パラメータ `extends` 句に限り許可し、他位置は従来どおり E1000）。
- 矛盾する制約（`Copy & Owned` など）は P2 で宣言時に拒否する。
- managed の無制約 `T` は既定 `!Owned`（所有型で具体化不可）とし、strict / rt の型パラメータは `Native`（または `Owned` 等）の明示を必須とする。

##### 2. 1 枚の型 × 能力マトリクス表

| 型 | 層・制約 | `Copy` | `Native` | `Owned` | `Send` | `Key` | `Codec` | 備考 |
| --- | --- | :---: | :---: | :---: | :---: | :---: | :---: | --- |
| 数値型（`i8`..`u32`, `usize`, `f32`, `f64`, 将来 `i64`/`u64`） | 全層 | ✅ | ✅ | — | ✅ | ✅ | ✅ | `===` 可 |
| `boolean` | 全層 | ✅ | ✅ | — | ✅ | ✅ | ✅ | `===` 可 |
| `null` | 全層 | ✅ | ✅ | — | ✅ | — | ✅ | 1B 固定配置新設により `Result<null, E>` 等を全層統一 |
| 文字列リテラル / リテラル union | 全層 | ✅ | ✅ | — | ✅ | ✅ | ✅ | 孤立サロゲート禁止（E2012）、`===` 可 |
| `string` | managed | ✅ | — | — | ✅ | ✅ | ✅ | `===` 可 |
| 不変レコード `{ readonly f: T; ... }` | 全層（`Native` 条件付） | 全 `f` が `Copy` | 全 `f` が `Native & Copy` | — | 全 `f` が `Send` | — | 全 `f` が `Codec` | strict/rt では `Struct<{ readonly ... }>` と同一型に正規化 |
| 可変レコード `{ f: T; ... }`（非 `readonly` あり） | managed | — | — | — | — | — | 全 `f` が `Codec` | 所有型フィールド不可 |
| `Struct<{ ... }>`（全 `f` が `Native`） | 全層 | 全 `f` が `readonly & Copy` | ✅ | `!Copy` | 全 `f` が `Send` | — | 全 `f` が `Codec` | `Copy` なものは不変レコードと同一型に正規化 |
| タグつき union / `T \| null` / `Result<T, E>` | 全層（`Native` 条件付） | 全メンバ `Copy` | 全メンバ `Native & Copy` | — | 全メンバ `Send` | — | 全メンバ `Codec` | `T \| null` の `===` は `T` が `===` 可のときのみ |
| `Array<T>` / `ReadonlyArray<T>`（`T` は `!Owned`） | managed | — | — | — | — | — | `T` が `Codec` | `Array<T>` のみ `Codec`（`castable`） |
| `Map<K extends Key, V>` / `Set<K extends Key>`（`V` は `!Owned`） | managed | — | — | — | — | — | — | `t.eq` 可 |
| `Vec<T extends Native & Copy>` | 全層（値保管は `Owned` 規則） | — | ✅ | ✅ | `T` が `Send` | — | — | `Audio.open` へ移動可 |
| `Pool<T extends Native & Copy>` | 全層（同上） | — | ✅ | ✅ | `T` が `Send` | — | — | プール ID をプロセス／領域間で一意化 |
| `Handle<T extends Native & Copy>` | 全層 | ✅ | ✅ | — | `T` が `Send` | — | — | `===` 値比較を許可 |
| `Arena` | 全層（値保管は `Owned` 規則） | — | ✅ | ✅ | ✅ | — | — | 移譲可、ID 一意化 |
| `ArenaBuf<T extends Native & Copy>` | 全層 | ✅ | ✅ | — | — | — | — | `!Send` のため `Ring` / `Port` / `Audio.open` から自動排除 |
| `RingTx<T>` / `RingRx<T>`（`T extends Native & Copy & Send`） | 全層 | — | ✅ | ✅ | ✅ | — | — | 旧 `noabuf` 不要 |
| `CHandle<T>` | 全層（操作は unsafe のみ） | — | ✅ | ✅ | — | — | — | `!Send`、safe でも保持・移動可 |
| `Ptr<T>` / `ConstPtr<T>` / `CType<"X">` | unsafe 専用 | `Ptr` 系は unsafe 内 Copy 扱い | — | — | — | — | — | 一般データ能力なし |
| `class` / `interface` / 関数型 | managed（関数型パラメータは strict/rt 例外あり） | — | — | — | — | — | — | `class` は `===` 参照比較、`Disposable` / `AsyncDisposable` 実装可 |
| `OwnedCell<T extends Owned>` / `Port<S extends Send, R extends Send>` / `AudioStream` | managed | — | — | — | — | — | — | `AudioStream` は `AsyncDisposable` 実装 |
| 権限型 / `JsRef` / `unknown` / `Test` | managed（権限は strict 可、rt は E4006 禁止） | — | — | — | — | — | — | データ能力なし |
| 非一級型（`Promise<T>`, `void`, `never`, `Slice<T>`, `Ref<T>`, `Mut<T>`） | 所定位置専用 | — | — | — | — | — | — | 型引数不可（`nopromise` 不要） |

##### 3. 構文・組み込み・境界条件の対応表（旧 12 `Need`・15+ 述語の解消確認）

| 機能・組み込み | 新条件（能力式） | 解消される旧 `Need` / 個別述語 |
| --- | --- | --- |
| `Vec` / `Slice` / `Pool` / `Handle` / `ArenaBuf` / `Arena.alloc` | `T extends Native & Copy`（※`Arena.alloc<T>` のジェネリック要素制限 Q215 は実行時サイズ渡し未対応のため当面維持） | `copy`, `layout`, `isCopy` |
| `RingTx` / `RingRx` / `Ring.create` | `T extends Native & Copy & Send` | `noabuf`（完全廃止） |
| `Port` / `spawn.isolate` | `S extends Send, R extends Send` | `send`, `sendable`, `hasUnsendable` |
| `Audio.open<S>` | `S extends Native & Send` | `audioStateOk`（`Vec`/`Pool`/`Arena`/`RingTx`/`RingRx`/Struct を一括許可） |
| `Ref<T>` / `Mut<T>` / `OwnedCell<T>` | `T extends Owned`（`Ref` / `Mut` は `Slice<U>` も可） | `borrow`（完全廃止） |
| strict / rt 境界と `Struct` フィールド | `Native` | `layerOk`, `hasLayout`, `cross`, `crossp`, `field`, `noauth`（統合廃止） |
| `Map` / `Set` / `includes` / `indexOf` | `K extends Key` | `key`, `keyOk` |
| `cast` / `js.decode` / `js.encode` / `JSON.stringify` | `T extends Codec` | `castable` |
| `===` / `!==` | `Key` ∪ `Handle<T>`（値比較）∪ `class`（参照比較）∪ それらの `T \| null` | 非明示の個別分岐表（Q017） |
| `t.eq<T>` | ジェネリック制約は `Codec` または `Copy`。直接呼び出しは非 `Owned`・非関数・非権限・非不透明データ（`Codec` ∪ `Map` ∪ `Set` ∪ `Handle` ∪ `ArenaBuf` ∪ `class`）を受理。`forAll` は非ジェネリック専用で `Codec` 系の合成生成規則を維持 | `eq`, `comparable` |
| `Ptr.box<T>`（unsafe 専用） | `Native` のうち JS バッキングを持たない型（`Copy`、`RingTx` / `RingRx`、`CHandle`、それらの `Struct`） | `boxable` |

##### 4. マトリクスで同時に解決する 5 つの設計課題

1. **`null` の 1B 固定レイアウト新設による `Result<null, E>` 全層統一**
   - §10.2 に `null` のバイト配置（`size: 1, align: 1, value: 0`）を新設し、`Result<null, E>` の strict / rt 境界（旧 `layout` / `cross` / `crossp` による E4002 拒否）を撤廃する。
2. **`Struct<{ readonly ... }>` と `{ readonly ... }` の同一型正規化**
   - 全フィールドが `readonly` かつ `Native & Copy` であるレコード型と `Struct<{ readonly ... }>` を同一型に正規化する。Q043 の一時回避を解消し、`cast<T>` / `JSON.stringify<T>` との非互換と既存テストの双方を保つ（新 `SPEC.md` では不変値レコードは `{ readonly ... }`、`Struct` は可変／所有型用を正規スタイルとして案内）。
3. **`Pool` / `Handle` / `Arena` の `Send` 化とプロセス一意 ID**
   - `Pool` / `Arena` の ID を isolate ローカル連番（1, 2, 3...）からプロセス一意 ID へ改め、`Pool` / `Handle` / `Arena` を `Send` かつ `ArenaBuf` を `!Send` とすることで、`Audio.open`・`Port`・`Ring` の安全規則を統一する。
4. **`using` / `await using` の二層設計**
   - **managed 層**: `Disposable`（`dispose(): void`）／`AsyncDisposable`（`disposeAsync(): Promise<void>`）インターフェースと `AudioStream` 等の組み込み実装で受ける。
   - **strict 層**: 組み込み `Resource.own(val, ctx, cleanup)` と所有権を解除する `h.take()`（所有権移動による解放キャンセル）を用意し、`Ffi` / `Alloc` 等の権限を受け取りつつ関数型パラメータの静的特殊化（Q189）でクロージャ／vtable なしに C 資源を確実解放する。
5. **`Pure` と `Mutatable` の分離、および `mutate` の可視化**
   - `Pure`（純粋決定的：キャッシュ・並列・witness 自動探索・静的証明用）と、`Mutatable`（`szigyr mutate` 対象：safe かつ `Test` 非依存で `Ffi`・`Spawn`・`Js`・`JsRef`・`Ptr`・`CHandle`・`Port` を含まない関数および `class` メソッド。`Alloc`・偽装可能権限 `Fs` / `Clock` / `Random` / `Log` / `Audio`・単一スレッドテスト内 `Ring` を含む）を分離する。
   - あわせて `szigyr mutate` の `summary` に `targets` と `skipped: [{ fn, reason }]` を追加する。

> **将来対応メモ**: `i64` / `u64` を導入する際は、マトリクス表の 1 行目（数値型：`Copy & Native & Send & Key & Codec`、8B 配置、JS 側は `BigInt` 表現）へそのまま追加でき、能力マトリクス自体の構造変更は不要。

### Step 2: 英語・1 万トークン以内の自己完結 `SPEC.md` への再編と実測検証

- Step 0・1 の決定を反映し、`docs/SPEC.md` を「`szigyr` / `.szigyr` 統一・`Qxxx` 参照ゼロ・**英語＋型シグネチャ中心・1 万トークン以内**で自己完結する AI 用教材」として書き直す（`docs/OPEN_QUESTIONS.md` の確定仕様はすべて吸収し、設計履歴だけを残す）。
- 新 `docs/SPEC.md` だけをプロジェクト文脈を持たない素の AI エージェントに渡し、代表的な小課題（事前確保済み `Vec` バッファ付き rt 音声処理、`using` 資源管理、テスト、`npm:` / C 連携等）を書かせて、初回パス率・詰まった規則・修正往復数を実測し、公理 1-2 の緩和候補と診断の穴を実証ベースで確定する。
- **完了状態**: `docs/SPEC-v1.md`（233 行・28 KB 未満、`zero-leak-ok`）を作成し、ブラインド AI 実地テストで 4/4 プログラムが一発生成に成功。発見された矛盾 2 件・明記漏れ 10 件を修正したうえ、オーナー判断で `Ptr.null<T>()` と `Ptr.sizeOf<T>()` を v1 に追加（`FakeJs` と `npm:` default import は v1 見送り）。

### Step 3: 実装への段階適用

1. **`szigyr` / `.szigyr` 一括切替＋AI 観測ループの改修**（先頭で実施）:
   - CLI / 拡張子の `szigyr` / `.szigyr` 一括切替（`packages/compiler/src/parse.ts` の `.szigyr` → 仮想 `.ts` マッピング対応を含む）
   - `analyze()` の全フェーズ完走（P1 で後段を止めない）
   - 主要エラーコードへの `data` / `fixes` 拡充とコード細分化の整理
   - `E2009` への `cc` stderr 添付
   - `cli.ts` の `--json` 出力契約（exit 2 / 70・出力ストリーム・`forAll` / `t.eq` 反例）の統一
   - `szigyr mutate` の `skipped` 報告・`equivalent` 印・`query` / `explain` の CLI 露出
2. **型能力マトリクスと所有権・テスト対象の刷新**:
   - Step 1 のマトリクス、`using` / `await using`、`Audio.open` への `Vec` / `Pool` / `Arena` 移動許可、`Pure` / `Mutatable` 分離（`class` メソッド・偽権限・`Alloc` 含む）をコンパイラ／ランタイムへ適用し、適合テストを追随させる。
3. **実運用の抜けを埋める**:
   - C 構造体・定数（`#define` / `enum`）の取り込み、Wasm 境界の部分コピー最適化、Linux ネイティブ `szigyr build` とブラウザ `build` の `npm:` 解消。

---

## 4. ブレ防止のガードレール（やらないこと）

- Step 0 の 3 つの公理が確定しないまま、個別の新機能追加（`i64`、`using`、`FixedArray`、Linux `build` 等）に着手しない。
- 既存のコンパイラや適合テスト資産（1,093 件）を捨ててゼロから書き直さない。
- 段階 6（SMT 静的証明）は、Step 1 の型能力統合と Step 2 の規範再編・AI 実測が終わるまで凍結する。
