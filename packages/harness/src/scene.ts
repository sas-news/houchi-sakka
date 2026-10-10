import {
  GenerateScenePayloadSchema,
  JOB_KIND_GENERATE_SCENE,
  textToTiptapDoc,
  type CanonFact,
  type GenerateSceneResult,
  type Scene,
  type Work,
  type WritingContract,
} from "@houchi/contracts";
import { buildSceneWriterInput } from "@houchi/prompts";
import type { TokenCallback } from "@houchi/providers";
import type { JobHandler } from "./index.js";

/** generate_scene がスクリプト側から取るコンテキスト。 */
export interface SceneContextData {
  scene: Scene;
  /** シーンの最新契約 (未作成は null)。 */
  contract: WritingContract | null;
  work: Work;
  canon_facts: CanonFact[];
  /** 直前シーンのタイトル+抜粋 (接続の材料)。 */
  prev_scenes: { id: string; title: string; excerpt: string }[];
}

/**
 * generate_scene: Writing Contract 承認済みのシーン本文を生成する
 * (spec §4.4 ゲート, §6 Scene/SceneRevision)。
 *
 * (a) contract.status === "approved" を検証 (ゲート)
 * → (b) 作品+正典+直前シーンを取り BYOキーで provider を stream 呼び出し
 * → (c) provider_result を checkpoint 永続化
 * → (d) 生成テキストを Tiptap doc JSON に変換し rev_no=最大+1 で保存、
 *   scenes.status=generated へ → (e) revision_id を checkpoint → complete。
 *
 * 再生成は同一シーンへの instruction 付き再投下で行い、rev_no が増える
 * (旧リビジョンは消えない)。
 */
export const runGenerateScene: JobHandler = async (job, ctx) => {
  const payload = GenerateScenePayloadSchema.parse(job.payload);
  const checkpoint = payload.checkpoint ?? {};
  const resumed = checkpoint.provider_result !== undefined;
  let providerResult = checkpoint.provider_result;

  if (providerResult === undefined) {
    if (!ctx.fetchSceneContext || !ctx.persistSceneRevision) {
      throw new Error("generate_scene context fetch is not wired");
    }
    const sceneCtx = await ctx.fetchSceneContext(payload.scene_id);

    // Writing Contract ゲート: 承認済みかつ payload の contract_id と一致する
    // こと。未承認・別契約・契約なしはジョブ起因の失敗とする。
    const contract = sceneCtx.contract;
    if (!contract || contract.status !== "approved") {
      throw new Error("writing contract is not approved");
    }
    if (contract.id !== payload.contract_id) {
      throw new Error("writing contract does not match the approved proposal");
    }

    const provider = ctx.getProvider(payload.provider);
    const apiKey = provider.requiresKey
      ? await ctx.resolveKey(payload.key_ref, job.id)
      : undefined;

    const input = buildSceneWriterInput({
      work: {
        title: sceneCtx.work.title,
        premise: sceneCtx.work.premise,
        genre: sceneCtx.work.genre,
      },
      charter: sceneCtx.work.charter,
      policy: sceneCtx.work.policy,
      canonFacts: sceneCtx.canon_facts.map((f) => f.statement),
      contract: contract.payload,
      sceneTitle: sceneCtx.scene.title,
      scenePurpose: sceneCtx.scene.purpose,
      prevScenes: sceneCtx.prev_scenes,
      ...(payload.instruction ? { instruction: payload.instruction } : {}),
    });

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

  let revisionId = checkpoint.revision_id;
  let revNo = 0;
  if (!revisionId) {
    if (!ctx.persistSceneRevision) {
      throw new Error("generate_scene persistence is not wired");
    }
    await ctx.postProgress("status", { step: "persist_revision" });
    const revision = await ctx.persistSceneRevision({
      scene_id: payload.scene_id,
      content_json: textToTiptapDoc(providerResult.output_text),
      source: "ai",
      job_id: job.id,
    });
    revisionId = revision.id;
    revNo = revision.rev_no;
    await ctx.saveCheckpoint({ revision_id: revisionId, rev_no: revNo });
  }

  await ctx.postProgress("status", { step: "complete" });
  const result: GenerateSceneResult = {
    kind: JOB_KIND_GENERATE_SCENE,
    scene_id: payload.scene_id,
    revision_id: revisionId,
    rev_no: revNo,
    resumed_from_checkpoint: resumed,
  };
  await ctx.complete(result);
};
