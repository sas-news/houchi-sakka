ALTER TABLE `works` ADD `charter_json` text;--> statement-breakpoint
ALTER TABLE `works` ADD `policy_json` text;--> statement-breakpoint
ALTER TABLE `works` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `works` ADD `model` text;--> statement-breakpoint
ALTER TABLE `works` ADD `key_ref` text;--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`ord` integer NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `episodes_work_idx` ON `episodes` (`work_id`,`ord`);--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`ord` integer NOT NULL,
	`title` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scenes_episode_idx` ON `scenes` (`episode_id`,`ord`);--> statement-breakpoint
CREATE TABLE `scene_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`rev_no` integer NOT NULL,
	`content_json` text NOT NULL,
	`source` text NOT NULL,
	`job_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scene_revisions_rev_uq` ON `scene_revisions` (`scene_id`,`rev_no`);--> statement-breakpoint
CREATE INDEX `scene_revisions_scene_idx` ON `scene_revisions` (`scene_id`);--> statement-breakpoint
CREATE TABLE `writing_contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `writing_contracts_scene_idx` ON `writing_contracts` (`scene_id`);--> statement-breakpoint
CREATE TABLE `canon_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`statement` text NOT NULL,
	`provenance` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `canon_facts_work_idx` ON `canon_facts` (`work_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `canon_facts_work_statement_uq` ON `canon_facts` (`work_id`,`statement`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proposals_work_idx` ON `proposals` (`work_id`);--> statement-breakpoint
CREATE INDEX `proposals_thread_idx` ON `proposals` (`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `proposals_message_kind_uq` ON `proposals` (`message_id`,`kind`);
