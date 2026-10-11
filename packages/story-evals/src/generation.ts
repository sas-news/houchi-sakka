// ---------------------------------------------------------------------------
// 生成品質 eval — 固定シナリオ (契約+正典+入力) から writer 生成 →
// validators (決定的検査) + critic (AI検査) で採点して findings・被覆率を出す。
// spec §10 Story Evals。DependencyEdge 被覆率を指標に含める。
// ---------------------------------------------------------------------------

import { runSkillStep } from "@houchi/harness";
import { criticSkill, writerSkill, type CriticOutput } from "@houchi/skills";
import type { Provider } from "@houchi/providers";
import {
  countFindings,
  requiredEventCoverage,
  toCriticOutput,
  validateProse,
  type ValidationReport,
} from "@houchi/validators";
import { canonSeedsToFacts, type GenerationScenario } from "./scenario.js";
import { makeJob, makeSkillCtx } from "./ctx.js";
import type { EvalResult } from "./report.js";

/** validateProse + critic をマージした findings の一覧形。 */
interface MergedFinding {
  source: "validators" | "critic";
  rule: string;
  severity: string;
  detail: string;
}

/**
 * writer → validators + critic を回して findings を出す。
 * provider は呼び出し側が選ぶ (stub は writer_response/critic_response を返す)。
 */
export async function runGenerationScenario(
  scenario: GenerationScenario,
  opts: { provider: Provider; apiKey: string; model: string },
): Promise<EvalResult> {
  const canonFacts = canonSeedsToFacts(scenario.canon_facts, "eval-work");
  const ctx = makeSkillCtx({
    provider: opts.provider,
    apiKey: opts.apiKey,
  });
  const job = makeJob("eval_generation", {});
  const failures: string[] = [];

  // --- writer ------------------------------------------------------------
  const writerOut = await runSkillStep(ctx, {
    job,
    skill: writerSkill,
    input: {
      contract: scenario.contract,
      scene_title: scenario.scene_title,
      scene_purpose: scenario.scene_purpose,
      canon_facts: canonFacts.map((f) => f.statement),
      ...(scenario.instruction !== undefined
        ? { instruction: scenario.instruction }
        : {}),
    },
    model: opts.model,
    providerName: "eval",
    keyRef: "eval-key",
    step: "write",
  });

  // --- validators (決定的検査) --------------------------------------------
  const report: ValidationReport = validateProse(writerOut.prose_md, {
    contract: scenario.contract,
    canonFacts,
  });
  const detCounts = countFindings(report);
  const detAsCritic = toCriticOutput(report);

  // --- critic (AI検査) ----------------------------------------------------
  const criticOut: CriticOutput = await runSkillStep(ctx, {
    job,
    skill: criticSkill,
    input: {
      contract: scenario.contract,
      scene_title: scenario.scene_title,
      prose_md: writerOut.prose_md,
      canon_facts: canonFacts.map((f) => f.statement),
    },
    model: opts.model,
    providerName: "eval",
    keyRef: "eval-key",
    step: "critique",
  });

  const findings: MergedFinding[] = [
    ...report.findings.map((f) => ({
      source: "validators" as const,
      rule: f.rule,
      severity: f.severity,
      detail: f.detail,
    })),
    ...criticOut.violations.map((v) => ({
      source: "critic" as const,
      rule: v.rule,
      severity: v.severity,
      detail: v.detail,
    })),
    ...criticOut.notes.map((n) => ({
      source: "critic" as const,
      rule: "note",
      severity: "info",
      detail: n,
    })),
  ];

  const mergedHigh =
    detAsCritic.violations.filter((v) => v.severity === "high").length +
    criticOut.violations.filter((v) => v.severity === "high").length;
  const coverage = requiredEventCoverage(writerOut.prose_md, scenario.contract);

  // --- 期待の評価 ----------------------------------------------------------
  const expect = scenario.expect;
  for (const want of expect.findings_include) {
    const hit = findings.some(
      (f) =>
        f.rule === want.rule &&
        (want.severity === undefined || f.severity === want.severity),
    );
    if (!hit) {
      failures.push(
        `期待された finding ${want.rule}` +
          (want.severity ? ` (${want.severity})` : "") +
          " が見つかりません",
      );
    }
  }
  if (expect.max_high !== undefined && mergedHigh > expect.max_high) {
    failures.push(`high findings ${mergedHigh} > 上限 ${expect.max_high}`);
  }
  if (expect.min_high !== undefined && mergedHigh < expect.min_high) {
    failures.push(`high findings ${mergedHigh} < 下限 ${expect.min_high}`);
  }
  if (
    expect.required_events_missing !== undefined &&
    coverage.missing.length !== expect.required_events_missing
  ) {
    failures.push(
      `未検出の必須イベント ${coverage.missing.length} 件 ` +
        `(期待 ${expect.required_events_missing})`,
    );
  }

  const merged = {
    high: detCounts.high +
      criticOut.violations.filter((v) => v.severity === "high").length,
    medium: detCounts.medium +
      criticOut.violations.filter((v) => v.severity === "medium").length,
    low: detCounts.low +
      criticOut.violations.filter((v) => v.severity === "low").length,
    info: detCounts.info + criticOut.notes.length,
  };

  return {
    name: scenario.name,
    kind: "generation",
    status: failures.length === 0 ? "pass" : "fail",
    description: scenario.description,
    findings,
    prose_md: writerOut.prose_md,
    metrics: {
      violations: merged,
      validator_findings: detCounts,
      required_events: {
        covered: coverage.covered.length,
        missing: coverage.missing.length,
        total: scenario.contract.required_events.length,
      },
      dependency_coverage: {
        edges: writerOut.depends_on.length,
        canon_facts: canonFacts.length,
      },
      prose_length: writerOut.prose_md.length,
    },
    failures,
  };
}
