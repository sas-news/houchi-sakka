// ---------------------------------------------------------------------------
// シナリオファイルのスキーマ (JSON)。scenarios/*.json を読む。
//
// golden dialogue (spec §10 Orchestrator Evals): ユーザー発言列を orchestrator
//   に流し、各ターンの挙動 (出すマーカー/出さないマーカー/文言) を検証する。
// 生成品質 (spec §10 Story Evals): 固定の契約+正典+入力から writer 生成させ、
//   validators (決定的検査) + critic (AI検査) で採点する。
// ---------------------------------------------------------------------------

import { z } from "zod";
import {
  CommitmentLevelSchema,
  DisclosurePolicySchema,
  WritingContractPayloadSchema,
  type CommitmentLevel,
  type DisclosurePolicy,
  type WritingContractPayload,
} from "@houchi/contracts";

/** orchestrator 応答末尾マーカーの種別。 */
export const MARKER_KINDS = [
  "WORK_PATCH",
  "CANON_FACTS",
  "PROPOSE",
  "RUN_PLAN",
  "CHANGESET",
] as const;
export type MarkerKind = (typeof MARKER_KINDS)[number];
const MarkerKindSchema = z.enum(MARKER_KINDS);

const CanonFactSeedSchema = z.object({
  statement: z.string().min(1),
  commitment: CommitmentLevelSchema.optional(),
  disclosure: DisclosurePolicySchema.optional(),
  provenance: z.string().default("orchestrator"),
});
export type CanonFactSeed = z.infer<typeof CanonFactSeedSchema>;

// --- golden dialogue -------------------------------------------------------

export const DialogueExpectSchema = z.object({
  /** このターンで必ず発火すべきマーカー (実効果として検出)。 */
  markers: z.array(MarkerKindSchema).default([]),
  /** このターンで発火してはいけないマーカー。 */
  forbidden_markers: z.array(MarkerKindSchema).default([]),
  /** assistant 応答本文に含まれるべき文字列。 */
  contains: z.array(z.string()).default([]),
  /** assistant 応答本文に含まれてはいけない文字列。 */
  not_contains: z.array(z.string()).default([]),
});
export type DialogueExpect = z.infer<typeof DialogueExpectSchema>;

export const DialogueTurnSchema = z.object({
  /** このターンのユーザー発言。 */
  user: z.string().min(1),
  /** stub provider が返す応答 (EVAL_LIVE では無視され実モデルが生成する)。 */
  stub_response: z.string().optional(),
  expect: DialogueExpectSchema.default({}),
});
export type DialogueTurn = z.infer<typeof DialogueTurnSchema>;

export const DialogueScenarioSchema = z.object({
  kind: z.literal("dialogue"),
  name: z.string().min(1),
  description: z.string().default(""),
  work: z
    .object({
      title: z.string().default(""),
      premise: z.string().default(""),
      genre: z.string().default(""),
      status: z.enum(["setup", "active"]).default("setup"),
    })
    .default({}),
  canon_facts: z.array(CanonFactSeedSchema).default([]),
  turns: z.array(DialogueTurnSchema).min(1),
});
export type DialogueScenario = z.infer<typeof DialogueScenarioSchema>;

// --- 生成品質 ----------------------------------------------------------------

export const GenerationExpectSchema = z.object({
  /** マージ済み findings にこの (rule, severity) の組が存在すること。 */
  findings_include: z
    .array(
      z.object({
        rule: z.string().min(1),
        severity: z.enum(["high", "medium", "low", "info"]).optional(),
      }),
    )
    .default([]),
  /** high findings の許容上限。 */
  max_high: z.number().int().optional(),
  /** high findings の必須下限。 */
  min_high: z.number().int().optional(),
  /** ヒューリスティックで未検出になる必須イベント数の期待値。 */
  required_events_missing: z.number().int().optional(),
});
export type GenerationExpect = z.infer<typeof GenerationExpectSchema>;

export const GenerationScenarioSchema = z.object({
  kind: z.literal("generation"),
  name: z.string().min(1),
  description: z.string().default(""),
  scene_title: z.string().min(1),
  scene_purpose: z.string().default(""),
  contract: WritingContractPayloadSchema,
  canon_facts: z.array(CanonFactSeedSchema).default([]),
  instruction: z.string().optional(),
  /** writer の stub 応答 (WriterOutput の JSON。EVAL_LIVE では無視)。 */
  writer_response: z.unknown().optional(),
  /** critic の stub 応答 (CriticOutput の JSON。EVAL_LIVE では無視)。 */
  critic_response: z.unknown().optional(),
  expect: GenerationExpectSchema.default({}),
});
export type GenerationScenario = z.infer<typeof GenerationScenarioSchema>;

export const ScenarioSchema = z.discriminatedUnion("kind", [
  DialogueScenarioSchema,
  GenerationScenarioSchema,
]);
export type Scenario = z.infer<typeof ScenarioSchema>;

// --- 実行時の内部表現 --------------------------------------------------------

/** シナリオの正典シードを CanonFact 形に展開する。 */
export function canonSeedsToFacts(
  seeds: CanonFactSeed[],
  workId: string,
): {
  id: string;
  work_id: string;
  statement: string;
  commitment: CommitmentLevel;
  disclosure: DisclosurePolicy;
  provenance: string;
  valid_from_rev: number | null;
  valid_to_rev: number | null;
  created_at: number;
}[] {
  return seeds.map((s, i) => ({
    id: `eval-fact-${i + 1}`,
    work_id: workId,
    statement: s.statement,
    commitment: s.commitment ?? "fixed",
    disclosure: s.disclosure ?? "normal",
    provenance: s.provenance,
    valid_from_rev: null,
    valid_to_rev: null,
    created_at: i,
  }));
}

export { type WritingContractPayload };
