import { describe, expect, it } from "vitest";
import {
  checkForbidden,
  checkKnowledgeLeak,
  checkRequiredEvents,
  contentTokens,
  countFindings,
  isSecretFact,
  normalizeText,
  requiredEventCoverage,
  toCriticOutput,
  validateProse,
} from "../src/index.js";

const CONTRACT = {
  role: "導入",
  pov: "三人称",
  required_events: ["雨上がり", "切符を拾う"],
  forbidden: ["黒猫の正体が明かされる", "時間旅行"],
  knowledge_notes: "",
  connections: "",
};

describe("normalizeText / contentTokens", () => {
  it("全角・空白・約物を落として一致させる", () => {
    expect(normalizeText("　Ｋｉｒａ、。")).toBe("kira");
    expect(normalizeText("黒猫 の 正体")).toBe("黒猫の正体");
  });

  it("助詞境界で2文字以上の塊に割る", () => {
    expect(contentTokens("黒猫の正体が明かされる")).toEqual(
      expect.arrayContaining(["黒猫", "正体", "明か"]),
    );
  });
});

describe("checkForbidden", () => {
  it("禁止事項と一致する表現は high を返す", () => {
    const r = checkForbidden(
      "彼は黒猫の正体が明かされるのを見た。",
      CONTRACT,
    );
    const f = r.findings.find((x) => x.rule === "contract.forbidden");
    expect(f?.severity).toBe("high");
    expect(f?.evidence).toBe("黒猫の正体が明かされる");
  });

  it("表記ゆれ (語順違い・送り仮名違い) は medium", () => {
    // 構成要素 (黒猫/正体/明か) が全部出るが完全一致ではない
    const r = checkForbidden("黒猫は正体を明かしてしまった。", {
      forbidden: ["黒猫の正体が明かされる"],
    });
    const f = r.findings.find((x) => x.rule === "contract.forbidden");
    expect(f?.severity).toBe("medium");
  });

  it("無関係な本文では findings は空", () => {
    const r = checkForbidden("雨が上がり、ホームに光が戻った。", CONTRACT);
    expect(r.findings.filter((f) => f.rule === "contract.forbidden")).toEqual(
      [],
    );
  });
});

describe("checkRequiredEvents", () => {
  it("触れられたイベントはカバー、未言及は info finding", () => {
    const r = checkRequiredEvents(
      "雨上がりのホームで、彼女は濡れた切符を拾った。",
      CONTRACT,
    );
    const missing = r.findings.filter(
      (f) => f.rule === "contract.required_events",
    );
    expect(missing).toHaveLength(0);

    const r2 = checkRequiredEvents("風が吹いていた。", CONTRACT);
    expect(
      r2.findings.filter((f) => f.rule === "contract.required_events"),
    ).toHaveLength(2);
    for (const f of r2.findings) expect(f.severity).toBe("info");
  });

  it("requiredEventCoverage は covered/missing を返す", () => {
    const { covered, missing } = requiredEventCoverage(
      "雨上がりの朝。",
      CONTRACT,
    );
    expect(covered).toEqual(["雨上がり"]);
    expect(missing).toEqual(["切符を拾う"]);
  });
});

describe("checkKnowledgeLeak", () => {
  const facts = [
    { statement: "汽車はもう走っていない", provenance: "orchestrator" },
    {
      statement: "[SECRET] 黒猫の正体は駅の精霊である",
      provenance: "orchestrator",
    },
    { statement: "駅長は裏で切符を盗んでいる", provenance: "secret" },
  ];

  it("provenance=secret / [SECRET] マークを秘密と判定する", () => {
    expect(isSecretFact(facts[0]!)).toBe(false);
    expect(isSecretFact(facts[1]!)).toBe(true);
    expect(isSecretFact(facts[2]!)).toBe(true);
  });

  it("秘密の内容が本文に一致して出ていれば high", () => {
    const r = checkKnowledgeLeak(
      "その時わかった。黒猫の正体は駅の精霊である、と。",
      facts,
    );
    const f = r.findings.find((x) => x.rule === "canon.secret_leak");
    expect(f?.severity).toBe("high");
  });

  it("構成要素の出現揃いは medium、秘密でない事実の一致は無視する", () => {
    const medium = checkKnowledgeLeak(
      "黒猫の正体は駅に棲む精霊のようだった。",
      facts,
    );
    expect(
      medium.findings.find((x) => x.rule === "canon.secret_leak")?.severity,
    ).toBe("medium");

    // 秘密でない事実「汽車はもう走っていない」が出ても finding にならない
    const none = checkKnowledgeLeak("汽車はもう走っていない、誰も知っている。", [
      facts[0]!,
    ]);
    expect(none.findings).toHaveLength(0);
  });
});

describe("validateProse / toCriticOutput / countFindings", () => {
  it("全チェックを深刻度順にまとめ、critic 形に畳める", () => {
    const report = validateProse(
      "黒猫の正体が明かされる。風が吹いていた。",
      {
        contract: CONTRACT,
        canonFacts: [
          { statement: "[SECRET] 駅長は精霊", provenance: "orchestrator" },
        ],
      },
    );
    const counts = countFindings(report);
    expect(counts.high).toBe(1); // forbidden
    expect(counts.info).toBe(2); // required_events 2件とも未言及

    const asCritic = toCriticOutput(report);
    expect(asCritic.violations).toHaveLength(1);
    expect(asCritic.violations[0]!.severity).toBe("high");
    expect(asCritic.notes.every((n) => n.startsWith("[決定的検査]"))).toBe(true);
  });
});
