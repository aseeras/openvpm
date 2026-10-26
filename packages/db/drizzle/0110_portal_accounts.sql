CREATE TABLE "portal_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"username" varchar(32) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_sign_in_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "portal_email_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"purpose" varchar(16) NOT NULL,
	"email" varchar(255) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_accounts" ADD CONSTRAINT "portal_accounts_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_accounts" ADD CONSTRAINT "portal_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_accounts" ADD CONSTRAINT "portal_accounts_client_tenant_fk" FOREIGN KEY ("practice_id","client_id") REFERENCES "public"."clients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_email_codes" ADD CONSTRAINT "portal_email_codes_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_accounts_username_uq" ON "portal_accounts" USING btree ("username") WHERE "portal_accounts"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_accounts_client_uq" ON "portal_accounts" USING btree ("practice_id","client_id") WHERE "portal_accounts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "portal_email_codes_email_idx" ON "portal_email_codes" USING btree ("practice_id","email","created_at");--> statement-breakpoint
ALTER TABLE "portal_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "portal_accounts"
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid)
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON portal_accounts FROM openpims_app;
		GRANT SELECT, INSERT, UPDATE ON portal_accounts TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON portal_accounts FROM anon; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON portal_accounts FROM authenticated; END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "portal_email_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "portal_email_codes"
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid)
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON portal_email_codes FROM openpims_app;
		GRANT SELECT, INSERT, UPDATE ON portal_email_codes TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON portal_email_codes FROM anon; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON portal_email_codes FROM authenticated; END IF;
END $$;
