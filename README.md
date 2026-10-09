# 放置作家 (houchi-sakka)

AI執筆前提の創作環境 + 小説投稿サイト。人間は物語の意思決定者であり、情報管理者ではない。

詳細は [`docs/spec.md`](docs/spec.md) を参照。

## 構成

pnpm workspaces モノレポ。`pnpm -r build` / `pnpm -r typecheck` / `pnpm -r test` が全グリーンの状態を保つ。

- `apps/web` — Cloudflare Workers の API (Phase 0 は API のみ。Studio UI は Phase 1)
  - `src/app.ts` — 素の fetch ハンドラ。`createApp({ db, secretKey, executorToken })` で DI するので D1 と better-sqlite3 の両方で動く
  - `src/index.ts` — Workers エントリ (env.DB / APP_SECRET_KEY / EXECUTOR_TOKEN)
- `apps/runner` — Node.js 実行体 (常駐ループ: lease → 処理 → progress → complete)
  - `src/api.ts` — Web API クライアント
  - `src/loop.ts` — `tick()` (1回分の lease+実行) と `runLoop()` (ポーリング常駐)
  - `src/cli.ts` — `pnpm --filter runner start` のエントリ
- `packages/contracts` — Zod スキーマの正本 (AgentJob / ProgressEvent / ProviderKey / API リクエストレスポンス / ProviderRequest-Response)
- `packages/secrets` — AES-256-GCM 暗号化 (Web Crypto、Node と Workers で共通)。`secretsEqual` はトークン比較用の定数時間比較
- `packages/providers` — `Provider` インターフェース、`OpenAIResponsesProvider` (Responses API、SSE ストリーム対応)、`StubProvider` (呼出しカウンタ付き)
- `packages/database` — Drizzle ORM スキーマ + リポジトリ関数 + `migrations/` (drizzle-kit 互換 SQL)。`DbLike` インターフェースで D1/better-sqlite3 を吸収
- `packages/harness` — ジョブ種別ごとのステートマシン。Phase 0 は `smoke_generate` のみ

## 開発

