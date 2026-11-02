import type {
  AgentDefinition,
  ApprovalRequest,
  AuditEntry,
  MemoryEntry,
  TaskEvent,
  TaskRecord,
  UsageRecord,
} from "./types.js";

/**
 * Persistence port. The orchestrator, memory and approvals only talk to this
 * interface; the API implements it on PostgreSQL, tests use InMemoryStore.
 */
export interface Store {
  // agents
  listAgents(): Promise<AgentDefinition[]>;
  getAgent(id: string): Promise<AgentDefinition | null>;
  upsertAgent(agent: AgentDefinition): Promise<void>;

  // tasks
  createTask(task: TaskRecord): Promise<void>;
  updateTask(id: string, patch: Partial<TaskRecord>): Promise<TaskRecord>;
  getTask(id: string): Promise<TaskRecord | null>;
  listTasks(filter?: { rootId?: string; status?: string; agentId?: string; limit?: number }): Promise<TaskRecord[]>;

  // events (append-only execution history)
  appendEvent(e: TaskEvent): Promise<void>;
  listEvents(filter: { rootId?: string; taskId?: string; limit?: number }): Promise<TaskEvent[]>;

  // approvals
  createApproval(a: ApprovalRequest): Promise<void>;
  getApproval(id: string): Promise<ApprovalRequest | null>;
  updateApproval(id: string, patch: Partial<ApprovalRequest>): Promise<ApprovalRequest>;
  /** Atomic compare-and-set on status. Returns null if the approval was not in `from`. */
  transitionApproval(id: string, from: ApprovalRequest["status"], patch: Partial<ApprovalRequest>): Promise<ApprovalRequest | null>;
  listApprovals(filter?: { status?: string; rootTaskId?: string }): Promise<ApprovalRequest[]>;

  // usage + audit (append-only)
  recordUsage(u: UsageRecord): Promise<void>;
  listUsage(filter?: { rootId?: string; since?: string }): Promise<UsageRecord[]>;
  appendAudit(a: AuditEntry): Promise<void>;
  listAudit(filter?: { limit?: number; actorId?: string }): Promise<AuditEntry[]>;

  // memory
  insertMemory(m: MemoryEntry): Promise<void>;
  updateMemoryStatus(id: string, status: MemoryEntry["status"]): Promise<void>;
  getMemory(id: string): Promise<MemoryEntry | null>;
  memoryVersions(key: string): Promise<MemoryEntry[]>;
  queryMemory(filter: {
    scopes: string[];
    scopeRef?: string | null;
    text?: string;
    includeStatuses?: MemoryEntry["status"][];
    limit?: number;
  }): Promise<MemoryEntry[]>;
}

/** Process-local store for tests and quick local runs. Not durable. */
export class InMemoryStore implements Store {
  agents = new Map<string, AgentDefinition>();
  tasks = new Map<string, TaskRecord>();
  events: TaskEvent[] = [];
  approvals = new Map<string, ApprovalRequest>();
  usage: UsageRecord[] = [];
  audit: AuditEntry[] = [];
  memory: MemoryEntry[] = [];

  async listAgents() {
    return [...this.agents.values()];
  }
  async getAgent(id: string) {
    return this.agents.get(id) ?? null;
  }
  async upsertAgent(agent: AgentDefinition) {
    this.agents.set(agent.id, structuredClone(agent));
  }

