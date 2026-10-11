import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StubProvider } from "@houchi/providers";
import { runDialogueScenario } from "../src/dialogue.js";
import { runGenerationScenario } from "../src/generation.js";
import { ScenarioSchema } from "../src/scenario.js";
import { formatReport, summarize } from "../src/report.js";

const SCENARIOS_DIR = fileURLToPath(new URL("../scenarios/", import.meta.url));

function loadScenario(file: string) {
  const raw = JSON.parse(readFileSync(`${SCENARIOS_DIR}${file}`, "utf8"));
  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function generationStub(opts: {
  writer: unknown;
  critic: unknown;
}): StubProvider {
  return new StubProvider({
    respond: (req) => {
      const joined = req.input.map((m) => m.content).join("\n");
      if (joined.includes("執筆担当")) {
        return typeof opts.writer === "string"
          ? opts.writer
          : JSON.stringify(opts.writer);
      }
      if (joined.includes("検査担当")) {
        return typeof opts.critic === "string"
          ? opts.critic
          : JSON.stringify(opts.critic);
      }
      return "{}";
    },
  });
}

describe("シナリオファイル", () => {
  it("scenarios/ の全ファイルがスキーマを通る (3件以上)", () => {
    const files = readdirSync(SCENARIOS_DIR).filter((f) =>
      f.endsWith(".json"),
    );
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      expect(() => loadScenario(file), file).not.toThrow();
    }
  });
});

describe("golden dialogue evals", () => {
  it("新規作品初期化: 契約要素の確認、CANON_FACTS 記録、本文生成しない", async () => {
    const s = loadScenario("new-work-dialogue.json");
    if (s.kind !== "dialogue") throw new Error("kind mismatch");
    const r = await runDialogueScenario(s, {
      providerForTurn: (turn) =>
        new StubProvider({ text: turn.stub_response ?? "" }),
      apiKey: "k",
      model: "stub",
    });
    expect(r.status).toBe("pass");
    expect(r.turns?.map((t) => t.status)).toEqual(["pass", "pass", "pass"]);
  });

  it("契約提案フロー: RUN_PLAN→PROPOSE、保留中は再提案しない", async () => {
    const s = loadScenario("contract-proposal-flow.json");
    if (s.kind !== "dialogue") throw new Error("kind mismatch");
    const r = await runDialogueScenario(s, {
      providerForTurn: (turn) =>
        new StubProvider({ text: turn.stub_response ?? "" }),
      apiKey: "k",
      model: "stub",
    });
    expect(r.status).toBe("pass");
  });

  it("期待を外す応答では fail になる (回帰検出の健全性)", async () => {
    const s = loadScenario("contract-proposal-flow.json");
    if (s.kind !== "dialogue") throw new Error("kind mismatch");
    // turn1 で RUN_PLAN を出さない悪い応答に差し替える。
    const bad = { ...s, turns: s.turns.map((t) => ({ ...t })) };
    bad.turns[0]!.stub_response = "わかりました、がんばりましょう。";
    const r = await runDialogueScenario(bad, {
      providerForTurn: (turn) =>
        new StubProvider({ text: turn.stub_response ?? "" }),
      apiKey: "k",
      model: "stub",
    });
    expect(r.status).toBe("fail");
    expect(r.turns?.[0]?.failures.join(" ")).toContain("RUN_PLAN");
  });

  it("本文生成ジョブは契約なしに enqueue されない", async () => {
    const s = loadScenario("new-work-dialogue.json");
    if (s.kind !== "dialogue") throw new Error("kind mismatch");
    const bad = { ...s, turns: s.turns.map((t) => ({ ...t })) };
    // 契約なしにシーン本文を実行しようとする応答 (RUN_PLAN で誤起票)。
    bad.turns[1]!.stub_response =
      "書きますね。\n<<RUN_PLAN>>";
    const r = await runDialogueScenario(bad, {
      providerForTurn: (turn) =>
        new StubProvider({ text: turn.stub_response ?? "" }),
      apiKey: "k",
      model: "stub",
    });
    expect(r.status).toBe("fail");
    expect(r.turns?.[1]?.failures.join(" ")).toContain("RUN_PLAN");
  });
});

describe("生成品質 evals", () => {
  it("禁止事項違反: validators が high を出す (AI が見逃しても)", async () => {
    const s = loadScenario("forbidden-violation.json");
    if (s.kind !== "generation") throw new Error("kind mismatch");
    const r = await runGenerationScenario(s, {
      provider: generationStub({
        writer: s.writer_response,
        critic: s.critic_response,
      }),
      apiKey: "k",
      model: "stub",
    });
    expect(r.status).toBe("pass");
    const detHigh = r.findings?.filter(
      (f) => f.source === "validators" && f.severity === "high",
    );
    expect(detHigh?.length).toBeGreaterThanOrEqual(1);
    expect(detHigh?.some((f) => f.rule === "contract.forbidden")).toBe(true);
    const v = r.metrics?.validator_findings as { high: number };
    expect(v.high).toBeGreaterThanOrEqual(1);
  });

  it("秘密漏洩: canon.secret_leak が high", async () => {
    const s = loadScenario("knowledge-leak.json");
    if (s.kind !== "generation") throw new Error("kind mismatch");
    const r = await runGenerationScenario(s, {
      provider: generationStub({
        writer: s.writer_response,
        critic: s.critic_response,
      }),
      apiKey: "k",
      model: "stub",
    });
    expect(r.status).toBe("pass");
    expect(
      r.findings?.some(
        (f) => f.rule === "canon.secret_leak" && f.severity === "high",
      ),
    ).toBe(true);
  });

  it("クリーン本文: high なし・必須イベントを網羅", async () => {
    const s = loadScenario("clean-generation.json");
    if (s.kind !== "generation") throw new Error("kind mismatch");
    const r = await runGenerationScenario(s, {
      provider: generationStub({
        writer: s.writer_response,
        critic: s.critic_response,
      }),
      apiKey: "k",
      model: "stub",
    });
    expect(r.status).toBe("pass");
    const req = r.metrics?.required_events as { missing: number };
    expect(req.missing).toBe(0);
  });

  it("期待を外す本文では fail になる", async () => {
    const s = loadScenario("clean-generation.json");
    if (s.kind !== "generation") throw new Error("kind mismatch");
    const bad = {
      ...s,
      expect: { ...s.expect, max_high: 0 },
      writer_response: {
        prose_md: "雨上がりのホームで黒猫の正体が明かされる。",
        canon_facts_new: [],
        depends_on: [],
      },
    };
    const r = await runGenerationScenario(bad, {
      provider: generationStub({
        writer: bad.writer_response,
        critic: s.critic_response,
      }),
      apiKey: "k",
      model: "stub",
    });
    expect(r.status).toBe("fail");
  });
});

describe("レポート", () => {
  it("集計と表示が壊れない", () => {
    const results = [
      {
        name: "a",
        kind: "dialogue" as const,
        status: "pass" as const,
        description: "",
        failures: [],
      },
      {
        name: "b",
        kind: "generation" as const,
        status: "fail" as const,
        description: "",
        failures: ["x"],
      },
    ];
    const totals = summarize(results);
    expect(totals).toEqual({ pass: 1, fail: 1, error: 0, scenarios: 2 });
    const text = formatReport({
      mode: "stub",
      model: "stub",
      started_at: "t",
      results,
      totals,
    });
    expect(text).toContain("[PASS] a");
    expect(text).toContain("[FAIL] b");
    expect(text).toContain("1/2 pass");
  });
});
