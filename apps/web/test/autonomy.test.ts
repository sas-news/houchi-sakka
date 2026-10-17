import { describe, expect, it } from "vitest";
import { devLogin, makeApp, makeCall } from "./helpers.js";

/**
 * spec §7.2/§7.3/§7.4: 自律運転 Draft only のライフサイクル
 * (開始→継続→停止) と実行ステップ記録 (AgentStep) の API。
 */

type Call = ReturnType<typeof makeCall>;

type JobLite = {
  id: string;
  kind: string;
  status: string;
  error: string | null;
  payload: Record<string, unknown>;
};

type WorkLite = {
  id: string;
  autonomy_level: "off" | "draft";
  autonomy_budget: number;
};

async function setupWork(call: Call) {
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
  const { work } = (await workRes.json()) as { work: WorkLite };
  return { cookie, workId: work.id };
}

/** 実行体としてキュー先頭のジョブをリースする。 */
async function lease(call: Call) {
  const res = await call("POST", "/api/jobs/lease", { executor_id: "ex-1" });
  expect(res.status).toBe(200);
  return (await res.json()) as { job: JobLite; lease_token: string };
}

async function complete(call: Call, jobId: string, leaseToken: string, result: unknown) {
  const res = await call("POST", `/api/jobs/${jobId}/complete`, {
    lease_token: leaseToken,
    result,
  });
  expect(res.status).toBe(200);
}

async function getWork(call: Call, cookie: string, workId: string) {
  const res = await call("GET", `/api/works/${workId}`, undefined, {
    token: null,
    cookie,
  });
  return (await res.json()) as {
    work: WorkLite;
    active_job: { job: JobLite } | null;
    messages: { role: string; content: string }[];
  };
}

describe("自律運転 (spec §7.2/§7.3)", () => {
  it("start で自律ジョブが起票され、上限まで継続後に自動停止する", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    const start = await call(
      "POST",
      `/api/works/${workId}/autonomy`,
      { action: "start", max_turns: 2 },
      { token: null, cookie },
    );
    expect(start.status).toBe(200);
    const { work } = (await start.json()) as { work: WorkLite };
    expect(work.autonomy_level).toBe("draft");
    // 1往復目は既に起票済みなので残りは maxTurns-1
    expect(work.autonomy_budget).toBe(1);

    // 1往復目: autonomous フラグ付き・trigger_message_id なし
    const t1 = await lease(call);
    expect(t1.job.kind).toBe("orchestrator_turn");
    expect(t1.job.payload.autonomous).toBe(true);
    expect(t1.job.payload.trigger_message_id).toBeUndefined();

    // 副作用あり → 継続 (budget 0 に減って次の往復が起票される)
    await complete(call, t1.job.id, t1.lease_token, {
      kind: "orchestrator_turn",
      actions: ["work_patch"],
    });
    const mid = await getWork(call, cookie, workId);
    expect(mid.work.autonomy_level).toBe("draft");
    expect(mid.work.autonomy_budget).toBe(0);

    // 2往復目完了 → 上限到達で停止
    const t2 = await lease(call);
    expect(t2.job.payload.autonomous).toBe(true);
    await complete(call, t2.job.id, t2.lease_token, {
      kind: "orchestrator_turn",
      actions: ["propose"],
    });
    const end = await getWork(call, cookie, workId);
    expect(end.work.autonomy_level).toBe("off");
    expect(end.work.autonomy_budget).toBe(0);
    // 停止理由がシステムメッセージで残る
    expect(
      end.messages.some(
        (m) => m.role === "system" && m.content.includes("実行上限"),
      ),
    ).toBe(true);
  });

  it("<<AUTO_STOP>> 結果で自律運転が停止する", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    await call(
      "POST",
      `/api/works/${workId}/autonomy`,
      { action: "start", max_turns: 10 },
      { token: null, cookie },
    );
    const t = await lease(call);
    await complete(call, t.job.id, t.lease_token, {
      kind: "orchestrator_turn",
      actions: ["propose"],
      auto_stop: true,
    });
    const detail = await getWork(call, cookie, workId);
    expect(detail.work.autonomy_level).toBe("off");
    expect(
      detail.messages.some(
        (m) => m.role === "system" && m.content.includes("終了を選択"),
      ),
    ).toBe(true);
  });

  it("自律ジョブの失敗で自律運転が停止する (障害時の安全停止)", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    await call(
      "POST",
      `/api/works/${workId}/autonomy`,
      { action: "start", max_turns: 10 },
      { token: null, cookie },
    );
    const t = await lease(call);
    const res = await call("POST", `/api/jobs/${t.job.id}/fail`, {
      lease_token: t.lease_token,
      error: "provider returned HTTP 402",
    });
    expect(res.status).toBe(200);
    const detail = await getWork(call, cookie, workId);
    expect(detail.work.autonomy_level).toBe("off");
    expect(
      detail.messages.some(
        (m) => m.role === "system" && m.content.includes("ジョブが失敗"),
      ),
    ).toBe(true);
  });

  it("副作用なしの自律返答は作者の判断待ちとして停止する", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    await call(
      "POST",
      `/api/works/${workId}/autonomy`,
      { action: "start", max_turns: 10 },
      { token: null, cookie },
    );
    const t = await lease(call);
    await complete(call, t.job.id, t.lease_token, {
      kind: "orchestrator_turn",
      actions: [],
    });
    const detail = await getWork(call, cookie, workId);
    expect(detail.work.autonomy_level).toBe("off");
    expect(
      detail.messages.some(
        (m) => m.role === "system" && m.content.includes("判断"),
      ),
    ).toBe(true);
  });

  it("stop で即座に off になり、実行中でも次の往復は起票されない", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    await call(
      "POST",
      `/api/works/${workId}/autonomy`,
      { action: "start", max_turns: 10 },
      { token: null, cookie },
    );
    const t = await lease(call);
    const stop = await call(
      "POST",
      `/api/works/${workId}/autonomy`,
      { action: "stop" },
      { token: null, cookie },
    );
    expect(stop.status).toBe(200);
    // 手動停止後に完了しても継続起票されない
    await complete(call, t.job.id, t.lease_token, {
      kind: "orchestrator_turn",
      actions: ["propose"],
    });
    const detail = await getWork(call, cookie, workId);
    expect(detail.work.autonomy_level).toBe("off");
    expect(detail.active_job).toBeNull();
  });
});

