import { z } from "zod";
import {
  ProposeScenePayloadSchema,
  WorkPatchRequestSchema,
  type ChatMessage,
  type ProviderInputMessage,
  type Work,
  type WorkPatchRequest,
  type WritingContractPayload,
} from "@houchi/contracts";

/**
 * packages/prompts — バージョン管理されたプロンプトと出力スキーマ (spec §8.2)。
 * orchestrator_turn ジョブが使うシステムプロンプトと、
 * 返答に埋め込む構造化パッチ (WORK_PATCH) のパーサーを提供する。
 */

/**
 * オーケストレーターの日本語システムプロンプト (Phase 1a)。
 * spec §3.3 の対話原則 + Phase 1a の範囲限定
 * (本文生成・正典・変更セットはまだ実装しない) を反映する。
 */
export const ORCHESTRATOR_SYSTEM_PROMPT = `あなたは創作パートナー「放置作家」のオーケストレーターです。作者との対話を受け、創作意図を聞き出し、作品の前提を対話で固めるのがあなたの役割です。

振る舞いの原則:
- 一度に大量の質問を投げず、最も重要な不確定事項から1つずつ確認する。
- 決定事項・暫定案・未決定事項・意図的に開けておく事項を区別して要約する。
- 作者が曖昧な表現を使った場合、重要な意味を勝手に確定しない。
- 過去の決定と矛盾する希望が来た場合、黙って上書きせず、どの決定が変わるかを説明する。
- 作品の体裁(タイトル・前提・ジャンル)が対話で固まったと判断したときだけ、下記の WORK_PATCH 行で更新を提案する。
- 対話から得られた創作上の確定事項(設定・キャラ・世界観など)は CANON_FACTS 行で正典メモとして記録する。

本文生成の提案 (PROPOSE):
- 作者が本文を書きたい意思を示し、かつシーンの目的・視点・必須イベントなどの契約要素が対話で揃ったときだけ、PROPOSE 行で「話+シーン+Writing Contract」の提案を出す。契約要素が足りない場合は提案せず、不足分を質問して固める。
- 提案は1返答につき1件まで。保留中の提案がある間は新しい提案を出さず、作者の承認/却下/修正指示を待つ。

出力形式: 返答は日本語のプレーンテキスト。マーカー行は返答の末尾にだけ書く(各行1行ずつ、順不同・必要なものだけ):
<<WORK_PATCH {"title": "…", "premise": "…", "genre": "…", "status": "active"}>>
<<CANON_FACTS ["確定した設定や決定事項", "…"]>>
<<PROPOSE {"episode_title": "第1話", "scene_title": "…", "scene_purpose": "…", "contract": {"role": "…", "pov": "…", "required_events": ["…"], "forbidden": ["…"], "knowledge_notes": "…", "connections": "…"}}>>
- WORK_PATCH: 更新しないフィールドは省略。更新がなければ行自体を出さない。status には "setup" または "active" だけが使える。
- CANON_FACTS: 新たに確定した事項だけを列挙する。既に記録済みの内容は繰り返さない。なければ出さない。
- PROPOSE: contract の各フィールドは対話で確定した内容のみ書く。episode_title を省略すると最新の話に追加される。`;

/** WORK_PATCH 行のマーカー。返答最終行のみをパース対象にする。 */
const WORK_PATCH_LINE = /^<<WORK_PATCH\s+(.+?)>>$/;

/**
 * orchestrator 応答テキストから WORK_PATCH 行を分離する。
 * - 最後の非空行が <<WORK_PATCH {...}>> 形式なら本文から取り除く。
 * - JSON パース・スキーマ検証に失敗した場合は patch=null (行は取り除き、
 *   本文として残さない)。
 */
export function parseWorkPatch(outputText: string): {
  replyText: string;
  patch: WorkPatchRequest | null;
} {
  const trimmedEnd = outputText.replace(/\s+$/, "");
  const lines = trimmedEnd.split("\n");
  const last = lines[lines.length - 1]?.trim() ?? "";
  const m = last.match(WORK_PATCH_LINE);
  if (!m) return { replyText: outputText.trim(), patch: null };
  const replyText = lines
    .slice(0, -1)
    .join("\n")
    .replace(/\s+$/, "");
  try {
    const parsed = WorkPatchRequestSchema.parse(JSON.parse(m[1]!));
    return { replyText, patch: parsed };
  } catch {
    return { replyText, patch: null };
  }
}

/** orchestrator_turn への入力を組み立てる (作品情報+正典+保留提案+履歴)。 */
export function buildOrchestratorInput(input: {
  work: Work;
  messages: ChatMessage[];
  canonFacts?: string[];
  pendingProposals?: string[];
}): ProviderInputMessage[] {
  const { work } = input;
  const lines = [
    `作品タイトル: ${work.title || "(未設定)"}`,
    `前提/あらすじ: ${work.premise || "(未設定)"}`,
    `ジャンル: ${work.genre || "(未設定)"}`,
    `状態: ${work.status}`,
  ];
  if (input.canonFacts && input.canonFacts.length > 0) {
    lines.push(
      "記録済みの正典メモ:",
      ...input.canonFacts.map((f) => `- ${f}`),
    );
  }
  if (input.pendingProposals && input.pendingProposals.length > 0) {
    lines.push(
      "保留中の提案 (作者の決定待ち・再提案するな):",
      ...input.pendingProposals.map((p) => `- ${p}`),
    );
  }
  const history: ProviderInputMessage[] = input.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
  return [
    { role: "developer", content: ORCHESTRATOR_SYSTEM_PROMPT },
    {
      role: "developer",
      content: `現在の作品情報:\n${lines.join("\n")}`,
    },
    ...history,
  ];
}

