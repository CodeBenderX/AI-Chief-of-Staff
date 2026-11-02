import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";

/** Minimal query port so production (PostgreSQL) and tests (PGlite) share one code path. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export class PgDb implements Db {
  private pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(sql, params);
    return r.rows as T[];
  }
  async close() {
    await this.pool.end();
  }
}

export async function createPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  // PGlite creates its own folder but not missing parents (e.g. ./data on a fresh clone).
  if (dataDir) mkdirSync(dirname(dataDir), { recursive: true });
  const db = new PGlite(dataDir);
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await db.query(sql, params);
      return r.rows as T[];
    },
    async close() {
      await db.close();
    },
  };
}

export async function connect(url: string | undefined): Promise<Db> {
  if (url && /^postgres(ql)?:\/\//.test(url)) return new PgDb(url);
  // Development fallback: embedded Postgres (PGlite) on disk or in memory.
  return createPglite(url?.startsWith("pglite:") ? url.slice(7) || undefined : undefined);
}

const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: "001_init",
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ceo','admin','viewer')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  parent_id TEXT,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  doc JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_root ON tasks(root_id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_agent ON tasks(agent_id);
CREATE TABLE IF NOT EXISTS task_events (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,
  task_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  doc JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS events_root ON task_events(root_id);
CREATE INDEX IF NOT EXISTS events_task ON task_events(task_id);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  root_task_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  doc JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status);
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  root_id TEXT,
  at TIMESTAMPTZ NOT NULL,
  doc JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_root ON usage(root_id);
CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
CREATE TABLE IF NOT EXISTS audit_log (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,
  actor_id TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  doc JSONB NOT NULL
);
-- The audit log is append-only: updates and deletes are rejected by the database.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_ref TEXT,
  status TEXT NOT NULL,
  version INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  search TSVECTOR NOT NULL,
  doc JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_key ON memory(key);
CREATE INDEX IF NOT EXISTS memory_scope ON memory(scope, status);
CREATE INDEX IF NOT EXISTS memory_search ON memory USING GIN(search);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT NOT NULL,
  version INT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  last4 TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];

MIGRATIONS.push({
  id: "002_outbox_delivery",
  sql: `
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS detail TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS task_id TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS agent_id TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS outbox_sent ON outbox(channel, status, sent_at);
`,
});

MIGRATIONS.push({
  id: "003_leads",
  sql: `
CREATE TABLE IF NOT EXISTS lead_runs (
  id TEXT PRIMARY KEY,
  niche TEXT NOT NULL,
  area TEXT NOT NULL,
  requested INT NOT NULL,
  status TEXT NOT NULL,
  searches INT NOT NULL DEFAULT 0,
  checked INT NOT NULL DEFAULT 0,
  qualified INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  message TEXT,
  started_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  domain TEXT UNIQUE NOT NULL,
  business_name TEXT NOT NULL,
  website TEXT NOT NULL,
  niche TEXT,
  area TEXT,
  status TEXT NOT NULL,
  score INT NOT NULL DEFAULT 0,
  audit JSONB,
  contact_email TEXT,
  contact_source TEXT,
  contact_found_at TIMESTAMPTZ,
  notes TEXT NOT NULL DEFAULT '',
  run_id TEXT,
  draft_task_id TEXT,
  contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS leads_email ON leads(lower(contact_email));
CREATE TABLE IF NOT EXISTS suppression (
  value TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  reason TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS search_usage (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS search_usage_at ON search_usage(at);
`,
});

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ id: string }>(`SELECT id FROM schema_migrations`)).map((r) => r.id));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    // Split on statement boundaries outside $$ bodies.
    for (const stmt of splitSql(m.sql)) await db.query(stmt);
    await db.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [m.id]);
    applied.push(m.id);
  }
  return applied;
}

function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  for (const line of sql.split("\n")) {
    if (line.trim().startsWith("--")) continue;
    const dollars = (line.match(/\$\$/g) ?? []).length;
    if (dollars % 2 === 1) inDollar = !inDollar;
    cur += line + "\n";
    if (!inDollar && line.trim().endsWith(";")) {
      out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
