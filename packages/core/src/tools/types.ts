import type { z } from "zod";
import type { AgentDefinition, AutonomyLevel, RiskLevel, SensitiveAction, TaskRecord } from "../types.js";

export interface ToolContext {
  agent: AgentDefinition;
  task: TaskRecord;
  signal: AbortSignal;
  /** Services the tool may use. Credentials are injected here, never shown to the model. */
  services: ToolServices;
}

/** Narrow service surface handed to tools. Filled in by the host (API). */
export interface ToolServices {
  memory?: import("../memory.js").MemoryService;
  /** Request a delegated subtask. Implemented by the orchestrator so limits are enforced centrally. */
  delegate?: (req: { agentId: string; title: string; instructions: string }) => Promise<{ taskId: string; result: string }>;
  sandbox?: import("../sandbox.js").Sandbox;
  outbox?: Outbox;
  documents?: DocumentStore;
  fetch?: typeof fetch;
  search?: import("../search.js").SearchProvider;
  /**
   * Host-defined checks before an action is executed or sent for approval
   * (e.g. outreach compliance, do-not-contact list). Return a reason to refuse.
   */
  preflight?: (req: { toolId: string; input: unknown; agentId: string; taskId: string }) => Promise<string | null>;
}

export interface Outbox {
  /** Queues an outbound message via the configured connector. */
  /**
   * Called only after policy + CEO approval. Returns the real delivery outcome:
   * "sent", "failed" (with detail), or "queued_no_connector".
   */
  send(
    msg: { channel: string; to: string; subject?: string; body: string },
    meta?: { taskId?: string; agentId?: string },
  ): Promise<{ id: string; status: string; detail?: string }>;
}

export interface DocumentStore {
  create(doc: { title: string; kind: string; body: string; author: string }): Promise<{ id: string; version: number }>;
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  id: string;
  name: string;
  description: string;
  input: I;
  output: O;
  /** Minimum autonomy level an agent needs to call this tool at all. */
  level: AutonomyLevel;
  risk: RiskLevel;
  /** Sensitive actions this tool always performs. */
  actions: SensitiveAction[];
  /** Extra sensitive actions derived from the concrete input (e.g. a production target). */
  classify?(input: z.infer<I>): SensitiveAction[];
  limits: { timeoutMs: number; maxCallsPerTask: number };
  /** Estimated USD cost of executing (for approval cards). */
  estimateCostUsd?(input: z.infer<I>): number;
  execute(ctx: ToolContext, input: z.infer<I>): Promise<z.infer<O>>;
}

/** Typed helper: infers input/output types from the zod schemas. */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: ToolDefinition<I, O>): ToolDefinition {
  return def as unknown as ToolDefinition;
}
