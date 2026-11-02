import { Link } from "react-router-dom";
import { fmtUsd, statusLabel, useApi, type TaskEvent } from "../api";
import { ErrorNote, PageHead } from "../ui";
import { Brief } from "./Tasks";

interface OverviewData {
  agents: { total: number; active: number };
  tasks: Record<string, number>;
  pendingApprovals: number;
  recentActivity: TaskEvent[];
  usage: { day: string; costUsd: number; tokens: number; calls: number }[];
  spend: { monthUsd: number; budgetUsd: number };
  health: { providers: string[]; failedModelCallsLastHour: number; sandbox: string };
}

const describe = (e: TaskEvent) => {
  const d = e.data;
  switch (e.type) {
    case "plan.created": return `Chief of Staff planned ${(d.subtasks as unknown[]).length} subtasks`;
    case "approval.requested": return `${e.agentId} asked for approval to run ${d.toolId}`;
    case "tool.called": return `${e.agentId} used ${d.toolId} (${d.status})`;
    case "model.called": return `${e.agentId} called ${d.model}`;
    case "task.created": return `New objective assigned to ${e.agentId}`;
    case "task.delegated": return `${d.from} delegated work to ${d.to}`;
    default: return `${e.agentId ?? "system"}: ${statusLabel(e.type.replace("task.", "task "))}`;
  }
};

export function Overview() {
  const { data, error } = useApi<OverviewData>("/overview");
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  const t = (s: string) => data.tasks[s] ?? 0;
  const maxCost = Math.max(...data.usage.map((u) => u.costUsd), 0.0001);
  const healthy = data.health.providers.length > 0 && data.health.failedModelCallsLastHour === 0;
  const realProviders = data.health.providers.filter((p) => p !== "mock");
  // Show what happened, not every model call or status flip.
  const activity = data.recentActivity.filter((e) => !["model.called", "task.running", "task.pending", "task.created", "memory.retrieved"].includes(e.type) || (e.type === "task.created" && !e.data.planKey)).slice(0, 14);
  return (
    <div className="stack">
      <PageHead title="Overview" sub={healthy ? "All systems working." : data.health.providers.length ? `${data.health.failedModelCallsLastHour} model calls failed in the last hour; work fell back to backup models where configured.` : "No model provider is reachable. Add one in Settings."} />

      <div className="strip" role="group" aria-label="Company status">
        <div className={data.pendingApprovals ? "attn" : ""}><b>{data.pendingApprovals}</b><span>Waiting for you</span></div>
        <div><b>{t("running") + t("pending")}</b><span>Running tasks</span></div>
        <div><b>{t("completed")}</b><span>Completed</span></div>
        <div><b>{t("failed") + t("escalated")}</b><span>Failed or escalated</span></div>
        <div><b>{data.agents.active}<span className="muted" style={{ fontSize: "1rem" }}>/{data.agents.total}</span></b><span>Active agents</span></div>
        <div><b>{fmtUsd(data.spend.monthUsd)}</b><span>AI spend this month of {fmtUsd(data.spend.budgetUsd)}</span></div>
      </div>

      {data.pendingApprovals > 0 && (
        <div className="note" style={{ background: "var(--authority-soft)", color: "var(--authority)" }}>
          {data.pendingApprovals} action{data.pendingApprovals > 1 ? "s are" : " is"} paused until you decide. <Link to="/approvals">Review approvals</Link>
        </div>
      )}

      <Brief />

      <div className="grid3">
        <section className="panel">
          <h2>Recent activity</h2>
          {activity.length === 0 ? (
            <p className="muted">Nothing yet. Give the company its first objective above.</p>
          ) : (
            <ul className="timeline">
              {activity.map((e) => (
                <li key={e.id}><time>{new Date(e.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}</time><span><Link to={`/tasks/${e.rootId}`}>{describe(e)}</Link></span></li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel">
          <h2>AI usage, last 30 days</h2>
          {data.usage.length === 0 ? <p className="muted">No model calls yet.</p> : (
            <>
              <div className="bars" aria-hidden="true">{data.usage.map((u) => <div key={u.day} title={`${u.day}: ${fmtUsd(u.costUsd)}, ${u.calls} calls`} style={{ height: `${(u.costUsd / maxCost) * 100}%` }} />)}</div>
              <p className="small muted" style={{ marginTop: 8 }}>
                {data.usage.reduce((s, u) => s + u.calls, 0)} calls · {data.usage.reduce((s, u) => s + u.tokens, 0).toLocaleString()} tokens · {fmtUsd(data.usage.reduce((s, u) => s + u.costUsd, 0))}
              </p>
            </>
          )}
          <h2 style={{ marginTop: 18 }}>System health</h2>
          <p className="small">Configured model providers: {realProviders.length ? realProviders.join(", ") : <span className="muted">none (offline mock only)</span>}</p>
          <p className="small">Failed model calls, last hour: {data.health.failedModelCallsLastHour}</p>
          <p className="small">Code sandbox: {data.health.sandbox === "docker" ? "Docker, isolated" : <span className="muted">off</span>}</p>
        </section>
      </div>
    </div>
  );
}
