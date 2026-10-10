import { describe, expect, it } from "vitest";
import { textToTiptapDoc } from "@houchi/contracts";
import {
  createEpisode,
  createScene,
  createSceneRevision,
  createWork,
  createWritingContract,
  listCanonFactsByWork,
  listProposalsByWork,
} from "@houchi/database";
import {
  buildPlanTree,
  listFiles,
  parseCanonStatements,
  PATH_CANON_FACTS,
  PATH_PLAN_TREE,
  PATH_WORK_JSON,
  readFile,
  writePropose,
} from "../src/index.js";
import { createTestDb } from "@houchi/database/testing";

async function setupWork() {
  const db = createTestDb();
  const { work, thread } = await createWork(db, {
    ownerRef: "u1",
    title: "テスト作品",
    premise: "前提",
  });
  return { db, work, thread };
}

describe("workspace 仮想FS", () => {
  it("listFiles は基本3ファイルを返す", async () => {
    const { db, work } = await setupWork();
    const files = await listFiles(db, work);
    const paths = files.map((f) => f.path);
    expect(paths).toContain(PATH_WORK_JSON);
    expect(paths).toContain(PATH_CANON_FACTS);
    expect(paths).toContain(PATH_PLAN_TREE);
  });

  it("readFile /work.json は作品の基本情報を返す", async () => {
    const { db, work } = await setupWork();
    const f = await readFile(db, work, "/work.json");
    expect(f).not.toBeNull();
    const parsed = JSON.parse(f!.content) as {
      title: string;
      premise: string;
      status: string;
    };
    expect(parsed.title).toBe("テスト作品");
    expect(parsed.premise).toBe("前提");
    expect(parsed.status).toBe("setup");
  });

  it("シーン+契約+リビジョンでパス解決と内容が正しい", async () => {
    const { db, work } = await setupWork();
    const episode = await createEpisode(db, {
      workId: work.id,
      title: "第1話",
    });
    const scene = await createScene(db, {
      episodeId: episode.id,
      title: "廃線ホーム",
      purpose: "導入",
      status: "approved",
    });
    await createWritingContract(db, {
      sceneId: scene.id,
      status: "approved",
      payload: { pov: "三人称" },
    });
    await createSceneRevision(db, {
      sceneId: scene.id,
      contentJson: textToTiptapDoc("本文テスト。\n\n二段落目。"),
      source: "ai",
      jobId: null,
    });

    const files = await listFiles(db, work);
    const paths = files.map((f) => f.path);
    expect(paths).toContain(`/contracts/${scene.id}.json`);
    expect(paths).toContain("/scenes/1-1.md");

    const contract = await readFile(db, work, `/contracts/${scene.id}.json`);
    expect(JSON.parse(contract!.content)).toMatchObject({
      scene_id: scene.id,
      status: "approved",
    });

    const sceneFile = await readFile(db, work, "/scenes/1-1.md");
    expect(sceneFile!.content).toContain("本文テスト。");

    const tree = await readFile(db, work, PATH_PLAN_TREE);
    expect(tree!.content).toContain("第1話");
    expect(tree!.content).toContain("廃線ホーム");
  });

  it("未定義パスは null", async () => {
    const { db, work } = await setupWork();
    expect(await readFile(db, work, "/etc/passwd")).toBeNull();
    expect(await readFile(db, work, "/scenes/9-9.md")).toBeNull();
  });

  it("writePropose は常に proposal 化する (/canon/facts.md は supported)", async () => {
    const { db, work } = await setupWork();
    const res = await writePropose(db, {
      workId: work.id,
      path: PATH_CANON_FACTS,
      content: "- 新しい事実\n- もう一つ",
      provenance: "test",
    });
    expect(res.supported).toBe(true);
    expect(res.proposal.kind).toBe("workspace_write");
    expect(res.proposal.status).toBe("pending");
    const payload = res.proposal.payload as { path: string; content: string };
    expect(payload.path).toBe(PATH_CANON_FACTS);
    // canon_facts には直接入らない
    expect(await listCanonFactsByWork(db, work.id)).toHaveLength(0);
  });

  it("writePropose の他パスは supported=false で記録のみ", async () => {
    const { db, work } = await setupWork();
    const res = await writePropose(db, {
      workId: work.id,
      path: "/plan/tree.md",
      content: "差分",
      provenance: "test",
    });
    expect(res.supported).toBe(false);
    const proposals = await listProposalsByWork(db, work.id);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.kind).toBe("workspace_write");
  });

  it("parseCanonStatements は箇条書きを宣言文にする", () => {
    expect(
      parseCanonStatements("- 事実A\n* 事実B\n・事実C\n1. 事実D\n\n事実E"),
    ).toEqual(["事実A", "事実B", "事実C", "事実D", "事実E"]);
  });
});
