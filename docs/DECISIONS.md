# 実装上の判断

## D001: typescript は 6.0.3 に固定する

（D005 で置き換え）

npm の latest は 7.0.2 だが、7.0.2 を入れて確かめたところ、Node の `import ts from "typescript"` は `version` と `versionMajorMinor` しか出さない（ネイティブ版で、`createSourceFile`、`ScriptTarget`、`forEachChild` が同期 API として存在しない）。`createSourceFile` が使えないので 6.x に固定する。6.0.3 では `createSourceFile`（位置情報つき）、`forEachChild`、`getLineAndCharacterOfPosition`、`sf.parseDiagnostics`（内部 API だが存在する）が同期的に動くことを確認した。7 系で同期の構文解析 API が安定したら再検討する。

## D002: テストを 2 つのコマンドに分ける

CLAUDE.md の「各コミットで全テストが通る」と、ROADMAP 段階 0 の「適合テストは全部失敗してよい」は、1 つのコマンドでは両立しない。そこで分ける。

- `pnpm test`: ユニットテスト（ハーネスの自己テストを含む）。偽のコンパイラで動くので常に緑。コミットの条件はこちら。
- `pnpm conformance`: `conformance/` を本物のコンパイラで実行する。段階 0 では赤でよい。`STS_STAGE=N` で、段階 N 以下のケースだけ実行できる。
- `pnpm typecheck`、`pnpm verify:conformance`（ケースの静的検査）。

## D003: 名前の一元化

言語名、CLI 名、パッケージスコープは `packages/compiler/src/names.ts` から導く。`package.json` の `name` だけは TS を読めないので手で書き、`names.test.ts` が一致を検査する。

## D004: 依存と pnpm 設定

依存は typescript（D005 で 7.0.2）、vitest、@types/node のみ。esbuild（vitest の依存）のビルドスクリプトは `pnpm-workspace.yaml` の `allowBuilds` で許可している。
ハーネスと検証スクリプトは Node の型除去（`.ts` を直接 import）で動かすため、`enum` などの型除去できない構文は使わない。

## D005: typescript 7.0.2 の unstable API を使う（D001 を置き換える）

方針は「なるべく最新を使う。古い版の固定は避ける」。6.x は保守が止まる。7.0.2 の既定の入口には `createSourceFile` がないが、`typescript/unstable/sync`（`API` → `updateSnapshot` → `Program.getSourceFile`）と `typescript/unstable/ast`（`createScanner`、`SyntaxKind`）で、構文解析だけを同期的に使えることを確かめた。

- 子プロセス（tsgo）の起動とスナップショットの作成に約 30ms。起動後は 100 行のファイルの取得が約 1ms（SourceFile 取得、全ノード走査込みで 1〜2ms）、構文エラーの取得は 0.3ms。目標の 10ms 未満を満たす。
- メモリ上のソースは `createVirtualFileSystem`（`typescript/unstable/fs`）で渡せる。tsconfig は不要で、`openFiles` を渡すと推論プロジェクトになる。
- 構文エラーは `Program.getSyntacticDiagnostics` で取れる。Checker も意味の診断も呼ばない（lib の d.ts は読み込まれるが、検査は走らない）。
- `close()` で子プロセスが終わる。呼ばなくても Node は終了する。
- 注意: `SyntaxKind.EndOfFileToken` は存在せず、`EndOfFile` を使う。`getChildren` はない。素のスキャナはテンプレートの継続を誤って分割するので、トークン先頭の判定は AST ノードの開始位置と併用する。

リスク: `unstable` は API が予告なく変わりうる。そこで `typescript` を import するのは `packages/compiler/src/parse.ts` だけにし、差し替えを安くする（`scripts/verify-conformance.mjs` もこれ経由）。バージョンは `7.0.2` に固定し、更新するときは `pnpm test` と `pnpm verify:conformance` で確かめる。

