import { Link, redirect, type MetaFunction , type RouterContextProvider } from "react-router";
import { listWorksByOwner } from "@houchi/database";
import { createAuthClient } from "better-auth/react";
import { requireUser } from "../lib/server";
import { cloudflareContext, depsContext } from "../lib/context";
import type { WorkInfo } from "../lib/types";

export const meta: MetaFunction = () => [{ title: "作品一覧 | 放置作家" }];

const authClient = createAuthClient();

const STATUS_LABEL: Record<WorkInfo["status"], string> = {
  setup: "初期化中",
  active: "進行中",
};

const STATUS_BADGE: Record<WorkInfo["status"], string> = {
  setup: "badge badge--warn",
  active: "badge badge--ok",
};

export async function loader({
  context,
  request,
}: {
  context: RouterContextProvider;
  request: Request;
}) {
  const user = await requireUser(context, request);
  const works = await listWorksByOwner(context.get(depsContext).db, user.id);
  return { user, works };
}

export default function Home({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  return (
    <main className="page">
      <nav className="topnav">
        <span className="brand">放置作家</span>
        <span className="spacer" />
        <Link to="/settings/keys">APIキー設定</Link>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void authClient.signOut().then(() => {
              window.location.href = "/login";
            });
          }}
        >
          ログアウト
        </button>
      </nav>
      <h1>作品一覧</h1>
      <p className="muted">{loaderData.user.name} としてログイン中</p>
      {loaderData.works.length === 0 ? (
        <div className="empty">
          まだ作品がありません。最初の作品を作りましょう。
        </div>
      ) : (
        loaderData.works.map((w) => (
          <Link className="card work-card" key={w.id} to={`/works/${w.id}`}>
            <h2>{w.title}</h2>
            <div className="card-meta">
              <span className={STATUS_BADGE[w.status]}>
                {STATUS_LABEL[w.status]}
              </span>
              <span>
                更新: {new Date(w.updated_at).toLocaleString("ja-JP")}
              </span>
            </div>
            {w.premise ? <p>{w.premise}</p> : null}
          </Link>
        ))
      )}
      <div className="form-actions">
        <Link className="btn" to="/works/new">
          新しい作品を作る
        </Link>
      </div>
    </main>
  );
}
