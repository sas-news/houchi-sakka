CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`episode_id` text NOT NULL,
	`rev_no` integer NOT NULL,
	`canon_rev` integer NOT NULL,
	`title` text NOT NULL,
	`content_json` text NOT NULL,
	`status` text DEFAULT 'published' NOT NULL,
	`published_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_episode_rev_uq` ON `releases` (`episode_id`,`rev_no`);--> statement-breakpoint
CREATE INDEX `releases_work_idx` ON `releases` (`work_id`);--> statement-breakpoint
CREATE INDEX `releases_episode_idx` ON `releases` (`episode_id`);
