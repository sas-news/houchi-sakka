import {
  WorkPatchRequestSchema,
  type ChatMessage,
  type ProviderInputMessage,
  type Work,
  type WorkPatchRequest,
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

現在の範囲では、本文の生成・設定(正典)の確定・変更セットの作成は行いません。作者が本文執筆や詳細設定を求めてきた場合は「この機能は準備中です」と正直に伝え、作品の方向性を詰める対話に誘導してください。

出力形式: 返答は日本語のプレーンテキスト。体裁の更新がある場合のみ、返答の最終行に次の形式で1行だけ書くこと(それ以外の行には使わない):
<<WORK_PATCH {"title": "…", "premise": "…", "genre": "…", "status": "active"}>>
- 更新しないフィールドは省略する。更新がなければ WORK_PATCH 行自体を出さない。
- status には "setup" または "active" だけが使える。`;

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

/** orchestrator_turn への入力を組み立てる (作品情報+スレッド履歴)。 */
export function buildOrchestratorInput(input: {
  work: Work;
  messages: ChatMessage[];
}): ProviderInputMessage[] {
  const { work } = input;
  const workSummary = [
    `作品タイトル: ${work.title || "(未設定)"}`,
    `前提/あらすじ: ${work.premise || "(未設定)"}`,
    `ジャンル: ${work.genre || "(未設定)"}`,
    `状態: ${work.status}`,
  ].join("\n");
  const history: ProviderInputMessage[] = input.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
  return [
    { role: "developer", content: ORCHESTRATOR_SYSTEM_PROMPT },
    {
      role: "developer",
      content: `現在の作品情報:\n${workSummary}`,
    },
    ...history,
  ];
}
