CREATE TABLE "software_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"version_number" text NOT NULL,
	"description" text,
	"release_date" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "software_versions_product_id_version_number_unique" UNIQUE("product_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "software_version_links" (
	"tenant_id" uuid NOT NULL,
	"software_version_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	CONSTRAINT "software_version_links_software_version_id_entity_type_entity_id_pk" PRIMARY KEY("software_version_id","entity_type","entity_id")
);
--> statement-breakpoint
ALTER TABLE "software_versions" ADD CONSTRAINT "software_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_versions" ADD CONSTRAINT "software_versions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_versions" ADD CONSTRAINT "software_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_version_links" ADD CONSTRAINT "software_version_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_version_links" ADD CONSTRAINT "software_version_links_software_version_id_software_versions_id_fk" FOREIGN KEY ("software_version_id") REFERENCES "public"."software_versions"("id") ON DELETE cascade ON UPDATE no action;
