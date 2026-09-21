CREATE TABLE "test_set_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"test_set_id" uuid NOT NULL,
	"label" text,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_executions" ADD COLUMN "test_set_cycle_id" uuid;--> statement-breakpoint
ALTER TABLE "test_set_cycles" ADD CONSTRAINT "test_set_cycles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_set_cycles" ADD CONSTRAINT "test_set_cycles_test_set_id_test_sets_id_fk" FOREIGN KEY ("test_set_id") REFERENCES "public"."test_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_set_cycles" ADD CONSTRAINT "test_set_cycles_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_executions" ADD CONSTRAINT "test_executions_test_set_cycle_id_test_set_cycles_id_fk" FOREIGN KEY ("test_set_cycle_id") REFERENCES "public"."test_set_cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_executions_test_set_cycle_id_idx" ON "test_executions" USING btree ("test_set_cycle_id");
