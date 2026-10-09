import {
  JOB_KIND_ORCHESTRATOR_TURN,
  OrchestratorTurnPayloadSchema,
  type OrchestratorTurnResult,
} from "@houchi/contracts";
import { buildOrchestratorInput, parseWorkPatch } from "@houchi/prompts";
import type { TokenCallback } from "@houchi/providers";
import type { JobHandler } from "./index.js";

/**
 * orchestrator_turn: 対話1往復 = 1ジョブ (spec §7.5)。
 *
 * (a) スレッド履歴+作品情報を取得 → (b) BYOキーで provider を呼ぶ
 * → (c) provider_result を checkpoint 永続化
 * → (d) assistant メッセージを永続化し WORK_PATCH を適用
 * → (e) assistant_message_id を checkpoint 永続化 → complete。
 *
 * smoke_generate と同じ2段階の思想: (c) まで進めば再リース時に
 * プロバイダー呼び出しをスキップする。(d) は冪等 (job_id ユニーク +
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

  const { replyText, patch } = parseWorkPatch(providerResult.output_text);
  let assistantMessageId = checkpoint.assistant_message_id;

  if (!assistantMessageId) {
    if (!ctx.persistChatMessage || !ctx.applyWorkPatch) {
      throw new Error("orchestrator persistence is not wired");
    }
    await ctx.postProgress("status", { step: "persist_message" });
    const message = await ctx.persistChatMessage({
      thread_id: payload.thread_id,
      role: "assistant",
      content: replyText,
      job_id: job.id,
    });
    assistantMessageId = message.id;
    if (patch) {
      await ctx.postProgress("status", { step: "apply_work_patch" });
      await ctx.applyWorkPatch(payload.work_id, patch);
    }
    await ctx.saveCheckpoint({
      assistant_message_id: assistantMessageId,
    });
  }

  await ctx.postProgress("status", { step: "complete" });
  const result: OrchestratorTurnResult = {
    kind: JOB_KIND_ORCHESTRATOR_TURN,
    message_id: assistantMessageId,
    reply_preview: replyText.slice(0, 140),
  };
  await ctx.complete(result);
};
