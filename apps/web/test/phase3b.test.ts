import { describe, expect, it } from "vitest";
import { textToTiptapDoc } from "@houchi/contracts";
import { diffParagraphs } from "../app/lib/diff.js";
import { devLogin, makeApp, makeCall } from "./helpers.js";

/**
 * Phase 3b: 読者向け作品ページ /w/:id の公開目次 API + リビジョン差分。
 * - /api/w/:id は published の話だけを最新版+版数つきで返す
 * - published が 1 件も無い作品は 404 (存在自体を出さない)
 * - 正典・下書き・ユーザー情報・canon_rev を返さない (spec P9)
 * - diffParagraphs は段落=行単位の差分を返す (same/added/removed)
 */

type Call = ReturnType<typeof makeCall>;

async function setupWork(call: Call) {
  const cookie = await devLogin(call);
  const workRes = await call(
    "POST",
    "/api/works",
    { title: "目次テスト作品", premise: "停まった鉄道の町で起きる話" },
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

/** 計画提案の承認で episode/scene を作る (message_id+kind 一意なので複数話は1提案にまとめる)。 */
async function seedEpisodes(
  call: Call,
  cookie: string,
  workId: string,
  threadId: string,
  messageId: string,
  specs: { epTitle: string; sceneTitle: string }[],
) {
  const propRes = await call("POST", "/api/internal/proposals", {
    work_id: workId,
    thread_id: threadId,
    message_id: messageId,
    kind: "plan",
    payload: {
      episodes: specs.map((s) => ({
        title: s.epTitle,
        scenes: [{ title: s.sceneTitle, purpose: "導入" }],
      })),
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
  return specs.map((_, i) => ({
    episodeId: episodes[i]!.id,
    sceneId: scenes[i]!.id,
  }));
}

async function persistProse(call: Call, sceneId: string, text: string) {
  const res = await call("POST", `/api/internal/scenes/${sceneId}/revisions`, {
    content_json: textToTiptapDoc(text),
    source: "ai",
    job_id: null,
  });
  if (!res.ok) throw new Error(`persist revision failed: ${res.status}`);
}

async function publish(call: Call, cookie: string, workId: string, episodeId: string) {
  return call(
    "POST",
    `/api/works/${workId}/episodes/${episodeId}/releases`,
    undefined,
    { token: null, cookie },
  );
}

interface PublicWorkBody {
  work: Record<string, unknown>;
  episodes: Record<string, unknown>[];
}

describe("Phase 3b: 読者向け作品目次 /api/w/:id", () => {
  it("published の話を最新版+版数つきで返す (ログイン不要)", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);
    const eps = await seedEpisodes(call, cookie, workId, threadId, messageId, [
      { epTitle: "第一話", sceneTitle: "廃線ホーム" },
      { epTitle: "第二話", sceneTitle: "站台" },
    ]);
    const ep1 = eps[0]!;
    const ep2 = eps[1]!;
    await persistProse(call, ep1.sceneId, "第一話の本文。汽車は止まった。");
    await persistProse(call, ep2.sceneId, "第二話の本文。");

    // 第一話を2版公開 (新版だけが一覧に出る)
    await publish(call, cookie, workId, ep1.episodeId);
    await call("POST", `/api/scenes/${ep1.sceneId}/revisions`, { text: "改稿した第一話。" }, { token: null, cookie });
    const r2 = await publish(call, cookie, workId, ep1.episodeId);
    const rel2 = (await r2.json()) as { release: { id: string; rev_no: number } };
    await publish(call, cookie, workId, ep2.episodeId);

    const res = await call("GET", `/api/w/${workId}`, undefined, { token: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublicWorkBody;
    expect(body.work).toEqual({
      id: workId,
      title: "目次テスト作品",
      premise: "停まった鉄道の町で起きる話",
    });
    expect(body.episodes).toHaveLength(2);
    const [e1, e2] = body.episodes;
    expect(e1).toEqual({
      episode_id: ep1.episodeId,
      ord: 1,
      title: "第一話",
      version_count: 2,
      release_id: rel2.release.id,
      rev_no: 2,
      published_at: expect.any(Number),
    });
    expect(e2).toMatchObject({ ord: 2, rev_no: 1, version_count: 1 });
  });

  it("公開 API は正典・ユーザー情報・canon_rev・本文を返さない (P9)", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);
    await call("POST", `/api/internal/works/${workId}/canon-facts`, {
      statements: ["秘密の正典情報"],
      provenance: "test",
    });
    const { episodeId, sceneId } = (
      await seedEpisodes(call, cookie, workId, threadId, messageId, [
        { epTitle: "第一話", sceneTitle: "廃線ホーム" },
      ])
    )[0]!;
    await persistProse(call, sceneId, "公開する本文");
    await publish(call, cookie, workId, episodeId);

    const res = await call("GET", `/api/w/${workId}`, undefined, { token: null });
    const body = (await res.json()) as PublicWorkBody;
    expect(Object.keys(body.work).sort()).toEqual(["id", "premise", "title"]);
    expect(Object.keys(body.episodes[0]!).sort()).toEqual([
      "episode_id",
      "ord",
      "published_at",
      "release_id",
      "rev_no",
      "title",
      "version_count",
    ]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("秘密の正典情報");
    expect(raw).not.toContain("公開する本文");
    expect(raw).not.toContain("canon_rev");
    expect(raw).not.toContain("owner_ref");
    expect(raw).not.toContain("dev@houchi-sakka.local");
  });

  it("published が無い作品は 404 (存在自体を出さない)", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);
    // 話も本文もあるが未公開 → 404
    const { episodeId, sceneId } = (
      await seedEpisodes(call, cookie, workId, threadId, messageId, [
        { epTitle: "第一話", sceneTitle: "廃線ホーム" },
      ])
    )[0]!;
    await persistProse(call, sceneId, "未公開の本文");
    expect((await call("GET", `/api/w/${workId}`, undefined, { token: null })).status).toBe(404);
    // 取り下げただけの作品も 404
    const { release } = (await (
      await publish(call, cookie, workId, episodeId)
    ).json()) as { release: { id: string } };
    await call("POST", `/api/releases/${release.id}/unlist`, undefined, { token: null, cookie });
    expect((await call("GET", `/api/w/${workId}`, undefined, { token: null })).status).toBe(404);
    // 存在しない作品も 404
    expect((await call("GET", "/api/w/no-such-work", undefined, { token: null })).status).toBe(404);
  });

  it("published の無い話は一覧に出ない", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, threadId, messageId } = await setupWork(call);
    const eps = await seedEpisodes(call, cookie, workId, threadId, messageId, [
      { epTitle: "第一話", sceneTitle: "廃線ホーム" },
      { epTitle: "第二話", sceneTitle: "站台" },
    ]);
    const ep1 = eps[0]!;
    const ep2 = eps[1]!;
    await persistProse(call, ep1.sceneId, "第一話の本文");
    await persistProse(call, ep2.sceneId, "第二話の本文");
    // 第二話だけ公開
    await publish(call, cookie, workId, ep2.episodeId);

    const res = await call("GET", `/api/w/${workId}`, undefined, { token: null });
    const body = (await res.json()) as PublicWorkBody;
    expect(body.episodes).toHaveLength(1);
    expect(body.episodes[0]).toMatchObject({ ord: 2, title: "第二話" });
  });
});

describe("Phase 3b: リビジョン差分 diffParagraphs", () => {
  it("同じ段落列は差分なし (全行 same)", () => {
    const rows = diffParagraphs(["春の朝。", "汽車は止まった。"], ["春の朝。", "汽車は止まった。"]);
    expect(rows.every((r) => r.kind === "same")).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("行の追加を added として検出する", () => {
    const rows = diffParagraphs(["一行目。"], ["一行目。", "二行目を足した。"]);
    expect(rows).toEqual([
      { kind: "same", text: "一行目。" },
      { kind: "added", text: "二行目を足した。" },
    ]);
  });

  it("行の削除を removed として検出し、書き換えは 削除+追加 になる", () => {
    const rows = diffParagraphs(
      ["導入。", "汽車は止まった。", "結び。"],
      ["導入。", "汽車は動き出した。", "結び。"],
    );
    expect(rows.map((r) => r.kind)).toEqual(["same", "removed", "added", "same"]);
    expect(rows[1]!.text).toBe("汽車は止まった。");
    expect(rows[2]!.text).toBe("汽車は動き出した。");
  });

  it("空の段落列どうしは空を返す", () => {
    expect(diffParagraphs([], [])).toEqual([]);
  });
});
