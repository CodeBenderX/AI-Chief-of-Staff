import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import { DEFAULT_AGENTS, MockProvider, toModelName, type ModelRequest, type SearchProvider } from "@aicos/core";
import { buildApp } from "./app.js";
import { createPglite, migrate, type Db } from "./db.js";
import { PgStore } from "./pgStore.js";

// ---- fake internet: search results and the websites they point to ----
const SITES: Record<string, { status?: number; html: string }> = {
  "joesplumbing.test/": { html: `<html><head><title>Joe's Plumbing | Burnaby</title></head><body><p>Since 1998</p><a href="/contact">Contact</a><footer>© 2016</footer></body></html>` },
  "joesplumbing.test/contact": { html: `<p>Email us: <a href="mailto:joe@joesplumbing.test">joe@joesplumbing.test</a></p>` },
  "fastdrain.test/": { html: `<html><head><title>Fast Drain - Plumbers</title></head><body>Call fastdrain@fastdrain.test <footer>Copyright 2015</footer></body></html>` },
  "modernpipes.test/": { html: `<html><head><title>Modern Pipes</title><meta name="viewport" content="width=device-width"><meta name="description" content="x"></head><body><h1>Hi</h1><footer>© 2026</footer></body></html>` },
};
const fakeFetch = (async (input: string | URL | Request) => {
  const u = new URL(String(input));
  if (u.protocol === "https:" && u.hostname !== "modernpipes.test") throw new Error("ECONNREFUSED"); // old sites: no https
  const page = SITES[`${u.hostname}${u.pathname}`];
  return new Response(page?.html ?? "not found", { status: page ? page.status ?? 200 : 404, headers: { "content-type": "text/html" } });
}) as typeof fetch;

let searchCalls: string[] = [];
const fakeSearch: SearchProvider = {
  id: "fake",
  async search(q) {
    searchCalls.push(q);
    return [
      { title: "Best plumbers in Burnaby - Yelp", url: "https://www.yelp.ca/search?find_desc=plumbers", snippet: "" },
      { title: "Joe's Plumbing", url: "https://joesplumbing.test/", snippet: "" },
      { title: "Modern Pipes", url: "https://modernpipes.test/", snippet: "" },
      { title: "Fast Drain", url: "http://www.fastdrain.test/services", snippet: "" },
      { title: "Plumbers | Facebook", url: "https://facebook.com/joes", snippet: "" },
    ];
  },
};

// ---- real SMTP server for delivery ----
const delivered: { to: string[]; raw: string }[] = [];
const smtp = new SMTPServer({
  disabledCommands: ["STARTTLS", "AUTH"],
  logger: false,
  onData(stream, session, cb) {
    let raw = "";
    stream.on("data", (d) => (raw += d));
    stream.on("end", () => (delivered.push({ to: session.envelope.rcptTo.map((r) => r.address), raw }), cb()));
  },
});

// ---- model: Sales forgets the footer first, then fixes it after the refusal ----
const nonAssistant = (r: ModelRequest) => [...r.messages].reverse().find((m) => m.role !== "assistant")?.content ?? "";
const mock = new MockProvider("ollama", (req) => {
  const last = nonAssistant(req);
  const to = /send it to (\S+) using/.exec(req.messages[0]!.content)?.[1];
  const body = "Hi Joe,\n\nI noticed your website isn't mobile-friendly and still says 2016. I help local businesses fix this.\n\nWould a free 15-minute call help?";
  if (!req.messages.some((m) => m.role === "tool")) return { toolCalls: [{ id: "e1", name: toModelName("email.send"), input: { to, subject: "Your website", body } }] };
  if (/must end with this footer/.test(last)) {
    const footer = last.split("---\n")[1]!;
    return { toolCalls: [{ id: "e2", name: toModelName("email.send"), input: { to, subject: "Your website", body: `${body}\n\n---\n${footer}` } }] };
  }
  return { text: `Done: ${last.slice(0, 200)}` };
});

