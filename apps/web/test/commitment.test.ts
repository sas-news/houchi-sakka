import { describe, expect, it } from "vitest";
import { textToTiptapDoc } from "@houchi/contracts";
import { devLogin, makeApp, makeCall } from "./helpers.js";

/**
 * spec §4.3: 正典のコミットメント状態 (確度) + 開示ポリシー。
 * - canon_facts に commitment/disclosure を持たせ、リビジョンの一部として記録する
 * - set_fact_commitment は旧行を閉じて新リビジョンを挿入する
 * - 影響分析は対象 fact の依存シーンを影響に含める
 * - 公開側 (/api/r, /api/w) に正典 (特に secret) を含めない
 */

type Call = ReturnType<typeof makeCall>;

type CanonFact = {
  id: string;
  statement: string;
  commitment: string;
  disclosure: string;
  provenance: string;
  valid_to_rev: number | null;
};

async function setupWork(call: Call) {
  const cookie = await devLogin(call);
  const workRes = await call(
    "POST",
    "/api/works",
    { title: "確度テスト作品" },
    { token: null, cookie },
  );
  const { work } = (await workRes.json()) as { work: { id: string } };
  const detail = (await (
    await call("GET", `/api/works/${work.id}`, undefined, {
      token: null,
      cookie,
    })
  ).json()) as {
    thread: { id: string };
    messages: { id: string }[];
    work: { canon_rev: number };
  };
  return {
    cookie,
    workId: work.id,
    threadId: detail.thread.id,
    messageId: detail.messages[0]!.id,
  };
}

async function getCanonFacts(call: Call, cookie: string, workId: string) {
  const prose = (await (
    await call("GET", `/api/works/${workId}/prose`, undefined, {
      token: null,
      cookie,
    })
  ).json()) as { canon_facts: CanonFact[]; scenes: { id: string }[] };
  return prose.canon_facts;
}

