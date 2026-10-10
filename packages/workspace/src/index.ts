// ---------------------------------------------------------------------------
// @houchi/workspace — 作品データを仮想ファイルとして公開する層 (Phase 2a)
//
// エージェントにとっての「唯一の窓口」。DB の直接読みは行わず、
// ファイルっぽいパスで読み取り、書き込みは必ず提案 (proposals) になる。
// 直接確定しない (spec §7.1 の監査方針)。
//
// パス写像:
//   /work.json                     title/premise/genre/status/charter/policy
//   /canon/facts.md                現行の canon_facts を箇条書きで (+ 改訂履歴件数)
//   /canon/history.md              全履歴行 (現行+閉じた) を rev 表示付きで
//   /plan/tree.md                  episodes→scenes の状態付きツリー
//   /contracts/<scene_id>.json     その scene の最新 Writing Contract
//   /scenes/<ep_ord>-<scene_ord>.md 最新リビジョン本文 (プレーンテキスト)
// ---------------------------------------------------------------------------

import {
  PROPOSAL_KIND_WORKSPACE_WRITE,
  tiptapDocToText,
  type Proposal,
  type Scene,
  type Work,
  type WorkspaceFile,
} from "@houchi/contracts";
import {
  appendMessage,
  createProposal,
  getEpisodeById,
  getLatestContractByScene,
  getSceneById,
  getThreadByWorkId,
  listAllCanonFactsByWork,
  listCanonFactsByWork,
  listEpisodesByWork,
  listRevisionsByScene,
  listScenesByEpisode,
  type DbLike,
} from "@houchi/database";

export const PATH_WORK_JSON = "/work.json" as const;
export const PATH_CANON_FACTS = "/canon/facts.md" as const;
export const PATH_CANON_HISTORY = "/canon/history.md" as const;
export const PATH_PLAN_TREE = "/plan/tree.md" as const;

const CONTRACT_PATH_RE = /^\/contracts\/(.+)\.json$/;
const SCENE_PATH_RE = /^\/scenes\/(\d+)-(\d+)\.md$/;

/** writePropose が apply 対応するパス (現状は正典メモ追記のみ)。 */
export const WRITABLE_PATHS = [PATH_CANON_FACTS] as const;

export function isWritablePath(path: string): boolean {
  return (WRITABLE_PATHS as readonly string[]).includes(path);
}

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

type SceneWithEpisode = { scene: Scene; episodeTitle: string; episodeOrd: number };

async function loadScenesWithEpisode(
  db: DbLike,
  workId: string,
): Promise<SceneWithEpisode[]> {
  const episodes = await listEpisodesByWork(db, workId);
  const out: SceneWithEpisode[] = [];
  for (const ep of episodes) {
    const scenes = await listScenesByEpisode(db, ep.id);
    for (const scene of scenes) {
      out.push({ scene, episodeTitle: ep.title, episodeOrd: ep.ord });
    }
  }
  return out;
}

/** /plan/tree.md の内容を生成する (planner の入力にも使うので公開)。 */
export async function buildPlanTree(db: DbLike, workId: string): Promise<string> {
  const episodes = await listEpisodesByWork(db, workId);
  if (episodes.length === 0) {
    return "(計画はまだありません — <<RUN_PLAN>> で計画を立てられます)";
  }
  const lines: string[] = [];
  for (const ep of episodes) {
    lines.push(`第${ep.ord}話 ${ep.title} [${ep.status}]`);
    const scenes = await listScenesByEpisode(db, ep.id);
    for (const s of scenes) {
      const revs = await listRevisionsByScene(db, s.id);
      const revLabel = revs.length > 0 ? `rev${revs.length}` : "本文なし";
      lines.push(`  - シーン${s.ord} ${s.title} [${s.status} / ${revLabel}] ${s.purpose}`);
    }
  }
  return lines.join("\n");
}

/**
 * /canon/facts.md の内容を生成する。
 * 現行行 (valid_to_rev IS NULL) のみ + 末尾に改訂履歴の件数注記 (spec §6.3)。
 */
export async function buildCanonFactsMd(
  db: DbLike,
  workId: string,
): Promise<string> {
  const facts = await listCanonFactsByWork(db, workId);
  const all = await listAllCanonFactsByWork(db, workId);
  const closed = all.length - facts.length;
  if (facts.length === 0) {
    return closed > 0
      ? `(正典メモはまだありません)\n\n--- (改訂履歴: ${closed}件)`
      : "(正典メモはまだありません)";
  }
  const body = facts.map((f) => `- ${f.statement}`).join("\n");
  return closed > 0 ? `${body}\n\n--- (改訂履歴: ${closed}件)` : body;
}

/** /canon/history.md: 全履歴行を rev 表示付きで (Phase 2b, spec §6.3)。 */
export async function buildCanonHistoryMd(
  db: DbLike,
  workId: string,
): Promise<string> {
  const all = await listAllCanonFactsByWork(db, workId);
  if (all.length === 0) {
    return "(正典メモの改訂履歴はまだありません)";
  }
  return all
    .map((f) => {
      const from = f.valid_from_rev === null ? "初期" : `rev${f.valid_from_rev}`;
      const to =
        f.valid_to_rev === null ? "現行" : `rev${f.valid_to_rev} で廃止`;
      const status = f.valid_to_rev === null ? "" : " (廃止)";
      return `- [${from}〜${to}] ${f.statement}${status}`;
    })
    .join("\n");
}

/** /work.json の内容を生成する。 */
export function buildWorkJson(work: Work): string {
  return JSON.stringify(
    {
      id: work.id,
      title: work.title,
      premise: work.premise,
      genre: work.genre,
      status: work.status,
      charter: work.charter,
      policy: work.policy,
    },
    null,
    2,
  );
}

