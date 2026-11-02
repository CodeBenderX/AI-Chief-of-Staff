import { ApprovalService } from "./approvals.js";
import { AuditLog } from "./audit.js";
import { DEFAULT_AGENTS } from "./agents.js";
import { MemoryService } from "./memory.js";
import { Orchestrator } from "./orchestrator.js";
import { PolicyEngine } from "./policy.js";
import { ModelRouter, type UsageSink } from "./providers/router.js";
import type { Store } from "./store.js";
import { BUILTIN_TOOLS } from "./tools/builtin.js";
import { ToolExecutor, ToolRegistry } from "./tools/registry.js";
import type { ToolDefinition, ToolServices } from "./tools/types.js";
import { newId, nowIso } from "./util.js";

/** Wires the whole engine together around one Store. Used by the API and by tests. */
export function createCompany(opts: { store: Store; services?: ToolServices; extraTools?: ToolDefinition[]; usageSink?: UsageSink }) {
  const { store } = opts;
  const audit = new AuditLog(store);
  const policy = new PolicyEngine();
  const approvals = new ApprovalService(store, audit);
  const memory = new MemoryService(store, audit);
  const tools = new ToolRegistry();
  for (const t of [...BUILTIN_TOOLS, ...(opts.extraTools ?? [])]) tools.register(t);
  const router = new ModelRouter(
    opts.usageSink ??
      (async (u) => {
        await store.recordUsage({
          id: newId("use"),
          taskId: u.meta.taskId ?? null,
          rootId: u.meta.rootId ?? null,
          agentId: u.meta.agentId ?? null,
          provider: u.provider,
          model: u.model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          costUsd: u.costUsd,
          latencyMs: u.latencyMs,
          ok: u.ok,
          at: nowIso(),
        });
      }),
  );
  const executor = new ToolExecutor(tools, policy, approvals, audit, { memory, ...opts.services });
  const orchestrator = new Orchestrator({ store, router, tools, executor, memory, audit });
  return { store, audit, policy, approvals, memory, tools, router, executor, orchestrator };
}
export type Company = ReturnType<typeof createCompany>;

export async function seedAgents(store: Store, overwrite = false) {
  for (const a of DEFAULT_AGENTS) {
    if (overwrite || !(await store.getAgent(a.id))) await store.upsertAgent(a);
  }
}
