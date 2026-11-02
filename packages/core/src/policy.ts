import type { ToolDefinition } from "./tools/types.js";
import { AutonomyLevel, type AgentDefinition, type SensitiveAction, type TaskRecord } from "./types.js";

export type PolicyDecision =
  | { kind: "allow"; effectiveLevel: AutonomyLevel }
  | { kind: "requires_approval"; actions: SensitiveAction[]; reason: string }
  | { kind: "deny"; reason: string };

/**
 * Backend enforcement of agent permissions. The model never decides whether it
 * may act: every tool call passes through `evaluate` before execution.
 *
 * Rules:
 *  1. Agent must be active.
 *  2. Tool must be registered AND explicitly assigned to the agent.
 *  3. Tool level must be <= min(agent.maxAutonomy, task.autonomyCap).
 *  4. Any Level 3 tool or any sensitive action needs a CEO approval for this exact action.
 *     This is independent of which agent asks or how the task was delegated, so
 *     delegation can never route around an approval.
 */
export class PolicyEngine {
  effectiveLevel(agent: AgentDefinition, task: TaskRecord): AutonomyLevel {
    return Math.min(agent.maxAutonomy, task.autonomyCap) as AutonomyLevel;
  }

  evaluate(agent: AgentDefinition, task: TaskRecord, tool: ToolDefinition | undefined, input: unknown): PolicyDecision {
    if (agent.status !== "active") return { kind: "deny", reason: `agent ${agent.id} is ${agent.status}` };
    if (!tool) return { kind: "deny", reason: "tool is not registered" };
    if (!agent.tools.includes(tool.id)) {
      return { kind: "deny", reason: `tool ${tool.id} is not assigned to agent ${agent.id}` };
    }
    const level = this.effectiveLevel(agent, task);
    if (tool.level > level) {
      return {
        kind: "deny",
        reason: `tool ${tool.id} needs autonomy level ${tool.level}; agent ${agent.id} is limited to ${level} on this task`,
      };
    }
    const actions = new Set<SensitiveAction>(tool.actions);
    try {
      for (const a of tool.classify?.(input as never) ?? []) actions.add(a);
    } catch {
      // classification on malformed input: input validation will reject it later
    }
    if (tool.level >= AutonomyLevel.External || actions.size > 0) {
      return {
        kind: "requires_approval",
        actions: [...actions],
        reason:
          actions.size > 0
            ? `action requires CEO approval: ${[...actions].join(", ")}`
            : "Level 3 (external/production) action requires CEO approval",
      };
    }
    return { kind: "allow", effectiveLevel: level };
  }
}
