import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockProvider, toModelName, type ModelRequest } from "@aicos/core";
import { buildApp } from "./app.js";
import { createPglite, type Db } from "./db.js";

const lastNonAssistant = (r: ModelRequest) => [...r.messages].reverse().find((m) => m.role !== "assistant")?.content ?? "";
const who = (r: ModelRequest) => /You are the (.+?) of/.exec(r.system)?.[1];

let db: Db;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let ceo: string;
let viewer: string;
let admin: string;

const mock = new MockProvider("ollama", (req) => {
  const last = lastNonAssistant(req);
  if (last.startsWith("PLAN_REQUEST"))
    return { text: JSON.stringify({ summary: "outreach", subtasks: [{ key: "s", agentId: "sales", title: "Email Acme", instructions: "Send a short intro email to buyer@acme.test", dependsOn: [] }] }) };
  if (last.startsWith("SYNTHESIS_REQUEST")) return { text: "Report: intro email sent after approval." };
  if (who(req) === "Sales Director" && !req.messages.some((m) => m.role === "tool"))
    return { toolCalls: [{ id: "c1", name: toModelName("email.send"), input: { to: "buyer@acme.test", subject: "Hello from us", body: "Intro" } }] };
  return { text: `done: ${last.slice(0, 100)}` };
});

async function call(method: string, url: string, token?: string, body?: unknown) {
  const res = await ctx.app.inject({ method: method as "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body as object });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  db = await createPglite();
  ctx = await buildApp({ db, jwtSecret: randomBytes(32).toString("hex"), masterKey: randomBytes(32).toString("base64"), providerOverrides: { ollama: mock } });
  const setup = await call("POST", "/api/auth/setup", undefined, { email: "ceo@co.test", password: "correct horse battery", name: "Ceo" });
  expect(setup.status).toBe(200);
  ceo = (await call("POST", "/api/auth/login", undefined, { email: "ceo@co.test", password: "correct horse battery" })).body.token;
  for (const [role, email] of [["viewer", "v@co.test"], ["admin", "a@co.test"]] as const) {
    expect((await call("POST", "/api/users", ceo, { email, password: "another long password", name: role, role })).status).toBe(200);
  }
  viewer = (await call("POST", "/api/auth/login", undefined, { email: "v@co.test", password: "another long password" })).body.token;
  admin = (await call("POST", "/api/auth/login", undefined, { email: "a@co.test", password: "another long password" })).body.token;
});
afterAll(async () => {
  await ctx.app.close();
  await db.close();
});

describe("auth & RBAC", () => {
  it("allows first-run setup only once", async () => {
    expect((await call("POST", "/api/auth/setup", undefined, { email: "x@co.test", password: "correct horse battery", name: "X" })).status).toBe(409);
  });
  it("rejects anonymous and wrong-password requests", async () => {
    expect((await call("GET", "/api/overview")).status).toBe(401);
    expect((await call("POST", "/api/auth/login", undefined, { email: "ceo@co.test", password: "wrong password!!" })).status).toBe(401);
  });
  it("lets viewers read but not act", async () => {
    expect((await call("GET", "/api/agents", viewer)).body).toHaveLength(12);
    expect((await call("POST", "/api/tasks", viewer, { objective: "do things" })).status).toBe(403);
  });
  it("stops admins from changing agent permissions", async () => {
    const agent = (await call("GET", "/api/agents", admin)).body.find((a: { id: string }) => a.id === "finance");
    const { metrics: _m, ...def } = agent;
    expect((await call("PUT", "/api/agents/finance", admin, { ...def, responsibilities: [...def.responsibilities, "Cash flow"] })).status).toBe(200);
    expect((await call("PUT", "/api/agents/finance", admin, { ...def, tools: [...def.tools, "email.send"] })).status).toBe(403);
    expect((await call("PUT", "/api/agents/finance", ceo, { ...def, tools: [...def.tools, "nonexistent.tool"] })).status).toBe(400);
  });
});

describe("end-to-end task with CEO approval", () => {
  it("plans, pauses for approval, and only sends after the CEO approves", async () => {
    const created = await call("POST", "/api/tasks", ceo, { objective: "Reach out to Acme about a pilot" });
    expect(created.status).toBe(200);
    const id = created.body.id;

    const paused = await until(() => call("GET", `/api/tasks/${id}`, ceo), (r) => r.body.task.status === "awaiting_approval");
    expect(paused.body.task.status).toBe("awaiting_approval");
    expect((await call("GET", "/api/outbox", ceo)).body).toHaveLength(0);

    const pending = (await call("GET", "/api/approvals?status=pending", ceo)).body;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ toolId: "email.send", risk: "medium", input: { to: "buyer@acme.test" } });

    expect((await call("POST", `/api/approvals/${pending[0].id}/decision`, viewer, { decision: "approved" })).status).toBe(403);
    expect((await call("POST", `/api/approvals/${pending[0].id}/decision`, admin, { decision: "approved" })).status).toBe(403);
    expect((await call("POST", `/api/approvals/${pending[0].id}/decision`, ceo, { decision: "approved" })).status).toBe(200);

    const done = await until(() => call("GET", `/api/tasks/${id}`, ceo), (r) => r.body.task.status === "completed");
    expect(done.body.task.status).toBe("completed");
    expect(done.body.tree).toHaveLength(2);
    expect(done.body.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["plan.created", "approval.requested", "tool.executed", "task.completed"]));
    const out = (await call("GET", "/api/outbox", ceo)).body;
    expect(out).toEqual([expect.objectContaining({ recipient: "buyer@acme.test", status: "queued_no_connector" })]);

    const overview = (await call("GET", "/api/overview", viewer)).body;
    expect(overview.tasks.completed).toBe(2);
    expect(overview.pendingApprovals).toBe(0);
  });
});

