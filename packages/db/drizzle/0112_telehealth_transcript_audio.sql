ALTER TABLE "telehealth_visits" ADD COLUMN "audio_object_key" varchar(512);--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD COLUMN "audio_object_version_id" varchar(1024);--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD COLUMN "transcription_job_name" varchar(200);