import { z } from "zod";
import {
  canonFactLabel,
  CanonFactInputSchema,
  ChangeSetOpSchema,
  ProposeScenePayloadSchema,
  WorkPatchRequestSchema,
  type CanonFactInput,
  type ChangeSetOp,
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
- 対話から得られた創作上の確定事項(設定・キャラ・世界観など)は CANON_FACTS 行で正典メモとして記録する。確度(コミットメント状態)を付けられる: "fixed"(確定・既定)/"committed"(約束済みの計画)/"provisional"(仮置き・本文では確定事項として使えない)/"open_by_design"(意図的な未確定)/"undecided"(未判断)。作者が「仮置きして」「未定だけど」などと言った事項は provisional で提案する。確度を付けるときは {"statement": "…", "commitment": "provisional"} の形で出す (確定の事項は文字列だけでよい)。読者にも未登場人物にも知られたくない事実は {"statement": "…", "disclosure": "secret"} で記録する。
- 記録済みの正典や作品の設定を変えたい・廃止したい場合、勝手に書き換えず CHANGESET 行で変更セットを提案する。既存の正典メモを直す時は必ずこちらを使う (CANON_FACTS は新規追加専用)。確度だけを変えるときは set_fact_commitment を使う。

変更の提案 (CHANGESET):
- 変更セットは作者の承認後にだけ適用される。影響しそうなシーン・契約は影響分析で示されるので、提案文には「何をなぜ変えるか」を書く。
- ops の語彙: {"op": "retire_fact", "fact_id": "…"} (正典を廃止) / {"op": "revise_fact", "fact_id": "…", "new_statement": "…", "commitment"?: "…", "disclosure"?: "…", "entity_refs"?: ["entity_id"]} (正典を書き換え) / {"op": "add_fact", "statement": "…", "commitment"?: "…", "disclosure"?: "…", "entity_refs"?: ["entity_id"]} (正典を追加。entity_refs で関連する登場要素を紐付けられる) / {"op": "set_fact_commitment", "fact_id": "…", "commitment": "…", "disclosure"?: "…"} (確度や秘密区分だけを変更) / {"op": "update_work", "patch": {"title"?: "…", "premise"?: "…", "genre"?: "…", "charter"?: {…}, "policy"?: {…}}} (作品の構造情報を変更)。
- 登場要素の ops: {"op": "add_entity", "kind": "character|place|org|item|concept", "name": "…", "summary"?: "…", "aliases"?: ["別名"]} (人物・場所・組織・物品・概念の追加) / {"op": "update_entity", "entity_id": "…", "name"?: "…", "summary"?: "…", "add_aliases"?: ["…"], "remove_aliases"?: ["…"]} (更新・別名の追加削除) / {"op": "retire_entity", "entity_id": "…"} (廃止)。「〜という人物/場所/組織を追加して」は add_entity で提案する。
- 知識の ops: {"op": "add_knowledge_event", "entity_id": "知った人物", "fact_id": "正典の fact_id", "scene_id"?: "…", "source"?: "目撃|伝聞|推論|記述"} (誰が何を知ったかを記録) / {"op": "retract_knowledge_event", "event_id": "…"} (取消)。視点人物が秘密を知っている場合は必ずこれで記録する。
- fact_id は「記録済みの正典メモ」に [fact_id: …]、entity_id は「登場要素」に [entity_id: …] で示されるものを使う。

本文生成の提案 (PROPOSE):
- 作者が本文を書きたい意思を示し、かつシーンの目的・視点・必須イベントなどの契約要素が対話で揃ったときだけ、PROPOSE 行で「話+シーン+Writing Contract」の提案を出す。契約要素が足りない場合は提案せず、不足分を質問して固める。
- 提案は1返答につき1件まで。保留中の提案がある間は新しい提案を出さず、作者の承認/却下/修正指示を待つ。

計画の起票 (RUN_PLAN):
- 作者が作品の計画 (話・シーン構成) を作りたい意思を示したとき、<<RUN_PLAN>> 行で計画ジョブを起票する。計画自体はあなたが書くのではなく、専任のプランナーが作り、結果は提案カードとして作者に示される。
- 計画の焦点や範囲の指示があれば JSON 引数で渡す (例: <<RUN_PLAN {"guidance": "序盤の導入だけ"}>>)。引数なしでもよい。
- 保留中の計画提案がある間は再度 RUN_PLAN を出さない。

資料 (workspace):
- 作品のデータはファイルとして整理されている (一覧と要約は「現在の作品情報」に載る)。ファイルの中身はここには載らない。計画や契約を考える材料として、一覧にあるファイルの存在を踏まえて対話する。

出力形式: 返答は日本語のプレーンテキスト。マーカー行は返答の末尾にだけ書く(各行1行ずつ、順不同・必要なものだけ):
<<WORK_PATCH {"title": "…", "premise": "…", "genre": "…", "status": "active"}>>
<<CANON_FACTS ["確定した設定や決定事項", {"statement": "仮置きの案", "commitment": "provisional"}, {"statement": "秘密の事実", "disclosure": "secret"}]>>
<<PROPOSE {"episode_title": "第1話", "scene_title": "…", "scene_purpose": "…", "contract": {"role": "…", "pov": "…", "required_events": ["…"], "forbidden": ["…"], "knowledge_notes": "…", "connections": "…"}}>>
<<RUN_PLAN {"guidance": "…"}>>
<<CHANGESET {"title": "…", "description": "…", "ops": [{"op": "revise_fact", "fact_id": "…", "new_statement": "…"}, {"op": "add_entity", "kind": "character", "name": "…", "aliases": ["…"]}]}>>
- WORK_PATCH: 更新しないフィールドは省略。更新がなければ行自体を出さない。status には "setup" または "active" だけが使える。
- CANON_FACTS: 新たに確定した事項だけを列挙する。既に記録済みの内容は繰り返さない。なければ出さない。仮置き・未定の事項は commitment="provisional"、秘密事項は disclosure="secret" を付ける。
- PROPOSE: contract の各フィールドは対話で確定した内容のみ書く。episode_title を省略すると最新の話に追加される。
- RUN_PLAN: 引数は省略可。計画したいときだけ出す。
- CHANGESET: 既存の正典・作品設定の変更を提案するときだけ出す。description は省略可。

自律実行モードでは、末尾に <<AUTO_STOP>> を出して自律継続を止められる (進めるべき作業が残っていない・作者の承認や判断が必要になったときに使う)。`;

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
  /** 正典メモ (fact_id つき。CHANGESET の ops が参照する)。 */
  canonFacts?: {
    id: string;
    statement: string;
    commitment?: string | undefined;
    disclosure?: string | undefined;
  }[];
  /** 登場要素一覧 (entity_id+別名。entity ops の参照に使う)。 */
  entities?: {
    entity_id: string;
    kind: string;
    name: string;
    aliases?: string[];
    summary?: string;
  }[];
  pendingProposals?: string[];
  /** workspace のファイル一覧 (一覧+要約のみ。中身は載せない)。 */
  workspaceFiles?: { path: string; summary: string }[];
  /** 自律往復なら true → 末尾に自律指示を足す (spec §7.2)。 */
  autonomous?: boolean;
}): ProviderInputMessage[] {
  const { work } = input;
  const lines = [
    `作品タイトル: ${work.title || "(未設定)"}`,
    `前提/あらすじ: ${work.premise || "(未設定)"}`,
    `ジャンル: ${work.genre || "(未設定)"}`,
    `状態: ${work.status}`,
  ];
  if (input.workspaceFiles && input.workspaceFiles.length > 0) {
    lines.push(
      "資料 (workspace) のファイル一覧 — 中身は読まず一覧+要約のみ:",
      ...input.workspaceFiles.map((f) => `- ${f.path} — ${f.summary}`),
    );
  }
  if (input.canonFacts && input.canonFacts.length > 0) {
    lines.push(
      "記録済みの正典メモ:",
      ...input.canonFacts.map(
        (f) => `- [fact_id: ${f.id}] ${canonFactLabel(f)}${f.statement}`,
      ),
    );
  }
  if (input.entities && input.entities.length > 0) {
    lines.push(
      "登場要素 (entity ops が参照する):",
      ...input.entities.map(
        (e) =>
          `- [entity_id: ${e.entity_id}] ${e.name} (${e.kind})${e.aliases && e.aliases.length > 0 ? ` 別名:${e.aliases.join("/")}` : ""}${e.summary ? ` — ${e.summary}` : ""}`,
      ),
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
      // 自律指示は先頭の開発者ブロックに統合する。履歴の末尾に system/
      // developer を置くと、会話先頭以外の system メッセージを拒否する
      // プロバイダー (Gemini 等) でエラーになる。
      content:
        `現在の作品情報:\n${lines.join("\n")}` +
        (input.autonomous ? `\n\n${AUTONOMY_DIRECTIVE}` : ""),
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

/** 応答の末尾行の `<<RUN_PLAN>>` / `<<RUN_PLAN {…}>>` マーカー。 */
export const RUN_PLAN_LINE = /^<<RUN_PLAN(?:\s+(.+?))?>>$/;

/** 応答の末尾行の `<<AUTO_STOP>>` マーカー (自律実行の終了要求, spec §7.3)。 */
export const AUTO_STOP_LINE = /^<<AUTO_STOP>>$/;

/**
 * 自律往復のプロンプト末尾に足す指示 (spec §7.2 Draft only)。
 * ユーザーの新規発言ではなくシステムからの運転指示であることを明示し、
 * 確定操作は提案に留める・止まるべきときは AUTO_STOP を出すことを命じる。
 */
export const AUTONOMY_DIRECTIVE =
  `これは自律実行モードによる往復です。作者からの新しい指示ではありません。\n` +
  `現在の作品状態を確認し、計画・草案・提案のうち次に進めるべき作業を1つ進めてください。\n` +
  `正典の確定・公開・作者の承認を要する変更は、確定せず提案 (PROPOSE/CHANGESET) の形に留めてください。\n` +
  `進めるべき作業がない、または作者の承認・判断・返答が必要な場合は、理由を簡潔に述べたうえで返答の末尾に <<AUTO_STOP>> を出してください。`;

export type RunPlanMarker = {
  /** 計画への指示 (焦点・範囲など)。 */
  guidance?: string;
};

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
/** 応答の末尾行の `<<CHANGESET {…}>>` マーカー (Phase 2b, spec §5)。 */
export const CHANGESET_LINE = /^<<CHANGESET\s+(.+?)>>$/;

/** CHANGESET マーカーの中身 (ops は ChangeSetOp の語彙)。 */
export const ChangeSetMarkerSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(20000).default(""),
  ops: z.array(ChangeSetOpSchema).min(1).max(100),
});
export type ChangeSetMarker = z.infer<typeof ChangeSetMarkerSchema>;

const MARKER_OPEN =
  /<<(WORK_PATCH|PROPOSE|CANON_FACTS|CHANGESET|RUN_PLAN|AUTO_STOP)(?=[\s>])/g;

export function parseOrchestratorMarkers(text: string): {
  cleanText: string;
  patch: WorkPatchRequest | null;
  proposal: ProposeMarker | null;
  canonFacts: CanonFactInput[];
  runPlan: RunPlanMarker | null;
  changeSet: {
    title: string;
    description: string;
    ops: ChangeSetOp[];
  } | null;
  /** <<AUTO_STOP>> が末尾にあったか (spec §7.3)。 */
  autoStop: boolean;
} {
  const patches: WorkPatchRequest[] = [];
  const proposals: ProposeMarker[] = [];
  const factLists: CanonFactInput[][] = [];
  let runPlan: RunPlanMarker | null = null;
  const changeSets: ChangeSetMarker[] = [];
  let autoStop = false;
  let tail = text;

  // 末尾の連続するマーカーを後ろから読む。
  // 1行に複数マーカーが並んだり JSON が複数行にまたがる応答にも対応するため
  // 行単位ではなく <<TAG ...>> の位置で切り出す。JSON 内に >> があっても
  // 後続の >> を順に試す。JSON はパースできたがスキーマ不合ならマーカーは
  // 本文に残して打ち止め。
  const tryMarker = (tag: string, jsonText: string): boolean | null => {
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch {
      return null; // 閉じ位置が違うかも → 次の >> を試す
    }
    try {
      switch (tag) {
        case "WORK_PATCH":
          patches.unshift(WorkPatchRequestSchema.parse(raw));
          return true;
        case "PROPOSE": {
          const p = ProposeScenePayloadSchema.parse(raw);
          proposals.unshift({
            ...(p.episode_title ? { episodeTitle: p.episode_title } : {}),
            sceneTitle: p.scene_title,
            scenePurpose: p.scene_purpose,
            contract: p.contract,
          });
          return true;
        }
        case "CANON_FACTS":
          factLists.unshift(z.array(CanonFactInputSchema).parse(raw));
          return true;
        case "CHANGESET":
          changeSets.unshift(ChangeSetMarkerSchema.parse(raw));
          return true;
        case "RUN_PLAN": {
          const o = z
            .object({ guidance: z.string().optional() })
            .passthrough()
            .parse(raw);
          runPlan = o.guidance !== undefined ? { guidance: o.guidance } : {};
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  outer: while (true) {
    MARKER_OPEN.lastIndex = 0;
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = MARKER_OPEN.exec(tail))) last = m;
    if (!last) break;
    const start = last.index;
    const tag = last[1]!;
    const after = tail.slice(start + last[0].length);

    if (tag === "AUTO_STOP") {
      const close = after.match(/^\s*>>/);
      if (!close) break;
      const end = start + last[0].length + close[0].length;
      if (tail.slice(end).trim() !== "") break;
      autoStop = true;
      tail = tail.slice(0, start);
      continue;
    }

    let searchFrom = 0;
    while (true) {
      const closeIdx = after.indexOf(">>", searchFrom);
      if (closeIdx === -1) break;
      const end = start + last[0].length + closeIdx + 2;
      // 末尾まで空白のみでないなら、この >> は JSON 内の文字列か
      // マーカーが末尾にない → 次の >> 候補へ。
      if (tail.slice(end).trim() !== "") {
        searchFrom = closeIdx + 2;
        continue;
      }
      const res = tryMarker(tag, after.slice(0, closeIdx));
      if (res === true) {
        tail = tail.slice(0, start);
        continue outer;
      }
      if (res === null) {
        searchFrom = closeIdx + 2;
        continue;
      }
      break outer;
    }
    break;
  }

  const cleanText = tail.trimEnd();
  const cs =
    changeSets.length > 0 ? changeSets[changeSets.length - 1]! : null;
  return {
    cleanText,
    patch: patches.length > 0 ? patches[patches.length - 1]! : null,
    proposal: proposals.length > 0 ? proposals[proposals.length - 1]! : null,
    canonFacts: factLists.flat(),
    runPlan,
    changeSet: cs,
    autoStop,
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