## D006: P1（構文の許可リスト）の構造

- `packages/compiler/src/syntax.ts` の `checkSyntax(file)` が P1。文・式・型・宣言ごとに `switch` で受理する種別を列挙し、`default` は E1000 にする。演算子、修飾子、リテラル型も同じく列挙で受理する。
- 子の走査は種別ごとに明示する（`forEachChild` で一律にたどらない）。トークンや名前を式として誤って検査しないため。
- 個別コードと位置は DIAGNOSTICS の表どおり。AST にノードのないトークン（`as`、`satisfies`、`export function*` の `function`）は `ParsedFile.tokenAfter` で求める。
- P1 の対象は Q003 のとおり E1xxx、E5002、E6001、E6003、E7001（`P1_CODE`）。
- 細部: `for…of` は `const` だけ（`let` は E1000）。空文、メソッドとフィールドの `public` / `protected` / `override`、確定代入アサーション `x!: T` は E1000。宣言のマージは、モジュール直下で同じ名前が 2 回宣言されたとき（型と値の区別なし）に、後の名前へ出す。`bigint` と `undefined` の型は名前として P2（E2000）に回す（Q011）。

## D007: check の骨組みとファイルの読み込み

- `check(entry)` は、入口のファイルと、そこから相対の静的 import（`./`、`../` で始まり `.ts` で終わるもの）でたどれるファイルを読み、フェーズを順に実行する（Q003）。今は P1 だけ。
- tsgo の子プロセスは 1 回の `check` で 1 つ（`parse.ts` の `createParser`）。import の深さごとに `updateSnapshot` を 1 回足す（1 回あたり約 1ms）。起動後の 1 ファイルの解析と P1 は合わせて約 2ms（68 行のファイル）。
- import 先のファイルがなければ、指定子の文字列リテラルに E7001（Q009）。名前が export されているかの検査は、モジュール解決の一切れで行う。
- 診断の `file` はカレントディレクトリからの相対パス。

## D008: 退行検出の PASSING.txt

`conformance/PASSING.txt` は、検査が実装済みで、今通っているケースの一覧（1 行 1 ケース、ソート済み）。`pnpm conformance:update-passing` が、`package.json` に書いたケース名の接頭辞に合うケースを実行して書き直す。`pnpm test` の `passing.test.ts` が、載っているケースが全部通ることを確かめる。新しい検査を実装したら接頭辞を足す。accept は、要求する検査が全部そろったもの（今は stage 1 の 22 本）だけを載せる。run は載せない。

## D020: SeededRandom は mulberry32

`SeededRandom.create(seed)` は mulberry32（状態 32 ビット、`seed >>> 0` で初期化）。`nextU32()` は 1 ステップの出力、`nextF64()` は `nextU32() / 2^32`（精度は 32 ビット。[0, 1) に収まる）。暗号用ではない。出力はシードだけで決まり、単体テストが `create(42)` の最初の値（2581720956）を固定する。算法を変えるとテストの期待値を使う利用側が壊れるので、変えるときは新しい名前にする。

## D021: ランタイムの構成と偽の権限

- `packages/runtime-js/src` は依存なし。整数演算は型名を第 1 引数に取る共通関数（`add("i32", a, b, pos)`）で、`RANGE` の表 1 つで 7 型を扱う。`wrapMul` は 32 ビット型で `Math.imul` を使う。
- `packages/std` は `../../runtime-js/src/index.ts` を相対 import する（pnpm の workspace リンクを使わず、`pnpm install` なしで動く。コンパイラ側が名前で import する必要が出たら見直す）。
- `TestAlloc.create()` と本物の `ALLOC` は同じ不透明な値 `{ kind: "alloc" }`。確保の記録はしない（SPEC にない）。
- `Js`: `call` / `get` は例外を `JsError { code: e.name, message }` に変換する。`await` は拒否された Promise を `err` にする。`decode` は `cast` と同じ。
- `runMain` はスタックの枯渇（`RangeError: Maximum call stack`）を T006 に変換する（Q035）。それ以外の JS 例外は握りつぶさず再送出する（ランタイムかコンパイラの不具合）。テストランナーも同じ。