/** 仮想ファイル一覧 (内容は載せない。一覧+要約のみ)。 */
export async function listFiles(
  db: DbLike,
  work: Work,
): Promise<WorkspaceFile[]> {
  const facts = await listCanonFactsByWork(db, work.id);
  const items = await loadScenesWithEpisode(db, work.id);

  const files: WorkspaceFile[] = [
    {
      path: PATH_WORK_JSON,
      summary: `作品の基本情報 (タイトル: ${work.title}, 状態: ${work.status})`,
    },
    {
      path: PATH_CANON_FACTS,
      summary: `正典メモ ${facts.length}件`,
    },
    {
      path: PATH_CANON_HISTORY,
      summary: "正典メモの改訂履歴",
    },
    {
      path: PATH_PLAN_TREE,
      summary: `計画ツリー (シーン ${items.length}件)`,
    },
  ];
  for (const { scene, episodeTitle, episodeOrd } of items) {
    const contract = await getLatestContractByScene(db, scene.id);
    if (contract) {
      files.push({
        path: `/contracts/${scene.id}.json`,
        summary: `${episodeTitle}「${scene.title}」の Writing Contract (${contract.status})`,
      });
    }
    const revs = await listRevisionsByScene(db, scene.id);
    files.push({
      path: `/scenes/${episodeOrd}-${scene.ord}.md`,
      summary: `${episodeTitle}「${scene.title}」の本文 (${revs.length > 0 ? `rev${revs.length}` : "本文なし"})`,
    });
  }
  return files;
}

/** 仮想ファイルの読み取り。未定義パスは null。 */
export async function readFile(
  db: DbLike,
  work: Work,
  path: string,
): Promise<{ path: string; content: string } | null> {
  if (path === PATH_WORK_JSON) {
    return { path, content: buildWorkJson(work) };
  }
  if (path === PATH_CANON_FACTS) {
    return { path, content: await buildCanonFactsMd(db, work.id) };
  }
  if (path === PATH_CANON_HISTORY) {
    return { path, content: await buildCanonHistoryMd(db, work.id) };
  }
  if (path === PATH_PLAN_TREE) {
    return { path, content: await buildPlanTree(db, work.id) };
  }
  const contractMatch = path.match(CONTRACT_PATH_RE);
  if (contractMatch) {
    const sceneId = contractMatch[1];
    if (!sceneId) return null;
    const scene = await getSceneById(db, sceneId);
    const episode = scene ? await getEpisodeById(db, scene.episode_id) : null;
    if (!scene || !episode || episode.work_id !== work.id) return null;
    const contract = await getLatestContractByScene(db, sceneId);
    if (!contract) return null;
    return {
      path,
      content: JSON.stringify(
        {
          scene_id: contract.scene_id,
          status: contract.status,
          contract: contract.payload,
          decided_at: contract.decided_at,
        },
        null,
        2,
      ),
    };
  }
  const sceneMatch = path.match(SCENE_PATH_RE);
  if (sceneMatch) {
    const episodeOrd = Number(sceneMatch[1]);
    const sceneOrd = Number(sceneMatch[2]);
    if (!Number.isFinite(episodeOrd) || !Number.isFinite(sceneOrd)) {
      return null;
    }
    const episodes = await listEpisodesByWork(db, work.id);
    const episode = episodes.find((e) => e.ord === episodeOrd);
    if (!episode) return null;
    const scenes = await listScenesByEpisode(db, episode.id);
    const scene = scenes.find((s) => s.ord === sceneOrd);
    if (!scene) return null;
    const revs = await listRevisionsByScene(db, scene.id);
    const latest = revs.at(-1);
    return {
      path,
      content: latest ? tiptapDocToText(latest.content_json) : "",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 書き込み提案 (常に proposal 化。直接確定しない)
// ---------------------------------------------------------------------------

/** 箇条書きコンテンツから正典メモの宣言文を抽出する。 */
export function parseCanonStatements(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^(?:[-*・]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0);
}

export type WriteProposeResult = {
  /** 作成された proposal (常に kind="workspace_write")。 */
  proposal: Proposal;
  /** このパスが apply 対応か (false なら提案は記録のみ、approve しても not_supported)。 */
  supported: boolean;
};

/**
 * workspace 経由の書き込み = 必ず提案になる。
 * - /canon/facts.md: 追記 supported (approve で箇条書き行→canon_facts に記録)
 * - その他: 提案自体は記録されるが supported=false (将来の差分適用の場)
 */
export async function writePropose(
  db: DbLike,
  input: {
    workId: string;
    path: string;
    content: string;
    /** 提案者 (job 名やスキル名などの出所記録)。 */
    provenance: string;
  },
): Promise<WriteProposeResult> {
  const thread = await getThreadByWorkId(db, input.workId);
  if (!thread) {
    throw new Error(`thread not found for work ${input.workId}`);
  }
  const supported = isWritablePath(input.path);
  const contentSummary = input.content.split("\n").at(0)?.slice(0, 60) ?? "";
  const message = await appendMessage(db, {
    threadId: thread.id,
    role: "assistant",
    content: supported
      ? `資料「${input.path}」への書き込み提案: ${contentSummary}`
      : `資料「${input.path}」への書き込み提案 (このパスへの書き込みは未対応。記録のみ): ${contentSummary}`,
  });
  const proposal = await createProposal(db, {
    workId: input.workId,
    threadId: thread.id,
    messageId: message.id,
    kind: PROPOSAL_KIND_WORKSPACE_WRITE,
    payload: {
      path: input.path,
      content: input.content,
      supported,
      provenance: input.provenance,
    },
  });
  return { proposal, supported };
}
