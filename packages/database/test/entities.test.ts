import { describe, expect, it } from "vitest";
import {
  addCanonFacts,
  addDependencyEdges,
  applyChangeSet,
  computeChangeSetImpact,
  createChangeSet,
  createEpisode,
  createScene,
  createSceneRevision,
  createWork,
  getCurrentEntityByEntityId,
  getWorkById,
  listAliasesByEntityIds,
  listCanonFactsByWork,
  listDependencyEdgesByScene,
  listEntitiesWithAliasesByWork,
  listFactRefsByEntityIds,
  listKnowledgeEventsByWork,
  verifyChangeSetForApply,
  type DbLike,
} from "../src/index.js";
import { createTestDb } from "../src/testing.js";

/** work+episode+scene をまとめて作る土台。 */
async function scaffold(db: DbLike) {
  const { work } = await createWork(db, {
    ownerRef: "u1",
    title: "テスト作品",
  });
  const episode = await createEpisode(db, { workId: work.id, title: "第1話" });
  const scene = await createScene(db, {
    episodeId: episode.id,
    title: "廃線ホーム",
    purpose: "導入",
    status: "approved",
  });
  return { work, episode, scene };
}

/** ops だけから変更セットを作って適用する (verify は別途テスト)。 */
async function proposeAndApply(
  db: DbLike,
  workId: string,
  ops: Parameters<typeof createChangeSet>[1]["ops"],
) {
  const impact = await computeChangeSetImpact(db, { workId, ops });
  const cs = await createChangeSet(db, {
    workId,
    title: "テスト変更",
    ops,
    impact,
  });
  const applied = await applyChangeSet(db, { changeSetId: cs.id });
  return { cs, applied };
}

describe("entities: CRUD ops", () => {
  it("add_entity で登場要素+別名が作られる", async () => {
    const db = createTestDb();
    const { work } = await scaffold(db);
    await proposeAndApply(db, work.id, [
      {
        op: "add_entity",
        kind: "character",
        name: "アキラ",
        summary: "主人公",
        aliases: ["暁", "アキ"],
      },
      {
        op: "add_entity",
        kind: "place",
        name: "白鷺高校",
        summary: "",
        aliases: [],
      },
    ]);
    const entities = await listEntitiesWithAliasesByWork(db, work.id);
    expect(entities).toHaveLength(2);
    const akira = entities.find((e) => e.name === "アキラ")!;
    expect(akira.kind).toBe("character");
    expect(akira.summary).toBe("主人公");
    expect(akira.aliases.sort()).toEqual(["アキ", "暁"]);
    expect(akira.valid_to_rev).toBeNull();
    // canon_rev が進んでいる (entity ops は正典タッチ)
    expect((await getWorkById(db, work.id))!.canon_rev).toBe(1);
  });

  it("add_entity の同名同種は冪等 (重複作成しない)", async () => {
    const db = createTestDb();
    const { work } = await scaffold(db);
    await proposeAndApply(db, work.id, [
      { op: "add_entity", kind: "character", name: "アキラ", summary: "", aliases: [] },
      { op: "add_entity", kind: "character", name: "アキラ", summary: "", aliases: [] },
    ]);
    expect(await listEntitiesWithAliasesByWork(db, work.id)).toHaveLength(1);
  });

  it("update_entity は時系列リビジョンで差し替える (entity_id 維持)", async () => {
    const db = createTestDb();
    const { work } = await scaffold(db);
    await proposeAndApply(db, work.id, [
      {
        op: "add_entity",
        kind: "character",
        name: "アキラ",
        summary: "v1",
        aliases: ["暁"],
      },
    ]);
    const before = (await listEntitiesWithAliasesByWork(db, work.id))[0]!;
    await proposeAndApply(db, work.id, [
      {
        op: "update_entity",
        entity_id: before.entity_id,
        summary: "v2",
        add_aliases: ["アキ"],
        remove_aliases: ["暁"],
      },
    ]);
    const after = (await listEntitiesWithAliasesByWork(db, work.id))[0]!;
    // 同じ entity_id で新しい行 (時系列モデル)
    expect(after.entity_id).toBe(before.entity_id);
    expect(after.id).not.toBe(before.id);
    expect(after.summary).toBe("v2");
    expect(after.name).toBe("アキラ");
    expect(after.aliases).toEqual(["アキ"]);
    expect(after.valid_from_rev).toBe((before.valid_from_rev ?? 0) + 1);
    // 旧行は閉じられている
    const old = await getCurrentEntityByEntityId(db, before.entity_id);
    expect(old!.id).toBe(after.id);
  });

  it("retire_entity で valid_to_rev が付き一覧から消える", async () => {
    const db = createTestDb();
    const { work } = await scaffold(db);
    await proposeAndApply(db, work.id, [
      { op: "add_entity", kind: "character", name: "アキラ", summary: "", aliases: [] },
    ]);
    const e = (await listEntitiesWithAliasesByWork(db, work.id))[0]!;
    await proposeAndApply(db, work.id, [
      { op: "retire_entity", entity_id: e.entity_id },
    ]);
    expect(await listEntitiesWithAliasesByWork(db, work.id)).toHaveLength(0);
  });
});

