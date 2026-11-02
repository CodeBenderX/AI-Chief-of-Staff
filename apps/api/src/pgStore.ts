import { tokenize, type AgentDefinition, type ApprovalRequest, type AuditEntry, type MemoryEntry, type Store, type TaskEvent, type TaskRecord, type UsageRecord } from "@aicos/core";
import type { Db } from "./db.js";

type DocRow<T> = { doc: T };
const docs = <T>(rows: DocRow<T>[]) => rows.map((r) => r.doc);
const j = (v: unknown) => JSON.stringify(v);

/** PostgreSQL implementation of the core Store port. */
export class PgStore implements Store {
  constructor(private db: Db) {}

  async listAgents() {
    return docs(await this.db.query<DocRow<AgentDefinition>>(`SELECT doc FROM agents ORDER BY doc->>'department', id`));
  }
  async getAgent(id: string) {
    return (await this.db.query<DocRow<AgentDefinition>>(`SELECT doc FROM agents WHERE id=$1`, [id]))[0]?.doc ?? null;
  }
  async upsertAgent(a: AgentDefinition) {
    await this.db.query(`INSERT INTO agents (id, doc) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET doc=EXCLUDED.doc, updated_at=now()`, [a.id, j(a)]);
  }

  async createTask(t: TaskRecord) {
    await this.db.query(`INSERT INTO tasks (id, root_id, parent_id, agent_id, status, created_at, doc) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [t.id, t.rootId, t.parentId, t.agentId, t.status, t.createdAt, j(t)]);
  }
  async updateTask(id: string, patch: Partial<TaskRecord>) {
    const updatedAt = new Date().toISOString();
    const rows = await this.db.query<DocRow<TaskRecord>>(
      `UPDATE tasks SET doc = doc || $2::jsonb, status = COALESCE($3, status) WHERE id=$1 RETURNING doc`,
      [id, j({ ...patch, updatedAt }), patch.status ?? null],
    );
    if (!rows[0]) throw new Error(`task ${id} not found`);
    return rows[0].doc;
  }
  async getTask(id: string) {
    return (await this.db.query<DocRow<TaskRecord>>(`SELECT doc FROM tasks WHERE id=$1`, [id]))[0]?.doc ?? null;
  }
  async listTasks(f: { rootId?: string; status?: string; agentId?: string; limit?: number } = {}) {
    return docs(
      await this.db.query<DocRow<TaskRecord>>(
        `SELECT doc FROM tasks WHERE ($1::text IS NULL OR root_id=$1) AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR agent_id=$3) ORDER BY created_at DESC LIMIT $4`,
        [f.rootId ?? null, f.status ?? null, f.agentId ?? null, f.limit ?? 500],
      ),
    );
  }

  async appendEvent(e: TaskEvent) {
    await this.db.query(`INSERT INTO task_events (id, task_id, root_id, type, at, doc) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [e.id, e.taskId, e.rootId, e.type, e.at, j(e)]);
  }
  async listEvents(f: { rootId?: string; taskId?: string; limit?: number }) {
    const rows = await this.db.query<DocRow<TaskEvent>>(
      `SELECT doc FROM (SELECT doc, seq FROM task_events WHERE ($1::text IS NULL OR root_id=$1) AND ($2::text IS NULL OR task_id=$2) ORDER BY seq DESC LIMIT $3) x ORDER BY seq ASC`,
      [f.rootId ?? null, f.taskId ?? null, f.limit ?? 1000],
    );
    return docs(rows);
  }

  async createApproval(a: ApprovalRequest) {
    await this.db.query(`INSERT INTO approvals (id, status, root_task_id, created_at, doc) VALUES ($1,$2,$3,$4,$5::jsonb)`, [a.id, a.status, a.rootTaskId, a.createdAt, j(a)]);
  }
  async getApproval(id: string) {
    return (await this.db.query<DocRow<ApprovalRequest>>(`SELECT doc FROM approvals WHERE id=$1`, [id]))[0]?.doc ?? null;
  }
  async updateApproval(id: string, patch: Partial<ApprovalRequest>) {
    const rows = await this.db.query<DocRow<ApprovalRequest>>(`UPDATE approvals SET doc = doc || $2::jsonb, status = COALESCE($3, status) WHERE id=$1 RETURNING doc`, [id, j(patch), patch.status ?? null]);
    if (!rows[0]) throw new Error(`approval ${id} not found`);
    return rows[0].doc;
  }
  /** Atomic: the WHERE status=$from makes concurrent double-approval / double-consume impossible. */
  async transitionApproval(id: string, from: ApprovalRequest["status"], patch: Partial<ApprovalRequest>) {
    const rows = await this.db.query<DocRow<ApprovalRequest>>(
      `UPDATE approvals SET doc = doc || $3::jsonb, status = COALESCE($4, status) WHERE id=$1 AND status=$2 RETURNING doc`,
      [id, from, j(patch), patch.status ?? null],
    );
    return rows[0]?.doc ?? null;
  }
  async listApprovals(f: { status?: string; rootTaskId?: string } = {}) {
    return docs(
      await this.db.query<DocRow<ApprovalRequest>>(
        `SELECT doc FROM approvals WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR root_task_id=$2) ORDER BY created_at DESC LIMIT 500`,
        [f.status ?? null, f.rootTaskId ?? null],
      ),
    );
  }

  async recordUsage(u: UsageRecord) {
    await this.db.query(`INSERT INTO usage (id, root_id, at, doc) VALUES ($1,$2,$3,$4::jsonb)`, [u.id, u.rootId, u.at, j(u)]);
  }
  async listUsage(f: { rootId?: string; since?: string } = {}) {
    return docs(
      await this.db.query<DocRow<UsageRecord>>(`SELECT doc FROM usage WHERE ($1::text IS NULL OR root_id=$1) AND ($2::timestamptz IS NULL OR at >= $2) ORDER BY at`, [f.rootId ?? null, f.since ?? null]),
    );
  }
  async appendAudit(a: AuditEntry) {
    await this.db.query(`INSERT INTO audit_log (id, actor_id, at, doc) VALUES ($1,$2,$3,$4::jsonb)`, [a.id, a.actorId, a.at, j(a)]);
  }
  async listAudit(f: { limit?: number; actorId?: string } = {}) {
    return docs(await this.db.query<DocRow<AuditEntry>>(`SELECT doc FROM audit_log WHERE ($1::text IS NULL OR actor_id=$1) ORDER BY seq DESC LIMIT $2`, [f.actorId ?? null, f.limit ?? 200]));
  }

  async insertMemory(m: MemoryEntry) {
    await this.db.query(
      `INSERT INTO memory (id, key, scope, scope_ref, status, version, created_at, search, doc) VALUES ($1,$2,$3,$4,$5,$6,$7, to_tsvector('english', $8), $9::jsonb)`,
      [m.id, m.key, m.scope, m.scopeRef, m.status, m.version, m.createdAt, `${m.title} ${m.content} ${m.tags.join(" ")}`, j(m)],
    );
  }
  async updateMemoryStatus(id: string, status: MemoryEntry["status"]) {
    await this.db.query(`UPDATE memory SET status=$2, doc = jsonb_set(doc, '{status}', to_jsonb($2::text)) WHERE id=$1`, [id, status]);
  }
  async getMemory(id: string) {
    return (await this.db.query<DocRow<MemoryEntry>>(`SELECT doc FROM memory WHERE id=$1`, [id]))[0]?.doc ?? null;
  }
  async memoryVersions(key: string) {
    return docs(await this.db.query<DocRow<MemoryEntry>>(`SELECT doc FROM memory WHERE key=$1 ORDER BY version`, [key]));
  }
  async queryMemory(f: { scopes: string[]; scopeRef?: string | null; text?: string; includeStatuses?: MemoryEntry["status"][]; limit?: number }) {
    const statuses = f.includeStatuses ?? ["current", "conflict"];
    const terms = f.text ? [...new Set(tokenize(f.text))].slice(0, 24) : [];
    const tsq = terms.map((t) => `${t}:*`).join(" | ");
    const rows = await this.db.query<DocRow<MemoryEntry>>(
      `SELECT doc FROM memory
       WHERE scope = ANY($1::text[]) AND status = ANY($2::text[])
         AND ($3::text IS NULL OR scope_ref IS NULL OR scope_ref = $3)
         AND ($4::text = '' OR search @@ to_tsquery('english', $4))
       ORDER BY CASE WHEN $4::text = '' THEN 0 ELSE ts_rank(search, to_tsquery('english', $4)) END DESC, created_at DESC
       LIMIT $5`,
      [f.scopes, statuses, f.scopeRef ?? null, tsq, f.limit ?? 20],
    );
    return docs(rows);
  }
}