// ---------------------------------------------------------------------------
// Phase 1b: PROPOSE / CANON_FACTS マーカー + 本文生成プロンプト
// ---------------------------------------------------------------------------

/** 応答の末尾行の `<<PROPOSE {…}>>` マーカー。 */
export const PROPOSE_LINE = /^<<PROPOSE\s+(.+?)>>$/;

/** 応答の末尾行の `<<CANON_FACTS [...]>>` マーカー。 */
export const CANON_FACTS_LINE = /^<<CANON_FACTS\s+(.+?)>>$/;

export type ProposeMarker = {
  episodeTitle?: string;
  sceneTitle: string;
  scenePurpose: string;
  contract: WritingContractPayload;
};

/**
 * オーケストレーター応答の末尾ブロックから WORK_PATCH / PROPOSE /
 * CANON_FACTS マーカーを抜き出す。
 *
 * マーカーは応答の末尾にのみ有効とし、連続するマーカー行を順不同で読む。
 * いずれも JSON が壊れていた場合はそのマーカーを捨てて本文に残す。
 */
export function parseOrchestratorMarkers(text: string): {
  cleanText: string;
  patch: WorkPatchRequest | null;
  proposal: ProposeMarker | null;
  canonFacts: string[];
} {
  const lines = text.split("\n");
  let end = lines.length;
  const patches: WorkPatchRequest[] = [];
  const proposals: ProposeMarker[] = [];
  const factLists: string[][] = [];

  // 末尾の連続するマーカー行を後ろから読む
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim() === "") {
      end = i;
      continue;
    }
    const patchMatch = line.match(WORK_PATCH_LINE);
    const proposeMatch = line.match(PROPOSE_LINE);
    const canonMatch = line.match(CANON_FACTS_LINE);
    if (patchMatch) {
      try {
        patches.unshift(WorkPatchRequestSchema.parse(JSON.parse(patchMatch[1]!)));
        end = i;
        continue;
      } catch {
        break;
      }
    }
    if (proposeMatch) {
      try {
        const raw = JSON.parse(proposeMatch[1]!);
        const p = ProposeScenePayloadSchema.parse(raw);
        proposals.unshift({
          ...(p.episode_title ? { episodeTitle: p.episode_title } : {}),
          sceneTitle: p.scene_title,
          scenePurpose: p.scene_purpose,
          contract: p.contract,
        });
        end = i;
        continue;
      } catch {
        break;
      }
    }
    if (canonMatch) {
      try {
        const raw = JSON.parse(canonMatch[1]!);
        const arr = z.array(z.string()).parse(raw);
        factLists.unshift(arr);
        end = i;
        continue;
      } catch {
        break;
      }
    }
    break;
  }

  const cleanText = lines.slice(0, end).join("\n").trimEnd();
  return {
    cleanText,
    patch: patches.length > 0 ? patches[patches.length - 1]! : null,
    proposal: proposals.length > 0 ? proposals[proposals.length - 1]! : null,
    canonFacts: factLists.flat(),
  };
}

/** 本文生成 (generate_scene) 用のモデル入力を組み立てる。 */
export function buildSceneWriterInput(ctx: {
  work: { title: string; premise: string; genre: string };
  charter: unknown | null;
  policy: unknown | null;
  canonFacts: string[];
  contract: WritingContractPayload;
  sceneTitle: string;
  scenePurpose: string;
  prevScenes: { title: string; excerpt: string }[];
  instruction?: string;
}): ProviderInputMessage[] {
  const system =
    "あなたは日本語の小説の本文を執筆する作家エージェントです。" +
    "指定された Writing Contract を厳守してシーン本文のみを書いてください。" +
    "出力は本文のみ。見出し・解説・メタ発言・箇条書きは書かない。" +
    "段落は空行で区切る。";

  const contractLines = [
    `シーン: ${ctx.sceneTitle}`,
    ctx.scenePurpose ? `目的: ${ctx.scenePurpose}` : null,
    ctx.contract.role ? `このシーンの役割: ${ctx.contract.role}` : null,
    ctx.contract.pov ? `視点: ${ctx.contract.pov}` : null,
    ctx.contract.required_events.length > 0
      ? `必須イベント: ${ctx.contract.required_events.join(" / ")}`
      : null,
    ctx.contract.forbidden.length > 0
      ? `禁止事項: ${ctx.contract.forbidden.join(" / ")}`
      : null,
    ctx.contract.knowledge_notes
      ? `知識メモ: ${ctx.contract.knowledge_notes}`
      : null,
    ctx.contract.connections ? `前後への接続: ${ctx.contract.connections}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const parts = [
    `作品「${ctx.work.title}」(${ctx.work.genre || "ジャンル未指定"})`,
    ctx.work.premise ? `前提: ${ctx.work.premise}` : null,
    ctx.charter ? `創作憲章: ${JSON.stringify(ctx.charter)}` : null,
    ctx.policy ? `作風ポリシー: ${JSON.stringify(ctx.policy)}` : null,
    ctx.canonFacts.length > 0
      ? `正典メモ:\n${ctx.canonFacts.map((f) => `- ${f}`).join("\n")}`
      : null,
    ctx.prevScenes.length > 0
      ? `直前のシーン:\n${ctx.prevScenes
          .map((s) => `- ${s.title}: ${s.excerpt}`)
          .join("\n")}`
      : null,
    `---\n【Writing Contract】\n${contractLines}`,
    ctx.instruction ? `---\n書き直し指示: ${ctx.instruction}` : null,
  ]
    .filter((p) => p !== null)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "developer", content: parts },
  ];
}
