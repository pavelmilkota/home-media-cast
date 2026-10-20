CREATE TABLE `last_source` (
	`video_id` text PRIMARY KEY NOT NULL,
	`release_key` text NOT NULL,
	`played_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `last_source` (`video_id`, `release_key`, `played_at`)
SELECT `video_id`, `release_key`, `last_played_at` FROM `progress` WHERE `release_key` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `progress` DROP COLUMN `release_key`;