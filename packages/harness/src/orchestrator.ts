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
import { withStep } from "./index.js";

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
 *
 * payload.autonomous=true の往復 (spec §7.2 Draft only) ではプロンプト末尾に
 * 自律指示を足し、result に副作用一覧 (actions) と <<AUTO_STOP>> 要求
 * (auto_stop) を載せる — サーバー側の継続判定が使う。
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
      entities: (threadCtx.entities ?? []).map((e) => ({
        entity_id: e.entity_id,
        kind: e.kind,
        name: e.name,
        aliases: e.aliases,
        summary: e.summary,
      })),
      canonFacts: threadCtx.canon_facts.map((f) => ({
        id: f.id,
        statement: f.statement,
        commitment: f.commitment,
        disclosure: f.disclosure,
      })),
      pendingProposals: threadCtx.proposals
        .filter((p) => p.status === "pending")
        .map((p) => JSON.stringify(p.payload)),
      workspaceFiles: threadCtx.workspace_files,
      autonomous: payload.autonomous === true,
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
    providerResult = await withStep(
      ctx,
      "call_provider",
      () =>
        provider.generate(
          { model: payload.model, input, stream: true },
          apiKey ?? "",
          onToken,
        ),
      (out) => ({
        model: payload.model,
        provider: payload.provider,
        usage: out.usage,
      }),
    );
    await progressChain;

    await ctx.postProgress("status", { step: "persist_result" });
    await ctx.saveCheckpoint({ provider_result: providerResult });
  } else {
    await ctx.postProgress("status", { step: "resume_from_checkpoint" });
  }

  const { cleanText, patch, proposal, canonFacts, runPlan, changeSet, autoStop } =
    parseOrchestratorMarkers(providerResult.output_text);
  let assistantMessageId = checkpoint.assistant_message_id;
  /** この往復で適用した副作用 (自律継続の停止判定に使う, spec §7.4)。 */
  const actions: string[] = [];

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
    const persistMessage = ctx.persistChatMessage;
    const message = await withStep(
      ctx,
      "persist_message",
      () =>
        persistMessage({
          thread_id: payload.thread_id,
          role: "assistant",
          content: cleanText,
          job_id: job.id,
        }),
      (m) => ({ artifact: { kind: "chat_message", id: m.id } }),
    );
    assistantMessageId = message.id;
    if (patch) {
      const applyPatch = ctx.applyWorkPatch;
      await ctx.postProgress("status", { step: "apply_work_patch" });
      await withStep(ctx, "apply_work_patch", () =>
        applyPatch(payload.work_id, patch),
      );
      actions.push("work_patch");
    }
    if (canonFacts.length > 0) {
      const addFacts = ctx.addCanonFacts;
      await ctx.postProgress("status", {
        step: "add_canon_facts",
        count: canonFacts.length,
      });
      await withStep(
        ctx,
        "add_canon_facts",
        () =>
          addFacts({
            work_id: payload.work_id,
            statements: canonFacts,
            provenance: "orchestrator",
          }),
        (r) => ({ artifact: { kind: "canon_facts", added: r.added } }),
      );
      actions.push("canon_facts");
    }
    if (proposal) {
      const createProposal = ctx.createProposal;
      await ctx.postProgress("status", { step: "create_proposal" });
      await withStep(
        ctx,
        "create_proposal",
        () =>
          createProposal({
            work_id: payload.work_id,
            thread_id: payload.thread_id,
            message_id: assistantMessageId!,
            kind: PROPOSAL_KIND_WRITING_CONTRACT,
            payload: {
              ...(proposal.episodeTitle
                ? { episode_title: proposal.episodeTitle }
                : {}),
              scene_title: proposal.sceneTitle,
              scene_purpose: proposal.scenePurpose,
              contract: proposal.contract,
            },
          }),
        (p) => ({ artifact: { kind: "proposal", id: p.id } }),
      );
      actions.push("propose");
    }
    // <<CHANGESET>>: 変更セットを提案状態で作成 (影響分析はサーバー側)
    if (changeSet) {
      if (!ctx.createChangeSet) {
        throw new Error("orchestrator changeset persistence is not wired");
      }
      const createChangeSet = ctx.createChangeSet;
      await ctx.postProgress("status", { step: "create_change_set" });
      await withStep(
        ctx,
        "create_change_set",
        () =>
          createChangeSet({
            work_id: payload.work_id,
            title: changeSet.title,
            description: changeSet.description,
            ops: changeSet.ops,
            message_id: assistantMessageId!,
          }),
        (c) => ({ artifact: { kind: "change_set", id: c.id } }),
      );
      actions.push("changeset");
    }
    // <<RUN_PLAN>>: plan_work ジョブを起票 (キー/プロバイダーはこの往復と同じ)
    if (runPlan) {
      if (!ctx.enqueueJob) {
        throw new Error("orchestrator job enqueue is not wired");
      }
      const enqueueJob = ctx.enqueueJob;
      await ctx.postProgress("status", { step: "enqueue_plan_work" });
      await withStep(
        ctx,
        "enqueue_plan_work",
        () =>
          enqueueJob({
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
          }),
        (j) => ({ artifact: { kind: "job", id: j.id } }),
      );
      actions.push("run_plan");
    }
    await ctx.saveCheckpoint({
      assistant_message_id: assistantMessageId,
      // resume で同じ actions が結果に復元されるよう保持する
      actions,
    });
  } else {
    // resume: checkpoint に保存済みの actions を結果へ引き継ぐ
    const saved = checkpoint.actions;
    if (Array.isArray(saved)) {
      actions.push(...saved.filter((a): a is string => typeof a === "string"));
    }
  }

  await ctx.postProgress("status", { step: "complete" });
  const result: OrchestratorTurnResult = {
    kind: JOB_KIND_ORCHESTRATOR_TURN,
    message_id: assistantMessageId,
    reply_preview: cleanText.slice(0, 140),
    actions,
    auto_stop: autoStop,
  };
  await ctx.complete(result);
};
