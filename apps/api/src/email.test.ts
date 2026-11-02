import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import { MockProvider, toModelName, type ModelRequest } from "@aicos/core";
import { buildApp } from "./app.js";
import { createPglite, type Db } from "./db.js";

interface Received { from: string; to: string[]; raw: string; user?: string }
const received: Received[] = [];

// A real SMTP server on localhost. Requires login; rejects any recipient containing "bounce".
const smtp = new SMTPServer({
  disabledCommands: ["STARTTLS"],
  allowInsecureAuth: true,
  logger: false,
  onAuth(auth, _session, cb) {
    if (auth.username === "agent@co.test" && auth.password === "app-password-123") return cb(null, { user: auth.username });
    return cb(new Error("Invalid login"));
  },
  onRcptTo(addr, _s, cb) {
    if (addr.address.includes("bounce")) return cb(Object.assign(new Error("No such user"), { responseCode: 550 }));
    cb();
  },
  onData(stream, session, cb) {
    let raw = "";
    stream.on("data", (d) => (raw += d));
    stream.on("end", () => {
      received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw, user: session.user as string | undefined });
      cb();
    });
  },
});

const lastNonAssistant = (r: ModelRequest) => [...r.messages].reverse().find((m) => m.role !== "assistant")?.content ?? "";
// Sales agent emails whatever address appears in its assignment, once; then reports the tool result verbatim.
const mock = new MockProvider("ollama", (req) => {
  if (!req.messages.some((m) => m.role === "tool")) {
    const to = /[\w.+-]+@[\w.-]+\.\w+/.exec(lastNonAssistant(req))?.[0] ?? "nobody@example.test";
    return { toolCalls: [{ id: "c1", name: toModelName("email.send"), input: { to, subject: "Pilot next steps", body: "Hi,\n\nConfirming the pilot starts 15 November.\n\nBest" } }] };
  }
  return { text: `RESULT: ${lastNonAssistant(req)}` };
});

