CREATE TABLE "external_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "external_links_entity_unique" UNIQUE("tenant_id","entity_type","entity_id","source"),
	CONSTRAINT "external_links_source_unique" UNIQUE("tenant_id","entity_type","source","external_id")
);
--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;