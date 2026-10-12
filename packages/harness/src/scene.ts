import {
  GenerateScenePayloadSchema,
  JOB_KIND_GENERATE_SCENE,
  textToTiptapDoc,
  type CanonFact,
  type DependencyEdgeInput,
  type EntityWithAliases,
  type GenerateSceneResult,
  type KnowledgeEvent,
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
import { detectEntityMentions } from "@houchi/mentions";
import {
  normalizeText,
  toCriticOutput,
  validateProse,
} from "@houchi/validators";
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
  /** 現行の登場要素+別名 (POV 解決・言及検出に使う, spec §6.4)。 */
  entities?: EntityWithAliases[];
  /** 現行の知識イベント (誰が何を知っているか)。 */
  knowledge_events?: KnowledgeEvent[];
}

/**
 * contract.pov (自由文) から視点人物のエンティティを引く。
 * 名前・別名の正規化一致 → pov 文字列に含まれる最長の表記、の順で拾う。
 */
export function resolvePovEntity(
  pov: string,
  entities: readonly EntityWithAliases[],
): EntityWithAliases | undefined {
  const np = normalizeText(pov);
  if (np.length === 0) return undefined;
  const surfaces = (e: EntityWithAliases) => [e.name, ...e.aliases];
  for (const e of entities) {
    if (surfaces(e).some((s) => normalizeText(s) === np)) return e;
  }
  let best: { e: EntityWithAliases; len: number } | undefined;
  for (const e of entities) {
    for (const s of surfaces(e)) {
      const ns = normalizeText(s);
      if (ns.length >= 2 && np.includes(ns) && (best === undefined || ns.length > best.len)) {
        best = { e, len: ns.length };
      }
    }
  }
  return best?.e;
}

/**
 * 視点人物が正当に知っている事実の集合 (spec §6.4 MVP)。
 * KnowledgeEvent (entity=POV人物, 現行) の fact_ref 群 + 契約の知識宣言に
 * 一致する正典文 (statement の部分一致) の fact_ref を返す。
 */
function knownFactsForPov(
  povEntity: EntityWithAliases | undefined,
  knowledgeEvents: readonly KnowledgeEvent[],
  canonFacts: readonly CanonFact[],
  knowledgeNotes: string,
): { factRefs: Set<string>; statements: string[] } {
  const factRefs = new Set<string>();
  const statements: string[] = [];
  const refOf = (f: CanonFact) => f.fact_ref ?? f.id;
  const factByRef = new Map(canonFacts.map((f) => [refOf(f), f]));
  if (povEntity) {
    for (const ev of knowledgeEvents) {
      if (ev.entity_id !== povEntity.entity_id) continue;
      if (ev.valid_to_rev !== null) continue;
      factRefs.add(ev.fact_id);
      const f = factByRef.get(ev.fact_id);
      if (f) statements.push(f.statement);
    }
  }
  // 契約の knowledge_notes で宣言された知識: 宣言文が正典文に含まれる
  // (またはその逆) ものを「知っている」とみなす (MVP の緩い一致)。
  const notes = knowledgeNotes.trim();
  if (notes.length > 0) {
    const nn = normalizeText(notes);
    for (const f of canonFacts) {
      const ns = normalizeText(f.statement);
      if (ns.length >= 4 && (nn.includes(ns) || ns.includes(nn))) {
        factRefs.add(refOf(f));
      }
    }
    statements.push(`(契約の知識宣言) ${notes}`);
  }
  return { factRefs, statements };
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
 *   2. critique — 決定的検査 (validators) + critic スキルで契約適合・
 *                 禁止事項・正典矛盾を検査 (checkpoint: critique)
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

  // 正典メモは commitment/disclosure つきのまま渡す (skills が [仮置き]
  // [秘密] 等のラベルを付けてプロンプトに出す, spec §4.3)
  const canonFacts = sceneCtx.canon_facts;
  const prevSummary =
    sceneCtx.prev_scenes.length > 0
      ? sceneCtx.prev_scenes
          .map((s) => `- ${s.title}: ${s.excerpt}`)
          .join("\n")
      : undefined;

  // POV 知識 (spec §6.4 MVP): 視点人物の KnowledgeEvent + 契約の知識宣言を
  // writer/critic のプロンプトと決定的検査の両方に渡す。
  const entities = sceneCtx.entities ?? [];
  const povEntity = resolvePovEntity(contract.payload.pov, entities);
  const povKnowledge = knownFactsForPov(
    povEntity,
    sceneCtx.knowledge_events ?? [],
    canonFacts,
    contract.payload.knowledge_notes,
  );
  const povKnowledgeOpt =
    povKnowledge.statements.length > 0
      ? { pov_knowledge: povKnowledge.statements }
      : {};
  const entitiesForMentions = entities.map((e) => ({
    id: e.entity_id,
    name: e.name,
    aliases: e.aliases,
  }));

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
        canon_facts: canonFacts,
        ...(prevSummary !== undefined
          ? { prev_scene_summary: prevSummary }
          : {}),
        ...(payload.instruction !== undefined
          ? { instruction: payload.instruction }
          : {}),
        ...povKnowledgeOpt,
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

  // --- 2. critique: 決定的検査 + critic スキル ---------------------------
  // validators は LLM を通さない確定検査 (spec §10)。その findings を critic
  // の出力にマージし、severity=high があれば revise 判定にそのまま使う。
  let critique = checkpoint.critique as CriticOutput | undefined;
  if (!critique) {
    const deterministic = toCriticOutput(
      validateProse(draft.prose_md, {
        contract: contract.payload,
        canonFacts: sceneCtx.canon_facts,
        knownFactIds: povKnowledge.factRefs,
      }),
    );
    const aiCritique = await runSkillStep(ctx, {
      job,
      skill: criticSkill,
      input: {
        contract: contract.payload,
        scene_title: sceneCtx.scene.title,
        prose_md: draft.prose_md,
        canon_facts: canonFacts,
        ...povKnowledgeOpt,
      },
      model: payload.model,
      providerName: payload.provider,
      keyRef: payload.key_ref,
      step: "critique",
    });
    critique = {
      violations: [...deterministic.violations, ...aiCritique.violations],
      notes: [...deterministic.notes, ...aiCritique.notes],
    };
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
        canon_facts: canonFacts,
        ...(prevSummary !== undefined
          ? { prev_scene_summary: prevSummary }
          : {}),
        critique,
        ...(payload.instruction !== undefined
          ? { instruction: payload.instruction }
          : {}),
        ...povKnowledgeOpt,
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
  // + 本文中のエンティティ言及を副経路エッジ (kind="mention") として記録
  // (spec §6.6: 宣言分と併存し、影響分析の言及経路に使う)。
  if (checkpoint.deps_recorded !== true) {
    const mentionEdges: DependencyEdgeInput[] = detectEntityMentions(
      output.prose_md,
      entitiesForMentions,
    ).map((entityId) => ({
      target_kind: "mention",
      target_ref: entityId,
    }));
    const edges = [
      ...(output.depends_on as DependencyEdgeInput[]),
      ...mentionEdges,
    ];
    if (edges.length > 0) {
      if (!ctx.recordDependencies) {
        throw new Error("generate_scene dependency persistence is not wired");
      }
      await ctx.postProgress("status", { step: "record_dependencies" });
      await ctx.recordDependencies({
        scene_id: payload.scene_id,
        work_id: sceneCtx.work.id,
        edges,
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
