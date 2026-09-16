CREATE TABLE "level_sequence_counters" (
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "level_sequence_counters_product_id_level_id_pk" PRIMARY KEY("product_id","level_id")
);
--> statement-breakpoint
ALTER TABLE "level_sequence_counters" ADD CONSTRAINT "level_sequence_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_sequence_counters" ADD CONSTRAINT "level_sequence_counters_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;

-- Everything below hand-edited after `drizzle-kit generate` - it only knows how to add
-- NOT NULL columns with no default, which fails outright against any pre-existing rows.
-- Added nullable, backfilled, then locked down, same pattern as the requirement_levels
-- enum-to-table migration (see TECH_STACK.md).

--> statement-breakpoint
ALTER TABLE "requirement_levels" ADD COLUMN "code" text;
--> statement-breakpoint
ALTER TABLE "test_levels" ADD COLUMN "code" text;
--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "sequence_number" integer;
--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "sequence_number" integer;

-- Backfill codes for any already-existing levels. The three seeded requirement-level names
-- and the one seeded test-level name (see DEFAULT_REQUIREMENT_LEVELS/DEFAULT_TEST_LEVELS in
-- packages/core) get the friendly defaults a human would actually pick; anything else (a
-- level a tenant already renamed or created themselves before this migration existed) gets
-- a generic derived code - uppercase, alphanumeric only, first 12 characters - since there's
-- no way to guess a better one automatically. All of this is editable in Settings afterward
-- regardless.
--> statement-breakpoint
UPDATE "requirement_levels" SET "code" = CASE "name"
  WHEN 'User Need' THEN 'USERNEED'
  WHEN 'System Requirement' THEN 'SYSREQ'
  WHEN 'Software Item Spec' THEN 'SWSPEC'
  ELSE upper(left(regexp_replace("name", '[^a-zA-Z0-9]', '', 'g'), 12))
END
WHERE "code" IS NULL;
--> statement-breakpoint
UPDATE "test_levels" SET "code" = CASE "name"
  WHEN 'Default' THEN 'TC'
  ELSE upper(left(regexp_replace("name", '[^a-zA-Z0-9]', '', 'g'), 12))
END
WHERE "code" IS NULL;

-- A generic-fallback code could collide with itself across two levels that reduce to the
-- same alphanumeric string (e.g. two custom levels named "V1" and "v1"), or with a
-- since-deleted level's leftover... not actually possible (levels aren't soft-deleted),
-- but two live levels could still collide - de-duplicate by appending each row's own
-- short id suffix to every code past the first per tenant, so the later unique constraint
-- can never fail on backfilled data.
--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY tenant_id, code ORDER BY sort_order, created_at) AS rn
  FROM "requirement_levels"
)
UPDATE "requirement_levels" rl SET "code" = rl."code" || '_' || left(rl.id::text, 4)
FROM ranked WHERE ranked.id = rl.id AND ranked.rn > 1;
--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY tenant_id, code ORDER BY sort_order, created_at) AS rn
  FROM "test_levels"
)
UPDATE "test_levels" tl SET "code" = tl."code" || '_' || left(tl.id::text, 4)
FROM ranked WHERE ranked.id = tl.id AND ranked.rn > 1;

-- Backfill sequence numbers for any already-existing requirements/test cases, numbered
-- per (product, level) in creation order - the same order they'd have been assigned in if
-- this feature had existed from the start.
--> statement-breakpoint
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY product_id, level_id ORDER BY created_at) AS rn
  FROM "requirements"
)
UPDATE "requirements" r SET "sequence_number" = numbered.rn
FROM numbered WHERE numbered.id = r.id AND r."sequence_number" IS NULL;
--> statement-breakpoint
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY product_id, level_id ORDER BY created_at) AS rn
  FROM "test_cases"
)
UPDATE "test_cases" tc SET "sequence_number" = numbered.rn
FROM numbered WHERE numbered.id = tc.id AND tc."sequence_number" IS NULL;

-- Seed the counters so the next real insert continues from the backfilled high-water mark
-- instead of restarting at 1 and colliding with an id that's already displayed somewhere.
--> statement-breakpoint
INSERT INTO "level_sequence_counters" (tenant_id, product_id, level_id, last_number)
SELECT tenant_id, product_id, level_id, max(sequence_number)
FROM "requirements"
GROUP BY tenant_id, product_id, level_id
ON CONFLICT (product_id, level_id) DO UPDATE SET last_number = GREATEST(level_sequence_counters.last_number, excluded.last_number);
--> statement-breakpoint
INSERT INTO "level_sequence_counters" (tenant_id, product_id, level_id, last_number)
SELECT tenant_id, product_id, level_id, max(sequence_number)
FROM "test_cases"
GROUP BY tenant_id, product_id, level_id
ON CONFLICT (product_id, level_id) DO UPDATE SET last_number = GREATEST(level_sequence_counters.last_number, excluded.last_number);

-- Now that every row has a value, lock both columns down for real.
--> statement-breakpoint
ALTER TABLE "requirement_levels" ALTER COLUMN "code" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "test_levels" ALTER COLUMN "code" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "requirements" ALTER COLUMN "sequence_number" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "test_cases" ALTER COLUMN "sequence_number" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "requirement_levels" ADD CONSTRAINT "requirement_levels_tenant_id_code_unique" UNIQUE("tenant_id","code");
--> statement-breakpoint
ALTER TABLE "test_levels" ADD CONSTRAINT "test_levels_tenant_id_code_unique" UNIQUE("tenant_id","code");
