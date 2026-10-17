import { describe, expect, it } from "vitest";
import {
  buildOrchestratorInput,
  parseOrchestratorMarkers,
  parseWorkPatch,
} from "../src/index.js";

describe("parseWorkPatch", () => {
  it("末尾の WORK_PATCH 行を取り出して本文から除く", () => {
    const { replyText, patch } = parseWorkPatch(
      'わかりました。冒険譚ですね。\n<<WORK_PATCH {"genre":"ファンタジー"}>>',
    );
    expect(replyText).toBe("わかりました。冒険譚ですね。");
    expect(patch).toEqual({ genre: "ファンタジー" });
  });

  it("パッチ行がなくても本文をそのまま返す", () => {
    const { replyText, patch } = parseWorkPatch("ただの返答です");
    expect(replyText).toBe("ただの返答です");
    expect(patch).toBeNull();
  });

  it("不正な JSON / スキーマ違反は無視し、本文にも残さない", () => {
    const bad = parseWorkPatch(
      "返答\n<<WORK_PATCH {invalid json}>>",
    );
    expect(bad.patch).toBeNull();
    expect(bad.replyText).toBe("返答");

    const badStatus = parseWorkPatch(
      '返答\n<<WORK_PATCH {"status":"bogus"}>>',
    );
    expect(badStatus.patch).toBeNull();
    expect(badStatus.replyText).toBe("返答");
  });

  it("途中行の WORK_PATCH っぽい文字列はパッチ扱いしない", () => {
    const { patch, replyText } = parseWorkPatch(
      '説明: <<WORK_PATCH {"genre":"x"}>> はこう使います\n以上です',
    );
    expect(patch).toBeNull();
    expect(replyText).toContain("以上です");
  });
});

describe("buildOrchestratorInput", () => {
  const work = {
    id: "w1",
    owner_ref: "u1",
    title: "タイトル",
    premise: "前提",
    genre: "",
    status: "setup" as const,
    charter: null,
    policy: null,
    provider: null,
    model: null,
    key_ref: null,
    autonomy_level: "off" as const,
    autonomy_budget: 0,
    canon_rev: 0,
    created_at: 0,
    updated_at: 0,
  };
  const msg = (role: "user" | "assistant" | "system", content: string) => ({
    id: "m",
    thread_id: "t",
    role,
    content,
    job_id: null,
    created_at: 0,
  });

  it("システムプロンプト + 作品情報 + 履歴を積む", () => {
    const input = buildOrchestratorInput({
      work,
      messages: [msg("user", "ファンタジーで"), msg("assistant", "了解です")],
    });
    expect(input[0]!.role).toBe("developer");
    expect(input[0]!.content).toContain("放置作家");
    expect(input[1]!.role).toBe("developer");
    expect(input[1]!.content).toContain("タイトル");
    expect(input[2]!.role).toBe("user");
    expect(input[3]!.role).toBe("assistant");
  });
});

describe("spec 4.3: コミットメント状態", () => {
  it("CANON_FACTS マーカーは commitment/disclosure 付きオブジェクトを受け付ける", () => {
    const r = parseOrchestratorMarkers(
      '了解です。\n<<CANON_FACTS ["汽車はもう走っていない", {"statement": "黒服は機械かも", "commitment": "provisional"}, {"statement": "駅長は裏切り者", "disclosure": "secret"}]>>',
    );
    expect(r.canonFacts).toEqual([
      "汽車はもう走っていない",
      { statement: "黒服は機械かも", commitment: "provisional" },
      { statement: "駅長は裏切り者", disclosure: "secret" },
    ]);
    expect(r.cleanText).toBe("了解です。");
  });

  it("CHANGESET マーカーは set_fact_commitment と確度付き add/revise を受理する", () => {
    const r = parseOrchestratorMarkers(
      '変更します。\n<<CHANGESET {"title":"確度整理","description":"","ops":[{"op":"set_fact_commitment","fact_id":"f1","commitment":"provisional"},{"op":"add_fact","statement":"線路の先は海","commitment":"committed"},{"op":"revise_fact","fact_id":"f2","new_statement":"汽車は走らない","disclosure":"secret"}]}>>',
    );
    expect(r.changeSet).not.toBeNull();
    expect(r.changeSet!.ops).toHaveLength(3);
    expect(r.changeSet!.ops[0]).toMatchObject({
      op: "set_fact_commitment",
      fact_id: "f1",
      commitment: "provisional",
    });
    expect(r.changeSet!.ops[1]).toMatchObject({
      op: "add_fact",
      commitment: "committed",
    });
    expect(r.changeSet!.ops[2]).toMatchObject({
      op: "revise_fact",
      disclosure: "secret",
    });
  });

  it("buildOrchestratorInput は確度・秘密のラベルを正典に付けて渡す", () => {
    const input = buildOrchestratorInput({
      work: {
        id: "w1",
        owner_ref: "u1",
        title: "タイトル",
        premise: "前提",
        genre: "",
        status: "setup" as const,
        charter: null,
        policy: null,
        provider: null,
        model: null,
        key_ref: null,
        autonomy_level: "off" as const,
        autonomy_budget: 0,
        canon_rev: 0,
        created_at: 0,
        updated_at: 0,
      },
      messages: [],
      canonFacts: [
        { id: "f1", statement: "汽車はもう走っていない" },
        { id: "f2", statement: "黒服は機械かも", commitment: "provisional" },
        { id: "f3", statement: "駅長は裏切り者", disclosure: "secret" },
        { id: "f4", statement: "町の名前", commitment: "undecided" },
      ],
    });
    const ctx = input[1]!.content;
    expect(ctx).toContain("[fact_id: f1] 汽車はもう走っていない");
    expect(ctx).toContain("[fact_id: f2] [仮置き] 黒服は機械かも");
    expect(ctx).toContain("[fact_id: f3] [秘密] 駅長は裏切り者");
    expect(ctx).toContain("[fact_id: f4] [未判断] 町の名前");
  });
});

