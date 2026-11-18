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

- §12 の許可リストのうち、JS の例外を投げうるメンバは次のとおり。`JSON.parse`（構文エラーは `err` で返す。D082）、`JSON.stringify`（文字列の長さの上限）、`String.fromCodePoint`（範囲外の符号位置）、string の `padStart` / `padEnd` / `replaceAll` / `toUpperCase` / `toLowerCase`（文字列の長さの上限）、`Array` の `push` / `concat` / `join`（配列と文字列の長さの上限。`ReadonlyArray` は `concat` / `join`）、`Map.set` / `Set.add`（要素数の上限）。これらの呼び出しは `guarded(受け手, 名前, 実引数, 位置)` にし、トラップ以外の例外を `panic`（T006）にする。位置はメンバ名（DIAGNOSTICS の T006 の行）。実引数は呼び出しの前に評価する。受け手が `?.` の呼び出しは包まない（`shortcut:` の印）。
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

## D056: 条件つきの評価と代入先の 1 か所化（Q133）

- 代入による絞り込みは `Checker.assignNarrow` だけが付ける。呼ぶのは `ExpressionStatement` と `for` の初期化式で、`binary` の `=` は右辺を検査するだけにした。
- 代入先は `expr.ts` の `assignTarget`（括弧を外す）で決める。`Checker.assigned` は代入先の鍵（局所変数の番号、または `this.f` のパス）を `keyOf` で求めて `forget` する。`lvalue`、`loopEntry`、`assignNarrow`、`capturedAssigned` はどれも `assignTarget` を使う。`kills` は鍵の文字列の列で、鍵とその下のパスを無効にする（`isDead`）。
- 条件つきで評価される部分は `Checker.branch(f, facts, mark, end)` を通す。入口で絞り込みの表を写し、出口で `restore` して、中で足した絞り込みを捨て、中の代入による無効化を残す。使う箇所は `&&` / `||` の右辺、`??` の右辺、三項演算子の 2 つの枝、`?.` を含む呼び出し（`NodeFlags.OptionalChain`）、ループの本体（`loopBody`）。三項演算子の 2 つ目の枝は 1 つ目の枝の前の表から始める。`if` と `switch` は分岐ごとの終わりの表を自分で合流させる（Q122 の 3、Q131）。

## D057: 型パラメータの Promise と診断の重複（Q130 の追記）

- `tparamShells` が作るユーザーの型パラメータは、最初から条件 `nopromise` を持つ。Q127 の `checkInsts` が、具体化のたびに型引数が Promise を含まないか（関数型の中は見ない）を検査する。組み込みの型パラメータはこの条件を持たない。
- `Reporter.report` は、同じファイル、同じコード、同じ開始位置の診断を 2 つ目から落とす。

## D058: 契約の式の検査（Q134）

- `builtinCall` の `requires` / `ensures` / `invariant` は実引数を検査した後に `observeOnly` で構文をたどる。代入・複合代入・`++` / `--` と、`MUTATORS` に名前がある組み込みメソッドの呼び出しを E6002 にする。受け手の型は `exprTypes` から取り、ユーザーの class なら対象外にする。
- E6001（契約の位置）ではなく E6002 を使う。どちらも契約の中身の規則で、E6002 は式の中の違反を扱うため。


## D070: P3（所有権）の構成