## D022: テストランナー

`test(name, fn)` はモジュール内の配列に積む。`runTests()` は登録順に実行し、`{ name, ok, failure?, trap?, pos? }` の配列を返す。失敗したテストは、そのテストだけを終える（Q058）。`t.traps` は期待外のコードで失敗し、トラップ以外の例外は再送出する。

## D009: P2 の型の内部表現

- `packages/compiler/src/types.ts`。型は判別子 `k` を持つプレーンなオブジェクト（`prim`、`num`、`lit`、`record`、`union`、`fn`、`class`、`iface`、`tparam`、`gen`、`opaque`、`ns`、`iter`、`error`）。レコードはフィールドを名前順に並べ、構造で同一性を判定する。class と interface は宣言の記号（`ClassSym` / `IfaceSym`）の同一性で判定する（Q020 の 1）。
- `Struct<{…}>` は `struct: true` のレコード。`Result<T, E>` は §8 の定義どおり 2 つのレコードの union に展開する。`IoError`、`CastError`、`JsError` は同じ形のレコード（Q036）。
- `Ref<X>` / `Mut<X>` はシグネチャには残し（決定性、契約、Q051 の検査に使う）、値として読むときは `X` に読み替える（`unref`。Q020 の追記、Q064）。
- `error` 型は診断済みを表し、代入可能性の判定ではどの型とも一致する（Q003 のカスケード抑止）。P1 が拒否するはずの構文に P2 が出会ったら、黙ってエラー型にせず例外を投げる。
- 型の別名は宣言ごとに 1 回だけ解決してキャッシュし、型引数は置換で具体化する。再帰的な別名は未対応（エラー型になる。適合テストに例がない）。

## D010: 組み込みの許可リストの表現

`packages/compiler/src/builtins.ts`。§12 を、名前の集合（大域の関数、名前空間、予約名、Q006 の大域の権限）と、受け手の型ごとのメンバ表（Q032、Q033、Q038 のシグネチャ）で表す。表にない名前は呼び出し側で E2000 / E2001 にする。managed 専用の組み込み（Q044）はメンバに `managedOnly` の印を付ける。組み込みの省略可能引数は `min`、コールバックが先頭からの部分列の引数を取れることは `prefix` で表す（Q032）。特別な型付けが要る組み込み関数（変換関数、`wrap*`、`divTrunc`、`rem`、`ok`、`err`、`panic`、`cast`、契約、`test`、`Math.min` / `max`）は `expr.ts` に直接書く。

## D011: モジュールとシグネチャ

- `packages/compiler/src/modules.ts` の `Program` が、ファイルごとの `Module`（値と型の表、export 表、import の対応）を作る。1 回めで全ファイルの宣言の殻を作り、2 回めで注釈からシグネチャを解決する（§10: シグネチャは構文だけから取り出せる）。import は名前の対応だけを持ち、参照のたびに相手の export 表をたどる。
- import した名前が相手に export されているかの検査（E7001）は、構文だけで作る export 表で行い、P1 の診断に含める（Q003、Q009）。P1 にエラーがあれば P2 は実行しない。
- 関数の層は、本体の指示子、なければファイルの指示子（モジュール直下の `function` だけ）で決め、記号に持たせる（Q039）。メソッド、`test` の本体は managed。アロー関数は外側の関数の層。

## D012: P2 の検査器の構成

