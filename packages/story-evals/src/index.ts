// ---------------------------------------------------------------------------
// @houchi/story-evals — Story Evals / Orchestrator Evals ハーネス (spec §10)。
// scenarios/*.json の固定シナリオを走らせて生成品質・対話品質の回帰を検出する。
// 既定は stub provider (決定的・API不要)。EVAL_LIVE=1 + OPENAI_API_KEY で
// 実モデルを呼ぶこともできる。
// ---------------------------------------------------------------------------

export * from "./scenario.js";
export * from "./ctx.js";
export * from "./report.js";
export * from "./dialogue.js";
export * from "./generation.js";