- `ownership.ts` に置く。P1・P2 の診断がゼロのときだけ `index.ts` の `analyze` から呼ぶ（Q003）。型は P2 の結果を読む。式の型は `exprTypes`、識別子と局所変数の記号の対応は `localOf`、呼び出しで使った署名は `callSigs`（どれも `expr.ts` の `WeakMap`）。識別子の型は `exprTypes` ではなく記号から取る（短縮プロパティは `exprTypes` を持たない）。
- 状態は「移動済みの局所変数 → 移動した式」の表 1 つ。到達しない経路は `null`。分岐と合流は `join` だけで行う（どちらかの経路で移動済みなら移動済み、`null` は単位元）。`if`、三項演算子、`&&` / `||` / `??`、`switch`、ループの出口と back-edge は、すべて写しを取って `join` する。`break` / `continue` はループ（`switch` を含む）の枠に状態を積んで `null` にする。`return` と `never` 型の式も `null` にする。
- ループは 1 回だけたどる。枠には、外側（ループに入る前の深さ）で宣言された変数の移動を記録する。back-edge（本体の正常終了と `continue` の合流、`for` の更新式、`do` の条件の後）で、まだ移動済みの変数の記録を E3002 にする。再代入された変数は表から消えるので、同じ反復の中の再代入は通る（Q150）。
- 式は文脈つきでたどる: `read`（使用だけ）、`move`（変数の初期化、代入の右辺、値渡しの実引数、`return`、Struct リテラルのフィールド、分割代入とスプレッドの元）、`store`（managed のレコード・`Array` / `Map` / `Set` の実引数・要素・class のフィールド・`ok` / `err`。所有型なら E3007）。借用の実引数と受け手は場所式として別にたどり、呼び出しごとに「根の変数、モード（ref / mut / move）、位置」の列を作って E3005 を判定する。
- 型の位置の E3004（`Ref` / `Mut` を引数の型注釈の外に書いた）は、モジュールの型ノードを構文でたどって出す。
- strict / rt の層の検査（E4002〜E4006）は P2（`checker.ts` / `expr.ts`）に置く。E4005 は rt 関数の呼び出しの辺を集め、全モジュールの検査の後に、辺の先から元へ戻れるかで判定する。
- 型パラメータは Q049 のとおり所有型として扱う。ただし interface の制約か、条件 `key` / `copy` / `eq`（Q127 の記録）を持つものは除く（Q153、`types.ts` の `movesLike`）。
- rt 関数ごとのトラップしうる箇所（§6）は `traps.ts` の `trapSites` で求め、`index.ts` の `rtTrapSites(entry)` が入口ファイルの rt 関数ごとに返す。対象は T001（整数の `+` `-` `*`、複合代入、単項 `-`）、T002（添字、`slice`）、T003（整数型への変換）、T004 / T005 / T010（契約）、T006（`panic`）、T007（`divTrunc` / `rem`）、T009（シフト）。位置は `docs/DIAGNOSTICS.md` のトラップのアンカーに合わせる。CLI には組み込まない。

## D080: 保留していた項目へのオーナーの決定（2026-11-19）

- 判断待ちだった項目を、おすすめの案で決めた。例外は Q130（案1に条件式を足す案3）。結果は各項目の「決定」行に書いた（`docs/OPEN_QUESTIONS.md`）。
- 現状の実装のままとする項目: Q031、Q086、Q120、Q121、Q122、Q123、Q134、Q005、Q010、Q019、Q022、Q040、Q041、Q042、Q043、Q017。Q120 は問題になれば広げてよい。Q122 は実用上の価値が高ければ案2を検討する。
- 実装を変える項目: Q081（文字列リテラルの union をキーに許す）、Q128（`js.callback`、D081）、Q026（`as const` を E1005 にする）、Q035（`JSON.parse` が `Result` を返す、D082）、Q130（`await` のオペランドの条件式）、Q090（SPEC の文面を実装に合わせる）。
- Q049 / Q068 は案2に決めたが、実装は所有権の検査の担当が別に行う。ここでは記録だけ。
- `docs/PENDING_DECISIONS.md` は、内容を `docs/OPEN_QUESTIONS.md` に移して削除した。

## D082: `JSON.parse` は `Result` を返す（Q035）

- 型は `JSON.parse(s: string): Result<unknown, JsError>`。構文エラー（JS の `SyntaxError`）は `err({ code: "SyntaxError", message })` で、`code` は Q036 のとおり JS の例外の名前。エラー型は `IoError` / `CastError` と同じ形の `JsError`。
- 実行時は `runtime-js` の `jsonParse(text, pos)`。`SyntaxError` 以外の例外（スタックの枯渇など）は T006（位置は `parse` の名前）。`JSON.stringify` とほかの組み込みは今までどおり `guarded` で T006。
- `cast<T>(x)` は `unknown` を受け取るので、`Result` をそのまま渡しても型検査は通る（実行時は `err`）。`unknown` を取り出して渡すこと。これは `cast` の引数の規則の問題で、今回は変えていない。
- 訂正（2026-11-19）: 上の項目は誤りだった。`Result` は `unknown` に渡せないので、`cast<T>(JSON.parse(x))` は E2002 になる（Q185）。

## D081: `js.callback` の形（Q128）

