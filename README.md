# Szigyr

TypeScript の構文をそのまま使い、「健全なサブセット＋所有権＋明示的能力境界＋明示的権限渡し」を備えた AI ファースト言語 **Szigyr**（`.szigyr`、CLI `szigyr`）のコンパイラ・ツールチェインです。

- **3 層設計**: `managed`（既定・JS GC）、`"use owned"`（strict・値／所有型＋静的または単回検査）、`"use rt"`（非確保・実時間安全・決定性）
- **3 バックエンド一致**: 非 C 専用コードは `--backend=js|c|wasm` で同じ出力・同じ位置のトラップ
- **信頼性と速度の機構**: 契約（`requires` / `ensures` / `invariant`）、性質テスト `forAll`、型付き変異テスト `szigyr mutate`、SMT 静的証明 `szigyr prove`（`build --release` で証明済み検査を除去）
- **AI 向け第一級導線**: 全コマンドの `--json` JSONL 出力、`query` / `explain`、および常駐 MCP サーバ `szigyr mcp`

## 前提環境

- **Node.js 24+**・**pnpm 12+**（このリポジトリで初回のみ `pnpm install`）
- **C バックエンド（任意）**: `cc`（`gcc` / `clang`、`CC` で上書き可）＋ Node-API ヘッダ。`declare module "c:..."` を使う場合は `pkg-config` と対象ライブラリ（例: `sdl3`）
- **Wasm / Browser ビルド（任意）**: `clang --target=wasm32`（lld 含む）または `zig cc`（`SZIGYR_WASM_CC` で上書き可）
- **SMT 静的証明**: `z3-solver`（Wasm）を同梱。PATH 上に `z3` / `cvc5` があれば優先使用（`SZIGYR_SMT` で指定または `wasm` 固定可）

## 別プロジェクトから `szigyr` を使う

このリポジトリで `pnpm install` を済ませれば、`packages/compiler/src/cli.ts` を任意のプロジェクトディレクトリから直接実行できます。`npm:` インポートはそのプロジェクト側の `node_modules` から解決され、キャッシュは作業ディレクトリの `.szigyr-cache/` に保存されます。

```bash
# このリポジトリのルートで依存を入れる（実行コマンドにリンクする場合）
pnpm install
ln -sf "$(pwd)/packages/compiler/src/cli.ts" ~/.local/bin/szigyr
```

PATH にリンクしない場合は、パスを直接指定して実行できます（例: `node /path/to/szigyr/packages/compiler/src/cli.ts check src/main.szigyr`）。外部プロジェクトの `.gitignore` には `.szigyr-cache/` を追加してください。

## 主要 CLI コマンド

```bash
szigyr check [--json] [--watch] [--fix] <file...>
szigyr run [--backend=js|c|wasm|both|all] <file> [-- <args...>]
szigyr test [--all] [--filter=<pat>] [--backend=js|c|wasm|both|all] [--watch] [--json] <file...>
szigyr prove [--all] [--strict] [--no-cache] [--timeout=<ms>] [--json] <file...>
szigyr mutate [--all] [--fail-on-survived] [--no-cache] [--json] <file...>
szigyr query [--json] <file...>
szigyr explain [--json] <code>
```

- **Node 向けビルド**:
  ```bash
  szigyr build --target=node [--backend=c|js|wasm] [--mode=app|lib] [--release] [-o dist] <file>
  node dist/main.js                # --mode=app の実行
  ```
  `--mode=lib`（および `app.js`）は `import { load } from "./dist/app.js"` で JS ホストから呼び出せます。
- **ブラウザ向けビルド**:
  ```bash
  szigyr build --target=browser [--mode=app|lib] [--release] [-o dist-web] <file>
  ```
  静的 ESM・`program.wasm`・`szigyr-worker.js`・`szigyr-worklet.js`・バンドル済み `vendor/`（`--mode=app` では `index.html` も）を出力します。`AudioWorklet` / `Ring` の zero-copy `SharedArrayBuffer` 経路を使う場合は COOP/COEP ヘッダ付きで配信してください（未設定時は `MessagePort` フォールバック）。

## AI エージェント向け `szigyr mcp` 設定例

stdio JSON-RPC 2.0 MCP サーバとして起動します（未リンクの場合は `"command": "/path/to/szigyr/packages/compiler/src/cli.ts"` としてください）。

```json
{
  "mcpServers": {
    "szigyr": {
      "command": "szigyr",
      "args": ["mcp"]
    }
  }
}
```

- **リソース**: `szigyr://spec`（言語仕様全文 `docs/SPEC.md`）、`szigyr://builtins`（組み込み関数・名前空間・型の JSON カタログ）
- **ツール**: `szigyr_check`, `szigyr_query`, `szigyr_explain`, `szigyr_test`（`all` / `filter` 対応）, `szigyr_run`, `szigyr_prove`, `szigyr_mutate`（常駐ワーカーでパーサ / SMT を再利用）

既存アプリを `.szigyr` へ書き換える場合も、AI エージェントには作業前に `szigyr://spec`（または [`docs/SPEC.md`](docs/SPEC.md)）と `szigyr://builtins` を参照させると仕様に沿ったコードを生成できます。

## ドキュメント・実例・コンパイラ開発

- **仕様と設計記録**: [`docs/SPEC.md`](docs/SPEC.md) / [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md) / [`docs/ROADMAP.md`](docs/ROADMAP.md) / [`docs/DECISIONS.md`](docs/DECISIONS.md) / [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md)
- **実例**: [`examples/retouch/`](examples/retouch)（画像フィルタ・契約証明・`Display` Canvas 2D / SDL3 対話アプリ [`app.szigyr`](examples/retouch/app.szigyr)）、[`examples/microdaw/`](examples/microdaw)（ポリフォニックシンセ／16 ステップシーケンサ・Browser AudioWorklet Wasm / Linux WebKitGTK Desktop）、[`examples/gzlog/`](examples/gzlog)（`zlib` C FFI＋`Resource.ownWith`）、[`examples/workspace-tool/`](examples/workspace-tool)（`Fs`・`Proc`・`Net`・`Url`・`use rt` 走査・Web UI）、[`examples/audio-portable/`](examples/audio-portable)（Node + ブラウザ Wasm AudioWorklet）、[`examples/audio/`](examples/audio)（Node + SDL3 FFI）
- **このリポジトリでの開発検証**:
  ```bash
  pnpm typecheck
  pnpm verify:conformance
  pnpm test
  pnpm conformance
  pnpm bench
  ```
