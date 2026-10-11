## Summary

生成品質を「なんとなく」ではなく自動で測れる土台 (spec §10) として、2つの新パッケージを追加。

- **`@houchi/validators`**: LLM を通さない決定的検査。critic の手前で必ず走るルール集
- **`@houchi/story-evals`**: `pnpm evals` で走る評価ハーネス (golden dialogue + 生成品質)

## 設計: 決定的にしたもの / AIに任せたもの

**決定的 (validators 側)** — ルールが一意に決まり、揺れが許されないもの:

| 関数 | 内容 | severity |
|---|---|---|
| `checkForbidden(prose, contract)` | `contract.forbidden` の語句・展開が本文に出ていないか | 完全一致→`high`、全トークン出現→`medium` |
| `checkRequiredEvents(prose, contract)` | `required_events` のキー要素が触れられているか (弱いヒューリスティック) | 未検出→`info` |
| `checkKnowledgeLeak(prose, canon_facts)` | `provenance="secret"` または `[SECRET]` マーク付き正典が本文に漏れていないか | 一致→`high` |

日本語向けに NFKC 正規化 + 助詞等でトークン分割し、語尾変化 (拾う→拾った) は語幹+活用語尾でカバーする。戻り値は `{findings: [{rule, severity, detail}]}`。`severity` に `info` を追加 (指定: 見つからない場合=info)。

**AIに任せたもの** — ニュアンス・文体・矛盾の解釈が必要なものは引き続き critic スキル。

**マージ方法**: `generate_scene` の critique 段と `review_change` で、`validateProse` の結果を `toCriticOutput` で critic 形式に変換して AI 出力と連結。既存の `summary.high > 0 → revise` ロジックは無変更で、そのまま決定的検査の high でも revise が回る。決定的検査の `info` は `[決定的検査]` プレフィックス付きで notes に入れ、AI findings と区別できるようにした。

## evals の見方

`pnpm evals` で `packages/story-evals/scenarios/*.json` を全件実行。既定は stub provider (決定的・APIキー不要)。`EVAL_LIVE=1` + `OPENAI_API_KEY` で実モデルに差し替え可能 (`EVAL_MODEL` でモデル指定)。

- **dialogue シナリオ**: ユーザー発言列を orchestrator_turn に流し、各ターンで「実際に発火した副作用」を期待マーカーと照合。観測は生テキストではなく副作用ベース (提案作成→PROPOSE、plan_work enqueue→RUN_PLAN、applyWorkPatch→WORK_PATCH、canon追加→CANON_FACTS、changeset→CHANGESET)。`forbidden_markers` で禁止挙動、`contains`/`not_contains` でキーワードを検査。契約なしに `generate_scene` が enqueue されたら常に fail。
- **generation シナリオ**: 固定の契約+正典+入力 → writer 生成 → validators+critic で採点。レポートに深刻度別違反数・`required_events` 被覆率・DependencyEdge 被覆率 (`depends_on` 件数/正典件数) を出力。
- レポートは stdout に日本語で + `packages/story-evals/reports/eval-report.json` に保存 (gitignore 済)。fail/error が1件でもあれば終了コード 1。

シナリオは5件: 新規作品初期化対話 / 契約提案フロー / 禁止事項違反 / 秘密漏洩 / クリーン生成。

## 検証結果

- `pnpm -r build` / `pnpm -r typecheck` / `pnpm -r test` 全グリーン (validators 11件 + story-evals 10件の新規テスト含む)
- `pnpm evals`: 5/5 pass。`禁止事項違反の検出` シナリオで `contract.forbidden` が high で発火することを確認 (`[high] validators contract.forbidden: 禁止事項「黒猫の正体が明かされる」…`)。同様に `canon.secret_leak` も high
- harness 統合テスト: 「決定的検査が禁止事項違反を検出 → critic が空でも revise が走る」(scene) と「決定的検査が秘密漏洩を記録する」(review) を追加してグリーン

## 補足

- story-evals が harness 内部のスキル実行ループを使えるよう `runSkillStep`/`extractJson` を `packages/harness/src/index.ts` から再エクスポート (中身の変更なし)
- `pnpm evals` は依存パッケージの `pnpm -r build` 後に `tsx src/cli.ts` を実行
