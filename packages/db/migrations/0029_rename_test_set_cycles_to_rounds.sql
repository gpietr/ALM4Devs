ALTER TABLE "test_set_cycles" RENAME TO "test_set_rounds";--> statement-breakpoint
ALTER TABLE "test_executions" RENAME COLUMN "test_set_cycle_id" TO "test_set_round_id";--> statement-breakpoint
ALTER TABLE "test_set_rounds" RENAME CONSTRAINT "test_set_cycles_tenant_id_tenants_id_fk" TO "test_set_rounds_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "test_set_rounds" RENAME CONSTRAINT "test_set_cycles_test_set_id_test_sets_id_fk" TO "test_set_rounds_test_set_id_test_sets_id_fk";--> statement-breakpoint
ALTER TABLE "test_set_rounds" RENAME CONSTRAINT "test_set_cycles_started_by_user_id_fk" TO "test_set_rounds_started_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "test_executions" RENAME CONSTRAINT "test_executions_test_set_cycle_id_test_set_cycles_id_fk" TO "test_executions_test_set_round_id_test_set_rounds_id_fk";--> statement-breakpoint
ALTER INDEX "test_executions_test_set_cycle_id_idx" RENAME TO "test_executions_test_set_round_id_idx";
