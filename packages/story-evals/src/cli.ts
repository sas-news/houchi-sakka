// ---------------------------------------------------------------------------
// pnpm evals のエントリ。scenarios/*.json を全部走らせてレポートを出す。
//
//   pnpm evals                 … stub provider (決定的・APIキー不要)
//   EVAL_LIVE=1 pnpm evals     … 実モデル (OPENAI_API_KEY 必須)
//   EVAL_MODEL=gpt-4o-mini     … live モードのモデル名 (既定 gpt-4o-mini)
//
// 終了コード: fail/error が1件でもあれば 1。
// レポート JSON は reports/eval-report.json にも書き出す (gitignore 済み)。
// ---------------------------------------------------------------------------

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OpenAIResponsesProvider, StubProvider } from "@houchi/providers";
import type { Provider } from "@houchi/providers";
import type { ProviderRequest } from "@houchi/contracts";
import { runDialogueScenario } from "./dialogue.js";
import { runGenerationScenario } from "./generation.js";
import {
  formatReport,
  summarize,
  type EvalReport,
  type EvalResult,
} from "./report.js";
import {
  ScenarioSchema,
  type DialogueScenario,
  type GenerationScenario,
} from "./scenario.js";

const SCENARIOS_DIR = fileURLToPath(new URL("../scenarios/", import.meta.url));
const REPORTS_DIR = fileURLToPath(new URL("../reports/", import.meta.url));

const live = process.env.EVAL_LIVE === "1";
const model = process.env.EVAL_MODEL ?? (live ? "gpt-4o-mini" : "stub-model");
const apiKey = process.env.OPENAI_API_KEY ?? "";

if (live && apiKey === "") {
  console.error("EVAL_LIVE=1 には OPENAI_API_KEY が必要です");
  process.exit(1);
}

/** generation eval 用: writer/critic の応答をシナリオから返すスタブ。 */
function generationProvider(scenario: GenerationScenario): Provider {
  if (live) return new OpenAIResponsesProvider();
  return new StubProvider({
    respond: (req: ProviderRequest) => {
      const joined = req.input.map((m) => m.content).join("\n");
      if (joined.includes("執筆担当")) {
        return typeof scenario.writer_response === "string"
          ? scenario.writer_response
          : JSON.stringify(
              scenario.writer_response ?? {
                prose_md: "(シナリオに writer_response がありません)",
                canon_facts_new: [],
                depends_on: [],
              },
            );
      }
      if (joined.includes("検査担当")) {
        return typeof scenario.critic_response === "string"
          ? scenario.critic_response
          : JSON.stringify(
              scenario.critic_response ?? { violations: [], notes: [] },
            );
      }
      return "{}";
    },
  });
}

function dialogueProvider(stubResponse: string | undefined): Provider {
  if (live) return new OpenAIResponsesProvider();
  return new StubProvider({ text: stubResponse ?? "" });
}

async function runOne(
  raw: unknown,
  sourceFile: string,
): Promise<EvalResult> {
  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      name: sourceFile,
      kind: "dialogue",
      status: "error",
      description: "",
      failures: [`シナリオがスキーマに合いません: ${parsed.error.message}`],
    };
  }
  const scenario = parsed.data;
  try {
    if (scenario.kind === "dialogue") {
      const s: DialogueScenario = scenario;
      return await runDialogueScenario(s, {
        providerForTurn: (turn) => dialogueProvider(turn.stub_response),
        apiKey,
        model,
      });
    }
    const s: GenerationScenario = scenario;
    return await runGenerationScenario(s, {
      provider: generationProvider(s),
      apiKey,
      model,
    });
  } catch (e) {
    return {
      name: scenario.name,
      kind: scenario.kind,
      status: "error",
      description: scenario.description,
      failures: [
        `シナリオ実行中に例外: ${e instanceof Error ? e.message : String(e)}`,
      ],
    };
  }
}

async function main(): Promise<void> {
  const files = readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    console.error(`シナリオがありません: ${SCENARIOS_DIR}`);
    process.exit(1);
  }
  const results: EvalResult[] = [];
  for (const file of files) {
    const raw = JSON.parse(
      readFileSync(new URL(`../scenarios/${file}`, import.meta.url), "utf8"),
    ) as unknown;
    results.push(await runOne(raw, file));
  }
  const report: EvalReport = {
    mode: live ? "live" : "stub",
    model,
    started_at: new Date().toISOString(),
    results,
    totals: summarize(results),
  };
  console.log(formatReport(report));
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(
    new URL("../reports/eval-report.json", import.meta.url),
    JSON.stringify(report, null, 2),
  );
  console.log(`レポート: ${REPORTS_DIR}eval-report.json`);
  if (report.totals.fail > 0 || report.totals.error > 0) {
    process.exit(1);
  }
}

await main();
