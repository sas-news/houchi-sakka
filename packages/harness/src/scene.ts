import {
  GenerateScenePayloadSchema,
  JOB_KIND_GENERATE_SCENE,
  textToTiptapDoc,
  type CanonFact,
  type DependencyEdgeInput,
  type GenerateSceneResult,
  type Scene,
  type Work,
  type WritingContract,
} from "@houchi/contracts";
import {
  criticSkill,
  writerSkill,
  type CriticOutput,
  type WriterOutput,
} from "@houchi/skills";
import type { JobHandler } from "./index.js";
import { runSkillStep } from "./skills.js";

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

function countSeverities(critique: CriticOutput): {
  high: number;
  medium: number;
  low: number;
  notes: number;
} {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const v of critique.violations) {
    if (v.severity === "high") high += 1;
    else if (v.severity === "medium") medium += 1;
    else low += 1;
  }
  return { high, medium, low, notes: critique.notes.length };
}

/**
 * generate_scene: Writing Contract 承認済みシーンの多段生成パイプライン
 * (Phase 2a, spec §4.4 ゲート + §7.1 planner/writer/critic)。
 *
 * 段構成 (各段の出力は checkpoint に永続化、resume で再実行しない):
 *   1. write    — writer スキルでドラフト生成 (checkpoint: draft)
 *   2. critique — critic スキルで契約適合・禁止事項・正典矛盾を検査
 *                 (checkpoint: critique)
 *   3. revise   — severity=high の violation がある時だけ、writer に
 *                 critique を渡して1回書き直し (checkpoint: final)
 *   4. 確定     — scene_revisions 保存 → canon_facts_new 追加 →
 *                 depends_on を dependency_edges に記録 → complete
 *
 * 再生成は同一シーンへの instruction 付き再投下で行い、rev_no が増える
 * (旧リビジョンは消えない)。
 */
export const runGenerateScene: JobHandler = async (job, ctx) => {
  const payload = GenerateScenePayloadSchema.parse(job.payload);
  const checkpoint = payload.checkpoint ?? {};
  const resumed =
    checkpoint.draft !== undefined || checkpoint.revision_id !== undefined;

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

  const canonStatements = sceneCtx.canon_facts.map((f) => f.statement);
  const prevSummary =
    sceneCtx.prev_scenes.length > 0
      ? sceneCtx.prev_scenes
          .map((s) => `- ${s.title}: ${s.excerpt}`)
          .join("\n")
      : undefined;

  // --- 1. write: writer スキルでドラフト --------------------------------
  let draft = checkpoint.draft as WriterOutput | undefined;
  if (!draft) {
    draft = await runSkillStep(ctx, {
      job,
      skill: writerSkill,
      input: {
        contract: contract.payload,
        scene_title: sceneCtx.scene.title,
        scene_purpose: sceneCtx.scene.purpose,
        canon_facts: canonStatements,
        ...(prevSummary !== undefined
          ? { prev_scene_summary: prevSummary }
          : {}),
        ...(payload.instruction !== undefined
          ? { instruction: payload.instruction }
          : {}),
      },
      model: payload.model,
      providerName: payload.provider,
      keyRef: payload.key_ref,
      step: "write",
    });
    await ctx.saveCheckpoint({ draft });
  } else {
    await ctx.postProgress("status", { step: "resume_from_checkpoint" });
  }

  // --- 2. critique: critic スキルで検査 ---------------------------------
  let critique = checkpoint.critique as CriticOutput | undefined;
  if (!critique) {
    critique = await runSkillStep(ctx, {
      job,
      skill: criticSkill,
      input: {
        contract: contract.payload,
        scene_title: sceneCtx.scene.title,
        prose_md: draft.prose_md,
        canon_facts: canonStatements,
      },
      model: payload.model,
      providerName: payload.provider,
      keyRef: payload.key_ref,
      step: "critique",
    });
    await ctx.saveCheckpoint({ critique });
  }

  const summary = countSeverities(critique);

  // --- 3. revise: high 指摘がある時だけ書き直し (1回) ---------------------
  let final = checkpoint.final as WriterOutput | undefined;
  let revised = false;
  if (summary.high > 0 && !final) {
    final = await runSkillStep(ctx, {
      job,
      skill: writerSkill,
      input: {
        contract: contract.payload,
        scene_title: sceneCtx.scene.title,
        scene_purpose: sceneCtx.scene.purpose,
        canon_facts: canonStatements,
        ...(prevSummary !== undefined
          ? { prev_scene_summary: prevSummary }
          : {}),
        critique,
        ...(payload.instruction !== undefined
          ? { instruction: payload.instruction }
          : {}),
      },
      model: payload.model,
      providerName: payload.provider,
      keyRef: payload.key_ref,
      step: "revise",
    });
    await ctx.saveCheckpoint({ final });
  }
  const output = final ?? draft;
  revised = final !== undefined;

  // --- 4. 確定 ------------------------------------------------------------
  let revisionId = checkpoint.revision_id;
  let revNo = checkpoint.rev_no ?? 0;
  if (!revisionId) {
    await ctx.postProgress("status", { step: "persist_revision" });
    const revision = await ctx.persistSceneRevision({
      scene_id: payload.scene_id,
      content_json: textToTiptapDoc(output.prose_md),
      source: "ai",
      job_id: job.id,
    });
    revisionId = revision.id;
    revNo = revision.rev_no;
    await ctx.saveCheckpoint({ revision_id: revisionId, rev_no: revNo });
  }

  // canon_facts_new の記録 (statement 重複は addCanonFacts 側でスキップ)
  if (checkpoint.canon_recorded !== true) {
    if (output.canon_facts_new.length > 0) {
      if (!ctx.addCanonFacts) {
        throw new Error("generate_scene canon persistence is not wired");
      }
      await ctx.postProgress("status", { step: "add_canon_facts" });
      await ctx.addCanonFacts({
        work_id: sceneCtx.work.id,
        statements: output.canon_facts_new,
        provenance: `generate_scene:${sceneCtx.scene.id}`,
      });
    }
    await ctx.saveCheckpoint({ canon_recorded: true });
  }

  // depends_on の記録 (完全一致重複は repository 側でスキップ)
  if (checkpoint.deps_recorded !== true) {
    if (output.depends_on.length > 0) {
      if (!ctx.recordDependencies) {
        throw new Error("generate_scene dependency persistence is not wired");
      }
      await ctx.postProgress("status", { step: "record_dependencies" });
      await ctx.recordDependencies({
        scene_id: payload.scene_id,
        work_id: sceneCtx.work.id,
        edges: output.depends_on as DependencyEdgeInput[],
      });
    }
    await ctx.saveCheckpoint({ deps_recorded: true });
  }

  await ctx.postProgress("status", { step: "complete" });
  const result: GenerateSceneResult = {
    kind: JOB_KIND_GENERATE_SCENE,
    scene_id: payload.scene_id,
    revision_id: revisionId,
    rev_no: revNo,
    resumed_from_checkpoint: resumed,
    revised,
    critique_summary: summary,
  };
  await ctx.complete(result);
};
