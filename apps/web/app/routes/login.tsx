import { useEffect, useState } from "react";
import { redirect, useNavigate, type MetaFunction , type RouterContextProvider } from "react-router";
import { createAuthClient } from "better-auth/react";
import { cloudflareContext, depsContext } from "../lib/context";

export const meta: MetaFunction = () => [{ title: "ログイン | 放置作家" }];

const authClient = createAuthClient();

export async function loader({
  context,
  request,
}: {
  context: RouterContextProvider;
  request: Request;
}) {
  const session = await context.get(depsContext).auth.api.getSession({
    headers: request.headers,
  });
  if (session?.user) throw redirect("/");
  return {
    devLoginEnabled: context.get(depsContext).devLoginEnabled,
    providers: {
      google:
        (context.get(cloudflareContext).env.GOOGLE_CLIENT_ID ?? "") !== "",
      github:
        (context.get(cloudflareContext).env.GITHUB_CLIENT_ID ?? "") !== "",
    },
  };
}

export default function Login({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const social = async (provider: "google" | "github") => {
    setBusy(true);
    setError(null);
    try {
      await authClient.signIn.social({
        provider,
        callbackURL: "/",
      });
    } catch {
      setError("ログインに失敗しました。もう一度お試しください");
      setBusy(false);
    }
  };

  const devLogin = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/dev/login", { method: "POST" });
    if (res.ok) {
      navigate("/", { replace: true });
    } else {
      setError("開発ログインに失敗しました");
      setBusy(false);
    }
  };

  useEffect(() => {
    document.title = "ログイン | 放置作家";
  }, []);

  return (
    <main className="page page--narrow">
      <div className="login-hero">
        <span className="brand-mark" aria-hidden="true" />
        <h1>放置作家</h1>
        <p className="tagline">
          AI執筆前提の創作環境。
          <br />
          オーケストレーターと対話して作品を作ります。
        </p>
      </div>
      <div className="card login-card">
        {error ? <p className="error-text">{error}</p> : null}
        <div className="form-actions">
          {loaderData.providers.google ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void social("google")}
            >
              Google でログイン
            </button>
          ) : null}
          {loaderData.providers.github ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void social("github")}
            >
              GitHub でログイン
            </button>
          ) : null}
          {loaderData.devLoginEnabled ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void devLogin()}
            >
              開発用ログイン (開発環境のみ)
            </button>
          ) : null}
        </div>
        {!loaderData.providers.google &&
        !loaderData.providers.github &&
        !loaderData.devLoginEnabled ? (
          <p className="muted">
            ログインプロバイダーが未設定です。管理者が環境変数
            (GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET) を
            設定する必要があります。
          </p>
        ) : null}
      </div>
    </main>
  );
}
