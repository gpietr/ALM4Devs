import type { GithubIssuesQuery } from "./issues-url";

const API_URL = "https://api.github.com";
const PAGE_SIZE = 100;

export interface GithubClientConfig {
  token?: string;
}

export class GithubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  state: "open" | "closed";
  labels: string[];
  milestone: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface GithubIssueSearchResult {
  totalCount: number;
  items: GithubIssue[];
  truncated: boolean;
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels: Array<string | { name?: string }>;
  milestone: { title: string } | null;
  created_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}
interface RawSearchResponse {
  total_count: number;
  items: RawIssue[];
}

function toIssue(raw: RawIssue): GithubIssue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    htmlUrl: raw.html_url,
    state: raw.state === "closed" ? "closed" : "open",
    labels: raw.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    milestone: raw.milestone?.title ?? null,
    createdAt: raw.created_at,
    closedAt: raw.closed_at,
  };
}

async function githubFetch<T>(config: GithubClientConfig, path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(path, API_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
    });
  } catch (err) {
    throw new GithubApiError(`could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`, 0);
  }
  if (!res.ok) {
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const when = Number.isFinite(reset) && reset > 0 ? ` after ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : " later";
      throw new GithubApiError(
        `GitHub rate limit reached - retry${when}${config.token ? "" : ", or add a token in Settings for a higher limit"}.`,
        res.status,
      );
    }
    if (res.status === 401) {
      throw new GithubApiError("GitHub rejected the saved token - check it in Settings.", res.status);
    }
    if (res.status === 422) {
      throw new GithubApiError(
        `GitHub rejected the query - check the repository exists${config.token ? " and the token can read it" : " (private repositories need a token in Settings)"} and the filter is valid.`,
        res.status,
      );
    }
    throw new GithubApiError(`GitHub API request failed: ${res.status} ${res.statusText}`, res.status);
  }
  return res.json() as Promise<T>;
}

export class GithubClient {
  constructor(private readonly config: GithubClientConfig) {}

  /** `/rate_limit` doesn't count against the limit. */
  async ping(): Promise<{ ok: true; authenticated: boolean; searchRemaining: number; searchLimit: number }> {
    const data = await githubFetch<{ resources: { search: { remaining: number; limit: number } } }>(this.config, "/rate_limit");
    return {
      ok: true,
      authenticated: !!this.config.token,
      searchRemaining: data.resources.search.remaining,
      searchLimit: data.resources.search.limit,
    };
  }

  /** Newest first, up to `limit` issues. */
  async searchIssues(query: GithubIssuesQuery, { limit = PAGE_SIZE } = {}): Promise<GithubIssueSearchResult> {
    const items: GithubIssue[] = [];
    let totalCount = 0;
    for (let page = 1; items.length < limit; page++) {
      const data = await githubFetch<RawSearchResponse>(this.config, "/search/issues", {
        q: query.query,
        sort: "created",
        order: "desc",
        per_page: PAGE_SIZE,
        page,
      });
      totalCount = data.total_count;
      items.push(...data.items.filter((i) => i.pull_request === undefined).map(toIssue));
      if (data.items.length < PAGE_SIZE) break;
    }
    const fetched = items.slice(0, limit);
    return { totalCount, items: fetched, truncated: totalCount > fetched.length };
  }
}

/** Test-only: selects the mock client when ALLOW_MOCK_GITHUB_PROVIDER=1 (see MOCK_NVD_API_KEY_SENTINEL). */
export const MOCK_GITHUB_TOKEN_SENTINEL = "mock-github-token";

class MockGithubClient extends GithubClient {
  override async ping() {
    return { ok: true as const, authenticated: true, searchRemaining: 30, searchLimit: 30 };
  }
  override async searchIssues(query: GithubIssuesQuery): Promise<GithubIssueSearchResult> {
    const base = `https://github.com/${query.owner}/${query.repo}/issues`;
    const items: GithubIssue[] = [
      {
        number: 102,
        title: "Crash when the database file is locked",
        body: "Mock issue for testing.",
        htmlUrl: `${base}/102`,
        state: "open",
        labels: ["bug"],
        milestone: null,
        createdAt: "2026-09-01T00:00:00Z",
        closedAt: null,
      },
      {
        number: 101,
        title: "Wrong result for empty input",
        body: "Mock issue for testing.",
        htmlUrl: `${base}/101`,
        state: "closed",
        labels: ["bug", "regression"],
        milestone: "2.4.1",
        createdAt: "2026-08-01T00:00:00Z",
        closedAt: "2026-08-15T00:00:00Z",
      },
    ];
    return { totalCount: items.length, items, truncated: false };
  }
}

export function createGithubClient(config: GithubClientConfig): GithubClient {
  if (process.env.ALLOW_MOCK_GITHUB_PROVIDER === "1" && config.token === MOCK_GITHUB_TOKEN_SENTINEL) {
    return new MockGithubClient(config);
  }
  return new GithubClient(config);
}
