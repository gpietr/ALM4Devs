CREATE TABLE "architecture_node_requirement_links" (
	"tenant_id" uuid NOT NULL,
	"architecture_node_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	CONSTRAINT "architecture_node_requirement_links_architecture_node_id_requirement_id_pk" PRIMARY KEY("architecture_node_id","requirement_id")
);
--> statement-breakpoint
CREATE TABLE "architecture_node_test_case_links" (
	"tenant_id" uuid NOT NULL,
	"architecture_node_id" uuid NOT NULL,
	"test_case_id" uuid NOT NULL,
	CONSTRAINT "architecture_node_test_case_links_architecture_node_id_test_case_id_pk" PRIMARY KEY("architecture_node_id","test_case_id")
);
--> statement-breakpoint
ALTER TABLE "architecture_node_requirement_links" ADD CONSTRAINT "architecture_node_requirement_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_node_requirement_links" ADD CONSTRAINT "architecture_node_requirement_links_architecture_node_id_architecture_nodes_id_fk" FOREIGN KEY ("architecture_node_id") REFERENCES "public"."architecture_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_node_requirement_links" ADD CONSTRAINT "architecture_node_requirement_links_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_node_test_case_links" ADD CONSTRAINT "architecture_node_test_case_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_node_test_case_links" ADD CONSTRAINT "architecture_node_test_case_links_architecture_node_id_architecture_nodes_id_fk" FOREIGN KEY ("architecture_node_id") REFERENCES "public"."architecture_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_node_test_case_links" ADD CONSTRAINT "architecture_node_test_case_links_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;