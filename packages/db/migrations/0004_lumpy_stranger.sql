CREATE TABLE "requirement_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Hand-edited: nullable for now (this table has existing rows with no level_id value
-- yet) - migrations-manual/004 backfills it from the old `type` column and sets NOT NULL
-- once every row has one. The snapshot drizzle-kit wrote alongside this file still
-- reflects schema.ts's NOT NULL declaration, so future `drizzle-kit generate` calls diff
-- correctly against the eventual end state, not this transient one.
ALTER TABLE "requirements" ADD COLUMN "level_id" uuid;--> statement-breakpoint
ALTER TABLE "requirement_levels" ADD CONSTRAINT "requirement_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_level_id_requirement_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."requirement_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_parent_requirement_id_requirements_id_fk" FOREIGN KEY ("parent_requirement_id") REFERENCES "public"."requirements"("id") ON DELETE set null ON UPDATE no action;