- `checker.ts`: 宣言、文、制御フロー、絞り込み。`expr.ts`: 式。`determinism.ts`: §7.3 の判定（Q062）。
- 式は双方向に検査する。`expr(c, e, want)` の `want` が文脈型で、数値リテラル（Q014）、文字列リテラル（Q016）、オブジェクトと配列のリテラル（Q021）、`ok` / `err`（Q037）、`??` の右辺がこれを使う。二項演算はリテラルだけの側を後で型付けし、もう一方の型を文脈にする。
- ジェネリック呼び出しの推論（Q030）は 4 段: 文脈の要らない実引数 → 関数式（引数は注釈済みなので、戻り値から型引数を推論）→ 呼び出しの文脈型 → リテラル。決まらなければ E2006。
- 絞り込み（Q025）はローカル変数（記号の番号）と `readonly` のフィールドパスをキーにした表で持つ。分岐ごとに複製し、`=== null`、`.kind === "…"`、文字列リテラル union の比較、`&&` / `||` / `!`、早期脱出、`switch` の各 case から作る。代入でそのキーを消し、ループの入口ではループ内で代入される変数の絞り込みを捨てる。
- 文は「正常に完了しうるか」を返し、Q023（非 `void` 関数の末尾）と早期脱出の絞り込みに使う。
- 公開 API: `check(entry)` に加えて、`deterministicFunctions(entry)` が入口ファイルのモジュール直下の関数ごとに決定性を返す（§7.3、Q062）。
- 性能: 起動後の P1+P2 は適合テストの accept / run の 60 ファイルで平均 0.3ms、最大 0.7ms。

## D013: 型の位置の検査と呼び出し条件の置き場所

- 型の位置の規則（union の合法性、`Map` / `Set` / `Vec` / `Slice` の型引数、`Struct` のフィールド、`void`、再帰する別名、制約）は `modules.ts` の `typeOf` / `typeRef` / `recordOf` にある。`typeOf` の第 3 引数 `voidOk` は、戻り値型の位置だけが `true`（`Promise` の型引数も `typeRef` が許す）。
- クラスと interface の型パラメータの制約は、シグネチャを解決する前に全モジュールで先に解決する（`classIfaceConstraints`）。型参照の側で `Box<X>` の制約を検査できる（以前は宣言より後ろで解決される制約を飛ばしていた）。別名の制約も同じ検査を通る。
- 呼び出し側の条件は `FnType.tcheck` で組み込みの署名に印を付ける: `cast`（`cast` / `js.decode` / `JSON.stringify` の `T`）、`eq`（`t.eq`）、`copy`（`Vec.create`）は `callSig` が推論後の第 1 型引数を検査し、`trap`（`t.traps`）は `call` が第 1 引数のリテラルを検査する。`cast<T>` は特別扱いの組み込みなので `builtinCall` が同じ `castable` を使う。
- 同名の宣言（Q087）は P1（`syntax.ts`）が持つ。スコープの集合を積んで、関数（引数と本体の最上位）、ブロック、`for`、`switch` の case ブロックごとに 1 つにする。E1000 は P1 のコードなので、P2 では検査しない。P2 の `switch` は case ブロックを 1 つのスコープにする（以前は内側の宣言が `switch` の外へ漏れていた）。

## D030: JS への変換（§10）の構成と型の受け渡し

