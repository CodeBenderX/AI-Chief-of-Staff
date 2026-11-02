import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtClock, fmtTime, fmtUsd, LEVELS, statusLabel, useApi, type Agent, type Approval, type Task, type TaskEvent } from "../api";
import { useUser } from "../main";
import { ErrorNote, Ladder, PageHead, Pill } from "../ui";

/** The central interface: one box to brief the whole company. */
export function Brief() {
  const user = useUser();
  const nav = useNavigate();
  const { data: agents } = useApi<Agent[]>("/agents");
  const [objective, setObjective] = useState("");
  const [agentId, setAgentId] = useState("chief-of-staff");
  const [priority, setPriority] = useState("normal");
  const [cap, setCap] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (user.role === "viewer") return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const t = await api<Task>("/tasks", { body: { objective, agentId, priority, autonomyCap: cap } });
      nav(`/tasks/${t.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h2>Brief the company</h2>
      <div className="field">
        <label htmlFor="obj" className="sr">Objective</label>
        <textarea id="obj" required minLength={5} placeholder="e.g. Assess whether we should launch a self-serve tier for small accounting firms. I need pricing options and risks by Friday." value={objective} onChange={(e) => setObjective(e.target.value)} />
      </div>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div style={{ minWidth: 220 }}>
          <label htmlFor="ag">Assign to</label>
          <select id="ag" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {(agents ?? []).filter((a) => a.status === "active").map((a) => <option key={a.id} value={a.id}>{a.canOrchestrate ? `${a.name} (plans and delegates)` : a.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="pr">Priority</label>
          <select id="pr" value={priority} onChange={(e) => setPriority(e.target.value)}>
            {["low", "normal", "high", "urgent"].map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="cap">Most autonomy allowed</label>
          <select id="cap" value={cap} onChange={(e) => setCap(Number(e.target.value))}>
            {LEVELS.map((l, i) => <option key={i} value={i}>L{i} {l}</option>)}
          </select>
        </div>
        <button className="primary" disabled={busy || objective.trim().length < 5}>{busy ? "Starting" : "Start work"}</button>
      </div>
      {error && <div className="err" style={{ marginTop: 12 }}>{error}</div>}
    </form>
  );
}

export function Tasks() {
  const [status, setStatus] = useState("");
  const { data, error } = useApi<Task[]>(`/tasks?rootsOnly=true${status ? `&status=${status}` : ""}`, [status]);
  const nav = useNavigate();
  return (
    <div className="stack">
      <PageHead title="Tasks" sub="Every objective you've given, with the work it created underneath.">
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 200 }}>
          <option value="">All statuses</option>
          {["running", "awaiting_approval", "completed", "escalated", "failed", "cancelled"].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>
      </PageHead>
      <Brief />
      <ErrorNote error={error} />
      <div className="panel table-wrap">
        {data && data.length === 0 ? <p className="muted">No tasks match.</p> : (
          <table>
            <thead><tr><th>Objective</th><th>Owner</th><th>Status</th><th>Priority</th><th>Started</th></tr></thead>
            <tbody>
              {(data ?? []).map((t) => (
                <tr key={t.id} className="click" onClick={() => nav(`/tasks/${t.id}`)}>
                  <td><Link to={`/tasks/${t.id}`} onClick={(e) => e.stopPropagation()}>{t.title}</Link></td>
                  <td>{t.agentId}</td>
                  <td><Pill s={t.status} /></td>
                  <td>{t.priority}</td>
                  <td className="muted">{fmtTime(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface Detail {
  task: Task;
  tree: Task[];
  events: TaskEvent[];
  approvals: Approval[];
  usage: { calls: number; tokens: number; costUsd: number };
  transcript: { role: string; content: string; toolName?: string; toolCalls?: { name: string; input: unknown }[] }[];
}

const TERMINAL = ["completed", "failed", "cancelled", "escalated"];

export function TaskDetail() {
  const { id } = useParams();
  const user = useUser();
  const { data, error, reload } = useApi<Detail>(`/tasks/${id}`, [id]);
  const [showTranscript, setShowTranscript] = useState(false);
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  const { task, tree, events, approvals, usage } = data;
  const root = tree.find((t) => t.id === task.rootId) ?? task;
  const children = (pid: string) => tree.filter((t) => t.parentId === pid).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byId = new Map(tree.map((t) => [t.id, t]));
  const cancel = async () => {
    if (!confirm("Cancel this task and all of its subtasks?")) return;
    await api(`/tasks/${task.id}/cancel`, { method: "POST" });
    reload();
  };
  const pending = approvals.filter((a) => a.status === "pending");

  const renderNode = (t: Task) => (
    <li key={t.id}>
      <div className="row" style={{ gap: 8 }}>
        <Pill s={t.status} />
        <Link to={`/tasks/${t.id}`}>{t.title}</Link>
        <span className="small muted">{t.agentId}{t.dependsOn.length ? `, after ${t.dependsOn.map((d) => byId.get(d)?.title ?? d).join(" and ")}` : ""}</span>
      </div>
      {t.error && <div className="small" style={{ color: "var(--danger)" }}>{t.error}</div>}
      {children(t.id).length > 0 && <ul className="tree">{children(t.id).map(renderNode)}</ul>}
    </li>
  );

  return (
    <div className="stack">
      <PageHead title={task.title} sub={`${task.agentId}, created ${fmtTime(task.createdAt)}`}>
        <Pill s={task.status} />
        {user.role !== "viewer" && !TERMINAL.includes(task.status) && <button className="reject" onClick={cancel}>Cancel task</button>}
      </PageHead>

      {pending.length > 0 && (
        <div className="note" style={{ background: "var(--authority-soft)", color: "var(--authority)" }}>
          Paused: {pending.length} action{pending.length > 1 ? "s need" : " needs"} your decision. <Link to="/approvals">Open approvals</Link>
        </div>
      )}

      <div className="grid3">
        <div className="stack">
          {task.result && (
            <section className="panel">
              <h2>{task.id === task.rootId ? "Report to the CEO" : "Result"}</h2>
              <pre style={{ background: "transparent", padding: 0, fontFamily: "var(--font)", fontSize: "0.95rem", maxHeight: "none" }}>{task.result}</pre>
            </section>
          )}
          {task.error && !task.result && <div className="err">{task.error}</div>}
          <section className="panel">
            <h2>Work breakdown</h2>
            <ul className="tree">{renderNode(root)}</ul>
          </section>
          <section className="panel">
            <h2>Instructions</h2>
            <p style={{ whiteSpace: "pre-wrap" }}>{task.instructions}</p>
            {data.transcript.length > 0 && (
              <>
                <button className="link" onClick={() => setShowTranscript(!showTranscript)}>{showTranscript ? "Hide" : "Show"} agent transcript ({data.transcript.length} messages)</button>
                {showTranscript && (
                  <div className="stack" style={{ marginTop: 12, gap: 8 }}>
                    {data.transcript.map((m, i) => (
                      <div key={i}>
                        <div className="small muted">{m.role === "tool" ? `Tool result: ${m.toolName}` : m.role === "user" ? "Assignment" : "Agent"}</div>
                        <pre>{m.content || (m.toolCalls ?? []).map((c) => `Calls ${c.name} ${JSON.stringify(c.input, null, 2)}`).join("\n")}</pre>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
        <div className="stack">
          <section className="panel">
            <h2>Limits and spend</h2>
            <p className="small"><Ladder level={task.autonomyCap} /></p>
            <p className="small">{usage.calls} model calls, {usage.tokens.toLocaleString()} tokens, {fmtUsd(usage.costUsd)}</p>
          </section>
          <section className="panel">
            <h2>Execution history</h2>
            <ul className="timeline">
              {events.slice().reverse().slice(0, 120).map((e) => (
                <li key={e.id}><time>{fmtClock(e.at)}</time><span><b>{e.agentId}</b> {statusLabel(e.type)}{e.data.toolId ? ` ${e.data.toolId}` : ""}{e.data.error ? `: ${String(e.data.error).slice(0, 140)}` : ""}</span></li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
