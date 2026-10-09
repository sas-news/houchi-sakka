import { describe, expect, it } from "vitest";
import {
  buildOrchestratorInput,
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
