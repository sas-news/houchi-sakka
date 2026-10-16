import { describe, expect, it } from "vitest";
import { devLogin, makeApp, makeCall, signUp } from "./helpers.js";

/**
 * gaps §3.4: 失敗ジョブの可視化 (GET /api/works/:id の recent_jobs) と
 * 「もう一度送信」の再送導線。
 * gaps §5: charter/policy を変える update_work 適用時に適用前の値を
 * change_sets.prev_settings に退避する。
 */

type Call = ReturnType<typeof makeCall>;

type JobLite = {
  id: string;
  kind: string;
  status: string;
  error: string | null;
  payload: Record<string, unknown>;
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
  const { work } = (await workRes.json()) as { work: { id: string } };
  return { cookie, workId: work.id };
}

/** 対話送信 → orchestrator_turn ジョブの作成。 */
async function send(
  call: Call,
  cookie: string,
  workId: string,
  content: string,
) {
  const res = await call(
    "POST",
    `/api/works/${workId}/messages`,
    { content },
    { token: null, cookie },
  );
  expect(res.status).toBe(202);
  return (await res.json()) as {
    message: { id: string; content: string };
    job: JobLite;
  };
}

/** 実行体としてキュー先頭のジョブをリース→失敗させる。 */
async function failLeased(call: Call, error: string) {
  const lease = await call("POST", "/api/jobs/lease", { executor_id: "ex-1" });
  const { job, lease_token } = (await lease.json()) as {
    job: JobLite;
    lease_token: string;
  };
  const res = await call("POST", `/api/jobs/${job.id}/fail`, {
    lease_token,
    error,
  });
  expect(res.status).toBe(200);
  const { job: failed } = (await res.json()) as { job: JobLite };
  return failed;
}

describe("実行履歴 (recent_jobs)", () => {
  it("全 status のジョブが新しい順に返り、失敗理由が載る", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    const sent = await send(call, cookie, workId, "第一章を書きたい");
    const failed = await failLeased(call, "プロバイダーが応答しません");

    const detail = (await (
      await call("GET", `/api/works/${workId}`, undefined, {
        token: null,
        cookie,
      })
    ).json()) as {
      active_job: unknown;
      recent_jobs: JobLite[];
    };
    expect(detail.active_job).toBeNull();
    expect(detail.recent_jobs.length).toBeGreaterThanOrEqual(1);
    expect(detail.recent_jobs[0]!.id).toBe(failed.id);
    expect(detail.recent_jobs[0]!.status).toBe("failed");
    expect(detail.recent_jobs[0]!.error).toBe("プロバイダーが応答しません");
    expect(sent.job.id).toBe(failed.id);
  });

  it("他人の作品の履歴は見えない (404)", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    await send(call, cookie, workId, "x");
    await failLeased(call, "err");

    // dev-login は同一ユーザーを返すので別ユーザーを signUp で作る
    const bob = await signUp(call, "bob@example.com");
    const res = await call("GET", `/api/works/${workId}`, undefined, {
      token: null,
      cookie: bob,
    });
    expect(res.status).toBe(404);
  });
});

