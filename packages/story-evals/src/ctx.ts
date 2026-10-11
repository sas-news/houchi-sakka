// ---------------------------------------------------------------------------
// evals 用のインメモリ JobContext。
// runOrchestratorTurn / runSkillStep を実物のまま動かし、副作用 (メッセージ永続
// 化・提案・パッチ・ジョブ起票) を記録してマーカー発火を「実効果」として検出
// する。サーバー側の冪等ルール (job_id ユニーク・statement 重複スキップ) も
// ここで再現する。
// ---------------------------------------------------------------------------

import {
  type AgentJob,
  type CanonFact,
  type ChangeSetOp,
  type ChangeSetWithFindings,
  type ChatMessage,
  type ChatRole,
  type ChatThread,
  type DependencyEdgeInput,
  type Proposal,
  type SceneRevision,
  type Work,
  type WorkPatchRequest,
} from "@houchi/contracts";
import type { JobContext } from "@houchi/harness";
import type { Provider } from "@houchi/providers";

/** 1ターンで観測された副作用。マーカー発火の検出に使う。 */
export interface TurnEffects {
  /** applyWorkPatch が呼ばれたか (+適用されたキー)。 */
  work_patched: string[];
  /** addCanonFacts で追加を試みた statement。 */
  canon_added: string[];
  /** createProposal で作られた提案。 */
  proposals_created: { kind: string; payload: Record<string, unknown> }[];
  /** enqueueJob で起票されたジョブ。 */
  jobs_enqueued: { kind: string; payload: Record<string, unknown> }[];
  /** createChangeSet で作られた変更セット。 */
  change_sets_created: { title: string; ops: unknown[] }[];
  /** persistChatMessage で保存された assistant 本文 (cleanText)。 */
  assistant_text: string;
  /** job の結果 (OrchestratorTurnResult)。 */
  result: unknown;
}

/** シナリオ全体のインメモリ状態。 */
export interface EvalWorld {
  work: Work;
  thread: ChatThread;
  messages: ChatMessage[];
  canon_facts: CanonFact[];
  proposals: Proposal[];
  jobs: AgentJob[];
  user_ref: string;
  key_ref: string;
  provider_name: string;
  model: string;
}

export function makeWork(input: {
  title: string;
  premise: string;
  genre: string;
  status: "setup" | "active";
}): Work {
  return {
    id: "eval-work",
    owner_ref: "eval-user",
    title: input.title,
    premise: input.premise,
    genre: input.genre,
    status: input.status,
    charter: null,
    policy: null,
    provider: null,
    model: null,
    key_ref: null,
    canon_rev: 0,
    created_at: 0,
    updated_at: 0,
  };
}

