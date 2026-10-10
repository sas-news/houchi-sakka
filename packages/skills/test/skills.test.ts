import { describe, expect, it } from "vitest";
import { SKILLS, criticSkill, plannerSkill, writerSkill } from "../src/index.js";

const contract = {
  role: "導入",
  pov: "三人称",
  required_events: ["雨上がり"],
  forbidden: [],
  knowledge_notes: "",
  connections: "",
};

describe("skills レジストリ", () => {
  it("planner/writer/critic の3スキルが登録されている", () => {
    expect(Object.keys(SKILLS).sort()).toEqual([
      "critic",
      "planner",
      "writer",
    ]);
    expect(plannerSkill.tools).toContain("writePropose");
    expect(writerSkill.tools).toContain("writePropose");
    expect(criticSkill.tools).not.toContain("writePropose");
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
});
