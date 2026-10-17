-- spec §7.4: AgentStep — ジョブ内の実行ステップ記録。
-- 進捗イベント (progress_events, UI 表示用) とは別に、監査・再開用の
-- 永続記録として、ステップ名・開始/終了・モデル/プロバイダー・使用量・
-- 成果物参照・エラーを残す。
--
-- spec §7.2: 自律運転レベルと実行上限 (autonomy_level / autonomy_budget)
-- を作品単位で保持する。

ALTER TABLE works ADD COLUMN autonomy_level TEXT NOT NULL DEFAULT 'off';
--> statement-breakpoint
ALTER TABLE works ADD COLUMN autonomy_budget INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

CREATE TABLE agent_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  model TEXT,
  provider TEXT,
  usage_json TEXT,
  artifact_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_steps_job_seq_uq ON agent_steps(job_id, seq);
--> statement-breakpoint
CREATE INDEX agent_steps_job_idx ON agent_steps(job_id);
