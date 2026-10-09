import { describe, expect, it } from "vitest";
import {
  AgentJobSchema,
  CreateJobRequestSchema,
  HeartbeatRequestSchema,
  ProviderResponseSchema,
  SmokeGeneratePayloadSchema,
} from "../src/index.js";

describe("contracts", () => {
  it("AgentJob を parse できる", () => {
    const job = AgentJobSchema.parse({
      id: "j1",
      kind: "smoke_generate",
      work_ref: null,
      payload: {},
      idempotency_key: "k1",
      status: "queued",
      leased_by: null,
      lease_token: null,
      lease_expires_at: null,
      attempts: 0,
      result: null,
      error: null,
      created_at: 1,
      updated_at: 1,
    });
    expect(job.status).toBe("queued");
  });

  it("不正な status を拒否する", () => {
    expect(() =>
      AgentJobSchema.parse({
        id: "j1",
        kind: "x",
        work_ref: null,
        payload: {},
        idempotency_key: "k",
        status: "bogus",
        leased_by: null,
        lease_token: null,
        lease_expires_at: null,
        attempts: 0,
        result: null,
        error: null,
        created_at: 1,
        updated_at: 1,
      }),
    ).toThrow();
  });

  it("CreateJobRequest は work_ref 省略可", () => {
    const req = CreateJobRequestSchema.parse({
      kind: "smoke_generate",
      payload: { model: "gpt-5" },
      idempotency_key: "idem-1",
    });
    expect(req.work_ref).toBeUndefined();
  });

  it("ProviderResponse の usage は 'unknown' を許容する", () => {
    expect(
      ProviderResponseSchema.parse({ output_text: "a", usage: "unknown" })
        .usage,
    ).toBe("unknown");
  });

  it("smoke_generate payload: checkpoint は任意", () => {
    const p = SmokeGeneratePayloadSchema.parse({
      model: "gpt-5",
      input: [{ role: "user", content: "hi" }],
    });
    expect(p.checkpoint).toBeUndefined();
  });

  it("HeartbeatRequest は checkpoint を持てる", () => {
    const h = HeartbeatRequestSchema.parse({
      lease_token: "t",
      checkpoint: { provider_result: { output_text: "x", usage: "unknown" } },
    });
    const pr = h.checkpoint?.provider_result as { output_text: string };
    expect(pr.output_text).toBe("x");
  });
});
