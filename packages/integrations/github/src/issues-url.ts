export interface GithubIssuesQuery {
  owner: string;
  repo: string;
  query: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

// Replaced by the pinned `repo:owner/name is:issue` scope.
const SCOPE_TOKEN = /^-?(repo|org|user|owner|type):/i;
const KIND_TOKEN = /^-?is:(issue|pr|pull-request)$/i;

/** Splits a query on whitespace, keeping `label:"good first issue"` in one piece. */
export function tokenizeGithubQuery(q: string): string[] {
  return q.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

export function githubIssueExternalId(query: GithubIssuesQuery, issueNumber: number): string {
  return `${query.owner}/${query.repo}#${issueNumber}`;
}

/** Converts a GitHub issues page URL, filters included, into an issue search query. */
export function parseGithubIssuesUrl(input: string): GithubIssuesQuery | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;

  const [owner, rawRepo, section, ...rest] = url.pathname.split("/").filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/i, "");
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return null;
  if (section !== undefined && section !== "issues") return null;
  if (rest.length > 0) return null;

  const filters: string[] = [];
  const q = url.searchParams.get("q");
  if (q !== null) {
    filters.push(...tokenizeGithubQuery(q).filter((t) => !SCOPE_TOKEN.test(t) && !KIND_TOKEN.test(t)));
  } else {
    // Legacy ?labels=a,b&state=closed links; GitHub defaults to open issues.
    const state = url.searchParams.get("state");
    filters.push(state === "closed" ? "is:closed" : state === "all" ? "" : "is:open");
    for (const label of (url.searchParams.get("labels") ?? "").split(",")) {
      const l = label.trim();
      if (l) filters.push(/\s/.test(l) ? `label:"${l}"` : `label:${l}`);
    }
  }

  const query = [`repo:${owner}/${repo}`, "is:issue", ...filters.filter(Boolean)].join(" ");
  return { owner, repo, query };
}
