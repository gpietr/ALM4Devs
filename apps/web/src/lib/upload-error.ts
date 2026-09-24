/** A user-facing reason for a failed /api/attachments/upload response: the server's own
 * message when it sent one (e.g. the 413 "file too large (limit 100 MB)"), otherwise a
 * generic fallback - a body rejected before it reaches the route (proxy limit, dropped
 * connection) has no JSON to read. */
export async function uploadErrorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (typeof body?.error === "string") return body.error;
  if (res.status === 413) return "File too large";
  return "Upload failed";
}
