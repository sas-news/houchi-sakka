// ---------------------------------------------------------------------------
// @houchi/skills — スキルレジストリ (Phase 2a, spec §7.1)
//
// スキル = { name, description, tools, buildPrompt(input), outputSchema }。
// 実行は harness 側の runSkillStep が担う (provider 呼び出し→JSON抽出→zod検証
// →失敗時 1 回だけ修正要求リトライ)。この層は「プロンプトと型」だけを持つ。
// ---------------------------------------------------------------------------

import { z } from "zod";
import {
  DependencyEdgeInputSchema,
  PlanProposalPayloadSchema,
  type PlanProposalPayload,
  type ProviderInputMessage,
  type WritingContractPayload,
} from "@houchi/contracts";

/** スキル定義。I=入力型, O=出力型 (zod で検証される)。 */
export type SkillDefinition<I, O> = {
  /** ジョブ・ログ上の一意名。 */
  name: string;
  /** 人向けの説明。 */
  description: string;
  /** このスキルが使ってよいツール名 (宣言のみ。実行層はこれを見て制御する)。 */
  tools: string[];
  /** input から provider 投入メッセージを組み立てる。 */
  buildPrompt(input: I): ProviderInputMessage[];
  /** JSON 構造化出力の検証スキーマ (default 付きで入力型が違ってよい)。 */
  outputSchema: z.ZodType<O, z.ZodTypeDef, unknown>;
};

/** プロンプト末尾に付ける JSON 出力指示。 */
const JSON_OUTPUT_DIRECTIVE =
  "出力は JSON オブジェクト1つだけを返してください。前後に説明文・コードフェンスを付けないでください。";

// ---------------------------------------------------------------------------
// planner — 作品の計画 (episodes→scenes の骨格) を作る
// ---------------------------------------------------------------------------

export type PlannerInput = {
  work: {
    title: string;
    premise: string;
    genre: string;
    /** StoryCharter / NarrativePolicy の JSON (未作成は null)。 */
    charter: unknown;
    policy: unknown;
  };
  /** /plan/tree.md の内容 (現状の骨格)。 */
  plan_tree: string;
  /** 正典メモの宣言文リスト。 */
  canon_facts: string[];
  /** 作者からの計画指示 (あれば)。 */
  guidance?: string;
};

export type PlannerOutput = PlanProposalPayload;

export const plannerSkill: SkillDefinition<PlannerInput, PlannerOutput> = {
  name: "planner",
  description:
    "作品の計画を立てる。前提・憲章・既存の骨格から episodes→scenes の構成案を JSON で返す。",
  tools: ["listFiles", "readFile", "writePropose"],
  buildPrompt(input) {
    return [
      {
        role: "system",
        content: [
          "あなたは小説作品の「計画担当」です。",
          "作品の前提・憲章・ポリシーと現状の計画ツリーから、",
          "エピソードとその配下のシーン構成案を作ってください。",
          "各シーンにはタイトルと目的 (purpose) を付けてください。",
          "既存の計画ツリーがある場合は、それを壊さない追加分のみを提案してください。",
          "",
          "出力形式:",
          '{ "episodes": [ { "title": "第1話 …", "scenes": [ { "title": "…", "purpose": "…" } ] } ] }',
          "",
          JSON_OUTPUT_DIRECTIVE,
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `【作品】${input.work.title}`,
          `前提: ${input.work.premise}`,
          `ジャンル: ${input.work.genre}`,
          input.work.charter !== null
            ? `憲章: ${JSON.stringify(input.work.charter)}`
            : "憲章: (未作成)",
          input.work.policy !== null
            ? `ポリシー: ${JSON.stringify(input.work.policy)}`
            : "ポリシー: (未作成)",
          "",
          "【現状の計画ツリー】",
          input.plan_tree,
          "",
          "【正典メモ】",
          input.canon_facts.length > 0
            ? input.canon_facts.map((f) => `- ${f}`).join("\n")
            : "(なし)",
          "",
          input.guidance ? `【作者の指示】\n${input.guidance}` : "",
        ]
          .filter((s) => s !== "")
          .join("\n"),
      },
    ];
  },
  outputSchema: PlanProposalPayloadSchema,
};

// ---------------------------------------------------------------------------
// writer — Writing Contract に従って本文を書く
// ---------------------------------------------------------------------------

export type WriterInput = {
  /** 審査対象の Writing Contract (approved)。 */
  contract: WritingContractPayload;
  /** 対象シーンのタイトル/目的。 */
  scene_title: string;
  scene_purpose: string;
  /** 関連する正典メモ。 */
  canon_facts: string[];
  /** 直前シーンの要約 (連続性のため。あれば)。 */
  prev_scene_summary?: string;
  /** critic の検査結果 (revise 段で渡す)。 */
  critique?: CriticOutput;
  /** 作者からの書き直し指示 (再生成ジョブ)。 */
  instruction?: string;
};

export const WriterOutputSchema = z.object({
  /** 生成本文 (markdown。段落は空行区切り)。 */
  prose_md: z.string().min(1),
  /** 本文生成で新たに確定した正典メモ。 */
  canon_facts_new: z.array(z.string()).default([]),
  /** この本文が依拠した正典/計画の参照 (依存宣言, spec §6.4)。 */
  depends_on: z.array(DependencyEdgeInputSchema).default([]),
});
export type WriterOutput = z.infer<typeof WriterOutputSchema>;

