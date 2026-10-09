import { useState, type FormEvent } from "react";
import { Link, useNavigate, type MetaFunction , type RouterContextProvider } from "react-router";
import { requireUser } from "../lib/server";

export const meta: MetaFunction = () => [
  { title: "新しい作品 | 放置作家" },
];

export async function loader({
  context,
  request,
}: {
  context: RouterContextProvider;
  request: Request;
}) {
  await requireUser(context, request);
  return {};
}

export default function NewWork() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const res = await fetch("/api/works", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: String(form.get("title") ?? ""),
        premise: String(form.get("premise") ?? ""),
      }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setError(data.error?.message ?? "作成に失敗しました");
      setBusy(false);
      return;
    }
    const { work } = (await res.json()) as { work: { id: string } };
    navigate(`/works/${work.id}`);
  };

  return (
    <main className="page">
      <nav className="topnav">
        <Link to="/" className="brand">
          放置作家
        </Link>
      </nav>
      <h1>新しい作品</h1>
      <div className="card">
        <form onSubmit={(e) => void submit(e)}>
          <label htmlFor="title">タイトル (仮でも可、対話で後から変えられます)</label>
          <input id="title" name="title" type="text" required maxLength={200} />
          <label htmlFor="premise">
            ひとこと (どんな物語にしたいか。未記入でも始められます)
          </label>
          <textarea id="premise" name="premise" maxLength={2000} />
          {error ? <p className="error-text">{error}</p> : null}
          <div className="form-actions">
            <button type="submit" disabled={busy}>
              作成して対話を始める
            </button>
            <Link className="btn secondary" to="/">
              キャンセル
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
