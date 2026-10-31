ALTER TABLE "users" ADD COLUMN "apple_subject" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "apple_linked_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "users_apple_subject_uq" ON "users" USING btree ("apple_subject") WHERE "users"."apple_subject" is not null;