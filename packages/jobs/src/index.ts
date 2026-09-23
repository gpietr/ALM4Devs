import PgBoss from "pg-boss";

/**
 * Thin wrapper around pg-boss (TECH_STACK.md section 3): the rest of the app only ever
 * sees `enqueue`/`registerWorker`, so swapping the underlying queue implementation later
 * (e.g. to Redis-backed BullMQ if throughput ever genuinely needs it) is additive, not a
 * rewrite. Runs in the `pgboss` schema, which app_runtime owns outright (see
 * infra/postgres/init-roles.sql) so pg-boss can self-manage its schema without app_runtime
 * needing any broader DDL rights.
 */

let bossPromise: Promise<PgBoss> | null = null;

function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    const boss = new PgBoss({ connectionString, schema: "pgboss" });
    boss.on("error", (err) => console.error("[jobs] pg-boss error:", err));
    bossPromise = boss.start().then(() => boss);
  }
  return bossPromise;
}

export async function enqueue<T extends object>(queue: string, data: T): Promise<string | null> {
  const boss = await getBoss();
  await boss.createQueue(queue).catch(() => {
    // queue already exists - pg-boss has no "createIfNotExists" flag pre-v10, ignore.
  });
  return boss.send(queue, data);
}

export async function registerWorker<T extends object>(
  queue: string,
  handler: (data: T) => Promise<void>,
): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(queue).catch(() => {});
  // batchSize/pollingIntervalSeconds default to 1 job per 2s poll (pg-boss's own
  // defaults) - fine for a single slow job, but a burst (e.g. many registrations in a
  // short window) would queue up behind that one-at-a-time rate. Fetch a real batch every
  // 500ms and run it concurrently instead - each of this app's jobs (send an email, insert
  // a row) is independent I/O with nothing to serialize on.
  await boss.work<T>(queue, { batchSize: 25, pollingIntervalSeconds: 0.5 }, async (jobs) => {
    await Promise.all(jobs.map((job) => handler(job.data)));
  });
}

export async function stopJobs(): Promise<void> {
  if (bossPromise) {
    const boss = await bossPromise;
    await boss.stop();
    bossPromise = null;
  }
}
