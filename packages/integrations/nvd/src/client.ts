/**
 * NVD (National Vulnerability Database) REST API client. Public, unauthenticated
 * requests are rate-limited to 5 per rolling 30s window; an API key (free, self-service
 * at nvd.nist.gov) raises that to 50 per 30s - see NvdClientConfig.apiKey, sent as the
 * `apiKey` HTTP header (not a query param, per NVD's own documentation).
 *
 * Two endpoints are used: the CVE API (search vulnerabilities by an exact CPE string or
 * a free-text keyword) and the separate CPE API (search for candidate CPE strings by
 * keyword, so a user can find the exact identifier for an OTS component without knowing
 * CPE syntax up front).
 */

const CVE_API_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const CPE_API_URL = "https://services.nvd.nist.gov/rest/json/cpes/2.0";

export interface NvdClientConfig {
  apiKey?: string;
}

export class NvdApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
  }
}

export interface NvdFinding {
  cveId: string;
  description: string;
  cvssScore: number | null;
  cvssVersion: string | null;
  severity: string | null;
  publishedAt: Date;
  lastModifiedAt: Date;
  sourceUrl: string;
}

export interface NvdCpeCandidate {
  cpeName: string;
  title: string;
  deprecated: boolean;
}

/** Raw shapes read off NVD's CVE API 2.0 response - only the fields this client uses. */
interface RawCvssMetric {
  type?: string;
  cvssData: { version: string; baseScore: number; baseSeverity?: string };
  baseSeverity?: string;
}
interface RawCve {
  id: string;
  published: string;
  lastModified: string;
  descriptions: Array<{ lang: string; value: string }>;
  metrics?: {
    cvssMetricV31?: RawCvssMetric[];
    cvssMetricV30?: RawCvssMetric[];
    cvssMetricV2?: RawCvssMetric[];
  };
}
interface RawCveApiResponse {
  totalResults: number;
  vulnerabilities: Array<{ cve: RawCve }>;
}
interface RawCpeApiResponse {
  totalResults: number;
  products: Array<{
    cpe: { cpeName: string; deprecated: boolean; titles?: Array<{ title: string; lang: string }> };
  }>;
}

/** Picks the highest-available CVSS version's metric entry, preferring one explicitly
 * marked `type: "Primary"` when a version has more than one (NVD can carry both a
 * "Primary" NVD-authored score and a "Secondary" CNA-authored one for the same CVE).
 * Severity is read off whichever entry is chosen - present on `cvssData` for v3.x, and
 * as a sibling of `cvssData` for v2 (CVSS v2 has no severity field in the vector itself,
 * so NVD's schema places it outside cvssData for that version only). */
export function pickPrimaryMetric(
  metrics: RawCve["metrics"],
): { score: number; version: string; severity: string | null } | null {
  const byVersion = [metrics?.cvssMetricV31, metrics?.cvssMetricV30, metrics?.cvssMetricV2].find(
    (arr) => arr && arr.length > 0,
  );
  if (!byVersion) return null;
  const entry = byVersion.find((m) => m.type === "Primary") ?? byVersion[0];
  if (!entry) return null;
  return {
    score: entry.cvssData.baseScore,
    version: entry.cvssData.version,
    severity: entry.cvssData.baseSeverity ?? entry.baseSeverity ?? null,
  };
}

function mapCve(raw: RawCve): NvdFinding {
  const description = raw.descriptions.find((d) => d.lang === "en")?.value ?? raw.descriptions[0]?.value ?? "";
  const metric = pickPrimaryMetric(raw.metrics);
  return {
    cveId: raw.id,
    description,
    cvssScore: metric?.score ?? null,
    cvssVersion: metric?.version ?? null,
    severity: metric?.severity ?? null,
    publishedAt: new Date(raw.published),
    lastModifiedAt: new Date(raw.lastModified),
    // Deliberately not references[0].url - NVD reference links are frequently dead or
    // tagged "Broken Link" in real data. The NVD detail page is always valid and stable.
    sourceUrl: `https://nvd.nist.gov/vuln/detail/${raw.id}`,
  };
}

function mapCpeCandidate(raw: RawCpeApiResponse["products"][number]): NvdCpeCandidate {
  const title = raw.cpe.titles?.find((t) => t.lang === "en")?.title ?? raw.cpe.titles?.[0]?.title ?? raw.cpe.cpeName;
  return { cpeName: raw.cpe.cpeName, title, deprecated: raw.cpe.deprecated };
}

