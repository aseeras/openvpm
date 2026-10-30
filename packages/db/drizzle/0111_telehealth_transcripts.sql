CREATE TABLE "telehealth_transcript_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"action" varchar(16) NOT NULL,
	"signer_name" varchar(255) NOT NULL,
	"disclosure_version" varchar(32) NOT NULL,
	"disclosure" text NOT NULL,
	CONSTRAINT "telehealth_transcript_consents_action_check" CHECK ("telehealth_transcript_consents"."action" in ('granted', 'declined')),
	CONSTRAINT "telehealth_transcript_consents_text_check" CHECK (length(btrim("telehealth_transcript_consents"."signer_name")) between 1 and 255
        and length(btrim("telehealth_transcript_consents"."disclosure_version")) between 1 and 32
        and length(btrim("telehealth_transcript_consents"."disclosure")) between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD COLUMN "transcript_status" varchar(16) DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD COLUMN "transcript" text;--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD COLUMN "transcript_error" varchar(300);--> statement-breakpoint
CREATE UNIQUE INDEX "telehealth_visits_tenant_identity_uq" ON "telehealth_visits" USING btree ("practice_id","id","client_id");--> statement-breakpoint
ALTER TABLE "telehealth_transcript_consents" ADD CONSTRAINT "telehealth_transcript_consents_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telehealth_transcript_consents" ADD CONSTRAINT "telehealth_transcript_consents_visit_id_telehealth_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."telehealth_visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telehealth_transcript_consents" ADD CONSTRAINT "telehealth_transcript_consents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telehealth_transcript_consents" ADD CONSTRAINT "telehealth_transcript_consents_visit_tenant_fk" FOREIGN KEY ("practice_id","visit_id","client_id") REFERENCES "public"."telehealth_visits"("practice_id","id","client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telehealth_transcript_consents_visit_idx" ON "telehealth_transcript_consents" USING btree ("practice_id","visit_id","created_at");--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD CONSTRAINT "telehealth_visits_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD CONSTRAINT "telehealth_visits_appointment_tenant_fk" FOREIGN KEY ("practice_id","appointment_id","patient_id") REFERENCES "public"."appointments"("practice_id","id","patient_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD CONSTRAINT "telehealth_visits_transcript_status_check" CHECK ("telehealth_visits"."transcript_status" in ('off', 'requested', 'declined', 'active', 'stopped', 'processing', 'ready', 'failed')
        and ("telehealth_visits"."transcript_status" <> 'ready' or "telehealth_visits"."transcript" is not null)
        and ("telehealth_visits"."transcript" is null or length("telehealth_visits"."transcript") <= 200000));--> statement-breakpoint
ALTER TABLE "telehealth_transcript_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "telehealth_transcript_consents"
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid)
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON telehealth_transcript_consents FROM openpims_app;
		GRANT SELECT, INSERT ON telehealth_transcript_consents TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON telehealth_transcript_consents FROM anon; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON telehealth_transcript_consents FROM authenticated; END IF;
END $$;
