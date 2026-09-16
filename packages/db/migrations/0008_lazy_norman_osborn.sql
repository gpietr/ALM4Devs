CREATE TABLE "spira_connections" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"api_version" text DEFAULT 'v6_0' NOT NULL,
	"username" text NOT NULL,
	"api_key" text NOT NULL,
	"project_id" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spira_connections" ADD CONSTRAINT "spira_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;