- 署名は `js.callback<T>(f: (arg: Result<T, CastError>) => void): JsRef`。`T` は `cast` と同じ条件（`tcheck: "cast"`）。引数の注釈（`Result<string, CastError>` など）から `T` を推論できる。推論できない形（`(x: string) => …`）は E2006、戻り値が `void` でない関数は E2002、`T` が条件に合わなければ E2002（アンカーは明示した型引数の先頭）。新しいエラーコードは足していない。
- 引数を検査する場所がソースに見えるよう、関数は検査結果の `Result` を受け取る。`decode` が失敗を `Result` で返すのと同じ形で、失敗してもトラップしない。
- 最小の形にしたので、引数は 1 つ、戻り値は `void` だけ（Q160）。実行時は `Js.callback(f, desc)` が `(...a) => { f(cast(a[0], desc)); }` を返す。`emit.ts` は引数の関数型から `T` の記述子（`decode` と同じ `desc`）を取って渡す。
- `encode` は変えない。

## D090: managed のジェネリックと所有型（Q068 の案2）

- 型パラメータに、宣言した層の印（`TParam.owner`）を付ける。strict / rt の関数の型パラメータはその層（`"strict"` / `"rt"`）、それ以外の利用者の型パラメータ（managed の関数、class、interface、メソッド、関数型、アロー関数）は `"managed"`。型エイリアスと組み込みの型パラメータには付けない。
- `movesLike` は、strict / rt の型パラメータだけを所有型として扱う。managed の本体では `T` を自由に格納し、何度でも読める。
- managed の型パラメータを所有型（またはそれを含む union）で具体化すると、P3 で E3007 を出す。新しいコードは足していない。Q068 の記録どおり E3007 にした。所有型の値を managed の入れ物に入れるのと同じ穴だからである。具体化は `Program.insts`（Q127）から取るので、アンカーは明示した型引数か、推論なら呼び出し先の名前になる。
- strict / rt の関数の型引数は §3.3 の最後の項目に従い、`layerOk` でない型なら P2 で E4002 を出す（`checkInsts`）。rt の関数の型引数が権限を含めば E4006 とする（§6）。managed の型パラメータを strict / rt の型パラメータの型引数にすると、この検査を素通りするので E4002 にする。
- 型エイリアス（`type Box<T> = Struct<{ v: T }>`）は型の上だけの置き換えなので対象にしない。

## D091: P3 の「有効な借用」の表と、レビューで見つかった穴の塞ぎ方

- `Flow.active` に、評価の途中で有効な借用を積む。積むのは、呼び出しの受け手と借用の実引数（呼び出しの終わりまで）、添字アクセスの根（添字の評価の間、`Ref`）、代入先の根（添字と右辺の評価の間、`Mut`）。移動と借用のたびにこの表を見る（Q170）。同じ呼び出しの実引数どうしの衝突は、今までどおり `uses` で調べる。借用の実引数の根は、`slice` の範囲を評価する前に積む（`a.slice(0, wn(a))` を拒否するため）。同じ位置に E3005 を 2 回出さないよう、出した位置を覚えておく。
- 式の中の代入 `x = v` は値を使う位置で `x` を使ったものとして扱う（Q172）。
- `async` の借用パラメータ（Q171）、`Ref` / `Mut` の外の `Slice`（Q173）、`Struct` の `Ref` / `Mut` のフィールドは、型の位置の検査（`typePositions`）で E3004 にする。`Struct` のフィールドの検査（P2、Q086）は、`Ref` / `Mut` を P3 に任せる。
- 所有型を要素に持つコンテナを作る呼び出しは、呼び出しの結果の型で判定する（Q174）。コンテナからの読み出しは検査しない。こうしたコンテナは常に空だからである。
- 契約の中の移動と `Mut` の借用は P2 の `observeOnly` で呼び出しの署名（`callSigs`）を見て E6002 にする（Q175）。
- `return` の式は戻り値の型の `Ref` / `Mut` を外して検査する。`Ref` を返す関数は P2 の E2002 ではなく P3 の E3004 になる（§5.5 の二級性 3）。
- strict / rt の関数型の注釈は E4003 にする（§2「関数値も v0 では禁止」）。以前は E4002 だったので、`reject/E4002-function-type-param-in-strict.ts` を `E4003-…` に改名した。
- 過剰な拒否を 2 つ直した。`Ref` / `Mut` の Struct から Copy のフィールドだけを分割代入するのは、読み取りとして扱う。`do … while (false)` には戻り辺がないので、E3002 を調べない。一時的な値への E3003（`f().field` など）は残した。

