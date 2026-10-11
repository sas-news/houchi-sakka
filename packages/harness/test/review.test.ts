import { describe, expect, it } from "vitest";
import {
  JOB_KIND_REVIEW_CHANGE,
  type AgentJob,
  type ChangeSetWithFindings,
  type ReviewFinding,
  type Work,
} from "@houchi/contracts";
import { StubProvider } from "@houchi/providers";
import { runJob, type JobContext } from "../src/index.js";

const WORK: Work = {
  id: "w1",
  owner_ref: "u1",
  title: "テスト作品",
  premise: "前提",
  genre: "ファンタジー",
  status: "active",
  charter: null,
  policy: null,
  provider: null,
  model: null,
  key_ref: null,
  canon_rev: 1,
  created_at: 0,
  updated_at: 0,
};

const CHANGE_SET: ChangeSetWithFindings = {
  id: "cs1",
  work_id: "w1",
  message_id: "m1",
  kind: "normal",
  title: "汽車の設定変更",
  description: "汽車は週1だけ走っている",
  ops: [
    {
      op: "revise_fact",
      fact_id: "f1",
      new_statement: "汽車は週1だけ走っている",
    },
  ],
  status: "applied",
  impact: {
    scenes: [{ id: "s1", title: "廃線ホーム", reason: "依存" }],
    facts: [],
    contracts: [],
    summary: "シーン 1件",
  },
  force: 0,
  findings: [],
  created_at: 0,
  decided_at: 1,
  applied_at: 1,
};

function makeJob(payload: Record<string, unknown>): AgentJob {
  return {
    id: "j1",
    kind: JOB_KIND_REVIEW_CHANGE,
    work_ref: "w1",
    user_ref: "u1",
    payload,
    idempotency_key: "k",
    status: "leased",
    leased_by: "ex",
    lease_token: "t",
    lease_expires_at: Date.now() + 60_000,
    attempts: 1,
    result: null,
    error: null,
    created_at: 0,
    updated_at: 0,
  };
}

const PAYLOAD = {
  change_set_id: "cs1",
  work_id: "w1",
  user_ref: "u1",
  key_ref: "key-1",
  provider: "stub",
  model: "stub-model",
};

function makeCtx(opts: {
  provider: StubProvider;
  findings: { change_set_id: string; findings: unknown[] }[];
  messages: { role: string; content: string }[];
}): JobContext {
  const progressCalls: string[] = [];
  void progressCalls;
  return {
    resolveKey: async () => "sk-test",
    getProvider: () => opts.provider,
    postProgress: async () => {},
    saveCheckpoint: async () => {},
    fetchChangeSetContext: async () => ({
      change_set: CHANGE_SET,
      work: WORK,
      thread_id: "t1",
      canon_facts: [
        {
          id: "f2",
          work_id: "w1",
          statement: "汽車は週1だけ走っている",
          provenance: "changeset:cs1",
          valid_from_rev: 1,
          valid_to_rev: null,
          created_at: 1,
        },
      ],
      scenes: [
        {
          id: "s1",
          title: "廃線ホーム",
          prose_md: "彼女は濡れた切符を眺めた。もう戻る汽車は来ない。",
          contract: null,
        },
      ],
    }),
    recordReviewFindings: async (req) => {
      opts.findings.push(req);
      return { added: req.findings.length };
    },
    persistChatMessage: async (req) => {
      opts.messages.push(req);
      return {
        id: "msg-review",
        thread_id: req.thread_id,
        role: req.role,
        content: req.content,
        job_id: req.job_id ?? null,
        created_at: Date.now(),
      };
    },
    complete: async () => {},
    fail: async () => {
      throw new Error("job failed");
    },
  };
}

describe("review_change ジョブ", () => {
  it("影響シーンを critic で検査し findings を記録して報告する", async () => {
    const provider = new StubProvider({
      respond: () =>
        JSON.stringify({
          violations: [
            {
              rule: "canon",
              detail: "「もう戻る汽車は来ない」は新正典と矛盾",
              severity: "high",
            },
          ],
          notes: ["正典リビジョン適用後の検査"],
        }),
    });
    const findings: { change_set_id: string; findings: unknown[] }[] = [];
    const messages: { role: string; content: string }[] = [];
    const ctx = makeCtx({ provider, findings, messages });

    expect(await runJob(makeJob({ ...PAYLOAD }), ctx)).toBe("completed");
    expect(provider.calls).toBe(1);

    // conflict + info の findings が記録される
    expect(findings).toHaveLength(1);
    expect(findings[0]!.change_set_id).toBe("cs1");
    const recorded = findings[0]!.findings as {
      kind: string;
      severity: string;
      summary: string;
      scene_id: string;
    }[];
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      kind: "conflict",
      severity: "high",
      scene_id: "s1",
    });
    expect(recorded[1]).toMatchObject({ kind: "info", severity: "low" });

    // 報告メッセージがスレッドに投稿される
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain("レビュー");
    expect(messages[0]!.content).toContain("1件のシーン");
  });

  it("本文のないシーンは検査をスキップする", async () => {
    const provider = new StubProvider({ text: "{}" });
    const findings: { change_set_id: string; findings: unknown[] }[] = [];
    const messages: { role: string; content: string }[] = [];
    const ctx = makeCtx({ provider, findings, messages });
    ctx.fetchChangeSetContext = async () => ({
      change_set: CHANGE_SET,
      work: WORK,
      thread_id: "t1",
      canon_facts: [],
      scenes: [{ id: "s1", title: "廃線ホーム", prose_md: "", contract: null }],
    });
    expect(await runJob(makeJob({ ...PAYLOAD }), ctx)).toBe("completed");
    expect(provider.calls).toBe(0);
    expect(findings).toHaveLength(1);
    expect((findings[0]!.findings as ReviewFinding[]).length).toBe(0);
    expect(messages[0]!.content).toContain("影響するシーンはありませんでした");
  });
});
