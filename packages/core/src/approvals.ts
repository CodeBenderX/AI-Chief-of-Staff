import type { AuditLog } from "./audit.js";
import type { Store } from "./store.js";
import type { ApprovalRequest, RiskLevel, SensitiveAction } from "./types.js";
import { actionHash, newId, nowIso } from "./util.js";

export const APPROVAL_TTL_MS = 72 * 3600_000;

const RISK_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];
const ACTION_RISK: Record<SensitiveAction, RiskLevel> = {
  external_communication: "medium",
  publish_content: "medium",
  spend_money: "high",
  production_deploy: "high",
  production_data_change: "high",
  delete_important_data: "critical",
  security_policy_change: "critical",
  access_permission_change: "critical",
  sign_agreement: "critical",
  irreversible_decision: "critical",
};

export function assessRisk(base: RiskLevel, actions: SensitiveAction[]): { risk: RiskLevel; summary: string } {
  let idx = RISK_ORDER.indexOf(base);
  for (const a of actions) idx = Math.max(idx, RISK_ORDER.indexOf(ACTION_RISK[a]));
  const risk = RISK_ORDER[idx] ?? "high";
  const summary = actions.length
    ? `Performs: ${actions.map((a) => a.replace(/_/g, " ")).join(", ")}. Risk rated ${risk}.`
    : `External/production action. Risk rated ${risk}.`;
  return { risk, summary };
}

export type Decision = "approved" | "rejected" | "changes_requested";

/**
 * Action-specific approvals. An approval unlocks exactly one execution of one
 * tool with one input (matched by hash). Silence never approves: pending
 * requests expire after APPROVAL_TTL_MS and are treated as rejected.
 */
export class ApprovalService {
  constructor(private store: Store, private audit: AuditLog) {}

  async request(params: {
    taskId: string;
    rootTaskId: string;
    agentId: string;
    toolId: string;
    input: unknown;
    actions: SensitiveAction[];
    baseRisk: RiskLevel;
    estimatedCostUsd: number;
    justification: string;
  }): Promise<ApprovalRequest> {
    const { risk, summary } = assessRisk(params.baseRisk, params.actions);
    const now = Date.now();
    const req: ApprovalRequest = {
      id: newId("apr"),
      taskId: params.taskId,
      rootTaskId: params.rootTaskId,
      agentId: params.agentId,
      toolId: params.toolId,
      input: params.input,
      actionHash: actionHash(params.toolId, params.input),
      actions: params.actions,
      risk,
      riskSummary: summary,
      estimatedCostUsd: params.estimatedCostUsd,
      justification: params.justification.slice(0, 2000),
      status: "pending",
      decidedBy: null,
      decisionNote: null,
      createdAt: new Date(now).toISOString(),
      decidedAt: null,
      expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
    };
    await this.store.createApproval(req);
    await this.audit.write({
      actorType: "agent",
      actorId: params.agentId,
      action: "approval.requested",
      target: req.id,
      outcome: "pending",
      detail: { toolId: params.toolId, actions: params.actions, risk },
    });
    return req;
  }

  /** CEO decision. Caller (API) must have verified the user holds the `approvals:decide` permission. */
  async decide(id: string, decision: Decision, userId: string, note?: string): Promise<ApprovalRequest> {
    const current = await this.store.getApproval(id);
    if (!current) throw new Error("approval not found");
    if (current.status === "pending" && Date.parse(current.expiresAt) < Date.now()) {
      await this.store.transitionApproval(id, "pending", { status: "expired" });
      throw new Error("approval request has expired");
    }
    const updated = await this.store.transitionApproval(id, "pending", {
      status: decision,
      decidedBy: userId,
      decisionNote: note ?? null,
      decidedAt: nowIso(),
    });
    if (!updated) throw new Error(`approval is ${current.status}, not pending`);
    await this.audit.write({
      actorType: "user",
      actorId: userId,
      action: `approval.${decision}`,
      target: id,
      outcome: "ok",
      detail: { toolId: current.toolId, actionHash: current.actionHash, note },
    });
    return updated;
  }

  /**
   * Atomically consume an approval for execution. Fails unless the approval is
   * approved, unexpired and covers exactly this tool + input.
   */
  async consume(id: string, toolId: string, input: unknown): Promise<ApprovalRequest> {
    const a = await this.store.getApproval(id);
    if (!a) throw new Error("approval not found");
    if (a.actionHash !== actionHash(toolId, input)) throw new Error("approval does not cover this exact action");
    if (Date.parse(a.expiresAt) < Date.now()) throw new Error("approval has expired");
    const consumed = await this.store.transitionApproval(id, "approved", { status: "consumed" });
    if (!consumed) throw new Error(`approval is ${a.status}; cannot execute`);
    return consumed;
  }

  async expireStale(): Promise<number> {
    const pending = await this.store.listApprovals({ status: "pending" });
    let n = 0;
    for (const a of pending) {
      if (Date.parse(a.expiresAt) < Date.now()) {
        if (await this.store.transitionApproval(a.id, "pending", { status: "expired" })) n++;
      }
    }
    return n;
  }
}
