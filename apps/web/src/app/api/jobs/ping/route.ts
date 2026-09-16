import { enqueue } from "@galm/jobs";
import { NextResponse } from "next/server";

/** Walking-skeleton scope: proves the pg-boss enqueue (web) -> process (worker) round trip
 * (backlog item 0, checklist #3). Real domain jobs (Jira sync, Spira import, PDF export)
 * are backlog items 7-8, 5. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message : "ping";
  const jobId = await enqueue("ping", { message });
  return NextResponse.json({ jobId });
}
