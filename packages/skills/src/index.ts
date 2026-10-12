// ---------------------------------------------------------------------------
// @houchi/skills — スキルレジストリ (Phase 2a, spec §7.1)
//
// スキル = { name, description, tools, buildPrompt(input), outputSchema }。
// 実行は harness 側の runSkillStep が担う (provider 呼び出し→JSON抽出→zod検証
// →失敗時 1 回だけ修正要求リトライ)。この層は「プロンプトと型」だけを持つ。
// ---------------------------------------------------------------------------

import { z } from "zod";
import {
  canonFactLabel,
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

/**
 * 正典メモのプロンプト入力 1 件。文字列なら無印の確定正典として、
 * CanonFact 形なら commitment/disclosure のラベルを先頭に付けて渡す
 * (spec §4.3: 未確定と秘密をモデルに明示する)。
 */
export type CanonFactPromptItem =
  | string
  | {
      statement: string;
      commitment?: string | undefined;
      disclosure?: string | undefined;
    };

function renderCanonFact(f: CanonFactPromptItem): string {
  if (typeof f === "string") return f;
  return `${canonFactLabel(f)}${f.statement}`;
}

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
  /** 正典メモ (ラベル付き: [仮置き]/[未判断] 等は未確定)。 */
  canon_facts: CanonFactPromptItem[];
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
            ? input.canon_facts.map((f) => `- ${renderCanonFact(f)}`).join("\n")
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
  /** 関連する正典メモ (ラベル付き: [仮置き]/[秘密] 等)。 */
  canon_facts: CanonFactPromptItem[];
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
          "正典メモの先頭ラベル: [約束済み]=近い将来の計画として約束済み。",
          "[仮置き]/[未判断]/[意図的未確定]=未確定なので、本文の確定事項として使ってはいけません。",
          "[秘密]=読者にも未登場人物にも知られたくない事実なので、本文には絶対に書かないでください。",
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
            ? input.canon_facts.map((f) => `- ${renderCanonFact(f)}`).join("\n")
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
  canon_facts: CanonFactPromptItem[];
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
          "violations に列挙してください。",
          "正典メモの先頭ラベル: [仮置き]/[未判断]/[意図的未確定] は未確定です。",
          "本文が未確定の正典を確定事項として使っていたら違反です (high 相当)。",
          "[秘密] の正典の内容が本文に出ていたら秘密の早期開示として違反です。",
          "severity は",
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
            ? input.canon_facts.map((f) => `- ${renderCanonFact(f)}`).join("\n")
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
// fixer — review findings から修正候補の変更セット ops を提案する
// ---------------------------------------------------------------------------

export type FixerFindingInput = {
  /** findings 配列内の添字 (fixes 側からこの番号で参照する)。 */
  index: number;
  kind: string;
  severity: string;
  summary: string;
  detail: string;
  /** 指摘対象のシーン (rewrite_scene 対象)。scene_id を持たない finding では null。 */
  scene: {
    id: string;
    title: string;
    prose_md: string;
    /** 最新の Writing Contract (JSON)。無ければ null。 */
    contract: unknown;
  } | null;
  /** 指摘対象の正典メモ (revise_fact 対象)。fact_id を持たない finding では null。 */
  fact: { id: string; statement: string } | null;
};

export type FixerInput = {
  work: { title: string; premise: string };
  /** レビュー対象だった変更セット。 */
  change_set: { title: string; description: string };
  canon_facts: {
    id: string;
    statement: string;
    commitment?: string | undefined;
    disclosure?: string | undefined;
  }[];
  findings: FixerFindingInput[];
};

const FixActionSchema = z.object({
  /** 対象 finding の添字。 */
  finding_index: z.number().int().min(0),
  /** どう直すか。none = 自動修正しない (人間判断に任せる)。 */
  action: z.enum(["rewrite_scene", "revise_fact", "add_fact", "none"]),
  /**
   * rewrite_scene → 書き換え後の本文全文 (markdown)。
   * revise_fact → 修正後の正典宣言文。add_fact → 追加する宣言文。
   * none のときは空文字列。
   */
  text: z.string().default(""),
  /** revise_fact の対象正典 id (正典メモ一覧に記載された fact_id をそのまま書く)。 */
  fact_id: z.string().default(""),
  /** その修正方針を選んだ理由 (人間向け, 1行)。 */
  reason: z.string().default(""),
});

export const FixPlanSchema = z.object({
  fixes: z.array(FixActionSchema).default([]),
});
export type FixPlan = z.infer<typeof FixPlanSchema>;

export const fixerSkill: SkillDefinition<FixerInput, FixPlan> = {
  name: "fixer",
  description:
    "レビュー findings に対し、シーン書き換え/正典改訂/正典追加の修正候補を提案する。",
  tools: ["readFile", "writePropose"],
  buildPrompt(input) {
    const findingBlocks = input.findings.map((f) => {
      const lines = [
        `### finding #${f.index} [${f.kind}/${f.severity}]`,
        `概要: ${f.summary}`,
        f.detail ? `詳細: ${f.detail}` : "",
      ];
      if (f.scene) {
        lines.push(
          `対象シーン: ${f.scene.title} (scene_id: ${f.scene.id})`,
          f.scene.contract
            ? `契約: ${JSON.stringify(f.scene.contract)}`
            : "",
          "現在の本文:",
          f.scene.prose_md || "(空)",
        );
      }
      if (f.fact) {
        lines.push(`対象正典: ${f.fact.statement} (fact_id: ${f.fact.id})`);
      }
      return lines.filter((s) => s !== "").join("\n");
    });

    return [
      {
        role: "system",
        content: [
          "あなたは小説作品の「修正案担当」です。",
          "レビューで検出された各 finding に対し、修正候補を立ててください。",
          "修正は必ず以下のいずれかで表現します:",
          "- rewrite_scene: シーン本文を書き換える (text に修正後の本文全文を書く)",
          "- revise_fact: 既存の正典宣言を書き換える (text に新しい宣言文を書く)",
          "- add_fact: 新しい正典宣言を追加する (text に宣言文を書く)",
          "- none: 自動修正しない (人間の判断に任せる。text は空にする)",
          "",
          "方針:",
          "- finding の対象が本文の不整合なら rewrite_scene を選び、",
          "  契約 (POV/必須イベント/禁止事項) と正典に矛盾しない全文を書き直す。",
          "- 対象が正典の記述自体の問題なら revise_fact。",
          "- 不足している事実の補完なら add_fact。",
          "- 情報不足や判断が作者のものに踏み込む場合は none。",
          "- rewrite_scene の text は本文全体を書くこと。一部だけの差分ではなく全文。",
          "",
          "出力形式:",
          '{ "fixes": [ { "finding_index": 0, "action": "rewrite_scene|revise_fact|add_fact|none", "text": "…", "fact_id": "…", "reason": "…" } ] }',
          "revise_fact のとき fact_id は必須 (他の action では空にする)。",
          "",
          JSON_OUTPUT_DIRECTIVE,
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `【作品】${input.work.title}`,
          `前提: ${input.work.premise}`,
          "",
          `【レビュー対象の変更セット】${input.change_set.title}`,
          input.change_set.description || "",
          "",
          "【正典メモ】",
          input.canon_facts.length > 0
            ? input.canon_facts
                .map((f) => `- ${renderCanonFact(f)} (fact_id: ${f.id})`)
                .join("\n")
            : "(なし)",
          "",
          "【検出された findings】",
          ...findingBlocks,
        ]
          .filter((s) => s !== "")
          .join("\n"),
      },
    ];
  },
  outputSchema: FixPlanSchema,
};

// ---------------------------------------------------------------------------
// レジストリ
// ---------------------------------------------------------------------------

export const SKILLS = {
  planner: plannerSkill,
  writer: writerSkill,
  critic: criticSkill,
  fixer: fixerSkill,
} as const;

export type SkillName = keyof typeof SKILLS;
