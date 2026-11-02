import { useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtTime, fmtUsd, LEVELS, useApi, type Agent, type Task } from "../api";
import { useUser } from "../main";
import { Drawer, ErrorNote, Ladder, PageHead, Pill } from "../ui";

interface ToolInfo { id: string; name: string; level: number; risk: string; description: string }
const SCOPES = ["conversation", "task", "agent", "company", "project", "decision", "organizational"];

const blank = (): Agent => ({
  id: "", name: "", department: "", role: "", systemPrompt: "", responsibilities: [], capabilities: [], maxAutonomy: 0, tools: [],
  memoryAccess: { read: ["company"], write: [] }, model: { profile: "default", temperature: 0.3 }, status: "active",
});

export function Workforce() {
  const { data, error, reload } = useApi<Agent[]>("/agents");
  const [editing, setEditing] = useState<{ agent: Agent; isNew: boolean } | null>(null);
  const user = useUser();
  // Executive Office first, then departments alphabetically.
  const departments = [...new Set((data ?? []).map((a) => a.department))].sort((x, y) => (x === "Executive Office" ? -1 : y === "Executive Office" ? 1 : x.localeCompare(y)));
  return (
    <div className="stack">
      <PageHead title="Workforce" sub="Who does what, how much authority each agent holds, and how they're performing.">
        {user.role !== "viewer" && <button className="primary" onClick={() => setEditing({ agent: blank(), isNew: true })}>Add agent</button>}
      </PageHead>
      <ErrorNote error={error} />
      <section className="panel table-wrap">
        <table>
          <thead><tr><th>Agent</th><th>Authority</th><th>Status</th><th>Done / failed</th><th>Spend</th><th><span className="sr">Actions</span></th></tr></thead>
          {departments.map((dep) => (
            <tbody key={dep}>
              <tr><th colSpan={6} scope="colgroup" style={{ paddingTop: 18, color: "var(--ink)", fontSize: "0.95rem" }}>{dep}</th></tr>
              {data!.filter((a) => a.department === dep).map((a) => (
                <tr key={a.id}>
                  <td><b>{a.name}</b><div className="small muted">{a.role}</div></td>
                  <td style={{ whiteSpace: "nowrap" }}><Ladder level={a.maxAutonomy} /></td>
                  <td><Pill s={a.status} />{a.metrics?.running ? <div className="small muted">{a.metrics.running} in progress</div> : null}</td>
                  <td>{a.metrics?.completed ?? 0} / {a.metrics?.failed ?? 0}{a.metrics?.successRate != null && <div className="small muted">{Math.round(a.metrics.successRate * 100)}% success</div>}</td>
                  <td>{fmtUsd(a.metrics?.costUsd ?? 0)}</td>
                  <td><button className="link" onClick={() => setEditing({ agent: a, isNew: false })}>{user.role === "viewer" ? "View" : "Configure"}</button></td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </section>
      {editing && <AgentEditor key={editing.agent.id || "new"} initial={editing.agent} isNew={editing.isNew} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function AgentEditor({ initial, isNew, onClose, onSaved }: { initial: Agent; isNew: boolean; onClose: () => void; onSaved: () => void }) {
  const user = useUser();
  const { data: tools } = useApi<ToolInfo[]>("/tools");
  const { data: settings } = useApi<{ models: { profiles: { id: string; label: string }[] } }>("/settings");
  const { data: activity } = useApi<{ tasks: Task[] }>(isNew ? null : `/agents/${initial.id}/activity`);
  const [a, setA] = useState<Agent>(initial);
  const [error, setError] = useState<string | null>(null);
  const readOnly = user.role === "viewer";
  const permsLocked = user.role !== "ceo";
  const set = <K extends keyof Agent>(k: K, v: Agent[K]) => setA({ ...a, [k]: v });
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  const save = async () => {
    const { metrics: _m, canOrchestrate: _c, ...body } = a;
    try {
      await api(isNew ? "/agents" : `/agents/${a.id}`, { method: isNew ? "POST" : "PUT", body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Drawer onClose={onClose}>
      <h1>{isNew ? "New agent" : a.name}</h1>
      <p className="muted">{isNew ? "New agents start read-only. Grant tools and autonomy deliberately." : a.role}</p>
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid2">
          <div className="field"><label htmlFor="a-id">ID</label><input id="a-id" value={a.id} disabled={!isNew} onChange={(e) => set("id", e.target.value.toLowerCase())} placeholder="legal-research" /></div>
          <div className="field"><label htmlFor="a-name">Name</label><input id="a-name" value={a.name} onChange={(e) => set("name", e.target.value)} /></div>
          <div className="field"><label htmlFor="a-dep">Department</label><input id="a-dep" value={a.department} onChange={(e) => set("department", e.target.value)} /></div>
          <div className="field">
            <label htmlFor="a-status">Status</label>
            <select id="a-status" value={a.status} onChange={(e) => set("status", e.target.value)}>
              <option value="active">Active</option><option value="paused">Paused</option><option value="deactivated">Deactivated</option>
            </select>
          </div>
        </div>
        <div className="field"><label htmlFor="a-role">Role</label><input id="a-role" value={a.role} onChange={(e) => set("role", e.target.value)} /></div>
        <div className="field"><label htmlFor="a-resp">Responsibilities, one per line</label><textarea id="a-resp" defaultValue={a.responsibilities.join("\n")} onChange={(e) => set("responsibilities", lines(e.target.value))} /></div>
        <div className="field"><label htmlFor="a-prompt">System prompt</label><textarea id="a-prompt" style={{ minHeight: 180 }} value={a.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} /></div>
        <div className="grid2">
          <div className="field">
            <label htmlFor="a-model">Model</label>
            <select id="a-model" value={a.model.profile} onChange={(e) => set("model", { ...a.model, profile: e.target.value })}>
              {(settings?.models.profiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="a-temp">Temperature</label><input id="a-temp" type="number" step="0.1" min="0" max="2" value={a.model.temperature ?? 0.3} onChange={(e) => set("model", { ...a.model, temperature: Number(e.target.value) })} /></div>
        </div>

        <h2 style={{ marginTop: 18 }}>Permissions</h2>
        {permsLocked && !readOnly && <p className="note">Only the CEO can change tools, autonomy or memory access.</p>}
        <fieldset disabled={permsLocked} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="field">
            <label htmlFor="a-level">Highest autonomy</label>
            <select id="a-level" value={a.maxAutonomy} onChange={(e) => set("maxAutonomy", Number(e.target.value))}>
              {LEVELS.map((l, i) => <option key={i} value={i}>L{i} {l}</option>)}
            </select>
            <div style={{ marginTop: 6 }}><Ladder level={a.maxAutonomy} /></div>
          </div>
          <div className="field">
            <label>Tools</label>
            <div className="stack" style={{ gap: 6 }}>
              {(tools ?? []).map((t) => (
                <label key={t.id} style={{ fontWeight: 400, display: "flex", gap: 8, alignItems: "flex-start", color: t.level > a.maxAutonomy ? "var(--ink-3)" : "var(--ink)" }}>
                  <input type="checkbox" style={{ width: "auto", marginTop: 4 }} checked={a.tools.includes(t.id)} onChange={() => set("tools", toggle(a.tools, t.id))} />
                  <span><b>{t.name}</b> <span className="small muted">needs L{t.level}{t.level === 3 ? ", always asks you first" : ""}{t.level > a.maxAutonomy ? ". Above this agent's autonomy, so it will be refused" : ""}</span></span>
                </label>
              ))}
            </div>
          </div>
          {(["read", "write"] as const).map((mode) => (
            <div className="field" key={mode}>
              <label>Memory it can {mode}</label>
              <div className="checks">
                {SCOPES.map((s) => (
                  <label key={s}><input type="checkbox" checked={a.memoryAccess[mode].includes(s)} onChange={() => set("memoryAccess", { ...a.memoryAccess, [mode]: toggle(a.memoryAccess[mode], s) })} />{s}</label>
                ))}
              </div>
            </div>
          ))}
        </fieldset>
      </fieldset>
      <ErrorNote error={error} />
      {!readOnly && <div className="row" style={{ marginTop: 12 }}><button className="primary" onClick={save}>{isNew ? "Create agent" : "Save changes"}</button><button onClick={onClose}>Discard</button></div>}

      {!isNew && (
        <>
          <h2 style={{ marginTop: 24 }}>Recent work</h2>
          {activity?.tasks.length ? (
            <ul className="timeline">{activity.tasks.slice(0, 20).map((t) => <li key={t.id}><time>{fmtTime(t.createdAt).split(",")[0]}</time><span><Pill s={t.status} /> <Link to={`/tasks/${t.id}`}>{t.title}</Link></span></li>)}</ul>
          ) : <p className="muted small">No tasks yet.</p>}
        </>
      )}
    </Drawer>
  );
}