export const writerSkill: SkillDefinition<WriterInput, WriterOutput> = {
  name: "writer",
  description:
    "Writing Contract に従って本文を執筆する。critic の検査結果を受けて改稿もできる。",
  tools: ["readFile", "writePropose"],
  buildPrompt(input) {
    const contractLines = [
      `視点 (POV): ${input.contract.pov}`,
      `文体・役割: ${input.contract.role}`,
      `必須イベント: ${input.contract.required_events.join("、") || "(なし)"}`,
      `禁止事項: ${input.contract.forbidden.join("、") || "(なし)"}`,
      `記憶ノート: ${input.contract.knowledge_notes || "(なし)"}`,
      `接続: ${input.contract.connections || "(なし)"}`,
    ].join("\n");

    const critiqueBlock = input.critique
      ? [
          "",
          "【検査結果 — この指摘を直して書き直してください】",
          ...input.critique.violations.map(
            (v) => `- [${v.severity}] ${v.rule}: ${v.detail}`,
          ),
          ...input.critique.notes.map((n) => `- (note) ${n}`),
        ]
      : [];

    return [
      {
        role: "system",
        content: [
          "あなたは小説作品の「執筆担当」です。",
          "渡された Writing Contract に厳密に従って本文を書いてください。",
          "禁止事項を破ってはいけません。必須イベントはすべて含めてください。",
          "正典メモと矛盾する設定を新たに作らないでください。",
          input.critique
            ? "検査で指摘された問題をすべて解消した版を書いてください。"
            : "",
          "",
          "出力形式:",
          '{ "prose_md": "本文…", "canon_facts_new": ["新たに確定した事実"], "depends_on": [ { "target_kind": "canon_fact|plan|scene", "target_ref": "依拠した参照" } ] }',
          "",
          JSON_OUTPUT_DIRECTIVE,
        ]
          .filter((s) => s !== "")
          .join("\n"),
      },
      {
        role: "user",
        content: [
          `【シーン】${input.scene_title}`,
          `目的: ${input.scene_purpose}`,
          "",
          "【Writing Contract】",
          contractLines,
          "",
          "【正典メモ】",
          input.canon_facts.length > 0
            ? input.canon_facts.map((f) => `- ${f}`).join("\n")
            : "(なし)",
          ...(input.prev_scene_summary
            ? ["", "【直前シーンの要約】", input.prev_scene_summary]
            : []),
          ...critiqueBlock,
          ...(input.instruction
            ? ["", "【作者の書き直し指示】", input.instruction]
            : []),
        ].join("\n"),
      },
    ];
  },
  outputSchema: WriterOutputSchema,
};

// ---------------------------------------------------------------------------
// critic — 生成本文を契約・禁止事項・正典との矛盾で検査する
// ---------------------------------------------------------------------------

export type CriticInput = {
  contract: WritingContractPayload;
  scene_title: string;
  /** 検査対象の本文。 */
  prose_md: string;
  canon_facts: string[];
};

export const CriticOutputSchema = z.object({
  violations: z.array(
    z.object({
      /** 違反したルール (contract.forbidden / required_events / canon / pov など)。 */
      rule: z.string(),
      detail: z.string(),
      severity: z.enum(["high", "medium", "low"]),
    }),
  ),
  notes: z.array(z.string()).default([]),
});
export type CriticOutput = z.infer<typeof CriticOutputSchema>;

export const criticSkill: SkillDefinition<CriticInput, CriticOutput> = {
  name: "critic",
  description:
    "生成本文を Writing Contract 適合・禁止事項・正典矛盾の観点で検査する。",
  tools: ["readFile"],
  buildPrompt(input) {
    return [
      {
        role: "system",
        content: [
          "あなたは小説作品の「検査担当」です。",
          "生成本文が Writing Contract に適合しているか検査してください。",
          "必須イベントの欠落、禁止事項への抵触、POV逸脱、正典メモとの矛盾を",
          "violations に列挙してください。severity は",
          "high=必須イベント欠落・禁止事項違反・正典と明確に矛盾、",
          "medium=契約の意図から外れているが致命傷ではない、low=些細な違和感、",
          "と判定してください。",
          "",
          "出力形式:",
          '{ "violations": [ { "rule": "…", "detail": "…", "severity": "high|medium|low" } ], "notes": ["補足"] }',
          "違反がなければ violations は空配列にしてください。",
          "",
          JSON_OUTPUT_DIRECTIVE,
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `【シーン】${input.scene_title}`,
          "",
          "【Writing Contract】",
          `視点 (POV): ${input.contract.pov}`,
          `文体・役割: ${input.contract.role}`,
          `必須イベント: ${input.contract.required_events.join("、") || "(なし)"}`,
          `禁止事項: ${input.contract.forbidden.join("、") || "(なし)"}`,
          `記憶ノート: ${input.contract.knowledge_notes || "(なし)"}`,
          "",
          "【正典メモ】",
          input.canon_facts.length > 0
            ? input.canon_facts.map((f) => `- ${f}`).join("\n")
            : "(なし)",
          "",
          "【検査対象の本文】",
          input.prose_md,
        ].join("\n"),
      },
    ];
  },
  outputSchema: CriticOutputSchema,
};

// ---------------------------------------------------------------------------
// レジストリ
// ---------------------------------------------------------------------------

export const SKILLS = {
  planner: plannerSkill,
  writer: writerSkill,
  critic: criticSkill,
} as const;

export type SkillName = keyof typeof SKILLS;
