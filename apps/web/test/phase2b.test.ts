import { describe, expect, it } from "vitest";
import { devLogin, makeApp, makeCall } from "./helpers.js";

/**
 * Phase 2b: 変更セット + 影響分析 + 正典リビジョン時系列 +
 * review_findings + manual_edit の自動変更セット。
 */

type Call = ReturnType<typeof makeCall>;

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
  const detail = (await (
    await call("GET", `/api/works/${work.id}`, undefined, {
      token: null,
      cookie,
    })
  ).json()) as {
    thread: { id: string };
    messages: { id: string }[];
    work: { canon_rev: number };
  };
  return {
    cookie,
    workId: work.id,
    threadId: detail.thread.id,
    messageId: detail.messages[0]!.id,
  };
}

/** 正典1件 + 計画承認でシーン1件 + 依存エッジを用意する。 */
async function seedSceneWithDep(call: Call, cookie: string, workId: string) {
  // 正典
  await call("POST", `/api/internal/works/${workId}/canon-facts`, {
    statements: ["汽車はもう走っていない"],
    provenance: "test",
  });
  // 計画 → 承認でシーン作成
  const detail = (await (
    await call("GET", `/api/works/${workId}`, undefined, {
      token: null,
      cookie,
    })
  ).json()) as { thread: { id: string }; messages: { id: string }[] };
  const propRes = await call("POST", "/api/internal/proposals", {
    work_id: workId,
    thread_id: detail.thread.id,
    message_id: detail.messages[0]!.id,
    kind: "plan",
    payload: {
      episodes: [
        {
          title: "第1話",
          scenes: [{ title: "廃線ホーム", purpose: "導入" }],
        },
      ],
    },
  });
  const { proposal } = (await propRes.json()) as {
    proposal: { id: string };
  };
  await call("POST", `/api/proposals/${proposal.id}/approve`, undefined, {
    token: null,
    cookie,
  });
  const prose = (await (
    await call("GET", `/api/works/${workId}/prose`, undefined, {
      token: null,
      cookie,
    })
  ).json()) as {
    scenes: { id: string; title: string }[];
    canon_facts: { id: string; statement: string }[];
  };
  const sceneId = prose.scenes[0]!.id;
  const factId = prose.canon_facts[0]!.id;
  // 依存宣言 (writer が canon_fact に依存)
  await call("POST", `/api/internal/scenes/${sceneId}/dependencies`, {
    edges: [
      {
        target_kind: "canon_fact",
        target_ref: "汽車はもう走っていない",
      },
    ],
  });
  return { sceneId, factId };
}

