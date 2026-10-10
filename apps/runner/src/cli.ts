import { hostname } from "node:os";
import type { ProviderRequest } from "@houchi/contracts";
import {
  createProviders,
  StubProvider,
  type Provider,
} from "@houchi/providers";
import { ApiClient } from "./api.js";
import { runLoop, tick, type RunnerDeps } from "./loop.js";

/**
 * apps/runner CLI — 常駐実行体。
 *
 *   pnpm --filter @houchi/runner start [-- --once] [-- --env-key] [-- --provider stub]
 *
 * env: WEB_BASE_URL, EXECUTOR_TOKEN, POLL_INTERVAL_MS, LEASE_TTL_MS,
 *      EXECUTOR_ID, RUNNER_PROVIDER, OPENAI_API_KEY, STUB_SCENARIO
 *
 * プロバイダーは openai / anthropic / stub のレジストリを常備し、
 * ジョブ payload.provider で引く (キー管理画面で選んだ provider に対応)。
 * (.env があれば process.loadEnvFile で読む)
 */

interface CliArgs {
  once: boolean;
  envKey: boolean;
  provider?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { once: false, envKey: false };
  for (const a of argv) {
    if (a === "--once") args.once = true;
    else if (a === "--env-key") args.envKey = true;
    else if (a.startsWith("--provider=")) args.provider = a.slice(11);
  }
  return args;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

/**
 * STUB_SCENARIO=phase1b: 対話→提案→本文生成→書き直しまでを stub で回す
 * E2E 用の応答パターン。
 * - 本文生成 (入力に【Writing Contract】) → 段落本文を返す。
 * - 保留中の提案がある間 → 再提案しない平文返答。
 * - 2往復目以降の対話 → シーン提案 (PROPOSE)。
 * - 初回の対話 → WORK_PATCH + CANON_FACTS で前提と正典を確定。
 */
function phase1bStubResponder(req: ProviderRequest): string {
  const joined = req.input.map((m) => m.content).join("\n");
  if (joined.includes("【Writing Contract】")) {
    return [
      "雨がやんだ頃、廃線のホームに少女が立っていた。",
      "",
      "彼女は濡れた切符を眺め、それから意を決したように線路の先を見上げた。もう戻る汽車は来ない。来ないからこそ、歩き出す理由ができた。",
      "",
      "枕木を踏むたび、石畳の下で都市の心音がかすかに鳴っていた。",
    ].join("\n");
  }
  if (joined.includes("保留中の提案")) {
    return "出している提案の決定を待っています。承認か却下、修正の指示をください。";
  }
  const userTurns = req.input.filter((m) => m.role === "user").length;
  if (userTurns >= 2) {
    return [
      "前提は固まりました。では第1話の冒頭シーンをこの契約で書きましょう。問題なければ承認してください。",
      '<<PROPOSE {"episode_title": "第1話", "scene_title": "廃線ホーム", "scene_purpose": "主人公の旅立ちの動機を示す導入", "contract": {"role": "物語の導入。主人公が旅に出る決意をする", "pov": "三人称・主人公寄り", "required_events": ["雨上がりの廃線ホーム", "濡れた切符", "都市の心音を聞く"], "forbidden": ["説明口調の背景説明"], "knowledge_notes": "世界観はメトロポリス幻想", "connections": "前話なし。次シーンで列車跡をたどる"}}>>',
    ].join("\n");
  }
  return [
    "いいですね。その方向で前提を固めましょう。ジャンルと主人公の動機を整理しました。次に冒頭シーンを書くか聞かせてください。",
    '<<CANON_FACTS ["主人公は廃都市に暮らす少女", "汽車はもう走っていない"]>>',
    '<<WORK_PATCH {"premise": "廃都市を出て行く少女の旅", "genre": "ファンタジー", "status": "active"}>>',
  ].join("\n");
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`invalid ${name}: ${v}`);
    process.exit(1);
  }
  return n;
}

async function main(): Promise<void> {
  // .env があれば読む (存在しなくても良い)
  try {
    process.loadEnvFile();
  } catch {
    /* no .env */
  }

  const args = parseArgs(process.argv.slice(2));
  const baseUrl = required("WEB_BASE_URL").replace(/\/$/, "");
  const token = required("EXECUTOR_TOKEN");
  const pollMs = intEnv("POLL_INTERVAL_MS", 2000);
  const leaseTtlMs = intEnv("LEASE_TTL_MS", 120_000);
  const executorId =
    process.env.EXECUTOR_ID || `${hostname()}-${process.pid}`;
  const defaultProvider = args.provider ?? process.env.RUNNER_PROVIDER;

  if (args.envKey && !process.env.OPENAI_API_KEY) {
    console.error("--env-key requires OPENAI_API_KEY to be set");
    process.exit(1);
  }

  // openai / anthropic / stub のレジストリ。
  const providers: Record<string, Provider> = createProviders();

  // RUNNER_PROVIDER / --provider で既定('openai'名)を差し替える。
  // payload.provider 未指定のジョブは 'openai' 名を引くため、
  // ここに選択した provider を載せれば既定経路が変わる。
  if (process.env.STUB_SCENARIO === "phase1b") {
    providers["stub"] = new StubProvider({ respond: phase1bStubResponder });
  }

  if (defaultProvider) {
    const p = providers[defaultProvider];
    if (!p) {
      console.error(`unknown RUNNER_PROVIDER: ${defaultProvider}`);
      process.exit(1);
    }
    providers["openai"] = p;
  }

  const deps: RunnerDeps = {
    api: new ApiClient(baseUrl, token),
    executorId,
    leaseTtlMs,
    providers,
    ...(args.envKey ? { envKey: required("OPENAI_API_KEY") } : {}),
    log: (m) => console.log(`[runner ${executorId}] ${m}`),
  };

  console.log(
    `[runner ${executorId}] polling ${baseUrl} every ${pollMs}ms (provider=${defaultProvider ?? "openai"})`,
  );

  if (args.once) {
    const worked = await tick(deps);
    console.log(worked ? "processed one job" : "no job available");
    return;
  }

  const ac = new AbortController();
  const stop = () => {
    console.log("shutting down…");
    ac.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await runLoop(deps, pollMs, ac.signal);
}

await main();
