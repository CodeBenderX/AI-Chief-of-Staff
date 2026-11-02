import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditSite, extractEmails, isDirectory } from "../siteAudit.js";
import { BraveSearch, SearxngSearch, TavilySearch } from "../search.js";

const servers: Server[] = [];
async function serve(handler: (req: IncomingMessage, body: string) => { status?: number; headers?: Record<string, string>; body?: string; delay?: number }) {
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      const r = handler(req, body);
      if (r.delay) await new Promise((x) => setTimeout(x, r.delay));
      res.writeHead(r.status ?? 200, { "content-type": "text/html", ...r.headers });
      res.end(r.body ?? "");
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}
afterAll(() => servers.forEach((s) => s.close()));

// Test servers run on 127.0.0.1, which the production guard (correctly) blocks.
// The tests swap https:// for http:// on the test port and skip the guard.
function localFetch(port: number, httpsAvailable: boolean): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.protocol === "https:" && !httpsAvailable) throw new Error("ECONNREFUSED");
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
}
const noGuard = async () => {};
const NOW = new Date("2026-11-01T12:00:00Z");

const OLD_SITE = `<!doctype html><html><head><title>Joe&#39;s Plumbing | Burnaby</title>
<script src="/js/jquery-1.8.2.min.js"></script></head><body>
<p>Call us!</p>${'<img src="/a.jpg">'.repeat(6)}
<a href="/services">Services</a> <a href="/old-page">Specials</a> <a href="/contact-us">Contact</a>
<footer>© 2017 Joe's Plumbing Ltd.</footer></body></html>`;

describe("site audit", () => {
  let oldPort: number;
  let goodPort: number;
  beforeAll(async () => {
    oldPort = await serve((req) => {
      if (req.url === "/") return { body: OLD_SITE };
      if (req.url === "/services") return { body: "<h1>Services</h1>" };
      if (req.url === "/contact-us") return { body: '<p>Email <a href="mailto:joe@joesplumbing.ca">joe@joesplumbing.ca</a> or info&#64;joesplumbing.ca. Built by x@sentry.io</p>' };
      return { status: 404, body: "not found" };
    });
    goodPort = await serve((req) =>
      req.url === "/"
        ? { body: `<html><head><title>Modern Dental</title><meta name="viewport" content="width=device-width"><meta name="description" content="Family dentist"></head><body><h1>Welcome</h1><a href="mailto:hello@moderndental.ca">Email</a><footer>© 2026</footer></body></html>` }
        : { status: 404 },
    );
  });

  it("reports real, fixable problems on an old site and finds its published email", async () => {
    const a = await auditSite("joesplumbing.ca", { fetch: localFetch(oldPort, false), guard: noGuard, now: NOW });
    const ids = a.findings.map((f) => f.id);
    expect(a.reachable).toBe(true);
    expect(a.https).toBe(false);
    expect(ids).toEqual(expect.arrayContaining(["no_https", "not_mobile", "outdated", "no_description", "no_h1", "img_alt", "old_jquery", "broken_links"]));
    expect(a.findings.find((f) => f.id === "outdated")!.detail).toContain("2017");
    expect(a.findings.find((f) => f.id === "broken_links")!.detail).toContain("/old-page (404)");
    expect(a.findings[0]!.severity).toBe("high"); // most serious first
    expect(a.score).toBeGreaterThanOrEqual(10);
    expect(a.title).toBe("Joe's Plumbing | Burnaby");
    expect(a.contactEmails.map((c) => c.email)).toEqual(["joe@joesplumbing.ca", "info@joesplumbing.ca"]);
    expect(a.contactEmails[0]!.sourceUrl).toContain("/contact-us");
  });

  it("finds little to fix on a modern site", async () => {
    const a = await auditSite("https://moderndental.ca", { fetch: localFetch(goodPort, true), guard: noGuard, now: NOW });
    expect(a.https).toBe(true);
    expect(a.findings).toEqual([]);
    expect(a.score).toBe(0);
    expect(a.contactEmails).toEqual([{ email: "hello@moderndental.ca", sourceUrl: "https://moderndental.ca/" }]);
  });

  it("reports a site that doesn't respond", async () => {
    const dead = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const a = await auditSite("gone.example", { fetch: dead, guard: noGuard, now: NOW });
    expect(a.reachable).toBe(false);
    expect(a.findings.map((f) => f.id)).toEqual(["unreachable"]);
  });

  it("refuses private network addresses by default", async () => {
    const a = await auditSite("http://127.0.0.1:1/", { now: NOW });
    expect(a.reachable).toBe(false);
  });

  it("filters junk emails and directory sites", () => {
    expect(extractEmails('a@example.com b@sentry.io logo@2x.png mailto:sales%40shop.ca your@email.com', "https://x.ca").map((e) => e.email)).toEqual(["sales@shop.ca"]);
    expect(isDirectory("https://www.yelp.ca/biz/joes")).toBe(true);
    expect(isDirectory("https://m.facebook.com/joes")).toBe(true);
    expect(isDirectory("https://www.google.com/maps/place/x")).toBe(true);
    expect(isDirectory("https://joesplumbing.ca")).toBe(false);
    expect(isDirectory("https://applebeesgrill.ca")).toBe(false);
  });
});

