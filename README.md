# 放置作家 (houchi-sakka)

AI執筆前提の創作環境 + 小説投稿サイト。人間は物語の意思決定者であり、情報管理者ではない。

詳細は [`docs/spec.md`](docs/spec.md) を参照。

## 構成(予定)

- `apps/web` — 読者サイト + Studio + API (React Router on Cloudflare Workers, D1, R2)
- `apps/runner` — AI実行体 (Node.js: ホステッド常駐 / 将来ローカルCLI)
- `packages/*` — contracts, domain, database, orchestrator, harness, providers 等

## 開発

```bash
pnpm install
pnpm -r build
pnpm -r test
```
