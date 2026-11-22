# Szigyr コンパイラ

TypeScript の構文をそのまま使い、意味を「健全なサブセット＋所有権＋明示的能力境界＋権限渡し」に絞った AI ファースト言語 **Szigyr**（`.szigyr`、CLI `szigyr`）のコンパイラ。
コードを書く主役は AI であり、人間向けの省略構文や暗黙推論よりも「明確さ・局所性・決定性・構造化されたツール出力」を最優先にする。

## 文書

| ファイル | 役割 |
| --- | --- |
| `docs/SPEC.md` | 言語仕様（現在の規範。ただし絶対ではなく、AI フレンドリーさを損なう場合は SPEC 側を見直す） |
| `docs/ROADMAP.md` | 段階と完了条件。「現在の段階」もここ |
| `docs/OPEN_QUESTIONS.md` | 仕様の穴の記録（なければ作る） |
| `docs/DIAGNOSTICS.md` | エラーコード一覧（なければ作る） |
| `docs/DECISIONS.md` | 実装上の判断の記録（なければ作る） |

作業を始める前に、必ず `docs/SPEC.md` を全部読むこと。TypeScript の学習データを活かす拡張設計だが、健全なサブセットとネイティブ拡張の正確な境界は仕様書が唯一の規範になる。

## 決定済みの前提（変えない）

- 構文は TS が基本。新しい概念は型・組み込み関数・指示子（`"use owned"`、`"use rt"`、`"use unsafe"`、`using`、`declare module "c:..."`）で表す。`"use strict"` は使わない。
- TS 構文をベースに健全な意味論へ拡張する（`indexOf -> null`、`JSON.parse -> Result`、`charCodeAt -> T002` 等を含む）。受理したプログラムは、規定の変換後に JS/C/Wasm として動かした挙動が基準（非 C 専用コードは 3 バックエンド同値）。
- 層は 3 つ。managed（既定・JS GC）、strict（`"use owned"`）、rt（`"use rt"`）。
- managed 層は JS エンジン上で動く。C / Wasm に変換するのは strict / rt 層。
- 参照は二級。`Ref<T>` と `Mut<T>` はパラメータ型にしか書けない。ライフタイム注釈は存在しない。
- 外界に触れる機能は、権限オブジェクト（`System` / `Log` / `Clock` 等）を引数で受け取った関数だけが使える。
- 関数の引数・戻り値・ジェネリック能力境界（`T extends Copy & Native` 等）は明示。推論はローカル変数と呼び出し型引数だけ。
- コンパイラは TS で書く。対象は Linux（C/Wasm/Node/Browser）。
- 言語名・CLI 名・識別子は `szigyr`（`packages/compiler/src/names.ts` の定数から導出）。

## 設計の選別基準

「AI フレンドリー」は次の 4 点で定義する。

- **学習量が多い**: TS の安全な構文を無駄に禁止せず、事前学習資産をそのまま活かせる。
- **書き間違えづらい**: 曖昧・危険な構文は拒否し、`--json` JSONL、`data`、`fixes`、`szigyr query`、`szigyr explain`、`szigyr mcp` で機械可読に返す。
- **テストを回しやすい**: 権限渡し・偽権限・同居テスト・`forAll`・`mutate` で速く確実に検証できる。
- **ネイティブ表現の連続性**: ネイティブ操作も可能な限り TS の延長線として表現できる。

機能追加の軸は「他者が結果を信じるための機能」（健全性、権限、契約、`forAll`、mutation テスト）と「速度・リアルタイム性のための機能」に置く一方、健全性・曖昧さに関係のない標準 TS 構文の過剰禁止や暗黙推論・曖昧な糖衣構文は避ける。
判断は常に「AI フレンドリーか」を最優先にする。`docs/SPEC.md` も既存テストも絶対に真ではなく、そのまま維持することを最優先にする意味はない。AI にとって罠になる・不自然・矛盾する点があれば、場合によっては SPEC や既存テスト自体を疑って見直す。

## 技術選定

- 言語: TypeScript（strict）。ESM。Node 24 以上。パッケージ管理は pnpm。
- 構文解析: `typescript` パッケージの構文解析 API だけを使い、呼び出しは `packages/compiler/src/parse.ts` の 1 モジュールに閉じ込める。**tsc の型検査器（`Checker`、型検査の診断）は使わない**。型検査器は自作する。
  - `typescript` は最新を使う。7 系の `typescript/unstable/sync` と `typescript/unstable/ast` を使う（`docs/DECISIONS.md` D005）。
- テスト: vitest。
- 依存は最小限。追加するときは `docs/DECISIONS.md` に理由を書く。

## リポジトリ構成（案）

```
packages/compiler/     コンパイラ本体（parse / check / ownership / layers / emit-js / emit-c / diagnostics / cli）
packages/runtime-js/   開発時ランタイム（整数検査、Vec、トラップ、契約）
packages/std/          標準ライブラリ（偽の権限など）
conformance/accept/    受理すべきソース
conformance/reject/    拒否すべきソース。先頭行に `// expect: E3001 @ 12:9`
conformance/run/       実行して結果を比べるソース。`// expect-output: ...` または `// expect-trap: T001 @ 8:14`
docs/
```

## 進め方

1. `docs/ROADMAP.md` の段階 0〜6 は完了済み。作業はタスクごとに合意したスコープに沿って進める。
2. TDD で進める。機能ごとに、先に conformance のケース（受理・拒否・実行）を足し、失敗を確認してから実装する。
3. 拒否ケースは、エラーコードと位置（行:列）の一致まで検査する。メッセージの文面はテストで固定しない。
4. 診断は最初から JSON と安定したエラーコードで出す。一度割り当てたコードの意味は変えない。割り当てたら `docs/DIAGNOSTICS.md` に追記する。
5. コンパイラ実装は許可リスト方式を保つ（未検証構文を暗黙に素通ししない）。一方で仕様設計では、健全性・曖昧さの根拠なく安全な TS 構文を拒否しない（緩和するときは先に `docs/SPEC.md` と conformance を更新する）。
6. 仕様の穴や矛盾を見つけたら、勝手に決めない。`docs/OPEN_QUESTIONS.md` に「状況、選択肢、既定案」を書き、既定案で実装を進め、該当テストにコメントで印を付ける。
7. 仕様を変える必要があるときは、先に `docs/SPEC.md` と conformance を直し、それから実装を直す。
8. 小さくコミットする。各コミットで全テストが通ること。
9. 各段階の終わりに、完了条件を満たした証拠（テスト結果、ベンチ結果）を `docs/ROADMAP.md` に追記する。

## やらないこと

- tsc の型検査器に頼る。
- SPEC に合意なく未検証の TS 機能を暗黙に素通しする。
- 暗黙の型変換や曖昧な糖衣構文。
- managed 層のネイティブ化（保留中）。