## D100: strict / rt の JS での表現（§10.9）と C との対応

- strict / rt の関数は managed と同じ変換器（`emit.ts`）で変換する。層ごとの分岐は足していない。境界の呼び出しは普通の JS の呼び出しになる。
- 表現は §10.9 のまま。Struct はプレーンなオブジェクト、`Vec<数値型>` は TypedArray を包んだ `Vec`、ほかの `Vec`（Copy の Struct、`boolean`、Copy の union）は配列を包んだ `Vec`。`Slice` は同じバッファへの `(buf, off, length)` のビュー。`Vec` を `Slice` のパラメータに渡すときは `Vec` そのものを渡す（`Slice` の操作は `Vec` の操作の部分集合なので、`view()` は呼ばない）。`Ref` / `Mut`、移動、破棄は何も生成しない。
- C で値渡しの struct と一致する理由: Copy の Struct は全フィールドが `readonly` で深く不変なので、参照の共有と複製を区別できない。非 Copy の Struct と `Vec` は束縛がただ 1 つ（§5）なので、共有しても別名が生じない。`Mut<S>` の書き込みは呼び出し元のオブジェクトに届き、C のポインタ渡しと同じになる。レコードと Struct は互いに代入できない（`E2002-record-passed-as-struct`、`E2002-struct-passed-as-record`）ので、managed の可変なレコードが Struct として別名を持つこともない。
- 評価順とトラップの位置は JS の評価順で決まる（§0.2）。C 側はこれに合わせる。`v[i] = e` は `v`、`i`、`e` の順に評価してから範囲を検査する（右辺のトラップが先。`run/61`）。`v[i] += e` は `v[i]` を読んでから `e` を評価する（読み出しの T002 が先。`run/62`）。実引数と二項演算のオペランドは左から右（`run/63`、`run/64`）。
- 既知の制限: 型パラメータを要素に持つ `Vec.create<T>`（strict のジェネリック関数の中）は、具体化が `f32` などでも配列で表す。単相化しないと要素の型が分からないため。値は同じなので JS 上では観測できない。C バックエンドでは単相化して数値型の配列にする。
- `Vec.create` や `push` の確保の失敗は JS の `RangeError` になり、Q035 の決定どおり T006（位置はその呼び出し）として報告される。適合テストは書かない。

## D101: C バックエンドの構成（JS ホスト形態）

- C にするのは、プログラムの全ファイルのモジュール直下の strict / rt の `function` 宣言だけ。managed は今までどおり JS で動く。プログラム全体で 1 つの C の翻訳単位にする（ファイルをまたぐ strict どうしの呼び出しは C の中で直接呼ぶ）。
- JS 側では、その関数の本体を `return rt.native.<key>(引数…)` に置き換える。managed からの呼び出しは、この JS の関数を経由してアドオンに入る。strict / rt どうしの呼び出しは C の中で閉じ、JS を経由しない。
- ビルド: インストール済みの `cc` で、実行中の Node のヘッダ（`<execPath>/../../include/node`）に対して Node-API のアドオンを直接コンパイルし、`process.dlopen` で読み込む。node-gyp も npm の依存も足さない。フラグは `-std=c11 -O2 -ffp-contract=off -fno-fast-math -fwrapv -shared -fPIC`。出力は C ソースのハッシュをキーに、利用者ごとのキャッシュ（`$XDG_CACHE_HOME` か `~/.cache` の下、自分だけが書けるディレクトリ）に置く。`cc` かヘッダがなければ、C バックエンドの実行はその理由を書いた内部エラーで止まる（JS にこっそり戻らない）。`zig` もあるが、`cc` で足りるので使わない。
- 選択: `run(file, { backend: "c" })` と `sts run|test --backend=js|c|both`。`both` は JS と C で別々に実行し、出力・テストの結果・トラップ（コードと位置）を比べ、食い違いを失敗として両方の結果とともに報告する。適合テストは、stage 2 以上の実行例を両方のバックエンドで実行する。

## D102: C での値の表現と境界