describe("search providers", () => {
  it("calls Tavily, Brave and SearXNG the way their APIs expect", async () => {
    const seen: Record<string, { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }> = {};
    const port = await serve((req, body) => {
      const key = req.url!.startsWith("/search?") ? "searxng" : req.url!.startsWith("/search") ? "tavily" : "brave";
      seen[key] = { method: req.method, url: req.url, headers: req.headers, body };
      const json = (o: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
      if (key === "tavily") return json({ results: [{ title: "Joe's", url: "https://joes.ca", content: "plumber" }] });
      if (key === "brave") return json({ web: { results: [{ title: "Joe's", url: "https://joes.ca", description: "plumber" }] } });
      return json({ results: [{ title: "Joe's", url: "https://joes.ca", content: "plumber" }, { title: "bad", url: "javascript:alert(1)", content: "" }] });
    });
    const base = `http://127.0.0.1:${port}`;
    const expected = [{ title: "Joe's", url: "https://joes.ca", snippet: "plumber" }];

    expect(await new TavilySearch("tvly-key", base).search("plumbers burnaby", { count: 5 })).toEqual(expected);
    expect(seen.tavily!.method).toBe("POST");
    expect(seen.tavily!.headers.authorization).toBe("Bearer tvly-key");
    expect(JSON.parse(seen.tavily!.body)).toMatchObject({ query: "plumbers burnaby", max_results: 5, search_depth: "basic" });

    expect(await new BraveSearch("brv-key", base).search("plumbers burnaby", { count: 5, country: "ca" })).toEqual(expected);
    expect(seen.brave!.url).toBe("/res/v1/web/search?q=plumbers+burnaby&count=5&country=CA");
    expect(seen.brave!.headers["x-subscription-token"]).toBe("brv-key");

    expect(await new SearxngSearch(`${base}/`).search("plumbers burnaby")).toEqual(expected); // unsafe URL dropped
    expect(seen.searxng!.url).toBe("/search?q=plumbers+burnaby&format=json");
  });

  it("explains auth and format errors", async () => {
    const port = await serve((req) => (req.url!.includes("format=json") ? { body: "<html>searx</html>" } : { status: 401, body: "invalid key" }));
    await expect(new TavilySearch("bad", `http://127.0.0.1:${port}`).search("x")).rejects.toThrow(/401.*check the API key/);
    await expect(new SearxngSearch(`http://127.0.0.1:${port}`).search("x")).rejects.toThrow(/enable "json"/);
  });
});
