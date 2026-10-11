import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Link,
  useRouteError,
  type MetaFunction,
  type RouterContextProvider,
} from "react-router";
import { getReleaseById, getWorkById } from "@houchi/database";
import { depsContext } from "../lib/context";
import type { PublicReleaseInfo } from "../lib/types";

/**
 * /r/:id — 読者向け公開ページ (ログイン不要, spec P9)。
 * 不変リリーススナップショットだけを描く。正典・下書き・ユーザー情報は
 * loader からも返さない。
 */

interface LoaderData {
  release: PublicReleaseInfo;
  /** 公開日 (JST で文字列化済み — SSR/CSR の TZ ずれを防ぐ)。 */
  publishedLabel: string;
}

export async function loader({
  context,
  params,
}: {
  context: RouterContextProvider;
  params: { id: string };
}): Promise<LoaderData> {
  const db = context.get(depsContext).db;
  const release = await getReleaseById(db, params.id);
  if (!release || release.status !== "published") {
    throw new Response("Not Found", { status: 404 });
  }
  const work = await getWorkById(db, release.work_id);
  if (!work) {
    throw new Response("Not Found", { status: 404 });
  }
  const publishedLabel = new Date(release.published_at).toLocaleDateString(
    "ja-JP",
    { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" },
  );
  return {
    release: {
      id: release.id,
      work_title: work.title,
      title: release.title,
      rev_no: release.rev_no,
      published_at: release.published_at,
      scenes: release.content,
    },
    publishedLabel,
  };
}

export const meta: MetaFunction = (args) => {
  const d = args.loaderData as LoaderData | undefined;
  return d
    ? [
        {
          title: `${d.release.title} | ${d.release.work_title} | 放置作家`,
        },
      ]
    : [{ title: "放置作家" }];
};

export default function ReaderPage({
  loaderData,
}: {
  loaderData: LoaderData;
}) {
  const { release, publishedLabel } = loaderData;
  return (
    <main className="reader">
      <header className="reader-head">
        <p className="reader-work">{release.work_title}</p>
        <h1 className="reader-title">{release.title}</h1>
        <p className="reader-meta">
          第{release.rev_no}版・{publishedLabel}公開
        </p>
      </header>
      <article className="reader-body">
        {release.scenes.map((scene) => (
          <section key={scene.scene_ord} className="reader-scene">
            <h2 className="reader-scene-title">{scene.scene_title}</h2>
            {scene.prose_md
              .split(/\n+/)
              .map((p) => p.trim())
              .filter((p) => p.length > 0)
              .map((p, i) => (
                <p key={i}>{p}</p>
              ))}
          </section>
        ))}
      </article>
      <footer className="reader-foot">
        <span className="reader-foot-line" aria-hidden="true" />
        <p>
          この作品は AI 執筆環境
          <Link to="/">放置作家</Link>
          で書かれ、公開されています。
        </p>
      </footer>
    </main>
  );
}

export function ErrorBoundary(): ReactNode {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main className="reader">
      <div className="reader-error">
        <h1>{notFound ? "この作品は読めません" : "エラーが発生しました"}</h1>
        <p className="muted">
          {notFound
            ? "公開版が見つからないか、取り下げられました。URLを確かめてください。"
            : "時間をおいてもう一度お試しください。"}
        </p>
        <p>
          <Link to="/">放置作家のトップへ戻る</Link>
        </p>
      </div>
    </main>
  );
}
