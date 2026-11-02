import { assertPublicUrl } from "./net.js";

/**
 * Website audit for prospecting. Plain code, not a model: every finding is
 * something that was actually observed, so an outreach email never cites a
 * problem that isn't there.
 */
export type Severity = "high" | "medium" | "low";

export interface AuditFinding {
  id: string;
  severity: Severity;
  /** Short, client-friendly description ("Site isn't mobile-friendly"). */
  title: string;
  /** Evidence ("no viewport meta tag on the home page"). */
  detail: string;
}

export interface ContactEmail {
  email: string;
  /** Page where the address was published (needed to show consent basis for outreach). */
  sourceUrl: string;
}

export interface SiteAudit {
  inputUrl: string;
  finalUrl: string | null;
  reachable: boolean;
  status: number | null;
  https: boolean;
  responseMs: number | null;
  htmlBytes: number;
  title: string | null;
  description: string | null;
  platform: string | null;
  findings: AuditFinding[];
  /** Sum of severities (high 3, medium 2, low 1). Higher = more for a web developer to fix. */
  score: number;
  contactEmails: ContactEmail[];
  contactPageUrl: string | null;
  checkedAt: string;
}

export interface AuditOptions {
  fetch?: typeof fetch;
  /** URL safety check before every request (default: block private networks). */
  guard?: (url: string) => Promise<unknown>;
  timeoutMs?: number;
  maxLinkChecks?: number;
  now?: Date;
}

interface Page {
  status: number;
  url: string;
  html: string;
  ms: number;
}

const UA = "Mozilla/5.0 (compatible; WebsiteCheck/1.0; one-time review)";
const MAX_HTML = 3_000_000;
const WEIGHT: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

async function getPage(url: string, o: Required<Pick<AuditOptions, "fetch" | "guard" | "timeoutMs">>, readBody = true): Promise<Page> {
  let current = url;
  const started = Date.now();
  for (let hop = 0; hop < 5; hop++) {
    await o.guard(current);
    const res = await o.fetch(current, { redirect: "manual", headers: { "user-agent": UA, accept: "text/html,*/*" }, signal: AbortSignal.timeout(o.timeoutMs) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      await res.body?.cancel().catch(() => {});
      continue;
    }
    let html = "";
    if (readBody) {
      const buf = Buffer.from(await res.arrayBuffer());
      html = buf.subarray(0, MAX_HTML).toString("utf8");
    } else {
      await res.body?.cancel().catch(() => {});
    }
    return { status: res.status, url: current, html, ms: Date.now() - started };
  }
  throw new Error("too many redirects");
}

const attr = (tag: string, name: string) => new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? null;
const metaContent = (html: string, name: string) => {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if ((attr(tag, "name") ?? attr(tag, "property") ?? "").toLowerCase() === name) return attr(tag, "content");
  }
  return null;
};
const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;
const JUNK_EMAIL_DOMAINS = /(^|\.)(example\.(com|org)|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|domain\.com|email\.com|yourdomain\.com|test\.com|godaddy\.com|squarespace\.com)$/i;

