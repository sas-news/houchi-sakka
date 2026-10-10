import {
  type AgentJob,
  type ProviderInputMessage,
} from "@houchi/contracts";
import type { SkillDefinition } from "@houchi/skills";
import type { z } from "zod";
import type { TokenCallback } from "@houchi/providers";
import type { JobContext } from "./index.js";

/**
 * runSkillStep — スキル1段の実行 (Phase 2a)。
 *
 * スキルの buildPrompt で組み立てた入力を provider に投げ、応答テキストから
 * JSON を抽出して outputSchema で検証する。パース失敗時は「修正要求」を
 * 会話に足して **1回だけ** 再試行する (それでも失敗ならジョブ起因の失敗)。
 */

/** 応答テキストから JSON オブジェクト片を切り出す。 */
export function extractJson(text: string): string | null {
  // ```json ... ``` フェンスがあればその中身を優先
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? (fence[1] ?? "") : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function tryParse<O>(
  outputSchema: z.ZodType<O, z.ZodTypeDef, unknown>,
  text: string,
): { ok: true; output: O } | { ok: false; error: string } {
  const json = extractJson(text);
  if (json === null) {
    return { ok: false, error: "no JSON object found in output" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return {
      ok: false,
      error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  return { ok: true, output: parsed.data };
}

const RETRY_INSTRUCTION =
  "上記の出力はスキーマに合いませんでした。指示した形式の JSON オブジェクト1つだけを返してください。説明文・コードフェンスは付けないでください。";

export async function runSkillStep<I, O>(
  ctx: JobContext,
  args: {
    job: AgentJob;
    skill: SkillDefinition<I, O>;
    input: I;
    model: string;
    providerName: string;
    keyRef: string | undefined;
    /** 進捗イベントの段階名 (write/critique/revise/plan など)。 */
    step: string;
    onToken?: TokenCallback;
  },
): Promise<O> {
  const { skill, job } = args;
  const provider = ctx.getProvider(args.providerName);
  const apiKey = provider.requiresKey
    ? await ctx.resolveKey(args.keyRef, job.id)
    : undefined;

  const baseInput = skill.buildPrompt(args.input);

  let progressChain: Promise<void> = Promise.resolve();
  const onToken = args.onToken
    ? (text: string) => {
        progressChain = progressChain.then(() =>
          ctx.postProgress("token", { text }),
        );
      }
    : undefined;

  const callOnce = async (
    input: ProviderInputMessage[],
  ): Promise<{ ok: true; output: O } | { ok: false; error: string }> => {
    const resp = await provider.generate(
      { model: args.model, input },
      apiKey ?? "",
      onToken,
    );
    return tryParse(skill.outputSchema, resp.output_text);
  };

  await ctx.postProgress("status", {
    step: args.step,
    skill: skill.name,
    model: args.model,
  });
  const first = await callOnce(baseInput);
  if (first.ok) {
    await progressChain;
    return first.output;
  }

  // パース失敗 → 修正要求を足して1回だけリトライ
  await ctx.postProgress("note", {
    step: `${args.step}_retry`,
    skill: skill.name,
    reason: first.error,
  });
  const retryInput: ProviderInputMessage[] = [
    ...baseInput,
    { role: "user", content: `${RETRY_INSTRUCTION}\nエラー: ${first.error}` },
  ];
  const second = await callOnce(retryInput);
  await progressChain;
  if (!second.ok) {
    throw new Error(
      `skill "${skill.name}" output parse failed after retry: ${second.error}`,
    );
  }
  return second.output;
}
