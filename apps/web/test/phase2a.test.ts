import { describe, expect, it } from "vitest";
import { devLogin, makeApp, makeCall } from "./helpers.js";

/**
 * Phase 2a: workspace 仮想FS、plan 提案、dependency_edges、
 * plan_work 用 thread context (workspace_files/plan_tree)。
 */

async function setupWork(call: ReturnType<typeof makeCall>) {
  const cookie = await devLogin(call);
  await call(
    "POST",
    "/api/keys",
    { label: "メイン", provider: "openai", api_key: "sk-test" },
    { token: null, cookie },
  );
  const workRes = await call(
    "POST",
    "/api/works",
    { title: "テスト作品" },
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
  };
  return {
    cookie,
    workId: work.id,
    threadId: detail.thread.id,
    messageId: detail.messages[0]!.id,
  };
}

describe("Phase 2a", () => {
  it("thread context に workspace_files と plan_tree が含まれる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { workId, threadId } = await setupWork(call);
    void workId;
    const res = await call(
      "GET",
      `/api/internal/threads/${threadId}/context`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspace_files: { path: string }[];
      plan_tree: string;
    };
    const paths = body.workspace_files.map((f) => f.path);
    expect(paths).toContain("/work.json");
    expect(paths).toContain("/canon/facts.md");
    expect(paths).toContain("/plan/tree.md");
    expect(body.plan_tree).toContain("計画はまだありません");
  });

  it("workspace files/file エンドポイントで一覧と中身が取れる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    const filesRes = await call(
      "GET",
      `/api/works/${workId}/workspace/files`,
      undefined,
      { token: null, cookie },
    );
    expect(filesRes.status).toBe(200);
    const { files } = (await filesRes.json()) as {
      files: { path: string; summary: string }[];
    };
    expect(files.map((f) => f.path)).toContain("/work.json");

    const fileRes = await call(
      "GET",
      `/api/works/${workId}/workspace/file?path=${encodeURIComponent("/work.json")}`,
      undefined,
      { token: null, cookie },
    );
    expect(fileRes.status).toBe(200);
    const file = (await fileRes.json()) as { content: string };
    expect(JSON.parse(file.content)).toMatchObject({ title: "テスト作品" });

    const missing = await call(
      "GET",
      `/api/works/${workId}/workspace/file?path=/nope`,
      undefined,
      { token: null, cookie },
    );
    expect(missing.status).toBe(404);
  });

  it("kind=plan の internal proposal → approve で episodes/scenes が作られる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);

    const propRes = await call("POST", "/api/internal/proposals", {
      work_id: workId,
      thread_id: threadId,
      message_id: messageId,
      kind: "plan",
      payload: {
        episodes: [
          {
            title: "第1話 廃線の街",
            scenes: [
              { title: "廃線ホーム", purpose: "導入" },
              { title: "線路の先へ", purpose: "決意" },
            ],
          },
          {
            title: "第2話 廃トンネル",
            scenes: [{ title: "トンネル入口", purpose: "" }],
          },
        ],
      },
    });
    expect(propRes.status).toBe(200);
    const { proposal } = (await propRes.json()) as {
      proposal: { id: string; kind: string };
    };
    expect(proposal.kind).toBe("plan");

    const approveRes = await call(
      "POST",
      `/api/proposals/${proposal.id}/approve`,
      undefined,
      { token: null, cookie },
    );
    expect(approveRes.status).toBe(200);
    const approved = (await approveRes.json()) as {
      proposal: { status: string };
      episodes: { title: string; ord: number }[];
      scenes: { title: string; status: string }[];
    };
    expect(approved.proposal.status).toBe("approved");
    expect(approved.episodes).toHaveLength(2);
    expect(approved.scenes).toHaveLength(3);
    expect(approved.scenes.every((s) => s.status === "draft")).toBe(true);

    // 資料タブ相当のファイル一覧にシーンが出る
    const filesRes = await call(
      "GET",
      `/api/works/${workId}/workspace/files`,
      undefined,
      { token: null, cookie },
    );
    const { files } = (await filesRes.json()) as {
      files: { path: string }[];
    };
    expect(files.map((f) => f.path)).toContain("/scenes/1-1.md");
    expect(files.map((f) => f.path)).toContain("/scenes/2-1.md");
  });

  it("kind=plan を却下すると rejected になり何も作られない", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);
    const propRes = await call("POST", "/api/internal/proposals", {
      work_id: workId,
      thread_id: threadId,
      message_id: messageId,
      kind: "plan",
      payload: { episodes: [{ title: "話", scenes: [] }] },
    });
    const { proposal } = (await propRes.json()) as { proposal: { id: string } };
    const rejectRes = await call(
      "POST",
      `/api/proposals/${proposal.id}/reject`,
      undefined,
      { token: null, cookie },
    );
    expect(rejectRes.status).toBe(200);
    const proseRes = await call("GET", `/api/works/${workId}/prose`, undefined, {
      token: null,
      cookie,
    });
    const prose = (await proseRes.json()) as { episodes: unknown[] };
    expect(prose.episodes).toHaveLength(0);
  });

  it("workspace write 提案 → approve で /canon/facts.md 追記が canon_facts になる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    const writeRes = await call(
      "POST",
      `/api/internal/works/${workId}/workspace/write`,
      {
        path: "/canon/facts.md",
        content: "- 汽車はもう走っていない\n- 都市の心音が響く",
        provenance: "test-e2e",
      },
    );
    expect(writeRes.status).toBe(200);
    const { proposal, supported } = (await writeRes.json()) as {
      proposal: { id: string; kind: string; status: string };
      supported: boolean;
    };
    expect(supported).toBe(true);
    expect(proposal.kind).toBe("workspace_write");

    const approveRes = await call(
      "POST",
      `/api/proposals/${proposal.id}/approve`,
      undefined,
      { token: null, cookie },
    );
    expect(approveRes.status).toBe(200);
    const approved = (await approveRes.json()) as { added: number };
    expect(approved.added).toBe(2);

    // /canon/facts.md の内容に反映されている
    const fileRes = await call(
      "GET",
      `/api/works/${workId}/workspace/file?path=${encodeURIComponent("/canon/facts.md")}`,
      undefined,
      { token: null, cookie },
    );
    const file = (await fileRes.json()) as { content: string };
    expect(file.content).toContain("汽車はもう走っていない");
    expect(file.content).toContain("都市の心音が響く");
  });

  it("workspace write の未対応パスは supported=false で提案記録のみ", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    const writeRes = await call(
      "POST",
      `/api/internal/works/${workId}/workspace/write`,
      {
        path: "/plan/tree.md",
        content: "差分",
        provenance: "test",
      },
    );
    const { supported, proposal } = (await writeRes.json()) as {
      supported: boolean;
      proposal: { id: string };
    };
    expect(supported).toBe(false);

    const approveRes = await call(
      "POST",
      `/api/proposals/${proposal.id}/approve`,
      undefined,
      { token: null, cookie },
    );
    const approved = (await approveRes.json()) as { added: number };
    expect(approved.added).toBe(0);
  });

  it("scenes/:id/dependencies で dependency_edges を記録する", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { workId, threadId, messageId } = await setupWork(call);

    // writing_contract 提案を経て scene を作る
    const propRes = await call("POST", "/api/internal/proposals", {
      work_id: workId,
      thread_id: threadId,
      message_id: messageId,
      kind: "writing_contract",
      payload: {
        episode_title: "第1話",
        scene_title: "廃線ホーム",
        scene_purpose: "導入",
        contract: { role: "導入", pov: "三人称" },
      },
    });
    const { proposal } = (await propRes.json()) as {
      proposal: { payload: { scene_id: string } };
    };
    const sceneId = proposal.payload.scene_id;

    const depRes = await call(
      "POST",
      `/api/internal/scenes/${sceneId}/dependencies`,
      {
        edges: [
          { target_kind: "canon_fact", target_ref: "汽車はもう走っていない" },
          { target_kind: "plan", target_ref: "第1話" },
        ],
      },
    );
    expect(depRes.status).toBe(200);
    const deps = (await depRes.json()) as {
      edges: { target_kind: string }[];
      added: number;
    };
    expect(deps.added).toBe(2);
    expect(deps.edges).toHaveLength(2);

    // 完全一致の重複はスキップ (冪等)
    const dupRes = await call(
      "POST",
      `/api/internal/scenes/${sceneId}/dependencies`,
      {
        edges: [
          { target_kind: "canon_fact", target_ref: "汽車はもう走っていない" },
        ],
      },
    );
    const dup = (await dupRes.json()) as { added: number; edges: unknown[] };
    expect(dup.added).toBe(0);
    expect(dup.edges).toHaveLength(2);
  });
});
