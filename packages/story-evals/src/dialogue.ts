// ---------------------------------------------------------------------------
// golden dialogue eval — シナリオのユーザー発言列を orchestrator_turn ジョブに
// 流し、各ターンで起きた副作用 (マーカーの実効果) と応答本文を検証する。
//
// stub モードではシナリオの stub_response を provider が返し、配線と期待の
// 決定的な一致を確認する。EVAL_LIVE では実モデルが応答し、同じ期待を
// モデルのマーカー規律への回帰検査として使う。
// ---------------------------------------------------------------------------

import {
  JOB_KIND_GENERATE_SCENE,
  JOB_KIND_ORCHESTRATOR_TURN,
  OrchestratorTurnPayloadSchema,
} from "@houchi/contracts";
import { runJob } from "@houchi/harness";
import type { Provider } from "@houchi/providers";
import {
  makeEvalCtx,
  makeEvalWorld,
  makeJob,
  makeWork,
  type TurnEffects,
} from "./ctx.js";
import {
  canonSeedsToFacts,
  type DialogueScenario,
  type DialogueTurn,
  type MarkerKind,
} from "./scenario.js";
import type { EvalResult, TurnResult } from "./report.js";

function emptyEffects(): TurnEffects {
  return {
    work_patched: [],
    canon_added: [],
    proposals_created: [],
    jobs_enqueued: [],
    change_sets_created: [],
    assistant_text: "",
    result: null,
  };
}

/** 観測された副作用 → 発火したマーカー種別の集合。 */
function firedMarkers(effects: TurnEffects): Set<MarkerKind> {
  const fired = new Set<MarkerKind>();
  if (effects.work_patched.length > 0) fired.add("WORK_PATCH");
  if (effects.canon_added.length > 0) fired.add("CANON_FACTS");
  if (effects.proposals_created.length > 0) fired.add("PROPOSE");
  if (effects.change_sets_created.length > 0) fired.add("CHANGESET");
  if (effects.jobs_enqueued.some((j) => j.kind === "plan_work")) {
    fired.add("RUN_PLAN");
  }
  return fired;
}

export async function runDialogueScenario(
  scenario: DialogueScenario,
  opts: {
    /** ターンごとの provider。stub では stub_response を返すものを作る。 */
    providerForTurn: (turn: DialogueTurn, index: number) => Provider;
    apiKey: string;
    model: string;
  },
): Promise<EvalResult> {
  const work = makeWork(scenario.work);
  const world = makeEvalWorld(work, canonSeedsToFacts(scenario.canon_facts, work.id), {
    provider_name: "eval",
    model: opts.model,
  });
  const turns: TurnResult[] = [];
  const failures: string[] = [];

  for (const [i, turn] of scenario.turns.entries()) {
    const turnNo = i + 1;
    const effects = emptyEffects();
    const completed: unknown[] = [];
    const failed: string[] = [];

    // ユーザー発言を履歴に追加してから orchestrator_turn を走らせる。
    world.messages.push({
      id: `eval-user-msg-${turnNo}`,
      thread_id: world.thread.id,
      role: "user",
      content: turn.user,
      job_id: null,
      created_at: world.messages.length,
    });

    const ctx = makeEvalCtx({
      world,
      provider: opts.providerForTurn(turn, i),
      apiKey: opts.apiKey,
      effects,
      completed,
      failed,
    });
    const payload = OrchestratorTurnPayloadSchema.parse({
      thread_id: world.thread.id,
      work_id: world.work.id,
      user_ref: world.user_ref,
      key_ref: world.key_ref,
      provider: world.provider_name,
      model: world.model,
      trigger_message_id: `eval-user-msg-${turnNo}`,
    });
    const job = makeJob(JOB_KIND_ORCHESTRATOR_TURN, payload);
    const outcome = await runJob(job, ctx);

    const fired = firedMarkers(effects);
    const turnFailures: string[] = [];
    const expect = turn.expect;

    if (outcome !== "completed") {
      turnFailures.push(
        `ジョブが完了しませんでした (${outcome}): ${failed.join("; ")}`,
      );
    }

    for (const m of expect.markers) {
      if (!fired.has(m)) {
        turnFailures.push(`マーカー ${m} が発火しませんでした`);
      }
    }
    for (const m of expect.forbidden_markers) {
      if (fired.has(m)) {
        turnFailures.push(`禁止マーカー ${m} が発火しました`);
      }
    }
    for (const kw of expect.contains) {
      if (!effects.assistant_text.includes(kw)) {
        turnFailures.push(`応答に「${kw}」が含まれません`);
      }
    }
    for (const kw of expect.not_contains) {
      if (effects.assistant_text.includes(kw)) {
        turnFailures.push(`応答に禁止文字列「${kw}」が含まれています`);
      }
    }
    // 不変条件: 対話ターンから本文生成ジョブは起票されない
    // (契約なしに本文を作らない、spec §4.4/P3)。
    if (
      effects.jobs_enqueued.some((j) => j.kind === JOB_KIND_GENERATE_SCENE)
    ) {
      turnFailures.push("対話ターンから generate_scene が起票されました");
    }

    turns.push({
      turn: turnNo,
      user: turn.user,
      assistant_text: effects.assistant_text,
      fired_markers: [...fired],
      status: turnFailures.length === 0 ? "pass" : "fail",
      failures: turnFailures,
    });
    failures.push(
      ...turnFailures.map((f) => `ターン${turnNo}: ${f}`),
    );
  }

  return {
    name: scenario.name,
    kind: "dialogue",
    status: failures.length === 0 ? "pass" : "fail",
    description: scenario.description,
    turns,
    metrics: {
      turns: scenario.turns.length,
      canon_facts: world.canon_facts.length,
      proposals: world.proposals.length,
      jobs_enqueued: world.jobs.length,
    },
    failures,
  };
}
