ALTER TABLE `works` ADD `canon_rev` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `canon_facts` ADD `valid_from_rev` integer;--> statement-breakpoint
ALTER TABLE `canon_facts` ADD `valid_to_rev` integer;--> statement-breakpoint
ALTER TABLE `scene_revisions` ADD `change_set_id` text;--> statement-breakpoint
DROP INDEX `canon_facts_work_statement_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `canon_facts_work_statement_current_uq` ON `canon_facts` (`work_id`,`statement`) WHERE valid_to_rev IS NULL;--> statement-breakpoint
CREATE TABLE `change_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`kind` text DEFAULT 'normal' NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`ops` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`impact` text NOT NULL,
	`force` integer DEFAULT 0 NOT NULL,
	`message_id` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`applied_at` integer
);
--> statement-breakpoint
CREATE INDEX `change_sets_work_idx` ON `change_sets` (`work_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `change_sets_message_uq` ON `change_sets` (`message_id`);--> statement-breakpoint
CREATE TABLE `review_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`change_set_id` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`scene_id` text,
	`fact_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `review_findings_change_set_idx` ON `review_findings` (`change_set_id`);--> statement-breakpoint
CREATE INDEX `review_findings_scene_idx` ON `review_findings` (`scene_id`);
