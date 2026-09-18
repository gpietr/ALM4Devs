CREATE TABLE "nvd_connections" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"api_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vulnerability_annotations" (
	"tenant_id" uuid NOT NULL,
	"architecture_node_id" uuid NOT NULL,
	"cve_id" text NOT NULL,
	"status" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"annotated_by" text NOT NULL,
	"annotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vulnerability_annotations_architecture_node_id_cve_id_pk" PRIMARY KEY("architecture_node_id","cve_id")
);
--> statement-breakpoint
CREATE TABLE "vulnerability_findings" (
	"tenant_id" uuid NOT NULL,
	"architecture_node_id" uuid NOT NULL,
	"cve_id" text NOT NULL,
	"description" text NOT NULL,
	"cvss_score" real,
	"cvss_version" text,
	"severity" text,
	"published_at" timestamp with time zone,
	"last_modified_at" timestamp with time zone,
	"source_url" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_scan_id" uuid,
	CONSTRAINT "vulnerability_findings_architecture_node_id_cve_id_pk" PRIMARY KEY("architecture_node_id","cve_id")
);
--> statement-breakpoint
CREATE TABLE "vulnerability_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"architecture_node_id" uuid NOT NULL,
	"triggered_by" text NOT NULL,
	"query" text NOT NULL,
	"match_type" text NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "architecture_nodes" ADD COLUMN "cpe" text;--> statement-breakpoint
ALTER TABLE "nvd_connections" ADD CONSTRAINT "nvd_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_annotations" ADD CONSTRAINT "vulnerability_annotations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_annotations" ADD CONSTRAINT "vulnerability_annotations_architecture_node_id_architecture_nodes_id_fk" FOREIGN KEY ("architecture_node_id") REFERENCES "public"."architecture_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_annotations" ADD CONSTRAINT "vulnerability_annotations_annotated_by_user_id_fk" FOREIGN KEY ("annotated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_findings" ADD CONSTRAINT "vulnerability_findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_findings" ADD CONSTRAINT "vulnerability_findings_architecture_node_id_architecture_nodes_id_fk" FOREIGN KEY ("architecture_node_id") REFERENCES "public"."architecture_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_findings" ADD CONSTRAINT "vulnerability_findings_last_scan_id_vulnerability_scans_id_fk" FOREIGN KEY ("last_scan_id") REFERENCES "public"."vulnerability_scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_scans" ADD CONSTRAINT "vulnerability_scans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_scans" ADD CONSTRAINT "vulnerability_scans_architecture_node_id_architecture_nodes_id_fk" FOREIGN KEY ("architecture_node_id") REFERENCES "public"."architecture_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_scans" ADD CONSTRAINT "vulnerability_scans_triggered_by_user_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vulnerability_scans_architecture_node_id_idx" ON "vulnerability_scans" USING btree ("architecture_node_id","created_at" DESC NULLS LAST);