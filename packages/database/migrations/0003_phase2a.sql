CREATE TABLE `dependency_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`scene_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_ref` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dependency_edges_work_idx` ON `dependency_edges` (`work_id`);--> statement-breakpoint
CREATE INDEX `dependency_edges_scene_idx` ON `dependency_edges` (`scene_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_edges_scene_target_uq` ON `dependency_edges` (`scene_id`,`target_kind`,`target_ref`);