- 数値型は `<stdint.h>` の同じ幅の型（`usize` は `uint32_t`）、`f32` は `float`、`f64` は `double`、`boolean` は `bool`。
- Struct は、型の構造ごとに 1 つの C の `struct`。Copy でも非 Copy でも値で持つ。`Ref<S>` / `Mut<S>` は `S*`。
- `Vec<T>` はハンドル `sts_vec*`。ハンドルは JS の `Vec` オブジェクトと、その `buf`（TypedArray）のデータへのポインタ、`len`、容量を持つ。C は JS の TypedArray のメモリを直接読み書きする（コピーしない）。`Vec` の値渡し（移動）と `Ref` / `Mut` は同じハンドルを渡す。`Vec.create` は JS の `Vec.create` をホストとして呼んで JS のオブジェクトを作る。`push` で容量が足りなければ、C が新しい ArrayBuffer を Node-API で作ってコピーし、JS の `Vec` の `buf` を差し替える。C が変えた `len` は、境界を出るとき（正常終了とトラップの両方）に JS のオブジェクトへ書き戻す。
- `Slice` は `{ data, len }` の値。JS の `Vec` か `Slice`（`buf`、`off`、`length`）から作る。書き込みは共有メモリに直接届く。
- `T | null`（`T` が数値型、`boolean`、Copy の Struct）は `{ bool some; T v; }`。
- 権限は不透明な `napi_value` のまま渡す。今は `Alloc` だけを扱い（`Vec.create` に渡す）、ほかの権限のメソッド呼び出しは未対応。
- STS のコードは、トラップの後で借用していた値を観測できない（`t.traps` の関数は所有型を捕捉できない。E3007）。トラップでも書き戻すのは念のためで、観測できる差はない。
- 境界: managed から来た実引数は、数値と `boolean` は値で、Struct は JS のオブジェクトのフィールドを読んで C の値にする。`Mut<S>` の実引数は、呼び出しの後（トラップでも）にフィールドを JS のオブジェクトへ書き戻す。戻り値の Struct は新しい JS のオブジェクトにする（Struct の同一性は観測できない。D100）。
- 数値型でない要素の `Vec` は D105 の配置で共有する。未対応のものを含む関数を C にしようとすると、位置つきの内部エラーで止まる。

## D103: C でのトラップと評価順

- トラップは `longjmp` で境界の入口に戻り、`Mut` の書き戻しと `len` の同期をしてから、ホストの `trap(code, file, line, col)` を呼んで JS の `Trap` を投げる。位置はソース上の位置で、呼び出し箇所ごとに C のソースに埋め込む（D030 と同じ考え方）。アンカーの規則は JS 側と同じ。
- 評価順: 式は左から右に一時変数へ落としてから使う（C の実引数とオペランドの評価順は未規定なので）。リテラル以外の部分式はすべて一時変数を通す。`&&`、`||`、`?:` は `if` にする。`v[i] = e` は `v`、`i`、`e` の順に評価してから範囲を検査し、`v[i] += e` は先に `v[i]` を読む（D100）。
- 整数は `int64_t`（`u32` の積は `__int128`）で計算してから範囲を調べるので、未定義動作の符号つきオーバーフローは起きない。`divTrunc` は 0 と範囲外を先に調べ、`rem` は 0 だけを調べる（`int64_t` の `%` なので `MIN % -1` も 0）。シフト量は 0〜31 を調べ、`i32` の `<<` は `uint32_t` でシフトする。整数に -0 はない。
- 浮動小数点: `f32` の演算は `float` の演算（x86-64 の SSE で 1 演算ごとに binary32 に丸める。`Math.fround(a op b)` と一致する）。`-ffp-contract=off` で積和の融合を止める。`Math.round`、`min`、`max`、`sign` は JS の定義（-0 と NaN を含む）どおりに自前で書く。C 側で数値を文字列にすることはない（出力は managed の JS がする）。
- strict の再帰の深さは C のスタックで決まるので、呼び出しの深さを数え、上限（10000）を超えたら T006 にする（Q035、Q182）。

## D092: 所有型を要素に持つコンテナの型を拒否する（Q174 の案2）