describe("実行ステップ記録 (spec §7.4)", () => {
  it("steps API で記録し、ジョブ詳細で一覧できる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    await call(
      "POST",
      `/api/works/${workId}/messages`,
      { content: "構成を考えて" },
      { token: null, cookie },
    );
    const { job, lease_token } = await lease(call);

    const s1 = await call("POST", `/api/jobs/${job.id}/steps`, {
      lease_token,
      name: "call_provider",
      started_at: Date.now() - 100,
      ended_at: Date.now(),
      model: "gpt-4o-mini",
      provider: "openai",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(s1.status).toBe(200);
    const { step } = (await s1.json()) as {
      step: { seq: number; name: string; status: string };
    };
    expect(step.seq).toBe(1);
    expect(step.name).toBe("call_provider");

    await call("POST", `/api/jobs/${job.id}/steps`, {
      lease_token,
      name: "persist_message",
      started_at: Date.now(),
      status: "error",
      error: "db write failed",
    });

    const detail = await call(
      "GET",
      `/api/works/${workId}/jobs/${job.id}`,
      undefined,
      { token: null, cookie },
    );
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      steps: { seq: number; name: string; status: string; error: string | null }[];
    };
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0]!.seq).toBe(1);
    expect(body.steps[1]!.name).toBe("persist_message");
    expect(body.steps[1]!.status).toBe("error");
    expect(body.steps[1]!.error).toBe("db write failed");
  });

  it("他人のジョブ詳細は見えない・実行体トークンなしでは記録できない", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    await call(
      "POST",
      `/api/works/${workId}/messages`,
      { content: "x" },
      { token: null, cookie },
    );
    const { job } = await lease(call);

    const detail = await call(
      "GET",
      `/api/works/${workId}/jobs/${job.id}`,
      undefined,
      { token: null },
    );
    expect(detail.status).toBe(401);

    const step = await call("POST", `/api/jobs/${job.id}/steps`, {
      lease_token: "wrong",
      name: "x",
      started_at: Date.now(),
    });
    expect(step.status).toBe(409);
  });
});
