// ---------------------------------------------------------------------------
// レポートの型・集計・表示。pnpm evals が全シナリオの結果をまとめて出す。
// ---------------------------------------------------------------------------

import type { MarkerKind } from "./scenario.js";

export type EvalStatus = "pass" | "fail" | "error";

export interface TurnResult {
  turn: number;
  user: string;
  assistant_text: string;
  fired_markers: MarkerKind[];
  status: "pass" | "fail";
  failures: string[];
}

export interface GenerationMetrics {
  /** マージ済み findings の深刻度別件数。 */
  violations: { high: number; medium: number; low: number; info: number };
  /** そのうち決定的検査 (validators) 由来の件数。 */
  validator_findings: { high: number; medium: number; low: number; info: number };
  /** required_events の被覆率。 */
  required_events: { covered: number; missing: number; total: number };
  /** DependencyEdge 被覆率 (spec §10): 宣言依存数 / 投入した正典件数。 */
  dependency_coverage: { edges: number; canon_facts: number };
  prose_length: number;
}

export interface EvalResult {
  name: string;
  kind: "dialogue" | "generation";
  status: EvalStatus;
  description: string;
  turns?: TurnResult[];
  /** generation: マージ済み findings の一覧。 */
  findings?: {
    source: "validators" | "critic";
    rule: string;
    severity: string;
    detail: string;
  }[];
  prose_md?: string;
  metrics?: Record<string, unknown>;
  failures: string[];
}

export interface EvalReport {
  /** stub | live (EVAL_LIVE=1)。 */
  mode: string;
  model: string;
  started_at: string;
  results: EvalResult[];
  totals: { pass: number; fail: number; error: number; scenarios: number };
}

export function summarize(results: EvalResult[]): EvalReport["totals"] {
  let pass = 0;
  let fail = 0;
  let error = 0;
  for (const r of results) {
    if (r.status === "pass") pass += 1;
    else if (r.status === "fail") fail += 1;
    else error += 1;
  }
  return { pass, fail, error, scenarios: results.length };
}

/** 人向けのレポート表示 (stdout)。 */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(
    `# Story Evals レポート (mode=${report.mode}, model=${report.model})`,
    "",
  );
  for (const r of report.results) {
    const mark = r.status === "pass" ? "PASS" : r.status.toUpperCase();
    lines.push(`## [${mark}] ${r.name} (${r.kind})`);
    if (r.description) lines.push(`  ${r.description}`);
    if (r.turns) {
      for (const t of r.turns) {
        const tmark = t.status === "pass" ? "ok" : "NG";
        lines.push(
          `  turn${t.turn} [${tmark}] user: ${t.user}`,
          `    markers: ${t.fired_markers.join(",") || "(なし)"}`,
        );
        for (const f of t.failures) lines.push(`    ✗ ${f}`);
      }
    }
    if (r.findings && r.findings.length > 0) {
      lines.push("  findings:");
      for (const f of r.findings) {
        lines.push(`    [${f.severity}] ${f.source} ${f.rule}: ${f.detail}`);
      }
    }
    if (r.metrics) {
      lines.push(`  metrics: ${JSON.stringify(r.metrics)}`);
    }
    for (const f of r.failures) lines.push(`  ✗ ${f}`);
    lines.push("");
  }
  lines.push(
    `合計: ${report.totals.pass}/${report.totals.scenarios} pass, ` +
      `${report.totals.fail} fail, ${report.totals.error} error`,
  );
  return lines.join("\n");
}