- 型を書いた位置は P2 で検査する。`Array` / `ReadonlyArray` / `Map` / `Set` / `Promise` の型引数が所有型なら、その型引数で E3007 を出す（`typeRef`）。入れ子（`Array<Array<Vec<f32>>>`）は内側の型で出る。型の別名・class・interface の具体化は、代入した結果のどこか（レコードのフィールド、class のフィールド、interface のメソッドの型、入れ子の別名を含む）にそういう型が現れたとき、具体化を書いた型参照で出す（`ownedDeep`、宣言の検査の後の `checkSubstInsts`）。型引数そのものがそういう型なら、その型引数の位置で報告済みなので出さない。
- 推論された型は P3 で検査する。呼び出しと `new` の結果の型がそういう型なら E3007 にする。アンカーは明示した所有型の型引数、なければ呼び出し先の名前。受け手の型がすでにそういう型の呼び出し（`m.set` など）は、受け手の出どころで報告済みなので出さない。この除外は報告を重ねないためのもので、健全性には関わらない。
- 前の規則（D091 の、コンテナを作る呼び出しの規則と「受け手がすでにそういうコンテナなら除外」）は削除した。
- 所有型の値を格納する式の E3007（Q048）は残した。`reduce` の初期値（`xs.reduce(…, mk(a))`）のように、型の規則に当たらない格納はこれで拒否する。
- 型が変わらないもの（managed のレコード、class のフィールド、クロージャ）は、今までどおり Q048 の格納の規則で検査する。`type Bx<T> = { readonly v: T }` の `Bx<Vec<f32>>` は受理のまま。
- 付録 B-8 の報告位置は戻り値の型注釈（1:33）に変わった。


## D104: C でのタグつき union、`Result`、ジェネリック、権限、契約、定数

- 文字列リテラル型（Q043。`kind` とその比較だけ）は、プログラム全体で番号を振った `int32_t`。境界では文字列と番号を相互に変える。
- strict / rt のレコード（全フィールドが `readonly` の Copy のレコード、Q043）は Struct と同じ C の `struct` にする。フィールドは `kind` を先頭に、残りを名前順に並べる。
- タグつき union と `Result` は、メンバの `struct` の C の `union`。どのメンバも `kind` で始まるので（共通の先頭部分）、`u.kind` で判定できる。絞り込んだ変数は、そのメンバ（`u.mI`）として読む。メンバの値を union の位置に置くときに包む。`ok(v)` / `err(e)` はそのメンバを直接作る。`switch` は C の `switch` にする（`case` のラベルはリテラルの番号か整数のリテラル）。境界では `kind` の文字列でメンバを選ぶ。
- `T | null` は D102 の `{ some, v }` に加え、`T` がタグつき union でもよい。`T | null` と `T` の `===` は Q017 のとおり。
- ジェネリックな strict / rt の関数は、具体化ごとに C の関数を作る（単相化）。型引数は呼び出しごとに検査器が記録したもの（`callTArgs`）を、外側の具体化で置き換えて使う。managed からの呼び出しは、呼び出し箇所ごとにその具体化のエクスポートを直接呼ぶ。JS 側の宣言そのものは呼ばれない（呼ばれたら内部エラー）。
- 権限（Q040）は `napi_value` のまま。`sys.clock` のようなプロパティは JS のプロパティを読み、メソッドは JS のメソッドを呼ぶ（引数と戻り値は境界と同じ変換）。文字列を取るメソッドは検査器が E4002 にするので、数値と `boolean` だけを扱う。
- `ensures` は、ブロック本体なら本体の `return` を述語の値にする。`void` の関数では、各 `return;` と本体の終わりで調べる。
- モジュール直下の `const`（§1: リテラルか、リテラルだけのレコード）は、使う位置ごとに初期化式を C に変換する。
- 非 `void` の関数の終わりには、到達しないことの印として内部エラーを置く（検査器が到達しないことを確かめている）。

## D105: 数値型でない `Vec` の要素の配置（Q184、SPEC §10.2）

