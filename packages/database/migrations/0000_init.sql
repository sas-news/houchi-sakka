CREATE TABLE `agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`work_ref` text,
	`payload` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL DEFAULT 'queued',
	`leased_by` text,
	`lease_token` text,
	`lease_expires_at` integer,
	`attempts` integer NOT NULL DEFAULT 0,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_jobs_idempotency_key_uq` ON `agent_jobs` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `agent_jobs_queue_idx` ON `agent_jobs` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `agent_jobs_lease_idx` ON `agent_jobs` (`status`,`lease_expires_at`);
--> statement-breakpoint
CREATE TABLE `progress_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `progress_events_job_seq_uq` ON `progress_events` (`job_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `progress_events_job_idx` ON `progress_events` (`job_id`);
--> statement-breakpoint
CREATE TABLE `provider_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_ref` text NOT NULL,
	`label` text NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer NOT NULL
);
