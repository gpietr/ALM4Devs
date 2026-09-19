CREATE INDEX "requirements_current_version_id_idx" ON "requirements" USING btree ("current_version_id");--> statement-breakpoint
CREATE INDEX "architecture_nodes_current_version_id_idx" ON "architecture_nodes" USING btree ("current_version_id");
