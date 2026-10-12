import { describe, expect, it } from "vitest";
import { textToTiptapDoc } from "@houchi/contracts";
import {
  addCanonFacts,
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

describe("spec 4.3: facts.md の確度グループ化", () => {
  it("/canon/facts.md は commitment ごとにグループ化し、秘密は [秘密] マークを付ける", async () => {
    const { db, work } = await setupWork();
    await addCanonFacts(db, {
      workId: work.id,
      statements: [
        "汽車はもう走っていない",
        { statement: "線路の先は海上である", commitment: "committed" },
        { statement: "黒服は機械であるかもしれない", commitment: "provisional" },
        { statement: "鐘の回数は不明", commitment: "open_by_design" },
        { statement: "町の名前", commitment: "undecided" },
        { statement: "駅長は裏切り者である", disclosure: "secret" },
      ],
      provenance: "test",
    });
    const file = await readFile(db, work, PATH_CANON_FACTS);
    const content = file!.content;
    // グループ見出しの順序
    const order = [
      "## 確定",
      "## 約束済み",
      "## 仮置き",
      "## 意図的未確定",
      "## 未判断",
    ];
    let last = -1;
    for (const h of order) {
      const idx = content.indexOf(h);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
    expect(content).toContain("- [秘密] 駅長は裏切り者である");
    expect(content).toContain("- 黒服は機械であるかもしれない");
    // 仮置き見出しに利用禁止の注記
    expect(content).toContain("本文の確定事項として使わない");
  });

  it("parseCanonStatements はタグ・見出し・区切り線を解釈してラウンドトリップする", () => {
    const parsed = parseCanonStatements(
      [
        "# 正典メモ",
        "",
        "## 確定",
        "- 汽車はもう走っていない",
        "- [秘密] 駅長は裏切り者である",
        "",
        "## 仮置き (未確定 — 本文の確定事項として使わない)",
        "- 黒服は機械であるかもしれない",
        "- [約束済み・秘密] 線路の先は海上である",
        "---",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      // セクション見出しの確度が既定として付く
      { statement: "汽車はもう走っていない", commitment: "fixed" },
      {
        statement: "駅長は裏切り者である",
        commitment: "fixed",
        disclosure: "secret",
      },
      {
        statement: "黒服は機械であるかもしれない",
        commitment: "provisional",
      },
      // 行頭タグはセクション既定を上書きする
      {
        statement: "線路の先は海上である",
        commitment: "committed",
        disclosure: "secret",
      },
    ]);
  });
});
