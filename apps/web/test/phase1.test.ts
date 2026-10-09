import { beforeEach, describe, expect, it } from "vitest";
import type { FetchHandler } from "../src/app.js";
import { devLogin, makeApp, makeCall, signUp } from "./helpers.js";

/**
 * Phase 1a のユーザー向け導線: dev-login → キー管理 → 作品作成 →
 * メッセージ送信 → orchestrator_turn エンキュー。
 */

let app: FetchHandler;
let call: ReturnType<typeof makeCall>;

beforeEach(() => {
  const m = makeApp();
  app = m.app;
  call = makeCall(app);
});

type KeyPub = { id: string; label: string; provider: string };
type JobLite = { id: string; kind: string; user_ref: string | null };
type MsgLite = { id: string; role: string; content: string };

describe("dev-login", () => {
  it("ワンクリックログインでセッションが発行される", async () => {
    const cookie = await devLogin(call);
    const me = await call("GET", "/api/me", undefined, {
      token: null,
      cookie,
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      user: { email: string; name: string };
    };
    expect(body.user.email).toBe("dev@houchi-sakka.local");
    expect(body.user.name).toBe("開発ユーザー");
  });

  it("2回目も同じユーザーでログインできる", async () => {
    const c1 = await devLogin(call);
    const c2 = await devLogin(call);
    const me1 = (
      (await (
        await call("GET", "/api/me", undefined, { token: null, cookie: c1 })
      ).json()) as { user: { id: string } }
    ).user;
    const me2 = (
      (await (
        await call("GET", "/api/me", undefined, { token: null, cookie: c2 })
      ).json()) as { user: { id: string } }
    ).user;
    expect(me1.id).toBe(me2.id);
  });
});

describe("キー管理 (ユーザー向け)", () => {
  it("登録 → 一覧 (平文は返らない) → 削除", async () => {
    const cookie = await devLogin(call);

    const created = await call(
      "POST",
      "/api/keys",
      { provider: "openai", label: "メイン", api_key: "sk-live-123" },
      { token: null, cookie },
    );
    expect(created.status).toBe(201);
    const { key } = (await created.json()) as { key: KeyPub };
    expect(key.provider).toBe("openai");
    expect((key as Record<string, unknown>).ciphertext).toBeUndefined();
    expect(JSON.stringify(key)).not.toContain("sk-live-123");

    const list = await call("GET", "/api/keys", undefined, {
      token: null,
      cookie,
    });
    const { keys } = (await list.json()) as { keys: KeyPub[] };
    expect(keys).toHaveLength(1);
    expect(JSON.stringify(keys)).not.toContain("sk-live-123");

    const del = await call("DELETE", `/api/keys/${key.id}`, undefined, {
      token: null,
      cookie,
    });
    expect(del.status).toBe(200);
    const list2 = await call("GET", "/api/keys", undefined, {
      token: null,
      cookie,
    });
    expect(((await list2.json()) as { keys: unknown[] }).keys).toHaveLength(
      0,
    );
  });

  it("他人のキーは見えない・消せない", async () => {
    const alice = await signUp(call, "alice@example.com", "Alice");
    const bob = await signUp(call, "bob@example.com", "Bob");

    const created = await call(
      "POST",
      "/api/keys",
      { provider: "anthropic", label: "a-key", api_key: "sk-ant-x" },
      { token: null, cookie: alice },
    );
    const { key } = (await created.json()) as { key: KeyPub };

    const bobList = (
      (await (
        await call("GET", "/api/keys", undefined, {
          token: null,
          cookie: bob,
        })
      ).json()) as { keys: KeyPub[] }
    ).keys;
    expect(bobList).toHaveLength(0);

    const del = await call("DELETE", `/api/keys/${key.id}`, undefined, {
      token: null,
      cookie: bob,
    });
    expect(del.status).toBe(404);
  });
});

describe("作品 + 対話", () => {
  async function makeWork(cookie: string, title = "テスト作品") {
    const res = await call(
      "POST",
      "/api/works",
      { title, premise: "前書き" },
      { token: null, cookie },
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as {
      work: { id: string; status: string };
    }).work;
  }

  it("作品作成でスレッドに案内メッセージが入る", async () => {
    const cookie = await devLogin(call);
    const work = await makeWork(cookie);
    expect(work.status).toBe("setup");

    const detail = await call("GET", `/api/works/${work.id}`, undefined, {
      token: null,
      cookie,
    });
    const body = (await detail.json()) as {
      work: { status: string };
      messages: MsgLite[];
      active_job: null;
    };
    expect(body.work.status).toBe("setup");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.role).toBe("assistant");
  });

  it("他人の作品は 404", async () => {
    const alice = await signUp(call, "a@example.com");
    const bob = await signUp(call, "b@example.com");
    const work = await makeWork(alice);
    const res = await call("GET", `/api/works/${work.id}`, undefined, {
      token: null,
      cookie: bob,
    });
    expect(res.status).toBe(404);
  });

  it("キー未登録で送信すると 400", async () => {
    const cookie = await devLogin(call);
    const work = await makeWork(cookie);
    const res = await call(
      "POST",
      `/api/works/${work.id}/messages`,
      { content: "よろしく" },
      { token: null, cookie },
    );
    expect(res.status).toBe(400);
  });

  it("送信 → orchestrator_turn がキューに積まれ status が active になる", async () => {
    const cookie = await devLogin(call);
    await call(
      "POST",
      "/api/keys",
      { provider: "openai", label: "k", api_key: "sk-x" },
      { token: null, cookie },
    );
    const work = await makeWork(cookie);

    const res = await call(
      "POST",
      `/api/works/${work.id}/messages`,
      { content: "ファンタジーにしたい" },
      { token: null, cookie },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      message: MsgLite;
      job: JobLite;
    };
    expect(body.message.role).toBe("user");
    expect(body.job.kind).toBe("orchestrator_turn");
    expect(body.job.user_ref).not.toBeNull();

    const detail = await call("GET", `/api/works/${work.id}`, undefined, {
      token: null,
      cookie,
    });
    const d = (await detail.json()) as {
      work: { status: string };
      messages: MsgLite[];
      active_job: { job: JobLite } | null;
    };
    expect(d.work.status).toBe("active");
    expect(d.messages.at(-1)!.content).toBe("ファンタジーにしたい");
    expect(d.active_job?.job.id).toBe(body.job.id);
  });

  it("他人の作品には送信できない", async () => {
    const alice = await signUp(call, "a@example.com");
    const bob = await signUp(call, "b@example.com");
    await call(
      "POST",
      "/api/keys",
      { provider: "openai", label: "k", api_key: "sk-x" },
      { token: null, cookie: bob },
    );
    const work = await makeWork(alice);
    const res = await call(
      "POST",
      `/api/works/${work.id}/messages`,
      { content: "x" },
      { token: null, cookie: bob },
    );
    expect(res.status).toBe(404);
  });
});
