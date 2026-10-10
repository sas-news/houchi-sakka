import { describe, expect, it } from "vitest";
import {
  BASE_URL,
  cookieFrom,
  devLogin,
  makeApp,
  makeCall,
  signUp,
} from "./helpers.js";

/**
 * Phase 1b: 提案の承認/却下 → generate_scene 投下、本文 API、設定、正典。
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
  return { cookie, workId: work.id, threadId: detail.thread.id, messageId: detail.messages[0]!.id };
}

async function makeProposal(
  call: ReturnType<typeof makeCall>,
  ids: { workId: string; threadId: string; messageId: string },
) {
  const res = await call("POST", "/api/internal/proposals", {
    work_id: ids.workId,
    thread_id: ids.threadId,
    message_id: ids.messageId,
    kind: "writing_contract",
    payload: {
      episode_title: "第1話",
      scene_title: "廃線ホーム",
      scene_purpose: "導入",
      contract: { role: "導入", pov: "三人称", required_events: ["雨上がり"] },
    },
  });
  const { proposal } = (await res.json()) as {
    proposal: { id: string; payload: { scene_id: string; contract_id: string; episode_id: string } };
  };
  return proposal;
}

describe("Phase 1b API", () => {
  it("internal/proposals が episode/scene/contract/proposal を作る", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const ids = await setupWork(call);
    const proposal = await makeProposal(call, ids);
    expect(proposal.payload.scene_id).toBeTruthy();
    expect(proposal.payload.contract_id).toBeTruthy();

    const cookie = (await devLogin(call));
    const prose = (await (
      await call("GET", `/api/works/${ids.workId}/prose`, undefined, {
        token: null,
        cookie,
      })
    ).json()) as {
      episodes: { title: string }[];
      scenes: { title: string; status: string }[];
      contracts: { status: string }[];
    };
    expect(prose.episodes[0]!.title).toBe("第1話");
    expect(prose.scenes[0]!.status).toBe("proposed");
    expect(prose.contracts[0]!.status).toBe("draft");
  });

  it("approve → 契約/シーン approved + generate_scene がキューされる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const ids = await setupWork(call);
    const proposal = await makeProposal(call, ids);
    const cookie = await devLogin(call);

    const res = await call(
      "POST",
      `/api/proposals/${proposal.id}/approve`,
      undefined,
      { token: null, cookie },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proposal: { status: string };
      scene: { status: string };
      contract: { status: string };
      job: { kind: string; status: string };
    };
    expect(body.proposal.status).toBe("approved");
    expect(body.scene.status).toBe("approved");
    expect(body.contract.status).toBe("approved");
    expect(body.job.kind).toBe("generate_scene");
    expect(body.job.status).toBe("queued");

    // 二重承認は弾かれる
    const again = await call(
      "POST",
      `/api/proposals/${proposal.id}/approve`,
      undefined,
      { token: null, cookie },
    );
    expect(again.status).toBe(400);
  });

  it("reject → 契約 rejected + シーン draft + 続きを促すメッセージ", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const ids = await setupWork(call);
    const proposal = await makeProposal(call, ids);
    const cookie = await devLogin(call);

    const res = await call(
      "POST",
      `/api/proposals/${proposal.id}/reject`,
      undefined,
      { token: null, cookie },
    );
    expect(res.status).toBe(200);
    const detail = (await (
      await call("GET", `/api/works/${ids.workId}`, undefined, {
        token: null,
        cookie,
      })
    ).json()) as { messages: { role: string; content: string }[] };
    expect(detail.messages.at(-1)!.content).toContain("却下しました");
  });

  it("他人の提案は approve/reject できない (owner スコープ)", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const ids = await setupWork(call);
    const proposal = await makeProposal(call, ids);
    const other = await signUp(call, "other@example.com");

    for (const action of ["approve", "reject"] as const) {
      const res = await call(
        "POST",
        `/api/proposals/${proposal.id}/${action}`,
        undefined,
        { token: null, cookie: other },
      );
      expect(res.status).toBe(404);
    }
  });

  it("rewrite は承認済み契約が必要 → 承認後は instruction 付きで投下できる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const ids = await setupWork(call);
    const proposal = await makeProposal(call, ids);
    const cookie = await devLogin(call);
    const sceneId = proposal.payload.scene_id;

    // 未承認のうちは 400
    const early = await call(
      "POST",
      `/api/scenes/${sceneId}/rewrite`,
      { instruction: "もっと静かに" },
      { token: null, cookie },
    );
    expect(early.status).toBe(400);

    await call("POST", `/api/proposals/${proposal.id}/approve`, undefined, {
      token: null,
      cookie,
    });
    const res = await call(
      "POST",
      `/api/scenes/${sceneId}/rewrite`,
      { instruction: "もっと静かに" },
      { token: null, cookie },
    );
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as {
      job: { kind: string; payload: { instruction: string } };
    };
    expect(job.kind).toBe("generate_scene");
    expect(job.payload.instruction).toBe("もっと静かに");
  });

  it("手編集リビジョンと正典メモの重複スキップ", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const ids = await setupWork(call);
    const proposal = await makeProposal(call, ids);
    const cookie = await devLogin(call);
    const sceneId = proposal.payload.scene_id;

    const rev = await call(
      "POST",
      `/api/scenes/${sceneId}/revisions`,
      { text: "手で書いた本文。\n\n二段落目。" },
      { token: null, cookie },
    );
    expect(rev.status).toBe(201);
    const { revision } = (await rev.json()) as {
      revision: { rev_no: number; source: string };
    };
    expect(revision.rev_no).toBe(1);
    expect(revision.source).toBe("manual_edit");

    const cf = await call("POST", `/api/internal/works/${ids.workId}/canon-facts`, {
      statements: ["主人公は少女", "主人公は少女"],
      provenance: "orchestrator",
    });
    const cfBody = (await cf.json()) as { added: number; canon_facts: unknown[] };
    expect(cfBody.added).toBe(1);
    expect(cfBody.canon_facts).toHaveLength(1);
  });

  it("設定タブ: 自分のキーとモデルを保存できる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const cookie = await devLogin(call);
    const keyRes = await call(
      "POST",
      "/api/keys",
      { label: "サブ", provider: "anthropic", api_key: "sk-ant" },
      { token: null, cookie },
    );
    const { key } = (await keyRes.json()) as { key: { id: string } };
    const workRes = await call(
      "POST",
      "/api/works",
      { title: "設定テスト" },
      { token: null, cookie },
    );
    const { work } = (await workRes.json()) as { work: { id: string } };

    const res = await call(
      "PATCH",
      `/api/works/${work.id}/settings`,
      { key_id: key.id, model: "claude-test" },
      { token: null, cookie },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      work: { key_ref: string; provider: string; model: string };
    };
    expect(body.work.key_ref).toBe(key.id);
    expect(body.work.provider).toBe("anthropic");
    expect(body.work.model).toBe("claude-test");
  });
});