describe("fact_entities: 正典と登場要素のリンク", () => {
  it("add_fact の entity_refs で fact_entities に記録される", async () => {
    const db = createTestDb();
    const { work } = await scaffold(db);
    await proposeAndApply(db, work.id, [
      { op: "add_entity", kind: "character", name: "アキラ", summary: "", aliases: [] },
    ]);
    const akira = (await listEntitiesWithAliasesByWork(db, work.id))[0]!;
    await proposeAndApply(db, work.id, [
      {
        op: "add_fact",
        statement: "アキラは転校生である",
        entity_refs: [akira.entity_id],
      },
    ]);
    const links = await listFactRefsByEntityIds(db, [akira.entity_id]);
    expect(links.get(akira.entity_id)).toHaveLength(1);
  });

  it("revise_fact で fact_ref が引き継がれ entity_refs も更新される", async () => {
    const db = createTestDb();
    const { work } = await scaffold(db);
    await proposeAndApply(db, work.id, [
      { op: "add_entity", kind: "character", name: "アキラ", summary: "", aliases: [] },
      { op: "add_entity", kind: "character", name: "美咲", summary: "", aliases: [] },
    ]);
    const [akira, misaki] = await listEntitiesWithAliasesByWork(db, work.id);
    await proposeAndApply(db, work.id, [
      {
        op: "add_fact",
        statement: "アキラは転校生である",
        entity_refs: [akira!.entity_id],
      },
    ]);
    const fact = (await listCanonFactsByWork(db, work.id))[0]!;
    const factRef = fact.fact_ref ?? fact.id;
    await proposeAndApply(db, work.id, [
      {
        op: "revise_fact",
        fact_id: fact.id,
        new_statement: "アキラは美咲の兄である",
        entity_refs: [akira!.entity_id, misaki!.entity_id],
      },
    ]);
    const facts = await listCanonFactsByWork(db, work.id);
    expect(facts).toHaveLength(1);
    // 新しい行でも fact_ref は同じ (安定ID)
    expect(facts[0]!.fact_ref).toBe(factRef);
    expect(facts[0]!.id).not.toBe(fact.id);
    const linksA = await listFactRefsByEntityIds(db, [akira!.entity_id]);
    const linksM = await listFactRefsByEntityIds(db, [misaki!.entity_id]);
    expect(linksA.get(akira!.entity_id)).toEqual([factRef]);
    expect(linksM.get(misaki!.entity_id)).toEqual([factRef]);
  });
});

describe("knowledge_events", () => {
  it("add_knowledge_event で記録、retract で閉じる", async () => {
    const db = createTestDb();
    const { work, scene } = await scaffold(db);
    await proposeAndApply(db, work.id, [
      { op: "add_entity", kind: "character", name: "アキラ", summary: "", aliases: [] },
      {
        op: "add_fact",
        statement: "アキラの正体は人造人間である",
        disclosure: "secret",
      },
    ]);
    const akira = (await listEntitiesWithAliasesByWork(db, work.id))[0]!;
    const fact = (await listCanonFactsByWork(db, work.id))[0]!;
    await proposeAndApply(db, work.id, [
      {
        op: "add_knowledge_event",
        entity_id: akira.entity_id,
        fact_id: fact.id,
        scene_id: scene.id,
        source: "目撃",
      },
    ]);
    let events = await listKnowledgeEventsByWork(db, work.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.entity_id).toBe(akira.entity_id);
    // fact_id には安定ID (fact_ref) が入る
    expect(events[0]!.fact_id).toBe(fact.fact_ref);
    expect(events[0]!.scene_id).toBe(scene.id);
    expect(events[0]!.source).toBe("目撃");

    await proposeAndApply(db, work.id, [
      { op: "retract_knowledge_event", event_id: events[0]!.id },
    ]);
    events = await listKnowledgeEventsByWork(db, work.id);
    expect(events).toHaveLength(0);
  });

  it("同じ (entity,fact) の現行イベントは重複作成しない", async () => {
    const db = createTestDb();
    const { work } = await scaffold(db);
    await proposeAndApply(db, work.id, [
      { op: "add_entity", kind: "character", name: "アキラ", summary: "", aliases: [] },
      { op: "add_fact", statement: "秘密の事実" },
    ]);
    const akira = (await listEntitiesWithAliasesByWork(db, work.id))[0]!;
    const fact = (await listCanonFactsByWork(db, work.id))[0]!;
    await proposeAndApply(db, work.id, [
      { op: "add_knowledge_event", entity_id: akira.entity_id, fact_id: fact.id, source: "記述" },
      {
        op: "add_knowledge_event",
        entity_id: akira.entity_id,
        fact_id: fact.fact_ref ?? fact.id, source: "記述" },
    ]);
    expect(await listKnowledgeEventsByWork(db, work.id)).toHaveLength(1);
  });
});

