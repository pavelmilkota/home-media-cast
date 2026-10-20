CREATE TABLE `stream_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`results` text NOT NULL,
	`errors` text NOT NULL,
	`fetched_at` integer NOT NULL
);