- `packages/compiler/src/emit.ts` の `emitFile(file, displayPath, tests)` が 1 ファイルを変換する。プリンタは書かず、ソースの文字列を継ぎはぎする: 各ノードは自分のテキストで、子を子の変換結果に置き換え、型の構文（`: T`、`<T>`、`type`、`interface`、`implements`、`readonly` / `private` などの修飾子、`as const`）を消す。§10 の書き換えが要るノード（二項・単項演算、数値リテラル、添字、`?.`、呼び出し、契約のある関数本体）だけを個別に組み立てる。生成コードは読みやすさを目標にしない。
- 型は P2 から受け取る。`expr.ts` の `expr()` を、型を `exprTypes`（`WeakMap<Node, Type>`）に記録する処理で包んだ（検査の規則は変えていない）。複合代入の型は BinaryExpression のノード、メソッド呼び出しの受け手の型は `p.expression` のノードから引く。`Vec.create<T>` の要素型、`cast<T>` / `js.decode<T>` の `T` は、呼び出し式の型（`Vec<T>`、`Result<T, …>`）から取り出す。
- ランタイムは 1 つの識別子 `RUNTIME_GLOBAL`（`names.ts`、`__sts_rt`）の下に置き、ユーザーの関数名（`add`、`at`、`shl` など）と衝突しない。`Vec`、`OwnedCell`、偽の権限は予約名（§1）なので、そのままの名前で束縛する。位置（`{file, line, col}`）はモジュールごとの表に置き、トラップしうる呼び出しの末尾の引数で渡す（Q091）。アンカーは DIAGNOSTICS のトラップ表どおり。
- `Vec` は `get` / `set` / `length` / `slice` / `fill` を持つので、`Slice` の仮引数にそのまま渡す（`view()` を挟まない）。
- `ensures` は、最後の `ensures` より後の本体を即時実行のアロー関数（`async` 関数なら `await` する async アロー）で包み、その結果を全部の `ensures` で検査してから返す。入れ子の関数の `return` は対象にならない。
- 複合代入の左辺が添字かプロパティのときは、受け手と添字を 1 回だけ評価するため、アロー関数に渡して書く。右辺もそのアローの中で、元の値を読んだあとに評価される（JS と同じ順序）。右辺に `await` があるときは、アローを async にしてその結果を `await` する（入れ子の関数の中の `await` は数えない）。
- §10 の 11（ソースマップ）: トラップの位置を呼び出しに直接埋め込む方式（Q091）で「ソース上の位置で報告する」を満たすので、`.map` ファイルは生成しない（未実装）。JS の例外のスタックトレースは生成コードの行を指す。
- 性能: 起動後の変換と評価は、`check` との差が測れない程度（`run` 全体で約 57ms のうち、tsgo の起動が大半。D005）。

## D031: 生成した JS の実行（`run` と `runTestFile`）

- 生成した JS はファイルごとに `new Function(RUNTIME_GLOBAL, IMP, body)` のファクトリにして、メモリ上で評価する。ファイルにも一時ディレクトリにも書かない。`import { a } from "./b.ts"` は `const { a } = IMP("<絶対パス>")`、`export` は本体の末尾で返すオブジェクトにする。依存先は初回の `IMP` で評価する（循環は Q100）。
- ランタイムは、`run` / `runTestFile` が使う `@sts/runtime-js` と `@sts/std` の同じインスタンスをファクトリに渡す。生成コードがパスで import すると別のインスタンスになり、`instanceof Trap` が効かなくなるため。
- `npm:x` は、ホストが import するファイルの位置から `createRequire(file).resolve(x)` で解決し、`import()` した名前空間を `IMP("npm:x")` で渡す（解決できなければコンパイラの位置から `import(x)`）。
- `run(entry)`: 検査に診断があれば返す。なければ全ファイルを変換し、入口の `main` を `runMain` で起動する。`main` がなければ例外（Q061 の CLI のエラー）。トラップに位置がないとき（D032 でソースの呼び出しを見つけられなかったスタックの枯渇）は、`file: ""`、`line: 0`、`col: 0` で返す。
- `runTestFile(entry)`（`sts test` の中身）: 入口ファイルの `test(...)` だけを残して変換し、`runTests` の結果を返す（Q101）。前後で `clearTests` を呼ぶ。`run` では `test(...)` を除く（§10 の 10）。
- `@sts/runtime-js` と `@sts/std` のクラスのパラメータプロパティを、明示的なフィールドに書き換えた。`node scripts/update-passing.mjs` がコンパイラ経由でこれらを素の Node（型の除去だけのモード）で読み込むため。
- `pnpm conformance:update-passing` の対象に `run/` を足した（D008 の「run は載せない」を改める）。