async function nvdFetch<T>(config: NvdClientConfig, baseUrl: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", ...(config.apiKey ? { apiKey: config.apiKey } : {}) },
    });
  } catch (err) {
    throw new NvdApiError(`could not reach NVD: ${err instanceof Error ? err.message : String(err)}`, 0);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => undefined);
    if (res.status === 403) {
      throw new NvdApiError(
        "NVD rate-limited this request - wait about 30 seconds and retry, or add an API key in Settings for a higher limit.",
        res.status,
        body,
      );
    }
    throw new NvdApiError(`NVD API request failed: ${res.status} ${res.statusText}`, res.status, body);
  }
  return res.json() as Promise<T>;
}

export class NvdClient {
  constructor(private readonly config: NvdClientConfig) {}

  /** Cheapest possible real request against NVD - looks up one well-known, permanently
   * archived CVE by id (resultsPerPage=1) rather than running a keyword search, so
   * "Test connection" verifies the key/network path without depending on any dataset
   * assumptions or costing a meaningful share of the rate limit. */
  async ping(): Promise<{ ok: true }> {
    await nvdFetch<RawCveApiResponse>(this.config, CVE_API_URL, { cveId: "CVE-1999-0001", resultsPerPage: 1 });
    return { ok: true };
  }

  async searchByCpe(cpeName: string): Promise<NvdFinding[]> {
    const data = await nvdFetch<RawCveApiResponse>(this.config, CVE_API_URL, {
      cpeName,
      resultsPerPage: 2000,
    });
    return data.vulnerabilities.map((v) => mapCve(v.cve));
  }

  async searchByKeyword(keyword: string): Promise<NvdFinding[]> {
    const data = await nvdFetch<RawCveApiResponse>(this.config, CVE_API_URL, {
      keywordSearch: keyword,
      resultsPerPage: 2000,
    });
    return data.vulnerabilities.map((v) => mapCve(v.cve));
  }

  /** Candidate CPE strings for a free-text query - "make it easy to find" the exact CPE
   * for an OTS component, without the user needing to know CPE syntax. Deprecated
   * entries are surfaced (via `deprecated`), not filtered out: an EOL/older version's
   * correct CPE is very often exactly the deprecated one. */
  async searchCpeCandidates(keyword: string): Promise<NvdCpeCandidate[]> {
    const data = await nvdFetch<RawCpeApiResponse>(this.config, CPE_API_URL, {
      keywordSearch: keyword,
      resultsPerPage: 50,
    });
    return data.products.map(mapCpeCandidate);
  }
}

/**
 * A real NVD API key can never legitimately equal this sentinel - it's the one and only
 * trigger for the test-only mock branch below, and only fires when BOTH this sentinel
 * matches AND ALLOW_MOCK_NVD_PROVIDER=1 is set in the environment (see .env.example -
 * dev/CI only, never set in a real deployment). Mirrors resolveModel's
 * MOCK_BASE_URL_SENTINEL pattern (packages/integrations/llm/src/resolve-model.ts).
 */
export const MOCK_NVD_API_KEY_SENTINEL = "mock-nvd-key";

const MOCK_FINDING: NvdFinding = {
  cveId: "CVE-2021-44228",
  description: "Mock finding for testing: Apache Log4j2 JNDI features (Log4Shell).",
  cvssScore: 10.0,
  cvssVersion: "3.1",
  severity: "CRITICAL",
  publishedAt: new Date("2021-12-10T10:15:00.000Z"),
  lastModifiedAt: new Date("2021-12-14T00:00:00.000Z"),
  sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2021-44228",
};

class MockNvdClient extends NvdClient {
  override async ping(): Promise<{ ok: true }> {
    return { ok: true };
  }
  override async searchByCpe(): Promise<NvdFinding[]> {
    return [MOCK_FINDING];
  }
  override async searchByKeyword(): Promise<NvdFinding[]> {
    return [MOCK_FINDING];
  }
  override async searchCpeCandidates(): Promise<NvdCpeCandidate[]> {
    return [{ cpeName: "cpe:2.3:a:apache:log4j:2.14.1:*:*:*:*:*:*:*", title: "Apache Log4j 2.14.1", deprecated: false }];
  }
}

export function createNvdClient(config: NvdClientConfig): NvdClient {
  if (process.env.ALLOW_MOCK_NVD_PROVIDER === "1" && config.apiKey === MOCK_NVD_API_KEY_SENTINEL) {
    return new MockNvdClient(config);
  }
  return new NvdClient(config);
}
