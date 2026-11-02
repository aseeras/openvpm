CREATE TABLE "appointment_check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_via" varchar(16) NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid
);
--> statement-breakpoint
ALTER TABLE "appointment_check_ins" ADD CONSTRAINT "appointment_check_ins_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_check_ins" ADD CONSTRAINT "appointment_check_ins_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_check_ins" ADD CONSTRAINT "appointment_check_ins_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_check_ins" ADD CONSTRAINT "appointment_check_ins_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_check_ins" ADD CONSTRAINT "appointment_check_ins_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_check_ins" ADD CONSTRAINT "appointment_check_ins_appointment_tenant_fk" FOREIGN KEY ("practice_id","appointment_id") REFERENCES "public"."appointments"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_check_ins" ADD CONSTRAINT "appointment_check_ins_patient_tenant_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_check_ins" ADD CONSTRAINT "appointment_check_ins_client_tenant_fk" FOREIGN KEY ("practice_id","client_id") REFERENCES "public"."clients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_check_ins_appointment_uq" ON "appointment_check_ins" USING btree ("practice_id","appointment_id") WHERE "appointment_check_ins"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "appointment_check_ins_patient_idx" ON "appointment_check_ins" USING btree ("practice_id","patient_id","submitted_at");--> statement-breakpoint
ALTER TABLE "appointment_check_ins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "appointment_check_ins"
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid)
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON appointment_check_ins FROM openpims_app;
		GRANT SELECT, INSERT, UPDATE ON appointment_check_ins TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON appointment_check_ins FROM anon; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON appointment_check_ins FROM authenticated; END IF;
END $$;
