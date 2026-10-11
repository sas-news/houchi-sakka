import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Link,
  redirect,
  type MetaFunction,
  type RouterContextProvider,
} from "react-router";
import { api, ApiError } from "../lib/api";
import { getWorkDetail, requireUser } from "../lib/server";
import type {
  ChangeSetInfo,
  ChangeSetOp,
  KeyInfo,
  ProposalInfo,
  ReleaseInfo,
  SceneInfo,
  SceneRevisionInfo,
  WorkDetail,
  WorkInfo,
  WorkProse,
  WorkReleases,
  WorkspaceFileInfo,
} from "../lib/types";

export const meta: MetaFunction = () => [{ title: "作品 | 放置作家" }];

const POLL_MS = 1500;
/** 実行体がジョブを取らないままこの時間を超えたら「応答なし」とみなす。 */
const EXECUTOR_STALE_MS = 120_000;

const STATUS_LABEL: Record<WorkInfo["status"], string> = {
  setup: "初期化中",
  active: "進行中",
};

const SCENE_STATUS_LABEL: Record<SceneInfo["status"], string> = {
  draft: "下書き",
  proposed: "提案中",
  approved: "承認済み",
  generated: "生成済み",
};

const SCENE_STATUS_BADGE: Record<SceneInfo["status"], string> = {
  draft: "badge",
  proposed: "badge badge--warn",
  approved: "badge badge--accent",
  generated: "badge badge--ok",
};

const PROPOSAL_STATUS_LABEL: Record<ProposalInfo["status"], string> = {
  pending: "決定待ち",
  approved: "承認済み",
  rejected: "却下済み",
};

const PROPOSAL_STATUS_BADGE: Record<ProposalInfo["status"], string> = {
  pending: "badge badge--warn",
  approved: "badge badge--ok",
  rejected: "badge",
};

const WORK_STATUS_BADGE: Record<WorkInfo["status"], string> = {
  setup: "badge badge--warn",
  active: "badge badge--ok",
};

const CS_STATUS_LABEL: Record<ChangeSetInfo["status"], string> = {
  proposed: "提案中",
  approved: "承認済み",
  rejected: "却下済み",
  applied: "適用済み",
};

const CS_STATUS_BADGE: Record<ChangeSetInfo["status"], string> = {
  proposed: "badge badge--warn",
  approved: "badge badge--ok",
  rejected: "badge",
  applied: "badge badge--ok",
};

const CS_KIND_LABEL: Record<ChangeSetInfo["kind"], string> = {
  normal: "変更提案",
  manual_edit: "手編集",
  force_override: "強制適用",
};

const OP_LABEL: Record<ChangeSetOp["op"], string> = {
  retire_fact: "正典の廃止",
  revise_fact: "正典の書き換え",
  add_fact: "正典の追加",
  update_work: "作品情報の更新",
};

const FINDING_SEV_LABEL: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

const RELEASE_STATUS_LABEL: Record<ReleaseInfo["status"], string> = {
  published: "公開中",
  unlisted: "取り下げ済み",
};

const RELEASE_STATUS_BADGE: Record<ReleaseInfo["status"], string> = {
  published: "badge badge--ok",
  unlisted: "badge",
};

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function opText(op: ChangeSetOp): string {
  switch (op.op) {
    case "retire_fact":
      return "正典を廃止する";
    case "revise_fact":
      return `正典を「${op.new_statement ?? ""}」に書き換える`;
    case "add_fact":
      return `正典に「${op.statement ?? ""}」を追加する`;
    case "update_work": {
      const keys = Object.entries(op.patch ?? {}).map(([k]) => k);
      return `作品情報を更新する (${keys.join(", ")})`;
    }
  }
}

const STEP_LABEL: Record<string, string> = {
  call_provider: "AIに問い合わせています",
  persist_result: "結果を保存しています",
  resume_from_checkpoint: "前回の状態から再開しています",
  persist_message: "返答を記録しています",
  apply_work_patch: "作品情報を更新しています",
  add_canon_facts: "正典を記録しています",
  create_proposal: "提案を作成しています",
  persist_revision: "本文を保存しています",
  record_dependencies: "依存関係を記録しています",
  enqueue_plan_work: "計画ジョブを起票しています",
  // Phase 2a 多段パイプライン
  write: "執筆中",
  critique: "検査中",
  revise: "改稿中",
  plan: "計画を作成しています",
  complete: "完了処理をしています",
  // Phase 2b 変更セット / レビュー
  create_change_set: "変更セットを作成しています",
  fetch_context: "変更対象を読み込んでいます",
  review_scene: "影響するシーンをレビューしています",
  record_findings: "レビュー結果を記録しています",
  report: "結果を報告しています",
};

export async function loader({
  context,
  request,
  params,
}: {
  context: RouterContextProvider;
  request: Request;
  params: { id: string };
}) {
  const user = await requireUser(context, request);
  const detail = await getWorkDetail(context, params.id);
  if (!detail || detail.work.owner_ref !== user.id) {
    throw redirect("/");
  }
  return detail;
}

