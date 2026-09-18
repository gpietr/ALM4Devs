CREATE TABLE "architecture_node_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"architecture_node_id" uuid NOT NULL,
	"version" text NOT NULL,
	"cpe" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "architecture_nodes" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "vulnerability_scans" ADD COLUMN "architecture_node_version_id" uuid;--> statement-breakpoint
ALTER TABLE "architecture_node_versions" ADD CONSTRAINT "architecture_node_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_node_versions" ADD CONSTRAINT "architecture_node_versions_architecture_node_id_architecture_nodes_id_fk" FOREIGN KEY ("architecture_node_id") REFERENCES "public"."architecture_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_node_versions" ADD CONSTRAINT "architecture_node_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_scans" ADD CONSTRAINT "vulnerability_scans_architecture_node_version_id_architecture_node_versions_id_fk" FOREIGN KEY ("architecture_node_version_id") REFERENCES "public"."architecture_node_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_nodes" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "architecture_nodes" DROP COLUMN "cpe";
