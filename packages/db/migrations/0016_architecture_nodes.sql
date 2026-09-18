-- Hand-edited after `drizzle-kit generate`: generate also wanted to DROP
-- requirements.safety_classification and test_cases.test_type, which were already dropped
-- (after data backfill) in migrations-manual/013. Those ALTER TABLE DROP COLUMN
-- statements were removed so this migration only creates architecture_nodes.

CREATE TABLE "architecture_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"parent_id" uuid,
	"sequence_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"supplier" text,
	"version" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "architecture_nodes_product_id_level_id_sequence_number_unique" UNIQUE("product_id","level_id","sequence_number")
);
--> statement-breakpoint
ALTER TABLE "architecture_nodes" ADD CONSTRAINT "architecture_nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_nodes" ADD CONSTRAINT "architecture_nodes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_nodes" ADD CONSTRAINT "architecture_nodes_level_id_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_nodes" ADD CONSTRAINT "architecture_nodes_parent_id_architecture_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."architecture_nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_nodes" ADD CONSTRAINT "architecture_nodes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;