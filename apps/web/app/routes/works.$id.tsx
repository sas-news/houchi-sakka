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
  KeyInfo,
  ProposalInfo,
  SceneInfo,
  SceneRevisionInfo,
  WorkDetail,
  WorkInfo,
  WorkProse,
} from "../lib/types";

export const meta: MetaFunction = () => [{ title: "作品 | 放置作家" }];

const POLL_MS = 1500;

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

const PROPOSAL_STATUS_LABEL: Record<ProposalInfo["status"], string> = {
  pending: "決定待ち",
  approved: "承認済み",
  rejected: "却下済み",
};

const STEP_LABEL: Record<string, string> = {
  call_provider: "AIに問い合わせています",
  persist_result: "結果を保存しています",
  resume_from_checkpoint: "前回の状態から再開しています",
  persist_message: "返答を記録しています",
  apply_work_patch: "作品情報を更新しています",
  add_canon_facts: "正典メモを記録しています",
  create_proposal: "提案を作成しています",
  persist_revision: "本文を保存しています",
  complete: "完了処理をしています",
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

/** 提案カード (対話メッセージの下に表示)。 */
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
  const c = p.contract ?? {};
  return (
    <div className={`proposal-card ${proposal.status}`}>
      <div className="who">シーン生成の提案 ({PROPOSAL_STATUS_LABEL[proposal.status]})</div>
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
        <span className="muted">({SCENE_STATUS_LABEL[scene.status]})</span>
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

type Tab = "chat" | "prose" | "settings";

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
  }, [tab, refreshProse, keys]);

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
  const step = latestStep(detail);
  const stream = streamText(detail);
  const { work } = detail;
  const proposalByMessage = new Map(
    detail.proposals.map((p) => [p.message_id, p]),
  );
  const selectedScene =
    prose?.scenes.find((s) => s.id === sceneId) ?? null;
  const selectedRevisions =
    prose?.revisions.filter((r) => r.scene_id === sceneId) ?? [];

  const TABS: { key: Tab; label: string }[] = [
    { key: "chat", label: "対話" },
    { key: "prose", label: "本文" },
    { key: "settings", label: "設定" },
  ];

  return (
    <main className="page">
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
                    return proposal ? (
                      <ProposalCard
                        proposal={proposal}
                        onDecide={(id, a) => void decideProposal(id, a)}
                        busy={sending || running}
                      />
                    ) : null;
                  })()}
                </div>
              ))}
              {running ? (
                <div className="job-status">
                  {step ?? "実行中です"}
                  {detail.queued_jobs > 0
                    ? ` (キュー待ち ${detail.queued_jobs} 件)`
                    : ""}
                  {stream ? <span className="stream">{stream}</span> : null}
                </div>
              ) : null}
              <div ref={bottomRef} />
            </div>
            {error ? <p className="error-text">{error}</p> : null}
            <form onSubmit={(e) => void submit(e)}>
              <label htmlFor="content">オーケストレーターへのメッセージ</label>
              <textarea
                id="content"
                name="content"
                required
                maxLength={20000}
              />
              <div className="form-actions">
                <button type="submit" disabled={sending}>
                  {running ? "送信 (キューに追加)" : "送信"}
                </button>
              </div>
            </form>
          </section>
          <aside className="card work-meta">
            <dl>
              <dt>状態</dt>
              <dd>{STATUS_LABEL[work.status]}</dd>
              <dt>ジャンル</dt>
              <dd>{work.genre || "未設定"}</dd>
              <dt>前提</dt>
              <dd>{work.premise || "未設定"}</dd>
            </dl>
            <p className="muted">
              作品情報はオーケストレーターとの対話で更新されます。
            </p>
          </aside>
        </div>
      ) : null}

      {tab === "prose" ? (
        <section>
          {proseError ? <p className="error-text">{proseError}</p> : null}
          {!prose ? (
            <p className="muted">読み込み中…</p>
          ) : prose.scenes.length === 0 ? (
            <p className="muted">
              まだシーンがありません。対話タブでオーケストレーターに提案を
              出してもらい、承認すると本文が生成されます。
            </p>
          ) : (
            <>
              <div className="scene-list">
                {prose.episodes.map((ep) => (
                  <div key={ep.id} className="card">
                    <strong>
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
                          <span className="muted">
                            ({SCENE_STATUS_LABEL[s.status]})
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
                <p className="muted">シーンを選ぶと本文が表示されます。</p>
              )}
              {prose.canon_facts.length > 0 ? (
                <div className="card">
                  <strong>正典メモ</strong>
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

      {tab === "settings" ? (
        <section>
          <div className="card">
            <h2>創作憲章 / 作風ポリシー</h2>
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
                    <strong>作風ポリシー</strong>
                    <pre className="json-view">
                      {JSON.stringify(work.policy, null, 2)}
                    </pre>
                  </>
                ) : null}
              </>
            )}
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