function latestStep(detail: WorkDetail): string | null {
  const events = detail.active_job?.progress ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const d = events[i]!.data;
    if (events[i]!.type === "status" && d && typeof d === "object") {
      const step = (d as { step?: string }).step;
      if (step) return STEP_LABEL[step] ?? step;
    }
  }
  return detail.active_job ? "キューで待機しています" : null;
}

function streamText(detail: WorkDetail): string {
  const events = detail.active_job?.progress ?? [];
  let out = "";
  for (const e of events) {
    if (e.type === "token" && e.data && typeof e.data === "object") {
      out += (e.data as { text?: string }).text ?? "";
    }
  }
  return out;
}

/** Tiptap doc JSON を段落の配列に直す (表示・手編集 textarea 用)。 */
function docToParagraphs(doc: unknown): string[] {
  if (!doc || typeof doc !== "object") return [];
  const content = (doc as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const paras: string[] = [];
  for (const node of content) {
    const inner = (node as { content?: unknown })?.content;
    if (!Array.isArray(inner)) continue;
    const text = inner
      .map((c) =>
        c && typeof c === "object"
          ? String((c as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
    paras.push(text);
  }
  return paras;
}

/** 提案カード (対話メッセージの下に表示)。kind ごとに中身を切り替える。 */
function ProposalCard({
  proposal,
  onDecide,
  busy,
}: {
  proposal: ProposalInfo;
  onDecide: (id: string, action: "approve" | "reject") => void;
  busy: boolean;
}) {
  const p = proposal.payload;

  // kind="plan": 計画提案 (episodes→scenes の一括作成案)
  if (proposal.kind === "plan") {
    const episodes = p.episodes ?? [];
    const sceneCount = episodes.reduce((acc, e) => acc + e.scenes.length, 0);
    return (
      <div className={`proposal-card ${proposal.status}`}>
        <div className="who">
          作品計画の提案 ({PROPOSAL_STATUS_LABEL[proposal.status]})
        </div>
        <div className="proposal-body">
          <strong>
            話 {episodes.length}件・シーン {sceneCount}件
          </strong>
          <dl className="contract">
            {episodes.map((ep, i) => (
              <div key={i}>
                <dt>{ep.title}</dt>
                <dd>
                  <ul>
                    {ep.scenes.map((s, j) => (
                      <li key={j}>
                        {s.title}
                        {s.purpose ? (
                          <span className="muted"> — {s.purpose}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ))}
          </dl>
        </div>
        {proposal.status === "pending" ? (
          <div className="proposal-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide(proposal.id, "approve")}
            >
              承認して計画を作成
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => onDecide(proposal.id, "reject")}
            >
              却下する
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  // kind="workspace_write": workspace への書き込み提案
  if (proposal.kind === "workspace_write") {
    return (
      <div className={`proposal-card ${proposal.status}`}>
        <div className="who">
          資料への書き込み提案 ({PROPOSAL_STATUS_LABEL[proposal.status]})
        </div>
        <div className="proposal-body">
          <strong>{p.path ?? "(不明なパス)"}</strong>
          {p.supported === false ? (
            <p className="muted">
              このパスへの書き込みはまだ対応していません (記録のみ)。
            </p>
          ) : null}
          {p.content ? (
            <pre className="json-view">
              {p.content.length > 600
                ? `${p.content.slice(0, 600)}…`
                : p.content}
            </pre>
          ) : null}
        </div>
        {proposal.status === "pending" ? (
          <div className="proposal-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide(proposal.id, "approve")}
            >
              承認して書き込む
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => onDecide(proposal.id, "reject")}
            >
              却下する
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  // kind="writing_contract" (既定): シーン生成の提案
  const c = p.contract ?? {};
  return (
    <div className={`proposal-card ${proposal.status}`}>
      <div className="proposal-head">
        <span className="who">シーン生成の提案</span>
        <span className={PROPOSAL_STATUS_BADGE[proposal.status]}>
          {PROPOSAL_STATUS_LABEL[proposal.status]}
        </span>
      </div>
      <div className="proposal-body">
        <strong>
          {p.episode_title ? `${p.episode_title} / ` : ""}
          {p.scene_title ?? "(無題のシーン)"}
        </strong>
        {p.scene_purpose ? <p>目的: {p.scene_purpose}</p> : null}
        <dl className="contract">
          {c.role ? (
            <>
              <dt>役割</dt>
              <dd>{c.role}</dd>
            </>
          ) : null}
          {c.pov ? (
            <>
              <dt>視点</dt>
              <dd>{c.pov}</dd>
            </>
          ) : null}
          {c.required_events && c.required_events.length > 0 ? (
            <>
              <dt>必須イベント</dt>
              <dd>{c.required_events.join(" / ")}</dd>
            </>
          ) : null}
          {c.forbidden && c.forbidden.length > 0 ? (
            <>
              <dt>禁止事項</dt>
              <dd>{c.forbidden.join(" / ")}</dd>
            </>
          ) : null}
          {c.knowledge_notes ? (
            <>
              <dt>知識メモ</dt>
              <dd>{c.knowledge_notes}</dd>
            </>
          ) : null}
          {c.connections ? (
            <>
              <dt>前後への接続</dt>
              <dd>{c.connections}</dd>
            </>
          ) : null}
        </dl>
      </div>
      {proposal.status === "pending" ? (
        <div className="proposal-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide(proposal.id, "approve")}
          >
            承認して本文を生成
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => onDecide(proposal.id, "reject")}
          >
            却下する
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 変更セットの提案カード (対話メッセージの下に表示)。 */
function ChangeSetCard({
  cs,
  onDecide,
  onForce,
  busy,
}: {
  cs: ChangeSetInfo;
  onDecide: (id: string, action: "approve" | "reject") => void;
  onForce: (id: string) => void;
  busy: boolean;
}) {
  const cardStatus =
    cs.status === "proposed"
      ? "pending"
      : cs.status === "rejected"
        ? "rejected"
        : "approved";
  const openFindings = cs.findings.filter((f) => f.status === "open").length;
  return (
    <div className={`proposal-card ${cardStatus}`}>
      <div className="proposal-head">
        <span className="who">変更セットの提案 ({CS_KIND_LABEL[cs.kind]})</span>
        <span className={CS_STATUS_BADGE[cs.status]}>
          {CS_STATUS_LABEL[cs.status]}
        </span>
      </div>
      <div className="proposal-body">
        <strong>{cs.title}</strong>
        {cs.description ? <p>{cs.description}</p> : null}
        <p className="muted">{cs.impact.summary}</p>
        <ul>
          {cs.ops.map((op, i) => (
            <li key={i}>{opText(op)}</li>
          ))}
        </ul>
        {openFindings > 0 ? (
          <p className="muted">
            レビュー: {openFindings}件の指摘あり — 「変更」タブで確認できます。
          </p>
        ) : null}
        {cs.force_reason ? (
          <p className="muted">強制適用の理由: {cs.force_reason}</p>
        ) : null}
      </div>
      {cs.status === "proposed" ? (
        <div className="proposal-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide(cs.id, "approve")}
          >
            承認して適用
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => onDecide(cs.id, "reject")}
          >
            却下する
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => onForce(cs.id)}
          >
            強制的に変更
          </button>
        </div>
      ) : null}
      {cs.status === "rejected" ? (
        <div className="proposal-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => onForce(cs.id)}
          >
            強制的に変更
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 本文ビュー (Tiptap JSON → 段落描画 + リビジョン切替 + 書き直し/手編集)。 */
function ProseView({
  scene,
  revisions,
  onRewrite,
  onEdit,
  busy,
}: {
  scene: SceneInfo;
  revisions: SceneRevisionInfo[];
  onRewrite: (instruction: string) => Promise<void>;
  onEdit: (text: string) => Promise<void>;
  busy: boolean;
}) {
  const sorted = useMemo(
    () => [...revisions].sort((a, b) => a.rev_no - b.rev_no),
    [revisions],
  );
  const [revNo, setRevNo] = useState<number | null>(null);
  const [mode, setMode] = useState<"read" | "rewrite" | "edit">("read");
  const [draft, setDraft] = useState("");
  const current = sorted.find((r) => r.rev_no === revNo) ?? sorted.at(-1);
  const paras = current ? docToParagraphs(current.content_json) : [];

  const submitAction = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (mode === "rewrite") await onRewrite(text);
    else if (mode === "edit") await onEdit(text);
    setMode("read");
    setDraft("");
  };

  return (
    <div>
      <h2>
        {scene.title}{" "}
        <span className={SCENE_STATUS_BADGE[scene.status]}>
          {SCENE_STATUS_LABEL[scene.status]}
        </span>
      </h2>
      {scene.purpose ? <p className="muted">目的: {scene.purpose}</p> : null}
      {sorted.length === 0 ? (
        <p className="muted">まだ本文がありません。</p>
      ) : (
        <>
          <label htmlFor="rev-select">リビジョン</label>
          <select
            id="rev-select"
            value={current?.rev_no ?? ""}
            onChange={(e) => {
              setRevNo(Number(e.target.value));
              setMode("read");
            }}
          >
            {sorted.map((r) => (
              <option key={r.id} value={r.rev_no}>
                第{r.rev_no}稿
                {r.source === "manual_edit" ? " (手編集)" : ""}
              </option>
            ))}
          </select>
          <div className="prose-body">
            {paras.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </>
      )}

      {mode === "read" ? (
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setMode("rewrite");
              setDraft("");
            }}
          >
            書き直しを依頼
          </button>
          {sorted.length > 0 ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setMode("edit");
                setDraft(paras.join("\n\n"));
              }}
            >
              手編集
            </button>
          ) : null}
        </div>
      ) : (
        <form onSubmit={(e) => void submitAction(e)}>
          <label htmlFor="revise-input">
            {mode === "rewrite" ? "書き直しの指示" : "本文を編集"}
          </label>
          <textarea
            id="revise-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={mode === "edit" ? 14 : 4}
            required
          />
          <div className="form-actions">
            <button type="submit" disabled={busy}>
              {mode === "rewrite" ? "書き直しを実行" : "この内容で保存"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setMode("read");
                setDraft("");
              }}
            >
              やめる
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** 変更タブ: 変更セット一覧 + 詳細 (ops / 影響分析 / findings / 操作)。 */
function ChangesView({
  changeSets,
  onDecide,
  onForce,
  onToggleFinding,
  busy,
}: {
  changeSets: ChangeSetInfo[];
  onDecide: (id: string, action: "approve" | "reject") => void;
  onForce: (id: string) => void;
  onToggleFinding: (id: string, status: "open" | "dismissed") => void;
  busy: boolean;
}) {
  const sorted = useMemo(
    () => [...changeSets].sort((a, b) => b.created_at - a.created_at),
    [changeSets],
  );
  const [selId, setSelId] = useState<string | null>(null);
  const sel = sorted.find((c) => c.id === selId) ?? null;
  if (sorted.length === 0) {
    return (
      <div className="empty">
        まだ変更セットがありません。対話で正典や作品情報の変更が提案されると、
        ここに一覧が出ます。
      </div>
    );
  }
  return (
    <div>
      <div className="scene-list">
        {sorted.map((c) => {
          const open = c.findings.filter((f) => f.status === "open").length;
          return (
            <button
              key={c.id}
              type="button"
              className={`scene-item${c.id === selId ? " active" : ""}`}
              onClick={() => setSelId(c.id)}
            >
              {c.title}{" "}
              <span className={CS_STATUS_BADGE[c.status]}>
                {CS_STATUS_LABEL[c.status]}
              </span>{" "}
              <span className="muted">{CS_KIND_LABEL[c.kind]}</span>
              {open > 0 ? (
                <span className="muted"> 指摘{open}件</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {sel ? (
        <div className="card">
          <h2>
            {sel.title}{" "}
            <span className={CS_STATUS_BADGE[sel.status]}>
              {CS_STATUS_LABEL[sel.status]}
            </span>{" "}
            <span className="badge">{CS_KIND_LABEL[sel.kind]}</span>
          </h2>
          {sel.description ? <p>{sel.description}</p> : null}

          <strong>操作内容</strong>
          <ul>
            {sel.ops.map((op, i) => (
              <li key={i}>
                {OP_LABEL[op.op]}: {opText(op)}
              </li>
            ))}
            {sel.ops.length === 0 ? <li>本文の手編集</li> : null}
          </ul>

          <strong>影響分析</strong>
          <p className="muted">{sel.impact.summary}</p>
          <dl className="contract">
            {sel.impact.scenes.length > 0 ? (
              <>
                <dt>影響するシーン</dt>
                <dd>
                  <ul>
                    {sel.impact.scenes.map((s) => (
                      <li key={s.id}>
                        {s.title} <span className="muted">— {s.reason}</span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
            {sel.impact.facts.length > 0 ? (
              <>
                <dt>文面が近い正典</dt>
                <dd>
                  <ul>
                    {sel.impact.facts.map((f) => (
                      <li key={f.id}>
                        {f.statement}{" "}
                        <span className="muted">— {f.reason}</span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
            {sel.impact.contracts.length > 0 ? (
              <>
                <dt>関係する契約</dt>
                <dd>
                  <ul>
                    {sel.impact.contracts.map((c) => (
                      <li key={c.id}>
                        <span className="muted">{c.reason}</span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
          </dl>

          {sel.findings.length > 0 ? (
            <>
              <strong>レビュー結果</strong>
              <ul className="findings">
                {sel.findings.map((f) => (
                  <li
                    key={f.id}
                    className={f.status === "dismissed" ? "muted" : ""}
                  >
                    <span className="badge badge--warn">
                      {FINDING_SEV_LABEL[f.severity] ?? f.severity}
                    </span>{" "}
                    {f.summary}
                    {f.detail ? <p className="muted">{f.detail}</p> : null}
                    {f.status === "dismissed" ? (
                      <span className="muted">(確認済み) </span>
                    ) : null}
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        onToggleFinding(
                          f.id,
                          f.status === "open" ? "dismissed" : "open",
                        )
                      }
                    >
                      {f.status === "open"
                        ? "確認済みにする"
                        : "未確認に戻す"}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {sel.status === "proposed" ? (
            <div className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => onDecide(sel.id, "approve")}
              >
                承認して適用
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => onDecide(sel.id, "reject")}
              >
                却下する
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => onForce(sel.id)}
              >
                強制的に変更
              </button>
            </div>
          ) : null}
          {sel.status === "rejected" ? (
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => onForce(sel.id)}
              >
                強制的に変更
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="empty">変更セットを選ぶと詳細が表示されます。</div>
      )}
    </div>
  );
}

/** 公開タブ: 話ごとのリリース履歴 + 公開操作 + 公開URL。 */
function ReleasesView({
  workId,
  data,
  busy,
  onPublish,
  onUnlist,
}: {
  workId: string;
  data: WorkReleases | null;
  busy: boolean;
  onPublish: (episodeId: string) => void;
  onUnlist: (releaseId: string) => void;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  if (data === null) {
    return (
      <div className="loading">
        <span className="spinner" aria-hidden="true" />
        読み込み中…
      </div>
    );
  }
  if (data.episodes.length === 0) {
    return (
      <div className="empty">
        まだ話がありません。対話で計画を立てて本文を生成すると、ここから公開できます。
      </div>
    );
  }

  const copyUrl = async (releaseId: string) => {
    const url = `${window.location.origin}/r/${releaseId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopiedId(releaseId);
    setTimeout(() => setCopiedId((c) => (c === releaseId ? null : c)), 2000);
  };

  const releasesByEpisode = new Map<string, ReleaseInfo[]>();
  for (const r of data.releases) {
    const list = releasesByEpisode.get(r.episode_id) ?? [];
    list.push(r);
    releasesByEpisode.set(r.episode_id, list);
  }

  return (
    <div>
      <p className="muted">
        話ごとに、その時点の本文を凍結した不変の公開版 (リリース) を発行します。
        公開後に本文を改稿しても、発行済みの公開版は変わりません。
      </p>
      {data.episodes.map((ep) => {
        const rels = releasesByEpisode.get(ep.id) ?? [];
        const latest = rels.at(-1);
        const isPublished = latest?.status === "published";
        return (
          <div key={ep.id} className="card release-card">
            <div className="release-head">
              <h2>
                第{ep.ord}話 {ep.title}{" "}
                {isPublished ? (
                  <span className="badge badge--ok">公開中</span>
                ) : rels.length > 0 ? (
                  <span className="badge">非公開</span>
                ) : (
                  <span className="badge">未公開</span>
                )}
                {ep.dirty ? (
                  <span className="badge badge--warn">未公開の変更あり</span>
                ) : null}
              </h2>
              <div className="form-actions">
                <button
                  type="button"
                  disabled={busy || !ep.has_prose}
                  onClick={() => onPublish(ep.id)}
                >
                  {isPublished || rels.length > 0
                    ? "最新の本文で公開する"
                    : "この版を公開する"}
                </button>
              </div>
              {!ep.has_prose ? (
                <p className="muted">
                  本文がまだありません。本文を生成してから公開できます。
                </p>
              ) : null}
            </div>
            {rels.length === 0 ? null : (
              <ul className="release-list">
                {[...rels].reverse().map((r) => (
                  <li key={r.id} className="release-row">
                    <div className="release-info">
                      <strong>第{r.rev_no}版</strong>{" "}
                      <span className={RELEASE_STATUS_BADGE[r.status]}>
                        {RELEASE_STATUS_LABEL[r.status]}
                      </span>{" "}
                      <span className="muted">
                        {formatDateTime(r.published_at)}
                      </span>
                    </div>
                    {r.status === "published" ? (
                      <div className="release-url">
                        <code>{`${window.location.origin}/r/${r.id}`}</code>
                        <div className="release-actions">
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => void copyUrl(r.id)}
                          >
                            {copiedId === r.id ? "コピーしました" : "URLをコピー"}
                          </button>
                          <a
                            className="secondary release-open"
                            href={`/r/${r.id}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            読者ページを開く
                          </a>
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => onUnlist(r.id)}
                          >
                            取り下げる
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <p className="muted">
        作品ID: {workId} — 公開した各版のURLは、ログインしていない読者にも開けます。
      </p>
    </div>
  );
}

type Tab = "chat" | "prose" | "materials" | "changes" | "publish" | "settings";

export default function WorkPage({
  loaderData,
}: {
  loaderData: WorkDetail;
}) {
  const [detail, setDetail] = useState<WorkDetail>(loaderData);
  const [tab, setTab] = useState<Tab>("chat");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 本文タブのデータ
  const [prose, setProse] = useState<WorkProse | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [proseError, setProseError] = useState<string | null>(null);
  // 設定タブのデータ
  const [keys, setKeys] = useState<KeyInfo[] | null>(null);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  // 資料タブのデータ (workspace 仮想FS)
  const [wsFiles, setWsFiles] = useState<WorkspaceFileInfo[] | null>(null);
  const [wsPath, setWsPath] = useState<string | null>(null);
  const [wsContent, setWsContent] = useState<string | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);
  // 公開タブのデータ
  const [releases, setReleases] = useState<WorkReleases | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const workId = loaderData.work.id;

  const refresh = useCallback(async () => {
    try {
      const next = await api.getWork(workId);
      setDetail(next);
    } catch {
      /* ポーリング失敗は次回に委ねる */
    }
  }, [workId]);

  const refreshProse = useCallback(async () => {
    try {
      setProse(await api.getProse(workId));
    } catch {
      /* 同上 */
    }
  }, [workId]);

  useEffect(() => {
    const t = setInterval(() => {
      void refresh();
      if (tab === "prose") void refreshProse();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh, refreshProse, tab]);

  useEffect(() => {
    if (tab === "prose") void refreshProse();
    if (tab === "settings" && keys === null) {
      api
        .listKeys()
        .then((r) => setKeys(r.keys))
        .catch(() => setKeys([]));
    }
    if (tab === "materials") {
      api
        .listWorkspaceFiles(workId)
        .then((r) => setWsFiles(r.files))
        .catch(() => setWsFiles([]));
    }
    if (tab === "publish") {
      api
        .getReleases(workId)
        .then(setReleases)
        .catch(() => setReleases({ episodes: [], releases: [] }));
    }
  }, [tab, refreshProse, keys, workId]);

  const openWorkspaceFile = async (path: string) => {
    setWsPath(path);
    setWsError(null);
    try {
      const res = await api.getWorkspaceFile(workId, path);
      setWsContent(res.content);
    } catch (e) {
      setWsContent(null);
      setWsError(e instanceof ApiError ? e.message : "読み込みに失敗しました");
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail.messages.length, detail.active_job?.job.id]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const content = String(data.get("content") ?? "").trim();
    if (!content) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/works/${workId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(body.error?.message ?? "送信に失敗しました");
        return;
      }
      form.reset();
      void refresh();
    } finally {
      setSending(false);
    }
  };

  const decideProposal = async (id: string, action: "approve" | "reject") => {
    setSending(true);
    setError(null);
    try {
      await api.decideProposal(id, action);
      await refresh();
      await refreshProse();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "操作に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const decideChangeSet = async (id: string, action: "approve" | "reject") => {
    setSending(true);
    setError(null);
    try {
      if (action === "approve") await api.approveChangeSet(id, false);
      else await api.rejectChangeSet(id);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "操作に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const forceChangeSet = async (id: string) => {
    // spec §5.4: 警告を表示し、変更理由の記録を要求する。
    const ok = window.confirm(
      "強制適用は通常の承認フローを迂回する緊急経路です。" +
        "適用後にAIレビューが起動し、指摘は「変更」タブに残ります。実行しますか?",
    );
    if (!ok) return;
    const input = window.prompt(
      "変更理由を記録してください (監査記録に残ります)",
    );
    if (input === null) return;
    const reason = input.trim();
    if (reason.length === 0) {
      setError("強制適用には変更理由の記録が必要です");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await api.approveChangeSet(id, true, reason);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "操作に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const toggleFinding = async (id: string, status: "open" | "dismissed") => {
    setSending(true);
    try {
      await api.setFindingStatus(id, status);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "操作に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const rewriteScene = async (instruction: string) => {
    if (!sceneId) return;
    setSending(true);
    setProseError(null);
    try {
      await api.rewriteScene(sceneId, instruction);
      await refresh();
      await refreshProse();
    } catch (e) {
      setProseError(e instanceof ApiError ? e.message : "書き直しに失敗しました");
      throw e;
    } finally {
      setSending(false);
    }
  };

  const editScene = async (text: string) => {
    if (!sceneId) return;
    setSending(true);
    setProseError(null);
    try {
      await api.createRevision(sceneId, text);
      await refreshProse();
    } catch (e) {
      setProseError(e instanceof ApiError ? e.message : "保存に失敗しました");
      throw e;
    } finally {
      setSending(false);
    }
  };

  const refreshReleases = useCallback(async () => {
    try {
      setReleases(await api.getReleases(workId));
    } catch {
      /* 同上 */
    }
  }, [workId]);

  const publishEpisode = async (episodeId: string) => {
    if (
      !window.confirm(
        "現時点の本文を凍結して公開します。" +
          "公開後に本文を改稿しても、この公開版は変わりません。公開しますか?",
      )
    ) {
      return;
    }
    setSending(true);
    setReleaseError(null);
    try {
      await api.publishRelease(workId, episodeId);
      await refreshReleases();
    } catch (e) {
      setReleaseError(e instanceof ApiError ? e.message : "公開に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const unlistRelease = async (releaseId: string) => {
    if (
      !window.confirm(
        "この公開版を取り下げますか? 読者ページにアクセスできなくなります。",
      )
    ) {
      return;
    }
    setSending(true);
    setReleaseError(null);
    try {
      await api.unlistRelease(releaseId);
      await refreshReleases();
    } catch (e) {
      setReleaseError(
        e instanceof ApiError ? e.message : "取り下げに失敗しました",
      );
    } finally {
      setSending(false);
    }
  };

  const saveSettings = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const keyId = String(data.get("key_id") ?? "");
    const model = String(data.get("model") ?? "").trim();
    setSending(true);
    setSettingsMsg(null);
    try {
      const res = await api.updateWorkSettings(workId, {
        key_id: keyId === "" ? null : keyId,
        ...(model ? { model } : {}),
      });
      setDetail((d) => ({ ...d, work: res.work }));
      setSettingsMsg("保存しました");
    } catch (err) {
      setSettingsMsg(err instanceof ApiError ? err.message : "保存に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const running = detail.active_job !== null;
  // 実行体が lease せずキュー滞留が続く = 実行体オフラインの可能性
  // (spec §3.4: Runner状態を画面に明示し対話・生成を止める)。
  const executorStale =
    detail.active_job?.job.status === "queued" &&
    detail.active_job.job.created_at <= Date.now() - EXECUTOR_STALE_MS;
  const step = latestStep(detail);
  const stream = streamText(detail);
  const { work } = detail;
  const proposalByMessage = new Map(
    detail.proposals.map((p) => [p.message_id, p]),
  );
  const changeSetByMessage = new Map(
    detail.change_sets
      .filter((c) => c.message_id !== null)
      .map((c) => [c.message_id as string, c]),
  );
  const selectedScene =
    prose?.scenes.find((s) => s.id === sceneId) ?? null;
  const selectedRevisions =
    prose?.revisions.filter((r) => r.scene_id === sceneId) ?? [];

  const TABS: { key: Tab; label: string }[] = [
    { key: "chat", label: "対話" },
    { key: "prose", label: "本文" },
    { key: "materials", label: "資料" },
    { key: "changes", label: "変更" },
    { key: "publish", label: "公開" },
    { key: "settings", label: "設定" },
  ];

  return (
    <main className="page page--wide">
      <nav className="topnav">
        <Link to="/" className="brand">
          放置作家
        </Link>
        <span className="spacer" />
        <Link to="/settings/keys">APIキー設定</Link>
      </nav>
      <h1>{work.title}</h1>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {executorStale ? (
        <p className="notice">
          実行体から応答がありません。対話・生成は実行体が戻るまで保留されます
          (ローカルRunner利用時はRunnerの起動を確認してください)。
        </p>
      ) : null}
      {tab === "chat" ? (
        <div className="work-layout">
          <section>
            <div className="chat">
              {detail.messages.map((m) => (
                <div key={m.id}>
                  <div className={`msg ${m.role}`}>
                    <div className="who">
                      {m.role === "user" ? "あなた" : "オーケストレーター"}
                    </div>
                    {m.content}
                  </div>
                  {(() => {
                    const proposal = proposalByMessage.get(m.id);
                    const cs = changeSetByMessage.get(m.id);
                    return (
                      <>
                        {proposal ? (
                          <ProposalCard
                            proposal={proposal}
                            onDecide={(id, a) => void decideProposal(id, a)}
                            busy={sending || running}
                          />
                        ) : null}
                        {cs ? (
                          <ChangeSetCard
                            cs={cs}
                            onDecide={(id, a) => void decideChangeSet(id, a)}
                            onForce={(id) => void forceChangeSet(id)}
                            busy={sending || running}
                          />
                        ) : null}
                      </>
                    );
                  })()}
                </div>
              ))}
              {running ? (
                <div className="job-status">
                  <span className="spinner" aria-hidden="true" />
                  <span className="step">
                    {step ?? "実行中です"}
                    {detail.queued_jobs > 0
                      ? ` (キュー待ち ${detail.queued_jobs} 件)`
                      : ""}
                  </span>
                  {stream ? <span className="stream">{stream}</span> : null}
                </div>
              ) : null}
              <div ref={bottomRef} />
            </div>
            {error ? <p className="error-text">{error}</p> : null}
            <form className="chat-form" onSubmit={(e) => void submit(e)}>
              <label htmlFor="content">オーケストレーターへのメッセージ</label>
              <textarea
                id="content"
                name="content"
                required
                maxLength={20000}
                disabled={executorStale}
                placeholder={
                  executorStale ? "実行体の応答を待っています" : undefined
                }
              />
              <div className="form-actions">
                <button type="submit" disabled={sending || executorStale}>
                  {running ? "送信 (キューに追加)" : "送信"}
                </button>
              </div>
            </form>
          </section>
          <aside className="card work-meta">
            <dl>
              <dt>状態</dt>
              <dd>
                <span className={WORK_STATUS_BADGE[work.status]}>
                  {STATUS_LABEL[work.status]}
                </span>
              </dd>
              <dt>ジャンル</dt>
              <dd>{work.genre || "未設定"}</dd>
              <dt>前提</dt>
              <dd>{work.premise || "未設定"}</dd>
              <dt>正典リビジョン</dt>
              <dd>rev{work.canon_rev}</dd>
            </dl>
            <p className="side-note">
              作品情報はオーケストレーターとの対話で更新されます。
            </p>
          </aside>
        </div>
      ) : null}

      {tab === "prose" ? (
        <section>
          {proseError ? <p className="error-text">{proseError}</p> : null}
          {!prose ? (
            <div className="loading">
              <span className="spinner" aria-hidden="true" />
              読み込み中…
            </div>
          ) : prose.scenes.length === 0 ? (
            <div className="empty">
              まだシーンがありません。対話タブでオーケストレーターに提案を
              出してもらい、承認すると本文が生成されます。
            </div>
          ) : (
            <>
              <div className="scene-list">
                {prose.episodes.map((ep) => (
                  <div key={ep.id} className="card">
                    <strong className="episode-title">
                      第{ep.ord}話 {ep.title}
                    </strong>
                    {prose.scenes
                      .filter((s) => s.episode_id === ep.id)
                      .map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className={`scene-item${
                            s.id === sceneId ? " active" : ""
                          }`}
                          onClick={() => setSceneId(s.id)}
                        >
                          {s.title}{" "}
                          <span className="scene-status">
                            {SCENE_STATUS_LABEL[s.status]}
                          </span>
                        </button>
                      ))}
                  </div>
                ))}
              </div>
              {selectedScene ? (
                <ProseView
                  scene={selectedScene}
                  revisions={selectedRevisions}
                  onRewrite={rewriteScene}
                  onEdit={editScene}
                  busy={sending}
                />
              ) : (
                <div className="empty">シーンを選ぶと本文が表示されます。</div>
              )}
              {prose.canon_facts.length > 0 ? (
                <div className="card canon-card">
                  <strong>正典</strong>
                  <ul>
                    {prose.canon_facts.map((f) => (
                      <li key={f.id}>{f.statement}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {tab === "materials" ? (
        <section>
          {wsError ? <p className="error-text">{wsError}</p> : null}
          {!wsFiles ? (
            <p className="muted">読み込み中…</p>
          ) : wsFiles.length === 0 ? (
            <p className="muted">まだ資料がありません。</p>
          ) : (
            <>
              <p className="muted">
                エージェントが見ている資料 (workspace) の一覧です。
                ファイルを選ぶと中身を表示します (読み取り専用)。
              </p>
              <div className="scene-list">
                {wsFiles.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    className={`scene-item${wsPath === f.path ? " active" : ""}`}
                    onClick={() => void openWorkspaceFile(f.path)}
                  >
                    {f.path}{" "}
                    <span className="muted">{f.summary}</span>
                  </button>
                ))}
              </div>
              {wsPath !== null ? (
                <div className="card">
                  <strong>{wsPath}</strong>
                  {wsContent === null ? (
                    <p className="muted">読み込み中…</p>
                  ) : (
                    <pre className="json-view">{wsContent}</pre>
                  )}
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {tab === "changes" ? (
        <section>
          <ChangesView
            changeSets={detail.change_sets}
            onDecide={(id, a) => void decideChangeSet(id, a)}
            onForce={(id) => void forceChangeSet(id)}
            onToggleFinding={(id, s) => void toggleFinding(id, s)}
            busy={sending || running}
          />
        </section>
      ) : null}

      {tab === "publish" ? (
        <section>
          {releaseError ? <p className="error-text">{releaseError}</p> : null}
          <ReleasesView
            workId={workId}
            data={releases}
            busy={sending}
            onPublish={(id) => void publishEpisode(id)}
            onUnlist={(id) => void unlistRelease(id)}
          />
        </section>
      ) : null}

      {tab === "settings" ? (
        <section>
          <div className="card">
            <h2>創作憲章 / 執筆ポリシー</h2>
            {work.charter === null && work.policy === null ? (
              <p className="muted">
                未設定です。対話で固まった内容がここに反映されます。
              </p>
            ) : (
              <>
                {work.charter !== null ? (
                  <>
                    <strong>創作憲章</strong>
                    <pre className="json-view">
                      {JSON.stringify(work.charter, null, 2)}
                    </pre>
                  </>
                ) : null}
                {work.policy !== null ? (
                  <>
                    <strong>執筆ポリシー</strong>
                    <pre className="json-view">
                      {JSON.stringify(work.policy, null, 2)}
                    </pre>
                  </>
                ) : null}
              </>
            )}
            <p className="muted">
              創作憲章・執筆ポリシーは対話の中で固めて更新します
              (この画面での手編集はありません)。
            </p>
          </div>
          <form onSubmit={(e) => void saveSettings(e)} className="card">
            <h2>生成設定</h2>
            <label htmlFor="key_id">APIキー</label>
            {/* keys は非同期取得のため、読み込み完了＋key_ref 変化で
                再マウントして値を同期する (uncontrolled のままズレると
                保存時に key_ref が消えるバグになる) */}
            <select
              id="key_id"
              name="key_id"
              key={`${keys === null}:${work.key_ref ?? ""}`}
              defaultValue={work.key_ref ?? ""}
            >
              <option value="">(未選択)</option>
              {(keys ?? []).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} ({k.provider})
                </option>
              ))}
            </select>
            <label htmlFor="model">モデル</label>
            <input
              id="model"
              name="model"
              type="text"
              defaultValue={work.model ?? ""}
              placeholder="例: gpt-4o-mini"
            />
            {settingsMsg ? <p className="muted">{settingsMsg}</p> : null}
            <div className="form-actions">
              <button type="submit" disabled={sending}>
                保存
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </main>
  );
}
