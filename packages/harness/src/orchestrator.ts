import {
  JOB_KIND_ORCHESTRATOR_TURN,
  JOB_KIND_PLAN_WORK,
  OrchestratorTurnPayloadSchema,
  PROPOSAL_KIND_WRITING_CONTRACT,
  type OrchestratorTurnResult,
} from "@houchi/contracts";
import {
  buildOrchestratorInput,
  parseOrchestratorMarkers,
} from "@houchi/prompts";
import type { TokenCallback } from "@houchi/providers";
import type { JobHandler } from "./index.js";

/**
 * orchestrator_turn: 対話1往復 = 1ジョブ (spec §7.5)。
 *
 * (a) スレッド履歴+作品情報+正典メモ+保留提案を取得 → (b) BYOキーで provider
 * を呼ぶ → (c) provider_result を checkpoint 永続化
 * → (d) assistant メッセージを永続化し、末尾マーカー
 *   (WORK_PATCH / PROPOSE / CANON_FACTS) を順に適用
 * → (e) assistant_message_id を checkpoint 永続化 → complete。
 *
 * smoke_generate と同じ2段階の思想: (c) まで進めば再リース時に
 * プロバイダー呼び出しをスキップする。(d) は冪等 (message の job_id ユニーク、
 * proposal の message_id+kind ユニーク、canon_facts の statement ユニーク、
 * patch の再適用は無害) なので再実行してよい。
 */
export const runOrchestratorTurn: JobHandler = async (job, ctx) => {
  const payload = OrchestratorTurnPayloadSchema.parse(job.payload);
  const checkpoint = payload.checkpoint ?? {};
  const resumed = checkpoint.provider_result !== undefined;
  let providerResult = checkpoint.provider_result;

  if (providerResult === undefined) {
    if (!ctx.fetchOrchestratorContext) {
      throw new Error("orchestrator context fetch is not wired");
    }
    const provider = ctx.getProvider(payload.provider);
    const apiKey = provider.requiresKey
      ? await ctx.resolveKey(payload.key_ref, job.id)
      : undefined;

    const threadCtx = await ctx.fetchOrchestratorContext(payload.thread_id);
    const input = buildOrchestratorInput({
      work: threadCtx.work,
      messages: threadCtx.messages,
      canonFacts: threadCtx.canon_facts.map((f) => ({
        id: f.id,
        statement: f.statement,
      })),
      pendingProposals: threadCtx.proposals
        .filter((p) => p.status === "pending")
        .map((p) => JSON.stringify(p.payload)),
      workspaceFiles: threadCtx.workspace_files,
    });

    // token 進捗は発行順を保つよう逐次化する (smoke_generate と同じ)。
    let progressChain: Promise<void> = Promise.resolve();
    const onToken: TokenCallback = (text) => {
      progressChain = progressChain.then(() =>
        ctx.postProgress("token", { text }),
      );
    };

    await ctx.postProgress("status", {
      step: "call_provider",
      model: payload.model,
    });
    providerResult = await provider.generate(
      { model: payload.model, input, stream: true },
      apiKey ?? "",
      onToken,
    );
    await progressChain;

    await ctx.postProgress("status", { step: "persist_result" });
    await ctx.saveCheckpoint({ provider_result: providerResult });
  } else {
    await ctx.postProgress("status", { step: "resume_from_checkpoint" });
  }

  const { cleanText, patch, proposal, canonFacts, runPlan, changeSet } =
    parseOrchestratorMarkers(providerResult.output_text);
  let assistantMessageId = checkpoint.assistant_message_id;

  if (!assistantMessageId) {
    if (
      !ctx.persistChatMessage ||
      !ctx.applyWorkPatch ||
      !ctx.createProposal ||
      !ctx.addCanonFacts
    ) {
      throw new Error("orchestrator persistence is not wired");
    }
    await ctx.postProgress("status", { step: "persist_message" });
    const message = await ctx.persistChatMessage({
      thread_id: payload.thread_id,
      role: "assistant",
      content: cleanText,
      job_id: job.id,
    });
    assistantMessageId = message.id;
    if (patch) {
      await ctx.postProgress("status", { step: "apply_work_patch" });
      await ctx.applyWorkPatch(payload.work_id, patch);
    }
    if (canonFacts.length > 0) {
      await ctx.postProgress("status", {
        step: "add_canon_facts",
        count: canonFacts.length,
      });
      await ctx.addCanonFacts({
        work_id: payload.work_id,
        statements: canonFacts,
        provenance: "orchestrator",
      });
    }
    if (proposal) {
      await ctx.postProgress("status", { step: "create_proposal" });
      await ctx.createProposal({
        work_id: payload.work_id,
        thread_id: payload.thread_id,
        message_id: assistantMessageId,
        kind: PROPOSAL_KIND_WRITING_CONTRACT,
        payload: {
          ...(proposal.episodeTitle
            ? { episode_title: proposal.episodeTitle }
            : {}),
          scene_title: proposal.sceneTitle,
          scene_purpose: proposal.scenePurpose,
          contract: proposal.contract,
        },
      });
    }
    // <<CHANGESET>>: 変更セットを提案状態で作成 (影響分析はサーバー側)
    if (changeSet) {
      if (!ctx.createChangeSet) {
        throw new Error("orchestrator changeset persistence is not wired");
      }
      await ctx.postProgress("status", { step: "create_change_set" });
      await ctx.createChangeSet({
        work_id: payload.work_id,
        title: changeSet.title,
        description: changeSet.description,
        ops: changeSet.ops,
        message_id: assistantMessageId,
      });
    }
    // <<RUN_PLAN>>: plan_work ジョブを起票 (キー/プロバイダーはこの往復と同じ)
    if (runPlan) {
      if (!ctx.enqueueJob) {
        throw new Error("orchestrator job enqueue is not wired");
      }
      await ctx.postProgress("status", { step: "enqueue_plan_work" });
      await ctx.enqueueJob({
        kind: JOB_KIND_PLAN_WORK,
        work_ref: payload.work_id,
        user_ref: payload.user_ref,
        idempotency_key: `plan_work:${job.id}`,
        payload: {
          work_id: payload.work_id,
          thread_id: payload.thread_id,
          user_ref: payload.user_ref,
          key_ref: payload.key_ref,
          provider: payload.provider,
          model: payload.model,
          ...(runPlan.guidance !== undefined
            ? { guidance: runPlan.guidance }
            : {}),
        },
      });
    }
    await ctx.saveCheckpoint({
      assistant_message_id: assistantMessageId,
    });
  }

  await ctx.postProgress("status", { step: "complete" });
  const result: OrchestratorTurnResult = {
    kind: JOB_KIND_ORCHESTRATOR_TURN,
    message_id: assistantMessageId,
    reply_preview: cleanText.slice(0, 140),
  };
  await ctx.complete(result);
};
