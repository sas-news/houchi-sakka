import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentJob } from "@houchi/contracts";
import { StubProvider } from "@houchi/providers";
import type { SkillDefinition } from "@houchi/skills";
import { extractJson, runSkillStep } from "../src/skills.js";
import type { JobContext } from "../src/index.js";

const JOB: AgentJob = {
  id: "j1",
  kind: "plan_work",
  work_ref: "w1",
  user_ref: "u1",
  payload: {},
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

const skill: SkillDefinition<{ x: number }, { ok: boolean }> = {
  name: "test-skill",
  description: "test",
  tools: [],
  buildPrompt: (input) => [
    { role: "system", content: `x=${input.x}` },
  ],
  outputSchema: z.object({ ok: z.boolean() }),
};

function makeCtx(provider: StubProvider) {
  const notes: unknown[] = [];
  const ctx: JobContext = {
    resolveKey: async () => "key",
    getProvider: () => provider,
    postProgress: async (type, data) => {
      notes.push({ type, data });
    },
    saveCheckpoint: async () => {},
    complete: async () => {},
    fail: async () => {},
  };
  return { ctx, notes };
}

describe("extractJson", () => {
  it("プレーンテキスト中の JSON を切り出す", () => {
    expect(extractJson('前振り {"a":1} 後文')).toBe('{"a":1}');
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson("no json")).toBeNull();
  });
});

describe("runSkillStep", () => {
  it("有効な JSON なら検証済み出力を返す", async () => {
    const provider = new StubProvider({ text: '{"ok": true}' });
    const { ctx } = makeCtx(provider);
    const out = await runSkillStep(ctx, {
      job: JOB,
      skill,
      input: { x: 1 },
      model: "m",
      providerName: "stub",
      keyRef: undefined,
      step: "write",
    });
    expect(out).toEqual({ ok: true });
    expect(provider.calls).toBe(1);
  });

  it("パース失敗→修正要求リトライ (1回のみ)", async () => {
    let n = 0;
    const provider = new StubProvider({
      respond: () => {
        n += 1;
        return n === 1 ? "not json at all" : '{"ok": true}';
      },
    });
    const { ctx, notes } = makeCtx(provider);
    const out = await runSkillStep(ctx, {
      job: JOB,
      skill,
      input: { x: 1 },
      model: "m",
      providerName: "stub",
      keyRef: undefined,
      step: "write",
    });
    expect(out).toEqual({ ok: true });
    expect(provider.calls).toBe(2);
    // リトライ要求は入力メッセージに追加されている
    const retryInput = provider.lastRequests.at(-1)!.input;
    expect(retryInput.at(-1)!.content).toContain("スキーマに合いません");
    expect(
      notes.some(
        (n2) =>
          (n2 as { type: string; data: { step?: string } }).type === "note" &&
          (n2 as { data: { step: string } }).data.step === "write_retry",
      ),
    ).toBe(true);
  });

  it("リトライでも失敗したらエラーになる", async () => {
    const provider = new StubProvider({ text: "still broken" });
    const { ctx } = makeCtx(provider);
    await expect(
      runSkillStep(ctx, {
        job: JOB,
        skill,
        input: { x: 1 },
        model: "m",
        providerName: "stub",
        keyRef: undefined,
        step: "write",
      }),
    ).rejects.toThrow("parse failed after retry");
    expect(provider.calls).toBe(2);
  });

  it("フェンス付き JSON も検証できる", async () => {
    const provider = new StubProvider({
      text: '出力です:\n```json\n{"ok": true}\n```',
    });
    const { ctx } = makeCtx(provider);
    const out = await runSkillStep(ctx, {
      job: JOB,
      skill,
      input: { x: 0 },
      model: "m",
      providerName: "stub",
      keyRef: undefined,
      step: "critique",
    });
    expect(out).toEqual({ ok: true });
  });
});
