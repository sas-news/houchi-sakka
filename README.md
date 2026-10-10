# 放置作家 (houchi-sakka)

AI執筆前提の創作環境 + 小説投稿サイト。人間は物語の意思決定者であり、情報管理者ではない。

詳細は [`docs/spec.md`](docs/spec.md) を参照。

## 構成

pnpm workspaces モノレポ。`pnpm -r build` / `pnpm -r typecheck` / `pnpm -r test` が全グリーンの状態を保つ。

- `apps/web` — Studio + API (Cloudflare Workers + React Router framework mode + D1)
  - `workers/app.ts` — Workers エントリ。`/api/*` は素の fetch ハンドラ (`src/app.ts`)、それ以外は React Router SSR に流す
  - `src/app.ts` — `createApp(deps)` の DI 形 API。D1 と better-sqlite3 の両方で動く
  - `src/auth.ts` — better-auth (Google/GitHub OAuth + dev-login 用 email/password)
  - `app/` — React Router のルート (`/login`, `/`, `/works/new`, `/works/:id`, `/settings/keys`)。素の CSS (`app/app.css`)
  - `test/helpers.ts` — `makeApp()` (createTestDb + createAuth + createApp) とセッション cookie 発行ヘルパー
- `apps/runner` — Node.js 実行体 (常駐ループ: lease → 処理 → progress → complete)
  - `src/api.ts` — Web API クライアント (key resolve / thread context / message append / work patch 含む)
  - `src/loop.ts` — `tick()` (1回分の lease+実行) と `runLoop()` (ポーリング常駐)
  - `src/cli.ts` — `pnpm --filter runner start` のエントリ
- `packages/contracts` — Zod スキーマの正本 (AgentJob / ProgressEvent / ProviderKey / Work / Chat / API・ジョブ payload)
- `packages/secrets` — AES-256-GCM 暗号化 (Web Crypto、Node と Workers で共通)。`secretsEqual` はトークン比較用の定数時間比較
- `packages/providers` — `Provider` インターフェース、`OpenAIResponsesProvider` (Responses API、SSE ストリーム対応)、`StubProvider` (呼出しカウンタ付き)
- `packages/database` — Drizzle ORM スキーマ + リポジトリ関数 + `migrations/` (drizzle-kit 互換 SQL)。`DbLike` インターフェースで D1/better-sqlite3 を吸収
- `packages/harness` — ジョブ種別ごとのステートマシン (`smoke_generate`, `orchestrator_turn`)
- `packages/prompts` — オーケストレーターの日本語システムプロンプトと `<<WORK_PATCH>>` パーサー

## 開発