```bash
corepack enable        # pnpm を corepack 経由で使う (packageManager フィールド固定)
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

必要な環境変数は [.env.example](.env.example) を参照。`.env` はコミットしない。

## API 概要 (Phase 0)

すべて `Authorization: Bearer <EXECUTOR_TOKEN>` (共有秘密) が必要。`GET /api/healthz` のみ無認証。

| Method | Path | 内容 |
| --- | --- | --- |
| POST | `/api/jobs` | ジョブ作成。`idempotency_key` が一致する既存ジョブがあればそれを返す (二重作成抑止) |
| POST | `/api/jobs/lease` | `queued` または期限切れ `leased` から1件リース。`lease_token` と `lease_expires_at` を発行 |
| GET | `/api/jobs/:id` | ジョブ参照 (lease_token は返さない) |
| POST | `/api/jobs/:id/progress` | 進捗イベント追記 (seq はサーバー側で連番) |
| POST | `/api/jobs/:id/heartbeat` | リース延長 + `payload.checkpoint` へのマージ |
| POST | `/api/jobs/:id/complete` | lease_token 照合 + 期限確認のうえ完了 |
| POST | `/api/jobs/:id/fail` | 同上で失敗終了 |
| POST | `/api/internal/keys` | プロバイダーキー登録 (AES-256-GCM で暗号化して保存) |
| GET | `/api/internal/keys/:ref` | 復号して平文を返す (実行体のみが使う) |

同一 `work_ref` を持つジョブは有効なリースが残っている間は別実行体にリースされない (直列化)。

## 手動スモーク (wrangler dev、実 OpenAI キー不要)

`apps/runner` を `RUNNER_PROVIDER=stub` で動かせば OpenAI を呼ばずに lease → progress → complete の全経路を確認できる。

1. 依存インストールと鍵生成

   ```bash
   pnpm install && pnpm -r build
   openssl rand -base64 32   # → APP_SECRET_KEY の値
   ```

2. `apps/web/.dev.vars` を作る

   ```
   APP_SECRET_KEY=<さっき生成した base64>
   EXECUTOR_TOKEN=dev-token
   ```

3. D1 ローカルにマイグレーション適用 + wrangler dev 起動

   ```bash
   cd apps/web
   pnpm exec wrangler d1 migrations apply houchi-sakka --local
   pnpm dev   # http://localhost:8787
   ```

4. 別ターミナルで runner を stub モードで起動

   ```bash
   cd apps/runner
   WEB_BASE_URL=http://localhost:8787 EXECUTOR_TOKEN=dev-token RUNNER_PROVIDER=stub \
     pnpm start
   ```

5. ジョブを作る

   ```bash
   curl -s http://localhost:8787/api/jobs \
     -H 'authorization: Bearer dev-token' \
     -H 'content-type: application/json' \
     -d '{
       "kind": "smoke_generate",
       "idempotency_key": "smoke-1",
       "payload": {
         "model": "stub-model",
         "provider": "stub",
         "input": [{"role": "user", "content": "こんにちは"}]
       }
     }'
   ```

   runner が数秒以内にリースして完了する。`GET /api/jobs/:id` で `status: "completed"` と `result.output_text` を確認できる。

6. 実 OpenAI で叩く場合 (任意)

   ローカル確認なら `OPENAI_API_KEY` を直接使う `--env-key` モード:

   ```bash
   WEB_BASE_URL=http://localhost:8787 EXECUTOR_TOKEN=dev-token OPENAI_API_KEY=sk-... \
     pnpm start --env-key
   ```

   payload の `provider` を `"openai"` (省略時の既定) にしてジョブを作る。

   本番想定の `key_ref` 経路は `POST /api/internal/keys` にキーを登録し、payload の `key_ref` にキー ID を指定する (runner は `GET /api/internal/keys/:ref` で復号済みキーを取得する)。`--env-key` 未指定時は `key_ref` 経路が使われる。

## チェックポイント / 再開の仕組み

`smoke_generate` は provider の結果を `POST /api/jobs/:id/heartbeat` の `checkpoint` で `payload.checkpoint.provider_result` に保存してから `complete` する (結果永続化 → 完了マークの2段階)。

実行体が途中で死んだ場合、リース期限切れ後に別実行体が再リースする。その際 `payload.checkpoint.provider_result` があれば provider を再呼出しせず保存済み結果で完了する。テストでは `StubProvider.calls === 1` で二重呼出しがないことを検証している。

## 仕様からの判断事項 (Phase 0)

- **チェックポイントの置き場所**: spec は「payload 内 `checkpoint` フィールドか別テーブル」と許容。payload 内 `checkpoint` を選んだ (heartbeat とのマージが原子的でテーブルが増えないため)。
- **DB アクセス層**: `drizzle-orm` の `db.get/all/run(sql``)` に合わせた `DbLike` インターフェースで、D1 (非同期) と better-sqlite3 (同期) を同一コードで扱う。
- **リースの原子性**: `UPDATE ... WHERE id = (SELECT ... ) RETURNING` の単発クエリにして、複数実行体での二重リースを SQL レベルで防ぐ。`work_ref` 直列化もこのクエリ内の `NOT IN` サブクエリで実現。
- **進捗 seq**: `progress_events` に `(job_id, seq)` のユニーク制約を付け、seq は `MAX(seq)+1` でサーバー側採番。
- **トークン進捗**: ストリーム中の token イベントは 500ms ごとにまとめて POST する (API スパム防止)。complete 前に残りを必ずフラッシュ。
- **エラー分類**: `JobInfraError` (API 通信・DB 失敗など配管系) はジョブを leased のまま残して次回リースに任せる。それ以外 (payload 不正・provider エラー・不明 kind) は `fail` で失敗終了。
- **`GET /api/internal/keys/:ref`**: 実行体専用のため `EXECUTOR_TOKEN` 認証のみ。返却値は復号済み平文 (`{"api_key": ...}`)。
- **usage**: OpenAI から usage が取れない場合は推測せず `"unknown"` を返す (spec 準拠)。
