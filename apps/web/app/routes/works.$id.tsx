import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, redirect, type MetaFunction , type RouterContextProvider } from "react-router";
import { api } from "../lib/api";
import { getWorkDetail, requireUser } from "../lib/server";
import type { WorkDetail, WorkInfo } from "../lib/types";

export const meta: MetaFunction = () => [{ title: "対話 | 放置作家" }];

const POLL_MS = 1500;

const STATUS_LABEL: Record<WorkInfo["status"], string> = {
  setup: "初期化中",
  active: "進行中",
};

const STEP_LABEL: Record<string, string> = {
  call_provider: "AIに問い合わせています",
  persist_result: "結果を保存しています",
  resume_from_checkpoint: "前回の状態から再開しています",
  persist_message: "返答を記録しています",
  apply_work_patch: "作品情報を更新しています",
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

export default function WorkPage({
  loaderData,
}: {
  loaderData: WorkDetail;
}) {
  const [detail, setDetail] = useState<WorkDetail>(loaderData);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getWork(loaderData.work.id);
      setDetail(next);
    } catch {
      /* ポーリング失敗は次回に委ねる */
    }
  }, [loaderData.work.id]);

  useEffect(() => {
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

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
    const res = await fetch(`/api/works/${detail.work.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setError(body.error?.message ?? "送信に失敗しました");
      setSending(false);
      return;
    }
    form.reset();
    setSending(false);
    void refresh();
  };

  const running = detail.active_job !== null;
  const step = latestStep(detail);
  const stream = streamText(detail);
  const { work } = detail;

  return (
    <main className="page">
      <nav className="topnav">
        <Link to="/" className="brand">
          放置作家
        </Link>
        <span className="spacer" />
        <Link to="/settings/keys">APIキー設定</Link>
      </nav>
      <div className="work-layout">
        <section>
          <h1>{work.title}</h1>
          <div className="chat">
            {detail.messages.map((m) => (
              <div className={`msg ${m.role}`} key={m.id}>
                <div className="who">
                  {m.role === "user" ? "あなた" : "オーケストレーター"}
                </div>
                {m.content}
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
    </main>
  );
}
