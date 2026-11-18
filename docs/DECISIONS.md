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

- `packages/runtime-js/src` は依存なし。整数演算は型名を第 1 引数に取る共通関数（`add("i32", a, b, pos)`）で、`RANGE` の表 1 つで 7 型を畳む。`wrapMul` は 32 ビット型で `Math.imul` を使う。
- `packages/std` は `../../runtime-js/src/index.ts` を相対 import する（pnpm の workspace リンクを使わず、`pnpm install` なしで動く。コンパイラ側が名前で import したくなったら見直す）。
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
