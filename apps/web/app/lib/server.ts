import { redirect, type RouterContextProvider } from "react-router";
import {
  getThreadByWorkId,
  getWorkById,
  listMessages,
  listOpenJobsByWork,
  listProgress,
} from "@houchi/database";
import { depsContext } from "./context";

/** セッションユーザーを要求。未ログインは /login へリダイレクト。 */
export async function requireUser(
  context: RouterContextProvider,
  request: Request,
) {
  const session = await context
    .get(depsContext)
    .auth.api.getSession({ headers: request.headers });
  if (!session?.user) throw redirect("/login");
  return session.user;
}

/** GET /api/works/:id と同じ組立 (SSR 用に共有)。 */
export async function getWorkDetail(
  context: RouterContextProvider,
  workId: string,
) {
  const db = context.get(depsContext).db;
  const work = await getWorkById(db, workId);
  if (!work) return null;
  const thread = await getThreadByWorkId(db, work.id);
  if (!thread) return null;
  const messages = await listMessages(db, thread.id);
  const openJobs = await listOpenJobsByWork(db, work.id);
  const active = openJobs[0] ?? null;
  return {
    work,
    thread,
    messages,
    active_job: active
      ? {
          job: { ...active, lease_token: null },
          progress: (await listProgress(db, active.id)).slice(-50),
        }
      : null,
    queued_jobs: Math.max(0, openJobs.length - 1),
  };
}