## D040: CLI の構成

- `packages/compiler/src/cli.ts`。Node 24 の型除去でそのまま動く（ビルドなし）。`package.json` の `bin` は `{ "sts": "src/cli.ts" }` で、キーが `CLI_NAME` と一致することを `names.test.ts` が検査する。使用文と接頭辞は `CLI_NAME` から導く。
- 引数解析は `node:util` の `parseArgs`。依存は足していない。`main(argv, out, err)` を export し、テストは子プロセスで起動する。
- 出力と終了コードは Q110。人間向けの出力は 1 行 1 件の最小限。

## D041: 診断の fixes

- `syntax.ts` の `fix()` が直前の診断に 1 編集の修正候補を付ける。対象: E1001（`var` → `let`、モジュール直下と `for-of` は `const`）、E1002（`===` / `!==`）、`T[]` → `Array<T>`（E1000）、値を使わない文位置と `for` の更新式の `x++` / `x--` → `x += 1` / `x -= 1`（E1000）。
- E2003: `expr.ts` の `numFix` が、注釈なしで数値リテラルから初期化した変数（`Checker.litLets`）が片側のオペランドで、もう一方が別の数値型のとき、変数名の直後に `: <相手の型>` を挿入する候補を付ける（SPEC §11 の例）。二項演算、複合代入、比較、`===` が対象。
- 推測が要るものには付けない（`.length` と比べる `let` 以外の E2003、E2002 など）。

## D032: JS の例外を投げる組み込みとスタックの枯渇（Q035）

- §12 の許可リストのうち、JS の例外を投げうるメンバは次のとおり。`JSON.parse`（構文エラー）、`JSON.stringify`（文字列の長さの上限）、`String.fromCodePoint`（範囲外の符号位置）、string の `padStart` / `padEnd` / `replaceAll` / `toUpperCase` / `toLowerCase`（文字列の長さの上限）、`Array` の `push` / `concat` / `join`（配列と文字列の長さの上限。`ReadonlyArray` は `concat` / `join`）、`Map.set` / `Set.add`（要素数の上限）。これらの呼び出しは `guarded(受け手, 名前, 実引数, 位置)` にし、トラップ以外の例外を `panic`（T006）にする。位置はメンバ名（DIAGNOSTICS の T006 の行）。実引数は呼び出しの前に評価する。受け手が `?.` の呼び出しは包まない（`shortcut:` の印）。
- 包まないもの: テンプレートリテラルと配列のスプレッドは組み込みではなく構文なので、長さの上限の `RangeError` はそのまま JS の例外になる。ランタイムの `Vec.push` の確保の失敗も同じ。
- スタックの枯渇: `asTrap`（runtime-js）が `RangeError: Maximum call stack size exceeded` を T006 にする。`runMain`、`runTests`、`t.traps` が使う。位置は Q035 の既定案のとおり、枯渇が起きた呼び出しの名前にする。生成コードは呼び出しの名前の直前（`new` は `new` の直前）に `/*__sts_rt@N*/` の注釈を残し、末尾に `//# sourceURL=sts:<絶対パス>` を付ける。V8 のスタックフレームの `行:列` が注釈の直後に当たるものを、上のフレームから探す。`new Function` は本体の前に 2 行を足すので、本体の 1 行目を 3 行目として数える。見つからなければ位置なし（D031）。
- ロケータはプロセスに 1 つ（`setStackLocator`）。同じプロセスで同時に走る 2 つの `run` は互いのロケータを上書きする（`shortcut:` の印）。

## D060: 変換器・ランタイム・ホストの修正（独立レビューの指摘）