```bash
corepack enable        # pnpm を corepack 経由で使う (packageManager フィールド固定)
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

必要な環境変数は [.env.example](.env.example) を参照。`.env` / `.dev.vars` はコミットしない。

## 認証の2系統

- **ユーザー向け** (`/api/works`, `/api/keys`, `/api/me` …): better-auth の HttpOnly Cookie セッション。ログインは Google / GitHub OAuth (環境変数で有効化)。未ログインで画面にアクセスすると `/login` に飛ぶ
- **実行体向け** (`/api/jobs`, `/api/internal/*`): `Authorization: Bearer <EXECUTOR_TOKEN>` (共有秘密)
- **`POST /api/dev/login`**: `DEV_LOGIN_ENABLED=true` の時だけ有効な開発用ワンクリックログイン (固定ユーザー `dev@houchi-sakka.local`)。**本番では絶対に有効化しない** — 誰でもログインできる抜け道になる。ログイン画面に「開発用ログイン」ボタンが出るのもフラグ時のみ

## API 概要

### ユーザー向け (セッション Cookie)

| Method | Path | 内容 |
| --- | --- | --- |
| GET | `/api/config` | 公開設定 (`dev_login_enabled`) |
| GET | `/api/me` | ログイン中ユーザー |
| GET/POST | `/api/works` | 作品一覧 / 作品作成 (対話スレッド + 案内メッセージも同時生成) |
| GET | `/api/works/:id` | 作品 + スレッド + メッセージ + 実行中ジョブ (UI のポーリング先) |
| POST | `/api/works/:id/messages` | ユーザー発言を保存 → `orchestrator_turn` ジョブをキュー (202) |
| GET/POST | `/api/keys` | BYO キー一覧 / 登録 (AES-256-GCM で暗号化、ciphertext は返さない) |
| DELETE | `/api/keys/:id` | 自分のキーのみ削除 |

### 実行体向け (Bearer)

| Method | Path | 内容 |
| --- | --- | --- |
| POST | `/api/jobs` | ジョブ作成。`idempotency_key` が一致する既存ジョブがあればそれを返す |
| POST | `/api/jobs/lease` | `queued` または期限切れ `leased` から1件リース |
| GET | `/api/jobs/:id` | ジョブ参照 (lease_token は返さない) |
| POST | `/api/jobs/:id/progress` | 進捗イベント追記 (seq はサーバー側で連番) |
| POST | `/api/jobs/:id/heartbeat` | リース延長 + `payload.checkpoint` へのマージ |
| POST | `/api/jobs/:id/complete` | lease_token 照合 + 期限確認のうえ完了 |
| POST | `/api/jobs/:id/fail` | 同上で失敗終了 |
| POST | `/api/internal/keys` | プロバイダーキー登録 |
| POST | `/api/internal/keys/:ref/resolve` | `{job_id}` を受け、`key.owner_ref === job.user_ref` の時だけ復号済み平文を返す (不一致は 403) |
| GET | `/api/internal/threads/:id/context` | orchestrator の入力 (work + thread + messages) |
| POST | `/api/internal/threads/:id/messages` | assistant メッセージ永続化 (`job_id` ユニークで冪等) |
| POST | `/api/internal/works/:id/patch` | WORK_PATCH の適用 |
| POST | `/api/internal/proposals` | PROPOSE の実体化 (episode/scene/contract/proposal 一括作成) |
| POST | `/api/internal/works/:id/canon-facts` | CANON_FACTS の蓄積 |
| GET | `/api/internal/scenes/:id/context` | generate_scene の入力 (シーン+契約+作品+正典+直前シーン抜粋) |
| POST | `/api/internal/scenes/:id/revisions` | 生成リビジョンの確定 (scene→generated) |

ユーザー向け (Phase 1b): `POST /api/proposals/:id/approve|reject` (承認カードの決定。approve は generate_scene を投下)、`GET /api/works/:id/prose` (本文タブ用)、`POST /api/scenes/:id/rewrite` (書き直し=新リビジョン)、`POST /api/scenes/:id/revisions` (手編集保存)、`PATCH /api/works/:id/settings` (キー/モデル設定)。

同一 `work_ref` を持つジョブは有効なリースが残っている間は別実行体にリースされない (直列化)。

## orchestrator_turn の流れ

`POST /api/works/:id/messages` → ユーザー発言を保存し `orchestrator_turn` ジョブをキュー → runner がリースして `fetchOrchestratorContext` (スレッド履歴+作品情報) を取得 → `packages/prompts` の日本語システムプロンプトで生成 → assistant メッセージを永続化して complete。UI は `GET /api/works/:id` を 1.5 秒ごとにポーリングし、進捗とストリーム中のテキストを表示する。

返答末尾のマーカー行をパースして適用する (いずれも末尾の連続マーカー行のみ有効、パース失敗は無視):
- `<<WORK_PATCH {...}>>` — 作品属性 (title/premise/genre/status/charter/policy) を更新
- `<<CANON_FACTS ["文", ...]>>` — 正典メモ (canon_facts) に追記。statement 完全一致は重複スキップ
- `<<PROPOSE {...}>>` — 「話+シーン+Writing Contract」の提案を作成し、チャットに承認カードを表示する (proposal + episode/scene/contract をサーバー側で一括作成)

最初のユーザー発言で作品は `setup` → `active` に遷移する。

## Phase 1b: 提案 → 承認 → 本文生成

- **提案カード**: `<<PROPOSE>>` で作られた提案は assistant メッセージの下に承認カードとして出る。「承認して本文を生成」→ 契約とシーンが approved になり `generate_scene` ジョブが投下される。「却下する」→ rejected にして対話で修正を続けられる。
- **generate_scene**: Writing Contract の `status === "approved"` をゲート検証 → 作品+正典メモ+直前シーン抜粋を入力に provider へ stream 生成 → 段落分割で Tiptap doc JSON に変換 → `scene_revisions` に `rev_no=最大+1` で保存 → `scenes.status=generated`。
- **本文タブ**: 話→シーンの一覧、リビジョン切替 (第N稿)、「書き直しを依頼」(指示付きで generate_scene 再投下=新リビジョン)、「手編集」(textarea → manual_edit リビジョン)。
- **設定タブ**: 創作憲章/作風ポリシーの表示、作品の provider/model/キー選択 (自分のキーのみ)。作品作成時点ではユーザーの最新キーが初期値。

## ローカル一気通貫 (ブラウザ + stub runner、実 OpenAI キー不要)

1. 依存インストールと鍵生成

   ```bash
   pnpm install && pnpm -r build
   openssl rand -base64 32   # → APP_SECRET_KEY の値
   ```

2. `apps/web/.dev.vars` を作る

   ```
   APP_SECRET_KEY=<さっき生成した base64>
   EXECUTOR_TOKEN=dev-token
   DEV_LOGIN_ENABLED=true
   DEFAULT_MODEL=stub-model
   ```

3. D1 ローカルにマイグレーション適用 + dev 起動

   ```bash
   cd apps/web
   pnpm exec wrangler d1 migrations apply houchi-sakka --local
   pnpm dev   # http://localhost:8787 (vite dev)
   ```

4. 別ターミナルで runner を stub モードで起動

   ```bash
   cd apps/runner
   WEB_BASE_URL=http://localhost:8787 EXECUTOR_TOKEN=dev-token RUNNER_PROVIDER=stub \
     pnpm start

   # Phase 1b シナリオ (対話→提案→承認→本文生成) を stub で回す場合:
   #   STUB_SCENARIO=phase1b を足す
   WEB_BASE_URL=http://localhost:8787 EXECUTOR_TOKEN=dev-token RUNNER_PROVIDER=stub \
     STUB_SCENARIO=phase1b pnpm start
   ```

5. ブラウザで http://localhost:8787 を開く

   「開発用ログイン」→ APIキー設定でキー登録 (provider: OpenAI、値は `sk-dummy` 等でよい — stub runner は使わない) → 「新しい作品を作る」→ 対話画面で送信 → 数秒で stub の返答が流れる。

   ※ runner に `RUNNER_PROVIDER=stub` を指定すると、登録キーの provider が `openai` でも stub が呼ばれる (キー自体は resolve 経路で owner 一致を検証されて渡る)。

   **STUB_SCENARIO=phase1b での確認手順**: 対話1往復目 → WORK_PATCH+CANON_FACTS で前提と正典を確定。2往復目に「書いて」等の発言 → PROPOSE 提案カードが出る。「承認して本文を生成」→ stub の段落本文がストリームされ、「本文」タブで読める。「書き直しを依頼」で第2稿、「手編集」で manual_edit リビジョンを試せる。

## チェックポイント / 再開の仕組み

`smoke_generate` / `orchestrator_turn` とも provider の結果を `payload.checkpoint` に保存してから `complete` する2段階方式 (結果永続化 → 完了マーク)。orchestrator_turn はさらに `assistant_message_id` をチェックポイントに持ち、`chat_messages.job_id` のユニーク制約でメッセージの二重確定を防ぐ。

実行体が途中で死んだ場合、リース期限切れ後に別実行体が再リースする。`provider_result` があれば provider を再呼出しせず保存済み結果で続きから完了する。テストでは `StubProvider.calls === 1` で二重呼出しがないことを検証している。

## 仕様からの判断事項

- **チェックポイントの置き場所**: spec は「payload 内 `checkpoint` フィールドか別テーブル」と許容。payload 内 `checkpoint` を選んだ (heartbeat とのマージが原子的でテーブルが増えないため)。
- **DB アクセス層**: `drizzle-orm` の `db.get/all/run(sql``)` に合わせた `DbLike` インターフェースで、D1 (非同期) と better-sqlite3 (同期) を同一コードで扱う。
- **リースの原子性**: `UPDATE ... WHERE id = (SELECT ... ) RETURNING` の単発クエリにして、複数実行体での二重リースを SQL レベルで防ぐ。`work_ref` 直列化もこのクエリ内の `NOT IN` サブクエリで実現。
- **進捗 seq**: `progress_events` に `(job_id, seq)` のユニーク制約を付け、seq は `MAX(seq)+1` でサーバー側採番。
- **トークン進捗**: ストリーム中の token イベントは 500ms ごとにまとめて POST する (API スパム防止)。complete 前に残りを必ずフラッシュ。
- **エラー分類**: `JobInfraError` (API 通信・DB 失敗など配管系) はジョブを leased のまま残して次回リースに任せる。それ以外 (payload 不正・provider エラー・不明 kind) は `fail` で失敗終了。
- **キー解決**: Phase 0 の `GET /api/internal/keys/:ref` は廃止し `POST .../resolve {job_id}` に置き換えた — キー所有者とジョブ起票者の一致を強制するため。
- **dev-login の実装**: better-auth の `emailAndPassword` (DEV_LOGIN_ENABLED 時のみ有効) に固定ユーザーを内部転送する方式。OAuth プロバイダー未設定でもローカル開発とテストが全部回る。
- **UI**: 規模が小さいので Tailwind/shadcn は入れず素の CSS + 最小コンポーネント。スマホ幅でも縦積みで破綻しないレイアウト。
- **usage**: OpenAI から usage が取れない場合は推測せず `"unknown"` を返す (spec 準拠)。
