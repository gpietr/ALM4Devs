import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createAdminDb } from "./client";

/**
 * Manual SQL migrations (migrations-manual/*.sql) now run exactly once, ever, tracked in
 * `manual_migrations_applied` - not "every file, every time" as originally written. That
 * original design assumed every file would stay safely re-runnable forever, which broke
 * in practice: migration 004 dropped `requirements.type`, which migration 002 (already
 * applied, but still re-executed on every future migrate run) unconditionally references
 * in a CHECK constraint, so a live re-run after 004 shipped failed on "column type does
 * not exist" - a real incident, not a hypothetical. Standard run-once tracking (what every
 * other migration tool does) is what actually prevents this whole class of problem.
 */
async function main() {
  const db = createAdminDb();

  console.log("[migrate] applying drizzle-generated migrations...");
  await migrate(db, { migrationsFolder: join(import.meta.dir, "..", "migrations") });

  await db.execute(sql`
    create table if not exists manual_migrations_applied (
      filename text primary key,
      applied_at timestamp with time zone not null default now()
    )
  `);

  const manualDir = join(import.meta.dir, "..", "migrations-manual");
  const files = (await readdir(manualDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const [row] = await db.execute<{ filename: string }>(
      sql`select filename from manual_migrations_applied where filename = ${file}`,
    );
    if (row) {
      console.log(`[migrate] skipping already-applied manual migration ${file}`);
      continue;
    }

    console.log(`[migrate] applying manual migration ${file}...`);
    const sqlText = await readFile(join(manualDir, file), "utf8");
    await db.execute(sqlText);
    await db.execute(sql`insert into manual_migrations_applied (filename) values (${file})`);
  }

  console.log("[migrate] done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