export function makeEvalWorld(
  work: Work,
  canonFacts: CanonFact[],
  opts: { provider_name: string; model: string },
): EvalWorld {
  return {
    work,
    thread: { id: "eval-thread", work_id: work.id, created_at: 0 },
    messages: [],
    canon_facts: canonFacts,
    proposals: [],
    jobs: [],
    user_ref: "eval-user",
    key_ref: "eval-key",
    provider_name: opts.provider_name,
    model: opts.model,
  };
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function makeJob(kind: string, payload: Record<string, unknown>): AgentJob {
  return {
    id: nextId("eval-job"),
    kind,
    work_ref: "eval-work",
    user_ref: "eval-user",
    payload,
    idempotency_key: nextId("eval-idem"),
    status: "leased",
    leased_by: "eval-runner",
    lease_token: "t",
    lease_expires_at: Date.now() + 60_000,
    attempts: 1,
    result: null,
    error: null,
    created_at: 0,
    updated_at: 0,
  };
}

/**
 * JobContext の骨組み。provider と APIキー解決だけは呼び出し側から受け取る。
 * effects は「このターンで起きた副作用」を集めるバッファ —— ターンごとに
 * リセットして使う。
 */
export function makeEvalCtx(args: {
  world: EvalWorld;
  provider: Provider;
  apiKey: string;
  effects: TurnEffects;
  completed?: unknown[];
  failed?: string[];
}): JobContext {
  const { world, effects } = args;
  return {
    resolveKey: async () => args.apiKey,
    getProvider: () => args.provider,
    postProgress: async () => {},
    saveCheckpoint: async () => {},
    complete: async (result) => {
      args.completed?.push(result);
    },
    fail: async (error) => {
      args.failed?.push(error);
    },
    fetchOrchestratorContext: async () => ({
      work: world.work,
      thread: world.thread,
      messages: world.messages,
      canon_facts: world.canon_facts,
      proposals: world.proposals,
      workspace_files: [],
      plan_tree: "",
    }),
    persistChatMessage: async (req: {
      thread_id: string;
      role: ChatRole;
      content: string;
      job_id: string;
    }): Promise<ChatMessage> => {
      const message: ChatMessage = {
        id: nextId("eval-msg"),
        thread_id: req.thread_id,
        role: req.role,
        content: req.content,
        job_id: req.job_id,
        created_at: world.messages.length,
      };
      world.messages.push(message);
      if (req.role === "assistant") effects.assistant_text = req.content;
      return message;
    },
    applyWorkPatch: async (_workId: string, patch: WorkPatchRequest) => {
      const applied: string[] = [];
      for (const key of [
        "title",
        "premise",
        "genre",
        "status",
        "charter",
        "policy",
      ] as const) {
        if (patch[key] !== undefined) {
          applied.push(key);
          if (key === "charter" || key === "policy") {
            world.work[key] = patch[key] as unknown;
          } else {
            (world.work as Record<string, unknown>)[key] = patch[key];
          }
        }
      }
      world.work.updated_at += 1;
      effects.work_patched.push(...applied);
    },
    createProposal: async (req: {
      work_id: string;
      thread_id: string;
      message_id: string;
      kind: string;
      payload: Record<string, unknown>;
    }): Promise<Proposal> => {
      const proposal: Proposal = {
        id: nextId("eval-proposal"),
        work_id: req.work_id,
        thread_id: req.thread_id,
        message_id: req.message_id,
        kind: req.kind,
        payload: req.payload,
        status: "pending",
        decided_at: null,
        created_at: world.proposals.length,
      };
      world.proposals.push(proposal);
      effects.proposals_created.push({
        kind: req.kind,
        payload: req.payload,
      });
      return proposal;
    },
    addCanonFacts: async (req: {
      work_id: string;
      statements: string[];
      provenance: string;
    }) => {
      let added = 0;
      for (const statement of req.statements) {
        // サーバー側の完全一致重複スキップを再現。
        if (world.canon_facts.some((f) => f.statement === statement)) continue;
        world.canon_facts.push({
          id: nextId("eval-fact"),
          work_id: req.work_id,
          statement,
          provenance: req.provenance,
          valid_from_rev: null,
          valid_to_rev: null,
          created_at: world.canon_facts.length,
        });
        added += 1;
        effects.canon_added.push(statement);
      }
      return { added };
    },
    createChangeSet: async (req: {
      work_id: string;
      title: string;
      description?: string;
      ops: ChangeSetOp[];
      message_id?: string | null;
    }): Promise<ChangeSetWithFindings> => {
      const cs: ChangeSetWithFindings = {
        id: nextId("eval-cs"),
        work_id: req.work_id,
        kind: "normal",
        title: req.title,
        description: req.description ?? "",
        ops: req.ops as ChangeSetWithFindings["ops"],
        status: "proposed",
        impact: { scenes: [], facts: [], contracts: [], summary: "" },
        force: 0,
        message_id: req.message_id ?? null,
        created_at: 0,
        decided_at: null,
        applied_at: null,
        findings: [],
      };
      effects.change_sets_created.push({ title: req.title, ops: req.ops });
      return cs;
    },
    enqueueJob: async (req: {
      kind: string;
      work_ref: string;
      user_ref: string;
      payload: Record<string, unknown>;
      idempotency_key: string;
    }): Promise<AgentJob> => {
      const job = makeJob(req.kind, req.payload);
      world.jobs.push(job);
      effects.jobs_enqueued.push({ kind: req.kind, payload: req.payload });
      return job;
    },
  };
}

/** runSkillStep を動かすためだけの最小 ctx (会話永続化系は不要)。 */
export function makeSkillCtx(args: {
  provider: Provider;
  apiKey: string;
}): JobContext {
  return {
    resolveKey: async () => args.apiKey,
    getProvider: () => args.provider,
    postProgress: async () => {},
    saveCheckpoint: async () => {},
    complete: async () => {},
    fail: async () => {},
    persistSceneRevision: async (req: {
      scene_id: string;
      content_json: unknown;
      source: "ai" | "manual_edit";
      job_id: string | null;
    }): Promise<SceneRevision> => ({
      id: "eval-rev",
      scene_id: req.scene_id,
      rev_no: 1,
      content_json: req.content_json,
      source: req.source,
      job_id: req.job_id,
      change_set_id: null,
      created_at: 0,
    }),
    recordDependencies: async (req: {
      scene_id: string;
      work_id: string;
      edges: DependencyEdgeInput[];
    }) => ({ added: req.edges.length }),
  };
}
