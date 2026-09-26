CREATE TABLE "ots_anomalies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"architecture_node_id" uuid NOT NULL,
	"external_id" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source_url" text,
	"discovery_method" text,
	"root_cause" text,
	"impact_evaluation" text,
	"outcome" text,
	"rationale" text,
	"defect_classification" text,
	"mitigation" text,
	"end_user_communication" text,
	"resolved_in_version" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ots_anomaly_requirement_links" (
	"tenant_id" uuid NOT NULL,
	"anomaly_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	CONSTRAINT "ots_anomaly_requirement_links_anomaly_id_requirement_id_pk" PRIMARY KEY("anomaly_id","requirement_id")
);
--> statement-breakpoint
CREATE TABLE "ots_anomaly_versions" (
	"tenant_id" uuid NOT NULL,
	"anomaly_id" uuid NOT NULL,
	"architecture_node_version_id" uuid NOT NULL,
	CONSTRAINT "ots_anomaly_versions_anomaly_id_architecture_node_version_id_pk" PRIMARY KEY("anomaly_id","architecture_node_version_id")
);
--> statement-breakpoint
CREATE TABLE "ots_platform_links" (
	"tenant_id" uuid NOT NULL,
	"architecture_node_id" uuid NOT NULL,
	"platform_node_id" uuid NOT NULL,
	CONSTRAINT "ots_platform_links_architecture_node_id_platform_node_id_pk" PRIMARY KEY("architecture_node_id","platform_node_id")
);
--> statement-breakpoint
CREATE TABLE "ots_profiles" (
	"architecture_node_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category" text,
	"hosting_environment" text,
	"end_user_documentation" text,
	"appropriateness_rationale" text,
	"design_limitations" text,
	"hardware_requirements" text,
	"software_requirements" text,
	"installation_configuration" text,
	"configuration_change_frequency" text,
	"user_training" text,
	"non_specified_software_prevention" text,
	"intended_function" text,
	"error_control_involvement" text,
	"external_interfaces" text,
	"anomaly_list_url" text,
	"updates_source_url" text,
	"anomalies_reviewed_at" timestamp with time zone,
	"anomalies_reviewed_by" text,
	"version_control_measures" text,
	"configuration_management" text,
	"storage_location" text,
	"installation_verification" text,
	"maintenance_plan" text,
	"risk_assessment" text,
	"development_assurance" text,
	"master_file_number" text,
	"support_mechanism" text,
	"end_of_support_date" timestamp with time zone,
	"retirement_plan" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ots_version_assessments" (
	"architecture_node_version_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"safety_impact" text,
	"design_impact" text,
	"installation_impact" text,
	"obsolescence_impact" text,
	"regression_analysis" text,
	"verification_summary" text,
	"regression_test_performed" boolean DEFAULT false NOT NULL,
	"test_set_id" uuid,
	"assessed_by" text NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "architecture_node_versions" ADD COLUMN "release_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "architecture_node_versions" ADD COLUMN "patch_level" text;--> statement-breakpoint
ALTER TABLE "architecture_node_versions" ADD COLUMN "upgrade_designation" text;--> statement-breakpoint
ALTER TABLE "architecture_node_versions" ADD COLUMN "release_notes_url" text;--> statement-breakpoint
ALTER TABLE "architecture_node_versions" ADD COLUMN "support_status" text DEFAULT 'in_use' NOT NULL;--> statement-breakpoint
ALTER TABLE "ots_anomalies" ADD CONSTRAINT "ots_anomalies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_anomalies" ADD CONSTRAINT "ots_anomalies_architecture_node_id_architecture_nodes_id_fk" FOREIGN KEY ("architecture_node_id") REFERENCES "public"."architecture_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_anomalies" ADD CONSTRAINT "ots_anomalies_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_anomalies" ADD CONSTRAINT "ots_anomalies_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_anomaly_requirement_links" ADD CONSTRAINT "ots_anomaly_requirement_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_anomaly_requirement_links" ADD CONSTRAINT "ots_anomaly_requirement_links_anomaly_id_ots_anomalies_id_fk" FOREIGN KEY ("anomaly_id") REFERENCES "public"."ots_anomalies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_anomaly_requirement_links" ADD CONSTRAINT "ots_anomaly_requirement_links_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_anomaly_versions" ADD CONSTRAINT "ots_anomaly_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_anomaly_versions" ADD CONSTRAINT "ots_anomaly_versions_anomaly_id_ots_anomalies_id_fk" FOREIGN KEY ("anomaly_id") REFERENCES "public"."ots_anomalies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_anomaly_versions" ADD CONSTRAINT "ots_anomaly_versions_architecture_node_version_id_architecture_node_versions_id_fk" FOREIGN KEY ("architecture_node_version_id") REFERENCES "public"."architecture_node_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_platform_links" ADD CONSTRAINT "ots_platform_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_platform_links" ADD CONSTRAINT "ots_platform_links_architecture_node_id_architecture_nodes_id_fk" FOREIGN KEY ("architecture_node_id") REFERENCES "public"."architecture_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_platform_links" ADD CONSTRAINT "ots_platform_links_platform_node_id_architecture_nodes_id_fk" FOREIGN KEY ("platform_node_id") REFERENCES "public"."architecture_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_profiles" ADD CONSTRAINT "ots_profiles_architecture_node_id_architecture_nodes_id_fk" FOREIGN KEY ("architecture_node_id") REFERENCES "public"."architecture_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_profiles" ADD CONSTRAINT "ots_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_profiles" ADD CONSTRAINT "ots_profiles_anomalies_reviewed_by_user_id_fk" FOREIGN KEY ("anomalies_reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_profiles" ADD CONSTRAINT "ots_profiles_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_version_assessments" ADD CONSTRAINT "ots_version_assessments_architecture_node_version_id_architecture_node_versions_id_fk" FOREIGN KEY ("architecture_node_version_id") REFERENCES "public"."architecture_node_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_version_assessments" ADD CONSTRAINT "ots_version_assessments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_version_assessments" ADD CONSTRAINT "ots_version_assessments_test_set_id_test_sets_id_fk" FOREIGN KEY ("test_set_id") REFERENCES "public"."test_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ots_version_assessments" ADD CONSTRAINT "ots_version_assessments_assessed_by_user_id_fk" FOREIGN KEY ("assessed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ots_anomalies_architecture_node_id_idx" ON "ots_anomalies" USING btree ("architecture_node_id");