/**
 * Pluggable web search. The CEO picks a service in Settings; keys come from the
 * encrypted secret store and never reach agents.
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly id: string;
  search(query: string, opts?: { count?: number; country?: string; signal?: AbortSignal }): Promise<SearchResult[]>;
}

export class SearchError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "SearchError";
  }
}

type Fetch = typeof fetch;

async function readJson(res: Response, service: string): Promise<any> {
  const text = await res.text();
  if (!res.ok) {
    const hint =
      service === "SearXNG" && res.status === 403
        ? ' (JSON output is turned off: add "json" under search → formats in SearXNG\'s settings.yml, then restart SearXNG)'
        : res.status === 401 || res.status === 403
        ? " (check the API key in Settings)"
        : res.status === 429
          ? " (rate limit or monthly allowance reached)"
          : "";
    throw new SearchError(`${service} returned ${res.status}${hint}: ${text.slice(0, 200)}`, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SearchError(`${service} did not return JSON${service === "SearXNG" ? ' (enable "json" under search.formats in settings.yml)' : ""}`);
  }
}

const clean = (r: SearchResult[], n: number) =>
  r.filter((x) => /^https?:\/\//.test(x.url)).slice(0, n).map((x) => ({ title: (x.title ?? "").slice(0, 300), url: x.url, snippet: (x.snippet ?? "").slice(0, 600) }));

/** Tavily: POST /search, Bearer key. Free tier: 1,000 credits/month (1 per basic search). */
export class TavilySearch implements SearchProvider {
  readonly id = "tavily";
  constructor(private apiKey: string, private baseUrl = "https://api.tavily.com", private f: Fetch = fetch) {}
  async search(query: string, opts: { count?: number; country?: string; signal?: AbortSignal } = {}) {
    const n = Math.min(opts.count ?? 10, 20);
    const res = await this.f(`${this.baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query, max_results: n, search_depth: "basic", include_answer: false }),
      signal: opts.signal,
    });
    const data = await readJson(res, "Tavily");
    return clean((data.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content })), n);
  }
}

/** Brave: GET /res/v1/web/search, X-Subscription-Token. */
export class BraveSearch implements SearchProvider {
  readonly id = "brave";
  constructor(private apiKey: string, private baseUrl = "https://api.search.brave.com", private f: Fetch = fetch) {}
  async search(query: string, opts: { count?: number; country?: string; signal?: AbortSignal } = {}) {
    const n = Math.min(opts.count ?? 10, 20);
    const params = new URLSearchParams({ q: query, count: String(n) });
    if (opts.country) params.set("country", opts.country.toUpperCase());
    const res = await this.f(`${this.baseUrl}/res/v1/web/search?${params}`, {
      headers: { accept: "application/json", "x-subscription-token": this.apiKey },
      signal: opts.signal,
    });
    const data = await readJson(res, "Brave Search");
    return clean((data.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description })), n);
  }
}

/** SearXNG (self-hosted): GET /search?format=json. JSON output must be enabled in settings.yml. */
export class SearxngSearch implements SearchProvider {
  readonly id = "searxng";
  constructor(private baseUrl: string, private f: Fetch = fetch) {}
  async search(query: string, opts: { count?: number; country?: string; signal?: AbortSignal } = {}) {
    const n = Math.min(opts.count ?? 10, 30);
    const params = new URLSearchParams({ q: query, format: "json" });
    const res = await this.f(`${this.baseUrl.replace(/\/$/, "")}/search?${params}`, { headers: { accept: "application/json" }, signal: opts.signal });
    const data = await readJson(res, "SearXNG");
    return clean((data.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content })), n);
  }
}
