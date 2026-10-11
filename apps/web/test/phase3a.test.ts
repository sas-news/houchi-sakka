import { describe, expect, it } from "vitest";
import { textToTiptapDoc } from "@houchi/contracts";
import { devLogin, makeApp, makeCall, signUp } from "./helpers.js";

/**
 * Phase 3a: 公開リリース (話単位の不変スナップショット) + 読者 API。
 * - content_json は発行時点で凍結される (後の改稿で変わらない)
 * - rev_no は話ごとの連番
 * - unlist で読者 API が 404
 * - 公開 API は正典/ユーザー情報/下書きを返さない (spec P9)
 * - owner 以外は発行不可
 */

type Call = ReturnType<typeof makeCall>;

async function setupWork(call: Call) {
  const cookie = await devLogin(call);
  const workRes = await call(
    "POST",
    "/api/works",
    { title: "公開テスト作品" },
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

/** 計画提案の承認で 1話1シーンを作る。episodeId/sceneId を返す。 */
async function seedEpisode(
  call: Call,
  cookie: string,
  workId: string,
  threadId: string,
  messageId: string,
  epTitle = "第一話",
  sceneTitle = "廃線ホーム",
) {
  const propRes = await call("POST", "/api/internal/proposals", {
    work_id: workId,
    thread_id: threadId,
    message_id: messageId,
    kind: "plan",
    payload: {
      episodes: [{ title: epTitle, scenes: [{ title: sceneTitle, purpose: "導入" }] }],
    },
  });
  const { proposal } = (await propRes.json()) as { proposal: { id: string } };
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
  return { episodeId: episodes[0]!.id, sceneId: scenes[0]!.id };
}

/** 内部 API でシーン本文リビジョンを 1 件永続化する。 */
async function persistProse(call: Call, sceneId: string, text: string) {
  const res = await call("POST", `/api/internal/scenes/${sceneId}/revisions`, {
    content_json: textToTiptapDoc(text),
    source: "ai",
    job_id: null,
  });
  if (!res.ok) throw new Error(`persist revision failed: ${res.status}`);
}

async function publish(call: Call, cookie: string, workId: string, episodeId: string) {
  const res = await call(
    "POST",
    `/api/works/${workId}/episodes/${episodeId}/releases`,
    undefined,
    { token: null, cookie },
  );
  return res;
}

describe("Phase 3a: 公開リリース", () => {
  it("公開するとスナップショットが凍結され、後の改稿で変わらない", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);
    const { episodeId, sceneId } = await seedEpisode(call, cookie, workId, threadId, messageId);
    await persistProse(call, sceneId, "第一稿の本文。汽車は止まった。");

    const res = await publish(call, cookie, workId, episodeId);
    expect(res.status).toBe(201);
    const { release } = (await res.json()) as {
      release: { id: string; rev_no: number; status: string; content: { prose_md: string }[] };
    };
    expect(release.rev_no).toBe(1);
    expect(release.status).toBe("published");
    expect(release.content[0]!.prose_md).toContain("汽車は止まった");

    // 後からシーンを改稿しても公開版は変わらない (不変スナップショット)
    await call("POST", `/api/scenes/${sceneId}/revisions`, { text: "第二稿。汽車は動き出した。" }, { token: null, cookie });
    const pub = await call("GET", `/api/r/${release.id}`, undefined, { token: null });
    expect(pub.status).toBe(200);
    const { release: pubRelease } = (await pub.json()) as {
      release: { title: string; work_title: string; scenes: { prose_md: string }[] };
    };
    expect(pubRelease.scenes[0]!.prose_md).toContain("汽車は止まった");
    expect(pubRelease.scenes[0]!.prose_md).not.toContain("動き出した");
    expect(pubRelease.work_title).toBe("公開テスト作品");
    expect(pubRelease.title).toBe("第一話");
  });

  it("rev_no は話ごとの連番で、再公開で +1 される", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);
    const { episodeId, sceneId } = await seedEpisode(call, cookie, workId, threadId, messageId);
    await persistProse(call, sceneId, "初稿");

    const r1 = await publish(call, cookie, workId, episodeId);
    expect(((await r1.json()) as { release: { rev_no: number } }).release.rev_no).toBe(1);
    await call("POST", `/api/scenes/${sceneId}/revisions`, { text: "改稿" }, { token: null, cookie });
    const r2 = await publish(call, cookie, workId, episodeId);
    const rel2 = (await r2.json()) as { release: { rev_no: number; content: { prose_md: string }[] } };
    expect(rel2.release.rev_no).toBe(2);
    expect(rel2.release.content[0]!.prose_md).toBe("改稿");
    // 別の話は独立した連番 (別作品の話を公開して rev_no=1)
    const w2 = await setupWork(call);
    const ep2 = await seedEpisode(call, w2.cookie, w2.workId, w2.threadId, w2.messageId);
    await persistProse(call, ep2.sceneId, "別の話の本文");
    const r3 = await publish(call, w2.cookie, w2.workId, ep2.episodeId);
    expect(((await r3.json()) as { release: { rev_no: number } }).release.rev_no).toBe(1);
  });

  it("本文が無い話は公開できない (400)", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);
    const { episodeId } = await seedEpisode(call, cookie, workId, threadId, messageId);
    const res = await publish(call, cookie, workId, episodeId);
    expect(res.status).toBe(400);
  });

  it("unlist で読者 API が 404、一覧でも取り下げ済みになる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);
    const { episodeId, sceneId } = await seedEpisode(call, cookie, workId, threadId, messageId);
    await persistProse(call, sceneId, "本文");
    const { release } = (await (
      await publish(call, cookie, workId, episodeId)
    ).json()) as { release: { id: string } };

    // 公開中は未ログインでも読める
    expect((await call("GET", `/api/r/${release.id}`, undefined, { token: null })).status).toBe(200);

    const un = await call("POST", `/api/releases/${release.id}/unlist`, undefined, {
      token: null,
      cookie,
    });
    expect(un.status).toBe(200);
    expect(((await un.json()) as { release: { status: string } }).release.status).toBe("unlisted");

    // 未ログイン・ログインどちらでも読めなくなる
    expect((await call("GET", `/api/r/${release.id}`, undefined, { token: null })).status).toBe(404);
    expect((await call("GET", `/api/r/${release.id}`, undefined, { token: null, cookie })).status).toBe(404);
    // 冪等: 2回目も 200
    expect(
      (await call("POST", `/api/releases/${release.id}/unlist`, undefined, { token: null, cookie })).status,
    ).toBe(200);
  });

  it("公開 API は正典・ユーザー情報・下書きを返さない (P9)", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);
    await call("POST", `/api/internal/works/${workId}/canon-facts`, {
      statements: ["秘密の正典情報"],
      provenance: "test",
    });
    const { episodeId, sceneId } = await seedEpisode(call, cookie, workId, threadId, messageId);
    await persistProse(call, sceneId, "公開する本文");
    const { release } = (await (
      await publish(call, cookie, workId, episodeId)
    ).json()) as { release: { id: string } };

    const res = await call("GET", `/api/r/${release.id}`, undefined, { token: null });
    const body = (await res.json()) as { release: Record<string, unknown> };
    const keys = JSON.stringify(Object.keys(body.release).sort());
    // 読者向けフィールドだけを含む
    expect(keys).toBe(
      JSON.stringify(["id", "published_at", "rev_no", "scenes", "title", "work_title"]),
    );
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("秘密の正典情報");
    expect(raw).not.toContain("canon_rev");
    expect(raw).not.toContain("owner_ref");
    expect(raw).not.toContain("dev@houchi-sakka.local");
  });

  it("owner 以外はリリースを発行・一覧・取り下げできない", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);
    const { episodeId, sceneId } = await seedEpisode(call, cookie, workId, threadId, messageId);
    await persistProse(call, sceneId, "本文");
    const { release } = (await (
      await publish(call, cookie, workId, episodeId)
    ).json()) as { release: { id: string } };

    const other = await signUp(call, "other@example.com");
    expect(
      (await call("POST", `/api/works/${workId}/episodes/${episodeId}/releases`, undefined, { token: null, cookie: other })).status,
    ).toBe(404);
    expect(
      (await call("GET", `/api/works/${workId}/releases`, undefined, { token: null, cookie: other })).status,
    ).toBe(404);
    expect(
      (await call("POST", `/api/releases/${release.id}/unlist`, undefined, { token: null, cookie: other })).status,
    ).toBe(404);
    // 一覧は owner には見える
    const list = await call("GET", `/api/works/${workId}/releases`, undefined, { token: null, cookie });
    expect(list.status).toBe(200);
    const { episodes, releases } = (await list.json()) as {
      episodes: { id: string; has_prose: boolean; dirty: boolean }[];
      releases: { id: string; status: string }[];
    };
    expect(releases).toHaveLength(1);
    expect(episodes[0]!.has_prose).toBe(true);
    expect(episodes[0]!.dirty).toBe(false);
  });

  it("一覧の dirty が「最新公開以降の本文変更」を検出する", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);
    const { episodeId, sceneId } = await seedEpisode(call, cookie, workId, threadId, messageId);
    await persistProse(call, sceneId, "初稿");
    await publish(call, cookie, workId, episodeId);

    const list1 = (await (
      await call("GET", `/api/works/${workId}/releases`, undefined, { token: null, cookie })
    ).json()) as { episodes: { dirty: boolean }[] };
    expect(list1.episodes[0]!.dirty).toBe(false);

    await call("POST", `/api/scenes/${sceneId}/revisions`, { text: "改稿後" }, { token: null, cookie });
    const list2 = (await (
      await call("GET", `/api/works/${workId}/releases`, undefined, { token: null, cookie })
    ).json()) as { episodes: { dirty: boolean }[] };
    expect(list2.episodes[0]!.dirty).toBe(true);
  });
});
