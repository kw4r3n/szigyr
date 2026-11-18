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
