-- Hand-edited after `drizzle-kit generate`: generate wanted to also drop
-- requirement_levels/test_levels and rewire every FK/constraint that touches them in this
-- same file, but that has to run *after* migrations-manual/004 and 005 (which still
-- enable RLS, seed defaults, and add constraints against those two tables) - on a fresh
-- bootstrap, ALL drizzle-generated migrations run before ANY manual migration (see
-- packages/db/src/migrate.ts), so if the drops happened here, 004/005 would run against
-- tables that no longer exist. This file is trimmed to just the new, purely additive
-- `levels` table; migrations-manual/009_levels_merge_constraints_and_rls.sql (which runs
-- after 004/005 in filename order) does the data backfill, the old-table drops, and the
-- constraint/FK rewiring - one place, after the tables it depends on are guaranteed to
-- still exist. See that file, and packages/db/src/schema.ts's `levels` docstring.
CREATE TABLE "levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "levels_tenant_id_code_unique" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
ALTER TABLE "levels" ADD CONSTRAINT "levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
