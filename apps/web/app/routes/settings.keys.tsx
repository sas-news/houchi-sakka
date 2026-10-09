import { useState, type FormEvent } from "react";
import { Link, useNavigate, type MetaFunction , type RouterContextProvider } from "react-router";
import { listKeysByOwner } from "@houchi/database";
import { requireUser } from "../lib/server";
import { cloudflareContext, depsContext } from "../lib/context";
import type { KeyInfo } from "../lib/types";

export const meta: MetaFunction = () => [
  { title: "APIキー設定 | 放置作家" },
];

const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

export async function loader({
  context,
  request,
}: {
  context: RouterContextProvider;
  request: Request;
}) {
  const user = await requireUser(context, request);
  const keys = (await listKeysByOwner(context.get(depsContext).db, user.id)).map(
    ({ ciphertext: _drop, ...pub }) => pub,
  );
  return { keys };
}

export default function KeysPage({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    const res = await fetch("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: String(data.get("provider")),
        label: String(data.get("label")),
        api_key: String(data.get("api_key")),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setError(body.error?.message ?? "登録に失敗しました");
      setBusy(false);
      return;
    }
    form.reset();
    setBusy(false);
    navigate(0);
  };

  const remove = async (id: string, label: string) => {
    if (!window.confirm(`キー「${label}」を削除しますか?`)) return;
    setError(null);
    const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("削除に失敗しました");
      return;
    }
    navigate(0);
  };

  return (
    <main className="page">
      <nav className="topnav">
        <Link to="/" className="brand">
          放置作家
        </Link>
        <span className="spacer" />
        <Link to="/">作品一覧</Link>
      </nav>
      <h1>APIキー設定</h1>

      <div className="card">
        <h2>キーを登録する</h2>
        <p className="notice">
          キーは暗号化して保存されます。登録後に平文を再表示することは
          ありません。漏えい時の影響を減らすため、利用量の上限がある
          制限付きキーや、プロジェクト別に分けたキーの発行を推奨します。
        </p>
        <form onSubmit={(e) => void submit(e)}>
          <label htmlFor="provider">プロバイダー</label>
          <select id="provider" name="provider" required>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
          <label htmlFor="label">ラベル (自分用の名前)</label>
          <input
            id="label"
            name="label"
            type="text"
            required
            maxLength={100}
          />
          <label htmlFor="api_key">APIキー</label>
          <input
            id="api_key"
            name="api_key"
            type="password"
            required
            maxLength={500}
            autoComplete="off"
          />
          {error ? <p className="error-text">{error}</p> : null}
          <div className="form-actions">
            <button type="submit" disabled={busy}>
              登録する
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>登録済みのキー</h2>
        {loaderData.keys.length === 0 ? (
          <p className="muted">登録済みのキーはありません。</p>
        ) : (
          loaderData.keys.map((k: KeyInfo) => (
            <div className="card" key={k.id}>
              <p>
                <strong>{k.label}</strong> (
                {PROVIDER_LABEL[k.provider] ?? k.provider})
              </p>
              <p className="muted">
                登録日: {new Date(k.created_at).toLocaleString("ja-JP")}
              </p>
              <button
                type="button"
                className="danger"
                onClick={() => void remove(k.id, k.label)}
              >
                削除
              </button>
            </div>
          ))
        )}
      </div>
    </main>
  );
}