describe("spec 4.3: コミットメント状態", () => {
  it("canon-facts POST は commitment/disclosure 付きオブジェクトを受け付け、文字列は既定値", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    const res = await call("POST", `/api/internal/works/${workId}/canon-facts`, {
      statements: [
        "汽車はもう走っていない",
        { statement: "黒服は機械であるかもしれない", commitment: "provisional" },
        { statement: "駅長は裏切り者である", disclosure: "secret" },
        { statement: "線路の先は海上である", commitment: "committed" },
        { statement: "鐘の回数は数えてはいけない", commitment: "open_by_design" },
        { statement: "町の名前", commitment: "undecided" },
      ],
      provenance: "test",
    });
    expect(res.status).toBe(200);
    const { added } = (await res.json()) as { added: number };
    expect(added).toBe(6);

    const facts = await getCanonFacts(call, cookie, workId);
    const byStatement = new Map(facts.map((f) => [f.statement, f]));
    expect(byStatement.get("汽車はもう走っていない")!.commitment).toBe("fixed");
    expect(byStatement.get("汽車はもう走っていない")!.disclosure).toBe("normal");
    expect(byStatement.get("黒服は機械であるかもしれない")!.commitment).toBe(
      "provisional",
    );
    expect(byStatement.get("駅長は裏切り者である")!.disclosure).toBe("secret");
    expect(byStatement.get("線路の先は海上である")!.commitment).toBe("committed");
    expect(byStatement.get("鐘の回数は数えてはいけない")!.commitment).toBe(
      "open_by_design",
    );
    expect(byStatement.get("町の名前")!.commitment).toBe("undecided");
  });

  it("canon_facts レスポンスは commitment/disclosure を含む", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    await call("POST", `/api/internal/works/${workId}/canon-facts`, {
      statements: [
        { statement: "実は主人公は機械である", disclosure: "secret" },
      ],
      provenance: "secret",
    });
    const facts = await getCanonFacts(call, cookie, workId);
    expect(facts[0]!.disclosure).toBe("secret");
    expect(facts[0]!.commitment).toBe("fixed");
  });

  it("add_fact op は commitment/disclosure を適用し、revise_fact は省略時に継承する", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    // add_fact with commitment
    const csRes = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      work_id: workId,
      title: "仮置き正典の追加",
      ops: [
        {
          op: "add_fact",
          statement: "線路の先は海上である",
          commitment: "provisional",
        },
      ],
    });
    const { change_set } = (await csRes.json()) as {
      change_set: { id: string };
    };
    await call("POST", `/api/change-sets/${change_set.id}/approve`, undefined, {
      token: null,
      cookie,
    });
    let facts = await getCanonFacts(call, cookie, workId);
    const added = facts.find((f) => f.statement === "線路の先は海上である")!;
    expect(added.commitment).toBe("provisional");
    expect(added.disclosure).toBe("normal");

    // revise_fact 省略時は commitment/disclosure を継承
    const cs2 = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      work_id: workId,
      title: "文面だけ修正",
      ops: [
        {
          op: "revise_fact",
          fact_id: added.id,
          new_statement: "線路の先は海の底である",
        },
      ],
    });
    const { change_set: cs2set } = (await cs2.json()) as {
      change_set: { id: string };
    };
    await call("POST", `/api/change-sets/${cs2set.id}/approve`, undefined, {
      token: null,
      cookie,
    });
    facts = await getCanonFacts(call, cookie, workId);
    const revised = facts.find((f) => f.statement === "線路の先は海の底である")!;
    expect(revised.commitment).toBe("provisional");

    // revise_fact に指定すれば上書き
    const cs3 = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      work_id: workId,
      title: "確定に格上げ",
      ops: [
        {
          op: "revise_fact",
          fact_id: revised.id,
          new_statement: "線路の先は海の底である",
          commitment: "fixed",
          disclosure: "secret",
        },
      ],
    });
    const { change_set: cs3set } = (await cs3.json()) as {
      change_set: { id: string };
    };
    await call("POST", `/api/change-sets/${cs3set.id}/approve`, undefined, {
      token: null,
      cookie,
    });
    facts = await getCanonFacts(call, cookie, workId);
    const promoted = facts.find((f) => f.statement === "線路の先は海の底である")!;
    expect(promoted.commitment).toBe("fixed");
    expect(promoted.disclosure).toBe("secret");
  });

  it("set_fact_commitment は旧行を閉じて新リビジョンを作り、影響分析は依存シーンを含める", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);

    // 正典 + シーン + 依存宣言
    await call("POST", `/api/internal/works/${workId}/canon-facts`, {
      statements: ["汽車はもう走っていない"],
      provenance: "test",
    });
    const propRes = await call("POST", "/api/internal/proposals", {
      work_id: workId,
      thread_id: threadId,
      message_id: messageId,
      kind: "plan",
      payload: {
        episodes: [
          { title: "第1話", scenes: [{ title: "廃線ホーム", purpose: "導入" }] },
        ],
      },
    });
    const { proposal } = (await propRes.json()) as {
      proposal: { id: string };
    };
    await call("POST", `/api/proposals/${proposal.id}/approve`, undefined, {
      token: null,
      cookie,
    });
    const prose = (await (
      await call("GET", `/api/works/${workId}/prose`, undefined, {
        token: null,
        cookie,
      })
    ).json()) as { scenes: { id: string }[]; canon_facts: CanonFact[] };
    const sceneId = prose.scenes[0]!.id;
    const factId = prose.canon_facts[0]!.id;
    await call("POST", `/api/internal/scenes/${sceneId}/dependencies`, {
      edges: [{ target_kind: "canon_fact", target_ref: "汽車はもう走っていない" }],
    });

    // 影響分析: set_fact_commitment でも依存シーンが影響に含まれる
    const csRes = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      work_id: workId,
      title: "確度を仮置きへ",
      ops: [
        { op: "set_fact_commitment", fact_id: factId, commitment: "provisional" },
      ],
    });
    const { change_set } = (await csRes.json()) as {
      change_set: { id: string; impact: { scenes: { id: string }[] } };
    };
    expect(change_set.impact.scenes.map((s) => s.id)).toContain(sceneId);

    // approve → 旧行閉鎖 + 新行に provisional
    await call("POST", `/api/change-sets/${change_set.id}/approve`, undefined, {
      token: null,
      cookie,
    });
    const facts = await getCanonFacts(call, cookie, workId);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.statement).toBe("汽車はもう走っていない");
    expect(facts[0]!.commitment).toBe("provisional");
    expect(facts[0]!.id).not.toBe(factId); // 新しいリビジョン行

    // history に閉じた旧行が残る
    const history = await call(
      "GET",
      `/api/works/${workId}/workspace/file?path=${encodeURIComponent("/canon/history.md")}`,
      undefined,
      { token: null, cookie },
    );
    const { content } = (await history.json()) as { content: string };
    expect(content).toContain("汽車はもう走っていない");

    // work.canon_rev が進む
    const detail = (await (
      await call("GET", `/api/works/${workId}`, undefined, {
        token: null,
        cookie,
      })
    ).json()) as { work: { canon_rev: number } };
    expect(detail.work.canon_rev).toBe(1);
  });

  it("公開 API (/api/r, /api/w) は正典を含めない (secret も同様)", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);

    await call("POST", `/api/internal/works/${workId}/canon-facts`, {
      statements: [
        { statement: "駅長は裏切り者である", disclosure: "secret" },
        { statement: "汽車はもう走っていない", commitment: "provisional" },
      ],
      provenance: "test",
    });

    // 1話1シーンを公開
    const propRes = await call("POST", "/api/internal/proposals", {
      work_id: workId,
      thread_id: threadId,
      message_id: messageId,
      kind: "plan",
      payload: {
        episodes: [
          { title: "第1話", scenes: [{ title: "廃線ホーム", purpose: "導入" }] },
        ],
      },
    });
    const { proposal } = (await propRes.json()) as {
      proposal: { id: string };
    };
    const approveRes = await call(
      "POST",
      `/api/proposals/${proposal.id}/approve`,
      undefined,
      { token: null, cookie },
    );
    const { episodes, scenes } = (await approveRes.json()) as {
      episodes: { id: string }[];
      scenes: { id: string }[];
    };
    await call("POST", `/api/internal/scenes/${scenes[0]!.id}/revisions`, {
      content_json: textToTiptapDoc("汽車は止まった。ホームには誰もいない。"),
      source: "ai",
      job_id: null,
    });
    const pubRes = await call(
      "POST",
      `/api/works/${workId}/episodes/${episodes[0]!.id}/releases`,
      undefined,
      { token: null, cookie },
    );
    const { release } = (await pubRes.json()) as { release: { id: string } };

    // 読者 API のレスポンスに正典・その文面・フィールド名が出ない
    const rRes = await call("GET", `/api/r/${release.id}`, undefined, {
      token: null,
    });
    const rBody = JSON.stringify(await rRes.json());
    expect(rBody).not.toContain("駅長は裏切り者である");
    expect(rBody).not.toContain("canon_facts");
    expect(rBody).not.toContain("disclosure");

    const wRes = await call("GET", `/api/w/${workId}`, undefined, {
      token: null,
    });
    const wBody = JSON.stringify(await wRes.json());
    expect(wBody).not.toContain("駅長は裏切り者である");
    expect(wBody).not.toContain("canon_facts");
  });
});
