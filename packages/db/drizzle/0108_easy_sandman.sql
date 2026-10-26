SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
CREATE TYPE "public"."telehealth_visit_status" AS ENUM('waiting', 'in_call', 'completed', 'cancelled', 'declined');--> statement-breakpoint
CREATE TABLE "telehealth_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"status" "telehealth_visit_status" DEFAULT 'waiting' NOT NULL,
	"reason" varchar(200) NOT NULL,
	"notes" text,
	"clinician_id" uuid,
	"video_room_name" varchar(128),
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"decline_reason" varchar(300),
	CONSTRAINT "telehealth_visits_reason_check" CHECK (length(btrim("telehealth_visits"."reason")) between 1 and 200),
	CONSTRAINT "telehealth_visits_notes_check" CHECK ("telehealth_visits"."notes" is null or length("telehealth_visits"."notes") <= 2000),
	CONSTRAINT "telehealth_visits_call_shape_check" CHECK ("telehealth_visits"."status" <> 'in_call' or (
        "telehealth_visits"."clinician_id" is not null
        and "telehealth_visits"."video_room_name" is not null
        and "telehealth_visits"."started_at" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD CONSTRAINT "telehealth_visits_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD CONSTRAINT "telehealth_visits_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD CONSTRAINT "telehealth_visits_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD CONSTRAINT "telehealth_visits_clinician_id_users_id_fk" FOREIGN KEY ("clinician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD CONSTRAINT "telehealth_visits_patient_client_tenant_fk" FOREIGN KEY ("practice_id","patient_id","client_id") REFERENCES "public"."patients"("practice_id","id","client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telehealth_visits" ADD CONSTRAINT "telehealth_visits_clinician_tenant_fk" FOREIGN KEY ("practice_id","clinician_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telehealth_visits_queue_idx" ON "telehealth_visits" USING btree ("practice_id","status","created_at");--> statement-breakpoint
CREATE INDEX "telehealth_visits_client_idx" ON "telehealth_visits" USING btree ("practice_id","client_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "telehealth_visits_one_open_per_patient_uq" ON "telehealth_visits" USING btree ("practice_id","patient_id") WHERE "telehealth_visits"."status" in ('waiting', 'in_call');--> statement-breakpoint
ALTER TABLE "telehealth_visits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "telehealth_visits"
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid)
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON telehealth_visits FROM openpims_app;
		GRANT SELECT, INSERT, UPDATE ON telehealth_visits TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON telehealth_visits FROM anon; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON telehealth_visits FROM authenticated; END IF;
END $$;
