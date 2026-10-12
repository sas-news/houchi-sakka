import {
  ChangeSetOpSchema,
  JOB_KIND_REVIEW_CHANGE,
  ReviewChangePayloadSchema,
  WritingContractPayloadSchema,
  type ChangeSetOp,
  type ReviewChangeResult,
  type WritingContractPayload,
} from "@houchi/contracts";
import {
  criticSkill,
  fixerSkill,
  type CriticOutput,
  type FixerFindingInput,
} from "@houchi/skills";
import { toCriticOutput, validateProse } from "@houchi/validators";
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
 * 影響対象シーンの本文 vs 適用後の現行正典を決定的検査 + critic スキルで
 * 検査し、衝突を review_findings に記録する (L0 レビュー。執筆は止めない)。
 *
 * 段構成 (各段の出力は checkpoint に永続化、resume で再実行しない):
 *   1. fetch  — 変更セット+影響シーン+現行正典を取得
 *   2. review — 各シーンを critic で検査 (checkpoint: reviews)
 *   3. record — violations/notes を review_findings として記録
 *   4. fix    — findings から修正候補 ops を生成 (checkpoint: fix_ops)
 *   5. report — スレッドに結果メッセージを投稿
 *   6. propose — 修正候補の変更セット (kind=revision) を起票 (checkpoint: fix_change_set_id)
 *
 * 修正提案の起票は findings>0 のときだけ。kind=revision の変更セットへの
 * レビューでは再提案しない → 自動提案は1段で止まる (提案の提案を生まない)。
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
  // commitment/disclosure つきのまま渡す ([仮置き]/[秘密] ラベル化は skill 側)
  const targetScenes = csCtx.scenes
    .filter((s) => s.prose_md.length > 0)
    .slice(0, MAX_REVIEW_SCENES);

  // --- 2. review: 影響シーンを critic で検査 ------------------------------
  const reviews = (checkpoint.reviews ?? {}) as Record<string, CriticOutput>;
  for (const scene of targetScenes) {
    if (reviews[scene.id]) continue;
    // 決定的検査 (LLM 不要) を critic の前に走らせ、findings をマージする
    // (spec §10「決定的に検査できるものはコードで検査する」)。
    const deterministic = toCriticOutput(
      validateProse(scene.prose_md, {
        contract: scene.contract ?? EMPTY_CONTRACT,
        canonFacts: csCtx.canon_facts,
      }),
    );
    const out = await runSkillStep(ctx, {
      job,
      skill: criticSkill,
      input: {
        contract: scene.contract ?? EMPTY_CONTRACT,
        scene_title: scene.title,
        prose_md: scene.prose_md,
        canon_facts: csCtx.canon_facts,
      },
      model: payload.model,
      providerName: payload.provider,
      keyRef: payload.key_ref,
      step: "review_scene",
    });
    reviews[scene.id] = {
      violations: [...deterministic.violations, ...out.violations],
      notes: [...deterministic.notes, ...out.notes],
    };
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

  // --- 4. fix: findings から修正候補 ops を生成 ----------------------------
  // 連鎖防止: 修正提案 (kind=revision) へのレビューでは再提案しない。
  // createChangeSet が未配線の環境 (eval 等) では提案自体をスキップする。
  const canPropose =
    findings.length > 0 && cs.kind !== "revision" && !!ctx.createChangeSet;
  const fixOps: ChangeSetOp[] = [];
  let fixDescription = checkpoint.fix_description ?? "";
  if (canPropose && !checkpoint.fix_change_set_id) {
    if (!checkpoint.fix_ops) {
      await ctx.postProgress("status", { step: "propose_fix" });
      const fixerFindings: FixerFindingInput[] = findings.map((f, i) => {
        const scene = f.scene_id
          ? (csCtx.scenes.find((s) => s.id === f.scene_id) ?? null)
          : null;
        return {
          index: i,
          kind: f.kind,
          severity: f.severity,
          summary: f.summary,
          detail: f.detail ?? "",
          scene: scene
            ? {
                id: scene.id,
                title: scene.title,
                prose_md: scene.prose_md,
                contract: scene.contract,
              }
            : null,
          fact: f.fact_id
            ? (csCtx.canon_facts.find((c) => c.id === f.fact_id) ?? null)
            : null,
        };
      });
      const plan = await runSkillStep(ctx, {
        job,
        skill: fixerSkill,
        input: {
          work: { title: csCtx.work.title, premise: csCtx.work.premise },
          change_set: { title: cs.title, description: cs.description },
          canon_facts: csCtx.canon_facts.map((f) => ({
            id: f.id,
            statement: f.statement,
            commitment: f.commitment,
            disclosure: f.disclosure,
          })),
          findings: fixerFindings,
        },
        model: payload.model,
        providerName: payload.provider,
        keyRef: payload.key_ref,
        step: "propose_fix",
      });
      const rewritten = new Set<string>();
      for (const fix of plan.fixes) {
        const finding = findings[fix.finding_index];
        const text = fix.text.trim();
        if (!finding || !text || fix.action === "none") continue;
        if (fix.action === "rewrite_scene") {
          // 同一シーンへの rewrite は先勝ち (後続 finding の全文を掛け合わせない)。
          if (!finding.scene_id || rewritten.has(finding.scene_id)) continue;
          rewritten.add(finding.scene_id);
          fixOps.push({
            op: "rewrite_scene",
            scene_id: finding.scene_id,
            text,
          });
        } else if (fix.action === "revise_fact") {
          const fact = csCtx.canon_facts.find((c) => c.id === fix.fact_id);
          if (!fact) continue;
          fixOps.push({
            op: "revise_fact",
            fact_id: fact.id,
            new_statement: text,
          });
        } else if (fix.action === "add_fact") {
          fixOps.push({ op: "add_fact", statement: text });
        }
      }
      const reasons = plan.fixes
        .filter((f) => f.action !== "none" && f.reason)
        .map((f) => `- finding #${f.finding_index}: ${f.reason}`)
        .join("\n");
      fixDescription =
        `変更セット「${cs.title}」のレビュー findings から自動生成した修正候補。` +
        (reasons ? `\n${reasons}` : "");
      await ctx.saveCheckpoint({ fix_ops: fixOps, fix_description: fixDescription });
    } else {
      // resume: 保存済み ops を復元 (スキルは再実行しない)
      for (const raw of checkpoint.fix_ops) {
        const parsed = ChangeSetOpSchema.safeParse(raw);
        if (parsed.success) fixOps.push(parsed.data);
      }
    }
  }

  // --- 5. report: スレッドに結果を投稿 -------------------------------------
  let messageId = checkpoint.message_id;
  if (!messageId) {
    const body =
      targetScenes.length === 0
        ? `変更セット「${cs.title}」のレビュー: 影響するシーンはありませんでした。`
        : `変更セット「${cs.title}」のレビュー: ${targetScenes.length}件のシーンを検査し、衝突 ${conflictCount}件・補足 ${infoCount}件を記録しました。「変更」タブで確認できます。` +
          (fixOps.length > 0
            ? "修正候補の変更セットを提案しました — 承認で適用します。"
            : canPropose && !checkpoint.fix_change_set_id
              ? "自動修正候補は見つかりませんでした。対話で修正を指示してください。"
              : "");
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

  // --- 6. propose: 修正候補の変更セット (kind=revision) を起票 -------------
  let fixChangeSetId = checkpoint.fix_change_set_id ?? null;
  if (!fixChangeSetId && fixOps.length > 0 && ctx.createChangeSet) {
    await ctx.postProgress("status", { step: "propose_fix" });
    const fixCs = await ctx.createChangeSet({
      work_id: payload.work_id,
      title: `修正候補: ${cs.title}`,
      description:
        fixDescription ||
        `変更セット「${cs.title}」のレビュー findings から自動生成した修正候補。`,
      ops: fixOps,
      message_id: messageId,
      kind: "revision",
    });
    fixChangeSetId = fixCs.id;
    await ctx.saveCheckpoint({ fix_change_set_id: fixChangeSetId });
  }

  await ctx.postProgress("status", { step: "complete" });
  const result: ReviewChangeResult = {
    kind: JOB_KIND_REVIEW_CHANGE,
    change_set_id: cs.id,
    scenes_reviewed: Object.keys(reviews).length,
    findings_count: findings.length,
    fix_change_set_id: fixChangeSetId,
  };
  await ctx.complete(result);
};
