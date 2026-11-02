import { z } from "zod";
import type { ApprovalService } from "../approvals.js";
import type { AuditLog } from "../audit.js";
import type { PolicyEngine } from "../policy.js";
import type { AgentDefinition, ApprovalRequest, TaskRecord } from "../types.js";
import { withTimeout } from "../util.js";
import type { ToolDefinition, ToolServices } from "./types.js";

/** Central registry. Agents only ever see tools that are registered here AND assigned to them. */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.id)) throw new Error(`tool ${tool.id} already registered`);
    this.tools.set(tool.id, tool);
    return this;
  }
  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }
  /** Tools the given agent may see. Unassigned or unknown ids are dropped. */
  forAgent(agent: AgentDefinition): ToolDefinition[] {
    return agent.tools.map((id) => this.tools.get(id)).filter((t): t is ToolDefinition => !!t);
  }
  /** JSON-schema description suitable for model tool-calling. */
  describe(tool: ToolDefinition): { name: string; description: string; inputSchema: Record<string, unknown> } {
    return {
      name: toModelName(tool.id),
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown>,
    };
  }
  fromModelName(name: string): ToolDefinition | undefined {
    return this.tools.get(name.replace(/__/g, "."));
  }
  catalog() {
    return this.list().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      level: t.level,
      risk: t.risk,
      actions: t.actions,
      limits: t.limits,
      inputSchema: z.toJSONSchema(t.input),
      outputSchema: z.toJSONSchema(t.output),
    }));
  }
}

/** Model APIs restrict tool names to [a-zA-Z0-9_-]. */
export const toModelName = (id: string) => id.replace(/\./g, "__");

export type ToolResult =
  | { status: "ok"; output: unknown }
  | { status: "denied"; reason: string }
  | { status: "needs_approval"; approval: ApprovalRequest }
  | { status: "error"; error: string };

export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private policy: PolicyEngine,
    private approvals: ApprovalService,
    private audit: AuditLog,
    private services: ToolServices,
  ) {}

  async run(params: {
    agent: AgentDefinition;
    task: TaskRecord;
    toolId: string;
    input: unknown;
    signal: AbortSignal;
    justification?: string;
    /** Set when resuming after CEO approval. */
    approvalId?: string;
    /** Per-call services (e.g. delegation bound to the calling task). */
    services?: Partial<ToolServices>;
  }): Promise<ToolResult> {
    const { agent, task, toolId, input } = params;
    const tool = this.registry.get(toolId);
    const decision = this.policy.evaluate(agent, task, tool, input);

    if (decision.kind === "deny" || !tool) {
      const reason = decision.kind === "deny" ? decision.reason : "unknown tool";
      await this.audit.write({ actorType: "agent", actorId: agent.id, action: `tool.${toolId}`, target: task.id, outcome: "denied", detail: { reason } });
      return { status: "denied", reason };
    }

    const parsed = tool.input.safeParse(input);
    if (!parsed.success) {
      const error = `invalid input: ${z.prettifyError(parsed.error)}`;
      await this.audit.write({ actorType: "agent", actorId: agent.id, action: `tool.${toolId}`, target: task.id, outcome: "error", detail: { error } });
      return { status: "error", error };
    }

    const services = { ...this.services, ...params.services };
    if (services.preflight) {
      const refusal = await services.preflight({ toolId, input: parsed.data, agentId: agent.id, taskId: task.id });
      if (refusal) {
        await this.audit.write({ actorType: "agent", actorId: agent.id, action: `tool.${toolId}`, target: task.id, outcome: "denied", detail: { reason: refusal, preflight: true } });
        return { status: "denied", reason: refusal };
      }
    }

    if (decision.kind === "requires_approval") {
      if (!params.approvalId) {
        const approval = await this.approvals.request({
          taskId: task.id,
          rootTaskId: task.rootId,
          agentId: agent.id,
          toolId,
          input: parsed.data,
          actions: decision.actions,
          baseRisk: tool.risk,
          estimatedCostUsd: tool.estimateCostUsd?.(parsed.data) ?? 0,
          justification: params.justification ?? task.title,
        });
        return { status: "needs_approval", approval };
      }
      try {
        await this.approvals.consume(params.approvalId, toolId, parsed.data);
      } catch (e) {
        const reason = (e as Error).message;
        await this.audit.write({ actorType: "agent", actorId: agent.id, action: `tool.${toolId}`, target: task.id, outcome: "denied", detail: { reason, approvalId: params.approvalId } });
        return { status: "denied", reason };
      }
    }

    try {
      const raw = await withTimeout(
        tool.execute({ agent, task, signal: params.signal, services }, parsed.data),
        tool.limits.timeoutMs,
        `tool ${toolId}`,
      );
      const out = tool.output.safeParse(raw);
      if (!out.success) throw new Error(`tool returned invalid output: ${z.prettifyError(out.error)}`);
      await this.audit.write({
        actorType: "agent",
        actorId: agent.id,
        action: `tool.${toolId}`,
        target: task.id,
        outcome: "ok",
        detail: { input: parsed.data, approvalId: params.approvalId ?? null },
      });
      return { status: "ok", output: out.data };
    } catch (e) {
      const error = (e as Error).message;
      await this.audit.write({ actorType: "agent", actorId: agent.id, action: `tool.${toolId}`, target: task.id, outcome: "error", detail: { error } });
      return { status: "error", error };
    }
  }
}
