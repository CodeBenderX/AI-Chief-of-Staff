/**
 * Shared domain types for the AI Company Operating System.
 *
 * Security-relevant concepts (autonomy levels, sensitive action kinds,
 * approvals) live here so every layer uses the same vocabulary.
 */

/** Autonomous execution levels, enforced by the PolicyEngine (not by prompts). */
export enum AutonomyLevel {
  /** Read-only access and analysis. */
  ReadOnly = 0,
  /** Internal drafts and recommendations. */
  Draft = 1,
  /** Authorized internal modifications and development work. */
  InternalWrite = 2,
  /** External or production actions — always require explicit CEO approval. */
  External = 3,
}

/**
 * Action kinds that ALWAYS require an action-specific CEO approval, no matter
 * which agent asks, which level it holds, or how the request was delegated.
 */
export const SENSITIVE_ACTIONS = [
  "external_communication",
  "publish_content",
  "spend_money",
  "production_deploy",
  "production_data_change",
  "delete_important_data",
  "security_policy_change",
  "access_permission_change",
  "sign_agreement",
  "irreversible_decision",
] as const;
export type SensitiveAction = (typeof SENSITIVE_ACTIONS)[number];

export type RiskLevel = "low" | "medium" | "high" | "critical";

export const MEMORY_SCOPES = [
  "conversation",
  "task",
  "agent",
  "company",
  "project",
  "decision",
  "organizational",
] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export type AgentStatus = "active" | "paused" | "deactivated";

export interface ModelSelection {
  /** Model profile id from the model registry (e.g. "default", "fast", "local-llama"). */
  profile: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface MemoryAccess {
  read: MemoryScope[];
  write: MemoryScope[];
}

export interface AgentDefinition {
  id: string;
  name: string;
  department: string;
  role: string;
  systemPrompt: string;
  responsibilities: string[];
  capabilities: string[];
  /** Highest autonomy level this agent may ever act at. */
  maxAutonomy: AutonomyLevel;
  /** Tool ids explicitly assigned. Agents get nothing by default. */
  tools: string[];
  memoryAccess: MemoryAccess;
  model: ModelSelection;
  status: AgentStatus;
  /** Only orchestrator-type agents may decompose objectives into plans. */
  canOrchestrate?: boolean;
}

export type TaskStatus =
  | "pending"
  | "blocked"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "escalated";

export const TERMINAL_STATUSES: TaskStatus[] = ["completed", "failed", "cancelled", "escalated"];

export type Priority = "low" | "normal" | "high" | "urgent";

export interface ExecutionLimits {
  /** Max delegation depth (root = 0). Prevents recursive delegation. */
  maxDepth: number;
  /** Max subtasks created anywhere in one task tree. */
  maxSubtasks: number;
  /** Max model calls across the whole tree. */
  maxModelCalls: number;
  /** Max tool calls across the whole tree. */
  maxToolCalls: number;
  /** Max agent loop steps for a single task. */
  maxStepsPerTask: number;
  /** Max total tokens (input + output) across the tree. */
  maxTokens: number;
  /** Max estimated spend in USD across the tree. */
  maxCostUsd: number;
  /** Max wall clock for the tree, ms. */
  maxWallMs: number;
  /** Retries per failed task before escalation. */
  maxRetries: number;
  /** Identical tool call (same tool + same input) allowed this many times per task. */
  maxIdenticalToolCalls: number;
  /** Parallel subtasks at once. */
  concurrency: number;
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  maxDepth: 2,
  maxSubtasks: 12,
  maxModelCalls: 60,
  maxToolCalls: 80,
  maxStepsPerTask: 8,
  maxTokens: 400_000,
  maxCostUsd: 5,
  maxWallMs: 15 * 60_000,
  maxRetries: 1,
  maxIdenticalToolCalls: 2,
  concurrency: 3,
};

export interface TaskRecord {
  id: string;
  rootId: string;
  parentId: string | null;
  title: string;
  instructions: string;
  agentId: string;
  status: TaskStatus;
  priority: Priority;
  depth: number;
  /** Agent ids from root to this task — used to block recursive delegation and to cap autonomy. */
  delegationChain: string[];
  dependsOn: string[];
  /** CEO-set ceiling for this task tree; inherited by every subtask, can only go down. */
  autonomyCap: AutonomyLevel;
  limits: ExecutionLimits;
  attempts: number;
  result: string | null;
  error: string | null;
  /** Serialized agent conversation so a paused task can resume after approval. */
  state: AgentRunState | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentRunState {
  messages: ChatMessage[];
  steps: number;
  /** A tool call waiting for a CEO decision. */
  pendingToolCall?: ToolCall & { approvalId: string };
  toolCallCounts: Record<string, number>;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "changes_requested" | "expired" | "consumed";

export interface ApprovalRequest {
  id: string;
  taskId: string;
  rootTaskId: string;
  agentId: string;
  toolId: string;
  /** Exact input the agent wants to execute. Approval covers exactly this. */
  input: unknown;
  /** SHA-256 of tool id + canonical input. An approval can only unlock this exact action. */
  actionHash: string;
  actions: SensitiveAction[];
  risk: RiskLevel;
  riskSummary: string;
  estimatedCostUsd: number;
  justification: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  /** Set when the CEO edited the action before approving it: what the agent originally proposed. */
  originalInput?: unknown;
  editedBy?: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  rootId: string;
  type: string;
  agentId: string | null;
  data: Record<string, unknown>;
  at: string;
}

export interface UsageRecord {
  id: string;
  taskId: string | null;
  rootId: string | null;
  agentId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  at: string;
}

export interface AuditEntry {
  id: string;
  actorType: "user" | "agent" | "system";
  actorId: string;
  action: string;
  target: string | null;
  outcome: "allowed" | "denied" | "pending" | "error" | "ok";
  detail: Record<string, unknown>;
  at: string;
}

export type SourceType = "ceo" | "agent" | "tool" | "external" | "system";

export interface MemoryEntry {
  id: string;
  /** Stable logical key; all versions of one fact share it. */
  key: string;
  scope: MemoryScope;
  /** Optional reference within scope (task id, agent id, project id ...). */
  scopeRef: string | null;
  title: string;
  content: string;
  tags: string[];
  source: string;
  sourceType: SourceType;
  /** Verified facts were confirmed by the CEO or a trusted source; everything else is a claim. */
  verified: boolean;
  version: number;
  status: "current" | "superseded" | "conflict" | "archived" | "deleted";
  createdBy: string;
  createdAt: string;
}