let db: Db;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let ceo: string;
let admin: string;
async function call(method: string, url: string, token?: string, body?: unknown) {
  const res = await ctx.app.inject({ method: method as "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body as object });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  db = await createPglite();
  // An install from before this update: Sales without the new tools.
  await migrate(db);
  const oldSales = DEFAULT_AGENTS.find((a) => a.id === "sales")!;
  await new PgStore(db).upsertAgent({ ...oldSales, tools: ["memory.search", "memory.write", "document.create", "email.send"] });

  ctx = await buildApp({ db, jwtSecret: randomBytes(32).toString("hex"), masterKey: randomBytes(32).toString("base64"), providerOverrides: { ollama: mock } });
  ctx.leads.auditOptions = { fetch: fakeFetch, guard: async () => {}, now: new Date("2026-11-01T12:00:00Z") };
  await call("POST", "/api/auth/setup", undefined, { email: "ceo@co.test", password: "correct horse battery", name: "Ceo" });
  ceo = (await call("POST", "/api/auth/login", undefined, { email: "ceo@co.test", password: "correct horse battery" })).body.token;
  await call("POST", "/api/users", ceo, { email: "a@co.test", password: "another long password", name: "Admin", role: "admin" });
  admin = (await call("POST", "/api/auth/login", undefined, { email: "a@co.test", password: "another long password" })).body.token;
});
afterAll(async () => {
  await ctx.app.close();
  await db.close();
  await new Promise<void>((r) => smtp.close(() => r()));
});

describe("prospecting", { timeout: 30_000 }, () => {
  it("gives existing installs the new read-only tools, once, with an audit record", async () => {
    const sales = (await call("GET", "/api/agents", ceo)).body.find((a: { id: string }) => a.id === "sales");
    expect(sales.tools).toEqual(expect.arrayContaining(["web.search", "site.audit", "email.send"]));
    const audit = (await call("GET", "/api/audit?limit=500", ceo)).body.filter((a: { action: string; target: string }) => a.action === "agent.permissions_change" && a.target === "sales");
    expect(audit).toHaveLength(1);
  });

  it("asks for a search service before running", async () => {
    const r = await call("POST", "/api/lead-runs", ceo, { niche: "plumbers", area: "Burnaby", count: 2 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Settings → Web search/);
  });

  it("finds businesses with weak websites, skipping directories and good sites", async () => {
    ctx.leads.searchOverride = fakeSearch;
    const r = await call("POST", "/api/lead-runs", admin, { niche: "plumbers", area: "Burnaby", count: 2 });
    expect(r.status).toBe(200);
    await ctx.leads.lastRun;
    const [run] = (await call("GET", "/api/lead-runs", ceo)).body;
    expect(run).toMatchObject({ status: "completed", qualified: 2, checked: 3 });
    expect(searchCalls[0]).toBe("plumbers Burnaby");

    const list = (await call("GET", "/api/leads", ceo)).body;
    expect(list.map((l: { domain: string }) => l.domain).sort()).toEqual(["fastdrain.test", "joesplumbing.test"]);
    const joe = list.find((l: { domain: string }) => l.domain === "joesplumbing.test");
    expect(joe).toMatchObject({ business_name: "Joe's Plumbing", status: "qualified", contact_email: "joe@joesplumbing.test" });
    expect(joe.contact_source).toContain("/contact");
    expect(joe.audit.findings.map((f: { id: string }) => f.id)).toEqual(expect.arrayContaining(["no_https", "not_mobile", "outdated"]));
    // the modern site is kept (so it isn't re-checked) but hidden from the default list
    expect((await call("GET", "/api/leads?status=not_a_fit", ceo)).body.map((l: { domain: string }) => l.domain)).toEqual(["modernpipes.test"]);

    // a second run doesn't re-check known sites
    await call("POST", "/api/lead-runs", ceo, { niche: "plumbers", area: "Burnaby", count: 2 });
    await ctx.leads.lastRun;
    expect((await call("GET", "/api/lead-runs", ceo)).body[0]).toMatchObject({ status: "completed", qualified: 0, checked: 0 });
  });

  it("drafts outreach only after you fill in your details, and enforces the footer", async () => {
    const joe = (await call("GET", "/api/leads", ceo)).body.find((l: { domain: string }) => l.domain === "joesplumbing.test");
    const blocked = await call("POST", `/api/leads/${joe.id}/draft`, ceo);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Settings → Outreach/);

    await call("PUT", "/api/settings/outreach", ceo, {
      senderName: "Angelo T.", businessName: "Angelo Web Studio", contactLine: "angeloweb.test · 604-555-0100",
      optOutText: 'If you\'d rather not hear from me, just reply "no thanks" and I won\'t contact you again.',
      pitch: "I build fast, mobile-friendly websites for local businesses.", minScore: 4,
    });
    await call("PUT", "/api/settings/email", ceo, { enabled: true, host: "127.0.0.1", port: (smtp.server.address() as AddressInfo).port, security: "none", username: "", fromAddress: "angelo@angeloweb.test", fromName: "Angelo", allowedDomains: [], dailyLimit: 50, bccCeo: false });

    const d = await call("POST", `/api/leads/${joe.id}/draft`, ceo);
    expect(d.status).toBe(200);
    await until(() => call("GET", `/api/tasks/${d.body.taskId}`, ceo), (r) => r.body.task.status === "awaiting_approval");
    // first attempt without the footer was refused before reaching you
    const audit = (await call("GET", "/api/audit?limit=500", ceo)).body;
    expect(audit.some((a: { detail: { preflight?: boolean } }) => a.detail.preflight)).toBe(true);
    const [approval] = (await call("GET", "/api/approvals?status=pending", ceo)).body;
    expect(approval.input.body).toContain("Angelo Web Studio");
    expect(approval.input.body).toContain("no thanks");
    expect((await call("GET", `/api/leads/${joe.id}`, ceo)).body.status).toBe("drafting");

    await call("POST", `/api/approvals/${approval.id}/decision`, ceo, { decision: "approved" });
    await until(() => call("GET", `/api/leads/${joe.id}`, ceo), (r) => r.body.status === "contacted");
    expect((await call("GET", `/api/leads/${joe.id}`, ceo)).body.status).toBe("contacted");
    expect(delivered.at(-1)!.to).toEqual(["joe@joesplumbing.test"]);
    expect(delivered.at(-1)!.raw).toContain("Angelo Web Studio");
  });

  it("respects the do-not-contact list everywhere", async () => {
    const fast = (await call("GET", "/api/leads", ceo)).body.find((l: { domain: string }) => l.domain === "fastdrain.test");
    // An email approved before they opted out is still stopped at send time.
    const d = await call("POST", `/api/leads/${fast.id}/draft`, ceo);
    await until(() => call("GET", `/api/tasks/${d.body.taskId}`, ceo), (r) => r.body.task.status === "awaiting_approval");
    const [approval] = (await call("GET", "/api/approvals?status=pending", ceo)).body;
    expect((await call("POST", `/api/leads/${fast.id}/do-not-contact`, admin)).status).toBe(200);
    const before = delivered.length;
    await call("POST", `/api/approvals/${approval.id}/decision`, ceo, { decision: "approved" });
    const done = await until(() => call("GET", `/api/tasks/${d.body.taskId}`, ceo), (r) => ["completed", "escalated", "failed"].includes(r.body.task.status));
    // Refused at execution time (before reaching the outbox), and the agent was told why.
    expect(delivered).toHaveLength(before);
    expect((await call("GET", "/api/outbox", ceo)).body.some((o: { recipient: string }) => o.recipient === "fastdrain@fastdrain.test")).toBe(false);
    expect(JSON.stringify(done.body.transcript)).toMatch(/do-not-contact list/);
    // Defense in depth: the outbox itself also refuses suppressed recipients.
    const direct = await ctx.outbox.send({ channel: "email", to: "fastdrain@fastdrain.test", subject: "x", body: "y" });
    expect(direct).toMatchObject({ status: "failed" });
    expect(direct.detail).toMatch(/do-not-contact/);
    expect(delivered).toHaveLength(before);

    // can't draft again; removal is CEO-only
    expect((await call("POST", `/api/leads/${fast.id}/draft`, ceo)).status).toBe(409);
    expect((await call("DELETE", "/api/do-not-contact/fastdrain.test", admin)).status).toBe(403);
    expect((await call("GET", "/api/do-not-contact", ceo)).body.map((s: { value: string }) => s.value).sort()).toEqual(["fastdrain.test", "fastdrain@fastdrain.test"]);
  });

  it("caps searches per month", async () => {
    await call("PUT", "/api/settings/search", ceo, { provider: "tavily", searxngUrl: "", country: "", monthlyLimit: 1 });
    const status = (await call("GET", "/api/settings/search", ceo)).body.status;
    expect(status.used).toBeGreaterThanOrEqual(1);
    await expect(ctx.leads.search("anything", "test")).rejects.toThrow(/monthly search limit \(1\) reached/);
  });
});
