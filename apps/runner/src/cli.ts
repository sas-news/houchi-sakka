import { hostname } from "node:os";
import {
  OpenAIResponsesProvider,
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
 *      EXECUTOR_ID, RUNNER_PROVIDER, OPENAI_API_KEY
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

  const providers: Record<string, Provider> = {
    openai: new OpenAIResponsesProvider(),
    stub: new StubProvider(),
  };

  // RUNNER_PROVIDER / --provider で既定('openai'名)を差し替える。
  // payload.provider 未指定のジョブは 'openai' 名を引くため、
  // ここに選択した provider を載せれば既定経路が変わる。
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