export function extractEmails(html: string, pageUrl: string): ContactEmail[] {
  const found = new Map<string, ContactEmail>();
  const text = html.replace(/&#64;|&#x40;/gi, "@");
  const candidates = [
    ...[...text.matchAll(/mailto:([^"'?>\s]+)/gi)].map((m) => decodeURIComponent(m[1]!)),
    ...(text.replace(/<script[\s\S]*?<\/script>/gi, " ").match(EMAIL_RE) ?? []),
  ];
  for (const raw of candidates) {
    const email = raw.trim().toLowerCase().replace(/[.,;:]+$/, "");
    const [local, domain] = email.split("@");
    if (!local || !domain || !EMAIL_RE.test(email)) continue;
    EMAIL_RE.lastIndex = 0;
    if (JUNK_EMAIL_DOMAINS.test(domain) || /\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(domain) || /^(your|name|email|user|someone)$/.test(local)) continue;
    if (!found.has(email)) found.set(email, { email, sourceUrl: pageUrl });
  }
  return [...found.values()];
}

function detectPlatform(html: string): string | null {
  const gen = metaContent(html, "generator");
  if (gen) return decode(gen).slice(0, 80);
  if (/wp-content\//i.test(html)) return "WordPress";
  if (/static\.wixstatic\.com|wix\.com/i.test(html)) return "Wix";
  if (/squarespace/i.test(html)) return "Squarespace";
  if (/cdn\.shopify\.com/i.test(html)) return "Shopify";
  if (/webflow/i.test(html)) return "Webflow";
  return null;
}

export async function auditSite(input: string, opts: AuditOptions = {}): Promise<SiteAudit> {
  const o = { fetch: opts.fetch ?? fetch, guard: opts.guard ?? assertPublicUrl, timeoutMs: opts.timeoutMs ?? 15_000 };
  const now = opts.now ?? new Date();
  const findings: AuditFinding[] = [];
  const add = (id: string, severity: Severity, title: string, detail: string) => findings.push({ id, severity, title, detail });
  const raw = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const host = new URL(raw).host;

  // 1. Reach the site, preferring HTTPS.
  let page: Page | null = null;
  let httpsWorks = false;
  try {
    page = await getPage(`https://${host}/`, o);
    httpsWorks = page.url.startsWith("https://");
  } catch {
    /* fall through to http */
  }
  if (!page) {
    try {
      page = await getPage(`http://${host}/`, o);
    } catch (e) {
      add("unreachable", "high", "Website doesn't load", `could not connect: ${(e as Error).message.slice(0, 120)}`);
    }
  } else if (!httpsWorks) {
    // https redirected down to http
  }
  const base: SiteAudit = {
    inputUrl: input, finalUrl: page?.url ?? null, reachable: !!page && page.status < 500, status: page?.status ?? null,
    https: !!page && page.url.startsWith("https://"), responseMs: page?.ms ?? null, htmlBytes: page ? Buffer.byteLength(page.html) : 0,
    title: null, description: null, platform: null, findings, score: 0, contactEmails: [], contactPageUrl: null, checkedAt: now.toISOString(),
  };
  if (!page) return finish(base);

  if (page.status >= 500) add("server_error", "high", "Website shows a server error", `home page returned HTTP ${page.status}`);
  else if (page.status >= 400) add("http_error", "high", "Home page returns an error", `home page returned HTTP ${page.status}`);
  if (!base.https) add("no_https", "high", "No secure connection (HTTPS)", "the site is served over plain http, so browsers mark it \"Not secure\"");

  const html = page.html;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  base.title = title ? decode(title).slice(0, 200) : null;
  base.description = metaContent(html, "description") ? decode(metaContent(html, "description")!).slice(0, 300) : null;
  base.platform = detectPlatform(html);

  // 2. Mobile, speed, search basics.
  if (page.status < 400) {
    if (!metaContent(html, "viewport")) add("not_mobile", "high", "Not mobile-friendly", "no viewport meta tag, so phones show a shrunken desktop page");
    if (page.ms > 3000) add("slow", "medium", "Slow to load", `home page took ${(page.ms / 1000).toFixed(1)}s to download (one measurement)`);
    if (base.htmlBytes > 1_500_000) add("heavy", "low", "Very large home page", `${Math.round(base.htmlBytes / 1024)} KB of HTML`);
    if (!base.title) add("no_title", "medium", "Missing page title", "no <title>, which hurts search results");
    if (!base.description) add("no_description", "low", "No search description", "no meta description for search results");
    if (!/<h1[\s>]/i.test(html)) add("no_h1", "low", "No main heading", "no <h1> on the home page");
    const years = [...html.matchAll(/(?:©|&copy;|copyright)[^<]{0,40}?((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi)].map((m) => Number(m[2] ?? m[1]));
    if (years.length) {
      const latest = Math.max(...years);
      if (latest <= now.getFullYear() - 3) add("outdated", "medium", "Looks out of date", `copyright notice says ${latest}`);
    }
    if (base.https && /\b(?:src|href)\s*=\s*["']http:\/\/(?!localhost)[^"']+\.(?:js|css|png|jpe?g|gif|webp|svg)/i.test(html)) {
      add("mixed_content", "medium", "Insecure files on a secure page", "images or scripts load over http on an https page");
    }
    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    const noAlt = imgs.filter((t) => !/\balt\s*=/i.test(t)).length;
    if (noAlt >= 5) add("img_alt", "low", "Images missing descriptions", `${noAlt} of ${imgs.length} images have no alt text (accessibility)`);
    const jq = /jquery[.-]?(1\.\d+(?:\.\d+)?)(?:\.min)?\.js/i.exec(html)?.[1];
    if (jq) add("old_jquery", "low", "Outdated code library", `uses jQuery ${jq}`);
    if (/\.swf["'?]/i.test(html)) add("flash", "high", "Uses Flash", "Flash content no longer works in any browser");
  }

  // 3. Broken internal links (a few).
  const links = [...new Set(
    [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)]
      .map((m) => { try { return new URL(m[1]!, page!.url); } catch { return null; } })
      .filter((u): u is URL => !!u && /^https?:$/.test(u.protocol) && u.host === new URL(page!.url).host && u.pathname !== "/")
      .map((u) => u.toString()),
  )];
  const broken: string[] = [];
  for (const l of links.slice(0, opts.maxLinkChecks ?? 6)) {
    try {
      const r = await getPage(l, o, false);
      if (r.status >= 400) broken.push(`${new URL(l).pathname} (${r.status})`);
    } catch {
      broken.push(`${new URL(l).pathname} (no response)`);
    }
  }
  if (broken.length) add("broken_links", "medium", "Broken links", broken.slice(0, 5).join(", "));

  // 4. Published contact email (home page, else contact page).
  base.contactEmails = extractEmails(html, page.url);
  const contactHref = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)].find(
    (m) => /contact|get[-\s]?in[-\s]?touch|about/i.test(m[1]!) || /contact/i.test(m[2]!),
  )?.[1];
  if (contactHref) {
    try {
      const cu = new URL(contactHref, page.url);
      if (cu.host === new URL(page.url).host) {
        base.contactPageUrl = cu.toString();
        if (!base.contactEmails.length) {
          const cp = await getPage(cu.toString(), o);
          if (cp.status < 400) base.contactEmails = extractEmails(cp.html, cp.url);
        }
      }
    } catch {
      /* ignore */
    }
  }
  // Prefer addresses on the business's own domain.
  const own = host.replace(/^www\./, "");
  base.contactEmails.sort((a, b) => Number(b.email.endsWith(own)) - Number(a.email.endsWith(own)));
  base.contactEmails = base.contactEmails.slice(0, 5);
  return finish(base);
}

function finish(a: SiteAudit): SiteAudit {
  a.findings.sort((x, y) => WEIGHT[y.severity] - WEIGHT[x.severity]);
  a.score = a.findings.reduce((s, f) => s + WEIGHT[f.severity], 0);
  return a;
}

/** Hosts that list businesses rather than being one; skipped when looking for prospects. */
export const DIRECTORY_HOSTS = [
  "yelp.", "yellowpages.", "facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "tiktok.com", "youtube.com",
  "google.", "maps.apple.com", "apple.com", "bing.com", "tripadvisor.", "bbb.org", "houzz.", "homestars.com", "angi.com", "angieslist.com",
  "thumbtack.com", "opentable.", "ubereats.com", "doordash.com", "skipthedishes.com", "wikipedia.org", "reddit.com", "indeed.", "glassdoor.",
  "foursquare.com", "nextdoor.com", "canada411.ca", "411.ca", "zomato.com", "groupon.", "mapquest.com", "healthgrades.com", "ratemds.com",
  "zocdoc.com", "avvo.com", "lawyers.com", "findlaw.com", "justia.com", "pinterest.", "medium.com", "craigslist.", "kijiji.ca", "amazon.",
  "trustpilot.com", "clutch.co", "upwork.com", "fiverr.com", "chamberofcommerce.com", "manta.com", "superpages.com", "cylex", "hotfrog",
];

export function isDirectory(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return DIRECTORY_HOSTS.some((d) => (d.endsWith(".") ? h.startsWith(d) || h.includes(`.${d}`) : h === d || h.endsWith(`.${d}`)));
  } catch {
    return true;
  }
}
