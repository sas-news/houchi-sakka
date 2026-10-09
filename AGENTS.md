# AGENTS.md

このリポジトリは「放置作家」(AI執筆前提の創作環境+小説投稿サイト)の実装です。

## 最重要

- **仕様書は `docs/spec.md`**。実装判断は必ずこれに従う。仕様と矛盾する変更は勝手にしない。
- 原則の要約: 人間は物語の意思決定者であり情報管理者ではない。創作上の変更はすべてオーケストレーター対話経由。本文生成は Writing Contract ゲート通過後のみ。重大変更は影響分析+承認の変更セットとして扱う。

## 技術構成

- pnpm workspaces + TypeScript モノレポ
- `apps/web`: React Router + Cloudflare Workers + D1 (Drizzle) + R2
- `apps/runner`: Node.js LTS 実行体(ジョブのリース取得→プロバイダー呼び出し→進捗永続化)
- `packages/contracts`: Zod スキーマの正本(API・ジョブ・変更セットの型)
- `packages/secrets`: BYO APIキーの暗号化境界層。キーの平文をログ・例外に出さない
- `packages/providers`: プロバイダー非依存の Provider インターフェース + OpenAI Responses アダプター

## ルール

- 秘密情報・APIキーをコミットしない。.env は .env.example で雛形のみ。
- UIは日本語のみ。テキストラベルを使い、絵文字だけのボタンにしない。スマホ(Android Chrome)で操作が完結するレスポンシブ。
- テストは Vitest。変更したパッケージのテストと `pnpm -r typecheck` を通してからPRにする。