describe("impact: entity 経路", () => {
  it("entity ops は紐付く正典+依存シーン+言及シーンを影響に含める", async () => {
    const db = createTestDb();
    const { work, scene } = await scaffold(db);
    // entity + 紐付く正典
    await proposeAndApply(db, work.id, [
      { op: "add_entity", kind: "character", name: "アキラ", summary: "", aliases: ["暁"] },
      {
        op: "add_fact",
        statement: "アキラは転校生である",
        entity_refs: [], // あとで revise で紐付ける
      },
    ]);
    const akira = (await listEntitiesWithAliasesByWork(db, work.id))[0]!;
    const fact = (await listCanonFactsByWork(db, work.id))[0]!;
    await proposeAndApply(db, work.id, [
      {
        op: "revise_fact",
        fact_id: fact.id,
        new_statement: "アキラは転校生である",
        entity_refs: [akira.entity_id],
      },
    ]);
    // シーンに依存宣言 (宣言経路) + 言及エッジ (副経路)
    await addDependencyEdges(db, {
      workId: work.id,
      sceneId: scene.id,
      edges: [
        { target_kind: "canon_fact", target_ref: fact.fact_ref ?? fact.id },
      ],
    });
    const scene2 = await createScene(db, {
      episodeId: (await createEpisode(db, { workId: work.id, title: "第2話" })).id,
      title: "放課後",
      purpose: "",
      status: "approved",
    });
    await addDependencyEdges(db, {
      workId: work.id,
      sceneId: scene2.id,
      edges: [{ target_kind: "mention", target_ref: akira.entity_id }],
    });
    // update_entity の影響: エンティティ自身+紐付く正典+両シーン
    const impact = await computeChangeSetImpact(db, {
      workId: work.id,
      ops: [{ op: "update_entity", entity_id: akira.entity_id, name: "晶" }],
    });
    expect(impact.entities.map((e) => e.id)).toContain(akira.entity_id);
    expect(impact.facts.map((f) => f.id)).toContain(
      (await listCanonFactsByWork(db, work.id))[0]!.id,
    );
    expect(impact.scenes.map((s) => s.id).sort()).toEqual(
      [scene.id, scene2.id].sort(),
    );
  });

  it("言及エッジが無いシーンは本文のエイリアス走査で拾う (副経路)", async () => {
    const db = createTestDb();
    const { work, scene } = await scaffold(db);
    await createSceneRevision(db, {
      sceneId: scene.id,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "暁は誰もいないホームに立った。" }],
          },
        ],
      },
      source: "ai",
    });
    await proposeAndApply(db, work.id, [
      { op: "add_entity", kind: "character", name: "アキラ", summary: "", aliases: ["暁"] },
    ]);
    const akira = (await listEntitiesWithAliasesByWork(db, work.id))[0]!;
    const impact = await computeChangeSetImpact(db, {
      workId: work.id,
      ops: [{ op: "retire_entity", entity_id: akira.entity_id }],
    });
    expect(impact.scenes.map((s) => s.id)).toContain(scene.id);
  });

  it("add_knowledge_event は対象 fact/entity と同じ経路を影響に入れる", async () => {
    const db = createTestDb();
    const { work } = await scaffold(db);
    await proposeAndApply(db, work.id, [
      { op: "add_entity", kind: "character", name: "アキラ", summary: "", aliases: [] },
      {
        op: "add_fact",
        statement: "アキラの正体は人造人間である",
        entity_refs: [],
      },
    ]);
    const akira = (await listEntitiesWithAliasesByWork(db, work.id))[0]!;
    const fact = (await listCanonFactsByWork(db, work.id))[0]!;
    await proposeAndApply(db, work.id, [
      {
        op: "revise_fact",
        fact_id: fact.id,
        new_statement: "アキラの正体は人造人間である",
        entity_refs: [akira.entity_id],
      },
    ]);
    const impact = await computeChangeSetImpact(db, {
      workId: work.id,
      ops: [
        { op: "add_knowledge_event", entity_id: akira.entity_id, fact_id: fact.id, source: "記述" },
      ],
    });
    expect(impact.entities.map((e) => e.id)).toContain(akira.entity_id);
    expect(impact.facts.length).toBeGreaterThan(0);
  });
});