- Js の境界（`call` / `get` / `await`）は、`Trap` とスタック枯渇の `RangeError` を `JsError` にせず投げ直す（§8: トラップは STS から捕捉できない）。それ以外の例外は従来どおり `JsError`。`decode` は例外を投げない。
- `asTrap` は、スタック枯渇に限らずすべての `RangeError` を T006 にする（Q035）。テンプレートリテラル、配列のスプレッド、文字列の `+`（検査器が拒否する）、`Vec.push` の確保失敗、`Map` / `Set` の上限は組み込みのメンバ呼び出しではないので `guarded` で包めない。STS のコードが起こしうる JS の例外は `RangeError`（長さの上限）と、`guarded` が包む `JSON` の `SyntaxError` / `TypeError` だけで、前者は `asTrap` が拾う。位置は、スタックの上から探した最も内側のソースの呼び出し（D032）で、起きた式そのものではない。Js 境界の内側で起きた長さの `RangeError` は、ホスト側の JS と区別できないので `JsError` になる。
- `?.` つきのメンバ呼び出しも `guarded` / `charCodeAt` に書き換える。受け手を引数にしたアロー関数で受け、null なら実引数を評価せずに null を返す（§10.7）。D032 の「`?.` の受け手は包まない」は取り下げ。`?.[i]` は E1000 で拒否されるので扱わない。
- 整数型の文脈の負の数値リテラルは `(-lit + 0)` にして `-0` を +0 にする（Q090）。ほかの経路（`neg` / `add` / `sub` / `mul` / `divTrunc` / `rem` / `convert` / `wrap*`）は既に +0 に直している。`cast` は Q141。
- await されない Promise の拒否は Q140 の既定案どおり、`capturing`（runtime-js の `trap.ts`）が `unhandledRejection` を集める。`runMain`、`runTests`（テスト 1 件ごと）、モジュールの読み込みが使う。リスナは使用中だけ付け、入れ子では最も内側が受ける。vitest は自前の `unhandledRejection` リスナで失敗にするので、この挙動のテストは CLI を別プロセスで動かす。
- 同じプロセスで `run` / `runTestFile` を並行に呼んだとき、スタックの位置ロケータ、テストの登録表、拒否の受け皿が実行の間で共有されて混ざる。実行ごとに分ける代わりに、呼び出しを順番待ちにする（`index.ts` の `exclusive`）。結果は混ざらず、呼び出し側は変わらない。制限: 1 つの実行が終わらないと次が始まらない。
- Q100 の既定案（b）を実装した。ファクトリはホストが作った exports オブジェクトを第 3 引数で受け取り、import より前に関数宣言（巻き上げられる）を入れ、末尾で残りを入れる。循環の途中のファイルから、相手の関数宣言が見える。`const` や `class` は ESM と同じく初期化の前には見えない。
- D032 の「ロケータはプロセスに 1 つ」と「`?.` は包まない」「テンプレートリテラルと配列のスプレッドは保護がない」は、上のとおり置き換わった。

## D050: P2 のエラー型の不変条件（fail closed）

- エラー型は「診断を出した後」にだけ使う（D009）。診断なしでエラー型を返していた経路を塞いだ: static メソッドと `function` 式の `this`（P1 で拒否し、P2 は `thisType` がなければ例外を投げる。`thisType` はアロー関数にだけ引き継ぐ）、スプレッドだけの配列リテラルの要素型（`Array` / `ReadonlyArray` でなければ E2002）。到達しないはずの `return ERROR`（`ident` の記号の種類、`binary` の演算子、`builtinCall` の名前）は例外にした。
- 保険として、`expr()` がエラー型を返した最初の式を覚え、P2 が診断を 1 つも出さずに終わったら、その式に E2002（"internal"）を出す。洗い出しから漏れた経路があっても、受理はしない。

## D051: 絞り込みの無効化（Q122）

