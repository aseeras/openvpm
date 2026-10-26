CREATE TABLE "portal_sign_in_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"provider" varchar(16) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"email" varchar(320),
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "portal_sign_in_identities" ADD CONSTRAINT "portal_sign_in_identities_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_sign_in_identities" ADD CONSTRAINT "portal_sign_in_identities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_sign_in_identities" ADD CONSTRAINT "portal_sign_in_identities_client_tenant_fk" FOREIGN KEY ("practice_id","client_id") REFERENCES "public"."clients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_sign_in_identities_subject_uq" ON "portal_sign_in_identities" USING btree ("practice_id","provider","subject") WHERE "portal_sign_in_identities"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "portal_sign_in_identities_lookup_idx" ON "portal_sign_in_identities" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX "portal_sign_in_identities_client_idx" ON "portal_sign_in_identities" USING btree ("practice_id","client_id");--> statement-breakpoint
ALTER TABLE "portal_sign_in_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "portal_sign_in_identities"
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid)
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON portal_sign_in_identities FROM openpims_app;
		GRANT SELECT, INSERT, UPDATE ON portal_sign_in_identities TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON portal_sign_in_identities FROM anon; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON portal_sign_in_identities FROM authenticated; END IF;
END $$;