describe("verify: entity ops の検査", () => {
  it("存在しない entity_id の update_entity は missing_ref 違反", async () => {
    const db = createTestDb();
    const { work } = await scaffold(db);
    const impact = await computeChangeSetImpact(db, {
      workId: work.id,
      ops: [{ op: "update_entity", entity_id: "no-such", name: "x" }],
    });
    const cs = await createChangeSet(db, {
      workId: work.id,
      title: "t",
      ops: [{ op: "update_entity", entity_id: "no-such", name: "x" }],
      impact,
    });
    const check = await verifyChangeSetForApply(db, { changeSetId: cs.id });
    expect(check!.violations.some((v) => v.kind === "missing_ref")).toBe(true);
  });

  it("entity_refs に無い entity を指す add_fact は missing_ref 違反", async () => {
    const db = createTestDb();
    const { work } = await scaffold(db);
    const ops = [
      {
        op: "add_fact" as const,
        statement: "x",
        entity_refs: ["ghost-entity"],
      },
    ];
    const impact = await computeChangeSetImpact(db, { workId: work.id, ops });
    const cs = await createChangeSet(db, {
      workId: work.id,
      title: "t",
      ops,
      impact,
    });
    const check = await verifyChangeSetForApply(db, { changeSetId: cs.id });
    expect(check!.violations.some((v) => v.kind === "missing_ref")).toBe(true);
  });

  it("既に閉じた知識イベントの retract は stale 違反", async () => {
    const db = createTestDb();
    const { work } = await scaffold(db);
    await proposeAndApply(db, work.id, [
      { op: "add_entity", kind: "character", name: "アキラ", summary: "", aliases: [] },
      { op: "add_fact", statement: "秘密" },
    ]);
    const akira = (await listEntitiesWithAliasesByWork(db, work.id))[0]!;
    const fact = (await listCanonFactsByWork(db, work.id))[0]!;
    await proposeAndApply(db, work.id, [
      { op: "add_knowledge_event", entity_id: akira.entity_id, fact_id: fact.id, source: "記述" },
    ]);
    const ev = (await listKnowledgeEventsByWork(db, work.id))[0]!;
    await proposeAndApply(db, work.id, [
      { op: "retract_knowledge_event", event_id: ev.id },
    ]);
    const ops = [{ op: "retract_knowledge_event", event_id: ev.id } as const];
    const impact = await computeChangeSetImpact(db, { workId: work.id, ops });
    const cs = await createChangeSet(db, {
      workId: work.id,
      title: "t",
      ops: [...ops],
      impact,
    });
    const check = await verifyChangeSetForApply(db, { changeSetId: cs.id });
    expect(check!.violations.some((v) => v.kind === "stale_fact")).toBe(true);
  });
});

describe("aliases repo", () => {
  it("listAliasesByEntityIds が entity_id ごとの別名を返す", async () => {
    const db = createTestDb();
    const { work } = await scaffold(db);
    await proposeAndApply(db, work.id, [
      { op: "add_entity", kind: "character", name: "アキラ", summary: "", aliases: ["暁", "アキ"] },
    ]);
    const e = (await listEntitiesWithAliasesByWork(db, work.id))[0]!;
    const aliases = await listAliasesByEntityIds(db, [e.entity_id]);
    expect(aliases.map((a) => a.alias).sort()).toEqual(["アキ", "暁"]);
  });

  it("言及エッジが dependency_edges に記録できる (kind=mention)", async () => {
    const db = createTestDb();
    const { work, scene } = await scaffold(db);
    const { edges } = await addDependencyEdges(db, {
      workId: work.id,
      sceneId: scene.id,
      edges: [{ target_kind: "mention", target_ref: "ent-1" }],
    });
    expect(edges[0]!.target_kind).toBe("mention");
    expect(
      (await listDependencyEdgesByScene(db, scene.id))[0]!.target_ref,
    ).toBe("ent-1");
  });
});