- `Checker.forget(id)` は、消した局所変数の番号を `kills` に追記する。分岐・ループ・`switch`・`&&` / `||`・三項演算子は、入る前の状態を保存するときに `mark()`（`kills` の長さ）を取り、戻すときに `restore(saved, mark)` で、その後に代入された変数を根とする絞り込みを除く。条件から得た事実は `withFacts(f, mark, end)` で、条件の評価中（`mark` から `end` まで）に代入された変数のものを除いて当てる。`if` の一方の分岐だけが正常に終わるときは、その分岐の終わりの絞り込みの表をそのまま使う。
- 捕捉と代入（Q122 の 1）は、モジュールごとの前処理 `capturedAssigned`（checker.ts）で、関数ノードごとに名前の集合を作る。`declare` がその関数の局所変数に `unstable` の印を付け、`keyOf` は印のある変数を絞り込みの対象にしない。
- `while` は、本体に `break` があれば出口で条件の事実を当てない（`hasBreak`）。

## D052: 型パラメータの条件の記録と遅延検査（Q127）

- `TParam.need` に条件（`key`、`copy`、`field`、`borrow`、`eq`）を記録する。型の位置の検査（`modules.ts` の `typeRef` / `recordOf`、`new Map` / `new Set`、`callSig` の `tcheck`）は、型パラメータに出会うと `demand()` で条件を記録して通す。それ以外の型は `needOk()` でその場で検査する。
- 具体化（`typeRef` のユーザー型の型引数、`callSig` で決まった型引数）は `Program.insts` に積む。`Checker.run()` の最後に `Program.checkInsts()` が、型パラメータへの具体化を通じて条件を不動点まで伝え、残りを検査する。本体を検査する順序（呼び出しが宣言より前にあるなど）に結果が左右されない。

## D053: P1 の関数ごとの文脈

- `syntax.ts` の `fc`（`thisOk`、`async`、ループと `switch` の深さ）を、関数（宣言、メソッド、constructor、アロー関数、関数式）に入るたびに作り直す。`thisOk` はインスタンスメソッドと constructor で真、アロー関数は外側を引き継ぐ。Q120、Q124 の検査に使う。
- 予約された名前（Q123）は `declName` と `memberName` で検査する。接頭辞は `names.ts` の `RUNTIME_GLOBAL` から取る（`emit.ts` の内部名はすべてこの接頭辞で始まる）。

## D054: Promise 型の式の位置（Q130）

- Promise 型を許す式は、親の式や文が `expr.ts` の `promiseOk`（`WeakSet<Node>`）に先に入れる。入れるのは、`await` のオペランド、`Promise.all` の実引数のうち配列リテラルの要素と呼び出し式、Promise を返す関数の `return` の式とアロー関数の式本体、許された括弧の中の式。`expr()` は、結果の型が Promise を含み（`hasPromise`）、許されておらず、入れ物の式（オブジェクト・配列リテラル、三項演算子、括弧、二項演算）でなければ E2002 を出す。入れ物は部分式の側で報告する。
- 型の側では、`Program.typeOf` が `Promise` の型参照を、戻り値の型の全体（`voidOk` が立っていて、型引数でないもの）でなければ拒否する。戻り値の注釈のない関数は、推論した型が `Promise` そのものでなければ `onlyPromise` で拒否する。
- `Checker.discard` は、入れ物の式文（代入を除く）だけを報告する。ほかは `expr()` が報告する。
- 代入による絞り込み（Q131）は `binary` の `=` で行い、`if` の合流は両方の終わりの表の共通部分を取る。
- D050 の保険は、P2 の診断（シグネチャの解決で出たものを含む）が 1 つもないときだけ出す。

## D055: constructor の確定代入（Q121 の追記）

- `classBody` は初期化区間の文を順にたどり、代入済みのフィールドの集合（初期化子つきから始める）を持つ。`this.f` は f が代入済みなら読める。入れ子の関数の中では、どの `this` も拒否する。直下の文 `this.f = …` は右辺を検査した後に f を代入済みに加える。入れ子の `this.f = …` は書き込みとして通すが、代入済みには数えない。
