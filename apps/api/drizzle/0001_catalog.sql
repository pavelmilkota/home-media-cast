CREATE TABLE `progress` (
	`video_id` text PRIMARY KEY NOT NULL,
	`title_id` text NOT NULL,
	`season` integer,
	`episode` integer,
	`label` text,
	`position_ms` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`watched` integer DEFAULT false NOT NULL,
	`last_played_at` integer NOT NULL,
	FOREIGN KEY (`title_id`) REFERENCES `titles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `titles` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`year` text,
	`poster` text,
	`liked` integer DEFAULT false NOT NULL,
	`saved` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
