import { useState, type FormEvent } from "react";
import { Link, useNavigate, type MetaFunction , type RouterContextProvider } from "react-router";
import { listKeyUsageCounts, listKeysByOwner } from "@houchi/database";
import { requireUser } from "../lib/server";
import { cloudflareContext, depsContext } from "../lib/context";
import type { KeyInfo } from "../lib/types";

export const meta: MetaFunction = () => [
  { title: "APIキー設定 | 放置作家" },
];

const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  github: "GitHub Models",
  custom: "カスタム (OpenAI互換)",
};

export async function loader({
  context,
  request,
}: {
  context: RouterContextProvider;
  request: Request;
}) {
  const user = await requireUser(context, request);
  const db = context.get(depsContext).db;
  const usage = await listKeyUsageCounts(db, user.id);
  const keys = (await listKeysByOwner(db, user.id)).map(
    ({ ciphertext: _drop, ...pub }) => ({
      ...pub,
      works_using: usage.get(pub.id) ?? 0,
    }),
  );
  return { keys };
}

export default function KeysPage({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
    openai: "gpt-4o-mini",
    gemini: "gemini-2.5-flash",
    anthropic: "claude-haiku-4-5",
    openrouter: "meta-llama/llama-3.3-70b-instruct:free",
    groq: "openai/gpt-oss-120b",
    github: "gpt-4o-mini",
  };

  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState("openai");
  const [testState, setTestState] = useState<
    Record<
      string,
      { busy: boolean; model: string; result: string | null; ok: boolean | null }
    >
  >({});

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    const baseUrl = String(data.get("base_url") ?? "").trim();
    const res = await fetch("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: String(data.get("provider")),
        label: String(data.get("label")),
        api_key: String(data.get("api_key")),
        ...(baseUrl !== "" ? { base_url: baseUrl } : {}),
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

  const runTest = async (k: KeyInfo) => {
    const cur = testState[k.id] ?? {
      busy: false,
      model: PROVIDER_DEFAULT_MODEL[k.provider] ?? "",
      result: null,
      ok: null,
    };
    setTestState((s) => ({
      ...s,
      [k.id]: { ...cur, busy: true, result: null, ok: null },
    }));
    try {
      const res = await fetch(`/api/keys/${k.id}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cur.model ? { model: cur.model } : {}),
      });
      const b = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        model?: string;
        ms?: number;
        response?: string;
        error?: string;
      };
      setTestState((s) => ({
        ...s,
        [k.id]: {
          ...cur,
          busy: false,
          ok: !!b.ok,
          result: b.ok
            ? `成功 (${b.ms}ms) ${(b.response ?? "").slice(0, 80)}`
            : `失敗: ${b.error ?? "不明なエラー"}`,
        },
      }));
    } catch {
      setTestState((s) => ({
        ...s,
        [k.id]: { ...cur, busy: false, ok: false, result: "失敗: 通信エラー" },
      }));
    }
  };

  const remove = async (k: KeyInfo) => {
    const inUse = k.works_using ?? 0;
    const warn =
      inUse > 0
        ? `\nこのキーを使っている作品が ${inUse} 件あります。削除するとそれらの作品で対話・生成・レビューが止まります。`
        : "";
    if (!window.confirm(`キー「${k.label}」を削除しますか?${warn}`)) return;
    setError(null);
    const res = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
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
          OpenAI はプロジェクト別キー、Anthropic はワークスペース別の
          発行でスコープを絞れます。Google Gemini は AI Studio
          (aistudio.google.com) で、GitHub Models は GitHub の
          個人アクセストークンで無料で利用できます。
        </p>
        <form onSubmit={(e) => void submit(e)}>
          <label htmlFor="provider">プロバイダー</label>
          <select
            id="provider"
            name="provider"
            required
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Google Gemini (無料枠あり)</option>
            <option value="openrouter">OpenRouter</option>
            <option value="groq">Groq (無料枠あり)</option>
            <option value="github">GitHub Models (無料)</option>
            <option value="custom">OpenAI互換 (カスタムURL)</option>
          </select>
          {provider === "github" ? (
            <p className="side-note">
              GitHub の個人アクセストークン (PAT) を APIキー欄に入力します。
              github.com/settings/personal-access-tokens で発行できます。
            </p>
          ) : null}
          {provider === "custom" ? (
            <>
              <label htmlFor="base_url">エンドポイントURL (OpenAI互換)</label>
              <input
                id="base_url"
                name="base_url"
                type="url"
                required
                placeholder="https://example.com/v1"
              />
              <p className="side-note">
                /chat/completions に対応する OpenAI 互換APIの URL。
                Ollama や LM Studio などローカルLLMにも使えます
                (runner がローカル実行の場合のみ到達可能)。
              </p>
            </>
          ) : null}
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
          <div className="empty">登録済みのキーはありません。</div>
        ) : (
          loaderData.keys.map((k: KeyInfo) => (
            <div className="key-row" key={k.id}>
              <div className="key-info">
                <span className="key-name">{k.label}</span>{" "}
                <span className="key-provider">
                  {PROVIDER_LABEL[k.provider] ?? k.provider}
                </span>
                <div className="key-date">
                  登録日: {new Date(k.created_at).toLocaleString("ja-JP")}
                </div>
                {(k.works_using ?? 0) > 0 ? (
                  <div className="key-date">
                    使用中の作品: {k.works_using} 件
                  </div>
                ) : null}
                <div className="key-test-row">
                  <input
                    className="key-test-model"
                    type="text"
                    placeholder="モデル (省略時は既定)"
                    value={testState[k.id]?.model ?? ""}
                    onChange={(e) =>
                      setTestState((s) => ({
                        ...s,
                        [k.id]: {
                          ...(s[k.id] ?? {
                            busy: false,
                            result: null,
                            ok: null,
                            model: "",
                          }),
                          model: e.target.value,
                        },
                      }))
                    }
                  />
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={testState[k.id]?.busy}
                    onClick={() => void runTest(k)}
                  >
                    {testState[k.id]?.busy ? "テスト中…" : "接続テスト"}
                  </button>
                </div>
                {testState[k.id]?.result ? (
                  <div
                    className={`key-date ${testState[k.id]?.ok ? "" : "error-text"}`}
                  >
                    {testState[k.id]?.result}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="danger btn-sm"
                onClick={() => void remove(k)}
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
