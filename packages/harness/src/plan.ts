import {
  JOB_KIND_PLAN_WORK,
  PlanWorkPayloadSchema,
  PlanProposalPayloadSchema,
  PROPOSAL_KIND_PLAN,
  type PlanProposalPayload,
  type PlanWorkResult,
} from "@houchi/contracts";
import { plannerSkill } from "@houchi/skills";
import type { JobHandler } from "./index.js";
import { runSkillStep } from "./skills.js";

/**
 * plan_work: planner スキルで作品の計画 (episodes→scenes 骨格) を作り、
 * kind="plan" の提案としてチャットに承認カードを出す (Phase 2a)。
 *
 * (a) スレッドのコンテキスト (work+canon+plan tree) を取る
 * → (b) planner を実行、出力を checkpoint 永続化
 * → (c) assistant メッセージ + plan 提案を永続化 (ともに冪等)
 * → (d) complete。approve されると episodes/scenes が一括作成される。
 */
export const runPlanWork: JobHandler = async (job, ctx) => {
  const payload = PlanWorkPayloadSchema.parse(job.payload);
  const checkpoint = payload.checkpoint ?? {};

  let plan = checkpoint.plan as PlanProposalPayload | undefined;
  const resumed = plan !== undefined;

  if (!plan) {
    if (!ctx.fetchOrchestratorContext) {
      throw new Error("plan_work context fetch is not wired");
    }
    const threadCtx = await ctx.fetchOrchestratorContext(payload.thread_id);
    plan = await runSkillStep(ctx, {
      job,
      skill: plannerSkill,
      input: {
        work: {
          title: threadCtx.work.title,
          premise: threadCtx.work.premise,
          genre: threadCtx.work.genre,
          charter: threadCtx.work.charter,
          policy: threadCtx.work.policy,
        },
        plan_tree: threadCtx.plan_tree,
        canon_facts: threadCtx.canon_facts.map((f) => f.statement),
        ...(payload.guidance !== undefined
          ? { guidance: payload.guidance }
          : {}),
      },
      model: payload.model,
      providerName: payload.provider,
      keyRef: payload.key_ref,
      step: "plan",
    });
    // 検証済み出力を永続化 (resume で planner を再実行しない)
    plan = PlanProposalPayloadSchema.parse(plan);
    await ctx.saveCheckpoint({ plan });
  } else {
    await ctx.postProgress("status", { step: "resume_from_checkpoint" });
  }

  let assistantMessageId = checkpoint.assistant_message_id;
  let proposalId = checkpoint.proposal_id;

  if (!assistantMessageId || !proposalId) {
    if (!ctx.persistChatMessage || !ctx.createProposal) {
      throw new Error("plan_work persistence is not wired");
    }
    await ctx.postProgress("status", { step: "persist_message" });
    const episodeCount = plan.episodes.length;
    const sceneCount = plan.episodes.reduce(
      (acc, e) => acc + e.scenes.length,
      0,
    );
    const message = await ctx.persistChatMessage({
      thread_id: payload.thread_id,
      role: "assistant",
      content: `計画案を作りました: 話 ${episodeCount}件・シーン ${sceneCount}件。承認すると一括で作成されます。`,
      job_id: job.id,
    });
    assistantMessageId = message.id;

    await ctx.postProgress("status", { step: "create_proposal" });
    const proposal = await ctx.createProposal({
      work_id: payload.work_id,
      thread_id: payload.thread_id,
      message_id: assistantMessageId,
      kind: PROPOSAL_KIND_PLAN,
      payload: { episodes: plan.episodes },
    });
    proposalId = proposal.id;
    await ctx.saveCheckpoint({
      assistant_message_id: assistantMessageId,
      proposal_id: proposalId,
    });
  }

  await ctx.postProgress("status", { step: "complete" });
  const result: PlanWorkResult = {
    kind: JOB_KIND_PLAN_WORK,
    proposal_id: proposalId,
    episode_count: plan.episodes.length,
    scene_count: plan.episodes.reduce((acc, e) => acc + e.scenes.length, 0),
  };
  await ctx.complete(result);
};
