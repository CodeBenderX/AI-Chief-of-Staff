import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import { MockProvider, toModelName, type ModelRequest } from "@aicos/core";
import { buildApp } from "./app.js";
import { createPglite, type Db } from "./db.js";

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

// Sales emails the address in its assignment once, then reports back.
const nonAssistant = (r: ModelRequest) => [...r.messages].reverse().find((m) => m.role !== "assistant")?.content ?? "";
const mock = new MockProvider("ollama", (req) => {
  if (!req.messages.some((m) => m.role === "tool")) {
    const to = /[\w.+-]+@[\w.-]+\.\w+/.exec(req.messages[0]!.content)?.[0];
    return { toolCalls: [{ id: "e1", name: toModelName("email.send"), input: { to, subject: "Quick question", body: "Agent draft: a bit too pushy." } }] };
  }
  return { text: `RESULT: ${nonAssistant(req)}` };
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
/** Start a Sales task that emails `to`, and return its pending approval. */
async function pendingEmailTo(to: string) {
  const t = (await call("POST", "/api/tasks", ceo, { objective: `Email ${to} a short hello`, agentId: "sales" })).body;
  await until(() => call("GET", `/api/tasks/${t.id}`, ceo), (r) => r.body.task.status === "awaiting_approval");
  const a = (await call("GET", "/api/approvals?status=pending", ceo)).body.find((x: { taskId: string }) => x.taskId === t.id);
  return { taskId: t.id as string, approval: a };
}

beforeAll(async () => {
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  db = await createPglite();
  ctx = await buildApp({ db, jwtSecret: randomBytes(32).toString("hex"), masterKey: randomBytes(32).toString("base64"), providerOverrides: { ollama: mock } });
  await call("POST", "/api/auth/setup", undefined, { email: "ceo@co.test", password: "correct horse battery", name: "Ceo" });
  ceo = (await call("POST", "/api/auth/login", undefined, { email: "ceo@co.test", password: "correct horse battery" })).body.token;
  await call("POST", "/api/users", ceo, { email: "a@co.test", password: "another long password", name: "Admin", role: "admin" });
  admin = (await call("POST", "/api/auth/login", undefined, { email: "a@co.test", password: "another long password" })).body.token;
  await call("PUT", "/api/settings/email", ceo, {
    enabled: true, host: "127.0.0.1", port: (smtp.server.address() as AddressInfo).port, security: "none", username: "",
    fromAddress: "me@co.test", fromName: "Me", allowedDomains: [], dailyLimit: 50, bccCeo: false,
  });
});
afterAll(async () => {
  await ctx.app.close();
  await db.close();
  await new Promise<void>((r) => smtp.close(() => r()));
});

describe("editing an action before approving it", { timeout: 30_000 }, () => {
  it("sends exactly the CEO's edited version, to the edited recipient", async () => {
    const { taskId, approval } = await pendingEmailTo("old@client.test");
    const edit = { to: "new@client.test", subject: "Your website", body: "Hi Sam,\n\nMy own wording.\n\nAngelo" };
    const r = await call("POST", `/api/approvals/${approval.id}/decision`, ceo, { decision: "approved", edit });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "approved", editedBy: expect.any(String), input: edit, originalInput: { to: "old@client.test", body: "Agent draft: a bit too pushy." } });

    const done = await until(() => call("GET", `/api/tasks/${taskId}`, ceo), (x) => x.body.task.status === "completed");
    const msg = delivered.at(-1)!;
    expect(msg.to).toEqual(["new@client.test"]);
    expect(msg.raw).toContain("Subject: Your website");
    expect(msg.raw).toContain("My own wording.");
    expect(msg.raw).not.toContain("too pushy");
    expect(delivered.some((d) => d.to.includes("old@client.test"))).toBe(false);
    // the agent is told its draft was edited
    expect(JSON.stringify(done.body.transcript)).toContain("The CEO edited your proposed action");
    // the audit log keeps both versions
    const audit = (await call("GET", "/api/audit?limit=500", ceo)).body.find((a: { action: string; target: string }) => a.action === "approval.approved" && a.target === approval.id);
    expect(audit.detail).toMatchObject({ edited: true, original: { to: "old@client.test" }, approvedVersion: { to: "new@client.test" } });
  });

  it("checks edits like any agent draft and leaves the request pending when they fail", async () => {
    const { approval } = await pendingEmailTo("checks@client.test");
    const decide = (body: unknown, token = ceo) => call("POST", `/api/approvals/${approval.id}/decision`, token, body);

    expect((await decide({ decision: "approved", edit: { to: "not-an-email" } })).status).toBe(400);
    const extra = await decide({ decision: "approved", edit: { cc: "boss@co.test" } });
    expect(extra.status).toBe(400);
    expect(extra.body.error).toMatch(/only to, subject and body can be edited/);
    expect((await decide({ decision: "rejected", edit: { subject: "x" } })).status).toBe(400);
    expect((await decide({ decision: "approved", edit: { subject: "x" } }, admin)).status).toBe(403);

    await call("POST", "/api/do-not-contact", ceo, { value: "blocked.test" });
    const blocked = await decide({ decision: "approved", edit: { to: "owner@blocked.test" } });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/do-not-contact/);

    expect((await call("GET", `/api/approvals?status=pending`, ceo)).body.some((a: { id: string }) => a.id === approval.id)).toBe(true);

    // a valid edit still works afterwards, and a decided request can't be edited again
    expect((await decide({ decision: "approved", edit: { subject: "Fine now" } })).status).toBe(200);
    expect((await decide({ decision: "approved", edit: { subject: "Again" } })).status).toBe(409);
  });

  it("requires the outreach footer when editing an email to a lead", async () => {
    await call("PUT", "/api/settings/outreach", ceo, {
      senderName: "Angelo", businessName: "Angelo Web Studio", contactLine: "angeloweb.test",
      optOutText: 'Reply "no thanks" and I won\'t contact you again.', pitch: "Websites.", minScore: 4,
    });
    await db.query(`INSERT INTO leads (id, domain, business_name, website, status, contact_email) VALUES ('lead_x', 'joes.test', 'Joe', 'https://joes.test', 'qualified', 'joe@joes.test')`);
    const { approval } = await pendingEmailTo("someone@client.test");
    const noFooter = await call("POST", `/api/approvals/${approval.id}/decision`, ceo, { decision: "approved", edit: { to: "joe@joes.test", body: "Hi Joe, want a new site?" } });
    expect(noFooter.status).toBe(400);
    expect(noFooter.body.error).toMatch(/must end with/);
    const withFooter = await call("POST", `/api/approvals/${approval.id}/decision`, ceo, {
      decision: "approved",
      edit: { to: "joe@joes.test", body: "Hi Joe, want a new site?\n\n---\nAngelo\nAngelo Web Studio\nangeloweb.test\n\nReply \"no thanks\" and I won't contact you again." },
    });
    expect(withFooter.status).toBe(200);
  });
});