  async createTask(task: TaskRecord) {
    this.tasks.set(task.id, structuredClone(task));
  }
  async updateTask(id: string, patch: Partial<TaskRecord>) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`task ${id} not found`);
    const next = { ...t, ...structuredClone(patch), updatedAt: new Date().toISOString() };
    this.tasks.set(id, next);
    return structuredClone(next);
  }
  async getTask(id: string) {
    const t = this.tasks.get(id);
    return t ? structuredClone(t) : null;
  }
  async listTasks(filter: { rootId?: string; status?: string; agentId?: string; limit?: number } = {}) {
    let out = [...this.tasks.values()];
    if (filter.rootId) out = out.filter((t) => t.rootId === filter.rootId);
    if (filter.status) out = out.filter((t) => t.status === filter.status);
    if (filter.agentId) out = out.filter((t) => t.agentId === filter.agentId);
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return structuredClone(out.slice(0, filter.limit ?? 500));
  }

  async appendEvent(e: TaskEvent) {
    this.events.push(structuredClone(e));
  }
  async listEvents(filter: { rootId?: string; taskId?: string; limit?: number }) {
    let out = this.events;
    if (filter.rootId) out = out.filter((e) => e.rootId === filter.rootId);
    if (filter.taskId) out = out.filter((e) => e.taskId === filter.taskId);
    return structuredClone(out.slice(-(filter.limit ?? 1000)));
  }

  async createApproval(a: ApprovalRequest) {
    this.approvals.set(a.id, structuredClone(a));
  }
  async getApproval(id: string) {
    const a = this.approvals.get(id);
    return a ? structuredClone(a) : null;
  }
  async updateApproval(id: string, patch: Partial<ApprovalRequest>) {
    const a = this.approvals.get(id);
    if (!a) throw new Error(`approval ${id} not found`);
    const next = { ...a, ...structuredClone(patch) };
    this.approvals.set(id, next);
    return structuredClone(next);
  }
  async transitionApproval(id: string, from: ApprovalRequest["status"], patch: Partial<ApprovalRequest>) {
    const a = this.approvals.get(id);
    if (!a || a.status !== from) return null;
    return this.updateApproval(id, patch);
  }
  async listApprovals(filter: { status?: string; rootTaskId?: string } = {}) {
    let out = [...this.approvals.values()];
    if (filter.status) out = out.filter((a) => a.status === filter.status);
    if (filter.rootTaskId) out = out.filter((a) => a.rootTaskId === filter.rootTaskId);
    return structuredClone(out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  async recordUsage(u: UsageRecord) {
    this.usage.push(structuredClone(u));
  }
  async listUsage(filter: { rootId?: string; since?: string } = {}) {
    let out = this.usage;
    if (filter.rootId) out = out.filter((u) => u.rootId === filter.rootId);
    if (filter.since) out = out.filter((u) => u.at >= filter.since!);
    return structuredClone(out);
  }
  async appendAudit(a: AuditEntry) {
    this.audit.push(structuredClone(a));
  }
  async listAudit(filter: { limit?: number; actorId?: string } = {}) {
    let out = this.audit;
    if (filter.actorId) out = out.filter((a) => a.actorId === filter.actorId);
    return structuredClone(out.slice(-(filter.limit ?? 200)).reverse());
  }

  async insertMemory(m: MemoryEntry) {
    this.memory.push(structuredClone(m));
  }
  async updateMemoryStatus(id: string, status: MemoryEntry["status"]) {
    const m = this.memory.find((x) => x.id === id);
    if (m) m.status = status;
  }
  async getMemory(id: string) {
    const m = this.memory.find((x) => x.id === id);
    return m ? structuredClone(m) : null;
  }
  async memoryVersions(key: string) {
    return structuredClone(this.memory.filter((m) => m.key === key).sort((a, b) => a.version - b.version));
  }
  async queryMemory(filter: {
    scopes: string[];
    scopeRef?: string | null;
    text?: string;
    includeStatuses?: MemoryEntry["status"][];
    limit?: number;
  }) {
    const statuses = filter.includeStatuses ?? ["current", "conflict"];
    let out = this.memory.filter((m) => filter.scopes.includes(m.scope) && statuses.includes(m.status));
    if (filter.scopeRef !== undefined && filter.scopeRef !== null) {
      out = out.filter((m) => m.scopeRef === null || m.scopeRef === filter.scopeRef);
    }
    if (filter.text) {
      const terms = tokenize(filter.text);
      const scored = out
        .map((m) => ({ m, s: score(terms, `${m.title} ${m.content} ${m.tags.join(" ")}`) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      out = scored.map((x) => x.m);
    } else {
      out = [...out].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return structuredClone(out.slice(0, filter.limit ?? 20));
  }
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "is", "are", "with", "our", "we"]);
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}
function score(terms: string[], doc: string): number {
  const words = tokenize(doc);
  if (!words.length) return 0;
  let s = 0;
  for (const t of terms) {
    const n = words.filter((w) => w === t || w.startsWith(t)).length;
    if (n) s += 1 + Math.log(1 + n);
  }
  return s;
}