describe("memory, secrets, audit", () => {
  it("stores verified CEO knowledge and finds it with full-text search", async () => {
    await call("POST", "/api/memory", ceo, { scope: "company", title: "Pricing policy", content: "We never discount below 20 percent margin.", source: "CEO directive" });
    const hits = (await call("GET", "/api/memory?q=discount%20margin", viewer)).body;
    expect(hits[0]).toMatchObject({ title: "Pricing policy", verified: true });
  });

  it("encrypts secrets and never returns their values", async () => {
    expect((await call("PUT", "/api/secrets/ANTHROPIC_API_KEY", admin, { value: "sk-ant-test-1234567890" })).status).toBe(403);
    expect((await call("PUT", "/api/secrets/ANTHROPIC_API_KEY", ceo, { value: "sk-ant-test-1234567890" })).status).toBe(200);
    const list = (await call("GET", "/api/secrets", ceo)).body;
    expect(list.find((s: { name: string }) => s.name === "ANTHROPIC_API_KEY")).toMatchObject({ source: "stored", hint: "••••7890" });
    expect(JSON.stringify(list)).not.toContain("sk-ant-test");
    const raw = await db.query<{ ciphertext: string }>(`SELECT ciphertext FROM secrets`);
    expect(raw[0]!.ciphertext).not.toContain("sk-ant");
    expect(JSON.stringify((await call("GET", "/api/audit", ceo)).body)).not.toContain("sk-ant-test");
  });

  it("keeps the audit log append-only at the database level", async () => {
    await expect(db.query(`UPDATE audit_log SET actor_id='x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });

  it("validates model settings", async () => {
    const s = (await call("GET", "/api/settings", ceo)).body;
    const bad = { ...s.models, profiles: s.models.profiles.map((p: { id: string }) => (p.id === "default" ? { ...p, provider: "nope" } : p)) };
    expect((await call("PUT", "/api/settings/models", ceo, bad)).status).toBe(400);
    expect((await call("PUT", "/api/settings/models", ceo, s.models)).status).toBe(200);
  });
});