describe("spec §7.3: <<AUTO_STOP>> (自律運転の終了要求)", () => {
  it("末尾の AUTO_STOP 行を検出し本文から除く", () => {
    const r = parseOrchestratorMarkers(
      "これ以上進めるには作者の判断が必要です。\n<<AUTO_STOP>>",
    );
    expect(r.autoStop).toBe(true);
    expect(r.cleanText).toBe("これ以上進めるには作者の判断が必要です。");
  });

  it("AUTO_STOP がなければ autoStop=false", () => {
    const r = parseOrchestratorMarkers("普通の返答です");
    expect(r.autoStop).toBe(false);
    expect(r.cleanText).toBe("普通の返答です");
  });

  it("他のマーカーと併存しても検出できる", () => {
    const r = parseOrchestratorMarkers(
      '提案だけ残して止まります。\n<<PROPOSE {"episode_title":"第1話","scene_title":"導入","scene_purpose":"目的","contract":{"role":"案内人","pov":"三人称","required_events":["出会い"],"forbidden":[],"knowledge_notes":"","connections":""}}>>\n<<AUTO_STOP>>',
    );
    expect(r.autoStop).toBe(true);
    expect(r.proposal).not.toBeNull();
    expect(r.cleanText).not.toContain("AUTO_STOP");
    expect(r.cleanText).toBe("提案だけ残して止まります。");
  });

  it("buildOrchestratorInput は autonomous 時だけ自律指示を追加する", () => {
    const work = {
      id: "w1",
      owner_ref: "u1",
      title: "タイトル",
      premise: "前提",
      genre: "",
      status: "setup" as const,
      charter: null,
      policy: null,
      provider: null,
      model: null,
      key_ref: null,
      autonomy_level: "off" as const,
      autonomy_budget: 0,
      canon_rev: 0,
      created_at: 0,
      updated_at: 0,
    };
    const auto = buildOrchestratorInput({
      work,
      messages: [
        {
          id: "m1",
          thread_id: "t",
          role: "user" as const,
          content: "こんにちは",
          job_id: null,
          created_at: 0,
        },
      ],
      autonomous: true,
    });
    expect(
      auto.some(
        (m) =>
          m.role === "developer" &&
          m.content.includes("自律実行モードによる往復です"),
      ),
    ).toBe(true);
    // 自律指示は先頭ブロック内 — 履歴以後に developer メッセージを置かない
    // (Gemini 等は会話先頭以外の system/developer を拒否する)。
    const lastDeveloper = auto.map((m) => m.role).lastIndexOf("developer");
    const firstNonDeveloper = auto.findIndex((m) => m.role !== "developer");
    expect(lastDeveloper).toBeLessThan(firstNonDeveloper);
    const manual = buildOrchestratorInput({ work, messages: [] });
    expect(
      manual.some(
        (m) =>
          m.role === "developer" &&
          m.content.includes("自律実行モードによる往復です"),
      ),
    ).toBe(false);
  });
});
