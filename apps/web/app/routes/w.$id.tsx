import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Link,
  useRouteError,
  type MetaFunction,
  type RouterContextProvider,
} from "react-router";
import { getWorkById, listPublicWorkEpisodes } from "@houchi/database";
import { depsContext } from "../lib/context";
import type { PublicWorkEpisodeInfo } from "../lib/types";

/**
 * /w/:id — 読者向けの作品ページ (ログイン不要, spec P9)。
 * 公開済みリリースの話目次だけを描く。published が 1 件も無い作品は
 * 存在自体を出さず 404。正典・下書き・ユーザー情報は loader からも返さない。
 */

interface EpisodeRow extends PublicWorkEpisodeInfo {
  /** 公開日 (JST で文字列化済み — SSR/CSR の TZ ずれを防ぐ)。 */
  publishedLabel: string;
}

interface LoaderData {
  work: { id: string; title: string; premise: string };
  episodes: EpisodeRow[];
}

export async function loader({
  context,
  params,
}: {
  context: RouterContextProvider;
  params: { id: string };
}): Promise<LoaderData> {
  const db = context.get(depsContext).db;
  const work = await getWorkById(db, params.id);
  if (!work) {
    throw new Response("Not Found", { status: 404 });
  }
  const episodes = await listPublicWorkEpisodes(db, work.id);
  if (episodes.length === 0) {
    throw new Response("Not Found", { status: 404 });
  }
  return {
    work: { id: work.id, title: work.title, premise: work.premise },
    episodes: episodes.map((ep) => ({
      ...ep,
      publishedLabel: new Date(ep.published_at).toLocaleDateString("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    })),
  };
}

export const meta: MetaFunction = (args) => {
  const d = args.loaderData as LoaderData | undefined;
  return d ? [{ title: `${d.work.title} | 放置作家` }] : [{ title: "放置作家" }];
};

export default function WorkIndexPage({
  loaderData,
}: {
  loaderData: LoaderData;
}) {
  const { work, episodes } = loaderData;
  return (
    <main className="reader">
      <header className="reader-head">
        <h1 className="reader-title">{work.title}</h1>
        <p className="reader-meta">全{episodes.length}話</p>
      </header>
      {work.premise ? <p className="reader-premise">{work.premise}</p> : null}
      <ol className="reader-toc">
        {episodes.map((ep) => (
          <li key={ep.episode_id}>
            <Link to={`/r/${ep.release_id}`} className="reader-toc-link">
              <span className="reader-toc-title">
                第{ep.ord}話 {ep.title}
              </span>
              <span className="reader-toc-meta">
                第{ep.rev_no}版・{ep.publishedLabel}公開
                {ep.version_count > 1 ? `・全${ep.version_count}版` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ol>
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
            ? "公開作品が見つからないか、まだ公開されていません。URLを確かめてください。"
            : "時間をおいてもう一度お試しください。"}
        </p>
        <p>
          <Link to="/">放置作家のトップへ戻る</Link>
        </p>
      </div>
    </main>
  );
}
