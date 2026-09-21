ALTER TABLE "test_executions" ADD COLUMN "test_set_item_id" uuid;--> statement-breakpoint
ALTER TABLE "test_executions" ADD CONSTRAINT "test_executions_test_set_item_id_test_set_items_id_fk" FOREIGN KEY ("test_set_item_id") REFERENCES "public"."test_set_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_executions_test_set_item_id_idx" ON "test_executions" USING btree ("test_set_item_id");
