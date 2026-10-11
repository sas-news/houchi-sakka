# apps/runner 用 Dockerfile — Node.js 常駐実行体。
#
# ビルドコンテキストは「リポジトリルート」(pnpm workspace 全体が必要):
#   docker build -f apps/runner/Dockerfile -t houchi-sakka-runner .
#
# 実行例:
#   docker run --rm -e WEB_BASE_URL=https://<デプロイ先> -e EXECUTOR_TOKEN=<共有トークン> \
#     houchi-sakka-runner
#
# 必須 env: WEB_BASE_URL, EXECUTOR_TOKEN
# 任意 env: POLL_INTERVAL_MS(既定2000), LEASE_TTL_MS(既定120000),
#           EXECUTOR_ID(既定 hostname+pid), RUNNER_PROVIDER, STUB_SCENARIO
#
# RUNNER_PROVIDER=stub を付けると全ジョブをダミー応答で処理する
# スモーク用モードになる。本番利用では未設定 (=openai) にし、
# 実キーは Web 側の BYO キー管理から resolve される (OPENAI_API_KEY 不要)。

FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# モノレポ全体をコピー (workspace 参照を壊さないため)
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# runner の tsc -b は project references 経由で依存パッケージも連鎖ビルドする
# (apps/web の vite ビルドは不要なので対象を runner だけに絞る)
RUN pnpm --filter @houchi/runner build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app

# 常駐ポーリングループ。`docker run ... -- --once` で1回だけ処理も可
CMD ["node", "apps/runner/dist/cli.js"]
