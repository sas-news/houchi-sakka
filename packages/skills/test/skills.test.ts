import { describe, expect, it } from "vitest";
import {
  SKILLS,
  criticSkill,
  fixerSkill,
  plannerSkill,
  writerSkill,
} from "../src/index.js";

const contract = {
  role: "導入",
  pov: "三人称",
  required_events: ["雨上がり"],
  forbidden: [],
  knowledge_notes: "",
  connections: "",
};

describe("skills レジストリ", () => {
  it("planner/writer/critic/fixer の4スキルが登録されている", () => {
    expect(Object.keys(SKILLS).sort()).toEqual([
      "critic",
      "fixer",
      "planner",
      "writer",
    ]);
    expect(plannerSkill.tools).toContain("writePropose");
    expect(writerSkill.tools).toContain("writePropose");
    expect(criticSkill.tools).not.toContain("writePropose");
    expect(fixerSkill.tools).toContain("writePropose");
  });

  it("planner: buildPrompt → outputSchema で往復できる", () => {
    const messages = plannerSkill.buildPrompt({
      work: { title: "作品", premise: "前提", genre: "SF", charter: null, policy: null },
      plan_tree: "(計画なし)",
      canon_facts: ["事実A"],
      guidance: "序盤だけ",
    });
    expect(messages.some((m) => m.content.includes("前提"))).toBe(true);
    const parsed = plannerSkill.outputSchema.parse({
      episodes: [{ title: "第1話", scenes: [{ title: "s", purpose: "p" }] }],
    });
    expect(parsed.episodes[0]!.scenes[0]!.title).toBe("s");
  });

  it("writer: prose_md/canon_facts_new/depends_on を検証する", () => {
    const messages = writerSkill.buildPrompt({
      contract,
      scene_title: "廃線ホーム",
      scene_purpose: "導入",
      canon_facts: ["事実A"],
    });
    expect(messages.some((m) => m.content.includes("廃線ホーム"))).toBe(true);
    const parsed = writerSkill.outputSchema.parse({
      prose_md: "本文",
    });
    expect(parsed.canon_facts_new).toEqual([]);
    expect(parsed.depends_on).toEqual([]);
  });

  it("critic: severity enum を検証する", () => {
    const out = criticSkill.outputSchema.parse({
      violations: [{ rule: "r", detail: "d", severity: "high" }],
      notes: ["n"],
    });
    expect(out.violations[0]!.severity).toBe("high");
    expect(() =>
      criticSkill.outputSchema.parse({
        violations: [{ rule: "r", detail: "d", severity: "fatal" }],
      }),
    ).toThrow();
  });

  it("fixer: findings の添字と action enum を検証する", () => {
    const messages = fixerSkill.buildPrompt({
      work: { title: "作品", premise: "前提" },
      change_set: { title: "設定変更", description: "" },
      canon_facts: [{ id: "f1", statement: "汽車は週1だけ走っている" }],
      findings: [
        {
          index: 0,
          kind: "conflict",
          severity: "high",
          summary: "廃線ホーム: canon",
          detail: "矛盾",
          scene: { id: "s1", title: "廃線ホーム", prose_md: "本文", contract: null },
          fact: null,
        },
      ],
    });
    // finding の本文と fact_id がプロンプトに乗る
    const joined = messages.map((m) => m.content).join("\n");
    expect(joined).toContain("汽車は週1だけ走っている");
    expect(joined).toContain("f1");
    expect(joined).toContain("本文");
    const parsed = fixerSkill.outputSchema.parse({
      fixes: [
        {
          finding_index: 0,
          action: "rewrite_scene",
          text: "書き換え後",
        },
      ],
    });
    expect(parsed.fixes[0]!.action).toBe("rewrite_scene");
    expect(() =>
      fixerSkill.outputSchema.parse({
        fixes: [{ finding_index: 0, action: "delete_scene", text: "x" }],
      }),
    ).toThrow();
  });
});