- 配置は検査器の型から `layout.ts` が 1 か所で計算する。JS の変換器は計算済みの配置（オフセットと大きさ）を JSON にして `Vec.create` に渡し、ランタイムはそれを解釈するだけで、オフセットを計算し直さない。C の変換器は同じ配置から要素ごとの `ld_P` / `st_P`（フィールドごとの型つきの読み書き）を作る。C の struct の配置には頼らない。
- JS 側では、`Vec` は `Uint8Array` と `DataView` で要素を読み書きする。読み出しのたびに新しいオブジェクトを作る。`Slice` は同じ `Uint8Array` と配置を共有する。数値型の `Vec` はこれまでどおり TypedArray。
- C 側の文字列リテラルの値は大域の番号のままにし、要素の読み書きで配置の添字との間を表で変換する。
- 型パラメータを要素に持つ `Vec.create<T>` は、JS ではこれまでどおり配列で作る（D100）。C の境界に `Vec` として渡されたときは、ホストの `adopt` でその場で配置の表現に移す（`Vec` は束縛が 1 つなので、移しても別名は生じない）。そのような `Vec` の `Slice` は移せないので、C に渡すと内部エラーにする。
- C バックエンドはリトルエンディアンのホストを前提にする（Linux の x86-64 と arm64）。
- C の要素の読み書きは、フィールドの型での読み書きにする（配置がフィールドを整列させ、JS の `ArrayBuffer` は 8 バイト以上に整列しているので正しい）。バイト単位の `memcpy` だと `Vec` のヘッダと別名になりうるので、最適化が効かない（ROADMAP のベンチマークの記録）。

## D106: C の評価順の徹底、スタックの上限、確保の失敗（独立レビューの指摘）

- ローカル変数の読み出しと代入式の値も一時変数に取る（D103 の徹底）。後のオペランドがその変数に代入しても（Q172）、先に読んだ値は変わらない。`v[i] op= e` の添字も `e` を評価する前の値で範囲を検査して書く（`run/78`）。
- Q182: 呼び出しの深さ 10000 に加えて、スレッドの実際のスタックの下限から余裕（スタックの 1/8、最低 256 KiB）を残した位置を超えたら T006 にする。大きな値渡しの Struct の再帰でもプロセスは落ちない（`run/80`、`cli.test.ts`）。
- `Vec` の伸長は容量を 2 倍にするが、`usize` の範囲（2^32 - 1 要素）で頭打ちにし、長さが 2^32 - 1 のときの `push` は T006 にする。JS 側は同じ大きさで型つき配列の確保が `RangeError`（T006）になるか、メモリが足りずに落ちる。2 GiB を超える試験は置かず、コードを読んで確かめた。`Vec` の長さは JS から倍精度で読み、容量を超えていたら内部エラーにする。
- ホストの `create` が投げた例外（`RangeError`）と、伸長での `ArrayBuffer` の確保の失敗は、その呼び出しの位置の T006 にする（D100 と同じ）。
- strict / rt の `a ?? b` と、文字列リテラルの union の `T | null` も C にした（`run/81`）。
- 既知の制限: 1 回の境界の呼び出しの中で作った `Vec` のハンドルと Node-API の値は、その呼び出しが戻るまで解放しない。ループの中で `Vec.create` や権限のメソッドを非常に多く呼ぶと、その分だけメモリを使う。

## D107: ループの中の層の境界の警告（W8001、Q187）

- 検査の後に、構文木を 1 回なめる別の段（`boundary.ts`）で出す。型検査と所有権の検査にエラーがあれば走らせない。警告は `check` の結果にだけ入り、`run` / `test` は警告で止まらない（`RunResult.diagnostics` にも入れない）。
- 呼び出し先はモジュール直下の名前（import を含む）で解決する。局所変数が strict の関数と同じ名前を隠していても警告する（既知の制限）。
- テストのハーネスは `accept` のケースの `// expect-warning:` の行と、`check` が返した警告の集合を比べる。行がなければ警告が 0 件であることを求める。

## D108: C の整数演算の検査を演算の型で行う

- `+`、`-`、`*` は `__builtin_add_overflow` などで、結果がその整数型に収まるかを調べる（T001）。以前は 64 ビットに広げてから範囲と比べていた。検査の意味は同じで、外した検査はない。
- 広げてから比べる形だと、gcc はループをまたぐ値（prefix sum の `s[i - 1]`）をレジスタに置けず、毎回メモリから読み直していた。組み込み関数の形にすると手書きの C に近い命令列になる（使い捨ての C で、検査つきで 1.82 ms から 0.27 ms、検査なしは 0.25 ms）。
- `divTrunc` と `rem` も演算の型で計算する（`STS_DIV` / `STS_REM`）。0 での除算は T007。符号つきで除数が -1 のときは、`divTrunc` を検査つきの符号反転（最小値は T001）にし、`rem` を 0 にする（C の未定義動作を避ける）。64 ビットの剰余は gcc がベクトル化しないので、`rem(u32(i), 3)` のようなループが遅かった。境界の値は `run/83`。