describe("Phase 2b: 変更セット", () => {
  it("変更セット作成時に影響分析 (依存エッジ/文面一致) を計算する", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId, messageId } = await setupWork(call);
    const { factId } = await seedSceneWithDep(call, cookie, workId);
    // 文面が近い別正典 (名前一致検査用: 部分文字列で一致する)
    await call("POST", `/api/internal/works/${workId}/canon-facts`, {
      statements: ["汽車はもう走っていないという噂が流れている"],
      provenance: "test",
    });

    const res = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      title: "汽車の設定変更",
      description: "汽車は週1だけ走る",
      ops: [
        { op: "revise_fact", fact_id: factId, new_statement: "汽車は週1だけ走っている" },
      ],
      message_id: messageId,
    });
    expect(res.status).toBe(201);
    const { change_set } = (await res.json()) as {
      change_set: {
        id: string;
        status: string;
        impact: {
          scenes: { id: string }[];
          facts: { id: string }[];
          summary: string;
        };
      };
    };
    expect(change_set.status).toBe("proposed");
    // dependency_edges 経由でシーンが拾われる
    expect(change_set.impact.scenes.length).toBeGreaterThanOrEqual(1);
    // 文面が近い正典が拾われる
    expect(change_set.impact.facts.length).toBeGreaterThanOrEqual(1);
    expect(change_set.impact.summary.length).toBeGreaterThan(0);

    // 変更タブの一覧に出る
    const listRes = await call(
      "GET",
      `/api/works/${workId}/changes`,
      undefined,
      { token: null, cookie },
    );
    const { change_sets } = (await listRes.json()) as {
      change_sets: { id: string }[];
    };
    expect(change_sets.map((c) => c.id)).toContain(change_set.id);

    // 作品詳細 (対話パネル用) にも含まれる
    const detail = (await (
      await call("GET", `/api/works/${workId}`, undefined, {
        token: null,
        cookie,
      })
    ).json()) as { change_sets: { id: string }[] };
    expect(detail.change_sets.map((c) => c.id)).toContain(change_set.id);
  });

  it("approve で ops 適用・canon_rev 増・旧 fact 閉鎖・レビュー起票", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    const { factId } = await seedSceneWithDep(call, cookie, workId);

    const res = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      title: "汽車の設定変更",
      ops: [
        { op: "revise_fact", fact_id: factId, new_statement: "汽車は週1だけ走っている" },
        { op: "add_fact", statement: "線路の先は海につながる" },
      ],
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
    expect(app2.status).toBe(200);
    const body = (await app2.json()) as {
      change_set: { status: string };
      job: { kind: string } | null;
    };
    expect(body.change_set.status).toBe("applied");
    // review_change ジョブが自動起票される
    expect(body.job).not.toBeNull();
    expect(body.job!.kind).toBe("review_change");

    // canon_rev が 1 に、現行正典が差し替わる
    const detail = (await (
      await call("GET", `/api/works/${workId}`, undefined, {
        token: null,
        cookie,
      })
    ).json()) as { work: { canon_rev: number } };
    expect(detail.work.canon_rev).toBe(1);

    const prose = (await (
      await call("GET", `/api/works/${workId}/prose`, undefined, {
        token: null,
        cookie,
      })
    ).json()) as { canon_facts: { statement: string }[] };
    const statements = prose.canon_facts.map((f) => f.statement);
    expect(statements).toContain("汽車は週1だけ走っている");
    expect(statements).toContain("線路の先は海につながる");
    expect(statements).not.toContain("汽車はもう走っていない");
  });

  it("reject 後も force で強制適用でき kind が force_override になる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    const { factId } = await seedSceneWithDep(call, cookie, workId);

    const res = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      title: "汽車の廃止",
      ops: [{ op: "retire_fact", fact_id: factId }],
    });
    const { change_set } = (await res.json()) as {
      change_set: { id: string };
    };
    const rej = await call(
      "POST",
      `/api/change-sets/${change_set.id}/reject`,
      {},
      { token: null, cookie },
    );
    expect(rej.status).toBe(200);

    // 却下済みに通常 approve は 400
    const plain = await call(
      "POST",
      `/api/change-sets/${change_set.id}/approve`,
      {},
      { token: null, cookie },
    );
    expect(plain.status).toBe(400);

    // force=true + 理由 で強制適用 (spec §5.4: 理由の記録は必須)
    const forced = await call(
      "POST",
      `/api/change-sets/${change_set.id}/approve`,
      { force: true, reason: "却下の誤りを取り消す" },
      { token: null, cookie },
    );
    expect(forced.status).toBe(200);
    const body = (await forced.json()) as {
      change_set: { status: string; kind: string; force: boolean };
    };
    expect(body.change_set.status).toBe("applied");
    expect(body.change_set.kind).toBe("force_override");
    expect(body.change_set.force).toBe(1);
  });

  it("手編集リビジョンで kind=manual_edit の変更セットが自動生成される", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    const { sceneId } = await seedSceneWithDep(call, cookie, workId);

    const res = await call(
      "POST",
      `/api/scenes/${sceneId}/revisions`,
      { text: "手で書き直した本文。\n\n第二段落。" },
      { token: null, cookie },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      revision: { change_set_id: string | null };
      change_set: {
        id: string;
        kind: string;
        status: string;
        title: string;
      };
    };
    expect(body.change_set.kind).toBe("manual_edit");
    expect(body.change_set.status).toBe("applied");
    expect(body.revision.change_set_id).toBe(body.change_set.id);

    const listRes = await call(
      "GET",
      `/api/works/${workId}/changes`,
      undefined,
      { token: null, cookie },
    );
    const { change_sets } = (await listRes.json()) as {
      change_sets: { id: string; kind: string }[];
    };
    expect(
      change_sets.find((c) => c.id === body.change_set.id)?.kind,
    ).toBe("manual_edit");
  });

  it("kind=revision の修正セット承認で rewrite_scene が新リビジョンとして適用される", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    const { sceneId } = await seedSceneWithDep(call, cookie, workId);

    // review_change の自動提案相当: kind=revision + rewrite_scene op
    const res = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      title: "修正候補: 汽車の設定変更",
      description: "レビュー findings から自動生成",
      kind: "revision",
      ops: [
        {
          op: "rewrite_scene",
          scene_id: sceneId,
          text: "週に一度だけ戻る汽車は来る。",
        },
      ],
    });
    expect(res.status).toBe(201);
    const { change_set } = (await res.json()) as {
      change_set: {
        id: string;
        kind: string;
        impact: { scenes: { id: string }[] };
      };
    };
    expect(change_set.kind).toBe("revision");
    // 影響分析は書き換え対象シーンを拾う
    expect(change_set.impact.scenes.map((s) => s.id)).toContain(sceneId);

    const app2 = await call(
      "POST",
      `/api/change-sets/${change_set.id}/approve`,
      {},
      { token: null, cookie },
    );
    expect(app2.status).toBe(200);
    const body = (await app2.json()) as {
      change_set: { status: string };
      job: { kind: string } | null;
    };
    expect(body.change_set.status).toBe("applied");
    // 通常の適用と同じく review_change が起票される
    expect(body.job?.kind).toBe("review_change");

    // 新リビジョンが change_set_id 紐付きで保存される
    const prose = (await (
      await call("GET", `/api/works/${workId}/prose`, undefined, {
        token: null,
        cookie,
      })
    ).json()) as {
      revisions: {
        scene_id: string;
        change_set_id: string | null;
        source: string;
        content_json: unknown;
      }[];
    };
    const rev = prose.revisions.find((r) => r.change_set_id === change_set.id);
    expect(rev).toBeDefined();
    expect(rev!.scene_id).toBe(sceneId);
    expect(JSON.stringify(rev!.content_json)).toContain(
      "週に一度だけ戻る汽車は来る",
    );
  });

  it("findings の記録と dismiss/open 切替ができる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    const { factId, sceneId } = await seedSceneWithDep(call, cookie, workId);

    const res = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      title: "汽車の設定変更",
      ops: [
        { op: "revise_fact", fact_id: factId, new_statement: "汽車は週1だけ走っている" },
      ],
    });
    const { change_set } = (await res.json()) as {
      change_set: { id: string };
    };

    // review_change 相当の findings 記録
    const fRes = await call(
      "POST",
      `/api/internal/change-sets/${change_set.id}/findings`,
      {
        findings: [
          {
            kind: "conflict",
            severity: "high",
            summary: "廃線ホーム: canon",
            detail: "「汽車は来ない」が新正典と矛盾",
            scene_id: sceneId,
          },
        ],
      },
    );
    expect(fRes.status).toBe(200);
    const fBody = (await fRes.json()) as {
      findings: { id: string; status: string }[];
      added: number;
    };
    expect(fBody.added).toBe(1);
    const findingId = fBody.findings[0]!.id;
    expect(fBody.findings[0]!.status).toBe("open");

    // 変更セット詳細に findings が含まれる
    const listRes = await call(
      "GET",
      `/api/works/${workId}/changes`,
      undefined,
      { token: null, cookie },
    );
    const { change_sets } = (await listRes.json()) as {
      change_sets: { id: string; findings: { id: string }[] }[];
    };
    const cs = change_sets.find((c) => c.id === change_set.id)!;
    expect(cs.findings.map((f) => f.id)).toContain(findingId);

    // dismiss → open に戻す
    const dis = await call(
      "POST",
      `/api/review-findings/${findingId}/status`,
      { status: "dismissed" },
      { token: null, cookie },
    );
    expect(dis.status).toBe(200);
    expect(
      ((await dis.json()) as { finding: { status: string } }).finding.status,
    ).toBe("dismissed");
    const reopen = await call(
      "POST",
      `/api/review-findings/${findingId}/status`,
      { status: "open" },
      { token: null, cookie },
    );
    expect(
      ((await reopen.json()) as { finding: { status: string } }).finding.status,
    ).toBe("open");
  });

  it("/canon/facts.md は現行のみ・/canon/history.md に閉じた行が残る", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    const { factId } = await seedSceneWithDep(call, cookie, workId);

    const res = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      title: "汽車の設定変更",
      ops: [
        { op: "revise_fact", fact_id: factId, new_statement: "汽車は週1だけ走っている" },
      ],
    });
    const { change_set } = (await res.json()) as {
      change_set: { id: string };
    };
    await call("POST", `/api/change-sets/${change_set.id}/approve`, {}, {
      token: null,
      cookie,
    });

    const facts = (await (
      await call(
        "GET",
        `/api/works/${workId}/workspace/file?path=${encodeURIComponent("/canon/facts.md")}`,
        undefined,
        { token: null, cookie },
      )
    ).json()) as { content: string };
    expect(facts.content).toContain("汽車は週1だけ走っている");
    expect(facts.content).not.toContain("汽車はもう走っていない");
    expect(facts.content).toContain("改訂履歴");

    const history = (await (
      await call(
        "GET",
        `/api/works/${workId}/workspace/file?path=${encodeURIComponent("/canon/history.md")}`,
        undefined,
        { token: null, cookie },
      )
    ).json()) as { content: string };
    expect(history.content).toContain("汽車はもう走っていない");
    expect(history.content).toContain("rev");
  });
});

