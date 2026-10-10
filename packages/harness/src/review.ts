import {
  JOB_KIND_REVIEW_CHANGE,
  ReviewChangePayloadSchema,
  WritingContractPayloadSchema,
  type ReviewChangeResult,
  type WritingContractPayload,
} from "@houchi/contracts";
import { criticSkill, type CriticOutput } from "@houchi/skills";
import type { JobHandler } from "./index.js";
import { runSkillStep } from "./skills.js";

/** 契約がないシーンに渡す空の契約 (全フィールド既定値)。 */
const EMPTY_CONTRACT: WritingContractPayload =
  WritingContractPayloadSchema.parse({});

/** 1回のレビューで検査するシーン数の上限。 */
const MAX_REVIEW_SCENES = 10;

/**
 * review_change: 適用済み変更セット1件を処理する自動レビュー (Phase 2b,
 * spec §5.3 の事後検査)。force_override / manual_edit でも同じレビューが走る。
 *
 * 影響対象シーンの本文 vs 適用後の現行正典を critic スキルで検査し、
 * 衝突を review_findings に記録する (L0 レビュー。執筆は止めない)。
 *
 * 段構成 (各段の出力は checkpoint に永続化、resume で再実行しない):
 *   1. fetch  — 変更セット+影響シーン+現行正典を取得
 *   2. review — 各シーンを critic で検査 (checkpoint: reviews)
 *   3. record — violations/notes を review_findings として記録
 *   4. report — スレッドに結果メッセージを投稿して complete
 */
export const runReviewChange: JobHandler = async (job, ctx) => {
  const payload = ReviewChangePayloadSchema.parse(job.payload);
  const checkpoint = payload.checkpoint ?? {};

  if (
    !ctx.fetchChangeSetContext ||
    !ctx.recordReviewFindings ||
    !ctx.persistChatMessage
  ) {
    throw new Error("review_change context is not wired");
  }

  // --- 1. fetch ----------------------------------------------------------
  await ctx.postProgress("status", { step: "fetch_context" });
  const csCtx = await ctx.fetchChangeSetContext(payload.change_set_id);
  const cs = csCtx.change_set;
  const canonStatements = csCtx.canon_facts.map((f) => f.statement);
  const targetScenes = csCtx.scenes
    .filter((s) => s.prose_md.length > 0)
    .slice(0, MAX_REVIEW_SCENES);

  // --- 2. review: 影響シーンを critic で検査 ------------------------------
  const reviews = (checkpoint.reviews ?? {}) as Record<string, CriticOutput>;
  for (const scene of targetScenes) {
    if (reviews[scene.id]) continue;
    const out = await runSkillStep(ctx, {
      job,
      skill: criticSkill,
      input: {
        contract: scene.contract ?? EMPTY_CONTRACT,
        scene_title: scene.title,
        prose_md: scene.prose_md,
        canon_facts: canonStatements,
      },
      model: payload.model,
      providerName: payload.provider,
      keyRef: payload.key_ref,
      step: "review_scene",
    });
    reviews[scene.id] = out;
    await ctx.saveCheckpoint({ reviews });
  }

  // --- 3. record: findings を記録 -----------------------------------------
  const sceneTitleById = new Map(csCtx.scenes.map((s) => [s.id, s.title]));
  const findings: {
    kind: string;
    severity: string;
    summary: string;
    detail?: string;
    scene_id?: string | null;
    fact_id?: string | null;
  }[] = [];
  for (const [sceneId, out] of Object.entries(reviews)) {
    const title = sceneTitleById.get(sceneId) ?? "(シーン)";
    for (const v of out.violations) {
      findings.push({
        kind: "conflict",
        severity: v.severity,
        summary: `${title}: ${v.rule}`,
        detail: v.detail,
        scene_id: sceneId,
      });
    }
    for (const note of out.notes) {
      findings.push({
        kind: "info",
        severity: "low",
        summary: `${title}: 補足`,
        detail: note,
        scene_id: sceneId,
      });
    }
  }
  const conflictCount = findings.filter((f) => f.kind === "conflict").length;
  const infoCount = findings.length - conflictCount;

  if (checkpoint.findings_recorded !== true) {
    await ctx.postProgress("status", {
      step: "record_findings",
      count: findings.length,
    });
    await ctx.recordReviewFindings({
      change_set_id: cs.id,
      findings,
    });
    await ctx.saveCheckpoint({ findings_recorded: true });
  }

  // --- 4. report: スレッドに結果を投稿 -------------------------------------
  let messageId = checkpoint.message_id;
  if (!messageId) {
    const body =
      targetScenes.length === 0
        ? `変更セット「${cs.title}」のレビュー: 影響するシーンはありませんでした。`
        : `変更セット「${cs.title}」のレビュー: ${targetScenes.length}件のシーンを検査し、衝突 ${conflictCount}件・補足 ${infoCount}件を記録しました。「変更」タブで確認できます。`;
    await ctx.postProgress("status", { step: "report" });
    const message = await ctx.persistChatMessage({
      thread_id: csCtx.thread_id,
      role: "assistant",
      content: body,
      job_id: job.id,
    });
    messageId = message.id;
    await ctx.saveCheckpoint({ message_id: messageId });
  }

  await ctx.postProgress("status", { step: "complete" });
  const result: ReviewChangeResult = {
    kind: JOB_KIND_REVIEW_CHANGE,
    change_set_id: cs.id,
    scenes_reviewed: Object.keys(reviews).length,
    findings_count: findings.length,
  };
  await ctx.complete(result);
};
