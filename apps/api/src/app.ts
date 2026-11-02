import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  AutonomyLevel,
  DisabledSandbox,
  MEMORY_SCOPES,
  createCompany,
  newId,
  seedAgents,
  type AgentDefinition,
  type Sandbox,
  type TaskEvent,
} from "@aicos/core";
import { hashPassword, loadUser, requirePermission, verifyPassword, type SessionUser } from "./auth.js";
import { migrate, type Db } from "./db.js";
import { PgStore } from "./pgStore.js";
import { SecretStore } from "./secrets.js";
import { DbDocuments, DbOutbox } from "./services.js";
import { CompanySchema, ModelsSchema, PoliciesSchema, Settings } from "./settings.js";

export interface AppConfig {
  db: Db;
  jwtSecret: string;
  masterKey?: string;
  webOrigin?: string;
  sandbox?: Sandbox;
  staticDir?: string;
  secureCookies?: boolean;
  logger?: boolean;
  /** Provider overrides (tests). */
  providerOverrides?: Parameters<ReturnType<typeof createCompany>["router"]["configure"]>[3];
}

const COOKIE = "aicos_session";

export async function buildApp(cfg: AppConfig) {
  if (cfg.jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  const { db } = cfg;
  await migrate(db);

  const store = new PgStore(db);
  const settings = new Settings(db);
  const secrets = new SecretStore(db, cfg.masterKey);
  const outbox = new DbOutbox(db);
  const documents = new DbDocuments(db);
  const company = createCompany({ store, services: { outbox, documents, sandbox: cfg.sandbox ?? new DisabledSandbox() } });
  await seedAgents(store);

  const reloadModels = async () => {
    const m = await settings.get("models");
    await company.router.configure(m.providers, m.profiles, secrets, cfg.providerOverrides ?? {});
  };
  await reloadModels();

  const app = Fastify({ logger: cfg.logger ?? false, bodyLimit: 1_000_000, trustProxy: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: cfg.webOrigin ? [cfg.webOrigin] : false, credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(cookie);
  await app.register(jwt, { secret: cfg.jwtSecret, cookie: { cookieName: COOKIE, signed: false }, sign: { expiresIn: "12h" } });

  const can = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(db, p) });
  const me = (req: { session?: SessionUser }) => req.session!;
  const audit = (user: SessionUser, action: string, target: string | null, detail: Record<string, unknown> = {}, outcome: "ok" | "denied" = "ok") =>
    company.audit.write({ actorType: "user", actorId: user.id, action, target, outcome, detail });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "validation failed", details: z.prettifyError(err) });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? "internal error" : (err as Error).message });
  });

  // ---------------- auth ----------------
  const Credentials = z.object({ email: z.email().max(200), password: z.string().min(12).max(200) });
  const setSession = (reply: import("fastify").FastifyReply, user: SessionUser) => {
    const token = app.jwt.sign({ sub: user.id, role: user.role });
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: cfg.secureCookies ?? false, path: "/", maxAge: 12 * 3600 });
    return token;
  };

  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { ok: true, providers: company.router.availableProviders(), time: new Date().toISOString() };
  });

  app.get("/api/auth/status", async () => {
    const n = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM users`))[0]!.n;
    return { needsSetup: n === "0" };
  });

  /** First-run only: creates the CEO account. Disabled once any user exists. */
  app.post("/api/auth/setup", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = Credentials.extend({ name: z.string().min(1).max(100) }).parse(req.body);
    const id = newId("usr");
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO users (id, email, name, password_hash, role) SELECT $1,$2,$3,$4,'ceo' WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING id`,
      [id, body.email.toLowerCase(), body.name, await hashPassword(body.password)],
    );
    if (!inserted.length) return reply.code(409).send({ error: "setup already completed" });
    const user = (await loadUser(db, id))!;
    setSession(reply, user);
    await audit(user, "auth.setup", id);
    return { user };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ email: z.string().max(200), password: z.string().max(200) }).parse(req.body);
    const row = (await db.query<{ id: string; password_hash: string; active: boolean }>(`SELECT id, password_hash, active FROM users WHERE email=$1`, [body.email.toLowerCase()]))[0];
    const ok = row && row.active && (await verifyPassword(row.password_hash, body.password));
    if (!ok) {
      await company.audit.write({ actorType: "user", actorId: body.email.slice(0, 200), action: "auth.login", target: null, outcome: "denied", detail: {} });
      return reply.code(401).send({ error: "invalid email or password" });
    }
    const user = (await loadUser(db, row.id))!;
    const token = setSession(reply, user);
    await audit(user, "auth.login", user.id);
    return { user, token };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", can("read"), async (req) => ({ user: me(req) }));

  app.post("/api/users", can("users:admin"), async (req) => {
    const body = Credentials.extend({ name: z.string().min(1).max(100), role: z.enum(["admin", "viewer"]) }).parse(req.body);
    const id = newId("usr");
    await db.query(`INSERT INTO users (id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5)`, [id, body.email.toLowerCase(), body.name, await hashPassword(body.password), body.role]);
    await audit(me(req), "user.create", id, { role: body.role });
    return { id };
  });
  app.get("/api/users", can("users:admin"), async () => db.query(`SELECT id, email, name, role, active, created_at FROM users ORDER BY created_at`));

  // ---------------- overview ----------------
  app.get("/api/overview", can("read"), async () => {
    const [agents, counts, pending, events, usage, health] = await Promise.all([
      store.listAgents(),
      db.query<{ status: string; n: string }>(`SELECT status, count(*)::text AS n FROM tasks GROUP BY status`),
      store.listApprovals({ status: "pending" }),
      db.query<{ doc: TaskEvent }>(`SELECT doc FROM task_events ORDER BY seq DESC LIMIT 25`),
      db.query<{ day: string; cost: string; tokens: string; calls: string }>(
        `SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, sum((doc->>'costUsd')::numeric)::text AS cost,
                sum((doc->>'inputTokens')::bigint + (doc->>'outputTokens')::bigint)::text AS tokens, count(*)::text AS calls
         FROM usage WHERE at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`,
      ),
      db.query<{ n: string }>(`SELECT count(*)::text AS n FROM usage WHERE at > now() - interval '1 hour' AND (doc->>'ok')::boolean = false`),
    ]);
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));
    const month = await monthSpend();
    const policies = await settings.get("policies");
    return {
      agents: { total: agents.length, active: agents.filter((a) => a.status === "active").length },
      tasks: byStatus,
      pendingApprovals: pending.length,
      recentActivity: events.map((e) => e.doc),
      usage: usage.map((u) => ({ day: u.day, costUsd: Number(u.cost), tokens: Number(u.tokens), calls: Number(u.calls) })),
      spend: { monthUsd: month, budgetUsd: policies.monthlyBudgetUsd },
      health: { providers: company.router.availableProviders(), failedModelCallsLastHour: Number(health[0]!.n), sandbox: (cfg.sandbox ?? new DisabledSandbox()).kind },
    };
  });

  async function monthSpend() {
    const r = await db.query<{ c: string | null }>(`SELECT sum((doc->>'costUsd')::numeric)::text AS c FROM usage WHERE at >= date_trunc('month', now())`);
    return Number(r[0]?.c ?? 0);
  }

  // ---------------- agents ----------------
  const AgentInput = z.object({
    id: z.string().regex(/^[a-z0-9-]{2,40}$/),
    name: z.string().min(2).max(80),
    department: z.string().min(2).max(80),
    role: z.string().min(2).max(300),
    systemPrompt: z.string().min(20).max(20_000),
    responsibilities: z.array(z.string().max(200)).max(30),
    capabilities: z.array(z.string().max(60)).max(30),
    maxAutonomy: z.nativeEnum(AutonomyLevel),
    tools: z.array(z.string()).max(40),
    memoryAccess: z.object({ read: z.array(z.enum(MEMORY_SCOPES)), write: z.array(z.enum(MEMORY_SCOPES)) }),
    model: z.object({ profile: z.string(), temperature: z.number().min(0).max(2).optional(), maxOutputTokens: z.number().int().min(16).max(200_000).optional() }),
    status: z.enum(["active", "paused", "deactivated"]),
  });

  const checkAgent = (a: z.infer<typeof AgentInput>) => {
    const unknown = a.tools.filter((t) => !company.tools.get(t));
    if (unknown.length) throw Object.assign(new Error(`unknown tools: ${unknown.join(", ")}`), { statusCode: 400 });
    if (!company.router.getProfile(a.model.profile)) throw Object.assign(new Error(`unknown model profile ${a.model.profile}`), { statusCode: 400 });
  };
  const permissionFields = (a: Pick<AgentDefinition, "tools" | "maxAutonomy" | "memoryAccess">) => JSON.stringify([[...a.tools].sort(), a.maxAutonomy, a.memoryAccess]);

  app.get("/api/agents", can("read"), async () => {
    const agents = await store.listAgents();
    const perf = await db.query<{ agent_id: string; status: string; n: string }>(`SELECT agent_id, status, count(*)::text AS n FROM tasks GROUP BY 1,2`);
    const cost = await db.query<{ agent: string; c: string }>(`SELECT doc->>'agentId' AS agent, sum((doc->>'costUsd')::numeric)::text AS c FROM usage GROUP BY 1`);
    return agents.map((a) => {
      const mine = perf.filter((p) => p.agent_id === a.id);
      const n = (s: string) => Number(mine.find((m) => m.status === s)?.n ?? 0);
      const done = n("completed");
      const bad = n("failed") + n("escalated");
      return {
        ...a,
        metrics: {
          completed: done,
          failed: bad,
          running: n("running") + n("awaiting_approval"),
          successRate: done + bad ? done / (done + bad) : null,
          costUsd: Number(cost.find((c) => c.agent === a.id)?.c ?? 0),
        },
      };
    });
  });

  app.post("/api/agents", can("agents:write"), async (req, reply) => {
    const a = AgentInput.parse(req.body);
    checkAgent(a);
    if (await store.getAgent(a.id)) return reply.code(409).send({ error: "agent id exists" });
    // New agents start with no elevated permissions unless the CEO grants them.
    if (me(req).role !== "ceo" && (a.tools.length || a.maxAutonomy > 0)) return reply.code(403).send({ error: "only the CEO can grant tools or autonomy" });
    await store.upsertAgent(a);
    await audit(me(req), "agent.create", a.id, { tools: a.tools, maxAutonomy: a.maxAutonomy });
    return a;
  });

  app.put("/api/agents/:id", can("agents:write"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = await store.getAgent(id);
    if (!current) return reply.code(404).send({ error: "not found" });
    const a = AgentInput.parse({ ...(req.body as object), id });
    checkAgent(a);
    const permsChanged = permissionFields(current) !== permissionFields(a);
    if (permsChanged && me(req).role !== "ceo") {
      await audit(me(req), "agent.permissions_change", id, {}, "denied");
      return reply.code(403).send({ error: "changing an agent's tools, autonomy or memory access requires the CEO" });
    }
    const next = { ...current, ...a };
    await store.upsertAgent(next);
    await audit(me(req), permsChanged ? "agent.permissions_change" : "agent.update", id, permsChanged ? { before: JSON.parse(permissionFields(current)), after: JSON.parse(permissionFields(a)) } : {});
    return next;
  });

  app.get("/api/agents/:id/activity", can("read"), async (req) => {
    const { id } = req.params as { id: string };
    const tasks = await store.listTasks({ agentId: id, limit: 50 });
    const auditRows = await store.listAudit({ actorId: id, limit: 50 });
    return { tasks: tasks.map(({ state: _s, ...t }) => t), audit: auditRows };
  });

  app.get("/api/tools", can("read"), async () => company.tools.catalog());

  // ---------------- tasks ----------------
  app.post("/api/tasks", can("tasks:write"), async (req, reply) => {
    const policies = await settings.get("policies");
    const body = z
      .object({
        objective: z.string().min(5).max(20_000),
        title: z.string().max(200).optional(),
        agentId: z.string().optional(),
        priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
        autonomyCap: z.nativeEnum(AutonomyLevel).optional(),
        limits: PoliciesSchema.shape.limits.partial().optional(),
      })
      .parse(req.body);
    // Only the CEO may run a task above the company default autonomy cap.
    const cap = body.autonomyCap ?? policies.defaultAutonomyCap;
    if (cap > policies.defaultAutonomyCap && me(req).role !== "ceo") return reply.code(403).send({ error: "raising the autonomy cap requires the CEO" });
    const spent = await monthSpend();
    if (spent >= policies.monthlyBudgetUsd) return reply.code(402).send({ error: `monthly AI budget ($${policies.monthlyBudgetUsd}) reached` });
    const task = await company.orchestrator.submit(body.objective, {
      createdBy: me(req).id,
      title: body.title,
      agentId: body.agentId,
      priority: body.priority,
      autonomyCap: cap,
      limits: { ...policies.limits, ...body.limits },
    });
    await audit(me(req), "task.create", task.id, { agentId: task.agentId, autonomyCap: cap });
    return strip(task);
  });

  const strip = <T extends { state?: unknown }>(t: T) => {
    const { state, ...rest } = t;
    return { ...rest, steps: (state as { steps?: number } | null)?.steps ?? 0 };
  };

  app.get("/api/tasks", can("read"), async (req) => {
    const q = z.object({ status: z.string().optional(), rootsOnly: z.coerce.boolean().optional(), limit: z.coerce.number().int().max(500).optional() }).parse(req.query);
    const rows = await db.query<{ doc: import("@aicos/core").TaskRecord }>(
      `SELECT doc FROM tasks WHERE ($1::text IS NULL OR status=$1) AND ($2::boolean IS NOT TRUE OR parent_id IS NULL) ORDER BY created_at DESC LIMIT $3`,
      [q.status ?? null, q.rootsOnly ?? false, q.limit ?? 200],
    );
    return rows.map((r) => strip(r.doc));
  });

  app.get("/api/tasks/:id", can("read"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await store.getTask(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const [tree, events, approvals, usage] = await Promise.all([
      store.listTasks({ rootId: task.rootId, limit: 1000 }),
      store.listEvents({ rootId: task.rootId, limit: 2000 }),
      store.listApprovals({ rootTaskId: task.rootId }),
      store.listUsage({ rootId: task.rootId }),
    ]);
    return {
      task: strip(task),
      tree: tree.map(strip),
      events,
      approvals,
      usage: { calls: usage.length, tokens: usage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0), costUsd: usage.reduce((s, u) => s + u.costUsd, 0) },
      transcript: task.state?.messages ?? [],
    };
  });

  app.post("/api/tasks/:id/cancel", can("tasks:write"), async (req) => {
    const { id } = req.params as { id: string };
    await company.orchestrator.cancel(id, me(req).id);
    return { ok: true };
  });

  // ---------------- approvals ----------------
  app.get("/api/approvals", can("read"), async (req) => {
    await company.approvals.expireStale();
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const list = await store.listApprovals({ status: q.status });
    const tasks = new Map<string, string>();
    for (const a of list) if (!tasks.has(a.taskId)) tasks.set(a.taskId, (await store.getTask(a.taskId))?.title ?? "");
    return list.map((a) => ({ ...a, taskTitle: tasks.get(a.taskId), tool: company.tools.catalog().find((t) => t.id === a.toolId)?.name }));
  });

  app.post("/api/approvals/:id/decision", can("approvals:decide"), async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ decision: z.enum(["approved", "rejected", "changes_requested"]), note: z.string().max(2000).optional() }).parse(req.body);
    if (body.decision === "changes_requested" && !body.note) throw Object.assign(new Error("say what should change"), { statusCode: 400 });
    const a = await company.approvals.decide(id, body.decision, me(req).id, body.note);
    await company.orchestrator.resume(a.taskId);
    return a;
  });

  // ---------------- memory & knowledge ----------------
  const ceoActor = (req: { session?: SessionUser }) => ({ type: "ceo" as const, id: me(req).id });

  app.get("/api/memory", can("read"), async (req) => {
    const q = z.object({ q: z.string().max(500).optional(), scope: z.enum(MEMORY_SCOPES).optional(), status: z.enum(["current", "conflict", "archived", "superseded", "all"]).optional() }).parse(req.query);
    const statuses = q.status === "all" ? (["current", "conflict", "archived", "superseded"] as const) : q.status ? [q.status] : (["current", "conflict"] as const);
    return store.queryMemory({ scopes: q.scope ? [q.scope] : [...MEMORY_SCOPES], text: q.q, includeStatuses: [...statuses], limit: 100 });
  });

  app.post("/api/memory", can("memory:write"), async (req) => {
    const body = z
      .object({ scope: z.enum(MEMORY_SCOPES), title: z.string().min(2).max(300), content: z.string().min(1).max(50_000), source: z.string().min(1).max(500), tags: z.array(z.string().max(40)).max(20).optional(), key: z.string().max(200).optional(), scopeRef: z.string().max(100).optional() })
      .parse(req.body);
    // Entries the CEO writes are verified; other staff record unverified claims.
    const actor = me(req).role === "ceo" ? ceoActor(req) : { type: "system" as const, id: me(req).id };
    return company.memory.write(actor, { ...body, sourceType: me(req).role === "ceo" ? "ceo" : "system" });
  });

  app.get("/api/memory/history/:key", can("read"), async (req) => company.memory.history(ceoActor(req), (req.params as { key: string }).key));

  app.post("/api/memory/:id/status", can("memory:admin"), async (req) => {
    const body = z.object({ status: z.enum(["archived", "deleted", "current"]) }).parse(req.body);
    await company.memory.setStatus(ceoActor(req), (req.params as { id: string }).id, body.status);
    return { ok: true };
  });

  app.get("/api/documents", can("read"), async (req) => documents.list((req.query as { q?: string }).q?.slice(0, 200)));
  app.get("/api/documents/:id", can("read"), async (req) => documents.versions((req.params as { id: string }).id));
  app.post("/api/documents", can("memory:write"), async (req) => {
    const body = z.object({ id: z.string().max(40).optional(), title: z.string().min(2).max(200), kind: z.string().max(40), body: z.string().min(1).max(200_000) }).parse(req.body);
    const r = await documents.create({ ...body, author: me(req).id });
    await audit(me(req), "document.save", r.id, { version: r.version });
    return r;
  });

  app.get("/api/outbox", can("read"), async () => outbox.list());

  // ---------------- settings, secrets, audit ----------------
  app.get("/api/settings", can("read"), async () => ({
    models: await settings.get("models"),
    company: await settings.get("company"),
    policies: await settings.get("policies"),
    activeProviders: company.router.availableProviders(),
    canStoreSecrets: secrets.canStore,
  }));

  app.put("/api/settings/models", can("settings:write"), async (req) => {
    const v = ModelsSchema.parse(req.body);
    await settings.set("models", v as never);
    await reloadModels();
    await audit(me(req), "settings.models", null, { providers: v.providers.map((p) => p.id), profiles: v.profiles.map((p) => `${p.id}=${p.provider}/${p.model}`) });
    return { ok: true, activeProviders: company.router.availableProviders() };
  });
  app.put("/api/settings/company", can("settings:write"), async (req) => {
    const v = CompanySchema.parse(req.body);
    await settings.set("company", v);
    await audit(me(req), "settings.company", null);
    return v;
  });
  app.put("/api/settings/policies", can("settings:write"), async (req) => {
    const v = PoliciesSchema.parse(req.body);
    await settings.set("policies", v);
    await audit(me(req), "settings.policies", null, v as unknown as Record<string, unknown>);
    return v;
  });

  app.get("/api/secrets", can("read"), async () => {
    const m = await settings.get("models");
    return secrets.list(m.providers.map((p) => p.apiKeySecret).filter((x): x is string => !!x));
  });
  app.put("/api/secrets/:name", can("secrets:write"), async (req) => {
    const { name } = req.params as { name: string };
    const { value } = z.object({ value: z.string().min(8).max(4000) }).parse(req.body);
    await secrets.set(name, value, me(req).id);
    await reloadModels();
    await audit(me(req), "secret.set", name);
    return { ok: true };
  });
  app.delete("/api/secrets/:name", can("secrets:write"), async (req) => {
    const { name } = req.params as { name: string };
    await secrets.delete(name);
    await reloadModels();
    await audit(me(req), "secret.delete", name);
    return { ok: true };
  });

  app.get("/api/audit", can("read"), async (req) => store.listAudit({ limit: Math.min(Number((req.query as { limit?: string }).limit ?? 200), 1000) }));

  // ---------------- live events (SSE) ----------------
  app.get("/api/events/stream", can("read"), async (req, reply) => {
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (type: string, data: unknown) => reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const onEvent = (e: TaskEvent) => send("task", { id: e.id, type: e.type, taskId: e.taskId, rootId: e.rootId, agentId: e.agentId, at: e.at });
    const onApproval = (a: { id: string }) => send("approval", { id: a.id });
    company.orchestrator.events.on("event", onEvent);
    company.orchestrator.events.on("approval", onApproval);
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      company.orchestrator.events.off("event", onEvent);
      company.orchestrator.events.off("approval", onApproval);
    });
    send("hello", { ok: true });
    return reply;
  });

  // ---------------- dashboard ----------------
  if (cfg.staticDir && existsSync(cfg.staticDir)) {
    await app.register(fastifyStatic, { root: cfg.staticDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "not found" }) : reply.sendFile("index.html")));
  }

  return { app: app as FastifyInstance, company, store, settings, secrets, outbox, documents };
}