describe("spec gap-fill: 強制適用の理由記録・楽観的競合・キー使用数", () => {
  it("正典に触れる変更セットは canon_rev が進むと承認で競合 (409) になる", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    await seedSceneWithDep(call, cookie, workId);

    const mk = async (title: string) => {
      const res = await call("POST", `/api/internal/works/${workId}/change-sets`, {
        title,
        ops: [{ op: "add_fact", statement: `事実:${title}` }],
      });
      const { change_set } = (await res.json()) as {
        change_set: { id: string; base_rev: number | null };
      };
      return change_set;
    };
    const a = await mk("A案");
    const b = await mk("B案");
    // 提案時点の canon_rev が記録されている
    expect(a.base_rev).not.toBeNull();
    expect(b.base_rev).toBe(a.base_rev);

    const okRes = await call(
      "POST",
      `/api/change-sets/${a.id}/approve`,
      {},
      { token: null, cookie },
    );
    expect(okRes.status).toBe(200);

    // B は base_rev が古いまま → 通常承認は競合で拒否
    const conf = await call(
      "POST",
      `/api/change-sets/${b.id}/approve`,
      {},
      { token: null, cookie },
    );
    expect(conf.status).toBe(409);
    // 競合しても status は proposed のまま
    const detail = (await (
      await call("GET", `/api/works/${workId}/changes`, undefined, {
        token: null,
        cookie,
      })
    ).json()) as { change_sets: { id: string; status: string }[] };
    expect(
      detail.change_sets.find((c) => c.id === b.id)?.status,
    ).toBe("proposed");
  });

  it("強制適用は理由なしだと 400、理由付きで force_override と理由が記録される", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const { cookie, workId } = await setupWork(call);
    await seedSceneWithDep(call, cookie, workId);

    const res = await call("POST", `/api/internal/works/${workId}/change-sets`, {
      title: "強制したい変更",
      ops: [{ op: "add_fact", statement: "強制で足す事実" }],
    });
    const { change_set } = (await res.json()) as {
      change_set: { id: string };
    };

    const noReason = await call(
      "POST",
      `/api/change-sets/${change_set.id}/approve`,
      { force: true },
      { token: null, cookie },
    );
    expect(noReason.status).toBe(400);

    const forced = await call(
      "POST",
      `/api/change-sets/${change_set.id}/approve`,
      { force: true, reason: "対話を待たずに直したい" },
      { token: null, cookie },
    );
    expect(forced.status).toBe(200);
    const { change_set: applied } = (await forced.json()) as {
      change_set: {
        kind: string;
        force: number;
        force_reason: string | null;
      };
    };
    expect(applied.kind).toBe("force_override");
    expect(applied.force).toBe(1);
    expect(applied.force_reason).toBe("対話を待たずに直したい");
  });

  it("GET /api/keys は使用中の作品数 works_using を返す", async () => {
    const { app } = makeApp();
    const call = makeCall(app);
    const cookie = await devLogin(call);
    const keyRes = await call(
      "POST",
      "/api/keys",
      { label: "メイン", provider: "openai", api_key: "sk-test" },
      { token: null, cookie },
    );
    const { key } = (await keyRes.json()) as { key: { id: string } };
    const workRes = await call(
      "POST",
      "/api/works",
      { title: "キー使用中の作品" },
      { token: null, cookie },
    );
    const { work } = (await workRes.json()) as { work: { id: string } };
    const patch = await call(
      "PATCH",
      `/api/works/${work.id}/settings`,
      { key_id: key.id },
      { token: null, cookie },
    );
    expect(patch.status).toBe(200);

    const list = await call("GET", "/api/keys", undefined, {
      token: null,
      cookie,
    });
    const { keys } = (await list.json()) as {
      keys: { id: string; works_using: number }[];
    };
    expect(keys.find((k) => k.id === key.id)?.works_using).toBe(1);
  });
});
