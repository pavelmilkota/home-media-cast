CREATE TABLE `playback_history` (
	`video_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title_id` text NOT NULL,
	`name` text NOT NULL,
	`year` text,
	`poster` text,
	`label` text,
	`release_title` text NOT NULL,
	`resolution` text,
	`quality` text,
	`release_key` text NOT NULL,
	`played_at` integer NOT NULL
);
