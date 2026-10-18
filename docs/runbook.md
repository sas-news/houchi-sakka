# 運用手順 (runbook)

「放置作家」の停止・再開・保守手順。2026-10 長期休止対応を反映済み。

## 構成の要点

- **Web (常時稼働)**: Cloudflare Workers `houchi-sakka-web.sasnews.workers.dev`。
  リクエスト駆動のみ。cron/queue/R2 は未使用で、放置中に勝手に動くものは無い。
- **Runner (利用者PC)**: systemd user サービス `houchi-sakka-runner`。
  キューのジョブをリース→プロバイダー呼び出し→進捗永続化。runner が
  止まっていてもジョブは queued のまま溜まるだけで消えない。
- **D1**: 作品・キー(暗号化)・履歴の唯一の永続層。バックアップは手動。

## 普段の再開 (runner だけ起こす)

```sh
systemctl --user start houchi-sakka-runner
systemctl --user status houchi-sakka-runner   # 確認
journalctl --user -u houchi-sakka-runner -f   # ログを見る
```

ジョブは溜まったものから順に実行される。ブラウザで
`https://houchi-sakka-web.sasnews.workers.dev` に GitHub ログインすれば使える。

## 休止

```sh
systemctl --user stop houchi-sakka-runner
systemctl --user disable houchi-sakka-runner   # 再ログイン時の自動起動も止める
```

Worker はリクエストがなければ課金されないので、そのまま放置してよい。

## ローカル LLM 等の private base_url を使いたい時

SSRF 対策で、private/loopback 宛の `base_url` は既定で拒否される
(キー登録時 400 / runner 実行時エラー)。Ollama 等を自分だけのために
使うなら、両方にフラグを立てる:

1. `apps/web/wrangler.production.toml` の `[vars]` に
   `ALLOW_PRIVATE_BASE_URL = "true"` を足して `pnpm deploy:prod`
2. `apps/runner` 側の `.env` に `ALLOW_PRIVATE_BASE_URL=1` を足して
   `systemctl --user restart houchi-sakka-runner`

DNS rebinding は残存リスクなので、**他者が登録できる状態では ON に
しないこと**。

## トークン・シークレットのローテ

`EXECUTOR_TOKEN` は god-mode (任意 user_ref でジョブ作成→キー解決可)。
疑わしい時は即ローテ:

```sh
NEW=$(openssl rand -hex 32)
echo "$NEW" | pnpm --dir apps/web exec wrangler secret put EXECUTOR_TOKEN \
  --config wrangler.production.toml
sed -i "s/^EXECUTOR_TOKEN=.*/EXECUTOR_TOKEN=$NEW/" .env   # runner 用 .env
```

- `APP_SECRET_KEY` を失うと `provider_keys` の暗号化キーは全滅する。
  パスワードマネージャに控えておくこと。
- OAuth secrets (GITHUB_*) は Cloudflare 側の secret。GitHub 側の
  OAuth App を消せばログインは全滅する (公開ページのみ残る)。

## バックアップ

```sh
pnpm --dir apps/web exec wrangler d1 export houchi-sakka --remote \
  --output ~/houchi-sakka-d1-backup-$(date +%Y%m%d).sql
chmod 600 ~/houchi-sakka-d1-backup-*.sql
```

休止前に一度取る。戻す時は `wrangler d1 execute --file=`。

## 放置中に溜まるもの (残存リスク)

- `progress_events` / `agent_steps` / `chat_messages` は retention 無し。
  長期運用で D1 が肥大化したら古いイベントを掃除するクエリを足す。
- 開放登録のままなので第三者のアカウント・作品が増え得る。悪用の主経路
  (private base_url SSRF) は塞いだが、quota 消費目的の登録自体は残る。
  閉じたくなったら OAuth secret を消すか allowlist を実装する。
- 依存パッケージは凍結のまま。長期後に復帰する時は `pnpm outdated` と
  セキュリティアドバイザリを見てからデプロイし直す。
