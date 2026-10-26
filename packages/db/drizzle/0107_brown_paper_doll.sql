SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
CREATE TYPE "public"."visit_recording_consent_action" AS ENUM('granted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."visit_recording_status" AS ENUM('awaiting_audio', 'transcribing', 'transcribed', 'failed', 'discarded');--> statement-breakpoint
CREATE TABLE "visit_recording_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"action" "visit_recording_consent_action" NOT NULL,
	"signer_name" varchar(255) NOT NULL,
	"disclosure_version" varchar(32) NOT NULL,
	"disclosure" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_name" varchar(255) NOT NULL,
	CONSTRAINT "visit_recording_consents_signer_name_check" CHECK (length(btrim("visit_recording_consents"."signer_name")) between 1 and 255),
	CONSTRAINT "visit_recording_consents_disclosure_check" CHECK (length(btrim("visit_recording_consents"."disclosure_version")) between 1 and 32
        and length(btrim("visit_recording_consents"."disclosure")) between 1 and 4000),
	CONSTRAINT "visit_recording_consents_actor_name_check" CHECK (length(btrim("visit_recording_consents"."actor_name")) between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "visit_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"status" "visit_recording_status" DEFAULT 'awaiting_audio' NOT NULL,
	"audio_object_key" varchar(512),
	"audio_object_version_id" varchar(1024),
	"audio_content_type" varchar(64),
	"audio_bytes" integer,
	"audio_deleted_at" timestamp with time zone,
	"transcription_job_name" varchar(200),
	"transcript" text,
	"transcribed_at" timestamp with time zone,
	"failure_reason" varchar(500),
	CONSTRAINT "visit_recordings_audio_bytes_check" CHECK ("visit_recordings"."audio_bytes" is null or "visit_recordings"."audio_bytes" > 0),
	CONSTRAINT "visit_recordings_transcript_shape_check" CHECK (("visit_recordings"."status" = 'transcribed') = ("visit_recordings"."transcript" is not null and "visit_recordings"."transcribed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "visit_recording_consents" ADD CONSTRAINT "visit_recording_consents_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_recording_consents" ADD CONSTRAINT "visit_recording_consents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_recording_consents" ADD CONSTRAINT "visit_recording_consents_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_recording_consents" ADD CONSTRAINT "visit_recording_consents_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_recording_consents" ADD CONSTRAINT "visit_recording_consents_appointment_patient_tenant_fk" FOREIGN KEY ("practice_id","appointment_id","patient_id") REFERENCES "public"."appointments"("practice_id","id","patient_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_recording_consents" ADD CONSTRAINT "visit_recording_consents_actor_tenant_fk" FOREIGN KEY ("practice_id","actor_user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_recording_consents_tenant_identity_uq" ON "visit_recording_consents" USING btree ("practice_id","id","appointment_id");--> statement-breakpoint
ALTER TABLE "visit_recordings" ADD CONSTRAINT "visit_recordings_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_recordings" ADD CONSTRAINT "visit_recordings_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_recordings" ADD CONSTRAINT "visit_recordings_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_recordings" ADD CONSTRAINT "visit_recordings_consent_id_visit_recording_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."visit_recording_consents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_recordings" ADD CONSTRAINT "visit_recordings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_recordings" ADD CONSTRAINT "visit_recordings_appointment_patient_tenant_fk" FOREIGN KEY ("practice_id","appointment_id","patient_id") REFERENCES "public"."appointments"("practice_id","id","patient_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_recordings" ADD CONSTRAINT "visit_recordings_consent_tenant_fk" FOREIGN KEY ("practice_id","consent_id","appointment_id") REFERENCES "public"."visit_recording_consents"("practice_id","id","appointment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_recordings" ADD CONSTRAINT "visit_recordings_creator_tenant_fk" FOREIGN KEY ("practice_id","created_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visit_recording_consents_appointment_history_idx" ON "visit_recording_consents" USING btree ("practice_id","appointment_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "visit_recordings_appointment_idx" ON "visit_recordings" USING btree ("practice_id","appointment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_recordings_transcription_job_uq" ON "visit_recordings" USING btree ("transcription_job_name") WHERE "visit_recordings"."transcription_job_name" is not null;--> statement-breakpoint
ALTER TABLE "visit_recording_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "visit_recording_consents"
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid)
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "visit_recordings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "visit_recordings"
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid)
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON visit_recording_consents FROM openpims_app;
		GRANT SELECT, INSERT ON visit_recording_consents TO openpims_app;
		REVOKE ALL ON visit_recordings FROM openpims_app;
		GRANT SELECT, INSERT, UPDATE ON visit_recordings TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON visit_recording_consents, visit_recordings FROM anon; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON visit_recording_consents, visit_recordings FROM authenticated; END IF;
END $$;