describe("失敗ジョブの再送", () => {
  it("failed の対話ジョブを再送すると新規メッセージ+ジョブが作られる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    const sent = await send(call, cookie, workId, "結末を変えたい");
    const failed = await failLeased(call, "timeout");

    const res = await call(
      "POST",
      `/api/works/${workId}/jobs/${failed.id}/resend`,
      undefined,
      { token: null, cookie },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      message: { id: string; content: string };
      job: JobLite;
    };
    // 新しいメッセージと新しいジョブ (元のメッセージ/ジョブは使い回さない)
    expect(body.message.id).not.toBe(sent.message.id);
    expect(body.message.content).toBe("結末を変えたい");
    expect(body.job.id).not.toBe(failed.id);
    expect(body.job.kind).toBe("orchestrator_turn");
    expect(body.job.status).toBe("queued");
    expect(body.job.payload.resend_of).toBe(failed.id);
    // 再送分がキューの先頭 (直列化の先頭) に入る
    const detail = (await (
      await call("GET", `/api/works/${workId}`, undefined, {
        token: null,
        cookie,
      })
    ).json()) as { active_job: { job: JobLite } | null; messages: { id: string }[] };
    expect(detail.active_job?.job.id).toBe(body.job.id);
    // 元メッセージ + 再送メッセージ + 案内文 = 3件
    expect(detail.messages).toHaveLength(3);
  });

  it("再送は現在の作品設定のモデル/キーを使う (失敗した旧ペイロードを引きずらない)", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    // メッセージごとのモデル指定で旧ペイロードに互換性のない値が残った状態を再現
    const res0 = await call(
      "POST",
      `/api/works/${workId}/messages`,
      { content: "書きたい", model: "gpt-4o-mini" },
      { token: null, cookie },
    );
    expect(res0.status).toBe(202);
    const failed = await failLeased(call, "provider returned HTTP 404");

    // 作品設定を修正してから再送 → 旧ペイロードでなく作品設定が使われる
    const set = await call(
      "PATCH",
      `/api/works/${workId}/settings`,
      { model: "gemini-2.5-flash" },
      { token: null, cookie },
    );
    expect(set.status).toBe(200);

    const res = await call(
      "POST",
      `/api/works/${workId}/jobs/${failed.id}/resend`,
      undefined,
      { token: null, cookie },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { job: JobLite };
    expect(body.job.payload.model).toBe("gemini-2.5-flash");
  });

  it("queued のジョブは再送できない (400)", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    const sent = await send(call, cookie, workId, "x");

    // queued のまま → 400
    const res = await call(
      "POST",
      `/api/works/${workId}/jobs/${sent.job.id}/resend`,
      undefined,
      { token: null, cookie },
    );
    expect(res.status).toBe(400);
  });

  it("対話以外のジョブは再送できない (400)", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    // 実行体 API で別種ジョブを作って失敗させる
    const created = await call("POST", "/api/jobs", {
      kind: "smoke_generate",
      work_ref: workId,
      payload: { model: "m" },
      idempotency_key: "smoke-1",
    });
    const { job: smoke } = (await created.json()) as { job: JobLite };
    await failLeased(call, "err");

    const res = await call(
      "POST",
      `/api/works/${workId}/jobs/${smoke.id}/resend`,
      undefined,
      { token: null, cookie },
    );
    expect(res.status).toBe(400);
  });
});

describe("変更前スナップショット (prev_settings)", () => {
  it("charter/policy を変える update_work 適用で適用前の値が退避される", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    // 旧版の憲章/ポリシーを直接 patch で設定
    const patched = await call("POST", `/api/internal/works/${workId}/patch`, {
      charter: { theme: "駅", tone: "静か" },
      policy: { pacing: "slow" },
    });
    expect(patched.status).toBe(200);

    // charter/policy 両方を変える変更セット → 承認
    const res = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      title: "憲章とポリシーの更新",
      ops: [
        {
          op: "update_work",
          patch: {
            charter: { theme: "海", tone: "明るい" },
            policy: { pacing: "fast" },
          },
        },
      ],
    });
    expect(res.status).toBe(201);
    const { change_set } = (await res.json()) as {
      change_set: { id: string; prev_settings: unknown };
    };
    // 提案中はまだスナップショットなし
    expect(change_set.prev_settings).toBeNull();

    const app2 = await call(
      "POST",
      `/api/change-sets/${change_set.id}/approve`,
      {},
      { token: null, cookie },
    );
    expect(app2.status).toBe(200);
    const body = (await app2.json()) as {
      change_set: {
        status: string;
        prev_settings: {
          charter: { theme: string; tone: string };
          policy: { pacing: string };
        } | null;
      };
    };
    expect(body.change_set.status).toBe("applied");
    expect(body.change_set.prev_settings).not.toBeNull();
    expect(body.change_set.prev_settings!.charter).toEqual({
      theme: "駅",
      tone: "静か",
    });
    expect(body.change_set.prev_settings!.policy).toEqual({ pacing: "slow" });

    // 変更タブの一覧にも出る
    const list = await call("GET", `/api/works/${workId}/changes`, undefined, {
      token: null,
      cookie,
    });
    const { change_sets } = (await list.json()) as {
      change_sets: { id: string; prev_settings: unknown }[];
    };
    const found = change_sets.find((c) => c.id === change_set.id);
    expect(found?.prev_settings).toEqual({
      charter: { theme: "駅", tone: "静か" },
      policy: { pacing: "slow" },
    });
  });

  it("charter/policy を触らない変更セットでは prev_settings は null", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);

    const res = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      title: "ジャンルだけ変更",
      ops: [{ op: "update_work", patch: { genre: "ファンタジー" } }],
    });
    const { change_set } = (await res.json()) as {
      change_set: { id: string };
    };
    const app2 = await call(
      "POST",
      `/api/change-sets/${change_set.id}/approve`,
      {},
      { token: null, cookie },
    );
    const body = (await app2.json()) as {
      change_set: { prev_settings: unknown };
    };
    expect(body.change_set.prev_settings).toBeNull();
  });
});
