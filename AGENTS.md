# AGENTS.md

リポジトリ全体の開発ガイドラインです。作業対象ディレクトリのガイドもあわせて確認してください。

## スコープ別のドキュメント

| パス | 対象 | 主な内容 |
| --- | --- | --- |
| [src/lib/AGENTS.md](src/lib/AGENTS.md) | LOD ライブラリ本体 | three 依存方針、バリアント共有、常駐管理と予算適応の不変条件 |
| [src/demo/AGENTS.md](src/demo/AGENTS.md) | デモ共通・板ポリデモ | デモビルド構成、板ポリデモ仕様、`window.__lodDemo` |
| [src/demo/vrm/AGENTS.md](src/demo/vrm/AGENTS.md) | VRM デモ | アトラス化、絶対 Tier、複製・徘徊、URL パラメータと HUD/GUI |
| [scripts/AGENTS.md](scripts/AGENTS.md) | 検証・取得スクリプト | スモークテスト前提・検証内容、モデル取得と SHA-256 固定 |
| [docs/measurements.md](docs/measurements.md) | 計測記録 | WebGPU / WebGL2 のパイプライン・メモリ・フレーム時間実測値 |

## ビルドと配布物の構成

`dist/demo/` と `dist/lib/` は互いに消さずに共存させます。

- `pnpm build` — デモアプリ（`index.html`, `vrm.html`, `src/demo/`）を `dist/demo/` へ出力する
- `pnpm build:lib` — ライブラリ本体（`src/lib/index.ts`）を `dist/lib/` へ出力し、`tsconfig.build.json` で型宣言を生成する（`public/` は含めない）
- `pnpm build:all` — デモとライブラリの両方を生成する

## 検証コマンド

- `pnpm typecheck` — TypeScript 型検査（`src`, `vite.config.ts`, `vite.lib.config.ts`）
- `pnpm test` — Vitest によるユニット・ファズテスト
- `pnpm smoke` — 板ポリデモの E2E スモーク（`pnpm build` 済み前提）
- `pnpm smoke:vrm` — VRM デモの E2E スモーク（`pnpm models:fetch` と `pnpm build` 済み前提）

## 単位表記の規約

ドキュメントおよび計測記録では、コードの `stats()` バイト値に基づく容量は MiB（バイト数を $1024^2$ で割った値）で表記し、URL パラメータ（`?budget`・`?atlas`）や GUI 表示の MB 表記と区別します。

## コーディング・テスト・文書規約

本リポジトリオリジナルのコード・テスト・ドキュメントを編集する際は、`.agents/skills/` 配下のスキル（`code-writing`, `ts-writing`, `test-writing`, `document-writing`, `design-policy`, `design-writing`）に従います。