let db: Db;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let ceo: string;
let admin: string;
let port: number;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const res = await ctx.app.inject({ method: method as "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body as object });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Run one sales task to the approval, approve it, return the finished task's outbox row. */
async function approvedEmailTo(address: string) {
  const t = (await call("POST", "/api/tasks", ceo, { objective: `Email ${address} about the pilot`, agentId: "sales" })).body;
  await until(() => call("GET", `/api/tasks/${t.id}`, ceo), (r) => r.body.task.status === "awaiting_approval");
  const [a] = (await call("GET", "/api/approvals?status=pending", ceo)).body;
  expect(a.input.to).toBe(address);
  await call("POST", `/api/approvals/${a.id}/decision`, ceo, { decision: "approved" });
  const done = await until(() => call("GET", `/api/tasks/${t.id}`, ceo), (r) => r.body.task.status === "completed");
  const row = (await call("GET", "/api/outbox", ceo)).body.find((o: { task_id: string }) => o.task_id === t.id);
  return { task: done.body.task, row };
}

const emailSettings = (over: Record<string, unknown> = {}) => ({
  enabled: true, host: "127.0.0.1", port, security: "none", username: "agent@co.test", fromAddress: "agent@co.test", fromName: "Acme Sales",
  allowedDomains: [], dailyLimit: 50, bccCeo: false, ...over,
});

beforeAll(async () => {
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  port = (smtp.server.address() as AddressInfo).port;
  db = await createPglite();
  ctx = await buildApp({ db, jwtSecret: randomBytes(32).toString("hex"), masterKey: randomBytes(32).toString("base64"), providerOverrides: { ollama: mock } });
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

describe("email delivery", () => {
  let queuedId: string;

  it("queues approved email honestly when no email account is set up", async () => {
    const { task, row } = await approvedEmailTo("first@client.test");
    expect(row).toMatchObject({ status: "queued_no_connector", recipient: "first@client.test" });
    expect(row.detail).toMatch(/turned off/);
    expect(task.result).toContain("queued_no_connector");
    expect(received).toHaveLength(0);
    queuedId = row.id;
  });

  it("only lets the CEO configure email, and refuses plaintext SMTP to remote hosts", async () => {
    expect((await call("PUT", "/api/settings/email", admin, emailSettings())).status).toBe(403);
    expect((await call("PUT", "/api/settings/email", ceo, emailSettings({ host: "smtp.example.com" }))).status).toBe(400);
    const r = await call("PUT", "/api/settings/email", ceo, emailSettings());
    expect(r.body.notReady).toMatch(/SMTP_PASSWORD/);
  });

  it("reports a wrong password clearly", async () => {
    await call("PUT", "/api/secrets/SMTP_PASSWORD", ceo, { value: "wrong-password" });
    const r = await call("POST", "/api/settings/email/test", ceo);
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/app password/);
  });

  it("sends a test email to the CEO", async () => {
    await call("PUT", "/api/secrets/SMTP_PASSWORD", ceo, { value: "app-password-123" });
    const r = await call("POST", "/api/settings/email/test", ceo);
    expect(r.body).toMatchObject({ ok: true, to: "ceo@co.test" });
    expect(received.at(-1)).toMatchObject({ to: ["ceo@co.test"], user: "agent@co.test" });
    // the password never comes back from the API
    expect(JSON.stringify((await call("GET", "/api/settings", ceo)).body)).not.toContain("app-password-123");
  });

  it("delivers an approved email exactly as approved, with BCC to the CEO", async () => {
    await call("PUT", "/api/settings/email", ceo, emailSettings({ bccCeo: true }));
    const before = received.length;
    const { task, row } = await approvedEmailTo("maria@ledgerline.test");
    expect(row).toMatchObject({ status: "sent", attempts: 1 });
    expect(row.provider_message_id).toBeTruthy();
    expect(task.result).toMatch(/"status":"sent"/);
    expect(received).toHaveLength(before + 1);
    const msg = received.at(-1)!;
    expect(msg.to.sort()).toEqual(["ceo@co.test", "maria@ledgerline.test"]);
    expect(msg.raw).toContain("Subject: Pilot next steps");
    expect(msg.raw).toContain("Confirming the pilot starts 15 November.");
    expect(msg.raw).toMatch(/From: "?Acme Sales"? <agent@co\.test>/);
    expect(msg.raw).not.toMatch(/^Bcc:/m); // BCC stays out of the headers
  });

  it("enforces the recipient domain allowlist without contacting the server", async () => {
    await call("PUT", "/api/settings/email", ceo, emailSettings({ allowedDomains: ["ledgerline.test"] }));
    const before = received.length;
    const { task, row } = await approvedEmailTo("someone@other.test");
    expect(row.status).toBe("failed");
    expect(row.detail).toMatch(/not on the allowed list/);
    expect(task.result).toMatch(/failed/);
    expect(received).toHaveLength(before);
    // subdomains of an allowed domain are fine
    expect((await approvedEmailTo("ops@eu.ledgerline.test")).row.status).toBe("sent");
  });

  it("records a server rejection as a failure", async () => {
    await call("PUT", "/api/settings/email", ceo, emailSettings());
    const { row } = await approvedEmailTo("bounce@client.test");
    expect(row.status).toBe("failed");
    expect(row.detail).toMatch(/No such user|did not accept/);
  });

  it("lets only the CEO deliver an earlier queued email, once", async () => {
    expect((await call("POST", `/api/outbox/${queuedId}/retry`, admin)).status).toBe(403);
    const before = received.length;
    const r = await call("POST", `/api/outbox/${queuedId}/retry`, ceo);
    expect(r.body.status).toBe("sent");
    expect(received).toHaveLength(before + 1);
    expect(received.at(-1)!.to).toEqual(["first@client.test"]);
    expect((await call("POST", `/api/outbox/${queuedId}/retry`, ceo)).status).toBe(409);
    expect(received).toHaveLength(before + 1);
  });

  it("stops at the daily sending limit", async () => {
    const sent = (await call("GET", "/api/outbox", ceo)).body.filter((o: { status: string }) => o.status === "sent").length;
    await call("PUT", "/api/settings/email", ceo, emailSettings({ dailyLimit: sent }));
    const { row } = await approvedEmailTo("late@client.test");
    expect(row.status).toBe("failed");
    expect(row.detail).toMatch(/daily email limit/);
  });

  it("audits configuration, tests and retries", async () => {
    const actions = (await call("GET", "/api/audit?limit=500", ceo)).body.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["settings.email", "email.test", "outbox.retry", "tool.email.send"]));
  });
});
